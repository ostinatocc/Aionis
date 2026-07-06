import {
  buildRuntimeAuthorityEffect,
  runtimeAuthorityRequestedTrustForSlots,
  sealRuntimeAuthorityEffectReceipt,
  type RuntimeAuthorityEffectKind,
} from "../../src/memory/authority-effect-broker.ts";
import { collectAuthorityClaims, type AuthorityWriteNode } from "../../src/memory/authority-claims.ts";
import {
  ExecutionContractV1Schema,
  parseExecutionContract,
  type ExecutionContractV1,
} from "../../src/memory/execution-contract.ts";
import { buildExecutionEvidenceFromValidation } from "../../src/memory/execution-evidence.ts";
import { collectAuthorityWriteGuardViolations } from "../../src/memory/authority-write-guard.ts";

export const TEST_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID = "test-authority-receipt-key";
export const TEST_AUTHORITY_RECEIPT_HMAC_SECRET = "test-authority-receipt-secret-32-bytes-minimum";

export const TEST_AUTHORITY_RECEIPT_ENV = {
  AIONIS_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID: TEST_AUTHORITY_RECEIPT_HMAC_ACTIVE_KEY_ID,
  AIONIS_AUTHORITY_RECEIPT_HMAC_SECRET: TEST_AUTHORITY_RECEIPT_HMAC_SECRET,
} as const;

type PreparedAuthorityNode = AuthorityWriteNode & {
  slots: Record<string, unknown>;
};

type PreparedWriteLike = {
  nodes: PreparedAuthorityNode[];
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

function fallbackAuthorityExecutionContract(args: {
  node: AuthorityWriteNode;
  slots: Record<string, unknown>;
}): ExecutionContractV1 {
  const taskSignature = firstString(
    asRecord(args.slots.execution_native_v1)?.task_signature,
    asRecord(args.slots.anchor_v1)?.task_signature,
    args.node.client_id,
    args.node.id,
  ) ?? "authority-fixture";
  const workflowSignature = firstString(
    asRecord(args.slots.execution_native_v1)?.workflow_signature,
    asRecord(args.slots.anchor_v1)?.workflow_signature,
    `workflow:${taskSignature}`,
  ) ?? `workflow:${taskSignature}`;

  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: "authoritative",
    task_family: "task:authority_fixture",
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    policy_memory_id: null,
    selected_tool: null,
    file_path: null,
    target_files: [],
    next_action: "Seed authority-backed test fixture.",
    workflow_steps: ["seed authority fixture", "verify fixture guard receipt"],
    pattern_hints: [],
    service_lifecycle_constraints: [],
    outcome: {
      acceptance_checks: ["authority fixture guard receipt verified"],
      success_invariants: ["all_acceptance_checks_pass"],
      dependency_requirements: [],
      environment_assumptions: [],
      must_hold_after_exit: [],
      external_visibility_requirements: [],
    },
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "authority_fixture_v1",
      source_anchor: taskSignature,
      evidence_refs: ["ci:authority-fixture"],
      notes: ["test fixture contract used only to satisfy runtime authority write guard"],
    },
  });
}

function authorityOutcomeExecutionContract(contract: ExecutionContractV1): ExecutionContractV1 {
  const acceptanceChecks = contract.outcome.acceptance_checks.length > 0
    ? contract.outcome.acceptance_checks
    : ["authority fixture guard receipt verified"];
  const successInvariants = Array.from(new Set([
    ...contract.outcome.success_invariants,
    "all_acceptance_checks_pass",
  ]));
  return ExecutionContractV1Schema.parse({
    ...contract,
    outcome: {
      ...contract.outcome,
      acceptance_checks: acceptanceChecks,
      success_invariants: successInvariants,
    },
  });
}

export function sealAuthorityReceiptsForPreparedWrite(
  prepared: PreparedWriteLike,
  options: {
    effectKind?: RuntimeAuthorityEffectKind;
    issuedAt?: string;
    evidenceRefs?: string[];
  } = {},
): void {
  const effectKind = options.effectKind ?? "stable_workflow_projection";
  const issuedAt = options.issuedAt ?? "2026-07-06T00:00:00.000Z";
  for (const node of prepared.nodes) {
    const slots = asRecord(node.slots);
    if (!slots) continue;
    const claims = collectAuthorityClaims(node, slots);
    if (claims.length === 0) continue;

    const hasAuthoritativeClaim = claims.some((claim) =>
      claim.requirement === "authoritative_trust_requires_passing_authority_gate"
      || claim.requirement === "broad_policy_authority_requires_passing_authority_gate"
    );
    let executionContract = parseExecutionContract(slots.execution_contract_v1);
    if (!executionContract && hasAuthoritativeClaim) {
      executionContract = fallbackAuthorityExecutionContract({ node, slots });
      slots.execution_contract_v1 = executionContract;
    }
    if (executionContract && hasAuthoritativeClaim) {
      executionContract = authorityOutcomeExecutionContract(executionContract);
      slots.execution_contract_v1 = executionContract;
    }

    const evidence = buildExecutionEvidenceFromValidation({
      validationPassed: true,
      afterExitRevalidated: true,
      freshShellProbePassed: true,
      validationBoundary: "external_verifier",
      evidenceRefs: options.evidenceRefs ?? ["ci:authority-fixture:passed"],
    });
    slots.execution_evidence_v1 = evidence;

    const authorityEffect = buildRuntimeAuthorityEffect({
      effectKind,
      executionContract,
      requestedTrust: runtimeAuthorityRequestedTrustForSlots(slots),
      slots,
      evidence,
    });
    Object.assign(slots, authorityEffect.slotsPatch);
    sealRuntimeAuthorityEffectReceipt({
      effectKind,
      node,
      slots,
      authorityGate: authorityEffect.authorityGate,
      issuedAt,
      mutate: true,
      requireAuthorityClaims: true,
    });
    const violations = collectAuthorityWriteGuardViolations([node]);
    if (violations.length > 0) {
      throw new Error(`authority fixture helper produced invalid receipt: ${JSON.stringify(violations)}`);
    }
  }
}
