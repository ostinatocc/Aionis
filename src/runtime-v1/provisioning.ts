import type { SignedAuthorityArtifactV1 } from
  "../continuation/authority-artifact.js";
import {
  CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
  verifyContinuationCompilerPolicyV1,
} from "../continuation/compiler-policy.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationSha256,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import { verifyEffectEvidencePolicyV1 } from
  "../continuation/effect-certificate.js";
import {
  EXPERIMENT_COHORT_SCHEMA_V1,
  verifyExperimentCohortV1,
} from "../continuation/experiment-cohort.js";
import {
  POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
  verifyPolicyRotationAuthorityArtifactV1,
  verifyPolicyRotationPayloadV1,
} from "../continuation/policy-rotation.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../continuation/task-envelope.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactProvisioner,
  type AuthorityPolicyProvisioningBundleV1,
  type ContinuationRuntimeV1AuthorityArtifactProvisioner,
} from "../store/continuation-runtime-v1-authority-artifact-provisioner.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationExecution,
  type ContinuationRuntimeV1OperationStore,
} from "../store/continuation-runtime-v1-operation-store.js";

type OfflineProvisioningCommonV1 = Readonly<{
  schema_version: "offline_provisioning_command_v1";
  tenant_id: string;
  scope: string;
  task_family: string;
  operation_id: string;
  actor_kind: "operator";
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256;
}>;

export type OfflinePolicyBundleInstallCommandV1 = OfflineProvisioningCommonV1
  & Readonly<{
    kind: "policy_bundle_install";
    policy_bundle: AuthorityPolicyProvisioningBundleV1;
  }>;

export type OfflineExperimentCohortInstallCommandV1 = OfflineProvisioningCommonV1
  & Readonly<{
    kind: "experiment_cohort_install";
    experiment_cohort_artifact: SignedAuthorityArtifactV1;
    /** Transient caller-owned bytes. They are never canonical operation data. */
    assignment_seed: Uint8Array;
  }>;

export type OfflinePolicyRotationInstallCommandV1 = OfflineProvisioningCommonV1
  & Readonly<{
    kind: "policy_rotation_install";
    policy_rotation_artifact: SignedAuthorityArtifactV1;
  }>;

export type OfflineProvisioningCommandV1 =
  | OfflinePolicyBundleInstallCommandV1
  | OfflineExperimentCohortInstallCommandV1
  | OfflinePolicyRotationInstallCommandV1;

export type ContinuationRuntimeV1OfflineProvisioningService = Readonly<{
  provision(
    command: OfflineProvisioningCommandV1,
  ): Promise<ContinuationRuntimeV1OperationExecution>;
}>;

type ParsedCommon = Readonly<{
  schema_version: "offline_provisioning_command_v1";
  tenant_id: string;
  scope: string;
  task_family: string;
  operation_id: string;
  actor_kind: "operator";
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256;
}>;

type ParsedCommand =
  | (ParsedCommon & Readonly<{
    kind: "policy_bundle_install";
    policy_bundle: AuthorityPolicyProvisioningBundleV1;
  }>)
  | (ParsedCommon & Readonly<{
    kind: "experiment_cohort_install";
    experiment_cohort_artifact: SignedAuthorityArtifactV1;
    assignment_seed: Buffer;
  }>)
  | (ParsedCommon & Readonly<{
    kind: "policy_rotation_install";
    policy_rotation_artifact: SignedAuthorityArtifactV1;
  }>);

const COMMON_COMMAND_KEYS = Object.freeze([
  "actor_kind",
  "actor_principal_sha256",
  "authority_subject_sha256",
  "kind",
  "operation_id",
  "schema_version",
  "scope",
  "task_family",
  "tenant_id",
] as const);
const POLICY_COMMAND_KEYS = Object.freeze([
  ...COMMON_COMMAND_KEYS,
  "policy_bundle",
] as const);
const COHORT_COMMAND_KEYS = Object.freeze([
  ...COMMON_COMMAND_KEYS,
  "assignment_seed",
  "experiment_cohort_artifact",
] as const);
const ROTATION_COMMAND_KEYS = Object.freeze([
  ...COMMON_COMMAND_KEYS,
  "policy_rotation_artifact",
] as const);
const POLICY_BUNDLE_KEYS = Object.freeze([
  "authority_subject_sha256",
  "compiler_policy",
  "evidence_policy",
  "schema_version",
  "tenant_id",
] as const);
const SIGNED_ARTIFACT_KEYS = Object.freeze([
  "artifact_id",
  "artifact_kind",
  "artifact_revision",
  "artifact_schema",
  "artifact_sha256",
  "authority_subject_sha256",
  "created_at",
  "expires_at",
  "payload",
  "payload_sha256",
  "signature",
  "signature_algorithm",
  "signer_principal_sha256",
  "tenant_id",
  "trust_root_sha256",
  "valid_from",
] as const);

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_offline_provisioning_${code}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) {
    fail(`${field}_shape_invalid`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `offline provisioning ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function discriminator(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    fail("command_must_be_plain_object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    fail("command_discriminator_invalid");
  }
  return descriptor.value;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `offline provisioning ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) fail(`${field}_invalid`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field}_invalid`);
  }
  return value as number;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  try {
    assertSha256(value, `offline provisioning ${field}`);
  } catch {
    fail(`${field}_invalid`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  try {
    assertCanonicalUtcMillis(value, `offline provisioning ${field}`);
  } catch {
    fail(`${field}_invalid`);
  }
  return value;
}

function signedArtifact(
  value: unknown,
  args: Readonly<{
    field: string;
    tenant_id: string;
    authority_subject_sha256: Sha256;
    artifact_kind: SignedAuthorityArtifactV1["artifact_kind"];
    artifact_schema: string;
    parse_payload(value: unknown): Readonly<{ readonly [key: string]: CanonicalJson }>;
  }>,
): SignedAuthorityArtifactV1 {
  const record = exactRecord(value, SIGNED_ARTIFACT_KEYS, args.field);
  const payload = args.parse_payload(record.payload);
  const tenantId = text(record.tenant_id, `${args.field}_tenant_id`);
  const subject = sha256(
    record.authority_subject_sha256,
    `${args.field}_authority_subject_sha256`,
  );
  if (tenantId !== args.tenant_id) fail(`${args.field}_tenant_mismatch`);
  if (subject !== args.authority_subject_sha256) fail(`${args.field}_subject_mismatch`);
  if (record.artifact_kind !== args.artifact_kind
    || record.artifact_schema !== args.artifact_schema) {
    fail(`${args.field}_kind_invalid`);
  }
  if (record.signature_algorithm !== "ed25519") {
    fail(`${args.field}_signature_algorithm_invalid`);
  }
  const payloadSha256 = sha256(record.payload_sha256, `${args.field}_payload_sha256`);
  if (canonicalContinuationSha256(payload) !== payloadSha256) {
    fail(`${args.field}_payload_digest_mismatch`);
  }
  const createdAt = timestamp(record.created_at, `${args.field}_created_at`);
  const validFrom = timestamp(record.valid_from, `${args.field}_valid_from`);
  const expiresAt = record.expires_at === null
    ? null : timestamp(record.expires_at, `${args.field}_expires_at`);
  if (createdAt > validFrom || (expiresAt !== null && validFrom >= expiresAt)) {
    fail(`${args.field}_validity_invalid`);
  }
  return canonicalContinuationClone({
    tenant_id: tenantId,
    artifact_id: text(record.artifact_id, `${args.field}_artifact_id`),
    artifact_revision: positiveInteger(
      record.artifact_revision,
      `${args.field}_artifact_revision`,
    ),
    artifact_kind: args.artifact_kind,
    artifact_schema: args.artifact_schema,
    authority_subject_sha256: subject,
    payload,
    payload_sha256: payloadSha256,
    artifact_sha256: sha256(record.artifact_sha256, `${args.field}_artifact_sha256`),
    signer_principal_sha256: sha256(
      record.signer_principal_sha256,
      `${args.field}_signer_principal_sha256`,
    ),
    trust_root_sha256: sha256(
      record.trust_root_sha256,
      `${args.field}_trust_root_sha256`,
    ),
    signature_algorithm: "ed25519" as const,
    valid_from: validFrom,
    expires_at: expiresAt,
    created_at: createdAt,
    signature: text(record.signature, `${args.field}_signature`, 128),
  }) as SignedAuthorityArtifactV1;
}

function common(record: Readonly<Record<string, unknown>>): ParsedCommon {
  if (record.schema_version !== "offline_provisioning_command_v1") {
    fail("command_schema_invalid");
  }
  if (record.actor_kind !== "operator") fail("actor_kind_invalid");
  const tenantId = text(record.tenant_id, "tenant_id");
  const scope = text(record.scope, "scope");
  const taskFamily = text(record.task_family, "task_family");
  const subject = sha256(record.authority_subject_sha256, "authority_subject_sha256");
  if (continuationAuthoritySubjectSha256V1({
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
  }) !== subject) fail("authority_subject_binding_invalid");
  return canonicalContinuationClone({
    schema_version: "offline_provisioning_command_v1" as const,
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
    operation_id: text(record.operation_id, "operation_id"),
    actor_kind: "operator" as const,
    actor_principal_sha256: sha256(
      record.actor_principal_sha256,
      "actor_principal_sha256",
    ),
    authority_subject_sha256: subject,
  });
}

function policyBundle(
  value: unknown,
  binding: ParsedCommon,
): AuthorityPolicyProvisioningBundleV1 {
  const record = exactRecord(value, POLICY_BUNDLE_KEYS, "policy_bundle");
  if (record.schema_version !== "authority_policy_provisioning_bundle_v1") {
    fail("policy_bundle_schema_invalid");
  }
  if (text(record.tenant_id, "policy_bundle_tenant_id") !== binding.tenant_id) {
    fail("policy_bundle_tenant_mismatch");
  }
  if (sha256(record.authority_subject_sha256, "policy_bundle_subject")
    !== binding.authority_subject_sha256) fail("policy_bundle_subject_mismatch");
  const compiler = signedArtifact(record.compiler_policy, {
    field: "compiler_policy",
    tenant_id: binding.tenant_id,
    authority_subject_sha256: binding.authority_subject_sha256,
    artifact_kind: "compiler_policy",
    artifact_schema: CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
    parse_payload: verifyContinuationCompilerPolicyV1,
  });
  const evidence = signedArtifact(record.evidence_policy, {
    field: "evidence_policy",
    tenant_id: binding.tenant_id,
    authority_subject_sha256: binding.authority_subject_sha256,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    parse_payload: verifyEffectEvidencePolicyV1,
  });
  const compilerPayload = verifyContinuationCompilerPolicyV1(compiler.payload);
  const evidencePayload = verifyEffectEvidencePolicyV1(evidence.payload);
  if (compilerPayload.tenant_id !== binding.tenant_id
    || evidencePayload.tenant_id !== binding.tenant_id) {
    fail("policy_bundle_payload_tenant_mismatch");
  }
  if (compilerPayload.authority_subject_sha256
      !== binding.authority_subject_sha256
    || evidencePayload.authority_subject_sha256
      !== binding.authority_subject_sha256) {
    fail("policy_bundle_payload_subject_mismatch");
  }
  return canonicalContinuationClone({
    schema_version: "authority_policy_provisioning_bundle_v1" as const,
    tenant_id: binding.tenant_id,
    authority_subject_sha256: binding.authority_subject_sha256,
    compiler_policy: compiler,
    evidence_policy: evidence,
  });
}

function parseCommand(value: unknown): ParsedCommand {
  const kind = discriminator(value);
  const keys = kind === "policy_bundle_install"
    ? POLICY_COMMAND_KEYS
    : kind === "experiment_cohort_install"
      ? COHORT_COMMAND_KEYS
      : kind === "policy_rotation_install"
        ? ROTATION_COMMAND_KEYS
        : fail("command_kind_invalid");
  const record = exactRecord(value, keys, "command");
  const binding = common(record);
  if (kind === "policy_bundle_install") {
    return {
      ...binding,
      kind,
      policy_bundle: policyBundle(record.policy_bundle, binding),
    };
  }
  if (kind === "experiment_cohort_install") {
    if (!(record.assignment_seed instanceof Uint8Array)
      || record.assignment_seed.byteLength !== 32) {
      fail("assignment_seed_must_be_exactly_32_bytes");
    }
    const artifact = signedArtifact(record.experiment_cohort_artifact, {
      field: "experiment_cohort_artifact",
      tenant_id: binding.tenant_id,
      authority_subject_sha256: binding.authority_subject_sha256,
      artifact_kind: "experiment_cohort",
      artifact_schema: EXPERIMENT_COHORT_SCHEMA_V1,
      parse_payload: verifyExperimentCohortV1,
    });
    const cohort = verifyExperimentCohortV1(artifact.payload);
    if (cohort.tenant_id !== binding.tenant_id
      || cohort.scope !== binding.scope
      || cohort.task_family !== binding.task_family
      || cohort.authority_subject_sha256 !== binding.authority_subject_sha256) {
      fail("experiment_cohort_binding_invalid");
    }
    const seed = Buffer.from(record.assignment_seed);
    if (assignmentSeedCommitmentSha256V1(seed)
      !== cohort.assignment_protocol.assignment_seed_commitment_sha256) {
      seed.fill(0);
      fail("assignment_seed_commitment_mismatch");
    }
    return {
      ...binding,
      kind,
      experiment_cohort_artifact: artifact,
      assignment_seed: seed,
    };
  }
  const artifact = signedArtifact(record.policy_rotation_artifact, {
    field: "policy_rotation_artifact",
    tenant_id: binding.tenant_id,
    authority_subject_sha256: binding.authority_subject_sha256,
    artifact_kind: "policy_rotation",
    artifact_schema: POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
    parse_payload: verifyPolicyRotationPayloadV1,
  });
  const rotation = verifyPolicyRotationAuthorityArtifactV1(artifact);
  if (rotation.payload.tenant_id !== binding.tenant_id
    || rotation.payload.authority_subject_sha256
      !== binding.authority_subject_sha256) {
    fail("policy_rotation_binding_invalid");
  }
  return {
    ...binding,
    kind: "policy_rotation_install",
    policy_rotation_artifact: rotation,
  };
}

/** Pure command-contract verification. No database, secret persistence, or signing occurs. */
export function assertOfflineProvisioningCommandV1(
  value: unknown,
): asserts value is OfflineProvisioningCommandV1 {
  const parsed = parseCommand(value);
  if (parsed.kind === "experiment_cohort_install") {
    parsed.assignment_seed.fill(0);
  }
}

function operationRequest(command: ParsedCommand) {
  const binding = {
    schema_version: "offline_provisioning_request_v1" as const,
    kind: command.kind,
    tenant_id: command.tenant_id,
    scope: command.scope,
    task_family: command.task_family,
    authority_subject_sha256: command.authority_subject_sha256,
  };
  if (command.kind === "policy_bundle_install") {
    return canonicalContinuationClone({
      ...binding,
      policy_bundle: command.policy_bundle,
    });
  }
  if (command.kind === "experiment_cohort_install") {
    return canonicalContinuationClone({
      ...binding,
      experiment_cohort_artifact: command.experiment_cohort_artifact,
    });
  }
  return canonicalContinuationClone({
    ...binding,
    policy_rotation_artifact: command.policy_rotation_artifact,
  });
}

/**
 * Offline-only installation boundary. It accepts root-signed public artifacts
 * and an authenticated operator identity, but never accepts or loads a root
 * private/signing key. Policy rotation is installed here and applied later by
 * the online governed authority decision path.
 */
export function createContinuationRuntimeV1OfflineProvisioningService(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactProvisioner,
  operationStore: ContinuationRuntimeV1OperationStore,
): ContinuationRuntimeV1OfflineProvisioningService {
  assertContinuationRuntimeV1AuthorityArtifactProvisioner(artifactStore, database);
  return Object.freeze({
    async provision(
      value: OfflineProvisioningCommandV1,
    ): Promise<ContinuationRuntimeV1OperationExecution> {
      const command = parseCommand(value);
      try {
        const request = operationRequest(command);
        return await operationStore.execute({
          tenantId: command.tenant_id,
          scope: command.scope,
          operationKind: "authority_decision",
          operationId: command.operation_id,
          actorKind: "operator",
          actorPrincipalSha256: command.actor_principal_sha256,
          request,
          produce: async (context) => {
            if (command.kind === "policy_bundle_install") {
              await artifactStore.putBundle(context, command.policy_bundle);
            } else if (command.kind === "experiment_cohort_install") {
              await artifactStore.putExperimentCohort(
                context,
                command.experiment_cohort_artifact,
                command.assignment_seed,
              );
            } else {
              await artifactStore.put(context, command.policy_rotation_artifact);
            }
            return deriveContinuationRuntimeV1OperationResultV1(
              database,
              assertContinuationRuntimeV1AuthorityWriteContext(context, database),
              "before_receipt_insert",
            );
          },
        });
      } finally {
        if (command.kind === "experiment_cohort_install") {
          command.assignment_seed.fill(0);
        }
      }
    },
  });
}
