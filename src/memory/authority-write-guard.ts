import stableStringify from "fast-json-stable-stringify";
import { badRequest } from "../util/http.js";
import type { RuntimeAuthorityGateV1 } from "./authority-gate.js";
import {
  collectAuthorityClaims,
  type AuthorityClaim,
  type AuthorityWriteNode,
} from "./authority-claims.js";
import {
  computeRuntimeAuthorityGateFromSlots,
  runtimeAuthorityGateFromValue,
} from "./authority-effect-broker.js";
import { verifyRuntimeAuthorityReceiptForNode } from "./authority-receipt.js";

export type AuthorityWriteGuardViolation = {
  node_id: string;
  client_id: string | null;
  node_type: string;
  path: string;
  requirement:
    | "authoritative_trust_requires_passing_authority_gate"
    | "stable_promotion_requires_passing_authority_gate"
    | "broad_policy_authority_requires_passing_authority_gate";
  reason:
    | "missing_authority_gate_receipt"
    | "invalid_authority_gate_receipt"
    | "missing_authority_receipt"
    | "invalid_authority_receipt"
    | "unknown_authority_receipt_key"
    | "authority_receipt_mismatch"
    | "authority_gate_receipt_mismatch"
    | "authority_gate_blocks_claim";
  requested_value: string | null;
  computed: {
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

function gateReceiptMatchesComputed(
  supplied: RuntimeAuthorityGateV1,
  computed: RuntimeAuthorityGateV1,
): boolean {
  return stableStringify(supplied) === stableStringify(computed);
}

function claimAllowed(claim: AuthorityClaim, gate: RuntimeAuthorityGateV1): boolean {
  if (claim.requirement === "stable_promotion_requires_passing_authority_gate") {
    return gate.allows_stable_promotion;
  }
  return gate.allows_authoritative;
}

function violationForClaim(args: {
  node: AuthorityWriteNode;
  claim: AuthorityClaim;
  reason: AuthorityWriteGuardViolation["reason"];
  computed: RuntimeAuthorityGateV1;
}): AuthorityWriteGuardViolation {
  return {
    node_id: args.node.id,
    client_id: args.node.client_id ?? null,
    node_type: args.node.type,
    path: args.claim.path,
    requirement: args.claim.requirement,
    reason: args.reason,
    requested_value: args.claim.requestedValue,
    computed: {
      allows_authoritative: args.computed.allows_authoritative,
      allows_stable_promotion: args.computed.allows_stable_promotion,
      requested_trust: args.computed.requested_trust,
      effective_trust: args.computed.effective_trust,
      reasons: args.computed.reasons.slice(0, 16),
    },
  };
}

export function collectAuthorityWriteGuardViolations(nodes: AuthorityWriteNode[]): AuthorityWriteGuardViolation[] {
  const violations: AuthorityWriteGuardViolation[] = [];
  for (const node of nodes) {
    const slots = asRecord(node.slots) ?? {};
    const claims = collectAuthorityClaims(node, slots);
    if (claims.length === 0) continue;

    const computed = computeRuntimeAuthorityGateFromSlots(slots);
    const suppliedGateRaw = asRecord(slots.authority_gate_v1);
    const suppliedGate = runtimeAuthorityGateFromValue(slots.authority_gate_v1);
    for (const claim of claims) {
      if (!suppliedGateRaw) {
        violations.push(violationForClaim({ node, claim, reason: "missing_authority_gate_receipt", computed }));
        continue;
      }
      if (!suppliedGate) {
        violations.push(violationForClaim({ node, claim, reason: "invalid_authority_gate_receipt", computed }));
        continue;
      }
      const receipt = verifyRuntimeAuthorityReceiptForNode({
        node,
        slots,
        authorityGate: suppliedGate,
      });
      if (!receipt.ok) {
        violations.push(violationForClaim({ node, claim, reason: receipt.reason, computed }));
        continue;
      }
      if (!gateReceiptMatchesComputed(suppliedGate, computed)) {
        violations.push(violationForClaim({ node, claim, reason: "authority_gate_receipt_mismatch", computed }));
        continue;
      }
      if (!claimAllowed(claim, computed)) {
        violations.push(violationForClaim({ node, claim, reason: "authority_gate_blocks_claim", computed }));
      }
    }
  }
  return violations;
}

export function assertAuthorityWriteReceipts(nodes: AuthorityWriteNode[]): void {
  const violations = collectAuthorityWriteGuardViolations(nodes);
  if (violations.length === 0) return;
  badRequest(
    "authority_receipt_required",
    "authority-bearing memory writes require a matching passing runtime authority gate receipt",
    {
      contract: "runtime_authority_write_guard_v1",
      violation_count: violations.length,
      violations: violations.slice(0, 20),
    },
  );
}
