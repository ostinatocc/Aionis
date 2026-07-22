import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSignedAuthorityArtifactV1,
  type AuthorityArtifactBuildInputV1,
  type SignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import type { AuthorityBranchManifestV1 } from
  "../../src/continuation/authority-branch.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "../../src/continuation/contract.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import {
  EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
  buildExperimentCohortV1,
  type ExperimentCohortV1,
} from "../../src/continuation/experiment-cohort.js";
import {
  POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
  buildPolicyRotationPayloadV1,
} from "../../src/continuation/policy-rotation.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../../src/continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  assertOfflineProvisioningCommandV1,
  createContinuationRuntimeV1OfflineProvisioningService,
  type OfflineExperimentCohortInstallCommandV1,
  type OfflinePolicyBundleInstallCommandV1,
  type OfflinePolicyRotationInstallCommandV1,
  type OfflineProvisioningCommandV1,
} from "../../src/runtime-v1/provisioning.js";
import {
  createContinuationRuntimeV1AuthorityArtifactProvisioner,
  type AuthorityPolicyProvisioningBundleV1,
} from "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1EffectCertificateReader } from
  "../../src/store/continuation-runtime-v1-effect-certificate-reader.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
} from "../../src/store/continuation-runtime-v1-operation-store.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-a";
const SCOPE = "scope-a";
const FAMILY = "coding";
const OPERATOR = "1".repeat(64) as Sha256;
const HOST = "2".repeat(64) as Sha256;
const VERIFIER = "3".repeat(64) as Sha256;
const SHA_A = "a".repeat(64) as Sha256;
const SHA_B = "b".repeat(64) as Sha256;
const SHA_C = "c".repeat(64) as Sha256;
const SHA_D = "d".repeat(64) as Sha256;
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: FAMILY,
});
const SEED_TEXT = "SECRET-SEED-0123456789-ABCDEFGHI";
const ASSIGNMENT_SEED = Buffer.from(SEED_TEXT, "utf8");
assert.equal(ASSIGNMENT_SEED.byteLength, 32);
let sequence = 0;

type Fixture = Readonly<{
  root: string;
  database: ContinuationRuntimeV1Database;
  artifacts: ReturnType<typeof createContinuationRuntimeV1AuthorityArtifactReader>;
  operations: ReturnType<typeof createContinuationRuntimeV1OperationStore>;
  authority: ReturnType<typeof createContinuationRuntimeV1AuthorityStore>;
  observations: ReturnType<typeof createContinuationRuntimeV1ObservationStore>;
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>;
  provisioning: ReturnType<typeof createContinuationRuntimeV1OfflineProvisioningService>;
}>;

function fixture(): Fixture {
  sequence += 1;
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-provisioning-"));
  const database = openContinuationRuntimeV1Database(
    join(root, "authority", "runtime.sqlite"),
    {
      databaseInstanceId: sequence.toString(16).padStart(64, "0"),
      now: () => "2026-07-21T00:00:00.000Z",
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
  const operations = createContinuationRuntimeV1OperationStore(database, {
    now: () => "2026-07-21T02:00:00.000Z",
  });
  const policies = createContinuationRuntimeV1PolicyAuthority(database, artifacts);
  const effects = createContinuationRuntimeV1EffectCertificateReader(
    database,
    artifacts,
    policies,
  );
  const authority = createContinuationRuntimeV1AuthorityStore(
    database,
    artifacts,
    policies,
    effects,
    { now: () => "2026-07-21T02:00:00.000Z" },
  );
  const observations = createContinuationRuntimeV1ObservationStore(database, {
    now: () => "2026-07-21T02:00:00.000Z",
  });
  const memory = createContinuationRuntimeV1MemoryStore(database, {
    now: () => "2026-07-21T02:00:00.000Z",
  });
  return {
    root,
    database,
    artifacts,
    operations,
    authority,
    observations,
    memory,
    provisioning: createContinuationRuntimeV1OfflineProvisioningService(
      database,
      artifactProvisioner,
      operations,
    ),
  };
}

function compilerPayload(revision = 1) {
  return buildContinuationCompilerPolicyV1({
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
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

function evidencePayload() {
  return buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    trusted_effect_verifier_principals: [VERIFIER],
    max_eligible_decisions: 256,
    max_treatment_delta_count: 8,
    min_evidence_window_ms: 60_000,
    max_evidence_window_ms: 86_400_000,
    min_control_exposures: 10,
    min_candidate_exposures: 10,
    max_missingness_bps: 0,
    harm_noninferiority_margin_bps: 0,
    utility_min_lift_bps: 1,
    confidence_bps: 9_000,
    effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  });
}

function signed(
  input: AuthorityArtifactBuildInputV1,
  key: KeyObject = ROOT_KEYS.privateKey,
): SignedAuthorityArtifactV1 {
  return buildSignedAuthorityArtifactV1(input, key);
}

function compilerArtifact(
  key: KeyObject = ROOT_KEYS.privateKey,
): SignedAuthorityArtifactV1 {
  return signed({
    tenant_id: TENANT,
    artifact_id: "compiler-main",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: compilerPayload(),
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  }, key);
}

function evidenceArtifact(): SignedAuthorityArtifactV1 {
  return signed({
    tenant_id: TENANT,
    artifact_id: "evidence-main",
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: evidencePayload(),
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  });
}

function artifactRef(artifact: SignedAuthorityArtifactV1): AuthorityArtifactRefV1 {
  return {
    artifact_sha256: artifact.artifact_sha256,
    payload_sha256: artifact.payload_sha256,
  };
}

function policyBundle(
  compiler = compilerArtifact(),
  evidence = evidenceArtifact(),
): AuthorityPolicyProvisioningBundleV1 {
  return {
    schema_version: "authority_policy_provisioning_bundle_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    compiler_policy: compiler,
    evidence_policy: evidence,
  };
}

function branchRef(manifest: AuthorityBranchManifestV1) {
  return {
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
  };
}

function fullBranchRef(manifest: AuthorityBranchManifestV1) {
  return {
    ...branchRef(manifest),
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  };
}

type CohortBindings = Readonly<{
  compiler: SignedAuthorityArtifactV1;
  evidence: SignedAuthorityArtifactV1;
  control_learning_ref: ExperimentCohortV1["control_learning_ref"];
  candidate_learning_ref: ExperimentCohortV1["candidate_learning_ref"];
}>;

function experimentCohortArtifact(
  seed: Uint8Array = ASSIGNMENT_SEED,
  key: KeyObject = ROOT_KEYS.privateKey,
  bindings?: CohortBindings,
): SignedAuthorityArtifactV1 {
  const compiler = bindings?.compiler ?? compilerArtifact();
  const evidence = bindings?.evidence ?? evidenceArtifact();
  const payload = buildExperimentCohortV1({
    schema_version: "experiment_cohort_v1",
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: FAMILY,
    cohort_id: "cohort-main",
    authority_subject_sha256: SUBJECT,
    control_learning_ref: bindings?.control_learning_ref ?? {
      branch_id: "authority-main",
      branch_revision: 1,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    candidate_learning_ref: bindings?.candidate_learning_ref ?? {
      branch_id: "candidate-main",
      branch_revision: 2,
      manifest_sha256: SHA_B,
      branch_kind: "candidate",
      state: "active_candidate",
    },
    compiler_policy_ref: artifactRef(compiler),
    evidence_policy_ref: artifactRef(evidence),
    eligibility: { host_principal_sha256s: null },
    assignment_protocol: {
      algorithm: "hmac_sha256_threshold_v1",
      algorithm_contract_sha256:
        EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
      assignment_seed_commitment_sha256:
        assignmentSeedCommitmentSha256V1(seed),
      basis_schema: "serving_assignment_basis_v1",
      candidate_allocation_bps: 5_000,
    },
    assignment_window_opened_at: "2026-07-21T03:00:00.000Z",
    assignment_window_closed_at: "2026-07-21T04:00:00.000Z",
    outcome_deadline: "2026-07-21T05:00:00.000Z",
    settlement_grace_ms: 60_000,
    settlement_cutoff_at: "2026-07-21T05:01:00.000Z",
  });
  return signed({
    tenant_id: TENANT,
    artifact_id: "cohort-main",
    artifact_revision: 1,
    artifact_kind: "experiment_cohort",
    artifact_schema: "experiment_cohort_v1",
    authority_subject_sha256: SUBJECT,
    payload,
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: "2026-07-21T06:00:00.000Z",
    created_at: "2026-07-21T00:00:00.000Z",
  }, key);
}

function policyRotationArtifact(): SignedAuthorityArtifactV1 {
  const compiler = compilerArtifact();
  const evidence = evidenceArtifact();
  const payload = buildPolicyRotationPayloadV1({
    schema_version: POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    previous_authoritative_ref: {
      branch_id: "authority-main",
      branch_revision: 1,
      manifest_sha256: SHA_A,
      branch_kind: "authoritative",
      state: "authoritative",
    },
    old_compiler_policy_ref: artifactRef(compiler),
    new_compiler_policy_ref: {
      artifact_sha256: SHA_C,
      payload_sha256: SHA_D,
    },
    old_evidence_policy_ref: artifactRef(evidence),
    new_evidence_policy_ref: artifactRef(evidence),
    previous_binding_set_sha256: SHA_B,
  });
  return signed({
    tenant_id: TENANT,
    artifact_id: "rotation-main",
    artifact_revision: 1,
    artifact_kind: "policy_rotation",
    artifact_schema: POLICY_ROTATION_ARTIFACT_SCHEMA_V1,
    authority_subject_sha256: SUBJECT,
    payload,
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  });
}

function common(operationId: string) {
  return {
    schema_version: "offline_provisioning_command_v1" as const,
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: FAMILY,
    operation_id: operationId,
    actor_kind: "operator" as const,
    actor_principal_sha256: OPERATOR,
    authority_subject_sha256: SUBJECT,
  };
}

function policyCommand(
  bundle = policyBundle(),
  operationId = "install-policy-bundle",
): OfflinePolicyBundleInstallCommandV1 {
  return {
    ...common(operationId),
    kind: "policy_bundle_install",
    policy_bundle: bundle,
  };
}

function cohortCommand(
  artifact = experimentCohortArtifact(),
  seed: Uint8Array = Buffer.from(ASSIGNMENT_SEED),
  operationId = "install-experiment-cohort",
): OfflineExperimentCohortInstallCommandV1 {
  return {
    ...common(operationId),
    kind: "experiment_cohort_install",
    experiment_cohort_artifact: artifact,
    assignment_seed: seed,
  };
}

function rotationCommand(
  artifact = policyRotationArtifact(),
  operationId = "install-policy-rotation",
): OfflinePolicyRotationInstallCommandV1 {
  return {
    ...common(operationId),
    kind: "policy_rotation_install",
    policy_rotation_artifact: artifact,
  };
}

async function operation<T>(
  current: Fixture,
  operationKind: "record_observations" | "authority_decision",
  operationId: string,
  produce: (context: ContinuationRuntimeV1AuthorityWriteContext) => Promise<T>,
): Promise<T> {
  let result: T | null = null;
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind,
    operationId,
    actorKind: operationKind === "authority_decision" ? "operator" : "trusted_host",
    actorPrincipalSha256: operationKind === "authority_decision" ? OPERATOR : HOST,
    request: { operation_id: operationId },
    produce: async (context) => {
      result = await produce(context);
      return deriveContinuationRuntimeV1OperationResultV1(
        current.database,
        assertContinuationRuntimeV1AuthorityWriteContext(context, current.database),
        "before_receipt_insert",
      );
    },
  });
  return result!;
}

async function seedLearningPair(
  current: Fixture,
  bundle: AuthorityPolicyProvisioningBundleV1,
): Promise<CohortBindings> {
  const seeded = await operation(
    current,
    "record_observations",
    "seed-cohort-learning-pair",
    async (context) => {
      await current.observations.put(context, {
        host_task_envelope: {
          host_task_id: "task-provisioning-learning-pair",
          episode_id: "episode-provisioning-learning-pair",
          run_id: "run-provisioning-learning-pair",
          consumer_agent_id: "agent-provisioning",
          consumer_team_id: null,
          task_family: FAMILY,
          task_signature: "provisioning-signature",
          workflow_signature: null,
          workspace_signature: "provisioning-workspace",
          source_task_sha256: SHA_C,
          source_event_sha256: SHA_D,
          issued_at: "2026-07-21T01:30:00.000Z",
          expires_at: "2026-07-21T06:00:00.000Z",
        },
        collector_observations: [],
        signed_observations: [],
      });
      await current.memory.appendMemoryRevision(context, {
        expected_head_revision: null,
        items: [{
          memory_id: "memory-provisioning-candidate",
          memory_kind: "procedure",
          lifecycle: "active",
          authority: "candidate",
          hydrated: true,
          projection: { source: "provisioning-cohort-fixture" },
          rehydration_ref: null,
          expires_at: null,
        }],
        relations: [],
        capsules: [{
          memory_id: "memory-provisioning-candidate",
          draft: {
            capsule_id: "capsule-provisioning-candidate",
            kind: "procedure",
            proposed_influence: "inspect",
            applicability: {
              task_family: FAMILY,
              task_signature: null,
              workflow_signature: null,
              workspace_signature: null,
              producer_agent_id: null,
              owner_agent_id: null,
              owner_team_id: null,
            },
            projection: {
              summary: "Inspect the candidate procedure",
              next_action: "Verify the exact candidate state",
              target_refs: [{ kind: "memory", ref: "candidate-state" }],
              workflow_steps: ["inspect", "verify"],
              acceptance_statements: ["candidate state verified"],
            },
            coverage_claims: [{
              obligation_kind: "required_state",
              target_refs: [{ kind: "memory", ref: "candidate-state" }],
              evidence_requirement: "runtime_state",
              required_probe_ids: [],
            }],
            precondition_specs: [],
            evidence_refs: [],
            verifier_refs: [],
            conflicts_with: [],
            supersedes: [],
            expires_at: null,
          },
        }],
      });
      const genesis = await current.authority.ensureGenesis(context);
      const candidate = await current.authority.createIsolatedCandidateDraft(context, {
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      });
      assert.ok(candidate);
      return { genesis, candidate };
    },
  );

  let candidate = seeded.candidate;
  for (const [index, target] of [
    "shadow",
    "eligible",
    "active_candidate",
  ].entries()) {
    candidate = await operation(
      current,
      "authority_decision",
      `advance-cohort-candidate-${index + 1}`,
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(candidate.revision.manifest),
        target_state: target as "shadow" | "eligible" | "active_candidate",
        reason_codes: ["verified_offline_evidence"],
        evidence_sha256s: [canonicalContinuationSha256({ target })],
        expected_head_revision: seeded.genesis.head.head_revision,
        expected_head_sha256: seeded.genesis.head.head_sha256,
      }),
    );
  }
  return {
    compiler: bundle.compiler_policy,
    evidence: bundle.evidence_policy,
    control_learning_ref: fullBranchRef(seeded.genesis.revision.manifest) as
      ExperimentCohortV1["control_learning_ref"],
    candidate_learning_ref: fullBranchRef(candidate.revision.manifest) as
      ExperimentCohortV1["candidate_learning_ref"],
  };
}

function count(database: ContinuationRuntimeV1Database, table: string): number {
  return (database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function assertEmptyAuthorityState(database: ContinuationRuntimeV1Database): void {
  assert.equal(count(database, "operations"), 0);
  assert.equal(count(database, "authority_artifacts"), 0);
  assert.equal(count(database, "durable_jobs"), 0);
  assert.equal(count(database, "branch_revisions"), 0);
  assert.equal(count(database, "authority_heads"), 0);
}

async function close(current: Fixture): Promise<void> {
  await current.database.close();
  rmSync(current.root, { recursive: true, force: true });
}

test("pure provisioning parser closes the tagged union and all transient seed bindings", () => {
  for (const command of [
    policyCommand(),
    cohortCommand(),
    rotationCommand(),
  ]) assert.doesNotThrow(() => assertOfflineProvisioningCommandV1(command));
  const rejected: ReadonlyArray<readonly [unknown, RegExp]> = [
    [{ ...policyCommand(), kind: "install_anything" }, /command_kind_invalid/u],
    [{ ...policyCommand(), actor_kind: "trusted_host" }, /actor_kind_invalid/u],
    [{ ...policyCommand(), private_key: "forbidden" }, /command_shape_invalid/u],
    [{ ...cohortCommand(), assignment_seed: Buffer.alloc(31) },
      /assignment_seed_must_be_exactly_32_bytes/u],
    [cohortCommand(
      experimentCohortArtifact(Buffer.alloc(32, 9)),
      Buffer.from(ASSIGNMENT_SEED),
    ), /assignment_seed_commitment_mismatch/u],
    [{ ...cohortCommand(), scope: "scope-other" }, /authority_subject_binding_invalid/u],
    [{ ...rotationCommand(), task_family: "finance" },
      /authority_subject_binding_invalid/u],
    [{ ...policyCommand(), actor_principal_sha256: "operator" },
      /actor_principal_sha256_invalid/u],
    [{
      schema_version: "offline_policy_provisioning_command_v1",
      tenant_id: TENANT,
      scope: SCOPE,
      operation_id: "legacy",
      actor_principal_sha256: OPERATOR,
      authority_subject_sha256: SUBJECT,
      bundle: policyBundle(),
    }, /command_discriminator_invalid/u],
  ];
  for (const [value, pattern] of rejected) {
    assert.throws(() => assertOfflineProvisioningCommandV1(value), pattern);
  }
});

function allPersistedJson(database: ContinuationRuntimeV1Database): string[] {
  const tables = database.db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ name: string }>;
  const values: string[] = [];
  for (const { name } of tables) {
    const escapedTable = name.replaceAll('"', '""');
    const columns = database.db.prepare(`PRAGMA table_info("${escapedTable}")`)
      .all() as Array<{ name: string }>;
    for (const column of columns.filter((entry) => entry.name.endsWith("_json"))) {
      const escapedColumn = column.name.replaceAll('"', '""');
      const rows = database.db.prepare(
        `SELECT "${escapedColumn}" AS value FROM "${escapedTable}"
          WHERE "${escapedColumn}" IS NOT NULL`,
      ).all() as Array<{ value: unknown }>;
      for (const row of rows) {
        assert.equal(typeof row.value, "string");
        values.push(row.value as string);
      }
    }
  }
  return values;
}

test("all three root-signed provisioning variants derive exact results and replay idempotently", async () => {
  const current = fixture();
  try {
    const bundle = policyBundle();
    const policy = policyCommand(bundle);
    const rotationArtifact = policyRotationArtifact();
    const rotation = rotationCommand(rotationArtifact);

    const policyCreated = await current.provisioning.provision(policy);
    assert.equal(policyCreated.status, "created");
    assert.deepEqual(policyCreated.receipt.result, {
      schema_version: "authority_decision_result_v1",
      decision_kind: "policy_bundle_install",
      compiler_policy_ref: artifactRef(bundle.compiler_policy),
      evidence_policy_ref: artifactRef(bundle.evidence_policy),
    });

    const learningPair = await seedLearningPair(current, bundle);
    const cohortArtifact = experimentCohortArtifact(
      ASSIGNMENT_SEED,
      ROOT_KEYS.privateKey,
      learningPair,
    );
    const cohort = cohortCommand(cohortArtifact);
    const cohortCreated = await current.provisioning.provision(cohort);
    assert.equal(cohortCreated.status, "created");
    assert.deepEqual(cohortCreated.receipt.result, {
      schema_version: "authority_decision_result_v1",
      decision_kind: "experiment_cohort_install",
      experiment_cohort_ref: artifactRef(cohortArtifact),
      effect_job_ref: {
        ...(cohortCreated.receipt.result as {
          effect_job_ref: Record<string, unknown>;
        }).effect_job_ref,
        task_family: FAMILY,
        authority_subject_sha256: SUBJECT,
        job_kind: "effect",
      },
    });
    const effectRef = (cohortCreated.receipt.result as {
      effect_job_ref: Readonly<Record<string, unknown>>;
    }).effect_job_ref;
    assert.deepEqual(Object.keys(effectRef).sort(), [
      "authority_subject_sha256",
      "definition_sha256",
      "job_id",
      "job_kind",
      "payload_sha256",
      "task_family",
    ]);
    assert.match(effectRef.job_id as string, /\S/u);
    assert.match(effectRef.payload_sha256 as string, /^[0-9a-f]{64}$/u);
    assert.match(effectRef.definition_sha256 as string, /^[0-9a-f]{64}$/u);

    const rotationCreated = await current.provisioning.provision(rotation);
    assert.equal(rotationCreated.status, "created");
    assert.deepEqual(rotationCreated.receipt.result, {
      schema_version: "authority_decision_result_v1",
      decision_kind: "policy_rotation_install",
      policy_rotation_artifact_ref: artifactRef(rotationArtifact),
    });

    for (const [command, created] of [
      [policy, policyCreated],
      [cohort, cohortCreated],
      [rotation, rotationCreated],
    ] as const) {
      const replay = await current.provisioning.provision(command);
      assert.equal(replay.status, "replayed");
      assert.deepEqual(replay, { ...created, status: "replayed" });
    }
    assert.deepEqual(Buffer.from(cohort.assignment_seed), ASSIGNMENT_SEED,
      "provisioning must not mutate caller-owned seed bytes");
    assert.equal(count(current.database, "operations"), 7);
    assert.equal(count(current.database, "authority_artifacts"), 4);
    assert.equal(count(current.database, "durable_jobs"), 1,
      "one cohort must create exactly one settlement job, including replay");
    assert.equal(count(current.database, "branch_revisions"), 5);
    assert.equal(count(current.database, "authority_heads"), 1,
      "offline rotation installs authority but never mutates the learning head");
  } finally {
    await close(current);
  }
});

test("the raw assignment seed exists only in protected_secret, never canonical JSON or receipts", async () => {
  const current = fixture();
  try {
    const bundle = policyBundle();
    await current.provisioning.provision(policyCommand(bundle));
    const learningPair = await seedLearningPair(current, bundle);
    const artifact = experimentCohortArtifact(
      ASSIGNMENT_SEED,
      ROOT_KEYS.privateKey,
      learningPair,
    );
    const command = cohortCommand(artifact);
    const created = await current.provisioning.provision(command);
    const operation = current.database.db.prepare(
      `SELECT request_json, receipt_json FROM operations
        WHERE tenant_id = ? AND scope = ? AND operation_id = ?`,
    ).get(TENANT, SCOPE, command.operation_id) as {
      request_json: string;
      receipt_json: string;
    };
    const request = JSON.parse(operation.request_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(request).sort(), [
      "authority_subject_sha256",
      "experiment_cohort_artifact",
      "kind",
      "schema_version",
      "scope",
      "task_family",
      "tenant_id",
    ]);
    assert.equal(Object.hasOwn(request, "assignment_seed"), false);
    assert.equal(canonicalContinuationJson(
      request.experiment_cohort_artifact,
    ), canonicalContinuationJson(artifact));
    assert.equal(created.receipt.result.schema_version,
      "authority_decision_result_v1");
    assert.equal((created.receipt.result as {
      decision_kind: string;
    }).decision_kind, "experiment_cohort_install");

    const row = current.database.db.prepare(
      `SELECT protected_secret, payload_json FROM authority_artifacts
        WHERE tenant_id = ? AND artifact_kind = 'experiment_cohort'`,
    ).get(TENANT) as { protected_secret: unknown; payload_json: string };
    assert.ok(row.protected_secret instanceof Uint8Array);
    assert.deepEqual(Buffer.from(row.protected_secret), ASSIGNMENT_SEED);
    assert.equal(row.payload_json.includes(SEED_TEXT), false);

    const forbidden = [
      SEED_TEXT,
      ASSIGNMENT_SEED.toString("hex"),
      ASSIGNMENT_SEED.toString("base64url"),
      ASSIGNMENT_SEED.toString("base64"),
    ];
    for (const json of allPersistedJson(current.database)) {
      for (const secret of forbidden) assert.equal(json.includes(secret), false);
    }
    for (const secret of forbidden) {
      assert.equal(operation.request_json.includes(secret), false);
      assert.equal(operation.receipt_json.includes(secret), false);
    }
  } finally {
    await close(current);
  }
});

test("wrong seed length, commitment, bindings, kind, root, operator, and shape roll back atomically", async () => {
  const wrongCommitmentArtifact = experimentCohortArtifact(Buffer.alloc(32, 9));
  const wrongRootBundle = policyBundle(
    compilerArtifact(OTHER_KEYS.privateKey),
    evidenceArtifact(),
  );
  const cases: ReadonlyArray<Readonly<{
    name: string;
    value(): OfflineProvisioningCommandV1;
    pattern: RegExp;
  }>> = [
    {
      name: "31-byte seed",
      value: () => cohortCommand(experimentCohortArtifact(), Buffer.alloc(31)),
      pattern: /assignment_seed_must_be_exactly_32_bytes/u,
    },
    {
      name: "33-byte seed",
      value: () => cohortCommand(experimentCohortArtifact(), Buffer.alloc(33)),
      pattern: /assignment_seed_must_be_exactly_32_bytes/u,
    },
    {
      name: "seed commitment",
      value: () => cohortCommand(wrongCommitmentArtifact, Buffer.from(ASSIGNMENT_SEED)),
      pattern: /assignment_seed_commitment_mismatch/u,
    },
    {
      name: "tenant binding",
      value: () => ({ ...policyCommand(), tenant_id: "tenant-other" } as never),
      pattern: /authority_subject_binding_invalid/u,
    },
    {
      name: "scope binding",
      value: () => ({ ...cohortCommand(), scope: "scope-other" } as never),
      pattern: /authority_subject_binding_invalid/u,
    },
    {
      name: "task-family binding",
      value: () => ({ ...rotationCommand(), task_family: "finance" } as never),
      pattern: /authority_subject_binding_invalid/u,
    },
    {
      name: "subject binding",
      value: () => ({ ...policyCommand(), authority_subject_sha256: SHA_D } as never),
      pattern: /authority_subject_binding_invalid/u,
    },
    {
      name: "artifact kind",
      value: () => cohortCommand(compilerArtifact()),
      pattern: /invalid_experiment_cohort_v1/u,
    },
    {
      name: "command kind",
      value: () => ({ ...policyCommand(), kind: "install_anything" } as never),
      pattern: /command_kind_invalid/u,
    },
    {
      name: "wrong root",
      value: () => policyCommand(wrongRootBundle),
      pattern: /trust_root_mismatch/u,
    },
    {
      name: "non-operator",
      value: () => ({ ...policyCommand(), actor_kind: "trusted_host" } as never),
      pattern: /actor_kind_invalid/u,
    },
    {
      name: "operator principal",
      value: () => ({ ...policyCommand(), actor_principal_sha256: "operator" } as never),
      pattern: /actor_principal_sha256_invalid/u,
    },
    {
      name: "top-level extra key",
      value: () => ({ ...policyCommand(), private_key: "forbidden" } as never),
      pattern: /command_shape_invalid/u,
    },
    {
      name: "signed artifact extra key",
      value: () => rotationCommand({
        ...policyRotationArtifact(),
        signing_key: "forbidden",
      } as never),
      pattern: /policy_rotation_artifact_shape_invalid/u,
    },
    {
      name: "removed legacy command",
      value: () => ({
        schema_version: "offline_policy_provisioning_command_v1",
        tenant_id: TENANT,
        scope: SCOPE,
        operation_id: "legacy",
        actor_principal_sha256: OPERATOR,
        authority_subject_sha256: SUBJECT,
        bundle: policyBundle(),
      } as never),
      pattern: /command_discriminator_invalid/u,
    },
  ];
  for (const currentCase of cases) {
    const current = fixture();
    try {
      let caught: unknown;
      try {
        await current.provisioning.provision(currentCase.value());
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, currentCase.name);
      assert.match(String(caught), currentCase.pattern, currentCase.name);
      assert.equal(String(caught).includes(SEED_TEXT), false, currentCase.name);
      assert.equal(
        String(caught).includes(ASSIGNMENT_SEED.toString("base64url")),
        false,
        currentCase.name,
      );
      assertEmptyAuthorityState(current.database);
    } finally {
      await close(current);
    }
  }
});
