import {
  PromotionEvidenceLedgerV1Schema,
  PromotionQualitySummaryV1Schema,
  type PromotionEvidenceLedgerV1,
  type PromotionQualitySummaryV1,
} from "./schemas.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

const TRANSITIONS: PromotionEvidenceLedgerV1["transition"][] = [
  "L0_to_L1",
  "L1_to_L2",
  "L2_to_L3",
  "L3_to_L4",
];

const TARGET_KINDS: PromotionEvidenceLedgerV1["target_kind"][] = [
  "distilled_step",
  "workflow",
  "pattern",
  "policy",
];

type Verdict = PromotionEvidenceLedgerV1["verdict"];
type VerdictCounts = PromotionQualitySummaryV1["verdict_counts"];
type GateCounts = PromotionQualitySummaryV1["authority_gate_counts"];
type VerifierStatusCounts = PromotionQualitySummaryV1["verifier_status_counts"];
type ContractTrustCounts = PromotionQualitySummaryV1["contract_trust_counts"];
type TransitionCount = PromotionQualitySummaryV1["transition_counts"][number];
type TargetKindCount = PromotionQualitySummaryV1["target_kind_counts"][number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function zeroVerdictCounts(): VerdictCounts {
  return {
    candidate_only: 0,
    promotion_admitted: 0,
    promotion_blocked: 0,
    contested: 0,
  };
}

function zeroGateCounts(): GateCounts {
  return {
    admitted: 0,
    rejected: 0,
    unknown: 0,
  };
}

function zeroVerifierStatusCounts(): VerifierStatusCounts {
  return {
    succeeded: 0,
    failed: 0,
    incomplete: 0,
    unknown: 0,
    missing: 0,
  };
}

function zeroContractTrustCounts(): ContractTrustCounts {
  return {
    authoritative: 0,
    advisory: 0,
    observational: 0,
    missing: 0,
  };
}

function zeroTransitionCount(transition: PromotionEvidenceLedgerV1["transition"]): TransitionCount {
  return {
    transition,
    total: 0,
    candidate_only: 0,
    promotion_admitted: 0,
    promotion_blocked: 0,
    contested: 0,
    counter_evidence_count: 0,
  };
}

function zeroTargetKindCount(targetKind: PromotionEvidenceLedgerV1["target_kind"]): TargetKindCount {
  return {
    target_kind: targetKind,
    total: 0,
    candidate_only: 0,
    promotion_admitted: 0,
    promotion_blocked: 0,
    contested: 0,
    counter_evidence_count: 0,
  };
}

function addVerdict(counts: VerdictCounts, verdict: Verdict) {
  counts[verdict] += 1;
}

function addGate(counts: GateCounts, value: boolean | null) {
  if (value === true) {
    counts.admitted += 1;
  } else if (value === false) {
    counts.rejected += 1;
  } else {
    counts.unknown += 1;
  }
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

function parseLedgersFromRow(row: LiteFindNodeRow): PromotionEvidenceLedgerV1[] {
  const slots = row.slots ?? {};
  const anchor = asRecord(slots.anchor_v1);
  const executionNative = asRecord(slots.execution_native_v1);
  const candidates = [
    slots.promotion_evidence_ledger_v1,
    anchor?.promotion_evidence_ledger_v1,
    executionNative?.promotion_evidence_ledger_v1,
  ];
  const ledgers: PromotionEvidenceLedgerV1[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const parsed = PromotionEvidenceLedgerV1Schema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.ledger_id)) continue;
    seen.add(parsed.data.ledger_id);
    ledgers.push(parsed.data);
  }
  return ledgers;
}

function invalidationPressure(args: {
  includedLedgerCount: number;
  verdictCounts: VerdictCounts;
  counterEvidenceRefCount: number;
  verifierStatusCounts: VerifierStatusCounts;
  authorityGateCounts: GateCounts;
  learningControlCounts: GateCounts;
}): PromotionQualitySummaryV1["invalidation_pressure"] {
  if (args.includedLedgerCount === 0) return "none";
  const negativeGateCount = args.authorityGateCounts.rejected + args.learningControlCounts.rejected;
  const contestedOrBlocked = args.verdictCounts.contested + args.verdictCounts.promotion_blocked;
  if (
    args.verdictCounts.contested > 0
    && (args.counterEvidenceRefCount > 0 || args.verdictCounts.promotion_blocked > 0)
  ) {
    return "high";
  }
  if (contestedOrBlocked > args.verdictCounts.promotion_admitted) return "high";
  if (args.verifierStatusCounts.failed > 0 || negativeGateCount > 0 || args.counterEvidenceRefCount > 0) {
    return "medium";
  }
  if (args.verdictCounts.candidate_only > 0) return "low";
  return "none";
}

function recommendedLearningPosture(args: {
  includedLedgerCount: number;
  verdictCounts: VerdictCounts;
  pressure: PromotionQualitySummaryV1["invalidation_pressure"];
}): PromotionQualitySummaryV1["recommended_learning_posture"] {
  if (args.includedLedgerCount === 0) return "insufficient_evidence";
  if (args.pressure === "high") return "invalidate";
  if (args.pressure === "medium") return "constrain";
  if (args.verdictCounts.promotion_admitted > 0) return "promotion_ready";
  if (args.verdictCounts.candidate_only > 0) return "candidate_only";
  return "insufficient_evidence";
}

function findings(args: {
  includedLedgerCount: number;
  verdictCounts: VerdictCounts;
  pressure: PromotionQualitySummaryV1["invalidation_pressure"];
  posture: PromotionQualitySummaryV1["recommended_learning_posture"];
  counterEvidenceRefCount: number;
  authorityGateCounts: GateCounts;
  learningControlCounts: GateCounts;
  verifierStatusCounts: VerifierStatusCounts;
}): string[] {
  const out: string[] = [];
  if (args.includedLedgerCount === 0) {
    out.push("No promotion evidence ledgers were found in the scan window.");
  }
  if (args.verdictCounts.promotion_admitted > 0) {
    out.push("Promotion-admitted ledgers are available for reuse-quality review.");
  }
  if (args.verdictCounts.candidate_only > 0) {
    out.push("Candidate-only ledgers still need stronger evidence or learning-control admission.");
  }
  if (args.verdictCounts.promotion_blocked > 0) {
    out.push("Blocked promotion ledgers indicate learning should stay constrained for the affected surfaces.");
  }
  if (args.verdictCounts.contested > 0 || args.counterEvidenceRefCount > 0) {
    out.push("Counter-evidence or contested ledgers are present and should feed invalidation review.");
  }
  if (args.authorityGateCounts.rejected > 0) {
    out.push("Authority gates rejected promotion in the scan window.");
  }
  if (args.learningControlCounts.rejected > 0) {
    out.push("Learning-control gates rejected promotion in the scan window.");
  }
  if (args.verifierStatusCounts.failed > 0) {
    out.push("Verifier-failed promotion ledgers should not become stable authority.");
  }
  if (args.pressure === "none" && args.posture === "promotion_ready") {
    out.push("Promotion quality is clean in this scan window; reuse posture is admissible.");
  }
  return out.slice(0, 12);
}

export function buildPromotionQualitySummaryFromRows(args: {
  rows: LiteFindNodeRow[];
  truncated?: boolean;
}): PromotionQualitySummaryV1 {
  const verdictCounts = zeroVerdictCounts();
  const authorityGateCounts = zeroGateCounts();
  const learningControlCounts = zeroGateCounts();
  const verifierStatusCounts = zeroVerifierStatusCounts();
  const contractTrustCounts = zeroContractTrustCounts();
  const transitionCounts = new Map<PromotionEvidenceLedgerV1["transition"], TransitionCount>();
  const targetKindCounts = new Map<PromotionEvidenceLedgerV1["target_kind"], TargetKindCount>();
  const includedRows: LiteFindNodeRow[] = [];
  const seenLedgerIds = new Set<string>();
  const targetIds = new Set<string>();
  const sourceRunIds = new Set<string>();
  const sourceCommitIds = new Set<string>();
  let evidenceEntryCount = 0;
  let promotionEvidenceRefCount = 0;
  let counterEvidenceRefCount = 0;

  for (const row of args.rows) {
    let rowIncluded = false;
    for (const ledger of parseLedgersFromRow(row)) {
      if (seenLedgerIds.has(ledger.ledger_id)) continue;
      seenLedgerIds.add(ledger.ledger_id);
      rowIncluded = true;
      addVerdict(verdictCounts, ledger.verdict);
      addGate(authorityGateCounts, ledger.authority_gate_admitted);
      addGate(learningControlCounts, ledger.learning_control_admitted);
      if (ledger.verifier_status) {
        verifierStatusCounts[ledger.verifier_status] += 1;
      } else {
        verifierStatusCounts.missing += 1;
      }
      if (ledger.contract_trust) {
        contractTrustCounts[ledger.contract_trust] += 1;
      } else {
        contractTrustCounts.missing += 1;
      }

      const transitionCount = transitionCounts.get(ledger.transition) ?? zeroTransitionCount(ledger.transition);
      transitionCount.total += 1;
      transitionCount[ledger.verdict] += 1;
      transitionCount.counter_evidence_count += ledger.counter_evidence_refs.length;
      transitionCounts.set(ledger.transition, transitionCount);

      const targetKindCount = targetKindCounts.get(ledger.target_kind) ?? zeroTargetKindCount(ledger.target_kind);
      targetKindCount.total += 1;
      targetKindCount[ledger.verdict] += 1;
      targetKindCount.counter_evidence_count += ledger.counter_evidence_refs.length;
      targetKindCounts.set(ledger.target_kind, targetKindCount);

      evidenceEntryCount += ledger.evidence.length;
      promotionEvidenceRefCount += ledger.promotion_evidence_refs.length;
      counterEvidenceRefCount += ledger.counter_evidence_refs.length;
      if (ledger.target_id) targetIds.add(ledger.target_id);
      for (const runId of ledger.source_run_ids) sourceRunIds.add(runId);
      for (const commitId of ledger.source_commit_ids) sourceCommitIds.add(commitId);
    }
    if (rowIncluded) includedRows.push(row);
  }

  const includedLedgerCount = seenLedgerIds.size;
  const pressure = invalidationPressure({
    includedLedgerCount,
    verdictCounts,
    counterEvidenceRefCount,
    verifierStatusCounts,
    authorityGateCounts,
    learningControlCounts,
  });
  const posture = recommendedLearningPosture({
    includedLedgerCount,
    verdictCounts,
    pressure,
  });

  return PromotionQualitySummaryV1Schema.parse({
    summary_version: "promotion_quality_summary_v1",
    scanned_node_count: args.rows.length,
    included_ledger_count: includedLedgerCount,
    evidence_entry_count: evidenceEntryCount,
    truncated: args.truncated ?? false,
    verdict_counts: verdictCounts,
    transition_counts: TRANSITIONS
      .map((transition) => transitionCounts.get(transition))
      .filter((count): count is TransitionCount => !!count),
    target_kind_counts: TARGET_KINDS
      .map((targetKind) => targetKindCounts.get(targetKind))
      .filter((count): count is TargetKindCount => !!count),
    authority_gate_counts: authorityGateCounts,
    learning_control_counts: learningControlCounts,
    verifier_status_counts: verifierStatusCounts,
    contract_trust_counts: contractTrustCounts,
    promotion_evidence_ref_count: promotionEvidenceRefCount,
    counter_evidence_ref_count: counterEvidenceRefCount,
    distinct_target_count: targetIds.size,
    distinct_source_run_count: sourceRunIds.size,
    distinct_source_commit_count: sourceCommitIds.size,
    promotion_admission_rate: includedLedgerCount > 0
      ? Number((verdictCounts.promotion_admitted / includedLedgerCount).toFixed(6))
      : 0,
    contested_rate: includedLedgerCount > 0
      ? Number((verdictCounts.contested / includedLedgerCount).toFixed(6))
      : 0,
    invalidation_pressure: pressure,
    recommended_learning_posture: posture,
    findings: findings({
      includedLedgerCount,
      verdictCounts,
      pressure,
      posture,
      counterEvidenceRefCount,
      authorityGateCounts,
      learningControlCounts,
      verifierStatusCounts,
    }),
    source_node_ids: sourceNodeIds(includedRows),
    source_code_change_allowed: false,
  });
}

export async function scanPromotionQualitySummaryLite(
  store: Pick<LiteWriteStore, "findNodes">,
  args: {
    scope: string;
    actor: string;
    limit?: number;
  },
): Promise<PromotionQualitySummaryV1> {
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

  return buildPromotionQualitySummaryFromRows({ rows, truncated });
}
