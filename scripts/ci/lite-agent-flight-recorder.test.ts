import assert from "node:assert/strict";
import test from "node:test";
import { buildAionisAgentFlightRecorderReport } from "../../src/memory/agent-flight-recorder.ts";
import { buildAionisMemoryDecisionTrace } from "../../src/memory/product-output-assembler.ts";
import { AionisAgentContextSchema } from "../../src/memory/product-output-contract.ts";

function validAgentContext() {
  return AionisAgentContextSchema.parse({
    contract_version: "aionis_agent_context_v1",
    tenant_id: "tenant-local",
    scope: "repo-a",
    agent_role: "reviewer",
    prompt_text: "AIONIS_AGENT_CONTEXT v1\nuse mem-current; avoid mem-failed.",
    summary: "Continue current state and avoid failed branch.",
    history_used: true,
    actionable_history_used: true,
    recommended_posture: "reuse_supported_history",
    authority: "trusted",
    target_files: ["src/index.ts"],
    use_now: ["Continue accepted route."],
    inspect_before_use: [],
    do_not_use: ["Avoid failed legacy route."],
    memory_ids: ["mem-current", "mem-failed", "mem-archive"],
    use_now_memory_ids: ["mem-current"],
    inspect_before_use_memory_ids: [],
    do_not_use_memory_ids: ["mem-failed"],
    command_posture: [
      {
        posture: "should_continue",
        surface: "use_now",
        memory_id: "mem-current",
        instruction: "Continue accepted route.",
        reason: "Trusted current memory.",
        target_files: ["src/index.ts"],
      },
      {
        posture: "must_not",
        surface: "do_not_use",
        memory_id: "mem-failed",
        instruction: "Do not reuse failed legacy route.",
        reason: "Failed branch is counter-evidence.",
        target_files: ["src/legacy.ts"],
      },
    ],
    route_contract: {
      active_targets: [
        {
          target: "src/index.ts",
          source_memory_id: "mem-current",
          source: "should_continue",
          artifact_status: "unknown",
          missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          reason: "Trusted current memory.",
        },
      ],
      pending_artifacts: [],
      reference_only_targets: [],
      blocked_direction_targets: [
        {
          target: "src/legacy.ts",
          source_memory_id: "mem-failed",
          source: "must_not",
          reason: "Failed branch is counter-evidence.",
        },
      ],
      evidence_sources: [],
      blocked_routes: [
        {
          target: "src/legacy.ts",
          source_memory_id: "mem-failed",
          source: "must_not",
          direction_policy: "blocked_route",
          evidence_use: "counter_evidence_only",
          reason: "Failed branch is counter-evidence.",
        },
      ],
      conflict_policy: "do_not_treat_missing_active_target_as_superseded",
      fallback_policy: "do_not_promote_reference_or_blocked_targets",
      action_policy: {
        missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"],
        terminal_inspect_allowed: false,
        reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
      },
    },
    prompt_aliases: [
      {
        alias: "Current route",
        memory_id: "mem-current",
        surface: "current",
      },
      {
        alias: "Failed route",
        memory_id: "mem-failed",
        surface: "avoid",
      },
    ],
    rehydrate_hints: [
      {
        memory_id: "mem-archive",
        reason: "Open archived payload before exact use.",
        required: true,
      },
    ],
    risk: {
      negative_transfer_risk: "medium",
      blocked_authority_count: 1,
      stale_memory_count: 0,
      reasons: ["failed_branch_is_counter_evidence"],
    },
    evidence_refs: {
      memory_ids: ["mem-current", "mem-failed"],
      workflow_ids: [],
      evidence_count: 2,
    },
  });
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
      value_text: "The current accepted target is src/index.ts.",
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
      value_text: "The old target was src/legacy.ts.",
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

test("agent flight recorder builds read-only replay from context, trace, receipt, and feedback", () => {
  const agentContext = validAgentContext();
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      agent_context: agentContext,
    },
    forget_result: {
      operation: "activate",
      run_id: "run-1",
      outcome: "positive",
      used_surface: "use_now",
      memory_ids: ["mem-current"],
      used_memory_ids: ["mem-current"],
    },
    source_map: {
      routes_used: ["/v1/measure"],
    },
  });
  const admissionRecord = {
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "memory_decision_trace",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: "tenant-local",
    scope: "repo-a",
    guide_trace_id: "guide-trace-1",
    prompt_char_count: agentContext.prompt_text.length,
    history_used: true,
    actionable_history_used: true,
    candidate_memory_count: 2,
    prompt_included_memory_count: 2,
    agent_used_memory_count: 1,
    entries: [
      {
        memory_id: "mem-current",
        title: "Current route",
        domain: "execution",
        memory_type: "execution_memory",
        lifecycle_state: "active",
        authority: "trusted",
        admission_action: "use_now",
        decision_kind: "used",
        actionable: true,
        prompt_included: true,
        agent_used: true,
        feedback_outcome: "positive",
        attribution_strength: "positive_attribution",
        reason_codes: ["trusted_current"],
        evidence_ids: ["ev-current"],
      },
      {
        memory_id: "mem-failed",
        title: "Failed route",
        domain: "execution",
        memory_type: "execution_memory",
        lifecycle_state: "suppressed",
        authority: "blocked",
        admission_action: "do_not_use",
        decision_kind: "blocked",
        actionable: false,
        prompt_included: true,
        agent_used: false,
        feedback_outcome: null,
        attribution_strength: null,
        reason_codes: ["failed_branch_counter_evidence"],
        evidence_ids: ["ev-failed"],
      },
    ],
    summary: "Admission replay test record.",
  };

  const report = buildAionisAgentFlightRecorderReport({
    tenant_id: "tenant-local",
    scope: "repo-a",
    guide_trace_id: "guide-trace-1",
    run_id: "run-1",
    agent_context: agentContext,
    memory_decision_trace: trace,
    memory_use_receipt: trace.memory_use_receipt,
    memory_admission_record: admissionRecord,
    claim_ledger_projection: claimLedgerProjection(),
    feedback_result: {
      run_id: "run-1",
      outcome: "positive",
      used_memory_ids: ["mem-current"],
    },
    now: "2026-06-13T00:00:00.000Z",
    source_map: {
      routes_used: ["/v1/audit/flight-recorder"],
    },
  });

  assert.equal(report.contract_version, "aionis_agent_flight_recorder_report_v1");
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_view.prompt_text_included, false);
  assert.deepEqual(report.agent_view.use_now_memory_ids, ["mem-current"]);
  assert.deepEqual(report.agent_view.do_not_use_memory_ids, ["mem-failed"]);
  assert.deepEqual(report.agent_view.rehydrate_memory_ids, ["mem-archive"]);
  assert.equal(report.blocked_or_suppressed.some((entry) => entry.memory_id === "mem-failed"), true);
  assert.equal(report.attribution.present, true);
  assert.deepEqual(report.attribution.used_memory_ids, ["mem-current"]);
  assert.equal(report.replay_sources.has_agent_context, true);
  assert.equal(report.replay_sources.has_memory_decision_trace, true);
  assert.equal(report.replay_sources.has_memory_use_receipt, true);
  assert.equal(report.replay_sources.has_memory_admission_record, true);
  assert.equal(report.claim_ledger_projection?.use_now[0]?.claim_id, "claim-current-target");
  assert.equal(report.claim_ledger_projection?.do_not_use[0]?.claim_id, "claim-old-target");
  assert.equal(report.claim_ledger_projection?.agent_prompt_included, false);
  assert.equal(report.claim_ledger_projection?.runtime_mutation, false);
  assert.ok(report.claims.some((claim) =>
    claim.claim === "claim_ledger_projection_replayable"
    && claim.status === "pass"
  ));
  assert.ok(report.source_map.internal_surfaces_used.includes("claim_ledger_projection"));
  assert.equal(JSON.stringify(report).includes("AIONIS_AGENT_CONTEXT v1"), false);
});
