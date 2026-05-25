import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config.js";
import { buildRuntimeBoundaryInventoryResponse } from "../memory/runtime-boundary-inventory.js";

type RegisterRuntimeBoundaryInventoryRoutesArgs = {
  app: FastifyInstance;
  env: Env;
};

export function registerRuntimeBoundaryInventoryRoutes(args: RegisterRuntimeBoundaryInventoryRoutesArgs) {
  const {
    app,
    env,
  } = args;

  if (env.AIONIS_EDITION !== "lite") {
    throw new Error("aionis-lite runtime boundary inventory routes only support AIONIS_EDITION=lite");
  }

  app.get("/v1/runtime/boundary-inventory", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send(buildRuntimeBoundaryInventoryResponse());
  });
}
