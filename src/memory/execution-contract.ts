import { z } from "zod";
import {
  ServiceLifecycleConstraintV1Schema,
  type ServiceLifecycleConstraintV1,
} from "../execution/types.js";
import { ContractTrustSchema, type ContractTrust } from "./contract-trust.js";
import { type TrajectoryCompileResponse } from "./schemas.js";

const NullableString = z.string().trim().min(1).nullable().default(null);
const ContractList = z.array(z.string().trim().min(1)).max(64).default([]);
const OutcomeList = z.array(z.string().trim().min(1)).max(24).default([]);
const EvidenceList = z.array(z.string().trim().min(1)).max(16).default([]);

export const ExecutionContractOutcomeV1Schema = z.object({
  acceptance_checks: OutcomeList,
  success_invariants: OutcomeList,
  dependency_requirements: OutcomeList,
  environment_assumptions: OutcomeList,
  must_hold_after_exit: OutcomeList,
  external_visibility_requirements: OutcomeList,
});
export type ExecutionContractOutcomeV1 = z.infer<typeof ExecutionContractOutcomeV1Schema>;

export const ExecutionContractProvenanceKindSchema = z.enum([
  "trajectory_compile",
  "handoff_store",
  "action_retrieval",
  "policy_contract",
  "derived_policy",
  "write_distillation",
  "pattern_anchor_write",
  "workflow_projection",
  "replay_compile_from_run",
  "slot_projection",
  "manual_context",
]);
export type ExecutionContractProvenanceKind = z.infer<typeof ExecutionContractProvenanceKindSchema>;

export const ExecutionContractProvenanceV1Schema = z.object({
  source_kind: ExecutionContractProvenanceKindSchema,
  source_summary_version: NullableString,
  source_anchor: NullableString,
  evidence_refs: EvidenceList,
  notes: EvidenceList,
});
export type ExecutionContractProvenanceV1 = z.infer<typeof ExecutionContractProvenanceV1Schema>;

export const ExecutionContractV1Schema = z.object({
  schema_version: z.literal("execution_contract_v1"),
  contract_trust: ContractTrustSchema.nullable().default(null),
  task_family: NullableString,
  task_signature: NullableString,
  workflow_signature: NullableString,
  policy_memory_id: NullableString,
  selected_tool: NullableString,
  file_path: NullableString,
  target_files: ContractList,
  next_action: NullableString,
  workflow_steps: ContractList,
  pattern_hints: ContractList,
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).default([]),
  outcome: ExecutionContractOutcomeV1Schema,
  provenance: ExecutionContractProvenanceV1Schema,
});
export type ExecutionContractV1 = z.infer<typeof ExecutionContractV1Schema>;

type ExecutionContractMergePreference = "existing" | "incoming";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeContractTrust(value: unknown): ContractTrust | null {
  const parsed = ContractTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function stringList(value: unknown, limit = 64): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.map((entry) => (typeof entry === "string" ? entry : null)), limit)
    : [];
}

function uniqueLifecycleConstraints(values: unknown[], limit = 16): ServiceLifecycleConstraintV1[] {
  const out: ServiceLifecycleConstraintV1[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const parsed = ServiceLifecycleConstraintV1Schema.safeParse(value);
    if (!parsed.success) continue;
    const key = [
      parsed.data.service_kind,
      parsed.data.label,
      parsed.data.endpoint ?? "",
      parsed.data.launch_reference ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeStringField(
  existing: unknown,
  incoming: unknown,
  preference: ExecutionContractMergePreference,
): string | null {
  return preference === "incoming"
    ? toStringOrNull(incoming) ?? toStringOrNull(existing)
    : toStringOrNull(existing) ?? toStringOrNull(incoming);
}

function mergeStringListField(
  existing: unknown,
  incoming: unknown,
  preference: ExecutionContractMergePreference,
  limit = 64,
): string[] {
  const existingList = stringList(existing, limit);
  const incomingList = stringList(incoming, limit);
  return preference === "incoming"
    ? uniqueStrings([...incomingList, ...existingList], limit)
    : uniqueStrings([...existingList, ...incomingList], limit);
}

function mergeLifecycleField(
  existing: unknown,
  incoming: unknown,
  preference: ExecutionContractMergePreference,
  limit = 16,
): ServiceLifecycleConstraintV1[] {
  const existingList = Array.isArray(existing) ? existing : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];
  return preference === "incoming"
    ? uniqueLifecycleConstraints([...incomingList, ...existingList], limit)
    : uniqueLifecycleConstraints([...existingList, ...incomingList], limit);
}

function deriveSuccessInvariants(args: {
  targetFiles: string[];
  acceptanceChecks: string[];
  serviceLifecycleConstraints: ServiceLifecycleConstraintV1[];
}): string[] {
  const out: Array<string | null> = [];
  if (args.targetFiles.length > 0) out.push("target_files_reflect_the_intended_change_surface");
  if (args.acceptanceChecks.length > 0) out.push("all_acceptance_checks_pass");
  for (const constraint of args.serviceLifecycleConstraints) {
    if (constraint.endpoint) {
      out.push(`service_endpoint_reachable:${constraint.endpoint}`);
    }
  }
  return uniqueStrings(out, 24);
}

function deriveMustHoldAfterExit(serviceLifecycleConstraints: ServiceLifecycleConstraintV1[]): string[] {
  return uniqueStrings(
    serviceLifecycleConstraints.flatMap((constraint) => {
      if (!constraint.must_survive_agent_exit) return [];
      return [
        `service_survives_agent_exit:${constraint.label}`,
        constraint.endpoint ? `service_endpoint_still_serves_after_exit:${constraint.endpoint}` : null,
      ];
    }),
    24,
  );
}

function deriveExternalVisibilityRequirements(serviceLifecycleConstraints: ServiceLifecycleConstraintV1[]): string[] {
  return uniqueStrings(
    serviceLifecycleConstraints.flatMap((constraint) => [
      constraint.endpoint ? `endpoint_reachable:${constraint.endpoint}` : null,
      ...constraint.health_checks.map((check) => `health_check:${check}`),
    ]),
    24,
  );
}

function deriveOutcomeFromInputs(args: {
  acceptanceChecks: string[];
  targetFiles: string[];
  serviceLifecycleConstraints: ServiceLifecycleConstraintV1[];
  environmentAssumptions?: string[];
  dependencyRequirements?: string[];
}): ExecutionContractOutcomeV1 {
  return ExecutionContractOutcomeV1Schema.parse({
    acceptance_checks: args.acceptanceChecks,
    success_invariants: deriveSuccessInvariants(args),
    dependency_requirements: args.dependencyRequirements ?? [],
    environment_assumptions: args.environmentAssumptions ?? [],
    must_hold_after_exit: deriveMustHoldAfterExit(args.serviceLifecycleConstraints),
    external_visibility_requirements: deriveExternalVisibilityRequirements(args.serviceLifecycleConstraints),
  });
}

export function parseExecutionContract(value: unknown): ExecutionContractV1 | null {
  const parsed = ExecutionContractV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asObject(value);
    if (record) return record;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = toStringOrNull(value);
    if (next) return next;
  }
  return null;
}

function firstContractTrust(...values: unknown[]): ContractTrust | null {
  for (const value of values) {
    const trust = normalizeContractTrust(value);
    if (trust) return trust;
  }
  return null;
}

function firstNonEmptyStringList(limit: number, ...values: unknown[]): string[] {
  for (const value of values) {
    const next = stringList(value, limit);
    if (next.length > 0) return next;
  }
  return [];
}

function firstLifecycleConstraintList(limit: number, ...values: unknown[]): ServiceLifecycleConstraintV1[] {
  for (const value of values) {
    const next = uniqueLifecycleConstraints(Array.isArray(value) ? value : [], limit);
    if (next.length > 0) return next;
  }
  return [];
}

function hasExecutionContractSignal(contract: ExecutionContractV1 | null): boolean {
  if (!contract) return false;
  return Boolean(
    contract.contract_trust
    || contract.task_family
    || contract.task_signature
    || contract.workflow_signature
    || contract.policy_memory_id
    || contract.selected_tool
    || contract.file_path
    || contract.next_action
    || contract.target_files.length > 0
    || contract.workflow_steps.length > 0
    || contract.pattern_hints.length > 0
    || contract.service_lifecycle_constraints.length > 0
    || contract.outcome.acceptance_checks.length > 0
    || contract.outcome.success_invariants.length > 0
    || contract.outcome.dependency_requirements.length > 0
    || contract.outcome.environment_assumptions.length > 0
    || contract.outcome.must_hold_after_exit.length > 0
    || contract.outcome.external_visibility_requirements.length > 0
  );
}

export function hasExecutionContractSurfaceSignal(slots: Record<string, unknown> | null): boolean {
  if (!slots) return false;
  const executionResultSummary = asObject(slots.execution_result_summary);
  return Boolean(
    parseExecutionContract(slots.execution_contract_v1)
    || asObject(slots.recovery_contract_v1)
    || asObject(slots.policy_contract_v1)
    || asObject(slots.policy_contract)
    || asObject(slots.derived_policy_v1)
    || asObject(slots.execution_native_v1)
    || asObject(slots.anchor_v1)
    || asObject(executionResultSummary?.trajectory_compile_v1)
    || firstNonEmptyString(
      slots.task_signature,
      slots.workflow_signature,
      slots.selected_tool,
      slots.file_path,
      slots.next_action,
      slots.contract_trust,
    )
    || stringList(slots.target_files, 24).length > 0
    || stringList(slots.acceptance_checks, 24).length > 0
    || stringList(slots.workflow_steps, 24).length > 0
    || stringList(slots.pattern_hints, 24).length > 0
    || (Array.isArray(slots.service_lifecycle_constraints) && slots.service_lifecycle_constraints.length > 0)
  );
}

export function deriveExecutionContractFromSlots(args: {
  slots: Record<string, unknown> | null;
  provenance?: {
    source_kind?: ExecutionContractProvenanceKind;
    source_summary_version?: string | null;
    source_anchor?: string | null;
    evidence_refs?: string[];
    notes?: string[];
  };
}): ExecutionContractV1 | null {
  const slots = args.slots;
  if (!slots) return null;

  const existing = parseExecutionContract(slots.execution_contract_v1);
  const executionNative = asObject(slots.execution_native_v1);
  const anchor = asObject(slots.anchor_v1);
  const executionResultSummary = asObject(slots.execution_result_summary);
  const trajectoryCompileSummary = asObject(executionResultSummary?.trajectory_compile_v1);
  const recoveryContract = asObject(slots.recovery_contract_v1);
  const recoveryBody = asObject(recoveryContract?.contract);
  const policyContract = firstRecord(slots.policy_contract_v1, slots.policy_contract);
  const derivedPolicy = asObject(slots.derived_policy_v1);

  const projected = buildExecutionContractFromProjection({
    contract_trust: firstContractTrust(
      slots.contract_trust,
      executionNative?.contract_trust,
      anchor?.contract_trust,
      recoveryContract?.contract_trust,
      policyContract?.contract_trust,
      derivedPolicy?.contract_trust,
    ),
    task_family: firstNonEmptyString(
      slots.task_family,
      slots.task_kind,
      executionNative?.task_family,
      anchor?.task_family,
      recoveryContract?.task_family,
      policyContract?.task_family,
      derivedPolicy?.task_family,
      trajectoryCompileSummary?.task_family,
    ),
    task_signature: firstNonEmptyString(
      slots.task_signature,
      executionNative?.task_signature,
      anchor?.task_signature,
      recoveryContract?.task_signature,
      policyContract?.task_signature,
      derivedPolicy?.task_signature,
    ),
    workflow_signature: firstNonEmptyString(
      slots.workflow_signature,
      executionNative?.workflow_signature,
      anchor?.workflow_signature,
      recoveryContract?.workflow_signature,
      policyContract?.workflow_signature,
      derivedPolicy?.workflow_signature,
      trajectoryCompileSummary?.workflow_signature,
    ),
    policy_memory_id: firstNonEmptyString(
      slots.policy_memory_id,
      policyContract?.policy_memory_id,
      derivedPolicy?.policy_memory_id,
    ),
    selected_tool: firstNonEmptyString(
      slots.selected_tool,
      executionNative?.selected_tool,
      anchor?.selected_tool,
      recoveryBody?.likely_tool,
      policyContract?.selected_tool,
      derivedPolicy?.selected_tool,
    ),
    file_path: firstNonEmptyString(
      slots.file_path,
      executionNative?.file_path,
      anchor?.file_path,
      policyContract?.file_path,
      derivedPolicy?.file_path,
    ),
    target_files: uniqueStrings([
      ...stringList(slots.target_files, 24),
      ...stringList(executionNative?.target_files, 24),
      ...stringList(anchor?.target_files, 24),
      ...stringList(recoveryBody?.target_files, 24),
      ...stringList(policyContract?.target_files, 24),
      ...stringList(derivedPolicy?.target_files, 24),
    ], 24),
    next_action: firstNonEmptyString(
      slots.next_action,
      executionNative?.next_action,
      anchor?.next_action,
      recoveryBody?.next_action,
      policyContract?.next_action,
      derivedPolicy?.next_action,
    ),
    workflow_steps: uniqueStrings([
      ...stringList(slots.workflow_steps, 24),
      ...stringList(executionNative?.workflow_steps, 24),
      ...stringList(anchor?.key_steps, 24),
      ...stringList(recoveryBody?.workflow_steps, 24),
      ...stringList(policyContract?.workflow_steps, 24),
      ...stringList(derivedPolicy?.workflow_steps, 24),
    ], 24),
    pattern_hints: uniqueStrings([
      ...stringList(slots.pattern_hints, 24),
      ...stringList(executionNative?.pattern_hints, 24),
      ...stringList(anchor?.pattern_hints, 24),
      ...stringList(recoveryBody?.pattern_hints, 24),
      ...stringList(policyContract?.pattern_hints, 24),
      ...stringList(derivedPolicy?.pattern_hints, 24),
    ], 24),
    service_lifecycle_constraints: [
      ...firstLifecycleConstraintList(16, slots.service_lifecycle_constraints),
      ...firstLifecycleConstraintList(16, executionNative?.service_lifecycle_constraints),
      ...firstLifecycleConstraintList(16, anchor?.service_lifecycle_constraints),
      ...firstLifecycleConstraintList(16, recoveryBody?.service_lifecycle_constraints),
      ...firstLifecycleConstraintList(16, policyContract?.service_lifecycle_constraints),
      ...firstLifecycleConstraintList(16, derivedPolicy?.service_lifecycle_constraints),
    ],
    acceptance_checks: uniqueStrings([
      ...stringList(slots.acceptance_checks, 24),
      ...stringList(recoveryBody?.acceptance_checks, 24),
      ...stringList(policyContract?.acceptance_checks, 24),
      ...stringList(derivedPolicy?.acceptance_checks, 24),
      ...stringList(existing?.outcome.acceptance_checks, 24),
    ], 24),
    success_invariants: uniqueStrings([
      ...stringList(recoveryBody?.success_invariants, 24),
      ...stringList(existing?.outcome.success_invariants, 24),
    ], 24),
    dependency_requirements: uniqueStrings([
      ...stringList(recoveryBody?.dependency_requirements, 24),
      ...stringList(existing?.outcome.dependency_requirements, 24),
    ], 24),
    environment_assumptions: uniqueStrings([
      ...stringList(recoveryBody?.environment_assumptions, 24),
      ...stringList(existing?.outcome.environment_assumptions, 24),
    ], 24),
    must_hold_after_exit: uniqueStrings([
      ...stringList(recoveryBody?.must_hold_after_exit, 24),
      ...stringList(existing?.outcome.must_hold_after_exit, 24),
    ], 24),
    external_visibility_requirements: uniqueStrings([
      ...stringList(recoveryBody?.external_visibility_requirements, 24),
      ...stringList(existing?.outcome.external_visibility_requirements, 24),
    ], 24),
    provenance: {
      source_kind: args.provenance?.source_kind ?? "slot_projection",
      source_summary_version:
        args.provenance?.source_summary_version
        ?? firstNonEmptyString(existing?.provenance.source_summary_version, trajectoryCompileSummary?.summary_version),
      source_anchor: args.provenance?.source_anchor ?? existing?.provenance.source_anchor ?? null,
      evidence_refs: uniqueStrings([
        ...(args.provenance?.evidence_refs ?? []),
        ...(existing?.provenance.evidence_refs ?? []),
      ], 16),
      notes: uniqueStrings([
        ...(args.provenance?.notes ?? []),
        ...(existing?.provenance.notes ?? []),
      ], 16),
    },
  });

  if (!hasExecutionContractSignal(projected)) return existing;
  if (!existing) return projected;
  return mergeExecutionContractsWithActionSurface({
    existing,
    incoming: projected,
    preference: "existing",
  });
}

export function buildExecutionContractFromTrajectoryCompile(compiled: TrajectoryCompileResponse): ExecutionContractV1 {
  return buildExecutionContractFromProjection({
    contract_trust: null,
    task_family: compiled.task_family,
    task_signature: compiled.task_signature,
    workflow_signature: compiled.workflow_signature,
    selected_tool: compiled.contract.likely_tool ?? null,
    target_files: compiled.contract.target_files,
    next_action: compiled.contract.next_action,
    workflow_steps: compiled.contract.workflow_steps,
    pattern_hints: compiled.contract.pattern_hints,
    service_lifecycle_constraints: compiled.contract.service_lifecycle_constraints,
    acceptance_checks: compiled.contract.acceptance_checks,
    success_invariants: compiled.contract.success_invariants,
    dependency_requirements: compiled.contract.dependency_requirements,
    environment_assumptions: compiled.contract.environment_assumptions,
    must_hold_after_exit: compiled.contract.must_hold_after_exit,
    external_visibility_requirements: compiled.contract.external_visibility_requirements,
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: compiled.summary_version,
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });
}

export function buildExecutionContractFromProjection(args: {
  contract_trust?: ContractTrust | null;
  task_family?: string | null;
  task_signature?: string | null;
  workflow_signature?: string | null;
  policy_memory_id?: string | null;
  selected_tool?: string | null;
  file_path?: string | null;
  target_files?: unknown;
  next_action?: string | null;
  workflow_steps?: unknown;
  pattern_hints?: unknown;
  service_lifecycle_constraints?: unknown;
  acceptance_checks?: unknown;
  success_invariants?: unknown;
  dependency_requirements?: unknown;
  environment_assumptions?: unknown;
  must_hold_after_exit?: unknown;
  external_visibility_requirements?: unknown;
  provenance: {
    source_kind: ExecutionContractProvenanceKind;
    source_summary_version?: string | null;
    source_anchor?: string | null;
    evidence_refs?: string[];
    notes?: string[];
  };
}): ExecutionContractV1 {
  const targetFiles = stringList(args.target_files, 24);
  const filePath = toStringOrNull(args.file_path) ?? targetFiles[0] ?? null;
  const serviceLifecycleConstraints = uniqueLifecycleConstraints(
    Array.isArray(args.service_lifecycle_constraints) ? args.service_lifecycle_constraints : [],
    16,
  );
  const derivedOutcome = deriveOutcomeFromInputs({
    acceptanceChecks: stringList(args.acceptance_checks, 24),
    targetFiles,
    serviceLifecycleConstraints,
    environmentAssumptions: stringList(args.environment_assumptions, 24),
    dependencyRequirements: stringList(args.dependency_requirements, 24),
  });
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: normalizeContractTrust(args.contract_trust),
    task_family: toStringOrNull(args.task_family),
    task_signature: toStringOrNull(args.task_signature),
    workflow_signature: toStringOrNull(args.workflow_signature),
    policy_memory_id: toStringOrNull(args.policy_memory_id),
    selected_tool: toStringOrNull(args.selected_tool),
    file_path: filePath,
    target_files: targetFiles,
    next_action: toStringOrNull(args.next_action),
    workflow_steps: stringList(args.workflow_steps, 24),
    pattern_hints: stringList(args.pattern_hints, 24),
    service_lifecycle_constraints: serviceLifecycleConstraints,
    outcome: {
      acceptance_checks: derivedOutcome.acceptance_checks,
      success_invariants: mergeStringListField(
        derivedOutcome.success_invariants,
        args.success_invariants,
        "incoming",
        24,
      ),
      dependency_requirements: mergeStringListField(
        derivedOutcome.dependency_requirements,
        args.dependency_requirements,
        "incoming",
        24,
      ),
      environment_assumptions: mergeStringListField(
        derivedOutcome.environment_assumptions,
        args.environment_assumptions,
        "incoming",
        24,
      ),
      must_hold_after_exit: mergeStringListField(
        derivedOutcome.must_hold_after_exit,
        args.must_hold_after_exit,
        "incoming",
        24,
      ),
      external_visibility_requirements: mergeStringListField(
        derivedOutcome.external_visibility_requirements,
        args.external_visibility_requirements,
        "incoming",
        24,
      ),
    },
    provenance: {
      source_kind: args.provenance.source_kind,
      source_summary_version: toStringOrNull(args.provenance.source_summary_version),
      source_anchor: toStringOrNull(args.provenance.source_anchor),
      evidence_refs: uniqueStrings(args.provenance.evidence_refs ?? [], 16),
      notes: uniqueStrings(args.provenance.notes ?? [], 16),
    },
  });
}

export function guardExecutionContractForConsumer(args: {
  contract: ExecutionContractV1 | null;
  trust: ContractTrust;
}): ExecutionContractV1 | null {
  if (!args.contract) return null;
  if (args.trust !== "observational") return args.contract;
  return ExecutionContractV1Schema.parse({
    ...args.contract,
    task_family: null,
    workflow_signature: null,
    policy_memory_id: null,
    file_path: null,
    target_files: [],
    next_action: null,
    workflow_steps: [],
    pattern_hints: [],
    service_lifecycle_constraints: [],
    outcome: {
      ...args.contract.outcome,
      acceptance_checks: [],
      must_hold_after_exit: [],
      external_visibility_requirements: [],
    },
  });
}

export function buildExecutionContractFromHandoff(args: {
  anchor: string;
  handoffKind: string;
  filePath?: string | null;
  repoRoot?: string | null;
  targetFiles?: string[];
  nextAction?: string | null;
  acceptanceChecks?: string[];
  workflowSteps?: string[];
  patternHints?: string[];
  selectedTool?: string | null;
  taskFamily?: string | null;
  taskSignature?: string | null;
  workflowSignature?: string | null;
  serviceLifecycleConstraints?: unknown[];
  base?: ExecutionContractV1 | null;
}): ExecutionContractV1 {
  const base = args.base ?? null;
  const targetFiles = uniqueStrings([
    ...(args.targetFiles ?? []),
    args.filePath ?? null,
    ...(base?.target_files ?? []),
  ], 24);
  const serviceLifecycleConstraints = uniqueLifecycleConstraints([
    ...(args.serviceLifecycleConstraints ?? []),
    ...(base?.service_lifecycle_constraints ?? []),
  ], 16);
  const environmentAssumptions = uniqueStrings([
    args.repoRoot ? `repo_root:${args.repoRoot}` : null,
    ...(base?.outcome.environment_assumptions ?? []),
  ], 24);
  const derivedOutcome = deriveOutcomeFromInputs({
    acceptanceChecks: uniqueStrings([
      ...(args.acceptanceChecks ?? []),
      ...(base?.outcome.acceptance_checks ?? []),
    ], 24),
    targetFiles,
    serviceLifecycleConstraints,
    environmentAssumptions,
    dependencyRequirements: base?.outcome.dependency_requirements ?? [],
  });
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust: base?.contract_trust ?? null,
    task_family: args.taskFamily ?? base?.task_family ?? args.handoffKind,
    task_signature: args.taskSignature ?? base?.task_signature ?? null,
    workflow_signature: args.workflowSignature ?? base?.workflow_signature ?? null,
    policy_memory_id: base?.policy_memory_id ?? null,
    selected_tool: args.selectedTool ?? base?.selected_tool ?? null,
    file_path: args.filePath ?? base?.file_path ?? targetFiles[0] ?? null,
    target_files: targetFiles,
    next_action: args.nextAction ?? base?.next_action ?? null,
    workflow_steps: uniqueStrings([
      ...(args.workflowSteps ?? []),
      ...(base?.workflow_steps ?? []),
    ], 24),
    pattern_hints: uniqueStrings([
      ...(args.patternHints ?? []),
      ...(base?.pattern_hints ?? []),
    ], 24),
    service_lifecycle_constraints: serviceLifecycleConstraints,
    outcome: {
      acceptance_checks: derivedOutcome.acceptance_checks,
      success_invariants: uniqueStrings([
        ...(base?.outcome.success_invariants ?? []),
        ...derivedOutcome.success_invariants,
      ], 24),
      dependency_requirements: uniqueStrings([
        ...(base?.outcome.dependency_requirements ?? []),
        ...derivedOutcome.dependency_requirements,
      ], 24),
      environment_assumptions: uniqueStrings([
        ...environmentAssumptions,
        ...derivedOutcome.environment_assumptions,
      ], 24),
      must_hold_after_exit: uniqueStrings([
        ...(base?.outcome.must_hold_after_exit ?? []),
        ...derivedOutcome.must_hold_after_exit,
      ], 24),
      external_visibility_requirements: uniqueStrings([
        ...(base?.outcome.external_visibility_requirements ?? []),
        ...derivedOutcome.external_visibility_requirements,
      ], 24),
    },
    provenance: {
      source_kind: "handoff_store",
      source_summary_version: base?.provenance.source_summary_version ?? null,
      source_anchor: args.anchor,
      evidence_refs: uniqueStrings(base?.provenance.evidence_refs ?? [], 16),
      notes: uniqueStrings(base?.provenance.notes ?? [], 16),
    },
  });
}

export function mergeExecutionContracts(args: {
  existing: unknown;
  incoming: ExecutionContractV1;
  preference?: ExecutionContractMergePreference;
}): ExecutionContractV1 {
  const preference = args.preference ?? "incoming";
  const existing = parseExecutionContract(args.existing);
  if (!existing) return ExecutionContractV1Schema.parse(args.incoming);
  const existingOutcome = existing.outcome;
  const incomingOutcome = args.incoming.outcome;
  return ExecutionContractV1Schema.parse({
    schema_version: "execution_contract_v1",
    contract_trust:
      preference === "incoming"
        ? normalizeContractTrust(args.incoming.contract_trust) ?? normalizeContractTrust(existing.contract_trust)
        : normalizeContractTrust(existing.contract_trust) ?? normalizeContractTrust(args.incoming.contract_trust),
    task_family: mergeStringField(existing.task_family, args.incoming.task_family, preference),
    task_signature: mergeStringField(existing.task_signature, args.incoming.task_signature, preference),
    workflow_signature: mergeStringField(existing.workflow_signature, args.incoming.workflow_signature, preference),
    policy_memory_id: mergeStringField(existing.policy_memory_id, args.incoming.policy_memory_id, preference),
    selected_tool: mergeStringField(existing.selected_tool, args.incoming.selected_tool, preference),
    file_path: mergeStringField(existing.file_path, args.incoming.file_path, preference),
    target_files: mergeStringListField(existing.target_files, args.incoming.target_files, preference, 24),
    next_action: mergeStringField(existing.next_action, args.incoming.next_action, preference),
    workflow_steps: mergeStringListField(existing.workflow_steps, args.incoming.workflow_steps, preference, 24),
    pattern_hints: mergeStringListField(existing.pattern_hints, args.incoming.pattern_hints, preference, 24),
    service_lifecycle_constraints: mergeLifecycleField(
      existing.service_lifecycle_constraints,
      args.incoming.service_lifecycle_constraints,
      preference,
      16,
    ),
    outcome: {
      acceptance_checks: mergeStringListField(
        existingOutcome.acceptance_checks,
        incomingOutcome.acceptance_checks,
        preference,
        24,
      ),
      success_invariants: mergeStringListField(
        existingOutcome.success_invariants,
        incomingOutcome.success_invariants,
        preference,
        24,
      ),
      dependency_requirements: mergeStringListField(
        existingOutcome.dependency_requirements,
        incomingOutcome.dependency_requirements,
        preference,
        24,
      ),
      environment_assumptions: mergeStringListField(
        existingOutcome.environment_assumptions,
        incomingOutcome.environment_assumptions,
        preference,
        24,
      ),
      must_hold_after_exit: mergeStringListField(
        existingOutcome.must_hold_after_exit,
        incomingOutcome.must_hold_after_exit,
        preference,
        24,
      ),
      external_visibility_requirements: mergeStringListField(
        existingOutcome.external_visibility_requirements,
        incomingOutcome.external_visibility_requirements,
        preference,
        24,
      ),
    },
    provenance: {
      source_kind:
        preference === "incoming"
          ? args.incoming.provenance.source_kind
          : existing.provenance.source_kind,
      source_summary_version: mergeStringField(
        existing.provenance.source_summary_version,
        args.incoming.provenance.source_summary_version,
        preference,
      ),
      source_anchor: mergeStringField(
        existing.provenance.source_anchor,
        args.incoming.provenance.source_anchor,
        preference,
      ),
      evidence_refs: mergeStringListField(
        existing.provenance.evidence_refs,
        args.incoming.provenance.evidence_refs,
        preference,
        16,
      ),
      notes: mergeStringListField(existing.provenance.notes, args.incoming.provenance.notes, preference, 16),
    },
  });
}

export function mergeExecutionContractsWithActionSurface(args: {
  existing: unknown;
  incoming: ExecutionContractV1;
  preference?: ExecutionContractMergePreference;
}): ExecutionContractV1 {
  const preference = args.preference ?? "incoming";
  const existing = parseExecutionContract(args.existing);
  if (!existing) return ExecutionContractV1Schema.parse(args.incoming);
  const merged = mergeExecutionContracts({
    existing,
    incoming: args.incoming,
    preference,
  });
  const primary = preference === "incoming" ? args.incoming : existing;
  const secondary = preference === "incoming" ? existing : args.incoming;
  return ExecutionContractV1Schema.parse({
    ...merged,
    target_files: primary.target_files.length > 0 ? primary.target_files : secondary.target_files,
    workflow_steps: primary.workflow_steps.length > 0 ? primary.workflow_steps : secondary.workflow_steps,
    pattern_hints: primary.pattern_hints.length > 0 ? primary.pattern_hints : secondary.pattern_hints,
    service_lifecycle_constraints:
      primary.service_lifecycle_constraints.length > 0
        ? primary.service_lifecycle_constraints
        : secondary.service_lifecycle_constraints,
    outcome: {
      ...merged.outcome,
      acceptance_checks:
        primary.outcome.acceptance_checks.length > 0
          ? primary.outcome.acceptance_checks
          : secondary.outcome.acceptance_checks,
      success_invariants:
        primary.outcome.success_invariants.length > 0
          ? primary.outcome.success_invariants
          : secondary.outcome.success_invariants,
      dependency_requirements:
        primary.outcome.dependency_requirements.length > 0
          ? primary.outcome.dependency_requirements
          : secondary.outcome.dependency_requirements,
      environment_assumptions:
        primary.outcome.environment_assumptions.length > 0
          ? primary.outcome.environment_assumptions
          : secondary.outcome.environment_assumptions,
      must_hold_after_exit:
        primary.outcome.must_hold_after_exit.length > 0
          ? primary.outcome.must_hold_after_exit
          : secondary.outcome.must_hold_after_exit,
      external_visibility_requirements:
        primary.outcome.external_visibility_requirements.length > 0
          ? primary.outcome.external_visibility_requirements
          : secondary.outcome.external_visibility_requirements,
    },
  });
}

export function projectExecutionContractToRecoveryContract(args: {
  existing: unknown;
  contract: ExecutionContractV1;
  summaryVersion?: string | null;
  compilerVersion?: string | null;
  promotionSeed?: unknown;
  noiseMarkers?: string[];
}): Record<string, unknown> {
  const existingRecord = asObject(args.existing);
  const existingBody = asObject(existingRecord?.contract);
  return {
    ...(existingRecord ?? {}),
    ...(args.summaryVersion ? { summary_version: args.summaryVersion } : {}),
    ...(args.compilerVersion ? { compiler_version: args.compilerVersion } : {}),
    ...(args.contract.contract_trust ? { contract_trust: args.contract.contract_trust } : {}),
    task_family: args.contract.task_family,
    task_signature: args.contract.task_signature,
    workflow_signature: args.contract.workflow_signature,
    contract: {
      ...(existingBody ?? {}),
      target_files: mergeStringListField(existingBody?.target_files, args.contract.target_files, "incoming", 24),
      acceptance_checks: mergeStringListField(
        existingBody?.acceptance_checks,
        args.contract.outcome.acceptance_checks,
        "incoming",
        24,
      ),
      next_action: mergeStringField(existingBody?.next_action, args.contract.next_action, "incoming"),
      workflow_steps: mergeStringListField(existingBody?.workflow_steps, args.contract.workflow_steps, "incoming", 24),
      pattern_hints: mergeStringListField(existingBody?.pattern_hints, args.contract.pattern_hints, "incoming", 24),
      likely_tool: mergeStringField(existingBody?.likely_tool, args.contract.selected_tool, "incoming"),
      service_lifecycle_constraints: mergeLifecycleField(
        existingBody?.service_lifecycle_constraints,
        args.contract.service_lifecycle_constraints,
        "incoming",
        16,
      ),
      success_invariants: mergeStringListField(
        existingBody?.success_invariants,
        args.contract.outcome.success_invariants,
        "incoming",
        24,
      ),
      dependency_requirements: mergeStringListField(
        existingBody?.dependency_requirements,
        args.contract.outcome.dependency_requirements,
        "incoming",
        24,
      ),
      environment_assumptions: mergeStringListField(
        existingBody?.environment_assumptions,
        args.contract.outcome.environment_assumptions,
        "incoming",
        24,
      ),
      must_hold_after_exit: mergeStringListField(
        existingBody?.must_hold_after_exit,
        args.contract.outcome.must_hold_after_exit,
        "incoming",
        24,
      ),
      external_visibility_requirements: mergeStringListField(
        existingBody?.external_visibility_requirements,
        args.contract.outcome.external_visibility_requirements,
        "incoming",
        24,
      ),
      noise_markers: mergeStringListField(existingBody?.noise_markers, args.noiseMarkers ?? [], "incoming", 16),
    },
    ...(args.promotionSeed !== undefined ? { promotion_seed: args.promotionSeed } : {}),
  };
}

export function buildExecutionContractContextOverlay(args: {
  currentContext: Record<string, unknown>;
  contract: ExecutionContractV1;
  recoveryContract?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const current = args.currentContext;
  return {
    ...current,
    task_kind: mergeStringField(current.task_kind, args.contract.task_family, "incoming"),
    task_family: mergeStringField(current.task_family, args.contract.task_family, "incoming"),
    task_signature: mergeStringField(current.task_signature, args.contract.task_signature, "incoming"),
    workflow_signature: mergeStringField(current.workflow_signature, args.contract.workflow_signature, "incoming"),
    target_files: args.contract.target_files.length > 0
      ? args.contract.target_files
      : stringList(current.target_files, 24),
    acceptance_checks: args.contract.outcome.acceptance_checks.length > 0
      ? args.contract.outcome.acceptance_checks
      : stringList(current.acceptance_checks, 24),
    next_action: mergeStringField(current.next_action, args.contract.next_action, "incoming"),
    workflow_steps: args.contract.workflow_steps.length > 0
      ? args.contract.workflow_steps
      : stringList(current.workflow_steps, 24),
    pattern_hints: args.contract.pattern_hints.length > 0
      ? args.contract.pattern_hints
      : stringList(current.pattern_hints, 24),
    likely_tool: mergeStringField(current.likely_tool, args.contract.selected_tool, "incoming"),
    service_lifecycle_constraints: args.contract.service_lifecycle_constraints.length > 0
      ? args.contract.service_lifecycle_constraints
      : uniqueLifecycleConstraints(Array.isArray(current.service_lifecycle_constraints) ? current.service_lifecycle_constraints : [], 16),
    execution_contract_v1: mergeExecutionContractsWithActionSurface({
      existing: current.execution_contract_v1,
      incoming: args.contract,
      preference: "incoming",
    }),
    recovery_contract_v1: args.recoveryContract ?? current.recovery_contract_v1,
  };
}
