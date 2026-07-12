import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
  type Env,
} from "../config.js";
import {
  activateMemoryNodesLite,
  applyUnusedExposureLearningControlLite,
  rehydrateArchiveNodesLite,
} from "../memory/lifecycle-lite.js";
import { memoryFindLite } from "../memory/find.js";
import { suppressAnchorLite, unsuppressAnchorLite } from "../memory/pattern-operator-override.js";
import { rehydrateAnchorPayloadLite } from "../memory/rehydrate-anchor.js";
import {
  buildAionisAgentFlightRecorderReport,
  buildAionisOperatorSnapshot,
} from "../memory/product-output/operator-projections.js";
import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
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

type ProductFeedbackLearningControlPersistence = Awaited<ReturnType<typeof applyUnusedExposureLearningControlLite>>;

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

async function persistUnusedExposureLearningControl(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  parsed: ProductForgetInput;
  guideExposure: Extract<ProductGuideExposureResolution, { ok: true }>;
  unusedExposureObservation: ProductUnusedExposureObservation;
}): Promise<ProductFeedbackLearningControlPersistence | null> {
  const candidates = args.unusedExposureObservation.memory_stats.filter((entry) =>
    entry.repeated_without_positive_attribution
    && entry.positive_attributed_use_count === 0
  );
  if (candidates.length === 0) return null;

  const result = await args.liteWriteStore.withTx(() =>
    applyUnusedExposureLearningControlLite(
      args.liteWriteStore,
      {
        tenant_id: args.guideExposure.ledger.tenant_id,
        scope: args.guideExposure.ledger.scope,
        actor: args.guideExposure.ledger.consumer_agent_id ?? args.parsed.actor ?? args.env.LITE_LOCAL_ACTOR_ID,
        consumer_team_id: args.guideExposure.ledger.consumer_team_id,
        run_id: args.parsed.run_id ?? null,
        guide_trace_id: args.guideExposure.ledger.guide_trace_id,
        reason: "Repeated guide exposure without positive host attribution should be inspected before direct reuse.",
        memory_stats: candidates,
      },
      args.env.MEMORY_SCOPE,
      args.env.MEMORY_TENANT_ID,
      {
        maxTextLen: args.env.MAX_TEXT_LEN,
        piiRedaction: args.env.PII_REDACTION,
        defaultActor: args.env.LITE_LOCAL_ACTOR_ID,
      },
    )
  );
  return result.changed_count > 0 ? result : null;
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
  const exposed = new Set(ledger.memory_ids);
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
  feedbackLearningControlPersistence?: ProductFeedbackLearningControlPersistence | null;
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

export type ProductLifecycleServiceDependencies = {
  env: Env;
  liteWriteStore: LiteWriteStore;
};

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
  return {
    async execute(parsed, surface): Promise<ProductServiceResult> {
      try {
        const guideExposure = await resolveGuideExposureForActivation({ liteWriteStore, parsed, env });
        if (guideExposure && !guideExposure.ok) {
          return { ok: false, statusCode: guideExposure.statusCode, body: guideExposure.body };
        }
        const target = productForgetTarget(parsed);
        const operation = productLifecycleOperation(parsed, target);
        const payload = productForgetPayload(parsed, target, guideExposure);
        let resultBody: unknown;
        try {
          resultBody = await executeLifecycleMutation({ dependencies, operation, payload });
        } catch (error) {
          return productServiceDependencyFailure(
            `memory_lifecycle_service:${operation}`,
            productServiceFailureFromUnknown(error).statusCode,
          );
        }
        const unusedExposureObservation = guideExposure?.ok
          ? await buildUnusedExposureObservation({ liteWriteStore, env, parsed, guideExposure })
          : null;
        const feedbackLearningControlPersistence = guideExposure?.ok && unusedExposureObservation
          ? await persistUnusedExposureLearningControl({
              liteWriteStore,
              env,
              parsed,
              guideExposure,
              unusedExposureObservation,
            })
          : null;
        return productServiceSuccess({
          contract_version: productLifecycleContractVersion(surface),
          tenant_id: parsed.tenant_id ?? env.MEMORY_TENANT_ID,
          scope: parsed.scope ?? env.MEMORY_SCOPE,
          ...(surface !== "forget" ? { product_action: surface } : {}),
          operation: parsed.operation,
          target,
          forget_effect: productForgetEffect({
            parsed,
            target,
            resultBody,
            guideExposure,
            unusedExposureObservation,
            feedbackLearningControlPersistence,
          }),
          result: resultBody,
          source_map: {
            routes_used: [`/v1/${surface}`],
            internal_surfaces_used: [
              ...(guideExposure ? ["guide_exposure_ledger"] : []),
              ...(unusedExposureObservation ? ["unused_exposure_observation"] : []),
              ...(feedbackLearningControlPersistence ? ["feedback_learning_control_persistence"] : []),
              target === "payload" ? "anchor_payload_rehydration" : "memory_lifecycle",
              parsed.operation === "suppress" || parsed.operation === "unsuppress" ? "learning_control" : "controlled_forgetting",
            ],
            omitted_internal_surfaces: ["raw_memory_rows", "raw_slots", "internal_route_schema"],
          },
        });
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
