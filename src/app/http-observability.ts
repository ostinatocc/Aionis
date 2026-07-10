import type { RuntimeConfig } from "../config/runtime-config.js";

type CorsPolicy = {
  allow_origins: string[];
  allow_methods: string;
  allow_headers: string;
  expose_headers: string;
};

type ContextAssemblyEndpoint = "planning_context" | "context_assemble";

type ContextAssemblyLayerTelemetryRow = {
  layer_name: "facts" | "episodes" | "rules" | "decisions" | "tools" | "citations";
  source_count: number;
  kept_count: number;
  dropped_count: number;
  budget_chars: number;
  used_chars: number;
  max_items: number;
};

type LoggerLike = {
  debug?: (payload: unknown, message?: string) => unknown;
};

type HttpRequestLike = {
  routeOptions?: { url?: string | null } | null;
  routerPath?: string | null;
  url?: string | null;
  method?: string | null;
  headers?: Record<string, unknown>;
  body?: unknown;
  id?: string | number;
  log?: LoggerLike;
  aionis_scope?: string;
  aionis_tenant_id?: string;
  aionis_api_key_prefix?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function routePath(req: HttpRequestLike): string {
  const raw = String(req.routeOptions?.url ?? req.routerPath ?? req.url ?? "");
  return raw.split("?")[0] ?? raw;
}

function requestHeader(req: HttpRequestLike, name: string): string | null {
  const raw = req.headers?.[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") return raw[0];
  return null;
}

function parseNonNegativeNumber(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function collectLayeredContextTelemetryRows(layeredContext: unknown): ContextAssemblyLayerTelemetryRow[] {
  const layered = asRecord(layeredContext);
  const layers = asRecord(layered?.layers);
  if (!layers) return [];
  const validLayers = ["facts", "episodes", "rules", "decisions", "tools", "citations"] as const;
  const out: ContextAssemblyLayerTelemetryRow[] = [];
  for (const layerName of validLayers) {
    const layer = asRecord(layers[layerName]);
    if (!layer) continue;
    out.push({
      layer_name: layerName,
      source_count: parseNonNegativeNumber(layer.source_count),
      kept_count: parseNonNegativeNumber(layer.kept_count),
      dropped_count: parseNonNegativeNumber(layer.dropped_count),
      budget_chars: parseNonNegativeNumber(layer.budget_chars),
      used_chars: parseNonNegativeNumber(layer.used_chars),
      max_items: parseNonNegativeNumber(layer.max_items),
    });
  }
  return out;
}

export function createHttpObservabilityHelpers(args: {
  config: Pick<RuntimeConfig, "runtime">;
}) {
  const { runtime } = args.config;

  const corsMemoryAllowOrigins = runtime.cors.memoryAllowOrigins;
  const corsAdminAllowOrigins = runtime.cors.adminAllowOrigins;
  const corsMemoryAllowHeaders = "content-type,x-api-key,x-tenant-id,authorization,x-request-id";
  const corsMemoryAllowMethods = "GET,POST,OPTIONS";
  const corsAdminAllowHeaders = "content-type,authorization,x-admin-token,x-request-id";
  const corsAdminAllowMethods = "GET,POST,PUT,DELETE,OPTIONS";
  const corsAdminRouteMethods = new Set(["GET", "POST", "PUT", "DELETE"]);

  function resolveCorsAllowOrigin(origin: string | null, allowOrigins: string[]): string | null {
    if (allowOrigins.includes("*")) return "*";
    if (!origin) return null;
    return allowOrigins.includes(origin) ? origin : null;
  }

  function resolveCorsPolicy(req: HttpRequestLike): CorsPolicy | null {
    const path = routePath(req);
    const method = String(req.method ?? "").toUpperCase();
    const preflightMethod = String(requestHeader(req, "access-control-request-method") ?? "").trim().toUpperCase();

    if (path.startsWith("/v1/memory/") || path.startsWith("/v1/handoff/")) {
      const isMemoryCorsMethod = method === "POST" || (method === "OPTIONS" && preflightMethod === "POST");
      if (!isMemoryCorsMethod) return null;
      return {
        allow_origins: [...corsMemoryAllowOrigins],
        allow_methods: corsMemoryAllowMethods,
        allow_headers: corsMemoryAllowHeaders,
        expose_headers: "x-request-id",
      };
    }

    if (path.startsWith("/v1/admin/")) {
      if (corsAdminAllowOrigins.length === 0) return null;
      const isAdminCorsMethod = corsAdminRouteMethods.has(method);
      const isAdminPreflight = method === "OPTIONS" && corsAdminRouteMethods.has(preflightMethod);
      if (!isAdminCorsMethod && !isAdminPreflight) return null;
      return {
        allow_origins: [...corsAdminAllowOrigins],
        allow_methods: corsAdminAllowMethods,
        allow_headers: corsAdminAllowHeaders,
        expose_headers: "x-request-id",
      };
    }

    return null;
  }

  function resolveRequestScopeForTelemetry(req: HttpRequestLike): string {
    if (typeof req.aionis_scope === "string" && req.aionis_scope.trim().length > 0) return req.aionis_scope.trim();
    const body = asRecord(req.body);
    if (body) {
      const s = body.scope;
      if (typeof s === "string" && s.trim().length > 0) return s.trim();
    }
    return runtime.MEMORY_SCOPE;
  }

  function resolveRequestTenantForTelemetry(req: HttpRequestLike): string {
    if (typeof req.aionis_tenant_id === "string" && req.aionis_tenant_id.trim().length > 0) return req.aionis_tenant_id.trim();
    const body = asRecord(req.body);
    if (body) {
      const t = body.tenant_id;
      if (typeof t === "string" && t.trim().length > 0) return t.trim();
    }
    const headerTenant = typeof req.headers?.["x-tenant-id"] === "string" ? String(req.headers["x-tenant-id"]).trim() : "";
    if (headerTenant) return headerTenant;
    return runtime.MEMORY_TENANT_ID;
  }

  function resolveRequestApiKeyPrefixForTelemetry(req: HttpRequestLike): string | null {
    const tagged = req.aionis_api_key_prefix;
    if (typeof tagged === "string" && tagged.trim().length > 0) return tagged.trim();
    return null;
  }

  async function recordContextAssemblyTelemetryBestEffort(args: {
    req: HttpRequestLike;
    tenant_id: string;
    scope: string;
    endpoint: ContextAssemblyEndpoint;
    latency_ms: number;
    layered_output: boolean;
    layered_context: unknown;
    selected_memory_layers?: string[];
    selection_policy?: {
      name?: string | null;
      source?: string | null;
      trust_anchor_layers?: string[];
      requested_allowed_layers?: string[];
    } | null;
  }) {
    const isLayeredOutput = args.layered_output === true;
    const layerRows = isLayeredOutput ? collectLayeredContextTelemetryRows(args.layered_context) : [];
    const layeredContext = asRecord(args.layered_context);
    const budget = asRecord(layeredContext?.budget);
    const stats = asRecord(layeredContext?.stats);
    const event = {
      tenant_id: args.tenant_id,
      scope: args.scope,
      endpoint: args.endpoint,
      layered_output: isLayeredOutput,
      latency_ms: parseNonNegativeNumber(args.latency_ms),
      request_id: String(args.req.id ?? ""),
      total_budget_chars: isLayeredOutput ? parseNonNegativeNumber(budget?.total_chars) : 0,
      used_chars: isLayeredOutput ? parseNonNegativeNumber(budget?.used_chars) : 0,
      remaining_chars: isLayeredOutput ? parseNonNegativeNumber(budget?.remaining_chars) : 0,
      source_items: isLayeredOutput ? parseNonNegativeNumber(stats?.source_items) : 0,
      kept_items: isLayeredOutput ? parseNonNegativeNumber(stats?.kept_items) : 0,
      dropped_items: isLayeredOutput ? parseNonNegativeNumber(stats?.dropped_items) : 0,
      layers_with_content: isLayeredOutput ? parseNonNegativeNumber(stats?.layers_with_content) : 0,
      merge_trace_included: isLayeredOutput ? Array.isArray(layeredContext?.merge_trace) : false,
      selection_policy_name:
        args.selection_policy && typeof args.selection_policy.name === "string" ? args.selection_policy.name : null,
      selection_policy_source:
        args.selection_policy && typeof args.selection_policy.source === "string" ? args.selection_policy.source : null,
      selected_memory_layers: Array.isArray(args.selected_memory_layers)
        ? args.selected_memory_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : [],
      trust_anchor_layers:
        args.selection_policy && Array.isArray(args.selection_policy.trust_anchor_layers)
          ? args.selection_policy.trust_anchor_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : [],
      requested_allowed_layers:
        args.selection_policy && Array.isArray(args.selection_policy.requested_allowed_layers)
          ? args.selection_policy.requested_allowed_layers.map((entry) => String(entry ?? "").trim()).filter(Boolean)
          : [],
      layers: layerRows,
    };
    const logger = args.req.log;
    if (logger && typeof logger.debug === "function") {
      logger.debug({ context_assembly: event }, "context assembly telemetry");
    }
  }

  return {
    corsMemoryAllowOrigins,
    corsAdminAllowOrigins,
    resolveCorsAllowOrigin,
    resolveCorsPolicy,
    resolveRequestScopeForTelemetry,
    resolveRequestTenantForTelemetry,
    resolveRequestApiKeyPrefixForTelemetry,
    recordContextAssemblyTelemetryBestEffort,
  };
}
