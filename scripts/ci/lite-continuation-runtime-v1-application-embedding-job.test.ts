import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSignedAuthorityArtifactV1,
  type SignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import { canonicalContinuationJson, type Sha256 } from
  "../../src/continuation/contract.js";
import {
  buildEffectEvidencePolicyV1,
} from "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  createContinuationRuntimeV1ApplicationService,
  type ContinuationRuntimeV1ApplicationServiceDependencies,
} from "../../src/runtime-v1/application-service.js";
import { buildRecordObservationsCommandV1 } from
  "../../src/runtime-v1/command.js";
import {
  buildContinuationRuntimeV1EmbeddingJobPayload,
  parseContinuationRuntimeV1EmbeddingJobPayload,
} from "../../src/runtime-v1/embedding-job-contract.js";
import { createContinuationRuntimeV1OfflineProvisioningService } from
  "../../src/runtime-v1/provisioning.js";
import { createContinuationRuntimeV1DecisionAssemblyService } from
  "../../src/runtime-v1/decision-assembly.js";
import { createContinuationRuntimeV1DecisionReader } from
  "../../src/runtime-v1/decision-reader.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.js";
import { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../../src/store/continuation-runtime-v1-durable-job-enqueuer.js";
import {
  openContinuationRuntimeV1Database,
  type ContinuationRuntimeV1Database,
} from "../../src/store/continuation-runtime-v1-database.js";
import { createContinuationRuntimeV1EffectCertificateReader } from
  "../../src/store/continuation-runtime-v1-effect-certificate-reader.js";
import { createContinuationRuntimeV1EpisodeStore } from
  "../../src/store/continuation-runtime-v1-episode-store.js";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "../../src/store/continuation-runtime-v1-experiment-cohort-authority.js";
import { createContinuationRuntimeV1MemoryHistoryStore } from
  "../../src/store/continuation-runtime-v1-memory-history.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.js";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.js";
import { createContinuationRuntimeV1OperationStore } from
  "../../src/store/continuation-runtime-v1-operation-store.js";
import type { RecordObservationsOperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-application-embedding";
const SCOPE = "scope-application-embedding";
const TASK_FAMILY = "repair";
const HOST = "1".repeat(64) as Sha256;
const OPERATOR = "2".repeat(64) as Sha256;
const VERIFIER = "3".repeat(64) as Sha256;
const NOW = "2026-07-22T10:05:00.000Z";
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: TASK_FAMILY,
});

function compilerArtifact(): SignedAuthorityArtifactV1 {
  const payload = buildContinuationCompilerPolicyV1({
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
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [HOST],
      external_verifier: [VERIFIER],
    },
  });
  return buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "compiler-main",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload,
    valid_from: "2026-07-22T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
  }, ROOT_KEYS.privateKey);
}

function evidenceArtifact(): SignedAuthorityArtifactV1 {
  const payload = buildEffectEvidencePolicyV1({
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
  return buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "evidence-main",
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload,
    valid_from: "2026-07-22T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
  }, ROOT_KEYS.privateKey);
}

function count(database: ContinuationRuntimeV1Database, table: string): number {
  return (database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function recordResponse(value: unknown): Readonly<{
  result: RecordObservationsOperationResultV1;
}> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<{ result: RecordObservationsOperationResultV1 }>;
}

function command(operationId: string, capsuleCount: number) {
  const memoryInputs = Array.from({ length: capsuleCount }, (_, index) => {
    const identity = `procedure-${String(index).padStart(2, "0")}`;
    const target = `authority-state-${String(index).padStart(2, "0")}`;
    return {
      memory_input_id: identity,
      kind: "procedure" as const,
      applicability: {
        task_signature: "task-signature-a",
        workflow_signature: null,
        workspace_signature: "workspace-a",
      },
      projection: {
        summary: "Inspect the authority state before modifying it.",
        next_action: "Verify the current authority digest.",
        target_refs: [{ kind: "memory" as const, ref: target }],
        workflow_steps: ["Read authority state.", "Verify the digest."],
        acceptance_statements: ["The authority digest matches."],
      },
      coverage_claims: [{
        obligation_kind: "required_state" as const,
        target_refs: [{ kind: "memory" as const, ref: target }],
        evidence_requirement: "runtime_state" as const,
        required_probe_ids: [],
      }],
      precondition_specs: [],
      evidence_observation_ids: ["observation-a"],
      expires_at: "2026-07-22T11:00:00.000Z",
    };
  });
  return buildRecordObservationsCommandV1(operationId, {
    schema_version: "record_observations_body_v1",
    host_task: {
      host_task_id: `task-${operationId}`,
      episode_id: `episode-${operationId}`,
      run_id: `run-${operationId}`,
      consumer_agent_id: "agent-a",
      consumer_team_id: "team-a",
      task_family: TASK_FAMILY,
      task_signature: "task-signature-a",
      workflow_signature: null,
      workspace_signature: "workspace-a",
      source_task_sha256: "4".repeat(64),
      source_event_sha256: "5".repeat(64),
      issued_at: "2026-07-22T10:00:00.000Z",
      expires_at: "2026-07-22T12:00:00.000Z",
    },
    memory_inputs: memoryInputs,
    collector_observations: [{
      schema_version: "collector_observation_v1",
      observation_id: "observation-a",
      probe_id: "probe-a",
      probe_spec_sha256: "6".repeat(64),
      observed_at: "2026-07-22T10:01:00.000Z",
      expires_at: "2026-07-22T11:30:00.000Z",
      value: {
        kind: "capability",
        capability_id: "authority-state",
        version: "1.0.0",
        presence: "present",
      },
      evidence_sha256: "7".repeat(64),
    }],
    signed_observations: [],
  }, {
    tenant_id: TENANT,
    scope: SCOPE,
    actor_kind: "trusted_host",
    actor_principal_sha256: HOST,
  });
}

test("recordObservations atomically emits one exact embedding job and replay cannot duplicate it", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-application-embedding-"));
  const clock = { value: NOW };
  const database = openContinuationRuntimeV1Database(
    join(root, "authority", "runtime.sqlite"),
    { databaseInstanceId: "8".repeat(64), authorityNow: () => clock.value },
  );
  try {
    const operationStore = createContinuationRuntimeV1OperationStore(database);
    const artifactProvisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
      database,
      ROOT_KEYS.publicKey,
    );
    const artifactStore = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      ROOT_KEYS.publicKey,
    );
    const provisioning = createContinuationRuntimeV1OfflineProvisioningService(
      database,
      artifactProvisioner,
      operationStore,
    );
    await provisioning.provision({
      schema_version: "offline_provisioning_command_v1",
      tenant_id: TENANT,
      scope: SCOPE,
      task_family: TASK_FAMILY,
      operation_id: "install-policy-bundle",
      actor_kind: "operator",
      actor_principal_sha256: OPERATOR,
      authority_subject_sha256: SUBJECT,
      kind: "policy_bundle_install",
      policy_bundle: {
        schema_version: "authority_policy_provisioning_bundle_v1",
        tenant_id: TENANT,
        authority_subject_sha256: SUBJECT,
        compiler_policy: compilerArtifact(),
        evidence_policy: evidenceArtifact(),
      },
    });

    const policyAuthority = createContinuationRuntimeV1PolicyAuthority(
      database,
      artifactStore,
    );
    const effectCertificateReader = createContinuationRuntimeV1EffectCertificateReader(
      database,
      artifactStore,
      policyAuthority,
    );
    const authorityStore = createContinuationRuntimeV1AuthorityStore(
      database,
      artifactStore,
      policyAuthority,
      effectCertificateReader,
    );
    const observationStore = createContinuationRuntimeV1ObservationStore(database);
    const memoryStore = createContinuationRuntimeV1MemoryStore(database);
    const durableJobStore = createContinuationRuntimeV1DurableJobEnqueuer(database);
    const memoryHistory = createContinuationRuntimeV1MemoryHistoryStore(database);
    const episodeStore = createContinuationRuntimeV1EpisodeStore(database);
    const experimentCohortAuthority =
      createContinuationRuntimeV1ExperimentCohortAuthority(
        database,
        artifactStore,
        policyAuthority,
      );
    const decisionAssembly = createContinuationRuntimeV1DecisionAssemblyService({
      database,
      observationStore,
      memoryStore,
      artifactStore,
      policyAuthority,
      effectCertificateReader,
      authorityStore,
      experimentCohortAuthority,
    });
    const decisionReader = createContinuationRuntimeV1DecisionReader({
      database,
      artifactStore,
      episodeStore,
      observationStore,
      memoryHistory,
      authorityStore,
      policyAuthority,
      effectCertificateReader,
    });
    const dependencies: ContinuationRuntimeV1ApplicationServiceDependencies = {
      tenantId: TENANT,
      trustRootSha256: "9".repeat(64) as Sha256,
      database,
      operationStore,
      durableJobStore,
      observationStore,
      memoryStore,
      policyAuthority,
      authorityStore,
      episodeStore,
      decisionAssembly,
      decisionReader,
    };

    const mutation = command("observe-with-embedding", 64);
    const baseline = {
      operations: count(database, "operations"),
      observations: count(database, "observation_snapshots"),
      commits: count(database, "memory_commits"),
      jobs: count(database, "durable_jobs"),
      branches: count(database, "branch_revisions"),
    };
    const failAfterEnqueue = createContinuationRuntimeV1ApplicationService({
      ...dependencies,
      authorityStore: {
        ...authorityStore,
        ensureGenesis: async () => {
          throw new Error("intentional_failure_after_embedding_enqueue");
        },
      },
    });
    await assert.rejects(
      async () => await Promise.resolve(
        failAfterEnqueue.recordObservations(mutation),
      ),
      /intentional_failure_after_embedding_enqueue/u,
    );
    assert.deepEqual({
      operations: count(database, "operations"),
      observations: count(database, "observation_snapshots"),
      commits: count(database, "memory_commits"),
      jobs: count(database, "durable_jobs"),
      branches: count(database, "branch_revisions"),
    }, baseline);

    const application = createContinuationRuntimeV1ApplicationService(dependencies);
    const createdValue = await Promise.resolve(
      application.recordObservations(mutation),
    );
    const created = recordResponse(createdValue);
    assert.equal(created.result.memory_revision_ref?.capsule_count, 64);
    assert.equal(created.result.durable_job_set.count, 1);
    assert.equal(created.result.durable_job_set.refs[0]!.job_kind, "embedding");
    assert.equal(count(database, "durable_jobs"), baseline.jobs + 1);

    const row = database.db.prepare(`SELECT payload_json, payload_sha256,
      source_operation_kind, source_operation_id, source_request_sha256
      FROM durable_jobs WHERE tenant_id = ? AND scope = ? AND job_kind = 'embedding'`
    ).get(TENANT, SCOPE) as {
      payload_json: string;
      payload_sha256: string;
      source_operation_kind: string;
      source_operation_id: string;
      source_request_sha256: string;
    };
    const payload = parseContinuationRuntimeV1EmbeddingJobPayload(
      JSON.parse(row.payload_json),
    );
    const capsuleRows = database.db.prepare(`SELECT capsule_id, capsule_revision,
      capsule_sha256 FROM capsule_revisions WHERE tenant_id = ? AND scope = ?
      ORDER BY capsule_id`).all(TENANT, SCOPE) as Array<{
        capsule_id: string;
        capsule_revision: number;
        capsule_sha256: Sha256;
      }>;
    assert.deepEqual(payload, buildContinuationRuntimeV1EmbeddingJobPayload(capsuleRows));
    assert.equal(payload.capsule_refs.length, 64);
    assert.equal(created.result.durable_job_set.refs[0]!.payload_sha256, row.payload_sha256);
    assert.deepEqual({
      operation_kind: row.source_operation_kind,
      operation_id: row.source_operation_id,
      request_sha256: row.source_request_sha256,
    }, {
      operation_kind: "record_observations",
      operation_id: mutation.operation_id,
      request_sha256: mutation.command_sha256,
    });
    assert.deepEqual(Object.keys(payload).sort(), ["capsule_refs", "schema_version"]);
    assert.equal(row.payload_json.includes("summary"), false);
    assert.equal(row.payload_json.includes("source"), false);

    const countsBeforeReplay = {
      operations: count(database, "operations"),
      observations: count(database, "observation_snapshots"),
      commits: count(database, "memory_commits"),
      jobs: count(database, "durable_jobs"),
      branches: count(database, "branch_revisions"),
    };
    const replayed = await Promise.resolve(application.recordObservations(mutation));
    assert.equal(
      canonicalContinuationJson(replayed),
      canonicalContinuationJson(createdValue),
    );
    assert.deepEqual({
      operations: count(database, "operations"),
      observations: count(database, "observation_snapshots"),
      commits: count(database, "memory_commits"),
      jobs: count(database, "durable_jobs"),
      branches: count(database, "branch_revisions"),
    }, countsBeforeReplay);

    const withoutCapsule = recordResponse(await Promise.resolve(
      application.recordObservations(command("observe-without-capsule", 0)),
    ));
    assert.equal(withoutCapsule.result.memory_revision_ref, null);
    assert.equal(withoutCapsule.result.durable_job_set.count, 0);
    assert.equal(count(database, "durable_jobs"), baseline.jobs + 1);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
