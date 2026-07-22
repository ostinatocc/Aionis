import {
  createHash,
  createPublicKey,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject,
} from "node:crypto";

import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type AuthorityArtifactRefV1,
  type CanonicalJson,
  type Sha256,
} from "./contract.js";
import { sha256Hex } from "../util/crypto.js";

const AUTHORITY_ARTIFACT_KEYS = [
  "tenant_id",
  "artifact_id",
  "artifact_revision",
  "artifact_kind",
  "artifact_schema",
  "authority_subject_sha256",
  "payload",
  "payload_sha256",
  "artifact_sha256",
  "signer_principal_sha256",
  "trust_root_sha256",
  "signature_algorithm",
  "valid_from",
  "expires_at",
  "created_at",
] as const;

const SIGNED_AUTHORITY_ARTIFACT_KEYS = [...AUTHORITY_ARTIFACT_KEYS, "signature"] as const;

const AUTHORITY_ARTIFACT_BUILD_KEYS = [
  "tenant_id",
  "artifact_id",
  "artifact_revision",
  "artifact_kind",
  "artifact_schema",
  "authority_subject_sha256",
  "payload",
  "valid_from",
  "expires_at",
  "created_at",
] as const;

const AUTHORITY_ARTIFACT_MAX_JSON_BYTES = 262_144;
const CANONICAL_ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type AuthorityArtifactKindV1 =
  | "compiler_policy"
  | "evidence_policy"
  | "experiment_cohort"
  | "policy_rotation";

export type AuthorityArtifactPayloadV1 = Readonly<{
  readonly [key: string]: CanonicalJson;
}>;

export type AuthorityArtifactBuildInputV1 = Readonly<{
  tenant_id: string;
  artifact_id: string;
  artifact_revision: number;
  artifact_kind: AuthorityArtifactKindV1;
  artifact_schema: string;
  authority_subject_sha256: Sha256 | null;
  payload: AuthorityArtifactPayloadV1;
  valid_from: string;
  expires_at: string | null;
  created_at: string;
}>;

export type AuthorityArtifactEnvelopeV1 = AuthorityArtifactBuildInputV1
  & AuthorityArtifactRefV1 & Readonly<{
    signer_principal_sha256: Sha256;
    trust_root_sha256: Sha256;
    signature_algorithm: "ed25519";
  }>;

type AuthorityArtifactIdentityBodyV1 = AuthorityArtifactBuildInputV1 & Readonly<{
  payload_sha256: Sha256;
  signer_principal_sha256: Sha256;
  trust_root_sha256: Sha256;
  signature_algorithm: "ed25519";
}>;

export type SignedAuthorityArtifactV1 = AuthorityArtifactEnvelopeV1 & Readonly<{
  signature: string;
}>;

export type AuthorityArtifactErrorCode =
  | "invalid_authority_artifact"
  | "invalid_ed25519_key"
  | "payload_digest_mismatch"
  | "artifact_digest_mismatch"
  | "trust_root_mismatch"
  | "signature_invalid";

export class AuthorityArtifactError extends Error {
  readonly code: AuthorityArtifactErrorCode;

  constructor(code: AuthorityArtifactErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "AuthorityArtifactError";
    this.code = code;
  }
}

function fail(code: AuthorityArtifactErrorCode, message: string): never {
  throw new AuthorityArtifactError(code, message);
}

function wrapInvalid<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AuthorityArtifactError) throw error;
    throw new AuthorityArtifactError(
      "invalid_authority_artifact",
      error instanceof Error ? error.message : "authority artifact validation failed",
      { cause: error },
    );
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_authority_artifact", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_authority_artifact", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("invalid_authority_artifact", `${label} must contain only string keys`);
  }
  const actualKeys = keys as string[];
  const expected = new Set(expectedKeys);
  const unknown = actualKeys.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  if (unknown.length > 0 || missing.length > 0 || actualKeys.length !== expectedKeys.length) {
    fail(
      "invalid_authority_artifact",
      `${label} keys are not exact (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"})`,
    );
  }
  const detached = Object.create(null) as Record<string, unknown>;
  for (const key of actualKeys) {
    assertUnicodeScalarString(key, `${label} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("invalid_authority_artifact", `${label} must contain only enumerable data properties`);
    }
    detached[key] = descriptor.value;
  }
  return detached;
}

function boundedText(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("invalid_authority_artifact", `${field} must be non-empty canonical text without surrounding whitespace`);
  }
  assertUnicodeScalarString(value, field);
  if (/[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail("invalid_authority_artifact", `${field} must contain 1-${maxBytes} UTF-8 bytes and no C0 or DEL controls`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_authority_artifact", `${field} must be a positive safe integer`);
  }
  return value as number;
}

function artifactKind(value: unknown): AuthorityArtifactKindV1 {
  if (value !== "compiler_policy" && value !== "evidence_policy"
    && value !== "experiment_cohort" && value !== "policy_rotation") {
    fail("invalid_authority_artifact", "artifact_kind is not a closed V1 authority artifact kind");
  }
  return value;
}

function optionalSha256(value: unknown, field: string): Sha256 | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("invalid_authority_artifact", `${field} must be a SHA-256 digest or null`);
  assertSha256(value, field);
  return value;
}

function requiredSha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail("invalid_authority_artifact", `${field} must be a SHA-256 digest`);
  assertSha256(value, field);
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid_authority_artifact", `${field} must be a timestamp`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function validateValidity(createdAt: string, validFrom: string, expiresAt: string | null): void {
  if (Date.parse(createdAt) > Date.parse(validFrom)) {
    fail("invalid_authority_artifact", "created_at must not follow valid_from");
  }
  if (expiresAt !== null && Date.parse(validFrom) >= Date.parse(expiresAt)) {
    fail("invalid_authority_artifact", "valid_from must precede expires_at");
  }
}

function assertControlFreePayload(value: CanonicalJson): void {
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      fail("invalid_authority_artifact", "payload keys and string values must not contain C0 or DEL controls");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const child of value) assertControlFreePayload(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/[\u0000-\u001f\u007f]/u.test(key)) {
      fail("invalid_authority_artifact", "payload keys and string values must not contain C0 or DEL controls");
    }
    assertControlFreePayload(child);
  }
}

function artifactPayload(value: unknown): AuthorityArtifactPayloadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_authority_artifact", "payload must be a canonical JSON object");
  }
  const json = canonicalContinuationJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes < 2 || bytes > AUTHORITY_ARTIFACT_MAX_JSON_BYTES) {
    fail(
      "invalid_authority_artifact",
      `payload must contain 2-${AUTHORITY_ARTIFACT_MAX_JSON_BYTES} canonical UTF-8 bytes`,
    );
  }
  const payload = canonicalContinuationClone(value) as AuthorityArtifactPayloadV1;
  assertControlFreePayload(payload);
  return payload;
}

function parseBuildFields(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): AuthorityArtifactBuildInputV1 {
  const record = exactRecord(value, expectedKeys, label);
  const createdAt = canonicalTimestamp(record.created_at, "created_at");
  const validFrom = canonicalTimestamp(record.valid_from, "valid_from");
  const expiresAt = record.expires_at === null
    ? null
    : canonicalTimestamp(record.expires_at, "expires_at");
  validateValidity(createdAt, validFrom, expiresAt);
  const kind = artifactKind(record.artifact_kind);
  const authoritySubjectSha256 = optionalSha256(
    record.authority_subject_sha256,
    "authority_subject_sha256",
  );
  if (kind === "experiment_cohort" && authoritySubjectSha256 === null) {
    fail("invalid_authority_artifact", "experiment cohort artifacts must bind authority_subject_sha256");
  }
  return {
    tenant_id: boundedText(record.tenant_id, "tenant_id"),
    artifact_id: boundedText(record.artifact_id, "artifact_id"),
    artifact_revision: positiveSafeInteger(record.artifact_revision, "artifact_revision"),
    artifact_kind: kind,
    artifact_schema: boundedText(record.artifact_schema, "artifact_schema"),
    authority_subject_sha256: authoritySubjectSha256,
    payload: artifactPayload(record.payload),
    valid_from: validFrom,
    expires_at: expiresAt,
    created_at: createdAt,
  };
}

function parseEnvelope(value: unknown): AuthorityArtifactEnvelopeV1 {
  const record = exactRecord(value, AUTHORITY_ARTIFACT_KEYS, "authority artifact envelope");
  const base = parseBuildFields(
    Object.fromEntries(AUTHORITY_ARTIFACT_BUILD_KEYS.map((key) => [key, record[key]])),
    AUTHORITY_ARTIFACT_BUILD_KEYS,
    "authority artifact envelope body",
  );
  if (record.signature_algorithm !== "ed25519") {
    fail("invalid_authority_artifact", "signature_algorithm must be ed25519");
  }
  return {
    ...base,
    payload_sha256: requiredSha256(record.payload_sha256, "payload_sha256"),
    artifact_sha256: requiredSha256(record.artifact_sha256, "artifact_sha256"),
    signer_principal_sha256: requiredSha256(record.signer_principal_sha256, "signer_principal_sha256"),
    trust_root_sha256: requiredSha256(record.trust_root_sha256, "trust_root_sha256"),
    signature_algorithm: "ed25519",
  };
}

function parseCanonicalSignature(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ED25519_SIGNATURE.test(value)) {
    fail("invalid_authority_artifact", "signature must be canonical unpadded base64url text for 64 bytes");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) {
    fail("invalid_authority_artifact", "signature must decode canonically to exactly 64 bytes");
  }
  return value;
}

function requirePrivateEd25519Key(key: KeyObject): KeyObject {
  if (!(key instanceof Object) || key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_ed25519_key", "signing key must be an Ed25519 private KeyObject");
  }
  return key;
}

function requirePublicEd25519Key(key: KeyObject): KeyObject {
  if (!(key instanceof Object) || key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("invalid_ed25519_key", "pinned trust root must be an Ed25519 public KeyObject");
  }
  return key;
}

export function authorityArtifactPublicKeySha256(publicKey: KeyObject): Sha256 {
  return wrapInvalid(() => {
    const key = requirePublicEd25519Key(publicKey);
    const spkiDer = key.export({ format: "der", type: "spki" });
    return createHash("sha256").update(spkiDer).digest("hex");
  });
}

function payloadDigest(value: AuthorityArtifactPayloadV1): Sha256 {
  return sha256Hex(canonicalContinuationJson(value));
}

/**
 * This projection is intentionally explicit. Adding a signed authority field
 * must be a conscious digest-contract change; it must never be silently
 * omitted by a generic object-rest or multi-field omission helper.
 */
function artifactIdentityBody(
  value: AuthorityArtifactIdentityBodyV1,
): AuthorityArtifactIdentityBodyV1 {
  return {
    tenant_id: value.tenant_id,
    artifact_id: value.artifact_id,
    artifact_revision: value.artifact_revision,
    artifact_kind: value.artifact_kind,
    artifact_schema: value.artifact_schema,
    authority_subject_sha256: value.authority_subject_sha256,
    payload: value.payload,
    payload_sha256: value.payload_sha256,
    signer_principal_sha256: value.signer_principal_sha256,
    trust_root_sha256: value.trust_root_sha256,
    signature_algorithm: value.signature_algorithm,
    valid_from: value.valid_from,
    expires_at: value.expires_at,
    created_at: value.created_at,
  };
}

function artifactDigest(value: AuthorityArtifactIdentityBodyV1): Sha256 {
  return sha256Hex(canonicalContinuationJson(artifactIdentityBody(value)));
}

function signingBytes(envelope: AuthorityArtifactEnvelopeV1): Buffer {
  return Buffer.from(canonicalContinuationJson(envelope), "utf8");
}

export function buildSignedAuthorityArtifactV1(
  value: unknown,
  privateKey: KeyObject,
): SignedAuthorityArtifactV1 {
  return wrapInvalid(() => {
    const signingKey = requirePrivateEd25519Key(privateKey);
    const input = parseBuildFields(value, AUTHORITY_ARTIFACT_BUILD_KEYS, "authority artifact build input");
    const publicKey = createPublicKey(signingKey);
    const trustRootSha256 = authorityArtifactPublicKeySha256(publicKey);
    const identity: AuthorityArtifactIdentityBodyV1 = {
      ...input,
      payload_sha256: payloadDigest(input.payload),
      signer_principal_sha256: trustRootSha256,
      trust_root_sha256: trustRootSha256,
      signature_algorithm: "ed25519",
    };
    const envelope: AuthorityArtifactEnvelopeV1 = {
      ...identity,
      artifact_sha256: artifactDigest(identity),
    };
    const signature = signDetached(null, signingBytes(envelope), signingKey).toString("base64url");
    parseCanonicalSignature(signature);
    return canonicalContinuationClone({ ...envelope, signature });
  });
}

export function verifySignedAuthorityArtifactV1(
  value: unknown,
  pinnedPublicKey: KeyObject,
): SignedAuthorityArtifactV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, SIGNED_AUTHORITY_ARTIFACT_KEYS, "signed authority artifact");
    const envelope = parseEnvelope(
      Object.fromEntries(AUTHORITY_ARTIFACT_KEYS.map((key) => [key, record[key]])),
    );
    const signature = parseCanonicalSignature(record.signature);
    const expectedPayloadSha256 = payloadDigest(envelope.payload);
    if (envelope.payload_sha256 !== expectedPayloadSha256) {
      fail("payload_digest_mismatch", "payload_sha256 does not authenticate payload");
    }
    const expectedArtifactSha256 = artifactDigest(envelope);
    if (envelope.artifact_sha256 !== expectedArtifactSha256) {
      fail("artifact_digest_mismatch", "artifact_sha256 does not authenticate the full unsigned artifact identity");
    }
    const trustRoot = requirePublicEd25519Key(pinnedPublicKey);
    const pinnedTrustRootSha256 = authorityArtifactPublicKeySha256(trustRoot);
    if (envelope.trust_root_sha256 !== pinnedTrustRootSha256
      || envelope.signer_principal_sha256 !== pinnedTrustRootSha256
      || envelope.signer_principal_sha256 !== envelope.trust_root_sha256) {
      fail("trust_root_mismatch", "V1 signer and trust root must equal the pinned Ed25519 public-key identity");
    }
    const valid = verifyDetached(
      null,
      signingBytes(envelope),
      trustRoot,
      Buffer.from(signature, "base64url"),
    );
    if (!valid) fail("signature_invalid", "authority artifact Ed25519 signature verification failed");
    return canonicalContinuationClone({ ...envelope, signature });
  });
}
