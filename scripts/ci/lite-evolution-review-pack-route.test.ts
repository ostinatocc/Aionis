import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { buildPolicyLearningControlContract } from "../../src/memory/evolution-inspect.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import { registerMemoryAccessRoutes } from "./support/register-memory-access-test-routes.ts";
import {
  EvolutionReviewPackResponseSchema,
  MemoryAnchorV1Schema,
  PolicyContractSchema,
  PolicyReviewSummarySchema,
} from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-evolution-review-pack-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildEnv() {
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
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const env = buildEnv();
  const guards = createRequestGuards({
    env,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });

  registerRuntimeErrorHandler(args.app);
  registerMemoryAccessRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

async function seedEvolutionFixture(dbPath: string) {
  const liteWriteStore = createLiteWriteStore(dbPath);
  const [sharedEmbedding] = await DeterministicEmbeddingProvider.embed(["recover durable workflow from failed validation"]);
  const trustedPattern = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: "stable",
    credibility_state: "trusted",
    task_signature: "tools_select:workflow-validation-recovery",
    task_family: "task:workflow_validation_recovery",
    error_family: "error:workflow-validation-mismatch",
    pattern_signature: "workflow-validation-recovery-stable-edit",
    summary: "Stable pattern: prefer edit for export repair.",
    tool_set: ["bash", "edit", "test"],
    selected_tool: "edit",
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    outcome: { status: "success", result_class: "tool_selection_pattern_stable", success_score: 0.94 },
    source: { source_kind: "tool_decision", decision_id: randomUUID() },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [randomUUID(), randomUUID(), randomUUID()], step_ids: [], commit_ids: [] },
    metrics: { usage_count: 0, reuse_success_count: 3, reuse_failure_count: 0, distinct_run_count: 3, last_used_at: null },
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

  const workflowAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    task_signature: "execution_task:workflow-validation-recovery",
    task_class: "execution_write_projection",
    workflow_signature: "execution_workflow:workflow-validation-recovery",
    summary: "Stable workflow for repairing validation failures.",
    tool_set: ["edit", "test"],
    file_path: "src/routes/export.ts",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    outcome: { status: "success", result_class: "execution_write_stable", success_score: 0.88 },
    source: { source_kind: "execution_write", node_id: randomUUID(), run_id: null, playbook_id: null, commit_id: null },
    payload_refs: { node_ids: [], decision_ids: [], run_ids: [], step_ids: [], commit_ids: [] },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: "low",
      recommended_when: ["workflow_summary_is_not_enough"],
    },
    metrics: { usage_count: 0, reuse_success_count: 0, reuse_failure_count: 0, distinct_run_count: 0, last_used_at: null },
    maintenance: {
      model: "lazy_online_v1",
      maintenance_state: "retain",
      offline_priority: "retain_workflow",
      lazy_update_fields: ["usage_count", "last_used_at"],
      last_maintenance_at: "2026-03-20T00:00:00Z",
    },
    workflow_promotion: {
      promotion_state: "stable",
      promotion_origin: "execution_write_auto_promotion",
      required_observations: 2,
      observed_count: 2,
      last_transition: "promoted_to_stable",
      last_transition_at: "2026-03-20T00:00:00Z",
      source_status: null,
    },
    schema_version: "anchor_v1",
  });

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "seed evolution review pack fixture",
      auto_embed: false,
      memory_lane: "shared",
      nodes: [
        {
          id: randomUUID(),
          type: "concept",
          title: "Stable edit pattern",
          text_summary: trustedPattern.summary,
          slots: {
            summary_kind: "pattern_anchor",
            compression_layer: "L3",
            anchor_v1: trustedPattern,
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "pattern_anchor",
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              task_signature: trustedPattern.task_signature,
              task_family: trustedPattern.task_family,
              error_family: trustedPattern.error_family,
              pattern_signature: trustedPattern.pattern_signature,
              anchor_kind: "pattern",
              anchor_level: "L3",
              tool_set: trustedPattern.tool_set,
              selected_tool: trustedPattern.selected_tool,
              pattern_state: "stable",
              credibility_state: "trusted",
              file_path: trustedPattern.file_path,
              target_files: trustedPattern.target_files,
              next_action: trustedPattern.next_action,
              promotion: trustedPattern.promotion,
              trust_hardening: trustedPattern.trust_hardening,
              maintenance: trustedPattern.maintenance,
            },
          },
          embedding: sharedEmbedding,
          embedding_model: DeterministicEmbeddingProvider.name,
          salience: 0.8,
          importance: 0.9,
          confidence: 0.9,
        },
        {
          id: randomUUID(),
          type: "procedure",
          title: "Recover workflow validation failure",
          text_summary: workflowAnchor.summary,
          slots: {
            summary_kind: "workflow_anchor",
            compression_layer: "L2",
            anchor_v1: workflowAnchor,
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_anchor",
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              task_signature: workflowAnchor.task_signature,
              workflow_signature: workflowAnchor.workflow_signature,
              anchor_kind: "workflow",
              anchor_level: "L2",
              tool_set: workflowAnchor.tool_set,
              file_path: workflowAnchor.file_path,
              target_files: workflowAnchor.target_files,
              next_action: workflowAnchor.next_action,
              workflow_promotion: workflowAnchor.workflow_promotion,
              maintenance: workflowAnchor.maintenance,
            },
          },
          embedding: sharedEmbedding,
          embedding_model: DeterministicEmbeddingProvider.name,
          salience: 0.8,
          importance: 0.9,
          confidence: 0.88,
        },
        {
          id: randomUUID(),
          type: "event",
          title: "Failed service-style export recovery",
          text_summary: "Candidate workflow blocked because after-exit revalidation failed.",
          slots: {
            summary_kind: "workflow_candidate",
            compression_layer: "L1",
            execution_native_v1: {
              schema_version: "execution_native_v1",
              execution_kind: "workflow_candidate",
              summary_kind: "workflow_candidate",
              compression_layer: "L1",
              task_signature: "execution_task:workflow-validation-recovery",
              workflow_signature: "execution_workflow:workflow-validation-recovery-service-check",
              anchor_kind: "workflow",
              anchor_level: "L1",
              tool_set: ["edit", "test"],
              file_path: "src/routes/export.ts",
              target_files: ["src/routes/export.ts"],
              next_action: "Patch export route, then revalidate from a fresh shell.",
              workflow_promotion: {
                promotion_state: "candidate",
                promotion_origin: "execution_write_auto_promotion",
                required_observations: 2,
                observed_count: 2,
                last_transition: "candidate_observed",
                last_transition_at: "2026-03-20T00:00:00Z",
                source_status: "failed",
              },
            },
            workflow_promotion: {
              promotion_state: "candidate",
              promotion_origin: "execution_write_auto_promotion",
              required_observations: 2,
              observed_count: 2,
              last_transition: "candidate_observed",
              last_transition_at: "2026-03-20T00:00:00Z",
              source_status: "failed",
            },
            authority_gate_v1: {
              gate_version: "runtime_authority_gate_v1",
              requested_trust: "authoritative",
              effective_trust: "advisory",
              status: "insufficient",
              allows_authoritative: false,
              allows_stable_promotion: false,
              reasons: ["execution_evidence:after_exit_revalidation_failed"],
              outcome_contract_gate: {
                status: "sufficient",
                requested_trust: "authoritative",
                allows_authoritative: true,
                reasons: [],
              },
              execution_evidence_assessment: {
                schema_version: "execution_evidence_assessment_v1",
                status: "failed",
                requested_trust: "authoritative",
                effective_trust: "advisory",
                allows_stable_promotion: false,
                reasons: ["after_exit_revalidation_failed"],
                decisive_fields: {
                  false_confidence_detected: true,
                },
              },
            },
            execution_evidence_assessment: {
              schema_version: "execution_evidence_assessment_v1",
              status: "failed",
              requested_trust: "authoritative",
              effective_trust: "advisory",
              allows_stable_promotion: false,
              reasons: ["after_exit_revalidation_failed"],
              decisive_fields: {
                false_confidence_detected: true,
              },
            },
          },
          embedding: sharedEmbedding,
          embedding_model: DeterministicEmbeddingProvider.name,
          salience: 0.72,
          importance: 0.82,
          confidence: 0.74,
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
  sealAuthorityReceiptsForPreparedWrite(prepared);
  await liteWriteStore.withTx(() =>
    applyMemoryWrite(prepared, {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      associativeLinkOrigin: "memory_write",
      write_access: liteWriteStore,
    }),
  );
}

test("policy learning_control contract keeps highest-priority action surface coherent", () => {
  const experienceExecutionContract = buildExecutionContractFromProjection({
    contract_trust: "advisory",
    task_family: "task:policy_surface_merge",
    workflow_signature: "execution_workflow:experience",
    selected_tool: "edit",
    file_path: "src/routes/experience.ts",
    target_files: ["src/routes/experience.ts"],
    next_action: "Experience next action",
    workflow_steps: ["experience step"],
    acceptance_checks: ["npm run -s test:experience"],
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "execution_contract_v1",
      source_anchor: "experience",
      evidence_refs: [],
      notes: [],
    },
  });
  const policyContract = PolicyContractSchema.parse({
    summary_version: "policy_contract_v1",
    policy_kind: "tool_preference",
    source_kind: "stable_workflow",
    policy_state: "stable",
    contract_trust: "authoritative",
    policy_memory_state: "active",
    activation_mode: "default",
    materialization_state: "persisted",
    history_applied: true,
    selected_tool: "edit",
    avoid_tools: [],
    task_family: "task:policy_surface_merge",
    workflow_signature: "execution_workflow:policy",
    file_path: "src/routes/policy.ts",
    target_files: ["src/routes/policy.ts"],
    next_action: "Policy next action",
    workflow_steps: ["policy step"],
    pattern_hints: ["policy hint"],
    rehydration_mode: null,
    confidence: 0.91,
    source_anchor_ids: ["policy-anchor"],
    policy_memory_id: "policy-memory-1",
    reason: "persisted policy should override lower-priority experience fields",
  });
  const derivedPolicy = {
    summary_version: "derived_policy_v1",
    policy_kind: "tool_preference",
    source_kind: "stable_workflow",
    policy_state: "stable",
    contract_trust: "authoritative",
    selected_tool: "edit",
    task_family: "task:policy_surface_merge",
    workflow_signature: "execution_workflow:derived",
    policy_memory_id: "policy-memory-1",
    file_path: "src/routes/derived.ts",
    target_files: ["src/routes/derived.ts"],
    workflow_steps: ["derived step"],
    pattern_hints: ["derived hint"],
    confidence: 0.94,
    supporting_anchor_ids: ["derived-anchor"],
    reason: "fresh derived policy should be the highest-priority action surface",
    evidence: {
      trusted_pattern_count: 1,
      stable_workflow_count: 1,
      usage_count: 2,
      reuse_success_count: 2,
      reuse_failure_count: 0,
      feedback_quality: null,
    },
  };
  const policyReview = PolicyReviewSummarySchema.parse({
    summary_version: "policy_review_summary_v1",
    persisted_policy_count: 1,
    active_policy_count: 1,
    contested_policy_count: 0,
    retired_policy_count: 0,
    review_recommended: false,
    selected_policy_memory_id: "policy-memory-1",
    selected_policy_memory_state: "active",
    attention_policy: null,
  });

  const learning_control = buildPolicyLearningControlContract({
    policyReview,
    policyContract,
    experienceExecutionContract,
    derivedPolicy,
  });

  assert.equal(learning_control.action, "monitor");
  assert.equal(learning_control.execution_contract_v1?.file_path, "src/routes/derived.ts");
  assert.deepEqual(learning_control.execution_contract_v1?.target_files, ["src/routes/derived.ts"]);
  assert.deepEqual(learning_control.execution_contract_v1?.workflow_steps, ["derived step"]);
  assert.deepEqual(learning_control.execution_contract_v1?.pattern_hints, ["derived hint"]);
});

test("memory evolution review-pack route exposes stable workflow and reviewer-friendly contract", async () => {
  const dbPath = tmpDbPath("evolution-review-pack");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });
    await seedEvolutionFixture(dbPath);

    for (const payload of [
      {
        tenant_id: "default",
        scope: "default",
        run_id: "run:evolution-repair-001",
        route_role: "patch",
        task_family: "task:workflow_validation_recovery",
        delegation_records_v1: {
          summary_version: "execution_delegation_records_v1",
          record_mode: "packet_backed",
          route_role: "patch",
          packet_count: 1,
          return_count: 1,
          artifact_routing_count: 2,
          missing_record_types: [],
          delegation_packets: [{
            version: 1,
            role: "patch",
            mission: "Apply the validated workflow change and rerun required checks.",
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            output_contract: "Return patch result and final node test status.",
            preferred_artifact_refs: ["artifact://workflow-validation-recovery/patch"],
            inherited_evidence: ["evidence://workflow-validation-recovery/failure"],
            routing_reason: "repair patch route",
            task_family: "task:workflow_validation_recovery",
            family_scope: "aionis://runtime/workflow-validation-recovery",
            source_mode: "packet_backed",
          }],
          delegation_returns: [{
            version: 1,
            role: "patch",
            status: "passed",
            summary: "Patch applied and export tests passed.",
            evidence: ["evidence://workflow-validation-recovery/test"],
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            source_mode: "packet_backed",
          }],
          artifact_routing_records: [{
            version: 1,
            ref: "artifact://workflow-validation-recovery/patch",
            ref_kind: "artifact",
            route_role: "patch",
            route_intent: "patch",
            route_mode: "packet_backed",
            task_family: "task:workflow_validation_recovery",
            family_scope: "aionis://runtime/workflow-validation-recovery",
            routing_reason: "patch artifact route",
            source: "execution_packet",
          }, {
            version: 1,
            ref: "evidence://workflow-validation-recovery/test",
            ref_kind: "evidence",
            route_role: "patch",
            route_intent: "patch",
            route_mode: "packet_backed",
            task_family: "task:workflow_validation_recovery",
            family_scope: "aionis://runtime/workflow-validation-recovery",
            routing_reason: "patch evidence route",
            source: "execution_packet",
          }],
        },
        execution_result_summary: {
          status: "passed",
          summary: "Patch applied and export tests passed.",
        },
        execution_artifacts: [{ ref: "artifact://workflow-validation-recovery/patch" }],
        execution_evidence: [{ ref: "evidence://workflow-validation-recovery/test" }],
      },
      {
        tenant_id: "default",
        scope: "default",
        memory_lane: "private",
        run_id: "run:evolution-repair-002",
        route_role: "patch",
        task_family: "task:workflow_validation_recovery",
        delegation_records_v1: {
          summary_version: "execution_delegation_records_v1",
          record_mode: "memory_only",
          route_role: "patch",
          packet_count: 1,
          return_count: 0,
          artifact_routing_count: 1,
          missing_record_types: ["delegation_returns"],
          delegation_packets: [{
            version: 1,
            role: "patch",
            mission: "Apply the export recovery patch before retrying tests.",
            working_set: ["src/routes/export.ts"],
            acceptance_checks: ["npm run -s test:lite -- export"],
            output_contract: "Return applied patch metadata.",
            preferred_artifact_refs: ["artifact://workflow-validation-recovery/recovery-patch"],
            inherited_evidence: [],
            routing_reason: "recovery memory patch route",
            task_family: "task:workflow_validation_recovery",
            family_scope: "aionis://runtime/workflow-validation-recovery",
            source_mode: "memory_only",
          }],
          delegation_returns: [],
          artifact_routing_records: [{
            version: 1,
            ref: "artifact://workflow-validation-recovery/recovery-patch",
            ref_kind: "artifact",
            route_role: "patch",
            route_intent: "memory_guided",
            route_mode: "memory_only",
            task_family: "task:workflow_validation_recovery",
            family_scope: "aionis://runtime/workflow-validation-recovery",
            routing_reason: "memory-guided patch route",
            source: "strategy_summary",
          }],
        },
      },
    ]) {
      const writeResponse = await app.inject({
        method: "POST",
        url: "/v1/memory/delegation/records",
        payload,
      });
      assert.equal(writeResponse.statusCode, 200, writeResponse.body);
    }

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/evolution/review-pack",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "recover durable workflow from failed validation",
        context: {
          task_kind: "workflow_validation_recovery",
          error: {
            signature: "workflow-validation-mismatch",
          },
          task: { id: "task-1", brief: "workflow validation recovery route" },
        },
        candidates: ["edit", "bash", "test"],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const parsed = EvolutionReviewPackResponseSchema.parse(JSON.parse(response.body));
    assert.equal(parsed.evolution_review_pack.pack_version, "evolution_review_pack_v1");
    assert.equal(parsed.evolution_review_pack.review_contract.selected_tool, "edit");
    assert.equal(parsed.evolution_review_pack.review_contract.file_path, "src/routes/export.ts");
    assert.equal(
      parsed.evolution_review_pack.review_contract.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );
    assert.equal(
      parsed.evolution_review_pack.review_contract.execution_contract_v1?.selected_tool,
      "edit",
    );
    assert.equal(
      parsed.evolution_review_pack.review_contract.execution_contract_v1?.file_path,
      "src/routes/export.ts",
    );
    assert.equal(
      parsed.evolution_review_pack.review_contract.execution_contract_v1?.workflow_signature,
      "execution_workflow:workflow-validation-recovery",
    );
    assert.ok(parsed.evolution_review_pack.stable_workflow);
    assert.equal(parsed.evolution_review_pack.promotion_ready_workflow, null);
    assert.equal(parsed.evolution_review_pack.derived_policy?.selected_tool, "edit");
    assert.equal(parsed.evolution_review_pack.policy_contract?.selected_tool, "edit");
    assert.equal(parsed.evolution_review_pack.policy_learning_control_contract.action, "none");
    assert.equal(
      parsed.evolution_review_pack.policy_learning_control_contract.execution_contract_v1?.schema_version,
      "execution_contract_v1",
    );
    assert.equal(
      parsed.evolution_review_pack.policy_learning_control_contract.execution_contract_v1?.selected_tool,
      "edit",
    );
    assert.equal(
      parsed.evolution_review_pack.policy_learning_control_contract.execution_contract_v1?.file_path,
      "src/routes/export.ts",
    );
    assert.equal(parsed.evolution_review_pack.policy_review.persisted_policy_count, 0);
    assert.ok(parsed.evolution_review_pack.review_contract.trusted_pattern_anchor_ids.length >= 1);
    const authoritySummary = (parsed.evolution_review_pack as any).authority_visibility_summary;
    assert.equal(authoritySummary.authoritative_blocked_count, 1);
    assert.equal(authoritySummary.execution_evidence_failed_count, 1);
    assert.deepEqual(authoritySummary.top_blockers, [
      "execution_evidence:after_exit_revalidation_failed",
      "outcome_contract:missing_verifiable_success_outcome",
    ]);
    const authorityBlockers = (parsed.evolution_review_pack as any).authority_blockers as Array<Record<string, unknown>>;
    assert.equal(authorityBlockers.length, 1);
    assert.equal(authorityBlockers[0]?.primary_blocker, "execution_evidence:after_exit_revalidation_failed");
    assert.equal((parsed.evolution_review_pack.review_contract as any).authority_visibility_summary.authoritative_blocked_count, 1);
    assert.equal((parsed.evolution_review_pack.review_contract as any).authority_blockers[0]?.execution_evidence_status, "failed");
    assert.deepEqual(parsed.evolution_review_pack.review_contract.promotion_ready_anchor_ids, []);
    assert.deepEqual(parsed.evolution_review_pack.learning_summary, {
      task_family: "task:workflow_validation_recovery",
      matched_records: 2,
      truncated: false,
      route_role_counts: {
        patch: 2,
      },
      record_outcome_counts: {
        completed: 1,
        missing_return: 1,
      },
      recommendation_count: 3,
    });
    assert.deepEqual(
      parsed.evolution_review_pack.learning_recommendations.map((entry) => entry.recommendation_kind),
      ["capture_missing_returns", "increase_artifact_capture", "promote_reusable_pattern"],
    );
    assert.equal(
      parsed.evolution_review_pack.learning_recommendations[0]?.recommended_action,
      "Capture delegation returns consistently for patch / task:workflow_validation_recovery.",
    );
    assert.equal(
      parsed.evolution_review_pack.learning_recommendations[2]?.sample_mission,
      "Apply the validated workflow change and rerun required checks.",
    );
  } finally {
    await app.close();
  }
});
