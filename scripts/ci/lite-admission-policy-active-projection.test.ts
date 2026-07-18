import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAionisAdmissionCandidatePolicyActiveProjectionFromDecisionSet,
  resolveAionisGuideLearningDecisionSet,
  resolveAionisAdmissionCandidatePolicyActiveProjection,
  type AionisGuideLearningPriorStateResolution,
} from "../../src/memory/product-output/operator-projections.js";
import {
  buildAionisAgentContext,
} from "../../src/memory/agent-context-compiler.js";
import { buildAionisMemoryPacket } from "../../src/memory/product-output/memory-packet.js";
import { productGuideCandidateServingEnabled } from "../../src/product/guide-service.js";
import { inspectLiteMemoryCommitAuthority } from
  "../../src/store/lite-memory-commit-integrity.js";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.js";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.js";

test("A/A and shadow guide phases cannot activate the candidate serving branch", () => {
  assert.equal(productGuideCandidateServingEnabled({ mode: "shadow", serving_arm: "control" }, true), false);
  assert.equal(productGuideCandidateServingEnabled({ mode: "active", serving_arm: "control" }, true), false);
  assert.equal(productGuideCandidateServingEnabled({ mode: "active", serving_arm: "candidate" }, false), false);
  assert.equal(productGuideCandidateServingEnabled({ mode: "active", serving_arm: "candidate" }, true), true);
});

test("admission candidate active projection only downgrades current use-now entries", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue admission candidate policy route",
    },
    nodes: [
      {
        id: "mem-project-supported",
        type: "topic",
        title: "Supported project context",
        text_summary: "Current project context is supported by prior positive feedback.",
        tier: "warm",
        confidence: 0.91,
        salience: 0.91,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-procedure-candidate",
        type: "procedure",
        title: "Procedure candidate",
        text_summary: "Procedure candidate should be inspected before direct prompt use by this policy.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-execution-current",
        type: "topic",
        title: "Accepted execution continuation",
        text_summary: "Verifier accepted this execution branch as the active continuation state.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
        slots: {
          execution_kind: "handoff",
        },
      },
      {
        id: "mem-execution-contradicted",
        type: "topic",
        title: "Contradicted execution continuation",
        text_summary: "Execution continuation with later negative feedback should be inspected.",
        tier: "warm",
        confidence: 0.88,
        salience: 0.88,
        created_at: "2026-06-01T00:00:00.000Z",
        slots: {
          execution_kind: "handoff",
        },
      },
      {
        id: "mem-project-contradicted",
        type: "topic",
        title: "Contradicted project context",
        text_summary: "Project context with repeated negative posture should not remain direct-use.",
        tier: "warm",
        confidence: 0.89,
        salience: 0.89,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    slot_by_memory_id: new Map([
      ["mem-project-supported", { positive_attributed_use_count: 2 }],
      ["mem-procedure-candidate", {}],
      ["mem-execution-current", {}],
      ["mem-project-contradicted", { strong_counter_signal_count: 2 }],
      ["mem-execution-contradicted", { strong_counter_signal_count: 2 }],
    ]),
  });

  assert.equal(projection.runtime_mutation, false);
  assert.equal(projection.authority_mutation, false);
  assert.equal(projection.hard_boundary_upgrade_count, 0);
  assert.deepEqual(projection.downgraded_memory_ids, [
    "mem-procedure-candidate",
    "mem-execution-contradicted",
    "mem-project-contradicted",
  ]);
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-project-supported")?.shadow_action,
    "use_now",
  );
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-execution-current")?.shadow_action,
    "use_now",
  );
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-project-contradicted")
      ?.closed_loop_effect_state,
    "contradicted",
  );
});

test("admission candidate active projection preserves non-use-now hard boundaries", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "preserve active projection hard boundaries",
    },
    nodes: [
      {
        id: "mem-use-now",
        type: "topic",
        title: "Use now memory",
        text_summary: "Direct project context remains direct-use.",
        tier: "warm",
        confidence: 0.91,
        salience: 0.91,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-already-inspect",
        type: "procedure",
        title: "Already inspect memory",
        text_summary: "This memory is already on the inspect-before-use surface.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const baseContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const agentContext = {
    ...baseContext,
    use_now_memory_ids: ["mem-use-now"],
    inspect_before_use_memory_ids: ["mem-already-inspect"],
  };
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    slot_by_memory_id: new Map([
      ["mem-use-now", {}],
      ["mem-already-inspect", {}],
    ]),
  });

  assert.equal(projection.hard_boundary_upgrade_count, 0);
  assert.deepEqual(projection.downgraded_memory_ids, []);
  assert.deepEqual(
    projection.shadow_policy_report.decisions.map((entry) => [
      entry.memory_id,
      entry.recorded_action,
      entry.shadow_action,
    ]),
    [
      ["mem-use-now", "use_now", "use_now"],
      ["mem-already-inspect", "inspect_before_use", "inspect_before_use"],
    ],
  );
});

test("guide learning decision set stays unbounded while its public shadow report remains capped", () => {
  const basePacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: { source: "text", intent: "exercise an unbounded learning projection" },
    nodes: [{
      id: "mem-000",
      type: "fact",
      title: "Fact 000",
      text_summary: "A relevant fact that the candidate policy should inspect before use.",
      confidence: 0.9,
      salience: 0.9,
      created_at: "2026-06-01T00:00:00.000Z",
    }],
  });
  const template = basePacket.relevant_memories[0]!;
  const relevantMemories = Array.from({ length: 120 }, (_, index) => ({
    ...template,
    memory_id: `mem-${String(index).padStart(3, "0")}`,
    title: `Fact ${String(index).padStart(3, "0")}`,
  }));
  const memoryPacket = { ...basePacket, relevant_memories: relevantMemories };
  const memoryIds = relevantMemories.map((entry) => entry.memory_id);
  const baseContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: basePacket,
  });
  const agentContext = {
    ...baseContext,
    use_now_memory_ids: memoryIds,
    inspect_before_use_memory_ids: [],
    do_not_use_memory_ids: [],
    rehydrate_hints: [],
  };
  const priorByMemoryId = new Map<string, AionisGuideLearningPriorStateResolution>(
    memoryIds.map((memoryId) => [memoryId, {
      status: "resolved",
      memory_id: memoryId,
      node_type: "fact",
      slots: {},
    }]),
  );

  const decisionSet = resolveAionisGuideLearningDecisionSet({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    prior_by_memory_id: priorByMemoryId,
  });

  assert.equal(decisionSet.projection_complete, true);
  assert.equal(decisionSet.decision_count, 120);
  assert.equal(decisionSet.complete_decision_count, 120);
  assert.equal(decisionSet.control_items.length, 120);
  assert.equal(decisionSet.candidate_items.length, 120);
  assert.equal(decisionSet.full_downgraded_memory_ids.length, 120);
  assert.equal(decisionSet.control_items[0]?.served_action, "use_now");
  assert.equal(decisionSet.candidate_items[0]?.served_action, "inspect_before_use");
  assert.equal(decisionSet.recorded_surface_sha256, decisionSet.control_served_surface_sha256);
  assert.equal(decisionSet.candidate_surface_sha256, decisionSet.candidate_served_surface_sha256);
  assert.ok(decisionSet.recorded_surface_sha256);

  const projection = buildAionisAdmissionCandidatePolicyActiveProjectionFromDecisionSet({
    decision_set: decisionSet,
    mode: "active",
  });
  assert.equal(projection.projection_complete, true);
  assert.equal(projection.full_decision_count, 120);
  assert.equal(projection.displayed_decision_count, 96);
  assert.equal(projection.shadow_policy_report.decisions.length, 96);
  assert.equal(projection.display_truncated, true);
  assert.equal(projection.full_downgraded_memory_count, 120);
  assert.equal(projection.downgraded_memory_ids.length, 96);
});

test("guide learning decision set makes every incomplete prior or surface reason explicit", () => {
  const basePacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: { source: "text", intent: "exercise incomplete learning projection reasons" },
    nodes: [
      { id: "mem-duplicate", type: "fact", title: "Duplicate", text_summary: "Duplicate relevant item." },
      { id: "mem-missing", type: "fact", title: "Missing", text_summary: "Missing prior item." },
      { id: "mem-invisible", type: "fact", title: "Invisible", text_summary: "Invisible prior item." },
      { id: "mem-lookup-failed", type: "fact", title: "Lookup failed", text_summary: "Failed prior lookup item." },
      { id: "mem-not-facing", type: "fact", title: "Not facing", text_summary: "Not on any Agent surface." },
      { id: "mem-unsupported", type: "fact", title: "Unsupported", text_summary: "Unsupported prior result." },
    ],
  });
  const duplicate = basePacket.relevant_memories.find((entry) => entry.memory_id === "mem-duplicate")!;
  const memoryPacket = {
    ...basePacket,
    relevant_memories: [...basePacket.relevant_memories, { ...duplicate }],
  };
  const baseContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: basePacket,
  });
  const agentContext = {
    ...baseContext,
    use_now_memory_ids: [
      "mem-duplicate",
      "mem-duplicate",
      "mem-missing",
      "mem-invisible",
      "mem-lookup-failed",
      "mem-unsupported",
    ],
    inspect_before_use_memory_ids: ["mem-duplicate"],
    do_not_use_memory_ids: ["mem-without-packet-entry"],
    rehydrate_hints: [],
  };
  const priorByMemoryId = new Map<string, AionisGuideLearningPriorStateResolution>([
    ["mem-duplicate", { status: "resolved", memory_id: "mem-duplicate", slots: {} }],
    ["mem-missing", { status: "memory_node_missing", memory_id: "mem-missing" }],
    ["mem-invisible", { status: "memory_visibility_mismatch", memory_id: "mem-invisible" }],
    ["mem-lookup-failed", { status: "prior_state_lookup_failed", memory_id: "mem-lookup-failed" }],
    ["mem-not-facing", { status: "resolved", memory_id: "mem-not-facing", slots: {} }],
    ["mem-unsupported", {
      status: "future_status",
      memory_id: "mem-unsupported",
    } as unknown as AionisGuideLearningPriorStateResolution],
  ]);

  const decisionSet = resolveAionisGuideLearningDecisionSet({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    prior_by_memory_id: priorByMemoryId,
  });

  assert.equal(decisionSet.projection_complete, false);
  assert.deepEqual(new Set(decisionSet.projection_incomplete_reason_codes), new Set([
    "duplicate_relevant_memory_id",
    "duplicate_recorded_surface_memory_id",
    "recorded_surface_conflict",
    "recorded_surface_item_omitted",
    "relevant_memory_not_agent_facing",
    "memory_node_missing",
    "memory_visibility_mismatch",
    "prior_state_lookup_failed",
    "unsupported_prior_resolution",
  ]));
  assert.equal(decisionSet.recorded_surface_sha256, null);
  assert.equal(decisionSet.candidate_surface_sha256, null);
  assert.equal(decisionSet.control_items.length, 0);
  assert.equal(decisionSet.candidate_items.length, 0);

  const projection = buildAionisAdmissionCandidatePolicyActiveProjectionFromDecisionSet({
    decision_set: decisionSet,
    mode: "active",
  });
  assert.equal(projection.agent_prompt_included, false);
  assert.deepEqual(projection.downgraded_memory_ids, []);
});

test("legacy slot-map compatibility never converts an omitted prior into no_prior", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: { source: "text", intent: "reject an omitted prior state" },
    nodes: [{
      id: "mem-prior-omitted",
      type: "fact",
      title: "Omitted prior",
      text_summary: "The caller did not resolve this prior state.",
    }],
  });
  const baseContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: {
      ...baseContext,
      use_now_memory_ids: ["mem-prior-omitted"],
      inspect_before_use_memory_ids: [],
      do_not_use_memory_ids: [],
      rehydrate_hints: [],
    },
    memory_packet: memoryPacket,
    slot_by_memory_id: new Map(),
    mode: "active",
  });

  assert.equal(projection.projection_complete, false);
  assert.deepEqual(projection.projection_incomplete_reason_codes, ["prior_state_result_omitted"]);
  assert.equal(projection.shadow_policy_report.decision_count, 0);
  assert.deepEqual(projection.downgraded_memory_ids, []);
});

test("batch guide prior lookup distinguishes empty, missing, and invisible nodes across SQL chunks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-guide-learning-prior-"));
  const databasePath = path.join(dir, "runtime.sqlite");
  try {
    const legacyDatabase = createLiteRuntimeDatabase(databasePath);
    const legacyStore = createLiteWriteStoreFromDatabase(legacyDatabase, {
      annProjectionEnabled: false,
      allowLegacyV1Fixtures: true,
      closeDatabaseOnClose: false,
    });
    let legacyStoreClosed = false;
    try {
      legacyDatabase.db.exec("BEGIN IMMEDIATE");
      try {
        // A real pre-v6 fixture has neither adoption object. Remove the
        // dependent binding table before its manifest parent.
        legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_bindings");
        legacyDatabase.db.exec("DROP TABLE lite_runtime_authority_adoption_manifests");
        const metadataUpdate = legacyDatabase.db.prepare(
          `UPDATE lite_runtime_schema_metadata
           SET version = 5, updated_at = ?
           WHERE component = 'write_projection'`,
        ).run("2026-07-19T00:00:00.000Z");
        assert.equal(Number(metadataUpdate.changes ?? 0), 1);
        legacyDatabase.db.exec("COMMIT");
      } catch (error) {
        legacyDatabase.db.exec("ROLLBACK");
        throw error;
      }

      const commitId = await legacyStore.insertLegacyV1CommitForMigrationOrTestFixture({
        scope: "repo-a",
        parentCommitId: null,
        inputSha256: "guide-learning-prior-input",
        diffJson: "{}",
        actor: "test",
        modelVersion: null,
        promptVersion: null,
        commitHash: "guide-learning-prior-commit",
      });
      const insertNode = async (args: {
        id: string;
        slots: Record<string, unknown>;
        memoryLane: "private" | "shared";
        ownerAgentId?: string | null;
        ownerTeamId?: string | null;
      }): Promise<void> => {
        await legacyStore.insertNode({
          id: args.id,
          scope: "repo-a",
          clientId: null,
          type: "fact",
          tier: "hot",
          title: args.id,
          textSummary: args.id,
          slotsJson: JSON.stringify(args.slots),
          rawRef: null,
          evidenceRef: null,
          embeddingVector: null,
          embeddingModel: null,
          memoryLane: args.memoryLane,
          producerAgentId: null,
          ownerAgentId: args.ownerAgentId ?? null,
          ownerTeamId: args.ownerTeamId ?? null,
          embeddingStatus: "pending",
          embeddingLastError: null,
          salience: 0.8,
          importance: 0.5,
          confidence: 0.8,
          redactionVersion: 0,
          commitId,
        });
      };
      await insertNode({ id: "mem-visible-empty", slots: {}, memoryLane: "shared" });
      await insertNode({
        id: "mem-private",
        slots: { positive_attributed_use_count: 3 },
        memoryLane: "private",
        ownerAgentId: "owner-agent",
      });

      const legacyAuthority = inspectLiteMemoryCommitAuthority(legacyDatabase.db);
      assert.equal(legacyAuthority.ok, true, JSON.stringify(legacyAuthority.findings));
      assert.equal(legacyAuthority.legacy_commit_count, 1);
      assert.equal(legacyAuthority.v2_commit_count, 0);
      await legacyStore.close();
      legacyStoreClosed = true;
    } finally {
      if (!legacyStoreClosed) await legacyStore.close();
      await legacyDatabase.close();
    }

    const migratedDatabase = createLiteRuntimeDatabase(databasePath);
    const store = createLiteWriteStoreFromDatabase(migratedDatabase, {
      annProjectionEnabled: false,
      closeDatabaseOnClose: false,
    });
    try {
      const metadata = migratedDatabase.db.prepare(
        `SELECT version FROM lite_runtime_schema_metadata
         WHERE component = 'write_projection'`,
      ).get() as { version: number } | undefined;
      assert.equal(metadata?.version, 6);
      const migratedAuthority = inspectLiteMemoryCommitAuthority(migratedDatabase.db);
      assert.equal(migratedAuthority.ok, true, JSON.stringify(migratedAuthority.findings));
      assert.ok(migratedAuthority.adoption_manifest_count > 0);
      assert.ok(migratedAuthority.adoption_binding_count > 0);
      assert.equal(
        migratedAuthority.adoption_binding_verified_count,
        migratedAuthority.adoption_binding_count,
      );

      const memoryIds = [
        "mem-visible-empty",
        "mem-private",
        ...Array.from({ length: 1_203 }, (_, index) => `mem-missing-${String(index).padStart(4, "0")}`),
      ];
      const publicResolution = await store.resolveGuideLearningPriorStates({
        scope: "repo-a",
        memoryIds,
      });
      assert.equal(publicResolution.size, memoryIds.length);
      assert.deepEqual(publicResolution.get("mem-visible-empty"), {
        status: "resolved",
        memory_id: "mem-visible-empty",
        node_type: "fact",
        slots: {},
      });
      assert.deepEqual(publicResolution.get("mem-private"), {
        status: "memory_visibility_mismatch",
        memory_id: "mem-private",
      });
      assert.deepEqual(publicResolution.get("mem-missing-1202"), {
        status: "memory_node_missing",
        memory_id: "mem-missing-1202",
      });

      const ownerResolution = await store.resolveGuideLearningPriorStates({
        scope: "repo-a",
        memoryIds: ["mem-private"],
        consumerAgentId: "owner-agent",
      });
      assert.deepEqual(ownerResolution.get("mem-private"), {
        status: "resolved",
        memory_id: "mem-private",
        node_type: "fact",
        slots: { positive_attributed_use_count: 3 },
      });
    } finally {
      try {
        await store.close();
      } finally {
        await migratedDatabase.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
