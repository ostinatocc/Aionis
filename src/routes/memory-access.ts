import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { Env } from "../config.js";
import { memoryResolveLite } from "../memory/resolve.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryResolveRequest = FastifyRequest<{ Body: unknown }>;

type RegisterMemoryAccessRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  liteWriteStore: LiteWriteStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: "resolve",
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "recall") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "recall", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "recall") => Promise<InflightGateToken>;
};

export function registerMemoryAccessRoutes(args: RegisterMemoryAccessRoutesArgs) {
  assertLocalStoreRuntimeEdition(args.env, "local-store memory-access routes");
  args.app.post("/v1/memory/resolve", async (req: MemoryResolveRequest, reply: FastifyReply) => {
    const principal = await args.requireMemoryPrincipal(req);
    const body = args.withIdentityFromRequest(req, req.body, principal, "resolve");
    await args.enforceRateLimit(req, reply, "recall");
    await args.enforceTenantQuota(req, reply, "recall", args.tenantFromBody(body));
    const gate = await args.acquireInflightSlot("recall");
    try {
      const out = await memoryResolveLite(
        args.liteWriteStore,
        body,
        args.env.MEMORY_SCOPE,
        args.env.MEMORY_TENANT_ID,
      );
      return reply.code(200).send(out);
    } finally {
      gate.release();
    }
  });
}
