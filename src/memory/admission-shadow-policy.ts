import {
  parseAionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryAdmissionClosedLoopEffectState,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryDecisionSurface,
} from "./product-output-contract.js";

export const AIONIS_ADMISSION_SHADOW_POLICY_ID = "candidate_project_context_closed_loop_inspect";
export const AIONIS_ADMISSION_SHADOW_POLICY_VERSION = "2026-06-18";

const SHADOW_USED_FIELDS = [
  "admission_action",
  "source_backend",
  "memory_type",
  "closed_loop_effect_state",
  "repeated_negative_posture",
];

type ShadowPolicyReportSource =
  | "memory_admission_record"
  | "memory_decision_trace"
  | "external_candidate_admission";

export type AionisMemoryAdmissionShadowPolicyEntryInput = {
  memory_id: string;
  title?: string | null;
  memory_origin?: "aionis" | "external";
  source_backend?: string | null;
  memory_type: AionisMemoryAdmissionRecord["entries"][number]["memory_type"];
  recorded_action: AionisMemoryDecisionSurface;
  prior_supported_use_count?: number | null;
  prior_contradicted_use_count?: number | null;
  prior_rehydrate_requested_count?: number | null;
  closed_loop_effect_state?: AionisMemoryAdmissionClosedLoopEffectState | null;
  repeated_negative_posture?: boolean | null;
};

export type AionisMemoryAdmissionShadowPolicyReportInput = {
  source: ShadowPolicyReportSource;
  entries: AionisMemoryAdmissionShadowPolicyEntryInput[];
};

function sourceBackendValue(entry: AionisMemoryAdmissionShadowPolicyEntryInput): string {
  const raw = typeof entry.source_backend === "string" ? entry.source_backend.trim() : "";
  if (raw.length > 0) return raw;
  return entry.memory_origin === "external" ? "external" : "aionis";
}

function closedLoopEffectStateValue(
  entry: AionisMemoryAdmissionShadowPolicyEntryInput,
): AionisMemoryAdmissionClosedLoopEffectState {
  return entry.closed_loop_effect_state ?? "no_prior";
}

function nonNegativeIntegerValue(value: number | null | undefined): number {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : 0;
}

function priorStateAvailable(entry: AionisMemoryAdmissionShadowPolicyEntryInput): boolean {
  return nonNegativeIntegerValue(entry.prior_supported_use_count) > 0
    || nonNegativeIntegerValue(entry.prior_contradicted_use_count) > 0
    || nonNegativeIntegerValue(entry.prior_rehydrate_requested_count) > 0
    || closedLoopEffectStateValue(entry) !== "no_prior"
    || entry.repeated_negative_posture === true;
}

function directUseCandidateMemoryType(entry: AionisMemoryAdmissionShadowPolicyEntryInput): boolean {
  return entry.memory_type === "project_context" || entry.memory_type === "execution_memory";
}

function shadowActionForEntry(entry: AionisMemoryAdmissionShadowPolicyEntryInput): AionisMemoryDecisionSurface {
  if (entry.recorded_action !== "use_now") return entry.recorded_action;
  const backend = sourceBackendValue(entry);
  const closedLoopEffectState = closedLoopEffectStateValue(entry);
  const admitsDirectUse =
    backend === "aionis"
    && directUseCandidateMemoryType(entry)
    && closedLoopEffectState !== "contradicted"
    && closedLoopEffectState !== "mixed"
    && entry.repeated_negative_posture !== true;
  return admitsDirectUse ? "use_now" : "inspect_before_use";
}

function shadowReasonCodes(
  entry: AionisMemoryAdmissionShadowPolicyEntryInput,
  shadowAction: AionisMemoryDecisionSurface,
): string[] {
  if (entry.recorded_action !== "use_now") {
    return ["hard_boundary_preserved", `recorded_action:${entry.recorded_action}`];
  }
  if (shadowAction === "use_now") return ["aionis_project_or_execution_context_shadow_use_now"];
  const reasons: string[] = [];
  if (sourceBackendValue(entry) !== "aionis") reasons.push("non_aionis_backend_shadow_inspect");
  if (!directUseCandidateMemoryType(entry)) reasons.push("non_project_or_execution_memory_shadow_inspect");
  const closedLoopEffectState = closedLoopEffectStateValue(entry);
  if (closedLoopEffectState === "contradicted" || closedLoopEffectState === "mixed") {
    reasons.push("closed_loop_counter_signal_shadow_inspect");
  }
  if (entry.repeated_negative_posture === true) reasons.push("repeated_negative_posture_shadow_inspect");
  return reasons.length > 0 ? reasons : ["candidate_policy_shadow_inspect"];
}

export function buildAionisMemoryAdmissionShadowPolicyReport(
  input: AionisMemoryAdmissionShadowPolicyReportInput,
): AionisMemoryAdmissionShadowPolicyReport {
  const decisions = input.entries.slice(0, 96).map((entry) => {
    const shadowAction = shadowActionForEntry(entry);
    return {
      memory_id: entry.memory_id,
      title: entry.title ?? null,
      recorded_action: entry.recorded_action,
      shadow_action: shadowAction,
      would_change_action: shadowAction !== entry.recorded_action,
      memory_origin: entry.memory_origin ?? "aionis",
      source_backend: sourceBackendValue(entry),
      memory_type: entry.memory_type,
      closed_loop_effect_state: closedLoopEffectStateValue(entry),
      repeated_negative_posture: entry.repeated_negative_posture === true,
      prior_state_available: priorStateAvailable(entry),
      used_fields: SHADOW_USED_FIELDS,
      reason_codes: shadowReasonCodes(entry, shadowAction),
    };
  });
  const policyChangedMemoryIds = decisions
    .filter((entry) => entry.would_change_action)
    .map((entry) => entry.memory_id);
  const downgradedMemoryIds = decisions
    .filter((entry) => entry.recorded_action === "use_now" && entry.shadow_action === "inspect_before_use")
    .map((entry) => entry.memory_id);
  const hardBoundaryUpgradeCount = decisions.filter((entry) =>
    entry.recorded_action !== "use_now" && entry.shadow_action === "use_now"
  ).length;
  const hardBoundaryPreservedMemoryIds = decisions
    .filter((entry) => entry.recorded_action !== "use_now" && entry.shadow_action === entry.recorded_action)
    .map((entry) => entry.memory_id);
  return parseAionisMemoryAdmissionShadowPolicyReport({
    contract_version: "aionis_memory_admission_shadow_policy_report_v1",
    intended_use: "admission_policy_shadow_audit",
    policy_id: AIONIS_ADMISSION_SHADOW_POLICY_ID,
    policy_version: AIONIS_ADMISSION_SHADOW_POLICY_VERSION,
    mode: "shadow_only",
    source: input.source,
    agent_prompt_included: false,
    runtime_mutation: false,
    hard_boundary_policy: "preserve_recorded_non_use_now",
    decision_count: decisions.length,
    changed_count: policyChangedMemoryIds.length,
    would_downgrade_use_now_count: downgradedMemoryIds.length,
    hard_boundary_upgrade_count: hardBoundaryUpgradeCount,
    direct_use_recorded_count: decisions.filter((entry) => entry.recorded_action === "use_now").length,
    direct_use_shadow_count: decisions.filter((entry) => entry.shadow_action === "use_now").length,
    policy_changed_memory_ids: policyChangedMemoryIds,
    downgraded_memory_ids: downgradedMemoryIds,
    hard_boundary_preserved_memory_ids: hardBoundaryPreservedMemoryIds,
    decisions,
    summary: `Shadow policy ${AIONIS_ADMISSION_SHADOW_POLICY_ID} evaluated ${decisions.length} admission decisions without mutating Runtime guide surfaces or Agent prompt context.`,
  });
}

export function buildAionisMemoryAdmissionShadowPolicyReportFromRecord(
  record: AionisMemoryAdmissionRecord,
  source: ShadowPolicyReportSource = "memory_admission_record",
): AionisMemoryAdmissionShadowPolicyReport {
  return buildAionisMemoryAdmissionShadowPolicyReport({
    source,
    entries: record.entries.map((entry) => ({
      memory_id: entry.memory_id,
      title: entry.title,
      memory_origin: entry.memory_origin,
      source_backend: entry.source_backend,
      memory_type: entry.memory_type,
      recorded_action: entry.admission_action,
    })),
  });
}
