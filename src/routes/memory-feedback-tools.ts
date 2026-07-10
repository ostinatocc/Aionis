import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import {
  buildLiteLearningControlRuntimeProviders,
  type LiteLearningControlRuntimeProviderBuilderOptions,
} from "../app/learning-control-runtime-providers.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createLearningKernel, type LiteLearningKernelStore } from "../kernel/learning-kernel.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type ToolMemoryRequestKind = "tools_select" | "tools_decision" | "tools_run" | "tools_feedback";
type ToolMemoryInflightKind = "write" | "recall";
type ToolMemoryRequest = FastifyRequest<{ Body: unknown }>;

type RegisterMemoryFeedbackToolRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder?: EmbeddingProvider | null;
  liteRecallAccess: RecallStoreAccess;
  liteWriteStore: LiteLearningKernelStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: ToolMemoryRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: ToolMemoryInflightKind) => Promise<void>;
  enforceTenantQuota: (
    req: FastifyRequest,
    reply: FastifyReply,
    kind: ToolMemoryInflightKind,
    tenantId: string,
  ) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: ToolMemoryInflightKind) => Promise<InflightGateToken>;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
};

export function registerMemoryFeedbackToolRoutes(args: RegisterMemoryFeedbackToolRoutesArgs) {
  const { env } = args;
  assertLocalStoreRuntimeEdition(env, "local-store memory-feedback-tools routes");
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(
    env,
    args.learningControlRuntimeProviderBuilderOptions,
  );
  const learningKernel = createLearningKernel({
    env,
    embedder: args.embedder,
    queryEmbedder: args.queryEmbedder,
    liteRecallAccess: args.liteRecallAccess,
    liteWriteStore: args.liteWriteStore,
    learningControlProviders: {
      toolsFeedback: learningControlProviders.toolsFeedback,
    },
  });

  const registerToolRoute = <TResult>(route: {
    path: string;
    requestKind: ToolMemoryRequestKind;
    inflightKind: ToolMemoryInflightKind;
    execute: (body: unknown) => Promise<TResult>;
  }) => {
    args.app.post(route.path, async (req: ToolMemoryRequest, reply: FastifyReply) => {
      const principal = await args.requireMemoryPrincipal(req);
      const body = args.withIdentityFromRequest(req, req.body, principal, route.requestKind);
      await args.enforceRateLimit(req, reply, route.inflightKind);
      await args.enforceTenantQuota(req, reply, route.inflightKind, args.tenantFromBody(body));
      const gate = await args.acquireInflightSlot(route.inflightKind);
      try {
        const out = await route.execute(body);
        return reply.code(200).send(out);
      } finally {
        gate.release();
      }
    });
  };

  registerToolRoute({
    path: "/v1/memory/tools/select",
    requestKind: "tools_select",
    inflightKind: "recall",
    execute: (body) => learningKernel.selectToolWithLearnedMemory(body),
  });
  registerToolRoute({
    path: "/v1/memory/tools/decision",
    requestKind: "tools_decision",
    inflightKind: "recall",
    execute: (body) => learningKernel.readToolDecision(body),
  });
  registerToolRoute({
    path: "/v1/memory/tools/run",
    requestKind: "tools_run",
    inflightKind: "recall",
    execute: (body) => learningKernel.readToolRun(body),
  });
  registerToolRoute({
    path: "/v1/memory/tools/feedback",
    requestKind: "tools_feedback",
    inflightKind: "write",
    execute: (body) => learningKernel.recordToolSelectionFeedback(body),
  });
}
