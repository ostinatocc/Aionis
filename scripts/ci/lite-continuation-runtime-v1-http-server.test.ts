import assert from "node:assert/strict";
import test from "node:test";

import {
  createContinuationRuntimeV1HttpServer,
  type ContinuationRuntimeV1HttpHandlerId,
} from "../../src/runtime-v1/http-server.js";
import {
  CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
} from "../../src/runtime-v1/http-surface.js";

const routes = [
  ...CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  ...CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
] as const;

function handlers() {
  return Object.fromEntries(routes.map((route) => [
    route.route_id,
    async () => ({ route_id: route.route_id }),
  ])) as Record<ContinuationRuntimeV1HttpHandlerId, () => Promise<unknown>>;
}

function concretePath(path: string): string {
  return path.replace(":decision_id", "decision-a");
}

test("real Fastify registration is exactly five public routes plus two probes", async () => {
  const server = createContinuationRuntimeV1HttpServer({
    bodyLimitBytes: 1_048_576,
    handlers: handlers(),
  });
  try {
    await server.ready();
    for (const route of routes) {
      const response = await server.inject({
        method: route.method,
        url: concretePath(route.path),
        payload: route.method === "POST" ? {} : undefined,
      });
      assert.equal(response.statusCode, 200, `${route.method} ${route.path}`);
      assert.deepEqual(response.json(), { route_id: route.route_id });
    }
    for (const request of [
      { method: "HEAD", url: "/healthz" },
      { method: "HEAD", url: "/readyz" },
      { method: "HEAD", url: "/v1/decisions/decision-a" },
      { method: "GET", url: "/healthz/" },
      { method: "POST", url: "/v1/observe" },
      { method: "POST", url: "/v1/guide" },
      { method: "GET", url: "/v1/operator/snapshot" },
    ] as const) {
      const response = await server.inject(request);
      assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
    }
  } finally {
    await server.close();
  }
});

test("handler map and body limit are closed before server construction", () => {
  assert.throws(
    () => createContinuationRuntimeV1HttpServer({
      bodyLimitBytes: 1_048_576,
      handlers: { ...handlers(), legacy_route: async () => ({}) } as never,
    }),
    /http_handlers_invalid/u,
  );
  assert.throws(
    () => createContinuationRuntimeV1HttpServer({
      bodyLimitBytes: 8_192,
      handlers: handlers(),
    }),
    /http_body_limit_invalid/u,
  );
});
