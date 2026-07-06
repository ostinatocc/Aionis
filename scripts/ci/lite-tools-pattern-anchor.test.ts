import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { MemoryAnchorV1Schema, MemoryRecallRequest, ToolsFeedbackResponseSchema } from "../../src/memory/schemas.ts";
import { suppressPatternAnchorLite } from "../../src/memory/pattern-operator-override.ts";
import { extractTaskFamily, resolvePatternTaskAffinity } from "../../src/memory/pattern-trust-shaping.ts";
import { buildExecutionContractFromProjection, parseExecutionContract } from "../../src/memory/execution-contract.ts";
import { memoryRecallParsed } from "../../src/memory/recall.ts";
import { selectTools } from "../../src/memory/tools-select.ts";
import { toolSelectionFeedback } from "../../src/memory/tools-feedback.ts";
import { createEvidenceFormPatternLearningControlReviewProvider } from "../../src/memory/learning-control-provider-evidence.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-tools-pattern-anchor-"));
  return path.join(dir, `${name}.sqlite`);
}

async function seedActiveRule(
  writeStorePath: string,
  preferredTool = "edit",
): Promise<{ liteWriteStore: ReturnType<typeof createLiteWriteStore>; ruleNodeId: string }> {
  const liteWriteStore = createLiteWriteStore(writeStorePath);
  const ruleNodeId = await insertAndActivateRule(liteWriteStore, preferredTool, `workflow-validation-recovery-${preferredTool}`);
  return { liteWriteStore, ruleNodeId };
}

async function insertAndActivateRule(
  liteWriteStore: ReturnType<typeof createLiteWriteStore>,
  preferredTool: string,
  ruleSuffix: string,
): Promise<string> {
  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "create rule prefer edit for export repair",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          client_id: `rule:prefer-${preferredTool}:${ruleSuffix}`,
          type: "rule",
          title: `Prefer ${preferredTool} for export repair`,
          text_summary: `For workflow_validation_recovery tasks, prefer ${preferredTool} over the other tools.`,
          slots: {
            if: {
              task_kind: { $eq: "workflow_validation_recovery" },
            },
            then: {
              tool: {
                prefer: [preferredTool],
              },
            },
            exceptions: [],
            rule_scope: "global",
          },
        },
      ],
      edges: [],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );
  sealAuthorityReceiptsForPreparedWrite(prepared);
  const out = await liteWriteStore.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
      }),
  );
  const ruleNodeId = out.nodes[0]?.id ?? null;
  assert.ok(ruleNodeId);

  await liteWriteStore.withTx(() =>
      updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "active",
        input_text: `activate prefer ${preferredTool} rule`,
      }, "default", "default", {
        liteWriteStore,
      }),
  );

  return ruleNodeId;
}

async function seedActiveRules(
  writeStorePath: string,
  preferredTools: string[],
): Promise<{ liteWriteStore: ReturnType<typeof createLiteWriteStore>; ruleNodeIds: string[] }> {
  const liteWriteStore = createLiteWriteStore(writeStorePath);
  const ruleNodeIds: string[] = [];
  for (const [index, preferredTool] of preferredTools.entries()) {
    ruleNodeIds.push(await insertAndActivateRule(liteWriteStore, preferredTool, `workflow-validation-recovery-${preferredTool}-${index + 1}`));
  }
  return { liteWriteStore, ruleNodeIds };
}

test("extractTaskFamily derives family from recovery contract when plain task_family is absent", () => {
  const taskFamily = extractTaskFamily({
    goal: "recover deploy hook and rerun smoke checks",
    recovery_contract_v1: {
      task_family: "task:git-deploy-webserver",
      contract: {
        next_action: "Fix the git post-receive hook and rerun the web smoke test.",
        target_files: ["/srv/git/hooks/post-receive"],
      },
    },
  }, null);

  assert.equal(taskFamily, "task:git-deploy-webserver");
});

test("pattern trust shaping prefers canonical execution contract over stale recovery contract", () => {
  const context = {
    goal: "recover deploy hook and rerun smoke checks",
    execution_contract_v1: buildExecutionContractFromProjection({
      task_family: "task:canonical-deploy-flow",
      task_signature: "execution_task:canonical-deploy-flow",
      workflow_signature: "execution_workflow:canonical-deploy-flow",
      target_files: ["/srv/git/hooks/post-receive"],
      next_action: "Rebuild the deploy hook from the canonical contract.",
      provenance: {
        source_kind: "manual_context",
        source_summary_version: "test",
      },
    }),
    recovery_contract_v1: {
      task_family: "task:stale-deploy-flow",
      task_signature: "execution_task:stale-deploy-flow",
      workflow_signature: "execution_workflow:stale-deploy-flow",
      contract: {
        next_action: "Use the stale recovery contract.",
        target_files: ["/tmp/stale-hook"],
      },
    },
  };

  const taskFamily = extractTaskFamily(context, null);
  const affinity = resolvePatternTaskAffinity({
    context,
    selectedTool: "edit",
    storedTaskFamily: "task:canonical-deploy-flow",
    storedTaskSignature: "tools_select:execution_task:canonical-deploy-flow",
    storedErrorFamily: null,
  });

  assert.equal(taskFamily, "task:canonical-deploy-flow");
  assert.equal(affinity.level, "same_task_family");
  assert.equal(affinity.current_task_family, "task:canonical-deploy-flow");
});

test("resolvePatternTaskAffinity uses trajectory compile task family when direct task family is missing", () => {
  const affinity = resolvePatternTaskAffinity({
    context: {
      goal: "recover a package index server after a failed publish attempt",
      execution_result_summary: {
        trajectory_compile_v1: {
          task_family: "task:package-index-server",
          contract: {
            next_action: "Restart the package index server and verify install from a fresh shell.",
            target_files: ["/app/scripts/build_and_serve.py"],
          },
        },
      },
    },
    selectedTool: "edit",
    storedTaskFamily: "task:package-index-server",
    storedTaskSignature: null,
    storedErrorFamily: null,
  });

  assert.equal(affinity.level, "same_task_family");
  assert.equal(affinity.current_task_family, "task:package-index-server");
});

test("selectTools resolves trusted pattern identity from canonical execution contract before stale slots", async () => {
  const dbPath = tmpDbPath("pattern-canonical-identity-selector");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover workflow validation failure pattern"]);
  const canonicalContract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "task:workflow_validation_recovery",
    task_signature: "tools_select:workflow-validation-recovery-canonical",
    workflow_signature: "execution_workflow:workflow-validation-recovery-canonical",
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    acceptance_checks: ["npm test -- export"],
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "test",
      notes: ["canonical contract intentionally conflicts with stale selected_tool"],
    },
  });
  const stalePattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:stale-bash",
    task_class: "tools_select_pattern",
    task_family: "task:stale_repair",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "stale-bash-canonical-edit-pattern",
    summary: "Stable stale pattern whose canonical contract now points to edit.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "bash",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.92,
    },
    source: {
      source_kind: "tool_decision",
      decision_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [randomUUID(), randomUUID(), randomUUID()],
      step_ids: [],
      commit_ids: [],
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 3,
      reuse_failure_count: 0,
      distinct_run_count: 3,
      last_used_at: null,
    },
    promotion: {
      required_distinct_runs: 3,
      distinct_run_count: 3,
      observed_run_ids: [randomUUID(), randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      credibility_state: "trusted",
      previous_credibility_state: "candidate",
      last_transition: "promoted_to_trusted",
      last_transition_at: new Date().toISOString(),
      stable_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: null,
    },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_trusted",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    schema_version: "anchor_v1",
  });

  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed canonical contract pattern identity fixture",
        auto_embed: false,
        memory_lane: "shared",
        nodes: [
          {
            id: randomUUID(),
            type: "concept",
            title: "Canonical edit pattern over stale bash",
            text_summary: stalePattern.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: stalePattern,
              execution_contract_v1: canonicalContract,
              execution_native_v1: {
                schema_version: "execution_native_v1",
                execution_kind: "pattern_anchor",
                summary_kind: "pattern_anchor",
                compression_layer: "L3",
                task_signature: "tools_select:stale-bash",
                task_family: "task:stale_repair",
                error_family: "error:workflow-validation-mismatch",
                pattern_signature: stalePattern.pattern_signature,
                anchor_kind: "pattern",
                anchor_level: "L3",
                tool_set: stalePattern.tool_set,
                selected_tool: "bash",
                pattern_state: "stable",
                credibility_state: "trusted",
                promotion: stalePattern.promotion,
                maintenance: stalePattern.maintenance,
              },
            },
            embedding: sharedEmbedding,
            embedding_model: DeterministicEmbeddingProvider.name,
            salience: 0.8,
            importance: 0.9,
            confidence: 0.9,
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context: {
        task_kind: "workflow_validation_recovery",
        goal: "recover durable workflow from failed validation",
        error: {
          signature: "workflow-validation-mismatch",
        },
      },
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.rules.matched, 0);
    assert.equal(recalled.selection.selected, "edit");
    assert.equal(recalled.pattern_matches.trusted, 1);
    assert.equal(recalled.pattern_matches.anchors[0]?.selected_tool, "edit");
    assert.equal(recalled.pattern_matches.anchors[0]?.task_family, "task:workflow_validation_recovery");
    assert.equal(recalled.pattern_matches.anchors[0]?.affinity_level, "same_task_family");
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, ["edit"]);
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_tools, ["edit"]);
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("recall ranking prefers stable pattern anchors over counter-evidence-open candidates", async () => {
  const dbPath = tmpDbPath("pattern-recall-ranking");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover workflow validation failure pattern"]);
  const stableAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_class: "tools_select_pattern",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "stable-edit-pattern",
    summary: "Stable pattern: prefer edit for export repair after repeated successful rule-backed tool selections.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    outcome: { status: "success", result_class: "tool_selection_pattern_stable", success_score: 0.92 },
    source: { source_kind: "tool_decision", decision_id: randomUUID() },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [], step_ids: [], commit_ids: [] },
    metrics: { usage_count: 0, reuse_success_count: 2, reuse_failure_count: 0, distinct_run_count: 2, last_used_at: null },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      credibility_state: "trusted",
      previous_credibility_state: "candidate",
      last_transition: "promoted_to_trusted",
      last_transition_at: new Date().toISOString(),
      stable_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: null,
    },
    schema_version: "anchor_v1",
  });
  const contestedAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "provisional",
    credibility_state: "contested",
    task_signature: "tools_select:workflow-validation-recovery",
    task_class: "tools_select_pattern",
    pattern_signature: "contested-bash-pattern",
    summary: "Candidate pattern: prefer bash for export repair; counter-evidence observed.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "bash",
    outcome: { status: "mixed", result_class: "tool_selection_pattern_counter_evidence", success_score: 0.34 },
    source: { source_kind: "tool_decision", decision_id: randomUUID() },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [], step_ids: [], commit_ids: [] },
    metrics: { usage_count: 0, reuse_success_count: 2, reuse_failure_count: 1, distinct_run_count: 2, last_used_at: null },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 1,
      counter_evidence_open: true,
      credibility_state: "contested",
      previous_credibility_state: "trusted",
      last_transition: "counter_evidence_opened",
      last_transition_at: new Date().toISOString(),
      stable_at: null,
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: new Date().toISOString(),
    },
    schema_version: "anchor_v1",
  });
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed pattern ranking anchors",
        auto_embed: false,
        memory_lane: "shared",
        nodes: [
          {
            client_id: "pattern:stable:edit",
            type: "concept",
            title: "Stable edit pattern",
            text_summary: stableAnchor.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: stableAnchor,
            },
            embedding: sharedEmbedding,
            embedding_model: DeterministicEmbeddingProvider.name,
            salience: 0.8,
            importance: 0.9,
            confidence: 0.9,
          },
          {
            client_id: "pattern:contested:bash",
            type: "concept",
            title: "Contested bash pattern",
            text_summary: contestedAnchor.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: contestedAnchor,
            },
            embedding: sharedEmbedding,
            embedding_model: DeterministicEmbeddingProvider.name,
            salience: 0.8,
            importance: 0.9,
            confidence: 0.9,
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    const out = await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );

    const seeds = await liteRecallStore.createRecallAccess().stage1CandidatesAnn({
      queryEmbedding: sharedEmbedding,
      scope: "default",
      oversample: 10,
      limit: 2,
      consumerAgentId: null,
      consumerTeamId: null,
    });

    assert.equal(seeds.length, 2);
    assert.equal(seeds[0]?.id, out.nodes[0]?.id);
    assert.equal(seeds[1]?.id, out.nodes[1]?.id);
    assert.ok((seeds[0]?.similarity ?? 0) > (seeds[1]?.similarity ?? 0));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("positive tools feedback writes a provisional recallable pattern anchor", async () => {
  const dbPath = tmpDbPath("pattern-anchor");
  const { liteWriteStore, ruleNodeId } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const selection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore,
    });

    assert.equal(selection.selection.selected, "edit");

    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: selection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.ok(feedback.pattern_anchor);
    assert.equal(feedback.pattern_anchor?.anchor_kind, "pattern");
    assert.equal(feedback.pattern_anchor?.anchor_level, "L3");
    assert.equal(feedback.pattern_anchor?.pattern_state, "provisional");
    assert.equal(feedback.pattern_anchor?.credibility_state, "candidate");
    assert.equal(feedback.pattern_anchor?.maintenance?.maintenance_state, "observe");
    assert.equal(feedback.pattern_anchor?.maintenance?.offline_priority, "none");

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: feedback.pattern_anchor?.node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const anchorNode = rows[0];
    assert.ok(anchorNode);
    assert.equal(anchorNode.type, "concept");
    assert.equal(anchorNode.embedding_status, "ready");
    assert.equal(anchorNode.slots.summary_kind, "pattern_anchor");
    assert.equal(anchorNode.slots.compression_layer, "L3");
    assert.equal(anchorNode.slots.execution_native_v1.execution_kind, "pattern_anchor");
    assert.equal(anchorNode.slots.execution_native_v1.summary_kind, "pattern_anchor");
    assert.equal(anchorNode.slots.execution_native_v1.compression_layer, "L3");
    assert.equal(anchorNode.slots.execution_native_v1.anchor_kind, "pattern");
    assert.equal(anchorNode.slots.execution_native_v1.anchor_level, "L3");
    assert.equal(anchorNode.slots.execution_native_v1.contract_trust, "observational");
    assert.equal(anchorNode.slots.execution_native_v1.task_family, "task:workflow_validation_recovery");
    assert.equal(anchorNode.slots.execution_native_v1.error_family, "error:workflow-validation-mismatch");
    assert.equal(anchorNode.slots.execution_native_v1.pattern_state, "provisional");
    assert.equal(anchorNode.slots.execution_native_v1.credibility_state, "candidate");
    assert.equal(anchorNode.slots.execution_native_v1.selected_tool, "edit");
    assert.equal(anchorNode.slots.anchor_v1.anchor_kind, "pattern");
    assert.equal(anchorNode.slots.anchor_v1.anchor_level, "L3");
    assert.equal(anchorNode.slots.anchor_v1.contract_trust, "observational");
    assert.equal(anchorNode.slots.anchor_v1.pattern_state, "provisional");
    assert.equal(anchorNode.slots.anchor_v1.credibility_state, "candidate");
    assert.equal(anchorNode.slots.anchor_v1.task_family, "task:workflow_validation_recovery");
    assert.equal(anchorNode.slots.anchor_v1.error_family, "error:workflow-validation-mismatch");
    assert.equal(anchorNode.slots.anchor_v1.maintenance.maintenance_state, "observe");
    assert.equal(anchorNode.slots.anchor_v1.maintenance.offline_priority, "none");
    assert.equal(anchorNode.slots.anchor_v1.selected_tool, "edit");
    assert.equal(anchorNode.slots.anchor_v1.source.decision_id, selection.decision.decision_id);
    assert.deepEqual(anchorNode.slots.anchor_v1.payload_refs.decision_ids, [selection.decision.decision_id]);
    assert.deepEqual(anchorNode.slots.anchor_v1.payload_refs.node_ids, [ruleNodeId]);
    assert.equal(anchorNode.slots.anchor_v1.metrics.distinct_run_count, 1);
    assert.equal(anchorNode.slots.anchor_v1.promotion.distinct_run_count, 1);
    assert.equal(anchorNode.slots.anchor_v1.promotion.required_distinct_runs, 3);
    assert.equal(anchorNode.slots.anchor_v1.promotion.credibility_state, "candidate");
    assert.equal(anchorNode.slots.anchor_v1.promotion.last_transition, "candidate_observed");
    assert.deepEqual(anchorNode.slots.anchor_v1.promotion.observed_run_ids, [runId]);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.task_family, "task:workflow_validation_recovery");
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.error_family, "error:workflow-validation-mismatch");
    assert.deepEqual(anchorNode.slots.anchor_v1.trust_hardening.observed_task_families, ["task:workflow_validation_recovery"]);
    assert.deepEqual(anchorNode.slots.anchor_v1.trust_hardening.observed_error_families, ["error:workflow-validation-mismatch"]);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.distinct_task_family_count, 1);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.distinct_error_family_count, 1);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.post_contest_distinct_run_count, 0);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.promotion_gate_kind, "current_distinct_runs_v1");
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.promotion_gate_satisfied, false);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.revalidation_floor_kind, "post_contest_two_fresh_runs_v1");
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.revalidation_floor_satisfied, true);
    assert.equal(anchorNode.slots.anchor_v1.trust_hardening.task_affinity_weighting_enabled, false);
    assert.equal(anchorNode.slots.execution_native_v1.promotion.credibility_state, "candidate");
    assert.equal(anchorNode.slots.execution_native_v1.promotion.last_transition, "candidate_observed");
    assert.equal(anchorNode.slots.execution_native_v1.trust_hardening.task_family, "task:workflow_validation_recovery");
    assert.equal(anchorNode.slots.execution_native_v1.trust_hardening.error_family, "error:workflow-validation-mismatch");
    assert.equal(anchorNode.slots.execution_native_v1.maintenance.maintenance_state, "observe");
    const executionContract = parseExecutionContract(anchorNode.slots.execution_contract_v1);
    assert.equal(executionContract?.schema_version, "execution_contract_v1");
    assert.equal(executionContract?.contract_trust, "observational");
    assert.equal(executionContract?.task_family, "task:workflow_validation_recovery");
    assert.equal(executionContract?.selected_tool, "edit");
    assert.equal(
      executionContract?.next_action,
      "Prefer edit first for recover durable workflow from failed validation before widening tool search.",
    );
    assert.ok(executionContract?.workflow_steps?.includes("evaluate active tool rules"));
    assert.ok(executionContract?.pattern_hints?.includes("rule_backed_selection_pattern"));
    assert.ok(executionContract?.pattern_hints?.includes("provisional_tool_selection_pattern"));

    const queryEmbedding = (await DeterministicEmbeddingProvider.embed([anchorNode.title ?? ""]))[0];
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

    assert.ok(recall.seeds.some((seed) => seed.id === feedback.pattern_anchor?.node_id && seed.type === "concept"));
    assert.ok(recall.context.items.some((item) => item.kind === "concept" && item.node_id === feedback.pattern_anchor?.node_id));
    assert.ok(Array.isArray((recall as any).runtime_tool_hints));
    assert.ok((recall as any).runtime_tool_hints.some((hint: any) => hint.anchor.id === feedback.pattern_anchor?.node_id));
    assert.equal((recall as any).action_recall_packet.packet_version, "action_recall_v1");
    assert.ok((recall as any).action_recall_packet.candidate_patterns.some((entry: any) => entry.anchor_id === feedback.pattern_anchor?.node_id));
    assert.ok((recall as any).action_recall_packet.rehydration_candidates.some((entry: any) => entry.anchor_id === feedback.pattern_anchor?.node_id));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("positive tools feedback without matched rule sources still writes a provisional recallable pattern anchor", async () => {
  const dbPath = tmpDbPath("pattern-anchor-generic-feedback");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded without an active tool rule",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(feedback.updated_rules, 0);
    assert.deepEqual(feedback.rule_node_ids, []);
    assert.equal(feedback.decision_link_mode, "created_from_feedback");
    assert.ok(feedback.pattern_anchor);
    assert.equal(feedback.pattern_anchor?.pattern_state, "provisional");
    assert.equal(feedback.pattern_anchor?.credibility_state, "candidate");

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: feedback.pattern_anchor?.node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows.length, 1);
    const anchor = MemoryAnchorV1Schema.parse(rows[0]?.slots?.anchor_v1);
    assert.match(anchor.summary ?? "", /after one successful tool selection/i);
    assert.equal(anchor.selected_tool, "edit");

    const queryEmbedding = (await DeterministicEmbeddingProvider.embed([rows[0]?.title ?? ""]))[0];
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
    assert.ok(recall.seeds.some((seed) => seed.id === feedback.pattern_anchor?.node_id && seed.type === "concept"));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("automatic agent tools feedback without concrete target does not write a generic pattern anchor", async () => {
  const dbPath = tmpDbPath("pattern-anchor-automatic-generic-feedback");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const runId = randomUUID();
  const context = {
    runtime_consumer: "local-agent-runtime",
    telemetry_source: "agent_post_tool_use",
    prompt: "continue",
    tool_name: "functions.exec_command",
    tool_status: "success",
  };
  try {
    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-agent-runtime",
        run_id: runId,
        outcome: "positive",
        context,
        candidates: ["functions.exec_command", "functions.apply_patch", "functions.update_plan"],
        selected_tool: "functions.exec_command",
        target: "tool",
        note: "agent runtime functions.exec_command completed with success",
        input_text: JSON.stringify({ cmd: "git status --short" }),
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(feedback.updated_rules, 0);
    assert.deepEqual(feedback.rule_node_ids, []);
    assert.equal(feedback.decision_link_mode, "created_from_feedback");
    assert.equal(feedback.pattern_anchor ?? null, null);
    assert.equal(feedback.policy_memory ?? null, null);
  } finally {
    await liteWriteStore.close();
  }
});

test("automatic agent tools feedback with concrete target can still write a pattern anchor", async () => {
  const dbPath = tmpDbPath("pattern-anchor-automatic-concrete-feedback");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const runId = randomUUID();
  const context = {
    runtime_consumer: "local-agent-runtime",
    telemetry_source: "agent_post_tool_use",
    task_signature: "fix-runtime-tools-feedback-timeout",
    goal: "fix Runtime tools feedback timeout",
    target_files: ["src/memory/tools-feedback.ts"],
    tool_name: "functions.apply_patch",
    tool_status: "success",
  };
  try {
    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-agent-runtime",
        run_id: runId,
        outcome: "positive",
        context,
        candidates: ["functions.exec_command", "functions.apply_patch", "functions.update_plan"],
        selected_tool: "functions.apply_patch",
        target: "tool",
        note: "agent runtime functions.apply_patch completed with success",
        input_text: "patch tools-feedback timeout handling",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(feedback.updated_rules, 0);
    assert.deepEqual(feedback.rule_node_ids, []);
    assert.equal(feedback.decision_link_mode, "created_from_feedback");
    assert.ok(feedback.pattern_anchor);
    assert.equal(feedback.pattern_anchor?.pattern_state, "provisional");
    assert.equal(feedback.pattern_anchor?.credibility_state, "candidate");
  } finally {
    await liteWriteStore.close();
  }
});

test("positive tools feedback with multiple matched rule sources exposes form_pattern learning_control preview", async () => {
  const dbPath = tmpDbPath("pattern-anchor-learning_control-preview");
  const { liteWriteStore, ruleNodeIds } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const selection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore,
    });

    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: selection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded with two matched rule sources",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    const parsed = ToolsFeedbackResponseSchema.parse(feedback);
    assert.ok(parsed.pattern_anchor);
    assert.ok(parsed.learning_control_preview?.form_pattern);
    assert.equal(parsed.learning_control_preview?.form_pattern.review_packet.operation, "form_pattern");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_packet.source_count, 2);
    assert.equal(parsed.learning_control_preview?.form_pattern.review_packet.deterministic_gate.gate_satisfied, true);
    assert.equal(
      parsed.learning_control_preview?.form_pattern.review_packet.signatures.task_signature,
      "tools_select:recover-durable-workflow-from-failed-validation",
    );
    assert.equal(parsed.learning_control_preview?.form_pattern.review_packet.signatures.error_signature, "workflow-validation-mismatch");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_packet.source_examples.length, 2);
    assert.deepEqual(
      uniqueStrings(parsed.learning_control_preview?.form_pattern.review_packet.source_examples.map((entry) => entry.node_id)),
      uniqueStrings(ruleNodeIds),
    );
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.trace_version, "form_pattern_learning_control_trace_v1");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.review_supplied, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissibility_evaluated, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissible, null);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.applies, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.effective_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.reason_code, "review_not_supplied");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.policy_effect_applies, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.effective_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.runtime_apply_changed_pattern_state, false);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.stage_order, [
      "review_packet_built",
      "policy_effect_derived",
    ]);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.reason_codes, ["review_not_supplied"]);
  } finally {
    await liteWriteStore.close();
  }
});

test("tools feedback form_pattern learning_control preview evaluates admitted review results", async () => {
  const dbPath = tmpDbPath("pattern-anchor-learning_control-admissible");
  const { liteWriteStore } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const selection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore,
    });

    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: selection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded with high-confidence grouped evidence",
        input_text: "recover durable workflow from failed validation",
        learning_control_review: {
          form_pattern: {
            review_result: {
              review_version: "form_pattern_semantic_review_v1",
              adjudication: {
                operation: "form_pattern",
                disposition: "recommend",
                target_kind: "pattern",
                target_level: "L3",
                reason: "Grouped repair traces share one stable reusable pattern",
                confidence: 0.89,
              },
            },
          },
        },
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    const parsed = ToolsFeedbackResponseSchema.parse(feedback);
    assert.equal(parsed.pattern_anchor?.pattern_state, "stable");
    assert.equal(parsed.pattern_anchor?.credibility_state, "trusted");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.adjudication.confidence, 0.89);
    assert.equal(parsed.learning_control_preview?.form_pattern.admissibility?.admissible, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.admissibility?.accepted_mutation_count, 1);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.applies, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.source, "form_pattern_learning_control_review");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.review_suggested_pattern_state, "stable");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.effective_pattern_state, "stable");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.reason_code, "high_confidence_pattern_stabilization");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.review_supplied, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissibility_evaluated, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissible, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.policy_effect_applies, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.effective_pattern_state, "stable");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.runtime_apply_changed_pattern_state, true);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.stage_order, [
      "review_packet_built",
      "review_result_received",
      "admissibility_evaluated",
      "policy_effect_derived",
      "runtime_policy_applied",
    ]);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.reason_codes, []);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: parsed.pattern_anchor?.node_id ?? "",
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const storedAnchor = MemoryAnchorV1Schema.parse(rows[0]?.slots?.anchor_v1);
    assert.equal(storedAnchor.pattern_state, "stable");
    assert.equal(storedAnchor.credibility_state, "trusted");
    assert.equal(storedAnchor.promotion?.credibility_state, "trusted");
    assert.equal(storedAnchor.trust_hardening?.semantic_review_override_applied, true);
    assert.equal(storedAnchor.trust_hardening?.semantic_review_override_reason, "high_confidence_form_pattern_review");
  } finally {
    await liteWriteStore.close();
  }
});

test("tools feedback form_pattern learning_control preview rejects low-confidence review results", async () => {
  const dbPath = tmpDbPath("pattern-anchor-learning_control-rejected");
  const { liteWriteStore } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const selection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore,
    });

    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: selection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair produced uncertain grouped evidence",
        input_text: "recover durable workflow from failed validation",
        learning_control_review: {
          form_pattern: {
            review_result: {
              review_version: "form_pattern_semantic_review_v1",
              adjudication: {
                operation: "form_pattern",
                disposition: "recommend",
                target_kind: "pattern",
                target_level: "L3",
                reason: "This might be the same pattern",
                confidence: 0.55,
              },
            },
          },
        },
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    const parsed = ToolsFeedbackResponseSchema.parse(feedback);
    assert.equal(parsed.learning_control_preview?.form_pattern.admissibility?.admissible, false);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.admissibility?.reason_codes, ["confidence_too_low"]);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.applies, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.source, "default_pattern_anchor_state");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.effective_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.reason_code, "review_not_admissible");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.review_supplied, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissibility_evaluated, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.admissible, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.policy_effect_applies, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.base_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.effective_pattern_state, "provisional");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.runtime_apply_changed_pattern_state, false);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.stage_order, [
      "review_packet_built",
      "review_result_received",
      "admissibility_evaluated",
      "policy_effect_derived",
    ]);
    assert.deepEqual(parsed.learning_control_preview?.form_pattern.decision_trace.reason_codes, [
      "confidence_too_low",
      "review_not_admissible",
    ]);
  } finally {
    await liteWriteStore.close();
  }
});

test("tools feedback form_pattern learning_control can use internal evidence provider without explicit review", async () => {
  const dbPath = tmpDbPath("pattern-anchor-learning_control-provider");
  const { liteWriteStore } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const selection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore,
    });

    const feedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: selection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded with grouped provider-backed evidence",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        learningControlReviewProviders: {
          form_pattern: createEvidenceFormPatternLearningControlReviewProvider(),
        },
        liteWriteStore,
      }),
    );

    const parsed = ToolsFeedbackResponseSchema.parse(feedback);
    assert.equal(parsed.pattern_anchor?.pattern_state, "stable");
    assert.equal(parsed.pattern_anchor?.credibility_state, "trusted");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.review_version, "form_pattern_semantic_review_v1");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.adjudication.reason, "evidence provider found grouped signature evidence");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.adjudication.confidence, 0.85);
    assert.equal(parsed.learning_control_preview?.form_pattern.admissibility?.admissible, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.applies, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.effective_pattern_state, "stable");
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.review_supplied, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.runtime_apply_changed_pattern_state, true);
  } finally {
    await liteWriteStore.close();
  }
});

test("selectTools does not trust provisional pattern anchors after the source rule is disabled", async () => {
  const dbPath = tmpDbPath("pattern-selector");
  const { liteWriteStore, ruleNodeId } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const runId = randomUUID();
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const initial = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: runId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });
    assert.equal(initial.selection.selected, "edit");

    const firstFeedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: runId,
        decision_id: initial.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );
    assert.equal(firstFeedback.pattern_anchor?.pattern_state, "provisional");

    await liteWriteStore.withTx(() =>
      updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "disabled",
        input_text: "disable prefer edit rule after pattern distillation",
      }, "default", "default", {
        liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.rules.matched, 0);
    assert.equal(recalled.pattern_matches.matched, 1);
    assert.equal(recalled.pattern_matches.trusted, 0);
    assert.deepEqual(recalled.pattern_matches.preferred_tools, []);
    assert.equal(recalled.pattern_matches.anchors[0]?.pattern_state, "provisional");
    assert.equal(recalled.pattern_matches.anchors[0]?.credibility_state, "candidate");
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(recalled.decision.pattern_summary.skipped_contested_pattern_tools, ["edit"]);
    assert.equal(recalled.selection_summary.trusted_pattern_count, 0);
    assert.equal(recalled.selection_summary.contested_pattern_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.candidate_count, 1);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.trusted_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.contested_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.near_promotion_count, 0);
    assert.deepEqual(recalled.selection_summary.pattern_lifecycle_summary.transition_counts, {
      candidate_observed: 1,
      promoted_to_trusted: 0,
      counter_evidence_opened: 0,
      revalidated_to_trusted: 0,
    });
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(recalled.selection_summary.skipped_contested_pattern_tools, []);
    assert.equal(
      recalled.selection_summary.provenance_explanation,
      "selected tool: bash; candidate patterns visible but not yet trusted: edit",
    );
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("selectTools reuses stable pattern anchors after distinct successful runs", async () => {
  const dbPath = tmpDbPath("stable-pattern-selector");
  const { liteWriteStore, ruleNodeId } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const baseContext = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const promotionStates: string[] = [];
    let stableAnchorId: string | null = null;
    for (const runId of [randomUUID(), randomUUID(), randomUUID()]) {
      const selection = await selectTools({
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context: baseContext,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      }, "default", "default", {
        embedder: DeterministicEmbeddingProvider,
        recallAccess: liteRecallStore.createRecallAccess(),
        liteWriteStore,
      });
      assert.equal(selection.selection.selected, "edit");

      const feedback = await liteWriteStore.withTx(() =>
        toolSelectionFeedback(null, {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          run_id: runId,
          decision_id: selection.decision.decision_id,
          outcome: "positive",
          context: baseContext,
          candidates: ["bash", "edit", "test"],
          selected_tool: "edit",
          target: "tool",
          note: "Edit-based repair succeeded",
          input_text: "recover durable workflow from failed validation",
        }, "default", "default", {
          maxTextLen: 10_000,
          piiRedaction: false,
          embedder: DeterministicEmbeddingProvider,
          liteWriteStore,
        }),
      );
      promotionStates.push(feedback.pattern_anchor?.pattern_state ?? "missing");
      stableAnchorId = feedback.pattern_anchor?.node_id ?? stableAnchorId;
    }
    assert.deepEqual(promotionStates, ["provisional", "provisional", "stable"]);
    assert.ok(stableAnchorId);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: stableAnchorId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.anchor_v1.pattern_state, "stable");
    assert.equal(rows[0]?.slots.anchor_v1.maintenance.maintenance_state, "retain");
    assert.equal(rows[0]?.slots.anchor_v1.maintenance.offline_priority, "retain_trusted");
    assert.equal(rows[0]?.slots.anchor_v1.metrics.distinct_run_count, 3);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.distinct_run_count, 3);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.required_distinct_runs, 3);
    assert.equal(rows[0]?.slots.anchor_v1.payload_refs.run_ids.length, 3);

    await liteWriteStore.withTx(() =>
      updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "disabled",
        input_text: "disable prefer edit rule after stable pattern promotion",
      }, "default", "default", {
        liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context: baseContext,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.rules.matched, 0);
    assert.equal(recalled.selection.selected, "edit");
    assert.equal(recalled.pattern_matches.matched, 1);
    assert.equal(recalled.pattern_matches.trusted, 1);
    assert.deepEqual(recalled.pattern_matches.preferred_tools, ["edit"]);
    assert.deepEqual(
      uniqueStrings(recalled.pattern_matches.anchors.map((anchor) => anchor.selected_tool)),
      ["edit"],
    );
    assert.equal(recalled.pattern_matches.anchors[0]?.pattern_state, "stable");
    assert.equal(recalled.pattern_matches.anchors[0]?.credibility_state, "trusted");
    assert.equal(recalled.pattern_matches.anchors[0]?.trusted, true);
    assert.equal(recalled.pattern_matches.matched, 1);
    assert.equal(recalled.selection.ordered[0], "edit");
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, ["edit"]);
    assert.deepEqual(
      recalled.decision.pattern_summary.used_trusted_pattern_anchor_ids,
      recalled.pattern_matches.anchors.filter((anchor) => anchor.trusted).map((anchor) => anchor.node_id),
    );
    assert.deepEqual(recalled.decision.pattern_summary.skipped_contested_pattern_tools, []);
    assert.deepEqual(recalled.decision.pattern_summary.skipped_contested_pattern_anchor_ids, []);
    assert.equal(recalled.selection_summary.trusted_pattern_count, 1);
    assert.equal(recalled.selection_summary.contested_pattern_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.candidate_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.trusted_count, 1);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.contested_count, 0);
    assert.deepEqual(recalled.selection_summary.pattern_lifecycle_summary.transition_counts, {
      candidate_observed: 0,
      promoted_to_trusted: 1,
      counter_evidence_opened: 0,
      revalidated_to_trusted: 0,
    });
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_tools, ["edit"]);
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_affinity_levels ?? [], ["exact_task_signature"]);
    assert.deepEqual(recalled.selection_summary.skipped_contested_pattern_tools, []);
    assert.deepEqual(
      recalled.selection_summary.used_trusted_pattern_tools,
      recalled.decision.pattern_summary.used_trusted_pattern_tools,
    );
    assert.equal(
      recalled.selection_summary.pattern_lifecycle_summary.trusted_count,
      recalled.pattern_matches.anchors.filter((anchor) => anchor.trusted).length,
    );
    assert.equal(
      recalled.selection_summary.provenance_explanation,
      "selected tool: edit; trusted pattern support: edit [exact_task_signature]",
    );
    const stableNodeLookup = await liteWriteStore.findNodes({
      scope: "default",
      id: stableAnchorId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const stableAnchorNode = stableNodeLookup.rows[0];
    assert.ok(stableAnchorNode);
    assert.equal(stableAnchorNode.slots.execution_native_v1.execution_kind, "pattern_anchor");
    assert.equal(stableAnchorNode.slots.execution_native_v1.contract_trust, "advisory");
    assert.equal(stableAnchorNode.slots.execution_native_v1.pattern_state, "stable");
    assert.equal(stableAnchorNode.slots.execution_native_v1.credibility_state, "trusted");
    assert.equal(stableAnchorNode.slots.execution_native_v1.promotion.last_transition, "promoted_to_trusted");
    assert.equal(stableAnchorNode.slots.execution_native_v1.maintenance.maintenance_state, "retain");
    const stableExecutionContract = parseExecutionContract(stableAnchorNode.slots.execution_contract_v1);
    assert.equal(stableExecutionContract?.contract_trust, "advisory");
    assert.equal(stableExecutionContract?.selected_tool, "edit");
    assert.ok(stableExecutionContract?.pattern_hints?.includes("stable_tool_selection_pattern"));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("selectTools keeps explicit tool.prefer ahead of trusted pattern preferences", async () => {
  const dbPath = tmpDbPath("pattern-explicit-prefer-order");
  const { liteWriteStore } = await seedActiveRule(dbPath, "bash");
  const liteRecallStore = createLiteRecallStore(dbPath);
  const sharedEmbedding = (await DeterministicEmbeddingProvider.embed(["recover workflow validation failure pattern"]))[0];
  const patternNodeId = randomUUID();
  const stablePattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_class: "tools_select_pattern",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "stable-edit-pattern",
    summary: "Stable pattern: prefer edit for workflow_validation_recovery after repeated successful runs.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.93,
    },
    source: {
      source_kind: "tool_decision",
      decision_id: randomUUID(),
    },
    payload_refs: {
      node_ids: [],
      decision_ids: [],
      run_ids: [randomUUID(), randomUUID()],
      step_ids: [],
      commit_ids: [],
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 2,
      reuse_failure_count: 0,
      distinct_run_count: 2,
      last_used_at: null,
    },
    promotion: {
      required_distinct_runs: 2,
      distinct_run_count: 2,
      observed_run_ids: [randomUUID(), randomUUID()],
      counter_evidence_count: 0,
      counter_evidence_open: false,
      credibility_state: "trusted",
      previous_credibility_state: "candidate",
      last_transition: "promoted_to_trusted",
      last_transition_at: new Date().toISOString(),
      stable_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      last_counter_evidence_at: null,
    },
    schema_version: "anchor_v1",
  });
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed stable edit pattern against explicit bash preference",
        auto_embed: false,
        memory_lane: "shared",
        nodes: [
          {
            id: patternNodeId,
            type: "concept",
            title: "Stable edit pattern",
            text_summary: stablePattern.summary,
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: stablePattern,
            },
            embedding: sharedEmbedding,
            embedding_model: DeterministicEmbeddingProvider.name,
            salience: 0.8,
            importance: 0.9,
            confidence: 0.9,
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context: {
        task_kind: "workflow_validation_recovery",
        goal: "recover durable workflow from failed validation",
        error: {
          signature: "workflow-validation-mismatch",
        },
      },
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.pattern_matches.trusted, 1);
    assert.deepEqual(recalled.pattern_matches.preferred_tools, ["edit"]);
    assert.equal(recalled.selection.selected, "bash");
    assert.deepEqual(recalled.selection.preferred, ["bash"]);
    assert.deepEqual(recalled.selection.ordered.slice(0, 2), ["bash", "edit"]);
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(
      recalled.decision.pattern_summary.used_trusted_pattern_anchor_ids,
      [],
    );
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(recalled.selection_summary.used_trusted_pattern_affinity_levels ?? [], []);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.trusted_count, 1);
    assert.equal(
      recalled.selection_summary.pattern_lifecycle_summary.trusted_count,
      recalled.pattern_matches.anchors.filter((anchor) => anchor.trusted).length,
    );
    assert.equal(
      recalled.selection_summary.provenance_explanation,
      "selected tool: bash; trusted patterns available but not used: edit [same_task_family]",
    );
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("selectTools excludes suppressed trusted patterns from trusted reuse without mutating learned credibility", async () => {
  const dbPath = tmpDbPath("pattern-suppress-selector");
  const { liteWriteStore, ruleNodeId } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const baseContext = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    let stableAnchorId: string | null = null;
    for (const runId of [randomUUID(), randomUUID(), randomUUID()]) {
      const selection = await selectTools({
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context: baseContext,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      }, "default", "default", {
        embedder: DeterministicEmbeddingProvider,
        recallAccess: liteRecallStore.createRecallAccess(),
        liteWriteStore,
      });
      const feedback = await liteWriteStore.withTx(() =>
        toolSelectionFeedback(null, {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          run_id: runId,
          decision_id: selection.decision.decision_id,
          outcome: "positive",
          context: baseContext,
          candidates: ["bash", "edit", "test"],
          selected_tool: "edit",
          target: "tool",
          note: "Edit-based repair succeeded",
          input_text: "recover durable workflow from failed validation",
        }, "default", "default", {
          maxTextLen: 10_000,
          piiRedaction: false,
          embedder: DeterministicEmbeddingProvider,
          liteWriteStore,
        }),
      );
      stableAnchorId = feedback.pattern_anchor?.node_id ?? stableAnchorId;
    }
    assert.ok(stableAnchorId);

    await liteWriteStore.withTx(() =>
      updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "disabled",
        input_text: "disable prefer edit rule before suppression test",
      }, "default", "default", {
        liteWriteStore,
      }),
    );

    await liteWriteStore.withTx(() =>
      suppressPatternAnchorLite({
        body: {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          anchor_id: stableAnchorId,
          reason: "operator stop-loss",
        },
        defaultScope: "default",
        defaultTenantId: "default",
        liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context: baseContext,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.selection.selected, "bash");
    assert.equal(recalled.pattern_matches.matched, 1);
    assert.equal(recalled.pattern_matches.trusted, 0);
    assert.equal(recalled.pattern_matches.anchors[0]?.credibility_state, "trusted");
    assert.equal(recalled.pattern_matches.anchors[0]?.suppressed, true);
    assert.equal(recalled.pattern_matches.anchors[0]?.trusted, false);
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(recalled.decision.pattern_summary.skipped_suppressed_pattern_tools, ["edit"]);
    assert.equal(recalled.selection_summary.trusted_pattern_count, 0);
    assert.equal(recalled.selection_summary.suppressed_pattern_count, 1);
    assert.deepEqual(recalled.selection_summary.skipped_suppressed_pattern_tools, ["edit"]);
    assert.equal(
      recalled.selection_summary.provenance_explanation,
      "selected tool: bash; suppressed patterns visible but operator-blocked: edit",
    );

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: stableAnchorId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.anchor_v1.credibility_state, "trusted");
    assert.equal(rows[0]?.slots.operator_override_v1.suppressed, true);
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("negative tools feedback demotes a stable pattern back to provisional", async () => {
  const dbPath = tmpDbPath("pattern-counter-evidence");
  const { liteWriteStore, ruleNodeId } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    let anchorId: string | null = null;
    for (const runId of [randomUUID(), randomUUID()]) {
      const selection = await selectTools({
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      }, "default", "default", {
        embedder: DeterministicEmbeddingProvider,
        recallAccess: liteRecallStore.createRecallAccess(),
        liteWriteStore,
      });
      const feedback = await liteWriteStore.withTx(() =>
        toolSelectionFeedback(null, {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          run_id: runId,
          decision_id: selection.decision.decision_id,
          outcome: "positive",
          context,
          candidates: ["bash", "edit", "test"],
          selected_tool: "edit",
          target: "tool",
          note: "Edit-based repair succeeded",
          input_text: "recover durable workflow from failed validation",
        }, "default", "default", {
          maxTextLen: 10_000,
          piiRedaction: false,
          embedder: DeterministicEmbeddingProvider,
          liteWriteStore,
        }),
      );
      anchorId = feedback.pattern_anchor?.node_id ?? anchorId;
    }

    assert.ok(anchorId);
    const negativeRunId = randomUUID();
    const negativeSelection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: negativeRunId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });
    const negativeFeedback = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: negativeRunId,
        decision_id: negativeSelection.decision.decision_id,
        outcome: "negative",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair failed on rerun",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(negativeFeedback.pattern_anchor?.node_id, anchorId);
    assert.equal(negativeFeedback.pattern_anchor?.pattern_state, "provisional");
    assert.equal(negativeFeedback.pattern_anchor?.credibility_state, "contested");

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: anchorId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.anchor_v1.pattern_state, "provisional");
    assert.equal(rows[0]?.slots.anchor_v1.credibility_state, "contested");
    assert.equal(rows[0]?.slots.anchor_v1.maintenance.maintenance_state, "review");
    assert.equal(rows[0]?.slots.anchor_v1.maintenance.offline_priority, "review_counter_evidence");
    assert.equal(rows[0]?.slots.anchor_v1.metrics.reuse_failure_count, 1);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.counter_evidence_count, 1);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.counter_evidence_open, true);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.credibility_state, "contested");
    assert.equal(rows[0]?.slots.anchor_v1.promotion.last_transition, "counter_evidence_opened");
    assert.equal(rows[0]?.slots.anchor_v1.promotion.last_counter_evidence_at != null, true);
    assert.equal(rows[0]?.slots.anchor_v1.trust_hardening.post_contest_distinct_run_count, 0);

    await liteWriteStore.withTx(() =>
      updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "disabled",
        input_text: "disable prefer edit rule after counter evidence",
      }, "default", "default", {
        liteWriteStore,
      }),
    );

    const recalled = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: true,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });

    assert.equal(recalled.rules.matched, 0);
    assert.equal(recalled.pattern_matches.matched, 1);
    assert.equal(recalled.pattern_matches.trusted, 0);
    assert.deepEqual(recalled.pattern_matches.preferred_tools, []);
    assert.equal(recalled.pattern_matches.anchors[0]?.pattern_state, "provisional");
    assert.equal(recalled.pattern_matches.anchors[0]?.credibility_state, "contested");
    assert.deepEqual(recalled.decision.pattern_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(recalled.decision.pattern_summary.skipped_contested_pattern_tools, ["edit"]);
    assert.deepEqual(
      recalled.decision.pattern_summary.skipped_contested_pattern_anchor_ids,
      recalled.pattern_matches.anchors.filter((anchor) => anchor.counter_evidence_open).map((anchor) => anchor.node_id),
    );
    assert.equal(recalled.selection_summary.trusted_pattern_count, 0);
    assert.equal(recalled.selection_summary.contested_pattern_count, 1);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.candidate_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.trusted_count, 0);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.contested_count, 1);
    assert.equal(recalled.selection_summary.pattern_lifecycle_summary.counter_evidence_open_count, 1);
    assert.equal(
      recalled.selection_summary.pattern_lifecycle_summary.contested_count,
      recalled.pattern_matches.anchors.filter((anchor) => anchor.counter_evidence_open).length,
    );
    assert.deepEqual(recalled.selection_summary.pattern_lifecycle_summary.transition_counts, {
      candidate_observed: 0,
      promoted_to_trusted: 0,
      counter_evidence_opened: 1,
      revalidated_to_trusted: 0,
    });
    assert.equal(
      recalled.selection_summary.provenance_explanation,
      "selected tool: bash; contested patterns visible but not trusted: edit",
    );
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("contested pattern requires two fresh positive runs before revalidation to trusted", async () => {
  const dbPath = tmpDbPath("pattern-revalidation");
  const { liteWriteStore } = await seedActiveRule(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const context = {
    task_kind: "workflow_validation_recovery",
    goal: "recover durable workflow from failed validation",
    error: {
      signature: "workflow-validation-mismatch",
    },
  };
  try {
    const stableRunIds = [randomUUID(), randomUUID(), randomUUID()];
    let anchorId: string | null = null;
    for (const runId of stableRunIds) {
      const selection = await selectTools({
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      }, "default", "default", {
        embedder: DeterministicEmbeddingProvider,
        recallAccess: liteRecallStore.createRecallAccess(),
        liteWriteStore,
      });
      const feedback = await liteWriteStore.withTx(() =>
        toolSelectionFeedback(null, {
          tenant_id: "default",
          scope: "default",
          actor: "local-user",
          run_id: runId,
          decision_id: selection.decision.decision_id,
          outcome: "positive",
          context,
          candidates: ["bash", "edit", "test"],
          selected_tool: "edit",
          target: "tool",
          note: "Edit-based repair succeeded",
          input_text: "recover durable workflow from failed validation",
        }, "default", "default", {
          maxTextLen: 10_000,
          piiRedaction: false,
          embedder: DeterministicEmbeddingProvider,
          liteWriteStore,
        }),
      );
      anchorId = feedback.pattern_anchor?.node_id ?? anchorId;
    }
    assert.ok(anchorId);

    const negativeSelection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: randomUUID(),
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });
    await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: negativeSelection.decision.run_id,
        decision_id: negativeSelection.decision.decision_id,
        outcome: "negative",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair failed on rerun",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    const firstRevalidationRunId = randomUUID();
    const firstRevalidationSelection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: firstRevalidationRunId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });
    const firstRevalidation = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: firstRevalidationRunId,
        decision_id: firstRevalidationSelection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded after revalidation",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(firstRevalidation.pattern_anchor?.pattern_state, "provisional");
    assert.equal(firstRevalidation.pattern_anchor?.credibility_state, "contested");

    const secondRevalidationRunId = randomUUID();
    const secondRevalidationSelection = await selectTools({
      tenant_id: "default",
      scope: "default",
      run_id: secondRevalidationRunId,
      context,
      candidates: ["bash", "edit", "test"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      embedder: DeterministicEmbeddingProvider,
      recallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
    });
    const revalidated = await liteWriteStore.withTx(() =>
      toolSelectionFeedback(null, {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        run_id: secondRevalidationRunId,
        decision_id: secondRevalidationSelection.decision.decision_id,
        outcome: "positive",
        context,
        candidates: ["bash", "edit", "test"],
        selected_tool: "edit",
        target: "tool",
        note: "Edit-based repair succeeded after second fresh revalidation",
        input_text: "recover durable workflow from failed validation",
      }, "default", "default", {
        maxTextLen: 10_000,
        piiRedaction: false,
        embedder: DeterministicEmbeddingProvider,
        liteWriteStore,
      }),
    );

    assert.equal(revalidated.pattern_anchor?.pattern_state, "stable");
    assert.equal(revalidated.pattern_anchor?.credibility_state, "trusted");
    assert.equal(revalidated.pattern_anchor?.promotion.last_transition, "revalidated_to_trusted");

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: anchorId,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.anchor_v1.credibility_state, "trusted");
    assert.equal(rows[0]?.slots.anchor_v1.promotion.credibility_state, "trusted");
    assert.equal(rows[0]?.slots.anchor_v1.promotion.counter_evidence_open, false);
    assert.equal(rows[0]?.slots.anchor_v1.promotion.last_transition, "revalidated_to_trusted");
    assert.equal(rows[0]?.slots.anchor_v1.trust_hardening.post_contest_distinct_run_count, 2);
    assert.equal(rows[0]?.slots.anchor_v1.trust_hardening.revalidation_floor_satisfied, true);
    const revalidatedExecutionContract = parseExecutionContract(rows[0]?.slots.execution_contract_v1);
    assert.equal(revalidatedExecutionContract?.contract_trust, "advisory");
    assert.ok(revalidatedExecutionContract?.pattern_hints?.includes("stable_tool_selection_pattern"));
  } finally {
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
