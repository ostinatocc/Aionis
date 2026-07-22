/**
 * The complete public HTTP surface of Continuation Runtime V1.
 *
 * Route registration, architecture checks, SDK generation, and documentation
 * must consume this value directly. Prefix scans and hand-maintained secondary
 * matrices are forbidden: they were the source of the legacy route-governance
 * blind spot.
 */
export const CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES = Object.freeze([
  Object.freeze({
    method: "POST",
    path: "/v1/observations",
    route_id: "record_observations",
    principal_kind: "trusted_host",
  }),
  Object.freeze({
    method: "POST",
    path: "/v1/continuations",
    route_id: "create_continuation",
    principal_kind: "trusted_host",
  }),
  Object.freeze({
    method: "POST",
    path: "/v1/outcomes",
    route_id: "record_outcome",
    principal_kind: "trusted_host",
  }),
  Object.freeze({
    method: "POST",
    path: "/v1/authority-decisions",
    route_id: "authority_decision",
    principal_kind: "operator",
  }),
  Object.freeze({
    method: "GET",
    path: "/v1/decisions/:decision_id",
    route_id: "read_decision",
    principal_kind: "trusted_host_or_operator",
  }),
] as const);

export type ContinuationRuntimeV1PublicRoute =
  typeof CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES[number];
export type ContinuationRuntimeV1PublicRouteId =
  ContinuationRuntimeV1PublicRoute["route_id"];

export const CONTINUATION_RUNTIME_V1_PROBE_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/healthz", route_id: "health" }),
  Object.freeze({ method: "GET", path: "/readyz", route_id: "readiness" }),
] as const);

export type ContinuationRuntimeV1HttpHandlerId =
  | ContinuationRuntimeV1PublicRouteId
  | typeof CONTINUATION_RUNTIME_V1_PROBE_ROUTES[number]["route_id"];

export const CONTINUATION_RUNTIME_V1_ROUTE_KEYS = Object.freeze([
  ...CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  ...CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
].map((route) => `${route.method} ${route.path}`));

if (new Set(CONTINUATION_RUNTIME_V1_ROUTE_KEYS).size
    !== CONTINUATION_RUNTIME_V1_ROUTE_KEYS.length) {
  throw new Error("continuation_runtime_v1_http_surface_contains_duplicate_route");
}
