import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildLiteUnsupportedDetails, HttpError } from "../util/http.js";

export const LITE_SERVER_ONLY_ROUTE_GROUPS = {
  admin_control: {
    prefixes: ["/v1/admin/control", "/v1/admin/control/*"],
    reason: "admin control routes are unavailable in lite edition",
  },
} as const;

export const LITE_PRODUCT_BOUNDARY = {
  boundary_version: "lite_product_boundary_v1",
  product_claim: "local_first_execution_memory_runtime",
  release_scope: "v0.1_rc",
  included_surfaces: [
    "lite-daemon",
    "local-sqlite-memory-stores",
    "execution-memory-kernel",
    "contract-compiler",
    "trust-gate",
    "orchestrator-read-surfaces",
    "learning-loop-projections",
    "semantic-forgetting-and-rehydration",
    "replay-and-playbook-kernel",
    "sdk-and-host-bridge",
  ],
  excluded_surfaces: [
    {
      surface: "cloud-multi-tenant-control-plane",
      reason: "Lite v0.1 is local-first and does not claim hosted multi-tenant production control-plane semantics.",
    },
    {
      surface: "server-admin-control-routes",
      reason: "Admin/control routes remain server-only and return structured server_only_in_lite errors.",
    },
    {
      surface: "production-auth-and-tenant-quota",
      reason: "Lite v0.1 intentionally runs MEMORY_AUTH_MODE=off and TENANT_QUOTA_ENABLED=false behind loopback defaults.",
    },
  ],
} as const;

export function buildLiteProductBoundary() {
  return {
    ...LITE_PRODUCT_BOUNDARY,
    included_surfaces: [...LITE_PRODUCT_BOUNDARY.included_surfaces],
    excluded_surfaces: LITE_PRODUCT_BOUNDARY.excluded_surfaces.map((entry) => ({ ...entry })),
  };
}

export function buildLiteRouteMatrix() {
  return {
    product_boundary: buildLiteProductBoundary(),
    kernel_required_routes: [
      "memory-write",
      "memory-handoff",
      "memory-recall",
      "memory-context-runtime",
      "memory-access-partial",
      "memory-replay-core",
      "memory-feedback-tools",
    ],
    optional_routes: [
      "runtime-boundary-inventory",
      "memory-lifecycle-lite",
      "memory-replay-learning-control-partial",
    ],
    server_only_route_groups: Object.entries(LITE_SERVER_ONLY_ROUTE_GROUPS).map(([group, value]) => ({
      group,
      prefixes: value.prefixes,
      reason: value.reason,
    })),
  };
}

export function registerLiteServerOnlyRoutes(app: FastifyInstance) {
  const handler = async (req: FastifyRequest) => {
    const path = String(req.url ?? req.routeOptions?.url ?? "");
    const matchedGroup = Object.entries(LITE_SERVER_ONLY_ROUTE_GROUPS).find(([, value]) =>
      value.prefixes.some((prefix) => {
        const normalized = prefix.endsWith("/*") ? prefix.slice(0, -2) : prefix;
        return path === normalized || path.startsWith(`${normalized}/`);
      }),
    );
    const group = matchedGroup?.[0] ?? "server_only";
    const reason = matchedGroup?.[1].reason ?? "route is unavailable in lite edition";
    throw new HttpError(501, "server_only_in_lite", reason, {
      ...buildLiteUnsupportedDetails({
        route: path,
        surface: "server_only_route_group",
        routeGroup: group,
        reason,
      }),
      fallback_applied: false,
    });
  };

  for (const { prefixes } of Object.values(LITE_SERVER_ONLY_ROUTE_GROUPS)) {
    for (const prefix of prefixes) {
      app.all(prefix, handler);
    }
  }
}
