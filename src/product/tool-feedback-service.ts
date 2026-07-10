import { buildLiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createLearningKernel, type LearningKernel, type LiteLearningKernelStore } from "../kernel/learning-kernel.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import {
  findGuideExposureLedger,
  productServiceDependencyFailure,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  type ProductServices,
  type ProductToolFeedbackInput,
} from "./product-services.js";

type ProductToolFeedbackKernel = Pick<
  LearningKernel,
  "recordToolSelectionFeedback" | "readToolRun"
>;

export type ProductToolFeedbackServiceDependencies = {
  env: Env;
  liteWriteStore: LiteLearningKernelStore;
  learningKernel: ProductToolFeedbackKernel | null;
};

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function attributionFailure(field: string) {
  return productServiceFailure({
    statusCode: 400,
    error: "guide_tool_selection_mismatch",
    message: "tool feedback must match the selection exposed by the referenced guide",
    details: { field },
  });
}

export function createProductToolFeedbackService(
  dependencies: ProductToolFeedbackServiceDependencies,
): ProductServices["toolFeedback"] {
  return {
    async execute(parsed: ProductToolFeedbackInput) {
      const { env, liteWriteStore, learningKernel } = dependencies;
      if (!learningKernel) return productServiceDependencyFailure("tool_feedback_service");
      const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? env.MEMORY_SCOPE;
      const consumerAgentId = parsed.consumer_agent_id ?? parsed.actor ?? env.LITE_LOCAL_ACTOR_ID;
      const consumerTeamId = parsed.consumer_team_id ?? null;
      try {
        const ledger = await findGuideExposureLedger({
          liteWriteStore,
          env,
          tenant_id: tenantId,
          scope,
          guide_trace_id: parsed.guide_trace_id,
          consumerAgentId,
          consumerTeamId,
        });
        if (!ledger) {
          return productServiceFailure({
            statusCode: 404,
            error: "guide_trace_not_found",
            message: "guide_trace_id does not resolve to a valid Aionis guide exposure ledger",
            details: { guide_trace_id: parsed.guide_trace_id },
          });
        }
        const receipt = ledger.tool_selection;
        if (!receipt) {
          return productServiceFailure({
            statusCode: 400,
            error: "guide_tool_selection_not_exposed",
            message: "the referenced guide did not expose a tool selection",
            details: { guide_trace_id: parsed.guide_trace_id },
          });
        }
        if (ledger.tenant_id !== tenantId) return attributionFailure("tenant_id");
        if (ledger.scope !== scope) return attributionFailure("scope");
        if (ledger.consumer_agent_id !== null && ledger.consumer_agent_id !== consumerAgentId) {
          return attributionFailure("consumer_agent_id");
        }
        if (ledger.consumer_team_id !== consumerTeamId) return attributionFailure("consumer_team_id");
        if (receipt.run_id !== parsed.run_id) return attributionFailure("run_id");
        if (receipt.decision_id !== parsed.decision_id) return attributionFailure("decision_id");
        if (receipt.selected_tool !== parsed.selected_tool) return attributionFailure("selected_tool");
        if (!sameStrings(receipt.candidates, parsed.candidates)) return attributionFailure("candidates");

        const feedbackResult = await learningKernel.recordToolSelectionFeedback({
          tenant_id: tenantId,
          scope,
          actor: parsed.actor ?? consumerAgentId,
          run_id: parsed.run_id,
          decision_id: parsed.decision_id,
          outcome: parsed.outcome,
          context: parsed.context,
          candidates: parsed.candidates,
          selected_tool: parsed.selected_tool,
          include_shadow: parsed.include_shadow,
          rules_limit: parsed.rules_limit,
          target: parsed.target,
          note: parsed.note,
          input_text: parsed.input_text,
          input_sha256: parsed.input_sha256,
          learning_control_review: parsed.learning_control_review,
        });
        const runLifecycle = await learningKernel.readToolRun({
          tenant_id: tenantId,
          scope,
          run_id: parsed.run_id,
          include_feedback: true,
        });
        return productServiceSuccess({
          contract_version: "aionis_feedback_result_v1",
          tenant_id: tenantId,
          scope,
          product_action: "feedback",
          feedback_kind: "tool_selection",
          tool_selection: receipt,
          feedback_result: feedbackResult,
          run_lifecycle: runLifecycle,
          source_map: {
            routes_used: ["/v1/feedback"],
            internal_surfaces_used: [
              "guide_exposure_ledger",
              "tool_selection_receipt",
              "tool_feedback_service",
              "learning_kernel",
              "run_lifecycle",
            ],
            omitted_internal_surfaces: ["raw_rule_rows", "raw_pattern_rows", "internal_route_schema"],
          },
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}

export function createProductToolFeedbackLearningKernel(args: {
  env: Env;
  embedder: EmbeddingProvider | null;
  queryEmbedder?: EmbeddingProvider | null;
  liteRecallAccess: RecallStoreAccess | null;
  liteWriteStore: LiteLearningKernelStore;
}): ProductToolFeedbackKernel | null {
  if (!args.liteRecallAccess) return null;
  const providers = buildLiteLearningControlRuntimeProviders(args.env);
  return createLearningKernel({
    env: args.env,
    embedder: args.embedder,
    queryEmbedder: args.queryEmbedder,
    liteRecallAccess: args.liteRecallAccess,
    liteWriteStore: args.liteWriteStore,
    learningControlProviders: { toolsFeedback: providers.toolsFeedback },
  });
}
