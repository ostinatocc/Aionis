import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSignedAuthorityArtifactV1,
  type AuthorityArtifactBuildInputV1,
  type SignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import {
  ContinuationRuntimeV1AuthorityArtifactConflictError,
  createContinuationRuntimeV1AuthorityArtifactProvisioner,
  type InstalledAuthorityArtifactV1,
} from "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationKind,
} from "../../src/store/continuation-runtime-v1-operation-store.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const SUBJECT = "a".repeat(64);
const DATABASE_ID = "b".repeat(64);
let operationSequence = 0;

function fixture(): Readonly<{ root: string; path: string }> {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-artifact-store-"));
  return { root, path: join(root, "authority", "runtime.sqlite") };
}

function openDatabase(path: string): ContinuationRuntimeV1Database {
  return openContinuationRuntimeV1Database(path, {
    databaseInstanceId: DATABASE_ID,
    now: () => "2026-07-21T00:00:00.000Z",
  });
}

function input(overrides: Partial<AuthorityArtifactBuildInputV1> = {}): AuthorityArtifactBuildInputV1 {
  const artifactId = overrides.artifact_id ?? "compiler-main";
  const revision = overrides.artifact_revision ?? 1;
  const authoritySubject = overrides.authority_subject_sha256 === undefined
    ? SUBJECT
    : overrides.authority_subject_sha256;
  return {
    tenant_id: "tenant-a",
    artifact_id: artifactId,
    artifact_revision: revision,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: authoritySubject,
    payload: buildContinuationCompilerPolicyV1({
      schema_version: "continuation_compiler_policy_v1",
      tenant_id: "tenant-a",
      authority_subject_sha256: authoritySubject,
      candidate_limit: 128,
      continuity_candidate_limit: 64,
      learning_candidate_limit: 64,
      selected_capsule_limit: 64,
      obligation_limit: 64,
      max_render_budget: 65_536,
      hard_coverage_weight: 1_000_000,
      advisory_coverage_weight: 10_000 + revision,
      authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
      freshness_bonus: [0, 2, 4, 8],
      freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
      trusted_observer_principals: {
        trusted_host_collector: ["1".repeat(64)],
        external_verifier: ["2".repeat(64)],
      },
    }),
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

function signed(
  overrides: Partial<AuthorityArtifactBuildInputV1> = {},
): SignedAuthorityArtifactV1 {
  return buildSignedAuthorityArtifactV1(input(overrides), ROOT_KEYS.privateKey);
}

function evidenceCompanion(
  artifact: SignedAuthorityArtifactV1,
  sequence: number,
): SignedAuthorityArtifactV1 {
  if (artifact.authority_subject_sha256 === null) {
    throw new Error("test policy bundle requires a subject-bound compiler policy");
  }
  return buildSignedAuthorityArtifactV1({
    tenant_id: artifact.tenant_id,
    artifact_id: `evidence-companion-${sequence}`,
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: artifact.authority_subject_sha256,
    payload: buildEffectEvidencePolicyV1({
      schema_version: "effect_evidence_policy_v1",
      tenant_id: artifact.tenant_id,
      authority_subject_sha256: artifact.authority_subject_sha256,
      trusted_effect_verifier_principals: ["2".repeat(64)],
      max_eligible_decisions: 256,
      max_treatment_delta_count: 64,
      min_evidence_window_ms: 1,
      max_evidence_window_ms: 86_400_000,
      min_control_exposures: 1,
      min_candidate_exposures: 1,
      max_missingness_bps: 1_000,
      harm_noninferiority_margin_bps: 0,
      utility_min_lift_bps: 0,
      confidence_bps: 9_500,
      effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
      statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
    }),
    valid_from: artifact.valid_from,
    expires_at: artifact.expires_at,
    created_at: artifact.created_at,
  }, ROOT_KEYS.privateKey);
}

async function persist(
  database: ContinuationRuntimeV1Database,
  artifact: SignedAuthorityArtifactV1,
  options: Readonly<{
    tenantId?: string;
    operationKind?: ContinuationRuntimeV1OperationKind;
    store?: ReturnType<typeof createContinuationRuntimeV1AuthorityArtifactProvisioner>;
  }> = {},
): Promise<InstalledAuthorityArtifactV1> {
  operationSequence += 1;
  const store = options.store ?? createContinuationRuntimeV1AuthorityArtifactProvisioner(
    database,
    ROOT_KEYS.publicKey,
  );
  const operationKind = options.operationKind ?? "authority_decision";
  const actorKind = operationKind === "authority_decision"
    ? "operator"
    : operationKind === "worker_completion" ? "worker" : "trusted_host";
  let persisted: InstalledAuthorityArtifactV1 | null = null;
  const companion = evidenceCompanion(artifact, operationSequence);
  await createContinuationRuntimeV1OperationStore(database, {
    now: () => "2026-07-21T00:30:00.000Z",
  }).execute({
    tenantId: options.tenantId ?? artifact.tenant_id,
    scope: "scope-is-not-artifact-authority",
    operationKind,
    operationId: `authority-artifact-operation-${operationSequence}`,
    actorKind,
    actorPrincipalSha256: "e".repeat(64),
    request: {
      artifact_id: artifact.artifact_id,
      artifact_revision: artifact.artifact_revision,
      artifact_sha256: artifact.artifact_sha256,
    },
    produce: async (context) => {
      const bundle = await store.putBundle(context, {
        schema_version: "authority_policy_provisioning_bundle_v1",
        tenant_id: artifact.tenant_id,
        authority_subject_sha256: artifact.authority_subject_sha256!,
        compiler_policy: artifact,
        evidence_policy: companion,
      });
      persisted = bundle.compiler_policy;
      return deriveContinuationRuntimeV1OperationResultV1(
        database,
        assertContinuationRuntimeV1AuthorityWriteContext(context, database),
        "before_receipt_insert",
      );
    },
  });
  return persisted!;
}

test("signed policy bundles persist as 64-byte BLOBs, reject duplicate installs, and survive reopen", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = null;
  try {
    database = openDatabase(current.path);
    let reader = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      ROOT_KEYS.publicKey,
    );
    let provisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
      database,
      ROOT_KEYS.publicKey,
    );
    assert.equal("resolveValidPolicy" in reader, false);
    assert.equal("put" in reader, false);
    const artifact = signed();
    assert.equal(Object.hasOwn(artifact, "installation"), false);
    assert.equal(Object.hasOwn(artifact, "source_operation_scope"), false);
    const first = await persist(database, artifact, { store: provisioner });
    await assert.rejects(persist(database, artifact, { store: provisioner }),
      ContinuationRuntimeV1AuthorityArtifactConflictError);
    assert.deepEqual(first.signed_artifact, artifact);
    assert.notEqual(first.signed_artifact, artifact);
    assert.deepEqual(first.installation, { ...database.db.prepare(`SELECT
      tenant_id, scope, operation_kind, operation_id, request_sha256,
      actor_kind, actor_principal_sha256
      FROM operations WHERE tenant_id = ? AND scope = ? AND operation_kind = ?
        AND operation_id = ?`).get(
      first.installation.tenant_id,
      first.installation.scope,
      first.installation.operation_kind,
      first.installation.operation_id,
    ) });
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.signed_artifact), true);
    assert.equal(Object.isFrozen(first.signed_artifact.payload), true);
    assert.equal(Object.isFrozen(first.installation), true);
    const row = database.db.prepare(
      "SELECT signature, length(signature) AS signature_length FROM authority_artifacts",
    ).get() as { signature: unknown; signature_length: number };
    assert.ok(row.signature instanceof Uint8Array);
    assert.equal(row.signature_length, 64);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM authority_artifacts")
      .get() as { count: number }).count, 2);
    assert.deepEqual((await reader.read({
      tenant_id: "tenant-a", artifact_id: "compiler-main", artifact_revision: 1,
    }))?.signed_artifact, artifact);
    assert.deepEqual((await reader.readByDigest({
      tenant_id: "tenant-a", artifact_sha256: artifact.artifact_sha256,
    }))?.signed_artifact, artifact);
    assert.equal(await reader.read({
      tenant_id: "tenant-other", artifact_id: "compiler-main", artifact_revision: 1,
    }), null);

    await database.close();
    database = null;
    const reopened = openContinuationRuntimeV1Database(current.path);
    database = reopened;
    reader = createContinuationRuntimeV1AuthorityArtifactReader(reopened, ROOT_KEYS.publicKey);
    const read = await reader.read({
      tenant_id: "tenant-a", artifact_id: "compiler-main", artifact_revision: 1,
    });
    assert.deepEqual(read?.signed_artifact, artifact);
    assert.equal(Object.isFrozen(read), true);
    assert.equal(Object.isFrozen(read!.signed_artifact.payload), true);
    assert.equal(Object.isFrozen(read!.installation), true);
  } finally {
    await database?.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("identity conflicts are explicit while renewals preserve exact subject binding", async () => {
  const current = fixture();
  const database = openDatabase(current.path);
  try {
    const originalInput = input();
    const original = buildSignedAuthorityArtifactV1(originalInput, ROOT_KEYS.privateKey);
    await persist(database, original);
    const identityConflict = signed({
      payload: {
        ...input().payload,
        advisory_coverage_weight: 999,
      },
    });
    await assert.rejects(
      persist(database, identityConflict),
      (error: unknown) => error instanceof ContinuationRuntimeV1AuthorityArtifactConflictError
        && error.code === "identity_conflict",
    );
    const renamed = buildSignedAuthorityArtifactV1({
      ...originalInput,
      artifact_id: "same-payload-other-identity",
    }, ROOT_KEYS.privateKey);
    const renewed = buildSignedAuthorityArtifactV1({
      ...originalInput,
      artifact_revision: 2,
      valid_from: "2026-07-22T01:00:00.000Z",
    }, ROOT_KEYS.privateKey);
    const rebound = buildSignedAuthorityArtifactV1({
      ...originalInput,
      artifact_id: "same-payload-other-subject",
      authority_subject_sha256: "d".repeat(64),
    }, ROOT_KEYS.privateKey);
    for (const variant of [renamed, renewed]) {
      assert.equal(variant.payload_sha256, original.payload_sha256);
      assert.notEqual(variant.artifact_sha256, original.artifact_sha256);
      assert.deepEqual((await persist(database, variant)).signed_artifact, variant);
    }
    await assert.rejects(persist(database, rebound), /compiler_binding_invalid/u);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM authority_artifacts")
      .get() as { count: number }).count, 6);
  } finally {
    await database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("opaque authority context is tenant-, database-, transaction-, kind-, and single-use bound", async () => {
  const current = fixture();
  const other = fixture();
  const database = openDatabase(current.path);
  const otherDatabase = openContinuationRuntimeV1Database(other.path, {
    databaseInstanceId: "c".repeat(64),
    now: () => "2026-07-21T00:00:00.000Z",
  });
  try {
    const store = createContinuationRuntimeV1AuthorityArtifactProvisioner(
      database,
      ROOT_KEYS.publicKey,
    );
    const otherStore = createContinuationRuntimeV1AuthorityArtifactProvisioner(
      otherDatabase,
      ROOT_KEYS.publicKey,
    );
    const artifact = signed();
    await assert.rejects(
      store.put({} as ContinuationRuntimeV1AuthorityWriteContext, artifact),
      /write_context_unrecognized/u,
    );
    await assert.rejects(
      persist(database, artifact, { operationKind: "worker_completion", store }),
      /operation_kind_forbidden/u,
    );
    await assert.rejects(
      persist(database, artifact, { operationKind: "record_outcome", store }),
      /operation_kind_forbidden/u,
    );
    await assert.rejects(
      persist(database, artifact, { tenantId: "tenant-other", store }),
      /tenant_mismatch/u,
    );

    let expired: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    await assert.rejects(createContinuationRuntimeV1OperationStore(database, {
      now: () => "2026-07-21T00:30:00.000Z",
    }).execute({
      tenantId: "tenant-a", scope: "scope", operationKind: "authority_decision",
      operationId: "capture-expired-artifact-context", request: { capture: true },
      actorKind: "operator", actorPrincipalSha256: "e".repeat(64),
      produce: (context) => {
        expired = context;
        throw new Error("capture expired context");
      },
    }), /capture expired context/u);
    await assert.rejects(store.put(expired!, artifact), /write_context_expired/u);

    await assert.rejects(
      createContinuationRuntimeV1OperationStore(database).execute({
        tenantId: "tenant-a", scope: "scope", operationKind: "authority_decision",
        operationId: "wrong-database-artifact-context", request: { wrong_database: true },
        actorKind: "operator", actorPrincipalSha256: "e".repeat(64),
        produce: (context) => otherStore.put(context, artifact).then(() => ({ stored: true })),
      }),
      /write_context_database_mismatch/u,
    );

    const second = signed({ artifact_id: "compiler-second" });
    await assert.rejects(
      createContinuationRuntimeV1OperationStore(database).execute({
        tenantId: "tenant-a", scope: "scope", operationKind: "authority_decision",
        operationId: "double-artifact-mutation", request: { count: 2 },
        actorKind: "operator", actorPrincipalSha256: "e".repeat(64),
        produce: async (context) => {
          await store.put(context, artifact);
          await store.put(context, second);
          return { stored: true };
        },
      }),
      /operation_context_already_used/u,
    );
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM authority_artifacts")
      .get() as { count: number }).count, 0, "outer operation rollback must undo first put");
  } finally {
    await otherDatabase.close();
    await database.close();
    rmSync(other.root, { recursive: true, force: true });
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("every read re-verifies the pinned trust root, canonical row, digest, and signature", async () => {
  const current = fixture();
  const database = openDatabase(current.path);
  try {
    const artifact = signed();
    const installed = await persist(database, artifact);
    const wrongRootStore = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      OTHER_KEYS.publicKey,
    );
    await assert.rejects(
      wrongRootStore.read({
        tenant_id: "tenant-a", artifact_id: "compiler-main", artifact_revision: 1,
      }),
      /trust_root_mismatch/u,
    );
    assert.throws(
      () => createContinuationRuntimeV1AuthorityArtifactReader(database, ROOT_KEYS.privateKey),
      /invalid_ed25519_key/u,
    );

    database.db.exec("DROP TRIGGER authority_artifacts_no_update");
    database.db.exec("PRAGMA foreign_keys = OFF");
    database.db.prepare(
      "UPDATE authority_artifacts SET source_request_sha256 = ? WHERE tenant_id = ? AND artifact_id = ?",
    ).run("f".repeat(64), "tenant-a", "compiler-main");
    const store = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      ROOT_KEYS.publicKey,
    );
    await assert.rejects(
      store.read({ tenant_id: "tenant-a", artifact_id: "compiler-main", artifact_revision: 1 }),
      /installation_operation_ref/u,
    );
    database.db.prepare(
      "UPDATE authority_artifacts SET source_request_sha256 = ? WHERE tenant_id = ? AND artifact_id = ?",
    ).run(installed.installation.request_sha256, "tenant-a", "compiler-main");
    database.db.exec("PRAGMA foreign_keys = ON");
    database.db.prepare(
      "UPDATE authority_artifacts SET signature = ? WHERE tenant_id = ? AND artifact_id = ?",
    ).run(Buffer.alloc(64, 7), "tenant-a", "compiler-main");
    await assert.rejects(
      store.read({ tenant_id: "tenant-a", artifact_id: "compiler-main", artifact_revision: 1 }),
      /signature_invalid/u,
    );
    await assert.rejects(
      store.readByDigest({ tenant_id: "tenant-a", artifact_sha256: artifact.artifact_sha256 }),
      /signature_invalid/u,
    );
  } finally {
    await database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("public arguments are exact canonical data and invisible policy controls are rejected", async () => {
  const current = fixture();
  const database = openDatabase(current.path);
  try {
    const reader = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      ROOT_KEYS.publicKey,
    );
    const provisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
      database,
      ROOT_KEYS.publicKey,
    );
    await assert.rejects(reader.read({
      tenant_id: "tenant-a", artifact_id: "missing", artifact_revision: 1, extra: true,
    } as never), /shape_invalid/u);
    await assert.rejects(reader.read({
      tenant_id: "tenant\n", artifact_id: "missing", artifact_revision: 1,
    }), /tenant_id_invalid/u);
    assert.throws(() => signed({
      artifact_id: "invisible-policy",
      artifact_kind: "deployment_policy",
      artifact_schema: "deployment_policy_v1",
      authority_subject_sha256: SUBJECT,
      payload: { rule: "allow\nthen-deny" },
    }), /closed V1 authority artifact kind/u);
    const payloadMismatch = JSON.parse(JSON.stringify(signed({
      artifact_id: "payload-mismatch",
    }))) as any;
    payloadMismatch.payload.policy = "changed";
    await assert.rejects(
      persist(database, payloadMismatch, { store: provisioner }),
      /payload_digest_mismatch/u,
    );
    const artifactMismatch = JSON.parse(JSON.stringify(signed({
      artifact_id: "artifact-mismatch",
    }))) as any;
    artifactMismatch.valid_from = "2026-07-21T01:00:00.001Z";
    await assert.rejects(
      persist(database, artifactMismatch, { store: provisioner }),
      /artifact_digest_mismatch/u,
    );
    const tampered = JSON.parse(JSON.stringify(signed({ artifact_id: "tampered" }))) as any;
    const signature = Buffer.from(tampered.signature, "base64url");
    signature[0] ^= 1;
    tampered.signature = signature.toString("base64url");
    await assert.rejects(
      persist(database, tampered, { store: provisioner }),
      /signature_invalid/u,
    );
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM authority_artifacts")
      .get() as { count: number }).count, 0);
  } finally {
    await database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});
