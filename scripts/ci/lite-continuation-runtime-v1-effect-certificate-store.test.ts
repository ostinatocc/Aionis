import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { buildSignedAuthorityArtifactV1 } from
  "../../src/continuation/authority-artifact.js";
import type { AuthorityBranchManifestV1 } from
  "../../src/continuation/authority-branch.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import {
  canonicalContinuationSha256,
  type CanonicalJson,
  type ContinuationContractV1,
} from "../../src/continuation/contract.js";
import {
  buildEffectEvidencePolicyV1,
  buildEffectTreatmentDeltaSetV1,
  buildSignedEffectCertificateV1,
  type EffectTreatmentDeltaSetV1,
} from "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import {
  buildEffectEvidenceMemberSetV1,
  type EffectEvidenceMemberInputV1,
  type EpisodeEventRefV1,
} from "../../src/continuation/episode.js";
import {
  EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
  buildExperimentCohortV1,
  type ExperimentCohortV1,
} from "../../src/continuation/experiment-cohort.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../../src/continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  authorityBranchBindingSetSha256V1,
  buildPolicyRotationPayloadV1,
} from "../../src/continuation/policy-rotation.js";
import { buildServingAssignmentBasisV1 } from
  "../../src/continuation/serving-assignment.js";
import { createContinuationRuntimeV1DecisionAssemblyService } from
  "../../src/runtime-v1/decision-assembly.js";
import { createContinuationRuntimeV1EffectWorkerProcessor } from
  "../../src/runtime-v1/effect-worker-processor.js";
import type { ContinuationRuntimeV1EffectSigner } from
  "../../src/runtime-v1/effect-signer.js";
import {
  buildWorkerCompletionCommandV1,
} from "../../src/runtime-v1/command.js";
import { operationRequestFromVerifiedCommandV1 } from
  "../../src/runtime-v1/operation-request.js";
import type {
  ContinuationRuntimeV1PreparedWorkerSuccess,
  ContinuationRuntimeV1WorkerAttemptJob,
} from "../../src/runtime-v1/worker-service.js";
import { ContinuationRuntimeV1WorkerProcessorError } from
  "../../src/runtime-v1/worker-service.js";
import { continuationRuntimeV1WorkerPrincipal } from
  "../../src/runtime-v1/worker-identity.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.js";
import type { ContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.js";
import {
  createContinuationRuntimeV1DurableJobWorkerStore,
  type ContinuationRuntimeV1DurableJob,
} from "../../src/store/continuation-runtime-v1-durable-job-store.js";
import {
  assertContinuationRuntimeV1EffectCertificateReader,
  assertVerifiedAdmittedEffectCertificateCapabilityV1,
  createContinuationRuntimeV1EffectCertificateReader,
  projectVerifiedAdmittedEffectCertificateCapabilityV1,
} from "../../src/store/continuation-runtime-v1-effect-certificate-reader.js";
import {
  assertContinuationRuntimeV1EffectCertificateWriter,
  createContinuationRuntimeV1EffectCertificateWriter,
} from "../../src/store/continuation-runtime-v1-effect-certificate-writer.js";
import { createContinuationRuntimeV1EpisodeStore } from
  "../../src/store/continuation-runtime-v1-episode-store.js";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "../../src/store/continuation-runtime-v1-experiment-cohort-authority.js";
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
  type ContinuationRuntimeV1OperationKind,
} from "../../src/store/continuation-runtime-v1-operation-store.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.js";
import { loadContinuationRuntimeV1Ddl } from
  "../../src/store/continuation-runtime-v1-schema.js";
import { createSqliteDatabase } from "../../src/store/sqlite.js";
import { createSqliteTransactionRunner } from
  "../../src/store/sqlite-transaction-runner.js";
import { sha256Hex } from "../../src/util/crypto.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const EFFECT_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-effect";
const SCOPE = "scope-effect";
const FAMILY = "repair";
const HOST = "1".repeat(64);
const OPERATOR = "2".repeat(64);
const WORKER = "3".repeat(64);
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: FAMILY,
});
const ASSIGNMENT_SEED = Buffer.alloc(32, 11);

function at(hour: number, minute = 0, second = 0, millisecond = 0): string {
  return `2026-07-22T${String(hour).padStart(2, "0")}:$${
    String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.$${
    String(millisecond).padStart(3, "0")}Z`.replaceAll("$", "");
}

function plus(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function principalForEffectVerifier(): string {
  return createHash("sha256")
    .update(createPublicKey(EFFECT_KEYS.privateKey).export({ format: "der", type: "spki" }))
    .digest("hex");
}

function inMemoryDatabase(): ContinuationRuntimeV1Database {
  const db = createSqliteDatabase(":memory:");
  db.exec(loadContinuationRuntimeV1Ddl());
  const transaction = createSqliteTransactionRunner({
    begin: () => db.exec("BEGIN IMMEDIATE"),
    commit: () => db.exec("COMMIT"),
    rollback: () => db.exec("ROLLBACK"),
  });
  let closed = false;
  return {
    path: ":memory:",
    databaseInstanceId: "d".repeat(64),
    db,
    transaction,
    withTx: (fn) => transaction.run(fn),
    read: (fn) => transaction.read(fn),
    async close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}

function fixture() {
  const clock = { value: at(8) };
  const database = inMemoryDatabase();
  const operations = createContinuationRuntimeV1OperationStore(database, {
    now: () => clock.value,
  });
  const artifactProvisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
    database,
    ROOT_KEYS.publicKey,
  );
  const artifacts = createContinuationRuntimeV1AuthorityArtifactReader(
    database,
    ROOT_KEYS.publicKey,
  );
  const policies = createContinuationRuntimeV1PolicyAuthority(database, artifacts);
  const effectReader = createContinuationRuntimeV1EffectCertificateReader(
    database,
    artifacts,
    policies,
  );
  const effectWriter = createContinuationRuntimeV1EffectCertificateWriter(
    database,
    artifacts,
    policies,
  );
  const authority = createContinuationRuntimeV1AuthorityStore(
    database,
    artifacts,
    policies,
    effectReader,
    { now: () => clock.value },
  );
  const observations = createContinuationRuntimeV1ObservationStore(database, {
    now: () => clock.value,
  });
  const memory = createContinuationRuntimeV1MemoryStore(database, {
    now: () => clock.value,
  });
  const cohorts = createContinuationRuntimeV1ExperimentCohortAuthority(
    database,
    artifacts,
    policies,
  );
  const episode = createContinuationRuntimeV1EpisodeStore(database, {
    now: () => clock.value,
  });
  const jobs = createContinuationRuntimeV1DurableJobWorkerStore(database, {
    now: () => clock.value,
  });
  const assembly = createContinuationRuntimeV1DecisionAssemblyService({
    database,
    observationStore: observations,
    memoryStore: memory,
    artifactStore: artifacts,
    policyAuthority: policies,
    effectCertificateReader: effectReader,
    authorityStore: authority,
    experimentCohortAuthority: cohorts,
  }, { now: () => clock.value });
  return {
    clock,
    database,
    operations,
    artifactProvisioner,
    artifacts,
    policies,
    effectReader,
    effectWriter,
    authority,
    observations,
    memory,
    cohorts,
    episode,
    jobs,
    assembly,
  };
}

type Fixture = ReturnType<typeof fixture>;

function actor(kind: ContinuationRuntimeV1OperationKind) {
  if (kind === "authority_decision") {
    return { actorKind: "operator" as const, actorPrincipalSha256: OPERATOR };
  }
  if (kind === "worker_completion") {
    return { actorKind: "worker" as const, actorPrincipalSha256: WORKER };
  }
  return { actorKind: "trusted_host" as const, actorPrincipalSha256: HOST };
}

async function operation<T>(
  current: Fixture,
  kind: ContinuationRuntimeV1OperationKind,
  operationId: string,
  produce: (context: ContinuationRuntimeV1AuthorityWriteContext) => Promise<T>,
): Promise<T> {
  let result: T | null = null;
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: kind,
    operationId,
    ...actor(kind),
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

async function installPolicies(
  current: Fixture,
  learningLimit = 64,
  revision = 1,
  maximumTreatmentDelta = 1,
  minimumExposures = 10,
) {
  const compilerPayload = buildContinuationCompilerPolicyV1({
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    candidate_limit: 64 + learningLimit,
    continuity_candidate_limit: 64,
    learning_candidate_limit: learningLimit,
    selected_capsule_limit: 64,
    obligation_limit: 64,
    max_render_budget: 65_536,
    hard_coverage_weight: 1_000_000,
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [HOST],
      external_verifier: [WORKER],
    },
  });
  const evidencePayload = buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    trusted_effect_verifier_principals: [principalForEffectVerifier()],
    max_eligible_decisions: 256,
    max_treatment_delta_count: maximumTreatmentDelta,
    min_evidence_window_ms: 60_000,
    max_evidence_window_ms: 86_400_000,
    min_control_exposures: minimumExposures,
    min_candidate_exposures: minimumExposures,
    max_missingness_bps: 1_000,
    harm_noninferiority_margin_bps: 0,
    utility_min_lift_bps: 1,
    confidence_bps: 9_000,
    effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  });
  const compiler = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "compiler-policy",
    artifact_revision: revision,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: compilerPayload,
    valid_from: at(7),
    expires_at: null,
    created_at: at(7),
  }, ROOT_KEYS.privateKey);
  const evidence = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "evidence-policy",
    artifact_revision: revision,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: evidencePayload,
    valid_from: at(7),
    expires_at: at(12),
    created_at: at(7),
  }, ROOT_KEYS.privateKey);
  await operation(current, "authority_decision", revision === 1
    ? "install-policy-bundle"
    : `install-policy-bundle-${revision}`, (context) =>
    current.artifactProvisioner.putBundle(context, {
      schema_version: "authority_policy_provisioning_bundle_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      compiler_policy: compiler,
      evidence_policy: evidence,
    }));
  return { compiler, evidence, compilerPayload, evidencePayload };
}

function candidateCapsuleDraft(capsuleId = "candidate-procedure") {
  return {
    capsule_id: capsuleId,
    kind: "procedure" as const,
    proposed_influence: "inspect" as const,
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
      summary: "Inspect candidate procedure",
      next_action: "Inspect exact state",
      target_refs: [{ kind: "memory" as const, ref: "candidate-state" }],
      workflow_steps: ["inspect", "verify"],
      acceptance_statements: ["candidate state verified"],
    },
    coverage_claims: [{
      obligation_kind: "required_state" as const,
      target_refs: [{ kind: "memory" as const, ref: "candidate-state" }],
      evidence_requirement: "runtime_state" as const,
      required_probe_ids: [],
    }],
    precondition_specs: [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: [],
    supersedes: [],
    expires_at: null,
  };
}

async function seedLearningPair(
  current: Fixture,
  learningLimit = 64,
  targets: readonly ("shadow" | "eligible" | "active_candidate")[] = [
    "shadow", "eligible", "active_candidate",
  ],
  candidateCount = 1,
  minimumExposures = 10,
) {
  const policies = await installPolicies(
    current,
    learningLimit,
    1,
    candidateCount,
    minimumExposures,
  );
  current.clock.value = at(8, 5);
  const seeded = await operation(current, "record_observations", "seed-learning", async (context) => {
    await current.observations.put(context, {
      host_task_envelope: {
        host_task_id: "seed-task",
        episode_id: "seed-episode",
        run_id: "seed-run",
        consumer_agent_id: "seed-agent",
        consumer_team_id: null,
        task_family: FAMILY,
        task_signature: "seed-signature",
        workflow_signature: null,
        workspace_signature: "seed-workspace",
        source_task_sha256: "4".repeat(64),
        source_event_sha256: "5".repeat(64),
        issued_at: at(8),
        expires_at: at(12),
      },
      collector_observations: [],
      signed_observations: [],
    });
    const memory = await current.memory.appendMemoryRevision(context, {
      expected_head_revision: null,
      items: Array.from({ length: candidateCount }, (_, index) => ({
        memory_id: `candidate-memory-${index}`,
        memory_kind: "procedure",
        lifecycle: "active",
        authority: "candidate",
        hydrated: true,
        projection: { source: "candidate" },
        rehydration_ref: null,
        expires_at: null,
      })),
      relations: [],
      capsules: Array.from({ length: candidateCount }, (_, index) => ({
        memory_id: `candidate-memory-${index}`,
        draft: candidateCapsuleDraft(`candidate-procedure-${index}`),
      })),
    });
    const genesis = await current.authority.ensureGenesis(context);
    const candidate = await current.authority.createIsolatedCandidateDraft(context, {
      expected_head_revision: genesis.head.head_revision,
      expected_head_sha256: genesis.head.head_sha256,
    });
    assert.ok(candidate);
    return { memory, genesis, candidate };
  });
  let candidate = seeded.candidate;
  for (const [index, target] of targets.entries()) {
    current.clock.value = at(8, 10 + index);
    candidate = await operation(
      current,
      "authority_decision",
      `candidate-${target}`,
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(candidate.revision.manifest),
        target_state: target,
        reason_codes: ["verified_offline_evidence"],
        evidence_sha256s: [canonicalContinuationSha256({ target })],
        expected_head_revision: seeded.genesis.head.head_revision,
        expected_head_sha256: seeded.genesis.head.head_sha256,
      }),
    );
  }
  return {
    policies,
    memory: seeded.memory,
    control: seeded.genesis.revision.manifest,
    candidate: candidate.revision.manifest,
    head: seeded.genesis.head,
  };
}

async function appendDetachedCandidateCapsule(current: Fixture) {
  current.clock.value = at(8, 20);
  return operation(
    current,
    "record_observations",
    "detached-overflow-capsule",
    async (context) => {
      await current.observations.put(context, {
        host_task_envelope: {
          host_task_id: "detached-overflow-task",
          episode_id: "detached-overflow-episode",
          run_id: "detached-overflow-run",
          consumer_agent_id: "effect-test-agent",
          consumer_team_id: null,
          task_family: FAMILY,
          task_signature: "effect-signature",
          workflow_signature: null,
          workspace_signature: "effect-workspace",
          source_task_sha256: "6".repeat(64),
          source_event_sha256: "7".repeat(64),
          issued_at: at(8, 19),
          expires_at: at(12),
        },
        collector_observations: [],
        signed_observations: [],
      });
      const head = await current.memory.readHead(TENANT, SCOPE);
      const revision = await current.memory.appendMemoryRevision(context, {
        expected_head_revision: head!.head_revision,
        items: [{
          memory_id: "detached-overflow-memory",
          memory_kind: "procedure",
          lifecycle: "active",
          authority: "candidate",
          hydrated: true,
          projection: { source: "detached-overflow" },
          rehydration_ref: null,
          expires_at: null,
        }],
        relations: [],
        capsules: [{
          memory_id: "detached-overflow-memory",
          draft: candidateCapsuleDraft("detached-overflow-procedure"),
        }],
      });
      return revision.capsules[0]!;
    },
  );
}

function insertCorruptOverflowBinding(
  current: Fixture,
  candidate: AuthorityBranchManifestV1,
  capsule: Readonly<{
    capsule_id: string;
    capsule_revision: number;
    capsule_sha256: string;
  }>,
): void {
  const binding = {
    capsule_scope: SCOPE,
    capsule: {
      capsule_id: capsule.capsule_id,
      capsule_revision: capsule.capsule_revision,
      capsule_sha256: capsule.capsule_sha256,
    },
    disposition: "include" as const,
    admission_authority: "candidate" as const,
  };
  const bindingSha256 = canonicalContinuationSha256({
    schema_version: "authority_branch_capsule_binding_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    branch: fullBranchRef(candidate),
    binding,
    created_at: candidate.created_at,
  });
  current.database.db.prepare(`INSERT INTO branch_capsule_bindings(
      tenant_id, authority_subject_sha256, branch_id, branch_revision,
      branch_manifest_sha256, branch_kind, capsule_scope, capsule_id,
      capsule_revision, capsule_sha256, disposition, admission_authority,
      binding_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    TENANT,
    SUBJECT,
    candidate.branch_id,
    candidate.branch_revision,
    candidate.manifest_sha256,
    candidate.branch_kind,
    binding.capsule_scope,
    binding.capsule.capsule_id,
    binding.capsule.capsule_revision,
    binding.capsule.capsule_sha256,
    binding.disposition,
    binding.admission_authority,
    bindingSha256,
    candidate.created_at,
  );
}

async function installCohort(
  current: Fixture,
  seeded: Awaited<ReturnType<typeof seedLearningPair>>,
  installedAt = at(8, 40),
) {
  const cohort = buildExperimentCohortV1({
    schema_version: "experiment_cohort_v1",
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: FAMILY,
    cohort_id: "cohort-main",
    authority_subject_sha256: SUBJECT,
    control_learning_ref: fullBranchRef(seeded.control) as
      ExperimentCohortV1["control_learning_ref"],
    candidate_learning_ref: fullBranchRef(seeded.candidate) as
      ExperimentCohortV1["candidate_learning_ref"],
    compiler_policy_ref: {
      artifact_sha256: seeded.policies.compiler.artifact_sha256,
      payload_sha256: seeded.policies.compiler.payload_sha256,
    },
    evidence_policy_ref: {
      artifact_sha256: seeded.policies.evidence.artifact_sha256,
      payload_sha256: seeded.policies.evidence.payload_sha256,
    },
    eligibility: { host_principal_sha256s: [HOST] },
    assignment_protocol: {
      algorithm: "hmac_sha256_threshold_v1",
      algorithm_contract_sha256:
        EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
      assignment_seed_commitment_sha256:
        assignmentSeedCommitmentSha256V1(ASSIGNMENT_SEED),
      basis_schema: "serving_assignment_basis_v1",
      candidate_allocation_bps: 5_000,
    },
    assignment_window_opened_at: at(9),
    assignment_window_closed_at: at(10),
    outcome_deadline: at(10, 30),
    settlement_grace_ms: 30 * 60 * 1_000,
    settlement_cutoff_at: at(11),
  });
  const artifact = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "experiment-cohort-main",
    artifact_revision: 1,
    artifact_kind: "experiment_cohort",
    artifact_schema: "experiment_cohort_v1",
    authority_subject_sha256: SUBJECT,
    payload: cohort,
    valid_from: at(8, 30),
    expires_at: at(12),
    created_at: at(8, 30),
  }, ROOT_KEYS.privateKey);
  current.clock.value = installedAt;
  await operation(current, "authority_decision", "install-cohort", (context) =>
    current.artifactProvisioner.putExperimentCohort(context, artifact, ASSIGNMENT_SEED));
  const receipt = await current.operations.read({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "authority_decision",
    operationId: "install-cohort",
  });
  assert.ok(receipt);
  return {
    cohort,
    artifact,
    ref: {
      artifact_sha256: artifact.artifact_sha256,
      payload_sha256: artifact.payload_sha256,
    },
    installationReceiptSha256: receipt.receipt_sha256,
  };
}

async function appendAssignedEvidence(current: Fixture, minimumExposures = 10) {
  const members: EffectEvidenceMemberInputV1[] = [];
  const counts = { control: 0, candidate: 0 };
  const observations = {
    control: {
      assigned_exposure_count: 0,
      succeeded_count: 0,
      partial_count: 0,
      failed_count: 0,
      unknown_count: 0,
      missing_outcome_count: 0,
    },
    candidate: {
      assigned_exposure_count: 0,
      succeeded_count: 0,
      partial_count: 0,
      failed_count: 0,
      unknown_count: 0,
      missing_outcome_count: 0,
    },
  };
  let cutoffCases = 0;
  for (let index = 0; index < 50; index += 1) {
    const thresholdMet = counts.control >= minimumExposures
      && counts.candidate >= minimumExposures;
    if (thresholdMet && cutoffCases >= 2) break;
    const cutoffCase = thresholdMet
      ? cutoffCases === 0 ? "exact" as const : "late" as const
      : null;
    const decisionId = `decision-${index.toString().padStart(3, "0")}`;
    const episodeId = `episode-${index.toString().padStart(3, "0")}`;
    const assignedAt = plus(at(9), index * 60_000);
    current.clock.value = plus(assignedAt, -1_000);
    const snapshot = await operation(
      current,
      "record_observations",
      `snapshot-${index.toString().padStart(3, "0")}`,
      (context) => current.observations.put(context, {
        host_task_envelope: {
          host_task_id: `task-${index}`,
          episode_id: episodeId,
          run_id: `run-${index}`,
          consumer_agent_id: "effect-test-agent",
          consumer_team_id: null,
          task_family: FAMILY,
          task_signature: "effect-signature",
          workflow_signature: null,
          workspace_signature: "effect-workspace",
          source_task_sha256: canonicalContinuationSha256({ index, kind: "task" }),
          source_event_sha256: canonicalContinuationSha256({ index, kind: "event" }),
          issued_at: plus(assignedAt, -2_000),
          expires_at: at(10, 30),
        },
        collector_observations: [],
        signed_observations: [],
      }),
    );
    current.clock.value = assignedAt;
    await operation(current, "create_continuation", decisionId, async (context) => {
      const capability = await current.assembly.assemble(context, {
        world_snapshot_ref: {
          world_snapshot_id: snapshot.snapshot.world_snapshot_id,
          world_snapshot_sha256: snapshot.snapshot.world_snapshot_sha256,
        },
        obligations: [],
        render_budget: 65_536,
      });
      return current.episode.appendExposure(context, capability);
    });
    const exposed = await current.episode.readDecision(TENANT, SCOPE, decisionId);
    const exposure = exposed[0]!;
    assert.equal(exposure.payload.payload_kind, "contract_exposed_v1");
    if (exposure.payload.payload_kind !== "contract_exposed_v1") {
      throw new Error("expected contract exposure");
    }
    const contract = exposure.payload.continuation_contract as unknown as
      ContinuationContractV1;
    const arm = contract.authority.serving_assignment_receipt?.arm;
    assert.ok(arm === "control" || arm === "candidate");
    counts[arm] += 1;
    observations[arm].assigned_exposure_count += 1;
    const appendOutcome = () => operation(
      current,
      "record_outcome",
      `outcome-${index.toString().padStart(3, "0")}`,
      (context) => current.episode.appendOutcomeBundle(context, {
        decision_id: decisionId,
        use_receipt: {
          schema_version: "host_capsule_use_receipt_v1",
          decision_id: decisionId,
          use_id: `use-${index}`,
          observed_at: cutoffCase === null
            ? plus(assignedAt, 100)
            : "2026-07-22T10:29:59.999Z",
          render_result_sha256: exposure.render_result_sha256,
          capsule_uses: contract.selected_capsules.map((selection) => ({
            capsule_scope: SCOPE,
            capsule_id: selection.capsule.capsule_id,
            capsule_revision: selection.capsule.capsule_revision,
            capsule_sha256: selection.capsule.capsule_sha256,
            surface: selection.surface,
            use_state: "used" as const,
          })),
          evidence_sha256: canonicalContinuationSha256({ decisionId, kind: "use" }),
        },
        outcome_receipt: {
          schema_version: "host_outcome_receipt_v1",
          decision_id: decisionId,
          observed_at: cutoffCase === null
            ? plus(assignedAt, 200)
            : "2026-07-22T10:30:00.000Z",
          outcome: arm === "candidate" ? "succeeded" : "failed",
          outcome_code: arm === "candidate" ? "verified_success" : "verified_failure",
          evidence_sha256: canonicalContinuationSha256({ decisionId, kind: "outcome" }),
          summary: `verified ${arm} outcome`,
        },
      }),
    );
    let terminal: EpisodeEventRefV1 & {
      event_kind: "contract_exposed" | "outcome_observed";
    };
    if (cutoffCase === "late") {
      current.clock.value = "2026-07-22T11:00:00.001Z";
      await assert.rejects(appendOutcome(), /settlement_cutoff|completion_deadline/u);
      assert.equal((await current.episode.readDecision(
        TENANT,
        SCOPE,
        decisionId,
      )).length, 1);
      terminal = {
        event_sequence: exposure.event_sequence,
        event_id: exposure.event_id,
        event_kind: "contract_exposed",
        event_sha256: exposure.event_sha256,
      };
      observations[arm].missing_outcome_count += 1;
    } else {
      current.clock.value = cutoffCase === "exact"
        ? "2026-07-22T11:00:00.000Z"
        : plus(assignedAt, 300);
      const outcome = await appendOutcome();
      const outcomeRef = outcome.event_refs.at(-1)!;
      assert.equal(outcomeRef.event_kind, "outcome_observed");
      terminal = outcomeRef as EpisodeEventRefV1 & {
        event_kind: "outcome_observed";
      };
      if (arm === "candidate") observations.candidate.succeeded_count += 1;
      else observations.control.failed_count += 1;
    }
    members.push({
      scope: SCOPE,
      episode_id: episodeId,
      decision_id: decisionId,
      terminal_event: terminal,
    });
    if (cutoffCase !== null) cutoffCases += 1;
  }
  assert.ok(counts.control >= minimumExposures
    && counts.candidate >= minimumExposures);
  assert.equal(cutoffCases, 2);
  return {
    memberSet: buildEffectEvidenceMemberSetV1(members),
    counts,
    observations,
  };
}

function exactTreatmentDelta(
  seeded: Awaited<ReturnType<typeof seedLearningPair>>,
): EffectTreatmentDeltaSetV1 {
  const controlByIdentity = new Map(seeded.control.capsule_bindings.map((binding) => [
    `${binding.capsule_scope}\0${binding.capsule.capsule_id}`,
    binding,
  ]));
  const candidateByIdentity = new Map(seeded.candidate.capsule_bindings.map((binding) => [
    `${binding.capsule_scope}\0${binding.capsule.capsule_id}`,
    binding,
  ]));
  const identities = [...new Set([
    ...controlByIdentity.keys(),
    ...candidateByIdentity.keys(),
  ])];
  return buildEffectTreatmentDeltaSetV1(identities.flatMap((identity) => {
    const before = controlByIdentity.get(identity) ?? null;
    const after = candidateByIdentity.get(identity) ?? null;
    if (canonicalContinuationSha256(before) === canonicalContinuationSha256(after)) {
      return [];
    }
    const binding = after ?? before!;
    return [{
      capsule_scope: binding.capsule_scope,
      capsule_id: binding.capsule.capsule_id,
      change_kind: before === null ? "added" as const
        : after === null ? "removed" as const : "changed" as const,
      before_binding: before,
      after_binding: after,
    }];
  }));
}

async function certificatePackage(
  current: Fixture,
  seeded: Awaited<ReturnType<typeof seedLearningPair>>,
  installed: Awaited<ReturnType<typeof installCohort>>,
  evidence: Awaited<ReturnType<typeof appendAssignedEvidence>>,
  certificateId: string,
  treatmentDelta = exactTreatmentDelta(seeded),
) {
  const policy = await current.policies.resolveExact({
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    artifact_kind: "evidence_policy",
    artifact_ref: installed.cohort.evidence_policy_ref,
    at: installed.cohort.assignment_window_opened_at,
  });
  const signedCertificate = buildSignedEffectCertificateV1({
    tenant_id: TENANT,
    certificate_id: certificateId,
    experiment_cohort_ref: installed.ref,
    experiment_cohort: installed.cohort,
    experiment_cohort_installation_receipt_sha256:
      installed.installationReceiptSha256,
    assignment_seed_reveal_base64url: ASSIGNMENT_SEED.toString("base64url"),
    evidence_policy: current.policies.evidenceBinding(policy),
    eligible_decision_set: evidence.memberSet,
    arm_observations: evidence.observations,
    treatment_delta_set: treatmentDelta,
    created_at: installed.cohort.settlement_cutoff_at,
  }, EFFECT_KEYS.privateKey);
  return {
    signed_certificate: signedCertificate,
    eligible_decision_set: evidence.memberSet,
    treatment_delta_set: treatmentDelta,
    evidence_policy: policy,
  };
}

test("effect writer settles atomically and the isolated reader verifies the result", async () => {
  const current = fixture();
  try {
    assertContinuationRuntimeV1EffectCertificateReader(
      current.effectReader,
      current.database,
      current.artifacts,
      current.policies,
    );
    assertContinuationRuntimeV1EffectCertificateWriter(
      current.effectWriter,
      current.database,
      current.artifacts,
      current.policies,
    );
    assert.deepEqual(Object.keys(current.effectReader), ["read"]);
    assert.deepEqual(Object.keys(current.effectWriter), ["put"]);
    const seeded = await seedLearningPair(
      current,
      64,
      ["shadow", "eligible", "active_candidate"],
      2,
    );
    const installed = await installCohort(current, seeded);
    const queued = current.database.db.prepare(`SELECT state, job_kind, available_at
      FROM durable_jobs`).all() as Array<Record<string, unknown>>;
    assert.deepEqual(queued.map((row) => ({ ...row })), [{
      state: "queued",
      job_kind: "effect",
      available_at: installed.cohort.settlement_cutoff_at,
    }]);
    const evidence = await appendAssignedEvidence(current);
    const treatment = exactTreatmentDelta(seeded);
    assert.equal(treatment.treatment_delta_count, 2);
    assert.equal(treatment.members[0]?.change_kind, "added");

    current.clock.value = installed.cohort.settlement_cutoff_at;
    const lease = await current.jobs.leaseNext({
      tenant_id: TENANT,
      job_kind: "effect",
      lease_owner: "effect-verifier-worker",
      lease_duration_ms: 60_000,
    });
    assert.ok(lease?.lease_token);

    const bad = await certificatePackage(
      current,
      seeded,
      installed,
      evidence,
      "effect-bad-delta",
      buildEffectTreatmentDeltaSetV1([]),
    );
    await assert.rejects(operation(
      current,
      "worker_completion",
      "effect-bad-delta",
      (context) => current.effectWriter.put(context, bad),
    ), /treatment_delta/u);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificates",
    ).get()?.count, 0);

    const packageValue = await certificatePackage(
      current,
      seeded,
      installed,
      evidence,
      "effect-main",
    );
    assert.equal(packageValue.signed_certificate.admission_state, "admitted");
    const persisted = await operation(
      current,
      "worker_completion",
      "effect-complete",
      async (context) => {
        const result = await current.effectWriter.put(context, packageValue);
        await current.jobs.complete(context, {
          job_id: lease.job_id,
          lease_token: lease.lease_token!,
        });
        return result;
      },
    );
    assert.equal(persisted.treatment_delta_count, 2);
    assert.equal(persisted.eligible_decision_count,
      evidence.memberSet.eligible_decision_count);
    const read = await current.effectReader.read({
      tenant_id: TENANT,
      certificate_sha256: persisted.certificate_sha256,
    });
    assert.deepEqual(read?.record.treatment_delta_set, treatment);
    assert.deepEqual(read?.record.eligible_decision_set, evidence.memberSet);
    assert.ok(read?.admitted_capability);
    assertVerifiedAdmittedEffectCertificateCapabilityV1(
      read!.admitted_capability,
      current.database,
      {
        tenant_id: TENANT,
        authority_subject_sha256: SUBJECT,
        certificate_sha256: persisted.certificate_sha256,
      },
    );
    assert.equal(projectVerifiedAdmittedEffectCertificateCapabilityV1(
      read!.admitted_capability!,
      current.database,
    ).treatment_delta_set_sha256, treatment.treatment_delta_set_sha256);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificate_treatment_members",
    ).get()?.count, 2);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM durable_jobs WHERE state='succeeded'",
    ).get()?.count, 1);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='effect_certificate_capsule_claims'",
    ).get()?.count, 0);

    const merged = await operation(
      current,
      "authority_decision",
      "merge-admitted-candidate",
      (context) => current.authority.mergeCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(seeded.candidate),
        effect_certificate_sha256: persisted.certificate_sha256,
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    );
    assert.equal(
      merged.authoritative_revision.manifest.capsule_bindings.length,
      2,
    );
    const smaller = await installPolicies(current, 1, 2, 1);
    const rotationPayload = buildPolicyRotationPayloadV1({
      schema_version: "policy_rotation_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      previous_authoritative_ref: fullBranchRef(
        merged.authoritative_revision.manifest,
      ) as ExperimentCohortV1["control_learning_ref"],
      old_compiler_policy_ref:
        merged.authoritative_revision.manifest.compiler_policy_ref,
      new_compiler_policy_ref: {
        artifact_sha256: smaller.compiler.artifact_sha256,
        payload_sha256: smaller.compiler.payload_sha256,
      },
      old_evidence_policy_ref:
        merged.authoritative_revision.manifest.evidence_policy_ref,
      new_evidence_policy_ref: {
        artifact_sha256: smaller.evidence.artifact_sha256,
        payload_sha256: smaller.evidence.payload_sha256,
      },
      previous_binding_set_sha256: authorityBranchBindingSetSha256V1(
        merged.authoritative_revision.manifest.capsule_bindings,
      ),
    });
    const rotationArtifact = buildSignedAuthorityArtifactV1({
      tenant_id: TENANT,
      artifact_id: "capacity-lowering-rotation",
      artifact_revision: 1,
      artifact_kind: "policy_rotation",
      artifact_schema: "policy_rotation_v1",
      authority_subject_sha256: SUBJECT,
      payload: rotationPayload,
      valid_from: at(7),
      expires_at: null,
      created_at: at(7),
    }, ROOT_KEYS.privateKey);
    await operation(
      current,
      "authority_decision",
      "install-capacity-lowering-rotation",
      (context) => current.artifactProvisioner.put(context, rotationArtifact),
    );
    const beforeRotationBranches = current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM branch_revisions",
    ).get()?.count;
    await assert.rejects(operation(
      current,
      "authority_decision",
      "reject-capacity-lowering-rotation",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: {
          artifact_sha256: rotationArtifact.artifact_sha256,
          payload_sha256: rotationArtifact.payload_sha256,
        },
        expected_head_revision: merged.head.head_revision,
        expected_head_sha256: merged.head.head_sha256,
      }),
    ), /policy_rotation_learning_capacity_exceeded|compiler policy capacity/u);
    assert.equal(current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM branch_revisions",
    ).get()?.count, beforeRotationBranches);
    assert.equal((await current.authority.readHead({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
    }))?.head_sha256, merged.head.head_sha256);
    assert.equal(await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: "reject-capacity-lowering-rotation",
    }), null);

    current.database.db.exec(`DROP TRIGGER effect_certificate_treatment_members_no_update;
      UPDATE effect_certificate_treatment_members
      SET member_sha256 = '${"f".repeat(64)}'
      WHERE rowid = (
        SELECT MIN(rowid)
        FROM effect_certificate_treatment_members
      )`);
    await assert.rejects(current.effectReader.read({
      tenant_id: TENANT,
      certificate_sha256: persisted.certificate_sha256,
    }), /treatment_delta/u);
  } finally {
    await current.database.close();
  }
});

test("cohort install and every resolve reject an over-capacity frozen learning pair", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current, 1);
    const overflowCapsule = await appendDetachedCandidateCapsule(current);
    current.database.db.exec(`
      DROP TRIGGER branch_capsule_bindings_learning_capacity_guard;
      DROP TRIGGER branch_capsule_bindings_source_operation_fence;
      DROP TRIGGER branch_capsule_bindings_no_delete;
    `);
    insertCorruptOverflowBinding(current, seeded.candidate, overflowCapsule);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_capsule_bindings
      WHERE tenant_id = ? AND authority_subject_sha256 = ?
        AND branch_id = ? AND branch_revision = ?`).get(
      TENANT,
      SUBJECT,
      seeded.candidate.branch_id,
      seeded.candidate.branch_revision,
    )?.count, 2);

    await assert.rejects(
      installCohort(current, seeded),
      /experiment_cohort_learning_pair_invalid|learning pair exceeds/u,
    );
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM authority_artifacts WHERE artifact_kind = 'experiment_cohort'`).get()?.count, 0);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM durable_jobs WHERE job_kind = 'effect'`).get()?.count, 0);

    current.database.db.prepare(`DELETE FROM branch_capsule_bindings
      WHERE tenant_id = ? AND authority_subject_sha256 = ?
        AND branch_id = ? AND branch_revision = ? AND capsule_id = ?`).run(
      TENANT,
      SUBJECT,
      seeded.candidate.branch_id,
      seeded.candidate.branch_revision,
      overflowCapsule.capsule_id,
    );
    const installed = await installCohort(current, seeded);
    insertCorruptOverflowBinding(current, seeded.candidate, overflowCapsule);
    await assert.rejects(current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: installed.cohort.assignment_window_opened_at,
    }), /learning_pair_or_policy_drift/u);
  } finally {
    await current.database.close();
  }
});

test("over-capacity draft cannot advance to eligible and rolls back atomically", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current, 1, ["shadow"], 2);
    assert.equal(seeded.candidate.state, "shadow");
    const before = current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count;
    current.clock.value = at(8, 15);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "over-capacity-eligible",
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(seeded.candidate),
        target_state: "eligible",
        reason_codes: ["offline_evidence_ready"],
        evidence_sha256s: ["f".repeat(64)],
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /learning_branch_capacity_exceeded|compiler policy capacity/u);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count, before);
    assert.equal(await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: "over-capacity-eligible",
    }), null);
  } finally {
    await current.database.close();
  }
});

test("merge refuses a tampered over-capacity active candidate atomically", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current, 1);
    const secondCapsule = await appendDetachedCandidateCapsule(current);
    current.database.db.exec(`
      DROP TRIGGER branch_capsule_bindings_learning_capacity_guard;
      DROP TRIGGER branch_capsule_bindings_source_operation_fence;
    `);
    insertCorruptOverflowBinding(current, seeded.candidate, secondCapsule);
    const before = current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count;
    current.clock.value = at(8, 30);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "over-capacity-merge",
      (context) => current.authority.mergeCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(seeded.candidate),
        effect_certificate_sha256: "e".repeat(64),
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /corrupt|capacity|binding/u);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count, before);
    assert.equal(await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: "over-capacity-merge",
    }), null);
  } finally {
    await current.database.close();
  }
});

test("cohort installation completion is atomically fenced before window open", async () => {
  const late = fixture();
  const exact = fixture();
  try {
    const latePair = await seedLearningPair(late);
    await assert.rejects(
      installCohort(late, latePair, at(9)),
      /completion_deadline|must be installed before its window/u,
    );
    assert.equal(late.database.db.prepare(`SELECT COUNT(*) AS count
      FROM authority_artifacts WHERE artifact_kind = 'experiment_cohort'`).get()?.count, 0);
    assert.equal(late.database.db.prepare(`SELECT COUNT(*) AS count
      FROM durable_jobs WHERE job_kind = 'effect'`).get()?.count, 0);
    assert.equal(await late.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: "install-cohort",
    }), null);

    const exactPair = await seedLearningPair(exact);
    const installed = await installCohort(
      exact,
      exactPair,
      "2026-07-22T08:59:59.999Z",
    );
    const receipt = await exact.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "authority_decision",
      operationId: "install-cohort",
    });
    assert.equal(receipt?.receipt.completed_at, "2026-07-22T08:59:59.999Z");
    assert.equal(installed.cohort.assignment_window_opened_at, at(9));
  } finally {
    await late.database.close();
    await exact.database.close();
  }
});

test("cohort rejects zero treatment at install and resolve boundaries", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current);
    current.database.db.exec(`
      DROP TRIGGER branch_capsule_bindings_learning_capacity_guard;
      DROP TRIGGER branch_capsule_bindings_source_operation_fence;
      DROP TRIGGER branch_capsule_bindings_no_delete;
    `);
    const removeCandidateBinding = () => current.database.db.prepare(`DELETE
      FROM branch_capsule_bindings
      WHERE tenant_id = ? AND authority_subject_sha256 = ?
        AND branch_id = ? AND branch_revision = ?`).run(
      TENANT,
      SUBJECT,
      seeded.candidate.branch_id,
      seeded.candidate.branch_revision,
    );
    removeCandidateBinding();
    await assert.rejects(
      installCohort(current, seeded),
      /treatment_delta_invalid|frozen policy/u,
    );
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM authority_artifacts WHERE artifact_kind = 'experiment_cohort'`).get()?.count, 0);
    insertCorruptOverflowBinding(
      current,
      seeded.candidate,
      seeded.memory.capsules[0]!,
    );
    const installed = await installCohort(current, seeded);
    removeCandidateBinding();
    await assert.rejects(current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: installed.cohort.assignment_window_opened_at,
    }), /treatment_delta_outside_frozen_policy/u);
  } finally {
    await current.database.close();
  }
});

test("cohort rejects treatment delta above frozen evidence policy atomically", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current);
    const secondCapsule = await appendDetachedCandidateCapsule(current);
    current.database.db.exec(`
      DROP TRIGGER branch_capsule_bindings_learning_capacity_guard;
      DROP TRIGGER branch_capsule_bindings_source_operation_fence;
      DROP TRIGGER branch_capsule_bindings_no_delete;
    `);
    insertCorruptOverflowBinding(current, seeded.candidate, secondCapsule);
    await assert.rejects(
      installCohort(current, seeded),
      /treatment_delta_invalid|frozen policy/u,
    );
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM authority_artifacts WHERE artifact_kind = 'experiment_cohort'`).get()?.count, 0);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM durable_jobs WHERE job_kind = 'effect'`).get()?.count, 0);
    current.database.db.prepare(`DELETE FROM branch_capsule_bindings
      WHERE tenant_id = ? AND authority_subject_sha256 = ?
        AND branch_id = ? AND branch_revision = ? AND capsule_id = ?`).run(
      TENANT,
      SUBJECT,
      seeded.candidate.branch_id,
      seeded.candidate.branch_revision,
      secondCapsule.capsule_id,
    );
    const installed = await installCohort(current, seeded);
    insertCorruptOverflowBinding(current, seeded.candidate, secondCapsule);
    await assert.rejects(current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: installed.cohort.assignment_window_opened_at,
    }), /treatment_delta_outside_frozen_policy/u);
  } finally {
    await current.database.close();
  }
});

test("active cohort freezes its pair while break-glass abort preserves settlement", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current);
    const installed = await installCohort(current, seeded);
    current.clock.value = at(8, 45);
    const replacement = await installPolicies(current, 64, 2);
    const rotationPayload = buildPolicyRotationPayloadV1({
      schema_version: "policy_rotation_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      previous_authoritative_ref: fullBranchRef(seeded.control) as
        ExperimentCohortV1["control_learning_ref"],
      old_compiler_policy_ref: seeded.control.compiler_policy_ref,
      new_compiler_policy_ref: {
        artifact_sha256: replacement.compiler.artifact_sha256,
        payload_sha256: replacement.compiler.payload_sha256,
      },
      old_evidence_policy_ref: seeded.control.evidence_policy_ref,
      new_evidence_policy_ref: {
        artifact_sha256: replacement.evidence.artifact_sha256,
        payload_sha256: replacement.evidence.payload_sha256,
      },
      previous_binding_set_sha256: authorityBranchBindingSetSha256V1(
        seeded.control.capsule_bindings,
      ),
    });
    const rotationArtifact = buildSignedAuthorityArtifactV1({
      tenant_id: TENANT,
      artifact_id: "policy-rotation-after-cohort",
      artifact_revision: 1,
      artifact_kind: "policy_rotation",
      artifact_schema: "policy_rotation_v1",
      authority_subject_sha256: SUBJECT,
      payload: rotationPayload,
      valid_from: at(8, 45),
      expires_at: null,
      created_at: at(8, 45),
    }, ROOT_KEYS.privateKey);
    await operation(
      current,
      "authority_decision",
      "install-policy-rotation-after-cohort",
      (context) => current.artifactProvisioner.put(context, rotationArtifact),
    );
    const rotationRef = {
      artifact_sha256: rotationArtifact.artifact_sha256,
      payload_sha256: rotationArtifact.payload_sha256,
    };
    current.clock.value = at(9, 4);
    const unrelatedDraft = await operation(
      current,
      "record_observations",
      "unrelated-draft-during-cohort",
      async (context) => {
        await current.observations.put(context, {
          host_task_envelope: {
            host_task_id: "unrelated-draft-task",
            episode_id: "unrelated-draft-episode",
            run_id: "unrelated-draft-run",
            consumer_agent_id: "effect-test-agent",
            consumer_team_id: null,
            task_family: FAMILY,
            task_signature: "unrelated-draft-signature",
            workflow_signature: null,
            workspace_signature: "effect-workspace",
            source_task_sha256: "0".repeat(64),
            source_event_sha256: "1".repeat(64),
            issued_at: at(9, 3),
            expires_at: at(12),
          },
          collector_observations: [],
          signed_observations: [],
        });
        const memoryHead = await current.memory.readHead(TENANT, SCOPE);
        await current.memory.appendMemoryRevision(context, {
          expected_head_revision: memoryHead!.head_revision,
          items: [{
            memory_id: "unrelated-draft-memory",
            memory_kind: "procedure",
            lifecycle: "active",
            authority: "candidate",
            hydrated: true,
            projection: { source: "unrelated-draft" },
            rehydration_ref: null,
            expires_at: null,
          }],
          relations: [],
          capsules: [{
            memory_id: "unrelated-draft-memory",
            draft: candidateCapsuleDraft("unrelated-draft-procedure"),
          }],
        });
        return current.authority.createIsolatedCandidateDraft(context, {
          expected_head_revision: seeded.head.head_revision,
          expected_head_sha256: seeded.head.head_sha256,
        });
      },
    );
    assert.equal(unrelatedDraft?.revision.manifest.state, "draft");
    assert.equal(unrelatedDraft?.head.head_sha256, seeded.head.head_sha256);
    const beforeRevisionCount = current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count;

    current.clock.value = at(9, 5);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "frozen-merge",
      (context) => current.authority.mergeCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(seeded.candidate),
        effect_certificate_sha256: "8".repeat(64),
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /cohort_freeze_head_mutation_frozen|active experiment cohort freezes/u);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "frozen-revert",
      (context) => current.authority.revertAuthority(context, {
        authority_subject_sha256: SUBJECT,
        revert_to_authority_ref: branchRef(seeded.control),
        reason_codes: ["operator_recovery"],
        evidence_sha256s: ["9".repeat(64)],
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /cohort_freeze_head_mutation_frozen|active experiment cohort freezes/u);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "frozen-rotation",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: rotationRef,
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /cohort_freeze_head_mutation_frozen|active experiment cohort freezes/u);
    assert.equal(current.database.db.prepare(`SELECT COUNT(*) AS count
      FROM branch_revisions`).get()?.count, beforeRevisionCount);
    for (const operationId of ["frozen-merge", "frozen-revert", "frozen-rotation"]) {
      assert.equal(await current.operations.read({
        tenantId: TENANT,
        scope: SCOPE,
        operationKind: "authority_decision",
        operationId,
      }), null);
    }

    const exactCapability = await current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: at(9, 6),
    });
    const memoryHead = await current.memory.readHead(TENANT, SCOPE);
    const assignment = current.cohorts.deriveAssignment(exactCapability, {
      assignment_basis: buildServingAssignmentBasisV1({
        schema_version: "serving_assignment_basis_v1",
        experiment_cohort_ref: installed.ref,
        create_continuation_operation_id: "pre-abort-decision",
        operation_request_sha256: "a".repeat(64),
        decision_id: "pre-abort-decision",
        episode_id: "pre-abort-episode",
        run_id: "pre-abort-run",
        host_task_id: "pre-abort-task",
        host_task_envelope_sha256: "b".repeat(64),
        host_principal_sha256: HOST,
        task_family: FAMILY,
        world_snapshot_ref: {
          world_snapshot_id: "pre-abort-snapshot",
          world_snapshot_sha256: "c".repeat(64),
        },
        memory_scope_head_ref: {
          revision: memoryHead!.head_revision,
          head_sha256: memoryHead!.head_sha256,
        },
      }),
      assigned_at: at(9, 6),
    });

    current.clock.value = at(9, 10);
    const aborted = await operation(
      current,
      "authority_decision",
      "break-glass-quarantine",
      (context) => current.authority.terminateCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(seeded.candidate),
        target_state: "quarantined",
        reason_codes: ["safety_break_glass"],
        evidence_sha256s: ["d".repeat(64)],
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    );
    assert.equal(aborted.revision.manifest.state, "quarantined");
    assert.equal(await current.cohorts.resolveActive({
      tenant_id: TENANT,
      scope: SCOPE,
      authority_subject_sha256: SUBJECT,
      task_family: FAMILY,
      host_principal_sha256: HOST,
      at: at(9, 11),
    }), null);
    const settlementCapability = await current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: assignment.assigned_at,
    });
    assert.deepEqual(current.cohorts.ref(settlementCapability), installed.ref);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "terminal-candidate-cannot-merge",
      (context) => current.authority.mergeCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: branchRef(aborted.revision.manifest),
        effect_certificate_sha256: "e".repeat(64),
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    ), /merge_candidate_not_active/u);

    current.clock.value = at(9, 15);
    const rotated = await operation(
      current,
      "authority_decision",
      "rotation-after-abort",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: rotationRef,
        expected_head_revision: seeded.head.head_revision,
        expected_head_sha256: seeded.head.head_sha256,
      }),
    );
    assert.equal(rotated.head.head_revision, seeded.head.head_revision + 1);
  } finally {
    await current.database.close();
  }
});

test("cohort capabilities never retain the protected assignment seed", async () => {
  const current = fixture();
  try {
    const seeded = await seedLearningPair(current);
    const installed = await installCohort(current, seeded);
    const capability = await current.cohorts.resolveExact({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      experiment_cohort_ref: installed.ref,
      at: at(9, 1),
    });
    const memoryHead = await current.memory.readHead(TENANT, SCOPE);
    assert.ok(memoryHead);
    const basis = buildServingAssignmentBasisV1({
      schema_version: "serving_assignment_basis_v1",
      experiment_cohort_ref: installed.ref,
      create_continuation_operation_id: "seed-hygiene-decision",
      operation_request_sha256: "1".repeat(64),
      decision_id: "seed-hygiene-decision",
      episode_id: "seed-hygiene-episode",
      run_id: "seed-hygiene-run",
      host_task_id: "seed-hygiene-task",
      host_task_envelope_sha256: "2".repeat(64),
      host_principal_sha256: HOST,
      task_family: FAMILY,
      world_snapshot_ref: {
        world_snapshot_id: "seed-hygiene-snapshot",
        world_snapshot_sha256: "3".repeat(64),
      },
      memory_scope_head_ref: {
        revision: memoryHead.head_revision,
        head_sha256: memoryHead.head_sha256,
      },
    });

    current.database.db.exec("DROP TRIGGER authority_artifacts_no_update");
    current.database.db.prepare(`UPDATE authority_artifacts
      SET protected_secret = ?
      WHERE tenant_id = ? AND artifact_sha256 = ? AND payload_sha256 = ?`
    ).run(
      Buffer.alloc(32),
      TENANT,
      installed.ref.artifact_sha256,
      installed.ref.payload_sha256,
    );
    assert.throws(() => current.cohorts.deriveAssignment(capability, {
      assignment_basis: basis,
      assigned_at: at(9, 2),
    }), /protected_seed_commitment_mismatch/u);

    current.database.db.prepare(`UPDATE authority_artifacts
      SET protected_secret = ?
      WHERE tenant_id = ? AND artifact_sha256 = ? AND payload_sha256 = ?`
    ).run(
      ASSIGNMENT_SEED,
      TENANT,
      installed.ref.artifact_sha256,
      installed.ref.payload_sha256,
    );
    const receipt = current.cohorts.deriveAssignment(capability, {
      assignment_basis: basis,
      assigned_at: at(9, 2),
    });
    assert.equal(receipt.experiment_cohort_ref.artifact_sha256,
      installed.ref.artifact_sha256);
  } finally {
    await current.database.close();
  }
});

test("effect package has no caller-owned per-capsule effect conclusion surface", () => {
  const treatment = buildEffectTreatmentDeltaSetV1([]);
  assert.deepEqual(Object.keys(treatment), [
    "members",
    "schema_version",
    "treatment_delta_count",
    "treatment_delta_set_sha256",
  ]);
  assert.equal(JSON.stringify(treatment).includes("effect_claim"), false);
  const forged = {
    signed_certificate: {} as never,
    eligible_decision_set: buildEffectEvidenceMemberSetV1([]),
    treatment_delta_set: treatment,
    evidence_policy: {} as never,
    capsule_claim_set: [],
  } satisfies Record<string, unknown>;
  assert.equal(Object.hasOwn(forged, "capsule_claim_set"), true);
});

function effectSigner(
  keys = EFFECT_KEYS,
): ContinuationRuntimeV1EffectSigner {
  const spki = createPublicKey(keys.privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return Object.freeze({
    privateKey: keys.privateKey,
    principalSha256: createHash("sha256").update(spki).digest("hex"),
    publicKeySpkiBase64url: spki.toString("base64url"),
  });
}

function effectAttemptJob(
  lease: ContinuationRuntimeV1DurableJob,
  override: Readonly<{
    payload?: ContinuationRuntimeV1DurableJob["payload"];
    payload_sha256?: string;
    lease_acquired_at?: string;
  }> = {},
): ContinuationRuntimeV1WorkerAttemptJob<"effect"> {
  assert.equal(lease.job_kind, "effect");
  assert.ok(lease.lease_acquired_at);
  assert.ok(lease.lease_expires_at);
  return {
    schema_version: "continuation_runtime_worker_attempt_job_v1",
    tenant_id: lease.tenant_id,
    scope: lease.scope,
    task_family: lease.task_family,
    authority_subject_sha256: lease.authority_subject_sha256,
    job_id: lease.job_id,
    job_kind: "effect",
    payload_sha256: override.payload_sha256 ?? lease.payload_sha256,
    payload: override.payload ?? lease.payload,
    attempt_count: lease.attempt_count,
    max_attempts: lease.max_attempts,
    lease_acquired_at: override.lease_acquired_at ?? lease.lease_acquired_at,
    lease_expires_at: lease.lease_expires_at,
  };
}

async function readyEffectSettlement(
  current: Fixture,
  signer = effectSigner(),
) {
  const seeded = await seedLearningPair(
    current,
    64,
    ["shadow", "eligible", "active_candidate"],
    1,
    1,
  );
  const installed = await installCohort(current, seeded);
  const evidence = await appendAssignedEvidence(current, 1);
  current.clock.value = installed.cohort.settlement_cutoff_at;
  const principal = continuationRuntimeV1WorkerPrincipal({
    database_instance_id: current.database.databaseInstanceId,
    worker_role: "effect",
  });
  const lease = await current.jobs.leaseNext({
    tenant_id: TENANT,
    job_kind: "effect",
    lease_owner: `effect-test-${principal.actor_principal_sha256}`,
    lease_duration_ms: 60_000,
  });
  assert.ok(lease?.lease_token);
  const processor = createContinuationRuntimeV1EffectWorkerProcessor({
    database: current.database,
    artifactStore: current.artifacts,
    policyAuthority: current.policies,
    signer,
  });
  return { seeded, installed, evidence, principal, lease, processor };
}

async function prepareEffectAttempt(
  ready: Awaited<ReturnType<typeof readyEffectSettlement>>,
  job = effectAttemptJob(ready.lease),
): Promise<ContinuationRuntimeV1PreparedWorkerSuccess<"effect">> {
  return ready.processor.process({
    schema_version: "continuation_runtime_worker_processor_input_v1",
    attempt_operation_id: `effect-attempt-${ready.lease.job_id}`,
    job,
    signal: new AbortController().signal,
  });
}

function workerCommand(
  ready: Awaited<ReturnType<typeof readyEffectSettlement>>,
  prepared: ContinuationRuntimeV1PreparedWorkerSuccess<"effect">,
  operationId: string,
) {
  return buildWorkerCompletionCommandV1(operationId, {
    schema_version: "worker_completion_body_v1",
    completion: { status: "succeeded", output: prepared.output },
  }, {
    tenant_id: TENANT,
    scope: SCOPE,
    actor_kind: "worker",
    actor_principal_sha256: ready.principal.actor_principal_sha256,
    task_family: FAMILY,
    authority_subject_sha256: SUBJECT,
    job_id: ready.lease.job_id,
    job_kind: "effect",
    job_payload_sha256: ready.lease.payload_sha256,
    attempt_count: ready.lease.attempt_count,
    lease_token_sha256: sha256Hex(ready.lease.lease_token!),
  });
}

async function commitEffectAttempt(
  current: Fixture,
  ready: Awaited<ReturnType<typeof readyEffectSettlement>>,
  prepared: ContinuationRuntimeV1PreparedWorkerSuccess<"effect">,
  operationId = `effect-completion-${ready.lease.job_id}`,
) {
  const command = workerCommand(ready, prepared, operationId);
  return current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: "worker_completion",
    operationId,
    actorKind: "worker",
    actorPrincipalSha256: ready.principal.actor_principal_sha256,
    request: operationRequestFromVerifiedCommandV1(command),
    produce: async (context) => {
      await prepared.commitAuthority({
        context,
        job: effectAttemptJob(ready.lease),
        output: prepared.output,
      });
      await current.jobs.complete(context, {
        job_id: ready.lease.job_id,
        lease_token: ready.lease.lease_token!,
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

async function appendMissingOutcomeAtExactCutoff(
  current: Fixture,
  ready: Awaited<ReturnType<typeof readyEffectSettlement>>,
): Promise<void> {
  const missing = ready.evidence.memberSet.members.find(
    (member) => member.terminal_event.event_kind === "contract_exposed",
  );
  assert.ok(missing);
  const decision = await current.episode.readDecision(
    TENANT,
    SCOPE,
    missing.decision_id,
  );
  const exposure = decision[0]!;
  assert.equal(exposure.payload.payload_kind, "contract_exposed_v1");
  if (exposure.payload.payload_kind !== "contract_exposed_v1") {
    throw new Error("expected missing-outcome exposure");
  }
  const contract = exposure.payload.continuation_contract as unknown as
    ContinuationContractV1;
  current.clock.value = ready.installed.cohort.settlement_cutoff_at;
  await operation(
    current,
    "record_outcome",
    `cutoff-race-${missing.decision_id}`,
    (context) => current.episode.appendOutcomeBundle(context, {
      decision_id: missing.decision_id,
      use_receipt: {
        schema_version: "host_capsule_use_receipt_v1",
        decision_id: missing.decision_id,
        use_id: `cutoff-race-use-${missing.decision_id}`,
        observed_at: plus(ready.installed.cohort.outcome_deadline, -1),
        render_result_sha256: exposure.render_result_sha256,
        capsule_uses: contract.selected_capsules.map((selection) => ({
          capsule_scope: SCOPE,
          capsule_id: selection.capsule.capsule_id,
          capsule_revision: selection.capsule.capsule_revision,
          capsule_sha256: selection.capsule.capsule_sha256,
          surface: selection.surface,
          use_state: "used" as const,
        })),
        evidence_sha256: canonicalContinuationSha256({
          decision_id: missing.decision_id,
          kind: "cutoff-race-use",
        }),
      },
      outcome_receipt: {
        schema_version: "host_outcome_receipt_v1",
        decision_id: missing.decision_id,
        observed_at: ready.installed.cohort.outcome_deadline,
        outcome: "succeeded",
        outcome_code: "verified_at_exact_deadline",
        evidence_sha256: canonicalContinuationSha256({
          decision_id: missing.decision_id,
          kind: "cutoff-race-outcome",
        }),
        summary: "verified outcome committed at exact settlement cutoff",
      },
    }),
  );
}

function assertProcessorFailure(
  code: string,
  disposition: "retry" | "dead" = "dead",
) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ContinuationRuntimeV1WorkerProcessorError);
    assert.equal(error.code, code);
    assert.equal(error.disposition, disposition);
    assert.equal(error.message,
      "continuation_runtime_v1_worker_processor_failed");
    return true;
  };
}

test("effect worker prepares exact ITT census, signs outside SQLite and replays atomically", async () => {
  const current = fixture();
  try {
    const ready = await readyEffectSettlement(current);
    const prepared = await prepareEffectAttempt(ready);
    assert.equal(prepared.output.kind, "effect");
    assert.equal(
      prepared.output.eligible_decision_set.eligible_decision_count,
      ready.evidence.memberSet.eligible_decision_count,
    );
    assert.deepEqual(
      prepared.output.eligible_decision_set,
      ready.evidence.memberSet,
      "the output must contain all and only assigned exposures, including missing outcomes",
    );
    assert.equal(
      prepared.output.signed_certificate.created_at,
      ready.installed.cohort.settlement_cutoff_at,
      "the exact settlement cutoff is admissible",
    );
    assert.equal(
      prepared.output.signed_certificate.effect_evaluation.missing_outcome_count,
      1,
      "the failed late outcome remains an ITT missing outcome",
    );
    const committed = await commitEffectAttempt(current, ready, prepared);
    assert.equal(committed.status, "created");
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificates",
    ).get()?.count, 1);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM durable_jobs WHERE state='succeeded'",
    ).get()?.count, 1);

    const command = workerCommand(
      ready,
      prepared,
      `effect-completion-${ready.lease.job_id}`,
    );
    const replay = await current.operations.execute({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "worker_completion",
      operationId: command.operation_id,
      actorKind: "worker",
      actorPrincipalSha256: ready.principal.actor_principal_sha256,
      request: operationRequestFromVerifiedCommandV1(command),
      produce: async () => {
        throw new Error("replay must not execute processor commit");
      },
    });
    assert.equal(replay.status, "replayed");
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificates",
    ).get()?.count, 1);
  } finally {
    await current.database.close();
  }
});

test("effect worker retries an exact-cutoff census race and rolls back its stale certificate", async () => {
  const current = fixture();
  try {
    const ready = await readyEffectSettlement(current);
    const prepared = await prepareEffectAttempt(ready);
    await appendMissingOutcomeAtExactCutoff(current, ready);
    await assert.rejects(
      commitEffectAttempt(current, ready, prepared, "effect-cutoff-census-race"),
      assertProcessorFailure("effect_settlement_commit_census_drift", "retry"),
    );
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificates",
    ).get()?.count, 0);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM episode_events WHERE event_kind='effect_certified'",
    ).get()?.count, 0);
    assert.equal(await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "worker_completion",
      operationId: "effect-cutoff-census-race",
    }), null);
  } finally {
    await current.database.close();
  }
});

test("effect worker rejects seed, ledger, cutoff, signer and payload forgery without leakage", async (t) => {
  await t.test("protected seed commitment tamper is terminal", async () => {
    const current = fixture();
    try {
      const ready = await readyEffectSettlement(current);
      current.database.db.exec("DROP TRIGGER authority_artifacts_no_update");
      current.database.db.prepare(`UPDATE authority_artifacts
        SET protected_secret = ?
        WHERE tenant_id = ? AND artifact_sha256 = ?`).run(
        Buffer.alloc(32, 99),
        TENANT,
        ready.installed.ref.artifact_sha256,
      );
      await assert.rejects(
        prepareEffectAttempt(ready),
        assertProcessorFailure("effect_seed_commitment_mismatch"),
      );
      assert.equal(current.database.db.prepare(
        "SELECT count(*) AS count FROM effect_certificates",
      ).get()?.count, 0);
    } finally {
      await current.database.close();
    }
  });

  await t.test("ledger census drift is terminal", async () => {
    const current = fixture();
    try {
      const ready = await readyEffectSettlement(current);
      current.database.db.exec("DROP TRIGGER episode_events_no_update");
      current.database.db.prepare(`UPDATE episode_events
        SET event_sha256 = ?
        WHERE rowid = (SELECT rowid FROM episode_events
          WHERE event_kind = 'outcome_observed' ORDER BY rowid LIMIT 1)`).run(
        "f".repeat(64),
      );
      await assert.rejects(
        prepareEffectAttempt(ready),
        assertProcessorFailure("effect_authority_or_ledger_invalid"),
      );
    } finally {
      await current.database.close();
    }
  });

  await t.test("certificate before settlement cutoff is terminal", async () => {
    const current = fixture();
    try {
      const ready = await readyEffectSettlement(current);
      const early = plus(ready.installed.cohort.settlement_cutoff_at, -1);
      await assert.rejects(
        prepareEffectAttempt(ready, effectAttemptJob(ready.lease, {
          lease_acquired_at: early,
        })),
        assertProcessorFailure("effect_cohort_binding_invalid"),
      );
    } finally {
      await current.database.close();
    }
  });

  await t.test("untrusted signing key is terminal", async () => {
    const current = fixture();
    try {
      const untrusted = generateKeyPairSync("ed25519");
      const ready = await readyEffectSettlement(current, effectSigner(untrusted));
      await assert.rejects(
        prepareEffectAttempt(ready),
        assertProcessorFailure("effect_settlement_signer_invalid"),
      );
    } finally {
      await current.database.close();
    }
  });

  await t.test("payload cannot inject an evidence member", async () => {
    const current = fixture();
    try {
      const ready = await readyEffectSettlement(current);
      const forgedPayload = {
        ...ready.lease.payload,
        eligible_decision_set: ready.evidence.memberSet,
      } as ContinuationRuntimeV1DurableJob["payload"];
      await assert.rejects(
        prepareEffectAttempt(ready, effectAttemptJob(ready.lease, {
          payload: forgedPayload,
          payload_sha256: canonicalContinuationSha256(forgedPayload),
        })),
        assertProcessorFailure("effect_settlement_payload_invalid"),
      );
      const forgedCutoff = {
        ...ready.lease.payload,
        settlement_cutoff_at: plus(
          ready.installed.cohort.settlement_cutoff_at,
          1,
        ),
      } as ContinuationRuntimeV1DurableJob["payload"];
      await assert.rejects(
        prepareEffectAttempt(ready, effectAttemptJob(ready.lease, {
          payload: forgedCutoff,
          payload_sha256: canonicalContinuationSha256(forgedCutoff),
        })),
        assertProcessorFailure("effect_settlement_payload_invalid"),
      );
    } finally {
      await current.database.close();
    }
  });
});

test("effect worker completion rollback removes certificate and effect events", async () => {
  const current = fixture();
  try {
    const ready = await readyEffectSettlement(current);
    const prepared = await prepareEffectAttempt(ready);
    current.database.db.exec(`CREATE TRIGGER test_effect_job_completion_abort
      BEFORE UPDATE OF state ON durable_jobs
      WHEN OLD.job_kind = 'effect' AND NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'forced effect completion rollback'); END`);
    await assert.rejects(
      commitEffectAttempt(current, ready, prepared, "effect-forced-rollback"),
      /forced effect completion rollback/u,
    );
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM effect_certificates",
    ).get()?.count, 0);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM episode_events WHERE event_kind='effect_certified'",
    ).get()?.count, 0);
    assert.equal(current.database.db.prepare(
      "SELECT count(*) AS count FROM durable_jobs WHERE state='leased'",
    ).get()?.count, 1);
    assert.equal(await current.operations.read({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "worker_completion",
      operationId: "effect-forced-rollback",
    }), null);
  } finally {
    await current.database.close();
  }
});
