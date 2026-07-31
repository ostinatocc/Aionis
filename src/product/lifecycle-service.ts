import stableStringify from "fast-json-stable-stringify";

import type { Env } from "../config.js";
import {
  activateMemoryNodesLite,
  rehydrateArchiveNodesLite,
} from "../memory/lifecycle-lite.js";
import { memoryFindLite } from "../memory/find.js";
import { setMemorySuppressionLite } from "../memory/memory-suppression.js";
import { rehydrateAnchorPayloadLite } from "../memory/rehydrate-anchor.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import type { AuthPrincipal } from "../util/auth.js";
import { HttpError } from "../util/http.js";
import {
  ProductForgetInput,
  ProductForgetRequest,
  ProductForgetTarget,
  ProductGuideExposureLedger,
  findGuideExposureLedger,
  finiteNumber,
  guideExposureServedMemoryIds,
  objectValue,
  productErrorResponse,
  productServiceDependencyFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  stripUndefined,
  uniqueStrings,
} from "./product-services.js";
import type {
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
  if (parsed.operation === "suppress" || parsed.operation === "unsuppress") return "memory";
  if (parsed.operation === "activate") return "memory";
  if (parsed.target) return parsed.target;
  if (parsed.anchor_id || parsed.anchor_uri || payloadString(parsed.payload, "anchor_id") || payloadString(parsed.payload, "anchor_uri")) {
    return "payload";
  }
  return "archive";
}

type ProductLifecycleOperation =
  | "suppress_memory"
  | "restore_memory"
  | "activate_memory"
  | "rehydrate_anchor_payload"
  | "rehydrate_archive";

function productLifecycleOperation(
  parsed: ProductForgetInput,
  target: ProductForgetTarget,
): ProductLifecycleOperation {
  if (parsed.operation === "suppress") return "suppress_memory";
  if (parsed.operation === "unsuppress") return "restore_memory";
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
    return stripUndefined({
      ...payload,
      ...identity,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      memory_ids: nodeIds.length > 0 ? nodeIds : payload.memory_ids,
      client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
      reason: parsed.reason,
    });
  }
  if (parsed.operation === "unsuppress") {
    return stripUndefined({
      ...payload,
      ...identity,
      anchor_id: parsed.anchor_id ?? payloadString(payload, "anchor_id"),
      memory_ids: nodeIds.length > 0 ? nodeIds : payload.memory_ids,
      client_ids: clientIds.length > 0 ? clientIds : payload.client_ids,
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
  if (operation === "suppress" || operation === "unsuppress") {
    return Array.isArray(body.changed_memory_ids)
      ? body.changed_memory_ids.length
      : 0;
  }
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
  learningAttributionStatus?: ProductLearningAttributionStatus;
  learningEpisodeId?: string | null;
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
    } : undefined,
    attribution: args.parsed.operation === "activate" ? stripUndefined({
      learning_episode_id: args.learningEpisodeId ?? undefined,
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

export const PRODUCT_FEEDBACK_OPERATION_KIND = "product_feedback_v1";
export const PRODUCT_FEEDBACK_OPERATION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

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
  ledger: ProductGuideExposureLedger;
  usedMemoryIds: readonly string[];
}): string[] {
  const receiptSurfaces = new Map(
    args.parsed.host_use_receipt_v1?.items.map((item) => [item.memory_id, item.used_surface]) ?? [],
  );
  const exposureById = new Map<string, string>();
  for (const memoryId of args.ledger.use_now_memory_ids) exposureById.set(memoryId, "use_now");
  for (const memoryId of args.ledger.inspect_before_use_memory_ids) {
    exposureById.set(memoryId, "inspect_before_use");
  }
  for (const memoryId of args.ledger.do_not_use_memory_ids) exposureById.set(memoryId, "do_not_use");
  for (const memoryId of args.ledger.rehydrate_memory_ids) exposureById.set(memoryId, "rehydrate");
  const missing = args.usedMemoryIds.filter((memoryId) => !exposureById.has(memoryId));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "guide_trace_used_memory_not_exposure_item",
      "feedback subjects must be exact items from the persisted guide response",
      { guide_trace_id: args.parsed.guide_trace_id, not_exposed_memory_ids: missing },
    );
  }
  return args.usedMemoryIds.filter((memoryId) => {
    const reported = receiptSurfaces.get(memoryId) ?? args.parsed.used_surface;
    const comparableReported = reported === "explicit_host_assertion" ? "use_now" : reported;
    return exposureById.get(memoryId)! !== comparableReported;
  });
}

function validateFormalFeedbackAuthority(args: {
  parsed: ProductForgetInput;
  ledger: ProductGuideExposureLedger;
  principal: AuthPrincipal | null;
  tenantId: string;
}): void {
  const receipt = args.parsed.host_use_receipt_v1;
  if (!receipt) return;
  if (receipt.episode_id !== args.ledger.feedback_episode_id
    || receipt.guide_trace_id !== args.ledger.guide_trace_id
    || receipt.operation_id !== args.parsed.operation_id
    || receipt.run_id !== args.parsed.run_id) {
    throw new HttpError(400, "host_use_receipt_identity_mismatch", "host-use receipt identity does not match the source guide");
  }
  if (!args.principal || args.principal.tenant_id !== args.tenantId) {
    throw new HttpError(403, "host_use_receipt_principal_mismatch", "verified host feedback requires the original authenticated principal");
  }
  if (
    (args.ledger.consumer_agent_id !== null
      && args.principal.agent_id !== args.ledger.consumer_agent_id)
    || (args.ledger.consumer_team_id !== null
      && args.principal.team_id !== args.ledger.consumer_team_id)
    || receipt.host_task_id !== args.ledger.host_task_id
    || receipt.host_task_envelope_sha256 !== args.ledger.host_task_envelope_sha256
    || receipt.collector_id !== args.ledger.collector_id
    || receipt.collector_version !== args.ledger.collector_version
  ) {
    throw new HttpError(403, "host_use_receipt_principal_mismatch", "host-use receipt does not match the source guide authority");
  }
}

export type ProductLifecycleServiceDependencies = {
  env: Env;
  liteWriteStore: LiteWriteStore;
};

function lifecycleSuccessResult(args: {
  env: Env;
  parsed: ProductForgetInput;
  surface: ProductLifecycleSurface;
  target: ProductForgetTarget;
  resultBody: unknown;
  guideExposure?: ProductGuideExposureResolution | null;
  learningAttributionStatus?: ProductLearningAttributionStatus;
  learningEpisodeId?: string | null;
}): ProductServiceResult {
  return productServiceSuccess({
    contract_version: productLifecycleContractVersion(args.surface),
    tenant_id: args.parsed.tenant_id ?? args.env.MEMORY_TENANT_ID,
    scope: args.parsed.scope ?? args.env.MEMORY_SCOPE,
    ...(args.parsed.operation_id ? { operation_id: args.parsed.operation_id } : {}),
    ...(args.parsed.operation === "activate" ? {
      learning_attribution_status: args.learningAttributionStatus ?? "not_attributed",
      learning_episode_id: args.learningEpisodeId ?? null,
    } : {}),
    ...(args.surface !== "forget" ? { product_action: args.surface } : {}),
    operation: args.parsed.operation,
    target: args.target,
    forget_effect: productForgetEffect({
      parsed: args.parsed,
      target: args.target,
      resultBody: args.resultBody,
      guideExposure: args.guideExposure,
      learningAttributionStatus: args.learningAttributionStatus,
      learningEpisodeId: args.learningEpisodeId,
    }),
    result: args.resultBody,
    source_map: {
      routes_used: [`/v1/${args.surface}`],
      internal_surfaces_used: [
        ...(args.guideExposure ? ["guide_exposure_ledger"] : []),
        ...(args.learningEpisodeId ? ["guide_feedback_attribution"] : []),
        args.target === "payload" ? "anchor_payload_rehydration" : "memory_lifecycle",
        args.parsed.operation === "suppress" || args.parsed.operation === "unsuppress"
          ? "memory_suppression"
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
  const { env, liteWriteStore } = args.dependencies;
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
    const guideLedger = guideExposure?.ok ? guideExposure.ledger : null;
    if (args.parsed.host_use_receipt_v1 && !guideLedger) {
      throw new HttpError(
        400,
        "host_use_receipt_source_guide_missing",
        "verified host feedback requires its persisted source guide",
      );
    }
    const usedMemoryIds = productForgetNodeIds(args.parsed, guideExposure);
    const boundaryIds = guideLedger
      ? boundaryIgnoredMemoryIds({ parsed: args.parsed, ledger: guideLedger, usedMemoryIds })
      : [];
    if (args.parsed.host_use_receipt_v1 && boundaryIds.length > 0) {
      throw new HttpError(
        400,
        "host_use_receipt_served_surface_mismatch",
        "verified host receipt subjects must match the exact served exposure surface",
        { memory_ids: boundaryIds },
      );
    }
    if (guideLedger) {
      validateFormalFeedbackAuthority({
        parsed: args.parsed,
        ledger: guideLedger,
        principal: args.context.principal,
        tenantId,
      });
    }
    const recordedAt = new Date().toISOString();
    const target = productForgetTarget(args.parsed);
    const payload = productForgetPayload(args.parsed, target, guideExposure, guideLedger ? {
      episodeId: guideLedger.feedback_episode_id,
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
    const learningAttributionStatus: ProductLearningAttributionStatus = guideLedger
      ? (args.parsed.host_use_receipt_v1 ? "verified_host_receipt" : "legacy_unverified")
      : "not_attributed";
    const response = lifecycleSuccessResult({
      env,
      parsed: args.parsed,
      surface: args.surface,
      target,
      resultBody,
      guideExposure,
      learningAttributionStatus,
      learningEpisodeId: guideLedger?.feedback_episode_id ?? null,
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
    if (/host-use receipt|host_use_receipt|feedback attribution/u.test(message)) {
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
    case "suppress_memory":
      return setMemorySuppressionLite({
        request: args.payload as ProductForgetInput,
        suppress: true,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        liteWriteStore,
      });
    case "restore_memory":
      return setMemorySuppressionLite({
        request: args.payload as ProductForgetInput,
        suppress: false,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        liteWriteStore,
      });
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
          if (error instanceof HttpError) {
            return productServiceFailureFromUnknown(error);
          }
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
  };
}
