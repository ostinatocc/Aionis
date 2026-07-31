import type { AionisKernelCapabilityId } from "../kernel/boundary.js";

export type LiteProductEffectId = "history_shaped_future_behavior";

export type LiteRouteCapabilityMatrixEntry = {
  method: "GET" | "POST";
  path: string;
  exposure: LiteRouteProductExposure;
  route_group: string;
  capabilities: readonly AionisKernelCapabilityId[];
  product_effects: readonly LiteProductEffectId[];
  surface_kind: "core_runtime";
  product_role: string;
};

export type LiteRouteProductExposure =
  | "product_entry"
  | "product_support"
  | "internal_evidence"
  | "internal_guidance"
  | "internal_control";

export const LITE_ROUTE_CAPABILITY_MATRIX_VERSION = "lite_route_capability_matrix_v13";

export const LITE_PRODUCT_BOUNDARY = {
  boundary_version: "lite_product_boundary_v1",
  product_claim: "local_authoritative_execution_memory_runtime",
  release_scope: "execution_memory",
  included_surfaces: [
    "lite-daemon",
    "local-sqlite-execution-memory",
    "agent-session-continuity",
    "verifier-bound-completion",
    "memory-recall-and-feedback",
    "forgetting-and-rehydration",
    "runtime-http-api",
  ],
  excluded_surfaces: [
    {
      surface: "cloud-multi-tenant-control-plane",
      reason: "Lite v0.1 is local-first and does not claim hosted multi-tenant production control-plane semantics.",
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
    product_role: "begin or resume execution, record evidence, and remember ordinary memory",
  },
  {
    method: "POST",
    path: "/v1/guide", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "compile authoritative current state and applicable experience",
  },
  {
    method: "POST",
    path: "/v1/forget", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "suppress, supersede, archive, restore, or reactivate memory",
  },
  {
    method: "POST",
    path: "/v1/feedback", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "verify execution outcome and attribute actual memory use",
  },
  {
    method: "POST",
    path: "/v1/rehydrate", exposure: "product_entry",
    route_group: "product-facade",
    capabilities: ["continuity", "forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "resolve deferred evidence or archived memory",
  },
  {
    method: "POST",
    path: "/v1/memory/resolve", exposure: "product_support",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "forgetting"],
    product_effects: [],
    surface_kind: "core_runtime",
    product_role: "resolve exact evidence referenced by Runtime-owned continuation context",
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
      "memory-access-partial",
    ],
    optional_routes: [],
    server_only_route_groups: [],
  };
}
