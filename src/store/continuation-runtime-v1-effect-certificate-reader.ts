import {
  canonicalContinuationClone,
  type Sha256,
} from "../continuation/contract.js";
import type { SignedEffectCertificateV1 } from
  "../continuation/effect-certificate.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "./continuation-runtime-v1-authority-artifact-reader.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import {
  canonicalText,
  effectStoreFail,
  exactRecord,
  sha256,
  type SqlRow,
} from "./continuation-runtime-v1-effect-certificate-support.js";
import type {
  ContinuationRuntimeV1EffectCertificateReader,
  ReadEffectCertificateResultV1,
  ReadEffectCertificateV1Args,
  VerifiedAdmittedEffectCertificateCapabilityV1,
  VerifiedAdmittedEffectCertificateProjectionV1,
} from "./continuation-runtime-v1-effect-certificate-types.js";
import { hydrateEffectCertificateRowV1 } from
  "./continuation-runtime-v1-effect-certificate-verification.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "./continuation-runtime-v1-policy-authority.js";

export type {
  ContinuationRuntimeV1EffectCertificateReader,
  PersistedEffectCertificateV1,
  ReadEffectCertificateResultV1,
  ReadEffectCertificateV1Args,
  VerifiedAdmittedEffectCertificateCapabilityV1,
  VerifiedAdmittedEffectCertificateProjectionV1,
} from "./continuation-runtime-v1-effect-certificate-types.js";

type CapabilityRecord = Readonly<{
  database: ContinuationRuntimeV1Database;
  projection: VerifiedAdmittedEffectCertificateProjectionV1;
}>;

const ADMITTED_CAPABILITIES = new WeakMap<object, CapabilityRecord>();
const EFFECT_CERTIFICATE_READERS = new WeakMap<object, Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
}>>();
const READ_KEYS = Object.freeze(["certificate_sha256", "tenant_id"] as const);

function capabilityProjection(
  certificate: SignedEffectCertificateV1,
): VerifiedAdmittedEffectCertificateProjectionV1 {
  return canonicalContinuationClone({
    schema_version: "verified_admitted_effect_certificate_projection_v1" as const,
    tenant_id: certificate.tenant_id,
    authority_subject_sha256: certificate.authority_subject_sha256,
    certificate_id: certificate.certificate_id,
    certificate_sha256: certificate.certificate_sha256,
    control_branch_ref: certificate.control_branch_ref,
    candidate_branch_ref: certificate.candidate_branch_ref,
    compiler_policy_ref: certificate.compiler_policy_ref,
    evidence_policy_ref: certificate.evidence_policy_ref,
    treatment_delta_set_sha256: certificate.treatment_delta_set_sha256,
  });
}

function issueAdmittedCapability(
  database: ContinuationRuntimeV1Database,
  certificate: SignedEffectCertificateV1,
): VerifiedAdmittedEffectCertificateCapabilityV1 {
  if (certificate.admission_state !== "admitted") {
    effectStoreFail("admitted_capability_requires_admitted_certificate");
  }
  const capability = Object.freeze(Object.create(null)) as object;
  ADMITTED_CAPABILITIES.set(capability, {
    database,
    projection: capabilityProjection(certificate),
  });
  return capability as VerifiedAdmittedEffectCertificateCapabilityV1;
}

function capabilityRecord(
  capability: unknown,
  database: ContinuationRuntimeV1Database,
): CapabilityRecord {
  if (capability === null || typeof capability !== "object") {
    effectStoreFail("admitted_capability_unrecognized");
  }
  const record = ADMITTED_CAPABILITIES.get(capability);
  if (!record) effectStoreFail("admitted_capability_unrecognized");
  if (record.database !== database) {
    effectStoreFail("admitted_capability_database_mismatch");
  }
  const persisted = database.db.prepare(`SELECT certificate_id, admission_state,
    authority_subject_sha256, treatment_delta_set_sha256
    FROM effect_certificates WHERE tenant_id = ? AND certificate_sha256 = ?`).all(
    record.projection.tenant_id,
    record.projection.certificate_sha256,
  ) as SqlRow[];
  if (persisted.length !== 1
    || persisted[0]!.certificate_id !== record.projection.certificate_id
    || persisted[0]!.admission_state !== "admitted"
    || persisted[0]!.authority_subject_sha256
      !== record.projection.authority_subject_sha256
    || persisted[0]!.treatment_delta_set_sha256
      !== record.projection.treatment_delta_set_sha256) {
    effectStoreFail("admitted_capability_persisted_binding_mismatch");
  }
  return record;
}

export function projectVerifiedAdmittedEffectCertificateCapabilityV1(
  capability: VerifiedAdmittedEffectCertificateCapabilityV1,
  database: ContinuationRuntimeV1Database,
): VerifiedAdmittedEffectCertificateProjectionV1 {
  return canonicalContinuationClone(capabilityRecord(capability, database).projection);
}

export function assertVerifiedAdmittedEffectCertificateCapabilityV1(
  capability: unknown,
  database: ContinuationRuntimeV1Database,
  expected: Readonly<{
    tenant_id: string;
    authority_subject_sha256: Sha256;
    certificate_sha256: Sha256;
  }>,
): asserts capability is VerifiedAdmittedEffectCertificateCapabilityV1 {
  const parsed = exactRecord(expected, [
    "authority_subject_sha256", "certificate_sha256", "tenant_id",
  ], "admitted_capability_expected");
  const record = capabilityRecord(capability, database).projection;
  if (record.tenant_id !== canonicalText(parsed.tenant_id, "expected_tenant_id")
    || record.authority_subject_sha256
      !== sha256(parsed.authority_subject_sha256, "expected_authority_subject_sha256")
    || record.certificate_sha256
      !== sha256(parsed.certificate_sha256, "expected_certificate_sha256")) {
    effectStoreFail("admitted_capability_binding_mismatch");
  }
}

export function assertContinuationRuntimeV1EffectCertificateReader(
  value: unknown,
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): asserts value is ContinuationRuntimeV1EffectCertificateReader {
  if (value === null || typeof value !== "object") {
    effectStoreFail("reader_unrecognized");
  }
  const record = EFFECT_CERTIFICATE_READERS.get(value);
  if (!record || record.database !== database
    || record.artifactStore !== artifactStore
    || record.policyAuthority !== policyAuthority) {
    effectStoreFail("reader_binding_mismatch");
  }
}

export function createContinuationRuntimeV1EffectCertificateReader(
  database: ContinuationRuntimeV1Database,
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader,
  policyAuthority: ContinuationRuntimeV1PolicyAuthority,
): ContinuationRuntimeV1EffectCertificateReader {
  assertContinuationRuntimeV1AuthorityArtifactReader(artifactStore, database);
  assertContinuationRuntimeV1PolicyAuthority(policyAuthority, database, artifactStore);

  const reader: ContinuationRuntimeV1EffectCertificateReader = Object.freeze({
    async read(value: ReadEffectCertificateV1Args):
    Promise<ReadEffectCertificateResultV1 | null> {
      const args = exactRecord(value, READ_KEYS, "read_args");
      const tenantId = canonicalText(args.tenant_id, "read_tenant_id");
      const digest = sha256(args.certificate_sha256, "read_certificate_sha256");
      return database.withTx(async () => {
        const row = database.db.prepare(
          "SELECT * FROM effect_certificates WHERE tenant_id = ? AND certificate_sha256 = ?",
        ).get(tenantId, digest) as SqlRow | undefined;
        if (!row) return null;
        const record = await hydrateEffectCertificateRowV1(
          database,
          artifactStore,
          policyAuthority,
          row,
        );
        return Object.freeze({
          record,
          admitted_capability: record.signed_certificate.admission_state === "admitted"
            ? issueAdmittedCapability(database, record.signed_certificate)
            : null,
        });
      });
    },
  });
  EFFECT_CERTIFICATE_READERS.set(reader, { database, artifactStore, policyAuthority });
  return reader;
}
