import { z } from "zod";
import type {
  ExecutionCapsuleV1,
  HostObservationV1,
  TypedPreconditionSpecV1,
} from "./contract.js";
import { canonicalContinuationSha256 } from "./contract.js";
import { continuationAuthoritySubjectSha256V1 } from "./task-envelope.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_UTC_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PROBE_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_POLICY_AGE_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_HOST_TASK_ENVELOPE_LIFETIME_MS = 24 * 60 * 60 * 1000;

function containsOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedText(maxBytes: number) {
  return z.string().min(1).superRefine((value, context) => {
    if (value !== value.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "must not have leading or trailing whitespace" });
    }
    if (value.includes("\0")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain NUL" });
    }
    if (!containsOnlyUnicodeScalars(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "must contain only Unicode scalar values" });
    }
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `must be at most ${maxBytes} UTF-8 bytes` });
    }
  });
}

const idSchema = boundedText(256);
const referenceSchema = boundedText(1_024);
const sha256Schema = z.string().regex(SHA256_PATTERN, "must be a lowercase SHA-256 digest");
const safePositiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const safeNonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const canonicalUtcMillisSchema = z.string()
  .regex(CANONICAL_UTC_MILLIS_PATTERN, "must be a canonical UTC millisecond timestamp")
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, {
    message: "must be a real canonical UTC millisecond timestamp",
  });

const hostTaskEnvelopeSchema = z.object({
  schema_version: z.literal("host_task_envelope_v1"),
  tenant_id: idSchema,
  scope: idSchema,
  authority_subject_sha256: sha256Schema,
  host_task_id: idSchema,
  episode_id: idSchema,
  run_id: idSchema,
  consumer_agent_id: idSchema.nullable(),
  consumer_team_id: idSchema.nullable(),
  task_family: idSchema,
  task_signature: boundedText(512),
  workflow_signature: boundedText(512).nullable(),
  workspace_signature: boundedText(512),
  source_task_sha256: sha256Schema,
  source_event_sha256: sha256Schema,
  issued_at: canonicalUtcMillisSchema,
  expires_at: canonicalUtcMillisSchema,
  host_task_envelope_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const lifetimeMs = Date.parse(value.expires_at) - Date.parse(value.issued_at);
  if (lifetimeMs <= 0 || lifetimeMs > MAX_HOST_TASK_ENVELOPE_LIFETIME_MS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "host task envelope lifetime must be positive and at most 24 hours",
    });
  }
  if (value.authority_subject_sha256 !== continuationAuthoritySubjectSha256V1({
    tenant_id: value.tenant_id,
    scope: value.scope,
    task_family: value.task_family,
  })) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority_subject_sha256"],
      message: "authority subject must bind envelope tenant, scope, and task family",
    });
  }
});

function addDuplicateIssues(
  values: readonly unknown[],
  key: (value: unknown) => string,
  context: z.RefinementCtx,
  message: string,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const itemKey = key(values[index]);
    if (seen.has(itemKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message });
    }
    seen.add(itemKey);
  }
}

const targetRefSchema = z.object({
  kind: z.enum(["artifact", "service", "capability", "memory", "workflow", "external_resource"]),
  ref: referenceSchema,
}).strict();

const capsuleRefSchema = z.object({
  capsule_id: idSchema,
  capsule_revision: safePositiveIntegerSchema,
  capsule_sha256: sha256Schema,
}).strict();

function capsuleRefKey(value: z.infer<typeof capsuleRefSchema>): string {
  return `${value.capsule_id}\0${value.capsule_revision}\0${value.capsule_sha256}`;
}

const authorityBranchRefSchema = z.object({
  branch_id: idSchema,
  branch_revision: safePositiveIntegerSchema,
  manifest_sha256: sha256Schema,
}).strict();

const authorityArtifactRefSchema = z.object({
  artifact_sha256: sha256Schema,
  payload_sha256: sha256Schema,
}).strict();

const authorityBranchRevisionRefSchema = z.object({
  branch_id: idSchema,
  branch_revision: safePositiveIntegerSchema,
  manifest_sha256: sha256Schema,
  branch_kind: z.enum(["authoritative", "candidate"]),
  state: z.enum(["authoritative", "active_candidate"]),
}).strict().superRefine((value, context) => {
  if ((value.branch_kind === "authoritative" && value.state !== "authoritative")
    || (value.branch_kind === "candidate" && value.state !== "active_candidate")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "branch revision kind/state is inconsistent",
    });
  }
});

const servingAssignmentBasisSchema = z.object({
  schema_version: z.literal("serving_assignment_basis_v1"),
  experiment_cohort_ref: authorityArtifactRefSchema,
  create_continuation_operation_id: idSchema,
  operation_request_sha256: sha256Schema,
  decision_id: idSchema,
  episode_id: idSchema,
  run_id: idSchema,
  host_task_id: idSchema,
  host_task_envelope_sha256: sha256Schema,
  host_principal_sha256: sha256Schema,
  task_family: idSchema,
  source_task_sha256: sha256Schema,
  world_snapshot_ref: z.object({
    world_snapshot_id: idSchema,
    world_snapshot_sha256: sha256Schema,
  }).strict(),
  memory_scope_head_ref: z.object({
    revision: safePositiveIntegerSchema,
    head_sha256: sha256Schema,
  }).strict(),
}).strict();

const servingAssignmentReceiptSchema = z.object({
  schema_version: z.literal("serving_assignment_receipt_v1"),
  tenant_id: idSchema,
  scope: idSchema,
  cohort_id: idSchema,
  authority_subject_sha256: sha256Schema,
  experiment_cohort_ref: authorityArtifactRefSchema,
  arm: z.enum(["control", "candidate"]),
  control_learning_ref: authorityBranchRevisionRefSchema,
  candidate_learning_ref: authorityBranchRevisionRefSchema,
  served_learning_ref: authorityBranchRevisionRefSchema,
  compiler_policy_ref: authorityArtifactRefSchema,
  evidence_policy_ref: authorityArtifactRefSchema,
  assignment_basis: servingAssignmentBasisSchema,
  assignment_basis_sha256: sha256Schema,
  assignment_draw_sha256: sha256Schema,
  assigned_at: canonicalUtcMillisSchema,
  serving_assignment_receipt_sha256: sha256Schema,
}).strict();

function authorityBranchRefKey(value: z.infer<typeof authorityBranchRefSchema>): string {
  return `${value.branch_id}\0${value.branch_revision}\0${value.manifest_sha256}`;
}

const probeCommonShape = {
  probe_id: idSchema,
  required_for: z.enum(["admission", "before_action", "before_merge", "before_complete"]),
  observer: z.enum(["trusted_host_collector", "external_verifier"]),
  max_age_ms: z.number().int().min(1).max(MAX_PROBE_AGE_MS),
  on_unknown: z.enum(["inspect", "rehydrate", "block"]),
  on_unsatisfied: z.enum(["block", "quarantine", "expire"]),
} as const;

const artifactPreconditionSchema = z.object({
  ...probeCommonShape,
  kind: z.literal("artifact"),
  workspace_id: idSchema,
  relative_path: boundedText(1_024).refine((value) => {
    const segments = value.split("/");
    return !value.startsWith("/")
      && !value.includes("\\")
      && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }, { message: "must be a repository-relative POSIX path without traversal" }),
  expected_presence: z.enum(["present", "absent"]),
  expected_kind: z.enum(["file", "directory"]).nullable(),
  expected_content_sha256: sha256Schema.nullable(),
}).strict();

const workspacePreconditionSchema = z.object({
  ...probeCommonShape,
  kind: z.literal("workspace"),
  workspace_id: idSchema,
  expected_revision: boundedText(512).nullable(),
  expected_tree_sha256: sha256Schema.nullable(),
  dirty_state: z.enum(["clean", "dirty", "either"]),
}).strict();

const verifierPreconditionSchema = z.object({
  ...probeCommonShape,
  kind: z.literal("verifier"),
  verifier_id: idSchema,
  config_sha256: sha256Schema,
  expected_result: z.literal("passed"),
  require_fresh_process: z.boolean(),
  require_after_agent_exit: z.boolean(),
}).strict();

const servicePreconditionSchema = z.object({
  ...probeCommonShape,
  kind: z.literal("service"),
  endpoint_id: idSchema.refine((value) => !value.includes("://"), {
    message: "must be a registered endpoint id, not a URL",
  }),
  protocol: z.enum(["http", "https", "tcp", "process"]),
  expected_health: z.literal("healthy"),
  require_external_visibility: z.boolean(),
  require_after_agent_exit: z.boolean(),
}).strict();

const capabilityPreconditionSchema = z.object({
  ...probeCommonShape,
  kind: z.literal("capability"),
  capability_id: idSchema,
  expected_version: boundedText(120).nullable(),
  expected_presence: z.enum(["present", "absent"]),
}).strict();

const typedPreconditionSpecSchema = z.discriminatedUnion("kind", [
  artifactPreconditionSchema,
  workspacePreconditionSchema,
  verifierPreconditionSchema,
  servicePreconditionSchema,
  capabilityPreconditionSchema,
]).superRefine((value, context) => {
  if (value.kind === "artifact" && value.expected_presence === "absent"
    && (value.expected_kind !== null || value.expected_content_sha256 !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an absent artifact must not declare a kind or content digest",
    });
  }
  if (value.kind === "capability" && value.expected_presence === "absent"
    && value.expected_version !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an absent capability must not declare a version",
    });
  }
});

const artifactObservationValueSchema = z.object({
  kind: z.literal("artifact"),
  presence: z.enum(["present", "absent"]),
  artifact_kind: z.enum(["file", "directory"]).nullable(),
  content_sha256: sha256Schema.nullable(),
}).strict();

const workspaceObservationValueSchema = z.object({
  kind: z.literal("workspace"),
  revision: boundedText(512).nullable(),
  tree_sha256: sha256Schema.nullable(),
  dirty_state: z.enum(["clean", "dirty"]),
}).strict();

const verifierObservationValueSchema = z.object({
  kind: z.literal("verifier"),
  verifier_id: idSchema,
  config_sha256: sha256Schema,
  result: z.enum(["passed", "failed"]),
  fresh_process: z.boolean(),
  after_agent_exit: z.boolean(),
}).strict();

const serviceObservationValueSchema = z.object({
  kind: z.literal("service"),
  endpoint_id: idSchema,
  protocol: z.enum(["http", "https", "tcp", "process"]),
  health: z.enum(["healthy", "unhealthy"]),
  externally_visible: z.boolean(),
  after_agent_exit: z.boolean(),
}).strict();

const capabilityObservationValueSchema = z.object({
  kind: z.literal("capability"),
  capability_id: idSchema,
  version: boundedText(120).nullable(),
  presence: z.enum(["present", "absent"]),
}).strict();

const hostObservationValueSchema = z.discriminatedUnion("kind", [
  artifactObservationValueSchema,
  workspaceObservationValueSchema,
  verifierObservationValueSchema,
  serviceObservationValueSchema,
  capabilityObservationValueSchema,
]).superRefine((value, context) => {
  if (value.kind === "artifact") {
    if (value.presence === "absent" && (value.artifact_kind !== null || value.content_sha256 !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an absent artifact observation must not contain artifact metadata",
      });
    }
    if (value.presence === "present" && value.artifact_kind === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a present artifact observation must identify the artifact kind",
      });
    }
  }
  if (value.kind === "capability" && value.presence === "absent" && value.version !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an absent capability observation must not contain a version",
    });
  }
});

const hostObservationSchema = z.object({
  schema_version: z.literal("host_observation_v1"),
  observation_id: idSchema,
  probe_id: idSchema,
  probe_spec_sha256: sha256Schema,
  observer: z.enum(["trusted_host_collector", "external_verifier"]),
  observer_principal_sha256: sha256Schema,
  host_task_envelope_sha256: sha256Schema,
  world_snapshot_id: idSchema,
  observed_at: canonicalUtcMillisSchema,
  expires_at: canonicalUtcMillisSchema,
  value: hostObservationValueSchema,
  evidence_sha256: sha256Schema,
  attestation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("authenticated_collector"),
    }).strict(),
    z.object({
      kind: z.literal("ed25519"),
      public_key_spki_base64url: boundedText(128),
      signature: boundedText(128),
    }).strict(),
  ]),
  observation_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expires_at) < Date.parse(value.observed_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "must not precede observed_at",
    });
  }
  if ((value.observer === "trusted_host_collector")
    !== (value.attestation.kind === "authenticated_collector")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attestation"],
      message: "collector observations require collector attestation; other roles require Ed25519",
    });
  }
});

const worldObservationSnapshotSchema = z.object({
  schema_version: z.literal("world_observation_snapshot_v1"),
  tenant_id: idSchema,
  scope: idSchema,
  authority_subject_sha256: sha256Schema,
  world_snapshot_id: idSchema,
  host_task_envelope: hostTaskEnvelopeSchema,
  collection_principal_sha256: sha256Schema,
  observations: z.array(hostObservationSchema).max(2_048),
  observed_from: canonicalUtcMillisSchema,
  observed_through: canonicalUtcMillisSchema,
  expires_at: canonicalUtcMillisSchema,
  created_at: canonicalUtcMillisSchema,
  world_snapshot_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  addDuplicateIssues(
    value.observations,
    (item) => (item as z.infer<typeof hostObservationSchema>).observation_id,
    context,
    "duplicate observation id",
  );
  addDuplicateIssues(
    value.observations,
    (item) => (item as z.infer<typeof hostObservationSchema>).probe_id,
    context,
    "multiple observations for one probe are not allowed in one snapshot",
  );
  if (value.observed_from > value.observed_through
    || value.observed_through > value.created_at
    || value.created_at >= value.expires_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "world observation snapshot time window is invalid",
    });
  }
  if (value.host_task_envelope.tenant_id !== value.tenant_id
    || value.host_task_envelope.scope !== value.scope
    || value.host_task_envelope.authority_subject_sha256
      !== value.authority_subject_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "snapshot authenticated domain must match its task envelope",
    });
  }
});

const continuationObligationSchema = z.object({
  obligation_id: idSchema,
  kind: z.enum(["active_goal", "required_state", "next_action", "must_hold", "prohibition", "verification"]),
  requirement: z.enum(["hard", "advisory"]),
  statement: boundedText(1_024),
  target_refs: z.array(targetRefSchema).min(1).max(16),
  required_probe_ids: z.array(idSchema).max(16),
  evidence_requirement: z.enum(["runtime_state", "trusted_host", "external_verifier"]),
  source_refs: z.array(idSchema).max(32),
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.target_refs, (item) => {
    const target = item as z.infer<typeof targetRefSchema>;
    return `${target.kind}\0${target.ref}`;
  }, context, "duplicate target ref");
  addDuplicateIssues(value.required_probe_ids, (item) => String(item), context, "duplicate required probe id");
  addDuplicateIssues(value.source_refs, (item) => String(item), context, "duplicate source ref");
  if (value.evidence_requirement !== "runtime_state" && value.required_probe_ids.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["required_probe_ids"],
      message: "non-runtime evidence requires at least one typed probe",
    });
  }
  if (value.evidence_requirement === "runtime_state" && value.required_probe_ids.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["required_probe_ids"],
      message: "runtime state is authenticated by database lineage, not a caller observation",
    });
  }
});

const projectionSchema = z.object({
  summary: boundedText(2_048),
  next_action: boundedText(1_024).nullable(),
  target_refs: z.array(targetRefSchema).max(16),
  workflow_steps: z.array(boundedText(512)).max(32),
  acceptance_statements: z.array(boundedText(1_024)).max(32),
  projection_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.target_refs, (item) => {
    const target = item as z.infer<typeof targetRefSchema>;
    return `${target.kind}\0${target.ref}`;
  }, context, "duplicate projection target ref");
});

const capsuleCoverageClaimSchema = z.object({
  obligation_kind: z.enum([
    "active_goal",
    "required_state",
    "next_action",
    "must_hold",
    "prohibition",
    "verification",
  ]),
  target_refs: z.array(targetRefSchema).min(1).max(16),
  evidence_requirement: z.enum(["runtime_state", "trusted_host", "external_verifier"]),
  required_probe_ids: z.array(idSchema).max(16),
  coverage_claim_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  addDuplicateIssues(value.target_refs, (item) => {
    const target = item as z.infer<typeof targetRefSchema>;
    return `${target.kind}\0${target.ref}`;
  }, context, "duplicate coverage target ref");
  addDuplicateIssues(
    value.required_probe_ids,
    (item) => String(item),
    context,
    "duplicate coverage probe id",
  );
  if ((value.evidence_requirement === "runtime_state")
      !== (value.required_probe_ids.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["required_probe_ids"],
      message: "runtime-state coverage has no probes; observed coverage requires probes",
    });
  }
  const expectedSha = canonicalContinuationSha256({
    obligation_kind: value.obligation_kind,
    target_refs: value.target_refs,
    evidence_requirement: value.evidence_requirement,
    required_probe_ids: value.required_probe_ids,
  });
  if (expectedSha !== value.coverage_claim_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coverage_claim_sha256"],
      message: "coverage claim digest mismatch",
    });
  }
});

const executionCapsuleSchema = z.object({
  schema_version: z.literal("execution_capsule_v1"),
  capsule_id: idSchema,
  capsule_revision: safePositiveIntegerSchema,
  capsule_sha256: sha256Schema,
  created_at: canonicalUtcMillisSchema,
  parent_capsule_sha256: sha256Schema.nullable(),
  source: z.object({
    memory_id: idSchema,
    source_commit_id: idSchema,
    source_projection_sha256: sha256Schema,
  }).strict(),
  kind: z.enum([
    "current_state",
    "verified_fact",
    "procedure",
    "constraint",
    "counter_evidence",
    "rehydration_pointer",
  ]),
  proposed_influence: z.enum(["use", "inspect", "block", "rehydrate"]),
  applicability: z.object({
    tenant_id: idSchema,
    scope: idSchema,
    task_family: idSchema,
    task_signature: idSchema.nullable(),
    workflow_signature: idSchema.nullable(),
    workspace_signature: idSchema.nullable(),
    producer_agent_id: idSchema.nullable(),
    owner_agent_id: idSchema.nullable(),
    owner_team_id: idSchema.nullable(),
  }).strict(),
  projection: projectionSchema,
  coverage_claims: z.array(capsuleCoverageClaimSchema).min(1).max(32),
  precondition_specs: z.array(typedPreconditionSpecSchema).max(16),
  evidence_refs: z.array(idSchema).max(32),
  verifier_refs: z.array(idSchema).max(32),
  conflicts_with: z.array(capsuleRefSchema).max(16),
  supersedes: z.array(capsuleRefSchema).max(16),
  expires_at: canonicalUtcMillisSchema.nullable(),
}).strict().superRefine((value, context) => {
  addDuplicateIssues(
    value.coverage_claims,
    (item) => (item as z.infer<typeof capsuleCoverageClaimSchema>).coverage_claim_sha256,
    context,
    "duplicate coverage claim",
  );
  addDuplicateIssues(value.precondition_specs, (item) => {
    return (item as z.infer<typeof typedPreconditionSpecSchema>).probe_id;
  }, context, "duplicate precondition probe id");
  addDuplicateIssues(value.evidence_refs, (item) => String(item), context, "duplicate evidence ref");
  addDuplicateIssues(value.verifier_refs, (item) => String(item), context, "duplicate verifier ref");
  addDuplicateIssues(value.conflicts_with, (item) => capsuleRefKey(item as z.infer<typeof capsuleRefSchema>), context, "duplicate conflict ref");
  addDuplicateIssues(value.supersedes, (item) => capsuleRefKey(item as z.infer<typeof capsuleRefSchema>), context, "duplicate supersedes ref");
  const selfKey = capsuleRefKey(value);
  if (value.conflicts_with.some((item) => capsuleRefKey(item) === selfKey)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts_with"], message: "capsule cannot conflict with itself" });
  }
  if (value.supersedes.some((item) => capsuleRefKey(item) === selfKey)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["supersedes"], message: "capsule cannot supersede itself" });
  }
  if (value.kind === "counter_evidence" && value.proposed_influence === "use") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposed_influence"],
      message: "counter-evidence cannot be proposed for positive direct use",
    });
  }
  const projectionTargets = new Set(value.projection.target_refs.map((target) =>
    `${target.kind}\0${target.ref}`));
  const specsById = new Map(value.precondition_specs.map((spec) => [spec.probe_id, spec]));
  for (const [claimIndex, claim] of value.coverage_claims.entries()) {
    if (claim.target_refs.some((target) =>
      !projectionTargets.has(`${target.kind}\0${target.ref}`))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage_claims", claimIndex, "target_refs"],
        message: "coverage target must be present in capsule projection",
      });
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
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["coverage_claims", claimIndex, "required_probe_ids"],
          message: "coverage probe must reference a matching serve-phase precondition",
        });
      }
    }
    if (claim.obligation_kind === "prohibition" && value.proposed_influence === "use") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage_claims", claimIndex, "obligation_kind"],
        message: "positive direct-use capsules cannot claim prohibition coverage",
      });
    }
  }
  if (value.expires_at !== null && Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "must be later than created_at" });
  }
});

const branchBindingSchema = z.object({
  capsule: capsuleRefSchema,
  branch_ref: authorityBranchRefSchema,
  disposition: z.enum(["include", "exclude", "prohibit"]),
  admission_authority: z.enum(["candidate", "authoritative"]),
  binding_sha256: sha256Schema,
}).strict();

const continuityBindingSchema = z.object({
  capsule: capsuleRefSchema,
  disposition: z.enum(["include", "prohibit"]),
  admission_authority: z.enum(["verified", "authoritative"]),
  memory_id: idSchema,
  capsule_source_commit_id: idSchema,
  memory_scope_head_revision: safePositiveIntegerSchema,
  memory_scope_head_sha256: sha256Schema,
  binding_sha256: sha256Schema,
}).strict();

const candidateProvenanceSchema = z.discriminatedUnion("lane", [
  z.object({
    lane: z.literal("governed_learning"),
    branch_binding: branchBindingSchema,
  }).strict(),
  z.object({
    lane: z.literal("verified_continuity"),
    continuity_binding: continuityBindingSchema,
  }).strict(),
]);

const lifecycleFactSchema = z.object({
  memory_id: idSchema,
  lifecycle_source_commit_id: idSchema,
  memory_projection_sha256: sha256Schema,
  lifecycle: z.enum(["active", "suppressed", "archived", "quarantined"]),
  memory_scope_head_revision: safePositiveIntegerSchema,
  memory_scope_head_sha256: sha256Schema,
  row_sha256: sha256Schema,
}).strict();

const compilerCandidateSchema = z.object({
  capsule: executionCapsuleSchema,
  provenance: candidateProvenanceSchema,
  lifecycle_fact: lifecycleFactSchema,
}).strict().superRefine((value, context) => {
  const outerRefKey = capsuleRefKey(value.capsule);
  const binding = value.provenance.lane === "governed_learning"
    ? value.provenance.branch_binding
    : value.provenance.continuity_binding;
  if (capsuleRefKey(binding.capsule) !== outerRefKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance"],
      message: "candidate provenance must bind the exact capsule revision",
    });
  }
  if (value.lifecycle_fact.memory_id !== value.capsule.source.memory_id
    || value.lifecycle_fact.memory_projection_sha256
      !== value.capsule.source.source_projection_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lifecycle_fact"],
      message: "lifecycle fact must bind the capsule source revision",
    });
  }
  if (value.provenance.lane === "governed_learning") {
    if (value.capsule.kind !== "procedure" && value.capsule.kind !== "counter_evidence") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "lane"],
        message: "governed learning lane accepts only learning capsule kinds",
      });
    }
  } else if ((value.capsule.kind !== "current_state"
      && value.capsule.kind !== "verified_fact"
      && value.capsule.kind !== "constraint")
    || value.provenance.continuity_binding.memory_id
      !== value.lifecycle_fact.memory_id
    || value.provenance.continuity_binding.capsule_source_commit_id
      !== value.capsule.source.source_commit_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance"],
      message: "verified continuity lane must bind an exact continuity memory fact",
    });
  }
});

const identitySchema = z.object({
  decision_id: idSchema,
  tenant_id: idSchema,
  scope: idSchema,
  episode_id: idSchema,
  run_id: idSchema,
  host_task_id: idSchema,
  host_task_envelope_sha256: sha256Schema,
  collection_principal_sha256: sha256Schema,
  consumer_agent_id: idSchema.nullable(),
  consumer_team_id: idSchema.nullable(),
  task_family: idSchema,
  task_signature: idSchema,
  workflow_signature: idSchema.nullable(),
  workspace_signature: idSchema,
  source_task_sha256: sha256Schema,
  source_event_sha256: sha256Schema,
  world_snapshot_id: idSchema,
  world_snapshot_sha256: sha256Schema,
}).strict();

const authoritySchema = z.object({
  authority_subject_sha256: sha256Schema,
  authoritative_learning_head: authorityBranchRefSchema,
  served_learning_branch: authorityBranchRefSchema,
  serving_mode: z.enum([
    "authoritative_unassigned", "assigned_control", "assigned_candidate",
  ]),
  experiment_cohort_ref: authorityArtifactRefSchema.nullable(),
  serving_assignment_receipt: servingAssignmentReceiptSchema.nullable(),
  compiler_policy_ref: authorityArtifactRefSchema,
  evidence_policy_ref: authorityArtifactRefSchema,
  memory_scope_head_revision: safePositiveIntegerSchema,
  memory_scope_head_sha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const sameBranch = authorityBranchRefKey(value.authoritative_learning_head)
    === authorityBranchRefKey(value.served_learning_branch);
  if (value.serving_mode === "authoritative_unassigned" && (
    !sameBranch
    || value.experiment_cohort_ref !== null
    || value.serving_assignment_receipt !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unassigned serving must use the authoritative learning head without cohort authority",
    });
  }
  if (value.serving_mode !== "authoritative_unassigned") {
    const receipt = value.serving_assignment_receipt;
    const expectedArm = value.serving_mode === "assigned_control"
      ? "control"
      : "candidate";
    const invalid = value.experiment_cohort_ref === null
      || receipt === null
      || receipt.arm !== expectedArm
      || (value.serving_mode === "assigned_control" ? !sameBranch : sameBranch)
      || (receipt !== null && (
        authorityBranchRefKey(receipt.control_learning_ref)
          !== authorityBranchRefKey(value.authoritative_learning_head)
        || authorityBranchRefKey(receipt.served_learning_ref)
          !== authorityBranchRefKey(value.served_learning_branch)
        || receipt.authority_subject_sha256 !== value.authority_subject_sha256
        || receipt.compiler_policy_ref.artifact_sha256
          !== value.compiler_policy_ref.artifact_sha256
        || receipt.compiler_policy_ref.payload_sha256
          !== value.compiler_policy_ref.payload_sha256
        || receipt.evidence_policy_ref.artifact_sha256
          !== value.evidence_policy_ref.artifact_sha256
        || receipt.evidence_policy_ref.payload_sha256
          !== value.evidence_policy_ref.payload_sha256
        || value.experiment_cohort_ref === null
        || receipt.experiment_cohort_ref.artifact_sha256
          !== value.experiment_cohort_ref.artifact_sha256
        || receipt.experiment_cohort_ref.payload_sha256
          !== value.experiment_cohort_ref.payload_sha256
      ));
    if (invalid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
        message: "assigned serving must bind its exact cohort, arm, learning refs, policies, and receipt",
    });
    }
  }
});

const trustedObserverPrincipalsSchema = z.object({
  trusted_host_collector: z.array(sha256Schema).max(64),
  external_verifier: z.array(sha256Schema).max(64),
}).strict().superRefine((value, context) => {
  for (const role of ["trusted_host_collector", "external_verifier"] as const) {
    addDuplicateIssues(value[role], (item) => String(item), context, `duplicate ${role} principal`);
  }
});

const compilerPolicySchema = z.object({
  schema_version: z.literal("continuation_compiler_policy_v1"),
  tenant_id: idSchema,
  authority_subject_sha256: sha256Schema.nullable(),
  candidate_limit: z.number().int().min(2).max(256),
  continuity_candidate_limit: z.number().int().min(1).max(255),
  learning_candidate_limit: z.number().int().min(1).max(255),
  selected_capsule_limit: z.number().int().min(1).max(64),
  obligation_limit: z.number().int().min(1).max(64),
  max_render_budget: z.number().int().min(1_024).max(65_536),
  hard_coverage_weight: z.number().int().min(0).max(1_000_000),
  advisory_coverage_weight: z.number().int().min(0).max(1_000_000),
  authority_bonus: z.object({
    candidate: z.number().int().min(0).max(1_000_000),
    verified: z.number().int().min(0).max(1_000_000),
    authoritative: z.number().int().min(0).max(1_000_000),
  }).strict(),
  freshness_bonus: z.tuple([
    safeNonNegativeIntegerSchema.max(1_000_000),
    safeNonNegativeIntegerSchema.max(1_000_000),
    safeNonNegativeIntegerSchema.max(1_000_000),
    safeNonNegativeIntegerSchema.max(1_000_000),
  ]),
  freshness_max_age_ms: z.tuple([
    z.number().int().min(1).max(MAX_POLICY_AGE_MS),
    z.number().int().min(1).max(MAX_POLICY_AGE_MS),
    z.number().int().min(1).max(MAX_POLICY_AGE_MS),
  ]),
  trusted_observer_principals: trustedObserverPrincipalsSchema,
}).strict().superRefine((value, context) => {
  const ages = value.freshness_max_age_ms;
  if (!(ages[0] < ages[1] && ages[1] < ages[2])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["freshness_max_age_ms"],
      message: "freshness thresholds must be strictly increasing",
    });
  }
  if (value.continuity_candidate_limit + value.learning_candidate_limit
    !== value.candidate_limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate_limit"],
      message: "lane candidate limits must sum exactly to candidate_limit",
    });
  }
  if (value.selected_capsule_limit > value.candidate_limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selected_capsule_limit"],
      message: "selected capsule limit must not exceed candidate limit",
    });
  }
});

const compileContinuationV1ArgsSchema = z.object({
  schema_version: z.literal("continuation_compile_input_v1"),
  identity: identitySchema,
  authority: authoritySchema,
  obligations: z.array(continuationObligationSchema).max(64),
  candidates: z.array(compilerCandidateSchema).max(256),
  candidate_retrieval_receipt: z.unknown(),
  observation_snapshot: worldObservationSnapshotSchema,
  compiled_at: canonicalUtcMillisSchema,
  render_budget: z.number().int().min(1_024).max(65_536),
  policy: compilerPolicySchema,
}).strict().superRefine((value, context) => {
  if (value.obligations.length > value.policy.obligation_limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["obligations"],
      message: "obligation count exceeds compiler policy",
    });
  }
  if (value.obligations.filter((item) => item.requirement === "hard").length > 32) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["obligations"],
      message: "hard obligation count exceeds 32",
    });
  }
  if (value.candidates.length > value.policy.candidate_limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate count exceeds compiler policy",
    });
  }
  if (value.render_budget > value.policy.max_render_budget) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["render_budget"],
      message: "render budget exceeds compiler policy",
    });
  }

  addDuplicateIssues(value.obligations, (item) => {
    return (item as z.infer<typeof continuationObligationSchema>).obligation_id;
  }, context, "duplicate obligation id");
  addDuplicateIssues(value.candidates, (item) => {
    return capsuleRefKey((item as z.infer<typeof compilerCandidateSchema>).capsule);
  }, context, "duplicate capsule revision");
  addDuplicateIssues(value.candidates, (item) => {
    return (item as z.infer<typeof compilerCandidateSchema>).capsule.capsule_id;
  }, context, "multiple revisions of one capsule are not allowed in one candidate universe");

  const candidateKeys = new Set(value.candidates.map((item) => capsuleRefKey(item.capsule)));
  const servedBranchKey = authorityBranchRefKey(
    value.authority.served_learning_branch,
  );
  for (let index = 0; index < value.candidates.length; index += 1) {
    const candidate = value.candidates[index];
    if (candidate.provenance.lane === "governed_learning"
      && authorityBranchRefKey(candidate.provenance.branch_binding.branch_ref)
        !== servedBranchKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates", index, "provenance", "branch_binding", "branch_ref"],
        message: "learning candidate must match the served learning branch",
      });
    }
    if (candidate.lifecycle_fact.memory_scope_head_revision !== value.authority.memory_scope_head_revision
      || candidate.lifecycle_fact.memory_scope_head_sha256 !== value.authority.memory_scope_head_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates", index, "lifecycle_fact"],
        message: "candidate lifecycle fact must be inside the contract memory-head fence",
      });
    }
    if (candidate.provenance.lane === "verified_continuity"
      && (candidate.provenance.continuity_binding.memory_scope_head_revision
          !== value.authority.memory_scope_head_revision
        || candidate.provenance.continuity_binding.memory_scope_head_sha256
          !== value.authority.memory_scope_head_sha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates", index, "provenance", "continuity_binding"],
        message: "continuity candidate must bind the exact contract memory head",
      });
    }
    for (const conflictRef of candidate.capsule.conflicts_with) {
      if (!candidateKeys.has(capsuleRefKey(conflictRef))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "capsule", "conflicts_with"],
          message: "conflict ref must resolve inside the bounded candidate universe",
        });
      }
    }
  }

  const snapshot = value.observation_snapshot;
  const envelope = snapshot.host_task_envelope;
  if (snapshot.tenant_id !== value.identity.tenant_id
    || snapshot.scope !== value.identity.scope
    || snapshot.authority_subject_sha256 !== value.authority.authority_subject_sha256
    || envelope.tenant_id !== value.identity.tenant_id
    || envelope.scope !== value.identity.scope
    || envelope.authority_subject_sha256 !== value.authority.authority_subject_sha256
    || snapshot.world_snapshot_id !== value.identity.world_snapshot_id
    || snapshot.world_snapshot_sha256 !== value.identity.world_snapshot_sha256
    || snapshot.collection_principal_sha256 !== value.identity.collection_principal_sha256
    || envelope.host_task_id !== value.identity.host_task_id
    || envelope.host_task_envelope_sha256 !== value.identity.host_task_envelope_sha256
    || envelope.episode_id !== value.identity.episode_id
    || envelope.run_id !== value.identity.run_id
    || envelope.consumer_agent_id !== value.identity.consumer_agent_id
    || envelope.consumer_team_id !== value.identity.consumer_team_id
    || envelope.task_family !== value.identity.task_family
    || envelope.task_signature !== value.identity.task_signature
    || envelope.workflow_signature !== value.identity.workflow_signature
    || envelope.workspace_signature !== value.identity.workspace_signature
    || envelope.source_task_sha256 !== value.identity.source_task_sha256
    || envelope.source_event_sha256 !== value.identity.source_event_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observation_snapshot"],
      message: "world observation snapshot must bind the exact continuation identity",
    });
  }
  if (value.compiled_at < snapshot.created_at || value.compiled_at >= snapshot.expires_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["compiled_at"],
      message: "compilation must occur inside the world observation snapshot window",
    });
  }
  if (!value.policy.trusted_observer_principals.trusted_host_collector
    .includes(snapshot.collection_principal_sha256)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observation_snapshot", "collection_principal_sha256"],
      message: "snapshot collector is not a trusted host collector",
    });
  }
  for (let index = 0; index < snapshot.observations.length; index += 1) {
    const observation = snapshot.observations[index];
    if (observation.host_task_envelope_sha256 !== value.identity.host_task_envelope_sha256
      || observation.world_snapshot_id !== value.identity.world_snapshot_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observation_snapshot", "observations", index],
        message: "observation must bind the current task envelope and world snapshot",
      });
    }
  }

  const observationsJsonBytes = Buffer.byteLength(JSON.stringify(snapshot.observations), "utf8");
  if (observationsJsonBytes > 262_144) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observation_snapshot", "observations"],
      message: "observation snapshot exceeds 256 KiB",
    });
  }
  const candidatesJsonBytes = Buffer.byteLength(JSON.stringify(value.candidates), "utf8");
  if (candidatesJsonBytes > 2_097_152) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate universe exceeds 2 MiB",
    });
  }
});

type ValidatedCompileContinuationV1Args = z.infer<typeof compileContinuationV1ArgsSchema>;

export function assertTypedPreconditionSpecV1(value: unknown): asserts value is TypedPreconditionSpecV1 {
  typedPreconditionSpecSchema.parse(value);
}

export function assertHostObservationV1(value: unknown): asserts value is HostObservationV1 {
  hostObservationSchema.parse(value);
}

export function assertExecutionCapsuleV1(value: unknown): asserts value is ExecutionCapsuleV1 {
  executionCapsuleSchema.parse(value);
}

export function assertCompileContinuationV1Args(value: unknown): asserts value is ValidatedCompileContinuationV1Args {
  compileContinuationV1ArgsSchema.parse(value);
}
