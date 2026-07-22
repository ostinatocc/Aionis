import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSignedAuthorityArtifactV1 } from
  "../../src/continuation/authority-artifact.ts";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.ts";
import type { ContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler.ts";
import { canonicalContinuationJson, type CanonicalJson } from
  "../../src/continuation/contract.ts";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.ts";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.ts";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.ts";
import { ContinuationRuntimeV1ApplicationError } from
  "../../src/runtime-v1/application.ts";
import { buildAuthenticatedDecisionQueryV1 } from
  "../../src/runtime-v1/command.ts";
import {
  ContinuationRuntimeV1CandidatePolicyCapacityError,
  createContinuationRuntimeV1DecisionAssemblyService,
} from
  "../../src/runtime-v1/decision-assembly.ts";
import { createContinuationRuntimeV1DecisionReader } from
  "../../src/runtime-v1/decision-reader.ts";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../../src/store/continuation-runtime-v1-authority-artifact-provisioner.ts";
import { createContinuationRuntimeV1AuthorityArtifactReader } from
  "../../src/store/continuation-runtime-v1-authority-artifact-reader.ts";
import { createContinuationRuntimeV1AuthorityStore } from
  "../../src/store/continuation-runtime-v1-authority-store.ts";
import { openContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.ts";
import { createContinuationRuntimeV1EffectCertificateReader } from
  "../../src/store/continuation-runtime-v1-effect-certificate-reader.ts";
import { createContinuationRuntimeV1EpisodeStore } from
  "../../src/store/continuation-runtime-v1-episode-store.ts";
import { createContinuationRuntimeV1ExperimentCohortAuthority } from
  "../../src/store/continuation-runtime-v1-experiment-cohort-authority.ts";
import { createContinuationRuntimeV1MemoryHistoryStore } from
  "../../src/store/continuation-runtime-v1-memory-history.ts";
import { createContinuationRuntimeV1MemoryStore } from
  "../../src/store/continuation-runtime-v1-memory-store.ts";
import { createContinuationRuntimeV1ObservationStore } from
  "../../src/store/continuation-runtime-v1-observation-store.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
} from "../../src/store/continuation-runtime-v1-operation-store.ts";
import { createContinuationRuntimeV1PolicyAuthority } from
  "../../src/store/continuation-runtime-v1-policy-authority.ts";

const KEYS = generateKeyPairSync("ed25519");
const TENANT = "tenant-reader";
const SCOPE = "scope-reader";
const FAMILY = "repair";
const HOST = "1".repeat(64);
const OTHER_HOST = "2".repeat(64);
const OPERATOR = "3".repeat(64);
const NOW = "2026-07-22T10:00:00.000Z";
const SNAPSHOT_NOW = "2026-07-22T09:30:00.000Z";
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: FAMILY,
});
const POLICY: ContinuationCompilerPolicyV1 = {
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
    external_verifier: [],
  },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-decision-reader-"));
  const clock = { value: NOW };
  const database = openContinuationRuntimeV1Database(
    join(root, "runtime", "runtime.sqlite"),
    { databaseInstanceId: "d".repeat(64), authorityNow: () => clock.value },
  );
  const operations = createContinuationRuntimeV1OperationStore(database);
  const artifactProvisioner = createContinuationRuntimeV1AuthorityArtifactProvisioner(
    database,
    KEYS.publicKey,
  );
  const artifacts = createContinuationRuntimeV1AuthorityArtifactReader(
    database,
    KEYS.publicKey,
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
  );
  const observations = createContinuationRuntimeV1ObservationStore(database);
  const memory = createContinuationRuntimeV1MemoryStore(database);
  const memoryHistory = createContinuationRuntimeV1MemoryHistoryStore(database);
  const cohorts = createContinuationRuntimeV1ExperimentCohortAuthority(
    database,
    artifacts,
    policies,
  );
  const assembly = createContinuationRuntimeV1DecisionAssemblyService({
    database,
    observationStore: observations,
    memoryStore: memory,
    artifactStore: artifacts,
    policyAuthority: policies,
    effectCertificateReader: effects,
    authorityStore: authority,
    experimentCohortAuthority: cohorts,
  });
  const episode = createContinuationRuntimeV1EpisodeStore(database);
  const reader = createContinuationRuntimeV1DecisionReader({
    database,
    artifactStore: artifacts,
    episodeStore: episode,
    observationStore: observations,
    memoryHistory,
    authorityStore: authority,
    policyAuthority: policies,
    effectCertificateReader: effects,
  });
  return {
    root,
    database,
    operations,
    artifactProvisioner,
    artifacts,
    authority,
    observations,
    memory,
    assembly,
    episode,
    reader,
    clock,
  };
}

type Fixture = ReturnType<typeof fixture>;

async function operation<T>(
  current: Fixture,
  kind: "record_observations" | "create_continuation" | "authority_decision",
  id: string,
  produce: (context: ContinuationRuntimeV1AuthorityWriteContext) => Promise<T>,
): Promise<T> {
  let result: T | null = null;
  await current.operations.execute({
    tenantId: TENANT,
    scope: SCOPE,
    operationKind: kind,
    operationId: id,
    actorKind: kind === "authority_decision" ? "operator" : "trusted_host",
    actorPrincipalSha256: kind === "authority_decision" ? OPERATOR : HOST,
    request: { operation_id: id },
    produce: async (context) => {
      try {
        result = await produce(context);
        return deriveContinuationRuntimeV1OperationResultV1(
          current.database,
          assertContinuationRuntimeV1AuthorityWriteContext(
            context,
            current.database,
          ),
          "before_receipt_insert",
        );
      } finally {
        current.clock.value = NOW;
      }
    },
  });
  return result!;
}

async function seed(current: Fixture, capsuleCount = 1) {
  const compiler = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "compiler-policy",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: buildContinuationCompilerPolicyV1(POLICY),
    valid_from: "2026-07-22T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
  }, KEYS.privateKey);
  const evidence = buildSignedAuthorityArtifactV1({
    tenant_id: TENANT,
    artifact_id: "evidence-policy",
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    authority_subject_sha256: SUBJECT,
    payload: buildEffectEvidencePolicyV1({
      schema_version: "effect_evidence_policy_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      trusted_effect_verifier_principals: [HOST],
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
    valid_from: "2026-07-22T00:00:00.000Z",
    expires_at: null,
    created_at: "2026-07-22T00:00:00.000Z",
  }, KEYS.privateKey);
  await operation(current, "authority_decision", "install-policies", (context) =>
    current.artifactProvisioner.putBundle(context, {
      schema_version: "authority_policy_provisioning_bundle_v1",
      tenant_id: TENANT,
      authority_subject_sha256: SUBJECT,
      compiler_policy: compiler,
      evidence_policy: evidence,
    }));
  return operation(current, "record_observations", "seed-memory", async (context) => {
    current.clock.value = SNAPSHOT_NOW;
    const snapshot = await current.observations.put(context, {
      host_task_envelope: {
        host_task_id: "task-reader",
        episode_id: "episode-reader",
        run_id: "run-reader",
        consumer_agent_id: "agent-reader",
        consumer_team_id: null,
        task_family: FAMILY,
        task_signature: "reader-signature",
        workflow_signature: null,
        workspace_signature: "reader-workspace",
        source_task_sha256: "4".repeat(64),
        source_event_sha256: "5".repeat(64),
        issued_at: "2026-07-22T09:00:00.000Z",
        expires_at: "2026-07-22T11:00:00.000Z",
      },
      collector_observations: [],
      signed_observations: [],
    });
    const memory = await current.memory.appendMemoryRevision(context, {
      expected_head_revision: null,
      items: Array.from({ length: capsuleCount }, (_, index) => ({
        memory_id: `memory-reader-state-${index.toString().padStart(3, "0")}`,
        memory_kind: "current_state",
        lifecycle: "active",
        authority: "verified",
        hydrated: true,
        projection: { state: "ready", index },
        rehydration_ref: null,
        expires_at: null,
      })),
      relations: [],
      capsules: Array.from({ length: capsuleCount }, (_, index) => ({
        memory_id: `memory-reader-state-${index.toString().padStart(3, "0")}`,
        draft: {
          capsule_id: `capsule-reader-state-${index.toString().padStart(3, "0")}`,
          kind: "current_state",
          proposed_influence: "use",
          applicability: {
            task_family: FAMILY,
            task_signature: "reader-signature",
            workflow_signature: null,
            workspace_signature: "reader-workspace",
            producer_agent_id: "agent-reader",
            owner_agent_id: null,
            owner_team_id: null,
          },
          projection: {
            summary: `The exact durable state ${index} is ready`,
            next_action: "Continue from ready state",
            target_refs: [{ kind: "memory", ref: "reader-state" }],
            workflow_steps: [],
            acceptance_statements: [],
          },
          coverage_claims: [{
            obligation_kind: "required_state",
            target_refs: [{ kind: "memory", ref: "reader-state" }],
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
      })),
    });
    current.clock.value = NOW;
    await current.authority.ensureGenesis(context);
    return { snapshot, memory };
  });
}

async function extendCurrentStateHistory(
  current: Fixture,
  targetRevision: number,
): Promise<void> {
  for (let revision = 2; revision <= targetRevision; revision += 1) {
    await operation(
        current,
        "record_observations",
        `history-depth-${revision.toString().padStart(4, "0")}`,
        async (context) => {
          current.clock.value = SNAPSHOT_NOW;
          await current.observations.put(context, {
            host_task_envelope: {
              host_task_id: `task-history-${revision}`,
              episode_id: "episode-history-depth",
              run_id: `run-history-${revision}`,
              consumer_agent_id: "agent-reader",
              consumer_team_id: null,
              task_family: FAMILY,
              task_signature: "reader-signature",
              workflow_signature: null,
              workspace_signature: "reader-workspace",
              source_task_sha256: "4".repeat(64),
              source_event_sha256: revision.toString(16).padStart(64, "0"),
              issued_at: "2026-07-22T09:00:00.000Z",
              expires_at: "2026-07-22T11:00:00.000Z",
            },
            collector_observations: [],
            signed_observations: [],
          });
          return current.memory.appendMemoryRevision(context, {
            expected_head_revision: revision - 1,
            items: [{
              memory_id: "memory-reader-state-000",
              memory_kind: "current_state",
              lifecycle: "active",
              authority: "verified",
              hydrated: true,
              projection: { state: "ready", revision },
              rehydration_ref: null,
              expires_at: null,
            }],
            relations: [],
            capsules: [{
              memory_id: "memory-reader-state-000",
              draft: {
                capsule_id: "capsule-reader-state-000",
                kind: "current_state",
                proposed_influence: "use",
                applicability: {
                  task_family: FAMILY,
                  task_signature: "reader-signature",
                  workflow_signature: null,
                  workspace_signature: "reader-workspace",
                  producer_agent_id: "agent-reader",
                  owner_agent_id: null,
                  owner_team_id: null,
                },
                projection: {
                  summary: `The exact durable state at revision ${revision} is ready`,
                  next_action: "Continue from ready state",
                  target_refs: [{ kind: "memory", ref: "reader-state" }],
                  workflow_steps: [],
                  acceptance_statements: [],
                },
                coverage_claims: [{
                  obligation_kind: "required_state",
                  target_refs: [{ kind: "memory", ref: "reader-state" }],
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
        },
    );
  }
}

async function expose(current: Fixture) {
  const seeded = await seed(current);
  await operation(current, "create_continuation", "decision-reader", async (context) => {
    const capability = await current.assembly.assemble(context, {
      world_snapshot_ref: {
        world_snapshot_id: seeded.snapshot.snapshot.world_snapshot_id,
        world_snapshot_sha256: seeded.snapshot.snapshot.world_snapshot_sha256,
      },
      obligations: [{
        obligation_id: "reader-state-required",
        kind: "required_state",
        requirement: "hard",
        statement: "The durable reader state must be available",
        target_refs: [{ kind: "memory", ref: "reader-state" }],
        required_probe_ids: [],
        evidence_requirement: "runtime_state",
        source_refs: [],
      }],
      render_budget: 65_536,
    });
    return current.episode.appendExposure(context, capability);
  });
  const events = await current.episode.readDecision(
    TENANT,
    SCOPE,
    "decision-reader",
  );
  const exposure = events[0]!;
  if (exposure.payload.payload_kind !== "contract_exposed_v1") {
    throw new Error("expected exposure");
  }
  const contract = exposure.payload.continuation_contract as unknown as {
    contract_sha256: string;
    identity: { host_task_envelope_sha256: string };
  };
  const render = exposure.payload.render_result as unknown as {
    render_result_sha256: string;
  };
  return { exposure, contract, render };
}

function query(
  exposed: Awaited<ReturnType<typeof expose>>,
  view: "summary" | "full" | "counterfactual",
  actor: "trusted_host" | "operator" = view === "counterfactual"
    ? "operator"
    : "trusted_host",
  principal = actor === "operator" ? OPERATOR : HOST,
  excludeCapsule: Readonly<{
    capsule_id: string;
    capsule_revision: number;
    capsule_sha256: string;
  }> | null = null,
) {
  return buildAuthenticatedDecisionQueryV1("decision-reader", {
    view,
    exclude_capsule: excludeCapsule,
    substitute_branch: null,
  }, {
    tenant_id: TENANT,
    scope: SCOPE,
    actor_kind: actor,
    actor_principal_sha256: principal,
    task_family: FAMILY,
    authority_subject_sha256: SUBJECT,
    decision_id: "decision-reader",
    contract_sha256: exposed.contract.contract_sha256,
    exposure_receipt_sha256: exposed.exposure.event_sha256,
    host_task_envelope_sha256:
      exposed.contract.identity.host_task_envelope_sha256,
    render_result_sha256: exposed.render.render_result_sha256,
  });
}

function rows(current: Fixture): readonly number[] {
  return ["operations", "memory_commits", "branch_revisions", "episode_events"]
    .map((table) => (current.database.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number }).count);
}

test("summary and operator full audit reconstruct the exact immutable historical exposure", async () => {
  const current = fixture();
  try {
    const exposed = await expose(current);
    const summary = await current.reader.read(query(exposed, "summary"));
    const repeated = await current.reader.read(query(exposed, "summary"));
    assert.equal(canonicalContinuationJson(summary), canonicalContinuationJson(repeated));
    const summaryRecord = summary as unknown as Record<string, CanonicalJson>;
    assert.equal(summaryRecord.schema_version, "continuation_decision_summary_v1");
    assert.equal(summaryRecord.query_sha256, query(exposed, "summary").query_sha256);

    const full = await current.reader.read(query(exposed, "full", "operator"));
    const fullRecord = full as unknown as Record<string, CanonicalJson>;
    assert.equal(fullRecord.schema_version, "continuation_decision_full_v1");
    assert.equal(
      (fullRecord.continuation_contract as Record<string, CanonicalJson>).contract_sha256,
      exposed.contract.contract_sha256,
    );
    assert.equal((fullRecord.events as CanonicalJson[]).length, 1);
    const fullContract = fullRecord.continuation_contract as Record<string, any>;
    assert.equal(
      fullContract.compiler.candidate_retrieval_receipt.receipt_sha256,
      (exposed.exposure.payload as any).continuation_contract.compiler
        .candidate_retrieval_receipt.receipt_sha256,
    );
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("counterfactual recompiles read-only and never emits executable authority", async () => {
  const current = fixture();
  try {
    const exposed = await expose(current);
    const before = rows(current);
    const exposedContract = exposed.exposure.payload.payload_kind === "contract_exposed_v1"
      ? exposed.exposure.payload.continuation_contract as unknown as {
        selected_capsules: Array<{ capsule: {
          capsule_id: string;
          capsule_revision: number;
          capsule_sha256: string;
        } }>;
      }
      : null;
    const excluded = exposedContract?.selected_capsules[0]?.capsule;
    assert.ok(excluded);
    const result = await current.reader.read(query(
      exposed,
      "counterfactual",
      "operator",
      OPERATOR,
      excluded,
    ));
    assert.deepEqual(rows(current), before);
    const record = result as unknown as Record<string, CanonicalJson>;
    assert.equal(record.schema_version, "continuation_decision_counterfactual_v1");
    assert.equal(record.counterfactual_only, true);
    assert.equal(record.executable_authority, false);
    assert.equal(
      (record.candidate_retrieval_receipt as Record<string, CanonicalJson>).receipt_sha256,
      ((exposed.exposure.payload as any).continuation_contract.compiler
        .candidate_retrieval_receipt as Record<string, CanonicalJson>).receipt_sha256,
    );
    assert.equal(Object.hasOwn(record, "continuation_contract"), false);
    const render = record.render_projection as Record<string, CanonicalJson>;
    assert.equal(render.status, "rendered");
    const projection = render.projection as Record<string, CanonicalJson>;
    assert.equal(projection.counterfactual_only, true);
    assert.equal(projection.executable_authority, false);
    const diff = record.diff as Record<string, CanonicalJson>;
    assert.equal((diff.selected_removed as CanonicalJson[]).length, 1);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("protected candidate overflow rolls back the operation and exposure atomically", async () => {
  const current = fixture();
  try {
    const seeded = await seed(current, 65);
    const before = rows(current);
    await assert.rejects(
      operation(current, "create_continuation", "decision-overflow", async (context) => {
        const capability = await current.assembly.assemble(context, {
          world_snapshot_ref: {
            world_snapshot_id: seeded.snapshot.snapshot.world_snapshot_id,
            world_snapshot_sha256: seeded.snapshot.snapshot.world_snapshot_sha256,
          },
          obligations: [{
            obligation_id: "reader-state-required",
            kind: "required_state",
            requirement: "hard",
            statement: "The durable reader state must be available",
            target_refs: [{ kind: "memory", ref: "reader-state" }],
            required_probe_ids: [],
            evidence_requirement: "runtime_state",
            source_refs: [],
          }],
          render_budget: 65_536,
        });
        return current.episode.appendExposure(context, capability);
      }),
      (error: unknown) =>
        error instanceof ContinuationRuntimeV1CandidatePolicyCapacityError,
    );
    assert.deepEqual(rows(current), before);
    assert.deepEqual(await current.episode.readDecision(
      TENANT,
      SCOPE,
      "decision-overflow",
    ), []);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("assembly at a 1000-commit head never performs a full memory commit-chain read", async () => {
  const current = fixture();
  try {
    const seeded = await seed(current);
    await extendCurrentStateHistory(current, 1_000);
    assert.equal((await current.memory.readHead(TENANT, SCOPE))?.head_revision, 1_000);
    const memoryCommitQueries: string[] = [];
    const sqlite = current.database.db as typeof current.database.db & {
      prepare(sql: string): ReturnType<typeof current.database.db.prepare>;
    };
    const originalPrepare = sqlite.prepare.bind(sqlite);
    await operation(current, "create_continuation", "decision-depth", async (context) => {
      sqlite.prepare = ((sql: string) => {
        if (/\b(?:FROM|JOIN)\s+memory_commits\b/iu.test(sql)) {
          memoryCommitQueries.push(sql);
        }
        return originalPrepare(sql);
      }) as typeof sqlite.prepare;
      let capability;
      try {
        capability = await current.assembly.assemble(context, {
          world_snapshot_ref: {
            world_snapshot_id: seeded.snapshot.snapshot.world_snapshot_id,
            world_snapshot_sha256: seeded.snapshot.snapshot.world_snapshot_sha256,
          },
          obligations: [{
            obligation_id: "reader-state-required",
            kind: "required_state",
            requirement: "hard",
            statement: "The durable reader state must be available",
            target_refs: [{ kind: "memory", ref: "reader-state" }],
            required_probe_ids: [],
            evidence_requirement: "runtime_state",
            source_refs: [],
          }],
          render_budget: 65_536,
        });
      } finally {
        sqlite.prepare = originalPrepare as typeof sqlite.prepare;
      }
      return current.episode.appendExposure(context, capability!);
    });
    assert.ok(memoryCommitQueries.length > 0);
    assert.ok(memoryCommitQueries.length <= 12, memoryCommitQueries.join("\n---\n"));
    assert.equal(memoryCommitQueries.some((sql) =>
      /memory_commit\.revision\s*<=/u.test(sql)), false);
    assert.equal(memoryCommitQueries.every((sql) =>
      /memory_commit\.revision\s*=\s*\?/u.test(sql)
      || (/source_operation_kind\s*=\s*\?/u.test(sql)
        && /source_operation_id\s*=\s*\?/u.test(sql)
        && /source_request_sha256\s*=\s*\?/u.test(sql))), true);
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("trusted hosts cannot read another collection principal decision", async () => {
  const current = fixture();
  try {
    const exposed = await expose(current);
    await assert.rejects(
      current.reader.read(query(exposed, "summary", "trusted_host", OTHER_HOST)),
      (error: unknown) => error instanceof ContinuationRuntimeV1ApplicationError
        && error.statusCode === 404
        && error.code === "decision_not_found",
    );
  } finally {
    await current.database.close();
    rmSync(current.root, { recursive: true, force: true });
  }
});
