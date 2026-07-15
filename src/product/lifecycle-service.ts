import stableStringify from "fast-json-stable-stringify";

import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
  type Env,
} from "../config.js";
import {
  activateMemoryNodesLite,
  rehydrateArchiveNodesLite,
} from "../memory/lifecycle-lite.js";
import {
  learningCollectionPrincipalSha256,
  learningEpisodeId,
} from "../memory/learning-episode-ledger.js";
import { memoryFindLite } from "../memory/find.js";
import { suppressAnchorLite, unsuppressAnchorLite } from "../memory/pattern-operator-override.js";
import { rehydrateAnchorPayloadLite } from "../memory/rehydrate-anchor.js";
import {
  buildAionisAgentFlightRecorderReport,
  buildAionisOperatorSnapshot,
} from "../memory/product-output/operator-projections.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import {
  appendLiteLearningFeedback,
  buildLiteLearningFeedbackAppend,
  liteLearningFeedbackEventId,
} from "../store/lite-learning-feedback.js";
import type { LiteLearningFeedbackSource } from "../store/lite-learning-feedback-source.js";
import { appendBoundaryLearningSafetyStop } from "../store/lite-learning-safety-stop.js";
import type { LiteLearningEpisodeLedgerAccess } from "../store/lite-learning-episode-ledger.js";
import type { LiteLearningControlJobAccess } from "../store/lite-learning-control-jobs.js";
import { sha256Hex } from "../util/crypto.js";
import type { AuthPrincipal } from "../util/auth.js";
import { HttpError } from "../util/http.js";
import {
  ProductDecisionTraceRequest,
  ProductFlightRecorderRequest,
  ProductForgetInput,
  ProductForgetRequest,
  ProductForgetTarget,
  ProductGuideExposureLedger,
  findGuideExposureLedger,
  findHistoricalGuideExposureLedgers,
  findMemoryNodeSlots,
  finiteNumber,
  guideExposureServedMemoryIds,
  guideExposureSurfaceIds,
  nonNegativeInt,
  objectValue,
  productErrorResponse,
  productMemoryDecisionOutputs,
  productServiceDependencyFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  sameGuideExposureConsumer,
  stripUndefined,
  uniqueStrings,
} from "./product-services.js";
import type {
  ProductDecisionTraceRequestInput,
  ProductFlightRecorderInput,
  ProductLifecycleSurface,
  ProductLifecycleExecutionContext,
  ProductServiceResult,
  ProductServices,
} from "./product-services.js";

export function productFeedbackRequest(body: unknown): ProductForgetInput {
  const record = objectValue(body) ?? {};
  const memoryFeedback = record.feedback_kind === "memory"
    ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "feedback_kind"))
    : record;
  return ProductForgetRequest.parse({
    ...memoryFeedback,
    operation: "activate",
    target: "memory",
  });
}

export function productRehydrateRequest(body: unknown): ProductForgetInput {
  const record = objectValue(body) ?? {};
  return ProductForgetRequest.parse({
    ...record,
    operation: "rehydrate",
  });
}

function productLifecycleContractVersion(surface: ProductLifecycleSurface): string {
  switch (surface) {
    case "feedback": return "aionis_feedback_result_v1";
    case "rehydrate": return "aionis_rehydrate_result_v1";
    case "forget": return "aionis_forget_result_v1";
  }
}

type ProductUnusedExposureObservation = {
  contract_version: "aionis_unused_exposure_observation_v1";
  mode: "read_only_measure";
  exposure_threshold: number;
  guide_trace_count: number;
  tracked_memory_count: number;
  repeated_unattributed_memory_ids: string[];
  repeated_unattributed_without_positive_memory_ids: string[];
  memory_stats: Array<{
    memory_id: string;
    current_unattributed: boolean;
    exposure_count: number;
    use_now_exposure_count: number;
    inspect_before_use_exposure_count: number;
    do_not_use_exposure_count: number;
    rehydrate_exposure_count: number;
    positive_attributed_use_count: number;
    feedback_positive_count: number;
    feedback_negative_count: number;
    repeated_without_positive_attribution: boolean;
  }>;
  reason: string;
};

type ProductGuideExposureResolution =
  | {
    ok: true;
    ledger: ProductGuideExposureLedger;
    usedMemoryIds: string[];
    unattributedRecalledMemoryIds: string[];
    unattributedUseNowMemoryIds: string[];
    unattributedInspectBeforeUseMemoryIds: string[];
    unattributedDoNotUseMemoryIds: string[];
    unattributedRehydrateMemoryIds: string[];
  }
  | {
    ok: false;
    statusCode: number;
    body: Record<string, unknown>;
  };

type ProductLearningAttributionStatus =
  | "not_attributed"
  | "legacy_unverified"
  | "verified_host_receipt";

async function buildUnusedExposureObservation(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  parsed: ProductForgetInput;
  guideExposure: Extract<ProductGuideExposureResolution, { ok: true }>;
}): Promise<ProductUnusedExposureObservation> {
  const ledger = args.guideExposure.ledger;
  const actor = ledger.consumer_agent_id ?? args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID;
  const consumerTeamId = ledger.consumer_team_id;
  const exposureThreshold = 2;
  const historicalLedgers = await findHistoricalGuideExposureLedgers({
    liteWriteStore: args.liteWriteStore,
    env: args.env,
    tenant_id: ledger.tenant_id,
    scope: ledger.scope,
    actor,
    consumerTeamId,
  });
  const ledgers = [
    ledger,
    ...historicalLedgers
      .filter((entry) =>
        entry.guide_trace_id !== ledger.guide_trace_id
        && sameGuideExposureConsumer(entry, ledger)
      ),
  ];

  const currentMemoryIds = ledger.memory_ids;
  const currentUnattributed = new Set(args.guideExposure.unattributedRecalledMemoryIds);
  const stats: ProductUnusedExposureObservation["memory_stats"] = [];
  for (const memoryId of currentMemoryIds) {
    const slots = await findMemoryNodeSlots({
      liteWriteStore: args.liteWriteStore,
      env: args.env,
      tenant_id: ledger.tenant_id,
      scope: ledger.scope,
      memory_id: memoryId,
      actor,
      consumerTeamId,
    });
    let exposureCount = 0;
    let useNowExposureCount = 0;
    let inspectExposureCount = 0;
    let doNotUseExposureCount = 0;
    let rehydrateExposureCount = 0;
    for (const exposure of ledgers) {
      if (!exposure.memory_ids.includes(memoryId)) continue;
      exposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "use_now_memory_ids").has(memoryId)) useNowExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "inspect_before_use_memory_ids").has(memoryId)) inspectExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "do_not_use_memory_ids").has(memoryId)) doNotUseExposureCount += 1;
      if (guideExposureSurfaceIds(exposure, "rehydrate_memory_ids").has(memoryId)) rehydrateExposureCount += 1;
    }
    const positiveAttributedUseCount = nonNegativeInt(slots.positive_attributed_use_count);
    const isCurrentUnattributed = currentUnattributed.has(memoryId);
    stats.push({
      memory_id: memoryId,
      current_unattributed: isCurrentUnattributed,
      exposure_count: exposureCount,
      use_now_exposure_count: useNowExposureCount,
      inspect_before_use_exposure_count: inspectExposureCount,
      do_not_use_exposure_count: doNotUseExposureCount,
      rehydrate_exposure_count: rehydrateExposureCount,
      positive_attributed_use_count: positiveAttributedUseCount,
      feedback_positive_count: nonNegativeInt(slots.feedback_positive),
      feedback_negative_count: nonNegativeInt(slots.feedback_negative),
      repeated_without_positive_attribution:
        isCurrentUnattributed && exposureCount >= exposureThreshold && positiveAttributedUseCount === 0,
    });
  }
  const repeatedUnattributed = stats
    .filter((entry) => entry.current_unattributed && entry.exposure_count >= exposureThreshold)
    .map((entry) => entry.memory_id);
  const repeatedWithoutPositive = stats
    .filter((entry) => entry.repeated_without_positive_attribution)
    .map((entry) => entry.memory_id);
  return {
    contract_version: "aionis_unused_exposure_observation_v1",
    mode: "read_only_measure",
    exposure_threshold: exposureThreshold,
    guide_trace_count: ledgers.length,
    tracked_memory_count: currentMemoryIds.length,
    repeated_unattributed_memory_ids: repeatedUnattributed,
    repeated_unattributed_without_positive_memory_ids: repeatedWithoutPositive,
    memory_stats: stats,
    reason: "Repeated exposure without host positive attribution is reported as read-only evidence; it does not lower authority or suppress memory.",
  };
}

async function resolveGuideExposureForActivation(args: {
  liteWriteStore: LiteWriteStore;
  parsed: ProductForgetInput;
  env: Env;
}): Promise<ProductGuideExposureResolution | null> {
  if (args.parsed.operation !== "activate" || !args.parsed.guide_trace_id) return null;
  const tenantId = args.parsed.tenant_id ?? args.env.MEMORY_TENANT_ID;
  const scope = args.parsed.scope ?? args.env.MEMORY_SCOPE;
  const actor = args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID;
  const consumerAgentId = args.parsed.consumer_agent_id ?? actor;
  let ledger: ProductGuideExposureLedger | null;
  try {
    ledger = await findGuideExposureLedger({
      liteWriteStore: args.liteWriteStore,
      env: args.env,
      tenant_id: tenantId,
      scope,
      guide_trace_id: args.parsed.guide_trace_id,
      consumerAgentId,
      consumerTeamId: args.parsed.consumer_team_id,
    });
  } catch {
    return {
      ok: false,
      statusCode: 500,
      body: productErrorResponse({
        status: 500,
        error: "guide_trace_lookup_failed",
        message: "guide trace lookup failed",
        details: { guide_trace_id: args.parsed.guide_trace_id },
      }),
    };
  }
  if (!ledger) {
    return {
      ok: false,
      statusCode: 400,
      body: productErrorResponse({
        status: 400,
        error: "guide_trace_not_found",
        message: "guide_trace_id does not resolve to a valid Aionis guide exposure ledger",
        details: { guide_trace_id: args.parsed.guide_trace_id },
        topLevel: { guide_trace_id: args.parsed.guide_trace_id },
      }),
    };
  }
  const requestedUsedMemoryIds = uniqueStrings([
    ...(args.parsed.used_memory_ids ?? []),
    ...(args.parsed.memory_ids ?? []),
    ...(args.parsed.node_ids ?? []),
  ]);
  const exposed = guideExposureServedMemoryIds(ledger);
  const notExposed = requestedUsedMemoryIds.filter((id) => !exposed.has(id));
  if (notExposed.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      body: productErrorResponse({
        status: 400,
        error: "guide_trace_used_memory_not_exposed",
        message: "activate feedback can only be attributed to memory ids exposed by the referenced guide_trace_id",
        details: {
          guide_trace_id: ledger.guide_trace_id,
          not_exposed_memory_ids: notExposed,
        },
        topLevel: {
          guide_trace_id: ledger.guide_trace_id,
          not_exposed_memory_ids: notExposed,
        },
      }),
    };
  }
  const used = new Set(requestedUsedMemoryIds);
  const unattributed = (ids: string[]) => ids.filter((id) => !used.has(id));
  return {
    ok: true,
    ledger,
    usedMemoryIds: requestedUsedMemoryIds,
    unattributedRecalledMemoryIds: unattributed(ledger.memory_ids),
    unattributedUseNowMemoryIds: unattributed(ledger.use_now_memory_ids),
    unattributedInspectBeforeUseMemoryIds: unattributed(ledger.inspect_before_use_memory_ids),
    unattributedDoNotUseMemoryIds: unattributed(ledger.do_not_use_memory_ids),
    unattributedRehydrateMemoryIds: unattributed(ledger.rehydrate_memory_ids),
  };
}

function productForgetNodeIds(parsed: ProductForgetInput, guideExposure?: ProductGuideExposureResolution | null): string[] {
  if (guideExposure?.ok) return guideExposure.usedMemoryIds;
  return uniqueStrings([
    ...(parsed.used_memory_ids ?? []),
    ...(parsed.node_ids ?? []),
    ...(parsed.memory_ids ?? []),
  ]);
}

function payloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function productForgetTarget(parsed: ProductForgetInput): ProductForgetTarget {
  if (parsed.operation === "suppress" || parsed.operation === "unsuppress") return "pattern";
  if (parsed.operation === "activate") return "memory";
  if (parsed.target) return parsed.target;
  if (parsed.anchor_id || parsed.anchor_uri || payloadString(parsed.payload, "anchor_id") || payloadString(parsed.payload, "anchor_uri")) {
    return "payload";
  }
  return "archive";
}

type ProductLifecycleOperation =
  | "suppress_anchor"
  | "unsuppress_anchor"
  | "activate_memory"
  | "rehydrate_anchor_payload"
  | "rehydrate_archive";

function productLifecycleOperation(
  parsed: ProductForgetInput,
  target: ProductForgetTarget,
): ProductLifecycleOperation {
  if (parsed.operation === "suppress") return "suppress_anchor";
  if (parsed.operation === "unsuppress") return "unsuppress_anchor";
  if (parsed.operation === "activate") return "activate_memory";
  if (target === "payload") return "rehydrate_anchor_payload";
  return "rehydrate_archive";
}

function productForgetPayload(
  parsed: ProductForgetInput,
  target: ProductForgetTarget,
  guideExposure?: ProductGuideExposureResolution | null,
  feedback?: Readonly<{
    episodeId: string;
    recordedAt: string;
    boundaryIgnoredMemoryIds: readonly string[];
    verifiedHostReceipt: boolean;
  }> | null,
): Record<string, unknown> {
  const payload = parsed.payload ?? {};
  const nodeIds = productForgetNodeIds(parsed, guideExposure);
  const clientIds = uniqueStrings(parsed.client_ids ?? []);
  const identity = stripUndefined({
    tenant_id: parsed.tenant_id ?? payloadString(payload, "tenant_id"),
    scope: parsed.scope ?? payloadString(payload, "scope"),
    actor: parsed.actor ?? payloadString(payload, "actor"),
    consumer_agent_id: parsed.consumer_agent_id ?? payloadString(payload, "consumer_agent_id"),
    consumer_team_id: parsed.consumer_team_id ?? payloadString(payload, "consumer_team_id"),
  });
  if (parsed.operation === "suppress") {
    const suppressMode = parsed.mode === "hard_freeze" || parsed.mode === "shadow_learn" ? parsed.mode : undefined;
    return stripUndefined({
      ...payload,
      ...identity,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      reason: parsed.reason,
      until: parsed.until ?? payload.until,
      mode: suppressMode ?? payload.mode,
    });
  }
  if (parsed.operation === "unsuppress") {
    return stripUndefined({
      ...payload,
      ...identity,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      reason: parsed.reason,
    });
  }
  if (parsed.operation === "activate") {
    return stripUndefined({
      ...payload,
      ...identity,
      node_ids: nodeIds.length > 0 ? nodeIds : payload.node_ids,
      client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
      consumer_team_id: guideExposure?.ok
        ? guideExposure.ledger.consumer_team_id ?? undefined
        : identity.consumer_team_id,
      guide_trace_id: feedback ? parsed.guide_trace_id : undefined,
      learning_episode_id: feedback?.episodeId,
      feedback_operation_id: parsed.operation_id,
      feedback_recorded_at: feedback?.recordedAt,
      boundary_ignored_memory_ids: feedback?.boundaryIgnoredMemoryIds,
      verified_host_receipt: feedback?.verifiedHostReceipt,
      run_id: parsed.run_id ?? payload.run_id,
      outcome: parsed.outcome ?? payload.outcome,
      activate: parsed.activate ?? payload.activate,
      reason: parsed.reason,
      input_text: typeof payload.input_text === "string" ? payload.input_text : parsed.reason,
      input_sha256: payload.input_sha256,
      used_surface: parsed.used_surface ?? payload.used_surface,
      verifier_status: parsed.verifier_status ?? payload.verifier_status,
      tool_status: parsed.tool_status ?? payload.tool_status,
      runtime_signal_refs: parsed.runtime_signal_refs ?? payload.runtime_signal_refs,
    });
  }
  if (target === "payload") {
    const rehydrationMode =
      parsed.mode === "summary_only" || parsed.mode === "partial" || parsed.mode === "full" || parsed.mode === "differential"
        ? parsed.mode
        : undefined;
    return stripUndefined({
      ...payload,
      ...identity,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      anchor_uri: parsed.anchor_uri ?? payloadString(payload, "anchor_uri"),
      mode: rehydrationMode ?? payload.mode,
      include_linked_decisions: parsed.include_linked_decisions ?? payload.include_linked_decisions,
      reason: parsed.reason,
    });
  }
  return stripUndefined({
    ...payload,
    ...identity,
    node_ids: nodeIds.length > 0 ? nodeIds : payload.node_ids,
    client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
    target_tier: parsed.target_tier ?? payload.target_tier,
    reason: parsed.reason,
    input_text: typeof payload.input_text === "string" ? payload.input_text : parsed.reason,
    input_sha256: payload.input_sha256,
  });
}

function productForgetChangedCount(resultBody: unknown, operation: ProductForgetInput["operation"], target: ProductForgetTarget): number {
  const body = resultBody && typeof resultBody === "object" && !Array.isArray(resultBody)
    ? resultBody as Record<string, unknown>
    : {};
  if (operation === "suppress" || operation === "unsuppress") return 1;
  if (operation === "activate") {
    const activated = body.activated && typeof body.activated === "object" && !Array.isArray(body.activated)
      ? body.activated as Record<string, unknown>
      : {};
    return finiteNumber(activated.updated_nodes) ?? 0;
  }
  if (target === "payload") {
    const rehydrated = body.rehydrated && typeof body.rehydrated === "object" && !Array.isArray(body.rehydrated)
      ? body.rehydrated as Record<string, unknown>
      : {};
    const summary = rehydrated.summary && typeof rehydrated.summary === "object" && !Array.isArray(rehydrated.summary)
      ? rehydrated.summary as Record<string, unknown>
      : {};
    return (finiteNumber(summary.resolved_nodes) ?? 0) + (finiteNumber(summary.resolved_decisions) ?? 0);
  }
  const rehydrated = body.rehydrated && typeof body.rehydrated === "object" && !Array.isArray(body.rehydrated)
    ? body.rehydrated as Record<string, unknown>
    : {};
  return finiteNumber(rehydrated.moved_nodes) ?? 0;
}

function productForgetEffect(args: {
  parsed: ProductForgetInput;
  target: ProductForgetTarget;
  resultBody: unknown;
  guideExposure?: ProductGuideExposureResolution | null;
  unusedExposureObservation?: ProductUnusedExposureObservation | null;
  feedbackLearningControlPersistence?: unknown;
  learningAttributionStatus?: ProductLearningAttributionStatus;
  learningEpisodeId?: string | null;
  learningFeedbackEventId?: string | null;
}) {
  const nodeIds = productForgetNodeIds(args.parsed, args.guideExposure);
  const changedCount = productForgetChangedCount(args.resultBody, args.parsed.operation, args.target);
  const result = args.resultBody && typeof args.resultBody === "object" && !Array.isArray(args.resultBody)
    ? args.resultBody as Record<string, unknown>
    : {};
  const anchorKind = typeof result.anchor_kind === "string" ? result.anchor_kind : null;
  return {
    action: args.parsed.operation,
    target: args.target,
    ...(anchorKind ? { anchor_kind: anchorKind } : {}),
    reason: args.parsed.reason,
    changed_count: changedCount,
    reversible: args.parsed.operation !== "activate",
    learning_attribution_status: args.parsed.operation === "activate"
      ? args.learningAttributionStatus ?? "not_attributed"
      : undefined,
    affected_memory_ids: nodeIds,
    affected_client_ids: uniqueStrings(args.parsed.client_ids ?? []),
    guide_trace: args.parsed.operation === "activate" && args.guideExposure?.ok ? {
      guide_trace_id: args.guideExposure.ledger.guide_trace_id,
      exposed_memory_ids: args.guideExposure.ledger.memory_ids,
      exposed_memory_count: args.guideExposure.ledger.memory_ids.length,
      attributed_memory_ids: args.guideExposure.usedMemoryIds,
      attributed_memory_count: args.guideExposure.usedMemoryIds.length,
      unattributed_recalled_memory_ids: args.guideExposure.unattributedRecalledMemoryIds,
      unattributed_recalled_memory_count: args.guideExposure.unattributedRecalledMemoryIds.length,
      unattributed_use_now_memory_ids: args.guideExposure.unattributedUseNowMemoryIds,
      unattributed_inspect_before_use_memory_ids: args.guideExposure.unattributedInspectBeforeUseMemoryIds,
      unattributed_do_not_use_memory_ids: args.guideExposure.unattributedDoNotUseMemoryIds,
      unattributed_rehydrate_memory_ids: args.guideExposure.unattributedRehydrateMemoryIds,
      unused_exposure_observation: args.unusedExposureObservation ?? undefined,
      feedback_learning_control: args.feedbackLearningControlPersistence ?? undefined,
    } : undefined,
    attribution: args.parsed.operation === "activate" ? stripUndefined({
      learning_episode_id: args.learningEpisodeId ?? undefined,
      learning_feedback_event_id: args.learningFeedbackEventId ?? undefined,
      run_id: args.parsed.run_id,
      outcome: args.parsed.outcome,
      used_surface: args.parsed.used_surface,
      verifier_status: args.parsed.verifier_status,
      tool_status: args.parsed.tool_status,
      runtime_signal_refs: args.parsed.runtime_signal_refs,
    }) : undefined,
    anchor_id: args.parsed.anchor_id ?? (typeof args.parsed.payload?.anchor_id === "string" ? args.parsed.payload.anchor_id : null),
    anchor_uri: args.parsed.anchor_uri ?? (typeof args.parsed.payload?.anchor_uri === "string" ? args.parsed.payload.anchor_uri : null),
  };
}

const PRODUCT_FEEDBACK_OPERATION_KIND = "product_feedback_v1";
const PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

type ProductFeedbackOperationIdentity = Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  requestSha256: string;
  surface: ProductLifecycleSurface;
}>;

function productFeedbackOperationIdentity(args: {
  parsed: ProductForgetInput;
  surface: ProductLifecycleSurface;
  env: Env;
}): ProductFeedbackOperationIdentity | null {
  if (args.parsed.operation !== "activate" || !args.parsed.operation_id) return null;
  const tenantId = args.parsed.tenant_id ?? args.env.MEMORY_TENANT_ID;
  const scope = args.parsed.scope ?? args.env.MEMORY_SCOPE;
  const normalized: Record<string, unknown> = {
    ...args.parsed,
    tenant_id: tenantId,
    scope,
    route_surface: args.surface,
  };
  delete normalized.operation_id;
  return {
    tenantId,
    scope,
    operationId: args.parsed.operation_id,
    requestSha256: sha256Hex(stableStringify(stripUndefined(normalized))),
    surface: args.surface,
  };
}

function assertFeedbackOperationMatches(
  identity: ProductFeedbackOperationIdentity,
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

function parseStoredFeedbackResult(
  identity: ProductFeedbackOperationIdentity,
  receiptJson: string,
): ProductServiceResult {
  if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES) {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptJson);
  } catch {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  if (stableStringify(parsed) !== receiptJson) {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is not canonical");
  }
  const result = objectValue(parsed);
  const body = objectValue(result?.body);
  if (result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== productLifecycleContractVersion(identity.surface)
    || body.operation_id !== identity.operationId
    || body.tenant_id !== identity.tenantId
    || body.scope !== identity.scope
    || typeof body.learning_attribution_status !== "string") {
    throw new HttpError(500, "protected_feedback_receipt_invalid", "stored feedback receipt is invalid");
  }
  return parsed as ProductServiceResult;
}

function boundaryIgnoredMemoryIds(args: {
  parsed: ProductForgetInput;
  source: LiteLearningFeedbackSource;
  usedMemoryIds: readonly string[];
}): string[] {
  const receiptSurfaces = new Map(
    args.parsed.host_use_receipt_v1?.items.map((item) => [item.memory_id, item.used_surface]) ?? [],
  );
  const exposureById = new Map(args.source.items.map((item) => [item.memory_id, item]));
  const missing = args.usedMemoryIds.filter((memoryId) => !exposureById.has(memoryId));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "guide_trace_used_memory_not_exposure_item",
      "feedback subjects must be exact items from the persisted learning exposure",
      { guide_trace_id: args.parsed.guide_trace_id, not_exposed_memory_ids: missing },
    );
  }
  return args.usedMemoryIds.filter((memoryId) => {
    const reported = receiptSurfaces.get(memoryId) ?? args.parsed.used_surface;
    const comparableReported = reported === "explicit_host_assertion" ? "use_now" : reported;
    return exposureById.get(memoryId)!.served_action !== comparableReported;
  });
}

function validateFormalFeedbackAuthority(args: {
  parsed: ProductForgetInput;
  source: LiteLearningFeedbackSource;
  principal: AuthPrincipal | null;
  tenantId: string;
}): void {
  const receipt = args.parsed.host_use_receipt_v1;
  if (!receipt) return;
  if (receipt.episode_id !== args.source.event.episode_id
    || receipt.guide_trace_id !== args.source.payload.guide_trace_id
    || receipt.operation_id !== args.parsed.operation_id
    || receipt.run_id !== args.parsed.run_id) {
    throw new HttpError(400, "host_use_receipt_identity_mismatch", "host-use receipt identity does not match the source exposure");
  }
  if (!args.principal || args.principal.tenant_id !== args.tenantId) {
    throw new HttpError(403, "host_use_receipt_principal_mismatch", "verified host feedback requires the original authenticated principal");
  }
  let principalSha256: string;
  try {
    principalSha256 = learningCollectionPrincipalSha256({
      tenant_id: args.principal.tenant_id,
      agent_id: args.principal.agent_id,
      team_id: args.principal.team_id,
    });
  } catch {
    throw new HttpError(403, "host_use_receipt_principal_mismatch", "verified host feedback requires a bounded principal identity");
  }
  if (principalSha256 !== args.source.eventRow.collection_principal_sha256
    || receipt.host_task_id !== args.source.eventRow.host_task_id
    || receipt.host_task_envelope_sha256 !== args.source.eventRow.host_task_envelope_sha256
    || receipt.collector_id !== args.source.eventRow.collector_id
    || receipt.collector_version !== args.source.eventRow.collector_version) {
    throw new HttpError(403, "host_use_receipt_principal_mismatch", "host-use receipt does not match the exposure authority");
  }
}

export type ProductLifecycleServiceDependencies = {
  env: Env;
  liteWriteStore: LiteWriteStore;
  learningEpisodeLedgerAccess?: LiteLearningEpisodeLedgerAccess | null;
  learningControlJobAccess?: LiteLearningControlJobAccess | null;
};

function lifecycleSuccessResult(args: {
  env: Env;
  parsed: ProductForgetInput;
  surface: ProductLifecycleSurface;
  target: ProductForgetTarget;
  resultBody: unknown;
  guideExposure?: ProductGuideExposureResolution | null;
  unusedExposureObservation?: ProductUnusedExposureObservation | null;
  learningAttributionStatus?: ProductLearningAttributionStatus;
  learningEpisodeId?: string | null;
  learningFeedbackEventId?: string | null;
  feedbackLearningControlPersistence?: unknown;
}): ProductServiceResult {
  return productServiceSuccess({
    contract_version: productLifecycleContractVersion(args.surface),
    tenant_id: args.parsed.tenant_id ?? args.env.MEMORY_TENANT_ID,
    scope: args.parsed.scope ?? args.env.MEMORY_SCOPE,
    ...(args.parsed.operation_id ? { operation_id: args.parsed.operation_id } : {}),
    ...(args.parsed.operation === "activate" ? {
      learning_attribution_status: args.learningAttributionStatus ?? "not_attributed",
      learning_episode_id: args.learningEpisodeId ?? null,
      learning_feedback_event_id: args.learningFeedbackEventId ?? null,
    } : {}),
    ...(args.surface !== "forget" ? { product_action: args.surface } : {}),
    operation: args.parsed.operation,
    target: args.target,
    forget_effect: productForgetEffect({
      parsed: args.parsed,
      target: args.target,
      resultBody: args.resultBody,
      guideExposure: args.guideExposure,
      unusedExposureObservation: args.unusedExposureObservation,
      learningAttributionStatus: args.learningAttributionStatus,
      learningEpisodeId: args.learningEpisodeId,
      learningFeedbackEventId: args.learningFeedbackEventId,
      feedbackLearningControlPersistence: args.feedbackLearningControlPersistence,
    }),
    result: args.resultBody,
    source_map: {
      routes_used: [`/v1/${args.surface}`],
      internal_surfaces_used: [
        ...(args.guideExposure ? ["guide_exposure_ledger"] : []),
        ...(args.unusedExposureObservation ? ["unused_exposure_observation"] : []),
        ...(args.learningFeedbackEventId ? ["learning_episode_feedback_attribution"] : []),
        args.target === "payload" ? "anchor_payload_rehydration" : "memory_lifecycle",
        args.parsed.operation === "suppress" || args.parsed.operation === "unsuppress"
          ? "learning_control"
          : "controlled_forgetting",
      ],
      omitted_internal_surfaces: ["raw_memory_rows", "raw_slots", "internal_route_schema"],
    },
  });
}

async function executeDirectFeedback(args: {
  dependencies: ProductLifecycleServiceDependencies;
  parsed: ProductForgetInput;
  surface: ProductLifecycleSurface;
  context: ProductLifecycleExecutionContext;
}): Promise<ProductServiceResult> {
  const { env, liteWriteStore, learningEpisodeLedgerAccess, learningControlJobAccess } = args.dependencies;
  const identity = productFeedbackOperationIdentity({ parsed: args.parsed, surface: args.surface, env });
  if (identity) {
    const stored = await liteWriteStore.getWriteOperation({
      tenantId: identity.tenantId,
      scope: identity.scope,
      operationKind: PRODUCT_FEEDBACK_OPERATION_KIND,
      operationId: identity.operationId,
    });
    if (stored) {
      assertFeedbackOperationMatches(identity, stored.request_sha256);
      return parseStoredFeedbackResult(identity, stored.receipt_json);
    }
  }
  try {
    return await liteWriteStore.withTx(async () => {
    if (identity) {
      const raced = await liteWriteStore.getWriteOperation({
        tenantId: identity.tenantId,
        scope: identity.scope,
        operationKind: PRODUCT_FEEDBACK_OPERATION_KIND,
        operationId: identity.operationId,
      });
      if (raced) {
        assertFeedbackOperationMatches(identity, raced.request_sha256);
        return parseStoredFeedbackResult(identity, raced.receipt_json);
      }
    }
    const guideExposure = await resolveGuideExposureForActivation({ liteWriteStore, parsed: args.parsed, env });
    if (guideExposure && !guideExposure.ok) {
      return { ok: false, statusCode: guideExposure.statusCode, body: guideExposure.body };
    }
    const tenantId = args.parsed.tenant_id ?? env.MEMORY_TENANT_ID;
    const scope = args.parsed.scope ?? env.MEMORY_SCOPE;
    const source = args.parsed.guide_trace_id && learningEpisodeLedgerAccess
      ? await learningEpisodeLedgerAccess.resolveFeedbackSource({
          tenantId,
          scope,
          guideTraceId: args.parsed.guide_trace_id,
        })
      : null;
    if (args.parsed.host_use_receipt_v1 && !source) {
      throw new HttpError(
        400,
        "host_use_receipt_source_exposure_missing",
        "verified host feedback requires its persisted learning exposure",
      );
    }
    const usedMemoryIds = productForgetNodeIds(args.parsed, guideExposure);
    const boundaryIds = source
      ? boundaryIgnoredMemoryIds({ parsed: args.parsed, source, usedMemoryIds })
      : [];
    if (args.parsed.host_use_receipt_v1 && boundaryIds.length > 0) {
      throw new HttpError(
        400,
        "host_use_receipt_served_surface_mismatch",
        "verified host receipt subjects must match the exact served exposure surface",
        { memory_ids: boundaryIds },
      );
    }
    if (source) {
      validateFormalFeedbackAuthority({
        parsed: args.parsed,
        source,
        principal: args.context.principal,
        tenantId,
      });
    }
    const recordedAt = new Date().toISOString();
    const target = productForgetTarget(args.parsed);
    const payload = productForgetPayload(args.parsed, target, guideExposure, source ? {
      episodeId: source.event.episode_id,
      recordedAt,
      boundaryIgnoredMemoryIds: boundaryIds,
      verifiedHostReceipt: args.parsed.host_use_receipt_v1 !== undefined,
    } : null);
    const resultBody = await activateMemoryNodesLite(
      liteWriteStore,
      payload,
      env.MEMORY_SCOPE,
      env.MEMORY_TENANT_ID,
      {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        defaultActor: env.LITE_LOCAL_ACTOR_ID,
      },
    );
    const result = objectValue(resultBody);
    const sourceCommitId = typeof result?.commit_id === "string" ? result.commit_id : null;
    const requireSourceCommitId = (): string => {
      if (!sourceCommitId) throw new Error("feedback activation did not produce a source commit");
      return sourceCommitId;
    };
    if (source) requireSourceCommitId();
    const feedbackEventId = source && learningEpisodeLedgerAccess
      ? liteLearningFeedbackEventId({
          tenantId: source.event.tenant_id,
          scope: source.event.scope,
          operationId: args.parsed.operation_id ?? null,
          sourceCommitId: requireSourceCommitId(),
        })
      : null;
    const learningAttributionStatus: ProductLearningAttributionStatus = source
      ? (args.parsed.host_use_receipt_v1 ? "verified_host_receipt" : "legacy_unverified")
      : "not_attributed";
    const unusedExposureObservation = guideExposure?.ok
      ? await buildUnusedExposureObservation({ liteWriteStore, env, parsed: args.parsed, guideExposure })
      : null;
    const learningControlWillQueue = source?.items.some((item) => !usedMemoryIds.includes(item.memory_id)) === true;
    const responseForLearningControlStatus = (
      learningControlStatus: "queued" | "already_completed" | null,
    ) => lifecycleSuccessResult({
      env,
      parsed: args.parsed,
      surface: args.surface,
      target,
      resultBody,
      guideExposure,
      unusedExposureObservation,
      learningAttributionStatus,
      learningEpisodeId: source?.event.episode_id ?? null,
      learningFeedbackEventId: feedbackEventId,
      feedbackLearningControlPersistence: learningControlStatus === null
        ? null
        : { learning_control_status: learningControlStatus },
    });
    let response = responseForLearningControlStatus(learningControlWillQueue ? "queued" : null);
    let receiptJson = identity ? stableStringify(response) : null;
    if (receiptJson !== null
      && Buffer.byteLength(receiptJson, "utf8") > PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES) {
      throw new HttpError(
        413,
        "protected_feedback_response_too_large",
        "protected feedback response exceeds the canonical receipt size limit",
        { max_bytes: PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES },
      );
    }
    if (source && learningEpisodeLedgerAccess) {
      const append = buildLiteLearningFeedbackAppend({
        source,
        operationId: args.parsed.operation_id ?? null,
        runId: args.parsed.run_id!,
        sourceCommitId: requireSourceCommitId(),
        requestSha256: identity?.requestSha256 ?? sha256Hex(stableStringify(stripUndefined({
          ...args.parsed,
          tenant_id: tenantId,
          scope,
          route_surface: args.surface,
        }))),
        operationReceiptSha256: receiptJson === null ? null : sha256Hex(receiptJson),
        outcome: args.parsed.outcome!,
        usedSurface: args.parsed.used_surface!,
        verifierStatus: args.parsed.verifier_status === "unknown"
          ? null
          : args.parsed.verifier_status ?? null,
        toolStatus: args.parsed.tool_status ?? null,
        runtimeSignalRefs: args.parsed.runtime_signal_refs ?? [],
        usedMemoryIds,
        recordedAt,
        hostUseReceipt: args.parsed.host_use_receipt_v1 ?? null,
      });
      if (append.event.event_id !== feedbackEventId) {
        throw new Error("learning feedback event identity diverged from its protected response");
      }
      const appendResult = await appendLiteLearningFeedback(learningEpisodeLedgerAccess, append);
      const feedbackEventRowId = Number(appendResult.row.row_id);
      if (!Number.isSafeInteger(feedbackEventRowId) || feedbackEventRowId < 1) {
        throw new Error("learning feedback append did not return its durable event row");
      }
      if (append.payload.unused_exposure_ids.length > 0) {
        if (!learningControlJobAccess) {
          throw new Error("learning feedback requires the durable learning-control queue");
        }
        const queued = await learningControlJobAccess.enqueueUnusedExposureLearningControlJob({
          tenantId: append.event.tenant_id,
          scope: append.event.scope,
          sourceEpisodeId: append.event.episode_id,
          sourceFeedbackEventId: append.event.event_id,
          sourceCommitId: requireSourceCommitId(),
          exposureIds: append.payload.unused_exposure_ids,
          enqueuedAt: append.event.recorded_at,
        });
        if (identity && queued.status !== "queued") {
          throw new Error("protected feedback cannot rewrite its canonical learning-control queue receipt");
        }
        if (!identity && queued.status !== "queued") {
          response = responseForLearningControlStatus(queued.status);
          receiptJson = null;
        }
      }
      await appendBoundaryLearningSafetyStop({
        ledger: learningEpisodeLedgerAccess,
        liteWriteStore,
        source,
        feedback: append,
        feedbackEventRowId,
        boundaryIgnoredMemoryIds: append.boundaryIgnoredMemoryIds,
        sourceCommitId: requireSourceCommitId(),
        recordedAt,
      });
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
    return response;
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: lite_learning_host_use_receipts|learning_authority_replay_conflict:lite_learning_host_use_receipts/u.test(message)) {
      throw new HttpError(
        409,
        "host_use_receipt_conflict",
        "host-use receipt identity was already consumed by another feedback operation",
      );
    }
    if (/host-use receipt|host_use_receipt|learning feedback subject|feedback attribution/u.test(message)) {
      throw new HttpError(400, "invalid_host_use_receipt", "host-use receipt validation failed");
    }
    throw error;
  }
}

export function productLifecycleGuardKind(input: ProductForgetInput): "recall" | "write" {
  const target = productForgetTarget(input);
  return input.operation === "rehydrate" && target === "payload" ? "recall" : "write";
}

async function executeLifecycleMutation(args: {
  dependencies: ProductLifecycleServiceDependencies;
  operation: ProductLifecycleOperation;
  payload: unknown;
}): Promise<unknown> {
  const { env, liteWriteStore } = args.dependencies;
  const writeOptions = {
    maxTextLen: env.MAX_TEXT_LEN,
    piiRedaction: env.PII_REDACTION,
    defaultActor: env.LITE_LOCAL_ACTOR_ID,
  };
  switch (args.operation) {
    case "suppress_anchor":
      return liteWriteStore.withTx(() => suppressAnchorLite({
        body: args.payload,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        liteWriteStore,
      }));
    case "unsuppress_anchor":
      return liteWriteStore.withTx(() => unsuppressAnchorLite({
        body: args.payload,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        liteWriteStore,
      }));
    case "rehydrate_archive":
      return liteWriteStore.withTx(() => rehydrateArchiveNodesLite(
        liteWriteStore,
        args.payload,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
        writeOptions,
      ));
    case "activate_memory":
      return liteWriteStore.withTx(() => activateMemoryNodesLite(
        liteWriteStore,
        args.payload,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
        writeOptions,
      ));
    case "rehydrate_anchor_payload":
      return rehydrateAnchorPayloadLite(
        liteWriteStore,
        args.payload,
        env.MEMORY_SCOPE,
        env.MEMORY_TENANT_ID,
        env.LITE_LOCAL_ACTOR_ID,
      );
    default:
      throw new Error("unsupported product lifecycle operation");
  }
}

export function createProductLifecycleService(
  dependencies: ProductLifecycleServiceDependencies,
): ProductServices["lifecycle"] {
  const { env, liteWriteStore } = dependencies;
  if (dependencies.learningEpisodeLedgerAccess
    && dependencies.learningEpisodeLedgerAccess.transactionRunner() !== liteWriteStore.transactionRunner()) {
    throw new Error("memory feedback ledger and write store must share one Runtime transaction runner");
  }
  if (dependencies.learningControlJobAccess
    && dependencies.learningControlJobAccess.transactionRunner() !== liteWriteStore.transactionRunner()) {
    throw new Error("memory feedback learning-control queue and write store must share one Runtime transaction runner");
  }
  return {
    async execute(parsed, surface, context): Promise<ProductServiceResult> {
      try {
        if (parsed.operation === "activate") {
          return await executeDirectFeedback({ dependencies, parsed, surface, context });
        }
        const target = productForgetTarget(parsed);
        const operation = productLifecycleOperation(parsed, target);
        const payload = productForgetPayload(parsed, target);
        let resultBody: unknown;
        try {
          resultBody = await executeLifecycleMutation({ dependencies, operation, payload });
        } catch (error) {
          return productServiceDependencyFailure(
            `memory_lifecycle_service:${operation}`,
            productServiceFailureFromUnknown(error).statusCode,
          );
        }
        return lifecycleSuccessResult({ env, parsed, surface, target, resultBody });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async decisionTrace(parsed: ProductDecisionTraceRequestInput) {
      try {
        const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
        const scope = parsed.scope ?? env.MEMORY_SCOPE;
        const decisionOutputs = productMemoryDecisionOutputs({
          tenant_id: tenantId,
          scope,
          trace: parsed.product_trace,
          routes_used: ["/v1/debug/memory-decision-trace"],
        });
        return productServiceSuccess({
          contract_version: "aionis_memory_decision_trace_result_v1",
          tenant_id: tenantId,
          scope,
          memory_decision_trace: decisionOutputs.memoryDecisionTrace,
          source_map: {
            routes_used: ["/v1/debug/memory-decision-trace"],
            internal_surfaces_used: ["product_trace_projection", "memory_decision_trace", "memory_use_receipt", "memory_admission_record"],
          },
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async decisionAudit(parsed: ProductDecisionTraceRequestInput) {
      try {
        const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
        const scope = parsed.scope ?? env.MEMORY_SCOPE;
        const decisionOutputs = productMemoryDecisionOutputs({
          tenant_id: tenantId,
          scope,
          trace: parsed.product_trace,
          routes_used: ["/v1/audit/memory-decision-report"],
        });
        return productServiceSuccess({
          contract_version: "aionis_memory_decision_audit_result_v1",
          tenant_id: tenantId,
          scope,
          memory_decision_audit: decisionOutputs.memoryDecisionAudit,
          source_map: {
            routes_used: ["/v1/audit/memory-decision-report"],
            internal_surfaces_used: ["product_trace_projection", "memory_decision_trace", "memory_decision_audit_report"],
          },
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async flightRecorder(parsed: ProductFlightRecorderInput) {
      try {
        const tenantId = parsed.tenant_id ?? env.MEMORY_TENANT_ID;
        const scope = parsed.scope ?? env.MEMORY_SCOPE;
        const decisionOutputs = parsed.product_trace
          ? productMemoryDecisionOutputs({
              tenant_id: tenantId,
              scope,
              trace: parsed.product_trace,
              routes_used: ["/v1/audit/flight-recorder"],
            })
          : null;
        const traceClaimLedgerProjection = parsed.product_trace
          ? (parsed.product_trace.after_guide as Record<string, unknown>).claim_ledger_projection
          : undefined;
        const claimLedgerProjectionInput = parsed.claim_ledger_projection ?? traceClaimLedgerProjection;
        const derivedOperatorSnapshot = parsed.product_trace
          ? buildAionisOperatorSnapshot({
              tenant_id: tenantId,
              scope,
              run_id: parsed.run_id ?? null,
              agent_context: parsed.agent_context ?? parsed.product_trace.after_guide.agent_context ?? undefined,
              guide_packet: parsed.product_trace.after_guide.guide_packet ?? undefined,
              memory_decision_trace: decisionOutputs?.memoryDecisionTrace,
              memory_decision_audit: decisionOutputs?.memoryDecisionAudit,
              claim_ledger_projection: claimLedgerProjectionInput,
              guide_trace_id: parsed.guide_trace_id ?? null,
              source_map: {
                routes_used: ["/v1/audit/flight-recorder"],
                internal_surfaces_used: [
                  "product_trace_projection",
                  "memory_decision_trace",
                  ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
                ],
              },
            })
          : null;
        const report = buildAionisAgentFlightRecorderReport({
          tenant_id: tenantId,
          scope,
          guide_trace_id: parsed.guide_trace_id ?? null,
          run_id: parsed.run_id ?? null,
          agent_context: parsed.agent_context ?? parsed.product_trace?.after_guide.agent_context,
          memory_decision_trace: parsed.memory_decision_trace ?? decisionOutputs?.memoryDecisionTrace,
          memory_use_receipt: parsed.memory_use_receipt,
          memory_admission_record: parsed.memory_admission_record,
          claim_ledger_projection: claimLedgerProjectionInput,
          operator_snapshot: parsed.operator_snapshot ?? derivedOperatorSnapshot,
          feedback_result: parsed.feedback_result ?? parsed.product_trace?.forget_result,
          now: parsed.decision_time,
          source_map: {
            routes_used: ["/v1/audit/flight-recorder"],
            internal_surfaces_used: [
              ...(parsed.product_trace ? ["product_trace_projection"] : []),
              ...(decisionOutputs ? ["memory_decision_trace", "memory_decision_audit_report"] : []),
              ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
              ...(derivedOperatorSnapshot ? ["operator_snapshot_contract"] : []),
            ],
          },
        });
        return productServiceSuccess({
          contract_version: "aionis_agent_flight_recorder_result_v1",
          tenant_id: tenantId,
          scope,
          agent_flight_recorder: report,
          source_map: {
            routes_used: ["/v1/audit/flight-recorder"],
            internal_surfaces_used: [
              "agent_flight_recorder",
              ...(parsed.product_trace ? ["product_trace_projection"] : []),
              ...(decisionOutputs ? ["memory_decision_trace", "memory_use_receipt", "memory_admission_record", "memory_decision_audit_report"] : []),
              ...(claimLedgerProjectionInput ? ["claim_ledger_projection"] : []),
              ...(derivedOperatorSnapshot || parsed.operator_snapshot ? ["operator_snapshot_contract"] : []),
            ],
            omitted_internal_surfaces: ["agent_prompt_text", "raw_memory_rows", "raw_slots", "raw_embedding_vectors"],
          },
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
