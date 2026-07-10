import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AionisKernelCapabilityId } from "../kernel/boundary.js";
import { buildLiteUnsupportedDetails, HttpError } from "../util/http.js";

export type LiteProductEffectId = "history_shaped_future_behavior";

export type LiteRouteCapabilityMatrixEntry = {
  method: "GET" | "POST";
  path: string;
  exposure: LiteRouteProductExposure;
  route_group: string;
  capabilities: readonly AionisKernelCapabilityId[];
  product_effects: readonly LiteProductEffectId[];
  surface_kind: "core_runtime" | "operator_review" | "operator_debug";
  product_role: string;
};

export type LiteRouteProductExposure =
  | "product_entry"
  | "product_support"
  | "internal_evidence"
  | "internal_guidance"
  | "internal_control"
  | "operator_support";

export const LITE_ROUTE_CAPABILITY_MATRIX_VERSION = "lite_route_capability_matrix_v10";

export const LITE_SERVER_ONLY_ROUTE_GROUPS = {
  admin_control: {
    prefixes: ["/v1/admin/control", "/v1/admin/control/*"],
    reason: "admin control routes are unavailable in lite edition",
  },
} as const;

export const LITE_PRODUCT_BOUNDARY = {
  boundary_version: "lite_product_boundary_v1",
  product_claim: "local_first_cognitive_memory_execution_learning_runtime",
  release_scope: "v0.1_rc",
  included_surfaces: [
    "lite-daemon",
    "local-sqlite-memory-stores",
    "cognitive-memory-recall",
    "execution-memory-kernel",
    "contract-compiler",
    "trust-gate",
    "orchestrator-read-surfaces",
    "learning-loop-projections",
    "semantic-forgetting-and-rehydration",
    "replay-and-playbook-kernel",
    "runtime-http-api",
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

export const LITE_ROUTE_CAPABILITY_MATRIX = [
  {
    method: "POST",
    path: "/v1/observe", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for writing memory, execution evidence, and resumable handoff state",
  },
  {
    method: "POST",
    path: "/v1/guide", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for compact MemoryPacket and GuidePacket output",
  },
  {
    method: "POST",
    path: "/v1/forget", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "advanced product facade for explicit lifecycle suppression, activation, archive rehydration, and payload rehydration",
  },
  {
    method: "POST",
    path: "/v1/feedback", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for attributing run outcomes to memory actually exposed by guide",
  },
  {
    method: "POST",
    path: "/v1/rehydrate", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for expanding archived memory or anchor payload on demand",
  },
  {
    method: "POST",
    path: "/v1/measure", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for measuring whether history positively shaped future behavior",
  },
  {
    method: "GET",
    path: "/v1/skills/candidates", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "read-only review queue for trace-derived skill candidates projected from measured execution traces",
  },
  {
    method: "POST",
    path: "/v1/skills/candidates", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "queues trace-derived skill candidates from effect reports without prompt injection or memory mutation",
  },
  {
    method: "POST",
    path: "/v1/skills/candidates/:id/promote", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "records operator promotion review for a trace-derived skill candidate without mutating memory authority",
  },
  {
    method: "POST",
    path: "/v1/skills/candidates/:id/reject", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "records operator rejection review for a trace-derived skill candidate without mutating memory authority",
  },
  {
    method: "POST",
    path: "/v1/skills/candidates/:id/materialize", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "materializes a promoted trace-derived skill candidate into a procedure memory draft and recommended observe payload without mutating memory",
  },
  {
    method: "POST",
    path: "/v1/operator/snapshot", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "read-only operator snapshot summarizing active paths, failed branches, guide attribution, learning-control posture, and measured effect",
  },
  {
    method: "GET",
    path: "/v1/operator/authority-effect-audit", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_debug",
    product_role: "read-only audit of authority effect broker receipts, gate hashes, key ids, and claim paths",
  },
  {
    method: "POST",
    path: "/v1/debug/memory-decision-trace", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_debug",
    product_role: "read-only debug trace explaining memory lifecycle, authority, and agent-context surface decisions",
  },
  {
    method: "POST",
    path: "/v1/audit/memory-decision-report", exposure: "operator_support",
    route_group: "product-facade",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_debug",
    product_role: "read-only audit report summarizing why memory was used, inspected, blocked, or rehydrated",
  },
  {
    method: "GET",
    path: "/v1/runtime/boundary-inventory", exposure: "operator_support",
    route_group: "runtime-boundary-inventory",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_debug",
    product_role: "read-only boundary audit for authority and Runtime surface ownership",
  },
  {
    method: "POST",
    path: "/v1/handoff/store", exposure: "product_support",
    route_group: "memory-handoff",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "store resumable execution state and project workflow evidence",
  },
  {
    method: "POST",
    path: "/v1/handoff/recover", exposure: "product_support",
    route_group: "memory-handoff",
    capabilities: ["continuity"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "recover resumable execution state for a later agent run",
  },
  {
    method: "POST",
    path: "/v1/memory/resolve", exposure: "product_support",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "forgetting"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "resolve memory nodes, edges, commits, or decisions for inspection",
  },
] as const satisfies readonly LiteRouteCapabilityMatrixEntry[];

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
    route_capability_matrix_version: LITE_ROUTE_CAPABILITY_MATRIX_VERSION,
    route_capability_matrix: LITE_ROUTE_CAPABILITY_MATRIX.map(({ exposure, ...entry }) => ({
      ...entry,
      capabilities: [...entry.capabilities],
      product_effects: [...entry.product_effects],
      product_exposure: exposure,
    })),
    kernel_required_routes: [
      "product-facade",
      "memory-handoff",
      "memory-access-partial",
    ],
    optional_routes: [
      "runtime-boundary-inventory",
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
    });
  };

  for (const { prefixes } of Object.values(LITE_SERVER_ONLY_ROUTE_GROUPS)) {
    for (const prefix of prefixes) {
      app.all(prefix, handler);
    }
  }
}
