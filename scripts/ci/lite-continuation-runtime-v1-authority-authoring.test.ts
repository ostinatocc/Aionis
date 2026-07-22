import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  authorityArtifactPublicKeySha256,
  verifySignedAuthorityArtifactV1,
  type SignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import type { AuthorityBranchManifestV1 } from
  "../../src/continuation/authority-branch.js";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type AuthorityArtifactRefV1,
  type Sha256,
} from "../../src/continuation/contract.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import { EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1 } from
  "../../src/continuation/experiment-cohort.js";
import type { ExperimentCohortV1 } from
  "../../src/continuation/experiment-cohort.js";
import { authorityBranchBindingSetSha256V1 } from
  "../../src/continuation/policy-rotation.js";
import { assignmentSeedCommitmentSha256V1 } from
  "../../src/continuation/serving-assignment.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import { continuationRuntimeV1PrincipalSha256 } from
  "../../src/runtime-v1/auth.js";
import {
  assertOfflineProvisioningCommandV1,
  createContinuationRuntimeV1OfflineProvisioningService,
  type OfflineExperimentCohortInstallCommandV1,
  type OfflinePolicyBundleInstallCommandV1,
  type OfflinePolicyRotationInstallCommandV1,
} from
  "../../src/runtime-v1/provisioning.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import type { AuthorityPolicyProvisioningBundleV1 } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.js";
import { openContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.js";
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
} from
  "../../src/store/continuation-runtime-v1-operation-store.js";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.js";
import {
  AuthorityAuthoringError,
  authorContinuationRuntimeV1AuthorityCommand,
} from "../../tools/continuation-runtime-v1-authority-authoring.js";
import {
  AuthorityRootKeyError,
  assertAuthorityRootDescriptorPosture,
  assertAuthorityRootDescriptorStable,
  type AuthorityRootDescriptorSnapshot,
} from "../../tools/continuation-runtime-v1-authority-key.js";

const AUTHORITY_BUILD_TOOL = fileURLToPath(new URL(
  "../../tools/build-continuation-runtime-v1-authority.mjs",
  import.meta.url,
));
const TOOL = fileURLToPath(new URL(
  "../../dist-authority/tools/author-continuation-runtime-v1-authority.js",
  import.meta.url,
));
const AUTHORITY_BUILD_MANIFEST = fileURLToPath(new URL(
  "../../dist-authority/authority-build-manifest.canonical.json",
  import.meta.url,
));
const AUTHORITY_KEYGEN_TOOL = fileURLToPath(new URL(
  "../../tools/generate-continuation-runtime-v1-authority-keys.mjs",
  import.meta.url,
));
const COHORT_SEEDGEN_TOOL = fileURLToPath(new URL(
  "../../tools/generate-continuation-runtime-v1-cohort-seed.mjs",
  import.meta.url,
));
const PROVISIONING_ENTRY = fileURLToPath(new URL(
  "../../src/runtime-v1/provisioning-entry.ts",
  import.meta.url,
));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROOT_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-a";
const SCOPE = "scope-a";
const FAMILY = "coding";
const OPERATOR_ID = "operator-a";
const HOST = "1".repeat(64) as Sha256;
const VERIFIER = "2".repeat(64) as Sha256;
const SHA_A = "a".repeat(64) as Sha256;
const SHA_B = "b".repeat(64) as Sha256;
const SHA_C = "c".repeat(64) as Sha256;
const SHA_D = "d".repeat(64) as Sha256;
const SHA_E = "e".repeat(64) as Sha256;
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: FAMILY,
});
const OPERATOR = continuationRuntimeV1PrincipalSha256({
  tenant_id: TENANT,
  principal_kind: "operator",
  principal_id: OPERATOR_ID,
});
const SEED = Buffer.from("SECRET-SEED-0123456789-ABCDEFGHI", "utf8");
assert.equal(SEED.byteLength, 32);

test.before(() => {
  const built = spawnSync("/bin/sh", [
    "-c",
    "umask 000; exec \"$1\" \"$2\"",
    "authority-build",
    process.execPath,
    AUTHORITY_BUILD_TOOL,
  ], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.stderr, "");
  const event = JSON.parse(built.stdout) as {
    schema_version: string;
    event: string;
    entrypoint: string;
    closure_sha256: string;
    file_count: number;
  };
  assert.equal(event.schema_version,
    "continuation_runtime_v1_authority_build_event_v1");
  assert.equal(event.event, "authority_build_complete");
  assert.equal(event.entrypoint,
    "tools/author-continuation-runtime-v1-authority.js");
  assert.match(event.closure_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(event.file_count > 0);
});

function compilerPayload() {
  return {
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
  };
}

function evidencePayload() {
  return {
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
  };
}

function artifactDraft(
  artifactId: string,
  payload: Readonly<Record<string, unknown>>,
  expiresAt: string | null = null,
) {
  return {
    artifact_id: artifactId,
    artifact_revision: 1,
    created_at: "2026-07-21T00:00:00.000Z",
    expires_at: expiresAt,
    payload,
    valid_from: "2026-07-21T01:00:00.000Z",
  };
}

function common(kind: string, operationId: string) {
  return {
    schema_version: "offline_authority_authoring_request_v1",
    kind,
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: FAMILY,
    operation_id: operationId,
    operator_principal_id: OPERATOR_ID,
  };
}

function policyRequest() {
  return {
    ...common("policy_bundle_install", "install-policy-bundle"),
    compiler_policy: artifactDraft("compiler-main", compilerPayload()),
    evidence_policy: artifactDraft("evidence-main", evidencePayload()),
  };
}

function cohortRequest() {
  return {
    ...common("experiment_cohort_install", "install-cohort"),
    experiment_cohort: artifactDraft("cohort-main", {
      schema_version: "experiment_cohort_v1",
      tenant_id: TENANT,
      scope: SCOPE,
      task_family: FAMILY,
      cohort_id: "cohort-main",
      authority_subject_sha256: SUBJECT,
      control_learning_ref: {
        branch_id: "authority-main",
        branch_revision: 1,
        manifest_sha256: SHA_A,
        branch_kind: "authoritative",
        state: "authoritative",
      },
      candidate_learning_ref: {
        branch_id: "candidate-main",
        branch_revision: 2,
        manifest_sha256: SHA_B,
        branch_kind: "candidate",
        state: "active_candidate",
      },
      compiler_policy_ref: {
        artifact_sha256: SHA_C,
        payload_sha256: SHA_D,
      },
      evidence_policy_ref: {
        artifact_sha256: SHA_D,
        payload_sha256: SHA_E,
      },
      eligibility: { host_principal_sha256s: null },
      assignment_protocol: {
        algorithm: "hmac_sha256_threshold_v1",
        algorithm_contract_sha256:
          EXPERIMENT_ASSIGNMENT_ALGORITHM_CONTRACT_SHA256_V1,
        assignment_seed_commitment_sha256:
          assignmentSeedCommitmentSha256V1(SEED),
        basis_schema: "serving_assignment_basis_v1",
        candidate_allocation_bps: 5_000,
      },
      assignment_window_opened_at: "2026-07-21T03:00:00.000Z",
      assignment_window_closed_at: "2026-07-21T04:00:00.000Z",
      outcome_deadline: "2026-07-21T05:00:00.000Z",
      settlement_grace_ms: 60_000,
      settlement_cutoff_at: "2026-07-21T05:01:00.000Z",
    }, "2026-07-21T06:00:00.000Z"),
  };
}

function rotationRequest() {
  return {
    ...common("policy_rotation_install", "install-rotation"),
    policy_rotation: artifactDraft("rotation-main", {
      schema_version: "policy_rotation_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      previous_authoritative_ref: {
        branch_id: "authority-main",
        branch_revision: 1,
        manifest_sha256: SHA_A,
        branch_kind: "authoritative",
        state: "authoritative",
      },
      old_compiler_policy_ref: {
        artifact_sha256: SHA_A,
        payload_sha256: SHA_B,
      },
      new_compiler_policy_ref: {
        artifact_sha256: SHA_C,
        payload_sha256: SHA_D,
      },
      old_evidence_policy_ref: {
        artifact_sha256: SHA_B,
        payload_sha256: SHA_C,
      },
      new_evidence_policy_ref: {
        artifact_sha256: SHA_D,
        payload_sha256: SHA_E,
      },
      previous_binding_set_sha256: SHA_E,
    }),
  };
}

function policyArtifacts(command: ReturnType<
  typeof authorContinuationRuntimeV1AuthorityCommand
>): readonly [SignedAuthorityArtifactV1, SignedAuthorityArtifactV1] {
  assert.equal(command.kind, "policy_bundle_install");
  assert.ok(command.policy_bundle);
  return [
    command.policy_bundle.compiler_policy,
    command.policy_bundle.evidence_policy,
  ];
}

type ChildResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function writeKey(root: string, key: KeyObject, mode = 0o600): string {
  const path = join(root, "authority-root.pem");
  const pem = key.export({ format: "pem", type: "pkcs8" });
  writeFileSync(path, pem, { mode });
  chmodSync(path, mode);
  return path;
}

function runCli(
  input: string,
  descriptorPath?: string,
  outerEnvironment: NodeJS.ProcessEnv = process.env,
): ChildResult {
  const command = descriptorPath === undefined
    ? "exec 3<&-; exec \"$1\" \"$2\""
    : "exec \"$1\" \"$2\" 3<\"$3\"";
  const args = [
    "-i", "/bin/sh", "-c", command, "authority-sign",
    process.execPath, TOOL,
  ];
  if (descriptorPath !== undefined) args.push(descriptorPath);
  const result = spawnSync("/usr/bin/env", args, {
    encoding: "utf8",
    env: outerEnvironment,
    input,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runCliWithFifo(
  input: string,
  keyPath: string,
  root: string,
): Promise<ChildResult> {
  const fifo = join(root, "authority-root.fifo");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  const sourceDescriptor = openSync(keyPath, "r");
  const broker = spawn("/bin/sh", [
    "-c",
    "cat <&3 > \"$1\"",
    "authority-secret-broker",
    fifo,
  ], { stdio: ["ignore", "ignore", "pipe", sourceDescriptor] });
  closeSync(sourceDescriptor);
  let brokerError = "";
  broker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    brokerError += chunk;
  });
  const brokerClosed = new Promise<number | null>((resolve, reject) => {
    broker.once("error", reject);
    broker.once("close", resolve);
  });
  const result = runCli(input, fifo);
  assert.equal(await brokerClosed, 0, brokerError);
  return result;
}

function canonicalTemplate(name: string): Record<string, unknown> {
  const source = readFileSync(fileURLToPath(new URL(
    `../../docs/examples/${name}`,
    import.meta.url,
  )), "utf8");
  const parsed = JSON.parse(source) as Record<string, unknown>;
  assert.equal(source, `${canonicalContinuationJson(parsed)}\n`,
    `${name} must remain byte-canonical`);
  return parsed;
}

function artifactRef(artifact: SignedAuthorityArtifactV1): AuthorityArtifactRefV1 {
  return {
    artifact_sha256: artifact.artifact_sha256,
    payload_sha256: artifact.payload_sha256,
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

type AuthorityChainFixture = Readonly<{
  root: string;
  dataPath: string;
  database: ContinuationRuntimeV1Database;
  operations: ReturnType<typeof createContinuationRuntimeV1OperationStore>;
  authority: ReturnType<typeof createContinuationRuntimeV1AuthorityStore>;
  observations: ReturnType<typeof createContinuationRuntimeV1ObservationStore>;
  memory: ReturnType<typeof createContinuationRuntimeV1MemoryStore>;
  provisioning: ReturnType<
    typeof createContinuationRuntimeV1OfflineProvisioningService
  >;
}>;

function authorityChainFixture(root: string): AuthorityChainFixture {
  const dataPath = join(root, "authority", "runtime.sqlite");
  const database = openContinuationRuntimeV1Database(dataPath, {
    databaseInstanceId: "9".repeat(64),
    now: () => "2026-07-21T02:00:00.000Z",
  });
  const artifactProvisioner =
    createContinuationRuntimeV1AuthorityArtifactProvisioner(
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
  return {
    root,
    dataPath,
    database,
    operations,
    authority: createContinuationRuntimeV1AuthorityStore(
      database,
      artifacts,
      policies,
      effects,
      { now: () => "2026-07-21T02:00:00.000Z" },
    ),
    observations: createContinuationRuntimeV1ObservationStore(database, {
      now: () => "2026-07-21T02:00:00.000Z",
    }),
    memory: createContinuationRuntimeV1MemoryStore(database, {
      now: () => "2026-07-21T02:00:00.000Z",
    }),
    provisioning: createContinuationRuntimeV1OfflineProvisioningService(
      database,
      artifactProvisioner,
      operations,
    ),
  };
}

async function authorityOperation<T>(
  current: AuthorityChainFixture,
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

type RealLearningPair = Readonly<{
  control: AuthorityBranchManifestV1;
  candidate: AuthorityBranchManifestV1;
}>;

async function seedRealLearningPair(
  current: AuthorityChainFixture,
): Promise<RealLearningPair> {
  const seeded = await authorityOperation(
    current,
    "record_observations",
    "authoring-chain-seed-learning-pair",
    async (context) => {
      await current.observations.put(context, {
        host_task_envelope: {
          host_task_id: "task-authoring-chain",
          episode_id: "episode-authoring-chain",
          run_id: "run-authoring-chain",
          consumer_agent_id: "agent-authoring-chain",
          consumer_team_id: null,
          task_family: FAMILY,
          task_signature: "authoring-chain-signature",
          workflow_signature: null,
          workspace_signature: "authoring-chain-workspace",
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
          memory_id: "memory-authoring-chain-candidate",
          memory_kind: "procedure",
          lifecycle: "active",
          authority: "candidate",
          hydrated: true,
          projection: { source: "tracked-authority-template-smoke" },
          rehydration_ref: null,
          expires_at: null,
        }],
        relations: [],
        capsules: [{
          memory_id: "memory-authoring-chain-candidate",
          draft: {
            capsule_id: "capsule-authoring-chain-candidate",
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
              summary: "Inspect the exact candidate state",
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
    candidate = await authorityOperation(
      current,
      "authority_decision",
      `authoring-chain-advance-candidate-${index + 1}`,
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
    control: seeded.genesis.revision.manifest,
    candidate: candidate.revision.manifest,
  };
}

function mutableRecord(value: unknown, field: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), field);
  return value as Record<string, unknown>;
}

function rewriteCommonTemplate(
  request: Record<string, unknown>,
  kind: string,
  operationId: string,
): void {
  request.kind = kind;
  request.tenant_id = TENANT;
  request.scope = SCOPE;
  request.task_family = FAMILY;
  request.operation_id = operationId;
  request.operator_principal_id = OPERATOR_ID;
}

function rewrittenPolicyTemplate(
  operationId: string,
  revision: number,
): Record<string, unknown> {
  const request = canonicalTemplate(
    "continuation-runtime-v1-policy-bundle-authoring-request.canonical.json",
  );
  rewriteCommonTemplate(request, "policy_bundle_install", operationId);
  const compiler = mutableRecord(request.compiler_policy, "compiler_policy");
  const evidence = mutableRecord(request.evidence_policy, "evidence_policy");
  for (const [draft, id] of [
    [compiler, "compiler-main"],
    [evidence, "evidence-main"],
  ] as const) {
    draft.artifact_id = id;
    draft.artifact_revision = revision;
    draft.created_at = revision === 1
      ? "2026-07-21T00:00:00.000Z"
      : "2026-07-21T00:30:00.000Z";
    draft.valid_from = "2026-07-21T01:00:00.000Z";
    draft.expires_at = null;
    const payload = mutableRecord(draft.payload, `${id}.payload`);
    payload.tenant_id = TENANT;
    payload.authority_subject_sha256 = SUBJECT;
  }
  const compilerPayloadRecord = mutableRecord(compiler.payload, "compiler.payload");
  compilerPayloadRecord.advisory_coverage_weight = 10_000 + revision - 1;
  compilerPayloadRecord.trusted_observer_principals = {
    trusted_host_collector: [HOST],
    external_verifier: [VERIFIER],
  };
  const evidencePayloadRecord = mutableRecord(evidence.payload, "evidence.payload");
  evidencePayloadRecord.trusted_effect_verifier_principals = [VERIFIER];
  evidencePayloadRecord.utility_min_lift_bps = revision;
  return request;
}

function rewrittenCohortTemplate(
  learningPair: RealLearningPair,
  policyBundleValue: AuthorityPolicyProvisioningBundleV1,
  seed: Uint8Array,
): Record<string, unknown> {
  const request = canonicalTemplate(
    "continuation-runtime-v1-experiment-cohort-authoring-request.canonical.json",
  );
  rewriteCommonTemplate(request, "experiment_cohort_install", "install-cohort-v1");
  const draft = mutableRecord(request.experiment_cohort, "experiment_cohort");
  draft.artifact_id = "cohort-main";
  draft.artifact_revision = 1;
  draft.created_at = "2026-07-21T00:00:00.000Z";
  draft.valid_from = "2026-07-21T01:00:00.000Z";
  draft.expires_at = "2026-07-21T06:00:00.000Z";
  const payload = mutableRecord(draft.payload, "experiment_cohort.payload");
  payload.tenant_id = TENANT;
  payload.scope = SCOPE;
  payload.task_family = FAMILY;
  payload.cohort_id = "cohort-main";
  payload.authority_subject_sha256 = SUBJECT;
  payload.control_learning_ref = fullBranchRef(learningPair.control);
  payload.candidate_learning_ref = fullBranchRef(learningPair.candidate);
  payload.compiler_policy_ref = artifactRef(policyBundleValue.compiler_policy);
  payload.evidence_policy_ref = artifactRef(policyBundleValue.evidence_policy);
  const assignment = mutableRecord(
    payload.assignment_protocol,
    "experiment_cohort.payload.assignment_protocol",
  );
  assignment.assignment_seed_commitment_sha256 =
    assignmentSeedCommitmentSha256V1(seed);
  payload.assignment_window_opened_at = "2026-07-21T03:00:00.000Z";
  payload.assignment_window_closed_at = "2026-07-21T04:00:00.000Z";
  payload.outcome_deadline = "2026-07-21T05:00:00.000Z";
  payload.settlement_grace_ms = 60_000;
  payload.settlement_cutoff_at = "2026-07-21T05:01:00.000Z";
  return request;
}

function rewrittenRotationTemplate(
  control: AuthorityBranchManifestV1,
  oldPolicy: AuthorityPolicyProvisioningBundleV1,
  newPolicy: AuthorityPolicyProvisioningBundleV1,
): Record<string, unknown> {
  const request = canonicalTemplate(
    "continuation-runtime-v1-policy-rotation-authoring-request.canonical.json",
  );
  rewriteCommonTemplate(request, "policy_rotation_install", "install-rotation-v1");
  const draft = mutableRecord(request.policy_rotation, "policy_rotation");
  draft.artifact_id = "rotation-main";
  draft.artifact_revision = 1;
  draft.created_at = "2026-07-21T00:30:00.000Z";
  draft.valid_from = "2026-07-21T01:00:00.000Z";
  draft.expires_at = null;
  const payload = mutableRecord(draft.payload, "policy_rotation.payload");
  payload.tenant_id = TENANT;
  payload.authority_subject_sha256 = SUBJECT;
  payload.previous_authoritative_ref = fullBranchRef(control);
  payload.old_compiler_policy_ref = artifactRef(oldPolicy.compiler_policy);
  payload.new_compiler_policy_ref = artifactRef(newPolicy.compiler_policy);
  payload.old_evidence_policy_ref = artifactRef(oldPolicy.evidence_policy);
  payload.new_evidence_policy_ref = artifactRef(newPolicy.evidence_policy);
  payload.previous_binding_set_sha256 =
    authorityBranchBindingSetSha256V1(control.capsule_bindings);
  return request;
}

function authoringFailure(operation: () => unknown, code: string): void {
  assert.throws(operation, (error) => error instanceof AuthorityAuthoringError
    && error.code === code);
}

async function assertPolicyCommandInstalls(
  command: ReturnType<typeof authorContinuationRuntimeV1AuthorityCommand>,
): Promise<void> {
  assert.equal(command.kind, "policy_bundle_install");
  const [compilerArtifact, evidenceArtifact] = policyArtifacts(command);
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-install-"));
  const database = openContinuationRuntimeV1Database(
    join(root, "authority", "runtime.sqlite"),
    {
      databaseInstanceId: "f".repeat(64),
      now: () => compilerArtifact.created_at,
    },
  );
  try {
    const artifactProvisioner =
      createContinuationRuntimeV1AuthorityArtifactProvisioner(
        database,
        ROOT_KEYS.publicKey,
      );
    const artifacts = createContinuationRuntimeV1AuthorityArtifactReader(
      database,
      ROOT_KEYS.publicKey,
    );
    const service = createContinuationRuntimeV1OfflineProvisioningService(
      database,
      artifactProvisioner,
      createContinuationRuntimeV1OperationStore(database, {
        now: () => compilerArtifact.created_at,
      }),
    );
    const installed = await service.provision(
      command as OfflinePolicyBundleInstallCommandV1,
    );
    assert.equal(installed.status, "created");
    const policies = createContinuationRuntimeV1PolicyAuthority(database, artifacts);
    const at = compilerArtifact.valid_from > evidenceArtifact.valid_from
      ? compilerArtifact.valid_from
      : evidenceArtifact.valid_from;
    const compiler = await policies.resolveCurrent({
      tenant_id: command.tenant_id,
      authority_subject_sha256: command.authority_subject_sha256,
      artifact_kind: "compiler_policy",
      at,
    });
    const evidence = await policies.resolveCurrent({
      tenant_id: command.tenant_id,
      authority_subject_sha256: command.authority_subject_sha256,
      artifact_kind: "evidence_policy",
      at,
    });
    assert.deepEqual(policies.payload(compiler), compilerArtifact.payload);
    assert.deepEqual(policies.payload(evidence), evidenceArtifact.payload);
  } finally {
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("policy bundle authoring derives exact actor/subject, signs, self-verifies, and replays deterministically", () => {
  const first = authorContinuationRuntimeV1AuthorityCommand(
    policyRequest(),
    ROOT_KEYS.privateKey,
  );
  const second = authorContinuationRuntimeV1AuthorityCommand(
    policyRequest(),
    ROOT_KEYS.privateKey,
  );
  assert.deepEqual(second, first);
  assert.equal(canonicalContinuationJson(second), canonicalContinuationJson(first));
  assert.equal(first.authority_subject_sha256, SUBJECT);
  assert.equal(first.actor_principal_sha256, continuationRuntimeV1PrincipalSha256({
    tenant_id: TENANT,
    principal_kind: "operator",
    principal_id: OPERATOR_ID,
  }));
  assertOfflineProvisioningCommandV1(first);
  const trustRoot = authorityArtifactPublicKeySha256(ROOT_KEYS.publicKey);
  for (const artifact of policyArtifacts(first)) {
    assert.deepEqual(
      verifySignedAuthorityArtifactV1(artifact, ROOT_KEYS.publicKey),
      artifact,
    );
    assert.equal(artifact.trust_root_sha256, trustRoot);
    assert.equal(artifact.signer_principal_sha256, trustRoot);
  }
});

test("authored policy command installs into fresh SQLite and resolves both current policies", async () => {
  await assertPolicyCommandInstalls(authorContinuationRuntimeV1AuthorityCommand(
    policyRequest(),
    ROOT_KEYS.privateKey,
  ));
});

test("cohort and rotation authoring validate exact V1 bindings and emit provisioner commands", () => {
  const cohort = authorContinuationRuntimeV1AuthorityCommand(
    cohortRequest(),
    ROOT_KEYS.privateKey,
  );
  assert.equal(cohort.kind, "experiment_cohort_install");
  assert.ok(cohort.experiment_cohort_artifact);
  assert.deepEqual(
    verifySignedAuthorityArtifactV1(
      cohort.experiment_cohort_artifact,
      ROOT_KEYS.publicKey,
    ),
    cohort.experiment_cohort_artifact,
  );
  assertOfflineProvisioningCommandV1({ ...cohort, assignment_seed: SEED });

  const rotation = authorContinuationRuntimeV1AuthorityCommand(
    rotationRequest(),
    ROOT_KEYS.privateKey,
  );
  assert.equal(rotation.kind, "policy_rotation_install");
  assert.ok(rotation.policy_rotation_artifact);
  assertOfflineProvisioningCommandV1(rotation);
});

test("authoring rejects unknown fields and wrong tenant, subject, cohort window, and rotation refs", () => {
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...policyRequest(),
    unknown: true,
  }, ROOT_KEYS.privateKey), "request_invalid");
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...policyRequest(),
    compiler_policy: {
      ...policyRequest().compiler_policy,
      payload: { ...compilerPayload(), tenant_id: "tenant-b" },
    },
  }, ROOT_KEYS.privateKey), "payload_binding_invalid");
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...policyRequest(),
    evidence_policy: {
      ...policyRequest().evidence_policy,
      payload: { ...evidencePayload(), authority_subject_sha256: SHA_A },
    },
  }, ROOT_KEYS.privateKey), "payload_binding_invalid");
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...policyRequest(),
    compiler_policy: {
      ...policyRequest().compiler_policy,
      payload: { ...compilerPayload(), schema_version: "compiler_policy_v2" },
    },
  }, ROOT_KEYS.privateKey), "payload_invalid");
  const badWindow = cohortRequest();
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...badWindow,
    experiment_cohort: {
      ...badWindow.experiment_cohort,
      expires_at: "2026-07-21T04:30:00.000Z",
    },
  }, ROOT_KEYS.privateKey), "payload_invalid");
  const badRotation = rotationRequest();
  authoringFailure(() => authorContinuationRuntimeV1AuthorityCommand({
    ...badRotation,
    policy_rotation: {
      ...badRotation.policy_rotation,
      payload: {
        ...badRotation.policy_rotation.payload,
        new_compiler_policy_ref:
          badRotation.policy_rotation.payload.old_compiler_policy_ref,
        new_evidence_policy_ref:
          badRotation.policy_rotation.payload.old_evidence_policy_ref,
      },
    },
  }, ROOT_KEYS.privateKey), "payload_invalid");
});

test("CLI accepts canonical regular-file FD3 and emits only the direct command", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-authoring-"));
  try {
    const keyPath = writeKey(root, ROOT_KEYS.privateKey);
    const request = canonicalContinuationJson(policyRequest());
    const first = runCli(request, keyPath);
    const second = runCli(`${request}\n`, keyPath);
    assert.equal(first.status, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.status, 0);
    assert.equal(second.stderr, "");
    assert.equal(second.stdout, first.stdout);
    assert.equal(first.stdout, `${canonicalContinuationJson(JSON.parse(first.stdout))}\n`);
    assert.equal(first.stdout.includes("BEGIN PRIVATE KEY"), false);
    assertOfflineProvisioningCommandV1(JSON.parse(first.stdout));
    chmodSync(keyPath, 0o400);
    const readOnly = runCli(request, keyPath);
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.equal(readOnly.stdout, first.stdout);

    const preload = join(root, "hostile-preload.mjs");
    const leak = join(root, "fd3-leak.bin");
    writeFileSync(preload, `
      import { readFileSync, writeFileSync } from "node:fs";
      try { writeFileSync(${JSON.stringify(leak)}, readFileSync(3)); } catch {}
    `, { mode: 0o600 });
    const cleanEnvironment = runCli(request, keyPath, {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      NODE_PATH: root,
    });
    assert.equal(cleanEnvironment.status, 0, cleanEnvironment.stderr);
    assert.equal(cleanEnvironment.stdout, first.stdout);
    assert.equal(statSync(root).isDirectory(), true);
    assert.equal(existsSync(leak), false,
      "clean env must run before the shell opens the root-key descriptor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux/macOS plain-Node keygen creates fresh 0700/0600 role-separated keys", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-keygen-parent-"));
  const destination = join(root, "authority");
  try {
    const generated = spawnSync("/bin/sh", [
      "-c",
      "umask 0777; exec \"$1\" \"$2\" \"$3\"",
      "authority-keygen",
      process.execPath,
      AUTHORITY_KEYGEN_TOOL,
      destination,
    ], { cwd: PROJECT_ROOT, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(generated.stderr, "");
    assert.equal(generated.stdout.includes("PRIVATE KEY"), false);
    const event = JSON.parse(generated.stdout) as {
      schema_version: string;
      event: string;
      trust_root_sha256: string;
      effect_signer_sha256: string;
    };
    assert.equal(event.schema_version,
      "continuation_runtime_v1_authority_key_generation_event_v1");
    assert.equal(event.event, "authority_keys_generated");
    assert.match(event.trust_root_sha256, /^[0-9a-f]{64}$/u);
    assert.match(event.effect_signer_sha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(event.effect_signer_sha256, event.trust_root_sha256);
    assert.equal(statSync(destination).mode & 0o777, 0o700);
    for (const name of [
      "root-private.pem", "root-public.pem",
      "effect-private.pem", "effect-public.pem",
    ]) {
      const status = statSync(join(destination, name));
      assert.equal(status.isFile(), true);
      assert.equal(status.nlink, 1);
      assert.equal(status.mode & 0o777, 0o600);
    }
    const rootPublic = createPublicKey(readFileSync(join(destination, "root-public.pem")));
    const effectPublic = createPublicKey(readFileSync(join(destination, "effect-public.pem")));
    for (const [key, expected] of [
      [rootPublic, event.trust_root_sha256],
      [effectPublic, event.effect_signer_sha256],
    ] as const) {
      assert.equal(createHash("sha256").update(
        key.export({ format: "der", type: "spki" }),
      ).digest("hex"), expected);
    }
    const privatePath = join(destination, "root-private.pem");
    const before = readFileSync(privatePath);
    const authored = runCli(canonicalContinuationJson(policyRequest()), privatePath);
    assert.equal(authored.status, 0, authored.stderr);
    assert.equal(JSON.parse(authored.stdout).policy_bundle.compiler_policy
      .trust_root_sha256, event.trust_root_sha256);
    const replayedKeygen = spawnSync(process.execPath, [
      AUTHORITY_KEYGEN_TOOL, destination,
    ], { cwd: PROJECT_ROOT, encoding: "utf8" });
    assert.equal(replayedKeygen.status, 1);
    assert.equal(replayedKeygen.stdout, "");
    assert.equal(replayedKeygen.stderr,
      "continuation_runtime_v1_authority_key_generation_failed:destination_create_failed\n");
    assert.deepEqual(readFileSync(privatePath), before,
      "O_EXCL key generation must never overwrite an existing root");
    before.fill(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all tracked templates author and provision a real policy-cohort-rotation chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-template-chain-"));
  const keyPath = writeKey(root, ROOT_KEYS.privateKey);
  const seedPath = join(root, "cohort-assignment-seed.bin");
  const publicKeyPath = join(root, "authority-root.public.pem");
  let current: AuthorityChainFixture | null = null;
  let databaseClosed = false;
  let seed: Buffer | null = null;
  try {
    const generatedSeed = spawnSync("/bin/sh", [
      "-c",
      "umask 0777; exec \"$1\" \"$2\" \"$3\"",
      "cohort-seed-generation",
      process.execPath,
      COHORT_SEEDGEN_TOOL,
      seedPath,
    ], { cwd: PROJECT_ROOT, encoding: "utf8" });
    assert.equal(generatedSeed.status, 0, generatedSeed.stderr);
    assert.equal(generatedSeed.stderr, "");
    const seedEvent = JSON.parse(generatedSeed.stdout) as {
      schema_version: string;
      event: string;
      assignment_seed_bytes: number;
      assignment_seed_file_mode: string;
      assignment_seed_commitment_sha256: Sha256;
    };
    assert.deepEqual(seedEvent, {
      schema_version: "continuation_runtime_v1_cohort_seed_generation_event_v1",
      event: "cohort_seed_generated",
      assignment_seed_bytes: 32,
      assignment_seed_file_mode: "0600",
      assignment_seed_commitment_sha256:
        seedEvent.assignment_seed_commitment_sha256,
    });
    assert.match(seedEvent.assignment_seed_commitment_sha256, /^[0-9a-f]{64}$/u);
    const seedStatus = statSync(seedPath);
    assert.equal(seedStatus.isFile(), true);
    assert.equal(seedStatus.nlink, 1);
    assert.equal(seedStatus.size, 32);
    assert.equal(seedStatus.mode & 0o777, 0o600,
      "hostile umask must not weaken or remove owner seed access");
    seed = readFileSync(seedPath);
    assert.equal(
      assignmentSeedCommitmentSha256V1(seed),
      seedEvent.assignment_seed_commitment_sha256,
    );

    current = authorityChainFixture(root);
    const policyV1Child = runCli(
      canonicalContinuationJson(rewrittenPolicyTemplate("install-policy-v1", 1)),
      keyPath,
    );
    assert.equal(policyV1Child.status, 0, policyV1Child.stderr);
    assert.equal(policyV1Child.stderr, "");
    const policyV1 = JSON.parse(policyV1Child.stdout) as
      OfflinePolicyBundleInstallCommandV1;
    assertOfflineProvisioningCommandV1(policyV1);
    assert.equal(policyV1.kind, "policy_bundle_install");
    assert.equal((await current.provisioning.provision(policyV1)).status, "created");

    const learningPair = await seedRealLearningPair(current);
    const cohortChild = runCli(canonicalContinuationJson(rewrittenCohortTemplate(
      learningPair,
      policyV1.policy_bundle,
      seed,
    )), keyPath);
    assert.equal(cohortChild.status, 0, cohortChild.stderr);
    assert.equal(cohortChild.stderr, "");
    const cohortWire = JSON.parse(cohortChild.stdout) as Omit<
      OfflineExperimentCohortInstallCommandV1,
      "assignment_seed"
    >;
    const cohort = { ...cohortWire, assignment_seed: seed } as
      OfflineExperimentCohortInstallCommandV1;
    assertOfflineProvisioningCommandV1(cohort);
    const cohortCreated = await current.provisioning.provision(cohort);
    assert.equal(cohortCreated.status, "created");
    assert.equal(cohortCreated.receipt.result.decision_kind,
      "experiment_cohort_install");

    const policyV2Child = runCli(
      canonicalContinuationJson(rewrittenPolicyTemplate("install-policy-v2", 2)),
      keyPath,
    );
    assert.equal(policyV2Child.status, 0, policyV2Child.stderr);
    const policyV2 = JSON.parse(policyV2Child.stdout) as
      OfflinePolicyBundleInstallCommandV1;
    assertOfflineProvisioningCommandV1(policyV2);
    assert.notDeepEqual(
      artifactRef(policyV2.policy_bundle.compiler_policy),
      artifactRef(policyV1.policy_bundle.compiler_policy),
    );
    assert.notDeepEqual(
      artifactRef(policyV2.policy_bundle.evidence_policy),
      artifactRef(policyV1.policy_bundle.evidence_policy),
    );
    assert.equal((await current.provisioning.provision(policyV2)).status, "created");

    const rotationChild = runCli(canonicalContinuationJson(rewrittenRotationTemplate(
      learningPair.control,
      policyV1.policy_bundle,
      policyV2.policy_bundle,
    )), keyPath);
    assert.equal(rotationChild.status, 0, rotationChild.stderr);
    assert.equal(rotationChild.stderr, "");
    const rotation = JSON.parse(rotationChild.stdout) as
      OfflinePolicyRotationInstallCommandV1;
    assertOfflineProvisioningCommandV1(rotation);
    const rotationCreated = await current.provisioning.provision(rotation);
    assert.equal(rotationCreated.status, "created");
    assert.equal(rotationCreated.receipt.result.decision_kind,
      "policy_rotation_install");

    assert.equal((current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM authority_artifacts",
    ).get() as { count: number }).count, 6);
    assert.equal((current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM durable_jobs",
    ).get() as { count: number }).count, 1);
    const protectedSeed = current.database.db.prepare(
      `SELECT protected_secret FROM authority_artifacts
        WHERE tenant_id = ? AND artifact_kind = 'experiment_cohort'`,
    ).get(TENANT) as { protected_secret: Uint8Array };
    assert.deepEqual(Buffer.from(protectedSeed.protected_secret), seed);

    writeFileSync(
      publicKeyPath,
      ROOT_KEYS.publicKey.export({ format: "pem", type: "spki" }),
      { mode: 0o600 },
    );
    chmodSync(publicKeyPath, 0o600);
    await current.database.close();
    databaseClosed = true;
    const seedDescriptor = openSync(seedPath, "r");
    try {
      const directProvision = spawnSync(
        process.execPath,
        ["--import", "tsx", PROVISIONING_ENTRY],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          input: `${canonicalContinuationJson(cohortWire)}\n`,
          env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            NODE_NO_WARNINGS: "1",
            AIONIS_DATA_PATH: current.dataPath,
            AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: publicKeyPath,
            AIONIS_TRUST_ROOT_SHA256:
              authorityArtifactPublicKeySha256(ROOT_KEYS.publicKey),
            AIONIS_PROVISIONING_SEED_FD: "3",
          },
          stdio: ["pipe", "pipe", "pipe", seedDescriptor],
        },
      );
      assert.equal(directProvision.status, 0, directProvision.stderr);
      assert.equal(directProvision.stderr, "");
      const event = JSON.parse(directProvision.stdout) as {
        event: string;
        operation: { status: string; receipt_sha256: string };
        public_config: { assignmentSeedFdConfigured: boolean };
      };
      assert.equal(event.event, "provisioning_complete");
      assert.equal(event.operation.status, "replayed");
      assert.equal(
        event.operation.receipt_sha256,
        cohortCreated.receipt_sha256,
      );
      assert.equal(event.public_config.assignmentSeedFdConfigured, true);
      assert.equal(directProvision.stdout.includes(seed.toString("hex")), false);
      assert.equal(directProvision.stdout.includes(seed.toString("base64")), false);
    } finally {
      closeSync(seedDescriptor);
    }

    const replayedSeedGeneration = spawnSync(process.execPath, [
      COHORT_SEEDGEN_TOOL, seedPath,
    ], { cwd: PROJECT_ROOT, encoding: "utf8" });
    assert.equal(replayedSeedGeneration.status, 1);
    assert.equal(replayedSeedGeneration.stdout, "");
    assert.equal(replayedSeedGeneration.stderr,
      "continuation_runtime_v1_cohort_seed_generation_failed:destination_create_failed\n");
  } finally {
    seed?.fill(0);
    if (current !== null && !databaseClosed) await current.database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI accepts an inherited FIFO broker without materializing a key path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-fifo-"));
  try {
    const keyPath = writeKey(root, ROOT_KEYS.privateKey);
    const result = await runCliWithFifo(
      canonicalContinuationJson(rotationRequest()),
      keyPath,
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assertOfflineProvisioningCommandV1(JSON.parse(result.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects noncanonical, oversized, and unknown-field requests with safe stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-input-"));
  try {
    const keyPath = writeKey(root, ROOT_KEYS.privateKey);
    const noncanonical = runCli(JSON.stringify(policyRequest(), null, 2), keyPath);
    assert.equal(noncanonical.status, 1);
    assert.equal(noncanonical.stdout, "");
    assert.equal(noncanonical.stderr,
      "continuation_runtime_v1_authority_authoring_failed:request_must_use_canonical_json\n");
    const oversized = runCli(`{"padding":"${"x".repeat(1024 * 1024)}"}`);
    assert.equal(oversized.status, 1);
    assert.equal(oversized.stdout, "");
    assert.equal(oversized.stderr,
      "continuation_runtime_v1_authority_authoring_failed:request_too_large\n");
    const unknown = runCli(canonicalContinuationJson({
      ...policyRequest(),
      private_key_path: keyPath,
    }), keyPath);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout, "");
    assert.equal(unknown.stderr,
      "continuation_runtime_v1_authority_authoring_failed:request_invalid\n");
    assert.equal(unknown.stderr.includes(keyPath), false);
    assert.equal(unknown.stderr.includes(TENANT), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FD3 rejects absent, directory, weak-mode, hard-linked, and wrong-key descriptors", () => {
  const root = mkdtempSync(join(tmpdir(), "aionis-authority-fd-"));
  const request = canonicalContinuationJson(policyRequest());
  try {
    const absent = runCli(request);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr,
      /^continuation_runtime_v1_authority_authoring_failed:root_key_(?:descriptor_unreadable|descriptor_type_invalid|link_count_invalid)\n$/u);

    const directory = runCli(request, root);
    assert.equal(directory.status, 1);
    assert.equal(directory.stderr,
      "continuation_runtime_v1_authority_authoring_failed:root_key_descriptor_type_invalid\n");

    const weak = writeKey(root, ROOT_KEYS.privateKey, 0o644);
    const weakResult = runCli(request, weak);
    assert.equal(weakResult.status, 1);
    assert.equal(weakResult.stderr,
      "continuation_runtime_v1_authority_authoring_failed:root_key_permissions_invalid\n");

    chmodSync(weak, 0o600);
    const secondLink = join(root, "authority-root-link.pem");
    linkSync(weak, secondLink);
    const linked = runCli(request, weak);
    assert.equal(linked.status, 1);
    assert.equal(linked.stderr,
      "continuation_runtime_v1_authority_authoring_failed:root_key_link_count_invalid\n");
    rmSync(secondLink);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeKey(root, rsa.privateKey);
    const wrongKey = runCli(request, weak);
    assert.equal(wrongKey.status, 1);
    assert.equal(wrongKey.stdout, "");
    assert.equal(wrongKey.stderr,
      "continuation_runtime_v1_authority_authoring_failed:root_key_must_be_ed25519\n");
    const pem = readFileSync(weak, "utf8");
    assert.equal(wrongKey.stderr.includes(pem.slice(0, 32)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(
  overrides: Partial<AuthorityRootDescriptorSnapshot> = {},
): AuthorityRootDescriptorSnapshot {
  return {
    kind: "regular",
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    nlink: 1n,
    uid: 501n,
    gid: 20n,
    rdev: 0n,
    size: 119n,
    mtime_ns: 3n,
    ctime_ns: 4n,
    ...overrides,
  };
}

test("descriptor owner and every stable regular-file identity fence fail closed", () => {
  assert.throws(
    () => assertAuthorityRootDescriptorPosture(snapshot({ uid: 502n }), 501),
    (error) => error instanceof AuthorityRootKeyError
      && error.code === "root_key_owner_invalid",
  );
  const before = snapshot();
  for (const after of [
    snapshot({ dev: 9n }),
    snapshot({ ino: 9n }),
    snapshot({ mode: 0o100400n }),
    snapshot({ nlink: 2n }),
    snapshot({ uid: 0n }),
    snapshot({ gid: 0n }),
    snapshot({ size: 120n }),
    snapshot({ mtime_ns: 9n }),
    snapshot({ ctime_ns: 9n }),
  ]) {
    assert.throws(
      () => assertAuthorityRootDescriptorStable(before, after),
      (error) => error instanceof AuthorityRootKeyError
        && error.code === "root_key_changed_during_read",
    );
  }
  assert.doesNotThrow(() => assertAuthorityRootDescriptorPosture(snapshot({
    kind: "fifo",
    mode: 0o010600n,
    size: 0n,
  }), 501));
  for (const fifo of [
    snapshot({ kind: "fifo", mode: 0o010666n, size: 0n }),
    snapshot({ kind: "fifo", mode: 0o010600n, nlink: 2n, size: 0n }),
  ]) {
    assert.throws(
      () => assertAuthorityRootDescriptorPosture(fifo, 501),
      (error) => error instanceof AuthorityRootKeyError
        && (error.code === "root_key_permissions_invalid"
          || error.code === "root_key_link_count_invalid"),
    );
  }
});

test("plain-Node authoring closure is deterministic, third-party-free, and excluded from Runtime", () => {
  const packageJson = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  )) as { private: boolean; files?: string[]; scripts: Record<string, string> };
  assert.equal(packageJson.private, true);
  assert.equal(Object.hasOwn(packageJson, "files"), false,
    "the private Runtime root is an OCI build manifest, not an npm artifact");
  const sdkPackage = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../packages/sdk/package.json", import.meta.url)),
    "utf8",
  )) as { files: string[] };
  assert.equal(sdkPackage.files.some((entry) => entry === "tools"
    || entry.startsWith("tools/")), false);
  assert.equal(packageJson.scripts["authority:author"], undefined,
    "npm reserves FD 3; root-key authoring must bypass npm");
  assert.equal(packageJson.scripts["authority:build"],
    "node tools/build-continuation-runtime-v1-authority.mjs");
  assert.equal(packageJson.scripts["authority:keys"], undefined);
  assert.equal(packageJson.scripts["authority:seed"], undefined);
  const dockerfile = readFileSync(
    fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
    "utf8",
  );
  const runtime = dockerfile.slice(dockerfile.indexOf(" AS runtime\n"));
  assert.equal(runtime.includes("COPY tools"), false);
  assert.equal(runtime.includes("authority-root"), false);
  assert.equal(runtime.includes("dist-authority"), false);
  const readme = readFileSync(
    fileURLToPath(new URL("../../README.md", import.meta.url)),
    "utf8",
  );
  assert.equal(
    readme.includes("node --import tsx tools/author-continuation-runtime-v1-authority"),
    false,
  );
  assert.equal(
    /AIONIS_PROVISIONING_SEED_FD=3\s+npm/gu.test(readme),
    false,
  );
  assert.equal(readme.includes(
    "exec \"$1\" \"$2\" 3<\"$3\" <\"$4\" >\"$5\"",
  ), true);
  assert.equal(readme.includes(
    "export AIONIS_PROVISIONING_SEED_FD=3",
  ), true);
  assert.equal(readme.includes("node \"$AUTHORITY_AUTHOR\""), false);
  for (const field of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_*"]) {
    assert.equal(readme.includes(field), true);
  }
  const manifestText = readFileSync(AUTHORITY_BUILD_MANIFEST, "utf8");
  const manifest = JSON.parse(manifestText) as {
    schema_version: string;
    entrypoint: string;
    closure_sha256: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(manifestText, `${canonicalContinuationJson(manifest)}\n`);
  assert.equal(manifest.schema_version,
    "continuation_runtime_v1_authority_build_manifest_v1");
  assert.equal(manifest.entrypoint,
    "tools/author-continuation-runtime-v1-authority.js");
  assert.equal(manifest.files.some((entry) => entry.path.includes("node_modules")), false);
  assert.equal(manifest.files.some((entry) => entry.path.includes("runtime-v1/config")), false,
    "offline authoring must not pull daemon configuration into the root-key closure");
  for (const entry of manifest.files) {
    const path = join(PROJECT_ROOT, "dist-authority", entry.path);
    const status = statSync(path);
    assert.equal(status.isFile(), true);
    assert.equal(status.nlink, 1);
    assert.equal(status.mode & 0o777, 0o400,
      "hostile umask must not leave the root-key executable closure writable");
    const bytes = readFileSync(path);
    assert.equal(bytes.byteLength, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
  assert.equal(createHash("sha256").update(canonicalContinuationJson({
    files: manifest.files,
  }), "utf8").digest("hex"), manifest.closure_sha256);
  const entrySource = readFileSync(TOOL, "utf8");
  assert.equal(entrySource.includes("tsx"), false);
  assert.equal(entrySource.includes("esbuild"), false);
  assert.equal(entrySource.includes("node_modules"), false);
  const manifestStatus = statSync(AUTHORITY_BUILD_MANIFEST);
  assert.equal(manifestStatus.nlink, 1);
  assert.equal(manifestStatus.mode & 0o777, 0o600);
  assert.equal(statSync(join(PROJECT_ROOT, "dist-authority")).mode & 0o777, 0o700);
  const rebuilt = spawnSync(process.execPath, [AUTHORITY_BUILD_TOOL], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(rebuilt.stderr, "");
  assert.equal(readFileSync(AUTHORITY_BUILD_MANIFEST, "utf8"), manifestText,
    "same exact source tree must reproduce the same authoring closure manifest");
  const keySource = readFileSync(fileURLToPath(new URL(
    "../../tools/continuation-runtime-v1-authority-key.ts",
    import.meta.url,
  )), "utf8");
  assert.equal(keySource.includes("bytes.toString"), false,
    "root private key bytes must never be copied into a non-zeroizable JS string");
  assert.equal(keySource.includes("process.env"), false);
  assert.equal(keySource.includes("openSync"), false,
    "the root key reader accepts only its inherited descriptor");
});
