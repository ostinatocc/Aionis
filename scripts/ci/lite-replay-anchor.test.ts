import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import {
  replayPlaybookCompileFromRun,
  replayPlaybookPromote,
  replayRunEnd,
  replayRunStart,
  replayStepAfter,
  replayStepBefore,
} from "../../src/memory/replay.ts";
import { buildExecutionMemoryIntrospectionLite } from "../../src/memory/execution-introspection.ts";
import { applyReplayMemoryWrite } from "../../src/memory/replay-write.ts";
import { memoryRecallParsed } from "../../src/memory/recall.ts";
import { MemoryRecallRequest } from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { AionisMemoryPacketSchema } from "../../src/memory/product-output-contract.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-replay-anchor-"));
  return path.join(dir, `${name}.sqlite`);
}

function authoritativeReplaySlotOverrides(label: string): Record<string, unknown> {
  return {
    contract_trust: "authoritative",
    task_family: "replay_export_repair",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun the export replay smoke test.",
    acceptance_checks: ["npm run -s test:lite -- export"],
    execution_evidence_v1: {
      schema_version: "execution_evidence_v1",
      validation_passed: true,
      after_exit_revalidated: true,
      fresh_shell_probe_passed: true,
      validation_boundary: "external_verifier",
      failure_reason: null,
      false_confidence_detected: false,
      evidence_refs: [`test:${label}:explicit-execution-evidence`],
    },
  };
}

async function seedDraftPlaybook(args: {
  writeStorePath: string;
  playbookId: string;
  runId: string;
  status?: "draft" | "shadow" | "active";
  slotOverrides?: Record<string, unknown>;
}) {
  const liteWriteStore = createLiteWriteStore(args.writeStorePath);
  const liteReplayStore = createLiteReplayStore(args.writeStorePath);
  const sourceClientId = `replay:playbook:${args.playbookId}:v1`;
  const status = args.status ?? "draft";
  try {
    const result = await applyReplayMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: `compile playbook ${args.playbookId}`,
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          client_id: sourceClientId,
          type: "procedure",
          title: "Recover workflow validation failure",
          text_summary: "Replay playbook compiled from failing export repair",
          slots: {
            replay_kind: "playbook",
            playbook_id: args.playbookId,
            name: "Recover workflow validation failure",
            version: 1,
            status,
            matchers: { task: "workflow-validation-failure" },
            success_criteria: { status: "success" },
            risk_profile: "medium",
            created_from_run_ids: [args.runId],
            source_run_id: args.runId,
            policy_constraints: {},
            steps_template: [
              {
                step_index: 1,
                tool_name: "edit",
                preconditions: [],
                postconditions: [],
                safety_level: "needs_confirm",
              },
              {
                step_index: 2,
                tool_name: "test",
                preconditions: [],
                postconditions: [],
                safety_level: "observe_only",
              },
            ],
            compile_summary: {
              source_run_id: args.runId,
              source_run_status: "success",
              steps_total: 2,
            },
            ...(args.slotOverrides ?? {}),
          },
        },
      ],
      edges: [],
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: null,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });

    const sourceNodeId = result.out.nodes[0]?.id ?? null;
    assert.ok(sourceNodeId);
    return { liteWriteStore, liteReplayStore, sourceNodeId, sourceClientId };
  } catch (err) {
    await liteReplayStore.close();
    await liteWriteStore.close();
    throw err;
  }
}

test("compile_from_run turns a successful real replay run into a workflow candidate", async () => {
  const dbPath = tmpDbPath("compile-candidate");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteReplayStore = createLiteReplayStore(dbPath);
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const writeOpts = {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: null,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    };
    const runId = randomUUID();
    await replayRunStart({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      goal: "Repair fastify-compress Web ReadableStream gzip regression on the real v7.0.3 code path.",
      metadata: {
        repo: "fastify/fastify-compress",
        version: "v7.0.3",
      },
    }, writeOpts);

    const firstStep = await replayStepBefore({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_index: 1,
      tool_name: "bash",
      tool_input: {
        command: "node repro-web-readable-stream.mjs",
      },
      preconditions: [
        { kind: "repo_checkout", repo: "fastify/fastify-compress", ref: "v7.0.3" },
      ],
      safety_level: "auto_ok",
    }, writeOpts);
    await replayStepAfter({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_id: firstStep.step_id,
      step_index: 1,
      status: "success",
      output_signature: {
        http_status: 500,
        error_code: "ERR_INVALID_ARG_TYPE",
      },
      metadata: {
        touched_files: ["test/web-readable-stream.test.js"],
      },
    }, writeOpts);

    const secondStep = await replayStepBefore({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_index: 2,
      tool_name: "edit",
      tool_input: {
        file_path: "index.js",
        intent: "convert Web ReadableStream into a Node readable before compression",
      },
      preconditions: [
        { kind: "failure_signature", code: "ERR_INVALID_ARG_TYPE" },
      ],
      safety_level: "needs_confirm",
    }, writeOpts);
    await replayStepAfter({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_id: secondStep.step_id,
      step_index: 2,
      status: "success",
      output_signature: {
        changed_files: ["index.js", "lib/utils.js"],
        behavior: "web_readable_stream_bridge",
      },
      artifact_refs: [
        `workspace://${runId}/index.js`,
        `workspace://${runId}/lib/utils.js`,
      ],
      metadata: {
        touched_files: ["index.js", "lib/utils.js"],
      },
    }, writeOpts);

    const thirdStep = await replayStepBefore({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_index: 3,
      tool_name: "bash",
      tool_input: {
        command: "npm test && npm run lint && npm run test:typescript",
      },
      safety_level: "auto_ok",
    }, writeOpts);
    await replayStepAfter({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      step_id: thirdStep.step_id,
      step_index: 3,
      status: "success",
      output_signature: {
        exit_code: 0,
        verifier: "npm test && npm run lint && npm run test:typescript",
      },
    }, writeOpts);

    const successCriteria = {
      verifier_command: "npm test && npm run lint && npm run test:typescript",
      verifier_passed: true,
      acceptance_checks: [
        "Web ReadableStream gzip route returns HTTP 200",
        "npm test passes",
        "npm run lint passes",
        "npm run test:typescript passes",
      ],
      target_files: ["index.js", "lib/utils.js"],
    };
    await replayRunEnd({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      status: "success",
      summary: "Fixed Web ReadableStream compression and validated with the real package test commands.",
      success_criteria: successCriteria,
      metrics: {
        verifier_passed: true,
      },
      metadata: {
        task_family: "fastify_compress_stream_repair",
      },
    }, writeOpts);

    const compiled = await replayPlaybookCompileFromRun({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory_lane: "shared",
      run_id: runId,
      name: "Fastify compress Web ReadableStream repair",
      matchers: {
        task_family: "fastify_compress_stream_repair",
        repo: "fastify/fastify-compress",
      },
      success_criteria: successCriteria,
      metadata: {
        task_family: "fastify_compress_stream_repair",
        next_action: "Reuse only when the failure signature, target files, and verifier commands match.",
      },
    }, writeOpts);

    assert.equal(compiled.status, "draft");
    assert.equal((compiled.compile_summary as any).quality.low_quality_steps, 0);
    assert.equal((compiled.compile_summary as any).recommendations.length, 0);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: compiled.playbook_node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const playbookNode = rows[0];
    assert.ok(playbookNode);
    assert.equal(playbookNode.slots.status, "draft");
    assert.equal(playbookNode.slots.summary_kind, "workflow_candidate");
    assert.equal(playbookNode.slots.compression_layer, "L1");
    assert.equal(playbookNode.slots.execution_native_v1.execution_kind, "workflow_candidate");
    assert.equal(playbookNode.slots.execution_native_v1.workflow_promotion.promotion_origin, "replay_compile_from_run");
    assert.equal(playbookNode.slots.execution_native_v1.workflow_promotion.promotion_state, "candidate");
    assert.equal(playbookNode.slots.execution_native_v1.workflow_promotion.observed_count, 1);
    assert.equal(playbookNode.slots.execution_native_v1.workflow_promotion.required_observations, 2);
    assert.equal(playbookNode.slots.anchor_v1.source.source_kind, "playbook");
    assert.equal(playbookNode.slots.anchor_v1.source.run_id, runId);
    assert.deepEqual(playbookNode.slots.execution_contract_v1.target_files, ["index.js", "lib/utils.js", "test/web-readable-stream.test.js"]);
    assert.ok(
      playbookNode.slots.execution_contract_v1.outcome.acceptance_checks.includes(
        "npm test && npm run lint && npm run test:typescript",
      ),
    );
    assert.equal(playbookNode.slots.execution_contract_v1.contract_trust, "advisory");
    assert.equal(playbookNode.slots.execution_contract_v1.provenance.source_kind, "replay_compile_from_run");
    assert.deepEqual(
      playbookNode.slots.steps_template.map((step: any) => step.expected_output_signature != null),
      [true, true, true],
    );
    assert.deepEqual(
      playbookNode.slots.steps_template.map((step: any) => step.postconditions.some((condition: any) => condition.kind === "observed_output_signature")),
      [true, true, true],
    );

    const introspection = await buildExecutionMemoryIntrospectionLite(
      liteWriteStore,
      {
        tenant_id: "default",
        scope: "default",
        limit: 10,
      },
      "default",
      "default",
      "local-user",
    );
    const candidate = introspection.candidate_workflows.find((entry: any) => entry.anchor_id === compiled.playbook_node_id);
    assert.ok(candidate);
    assert.equal(candidate.source_kind, "playbook");
    assert.equal(candidate.promotion_origin, "replay_compile_from_run");
    assert.equal(candidate.promotion_state, "candidate");
    assert.equal(candidate.contract_trust, "advisory");
    assert.deepEqual(candidate.tool_set, ["bash", "edit"]);
    assert.equal(introspection.workflow_lifecycle_summary.candidate_count, 1);
    assert.equal(introspection.workflow_lifecycle_summary.replay_source_count, 1);
  } finally {
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("replayPlaybookPromote writes workflow anchor payload onto stable playbook versions", async () => {
  const dbPath = tmpDbPath("promote");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore, sourceNodeId } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    slotOverrides: authoritativeReplaySlotOverrides("promote"),
  });
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const out = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });

    assert.ok(out.playbook_node_id);
    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: out.playbook_node_id,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const promoted = rows[0];
    assert.ok(promoted);
    assert.equal(promoted.embedding_status, "ready");
    assert.equal(promoted.slots.summary_kind, "workflow_anchor");
    assert.equal(promoted.slots.compression_layer, "L2");
    assert.equal(promoted.slots.anchor_v1.anchor_kind, "workflow");
    assert.equal(promoted.slots.anchor_v1.anchor_level, "L2");
    assert.equal(promoted.slots.execution_native_v1.execution_kind, "workflow_anchor");
    assert.equal(promoted.slots.execution_native_v1.summary_kind, "workflow_anchor");
    assert.equal(promoted.slots.anchor_v1.maintenance.maintenance_state, "retain");
    assert.equal(promoted.slots.anchor_v1.maintenance.offline_priority, "retain_workflow");
    assert.equal(promoted.slots.execution_native_v1.workflow_promotion.promotion_origin, "replay_promote");
    assert.equal(promoted.slots.anchor_v1.workflow_promotion.promotion_state, "stable");
    assert.equal(promoted.slots.anchor_v1.workflow_promotion.promotion_origin, "replay_promote");
    assert.equal(promoted.slots.anchor_v1.workflow_promotion.last_transition, "promoted_to_stable");
    assert.equal(promoted.slots.anchor_v1.source.playbook_id, playbookId);
    assert.deepEqual(promoted.slots.anchor_v1.tool_set, ["edit", "test"]);
    assert.deepEqual(promoted.slots.anchor_v1.payload_refs.node_ids, [sourceNodeId]);
    assert.deepEqual(promoted.slots.anchor_v1.payload_refs.run_ids, [runId]);
    assert.equal(promoted.slots.execution_contract_v1.schema_version, "execution_contract_v1");
    assert.equal(promoted.slots.execution_contract_v1.task_signature, promoted.slots.anchor_v1.task_signature);
    assert.equal(promoted.slots.execution_contract_v1.workflow_signature, promoted.slots.anchor_v1.workflow_signature);
    assert.deepEqual(promoted.slots.execution_contract_v1.workflow_steps, promoted.slots.anchor_v1.key_steps);
    assert.equal(promoted.slots.semantic_forgetting_v1.action, "retain");
    assert.equal(promoted.slots.archive_relocation_v1.payload_scope, "anchor_payload");
    assert.equal(promoted.slots.archive_relocation_v1.relocation_state, "none");
  } finally {
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("stable replay playbook anchors are recallable through the procedure recall path", async () => {
  const dbPath = tmpDbPath("recall");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    slotOverrides: authoritativeReplaySlotOverrides("recall"),
  });
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const promoted = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });
    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: promoted.playbook_node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const promotedNode = rows[0];
    assert.ok(promotedNode);
    const anchor = promotedNode.slots.anchor_v1;
    const embedText = `${promotedNode.title}\n${anchor.summary}\n${anchor.tool_set.join(" ")}\n${anchor.task_signature}`;
    const queryEmbedding = (await DeterministicEmbeddingProvider.embed([embedText]))[0];
    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.ok(recall.seeds.some((seed) => seed.id === promoted.playbook_node_id && seed.type === "procedure"));
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.source_kind, "playbook");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.promotion_origin, "replay_promote");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.last_transition, "promoted_to_stable");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.rehydration_default_mode, "partial");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.maintenance_state, "retain");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.offline_priority, "retain_workflow");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.execution_contract_v1?.workflow_signature, promotedNode.slots.anchor_v1.workflow_signature);
    assert.ok(recall.context.items.some((item) => item.kind === "procedure" && item.node_id === promoted.playbook_node_id));
    assert.ok(Array.isArray((recall as any).runtime_tool_hints));
    assert.ok((recall as any).runtime_tool_hints.some((hint: any) => hint.anchor.id === promoted.playbook_node_id));
    assert.equal((recall as any).action_recall_packet.packet_version, "action_recall_v1");
    assert.ok((recall as any).action_recall_packet.recommended_workflows.some((entry: any) => entry.anchor_id === promoted.playbook_node_id));
    assert.ok((recall as any).action_recall_packet.rehydration_candidates.some((entry: any) => entry.anchor_id === promoted.playbook_node_id));
    const memoryPacket = AionisMemoryPacketSchema.parse((recall as any).aionis_memory_packet);
    assert.equal(memoryPacket.contract_version, "aionis_memory_packet_v1");
    assert.equal(memoryPacket.memory_family, "execution");
    assert.ok(memoryPacket.relevant_memories.some((entry) =>
      entry.memory_id === promoted.playbook_node_id && entry.domain === "execution"
    ));
    assert.ok(memoryPacket.behavior_impact.expected_effects.includes("tool_or_workflow_guidance"));
  } finally {
    await liteRecallStore.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("advisory replay playbook recall surfaces persisted contract trust without stable authority", async () => {
  const dbPath = tmpDbPath("recall-contract-trust");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    slotOverrides: {
      contract_trust: "advisory",
      execution_native_v1: {
        schema_version: "execution_native_v1",
        execution_kind: "execution_native",
        summary_kind: "handoff",
        compression_layer: "L0",
        contract_trust: "advisory",
        task_family: "external_content_visibility",
        target_files: ["/app/bin/install.sh"],
        next_action: "Review the deploy hook and rerun the smoke test from a fresh shell.",
      },
    },
  });
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const promoted = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });
    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: promoted.playbook_node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const promotedNode = rows[0];
    assert.ok(promotedNode);
    const anchor = promotedNode.slots.anchor_v1;
    const [queryEmbedding] = await DeterministicEmbeddingProvider.embed([
      `${promotedNode.title}\n${anchor.summary}\n${anchor.tool_set.join(" ")}\n${anchor.task_signature}`,
    ]);

    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal((recall as any).action_recall_packet.recommended_workflows.length, 0);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.contract_trust, "advisory");
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.execution_contract_v1?.contract_trust, "advisory");
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.promotion_state, "candidate");
  } finally {
    await liteRecallStore.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("replayPlaybookPromote preserves richer recovery contract fields while advisory anchors remain candidates", async () => {
  const dbPath = tmpDbPath("promote-rich-contract");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    slotOverrides: {
      contract_trust: "advisory",
      task_family: "service_publish_validate",
      target_files: ["scripts/build_and_serve.py", "pyproject.toml"],
      next_action: "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
      workflow_steps: [
        "python scripts/build_and_serve.py --port 8080",
        "curl http://localhost:8080/simple/vectorops/",
        "pip install --index-url http://localhost:8080/simple vectorops==0.1.0",
      ],
      pattern_hints: [
        "validate_from_clean_consumer_path",
        "revalidate_service_from_fresh_shell",
      ],
      service_lifecycle_constraints: [
        {
          version: 1,
          service_kind: "http",
          label: "service:http://localhost:8080/simple/vectorops/",
          launch_reference: "python scripts/build_and_serve.py --port 8080",
          endpoint: "http://localhost:8080/simple/vectorops/",
          must_survive_agent_exit: true,
          revalidate_from_fresh_shell: true,
          detach_then_probe: true,
          health_checks: [
            "curl http://localhost:8080/simple/vectorops/",
            "pip install --index-url http://localhost:8080/simple vectorops==0.1.0",
          ],
          teardown_notes: [],
        },
      ],
      execution_native_v1: {
        schema_version: "execution_native_v1",
        execution_kind: "execution_native",
        summary_kind: "handoff",
        compression_layer: "L0",
        contract_trust: "advisory",
        task_family: "service_publish_validate",
        target_files: ["scripts/build_and_serve.py", "pyproject.toml"],
        next_action: "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
        workflow_steps: [
          "python scripts/build_and_serve.py --port 8080",
          "curl http://localhost:8080/simple/vectorops/",
        ],
        pattern_hints: [
          "validate_from_clean_consumer_path",
          "revalidate_service_from_fresh_shell",
        ],
        service_lifecycle_constraints: [
          {
            version: 1,
            service_kind: "http",
            label: "service:http://localhost:8080/simple/vectorops/",
            launch_reference: "python scripts/build_and_serve.py --port 8080",
            endpoint: "http://localhost:8080/simple/vectorops/",
            must_survive_agent_exit: true,
            revalidate_from_fresh_shell: true,
            detach_then_probe: true,
            health_checks: [
              "curl http://localhost:8080/simple/vectorops/",
            ],
            teardown_notes: [],
          },
        ],
      },
      execution_result_summary: {
        trajectory_compile_v1: {
          task_family: "service_publish_validate",
        },
      },
      execution_evidence_v1: {
        schema_version: "execution_evidence_v1",
        validation_passed: true,
        after_exit_revalidated: true,
        fresh_shell_probe_passed: true,
        validation_boundary: "external_verifier",
        failure_reason: null,
        false_confidence_detected: false,
        evidence_refs: ["test:package-index-fresh-shell"],
      },
    },
  });
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const out = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: out.playbook_node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const promoted = rows[0];
    assert.ok(promoted);
    assert.equal(promoted.slots.anchor_v1.workflow_promotion.promotion_state, "candidate");
    assert.equal(promoted.slots.execution_native_v1.execution_kind, "workflow_candidate");
    assert.equal(promoted.slots.anchor_v1.contract_trust, "advisory");
    assert.equal(promoted.slots.anchor_v1.task_family, "service_publish_validate");
    assert.deepEqual(promoted.slots.anchor_v1.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
    assert.equal(
      promoted.slots.anchor_v1.next_action,
      "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
    );
    assert.ok(promoted.slots.anchor_v1.key_steps.includes("python scripts/build_and_serve.py --port 8080"));
    assert.ok(promoted.slots.anchor_v1.pattern_hints.includes("revalidate_service_from_fresh_shell"));
    assert.equal(promoted.slots.anchor_v1.service_lifecycle_constraints[0]?.must_survive_agent_exit, true);
    assert.equal(promoted.slots.execution_native_v1.contract_trust, "advisory");
    assert.equal(promoted.slots.execution_native_v1.task_family, "service_publish_validate");
    assert.deepEqual(promoted.slots.execution_native_v1.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
    assert.ok(promoted.slots.execution_native_v1.workflow_steps.includes("python scripts/build_and_serve.py --port 8080"));
    assert.ok(promoted.slots.execution_native_v1.pattern_hints.includes("validate_from_clean_consumer_path"));
    assert.equal(promoted.slots.execution_native_v1.service_lifecycle_constraints[0]?.revalidate_from_fresh_shell, true);
    assert.equal(promoted.slots.execution_contract_v1.contract_trust, "advisory");
    assert.equal(promoted.slots.execution_contract_v1.task_family, "service_publish_validate");
    assert.deepEqual(promoted.slots.execution_contract_v1.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
    assert.equal(
      promoted.slots.execution_contract_v1.outcome.must_hold_after_exit[0],
      "service_survives_agent_exit:service:http://localhost:8080/simple/vectorops/",
    );
  } finally {
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("planning recall prioritizes workflow anchors ahead of generic supporting concepts", async () => {
  const dbPath = tmpDbPath("planning-priority");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    slotOverrides: authoritativeReplaySlotOverrides("planning-priority"),
  });
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const promoted = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });
    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: promoted.playbook_node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const promotedNode = rows[0];
    assert.ok(promotedNode);
    const anchor = promotedNode.slots.anchor_v1;
    const embedText = `${promotedNode.title}\n${anchor.summary}\n${anchor.tool_set.join(" ")}\n${anchor.task_signature}`;
    const [queryEmbedding] = await DeterministicEmbeddingProvider.embed([embedText]);

    const prepared = await prepareMemoryWrite({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed generic concept near workflow anchor",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          client_id: "concept:supporting-knowledge",
          type: "concept",
          title: "Generic export debugging note",
          text_summary: "General note about fixing export-related failures in tests.",
          slots: {
            summary_kind: "write_distillation_fact",
            compression_layer: "L1",
          },
          embedding: queryEmbedding,
          embedding_model: DeterministicEmbeddingProvider.name,
          salience: 0.95,
          importance: 0.95,
          confidence: 0.95,
        },
      ],
      edges: [],
    }, "default", "default", {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    }, null);
    await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );

    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal(recall.ranked[0]?.id, promoted.playbook_node_id);
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.anchor_id, promoted.playbook_node_id);
    assert.ok((recall as any).action_recall_packet.supporting_knowledge.some((entry: any) => entry.title === "Generic export debugging note"));
  } finally {
    await liteRecallStore.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("planning recall treats execution_native_v1 workflow procedures as action memory without anchor_v1", async () => {
  const dbPath = tmpDbPath("execution-native-recall");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const workflowText = "Execution-native workflow only\nRecover workflow validation by inspect patch rerun\nworkflow-validation-recovery-node-tests";
    const conceptText = "Generic recall concept\nSupporting knowledge for export repair";
    const [workflowEmbedding, conceptEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText, conceptText]);

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed execution-native recall",
        memory_lane: "shared",
        auto_embed: false,
        nodes: [
          {
            type: "procedure",
            title: "Execution-native workflow only",
            text_summary: "Recover workflow validation by inspect patch rerun",
            embedding: workflowEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_anchor",
                summary_kind: "workflow_anchor",
                compression_layer: "L2",
                task_signature: "workflow-validation-recovery-node-tests",
                error_signature: "workflow-validation-mismatch",
                workflow_signature: "inspect-patch-rerun",
                anchor_kind: "workflow",
                anchor_level: "L2",
              },
            },
          },
          {
            type: "concept",
            title: "Generic recall concept",
            text_summary: "Supporting knowledge for export repair",
            embedding: conceptEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "note",
            },
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    const writeOut = await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );
    const workflowNodeId = writeOut.nodes.find((node) => node.type === "procedure")?.id ?? null;
    assert.ok(workflowNodeId);

    const [queryEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText]);
    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal(recall.seeds[0]?.id, workflowNodeId);
    assert.equal(recall.ranked[0]?.id, workflowNodeId);
    assert.ok((recall as any).action_recall_packet.recommended_workflows.some((entry: any) => entry.anchor_id === workflowNodeId));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning recall surfaces execution_native_v1 workflow candidates separately from stable workflows", async () => {
  const dbPath = tmpDbPath("workflow-candidate-recall");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const workflowText = "Replay Episode: Recover workflow validation failure\nReplay repair learning episode for validation failure";
    const conceptText = "Generic recall concept\nSupporting knowledge for export repair";
    const [workflowEmbedding, conceptEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText, conceptText]);

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed workflow candidate recall",
        memory_lane: "shared",
        auto_embed: false,
        nodes: [
          {
            type: "event",
            title: "Replay Episode: Recover workflow validation failure",
            text_summary: "Replay repair learning episode for validation failure",
            embedding: workflowEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_candidate",
                summary_kind: "workflow_candidate",
                compression_layer: "L1",
                task_signature: "workflow-validation-recovery-node-tests",
                workflow_signature: "replay-learning-candidate-export-fix",
                anchor_kind: "workflow",
                anchor_level: "L1",
                workflow_promotion: {
                  promotion_state: "candidate",
                  promotion_origin: "replay_learning_episode",
                  required_observations: 2,
                  observed_count: 1,
                  last_transition: "candidate_observed",
                  last_transition_at: "2026-03-20T00:00:00Z",
                  source_status: null,
                },
                maintenance: {
                  model: "lazy_online_v1",
                  maintenance_state: "observe",
                  offline_priority: "promote_candidate",
                  lazy_update_fields: ["usage_count", "last_used_at"],
                  last_maintenance_at: "2026-03-20T00:00:00Z",
                },
              },
            },
          },
          {
            type: "concept",
            title: "Generic recall concept",
            text_summary: "Supporting knowledge for export repair",
            embedding: conceptEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "note",
            },
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    const writeOut = await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );
    const workflowNodeId = writeOut.nodes.find((node) => node.type === "event")?.id ?? null;
    assert.ok(workflowNodeId);

    const [queryEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText]);
    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: queryEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal(recall.ranked[0]?.id, workflowNodeId);
    assert.equal((recall as any).action_recall_packet.recommended_workflows.length, 0);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.anchor_id, workflowNodeId);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.promotion_state, "candidate");
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.required_observations, 2);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.observed_count, 1);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.last_transition, "candidate_observed");
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.maintenance_state, "observe");
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.offline_priority, "promote_candidate");
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning recall prioritizes promotion-ready workflow candidates ahead of non-ready candidates", async () => {
  const dbPath = tmpDbPath("candidate-workflow-priority");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const workflowText = "Replay Episode: Recover workflow validation failure\nReplay repair learning episode for validation failure";
    const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText]);

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed candidate workflow priority recall",
        memory_lane: "shared",
        auto_embed: false,
        nodes: [
          {
            client_id: "event:workflow-candidate-not-ready",
            type: "event",
            title: "Replay Episode: Recover workflow validation failure",
            text_summary: "Replay repair learning episode for validation failure",
            embedding: sharedEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_candidate",
                summary_kind: "workflow_candidate",
                compression_layer: "L1",
                task_signature: "workflow-validation-recovery-node-tests",
                workflow_signature: "replay-learning-candidate-export-fix:not-ready",
                anchor_kind: "workflow",
                anchor_level: "L1",
                workflow_promotion: {
                  promotion_state: "candidate",
                  promotion_origin: "replay_learning_episode",
                  required_observations: 2,
                  observed_count: 1,
                  last_transition: "candidate_observed",
                  last_transition_at: "2026-03-20T00:00:00Z",
                  source_status: null,
                },
                maintenance: {
                  model: "lazy_online_v1",
                  maintenance_state: "observe",
                  offline_priority: "promote_candidate",
                  lazy_update_fields: ["usage_count", "last_used_at"],
                  last_maintenance_at: "2026-03-20T00:00:00Z",
                },
              },
            },
          },
          {
            client_id: "event:workflow-candidate-ready",
            type: "event",
            title: "Replay Episode: Recover workflow validation failure",
            text_summary: "Replay repair learning episode for validation failure",
            embedding: sharedEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_candidate",
                summary_kind: "workflow_candidate",
                compression_layer: "L1",
                task_signature: "workflow-validation-recovery-node-tests",
                workflow_signature: "replay-learning-candidate-export-fix:ready",
                anchor_kind: "workflow",
                anchor_level: "L1",
                workflow_promotion: {
                  promotion_state: "candidate",
                  promotion_origin: "replay_learning_episode",
                  required_observations: 2,
                  observed_count: 2,
                  last_transition: "candidate_observed",
                  last_transition_at: "2026-03-20T00:00:00Z",
                  source_status: null,
                },
                maintenance: {
                  model: "lazy_online_v1",
                  maintenance_state: "observe",
                  offline_priority: "promote_candidate",
                  lazy_update_fields: ["usage_count", "last_used_at"],
                  last_maintenance_at: "2026-03-20T00:00:00Z",
                },
              },
            },
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    const writeOut = await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );
    const readyNodeId = writeOut.nodes.find((node) => node.client_id === "event:workflow-candidate-ready")?.id ?? null;
    const notReadyNodeId = writeOut.nodes.find((node) => node.client_id === "event:workflow-candidate-not-ready")?.id ?? null;
    assert.ok(readyNodeId);
    assert.ok(notReadyNodeId);

    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: sharedEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal(recall.ranked[0]?.id, readyNodeId);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.anchor_id, readyNodeId);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[0]?.promotion_ready, true);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[1]?.anchor_id, notReadyNodeId);
    assert.equal((recall as any).action_recall_packet.candidate_workflows[1]?.promotion_ready, false);
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("planning recall suppresses candidate workflows when a stable workflow with the same signature exists", async () => {
  const dbPath = tmpDbPath("candidate-workflow-suppressed-by-stable");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const workflowText = "Replay learned workflow\nReplay repair learning episode for validation failure";
    const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed([workflowText]);

    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed stable and candidate workflow with same signature",
        memory_lane: "shared",
        auto_embed: false,
        nodes: [
          {
            client_id: "procedure:workflow-stable",
            type: "procedure",
            title: "Replay Learned Workflow: Recover workflow validation failure",
            text_summary: "Replay repair learning episode for validation failure",
            embedding: sharedEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_anchor",
                summary_kind: "workflow_anchor",
                compression_layer: "L2",
                task_signature: "workflow-validation-recovery-node-tests",
                workflow_signature: "replay-learning-candidate-export-fix",
                anchor_kind: "workflow",
                anchor_level: "L2",
                workflow_promotion: {
                  promotion_state: "stable",
                  promotion_origin: "replay_learning_auto_promotion",
                  required_observations: 2,
                  observed_count: 2,
                  last_transition: "promoted_to_stable",
                  last_transition_at: "2026-03-20T00:00:00Z",
                  source_status: null,
                },
                maintenance: {
                  model: "lazy_online_v1",
                  maintenance_state: "retain",
                  offline_priority: "retain_workflow",
                  lazy_update_fields: ["usage_count", "last_used_at"],
                  last_maintenance_at: "2026-03-20T00:00:00Z",
                },
                rehydration: {
                  default_mode: "partial",
                  payload_cost_hint: "medium",
                  recommended_when: ["workflow_summary_is_not_enough"],
                },
              },
            },
          },
          {
            client_id: "event:workflow-candidate-duplicate",
            type: "event",
            title: "Replay Episode: Recover workflow validation failure",
            text_summary: "Replay repair learning episode for validation failure",
            embedding: sharedEmbedding,
            embedding_model: "deterministic-test",
            slots: {
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "workflow_candidate",
                summary_kind: "workflow_candidate",
                compression_layer: "L1",
                task_signature: "workflow-validation-recovery-node-tests",
                workflow_signature: "replay-learning-candidate-export-fix",
                anchor_kind: "workflow",
                anchor_level: "L1",
                workflow_promotion: {
                  promotion_state: "candidate",
                  promotion_origin: "replay_learning_episode",
                  required_observations: 2,
                  observed_count: 1,
                  last_transition: "candidate_observed",
                  last_transition_at: "2026-03-20T00:00:00Z",
                  source_status: null,
                },
                maintenance: {
                  model: "lazy_online_v1",
                  maintenance_state: "observe",
                  offline_priority: "promote_candidate",
                  lazy_update_fields: ["usage_count", "last_used_at"],
                  last_maintenance_at: "2026-03-20T00:00:00Z",
                },
              },
            },
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    const writeOut = await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );
    const stableNodeId = writeOut.nodes.find((node) => node.client_id === "procedure:workflow-stable")?.id ?? null;
    assert.ok(stableNodeId);

    const recall = await memoryRecallParsed(MemoryRecallRequest.parse({
        tenant_id: "default",
        scope: "default",
        query_embedding: sharedEmbedding,
        limit: 5,
        neighborhood_hops: 1,
        max_nodes: 10,
        max_edges: 10,
        ranked_limit: 10,
      }),
      "default",
      "default",
      { allow_debug_embeddings: false },
      undefined,
      "planning_context",
      { recall_access: liteRecallStore.createRecallAccess(), internal_allow_l4_selection: true },
    );

    assert.equal(recall.ranked[0]?.id, stableNodeId);
    assert.equal((recall as any).action_recall_packet.recommended_workflows[0]?.anchor_id, stableNodeId);
    assert.equal((recall as any).action_recall_packet.candidate_workflows.length, 0);
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("replayPlaybookPromote normalizes latest stable playbooks onto workflow anchors without creating a new version", async () => {
  const dbPath = tmpDbPath("normalize-latest-stable");
  const playbookId = randomUUID();
  const runId = randomUUID();
  const { liteWriteStore, liteReplayStore, sourceNodeId } = await seedDraftPlaybook({
    writeStorePath: dbPath,
    playbookId,
    runId,
    status: "active",
    slotOverrides: authoritativeReplaySlotOverrides("normalize-latest-stable"),
  });
  try {
    const replayAccess = liteReplayStore.createReplayAccess();
    const beforeVersions = await replayAccess.listReplayPlaybookVersions("default", playbookId, {
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(beforeVersions.length, 1);
    assert.equal(beforeVersions[0]?.slots.anchor_v1, undefined);

    const seededRows = await liteWriteStore.findNodes({
      scope: "default",
      id: sourceNodeId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const seededNode = seededRows.rows[0];
    assert.ok(seededNode);
    const seededSlots = {
      ...(seededNode.slots ?? {}),
      execution_native_v1: {
        schema_version: "execution_native_v1",
        execution_kind: "workflow_anchor",
        summary_kind: "workflow_anchor",
        compression_layer: "L2",
        task_signature: `replay_playbook:${playbookId}`,
        workflow_signature: `replay_workflow:${playbookId}`,
        anchor_kind: "workflow",
        anchor_level: "L2",
        workflow_promotion: {
          promotion_state: "stable",
          promotion_origin: "replay_promote",
          last_transition: "promoted_to_stable",
          last_transition_at: "2026-03-20T00:00:00Z",
          source_status: "active",
        },
        maintenance: {
          model: "lazy_online_v1",
          maintenance_state: "retain",
          offline_priority: "retain_workflow",
          lazy_update_fields: ["usage_count", "last_used_at"],
          last_maintenance_at: "2026-03-20T00:00:00Z",
        },
        rehydration: {
          default_mode: "partial",
          payload_cost_hint: "low",
          recommended_when: ["workflow_summary_is_not_enough"],
        },
        distillation: {
          abstraction_state: "distilled",
          distillation_origin: "replay_learning_episode",
          source_kind: "replay_learning",
          preferred_promotion_target: "workflow",
          extraction_pattern: null,
          source_node_id: sourceNodeId,
          source_evidence_node_id: null,
          has_execution_signature: false,
          last_transition: "projected_from_replay_learning",
          last_transition_at: "2026-03-20T00:00:00Z",
        },
      },
    };
    const updatedSeed = await liteWriteStore.updateNodeAnchorState({
      scope: "default",
      id: sourceNodeId,
      slots: seededSlots,
      textSummary: seededNode.text_summary,
      salience: seededNode.salience,
      importance: seededNode.importance,
      confidence: seededNode.confidence,
      commitId: seededNode.commit_id,
    });
    assert.ok(updatedSeed);

    const out = await replayPlaybookPromote({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      playbook_id: playbookId,
      target_status: "active",
    }, {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: DeterministicEmbeddingProvider,
      replayAccess,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    });

    assert.equal(out.from_version, 1);
    assert.equal(out.to_version, 1);
    assert.equal(out.unchanged, false);
    assert.equal((out as any).reason, "normalized_latest_stable_anchor");
    assert.equal(out.playbook_node_id, sourceNodeId);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: sourceNodeId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const latestNode = rows[0];
    assert.ok(latestNode);
    assert.equal(latestNode.embedding_status, "ready");
    assert.equal(latestNode.slots.summary_kind, "workflow_anchor");
    assert.equal(latestNode.slots.anchor_v1.anchor_kind, "workflow");
    assert.equal(latestNode.slots.execution_native_v1.execution_kind, "workflow_anchor");
    assert.equal(latestNode.slots.anchor_v1.workflow_promotion.promotion_origin, "replay_stable_normalization");
    assert.equal(latestNode.slots.anchor_v1.workflow_promotion.last_transition, "normalized_latest_stable");
    assert.equal(latestNode.slots.execution_native_v1.workflow_promotion.promotion_origin, "replay_stable_normalization");
    assert.equal(latestNode.slots.execution_native_v1.distillation.distillation_origin, "replay_learning_episode");
    assert.equal(latestNode.slots.execution_native_v1.distillation.preferred_promotion_target, "workflow");
    assert.equal(latestNode.slots.anchor_v1.source.playbook_id, playbookId);
    assert.deepEqual(latestNode.slots.anchor_v1.payload_refs.node_ids, [sourceNodeId]);
    assert.equal(latestNode.slots.semantic_forgetting_v1.action, "retain");
    assert.equal(latestNode.slots.archive_relocation_v1.payload_scope, "anchor_payload");
    assert.equal(latestNode.slots.archive_relocation_v1.relocation_state, "none");

    const afterVersions = await replayAccess.listReplayPlaybookVersions("default", playbookId, {
      consumerAgentId: null,
      consumerTeamId: null,
    });
    assert.equal(afterVersions.length, 1);
    assert.equal(afterVersions[0]?.id, sourceNodeId);
    assert.equal(afterVersions[0]?.slots.summary_kind, "workflow_anchor");
    assert.equal(afterVersions[0]?.slots.anchor_v1.anchor_kind, "workflow");
  } finally {
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});
