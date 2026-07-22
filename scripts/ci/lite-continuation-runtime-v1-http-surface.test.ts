import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
  CONTINUATION_RUNTIME_V1_ROUTE_KEYS,
} from "../../src/runtime-v1/http-surface.js";

test("V1 has one exact five-route product surface and two unauthenticated probes", () => {
  assert.deepEqual(CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES, [
    { method: "POST", path: "/v1/observations", route_id: "record_observations",
      principal_kind: "trusted_host" },
    { method: "POST", path: "/v1/continuations", route_id: "create_continuation",
      principal_kind: "trusted_host" },
    { method: "POST", path: "/v1/outcomes", route_id: "record_outcome",
      principal_kind: "trusted_host" },
    { method: "POST", path: "/v1/authority-decisions", route_id: "authority_decision",
      principal_kind: "operator" },
    { method: "GET", path: "/v1/decisions/:decision_id", route_id: "read_decision",
      principal_kind: "trusted_host_or_operator" },
  ]);
  assert.deepEqual(CONTINUATION_RUNTIME_V1_PROBE_ROUTES, [
    { method: "GET", path: "/healthz", route_id: "health" },
    { method: "GET", path: "/readyz", route_id: "readiness" },
  ]);
  assert.equal(CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES.length, 5);
  assert.equal(CONTINUATION_RUNTIME_V1_ROUTE_KEYS.length, 7);
  assert.equal(new Set(CONTINUATION_RUNTIME_V1_ROUTE_KEYS).size, 7);
});

test("offline provisioning and worker completion can never become HTTP routes", () => {
  const serialized = JSON.stringify(CONTINUATION_RUNTIME_V1_ROUTE_KEYS);
  for (const forbidden of [
    "provision",
    "worker",
    "/v1/observe",
    "/v1/guide",
    "/v1/feedback",
    "/v1/measure",
    "/v1/operator",
    "/v1/debug",
    "/v1/audit",
    "/v1/handoff",
    "/v1/memory",
    "/v1/skills",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("the surface is recursively immutable at module load", () => {
  assert.equal(Object.isFrozen(CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES), true);
  assert.equal(Object.isFrozen(CONTINUATION_RUNTIME_V1_PROBE_ROUTES), true);
  assert.equal(Object.isFrozen(CONTINUATION_RUNTIME_V1_ROUTE_KEYS), true);
  for (const route of [
    ...CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
    ...CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  ]) assert.equal(Object.isFrozen(route), true);
});
