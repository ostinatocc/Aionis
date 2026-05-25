import {
  resolveNodeAnchorMetricsSurface,
  resolveNodeCompressionLayer,
  resolveNodeCredibilityState,
  resolveNodeExecutionContractTrust,
  resolveNodePatternExecutionSurface,
  resolveNodeSummaryKind,
  resolveNodeAnchorKind,
  resolveNodePolicyMemoryState,
  resolveNodeWorkflowPromotionSurface,
} from "./node-execution-surface.js";

type NodePriorityValue = {
  salience: number;
  importance: number;
  confidence: number;
};

export type ResolvedNodePriorityProfile = NodePriorityValue & {
  retention_score: number;
};

type ResolveNodePriorityProfileArgs = {
  type: string;
  tier?: string | null;
  title?: string | null;
  text_summary?: string | null;
  slots?: Record<string, unknown> | null;
  salience?: number | null;
  importance?: number | null;
  confidence?: number | null;
  reference_time?: string | number | Date | null;
};

type RetentionScoreArgs = {
  salience: number;
  importance: number;
  confidence: number;
  feedback_quality?: number | null;
  last_activated_at?: string | number | Date | null;
  reference_time?: string | number | Date | null;
};

export const RETENTION_SALIENCE_WEIGHT = 0.35;
export const RETENTION_IMPORTANCE_WEIGHT = 0.55;
export const RETENTION_CONFIDENCE_WEIGHT = 0.1;
export const RETENTION_FEEDBACK_STRENGTH = 0.06;
export const RETENTION_RECENT_BONUS = 0.03;
export const RETENTION_STALE_PENALTY = 0.04;
export const SALIENCE_IMPORTANCE_PROTECTION = 0.35;
export const IMPORTANCE_BLEND_KEEP = 0.9;
export const IMPORTANCE_RECENT_BONUS = 0.02;
export const IMPORTANCE_STALE_PENALTY = 0.015;
export const IMPORTANCE_FEEDBACK_STRENGTH = 0.06;

const BASE_TYPE_PROFILE: Record<string, NodePriorityValue> = {
  event: { salience: 0.44, importance: 0.46, confidence: 0.52 },
  evidence: { salience: 0.48, importance: 0.52, confidence: 0.58 },
  entity: { salience: 0.48, importance: 0.5, confidence: 0.56 },
  topic: { salience: 0.5, importance: 0.56, confidence: 0.58 },
  concept: { salience: 0.54, importance: 0.6, confidence: 0.6 },
  procedure: { salience: 0.58, importance: 0.66, confidence: 0.68 },
  rule: { salience: 0.62, importance: 0.74, confidence: 0.78 },
  self_model: { salience: 0.68, importance: 0.8, confidence: 0.84 },
};

const LAYER_BONUS: Record<string, NodePriorityValue> = {
  L0: { salience: 0, importance: 0, confidence: 0 },
  L1: { salience: 0.02, importance: 0.03, confidence: 0.02 },
  L2: { salience: 0.06, importance: 0.08, confidence: 0.04 },
  L3: { salience: 0.08, importance: 0.1, confidence: 0.06 },
  L4: { salience: 0.1, importance: 0.12, confidence: 0.08 },
  L5: { salience: 0.12, importance: 0.14, confidence: 0.1 },
};

const SUMMARY_KIND_BONUS: Record<string, NodePriorityValue> = {
  workflow_candidate: { salience: 0.12, importance: 0.16, confidence: 0.08 },
  workflow_anchor: { salience: 0.08, importance: 0.08, confidence: 0.08 },
  pattern_anchor: { salience: 0.02, importance: 0.04, confidence: 0.02 },
  policy_memory: { salience: 0.06, importance: 0.12, confidence: 0.08 },
  write_distillation_evidence: { salience: 0.01, importance: 0.02, confidence: 0.05 },
  write_distillation_fact: { salience: 0.02, importance: 0.04, confidence: 0.06 },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function addProfile(base: NodePriorityValue, delta: Partial<NodePriorityValue> | null | undefined): NodePriorityValue {
  if (!delta) return base;
  return {
    salience: base.salience + (delta.salience ?? 0),
    importance: base.importance + (delta.importance ?? 0),
    confidence: base.confidence + (delta.confidence ?? 0),
  };
}

function normalizeTime(value: string | number | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function recencyAdjustment(args: {
  lastActivatedAt: string | number | Date | null;
  referenceTime: string | number | Date | null;
}): Partial<NodePriorityValue> | null {
  const lastActivatedMs = normalizeTime(args.lastActivatedAt);
  if (lastActivatedMs == null) return null;
  const referenceMs = normalizeTime(args.referenceTime) ?? Date.now();
  const ageDays = (referenceMs - lastActivatedMs) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays)) return null;
  if (ageDays <= 3) {
    return { salience: 0.01, importance: 0.02, confidence: 0.01 };
  }
  if (ageDays <= 14) {
    return { salience: 0.005, importance: 0.01, confidence: 0.005 };
  }
  if (ageDays >= 45) {
    return { salience: -0.03, importance: -0.02, confidence: -0.01 };
  }
  return null;
}

function extractFeedbackQuality(slots: Record<string, unknown> | null): number {
  if (!slots) return 0;
  const direct = numeric(slots.feedback_quality);
  if (direct != null) return Math.max(-1, Math.min(1, direct));
  const positive = Math.max(0, numeric(slots.feedback_positive) ?? 0);
  const negative = Math.max(0, numeric(slots.feedback_negative) ?? 0);
  if (positive <= 0 && negative <= 0) return 0;
  return Math.max(-1, Math.min(1, (positive - negative) / Math.max(1, positive + negative)));
}

function deriveAnchorMetrics(slots: Record<string, unknown> | null) {
  const metrics = resolveNodeAnchorMetricsSurface(slots);
  const patternPromotion = resolveNodePatternExecutionSurface({ slots }).promotion;
  const workflowPromotion = resolveNodeWorkflowPromotionSurface(slots);
  return {
    usage_count: Math.max(0, numeric(metrics?.usage_count) ?? 0),
    reuse_success_count: Math.max(0, numeric(metrics?.reuse_success_count) ?? 0),
    reuse_failure_count: Math.max(0, numeric(metrics?.reuse_failure_count) ?? 0),
    distinct_run_count: Math.max(
      0,
      numeric(metrics?.distinct_run_count)
      ?? numeric(workflowPromotion?.observed_count)
      ?? numeric(patternPromotion.distinct_run_count)
      ?? 0,
    ),
    last_used_at: firstString(metrics?.last_used_at, slots?.last_feedback_at, slots?.last_activated, slots?.last_activated_at),
  };
}

function deriveCredibilityState(slots: Record<string, unknown> | null): string | null {
  return resolveNodeCredibilityState(slots);
}

function deriveCompressionLayer(slots: Record<string, unknown> | null): string | null {
  return resolveNodeCompressionLayer({
    type: "concept",
    slots,
  });
}

function deriveSummaryKind(slots: Record<string, unknown> | null): string | null {
  return resolveNodeSummaryKind(slots);
}

function derivePriorityProfile(args: ResolveNodePriorityProfileArgs): NodePriorityValue {
  const slots = args.slots ?? null;
  const typeKey = firstString(args.type)?.toLowerCase() ?? "event";
  let profile = { ...(BASE_TYPE_PROFILE[typeKey] ?? { salience: 0.5, importance: 0.5, confidence: 0.5 }) };

  profile = addProfile(profile, LAYER_BONUS[deriveCompressionLayer(slots) ?? ""]);
  profile = addProfile(profile, SUMMARY_KIND_BONUS[deriveSummaryKind(slots) ?? ""]);

  const anchorKind = resolveNodeAnchorKind(slots);
  if (anchorKind === "workflow") {
    profile = addProfile(profile, { salience: 0.02, importance: 0.03, confidence: 0.03 });
  }

  const credibilityState = deriveCredibilityState(slots);
  if (anchorKind === "pattern" || deriveSummaryKind(slots) === "pattern_anchor") {
    if (credibilityState === "trusted") {
      profile = addProfile(profile, { salience: 0.18, importance: 0.16, confidence: 0.24 });
    } else if (credibilityState === "contested") {
      profile = addProfile(profile, { salience: 0.01, importance: -0.04, confidence: -0.13 });
    } else {
      profile = addProfile(profile, { salience: 0.04, importance: 0, confidence: -0.1 });
    }
  }

  const workflowPromotion = resolveNodeWorkflowPromotionSurface(slots);
  if (firstString(workflowPromotion?.promotion_state) === "stable") {
    profile = addProfile(profile, { salience: 0.04, importance: 0.05, confidence: 0.05 });
  }

  const summaryKind = deriveSummaryKind(slots);
  const contractTrust = resolveNodeExecutionContractTrust({ slots });
  const policyMemoryState = resolveNodePolicyMemoryState(slots);
  if (summaryKind === "policy_memory") {
    if (contractTrust === "authoritative") {
      profile = addProfile(profile, { salience: 0.03, importance: 0.06, confidence: 0.08 });
    } else if (contractTrust === "advisory") {
      profile = addProfile(profile, { salience: 0.01, importance: 0.01, confidence: -0.04 });
    } else if (contractTrust === "observational") {
      profile = addProfile(profile, { salience: -0.01, importance: -0.02, confidence: -0.08 });
    }
    if (policyMemoryState === "contested") {
      profile = addProfile(profile, { salience: -0.02, importance: -0.05, confidence: -0.08 });
    } else if (policyMemoryState === "retired") {
      profile = addProfile(profile, { salience: -0.04, importance: -0.08, confidence: -0.12 });
    }
  }

  const anchorMetrics = deriveAnchorMetrics(slots);
  const usageScore = clamp01(anchorMetrics.usage_count / 8);
  const successScore = clamp01(anchorMetrics.reuse_success_count / 4);
  const failureScore = clamp01(anchorMetrics.reuse_failure_count / 4);
  const distinctScore = clamp01(anchorMetrics.distinct_run_count / 3);
  profile = addProfile(profile, {
    salience: (usageScore * 0.02) + (successScore * 0.03) + (distinctScore * 0.02) - (failureScore * 0.04),
    importance: (usageScore * 0.03) + (successScore * 0.05) + (distinctScore * 0.04) - (failureScore * 0.06),
    confidence: (usageScore * 0.02) + (successScore * 0.03) + (distinctScore * 0.03) - (failureScore * 0.08),
  });

  profile = addProfile(profile, {
    salience: extractFeedbackQuality(slots) * 0.04,
    importance: extractFeedbackQuality(slots) * 0.06,
    confidence: extractFeedbackQuality(slots) * 0.06,
  });

  profile = addProfile(profile, recencyAdjustment({
    lastActivatedAt: anchorMetrics.last_used_at,
    referenceTime: args.reference_time ?? null,
  }));

  if (!firstString(args.title, args.text_summary)) {
    profile = addProfile(profile, { salience: -0.02, importance: -0.01, confidence: -0.04 });
  }

  if (args.tier === "archive") {
    profile = addProfile(profile, { salience: -0.08, importance: -0.02, confidence: -0.01 });
  } else if (args.tier === "cold") {
    profile = addProfile(profile, { salience: -0.04, importance: -0.01, confidence: 0 });
  }

  profile.salience = Math.max(
    clamp01(profile.salience),
    Math.min(SALIENCE_IMPORTANCE_PROTECTION, clamp01(profile.importance) * 0.5),
  );
  profile.importance = Math.max(
    clamp01(profile.importance),
    Math.min(SALIENCE_IMPORTANCE_PROTECTION, clamp01(profile.salience) * 0.5),
  );
  profile.confidence = clamp01(profile.confidence);

  return {
    salience: clamp01(profile.salience),
    importance: clamp01(profile.importance),
    confidence: clamp01(profile.confidence),
  };
}

export function computeRetentionScore(args: RetentionScoreArgs): number {
  const feedbackQuality = Math.max(-1, Math.min(1, args.feedback_quality ?? 0));
  const base =
    (clamp01(args.salience) * RETENTION_SALIENCE_WEIGHT)
    + (clamp01(args.importance) * RETENTION_IMPORTANCE_WEIGHT)
    + (clamp01(args.confidence) * RETENTION_CONFIDENCE_WEIGHT);

  const lastActivatedMs = normalizeTime(args.last_activated_at);
  const referenceMs = normalizeTime(args.reference_time) ?? Date.now();
  let recency = 0;
  if (lastActivatedMs != null) {
    const ageDays = (referenceMs - lastActivatedMs) / (24 * 60 * 60 * 1000);
    if (Number.isFinite(ageDays)) {
      if (ageDays <= 3) recency = RETENTION_RECENT_BONUS;
      else if (ageDays >= 45) recency = -RETENTION_STALE_PENALTY;
    }
  }
  return clamp01(base + recency + (feedbackQuality * RETENTION_FEEDBACK_STRENGTH));
}

export function computeAdaptiveImportanceTarget(args: {
  current_importance: number;
  feedback_quality?: number | null;
  is_recent?: boolean;
}): number {
  const current = clamp01(args.current_importance);
  const recentDelta = args.is_recent ? IMPORTANCE_RECENT_BONUS : -IMPORTANCE_STALE_PENALTY;
  const feedbackDelta = Math.max(-1, Math.min(1, args.feedback_quality ?? 0)) * IMPORTANCE_FEEDBACK_STRENGTH;
  return clamp01(current + recentDelta + feedbackDelta);
}

export function resolveNodePriorityProfile(args: ResolveNodePriorityProfileArgs): ResolvedNodePriorityProfile {
  const derived = derivePriorityProfile(args);
  const salience = args.salience == null ? derived.salience : clamp01(args.salience);
  const importance = args.importance == null ? derived.importance : clamp01(args.importance);
  const confidence = args.confidence == null ? derived.confidence : clamp01(args.confidence);
  const slots = args.slots ?? null;
  const metrics = deriveAnchorMetrics(slots);
  return {
    salience,
    importance,
    confidence,
    retention_score: computeRetentionScore({
      salience,
      importance,
      confidence,
      feedback_quality: extractFeedbackQuality(slots),
      last_activated_at: metrics.last_used_at,
      reference_time: args.reference_time ?? null,
    }),
  };
}
