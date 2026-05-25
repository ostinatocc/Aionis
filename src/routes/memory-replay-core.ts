import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Env } from "../config.js";
import { createEmbeddingSurfacePolicy, type EmbeddingSurfacePolicy } from "../embeddings/surface-policy.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  replayPlaybookCandidate,
  replayPlaybookCompileFromRun,
  replayPlaybookGet,
  replayPlaybookPromote,
  replayPlaybookRepair,
  replayRunEnd,
  replayRunGet,
  replayRunStart,
  replayStepAfter,
  replayStepBefore,
} from "../memory/replay.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

type StoreLike = {
  withTx: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
  withClient: <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
};

type ReplayCoreRequest = FastifyRequest<{ Body: unknown }>;

type ReplayWriteOptionsLike = Parameters<typeof replayRunStart>[2];
type ReplayReadOptionsLike = Parameters<typeof replayRunGet>[2];

type ReplayCoreRequestKind =
  | "replay_run_start"
  | "replay_step_before"
  | "replay_step_after"
  | "replay_run_end"
  | "replay_run_get"
  | "replay_playbook_compile"
  | "replay_playbook_get"
  | "replay_playbook_candidate"
  | "replay_playbook_promote"
  | "replay_playbook_repair";

type ReplayCoreRateKind = "write" | "recall";
type ReplayCoreExecutor<TResult> = (body: unknown) => Promise<TResult>;

export function registerMemoryReplayCoreRoutes(args: {
  app: FastifyInstance;
  env: Env;
  store: StoreLike;
  embedder: EmbeddingProvider | null;
  embeddingSurfacePolicy?: EmbeddingSurfacePolicy;
  embeddedRuntime: ReplayWriteOptionsLike["embeddedRuntime"];
  liteReplayAccess?: ReplayWriteOptionsLike["replayAccess"];
  liteReplayStore?: ReplayWriteOptionsLike["replayMirror"];
  liteWriteStore?: LiteWriteStore | null;
  writeAccessShadowMirrorV2: boolean;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: ReplayCoreRequestKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: ReplayCoreRateKind) => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: ReplayCoreRateKind, tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: ReplayCoreRateKind) => Promise<InflightGateToken>;
}) {
  const {
    app,
    env,
    store,
    embedder,
    embeddingSurfacePolicy: embeddingSurfacePolicyArg,
    embeddedRuntime,
    liteReplayAccess,
    liteReplayStore,
    liteWriteStore,
    writeAccessShadowMirrorV2,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
  } = args;
  const embeddingSurfacePolicy =
    embeddingSurfacePolicyArg ?? createEmbeddingSurfacePolicy({ providerConfigured: !!embedder });
  const writeEmbedder = embeddingSurfacePolicy.providerFor("write_auto_embed", embedder);

  const writeDefaults = {
    defaultScope: env.MEMORY_SCOPE,
    defaultTenantId: env.MEMORY_TENANT_ID,
    maxTextLen: env.MAX_TEXT_LEN,
    piiRedaction: env.PII_REDACTION,
    allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
    shadowDualWriteEnabled: env.MEMORY_SHADOW_DUAL_WRITE_ENABLED,
    shadowDualWriteStrict: env.MEMORY_SHADOW_DUAL_WRITE_STRICT,
    writeAccessShadowMirrorV2,
    embedder: writeEmbedder,
    embeddedRuntime,
    replayAccess: liteReplayAccess ?? null,
    replayMirror: liteReplayStore ?? null,
    writeAccess: liteWriteStore ?? null,
  } satisfies ReplayWriteOptionsLike;

  const readDefaults = {
    defaultScope: env.MEMORY_SCOPE,
    defaultTenantId: env.MEMORY_TENANT_ID,
    embeddedRuntime,
    replayAccess: liteReplayAccess ?? null,
  } satisfies ReplayReadOptionsLike;

  const liteModeActive = env.AIONIS_EDITION === "lite" && !!liteWriteStore;
  const liteReplayReadActive = env.AIONIS_EDITION === "lite" && !!liteReplayAccess;
  const executeReplayWrite = <TResult>(
    body: unknown,
    operation: (client: pg.PoolClient | null, requestBody: unknown) => Promise<TResult>,
  ) =>
    liteModeActive
      ? liteWriteStore.withTx(() => operation(null, body))
      : store.withTx((client) => operation(client, body));

  const executeReplayRead = <TResult>(
    body: unknown,
    operation: (client: pg.PoolClient | null, requestBody: unknown) => Promise<TResult>,
  ) =>
    liteReplayReadActive
      ? operation(null, body)
      : store.withClient((client) => operation(client, body));

  const runReplayRoute = async <TResult>(args: {
    req: ReplayCoreRequest;
    reply: FastifyReply;
    requestKind: ReplayCoreRequestKind;
    rateKind: ReplayCoreRateKind;
    execute: (body: unknown) => Promise<TResult>;
  }): Promise<TResult> => {
    const { req, reply, requestKind, rateKind, execute } = args;
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, requestKind);
    await enforceRateLimit(req, reply, rateKind);
    await enforceTenantQuota(req, reply, rateKind, tenantFromBody(body));
    const gate = await acquireInflightSlot(rateKind);
    try {
      return await execute(body);
    } finally {
      gate.release();
    }
  };

  const registerReplayPostRoute = (
    path: string,
    requestKind: ReplayCoreRequestKind,
    rateKind: ReplayCoreRateKind,
    execute: ReplayCoreExecutor<unknown>,
  ) => {
    app.post(path, async (req: ReplayCoreRequest, reply: FastifyReply) => {
      const out = await runReplayRoute({ req, reply, requestKind, rateKind, execute });
      return reply.code(200).send(out);
    });
  };

  registerReplayPostRoute("/v1/memory/replay/run/start", "replay_run_start", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayRunStart(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/step/before", "replay_step_before", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayStepBefore(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/step/after", "replay_step_after", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayStepAfter(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/run/end", "replay_run_end", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayRunEnd(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/runs/get", "replay_run_get", "recall", (body) =>
    executeReplayRead(body, (client, requestBody) => replayRunGet(client, requestBody, readDefaults)),
  );

  registerReplayPostRoute(
    "/v1/memory/replay/playbooks/compile_from_run",
    "replay_playbook_compile",
    "write",
    (body) =>
      executeReplayWrite(body, (client, requestBody) => replayPlaybookCompileFromRun(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/playbooks/get", "replay_playbook_get", "recall", (body) =>
    executeReplayRead(body, (client, requestBody) => replayPlaybookGet(client, requestBody, readDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/playbooks/candidate", "replay_playbook_candidate", "recall", (body) =>
    executeReplayRead(body, (client, requestBody) => replayPlaybookCandidate(client, requestBody, readDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/playbooks/promote", "replay_playbook_promote", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayPlaybookPromote(client, requestBody, writeDefaults)),
  );

  registerReplayPostRoute("/v1/memory/replay/playbooks/repair", "replay_playbook_repair", "write", (body) =>
    executeReplayWrite(body, (client, requestBody) => replayPlaybookRepair(client, requestBody, writeDefaults)),
  );
}
