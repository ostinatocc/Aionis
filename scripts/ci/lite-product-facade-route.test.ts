import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { buildAionisUri } from "../../src/memory/uri.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryFeedbackToolRoutes } from "../../src/routes/memory-feedback-tools.ts";
import { registerLiteMemoryLifecycleRoutes } from "../../src/routes/memory-lifecycle-lite.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerProductFacadeRoutes } from "../../src/routes/product-facade.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteSkillCandidateReviewStore } from "../../src/store/lite-skill-candidate-review-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-product-facade-"));
  return path.join(dir, `${name}.sqlite`);
}

function sortedKeys(value: unknown): string[] {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.keys(value as Record<string, unknown>).sort();
}

function assertExactKeys(value: unknown, expected: string[]) {
  assert.deepEqual(sortedKeys(value), [...expected].sort());
}

function assertNoForbiddenProductFields(value: unknown) {
  const forbidden = new Set([
    ["first", "action"].join("_"),
    ["first", "step"].join("_"),
    ["kick", "off"].join(""),
    ["runtime", "context", "packet"].join("_"),
    "learning_packet",
    "cost_signals",
    "raw_memory_rows",
    "raw_slots",
    "internal_route",
    "internal_route_schema",
  ]);
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      assert.equal(forbidden.has(key), false, `forbidden product field leaked: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function productFullPowerTreeOperation(
  tree: ExecutionTreeV1,
  operation: Record<string, unknown>,
): ExecutionTreeOperationV1 {
  return {
    tree_id: tree.tree_id,
    scope: tree.scope,
    ...operation,
  } as ExecutionTreeOperationV1;
}

function buildProductGuideFullPowerTree(runId: string): ExecutionTreeV1 {
  let tree = createExecutionTreeV1({
    tree_id: `tree-product-guide-full-power-${runId}`,
    scope: `aionis://execution-tree/product-guide-full-power/${runId}`,
    task_brief: "Product guide full-power context should merge active passed execution and failed branch counter-evidence.",
    at: "2026-06-09T00:00:00.000Z",
  });
  const add = (operation: Record<string, unknown>) => {
    tree = applyExecutionTreeOperationV1(tree, productFullPowerTreeOperation(tree, operation));
  };

  add({
    type: "grow",
    operation_id: `${runId}:failed-grow`,
    actor_role: "worker",
    at: "2026-06-09T00:01:00.000Z",
    action: "Try FULL_POWER_GUIDE_FAILED_BRANCH broad retry.",
    observation: "FULL_POWER_GUIDE_FAILED_BRANCH failed verifier checks.",
    title: "FULL_POWER_GUIDE_FAILED_BRANCH rejected branch",
  });
  add({
    type: "compress",
    operation_id: `${runId}:failed-compress`,
    actor_role: "worker",
    at: "2026-06-09T00:02:00.000Z",
    title: "FULL_POWER_GUIDE_FAILED_BRANCH rejected summary",
    summary: "FULL_POWER_GUIDE_FAILED_BRANCH is counter-evidence.",
  });
  const failedSummaryNodeId = tree.current_summary_node_id;
  assert.ok(failedSummaryNodeId);
  add({
    type: "maintain",
    operation_id: `${runId}:failed-maintain`,
    actor_role: "verifier",
    at: "2026-06-09T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "FULL_POWER_GUIDE_FAILED_BRANCH failed replay.",
  });
  add({
    type: "revise",
    operation_id: `${runId}:revise`,
    actor_role: "worker",
    at: "2026-06-09T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "Resume from safe boundary.",
  });
  add({
    type: "grow",
    operation_id: `${runId}:passed-grow`,
    actor_role: "worker",
    at: "2026-06-09T00:05:00.000Z",
    action: "Use FULL_POWER_GUIDE_PASSED_BRANCH scoped continuation.",
    observation: "FULL_POWER_GUIDE_PASSED_BRANCH passed verifier replay.",
    title: "FULL_POWER_GUIDE_PASSED_BRANCH accepted branch",
  });
  add({
    type: "compress",
    operation_id: `${runId}:passed-compress`,
    actor_role: "worker",
    at: "2026-06-09T00:06:00.000Z",
    title: "FULL_POWER_GUIDE_PASSED_BRANCH accepted summary",
    summary: "FULL_POWER_GUIDE_PASSED_BRANCH is the active continuation.",
  });
  const passedSummaryNodeId = tree.current_summary_node_id;
  assert.ok(passedSummaryNodeId);
  add({
    type: "maintain",
    operation_id: `${runId}:passed-maintain`,
    actor_role: "verifier",
    at: "2026-06-09T00:07:00.000Z",
    passed: true,
    target_summary_node_id: passedSummaryNodeId,
    diagnostic_note: null,
  });
  return tree;
}

function assertProductSourceMap(value: unknown, expectedKeys = ["internal_surfaces_used", "routes_used"]) {
  assertExactKeys(value, expectedKeys);
}

function objectValue(value: unknown, label: string): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, any>;
}

function arrayValue(value: unknown, label: string): Array<Record<string, any>> {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value as Array<Record<string, any>>;
}

function countTraceSurface(trace: Record<string, any>, surface: string): number {
  return arrayValue(trace.memory_decisions, "trace.memory_decisions")
    .filter((entry) => entry.agent_surface === surface).length;
}

function assertDecisionTraceMatchesGuide(traceRaw: unknown, guideRaw: unknown) {
  const trace = objectValue(traceRaw, "memory_decision_trace");
  const guide = objectValue(guideRaw, "guide");
  const memoryPacket = objectValue(guide.memory_packet, "guide.memory_packet");
  const agentContext = objectValue(guide.agent_context, "guide.agent_context");
  const memories = arrayValue(memoryPacket.relevant_memories, "memory_packet.relevant_memories");
  const evidenceTrail = arrayValue(memoryPacket.evidence_trail, "memory_packet.evidence_trail");
  const decisions = arrayValue(trace.memory_decisions, "trace.memory_decisions");
  const relationDecisions = arrayValue(trace.relation_decisions, "trace.relation_decisions");
  const summary = objectValue(trace.summary, "trace.summary");
  const contextDecision = objectValue(trace.context_decision, "trace.context_decision");
  const receipt = objectValue(trace.memory_use_receipt, "trace.memory_use_receipt");

  assert.equal(trace.contract_version, "aionis_memory_decision_trace_v1");
  assert.equal(trace.agent_prompt_included, false);
  assert.equal(trace.runtime_mutation, false);
  assert.equal(receipt.contract_version, "aionis_memory_use_receipt_v1");
  assert.equal(receipt.agent_prompt_included, false);
  assert.equal(receipt.runtime_mutation, false);
  assert.equal(summary.total_memory_count, memories.length);
  assert.equal(summary.direct_use_count, countTraceSurface(trace, "use_now"));
  assert.equal(summary.inspect_before_use_count, countTraceSurface(trace, "inspect_before_use"));
  assert.equal(summary.do_not_use_count, countTraceSurface(trace, "do_not_use"));
  assert.equal(summary.rehydrate_count, countTraceSurface(trace, "rehydrate"));
  assert.equal(summary.relation_count, relationDecisions.length);
  const feedbackAttribution = objectValue(trace.feedback_attribution, "trace.feedback_attribution");
  assert.equal(summary.feedback_attribution_count, arrayValue(feedbackAttribution.attributed_memory_ids, "feedback_attribution.attributed_memory_ids").length);
  assert.equal(summary.feedback_threshold_met_count, arrayValue(feedbackAttribution.threshold_met_memory_ids, "feedback_attribution.threshold_met_memory_ids").length);
  assert.equal(summary.unattributed_recalled_memory_count, arrayValue(feedbackAttribution.unattributed_recalled_memory_ids, "feedback_attribution.unattributed_recalled_memory_ids").length);
  assert.equal(summary.prompt_char_count, String(agentContext.prompt_text ?? "").length);
  assert.equal(summary.history_used, agentContext.history_used);
  assert.equal(summary.recommended_posture, agentContext.recommended_posture);
  assert.equal(summary.authority, agentContext.authority);
  assert.equal(summary.negative_transfer_risk, objectValue(agentContext.risk, "agent_context.risk").negative_transfer_risk);

  assert.equal(contextDecision.prompt_char_count, String(agentContext.prompt_text ?? "").length);
  assert.equal(contextDecision.use_now_count, arrayValue(agentContext.use_now, "agent_context.use_now").length);
  assert.equal(contextDecision.inspect_before_use_count, arrayValue(agentContext.inspect_before_use, "agent_context.inspect_before_use").length);
  assert.equal(contextDecision.do_not_use_count, arrayValue(agentContext.do_not_use, "agent_context.do_not_use").length);
  assert.equal(contextDecision.rehydrate_hint_count, arrayValue(agentContext.rehydrate_hints, "agent_context.rehydrate_hints").length);
  assert.deepEqual(contextDecision.memory_ids, agentContext.memory_ids);
  assert.equal(receipt.history_used, summary.history_used);
  assert.equal(receipt.actionable_history_used, summary.actionable_history_used);
  assert.equal(receipt.prompt_char_count, contextDecision.prompt_char_count);
  assert.deepEqual(
    receipt.use_now_memory_ids,
    decisions.filter((entry) => entry.agent_surface === "use_now").map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    receipt.inspect_before_use_memory_ids,
    decisions.filter((entry) => entry.agent_surface === "inspect_before_use").map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    receipt.do_not_use_memory_ids,
    decisions.filter((entry) => entry.agent_surface === "do_not_use").map((entry) => entry.memory_id),
  );
  assert.deepEqual(
    receipt.rehydrate_memory_ids,
    decisions.filter((entry) => entry.agent_surface === "rehydrate").map((entry) => entry.memory_id),
  );

  const promptText = String(agentContext.prompt_text ?? "");
  assert.equal(promptText.includes("memory_decision_trace"), false);
  assert.equal(promptText.includes("memory_decision_audit"), false);
  assert.equal(promptText.includes("decision_reviews"), false);

  const memoriesById = new Map(memories.map((entry) => [entry.memory_id, entry]));
  const relationByTarget = new Map(relationDecisions.map((entry) => [entry.target_memory_id, entry]));
  const lifecycleHintsById = new Map(arrayValue(objectValue(memoryPacket.lifecycle, "memory_packet.lifecycle").rehydration_hints, "memory_packet.lifecycle.rehydration_hints")
    .map((entry) => [entry.memory_id, entry]));
  for (const decision of decisions) {
    const memory = memoriesById.get(decision.memory_id);
    assert.ok(memory, `trace decision points at missing memory: ${decision.memory_id}`);
    assert.equal(decision.title, memory.title);
    assert.equal(decision.lifecycle_state, memory.lifecycle_state);
    assert.equal(decision.authority, memory.authority);
    if (decision.agent_surface === "use_now") {
      const used = objectValue(decision.used_detail, `used_detail:${decision.memory_id}`);
      assert.equal(used.confidence, memory.confidence);
      assert.equal(used.salience, memory.salience);
      assert.equal(used.source_layer, memory.source_layer);
      assert.equal(used.not_superseded, !relationByTarget.has(decision.memory_id));
    }
    if (decision.agent_surface === "inspect_before_use" && relationByTarget.has(decision.memory_id)) {
      const relation = relationByTarget.get(decision.memory_id)!;
      const downgraded = objectValue(decision.downgraded_detail, `downgraded_detail:${decision.memory_id}`);
      assert.equal(downgraded.by_memory_id, relation.source_memory_id);
      assert.equal(downgraded.evidence_id, relation.evidence_id);
      assert.deepEqual(objectValue(downgraded.relation, `downgraded_relation:${decision.memory_id}`).gate, relation.gate);
    }
    if (decision.agent_surface === "do_not_use") {
      const blocked = objectValue(decision.blocked_detail, `blocked_detail:${decision.memory_id}`);
      assert.equal(blocked.lifecycle_state, memory.lifecycle_state);
      assert.equal(blocked.authority, memory.authority);
    }
    if (decision.agent_surface === "rehydrate") {
      const rehydrate = objectValue(decision.rehydrate_detail, `rehydrate_detail:${decision.memory_id}`);
      const hint = lifecycleHintsById.get(decision.memory_id);
      if (hint) {
        assert.equal(rehydrate.mode, hint.mode);
        assert.equal(rehydrate.required, hint.required);
        assert.equal(rehydrate.reason, hint.reason);
      }
    }
  }

  const lifecycleEvidence = evidenceTrail.filter((entry) => entry.source === "edge" && entry.lifecycle_relation);
  assert.equal(relationDecisions.length, lifecycleEvidence.length);
  for (const evidence of lifecycleEvidence) {
    const relation = relationDecisions.find((entry) => entry.evidence_id === evidence.evidence_id);
    assert.ok(relation, `missing relation decision for evidence ${evidence.evidence_id}`);
    const lifecycleRelation = objectValue(evidence.lifecycle_relation, `lifecycle_relation:${evidence.evidence_id}`);
    assert.equal(relation.memory_id, evidence.memory_id);
    assert.equal(relation.source_memory_id, lifecycleRelation.source_memory_id);
    assert.equal(relation.target_memory_id, lifecycleRelation.target_memory_id);
    assert.equal(relation.lifecycle_relation, lifecycleRelation.lifecycle_relation);
    assert.equal(relation.confidence, lifecycleRelation.confidence);
    assert.deepEqual(relation.gate, lifecycleRelation.gate);
    assert.deepEqual(relation.signals, lifecycleRelation.signals);
  }
}

function assertTraceCoreEqual(leftRaw: unknown, rightRaw: unknown) {
  const left = objectValue(leftRaw, "left trace");
  const right = objectValue(rightRaw, "right trace");
  for (const key of [
    "tenant_id",
    "scope",
    "input",
    "summary",
    "memory_decisions",
    "relation_decisions",
    "feedback_attribution",
    "context_decision",
    "memory_use_receipt",
    "forget_decisions",
  ]) {
    assert.deepEqual(left[key], right[key], `trace core mismatch: ${key}`);
  }
}

function assertAuditReportMatchesTrace(auditRaw: unknown, traceRaw: unknown) {
  const audit = objectValue(auditRaw, "memory_decision_audit");
  const trace = objectValue(traceRaw, "memory_decision_trace");
  const decisions = arrayValue(trace.memory_decisions, "trace.memory_decisions");
  const reviews = objectValue(audit.decision_reviews, "audit.decision_reviews");
  const feedbackReview = objectValue(audit.feedback_signal_review, "audit.feedback_signal_review");
  const feedbackAttribution = objectValue(trace.feedback_attribution, "trace.feedback_attribution");
  const sparseSummary = objectValue(feedbackAttribution.sparse_feedback_signal_summary, "trace.feedback_attribution.sparse_feedback_signal_summary");
  const used = decisions.filter((entry) => entry.decision_kind === "used" && entry.used_detail);
  const downgraded = decisions.filter((entry) => entry.decision_kind === "downgraded" && entry.downgraded_detail);
  const blocked = decisions.filter((entry) => entry.decision_kind === "blocked" && entry.blocked_detail);
  const rehydrate = decisions.filter((entry) => entry.decision_kind === "rehydrate" && entry.rehydrate_detail);

  assert.equal(audit.contract_version, "aionis_memory_decision_audit_report_v1");
  assert.equal(audit.agent_prompt_included, false);
  assert.equal(audit.runtime_mutation, false);
  const counters = objectValue(audit.counters, "audit.counters");
  const summary = objectValue(trace.summary, "trace.summary");
  assert.equal(counters.total_memory_count, summary.total_memory_count);
  assert.equal(counters.feedback_attribution_count, summary.feedback_attribution_count);
  assert.equal(counters.feedback_threshold_met_count, summary.feedback_threshold_met_count);
  assert.deepEqual(arrayValue(reviews.used_memories, "reviews.used_memories").map((entry) => entry.memory_id), used.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.downgraded_memories, "reviews.downgraded_memories").map((entry) => entry.memory_id), downgraded.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.blocked_memories, "reviews.blocked_memories").map((entry) => entry.memory_id), blocked.map((entry) => entry.memory_id));
  assert.deepEqual(arrayValue(reviews.rehydrate_memories, "reviews.rehydrate_memories").map((entry) => entry.memory_id), rehydrate.map((entry) => entry.memory_id));
  assert.equal(feedbackReview.present, sparseSummary.present);
  assert.equal(feedbackReview.mode, sparseSummary.mode);
  assert.equal(feedbackReview.authority_mutation, false);
  assert.deepEqual(
    arrayValue(feedbackReview.positive_attributed_memories, "feedback_signal_review.positive_attributed_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.positive_attributed_memory_ids, "sparse_feedback_signal_summary.positive_attributed_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.weak_counter_signal_memories, "feedback_signal_review.weak_counter_signal_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.weak_counter_signal_memory_ids, "sparse_feedback_signal_summary.weak_counter_signal_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.strong_counter_signal_memories, "feedback_signal_review.strong_counter_signal_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.strong_counter_signal_memory_ids, "sparse_feedback_signal_summary.strong_counter_signal_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.relation_counter_signal_memories, "feedback_signal_review.relation_counter_signal_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.relation_counter_signal_memory_ids, "sparse_feedback_signal_summary.relation_counter_signal_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.contradiction_warning_memories, "feedback_signal_review.contradiction_warning_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.contradiction_warning_memory_ids, "sparse_feedback_signal_summary.contradiction_warning_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.repeated_unattributed_memories, "feedback_signal_review.repeated_unattributed_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.repeated_unattributed_memory_ids, "sparse_feedback_signal_summary.repeated_unattributed_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.repeated_unattributed_without_positive_memories, "feedback_signal_review.repeated_unattributed_without_positive_memories").map((entry) => entry.memory_id),
    arrayValue(sparseSummary.repeated_unattributed_without_positive_memory_ids, "sparse_feedback_signal_summary.repeated_unattributed_without_positive_memory_ids"),
  );
  assert.deepEqual(
    arrayValue(feedbackReview.read_only_signal_memory_ids, "feedback_signal_review.read_only_signal_memory_ids"),
    arrayValue(sparseSummary.read_only_signal_memory_ids, "sparse_feedback_signal_summary.read_only_signal_memory_ids"),
  );
}

function liteEnv() {
  return {
    AIONIS_EDITION: "lite",
    MEMORY_AUTH_MODE: "off",
    TENANT_QUOTA_ENABLED: false,
    LITE_LOCAL_ACTOR_ID: "local-user",
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    APP_ENV: "test",
    ADMIN_TOKEN: "",
    TRUST_PROXY: false,
    TRUSTED_PROXY_CIDRS: [],
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_BYPASS_LOOPBACK: false,
    WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
    RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    MAX_TEXT_LEN: 10_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
  } as any;
}

function requestGuards(env: ReturnType<typeof liteEnv>, embedder: typeof DeterministicEmbeddingProvider | null = null) {
  return createRequestGuards({
    env,
    embedder,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

function registerProductFacade(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore?: ReturnType<typeof createLiteWriteStore>;
  skillCandidateReviewAccess?: ReturnType<ReturnType<typeof createLiteSkillCandidateReviewStore>["createSkillCandidateReviewAccess"]>;
}) {
  registerProductFacadeRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore ?? ({} as ReturnType<typeof createLiteWriteStore>),
    skillCandidateReviewAccess: args.skillCandidateReviewAccess,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
}

async function seedProductFacadeMemory(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  input_text: string;
  nodes: Record<string, unknown>[];
}) {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: args.input_text,
    nodes: args.nodes,
    edges: [],
  }, "default", "default", {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
  }, null);

  await args.liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
    maxTextLen: 10000,
    piiRedaction: false,
    allowCrossScopeEdges: false,
    write_access: args.liteWriteStore,
  }));
}

async function seedProductPatternAnchor(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const anchorId = randomUUID();
  await seedProductFacadeMemory({
    liteWriteStore,
    input_text: "seed product facade pattern anchor",
    nodes: [{
      id: anchorId,
      type: "concept",
      tier: "hot",
      memory_lane: "private",
      owner_agent_id: "local-user",
      title: "Product facade suppression pattern",
      text_summary: "Prefer read before edit when a trusted scoped workflow exists.",
      slots: {
        anchor_v1: {
          schema_version: "anchor_v1",
          anchor_kind: "pattern",
          anchor_level: "L3",
          selected_tool: "read",
          task_signature: "product-facade-pattern-suppression",
          task_family: "product_facade",
          summary: "Prefer read before edit when a trusted scoped workflow exists.",
          tool_set: ["read", "edit", "test"],
          pattern_state: "stable",
          credibility_state: "trusted",
          promotion: {
            credibility_state: "trusted",
            distinct_run_count: 3,
            required_distinct_runs: 2,
            counter_evidence_count: 0,
          },
        },
      },
    }],
  });
  return { anchorId };
}

async function seedProductPayloadAnchor(liteWriteStore: ReturnType<typeof createLiteWriteStore>) {
  const payloadNodeId = randomUUID();
  const anchorNodeId = randomUUID();
  const decisionId = randomUUID();
  const runId = "run-product-payload-rehydrate";
  await seedProductFacadeMemory({
    liteWriteStore,
    input_text: "seed product facade payload anchor",
    nodes: [
      {
        id: payloadNodeId,
        type: "procedure",
        tier: "warm",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Payload workflow step",
        text_summary: "Read the prior verified state, apply the scoped edit, and verify the result.",
        slots: {
          replay_kind: "step",
          status: "succeeded",
          tool_name: "edit",
        },
      },
      {
        id: anchorNodeId,
        type: "procedure",
        tier: "warm",
        memory_lane: "private",
        owner_agent_id: "local-user",
        title: "Payload rehydration anchor",
        text_summary: "Anchor for a resumable workflow payload.",
        slots: {
          anchor_v1: {
            schema_version: "anchor_v1",
            anchor_kind: "workflow",
            anchor_level: "L2",
            task_signature: "product-payload-rehydrate",
            summary: "Read the prior verified state, apply the scoped edit, and verify the result.",
            tool_set: ["read", "edit", "test"],
            outcome: { status: "success" },
            source: {
              source_kind: "playbook",
              node_id: payloadNodeId,
              decision_id: decisionId,
              run_id: runId,
              step_id: null,
              playbook_id: "product_payload_anchor",
              commit_id: null,
            },
            payload_refs: {
              node_ids: [payloadNodeId],
              decision_ids: [decisionId],
              run_ids: [runId],
              step_ids: [],
              commit_ids: [],
            },
          },
        },
      },
    ],
  });
  await liteWriteStore.insertExecutionDecision({
    id: decisionId,
    scope: "default",
    decisionKind: "tools_select",
    runId,
    selectedTool: "edit",
    candidatesJson: ["read", "edit", "test"],
    contextSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    sourceRuleIds: [],
    metadataJson: { product_facade_fixture: true },
    commitId: null,
  });
  return { anchorNodeId, payloadNodeId, decisionId };
}

function registerFullProductMemoryApp(args: {
  app: ReturnType<typeof Fastify>;
  env: ReturnType<typeof liteEnv>;
  guards: ReturnType<typeof requestGuards>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  embedder?: typeof DeterministicEmbeddingProvider | null;
}) {
  const routeEmbedder = args.embedder === undefined ? DeterministicEmbeddingProvider : args.embedder;
  registerRuntimeErrorHandler(args.app);
  registerMemoryWriteRoutes({
    app: args.app,
    env: args.env,
    embedder: routeEmbedder,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
  });
  registerHandoffRoutes({
    app: args.app,
    env: args.env,
    embedder: routeEmbedder,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    executionStateStore: null,
  });
  registerMemoryAccessRoutes({
    app: args.app,
    env: args.env,
    embedder: routeEmbedder,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    executionStateStore: null,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerMemoryContextRuntimeRoutes({
    app: args.app,
    env: args.env,
    embedder: routeEmbedder,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    recallTextEmbedBatcher: { stats: () => null },
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: args.guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: args.guards.buildRecallAuth,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
    hasExplicitRecallKnobs: () => false,
    resolveRecallProfile: () => ({ profile: "balanced", source: "test" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "test_default",
      source: "test",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "test_default",
      source: "test",
      workload_class: null,
      signals: [],
    }),
    withRecallProfileDefaults: (body) => ({ ...(body as Record<string, unknown>) }),
    resolveRecallStrategy: () => ({ strategy: "local", defaults: {}, applied: false }),
    resolveAdaptiveRecallProfile: (profile) => ({ profile, defaults: {}, applied: false, reason: "test_default" }),
    resolveAdaptiveRecallHardCap: () => ({ defaults: {}, applied: false, reason: "test_default" }),
    inferRecallStrategyFromKnobs: () => "local",
    buildRecallTrajectory: () => ({ strategy: "local" }),
    embedRecallTextQuery: async (provider, queryText) => {
      const [vec] = await provider.embed([queryText]);
      return {
        vec,
        ms: 0,
        cache_hit: false,
        singleflight_join: false,
        queue_wait_ms: 0,
        batch_size: 1,
      };
    },
    mapRecallTextEmbeddingError: () => ({
      statusCode: 500,
      code: "embed_failed",
      message: "embedding failed",
    }),
    recordContextAssemblyTelemetryBestEffort: async () => {},
  });
  registerLiteMemoryLifecycleRoutes({
    app: args.app,
    env: args.env,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerMemoryFeedbackToolRoutes({
    app: args.app,
    env: args.env,
    embedder: routeEmbedder,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: args.guards.requireMemoryPrincipal,
    withIdentityFromRequest: args.guards.withIdentityFromRequest as any,
    enforceRateLimit: args.guards.enforceRateLimit,
    enforceTenantQuota: args.guards.enforceTenantQuota,
    tenantFromBody: args.guards.tenantFromBody,
    acquireInflightSlot: args.guards.acquireInflightSlot,
  });
  registerProductFacade(args);
}

test("product memory admission route governs external backend candidates without writing Runtime memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("memory-admission-gateway");
  const liteWriteStore = createLiteWriteStore(dbPath);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({ app, env, guards, liteWriteStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/govern",
      payload: {
        tenant_id: "default",
        scope: "default",
        run_id: "run-admission",
        query_text: "Continue checkout migration without reusing failed branches.",
        include_records: true,
        candidates: [
          {
            external_memory_id: "mem0:current",
            source_backend: "mem0",
            text: "The current accepted target is packages/api/src/checkout.ts.",
            metadata: {
              title: "Current checkout target",
              target_files: ["packages/api/src/checkout.ts"],
            },
            authority: {
              source_trust: "trusted",
              scope: "project",
              evidence_requirement: "none",
            },
            lifecycle_hint: "current",
            evidence_refs: ["mem0:trace:1"],
          },
          {
            external_memory_id: "zep:failed",
            source_backend: "zep",
            text: "The old fullBundleEnvironment.ts route failed verification and should stay counter-evidence.",
            authority: {
              source_trust: "trusted",
              scope: "project",
              evidence_requirement: "none",
            },
            lifecycle_hint: "failed",
            evidence_refs: ["ci:failed"],
          },
          {
            external_memory_id: "vector:raw",
            source_backend: "vector_db",
            text: "Exact raw patch evidence is behind this vector result and must be expanded.",
            authority: {
              source_trust: "known",
              scope: "project",
              evidence_requirement: "rehydrate_before_use",
            },
            lifecycle_hint: "procedure",
          },
          {
            external_memory_id: "markdown:blocked",
            source_backend: "markdown",
            text: "Suppressed note should not direct the Agent.",
            lifecycle_hint: "suppressed",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.contract_version, "aionis_memory_admission_gateway_result_v1");
    assert.equal(body.agent_context.contract_version, "aionis_agent_context_v1");
    assert.deepEqual(body.agent_context.use_now_memory_ids, ["mem0:current"]);
    assert.deepEqual(body.agent_context.inspect_before_use_memory_ids, ["zep:failed"]);
    assert.deepEqual(body.agent_context.do_not_use_memory_ids, ["markdown:blocked"]);
    assert.deepEqual(body.agent_context.rehydrate_hints.map((entry: Record<string, unknown>) => entry.memory_id), ["vector:raw"]);
    assert.equal(body.memory_admission_records.source, "external_candidate_admission");
    assert.equal(body.memory_admission_records.runtime_mutation, false);
    assert.equal(body.memory_admission_records.entries.every((entry: Record<string, unknown>) => entry.memory_origin === "external"), true);
    assert.equal(body.memory_admission_records.entries.find((entry: Record<string, unknown>) => entry.memory_id === "zep:failed")?.admission_action, "inspect_before_use");
    assert.equal(body.memory_admission_records.entries.find((entry: Record<string, unknown>) => entry.memory_id === "markdown:blocked")?.admission_action, "do_not_use");
    assert.equal(body.memory_use_receipt.use_now_memory_ids.includes("zep:failed"), false);
    assert.equal(body.memory_firewall, undefined);
    assert.equal(String(body.agent_context.prompt_text).includes("memory_admission_record"), false);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/govern"]);
    assert.equal(body.source_map.internal_surfaces_used.includes("external_candidate_admission"), true);
    assert.equal(body.source_map.internal_surfaces_used.includes("memory_write"), false);
    assert.equal(body.source_map.omitted_internal_surfaces.includes("memory_write"), true);

    const nodes = await liteWriteStore.findNodes({ scope: "default", limit: 10, offset: 0 });
    assert.equal(nodes.rows.length, 0);
  } finally {
    await app.close();
  }
});

test("product guide returns an empty agent context when semantic planning recall has no embedding provider", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, null);
  const dbPath = tmpDbPath("product-guide-no-embedding-provider");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({
      app,
      env,
      guards,
      liteWriteStore,
      liteRecallStore,
      embedder: null,
    });

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Continue the fresh install no-key Runtime smoke.",
        agent_role: "worker",
        consumer_agent_id: "fresh-install-worker",
        run_id: "run-fresh-install-no-embedding",
        context: {
          task_signature: "fresh-install-mcp-context",
          task_family: "fresh_install_ci",
        },
        mode: "full_power",
        context_mode: "compact_agent",
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200, guide.body);
    const body = guide.json();
    assert.equal(body.agent_context.contract_version, "aionis_agent_context_v1");
    assert.equal(body.agent_context.history_used, false);
    assert.equal(body.agent_context.recommended_posture, "ignore_history");
    assert.equal(body.memory_packet, null);
    assert.equal(body.guide_packet, null);
    assert.equal(
      body.source_map.internal_surfaces_used.includes("planning_context_embedding_unavailable"),
      true,
    );
    assert.equal(
      body.source_map.omitted_internal_surfaces.includes("semantic_planning_recall"),
      true,
    );
  } finally {
    await liteWriteStore.close();
    await liteRecallStore.close();
    await app.close();
  }
});

test("product guide can opt into admission candidate policy shadow projection without changing agent context", async () => {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "shadow",
  };
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("admission-candidate-policy-shadow");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        auto_embed: true,
        nodes: [
          {
            client_id: "admission-shadow-project",
            type: "topic",
            title: "ADMISSION_SHADOW_POLICY_ROUTE project context",
            text_summary: "ADMISSION_SHADOW_POLICY_ROUTE accepted target is src/current-route.ts.",
            tier: "warm",
            slots: {
              positive_attributed_use_count: 1,
            },
            confidence: 0.95,
            salience: 0.95,
          },
          {
            client_id: "admission-shadow-fact",
            type: "concept",
            title: "ADMISSION_SHADOW_POLICY_ROUTE fact candidate",
            text_summary: "ADMISSION_SHADOW_POLICY_ROUTE related fact should remain recorded as use_now in shadow mode.",
            tier: "warm",
            confidence: 0.94,
            salience: 0.94,
          },
        ],
      },
    });
    assert.equal(observe.statusCode, 200);
    const writtenNodes = observe.json().memory_write.nodes;
    const projectMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-shadow-project"
    )?.id;
    const factMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-shadow-fact"
    )?.id;
    assert.equal(typeof projectMemoryId, "string");
    assert.equal(typeof factMemoryId, "string");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Continue ADMISSION_SHADOW_POLICY_ROUTE using current route context.",
        consumer_agent_id: "local-user",
        limit: 8,
      },
    });

    assert.equal(guide.statusCode, 200);
    const body = guide.json();
    assert.equal(
      body.source_map.internal_surfaces_used.includes("admission_candidate_policy_shadow_projection"),
      true,
    );
    assert.equal(
      body.source_map.internal_surfaces_used.includes("admission_candidate_policy_active_projection"),
      false,
    );
    assert.equal(body.admission_candidate_policy_projection.mode, "shadow");
    assert.equal(body.admission_candidate_policy_projection.agent_prompt_included, false);
    assert.equal(body.admission_candidate_policy_projection.runtime_mutation, false);
    assert.equal(body.admission_candidate_policy_projection.shadow_policy_report.mode, "shadow_only");
    assert.equal(
      body.admission_candidate_policy_projection.shadow_policy_report.hard_boundary_upgrade_count,
      0,
    );
    assert.equal(
      body.agent_context.use_now_memory_ids.includes(projectMemoryId),
      true,
    );
    assert.equal(
      body.agent_context.use_now_memory_ids.includes(factMemoryId),
      true,
    );
    assert.equal(
      body.agent_context.inspect_before_use_memory_ids.includes(factMemoryId),
      false,
    );
    assert.equal(
      body.admission_candidate_policy_projection.downgraded_memory_ids.includes(factMemoryId),
      true,
    );
  } finally {
    await liteWriteStore.close();
    await liteRecallStore.close();
    await app.close();
  }
});

test("product guide can opt into admission candidate policy active projection", async () => {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "active",
  };
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("admission-candidate-policy-active");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        auto_embed: true,
        nodes: [
          {
            client_id: "admission-active-project",
            type: "topic",
            title: "ADMISSION_ACTIVE_POLICY_ROUTE project context",
            text_summary: "ADMISSION_ACTIVE_POLICY_ROUTE accepted target is src/current-route.ts.",
            tier: "warm",
            slots: {
              positive_attributed_use_count: 1,
            },
            confidence: 0.95,
            salience: 0.95,
          },
          {
            client_id: "admission-active-fact",
            type: "concept",
            title: "ADMISSION_ACTIVE_POLICY_ROUTE fact candidate",
            text_summary: "ADMISSION_ACTIVE_POLICY_ROUTE related fact should be inspected before direct execution by the candidate policy.",
            tier: "warm",
            confidence: 0.94,
            salience: 0.94,
          },
        ],
      },
    });
    assert.equal(observe.statusCode, 200);
    const writtenNodes = observe.json().memory_write.nodes;
    const projectMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-active-project"
    )?.id;
    const factMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-active-fact"
    )?.id;
    assert.equal(typeof projectMemoryId, "string");
    assert.equal(typeof factMemoryId, "string");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Continue ADMISSION_ACTIVE_POLICY_ROUTE using current route context.",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const body = guide.json();
    assert.equal(
      body.source_map.internal_surfaces_used.includes("admission_candidate_policy_active_projection"),
      true,
    );
    assert.equal(
      body.agent_context.use_now_memory_ids.includes(projectMemoryId),
      true,
    );
    assert.equal(
      body.agent_context.use_now_memory_ids.includes(factMemoryId),
      false,
    );
    assert.equal(
      body.agent_context.inspect_before_use_memory_ids.includes(factMemoryId),
      true,
    );
    assert.equal(
      body.agent_context.risk.reasons.includes("admission_candidate_policy_active_projection"),
      true,
    );
  } finally {
    await liteWriteStore.close();
    await liteRecallStore.close();
    await app.close();
  }
});

test("product guide can scope admission candidate policy active projection to a guide profile", async () => {
  const app = Fastify();
  const env = {
    ...liteEnv(),
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: JSON.stringify([
      {
        profile_id: "validated-worker-continuation",
        mode: "active",
        task_families: ["validated_worker_continuation"],
        agent_roles: ["worker"],
        context_modes: ["compact_agent"],
      },
    ]),
  };
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("admission-candidate-policy-profile-active");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        auto_embed: true,
        nodes: [
          {
            client_id: "admission-profile-project",
            type: "topic",
            title: "ADMISSION_PROFILE_POLICY_ROUTE project context",
            text_summary: "ADMISSION_PROFILE_POLICY_ROUTE accepted target is src/current-route.ts.",
            tier: "warm",
            slots: {
              positive_attributed_use_count: 1,
            },
            confidence: 0.95,
            salience: 0.95,
          },
          {
            client_id: "admission-profile-fact",
            type: "concept",
            title: "ADMISSION_PROFILE_POLICY_ROUTE fact candidate",
            text_summary: "ADMISSION_PROFILE_POLICY_ROUTE related fact should be inspected before direct execution by the candidate policy.",
            tier: "warm",
            confidence: 0.94,
            salience: 0.94,
          },
        ],
      },
    });
    assert.equal(observe.statusCode, 200);
    const writtenNodes = observe.json().memory_write.nodes;
    const projectMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-profile-project"
    )?.id;
    const factMemoryId = writtenNodes.find((entry: Record<string, unknown>) =>
      entry.client_id === "admission-profile-fact"
    )?.id;
    assert.equal(typeof projectMemoryId, "string");
    assert.equal(typeof factMemoryId, "string");

    const nonMatchingGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Continue ADMISSION_PROFILE_POLICY_ROUTE using current route context.",
        agent_role: "worker",
        consumer_agent_id: "local-user",
        context_mode: "compact_agent",
        context: {
          task_family: "unvalidated_worker_continuation",
        },
        limit: 8,
      },
    });
    assert.equal(nonMatchingGuide.statusCode, 200);
    const nonMatchingBody = nonMatchingGuide.json();
    assert.equal(
      nonMatchingBody.source_map.internal_surfaces_used.includes("admission_candidate_policy_active_projection"),
      false,
    );
    assert.equal(nonMatchingBody.source_map.admission_candidate_policy.mode, "off");
    assert.equal(nonMatchingBody.source_map.admission_candidate_policy.source, "off");
    assert.equal(nonMatchingBody.agent_context.use_now_memory_ids.includes(factMemoryId), true);

    const matchingGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Continue ADMISSION_PROFILE_POLICY_ROUTE using current route context.",
        agent_role: "worker",
        consumer_agent_id: "local-user",
        context_mode: "compact_agent",
        context: {
          task_family: "validated_worker_continuation",
        },
        limit: 8,
      },
    });

    assert.equal(matchingGuide.statusCode, 200);
    const matchingBody = matchingGuide.json();
    assert.equal(matchingBody.source_map.admission_candidate_policy.mode, "active");
    assert.equal(matchingBody.source_map.admission_candidate_policy.source, "profile_rule");
    assert.equal(matchingBody.source_map.admission_candidate_policy.profile_id, "validated-worker-continuation");
    assert.equal(
      matchingBody.source_map.internal_surfaces_used.includes("admission_candidate_policy_active_projection"),
      true,
    );
    assert.equal(
      matchingBody.source_map.internal_surfaces_used.includes("admission_candidate_policy_profile_active_projection"),
      true,
    );
    assert.equal(matchingBody.agent_context.use_now_memory_ids.includes(projectMemoryId), true);
    assert.equal(matchingBody.agent_context.use_now_memory_ids.includes(factMemoryId), false);
    assert.equal(matchingBody.agent_context.inspect_before_use_memory_ids.includes(factMemoryId), true);
  } finally {
    await liteWriteStore.close();
    await liteRecallStore.close();
    await app.close();
  }
});

test("product memory admission route exposes Memory Firewall summary in firewall mode", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("memory-firewall-gateway");
  const liteWriteStore = createLiteWriteStore(dbPath);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({ app, env, guards, liteWriteStore });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/govern",
      payload: {
        tenant_id: "default",
        scope: "default",
        run_id: "run-firewall",
        query_text: "Continue current work without stale or failed external memory.",
        mode: "firewall",
        include_records: true,
        candidates: [
          {
            external_memory_id: "mem0:current",
            source_backend: "mem0",
            text: "Current accepted target is packages/api/src/checkout.ts.",
            metadata: {
              title: "Current checkout target",
              target_files: ["packages/api/src/checkout.ts"],
            },
            authority: {
              source_trust: "trusted",
              scope: "project",
              evidence_requirement: "none",
            },
            lifecycle_hint: "current",
          },
          {
            external_memory_id: "zep:failed",
            source_backend: "zep",
            text: "Failed branch: the legacy route failed verification.",
            authority: {
              source_trust: "trusted",
              scope: "project",
              evidence_requirement: "none",
            },
            lifecycle_hint: "failed",
          },
          {
            external_memory_id: "vector:raw",
            source_backend: "vector_db",
            text: "Raw evidence pointer must be opened before exact use.",
            authority: {
              source_trust: "trusted",
              scope: "project",
              evidence_requirement: "rehydrate_before_use",
            },
            lifecycle_hint: "procedure",
          },
          {
            external_memory_id: "markdown:unknown",
            source_backend: "markdown",
            text: "Unknown project note claims a route but has no authority.",
            authority: {
              source_trust: "unknown",
              scope: "project",
              evidence_requirement: "none",
            },
            lifecycle_hint: "current",
          },
        ],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.mode, "firewall");
    assert.equal(body.memory_firewall.contract_version, "aionis_memory_firewall_summary_v1");
    assert.equal(body.memory_firewall.direct_use_count, 1);
    assert.equal(body.memory_firewall.blocked_count, 1);
    assert.equal(body.memory_firewall.inspect_count, 1);
    assert.equal(body.memory_firewall.rehydrate_count, 1);
    assert.equal(body.memory_firewall.unsafe_direct_use_count, 0);
    assert.equal(body.memory_firewall.runtime_mutation, false);
    assert.equal(body.memory_firewall.claims.some((claim: Record<string, unknown>) => claim.status === "fail"), false);
    assert.deepEqual(body.agent_context.use_now_memory_ids, ["mem0:current"]);
    assert.deepEqual(body.agent_context.do_not_use_memory_ids, ["zep:failed"]);
    assert.deepEqual(body.agent_context.inspect_before_use_memory_ids, ["markdown:unknown"]);
    assert.deepEqual(body.memory_use_receipt.rehydrate_memory_ids, ["vector:raw"]);

    const nodes = await liteWriteStore.findNodes({ scope: "default", limit: 10, offset: 0 });
    assert.equal(nodes.rows.length, 0);
  } finally {
    await app.close();
  }
});

test("product measure facade returns a product effect report without external eval runners", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({ app, env, guards });

    const response = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        task: {
          run_id: "run:measure-facade-contract",
          task_signature: "measure-facade-contract",
          task_family: "measure_facade",
          workflow_signature: "planner-worker-verifier-reviewer",
        },
        baseline: {
          continuity: {
            repeatedDiscoverySteps: 4,
            continuityGuidanceCorrect: false,
            recoveredStateFacts: 1,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: false,
            provisionalMemoriesWritten: 1,
          },
          forgetting: {
            contextItems: 8,
            usefulContextItems: 2,
            staleMemorySurfaced: 3,
          },
          learning_control: {
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        aionis: {
          continuity: {
            repeatedDiscoverySteps: 1,
            continuityGuidanceCorrect: true,
            recoveredStateFacts: 4,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: true,
            stableWorkflowReused: true,
            trustedPromotions: 1,
            weakEvidencePromoted: 0,
          },
          forgetting: {
            contextItems: 5,
            usefulContextItems: 4,
            staleMemorySurfaced: 0,
            staleMemorySuppressed: 3,
            archivedMemoryRehydratedOnDemand: 1,
          },
          learning_control: {
            weakEvidenceBlocked: 2,
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        comparison: {
          mode: "baseline_vs_aionis",
          sufficient_evidence: true,
        },
        evidence_ids: ["effect-run:facade-contract"],
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assertNoForbiddenProductFields(body);
    assertExactKeys(body, [
      "contract_version",
      "tenant_id",
      "scope",
      "measurement_input",
      "effect_report",
      "kernel_report",
      "source_map",
    ]);
    assertExactKeys(body.measurement_input, ["source", "baseline", "aionis"]);
    assertProductSourceMap(body.source_map);
    assertExactKeys(body.effect_report, [
      "contract_version",
      "tenant_id",
      "scope",
      "task",
      "comparison",
      "history_impact",
      "efficiency",
      "quality",
      "history_contributions",
      "learning_effect",
      "forgetting_effect",
      "feedback_signal_summary",
      "neighborhood_drift_summary",
      "confidence_decay_summary",
      "training_candidates",
      "evidence",
    ]);
    assert.equal(body.contract_version, "aionis_measure_result_v1");
    assert.equal(body.effect_report.contract_version, "aionis_effect_report_v1");
    assert.equal(body.effect_report.task.workflow_signature, undefined);
    assert.equal(body.effect_report.confidence_decay_summary.authority_mutation, false);
    assert.equal(body.effect_report.confidence_decay_summary.time_decay_age_threshold_days, 0);
    assert.equal(body.effect_report.history_impact.impact_direction, "positive");
    assert.equal(body.effect_report.history_impact.changed_future_behavior, true);
    assert.equal(body.effect_report.quality.negative_transfer_detected, false);
    assert.equal(body.effect_report.feedback_signal_summary.present, false);
    assert.equal(body.effect_report.feedback_signal_summary.source, "not_supplied");
    assert.equal(body.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.equal(body.effect_report.neighborhood_drift_summary.present, false);
    assert.equal(body.effect_report.neighborhood_drift_summary.source, "not_supplied");
    assert.equal(body.effect_report.neighborhood_drift_summary.authority_mutation, false);
    assert.deepEqual(body.source_map.routes_used, ["/v1/measure"]);
  } finally {
    await app.close();
  }
});

test("product skills candidates routes queue and review trace-derived skill candidates", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env);
  const reviewStore = createLiteSkillCandidateReviewStore(tmpDbPath("skill-candidates"));
  try {
    registerRuntimeErrorHandler(app);
    registerProductFacade({
      app,
      env,
      guards,
      skillCandidateReviewAccess: reviewStore.createSkillCandidateReviewAccess(),
    });

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        task: {
          run_id: "run:skill-candidate-route",
          task_signature: "skill-candidate-route",
          task_family: "runtime_learning",
        },
        baseline: {
          continuity: {
            repeatedDiscoverySteps: 4,
            continuityGuidanceCorrect: false,
            recoveredStateFacts: 1,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: false,
            provisionalMemoriesWritten: 1,
          },
          forgetting: {
            contextItems: 8,
            usefulContextItems: 2,
          },
          learning_control: {
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        aionis: {
          continuity: {
            repeatedDiscoverySteps: 1,
            continuityGuidanceCorrect: true,
            recoveredStateFacts: 4,
            expectedStateFacts: 4,
          },
          learning: {
            workflowReused: true,
            stableWorkflowReused: true,
            trustedPromotions: 1,
            weakEvidencePromoted: 0,
          },
          forgetting: {
            contextItems: 4,
            usefulContextItems: 4,
            staleMemorySuppressed: 2,
          },
          learning_control: {
            weakEvidenceBlocked: 2,
            authorityRequiresEvidence: true,
            blockedAuthorityVisible: true,
            unverifiedAuthorityApplied: 0,
          },
        },
        comparison: {
          mode: "baseline_vs_aionis",
          sufficient_evidence: true,
        },
        evidence_ids: ["effect-run:skill-candidate-route"],
      },
    });
    assert.equal(measure.statusCode, 200);
    const measureBody = measure.json();
    assert.ok(measureBody.effect_report.training_candidates.some((candidate: any) =>
      candidate.candidate_type === "trace_derived_skill"
    ));

    const queued = await app.inject({
      method: "POST",
      url: "/v1/skills/candidates",
      payload: {
        measure_result: measureBody,
      },
    });
    assert.equal(queued.statusCode, 200);
    const queuedBody = queued.json();
    assert.equal(queuedBody.contract_version, "aionis_trace_derived_skill_review_result_v1");
    assert.equal(queuedBody.safety.agent_prompt_included, false);
    assert.equal(queuedBody.safety.memory_runtime_mutation, false);
    assert.equal(queuedBody.inserted_count, 2);
    assert.equal(queuedBody.candidate_count, 2);
    const firstId = queuedBody.candidates[0].candidate_id;
    const secondId = queuedBody.candidates[1].candidate_id;
    assert.ok(firstId);
    assert.ok(secondId);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/skills/candidates?status=pending_review&limit=10",
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().candidate_count, 2);

    const promoted = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${firstId}/promote`,
      payload: {
        reviewer_id: "operator-1",
        reason: "Strong continuity evidence.",
      },
    });
    assert.equal(promoted.statusCode, 200);
    assert.equal(promoted.json().candidates[0].review_status, "promoted");
    assert.equal(promoted.json().candidates[0].candidate.trace_derived_skill.authority_state, "candidate");
    assert.equal(promoted.json().safety.memory_runtime_mutation, false);

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${secondId}/reject`,
      payload: {
        reviewer_id: "operator-1",
        reason: "Needs more repeated evidence.",
      },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().candidates[0].review_status, "rejected");
  } finally {
    await reviewStore.close();
    await app.close();
  }
});

test("product observe turns plain input_text into recallable general memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-plain-text");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const memoryText = "The workspace owner prefers concise product-facing status reports with direct next steps.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: memoryText,
        auto_embed: true,
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assertNoForbiddenProductFields(observeBody);
    assertExactKeys(observeBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "observed",
      "structured_memory",
      "memory_write",
      "handoff",
      "source_map",
    ]);
    assertExactKeys(observeBody.observed, [
      "memory_written",
      "handoff_stored",
      "general_memory_count",
      "execution_memory_count",
      "auto_text_memory_count",
      "execution_observation_count",
    ]);
    assertExactKeys(observeBody.structured_memory, [
      "schema_version",
      "mode",
      "input_node_count",
      "auto_text_node_count",
      "passthrough_node_count",
      "already_structured_node_count",
      "execution_workflow_count",
      "execution_observation_count",
      "general_memory_count",
      "structured_nodes",
    ]);
    assertProductSourceMap(observeBody.source_map);
    assert.equal(observeBody.observed.memory_written, true);
    assert.equal(observeBody.observed.auto_text_memory_count, 1);
    assert.equal(observeBody.observed.general_memory_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "input_text");
    assert.equal(observeBody.structured_memory.structured_nodes[0].classification, "general_memory");
    assert.equal(observeBody.memory_write.nodes.length, 1);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "How should status reports be written?",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.memory_packet.memory_family, "general_cognitive");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "general"
        && entry.summary === memoryText,
      ),
    );
    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    assert.equal(auditBody.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(auditBody.memory_decision_audit.agent_prompt_included, false);
    assert.equal(guideBody.agent_context.prompt_text.includes("memory_decision_audit"), false);
    assert.equal(guideBody.agent_context.prompt_text.includes("decision_reviews"), false);
  } finally {
    await app.close();
  }
});

test("fresh single-agent guide distinguishes channel history from actionable history", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("fresh-single-agent-actionable-history");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "fresh-single-agent-actionable-history",
        query_text: "Start a fresh single-agent task with no prior memory.",
        agent_role: "agent",
        consumer_agent_id: "fresh-agent",
        mode: "full_power",
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const body = guide.json();
    assert.equal(body.guide_packet.guide_brief.history_used, false);
    assert.equal(body.guide_packet.guide_brief.actionable_history_used, false);
    assert.equal(body.guide_packet.guide_brief.recommended_posture, "ignore_history");
    assert.equal(body.guide_packet.guide_brief.authority, "none");
    assert.equal(body.agent_context.history_used, true);
    assert.equal(body.agent_context.actionable_history_used, false);
    assert.equal(body.agent_context.recommended_posture, "ignore_history");
    assert.equal(body.agent_context.authority, "none");
    assert.deepEqual(body.agent_context.use_now_memory_ids, []);
    assert.deepEqual(body.agent_context.inspect_before_use_memory_ids, []);
    assert.deepEqual(body.agent_context.do_not_use_memory_ids, []);
    assert.equal(body.agent_context.prompt_text.includes("actionable_history=no"), true);
  } finally {
    await app.close();
  }
});

test("product observe persists lifecycle relation graph and guide suppresses superseded memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-lifecycle-relation-graph");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const oldSummary = "AIONIS_RELATION_OLD_MARKER Initial checkout validation investigation. At that time the likely change surface looked like: legacy/payments/old-checkout.ts and obsolete/tests/old-checkout.test.ts. This note was written before later repository evidence was examined.";
    const currentSummary = "AIONIS_RELATION_CURRENT_MARKER Later corrected checkout validation project memory. Subsequent evidence contradicted the earlier initial working note; the earlier change surface should be treated as an unverified prior, not direct action context. Current change surface: src/payments/checkout.ts and tests/checkout.test.ts.";

    const oldObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory: {
          client_id: "lifecycle-relation-old-checkout",
          type: "concept",
          memory_kind: "general_memory",
          title: "Initial checkout validation investigation",
          text_summary: oldSummary,
          confidence: 0.91,
        },
      },
    });
    assert.equal(oldObserve.statusCode, 200);
    const oldNodeId = oldObserve.json().memory_write.nodes[0].id;

    const currentObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory: {
          client_id: "lifecycle-relation-current-checkout",
          type: "concept",
          memory_kind: "general_memory",
          title: "Corrected checkout validation investigation",
          text_summary: currentSummary,
          confidence: 0.94,
        },
      },
    });
    assert.equal(currentObserve.statusCode, 200);
    const currentBody = currentObserve.json();
    const currentNodeId = currentBody.memory_write.nodes[0].id;
    assert.ok(currentBody.memory_write.edges.some((edge: Record<string, unknown>) =>
      edge.type === "contradicts"
      && edge.src_id === currentNodeId
      && edge.dst_id === oldNodeId,
    ));

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_RELATION_OLD_MARKER legacy/payments/old-checkout.ts checkout validation",
        consumer_agent_id: "local-user",
        limit: 1,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    const oldMemory = guideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === oldNodeId,
    );
    assert.ok(oldMemory);
    assert.equal(oldMemory.lifecycle_state, "contested");
    assert.equal(oldMemory.authority, "candidate");
    assert.ok(guideBody.memory_packet.evidence_trail.some((entry: Record<string, unknown>) =>
      entry.source === "edge"
      && entry.relation === "contradicts"
      && entry.memory_id === oldNodeId,
    ));
    assert.ok(guideBody.memory_packet.source_map.internal_surfaces_used.includes("memory_lifecycle_relation_graph"));
    assert.equal(
      guideBody.agent_context.use_now.some((entry: string) => entry.includes("AIONIS_RELATION_OLD_MARKER")),
      false,
    );
    assert.ok(
      guideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes(oldNodeId) || entry.includes("Initial checkout validation investigation")
      ),
    );
    assert.ok(
      guideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.startsWith("Premise risk:")
        && entry.includes(currentNodeId)
        && entry.includes("contradicts")
      ),
    );
    assert.ok(guideBody.agent_context.risk.reasons.includes("premise_firewall_query_conflicts_with_current_memory"));
    assert.ok(guideBody.source_map.internal_surfaces_used.includes("memory_contract"));
    assert.ok(guideBody.source_map.internal_surfaces_used.includes("premise_firewall"));
    assert.equal(guideBody.agent_context.prompt_text.includes("legacy/payments/old-checkout.ts"), false);
    assert.equal(guideBody.agent_context.prompt_text.includes("decision_reviews"), false);

    const debugTrace = await app.inject({
      method: "POST",
      url: "/v1/debug/memory-decision-trace",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(debugTrace.statusCode, 200);
    const debugBody = debugTrace.json();
    assert.deepEqual(debugBody.source_map.routes_used, ["/v1/debug/memory-decision-trace"]);
    assertDecisionTraceMatchesGuide(debugBody.memory_decision_trace, guideBody);
    const oldDecision = debugBody.memory_decision_trace.memory_decisions.find((entry: Record<string, unknown>) =>
      entry.memory_id === oldNodeId,
    );
    assert.equal(oldDecision?.decision_kind, "downgraded");
    assert.ok((oldDecision?.reason_codes as string[]).includes("premise_firewall_query_risk"));
    assert.ok(debugBody.memory_decision_trace.source_map.internal_surfaces_used.includes("premise_firewall"));
    assert.ok(debugBody.memory_decision_trace.memory_use_receipt.risk_flags.includes("premise_firewall_query_risk"));
    assert.equal(objectValue(oldDecision?.downgraded_detail, "old decision downgraded detail").by_memory_id, currentNodeId);

    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          after_guide: guideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    const downgraded = auditBody.memory_decision_audit.decision_reviews.downgraded_memories[0];
    assert.equal(downgraded.memory_id, oldNodeId);
    assert.equal(downgraded.by_memory_id, currentNodeId);
    assert.equal(downgraded.lifecycle_relation, "contradicts");
    assert.equal(downgraded.producer, "rule_cue");
    assert.equal(downgraded.gate.accepted, true);
    assert.ok(downgraded.signals.source_newer);
    assert.deepEqual(auditBody.source_map.routes_used, ["/v1/audit/memory-decision-report"]);
    assertAuditReportMatchesTrace(auditBody.memory_decision_audit, debugBody.memory_decision_trace);
  } finally {
    await app.close();
  }
});

test("product observe keeps active preference rules recallable in agent context", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-active-preference-rule");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const preferenceText = "ACTIVE_PREF_MARKER: The user prefers concise memory guidance with concrete evidence references.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        nodes: [{
          client_id: "active-preference-rule",
          type: "rule",
          title: "Active response preference",
          text_summary: preferenceText,
          confidence: 0.86,
          slots: {
            memory_kind: "general_memory",
            lifecycle_state: "active",
            state: "active",
            compression_layer: "L2",
          },
        }],
      },
    });

    assert.equal(observe.statusCode, 200);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "What response preference should I follow for memory guidance?",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.agent_context.history_used, true);
    assert.equal(guideBody.agent_context.authority, "advisory");
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.memory_type === "preference"
        && entry.summary === preferenceText,
      ),
    );
    assert.ok(
      guideBody.agent_context.use_now.some((entry: string) => entry.includes("ACTIVE_PREF_MARKER")),
    );
  } finally {
    await app.close();
  }
});

test("product observe keeps SDK-style preference memory recallable without activating policy rules", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-sdk-style-preference-memory");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const preferenceText = "SDK_STYLE_PREF_MARKER: The user prefers compact product updates with concrete next steps.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: preferenceText,
        memory_kind: "general_memory",
        memory_lane: "private",
        owner_agent_id: "local-user",
        memory: {
          client_id: "sdk-style-preference-memory",
          type: "self_model",
          memory_kind: "general_memory",
          title: "SDK style response preference",
          text_summary: preferenceText,
          confidence: 0.9,
          slots: {
            memory_kind: "general_memory",
            lifecycle_state: "active",
            compression_layer: "L2",
          },
        },
      },
    });

    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "SDK_STYLE_PREF_MARKER response preference",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    assert.equal(guideBody.agent_context.use_now_memory_ids.includes(nodeId), true);
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.memory_id === nodeId
        && entry.memory_type === "preference"
        && entry.summary === preferenceText,
      ),
    );
    assert.ok(
      guideBody.agent_context.use_now.some((entry: string) => entry.includes("SDK_STYLE_PREF_MARKER")),
    );

    const rules = await app.inject({
      method: "POST",
      url: "/v1/memory/rules/evaluate",
      payload: {
        tenant_id: "default",
        scope: "default",
        context: {
          agent_id: "local-user",
          task: "SDK_STYLE_PREF_MARKER response preference",
        },
        include_shadow: true,
        limit: 20,
      },
    });

    assert.equal(rules.statusCode, 200, rules.body);
    assert.equal(rules.json().considered, 0);
    assert.equal(rules.json().matched, 0);
  } finally {
    await app.close();
  }
});

test("product observe turns execution input into recallable execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-execution-input");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const executionSummary = "Recovered the known target file, applied the scoped change, and verified the focused test before broad search.";
    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        execution: {
          run_id: "run:product-observe-execution",
          task_id: "task:continuity-product-loop",
          task_family: "continuity_recovery",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-before-broad-search",
          title: "Recover target file before broad discovery",
          summary: executionSummary,
          outcome: "succeeded",
          target_files: ["src/current-target.ts"],
          workflow_steps: [
            "Read the known target file",
            "Apply the scoped change",
            "Run the focused verifier",
          ],
          tool_set: ["read", "edit", "test"],
          acceptance_checks: ["focused verifier passed"],
          continuation_hint: "Recover and verify the known target before broad discovery.",
          confidence: 0.88,
          evidence: [{
            ref: "run:product-observe-execution#verifier",
            summary: "Focused verifier passed after the scoped edit.",
          }],
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assert.equal(observeBody.observed.execution_observation_count, 1);
    assert.equal(observeBody.observed.execution_memory_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "execution");
    assert.equal(observeBody.structured_memory.structured_nodes[0].execution_kind, "workflow_anchor");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        agent_role: "reviewer",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assertNoForbiddenProductFields(guideBody);
    assertExactKeys(guideBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "consumer_agent_id",
      "guide_trace_id",
      "agent_context",
      "memory_packet",
      "guide_packet",
      "source_map",
    ]);
    assertProductSourceMap(guideBody.source_map, [
      "admission_candidate_policy",
      "internal_surfaces_used",
      "omitted_internal_surfaces",
      "routes_used",
    ]);
    assert.deepEqual(guideBody.source_map.admission_candidate_policy, {
      mode: "off",
      source: "off",
    });
    assertExactKeys(guideBody.guide_packet.guide_brief, [
      "summary",
      "history_used",
      "actionable_history_used",
      "recommended_posture",
      "authority",
      "use_now",
      "inspect_before_use",
      "do_not_use",
      "rehydrate",
      "expected_product_effects",
    ]);
    assertExactKeys(guideBody.guide_packet.guide_brief.expected_product_effects, [
      "reduces_repeated_discovery",
      "reduces_context_replay",
      "controls_negative_transfer",
      "reason",
    ]);
    assertExactKeys(guideBody.agent_context, [
      "contract_version",
      "tenant_id",
      "scope",
      "agent_role",
      "agent_context_mode",
      "task_context_profile",
      "prompt_text",
      "summary",
      "history_used",
      "actionable_history_used",
      "recommended_posture",
      "authority",
      "target_files",
      "use_now",
      "inspect_before_use",
      "do_not_use",
      "memory_ids",
      "use_now_memory_ids",
      "inspect_before_use_memory_ids",
      "do_not_use_memory_ids",
      "command_posture",
      "route_contract",
      "prompt_aliases",
      "rehydrate_hints",
      "risk",
      "evidence_refs",
    ]);
    assert.equal(guideBody.agent_context.contract_version, "aionis_agent_context_v1");
    assert.equal(guideBody.agent_context.agent_role, "reviewer");
    assert.equal(guideBody.agent_context.agent_context_mode, "standard");
    assert.equal(guideBody.agent_context.task_context_profile, "general");
    assert.equal(typeof guideBody.guide_trace_id, "string");
    assert.ok(guideBody.guide_trace_id.startsWith("guide_trace:"));
    assert.equal(guideBody.agent_context.history_used, true);
    assert.equal(guideBody.agent_context.actionable_history_used, true);
    assert.deepEqual(guideBody.agent_context.prompt_aliases, []);
    assert.ok(guideBody.agent_context.prompt_text.includes("AIONIS_AGENT_CONTEXT v1"));
    assert.ok(guideBody.agent_context.prompt_text.includes("state: role=reviewer"));
    assert.ok(guideBody.agent_context.prompt_text.includes("role_focus: review branch status"));
    assert.equal(guideBody.agent_context.route_contract.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
    assert.equal(guideBody.agent_context.route_contract.fallback_policy, "do_not_promote_reference_or_blocked_targets");
    assert.deepEqual(guideBody.agent_context.route_contract.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
    assert.equal(guideBody.agent_context.route_contract.action_policy.terminal_inspect_allowed, false);
    assert.equal(guideBody.agent_context.route_contract.action_policy.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
    assert.ok(guideBody.source_map.internal_surfaces_used.includes("role_aware_agent_context"));
    assert.ok(guideBody.agent_context.prompt_text.length < JSON.stringify({
      memory_packet: guideBody.memory_packet,
      guide_packet: guideBody.guide_packet,
    }).length);
    assert.equal(guideBody.memory_packet.memory_family, "execution");
    assert.equal(guideBody.guide_packet.guide_brief.history_used, true);
    assert.equal(guideBody.guide_packet.guide_brief.actionable_history_used, true);
    assert.ok(
      ["reuse_supported_history", "use_as_context", "inspect_before_use", "rehydrate_before_use"].includes(
        guideBody.guide_packet.guide_brief.recommended_posture,
      ),
    );
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "execution"
        && entry.memory_type === "execution_memory"
        && entry.summary === executionSummary,
      ),
    );

    const compactGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
      },
    });
    assert.equal(compactGuide.statusCode, 200);
    const compactBody = compactGuide.json();
    assertNoForbiddenProductFields(compactBody);
    assertExactKeys(compactBody, [
      "contract_version",
      "tenant_id",
      "scope",
      "consumer_agent_id",
      "guide_trace_id",
      "agent_context",
      "source_map",
    ]);
    assert.equal("memory_packet" in compactBody, false);
    assert.equal("guide_packet" in compactBody, false);
    assert.equal(typeof compactBody.guide_trace_id, "string");
    assert.ok(compactBody.guide_trace_id.startsWith("guide_trace:"));
    assert.equal(compactBody.agent_context.contract_version, "aionis_agent_context_v1");
    assert.equal(compactBody.agent_context.history_used, true);
    assert.deepEqual(compactBody.agent_context.target_files, ["src/current-target.ts"]);
    assert.equal(compactBody.agent_context.route_contract.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
    assert.equal(compactBody.agent_context.route_contract.fallback_policy, "do_not_promote_reference_or_blocked_targets");
    assert.deepEqual(compactBody.agent_context.route_contract.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
    assert.equal(compactBody.agent_context.route_contract.action_policy.terminal_inspect_allowed, false);
    assert.equal(compactBody.agent_context.route_contract.action_policy.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
    assert.ok(compactBody.source_map.omitted_internal_surfaces.includes("memory_packet"));
    assert.ok(compactBody.source_map.omitted_internal_surfaces.includes("guide_packet"));
  } finally {
    await app.close();
  }
});

test("product observe gives repeated execution observations distinct default ids when run anchors differ", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-execution-distinct-run-anchors");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const baseExecution = {
      task_signature: "claude-code:diagnostic:workspace",
      title: "Claude Code Bash completed",
      summary: "Bash: npm test 2>&1 completed. Response excerpt: tests passed",
      outcome: "succeeded",
      tool_set: ["Bash"],
      confidence: 0.8,
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        memory_lane: "shared",
        producer_agent_id: "claude-code",
        owner_team_id: "team:diagnostic",
        execution: {
          ...baseExecution,
          run_id: "claude:session-one",
          raw_ref: "tool-use-one",
        },
      },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        memory_lane: "shared",
        producer_agent_id: "claude-code",
        owner_team_id: "team:diagnostic",
        execution: {
          ...baseExecution,
          run_id: "claude:session-two",
          raw_ref: "tool-use-two",
        },
      },
    });
    assert.equal(second.statusCode, 200, second.body);

    const firstClientId = first.json().structured_memory.structured_nodes[0].client_id;
    const secondClientId = second.json().structured_memory.structured_nodes[0].client_id;
    assert.equal(typeof firstClientId, "string");
    assert.equal(typeof secondClientId, "string");
    assert.notEqual(firstClientId, secondClientId);
  } finally {
    await app.close();
  }
});

test("product guide full_power merges semantic memory with safe execution context", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-full-power-merged-agent-context");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const generalObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "FULL_POWER_GUIDE_GENERAL_MEMORY Use the release checklist when summarizing this task.",
        memory: {
          client_id: "memory:full-power-guide-general",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "FULL_POWER_GUIDE_GENERAL_MEMORY release checklist",
          text_summary: "FULL_POWER_GUIDE_GENERAL_MEMORY Use the release checklist when summarizing this task.",
          confidence: 0.9,
        },
      },
    });
    assert.equal(generalObserve.statusCode, 200, generalObserve.body);
    const generalNodeId = generalObserve.json().memory_write.nodes[0].id;

    const contestedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "FULL_POWER_GUIDE_CONTESTED_MEMORY Prefer the old checklist.",
        memory: {
          client_id: "memory:full-power-guide-contested",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "FULL_POWER_GUIDE_CONTESTED_MEMORY old checklist",
          text_summary: "FULL_POWER_GUIDE_CONTESTED_MEMORY Prefer the old checklist.",
          confidence: 0.86,
        },
      },
    });
    assert.equal(contestedObserve.statusCode, 200, contestedObserve.body);
    const contestedNodeId = contestedObserve.json().memory_write.nodes[0].id;
    const contestedFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [contestedNodeId],
        run_id: "run:full-power-guide-contested",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        activate: true,
        reason: "The old checklist caused a verifier failure.",
      },
    });
    assert.equal(contestedFeedback.statusCode, 200, contestedFeedback.body);

    const evidenceWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "Full-power product guide raw evidence and bounded abstraction.",
        auto_embed: false,
        nodes: [
          {
            client_id: "memory:full-power-guide-raw-evidence",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "local-user",
            title: "Raw full-power guide evidence",
            text_summary: "FULL_POWER_GUIDE_RAW_EVIDENCE raw verifier trace should stay out of agent_context prompt.",
            raw_ref: "raw://product-guide/full-power/verifier",
            evidence_ref: "evidence://product-guide/full-power/verifier",
            slots: {
              task_signature: "full-power-guide-contract",
              evidence_kind: "verifier_trace",
            },
          },
          {
            client_id: "memory:full-power-guide-gated-abstraction",
            type: "procedure",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "local-user",
            title: "Bounded full-power guide abstraction",
            text_summary: "FULL_POWER_GUIDE_GATED_ABSTRACTION reuse only when applies_when matches.",
            slots: {
              task_signature: "full-power-guide-contract",
              summary_kind: "pattern_anchor",
              applies_when: ["release checklist task needs branch-aware status"],
              does_not_apply_when: ["task asks for old checklist"],
              counterexamples: ["FULL_POWER_GUIDE_CONTESTED_MEMORY caused verifier failure"],
              source_episode_refs: ["raw://product-guide/full-power/verifier"],
              promotion_state: "stable",
            },
          },
          {
            client_id: "memory:full-power-guide-gated-admitted",
            type: "procedure",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "local-user",
            title: "Admitted bounded guide abstraction",
            text_summary: "FULL_POWER_GUIDE_GATED_ADMITTED admitted bounded abstraction should stay out of product guide agent_context.",
            slots: {
              task_signature: "full-power-guide-contract",
              summary_kind: "pattern_anchor",
              applies_when: ["release checklist task needs branch-aware status"],
              does_not_apply_when: ["task asks for unrelated migration work"],
              source_episode_refs: ["raw://product-guide/full-power/verifier"],
              promotion_state: "stable",
            },
          },
        ],
        edges: [],
      },
    });
    assert.equal(evidenceWrite.statusCode, 200, evidenceWrite.body);

    const executionTree = buildProductGuideFullPowerTree("contract");
    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        mode: "full_power",
        query_text: [
          "FULL_POWER_GUIDE_GENERAL_MEMORY",
          "FULL_POWER_GUIDE_PASSED_BRANCH",
          "FULL_POWER_GUIDE_FAILED_BRANCH",
          "full power guide contract",
        ].join(" "),
        agent_role: "reviewer",
        consumer_agent_id: "local-user",
        context: {
          task_signature: "full-power-guide-contract",
        },
        execution_tree_v1: executionTree,
        limit: 12,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    const agentContext = guideBody.agent_context;
    assert.equal(agentContext.contract_version, "aionis_agent_context_v1");
    assert.equal(agentContext.history_used, true);
    assert.equal(guideBody.source_map.routes_used.includes("/v1/execution/context/assemble"), true);
    assert.equal(guideBody.source_map.internal_surfaces_used.includes("full_power_execution_context"), true);
    assert.equal(guideBody.source_map.internal_surfaces_used.includes("full_power_agent_context_merge"), true);
    assert.equal(agentContext.memory_ids.includes(generalNodeId), true);
    assert.equal(agentContext.use_now.some((entry: string) => entry.includes("FULL_POWER_GUIDE_GENERAL_MEMORY")), true);
    assert.equal(agentContext.use_now.some((entry: string) => entry.includes("FULL_POWER_GUIDE_PASSED_BRANCH")), true);
    assert.equal(agentContext.do_not_use.some((entry: string) => entry.includes("FULL_POWER_GUIDE_FAILED_BRANCH")), true);
    assert.equal(agentContext.use_now.some((entry: string) => entry.includes("FULL_POWER_GUIDE_CONTESTED_MEMORY")), false);
    assert.equal(agentContext.inspect_before_use_memory_ids.includes(contestedNodeId), true);
    assert.equal(agentContext.recommended_posture, "inspect_before_use");
    assert.equal(agentContext.prompt_text.includes("AIONIS_CTX v2"), true);
    assert.equal(agentContext.prompt_text.includes("avoid: note="), true);
    assert.equal(agentContext.prompt_text.includes("RAW_EVIDENCE"), false);
    assert.equal(agentContext.prompt_text.includes("GATED_ABSTRACTIONS"), false);
    assert.equal(agentContext.prompt_text.includes("TRACE"), false);
    assert.equal(agentContext.prompt_text.includes("FULL_POWER_GUIDE_RAW_EVIDENCE"), false);
    assert.equal(agentContext.prompt_text.includes("FULL_POWER_GUIDE_GATED_ABSTRACTION"), false);
    assert.equal(agentContext.prompt_text.includes("FULL_POWER_GUIDE_GATED_ADMITTED"), false);
    assert.equal(agentContext.prompt_text.includes("full_power_trace"), false);
    const visibleAgentText = JSON.stringify({
      use_now: agentContext.use_now,
      inspect_before_use: agentContext.inspect_before_use,
      do_not_use: agentContext.do_not_use,
      risk: agentContext.risk,
    });
    assert.equal(visibleAgentText.includes("FULL_POWER_GUIDE_RAW_EVIDENCE"), false);
    assert.equal(visibleAgentText.includes("FULL_POWER_GUIDE_GATED_ABSTRACTION"), false);
    assert.equal(visibleAgentText.includes("FULL_POWER_GUIDE_GATED_ADMITTED"), false);
    assert.equal(visibleAgentText.includes("Bounded guidance"), false);
    assert.equal(visibleAgentText.includes("gated abstraction"), false);

    const compactGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        context_mode: "compact_agent",
        query_text: [
          "FULL_POWER_GUIDE_GENERAL_MEMORY",
          "FULL_POWER_GUIDE_PASSED_BRANCH",
          "FULL_POWER_GUIDE_FAILED_BRANCH",
          "full power guide contract",
        ].join(" "),
        agent_role: "reviewer",
        consumer_agent_id: "local-user",
        context: {
          task_signature: "full-power-guide-contract",
        },
        execution_tree_v1: executionTree,
        limit: 12,
      },
    });
    assert.equal(compactGuide.statusCode, 200, compactGuide.body);
    const compactGuideBody = compactGuide.json();
    const compactAgentContext = compactGuideBody.agent_context;
    assert.equal(compactAgentContext.agent_context_mode, "compact_agent");
    assert.equal(compactGuideBody.source_map.routes_used.includes("/v1/execution/context/assemble"), true);
    assert.equal(compactGuideBody.source_map.internal_surfaces_used.includes("compact_agent_context"), true);
    assert.equal(compactAgentContext.prompt_text.includes("AIONIS_CTX compact_agent"), true);
    assert.equal(compactAgentContext.prompt_text.length < agentContext.prompt_text.length, true);
    assert.equal(compactAgentContext.use_now.some((entry: string) => entry.includes("FULL_POWER_GUIDE_PASSED_BRANCH")), true);
    assert.equal(compactAgentContext.do_not_use.some((entry: string) => entry.includes("FULL_POWER_GUIDE_FAILED_BRANCH")), true);
    assert.equal(compactAgentContext.prompt_text.includes("RAW_EVIDENCE"), false);
    assert.equal(compactAgentContext.prompt_text.includes("TRACE"), false);
  } finally {
    await app.close();
  }
});

test("full-power product guide merges structured execution control memory into packet context and receipt", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("full-power-structured-execution-control");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const taskSignature = "structured-execution-control-guide";
    const workflowSignature = "workflow:structured-execution-control-guide";
    const tenantId = "structured-control-tenant";
    const scope = "structured-control-scope";
    const executionSlots = (
      id: string,
      lifecycle_state: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) => ({
      lifecycle_state,
      execution_result_summary: {
        status,
        summary: `Structured control evidence ${id}`,
      },
      execution_native_v1: {
        schema_version: "execution_native_v1",
        execution_kind: "execution_native",
        summary_kind: id,
        compression_layer: id === "rehydrate" ? "L1" : "L2",
        contract_trust: status === "failed" ? "observational" : "advisory",
        task_signature: taskSignature,
        workflow_signature: workflowSignature,
        anchor_kind: "execution",
        anchor_level: id === "rehydrate" ? "L1" : "L2",
        selected_tool: "edit",
        file_path: `src/${id}.ts`,
        target_files: [`src/${id}.ts`],
        next_action: id === "failed"
          ? "Do not continue this failed branch."
          : id === "contested"
            ? "Inspect before relying on this contested branch."
            : "Rehydrate payload only if exact trace details are required.",
        ...extra,
      },
    });

    const write = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: {
        tenant_id: tenantId,
        scope,
        actor: "local-user",
        input_text: "Structured full-power execution control evidence.",
        auto_embed: false,
        nodes: [
          {
            client_id: "structured-control-passed-workflow",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "control-agent",
            owner_team_id: "control-team",
            title: "STRUCTURED_CONTROL_PASSED_WORKFLOW",
            text_summary: "STRUCTURED_CONTROL_PASSED_WORKFLOW is the accepted workflow route and should be reused directly.",
            slots: executionSlots("passed", "active", "passed", {
              summary_kind: "workflow_anchor",
              execution_kind: "workflow_anchor",
              execution_outcome_role: "passed_solution",
              anchor_kind: "workflow",
              file_path: "src/passed.ts",
              target_files: ["src/passed.ts", "src/passed-helper.ts"],
              next_action: "Continue STRUCTURED_CONTROL_PASSED_WORKFLOW through src/passed.ts.",
            }),
          },
          {
            client_id: "structured-control-failed",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "control-agent",
            owner_team_id: "control-team",
            title: "STRUCTURED_CONTROL_FAILED_BRANCH",
            text_summary: "STRUCTURED_CONTROL_FAILED_BRANCH broad edit failed verifier checks and must not be reused.",
            slots: executionSlots("failed", "suppressed", "failed"),
          },
          {
            client_id: "structured-control-contested",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "control-agent",
            owner_team_id: "control-team",
            title: "STRUCTURED_CONTROL_CONTESTED_BRANCH",
            text_summary: "STRUCTURED_CONTROL_CONTESTED_BRANCH has conflicting evidence and needs inspection before reuse.",
            slots: executionSlots("contested", "contested", "contested"),
          },
          {
            client_id: "structured-control-rehydrate",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "control-agent",
            owner_team_id: "control-team",
            title: "STRUCTURED_CONTROL_REHYDRATE_POINTER",
            text_summary: "STRUCTURED_CONTROL_REHYDRATE_POINTER is a cold trace pointer; do not expand unless exact details are needed.",
            slots: executionSlots("rehydrate", "rehydration_candidate", "passed", {
              rehydration: {
                default_mode: "partial",
                payload_cost_hint: "medium",
                recommended_when: ["exact failed trace detail is required"],
              },
            }),
          },
          {
            client_id: "structured-control-other-task",
            type: "evidence",
            tier: "warm",
            memory_lane: "private",
            owner_agent_id: "control-agent",
            owner_team_id: "control-team",
            title: "STRUCTURED_CONTROL_OTHER_TASK",
            text_summary: "STRUCTURED_CONTROL_OTHER_TASK belongs to another task and must not be recalled.",
            slots: {
              ...executionSlots("other", "suppressed", "failed"),
              execution_native_v1: {
                ...(executionSlots("other", "suppressed", "failed").execution_native_v1 as Record<string, unknown>),
                task_signature: "unrelated-structured-control-guide",
                workflow_signature: "workflow:unrelated-structured-control-guide",
              },
            },
          },
        ],
        edges: [],
      },
    });
    assert.equal(write.statusCode, 200, write.body);
    const writtenNodes = arrayValue(write.json().nodes, "write.nodes");
    const idByClientId = new Map(writtenNodes.map((entry) => [entry.client_id, entry.id]));
    const passedWorkflowNodeId = String(idByClientId.get("structured-control-passed-workflow"));
    const failedNodeId = String(idByClientId.get("structured-control-failed"));
    const contestedNodeId = String(idByClientId.get("structured-control-contested"));
    const rehydrateNodeId = String(idByClientId.get("structured-control-rehydrate"));
    const otherNodeId = String(idByClientId.get("structured-control-other-task"));

    const noiseWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: {
        tenant_id: tenantId,
        scope,
        actor: "local-user",
        input_text: "Structured full-power execution control recency noise.",
        auto_embed: false,
        nodes: Array.from({ length: 48 }, (_, index) => ({
          client_id: `structured-control-background-${index}`,
          type: "evidence",
          tier: "warm",
          memory_lane: "private",
          owner_agent_id: "control-agent",
          owner_team_id: "control-team",
          title: `STRUCTURED_CONTROL_BACKGROUND_${index}`,
          text_summary: `STRUCTURED_CONTROL_BACKGROUND_${index} is unrelated workflow volume and must not replace accepted route evidence.`,
          slots: executionSlots(`background-${index}`, "active", "passed", {
            execution_kind: "workflow_anchor",
            summary_kind: "workflow_anchor",
            anchor_kind: "workflow",
            file_path: `internal/noise/${index}.txt`,
            target_files: [`internal/noise/${index}.txt`],
            next_action: `Background noise ${index}; do not treat as accepted route.`,
          }),
        })),
        edges: [],
      },
    });
    assert.equal(noiseWrite.statusCode, 200, noiseWrite.body);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: tenantId,
        scope,
        mode: "full_power",
        query_text: "Continue the structured execution control task without repeating bad branches; request exact raw failed trace detail if a payload pointer is available.",
        agent_role: "worker",
        consumer_agent_id: "control-agent",
        consumer_team_id: "control-team",
        context: {
          task_signature: taskSignature,
          workflow_signature: workflowSignature,
        },
        include_packets: true,
        context_char_budget: 4096,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    const agentContext = guideBody.agent_context;
    const memoryPacket = guideBody.memory_packet;
    assert.equal(guideBody.scope, scope);
    assert.equal(memoryPacket.scope, scope);
    assert.equal(guideBody.source_map.internal_surfaces_used.includes("full_power_structured_execution_recall"), true);
    assert.equal(agentContext.use_now_memory_ids.includes(passedWorkflowNodeId), true);
    assert.equal(agentContext.do_not_use_memory_ids.includes(failedNodeId), true);
    assert.equal(agentContext.inspect_before_use_memory_ids.includes(contestedNodeId), true);
    assert.equal(agentContext.rehydrate_hints.some((hint: Record<string, unknown>) => hint.memory_id === rehydrateNodeId), true);
    assert.equal(agentContext.use_now.some((entry: string) => entry.includes("STRUCTURED_CONTROL_PASSED_WORKFLOW")), true);
    assert.equal(agentContext.do_not_use.some((entry: string) => entry.includes("STRUCTURED_CONTROL_FAILED_BRANCH")), true);
    assert.equal(agentContext.inspect_before_use.some((entry: string) => entry.includes("STRUCTURED_CONTROL_CONTESTED_BRANCH")), true);
    assert.equal(agentContext.prompt_text.includes("STRUCTURED_CONTROL_OTHER_TASK"), false);
    const packetMemoryIds = arrayValue(memoryPacket.relevant_memories, "memory_packet.relevant_memories")
      .map((entry) => entry.memory_id);
    assert.equal(packetMemoryIds.includes(passedWorkflowNodeId), true);
    assert.equal(packetMemoryIds.includes(failedNodeId), true);
    assert.equal(packetMemoryIds.includes(contestedNodeId), true);
    assert.equal(packetMemoryIds.includes(rehydrateNodeId), true);
    assert.equal(packetMemoryIds.includes(otherNodeId), false);
    const failedMemoryEntry = arrayValue(memoryPacket.relevant_memories, "memory_packet.relevant_memories")
      .find((entry) => entry.memory_id === failedNodeId);
    assert.equal(
      arrayValue(failedMemoryEntry?.recall_sources, "failed recall_sources")
        .some((source) => source.kind === "execution_native"),
      true,
    );

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          baseline: {
            forgetting: {
              contextItems: 0,
              usefulContextItems: 0,
              staleMemorySurfaced: 0,
            },
          },
          after_guide: guideBody,
          evidence_ids: ["structured-execution-control-guide:test"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const receipt = measure.json().memory_decision_trace.memory_use_receipt;
    assert.equal(receipt.do_not_use_memory_ids.includes(failedNodeId), true);
    assert.equal(receipt.inspect_before_use_memory_ids.includes(contestedNodeId), true);
    assert.equal(receipt.rehydrate_memory_ids.includes(rehydrateNodeId), true);
  } finally {
    await app.close();
  }
});

test("product measure derives closed-loop effect from guide packets", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("measure-product-trace");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const query = "Recover target file before broad discovery";
    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        execution: {
          run_id: "run:product-measure-trace",
          task_id: "task:product-measure-trace",
          task_family: "continuity_recovery",
          task_signature: "measure-product-trace",
          workflow_signature: "recover-target-file-before-broad-search",
          title: "Recover target file before broad discovery",
          summary: "Recovered the known target file, applied the scoped change, and verified before broad search.",
          outcome: "succeeded",
          target_files: ["src/current-target.ts"],
          workflow_steps: [
            "Read the known target file",
            "Apply the scoped change",
            "Run the focused verifier",
          ],
          tool_set: ["read", "edit", "test"],
          acceptance_checks: ["focused verifier passed"],
          continuation_hint: "Reuse the known target-file recovery workflow before broad discovery.",
          confidence: 0.9,
          evidence: [{
            ref: "run:product-measure-trace#verifier",
            summary: "Focused verifier passed after the scoped edit.",
          }],
        },
      },
    });
    assert.equal(observe.statusCode, 200);

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200);
    const afterGuideBody = afterGuide.json();
    assert.equal(afterGuideBody.guide_packet.guide_brief.history_used, true);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        task: {
          task_id: "task:product-measure-trace",
          run_id: "run:product-measure-trace",
          task_signature: "measure-product-trace",
          task_family: "continuity_recovery",
        },
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:observe-guide-measure"],
        },
      },
    });

    assert.equal(measure.statusCode, 200);
    const body = measure.json();
    assert.equal(body.contract_version, "aionis_measure_result_v1");
    assert.equal(body.measurement_input.source, "product_trace");
    assert.equal(body.measurement_input.baseline.continuity.continuityGuidanceCorrect, false);
    assert.equal(body.measurement_input.aionis.continuity.continuityGuidanceCorrect, true);
    assert.ok(
      body.measurement_input.baseline.continuity.repeatedDiscoverySteps
      > body.measurement_input.aionis.continuity.repeatedDiscoverySteps,
    );
    assert.ok(body.kernel_report.proof_summary.repeated_discovery_delta > 0);
    assert.equal(body.effect_report.history_impact.impact_direction, "positive");
    assert.equal(body.effect_report.history_impact.changed_future_behavior, true);
    assert.equal(body.effect_report.feedback_signal_summary.present, false);
    assert.equal(body.effect_report.feedback_signal_summary.source, "memory_decision_audit");
    assert.equal(body.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.ok(body.source_map.internal_surfaces_used.includes("product_trace_projection"));
    assert.ok(body.source_map.internal_surfaces_used.includes("memory_decision_trace"));
    assert.ok(body.source_map.internal_surfaces_used.includes("memory_use_receipt"));
    assert.ok(body.source_map.internal_surfaces_used.includes("memory_decision_audit_report"));
    assert.equal(body.memory_decision_trace.contract_version, "aionis_memory_decision_trace_v1");
    assert.equal(body.memory_decision_trace.agent_prompt_included, false);
    assert.equal(body.memory_decision_trace.runtime_mutation, false);
    assert.equal(body.memory_decision_trace.input.agent_context_present, true);
    assert.equal(body.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(body.memory_decision_audit.agent_prompt_included, false);
    assert.equal(body.memory_decision_audit.runtime_mutation, false);
    assertDecisionTraceMatchesGuide(body.memory_decision_trace, afterGuideBody);
    assertAuditReportMatchesTrace(body.memory_decision_audit, body.memory_decision_trace);

    const debugTrace = await app.inject({
      method: "POST",
      url: "/v1/debug/memory-decision-trace",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
        },
      },
    });
    assert.equal(debugTrace.statusCode, 200);
    const debugBody = debugTrace.json();
    assert.equal(debugBody.contract_version, "aionis_memory_decision_trace_result_v1");
    assert.equal(debugBody.memory_decision_trace.contract_version, "aionis_memory_decision_trace_v1");
    assert.equal(debugBody.memory_decision_trace.agent_prompt_included, false);
    assert.deepEqual(debugBody.source_map.routes_used, ["/v1/debug/memory-decision-trace"]);
    assert.ok(debugBody.source_map.internal_surfaces_used.includes("memory_use_receipt"));
    assertDecisionTraceMatchesGuide(debugBody.memory_decision_trace, afterGuideBody);
    assertTraceCoreEqual(debugBody.memory_decision_trace, body.memory_decision_trace);

    const auditReport = await app.inject({
      method: "POST",
      url: "/v1/audit/memory-decision-report",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
        },
      },
    });
    assert.equal(auditReport.statusCode, 200);
    const auditBody = auditReport.json();
    assert.equal(auditBody.contract_version, "aionis_memory_decision_audit_result_v1");
    assert.equal(auditBody.memory_decision_audit.contract_version, "aionis_memory_decision_audit_report_v1");
    assert.equal(auditBody.memory_decision_audit.agent_prompt_included, false);
    assert.equal(afterGuideBody.agent_context.prompt_text.includes("memory_decision_audit"), false);
    assert.equal(afterGuideBody.agent_context.prompt_text.includes("decision_reviews"), false);
    assert.deepEqual(auditBody.source_map.routes_used, ["/v1/audit/memory-decision-report"]);
    assertAuditReportMatchesTrace(auditBody.memory_decision_audit, debugBody.memory_decision_trace);
    assert.deepEqual(
      auditBody.memory_decision_audit.decision_reviews,
      body.memory_decision_audit.decision_reviews,
    );

    const claimLedgerProjection = {
      contract_version: "aionis_claim_ledger_projection_v1",
      use_now: [{
        claim_id: "claim-product-current",
        slot_key: "project:product.current_target",
        subject_key: "project:product",
        predicate: "current_target",
        surface: "use_now",
        reason_code: "claim_ledger_live_singleton",
        value_text: "The current product route uses the accepted guide target.",
        authority: "trusted",
        status: "active",
        confidence: 0.9,
        evidence_refs: ["guide:product-current"],
        source_memory_id: null,
        valid_from: "2026-06-13T00:00:00.000Z",
        valid_until: null,
        superseded_by_claim_id: null,
      }],
      inspect_before_use: [],
      do_not_use: [],
      audit_only: [],
      blocked_superseded_count: 0,
      live_claim_count: 1,
      contested_claim_count: 0,
      agent_prompt_included: false,
      runtime_mutation: false,
    };

    const flightRecorder = await app.inject({
      method: "POST",
      url: "/v1/audit/flight-recorder",
      payload: {
        tenant_id: "default",
        scope: "default",
        guide_trace_id: afterGuideBody.guide_trace_id,
        run_id: "run:product-measure-trace",
        decision_time: "2026-06-13T00:00:00.000Z",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuideBody,
        },
        claim_ledger_projection: claimLedgerProjection,
        feedback_result: {
          run_id: "run:product-measure-trace",
          outcome: "positive",
          used_memory_ids: afterGuideBody.agent_context.use_now_memory_ids.slice(0, 1),
        },
      },
    });
    assert.equal(flightRecorder.statusCode, 200);
    const flightBody = flightRecorder.json();
    assert.equal(flightBody.contract_version, "aionis_agent_flight_recorder_result_v1");
    assert.equal(flightBody.agent_flight_recorder.contract_version, "aionis_agent_flight_recorder_report_v1");
    assert.equal(flightBody.agent_flight_recorder.agent_prompt_included, false);
    assert.equal(flightBody.agent_flight_recorder.runtime_mutation, false);
    assert.equal(flightBody.agent_flight_recorder.agent_view.prompt_text_included, false);
    assert.deepEqual(
      flightBody.agent_flight_recorder.agent_view.use_now_memory_ids,
      afterGuideBody.agent_context.use_now_memory_ids,
    );
    assert.equal(flightBody.agent_flight_recorder.replay_sources.has_agent_context, true);
    assert.equal(flightBody.agent_flight_recorder.replay_sources.has_memory_decision_trace, true);
    assert.equal(flightBody.agent_flight_recorder.replay_sources.has_operator_snapshot, true);
    assert.equal(flightBody.agent_flight_recorder.claim_ledger_projection.use_now[0].claim_id, "claim-product-current");
    assert.ok(flightBody.agent_flight_recorder.claims.some((claim: Record<string, unknown>) =>
      claim.claim === "claim_ledger_projection_replayable"
      && claim.status === "pass"
    ));
    assert.ok(flightBody.source_map.internal_surfaces_used.includes("claim_ledger_projection"));
    assert.equal(String(JSON.stringify(flightBody.agent_flight_recorder)).includes(afterGuideBody.agent_context.prompt_text), false);
    assert.deepEqual(flightBody.source_map.routes_used, ["/v1/audit/flight-recorder"]);
    assert.ok(flightBody.source_map.internal_surfaces_used.includes("agent_flight_recorder"));
  } finally {
    await app.close();
  }
});

test("product observe stores explicit handoff through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-handoff");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        handoff: {
          handoff_kind: "task_handoff",
          anchor: "product-observe-handoff",
          title: "Resume focused product check",
          summary: "Resume the focused product check without replaying the full prior conversation.",
          handoff_text: "Continue from the product observe facade validation point.",
          target_files: ["src/routes/product-facade.ts"],
          next_action: "Inspect product observe facade behavior and run the product facade test.",
          acceptance_checks: ["product facade test passes"],
          tags: ["product", "continuity"],
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const body = observe.json();
    assert.equal(body.observed.memory_written, false);
    assert.equal(body.observed.handoff_stored, true);
    assert.deepEqual(body.source_map.routes_used, ["/v1/handoff/store"]);
    assert.deepEqual(body.source_map.internal_surfaces_used, ["handoff_store"]);
    assert.equal(body.handoff.handoff.anchor, "product-observe-handoff");
    assert.equal(body.handoff.handoff.handoff_kind, "task_handoff");
  } finally {
    await app.close();
  }
});

test("product observe auto-structures user-level workflow input into execution memory", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-workflow");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        memory: {
          client_id: "workflow:continuity",
          type: "procedure",
          memory_kind: "execution_workflow",
          title: "Recover target file before broad discovery",
          text_summary: "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-first",
          target_files: ["src/current-target.ts"],
          next_action: "Read src/current-target.ts before broad discovery.",
          tool_set: ["read", "edit", "test"],
          confidence: 0.9,
        },
      },
    });

    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    assert.equal(observeBody.structured_memory.execution_workflow_count, 1);
    assert.equal(observeBody.structured_memory.structured_nodes[0].source, "memory");
    assert.equal(observeBody.structured_memory.structured_nodes[0].execution_kind, "workflow_anchor");
    assert.ok(observeBody.memory_write.nodes[0].id);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });

    assert.equal(guide.statusCode, 200);
    const guideBody = guide.json();
    assert.equal(guideBody.memory_packet.memory_family, "execution");
    assert.equal(guideBody.guide_packet.guide_brief.history_used, true);
    assert.equal(["first", "action"].join("_") in guideBody.guide_packet.guide_brief, false);
    assert.equal("learning_packet" in guideBody, false);
    assert.equal(["runtime", "context", "packet"].join("_") in guideBody, false);
    assert.equal(["continuity guidance", "recommendation"].join("_") in guideBody, false);
    assert.equal("cost_signals" in guideBody, false);
    assert.ok(
      guideBody.memory_packet.relevant_memories.some((entry: Record<string, unknown>) =>
        entry.domain === "execution"
        && entry.memory_type === "execution_memory"
        && entry.summary === "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
      ),
    );
    assert.ok(Array.isArray(guideBody.guide_packet.guidance.workflow_candidates));
  } finally {
    await app.close();
  }
});

test("product observe does not auto-promote general memory into execution workflow", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("observe-general");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "The workspace owner prefers short product-facing reports.",
        auto_embed: true,
        nodes: [{
          client_id: "general:report-style",
          type: "concept",
          memory_kind: "general_memory",
          title: "Report style preference",
          text_summary: "The workspace owner prefers short product-facing reports.",
          confidence: 0.9,
        }],
      },
    });

    assert.equal(observe.statusCode, 200);
    const body = observe.json();
    assert.equal(body.structured_memory.execution_workflow_count, 0);
    assert.equal(body.structured_memory.general_memory_count, 1);
    assert.equal(body.structured_memory.structured_nodes[0].execution_kind, null);
  } finally {
    await app.close();
  }
});

test("product forget rehydrates archived memory through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-rehydrate-archive");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "Archive this proven workflow until a related task needs it again.",
        memory: {
          client_id: "archive:product-forget-rehydrate",
          type: "procedure",
          tier: "archive",
          memory_kind: "execution_workflow",
          title: "Archived workflow for product forget",
          text_summary: "Rehydrate this archived workflow only when the same continuation need returns.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;
    const query = "Rehydrate this archived workflow only when the same continuation need returns.";
    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "rehydrate",
        target: "archive",
        memory_ids: [nodeId],
        target_tier: "hot",
        reason: "The related task returned and needs this archived workflow.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assertNoForbiddenProductFields(body);
    assertExactKeys(body, [
      "contract_version",
      "tenant_id",
      "scope",
      "operation",
      "target",
      "forget_effect",
      "result",
      "source_map",
    ]);
    assertExactKeys(body.forget_effect, [
      "action",
      "target",
      "reason",
      "changed_count",
      "reversible",
      "affected_memory_ids",
      "affected_client_ids",
      "anchor_id",
      "anchor_uri",
    ]);
    assertProductSourceMap(body.source_map, [
      "internal_surfaces_used",
      "omitted_internal_surfaces",
      "routes_used",
    ]);
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "rehydrate");
    assert.equal(body.target, "archive");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, true);
    assert.deepEqual(body.forget_effect.affected_memory_ids, [nodeId]);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/archive/rehydrate"]);
    assert.equal(body.result.rehydrated.moved_nodes, 1);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.tier, "hot");
    assert.equal(rows[0]?.slots.last_rehydrated_job, "archive_rehydrate");

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: query,
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuide.json(),
          after_guide: afterGuide.json(),
          forget_result: body,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:forget-rehydrate-guide"],
        },
      },
    });
    assert.equal(measure.statusCode, 200);
    const measureBody = measure.json();
    assert.equal(measureBody.measurement_input.source, "product_trace");
    assert.equal(measureBody.measurement_input.aionis.forgetting.archivedMemoryRehydratedOnDemand, 1);
    assert.ok(measureBody.effect_report.evidence.evidence_ids.includes(`forget:${nodeId}`));
  } finally {
    await app.close();
  }
});

test("product forget rehydrates anchor payload through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-rehydrate-payload");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const fixture = await seedProductPayloadAnchor(liteWriteStore);
    const anchorUri = buildAionisUri({
      tenant_id: "default",
      scope: "default",
      type: "procedure",
      id: fixture.anchorNodeId,
    });

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "rehydrate",
        target: "payload",
        anchor_uri: anchorUri,
        mode: "partial",
        include_linked_decisions: true,
        reason: "Need the compact payload behind this workflow anchor.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "rehydrate");
    assert.equal(body.target, "payload");
    assert.equal(body.forget_effect.anchor_uri, anchorUri);
    assert.equal(body.forget_effect.changed_count, 2);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/anchors/rehydrate_payload"]);
    assert.equal(body.result.anchor.id, fixture.anchorNodeId);
    assert.equal(body.result.rehydrated.summary.resolved_nodes, 1);
    assert.equal(body.result.rehydrated.summary.resolved_decisions, 1);
    assert.equal(body.result.rehydrated.nodes[0]?.id, fixture.payloadNodeId);
    assert.equal(body.result.rehydrated.decisions[0]?.decision_id, fixture.decisionId);
  } finally {
    await app.close();
  }
});

test("product forget suppresses and unsuppresses pattern anchors through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-pattern-suppress");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });
    const fixture = await seedProductPatternAnchor(liteWriteStore);
    const until = new Date(Date.now() + 60_000).toISOString();

    const suppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "suppress",
        target: "pattern",
        anchor_id: fixture.anchorId,
        mode: "shadow_learn",
        until,
        reason: "The pattern should be inspected before reuse.",
      },
    });

    assert.equal(suppress.statusCode, 200, suppress.payload);
    const suppressBody = suppress.json();
    assert.equal(suppressBody.contract_version, "aionis_forget_result_v1");
    assert.equal(suppressBody.operation, "suppress");
    assert.equal(suppressBody.target, "pattern");
    assert.equal(suppressBody.forget_effect.changed_count, 1);
    assert.equal(suppressBody.forget_effect.anchor_kind, "pattern");
    assert.equal(suppressBody.forget_effect.anchor_id, fixture.anchorId);
    assert.deepEqual(suppressBody.source_map.routes_used, ["/v1/memory/anchors/suppress"]);
    assert.equal(suppressBody.result.anchor_kind, "pattern");
    assert.equal(suppressBody.result.node_type, "concept");
    assert.equal(suppressBody.result.operator_override.suppressed, true);
    assert.equal(suppressBody.result.operator_override.mode, "shadow_learn");

    const suppressedRows = await liteWriteStore.findNodes({
      scope: "default",
      id: fixture.anchorId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(suppressedRows.rows[0]?.slots.operator_override_v1.suppressed, true);

    const unsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "unsuppress",
        target: "pattern",
        anchor_id: fixture.anchorId,
        reason: "The pattern was reviewed and can return to normal guidance.",
      },
    });

    assert.equal(unsuppress.statusCode, 200);
    const unsuppressBody = unsuppress.json();
    assert.equal(unsuppressBody.contract_version, "aionis_forget_result_v1");
    assert.equal(unsuppressBody.operation, "unsuppress");
    assert.equal(unsuppressBody.target, "pattern");
    assert.equal(unsuppressBody.forget_effect.changed_count, 1);
    assert.equal(unsuppressBody.forget_effect.anchor_kind, "pattern");
    assert.deepEqual(unsuppressBody.source_map.routes_used, ["/v1/memory/anchors/unsuppress"]);
    assert.equal(unsuppressBody.result.anchor_kind, "pattern");
    assert.equal(unsuppressBody.result.node_type, "concept");
    assert.equal(unsuppressBody.result.operator_override.suppressed, false);
    assert.equal(unsuppressBody.result.operator_override.last_action, "unsuppress");

    const unsuppressedRows = await liteWriteStore.findNodes({
      scope: "default",
      id: fixture.anchorId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(unsuppressedRows.rows[0]?.slots.operator_override_v1.suppressed, false);
  } finally {
    await app.close();
  }
});

test("product forget suppresses workflow anchors from product guidance", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-workflow-suppress");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "private",
        memory: {
          client_id: "workflow:forget-suppression",
          type: "procedure",
          memory_kind: "execution_workflow",
          title: "Recover target file before broad discovery",
          text_summary: "Read the known target file first, verify it still matches the task, then avoid repeated broad search.",
          task_signature: "continuity-product-loop",
          workflow_signature: "recover-target-file-first",
          target_files: ["src/current-target.ts"],
          next_action: "Read src/current-target.ts before broad discovery.",
          tool_set: ["read", "edit", "test"],
          confidence: 0.9,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const observeBody = observe.json();
    const workflowId = observeBody.memory_write.nodes[0].id;
    assert.ok(workflowId);

    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200);
    assert.ok(
      beforeGuide.json().guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
    );

    const suppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "suppress",
        anchor_id: workflowId,
        mode: "shadow_learn",
        reason: "This workflow is contested and must not be reused until reviewed.",
      },
    });
    assert.equal(suppress.statusCode, 200, suppress.payload);
    const suppressBody = suppress.json();
    assert.equal(suppressBody.result.anchor_kind, "workflow");
    assert.equal(suppressBody.result.node_type, "procedure");
    assert.equal(suppressBody.result.operator_override.suppressed, true);
    assert.equal(suppressBody.forget_effect.anchor_kind, "workflow");
    assert.deepEqual(suppressBody.source_map.routes_used, ["/v1/memory/anchors/suppress"]);

    const suppressedGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(suppressedGuide.statusCode, 200);
    const suppressedGuideBody = suppressedGuide.json();
    assert.equal(
      suppressedGuideBody.guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
      false,
      JSON.stringify(suppressedGuideBody.guide_packet.guidance.workflow_candidates),
    );
    assert.equal(
      suppressedGuideBody.agent_context.evidence_refs.workflow_ids.includes(workflowId),
      false,
    );

    const unsuppress = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "unsuppress",
        anchor_id: workflowId,
        reason: "The contested workflow was reviewed and can be considered again.",
      },
    });
    assert.equal(unsuppress.statusCode, 200);
    const unsuppressBody = unsuppress.json();
    assert.equal(unsuppressBody.result.anchor_kind, "workflow");
    assert.equal(unsuppressBody.result.operator_override.suppressed, false);
    assert.deepEqual(unsuppressBody.source_map.routes_used, ["/v1/memory/anchors/unsuppress"]);

    const restoredGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover target file before broad discovery",
        consumer_agent_id: "local-user",
        tool_candidates: ["read", "edit", "test"],
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(restoredGuide.statusCode, 200);
    assert.ok(
      restoredGuide.json().guide_packet.guidance.workflow_candidates.some(
        (entry: Record<string, unknown>) => entry.workflow_id === workflowId,
      ),
    );
  } finally {
    await app.close();
  }
});

test("product forget records activation feedback through the product facade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("forget-activate-memory");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "Use compact product status reports when the user asks for progress.",
        memory: {
          client_id: "memory:product-forget-activate",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Product status style",
          text_summary: "Use compact product status reports when the user asks for progress.",
          confidence: 0.8,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const forget = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:product-forget-activate",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        activate: true,
        reason: "The recalled style memory was reused correctly in the current run.",
      },
    });

    assert.equal(forget.statusCode, 200);
    const body = forget.json();
    assert.equal(body.contract_version, "aionis_forget_result_v1");
    assert.equal(body.operation, "activate");
    assert.equal(body.target, "memory");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, false);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/nodes/activate"]);
    assert.equal(body.result.activated.updated_nodes, 1);
    assert.equal(body.result.activated.outcome, "positive");
    assert.equal(body.result.activated.activate, true);
    assert.equal(body.forget_effect.guide_trace, undefined);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(typeof rows[0]?.slots.last_activated_at, "string");

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "compact product status reports",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200, afterGuide.body);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: afterGuide.json(),
          after_guide: afterGuide.json(),
          forget_result: body,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:no-guide-trace-activation"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const trace = measure.json().memory_decision_trace;
    assert.equal(trace.feedback_attribution.present, true);
    assert.equal(trace.feedback_attribution.guide_trace_id, null);
    assert.equal(trace.feedback_attribution.unused_exposure_observation.present, false);
    assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.present, true);
    assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.mode, "read_only_measure");
    assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.authority_mutation, false);
    assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.positive_attributed_memory_ids, [nodeId]);
    assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.weak_counter_signal_memory_ids, []);
    assert.ok(trace.feedback_attribution.sparse_feedback_signal_summary.read_only_signal_memory_ids.includes(nodeId));
  } finally {
    await app.close();
  }
});

test("product guide feedback loop requires repeated weak negative attribution before downgrade", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-repeated-negative-attribution");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_SPARSE_FEEDBACK_MARKER Prefer concise release notes for status updates.",
        memory: {
          client_id: "memory:guide-feedback-negative-attribution",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Sparse feedback status style",
          text_summary: "AIONIS_SPARSE_FEEDBACK_MARKER Prefer concise release notes for status updates.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const unusedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_SPARSE_FEEDBACK_MARKER Related but unused memory for status updates.",
        memory: {
          client_id: "memory:guide-feedback-unused-attribution",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Unused sparse feedback memory",
          text_summary: "AIONIS_SPARSE_FEEDBACK_MARKER Related but unused memory for status updates.",
          confidence: 0.81,
        },
      },
    });
    assert.equal(unusedObserve.statusCode, 200, unusedObserve.body);
    const unusedNodeId = unusedObserve.json().memory_write.nodes[0].id;

    const beforeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(beforeGuide.statusCode, 200, beforeGuide.body);
    const beforeGuideBody = beforeGuide.json();
    const beforeMemory = beforeGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(beforeMemory);
    assert.equal(beforeMemory.lifecycle_state, "active");
    assert.equal(beforeMemory.authority, "advisory");
    assert.ok(
      beforeGuideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_SPARSE_FEEDBACK_MARKER")
      ),
    );
    assert.equal(beforeGuideBody.agent_context.memory_ids.includes(nodeId), true);
    assert.equal(beforeGuideBody.agent_context.use_now_memory_ids.includes(nodeId), true);
    assert.equal(beforeGuideBody.agent_context.inspect_before_use_memory_ids.includes(nodeId), false);
    assert.equal(beforeGuideBody.agent_context.memory_ids.includes(unusedNodeId), true);
    assert.equal(beforeGuideBody.agent_context.use_now_memory_ids.includes(unusedNodeId), true);

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-negative-attribution-1",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The Agent used this recalled memory, but the resulting status update was rejected.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    const feedbackBody = feedback.json();
    assert.equal(feedbackBody.result.activated.outcome, "negative");
    assert.equal(feedbackBody.forget_effect.changed_count, 1);
    assert.deepEqual(feedbackBody.forget_effect.affected_memory_ids, [nodeId]);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_negative, 1);
    assert.equal(rows[0]?.slots.weak_counter_signal_count, 1);
    assert.equal(rows[0]?.slots.strong_counter_signal_count, 0);
    assert.equal(rows[0]?.slots.last_feedback_outcome, "negative");
    assert.equal(rows[0]?.slots.last_feedback_run_id, "run:guide-feedback-negative-attribution-1");
    assert.equal(rows[0]?.slots.last_feedback_used_surface, "use_now");

    const unusedAfterFeedback = await liteWriteStore.findNodes({
      scope: "default",
      id: unusedNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(unusedAfterFeedback.rows[0]?.slots.feedback_negative, undefined);
    assert.equal(unusedAfterFeedback.rows[0]?.slots.weak_counter_signal_count, undefined);

    const afterFirstWeakGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterFirstWeakGuide.statusCode, 200, afterFirstWeakGuide.body);
    const afterFirstWeakGuideBody = afterFirstWeakGuide.json();
    const afterFirstWeakMemory = afterFirstWeakGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(afterFirstWeakMemory);
    assert.equal(afterFirstWeakMemory.lifecycle_state, "active");
    assert.equal(afterFirstWeakMemory.authority, "advisory");
    assert.ok(
      afterFirstWeakGuideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_SPARSE_FEEDBACK_MARKER")
      ),
    );
    assert.equal(afterFirstWeakGuideBody.agent_context.use_now_memory_ids.includes(nodeId), true);
    assert.equal(afterFirstWeakGuideBody.agent_context.inspect_before_use_memory_ids.includes(nodeId), false);

    const firstWeakMeasure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuideBody,
          after_guide: afterFirstWeakGuideBody,
          forget_result: feedbackBody,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:guide-feedback-first-weak-negative-attribution"],
        },
      },
    });
    assert.equal(firstWeakMeasure.statusCode, 200, firstWeakMeasure.body);
    const firstWeakTrace = firstWeakMeasure.json().memory_decision_trace;
    assert.equal(firstWeakTrace.feedback_attribution.present, true);
    assert.equal(firstWeakTrace.feedback_attribution.run_id, "run:guide-feedback-negative-attribution-1");
    assert.deepEqual(firstWeakTrace.feedback_attribution.affected_memory_ids, [nodeId]);
    assert.deepEqual(firstWeakTrace.feedback_attribution.attributed_memory_ids, [nodeId]);
    assert.ok(firstWeakTrace.feedback_attribution.unattributed_recalled_memory_ids.includes(unusedNodeId));
    assert.deepEqual(firstWeakTrace.feedback_attribution.threshold_met_memory_ids, []);
    assert.deepEqual(firstWeakTrace.feedback_attribution.sparse_feedback_signal_summary.weak_counter_signal_memory_ids, [nodeId]);
    assert.equal(firstWeakTrace.feedback_attribution.sparse_feedback_signal_summary.authority_mutation, false);
    const firstWeakDecision = firstWeakTrace.memory_decisions.find((entry: Record<string, unknown>) => entry.memory_id === nodeId);
    assert.equal(firstWeakDecision.feedback_detail.threshold_state, "weak_below_threshold");
    assert.equal(firstWeakDecision.feedback_detail.threshold_met, false);
    assert.equal(firstWeakDecision.agent_surface, "use_now");

    const secondFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-negative-attribution-2",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The Agent used the same memory again and the run failed again.",
      },
    });
    assert.equal(secondFeedback.statusCode, 200, secondFeedback.body);

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_SPARSE_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200, afterGuide.body);
    const afterGuideBody = afterGuide.json();
    const afterMemory = afterGuideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(afterMemory);
    assert.equal(afterMemory.lifecycle_state, "contested");
    assert.equal(afterMemory.authority, "candidate");
    assert.ok(
      afterGuideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes("Sparse feedback status style") || entry.includes(nodeId)
      ),
    );
    assert.equal(afterGuideBody.agent_context.use_now_memory_ids.includes(nodeId), false);
    assert.equal(afterGuideBody.agent_context.inspect_before_use_memory_ids.includes(nodeId), true);
    assert.equal(afterGuideBody.agent_context.use_now_memory_ids.includes(unusedNodeId), true);
    assert.equal(afterGuideBody.agent_context.inspect_before_use_memory_ids.includes(unusedNodeId), false);
    assert.equal(afterGuideBody.agent_context.recommended_posture, "inspect_before_use");
    assert.equal(afterGuideBody.agent_context.authority, "advisory");
    assert.equal(
      afterGuideBody.agent_context.risk.reasons.includes("candidate_or_contested_memory_kept_out_of_use_now"),
      true,
    );

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: beforeGuideBody,
          after_guide: afterGuideBody,
          forget_result: secondFeedback.json(),
          sufficient_evidence: true,
          evidence_ids: ["product_trace:guide-feedback-repeated-negative-attribution"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const measureBody = measure.json();
    assert.equal(measureBody.measurement_input.source, "product_trace");
    assert.equal(measureBody.memory_decision_trace.summary.inspect_before_use_count > 0, true);
    assert.equal(measureBody.memory_decision_trace.feedback_attribution.present, true);
    assert.equal(measureBody.memory_decision_trace.feedback_attribution.run_id, "run:guide-feedback-negative-attribution-2");
    assert.deepEqual(measureBody.memory_decision_trace.feedback_attribution.affected_memory_ids, [nodeId]);
    assert.deepEqual(measureBody.memory_decision_trace.feedback_attribution.attributed_memory_ids, [nodeId]);
    assert.ok(measureBody.memory_decision_trace.feedback_attribution.unattributed_recalled_memory_ids.includes(unusedNodeId));
    assert.deepEqual(measureBody.memory_decision_trace.feedback_attribution.weak_counter_signal_memory_ids, [nodeId]);
    assert.deepEqual(measureBody.memory_decision_trace.feedback_attribution.threshold_met_memory_ids, [nodeId]);
    assert.deepEqual(measureBody.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.weak_counter_signal_memory_ids, [nodeId]);
    assert.equal(measureBody.memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary.authority_mutation, false);
    const repeatedWeakDecision = measureBody.memory_decision_trace.memory_decisions.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId
    );
    assert.equal(repeatedWeakDecision.feedback_detail.threshold_state, "repeated_weak_threshold_met");
    assert.equal(repeatedWeakDecision.feedback_detail.weak_counter_signal_count, 2);
    assert.equal(repeatedWeakDecision.feedback_detail.threshold_met, true);
    assert.equal(repeatedWeakDecision.agent_surface, "inspect_before_use");
    const unusedDecision = measureBody.memory_decision_trace.memory_decisions.find((entry: Record<string, unknown>) =>
      entry.memory_id === unusedNodeId
    );
    assert.equal(unusedDecision.feedback_detail, null);
    assert.equal(measureBody.memory_decision_audit.counters.feedback_attribution_count, 1);
    assert.equal(measureBody.memory_decision_audit.counters.feedback_threshold_met_count, 1);
    assert.equal(measureBody.memory_decision_audit.feedback_signal_review.present, true);
    assert.equal(measureBody.memory_decision_audit.feedback_signal_review.authority_mutation, false);
    assert.deepEqual(
      measureBody.memory_decision_audit.feedback_signal_review.weak_counter_signal_memories.map((entry: Record<string, unknown>) => entry.memory_id),
      [nodeId],
    );
    assert.deepEqual(measureBody.memory_decision_audit.feedback_signal_review.read_only_signal_memory_ids, [nodeId]);
    assert.equal(measureBody.effect_report.feedback_signal_summary.present, true);
    assert.equal(measureBody.effect_report.feedback_signal_summary.source, "memory_decision_audit");
    assert.equal(measureBody.effect_report.feedback_signal_summary.authority_mutation, false);
    assert.deepEqual(measureBody.effect_report.feedback_signal_summary.weak_counter_signal_memory_ids, [nodeId]);
    assert.deepEqual(measureBody.effect_report.feedback_signal_summary.read_only_signal_memory_ids, [nodeId]);
    assert.equal(
      measureBody.memory_decision_audit.claims.some((claim: Record<string, unknown>) =>
        claim.claim === "feedback_attribution_visible" && claim.status === "pass"
      ),
      true,
    );
  } finally {
    await app.close();
  }
});

test("product guide trace attribution resolves used memories from persisted exposure ledger", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-trace-exposure-feedback-attribution");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const usedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_GUIDE_TRACE_MARKER Use concise incident summaries for customer updates.",
        memory: {
          client_id: "memory:guide-trace-used-feedback",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Guide trace used memory",
          text_summary: "AIONIS_GUIDE_TRACE_MARKER Use concise incident summaries for customer updates.",
          confidence: 0.84,
        },
      },
    });
    assert.equal(usedObserve.statusCode, 200, usedObserve.body);
    const usedNodeId = usedObserve.json().memory_write.nodes[0].id;

    const unusedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_GUIDE_TRACE_MARKER Related historical style note that was not used.",
        memory: {
          client_id: "memory:guide-trace-unused-feedback",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Guide trace unused memory",
          text_summary: "AIONIS_GUIDE_TRACE_MARKER Related historical style note that was not used.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(unusedObserve.statusCode, 200, unusedObserve.body);
    const unusedNodeId = unusedObserve.json().memory_write.nodes[0].id;

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_GUIDE_TRACE_MARKER customer update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    assert.equal(typeof guideBody.guide_trace_id, "string");
    assert.ok(guideBody.agent_context.memory_ids.includes(usedNodeId));
    assert.ok(guideBody.agent_context.memory_ids.includes(unusedNodeId));

    const ledgerRows = await liteWriteStore.findNodes({
      scope: "default",
      clientId: guideBody.guide_trace_id,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(ledgerRows.rows.length, 1);
    const ledger = ledgerRows.rows[0]?.slots.guide_exposure_v1;
    assert.equal(ledger.contract_version, "aionis_guide_exposure_v1");
    assert.equal(ledger.guide_trace_id, guideBody.guide_trace_id);
    assert.ok(ledger.memory_ids.includes(usedNodeId));
    assert.ok(ledger.memory_ids.includes(unusedNodeId));
    assert.equal(ledgerRows.rows[0]?.embedding_status, "failed");

    const repeatedGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_GUIDE_TRACE_MARKER customer update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(repeatedGuide.statusCode, 200, repeatedGuide.body);
    const repeatedGuideBody = repeatedGuide.json();
    assert.notEqual(repeatedGuideBody.guide_trace_id, guideBody.guide_trace_id);
    assert.ok(repeatedGuideBody.agent_context.memory_ids.includes(unusedNodeId));

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: guideBody.guide_trace_id,
        used_memory_ids: [usedNodeId],
        run_id: "run:guide-trace-feedback-attribution",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The Agent used one exposed memory, but the resulting customer update was rejected.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);
    const feedbackBody = feedback.json();
    assert.deepEqual(feedbackBody.source_map.routes_used, ["/v1/memory/find", "/v1/memory/nodes/activate"]);
    assert.ok(feedbackBody.source_map.internal_surfaces_used.includes("guide_exposure_ledger"));
    assert.deepEqual(feedbackBody.forget_effect.affected_memory_ids, [usedNodeId]);
    assert.equal(feedbackBody.forget_effect.guide_trace.guide_trace_id, guideBody.guide_trace_id);
    assert.equal(feedbackBody.forget_effect.guide_trace.exposed_memory_count, guideBody.agent_context.memory_ids.length);
    assert.equal(feedbackBody.forget_effect.guide_trace.attributed_memory_count, 1);
    assert.equal(
      feedbackBody.forget_effect.guide_trace.unattributed_recalled_memory_count,
      guideBody.agent_context.memory_ids.length - 1,
    );
    assert.deepEqual(feedbackBody.forget_effect.guide_trace.attributed_memory_ids, [usedNodeId]);
    assert.ok(feedbackBody.forget_effect.guide_trace.exposed_memory_ids.includes(unusedNodeId));
    assert.ok(feedbackBody.forget_effect.guide_trace.unattributed_recalled_memory_ids.includes(unusedNodeId));
    const unattributedSurfaceIds = [
      ...feedbackBody.forget_effect.guide_trace.unattributed_use_now_memory_ids,
      ...feedbackBody.forget_effect.guide_trace.unattributed_inspect_before_use_memory_ids,
      ...feedbackBody.forget_effect.guide_trace.unattributed_do_not_use_memory_ids,
      ...feedbackBody.forget_effect.guide_trace.unattributed_rehydrate_memory_ids,
    ];
    assert.ok(unattributedSurfaceIds.includes(unusedNodeId));
    assert.equal(unattributedSurfaceIds.includes(usedNodeId), false);
    const unusedExposure = feedbackBody.forget_effect.guide_trace.unused_exposure_observation;
    assert.equal(unusedExposure.contract_version, "aionis_unused_exposure_observation_v1");
    assert.equal(unusedExposure.mode, "read_only_measure");
    assert.equal(unusedExposure.exposure_threshold, 2);
    assert.equal(unusedExposure.guide_trace_count, 2);
    assert.ok(unusedExposure.repeated_unattributed_memory_ids.includes(unusedNodeId));
    assert.ok(unusedExposure.repeated_unattributed_without_positive_memory_ids.includes(unusedNodeId));
    assert.equal(unusedExposure.repeated_unattributed_memory_ids.includes(usedNodeId), false);
    const unusedExposureStat = unusedExposure.memory_stats.find((entry: Record<string, unknown>) => entry.memory_id === unusedNodeId);
    assert.ok(unusedExposureStat);
    assert.equal(unusedExposureStat.current_unattributed, true);
    assert.equal(unusedExposureStat.exposure_count, 2);
    assert.equal(unusedExposureStat.positive_attributed_use_count, 0);
    assert.equal(unusedExposureStat.repeated_without_positive_attribution, true);
    assert.equal(feedbackBody.forget_effect.guide_trace.feedback_learning_control.contract_version, "aionis_feedback_learning_control_persistence_v1");
    assert.equal(feedbackBody.forget_effect.guide_trace.feedback_learning_control.mode, "inspect_before_use_persistence");
    assert.deepEqual(feedbackBody.forget_effect.guide_trace.feedback_learning_control.changed_memory_ids, [unusedNodeId]);

    const usedAfterFeedback = await liteWriteStore.findNodes({
      scope: "default",
      id: usedNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(usedAfterFeedback.rows[0]?.slots.feedback_negative, 1);
    assert.equal(usedAfterFeedback.rows[0]?.slots.weak_counter_signal_count, 1);

    const unusedAfterFeedback = await liteWriteStore.findNodes({
      scope: "default",
      id: unusedNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(unusedAfterFeedback.rows[0]?.slots.feedback_negative, undefined);
    assert.equal(unusedAfterFeedback.rows[0]?.slots.unused_exposure_observation, undefined);
    assert.equal(unusedAfterFeedback.rows[0]?.slots.repeated_unattributed_memory_ids, undefined);
    assert.equal(unusedAfterFeedback.rows[0]?.slots.feedback_learning_control_posture, "inspect_before_use");
    assert.equal(unusedAfterFeedback.rows[0]?.slots.feedback_learning_control_source, "repeated_unused_without_positive_attribution");

    const afterGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_GUIDE_TRACE_MARKER customer update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterGuide.statusCode, 200, afterGuide.body);
    const afterGuideBody = afterGuide.json();

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: guideBody,
          after_guide: afterGuideBody,
          forget_result: feedbackBody,
          sufficient_evidence: true,
          evidence_ids: ["product_trace:guide-trace-feedback-attribution"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const trace = measure.json().memory_decision_trace;
    assert.equal(trace.feedback_attribution.present, true);
    assert.equal(trace.feedback_attribution.guide_trace_id, guideBody.guide_trace_id);
    assert.equal(trace.feedback_attribution.exposed_memory_count, guideBody.agent_context.memory_ids.length);
    assert.equal(trace.feedback_attribution.attributed_memory_count, 1);
    assert.equal(trace.feedback_attribution.unattributed_recalled_memory_count, guideBody.agent_context.memory_ids.length - 1);
    assert.deepEqual(trace.feedback_attribution.attributed_memory_ids, [usedNodeId]);
    assert.ok(trace.feedback_attribution.unattributed_recalled_memory_ids.includes(unusedNodeId));
    assert.ok(trace.feedback_attribution.unattributed_use_now_memory_ids.includes(unusedNodeId)
      || trace.feedback_attribution.unattributed_inspect_before_use_memory_ids.includes(unusedNodeId)
      || trace.feedback_attribution.unattributed_do_not_use_memory_ids.includes(unusedNodeId)
      || trace.feedback_attribution.unattributed_rehydrate_memory_ids.includes(unusedNodeId));
    assert.equal(trace.feedback_attribution.unused_exposure_observation.present, true);
    assert.ok(trace.feedback_attribution.unused_exposure_observation.repeated_unattributed_memory_ids.includes(unusedNodeId));
    assert.ok(
      trace.feedback_attribution.unused_exposure_observation.repeated_unattributed_without_positive_memory_ids.includes(unusedNodeId),
    );
    assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.present, true);
    assert.equal(trace.feedback_attribution.sparse_feedback_signal_summary.authority_mutation, false);
    assert.deepEqual(trace.feedback_attribution.sparse_feedback_signal_summary.weak_counter_signal_memory_ids, [usedNodeId]);
    assert.ok(trace.feedback_attribution.sparse_feedback_signal_summary.repeated_unattributed_memory_ids.includes(unusedNodeId));
    assert.ok(
      trace.feedback_attribution.sparse_feedback_signal_summary.repeated_unattributed_without_positive_memory_ids.includes(unusedNodeId),
    );
    assert.ok(trace.feedback_attribution.sparse_feedback_signal_summary.read_only_signal_memory_ids.includes(usedNodeId));
    assert.ok(trace.feedback_attribution.sparse_feedback_signal_summary.read_only_signal_memory_ids.includes(unusedNodeId));
    const usedDecision = trace.memory_decisions.find((entry: Record<string, unknown>) => entry.memory_id === usedNodeId);
    assert.equal(usedDecision.feedback_detail.threshold_state, "weak_below_threshold");
    const unusedDecision = trace.memory_decisions.find((entry: Record<string, unknown>) => entry.memory_id === unusedNodeId);
    assert.equal(unusedDecision.agent_surface, "inspect_before_use");
    assert.equal(unusedDecision.feedback_detail, null);
  } finally {
    await app.close();
  }
});

test("product unused exposure observation respects scope, consumer, and positive attribution boundaries", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("unused-exposure-boundaries");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const positiveObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "shared",
        input_text: "AIONIS_UNUSED_BOUNDARY_MARKER Keep escalation summaries short and evidence-backed.",
        memory: {
          client_id: "memory:unused-boundary-positive",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Positive attributed memory",
          text_summary: "AIONIS_UNUSED_BOUNDARY_MARKER Keep escalation summaries short and evidence-backed.",
          confidence: 0.87,
        },
      },
    });
    assert.equal(positiveObserve.statusCode, 200, positiveObserve.body);
    const positiveNodeId = positiveObserve.json().memory_write.nodes[0].id;

    const usedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        memory_lane: "shared",
        input_text: "AIONIS_UNUSED_BOUNDARY_MARKER Use customer-facing severity labels.",
        memory: {
          client_id: "memory:unused-boundary-used",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Current used memory",
          text_summary: "AIONIS_UNUSED_BOUNDARY_MARKER Use customer-facing severity labels.",
          confidence: 0.85,
        },
      },
    });
    assert.equal(usedObserve.statusCode, 200, usedObserve.body);
    const usedNodeId = usedObserve.json().memory_write.nodes[0].id;

    const otherScopeObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "other-scope",
        auto_embed: true,
        memory_lane: "shared",
        input_text: "AIONIS_UNUSED_BOUNDARY_MARKER Other scope memory should not affect default scope.",
        memory: {
          client_id: "memory:unused-boundary-other-scope",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Other scope memory",
          text_summary: "AIONIS_UNUSED_BOUNDARY_MARKER Other scope memory should not affect default scope.",
          confidence: 0.86,
        },
      },
    });
    assert.equal(otherScopeObserve.statusCode, 200, otherScopeObserve.body);

    const otherScopeGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "other-scope",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(otherScopeGuide.statusCode, 200, otherScopeGuide.body);

    const otherConsumerGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "other-agent",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(otherConsumerGuide.statusCode, 200, otherConsumerGuide.body);
    assert.ok(otherConsumerGuide.json().agent_context.memory_ids.includes(positiveNodeId));

    const otherTeamGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "local-user",
        consumer_team_id: "other-team",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(otherTeamGuide.statusCode, 200, otherTeamGuide.body);
    assert.ok(otherTeamGuide.json().agent_context.memory_ids.includes(positiveNodeId));

    const positiveGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(positiveGuide.statusCode, 200, positiveGuide.body);
    const positiveGuideBody = positiveGuide.json();
    assert.ok(positiveGuideBody.agent_context.memory_ids.includes(positiveNodeId));
    assert.ok(positiveGuideBody.agent_context.memory_ids.includes(usedNodeId));

    const positiveFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: positiveGuideBody.guide_trace_id,
        used_memory_ids: [positiveNodeId],
        run_id: "run:unused-boundary-positive",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        activate: true,
        reason: "The host used this exposed memory successfully.",
      },
    });
    assert.equal(positiveFeedback.statusCode, 200, positiveFeedback.body);

    const currentGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(currentGuide.statusCode, 200, currentGuide.body);
    const currentGuideBody = currentGuide.json();
    assert.ok(currentGuideBody.agent_context.memory_ids.includes(positiveNodeId));
    assert.ok(currentGuideBody.agent_context.memory_ids.includes(usedNodeId));

    const currentFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: currentGuideBody.guide_trace_id,
        used_memory_ids: [usedNodeId],
        run_id: "run:unused-boundary-current",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "not_run",
        tool_status: "unknown",
        activate: true,
        reason: "The host used a different exposed memory in this run.",
      },
    });
    assert.equal(currentFeedback.statusCode, 200, currentFeedback.body);
    const observation = currentFeedback.json().forget_effect.guide_trace.unused_exposure_observation;
    assert.equal(observation.mode, "read_only_measure");
    assert.equal(observation.guide_trace_count, 2);
    assert.ok(observation.repeated_unattributed_memory_ids.includes(positiveNodeId));
    assert.equal(observation.repeated_unattributed_memory_ids.includes(usedNodeId), false);
    assert.equal(observation.repeated_unattributed_without_positive_memory_ids.includes(positiveNodeId), false);
    const positiveStat = observation.memory_stats.find((entry: Record<string, unknown>) => entry.memory_id === positiveNodeId);
    assert.ok(positiveStat);
    assert.equal(positiveStat.current_unattributed, true);
    assert.equal(positiveStat.exposure_count, 2);
    assert.equal(positiveStat.positive_attributed_use_count, 1);
    assert.equal(positiveStat.repeated_without_positive_attribution, false);
    const boundaryObservation = currentFeedback.json().forget_effect.guide_trace.unused_exposure_observation;
    assert.equal(boundaryObservation.repeated_unattributed_without_positive_memory_ids.includes(positiveNodeId), false);

    const afterCurrentGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_UNUSED_BOUNDARY_MARKER escalation summary",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(afterCurrentGuide.statusCode, 200, afterCurrentGuide.body);
    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: currentGuideBody,
          after_guide: afterCurrentGuide.json(),
          forget_result: currentFeedback.json(),
          sufficient_evidence: true,
          evidence_ids: ["product_trace:unused-exposure-positive-attribution-boundary"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const candidateLearningControl = measure.json().memory_decision_trace.feedback_attribution.sparse_feedback_signal_summary
      .candidate_learning_control_summary;
    assert.equal(candidateLearningControl.authority_mutation, false);
    assert.equal(candidateLearningControl.candidate_inspect_before_use_memory_ids.includes(positiveNodeId), false);
    assert.ok(candidateLearningControl.blocked_by_positive_attribution_memory_ids.includes(positiveNodeId));

    const positiveAfterCurrent = await liteWriteStore.findNodes({
      scope: "default",
      id: positiveNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(positiveAfterCurrent.rows[0]?.slots.positive_attributed_use_count, 1);
    assert.equal(positiveAfterCurrent.rows[0]?.slots.feedback_negative, 0);
    assert.equal(positiveAfterCurrent.rows[0]?.slots.unused_exposure_observation, undefined);
  } finally {
    await app.close();
  }
});

test("product guide trace attribution rejects memories not exposed by that guide", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-trace-rejects-unexposed-feedback");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const exposedObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_GUIDE_TRACE_REJECT_MARKER Use brief support summaries.",
        memory: {
          client_id: "memory:guide-trace-exposed-before-reject",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Guide trace exposed memory",
          text_summary: "AIONIS_GUIDE_TRACE_REJECT_MARKER Use brief support summaries.",
          confidence: 0.84,
        },
      },
    });
    assert.equal(exposedObserve.statusCode, 200, exposedObserve.body);

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_GUIDE_TRACE_REJECT_MARKER support summary style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    assert.equal(typeof guideBody.guide_trace_id, "string");

    const lateObserve = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_GUIDE_TRACE_REJECT_MARKER This memory was written after the guide exposure.",
        memory: {
          client_id: "memory:guide-trace-unexposed-feedback-target",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Guide trace unexposed memory",
          text_summary: "AIONIS_GUIDE_TRACE_REJECT_MARKER This memory was written after the guide exposure.",
          confidence: 0.9,
        },
      },
    });
    assert.equal(lateObserve.statusCode, 200, lateObserve.body);
    const lateNodeId = lateObserve.json().memory_write.nodes[0].id;
    assert.equal(guideBody.agent_context.memory_ids.includes(lateNodeId), false);

    const rejectedFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        guide_trace_id: guideBody.guide_trace_id,
        used_memory_ids: [lateNodeId],
        run_id: "run:guide-trace-rejects-unexposed-feedback",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        activate: true,
        reason: "This feedback tries to blame a memory that was not exposed by the referenced guide.",
      },
    });
    assert.equal(rejectedFeedback.statusCode, 400, rejectedFeedback.body);
    const rejectedBody = rejectedFeedback.json();
    assert.equal(rejectedBody.error, "guide_trace_used_memory_not_exposed");
    assert.equal(rejectedBody.guide_trace_id, guideBody.guide_trace_id);
    assert.deepEqual(rejectedBody.not_exposed_memory_ids, [lateNodeId]);

    const lateAfterRejectedFeedback = await liteWriteStore.findNodes({
      scope: "default",
      id: lateNodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(lateAfterRejectedFeedback.rows[0]?.slots.feedback_negative, undefined);
    assert.equal(lateAfterRejectedFeedback.rows[0]?.slots.strong_counter_signal_count, undefined);
  } finally {
    await app.close();
  }
});

test("product guide visibility enforces private and team-owned shared boundaries", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-visibility-private-team-shared-boundaries");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    async function observeVisibilityMemory(payload: Record<string, unknown>): Promise<string> {
      const response = await app.inject({
        method: "POST",
        url: "/v1/observe",
        payload: {
          tenant_id: "default",
          scope: "default",
          auto_embed: true,
          ...payload,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const nodeId = response.json().memory_write.nodes[0].id;
      assert.equal(typeof nodeId, "string");
      return nodeId;
    }

    const globalSharedId = await observeVisibilityMemory({
      memory_lane: "shared",
      input_text: "AIONIS_VIS_GLOBAL_SHARED marker visible to all scope consumers.",
      memory: {
        client_id: "memory:visibility-global-shared",
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: "Visibility global shared",
        text_summary: "AIONIS_VIS_GLOBAL_SHARED marker visible to all scope consumers.",
        confidence: 0.88,
      },
    });
    const alphaSharedId = await observeVisibilityMemory({
      memory_lane: "shared",
      owner_team_id: "team-alpha",
      input_text: "AIONIS_VIS_ALPHA_SHARED marker visible only to team alpha.",
      memory: {
        client_id: "memory:visibility-alpha-shared",
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: "Visibility alpha shared",
        text_summary: "AIONIS_VIS_ALPHA_SHARED marker visible only to team alpha.",
        confidence: 0.88,
      },
    });
    const betaSharedId = await observeVisibilityMemory({
      memory_lane: "shared",
      owner_team_id: "team-beta",
      input_text: "AIONIS_VIS_BETA_SHARED marker visible only to team beta.",
      memory: {
        client_id: "memory:visibility-beta-shared",
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: "Visibility beta shared",
        text_summary: "AIONIS_VIS_BETA_SHARED marker visible only to team beta.",
        confidence: 0.88,
      },
    });
    const plannerPrivateId = await observeVisibilityMemory({
      memory_lane: "private",
      owner_agent_id: "planner-agent",
      input_text: "AIONIS_VIS_PLANNER_PRIVATE marker visible only to planner agent.",
      memory: {
        client_id: "memory:visibility-planner-private",
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: "Visibility planner private",
        text_summary: "AIONIS_VIS_PLANNER_PRIVATE marker visible only to planner agent.",
        confidence: 0.88,
      },
    });
    const alphaPrivateId = await observeVisibilityMemory({
      memory_lane: "private",
      owner_team_id: "team-alpha",
      input_text: "AIONIS_VIS_ALPHA_PRIVATE marker visible only to team alpha.",
      memory: {
        client_id: "memory:visibility-alpha-private",
        type: "concept",
        tier: "warm",
        memory_kind: "general_memory",
        title: "Visibility alpha private",
        text_summary: "AIONIS_VIS_ALPHA_PRIVATE marker visible only to team alpha.",
        confidence: 0.88,
      },
    });

    async function guideIds(payload: Record<string, unknown>): Promise<Set<string>> {
      const guide = await app.inject({
        method: "POST",
        url: "/v1/guide",
        payload: {
          tenant_id: "default",
          scope: "default",
          query_text: [
            "AIONIS_VIS_GLOBAL_SHARED",
            "AIONIS_VIS_ALPHA_SHARED",
            "AIONIS_VIS_BETA_SHARED",
            "AIONIS_VIS_PLANNER_PRIVATE",
            "AIONIS_VIS_ALPHA_PRIVATE",
            "visibility boundary",
          ].join(" "),
          limit: 20,
          include_packets: true,
          ...payload,
        },
      });
      assert.equal(guide.statusCode, 200, guide.body);
      return new Set(guide.json().agent_context.memory_ids);
    }

    const alphaReviewerIds = await guideIds({
      consumer_agent_id: "reviewer-alpha",
      consumer_team_id: "team-alpha",
    });
    assert.equal(alphaReviewerIds.has(globalSharedId), true);
    assert.equal(alphaReviewerIds.has(alphaSharedId), true);
    assert.equal(alphaReviewerIds.has(alphaPrivateId), true);
    assert.equal(alphaReviewerIds.has(betaSharedId), false);
    assert.equal(alphaReviewerIds.has(plannerPrivateId), false);

    const betaReviewerIds = await guideIds({
      consumer_agent_id: "reviewer-beta",
      consumer_team_id: "team-beta",
    });
    assert.equal(betaReviewerIds.has(globalSharedId), true);
    assert.equal(betaReviewerIds.has(betaSharedId), true);
    assert.equal(betaReviewerIds.has(alphaSharedId), false);
    assert.equal(betaReviewerIds.has(alphaPrivateId), false);
    assert.equal(betaReviewerIds.has(plannerPrivateId), false);

    const plannerIds = await guideIds({
      consumer_agent_id: "planner-agent",
    });
    assert.equal(plannerIds.has(globalSharedId), true);
    assert.equal(plannerIds.has(plannerPrivateId), true);
    assert.equal(plannerIds.has(alphaSharedId), false);
    assert.equal(plannerIds.has(betaSharedId), false);
    assert.equal(plannerIds.has(alphaPrivateId), false);

    const alphaTraceGuide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: [
          "AIONIS_VIS_GLOBAL_SHARED",
          "AIONIS_VIS_ALPHA_SHARED",
          "AIONIS_VIS_BETA_SHARED",
          "AIONIS_VIS_PLANNER_PRIVATE",
          "AIONIS_VIS_ALPHA_PRIVATE",
          "visibility trace attribution boundary",
        ].join(" "),
        consumer_agent_id: "reviewer-alpha",
        consumer_team_id: "team-alpha",
        limit: 20,
        include_packets: true,
      },
    });
    assert.equal(alphaTraceGuide.statusCode, 200, alphaTraceGuide.body);
    const alphaTraceGuideBody = alphaTraceGuide.json();
    assert.equal(alphaTraceGuideBody.agent_context.memory_ids.includes(betaSharedId), false);
    const rejectedCrossTeamFeedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "reviewer-alpha",
        operation: "activate",
        target: "memory",
        guide_trace_id: alphaTraceGuideBody.guide_trace_id,
        used_memory_ids: [betaSharedId],
        run_id: "run:visibility-cross-team-attribution-reject",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        activate: true,
        reason: "This feedback tries to attribute a beta-team memory that the alpha guide never exposed.",
      },
    });
    assert.equal(rejectedCrossTeamFeedback.statusCode, 400, rejectedCrossTeamFeedback.body);
    assert.equal(rejectedCrossTeamFeedback.json().error, "guide_trace_used_memory_not_exposed");
  } finally {
    await app.close();
  }
});

test("product guide feedback loop downgrades after aligned verifier failure attribution", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-strong-negative-attribution");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "AIONIS_STRONG_FEEDBACK_MARKER Prefer release-note format for status updates.",
        memory: {
          client_id: "memory:guide-feedback-strong-negative-attribution",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Strong feedback status style",
          text_summary: "AIONIS_STRONG_FEEDBACK_MARKER Prefer release-note format for status updates.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200, observe.body);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [nodeId],
        run_id: "run:guide-feedback-strong-negative-attribution",
        outcome: "negative",
        used_surface: "use_now",
        verifier_status: "failed",
        tool_status: "unknown",
        runtime_signal_refs: ["verifier:status-format-failed"],
        activate: true,
        reason: "The Agent used this memory and the verifier failed on the resulting output.",
      },
    });
    assert.equal(feedback.statusCode, 200, feedback.body);

    const { rows } = await liteWriteStore.findNodes({
      scope: "default",
      id: nodeId,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    assert.equal(rows[0]?.slots.feedback_negative, 1);
    assert.equal(rows[0]?.slots.weak_counter_signal_count, 0);
    assert.equal(rows[0]?.slots.strong_counter_signal_count, 1);
    assert.equal(rows[0]?.slots.last_feedback_verifier_status, "failed");

    const guide = await app.inject({
      method: "POST",
      url: "/v1/guide",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "AIONIS_STRONG_FEEDBACK_MARKER status update style",
        consumer_agent_id: "local-user",
        limit: 8,
        include_packets: true,
      },
    });
    assert.equal(guide.statusCode, 200, guide.body);
    const guideBody = guide.json();
    const memory = guideBody.memory_packet.relevant_memories.find((entry: Record<string, unknown>) =>
      entry.memory_id === nodeId,
    );
    assert.ok(memory);
    assert.equal(memory.lifecycle_state, "contested");
    assert.equal(memory.authority, "candidate");
    assert.equal(
      guideBody.agent_context.use_now.some((entry: string) =>
        entry.includes("AIONIS_STRONG_FEEDBACK_MARKER")
      ),
      false,
    );
    assert.ok(
      guideBody.agent_context.inspect_before_use.some((entry: string) =>
        entry.includes("Strong feedback status style") || entry.includes(nodeId)
      ),
    );
    assert.equal(guideBody.agent_context.use_now_memory_ids.includes(nodeId), false);
    assert.equal(guideBody.agent_context.inspect_before_use_memory_ids.includes(nodeId), true);

    const measure = await app.inject({
      method: "POST",
      url: "/v1/measure",
      payload: {
        tenant_id: "default",
        scope: "default",
        product_trace: {
          before_guide: guideBody,
          after_guide: guideBody,
          forget_result: feedback.json(),
          sufficient_evidence: true,
          evidence_ids: ["product_trace:guide-feedback-strong-negative-attribution"],
        },
      },
    });
    assert.equal(measure.statusCode, 200, measure.body);
    const trace = measure.json().memory_decision_trace;
    assert.deepEqual(trace.feedback_attribution.strong_counter_signal_memory_ids, [nodeId]);
    assert.deepEqual(trace.feedback_attribution.threshold_met_memory_ids, [nodeId]);
    const decision = trace.memory_decisions.find((entry: Record<string, unknown>) => entry.memory_id === nodeId);
    assert.equal(decision.feedback_detail.threshold_state, "strong_signal_threshold_met");
    assert.equal(decision.feedback_detail.strong_counter_signal_count, 1);
    assert.equal(decision.feedback_detail.verifier_status, "failed");
    assert.deepEqual(decision.feedback_detail.runtime_signal_refs, ["verifier:status-format-failed"]);
  } finally {
    await app.close();
  }
});

test("product feedback alias records activation without exposing forget operation to callers", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("feedback-alias-activate-memory");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "Use compact product status reports when asked for progress.",
        memory: {
          client_id: "memory:product-feedback-alias",
          type: "concept",
          tier: "warm",
          memory_kind: "general_memory",
          title: "Product status style",
          text_summary: "Use compact product status reports when asked for progress.",
          confidence: 0.8,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const feedback = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: {
        tenant_id: "default",
        scope: "default",
        memory_ids: [nodeId],
        run_id: "run:product-feedback-alias",
        outcome: "positive",
        used_surface: "use_now",
        verifier_status: "passed",
        tool_status: "succeeded",
        reason: "The recalled style memory was reused correctly in the current run.",
      },
    });

    assert.equal(feedback.statusCode, 200, feedback.payload);
    const body = feedback.json();
    assertNoForbiddenProductFields(body);
    assert.equal(body.contract_version, "aionis_feedback_result_v1");
    assert.equal(body.product_action, "feedback");
    assert.equal(body.operation, "activate");
    assert.equal(body.target, "memory");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, false);
    assert.deepEqual(body.forget_effect.affected_memory_ids, [nodeId]);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/nodes/activate"]);
    assert.equal(body.result.activated.updated_nodes, 1);
    assert.equal(body.result.activated.outcome, "positive");
  } finally {
    await app.close();
  }
});

test("product rehydrate alias restores archived memory without exposing forget operation to callers", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("rehydrate-alias-archive");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const observe = await app.inject({
      method: "POST",
      url: "/v1/observe",
      payload: {
        tenant_id: "default",
        scope: "default",
        auto_embed: true,
        input_text: "Archive this workflow until the same continuation returns.",
        memory: {
          client_id: "archive:product-rehydrate-alias",
          type: "procedure",
          tier: "archive",
          memory_kind: "execution_workflow",
          title: "Archived workflow for product rehydrate alias",
          text_summary: "Rehydrate this archived workflow only when the same continuation need returns.",
          confidence: 0.82,
        },
      },
    });
    assert.equal(observe.statusCode, 200);
    const nodeId = observe.json().memory_write.nodes[0].id;

    const rehydrate = await app.inject({
      method: "POST",
      url: "/v1/rehydrate",
      payload: {
        tenant_id: "default",
        scope: "default",
        target: "archive",
        memory_ids: [nodeId],
        target_tier: "hot",
        reason: "The related task returned and needs this archived workflow.",
      },
    });

    assert.equal(rehydrate.statusCode, 200, rehydrate.payload);
    const body = rehydrate.json();
    assertNoForbiddenProductFields(body);
    assert.equal(body.contract_version, "aionis_rehydrate_result_v1");
    assert.equal(body.product_action, "rehydrate");
    assert.equal(body.operation, "rehydrate");
    assert.equal(body.target, "archive");
    assert.equal(body.forget_effect.changed_count, 1);
    assert.equal(body.forget_effect.reversible, true);
    assert.deepEqual(body.forget_effect.affected_memory_ids, [nodeId]);
    assert.deepEqual(body.source_map.routes_used, ["/v1/memory/archive/rehydrate"]);
    assert.equal(body.result.rehydrated.moved_nodes, 1);
  } finally {
    await app.close();
  }
});

test("product forget activate requires run outcome attribution", async () => {
  const app = Fastify();
  const env = liteEnv();
  const guards = requestGuards(env, DeterministicEmbeddingProvider);
  const dbPath = tmpDbPath("guide-feedback-attribution-required");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerFullProductMemoryApp({ app, env, guards, liteWriteStore, liteRecallStore });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [randomUUID()],
        reason: "This activation feedback lacks attribution and outcome.",
      },
    });

    assert.equal(missing.statusCode, 400);
    assert.ok(missing.body.includes("activate requires run_id"));
    assert.ok(missing.body.includes("activate requires outcome"));
    assert.ok(missing.body.includes("activate requires used_surface"));

    const ambiguous = await app.inject({
      method: "POST",
      url: "/v1/forget",
      payload: {
        tenant_id: "default",
        scope: "default",
        operation: "activate",
        target: "memory",
        memory_ids: [randomUUID()],
        run_id: "run:ambiguous-feedback",
        outcome: "negative",
        used_surface: "inspect_before_use",
        reason: "This activation feedback is not directly attributable to used history.",
      },
    });

    assert.equal(ambiguous.statusCode, 400);
    assert.ok(ambiguous.body.includes("non-neutral activation feedback requires use_now or explicit_host_assertion"));
  } finally {
    await app.close();
  }
});
