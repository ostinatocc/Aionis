import {
  parseAionisMemoryAdmissionShadowPolicyReport,
  type AionisMemoryAdmissionClosedLoopEffectState,
  type AionisMemoryAdmissionShadowPolicyReport,
  parseAionisMemoryAdmissionRecord,
  parseAionisMemoryDecisionAuditReport,
  parseAionisMemoryDecisionTrace,
  parseAionisMemoryUseReceipt,
  type AionisAgentContext,
  type AionisGuidePacket,
  type AionisJudgmentCalibrationSummary,
  type AionisLifecycleCandidateSignal,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisMemoryPacket,
  type AionisMemoryUseReceipt,
} from "../product-output-contract.js";
import type { AionisMemoryDecisionSurface } from "../governance-contract.js";
import {
  inferLifecycleCandidateSignals,
  lifecycleCandidateAllowsRehydrate,
} from "../lifecycle-candidate-inference.js";
import {
  MemoryPacketEntry,
  NormalizedAgentPromptExecutionScope,
  asRecord,
  compactStrings,
  contractEntryIsHandoff,
  extractPathTargets,
  governanceDecisionForMemoryEntry,
  lifecycleCandidateMemoryDirectUseAdmissible,
  lifecycleCandidateMemoryDirectUseUnsafe,
  lifecycleCandidateRehydrateEligible,
  lifecycleCandidateSignalsByMemoryId,
  nonNegativeIntegerValue,
  numberValue,
  stringArrayValue,
  stringValue,
  textMatchesMemoryEntry,
} from "./memory-packet.js";
import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  decideAdmissionCandidatePolicyAction,
  resolveAdmissionCandidatePolicy,
} from "../admission-candidate-policy.js";
import {
  classifyLearningTrack,
  type FrozenPriorState,
} from "../learning-episode-ledger.js";

type FeedbackAttributionDetail = NonNullable<AionisMemoryDecisionTrace["memory_decisions"][number]["feedback_detail"]>;

type FeedbackAttributionSummary = AionisMemoryDecisionTrace["feedback_attribution"];

type UnusedExposureObservationSummary = FeedbackAttributionSummary["unused_exposure_observation"];

type SparseFeedbackSignalSummary = FeedbackAttributionSummary["sparse_feedback_signal_summary"];

type CandidateLearningControlSummary = SparseFeedbackSignalSummary["candidate_learning_control_summary"];

type NeighborhoodDriftObservation = AionisMemoryDecisionTrace["neighborhood_drift_observation"];

type NeighborhoodDriftCandidate = NeighborhoodDriftObservation["candidates"][number];

type ConfidenceDecayCandidateSummary = AionisMemoryDecisionTrace["confidence_decay_candidate_summary"];

type InspectBeforeUseShadowDelta = AionisMemoryDecisionTrace["inspect_before_use_shadow_delta"];

type TraceDecisionSurface = AionisMemoryDecisionTrace["memory_decisions"][number]["agent_surface"];

type LifecycleCandidateSummary = AionisMemoryDecisionTrace["lifecycle_candidate_summary"];

type JudgmentCalibrationSummary = AionisJudgmentCalibrationSummary;

const NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD = 2;

const NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD = 2;

const NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD = 1;

export const AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

const NEIGHBORHOOD_DRIFT_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "current",
  "during",
  "early",
  "later",
  "memory",
  "notes",
  "project",
  "should",
  "source",
  "still",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "where",
  "with",
  "work",
]);

type AionisDecisionTraceGuideSnapshot = {
  memory_packet?: AionisMemoryPacket | null;
  guide_packet?: AionisGuidePacket | null;
  agent_context?: AionisAgentContext | null;
};

export type BuildAionisMemoryDecisionTraceArgs = {
  tenant_id: string;
  scope: string;
  before_guide?: AionisDecisionTraceGuideSnapshot | null;
  after_guide: AionisDecisionTraceGuideSnapshot;
  lifecycle_candidate_shadow_signals?: AionisLifecycleCandidateSignal[];
  forget_result?: unknown;
  source_map?: Partial<AionisMemoryDecisionTrace["source_map"]>;
};

export type BuildAionisMemoryDecisionAuditReportArgs = {
  trace: AionisMemoryDecisionTrace;
  source_map?: Partial<AionisMemoryDecisionAuditReport["source_map"]>;
};

function mergeTraceLifecycleCandidateSignals(args: {
  inferred: AionisLifecycleCandidateSignal[];
  shadow_signals?: AionisLifecycleCandidateSignal[];
  memory_ids: Set<string>;
}): AionisLifecycleCandidateSignal[] {
  const out: AionisLifecycleCandidateSignal[] = [];
  const seen = new Set<string>();
  const add = (signal: AionisLifecycleCandidateSignal) => {
    if (!args.memory_ids.has(signal.memory_id)) return;
    const key = [
      signal.memory_id,
      signal.signal_type,
      signal.producer,
      signal.evidence_span.source_field,
      signal.evidence_span.quote.toLowerCase(),
    ].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(signal);
  };
  for (const signal of args.inferred) add(signal);
  for (const signal of args.shadow_signals ?? []) {
    if (signal.producer !== "llm_shadow_v1") continue;
    add(signal);
  }
  return out.slice(0, 64);
}

function traceTextMatchesEntry(values: string[], entry: MemoryPacketEntry): boolean {
  return values.some((value) => textMatchesMemoryEntry(value, entry));
}

function traceProjectedSurfaceForMemory(args: {
  entry: MemoryPacketEntry;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
}): AionisMemoryDecisionSurface | null {
  const guideBrief = args.guide?.guide_brief ?? null;
  if (
    args.agentContext?.do_not_use_memory_ids.includes(args.entry.memory_id)
    || traceTextMatchesEntry(args.agentContext?.do_not_use ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.do_not_use ?? [], args.entry)
  ) return "do_not_use";
  const rehydrateIds = new Set([
    ...(args.agentContext?.rehydrate_hints ?? []).map((hint) => hint.memory_id),
    ...(guideBrief?.rehydrate ?? []).map((hint) => hint.memory_id),
  ]);
  if (rehydrateIds.has(args.entry.memory_id)) return "rehydrate";
  if (
    args.agentContext?.inspect_before_use_memory_ids.includes(args.entry.memory_id)
    || traceTextMatchesEntry(args.agentContext?.inspect_before_use ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.inspect_before_use ?? [], args.entry)
  ) return "inspect_before_use";
  if (
    args.agentContext?.use_now_memory_ids.includes(args.entry.memory_id)
    || traceTextMatchesEntry(args.agentContext?.use_now ?? [], args.entry)
    || traceTextMatchesEntry(guideBrief?.use_now ?? [], args.entry)
  ) return "use_now";
  return null;
}

function traceReasonCodes(args: {
  entry: MemoryPacketEntry;
  memory: AionisMemoryPacket | null;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
  lifecycleCandidateSignals: AionisLifecycleCandidateSignal[];
  governanceReasonCodes: string[];
}): string[] {
  const premiseFirewallReasonVisible =
    args.agentContext?.risk.reasons.some((reason) => reason.startsWith("premise_firewall_")) === true
    && (args.agentContext.inspect_before_use_memory_ids.includes(args.entry.memory_id)
      || args.agentContext.do_not_use_memory_ids.includes(args.entry.memory_id));
  const lifecycleCandidateSignals = args.lifecycleCandidateSignals.filter((signal) => signal.memory_id === args.entry.memory_id);
  return compactStrings([
    ...args.governanceReasonCodes,
    args.memory?.evidence_trail.some((evidence) => evidence.source === "edge" && evidence.memory_id === args.entry.memory_id)
      ? "lifecycle_relation_evidence" : null,
    args.memory?.contradiction_warnings.some((warning) => warning.memory_id === args.entry.memory_id)
      ? "contradiction_warning" : null,
    premiseFirewallReasonVisible ? "premise_firewall_query_risk" : null,
    lifecycleCandidateSignals.length > 0 ? "lifecycle_candidate_signal" : null,
    ...lifecycleCandidateSignals.map((signal) => `lifecycle_candidate_${signal.signal_type}`),
    lifecycleCandidateMemoryDirectUseUnsafe(lifecycleCandidateSignals)
      && !args.governanceReasonCodes.includes("available_for_agent_use") ? "lifecycle_candidate_direct_use_gated" : null,
    `memory_contract_${args.entry.memory_contract.use_policy}`,
    args.entry.memory_contract.confirmation_required ? "memory_contract_confirmation_required" : null,
    args.entry.memory_contract.evidence_requirement === "requires_more_evidence" ? "memory_contract_requires_more_evidence" : null,
    args.entry.memory_contract.allowed_scope === "supporting_evidence_only" ? "memory_contract_supporting_evidence_only" : null,
    args.agentContext ? "agent_context_projection_checked" : null,
    args.guide?.guide_brief.history_used ? "guide_history_used" : null,
  ]);
}

function isForgetAction(value: string | null): value is AionisMemoryDecisionTrace["forget_decisions"][number]["action"] {
  return value === "suppress" || value === "unsuppress" || value === "rehydrate" || value === "activate";
}

function isForgetTarget(value: string | null): value is NonNullable<AionisMemoryDecisionTrace["forget_decisions"][number]["target"]> {
  return value === "pattern" || value === "archive" || value === "payload" || value === "memory";
}

function traceForgetDecisions(forgetResult: unknown): AionisMemoryDecisionTrace["forget_decisions"] {
  const root = asRecord(forgetResult);
  const effect = asRecord(root?.forget_effect);
  const action = stringValue(effect?.action) ?? stringValue(root?.operation);
  if (!isForgetAction(action)) return [];
  const target = stringValue(effect?.target) ?? stringValue(root?.target);
  const affected = Array.isArray(effect?.affected_memory_ids)
    ? compactStrings(effect.affected_memory_ids.map((entry) => typeof entry === "string" ? entry : null))
    : [];
  return [{
    action,
    target: isForgetTarget(target) ? target : null,
    changed_count: Math.max(0, numberValue(effect?.changed_count) ?? 0),
    affected_memory_ids: affected,
    reason: stringValue(root?.reason) ?? stringValue(effect?.reason),
  }];
}

type TraceFeedbackActivationSummary = {
  memory_id: string;
  run_id: string | null;
  outcome: FeedbackAttributionDetail["outcome"];
  used_surface: FeedbackAttributionDetail["used_surface"];
  verifier_status: FeedbackAttributionDetail["verifier_status"];
  tool_status: FeedbackAttributionDetail["tool_status"];
  runtime_signal_refs: string[];
  attribution_strength: FeedbackAttributionDetail["attribution_strength"];
  weak_counter_signal_count: number;
  strong_counter_signal_count: number;
};

type TraceFeedbackAttributionInput = {
  present: boolean;
  guide_trace_id: string | null;
  run_id: string | null;
  outcome: FeedbackAttributionDetail["outcome"];
  used_surface: FeedbackAttributionDetail["used_surface"];
  verifier_status: FeedbackAttributionDetail["verifier_status"];
  tool_status: FeedbackAttributionDetail["tool_status"];
  runtime_signal_refs: string[];
  affected_memory_ids: string[];
  exposed_memory_count: number;
  attributed_memory_count: number;
  unattributed_recalled_memory_count: number;
  unattributed_recalled_memory_ids: string[];
  unattributed_use_now_memory_ids: string[];
  unattributed_inspect_before_use_memory_ids: string[];
  unattributed_do_not_use_memory_ids: string[];
  unattributed_rehydrate_memory_ids: string[];
  unused_exposure_observation: UnusedExposureObservationSummary;
  summaries: Map<string, TraceFeedbackActivationSummary>;
};

function feedbackOutcomeValue(value: unknown): FeedbackAttributionDetail["outcome"] {
  return value === "positive" || value === "negative" || value === "neutral" ? value : null;
}

function feedbackUsedSurfaceValue(value: unknown): FeedbackAttributionDetail["used_surface"] {
  return value === "use_now"
    || value === "inspect_before_use"
    || value === "do_not_use"
    || value === "explicit_host_assertion"
    ? value
    : null;
}

function feedbackVerifierStatusValue(value: unknown): FeedbackAttributionDetail["verifier_status"] {
  return value === "passed" || value === "failed" || value === "not_run" || value === "unknown" ? value : null;
}

function feedbackToolStatusValue(value: unknown): FeedbackAttributionDetail["tool_status"] {
  return value === "succeeded" || value === "failed" || value === "not_run" || value === "unknown" ? value : null;
}

function feedbackAttributionStrengthValue(value: unknown): FeedbackAttributionDetail["attribution_strength"] {
  return value === "observed_feedback"
    || value === "positive_attribution"
    || value === "weak_counter_signal"
    || value === "strong_counter_signal"
    ? value
    : null;
}

function emptyUnusedExposureObservation(reason = "No guide exposure observation was supplied for this trace."): UnusedExposureObservationSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    exposure_threshold: 0,
    guide_trace_count: 0,
    tracked_memory_count: 0,
    repeated_unattributed_memory_ids: [],
    repeated_unattributed_without_positive_memory_ids: [],
    memory_stats: [],
    reason,
  };
}

function emptySparseFeedbackSignalSummary(
  reason = "No activate feedback or unused exposure signal was supplied for this trace.",
): SparseFeedbackSignalSummary {
  return {
    present: false,
    mode: null,
    authority_mutation: false,
    positive_attributed_memory_ids: [],
    weak_counter_signal_memory_ids: [],
    strong_counter_signal_memory_ids: [],
    relation_counter_signal_memory_ids: [],
    contradiction_warning_memory_ids: [],
    repeated_unattributed_memory_ids: [],
    repeated_unattributed_without_positive_memory_ids: [],
    read_only_signal_memory_ids: [],
    candidate_learning_control_summary: emptyCandidateLearningControlSummary(),
    reason,
  };
}

function emptyCandidateLearningControlSummary(
  reason = "No sparse feedback signal crossed the candidate learning-control gate.",
): CandidateLearningControlSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    candidate_inspect_before_use_memory_ids: [],
    candidate_from_threshold_met_memory_ids: [],
    candidate_from_repeated_unused_without_positive_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    reason,
  };
}

function buildCandidateLearningControlSummary(args: {
  thresholdMetMemoryIds: string[];
  unusedExposureObservation: UnusedExposureObservationSummary;
}): CandidateLearningControlSummary {
  const positiveAttributedUseMemoryIds = new Set(
    args.unusedExposureObservation.memory_stats
      .filter((entry) => entry.positive_attributed_use_count > 0)
      .map((entry) => entry.memory_id),
  );
  const repeatedWithoutPositive = args.unusedExposureObservation.repeated_unattributed_without_positive_memory_ids
    .filter((memoryId) => !positiveAttributedUseMemoryIds.has(memoryId));
  const blockedByPositiveAttribution = args.unusedExposureObservation.repeated_unattributed_memory_ids
    .filter((memoryId) => positiveAttributedUseMemoryIds.has(memoryId));
  const candidateFromThresholdMet = compactStrings(args.thresholdMetMemoryIds);
  const candidateFromUnusedExposure = compactStrings(repeatedWithoutPositive);
  const candidateInspect = compactStrings([
    ...candidateFromThresholdMet,
    ...candidateFromUnusedExposure,
  ]);
  const blockedByPositive = compactStrings(blockedByPositiveAttribution);

  if (candidateInspect.length === 0 && blockedByPositive.length === 0) {
    return emptyCandidateLearningControlSummary();
  }

  return {
    present: true,
    contract_version: "aionis_candidate_learning_control_summary_v1",
    mode: "candidate_only",
    authority_mutation: false,
    candidate_inspect_before_use_memory_ids: candidateInspect,
    candidate_from_threshold_met_memory_ids: candidateFromThresholdMet,
    candidate_from_repeated_unused_without_positive_memory_ids: candidateFromUnusedExposure,
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    reason: candidateInspect.length > 0
      ? "Threshold-met feedback and repeated unused exposure without positive attribution are candidate-only inspect-before-use signals; this summary does not mutate authority."
      : "Repeated unused exposure was observed, but positive attributed use blocks candidate learning-control.",
  };
}

function emptyConfidenceDecayCandidateSummary(
  reason = "No confidence decay shadow candidate crossed the read-only gate.",
): ConfidenceDecayCandidateSummary {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    agent_prompt_included: false,
    time_decay_age_threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
    decay_candidate_memory_ids: [],
    candidate_from_learning_control_memory_ids: [],
    candidate_from_time_decay_memory_ids: [],
    supported_by_neighborhood_drift_memory_ids: [],
    drift_only_observation_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    blocked_by_recent_validation_memory_ids: [],
    time_decay_candidate_details: [],
    reason,
  };
}

function buildConfidenceDecayCandidateSummary(args: {
  feedbackAttribution: FeedbackAttributionSummary;
  memory: AionisMemoryPacket | null;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
  neighborhoodDriftObservation: NeighborhoodDriftObservation;
}): ConfidenceDecayCandidateSummary {
  const sparse = args.feedbackAttribution.sparse_feedback_signal_summary;
  const learningControl = sparse.candidate_learning_control_summary;
  const positiveMemoryIds = new Set(compactStrings(sparse.positive_attributed_memory_ids));
  const learningControlCandidates = compactStrings(learningControl.candidate_inspect_before_use_memory_ids);
  const memoryEntriesById = new Map((args.memory?.relevant_memories ?? []).map((entry) => [entry.memory_id, entry]));
  const decisionsById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const observedTimes = (args.memory?.relevant_memories ?? [])
    .map((entry) => parseObservedTime(entry.observed_at))
    .filter((value): value is number => value !== null);
  const referenceObservedTime = observedTimes.length > 0 ? Math.max(...observedTimes) : null;
  const referenceObservedAt = referenceObservedTime === null ? null : new Date(referenceObservedTime).toISOString();
  const timeDecayDetails: ConfidenceDecayCandidateSummary["time_decay_candidate_details"] = [];
  const timeDecayBlockedByPositive: string[] = [];

  if (referenceObservedTime !== null && referenceObservedAt !== null) {
    for (const [memoryId, decision] of decisionsById) {
      if (decision.agent_surface !== "use_now" && decision.agent_surface !== "inspect_before_use") continue;
      if (decision.authority !== "trusted" && decision.authority !== "advisory") continue;
      if (decision.lifecycle_state !== "active") continue;
      const entry = memoryEntriesById.get(memoryId);
      const observedTime = parseObservedTime(entry?.observed_at);
      if (observedTime === null || observedTime >= referenceObservedTime) continue;
      const ageDays = Math.floor((referenceObservedTime - observedTime) / DAY_MS);
      if (ageDays < AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS) continue;
      const blockedByPositiveAttribution = positiveMemoryIds.has(memoryId) || hasPositiveAttribution(decision);
      if (blockedByPositiveAttribution) {
        timeDecayBlockedByPositive.push(memoryId);
      }
      timeDecayDetails.push({
        memory_id: memoryId,
        observed_at: new Date(observedTime).toISOString(),
        reference_observed_at: referenceObservedAt,
        age_days: ageDays,
        threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
        agent_surface: decision.agent_surface,
        authority: decision.authority,
        blocked_by_positive_attribution: blockedByPositiveAttribution,
        reason: blockedByPositiveAttribution
          ? "Temporal staleness was observed, but positive attribution in the current feedback window blocks confidence-decay candidacy."
          : "Memory is substantially older than the freshest scoped evidence while still exposed to the agent; this is a read-only confidence-decay candidate and does not mutate authority.",
      });
    }
  }

  const candidateFromLearningControl = learningControlCandidates.filter((memoryId) => !positiveMemoryIds.has(memoryId));
  const candidateFromTimeDecay = compactStrings(
    timeDecayDetails
      .filter((entry) => !entry.blocked_by_positive_attribution)
      .map((entry) => entry.memory_id),
  );
  const blockedByPositive = compactStrings([
    ...learningControl.blocked_by_positive_attribution_memory_ids,
    ...learningControlCandidates.filter((memoryId) => positiveMemoryIds.has(memoryId)),
    ...timeDecayBlockedByPositive,
  ]);
  const driftSignalMemoryIds = new Set(args.neighborhoodDriftObservation.signal_memory_ids);
  const candidateMemoryIds = compactStrings([
    ...candidateFromLearningControl,
    ...candidateFromTimeDecay,
  ]);
  const supportedByDrift = candidateMemoryIds.filter((memoryId) => driftSignalMemoryIds.has(memoryId));
  const driftOnlyObservation = args.neighborhoodDriftObservation.signal_memory_ids
    .filter((memoryId) => !candidateMemoryIds.includes(memoryId) && !blockedByPositive.includes(memoryId));
  const decayCandidates = compactStrings(candidateMemoryIds);

  if (
    decayCandidates.length === 0
    && blockedByPositive.length === 0
    && driftOnlyObservation.length === 0
    && timeDecayDetails.length === 0
  ) {
    return emptyConfidenceDecayCandidateSummary();
  }

  return {
    present: true,
    contract_version: "aionis_confidence_decay_candidate_summary_v1",
    mode: "shadow_candidate",
    authority_mutation: false,
    agent_prompt_included: false,
    time_decay_age_threshold_days: AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
    decay_candidate_memory_ids: decayCandidates,
    candidate_from_learning_control_memory_ids: candidateFromLearningControl,
    candidate_from_time_decay_memory_ids: candidateFromTimeDecay,
    supported_by_neighborhood_drift_memory_ids: supportedByDrift,
    drift_only_observation_memory_ids: compactStrings(driftOnlyObservation),
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    blocked_by_recent_validation_memory_ids: blockedByPositive,
    time_decay_candidate_details: timeDecayDetails.slice(0, 24),
    reason: decayCandidates.length > 0
      ? "Direction 1 candidate evidence or temporal staleness may become a confidence-decay shadow candidate, but this summary does not mutate authority."
      : "Positive attribution, recent validation, or drift-only evidence blocked confidence-decay candidacy.",
  };
}

function emptyInspectBeforeUseShadowDelta(
  reason = "Inspect-before-use shadow delta is disabled and no confidence-decay candidates were supplied.",
): InspectBeforeUseShadowDelta {
  return {
    present: false,
    contract_version: null,
    mode: null,
    enabled: false,
    authority_mutation: false,
    agent_prompt_included: false,
    simulated_surface: "inspect_before_use",
    candidate_memory_ids: [],
    would_move_to_inspect_before_use_memory_ids: [],
    already_inspect_before_use_memory_ids: [],
    blocked_by_positive_attribution_memory_ids: [],
    blocked_by_recent_validation_memory_ids: [],
    drift_only_observation_memory_ids: [],
    entries: [],
    reason,
  };
}

function buildInspectBeforeUseShadowDelta(args: {
  confidenceDecayCandidateSummary: ConfidenceDecayCandidateSummary;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
}): InspectBeforeUseShadowDelta {
  const summary = args.confidenceDecayCandidateSummary;
  const candidateMemoryIds = compactStrings(summary.decay_candidate_memory_ids);
  const blockedByPositive = compactStrings(summary.blocked_by_positive_attribution_memory_ids);
  const blockedByRecentValidation = compactStrings(summary.blocked_by_recent_validation_memory_ids);
  const driftOnlyObservation = compactStrings(summary.drift_only_observation_memory_ids);
  if (
    candidateMemoryIds.length === 0
    && blockedByPositive.length === 0
    && blockedByRecentValidation.length === 0
    && driftOnlyObservation.length === 0
  ) {
    return emptyInspectBeforeUseShadowDelta();
  }

  const learningControlIds = new Set(summary.candidate_from_learning_control_memory_ids);
  const timeDecayIds = new Set(summary.candidate_from_time_decay_memory_ids);
  const decisionById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const entries: InspectBeforeUseShadowDelta["entries"] = [];
  const wouldMove: string[] = [];
  const alreadyInspect: string[] = [];

  for (const memoryId of candidateMemoryIds) {
    const decision = decisionById.get(memoryId);
    if (!decision) continue;
    const sources = compactStrings([
      learningControlIds.has(memoryId) ? "learning_control" : null,
      timeDecayIds.has(memoryId) ? "time_decay" : null,
    ]) as InspectBeforeUseShadowDelta["entries"][number]["sources"];
    const wouldChangeSurface = decision.agent_surface !== "inspect_before_use";
    if (wouldChangeSurface) {
      wouldMove.push(memoryId);
    } else {
      alreadyInspect.push(memoryId);
    }
    entries.push({
      memory_id: memoryId,
      title: decision.title,
      current_surface: decision.agent_surface,
      proposed_surface: "inspect_before_use",
      would_change_surface: wouldChangeSurface,
      authority: decision.authority,
      lifecycle_state: decision.lifecycle_state,
      sources,
      reason: wouldChangeSurface
        ? "If the disabled product flag were enabled, this confidence-decay candidate would move from direct reuse to inspect-before-use."
        : "This confidence-decay candidate is already inspect-before-use under existing runtime evidence; the disabled preview would not change its surface.",
    });
  }

  return {
    present: true,
    contract_version: "aionis_inspect_before_use_shadow_delta_v1",
    mode: "disabled_preview",
    enabled: false,
    authority_mutation: false,
    agent_prompt_included: false,
    simulated_surface: "inspect_before_use",
    candidate_memory_ids: candidateMemoryIds,
    would_move_to_inspect_before_use_memory_ids: compactStrings(wouldMove),
    already_inspect_before_use_memory_ids: compactStrings(alreadyInspect),
    blocked_by_positive_attribution_memory_ids: blockedByPositive,
    blocked_by_recent_validation_memory_ids: blockedByRecentValidation,
    drift_only_observation_memory_ids: driftOnlyObservation,
    entries: entries.slice(0, 48),
    reason: candidateMemoryIds.length > 0
      ? "Disabled preview only: candidate memories are reported as an inspect-before-use delta without mutating authority or entering the Agent prompt."
      : "Disabled preview only: no memories would move; existing positive, recent-validation, or drift-only boundaries blocked the delta.",
  };
}

function unusedExposureObservationValue(value: unknown): UnusedExposureObservationSummary {
  const record = asRecord(value);
  if (!record || record.contract_version !== "aionis_unused_exposure_observation_v1") {
    return emptyUnusedExposureObservation();
  }
  const memoryStats = Array.isArray(record.memory_stats)
    ? record.memory_stats
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map((entry) => ({
        memory_id: stringValue(entry.memory_id) ?? "unknown",
        current_unattributed: entry.current_unattributed === true,
        exposure_count: nonNegativeIntegerValue(entry.exposure_count),
        use_now_exposure_count: nonNegativeIntegerValue(entry.use_now_exposure_count),
        inspect_before_use_exposure_count: nonNegativeIntegerValue(entry.inspect_before_use_exposure_count),
        do_not_use_exposure_count: nonNegativeIntegerValue(entry.do_not_use_exposure_count),
        rehydrate_exposure_count: nonNegativeIntegerValue(entry.rehydrate_exposure_count),
        positive_attributed_use_count: nonNegativeIntegerValue(entry.positive_attributed_use_count),
        feedback_positive_count: nonNegativeIntegerValue(entry.feedback_positive_count),
        feedback_negative_count: nonNegativeIntegerValue(entry.feedback_negative_count),
        repeated_without_positive_attribution: entry.repeated_without_positive_attribution === true,
      }))
      .filter((entry) => entry.memory_id !== "unknown")
    : [];
  return {
    present: true,
    contract_version: "aionis_unused_exposure_observation_v1",
    mode: "read_only_measure",
    exposure_threshold: nonNegativeIntegerValue(record.exposure_threshold),
    guide_trace_count: nonNegativeIntegerValue(record.guide_trace_count),
    tracked_memory_count: nonNegativeIntegerValue(record.tracked_memory_count),
    repeated_unattributed_memory_ids: stringArrayValue(record.repeated_unattributed_memory_ids),
    repeated_unattributed_without_positive_memory_ids: stringArrayValue(record.repeated_unattributed_without_positive_memory_ids),
    memory_stats: memoryStats,
    reason: stringValue(record.reason) ?? "Repeated unused exposure is reported as read-only evidence.",
  };
}

function buildSparseFeedbackSignalSummary(args: {
  present: boolean;
  positiveAttributedMemoryIds: string[];
  weakCounterSignalMemoryIds: string[];
  strongCounterSignalMemoryIds: string[];
  thresholdMetMemoryIds: string[];
  relationCounterSignalMemoryIds: string[];
  contradictionWarningMemoryIds: string[];
  unusedExposureObservation: UnusedExposureObservationSummary;
}): SparseFeedbackSignalSummary {
  const repeatedUnattributed = args.unusedExposureObservation.repeated_unattributed_memory_ids;
  const repeatedWithoutPositive = args.unusedExposureObservation.repeated_unattributed_without_positive_memory_ids;
  const readOnlySignalMemoryIds = compactStrings([
    ...args.positiveAttributedMemoryIds,
    ...args.weakCounterSignalMemoryIds,
    ...args.strongCounterSignalMemoryIds,
    ...args.relationCounterSignalMemoryIds,
    ...args.contradictionWarningMemoryIds,
    ...repeatedUnattributed,
    ...repeatedWithoutPositive,
  ]);
  const candidateLearningControlSummary = buildCandidateLearningControlSummary({
    thresholdMetMemoryIds: args.thresholdMetMemoryIds,
    unusedExposureObservation: args.unusedExposureObservation,
  });
  if (readOnlySignalMemoryIds.length === 0) {
    return emptySparseFeedbackSignalSummary();
  }
  return {
    present: true,
    mode: "read_only_measure",
    authority_mutation: false,
    positive_attributed_memory_ids: args.positiveAttributedMemoryIds,
    weak_counter_signal_memory_ids: args.weakCounterSignalMemoryIds,
    strong_counter_signal_memory_ids: args.strongCounterSignalMemoryIds,
    relation_counter_signal_memory_ids: args.relationCounterSignalMemoryIds,
    contradiction_warning_memory_ids: args.contradictionWarningMemoryIds,
    repeated_unattributed_memory_ids: repeatedUnattributed,
    repeated_unattributed_without_positive_memory_ids: repeatedWithoutPositive,
    read_only_signal_memory_ids: readOnlySignalMemoryIds,
    candidate_learning_control_summary: candidateLearningControlSummary,
    reason: "Sparse feedback, repeated exposure, and relation-derived counter signals are summarized for measure/debug/audit only; this summary does not lower authority or suppress memory.",
  };
}

function traceFeedbackAttributionInput(forgetResult: unknown): TraceFeedbackAttributionInput {
  const root = asRecord(forgetResult);
  const effect = asRecord(root?.forget_effect);
  const action = stringValue(effect?.action) ?? stringValue(root?.operation);
  const affectedMemoryIds = Array.isArray(effect?.affected_memory_ids)
    ? compactStrings(effect.affected_memory_ids.map((entry) => typeof entry === "string" ? entry : null))
    : [];
  if (action !== "activate") {
    return {
      present: false,
      guide_trace_id: null,
      run_id: null,
      outcome: null,
      used_surface: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs: [],
      affected_memory_ids: [],
      exposed_memory_count: 0,
      attributed_memory_count: 0,
      unattributed_recalled_memory_count: 0,
      unattributed_recalled_memory_ids: [],
      unattributed_use_now_memory_ids: [],
      unattributed_inspect_before_use_memory_ids: [],
      unattributed_do_not_use_memory_ids: [],
      unattributed_rehydrate_memory_ids: [],
      unused_exposure_observation: emptyUnusedExposureObservation(),
      summaries: new Map(),
    };
  }

  const attribution = asRecord(effect?.attribution);
  const guideTrace = asRecord(effect?.guide_trace);
  const result = asRecord(root?.result);
  const activated = asRecord(result?.activated);
  const rawSummaries = Array.isArray(activated?.feedback_attributions) ? activated.feedback_attributions : [];
  const fallback = {
    run_id: stringValue(attribution?.run_id),
    outcome: feedbackOutcomeValue(attribution?.outcome),
    used_surface: feedbackUsedSurfaceValue(attribution?.used_surface),
    verifier_status: feedbackVerifierStatusValue(attribution?.verifier_status),
    tool_status: feedbackToolStatusValue(attribution?.tool_status),
    runtime_signal_refs: stringArrayValue(attribution?.runtime_signal_refs),
  };
  const summaries = new Map<string, TraceFeedbackActivationSummary>();
  for (const item of rawSummaries) {
    const record = asRecord(item);
    const memoryId = stringValue(record?.memory_id);
    if (!memoryId) continue;
    summaries.set(memoryId, {
      memory_id: memoryId,
      run_id: stringValue(record?.run_id) ?? fallback.run_id,
      outcome: feedbackOutcomeValue(record?.outcome) ?? fallback.outcome,
      used_surface: feedbackUsedSurfaceValue(record?.used_surface) ?? fallback.used_surface,
      verifier_status: feedbackVerifierStatusValue(record?.verifier_status) ?? fallback.verifier_status,
      tool_status: feedbackToolStatusValue(record?.tool_status) ?? fallback.tool_status,
      runtime_signal_refs: stringArrayValue(record?.runtime_signal_refs).length > 0
        ? stringArrayValue(record?.runtime_signal_refs)
        : fallback.runtime_signal_refs,
      attribution_strength: feedbackAttributionStrengthValue(record?.attribution_strength),
      weak_counter_signal_count: nonNegativeIntegerValue(record?.weak_counter_signal_count),
      strong_counter_signal_count: nonNegativeIntegerValue(record?.strong_counter_signal_count),
    });
  }
  for (const memoryId of affectedMemoryIds) {
    if (summaries.has(memoryId)) continue;
    summaries.set(memoryId, {
      memory_id: memoryId,
      ...fallback,
      attribution_strength: null,
      weak_counter_signal_count: 0,
      strong_counter_signal_count: 0,
    });
  }

  return {
    present: true,
    guide_trace_id: stringValue(guideTrace?.guide_trace_id),
    ...fallback,
    affected_memory_ids: affectedMemoryIds,
    exposed_memory_count: nonNegativeIntegerValue(guideTrace?.exposed_memory_count),
    attributed_memory_count: nonNegativeIntegerValue(guideTrace?.attributed_memory_count),
    unattributed_recalled_memory_count: nonNegativeIntegerValue(guideTrace?.unattributed_recalled_memory_count),
    unattributed_recalled_memory_ids: stringArrayValue(guideTrace?.unattributed_recalled_memory_ids),
    unattributed_use_now_memory_ids: stringArrayValue(guideTrace?.unattributed_use_now_memory_ids),
    unattributed_inspect_before_use_memory_ids: stringArrayValue(guideTrace?.unattributed_inspect_before_use_memory_ids),
    unattributed_do_not_use_memory_ids: stringArrayValue(guideTrace?.unattributed_do_not_use_memory_ids),
    unattributed_rehydrate_memory_ids: stringArrayValue(guideTrace?.unattributed_rehydrate_memory_ids),
    unused_exposure_observation: unusedExposureObservationValue(guideTrace?.unused_exposure_observation),
    summaries,
  };
}

function feedbackThresholdState(summary: TraceFeedbackActivationSummary): FeedbackAttributionDetail["threshold_state"] {
  if (summary.outcome === "positive") return "positive_attribution";
  if (summary.attribution_strength === "strong_counter_signal" || summary.strong_counter_signal_count > 0) {
    return "strong_signal_threshold_met";
  }
  if (summary.attribution_strength === "weak_counter_signal" || summary.weak_counter_signal_count > 0) {
    return summary.weak_counter_signal_count >= 2 ? "repeated_weak_threshold_met" : "weak_below_threshold";
  }
  if (summary.attribution_strength === "observed_feedback") return "observed_feedback_only";
  return "none";
}

function feedbackTraceReason(args: {
  summary: TraceFeedbackActivationSummary;
  thresholdState: FeedbackAttributionDetail["threshold_state"];
}): string {
  if (args.thresholdState === "strong_signal_threshold_met") {
    return "Negative feedback is aligned with verifier, tool, or runtime failure evidence, so the memory is kept out of direct use.";
  }
  if (args.thresholdState === "repeated_weak_threshold_met") {
    return "Repeated weak negative feedback reached the attribution threshold, so the memory is kept out of direct use.";
  }
  if (args.thresholdState === "weak_below_threshold") {
    return "A single weak negative feedback signal was recorded; authority remains direct-use until repeated or aligned evidence appears.";
  }
  if (args.thresholdState === "positive_attribution") {
    return "Positive host attribution supports continued direct use for this memory.";
  }
  return args.summary.used_surface
    ? "Host feedback was recorded, but it does not meet a counter-signal threshold."
    : "Feedback result did not include a direct host-used attribution surface.";
}

function traceFeedbackDetail(args: {
  entry: MemoryPacketEntry;
  feedbackInput: TraceFeedbackAttributionInput;
}): FeedbackAttributionDetail | null {
  const summary = args.feedbackInput.summaries.get(args.entry.memory_id);
  if (!summary) return null;
  const thresholdState = feedbackThresholdState(summary);
  const thresholdMet = thresholdState === "repeated_weak_threshold_met" || thresholdState === "strong_signal_threshold_met";
  const hostMarkedUsed = summary.used_surface === "use_now" || summary.used_surface === "explicit_host_assertion";
  return {
    run_id: summary.run_id,
    outcome: summary.outcome,
    used_surface: summary.used_surface,
    verifier_status: summary.verifier_status,
    tool_status: summary.tool_status,
    runtime_signal_refs: summary.runtime_signal_refs,
    attribution_strength: summary.attribution_strength,
    weak_counter_signal_count: summary.weak_counter_signal_count,
    strong_counter_signal_count: summary.strong_counter_signal_count,
    threshold_state: thresholdState,
    threshold_met: thresholdMet,
    host_marked_used: hostMarkedUsed,
    reason: feedbackTraceReason({ summary, thresholdState }),
  };
}

function buildTraceFeedbackAttribution(args: {
  feedbackInput: TraceFeedbackAttributionInput;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
  agentContext: AionisAgentContext | null;
}): FeedbackAttributionSummary {
  const relationCounterSignalMemoryIds = args.memoryDecisions
    .filter((entry) => !!entry.downgraded_detail?.relation)
    .map((entry) => entry.memory_id);
  const contradictionWarningMemoryIds = args.memoryDecisions
    .filter((entry) => entry.reason_codes.includes("contradiction_warning"))
    .map((entry) => entry.memory_id);
  if (!args.feedbackInput.present) {
    const sparseFeedbackSignalSummary = buildSparseFeedbackSignalSummary({
      present: false,
      positiveAttributedMemoryIds: [],
      weakCounterSignalMemoryIds: [],
      strongCounterSignalMemoryIds: [],
      thresholdMetMemoryIds: [],
      relationCounterSignalMemoryIds,
      contradictionWarningMemoryIds,
      unusedExposureObservation: emptyUnusedExposureObservation(),
    });
    return {
      present: false,
      guide_trace_id: null,
      run_id: null,
      outcome: null,
      used_surface: null,
      verifier_status: null,
      tool_status: null,
      runtime_signal_refs: [],
      affected_memory_ids: [],
      exposed_memory_count: 0,
      attributed_memory_count: 0,
      unattributed_recalled_memory_count: args.agentContext?.memory_ids.length ?? 0,
      attributed_memory_ids: [],
      unattributed_recalled_memory_ids: args.agentContext?.memory_ids ?? [],
      unattributed_use_now_memory_ids: [],
      unattributed_inspect_before_use_memory_ids: [],
      unattributed_do_not_use_memory_ids: [],
      unattributed_rehydrate_memory_ids: [],
      unused_exposure_observation: emptyUnusedExposureObservation(),
      sparse_feedback_signal_summary: sparseFeedbackSignalSummary,
      weak_counter_signal_memory_ids: [],
      strong_counter_signal_memory_ids: [],
      threshold_met_memory_ids: [],
      reason: "No activate feedback attribution was supplied for this trace.",
    };
  }
  const details = args.memoryDecisions
    .map((entry) => ({ memory_id: entry.memory_id, detail: entry.feedback_detail }))
    .filter((entry): entry is { memory_id: string; detail: FeedbackAttributionDetail } => !!entry.detail);
  const affected = new Set(args.feedbackInput.affected_memory_ids);
  const recalled = args.agentContext?.memory_ids ?? args.memoryDecisions.map((entry) => entry.memory_id);
  const attributedMemoryIds = details
    .filter((entry) => entry.detail.host_marked_used)
    .map((entry) => entry.memory_id);
  const positiveAttributedMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "positive_attribution")
    .map((entry) => entry.memory_id);
  const unattributedRecalledMemoryIds = args.feedbackInput.unattributed_recalled_memory_ids.length > 0
    ? args.feedbackInput.unattributed_recalled_memory_ids
    : recalled.filter((memoryId) => !affected.has(memoryId));
  const hasGuideTrace = !!args.feedbackInput.guide_trace_id;
  const weakCounterSignalMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "weak_counter_signal")
    .map((entry) => entry.memory_id);
  const strongCounterSignalMemoryIds = details
    .filter((entry) => entry.detail.attribution_strength === "strong_counter_signal")
    .map((entry) => entry.memory_id);
  const thresholdMetMemoryIds = details
    .filter((entry) => entry.detail.threshold_met)
    .map((entry) => entry.memory_id);
  const sparseFeedbackSignalSummary = buildSparseFeedbackSignalSummary({
    present: args.feedbackInput.present,
    positiveAttributedMemoryIds,
    weakCounterSignalMemoryIds,
    strongCounterSignalMemoryIds,
    thresholdMetMemoryIds,
    relationCounterSignalMemoryIds,
    contradictionWarningMemoryIds,
    unusedExposureObservation: args.feedbackInput.unused_exposure_observation,
  });
  return {
    present: true,
    guide_trace_id: args.feedbackInput.guide_trace_id,
    run_id: args.feedbackInput.run_id,
    outcome: args.feedbackInput.outcome,
    used_surface: args.feedbackInput.used_surface,
    verifier_status: args.feedbackInput.verifier_status,
    tool_status: args.feedbackInput.tool_status,
    runtime_signal_refs: args.feedbackInput.runtime_signal_refs,
    affected_memory_ids: args.feedbackInput.affected_memory_ids,
    exposed_memory_count: hasGuideTrace ? args.feedbackInput.exposed_memory_count : 0,
    attributed_memory_count: hasGuideTrace ? args.feedbackInput.attributed_memory_count : attributedMemoryIds.length,
    unattributed_recalled_memory_count: hasGuideTrace
      ? args.feedbackInput.unattributed_recalled_memory_count
      : unattributedRecalledMemoryIds.length,
    attributed_memory_ids: attributedMemoryIds,
    unattributed_recalled_memory_ids: unattributedRecalledMemoryIds,
    unattributed_use_now_memory_ids: args.feedbackInput.unattributed_use_now_memory_ids,
    unattributed_inspect_before_use_memory_ids: args.feedbackInput.unattributed_inspect_before_use_memory_ids,
    unattributed_do_not_use_memory_ids: args.feedbackInput.unattributed_do_not_use_memory_ids,
    unattributed_rehydrate_memory_ids: args.feedbackInput.unattributed_rehydrate_memory_ids,
    unused_exposure_observation: args.feedbackInput.unused_exposure_observation,
    sparse_feedback_signal_summary: sparseFeedbackSignalSummary,
    weak_counter_signal_memory_ids: weakCounterSignalMemoryIds,
    strong_counter_signal_memory_ids: strongCounterSignalMemoryIds,
    threshold_met_memory_ids: thresholdMetMemoryIds,
    reason: "Activate feedback is attributed only to host-reported used memory ids; recalled but unreported memories remain unattributed.",
  };
}

function emptyNeighborhoodDriftObservation(
  reason = "No neighborhood drift signal was observed for this trace.",
): NeighborhoodDriftObservation {
  return {
    present: false,
    contract_version: null,
    mode: null,
    authority_mutation: false,
    growth_threshold: NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD,
    directional_drift_threshold: NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD,
    isolation_threshold: NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD,
    signal_memory_ids: [],
    candidate_count: 0,
    candidates: [],
    reason,
  };
}

function parseObservedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedDriftTokens(entry: MemoryPacketEntry): Set<string> {
  const text = compactStrings([entry.title, entry.summary]).join(" ").toLowerCase();
  const tokens = text
    .replace(/[/_.:-]+/g, " ")
    .match(/[a-z0-9]{4,}/g) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    if (NEIGHBORHOOD_DRIFT_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function memoryTargetFiles(entry: MemoryPacketEntry): string[] {
  return compactStrings([
    ...(entry.target_files ?? []),
    ...extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`),
  ]).slice(0, 16);
}

function sharedPathCount(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  let count = 0;
  for (const value of right) {
    if (leftSet.has(value)) count += 1;
  }
  return count;
}

function hasPositiveAttribution(
  decision: AionisMemoryDecisionTrace["memory_decisions"][number] | undefined,
): boolean {
  return decision?.feedback_detail?.attribution_strength === "positive_attribution";
}

function buildNeighborhoodDriftObservation(args: {
  memory: AionisMemoryPacket | null;
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
}): NeighborhoodDriftObservation {
  const entries = (args.memory?.relevant_memories ?? []).slice(0, 96);
  if (entries.length < 3) {
    return emptyNeighborhoodDriftObservation("Neighborhood drift observation needs at least one older memory and two newer related memories.");
  }
  const decisionsById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const metadata = entries.map((entry) => ({
    entry,
    observedTime: parseObservedTime(entry.observed_at),
    targetFiles: memoryTargetFiles(entry),
    tokens: normalizedDriftTokens(entry),
  }));
  const candidates: NeighborhoodDriftCandidate[] = [];

  for (const target of metadata) {
    if (target.observedTime === null) continue;
    const related: string[] = [];
    const directionalDrift: string[] = [];
    const sameDirection: string[] = [];

    for (const source of metadata) {
      if (source.entry.memory_id === target.entry.memory_id) continue;
      if (source.observedTime === null || source.observedTime <= target.observedTime) continue;
      const sharedPaths = sharedPathCount(target.targetFiles, source.targetFiles);
      const topicOverlap = intersectionSize(target.tokens, source.tokens);
      const isRelated = (sharedPaths > 0 && topicOverlap >= 2) || topicOverlap >= 5;
      if (!isRelated) continue;
      related.push(source.entry.memory_id);
      if (topicOverlap >= 6) {
        sameDirection.push(source.entry.memory_id);
      } else if (sharedPaths > 0 && topicOverlap >= 2) {
        directionalDrift.push(source.entry.memory_id);
      }
    }

    const isolationScore = hasPositiveAttribution(decisionsById.get(target.entry.memory_id)) ? 0 : 1;
    const signalPresent =
      related.length >= NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD
      && directionalDrift.length >= NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD
      && isolationScore >= NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD;

    if (!signalPresent) continue;
    candidates.push({
      memory_id: target.entry.memory_id,
      title: target.entry.title,
      signal_present: true,
      neighborhood_growth_count: related.length,
      newer_related_memory_count: related.length,
      directional_drift_count: directionalDrift.length,
      same_direction_growth_count: sameDirection.length,
      isolation_score: isolationScore,
      related_memory_ids: related.slice(0, 12),
      directional_drift_memory_ids: directionalDrift.slice(0, 12),
      same_direction_memory_ids: sameDirection.slice(0, 12),
      reason: "Older memory has multiple newer related memories on the same target surface with directional drift and no positive attribution in this trace; this is read-only evidence for audit/measure, not authority mutation.",
    });
  }

  if (candidates.length === 0) {
    return emptyNeighborhoodDriftObservation("No isolated memory met the conservative growth, directional-drift, and isolation thresholds.");
  }
  const signalMemoryIds = candidates.map((entry) => entry.memory_id);
  return {
    present: true,
    contract_version: "aionis_neighborhood_drift_observation_v1",
    mode: "read_only_measure",
    authority_mutation: false,
    growth_threshold: NEIGHBORHOOD_DRIFT_GROWTH_THRESHOLD,
    directional_drift_threshold: NEIGHBORHOOD_DRIFT_DIRECTIONAL_THRESHOLD,
    isolation_threshold: NEIGHBORHOOD_DRIFT_ISOLATION_THRESHOLD,
    signal_memory_ids: signalMemoryIds,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 24),
    reason: "Neighborhood drift is reported as a read-only sparse feedback observation; it does not lower authority, change guide placement, suppress, archive, or delete memory.",
  };
}

function traceRelationDecisions(memory: AionisMemoryPacket | null): AionisMemoryDecisionTrace["relation_decisions"] {
  return (memory?.evidence_trail ?? [])
    .filter((entry) => entry.source === "edge" && !!entry.lifecycle_relation)
    .slice(0, 96)
    .map((entry) => ({
      evidence_id: entry.evidence_id,
      memory_id: entry.memory_id,
      relation: entry.relation,
      source_memory_id: entry.lifecycle_relation!.source_memory_id,
      target_memory_id: entry.lifecycle_relation!.target_memory_id,
      lifecycle_relation: entry.lifecycle_relation!.lifecycle_relation,
      confidence: entry.lifecycle_relation!.confidence,
      producer: entry.lifecycle_relation!.producer,
      candidate_confidence: entry.lifecycle_relation!.candidate_confidence,
      signals: entry.lifecycle_relation!.signals,
      gate: entry.lifecycle_relation!.gate,
      reason: entry.reason,
      reasons: entry.lifecycle_relation!.reasons,
    }));
}

function relationDecisionByTarget(
  relationDecisions: AionisMemoryDecisionTrace["relation_decisions"],
): Map<string, AionisMemoryDecisionTrace["relation_decisions"][number]> {
  return new Map(relationDecisions.map((entry) => [entry.target_memory_id, entry]));
}

function traceDecisionKind(args: {
  surface: AionisMemoryDecisionSurface;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["decision_kind"] {
  if (args.surface === "use_now") return "used";
  if (args.surface === "inspect_before_use") return "downgraded";
  if (args.surface === "do_not_use") return "blocked";
  if (args.surface === "rehydrate") return "rehydrate";
  return "not_agent_facing";
}

function traceUsedDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
  relationDecision: AionisMemoryDecisionTrace["relation_decisions"][number] | undefined;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["used_detail"] {
  if (args.surface !== "use_now") return null;
  return {
    authority: args.entry.authority,
    confidence: args.entry.confidence,
    salience: args.entry.salience,
    source_layer: args.entry.source_layer,
    not_superseded: !args.relationDecision,
  };
}

function traceDowngradedDetail(args: {
  surface: AionisMemoryDecisionSurface;
  relationDecision: AionisMemoryDecisionTrace["relation_decisions"][number] | undefined;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["downgraded_detail"] {
  if (args.surface !== "inspect_before_use" || !args.relationDecision) return null;
  return {
    by_memory_id: args.relationDecision.source_memory_id,
    evidence_id: args.relationDecision.evidence_id,
    relation: {
      source_memory_id: args.relationDecision.source_memory_id,
      target_memory_id: args.relationDecision.target_memory_id,
      lifecycle_relation: args.relationDecision.lifecycle_relation,
      confidence: args.relationDecision.confidence,
      producer: args.relationDecision.producer,
      candidate_confidence: args.relationDecision.candidate_confidence,
      signals: args.relationDecision.signals,
      gate: args.relationDecision.gate,
      reasons: args.relationDecision.reasons,
    },
  };
}

function traceBlockedBy(entry: MemoryPacketEntry): NonNullable<AionisMemoryDecisionTrace["memory_decisions"][number]["blocked_detail"]>["blocked_by"] {
  if (entry.lifecycle_state === "suppressed" || entry.lifecycle_state === "demoted") return "suppressed_lifecycle";
  if (entry.lifecycle_state === "archived") return "archived_lifecycle";
  if (entry.authority === "blocked") return "blocked_authority";
  if (entry.authority === "candidate" || entry.authority === "none") return "low_authority";
  return "agent_surface_projection";
}

function traceBlockedDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["blocked_detail"] {
  if (args.surface !== "do_not_use") return null;
  const blockedBy = traceBlockedBy(args.entry);
  return {
    blocked_by: blockedBy,
    lifecycle_state: args.entry.lifecycle_state,
    authority: args.entry.authority,
    reason: `Memory is not exposed for direct agent use because ${blockedBy}.`,
  };
}

function traceRehydrateDetail(args: {
  entry: MemoryPacketEntry;
  surface: AionisMemoryDecisionSurface;
  memory: AionisMemoryPacket | null;
  guide: AionisGuidePacket | null;
  agentContext: AionisAgentContext | null;
}): AionisMemoryDecisionTrace["memory_decisions"][number]["rehydrate_detail"] {
  if (args.surface !== "rehydrate") return null;
  const memoryHint = args.memory?.lifecycle.rehydration_hints.find((hint) => hint.memory_id === args.entry.memory_id);
  const agentHint = args.agentContext?.rehydrate_hints.find((hint) => hint.memory_id === args.entry.memory_id);
  const guideHint = args.guide?.guide_brief.rehydrate.find((hint) => hint.memory_id === args.entry.memory_id);
  return {
    mode: memoryHint?.mode ?? "differential",
    reason: memoryHint?.reason ?? agentHint?.reason ?? guideHint?.reason ?? "Memory requires payload rehydration before use.",
    required: memoryHint?.required ?? agentHint?.required ?? guideHint?.required ?? false,
    payload_status: memoryHint ? "cold_payload" : "unknown",
  };
}

function traceMemoryIdsForSurface(
  trace: AionisMemoryDecisionTrace,
  surface: TraceDecisionSurface,
): string[] {
  return compactStrings(
    trace.memory_decisions
      .filter((entry) => entry.agent_surface === surface)
      .map((entry) => entry.memory_id),
  );
}

function buildLifecycleCandidateSummary(args: {
  signals: AionisLifecycleCandidateSignal[];
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
}): LifecycleCandidateSummary {
  if (args.signals.length === 0) {
    return {
      present: false,
      contract_version: null,
      mode: null,
      authority_mutation: false,
      agent_prompt_included: false,
      signal_payload_prompt_included: false,
      surface_effect_prompt_included: false,
      candidate_count: 0,
      gated_count: 0,
      shadow_only_count: 0,
      candidate_memory_ids: [],
      gated_memory_ids: [],
      shadow_only_memory_ids: [],
      signals: [],
      reason: "No lifecycle candidate signals were produced.",
    };
  }
  const decisionsById = new Map(args.memoryDecisions.map((entry) => [entry.memory_id, entry]));
  const signalsById = lifecycleCandidateSignalsByMemoryId(args.signals);
  const gatedMemoryIds = compactStrings([...signalsById.entries()]
    .filter(([memoryId, signals]) => {
      const decision = decisionsById.get(memoryId);
      const surface = decision?.agent_surface ?? "not_agent_facing";
      return (
        lifecycleCandidateMemoryDirectUseUnsafe(signals)
        && surface !== "use_now"
        && surface !== "not_agent_facing"
      ) || signals.some((signal) => lifecycleCandidateAllowsRehydrate({
        signal,
        surface,
        memory_lifecycle_state: decision?.lifecycle_state ?? "unknown",
        rehydration_requested: surface === "rehydrate",
      }));
    })
    .map(([memoryId]) => memoryId));
  const candidateMemoryIds = compactStrings(args.signals.map((signal) => signal.memory_id));
  const gatedSet = new Set(gatedMemoryIds);
  const shadowOnlyMemoryIds = candidateMemoryIds.filter((memoryId) => !gatedSet.has(memoryId));
  const admittedDirectUseMemoryIds = compactStrings(args.memoryDecisions
    .filter((decision) =>
      decision.agent_surface === "use_now"
      && decision.reason_codes.includes("lifecycle_candidate_direct_use_admitted")
    )
    .map((decision) => decision.memory_id));
  const surfaceEffectPromptIncluded = gatedMemoryIds.length > 0 || admittedDirectUseMemoryIds.length > 0;
  return {
    present: true,
    contract_version: "aionis_lifecycle_candidate_summary_v1",
    mode: gatedMemoryIds.length > 0 ? "rule_gated" : "rule_shadow",
    authority_mutation: false,
    agent_prompt_included: false,
    signal_payload_prompt_included: false,
    surface_effect_prompt_included: surfaceEffectPromptIncluded,
    candidate_count: args.signals.length,
    gated_count: gatedMemoryIds.length,
    shadow_only_count: shadowOnlyMemoryIds.length,
    candidate_memory_ids: candidateMemoryIds,
    gated_memory_ids: gatedMemoryIds,
    shadow_only_memory_ids: shadowOnlyMemoryIds,
    signals: args.signals.slice(0, 64),
    reason: gatedMemoryIds.length > 0
      ? "Lifecycle candidate signal payloads were not injected into the Agent prompt, but their gated surface effect may appear through inspect/rehydrate context; memory rows were not mutated."
      : surfaceEffectPromptIncluded
        ? "Lifecycle candidate signal payloads were not injected into the Agent prompt, but current/procedure admission affected the compiled context surface; memory rows were not mutated."
        : "Lifecycle candidate signals are visible as shadow evidence only; signal payloads, memory rows, and authority were not mutated.",
  };
}

type JudgmentCalibrationOutcome = "supported" | "contradicted" | "unused" | "inconclusive";

type JudgmentCalibrationBucketDraft = {
  record_count: number;
  supported_count: number;
  contradicted_count: number;
  weak_count: number;
  unused_count: number;
  inconclusive_count: number;
  memory_ids: string[];
};

function emptyJudgmentCalibrationBucketDraft(): JudgmentCalibrationBucketDraft {
  return {
    record_count: 0,
    supported_count: 0,
    contradicted_count: 0,
    weak_count: 0,
    unused_count: 0,
    inconclusive_count: 0,
    memory_ids: [],
  };
}

function feedbackDetailIsWeakNegative(
  detail: FeedbackAttributionDetail | null,
): boolean {
  return detail?.outcome === "negative"
    && (
      detail.attribution_strength === "weak_counter_signal"
      || detail.threshold_state === "weak_below_threshold"
    )
    && detail.threshold_met === false;
}

function judgmentOutcomeForDecision(args: {
  decision: AionisMemoryDecisionTrace["memory_decisions"][number];
  feedbackAttribution: FeedbackAttributionSummary;
}): JudgmentCalibrationOutcome {
  const detail = args.decision.feedback_detail;
  if (detail) {
    if (detail.outcome === "positive") return "supported";
    if (detail.outcome === "negative") {
      return feedbackDetailIsWeakNegative(detail) ? "inconclusive" : "contradicted";
    }
    return "inconclusive";
  }
  if (
    args.feedbackAttribution.present
    && args.feedbackAttribution.unattributed_recalled_memory_ids.includes(args.decision.memory_id)
  ) {
    return "unused";
  }
  return "inconclusive";
}

function judgmentCalibrationBucketsForDecision(args: {
  decision: AionisMemoryDecisionTrace["memory_decisions"][number];
  relationDecision: AionisMemoryDecisionTrace["relation_decisions"][number] | undefined;
  lifecycleSignals: AionisLifecycleCandidateSignal[];
  feedbackAttribution: FeedbackAttributionSummary;
}): string[] {
  const sparse = args.feedbackAttribution.sparse_feedback_signal_summary;
  return compactStrings([
    `surface:${args.decision.agent_surface}`,
    `domain:${args.decision.domain}`,
    args.decision.memory_type === "procedure" || args.decision.memory_type === "execution_memory"
      ? "domain:execution_memory"
      : null,
    args.relationDecision ? `signal:relation_${args.relationDecision.lifecycle_relation}` : null,
    ...args.lifecycleSignals.map((signal) => `signal:lifecycle_${signal.signal_type}`),
    sparse.positive_attributed_memory_ids.includes(args.decision.memory_id) ? "signal:feedback_positive" : null,
    sparse.weak_counter_signal_memory_ids.includes(args.decision.memory_id)
      || sparse.strong_counter_signal_memory_ids.includes(args.decision.memory_id)
      ? "signal:feedback_negative"
      : null,
    sparse.repeated_unattributed_memory_ids.includes(args.decision.memory_id) ? "signal:repeated_unused" : null,
  ]);
}

function judgmentCalibrationRecommendedAdjustment(
  draft: JudgmentCalibrationBucketDraft,
): JudgmentCalibrationSummary["buckets"][number]["recommended_adjustment"] {
  if (draft.record_count === 0) return "needs_more_evidence";
  if (draft.contradicted_count > 0 && draft.contradicted_count >= draft.supported_count) return "inspect_first";
  if (draft.unused_count > draft.supported_count && draft.unused_count > 0) return "needs_more_evidence";
  if (draft.supported_count > draft.contradicted_count && draft.supported_count > 0) return "keep";
  return "needs_more_evidence";
}

function buildAionisJudgmentCalibrationSummary(args: {
  memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"];
  relationDecisions: AionisMemoryDecisionTrace["relation_decisions"];
  lifecycleCandidateSummary: LifecycleCandidateSummary;
  feedbackAttribution: FeedbackAttributionSummary;
}): JudgmentCalibrationSummary {
  const relationByTarget = relationDecisionByTarget(args.relationDecisions);
  const lifecycleSignalsByMemoryId = new Map<string, AionisLifecycleCandidateSignal[]>();
  for (const signal of args.lifecycleCandidateSummary.signals) {
    const next = lifecycleSignalsByMemoryId.get(signal.memory_id) ?? [];
    next.push(signal);
    lifecycleSignalsByMemoryId.set(signal.memory_id, next);
  }

  const supportedMemoryIds: string[] = [];
  const contradictedMemoryIds: string[] = [];
  const weakMemoryIds: string[] = [];
  const unusedMemoryIds: string[] = [];
  const inconclusiveMemoryIds: string[] = [];
  const buckets = new Map<string, JudgmentCalibrationBucketDraft>();
  let anchoredCount = 0;

  for (const decision of args.memoryDecisions) {
    const outcome = judgmentOutcomeForDecision({
      decision,
      feedbackAttribution: args.feedbackAttribution,
    });
    const weak = feedbackDetailIsWeakNegative(decision.feedback_detail);
    if (decision.feedback_detail?.host_marked_used === true) anchoredCount += 1;
    if (outcome === "supported") supportedMemoryIds.push(decision.memory_id);
    else if (outcome === "contradicted") contradictedMemoryIds.push(decision.memory_id);
    else if (outcome === "unused") unusedMemoryIds.push(decision.memory_id);
    else inconclusiveMemoryIds.push(decision.memory_id);
    if (weak) weakMemoryIds.push(decision.memory_id);

    const decisionBuckets = judgmentCalibrationBucketsForDecision({
      decision,
      relationDecision: relationByTarget.get(decision.memory_id),
      lifecycleSignals: lifecycleSignalsByMemoryId.get(decision.memory_id) ?? [],
      feedbackAttribution: args.feedbackAttribution,
    });
    for (const bucket of decisionBuckets) {
      const draft = buckets.get(bucket) ?? emptyJudgmentCalibrationBucketDraft();
      draft.record_count += 1;
      if (outcome === "supported") draft.supported_count += 1;
      else if (outcome === "contradicted") draft.contradicted_count += 1;
      else if (outcome === "unused") draft.unused_count += 1;
      else draft.inconclusive_count += 1;
      if (weak) draft.weak_count += 1;
      draft.memory_ids = compactStrings([...draft.memory_ids, decision.memory_id]).slice(0, 48);
      buckets.set(bucket, draft);
    }
  }

  const summaryBuckets: JudgmentCalibrationSummary["buckets"] = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 32)
    .map(([bucket, draft]) => ({
      bucket,
      record_count: draft.record_count,
      supported_count: draft.supported_count,
      contradicted_count: draft.contradicted_count,
      weak_count: draft.weak_count,
      unused_count: draft.unused_count,
      inconclusive_count: draft.inconclusive_count,
      memory_ids: draft.memory_ids,
      recommended_adjustment: judgmentCalibrationRecommendedAdjustment(draft),
      authority: "read_only",
      reason: `Read-only calibration bucket ${bucket}: ${draft.supported_count} supported, ${draft.contradicted_count} contradicted, ${draft.unused_count} unused, ${draft.inconclusive_count} inconclusive.`,
    }));

  const recordCount = args.memoryDecisions.length;
  const weakIds = compactStrings(weakMemoryIds);
  const inconclusiveIds = compactStrings(inconclusiveMemoryIds);
  return {
    contract_version: "aionis_judgment_calibration_summary_v1",
    intended_use: "judgment_calibration_audit",
    source: "memory_decision_trace",
    agent_prompt_included: false,
    runtime_mutation: false,
    authority: "read_only",
    window: {
      record_count: recordCount,
      anchored_count: anchoredCount,
      weak_count: weakIds.length,
      unused_count: compactStrings(unusedMemoryIds).length,
      inconclusive_count: inconclusiveIds.length,
    },
    supported_memory_ids: compactStrings(supportedMemoryIds).slice(0, 64),
    contradicted_memory_ids: compactStrings(contradictedMemoryIds).slice(0, 64),
    weak_memory_ids: weakIds.slice(0, 64),
    unused_memory_ids: compactStrings(unusedMemoryIds).slice(0, 64),
    inconclusive_memory_ids: inconclusiveIds.slice(0, 64),
    buckets: summaryBuckets,
    reason: recordCount > 0
      ? "Memory judgment calibration was derived from decision trace surfaces and feedback attribution only; it is read-only and does not mutate authority."
      : "No memory judgment decisions were available for calibration.",
  };
}

export function buildAionisMemoryUseReceiptFromDecisionTrace(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryUseReceipt {
  const useNowMemoryIds = traceMemoryIdsForSurface(trace, "use_now");
  const inspectBeforeUseMemoryIds = traceMemoryIdsForSurface(trace, "inspect_before_use");
  const doNotUseMemoryIds = traceMemoryIdsForSurface(trace, "do_not_use");
  const rehydrateMemoryIds = traceMemoryIdsForSurface(trace, "rehydrate");
  const sparseSummary = trace.feedback_attribution.sparse_feedback_signal_summary;
  const riskFlags = compactStrings([
    trace.summary.negative_transfer_risk !== "low"
      ? `negative_transfer_risk:${trace.summary.negative_transfer_risk}`
      : null,
    ...trace.memory_decisions
      .filter((entry) => entry.agent_surface !== "use_now")
      .flatMap((entry) => entry.reason_codes),
    ...trace.relation_decisions.map((entry) => `relation:${entry.lifecycle_relation}`),
    ...sparseSummary.weak_counter_signal_memory_ids.map((id) => `weak_counter_signal:${id}`),
    ...sparseSummary.strong_counter_signal_memory_ids.map((id) => `strong_counter_signal:${id}`),
    ...sparseSummary.relation_counter_signal_memory_ids.map((id) => `relation_counter_signal:${id}`),
    ...sparseSummary.contradiction_warning_memory_ids.map((id) => `contradiction_warning:${id}`),
    ...sparseSummary.repeated_unattributed_without_positive_memory_ids.map((id) =>
      `repeated_unattributed_without_positive:${id}`
    ),
  ]).slice(0, 64);
  const exposedMemoryIds = compactStrings([
    ...trace.context_decision.memory_ids,
    ...useNowMemoryIds,
    ...inspectBeforeUseMemoryIds,
    ...doNotUseMemoryIds,
    ...rehydrateMemoryIds,
  ]);
  const decisionSummaries = trace.memory_decisions
    .filter((entry) => entry.agent_surface !== "not_agent_facing" || entry.reason_codes.length > 0)
    .slice(0, 48)
    .map((entry) => ({
      memory_id: entry.memory_id,
      agent_surface: entry.agent_surface,
      decision_kind: entry.decision_kind,
      actionable: entry.agent_surface === "use_now",
      reason_codes: compactStrings(entry.reason_codes).slice(0, 12),
      recall_sources: entry.recall_sources,
    }));

  return parseAionisMemoryUseReceipt({
    contract_version: "aionis_memory_use_receipt_v1",
    intended_use: "memory_use_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: trace.feedback_attribution.guide_trace_id,
    history_used: trace.summary.history_used,
    actionable_history_used: trace.summary.actionable_history_used,
    prompt_char_count: trace.context_decision.prompt_char_count,
    exposed_memory_ids: exposedMemoryIds,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: doNotUseMemoryIds,
    rehydrate_memory_ids: rehydrateMemoryIds,
    attributed_memory_ids: trace.feedback_attribution.attributed_memory_ids,
    unattributed_recalled_memory_ids: trace.feedback_attribution.unattributed_recalled_memory_ids,
    read_only_signal_memory_ids: sparseSummary.read_only_signal_memory_ids,
    decision_summaries: decisionSummaries,
    risk_flags: riskFlags,
    summary: `Aionis compiled memory into ${useNowMemoryIds.length} use_now, ${inspectBeforeUseMemoryIds.length} inspect_before_use, ${doNotUseMemoryIds.length} do_not_use, and ${rehydrateMemoryIds.length} rehydrate decisions; receipt is read-only and excluded from the Agent prompt.`,
  });
}

export function buildAionisMemoryAdmissionRecordFromDecisionTrace(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryAdmissionRecord {
  const attributedIds = new Set(trace.feedback_attribution.attributed_memory_ids);
  const promptMemoryIds = new Set([
    ...trace.context_decision.memory_ids,
    ...traceMemoryIdsForSurface(trace, "use_now"),
    ...traceMemoryIdsForSurface(trace, "inspect_before_use"),
    ...traceMemoryIdsForSurface(trace, "do_not_use"),
    ...traceMemoryIdsForSurface(trace, "rehydrate"),
  ]);
  const entries = trace.memory_decisions.slice(0, 96).map((decision) => {
    const promptIncluded = decision.agent_surface !== "not_agent_facing" || promptMemoryIds.has(decision.memory_id);
    const agentUsed = attributedIds.has(decision.memory_id) || decision.feedback_detail?.host_marked_used === true;
    return {
      memory_id: decision.memory_id,
      title: decision.title,
      domain: decision.domain,
      memory_type: decision.memory_type,
      lifecycle_state: decision.lifecycle_state,
      authority: decision.authority,
      admission_action: decision.agent_surface,
      decision_kind: decision.decision_kind,
      actionable: decision.agent_surface === "use_now",
      prompt_included: promptIncluded,
      agent_used: agentUsed,
      feedback_outcome: agentUsed || trace.feedback_attribution.affected_memory_ids.includes(decision.memory_id)
        ? trace.feedback_attribution.outcome
        : null,
      attribution_strength: decision.feedback_detail?.attribution_strength ?? null,
      reason_codes: compactStrings(decision.reason_codes).slice(0, 16),
      evidence_ids: compactStrings(decision.evidence_ids).slice(0, 16),
      recall_sources: decision.recall_sources,
    };
  });
  const promptIncludedCount = entries.filter((entry) => entry.prompt_included).length;
  const agentUsedCount = entries.filter((entry) => entry.agent_used).length;
  const baseRecord = parseAionisMemoryAdmissionRecord({
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "memory_decision_trace",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: trace.tenant_id,
    scope: trace.scope,
    guide_trace_id: trace.feedback_attribution.guide_trace_id,
    prompt_char_count: trace.context_decision.prompt_char_count,
    history_used: trace.summary.history_used,
    actionable_history_used: trace.summary.actionable_history_used,
    candidate_memory_count: entries.length,
    prompt_included_memory_count: promptIncludedCount,
    agent_used_memory_count: agentUsedCount,
    entries,
    summary: `Aionis recorded ${entries.length} memory admission decisions, ${promptIncludedCount} agent-facing exposures, and ${agentUsedCount} host-attributed uses; record is read-only and excluded from the Agent prompt.`,
  });
  return parseAionisMemoryAdmissionRecord({
    ...baseRecord,
    shadow_policy_report: buildAionisMemoryAdmissionShadowPolicyReportFromRecord(
      baseRecord,
      "memory_decision_trace",
    ),
  });
}

export function buildAionisMemoryDecisionTrace(args: BuildAionisMemoryDecisionTraceArgs): AionisMemoryDecisionTrace {
  const memory = args.after_guide.memory_packet ?? null;
  const guide = args.after_guide.guide_packet ?? null;
  const agentContext = args.after_guide.agent_context ?? null;
  const relationDecisions = traceRelationDecisions(memory);
  const relationByTarget = relationDecisionByTarget(relationDecisions);
  const forgetDecisions = traceForgetDecisions(args.forget_result);
  const feedbackInput = traceFeedbackAttributionInput(args.forget_result);
  const inferredLifecycleCandidateSignals = inferLifecycleCandidateSignals({
    entries: memory?.relevant_memories ?? [],
    query_intent: args.after_guide.memory_packet?.query.intent ?? null,
  });
  const lifecycleCandidateSignals = mergeTraceLifecycleCandidateSignals({
    inferred: inferredLifecycleCandidateSignals,
    shadow_signals: args.lifecycle_candidate_shadow_signals,
    memory_ids: new Set((memory?.relevant_memories ?? []).map((entry) => entry.memory_id)),
  });
  const traceExecutionScope: NormalizedAgentPromptExecutionScope = { task_signature: null, task_family: null, workflow_signature: null };
  const memoryDecisions: AionisMemoryDecisionTrace["memory_decisions"] = (memory?.relevant_memories ?? [])
    .slice(0, 96)
    .map((entry) => {
      const projectedSurface = traceProjectedSurfaceForMemory({ entry, guide, agentContext });
      const entryLifecycleSignals = lifecycleCandidateSignals.filter((signal) => signal.memory_id === entry.memory_id);
      const governanceDecision = governanceDecisionForMemoryEntry({
        entry,
        executionScope: traceExecutionScope,
        projectedSurface,
        verifiedRecoveredHandoff: projectedSurface === "use_now" && contractEntryIsHandoff(entry),
        rehydrateRequested: projectedSurface === "rehydrate",
        lifecycleCandidate: lifecycleCandidateRehydrateEligible({ entry, signals: entryLifecycleSignals })
          ? "rehydrate"
          : lifecycleCandidateMemoryDirectUseAdmissible({ entry, signals: entryLifecycleSignals })
            ? "direct_use"
            : lifecycleCandidateMemoryDirectUseUnsafe(entryLifecycleSignals) ? "inspect_before_use" : "none",
      });
      const surface = governanceDecision.surface;
      const relationDecision = relationByTarget.get(entry.memory_id);
      return {
        memory_id: entry.memory_id,
        title: entry.title,
        domain: entry.domain,
        memory_type: entry.memory_type,
        lifecycle_state: entry.lifecycle_state,
        authority: entry.authority,
        agent_surface: surface,
        decision_kind: traceDecisionKind({ surface }),
        evidence_ids: entry.evidence_ids,
        recall_sources: entry.recall_sources,
        used_detail: traceUsedDetail({ entry, surface, relationDecision }),
        downgraded_detail: traceDowngradedDetail({ surface, relationDecision }),
        blocked_detail: traceBlockedDetail({ entry, surface }),
        feedback_detail: traceFeedbackDetail({ entry, feedbackInput }),
        rehydrate_detail: traceRehydrateDetail({ entry, surface, memory, guide, agentContext }),
        reason_codes: traceReasonCodes({
          entry,
          memory,
          guide,
          agentContext,
          lifecycleCandidateSignals,
          governanceReasonCodes: governanceDecision.reason_codes,
        }),
      };
    });
  const lifecycleCandidateSummary = buildLifecycleCandidateSummary({
    signals: lifecycleCandidateSignals,
    memoryDecisions,
  });
  const feedbackAttribution = buildTraceFeedbackAttribution({
    feedbackInput,
    memoryDecisions,
    agentContext,
  });
  const judgmentCalibrationSummary = buildAionisJudgmentCalibrationSummary({
    memoryDecisions,
    relationDecisions,
    lifecycleCandidateSummary,
    feedbackAttribution,
  });
  const neighborhoodDriftObservation = buildNeighborhoodDriftObservation({
    memory,
    memoryDecisions,
  });
  const confidenceDecayCandidateSummary = buildConfidenceDecayCandidateSummary({
    feedbackAttribution,
    memory,
    memoryDecisions,
    neighborhoodDriftObservation,
  });
  const inspectBeforeUseShadowDelta = buildInspectBeforeUseShadowDelta({
    confidenceDecayCandidateSummary,
    memoryDecisions,
  });
  const directUseCount = memoryDecisions.filter((entry) => entry.agent_surface === "use_now").length;
  const inspectCount = memoryDecisions.filter((entry) => entry.agent_surface === "inspect_before_use").length;
  const doNotUseCount = memoryDecisions.filter((entry) => entry.agent_surface === "do_not_use").length;
  const rehydrateCount = memoryDecisions.filter((entry) => entry.agent_surface === "rehydrate").length;
  const recallSourceTracePresent = memoryDecisions.some((entry) => entry.recall_sources.length > 0);
  const fallbackActionableHistoryUsed = directUseCount > 0 || inspectCount > 0 || doNotUseCount > 0 || rehydrateCount > 0;
  const contextDecision = {
    prompt_char_count: agentContext?.prompt_text.length ?? 0,
    target_files: agentContext?.target_files ?? [],
    use_now_count: agentContext?.use_now.length ?? guide?.guide_brief.use_now.length ?? 0,
    inspect_before_use_count: agentContext?.inspect_before_use.length ?? guide?.guide_brief.inspect_before_use.length ?? 0,
    do_not_use_count: agentContext?.do_not_use.length ?? guide?.guide_brief.do_not_use.length ?? 0,
    rehydrate_hint_count: agentContext?.rehydrate_hints.length ?? guide?.guide_brief.rehydrate.length ?? 0,
    actionable_history_used: agentContext?.actionable_history_used ?? guide?.guide_brief.actionable_history_used ?? fallbackActionableHistoryUsed,
    memory_ids: agentContext?.memory_ids ?? guide?.memory_lifecycle.used_memory_ids ?? [],
  };
  const feedbackAttributionCount = feedbackAttribution.attributed_memory_ids.length;
  const feedbackThresholdMetCount = feedbackAttribution.threshold_met_memory_ids.length;
  const historyUsed = agentContext?.history_used ?? guide?.guide_brief.history_used ?? memoryDecisions.length > 0;
  const actionableHistoryUsed =
    (agentContext?.actionable_history_used
      ?? guide?.guide_brief.actionable_history_used
      ?? fallbackActionableHistoryUsed);
  const recommendedPosture =
    agentContext?.recommended_posture
    ?? guide?.guide_brief.recommended_posture
    ?? (historyUsed ? "use_as_context" : "ignore_history");
  const authority =
    agentContext?.authority
    ?? guide?.guide_brief.authority
    ?? (memory?.behavior_impact.will_shape_behavior ? "advisory" : "none");
  const negativeTransferRisk =
    agentContext?.risk.negative_transfer_risk
    ?? guide?.risk.negative_transfer_risk
    ?? memory?.risk.negative_transfer_risk
    ?? "low";
  const contradictionWarningCount = memory?.contradiction_warnings.length ?? 0;
  const controlVisible =
    inspectCount > 0
    || doNotUseCount > 0
    || rehydrateCount > 0
    || relationDecisions.length > 0
    || contradictionWarningCount > 0
    || feedbackAttribution.present
    || confidenceDecayCandidateSummary.present
    || inspectBeforeUseShadowDelta.present
    || forgetDecisions.length > 0
    || negativeTransferRisk !== "low";

  const traceWithoutReceipt = parseAionisMemoryDecisionTrace({
    contract_version: "aionis_memory_decision_trace_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    intended_use: "measure_debug_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    input: {
      before_guide_present: !!args.before_guide,
      after_guide_present: true,
      memory_packet_present: !!memory,
      guide_packet_present: !!guide,
      agent_context_present: !!agentContext,
      forget_result_present: !!args.forget_result,
    },
    summary: {
      total_memory_count: memoryDecisions.length,
      direct_use_count: directUseCount,
      inspect_before_use_count: inspectCount,
      do_not_use_count: doNotUseCount,
      rehydrate_count: rehydrateCount,
      relation_count: relationDecisions.length,
      contradiction_warning_count: contradictionWarningCount,
      feedback_attribution_count: feedbackAttributionCount,
      feedback_threshold_met_count: feedbackThresholdMetCount,
      unattributed_recalled_memory_count: feedbackAttribution.unattributed_recalled_memory_ids.length,
      prompt_char_count: contextDecision.prompt_char_count,
      history_used: historyUsed,
      actionable_history_used: actionableHistoryUsed,
      recommended_posture: recommendedPosture,
      authority,
      negative_transfer_risk: negativeTransferRisk,
      learning_control_visible: controlVisible,
    },
    memory_decisions: memoryDecisions,
    relation_decisions: relationDecisions,
    lifecycle_candidate_summary: lifecycleCandidateSummary,
    feedback_attribution: feedbackAttribution,
    judgment_calibration_summary: judgmentCalibrationSummary,
    neighborhood_drift_observation: neighborhoodDriftObservation,
    confidence_decay_candidate_summary: confidenceDecayCandidateSummary,
    inspect_before_use_shadow_delta: inspectBeforeUseShadowDelta,
    context_decision: contextDecision,
    forget_decisions: forgetDecisions,
    source_map: {
      routes_used: args.source_map?.routes_used ?? [],
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? compactStrings([
        "memory_packet_lifecycle",
        "guide_packet_posture",
        agentContext ? "agent_context_surface_projection" : null,
        recallSourceTracePresent ? "recall_source_trace" : null,
        memory?.relevant_memories.some((entry) => entry.memory_contract) ? "memory_contract" : null,
        relationDecisions.length > 0 ? "memory_lifecycle_relation_graph" : null,
        lifecycleCandidateSummary.present ? "lifecycle_candidate_inference" : null,
        lifecycleCandidateSignals.some((signal) => signal.producer === "llm_shadow_v1")
          ? "memory_lifecycle_llm_shadow_candidates"
          : null,
        feedbackAttribution.present ? "feedback_attribution_trace" : null,
        judgmentCalibrationSummary.window.record_count > 0 ? "judgment_calibration_summary" : null,
        neighborhoodDriftObservation.present ? "neighborhood_drift_observation" : null,
        confidenceDecayCandidateSummary.present ? "confidence_decay_candidate_summary" : null,
        inspectBeforeUseShadowDelta.present ? "inspect_before_use_shadow_delta" : null,
        agentContext?.risk.reasons.some((reason) => reason.startsWith("premise_firewall_"))
          ? "premise_firewall"
          : null,
        forgetDecisions.length > 0 ? "forget_result_projection" : null,
        "memory_decision_trace",
        "memory_use_receipt",
        "memory_admission_record",
      ]),
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
        "agent_prompt_injection",
      ],
    },
  });

  return parseAionisMemoryDecisionTrace({
    ...traceWithoutReceipt,
    memory_use_receipt: buildAionisMemoryUseReceiptFromDecisionTrace(traceWithoutReceipt),
    admission_record: buildAionisMemoryAdmissionRecordFromDecisionTrace(traceWithoutReceipt),
  });
}

function auditClaim(args: {
  claim: AionisMemoryDecisionAuditReport["claims"][number]["claim"];
  status: AionisMemoryDecisionAuditReport["claims"][number]["status"];
  evidence: string;
}): AionisMemoryDecisionAuditReport["claims"][number] {
  return args;
}

function auditFeedbackSignalMemories(args: {
  trace: AionisMemoryDecisionTrace;
  memoryIds: string[];
  reason: string;
}): AionisMemoryDecisionAuditReport["feedback_signal_review"]["positive_attributed_memories"] {
  const decisionById = new Map(args.trace.memory_decisions.map((entry) => [entry.memory_id, entry]));
  return args.memoryIds.slice(0, 48).map((memoryId) => {
    const decision = decisionById.get(memoryId);
    return {
      memory_id: memoryId,
      title: decision?.title ?? null,
      reason: args.reason,
    };
  });
}

function buildAuditFeedbackSignalReview(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryDecisionAuditReport["feedback_signal_review"] {
  const summary = trace.feedback_attribution.sparse_feedback_signal_summary;
  return {
    present: summary.present,
    mode: summary.mode,
    authority_mutation: false,
    positive_attributed_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.positive_attributed_memory_ids,
      reason: "Host outcome positively attributed this memory as used evidence.",
    }),
    weak_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.weak_counter_signal_memory_ids,
      reason: "Host outcome produced a weak counter-signal; this remains read-only unless attribution thresholds are met elsewhere.",
    }),
    strong_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.strong_counter_signal_memory_ids,
      reason: "Host outcome produced verifier/tool/runtime-aligned counter-signal evidence.",
    }),
    relation_counter_signal_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.relation_counter_signal_memory_ids,
      reason: "Accepted lifecycle relation evidence points to newer related memory that supersedes, contradicts, or invalidates this memory.",
    }),
    contradiction_warning_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.contradiction_warning_memory_ids,
      reason: "Memory carried contradiction or contested-lifecycle warning evidence and should remain inspect-first.",
    }),
    repeated_unattributed_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.repeated_unattributed_memory_ids,
      reason: "Memory was repeatedly shown in guide traces without being host-marked as used in the current activation.",
    }),
    repeated_unattributed_without_positive_memories: auditFeedbackSignalMemories({
      trace,
      memoryIds: summary.repeated_unattributed_without_positive_memory_ids,
      reason: "Memory was repeatedly shown without any recorded positive attributed use.",
    }),
    read_only_signal_memory_ids: summary.read_only_signal_memory_ids,
    candidate_learning_control_summary: summary.candidate_learning_control_summary,
    reason: summary.reason,
  };
}

function buildAuditDecisionReviews(
  trace: AionisMemoryDecisionTrace,
): AionisMemoryDecisionAuditReport["decision_reviews"] {
  return {
    used_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "used" && !!entry.used_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        authority: entry.used_detail!.authority,
        confidence: entry.used_detail!.confidence,
        salience: entry.used_detail!.salience,
        source_layer: entry.used_detail!.source_layer,
        evidence_ids: entry.evidence_ids,
        reason: entry.used_detail!.not_superseded
          ? "Memory entered direct use because it has usable authority and no accepted lifecycle relation superseded it."
          : "Memory entered direct use, but an accepted lifecycle relation was also present in the trace.",
      })),
    downgraded_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "downgraded" && !!entry.downgraded_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        by_memory_id: entry.downgraded_detail!.by_memory_id,
        evidence_id: entry.downgraded_detail!.evidence_id,
        lifecycle_relation: entry.downgraded_detail!.relation.lifecycle_relation,
        relation_confidence: entry.downgraded_detail!.relation.confidence,
        producer: entry.downgraded_detail!.relation.producer,
        candidate_confidence: entry.downgraded_detail!.relation.candidate_confidence,
        signals: entry.downgraded_detail!.relation.signals,
        gate: entry.downgraded_detail!.relation.gate,
        reasons: entry.downgraded_detail!.relation.reasons,
      })),
    blocked_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "blocked" && !!entry.blocked_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        blocked_by: entry.blocked_detail!.blocked_by,
        lifecycle_state: entry.blocked_detail!.lifecycle_state,
        authority: entry.blocked_detail!.authority,
        reason: entry.blocked_detail!.reason,
      })),
    rehydrate_memories: trace.memory_decisions
      .filter((entry) => entry.decision_kind === "rehydrate" && !!entry.rehydrate_detail)
      .slice(0, 48)
      .map((entry) => ({
        memory_id: entry.memory_id,
        title: entry.title,
        mode: entry.rehydrate_detail!.mode,
        required: entry.rehydrate_detail!.required,
        payload_status: entry.rehydrate_detail!.payload_status,
        reason: entry.rehydrate_detail!.reason,
      })),
  };
}

export function buildAionisMemoryDecisionAuditReport(
  args: BuildAionisMemoryDecisionAuditReportArgs,
): AionisMemoryDecisionAuditReport {
  const trace = args.trace;
  const decisionReviews = buildAuditDecisionReviews(trace);
  const controlledMemoryCount =
    trace.summary.inspect_before_use_count
    + trace.summary.do_not_use_count
    + trace.summary.rehydrate_count;
  const blockedOrSuppressedCount = trace.memory_decisions.filter((entry) =>
    entry.agent_surface === "do_not_use"
    || entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "archived"
    || entry.authority === "blocked"
  ).length;
  const verdict = trace.summary.total_memory_count === 0
    ? "no_history" as const
    : trace.summary.learning_control_visible
      ? "learning_control_visible" as const
      : "insufficient_trace" as const;
  const promptCompactStatus = trace.context_decision.prompt_char_count === 0
    ? "not_applicable" as const
    : trace.context_decision.prompt_char_count <= 4096
      ? "pass" as const
      : "fail" as const;
  const feedbackSignalReview = buildAuditFeedbackSignalReview(trace);

  return parseAionisMemoryDecisionAuditReport({
    contract_version: "aionis_memory_decision_audit_report_v1",
    tenant_id: trace.tenant_id,
    scope: trace.scope,
    intended_use: "operator_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    verdict,
    claims: [
      auditClaim({
        claim: "agent_prompt_excluded",
        status: trace.agent_prompt_included === false ? "pass" : "fail",
        evidence: "Decision trace is returned on measure/debug/audit surfaces, not embedded in agent_context.prompt_text.",
      }),
      auditClaim({
        claim: "runtime_state_unchanged",
        status: trace.runtime_mutation === false ? "pass" : "fail",
        evidence: "Decision trace is a read-only projection over existing product packets and forget effects.",
      }),
      auditClaim({
        claim: "memory_lifecycle_visible",
        status: trace.summary.total_memory_count === 0 ? "not_applicable" : "pass",
        evidence: `${trace.summary.total_memory_count} memory decisions exposed with lifecycle and authority.`,
      }),
      auditClaim({
        claim: "negative_transfer_control_visible",
        status: trace.summary.learning_control_visible ? "pass" : "not_applicable",
        evidence: `${controlledMemoryCount} memories were placed on inspect/do-not-use/rehydrate surfaces.`,
      }),
      auditClaim({
        claim: "feedback_attribution_visible",
        status: trace.feedback_attribution.present ? "pass" : "not_applicable",
        evidence: trace.feedback_attribution.present
          ? `${trace.feedback_attribution.attributed_memory_ids.length} memories received host-used feedback attribution; ${trace.feedback_attribution.unattributed_recalled_memory_ids.length} recalled memories stayed unattributed.`
          : "No activate feedback attribution was supplied for this trace.",
      }),
      auditClaim({
        claim: "history_surface_compact",
        status: promptCompactStatus,
        evidence: `Agent context prompt length is ${trace.context_decision.prompt_char_count} characters.`,
      }),
    ],
    counters: {
      total_memory_count: trace.summary.total_memory_count,
      controlled_memory_count: controlledMemoryCount,
      relation_count: trace.summary.relation_count,
      feedback_attribution_count: trace.summary.feedback_attribution_count,
      feedback_threshold_met_count: trace.summary.feedback_threshold_met_count,
      prompt_char_count: trace.context_decision.prompt_char_count,
    },
    risks: {
      negative_transfer_risk: trace.summary.negative_transfer_risk,
      unresolved_inspection_count: trace.summary.inspect_before_use_count,
      blocked_or_suppressed_count: blockedOrSuppressedCount,
      reasons: compactStrings([
        ...trace.memory_decisions
          .filter((entry) => entry.agent_surface !== "use_now")
          .flatMap((entry) => entry.reason_codes),
        ...trace.relation_decisions.map((entry) => entry.reason),
      ]).slice(0, 12),
    },
    feedback_signal_review: feedbackSignalReview,
    judgment_calibration_review: trace.judgment_calibration_summary,
    neighborhood_drift_review: trace.neighborhood_drift_observation,
    confidence_decay_candidate_review: trace.confidence_decay_candidate_summary,
    inspect_before_use_shadow_delta_review: trace.inspect_before_use_shadow_delta,
    decision_reviews: decisionReviews,
    source_map: {
      routes_used: args.source_map?.routes_used ?? trace.source_map.routes_used,
      internal_surfaces_used: args.source_map?.internal_surfaces_used ?? compactStrings([
        ...trace.source_map.internal_surfaces_used,
        feedbackSignalReview.present ? "sparse_feedback_signal_summary" : null,
        trace.neighborhood_drift_observation.present ? "neighborhood_drift_observation" : null,
        trace.confidence_decay_candidate_summary.present ? "confidence_decay_candidate_summary" : null,
        trace.inspect_before_use_shadow_delta.present ? "inspect_before_use_shadow_delta" : null,
        trace.judgment_calibration_summary.window.record_count > 0 ? "judgment_calibration_summary" : null,
        "memory_decision_audit_report",
      ]),
      omitted_internal_surfaces: args.source_map?.omitted_internal_surfaces ?? [
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
      ],
    },
  });
}

export const AIONIS_ADMISSION_SHADOW_POLICY_ID = AIONIS_ADMISSION_CANDIDATE_POLICY_ID;

export const AIONIS_ADMISSION_SHADOW_POLICY_VERSION = AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION;

const SHADOW_POLICY = resolveAdmissionCandidatePolicy(
  AIONIS_ADMISSION_SHADOW_POLICY_ID,
  AIONIS_ADMISSION_SHADOW_POLICY_VERSION,
);

const SHADOW_USED_FIELDS = [...SHADOW_POLICY.config.used_fields];

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

function shadowNonNegativeIntegerValue(value: number | null | undefined): number {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : 0;
}

function frozenPriorStateForEntry(entry: AionisMemoryAdmissionShadowPolicyEntryInput): FrozenPriorState {
  return {
    prior_supported_use_count: shadowNonNegativeIntegerValue(entry.prior_supported_use_count),
    prior_contradicted_use_count: shadowNonNegativeIntegerValue(entry.prior_contradicted_use_count),
    prior_rehydrate_requested_count: shadowNonNegativeIntegerValue(entry.prior_rehydrate_requested_count),
    prior_effect_state: closedLoopEffectStateValue(entry),
    repeated_negative_posture: entry.repeated_negative_posture === true,
  };
}

function candidateDecisionForEntry(entry: AionisMemoryAdmissionShadowPolicyEntryInput) {
  return decideAdmissionCandidatePolicyAction({
    recorded_action: entry.recorded_action,
    memory_origin: entry.memory_origin,
    source_backend: entry.source_backend,
    memory_type: entry.memory_type,
    closed_loop_effect_state: entry.closed_loop_effect_state,
    repeated_negative_posture: entry.repeated_negative_posture,
  }, SHADOW_POLICY);
}

function priorStateAvailable(entry: AionisMemoryAdmissionShadowPolicyEntryInput): boolean {
  return classifyLearningTrack(frozenPriorStateForEntry(entry)).track === "exploit";
}

export function buildAionisMemoryAdmissionShadowPolicyReport(
  input: AionisMemoryAdmissionShadowPolicyReportInput,
): AionisMemoryAdmissionShadowPolicyReport {
  const decisions = input.entries.slice(0, 96).map((entry) => {
    const candidateDecision = candidateDecisionForEntry(entry);
    const shadowAction = candidateDecision.action as AionisMemoryDecisionSurface;
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
      reason_codes: candidateDecision.reason_codes,
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
