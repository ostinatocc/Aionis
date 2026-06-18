import {
  buildAionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryAdmissionShadowPolicyReportInput,
} from "./admission-shadow-policy.js";
import type {
  AionisAgentContext,
  AionisMemoryAdmissionClosedLoopEffectState,
  AionisMemoryAdmissionShadowPolicyReport,
  AionisMemoryDecisionSurface,
  AionisMemoryPacket,
} from "./product-output-contract.js";

type MemoryPacketEntry = AionisMemoryPacket["relevant_memories"][number];
type RuntimeSlotMap = ReadonlyMap<string, Record<string, unknown>>;

export const AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON =
  "admission_candidate_policy_active_projection";

export type AionisAdmissionCandidatePolicyActiveProjection = {
  contract_version: "aionis_admission_candidate_policy_guide_projection_v1";
  intended_use: "guide_shadow_projection_audit" | "guide_active_projection_gate";
  mode: "shadow" | "active";
  agent_prompt_included: boolean;
  runtime_mutation: false;
  authority_mutation: false;
  shadow_policy_report: AionisMemoryAdmissionShadowPolicyReport;
  downgraded_memory_ids: string[];
  hard_boundary_upgrade_count: number;
  summary: string;
};

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function closedLoopEffectState(args: {
  supported: number;
  contradicted: number;
  rehydrateRequested: number;
}): AionisMemoryAdmissionClosedLoopEffectState {
  if (args.supported > 0 && args.contradicted > 0) return "mixed";
  if (args.contradicted > 0) return "contradicted";
  if (args.supported > 0) return "supported";
  if (args.rehydrateRequested > 0) return "rehydrate_requested";
  return "no_prior";
}

function runtimePriorStateFromSlots(slots: Record<string, unknown>) {
  const supported = nonNegativeInt(slots.positive_attributed_use_count);
  const weakCounterSignalCount = nonNegativeInt(slots.weak_counter_signal_count);
  const strongCounterSignalCount = nonNegativeInt(slots.strong_counter_signal_count);
  const contradicted = weakCounterSignalCount + strongCounterSignalCount;
  const rehydrateRequested = nonNegativeInt(slots.prior_rehydrate_requested_count)
    + nonNegativeInt(slots.rehydrate_requested_count);
  const repeatedNegativePosture =
    contradicted >= 2
    || slots.feedback_learning_control_posture === "inspect_before_use"
    || nonNegativeInt(slots.repeated_unused_without_positive_observation_count) >= 2;
  return {
    prior_supported_use_count: supported,
    prior_contradicted_use_count: contradicted,
    prior_rehydrate_requested_count: rehydrateRequested,
    closed_loop_effect_state: closedLoopEffectState({
      supported,
      contradicted,
      rehydrateRequested,
    }),
    repeated_negative_posture: repeatedNegativePosture,
  };
}

function surfaceForEntry(args: {
  entry: MemoryPacketEntry;
  useNowIds: ReadonlySet<string>;
  inspectBeforeUseIds: ReadonlySet<string>;
  doNotUseIds: ReadonlySet<string>;
  rehydrateIds: ReadonlySet<string>;
}): AionisMemoryDecisionSurface {
  if (args.useNowIds.has(args.entry.memory_id)) return "use_now";
  if (args.inspectBeforeUseIds.has(args.entry.memory_id)) return "inspect_before_use";
  if (args.doNotUseIds.has(args.entry.memory_id)) return "do_not_use";
  if (args.rehydrateIds.has(args.entry.memory_id)) return "rehydrate";
  return "not_agent_facing";
}

function shadowEntryForMemory(args: {
  entry: MemoryPacketEntry;
  agentContext: AionisAgentContext;
  slotByMemoryId: RuntimeSlotMap;
}): AionisMemoryAdmissionShadowPolicyReportInput["entries"][number] {
  const useNowIds = new Set(args.agentContext.use_now_memory_ids);
  const inspectBeforeUseIds = new Set(args.agentContext.inspect_before_use_memory_ids);
  const doNotUseIds = new Set(args.agentContext.do_not_use_memory_ids);
  const rehydrateIds = new Set(args.agentContext.rehydrate_hints.map((hint) => hint.memory_id));
  const slots = args.slotByMemoryId.get(args.entry.memory_id) ?? {};
  return {
    memory_id: args.entry.memory_id,
    title: args.entry.title,
    memory_origin: "aionis",
    source_backend: "aionis",
    memory_type: args.entry.memory_type,
    recorded_action: surfaceForEntry({
      entry: args.entry,
      useNowIds,
      inspectBeforeUseIds,
      doNotUseIds,
      rehydrateIds,
    }),
    ...runtimePriorStateFromSlots(slots),
  };
}

export function resolveAionisAdmissionCandidatePolicyActiveProjection(args: {
  agent_context: AionisAgentContext;
  memory_packet: AionisMemoryPacket | null;
  slot_by_memory_id?: RuntimeSlotMap | null;
  mode?: "shadow" | "active" | null;
}): AionisAdmissionCandidatePolicyActiveProjection {
  const mode = args.mode === "shadow" ? "shadow" : "active";
  const slotByMemoryId = args.slot_by_memory_id ?? new Map<string, Record<string, unknown>>();
  const report = buildAionisMemoryAdmissionShadowPolicyReport({
    source: "memory_decision_trace",
    entries: (args.memory_packet?.relevant_memories ?? []).map((entry) =>
      shadowEntryForMemory({
        entry,
        agentContext: args.agent_context,
        slotByMemoryId,
      })
    ),
  });
  const currentUseNowIds = new Set(args.agent_context.use_now_memory_ids);
  const downgradedMemoryIds = report.downgraded_memory_ids.filter((memoryId) =>
    currentUseNowIds.has(memoryId)
  );
  return {
    contract_version: "aionis_admission_candidate_policy_guide_projection_v1",
    intended_use: mode === "active" ? "guide_active_projection_gate" : "guide_shadow_projection_audit",
    mode,
    agent_prompt_included: mode === "active",
    runtime_mutation: false,
    authority_mutation: false,
    shadow_policy_report: report,
    downgraded_memory_ids: downgradedMemoryIds,
    hard_boundary_upgrade_count: report.hard_boundary_upgrade_count,
    summary: `Candidate admission policy would downgrade ${downgradedMemoryIds.length} current use_now memories to inspect_before_use without mutating stored memory state.`,
  };
}
