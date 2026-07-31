import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  ExecutionSubjectV1Schema,
  StateDeltaV1Schema,
  type ExecutionSubjectV1,
} from "../execution/subject-state-adapter.js";
import { sha256Hex } from "../util/crypto.js";
import {
  HostTaskEnvelopeV1Schema,
} from "../execution/host-task-contract.js";

type PublicScope = string & { readonly __kind: "public_scope" };
type StoreScope = string & { readonly __kind: "store_scope" };

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_UTC_MILLIS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES = 256 * 1024;
export const EXECUTION_EPISODE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function exactBoundedString(
  label: string,
  maxUtf8Bytes: number,
): z.ZodEffects<z.ZodString, string, string> {
  return z.string().superRefine((value, context) => {
    if (
      value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxUtf8Bytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be non-empty, exact, and at most ${maxUtf8Bytes} UTF-8 bytes`,
      });
    }
  });
}

const BoundedIdSchema = exactBoundedString("Identifier", 256);
const BoundedKindSchema = exactBoundedString("Kind", 120);
const BoundedPolicySchema = exactBoundedString("Policy", 256);
const BoundedStorageRefSchema = exactBoundedString("Storage reference", 2048);
const BoundedReasonSchema = exactBoundedString("Reason", 2048);

export const ExecutionEpisodeSha256Schema = z.string().regex(SHA256_PATTERN);
export const ExecutionEpisodeCanonicalUtcTimestampSchema = z.string()
  .regex(CANONICAL_UTC_MILLIS_PATTERN)
  .datetime({ offset: false, precision: 3 });

export const ExecutionEpisodePublicScopeSchema = exactBoundedString(
  "Public scope",
  256,
).transform((value) => value as PublicScope);

export const ExecutionEpisodeStoreScopeSchema = exactBoundedString(
  "Store scope",
  256,
).transform((value) => value as StoreScope);

function canonicalContractDigest<T>(schema: z.ZodType<T>, value: T): string {
  return sha256Hex(stableStringify(schema.parse(value)));
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export const EvidenceArtifactKindV1Schema = z.enum([
  "state_snapshot",
  "feature_vector",
  "prompt",
  "tool_request",
  "tool_result",
  "usage_receipt",
  "workspace_diff",
  "verifier_input",
  "verifier_output",
  "candidate_set",
  "training_dataset",
  "policy_parameters",
  "policy_calibration",
  "procedure_candidate",
  "manifest",
]);

export type EvidenceArtifactKindV1 = z.infer<typeof EvidenceArtifactKindV1Schema>;

export const EvidenceArtifactRefV1Schema = z.object({
  contract_version: z.literal("evidence_artifact_ref_v1"),
  artifact_id: BoundedIdSchema,
  kind: EvidenceArtifactKindV1Schema,
  sha256: ExecutionEpisodeSha256Schema,
  storage_ref: BoundedStorageRefSchema,
  byte_length: z.number().int().nonnegative().max(EXECUTION_EPISODE_MAX_ARTIFACT_BYTES),
  media_type: exactBoundedString("Artifact media type", 255),
  encoding: exactBoundedString("Artifact encoding", 64),
  redaction_policy: BoundedPolicySchema,
  retention_policy: BoundedPolicySchema,
}).strict();

export type EvidenceArtifactRefV1 = z.infer<typeof EvidenceArtifactRefV1Schema>;

const BoundedInlineBase64IngestV1Schema = z.object({
  mode: z.literal("bounded_inline_base64"),
  data: z.string().max(
    Math.ceil(EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES / 3) * 4,
  ),
}).strict();

const FinalizedRuntimeUploadIngestV1Schema = z.object({
  mode: z.literal("finalized_runtime_upload"),
  upload_id: BoundedIdSchema,
  finalize_receipt_digest: ExecutionEpisodeSha256Schema,
}).strict();

export const EvidenceArtifactInputV1Schema = z.object({
  contract_version: z.literal("evidence_artifact_input_v1"),
  kind: EvidenceArtifactKindV1Schema,
  declared_sha256: ExecutionEpisodeSha256Schema,
  declared_byte_length: z.number().int().nonnegative()
    .max(EXECUTION_EPISODE_MAX_ARTIFACT_BYTES),
  media_type: exactBoundedString("Artifact media type", 255),
  encoding: exactBoundedString("Artifact encoding", 64),
  ingest: z.discriminatedUnion("mode", [
    BoundedInlineBase64IngestV1Schema,
    FinalizedRuntimeUploadIngestV1Schema,
  ]),
}).strict().superRefine((value, context) => {
  if (value.ingest.mode !== "bounded_inline_base64") return;
  const decoded = decodeCanonicalBase64(value.ingest.data);
  if (decoded === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ingest", "data"],
      message: "Inline artifact data must be canonical padded base64",
    });
    return;
  }
  if (decoded.byteLength > EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: EXECUTION_EPISODE_MAX_INLINE_ARTIFACT_BYTES,
      inclusive: true,
      type: "array",
      path: ["ingest", "data"],
      message: "Inline artifact exceeds the bounded inline byte limit",
    });
  }
  if (decoded.byteLength !== value.declared_byte_length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["declared_byte_length"],
      message: "Inline artifact byte length does not match the declared length",
    });
  }
  if (sha256Bytes(decoded) !== value.declared_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["declared_sha256"],
      message: "Inline artifact digest does not match the declared SHA-256",
    });
  }
});

export type EvidenceArtifactInputV1 = z.infer<typeof EvidenceArtifactInputV1Schema>;

export function evidenceArtifactRefDigest(value: EvidenceArtifactRefV1): string {
  return canonicalContractDigest(EvidenceArtifactRefV1Schema, value);
}

export function evidenceArtifactInputDigest(value: EvidenceArtifactInputV1): string {
  return canonicalContractDigest(EvidenceArtifactInputV1Schema, value);
}

export const StateSnapshotKindV1Schema = z.enum([
  "workspace",
  "artifact",
  "database",
  "service",
  "data",
]);

export const StateSnapshotV1Schema = z.object({
  contract_version: z.literal("state_snapshot_v1"),
  snapshot_id: BoundedIdSchema,
  algorithm_id: BoundedKindSchema,
  algorithm_version: BoundedKindSchema,
  state_kind: StateSnapshotKindV1Schema,
  environment_digest: ExecutionEpisodeSha256Schema,
  content_digest: ExecutionEpisodeSha256Schema,
  artifact_ref: EvidenceArtifactRefV1Schema,
  captured_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.artifact_ref.kind !== "state_snapshot") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifact_ref", "kind"],
      message: "A state snapshot must reference a state_snapshot artifact",
    });
  }
  if (value.content_digest !== value.artifact_ref.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_digest"],
      message: "State content digest must bind the canonical snapshot artifact",
    });
  }
});

export type StateSnapshotV1 = z.infer<typeof StateSnapshotV1Schema>;

export function stateSnapshotDigest(value: StateSnapshotV1): string {
  return canonicalContractDigest(StateSnapshotV1Schema, value);
}

export const EpisodeBudgetV1Schema = z.object({
  max_steps: z.number().int().positive().max(1_000_000),
  max_tokens: z.number().int().positive().max(1_000_000_000),
  max_cost_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  deadline_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const SubjectStateRootV2Schema = exactBoundedString(
  "Subject state root",
  16 * 1024,
).superRefine((value, context) => {
  const segments = value.split("/");
  if (
    value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("\u0000")
    || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
    || value === ".git"
    || value.startsWith(".git/")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Subject state roots must be canonical root-relative paths outside .git",
    });
  }
});

export const WorkspaceExecutionEpisodeSubjectStateSpecV2Schema = z.object({
  contract_version: z.literal("workspace_subject_state_spec_v2"),
  additional_state_roots: z.array(SubjectStateRootV2Schema).max(256),
}).strict().superRefine((value, context) => {
  let previous: string | null = null;
  for (const [index, root] of value.additional_state_roots.entries()) {
    if (
      previous !== null
      && Buffer.compare(Buffer.from(previous, "utf8"), Buffer.from(root, "utf8"))
        >= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additional_state_roots", index],
        message: "Subject state roots must be unique and sorted by unsigned UTF-8 bytes",
      });
    }
    previous = root;
  }
});

export const StructuredArtifactSubjectStateSpecV1Schema = z.object({
  contract_version:
    z.literal("structured_artifact_subject_state_spec_v1"),
  format: z.literal("json"),
  capture_scope: z.literal("entire_artifact"),
}).strict();

export const SqliteDatabaseSubjectStateSpecV1Schema = z.object({
  contract_version:
    z.literal("sqlite_database_subject_state_spec_v1"),
  capture_scope: z.literal("entire_database"),
}).strict();

export const ExecutionEpisodeSubjectStateSpecV2Schema =
  z.union([
    WorkspaceExecutionEpisodeSubjectStateSpecV2Schema,
    StructuredArtifactSubjectStateSpecV1Schema,
    SqliteDatabaseSubjectStateSpecV1Schema,
  ]);

export type ExecutionEpisodeSubjectStateSpecV2 = z.infer<
  typeof ExecutionEpisodeSubjectStateSpecV2Schema
>;
export type WorkspaceExecutionEpisodeSubjectStateSpecV2 = z.infer<
  typeof WorkspaceExecutionEpisodeSubjectStateSpecV2Schema
>;
export type StructuredArtifactSubjectStateSpecV1 = z.infer<
  typeof StructuredArtifactSubjectStateSpecV1Schema
>;
export type SqliteDatabaseSubjectStateSpecV1 = z.infer<
  typeof SqliteDatabaseSubjectStateSpecV1Schema
>;

function subjectStateSpecKind(
  value: ExecutionEpisodeSubjectStateSpecV2,
): z.infer<typeof StateSnapshotKindV1Schema> {
  switch (value.contract_version) {
    case "workspace_subject_state_spec_v2":
      return "workspace";
    case "structured_artifact_subject_state_spec_v1":
      return "artifact";
    case "sqlite_database_subject_state_spec_v1":
      return "database";
  }
}

export function executionEpisodeSubjectStateSpecDigest(
  value: ExecutionEpisodeSubjectStateSpecV2,
): string {
  return canonicalContractDigest(
    ExecutionEpisodeSubjectStateSpecV2Schema,
    value,
  );
}

export const ExecutionEpisodeRequiredVerifierV1Schema = z.object({
  contract_version: z.literal("execution_episode_required_verifier_v1"),
  verifier_id: BoundedIdSchema,
  verifier_definition_sha256: ExecutionEpisodeSha256Schema,
}).strict();

export type ExecutionEpisodeRequiredVerifierV1 = z.infer<
  typeof ExecutionEpisodeRequiredVerifierV1Schema
>;

export const ExecutionEpisodeTaskManifestV1Schema = z.object({
  contract_version: z.literal("execution_episode_task_manifest_v1"),
  host_task_envelope: HostTaskEnvelopeV1Schema,
  source_task_ref: EvidenceArtifactRefV1Schema,
  model: z.object({
    model_id: BoundedIdSchema,
    model_config_digest: ExecutionEpisodeSha256Schema,
    model_config_ref: EvidenceArtifactRefV1Schema,
  }).strict(),
  subject: z.object({
    state_kind: StateSnapshotKindV1Schema,
    capture_algorithm_id: BoundedKindSchema,
    capture_algorithm_version: BoundedKindSchema,
    subject_state_spec: ExecutionEpisodeSubjectStateSpecV2Schema,
    expected_initial_content_digest: ExecutionEpisodeSha256Schema,
    execution_subject: ExecutionSubjectV1Schema.optional(),
  }).strict(),
  required_verifier: ExecutionEpisodeRequiredVerifierV1Schema,
}).strict().superRefine((value, context) => {
  if (
    value.source_task_ref.kind !== "prompt"
    || value.source_task_ref.sha256
      !== value.host_task_envelope.source_task_sha256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_task_ref"],
      message: "Task manifest must bind the retained source task bytes",
    });
  }
  if (
    value.model.model_config_ref.kind !== "manifest"
    || value.model.model_config_ref.sha256
      !== value.model.model_config_digest
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model", "model_config_ref"],
      message: "Task manifest must bind the retained model configuration",
    });
  }
  if (
    value.subject.execution_subject !== undefined
    && (
      value.subject.execution_subject.kind !== value.subject.state_kind
      || value.subject.execution_subject.identity_sha256.length !== 64
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "execution_subject"],
      message: "Task manifest execution subject must match its state kind",
    });
  }
  if (value.subject.state_kind !== subjectStateSpecKind(
    value.subject.subject_state_spec,
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject", "subject_state_spec"],
      message: "Task manifest subject state spec must match its state kind",
    });
  }
});

export type ExecutionEpisodeTaskManifestV1 = z.infer<
  typeof ExecutionEpisodeTaskManifestV1Schema
>;

export function executionEpisodeTaskManifestDigest(
  value: ExecutionEpisodeTaskManifestV1,
): string {
  return canonicalContractDigest(ExecutionEpisodeTaskManifestV1Schema, value);
}

const ExecutionEpisodeSubjectIdentityMaterialV1Schema = z.object({
  contract_version: z.literal("execution_episode_subject_identity_v1"),
  state_kind: StateSnapshotKindV1Schema,
  canonical_root_sha256: ExecutionEpisodeSha256Schema,
  capture_algorithm_id: BoundedKindSchema,
  capture_algorithm_version: BoundedKindSchema,
  subject_state_spec: ExecutionEpisodeSubjectStateSpecV2Schema,
  subject_state_spec_sha256: ExecutionEpisodeSha256Schema,
}).strict();

export const ExecutionEpisodeSubjectIdentityV1Schema =
  ExecutionEpisodeSubjectIdentityMaterialV1Schema.extend({
    identity_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    if (
      value.subject_state_spec_sha256
      !== executionEpisodeSubjectStateSpecDigest(value.subject_state_spec)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject_state_spec_sha256"],
        message: "Subject identity must bind the canonical subject state spec",
      });
    }
    if (value.state_kind !== subjectStateSpecKind(value.subject_state_spec)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject_state_spec"],
        message: "Subject identity state spec must match its state kind",
      });
    }
    const { identity_sha256: _identitySha256, ...material } = value;
    if (
      value.identity_sha256
      !== canonicalContractDigest(
        ExecutionEpisodeSubjectIdentityMaterialV1Schema,
        material,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identity_sha256"],
        message: "Subject identity digest must bind canonical identity material",
      });
    }
  });

export type ExecutionEpisodeSubjectIdentityV1 = z.infer<
  typeof ExecutionEpisodeSubjectIdentityV1Schema
>;

export function executionEpisodeSubjectIdentityDigest(
  value: Omit<ExecutionEpisodeSubjectIdentityV1, "identity_sha256">,
): string {
  return canonicalContractDigest(
    ExecutionEpisodeSubjectIdentityMaterialV1Schema,
    value,
  );
}

export const DecisionEpisodeV1Schema = z.object({
  contract_version: z.literal("decision_episode_v1"),
  episode_id: BoundedIdSchema,
  tenant_id: BoundedIdSchema,
  public_scope: ExecutionEpisodePublicScopeSchema,
  store_scope: ExecutionEpisodeStoreScopeSchema,
  task_id: BoundedIdSchema,
  task_envelope_digest: ExecutionEpisodeSha256Schema,
  task_envelope_ref: EvidenceArtifactRefV1Schema,
  task_manifest_digest: ExecutionEpisodeSha256Schema,
  task_manifest_ref: EvidenceArtifactRefV1Schema,
  source_task_ref: EvidenceArtifactRefV1Schema,
  task_cluster_id: BoundedIdSchema,
  task_cluster_policy_version: BoundedKindSchema,
  run_id: BoundedIdSchema,
  model_id: BoundedIdSchema,
  model_config_digest: ExecutionEpisodeSha256Schema,
  model_config_ref: EvidenceArtifactRefV1Schema,
  environment_digest: ExecutionEpisodeSha256Schema,
  subject_identity: ExecutionEpisodeSubjectIdentityV1Schema,
  execution_subject: ExecutionSubjectV1Schema.optional(),
  required_verifier: ExecutionEpisodeRequiredVerifierV1Schema,
  initial_state_snapshot_id: BoundedIdSchema,
  budget: EpisodeBudgetV1Schema,
  opened_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
  closed_at: ExecutionEpisodeCanonicalUtcTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.task_envelope_ref.kind !== "manifest") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_envelope_ref", "kind"],
      message: "Decision episode task envelope must reference a manifest artifact",
    });
  }
  if (value.task_envelope_digest !== value.task_envelope_ref.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_envelope_digest"],
      message: "Decision episode task envelope digest must bind its artifact",
    });
  }
  if (value.task_manifest_ref.kind !== "manifest") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_manifest_ref", "kind"],
      message: "Decision episode task manifest must reference a manifest artifact",
    });
  }
  if (value.task_manifest_digest !== value.task_manifest_ref.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_manifest_digest"],
      message: "Decision episode task manifest digest must bind its artifact",
    });
  }
  if (value.source_task_ref.kind !== "prompt") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_task_ref", "kind"],
      message: "Decision episode source task must reference a prompt artifact",
    });
  }
  if (
    value.model_config_ref.kind !== "manifest"
    || value.model_config_digest !== value.model_config_ref.sha256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model_config_ref"],
      message: "Decision episode model configuration must bind its artifact",
    });
  }
  if (
    value.execution_subject !== undefined
    && (
      value.execution_subject.kind !== value.subject_identity.state_kind
      || value.execution_subject.identity_sha256
        !== value.subject_identity.identity_sha256
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["execution_subject"],
      message:
        "Decision episode execution subject must bind the adapter subject identity",
    });
  }
  if (
    value.closed_at !== undefined
    && Date.parse(value.closed_at) < Date.parse(value.opened_at)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["closed_at"],
      message: "Episode close time cannot precede its open time",
    });
  }
});

export type DecisionEpisodeV1 = z.infer<typeof DecisionEpisodeV1Schema>;
export type ExecutionEpisodeExecutionSubjectV1 = ExecutionSubjectV1;

export function decisionEpisodeDigest(value: DecisionEpisodeV1): string {
  return canonicalContractDigest(DecisionEpisodeV1Schema, value);
}

export const ActionMutationReceiptV1Schema = z.object({
  contract_version: z.literal("action_mutation_receipt_v1"),
  action_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  action_kind: BoundedKindSchema,
  tool_name: BoundedIdSchema.optional(),
  request_digest: ExecutionEpisodeSha256Schema,
  request_ref: EvidenceArtifactRefV1Schema,
  result_digest: ExecutionEpisodeSha256Schema,
  result_ref: EvidenceArtifactRefV1Schema,
  state_before_snapshot_id: BoundedIdSchema,
  state_after_snapshot_id: BoundedIdSchema,
  state_delta: StateDeltaV1Schema.optional(),
  state_delta_ref: EvidenceArtifactRefV1Schema.optional(),
  mutation: z.boolean(),
  occurred_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.request_digest !== value.request_ref.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["request_digest"],
      message: "Action request digest must bind the request artifact",
    });
  }
  if (value.result_digest !== value.result_ref.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["result_digest"],
      message: "Action result digest must bind the result artifact",
    });
  }
  if (
    value.mutation
    && value.state_before_snapshot_id === value.state_after_snapshot_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_after_snapshot_id"],
      message: "A mutating action must point to a distinct post-action snapshot",
    });
  }
  if (
    !value.mutation
    && value.state_before_snapshot_id !== value.state_after_snapshot_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_after_snapshot_id"],
      message: "A non-mutating action must retain the exact current snapshot",
    });
  }
  if (
    (value.state_delta === undefined)
      !== (value.state_delta_ref === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_delta"],
      message: "State delta and its retained artifact must be supplied together",
    });
  }
  if (
    !value.mutation
    && (
      value.state_delta !== undefined
      || value.state_delta_ref !== undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_delta"],
      message: "A non-mutating action cannot carry a state delta",
    });
  }
  if (
    value.state_delta !== undefined
    && (
      value.state_delta.subject_id.length === 0
      || value.state_delta.before_snapshot_id
        !== value.state_before_snapshot_id
      || value.state_delta.after_snapshot_id
        !== value.state_after_snapshot_id
      || value.state_delta_ref?.kind !== "workspace_diff"
      || value.state_delta.content_sha256 !== value.state_delta_ref.sha256
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state_delta"],
      message:
        "State delta must bind the action snapshots and retained delta artifact",
    });
  }
});

export type ActionMutationReceiptV1 = z.infer<typeof ActionMutationReceiptV1Schema>;

export function actionMutationReceiptDigest(value: ActionMutationReceiptV1): string {
  return canonicalContractDigest(ActionMutationReceiptV1Schema, value);
}

export const VerifierKindV1Schema = z.enum([
  "hidden_test",
  "environment_assertion",
  "database_constraint",
  "independent_executable",
  "process_verifier",
  "llm_judge_diagnostic",
]);

const RuntimeVerifierLaunchAuthorityV1Schema = z.object({
  kind: z.literal("runtime_launched"),
  runtime_reservation_digest: ExecutionEpisodeSha256Schema,
}).strict();

const TrustedVerifierRunnerAuthorityV1Schema = z.object({
  kind: z.literal("trusted_runner"),
  principal_id: BoundedIdSchema,
  key_id: BoundedIdSchema,
}).strict();

export const VerifierInvocationV1Schema = z.object({
  contract_version: z.literal("verifier_invocation_v1"),
  verifier_invocation_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  verifier_id: BoundedIdSchema,
  verifier_definition_sha256: ExecutionEpisodeSha256Schema,
  verifier_kind: VerifierKindV1Schema,
  verifier_version: BoundedKindSchema,
  verifier_issuer_id: BoundedIdSchema,
  verifier_runner_instance_id: BoundedIdSchema,
  launch_authority: z.discriminatedUnion("kind", [
    RuntimeVerifierLaunchAuthorityV1Schema,
    TrustedVerifierRunnerAuthorityV1Schema,
  ]),
  verifier_program_digest: ExecutionEpisodeSha256Schema,
  verifier_config_digest: ExecutionEpisodeSha256Schema,
  verifier_environment_digest: ExecutionEpisodeSha256Schema,
  target_state_snapshot_id: BoundedIdSchema,
  target_state_snapshot_algorithm_version: BoundedKindSchema,
  verifier_input_ref: EvidenceArtifactRefV1Schema,
  invoked_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.verifier_input_ref.kind !== "verifier_input") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifier_input_ref", "kind"],
      message: "A verifier invocation must reference verifier_input evidence",
    });
  }
});

export type VerifierInvocationV1 = z.infer<typeof VerifierInvocationV1Schema>;

export function verifierInvocationDigest(value: VerifierInvocationV1): string {
  return canonicalContractDigest(VerifierInvocationV1Schema, value);
}

const RuntimeLaunchedVerifierAttestationV1Schema = z.object({
  kind: z.literal("runtime_launched"),
  runtime_launch_sha256: ExecutionEpisodeSha256Schema,
}).strict();

const TrustedRunnerSignatureVerifierAttestationV1Schema = z.object({
  kind: z.literal("trusted_runner_signature"),
  principal_id: BoundedIdSchema,
  key_id: BoundedIdSchema,
  signed_payload_digest: ExecutionEpisodeSha256Schema,
  signature: exactBoundedString("Verifier signature", 2048),
}).strict();

const VerifierOutcomeReceiptObjectV1Schema = z.object({
  contract_version: z.literal("verifier_outcome_receipt_v1"),
  verifier_receipt_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  verifier_id: BoundedIdSchema,
  verifier_definition_sha256: ExecutionEpisodeSha256Schema,
  verifier_kind: VerifierKindV1Schema,
  verifier_version: BoundedKindSchema,
  verifier_issuer_id: BoundedIdSchema,
  verifier_runner_instance_id: BoundedIdSchema,
  verifier_invocation_id: BoundedIdSchema,
  verifier_invocation_digest: ExecutionEpisodeSha256Schema,
  attestation: z.discriminatedUnion("kind", [
    RuntimeLaunchedVerifierAttestationV1Schema,
    TrustedRunnerSignatureVerifierAttestationV1Schema,
  ]),
  verifier_program_digest: ExecutionEpisodeSha256Schema,
  verifier_config_digest: ExecutionEpisodeSha256Schema,
  verifier_environment_digest: ExecutionEpisodeSha256Schema,
  verified_state_snapshot_id: BoundedIdSchema,
  verified_state_snapshot_algorithm_version: BoundedKindSchema,
  verifier_input_ref: EvidenceArtifactRefV1Schema,
  verifier_output_ref: EvidenceArtifactRefV1Schema,
  evidence_digest: ExecutionEpisodeSha256Schema,
  execution_exit_code: z.number().int().min(-255).max(2_147_483_647).nullable(),
  status: z.enum([
    "passed",
    "failed",
    "infrastructure_error",
    "inconclusive",
  ]),
  infrastructure_failure_reasons: z.array(BoundedReasonSchema).max(64),
  infrastructure_failure_attribution: z.enum([
    "arm_caused",
    "arm_independent",
  ]).nullable(),
  completed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

type VerifierOutcomeReceiptObjectV1 = z.infer<
  typeof VerifierOutcomeReceiptObjectV1Schema
>;

const VerifierOutcomeEvidenceMaterialV1Schema =
  VerifierOutcomeReceiptObjectV1Schema.omit({
    attestation: true,
    evidence_digest: true,
  });

const VerifierOutcomeAttestationMaterialV1Schema =
  VerifierOutcomeReceiptObjectV1Schema.omit({
    attestation: true,
  });

export function verifierOutcomeEvidenceDigest(
  value: z.input<typeof VerifierOutcomeEvidenceMaterialV1Schema>,
): string {
  return sha256Hex(stableStringify({
    contract: "verifier_outcome_evidence_material_v1",
    receipt: VerifierOutcomeEvidenceMaterialV1Schema.parse(value),
  }));
}

export function verifierOutcomeAttestationPayloadDigest(
  value: z.input<typeof VerifierOutcomeAttestationMaterialV1Schema>,
): string {
  return sha256Hex(stableStringify({
    contract: "verifier_outcome_attestation_payload_v1",
    receipt: VerifierOutcomeAttestationMaterialV1Schema.parse(value),
  }));
}

export const VerifierOutcomeReceiptV1Schema =
  VerifierOutcomeReceiptObjectV1Schema.superRefine((value, context) => {
    if (value.verifier_input_ref.kind !== "verifier_input") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifier_input_ref", "kind"],
        message: "A verifier outcome must reference verifier_input evidence",
      });
    }
    if (value.verifier_output_ref.kind !== "verifier_output") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifier_output_ref", "kind"],
        message: "A verifier outcome must reference verifier_output evidence",
      });
    }
    if (
      (value.status === "passed" || value.status === "failed")
      && value.execution_exit_code === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_exit_code"],
        message: "Passed or failed verifier execution requires an exit code",
      });
    }
    if (
      (
        value.status === "infrastructure_error"
        && value.infrastructure_failure_attribution === null
      )
      || (
        value.status !== "infrastructure_error"
        && value.infrastructure_failure_attribution !== null
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["infrastructure_failure_attribution"],
        message: "Only infrastructure outcomes require failure attribution",
      });
    }
    if (value.status === "passed" && value.execution_exit_code !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution_exit_code"],
        message: "A passed verifier execution requires exit code zero",
      });
    }
    if (
      (
        value.status === "infrastructure_error"
        && value.infrastructure_failure_reasons.length === 0
      )
      || (
        value.status !== "infrastructure_error"
        && value.infrastructure_failure_reasons.length !== 0
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["infrastructure_failure_reasons"],
        message: "Only infrastructure outcomes require infrastructure failure reasons",
      });
    }
    const {
      attestation: _attestation,
      evidence_digest: _evidenceDigest,
      ...evidenceMaterial
    } = value;
    if (
      value.evidence_digest
      !== verifierOutcomeEvidenceDigest(evidenceMaterial)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_digest"],
        message: "Verifier evidence digest does not bind the canonical outcome",
      });
    }
    if (
      value.attestation.kind === "trusted_runner_signature"
      && value.attestation.signed_payload_digest
        !== verifierOutcomeAttestationPayloadDigest({
          ...evidenceMaterial,
          evidence_digest: value.evidence_digest,
        })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attestation", "signed_payload_digest"],
        message: "Trusted verifier signature does not bind the canonical outcome",
      });
    }
  });

export type VerifierOutcomeReceiptV1 = VerifierOutcomeReceiptObjectV1;

export function verifierOutcomeReceiptDigest(
  value: VerifierOutcomeReceiptV1,
): string {
  return canonicalContractDigest(VerifierOutcomeReceiptV1Schema, value);
}

export const EpisodeRewardOutcomeClassV1Schema = z.enum([
  "verified_pass",
  "verified_failure",
  "arm_caused_incomplete",
  "arm_independent_infrastructure",
  "diagnostic_only",
]);

export const EpisodeRewardAuthorityV1Schema = z.enum([
  "deterministic",
  "independent_executable",
  "process",
  "protocol_itt_failure",
  "diagnostic_only",
  "missing",
]);

const PRIMARY_REWARD_AUTHORITIES = new Set([
  "deterministic",
  "independent_executable",
  "process",
] as const);

export const EPISODE_REWARD_OUTCOME_CLASS_MAPPING = {
  verified_pass: {
    verified_success: 1,
    reward_authorities: [
      "deterministic",
      "independent_executable",
      "process",
    ],
    selector_eligible_when_uncontaminated: true,
  },
  verified_failure: {
    verified_success: 0,
    reward_authorities: [
      "deterministic",
      "independent_executable",
      "process",
    ],
    selector_eligible_when_uncontaminated: true,
  },
  arm_caused_incomplete: {
    verified_success: 0,
    reward_authorities: ["protocol_itt_failure"],
    selector_eligible_when_uncontaminated: true,
  },
  arm_independent_infrastructure: {
    verified_success: null,
    reward_authorities: ["missing"],
    selector_eligible_when_uncontaminated: false,
  },
  diagnostic_only: {
    verified_success: null,
    reward_authorities: ["diagnostic_only"],
    selector_eligible_when_uncontaminated: false,
  },
} as const;

export const EpisodeRewardV1Schema = z.object({
  reward_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  reward_contract_version: z.literal("episode_reward_v1"),
  verified_success: z.union([z.literal(0), z.literal(1), z.null()]),
  outcome_class: EpisodeRewardOutcomeClassV1Schema,
  reward_authority: EpisodeRewardAuthorityV1Schema,
  final_state_snapshot_id: BoundedIdSchema.optional(),
  verifier_receipt_id: BoundedIdSchema.optional(),
  token_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  token_usage_authority: z.enum([
    "provider_receipt",
    "trusted_adapter_signature",
    "unavailable",
  ]),
  token_usage_ref: EvidenceArtifactRefV1Schema.optional(),
  tool_call_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  elapsed_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outcome_reasons: z.array(BoundedReasonSchema).max(64),
  contamination_reasons: z.array(BoundedReasonSchema).max(64),
}).strict().superRefine((value, context) => {
  const mapping = EPISODE_REWARD_OUTCOME_CLASS_MAPPING[value.outcome_class];
  if (value.verified_success !== mapping.verified_success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verified_success"],
      message: "Verified success does not match the reward outcome class",
    });
  }
  if (!(mapping.reward_authorities as readonly string[]).includes(value.reward_authority)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reward_authority"],
      message: "Reward authority does not match the reward outcome class",
    });
  }
  if (
    (value.outcome_class === "verified_pass"
      || value.outcome_class === "verified_failure")
    && (
      value.final_state_snapshot_id === undefined
      || value.verifier_receipt_id === undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifier_receipt_id"],
      message: "Verified rewards require exact final-state and verifier references",
    });
  }
  if (
    value.token_usage_authority === "unavailable"
    && (value.token_count !== null || value.token_usage_ref !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token_usage_authority"],
      message: "Unavailable token usage cannot claim a count or evidence",
    });
  }
  if (
    value.token_usage_authority !== "unavailable"
    && (value.token_count === null || value.token_usage_ref === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token_usage_ref"],
      message: "Counted token usage requires retained authority evidence",
    });
  }
  if (
    value.token_usage_ref !== undefined
    && value.token_usage_ref.kind !== "usage_receipt"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token_usage_ref", "kind"],
      message: "Token usage must reference a usage_receipt artifact",
    });
  }
  if (
    value.outcome_class === "diagnostic_only"
    && value.verifier_receipt_id === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verifier_receipt_id"],
      message: "A diagnostic-only reward requires its diagnostic verifier receipt",
    });
  }
  if (
    (value.outcome_class === "arm_caused_incomplete"
      || value.outcome_class === "arm_independent_infrastructure")
    && value.outcome_reasons.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome_reasons"],
      message: "Incomplete or missing outcomes require an explicit outcome reason",
    });
  }
  if (new Set(value.outcome_reasons).size !== value.outcome_reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome_reasons"],
      message: "Outcome reasons must be unique",
    });
  }
  if (new Set(value.contamination_reasons).size !== value.contamination_reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contamination_reasons"],
      message: "Contamination reasons must be unique",
    });
  }
});

export type EpisodeRewardV1 = z.infer<typeof EpisodeRewardV1Schema>;

export function episodeRewardDigest(value: EpisodeRewardV1): string {
  return canonicalContractDigest(EpisodeRewardV1Schema, value);
}

const ExecutionCostReceiptMaterialV1Shape = {
  cost_receipt_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  provider: BoundedIdSchema,
  model: BoundedIdSchema,
  model_config_sha256: ExecutionEpisodeSha256Schema,
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  cached_input_tokens:
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  token_usage_authority: z.enum([
    "provider_total",
    "exact_tokenizer",
    "signed_host_receipt",
    "estimated",
    "unavailable",
  ]),
  tool_calls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  elapsed_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  monetary_cost_micros:
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: BoundedKindSchema.nullable(),
  raw_usage_ref: EvidenceArtifactRefV1Schema.optional(),
  producer_id: BoundedIdSchema,
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
} as const;

const ExecutionCostReceiptMaterialObjectV1Schema = z.object(
  ExecutionCostReceiptMaterialV1Shape,
).strict();

function refineExecutionCostReceiptMaterial(
  value: z.infer<typeof ExecutionCostReceiptMaterialObjectV1Schema>,
  context: z.RefinementCtx,
): void {
  const unavailable = value.token_usage_authority === "unavailable";
  if (
    unavailable
    && (
      value.input_tokens !== null
      || value.output_tokens !== null
      || value.cached_input_tokens !== null
      || value.raw_usage_ref !== undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token_usage_authority"],
      message: "Unavailable usage cannot claim tokens or a usage receipt",
    });
  }
  if (
    !unavailable
    && (
      value.input_tokens === null
      || value.output_tokens === null
      || value.raw_usage_ref === undefined
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["raw_usage_ref"],
      message: "Authoritative usage requires input/output totals and evidence",
    });
  }
  if (
    value.raw_usage_ref !== undefined
    && value.raw_usage_ref.kind !== "usage_receipt"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["raw_usage_ref", "kind"],
      message: "Execution cost must reference a usage_receipt artifact",
    });
  }
  if (
    value.cached_input_tokens !== null
    && value.input_tokens !== null
    && value.cached_input_tokens > value.input_tokens
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cached_input_tokens"],
      message: "Cached input tokens cannot exceed total input tokens",
    });
  }
  if (
    (value.monetary_cost_micros === null) !== (value.currency === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "Monetary cost and currency must be both present or both null",
    });
  }
}

const ExecutionCostReceiptMaterialV1Schema =
  ExecutionCostReceiptMaterialObjectV1Schema.superRefine(
    refineExecutionCostReceiptMaterial,
  );

export type ExecutionCostReceiptMaterialV1 = z.infer<
  typeof ExecutionCostReceiptMaterialV1Schema
>;

export function executionCostReceiptDigest(
  value: ExecutionCostReceiptMaterialV1,
): string {
  return canonicalContractDigest(ExecutionCostReceiptMaterialV1Schema, value);
}

export const ExecutionCostReceiptV1Schema =
  z.object({
    ...ExecutionCostReceiptMaterialV1Shape,
    receipt_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineExecutionCostReceiptMaterial(value, context);
    const { receipt_sha256: suppliedDigest, ...material } = value;
    if (suppliedDigest !== executionCostReceiptDigest(material)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt_sha256"],
        message: "Execution cost receipt digest does not bind its material",
      });
    }
  });

export type ExecutionCostReceiptV1 = z.infer<
  typeof ExecutionCostReceiptV1Schema
>;

export function isEpisodeRewardSelectorEligible(value: EpisodeRewardV1): boolean {
  const reward = EpisodeRewardV1Schema.parse(value);
  if (
    reward.verified_success === 0
    && reward.reward_authority === "protocol_itt_failure"
  ) {
    return reward.contamination_reasons.length === 0;
  }
  return reward.verified_success !== null
    && reward.contamination_reasons.length === 0
    && PRIMARY_REWARD_AUTHORITIES.has(
      reward.reward_authority as "deterministic" | "independent_executable" | "process",
    );
}

const DecisionCommittedReceiptMaterialV1Schema = z.object({
  contract_version: z.literal("decision_committed_receipt_v1"),
  episode_id: BoundedIdSchema,
  decision_id: BoundedIdSchema,
  target_state_snapshot_id: BoundedIdSchema,
  guide_trace_id: BoundedIdSchema,
  guide_receipt_digest: ExecutionEpisodeSha256Schema,
  treatment_assignment_id: BoundedIdSchema.nullable(),
  candidate_set_digest: ExecutionEpisodeSha256Schema,
  selected_candidate_ids: z.array(BoundedIdSchema).max(200),
  policy_id: BoundedIdSchema,
  policy_version: BoundedKindSchema,
  policy_artifact_digest: ExecutionEpisodeSha256Schema,
  committed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type DecisionCommittedReceiptMaterialV1 = z.infer<
  typeof DecisionCommittedReceiptMaterialV1Schema
>;

export function decisionCommittedReceiptDigest(
  value: DecisionCommittedReceiptMaterialV1,
): string {
  return canonicalContractDigest(
    DecisionCommittedReceiptMaterialV1Schema,
    value,
  );
}

export const DecisionCommittedReceiptV1Schema =
  DecisionCommittedReceiptMaterialV1Schema.extend({
    decision_digest: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
  if (new Set(value.selected_candidate_ids).size !== value.selected_candidate_ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selected_candidate_ids"],
      message: "Selected candidate IDs must be unique",
    });
  }
  const { decision_digest: suppliedDigest, ...material } = value;
  if (suppliedDigest !== decisionCommittedReceiptDigest(material)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decision_digest"],
      message: "Decision digest does not bind the canonical decision receipt",
    });
  }
});

export type DecisionCommittedReceiptV1 = z.infer<
  typeof DecisionCommittedReceiptV1Schema
>;

const SemanticEventEvidenceRefsV1Schema = z.array(
  EvidenceArtifactRefV1Schema,
).min(1).max(64).superRefine((values, context) => {
  const identities = values.map((value) =>
    `${value.artifact_id}\u0000${value.sha256}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Semantic-event evidence references must be unique",
    });
  }
});

const DecisiveEvidenceSourceRefV1Schema = exactBoundedString(
  "Decisive evidence source reference",
  512,
);
const DecisiveEvidenceExcerptTextV1Schema = exactBoundedString(
  "Decisive evidence excerpt",
  2_048,
);

const DecisiveEvidenceExcerptMaterialV1Schema = z.object({
  contract_version: z.literal("decisive_evidence_excerpt_v1"),
  source_ref: DecisiveEvidenceSourceRefV1Schema,
  excerpt: DecisiveEvidenceExcerptTextV1Schema,
  evidence_artifact_id: BoundedIdSchema,
  evidence_artifact_sha256: ExecutionEpisodeSha256Schema,
}).strict();

export function decisiveEvidenceExcerptDigest(
  value: z.input<typeof DecisiveEvidenceExcerptMaterialV1Schema>,
): string {
  return canonicalContractDigest(
    DecisiveEvidenceExcerptMaterialV1Schema,
    value,
  );
}

export const DecisiveEvidenceExcerptV1Schema =
  DecisiveEvidenceExcerptMaterialV1Schema.extend({
    excerpt_sha256: ExecutionEpisodeSha256Schema,
    evidence_id: BoundedIdSchema,
  }).strict().superRefine((value, context) => {
    const {
      excerpt_sha256: suppliedExcerptSha256,
      evidence_id: suppliedEvidenceId,
      ...material
    } = value;
    if (
      suppliedExcerptSha256
        !== sha256Bytes(Buffer.from(value.excerpt, "utf8"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excerpt_sha256"],
        message:
          "Decisive evidence excerpt digest must bind the exact excerpt",
      });
    }
    const expectedEvidenceId =
      `dee_${decisiveEvidenceExcerptDigest(material)}`;
    if (suppliedEvidenceId !== expectedEvidenceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_id"],
        message:
          "Decisive evidence identity must bind its source and evidence artifact",
      });
    }
  });

export type DecisiveEvidenceExcerptV1 = z.infer<
  typeof DecisiveEvidenceExcerptV1Schema
>;

export function buildDecisiveEvidenceExcerptV1(args: Readonly<{
  sourceRef: string;
  excerpt: string;
  evidenceArtifact: EvidenceArtifactRefV1;
}>): DecisiveEvidenceExcerptV1 {
  const material = DecisiveEvidenceExcerptMaterialV1Schema.parse({
    contract_version: "decisive_evidence_excerpt_v1",
    source_ref: args.sourceRef,
    excerpt: args.excerpt,
    evidence_artifact_id: args.evidenceArtifact.artifact_id,
    evidence_artifact_sha256: args.evidenceArtifact.sha256,
  });
  return DecisiveEvidenceExcerptV1Schema.parse({
    ...material,
    excerpt_sha256: sha256Bytes(Buffer.from(material.excerpt, "utf8")),
    evidence_id: `dee_${decisiveEvidenceExcerptDigest(material)}`,
  });
}

export const DecisiveEvidenceExcerptListV1Schema = z.array(
  DecisiveEvidenceExcerptV1Schema,
).max(12).superRefine((values, context) => {
  const identities = values.map((value) => value.evidence_id);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Decisive evidence excerpts must be unique",
    });
  }
  const totalUtf8Bytes = values.reduce(
    (total, value) =>
      total + Buffer.byteLength(value.excerpt, "utf8"),
    0,
  );
  if (totalUtf8Bytes > 12 * 2_048) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Decisive evidence excerpts exceed their aggregate budget",
    });
  }
});

const HostDeclaredSemanticEventAuthorityV1Schema = z.object({
  contract_version: z.literal("semantic_event_authority_v1"),
  kind: z.literal("host_declared"),
  actor_id: BoundedIdSchema,
  model_id: z.null(),
  derivation_sha256: z.null(),
  uncertainty: z.null(),
  evidence_refs: SemanticEventEvidenceRefsV1Schema,
}).strict();

const RuntimeDerivedSemanticEventAuthorityV1Schema = z.object({
  contract_version: z.literal("semantic_event_authority_v1"),
  kind: z.literal("runtime_derived"),
  actor_id: BoundedIdSchema,
  model_id: z.null(),
  derivation_sha256: ExecutionEpisodeSha256Schema,
  uncertainty: z.null(),
  evidence_refs: SemanticEventEvidenceRefsV1Schema,
}).strict();

const ModelDerivedSemanticEventAuthorityV1Schema = z.object({
  contract_version: z.literal("semantic_event_authority_v1"),
  kind: z.literal("model_derived"),
  actor_id: BoundedIdSchema,
  model_id: BoundedIdSchema,
  derivation_sha256: ExecutionEpisodeSha256Schema,
  uncertainty: z.number().finite().min(0).max(1),
  evidence_refs: SemanticEventEvidenceRefsV1Schema,
}).strict();

export const SemanticEventAuthorityV1Schema = z.discriminatedUnion("kind", [
  HostDeclaredSemanticEventAuthorityV1Schema,
  RuntimeDerivedSemanticEventAuthorityV1Schema,
  ModelDerivedSemanticEventAuthorityV1Schema,
]);

export type SemanticEventAuthorityV1 = z.infer<
  typeof SemanticEventAuthorityV1Schema
>;

const SemanticStatementV1Schema = exactBoundedString(
  "Semantic execution statement",
  16 * 1024,
);

const SemanticStatementListV1Schema = z.array(
  SemanticStatementV1Schema,
).max(64).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Semantic execution statements must be unique",
    });
  }
});

export const SemanticObservationEventV1Schema = z.object({
  semantic_event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  observation: SemanticStatementV1Schema,
  target_state_snapshot_id: BoundedIdSchema,
  authority: SemanticEventAuthorityV1Schema,
  decisive_evidence: DecisiveEvidenceExcerptListV1Schema.optional(),
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type SemanticObservationEventV1 = z.infer<
  typeof SemanticObservationEventV1Schema
>;

export const AgentDecisionEventV1Schema = z.object({
  semantic_event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  decision: SemanticStatementV1Schema,
  reasons: SemanticStatementListV1Schema,
  alternatives_rejected: SemanticStatementListV1Schema,
  target_state_snapshot_id: BoundedIdSchema,
  authority: SemanticEventAuthorityV1Schema,
  decisive_evidence: DecisiveEvidenceExcerptListV1Schema.optional(),
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type AgentDecisionEventV1 = z.infer<
  typeof AgentDecisionEventV1Schema
>;

export const ProgressStateEventV1Schema = z.object({
  semantic_event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  item_id: BoundedIdSchema,
  state: z.enum(["completed", "failed", "unresolved", "blocked"]),
  statement: SemanticStatementV1Schema,
  target_state_snapshot_id: BoundedIdSchema,
  authority: SemanticEventAuthorityV1Schema,
  decisive_evidence: DecisiveEvidenceExcerptListV1Schema.optional(),
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type ProgressStateEventV1 = z.infer<
  typeof ProgressStateEventV1Schema
>;

export const PlannedActionEventV1Schema = z.object({
  semantic_event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  action_id: BoundedIdSchema,
  intent: SemanticStatementV1Schema,
  justification: SemanticStatementV1Schema,
  preconditions: SemanticStatementListV1Schema,
  target_state_snapshot_id: BoundedIdSchema,
  authority: SemanticEventAuthorityV1Schema,
  decisive_evidence: DecisiveEvidenceExcerptListV1Schema.optional(),
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type PlannedActionEventV1 = z.infer<
  typeof PlannedActionEventV1Schema
>;

const EpisodeStartedEventPayloadV1Schema = z.object({
  event_kind: z.literal("episode_started"),
  episode: DecisionEpisodeV1Schema,
  initial_state_snapshot: StateSnapshotV1Schema,
}).strict();

const DecisionCommittedEventPayloadV1Schema = z.object({
  event_kind: z.literal("decision_committed"),
  decision: DecisionCommittedReceiptV1Schema,
}).strict();

const ActionObservedEventPayloadV1Schema = z.object({
  event_kind: z.literal("action_observed"),
  action: ActionMutationReceiptV1Schema,
  state_before_snapshot: StateSnapshotV1Schema,
  state_after_snapshot: StateSnapshotV1Schema,
}).strict();

const SemanticObservationRecordedEventPayloadV1Schema = z.object({
  event_kind: z.literal("semantic_observation_recorded"),
  observation: SemanticObservationEventV1Schema,
}).strict();

const AgentDecisionRecordedEventPayloadV1Schema = z.object({
  event_kind: z.literal("agent_decision_recorded"),
  decision: AgentDecisionEventV1Schema,
}).strict();

const ProgressStateRecordedEventPayloadV1Schema = z.object({
  event_kind: z.literal("progress_state_recorded"),
  progress: ProgressStateEventV1Schema,
}).strict();

const PlannedActionRecordedEventPayloadV1Schema = z.object({
  event_kind: z.literal("planned_action_recorded"),
  planned_action: PlannedActionEventV1Schema,
}).strict();

const VerifierRecordedEventPayloadV1Schema = z.object({
  event_kind: z.literal("verifier_recorded"),
  invocation: VerifierInvocationV1Schema,
  outcome: VerifierOutcomeReceiptV1Schema,
  verified_state_snapshot: StateSnapshotV1Schema,
}).strict();

export const ExecutionEpisodeTerminationV1Schema = z.enum([
  "completed",
  "agent_error",
  "timeout",
  "cancelled",
  "missing_verifier",
]);

export type ExecutionEpisodeTerminationV1 = z.infer<
  typeof ExecutionEpisodeTerminationV1Schema
>;

const EpisodeClosedEventPayloadV1Schema = z.object({
  event_kind: z.literal("episode_closed"),
  termination: ExecutionEpisodeTerminationV1Schema,
  outcome_details: z.array(BoundedReasonSchema).max(64),
  reward: EpisodeRewardV1Schema,
  cost_receipt: ExecutionCostReceiptV1Schema.optional(),
  final_state_snapshot: StateSnapshotV1Schema.optional(),
  closed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export const ExecutionEpisodeEventKindV1Schema = z.enum([
  "episode_started",
  "decision_committed",
  "action_observed",
  "semantic_observation_recorded",
  "agent_decision_recorded",
  "progress_state_recorded",
  "planned_action_recorded",
  "verifier_recorded",
  "episode_closed",
]);

export const ExecutionEpisodeEventPayloadV1Schema = z.discriminatedUnion(
  "event_kind",
  [
    EpisodeStartedEventPayloadV1Schema,
    DecisionCommittedEventPayloadV1Schema,
    ActionObservedEventPayloadV1Schema,
    SemanticObservationRecordedEventPayloadV1Schema,
    AgentDecisionRecordedEventPayloadV1Schema,
    ProgressStateRecordedEventPayloadV1Schema,
    PlannedActionRecordedEventPayloadV1Schema,
    VerifierRecordedEventPayloadV1Schema,
    EpisodeClosedEventPayloadV1Schema,
  ],
).superRefine((value, context) => {
  if (value.event_kind === "episode_started") {
    if (value.episode.closed_at !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["episode", "closed_at"],
        message: "An episode_started event cannot contain a closed episode",
      });
    }
    if (
      value.episode.initial_state_snapshot_id
      !== value.initial_state_snapshot.snapshot_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initial_state_snapshot", "snapshot_id"],
        message: "Episode initial-state identity does not match its snapshot",
      });
    }
    if (
      value.episode.environment_digest
      !== value.initial_state_snapshot.environment_digest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initial_state_snapshot", "environment_digest"],
        message: "Episode environment does not match its initial snapshot",
      });
    }
    return;
  }
  if (value.event_kind === "action_observed") {
    if (
      value.action.state_before_snapshot_id
        !== value.state_before_snapshot.snapshot_id
      || value.action.state_after_snapshot_id
        !== value.state_after_snapshot.snapshot_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Action state identities do not match their snapshots",
      });
    }
    if (
      value.action.mutation
      && value.state_before_snapshot.content_digest
        === value.state_after_snapshot.content_digest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_after_snapshot", "content_digest"],
        message: "A mutating action must change the canonical state content digest",
      });
    }
    if (
      !value.action.mutation
      && (
        value.state_before_snapshot.snapshot_id
          !== value.state_after_snapshot.snapshot_id
        || value.state_before_snapshot.content_digest
          !== value.state_after_snapshot.content_digest
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_after_snapshot"],
        message: "A non-mutating action must preserve the exact canonical state",
      });
    }
    if (
      value.state_before_snapshot.algorithm_id
        !== value.state_after_snapshot.algorithm_id
      || value.state_before_snapshot.algorithm_version
        !== value.state_after_snapshot.algorithm_version
      || value.state_before_snapshot.state_kind
        !== value.state_after_snapshot.state_kind
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state_after_snapshot"],
        message: "Action state transition must use one comparable snapshot algorithm",
      });
    }
    return;
  }
  if (value.event_kind === "semantic_observation_recorded") {
    if (
      value.observation.semantic_event_id.length === 0
      || value.observation.episode_id.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observation"],
        message: "Semantic observation identity is required",
      });
    }
    return;
  }
  if (value.event_kind === "agent_decision_recorded") {
    if (value.decision.reasons.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "reasons"],
        message: "An Agent decision requires at least one explicit reason",
      });
    }
    return;
  }
  if (value.event_kind === "verifier_recorded") {
    const invocationDigest = verifierInvocationDigest(value.invocation);
    if (
      value.invocation.verifier_invocation_id
        !== value.outcome.verifier_invocation_id
      || invocationDigest !== value.outcome.verifier_invocation_digest
      || value.invocation.episode_id !== value.outcome.episode_id
      || value.invocation.verifier_id !== value.outcome.verifier_id
      || value.invocation.verifier_definition_sha256
        !== value.outcome.verifier_definition_sha256
      || value.invocation.verifier_kind !== value.outcome.verifier_kind
      || value.invocation.verifier_version !== value.outcome.verifier_version
      || value.invocation.verifier_issuer_id !== value.outcome.verifier_issuer_id
      || value.invocation.verifier_runner_instance_id
        !== value.outcome.verifier_runner_instance_id
      || value.invocation.verifier_program_digest
        !== value.outcome.verifier_program_digest
      || value.invocation.verifier_config_digest
        !== value.outcome.verifier_config_digest
      || value.invocation.verifier_environment_digest
        !== value.outcome.verifier_environment_digest
      || value.invocation.target_state_snapshot_id
        !== value.verified_state_snapshot.snapshot_id
      || value.outcome.verified_state_snapshot_id
        !== value.verified_state_snapshot.snapshot_id
      || value.outcome.verified_state_snapshot_algorithm_version
        !== value.verified_state_snapshot.algorithm_version
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "Verifier invocation, outcome, and exact state bindings disagree",
      });
    }
    if (Date.parse(value.outcome.completed_at) < Date.parse(value.invocation.invoked_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome", "completed_at"],
        message: "Verifier completion cannot precede its invocation",
      });
    }
    if (
      stableStringify(value.invocation.verifier_input_ref)
      !== stableStringify(value.outcome.verifier_input_ref)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome", "verifier_input_ref"],
        message: "Verifier outcome input does not match the invocation input",
      });
    }
    if (
      value.invocation.launch_authority.kind === "runtime_launched"
      && value.outcome.attestation.kind !== "runtime_launched"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome", "attestation"],
        message: "Runtime-launched verifier requires a Runtime launch attestation",
      });
    }
    if (
      value.invocation.launch_authority.kind === "trusted_runner"
      && (
        value.outcome.attestation.kind !== "trusted_runner_signature"
        || value.invocation.launch_authority.principal_id
          !== value.outcome.attestation.principal_id
        || value.invocation.launch_authority.key_id
          !== value.outcome.attestation.key_id
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome", "attestation"],
        message: "Trusted verifier attestation does not match its invocation authority",
      });
    }
    return;
  }
  if (value.event_kind === "episode_closed") {
    if (new Set(value.outcome_details).size !== value.outcome_details.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_details"],
        message: "Episode close outcome details must be unique",
      });
    }
    if (
      value.outcome_details.some(
        (detail) => !value.reward.outcome_reasons.includes(detail),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome_details"],
        message: "Episode close diagnostics must be retained in reward reasons",
      });
    }
    if (
      value.reward.final_state_snapshot_id === undefined
      && value.final_state_snapshot !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["final_state_snapshot"],
        message: "Unbound final-state snapshot cannot be added to an episode close",
      });
    }
    if (
      value.reward.final_state_snapshot_id !== undefined
      && value.reward.final_state_snapshot_id
        !== value.final_state_snapshot?.snapshot_id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["final_state_snapshot"],
        message: "Episode reward does not bind the supplied final-state snapshot",
      });
    }
    if (value.cost_receipt !== undefined) {
      const expectedTokenCount =
        value.cost_receipt.input_tokens === null
        || value.cost_receipt.output_tokens === null
          ? null
          : value.cost_receipt.input_tokens
            + value.cost_receipt.output_tokens;
      const expectedRewardAuthority =
        value.cost_receipt.token_usage_authority === "unavailable"
          ? "unavailable"
          : value.cost_receipt.token_usage_authority === "signed_host_receipt"
            ? "trusted_adapter_signature"
            : "provider_receipt";
      if (
        value.cost_receipt.episode_id !== value.reward.episode_id
        || value.cost_receipt.tool_calls !== value.reward.tool_call_count
        || value.cost_receipt.elapsed_ms !== value.reward.elapsed_ms
        || expectedTokenCount !== value.reward.token_count
        || expectedRewardAuthority !== value.reward.token_usage_authority
        || stableStringify(value.cost_receipt.raw_usage_ref)
          !== stableStringify(value.reward.token_usage_ref)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cost_receipt"],
          message: "Execution cost receipt and episode reward disagree",
        });
      }
    }
  }
});

export type ExecutionEpisodeEventPayloadV1 = z.infer<
  typeof ExecutionEpisodeEventPayloadV1Schema
>;

function eventPayloadEpisodeId(payload: ExecutionEpisodeEventPayloadV1): string {
  switch (payload.event_kind) {
    case "episode_started":
      return payload.episode.episode_id;
    case "decision_committed":
      return payload.decision.episode_id;
    case "action_observed":
      return payload.action.episode_id;
    case "semantic_observation_recorded":
      return payload.observation.episode_id;
    case "agent_decision_recorded":
      return payload.decision.episode_id;
    case "progress_state_recorded":
      return payload.progress.episode_id;
    case "planned_action_recorded":
      return payload.planned_action.episode_id;
    case "verifier_recorded":
      return payload.invocation.episode_id;
    case "episode_closed":
      return payload.reward.episode_id;
  }
}

export function executionEpisodeEventPayloadDigest(
  value: ExecutionEpisodeEventPayloadV1,
): string {
  return canonicalContractDigest(ExecutionEpisodeEventPayloadV1Schema, value);
}

const ExecutionEpisodeEventHashMaterialV1Schema = z.object({
  contract_version: z.literal("execution_episode_event_v1"),
  event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  operation_kind: BoundedKindSchema,
  operation_id: BoundedIdSchema,
  request_sha256: ExecutionEpisodeSha256Schema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previous_event_sha256: ExecutionEpisodeSha256Schema.nullable(),
  payload_sha256: ExecutionEpisodeSha256Schema,
  occurred_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export type ExecutionEpisodeEventHashMaterialV1 = z.infer<
  typeof ExecutionEpisodeEventHashMaterialV1Schema
>;

export function executionEpisodeEventDigest(
  value: ExecutionEpisodeEventHashMaterialV1,
): string {
  return canonicalContractDigest(ExecutionEpisodeEventHashMaterialV1Schema, value);
}

const ExecutionEpisodeEventEnvelopeObjectV1Schema = z.object({
  contract_version: z.literal("execution_episode_event_v1"),
  event_id: BoundedIdSchema,
  episode_id: BoundedIdSchema,
  operation_kind: BoundedKindSchema,
  operation_id: BoundedIdSchema,
  request_sha256: ExecutionEpisodeSha256Schema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previous_event_sha256: ExecutionEpisodeSha256Schema.nullable(),
  payload: ExecutionEpisodeEventPayloadV1Schema,
  payload_sha256: ExecutionEpisodeSha256Schema,
  event_sha256: ExecutionEpisodeSha256Schema,
  occurred_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export const ExecutionEpisodeEventEnvelopeV1Schema =
  ExecutionEpisodeEventEnvelopeObjectV1Schema.superRefine((value, context) => {
    if (eventPayloadEpisodeId(value.payload) !== value.episode_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message: "Event payload belongs to a different episode",
      });
    }
    if (
      (value.sequence === 0 && value.previous_event_sha256 !== null)
      || (value.sequence > 0 && value.previous_event_sha256 === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previous_event_sha256"],
        message: "Event sequence and previous-event hash do not form a valid chain",
      });
    }
    if (
      value.payload.event_kind === "episode_started"
      && value.sequence !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sequence"],
        message: "episode_started must be the first event in the chain",
      });
    }
    if (
      value.payload.event_kind !== "episode_started"
      && value.sequence === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sequence"],
        message: "Only episode_started may be the first event in the chain",
      });
    }
    const payloadSha256 = executionEpisodeEventPayloadDigest(value.payload);
    if (value.payload_sha256 !== payloadSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload_sha256"],
        message: "Event payload digest does not match its canonical payload",
      });
    }
    const eventSha256 = executionEpisodeEventDigest({
      contract_version: value.contract_version,
      event_id: value.event_id,
      episode_id: value.episode_id,
      operation_kind: value.operation_kind,
      operation_id: value.operation_id,
      request_sha256: value.request_sha256,
      sequence: value.sequence,
      previous_event_sha256: value.previous_event_sha256,
      payload_sha256: value.payload_sha256,
      occurred_at: value.occurred_at,
    });
    if (value.event_sha256 !== eventSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_sha256"],
        message: "Event digest does not match its canonical hash material",
      });
    }
  });

export type ExecutionEpisodeEventEnvelopeV1 = z.infer<
  typeof ExecutionEpisodeEventEnvelopeV1Schema
>;

export function buildExecutionEpisodeEventEnvelopeV1(args: {
  event_id: string;
  episode_id: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  sequence: number;
  previous_event_sha256: string | null;
  payload: ExecutionEpisodeEventPayloadV1;
  occurred_at: string;
}): ExecutionEpisodeEventEnvelopeV1 {
  const payload = ExecutionEpisodeEventPayloadV1Schema.parse(args.payload);
  const payloadSha256 = executionEpisodeEventPayloadDigest(payload);
  const hashMaterial = ExecutionEpisodeEventHashMaterialV1Schema.parse({
    contract_version: "execution_episode_event_v1",
    event_id: args.event_id,
    episode_id: args.episode_id,
    operation_kind: args.operation_kind,
    operation_id: args.operation_id,
    request_sha256: args.request_sha256,
    sequence: args.sequence,
    previous_event_sha256: args.previous_event_sha256,
    payload_sha256: payloadSha256,
    occurred_at: args.occurred_at,
  });
  return ExecutionEpisodeEventEnvelopeV1Schema.parse({
    ...hashMaterial,
    payload,
    event_sha256: executionEpisodeEventDigest(hashMaterial),
  });
}
