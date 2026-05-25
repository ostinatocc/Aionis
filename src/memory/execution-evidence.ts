import { z } from "zod";
import { ContractTrustSchema, type ContractTrust } from "./contract-trust.js";
import type { ExecutionContractV1 } from "./execution-contract.js";

const EvidenceStringList = z.array(z.string().trim().min(1).max(256)).max(32).default([]);
const ExecutionValidationBoundarySchema = z.enum([
  "unknown",
  "agent_self",
  "runtime_orchestrator",
  "external_verifier",
]);
export type ExecutionValidationBoundary = z.infer<typeof ExecutionValidationBoundarySchema>;

export const ExecutionEvidenceV1Schema = z.object({
  schema_version: z.literal("execution_evidence_v1"),
  validation_passed: z.boolean().nullable().default(null),
  after_exit_revalidated: z.boolean().nullable().default(null),
  fresh_shell_probe_passed: z.boolean().nullable().default(null),
  validation_boundary: ExecutionValidationBoundarySchema.default("unknown"),
  failure_reason: z.string().trim().min(1).max(256).nullable().default(null),
  false_confidence_detected: z.boolean().default(false),
  evidence_refs: EvidenceStringList,
});
export type ExecutionEvidenceV1 = z.infer<typeof ExecutionEvidenceV1Schema>;

export const ExecutionEvidenceAssessmentV1Schema = z.object({
  schema_version: z.literal("execution_evidence_assessment_v1"),
  status: z.enum(["succeeded", "failed", "incomplete", "unknown"]),
  allows_authoritative: z.boolean(),
  allows_stable_promotion: z.boolean(),
  requested_trust: ContractTrustSchema.nullable(),
  effective_trust: ContractTrustSchema.nullable(),
  reasons: z.array(z.string().min(1).max(128)).max(16),
  decisive_fields: z.object({
    validation_passed: z.boolean().nullable(),
    after_exit_revalidated: z.boolean().nullable(),
    fresh_shell_probe_passed: z.boolean().nullable(),
    validation_boundary: ExecutionValidationBoundarySchema,
    false_confidence_detected: z.boolean(),
    failure_reason_present: z.boolean(),
    requires_after_exit_revalidation: z.boolean(),
    requires_fresh_shell_probe: z.boolean(),
    requires_external_validation_boundary: z.boolean(),
  }),
});
export type ExecutionEvidenceAssessmentV1 = z.infer<typeof ExecutionEvidenceAssessmentV1Schema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function booleanField(record: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function statusToValidation(value: unknown): boolean | null {
  const status = nullableString(value)?.toLowerCase();
  if (!status) return null;
  if (["ok", "pass", "passed", "success", "succeeded", "complete", "completed"].includes(status)) return true;
  if (["fail", "failed", "failure", "error", "errored", "blocked", "timeout", "timed_out"].includes(status)) return false;
  return null;
}

function normalizeValidationBoundary(value: unknown): ExecutionValidationBoundary {
  const raw = nullableString(value)?.toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "unknown";
  if (["agent", "agent_self", "same_agent", "self", "self_reported", "worker_self"].includes(raw)) {
    return "agent_self";
  }
  if (["runtime", "runtime_orchestrator", "orchestrator", "parent", "parent_process"].includes(raw)) {
    return "runtime_orchestrator";
  }
  if (["external", "external_probe", "external_verifier", "verifier", "independent_verifier"].includes(raw)) {
    return "external_verifier";
  }
  return "unknown";
}

function uniqueEvidenceRefs(values: unknown[], limit = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of uniqueEvidenceRefs(value, limit)) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        out.push(entry);
        if (out.length >= limit) return out;
      }
      continue;
    }
    const record = asRecord(value);
    if (record) {
      for (const entry of uniqueEvidenceRefs([record.evidence_refs, record.evidenceRefs], limit)) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        out.push(entry);
        if (out.length >= limit) return out;
      }
    }
    const ref = record
      ? nullableString(record.ref)
        ?? nullableString(record.uri)
        ?? nullableString(record.id)
        ?? nullableString(record.evidence_ref)
      : nullableString(value);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}

function firstFailureReason(values: unknown[]): string | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstFailureReason(value);
      if (nested) return nested;
      continue;
    }
    const record = asRecord(value);
    const reason =
      nullableString(record?.failure_reason)
      ?? nullableString(record?.failureReason)
      ?? nullableString(record?.error)
      ?? nullableString(record?.reason);
    if (reason) return reason;
  }
  return null;
}

function normalizeTrust(value: unknown): ContractTrust | null {
  const parsed = ContractTrustSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseEvidence(value: unknown): ExecutionEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;
  const parsed = ExecutionEvidenceV1Schema.safeParse({
    schema_version: "execution_evidence_v1",
    ...record,
  });
  return parsed.success ? parsed.data : null;
}

function compileEvidenceFromRecord(args: {
  record: Record<string, unknown> | null;
  evidenceRefs?: unknown[];
}): ExecutionEvidenceV1 | null {
  const record = args.record;
  if (!record) return null;
  const validationPassed =
    booleanField(record, "validation_passed", "validationPassed", "passed", "ok", "success")
    ?? statusToValidation(record.status)
    ?? statusToValidation(record.validation_status)
    ?? statusToValidation(record.source_run_status)
    ?? statusToValidation(record.result)
    ?? statusToValidation(record.outcome);
  const afterExitRevalidated = booleanField(
    record,
    "after_exit_revalidated",
    "afterExitRevalidated",
    "after_exit_validation_passed",
    "must_hold_after_exit_passed",
  );
  const freshShellProbePassed = booleanField(
    record,
    "fresh_shell_probe_passed",
    "freshShellProbePassed",
    "fresh_shell_revalidated",
    "fresh_shell_validation_passed",
    "revalidate_from_fresh_shell_passed",
  );
  const validationBoundary = normalizeValidationBoundary(
    record.validation_boundary
    ?? record.validationBoundary
    ?? record.validation_actor
    ?? record.validationActor
    ?? record.probe_actor
    ?? record.probeActor
    ?? record.verifier_actor
    ?? record.verifierActor,
  );
  const failureReason =
    nullableString(record.failure_reason)
    ?? nullableString(record.error)
    ?? nullableString(record.reason)
    ?? firstFailureReason(args.evidenceRefs ?? [])
    ?? (validationPassed === false ? nullableString(record.summary) : null);
  const falseConfidenceDetected =
    booleanField(record, "false_confidence_detected", "falseConfidenceDetected") === true
    || (
      statusToValidation(record.status) === true
      && [validationPassed, afterExitRevalidated, freshShellProbePassed].some((value) => value === false)
    );
  const evidenceRefs = uniqueEvidenceRefs([
    record.evidence_refs,
    record.evidenceRefs,
    record.ref,
    record.uri,
    record.id,
    ...(args.evidenceRefs ?? []),
  ]);

  if (
    validationPassed === null
    && afterExitRevalidated === null
    && freshShellProbePassed === null
    && !failureReason
    && !falseConfidenceDetected
  ) {
    return null;
  }

  return ExecutionEvidenceV1Schema.parse({
    schema_version: "execution_evidence_v1",
    validation_passed: validationPassed,
    after_exit_revalidated: afterExitRevalidated,
    fresh_shell_probe_passed: freshShellProbePassed,
    validation_boundary: validationBoundary,
    failure_reason: failureReason,
    false_confidence_detected: falseConfidenceDetected,
    evidence_refs: evidenceRefs,
  });
}

function compileEvidenceFromArray(value: unknown): ExecutionEvidenceV1 | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const parsed = parseEvidence(entry);
    if (parsed) return parsed;
  }
  for (const entry of value) {
    const compiled = compileEvidenceFromRecord({
      record: asRecord(entry),
      evidenceRefs: value,
    });
    if (compiled) return compiled;
  }
  return null;
}

function metricEvidence(metrics: unknown): ExecutionEvidenceV1 | null {
  const record = asRecord(metrics);
  if (!record) return null;
  const successRatio = record && typeof record.success_ratio === "number" && Number.isFinite(record.success_ratio)
    ? record.success_ratio
    : null;
  const validationPassed =
    booleanField(record, "validation_passed", "validationPassed", "passed", "ok", "success")
    ?? statusToValidation(record.status)
    ?? statusToValidation(record.validation_status)
    ?? (successRatio == null ? null : successRatio >= 1);
  const afterExitRevalidated = booleanField(
    record,
    "after_exit_revalidated",
    "afterExitRevalidated",
    "after_exit_validation_passed",
    "must_hold_after_exit_passed",
  );
  const freshShellProbePassed = booleanField(
    record,
    "fresh_shell_probe_passed",
    "freshShellProbePassed",
    "fresh_shell_revalidated",
    "fresh_shell_validation_passed",
    "revalidate_from_fresh_shell_passed",
  );
  const validationBoundary = normalizeValidationBoundary(
    record.validation_boundary
    ?? record.validationBoundary
    ?? record.validation_actor
    ?? record.validationActor
    ?? record.probe_actor
    ?? record.probeActor
    ?? record.verifier_actor
    ?? record.verifierActor,
  );
  const failureReason =
    nullableString(record.failure_reason)
    ?? nullableString(record.error)
    ?? nullableString(record.reason)
    ?? (validationPassed === false ? "source_metrics_validation_failed" : null)
    ?? (successRatio != null && successRatio < 1 ? "source_metrics_success_ratio_below_one" : null);
  const falseConfidenceDetected =
    booleanField(record, "false_confidence_detected", "falseConfidenceDetected") === true
    || (
      statusToValidation(record.status) === true
      && [validationPassed, afterExitRevalidated, freshShellProbePassed].some((value) => value === false)
    );
  const evidenceRefs = uniqueEvidenceRefs([record.evidence_refs, record.evidenceRefs, record.ref, record.uri, record.id]);
  if (
    validationPassed === null
    && afterExitRevalidated === null
    && freshShellProbePassed === null
    && !failureReason
    && !falseConfidenceDetected
  ) {
    return null;
  }
  return ExecutionEvidenceV1Schema.parse({
    schema_version: "execution_evidence_v1",
    validation_passed: validationPassed,
    after_exit_revalidated: afterExitRevalidated,
    fresh_shell_probe_passed: freshShellProbePassed,
    validation_boundary: validationBoundary,
    failure_reason: failureReason,
    false_confidence_detected: falseConfidenceDetected,
    evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : ["source.metrics"],
  });
}

function inferRequiresAfterExit(contract: ExecutionContractV1 | null | undefined): boolean {
  if (!contract) return false;
  return contract.outcome.must_hold_after_exit.length > 0
    || contract.service_lifecycle_constraints.some((constraint) => constraint.must_survive_agent_exit);
}

function inferRequiresFreshShell(contract: ExecutionContractV1 | null | undefined): boolean {
  if (!contract) return false;
  return contract.service_lifecycle_constraints.some((constraint) => constraint.revalidate_from_fresh_shell)
    || contract.outcome.environment_assumptions.some((assumption) =>
      /fresh_shell|fresh shell|new shell|clean_client|clean client|validation_can_run_from_fresh_shell/i.test(assumption)
    )
    || contract.outcome.success_invariants.some((invariant) =>
      /fresh_shell|fresh shell|clean_client|clean client/i.test(invariant)
    )
    || contract.outcome.external_visibility_requirements.some((requirement) =>
      /clean_client|clean client|fresh_shell|fresh shell/i.test(requirement)
    );
}

function deriveStatus(args: {
  evidence: ExecutionEvidenceV1 | null;
  reasons: string[];
}): ExecutionEvidenceAssessmentV1["status"] {
  if (!args.evidence) return "unknown";
  if (
    args.evidence.validation_passed === false
    || args.evidence.after_exit_revalidated === false
    || args.evidence.fresh_shell_probe_passed === false
    || args.evidence.false_confidence_detected
  ) {
    return "failed";
  }
  if (args.reasons.length > 0) return "incomplete";
  return "succeeded";
}

function evidenceReason(prefix: string, value: string): string {
  return `${prefix}:${value}`.slice(0, 128);
}

function hasExplicitExecutionEvidenceRef(evidence: ExecutionEvidenceV1 | null): boolean {
  return (evidence?.evidence_refs ?? []).some((ref) => ref !== "source.metrics");
}

function validationBoundaryAllowsExternalVerification(evidence: ExecutionEvidenceV1 | null): boolean {
  return evidence?.validation_boundary === "runtime_orchestrator"
    || evidence?.validation_boundary === "external_verifier";
}

export function extractExecutionEvidenceFromSlots(args: {
  slots?: Record<string, unknown> | null;
  metrics?: unknown;
}): ExecutionEvidenceV1 | null {
  const slots = args.slots ?? {};
  const executionResultSummary = asRecord(slots.execution_result_summary);
  const compileSummary = asRecord(slots.compile_summary);
  return parseEvidence(slots.execution_evidence_v1)
    ?? parseEvidence(executionResultSummary?.execution_evidence_v1)
    ?? compileEvidenceFromRecord({
      record: executionResultSummary,
      evidenceRefs: [slots.execution_evidence, slots.execution_packet_v1],
    })
    ?? compileEvidenceFromRecord({
      record: compileSummary,
      evidenceRefs: [slots.execution_evidence, slots.execution_packet_v1],
    })
    ?? compileEvidenceFromArray(slots.execution_evidence)
    ?? compileEvidenceFromArray(executionResultSummary?.execution_evidence)
    ?? metricEvidence(args.metrics);
}

export function assessExecutionEvidence(args: {
  executionContract?: ExecutionContractV1 | null;
  evidence?: unknown;
  requestedTrust?: unknown;
  requiresAfterExitRevalidation?: boolean;
  requiresFreshShellProbe?: boolean;
}): ExecutionEvidenceAssessmentV1 {
  const evidence = parseEvidence(args.evidence);
  const requestedTrust = normalizeTrust(args.requestedTrust ?? args.executionContract?.contract_trust);
  const requiresAfterExitRevalidation =
    args.requiresAfterExitRevalidation ?? inferRequiresAfterExit(args.executionContract);
  const requiresFreshShellProbe =
    args.requiresFreshShellProbe ?? inferRequiresFreshShell(args.executionContract);
  const requiresExternalValidationBoundary = requiresAfterExitRevalidation || requiresFreshShellProbe;
  const reasons: string[] = [];
  const hasExplicitEvidence = hasExplicitExecutionEvidenceRef(evidence);

  if (!evidence) {
    reasons.push("missing_execution_evidence");
  } else {
    if (!hasExplicitEvidence) {
      reasons.push("missing_explicit_execution_evidence");
    }
    if (evidence.validation_passed !== true) {
      reasons.push(evidence.validation_passed === false ? "validation_failed" : "missing_validation_passed");
    }
    if (requiresAfterExitRevalidation && evidence.after_exit_revalidated !== true) {
      reasons.push(
        evidence.after_exit_revalidated === false
          ? "after_exit_revalidation_failed"
          : "missing_after_exit_revalidation",
      );
    }
    if (requiresFreshShellProbe && evidence.fresh_shell_probe_passed !== true) {
      reasons.push(
        evidence.fresh_shell_probe_passed === false
          ? "fresh_shell_probe_failed"
          : "missing_fresh_shell_probe",
      );
    }
    if (requiresExternalValidationBoundary && !validationBoundaryAllowsExternalVerification(evidence)) {
      reasons.push(
        evidence.validation_boundary === "agent_self"
          ? "agent_self_validation_boundary"
          : "missing_external_validation_boundary",
      );
    }
    if (evidence.false_confidence_detected) reasons.push("false_confidence_detected");
    if (evidence.failure_reason) reasons.push(evidenceReason("failure_reason", evidence.failure_reason));
  }

  const status = deriveStatus({ evidence, reasons });
  const allowsAuthoritative = requestedTrust === "authoritative" && status === "succeeded" && hasExplicitEvidence;
  const effectiveTrust = requestedTrust === "authoritative" && !allowsAuthoritative
    ? "advisory"
    : requestedTrust;

  return ExecutionEvidenceAssessmentV1Schema.parse({
    schema_version: "execution_evidence_assessment_v1",
    status,
    allows_authoritative: allowsAuthoritative,
    allows_stable_promotion: status === "succeeded" && hasExplicitEvidence,
    requested_trust: requestedTrust,
    effective_trust: effectiveTrust,
    reasons: Array.from(new Set(reasons)).slice(0, 16),
    decisive_fields: {
      validation_passed: evidence?.validation_passed ?? null,
      after_exit_revalidated: evidence?.after_exit_revalidated ?? null,
      fresh_shell_probe_passed: evidence?.fresh_shell_probe_passed ?? null,
      validation_boundary: evidence?.validation_boundary ?? "unknown",
      false_confidence_detected: evidence?.false_confidence_detected ?? false,
      failure_reason_present: !!evidence?.failure_reason,
      requires_after_exit_revalidation: requiresAfterExitRevalidation,
      requires_fresh_shell_probe: requiresFreshShellProbe,
      requires_external_validation_boundary: requiresExternalValidationBoundary,
    },
  });
}

export function buildExecutionEvidenceFromValidation(args: {
  validationPassed: boolean;
  afterExitRevalidated?: boolean | null;
  freshShellProbePassed?: boolean | null;
  validationBoundary?: ExecutionValidationBoundary;
  failureReason?: string | null;
  falseConfidenceDetected?: boolean;
  evidenceRefs?: string[];
}): ExecutionEvidenceV1 {
  return ExecutionEvidenceV1Schema.parse({
    schema_version: "execution_evidence_v1",
    validation_passed: args.validationPassed,
    after_exit_revalidated: args.afterExitRevalidated ?? null,
    fresh_shell_probe_passed: args.freshShellProbePassed ?? null,
    validation_boundary: args.validationBoundary ?? "unknown",
    failure_reason: args.failureReason ?? null,
    false_confidence_detected: args.falseConfidenceDetected ?? false,
    evidence_refs: args.evidenceRefs ?? [],
  });
}
