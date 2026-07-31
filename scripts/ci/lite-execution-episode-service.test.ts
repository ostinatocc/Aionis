import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import Fastify from "fastify";
import stableStringify from "fast-json-stable-stringify";

import {
  createRuntimeEpisodeVerifierInvocationAuthorityChannel,
  type RuntimeEpisodeVerifierInvocationAuthorityV1,
} from "../../src/execution/runtime-episode-verifier-launch-authority.js";
import {
  DEFAULT_CURRENT_STATE_AUDIT_RENDER_POLICY_V1,
  projectCurrentExecutionStateV2,
  renderCurrentExecutionStateV2,
} from "../../src/execution/current-execution-state.js";
import type {
  CurrentExecutionStateV2,
} from "../../src/execution/types.js";
import {
  createRuntimeEpisodeVerifierRegistry,
  type RuntimeEpisodeVerifierDefinitionInput,
  type RuntimeEpisodeVerifierLaunchLifecycleV1,
  type RuntimeEpisodeVerifierRegistry,
} from "../../src/execution/runtime-episode-verifier-registry.js";
import {
  createLiteExecutionStateStoreFromDatabase,
  type LiteExecutionStateStore,
} from "../../src/execution/state-store.js";
import type {
  VerifierSubjectMaterializationV1,
} from "../../src/execution/verifier-subject-materialization.js";
import {
  DecisionEpisodeV1Schema,
  EpisodeRewardV1Schema,
  VerifierOutcomeReceiptV1Schema,
} from "../../src/memory/execution-episode.js";
import {
  createProductExecutionEpisodeTransportService,
} from "../../src/product/execution-episode-transport-service.js";
import {
  createExecutionEpisodeService,
  type ExecutionEpisodeBeginInputV1,
  type ExecutionEpisodeCloseInputV1,
  type ExecutionEpisodeRecordActionInputV1,
  type ExecutionEpisodeRunVerifierInputV1,
  type ExecutionEpisodeService,
} from "../../src/product/execution-episode-service.js";
import {
  createExecutionTurnTransactionService,
  type ExecutionAgentSessionBeginInputV1,
  type ExecutionAgentSessionCredentialsV1,
  type ExecutionTurnTransactionService,
} from "../../src/product/execution-turn-transaction-service.js";
import type {
  ExecutionSessionLeaseV1,
} from "../../src/execution/agent-session.js";
import {
  ProductExecutionEpisodeOutcomeRequest,
  ProductObserveRouteRequest,
  type ProductServiceResult,
} from "../../src/product/product-services.js";
import {
  registerProductFacadeRoutes,
} from "../../src/routes/product-facade.js";
import {
  createAionisClient,
} from "../../src/sdk.js";
import {
  createRuntimeProductServices,
  registerRuntimeErrorHandler,
} from "../../src/server/http-server.js";
import {
  createLiteEvidenceArtifactStore,
  type LiteEvidenceArtifactStore,
} from "../../src/store/lite-evidence-artifact-store.js";
import {
  createLiteExecutionEpisodeStore,
  type LiteExecutionEpisodeStore,
} from "../../src/store/lite-execution-episode-store.js";
import {
  createLiteExecutionSessionLeaseStore,
  type LiteExecutionSessionLeaseStore,
} from "../../src/store/lite-execution-session-lease-store.js";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.js";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.js";

const TENANT = "tenant-execution-service";
const SCOPE = "tenant:tenant-execution-service:project:real-e2e";
const VERIFIER_ID = "real-cas-answer-verifier";
const EXPECTED_ANSWER = "verified answer\n";
const CREATED_AT = "2026-07-27T10:00:00.000Z";

type Fixture = Readonly<{
  directory: string;
  databasePath: string;
  subjectRoot: string;
  answerPath: string;
  verifierDirectory: string;
  verifierPath: string;
  verifierDefinition: RuntimeEpisodeVerifierDefinitionInput;
}>;

type Harness = Readonly<{
  database: LiteRuntimeDatabase;
  writeStore: LiteWriteStore;
  artifactStore: LiteEvidenceArtifactStore;
  episodeStore: LiteExecutionEpisodeStore;
  stateStore: LiteExecutionStateStore;
  sessionLeaseStore: LiteExecutionSessionLeaseStore;
  turnService: ExecutionTurnTransactionService;
  verifierRegistry: RuntimeEpisodeVerifierRegistry;
  service: ExecutionEpisodeService;
  close(): Promise<void>;
}>;

type PersistedVerifierExecutionEvidence = Readonly<{
  contract_version: string;
  runner_result: Readonly<{
    stdout: Readonly<{
      captured_base64: string;
    }>;
  }>;
}>;

type RealVerifierStdout = Readonly<{
  child_pid: number;
  parent_pid: number;
  cwd: string;
  subject_root: string;
  answer_sha256: string;
}>;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(): Fixture {
  const directory = mkdtempSync(
    join(tmpdir(), "aionis-execution-episode-service-"),
  );
  const subjectRoot = join(directory, "subject");
  const verifierDirectory = join(directory, "verifier");
  mkdirSync(subjectRoot);
  mkdirSync(verifierDirectory);

  const answerPath = join(subjectRoot, "answer.txt");
  writeFileSync(answerPath, "not verified\n", "utf8");

  const verifierPath = join(verifierDirectory, "verify-answer.mjs");
  writeFileSync(
    verifierPath,
    `
      import { createHash } from "node:crypto";
      import { readFileSync, realpathSync } from "node:fs";
      import { join } from "node:path";

      const subjectRootValue = process.env.AIONIS_VERIFIER_SUBJECT_ROOT;
      if (!subjectRootValue) {
        process.stderr.write("missing Runtime-owned subject root");
        process.exit(31);
      }
      const subjectRoot = realpathSync(subjectRootValue);
      const cwd = realpathSync(process.cwd());
      if (cwd !== subjectRoot) {
        process.stderr.write("verifier cwd is not the materialized subject");
        process.exit(32);
      }
      const answer = readFileSync(join(subjectRoot, "answer.txt"));
      const answerSha256 = createHash("sha256").update(answer).digest("hex");
      if (answerSha256 !== process.env.AIONIS_EXPECTED_ANSWER_SHA256) {
        process.stderr.write("answer digest mismatch");
        process.exit(33);
      }
      process.stdout.write(JSON.stringify({
        child_pid: process.pid,
        parent_pid: process.ppid,
        cwd,
        subject_root: subjectRoot,
        answer_sha256: answerSha256,
      }));
    `,
    { encoding: "utf8", mode: 0o600 },
  );

  const verifierDefinition: RuntimeEpisodeVerifierDefinitionInput = {
    verifier_id: VERIFIER_ID,
    verifier_kind: "independent_executable",
    verifier_version: "real-cas-answer-verifier-v1",
    verifier_issuer_id: "aionis-runtime-service-test",
    reward_role: "primary",
    verifier_material_paths: [verifierPath],
    runner_config: {
      executable: process.execPath,
      argv: [verifierPath],
      cwd: verifierDirectory,
      environment: {
        AIONIS_EXPECTED_ANSWER_SHA256: sha256(EXPECTED_ANSWER),
      },
      timeout_ms: 5_000,
      terminate_grace_ms: 100,
      max_stdout_bytes: 4_096,
      max_stderr_bytes: 4_096,
    },
  };

  return {
    directory,
    databasePath: join(directory, "runtime.sqlite"),
    subjectRoot,
    answerPath,
    verifierDirectory,
    verifierPath,
    verifierDefinition,
  };
}

function openHarness(
  databasePath: string,
  verifierDefinition: RuntimeEpisodeVerifierDefinitionInput,
  options: Readonly<{
    runtimeInstanceId?: string;
    wrapVerifierRegistry?: (
      registry: RuntimeEpisodeVerifierRegistry,
    ) => RuntimeEpisodeVerifierRegistry;
    sessionNow?: () => string;
  }> = {},
): Harness {
  const authorityChannel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const database = createLiteRuntimeDatabase(databasePath);
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    annProjectionEnabled: false,
  });
  const artifactStore = createLiteEvidenceArtifactStore(database);
  const episodeStore = createLiteExecutionEpisodeStore(database, {
    verifierInvocationAuthorityIssuer: authorityChannel.issuer,
    verifierInvocationAuthorityVerifier: authorityChannel.verifier,
  });
  const stateStore = createLiteExecutionStateStoreFromDatabase(
    database.db,
    {
      path: database.path,
      readDatabase: database.readDb,
      transaction: database.transaction,
    },
  );
  const sessionLeaseStore = createLiteExecutionSessionLeaseStore(
    database,
    options.sessionNow ? { now: options.sessionNow } : {},
  );
  const baseVerifierRegistry = createRuntimeEpisodeVerifierRegistry(
    [verifierDefinition],
    authorityChannel.verifier,
  );
  const verifierRegistry = options.wrapVerifierRegistry?.(
    baseVerifierRegistry,
  ) ?? baseVerifierRegistry;
  const service = createExecutionEpisodeService({
    artifactStore,
    episodeStore,
    stateStore,
    sessionLeaseStore,
    verifierRegistry,
    ...(options.runtimeInstanceId
      ? { runtimeInstanceId: options.runtimeInstanceId }
      : {}),
  });
  const turnService = createExecutionTurnTransactionService({
    episodeService: service,
    episodeStore,
    stateStore,
    sessionLeaseStore,
  });
  let closed = false;

  return {
    database,
    writeStore,
    artifactStore,
    episodeStore,
    stateStore,
    sessionLeaseStore,
    turnService,
    verifierRegistry,
    service,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await writeStore.close();
      } finally {
        await database.close();
      }
    },
  };
}

function parseVerifierExecutionEvidence(
  bytes: Buffer,
): PersistedVerifierExecutionEvidence {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const evidence = parsed as PersistedVerifierExecutionEvidence;
  assert.equal(
    evidence.contract_version,
    "runtime_episode_verifier_execution_evidence_v1",
  );
  assert.equal(
    typeof evidence.runner_result?.stdout?.captured_base64,
    "string",
  );
  return evidence;
}

function parseRealVerifierStdout(
  evidence: PersistedVerifierExecutionEvidence,
): RealVerifierStdout {
  const stdout = Buffer.from(
    evidence.runner_result.stdout.captured_base64,
    "base64",
  ).toString("utf8");
  const parsed = JSON.parse(stdout) as unknown;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const result = parsed as RealVerifierStdout;
  assert.equal(typeof result.child_pid, "number");
  assert.equal(typeof result.parent_pid, "number");
  assert.equal(typeof result.cwd, "string");
  assert.equal(typeof result.subject_root, "string");
  assert.equal(typeof result.answer_sha256, "string");
  return result;
}

function successfulProductBody(
  result: ProductServiceResult,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.ok(
    result.body !== null
      && typeof result.body === "object"
      && !Array.isArray(result.body),
  );
  return result.body as Record<string, unknown>;
}

async function beginAndMutateVerifiedAnswer(
  harness: Harness,
  fixture: Fixture,
  prefix: string,
): Promise<Readonly<{
  started: Awaited<ReturnType<ExecutionEpisodeService["begin"]>>;
  action: Awaited<ReturnType<ExecutionEpisodeService["recordAction"]>>;
}>> {
  const sourceTaskBytes = Buffer.from(
    "Write the exact verified answer and run the registered verifier.",
    "utf8",
  );
  const started = await harness.service.begin({
    tenantId: TENANT,
    publicScope: SCOPE,
    storeScope: SCOPE,
    operationId: `${prefix}-begin`,
    taskEnvelope: {
      contract_version: "host_task_envelope_v1",
      host_task_id: `${prefix}-task`,
      collector_id: "real-service-durable-launch-harness",
      collector_version: "v1",
      task_family: "real-workspace-answer-edit",
      task_signature: `${prefix}-write-and-verify`,
      repository_signature: "filesystem-subject-v1",
      source_task_sha256: sha256(sourceTaskBytes),
      source_event_sha256: sha256(`${prefix}-source-event`),
      created_at: CREATED_AT,
    },
    sourceTaskBytes,
    runId: `${prefix}-run`,
    modelId: "real-host-process",
    modelConfig: {
      provider: "real-process-harness",
      model: "real-host-process",
      temperature: 0,
    },
    budget: {
      max_steps: 8,
      max_tokens: 8_000,
      deadline_ms: 60_000,
    },
    workspaceRoot: fixture.subjectRoot,
    subjectStateSpec: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
    requiredVerifierId: VERIFIER_ID,
  });
  writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
  const action = await harness.service.recordAction({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: `${prefix}-action`,
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      started.initial_state_snapshot.snapshot_id,
    actionKind: "file_write",
    toolName: "node_fs_write_file",
    requestBytes: Buffer.from(stableStringify({
      path: "answer.txt",
      expected_sha256: sha256(EXPECTED_ANSWER),
    })),
    resultBytes: Buffer.from(stableStringify({
      actual_sha256: sha256(readFileSync(fixture.answerPath)),
    })),
  });
  return Object.freeze({ started, action });
}

function sessionCredentials(
  lease: ExecutionSessionLeaseV1,
): ExecutionAgentSessionCredentialsV1 {
  return {
    tenantId: lease.binding.tenant_id,
    storeScope: lease.binding.store_scope,
    sessionKey: lease.binding.session_key,
    holderId: lease.holder_id,
    leaseId: lease.lease_id,
    leaseRevision: lease.lease_revision,
  };
}

function rejectsWithCode(expectedCode: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(
      (error as Error & { code?: unknown }).code,
      expectedCode,
    );
    return true;
  };
}

test("agent session owns one real episode across retry, expiry, handoff, verifier, release, and restart", async (t) => {
  const fixture = createFixture();
  let leaseClockMs = Date.parse("2026-07-28T08:00:00.000Z");
  const sessionNow = () => new Date(leaseClockMs).toISOString();
  let harness: Harness | null = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
    { sessionNow },
  );
  t.after(async () => {
    await harness?.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const sourceTaskBytes = Buffer.from(
    "Replace answer.txt with the exact verified answer, verify it, and preserve enough execution state for another Agent to finish.",
    "utf8",
  );
  const beginInput: ExecutionAgentSessionBeginInputV1 = {
    tenantId: TENANT,
    publicScope: SCOPE,
    storeScope: SCOPE,
    operationId: "session-real-begin",
    sessionKey: "session-real-agent-handoff",
    continuationId: "continuation-real-agent-handoff",
    holderId: "agent-holder-a",
    leaseTtlMs: 1_000,
    taskEnvelope: {
      contract_version: "host_task_envelope_v1",
      host_task_id: "session-real-task",
      collector_id: "agent-session-real-harness",
      collector_version: "v1",
      task_family: "real-workspace-answer-edit",
      task_signature: "session-replace-answer-and-verify",
      repository_signature: "filesystem-subject-v1",
      source_task_sha256: sha256(sourceTaskBytes),
      source_event_sha256: sha256("session-real-source-event"),
      created_at: CREATED_AT,
    },
    sourceTaskBytes,
    runId: "session-real-run",
    modelId: "real-host-agent-a",
    modelConfig: {
      provider: "real-host-process",
      model: "real-host-agent-a",
      temperature: 0,
    },
    budget: {
      max_steps: 20,
      max_tokens: 20_000,
      max_cost_micros: 1_000_000,
      deadline_ms: 120_000,
    },
    workspaceRoot: fixture.subjectRoot,
    subjectStateSpec: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
    requiredVerifierId: VERIFIER_ID,
  };

  const started = await harness.turnService.beginOrResume(beginInput);
  assert.equal(started.resumed, false);
  assert.equal(started.session.event.event_kind, "acquired");
  assert.equal(started.session.lease.lease_revision, 1);
  assert.equal(
    started.session.lease.binding.continuation_id,
    beginInput.continuationId,
  );
  assert.equal(
    started.current_state.continuation_id,
    beginInput.continuationId,
  );
  assert.equal(
    started.current_state.episode_id,
    started.episode?.episode.episode_id,
  );

  const exactBeginReplay =
    await harness.turnService.beginOrResume(beginInput);
  assert.equal(exactBeginReplay.resumed, true);
  assert.equal(exactBeginReplay.session.replayed, true);
  assert.equal(exactBeginReplay.session.event.event_kind, "acquired");
  assert.equal(
    (
      await harness.sessionLeaseStore.listEvents({
        tenantId: TENANT,
        scope: SCOPE,
        sessionKey: beginInput.sessionKey,
      })
    ).length,
    1,
  );

  const initialCredentials = sessionCredentials(started.session.lease);
  const observationEvidence = Buffer.from(stableStringify({
    observed_path: "answer.txt",
    observed_sha256: sha256(readFileSync(fixture.answerPath)),
  }));
  const observation = await harness.turnService.runLeased({
    credentials: initialCredentials,
    leaseOperationId: "session-real-observation-lease",
    operationBinding: {
      kind: "semantic_observation",
      operation_id: "session-real-observation",
      evidence_sha256: sha256(observationEvidence),
    },
    expectedEpisodeId: started.episode!.episode.episode_id,
    expectedContinuationId: beginInput.continuationId,
    leaseTtlMs: 1_000,
    execute: async () =>
      await harness!.service.recordObservation({
        tenantId: TENANT,
        storeScope: SCOPE,
        episodeId: started.episode!.episode.episode_id,
        operationId: "session-real-observation",
        workspaceRoot: fixture.subjectRoot,
        expectedCurrentStateSnapshotId:
          started.current_state_snapshot.snapshot_id,
        observation:
          "answer.txt has not yet reached the verifier-required content.",
        authority: {
          kind: "host_declared",
          actorId: "real-host-agent-a",
        },
        evidenceKind: "tool_result",
        evidenceBytes: observationEvidence,
        evidenceMediaType: "application/json",
        evidenceEncoding: "utf-8",
      }),
  });
  assert.equal(observation.session.event.event_kind, "renewed");
  assert.equal(observation.session.lease.lease_revision, 2);
  assert.notEqual(
    observation.current_state.state_sha256,
    started.current_state.state_sha256,
  );
  assert.equal(
    observation.current_state.observations.some((item) =>
      item.statement.includes("has not yet reached")),
    true,
  );

  writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
  const actionRequest = Buffer.from(stableStringify({
    operation: "write_file",
    path: "answer.txt",
    content_sha256: sha256(EXPECTED_ANSWER),
  }));
  const actionResultBytes = Buffer.from(stableStringify({
    ok: true,
    byte_length: Buffer.byteLength(EXPECTED_ANSWER),
    content_sha256: sha256(readFileSync(fixture.answerPath)),
  }));
  const actionCredentials = sessionCredentials(observation.session.lease);
  const action = await harness.turnService.runLeased({
    credentials: actionCredentials,
    leaseOperationId: "session-real-action-lease",
    operationBinding: {
      kind: "action",
      operation_id: "session-real-action",
      request_sha256: sha256(actionRequest),
      result_sha256: sha256(actionResultBytes),
    },
    expectedEpisodeId: started.episode!.episode.episode_id,
    expectedContinuationId: beginInput.continuationId,
    leaseTtlMs: 1_000,
    execute: async () =>
      await harness!.service.recordAction({
        tenantId: TENANT,
        storeScope: SCOPE,
        episodeId: started.episode!.episode.episode_id,
        operationId: "session-real-action",
        workspaceRoot: fixture.subjectRoot,
        expectedCurrentStateSnapshotId:
          observation.result.current_state_snapshot.snapshot_id,
        actionKind: "file_write",
        toolName: "node_fs_write_file",
        requestBytes: actionRequest,
        resultBytes: actionResultBytes,
      }),
  });
  assert.equal(action.result.action.mutation, true);
  assert.equal(action.session.event.event_kind, "renewed");
  assert.equal(action.session.lease.lease_revision, 3);
  assert.equal(
    action.session.lease.current_state_sha256,
    action.current_state.state_sha256,
  );

  const actionRetry = await harness.turnService.runLeased({
    credentials: actionCredentials,
    leaseOperationId: "session-real-action-lease",
    operationBinding: {
      kind: "action",
      operation_id: "session-real-action",
      request_sha256: sha256(actionRequest),
      result_sha256: sha256(actionResultBytes),
    },
    expectedEpisodeId: started.episode!.episode.episode_id,
    expectedContinuationId: beginInput.continuationId,
    leaseTtlMs: 1_000,
    execute: async () =>
      await harness!.service.recordAction({
        tenantId: TENANT,
        storeScope: SCOPE,
        episodeId: started.episode!.episode.episode_id,
        operationId: "session-real-action",
        workspaceRoot: fixture.subjectRoot,
        expectedCurrentStateSnapshotId:
          observation.result.current_state_snapshot.snapshot_id,
        actionKind: "file_write",
        toolName: "node_fs_write_file",
        requestBytes: actionRequest,
        resultBytes: actionResultBytes,
      }),
  });
  assert.equal(actionRetry.result.replayed, true);
  assert.equal(actionRetry.session.replayed, true);
  assert.equal(actionRetry.session.lease.lease_revision, 3);

  await assert.rejects(
    async () =>
      await harness!.turnService.beginOrResume({
        ...beginInput,
        operationId: "session-real-conflicting-acquire",
        holderId: "agent-holder-b",
        modelId: "real-host-agent-b",
      }),
    rejectsWithCode("execution_session_active_lease_conflict"),
  );

  leaseClockMs =
    Date.parse(action.session.lease.expires_at!) + 1;
  const takeover = await harness.turnService.beginOrResume({
    ...beginInput,
    operationId: "session-real-expired-takeover",
    holderId: "agent-holder-b",
    modelId: "real-host-agent-b",
  });
  assert.equal(takeover.resumed, true);
  assert.equal(takeover.session.event.event_kind, "taken_over");
  assert.equal(takeover.session.lease.lease_revision, 4);
  assert.notEqual(
    takeover.session.lease.lease_id,
    action.session.lease.lease_id,
  );

  const takeoverCredentials =
    sessionCredentials(takeover.session.lease);
  const handoff = await harness.turnService.handoff({
    credentials: takeoverCredentials,
    operationId: "session-real-handoff",
    toHolderId: "agent-holder-c",
    evidenceRefs: [action.result.event.event_id],
    leaseTtlMs: 1_000,
  });
  assert.equal(handoff.event.event_kind, "handed_off");
  assert.equal(handoff.lease.lease_revision, 5);
  assert.equal(handoff.lease.holder_id, "agent-holder-c");
  assert.equal(handoff.handoff_receipt?.from_holder_id, "agent-holder-b");
  assert.equal(handoff.handoff_receipt?.to_holder_id, "agent-holder-c");
  assert.equal(
    handoff.handoff_receipt?.state_sha256,
    action.current_state.state_sha256,
  );

  let staleHolderExecuted = false;
  await assert.rejects(
    async () =>
      await harness!.turnService.runLeased({
        credentials: takeoverCredentials,
        leaseOperationId: "session-real-stale-holder-operation",
        operationBinding: {
          kind: "must_not_execute",
        },
        execute: async () => {
          staleHolderExecuted = true;
          return null;
        },
      }),
    rejectsWithCode("execution_session_lease_cas_conflict"),
  );
  assert.equal(staleHolderExecuted, false);

  const verifier = await harness.turnService.runLeased({
    credentials: sessionCredentials(handoff.lease),
    leaseOperationId: "session-real-verifier-lease",
    operationBinding: {
      kind: "run_verifier",
      operation_id: "session-real-verifier",
      target_snapshot_id:
        action.result.current_state_snapshot.snapshot_id,
    },
    expectedEpisodeId: started.episode!.episode.episode_id,
    expectedContinuationId: beginInput.continuationId,
    leaseTtlMs: 1_000,
    execute: async () =>
      await harness!.service.runVerifier({
        tenantId: TENANT,
        storeScope: SCOPE,
        episodeId: started.episode!.episode.episode_id,
        operationId: "session-real-verifier",
        workspaceRoot: fixture.subjectRoot,
        expectedCurrentStateSnapshotId:
          action.result.current_state_snapshot.snapshot_id,
      }),
  });
  assert.equal(verifier.result.outcome.status, "passed");
  assert.equal(verifier.result.outcome.execution_exit_code, 0);
  assert.equal(verifier.session.lease.lease_revision, 6);
  const verifierEvidence =
    await harness.artifactStore.readArtifactBytes({
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: started.episode!.episode.episode_id,
      artifactId:
        verifier.result.outcome.verifier_output_ref.artifact_id,
    });
  const verifierStdout = parseRealVerifierStdout(
    parseVerifierExecutionEvidence(verifierEvidence),
  );
  assert.notEqual(verifierStdout.child_pid, process.pid);
  assert.equal(
    verifierStdout.answer_sha256,
    sha256(EXPECTED_ANSWER),
  );

  const closed = await harness.turnService.closeAndRelease({
    credentials: sessionCredentials(verifier.session.lease),
    close: {
      operationId: "session-real-close",
      workspaceRoot: fixture.subjectRoot,
      expectedCurrentStateSnapshotId:
        verifier.result.current_state_snapshot.snapshot_id,
      termination: "completed",
      verifierReceiptId:
        verifier.result.outcome.verifier_receipt_id,
      outcomeDetails: [
        "the registered verifier passed against Runtime-owned state",
      ],
    },
    releaseOperationId: "session-real-release",
  });
  assert.equal(closed.result.event.payload.event_kind, "episode_closed");
  assert.equal(closed.session.event.event_kind, "released");
  assert.equal(closed.session.lease.status, "released");
  assert.equal(closed.session.lease.lease_revision, 7);
  assert.equal(closed.session.lease.expires_at, null);

  const events = await harness.sessionLeaseStore.listEvents({
    tenantId: TENANT,
    scope: SCOPE,
    sessionKey: beginInput.sessionKey,
  });
  assert.deepEqual(
    events.map((event) => event.event_kind),
    [
      "acquired",
      "renewed",
      "renewed",
      "taken_over",
      "handed_off",
      "renewed",
      "released",
    ],
  );
  for (const [index, event] of events.entries()) {
    assert.equal(event.lease_revision, index + 1);
    assert.equal(
      event.previous_event_sha256,
      index === 0 ? null : events[index - 1]!.event_sha256,
    );
  }

  await harness.close();
  harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
    { sessionNow },
  );
  const persisted = await harness.sessionLeaseStore.get({
    tenantId: TENANT,
    scope: SCOPE,
    sessionKey: beginInput.sessionKey,
  });
  assert.equal(persisted?.status, "released");
  assert.equal(persisted?.lease_revision, 7);
  assert.equal(
    persisted?.last_event_sha256,
    events.at(-1)?.event_sha256,
  );
  const replay = await harness.episodeStore.replayEpisode({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode!.episode.episode_id,
  });
  assert.equal(replay.closed, true);
  assert.equal(replay.reward?.verified_success, 1);
  const persistedCurrentState = harness.stateStore.getCurrent(
    SCOPE,
    beginInput.continuationId,
  );
  assert.equal(
    persistedCurrentState?.state.episode_id,
    started.episode!.episode.episode_id,
  );
  assert.equal(
    persistedCurrentState?.state.continuation_id,
    beginInput.continuationId,
  );
  assert.equal(
    persistedCurrentState?.state.state_sha256,
    closed.current_state.state_sha256,
  );
});

test("public SDK completes a real Agent session over local Runtime HTTP without manual identity stitching", async (t) => {
  const fixture = createFixture();
  const publicScope = "sdk-real-project";
  const storeScope = publicScope;
  const harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
  );
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
    await harness.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const env = {
    AIONIS_EDITION: "lite",
    MEMORY_AUTH_MODE: "off",
    MEMORY_TENANT_ID: TENANT,
    MEMORY_SCOPE: publicScope,
    LITE_LOCAL_ACTOR_ID: "sdk-real-agent",
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_INSPECT_BEFORE_USE_MODE: "shadow",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: "[]",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED:
      false,
  } as never;
  const services = createRuntimeProductServices({
    env,
    liteWriteStore: harness.writeStore,
    liteRecallAccess: null,
    embedder: null,
    queryEmbedder: null,
    executionTreeStore: null,
    claimLedgerAccess: null,
    learningEpisodeLedgerAccess: null,
    learningControlJobAccess: null,
    skillCandidateReviewAccess: null,
    memoryWriteService: null,
    handoffRouteService: null,
    executionEpisodeService: harness.service,
    executionTurnTransactionService: harness.turnService,
    executionEpisodeStore: harness.episodeStore,
    evidenceArtifactStore: harness.artifactStore,
    executionStateStore: harness.stateStore,
  });
  registerRuntimeErrorHandler(app);
  registerProductFacadeRoutes({
    app,
    services,
    planningContextService: null,
    requireMemoryPrincipal: async () => null,
    withIdentityFromRequest: (_request, body) => body,
    enforceRateLimit: async () => {},
    enforceTenantQuota: async () => {},
    tenantFromBody: (body) => {
      if (
        body
        && typeof body === "object"
        && !Array.isArray(body)
        && typeof (body as { tenant_id?: unknown }).tenant_id === "string"
      ) {
        return (body as { tenant_id: string }).tenant_id;
      }
      return TENANT;
    },
    acquireInflightSlot: async () => ({
      wait_ms: 0,
      release: () => {},
    }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const client = createAionisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    tenant_id: TENANT,
    scope: publicScope,
  });

  const sourceTaskBytes = Buffer.from(
    "Use the real local workspace to replace answer.txt, hand the task to a second Agent, run the registered verifier, and finish.",
    "utf8",
  );
  const session = await client.agentSession.begin({
    operation_id: "sdk-real-session-begin",
    session_key: "sdk-real-session",
    continuation_id: "sdk-real-continuation",
    holder_id: "sdk-real-agent-a",
    task_envelope_v1: {
      contract_version: "host_task_envelope_v1",
      host_task_id: "sdk-real-task",
      collector_id: "sdk-real-http-runtime",
      collector_version: "v1",
      task_family: "real-workspace-answer-edit",
      task_signature: "sdk-real-replace-answer-and-verify",
      repository_signature: "filesystem-subject-v1",
      source_task_sha256: sha256(sourceTaskBytes),
      source_event_sha256: sha256("sdk-real-source-event"),
      created_at: CREATED_AT,
    },
    source_task: sourceTaskBytes,
    run_id: "sdk-real-run",
    model_id: "sdk-real-agent-a",
    model_config: {
      provider: "real-host-process",
      model: "sdk-real-agent-a",
      temperature: 0,
    },
    budget: {
      max_steps: 20,
      max_tokens: 20_000,
      max_cost_micros: 1_000_000,
      deadline_ms: 120_000,
    },
    workspace_root: fixture.subjectRoot,
    subject_state_spec_v2: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
    required_verifier_id: VERIFIER_ID,
    tenant_id: TENANT,
    scope: publicScope,
  });
  assert.equal(session.episodeId.length > 0, true);
  assert.equal(session.continuationId, "sdk-real-continuation");
  assert.equal(session.handle.lease_revision, 1);

  const sdkObservationExcerpt =
    "answer.txt still contains its pre-task bytes before the real file-write action.";
  const sdkObservation = await session.recordObservation<{
    current_execution_state: {
      decisive_evidence?: Array<{
        source_ref: string;
        excerpt: string;
      }>;
    };
  }>({
    operation_id: "sdk-real-observation",
    observation:
      "The exact answer still needs to be written before verification.",
    authority: {
      kind: "host_declared",
      actor_id: "sdk-real-agent-a",
    },
    evidence_kind: "tool_result",
    evidence: {
      path: "answer.txt",
      sha256: sha256(readFileSync(fixture.answerPath)),
      decisive_excerpt: sdkObservationExcerpt,
    },
    decisive_evidence: [{
      source_ref: "workspace:answer.txt",
      excerpt: sdkObservationExcerpt,
    }],
  });
  assert.equal(session.handle.lease_revision, 2);
  assert.equal(
    sdkObservation.current_execution_state.decisive_evidence?.[0]
      ?.excerpt,
    sdkObservationExcerpt,
  );

  const action = await session.aroundAction({
    operation_id: "sdk-real-action",
    action_kind: "file_write",
    tool_name: "node_fs_write_file",
    request: {
      path: "answer.txt",
      content_sha256: sha256(EXPECTED_ANSWER),
    },
    execute: async () => {
      writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
      return {
        ok: true,
        content_sha256: sha256(readFileSync(fixture.answerPath)),
      };
    },
  });
  assert.equal(action.result.ok, true);
  assert.equal(session.handle.lease_revision, 3);
  const actionReceipt = action.receipt as {
    event?: { event_id?: string };
  };
  const acceptedCandidateSnapshotId =
    session.currentStateSnapshotId;
  const acceptedVerification = await session.runVerifier<{
    outcome: {
      status: string;
      verifier_receipt_id: string;
    };
  }>({
    operation_id: "sdk-real-accepted-candidate-verifier",
  });
  assert.equal(acceptedVerification.outcome.status, "passed");
  assert.equal(session.handle.lease_revision, 4);
  const regressedPath = join(
    fixture.subjectRoot,
    "regressed.txt",
  );
  await session.aroundAction({
    operation_id: "sdk-real-regression-action",
    action_kind: "file_write",
    tool_name: "node_fs_write_file",
    request: {
      paths: ["answer.txt", "regressed.txt"],
      intent: "simulate a later regressed branch",
    },
    execute: async () => {
      writeFileSync(fixture.answerPath, "regressed answer\n", "utf8");
      writeFileSync(regressedPath, "later branch\n", "utf8");
      return {
        ok: true,
        answer_sha256: sha256(readFileSync(fixture.answerPath)),
        regressed_sha256: sha256(readFileSync(regressedPath)),
      };
    },
  });
  assert.equal(session.handle.lease_revision, 5);
  assert.equal(
    readFileSync(fixture.answerPath, "utf8"),
    "regressed answer\n",
  );
  assert.equal(existsSync(regressedPath), true);

  const failedVerification = await session.runVerifier<{
    outcome: {
      status: string;
      verifier_receipt_id: string;
    };
    current_execution_state: CurrentExecutionStateV2;
  }>({
    operation_id: "sdk-real-regressed-candidate-verifier",
  });
  assert.equal(failedVerification.outcome.status, "failed");
  assert.equal(session.handle.lease_revision, 6);
  const recoveryRecommendation =
    failedVerification.current_execution_state
      .continuity_projection?.branch_state
      .recovery_recommendation;
  assert.ok(recoveryRecommendation);
  assert.equal(
    recoveryRecommendation.reason_code,
    "current_verifier_failed_prior_snapshot_passed",
  );
  assert.equal(
    recoveryRecommendation.current_failed_candidate.snapshot_id,
    session.currentStateSnapshotId,
  );
  assert.equal(
    recoveryRecommendation.current_failed_candidate
      .verifier_receipt_id,
    failedVerification.outcome.verifier_receipt_id,
  );
  assert.equal(
    recoveryRecommendation.target_accepted_candidate.snapshot_id,
    acceptedCandidateSnapshotId,
  );
  assert.equal(
    recoveryRecommendation.target_accepted_candidate
      .verifier_receipt_id,
    acceptedVerification.outcome.verifier_receipt_id,
  );
  assert.equal(
    failedVerification.current_execution_state
      .continuity_projection?.readiness.status,
    "recovery_recommended",
  );
  assert.equal(
    failedVerification.current_execution_state
      .continuity_projection?.readiness
      .safe_to_execute_planned_action,
    false,
  );
  await assert.rejects(
    harness.service.close({
      tenantId: TENANT,
      storeScope,
      episodeId: session.episodeId,
      operationId: "sdk-real-direct-missing-verifier-close",
      workspaceRoot: fixture.subjectRoot,
      expectedCurrentStateSnapshotId:
        session.currentStateSnapshotId,
      termination: "completed",
    }),
    /execution_episode_completion_verifier_required/u,
  );
  await assert.rejects(
    harness.service.close({
      tenantId: TENANT,
      storeScope,
      episodeId: session.episodeId,
      operationId: "sdk-real-direct-stale-verifier-close",
      workspaceRoot: fixture.subjectRoot,
      expectedCurrentStateSnapshotId:
        session.currentStateSnapshotId,
      termination: "completed",
      verifierReceiptId:
        acceptedVerification.outcome.verifier_receipt_id,
    }),
    /execution_episode_completion_verifier_stale/u,
  );
  await assert.rejects(
    harness.service.close({
      tenantId: TENANT,
      storeScope,
      episodeId: session.episodeId,
      operationId: "sdk-real-direct-failed-close",
      workspaceRoot: fixture.subjectRoot,
      expectedCurrentStateSnapshotId:
        session.currentStateSnapshotId,
      termination: "completed",
      verifierReceiptId:
        failedVerification.outcome.verifier_receipt_id,
    }),
    /execution_episode_completion_verifier_not_passed/u,
  );
  const blockedFinish = await session.finish<{
    outcome: {
      status: string;
      verifier_receipt_id: string;
    };
  }, never>({
    verifier_operation_id: "sdk-real-blocked-finish-verifier",
    close_operation_id: "sdk-real-blocked-finish-close",
    recovery_mode: "manual",
    termination: "completed",
  });
  assert.equal(blockedFinish.status, "continue");
  assert.equal(blockedFinish.verifier_status, "failed");
  assert.equal(blockedFinish.close, null);
  assert.equal(
    blockedFinish.continuation?.reason,
    "verifier_failed",
  );
  assert.equal(
    blockedFinish.continuation?.current_state_snapshot_id,
    session.currentStateSnapshotId,
  );
  assert.equal(blockedFinish.continuation?.recovery, null);
  assert.equal(session.active, true);
  assert.equal(session.handle.episode.closed, false);
  assert.equal(session.handle.lease_revision, 7);
  const failedStateRender = renderCurrentExecutionStateV2({
    state: failedVerification.current_execution_state,
  });
  assert.match(
    failedStateRender.text,
    new RegExp(
      `recovery_action: restore_snapshot target=${
        acceptedCandidateSnapshotId.replace(
          /[.*+?^${}()|[\]\\]/gu,
          "\\$&",
        )
      }`,
      "u",
    ),
  );
  assert.match(
    failedStateRender.text,
    /reason=current_verifier_failed_prior_snapshot_passed/u,
  );

  const failedCandidateSnapshotId = session.currentStateSnapshotId;
  const readOnlyAfterFailure = await session.aroundAction<{
    ok: boolean;
    content_sha256: string;
  }, {
    current_execution_state: CurrentExecutionStateV2;
  }>({
    operation_id: "sdk-real-read-after-failed-verifier",
    action_kind: "file_read",
    tool_name: "node_fs_read_file",
    request: {
      path: "answer.txt",
    },
    execute: async () => ({
      ok: true,
      content_sha256: sha256(readFileSync(fixture.answerPath)),
    }),
  });
  assert.equal(readOnlyAfterFailure.result.ok, true);
  assert.equal(session.handle.lease_revision, 8);
  assert.equal(
    session.currentStateSnapshotId,
    failedCandidateSnapshotId,
  );
  const readOnlyBranch =
    readOnlyAfterFailure.receipt.current_execution_state
      .continuity_projection?.branch_state;
  assert.equal(
    readOnlyBranch?.current_candidate.verification_status,
    "failed",
    "a non-mutating action must preserve verifier truth for the exact current snapshot",
  );
  assert.equal(
    readOnlyBranch?.recovery_recommendation
      ?.target_accepted_candidate.snapshot_id,
    acceptedCandidateSnapshotId,
  );
  assert.equal(
    readOnlyBranch?.candidate_ledger?.total_candidate_count,
    3,
    "a non-mutating action must not manufacture another branch candidate",
  );

  const recoveredFinish = await session.finish<{
    outcome: {
      status: string;
      verifier_receipt_id: string;
    };
  }, never, {
    restored_exact: boolean;
    recovery_target_snapshot: {
      snapshot_id: string;
      content_digest: string;
    };
    state_after_snapshot: {
      snapshot_id: string;
      content_digest: string;
    };
    current_execution_state: CurrentExecutionStateV2;
  }>({
    verifier_operation_id: "sdk-real-auto-recovery-verifier",
    close_operation_id: "sdk-real-auto-recovery-close",
    termination: "completed",
  });
  assert.equal(recoveredFinish.status, "continue");
  assert.equal(recoveredFinish.verifier_status, "failed");
  assert.equal(
    recoveredFinish.continuation?.reason,
    "verified_branch_restored",
  );
  if (
    recoveredFinish.status !== "continue"
    || recoveredFinish.continuation.recovery === null
  ) {
    assert.fail(
      "a failed current branch with an accepted predecessor must restore",
    );
  }
  const recovery = recoveredFinish.continuation.recovery;
  const restored = recovery.response;
  assert.equal(recovery.status, "restored");
  assert.match(recovery.operation_id, /^finish-recovery-[a-f0-9]{48}$/u);
  assert.equal(
    recovery.failed_snapshot_id,
    failedCandidateSnapshotId,
  );
  assert.equal(
    recovery.restored_snapshot_id,
    acceptedCandidateSnapshotId,
  );
  assert.equal(
    recovery.accepted_verifier_receipt_id,
    acceptedVerification.outcome.verifier_receipt_id,
  );
  assert.equal(restored.restored_exact, true);
  assert.equal(
    restored.recovery_target_snapshot.snapshot_id,
    acceptedCandidateSnapshotId,
  );
  assert.equal(
    restored.state_after_snapshot.snapshot_id,
    acceptedCandidateSnapshotId,
    "exact restoration must reuse the historical CAS snapshot identity",
  );
  assert.equal(
    restored.state_after_snapshot.content_digest,
    restored.recovery_target_snapshot.content_digest,
  );
  assert.equal(
    readFileSync(fixture.answerPath, "utf8"),
    EXPECTED_ANSWER,
  );
  assert.equal(existsSync(regressedPath), false);
  assert.equal(session.handle.lease_revision, 10);
  const restoredLedger =
    restored.current_execution_state.continuity_projection
      ?.branch_state.candidate_ledger;
  assert.equal(restoredLedger?.total_candidate_count, 4);
  assert.equal(
    restoredLedger?.entries.at(-1)?.transition?.action_kind,
    "state_snapshot_restore",
  );
  assert.equal(
    restored.current_execution_state.continuity_projection
      ?.branch_state.recovery_recommendation,
    null,
  );
  assert.equal(
    restored.current_execution_state.continuity_projection
      ?.branch_state.accepted_candidate_is_current,
    true,
  );

  await session.handoff({
    operation_id: "sdk-real-handoff",
    to_holder_id: "sdk-real-agent-b",
    evidence_refs: actionReceipt.event?.event_id
      ? [actionReceipt.event.event_id]
      : [],
  });
  assert.equal(session.handle.holder_id, "sdk-real-agent-b");
  assert.equal(session.handle.lease_revision, 11);

  const resumed = await client.agentSession.resume(
    session.toJSON(),
    { operation_id: "sdk-real-resume-agent-b" },
  );
  assert.equal(resumed.handle.holder_id, "sdk-real-agent-b");
  assert.equal(resumed.handle.lease_revision, 12);
  const finished = await resumed.finish<{
    outcome: {
      status: string;
      execution_exit_code: number | null;
    };
  }, {
    event: {
      payload: {
        event_kind: string;
      };
    };
  }>({
    verifier_operation_id: "sdk-real-verifier",
    close_operation_id: "sdk-real-close",
    termination: "completed",
    outcome_details: [
      "the real registered verifier passed after an Agent handoff",
    ],
  });
  assert.equal(finished.status, "completed");
  assert.equal(finished.verifier.outcome.status, "passed");
  assert.equal(finished.verifier.outcome.execution_exit_code, 0);
  if (finished.status !== "completed") {
    assert.fail("a passed verifier must complete the Agent session");
  }
  assert.equal(
    finished.close.event.payload.event_kind,
    "episode_closed",
  );
  assert.equal(resumed.active, false);
  assert.equal(resumed.handle.lease_status, "released");
  assert.equal(resumed.handle.episode.closed, true);
  assert.equal(
    readFileSync(fixture.answerPath, "utf8"),
    EXPECTED_ANSWER,
  );

  const persisted = await harness.sessionLeaseStore.get({
    tenantId: TENANT,
    scope: storeScope,
    sessionKey: "sdk-real-session",
  });
  assert.equal(persisted?.holder_id, "sdk-real-agent-b");
  assert.equal(persisted?.status, "released");
  const replay = await harness.episodeStore.replayEpisode({
    tenantId: TENANT,
    scope: storeScope,
    episodeId: resumed.episodeId,
  });
  assert.equal(replay.closed, true);
  assert.equal(replay.reward?.verified_success, 1);
});

test("service exactly restores real structured-artifact and SQLite subjects through their canonical adapters", async (t) => {
  const fixture = createFixture();
  const harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
  );
  t.after(async () => {
    await harness.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const beginSubject = async (
    prefix: string,
    subjectPath: string,
    subjectStateSpec:
      NonNullable<ExecutionEpisodeBeginInputV1["subjectStateSpec"]>,
  ) => {
    const sourceTaskBytes = Buffer.from(
      `Mutate and then exactly recover the real ${prefix} subject.`,
      "utf8",
    );
    return await harness.service.begin({
      tenantId: TENANT,
      publicScope: SCOPE,
      storeScope: SCOPE,
      operationId: `${prefix}-begin`,
      taskEnvelope: {
        contract_version: "host_task_envelope_v1",
        host_task_id: `${prefix}-task`,
        collector_id: "real-subject-restore-harness",
        collector_version: "v1",
        task_family: "exact-subject-state-recovery",
        task_signature: `${prefix}-mutate-and-recover`,
        repository_signature: "local-real-subject-v1",
        source_task_sha256: sha256(sourceTaskBytes),
        source_event_sha256: sha256(`${prefix}-source-event`),
        created_at: CREATED_AT,
      },
      sourceTaskBytes,
      runId: `${prefix}-run`,
      modelId: "real-host-process",
      modelConfig: {
        provider: "real-process-harness",
        model: "real-host-process",
        temperature: 0,
      },
      budget: {
        max_steps: 8,
        max_tokens: 8_000,
        deadline_ms: 60_000,
      },
      workspaceRoot: subjectPath,
      subjectStateSpec,
      requiredVerifierId: VERIFIER_ID,
    });
  };

  const jsonPath = join(fixture.subjectRoot, "state.json");
  const initialJson = Buffer.from(
    "{\"answer\":\"accepted\",\"nested\":{\"count\":1}}\n",
    "utf8",
  );
  writeFileSync(jsonPath, initialJson);
  const jsonStarted = await beginSubject(
    "real-json-restore",
    jsonPath,
    {
      contract_version: "structured_artifact_subject_state_spec_v1",
      format: "json",
      capture_scope: "entire_artifact",
    },
  );
  const initialJsonCas = await harness.artifactStore.readArtifactBytes({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: jsonStarted.episode.episode_id,
    artifactId:
      jsonStarted.initial_state_snapshot.artifact_ref.artifact_id,
  });
  writeFileSync(
    jsonPath,
    "{\"answer\":\"regressed\",\"nested\":{\"count\":2}}\n",
    "utf8",
  );
  const jsonRegression = await harness.service.recordAction({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: jsonStarted.episode.episode_id,
    operationId: "real-json-regression",
    workspaceRoot: jsonPath,
    expectedCurrentStateSnapshotId:
      jsonStarted.initial_state_snapshot.snapshot_id,
    actionKind: "structured_artifact_update",
    toolName: "node_fs_write_file",
    requestBytes: Buffer.from("replace JSON state", "utf8"),
    resultBytes: Buffer.from("regressed JSON persisted", "utf8"),
  });
  const jsonRestoreInput = {
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: jsonStarted.episode.episode_id,
    operationId: "real-json-exact-restore",
    workspaceRoot: jsonPath,
    expectedCurrentStateSnapshotId:
      jsonRegression.state_after_snapshot.snapshot_id,
    targetSnapshotId:
      jsonStarted.initial_state_snapshot.snapshot_id,
  } as const;
  const jsonRestored = await harness.service.restoreSnapshot(
    jsonRestoreInput,
  );
  assert.equal(jsonRestored.restored_exact, true);
  assert.equal(
    jsonRestored.state_after_snapshot.snapshot_id,
    jsonStarted.initial_state_snapshot.snapshot_id,
  );
  assert.deepEqual(readFileSync(jsonPath), initialJsonCas);
  const jsonReplay = await harness.service.restoreSnapshot(
    jsonRestoreInput,
  );
  assert.equal(jsonReplay.replayed, true);
  assert.equal(
    jsonReplay.event.event_id,
    jsonRestored.event.event_id,
  );

  const sqlitePath = join(fixture.subjectRoot, "state.sqlite");
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec(
    "CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);"
      + " INSERT INTO state (id, value) VALUES (1, 'accepted');",
  );
  sqlite.close();
  const sqliteStarted = await beginSubject(
    "real-sqlite-restore",
    sqlitePath,
    {
      contract_version: "sqlite_database_subject_state_spec_v1",
      capture_scope: "entire_database",
    },
  );
  const initialSqliteCas =
    await harness.artifactStore.readArtifactBytes({
      tenantId: TENANT,
      scope: SCOPE,
      episodeId: sqliteStarted.episode.episode_id,
      artifactId:
        sqliteStarted.initial_state_snapshot.artifact_ref.artifact_id,
    });
  const regressedSqlite = new DatabaseSync(sqlitePath);
  regressedSqlite.exec(
    "UPDATE state SET value = 'regressed' WHERE id = 1;"
      + " INSERT INTO state (id, value) VALUES (2, 'extra');",
  );
  regressedSqlite.close();
  const sqliteRegression = await harness.service.recordAction({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: sqliteStarted.episode.episode_id,
    operationId: "real-sqlite-regression",
    workspaceRoot: sqlitePath,
    expectedCurrentStateSnapshotId:
      sqliteStarted.initial_state_snapshot.snapshot_id,
    actionKind: "sqlite_transaction",
    toolName: "node_sqlite",
    requestBytes: Buffer.from("update authoritative rows", "utf8"),
    resultBytes: Buffer.from("regressed transaction committed", "utf8"),
  });
  const sqliteRestored = await harness.service.restoreSnapshot({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: sqliteStarted.episode.episode_id,
    operationId: "real-sqlite-exact-restore",
    workspaceRoot: sqlitePath,
    expectedCurrentStateSnapshotId:
      sqliteRegression.state_after_snapshot.snapshot_id,
    targetSnapshotId:
      sqliteStarted.initial_state_snapshot.snapshot_id,
  });
  assert.equal(sqliteRestored.restored_exact, true);
  assert.equal(
    sqliteRestored.state_after_snapshot.snapshot_id,
    sqliteStarted.initial_state_snapshot.snapshot_id,
  );
  assert.deepEqual(readFileSync(sqlitePath), initialSqliteCas);
  const restoredSqlite = new DatabaseSync(sqlitePath, {
    readOnly: true,
  });
  try {
    const restoredRows = restoredSqlite.prepare(
      "SELECT id, value FROM state ORDER BY id",
    ).all() as Array<{ id: number; value: string }>;
    assert.deepEqual(
      restoredRows.map((row) => ({
        id: row.id,
        value: row.value,
      })),
      [{ id: 1, value: "accepted" }],
    );
    const quickCheck = restoredSqlite.prepare(
      "PRAGMA quick_check",
    ).all() as Array<{ quick_check: string }>;
    assert.deepEqual(
      quickCheck.map((row) => ({
        quick_check: row.quick_check,
      })),
      [{ quick_check: "ok" }],
    );
  } finally {
    restoredSqlite.close();
  }
});

test("service runs a real verifier against CAS, closes, reopens, and exactly replays", async (t) => {
  const fixture = createFixture();
  let harness: Harness | null = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
  );
  t.after(async () => {
    await harness?.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const sourceTaskBytes = Buffer.from(
    "Replace answer.txt with the exact UTF-8 text: verified answer\\n",
    "utf8",
  );
  const beginInput: ExecutionEpisodeBeginInputV1 = {
    tenantId: TENANT,
    publicScope: SCOPE,
    storeScope: SCOPE,
    operationId: "service-e2e-begin",
    taskEnvelope: {
      contract_version: "host_task_envelope_v1",
      host_task_id: "service-e2e-task",
      collector_id: "real-service-e2e-collector",
      collector_version: "v1",
      task_family: "real-workspace-answer-edit",
      task_signature: "replace-answer-with-exact-text",
      repository_signature: "filesystem-subject-v1",
      source_task_sha256: sha256(sourceTaskBytes),
      source_event_sha256: sha256("service-e2e-source-event"),
      created_at: CREATED_AT,
    },
    sourceTaskBytes,
    runId: "service-e2e-run",
    modelId: "real-host-model",
    modelConfig: {
      provider: "local-real-process-host",
      model: "real-host-model",
      temperature: 0,
    },
    budget: {
      max_steps: 20,
      max_tokens: 20_000,
      max_cost_micros: 1_000_000,
      deadline_ms: 120_000,
    },
    workspaceRoot: fixture.subjectRoot,
    subjectStateSpec: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
    requiredVerifierId: VERIFIER_ID,
  };

  const started = await harness.service.begin(beginInput);
  assert.equal(started.replayed, false);
  assert.equal(started.event.payload.event_kind, "episode_started");
  assert.equal(
    started.episode.required_verifier.verifier_id,
    VERIFIER_ID,
  );
  assert.equal(
    started.episode.required_verifier.verifier_definition_sha256,
    harness.verifierRegistry.resolve(VERIFIER_ID)?.identity.definition_sha256,
  );
  assert.equal(
    started.episode.subject_identity.canonical_root_sha256,
    sha256(realpathSync(fixture.subjectRoot)),
  );

  writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
  const actionInput: ExecutionEpisodeRecordActionInputV1 = {
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-e2e-action",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      started.initial_state_snapshot.snapshot_id,
    actionKind: "file_write",
    toolName: "node_fs_write_file",
    requestBytes: Buffer.from(stableStringify({
      operation: "write_file",
      path: "answer.txt",
      content_sha256: sha256(EXPECTED_ANSWER),
    })),
    resultBytes: Buffer.from(stableStringify({
      ok: true,
      byte_length: Buffer.byteLength(EXPECTED_ANSWER),
      content_sha256: sha256(EXPECTED_ANSWER),
    })),
  };
  const action = await harness.service.recordAction(actionInput);
  assert.equal(action.replayed, false);
  assert.equal(action.action.mutation, true);
  assert.notEqual(
    action.state_after_snapshot.snapshot_id,
    started.initial_state_snapshot.snapshot_id,
  );
  assert.equal(
    action.current_state_snapshot.snapshot_id,
    action.state_after_snapshot.snapshot_id,
  );
  assert.equal(
    readFileSync(fixture.answerPath, "utf8"),
    EXPECTED_ANSWER,
  );

  const notePath = join(fixture.subjectRoot, "verification-note.txt");
  writeFileSync(notePath, "second state\n", "utf8");
  const secondActionInput: ExecutionEpisodeRecordActionInputV1 = {
    ...actionInput,
    operationId: "service-e2e-action-second",
    expectedCurrentStateSnapshotId:
      action.state_after_snapshot.snapshot_id,
    requestBytes: Buffer.from(stableStringify({
      operation: "write_file",
      path: "verification-note.txt",
      content_sha256: sha256("second state\n"),
    })),
    resultBytes: Buffer.from(stableStringify({
      ok: true,
      byte_length: Buffer.byteLength("second state\n"),
      content_sha256: sha256("second state\n"),
    })),
  };
  const secondAction = await harness.service.recordAction(secondActionInput);
  assert.equal(secondAction.replayed, false);
  assert.notEqual(
    secondAction.state_after_snapshot.snapshot_id,
    action.state_after_snapshot.snapshot_id,
  );
  const historicalReplay = await harness.service.recordAction(actionInput);
  assert.equal(historicalReplay.replayed, true);
  assert.equal(
    historicalReplay.state_after_snapshot.snapshot_id,
    action.state_after_snapshot.snapshot_id,
    "an exact replay must preserve the historical action result",
  );
  assert.equal(
    historicalReplay.current_state_snapshot.snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
    "an exact replay must return the current episode head separately",
  );

  const semanticAuthority = {
    kind: "host_declared" as const,
    actorId: "real-service-host-agent",
  };
  const semanticBase = {
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      secondAction.state_after_snapshot.snapshot_id,
    authority: semanticAuthority,
    evidenceKind: "tool_result" as const,
    evidenceBytes: Buffer.from(stableStringify({
      answer_sha256: sha256(readFileSync(fixture.answerPath)),
      verification_note_sha256: sha256(readFileSync(notePath)),
    })),
    evidenceMediaType: "application/json",
    evidenceEncoding: "utf-8",
  };
  const observationExcerpt =
    "answer.txt contains the verifier-target bytes and verification-note.txt is present.";
  const observationInput = {
    ...semanticBase,
    operationId: "service-e2e-semantic-observation",
    observation:
      "The exact answer file is present and a second verification note exists.",
    evidenceBytes: Buffer.from(stableStringify({
      answer_sha256: sha256(readFileSync(fixture.answerPath)),
      verification_note_sha256: sha256(readFileSync(notePath)),
      decisive_excerpt: observationExcerpt,
    })),
    decisiveEvidence: [{
      sourceRef: "workspace:answer.txt+verification-note.txt",
      excerpt: observationExcerpt,
    }],
  };
  const observation =
    await harness.service.recordObservation(observationInput);
  assert.equal(observation.replayed, false);
  assert.equal(
    observation.semantic_event.target_state_snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );

  const decision = await harness.service.recordDecision({
    ...semanticBase,
    operationId: "service-e2e-agent-decision",
    decision:
      "Run the independent verifier against the exact current snapshot.",
    reasons: [
      "The requested answer bytes are present.",
      "Only the independent verifier can authorize task success.",
    ],
    alternativesRejected: [
      "Do not infer success from the write tool result alone.",
    ],
    evidenceKind: "prompt",
    evidenceBytes: sourceTaskBytes,
    evidenceMediaType: "text/plain",
  });
  assert.equal(decision.replayed, false);

  const progress = await harness.service.recordProgress({
    ...semanticBase,
    operationId: "service-e2e-progress",
    itemId: "replace-answer-file",
    state: "completed",
    statement: "The requested answer bytes were written to answer.txt.",
  });
  assert.equal(progress.semantic_event.state, "completed");

  const plannedAction = await harness.service.recordPlannedAction({
    ...semanticBase,
    operationId: "service-e2e-planned-action",
    actionId: "run-independent-verifier",
    intent: "Verify the exact current workspace state.",
    justification:
      "A write receipt is not authoritative evidence of task success.",
    preconditions: [
      "The current workspace snapshot still matches the recorded state.",
    ],
  });
  assert.equal(plannedAction.replayed, false);

  const openReplay = await harness.episodeStore.replayEpisode({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
  });
  const openCurrentState = projectCurrentExecutionStateV2({
    episode: openReplay.episode,
    events: openReplay.events,
    current_state_snapshot_id: openReplay.current_state_snapshot_id,
    goal: sourceTaskBytes.toString("utf8"),
  });
  assert.equal(openCurrentState.revision, 7);
  assert.equal(openCurrentState.episode_status, "open");
  assert.equal(openCurrentState.completed.length, 1);
  assert.equal(
    openCurrentState.completed[0]?.item_id,
    "replace-answer-file",
  );
  assert.equal(openCurrentState.failed.length, 0);
  assert.equal(openCurrentState.unresolved.length, 0);
  assert.equal(openCurrentState.blocked.length, 0);
  assert.equal(openCurrentState.observations.length, 1);
  assert.equal(openCurrentState.decisive_evidence?.length, 1);
  assert.equal(
    openCurrentState.decisive_evidence?.[0]?.excerpt,
    observationExcerpt,
  );
  assert.equal(openCurrentState.decisions.length, 1);
  assert.equal(
    openCurrentState.next_action?.action_id,
    "run-independent-verifier",
  );
  assert.equal(
    openCurrentState.next_action?.intent,
    "Verify the exact current workspace state.",
  );
  const openContinuity = openCurrentState.continuity_projection;
  assert.ok(openContinuity);
  assert.equal(
    openContinuity.task_contract.constraints.length,
    1,
  );
  assert.equal(
    openContinuity.task_contract.constraints[0]?.statement,
    sourceTaskBytes.toString("utf8"),
  );
  assert.equal(
    openContinuity.task_contract.coverage.unresolved_count,
    1,
  );
  assert.equal(
    openContinuity.epistemic_state.reported_count,
    1,
  );
  assert.equal(
    openContinuity.epistemic_state.hypothesis_count,
    0,
  );
  assert.equal(
    openContinuity.branch_state.current_candidate.snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );
  assert.equal(
    openContinuity.branch_state.current_candidate.verification_status,
    "unverified",
  );
  assert.equal(
    openContinuity.branch_state.last_verifier_accepted,
    null,
  );
  const openCandidateLedger =
    openContinuity.branch_state.candidate_ledger;
  assert.ok(openCandidateLedger);
  assert.equal(openCandidateLedger.total_candidate_count, 3);
  assert.equal(openCandidateLedger.retained_candidate_count, 3);
  assert.equal(
    openCandidateLedger.history_complete_in_projection,
    true,
  );
  assert.deepEqual(
    openCandidateLedger.entries.map(
      (entry) => entry.candidate.snapshot_id,
    ),
    [
      started.initial_state_snapshot.snapshot_id,
      action.state_after_snapshot.snapshot_id,
      secondAction.state_after_snapshot.snapshot_id,
    ],
  );
  assert.deepEqual(
    openCandidateLedger.entries.map(
      (entry) => entry.candidate.verification_status,
    ),
    ["unverified", "unverified", "unverified"],
  );
  assert.equal(
    openCandidateLedger.entries[1]?.transition?.source_snapshot_id,
    started.initial_state_snapshot.snapshot_id,
  );
  assert.equal(
    openCandidateLedger.entries[1]?.transition?.action_id,
    action.action.action_id,
  );
  assert.equal(
    openCandidateLedger.entries[1]?.transition?.action_kind,
    "file_write",
  );
  assert.equal(
    openCandidateLedger.entries[1]?.transition?.delta_content_sha256,
    openCandidateLedger.entries[1]?.transition?.delta_ref.sha256,
  );
  assert.ok(
    openCandidateLedger.entries[1]?.transition?.changed_fields_preview
      .some((field) => field.includes("answer.txt")),
  );
  assert.ok(
    openCandidateLedger.entries[2]?.transition?.changed_fields_preview
      .some((field) => field.includes("verification-note.txt")),
  );
  assert.equal(openContinuity.readiness.status, "ready_to_act");
  assert.equal(
    openContinuity.readiness.safe_to_execute_planned_action,
    true,
  );
  assert.equal(openCurrentState.pending_checks.length, 1);
  assert.equal(
    openCurrentState.pending_checks[0]?.target_state_snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );
  const openCurrentStateRender = renderCurrentExecutionStateV2({
    state: openCurrentState,
  });
  const openCurrentStateHead = harness.stateStore.getCurrent(
    SCOPE,
    openCurrentState.continuation_id,
  );
  assert.ok(openCurrentStateHead);
  assert.equal(
    openCurrentStateHead.state.state_sha256,
    openCurrentState.state_sha256,
  );
  assert.equal(openCurrentStateHead.revision, openCurrentState.revision);
  assert.equal(openCurrentStateRender.token_count, null);
  assert.equal(
    openCurrentStateRender.token_measurement.authority,
    "unavailable",
  );
  assert.match(
    openCurrentStateRender.text,
    /next_action: Verify the exact current workspace state\./u,
  );
  assert.match(
    openCurrentStateRender.text,
    /protected_task_contract: verification=unverified coverage=0\/1/u,
  );
  assert.match(
    openCurrentStateRender.text,
    /next_action_why: A write receipt is not authoritative evidence of task success\./u,
  );
  assert.match(
    openCurrentStateRender.text,
    /next_action_preconditions:/u,
  );
  assert.match(
    openCurrentStateRender.text,
    /\[reported\] The exact answer file is present/u,
  );
  assert.match(
    openCurrentStateRender.text,
    /candidate_ledger: retained=3\/3 complete=true/u,
  );
  assert.match(
    openCurrentStateRender.text,
    new RegExp(
      `latest_prior_candidate: snapshot=${
        action.state_after_snapshot.snapshot_id
      } verification=unverified action=file_write`,
      "u",
    ),
  );
  assert.match(
    openCurrentStateRender.text,
    /continuation_evidence:/u,
  );
  assert.doesNotMatch(
    openCurrentStateRender.text,
    /^decisive_evidence:/mu,
  );
  assert.match(openCurrentStateRender.text, /\[completed/u);
  const openCurrentStateAuditRender = renderCurrentExecutionStateV2({
    state: openCurrentState,
    policy: DEFAULT_CURRENT_STATE_AUDIT_RENDER_POLICY_V1,
  });
  assert.match(
    openCurrentStateAuditRender.text,
    /decisive_evidence:/u,
  );
  assert.match(
    openCurrentStateAuditRender.text,
    /answer\.txt contains the verifier-target bytes/u,
  );

  const observationReplay =
    await harness.service.recordObservation(observationInput);
  assert.equal(observationReplay.replayed, true);
  assert.equal(
    observationReplay.event.event_sha256,
    observation.event.event_sha256,
  );

  await assert.rejects(
    harness.service.runVerifier({
      tenantId: TENANT,
      storeScope: SCOPE,
      episodeId: started.episode.episode_id,
      operationId: "service-e2e-verifier-stale-handle",
      workspaceRoot: fixture.subjectRoot,
      expectedCurrentStateSnapshotId:
        action.state_after_snapshot.snapshot_id,
    }),
    /execution_episode_verifier_target_state_stale/u,
  );

  const verifierInput: ExecutionEpisodeRunVerifierInputV1 = {
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-e2e-verifier",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      secondAction.state_after_snapshot.snapshot_id,
  };
  const verified = await harness.service.runVerifier(verifierInput);
  assert.equal(verified.replayed, false);
  assert.equal(verified.outcome.status, "passed");
  assert.equal(verified.outcome.execution_exit_code, 0);
  assert.equal(
    verified.outcome.verified_state_snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );

  const verifierOutputBytes = await harness.artifactStore.readArtifactBytes({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
    artifactId: verified.outcome.verifier_output_ref.artifact_id,
  });
  assert.equal(
    sha256(verifierOutputBytes),
    verified.outcome.verifier_output_ref.sha256,
  );
  const executionEvidence = parseVerifierExecutionEvidence(
    verifierOutputBytes,
  );
  const verifierStdout = parseRealVerifierStdout(executionEvidence);
  assert.notEqual(verifierStdout.child_pid, process.pid);
  assert.equal(verifierStdout.parent_pid, process.pid);
  assert.equal(verifierStdout.cwd, verifierStdout.subject_root);
  assert.notEqual(
    verifierStdout.subject_root,
    realpathSync(fixture.subjectRoot),
  );
  assert.equal(verifierStdout.answer_sha256, sha256(EXPECTED_ANSWER));
  assert.equal(
    readFileSync(fixture.answerPath, "utf8"),
    EXPECTED_ANSWER,
    "the CAS verifier must not mutate the live subject",
  );

  const closeInput: ExecutionEpisodeCloseInputV1 = {
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-e2e-close",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      secondAction.state_after_snapshot.snapshot_id,
    termination: "completed",
    verifierReceiptId: verified.outcome.verifier_receipt_id,
    outcomeDetails: [
      "real Node verifier passed against the materialized final state",
      "live subject remained unchanged during verification",
    ],
  };
  const closed = await harness.service.close(closeInput);
  assert.equal(closed.replayed, false);

  const beforeReopen = await harness.episodeStore.verifyEpisodeIntegrity({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
  });
  assert.equal(beforeReopen.closed, true);
  assert.equal(beforeReopen.reward_eligible, true);
  assert.equal(beforeReopen.reward?.verified_success, 1);
  assert.equal(beforeReopen.reward?.tool_call_count, 2);
  assert.equal(
    beforeReopen.cost_receipt?.token_usage_authority,
    "unavailable",
  );
  assert.equal(beforeReopen.cost_receipt?.input_tokens, null);
  assert.equal(beforeReopen.cost_receipt?.output_tokens, null);
  assert.equal(
    beforeReopen.cost_receipt?.tool_calls,
    beforeReopen.reward?.tool_call_count,
  );
  const closedCurrentState = projectCurrentExecutionStateV2({
    episode: beforeReopen.episode,
    events: beforeReopen.events,
    current_state_snapshot_id: beforeReopen.current_state_snapshot_id,
    goal: sourceTaskBytes.toString("utf8"),
  });
  assert.equal(closedCurrentState.episode_status, "closed");
  assert.equal(closedCurrentState.next_action, null);
  assert.equal(closedCurrentState.verified_facts.length, 1);
  assert.equal(closedCurrentState.verified_facts[0]?.status, "passed");
  assert.deepEqual(closedCurrentState.pending_checks, []);
  const closedContinuity = closedCurrentState.continuity_projection;
  assert.ok(closedContinuity);
  assert.equal(
    closedContinuity.task_contract.verification_status,
    "passed",
  );
  assert.equal(
    closedContinuity.task_contract.coverage.satisfied_count,
    1,
  );
  assert.equal(
    closedContinuity.branch_state.accepted_candidate_is_current,
    true,
  );
  assert.equal(
    closedContinuity.branch_state.last_verifier_accepted?.snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );
  const closedCandidateLedger =
    closedContinuity.branch_state.candidate_ledger;
  assert.ok(closedCandidateLedger);
  assert.equal(closedCandidateLedger.total_candidate_count, 3);
  assert.deepEqual(
    closedCandidateLedger.entries.map(
      (entry) => entry.candidate.verification_status,
    ),
    ["unverified", "unverified", "passed"],
  );
  assert.equal(
    closedCandidateLedger.entries.at(-1)
      ?.candidate.verifier_receipt_id,
    verified.outcome.verifier_receipt_id,
  );
  assert.deepEqual(
    closedCandidateLedger.entries.at(-1)
      ?.verification_evidence_refs.map((ref) => ref.artifact_id),
    [
      verified.outcome.verifier_input_ref.artifact_id,
      verified.outcome.verifier_output_ref.artifact_id,
      verified.verified_state_snapshot.artifact_ref.artifact_id,
    ],
  );
  assert.equal(
    closedContinuity.readiness.status,
    "verified_complete",
  );
  const closedCurrentStateHead = harness.stateStore.getCurrent(
    SCOPE,
    closedCurrentState.continuation_id,
  );
  assert.ok(closedCurrentStateHead);
  assert.equal(
    closedCurrentStateHead.state.state_sha256,
    closedCurrentState.state_sha256,
  );
  assert.equal(
    closedCurrentStateHead.last_projection_event_id,
    beforeReopen.events.at(-1)?.event_id,
  );
  assert.deepEqual(
    beforeReopen.events.map((event) => event.payload.event_kind),
    [
      "episode_started",
      "action_observed",
      "action_observed",
      "semantic_observation_recorded",
      "agent_decision_recorded",
      "progress_state_recorded",
      "planned_action_recorded",
      "verifier_recorded",
      "episode_closed",
    ],
  );
  const originalEventDigests = beforeReopen.events.map(
    (event) => event.event_sha256,
  );
  const originalVerifierReceiptCount = (
    harness.database.db.prepare(
      `SELECT count(*) AS count
       FROM lite_execution_verifier_receipts
       WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
    ).get(
      TENANT,
      SCOPE,
      started.episode.episode_id,
    ) as { count: number }
  ).count;
  assert.equal(originalVerifierReceiptCount, 1);

  await harness.close();
  harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
  );

  const replayedBegin = await harness.service.begin(beginInput);
  assert.equal(replayedBegin.replayed, true);
  assert.equal(
    replayedBegin.event.event_sha256,
    started.event.event_sha256,
  );
  const replayedAction = await harness.service.recordAction(actionInput);
  assert.equal(replayedAction.replayed, true);
  assert.equal(
    replayedAction.event.event_sha256,
    action.event.event_sha256,
  );
  assert.equal(
    replayedAction.current_state_snapshot.snapshot_id,
    secondAction.state_after_snapshot.snapshot_id,
  );
  const replayedVerifier = await harness.service.runVerifier(verifierInput);
  assert.equal(replayedVerifier.replayed, true);
  assert.equal(
    replayedVerifier.event.event_sha256,
    verified.event.event_sha256,
  );
  assert.equal(
    replayedVerifier.outcome.evidence_digest,
    verified.outcome.evidence_digest,
  );
  const replayedClose = await harness.service.close(closeInput);
  assert.equal(replayedClose.replayed, true);
  assert.equal(
    replayedClose.event.event_sha256,
    closed.event.event_sha256,
  );

  const afterReopen = await harness.episodeStore.verifyEpisodeIntegrity({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
  });
  assert.deepEqual(
    afterReopen.events.map((event) => event.event_sha256),
    originalEventDigests,
  );
  assert.equal(afterReopen.reward?.verified_success, 1);
  const replayedClosedCurrentState = projectCurrentExecutionStateV2({
    episode: afterReopen.episode,
    events: afterReopen.events,
    current_state_snapshot_id: afterReopen.current_state_snapshot_id,
    goal: sourceTaskBytes.toString("utf8"),
  });
  assert.equal(
    replayedClosedCurrentState.state_sha256,
    closedCurrentState.state_sha256,
    "fresh-process replay must reproduce the exact semantic current state",
  );
  const reopenedCurrentStateHead = harness.stateStore.getCurrent(
    SCOPE,
    replayedClosedCurrentState.continuation_id,
  );
  assert.ok(reopenedCurrentStateHead);
  assert.equal(
    reopenedCurrentStateHead.state.state_sha256,
    replayedClosedCurrentState.state_sha256,
    "fresh-process state-store audit must retain the exact replay head",
  );
  assert.equal(
    (
      harness.database.db.prepare(
        `SELECT count(*) AS count
         FROM lite_execution_verifier_receipts
         WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
      ).get(
        TENANT,
        SCOPE,
        started.episode.episode_id,
      ) as { count: number }
    ).count,
    originalVerifierReceiptCount,
  );
  assert.deepEqual(await harness.episodeStore.verifyIntegrity(), {
    episode_count: 1,
    event_count: 9,
    closed_episode_count: 1,
    selector_eligible_episode_count: 0,
  });
  const artifactIntegrity = await harness.artifactStore.inspectIntegrity();
  assert.equal(artifactIntegrity.ok, true);
  assert.deepEqual(artifactIntegrity.problems, []);
});

test("a post-prepare launch exception is durably terminalized by its owner", async (t) => {
  const fixture = createFixture();
  const harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
    {
      runtimeInstanceId: "service-owner-abort-runtime",
      wrapVerifierRegistry(base) {
        const launch = (async (
          authority: RuntimeEpisodeVerifierInvocationAuthorityV1 | string,
          materialization?: VerifierSubjectMaterializationV1,
          lifecycle?: RuntimeEpisodeVerifierLaunchLifecycleV1,
        ) => {
          if (typeof authority === "string") {
            return await base.launch(authority);
          }
          assert.ok(materialization);
          assert.ok(lifecycle);
          return await base.launch(
            authority,
            materialization,
            {
              ...lifecycle,
              async persist_prepared_launch(prepared) {
                await lifecycle.persist_prepared_launch(prepared);
                throw new Error("prepared_commit_ack_lost");
              },
            },
          );
        }) as RuntimeEpisodeVerifierRegistry["launch"];
        return Object.freeze({
          registry_status: base.registry_status,
          identities: base.identities,
          resolve: base.resolve.bind(base),
          launch,
        });
      },
    },
  );
  t.after(async () => {
    await harness.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const { started, action } = await beginAndMutateVerifiedAnswer(
    harness,
    fixture,
    "service-owner-abort",
  );
  const verified = await harness.service.runVerifier({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-owner-abort-verifier",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      action.current_state_snapshot.snapshot_id,
  });
  assert.equal(verified.outcome.status, "infrastructure_error");
  assert.deepEqual(
    verified.outcome.infrastructure_failure_reasons,
    ["runtime_episode_verifier_owner_aborted_before_result"],
  );
  assert.equal(
    verified.outcome.infrastructure_failure_attribution,
    "arm_caused",
  );
  assert.equal(verified.outcome.execution_exit_code, null);
  const events = harness.database.db.prepare(
    `SELECT event_kind, event_owner_instance_id, event_owner_process_id
     FROM lite_execution_verifier_launch_attempt_events
     ORDER BY event_sequence`,
  ).all() as Array<{
    event_kind: string;
    event_owner_instance_id: string;
    event_owner_process_id: number;
  }>;
  assert.deepEqual(
    events.map((event) => event.event_kind),
    ["launch_committed", "interrupted"],
  );
  assert.equal(
    events[1]?.event_owner_instance_id,
    "service-owner-abort-runtime",
  );
  assert.equal(events[1]?.event_owner_process_id, process.pid);
  await harness.service.close({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-owner-abort-close",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      action.current_state_snapshot.snapshot_id,
    termination: "agent_error",
    verifierReceiptId: verified.outcome.verifier_receipt_id,
    outcomeDetails: [
      "prepared launch commit succeeded but acknowledgement failed",
      "the owning Runtime terminalized the attempt as ITT failure",
    ],
  });
  const integrity = await harness.episodeStore.verifyEpisodeIntegrity({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
  });
  assert.equal(integrity.reward?.verified_success, 0);
  assert.equal(integrity.reward?.outcome_class, "arm_caused_incomplete");
  assert.deepEqual(await harness.episodeStore.verifyIntegrity(), {
    episode_count: 1,
    event_count: 4,
    closed_episode_count: 1,
    selector_eligible_episode_count: 0,
  });
});

test("a new Runtime instance recovers an open attempt even when the old PID is still alive", async (t) => {
  const fixture = createFixture();
  let releasePrepared!: () => void;
  let preparedPersisted!: () => void;
  const releasePreparedPromise = new Promise<void>((resolve) => {
    releasePrepared = resolve;
  });
  const preparedPersistedPromise = new Promise<void>((resolve) => {
    preparedPersisted = resolve;
  });
  const harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
    {
      runtimeInstanceId: "service-live-pid-owner",
      wrapVerifierRegistry(base) {
        const launch = (async (
          authority: RuntimeEpisodeVerifierInvocationAuthorityV1 | string,
          materialization?: VerifierSubjectMaterializationV1,
          lifecycle?: RuntimeEpisodeVerifierLaunchLifecycleV1,
        ) => {
          if (typeof authority === "string") {
            return await base.launch(authority);
          }
          assert.ok(materialization);
          assert.ok(lifecycle);
          return await base.launch(
            authority,
            materialization,
            {
              ...lifecycle,
              async persist_prepared_launch(prepared) {
                await lifecycle.persist_prepared_launch(prepared);
                preparedPersisted();
                await releasePreparedPromise;
              },
            },
          );
        }) as RuntimeEpisodeVerifierRegistry["launch"];
        return Object.freeze({
          registry_status: base.registry_status,
          identities: base.identities,
          resolve: base.resolve.bind(base),
          launch,
        });
      },
    },
  );
  t.after(async () => {
    releasePrepared();
    await harness.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const sourceTaskBytes = Buffer.from(
    "Write the exact verified answer and run the registered verifier.",
    "utf8",
  );
  const started = await harness.service.begin({
    tenantId: TENANT,
    publicScope: SCOPE,
    storeScope: SCOPE,
    operationId: "service-live-pid-begin",
    taskEnvelope: {
      contract_version: "host_task_envelope_v1",
      host_task_id: "service-live-pid-task",
      collector_id: "real-service-live-pid-harness",
      collector_version: "v1",
      task_family: "real-workspace-answer-edit",
      task_signature: "recover-open-attempt-with-reused-live-pid",
      repository_signature: "filesystem-subject-v1",
      source_task_sha256: sha256(sourceTaskBytes),
      source_event_sha256: sha256("service-live-pid-source-event"),
      created_at: CREATED_AT,
    },
    sourceTaskBytes,
    runId: "service-live-pid-run",
    modelId: "real-host-process",
    modelConfig: {
      provider: "real-process-harness",
      model: "real-host-process",
      temperature: 0,
    },
    budget: {
      max_steps: 8,
      max_tokens: 8_000,
      deadline_ms: 60_000,
    },
    workspaceRoot: fixture.subjectRoot,
    subjectStateSpec: {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
    requiredVerifierId: VERIFIER_ID,
  });
  writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
  const action = await harness.service.recordAction({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-live-pid-action",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      started.initial_state_snapshot.snapshot_id,
    actionKind: "file_write",
    toolName: "node_fs_write_file",
    requestBytes: Buffer.from(stableStringify({
      path: "answer.txt",
      expected_sha256: sha256(EXPECTED_ANSWER),
    })),
    resultBytes: Buffer.from(stableStringify({
      actual_sha256: sha256(readFileSync(fixture.answerPath)),
    })),
  });
  const verifierPromise = harness.service.runVerifier({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-live-pid-verifier",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      action.current_state_snapshot.snapshot_id,
  });
  await preparedPersistedPromise;
  const openAttempt = harness.database.db.prepare(
    `SELECT owner_instance_id, owner_process_id
     FROM lite_execution_verifier_launch_attempts`,
  ).get() as {
    owner_instance_id: string;
    owner_process_id: number;
  };
  assert.equal(openAttempt.owner_instance_id, "service-live-pid-owner");
  assert.equal(openAttempt.owner_process_id, process.pid);

  const recoveryService = createExecutionEpisodeService({
    artifactStore: harness.artifactStore,
    episodeStore: harness.episodeStore,
    stateStore: harness.stateStore,
    verifierRegistry: harness.verifierRegistry,
    runtimeInstanceId: "service-live-pid-recovery",
  });
  const recovery =
    await recoveryService.recoverInterruptedVerifierLaunches();
  assert.deepEqual(recovery, {
    recovered_count: 1,
    cleanup_failure_count: 0,
  });
  releasePrepared();
  const verified = await verifierPromise;
  assert.equal(verified.outcome.status, "infrastructure_error");
  assert.deepEqual(
    verified.outcome.infrastructure_failure_reasons,
    ["runtime_episode_verifier_recovered_launch_ambiguous"],
  );
  assert.equal(
    verified.outcome.infrastructure_failure_attribution,
    "arm_caused",
  );
  assert.equal(verified.outcome.execution_exit_code, null);

  await recoveryService.close({
    tenantId: TENANT,
    storeScope: SCOPE,
    episodeId: started.episode.episode_id,
    operationId: "service-live-pid-close",
    workspaceRoot: fixture.subjectRoot,
    expectedCurrentStateSnapshotId:
      action.current_state_snapshot.snapshot_id,
    termination: "cancelled",
    verifierReceiptId: verified.outcome.verifier_receipt_id,
    outcomeDetails: [
      "a different Runtime instance recovered the durable attempt",
      "a live or reused PID did not inherit durable ownership",
    ],
  });
  const integrity = await harness.episodeStore.verifyEpisodeIntegrity({
    tenantId: TENANT,
    scope: SCOPE,
    episodeId: started.episode.episode_id,
  });
  assert.equal(integrity.reward?.verified_success, 0);
  assert.equal(integrity.reward?.outcome_class, "arm_caused_incomplete");
  assert.equal(integrity.reward?.reward_authority, "protocol_itt_failure");
  assert.deepEqual(await harness.episodeStore.verifyIntegrity(), {
    episode_count: 1,
    event_count: 4,
    closed_episode_count: 1,
    selector_eligible_episode_count: 0,
  });
});

test("product transport parses real JSON and derives non-default tenant scopes across the complete episode", async (t) => {
  const fixture = createFixture();
  const harness = openHarness(
    fixture.databasePath,
    fixture.verifierDefinition,
  );
  t.after(async () => {
    await harness.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });

  const defaultTenantId = "default";
  const defaultScope = "default";
  const tenantId = "transport-real-tenant";
  const publicScope = "transport-real-project";
  const storeScope = `tenant:${tenantId}::scope:${publicScope}`;
  const transport = createProductExecutionEpisodeTransportService({
    defaultTenantId,
    defaultScope,
    executionEpisodeService: harness.service,
  });
  const sourceTaskBytes = Buffer.from(
    "Write the exact verified answer to answer.txt using a real file operation.",
    "utf8",
  );

  const parsedBegin = ProductObserveRouteRequest.parse(JSON.parse(
    JSON.stringify({
      observation_kind: "execution_episode",
      event_kind: "episode_started",
      operation_id: "transport-real-begin",
      tenant_id: tenantId,
      scope: publicScope,
      workspace_root: fixture.subjectRoot,
      task_envelope_v1: {
        contract_version: "host_task_envelope_v1",
        host_task_id: "transport-real-task",
        collector_id: "product-transport-real-json",
        collector_version: "v1",
        task_family: "real-workspace-answer-edit",
        task_signature: "transport-replace-answer",
        repository_signature: "transport-filesystem-subject-v1",
        source_task_sha256: sha256(sourceTaskBytes),
        source_event_sha256: sha256("transport-real-source-event"),
        created_at: CREATED_AT,
      },
      source_task_base64: sourceTaskBytes.toString("base64"),
      run_id: "transport-real-run",
      model_id: "real-host-model",
      model_config: {
        provider: "local-real-process-host",
        model: "real-host-model",
        temperature: 0,
      },
      budget: {
        max_steps: 20,
        max_tokens: 20_000,
        max_cost_micros: 1_000_000,
        deadline_ms: 120_000,
      },
      subject_state_spec_v2: {
        contract_version: "workspace_subject_state_spec_v2",
        additional_state_roots: [],
      },
      required_verifier_id: VERIFIER_ID,
    }),
  ));
  assert.ok("observation_kind" in parsedBegin);
  const beginBody = successfulProductBody(
    await transport.observe(parsedBegin),
  );
  assert.equal(beginBody.event_kind, "episode_started");
  assert.equal(beginBody.tenant_id, tenantId);
  assert.equal(beginBody.scope, publicScope);
  const episode = DecisionEpisodeV1Schema.parse(beginBody.episode);
  assert.equal(episode.tenant_id, tenantId);
  assert.equal(episode.public_scope, publicScope);
  assert.equal(episode.store_scope, storeScope);

  const persistedScope = harness.database.db.prepare(
    `SELECT public_scope, scope AS store_scope
     FROM lite_execution_episodes
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?`,
  ).get(
    tenantId,
    storeScope,
    episode.episode_id,
  ) as { public_scope: string; store_scope: string } | undefined;
  assert.equal(persistedScope?.public_scope, publicScope);
  assert.equal(persistedScope?.store_scope, storeScope);

  writeFileSync(fixture.answerPath, EXPECTED_ANSWER, "utf8");
  const requestBytes = Buffer.from(stableStringify({
    operation: "write_file",
    path: "answer.txt",
    content_sha256: sha256(EXPECTED_ANSWER),
  }));
  const resultBytes = Buffer.from(stableStringify({
    ok: true,
    byte_length: Buffer.byteLength(EXPECTED_ANSWER),
    content_sha256: sha256(EXPECTED_ANSWER),
  }));
  const parsedAction = ProductObserveRouteRequest.parse(JSON.parse(
    JSON.stringify({
      observation_kind: "execution_episode",
      event_kind: "action_observed",
      operation_id: "transport-real-action",
      tenant_id: tenantId,
      scope: publicScope,
      workspace_root: fixture.subjectRoot,
      episode_id: episode.episode_id,
      expected_current_state_snapshot_id:
        (beginBody.current_state_snapshot as { snapshot_id: string })
          .snapshot_id,
      action_kind: "file_write",
      tool_name: "node_fs_write_file",
      request_base64: requestBytes.toString("base64"),
      result_base64: resultBytes.toString("base64"),
    }),
  ));
  assert.ok("observation_kind" in parsedAction);
  const actionBody = successfulProductBody(
    await transport.observe(parsedAction),
  );
  assert.equal(actionBody.event_kind, "action_observed");
  assert.equal(actionBody.tenant_id, tenantId);
  assert.equal(actionBody.scope, publicScope);
  assert.equal(
    (actionBody.action as { mutation?: unknown }).mutation,
    true,
  );

  const parsedObservation = ProductObserveRouteRequest.parse(JSON.parse(
    JSON.stringify({
      observation_kind: "execution_episode",
      event_kind: "semantic_observation_recorded",
      operation_id: "transport-real-observation",
      tenant_id: tenantId,
      scope: publicScope,
      workspace_root: fixture.subjectRoot,
      episode_id: episode.episode_id,
      expected_current_state_snapshot_id:
        (actionBody.current_state_snapshot as { snapshot_id: string })
          .snapshot_id,
      observation:
        "The live workspace contains the requested exact answer bytes.",
      authority: {
        kind: "host_declared",
        actor_id: "transport-real-host-agent",
      },
      evidence_kind: "tool_result",
      evidence_base64: resultBytes.toString("base64"),
      evidence_media_type: "application/json",
      evidence_encoding: "utf-8",
    }),
  ));
  const observationBody = successfulProductBody(
    await transport.observe(parsedObservation),
  );
  assert.equal(
    observationBody.event_kind,
    "semantic_observation_recorded",
  );
  assert.equal(
    (
      observationBody.semantic_event as {
        target_state_snapshot_id?: unknown;
      }
    ).target_state_snapshot_id,
    (actionBody.current_state_snapshot as { snapshot_id: string })
      .snapshot_id,
  );

  const parsedVerifier = ProductExecutionEpisodeOutcomeRequest.parse(JSON.parse(
    JSON.stringify({
      feedback_kind: "episode_outcome",
      event_kind: "run_verifier",
      operation_id: "transport-real-verifier",
      tenant_id: tenantId,
      scope: publicScope,
      workspace_root: fixture.subjectRoot,
      episode_id: episode.episode_id,
      expected_current_state_snapshot_id:
        (actionBody.current_state_snapshot as { snapshot_id: string })
          .snapshot_id,
    }),
  ));
  const verifierBody = successfulProductBody(
    await transport.outcome(parsedVerifier),
  );
  assert.equal(verifierBody.event_kind, "run_verifier");
  assert.equal(verifierBody.tenant_id, tenantId);
  assert.equal(verifierBody.scope, publicScope);
  const verifierOutcome = VerifierOutcomeReceiptV1Schema.parse(
    verifierBody.outcome,
  );
  assert.equal(verifierOutcome.status, "passed");
  assert.equal(verifierOutcome.execution_exit_code, 0);

  const verifierOutputBytes = await harness.artifactStore.readArtifactBytes({
    tenantId,
    scope: storeScope,
    episodeId: episode.episode_id,
    artifactId: verifierOutcome.verifier_output_ref.artifact_id,
  });
  const executionEvidence = parseVerifierExecutionEvidence(
    verifierOutputBytes,
  );
  const verifierStdout = parseRealVerifierStdout(executionEvidence);
  assert.notEqual(verifierStdout.child_pid, process.pid);
  assert.equal(verifierStdout.parent_pid, process.pid);
  assert.equal(verifierStdout.cwd, verifierStdout.subject_root);
  assert.notEqual(
    verifierStdout.subject_root,
    realpathSync(fixture.subjectRoot),
  );

  const parsedClose = ProductExecutionEpisodeOutcomeRequest.parse(JSON.parse(
    JSON.stringify({
      feedback_kind: "episode_outcome",
      event_kind: "episode_closed",
      operation_id: "transport-real-close",
      tenant_id: tenantId,
      scope: publicScope,
      workspace_root: fixture.subjectRoot,
      episode_id: episode.episode_id,
      expected_current_state_snapshot_id:
        (actionBody.current_state_snapshot as { snapshot_id: string })
          .snapshot_id,
      termination: "completed",
      verifier_receipt_id: verifierOutcome.verifier_receipt_id,
      outcome_details: [
        "real product transport preserved the verifier-bound outcome",
        "non-default tenant scope derivation remained stable",
      ],
    }),
  ));
  const closeBody = successfulProductBody(
    await transport.outcome(parsedClose),
  );
  assert.equal(closeBody.event_kind, "episode_closed");
  assert.equal(closeBody.tenant_id, tenantId);
  assert.equal(closeBody.scope, publicScope);
  const reward = EpisodeRewardV1Schema.parse(closeBody.reward);
  assert.equal(reward.verified_success, 1);
  assert.equal(reward.tool_call_count, 1);
  assert.equal(
    (
      closeBody.cost_receipt as {
        token_usage_authority?: unknown;
      }
    ).token_usage_authority,
    "unavailable",
  );

  const replay = await harness.episodeStore.verifyEpisodeIntegrity({
    tenantId,
    scope: storeScope,
    episodeId: episode.episode_id,
  });
  assert.equal(replay.closed, true);
  assert.equal(replay.reward_eligible, true);
  assert.equal(replay.reward?.verified_success, 1);
  assert.deepEqual(
    replay.events.map((event) => event.payload.event_kind),
    [
      "episode_started",
      "action_observed",
      "semantic_observation_recorded",
      "verifier_recorded",
      "episode_closed",
    ],
  );
  const artifactIntegrity = await harness.artifactStore.inspectIntegrity();
  assert.equal(artifactIntegrity.ok, true);
  assert.deepEqual(artifactIntegrity.problems, []);
});
