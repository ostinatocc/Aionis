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
import type { AuthorityArtifactRefV1, Sha256 } from
  "../../src/continuation/contract.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
} from "../../src/store/continuation-runtime-v1-operation-store.js";
import {
  ContinuationRuntimeV1PolicyAmbiguityError,
  ContinuationRuntimeV1PolicyUnavailableError,
  assertContinuationRuntimeV1PolicyAuthority,
  createContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
  type VerifiedCompilerPolicyCapabilityV1,
} from "../../src/store/continuation-runtime-v1-policy-authority.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-a";
const SUBJECT = "a".repeat(64) as Sha256;
const HOST = "1".repeat(64) as Sha256;
const VERIFIER = "2".repeat(64) as Sha256;
let sequence = 0;

type Fixture = Readonly<{
  root: string;
  clock: { value: string };
  database: ContinuationRuntimeV1Database;
  artifactProvisioner: ReturnType<
    typeof createContinuationRuntimeV1AuthorityArtifactProvisioner
  >;
  artifacts: ReturnType<typeof createContinuationRuntimeV1AuthorityArtifactReader>;
  policies: ContinuationRuntimeV1PolicyAuthority;
}>;

function fixture(): Fixture {
  sequence += 1;
  const root = mkdtempSync(join(tmpdir(), "aionis-policy-authority-"));
  const clock = { value: "2026-07-21T00:00:00.000Z" };
  const database = openContinuationRuntimeV1Database(
    join(root, "authority", "runtime.sqlite"),
    {
      databaseInstanceId: sequence.toString(16).padStart(64, "0"),
      authorityNow: () => clock.value,
    },
  );
  const artifactProvisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
    database,
    ROOT_KEYS.publicKey,
  );
  const artifacts = createContinuationRuntimeV1AuthorityArtifactReader(
    database,
    ROOT_KEYS.publicKey,
  );
  return {
    root,
    clock,
    database,
    artifactProvisioner,
    artifacts,
    policies: createContinuationRuntimeV1PolicyAuthority(database, artifacts),
  };
}

function compilerPayload(subject: Sha256 | null, revision = 1) {
  return buildContinuationCompilerPolicyV1({
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: subject,
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
      trusted_host_collector: [HOST],
      external_verifier: [VERIFIER],
    },
  });
}

function evidencePayload(subject: Sha256 | null) {
  return buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: subject,
    trusted_effect_verifier_principals: [VERIFIER],
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
  });
}

function signedPolicy(args: Readonly<{
  artifactId: string;
  revision?: number;
  kind?: "compiler_policy" | "evidence_policy";
  subject?: Sha256 | null;
  schema?: string;
  payload?: AuthorityArtifactBuildInputV1["payload"];
  validFrom?: string;
  expiresAt?: string | null;
  privateKey?: typeof ROOT_KEYS.privateKey;
}>): SignedAuthorityArtifactV1 {
  const kind = args.kind ?? "compiler_policy";
  const subject = args.subject === undefined ? SUBJECT : args.subject;
  const revision = args.revision ?? 1;
  return buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: args.artifactId,
    artifact_revision: revision,
    artifact_kind: kind,
    artifact_schema: args.schema ?? (kind === "compiler_policy"
      ? "continuation_compiler_policy_v1"
      : "effect_evidence_policy_v1"),
    authority_subject_sha256: subject,
    payload: args.payload ?? (kind === "compiler_policy"
      ? compilerPayload(subject, revision)
      : evidencePayload(subject)),
    valid_from: args.validFrom ?? "2026-07-21T01:00:00.000Z",
    expires_at: args.expiresAt ?? null,
    created_at: "2026-07-21T00:00:00.000Z",
  }, args.privateKey ?? ROOT_KEYS.privateKey);
}

function ref(artifact: SignedAuthorityArtifactV1): AuthorityArtifactRefV1 {
  return {
    artifact_sha256: artifact.artifact_sha256,
    payload_sha256: artifact.payload_sha256,
  };
}

async function persist(current: Fixture, artifact: SignedAuthorityArtifactV1): Promise<void> {
  sequence += 1;
  current.clock.value = "2026-07-21T00:30:00.000Z";
  const bundleSubject = artifact.authority_subject_sha256 ?? SUBJECT;
  const companionKind = artifact.artifact_kind === "compiler_policy"
    ? "evidence_policy" as const
    : "compiler_policy" as const;
  const companion = signedPolicy({
    artifactId: `non-current-${companionKind}-${sequence}`,
    kind: companionKind,
    subject: bundleSubject,
    validFrom: "2099-01-01T00:00:00.000Z",
  });
  await createContinuationRuntimeV1OperationStore(current.database).execute({
    tenantId: TENANT,
    scope: "scope-a",
    operationKind: "authority_decision",
    operationId: `install-policy-${sequence}`,
    actorKind: "operator",
    actorPrincipalSha256: "5".repeat(64),
    request: { artifact_sha256: artifact.artifact_sha256 },
    produce: async (context) => {
      await current.artifactProvisioner.putBundle(context, {
        schema_version: "authority_policy_provisioning_bundle_v1",
        tenant_id: TENANT,
        authority_subject_sha256: bundleSubject,
        compiler_policy: artifact.artifact_kind === "compiler_policy"
          ? artifact
          : companion,
        evidence_policy: artifact.artifact_kind === "evidence_policy"
          ? artifact
          : companion,
      });
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          current.database,
        ),
        "before_receipt_insert",
      );
    },
  });
}

test("typed current/exact resolution issues opaque capabilities and preserves revision precedence", async () => {
  const current = fixture();
  try {
    const specificV1 = signedPolicy({
      artifactId: "compiler-specific",
      revision: 1,
      validFrom: "2026-07-21T02:00:00.000Z",
      expiresAt: "2026-07-21T03:00:00.000Z",
    });
    const specificV2 = signedPolicy({
      artifactId: "compiler-specific",
      revision: 2,
      validFrom: "2026-07-21T02:30:00.000Z",
      expiresAt: "2026-07-21T03:00:00.000Z",
    });
    const evidence = signedPolicy({ artifactId: "evidence-specific", kind: "evidence_policy" });
    for (const artifact of [specificV1, specificV2, evidence]) {
      await persist(current, artifact);
    }

    await assert.rejects(current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T00:59:59.999Z",
    }), ContinuationRuntimeV1PolicyUnavailableError);
    await assert.rejects(current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T01:00:00.000Z",
    }), ContinuationRuntimeV1PolicyUnavailableError);
    const first = await current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T02:00:00.000Z",
    });
    assert.deepEqual(current.policies.ref(first), ref(specificV1));
    const second = await current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T02:30:00.000Z",
    });
    assert.deepEqual(current.policies.ref(second), ref(specificV2));
    await assert.rejects(current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T03:00:00.000Z",
    }), ContinuationRuntimeV1PolicyUnavailableError);

    const exactEvidence = await current.policies.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "evidence_policy",
      artifact_ref: ref(evidence),
      at: "2026-07-21T02:00:00.000Z",
    });
    const binding = current.policies.evidenceBinding(exactEvidence);
    assert.deepEqual(binding.artifact_ref, ref(evidence));
    assert.equal(binding.trust_root_sha256, evidence.trust_root_sha256);
    assert.deepEqual(binding.payload, evidencePayload(SUBJECT));
    assert.equal(Object.isFrozen(binding), true);
    assert.equal(Object.isFrozen(current.policies.payload(second)), true);

    assert.throws(
      () => current.policies.ref({} as VerifiedCompilerPolicyCapabilityV1),
      /capability_invalid/u,
    );
    assert.throws(
      () => current.policies.ref({ ...second } as VerifiedCompilerPolicyCapabilityV1),
      /capability_invalid/u,
    );
    const sibling = createContinuationRuntimeV1PolicyAuthority(
      current.database,
      current.artifacts,
    );
    assert.throws(() => sibling.ref(second), /capability_invalid/u);
    assertContinuationRuntimeV1PolicyAuthority(
      current.policies,
      current.database,
      current.artifacts,
    );
    assert.throws(() => assertContinuationRuntimeV1PolicyAuthority(
      { ...current.policies },
      current.database,
      current.artifacts,
    ), /service_invalid/u);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("policy bundles reject untyped artifacts atomically and exact resolution enforces time", async () => {
  const current = fixture();
  try {
    const {
      trusted_observer_principals: _omittedTrustedObservers,
      ...missingFieldPayload
    } = compilerPayload(SUBJECT);
    const cases = [
      signedPolicy({
        artifactId: "wrong-schema",
        schema: "compiler_policy_v1",
      }),
      signedPolicy({ artifactId: "dummy", payload: {} }),
      signedPolicy({
        artifactId: "missing-field",
        payload: missingFieldPayload,
      }),
      signedPolicy({
        artifactId: "subject-mismatch",
        payload: compilerPayload("b".repeat(64) as Sha256),
      }),
      signedPolicy({
        artifactId: "payload-tenant-mismatch",
        payload: buildContinuationCompilerPolicyV1({
          ...compilerPayload(SUBJECT),
          tenant_id: "tenant-b",
        }),
      }),
      signedPolicy({
        artifactId: "wrong-evidence-schema",
        kind: "evidence_policy",
        schema: "evidence_policy_v1",
      }),
    ];
    for (const artifact of cases) {
      await assert.rejects(persist(current, artifact));
      assert.equal(await current.artifacts.readByDigest({
        tenant_id: TENANT,
        artifact_sha256: artifact.artifact_sha256,
      }), null, "invalid policy bundle must roll back before installing either artifact");
    }

    const timed = signedPolicy({
      artifactId: "time-window",
      validFrom: "2026-07-21T02:00:00.000Z",
      expiresAt: "2026-07-21T03:00:00.000Z",
    });
    await persist(current, timed);
    for (const at of ["2026-07-21T01:59:59.999Z", "2026-07-21T03:00:00.000Z"]) {
      await assert.rejects(current.policies.resolveExact({
        tenant_id: TENANT,
        authority_subject_sha256: SUBJECT,
        artifact_kind: "compiler_policy",
        artifact_ref: ref(timed),
        at,
      }), /artifact_binding_invalid/u);
    }

    const wrongRootStore = createContinuationRuntimeV1AuthorityArtifactReader(
      current.database,
      OTHER_KEYS.publicKey,
    );
    const wrongRootAuthority = createContinuationRuntimeV1PolicyAuthority(
      current.database,
      wrongRootStore,
    );
    await assert.rejects(wrongRootAuthority.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      artifact_ref: ref(timed),
      at: "2026-07-21T02:30:00.000Z",
    }), /trust_root_mismatch/u);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("current resolution fails closed on ambiguity and invalid bundles cannot poison it", async () => {
  const current = fixture();
  try {
    const first = signedPolicy({ artifactId: "compiler-a" });
    const second = signedPolicy({ artifactId: "compiler-b", revision: 2 });
    await persist(current, first);
    await persist(current, second);
    await assert.rejects(current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T02:00:00.000Z",
    }), (error: unknown) => {
      assert.ok(error instanceof ContinuationRuntimeV1PolicyAmbiguityError);
      assert.deepEqual(error.artifactIds, ["compiler-a", "compiler-b"]);
      assert.equal(Object.isFrozen(error.artifactIds), true);
      return true;
    });

    const otherSubject = "c".repeat(64) as Sha256;
    const valid = signedPolicy({ artifactId: "valid-other", subject: otherSubject });
    const dummy = signedPolicy({
      artifactId: "dummy-other",
      subject: otherSubject,
      payload: {},
    });
    await persist(current, valid);
    await assert.rejects(persist(current, dummy));
    const resolved = await current.policies.resolveCurrent({
      tenant_id: TENANT,
      authority_subject_sha256: otherSubject,
      artifact_kind: "compiler_policy",
      at: "2026-07-21T02:00:00.000Z",
    });
    assert.deepEqual(current.policies.ref(resolved), ref(valid));
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});
