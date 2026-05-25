import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { activateMemoryNodesLite, rehydrateArchiveNodesLite } from "../memory/lifecycle-lite.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryLifecycleRequestKind = "rehydrate" | "activate";
type MemoryLifecycleRequest = FastifyRequest<{ Body: unknown }>;

type RegisterLiteMemoryLifecycleRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  liteWriteStore: LiteWriteStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: MemoryLifecycleRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write") => Promise<InflightGateToken>;
};

export function registerLiteMemoryLifecycleRoutes(args: RegisterLiteMemoryLifecycleRoutesArgs) {
  const {
    app,
    env,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;

  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite memory-lifecycle routes only support AIONIS_EDITION=lite");
  }

  const runLifecycleRoute = async <T>(args: {
    req: MemoryLifecycleRequest;
    reply: FastifyReply;
    requestKind: MemoryLifecycleRequestKind;
    execute: (body: unknown) => Promise<T>;
  }): Promise<T> => {
    const principal = await requireMemoryPrincipal(args.req);
    const body = withIdentityFromRequest(args.req, args.req.body, principal, args.requestKind);
    await enforceRateLimit(args.req, args.reply, "write");
    await enforceTenantQuota(args.req, args.reply, "write", tenantFromBody(body));
    const gate = await acquireInflightSlot("write");
    try {
      return await executeWithTx(liteWriteStore, () => args.execute(body));
    } finally {
      gate.release();
    }
  };

  app.post("/v1/memory/archive/rehydrate", async (req: MemoryLifecycleRequest, reply: FastifyReply) => {
    const out = await runLifecycleRoute({
      req,
      reply,
      requestKind: "rehydrate",
      execute: (body) =>
        rehydrateArchiveNodesLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
          maxTextLen: env.MAX_TEXT_LEN,
          piiRedaction: env.PII_REDACTION,
          defaultActor: env.LITE_LOCAL_ACTOR_ID,
        }),
    });
    return reply.code(200).send(out);
  });

  app.post("/v1/memory/nodes/activate", async (req: MemoryLifecycleRequest, reply: FastifyReply) => {
    const out = await runLifecycleRoute({
      req,
      reply,
      requestKind: "activate",
      execute: (body) =>
        activateMemoryNodesLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
          maxTextLen: env.MAX_TEXT_LEN,
          piiRedaction: env.PII_REDACTION,
          defaultActor: env.LITE_LOCAL_ACTOR_ID,
        }),
    });
    return reply.code(200).send(out);
  });
}

async function executeWithTx<T>(store: Pick<LiteWriteStore, "withTx">, fn: () => Promise<T>): Promise<T> {
  return await store.withTx(fn);
}
