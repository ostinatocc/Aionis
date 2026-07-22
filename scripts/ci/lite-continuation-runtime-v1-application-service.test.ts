import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
} from "../../src/continuation/contract.js";
import { compileContinuationV1, continuationCompilerPolicySha256 } from
  "../../src/continuation/compiler.js";
import { retrieveContinuationCandidatesV1 } from
  "../../src/continuation/candidate-retrieval.js";
import type { ContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import {
  buildEpisodeCapsuleFactSetV1,
  buildEpisodeEventV1,
  episodeEventRefV1,
} from "../../src/continuation/episode.js";
import { renderContinuationProjectionV1 } from
  "../../src/continuation/renderer.js";
import {
  buildHostTaskEnvelopeV1,
  continuationAuthoritySubjectSha256V1,
} from "../../src/continuation/task-envelope.js";
import { buildWorldObservationSnapshotV1 } from
  "../../src/continuation/world-snapshot.js";
import {
  ContinuationRuntimeV1ApplicationError,
} from "../../src/runtime-v1/application.js";
import {
  createContinuationRuntimeV1ApplicationService,
  type ContinuationRuntimeV1ApplicationServiceDependencies,
} from "../../src/runtime-v1/application-service.js";
import {
  ContinuationRuntimeV1CandidatePolicyCapacityError,
  ContinuationRuntimeV1CandidateSourceCapacityError,
  assertContinuationRuntimeV1CandidateSourceCapacity,
} from "../../src/runtime-v1/decision-assembly.js";
import {
  buildAuthenticatedDecisionQueryV1,
  buildAuthorityDecisionCommandV1,
  buildCreateContinuationCommandV1,
  buildRecordObservationsCommandV1,
  buildRecordOutcomeCommandV1,
  type RuntimeV1MutationCommand,
  type VerifiedAuthorityCommandBindingV1,
  type VerifiedDecisionCommandBindingV1,
  type VerifiedSnapshotCommandBindingV1,
} from "../../src/runtime-v1/command.js";
import { operationRequestFromVerifiedCommandV1 } from
  "../../src/runtime-v1/operation-request.js";
import type {
  ContinuationRuntimeV1AuthorityWriteContext,
  ContinuationRuntimeV1OperationRecord,
  ExecuteContinuationRuntimeV1OperationArgs,
} from "../../src/store/continuation-runtime-v1-operation-store.js";
import { ContinuationRuntimeV1PolicyUnavailableError } from
  "../../src/store/continuation-runtime-v1-policy-authority.js";

const TENANT = "tenant-a";
const SCOPE = "scope-a";
const TASK_FAMILY = "repair";
const HOST = "1".repeat(64);
const OPERATOR = "2".repeat(64);
const TRUST_ROOT = "3".repeat(64);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const NOW = "2026-07-22T10:05:00.000Z";
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: TENANT,
  scope: SCOPE,
  task_family: TASK_FAMILY,
});

const HOST_PRINCIPAL = Object.freeze({
  tenant_id: TENANT,
  principal_sha256: HOST,
  principal_kind: "trusted_host" as const,
  authentication: "bearer_sha256_v1" as const,
});
const OPERATOR_PRINCIPAL = Object.freeze({
  tenant_id: TENANT,
  principal_sha256: OPERATOR,
  principal_kind: "operator" as const,
  authentication: "bearer_sha256_v1" as const,
});

const TASK_INPUT = Object.freeze({
  host_task_id: "task-a",
  episode_id: "episode-a",
  run_id: "run-a",
  consumer_agent_id: "agent-a",
  consumer_team_id: null,
  task_family: TASK_FAMILY,
  task_signature: "task-signature-a",
  workflow_signature: null,
  workspace_signature: "workspace-a",
  source_task_sha256: SHA_A,
  source_event_sha256: SHA_B,
  issued_at: "2026-07-22T10:00:00.000Z",
  expires_at: "2026-07-22T12:00:00.000Z",
});

const ENVELOPE = buildHostTaskEnvelopeV1(TASK_INPUT, {
  tenant_id: TENANT,
  scope: SCOPE,
  authority_subject_sha256: SUBJECT,
});
const SNAPSHOT = buildWorldObservationSnapshotV1({
  tenant_id: TENANT,
  scope: SCOPE,
  authority_subject_sha256: SUBJECT,
  world_snapshot_id: "snapshot-a",
  host_task_envelope: ENVELOPE,
  collection_principal_sha256: HOST,
  observations: [],
  created_at: "2026-07-22T10:01:00.000Z",
});

const POLICY: ContinuationCompilerPolicyV1 = Object.freeze({
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
});
const BRANCH = Object.freeze({
  branch_id: "authoritative-a",
  branch_revision: 1,
  manifest_sha256: SHA_C,
});

const CONTRACT_IDENTITY = Object.freeze({
    decision_id: "continue-a",
    tenant_id: TENANT,
    scope: SCOPE,
    episode_id: ENVELOPE.episode_id,
    run_id: ENVELOPE.run_id,
    host_task_id: ENVELOPE.host_task_id,
    host_task_envelope_sha256: ENVELOPE.host_task_envelope_sha256,
    collection_principal_sha256: HOST,
    consumer_agent_id: ENVELOPE.consumer_agent_id,
    consumer_team_id: ENVELOPE.consumer_team_id,
    task_family: ENVELOPE.task_family,
    task_signature: ENVELOPE.task_signature,
    workflow_signature: ENVELOPE.workflow_signature,
    workspace_signature: ENVELOPE.workspace_signature,
    source_task_sha256: ENVELOPE.source_task_sha256,
    source_event_sha256: ENVELOPE.source_event_sha256,
    world_snapshot_id: SNAPSHOT.world_snapshot_id,
    world_snapshot_sha256: SNAPSHOT.world_snapshot_sha256,
});
const EMPTY_RETRIEVAL = retrieveContinuationCandidatesV1({
  schema_version: "continuation_candidate_retrieval_input_v1",
  identity: CONTRACT_IDENTITY,
  obligations: [],
  candidates: [],
  evaluated_at: NOW,
  policy: POLICY,
});
if (EMPTY_RETRIEVAL.status !== "selected") throw new Error("empty retrieval overflow");
const CONTRACT = compileContinuationV1({
  schema_version: "continuation_compile_input_v1",
  identity: CONTRACT_IDENTITY,
  authority: {
    authority_subject_sha256: SUBJECT,
    authoritative_learning_head: BRANCH,
    served_learning_branch: BRANCH,
    serving_mode: "authoritative_unassigned",
    experiment_cohort_ref: null,
    serving_assignment_receipt: null,
    compiler_policy_ref: {
      artifact_sha256: SHA_A,
      payload_sha256: continuationCompilerPolicySha256(POLICY),
    },
    evidence_policy_ref: { artifact_sha256: SHA_B, payload_sha256: SHA_D },
    memory_scope_head_revision: 1,
    memory_scope_head_sha256: SHA_D,
  },
  obligations: [],
  candidates: [],
  candidate_retrieval_receipt: EMPTY_RETRIEVAL.receipt,
  observation_snapshot: SNAPSHOT,
  compiled_at: NOW,
  render_budget: 4_096,
  policy: POLICY,
});
const RENDER = renderContinuationProjectionV1({ contract: CONTRACT, capsules: [] });
const EXPOSURE_FACTS = buildEpisodeCapsuleFactSetV1("contract_exposed", []);

const SNAPSHOT_BINDING: VerifiedSnapshotCommandBindingV1 = Object.freeze({
  tenant_id: TENANT,
  scope: SCOPE,
  actor_kind: "trusted_host",
  actor_principal_sha256: HOST,
  task_family: TASK_FAMILY,
  authority_subject_sha256: SUBJECT,
  world_snapshot_id: SNAPSHOT.world_snapshot_id,
  world_snapshot_sha256: SNAPSHOT.world_snapshot_sha256,
});
const DECISION_BINDING: VerifiedDecisionCommandBindingV1 = Object.freeze({
  tenant_id: TENANT,
  scope: SCOPE,
  actor_kind: "trusted_host",
  actor_principal_sha256: HOST,
  task_family: TASK_FAMILY,
  authority_subject_sha256: SUBJECT,
  decision_id: CONTRACT.identity.decision_id,
  contract_sha256: CONTRACT.contract_sha256,
  render_result_sha256: RENDER.render_result_sha256,
  exposure_receipt_sha256: SHA_C,
  host_task_envelope_sha256: ENVELOPE.host_task_envelope_sha256,
});
const AUTHORITY_BINDING: VerifiedAuthorityCommandBindingV1 = Object.freeze({
  tenant_id: TENANT,
  scope: SCOPE,
  actor_kind: "operator",
  actor_principal_sha256: OPERATOR,
  task_family: TASK_FAMILY,
  authority_subject_sha256: SUBJECT,
});

const OBSERVATIONS = buildRecordObservationsCommandV1("observe-a", {
  schema_version: "record_observations_body_v1",
  host_task: TASK_INPUT,
  memory_inputs: [],
  collector_observations: [],
  signed_observations: [],
}, {
  tenant_id: TENANT,
  scope: SCOPE,
  actor_kind: "trusted_host",
  actor_principal_sha256: HOST,
});
const CONTINUATION = buildCreateContinuationCommandV1("continue-a", {
  schema_version: "create_continuation_body_v1",
  world_snapshot_ref: {
    world_snapshot_id: SNAPSHOT.world_snapshot_id,
    world_snapshot_sha256: SNAPSHOT.world_snapshot_sha256,
  },
  obligations: [],
  render_budget_bytes: 4_096,
}, SNAPSHOT_BINDING);

const EXPOSURE = buildEpisodeEventV1({
  tenant_id: TENANT,
  scope: SCOPE,
  episode_id: ENVELOPE.episode_id,
  event_sequence: 1,
  event_id: "exposure-a",
  event_kind: "contract_exposed",
  source_operation: {
    operation_kind: "create_continuation",
    operation_id: CONTINUATION.operation_id,
    request_sha256: CONTINUATION.command_sha256,
  },
  previous_event_ref: null,
  cause_event_ref: null,
  context: {
    context_kind: "decision",
    decision_id: CONTRACT.identity.decision_id,
    run_id: CONTRACT.identity.run_id,
    host_task_envelope_sha256: CONTRACT.identity.host_task_envelope_sha256,
    contract_sha256: CONTRACT.contract_sha256,
    coverage_certificate_sha256: CONTRACT.coverage_certificate.certificate_sha256,
    render_result_sha256: RENDER.render_result_sha256,
    authority_subject_sha256: SUBJECT,
    branch_manifest_sha256: CONTRACT.authority.served_learning_branch.manifest_sha256,
  },
  render_result_sha256: RENDER.render_result_sha256,
  effect_certificate_sha256: null,
  effect_member_sequence: null,
  capsule_fact_count: EXPOSURE_FACTS.capsule_fact_count,
  capsule_fact_set_sha256: EXPOSURE_FACTS.capsule_fact_set_sha256,
  payload: {
    payload_kind: "contract_exposed_v1",
    continuation_contract: CONTRACT,
    render_result: RENDER,
  },
  created_at: "2026-07-22T10:06:00.000Z",
});

const OUTCOME = buildRecordOutcomeCommandV1("outcome-a", {
  schema_version: "record_outcome_body_v1",
  decision_ref: {
    decision_id: CONTRACT.identity.decision_id,
    contract_sha256: CONTRACT.contract_sha256,
    exposure_receipt_sha256: EXPOSURE.event_sha256,
  },
  use_receipt: {
    schema_version: "host_capsule_use_receipt_v1",
    decision_id: CONTRACT.identity.decision_id,
    use_id: "use-a",
    observed_at: "2026-07-22T10:10:00.000Z",
    render_result_sha256: RENDER.render_result_sha256,
    capsule_uses: [],
    evidence_sha256: SHA_A,
  },
  outcome_receipt: {
    schema_version: "host_outcome_receipt_v1",
    decision_id: CONTRACT.identity.decision_id,
    observed_at: "2026-07-22T10:11:00.000Z",
    outcome: "succeeded",
    outcome_code: "completed",
    evidence_sha256: SHA_B,
    summary: null,
  },
}, { ...DECISION_BINDING, exposure_receipt_sha256: EXPOSURE.event_sha256 });
const AUTHORITY = buildAuthorityDecisionCommandV1("authority-a", {
  schema_version: "authority_decision_body_v1",
  expected_head: { revision: 1, head_sha256: SHA_A },
  decision: {
    kind: "branch_reject",
    candidate: {
      branch_id: "candidate-a",
      branch_revision: 1,
      manifest_sha256: SHA_B,
    },
    reason_codes: ["negative_transfer"],
    evidence_sha256s: [SHA_D],
  },
}, AUTHORITY_BINDING);

function emptySet<T extends CanonicalJson>(): Readonly<{
  count: number;
  set_sha256: string;
  refs: readonly T[];
}> {
  return { count: 0, set_sha256: canonicalContinuationSha256([]), refs: [] };
}

function result(command: RuntimeV1MutationCommand): ContinuationRuntimeV1OperationRecord["receipt"]["result"] {
  if (command.operation_kind === "record_observations") {
    return {
      schema_version: "record_observations_result_v1",
      observation_snapshot_ref: {
        world_snapshot_id: command.operation_id,
        world_snapshot_sha256: SNAPSHOT.world_snapshot_sha256,
        host_task_envelope_sha256: ENVELOPE.host_task_envelope_sha256,
      },
      memory_revision_ref: null,
      authority_branch_set: emptySet(),
      durable_job_set: emptySet(),
    };
  }
  if (command.operation_kind === "create_continuation") {
    return {
      schema_version: "create_continuation_result_v1",
      episode_id: ENVELOPE.episode_id,
      decision_id: CONTRACT.identity.decision_id,
      event_refs: [episodeEventRefV1(EXPOSURE)],
    };
  }
  if (command.operation_kind === "record_outcome") {
    return {
      schema_version: "record_outcome_result_v1",
      episode_id: ENVELOPE.episode_id,
      decision_id: CONTRACT.identity.decision_id,
      event_refs: [],
    };
  }
  if (command.operation_kind === "authority_decision") {
    return {
      schema_version: "authority_decision_result_v1",
      decision_kind: "branch_update",
      branch_revision_set: emptySet(),
    };
  }
  throw new Error("worker command is outside application test scope");
}

function operationRecord(command: RuntimeV1MutationCommand): ContinuationRuntimeV1OperationRecord {
  const receipt = {
    schema_version: "continuation_runtime_operation_receipt_v1" as const,
    tenant_id: command.tenant_id,
    scope: command.scope,
    operation_kind: command.operation_kind,
    operation_id: command.operation_id,
    request_sha256: command.command_sha256,
    actor_kind: command.actor_kind,
    actor_principal_sha256: command.actor_principal_sha256,
    completed_at: "2026-07-22T10:20:00.000Z",
    result: result(command),
  };
  return {
    request: operationRequestFromVerifiedCommandV1(command),
    request_sha256: command.command_sha256,
    receipt_sha256: canonicalContinuationSha256(receipt),
    receipt,
  };
}

type Harness = Readonly<{
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies;
  executions: ExecuteContinuationRuntimeV1OperationArgs[];
}>;

function harness(options: Readonly<{ policiesAvailable?: boolean }> = {}): Harness {
  const records = new Map<string, ContinuationRuntimeV1OperationRecord>();
  for (const command of [OBSERVATIONS, CONTINUATION, OUTCOME, AUTHORITY]) {
    records.set(`${command.operation_kind}\0${command.operation_id}`, operationRecord(command));
  }
  const executions: ExecuteContinuationRuntimeV1OperationArgs[] = [];
  const notInvoked = async (): Promise<never> => {
    throw new Error("producer must not run while exercising durable replay");
  };
  let executeCount = 0;
  const database = {
    databaseInstanceId: SHA_A,
    read: async <T>(read: () => T | Promise<T>) => read(),
    db: {
      prepare: (sql: string) => ({
        get: () => {
          if (!sql.includes("runtime_meta")) throw new Error("unexpected readiness get");
          return { database_instance_id: SHA_A };
        },
        all: () => {
          if (!sql.includes("authority_artifacts")) throw new Error("unexpected readiness all");
          return [{ authority_subject_sha256: SUBJECT }];
        },
      }),
    },
  };
  const dependencies = {
    tenantId: TENANT,
    trustRootSha256: TRUST_ROOT,
    database,
    operationStore: {
      execute: async (args: ExecuteContinuationRuntimeV1OperationArgs) => {
        executions.push(args);
        const record = records.get(`${args.operationKind}\0${args.operationId}`)!;
        executeCount += 1;
        return {
          status: executeCount <= 4 ? "created" as const : "replayed" as const,
          request_sha256: record.request_sha256,
          receipt_sha256: record.receipt_sha256,
          receipt: record.receipt,
        };
      },
      read: async (args: { operationKind: string; operationId: string }) =>
        records.get(`${args.operationKind}\0${args.operationId}`) ?? null,
    },
    durableJobStore: { enqueue: notInvoked },
    observationStore: {
      put: notInvoked,
      read: async () => ({
        snapshot: SNAPSHOT,
        source_operation: {
          tenant_id: TENANT,
          scope: SCOPE,
          operation_kind: "record_observations",
          operation_id: "observe-a",
          request_sha256: OBSERVATIONS.command_sha256,
          actor_kind: "trusted_host",
          actor_principal_sha256: HOST,
        },
      }),
    },
    memoryStore: {
      appendMemoryRevision: notInvoked,
      readHead: notInvoked,
      readMemoryItem: notInvoked,
    },
    policyAuthority: {
      resolveCurrent: async () => {
        if (options.policiesAvailable === false) {
          throw new ContinuationRuntimeV1PolicyUnavailableError("compiler_policy");
        }
        return Object.freeze({});
      },
    },
    authorityStore: {
      advanceCandidate: notInvoked,
      createIsolatedCandidateDraft: notInvoked,
      ensureGenesis: notInvoked,
      mergeCandidate: notInvoked,
      readHead: async () => ({
        head_revision: 1,
        head_sha256: SHA_A,
        source_operation: { scope: SCOPE },
      }),
      revertAuthority: notInvoked,
      rotatePolicies: notInvoked,
      terminateCandidate: notInvoked,
    },
    episodeStore: {
      appendExposure: notInvoked,
      appendOutcomeBundle: notInvoked,
      readDecision: async () => [EXPOSURE],
    },
    decisionAssembly: { assemble: notInvoked },
    decisionReader: {
      read: async (query: { query_sha256: string }) => ({
        schema_version: "decision_reader_test_v1",
        query_sha256: query.query_sha256,
      }),
    },
    now: () => NOW,
  } as unknown as ContinuationRuntimeV1ApplicationServiceDependencies;
  return { dependencies, executions };
}

test("application selectors bind snapshots, one durable exposure, and an existing authority head", async () => {
  const app = createContinuationRuntimeV1ApplicationService(harness().dependencies);
  assert.deepEqual(await app.resolveSnapshotBinding({
    principal: HOST_PRINCIPAL,
    operation_id: "continue-a",
    scope: SCOPE,
    world_snapshot_id: SNAPSHOT.world_snapshot_id,
    world_snapshot_sha256: SNAPSHOT.world_snapshot_sha256,
  }), SNAPSHOT_BINDING);

  const decision = await app.resolveDecisionBinding({
    principal: HOST_PRINCIPAL,
    purpose: "record_outcome",
    operation_id: "outcome-a",
    scope: SCOPE,
    decision_id: CONTRACT.identity.decision_id,
  });
  assert.equal(decision.contract_sha256, CONTRACT.contract_sha256);
  assert.equal(decision.exposure_receipt_sha256, EXPOSURE.event_sha256);
  assert.equal(decision.render_result_sha256, RENDER.render_result_sha256);

  assert.deepEqual(await app.resolveAuthorityBinding({
    principal: OPERATOR_PRINCIPAL,
    operation_id: "authority-a",
    scope: SCOPE,
    task_family: TASK_FAMILY,
    authority_subject_sha256: SUBJECT,
  }), AUTHORITY_BINDING);

  await assert.rejects(app.resolveDecisionBinding({
    principal: { ...HOST_PRINCIPAL, principal_sha256: SHA_D },
    purpose: "read_decision",
    operation_id: null,
    scope: SCOPE,
    decision_id: CONTRACT.identity.decision_id,
  }), (error: unknown) => error instanceof ContinuationRuntimeV1ApplicationError
    && error.statusCode === 404 && error.code === "decision_not_found");
});

test("all four mutations use exact verified operation requests and response bytes ignore created/replayed status", async () => {
  const value = harness();
  const app = createContinuationRuntimeV1ApplicationService(value.dependencies);
  const commands = [OBSERVATIONS, CONTINUATION, OUTCOME, AUTHORITY] as const;
  const invoke = (index: number) => index === 0
    ? app.recordObservations(OBSERVATIONS)
    : index === 1
      ? app.createContinuation(CONTINUATION)
      : index === 2
        ? app.recordOutcome(OUTCOME)
        : app.decideAuthority(AUTHORITY);
  const first: CanonicalJson[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    first.push(await invoke(index));
  }
  const replay: CanonicalJson[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    replay.push(await invoke(index));
  }
  assert.deepEqual(
    replay.map((item) => canonicalContinuationJson(item)),
    first.map((item) => canonicalContinuationJson(item)),
  );
  for (let index = 0; index < value.executions.length; index += 1) {
    const command = commands[index % commands.length]!;
    assert.equal(
      canonicalContinuationJson(value.executions[index]!.request),
      canonicalContinuationJson(operationRequestFromVerifiedCommandV1(command)),
    );
  }
  assert.equal((first[0] as { schema_version: string }).schema_version,
    "record_observations_response_v1");
  assert.equal((first[1] as { exposure_receipt: { event_sha256: string } })
    .exposure_receipt.event_sha256, EXPOSURE.event_sha256);
});

test("readiness requires a verified current compiler/evidence pair and decision reads are delegated", async () => {
  const ready = createContinuationRuntimeV1ApplicationService(harness().dependencies);
  assert.deepEqual(await ready.readiness(), { ready: true, reason_codes: [] });
  const query = buildAuthenticatedDecisionQueryV1(CONTRACT.identity.decision_id, {
    view: "full",
    exclude_capsule: null,
    substitute_branch: null,
  }, { ...DECISION_BINDING, actor_kind: "operator", actor_principal_sha256: OPERATOR });
  assert.deepEqual(await ready.readDecision(query), {
    schema_version: "decision_reader_test_v1",
    query_sha256: query.query_sha256,
  });

  const unavailable = createContinuationRuntimeV1ApplicationService(
    harness({ policiesAvailable: false }).dependencies,
  );
  assert.deepEqual(await unavailable.readiness(), {
    ready: false,
    reason_codes: ["policy_bundle_unavailable"],
  });
});

test("candidate protected overflow is exposed as stable 503 capacity failure", async () => {
  const value = harness();
  const dependencies = {
    ...value.dependencies,
    operationStore: {
      ...value.dependencies.operationStore,
      execute: async (args: ExecuteContinuationRuntimeV1OperationArgs) => {
        await args.produce({} as ContinuationRuntimeV1AuthorityWriteContext);
        throw new Error("unreachable");
      },
    },
    decisionAssembly: {
      assemble: async () => {
        throw new ContinuationRuntimeV1CandidatePolicyCapacityError(
          EMPTY_RETRIEVAL.receipt,
        );
      },
    },
  } as ContinuationRuntimeV1ApplicationServiceDependencies;
  const app = createContinuationRuntimeV1ApplicationService(dependencies);
  await assert.rejects(
    app.createContinuation(CONTINUATION),
    (error: unknown) => error instanceof ContinuationRuntimeV1ApplicationError
      && error.statusCode === 503
      && error.code === "candidate_policy_capacity_exceeded",
  );
});

test("candidate source overflow is a distinct stable 503 before retrieval", async () => {
  assert.throws(
    () => assertContinuationRuntimeV1CandidateSourceCapacity(4_000, 100),
    (error: unknown) =>
      error instanceof ContinuationRuntimeV1CandidateSourceCapacityError
      && error.continuityCandidateCount === 4_000
      && error.learningCandidateCount === 100
      && error.sourceCandidateCount === 4_100
      && error.sourceCandidateLimit === 4_096
      && error.sourceCandidateBytes === 0
      && error.sourceCandidateBytesLimit === 64 * 1_024 * 1_024,
  );
  assert.doesNotThrow(() =>
    assertContinuationRuntimeV1CandidateSourceCapacity(3_996, 100));
  assert.throws(
    () => assertContinuationRuntimeV1CandidateSourceCapacity(
      1,
      0,
      64 * 1_024 * 1_024 + 1,
    ),
    ContinuationRuntimeV1CandidateSourceCapacityError,
  );
  const value = harness();
  const dependencies = {
    ...value.dependencies,
    operationStore: {
      ...value.dependencies.operationStore,
      execute: async (args: ExecuteContinuationRuntimeV1OperationArgs) => {
        await args.produce({} as ContinuationRuntimeV1AuthorityWriteContext);
        throw new Error("unreachable");
      },
    },
    decisionAssembly: {
      assemble: async () => {
        throw new ContinuationRuntimeV1CandidateSourceCapacityError(4_000, 100);
      },
    },
  } as ContinuationRuntimeV1ApplicationServiceDependencies;
  const app = createContinuationRuntimeV1ApplicationService(dependencies);
  await assert.rejects(
    app.createContinuation(CONTINUATION),
    (error: unknown) => error instanceof ContinuationRuntimeV1ApplicationError
      && error.statusCode === 503
      && error.code === "candidate_source_capacity_exceeded",
  );
});
