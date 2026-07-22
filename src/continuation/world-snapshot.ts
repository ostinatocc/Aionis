import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type HostObservationV1,
  type Sha256,
} from "./contract.js";
import {
  verifyHostTaskEnvelopeV1,
  type HostTaskEnvelopeV1,
} from "./task-envelope.js";
import { verifyHostObservationAttestationV1 } from "./observation-attestation.js";

export type WorldObservationSnapshotInputV1 = Readonly<{
  tenant_id: string;
  scope: string;
  authority_subject_sha256: Sha256;
  world_snapshot_id: string;
  host_task_envelope: HostTaskEnvelopeV1;
  collection_principal_sha256: Sha256;
  observations: readonly HostObservationV1[];
  created_at: string;
}>;

export type WorldObservationSnapshotV1 = WorldObservationSnapshotInputV1 & Readonly<{
  schema_version: "world_observation_snapshot_v1";
  observed_from: string;
  observed_through: string;
  expires_at: string;
  world_snapshot_sha256: Sha256;
}>;

const INPUT_KEYS = Object.freeze([
  "authority_subject_sha256",
  "collection_principal_sha256",
  "created_at",
  "host_task_envelope",
  "observations",
  "scope",
  "tenant_id",
  "world_snapshot_id",
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  ...INPUT_KEYS,
  "expires_at",
  "observed_from",
  "observed_through",
  "schema_version",
  "world_snapshot_sha256",
].sort(compareCanonicalUtf8));
const MAX_OBSERVATIONS = 2_048;
const MAX_OBSERVATIONS_JSON_BYTES = 262_144;

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`world_observation_snapshot_${field}_must_be_plain_object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`world_observation_snapshot_${field}_must_be_plain_object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`world_observation_snapshot_${field}_shape_invalid`);
  }
  const actual = [...keys as string[]].sort(compareCanonicalUtf8);
  const expected = [...expectedKeys].sort(compareCanonicalUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`world_observation_snapshot_${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`world_observation_snapshot_${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`world_observation_snapshot_${field}_invalid`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`world_observation_snapshot_${field}_invalid`);
  }
  return value;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") throw new Error(`world_observation_snapshot_${field}_invalid`);
  assertSha256(value, field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`world_observation_snapshot_${field}_invalid`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function parseObservations(
  value: unknown,
  worldSnapshotId: string,
  hostTaskEnvelopeSha256: Sha256,
  hostTaskIssuedAt: string,
  hostTaskExpiresAt: string,
  collectionPrincipalSha256: Sha256,
  createdAt: string,
): readonly HostObservationV1[] {
  if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS) {
    throw new Error("world_observation_snapshot_observation_count_invalid");
  }
  const parsed = value.map((observation) => {
    const verified = verifyHostObservationAttestationV1(observation);
    if (verified.world_snapshot_id !== worldSnapshotId
      || verified.host_task_envelope_sha256 !== hostTaskEnvelopeSha256) {
      throw new Error(`world_observation_snapshot_observation_binding_invalid:${verified.observation_id}`);
    }
    if (verified.observer === "trusted_host_collector"
      && verified.observer_principal_sha256 !== collectionPrincipalSha256) {
      throw new Error(
        `world_observation_snapshot_collector_principal_mismatch:${verified.observation_id}`,
      );
    }
    if (verified.observed_at < hostTaskIssuedAt
      || verified.observed_at > createdAt
      || verified.expires_at <= createdAt
      || verified.expires_at > hostTaskExpiresAt) {
      throw new Error(`world_observation_snapshot_observation_stale_or_future:${verified.observation_id}`);
    }
    return verified;
  });
  const observations = canonicalUniqueSet(parsed, (item) => item.observation_id);
  if (new Set(observations.map((item) => item.probe_id)).size !== observations.length) {
    throw new Error("world_observation_snapshot_duplicate_probe");
  }
  const json = canonicalContinuationJson(observations);
  if (Buffer.byteLength(json, "utf8") > MAX_OBSERVATIONS_JSON_BYTES) {
    throw new Error("world_observation_snapshot_observations_too_large");
  }
  return observations;
}

function snapshotDigestBody(
  value: Omit<WorldObservationSnapshotV1, "world_snapshot_sha256">,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: value.schema_version,
    tenant_id: value.tenant_id,
    scope: value.scope,
    authority_subject_sha256: value.authority_subject_sha256,
    world_snapshot_id: value.world_snapshot_id,
    host_task_envelope_sha256: value.host_task_envelope.host_task_envelope_sha256,
    collection_principal_sha256: value.collection_principal_sha256,
    observations: value.observations.map((observation) => ({
      observation_id: observation.observation_id,
      observation_sha256: observation.observation_sha256,
    })),
    observed_from: value.observed_from,
    observed_through: value.observed_through,
    expires_at: value.expires_at,
    created_at: value.created_at,
  };
}

export function buildWorldObservationSnapshotV1(
  value: WorldObservationSnapshotInputV1,
): WorldObservationSnapshotV1 {
  const record = exactRecord(value, INPUT_KEYS, "input");
  const tenantId = text(record.tenant_id, "tenant_id");
  const scope = text(record.scope, "scope");
  const authoritySubjectSha256 = sha256(
    record.authority_subject_sha256,
    "authority_subject_sha256",
  );
  const worldSnapshotId = text(record.world_snapshot_id, "world_snapshot_id");
  const hostTaskEnvelope = verifyHostTaskEnvelopeV1(record.host_task_envelope);
  if (hostTaskEnvelope.tenant_id !== tenantId
    || hostTaskEnvelope.scope !== scope
    || hostTaskEnvelope.authority_subject_sha256 !== authoritySubjectSha256) {
    throw new Error("world_observation_snapshot_authenticated_domain_mismatch");
  }
  const hostTaskEnvelopeSha256 = hostTaskEnvelope.host_task_envelope_sha256;
  const collectionPrincipalSha256 = sha256(
    record.collection_principal_sha256,
    "collection_principal_sha256",
  );
  const createdAt = timestamp(record.created_at, "created_at");
  if (createdAt < hostTaskEnvelope.issued_at || createdAt >= hostTaskEnvelope.expires_at) {
    throw new Error("world_observation_snapshot_task_envelope_not_current");
  }
  const observations = parseObservations(
    record.observations,
    worldSnapshotId,
    hostTaskEnvelopeSha256,
    hostTaskEnvelope.issued_at,
    hostTaskEnvelope.expires_at,
    collectionPrincipalSha256,
    createdAt,
  );
  const observationTimes = observations
    .map((observation) => observation.observed_at)
    .sort(compareCanonicalUtf8);
  const observedFrom = observationTimes[0] ?? createdAt;
  const observedThrough = observationTimes.at(-1) ?? createdAt;
  const expiresAt = [
    hostTaskEnvelope.expires_at,
    ...observations.map((observation) => observation.expires_at),
  ].sort(compareCanonicalUtf8)[0]!;
  const body = {
    schema_version: "world_observation_snapshot_v1" as const,
    tenant_id: tenantId,
    scope,
    authority_subject_sha256: authoritySubjectSha256,
    world_snapshot_id: worldSnapshotId,
    host_task_envelope: hostTaskEnvelope,
    collection_principal_sha256: collectionPrincipalSha256,
    observations,
    observed_from: observedFrom,
    observed_through: observedThrough,
    expires_at: expiresAt,
    created_at: createdAt,
  };
  return canonicalContinuationClone({
    ...body,
    world_snapshot_sha256: canonicalContinuationSha256(snapshotDigestBody(body)),
  });
}

export function verifyWorldObservationSnapshotV1(value: unknown): WorldObservationSnapshotV1 {
  const record = exactRecord(value, SNAPSHOT_KEYS, "value");
  if (record.schema_version !== "world_observation_snapshot_v1") {
    throw new Error("world_observation_snapshot_schema_version_invalid");
  }
  const expectedDigest = sha256(record.world_snapshot_sha256, "world_snapshot_sha256");
  const built = buildWorldObservationSnapshotV1({
    tenant_id: record.tenant_id as string,
    scope: record.scope as string,
    authority_subject_sha256: record.authority_subject_sha256 as Sha256,
    world_snapshot_id: record.world_snapshot_id as string,
    host_task_envelope: record.host_task_envelope as HostTaskEnvelopeV1,
    collection_principal_sha256: record.collection_principal_sha256 as Sha256,
    observations: record.observations as readonly HostObservationV1[],
    created_at: record.created_at as string,
  });
  if (built.observed_from !== record.observed_from
    || built.observed_through !== record.observed_through
    || built.expires_at !== record.expires_at
    || built.world_snapshot_sha256 !== expectedDigest) {
    throw new Error("world_observation_snapshot_digest_or_window_mismatch");
  }
  return built;
}
