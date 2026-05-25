import {
  RuntimeSignalLedgerV1Schema,
  RuntimeSignalTrendSummaryV1Schema,
  type RuntimeSignalAuthorityEffect,
  type RuntimeSignalCapability,
  type RuntimeSignalKind,
  type RuntimeSignalLedgerEntryV1,
  type RuntimeSignalPolarity,
  type RuntimeSignalTrendSummaryV1,
} from "./schemas.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

const SIGNAL_KINDS: RuntimeSignalKind[] = [
  "verifier_result",
  "recovery_cost",
  "retry_count",
  "repeated_discovery",
  "repeated_failed_action",
  "provider_protocol_failure",
  "edit_boundary_rejection",
  "tool_selection_outcome",
  "workflow_reuse_outcome",
  "adaptive_guidance_outcome",
  "maintenance_effect",
  "token_context_pressure",
  "rehydration_usefulness",
];

const POLARITIES: RuntimeSignalPolarity[] = ["positive", "neutral", "negative"];

const AUTHORITY_EFFECTS: RuntimeSignalAuthorityEffect[] = [
  "none",
  "promotion_evidence_candidate",
  "counter_evidence",
  "quarantine",
  "forgetting_signal",
];

const CAPABILITIES: RuntimeSignalCapability[] = [
  "continuity",
  "learning",
  "forgetting",
  "learning_control",
];

type SignalCount = RuntimeSignalTrendSummaryV1["signal_counts"][number];
type NumericAccumulator = {
  count: number;
  min: number;
  max: number;
  total: number;
};

function zeroAuthorityEffects(): Record<RuntimeSignalAuthorityEffect, number> {
  return {
    none: 0,
    promotion_evidence_candidate: 0,
    counter_evidence: 0,
    quarantine: 0,
    forgetting_signal: 0,
  };
}

function zeroSignalCount(kind: RuntimeSignalKind): SignalCount {
  return {
    signal_kind: kind,
    total: 0,
    positive: 0,
    neutral: 0,
    negative: 0,
    authority_effects: zeroAuthorityEffects(),
  };
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

function parseEntries(row: LiteFindNodeRow): RuntimeSignalLedgerEntryV1[] {
  const parsed = RuntimeSignalLedgerV1Schema.safeParse(row.slots.runtime_signal_ledger_v1);
  return parsed.success ? parsed.data.entries : [];
}

function dominantSignals(
  signalCounts: SignalCount[],
  polarity: "positive" | "negative",
): RuntimeSignalKind[] {
  return signalCounts
    .filter((count) => count[polarity] > 0)
    .sort((a, b) => b[polarity] - a[polarity] || SIGNAL_KINDS.indexOf(a.signal_kind) - SIGNAL_KINDS.indexOf(b.signal_kind))
    .map((count) => count.signal_kind)
    .slice(0, 12);
}

function runtimePosture(args: {
  includedLedgerCount: number;
  signalCounts: SignalCount[];
  authorityCounts: Record<RuntimeSignalAuthorityEffect, number>;
  positiveCount: number;
  negativeCount: number;
}): RuntimeSignalTrendSummaryV1["recommended_runtime_posture"] {
  if (args.authorityCounts.quarantine > 0) return "quarantine";
  if (args.negativeCount > args.positiveCount || args.authorityCounts.counter_evidence > args.authorityCounts.promotion_evidence_candidate) {
    return "constrain";
  }
  const repeatedDiscovery = args.signalCounts.find((count) => count.signal_kind === "repeated_discovery");
  if (args.includedLedgerCount === 0 || (repeatedDiscovery && repeatedDiscovery.negative > 0)) return "explore";
  return "reuse";
}

function findings(args: {
  includedLedgerCount: number;
  signalCounts: SignalCount[];
  authorityCounts: Record<RuntimeSignalAuthorityEffect, number>;
  posture: RuntimeSignalTrendSummaryV1["recommended_runtime_posture"];
}): string[] {
  const out: string[] = [];
  const countFor = (kind: RuntimeSignalKind) => args.signalCounts.find((count) => count.signal_kind === kind) ?? zeroSignalCount(kind);

  if (args.includedLedgerCount === 0) {
    out.push("No runtime signal ledgers were found in the scan window.");
  }
  if (args.authorityCounts.quarantine > 0) {
    out.push("Quarantine evidence is present; broad learning promotion should stay blocked.");
  }
  if (args.authorityCounts.counter_evidence > args.authorityCounts.promotion_evidence_candidate) {
    out.push("Counter-evidence exceeds promotion candidates; learning should remain constrained.");
  }
  if (countFor("repeated_discovery").negative > 0) {
    out.push("Repeated discovery signals indicate recall, continuity, or workflow coverage gaps.");
  }
  if (countFor("token_context_pressure").negative > 0) {
    out.push("Token/context pressure suggests narrower recall, better compression, or controlled forgetting.");
  }
  if (countFor("workflow_reuse_outcome").positive > 0) {
    out.push("Successful workflow reuse evidence is available for learning-control review.");
  }
  if (args.authorityCounts.promotion_evidence_candidate > 0) {
    out.push("Promotion evidence candidates are present but still require scoped learning-control adjudication.");
  }
  if (out.length === 0 && args.posture === "reuse") {
    out.push("Positive runtime signals dominate the scan window; reuse posture is admissible.");
  }

  return out.slice(0, 12);
}

export function buildRuntimeSignalTrendSummaryFromRows(args: {
  rows: LiteFindNodeRow[];
  truncated?: boolean;
}): RuntimeSignalTrendSummaryV1 {
  const signalCounts = new Map<RuntimeSignalKind, SignalCount>();
  const numeric = new Map<RuntimeSignalKind, NumericAccumulator>();
  const polarityCounts: Record<RuntimeSignalPolarity, number> = {
    positive: 0,
    neutral: 0,
    negative: 0,
  };
  const authorityCounts = zeroAuthorityEffects();
  const capabilityCounts: Record<RuntimeSignalCapability, number> = {
    continuity: 0,
    learning: 0,
    forgetting: 0,
    learning_control: 0,
  };
  const includedRows: LiteFindNodeRow[] = [];
  let entryCount = 0;

  for (const row of args.rows) {
    const entries = parseEntries(row);
    if (entries.length === 0) continue;
    includedRows.push(row);
    for (const entry of entries) {
      entryCount += 1;
      polarityCounts[entry.polarity] += 1;
      authorityCounts[entry.authority_effect] += 1;
      let count = signalCounts.get(entry.signal_kind);
      if (!count) {
        count = zeroSignalCount(entry.signal_kind);
        signalCounts.set(entry.signal_kind, count);
      }
      count.total += 1;
      count[entry.polarity] += 1;
      count.authority_effects[entry.authority_effect] += 1;
      for (const capability of entry.affected_capabilities) {
        capabilityCounts[capability] += 1;
      }
      if (typeof entry.numeric_value === "number" && Number.isFinite(entry.numeric_value)) {
        const current = numeric.get(entry.signal_kind) ?? {
          count: 0,
          min: entry.numeric_value,
          max: entry.numeric_value,
          total: 0,
        };
        current.count += 1;
        current.min = Math.min(current.min, entry.numeric_value);
        current.max = Math.max(current.max, entry.numeric_value);
        current.total += entry.numeric_value;
        numeric.set(entry.signal_kind, current);
      }
    }
  }

  const orderedSignalCounts = SIGNAL_KINDS
    .map((kind) => signalCounts.get(kind))
    .filter((count): count is SignalCount => !!count);
  const posture = runtimePosture({
    includedLedgerCount: includedRows.length,
    signalCounts: orderedSignalCounts,
    authorityCounts,
    positiveCount: polarityCounts.positive,
    negativeCount: polarityCounts.negative,
  });

  return RuntimeSignalTrendSummaryV1Schema.parse({
    summary_version: "runtime_signal_trend_summary_v1",
    scanned_node_count: args.rows.length,
    included_ledger_count: includedRows.length,
    entry_count: entryCount,
    truncated: args.truncated ?? false,
    signal_counts: orderedSignalCounts,
    polarity_counts: polarityCounts,
    authority_effect_counts: authorityCounts,
    capability_counts: capabilityCounts,
    quarantine_signal_count: authorityCounts.quarantine,
    counter_evidence_count: authorityCounts.counter_evidence,
    promotion_evidence_candidate_count: authorityCounts.promotion_evidence_candidate,
    forgetting_signal_count: authorityCounts.forgetting_signal,
    numeric_trends: SIGNAL_KINDS
      .map((kind) => {
        const stat = numeric.get(kind);
        if (!stat) return null;
        return {
          signal_kind: kind,
          count: stat.count,
          min: stat.min,
          max: stat.max,
          average: Number((stat.total / Math.max(1, stat.count)).toFixed(6)),
        };
      })
      .filter((stat): stat is RuntimeSignalTrendSummaryV1["numeric_trends"][number] => !!stat),
    dominant_negative_signals: dominantSignals(orderedSignalCounts, "negative"),
    dominant_positive_signals: dominantSignals(orderedSignalCounts, "positive"),
    recommended_runtime_posture: posture,
    findings: findings({
      includedLedgerCount: includedRows.length,
      signalCounts: orderedSignalCounts,
      authorityCounts,
      posture,
    }),
    source_node_ids: sourceNodeIds(includedRows),
    source_code_change_allowed: false,
  });
}

export async function scanRuntimeSignalTrendSummaryLite(
  store: Pick<LiteWriteStore, "findNodes">,
  args: {
    scope: string;
    actor: string;
    limit?: number;
  },
): Promise<RuntimeSignalTrendSummaryV1> {
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

  return buildRuntimeSignalTrendSummaryFromRows({ rows, truncated });
}
