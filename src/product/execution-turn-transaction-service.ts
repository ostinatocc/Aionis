import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import stableStringify from "fast-json-stable-stringify";

import {
  ExecutionEpisodeSubjectStateSpecV2Schema,
  executionEpisodeSubjectStateSpecDigest,
  type StateSnapshotV1,
} from "../memory/execution-episode.js";
import {
  hostTaskEnvelopeDigest,
} from "../execution/host-task-contract.js";
import type {
  CurrentExecutionStateV2,
} from "../execution/types.js";
import {
  stateContentRef,
  type StateSnapshotV2,
} from "../execution/subject-state-adapter.js";
import type {
  ExecutionStateStore,
} from "../execution/state-store.js";
import type {
  ExecutionSessionLeaseOperationResultV1,
  LiteExecutionSessionLeaseStore,
} from "../store/lite-execution-session-lease-store.js";
import type {
  LiteExecutionEpisodeAppendResult,
  LiteExecutionEpisodeStore,
} from "../store/lite-execution-episode-store.js";
import type {
  SqliteTransactionRunner,
} from "../store/sqlite-transaction-runner.js";
import {
  type ExecutionEpisodeBeginInputV1,
  type ExecutionEpisodeBeginResultV1,
  type ExecutionEpisodeCloseInputV1,
  type ExecutionEpisodeService,
} from "./execution-episode-service.js";

const DEFAULT_SESSION_LEASE_TTL_MS = 120_000;

export type ExecutionAgentSessionCredentialsV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  sessionKey: string;
  holderId: string;
  leaseId: string;
  leaseRevision: number;
}>;

export type ExecutionAgentSessionBeginInputV1 =
  Omit<ExecutionEpisodeBeginInputV1, "operationId" | "continuationId">
  & Readonly<{
    operationId: string;
    sessionKey: string;
    continuationId: string;
    holderId: string;
    leaseTtlMs?: number;
  }>;

export type ExecutionAgentSessionResultV1 = Readonly<{
  session: ExecutionSessionLeaseOperationResultV1;
  episode: ExecutionEpisodeBeginResultV1 | null;
  current_state_snapshot: StateSnapshotV1;
  current_state_snapshot_v2: StateSnapshotV2;
  current_state: CurrentExecutionStateV2;
  resumed: boolean;
}>;

export type ExecutionAgentSessionLeasedResultV1<T> = Readonly<{
  session: ExecutionSessionLeaseOperationResultV1;
  result: T;
  current_state: CurrentExecutionStateV2;
}>;

export type ExecutionTurnTransactionService = Readonly<{
  transactionRunner(): SqliteTransactionRunner;
  beginOrResume(
    input: ExecutionAgentSessionBeginInputV1,
  ): Promise<ExecutionAgentSessionResultV1>;
  resume(args: Readonly<{
    credentials: Omit<
      ExecutionAgentSessionCredentialsV1,
      "leaseId" | "leaseRevision"
    >;
    operationId: string;
    workspaceRoot: string;
    leaseTtlMs?: number;
  }>): Promise<ExecutionAgentSessionResultV1>;
  runLeased<T>(args: Readonly<{
    credentials: ExecutionAgentSessionCredentialsV1;
    leaseOperationId: string;
    operationBinding: unknown;
    leaseTtlMs?: number;
    expectedEpisodeId?: string;
    expectedContinuationId?: string;
    execute: () => Promise<T>;
  }>): Promise<ExecutionAgentSessionLeasedResultV1<T>>;
  handoff(args: Readonly<{
    credentials: ExecutionAgentSessionCredentialsV1;
    operationId: string;
    toHolderId: string;
    evidenceRefs: readonly string[];
    leaseTtlMs?: number;
  }>): Promise<ExecutionSessionLeaseOperationResultV1>;
  release(args: Readonly<{
    credentials: ExecutionAgentSessionCredentialsV1;
    operationId: string;
  }>): Promise<ExecutionSessionLeaseOperationResultV1>;
  closeAndRelease(args: Readonly<{
    credentials: ExecutionAgentSessionCredentialsV1;
    close: Omit<
      ExecutionEpisodeCloseInputV1,
      "tenantId" | "storeScope" | "episodeId"
    >;
    releaseOperationId: string;
  }>): Promise<ExecutionAgentSessionLeasedResultV1<
    LiteExecutionEpisodeAppendResult
  >>;
}>;

export type ExecutionTurnTransactionDependencies = Readonly<{
  episodeService: ExecutionEpisodeService;
  episodeStore: LiteExecutionEpisodeStore;
  stateStore: ExecutionStateStore;
  sessionLeaseStore: LiteExecutionSessionLeaseStore;
}>;

export class ExecutionTurnTransactionServiceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "ExecutionTurnTransactionServiceError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ExecutionTurnTransactionServiceError(code);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function derivedOperationId(
  parentOperationId: string,
  kind: string,
): string {
  return `ess_${digest(stableStringify({
    contract_version: "execution_agent_session_suboperation_v1",
    parent_operation_id: parentOperationId,
    kind,
  }))}`;
}

function operationBindingDigest(value: unknown): string {
  const canonical = stableStringify(value);
  if (typeof canonical !== "string") {
    return fail("execution_session_operation_binding_invalid");
  }
  return digest(canonical);
}

function ttl(value: number | undefined): number {
  return value ?? DEFAULT_SESSION_LEASE_TTL_MS;
}

function workspaceIdentity(input: {
  workspaceRoot: string;
  subjectStateSpec: ExecutionEpisodeBeginInputV1["subjectStateSpec"];
}): Readonly<{
  canonicalRootSha256: string;
  subjectStateSpecSha256: string;
}> {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(input.workspaceRoot);
  } catch {
    return fail("execution_session_workspace_root_unavailable");
  }
  const stateSpec = ExecutionEpisodeSubjectStateSpecV2Schema.parse(
    input.subjectStateSpec ?? {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
  );
  return Object.freeze({
    canonicalRootSha256: digest(Buffer.from(canonicalRoot, "utf8")),
    subjectStateSpecSha256:
      executionEpisodeSubjectStateSpecDigest(stateSpec),
  });
}

function currentState(
  stateStore: ExecutionStateStore,
  scope: string,
  continuationId: string,
  episodeId: string,
): CurrentExecutionStateV2 {
  const stored = stateStore.getCurrent(scope, continuationId);
  if (
    !stored
    || stored.state.episode_id !== episodeId
  ) {
    return fail("execution_session_current_state_missing");
  }
  return stored.state;
}

function snapshotV2(
  snapshot: StateSnapshotV1,
  episode: ExecutionEpisodeBeginResultV1["episode"],
): StateSnapshotV2 {
  const subject = episode.execution_subject
    ?? fail("execution_session_subject_v2_missing");
  return {
    contract_version: "state_snapshot_v2",
    snapshot_id: snapshot.snapshot_id,
    subject,
    captured_at: snapshot.captured_at,
    algorithm_id: snapshot.algorithm_id,
    algorithm_version: snapshot.algorithm_version,
    environment_sha256: snapshot.environment_digest,
    content_ref: stateContentRef(snapshot.content_digest),
    content_sha256: snapshot.content_digest,
    content_media_type: snapshot.artifact_ref.media_type,
    content_encoding: snapshot.artifact_ref.encoding,
    capture_authority: "runtime_adapter",
    attestation_ref: null,
  };
}

function assertSessionCredentialsMatch(
  lease: Awaited<ReturnType<LiteExecutionSessionLeaseStore["assertActive"]>>,
  credentials: ExecutionAgentSessionCredentialsV1,
): void {
  if (
    lease.binding.tenant_id !== credentials.tenantId
    || lease.binding.store_scope !== credentials.storeScope
    || lease.binding.session_key !== credentials.sessionKey
    || lease.holder_id !== credentials.holderId
    || lease.lease_id !== credentials.leaseId
    || lease.lease_revision !== credentials.leaseRevision
  ) {
    fail("execution_session_credentials_mismatch");
  }
}

export function createExecutionTurnTransactionService(
  dependencies: ExecutionTurnTransactionDependencies,
): ExecutionTurnTransactionService {
  const {
    episodeService,
    episodeStore,
    stateStore,
    sessionLeaseStore,
  } = dependencies;
  const transaction = episodeStore.transactionRunner();
  if (
    transaction !== sessionLeaseStore.transactionRunner()
    || (
      stateStore.transactionRunner !== null
      && transaction !== stateStore.transactionRunner
    )
  ) {
    throw new Error(
      "execution_turn_service_requires_one_shared_transaction_runner",
    );
  }

  async function activeLease(
    credentials: ExecutionAgentSessionCredentialsV1,
  ) {
    const lease = await sessionLeaseStore.assertActive({
      tenantId: credentials.tenantId,
      scope: credentials.storeScope,
      sessionKey: credentials.sessionKey,
      holderId: credentials.holderId,
      leaseId: credentials.leaseId,
      leaseRevision: credentials.leaseRevision,
    });
    assertSessionCredentialsMatch(lease, credentials);
    return lease;
  }

  return {
    transactionRunner(): SqliteTransactionRunner {
      return transaction;
    },

    async beginOrResume(input) {
      return await transaction.run(async () => {
        const existing = await sessionLeaseStore.get({
          tenantId: input.tenantId,
          scope: input.storeScope,
          sessionKey: input.sessionKey,
        });
        if (existing) {
          if (
            existing.binding.continuation_id !== input.continuationId
            || existing.binding.public_scope !== input.publicScope
            || existing.binding.goal_sha256
              !== input.taskEnvelope.source_task_sha256
            || existing.binding.task_envelope_sha256
              !== hostTaskEnvelopeDigest(input.taskEnvelope)
          ) {
            return fail("execution_session_binding_conflict");
          }
          const replay = await episodeStore.replayEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: existing.binding.episode_id,
          });
          if (replay.closed) {
            return fail("execution_session_episode_closed");
          }
          const expectedWorkspace = workspaceIdentity({
            workspaceRoot: input.workspaceRoot,
            subjectStateSpec: input.subjectStateSpec,
          });
          if (
            replay.episode.subject_identity.canonical_root_sha256
              !== expectedWorkspace.canonicalRootSha256
            || replay.episode.subject_identity.subject_state_spec_sha256
              !== expectedWorkspace.subjectStateSpecSha256
            || replay.episode.subject_identity.identity_sha256
              !== existing.binding.subject_identity_sha256
          ) {
            return fail("execution_session_subject_identity_mismatch");
          }
          const resumedEpisode = await episodeService.resume({
            tenantId: input.tenantId,
            storeScope: input.storeScope,
            episodeId: existing.binding.episode_id,
            workspaceRoot: input.workspaceRoot,
            continuationId: input.continuationId,
          });
          const state = currentState(
            stateStore,
            input.storeScope,
            input.continuationId,
            existing.binding.episode_id,
          );
          const {
            created_at: _createdAt,
            ...binding
          } = existing.binding;
          const session = await sessionLeaseStore.acquire({
            binding,
            operationId: input.operationId,
            holderId: input.holderId,
            leaseTtlMs: ttl(input.leaseTtlMs),
            currentStateSha256: state.state_sha256,
          });
          const root = resumedEpisode.replay.events[0];
          if (!root || root.payload.event_kind !== "episode_started") {
            return fail("execution_session_episode_root_corrupt");
          }
          return Object.freeze({
            session,
            episode: {
              episode: resumedEpisode.replay.episode,
              initial_state_snapshot: root.payload.initial_state_snapshot,
              initial_state_snapshot_v2: snapshotV2(
                root.payload.initial_state_snapshot,
                resumedEpisode.replay.episode,
              ),
              event: root,
              replayed: true,
            },
            current_state_snapshot:
              resumedEpisode.current_state_snapshot,
            current_state_snapshot_v2:
              resumedEpisode.current_state_snapshot_v2,
            current_state: state,
            resumed: true,
          });
        }

        const {
          sessionKey: _sessionKey,
          holderId: _holderId,
          leaseTtlMs: _leaseTtlMs,
          ...episodeInput
        } = input;
        const episode = await episodeService.begin({
          ...episodeInput,
          operationId: derivedOperationId(
            input.operationId,
            "episode_begin",
          ),
          continuationId: input.continuationId,
        });
        const state = currentState(
          stateStore,
          input.storeScope,
          input.continuationId,
          episode.episode.episode_id,
        );
        const session = await sessionLeaseStore.acquire({
          binding: {
            contract_version: "execution_session_binding_v1",
            tenant_id: input.tenantId,
            store_scope: input.storeScope,
            public_scope: input.publicScope,
            session_key: input.sessionKey,
            continuation_id: input.continuationId,
            episode_id: episode.episode.episode_id,
            goal_sha256: input.taskEnvelope.source_task_sha256,
            task_envelope_sha256:
              hostTaskEnvelopeDigest(input.taskEnvelope),
            subject_identity_sha256:
              episode.episode.subject_identity.identity_sha256,
          },
          operationId: input.operationId,
          holderId: input.holderId,
          leaseTtlMs: ttl(input.leaseTtlMs),
          currentStateSha256: state.state_sha256,
        });
        return Object.freeze({
          session,
          episode,
          current_state_snapshot: episode.initial_state_snapshot,
          current_state_snapshot_v2:
            episode.initial_state_snapshot_v2,
          current_state: state,
          resumed: false,
        });
      });
    },

    async resume(args) {
      return await transaction.run(async () => {
        const existing = await sessionLeaseStore.get({
          tenantId: args.credentials.tenantId,
          scope: args.credentials.storeScope,
          sessionKey: args.credentials.sessionKey,
        });
        if (!existing) return fail("execution_session_missing");
        if (existing.binding.tenant_id !== args.credentials.tenantId) {
          return fail("execution_session_binding_conflict");
        }
        const resumedEpisode = await episodeService.resume({
          tenantId: args.credentials.tenantId,
          storeScope: args.credentials.storeScope,
          episodeId: existing.binding.episode_id,
          workspaceRoot: args.workspaceRoot,
          continuationId: existing.binding.continuation_id,
        });
        if (resumedEpisode.replay.closed) {
          return fail("execution_session_episode_closed");
        }
        const state = currentState(
          stateStore,
          args.credentials.storeScope,
          existing.binding.continuation_id,
          existing.binding.episode_id,
        );
        const {
          created_at: _createdAt,
          ...binding
        } = existing.binding;
        const session = await sessionLeaseStore.acquire({
          binding,
          operationId: args.operationId,
          holderId: args.credentials.holderId,
          leaseTtlMs: ttl(args.leaseTtlMs),
          currentStateSha256: state.state_sha256,
        });
        const root = resumedEpisode.replay.events[0];
        if (!root || root.payload.event_kind !== "episode_started") {
          return fail("execution_session_episode_root_corrupt");
        }
        return Object.freeze({
          session,
            episode: {
              episode: resumedEpisode.replay.episode,
              initial_state_snapshot: root.payload.initial_state_snapshot,
              initial_state_snapshot_v2: snapshotV2(
                root.payload.initial_state_snapshot,
                resumedEpisode.replay.episode,
              ),
            event: root,
            replayed: true,
          },
          current_state_snapshot:
            resumedEpisode.current_state_snapshot,
          current_state_snapshot_v2:
            resumedEpisode.current_state_snapshot_v2,
          current_state: state,
          resumed: true,
        });
      });
    },

    async runLeased(args) {
      return await transaction.run(async () => {
        let binding;
        try {
          binding = (await activeLease(args.credentials)).binding;
        } catch (error) {
          const events = await sessionLeaseStore.listEvents({
            tenantId: args.credentials.tenantId,
            scope: args.credentials.storeScope,
            sessionKey: args.credentials.sessionKey,
          });
          const committedRetry = events.find((event) =>
            event.operation_id === args.leaseOperationId
            && event.event_kind === "renewed"
            && event.lease_id === args.credentials.leaseId
            && event.lease_revision
              === args.credentials.leaseRevision + 1
            && event.holder_id === args.credentials.holderId
            && event.previous_holder_id
              === args.credentials.holderId
          );
          if (!committedRetry) throw error;
          binding = (await sessionLeaseStore.get({
            tenantId: args.credentials.tenantId,
            scope: args.credentials.storeScope,
            sessionKey: args.credentials.sessionKey,
          }))?.binding ?? fail("execution_session_missing");
        }
        if (
          args.expectedEpisodeId !== undefined
          && binding.episode_id !== args.expectedEpisodeId
        ) {
          return fail("execution_session_episode_identity_mismatch");
        }
        if (
          args.expectedContinuationId !== undefined
          && binding.continuation_id
            !== args.expectedContinuationId
        ) {
          return fail("execution_session_continuation_identity_mismatch");
        }
        const result = await args.execute();
        const state = currentState(
          stateStore,
          args.credentials.storeScope,
          binding.continuation_id,
          binding.episode_id,
        );
        const session = await sessionLeaseStore.renew({
          tenantId: args.credentials.tenantId,
          scope: args.credentials.storeScope,
          sessionKey: args.credentials.sessionKey,
          operationId: args.leaseOperationId,
          holderId: args.credentials.holderId,
          expectedLeaseId: args.credentials.leaseId,
          expectedLeaseRevision: args.credentials.leaseRevision,
          leaseTtlMs: ttl(args.leaseTtlMs),
          currentStateSha256: state.state_sha256,
          operationRequestSha256:
            operationBindingDigest(args.operationBinding),
          // activeLease() ran after this BEGIN IMMEDIATE transaction started.
          // A long real tool/verifier operation may cross the wall-clock
          // expiry, but no takeover can commit while this CAS transaction
          // remains open. Let that already-authorized operation finish; a
          // request that starts after expiry is still rejected above.
          allowExpiredAtCompletion: true,
        });
        return Object.freeze({
          session,
          result,
          current_state: state,
        });
      });
    },

    async handoff(args) {
      return await transaction.run(async () => {
        const previous = await activeLease(args.credentials);
        const state = currentState(
          stateStore,
          args.credentials.storeScope,
          previous.binding.continuation_id,
          previous.binding.episode_id,
        );
        return await sessionLeaseStore.handoff({
          tenantId: args.credentials.tenantId,
          scope: args.credentials.storeScope,
          sessionKey: args.credentials.sessionKey,
          operationId: args.operationId,
          holderId: args.credentials.holderId,
          expectedLeaseId: args.credentials.leaseId,
          expectedLeaseRevision: args.credentials.leaseRevision,
          toHolderId: args.toHolderId,
          evidenceRefs: args.evidenceRefs,
          leaseTtlMs: ttl(args.leaseTtlMs),
          currentStateSha256: state.state_sha256,
        });
      });
    },

    async release(args) {
      return await transaction.run(async () => {
        const previous = await activeLease(args.credentials);
        const state = currentState(
          stateStore,
          args.credentials.storeScope,
          previous.binding.continuation_id,
          previous.binding.episode_id,
        );
        return await sessionLeaseStore.release({
          tenantId: args.credentials.tenantId,
          scope: args.credentials.storeScope,
          sessionKey: args.credentials.sessionKey,
          operationId: args.operationId,
          holderId: args.credentials.holderId,
          expectedLeaseId: args.credentials.leaseId,
          expectedLeaseRevision: args.credentials.leaseRevision,
          currentStateSha256: state.state_sha256,
        });
      });
    },

    async closeAndRelease(args) {
      return await transaction.run(async () => {
        const previous = await activeLease(args.credentials);
        const result = await episodeService.close({
          ...args.close,
          tenantId: args.credentials.tenantId,
          storeScope: args.credentials.storeScope,
          episodeId: previous.binding.episode_id,
        });
        const state = currentState(
          stateStore,
          args.credentials.storeScope,
          previous.binding.continuation_id,
          previous.binding.episode_id,
        );
        const session = await sessionLeaseStore.release({
          tenantId: args.credentials.tenantId,
          scope: args.credentials.storeScope,
          sessionKey: args.credentials.sessionKey,
          operationId: args.releaseOperationId,
          holderId: args.credentials.holderId,
          expectedLeaseId: args.credentials.leaseId,
          expectedLeaseRevision: args.credentials.leaseRevision,
          currentStateSha256: state.state_sha256,
        });
        return Object.freeze({
          session,
          result,
          current_state: state,
        });
      });
    },
  };
}
