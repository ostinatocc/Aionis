import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSignedAuthorityArtifactV1 } from
  "../../src/continuation/authority-artifact.js";
import type {
  AuthorityBranchManifestV1,
  AuthoritativeBranchRevisionRefV1,
} from
  "../../src/continuation/authority-branch.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import { canonicalContinuationSha256 } from
  "../../src/continuation/contract.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import {
  authorityBranchBindingSetSha256V1,
  buildPolicyRotationPayloadV1,
} from "../../src/continuation/policy-rotation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.js";
import {
  ContinuationRuntimeV1AuthorityHeadConflictError,
  createContinuationRuntimeV1AuthorityStore,
} from "../../src/store/continuation-runtime-v1-authority-store.js";
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
  type ContinuationRuntimeV1OperationKind,
} from "../../src/store/continuation-runtime-v1-operation-store.js";
import {
  ContinuationRuntimeV1PolicyAmbiguityError,
  ContinuationRuntimeV1PolicyUnavailableError,
  createContinuationRuntimeV1PolicyAuthority,
} from "../../src/store/continuation-runtime-v1-policy-authority.js";

const ROOT_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-authority";
const SCOPE = "scope-authority";
const FAMILY = "repair";
const HOST = "1".repeat(64);
const OPERATOR = "2".repeat(64);
const WORKER = "3".repeat(64);
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: FAMILY,
});
let sequence = 0;

function plus(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function fixture() {
  sequence += 1;
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-authority-"));
  const path = join(root, "runtime", "runtime.sqlite");
  const clock = { value: "2026-07-21T01:00:00.000Z" };
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: sequence.toString(16).padStart(64, "0"),
    now: () => "2026-07-21T00:00:00.000Z",
  });
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
    { now: () => clock.value },
  );
  return {
    root,
    path,
    clock,
    database,
    operations,
    artifactProvisioner,
    artifacts,
    policies,
    effects,
    authority,
    observations: createContinuationRuntimeV1ObservationStore(database, {
      now: () => clock.value,
    }),
    memory: createContinuationRuntimeV1MemoryStore(database, {
      now: () => clock.value,
    }),
  };
}

type Fixture = ReturnType<typeof fixture>;

function advance(current: Fixture): void {
  current.clock.value = plus(current.clock.value, 1);
}

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
  let value: T | null = null;
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: kind,
    operationId,
    ...actor(kind),
    request: { operation_id: operationId },
    produce: async (context) => {
      value = await produce(context);
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
  return value!;
}

function compilerArtifact(revision: number, artifactId: string, key = ROOT_KEYS.privateKey) {
  return buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: artifactId,
    artifact_revision: revision,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: buildContinuationCompilerPolicyV1({
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
        external_verifier: [WORKER],
      },
    }),
    valid_from: "2026-07-21T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  }, key);
}

function evidenceArtifact(revision: number, artifactId: string, key = ROOT_KEYS.privateKey) {
  return buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: artifactId,
    artifact_revision: revision,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: buildEffectEvidencePolicyV1({
      schema_version: "effect_evidence_policy_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      trusted_effect_verifier_principals: [WORKER],
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
    valid_from: "2026-07-21T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  }, key);
}

async function installPolicies(
  current: Fixture,
  revision = 1,
  prefix = `policy-${revision}`,
  key = ROOT_KEYS.privateKey,
) {
  const compiler = compilerArtifact(revision, `${prefix}-compiler`, key);
  const evidence = evidenceArtifact(revision, `${prefix}-evidence`, key);
  await operation(current, "authority_decision", `install-${prefix}`, (context) =>
    current.artifactProvisioner.putBundle(context, {
      schema_version: "authority_policy_provisioning_bundle_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      compiler_policy: compiler,
      evidence_policy: evidence,
    }));
  advance(current);
  return { compiler, evidence };
}

async function putObservation(
  current: Fixture,
  context: ContinuationRuntimeV1AuthorityWriteContext,
  operationId: string,
): Promise<void> {
  await current.observations.put(context, {
    host_task_envelope: {
      host_task_id: `task-${operationId}`,
      episode_id: `episode-${operationId}`,
      run_id: `run-${operationId}`,
      consumer_agent_id: "authority-test-agent",
      consumer_team_id: null,
      task_family: FAMILY,
      task_signature: "authority-test-signature",
      workflow_signature: null,
      workspace_signature: "authority-test-workspace",
      source_task_sha256: canonicalContinuationSha256({ operationId, kind: "task" }),
      source_event_sha256: canonicalContinuationSha256({ operationId, kind: "event" }),
      issued_at: current.clock.value,
      expires_at: plus(current.clock.value, 3_600_000),
    },
    collector_observations: [],
    signed_observations: [],
  });
}

async function ensureGenesis(current: Fixture, operationId: string) {
  const result = await operation(
    current,
    "record_observations",
    operationId,
    async (context) => {
      await putObservation(current, context, operationId);
      const head = await current.memory.readHead(TENANT, SCOPE);
      await current.memory.appendMemoryRevision(context, {
        expected_head_revision: head?.head_revision ?? null,
        items: head === null ? [] : [{
          memory_id: `observation-root-${operationId}`,
          memory_kind: "observation_root",
          lifecycle: "active",
          authority: "verified",
          hydrated: true,
          projection: { operation_id: operationId },
          rehydration_ref: null,
          expires_at: null,
        }],
        relations: [],
        capsules: [],
      });
      return current.authority.ensureGenesis(context);
    },
  );
  advance(current);
  return result;
}

function basicRef(manifest: AuthorityBranchManifestV1) {
  return {
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
  };
}

function fullRef(manifest: AuthorityBranchManifestV1) {
  return {
    ...basicRef(manifest),
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  };
}

async function createLearningDraft(
  current: Fixture,
  operationId: string,
  head: Awaited<ReturnType<typeof ensureGenesis>>["head"],
) {
  const result = await operation(
    current,
    "record_observations",
    operationId,
    async (context) => {
      await putObservation(current, context, operationId);
      const memoryHead = await current.memory.readHead(TENANT, SCOPE);
      await current.memory.appendMemoryRevision(context, {
        expected_head_revision: memoryHead!.head_revision,
        items: [{
          memory_id: `learning-memory-${operationId}`,
          memory_kind: "procedure",
          lifecycle: "active",
          authority: "candidate",
          hydrated: true,
          projection: { operation_id: operationId },
          rehydration_ref: null,
          expires_at: null,
        }],
        relations: [],
        capsules: [{
          memory_id: `learning-memory-${operationId}`,
          draft: {
            capsule_id: `learning-capsule-${operationId}`,
            kind: "procedure",
            proposed_influence: "use",
            applicability: {
              task_family: FAMILY,
              task_signature: "authority-test-signature",
              workflow_signature: null,
              workspace_signature: "authority-test-workspace",
              producer_agent_id: "authority-test-agent",
              owner_agent_id: null,
              owner_team_id: null,
            },
            projection: {
              summary: "Use the admitted procedure",
              next_action: "Execute the verified procedure",
              target_refs: [{ kind: "memory", ref: "learning-procedure" }],
              workflow_steps: ["inspect", "execute", "verify"],
              acceptance_statements: ["procedure outcome verified"],
            },
            coverage_claims: [{
              obligation_kind: "required_state",
              target_refs: [{ kind: "memory", ref: "learning-procedure" }],
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
      const draft = await current.authority.createIsolatedCandidateDraft(context, {
        expected_head_revision: head.head_revision,
        expected_head_sha256: head.head_sha256,
      });
      assert.ok(draft);
      return draft;
    },
  );
  advance(current);
  return result;
}

async function installRotation(
  current: Fixture,
  previous: AuthorityBranchManifestV1,
  policies: Awaited<ReturnType<typeof installPolicies>>,
  artifactId = "rotation-main",
) {
  const payload = buildPolicyRotationPayloadV1({
    schema_version: "policy_rotation_v1",
    tenant_id: TENANT,
    authority_subject_sha256: SUBJECT,
    previous_authoritative_ref: fullRef(previous) as
      AuthoritativeBranchRevisionRefV1,
    old_compiler_policy_ref: previous.compiler_policy_ref,
    new_compiler_policy_ref: {
      artifact_sha256: policies.compiler.artifact_sha256,
      payload_sha256: policies.compiler.payload_sha256,
    },
    old_evidence_policy_ref: previous.evidence_policy_ref,
    new_evidence_policy_ref: {
      artifact_sha256: policies.evidence.artifact_sha256,
      payload_sha256: policies.evidence.payload_sha256,
    },
    previous_binding_set_sha256: authorityBranchBindingSetSha256V1(
      previous.capsule_bindings,
    ),
  });
  const artifact = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: artifactId,
    artifact_revision: 1,
    artifact_kind: "policy_rotation",
    artifact_schema: "policy_rotation_v1",
    authority_subject_sha256: SUBJECT,
    payload,
    valid_from: "2026-07-21T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  }, ROOT_KEYS.privateKey);
  await operation(current, "authority_decision", `install-${artifactId}`,
    (context) => current.artifactProvisioner.put(context, artifact));
  advance(current);
  return artifact;
}

test("lazy genesis is deterministic, immutable, and survives exact reopen", async () => {
  const current = fixture();
  let database: ContinuationRuntimeV1Database | null = current.database;
  try {
    const policies = await installPolicies(current);
    const [first, second] = await Promise.all([
      ensureGenesis(current, "genesis-a"),
      ensureGenesis(current, "genesis-b"),
    ]);
    assert.equal([first.created, second.created].filter(Boolean).length, 1);
    assert.equal(first.head.head_sha256, second.head.head_sha256);
    assert.equal(first.revision.manifest.branch_kind, "authoritative");
    assert.equal(first.revision.manifest.capsule_bindings.length, 0);
    assert.deepEqual(first.revision.manifest.compiler_policy_ref, {
      artifact_sha256: policies.compiler.artifact_sha256,
      payload_sha256: policies.compiler.payload_sha256,
    });
    assert.equal(Object.isFrozen(first.head), true);
    assert.equal(current.database.db.prepare(
      "SELECT COUNT(*) AS count FROM authority_heads",
    ).get()?.count, 1);

    const expected = first.head;
    await database.close();
    database = null;
    const reopened = openContinuationRuntimeV1Database(current.path);
    database = reopened;
    const artifacts = createContinuationRuntimeV1AuthorityArtifactReader(
      reopened,
      ROOT_KEYS.publicKey,
    );
    const policyAuthority = createContinuationRuntimeV1PolicyAuthority(
      reopened,
      artifacts,
    );
    const effects = createContinuationRuntimeV1EffectCertificateReader(
      reopened,
      artifacts,
      policyAuthority,
    );
    const authority = createContinuationRuntimeV1AuthorityStore(
      reopened,
      artifacts,
      policyAuthority,
      effects,
    );
    assert.deepEqual(await authority.readHead({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
    }), expected);
  } finally {
    await database?.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("genesis rejects unavailable, ambiguous, and untrusted policy bundles atomically", async () => {
  const current = fixture();
  try {
    await assert.rejects(
      ensureGenesis(current, "genesis-without-policy"),
      ContinuationRuntimeV1PolicyUnavailableError,
    );
    assert.equal(await current.memory.readHead(TENANT, SCOPE), null);

    await installPolicies(current, 1, "ambiguous-a");
    await installPolicies(current, 2, "ambiguous-b");
    await assert.rejects(
      ensureGenesis(current, "genesis-with-ambiguous-policy"),
      ContinuationRuntimeV1PolicyAmbiguityError,
    );
    assert.equal(await current.authority.readHead({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
    }), null);

    const compiler = compilerArtifact(3, "untrusted-compiler", OTHER_KEYS.privateKey);
    const evidence = evidenceArtifact(3, "untrusted-evidence", OTHER_KEYS.privateKey);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "install-untrusted-policy",
      (context) => current.artifactProvisioner.putBundle(context, {
        schema_version: "authority_policy_provisioning_bundle_v1",
        tenant_id: TENANT,
        authority_subject_sha256: SUBJECT,
        compiler_policy: compiler,
        evidence_policy: evidence,
      }),
    ), /trust_root_mismatch|signature_invalid/u);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("every later candidate receipt carries its immutable control head for operator CAS", async () => {
  const current = fixture();
  try {
    await installPolicies(current);
    const genesis = await ensureGenesis(current, "receipt-control-genesis");
    const operationId = "receipt-control-candidate";
    const draft = await createLearningDraft(current, operationId, genesis.head);
    const result = deriveContinuationRuntimeV1OperationResultV1(current.database, {
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "record_observations",
      operationId,
      requestSha256: canonicalContinuationSha256({ operation_id: operationId }),
      actorKind: "trusted_host",
      actorPrincipalSha256: HOST,
    }, "replay");
    assert.equal(result.schema_version, "record_observations_result_v1");
    assert.equal(result.authority_branch_set.count, 2);
    const control = result.authority_branch_set.refs.find(
      (ref) => ref.branch_kind === "authoritative",
    );
    const candidate = result.authority_branch_set.refs.find(
      (ref) => ref.branch_kind === "candidate",
    );
    assert.ok(control);
    assert.ok(candidate);
    assert.deepEqual({
      branch_id: control.branch_id,
      branch_revision: control.branch_revision,
      manifest_sha256: control.manifest_sha256,
      branch_state: control.branch_state,
      authority_head_ref: control.authority_head_ref,
    }, {
      branch_id: genesis.revision.manifest.branch_id,
      branch_revision: genesis.revision.manifest.branch_revision,
      manifest_sha256: genesis.revision.manifest.manifest_sha256,
      branch_state: "authoritative",
      authority_head_ref: {
        head_revision: genesis.head.head_revision,
        head_sha256: genesis.head.head_sha256,
      },
    });
    assert.deepEqual({
      branch_id: candidate.branch_id,
      branch_revision: candidate.branch_revision,
      manifest_sha256: candidate.manifest_sha256,
      branch_state: candidate.branch_state,
      authority_head_ref: candidate.authority_head_ref,
    }, {
      branch_id: draft.revision.manifest.branch_id,
      branch_revision: draft.revision.manifest.branch_revision,
      manifest_sha256: draft.revision.manifest.manifest_sha256,
      branch_state: "draft",
      authority_head_ref: null,
    });
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("candidate transitions are closed and never move the authoritative head", async () => {
  const current = fixture();
  try {
    await installPolicies(current);
    const genesis = await ensureGenesis(current, "candidate-genesis");
    const draft = await createLearningDraft(current, "candidate-draft", genesis.head);
    assert.equal(draft.revision.manifest.state, "draft");
    assert.equal(draft.revision.manifest.capsule_bindings.length, 1);
    assert.deepEqual(draft.revision.manifest.base_authoritative_ref, genesis.head.target);
    assert.equal(draft.head.head_sha256, genesis.head.head_sha256);

    await assert.rejects(operation(
      current,
      "authority_decision",
      "candidate-stale-cas",
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: basicRef(draft.revision.manifest),
        target_state: "shadow",
        reason_codes: ["verified_offline_evidence"],
        evidence_sha256s: ["a".repeat(64)],
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: "f".repeat(64),
      }),
    ), ContinuationRuntimeV1AuthorityHeadConflictError);
    const shadow = await operation(
      current,
      "authority_decision",
      "candidate-shadow",
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: basicRef(draft.revision.manifest),
        target_state: "shadow",
        reason_codes: ["verified_offline_evidence"],
        evidence_sha256s: ["b".repeat(64)],
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    );
    advance(current);
    const rejected = await operation(
      current,
      "authority_decision",
      "candidate-rejected",
      (context) => current.authority.terminateCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: basicRef(shadow.revision.manifest),
        target_state: "rejected",
        reason_codes: ["failed_offline_evidence"],
        evidence_sha256s: ["c".repeat(64)],
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    );
    advance(current);
    await assert.rejects(operation(
      current,
      "authority_decision",
      "terminal-candidate-retry",
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: basicRef(rejected.revision.manifest),
        target_state: "shadow",
        reason_codes: ["invalid_retry"],
        evidence_sha256s: ["d".repeat(64)],
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    ), /transition|terminal|candidate_not_current/u);
    assert.equal((await current.authority.readHead({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
    }))?.head_sha256, genesis.head.head_sha256);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("root-signed rotation and same-chain revert are the only public head mutations", async () => {
  const current = fixture();
  try {
    await installPolicies(current);
    const genesis = await ensureGenesis(current, "rotation-genesis");
    const oldCandidate = await createLearningDraft(
      current,
      "candidate-before-rotation",
      genesis.head,
    );
    const replacement = await installPolicies(current, 2, "replacement");
    const rotationArtifact = await installRotation(
      current,
      genesis.revision.manifest,
      replacement,
    );
    const rotationRef = {
      artifact_sha256: rotationArtifact.artifact_sha256,
      payload_sha256: rotationArtifact.payload_sha256,
    };
    await assert.rejects(operation(
      current,
      "authority_decision",
      "rotation-stale-cas",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: rotationRef,
        expected_head_revision: genesis.head.head_revision + 1,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    ), ContinuationRuntimeV1AuthorityHeadConflictError);
    const rotated = await operation(
      current,
      "authority_decision",
      "rotate-policies",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: rotationRef,
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    );
    advance(current);
    assert.equal(rotated.head.head_revision, 2);
    assert.deepEqual(rotated.revision.manifest.compiler_policy_ref, {
      artifact_sha256: replacement.compiler.artifact_sha256,
      payload_sha256: replacement.compiler.payload_sha256,
    });
    await assert.rejects(operation(
      current,
      "authority_decision",
      "old-candidate-after-rotation",
      (context) => current.authority.advanceCandidate(context, {
        authority_subject_sha256: SUBJECT,
        candidate_ref: basicRef(oldCandidate.revision.manifest),
        target_state: "shadow",
        reason_codes: ["stale_candidate"],
        evidence_sha256s: ["e".repeat(64)],
        expected_head_revision: rotated.head.head_revision,
        expected_head_sha256: rotated.head.head_sha256,
      }),
    ), /candidate_not_current_or_exact/u);

    const reverted = await operation(
      current,
      "authority_decision",
      "revert-authority",
      (context) => current.authority.revertAuthority(context, {
        authority_subject_sha256: SUBJECT,
        revert_to_authority_ref: basicRef(genesis.revision.manifest),
        reason_codes: ["operator_recovery"],
        evidence_sha256s: ["f".repeat(64)],
        expected_head_revision: rotated.head.head_revision,
        expected_head_sha256: rotated.head.head_sha256,
      }),
    );
    advance(current);
    assert.equal(reverted.head.head_revision, 3);
    assert.equal(reverted.revision.manifest.branch_revision, 3);
    assert.deepEqual(
      reverted.revision.manifest.reverts_authority_ref,
      genesis.head.target,
    );
    await assert.rejects(operation(
      current,
      "authority_decision",
      "stale-revert-cas",
      (context) => current.authority.revertAuthority(context, {
        authority_subject_sha256: SUBJECT,
        revert_to_authority_ref: basicRef(genesis.revision.manifest),
        reason_codes: ["stale_operator_recovery"],
        evidence_sha256s: ["9".repeat(64)],
        expected_head_revision: rotated.head.head_revision,
        expected_head_sha256: rotated.head.head_sha256,
      }),
    ), ContinuationRuntimeV1AuthorityHeadConflictError);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("authority capabilities and every persisted projection fail closed", async () => {
  const current = fixture();
  const other = fixture();
  try {
    await installPolicies(current);
    const genesis = await ensureGenesis(current, "tamper-genesis");
    const draft = await createLearningDraft(current, "tamper-draft", genesis.head);
    await assert.rejects(
      current.authority.ensureGenesis({} as ContinuationRuntimeV1AuthorityWriteContext),
      /write_context_unrecognized/u,
    );
    await assert.rejects(operation(
      current,
      "authority_decision",
      "wrong-kind-genesis",
      (context) => current.authority.ensureGenesis(context),
    ), /genesis_operation_forbidden/u);
    await assert.rejects(operation(
      current,
      "record_observations",
      "wrong-kind-rotation",
      (context) => current.authority.rotatePolicies(context, {
        policy_rotation_artifact_ref: {
          artifact_sha256: "0".repeat(64),
          payload_sha256: "0".repeat(64),
        },
        expected_head_revision: genesis.head.head_revision,
        expected_head_sha256: genesis.head.head_sha256,
      }),
    ), /policy_rotation_operation_forbidden/u);
    await assert.rejects(operation(
      current,
      "record_observations",
      "wrong-database-context",
      (context) => other.authority.ensureGenesis(context),
    ), /write_context_database_mismatch/u);

    current.database.db.exec("DROP TRIGGER branch_capsule_bindings_no_update");
    current.database.db.prepare(`UPDATE branch_capsule_bindings
      SET binding_sha256 = ? WHERE tenant_id = ? AND branch_id = ?`).run(
      "f".repeat(64),
      TENANT,
      draft.revision.manifest.branch_id,
    );
    await assert.rejects(current.authority.readRevision({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      branch_id: draft.revision.manifest.branch_id,
      branch_revision: draft.revision.manifest.branch_revision,
    }), /corrupt:(?:binding_projection|source_operation_result)/u);

    current.database.db.exec("DROP TRIGGER authority_heads_advance_guard");
    current.database.db.exec("DROP TRIGGER authority_heads_source_operation_update_fence");
    current.database.db.prepare("UPDATE authority_heads SET head_sha256 = ?")
      .run("e".repeat(64));
    await assert.rejects(current.authority.readHead({
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
    }), /corrupt:(?:head_projection|source_operation_result)/u);
  } finally {
    await current.database.close();
    await other.database.close();
    rmSync(current.root, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});
