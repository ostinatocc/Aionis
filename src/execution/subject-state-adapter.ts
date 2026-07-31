import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const ExactIdSchema = z.string().superRefine((value, context) => {
  if (
    value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Identifier must be exact, non-empty, and at most 256 bytes",
    });
  }
});

const ExactKindSchema = z.string().superRefine((value, context) => {
  if (
    value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 120
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Kind must be exact, non-empty, and at most 120 bytes",
    });
  }
});

const ExactReferenceSchema = z.string().superRefine((value, context) => {
  if (
    value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || value.includes("\r")
    || value.includes("\n")
    || Buffer.byteLength(value, "utf8") > 2_048
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Reference must be exact, single-line, and at most 2,048 bytes",
    });
  }
});

const CanonicalUtcTimestampSchema = z.string().datetime().superRefine(
  (value, context) => {
    const parsed = new Date(value);
    if (
      !Number.isFinite(parsed.getTime())
      || parsed.toISOString() !== value
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Timestamp must be a canonical UTC ISO-8601 instant",
      });
    }
  },
);

const Sha256Schema = z.string().regex(SHA256_PATTERN);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(value: unknown): string {
  return sha256(Buffer.from(stableStringify(value), "utf8"));
}

function canonicalUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export const SubjectStateCapabilityV1Schema = z.enum([
  "capture",
  "delta",
  "restore",
  "runtime_owned_capture",
  "signed_host_capture",
  "verifier_materialization",
]);
export type SubjectStateCapabilityV1 = z.infer<
  typeof SubjectStateCapabilityV1Schema
>;

export const SubjectCapabilityDescriptorV1Schema = z.object({
  contract_version: z.literal("subject_capability_descriptor_v1"),
  subject_kind: ExactKindSchema,
  capabilities: z.array(SubjectStateCapabilityV1Schema).min(1).max(16),
  snapshot_media_types: z.array(ExactReferenceSchema).min(1).max(32),
  delta_media_types: z.array(ExactReferenceSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  for (
    const [field, values] of [
      ["capabilities", value.capabilities],
      ["snapshot_media_types", value.snapshot_media_types],
      ["delta_media_types", value.delta_media_types],
    ] as const
  ) {
    for (let index = 1; index < values.length; index += 1) {
      if (canonicalUtf8Compare(values[index - 1]!, values[index]!) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index],
          message: `${field} must be unique and sorted by unsigned UTF-8 bytes`,
        });
      }
    }
  }
});
export type SubjectCapabilityDescriptorV1 = z.infer<
  typeof SubjectCapabilityDescriptorV1Schema
>;

export function subjectCapabilityDescriptorDigest(
  value: SubjectCapabilityDescriptorV1,
): string {
  return canonicalDigest(SubjectCapabilityDescriptorV1Schema.parse(value));
}

export function subjectCapabilityDescriptorRef(
  descriptorSha256: string,
): string {
  return `urn:aionis:subject-capability:sha256:${Sha256Schema.parse(
    descriptorSha256,
  )}`;
}

export function executionSubjectId(identitySha256: string): string {
  return `esub_${Sha256Schema.parse(identitySha256)}`;
}

export const ExecutionSubjectV1Schema = z.object({
  contract_version: z.literal("execution_subject_v1"),
  subject_id: ExactIdSchema,
  kind: ExactKindSchema,
  adapter_id: ExactKindSchema,
  adapter_version: ExactKindSchema,
  identity_sha256: Sha256Schema,
  capability_descriptor_ref: ExactReferenceSchema,
  capability_descriptor_sha256: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.subject_id !== executionSubjectId(value.identity_sha256)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subject_id"],
      message: "Execution subject identity must derive from identity_sha256",
    });
  }
  if (
    value.capability_descriptor_ref
    !== subjectCapabilityDescriptorRef(value.capability_descriptor_sha256)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["capability_descriptor_ref"],
      message: "Capability descriptor reference must bind its SHA-256",
    });
  }
});
export type ExecutionSubjectV1 = z.infer<typeof ExecutionSubjectV1Schema>;

export function executionSubjectDigest(value: ExecutionSubjectV1): string {
  return canonicalDigest(ExecutionSubjectV1Schema.parse(value));
}

function contentAddressedReference(
  namespace: "state" | "delta",
  digest: string,
): string {
  return `urn:aionis:${namespace}:sha256:${Sha256Schema.parse(digest)}`;
}

export const StateSnapshotV2Schema = z.object({
  contract_version: z.literal("state_snapshot_v2"),
  snapshot_id: ExactIdSchema,
  subject: ExecutionSubjectV1Schema,
  captured_at: CanonicalUtcTimestampSchema,
  algorithm_id: ExactKindSchema,
  algorithm_version: ExactKindSchema,
  environment_sha256: Sha256Schema,
  content_ref: ExactReferenceSchema,
  content_sha256: Sha256Schema,
  content_media_type: ExactReferenceSchema,
  content_encoding: ExactKindSchema,
  capture_authority: z.enum([
    "runtime_adapter",
    "signed_host_adapter",
  ]),
  attestation_ref: ExactReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.content_ref
    !== contentAddressedReference("state", value.content_sha256)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_ref"],
      message: "State content reference must bind its SHA-256",
    });
  }
  if (
    (value.capture_authority === "runtime_adapter")
      !== (value.attestation_ref === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attestation_ref"],
      message:
        "Runtime capture omits host attestation; signed host capture requires it",
    });
  }
});
export type StateSnapshotV2 = z.infer<typeof StateSnapshotV2Schema>;

export function stateSnapshotV2Digest(value: StateSnapshotV2): string {
  return canonicalDigest(StateSnapshotV2Schema.parse(value));
}

export const StateDeltaV1Schema = z.object({
  contract_version: z.literal("state_delta_v1"),
  delta_id: ExactIdSchema,
  subject_id: ExactIdSchema,
  before_snapshot_id: ExactIdSchema,
  after_snapshot_id: ExactIdSchema,
  changed_fields: z.array(ExactReferenceSchema).max(200_000),
  content_ref: ExactReferenceSchema,
  content_sha256: Sha256Schema,
  content_media_type: ExactReferenceSchema,
  content_encoding: ExactKindSchema,
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.changed_fields.length; index += 1) {
    if (
      canonicalUtf8Compare(
        value.changed_fields[index - 1]!,
        value.changed_fields[index]!,
      ) >= 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changed_fields", index],
        message:
          "Changed fields must be unique and sorted by unsigned UTF-8 bytes",
      });
    }
  }
  if (
    value.content_ref
    !== contentAddressedReference("delta", value.content_sha256)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_ref"],
      message: "Delta content reference must bind its SHA-256",
    });
  }
});
export type StateDeltaV1 = z.infer<typeof StateDeltaV1Schema>;

export function stateDeltaV1Digest(value: StateDeltaV1): string {
  return canonicalDigest(StateDeltaV1Schema.parse(value));
}

export type SubjectStateArtifactV1 = Readonly<{
  bytes: Buffer;
  declared_sha256: string;
  declared_byte_length: number;
  media_type: string;
  encoding: string;
}>;

export type CapturedSubjectStateV2 = Readonly<{
  snapshot: StateSnapshotV2;
  artifact: SubjectStateArtifactV1;
}>;

export type CapturedSubjectDeltaV1 = Readonly<{
  delta: StateDeltaV1;
  artifact: SubjectStateArtifactV1;
}>;

export type SubjectVerifierMaterializationV1 = Readonly<{
  contract_version: "subject_verifier_materialization_v1";
  subject: ExecutionSubjectV1;
  source_snapshot_id: string;
  source_content_sha256: string;
  source_environment_sha256: string;
  materialization_id: string;
  subject_root: string;
  scratch_root: string;
  native_handle: unknown;
  cleanup(): void;
}>;

export interface SubjectStateAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly capabilities: SubjectCapabilityDescriptorV1;

  supports(subjectKind: string): boolean;
  identify(input: unknown): Promise<ExecutionSubjectV1>;
  capture(input: Readonly<{
    subject: ExecutionSubjectV1;
    adapter_input: unknown;
    snapshot_identity_seed: string;
    captured_at: string;
  }>): Promise<CapturedSubjectStateV2>;
  diff(input: Readonly<{
    before: CapturedSubjectStateV2;
    after: CapturedSubjectStateV2;
  }>): Promise<CapturedSubjectDeltaV1>;
  restoreSnapshot(input: Readonly<{
    subject: ExecutionSubjectV1;
    adapter_input: unknown;
    snapshot: StateSnapshotV2;
    snapshot_artifact_bytes: Uint8Array;
  }>): Promise<void>;
  materializeForVerifier(input: Readonly<{
    snapshot: StateSnapshotV2;
    snapshot_artifact_bytes: Uint8Array;
  }>): Promise<SubjectVerifierMaterializationV1>;
}

export function stateContentRef(contentSha256: string): string {
  return contentAddressedReference("state", contentSha256);
}

export function stateDeltaContentRef(contentSha256: string): string {
  return contentAddressedReference("delta", contentSha256);
}

export function deterministicSubjectContractId(
  prefix: string,
  material: unknown,
): string {
  return `${prefix}_${canonicalDigest(material)}`;
}
