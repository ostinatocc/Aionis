import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  LearningExternalCanonicalUtcMillisSchema,
  LearningExternalEd25519SignatureBase64Schema,
  learningExternalEd25519PublicKeyDigest,
  verifyLearningExternalReceiptWithExplicitSigner,
} from "./learning-external-authority.js";
import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "./learning-episode-ledger.js";

const MAX_CANONICAL_DATABASE_BINDING_RECEIPT_BYTES = 16 * 1024;
const DigestSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CanonicalUnsigned64DecimalSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn, {
    message: "Expected a canonical unsigned 64-bit decimal integer",
  });
const CanonicalPositiveUnsigned64DecimalSchema = CanonicalUnsigned64DecimalSchema.refine(
  (value) => value !== "0",
  { message: "Expected a positive canonical unsigned 64-bit decimal integer" },
);

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const BoundedIdSchema = z.string().superRefine((value, context) => {
  if (value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > 256
    || containsUnpairedSurrogate(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected an exact identifier bounded to 256 UTF-8 bytes",
    });
  }
});

export const LearningRuntimeDatabaseBindingFirstChainV1Schema = z.object({
  chain_kind: z.literal("first"),
  first_binding_anchor_sha256: DigestSha256Schema,
}).strict();

export const LearningRuntimeDatabaseBindingSuccessorChainV1Schema = z.object({
  chain_kind: z.literal("successor"),
  previous_database_binding_receipt_sha256: DigestSha256Schema,
}).strict();

export const LearningRuntimeDatabaseBindingChainV1Schema = z.discriminatedUnion(
  "chain_kind",
  [
    LearningRuntimeDatabaseBindingFirstChainV1Schema,
    LearningRuntimeDatabaseBindingSuccessorChainV1Schema,
  ],
);

export const LearningRuntimeDatabaseBindingReceiptBodyV1Schema = z.object({
  contract_version: z.literal("aionis_learning_runtime_database_binding_receipt_body_v1"),
  deployment_slot: BoundedIdSchema,
  external_execution_policy_sha256: DigestSha256Schema,
  database_instance_id: DigestSha256Schema,
  database_file_device: CanonicalUnsigned64DecimalSchema,
  database_file_inode: CanonicalUnsigned64DecimalSchema,
  checkpoint_generation: CanonicalPositiveUnsigned64DecimalSchema,
  database_main_file_byte_length: CanonicalUnsigned64DecimalSchema,
  database_main_file_sha256: DigestSha256Schema,
  wal_checkpoint_mode: z.literal("truncate"),
  wal_checkpoint_busy: z.literal(0),
  wal_checkpoint_log_frame_count: z.literal(0),
  wal_checkpointed_frame_count: z.literal(0),
  wal_file_byte_length: z.literal("0"),
  wal_checkpointed_and_truncated: z.literal(true),
  writer_fence_inspection_sha256: DigestSha256Schema,
  binding_chain: LearningRuntimeDatabaseBindingChainV1Schema,
  service_launcher_policy_sha256: DigestSha256Schema,
  service_launcher_binary_sha256: DigestSha256Schema,
  service_launcher_public_key_sha256: DigestSha256Schema,
  service_launcher_key_id: BoundedIdSchema,
  attestor_service_identity: BoundedIdSchema,
  attestor_binary_sha256: DigestSha256Schema,
  attestor_policy_sha256: DigestSha256Schema,
  attestor_public_key_sha256: DigestSha256Schema,
  attestor_key_id: BoundedIdSchema,
  issued_at: LearningExternalCanonicalUtcMillisSchema,
}).strict().superRefine((value, context) => {
  if (value.service_launcher_public_key_sha256 === value.attestor_public_key_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["service_launcher_public_key_sha256"],
      message: "Runtime database binding launcher and attestor keys must be distinct",
    });
  }
});

export type LearningRuntimeDatabaseBindingReceiptBodyV1 = z.infer<
  typeof LearningRuntimeDatabaseBindingReceiptBodyV1Schema
>;

export const LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema = z.object({
  body: LearningRuntimeDatabaseBindingReceiptBodyV1Schema,
  signature_algorithm: z.literal("ed25519-v1"),
  signature_base64: LearningExternalEd25519SignatureBase64Schema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(stableStringify(value), "utf8")
    > MAX_CANONICAL_DATABASE_BINDING_RECEIPT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "Runtime database binding receipt exceeds the canonical byte limit",
    });
  }
});

export type LearningRuntimeDatabaseBindingReceiptEnvelopeV1 = z.infer<
  typeof LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema
>;

export type LearningRuntimeDatabaseBindingReceiptCryptographicVerificationV1 =
  Readonly<{
    contract_version:
      "aionis_learning_runtime_database_binding_cryptographic_verification_v1";
    authority_scope: "cryptographic_relation_only";
    signing_eligible: false;
    receipt: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
    receipt_sha256: string;
  }>;

export type LearningRuntimeDatabaseBindingChainExpectationV1 =
  | Readonly<{
    chainKind: "first";
    /** Must come from the launcher-owned deployment-slot epoch state. */
    expectedFirstBindingAnchorSha256: string;
    /** Must come from the launcher-owned durable generation reservation. */
    expectedCheckpointGeneration: string;
  }>
  | Readonly<{
    chainKind: "successor";
    /** Locator bytes are reverified; they are not themselves the durable head. */
    previousReceipt: unknown;
    /** The policy stored with the durable predecessor, which may be historical. */
    previousExternalExecutionPolicy: ExternalExecutionPolicyV1;
    previousRegisteredExternalExecutionPolicySha256: string;
    /** Must come from the launcher-owned deployment-slot durable chain head. */
    expectedPreviousReceiptSha256: string;
    /** Must come from the launcher-owned durable generation reservation. */
    expectedCheckpointGeneration: string;
  }>;

function canonicalJson<T>(schema: z.ZodType<T>, value: unknown): string {
  return stableStringify(schema.parse(value));
}

function parseCanonicalJson<T>(args: Readonly<{
  contractName: string;
  raw: string | Uint8Array;
  schema: z.ZodType<T>;
}>): T {
  const byteLength = typeof args.raw === "string"
    ? Buffer.byteLength(args.raw, "utf8")
    : args.raw.byteLength;
  if (byteLength > MAX_CANONICAL_DATABASE_BINDING_RECEIPT_BYTES) {
    throw new Error(`${args.contractName}_oversized`);
  }
  if (typeof args.raw !== "string"
    && args.raw.byteLength >= 3
    && args.raw[0] === 0xef
    && args.raw[1] === 0xbb
    && args.raw[2] === 0xbf) {
    throw new Error(`${args.contractName}_utf8_bom_forbidden`);
  }
  let raw: string;
  try {
    raw = typeof args.raw === "string"
      ? args.raw
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(args.raw);
  } catch {
    throw new Error(`${args.contractName}_invalid_utf8`);
  }
  if (raw.startsWith("\ufeff")) {
    throw new Error(`${args.contractName}_utf8_bom_forbidden`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${args.contractName}_invalid_json`);
  }
  const parsed = args.schema.parse(decoded);
  if (stableStringify(parsed) !== raw) {
    throw new Error(`${args.contractName}_noncanonical_json`);
  }
  return parsed;
}

export function learningRuntimeDatabaseBindingReceiptBodyJson(value: unknown): string {
  return canonicalJson(LearningRuntimeDatabaseBindingReceiptBodyV1Schema, value);
}

export function learningRuntimeDatabaseBindingReceiptBodyDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningRuntimeDatabaseBindingReceiptBodyJson(value))
    .digest("hex");
}

export function parseCanonicalLearningRuntimeDatabaseBindingReceiptBodyJson(
  raw: string | Uint8Array,
): LearningRuntimeDatabaseBindingReceiptBodyV1 {
  return parseCanonicalJson({
    contractName: "learning_runtime_database_binding_receipt_body",
    raw,
    schema: LearningRuntimeDatabaseBindingReceiptBodyV1Schema,
  });
}

export function learningRuntimeDatabaseBindingReceiptJson(value: unknown): string {
  return canonicalJson(LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema, value);
}

/** Digest of the complete signed envelope; this is the D1 receipt binding. */
export function learningRuntimeDatabaseBindingReceiptDigest(value: unknown): string {
  return createHash("sha256")
    .update(learningRuntimeDatabaseBindingReceiptJson(value))
    .digest("hex");
}

export function parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(
  raw: string | Uint8Array,
): LearningRuntimeDatabaseBindingReceiptEnvelopeV1 {
  return parseCanonicalJson({
    contractName: "learning_runtime_database_binding_receipt",
    raw,
    schema: LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema,
  });
}

function bindingError(code: string, field?: string): never {
  throw new Error(
    `learning_runtime_database_binding_receipt_${code}${field ? `:${field}` : ""}`,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function cryptographicVerification(
  envelope: LearningRuntimeDatabaseBindingReceiptEnvelopeV1,
): LearningRuntimeDatabaseBindingReceiptCryptographicVerificationV1 {
  const receipt = deepFreeze(envelope);
  return Object.freeze({
    contract_version:
      "aionis_learning_runtime_database_binding_cryptographic_verification_v1",
    authority_scope: "cryptographic_relation_only",
    signing_eligible: false,
    receipt,
    receipt_sha256: learningRuntimeDatabaseBindingReceiptDigest(receipt),
  });
}

type VerifiedPolicyContext = Readonly<{
  policy: ExternalExecutionPolicyV1;
  registeredPolicySha256: string;
  expectedDeploymentSlot: string;
}>;

function resolveVerifiedPolicyContext(args: Readonly<{
  externalExecutionPolicy: ExternalExecutionPolicyV1;
  registeredExternalExecutionPolicySha256: string;
  expectedDeploymentSlot: string;
}>): VerifiedPolicyContext {
  const policy = ExternalExecutionPolicyV1Schema.parse(args.externalExecutionPolicy);
  const registeredPolicySha256 = DigestSha256Schema.parse(
    args.registeredExternalExecutionPolicySha256,
  );
  if (externalExecutionPolicyDigest(policy) !== registeredPolicySha256) {
    return bindingError("external_execution_policy_digest_mismatch");
  }
  return Object.freeze({
    policy,
    registeredPolicySha256,
    expectedDeploymentSlot: BoundedIdSchema.parse(args.expectedDeploymentSlot),
  });
}

function verifyPolicyBoundEnvelope(
  envelopeInput: unknown,
  context: VerifiedPolicyContext,
): LearningRuntimeDatabaseBindingReceiptEnvelopeV1 {
  const envelope = LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema.parse(envelopeInput);
  const body = envelope.body;
  const expected = context.policy.runtime_authority_attestor;
  const expectedLauncherPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    expected.service_launcher_public_key_base64,
  );
  if (expectedLauncherPublicKeySha256 !== expected.service_launcher_public_key_sha256) {
    return bindingError("launcher_public_key_mismatch");
  }
  const expectedBindings: ReadonlyArray<readonly [unknown, unknown, string]> = [
    [body.deployment_slot, context.expectedDeploymentSlot, "deployment_slot"],
    [body.external_execution_policy_sha256, context.registeredPolicySha256,
      "external_execution_policy_sha256"],
    [body.database_instance_id, expected.expected_database_instance_id,
      "database_instance_id"],
    [body.service_launcher_policy_sha256, expected.service_launcher_policy_sha256,
      "service_launcher_policy_sha256"],
    [body.service_launcher_binary_sha256, expected.service_launcher_binary_sha256,
      "service_launcher_binary_sha256"],
    [body.service_launcher_public_key_sha256, expectedLauncherPublicKeySha256,
      "service_launcher_public_key_sha256"],
    [body.service_launcher_key_id, expected.service_launcher_key_id,
      "service_launcher_key_id"],
    [body.attestor_service_identity, expected.service_identity,
      "attestor_service_identity"],
    [body.attestor_binary_sha256, expected.attestor_binary_sha256,
      "attestor_binary_sha256"],
    [body.attestor_policy_sha256, expected.attestor_policy_sha256,
      "attestor_policy_sha256"],
    [body.attestor_public_key_sha256, expected.attestor_public_key_sha256,
      "attestor_public_key_sha256"],
    [body.attestor_key_id, expected.attestor_key_id, "attestor_key_id"],
  ];
  for (const [actual, expectedValue, field] of expectedBindings) {
    if (actual !== expectedValue) return bindingError("binding_mismatch", field);
  }
  const verified = verifyLearningExternalReceiptWithExplicitSigner({
    bodySchema: LearningRuntimeDatabaseBindingReceiptBodyV1Schema,
    envelope,
    expectedPublicKeyBase64: expected.service_launcher_public_key_base64,
    expectedPublicKeySha256: expectedLauncherPublicKeySha256,
  });
  return LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema.parse(verified);
}

/**
 * Pure cryptographic verifier for a launcher-signed physical database binding.
 * No independent public-key argument is accepted: the launcher key is selected
 * only from the supplied policy, and that policy must match the supplied
 * registered digest. This pure layer does not prove those two values came from
 * the live Runtime revision. D3's store composition must supply them through a
 * same-snapshot opaque database capability, and must likewise source the slot
 * and chain expectation from durable launcher state.
 */
export function verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation(
  args: Readonly<{
    envelope: unknown;
    externalExecutionPolicy: ExternalExecutionPolicyV1;
    registeredExternalExecutionPolicySha256: string;
    expectedDeploymentSlot: string;
    chainExpectation: LearningRuntimeDatabaseBindingChainExpectationV1;
  }>,
): LearningRuntimeDatabaseBindingReceiptCryptographicVerificationV1 {
  const context = resolveVerifiedPolicyContext(args);
  const envelope = verifyPolicyBoundEnvelope(args.envelope, context);
  const expectedCheckpointGeneration =
    CanonicalPositiveUnsigned64DecimalSchema.parse(
      args.chainExpectation.expectedCheckpointGeneration,
    );
  if (envelope.body.checkpoint_generation !== expectedCheckpointGeneration) {
    return bindingError("durable_checkpoint_generation_mismatch");
  }
  const chain = envelope.body.binding_chain;
  if (args.chainExpectation.chainKind === "first") {
    if (chain.chain_kind !== "first") {
      return bindingError("chain_kind_mismatch", "first");
    }
    const expectedAnchor = DigestSha256Schema.parse(
      args.chainExpectation.expectedFirstBindingAnchorSha256,
    );
    if (chain.first_binding_anchor_sha256 !== expectedAnchor) {
      return bindingError("first_binding_anchor_mismatch");
    }
    return cryptographicVerification(envelope);
  }

  if (chain.chain_kind !== "successor") {
    return bindingError("chain_kind_mismatch", "successor");
  }
  const previousContext = resolveVerifiedPolicyContext({
    externalExecutionPolicy:
      args.chainExpectation.previousExternalExecutionPolicy,
    registeredExternalExecutionPolicySha256:
      args.chainExpectation.previousRegisteredExternalExecutionPolicySha256,
    expectedDeploymentSlot: context.expectedDeploymentSlot,
  });
  const previous = verifyPolicyBoundEnvelope(
    args.chainExpectation.previousReceipt,
    previousContext,
  );
  const previousReceiptSha256 = learningRuntimeDatabaseBindingReceiptDigest(previous);
  const expectedPreviousReceiptSha256 = DigestSha256Schema.parse(
    args.chainExpectation.expectedPreviousReceiptSha256,
  );
  if (previousReceiptSha256 !== expectedPreviousReceiptSha256) {
    return bindingError("durable_chain_head_mismatch");
  }
  if (chain.previous_database_binding_receipt_sha256 !== expectedPreviousReceiptSha256) {
    return bindingError("previous_binding_receipt_digest_mismatch");
  }
  const body = envelope.body;
  const previousBody = previous.body;
  if (body.database_instance_id !== previousBody.database_instance_id) {
    return bindingError("physical_database_identity_changed", "database_instance_id");
  }
  if (body.database_file_device !== previousBody.database_file_device) {
    return bindingError("physical_database_identity_changed", "database_file_device");
  }
  if (body.database_file_inode !== previousBody.database_file_inode) {
    return bindingError("physical_database_identity_changed", "database_file_inode");
  }
  // A crash after reserving and fsyncing a generation may burn a number. Gaps
  // are valid, but reuse, equality, or rollback can never be accepted.
  if (BigInt(body.checkpoint_generation) <= BigInt(previousBody.checkpoint_generation)) {
    return bindingError("checkpoint_generation_not_monotonic");
  }
  if (body.issued_at < previousBody.issued_at) {
    return bindingError("issued_at_precedes_previous_receipt");
  }
  return cryptographicVerification(envelope);
}
