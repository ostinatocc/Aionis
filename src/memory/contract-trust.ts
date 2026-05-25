import { z } from "zod";

export const ContractTrustSchema = z.enum(["authoritative", "advisory", "observational"]);
export type ContractTrust = z.infer<typeof ContractTrustSchema>;

export const OutcomeContractGateSchema = z.object({
  gate_version: z.literal("outcome_contract_gate_v1"),
  status: z.enum(["sufficient", "insufficient"]),
  allows_authoritative: z.boolean(),
  requested_trust: ContractTrustSchema.nullable(),
  effective_trust: ContractTrustSchema.nullable(),
  reasons: z.array(z.string().min(1).max(128)).max(16),
  requires_service_lifecycle_outcome: z.boolean(),
  decisive_fields: z.object({
    acceptance_check_count: z.number().int().min(0),
    success_invariant_count: z.number().int().min(0),
    meaningful_success_invariant_count: z.number().int().min(0),
    must_hold_after_exit_count: z.number().int().min(0),
    external_visibility_requirement_count: z.number().int().min(0),
    service_lifecycle_constraint_count: z.number().int().min(0),
    durable_service_lifecycle_constraint_count: z.number().int().min(0),
    service_must_survive_agent_exit_count: z.number().int().min(0),
    service_revalidate_from_fresh_shell_count: z.number().int().min(0),
    service_detach_then_probe_count: z.number().int().min(0),
    service_health_check_count: z.number().int().min(0),
  }),
});
export type OutcomeContractGate = z.infer<typeof OutcomeContractGateSchema>;

const CONTRACT_TRUST_RANK: Record<ContractTrust, number> = {
  observational: 0,
  advisory: 1,
  authoritative: 2,
};

const GENERIC_SUCCESS_INVARIANTS = new Set([
  "all_acceptance_checks_pass",
  "target_files_reflect_the_intended_change_surface",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  return value[field] === true;
}

function serviceConstraintRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => !!entry);
}

function isDurableServiceLifecycleConstraint(constraint: Record<string, unknown>): boolean {
  const serviceKind = nonEmptyString(constraint.service_kind) ?? "generic";
  return serviceKind === "http"
    || serviceKind === "tcp"
    || serviceKind === "process"
    || !!nonEmptyString(constraint.endpoint)
    || !!nonEmptyString(constraint.launch_reference);
}

function withAdditionalGateReasons(gate: OutcomeContractGate, reasons: string[]): OutcomeContractGate {
  const mergedReasons = Array.from(new Set([...gate.reasons, ...reasons.filter((reason) => reason.trim().length > 0)]));
  const allowsAuthoritative = gate.allows_authoritative && mergedReasons.length === gate.reasons.length;
  return OutcomeContractGateSchema.parse({
    ...gate,
    status: allowsAuthoritative ? gate.status : "insufficient",
    allows_authoritative: allowsAuthoritative,
    effective_trust: gate.requested_trust === "authoritative"
      ? allowsAuthoritative
        ? "authoritative"
        : "advisory"
      : gate.effective_trust,
    reasons: mergedReasons,
  });
}

export function normalizeContractTrust(value: unknown): ContractTrust | null {
  const parsed = ContractTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function minContractTrust(a: ContractTrust, b: ContractTrust): ContractTrust {
  return CONTRACT_TRUST_RANK[a] <= CONTRACT_TRUST_RANK[b] ? a : b;
}

export function buildOutcomeContractGate(args: {
  executionContract?: unknown;
  requestedTrust?: unknown;
}): OutcomeContractGate {
  const contract = args.executionContract;
  const parsedContract = asRecord(contract);
  const outcome = asRecord(parsedContract?.outcome);
  const acceptanceChecks = stringList(outcome?.acceptance_checks ?? parsedContract?.acceptance_checks);
  const successInvariants = stringList(outcome?.success_invariants ?? parsedContract?.success_invariants);
  const mustHoldAfterExit = stringList(outcome?.must_hold_after_exit ?? parsedContract?.must_hold_after_exit);
  const externalVisibilityRequirements = stringList(
    outcome?.external_visibility_requirements ?? parsedContract?.external_visibility_requirements,
  );
  const serviceLifecycleConstraints = serviceConstraintRecords(parsedContract?.service_lifecycle_constraints);
  const durableServiceLifecycleConstraints = serviceLifecycleConstraints.filter(isDurableServiceLifecycleConstraint);
  const serviceMustSurviveCount = durableServiceLifecycleConstraints
    .filter((constraint) => booleanField(constraint, "must_survive_agent_exit"))
    .length;
  const serviceFreshShellCount = durableServiceLifecycleConstraints
    .filter((constraint) => booleanField(constraint, "revalidate_from_fresh_shell"))
    .length;
  const serviceDetachThenProbeCount = durableServiceLifecycleConstraints
    .filter((constraint) => booleanField(constraint, "detach_then_probe"))
    .length;
  const serviceHealthCheckCount = durableServiceLifecycleConstraints
    .reduce((sum, constraint) => sum + stringList(constraint.health_checks).length, 0);

  const meaningfulSuccessInvariantCount = successInvariants.filter(
    (invariant) => !GENERIC_SUCCESS_INVARIANTS.has(invariant),
  ).length;
  const hasMeaningfulSuccessInvariant = meaningfulSuccessInvariantCount > 0;
  const acceptanceChecksBindSuccess =
    acceptanceChecks.length > 0
    && successInvariants.includes("all_acceptance_checks_pass");
  const hasVerifiableOutcome =
    hasMeaningfulSuccessInvariant
    || acceptanceChecksBindSuccess
    || (mustHoldAfterExit.length > 0 && externalVisibilityRequirements.length > 0);

  const requiresServiceLifecycleOutcome = durableServiceLifecycleConstraints.length > 0;
  const reasons: string[] = [];
  if (!hasVerifiableOutcome) reasons.push("missing_verifiable_success_outcome");
  if (requiresServiceLifecycleOutcome && mustHoldAfterExit.length === 0) {
    reasons.push("missing_must_hold_after_exit");
  }
  if (requiresServiceLifecycleOutcome && externalVisibilityRequirements.length === 0) {
    reasons.push("missing_external_visibility_requirements");
  }
  if (
    requiresServiceLifecycleOutcome
    && serviceMustSurviveCount < durableServiceLifecycleConstraints.length
  ) {
    reasons.push("missing_service_must_survive_agent_exit");
  }
  if (
    requiresServiceLifecycleOutcome
    && serviceFreshShellCount < durableServiceLifecycleConstraints.length
  ) {
    reasons.push("missing_service_revalidate_from_fresh_shell");
  }
  if (
    requiresServiceLifecycleOutcome
    && serviceDetachThenProbeCount < durableServiceLifecycleConstraints.length
  ) {
    reasons.push("missing_service_detach_then_probe");
  }
  if (requiresServiceLifecycleOutcome && serviceHealthCheckCount === 0) {
    reasons.push("missing_service_health_check");
  }
  const requestedTrust = normalizeContractTrust(args.requestedTrust ?? parsedContract?.contract_trust);
  const allowsAuthoritative = requestedTrust === "authoritative" && reasons.length === 0;

  return OutcomeContractGateSchema.parse({
    gate_version: "outcome_contract_gate_v1",
    status: reasons.length === 0 ? "sufficient" : "insufficient",
    allows_authoritative: allowsAuthoritative,
    requested_trust: requestedTrust,
    effective_trust: requestedTrust === "authoritative"
      ? allowsAuthoritative
        ? "authoritative"
        : "advisory"
      : requestedTrust,
    reasons,
    requires_service_lifecycle_outcome: requiresServiceLifecycleOutcome,
    decisive_fields: {
      acceptance_check_count: acceptanceChecks.length,
      success_invariant_count: successInvariants.length,
      meaningful_success_invariant_count: meaningfulSuccessInvariantCount,
      must_hold_after_exit_count: mustHoldAfterExit.length,
      external_visibility_requirement_count: externalVisibilityRequirements.length,
      service_lifecycle_constraint_count: serviceLifecycleConstraints.length,
      durable_service_lifecycle_constraint_count: durableServiceLifecycleConstraints.length,
      service_must_survive_agent_exit_count: serviceMustSurviveCount,
      service_revalidate_from_fresh_shell_count: serviceFreshShellCount,
      service_detach_then_probe_count: serviceDetachThenProbeCount,
      service_health_check_count: serviceHealthCheckCount,
    },
  });
}

export function evaluateAuthoritativeOutcomeContract(contract: unknown): {
  ok: boolean;
  reasons: string[];
  requires_service_lifecycle_outcome: boolean;
} {
  const gate = buildOutcomeContractGate({ executionContract: contract, requestedTrust: "authoritative" });
  return {
    ok: gate.status === "sufficient",
    reasons: gate.reasons,
    requires_service_lifecycle_outcome: gate.requires_service_lifecycle_outcome,
  };
}

export function hasAuthoritativeOutcomeSignal(contract: unknown): boolean {
  return evaluateAuthoritativeOutcomeContract(contract).ok;
}

export function explainContractTrustForSteering(args: {
  computedTrust: ContractTrust;
  explicitTrust?: ContractTrust | null;
  executionContract?: unknown;
}): {
  contract_trust: ContractTrust;
  outcome_contract_gate: OutcomeContractGate;
} {
  const explicitTrust = normalizeContractTrust(args.explicitTrust);
  const candidate = explicitTrust
    ? minContractTrust(explicitTrust, args.computedTrust)
    : args.computedTrust;
  let gate = buildOutcomeContractGate({
    executionContract: args.executionContract,
    requestedTrust: explicitTrust ?? candidate,
  });

  if (candidate !== "authoritative") {
    return {
      contract_trust: candidate,
      outcome_contract_gate: gate,
    };
  }

  if (explicitTrust !== "authoritative") {
    gate = withAdditionalGateReasons(gate, ["missing_explicit_authoritative_trust"]);
    return {
      contract_trust: "advisory",
      outcome_contract_gate: gate,
    };
  }
  if (!gate.allows_authoritative) {
    return {
      contract_trust: "advisory",
      outcome_contract_gate: gate,
    };
  }
  return {
    contract_trust: "authoritative",
    outcome_contract_gate: gate,
  };
}

export function resolveContractTrustForSteering(args: {
  computedTrust: ContractTrust;
  explicitTrust?: ContractTrust | null;
  executionContract?: unknown;
}): ContractTrust {
  return explainContractTrustForSteering(args).contract_trust;
}
