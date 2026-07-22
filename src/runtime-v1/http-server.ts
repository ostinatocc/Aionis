import Fastify, {
  type FastifyInstance,
  type RouteHandlerMethod,
} from "fastify";

import {
  CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
  CONTINUATION_RUNTIME_V1_ROUTE_KEYS,
  type ContinuationRuntimeV1HttpHandlerId,
} from "./http-surface.js";
import {
  continuationRuntimeV1HttpErrorHandler,
  continuationRuntimeV1HttpNotFoundHandler,
} from "./http-handlers.js";

export type { ContinuationRuntimeV1HttpHandlerId } from "./http-surface.js";

export type ContinuationRuntimeV1HttpHandlers = Readonly<
  Record<ContinuationRuntimeV1HttpHandlerId, RouteHandlerMethod>
>;

export type ContinuationRuntimeV1HttpServerOptions = Readonly<{
  bodyLimitBytes: number;
  handlers: ContinuationRuntimeV1HttpHandlers;
}>;

const ROUTES = Object.freeze([
  ...CONTINUATION_RUNTIME_V1_PROBE_ROUTES,
  ...CONTINUATION_RUNTIME_V1_PUBLIC_ROUTES,
]);
const HANDLER_IDS = Object.freeze(ROUTES.map((route) => route.route_id));

function assertHandlers(value: unknown): asserts value is ContinuationRuntimeV1HttpHandlers {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("continuation_runtime_v1_http_handlers_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(HANDLER_IDS);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== HANDLER_IDS.length
    || keys.some((key) => !expected.has(key as string))) {
    throw new Error("continuation_runtime_v1_http_handlers_invalid");
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "function") {
      throw new Error("continuation_runtime_v1_http_handlers_invalid");
    }
  }
}

function assertBodyLimit(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 16_384
    || (value as number) > 5_242_880) {
    throw new Error("continuation_runtime_v1_http_body_limit_invalid");
  }
}

function canonicalRouteKeys(values: Iterable<string>): readonly string[] {
  return [...values].sort();
}

/**
 * Builds the complete public Runtime server. Fastify's implicit GET -> HEAD
 * expansion is disabled so the actual registered surface can equal the single
 * governed route inventory byte-for-byte.
 */
export function createContinuationRuntimeV1HttpServer(
  options: ContinuationRuntimeV1HttpServerOptions,
): FastifyInstance {
  assertBodyLimit(options?.bodyLimitBytes);
  assertHandlers(options?.handlers);
  const registered = new Set<string>();
  const server = Fastify({
    bodyLimit: options.bodyLimitBytes,
    exposeHeadRoutes: false,
    logger: false,
    onConstructorPoisoning: "error",
    onProtoPoisoning: "error",
    return503OnClosing: true,
    routerOptions: {
      caseSensitive: true,
      ignoreTrailingSlash: false,
      maxParamLength: 256,
    },
  });
  server.setErrorHandler(continuationRuntimeV1HttpErrorHandler);
  server.setNotFoundHandler(continuationRuntimeV1HttpNotFoundHandler);
  server.addHook("onRoute", (route) => {
    if (Array.isArray(route.method)) {
      throw new Error("continuation_runtime_v1_http_multi_method_route_forbidden");
    }
    registered.add(`${route.method} ${route.url}`);
  });
  for (const route of ROUTES) {
    server.route({
      method: route.method,
      url: route.path,
      handler: options.handlers[route.route_id],
    });
  }
  const actual = canonicalRouteKeys(registered);
  const expected = canonicalRouteKeys(CONTINUATION_RUNTIME_V1_ROUTE_KEYS);
  if (actual.length !== expected.length
    || actual.some((route, index) => route !== expected[index])) {
    throw new Error(
      `continuation_runtime_v1_http_surface_mismatch:${actual.join(",")}`,
    );
  }
  return server;
}
