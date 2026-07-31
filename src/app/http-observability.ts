import type { RuntimeConfig } from "../config/runtime-config.js";

type CorsPolicy = {
  allow_origins: string[];
  allow_methods: string;
  allow_headers: string;
  expose_headers: string;
};

type HttpRequestLike = {
  routeOptions?: { url?: string | null } | null;
  routerPath?: string | null;
  url?: string | null;
  method?: string | null;
  headers?: Record<string, unknown>;
};

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

    if (path.startsWith("/v1/") && !path.startsWith("/v1/admin/")) {
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

  return {
    corsMemoryAllowOrigins,
    corsAdminAllowOrigins,
    resolveCorsAllowOrigin,
    resolveCorsPolicy,
  };
}
