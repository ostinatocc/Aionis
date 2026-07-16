import stableStringify from "fast-json-stable-stringify";

import { buildLiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";
import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { createLearningKernel, type LearningKernel, type LiteLearningKernelStore } from "../kernel/learning-kernel.js";
import {
  appendLiteLearningFeedback,
  buildLiteToolFeedbackAppend,
  liteToolFeedbackEventId,
} from "../store/lite-learning-feedback.js";
import type { LiteLearningEpisodeLedgerAccess } from "../store/lite-learning-episode-ledger.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import {
  PRODUCT_FEEDBACK_OPERATION_KIND,
  PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES,
} from "./lifecycle-service.js";
import {
  findGuideExposureLedger,
  objectValue,
  productServiceDependencyFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  stripUndefined,
  type ProductGuideExposureLedger,
  type ProductServiceResult,
  type ProductServices,
  type ProductToolFeedbackInput,
} from "./product-services.js";

type ProductToolFeedbackKernel = Pick<
  LearningKernel,
  | "prepareToolSelectionFeedback"
  | "persistToolSelectionFeedback"
  | "finalizeToolSelectionFeedback"
  | "readToolRun"
>;

export type ProductToolFeedbackServiceDependencies = {
  env: Env;
  liteWriteStore: LiteLearningKernelStore;
  learningKernel: ProductToolFeedbackKernel | null;
  learningEpisodeLedgerAccess: LiteLearningEpisodeLedgerAccess | null;
};

type ProductToolFeedbackOperationIdentity = Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  requestSha256: string;
}>;

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function attributionFailure(field: string): never {
  throw new HttpError(
    400,
    "guide_tool_selection_mismatch",
    "tool feedback must match the selection exposed by the referenced guide",
    { field },
  );
}

function toolFeedbackRequestSha256(args: {
  parsed: ProductToolFeedbackInput;
  tenantId: string;
  scope: string;
}): string {
  const normalized: Record<string, unknown> = {
    ...args.parsed,
    tenant_id: args.tenantId,
    scope: args.scope,
    route_surface: "feedback",
  };
  delete normalized.operation_id;
  return sha256Hex(stableStringify(stripUndefined(normalized)));
}

function toolFeedbackOperationIdentity(args: {
  parsed: ProductToolFeedbackInput;
  tenantId: string;
  scope: string;
  requestSha256: string;
}): ProductToolFeedbackOperationIdentity | null {
  if (!args.parsed.operation_id) return null;
  return {
    tenantId: args.tenantId,
    scope: args.scope,
    operationId: args.parsed.operation_id,
    requestSha256: args.requestSha256,
  };
}

function assertToolFeedbackOperationMatches(
  identity: ProductToolFeedbackOperationIdentity,
  storedRequestSha256: string,
): void {
  if (identity.requestSha256 === storedRequestSha256) return;
  throw new HttpError(
    409,
    "learning_episode_operation_conflict",
    "operation_id was already used for a different feedback request",
    { operation_id: identity.operationId },
  );
}

function parseStoredToolFeedbackResult(args: {
  identity: ProductToolFeedbackOperationIdentity;
  receiptJson: string;
  commitId: string | null;
}): ProductServiceResult {
  if (Buffer.byteLength(args.receiptJson, "utf8") > PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES) {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.receiptJson);
  } catch {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  if (stableStringify(parsed) !== args.receiptJson) {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is not canonical");
  }
  const result = objectValue(parsed);
  const body = objectValue(result?.body);
  const feedbackResult = objectValue(body?.feedback_result);
  const toolSelection = objectValue(body?.tool_selection);
  const runLifecycle = objectValue(body?.run_lifecycle);
  const attributionStatus = body?.learning_attribution_status;
  const attributed = attributionStatus === "tool_decision";
  if (result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== "aionis_feedback_result_v1"
    || body.product_action !== "feedback"
    || body.feedback_kind !== "tool_selection"
    || body.operation_id !== args.identity.operationId
    || body.tenant_id !== args.identity.tenantId
    || body.scope !== args.identity.scope
    || (attributionStatus !== "tool_decision" && attributionStatus !== "not_attributed")
    || (attributed
      ? typeof body.learning_episode_id !== "string" || typeof body.learning_feedback_event_id !== "string"
      : body.learning_episode_id !== null || body.learning_feedback_event_id !== null)
    || !feedbackResult
    || typeof feedbackResult.commit_id !== "string"
    || feedbackResult.commit_id !== args.commitId
    || !toolSelection
    || toolSelection.decision_id !== feedbackResult.decision_id
    || !runLifecycle
    || runLifecycle.run_id !== toolSelection.run_id) {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  return parsed as ProductServiceResult;
}

async function resolveValidatedToolFeedbackGuide(args: {
  env: Env;
  liteWriteStore: LiteLearningKernelStore;
  parsed: ProductToolFeedbackInput;
  tenantId: string;
  scope: string;
  consumerAgentId: string;
  consumerTeamId: string | null;
}): Promise<ProductGuideExposureLedger> {
  const ledger = await findGuideExposureLedger({
    liteWriteStore: args.liteWriteStore,
    env: args.env,
    tenant_id: args.tenantId,
    scope: args.scope,
    guide_trace_id: args.parsed.guide_trace_id,
    consumerAgentId: args.consumerAgentId,
    consumerTeamId: args.consumerTeamId,
  });
  if (!ledger) {
    throw new HttpError(
      404,
      "guide_trace_not_found",
      "guide_trace_id does not resolve to a valid Aionis guide exposure ledger",
      { guide_trace_id: args.parsed.guide_trace_id },
    );
  }
  const receipt = ledger.tool_selection;
  if (!receipt) {
    throw new HttpError(
      400,
      "guide_tool_selection_not_exposed",
      "the referenced guide did not expose a tool selection",
      { guide_trace_id: args.parsed.guide_trace_id },
    );
  }
  if (ledger.tenant_id !== args.tenantId) attributionFailure("tenant_id");
  if (ledger.scope !== args.scope) attributionFailure("scope");
  if (ledger.consumer_agent_id !== null && ledger.consumer_agent_id !== args.consumerAgentId) {
    attributionFailure("consumer_agent_id");
  }
  if (ledger.consumer_team_id !== args.consumerTeamId) attributionFailure("consumer_team_id");
  if (ledger.context_sha256 !== sha256Hex(stableStringify(args.parsed.context))) {
    attributionFailure("context");
  }
  if (receipt.run_id !== args.parsed.run_id) attributionFailure("run_id");
  if (receipt.decision_id !== args.parsed.decision_id) attributionFailure("decision_id");
  if (receipt.selected_tool !== args.parsed.selected_tool) attributionFailure("selected_tool");
  if (!sameStrings(receipt.candidates, args.parsed.candidates)) attributionFailure("candidates");
  return ledger;
}

export function createProductToolFeedbackService(
  dependencies: ProductToolFeedbackServiceDependencies,
): ProductServices["toolFeedback"] {
  if (dependencies.learningEpisodeLedgerAccess
    && dependencies.learningEpisodeLedgerAccess.transactionRunner()
      !== dependencies.liteWriteStore.transactionRunner()) {
    throw new Error("tool feedback ledger and write store must share one Runtime transaction runner");
  }
  return {
    async execute(parsed: ProductToolFeedbackInput) {
      const { env, liteWriteStore, learningKernel, learningEpisodeLedgerAccess } = dependencies;
      const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
      const scope = parsed.scope ?? env.MEMORY_SCOPE;
      const consumerAgentId = parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID;
      const consumerTeamId = parsed.consumer_team_id ?? null;
      const requestSha256 = toolFeedbackRequestSha256({ parsed, tenantId, scope });
      const identity = toolFeedbackOperationIdentity({ parsed, tenantId, scope, requestSha256 });
      try {
        if (identity) {
          const stored = await liteWriteStore.getWriteOperation({
            tenantId: identity.tenantId,
            scope: identity.scope,
            operationKind: PRODUCT_FEEDBACK_OPERATION_KIND,
            operationId: identity.operationId,
          });
          if (stored) {
            assertToolFeedbackOperationMatches(identity, stored.request_sha256);
            return parseStoredToolFeedbackResult({
              identity,
              receiptJson: stored.receipt_json,
              commitId: stored.commit_id,
            });
          }
        }
        if (!learningKernel) return productServiceDependencyFailure("tool_feedback_service");
        const guideLedger = await resolveValidatedToolFeedbackGuide({
          env,
          liteWriteStore,
          parsed,
          tenantId,
          scope,
          consumerAgentId,
          consumerTeamId,
        });
        const toolSelection = guideLedger.tool_selection!;
        if (!toolSelection.context_sha256 || !toolSelection.rule_evaluation_sha256) {
          throw new HttpError(
            409,
            "guide_tool_selection_provenance_unavailable",
            "the served tool decision predates exact rule evaluation provenance",
            { guide_trace_id: parsed.guide_trace_id, decision_id: parsed.decision_id },
          );
        }
        const guideLedgerJson = stableStringify(guideLedger);
        const prepared = await learningKernel.prepareToolSelectionFeedback({
          tenant_id: tenantId,
          scope,
          actor: parsed.actor ?? consumerAgentId,
          guide_trace_id: parsed.guide_trace_id,
          operation_id: parsed.operation_id,
          guide_policy_sha256: toolSelection.policy_sha256,
          guide_source_rule_ids: toolSelection.source_rule_ids,
          guide_context_sha256: toolSelection.context_sha256,
          guide_rule_evaluation_sha256: toolSelection.rule_evaluation_sha256,
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
        return await liteWriteStore.withTx(async () => {
          if (identity) {
            const raced = await liteWriteStore.getWriteOperation({
              tenantId: identity.tenantId,
              scope: identity.scope,
              operationKind: PRODUCT_FEEDBACK_OPERATION_KIND,
              operationId: identity.operationId,
            });
            if (raced) {
              assertToolFeedbackOperationMatches(identity, raced.request_sha256);
              return parseStoredToolFeedbackResult({
                identity,
                receiptJson: raced.receipt_json,
                commitId: raced.commit_id,
              });
            }
          }
          const currentGuideLedger = await resolveValidatedToolFeedbackGuide({
            env,
            liteWriteStore,
            parsed,
            tenantId,
            scope,
            consumerAgentId,
            consumerTeamId,
          });
          if (stableStringify(currentGuideLedger) !== guideLedgerJson) {
            throw new HttpError(
              409,
              "guide_trace_changed",
              "the referenced guide exposure changed while feedback was being prepared",
              { guide_trace_id: parsed.guide_trace_id },
            );
          }
          const source = learningEpisodeLedgerAccess
            ? await learningEpisodeLedgerAccess.resolveFeedbackSource({
                tenantId,
                scope,
                guideTraceId: parsed.guide_trace_id,
              })
            : null;
          if (identity && learningEpisodeLedgerAccess && !source) {
            throw new HttpError(
              400,
              "tool_feedback_source_exposure_missing",
              "protected tool feedback requires its persisted learning exposure",
            );
          }
          if (source && source.event.run_id !== parsed.run_id) attributionFailure("run_id");

          const persisted = await learningKernel.persistToolSelectionFeedback(prepared);
          const feedbackResult = persisted.response;
          const feedbackResultBody = objectValue(feedbackResult);
          const sourceCommitId = typeof feedbackResultBody?.commit_id === "string"
            ? feedbackResultBody.commit_id
            : null;
          if (!sourceCommitId) throw new Error("tool feedback did not produce a source commit");
          if (feedbackResultBody?.decision_id !== parsed.decision_id
            || feedbackResultBody.tenant_id !== tenantId
            || feedbackResultBody.scope !== scope) {
            throw new Error("tool feedback result diverged from its validated guide decision");
          }
          const runLifecycleRowidCutoffs = identity
            ? await liteWriteStore.toolRunLifecycleRowidCutoffs({
                scope: prepared.scope_key,
                runId: parsed.run_id,
              })
            : null;
          const runLifecycle = await learningKernel.readToolRun({
            tenant_id: tenantId,
            scope,
            run_id: parsed.run_id,
            include_feedback: true,
          });
          const recordedAt = new Date().toISOString();
          const feedbackEventId = source
            ? liteToolFeedbackEventId({
                tenantId,
                scope,
                operationId: parsed.operation_id ?? null,
                sourceCommitId,
              })
            : null;
          const response = productServiceSuccess({
            contract_version: "aionis_feedback_result_v1",
            tenant_id: tenantId,
            scope,
            ...(parsed.operation_id ? { operation_id: parsed.operation_id } : {}),
            product_action: "feedback",
            feedback_kind: "tool_selection",
            learning_attribution_status: source ? "tool_decision" : "not_attributed",
            learning_episode_id: source?.event.episode_id ?? null,
            learning_feedback_event_id: feedbackEventId,
            tool_selection: currentGuideLedger.tool_selection!,
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
                ...(source ? ["learning_episode_feedback_attribution"] : []),
              ],
              omitted_internal_surfaces: ["raw_rule_rows", "raw_pattern_rows", "internal_route_schema"],
            },
          });
          const receiptJson = identity ? stableStringify(response) : null;
          if (receiptJson !== null
            && Buffer.byteLength(receiptJson, "utf8") > PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES) {
            throw new HttpError(
              413,
              "protected_feedback_response_too_large",
              "protected feedback response exceeds the canonical receipt size limit",
              { max_bytes: PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES },
            );
          }
          const canonicalResponse = receiptJson === null
            ? response
            : JSON.parse(receiptJson) as ProductServiceResult;
          if (source && learningEpisodeLedgerAccess) {
            const append = buildLiteToolFeedbackAppend({
              source,
              operationId: parsed.operation_id ?? null,
              runId: parsed.run_id,
              decisionId: String(feedbackResultBody.decision_id),
              sourceCommitId,
              requestSha256,
              operationReceiptSha256: receiptJson === null ? null : sha256Hex(receiptJson),
              runLifecycleRowidCutoffs,
              outcome: parsed.outcome,
              recordedAt,
            });
            if (append.event.event_id !== feedbackEventId) {
              throw new Error("tool feedback event identity diverged from its protected response");
            }
            await appendLiteLearningFeedback(learningEpisodeLedgerAccess, append);
          }
          if (identity) {
            await liteWriteStore.insertWriteOperation({
              tenantId: identity.tenantId,
              scope: identity.scope,
              operationKind: PRODUCT_FEEDBACK_OPERATION_KIND,
              operationId: identity.operationId,
              requestSha256: identity.requestSha256,
              receiptJson: receiptJson!,
              commitId: sourceCommitId,
            });
          }
          await liteWriteStore.afterCommit(async () => {
            await learningKernel.finalizeToolSelectionFeedback(persisted);
          });
          return canonicalResponse;
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
