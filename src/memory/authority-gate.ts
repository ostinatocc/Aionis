import {
  buildOutcomeContractGate,
  normalizeContractTrust,
  type ContractTrust,
  type OutcomeContractGate,
} from "./contract-trust.js";
import {
  assessExecutionEvidence,
  extractExecutionEvidenceFromSlots,
  type ExecutionEvidenceAssessmentV1,
  type ExecutionEvidenceV1,
} from "./execution-evidence.js";
import type { ExecutionContractV1 } from "./execution-contract.js";

export type RuntimeAuthorityGateV1 = {
  gate_version: "runtime_authority_gate_v1";
  status: "sufficient" | "insufficient";
  allows_authoritative: boolean;
  allows_stable_promotion: boolean;
  requested_trust: ContractTrust | null;
  effective_trust: ContractTrust | null;
  reasons: string[];
  outcome_contract_gate: OutcomeContractGate;
  execution_evidence_assessment: ExecutionEvidenceAssessmentV1;
};

export function buildRuntimeAuthorityGate(args: {
  executionContract?: ExecutionContractV1 | Record<string, unknown> | null;
  requestedTrust?: unknown;
  slots?: Record<string, unknown> | null;
  metrics?: unknown;
  evidence?: unknown;
}): {
  authorityGate: RuntimeAuthorityGateV1;
  outcomeContractGate: OutcomeContractGate;
  executionEvidence: ExecutionEvidenceV1 | null;
  executionEvidenceAssessment: ExecutionEvidenceAssessmentV1;
} {
  const requestedTrust = normalizeContractTrust(args.requestedTrust ?? args.executionContract?.contract_trust);
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract: args.executionContract,
    requestedTrust,
  });
  const executionEvidence =
    (args.evidence as ExecutionEvidenceV1 | null | undefined)
    ?? extractExecutionEvidenceFromSlots({
      slots: args.slots,
      metrics: args.metrics,
    });
  const executionEvidenceAssessment = assessExecutionEvidence({
    executionContract: args.executionContract as ExecutionContractV1 | null | undefined,
    evidence: executionEvidence,
    requestedTrust,
  });
  const reasons = Array.from(new Set([
    ...outcomeContractGate.reasons.map((reason) => `outcome_contract:${reason}`),
    ...executionEvidenceAssessment.reasons.map((reason) => `execution_evidence:${reason}`),
  ])).slice(0, 16);
  const allowsAuthoritative =
    requestedTrust === "authoritative"
    && outcomeContractGate.allows_authoritative
    && executionEvidenceAssessment.allows_authoritative;
  const allowsStablePromotion =
    executionEvidenceAssessment.allows_stable_promotion
    && (
      requestedTrust !== "authoritative"
      || outcomeContractGate.allows_authoritative
    );
  const effectiveTrust = requestedTrust === "authoritative" && !allowsAuthoritative
    ? "advisory"
    : requestedTrust;

  return {
    authorityGate: {
      gate_version: "runtime_authority_gate_v1",
      status: reasons.length === 0 ? "sufficient" : "insufficient",
      allows_authoritative: allowsAuthoritative,
      allows_stable_promotion: allowsStablePromotion,
      requested_trust: requestedTrust,
      effective_trust: effectiveTrust,
      reasons,
      outcome_contract_gate: outcomeContractGate,
      execution_evidence_assessment: executionEvidenceAssessment,
    },
    outcomeContractGate,
    executionEvidence,
    executionEvidenceAssessment,
  };
}

export function downgradeAuthoritativeTrust(args: {
  requestedTrust?: ContractTrust | null;
  authorityGate: RuntimeAuthorityGateV1;
}): ContractTrust | null {
  if (args.requestedTrust === "authoritative" && !args.authorityGate.allows_authoritative) {
    return args.authorityGate.effective_trust ?? "advisory";
  }
  return args.requestedTrust ?? null;
}
