import stableStringify from "fast-json-stable-stringify";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import { sha256Hex } from "../util/crypto.js";
import {
  buildPatternMaintenanceMetadata,
  buildPatternPromotionMetadata,
  type PatternCredibilityState,
  type PatternTransitionKind,
} from "./evolution-operators.js";
import { buildExecutionContractFromProjection } from "./execution-contract.js";
import { resolveNodePriorityProfile } from "./importance-dynamics.js";
import { ExecutionNativeV1Schema, MemoryAnchorV1Schema, type MemoryAnchorV1 } from "./schemas.js";
import {
  completeLiteInlineEmbeddings,
  persistLitePreparedWrite,
  type LiteProjectedWriteStore,
} from "./lite-projected-write-commit.js";
import { applyPreparedMemoryWrite, prepareMemoryWrite, type PreparedWrite } from "./write.js";
import { buildPromotionEvidenceLedgerV1 } from "./promotion-evidence-ledger.js";
import {
  buildTaskSignature,
  extractErrorFamily,
  extractErrorSignature,
  extractTaskCue,
  extractTaskFamily,
} from "./pattern-trust-shaping.js";
import type { ContractTrust } from "./contract-trust.js";

const STABLE_PATTERN_MIN_DISTINCT_RUNS = 3;
const CONTESTED_REVALIDATION_MIN_FRESH_RUNS = 2;
const MAX_OBSERVED_RUN_IDS = 16;

type DecisionAnchorSource = {
  id: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: unknown[];
  context_sha256: string;
  policy_sha256: string;
  created_at: string;
  commit_id: string | null;
};

export type WriteToolsDecisionPatternAnchorArgs = {
  tenant_id: string;
  scope: string;
  actor: string;
  input_text?: string | null;
  input_sha256: string;
  note?: string | null;
  context: unknown;
  selected_tool: string;
  candidates: string[];
  source_rule_ids: string[];
  decision: DecisionAnchorSource;
  feedback_commit_id: string;
  feedback_outcome: "positive" | "negative";
  learning_control_pattern_state_override?: "stable" | null;
};

export type WriteToolsDecisionPatternAnchorOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges?: boolean;
  embedder: EmbeddingProvider | null;
  writeAccess?: WriteStoreAccess | null;
  liteWriteStore?: LiteWriteStore | null;
};

export type PatternAnchorWriteResult = {
  node_id: string;
  client_id: string;
  pattern_signature: string;
  anchor: MemoryAnchorV1;
};

type ExistingPatternAnchorNode = {
  id: string;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
  salience: number;
  importance: number;
  confidence: number;
};

export type PreparedToolsDecisionPatternAnchor = {
  scope: string;
  feedback_commit_id: string;
  expected_existing_sha256: string | null;
  update: {
    id: string;
    slots: Record<string, unknown>;
    text_summary: string;
    salience: number;
    importance: number;
    confidence: number;
  } | null;
  prepared_write: PreparedWrite | null;
  result: PatternAnchorWriteResult;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function words(value: string, limit = 6): string[] {
  return value
    .split(/[\s,.;:()[\]{}"']+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function buildPatternSignature(args: {
  selected_tool: string;
  candidates: string[];
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids: string[];
}): string {
  return sha256Hex(
    stableStringify({
      schema: "tools_pattern_v1",
      selected_tool: args.selected_tool,
      candidates: args.candidates,
      context_sha256: args.context_sha256,
      policy_sha256: args.policy_sha256,
      source_rule_ids: args.source_rule_ids,
    }),
  );
}

function buildPatternSummary(args: {
  taskCue: string | null;
  selectedTool: string;
  patternState: "provisional" | "stable";
  credibilityState: PatternCredibilityState;
  feedbackOutcome: "positive" | "negative";
  ruleBacked: boolean;
}): string {
  const prefix =
    args.credibilityState === "trusted"
      ? "Stable pattern"
      : args.credibilityState === "contested"
        ? "Contested pattern"
        : "Candidate pattern";
  const body = args.taskCue
    ? `for ${args.taskCue}, prefer ${args.selectedTool}`
    : `prefer ${args.selectedTool}`;
  const evidence =
    args.credibilityState === "contested"
      ? "counter-evidence observed; requires fresh successful validation before trusted reuse."
      : args.patternState === "stable"
        ? args.ruleBacked
          ? "after repeated successful rule-backed tool selections."
          : "after repeated successful tool selections."
        : args.ruleBacked
          ? "after one successful rule-backed tool selection."
          : "after one successful tool selection.";
  return truncate(`${prefix}: ${body} ${evidence}`, 400);
}

function parseExistingAnchor(node: ExistingPatternAnchorNode): MemoryAnchorV1 {
  const parsed = MemoryAnchorV1Schema.safeParse(node.slots?.anchor_v1);
  if (!parsed.success) {
    throw new Error(`invalid_existing_pattern_anchor:${node.id}`);
  }
  return parsed.data;
}

function observedRunIdsFromAnchor(anchor: MemoryAnchorV1): string[] {
  const promotion = asRecord(anchor.promotion);
  const observed = Array.isArray(promotion?.observed_run_ids)
    ? (promotion.observed_run_ids as Array<string | null | undefined>)
    : [];
  return uniqueStrings(observed, MAX_OBSERVED_RUN_IDS);
}

function trustHardeningRecord(anchor: MemoryAnchorV1 | null | undefined): Record<string, unknown> | null {
  return asRecord(anchor?.trust_hardening);
}

function observedFamiliesFromHardening(record: Record<string, unknown> | null, key: "observed_task_families" | "observed_error_families"): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? uniqueStrings((value as Array<string | null | undefined>).filter((entry): entry is string => typeof entry === "string"), 16)
    : [];
}

function observedPostContestRunIds(record: Record<string, unknown> | null): string[] {
  const value = record?.post_contest_observed_run_ids;
  return Array.isArray(value)
    ? uniqueStrings((value as Array<string | null | undefined>).filter((entry): entry is string => typeof entry === "string"), MAX_OBSERVED_RUN_IDS)
    : [];
}

function derivePatternAnchorContractTrust(anchor: Pick<MemoryAnchorV1, "pattern_state" | "credibility_state">): ContractTrust {
  if ((anchor.pattern_state ?? "provisional") === "stable" && (anchor.credibility_state ?? "candidate") === "trusted") {
    return "advisory";
  }
  return "observational";
}

function buildPatternExecutionContract(args: {
  anchor: MemoryAnchorV1;
  taskCue: string | null;
  sourceRuleIds: string[];
  feedbackOutcome: "positive" | "negative";
}) {
  const contractTrust = derivePatternAnchorContractTrust(args.anchor);
  const nextAction = args.anchor.selected_tool
    ? args.taskCue
      ? `Prefer ${args.anchor.selected_tool} first for ${args.taskCue} before widening tool search.`
      : `Prefer ${args.anchor.selected_tool} first before widening tool search.`
    : null;
  const patternHints = uniqueStrings([
    args.sourceRuleIds.length > 0 ? "rule_backed_selection_pattern" : "feedback_derived_selection_pattern",
    (args.anchor.pattern_state ?? "provisional") === "stable" ? "stable_tool_selection_pattern" : "provisional_tool_selection_pattern",
    (args.anchor.credibility_state ?? "candidate") === "contested" ? "counter_evidence_open" : null,
    args.feedbackOutcome === "negative" ? "negative_feedback_recorded" : "positive_feedback_recorded",
  ], 8);
  return buildExecutionContractFromProjection({
    contract_trust: contractTrust,
    task_family: args.anchor.task_family ?? null,
    task_signature: args.anchor.task_signature,
    selected_tool: args.anchor.selected_tool ?? null,
    next_action: nextAction,
    workflow_steps: args.anchor.key_steps ?? [],
    pattern_hints: patternHints,
    provenance: {
      source_kind: "pattern_anchor_write",
      source_anchor: args.anchor.pattern_signature ?? null,
      notes: ["tools_pattern_anchor_projection"],
    },
  });
}

function buildPatternAnchor(args: {
  taskCue: string | null;
  taskFamily: string | null;
  errorSignature: string | null;
  errorFamily: string | null;
  patternSignature: string;
  selectedTool: string;
  candidates: string[];
  sourceRuleIds: string[];
  decision: DecisionAnchorSource;
  feedbackCommitId: string;
  feedbackOutcome: "positive" | "negative";
  existing?: MemoryAnchorV1 | null;
  learningControlPatternStateOverride?: "stable" | null;
}): MemoryAnchorV1 {
  const existing = args.existing ?? null;
  const existingHardening = trustHardeningRecord(existing);
  const existingCredibilityState = (existing?.credibility_state ?? existing?.promotion?.credibility_state ?? "candidate") as PatternCredibilityState;
  const existingObservedRunIds = existing ? observedRunIdsFromAnchor(existing) : [];
  const nextObservedRunIds = args.feedbackOutcome === "positive"
    ? uniqueStrings([...existingObservedRunIds, args.decision.run_id], MAX_OBSERVED_RUN_IDS)
    : existingObservedRunIds;
  const distinctRunCount = nextObservedRunIds.length;
  const requiredDistinctRuns = Math.max(
    STABLE_PATTERN_MIN_DISTINCT_RUNS,
    Number(existing?.promotion?.required_distinct_runs ?? STABLE_PATTERN_MIN_DISTINCT_RUNS),
  );
  const hasNewDistinctRun = args.feedbackOutcome === "positive" && (
    args.decision.run_id
      ? !existingObservedRunIds.includes(args.decision.run_id)
      : !existing
  );
  const reuseSuccessCount = Math.max(
    existing?.metrics?.reuse_success_count ?? 0,
    0,
  ) + (hasNewDistinctRun ? 1 : 0);
  const existingCounterEvidenceCount = Math.max(Number(existing?.promotion?.counter_evidence_count ?? 0), 0);
  const nextCounterEvidenceCount = existingCounterEvidenceCount + (args.feedbackOutcome === "negative" ? 1 : 0);
  const existingObservedTaskFamilies = observedFamiliesFromHardening(existingHardening, "observed_task_families");
  const existingObservedErrorFamilies = observedFamiliesFromHardening(existingHardening, "observed_error_families");
  const observedTaskFamilies = uniqueStrings([...existingObservedTaskFamilies, args.taskFamily], 16);
  const observedErrorFamilies = uniqueStrings([...existingObservedErrorFamilies, args.errorFamily], 16);
  const existingPostContestObservedRunIds = observedPostContestRunIds(existingHardening);
  const postContestObservedRunIds = args.feedbackOutcome === "negative"
    ? []
    : existingCounterEvidenceCount > 0
      ? hasNewDistinctRun
        ? uniqueStrings([...existingPostContestObservedRunIds, args.decision.run_id], MAX_OBSERVED_RUN_IDS)
        : existingPostContestObservedRunIds
      : existingPostContestObservedRunIds;
  const revalidationFloorSatisfied =
    nextCounterEvidenceCount === 0 || postContestObservedRunIds.length >= CONTESTED_REVALIDATION_MIN_FRESH_RUNS;
  const counterEvidenceOpen = args.feedbackOutcome === "negative"
    ? true
    : distinctRunCount >= (requiredDistinctRuns + nextCounterEvidenceCount) && revalidationFloorSatisfied
      ? false
      : Boolean(existing?.promotion?.counter_evidence_open ?? false);
  const reuseFailureCount = Math.max(existing?.metrics?.reuse_failure_count ?? 0, 0) + (args.feedbackOutcome === "negative" ? 1 : 0);
  const patternState: "provisional" | "stable" =
    !counterEvidenceOpen && distinctRunCount >= (requiredDistinctRuns + nextCounterEvidenceCount)
      ? "stable"
      : "provisional";
  const credibilityState: PatternCredibilityState =
    counterEvidenceOpen
      ? "contested"
      : patternState === "stable"
        ? "trusted"
        : "candidate";
  const taskSignature = buildTaskSignature({
    taskCue: args.taskCue,
  });
  const summary = buildPatternSummary({
    taskCue: args.taskCue,
    selectedTool: args.selectedTool,
    patternState,
    credibilityState,
    feedbackOutcome: args.feedbackOutcome,
    ruleBacked: args.sourceRuleIds.length > 0,
  });
  const keywordTerms = uniqueStrings([
    args.selectedTool,
    args.taskCue,
    args.errorSignature,
    ...args.candidates,
    ...args.sourceRuleIds,
  ], 16);
  const maintenance = buildPatternMaintenanceMetadata({
    credibility_state: credibilityState,
    distinct_run_count: distinctRunCount,
    required_distinct_runs: requiredDistinctRuns,
    counter_evidence_open: counterEvidenceOpen,
    at: args.decision.created_at,
  });
  const promotionGateSatisfied = distinctRunCount >= requiredDistinctRuns;
  const promotionEvidenceLedger = buildPromotionEvidenceLedgerV1({
    targetKind: "pattern",
    targetId: existing ? args.patternSignature : null,
    sourceLayers: ["L2"],
    targetLayer: "L3",
    transition: "L2_to_L3",
    promotionState: credibilityState,
    promotionOrigin: "tools_feedback",
    observedCount: distinctRunCount,
    requiredCount: requiredDistinctRuns,
    authorityGateAdmitted: credibilityState === "trusted" ? true : null,
    learningControlAdmitted: args.learningControlPatternStateOverride === "stable" ? true : null,
    verifierStatus: args.feedbackOutcome === "negative" ? "failed" : "succeeded",
    contractTrust: derivePatternAnchorContractTrust({
      pattern_state: patternState,
      credibility_state: credibilityState,
    }),
    sourceNodeIds: args.sourceRuleIds,
    sourceRunIds: [args.decision.run_id],
    sourceCommitIds: [args.feedbackCommitId, args.decision.commit_id],
    promotionEvidenceRefs: [
      args.decision.id,
      args.feedbackCommitId,
      ...nextObservedRunIds.map((runId) => `run:${runId}`),
    ],
    counterEvidenceRefs: args.feedbackOutcome === "negative" ? [args.decision.id] : [],
    reasonCodes: [
      "tools_pattern_feedback",
      promotionGateSatisfied ? "pattern_distinct_run_gate_satisfied" : "pattern_distinct_run_gate_pending",
      counterEvidenceOpen ? "pattern_counter_evidence_open" : "pattern_counter_evidence_clear",
    ],
    evidence: [
      {
        evidence_id: `${args.patternSignature}:distinct_runs`,
        evidence_kind: "distinct_observation",
        polarity: promotionGateSatisfied ? "positive" : "neutral",
        source_ref: args.decision.id,
        claim: `observed ${distinctRunCount} of ${requiredDistinctRuns} required pattern runs`,
        confidence: promotionGateSatisfied ? 0.86 : 0.58,
      },
      {
        evidence_id: `${args.patternSignature}:feedback`,
        evidence_kind: args.feedbackOutcome === "negative" ? "counter_evidence" : "operator_feedback",
        polarity: args.feedbackOutcome === "negative" ? "negative" : "positive",
        source_ref: args.feedbackCommitId,
        claim: args.feedbackOutcome === "negative"
          ? "negative tool feedback opened counter-evidence"
          : "positive tool feedback supports pattern promotion",
        confidence: args.feedbackOutcome === "negative" ? 0.82 : 0.72,
      },
      ...(args.learningControlPatternStateOverride === "stable"
        ? [{
            evidence_id: `${args.patternSignature}:learning_control`,
            evidence_kind: "learning_control" as const,
            polarity: "positive" as const,
            source_ref: `${args.feedbackCommitId}:learning_control`,
            claim: "learning control admitted trusted pattern override",
            confidence: 0.86,
          }]
        : []),
    ],
  });
  const baseAnchor = MemoryAnchorV1Schema.parse({
    anchor_kind: "pattern",
    anchor_level: "L3",
    contract_trust: derivePatternAnchorContractTrust({
      pattern_state: patternState,
      credibility_state: credibilityState,
    }),
    pattern_state: patternState,
    credibility_state: credibilityState,
    task_signature: taskSignature,
    task_class: "tools_select_pattern",
    task_family: args.taskFamily ?? undefined,
    error_signature: args.errorSignature ?? undefined,
    error_family: args.errorFamily ?? undefined,
    pattern_signature: args.patternSignature,
    summary,
    tool_set: args.candidates,
    selected_tool: args.selectedTool,
    key_steps: [
      "evaluate active tool rules",
      `select ${args.selectedTool}`,
      args.feedbackOutcome === "negative" ? "record negative execution feedback" : "record positive execution feedback",
    ],
    outcome: {
      status: args.feedbackOutcome === "negative" ? "mixed" : "success",
      result_class: args.feedbackOutcome === "negative"
        ? "tool_selection_pattern_counter_evidence"
        : patternState === "stable"
          ? "tool_selection_pattern_stable"
          : "tool_selection_pattern_candidate",
      success_score: args.feedbackOutcome === "negative"
        ? 0.34
        : patternState === "stable"
          ? 0.92
          : 0.68,
    },
    source: {
      source_kind: "tool_decision",
      node_id: null,
      decision_id: args.decision.id,
      run_id: args.decision.run_id,
      step_id: null,
      playbook_id: null,
      commit_id: args.feedbackCommitId,
    },
    payload_refs: {
      node_ids: uniqueStrings([...(existing?.payload_refs.node_ids ?? []), ...args.sourceRuleIds], 256),
      decision_ids: uniqueStrings([...(existing?.payload_refs.decision_ids ?? []), args.decision.id], 256),
      run_ids: uniqueStrings([...(existing?.payload_refs.run_ids ?? []), args.decision.run_id], 256),
      step_ids: existing?.payload_refs.step_ids ?? [],
      commit_ids: uniqueStrings([...(existing?.payload_refs.commit_ids ?? []), args.feedbackCommitId, args.decision.commit_id], 256),
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: "medium",
      recommended_when: [
        "need_original_decision_context",
        "need_linked_rule_attribution",
        "pattern_summary_is_not_enough",
      ],
    },
    recall_features: {
      error_tags: args.errorSignature ? [args.errorSignature] : [],
      tool_tags: uniqueStrings([args.selectedTool, ...args.candidates], 16),
      outcome_tags: uniqueStrings([
        args.feedbackOutcome === "negative" ? "negative_feedback" : "positive_feedback",
        args.sourceRuleIds.length > 0 ? "rule_backed_selection" : "feedback_derived_selection",
        counterEvidenceOpen ? "counter_evidence_open" : "counter_evidence_clear",
        `credibility_${credibilityState}`,
        patternState === "stable" ? "stable_pattern" : "provisional_pattern",
      ], 8),
      keywords: keywordTerms,
    },
    metrics: {
      usage_count: existing?.metrics?.usage_count ?? 0,
      reuse_success_count: reuseSuccessCount,
      reuse_failure_count: reuseFailureCount,
      distinct_run_count: distinctRunCount,
      last_used_at: args.decision.created_at,
    },
    maintenance,
    promotion: buildPatternPromotionMetadata({
      required_distinct_runs: requiredDistinctRuns,
      distinct_run_count: distinctRunCount,
      observed_run_ids: nextObservedRunIds,
      counter_evidence_count: nextCounterEvidenceCount,
      counter_evidence_open: counterEvidenceOpen,
      credibility_state: credibilityState,
      previous_credibility_state: existing ? existingCredibilityState : null,
      at: args.decision.created_at,
      stable_at: patternState === "stable"
        ? existing?.pattern_state === "stable"
          ? existing?.promotion?.stable_at ?? args.decision.created_at
          : args.decision.created_at
        : null,
      last_validated_at: args.feedbackOutcome === "positive"
        ? args.decision.created_at
        : existing?.promotion?.last_validated_at ?? null,
      last_counter_evidence_at: args.feedbackOutcome === "negative"
        ? args.decision.created_at
        : existing?.promotion?.last_counter_evidence_at ?? null,
      default_transition: existingCredibilityState === "trusted"
        ? (existing?.promotion?.last_transition as PatternTransitionKind | null) ?? "promoted_to_trusted"
        : null,
    }),
    promotion_evidence_ledger_v1: promotionEvidenceLedger,
    trust_hardening: {
      task_family: args.taskFamily,
      error_family: args.errorFamily,
      observed_task_families: observedTaskFamilies,
      observed_error_families: observedErrorFamilies,
      distinct_task_family_count: observedTaskFamilies.length,
      distinct_error_family_count: observedErrorFamilies.length,
      post_contest_observed_run_ids: postContestObservedRunIds,
      post_contest_distinct_run_count: postContestObservedRunIds.length,
      promotion_gate_kind: "current_distinct_runs_v1",
      promotion_gate_satisfied: promotionGateSatisfied,
      revalidation_floor_kind: "post_contest_two_fresh_runs_v1",
      revalidation_floor_satisfied: revalidationFloorSatisfied,
      task_affinity_weighting_enabled: false,
      semantic_review_override_applied: false,
      semantic_review_override_reason: null,
    },
    schema_version: "anchor_v1",
  });

  if (args.learningControlPatternStateOverride !== "stable") {
    return baseAnchor;
  }
  if ((baseAnchor.pattern_state ?? "provisional") === "stable") {
    return baseAnchor;
  }

  return MemoryAnchorV1Schema.parse({
    ...baseAnchor,
    contract_trust: derivePatternAnchorContractTrust({
      pattern_state: "stable",
      credibility_state: "trusted",
    }),
    pattern_state: "stable",
    credibility_state: "trusted",
    summary: buildPatternSummary({
      taskCue: args.taskCue,
      selectedTool: args.selectedTool,
      patternState: "stable",
      credibilityState: "trusted",
      feedbackOutcome: args.feedbackOutcome,
      ruleBacked: args.sourceRuleIds.length > 0,
    }),
    maintenance: buildPatternMaintenanceMetadata({
      credibility_state: "trusted",
      distinct_run_count: distinctRunCount,
      required_distinct_runs: requiredDistinctRuns,
      counter_evidence_open: false,
      at: args.decision.created_at,
    }),
    promotion: {
      ...baseAnchor.promotion,
      ...buildPatternPromotionMetadata({
        required_distinct_runs: Number(baseAnchor.promotion?.required_distinct_runs ?? requiredDistinctRuns),
        distinct_run_count: Number(baseAnchor.promotion?.distinct_run_count ?? distinctRunCount),
        observed_run_ids: Array.isArray(baseAnchor.promotion?.observed_run_ids)
          ? baseAnchor.promotion.observed_run_ids.filter((value): value is string => typeof value === "string")
          : [],
        counter_evidence_count: Number(baseAnchor.promotion?.counter_evidence_count ?? nextCounterEvidenceCount),
        counter_evidence_open: false,
        credibility_state: "trusted",
        previous_credibility_state: (baseAnchor.credibility_state ?? baseAnchor.promotion?.credibility_state ?? "candidate") as PatternCredibilityState,
        at: args.decision.created_at,
        stable_at: baseAnchor.promotion?.stable_at ?? args.decision.created_at,
        last_validated_at: args.decision.created_at,
        last_counter_evidence_at: baseAnchor.promotion?.last_counter_evidence_at ?? null,
      }),
    },
    promotion_evidence_ledger_v1: buildPromotionEvidenceLedgerV1({
      targetKind: "pattern",
      targetId: args.patternSignature,
      sourceLayers: ["L2"],
      targetLayer: "L3",
      transition: "L2_to_L3",
      promotionState: "trusted",
      promotionOrigin: "learning_control",
      observedCount: distinctRunCount,
      requiredCount: requiredDistinctRuns,
      authorityGateAdmitted: true,
      learningControlAdmitted: true,
      verifierStatus: "succeeded",
      contractTrust: "advisory",
      sourceNodeIds: args.sourceRuleIds,
      sourceRunIds: [args.decision.run_id],
      sourceCommitIds: [args.feedbackCommitId, args.decision.commit_id],
      promotionEvidenceRefs: [args.decision.id, args.feedbackCommitId],
      reasonCodes: ["tools_pattern_feedback", "learning_control_trusted_pattern_override"],
      evidence: [
        {
          evidence_id: `${args.patternSignature}:learning_control`,
          evidence_kind: "learning_control",
          polarity: "positive",
          source_ref: `${args.feedbackCommitId}:learning_control`,
          claim: "learning control admitted trusted pattern override",
          confidence: 0.86,
        },
        {
          evidence_id: `${args.patternSignature}:feedback`,
          evidence_kind: "operator_feedback",
          polarity: "positive",
          source_ref: args.feedbackCommitId,
          claim: "positive tool feedback supports trusted pattern",
          confidence: 0.72,
        },
      ],
    }),
    trust_hardening: {
      ...baseAnchor.trust_hardening,
      semantic_review_override_applied: true,
      semantic_review_override_reason: "high_confidence_form_pattern_review",
    },
  });
}

function buildPatternAnchorSlots(args: {
  anchor: MemoryAnchorV1;
  taskCue: string | null;
  patternSignature: string;
  selectedTool: string;
  candidates: string[];
  sourceRuleIds: string[];
  feedbackOutcome: "positive" | "negative";
}): Record<string, unknown> {
  const executionContract = buildPatternExecutionContract({
    anchor: args.anchor,
    taskCue: args.taskCue,
    sourceRuleIds: args.sourceRuleIds,
    feedbackOutcome: args.feedbackOutcome,
  });
  const executionNative = ExecutionNativeV1Schema.parse({
    schema_version: "execution_native_v1",
    execution_kind: "pattern_anchor",
    summary_kind: "pattern_anchor",
    compression_layer: "L3",
    ...(args.anchor.contract_trust ? { contract_trust: args.anchor.contract_trust } : {}),
    task_signature: args.anchor.task_signature,
    ...(args.anchor.task_family ? { task_family: args.anchor.task_family } : {}),
    ...(args.anchor.error_signature ? { error_signature: args.anchor.error_signature } : {}),
    ...(args.anchor.error_family ? { error_family: args.anchor.error_family } : {}),
    ...(args.anchor.pattern_signature ? { pattern_signature: args.anchor.pattern_signature } : {}),
    anchor_kind: args.anchor.anchor_kind,
    anchor_level: args.anchor.anchor_level,
    ...(args.anchor.pattern_state ? { pattern_state: args.anchor.pattern_state } : {}),
    ...(args.anchor.credibility_state ? { credibility_state: args.anchor.credibility_state } : {}),
    ...(args.anchor.selected_tool !== undefined ? { selected_tool: args.anchor.selected_tool } : {}),
    ...(args.anchor.promotion ? { promotion: args.anchor.promotion } : {}),
    ...(args.anchor.promotion_evidence_ledger_v1 ? { promotion_evidence_ledger_v1: args.anchor.promotion_evidence_ledger_v1 } : {}),
    ...(args.anchor.trust_hardening ? { trust_hardening: args.anchor.trust_hardening } : {}),
    ...(args.anchor.maintenance ? { maintenance: args.anchor.maintenance } : {}),
  });
  return {
    summary_kind: "pattern_anchor",
    compression_layer: "L3",
    anchor_v1: args.anchor,
    execution_native_v1: executionNative,
    ...(args.anchor.promotion_evidence_ledger_v1 ? { promotion_evidence_ledger_v1: args.anchor.promotion_evidence_ledger_v1 } : {}),
    execution_contract_v1: executionContract,
    decision_pattern_signature: args.patternSignature,
    pattern_state: args.anchor.pattern_state ?? "provisional",
    credibility_state: args.anchor.credibility_state ?? "candidate",
    selected_tool: args.selectedTool,
    candidates: args.candidates,
    source_rule_ids: args.sourceRuleIds,
    outcome: args.feedbackOutcome,
    anchor_origin: "tools_feedback",
  };
}

async function findExistingPatternAnchorLite(
  liteWriteStore: Pick<LiteWriteStore, "findNodes">,
  scope: string,
  clientId: string,
): Promise<ExistingPatternAnchorNode | null> {
  const { rows } = await liteWriteStore.findNodes({
    scope,
    type: "concept",
    clientId,
    limit: 1,
    offset: 0,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    text_summary: row.text_summary,
    slots: row.slots,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
  };
}

function existingPatternAnchorSha256(node: ExistingPatternAnchorNode | null): string | null {
  return node ? sha256Hex(stableStringify(node)) : null;
}

async function updateExistingPatternAnchorLite(
  liteWriteStore: Pick<LiteWriteStore, "updateNodeAnchorState">,
  args: {
    scope: string;
    id: string;
    slots: Record<string, unknown>;
    textSummary: string;
    salience: number;
    importance: number;
    confidence: number;
    commitId: string;
  },
): Promise<void> {
  await liteWriteStore.updateNodeAnchorState({
    scope: args.scope,
    id: args.id,
    slots: args.slots,
    textSummary: args.textSummary,
    salience: args.salience,
    importance: args.importance,
    confidence: args.confidence,
    commitId: args.commitId,
  });
}

export async function prepareToolsDecisionPatternAnchor(
  args: WriteToolsDecisionPatternAnchorArgs,
  opts: WriteToolsDecisionPatternAnchorOptions,
): Promise<PreparedToolsDecisionPatternAnchor | null> {
  const taskCue = extractTaskCue(args.context, args.input_text ?? null, args.note ?? null);
  const taskFamily = extractTaskFamily(args.context, taskCue);
  const errorSignature = extractErrorSignature(args.context);
  const errorFamily = extractErrorFamily(args.context, errorSignature);
  const patternSignature = buildPatternSignature({
    selected_tool: args.selected_tool,
    candidates: args.candidates,
    context_sha256: args.decision.context_sha256,
    policy_sha256: args.decision.policy_sha256,
    source_rule_ids: args.source_rule_ids,
  });
  const clientId = `tools-pattern:${patternSignature}`;
  const title = truncate(
    taskCue ? `Pattern: prefer ${args.selected_tool} for ${taskCue}` : `Pattern: prefer ${args.selected_tool}`,
    180,
  );

  const existingNode = opts.liteWriteStore
    ? await findExistingPatternAnchorLite(opts.liteWriteStore, args.scope, clientId)
    : null;
  if (!existingNode && args.feedback_outcome === "negative") {
    return null;
  }

  const existingAnchor = existingNode ? parseExistingAnchor(existingNode) : null;
  const anchor = buildPatternAnchor({
    taskCue,
    taskFamily,
    errorSignature,
    errorFamily,
    patternSignature,
    selectedTool: args.selected_tool,
    candidates: args.candidates,
    sourceRuleIds: args.source_rule_ids,
    decision: args.decision,
    feedbackCommitId: args.feedback_commit_id,
    feedbackOutcome: args.feedback_outcome,
    existing: existingAnchor,
    learningControlPatternStateOverride: args.learning_control_pattern_state_override ?? null,
  });
  const summary = anchor.summary;
  const slots = buildPatternAnchorSlots({
    anchor,
    taskCue,
    patternSignature,
    selectedTool: args.selected_tool,
    candidates: args.candidates,
    sourceRuleIds: args.source_rule_ids,
    feedbackOutcome: args.feedback_outcome,
  });
  const trustProfile = resolveNodePriorityProfile({
    type: "concept",
    tier: "warm",
    title,
    text_summary: summary,
    slots,
  });

  if (existingNode) {
    return {
      scope: args.scope,
      feedback_commit_id: args.feedback_commit_id,
      expected_existing_sha256: existingPatternAnchorSha256(existingNode),
      update: {
        id: existingNode.id,
        slots,
        text_summary: summary,
        salience: trustProfile.salience,
        importance: trustProfile.importance,
        confidence: trustProfile.confidence,
      },
      prepared_write: null,
      result: {
        node_id: existingNode.id,
        client_id: clientId,
        pattern_signature: patternSignature,
        anchor,
      },
    };
  }

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: args.tenant_id,
      scope: args.scope,
      actor: args.actor,
      input_text: args.input_text ?? undefined,
      input_sha256: args.input_sha256,
      auto_embed: true,
      memory_lane: "shared",
      nodes: [
        {
          client_id: clientId,
          type: "concept",
          title,
          text_summary: summary,
          slots,
          salience: trustProfile.salience,
          importance: trustProfile.importance,
          confidence: trustProfile.confidence,
        },
      ],
      edges: [],
    },
    opts.defaultScope,
    opts.defaultTenantId,
    {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
    },
    opts.embedder,
  );
  return {
    scope: args.scope,
    feedback_commit_id: args.feedback_commit_id,
    expected_existing_sha256: null,
    update: null,
    prepared_write: prepared,
    result: {
      node_id: prepared.nodes[0]!.id,
      client_id: clientId,
      pattern_signature: patternSignature,
      anchor,
    },
  };
}

export async function persistPreparedToolsDecisionPatternAnchor(
  prepared: PreparedToolsDecisionPatternAnchor,
  opts: {
    liteWriteStore: LiteProjectedWriteStore & Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">;
    maxTextLen: number;
    piiRedaction: boolean;
    allowCrossScopeEdges?: boolean;
  },
): Promise<PatternAnchorWriteResult> {
  const current = await findExistingPatternAnchorLite(
    opts.liteWriteStore,
    prepared.scope,
    prepared.result.client_id,
  );
  if (existingPatternAnchorSha256(current) !== prepared.expected_existing_sha256) {
    throw new Error("tools_pattern_anchor_prepare_conflict");
  }
  if (prepared.update) {
    await updateExistingPatternAnchorLite(opts.liteWriteStore, {
      scope: prepared.scope,
      id: prepared.update.id,
      slots: prepared.update.slots,
      textSummary: prepared.update.text_summary,
      salience: prepared.update.salience,
      importance: prepared.update.importance,
      confidence: prepared.update.confidence,
      commitId: prepared.feedback_commit_id,
    });
  } else if (prepared.prepared_write) {
    await persistLitePreparedWrite({
      prepared: prepared.prepared_write,
      liteWriteStore: opts.liteWriteStore,
      writeOptions: {
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
        allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
        associativeLinkOrigin: "memory_write",
      },
    });
  }
  return prepared.result;
}

export async function writeToolsDecisionPatternAnchor(
  args: WriteToolsDecisionPatternAnchorArgs,
  opts: WriteToolsDecisionPatternAnchorOptions,
): Promise<PatternAnchorWriteResult | null> {
  if (!opts.writeAccess) throw new Error("write_access_required_for_tools_pattern_anchor");
  const liteWriteStore = opts.liteWriteStore ?? null;
  if (liteWriteStore && opts.writeAccess !== liteWriteStore) {
    throw new Error("tools pattern anchor write authorities must share one Lite store");
  }
  if (liteWriteStore?.transactionRunner().inTransaction()) {
    throw new Error("writeToolsDecisionPatternAnchor must be entered outside a transaction");
  }
  const prepared = await prepareToolsDecisionPatternAnchor(args, opts);
  if (!prepared) return null;
  if (!liteWriteStore) {
    const write = prepared.prepared_write;
    if (!write) throw new Error("tools pattern anchor generic write plan is missing");
    const planned = write.nodes.filter((node) => (
      !node.embedding && typeof node.embed_text === "string" && node.embed_text.trim().length > 0
    ));
    if (opts.embedder && planned.length > 0) {
      const vectors = await opts.embedder.embed(planned.map((node) => String(node.embed_text)));
      for (let index = 0; index < planned.length; index += 1) {
        planned[index]!.embedding = vectors[index] ?? planned[index]!.embedding;
        planned[index]!.embedding_model = opts.embedder.name;
      }
    }
    const out = await applyPreparedMemoryWrite(opts.writeAccess, write, {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges ?? false,
      associativeLinkOrigin: "memory_write",
    });
    return { ...prepared.result, node_id: out.nodes[0]!.id };
  }
  const result = await liteWriteStore.withTx(() => persistPreparedToolsDecisionPatternAnchor(prepared, {
    liteWriteStore,
    maxTextLen: opts.maxTextLen,
    piiRedaction: opts.piiRedaction,
    allowCrossScopeEdges: opts.allowCrossScopeEdges,
  }));
  if (prepared.prepared_write) {
    await completeLiteInlineEmbeddings({ prepared: prepared.prepared_write, embedder: opts.embedder, liteWriteStore });
  }
  return result;
}
