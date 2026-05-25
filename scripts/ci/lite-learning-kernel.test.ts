import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createLearningKernel,
  LEARNING_LIFECYCLE_STATES,
  type LiteLearningKernelStore,
} from "../../src/kernel/learning-kernel.ts";
import {
  buildMaterializationContextFromFeedback,
  decideToolsFeedbackLearning,
  extractWorkflowFeedbackTarget,
} from "../../src/kernel/learning-decision-kernel.ts";
import {
  buildWorkflowPromotionLearningControlPreview,
  deriveWorkflowPromotionSemanticPolicyEffect,
} from "../../src/kernel/learning-promotion-kernel.ts";
import { MemoryAnchorV1Schema } from "../../src/memory/schemas.ts";

function buildStablePatternAnchor() {
  return MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:repair-export",
    task_class: "tools_select_pattern",
    task_family: "task:repair_export",
    error_family: "error:node-export-mismatch",
    pattern_signature: "stable-edit-pattern",
    summary: "Stable pattern: prefer edit for repair_export after repeated successful runs.",
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
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_trusted",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-05-18T00:00:00.000Z",
    },
    schema_version: "anchor_v1",
  });
}

function createPatternOnlyStore() {
  let txCount = 0;
  const node = {
    id: randomUUID(),
    type: "concept",
    title: "Stable edit pattern",
    text_summary: "Stable pattern: prefer edit for repair_export.",
    slots: {
      summary_kind: "pattern_anchor",
      compression_layer: "L3",
      anchor_v1: buildStablePatternAnchor(),
    },
    tier: null,
    salience: 0.8,
    importance: 0.9,
    confidence: 0.9,
    commit_id: null,
  };
  const store = {
    withTx: async <T>(fn: () => Promise<T>) => {
      txCount += 1;
      return await fn();
    },
    findNodes: async (query: { id?: string; type?: string }) => ({
      rows: (!query.id || query.id === node.id) && (!query.type || query.type === node.type) ? [node] : [],
      total: (!query.id || query.id === node.id) && (!query.type || query.type === node.type) ? 1 : 0,
    }),
    updateNodeAnchorState: async (input: {
      id: string;
      slots: Record<string, unknown>;
      textSummary: string;
      salience: number;
      importance: number;
      confidence: number;
      commitId: string | null;
    }) => {
      assert.equal(input.id, node.id);
      node.slots = input.slots as typeof node.slots;
      node.text_summary = input.textSummary;
      node.salience = input.salience;
      node.importance = input.importance;
      node.confidence = input.confidence;
      node.commit_id = input.commitId;
    },
  };
  return {
    node,
    store: store as unknown as LiteLearningKernelStore,
    txCount: () => txCount,
  };
}

test("learning kernel declares the narrow lifecycle vocabulary", () => {
  assert.deepEqual([...LEARNING_LIFECYCLE_STATES], [
    "observed",
    "provisional",
    "trusted",
    "contested",
    "retired",
    "archived",
  ]);
});

test("learning decision kernel blocks generic automatic feedback but admits concrete learning evidence", () => {
  const genericAutomatic = decideToolsFeedbackLearning({
    context: {
      telemetry_source: "host_post_tool_use",
    },
    outcome: "positive",
    sourceRuleIds: [],
  });
  assert.equal(genericAutomatic.automaticHostToolFeedback, true);
  assert.equal(genericAutomatic.shouldWritePatternAnchor, false);

  const targetedAutomatic = decideToolsFeedbackLearning({
    context: {
      telemetry_source: "host_post_tool_use",
      execution: {
        target_files: ["src/routes/export.ts"],
        workflow_steps: ["inspect export mismatch", "patch targeted file"],
      },
    },
    outcome: "positive",
    sourceRuleIds: [],
  });
  assert.equal(targetedAutomatic.shouldWritePatternAnchor, true);
  assert.deepEqual(targetedAutomatic.workflowFeedbackTarget.targetFiles, ["src/routes/export.ts"]);

  const ruleBackedAutomatic = decideToolsFeedbackLearning({
    context: {
      telemetry_source: "host_post_tool_use",
    },
    outcome: "negative",
    sourceRuleIds: ["rule-1"],
  });
  assert.equal(ruleBackedAutomatic.shouldWritePatternAnchor, true);

  const neutralManual = decideToolsFeedbackLearning({
    context: {
      goal: "manual note",
    },
    outcome: "neutral",
    sourceRuleIds: ["rule-1"],
  });
  assert.equal(neutralManual.shouldWritePatternAnchor, false);
});

test("learning decision kernel separates observational feedback from policy materialization", () => {
  const observational = decideToolsFeedbackLearning({
    context: {
      contract_trust: "observational",
      execution: {
        target_files: ["src/runtime.ts"],
      },
    },
    outcome: "positive",
    sourceRuleIds: [],
  });
  assert.equal(observational.contractTrustForMaterialization, "observational");
  assert.equal(observational.shouldMaterializePolicyMemory, false);

  const advisoryTarget = extractWorkflowFeedbackTarget({
    contract_trust: "advisory",
    execution: {
      task_family: "task:runtime-kernel",
      workflow_signature: "workflow:runtime-kernel",
      target_files: ["src/kernel/learning-decision-kernel.ts"],
      next_action: "keep feedback decisions in kernel",
      workflow_steps: ["extract decision", "run focused regression"],
      pattern_hints: ["automatic feedback needs concrete evidence"],
    },
  });
  const materializedContext = buildMaterializationContextFromFeedback({
    context: { contract_trust: "advisory" },
    workflowFeedbackTarget: advisoryTarget,
  });
  assert.equal(materializedContext.contract_trust, "advisory");
  assert.deepEqual(materializedContext.target_files, ["src/kernel/learning-decision-kernel.ts"]);
  assert.equal((materializedContext.execution_contract_v1 as Record<string, unknown>)?.contract_trust, "advisory");
});

test("learning promotion kernel only raises workflow promotion through authoritative review and evidence", () => {
  const review = {
    review_version: "promote_memory_semantic_review_v1",
    adjudication: {
      operation: "promote_memory",
      disposition: "recommend",
      target_kind: "workflow",
      target_level: "L2",
      reason: "stable workflow is reusable and validated",
      confidence: 0.92,
      strategic_value: "high",
    },
  } as const;
  const admissibility = {
    operation: "promote_memory",
    admissible: true,
    requires_manual_review: false,
    accepted_mutation_count: 1,
    reason_codes: [],
  } as const;
  const executionContract = {
    contract_trust: "authoritative",
    acceptance_checks: ["npm run -s test:focused"],
    success_invariants: ["all_acceptance_checks_pass"],
  };

  const allowed = deriveWorkflowPromotionSemanticPolicyEffect({
    basePromotionState: "candidate",
    contractTrust: "authoritative",
    executionContract,
    executionEvidenceAssessment: { allows_stable_promotion: true },
    review,
    admissibility,
  });
  assert.equal(allowed.applies, true);
  assert.equal(allowed.effective_promotion_state, "stable");
  assert.equal(allowed.reason_code, "high_confidence_workflow_promotion");

  const blockedByEvidence = deriveWorkflowPromotionSemanticPolicyEffect({
    basePromotionState: "candidate",
    contractTrust: "authoritative",
    executionContract,
    executionEvidenceAssessment: { allows_stable_promotion: false },
    review,
    admissibility,
  });
  assert.equal(blockedByEvidence.applies, false);
  assert.equal(blockedByEvidence.effective_promotion_state, "candidate");
  assert.equal(blockedByEvidence.reason_code, "execution_evidence_insufficient");

  const blockedByTrust = deriveWorkflowPromotionSemanticPolicyEffect({
    basePromotionState: "candidate",
    contractTrust: "advisory",
    executionContract,
    executionEvidenceAssessment: { allows_stable_promotion: true },
    review,
    admissibility,
  });
  assert.equal(blockedByTrust.applies, false);
  assert.equal(blockedByTrust.reason_code, "contract_trust_below_authoritative");
});

test("learning promotion kernel records runtime apply only after admitted stable workflow promotion", async () => {
  const candidateId = randomUUID();
  const preview = await buildWorkflowPromotionLearningControlPreview({
    candidateNodeIds: [candidateId],
    inputText: "promote validated workflow",
    inputSha256: "a".repeat(64),
    candidateExamples: [{
      node_id: candidateId,
      title: "Validated focused workflow",
      summary: "Run the focused suite after extracting a kernel slice.",
      task_signature: "task:focused-kernel",
      workflow_signature: "workflow:focused-kernel",
      outcome_status: "candidate",
      success_score: 0.9,
    }],
    contractTrust: "authoritative",
    executionContract: {
      contract_trust: "authoritative",
      acceptance_checks: ["npm run -s test:focused"],
      success_invariants: ["all_acceptance_checks_pass"],
    },
    executionEvidenceAssessment: {
      allows_stable_promotion: true,
      reasons: [],
    },
    reviewResult: {
      review_version: "promote_memory_semantic_review_v1",
      adjudication: {
        operation: "promote_memory",
        disposition: "recommend",
        target_kind: "workflow",
        target_level: "L2",
        reason: "stable workflow promotion is strategically valuable here",
        confidence: 0.92,
        strategic_value: "high",
      },
    },
  });

  assert.equal(preview.promote_memory.admissibility?.admissible, true);
  assert.equal(preview.promote_memory.policy_effect.applies, true);
  assert.equal(preview.runtime_apply.promotion_state_override, "stable");
  assert.equal(preview.runtime_apply.changed_promotion_state, true);
  assert.equal(preview.promote_memory.decision_trace.runtime_apply_changed_promotion_state, true);
  assert.ok(preview.promote_memory.decision_trace.stage_order.includes("runtime_policy_applied"));
});

test("learning kernel facade suppresses and unsuppresses a learned pattern without demoting trust", async () => {
  const { node, store, txCount } = createPatternOnlyStore();
  const kernel = createLearningKernel({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_SCOPE: "default",
      MEMORY_TENANT_ID: "default",
      LITE_LOCAL_ACTOR_ID: "local-user",
      MAX_TEXT_LEN: 10_000,
      PII_REDACTION: false,
    } as any,
    embedder: null,
    embeddedRuntime: null,
    liteRecallAccess: {} as any,
    liteWriteStore: store,
  });

  const suppressed = await kernel.suppressLearnedPattern({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    anchor_id: node.id,
    reason: "temporarily disable in this workspace",
  }) as Record<string, any>;

  assert.equal(suppressed.anchor_id, node.id);
  assert.equal(suppressed.selected_tool, "edit");
  assert.equal(suppressed.credibility_state, "trusted");
  assert.equal(suppressed.operator_override.suppressed, true);
  assert.equal((node.slots as any).anchor_v1.credibility_state, "trusted");
  assert.equal((node.slots as any).operator_override_v1.suppressed, true);

  const unsuppressed = await kernel.unsuppressLearnedPattern({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    anchor_id: node.id,
    reason: "operator review passed",
  }) as Record<string, any>;

  assert.equal(unsuppressed.anchor_id, node.id);
  assert.equal(unsuppressed.credibility_state, "trusted");
  assert.equal(unsuppressed.operator_override.suppressed, false);
  assert.equal((node.slots as any).anchor_v1.credibility_state, "trusted");
  assert.equal((node.slots as any).operator_override_v1.suppressed, false);
  assert.equal(txCount(), 2);
});
