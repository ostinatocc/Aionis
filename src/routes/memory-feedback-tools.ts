import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertLocalStoreRuntimeEdition } from "../app/edition.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  buildLiteLearningControlRuntimeProviders,
  type LiteLearningControlRuntimeProviderBuilderOptions,
} from "../app/learning-control-runtime-providers.js";
import {
  createLearningKernel,
  type LiteLearningKernelStore,
} from "../kernel/learning-kernel.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { AuthPrincipal } from "../util/auth.js";
import type { InflightGateToken } from "../util/inflight_gate.js";

type MemoryFeedbackToolKind =
  | "feedback"
  | "rules_state"
  | "rules_evaluate"
  | "tools_select"
  | "tools_decision"
  | "tools_run"
  | "tools_feedback"
  | "learning_loop_run"
  | "runtime_maintenance_run"
  | "policy_learning_control_apply"
  | "anchors_suppress"
  | "anchors_unsuppress"
  | "patterns_suppress"
  | "patterns_unsuppress"
  | "rehydrate_payload";
type MemoryFeedbackInflightKind = "write" | "recall";

type MemoryFeedbackToolRequest = FastifyRequest<{ Body: unknown }>;

type RegisterMemoryFeedbackToolRoutesArgs = {
  app: FastifyInstance;
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder?: EmbeddingProvider | null;
  liteRecallAccess: RecallStoreAccess;
  liteWriteStore: LiteLearningKernelStore;
  requireMemoryPrincipal: (req: FastifyRequest) => Promise<AuthPrincipal | null>;
  withIdentityFromRequest: (
    req: FastifyRequest,
    body: unknown,
    principal: AuthPrincipal | null,
    kind: MemoryFeedbackToolKind,
  ) => unknown;
  enforceRateLimit: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall") => Promise<void>;
  enforceTenantQuota: (req: FastifyRequest, reply: FastifyReply, kind: "write" | "recall", tenantId: string) => Promise<void>;
  tenantFromBody: (body: unknown) => string;
  acquireInflightSlot: (kind: "write" | "recall") => Promise<InflightGateToken>;
  learningControlRuntimeProviderBuilderOptions?: LiteLearningControlRuntimeProviderBuilderOptions;
  routeExposure?: "all" | "temporary";
};

export function registerMemoryFeedbackToolRoutes(args: RegisterMemoryFeedbackToolRoutesArgs) {
  const {
    app,
    env,
    embedder,
    queryEmbedder,
    liteRecallAccess,
    liteWriteStore,
    requireMemoryPrincipal,
    withIdentityFromRequest,
    enforceRateLimit,
    enforceTenantQuota,
    tenantFromBody,
    acquireInflightSlot,
    routeExposure = "all",
  } = args;
  assertLocalStoreRuntimeEdition(env, "local-store memory-feedback-tools routes");
  const learningControlProviders = buildLiteLearningControlRuntimeProviders(
    env,
    args.learningControlRuntimeProviderBuilderOptions,
  );
  const learningKernel = createLearningKernel({
    env,
    embedder,
    queryEmbedder,
    liteRecallAccess,
    liteWriteStore,
    learningControlProviders: {
      toolsFeedback: learningControlProviders.toolsFeedback,
    },
  });

  const runFeedbackRoute = async <TResult>(args: {
    req: MemoryFeedbackToolRequest;
    reply: FastifyReply;
    requestKind: MemoryFeedbackToolKind;
    inflightKind: MemoryFeedbackInflightKind;
    withGate?: boolean;
    execute: (body: unknown) => Promise<TResult>;
  }): Promise<TResult> => {
    const { req, reply, requestKind, inflightKind, withGate = true, execute } = args;
    const principal = await requireMemoryPrincipal(req);
    const body = withIdentityFromRequest(req, req.body, principal, requestKind);
    await enforceRateLimit(req, reply, inflightKind);
    await enforceTenantQuota(req, reply, inflightKind, tenantFromBody(body));
    if (!withGate) {
      return await execute(body);
    }
    const gate = await acquireInflightSlot(inflightKind);
    try {
      return await execute(body);
    } finally {
      gate.release();
    }
  };
  const registerFeedbackPostRoute = <TResult>(args: {
    path: string;
    requestKind: MemoryFeedbackToolKind;
    inflightKind: MemoryFeedbackInflightKind;
    withGate?: boolean;
    execute: (body: unknown) => Promise<TResult>;
  }) => {
    if (
      routeExposure === "temporary"
      && ![
        "/v1/memory/tools/select",
        "/v1/memory/tools/decision",
        "/v1/memory/tools/run",
        "/v1/memory/tools/feedback",
      ].includes(args.path)
    ) {
      return;
    }
    app.post(args.path, async (req: MemoryFeedbackToolRequest, reply: FastifyReply) => {
      const out = await runFeedbackRoute({
        req,
        reply,
        requestKind: args.requestKind,
        inflightKind: args.inflightKind,
        withGate: args.withGate,
        execute: args.execute,
      });
      return reply.code(200).send(out);
    });
  };

  registerFeedbackPostRoute({
    path: "/v1/memory/feedback",
    requestKind: "feedback",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.recordRuleFeedback(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/rules/state",
    requestKind: "rules_state",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.applyRuleState(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/rules/evaluate",
    requestKind: "rules_evaluate",
    inflightKind: "recall",
    execute: (body) => learningKernel.evaluateRulePolicy(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/select",
    requestKind: "tools_select",
    inflightKind: "recall",
    execute: (body) => learningKernel.selectToolWithLearnedMemory(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/decision",
    requestKind: "tools_decision",
    inflightKind: "recall",
    execute: (body) => learningKernel.readToolDecision(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/run",
    requestKind: "tools_run",
    inflightKind: "recall",
    execute: (body) => learningKernel.readToolRun(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/runs/list",
    requestKind: "tools_run",
    inflightKind: "recall",
    execute: (body) => learningKernel.listToolRuns(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/feedback",
    requestKind: "tools_feedback",
    inflightKind: "write",
    execute: (body) => learningKernel.recordToolSelectionFeedback(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/learning-loop/run",
    requestKind: "learning_loop_run",
    inflightKind: "write",
    execute: (body) => learningKernel.runLearningLoop(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/runtime-maintenance/run",
    requestKind: "runtime_maintenance_run",
    inflightKind: "write",
    execute: (body) => learningKernel.runRuntimeMaintenance(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/runtime-maintenance/immediate",
    requestKind: "runtime_maintenance_run",
    inflightKind: "write",
    execute: (body) => learningKernel.runRuntimeMaintenanceImmediate(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/runtime-maintenance/daily",
    requestKind: "runtime_maintenance_run",
    inflightKind: "write",
    execute: (body) => learningKernel.runRuntimeMaintenanceDaily(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/runtime-maintenance/long-horizon",
    requestKind: "runtime_maintenance_run",
    inflightKind: "write",
    execute: (body) => learningKernel.runRuntimeMaintenanceLongHorizon(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/policies/learning-control/apply",
    requestKind: "policy_learning_control_apply",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.applyPolicyLearningControl(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/anchors/suppress",
    requestKind: "anchors_suppress",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.suppressLearnedAnchor(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/anchors/unsuppress",
    requestKind: "anchors_unsuppress",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.unsuppressLearnedAnchor(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/patterns/suppress",
    requestKind: "patterns_suppress",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.suppressLearnedPattern(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/patterns/unsuppress",
    requestKind: "patterns_unsuppress",
    inflightKind: "write",
    withGate: false,
    execute: (body) => learningKernel.unsuppressLearnedPattern(body),
  });
  registerFeedbackPostRoute({
    path: "/v1/memory/tools/rehydrate_payload",
    requestKind: "rehydrate_payload",
    inflightKind: "recall",
    execute: (body) => learningKernel.rehydrateLearnedAnchorPayload(body),
  });
}
