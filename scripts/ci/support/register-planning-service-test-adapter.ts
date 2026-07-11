import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MemoryPlanningContextService } from "../../../src/routes/memory-context-runtime.js";

export const PLANNING_SERVICE_TEST_PATH = "/__test/memory-planning-context";

export function registerPlanningServiceTestAdapter(
  app: FastifyInstance,
  service: MemoryPlanningContextService,
): void {
  app.post(PLANNING_SERVICE_TEST_PATH, async (
    req: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ) => {
    const response = await service.assemble(req, reply);
    return reply.code(200).send(response);
  });
}
