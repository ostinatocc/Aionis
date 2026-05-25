import { resolveNodePriorityProfile } from "./importance-dynamics.js";

export type NodeFeedbackOutcome = "positive" | "negative" | "neutral";
export type NodeFeedbackSource = "rule_feedback" | "tools_feedback" | "nodes_activate";

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
};

type ComputeFeedbackUpdatedNodeStateArgs = {
  node: FeedbackNodeSnapshot;
  feedback: MergeNodeFeedbackSlotsArgs;
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
  });
  return {
    slots,
    salience: profile.salience,
    importance: profile.importance,
    confidence: profile.confidence,
  };
}
