import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AionisKernelCapabilityId } from "../kernel/boundary.js";
import { buildLiteUnsupportedDetails, HttpError } from "../util/http.js";

export type LiteProductEffectId = "history_shaped_future_behavior";

export type LiteRouteCapabilityMatrixEntry = {
  method: "GET" | "POST";
  path: string;
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

export const LITE_ROUTE_CAPABILITY_MATRIX_VERSION = "lite_route_capability_matrix_v3";

const LITE_PRODUCT_ENTRY_ROUTES = new Set([
  "POST /v1/observe",
  "POST /v1/guide",
  "POST /v1/forget",
  "POST /v1/measure",
]);

const LITE_INTERNAL_GUIDANCE_ROUTES = new Set([
  "POST /v1/memory/action/retrieval",
  "POST /v1/memory/tools/select",
]);

const LITE_INTERNAL_CONTROL_ROUTES = new Set([
  "POST /v1/memory/policies/learning-control/apply",
]);

function routeKey(entry: Pick<LiteRouteCapabilityMatrixEntry, "method" | "path">): string {
  return `${entry.method} ${entry.path}`;
}

function classifyLiteRouteProductExposure(entry: LiteRouteCapabilityMatrixEntry): LiteRouteProductExposure {
  const key = routeKey(entry);
  if (LITE_PRODUCT_ENTRY_ROUTES.has(key)) return "product_entry";
  if (LITE_INTERNAL_GUIDANCE_ROUTES.has(key)) return "internal_guidance";
  if (LITE_INTERNAL_CONTROL_ROUTES.has(key)) return "internal_control";
  if (entry.surface_kind === "operator_review" || entry.surface_kind === "operator_debug") return "operator_support";
  if (entry.route_group.startsWith("memory-replay")) return "internal_evidence";
  if (
    entry.path === "/v1/memory/trajectory/compile" ||
    entry.path === "/v1/memory/feedback" ||
    entry.path === "/v1/memory/tools/decision" ||
    entry.path === "/v1/memory/tools/run" ||
    entry.path === "/v1/memory/tools/feedback" ||
    entry.path.startsWith("/v1/memory/learning-loop/") ||
    entry.path.startsWith("/v1/memory/runtime-maintenance/") ||
    entry.path === "/v1/memory/tools/rehydrate_payload"
  ) {
    return "internal_evidence";
  }
  return "product_support";
}

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
    path: "/v1/observe",
    route_group: "product-facade",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for writing memory, execution evidence, and resumable handoff state",
  },
  {
    method: "POST",
    path: "/v1/guide",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for compact MemoryPacket and GuidePacket output",
  },
  {
    method: "POST",
    path: "/v1/forget",
    route_group: "product-facade",
    capabilities: ["forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for suppression, activation, archive rehydration, and payload rehydration",
  },
  {
    method: "POST",
    path: "/v1/measure",
    route_group: "product-facade",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "product facade for measuring whether history positively shaped future behavior",
  },
  {
    method: "GET",
    path: "/v1/runtime/boundary-inventory",
    route_group: "runtime-boundary-inventory",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_debug",
    product_role: "read-only boundary audit for authority and Runtime surface ownership",
  },
  {
    method: "POST",
    path: "/v1/memory/write",
    route_group: "memory-write",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "persist execution evidence, continuity carriers, and learning candidates",
  },
  {
    method: "POST",
    path: "/v1/handoff/store",
    route_group: "memory-handoff",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "store resumable execution state and project workflow evidence",
  },
  {
    method: "POST",
    path: "/v1/handoff/recover",
    route_group: "memory-handoff",
    capabilities: ["continuity"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "recover resumable execution state for a later agent run",
  },
  {
    method: "POST",
    path: "/v1/memory/archive/rehydrate",
    route_group: "memory-lifecycle-lite",
    capabilities: ["forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "rehydrate archived memory through learning-control lifecycle state",
  },
  {
    method: "POST",
    path: "/v1/memory/nodes/activate",
    route_group: "memory-lifecycle-lite",
    capabilities: ["forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "record activation feedback so useful memory stays warm",
  },
  {
    method: "POST",
    path: "/v1/memory/recall",
    route_group: "memory-recall",
    capabilities: ["continuity", "forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "retrieve scoped memory with lifecycle, trust, and compaction policy",
  },
  {
    method: "POST",
    path: "/v1/memory/recall_text",
    route_group: "memory-context-runtime",
    capabilities: ["continuity", "forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "embed text recall into the same lifecycle-aware recall path",
  },
  {
    method: "POST",
    path: "/v1/memory/planning/context",
    route_group: "memory-context-runtime",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "assemble the agent-facing planning packet from continuity, recall, learning, and authority signals",
  },
  {
    method: "POST",
    path: "/v1/memory/context/assemble",
    route_group: "memory-context-runtime",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "assemble internal context evidence behind the product guide facade",
  },
  {
    method: "POST",
    path: "/v1/memory/trajectory/compile",
    route_group: "memory-access-partial",
    capabilities: ["continuity"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "compile execution trajectory evidence into resumable continuity signals",
  },
  {
    method: "POST",
    path: "/v1/memory/delegation/records",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "persist delegation evidence that can affect future collaboration context",
  },
  {
    method: "POST",
    path: "/v1/memory/delegation/records/find",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "read prior delegation evidence for continuity and learning review",
  },
  {
    method: "POST",
    path: "/v1/memory/delegation/records/aggregate",
    route_group: "memory-access-partial",
    capabilities: ["learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "aggregate delegation experience into learning signals",
  },
  {
    method: "POST",
    path: "/v1/memory/find",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "forgetting"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "inspect scoped memory without creating authority",
  },
  {
    method: "POST",
    path: "/v1/memory/continuity/review-pack",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "review continuity evidence, rollback requirements, and next execution anchors",
  },
  {
    method: "POST",
    path: "/v1/memory/agent/inspect",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "inspect the combined agent memory state without granting new authority",
  },
  {
    method: "POST",
    path: "/v1/memory/agent/review-pack",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "summarize reviewable memory state for safe agent continuation",
  },
  {
    method: "POST",
    path: "/v1/memory/agent/resume-pack",
    route_group: "memory-access-partial",
    capabilities: ["continuity"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "produce a resumable agent packet from prior execution state",
  },
  {
    method: "POST",
    path: "/v1/memory/agent/handoff-pack",
    route_group: "memory-access-partial",
    capabilities: ["continuity"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "produce a handoff packet for transfer between agent runs",
  },
  {
    method: "POST",
    path: "/v1/memory/execution/introspect",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "inspect execution memory, workflow authority, and policy state",
  },
  {
    method: "POST",
    path: "/v1/memory/evolution/review-pack",
    route_group: "memory-access-partial",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "review learning evolution candidates and authority posture",
  },
  {
    method: "POST",
    path: "/v1/memory/action/retrieval",
    route_group: "memory-access-partial",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "retrieve reusable action memory while keeping candidate authority visible",
  },
  {
    method: "POST",
    path: "/v1/memory/experience/intelligence",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "summarize how prior experience should shape the next run",
  },
  {
    method: "POST",
    path: "/v1/memory/resolve",
    route_group: "memory-access-partial",
    capabilities: ["continuity", "forgetting"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "resolve memory nodes, edges, commits, or decisions for inspection",
  },
  {
    method: "POST",
    path: "/v1/memory/anchors/rehydrate_payload",
    route_group: "memory-access-partial",
    capabilities: ["forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "rehydrate anchor payloads that forgetting lifecycle kept out of default context",
  },
  {
    method: "POST",
    path: "/v1/memory/feedback",
    route_group: "memory-feedback-tools",
    capabilities: ["learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "record outcome feedback for future learning decisions",
  },
  {
    method: "POST",
    path: "/v1/memory/rules/state",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "learning_control"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "inspect scoped rule state without widening authority",
  },
  {
    method: "POST",
    path: "/v1/memory/rules/evaluate",
    route_group: "memory-feedback-tools",
    capabilities: ["learning_control"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "evaluate scoped rules as advisory Runtime evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/select",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "select tools from learned patterns while preserving trust boundaries",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/decision",
    route_group: "memory-feedback-tools",
    capabilities: ["learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "persist tool decision evidence for later feedback and learning",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/run",
    route_group: "memory-feedback-tools",
    capabilities: ["learning"],
    product_effects: [],
    surface_kind: "core_runtime",
    product_role: "record tool run evidence without granting policy authority",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/runs/list",
    route_group: "memory-feedback-tools",
    capabilities: ["learning"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "inspect recorded tool runs for learning review",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/feedback",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "turn tool feedback into learning-control learning candidates",
  },
  {
    method: "POST",
    path: "/v1/memory/learning-loop/run",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run the evidence-gated learning and forgetting loop",
  },
  {
    method: "POST",
    path: "/v1/memory/runtime-maintenance/run",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run maintenance over learning, forgetting, and authority state",
  },
  {
    method: "POST",
    path: "/v1/memory/runtime-maintenance/immediate",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run immediate maintenance profile over Runtime memory state",
  },
  {
    method: "POST",
    path: "/v1/memory/runtime-maintenance/daily",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run daily maintenance profile over Runtime memory state",
  },
  {
    method: "POST",
    path: "/v1/memory/runtime-maintenance/long-horizon",
    route_group: "memory-feedback-tools",
    capabilities: ["learning", "forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run long-horizon maintenance profile over Runtime memory state",
  },
  {
    method: "POST",
    path: "/v1/memory/policies/learning-control/apply",
    route_group: "memory-feedback-tools",
    capabilities: ["learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "apply learning-control lifecycle changes to policy memory",
  },
  {
    method: "POST",
    path: "/v1/memory/patterns/suppress",
    route_group: "memory-feedback-tools",
    capabilities: ["forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "suppress learned patterns without deleting their evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/patterns/unsuppress",
    route_group: "memory-feedback-tools",
    capabilities: ["forgetting", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "reactivate suppressed pattern memory under lifecycle control",
  },
  {
    method: "POST",
    path: "/v1/memory/tools/rehydrate_payload",
    route_group: "memory-feedback-tools",
    capabilities: ["forgetting"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "execute the rehydrate-payload tool hint emitted by recall",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/run/start",
    route_group: "memory-replay-core",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "start a replay run that can become reusable execution evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/step/before",
    route_group: "memory-replay-core",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "record pre-step replay evidence before tool execution",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/step/after",
    route_group: "memory-replay-core",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "record post-step replay outcome evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/run/end",
    route_group: "memory-replay-core",
    capabilities: ["continuity", "learning"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "finish a replay run and summarize its learning evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/runs/get",
    route_group: "memory-replay-core",
    capabilities: ["continuity", "learning"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "inspect replay run evidence for learning review",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/compile_from_run",
    route_group: "memory-replay-core",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "compile successful replay evidence into a learning-control playbook candidate",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/get",
    route_group: "memory-replay-core",
    capabilities: ["learning"],
    product_effects: [],
    surface_kind: "operator_review",
    product_role: "inspect replay playbook memory",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/candidate",
    route_group: "memory-replay-core",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "materialize a learning-control playbook candidate",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/promote",
    route_group: "memory-replay-core",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "promote playbook memory only through learning-control evidence",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/repair",
    route_group: "memory-replay-core",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "record playbook repair evidence without becoming a semantic repair engine",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/repair/review",
    route_group: "memory-replay-learning-control-partial",
    capabilities: ["learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "operator_review",
    product_role: "review playbook repair through learning-control before mutation",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/run",
    route_group: "memory-replay-learning-control-partial",
    capabilities: ["continuity", "learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "run a playbook through the learning-control replay path",
  },
  {
    method: "POST",
    path: "/v1/memory/replay/playbooks/dispatch",
    route_group: "memory-replay-learning-control-partial",
    capabilities: ["continuity", "learning", "learning_control"],
    product_effects: ["history_shaped_future_behavior"],
    surface_kind: "core_runtime",
    product_role: "dispatch a learning-control playbook run request",
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
    route_capability_matrix: LITE_ROUTE_CAPABILITY_MATRIX.map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities],
      product_effects: [...entry.product_effects],
      product_exposure: classifyLiteRouteProductExposure(entry),
    })),
    kernel_required_routes: [
      "product-facade",
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
    });
  };

  for (const { prefixes } of Object.values(LITE_SERVER_ONLY_ROUTE_GROUPS)) {
    for (const prefix of prefixes) {
      app.all(prefix, handler);
    }
  }
}
