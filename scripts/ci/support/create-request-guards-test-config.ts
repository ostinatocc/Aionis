import type { Env } from "../../../src/config.ts";
import { createRuntimeConfig } from "../../../src/config/runtime-config.ts";
import { createRequestGuards as createTypedRequestGuards } from "../../../src/app/request-guards.ts";

type TypedRequestGuardArgs = Parameters<typeof createTypedRequestGuards>[0];
type TestRequestGuardArgs = Omit<TypedRequestGuardArgs, "config"> & { env: Env };

/** CI-only bridge for tests that construct explicit Env fixtures. */
export function createRequestGuards({ env, ...args }: TestRequestGuardArgs) {
  return createTypedRequestGuards({
    ...args,
    config: createRuntimeConfig(env),
  });
}
