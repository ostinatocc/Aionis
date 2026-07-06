import {
  buildRuntimeAuthorityGate,
  type RuntimeAuthorityGateV1,
} from "./authority-gate.js";
import {
  authorityClaimPaths,
  collectAuthorityClaims,
  type AuthorityWriteNode,
} from "./authority-claims.js";
import { issueRuntimeAuthorityReceiptForNode, type RuntimeAuthorityReceiptV1 } from "./authority-receipt.js";
import { parseExecutionContract, type ExecutionContractV1 } from "./execution-contract.js";
import type { ExecutionEvidenceAssessmentV1, ExecutionEvidenceV1 } from "./execution-evidence.js";
import type { OutcomeContractGate } from "./contract-trust.js";

export const RUNTIME_AUTHORITY_EFFECT_KINDS = [
  "workflow_candidate_projection",
  "stable_workflow_projection",
  "replay_learning_candidate_projection",
  "replay_learning_stable_projection",
  "stable_replay_playbook_anchor",
  "policy_memory_authority",
  "prepared_replay_write_authority",
] as const;

export type RuntimeAuthorityEffectKind = typeof RUNTIME_AUTHORITY_EFFECT_KINDS[number];

export type RuntimeAuthorityEffectBuildResult = {
  effect_kind: RuntimeAuthorityEffectKind;
  authorityGate: RuntimeAuthorityGateV1;
  outcomeContractGate: OutcomeContractGate;
  executionEvidence: ExecutionEvidenceV1 | null;
  executionEvidenceAssessment: ExecutionEvidenceAssessmentV1;
  slotsPatch: Record<string, unknown>;
};

export type RuntimeAuthorityEffectSealResult = {
  effect_kind: RuntimeAuthorityEffectKind;
  slots: Record<string, unknown>;
  authorityGate: RuntimeAuthorityGateV1 | null;
  receipt: RuntimeAuthorityReceiptV1 | null;
  audit: RuntimeAuthorityEffectAuditV1 | null;
  claim_paths: string[];
};

export type RuntimeAuthorityEffectAuditV1 = {
  audit_version: "runtime_authority_effect_audit_v1";
  broker: "authority_effect_broker";
  effect_kind: RuntimeAuthorityEffectKind;
  node: {
    scope: string;
    node_id: string;
    client_id: string | null;
    node_type: string;
  };
  claim_paths: string[];
  receipt: {
    receipt_version: RuntimeAuthorityReceiptV1["receipt_version"];
    key_id: string;
    gate_sha256: string;
    issued_at: string;
  };
  gate: {
    status: RuntimeAuthorityGateV1["status"];
    allows_authoritative: boolean;
    allows_stable_promotion: boolean;
    requested_trust: string | null;
    effective_trust: string | null;
    reasons: string[];
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export function runtimeAuthorityGateFromValue(value: unknown): RuntimeAuthorityGateV1 | null {
  const record = asRecord(value);
  if (record?.gate_version !== "runtime_authority_gate_v1") return null;
  if (typeof record.allows_authoritative !== "boolean") return null;
  if (typeof record.allows_stable_promotion !== "boolean") return null;
  if (record.status !== "sufficient" && record.status !== "insufficient") return null;
  return record as RuntimeAuthorityGateV1;
}

export function runtimeAuthorityRequestedTrustForSlots(slots: Record<string, unknown>): unknown {
  const suppliedGate = runtimeAuthorityGateFromValue(slots.authority_gate_v1);
  return suppliedGate?.requested_trust
    ?? firstString(
      asRecord(slots.execution_contract_v1)?.contract_trust,
      asRecord(slots.execution_native_v1)?.contract_trust,
      asRecord(slots.anchor_v1)?.contract_trust,
      asRecord(slots.policy_contract_v1)?.contract_trust,
      slots.contract_trust,
    );
}

export function computeRuntimeAuthorityGateFromSlots(slots: Record<string, unknown>): RuntimeAuthorityGateV1 {
  const executionContract = parseExecutionContract(slots.execution_contract_v1);
  return buildRuntimeAuthorityGate({
    executionContract,
    requestedTrust: runtimeAuthorityRequestedTrustForSlots(slots),
    slots,
    evidence: asRecord(slots.execution_evidence_v1) ?? undefined,
  }).authorityGate;
}

export function buildRuntimeAuthorityEffect(args: {
  effectKind: RuntimeAuthorityEffectKind;
  executionContract?: ExecutionContractV1 | Record<string, unknown> | null;
  requestedTrust?: unknown;
  slots?: Record<string, unknown> | null;
  metrics?: unknown;
  evidence?: unknown;
}): RuntimeAuthorityEffectBuildResult {
  const {
    authorityGate,
    outcomeContractGate,
    executionEvidence,
    executionEvidenceAssessment,
  } = buildRuntimeAuthorityGate({
    executionContract: args.executionContract,
    requestedTrust: args.requestedTrust,
    slots: args.slots,
    metrics: args.metrics,
    evidence: args.evidence,
  });

  return {
    effect_kind: args.effectKind,
    authorityGate,
    outcomeContractGate,
    executionEvidence,
    executionEvidenceAssessment,
    slotsPatch: {
      outcome_contract_gate: outcomeContractGate,
      ...(executionEvidence ? { execution_evidence_v1: executionEvidence } : {}),
      execution_evidence_assessment: executionEvidenceAssessment,
      authority_gate_v1: authorityGate,
    },
  };
}

export function sealRuntimeAuthorityEffectReceipt(args: {
  effectKind: RuntimeAuthorityEffectKind;
  node: AuthorityWriteNode;
  slots?: Record<string, unknown>;
  authorityGate?: RuntimeAuthorityGateV1 | null;
  issuedAt?: string | null;
  mutate?: boolean;
  requireAuthorityClaims?: boolean;
}): RuntimeAuthorityEffectSealResult {
  const slots = args.mutate === false
    ? { ...(args.slots ?? args.node.slots) }
    : (args.slots ?? args.node.slots);
  const node: AuthorityWriteNode = {
    ...args.node,
    slots,
  };
  const claims = collectAuthorityClaims(node, slots);
  const claimPaths = authorityClaimPaths(claims);
  const requireClaims = args.requireAuthorityClaims === true;
  if (claimPaths.length === 0) {
    if (requireClaims) {
      throw new Error(`authority effect ${args.effectKind} did not declare authority-bearing claim paths`);
    }
    return {
      effect_kind: args.effectKind,
      slots,
      authorityGate: null,
      receipt: null,
      audit: null,
      claim_paths: [],
    };
  }

  const authorityGate = args.authorityGate ?? runtimeAuthorityGateFromValue(slots.authority_gate_v1);
  if (!authorityGate) {
    throw new Error(`authority effect ${args.effectKind} requires authority_gate_v1 before receipt sealing`);
  }
  const receipt = issueRuntimeAuthorityReceiptForNode({
    node,
    slots,
    authorityGate,
    issuedAt: firstString(args.issuedAt) ?? undefined,
  });
  if (!receipt) {
    throw new Error(`authority effect ${args.effectKind} failed to issue authority receipt`);
  }
  const audit: RuntimeAuthorityEffectAuditV1 = {
    audit_version: "runtime_authority_effect_audit_v1",
    broker: "authority_effect_broker",
    effect_kind: args.effectKind,
    node: {
      scope: receipt.subject.scope,
      node_id: receipt.subject.node_id,
      client_id: receipt.subject.client_id,
      node_type: receipt.subject.node_type,
    },
    claim_paths: [...receipt.claim_paths],
    receipt: {
      receipt_version: receipt.receipt_version,
      key_id: receipt.key_id,
      gate_sha256: receipt.gate_sha256,
      issued_at: receipt.issued_at,
    },
    gate: {
      status: authorityGate.status,
      allows_authoritative: authorityGate.allows_authoritative,
      allows_stable_promotion: authorityGate.allows_stable_promotion,
      requested_trust: authorityGate.requested_trust,
      effective_trust: authorityGate.effective_trust,
      reasons: authorityGate.reasons.slice(0, 16),
    },
  };
  slots.authority_receipt_v1 = receipt;
  slots.authority_effect_audit_v1 = audit;
  return {
    effect_kind: args.effectKind,
    slots,
    authorityGate,
    receipt,
    audit,
    claim_paths: claimPaths,
  };
}
