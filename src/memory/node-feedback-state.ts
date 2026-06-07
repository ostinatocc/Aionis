import { resolveNodePriorityProfile } from "./importance-dynamics.js";

export type NodeFeedbackOutcome = "positive" | "negative" | "neutral";
export type NodeFeedbackSource = "rule_feedback" | "tools_feedback" | "nodes_activate";
export type NodeFeedbackUsedSurface = "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
export type NodeFeedbackVerifierStatus = "passed" | "failed" | "not_run" | "unknown";
export type NodeFeedbackToolStatus = "succeeded" | "failed" | "not_run" | "unknown";
export type NodeFeedbackLearningControlPosture = "inspect_before_use";
export type NodeFeedbackLearningControlSource = "repeated_unused_without_positive_attribution";

export type FeedbackNodeSnapshot = {
  id: string;
  type: string;
  tier?: string | null;
  title?: string | null;
  text_summary?: string | null;
  slots?: Record<string, unknown> | null;
  salience?: number | null;
  importance?: number | null;
  confidence?: number | null;
};

type MergeNodeFeedbackSlotsArgs = {
  slots?: Record<string, unknown> | null;
  outcome: NodeFeedbackOutcome;
  run_id?: string | null;
  reason?: string | null;
  input_sha256: string;
  source: NodeFeedbackSource;
  timestamp: string;
  used_surface?: NodeFeedbackUsedSurface | null;
  verifier_status?: NodeFeedbackVerifierStatus | null;
  tool_status?: NodeFeedbackToolStatus | null;
  runtime_signal_refs?: string[] | null;
};

type ComputeFeedbackUpdatedNodeStateArgs = {
  node: FeedbackNodeSnapshot;
  feedback: MergeNodeFeedbackSlotsArgs;
};

export type MergeNodeFeedbackLearningControlSlotsArgs = {
  slots?: Record<string, unknown> | null;
  posture: NodeFeedbackLearningControlPosture;
  source: NodeFeedbackLearningControlSource;
  timestamp: string;
  run_id?: string | null;
  guide_trace_id?: string | null;
  reason?: string | null;
  input_sha256: string;
  exposure_count?: number | null;
  positive_attributed_use_count?: number | null;
};

function asNonNegativeInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v !== "string") return 0;
  if (!/^[0-9]+$/.test(v.trim())) return 0;
  return Math.max(0, Number(v));
}

function asFeedbackQuality(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(-1, Math.min(1, v));
  if (typeof v !== "string") return 0;
  const s = v.trim();
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return 0;
  return Math.max(-1, Math.min(1, Number(s)));
}

function normalizeReason(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringList(values: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, 32);
}

function isDirectAttributionSurface(surface: NodeFeedbackUsedSurface | null | undefined): boolean {
  return surface === "use_now" || surface === "explicit_host_assertion";
}

function hasAlignedFailureSignal(args: {
  verifier_status?: NodeFeedbackVerifierStatus | null;
  tool_status?: NodeFeedbackToolStatus | null;
  runtime_signal_refs?: string[] | null;
}): boolean {
  return args.verifier_status === "failed"
    || args.tool_status === "failed"
    || normalizeStringList(args.runtime_signal_refs).length > 0;
}

export function shouldActivateNodeOnFeedback(outcome: NodeFeedbackOutcome): boolean {
  return outcome === "positive";
}

export function mergeNodeFeedbackSlots(args: MergeNodeFeedbackSlotsArgs): Record<string, unknown> {
  const slots = { ...(args.slots ?? {}) };
  const prevPos = asNonNegativeInt(slots.feedback_positive);
  const prevNeg = asNonNegativeInt(slots.feedback_negative);
  const prevQuality = asFeedbackQuality(slots.feedback_quality);
  const posInc = args.outcome === "positive" ? 1 : 0;
  const negInc = args.outcome === "negative" ? 1 : 0;
  const qualitySignal = args.outcome === "positive" ? 1 : args.outcome === "negative" ? -1 : 0;
  const runtimeSignalRefs = normalizeStringList(args.runtime_signal_refs);
  const directlyAttributed = isDirectAttributionSurface(args.used_surface);
  const strongCounterSignal =
    args.outcome === "negative"
    && directlyAttributed
    && hasAlignedFailureSignal({
      verifier_status: args.verifier_status,
      tool_status: args.tool_status,
      runtime_signal_refs: runtimeSignalRefs,
    });
  const weakCounterSignal = args.outcome === "negative" && directlyAttributed && !strongCounterSignal;

  const nextPos = prevPos + posInc;
  const nextNeg = prevNeg + negInc;
  const nextQuality =
    args.outcome === "neutral"
      ? prevQuality
      : Math.max(-1, Math.min(1, 0.8 * prevQuality + 0.2 * qualitySignal));

  slots.feedback_positive = nextPos;
  slots.feedback_negative = nextNeg;
  slots.feedback_quality = Number(nextQuality.toFixed(4));
  slots.last_feedback_outcome = args.outcome;
  slots.last_feedback_at = args.timestamp;
  slots.last_feedback_run_id = args.run_id ?? null;
  slots.last_feedback_reason = normalizeReason(args.reason);
  slots.last_feedback_input_sha256 = args.input_sha256;
  slots.last_feedback_source = args.source;
  slots.last_feedback_used_surface = args.used_surface ?? null;
  slots.last_feedback_verifier_status = args.verifier_status ?? null;
  slots.last_feedback_tool_status = args.tool_status ?? null;
  slots.last_feedback_runtime_signal_refs = runtimeSignalRefs;
  slots.attributed_use_count = asNonNegativeInt(slots.attributed_use_count) + (directlyAttributed ? 1 : 0);
  slots.positive_attributed_use_count =
    asNonNegativeInt(slots.positive_attributed_use_count) + (args.outcome === "positive" && directlyAttributed ? 1 : 0);
  slots.weak_counter_signal_count =
    asNonNegativeInt(slots.weak_counter_signal_count) + (weakCounterSignal ? 1 : 0);
  slots.strong_counter_signal_count =
    asNonNegativeInt(slots.strong_counter_signal_count) + (strongCounterSignal ? 1 : 0);
  slots.last_feedback_attribution_strength = strongCounterSignal
    ? "strong_counter_signal"
    : weakCounterSignal
      ? "weak_counter_signal"
      : args.outcome === "positive" && directlyAttributed
        ? "positive_attribution"
        : "observed_feedback";
  if (args.outcome === "positive" && directlyAttributed) {
    delete slots.feedback_learning_control_posture;
    delete slots.feedback_learning_control_source;
    delete slots.feedback_learning_control_reason;
    slots.feedback_learning_control_cleared_at = args.timestamp;
    slots.feedback_learning_control_cleared_reason = "positive_attribution";
    slots.feedback_learning_control_cleared_run_id = args.run_id ?? null;
  }
  return slots;
}

export function mergeNodeFeedbackLearningControlSlots(args: MergeNodeFeedbackLearningControlSlotsArgs): Record<string, unknown> {
  const slots = { ...(args.slots ?? {}) };
  const exposureCount = asNonNegativeInt(args.exposure_count);
  const positiveAttributedUseCount = asNonNegativeInt(args.positive_attributed_use_count);
  slots.feedback_learning_control_posture = args.posture;
  slots.feedback_learning_control_source = args.source;
  slots.feedback_learning_control_at = args.timestamp;
  slots.feedback_learning_control_run_id = args.run_id ?? null;
  slots.feedback_learning_control_guide_trace_id = args.guide_trace_id ?? null;
  slots.feedback_learning_control_reason = normalizeReason(args.reason);
  slots.feedback_learning_control_input_sha256 = args.input_sha256;
  slots.feedback_learning_control_evidence_count = Math.max(
    asNonNegativeInt(slots.feedback_learning_control_evidence_count),
    exposureCount,
  );
  slots.repeated_unused_without_positive_observation_count =
    Math.max(asNonNegativeInt(slots.repeated_unused_without_positive_observation_count), exposureCount);
  slots.last_repeated_unused_without_positive_at = args.timestamp;
  slots.last_repeated_unused_without_positive_guide_trace_id = args.guide_trace_id ?? null;
  slots.last_repeated_unused_without_positive_run_id = args.run_id ?? null;
  slots.last_repeated_unused_without_positive_count = exposureCount;
  slots.last_repeated_unused_without_positive_positive_attributed_use_count = positiveAttributedUseCount;
  return slots;
}

export function computeFeedbackUpdatedNodeState(args: ComputeFeedbackUpdatedNodeStateArgs) {
  const slots = mergeNodeFeedbackSlots({
    ...args.feedback,
    slots: args.node.slots ?? {},
  });
  const profile = resolveNodePriorityProfile({
    type: args.node.type,
    tier: args.node.tier ?? null,
    title: args.node.title ?? null,
    text_summary: args.node.text_summary ?? null,
    slots,
    salience: args.node.salience ?? null,
    importance: args.node.importance ?? null,
    confidence: args.node.confidence ?? null,
    reference_time: args.feedback.timestamp,
  });
  return {
    slots,
    salience: profile.salience,
    importance: profile.importance,
    confidence: profile.confidence,
  };
}
