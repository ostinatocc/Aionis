import { nextColderTier, normalizeMemoryTier, type MemoryTierName } from "../memory/evolution-operators.js";
import { resolveNodePriorityProfile } from "../memory/importance-dynamics.js";
import {
  resolveNodeAnchorPayloadRefs,
  resolveNodeCredibilityState,
  resolveNodeExecutionContractTrust,
  resolveNodePolicyMemoryState,
  resolveNodeSummaryKind,
} from "../memory/node-execution-surface.js";

export type SemanticForgettingAction = "retain" | "demote" | "archive" | "review";
export type SemanticForgettingLifecycleState = "active" | "contested" | "retired" | "archived";

export type SemanticForgettingDecision = {
  action: SemanticForgettingAction;
  current_tier: MemoryTierName;
  target_tier: MemoryTierName;
  lifecycle_state: SemanticForgettingLifecycleState;
  retention_score: number;
  salience: number;
  importance: number;
  confidence: number;
  should_compact: boolean;
  should_relocate: boolean;
  rationale: string[];
};

export type ResolveSemanticForgettingDecisionArgs = {
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

export type ArchiveRelocationState = "none" | "candidate" | "cold_archive";
export type ArchiveRelocationTarget = "none" | "local_cold_store" | "external_object_store";

export type ArchiveRelocationPlan = {
  relocation_state: ArchiveRelocationState;
  relocation_target: ArchiveRelocationTarget;
  payload_scope: "none" | "anchor_payload" | "node";
  should_relocate: boolean;
  rationale: string[];
};

export type DifferentialCandidate = {
  id: string;
  title?: string | null;
  summary?: string | null;
  selected_tool?: string | null;
  run_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type DifferentialPlanArgs = {
  nodes: DifferentialCandidate[];
  decisions: DifferentialCandidate[];
  reason?: string | null;
  adjudication?: Record<string, unknown> | null;
};

export type DifferentialRehydrationPlan = {
  node_ids: string[];
  decision_ids: string[];
  rationale: string[];
};

export type ForgettingKernel = {
  scoreImportance(input: ResolveSemanticForgettingDecisionArgs): ReturnType<typeof resolveNodePriorityProfile>;
  planForgetting(input: ResolveSemanticForgettingDecisionArgs): SemanticForgettingDecision;
  planArchiveRelocation(input: {
    forgetting: SemanticForgettingDecision;
    slots?: Record<string, unknown> | null;
    raw_ref?: string | null;
    evidence_ref?: string | null;
  }): ArchiveRelocationPlan;
  planRehydration(input: DifferentialPlanArgs): DifferentialRehydrationPlan;
};

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

function deriveLifecycleState(slots: Record<string, unknown> | null, tier: MemoryTierName): SemanticForgettingLifecycleState {
  if (tier === "archive") return "archived";
  const policyState = resolveNodePolicyMemoryState(slots);
  if (policyState === "retired") return "retired";
  if (policyState === "contested") return "contested";
  const credibilityState = resolveNodeCredibilityState(slots);
  if (credibilityState === "contested") return "contested";
  const summaryKind = resolveNodeSummaryKind(slots);
  const contractTrust = resolveNodeExecutionContractTrust({ slots });
  if (summaryKind === "policy_memory" && contractTrust && contractTrust !== "authoritative") {
    return "contested";
  }
  const explicit = firstString(slots?.lifecycle_state);
  if (explicit === "archived") return "archived";
  return "active";
}

function deriveFeedbackQuality(slots: Record<string, unknown> | null): number {
  const direct = numeric(slots?.feedback_quality);
  if (direct != null) return Math.max(-1, Math.min(1, direct));
  return 0;
}

export function scoreForgettingImportance(args: ResolveSemanticForgettingDecisionArgs): ReturnType<typeof resolveNodePriorityProfile> {
  return resolveNodePriorityProfile({
    type: args.type,
    tier: normalizeMemoryTier(args.tier),
    title: args.title ?? null,
    text_summary: args.text_summary ?? null,
    slots: args.slots ?? null,
    salience: args.salience ?? null,
    importance: args.importance ?? null,
    confidence: args.confidence ?? null,
    reference_time: args.reference_time ?? null,
  });
}

export function resolveSemanticForgettingDecision(
  args: ResolveSemanticForgettingDecisionArgs,
): SemanticForgettingDecision {
  const currentTier = normalizeMemoryTier(args.tier);
  const profile = scoreForgettingImportance({
    ...args,
    tier: currentTier,
  });
  const slots = args.slots ?? null;
  const lifecycleState = deriveLifecycleState(slots, currentTier);
  const feedbackQuality = deriveFeedbackQuality(slots);
  const rationale: string[] = [];

  let action: SemanticForgettingAction = "retain";
  let targetTier: MemoryTierName = currentTier;

  if (lifecycleState === "retired") {
    action = currentTier === "archive" ? "retain" : "archive";
    targetTier = action === "archive" ? "archive" : currentTier;
    rationale.push("retired_policy_memory");
  } else if (profile.retention_score <= 0.3 || feedbackQuality <= -0.7) {
    action = currentTier === "archive" ? "retain" : "archive";
    targetTier = action === "archive" ? "archive" : currentTier;
    rationale.push("retention_below_archive_floor");
  } else if (lifecycleState === "contested" || profile.retention_score <= 0.45) {
    action = currentTier === "archive" ? "review" : "demote";
    targetTier = action === "demote" ? nextColderTier(currentTier) : currentTier;
    rationale.push(lifecycleState === "contested" ? "contested_lifecycle_state" : "retention_below_demote_floor");
  } else if (profile.retention_score <= 0.58 && currentTier === "hot") {
    action = "demote";
    targetTier = "warm";
    rationale.push("hot_tier_not_justified");
  } else {
    rationale.push("retention_supports_visibility");
  }

  if (currentTier === "archive" && action === "demote") {
    action = "review";
    targetTier = currentTier;
    rationale.push("archive_requires_explicit_rehydrate");
  }

  return {
    action,
    current_tier: currentTier,
    target_tier: targetTier,
    lifecycle_state: lifecycleState,
    retention_score: profile.retention_score,
    salience: profile.salience,
    importance: profile.importance,
    confidence: profile.confidence,
    should_compact: action === "demote" || action === "archive",
    should_relocate: action === "archive",
    rationale,
  };
}

function hasAnchorPayloadRefs(slots: Record<string, unknown> | null): boolean {
  const refs = resolveNodeAnchorPayloadRefs(slots);
  if (!refs) return false;
  return ["node_ids", "decision_ids", "run_ids", "step_ids", "commit_ids"].some((key) => Array.isArray(refs[key]) && (refs[key] as unknown[]).length > 0);
}

export function resolveArchiveRelocationPlan(args: {
  forgetting: SemanticForgettingDecision;
  slots?: Record<string, unknown> | null;
  raw_ref?: string | null;
  evidence_ref?: string | null;
}): ArchiveRelocationPlan {
  const hasPayload = hasAnchorPayloadRefs(args.slots ?? null) || !!args.raw_ref || !!args.evidence_ref;
  if (args.forgetting.action !== "archive") {
    return {
      relocation_state: args.forgetting.action === "demote" ? "candidate" : "none",
      relocation_target: "none",
      payload_scope: hasPayload ? "anchor_payload" : "none",
      should_relocate: false,
      rationale: args.forgetting.action === "demote" ? ["watch_for_archive_transition"] : ["retained_in_current_store"],
    };
  }

  return {
    relocation_state: "cold_archive",
    relocation_target: hasPayload ? "local_cold_store" : "none",
    payload_scope: hasPayload ? "anchor_payload" : "node",
    should_relocate: hasPayload,
    rationale: [
      "archive_transition_requested",
      ...(hasPayload ? ["payload_externalization_candidate"] : ["summary_only_node"]),
    ],
  };
}

function stringList(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = typeof item === "string" ? item.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function tokenize(input: string | null | undefined): string[] {
  return String(input ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_:/.-]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function collectSignalTokens(args: DifferentialPlanArgs): string[] {
  const adjudication = args.adjudication ?? {};
  return Array.from(new Set([
    ...tokenize(args.reason),
    ...stringList(adjudication.keep_details, 24).flatMap((value) => tokenize(value)),
    ...tokenize(firstString(adjudication.expected_task_signature)),
    ...tokenize(firstString(adjudication.expected_error_signature)),
  ]));
}

function scoreCandidate(
  candidate: DifferentialCandidate,
  tokens: string[],
  preferredIds: Set<string>,
  deniedTokens: Set<string>,
): number {
  let score = preferredIds.has(candidate.id) ? 100 : 0;
  const haystack = [
    candidate.title,
    candidate.summary,
    candidate.selected_tool,
    candidate.run_id,
    ...Object.values(candidate.metadata ?? {}).map((value) => String(value)),
  ]
    .join(" ")
    .toLowerCase();
  for (const token of tokens) {
    if (haystack.includes(token)) score += 12;
  }
  for (const token of deniedTokens) {
    if (haystack.includes(token)) score -= 16;
  }
  return score;
}

function pickIds(
  candidates: DifferentialCandidate[],
  tokens: string[],
  preferredIds: Set<string>,
  deniedTokens: Set<string>,
  selectionLimit: number,
): string[] {
  if (preferredIds.size > 0) {
    return candidates
      .filter((candidate) => preferredIds.has(candidate.id))
      .map((candidate) => candidate.id)
      .slice(0, selectionLimit);
  }
  const ranked = candidates
    .map((candidate) => ({
      id: candidate.id,
      score: scoreCandidate(candidate, tokens, preferredIds, deniedTokens),
    }))
    .sort((left, right) => right.score - left.score);
  const selected = ranked.filter((entry) => entry.score > 0).map((entry) => entry.id);
  if (selected.length > 0) return selected.slice(0, selectionLimit);
  return ranked.slice(0, selectionLimit).map((entry) => entry.id);
}

export function buildDifferentialRehydrationPlan(args: DifferentialPlanArgs): DifferentialRehydrationPlan {
  const adjudication = args.adjudication ?? {};
  const preferredNodeIds = new Set(stringList(adjudication.related_memory_ids, 32));
  const preferredDecisionIds = new Set(stringList(adjudication.related_decision_ids, 32));
  const deniedTokens = new Set(stringList(adjudication.drop_details, 24).flatMap((value) => tokenize(value)));
  const tokens = collectSignalTokens(args);
  const nodeIds = pickIds(args.nodes, tokens, preferredNodeIds, deniedTokens, 2);
  const decisionIds = pickIds(args.decisions, tokens, preferredDecisionIds, deniedTokens, 1);
  const rationale = [
    preferredNodeIds.size > 0 || preferredDecisionIds.size > 0 ? "explicit_related_ids" : null,
    tokens.length > 0 ? "reason_and_keep_details_match" : null,
    deniedTokens.size > 0 ? "drop_details_penalty" : null,
    nodeIds.length === 0 && decisionIds.length === 0 ? "select_first_payload" : null,
  ].filter((value): value is string => !!value);

  return {
    node_ids: nodeIds,
    decision_ids: decisionIds,
    rationale: rationale.length > 0 ? rationale : ["ranked_payload_selected"],
  };
}

export const forgettingKernel: ForgettingKernel = {
  scoreImportance: scoreForgettingImportance,
  planForgetting: resolveSemanticForgettingDecision,
  planArchiveRelocation: resolveArchiveRelocationPlan,
  planRehydration: buildDifferentialRehydrationPlan,
};
