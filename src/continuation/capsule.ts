import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalUniqueSet,
  type CapsuleCoverageClaimV1,
  type CapsuleRefV1,
  type ExecutionCapsuleV1,
  type TargetRefV1,
  type TypedPreconditionSpecV1,
} from "./contract.js";
import { validatePreconditionSpecV1 } from "./observation.js";
import { assertExecutionCapsuleV1 } from "./validation.js";

export type ExecutionCapsuleDraftV1 = Readonly<{
  capsule_id: string;
  created_at: string;
  kind: ExecutionCapsuleV1["kind"];
  proposed_influence: ExecutionCapsuleV1["proposed_influence"];
  applicability: Readonly<Omit<ExecutionCapsuleV1["applicability"], "tenant_id" | "scope">>;
  projection: Readonly<Omit<ExecutionCapsuleV1["projection"], "projection_sha256">>;
  coverage_claims: readonly Readonly<
    Omit<CapsuleCoverageClaimV1, "coverage_claim_sha256">
  >[];
  precondition_specs: readonly TypedPreconditionSpecV1[];
  evidence_refs: readonly string[];
  verifier_refs: readonly string[];
  conflicts_with: readonly CapsuleRefV1[];
  supersedes: readonly CapsuleRefV1[];
  expires_at: string | null;
}>;

export type BuildExecutionCapsuleV1Args = Readonly<{
  tenant_id: string;
  scope: string;
  capsule_revision: number;
  parent_capsule_sha256: string | null;
  source: Readonly<{
    memory_id: string;
    source_commit_id: string;
    source_projection_sha256: string;
  }>;
  draft: ExecutionCapsuleDraftV1;
}>;

const CAPSULE_KINDS = new Set<ExecutionCapsuleV1["kind"]>([
  "current_state",
  "verified_fact",
  "procedure",
  "constraint",
  "counter_evidence",
  "rehydration_pointer",
]);
const INFLUENCES = new Set<ExecutionCapsuleV1["proposed_influence"]>([
  "use",
  "inspect",
  "block",
  "rehydrate",
]);
const TARGET_KINDS = new Set<TargetRefV1["kind"]>([
  "artifact",
  "service",
  "capability",
  "memory",
  "workflow",
  "external_resource",
]);
const OBLIGATION_KINDS = new Set<CapsuleCoverageClaimV1["obligation_kind"]>([
  "active_goal",
  "required_state",
  "next_action",
  "must_hold",
  "prohibition",
  "verification",
]);
const EVIDENCE_REQUIREMENTS = new Set<CapsuleCoverageClaimV1["evidence_requirement"]>([
  "runtime_state",
  "trusted_host",
  "external_verifier",
]);

function assertText(value: string, maxBytes: number, field: string): void {
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim() || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be non-empty canonical text bounded to ${maxBytes} UTF-8 bytes`);
  }
}

function assertNullableText(
  value: string | null,
  maxBytes: number,
  field: string,
): void {
  if (value !== null) assertText(value, maxBytes, field);
}

function assertJsonBytes(value: unknown, maxBytes: number, field: string): string {
  const json = canonicalContinuationJson(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} canonical JSON bytes`);
  }
  return json;
}

function canonicalStrings(
  values: readonly string[],
  maxCount: number,
  maxBytes: number,
  field: string,
): string[] {
  if (values.length > maxCount) throw new Error(`${field} exceeds ${maxCount} entries`);
  values.forEach((value) => assertText(value, maxBytes, field));
  return canonicalUniqueSet(values, (value) => value);
}

function targetKey(target: TargetRefV1): string {
  return `${target.kind}\0${target.ref}`;
}

function canonicalTargets(values: readonly TargetRefV1[]): TargetRefV1[] {
  if (values.length > 16) throw new Error("capsule projection target_refs exceeds 16 entries");
  for (const target of values) {
    if (!TARGET_KINDS.has(target.kind)) throw new Error("capsule target kind is invalid");
    assertText(target.ref, 1024, "capsule.projection.target_ref");
  }
  return canonicalUniqueSet(values.map((value) => ({ ...value })), targetKey);
}

function canonicalCoverageClaims(
  values: ExecutionCapsuleDraftV1["coverage_claims"],
): CapsuleCoverageClaimV1[] {
  if (values.length < 1 || values.length > 32) {
    throw new Error("capsule coverage_claims must contain between 1 and 32 entries");
  }
  const claims = values.map((value): CapsuleCoverageClaimV1 => {
    if (!OBLIGATION_KINDS.has(value.obligation_kind)
      || !EVIDENCE_REQUIREMENTS.has(value.evidence_requirement)) {
      throw new Error("capsule coverage claim kind or evidence requirement is invalid");
    }
    const targetRefs = canonicalTargets(value.target_refs);
    if (targetRefs.length === 0) {
      throw new Error("capsule coverage claim requires a stable target set");
    }
    const requiredProbeIds = canonicalStrings(
      value.required_probe_ids,
      16,
      256,
      "capsule.coverage_claim.required_probe_id",
    );
    if ((value.evidence_requirement === "runtime_state") !== (requiredProbeIds.length === 0)) {
      throw new Error(
        "capsule coverage claim runtime-state evidence must have no probes and observed evidence must have probes",
      );
    }
    const body = {
      obligation_kind: value.obligation_kind,
      target_refs: targetRefs,
      evidence_requirement: value.evidence_requirement,
      required_probe_ids: requiredProbeIds,
    };
    return {
      ...body,
      coverage_claim_sha256: canonicalContinuationSha256(body),
    };
  });
  return canonicalUniqueSet(claims, (value) => value.coverage_claim_sha256);
}

function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision.toString().padStart(16, "0")}\0${ref.capsule_sha256}`;
}

function canonicalCapsuleRefs(
  values: readonly CapsuleRefV1[],
  field: string,
): CapsuleRefV1[] {
  if (values.length > 16) throw new Error(`${field} exceeds 16 entries`);
  for (const ref of values) {
    assertText(ref.capsule_id, 256, `${field}.capsule_id`);
    if (!Number.isSafeInteger(ref.capsule_revision) || ref.capsule_revision < 1) {
      throw new Error(`${field}.capsule_revision must be a positive safe integer`);
    }
    assertSha256(ref.capsule_sha256, `${field}.capsule_sha256`);
  }
  return canonicalUniqueSet(values.map((value) => ({ ...value })), capsuleRefKey);
}

function canonicalPreconditions(
  values: readonly TypedPreconditionSpecV1[],
): TypedPreconditionSpecV1[] {
  if (values.length > 16) throw new Error("capsule precondition_specs exceeds 16 entries");
  for (const value of values) validatePreconditionSpecV1(value);
  const copied = values.map((value): TypedPreconditionSpecV1 => ({ ...value }));
  return canonicalUniqueSet(copied, (value) => value.probe_id);
}

function assertSequence(
  values: readonly string[],
  maxCount: number,
  maxBytes: number,
  field: string,
): void {
  if (values.length > maxCount) throw new Error(`${field} exceeds ${maxCount} entries`);
  values.forEach((value) => assertText(value, maxBytes, field));
}

/**
 * Builds the only persisted capsule shape. Set-like fields are canonicalized
 * before either projection or capsule digest is calculated; ordered workflow
 * and acceptance sequences retain caller order because order is semantic.
 */
export function buildExecutionCapsuleV1(
  args: BuildExecutionCapsuleV1Args,
): ExecutionCapsuleV1 {
  assertText(args.tenant_id, 256, "capsule.applicability.tenant_id");
  assertText(args.scope, 256, "capsule.applicability.scope");
  assertText(args.draft.capsule_id, 256, "capsule_id");
  if (!Number.isSafeInteger(args.capsule_revision) || args.capsule_revision < 1) {
    throw new Error("capsule_revision must be a positive safe integer");
  }
  if (args.capsule_revision === 1) {
    if (args.parent_capsule_sha256 !== null) {
      throw new Error("first capsule revision cannot have a parent digest");
    }
  } else {
    if (args.parent_capsule_sha256 === null) {
      throw new Error("later capsule revision requires a parent digest");
    }
    assertSha256(args.parent_capsule_sha256, "parent_capsule_sha256");
  }
  assertCanonicalUtcMillis(args.draft.created_at, "capsule.created_at");
  if (args.draft.expires_at !== null) {
    assertCanonicalUtcMillis(args.draft.expires_at, "capsule.expires_at");
    if (args.draft.expires_at <= args.draft.created_at) {
      throw new Error("capsule.expires_at must be later than created_at");
    }
  }
  if (!CAPSULE_KINDS.has(args.draft.kind) || !INFLUENCES.has(args.draft.proposed_influence)) {
    throw new Error("capsule kind or proposed influence is invalid");
  }
  if (args.draft.kind === "counter_evidence" && args.draft.proposed_influence === "use") {
    throw new Error("counter-evidence cannot propose direct use");
  }

  assertText(args.source.memory_id, 256, "capsule.source.memory_id");
  assertText(args.source.source_commit_id, 256, "capsule.source.source_commit_id");
  assertSha256(args.source.source_projection_sha256, "capsule.source.source_projection_sha256");

  const applicability = args.draft.applicability;
  assertText(applicability.task_family, 256, "capsule.applicability.task_family");
  assertNullableText(applicability.task_signature, 256, "capsule.applicability.task_signature");
  assertNullableText(applicability.workflow_signature, 256, "capsule.applicability.workflow_signature");
  assertNullableText(applicability.workspace_signature, 256, "capsule.applicability.workspace_signature");
  assertNullableText(applicability.producer_agent_id, 256, "capsule.applicability.producer_agent_id");
  assertNullableText(applicability.owner_agent_id, 256, "capsule.applicability.owner_agent_id");
  assertNullableText(applicability.owner_team_id, 256, "capsule.applicability.owner_team_id");

  assertText(args.draft.projection.summary, 2048, "capsule.projection.summary");
  assertNullableText(args.draft.projection.next_action, 1024, "capsule.projection.next_action");
  assertSequence(args.draft.projection.workflow_steps, 32, 512, "capsule.projection.workflow_step");
  assertSequence(
    args.draft.projection.acceptance_statements,
    32,
    1024,
    "capsule.projection.acceptance_statement",
  );
  const projectionBody = {
    summary: args.draft.projection.summary,
    next_action: args.draft.projection.next_action,
    target_refs: canonicalTargets(args.draft.projection.target_refs),
    workflow_steps: [...args.draft.projection.workflow_steps],
    acceptance_statements: [...args.draft.projection.acceptance_statements],
  };
  assertJsonBytes(projectionBody, 8192, "capsule.projection");
  const projection: ExecutionCapsuleV1["projection"] = {
    ...projectionBody,
    projection_sha256: canonicalContinuationSha256(projectionBody),
  };
  assertJsonBytes(projection, 8192, "capsule.projection");

  const coverageClaims = canonicalCoverageClaims(args.draft.coverage_claims);
  const preconditionSpecs = canonicalPreconditions(args.draft.precondition_specs);
  const projectionTargetKeys = new Set(projection.target_refs.map(targetKey));
  const specsById = new Map(preconditionSpecs.map((spec) => [spec.probe_id, spec]));
  for (const claim of coverageClaims) {
    if (claim.target_refs.some((target) => !projectionTargetKeys.has(targetKey(target)))) {
      throw new Error("capsule coverage claim target must be present in the bounded projection");
    }
    const expectedObserver = claim.evidence_requirement === "trusted_host"
      ? "trusted_host_collector"
      : claim.evidence_requirement === "external_verifier"
        ? "external_verifier"
        : null;
    for (const probeId of claim.required_probe_ids) {
      const spec = specsById.get(probeId);
      if (!spec || spec.observer !== expectedObserver
        || (spec.required_for !== "admission" && spec.required_for !== "before_action")) {
        throw new Error(
          "capsule coverage claim probe must reference a matching serve-phase precondition",
        );
      }
    }
    if (claim.obligation_kind === "prohibition"
      && args.draft.proposed_influence === "use") {
      throw new Error("a positive direct-use capsule cannot claim prohibition coverage");
    }
  }
  const evidenceRefs = canonicalStrings(args.draft.evidence_refs, 32, 256, "capsule.evidence_ref");
  const verifierRefs = canonicalStrings(args.draft.verifier_refs, 32, 256, "capsule.verifier_ref");
  const conflictsWith = canonicalCapsuleRefs(args.draft.conflicts_with, "capsule.conflicts_with");
  const supersedes = canonicalCapsuleRefs(args.draft.supersedes, "capsule.supersedes");
  const conflicts = new Set(conflictsWith.map(capsuleRefKey));
  if (supersedes.some((ref) => conflicts.has(capsuleRefKey(ref)))) {
    throw new Error("a capsule reference cannot be both a conflict and a supersession");
  }
  const selfPrefix = `${args.draft.capsule_id}\0${args.capsule_revision.toString().padStart(16, "0")}\0`;
  if ([...conflictsWith, ...supersedes].some((ref) => capsuleRefKey(ref).startsWith(selfPrefix))) {
    throw new Error("a capsule cannot conflict with or supersede itself");
  }
  assertJsonBytes(preconditionSpecs, 65_536, "capsule.precondition_specs");
  assertJsonBytes(coverageClaims, 65_536, "capsule.coverage_claims");
  assertJsonBytes(conflictsWith, 16_384, "capsule.conflicts_with");
  assertJsonBytes(supersedes, 16_384, "capsule.supersedes");

  const capsuleBody = {
    schema_version: "execution_capsule_v1" as const,
    capsule_id: args.draft.capsule_id,
    capsule_revision: args.capsule_revision,
    created_at: args.draft.created_at,
    parent_capsule_sha256: args.parent_capsule_sha256,
    source: { ...args.source },
    kind: args.draft.kind,
    proposed_influence: args.draft.proposed_influence,
    applicability: {
      tenant_id: args.tenant_id,
      scope: args.scope,
      ...applicability,
    },
    projection,
    coverage_claims: coverageClaims,
    precondition_specs: preconditionSpecs,
    evidence_refs: evidenceRefs,
    verifier_refs: verifierRefs,
    conflicts_with: conflictsWith,
    supersedes,
    expires_at: args.draft.expires_at,
  };
  assertJsonBytes(capsuleBody, 131_072, "execution capsule");
  const capsule: ExecutionCapsuleV1 = {
    ...capsuleBody,
    capsule_sha256: canonicalContinuationSha256(capsuleBody),
  };
  assertJsonBytes(capsule, 131_072, "execution capsule");
  assertExecutionCapsuleV1(capsule);
  return canonicalContinuationClone(capsule);
}
