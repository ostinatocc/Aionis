import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../../../src/config.ts";
import type { EmbeddingSurfacePolicy } from "../../../src/embeddings/surface-policy.ts";
import type { EmbeddingProvider } from "../../../src/embeddings/types.ts";
import type { ExecutionStateStore } from "../../../src/execution/state-store.ts";
import type { ExecutionTreeStore } from "../../../src/execution/tree-store.ts";
import type { LiteLearningControlRuntimeProviderBuilderOptions } from "../../../src/app/learning-control-runtime-providers.ts";
import {
  createMemoryWriteRouteService,
  type MemoryWriteRouteServiceArgs,
} from "../../../src/routes/memory-write.ts";
import type { LiteWriteStore } from "../../../src/store/lite-write-store.ts";
import type { AuthPrincipal } from "../../../src/util/auth.ts";
import type { InflightGateToken } from "../../../src/util/inflight_gate.ts";

type MemoryWriteRequest = FastifyRequest<{ Body: unknown }>;

/**
 * Test-only compatibility harness for exercising the typed write service through
 * the retired HTTP shape. Runtime production composition does not import it.
 */
export function registerMemoryWriteRoutes(args: {
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
    kind: "write",
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write") => Promise<InflightGateToken>;
  executionStateStore?: ExecutionStateStore | null;
  executionTreeStore?: ExecutionTreeStore | null;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
}) {
  const service = createMemoryWriteRouteService(args satisfies MemoryWriteRouteServiceArgs);
  args.app.post("/v1/memory/write", async (req: MemoryWriteRequest, reply: FastifyReply) => {
    const startedAt = performance.now();
    const principal = await args.requireMemoryPrincipal(req);
    const body = args.withIdentityFromRequest(req, req.body, principal, "write");
    await args.enforceRateLimit(req, reply, "write");
    await args.enforceTenantQuota(req, reply, "write", args.tenantFromBody(body));
    const gate = await args.acquireInflightSlot("write");
    try {
      const result = await service.commit(body, { log: req.log, startedAt });
      return reply.code(200).send(result.response);
    } finally {
      gate.release();
    }
  });
}
