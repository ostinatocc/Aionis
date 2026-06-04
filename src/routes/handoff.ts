import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import { buildLiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";
import {
  readExecutionContinuitySlotFields,
} from "../memory/execution-slot-surface.js";
import { applyExecutionContinuityTransitionsFromSlots } from "../kernel/execution-continuity-kernel.js";
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
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import { commitLitePreparedWriteWithProjection } from "../memory/lite-projected-write-commit.js";

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

type RegisterHandoffRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  liteWriteStore: LiteWriteStore;
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
  executionStateStore?: ExecutionStateStore | null;
};

function firstNode<T>(value: unknown): T | null {
  return Array.isArray(value) ? ((value[0] as T | undefined) ?? null) : null;
}

function asSlots(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function registerHandoffRoutes(args: RegisterHandoffRoutesArgs) {
  const {
    app,
    env,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    executionStateStore,
  } = args;
  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite handoff routes only support AIONIS_EDITION=lite");
  }
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(env);
  const buildPrincipalHandoffWriteBody = (body: HandoffStoreInput, principal: AuthPrincipal | null) => {
    const actorId = typeof body.actor === "string" && body.actor.trim().length > 0 ? body.actor.trim() : null;
    return buildHandoffWriteBody({
      ...body,
      ...(principal?.agent_id ? { producer_agent_id: principal.agent_id } : actorId ? { producer_agent_id: actorId } : {}),
      ...(principal?.agent_id ? { owner_agent_id: principal.agent_id } : actorId ? { owner_agent_id: actorId } : {}),
      ...(!principal?.agent_id && principal?.team_id ? { owner_team_id: principal.team_id } : {}),
    });
  };
  const runCommittedHandoffWrite = async (prepared: PreparedHandoffWrite): Promise<HandoffWriteResult> =>
    (
      await commitLitePreparedWriteWithProjection({
        prepared,
        liteWriteStore,
        embedder: writeEmbedder,
        learningControlReviewProviders: learningControlProviders.workflowProjection,
        writeOptions: {
          maxTextLen: env.MAX_TEXT_LEN,
          piiRedaction: env.PII_REDACTION,
          allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
          associativeLinkOrigin: "handoff_store",
        },
      })
    ).out;
  const buildHandoffStoreResponse = (args: {
    body: HandoffStoreInput;
    writeBody: ReturnType<typeof buildHandoffWriteBody>;
    out: HandoffWriteResult;
    appliedExecutionTransitions: Array<Record<string, unknown>> | undefined;
  }) => {
    const handoffNode = firstNode<HandoffNodeLike>(args.out.nodes);
    const handoffSlots = asSlots(handoffNode?.slots);
    const writeNode = firstNode<HandoffWriteBodyNodeLike>(args.writeBody.nodes);
    const writeSlots = asSlots(writeNode?.slots);
    const continuitySlots = handoffSlots ?? writeSlots;
    const executionSlots = readExecutionContinuitySlotFields(continuitySlots);
    const resolvedAcceptanceChecks = resolveNodeAcceptanceChecks({ slots: continuitySlots });
    const resolvedTargetFiles = resolveNodeTargetFiles({ slots: continuitySlots });
    const resolvedNextAction = resolveNodeNextAction({ slots: continuitySlots });
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
      control_profile_v1: executionSlots.control_profile_v1,
      execution_transitions_v1:
        args.appliedExecutionTransitions ?? executionSlots.execution_transitions_v1,
    };
  };
  const runHandoffRecoverForPrincipal = (body: HandoffRecoverInput, principal: AuthPrincipal | null) =>
    recoverHandoff({
      liteWriteStore,
      executionStateStore,
      input: body,
      defaultScope: env.MEMORY_SCOPE,
      defaultTenantId: env.MEMORY_TENANT_ID,
      consumerAgentId: principal?.agent_id ?? null,
      consumerTeamId: principal?.team_id ?? null,
    });

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
      execute: async (body, principal) => {
      const writeBody = buildPrincipalHandoffWriteBody(body, principal);
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
      const out = await runCommittedHandoffWrite(prepared);

      const writeNode = firstNode<HandoffWriteBodyNodeLike>(writeBody.nodes);
      const writeSlots = asSlots(writeNode?.slots);
      const appliedExecutionTransitions = applyExecutionContinuityTransitionsFromSlots({
        executionStateStore,
        writeSlots,
      });
      return buildHandoffStoreResponse({
        body,
        writeBody,
        out,
        appliedExecutionTransitions,
      });
      },
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
      execute: (body, principal) => runHandoffRecoverForPrincipal(body, principal),
    });
    return reply.code(200).send(out);
  });
}
