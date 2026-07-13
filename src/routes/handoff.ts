import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import stableStringify from "fast-json-stable-stringify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { Env } from "../config.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { ExecutionTreeStore } from "../execution/tree-store.js";
import { applyAutoExecutionTreeFromSlots, type AutoExecutionTreeApplyResult } from "../execution/tree-auto.js";
import { buildLiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";
import {
  readExecutionContinuitySlotFields,
  readExecutionStateSlot,
  readExecutionTransitionsSlot,
  readExecutionTreeSlot,
} from "../memory/execution-slot-surface.js";
import { applyExecutionTreeOperationsFromSlots } from "../kernel/execution-continuity-kernel.js";
import {
  resolveNodeAcceptanceChecks,
  resolveNodeNextAction,
  resolveNodeTargetFiles,
} from "../memory/node-execution-surface.js";
import { buildHandoffWriteBody, recoverHandoff } from "../memory/handoff.js";
import type { HandoffRecoverInput, HandoffStoreInput } from "../memory/schemas.js";
import { applyMemoryWrite, prepareMemoryWrite } from "../memory/write.js";
import { HandoffRecoverRequest, HandoffStoreRequest } from "../memory/schemas.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { SqliteTransactionRunner } from "../store/sqlite-transaction-runner.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import { HttpError } from "../util/http.js";
import { sha256Hex } from "../util/crypto.js";
import {
  completeLiteInlineEmbeddings,
  persistLitePreparedWrite,
  prepareLiteProjectedWrite,
} from "../memory/lite-projected-write-commit.js";

type HandoffRouteKind = "handoff_store" | "handoff_recover";

type HandoffRequest = FastifyRequest<{ Body: unknown }>;

type HandoffNodeLike = {
  id: string;
  uri?: string | null;
  type: string;
  client_id?: string | null;
  slots?: Record<string, unknown> | null;
};

type HandoffWriteBodyNodeLike = {
  slots?: Record<string, unknown> | null;
};

type PreparedHandoffWrite = Awaited<ReturnType<typeof prepareMemoryWrite>>;
type HandoffWriteResult = Awaited<ReturnType<typeof applyMemoryWrite>>;

const HANDOFF_STORE_OPERATION_KIND = "handoff_store_v1";
const HANDOFF_STORE_RESULT_CONTRACT_VERSION = "aionis_handoff_store_result_v1";

type HandoffStoreResult = Record<string, unknown> & {
  contract_version: typeof HANDOFF_STORE_RESULT_CONTRACT_VERSION;
  operation_id: string;
  tenant_id: string;
  scope: string;
  commit_id: string;
};

export type HandoffStorePlan = {
  body: HandoffStoreInput;
  writeBody: ReturnType<typeof buildHandoffWriteBody>;
  prepared: PreparedHandoffWrite;
  internalExecutionTransitions: boolean;
  projectionPrepared: boolean;
  projectionBase: { id: string; commit_hash: string } | null;
};

export type HandoffStoreOptions = {
  principal?: AuthPrincipal | null;
  deferProjection?: boolean;
};

export type PersistedHandoffStore = {
  out: HandoffWriteResult;
  appliedExecutionTransitions: Array<Record<string, unknown>> | undefined;
  appliedExecutionTreeOperations: Array<Record<string, unknown>> | undefined;
  appliedAutoExecutionTree: AutoExecutionTreeApplyResult | null;
};

export type HandoffRouteServiceArgs = {
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  liteWriteStore: LiteWriteStore;
  executionStateStore?: ExecutionStateStore | null;
  executionTreeStore?: ExecutionTreeStore | null;
};

export type HandoffRouteService = {
  transactionRunner(): SqliteTransactionRunner;
  prepareStore: (body: HandoffStoreInput, options?: HandoffStoreOptions) => Promise<HandoffStorePlan>;
  persistStore: (plan: HandoffStorePlan) => Promise<PersistedHandoffStore>;
  receiptStore: (plan: HandoffStorePlan, persisted: PersistedHandoffStore) => unknown;
  finalizeStore: (plan: HandoffStorePlan, persisted: PersistedHandoffStore) => Promise<unknown>;
  store: (body: HandoffStoreInput, options?: HandoffStoreOptions) => Promise<unknown>;
  recover: (body: HandoffRecoverInput, options?: { principal?: AuthPrincipal | null }) => Promise<unknown>;
};

type RegisterHandoffRoutesArgs = HandoffRouteServiceArgs & {
  app: FastifyInstance;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: HandoffRouteKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write" | "recall") => Promise<InflightGateToken>;
};

function firstNode<T>(value: unknown): T | null {
  return Array.isArray(value) ? ((value[0] as T | undefined) ?? null) : null;
}

function asSlots(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sameProjectionBase(
  left: { id: string; commit_hash: string } | null,
  right: { id: string; commit_hash: string } | null,
): boolean {
  return left?.id === right?.id && left?.commit_hash === right?.commit_hash;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assertHandoffOperationMatches(args: {
  operationId: string;
  requestSha256: string;
  storedRequestSha256: string;
}): void {
  if (args.requestSha256 === args.storedRequestSha256) return;
  throw new HttpError(
    409,
    "handoff_operation_id_conflict",
    "operation_id was already used for a different handoff/store request",
    { operation_id: args.operationId },
  );
}

function handoffOperationReceiptCorrupt(operationId: string): never {
  throw new HttpError(
    500,
    "handoff_operation_receipt_corrupt",
    "stored handoff operation receipt is invalid",
    { operation_id: operationId },
  );
}

function parseStoredHandoffReceipt(args: {
  raw: string;
  operationId: string;
  tenantId: string;
  scope: string;
  commitId: string | null;
}): HandoffStoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.raw);
  } catch {
    return handoffOperationReceiptCorrupt(args.operationId);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return handoffOperationReceiptCorrupt(args.operationId);
  }
  const receipt = parsed as Record<string, unknown>;
  if (
    receipt.contract_version !== HANDOFF_STORE_RESULT_CONTRACT_VERSION
    || receipt.operation_id !== args.operationId
    || receipt.tenant_id !== args.tenantId
    || receipt.scope !== args.scope
    || !args.commitId
    || receipt.commit_id !== args.commitId
  ) {
    return handoffOperationReceiptCorrupt(args.operationId);
  }
  return receipt as HandoffStoreResult;
}

function applyHandoffExecutionTransitionsFromSlots(args: {
  executionStateStore?: ExecutionStateStore | null;
  writeSlots: Record<string, unknown> | null;
  allowInternalExpectedRevision: boolean;
}): Array<Record<string, unknown>> | undefined {
  const executionState = readExecutionStateSlot(args.writeSlots);
  if (!args.executionStateStore || !executionState) return undefined;
  const transitions = readExecutionTransitionsSlot(args.writeSlots);
  const existing = args.executionStateStore.get(executionState.scope, executionState.state_id);
  const initializedHere = !existing;
  args.executionStateStore.initialize(executionState);
  if (!transitions) return undefined;

  const applied: Array<Record<string, unknown>> = [];
  for (const parsed of transitions) {
    const current = args.executionStateStore.get(parsed.scope, parsed.state_id);
    const transition = parsed.expected_revision == null
      && current
      && (initializedHere || args.allowInternalExpectedRevision)
      ? { ...parsed, expected_revision: current.revision }
      : parsed;
    args.executionStateStore.applyTransition(transition);
    applied.push(transition as Record<string, unknown>);
  }
  return applied;
}

export function createHandoffRouteService(args: HandoffRouteServiceArgs): HandoffRouteService {
  const {
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    liteWriteStore,
    executionStateStore,
    executionTreeStore,
  } = args;
  const atomicRunner = liteWriteStore.transactionRunner();
  if (executionStateStore && executionStateStore.transactionRunner !== atomicRunner) {
    throw new Error("handoff execution state store must share the Lite write transaction runner");
  }
  if (executionTreeStore && executionTreeStore.transactionRunner !== atomicRunner) {
    throw new Error("handoff execution tree store must share the Lite write transaction runner");
  }
  assertLocalStoreRuntimeEdition(env, "local-store handoff route service");
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(env);
  const effectiveHandoffStoreBody = (
    body: HandoffStoreInput,
    principal: AuthPrincipal | null,
  ): HandoffStoreInput => {
    const principalAgentId = asNonEmptyString(principal?.agent_id);
    const principalTeamId = asNonEmptyString(principal?.team_id);
    const principalSubjectId = principalAgentId ?? principalTeamId;
    if (principal && !principalSubjectId) {
      throw new HttpError(
        403,
        "principal_subject_required",
        "an authenticated agent or team identity is required for attributed handoff operations",
      );
    }
    const actorId = principalSubjectId ?? asNonEmptyString(body.actor);
    const producerAgentId = principal
      ? principalAgentId ?? principalSubjectId!
      : actorId ?? asNonEmptyString(body.producer_agent_id);
    const ownerAgentId = principal
      ? principalAgentId
      : actorId ?? asNonEmptyString(body.owner_agent_id);
    const ownerTeamId = principal
      ? principalTeamId
      : asNonEmptyString(body.owner_team_id);
    return HandoffStoreRequest.parse({
      ...body,
      tenant_id: principal?.tenant_id ?? body.tenant_id ?? env.MEMORY_TENANT_ID,
      scope: body.scope ?? env.MEMORY_SCOPE,
      actor: actorId ?? undefined,
      producer_agent_id: producerAgentId ?? undefined,
      owner_agent_id: ownerAgentId ?? undefined,
      owner_team_id: ownerTeamId ?? undefined,
    });
  };
  const handoffStoreOperationIdentity = (
    body: HandoffStoreInput,
    principal: AuthPrincipal | null,
  ): { operationId: string; requestSha256: string } => {
    const request = { ...body } as Record<string, unknown>;
    const suppliedOperationId = asNonEmptyString(request.operation_id);
    delete request.operation_id;
    return {
      operationId: suppliedOperationId ?? `handoff_${randomUUID()}`,
      requestSha256: sha256Hex(stableStringify({
        contract_version: "aionis_handoff_store_request_identity_v1",
        request,
        principal_binding: principal
          ? {
              tenant_id: principal.tenant_id,
              agent_id: asNonEmptyString(principal.agent_id),
              team_id: asNonEmptyString(principal.team_id),
            }
          : null,
      })),
    };
  };
  const prepareCommittedHandoffWrite = async (
    prepared: PreparedHandoffWrite,
    options: { allowExternalReview: boolean },
  ): Promise<void> => {
    await prepareLiteProjectedWrite({
      prepared,
      liteWriteStore,
      learningControlReviewProviders: options.allowExternalReview
        ? learningControlProviders.workflowProjection
        : undefined,
    });
  };
  const persistCommittedHandoffWrite = async (prepared: PreparedHandoffWrite): Promise<HandoffWriteResult> =>
    persistLitePreparedWrite({
      prepared,
      liteWriteStore,
      writeOptions: {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
        associativeLinkOrigin: "handoff_store",
      },
    });
  const completeCommittedHandoffWrite = async (prepared: PreparedHandoffWrite): Promise<void> => {
    try {
      await completeLiteInlineEmbeddings({
        prepared,
        embedder: writeEmbedder,
        liteWriteStore,
      });
    } catch (error) {
      process.emitWarning(
        `Handoff post-commit embedding failed: ${error instanceof Error ? error.message : String(error)}`,
        { code: "AIONIS_POST_COMMIT_EMBEDDING_FAILED" },
      );
    }
  };
  const buildHandoffStoreResponse = (args: {
    body: HandoffStoreInput;
    writeBody: ReturnType<typeof buildHandoffWriteBody>;
    out: HandoffWriteResult;
    appliedExecutionTransitions: Array<Record<string, unknown>> | undefined;
    appliedExecutionTreeOperations: Array<Record<string, unknown>> | undefined;
    appliedAutoExecutionTree: AutoExecutionTreeApplyResult | null;
  }) => {
    const handoffNode = firstNode<HandoffNodeLike>(args.out.nodes);
    const handoffSlots = asSlots(handoffNode?.slots);
    const writeNode = firstNode<HandoffWriteBodyNodeLike>(args.writeBody.nodes);
    const writeSlots = asSlots(writeNode?.slots);
    const continuitySlots = handoffSlots ?? writeSlots;
    const executionSlots = readExecutionContinuitySlotFields(continuitySlots);
    const executionTreeSlot = readExecutionTreeSlot(continuitySlots);
    const resolvedAcceptanceChecks = resolveNodeAcceptanceChecks({ slots: continuitySlots });
    const resolvedTargetFiles = resolveNodeTargetFiles({ slots: continuitySlots });
    const resolvedNextAction = resolveNodeNextAction({ slots: continuitySlots });
    const latestStoredExecutionTree = executionTreeSlot && executionTreeStore
      ? executionTreeStore.get(executionTreeSlot.scope, executionTreeSlot.tree_id)?.tree ?? null
      : null;
    const effectiveAcceptanceChecks = resolvedAcceptanceChecks.length > 0
      ? resolvedAcceptanceChecks
      : (args.body.acceptance_checks ?? []);
    const effectiveTargetFiles = resolvedTargetFiles.length > 0
      ? resolvedTargetFiles
      : (args.body.target_files ?? []);
    const effectiveNextAction = resolvedNextAction ?? args.body.next_action ?? args.body.handoff_text;
    return {
      tenant_id: args.out.tenant_id,
      scope: args.out.scope,
      commit_id: args.out.commit_id,
      commit_uri: args.out.commit_uri,
      handoff: handoffNode
        ? {
            id: handoffNode.id,
            uri: handoffNode.uri ?? null,
            type: handoffNode.type,
            client_id: handoffNode.client_id ?? null,
            handoff_kind: args.body.handoff_kind,
            task_family: args.body.task_family ?? null,
            task_signature: args.body.task_signature ?? null,
            workflow_signature: args.body.workflow_signature ?? null,
            anchor: args.body.anchor,
            file_path: args.body.file_path ?? null,
            repo_root: args.body.repo_root ?? null,
            symbol: args.body.symbol ?? null,
            summary: args.body.summary,
            handoff_text: args.body.handoff_text,
            risk: args.body.risk ?? null,
            acceptance_checks: effectiveAcceptanceChecks,
            tags: args.body.tags ?? [],
            target_files: effectiveTargetFiles,
            next_action: effectiveNextAction,
            must_change: args.body.must_change ?? [],
            must_remove: args.body.must_remove ?? [],
            must_keep: args.body.must_keep ?? [],
            memory_lane: args.body.memory_lane,
          }
        : null,
      execution_result_summary: executionSlots.execution_result_summary,
      execution_artifacts: executionSlots.execution_artifacts,
      execution_evidence: executionSlots.execution_evidence,
      delegation_records_v1: executionSlots.delegation_records_v1,
      execution_contract_v1: executionSlots.execution_contract_v1,
      execution_state_v1: executionSlots.execution_state_v1,
      execution_packet_v1: executionSlots.execution_packet_v1,
      execution_tree_v1: args.appliedAutoExecutionTree?.tree ?? latestStoredExecutionTree ?? executionTreeSlot ?? executionSlots.execution_tree_v1,
      control_profile_v1: executionSlots.control_profile_v1,
      execution_transitions_v1:
        args.appliedExecutionTransitions ?? executionSlots.execution_transitions_v1,
      execution_tree_operations_v1:
        args.appliedExecutionTreeOperations
        ?? (args.appliedAutoExecutionTree ? args.appliedAutoExecutionTree.operations : undefined)
        ?? executionSlots.execution_tree_operations_v1,
    };
  };
  const runHandoffRecoverForPrincipal = (body: HandoffRecoverInput, principal: AuthPrincipal | null) =>
    recoverHandoff({
      liteWriteStore,
      executionStateStore,
      executionTreeStore,
      input: body,
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
      consumerAgentId: principal?.agent_id ?? null,
      consumerTeamId: principal?.team_id ?? null,
    });

  const prepareStore = async (
    body: HandoffStoreInput,
    options: HandoffStoreOptions = {},
  ): Promise<HandoffStorePlan> => {
      const effectiveBody = effectiveHandoffStoreBody(body, options.principal ?? null);
      const internalExecutionTransitions = !Array.isArray(
        (effectiveBody as HandoffStoreInput & { execution_transitions_v1?: unknown }).execution_transitions_v1,
      );
      const writeBody = buildHandoffWriteBody(effectiveBody);
      const prepared = await prepareMemoryWrite(
        writeBody,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
        {
          maxTextLen: env.MAX_TEXT_LEN,
          piiRedaction: env.PII_REDACTION,
          allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
        },
        writeEmbedder,
      );
      const projectionBase = options.deferProjection
        ? null
        : await liteWriteStore.latestCommit(prepared.scope);
      if (!options.deferProjection) {
        await prepareCommittedHandoffWrite(prepared, { allowExternalReview: true });
        const projectionBaseAfter = await liteWriteStore.latestCommit(prepared.scope);
        if (!sameProjectionBase(projectionBase, projectionBaseAfter)) {
          throw new HttpError(409, "write_projection_stale", "memory changed while handoff projection was being prepared", {
            scope: prepared.scope_public,
            projection_base_commit_id: projectionBase?.id ?? null,
            current_commit_id: projectionBaseAfter?.id ?? null,
            retryable: true,
          });
        }
      }
      return {
        body: effectiveBody,
        writeBody,
        prepared,
        internalExecutionTransitions,
        projectionPrepared: !options.deferProjection,
        projectionBase,
      };
  };
  const persistStore = async (plan: HandoffStorePlan): Promise<PersistedHandoffStore> => {
      if (!liteWriteStore.transactionRunner().inTransaction()) {
        throw new Error("handoff persist requires the configured atomic write transaction");
      }
      if (plan.projectionPrepared) {
        const currentProjectionBase = await liteWriteStore.latestCommit(plan.prepared.scope);
        if (!sameProjectionBase(plan.projectionBase, currentProjectionBase)) {
          throw new HttpError(409, "write_projection_stale", "memory changed after handoff projection was prepared", {
            scope: plan.prepared.scope_public,
            projection_base_commit_id: plan.projectionBase?.id ?? null,
            current_commit_id: currentProjectionBase?.id ?? null,
            retryable: true,
          });
        }
      } else {
        await prepareCommittedHandoffWrite(plan.prepared, { allowExternalReview: false });
        plan.projectionPrepared = true;
      }
      const preparedNode = firstNode<HandoffWriteBodyNodeLike>(plan.prepared.nodes);
      const writeSlots = asSlots(preparedNode?.slots);
      const out = await persistCommittedHandoffWrite(plan.prepared);
      const appliedExecutionTransitions = applyHandoffExecutionTransitionsFromSlots({
        executionStateStore,
        writeSlots,
        allowInternalExpectedRevision: plan.internalExecutionTransitions,
      });
      const appliedExecutionTreeOperations = applyExecutionTreeOperationsFromSlots({
        executionTreeStore,
        writeSlots,
      });
      const appliedAutoExecutionTree = env.EXECUTION_TREE_DEFAULT_ENABLED === false
        ? null
        : applyAutoExecutionTreeFromSlots({
            executionTreeStore,
            slots: writeSlots,
            title: plan.body.title ?? null,
            textSummary: plan.body.summary,
          });
      return {
        out,
        appliedExecutionTransitions,
        appliedExecutionTreeOperations,
        appliedAutoExecutionTree,
      };
  };
  const finalizeStore = async (
    plan: HandoffStorePlan,
    persisted: PersistedHandoffStore,
  ): Promise<unknown> => {
      await completeCommittedHandoffWrite(plan.prepared);
      return receiptStore(plan, persisted);
  };
  const receiptStore = (
    plan: HandoffStorePlan,
    persisted: PersistedHandoffStore,
  ): unknown => buildHandoffStoreResponse({
        body: plan.body,
        writeBody: plan.writeBody,
        ...persisted,
      });

  return {
    transactionRunner: () => liteWriteStore.transactionRunner(),
    prepareStore,
    persistStore,
    receiptStore,
    finalizeStore,
    async store(body, options = {}) {
      const effectiveBody = effectiveHandoffStoreBody(body, options.principal ?? null);
      const tenantId = effectiveBody.tenant_id!;
      const scope = effectiveBody.scope!;
      const { operationId, requestSha256 } = handoffStoreOperationIdentity(
        effectiveBody,
        options.principal ?? null,
      );
      const stored = await liteWriteStore.getWriteOperation({
        tenantId,
        scope,
        operationKind: HANDOFF_STORE_OPERATION_KIND,
        operationId,
      });
      if (stored) {
        assertHandoffOperationMatches({
          operationId,
          requestSha256,
          storedRequestSha256: stored.request_sha256,
        });
        return parseStoredHandoffReceipt({
          raw: stored.receipt_json,
          operationId,
          tenantId,
          scope,
          commitId: stored.commit_id,
        });
      }

      const plan = await prepareStore(effectiveBody, options);
      const committed = await liteWriteStore.withTx(async () => {
        const raced = await liteWriteStore.getWriteOperation({
          tenantId,
          scope,
          operationKind: HANDOFF_STORE_OPERATION_KIND,
          operationId,
        });
        if (raced) {
          assertHandoffOperationMatches({
            operationId,
            requestSha256,
            storedRequestSha256: raced.request_sha256,
          });
          return {
            persisted: null,
            response: parseStoredHandoffReceipt({
              raw: raced.receipt_json,
              operationId,
              tenantId,
              scope,
              commitId: raced.commit_id,
            }),
            committedNew: false,
          } as const;
        }
        const persisted = await persistStore(plan);
        const baseResponse = receiptStore(plan, persisted);
        if (!baseResponse || typeof baseResponse !== "object" || Array.isArray(baseResponse)) {
          throw new Error("handoff store response must be an object");
        }
        const response: HandoffStoreResult = {
          ...(baseResponse as Record<string, unknown>),
          contract_version: HANDOFF_STORE_RESULT_CONTRACT_VERSION,
          operation_id: operationId,
          tenant_id: tenantId,
          scope,
          commit_id: persisted.out.commit_id,
        };
        await liteWriteStore.insertWriteOperation({
          tenantId,
          scope,
          operationKind: HANDOFF_STORE_OPERATION_KIND,
          operationId,
          requestSha256,
          receiptJson: JSON.stringify(response),
          commitId: persisted.out.commit_id,
        });
        return {
          persisted,
          response,
          committedNew: true,
        } as const;
      });
      if (committed.committedNew) await completeCommittedHandoffWrite(plan.prepared);
      return committed.response;
    },
    async recover(body, options = {}) {
      return runHandoffRecoverForPrincipal(body, options.principal ?? null);
    },
  };
}

export function registerHandoffRoutes(args: RegisterHandoffRoutesArgs) {
  const {
    app,
    env,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;
  assertLocalStoreRuntimeEdition(env, "local-store handoff routes");
  const service = createHandoffRouteService(args);

  const runHandoffRoute = async <TBody, TResult>(args: {
    req: HandoffRequest;
    reply: FastifyReply;
    requestKind: HandoffRouteKind;
    inflightKind: "write" | "recall";
    parseBody: (input: unknown) => TBody;
    execute: (body: TBody, principal: AuthPrincipal | null) => Promise<TResult>;
  }): Promise<TResult> => {
    const { req, reply, requestKind, inflightKind, parseBody, execute } = args;
    const principal = await requireMemoryPrincipal(req);
    const body = parseBody(withIdentityFromRequest(req, req.body, principal, requestKind));
    await enforceRateLimit(req, reply, inflightKind);
    await enforceTenantQuota(req, reply, inflightKind, tenantFromBody(body));
    const gate = await acquireInflightSlot(inflightKind);
    try {
      return await execute(body, principal);
    } finally {
      gate.release();
    }
  };

  app.post("/v1/handoff/store", async (req: HandoffRequest, reply: FastifyReply) => {
    const out = await runHandoffRoute<HandoffStoreInput, unknown>({
      req,
      reply,
      requestKind: "handoff_store",
      inflightKind: "write",
      parseBody: (input) => HandoffStoreRequest.parse(input),
      execute: (body, principal) => service.store(body, { principal }),
    });
    return reply.code(200).send(out);
  });

  app.post("/v1/handoff/recover", async (req: HandoffRequest, reply: FastifyReply) => {
    const out = await runHandoffRoute<HandoffRecoverInput, unknown>({
      req,
      reply,
      requestKind: "handoff_recover",
      inflightKind: "recall",
      parseBody: (input) => HandoffRecoverRequest.parse(input),
      execute: (body, principal) => service.recover(body, { principal }),
    });
    return reply.code(200).send(out);
  });
}
