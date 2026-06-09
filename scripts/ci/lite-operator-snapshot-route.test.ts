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
      "- MULTI_AGENT_SNAPSHOT_PASSED continue scoped branch.",
      "do_not_use",
      "- MULTI_AGENT_SNAPSHOT_FAILED broad retry failed verifier checks.",
    ].join("\n"),
    summary: "Reviewer should continue the passed branch and avoid the failed branch.",
    history_used: true,
    actionable_history_used: true,
    recommended_posture: "reuse_supported_history",
    authority: "advisory",
    target_files: ["src/current-target.ts"],
    use_now: ["MULTI_AGENT_SNAPSHOT_PASSED continue scoped branch."],
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
      workflow_ids: [],
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
        title: "Passed scoped patch",
        summary: "MULTI_AGENT_SNAPSHOT_PASSED scoped patch passed verifier replay.",
        evidence_refs: ["evidence://snapshot/passed"],
      },
    ],
    failed_branches: [
      {
        source: "execution_tree",
        node_id: "failed-1",
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

test("operator snapshot route reports branch isolation and markdown without mutating runtime", async () => {
  const app = registerApp();
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
  assert.ok(body.operator_snapshot.claims.some((claim: Record<string, unknown>) =>
    claim.claim === "memory_use_receipt_visible"
    && claim.status === "pass"
  ));
  assert.ok(body.source_map.internal_surfaces_used.includes("memory_use_receipt"));
  assert.match(body.markdown, /Aionis Operator Snapshot/);
  assert.match(body.markdown, /Memory Use Receipt/);
  assert.match(body.markdown, /MULTI_AGENT_SNAPSHOT_FAILED/);

  await app.close();
});
