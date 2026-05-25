import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Env } from "../config.js";
import {
  cancelSandboxRun,
  createSandboxSession,
  enqueueSandboxRun,
  getSandboxRun,
  getSandboxRunArtifact,
  getSandboxRunLogs,
} from "../memory/sandbox.js";
import { HttpError } from "../util/http.js";

type StoreLike = {
  withTx: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  withClient: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
};

type SandboxExecutorLike = {
  executeSync: (runId: string) => Promise<void>;
  enqueue: (runId: string) => void;
  requestCancel: (runId: string) => void;
};

type MemorySandboxRequestKind =
  | "sandbox_session_create"
  | "sandbox_execute"
  | "sandbox_run_get"
  | "sandbox_run_logs"
  | "sandbox_run_artifact"
  | "sandbox_run_cancel";

type MemorySandboxRequest = FastifyRequest<{ Body: unknown }>;
type SandboxRateLimitKind = "sandbox_read" | "sandbox_write";
type SandboxTenantQuotaKind = "recall" | "write";
type SandboxStoreOperation<T> = (client: pg.PoolClient, body: unknown) => Promise<T>;

type RegisterMemorySandboxRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  store: StoreLike;
  sandboxExecutor: SandboxExecutorLike;
  requireAdminToken: (req: FastifyRequest) => void;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: null,
    kind: MemorySandboxRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "sandbox_read" | "sandbox_write") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "recall" | "write", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  scopeFromBody: (body: unknown) => string;
  projectFromBody: (body: unknown) => string | null;
  enforceSandboxTenantBudget: (reply: FastifyReply, tenantId: string, scope: string, projectId?: string | null) => Promise<void>;
};

export function registerMemorySandboxRoutes(args: RegisterMemorySandboxRoutesArgs) {
  const {
    app,
    env,
    store,
    sandboxExecutor,
    requireAdminToken,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    scopeFromBody,
    projectFromBody,
    enforceSandboxTenantBudget,
  } = args;
  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite memory-sandbox routes only support AIONIS_EDITION=lite");
  }

  const assertSandboxEnabled = (req: FastifyRequest) => {
    if (!env.SANDBOX_ENABLED) {
      throw new HttpError(400, "sandbox_disabled", "sandbox interface is disabled");
    }
    if (env.SANDBOX_ADMIN_ONLY) {
      requireAdminToken(req);
    }
  };

  const prepareSandboxBody = async (
    req: MemorySandboxRequest,
    reply: FastifyReply,
    kind: MemorySandboxRequestKind,
    rateLimitKind: SandboxRateLimitKind,
    tenantQuotaKind: SandboxTenantQuotaKind,
  ) => {
    assertSandboxEnabled(req);
    const typedBody = withIdentityFromRequest(req, req.body, null, kind);
    await enforceRateLimit(req, reply, rateLimitKind);
    await enforceTenantQuota(req, reply, tenantQuotaKind, tenantFromBody(typedBody));
    return typedBody;
  };

  const executeSandboxStoreOperation = <T>(
    body: unknown,
    operation: SandboxStoreOperation<T>,
    options: { transactional: boolean },
  ) =>
    options.transactional
      ? store.withTx((client) => operation(client, body))
      : store.withClient((client) => operation(client, body));

  const registerSandboxPostRoute = <T>(
    path: string,
    config: {
      kind: MemorySandboxRequestKind;
      rateLimitKind: SandboxRateLimitKind;
      tenantQuotaKind: SandboxTenantQuotaKind;
      transactional: boolean;
      operation: SandboxStoreOperation<T>;
    },
  ) => {
    app.post(path, async (req: MemorySandboxRequest, reply: FastifyReply) => {
      const body = await prepareSandboxBody(
        req,
        reply,
        config.kind,
        config.rateLimitKind,
        config.tenantQuotaKind,
      );
      const out = await executeSandboxStoreOperation(body, config.operation, {
        transactional: config.transactional,
      });
      return reply.code(200).send(out);
    });
  };

  const buildSandboxRunPayload = async (queued: Awaited<ReturnType<typeof enqueueSandboxRun>>) => {
    let runPayload = queued.run;
    if (runPayload.mode === "sync") {
      await sandboxExecutor.executeSync(runPayload.run_id);
      const final = await executeSandboxStoreOperation(
        {
          tenant_id: queued.tenant_id,
          scope: queued.scope,
          run_id: runPayload.run_id,
        },
        (client, requestBody) =>
          getSandboxRun(client, requestBody, {
            defaultScope: env.MEMORY_SCOPE,
            defaultTenantId: env.MEMORY_TENANT_ID,
          }),
        { transactional: false },
      );
      runPayload = final.run;
    } else {
      sandboxExecutor.enqueue(runPayload.run_id);
    }

    return {
      tenant_id: queued.tenant_id,
      scope: queued.scope,
      accepted: runPayload.mode === "async",
      run: runPayload,
    };
  };

  registerSandboxPostRoute("/v1/memory/sandbox/sessions", {
    kind: "sandbox_session_create",
    rateLimitKind: "sandbox_write",
    tenantQuotaKind: "write",
    transactional: true,
    operation: (client, body) =>
      createSandboxSession(client, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
      }),
  });

  app.post("/v1/memory/sandbox/execute", async (req: MemorySandboxRequest, reply: FastifyReply) => {
    const body = await prepareSandboxBody(req, reply, "sandbox_execute", "sandbox_write", "write");
    const tenantId = tenantFromBody(body);
    const scope = scopeFromBody(body);
    const projectId = projectFromBody(body);
    await enforceSandboxTenantBudget(reply, tenantId, scope, projectId);
    const queued = await executeSandboxStoreOperation(
      body,
      (client, requestBody) =>
        enqueueSandboxRun(client, requestBody, {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          defaultTimeoutMs: env.SANDBOX_EXECUTOR_TIMEOUT_MS,
        }),
      { transactional: true },
    );

    return reply.code(200).send(await buildSandboxRunPayload(queued));
  });

  registerSandboxPostRoute("/v1/memory/sandbox/runs/get", {
    kind: "sandbox_run_get",
    rateLimitKind: "sandbox_read",
    tenantQuotaKind: "recall",
    transactional: false,
    operation: (client, body) =>
      getSandboxRun(client, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
      }),
  });

  registerSandboxPostRoute("/v1/memory/sandbox/runs/logs", {
    kind: "sandbox_run_logs",
    rateLimitKind: "sandbox_read",
    tenantQuotaKind: "recall",
    transactional: false,
    operation: (client, body) =>
      getSandboxRunLogs(client, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
      }),
  });

  registerSandboxPostRoute("/v1/memory/sandbox/runs/artifact", {
    kind: "sandbox_run_artifact",
    rateLimitKind: "sandbox_read",
    tenantQuotaKind: "recall",
    transactional: false,
    operation: (client, body) =>
      getSandboxRunArtifact(client, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        artifactObjectStoreBaseUri: env.SANDBOX_ARTIFACT_OBJECT_STORE_BASE_URI.trim() || null,
      }),
  });

  app.post("/v1/memory/sandbox/runs/cancel", async (req: MemorySandboxRequest, reply: FastifyReply) => {
    const body = await prepareSandboxBody(req, reply, "sandbox_run_cancel", "sandbox_write", "write");
    const out = await executeSandboxStoreOperation(
      body,
      (client, requestBody) =>
        cancelSandboxRun(client, requestBody, {
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
        }),
      { transactional: true },
    );
    if (out.status === "running") {
      sandboxExecutor.requestCancel(out.run_id);
    }
    return reply.code(200).send(out);
  });
}
