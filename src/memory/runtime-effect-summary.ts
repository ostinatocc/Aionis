import {
  RuntimeEffectSummaryV1Schema,
  RuntimeSignalLedgerV1Schema,
  type RuntimeEffectSummaryV1,
  type RuntimeSignalKind,
  type RuntimeSignalLedgerV1,
  type RuntimeSignalPolarity,
} from "./schemas.js";
import { buildPromotionQualitySummaryFromRows } from "./promotion-quality-summary.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

type RuntimeEffectPosture = RuntimeEffectSummaryV1["measurable_effect_posture"];

type SignalStats = {
  includedLedgerCount: number;
  repeatedDiscoveryCount: number;
  repeatedFailedActionCount: number;
  continuityReadySignalCount: number;
  verifierSuccessCount: number;
  verifierFailureCount: number;
  retryCountTotal: number;
  recoveryCostTotal: number;
  providerQuarantineCount: number;
  workflowReuseSuccessCount: number;
  workflowReuseFailureCount: number;
  toolSelectionSuccessCount: number;
  toolSelectionFailureCount: number;
  forgettingSignalCount: number;
  rehydrationUsefulCount: number;
  rehydrationUnhelpfulCount: number;
};

type ContextCostStats = {
  observedCount: number;
  withinBudgetCount: number;
  overBudgetCount: number;
  unknownBudgetCount: number;
  totalEstTokens: number;
  maxEstTokens: number;
  totalTokenBudget: number;
  budgetObservationCount: number;
  contextItemsReducedCount: number;
  primarySavingsLevers: Set<string>;
};

type MaintenanceEffectStats = {
  memoryDemotions: number;
  memoryArchives: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function numericSignal(entry: RuntimeSignalLedgerV1["entries"][number]): number {
  if (typeof entry.numeric_value === "number" && Number.isFinite(entry.numeric_value)) {
    return Math.max(0, Math.trunc(entry.numeric_value));
  }
  return entry.polarity === "negative" || entry.polarity === "positive" ? 1 : 0;
}

function sourceNodeIds(rows: LiteFindNodeRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row.id);
    if (out.length >= 64) break;
  }
  return out;
}

function parseSignalLedger(row: LiteFindNodeRow): RuntimeSignalLedgerV1 | null {
  const parsed = RuntimeSignalLedgerV1Schema.safeParse(row.slots.runtime_signal_ledger_v1);
  return parsed.success ? parsed.data : null;
}

function updateOutcomeCounts(args: {
  kind: RuntimeSignalKind;
  polarity: RuntimeSignalPolarity;
  stats: SignalStats;
}) {
  if (args.kind === "verifier_result") {
    if (args.polarity === "positive") args.stats.verifierSuccessCount += 1;
    if (args.polarity === "negative") args.stats.verifierFailureCount += 1;
  }
  if (args.kind === "workflow_reuse_outcome") {
    if (args.polarity === "positive") args.stats.workflowReuseSuccessCount += 1;
    if (args.polarity === "negative") args.stats.workflowReuseFailureCount += 1;
  }
  if (args.kind === "tool_selection_outcome") {
    if (args.polarity === "positive") args.stats.toolSelectionSuccessCount += 1;
    if (args.polarity === "negative") args.stats.toolSelectionFailureCount += 1;
  }
  if (args.kind === "rehydration_usefulness") {
    if (args.polarity === "positive") args.stats.rehydrationUsefulCount += 1;
    if (args.polarity === "negative") args.stats.rehydrationUnhelpfulCount += 1;
  }
}

function collectSignalStats(rows: LiteFindNodeRow[]): { stats: SignalStats; includedRows: LiteFindNodeRow[] } {
  const stats: SignalStats = {
    includedLedgerCount: 0,
    repeatedDiscoveryCount: 0,
    repeatedFailedActionCount: 0,
    continuityReadySignalCount: 0,
    verifierSuccessCount: 0,
    verifierFailureCount: 0,
    retryCountTotal: 0,
    recoveryCostTotal: 0,
    providerQuarantineCount: 0,
    workflowReuseSuccessCount: 0,
    workflowReuseFailureCount: 0,
    toolSelectionSuccessCount: 0,
    toolSelectionFailureCount: 0,
    forgettingSignalCount: 0,
    rehydrationUsefulCount: 0,
    rehydrationUnhelpfulCount: 0,
  };
  const includedRows: LiteFindNodeRow[] = [];
  for (const row of rows) {
    const ledger = parseSignalLedger(row);
    if (!ledger) continue;
    stats.includedLedgerCount += 1;
    includedRows.push(row);
    for (const entry of ledger.entries) {
      const amount = numericSignal(entry);
      if (entry.signal_kind === "repeated_discovery") stats.repeatedDiscoveryCount += amount;
      if (entry.signal_kind === "repeated_failed_action") stats.repeatedFailedActionCount += amount;
      if (entry.signal_kind === "retry_count") stats.retryCountTotal += amount;
      if (entry.signal_kind === "recovery_cost") stats.recoveryCostTotal += amount;
      if (entry.signal_kind === "provider_protocol_failure" || entry.authority_effect === "quarantine") {
        stats.providerQuarantineCount += 1;
      }
      if (entry.authority_effect === "forgetting_signal") stats.forgettingSignalCount += 1;
      updateOutcomeCounts({ kind: entry.signal_kind, polarity: entry.polarity, stats });
    }
    const actionContract = asRecord(row.slots.action_intelligence_runtime_contract)
      ?? asRecord(row.slots.action_intelligence_runtime_contract_v1);
    const preActionGate = asRecord(actionContract?.pre_action_gate);
    if (preActionGate?.known_enough === true) stats.continuityReadySignalCount += 1;
  }
  return { stats, includedRows };
}

function contextCostRecord(row: LiteFindNodeRow): Record<string, unknown> | null {
  return asRecord(row.slots.context_cost_signals_v1) ?? asRecord(row.slots.context_cost_signals);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 64);
}

function collectContextCostStats(rows: LiteFindNodeRow[]): { stats: ContextCostStats; includedRows: LiteFindNodeRow[] } {
  const stats: ContextCostStats = {
    observedCount: 0,
    withinBudgetCount: 0,
    overBudgetCount: 0,
    unknownBudgetCount: 0,
    totalEstTokens: 0,
    maxEstTokens: 0,
    totalTokenBudget: 0,
    budgetObservationCount: 0,
    contextItemsReducedCount: 0,
    primarySavingsLevers: new Set<string>(),
  };
  const includedRows: LiteFindNodeRow[] = [];
  for (const row of rows) {
    const record = contextCostRecord(row);
    if (!record) continue;
    includedRows.push(row);
    stats.observedCount += 1;
    const estTokens = nonNegativeInt(record.context_est_tokens ?? record.estimated_tokens);
    stats.totalEstTokens += estTokens;
    stats.maxEstTokens = Math.max(stats.maxEstTokens, estTokens);
    const budgetRaw = record.context_token_budget ?? record.token_budget;
    const tokenBudget = Number(budgetRaw);
    if (Number.isFinite(tokenBudget) && tokenBudget > 0) {
      stats.totalTokenBudget += Math.trunc(tokenBudget);
      stats.budgetObservationCount += 1;
      const within = record.within_token_budget === true || estTokens <= tokenBudget;
      if (within) stats.withinBudgetCount += 1;
      else stats.overBudgetCount += 1;
    } else {
      stats.unknownBudgetCount += 1;
    }
    stats.contextItemsReducedCount += nonNegativeInt(record.forgotten_items)
      + nonNegativeInt(record.retrieval_filtered_by_layer_policy_count)
      + nonNegativeInt(record.filtered_by_layer_policy_count)
      + nonNegativeInt(record.static_blocks_rejected);
    for (const lever of stringList(record.primary_savings_levers)) {
      stats.primarySavingsLevers.add(lever.slice(0, 128));
    }
  }
  return { stats, includedRows };
}

function collectMaintenanceEffectStats(rows: LiteFindNodeRow[]): MaintenanceEffectStats {
  const stats: MaintenanceEffectStats = {
    memoryDemotions: 0,
    memoryArchives: 0,
  };
  for (const row of rows) {
    const effect = asRecord(row.slots.runtime_maintenance_effect_summary_v1)
      ?? asRecord(row.slots.runtime_maintenance_effect_summary);
    if (!effect) continue;
    stats.memoryDemotions += nonNegativeInt(effect.memory_demotions);
    stats.memoryArchives += nonNegativeInt(effect.memory_archives);
  }
  return stats;
}

function effectPosture(args: {
  signal: SignalStats;
  context: ContextCostStats;
  promotion: ReturnType<typeof buildPromotionQualitySummaryFromRows>;
}): RuntimeEffectPosture {
  const evidenceCount = args.signal.includedLedgerCount
    + args.context.observedCount
    + args.promotion.included_ledger_count;
  if (evidenceCount === 0) return "insufficient_evidence";
  if (args.signal.providerQuarantineCount > 0) return "blocked";
  if (
    args.signal.verifierFailureCount > args.signal.verifierSuccessCount
    && args.signal.verifierSuccessCount === 0
  ) {
    return "blocked";
  }
  if (
    args.promotion.invalidation_pressure === "high"
    || args.promotion.recommended_learning_posture === "invalidate"
    || args.context.overBudgetCount > 0
    || args.signal.repeatedDiscoveryCount > 0
    || args.signal.repeatedFailedActionCount > 0
    || args.signal.workflowReuseFailureCount > args.signal.workflowReuseSuccessCount
  ) {
    return "constrained";
  }
  if (
    args.signal.verifierSuccessCount > 0
    || args.signal.workflowReuseSuccessCount > 0
    || args.promotion.recommended_learning_posture === "promotion_ready"
  ) {
    return "positive";
  }
  return "mixed";
}

function findings(args: {
  posture: RuntimeEffectPosture;
  signal: SignalStats;
  context: ContextCostStats;
  promotion: ReturnType<typeof buildPromotionQualitySummaryFromRows>;
}): string[] {
  const out: string[] = [];
  if (args.posture === "insufficient_evidence") {
    out.push("No measurable runtime effect evidence was found in the scan window.");
  }
  if (args.signal.providerQuarantineCount > 0) {
    out.push("Provider or protocol quarantine evidence blocks effectiveness claims for this window.");
  }
  if (args.signal.verifierSuccessCount > 0) {
    out.push("Verifier-success signals are present for real outcome measurement.");
  }
  if (args.signal.verifierFailureCount > 0) {
    out.push("Verifier-failure signals reduce measured runtime effect quality.");
  }
  if (args.signal.workflowReuseSuccessCount > 0) {
    out.push("Workflow reuse succeeded in the scan window.");
  }
  if (args.signal.repeatedDiscoveryCount > 0) {
    out.push("Repeated discovery remains visible; continuity or recall coverage still needs improvement.");
  }
  if (args.context.overBudgetCount > 0) {
    out.push("Token/context pressure exceeded budget in at least one observed context.");
  }
  if (args.context.contextItemsReducedCount > 0) {
    out.push("Context reduction evidence is present through forgetting, filtering, or compaction levers.");
  }
  if (args.promotion.included_ledger_count > 0) {
    out.push("Promotion quality evidence is available for learning-effect measurement.");
  }
  if (args.promotion.invalidation_pressure === "high") {
    out.push("Promotion invalidation pressure is high; broad learning claims should stay blocked.");
  }
  out.push("Baseline comparison is still required before claiming product-level effectiveness.");
  return out.slice(0, 12);
}

export function buildRuntimeEffectSummaryFromRows(args: {
  rows: LiteFindNodeRow[];
  truncated?: boolean;
}): RuntimeEffectSummaryV1 {
  const signal = collectSignalStats(args.rows);
  const context = collectContextCostStats(args.rows);
  const maintenance = collectMaintenanceEffectStats(args.rows);
  const promotion = buildPromotionQualitySummaryFromRows(args);
  const posture = effectPosture({
    signal: signal.stats,
    context: context.stats,
    promotion,
  });
  const includedRows = [...signal.includedRows, ...context.includedRows];
  const averageEstTokens = context.stats.observedCount > 0
    ? Number((context.stats.totalEstTokens / context.stats.observedCount).toFixed(6))
    : 0;
  const averageTokenBudget = context.stats.budgetObservationCount > 0
    ? Number((context.stats.totalTokenBudget / context.stats.budgetObservationCount).toFixed(6))
    : null;

  return RuntimeEffectSummaryV1Schema.parse({
    summary_version: "runtime_effect_summary_v1",
    scanned_node_count: args.rows.length,
    included_signal_ledger_count: signal.stats.includedLedgerCount,
    included_promotion_ledger_count: promotion.included_ledger_count,
    context_cost_observation_count: context.stats.observedCount,
    truncated: args.truncated ?? false,
    baseline_comparison_required: true,
    token_context: {
      observed_count: context.stats.observedCount,
      within_budget_count: context.stats.withinBudgetCount,
      over_budget_count: context.stats.overBudgetCount,
      unknown_budget_count: context.stats.unknownBudgetCount,
      average_est_tokens: averageEstTokens,
      average_token_budget: averageTokenBudget,
      max_est_tokens: context.stats.maxEstTokens,
      context_items_reduced_count: context.stats.contextItemsReducedCount,
      primary_savings_levers: Array.from(context.stats.primarySavingsLevers).slice(0, 32),
    },
    continuity: {
      repeated_discovery_count: signal.stats.repeatedDiscoveryCount,
      repeated_failed_action_count: signal.stats.repeatedFailedActionCount,
      continuity_ready_signal_count: signal.stats.continuityReadySignalCount,
    },
    verification: {
      verifier_success_count: signal.stats.verifierSuccessCount,
      verifier_failure_count: signal.stats.verifierFailureCount,
      retry_count_total: signal.stats.retryCountTotal,
      recovery_cost_total: signal.stats.recoveryCostTotal,
      provider_quarantine_count: signal.stats.providerQuarantineCount,
    },
    learning: {
      workflow_reuse_success_count: signal.stats.workflowReuseSuccessCount,
      workflow_reuse_failure_count: signal.stats.workflowReuseFailureCount,
      tool_selection_success_count: signal.stats.toolSelectionSuccessCount,
      tool_selection_failure_count: signal.stats.toolSelectionFailureCount,
      promotion_admission_rate: promotion.promotion_admission_rate,
      promotion_contested_rate: promotion.contested_rate,
      promotion_invalidation_pressure: promotion.invalidation_pressure,
      recommended_learning_posture: promotion.recommended_learning_posture,
    },
    forgetting: {
      forgetting_signal_count: signal.stats.forgettingSignalCount,
      memory_demotions: maintenance.memoryDemotions,
      memory_archives: maintenance.memoryArchives,
      rehydration_useful_count: signal.stats.rehydrationUsefulCount,
      rehydration_unhelpful_count: signal.stats.rehydrationUnhelpfulCount,
    },
    measurable_effect_posture: posture,
    findings: findings({
      posture,
      signal: signal.stats,
      context: context.stats,
      promotion,
    }),
    source_node_ids: sourceNodeIds(includedRows),
    source_code_change_allowed: false,
  });
}

export async function scanRuntimeEffectSummaryLite(
  store: Pick<LiteWriteStore, "findNodes">,
  args: {
    scope: string;
    actor: string;
    limit?: number;
  },
): Promise<RuntimeEffectSummaryV1> {
  const limit = Math.max(1, Math.min(2_000, args.limit ?? 500));
  const rows: LiteFindNodeRow[] = [];
  let offset = 0;
  let truncated = false;

  while (rows.length < limit) {
    const page = await store.findNodes({
      scope: args.scope,
      consumerAgentId: args.actor,
      consumerTeamId: null,
      limit: Math.min(100, limit - rows.length),
      offset,
    });
    rows.push(...page.rows);
    offset += page.rows.length;
    if (!page.has_more || page.rows.length === 0) break;
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
  }

  return buildRuntimeEffectSummaryFromRows({ rows, truncated });
}
