import {
  CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
  verifyContinuationCompilerPolicyV1,
  type ContinuationCompilerPolicyV1,
} from "../continuation/compiler-policy.js";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "../continuation/contract.js";
import {
  verifyEffectEvidencePolicyV1,
  type EffectEvidencePolicyArtifactBindingV1,
  type EffectEvidencePolicyV1,
} from "../continuation/effect-certificate.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
  type InstalledAuthorityArtifactV1,
} from "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";

export type AuthorityPolicyKindV1 = "compiler_policy" | "evidence_policy";

declare const VERIFIED_COMPILER_POLICY_CAPABILITY: unique symbol;
declare const VERIFIED_EVIDENCE_POLICY_CAPABILITY: unique symbol;

export type VerifiedCompilerPolicyCapabilityV1 = Readonly<{
  [VERIFIED_COMPILER_POLICY_CAPABILITY]: "verified_compiler_policy_capability_v1";
}>;

export type VerifiedEvidencePolicyCapabilityV1 = Readonly<{
  [VERIFIED_EVIDENCE_POLICY_CAPABILITY]: "verified_evidence_policy_capability_v1";
}>;

export type VerifiedAuthorityPolicyCapabilityV1 =
  | VerifiedCompilerPolicyCapabilityV1
  | VerifiedEvidencePolicyCapabilityV1;

type ResolvePolicyBaseV1 = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  at: string;
}>;

export type ResolveExactCompilerPolicyV1Args = ResolvePolicyBaseV1 & Readonly<{
  artifact_kind: "compiler_policy";
  artifact_ref: AuthorityArtifactRefV1;
}>;

export type ResolveExactEvidencePolicyV1Args = ResolvePolicyBaseV1 & Readonly<{
  artifact_kind: "evidence_policy";
  artifact_ref: AuthorityArtifactRefV1;
}>;

export type ResolveExactAuthorityPolicyV1Args =
  | ResolveExactCompilerPolicyV1Args
  | ResolveExactEvidencePolicyV1Args;

export type ResolveCurrentCompilerPolicyV1Args = ResolvePolicyBaseV1 & Readonly<{
  artifact_kind: "compiler_policy";
}>;

export type ResolveCurrentEvidencePolicyV1Args = ResolvePolicyBaseV1 & Readonly<{
  artifact_kind: "evidence_policy";
}>;

export type ResolveCurrentAuthorityPolicyV1Args =
  | ResolveCurrentCompilerPolicyV1Args
  | ResolveCurrentEvidencePolicyV1Args;

export type ContinuationRuntimeV1PolicyAuthority = Readonly<{
  resolveExact(
    args: ResolveExactCompilerPolicyV1Args,
  ): Promise<VerifiedCompilerPolicyCapabilityV1>;
  resolveExact(
    args: ResolveExactEvidencePolicyV1Args,
  ): Promise<VerifiedEvidencePolicyCapabilityV1>;
  resolveCurrent(
    args: ResolveCurrentCompilerPolicyV1Args,
  ): Promise<VerifiedCompilerPolicyCapabilityV1>;
  resolveCurrent(
    args: ResolveCurrentEvidencePolicyV1Args,
  ): Promise<VerifiedEvidencePolicyCapabilityV1>;
  ref(capability: VerifiedAuthorityPolicyCapabilityV1): AuthorityArtifactRefV1;
  payload(capability: VerifiedCompilerPolicyCapabilityV1): ContinuationCompilerPolicyV1;
  payload(capability: VerifiedEvidencePolicyCapabilityV1): EffectEvidencePolicyV1;
  evidenceBinding(
    capability: VerifiedEvidencePolicyCapabilityV1,
  ): EffectEvidencePolicyArtifactBindingV1;
}>;

export class ContinuationRuntimeV1PolicyUnavailableError extends Error {
  constructor(readonly artifactKind: AuthorityPolicyKindV1) {
    super(`continuation_runtime_v1_policy_authority_${artifactKind}_unavailable`);
    this.name = "ContinuationRuntimeV1PolicyUnavailableError";
  }
}

export class ContinuationRuntimeV1PolicyAmbiguityError extends Error {
  readonly artifactIds: readonly string[];

  constructor(artifactIds: readonly string[]) {
    super("continuation_runtime_v1_policy_authority_ambiguous");
    this.name = "ContinuationRuntimeV1PolicyAmbiguityError";
    this.artifactIds = Object.freeze([...artifactIds]);
  }
}

type PolicyPayloadV1 = ContinuationCompilerPolicyV1 | EffectEvidencePolicyV1;
type VerifiedPolicyMaterialV1 = Readonly<{
  artifact: InstalledAuthorityArtifactV1["signed_artifact"];
  ref: AuthorityArtifactRefV1;
  payload: PolicyPayloadV1;
}>;
type PolicyRecordV1 = VerifiedPolicyMaterialV1 & Readonly<{
  owner: ContinuationRuntimeV1PolicyAuthority;
}>;
type ServiceRecordV1 = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
}>;

const EXACT_KEYS = Object.freeze([
  "artifact_kind", "artifact_ref", "at", "authority_subject_sha256", "tenant_id",
] as const);
const CURRENT_KEYS = Object.freeze([
  "artifact_kind", "at", "authority_subject_sha256", "tenant_id",
] as const);
const REF_KEYS = Object.freeze(["artifact_sha256", "payload_sha256"] as const);
const COMPILER_CAPABILITIES = new WeakMap<object, PolicyRecordV1>();
const EVIDENCE_CAPABILITIES = new WeakMap<object, PolicyRecordV1>();
const POLICY_AUTHORITIES = new WeakMap<object, ServiceRecordV1>();

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_policy_authority_${code}`);
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
    || keys.some((key) => !expected.has(key as string))) fail(`${field}_shape_invalid`);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    assertUnicodeScalarString(key, `policy authority ${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `policy authority ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `policy authority ${field}`);
  return value;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `policy authority ${field}`);
  return value;
}

function kind(value: unknown): AuthorityPolicyKindV1 {
  if (value !== "compiler_policy" && value !== "evidence_policy") {
    fail("artifact_kind_invalid");
  }
  return value;
}

function artifactRef(value: unknown): AuthorityArtifactRefV1 {
  const record = exactRecord(value, REF_KEYS, "artifact_ref");
  return {
    artifact_sha256: sha(record.artifact_sha256, "artifact_ref_artifact_sha256"),
    payload_sha256: sha(record.payload_sha256, "artifact_ref_payload_sha256"),
  };
}

function parseBase(
  record: Readonly<Record<string, unknown>>,
): ResolvePolicyBaseV1 & Readonly<{ artifact_kind: AuthorityPolicyKindV1 }> {
  return {
    tenant_id: text(record.tenant_id, "tenant_id"),
    authority_subject_sha256: sha(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    artifact_kind: kind(record.artifact_kind),
    at: time(record.at, "at"),
  };
}

function parseExact(value: unknown): ResolveExactAuthorityPolicyV1Args {
  const record = exactRecord(value, EXACT_KEYS, "resolve_exact_args");
  return { ...parseBase(record), artifact_ref: artifactRef(record.artifact_ref) };
}

function parseCurrent(value: unknown): ResolveCurrentAuthorityPolicyV1Args {
  return parseBase(exactRecord(value, CURRENT_KEYS, "resolve_current_args"));
}

function schemaFor(policyKind: AuthorityPolicyKindV1): string {
  return policyKind === "compiler_policy"
    ? CONTINUATION_COMPILER_POLICY_SCHEMA_V1
    : "effect_evidence_policy_v1";
}

function parsePayload(
  policyKind: AuthorityPolicyKindV1,
  payload: unknown,
): PolicyPayloadV1 {
  return policyKind === "compiler_policy"
    ? verifyContinuationCompilerPolicyV1(payload)
    : verifyEffectEvidencePolicyV1(payload);
}

async function verifyPolicyArtifact(
  record: ServiceRecordV1,
  args: ResolvePolicyBaseV1 & Readonly<{
    artifact_kind: AuthorityPolicyKindV1;
    artifact_ref: AuthorityArtifactRefV1;
  }>,
): Promise<VerifiedPolicyMaterialV1> {
  const installed = await record.artifactStore.readByDigest({
    tenant_id: args.tenant_id,
    artifact_sha256: args.artifact_ref.artifact_sha256,
  });
  if (!installed) fail(`${args.artifact_kind}_ref_missing`);
  const artifact = installed.signed_artifact;
  if (artifact.tenant_id !== args.tenant_id
    || artifact.artifact_kind !== args.artifact_kind
    || artifact.artifact_schema !== schemaFor(args.artifact_kind)
    || artifact.artifact_sha256 !== args.artifact_ref.artifact_sha256
    || artifact.payload_sha256 !== args.artifact_ref.payload_sha256
    || artifact.valid_from > args.at
    || (artifact.expires_at !== null && args.at >= artifact.expires_at)
    || (artifact.authority_subject_sha256 !== null
      && artifact.authority_subject_sha256 !== args.authority_subject_sha256)) {
    fail(`${args.artifact_kind}_artifact_binding_invalid`);
  }
  const payload = parsePayload(args.artifact_kind, artifact.payload);
  if (payload.tenant_id !== artifact.tenant_id
    || payload.authority_subject_sha256 !== artifact.authority_subject_sha256
    || canonicalContinuationSha256(payload) !== artifact.payload_sha256
    || canonicalContinuationJson(payload) !== canonicalContinuationJson(artifact.payload)) {
    fail(`${args.artifact_kind}_payload_binding_invalid`);
  }
  return {
    artifact,
    ref: canonicalContinuationClone(args.artifact_ref),
    payload,
  };
}

function chooseCurrent(
  records: readonly VerifiedPolicyMaterialV1[],
  subject: Sha256,
): VerifiedPolicyMaterialV1 | null {
  const specific = records.filter(
    (record) => record.artifact.authority_subject_sha256 === subject,
  );
  const eligible = specific.length > 0
    ? specific
    : records.filter((record) => record.artifact.authority_subject_sha256 === null);
  if (eligible.length === 0) return null;
  const artifactIds = [...new Set(eligible.map((record) => record.artifact.artifact_id))]
    .sort(compareCanonicalUtf8);
  if (artifactIds.length !== 1) throw new ContinuationRuntimeV1PolicyAmbiguityError(artifactIds);
  return [...eligible].sort((left, right) => {
    if (left.artifact.artifact_revision !== right.artifact.artifact_revision) {
      return right.artifact.artifact_revision - left.artifact.artifact_revision;
    }
    const created = compareCanonicalUtf8(right.artifact.created_at, left.artifact.created_at);
    return created !== 0
      ? created
      : compareCanonicalUtf8(left.artifact.artifact_sha256, right.artifact.artifact_sha256);
  })[0] ?? null;
}

function issue(
  owner: ContinuationRuntimeV1PolicyAuthority,
  record: VerifiedPolicyMaterialV1,
): VerifiedAuthorityPolicyCapabilityV1 {
  const capability = Object.freeze(Object.create(null)) as object;
  const owned = { ...record, owner };
  if (record.artifact.artifact_kind === "compiler_policy") {
    COMPILER_CAPABILITIES.set(capability, owned);
    return capability as VerifiedCompilerPolicyCapabilityV1;
  }
  EVIDENCE_CAPABILITIES.set(capability, owned);
  return capability as VerifiedEvidencePolicyCapabilityV1;
}

function capabilityRecord(
  owner: ContinuationRuntimeV1PolicyAuthority,
  capability: unknown,
): PolicyRecordV1 {
  if (capability === null || typeof capability !== "object") fail("capability_invalid");
  const record = COMPILER_CAPABILITIES.get(capability)
    ?? EVIDENCE_CAPABILITIES.get(capability);
  if (!record || record.owner !== owner) fail("capability_invalid");
  return record;
}

export function assertContinuationRuntimeV1PolicyAuthority(
  value: unknown,
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
): asserts value is ContinuationRuntimeV1PolicyAuthority {
  if (value === null || typeof value !== "object") fail("service_invalid");
  const record = POLICY_AUTHORITIES.get(value);
  if (!record || record.database !== database || record.artifactStore !== artifactStore) {
    fail("service_invalid");
  }
}

export function createContinuationRuntimeV1PolicyAuthority(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
): ContinuationRuntimeV1PolicyAuthority {
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  let service!: ContinuationRuntimeV1PolicyAuthority;
  service = Object.freeze({
    async resolveExact(
      value: ResolveExactAuthorityPolicyV1Args,
    ): Promise<VerifiedAuthorityPolicyCapabilityV1> {
      const args = parseExact(value);
      const record = await verifyPolicyArtifact(
        { database, artifactStore },
        args,
      );
      return issue(service, record);
    },

    async resolveCurrent(
      value: ResolveCurrentAuthorityPolicyV1Args,
    ): Promise<VerifiedAuthorityPolicyCapabilityV1> {
      const args = parseCurrent(value);
      const refs = await database.read(() => database.db.prepare(`SELECT
          artifact_sha256, payload_sha256
        FROM authority_artifacts
        WHERE tenant_id = ? AND artifact_kind = ?
          AND valid_from <= ? AND (expires_at IS NULL OR ? < expires_at)
          AND (authority_subject_sha256 = ? OR authority_subject_sha256 IS NULL)`).all(
        args.tenant_id,
        args.artifact_kind,
        args.at,
        args.at,
        args.authority_subject_sha256,
      ) as Array<{ artifact_sha256: unknown; payload_sha256: unknown }>);
      const records: VerifiedPolicyMaterialV1[] = [];
      for (const row of refs) {
        records.push(await verifyPolicyArtifact(
          { database, artifactStore },
          {
            ...args,
            artifact_ref: {
              artifact_sha256: sha(row.artifact_sha256, "persisted_artifact_sha256"),
              payload_sha256: sha(row.payload_sha256, "persisted_payload_sha256"),
            },
          },
        ));
      }
      const selected = chooseCurrent(records, args.authority_subject_sha256);
      if (!selected) throw new ContinuationRuntimeV1PolicyUnavailableError(args.artifact_kind);
      return issue(service, selected);
    },

    ref(capability: VerifiedAuthorityPolicyCapabilityV1): AuthorityArtifactRefV1 {
      return canonicalContinuationClone(capabilityRecord(service, capability).ref);
    },

    payload(capability: VerifiedAuthorityPolicyCapabilityV1): PolicyPayloadV1 {
      return canonicalContinuationClone(capabilityRecord(service, capability).payload);
    },

    evidenceBinding(
      capability: VerifiedEvidencePolicyCapabilityV1,
    ): EffectEvidencePolicyArtifactBindingV1 {
      const record = capabilityRecord(service, capability);
      if (record.artifact.artifact_kind !== "evidence_policy") {
        fail("evidence_capability_invalid");
      }
      return canonicalContinuationClone({
        artifact_ref: record.ref,
        trust_root_sha256: record.artifact.trust_root_sha256,
        payload: record.payload as EffectEvidencePolicyV1,
      });
    },
  }) as ContinuationRuntimeV1PolicyAuthority;
  POLICY_AUTHORITIES.set(service, { database, artifactStore });
  return service;
}
