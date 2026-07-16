import stableStringify from "fast-json-stable-stringify";

import {
  FeedbackAttributedV1Schema,
  HostUseReceiptV1BodySchema,
  HostUseReceiptV1Schema,
  learningEpisodeEventDigest,
  hostUseReceiptDigest,
  type EventWithoutDigest,
  type FeedbackAttributedV1,
  type HostUseReceiptV1,
} from "../memory/learning-episode-ledger.js";
import { resolveNodeFeedbackAttributionStrength } from "../memory/node-feedback-state.js";
import { sha256Hex } from "../util/crypto.js";
import {
  LITE_LEARNING_LEDGER_REQUIRED_COLUMNS,
  type LiteLearningEpisodeLedgerAccess,
} from "./lite-learning-episode-ledger.js";
import {
  learningFeedbackAttributionItemDigest,
  learningFeedbackAttributionSetDigest,
  learningHostUseReceiptItemSetDigest,
} from "./lite-learning-feedback-digest.js";
import type {
  LiteLearningAuthorityRow,
  LiteLearningSqlValue,
} from "./lite-learning-confirmatory-authority.js";
import type { LiteLearningFeedbackSource } from "./lite-learning-feedback-source.js";

type FeedbackSurface = "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
type FeedbackOutcome = "positive" | "negative" | "neutral";
type MutableAuthorityRow = Record<string, LiteLearningSqlValue>;

export type LiteLearningFeedbackAppend = Readonly<{
  event: EventWithoutDigest;
  eventRow: LiteLearningAuthorityRow;
  payload: FeedbackAttributedV1;
  attributions: readonly LiteLearningAuthorityRow[];
  hostUseReceipt: LiteLearningAuthorityRow | null;
  boundaryIgnoredMemoryIds: readonly string[];
}>;

function emptyAuthorityRow(table: keyof typeof LITE_LEARNING_LEDGER_REQUIRED_COLUMNS): MutableAuthorityRow {
  return Object.fromEntries(
    LITE_LEARNING_LEDGER_REQUIRED_COLUMNS[table]
      .filter((column) => column !== "row_id")
      .map((column) => [column, null]),
  ) as MutableAuthorityRow;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

export function liteLearningFeedbackEventId(args: Readonly<{
  tenantId: string;
  scope: string;
  operationId: string | null;
  sourceCommitId: string;
}>): string {
  return `lfeedback_${sha256Hex(stableStringify({
    tenant_id: args.tenantId,
    scope: args.scope,
    source_kind: "memory_feedback_operation",
    source_id: args.operationId ?? args.sourceCommitId,
  }))}`;
}

export function liteToolFeedbackEventId(args: Readonly<{
  tenantId: string;
  scope: string;
  operationId: string | null;
  sourceCommitId: string;
}>): string {
  return `lfeedback_${sha256Hex(stableStringify({
    tenant_id: args.tenantId,
    scope: args.scope,
    source_kind: "tool_feedback_operation",
    source_id: args.operationId ?? args.sourceCommitId,
  }))}`;
}

function buildFeedbackEventRow(args: {
  source: LiteLearningFeedbackSource;
  event: EventWithoutDigest;
  payload: FeedbackAttributedV1;
}): LiteLearningAuthorityRow {
  const row = emptyAuthorityRow("lite_learning_episode_events");
  for (const field of LITE_LEARNING_LEDGER_REQUIRED_COLUMNS.lite_learning_episode_events) {
    if (field === "row_id") continue;
    if (field in args.source.eventRow) row[field] = args.source.eventRow[field] ?? null;
  }
  const payloadJson = stableStringify(args.payload);
  Object.assign(row, {
    tenant_id: args.event.tenant_id,
    scope: args.event.scope,
    event_id: args.event.event_id,
    episode_id: args.event.episode_id,
    episode_sequence: args.event.episode_sequence,
    event_kind: args.event.event_kind,
    source_kind: args.event.source_kind,
    source_id: args.event.source_id,
    source_sha256: args.event.source_sha256,
    previous_event_sha256: args.event.previous_event_sha256,
    event_sha256: learningEpisodeEventDigest(args.event),
    payload_sha256: args.event.payload_sha256,
    payload_json: payloadJson,
    item_set_sha256: args.event.item_set_sha256,
    source_commit_id: args.event.source_commit_id,
    supersedes_event_id: args.event.supersedes_event_id,
    operation_id: args.event.operation_id,
    run_id: args.event.run_id,
    collection_class: args.event.collection_class,
    promotion_eligible: 0,
    recorded_at: args.event.recorded_at,
  });
  return row;
}

export function buildLiteLearningFeedbackAppend(args: Readonly<{
  source: LiteLearningFeedbackSource;
  operationId: string | null;
  runId: string;
  sourceCommitId: string;
  requestSha256: string;
  operationReceiptSha256: string | null;
  outcome: FeedbackOutcome;
  usedSurface: FeedbackSurface;
  verifierStatus: "passed" | "failed" | "not_run" | "unknown" | null;
  toolStatus: "succeeded" | "failed" | "not_run" | "unknown" | null;
  runtimeSignalRefs: readonly string[];
  usedMemoryIds: readonly string[];
  recordedAt: string;
  hostUseReceipt?: HostUseReceiptV1 | null;
}>): LiteLearningFeedbackAppend {
  const receipt = args.hostUseReceipt ? HostUseReceiptV1Schema.parse(args.hostUseReceipt) : null;
  const receiptBody = receipt
    ? HostUseReceiptV1BodySchema.parse((({ receipt_sha256: _digest, ...body }) => body)(receipt))
    : null;
  const receiptItems = new Map(receiptBody?.items.map((item) => [item.memory_id, item]) ?? []);
  const exposureItems = new Map(args.source.items.map((item) => [item.memory_id, item]));
  const usedMemoryIds = canonicalStrings(args.usedMemoryIds);
  if (usedMemoryIds.length === 0) throw new Error("learning feedback requires at least one used exposure item");
  const notExposed = usedMemoryIds.filter((memoryId) => !exposureItems.has(memoryId));
  if (notExposed.length > 0) {
    throw new Error(`learning feedback subject is not an exposure item: ${notExposed.join(", ")}`);
  }
  if (receiptBody && stableStringify([...receiptItems.keys()]) !== stableStringify(usedMemoryIds)) {
    throw new Error("host-use receipt subject set does not match the feedback request");
  }
  const runtimeSignalRefs = canonicalStrings(args.runtimeSignalRefs);
  const sourceId = args.operationId ?? args.sourceCommitId;
  const eventId = liteLearningFeedbackEventId({
    tenantId: args.source.event.tenant_id,
    scope: args.source.event.scope,
    operationId: args.operationId,
    sourceCommitId: args.sourceCommitId,
  });
  const boundaryIgnoredMemoryIds: string[] = [];
  const attributions = usedMemoryIds.map((memoryId) => {
    const exposure = exposureItems.get(memoryId)!;
    const receiptItem = receiptItems.get(memoryId) ?? null;
    const usedSurface = receiptItem?.used_surface ?? args.usedSurface;
    const outcome = receiptItem?.outcome ?? args.outcome;
    const comparableSurface = usedSurface === "explicit_host_assertion" ? "use_now" : usedSurface;
    const boundaryOutcome = exposure.served_action === comparableSurface ? "aligned" : "boundary_ignored";
    if (boundaryOutcome === "boundary_ignored") boundaryIgnoredMemoryIds.push(memoryId);
    const base = emptyAuthorityRow("lite_learning_feedback_attributions");
    Object.assign(base, {
      tenant_id: args.source.event.tenant_id,
      scope: args.source.event.scope,
      event_id: eventId,
      episode_id: args.source.event.episode_id,
      subject_kind: "memory",
      subject_id: memoryId,
      outcome,
      action_outcome: receiptItem?.action_outcome ?? null,
      used_surface: usedSurface,
      exposure_action: exposure.served_action,
      boundary_outcome: boundaryOutcome,
      attribution_strength: resolveNodeFeedbackAttributionStrength({
        outcome,
        used_surface: usedSurface,
        verified_host_receipt: receiptItem !== null,
        verifier_status: receiptItem?.verifier_status ?? (args.verifierStatus === "unknown" ? null : args.verifierStatus),
        tool_status: args.toolStatus,
        runtime_signal_refs: runtimeSignalRefs,
      }),
      evidence_class: receiptItem ? "verified_host_receipt" : "legacy_unverified",
      host_use_receipt_id: receiptBody?.receipt_id ?? null,
      host_use_receipt_sha256: receipt?.receipt_sha256 ?? null,
      receipt_item_sha256: receiptItem ? sha256Hex(stableStringify(receiptItem)) : null,
      host_task_envelope_sha256: receiptBody?.host_task_envelope_sha256 ?? null,
      collection_principal_sha256: receiptItem ? args.source.eventRow.collection_principal_sha256 : null,
      collector_id: receiptBody?.collector_id ?? null,
      collector_version: receiptBody?.collector_version ?? null,
      content_evidence_sha256: receiptItem?.content_evidence_sha256 ?? null,
      verifier_kind: receiptItem?.verifier_kind ?? null,
      verifier_version: receiptItem?.verifier_version ?? null,
      verifier_config_sha256: receiptItem?.verifier_config_sha256 ?? null,
      verifier_status: receiptItem?.verifier_status ?? null,
      tool_status: args.toolStatus,
      runtime_signal_refs_sha256: sha256Hex(stableStringify(runtimeSignalRefs)),
      item_sha256: "0".repeat(64),
    });
    base.item_sha256 = learningFeedbackAttributionItemDigest(base);
    return base;
  });
  const receiptSha256 = receiptBody ? hostUseReceiptDigest(receiptBody) : null;
  const unusedExposureIds = args.source.items.some((item) => !usedMemoryIds.includes(item.memory_id))
    ? [args.source.event.event_id]
    : [];
  const payload = FeedbackAttributedV1Schema.parse({
    contract_version: "aionis_learning_feedback_v1",
    feedback_kind: "memory",
    guide_trace_id: args.source.payload.guide_trace_id,
    request_sha256: args.requestSha256,
    operation_protection: args.operationId ? "protected" : "legacy_unprotected",
    operation_receipt_sha256: args.operationReceiptSha256,
    run_id: args.runId,
    source_commit_id: args.sourceCommitId,
    host_use_receipt_sha256: receiptSha256,
    runtime_signal_refs: runtimeSignalRefs,
    unused_exposure_ids: unusedExposureIds,
    ...(unusedExposureIds.length > 0
      ? { learning_control_queue_contract: "unused_exposure_learning_control_v1" }
      : {}),
  });
  const event: EventWithoutDigest = {
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: args.source.event.tenant_id,
    scope: args.source.event.scope,
    event_id: eventId,
    episode_id: args.source.event.episode_id,
    episode_sequence: args.source.headSequence + 1,
    event_kind: "feedback_attributed",
    source_kind: "memory_feedback_operation",
    source_id: sourceId,
    source_sha256: args.requestSha256,
    previous_event_sha256: args.source.headEventSha256,
    payload_sha256: sha256Hex(stableStringify(payload)),
    item_set_sha256: learningFeedbackAttributionSetDigest(attributions),
    source_commit_id: args.sourceCommitId,
    supersedes_event_id: null,
    operation_id: args.operationId,
    run_id: args.runId,
    collection_class: args.source.event.collection_class,
    recorded_at: args.recordedAt,
  };
  const hostUseReceipt = receiptBody ? Object.assign(emptyAuthorityRow("lite_learning_host_use_receipts"), {
    tenant_id: event.tenant_id,
    scope: event.scope,
    receipt_id: receiptBody.receipt_id,
    episode_id: event.episode_id,
    feedback_event_id: event.event_id,
    operation_id: receiptBody.operation_id,
    run_id: receiptBody.run_id,
    host_task_id: receiptBody.host_task_id,
    host_task_envelope_sha256: receiptBody.host_task_envelope_sha256,
    collection_principal_sha256: args.source.eventRow.collection_principal_sha256,
    collector_id: receiptBody.collector_id,
    collector_version: receiptBody.collector_version,
    host_trace_sha256: receiptBody.host_trace_sha256,
    observed_at: receiptBody.observed_at,
    received_at: args.recordedAt,
    item_count: receiptBody.items.length,
    item_set_sha256: learningHostUseReceiptItemSetDigest(receiptBody.items),
    receipt_sha256: receiptSha256,
    receipt_payload_json: stableStringify(receiptBody),
    verifier_status: "passed",
  }) : null;
  return {
    event,
    eventRow: buildFeedbackEventRow({ source: args.source, event, payload }),
    payload,
    attributions,
    hostUseReceipt,
    boundaryIgnoredMemoryIds,
  };
}

function toolFeedbackAttributionStrength(
  outcome: FeedbackOutcome,
): "observed_feedback" | "positive_attribution" | "strong_counter_signal" {
  if (outcome === "positive") return "positive_attribution";
  if (outcome === "negative") return "strong_counter_signal";
  return "observed_feedback";
}

export function buildLiteToolFeedbackAppend(args: Readonly<{
  source: LiteLearningFeedbackSource;
  operationId: string | null;
  runId: string;
  sourceCommitId: string;
  requestSha256: string;
  operationReceiptSha256: string | null;
  runLifecycleRowidCutoffs: {
    decision_rowid_cutoff: number;
    feedback_rowid_cutoff: number;
  } | null;
  decisionId: string;
  outcome: FeedbackOutcome;
  recordedAt: string;
}>): LiteLearningFeedbackAppend {
  const sourceId = args.operationId ?? args.sourceCommitId;
  const eventId = liteToolFeedbackEventId({
    tenantId: args.source.event.tenant_id,
    scope: args.source.event.scope,
    operationId: args.operationId,
    sourceCommitId: args.sourceCommitId,
  });
  const attribution = emptyAuthorityRow("lite_learning_feedback_attributions");
  Object.assign(attribution, {
    tenant_id: args.source.event.tenant_id,
    scope: args.source.event.scope,
    event_id: eventId,
    episode_id: args.source.event.episode_id,
    subject_kind: "tool_decision",
    subject_id: args.decisionId,
    outcome: args.outcome,
    action_outcome: null,
    used_surface: null,
    exposure_action: null,
    boundary_outcome: "not_applicable",
    attribution_strength: toolFeedbackAttributionStrength(args.outcome),
    evidence_class: "tool_decision",
    host_use_receipt_id: null,
    host_use_receipt_sha256: null,
    receipt_item_sha256: null,
    host_task_envelope_sha256: null,
    collection_principal_sha256: null,
    collector_id: null,
    collector_version: null,
    content_evidence_sha256: null,
    verifier_kind: null,
    verifier_version: null,
    verifier_config_sha256: null,
    verifier_status: null,
    tool_status: null,
    runtime_signal_refs_sha256: null,
    item_sha256: "0".repeat(64),
  });
  attribution.item_sha256 = learningFeedbackAttributionItemDigest(attribution);
  const attributions = [attribution] as const;
  const payload = FeedbackAttributedV1Schema.parse({
    contract_version: "aionis_learning_feedback_v1",
    feedback_kind: "tool_selection",
    guide_trace_id: args.source.payload.guide_trace_id,
    request_sha256: args.requestSha256,
    operation_protection: args.operationId ? "protected" : "legacy_unprotected",
    operation_receipt_sha256: args.operationReceiptSha256,
    run_id: args.runId,
    source_commit_id: args.sourceCommitId,
    ...(args.runLifecycleRowidCutoffs ? {
      run_lifecycle_decision_rowid_cutoff: args.runLifecycleRowidCutoffs.decision_rowid_cutoff,
      run_lifecycle_feedback_rowid_cutoff: args.runLifecycleRowidCutoffs.feedback_rowid_cutoff,
    } : {}),
    host_use_receipt_sha256: null,
    runtime_signal_refs: [],
    unused_exposure_ids: [],
  });
  const event: EventWithoutDigest = {
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: args.source.event.tenant_id,
    scope: args.source.event.scope,
    event_id: eventId,
    episode_id: args.source.event.episode_id,
    episode_sequence: args.source.headSequence + 1,
    event_kind: "feedback_attributed",
    source_kind: "tool_feedback_operation",
    source_id: sourceId,
    source_sha256: args.requestSha256,
    previous_event_sha256: args.source.headEventSha256,
    payload_sha256: sha256Hex(stableStringify(payload)),
    item_set_sha256: learningFeedbackAttributionSetDigest(attributions),
    source_commit_id: args.sourceCommitId,
    supersedes_event_id: null,
    operation_id: args.operationId,
    run_id: args.runId,
    collection_class: args.source.event.collection_class,
    recorded_at: args.recordedAt,
  };
  return {
    event,
    eventRow: buildFeedbackEventRow({ source: args.source, event, payload }),
    payload,
    attributions,
    hostUseReceipt: null,
    boundaryIgnoredMemoryIds: [],
  };
}

export async function appendLiteLearningFeedback(
  ledger: LiteLearningEpisodeLedgerAccess,
  append: LiteLearningFeedbackAppend,
): ReturnType<LiteLearningEpisodeLedgerAccess["appendEpisodeEvent"]> {
  return await ledger.appendEpisodeEvent({
    row: append.eventRow,
    event: append.event,
    payload: append.payload,
    feedbackAttributions: append.attributions,
    hostUseReceipt: append.hostUseReceipt,
  });
}
