import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  PromotionEvidenceLedgerV1Schema,
  type ContractTrust,
  type PromotionEvidenceLedgerV1,
} from "./schemas.js";

type EvidenceKind = PromotionEvidenceLedgerV1["evidence"][number]["evidence_kind"];
type EvidencePolarity = PromotionEvidenceLedgerV1["evidence"][number]["polarity"];

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
  const reasonCodes = uniqueStrings([
    ...(args.reasonCodes ?? []),
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
    source_code_change_allowed: false,
  });
}
