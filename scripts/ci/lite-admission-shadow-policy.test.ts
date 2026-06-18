import assert from "node:assert/strict";
import test from "node:test";
import {
  AIONIS_ADMISSION_SHADOW_POLICY_ID,
  buildAionisMemoryAdmissionShadowPolicyReport,
  buildAionisMemoryAdmissionShadowPolicyReportFromRecord,
} from "../../src/memory/admission-shadow-policy.js";
import { parseAionisMemoryAdmissionRecord } from "../../src/memory/product-output-contract.js";

test("admission shadow policy downgrades unsafe direct-use candidates without runtime mutation", () => {
  const report = buildAionisMemoryAdmissionShadowPolicyReport({
    source: "memory_admission_record",
    entries: [
      {
        memory_id: "mem-current-project",
        title: "Current project context",
        memory_origin: "aionis",
        source_backend: "aionis",
        memory_type: "project_context",
        recorded_action: "use_now",
        closed_loop_effect_state: "supported",
      },
      {
        memory_id: "mem-procedure",
        title: "Procedure memory",
        memory_origin: "aionis",
        source_backend: "aionis",
        memory_type: "procedure",
        recorded_action: "use_now",
      },
      {
        memory_id: "mem-mem0",
        title: "External memory",
        memory_origin: "external",
        source_backend: "mem0",
        memory_type: "project_context",
        recorded_action: "use_now",
      },
      {
        memory_id: "mem-prior-negative",
        title: "Repeated negative posture",
        memory_origin: "aionis",
        source_backend: "aionis",
        memory_type: "project_context",
        recorded_action: "use_now",
        closed_loop_effect_state: "mixed",
        repeated_negative_posture: true,
      },
    ],
  });

  assert.equal(report.contract_version, "aionis_memory_admission_shadow_policy_report_v1");
  assert.equal(report.policy_id, AIONIS_ADMISSION_SHADOW_POLICY_ID);
  assert.equal(report.mode, "shadow_only");
  assert.equal(report.runtime_mutation, false);
  assert.equal(report.agent_prompt_included, false);
  assert.equal(report.hard_boundary_upgrade_count, 0);
  assert.equal(report.direct_use_recorded_count, 4);
  assert.equal(report.direct_use_shadow_count, 1);
  assert.deepEqual(report.downgraded_memory_ids, ["mem-procedure", "mem-mem0", "mem-prior-negative"]);
  assert.equal(
    report.decisions.find((entry) => entry.memory_id === "mem-current-project")?.shadow_action,
    "use_now",
  );
  assert.equal(
    report.decisions.find((entry) => entry.memory_id === "mem-prior-negative")?.reason_codes.includes(
      "closed_loop_counter_signal_shadow_inspect",
    ),
    true,
  );
});

test("admission shadow policy preserves Runtime hard boundaries", () => {
  const report = buildAionisMemoryAdmissionShadowPolicyReport({
    source: "memory_admission_record",
    entries: [
      {
        memory_id: "mem-inspect",
        memory_type: "project_context",
        recorded_action: "inspect_before_use",
      },
      {
        memory_id: "mem-blocked",
        memory_type: "project_context",
        recorded_action: "do_not_use",
      },
      {
        memory_id: "mem-rehydrate",
        memory_type: "project_context",
        recorded_action: "rehydrate",
      },
    ],
  });

  assert.equal(report.hard_boundary_upgrade_count, 0);
  assert.equal(report.direct_use_shadow_count, 0);
  assert.deepEqual(
    report.decisions.map((entry) => [entry.memory_id, entry.recorded_action, entry.shadow_action]),
    [
      ["mem-inspect", "inspect_before_use", "inspect_before_use"],
      ["mem-blocked", "do_not_use", "do_not_use"],
      ["mem-rehydrate", "rehydrate", "rehydrate"],
    ],
  );
});

test("admission shadow policy report can be attached to a parsed admission record", () => {
  const record = parseAionisMemoryAdmissionRecord({
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "memory_decision_trace",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: "tenant-local",
    scope: "repo-a",
    guide_trace_id: "guide-1",
    prompt_char_count: 100,
    history_used: true,
    actionable_history_used: true,
    candidate_memory_count: 1,
    prompt_included_memory_count: 1,
    agent_used_memory_count: 0,
    entries: [
      {
        memory_id: "mem-a",
        title: "Current project context",
        memory_origin: "aionis",
        source_backend: "aionis",
        domain: "execution",
        memory_type: "project_context",
        lifecycle_state: "active",
        authority: "advisory",
        admission_action: "use_now",
        decision_kind: "used",
        actionable: true,
        prompt_included: true,
        agent_used: false,
        feedback_outcome: null,
        attribution_strength: null,
        reason_codes: [],
        evidence_ids: [],
      },
    ],
    summary: "Aionis recorded one admission decision.",
  });
  const shadowPolicyReport = buildAionisMemoryAdmissionShadowPolicyReportFromRecord(record);
  const parsed = parseAionisMemoryAdmissionRecord({
    ...record,
    shadow_policy_report: shadowPolicyReport,
  });

  assert.equal(parsed.shadow_policy_report?.runtime_mutation, false);
  assert.equal(parsed.shadow_policy_report?.decisions[0]?.shadow_action, "use_now");
});
