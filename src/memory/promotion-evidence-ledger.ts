import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  PromotionEvidenceLedgerV1Schema,
  type ContractTrust,
  type PromotionEvidenceLedgerV1,
} from "./schemas.js";

type EvidenceKind = PromotionEvidenceLedgerV1["evidence"][number]["evidence_kind"];
type EvidencePolarity = PromotionEvidenceLedgerV1["evidence"][number]["polarity"];
type PromotionProtocol = PromotionEvidenceLedgerV1["promotion_protocol"];
type PromotionScope = PromotionProtocol["source_scope"];
type PromotionCandidateProducer = PromotionProtocol["candidate_producer"];
type PromotionGateState = PromotionProtocol["leakage_gate"];

function uniqueStrings(values: Array<string | null | undefined>, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed.slice(0, 256));
    if (out.length >= limit) break;
  }
  return out;
}

function intCount(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function ledgerId(args: {
  targetKind: string;
  targetId: string | null;
  transition: string;
  verdict: string;
  promotionState: string;
  sourceNodeIds: string[];
  sourceRunIds: string[];
  promotionEvidenceRefs: string[];
  counterEvidenceRefs: string[];
}): string {
  return `pel:${sha256Hex(stableStringify(args)).slice(0, 24)}`;
}

function resolveGateState(args: {
  supplied?: PromotionGateState | null;
  positiveCount?: number;
  negativeCount?: number;
  defaultState?: PromotionGateState;
}): PromotionGateState {
  if (args.supplied) return args.supplied;
  if (intCount(args.negativeCount) > 0) return "failed";
  if (intCount(args.positiveCount) > 0) return "passed";
  return args.defaultState ?? "pending";
}

function buildPromotionProtocol(args: {
  verdict: PromotionEvidenceLedgerV1["verdict"];
  sourceRunIds: string[];
  observedCount: number;
  promotionProtocol?: Partial<PromotionProtocol> | null;
}): PromotionProtocol {
  const supplied = args.promotionProtocol ?? {};
  const providerProtocolContaminationCount = intCount(supplied.provider_protocol_contamination_count);
  const taskSpecificSignalCount = intCount(supplied.task_specific_signal_count);
  const regressionEvidenceCount = intCount(supplied.regression_evidence_count);
  const negativeTransferCount = intCount(supplied.negative_transfer_count);
  const holdoutEvidenceCount = intCount(supplied.holdout_evidence_count);
  const promotedItemCount = intCount(supplied.promoted_item_count);
  const coveredTaskCount = intCount(supplied.covered_task_count);
  const promotionGrowthRatio = supplied.promotion_growth_ratio ?? ratio(promotedItemCount, coveredTaskCount);
  const leakageGate = resolveGateState({
    supplied: supplied.leakage_gate,
    negativeCount: providerProtocolContaminationCount + taskSpecificSignalCount,
    defaultState: "pending",
  });
  const holdoutGate = resolveGateState({
    supplied: supplied.holdout_gate,
    positiveCount: holdoutEvidenceCount,
    defaultState: "pending",
  });
  const interferenceGate = resolveGateState({
    supplied: supplied.interference_gate,
    negativeCount: regressionEvidenceCount + negativeTransferCount,
    defaultState: "pending",
  });
  const growthGate: PromotionGateState = supplied.growth_gate
    ?? (promotionGrowthRatio === null
      ? "not_applicable"
      : promotionGrowthRatio < 1
        ? "passed"
        : "failed");
  const localReuseAllowed = supplied.local_reuse_allowed ?? args.verdict === "promotion_admitted";
  const requestedWider = supplied.wider_generalization_allowed === true;
  const widerGeneralizationAllowed =
    requestedWider
    && localReuseAllowed
    && leakageGate === "passed"
    && holdoutGate === "passed"
    && interferenceGate === "passed"
    && (growthGate === "passed" || growthGate === "not_applicable");
  const sourceScope = supplied.source_scope ?? "exact_task";
  const authorityScope = widerGeneralizationAllowed
    ? supplied.authority_scope ?? sourceScope
    : sourceScope;
  const reasonCodes = uniqueStrings([
    ...(supplied.reason_codes ?? []),
    localReuseAllowed ? "local_reuse_allowed" : "local_reuse_blocked",
    widerGeneralizationAllowed ? "wider_generalization_allowed" : "wider_generalization_not_proven",
    `leakage_gate_${leakageGate}`,
    `holdout_gate_${holdoutGate}`,
    `interference_gate_${interferenceGate}`,
    `growth_gate_${growthGate}`,
    providerProtocolContaminationCount > 0 ? "provider_protocol_contamination_present" : null,
    taskSpecificSignalCount > 0 ? "task_specific_signal_present" : null,
    regressionEvidenceCount > 0 ? "regression_evidence_present" : null,
    negativeTransferCount > 0 ? "negative_transfer_present" : null,
  ], 32);

  return {
    protocol_version: "promotion_evidence_protocol_v1",
    candidate_producer: (supplied.candidate_producer ?? "runtime_history") as PromotionCandidateProducer,
    source_scope: sourceScope as PromotionScope,
    authority_scope: authorityScope as PromotionScope,
    local_reuse_allowed: localReuseAllowed,
    wider_generalization_allowed: widerGeneralizationAllowed,
    source_code_change_allowed: false,
    distinct_run_count: intCount(supplied.distinct_run_count ?? args.sourceRunIds.length),
    distinct_task_count: intCount(supplied.distinct_task_count),
    holdout_evidence_count: holdoutEvidenceCount,
    regression_evidence_count: regressionEvidenceCount,
    negative_transfer_count: negativeTransferCount,
    provider_protocol_contamination_count: providerProtocolContaminationCount,
    task_specific_signal_count: taskSpecificSignalCount,
    promoted_item_count: promotedItemCount,
    covered_task_count: coveredTaskCount,
    promotion_growth_ratio: promotionGrowthRatio,
    leakage_gate: leakageGate,
    holdout_gate: holdoutGate,
    interference_gate: interferenceGate,
    growth_gate: growthGate,
    reason_codes: reasonCodes,
  };
}

export function buildPromotionEvidenceLedgerV1(args: {
  targetKind: PromotionEvidenceLedgerV1["target_kind"];
  targetId?: string | null;
  sourceLayers: PromotionEvidenceLedgerV1["source_layers"];
  targetLayer: PromotionEvidenceLedgerV1["target_layer"];
  transition: PromotionEvidenceLedgerV1["transition"];
  promotionState: string;
  promotionOrigin?: string | null;
  observedCount?: number | null;
  requiredCount?: number | null;
  authorityGateAdmitted?: boolean | null;
  learningControlAdmitted?: boolean | null;
  verifierStatus?: PromotionEvidenceLedgerV1["verifier_status"];
  contractTrust?: ContractTrust | null;
  sourceNodeIds?: Array<string | null | undefined>;
  sourceRunIds?: Array<string | null | undefined>;
  sourceCommitIds?: Array<string | null | undefined>;
  promotionEvidenceRefs?: Array<string | null | undefined>;
  counterEvidenceRefs?: Array<string | null | undefined>;
  reasonCodes?: Array<string | null | undefined>;
  promotionProtocol?: Partial<PromotionProtocol> | null;
  evidence?: Array<{
    evidence_id: string;
    evidence_kind: EvidenceKind;
    polarity: EvidencePolarity;
    source_ref: string;
    claim: string;
    confidence: number;
  }>;
}): PromotionEvidenceLedgerV1 {
  const promotionEvidenceRefs = uniqueStrings(args.promotionEvidenceRefs ?? [], 64);
  const counterEvidenceRefs = uniqueStrings(args.counterEvidenceRefs ?? [], 64);
  const sourceNodeIds = uniqueStrings(args.sourceNodeIds ?? [], 64);
  const sourceRunIds = uniqueStrings(args.sourceRunIds ?? [], 64);
  const sourceCommitIds = uniqueStrings(args.sourceCommitIds ?? [], 64);
  const observedCount = intCount(args.observedCount);
  const requiredCount = intCount(args.requiredCount);
  const evidence = (args.evidence ?? []).map((entry) => ({
    ...entry,
    source_ref: entry.source_ref.slice(0, 256),
    claim: entry.claim.slice(0, 256),
    confidence: Math.max(0, Math.min(1, Number(entry.confidence))),
  }));
  const authorityBlocked = args.authorityGateAdmitted === false || args.learningControlAdmitted === false;
  const verifierBlocked = args.verifierStatus === "failed" || args.verifierStatus === "incomplete";
  const enoughObservations = requiredCount === 0 || observedCount >= requiredCount;
  const evidenceGateSatisfied = enoughObservations || args.learningControlAdmitted === true;
  const verdict: PromotionEvidenceLedgerV1["verdict"] =
    counterEvidenceRefs.length > 0 || args.promotionState === "contested"
      ? "contested"
      : args.promotionState === "candidate" || !evidenceGateSatisfied
        ? "candidate_only"
        : authorityBlocked || verifierBlocked
          ? "promotion_blocked"
          : "promotion_admitted";
  const promotionProtocol = buildPromotionProtocol({
    verdict,
    sourceRunIds,
    observedCount,
    promotionProtocol: args.promotionProtocol,
  });
  const reasonCodes = uniqueStrings([
    ...(args.reasonCodes ?? []),
    ...promotionProtocol.reason_codes,
    enoughObservations ? "observation_gate_satisfied" : "observation_gate_pending",
    args.authorityGateAdmitted === true ? "authority_gate_admitted" : args.authorityGateAdmitted === false ? "authority_gate_blocked" : null,
    args.learningControlAdmitted === true ? "learning_control_admitted" : args.learningControlAdmitted === false ? "learning_control_blocked" : null,
    args.verifierStatus ? `verifier_${args.verifierStatus}` : null,
    verdict,
  ], 32);

  return PromotionEvidenceLedgerV1Schema.parse({
    ledger_version: "promotion_evidence_ledger_v1",
    ledger_id: ledgerId({
      targetKind: args.targetKind,
      targetId: args.targetId ?? null,
      transition: args.transition,
      verdict,
      promotionState: args.promotionState,
      sourceNodeIds,
      sourceRunIds,
      promotionEvidenceRefs,
      counterEvidenceRefs,
    }),
    target_kind: args.targetKind,
    target_id: args.targetId ?? null,
    source_layers: args.sourceLayers,
    target_layer: args.targetLayer,
    transition: args.transition,
    verdict,
    promotion_state: args.promotionState,
    promotion_origin: args.promotionOrigin ?? null,
    observed_count: observedCount,
    required_count: requiredCount,
    authority_gate_admitted: args.authorityGateAdmitted ?? null,
    learning_control_admitted: args.learningControlAdmitted ?? null,
    verifier_status: args.verifierStatus ?? null,
    contract_trust: args.contractTrust ?? null,
    evidence,
    promotion_evidence_refs: promotionEvidenceRefs,
    counter_evidence_refs: counterEvidenceRefs,
    source_node_ids: sourceNodeIds,
    source_run_ids: sourceRunIds,
    source_commit_ids: sourceCommitIds,
    reason_codes: reasonCodes,
    promotion_protocol: promotionProtocol,
    source_code_change_allowed: false,
  });
}
