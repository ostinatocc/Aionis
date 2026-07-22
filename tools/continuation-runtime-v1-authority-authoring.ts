import { createPublicKey, type KeyObject } from "node:crypto";

import {
  buildSignedAuthorityArtifactV1,
  verifySignedAuthorityArtifactV1,
  type AuthorityArtifactKindV1,
  type SignedAuthorityArtifactV1,
} from "../src/continuation/authority-artifact.js";
import {
  CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
  verifyContinuationCompilerPolicyV1,
} from "../src/continuation/compiler-policy.js";
import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type CanonicalJson,
  type Sha256,
} from "../src/continuation/contract.js";
import { verifyEffectEvidencePolicyV1 } from
  "../src/continuation/effect-certificate.js";
import {
  EXPERIMENT_COHORT_SCHEMA_V1,
  assertExperimentCohortArtifactWindowV1,
  verifyExperimentCohortV1,
} from "../src/continuation/experiment-cohort.js";
import {
  POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
  verifyPolicyRotationAuthorityArtifactV1,
  verifyPolicyRotationPayloadV1,
} from "../src/continuation/policy-rotation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../src/continuation/task-envelope.js";
import { continuationRuntimeV1PrincipalSha256 } from
  "../src/runtime-v1/principal.js";

export const OFFLINE_AUTHORITY_AUTHORING_REQUEST_SCHEMA_V1 =
  "offline_authority_authoring_request_v1" as const;

const COMMON_KEYS = Object.freeze([
  "kind",
  "operation_id",
  "operator_principal_id",
  "schema_version",
  "scope",
  "task_family",
  "tenant_id",
] as const);
const POLICY_KEYS = Object.freeze([
  ...COMMON_KEYS,
  "compiler_policy",
  "evidence_policy",
] as const);
const COHORT_KEYS = Object.freeze([
  ...COMMON_KEYS,
  "experiment_cohort",
] as const);
const ROTATION_KEYS = Object.freeze([
  ...COMMON_KEYS,
  "policy_rotation",
] as const);
const ARTIFACT_DRAFT_KEYS = Object.freeze([
  "artifact_id",
  "artifact_revision",
  "created_at",
  "expires_at",
  "payload",
  "valid_from",
] as const);

export type AuthorityAuthoringFailureCode =
  | "request_invalid"
  | "payload_invalid"
  | "payload_binding_invalid"
  | "artifact_identity_collision"
  | "signing_failed"
  | "signature_self_check_failed";

export class AuthorityAuthoringError extends Error {
  readonly code: AuthorityAuthoringFailureCode;

  constructor(code: AuthorityAuthoringFailureCode) {
    super(`continuation_runtime_v1_authority_authoring_${code}`);
    this.name = "AuthorityAuthoringError";
    this.code = code;
  }
}

type ArtifactDraft = Readonly<{
  artifact_id: string;
  artifact_revision: number;
  created_at: string;
  expires_at: string | null;
  payload: unknown;
  valid_from: string;
}>;

type ParsedCommon = Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
  operation_id: string;
  operator_principal_id: string;
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256;
}>;

type ParsedRequest =
  | (ParsedCommon & Readonly<{
    kind: "policy_bundle_install";
    compiler_policy: ArtifactDraft;
    evidence_policy: ArtifactDraft;
  }>)
  | (ParsedCommon & Readonly<{
    kind: "experiment_cohort_install";
    experiment_cohort: ArtifactDraft;
  }>)
  | (ParsedCommon & Readonly<{
    kind: "policy_rotation_install";
    policy_rotation: ArtifactDraft;
  }>);

export type SeedlessOfflineAuthorityCommandV1 = Readonly<{
  schema_version: "offline_provisioning_command_v1";
  tenant_id: string;
  scope: string;
  task_family: string;
  operation_id: string;
  actor_kind: "operator";
  actor_principal_sha256: Sha256;
  authority_subject_sha256: Sha256;
  kind:
    | "policy_bundle_install"
    | "experiment_cohort_install"
    | "policy_rotation_install";
  policy_bundle?: Readonly<{
    schema_version: "authority_policy_provisioning_bundle_v1";
    tenant_id: string;
    authority_subject_sha256: Sha256;
    compiler_policy: SignedAuthorityArtifactV1;
    evidence_policy: SignedAuthorityArtifactV1;
  }>;
  experiment_cohort_artifact?: SignedAuthorityArtifactV1;
  policy_rotation_artifact?: SignedAuthorityArtifactV1;
}>;

function fail(code: AuthorityAuthoringFailureCode): never {
  throw new AuthorityAuthoringError(code);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("request_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expectedKeys.length
    || keys.some((key) => !expected.has(key as string))) {
    fail("request_invalid");
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("request_invalid");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string") fail("request_invalid");
  try {
    assertUnicodeScalarString(value, "offline authority authoring text");
  } catch {
    fail("request_invalid");
  }
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) fail("request_invalid");
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("request_invalid");
  }
  return value as number;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") fail("request_invalid");
  try {
    assertCanonicalUtcMillis(value, "offline authority authoring timestamp");
  } catch {
    fail("request_invalid");
  }
  return value;
}

function artifactDraft(value: unknown): ArtifactDraft {
  const record = exactRecord(value, ARTIFACT_DRAFT_KEYS);
  const createdAt = timestamp(record.created_at);
  const validFrom = timestamp(record.valid_from);
  const expiresAt = record.expires_at === null
    ? null
    : timestamp(record.expires_at);
  if (Date.parse(createdAt) > Date.parse(validFrom)
    || (expiresAt !== null && Date.parse(validFrom) >= Date.parse(expiresAt))) {
    fail("request_invalid");
  }
  if (record.payload === null || typeof record.payload !== "object"
    || Array.isArray(record.payload)) fail("payload_invalid");
  return Object.freeze({
    artifact_id: text(record.artifact_id),
    artifact_revision: positiveInteger(record.artifact_revision),
    created_at: createdAt,
    expires_at: expiresAt,
    payload: record.payload,
    valid_from: validFrom,
  });
}

function discriminator(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("request_invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    fail("request_invalid");
  }
  return descriptor.value;
}

function parseCommon(
  record: Readonly<Record<string, unknown>>,
): ParsedCommon {
  if (record.schema_version !== OFFLINE_AUTHORITY_AUTHORING_REQUEST_SCHEMA_V1) {
    fail("request_invalid");
  }
  const tenantId = text(record.tenant_id);
  const scope = text(record.scope);
  const taskFamily = text(record.task_family);
  const operatorPrincipalId = text(record.operator_principal_id);
  const authoritySubjectSha256 = continuationAuthoritySubjectSha256V1({
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
  });
  return Object.freeze({
    tenant_id: tenantId,
    scope,
    task_family: taskFamily,
    operation_id: text(record.operation_id),
    operator_principal_id: operatorPrincipalId,
    actor_principal_sha256: continuationRuntimeV1PrincipalSha256({
      tenant_id: tenantId,
      principal_kind: "operator",
      principal_id: operatorPrincipalId,
    }),
    authority_subject_sha256: authoritySubjectSha256,
  });
}

function parseRequest(value: unknown): ParsedRequest {
  const kind = discriminator(value);
  const keys = kind === "policy_bundle_install"
    ? POLICY_KEYS
    : kind === "experiment_cohort_install"
      ? COHORT_KEYS
      : kind === "policy_rotation_install"
        ? ROTATION_KEYS
        : fail("request_invalid");
  const record = exactRecord(value, keys);
  const common = parseCommon(record);
  if (kind === "policy_bundle_install") {
    return Object.freeze({
      ...common,
      kind,
      compiler_policy: artifactDraft(record.compiler_policy),
      evidence_policy: artifactDraft(record.evidence_policy),
    });
  }
  if (kind === "experiment_cohort_install") {
    return Object.freeze({
      ...common,
      kind,
      experiment_cohort: artifactDraft(record.experiment_cohort),
    });
  }
  return Object.freeze({
    ...common,
    kind: "policy_rotation_install" as const,
    policy_rotation: artifactDraft(record.policy_rotation),
  });
}

function payload<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AuthorityAuthoringError) throw error;
    fail("payload_invalid");
  }
}

function assertPayloadBinding(
  actualTenantId: string,
  actualSubject: Sha256 | null,
  expected: ParsedCommon,
): void {
  if (actualTenantId !== expected.tenant_id
    || actualSubject !== expected.authority_subject_sha256) {
    fail("payload_binding_invalid");
  }
}

function signArtifact(
  draft: ArtifactDraft,
  args: Readonly<{
    tenant_id: string;
    authority_subject_sha256: Sha256;
    artifact_kind: AuthorityArtifactKindV1;
    artifact_schema: string;
    payload: Readonly<{ readonly [key: string]: CanonicalJson }>;
  }>,
  privateKey: KeyObject,
  publicKey: KeyObject,
): SignedAuthorityArtifactV1 {
  let signed: SignedAuthorityArtifactV1;
  try {
    signed = buildSignedAuthorityArtifactV1({
      tenant_id: args.tenant_id,
      artifact_id: draft.artifact_id,
      artifact_revision: draft.artifact_revision,
      artifact_kind: args.artifact_kind,
      artifact_schema: args.artifact_schema,
      authority_subject_sha256: args.authority_subject_sha256,
      payload: args.payload,
      valid_from: draft.valid_from,
      expires_at: draft.expires_at,
      created_at: draft.created_at,
    }, privateKey);
  } catch {
    fail("signing_failed");
  }
  try {
    const verified = verifySignedAuthorityArtifactV1(signed, publicKey);
    if (canonicalContinuationJson(verified) !== canonicalContinuationJson(signed)) {
      fail("signature_self_check_failed");
    }
  } catch (error) {
    if (error instanceof AuthorityAuthoringError) throw error;
    fail("signature_self_check_failed");
  }
  return signed;
}

function commandCommon(request: ParsedCommon) {
  return {
    schema_version: "offline_provisioning_command_v1" as const,
    tenant_id: request.tenant_id,
    scope: request.scope,
    task_family: request.task_family,
    operation_id: request.operation_id,
    actor_kind: "operator" as const,
    actor_principal_sha256: request.actor_principal_sha256,
    authority_subject_sha256: request.authority_subject_sha256,
  };
}

/**
 * Authors a deterministic seedless provisioning command from one exact V1
 * request. No clock, randomness, database, network, or environment is read.
 */
export function authorContinuationRuntimeV1AuthorityCommand(
  value: unknown,
  privateKey: KeyObject,
): SeedlessOfflineAuthorityCommandV1 {
  const request = parseRequest(value);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(privateKey);
  } catch {
    fail("signing_failed");
  }
  if (request.kind === "policy_bundle_install") {
    const compiler = payload(() =>
      verifyContinuationCompilerPolicyV1(request.compiler_policy.payload));
    const evidence = payload(() =>
      verifyEffectEvidencePolicyV1(request.evidence_policy.payload));
    assertPayloadBinding(
      compiler.tenant_id,
      compiler.authority_subject_sha256,
      request,
    );
    assertPayloadBinding(
      evidence.tenant_id,
      evidence.authority_subject_sha256,
      request,
    );
    if (request.compiler_policy.artifact_id === request.evidence_policy.artifact_id
      && request.compiler_policy.artifact_revision
        === request.evidence_policy.artifact_revision) {
      fail("artifact_identity_collision");
    }
    const compilerArtifact = signArtifact(request.compiler_policy, {
      tenant_id: request.tenant_id,
      authority_subject_sha256: request.authority_subject_sha256,
      artifact_kind: "compiler_policy",
      artifact_schema: CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
      payload: compiler,
    }, privateKey, publicKey);
    const evidenceArtifact = signArtifact(request.evidence_policy, {
      tenant_id: request.tenant_id,
      authority_subject_sha256: request.authority_subject_sha256,
      artifact_kind: "evidence_policy",
      artifact_schema: "effect_evidence_policy_v1",
      payload: evidence,
    }, privateKey, publicKey);
    return canonicalContinuationClone({
      ...commandCommon(request),
      kind: "policy_bundle_install" as const,
      policy_bundle: {
        schema_version: "authority_policy_provisioning_bundle_v1" as const,
        tenant_id: request.tenant_id,
        authority_subject_sha256: request.authority_subject_sha256,
        compiler_policy: compilerArtifact,
        evidence_policy: evidenceArtifact,
      },
    }) as SeedlessOfflineAuthorityCommandV1;
  }
  if (request.kind === "experiment_cohort_install") {
    const cohort = payload(() =>
      verifyExperimentCohortV1(request.experiment_cohort.payload));
    if (cohort.tenant_id !== request.tenant_id
      || cohort.scope !== request.scope
      || cohort.task_family !== request.task_family
      || cohort.authority_subject_sha256 !== request.authority_subject_sha256) {
      fail("payload_binding_invalid");
    }
    payload(() => assertExperimentCohortArtifactWindowV1(
      cohort,
      request.experiment_cohort.valid_from,
      request.experiment_cohort.expires_at,
    ));
    if (cohort.assignment_window_opened_at <= request.experiment_cohort.created_at) {
      fail("payload_invalid");
    }
    const artifact = signArtifact(request.experiment_cohort, {
      tenant_id: request.tenant_id,
      authority_subject_sha256: request.authority_subject_sha256,
      artifact_kind: "experiment_cohort",
      artifact_schema: EXPERIMENT_COHORT_SCHEMA_V1,
      payload: cohort,
    }, privateKey, publicKey);
    return canonicalContinuationClone({
      ...commandCommon(request),
      kind: "experiment_cohort_install" as const,
      experiment_cohort_artifact: artifact,
    }) as SeedlessOfflineAuthorityCommandV1;
  }
  const rotationPayload = payload(() =>
    verifyPolicyRotationPayloadV1(request.policy_rotation.payload));
  assertPayloadBinding(
    rotationPayload.tenant_id,
    rotationPayload.authority_subject_sha256,
    request,
  );
  const artifact = signArtifact(request.policy_rotation, {
    tenant_id: request.tenant_id,
    authority_subject_sha256: request.authority_subject_sha256,
    artifact_kind: "policy_rotation",
    artifact_schema: POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
    payload: rotationPayload,
  }, privateKey, publicKey);
  payload(() => verifyPolicyRotationAuthorityArtifactV1(artifact));
  return canonicalContinuationClone({
    ...commandCommon(request),
    kind: "policy_rotation_install" as const,
    policy_rotation_artifact: artifact,
  }) as SeedlessOfflineAuthorityCommandV1;
}
