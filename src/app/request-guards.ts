import type { RuntimeConfig } from "../config/runtime-config.js";
import type { RecallAuth } from "../memory/recall.js";
import { secretTokensEqual } from "../util/admin_auth.js";
import { createAuthResolver, type AuthPrincipal } from "../util/auth.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { parseTrustedProxyCidrs, resolveTrustedClientIp } from "../util/ip-guard.js";
import { InflightGate, InflightGateError, type InflightGateToken } from "../util/inflight_gate.js";
import { TokenBucketLimiter } from "../util/ratelimit.js";

type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retry_after_ms: number };

type Limiter = {
  check: (key: string, cost?: number) => RateLimitResult;
};

type RequestHeaders = Record<string, unknown>;

type RequestSocketLike = {
  remoteAddress?: string | null;
};

type RequestLike = {
  headers?: RequestHeaders;
  raw?: { socket?: RequestSocketLike | null } | null;
  socket?: RequestSocketLike | null;
  ip?: string | null;
  aionis_client_ip?: string;
  aionis_tenant_id?: string;
  aionis_scope?: string;
};

type ReplyWithHeader = {
  header: (name: string, value: unknown) => unknown;
};

export type RateLimitKind = "recall" | "debug_embeddings" | "write";
export type TenantQuotaKind = "recall" | "debug_embeddings" | "write";
export type InflightKind = "recall" | "write";

export type IdentityRequestKind =
  | "write"
  | "handoff_store"
  | "handoff_recover"
  | "rehydrate"
  | "activate"
  | "find"
  | "continuity_review_pack"
  | "agent_memory_inspect"
  | "agent_memory_review_pack"
  | "agent_memory_resume_pack"
  | "agent_memory_handoff_pack"
  | "execution_introspect"
  | "execution_context_assemble"
  | "evolution_review_pack"
  | "action_retrieval"
  | "experience_intelligence"
  | "delegation_records_write"
  | "delegation_records_find"
  | "delegation_records_aggregate"
  | "trajectory_compile"
  | "resolve"
  | "rehydrate_payload"
  | "product_guide"
  | "recall"
  | "recall_text"
  | "planning_context"
  | "context_assemble"
  | "feedback"
  | "rules_state"
  | "rules_evaluate"
  | "tools_select"
  | "tools_decision"
  | "tools_run"
  | "tools_feedback"
  | "learning_loop_run"
  | "runtime_maintenance_run"
  | "policy_learning_control_apply"
  | "anchors_suppress"
  | "anchors_unsuppress"
  | "patterns_suppress"
  | "patterns_unsuppress"
  | "replay_run_start"
  | "replay_step_before"
  | "replay_step_after"
  | "replay_run_end"
  | "replay_run_get"
  | "replay_playbook_compile"
  | "replay_playbook_get"
  | "replay_playbook_candidate"
  | "replay_playbook_promote"
  | "replay_playbook_repair"
  | "replay_playbook_repair_review"
  | "replay_playbook_run"
  | "replay_playbook_dispatch";

type CreateRequestGuardsArgs = {
  config: Pick<RuntimeConfig, "runtime" | "governance" | "limits">;
  embedder: { embed: (texts: string[]) => Promise<number[][]> } | null;
  recallLimiter: Limiter | null;
  debugEmbedLimiter: Limiter | null;
  writeLimiter: Limiter | null;
  recallTextEmbedLimiter: Limiter | null;
  recallInflightGate: InflightGate;
  writeInflightGate: InflightGate;
};

const TENANT_SLOT_SCAN_MAX_DEPTH = 32;
const TENANT_SLOT_SCAN_MAX_NODES = 20000;

function assertLiteRequestGuardPosture(config: Pick<RuntimeConfig, "governance">): void {
  if (config.governance.MEMORY_AUTH_MODE !== "off") {
    throw new Error("aionis-lite request guards only support MEMORY_AUTH_MODE=off");
  }
  if (config.governance.TENANT_QUOTA_ENABLED) {
    throw new Error("aionis-lite request guards only support TENANT_QUOTA_ENABLED=false");
  }
}

function assertServerRequestGuardPosture(config: Pick<RuntimeConfig, "runtime" | "governance">): void {
  if (config.governance.MEMORY_AUTH_MODE === "off" && !config.runtime.AIONIS_SERVER_ALLOW_AUTH_OFF_FOR_DEV) {
    throw new Error("aionis-server request guards require MEMORY_AUTH_MODE=api_key, jwt, or api_key_or_jwt");
  }
}

function firstHeaderValue(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length > 0) return firstHeaderValue(v[0]);
  return "";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function serverDefaultScopeForPrincipal(runtime: RuntimeConfig["runtime"], principal: AuthPrincipal): string {
  if (principal.default_scope && principal.default_scope.trim().length > 0) return principal.default_scope.trim();
  const configured = runtime.MEMORY_SCOPE.trim();
  if (!configured || configured === "default") return `${principal.tenant_id}/default`;
  if (configured === principal.tenant_id || configured.startsWith(`${principal.tenant_id}/`)) return configured;
  return `${principal.tenant_id}/${configured}`;
}

function assertTenantAllowedForPrincipal(args: {
  principal: AuthPrincipal;
  tenantId: string;
  source: string;
}): void {
  const tenantId = args.tenantId.trim();
  if (!tenantId) return;
  if (tenantId === args.principal.tenant_id) return;
  throw new HttpError(403, "tenant_forbidden", "tenant is not allowed for this principal", {
    source: args.source,
  });
}

function assertScopeAllowedForPrincipal(args: {
  principal: AuthPrincipal;
  scope: string;
}): void {
  const scope = args.scope.trim();
  if (!scope) throw new HttpError(400, "invalid_scope", "scope is required");
  if (args.principal.allowed_scopes.includes(scope)) return;
  if (args.principal.default_scope === scope) return;
  if (scope === args.principal.tenant_id || scope.startsWith(`${args.principal.tenant_id}/`)) return;
  throw new HttpError(403, "scope_forbidden", "scope is not allowed for this principal");
}

function assertNoTenantOverrideInSlots(args: {
  value: unknown;
  principal: AuthPrincipal;
}): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; insideSlots: boolean; depth: number }> = [
    { value: args.value, path: "", insideSlots: false, depth: 0 },
  ];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { value, path, insideSlots, depth } = current;
    if (!value || typeof value !== "object") continue;
    if (depth > TENANT_SLOT_SCAN_MAX_DEPTH) {
      throw new HttpError(400, "request_nesting_too_deep", "request body nesting exceeds the supported limit", {
        max_depth: TENANT_SLOT_SCAN_MAX_DEPTH,
        source: path,
      });
    }
    if (seen.has(value)) continue;
    seen.add(value);
    visitedNodes += 1;
    if (visitedNodes > TENANT_SLOT_SCAN_MAX_NODES) {
      throw new HttpError(400, "request_body_too_complex", "request body object graph exceeds the supported limit", {
        max_nodes: TENANT_SLOT_SCAN_MAX_NODES,
      });
    }

    if (Array.isArray(value)) {
      for (let idx = value.length - 1; idx >= 0; idx -= 1) {
        const child = value[idx];
        if (!child || typeof child !== "object") continue;
        stack.push({
          value: child,
          path: path ? `${path}.${idx}` : String(idx),
          insideSlots,
          depth: depth + 1,
        });
      }
      continue;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
      const [key, child] = entries[idx] ?? ["", undefined];
      if (!key) continue;
      const childPath = path ? `${path}.${key}` : key;
      const childInsideSlots = insideSlots || key === "slots";
      if (childInsideSlots && key === "tenant_id" && typeof child === "string" && child.trim() && child.trim() !== args.principal.tenant_id) {
        throw new HttpError(403, "tenant_forbidden", "tenant is not allowed for this principal", {
          source: childPath,
        });
      }
      if (child && typeof child === "object") {
        stack.push({ value: child, path: childPath, insideSlots: childInsideSlots, depth: depth + 1 });
      }
    }
  }
}

function assertNoReservedRuntimeWriteClaims(value: unknown): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: string; insideSlots: boolean; depth: number }> = [
    { value, path: "", insideSlots: false, depth: 0 },
  ];
  let visitedNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.value || typeof current.value !== "object") continue;
    if (current.depth > TENANT_SLOT_SCAN_MAX_DEPTH) {
      throw new HttpError(400, "request_nesting_too_deep", "request body nesting exceeds the supported limit", {
        max_depth: TENANT_SLOT_SCAN_MAX_DEPTH,
        source: current.path,
      });
    }
    if (seen.has(current.value as object)) continue;
    seen.add(current.value as object);
    visitedNodes += 1;
    if (visitedNodes > TENANT_SLOT_SCAN_MAX_NODES) {
      throw new HttpError(400, "request_body_too_complex", "request body object graph exceeds the supported limit", {
        max_nodes: TENANT_SLOT_SCAN_MAX_NODES,
      });
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => {
        if (child && typeof child === "object") {
          stack.push({
            value: child,
            path: current.path ? `${current.path}.${index}` : String(index),
            insideSlots: current.insideSlots,
            depth: current.depth + 1,
          });
        }
      });
      continue;
    }
    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      const childPath = current.path ? `${current.path}.${key}` : key;
      const childInsideSlots = current.insideSlots || key === "slots";
      if (key === "producer_agent_id" && child === "aionis-runtime") {
        throw new HttpError(400, "reserved_runtime_identity", "aionis-runtime producer identity is reserved for Runtime-owned writes", {
          source: childPath,
        });
      }
      if (
        childInsideSlots
        && (key === "guide_exposure_v1" || key === "product_guide_receipt_v1")
      ) {
        throw new HttpError(400, "reserved_runtime_receipt", "Runtime receipt slots cannot be supplied by public writes", {
          source: childPath,
        });
      }
      if (child && typeof child === "object") {
        stack.push({ value: child, path: childPath, insideSlots: childInsideSlots, depth: current.depth + 1 });
      }
    }
  }
}

function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReplayReadIdentityKind(kind: IdentityRequestKind): boolean {
  return (
    kind === "replay_run_start"
    || kind === "replay_step_before"
    || kind === "replay_step_after"
    || kind === "replay_run_end"
    || kind === "replay_run_get"
    || kind === "replay_playbook_compile"
    || kind === "replay_playbook_get"
    || kind === "replay_playbook_candidate"
    || kind === "replay_playbook_promote"
    || kind === "replay_playbook_repair"
    || kind === "replay_playbook_repair_review"
    || kind === "replay_playbook_run"
    || kind === "replay_playbook_dispatch"
    || kind === "execution_introspect"
    || kind === "continuity_review_pack"
    || kind === "evolution_review_pack"
  );
}

function isReplayWriteIdentityKind(kind: IdentityRequestKind): boolean {
  return (
    kind === "replay_run_start"
    || kind === "replay_step_before"
    || kind === "replay_step_after"
    || kind === "replay_run_end"
    || kind === "replay_playbook_compile"
    || kind === "replay_playbook_promote"
    || kind === "replay_playbook_repair"
    || kind === "replay_playbook_repair_review"
    || kind === "replay_playbook_run"
    || kind === "replay_playbook_dispatch"
  );
}

function isProductLifecycleIdentityKind(kind: IdentityRequestKind): boolean {
  return (
    kind === "activate"
    || kind === "rehydrate"
    || kind === "rehydrate_payload"
    || kind === "feedback"
    || kind === "anchors_suppress"
    || kind === "anchors_unsuppress"
    || kind === "patterns_suppress"
    || kind === "patterns_unsuppress"
  );
}

export function createRequestGuards({
  config,
  embedder,
  recallLimiter,
  debugEmbedLimiter,
  writeLimiter,
  recallTextEmbedLimiter,
  recallInflightGate,
  writeInflightGate,
}: CreateRequestGuardsArgs) {
  const { runtime, governance, limits } = config;
  if (runtime.AIONIS_EDITION === "lite") {
    assertLiteRequestGuardPosture(config);
  } else {
    assertServerRequestGuardPosture(config);
  }

  const authResolver = createAuthResolver({
    mode: governance.MEMORY_AUTH_MODE,
    apiKeysJson: governance.MEMORY_API_KEYS_JSON,
    jwtHs256Secret: governance.MEMORY_JWT_HS256_SECRET,
    jwtClockSkewSec: governance.MEMORY_JWT_CLOCK_SKEW_SEC,
    jwtRequireExp: governance.MEMORY_JWT_REQUIRE_EXP,
  });

  const tenantRecallLimiter = governance.TENANT_QUOTA_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.TENANT_RECALL_RATE_LIMIT_RPS,
        burst: limits.TENANT_RECALL_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const tenantDebugEmbedLimiter = governance.TENANT_QUOTA_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.TENANT_DEBUG_EMBED_RATE_LIMIT_RPS,
        burst: limits.TENANT_DEBUG_EMBED_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const tenantWriteLimiter = governance.TENANT_QUOTA_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.TENANT_WRITE_RATE_LIMIT_RPS,
        burst: limits.TENANT_WRITE_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;
  const tenantRecallTextEmbedLimiter = governance.TENANT_QUOTA_ENABLED
    ? new TokenBucketLimiter({
        rate_per_sec: limits.TENANT_RECALL_TEXT_EMBED_RATE_LIMIT_RPS,
        burst: limits.TENANT_RECALL_TEXT_EMBED_RATE_LIMIT_BURST,
        ttl_ms: limits.RATE_LIMIT_TTL_MS,
        sweep_every_n: 500,
      })
    : null;

  const trustedProxyCidrs = parseTrustedProxyCidrs(runtime.TRUSTED_PROXY_CIDRS);
  const requestClientIp = (req: RequestLike): string => {
    const cached = typeof req.aionis_client_ip === "string" ? req.aionis_client_ip : "";
    if (cached) return cached;
    const ip = runtime.TRUST_PROXY
      ? resolveTrustedClientIp({
          remoteAddress: String(req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress ?? ""),
          headers: req.headers ?? {},
          trustedProxyCidrs,
        })
      : String(req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress ?? req.ip ?? "");
    req.aionis_client_ip = ip;
    return ip;
  };

  const buildRecallAuth = (req: RequestLike, wantDebugEmbeddings: boolean): RecallAuth => {
    if (!wantDebugEmbeddings) return { allow_debug_embeddings: false };

    const headerToken = String(req.headers?.["x-admin-token"] ?? "");
    if (secretTokensEqual(headerToken, governance.ADMIN_TOKEN)) return { allow_debug_embeddings: true };

    const ip = requestClientIp(req);
    if (!governance.ADMIN_TOKEN && runtime.APP_ENV !== "prod" && isLoopbackIp(ip)) return { allow_debug_embeddings: true };

    return { allow_debug_embeddings: false };
  };

  const rateLimitKey = (req: RequestLike, category: string): string => {
    const headerToken = String(req.headers?.["x-admin-token"] ?? "");
    if (secretTokensEqual(headerToken, governance.ADMIN_TOKEN)) {
      return `${category}:admin:${sha256Hex(headerToken).slice(0, 16)}`;
    }
    const ip = requestClientIp(req) || "unknown";
    return `${category}:ip:${ip}`;
  };

  const acquireInflightSlot = async (kind: InflightKind): Promise<InflightGateToken> => {
    const gate = kind === "write" ? writeInflightGate : recallInflightGate;
    try {
      return await gate.acquire();
    } catch (err) {
      if (err instanceof InflightGateError) {
        const code = kind === "write" ? "write_backpressure" : "recall_backpressure";
        throw new HttpError(429, code, `server busy on ${kind}; retry later`, err.details);
      }
      throw err;
    }
  };

  const enforceRateLimit = async (req: RequestLike, reply: ReplyWithHeader, kind: RateLimitKind) => {
    if (!limits.RATE_LIMIT_ENABLED) return;
    const limiter =
      kind === "debug_embeddings"
        ? debugEmbedLimiter
        : kind === "write"
          ? writeLimiter
          : recallLimiter;
    if (!limiter) return;

    const ip = requestClientIp(req);
    if (limits.RATE_LIMIT_BYPASS_LOOPBACK && runtime.APP_ENV !== "prod" && isLoopbackIp(ip)) return;

    const key = rateLimitKey(req, kind);
    let waitedMs = 0;
    let res = limiter.check(key, 1);
    if (!res.allowed && kind === "write" && limits.WRITE_RATE_LIMIT_MAX_WAIT_MS > 0) {
      waitedMs = Math.min(limits.WRITE_RATE_LIMIT_MAX_WAIT_MS, Math.max(1, res.retry_after_ms));
      await sleep(waitedMs);
      res = limiter.check(key, 1);
    }
    if (res.allowed) return;

    reply.header("retry-after", Math.ceil(res.retry_after_ms / 1000));
    const code =
      kind === "debug_embeddings"
        ? "rate_limited_debug_embeddings"
        : kind === "write"
          ? "rate_limited_write"
          : "rate_limited_recall";
    throw new HttpError(429, code, `rate limited (${kind}); retry later`, {
      retry_after_ms: res.retry_after_ms,
      waited_ms: waitedMs,
    });
  };

  const enforceRecallTextEmbedQuota = async (req: RequestLike, reply: ReplyWithHeader, tenantId: string) => {
    if (!embedder) return;
    if (!limits.RATE_LIMIT_ENABLED || !recallTextEmbedLimiter) return;

    const key = rateLimitKey(req, "recall_text_embed");
    let waitedMs = 0;
    let res = recallTextEmbedLimiter.check(key, 1);
    if (!res.allowed && limits.RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS > 0) {
      waitedMs = Math.min(limits.RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS, Math.max(1, res.retry_after_ms));
      await sleep(waitedMs);
      res = recallTextEmbedLimiter.check(key, 1);
    }
    if (res.allowed) return;

    reply.header("retry-after", Math.ceil(res.retry_after_ms / 1000));
    throw new HttpError(429, "rate_limited_recall_text_embed", "recall_text embedding quota exceeded; retry later", {
      retry_after_ms: res.retry_after_ms,
      waited_ms: waitedMs,
    });
  };

  const requireMemoryPrincipal = async (req: RequestLike): Promise<AuthPrincipal | null> => {
    if (governance.MEMORY_AUTH_MODE === "off") return null;
    const principal = authResolver.resolve(req.headers ?? {});
    if (principal) return principal;
    throw new HttpError(401, "unauthorized", "missing or invalid memory credentials", {
      required_header: authResolver.required_header_hint,
    });
  };

  const withIdentityFromRequest = (
    req: RequestLike,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: IdentityRequestKind,
  ): unknown => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    if (kind === "write" || kind === "handoff_store" || kind === "delegation_records_write") {
      assertNoReservedRuntimeWriteClaims(body);
    }
    const obj = { ...(body as Record<string, unknown>) };
    const headerTenantRaw = req.headers?.["x-tenant-id"];
    const headerTenant = firstHeaderValue(headerTenantRaw);
    const bodyTenant = typeof obj.tenant_id === "string" ? obj.tenant_id.trim() : "";

    if (runtime.AIONIS_EDITION === "server" && principal) {
      assertTenantAllowedForPrincipal({ principal, tenantId: headerTenant, source: "x-tenant-id" });
      assertTenantAllowedForPrincipal({ principal, tenantId: bodyTenant, source: "body.tenant_id" });
      assertNoTenantOverrideInSlots({ value: obj, principal });
      const requestedScope = stringField(obj, "scope") || serverDefaultScopeForPrincipal(runtime, principal);
      assertScopeAllowedForPrincipal({ principal, scope: requestedScope });
      obj.tenant_id = principal.tenant_id;
      obj.scope = requestedScope;
      req.aionis_tenant_id = principal.tenant_id;
      req.aionis_scope = requestedScope;

      if (
        kind === "write"
        || kind === "handoff_store"
        || kind === "product_guide"
        || kind === "feedback"
        || kind === "tools_feedback"
        || kind === "resolve"
        || isProductLifecycleIdentityKind(kind)
      ) {
        const principalAgentId = principal.agent_id?.trim() || null;
        const principalTeamId = principal.team_id?.trim() || null;
        const principalActorId = principalAgentId ?? principalTeamId;
        if (!principalActorId) {
          throw new HttpError(
            403,
            "principal_subject_required",
            "an authenticated agent or team identity is required for attributed product operations",
          );
        }
        if (
          kind === "product_guide"
          || kind === "feedback"
          || kind === "tools_feedback"
          || kind === "resolve"
          || isProductLifecycleIdentityKind(kind)
        ) {
          obj.consumer_agent_id = principalActorId;
          if (principalTeamId) obj.consumer_team_id = principalTeamId;
          else delete obj.consumer_team_id;
        }
        if (kind === "product_guide" || kind === "tools_feedback") {
          const contextRecord = asRecord(obj.context);
          if (contextRecord) {
            const agentRecord = asRecord(contextRecord.agent);
            obj.context = {
              ...contextRecord,
              agent_id: principalActorId,
              agent: {
                ...(agentRecord ?? {}),
                id: principalActorId,
              },
            };
          }
        }
        if (kind === "write" || kind === "handoff_store") {
          obj.actor = principalActorId;
          obj.producer_agent_id = principalAgentId ?? principalActorId;
          if (principalAgentId) obj.owner_agent_id = principalAgentId;
          else delete obj.owner_agent_id;
          if (principalTeamId) obj.owner_team_id = principalTeamId;
          else delete obj.owner_team_id;
        }
        if (kind === "feedback" || kind === "tools_feedback") obj.actor = principalActorId;
        if (isProductLifecycleIdentityKind(kind)) {
          obj.actor = principalActorId;
          const payload = asRecord(obj.payload);
          if (payload) {
            const boundPayload: Record<string, unknown> = {
              ...payload,
              tenant_id: principal.tenant_id,
              scope: requestedScope,
              actor: principalActorId,
              consumer_agent_id: principalActorId,
            };
            if (principalTeamId) boundPayload.consumer_team_id = principalTeamId;
            else delete boundPayload.consumer_team_id;
            obj.payload = boundPayload;
          }
        }
      }
    } else {
      if (!bodyTenant && headerTenant) {
        obj.tenant_id = headerTenant;
      }
      if (typeof obj.tenant_id === "string" && obj.tenant_id.trim().length > 0) {
        req.aionis_tenant_id = obj.tenant_id.trim();
      } else if (headerTenant) {
        req.aionis_tenant_id = headerTenant;
      }
      if (typeof obj.scope === "string" && obj.scope.trim().length > 0) {
        req.aionis_scope = obj.scope.trim();
      }
    }

    if (isReplayReadIdentityKind(kind) && !obj.consumer_agent_id) {
      obj.consumer_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
    }

    if (
      (
        kind === "rehydrate_payload"
        || kind === "anchors_suppress"
        || kind === "anchors_unsuppress"
        || kind === "patterns_suppress"
        || kind === "patterns_unsuppress"
      )
      && !obj.actor
    ) {
      obj.actor = runtime.LITE_LOCAL_ACTOR_ID;
    }

    if (kind === "write" || kind === "handoff_store" || isReplayWriteIdentityKind(kind)) {
      if (!obj.actor) obj.actor = runtime.LITE_LOCAL_ACTOR_ID;
      if (!obj.memory_lane) obj.memory_lane = "private";
      if (!obj.producer_agent_id) obj.producer_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
      if (!obj.owner_agent_id && !obj.owner_team_id) obj.owner_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
    }

    if (kind === "delegation_records_write") {
      if (!obj.actor) obj.actor = runtime.LITE_LOCAL_ACTOR_ID;
      if (!obj.memory_lane) obj.memory_lane = "shared";
      if (!obj.producer_agent_id) obj.producer_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
      if (!obj.owner_agent_id && !obj.owner_team_id) obj.owner_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
    }

    if (
      kind === "planning_context"
      || kind === "context_assemble"
      || kind === "execution_context_assemble"
      || kind === "experience_intelligence"
      || kind === "evolution_review_pack"
      || kind === "continuity_review_pack"
      || kind === "delegation_records_find"
      || kind === "delegation_records_aggregate"
    ) {
      if (!obj.consumer_agent_id) obj.consumer_agent_id = runtime.LITE_LOCAL_ACTOR_ID;
    }

    if (kind === "product_guide" || kind === "rules_evaluate" || kind === "tools_select" || kind === "tools_feedback" || kind === "planning_context" || kind === "context_assemble" || kind === "experience_intelligence") {
      const ctxRecord = asRecord(obj.context);
      const ctx = ctxRecord ? { ...ctxRecord } : {};
      const agentRecord = asRecord(ctx.agent);
      const agent = agentRecord ? { ...agentRecord } : {};
      if (!agent.id) agent.id = runtime.LITE_LOCAL_ACTOR_ID;
      if (!ctx.agent_id) ctx.agent_id = runtime.LITE_LOCAL_ACTOR_ID;
      if (Object.keys(agent).length > 0) ctx.agent = agent;
      obj.context = ctx;
    }

    return obj;
  };

  const tenantFromBody = (body: unknown): string => {
    const record = asRecord(body);
    if (record) {
      const tenantId = record.tenant_id;
      if (typeof tenantId === "string" && tenantId.trim().length > 0) return tenantId.trim();
    }
    return runtime.MEMORY_TENANT_ID;
  };

  const scopeFromBody = (body: unknown): string => {
    const record = asRecord(body);
    if (record) {
      const scope = record.scope;
      if (typeof scope === "string" && scope.trim().length > 0) return scope.trim();
    }
    return runtime.MEMORY_SCOPE;
  };

  const projectFromBody = (body: unknown): string | null => {
    const record = asRecord(body);
    if (record) {
      const projectId = record.project_id;
      if (typeof projectId === "string" && projectId.trim().length > 0) return projectId.trim();
    }
    return null;
  };

  const tenantQuotaKey = (kind: string, tenantId: string): string => {
    const normalized = tenantId.trim() || runtime.MEMORY_TENANT_ID;
    return `tenant:${kind}:${normalized}`;
  };

  const enforceTenantLimiter = async (reply: ReplyWithHeader, kind: TenantQuotaKind | "recall_text_embed", tenantId: string) => {
    if (!governance.TENANT_QUOTA_ENABLED) return;
    const limiter =
      kind === "debug_embeddings"
        ? tenantDebugEmbedLimiter
        : kind === "write"
          ? tenantWriteLimiter
          : kind === "recall_text_embed"
            ? tenantRecallTextEmbedLimiter
            : tenantRecallLimiter;
    if (!limiter) return;
    const waitLimitMs =
      kind === "write"
        ? limits.TENANT_WRITE_RATE_LIMIT_MAX_WAIT_MS
        : kind === "recall_text_embed"
          ? limits.TENANT_RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS
          : 0;
    let waitedMs = 0;
    let res = limiter.check(tenantQuotaKey(kind, tenantId), 1);
    if (!res.allowed && waitLimitMs > 0) {
      waitedMs = Math.min(waitLimitMs, Math.max(1, res.retry_after_ms));
      await sleep(waitedMs);
      res = limiter.check(tenantQuotaKey(kind, tenantId), 1);
    }
    if (res.allowed) return;
    reply.header("retry-after", Math.ceil(res.retry_after_ms / 1000));
    throw new HttpError(429, `tenant_quota_exceeded_${kind}`, `tenant quota exceeded (${kind}); retry later`, {
      tenant_id: tenantId.trim() || runtime.MEMORY_TENANT_ID,
      retry_after_ms: res.retry_after_ms,
      waited_ms: waitedMs,
    });
  };

  const originalEnforceRecallTextEmbedQuota = enforceRecallTextEmbedQuota;
  const enforceRecallTextEmbedQuotaWithTenant = async (req: RequestLike, reply: ReplyWithHeader, tenantId: string) => {
    await originalEnforceRecallTextEmbedQuota(req, reply, tenantId);
    await enforceTenantLimiter(reply, "recall_text_embed", tenantId);
  };

  const enforceTenantQuota = async (_req: RequestLike, reply: ReplyWithHeader, kind: TenantQuotaKind, tenantId: string) => {
    await enforceTenantLimiter(reply, kind, tenantId);
  };

  return {
    buildRecallAuth,
    acquireInflightSlot,
    enforceRateLimit,
    enforceRecallTextEmbedQuota: enforceRecallTextEmbedQuotaWithTenant,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    tenantFromBody,
    scopeFromBody,
    projectFromBody,
    enforceTenantQuota,
  };
}
