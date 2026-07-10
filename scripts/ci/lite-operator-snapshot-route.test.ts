import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerOperatorSnapshotRoutes } from "../../src/routes/operator-snapshot.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";

function liteEnv() {
  return {
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
  } as any;
}

function registerApp() {
  const app = Fastify();
  registerRuntimeErrorHandler(app);
  registerOperatorSnapshotRoutes({
    app,
    env: liteEnv(),
    requireMemoryPrincipal: async () => null,
    withIdentityFromRequest: (_req, body) => body,
    enforceRateLimit: async () => {},
    enforceTenantQuota: async () => {},
    tenantFromBody: (body) => {
      const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      return typeof record.tenant_id === "string" ? record.tenant_id : "default";
    },
    acquireInflightSlot: async () => ({ release() {} }),
  });
  return app;
}

function agentContext() {
  return {
    contract_version: "aionis_agent_context_v1",
    tenant_id: "default",
    scope: "default",
    agent_role: "reviewer",
    prompt_text: [
      "AIONIS_AGENT_CONTEXT v1",
      "use_now",
      "- MULTI_AGENT_SNAPSHOT_PASSED continue scoped branch and avoid MULTI_AGENT_SNAPSHOT_FAILED.",
      "do_not_use",
      "- MULTI_AGENT_SNAPSHOT_FAILED broad retry failed verifier checks.",
    ].join("\n"),
    summary: "Reviewer should continue the passed branch and avoid the failed branch.",
    history_used: true,
    actionable_history_used: true,
    recommended_posture: "reuse_supported_history",
    authority: "advisory",
    target_files: ["src/current-target.ts"],
    use_now: ["MULTI_AGENT_SNAPSHOT_PASSED continue scoped branch and avoid MULTI_AGENT_SNAPSHOT_FAILED."],
    inspect_before_use: [],
    do_not_use: ["MULTI_AGENT_SNAPSHOT_FAILED broad retry failed verifier checks."],
    memory_ids: ["mem-passed", "mem-failed"],
    use_now_memory_ids: ["mem-passed"],
    inspect_before_use_memory_ids: [],
    do_not_use_memory_ids: ["mem-failed"],
    rehydrate_hints: [],
    risk: {
      negative_transfer_risk: "medium",
      blocked_authority_count: 1,
      stale_memory_count: 0,
      reasons: [
        "failed_execution_branches_kept_out_of_use_now",
        "premise_firewall_query_conflicts_with_current_memory",
        "memory_contract_evidence_only_kept_out_of_use_now",
      ],
    },
    evidence_refs: {
      memory_ids: ["mem-passed", "mem-failed"],
      workflow_ids: ["wf-checkout-reviewer"],
      evidence_count: 2,
    },
  };
}

function executionContext() {
  return {
    contract_version: "execution_evidence_context_v1",
    context_mode: "full_power",
    current_active_path: {
      compressed_state: [
        {
          node_id: "active-1",
          memory_id: "mem-active",
          title: "Active reviewer continuation",
          summary: "MULTI_AGENT_SNAPSHOT_PASSED reviewer continues scoped branch.",
          supporting_raw_refs: ["trace://snapshot/passed/raw"],
        },
      ],
    },
    passed_solutions: [
      {
        source: "execution_tree",
        node_id: "passed-1",
        memory_id: "mem-passed",
        title: "Passed scoped patch",
        summary: "MULTI_AGENT_SNAPSHOT_PASSED scoped patch passed verifier replay.",
        evidence_refs: ["evidence://snapshot/passed"],
      },
    ],
    failed_branches: [
      {
        source: "execution_tree",
        node_id: "failed-1",
        memory_id: "mem-failed",
        title: "Failed broad retry",
        summary: "MULTI_AGENT_SNAPSHOT_FAILED broad retry failed verifier replay.",
        supporting_raw_refs: ["trace://snapshot/failed/raw"],
      },
    ],
    selection_trace: {
      memory_consolidation_guard_blocked_count: 1,
      supporting_only_count: 1,
    },
    prompt_text: [
      "CURRENT_ACTIVE_PATH",
      "- MULTI_AGENT_SNAPSHOT_PASSED reviewer continues scoped branch.",
      "PASSED_SOLUTIONS",
      "- MULTI_AGENT_SNAPSHOT_PASSED scoped patch passed verifier replay.",
      "FAILED_BRANCHES",
      "- MULTI_AGENT_SNAPSHOT_FAILED broad retry failed verifier replay.",
      "SUPPORTING_EVIDENCE",
      "- promotion_blocked=memory_execution_summary_without_raw_or_evidence_refs",
    ].join("\n"),
    agent_context: agentContext(),
  };
}

function claimLedgerProjection() {
  return {
    contract_version: "aionis_claim_ledger_projection_v1",
    use_now: [{
      claim_id: "claim-current-target",
      slot_key: "project:checkout.active_execution_target",
      subject_key: "project:checkout",
      predicate: "active_execution_target",
      surface: "use_now",
      reason_code: "claim_ledger_live_singleton",
      value_text: "The current accepted target is src/current-target.ts.",
      authority: "trusted",
      status: "active",
      confidence: 0.94,
      evidence_refs: ["run:claim-current"],
      source_memory_id: null,
      valid_from: "2026-06-17T00:00:00.000Z",
      valid_until: null,
      superseded_by_claim_id: null,
    }],
    inspect_before_use: [],
    do_not_use: [{
      claim_id: "claim-old-target",
      slot_key: "project:checkout.active_execution_target",
      subject_key: "project:checkout",
      predicate: "active_execution_target",
      surface: "do_not_use",
      reason_code: "claim_ledger_superseded",
      value_text: "The old target was src/legacy-target.ts.",
      authority: "advisory",
      status: "superseded",
      confidence: 0.72,
      evidence_refs: ["run:claim-old"],
      source_memory_id: null,
      valid_from: "2026-06-16T00:00:00.000Z",
      valid_until: "2026-06-17T00:00:00.000Z",
      superseded_by_claim_id: "claim-current-target",
    }],
    audit_only: [],
    blocked_superseded_count: 1,
    live_claim_count: 1,
    contested_claim_count: 0,
    agent_prompt_included: false,
    runtime_mutation: false,
  };
}

test("operator snapshot route reports branch isolation and markdown without mutating runtime", async () => {
  const app = registerApp();
  const projection = claimLedgerProjection();
  const response = await app.inject({
    method: "POST",
    url: "/v1/operator/snapshot",
    payload: {
      tenant_id: "default",
      scope: "default",
      run_id: "run-operator-snapshot",
      task_signature: "multi-agent-snapshot",
      task_family: "multi_agent_execution_memory",
      workflow_signature: "planner-worker-verifier-reviewer",
      agent_context: agentContext(),
      execution_context: executionContext(),
      claim_ledger_projection: projection,
      guide_trace_id: "guide_trace:snapshot",
      include_markdown: true,
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.contract_version, "aionis_operator_snapshot_result_v1");
  assert.equal(body.operator_snapshot.contract_version, "aionis_operator_snapshot_v1");
  assert.equal(body.operator_snapshot.agent_prompt_included, false);
  assert.equal(body.operator_snapshot.runtime_mutation, false);
  assert.equal(body.operator_snapshot.task.agent_role, "reviewer");
  assert.equal(body.operator_snapshot.execution_state.branch_isolation.status, "pass");
  assert.equal(body.operator_snapshot.execution_state.actionable_history_used, true);
  assert.equal(body.operator_snapshot.execution_state.branch_isolation.failed_branch_leaked_to_use_now, false);
  assert.equal(body.operator_snapshot.execution_state.failed_branches.count, 1);
  assert.equal(body.operator_snapshot.memory_lifecycle.consolidation_guard.promotion_blocked_count, 1);
  assert.equal(body.operator_snapshot.guide_trace.guide_trace_id, "guide_trace:snapshot");
  assert.equal(body.operator_snapshot.memory_use_receipt.contract_version, "aionis_memory_use_receipt_v1");
  assert.equal(body.operator_snapshot.memory_use_receipt.agent_prompt_included, false);
  assert.equal(body.operator_snapshot.memory_use_receipt.runtime_mutation, false);
  assert.deepEqual(body.operator_snapshot.memory_use_receipt.use_now_memory_ids, ["mem-passed"]);
  assert.deepEqual(body.operator_snapshot.memory_use_receipt.do_not_use_memory_ids, ["mem-failed"]);
  assert.ok(body.operator_snapshot.memory_use_receipt.risk_flags.includes("premise_firewall_query_risk"));
  assert.ok(body.operator_snapshot.memory_use_receipt.risk_flags.includes("memory_contract_risk"));
  assert.equal(body.operator_snapshot.judgment_calibration.contract_version, "aionis_judgment_calibration_summary_v1");
  assert.equal(body.operator_snapshot.judgment_calibration.agent_prompt_included, false);
  assert.equal(body.operator_snapshot.judgment_calibration.runtime_mutation, false);
  assert.equal(body.operator_snapshot.judgment_calibration.authority, "read_only");
  assert.equal(body.operator_snapshot.trace_to_procedure.present, true);
  assert.equal(body.operator_snapshot.trace_to_procedure.runtime_mutation, false);
  assert.equal(body.operator_snapshot.trace_to_procedure.candidate_visible, true);
  assert.equal(body.operator_snapshot.trace_to_procedure.stable_reuse_visible, false);
  assert.equal(body.operator_snapshot.trace_to_procedure.promotion_status, "blocked");
  assert.equal(body.operator_snapshot.trace_to_procedure.promotion_blocked_count, 1);
  assert.ok(body.operator_snapshot.trace_to_procedure.source_surfaces.includes("execution_tree"));
  assert.ok(body.operator_snapshot.trace_to_procedure.source_surfaces.includes("workflow_projection"));
  assert.ok(body.operator_snapshot.trace_to_procedure.source_surfaces.includes("promotion_evidence"));
  assert.ok(body.operator_snapshot.trace_to_procedure.procedure_memory_ids.includes("mem-passed"));
  assert.ok(body.operator_snapshot.trace_to_procedure.workflow_ids.includes("wf-checkout-reviewer"));
  assert.equal(body.operator_snapshot.claim_ledger_projection.contract_version, "aionis_claim_ledger_projection_v1");
  assert.equal(body.operator_snapshot.claim_ledger_projection.use_now[0].claim_id, "claim-current-target");
  assert.equal(body.operator_snapshot.claim_ledger_projection.do_not_use[0].claim_id, "claim-old-target");
  assert.equal(body.operator_snapshot.claim_ledger_projection.agent_prompt_included, false);
  assert.equal(body.operator_snapshot.claim_ledger_projection.runtime_mutation, false);
  assert.ok(body.operator_snapshot.claims.some((claim: Record<string, unknown>) =>
    claim.claim === "memory_use_receipt_visible"
    && claim.status === "pass"
  ));
  assert.ok(body.operator_snapshot.claims.some((claim: Record<string, unknown>) =>
    claim.claim === "judgment_calibration_visible"
    && claim.status === "not_applicable"
  ));
  assert.ok(body.operator_snapshot.claims.some((claim: Record<string, unknown>) =>
    claim.claim === "trace_to_procedure_visible"
    && claim.status === "pass"
  ));
  assert.ok(body.operator_snapshot.claims.some((claim: Record<string, unknown>) =>
    claim.claim === "claim_ledger_projection_visible"
    && claim.status === "pass"
  ));
  assert.ok(body.source_map.internal_surfaces_used.includes("memory_use_receipt"));
  assert.ok(body.source_map.internal_surfaces_used.includes("trace_to_procedure_projection"));
  assert.ok(body.source_map.internal_surfaces_used.includes("claim_ledger_projection"));
  assert.match(body.markdown, /Aionis Operator Snapshot/);
  assert.match(body.markdown, /Memory Use Receipt/);
  assert.match(body.markdown, /Claim Ledger Projection/);
  assert.match(body.markdown, /claim-current-target/);
  assert.match(body.markdown, /Judgment Calibration/);
  assert.match(body.markdown, /Trace to Procedure/);
  assert.match(body.markdown, /MULTI_AGENT_SNAPSHOT_FAILED/);

  await app.close();
});

test("operator snapshot route detects a failed branch leaked through structured memory attribution", async () => {
  const app = registerApp();
  const leakingAgentContext = agentContext();
  leakingAgentContext.use_now = ["Continue the scoped branch."];
  leakingAgentContext.use_now_memory_ids = ["mem-passed", "mem-failed"];
  const response = await app.inject({
    method: "POST",
    url: "/v1/operator/snapshot",
    payload: {
      tenant_id: "default",
      scope: "default",
      run_id: "run-operator-snapshot-structured-leak",
      agent_context: leakingAgentContext,
      execution_context: executionContext(),
    },
  });

  assert.equal(response.statusCode, 200);
  const isolation = response.json().operator_snapshot.execution_state.branch_isolation;
  assert.equal(isolation.status, "fail");
  assert.equal(isolation.failed_branch_leaked_to_use_now, true);

  await app.close();
});
