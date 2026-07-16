import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  PolicyMutationAdjudicationV1Schema,
  PolicyMutationV1Schema,
} from "../../src/kernel/policy-mutation-loop.ts";
import {
  MemoryAnchorV1Schema,
  PatternSuppressResponseSchema,
  PolicyLearningControlApplyResponseSchema,
  PromotionEvidenceLedgerV1Schema,
  ToolsFeedbackResponseSchema,
  ToolsSelectRouteContractSchema,
} from "../../src/memory/schemas.ts";
import { applyPolicyMemoryLearningControlLite } from "../../src/memory/policy-memory.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { buildMaterializationContextFromFeedback } from "../../src/memory/tools-feedback.ts";
import {
  buildToolRuleEvaluationProvenance,
  buildToolRuleEvaluationSource,
  readToolRuleEvaluationProvenance,
  verifyToolRuleEvaluationProvenance,
} from "../../src/memory/tool-rule-evaluation-provenance.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { registerMemoryFeedbackToolRoutes } from "./support/register-memory-feedback-tool-test-routes.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

type TestLearningKernel = ReturnType<typeof registerMemoryFeedbackToolRoutes>;

async function invokeLearningKernel(
  kernel: TestLearningKernel,
  operation: "select" | "feedback",
  payload: unknown,
) {
  const body = operation === "select"
    ? await kernel.selectToolWithLearnedMemory(payload)
    : await kernel.recordToolSelectionFeedback(payload);
  return {
    statusCode: 200,
    body: JSON.stringify(body),
    json: () => body,
  };
}

const TOOLS_SELECT_ROUTE_KEYS = [
  "candidates",
  "decision",
  "execution_kernel",
  "pattern_matches",
  "scope",
  "selection",
  "selection_summary",
  "tenant_id",
  "rules",
].sort();

const TOOLS_SELECT_SELECTION_KEYS = [
  "allowed",
  "candidates",
  "denied",
  "ordered",
  "policy_relaxation",
  "preferred",
  "selected",
].sort();

const TOOLS_SELECT_POLICY_RELAXATION_KEYS = ["applied", "effective_mode", "note", "reason"].sort();

const TOOLS_SELECT_EXECUTION_KERNEL_KEYS = [
  "active_role",
  "candidate_families",
  "control_profile_origin",
  "current_stage",
  "execution_artifacts_count",
  "execution_evidence_count",
  "execution_result_summary_present",
  "execution_state_v1_present",
  "family_aware_ordering_applied",
  "tool_registry_present",
].sort();

const TOOLS_SELECT_RULES_KEYS = [
  "agent_visibility_summary",
  "applied",
  "considered",
  "invalid_then_sample",
  "matched",
  "skipped_invalid_then",
  "tool_conflicts_summary",
].sort();

const TOOLS_SELECT_PATTERN_MATCHES_KEYS = ["anchors", "matched", "preferred_tools", "trusted"].sort();

const TOOLS_SELECT_DECISION_KEYS = [
  "created_at",
  "context_sha256",
  "decision_id",
  "decision_uri",
  "pattern_summary",
  "policy_sha256",
  "rule_evaluation_sha256",
  "run_id",
  "selected_tool",
  "source_rule_ids",
].sort();

const TOOLS_SELECT_PATTERN_SUMMARY_KEYS = [
  "skipped_contested_pattern_affinity_levels",
  "skipped_contested_pattern_anchor_ids",
  "skipped_contested_pattern_tools",
  "skipped_suppressed_pattern_affinity_levels",
  "skipped_suppressed_pattern_anchor_ids",
  "skipped_suppressed_pattern_tools",
  "used_trusted_pattern_affinity_levels",
  "used_trusted_pattern_anchor_ids",
  "used_trusted_pattern_tools",
].sort();

const TOOLS_SELECT_SELECTION_SUMMARY_KEYS = [
  "allowed_count",
  "candidate_count",
  "contested_pattern_count",
  "denied_count",
  "matched_rules",
  "pattern_lifecycle_summary",
  "pattern_maintenance_summary",
  "policy_relaxation_applied",
  "policy_relaxation_reason",
  "preferred_count",
  "provenance_explanation",
  "selected_tool",
  "shadow_selected_tool",
  "skipped_contested_pattern_affinity_levels",
  "skipped_contested_pattern_tools",
  "skipped_suppressed_pattern_affinity_levels",
  "skipped_suppressed_pattern_tools",
  "source_rule_count",
  "summary_version",
  "suppressed_pattern_count",
  "tool_conflicts",
  "trusted_pattern_count",
  "used_trusted_pattern_affinity_levels",
  "used_trusted_pattern_tools",
].sort();

function assertToolsSelectExactKeySurface(body: {
  selection: { policy_relaxation?: unknown };
  execution_kernel: unknown;
  rules: unknown;
  pattern_matches: unknown;
  decision: { pattern_summary: unknown };
  selection_summary: unknown;
}) {
  assert.deepEqual(Object.keys(body as Record<string, unknown>).sort(), TOOLS_SELECT_ROUTE_KEYS);
  assert.deepEqual(Object.keys(body.selection as Record<string, unknown>).sort(), TOOLS_SELECT_SELECTION_KEYS);
  assert.deepEqual(
    Object.keys(body.selection.policy_relaxation as Record<string, unknown>).sort(),
    TOOLS_SELECT_POLICY_RELAXATION_KEYS,
  );
  assert.deepEqual(
    Object.keys(body.execution_kernel as Record<string, unknown>).sort(),
    TOOLS_SELECT_EXECUTION_KERNEL_KEYS,
  );
  assert.deepEqual(Object.keys(body.rules as Record<string, unknown>).sort(), TOOLS_SELECT_RULES_KEYS);
  assert.deepEqual(
    Object.keys(body.pattern_matches as Record<string, unknown>).sort(),
    TOOLS_SELECT_PATTERN_MATCHES_KEYS,
  );
  assert.deepEqual(Object.keys(body.decision as Record<string, unknown>).sort(), TOOLS_SELECT_DECISION_KEYS);
  assert.deepEqual(
    Object.keys(body.decision.pattern_summary as Record<string, unknown>).sort(),
    TOOLS_SELECT_PATTERN_SUMMARY_KEYS,
  );
  assert.deepEqual(
    Object.keys(body.selection_summary as Record<string, unknown>).sort(),
    TOOLS_SELECT_SELECTION_SUMMARY_KEYS,
  );
}

test("tool rule evaluation provenance is canonical, strict, and self-verifying", () => {
  const source = (
    ruleNodeId: string,
    state: "active" | "shadow" = "active",
    overrides: Partial<Parameters<typeof buildToolRuleEvaluationSource>[0]> = {},
  ) => buildToolRuleEvaluationSource({
    rule_node_id: ruleNodeId,
    state,
    rule_scope: "global",
    target_agent_id: null,
    target_team_id: null,
    rule_memory_lane: "shared",
    rule_owner_agent_id: null,
    rule_owner_team_id: null,
    if_json: { task_kind: { $eq: "repository_change" } },
    then_json: { tool: { prefer: ["read"] } },
    exceptions_json: [],
    rule_slots: {},
    commit_id: `commit:${ruleNodeId}`,
    ...overrides,
  });
  const contextSha256 = "a".repeat(64);
  const policySha256 = "b".repeat(64);
  const provenance = buildToolRuleEvaluationProvenance({
    effective_context_sha256: contextSha256,
    policy_sha256: policySha256,
    include_shadow: true,
    rules_limit: 20,
    active_sources: [source("rule:b"), source("rule:a")],
    shadow_sources: [source("rule:shadow", "shadow")],
  });
  assert.deepEqual(provenance.active_sources.map((entry) => entry.rule_node_id), ["rule:a", "rule:b"]);
  assert.deepEqual(provenance.active_sources[0]?.touched_paths, ["tool.prefer"]);
  assert.equal(provenance.shadow_sources[0]?.state, "shadow");
  assert.equal(verifyToolRuleEvaluationProvenance(provenance), true);
  assert.equal("context" in provenance, false);
  assert.equal(verifyToolRuleEvaluationProvenance({ ...provenance, policy_sha256: contextSha256 }), false);
  const semanticBaseline = source("rule:semantic");
  assert.notEqual(source("rule:semantic", "active", {
    rule_memory_lane: "private",
    rule_owner_agent_id: "agent:owner",
  }).row_sha256, semanticBaseline.row_sha256);
  assert.notEqual(source("rule:semantic", "active", {
    rule_slots: { rule_meta: { priority: 7, weight: 1.5 } },
  }).row_sha256, semanticBaseline.row_sha256);
  assert.throws(() => buildToolRuleEvaluationProvenance({
    effective_context_sha256: contextSha256,
    policy_sha256: policySha256,
    include_shadow: true,
    rules_limit: 20,
    active_sources: [source("rule:a")],
    shadow_sources: [source("rule:a", "shadow")],
  }));
});

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-tools-select-route-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildRequestGuards() {
  return createRequestGuards({
    env: {
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
      MAX_TEXT_LEN: 10000,
      PII_REDACTION: false,
      ALLOW_CROSS_SCOPE_EDGES: false,
    } as any,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

function buildLiteEnv(overrides: Record<string, unknown> = {}) {
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
    MAX_TEXT_LEN: 10000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    TOOLS_LEARNING_CONTROL_EVIDENCE_FORM_PATTERN_PROVIDER_ENABLED: false,
    ...overrides,
  } as any;
}

test("feedback materialization upgrades thin recovery contract placeholders", () => {
  const merged = buildMaterializationContextFromFeedback({
    context: {
      contract_trust: "authoritative",
      task_family: null,
      workflow_signature: null,
      file_path: null,
      target_files: [],
      next_action: null,
      workflow_steps: [],
      pattern_hints: [],
      service_lifecycle_constraints: [],
      recovery_contract_v1: {
        task_family: null,
        task_signature: null,
        workflow_signature: null,
        contract: {
          target_files: [],
          acceptance_checks: ["curl -fsS http://localhost:8080/healthz"],
          success_invariants: ["all_acceptance_checks_pass"],
          next_action: null,
          workflow_steps: [],
          pattern_hints: [],
          service_lifecycle_constraints: [],
        },
      },
    },
    workflowFeedbackTarget: {
      taskSignature: "workflow-validation-recovery-route",
      errorSignature: null,
      workflowSignature: "execution_workflow:workflow-validation-recovery",
      taskFamily: "task:workflow_validation_recovery",
      filePath: "src/routes/export.ts",
      targetFiles: ["src/routes/export.ts"],
      nextAction: "Patch src/routes/export.ts and rerun export tests.",
      workflowSteps: [
        "Inspect src/routes/export.ts for the export mismatch.",
        "Patch the route export serialization.",
      ],
      patternHints: ["prefer_edit_for_route_level_repairs"],
      serviceLifecycleConstraints: [
        {
          version: 1,
          service_kind: "http",
          label: "service:http://localhost:8080/healthz",
          launch_reference: "nohup node scripts/dev-server.js >/tmp/dev-server.log 2>&1 &",
          endpoint: "http://localhost:8080/healthz",
          must_survive_agent_exit: true,
          revalidate_from_fresh_shell: true,
          detach_then_probe: true,
          health_checks: ["curl -fsS http://localhost:8080/healthz"],
          teardown_notes: [],
        },
      ],
    },
  }) as Record<string, unknown>;

  const recoveryContract = merged.recovery_contract_v1 as Record<string, unknown>;
  const recoveryBody = recoveryContract.contract as Record<string, unknown>;
  assert.equal(merged.contract_trust, "authoritative");
  assert.equal(merged.task_family, "task:workflow_validation_recovery");
  assert.equal(merged.workflow_signature, "execution_workflow:workflow-validation-recovery");
  assert.deepEqual(merged.target_files, ["src/routes/export.ts"]);
  assert.equal(merged.next_action, "Patch src/routes/export.ts and rerun export tests.");
  assert.equal(recoveryContract.task_signature, "workflow-validation-recovery-route");
  assert.equal(recoveryContract.workflow_signature, "execution_workflow:workflow-validation-recovery");
  assert.equal(recoveryContract.contract_trust, "authoritative");
  assert.deepEqual(recoveryBody.target_files, ["src/routes/export.ts"]);
  assert.equal(recoveryBody.next_action, "Patch src/routes/export.ts and rerun export tests.");
  assert.deepEqual(recoveryBody.workflow_steps, [
    "Inspect src/routes/export.ts for the export mismatch.",
    "Patch the route export serialization.",
  ]);
  assert.deepEqual(recoveryBody.pattern_hints, ["prefer_edit_for_route_level_repairs"]);
  assert.equal((recoveryBody.service_lifecycle_constraints as Array<Record<string, unknown>>)[0]?.revalidate_from_fresh_shell, true);
});

test("feedback materialization keeps observational trust from hardening into recovery contract fields", () => {
  const merged = buildMaterializationContextFromFeedback({
    context: {
      contract_trust: "observational",
      task_family: null,
      workflow_signature: null,
      file_path: null,
      target_files: [],
      next_action: null,
      workflow_steps: [],
      pattern_hints: [],
      service_lifecycle_constraints: [],
      recovery_contract_v1: {
        task_family: null,
        task_signature: null,
        workflow_signature: null,
        contract: {
          target_files: [],
          next_action: null,
          workflow_steps: [],
          pattern_hints: [],
          service_lifecycle_constraints: [],
        },
      },
    },
    workflowFeedbackTarget: {
      taskSignature: "workflow-validation-recovery-route",
      errorSignature: null,
      workflowSignature: "execution_workflow:workflow-validation-recovery",
      taskFamily: "task:workflow_validation_recovery",
      filePath: "src/routes/export.ts",
      targetFiles: ["src/routes/export.ts"],
      nextAction: "Patch src/routes/export.ts and rerun export tests.",
      workflowSteps: ["Inspect src/routes/export.ts for the export mismatch."],
      patternHints: ["prefer_edit_for_route_level_repairs"],
      serviceLifecycleConstraints: [],
    },
  }) as Record<string, unknown>;

  const recoveryContract = merged.recovery_contract_v1 as Record<string, unknown>;
  const recoveryBody = recoveryContract.contract as Record<string, unknown>;
  assert.equal(merged.contract_trust, "observational");
  assert.equal(merged.task_family, null);
  assert.equal(merged.workflow_signature, null);
  assert.equal(merged.file_path, null);
  assert.deepEqual(merged.target_files, []);
  assert.equal(recoveryContract.contract_trust, "observational");
  assert.deepEqual(recoveryBody.target_files, []);
  assert.equal(recoveryBody.next_action, null);
});

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
      input_text: `create rule prefer ${preferredTool} for export repair`,
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
  dbPath: string,
  preferredTools: string[],
): Promise<{ liteWriteStore: ReturnType<typeof createLiteWriteStore>; ruleNodeIds: string[] }> {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const ruleNodeIds: string[] = [];
  for (const [index, preferredTool] of preferredTools.entries()) {
    ruleNodeIds.push(await insertAndActivateRule(liteWriteStore, preferredTool, `route-${preferredTool}-${index + 1}`));
  }
  return { liteWriteStore, ruleNodeIds };
}

async function seedToolsSelectFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover durable workflow from failed validation"]);
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
    trust_hardening: {
      task_family: "task:workflow_validation_recovery",
      error_family: "error:workflow-validation-mismatch",
      observed_task_families: ["task:workflow_validation_recovery"],
      observed_error_families: ["error:workflow-validation-mismatch"],
      distinct_task_family_count: 1,
      distinct_error_family_count: 1,
      post_contest_observed_run_ids: [],
      post_contest_distinct_run_count: 0,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: true,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: true,
      task_affinity_weighting_enabled: true,
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

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed tools select route contract fixture",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          client_id: "rule:prefer-bash:workflow-validation-recovery",
          type: "rule",
          title: "Prefer bash for export repair",
          text_summary: "For workflow_validation_recovery tasks, prefer bash over the other tools.",
          slots: {
            if: {
              task_kind: { $eq: "workflow_validation_recovery" },
            },
            then: {
              tool: {
                prefer: ["bash"],
              },
            },
            exceptions: [],
            rule_scope: "global",
          },
        },
        {
          id: randomUUID(),
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

  const out = await liteWriteStore.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  const ruleNodeId = out.nodes.find((node) => node.type === "rule")?.id;
  assert.ok(ruleNodeId);

  await liteWriteStore.withTx(() =>
    updateRuleState({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "activate prefer bash rule",
    }, "default", "default", {
      liteWriteStore,
    }),
  );

  return { liteWriteStore, liteRecallStore };
}

async function seedPolicyMemoryLearningControlFixture(dbPath: string) {
  const { liteWriteStore, ruleNodeIds } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover durable workflow from failed validation"]);
  const stablePattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_class: "tools_select_pattern",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "policy-learning-control-edit-pattern",
    summary: "Stable pattern: prefer edit for workflow_validation_recovery after repeated successful runs.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    outcome: {
      status: "success",
      result_class: "tool_selection_pattern_stable",
      success_score: 0.94,
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
    trust_hardening: {
      task_family: "task:workflow_validation_recovery",
      error_family: "error:workflow-validation-mismatch",
      observed_task_families: ["task:workflow_validation_recovery"],
      observed_error_families: ["error:workflow-validation-mismatch"],
      distinct_task_family_count: 1,
      distinct_error_family_count: 1,
      post_contest_observed_run_ids: [],
      post_contest_distinct_run_count: 0,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: true,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: true,
      task_affinity_weighting_enabled: true,
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

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed policy learning_control fixture",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          id: randomUUID(),
          type: "concept",
          title: "Policy learning_control stable edit pattern",
          text_summary: stablePattern.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: stablePattern,
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "pattern_anchor",
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              task_signature: stablePattern.task_signature,
              task_family: stablePattern.task_family,
              error_family: stablePattern.error_family,
              pattern_signature: stablePattern.pattern_signature,
              anchor_kind: "pattern",
              anchor_level: "L3",
              tool_set: stablePattern.tool_set,
              selected_tool: stablePattern.selected_tool,
              pattern_state: "stable",
              credibility_state: "trusted",
              file_path: stablePattern.file_path,
              target_files: stablePattern.target_files,
              next_action: stablePattern.next_action,
              promotion: stablePattern.promotion,
              trust_hardening: stablePattern.trust_hardening,
              maintenance: stablePattern.maintenance,
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

  await liteWriteStore.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );

  return { liteWriteStore, liteRecallStore, ruleNodeIds };
}

test("LearningKernel tool selection returns the stable execution-memory contract surface", async () => {
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedToolsSelectFixture(tmpDbPath("route"));
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
      } as any,
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const response = await invokeLearningKernel(learningKernel, "select", {
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
      });

    assert.equal(response.statusCode, 200);
    const body = ToolsSelectRouteContractSchema.parse(response.json());
    assertToolsSelectExactKeySurface(body);
    assert.throws(() =>
      ToolsSelectRouteContractSchema.parse({
        ...body,
        debug_passthrough: true,
      }),
    );
    assert.throws(() =>
      ToolsSelectRouteContractSchema.parse({
        ...body,
        selection: {
          ...body.selection,
          debug_passthrough: true,
        },
      }),
    );
    assert.throws(() =>
      ToolsSelectRouteContractSchema.parse({
        ...body,
        decision: {
          ...body.decision,
          pattern_summary: {
            ...body.decision.pattern_summary,
            debug_passthrough: true,
          },
        },
      }),
    );
    assert.equal(body.selection.selected, "bash");
    assert.deepEqual(body.selection.preferred, ["bash"]);
    assert.deepEqual(body.selection.ordered.slice(0, 2), ["bash", "edit"]);
    assert.equal(body.pattern_matches.matched, 1);
    assert.equal(body.pattern_matches.trusted, 1);
    assert.deepEqual(body.pattern_matches.preferred_tools, ["edit"]);
    assert.equal(body.pattern_matches.anchors[0]?.selected_tool, "edit");
    assert.equal(body.pattern_matches.anchors[0]?.credibility_state, "trusted");
    assert.equal(body.pattern_matches.anchors[0]?.affinity_level, "same_task_family");
    assert.equal(body.pattern_matches.anchors[0]?.trust_hardening?.promotion_gate_kind, "current_distinct_runs_v1");
    assert.equal(body.pattern_matches.anchors[0]?.trust_hardening?.revalidation_floor_kind, "post_contest_two_fresh_runs_v1");
    assert.equal(body.pattern_matches.anchors[0]?.trust_hardening?.task_affinity_weighting_enabled, true);
    assert.deepEqual(body.decision.pattern_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(body.decision.pattern_summary.used_trusted_pattern_anchor_ids, []);
    assert.deepEqual(body.decision.pattern_summary.used_trusted_pattern_affinity_levels ?? [], []);
    assert.deepEqual(body.decision.pattern_summary.skipped_contested_pattern_tools, []);
    const persistedDecision = await liteWriteStore.getExecutionDecision({
      scope: "default",
      id: body.decision.decision_id,
    });
    assert.ok(persistedDecision);
    assert.equal(body.decision.context_sha256, persistedDecision.context_sha256);
    const ruleEvaluation = readToolRuleEvaluationProvenance(persistedDecision.metadata_json);
    assert.ok(ruleEvaluation);
    assert.equal(ruleEvaluation.effective_context_sha256, body.decision.context_sha256);
    assert.equal(ruleEvaluation.policy_sha256, body.decision.policy_sha256);
    assert.equal(ruleEvaluation.provenance_sha256, body.decision.rule_evaluation_sha256);
    assert.equal(ruleEvaluation.include_shadow, false);
    assert.equal(ruleEvaluation.rules_limit, 20);
    assert.equal(ruleEvaluation.active_sources.length, 1);
    assert.equal(ruleEvaluation.active_sources[0]?.state, "active");
    assert.equal(ruleEvaluation.active_sources[0]?.row_sha256.length, 64);
    assert.deepEqual(ruleEvaluation.active_sources[0]?.touched_paths, ["tool.prefer"]);
    assert.deepEqual(ruleEvaluation.shadow_sources, []);
    assert.equal("context" in ruleEvaluation, false, "decision provenance must not persist raw execution context");
    assert.equal(body.selection_summary.trusted_pattern_count, 1);
    assert.equal(body.selection_summary.contested_pattern_count, 0);
    assert.equal(body.selection_summary.pattern_lifecycle_summary.trusted_count, 1);
    assert.equal(body.selection_summary.pattern_lifecycle_summary.candidate_count, 0);
    assert.equal(body.selection_summary.pattern_maintenance_summary.retain_count, 1);
    assert.deepEqual(body.selection_summary.used_trusted_pattern_affinity_levels ?? [], []);
    assert.equal(
      body.selection_summary.provenance_explanation,
      "selected tool: bash; trusted patterns available but not used: edit [same_task_family]",
    );
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("LearningKernel selection keeps suppressed trusted patterns visible but excludes them from trusted reuse", async () => {
  const app = Fastify();
  const { liteWriteStore, liteRecallStore } = await seedToolsSelectFixture(tmpDbPath("suppressed"));
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
      } as any,
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const patternNode = await liteWriteStore.findNodes({
      scope: "default",
      type: "concept",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    const patternNodeId = patternNode.rows.find((row) => row.slots?.anchor_v1?.anchor_kind === "pattern")?.id;
    assert.ok(patternNodeId);

    const suppressResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/patterns/suppress",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor_id: patternNodeId,
        reason: "stop trusted reuse during operator review",
      },
    });
    assert.equal(suppressResponse.statusCode, 200);
    PatternSuppressResponseSchema.parse(suppressResponse.json());

    const response = await invokeLearningKernel(learningKernel, "select", {
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
      });

    assert.equal(response.statusCode, 200);
    const body = ToolsSelectRouteContractSchema.parse(response.json());
    assert.equal(body.selection.selected, "bash");
    assert.equal(body.pattern_matches.matched, 1);
    assert.equal(body.pattern_matches.trusted, 0);
    assert.equal(body.pattern_matches.anchors[0]?.credibility_state, "trusted");
    assert.equal(body.pattern_matches.anchors[0]?.suppressed, true);
    assert.equal(body.pattern_matches.anchors[0]?.affinity_level, "same_task_family");
    assert.equal(body.selection_summary.trusted_pattern_count, 0);
    assert.equal(body.selection_summary.suppressed_pattern_count, 1);
    assert.deepEqual(body.selection_summary.used_trusted_pattern_tools, []);
    assert.deepEqual(body.selection_summary.used_trusted_pattern_affinity_levels ?? [], []);
    assert.deepEqual(body.selection_summary.skipped_suppressed_pattern_tools, ["edit"]);
    assert.deepEqual(body.selection_summary.skipped_suppressed_pattern_affinity_levels ?? [], ["same_task_family"]);
    assert.deepEqual(body.decision.pattern_summary.skipped_suppressed_pattern_tools, ["edit"]);
    assert.deepEqual(body.decision.pattern_summary.skipped_suppressed_pattern_affinity_levels ?? [], ["same_task_family"]);
    assert.equal(
      body.selection_summary.provenance_explanation,
      "selected tool: bash; suppressed patterns visible but operator-blocked: edit",
    );
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("LearningKernel feedback can use internal evidence form_pattern provider without explicit review", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("tools-feedback-provider-route");
  const { liteWriteStore } = await seedActiveRules(dbPath, ["edit", "edit"]);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv({
        TOOLS_LEARNING_CONTROL_EVIDENCE_FORM_PATTERN_PROVIDER_ENABLED: true,
      }),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "authoritative",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      recovery_contract_v1: {
        contract_trust: "authoritative",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          acceptance_checks: ["npm run -s test:lite -- export"],
          success_invariants: ["all_acceptance_checks_pass"],
          must_hold_after_exit: ["verification_result_revalidated_from_fresh_shell"],
          external_visibility_requirements: ["health_check:npm run -s test:lite -- export"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
          workflow_steps: [
            "Inspect src/routes/export.ts for the export mismatch.",
            "Patch the route export serialization.",
            "Rerun export-focused tests before handoff.",
          ],
          pattern_hints: [
            "prefer_edit_for_route_level_repairs",
            "keep_changes_scoped_to_export_route",
          ],
          service_lifecycle_constraints: [
            {
              version: 1,
              service_kind: "generic",
              label: "export test verification shell",
              launch_reference: null,
              endpoint: null,
              must_survive_agent_exit: false,
              revalidate_from_fresh_shell: true,
              detach_then_probe: false,
              health_checks: ["npm run -s test:lite -- export"],
              teardown_notes: [],
            },
          ],
        },
      },
      error: {
        signature: "workflow-validation-mismatch",
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
      });
    assert.equal(feedbackResponse.statusCode, 200);
    const parsed = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    assert.equal(parsed.pattern_anchor?.pattern_state, "stable");
    assert.equal(parsed.pattern_anchor?.credibility_state, "trusted");
    const patternPromotionLedger = PromotionEvidenceLedgerV1Schema.parse(
      (parsed.pattern_anchor as Record<string, unknown> | undefined)?.promotion_evidence_ledger_v1,
    );
    assert.equal(patternPromotionLedger.transition, "L2_to_L3");
    assert.equal(patternPromotionLedger.target_kind, "pattern");
    assert.equal(patternPromotionLedger.verdict, "promotion_admitted");
    assert.equal(patternPromotionLedger.source_code_change_allowed, false);
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.review_version, "form_pattern_semantic_review_v1");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.adjudication.reason, "evidence provider found grouped signature evidence");
    assert.equal(parsed.learning_control_preview?.form_pattern.review_result?.adjudication.confidence, 0.85);
    assert.equal(parsed.learning_control_preview?.form_pattern.admissibility?.admissible, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.policy_effect?.applies, true);
    assert.equal(parsed.learning_control_preview?.form_pattern.decision_trace.runtime_apply_changed_pattern_state, true);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("policy learning_control apply route can retire and reactivate persisted policy memory", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("policy-learning-control-route");
  const { liteWriteStore, liteRecallStore } = await seedPolicyMemoryLearningControlFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv(),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "authoritative",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      execution_evidence_v1: {
        schema_version: "execution_evidence_v1",
        validation_passed: true,
        after_exit_revalidated: true,
        fresh_shell_probe_passed: true,
        validation_boundary: "external_verifier",
        failure_reason: null,
        false_confidence_detected: false,
        evidence_refs: ["tools_feedback_policy_learning_control:fresh_shell_validation_test"],
      },
      error: {
        signature: "workflow-validation-mismatch",
      },
      recovery_contract_v1: {
        contract_trust: "authoritative",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          acceptance_checks: ["npm run -s test:lite -- export"],
          success_invariants: ["all_acceptance_checks_pass"],
          must_hold_after_exit: ["verification_result_revalidated_from_fresh_shell"],
          external_visibility_requirements: ["health_check:npm run -s test:lite -- export"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
          workflow_steps: [
            "Inspect src/routes/export.ts for the export mismatch.",
            "Patch the route export serialization.",
            "Rerun export-focused tests before handoff.",
          ],
          pattern_hints: [
            "prefer_edit_for_route_level_repairs",
            "keep_changes_scoped_to_export_route",
          ],
          service_lifecycle_constraints: [
            {
              version: 1,
              service_kind: "generic",
              label: "export test verification shell",
              launch_reference: null,
              endpoint: null,
              must_survive_agent_exit: false,
              revalidate_from_fresh_shell: true,
              detach_then_probe: false,
              healthcheck_commands: ["npm test -- export"],
              notes: ["rerun export tests from a fresh shell before handoff"],
            },
          ],
        },
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
        note: "Edit produced the successful repair path and should become persisted policy memory.",
        input_text: "recover durable workflow from failed validation",
      });
    assert.equal(feedbackResponse.statusCode, 200, feedbackResponse.body);
    const feedback = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    assert.equal(feedback.policy_memory?.selected_tool, "edit");
    assert.equal(feedback.policy_memory?.policy_memory_state, "active");
    assert.equal(feedback.policy_memory?.policy_contract.materialization_state, "persisted");
    assert.equal(feedback.policy_memory?.policy_contract.contract_trust, "authoritative");
    const policyPromotionLedger = PromotionEvidenceLedgerV1Schema.parse(
      (feedback.policy_memory as Record<string, unknown> | undefined)?.promotion_evidence_ledger_v1,
    );
    assert.equal(policyPromotionLedger.transition, "L3_to_L4");
    assert.equal(policyPromotionLedger.target_kind, "policy");
    assert.equal(policyPromotionLedger.promotion_state, "active");
    assert.equal(policyPromotionLedger.source_code_change_allowed, false);
    assert.deepEqual(feedback.policy_memory?.policy_contract.target_files, ["src/routes/export.ts"]);
    assert.equal(feedback.policy_memory?.policy_contract.file_path, "src/routes/export.ts");
    assert.equal(feedback.policy_memory?.policy_contract.next_action, "Patch src/routes/export.ts and rerun export tests.");
    assert.deepEqual(feedback.policy_memory?.policy_contract.workflow_steps, [
      "Inspect src/routes/export.ts for the export mismatch.",
      "Patch the route export serialization.",
      "Rerun export-focused tests before handoff.",
    ]);
    assert.deepEqual(feedback.policy_memory?.policy_contract.pattern_hints, [
      "prefer_edit_for_route_level_repairs",
      "keep_changes_scoped_to_export_route",
    ]);
    assert.equal(feedback.policy_memory?.policy_contract.service_lifecycle_constraints?.[0]?.revalidate_from_fresh_shell, true);
    const policyMemoryId = feedback.policy_memory?.node_id;
    assert.ok(policyMemoryId);
    const persistedAfterFeedback = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const feedbackSlots = (persistedAfterFeedback.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((feedbackSlots.execution_contract_v1 as Record<string, unknown>)?.schema_version, "execution_contract_v1");
    assert.equal((feedbackSlots.execution_contract_v1 as Record<string, unknown>)?.policy_memory_id, policyMemoryId);
    assert.equal((feedbackSlots.execution_contract_v1 as Record<string, unknown>)?.selected_tool, "edit");
    assert.equal((feedbackSlots.execution_contract_v1 as Record<string, unknown>)?.file_path, "src/routes/export.ts");

    const retireResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/policies/learning-control/apply",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        policy_memory_id: policyMemoryId,
        action: "retire",
        reason: "manual review retired this persisted policy memory",
      },
    });
    assert.equal(retireResponse.statusCode, 200, retireResponse.body);
    const retired = PolicyLearningControlApplyResponseSchema.parse(retireResponse.json());
    assert.equal(retired.applied, true);
    assert.equal(retired.action, "retire");
    assert.equal(retired.previous_state, "active");
    assert.equal(retired.next_state, "retired");
    assert.equal(retired.policy_memory.policy_memory_state, "retired");
    const retiredMutation = PolicyMutationV1Schema.parse(retired.policy_mutation_v1);
    const retiredAdjudication = PolicyMutationAdjudicationV1Schema.parse(retired.policy_mutation_adjudication_v1);
    assert.equal(retiredMutation.stage, "apply");
    assert.equal(retiredMutation.target.kind, "policy_memory");
    assert.equal(retiredMutation.target.target_id, policyMemoryId);
    assert.equal(retiredMutation.proposed_effect, "retired");
    assert.equal(retiredMutation.source_code_change_allowed, false);
    assert.equal(retiredMutation.project_specific_content_destination, "policy_memory");
    assert.equal(retiredAdjudication.admissible, true);
    assert.equal(retiredAdjudication.source_code_change_allowed, false);
    const persistedAfterRetire = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const retireSlots = (persistedAfterRetire.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((retireSlots.execution_contract_v1 as Record<string, unknown>)?.schema_version, "execution_contract_v1");
    assert.equal((retireSlots.execution_contract_v1 as Record<string, unknown>)?.policy_memory_id, policyMemoryId);
    assert.equal((retireSlots.execution_contract_v1 as Record<string, unknown>)?.selected_tool, "edit");

    const reactivateResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/policies/learning-control/apply",
      payload: {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        policy_memory_id: policyMemoryId,
        action: "reactivate",
        reason: "fresh live evidence supports reactivating the retired policy memory",
        query_text: "recover durable workflow from failed validation",
        context,
        candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(reactivateResponse.statusCode, 200, reactivateResponse.body);
    const reactivated = PolicyLearningControlApplyResponseSchema.parse(reactivateResponse.json());
    assert.equal(reactivated.applied, true);
    assert.equal(reactivated.action, "reactivate");
    assert.equal(reactivated.previous_state, "retired");
    assert.equal(reactivated.next_state, "active");
    assert.equal(reactivated.policy_memory.policy_memory_state, "active");
    const reactivatedPromotionLedger = PromotionEvidenceLedgerV1Schema.parse(
      (reactivated.policy_memory as Record<string, unknown>).promotion_evidence_ledger_v1,
    );
    assert.equal(reactivatedPromotionLedger.transition, "L3_to_L4");
    assert.equal(reactivatedPromotionLedger.promotion_origin, "learning_control");
    assert.equal(reactivatedPromotionLedger.learning_control_admitted, true);
    assert.equal(reactivatedPromotionLedger.source_code_change_allowed, false);
    assert.equal(reactivated.live_policy_contract?.selected_tool, "edit");
    const reactivatedMutation = PolicyMutationV1Schema.parse(reactivated.policy_mutation_v1);
    const reactivatedAdjudication = PolicyMutationAdjudicationV1Schema.parse(reactivated.policy_mutation_adjudication_v1);
    assert.equal(reactivatedMutation.stage, "apply");
    assert.equal(reactivatedMutation.target.kind, "policy_memory");
    assert.equal(reactivatedMutation.target.target_id, policyMemoryId);
    assert.equal(reactivatedMutation.source_code_change_allowed, false);
    assert.equal(reactivatedMutation.project_specific_content_destination, "policy_memory");
    assert.equal(reactivatedMutation.evidence.some((entry) => entry.grade === "deterministic_contract_pass"), true);
    assert.equal(reactivatedAdjudication.admissible, true);
    assert.equal(reactivatedAdjudication.source_code_change_allowed, false);
    const persistedAfterReactivate = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const reactivateSlots = (persistedAfterReactivate.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((reactivateSlots.execution_contract_v1 as Record<string, unknown>)?.schema_version, "execution_contract_v1");
    assert.equal((reactivateSlots.execution_contract_v1 as Record<string, unknown>)?.policy_memory_id, policyMemoryId);
    assert.equal((reactivateSlots.execution_contract_v1 as Record<string, unknown>)?.selected_tool, "edit");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("LearningKernel feedback does not materialize policy memory from observational trust", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("policy-materialization-observational");
  const { liteWriteStore, liteRecallStore } = await seedPolicyMemoryLearningControlFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv(),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "observational",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      error: {
        signature: "workflow-validation-mismatch",
      },
      recovery_contract_v1: {
        contract_trust: "observational",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
        },
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
        note: "Observational continuity should not harden into persisted policy memory.",
        input_text: "recover durable workflow from failed validation",
      });
    assert.equal(feedbackResponse.statusCode, 200, feedbackResponse.body);
    const feedback = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    assert.equal(feedback.policy_memory ?? null, null);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("LearningKernel feedback materializes advisory trust as hint-only candidate policy memory", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("policy-materialization-advisory");
  const { liteWriteStore, liteRecallStore } = await seedPolicyMemoryLearningControlFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv(),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "advisory",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      error: {
        signature: "workflow-validation-mismatch",
      },
      recovery_contract_v1: {
        contract_trust: "advisory",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
          workflow_steps: [
            "Inspect src/routes/export.ts for the export mismatch.",
            "Patch the route export serialization.",
          ],
        },
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
        note: "Advisory continuity may persist, but only as hint-level candidate policy memory.",
        input_text: "recover durable workflow from failed validation",
      });
    assert.equal(feedbackResponse.statusCode, 200, feedbackResponse.body);
    const feedback = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    assert.equal(feedback.policy_memory?.policy_contract.contract_trust, "advisory");
    assert.equal(feedback.policy_memory?.policy_memory_state, "contested");
    assert.equal(feedback.policy_memory?.policy_contract.activation_mode, "hint");
    assert.equal(feedback.policy_memory?.policy_contract.policy_state, "candidate");
    assert.equal((feedback.policy_memory?.policy_contract as any)?.outcome_contract_gate?.status, "insufficient");
    assert.ok((feedback.policy_memory?.policy_contract as any)?.outcome_contract_gate?.reasons?.includes("missing_verifiable_success_outcome"));
    const policyMemoryId = feedback.policy_memory?.node_id;
    assert.ok(policyMemoryId);
    const persisted = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const persistedSlots = (persisted.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.schema_version, "execution_contract_v1");
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.policy_memory_id, policyMemoryId);
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.contract_trust, "advisory");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("LearningKernel feedback downgrades authoritative trust without sufficient outcome contract", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("policy-materialization-authoritative-thin");
  const { liteWriteStore, liteRecallStore } = await seedPolicyMemoryLearningControlFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv(),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "authoritative",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      error: {
        signature: "workflow-validation-mismatch",
      },
      recovery_contract_v1: {
        contract_trust: "authoritative",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
          workflow_steps: [
            "Inspect src/routes/export.ts for the export mismatch.",
            "Patch the route export serialization.",
          ],
        },
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
        note: "Thin authoritative continuity may persist only as hint-level policy memory.",
        input_text: "recover durable workflow from failed validation",
      });
    assert.equal(feedbackResponse.statusCode, 200, feedbackResponse.body);
    const feedback = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    assert.equal(feedback.policy_memory?.policy_contract.contract_trust, "advisory");
    assert.equal(feedback.policy_memory?.policy_memory_state, "contested");
    assert.equal(feedback.policy_memory?.policy_contract.activation_mode, "hint");
    assert.equal(feedback.policy_memory?.policy_contract.policy_state, "candidate");
    const policyMemoryId = feedback.policy_memory?.node_id;
    assert.ok(policyMemoryId);
    const persisted = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const persistedSlots = (persisted.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.contract_trust, "advisory");
    assert.equal(((persistedSlots.policy_contract_v1 as Record<string, unknown>)?.outcome_contract_gate as any)?.status, "insufficient");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});

test("policy learning_control core keeps advisory policy memory contested until stronger trust arrives", async () => {
  const app = Fastify();
  const dbPath = tmpDbPath("policy-learning-control-advisory-reactivate");
  const { liteWriteStore, liteRecallStore } = await seedPolicyMemoryLearningControlFixture(dbPath);
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    const learningKernel = registerMemoryFeedbackToolRoutes({
      app,
      env: buildLiteEnv(),
      embedder: DeterministicEmbeddingProvider,
      liteRecallAccess: liteRecallStore.createRecallAccess(),
      liteWriteStore,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const runId = randomUUID();
    const context = {
      contract_trust: "advisory",
      task_kind: "workflow_validation_recovery",
      task_family: "task:workflow_validation_recovery",
      workflow_signature: "execution_workflow:workflow-validation-recovery",
      goal: "recover durable workflow from failed validation",
      target_files: ["src/routes/export.ts"],
      next_action: "Patch src/routes/export.ts and rerun export tests.",
      error: {
        signature: "workflow-validation-mismatch",
      },
      recovery_contract_v1: {
        contract_trust: "advisory",
        task_family: "task:workflow_validation_recovery",
        task_signature: "workflow-validation-recovery-route",
        workflow_signature: "execution_workflow:workflow-validation-recovery",
        contract: {
          target_files: ["src/routes/export.ts"],
          next_action: "Patch src/routes/export.ts and rerun export tests.",
          workflow_steps: [
            "Inspect src/routes/export.ts for the export mismatch.",
            "Patch the route export serialization.",
          ],
        },
      },
    };

    const selectionResponse = await invokeLearningKernel(learningKernel, "select", {
        tenant_id: "default",
        scope: "default",
        run_id: runId,
        context,
        candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
        strict: true,
        reorder_candidates: false,
      });
    assert.equal(selectionResponse.statusCode, 200);
    const selection = ToolsSelectRouteContractSchema.parse(selectionResponse.json());

    const feedbackResponse = await invokeLearningKernel(learningKernel, "feedback", {
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
        note: "Advisory continuity should persist for learning_control, but not reactivate as active policy memory.",
        input_text: "recover durable workflow from failed validation",
      });
    assert.equal(feedbackResponse.statusCode, 200, feedbackResponse.body);
    const feedback = ToolsFeedbackResponseSchema.parse(feedbackResponse.json());
    const policyMemoryId = feedback.policy_memory?.node_id;
    assert.ok(policyMemoryId);
    assert.equal(feedback.policy_memory?.policy_memory_state, "contested");

    const reactivated = await applyPolicyMemoryLearningControlLite(liteWriteStore, {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      policy_memory_id: policyMemoryId!,
      action: "reactivate",
      reason: "attempt reactivation with only advisory live evidence",
      live_policy_contract: feedback.policy_memory?.policy_contract ?? null,
      live_derived_policy: null,
    });
    assert.equal(reactivated.previous_state, "contested");
    assert.equal(reactivated.next_state, "contested");
    assert.equal(reactivated.policy_memory.policy_memory_state, "contested");
    assert.equal(reactivated.policy_memory.policy_contract.contract_trust, "advisory");
    assert.equal(reactivated.policy_memory.policy_contract.activation_mode, "hint");
    const persisted = await liteWriteStore.findNodes({
      scope: "default",
      id: policyMemoryId!,
      type: "concept",
      limit: 1,
      offset: 0,
    });
    const persistedSlots = (persisted.rows[0]?.slots ?? {}) as Record<string, unknown>;
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.schema_version, "execution_contract_v1");
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.policy_memory_id, policyMemoryId);
    assert.equal((persistedSlots.execution_contract_v1 as Record<string, unknown>)?.contract_trust, "advisory");
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteWriteStore.close();
  }
});
