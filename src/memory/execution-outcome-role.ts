export type ExecutionOutcomeRole = "passed_solution" | "failed_branch" | "blocked" | "unknown";
export type ExecutionTaskOutcome =
  | "verified_pass"
  | "verified_failure"
  | "unresolved"
  | "infrastructure";
export type ExecutionOutcomeAuthority =
  | "runtime_verifier"
  | "external_verifier"
  | "explicit_branch_evaluation"
  | "none";

const EXECUTION_OUTCOME_ROLES = new Set<ExecutionOutcomeRole>([
  "passed_solution",
  "failed_branch",
  "blocked",
  "unknown",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseExecutionOutcomeRole(value: unknown): ExecutionOutcomeRole | null {
  const role = exactString(value);
  return role && EXECUTION_OUTCOME_ROLES.has(role as ExecutionOutcomeRole)
    ? role as ExecutionOutcomeRole
    : null;
}

export function normalizeExecutionOutcomeRoleFromValue(value: unknown): ExecutionOutcomeRole | null {
  const direct = parseExecutionOutcomeRole(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  return parseExecutionOutcomeRole(record.execution_outcome_role)
    ?? parseExecutionOutcomeRole(record.outcome_role);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(exactString)
    .filter((entry): entry is string => entry !== null);
}

function verifiedResultFields(value: unknown): {
  role: ExecutionOutcomeRole;
  taskOutcome: ExecutionTaskOutcome | null;
  authority: ExecutionOutcomeAuthority | null;
  verifierReceiptId: string | null;
  targetStateSnapshotId: string | null;
  evidenceRefs: string[];
} {
  const record = asRecord(value) ?? {};
  const role =
    normalizeExecutionOutcomeRoleFromValue(record) ?? "unknown";
  const taskOutcomeValue = exactString(
    record.task_outcome ?? record.outcome_class,
  );
  const taskOutcome =
    taskOutcomeValue === "verified_pass"
      || taskOutcomeValue === "verified_failure"
      || taskOutcomeValue === "unresolved"
      || taskOutcomeValue === "infrastructure"
      ? taskOutcomeValue
      : null;
  const authorityValue = exactString(
    record.outcome_authority ?? record.reward_authority,
  );
  const authority =
    authorityValue === "runtime_verifier"
      || authorityValue === "external_verifier"
      || authorityValue === "explicit_branch_evaluation"
      || authorityValue === "none"
      ? authorityValue
      : null;
  return {
    role,
    taskOutcome,
    authority,
    verifierReceiptId: exactString(record.verifier_receipt_id),
    targetStateSnapshotId: exactString(
      record.target_state_snapshot_id
        ?? record.final_state_snapshot_id
        ?? record.verified_state_snapshot_id,
    ),
    evidenceRefs: [
      ...stringArray(record.evidence_refs),
      ...stringArray(record.source_evidence_refs),
    ],
  };
}

export function deriveExecutionOutcomeRoleFromVerifiedResult(
  value: unknown,
): ExecutionOutcomeRole {
  const result = verifiedResultFields(value);
  if (result.role === "unknown") return "unknown";
  const verifierBound =
    (result.authority === "runtime_verifier"
      || result.authority === "external_verifier")
    && result.verifierReceiptId !== null
    && result.targetStateSnapshotId !== null;
  if (
    result.role === "passed_solution"
    && result.taskOutcome === "verified_pass"
    && verifierBound
  ) {
    return "passed_solution";
  }
  if (
    result.role === "failed_branch"
    && result.taskOutcome === "verified_failure"
    && verifierBound
  ) {
    return "failed_branch";
  }
  if (
    (result.role === "failed_branch" || result.role === "blocked")
    && result.authority === "explicit_branch_evaluation"
    && result.targetStateSnapshotId !== null
    && result.evidenceRefs.length > 0
  ) {
    return result.role;
  }
  return "unknown";
}

export function deriveExecutionOutcomeRoleFromSlots(
  slots: unknown,
): ExecutionOutcomeRole {
  const root = asRecord(slots);
  if (!root) return "unknown";
  const result = asRecord(root.execution_result_summary) ?? {};
  const observation = asRecord(root.execution_observation_v1) ?? {};
  const executionNative = asRecord(root.execution_native_v1) ?? {};
  return deriveExecutionOutcomeRoleFromVerifiedResult({
    ...root,
    ...result,
    ...observation,
    ...executionNative,
    evidence_refs: [
      ...stringArray(root.evidence_refs),
      ...stringArray(result.evidence_refs),
      ...stringArray(observation.evidence_refs),
      ...stringArray(executionNative.evidence_refs),
    ],
  });
}

export function executionOutcomeRoleBlocksDirectUse(role: unknown): boolean {
  return role === "failed_branch" || role === "blocked";
}
