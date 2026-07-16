import stableStringify from "fast-json-stable-stringify";

import {
  LearningEpisodeEventWithoutDigestSchema,
  LearningEpisodePayloadV1Schema,
  learningEpisodeEventDigest,
  learningEpisodeId,
  type EffectMeasuredV1,
  type EventWithoutDigest,
  type FreshEffectMeasuredV1,
  type HostTaskEnvelopeV1,
} from "../memory/learning-episode-ledger.js";
import { sha256Hex } from "../util/crypto.js";
import type { LiteLearningAuthorityRow } from "./lite-learning-confirmatory-authority.js";
import { resolveLiteLearningFeedbackSource } from "./lite-learning-feedback-source.js";
import {
  resolveLiteLearningProtectedPositiveToolFeedbackAuthority,
  type LiteLearningProtectedToolFeedbackAuthorityResolution,
} from "./lite-learning-safety-stop-integrity.js";
import {
  PRODUCT_MEASURE_OPERATION_KIND,
  PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX,
  PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
  assertProductMeasureReceiptAuthority,
  parseProductMeasureOperationEvidenceReference,
  productMeasurementFromDbRecord,
  type LiteProductMeasureOperationRecord,
  type LiteProductMeasurementDbRecord,
} from "./lite-product-measurement-record.js";
import type { ProductMeasurementRecord } from "./memory-store.js";
import type { SqliteDatabase } from "./sqlite.js";

export type LiteLearningMeasurementEpisodeExposure = Readonly<{
  guideTraceId: string;
  episodeId: string;
  eventId: string;
  eventSha256: string;
  recordedAt: string;
  runId: string;
  headSequence: number;
  headEventSha256: string;
  collectionClass: EventWithoutDigest["collection_class"];
  collectionPrincipalSha256: string | null;
  collectorId: string | null;
  collectorVersion: string | null;
  experimentId: string | null;
  experimentRevision: number | null;
  candidatePolicyId: string | null;
  candidatePolicyVersion: string | null;
  hostTaskEnvelope: Readonly<Pick<
    HostTaskEnvelopeV1,
    | "host_task_id"
    | "task_signature"
    | "task_family"
    | "repository_signature"
    | "source_task_sha256"
  >> | null;
  hostTaskIdentitySha256: string | null;
  promotionEligible: boolean;
  eventRow: LiteLearningAuthorityRow;
}>;

export type LiteLearningMeasurementProvenanceReasonCode =
  | "baseline_not_eligible_host"
  | "after_not_eligible_host"
  | "collection_principal_missing"
  | "collection_principal_mismatch"
  | "collector_mismatch"
  | "experiment_identity_missing"
  | "experiment_identity_mismatch"
  | "candidate_policy_mismatch"
  | "baseline_host_task_envelope_missing"
  | "after_host_task_envelope_missing"
  | "host_task_id_mismatch"
  | "task_signature_mismatch"
  | "task_family_mismatch"
  | "host_task_identity_mismatch"
  | "baseline_not_promotion_eligible"
  | "after_not_promotion_eligible";

export type LiteLearningMeasurementEpisodePairAvailable = Readonly<{
  status: "available";
  baseline: LiteLearningMeasurementEpisodeExposure;
  after: LiteLearningMeasurementEpisodeExposure;
  provenance: Readonly<{
    collectionClass: "eligible_host" | "unverified";
    collectionPrincipalSha256: string | null;
    experimentId: string | null;
    experimentRevision: number | null;
    promotionEligible: boolean;
    reasonCodes: readonly LiteLearningMeasurementProvenanceReasonCode[];
  }>;
}>;

export type LiteLearningMeasurementEpisodePairUnavailableReason =
  | "baseline_exposure_missing"
  | "after_exposure_missing"
  | "episode_ids_not_distinct"
  | "exposure_order_invalid"
  | "exposure_run_missing"
  | "exposure_run_mismatch";

export type LiteLearningMeasurementEpisodePairResolution =
  | LiteLearningMeasurementEpisodePairAvailable
  | Readonly<{
      status: "unavailable";
      baselineEpisodeId: string;
      afterEpisodeId: string;
      reasonCode: LiteLearningMeasurementEpisodePairUnavailableReason;
    }>;

export type LiteLearningMeasurementEffectAuthorityResolution =
  | Readonly<{
      status: "available";
      measurementId: string;
      measurementDigest: string;
      measurementRecordSha256: string;
      effectEventId: string;
      episodeId: string;
      operationId: string;
    }>
  | Readonly<{
      status: "unavailable";
      reasonCode:
        | "measurement_missing"
        | "measurement_digest_mismatch"
        | "measurement_not_export_eligible"
        | "effect_missing"
        | "effect_receipt_authority_missing";
    }>;

type MeasurementExposureCandidate = Omit<LiteLearningMeasurementEpisodeExposure, "runId"> & {
  runId: string | null;
};

type LiteLearningMeasurementAuthorityDependencies = Readonly<{
  eventColumns: readonly string[];
  assertEventRowShape(row: LiteLearningAuthorityRow): void;
}>;

export const EFFECT_EXPECTED_V1_EVIDENCE_PREFIX = "effect_expected_v1:";

export function effectExpectedV1EvidenceReference(args: Readonly<{
  tenantId: string;
  scope: string;
  measurementId: string;
  baselineEpisodeId: string;
  afterEpisodeId: string;
}>): string {
  if (!args.tenantId || !args.scope || !args.measurementId
    || !args.baselineEpisodeId || !args.afterEpisodeId
    || args.baselineEpisodeId === args.afterEpisodeId) {
    throw new Error("measurement effect expectation has invalid episode identity");
  }
  return `${EFFECT_EXPECTED_V1_EVIDENCE_PREFIX}${sha256Hex(stableStringify({
    contract_version: "aionis_learning_effect_expected_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    measurement_id: args.measurementId,
    baseline_episode_id: args.baselineEpisodeId,
    after_episode_id: args.afterEpisodeId,
  }))}`;
}

function assertEffectExpectedV1Evidence(measurement: ProductMeasurementRecord): void {
  const expectedRefs = measurement.runtime_evidence_ids.filter((value) =>
    value.startsWith(EFFECT_EXPECTED_V1_EVIDENCE_PREFIX)
  );
  const exactRef = measurement.baseline_episode_id && measurement.after_episode_id
    ? effectExpectedV1EvidenceReference({
        tenantId: measurement.tenant_id,
        scope: measurement.scope,
        measurementId: measurement.measurement_id,
        baselineEpisodeId: measurement.baseline_episode_id,
        afterEpisodeId: measurement.after_episode_id,
      })
    : null;
  if (measurement.source !== "product_trace"
    || measurement.evidence_status !== "sufficient"
    || expectedRefs.length !== 1
    || expectedRefs[0] !== exactRef) {
    throw new Error("product measurement has invalid effect expectation evidence");
  }
}

function requiredString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function nullableAuthorityString(row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`learning measurement exposure has invalid ${field}`);
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return Buffer.from(left).equals(Buffer.from(right));
  }
  if (typeof left === "bigint" || typeof right === "bigint") {
    try {
      return BigInt(left as bigint | number | string) === BigInt(right as bigint | number | string);
    } catch {
      return false;
    }
  }
  return left === right;
}

function assertProtectedProductMeasureReceipt(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    operationId: string;
    operationReceiptSha256: string;
    measurement: ReturnType<typeof productMeasurementFromDbRecord>;
  }>,
): void {
  const operation = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    PRODUCT_MEASURE_OPERATION_KIND,
    args.operationId,
  ) as LiteProductMeasureOperationRecord | undefined;
  const authority = db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations
     WHERE tenant_id = ? AND scope = ? AND operation_kind = ? AND operation_id = ?`,
  ).get(
    args.tenantId,
    args.scope,
    PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
    args.operationId,
  ) as LiteProductMeasureOperationRecord | undefined;
  if (!operation) throw new Error("protected effect requires a product measure operation");
  try {
    assertProductMeasureReceiptAuthority({
      originalOperation: operation,
      authorityOperation: authority ?? null,
      measurement: args.measurement,
      expectedOperationReceiptSha256: args.operationReceiptSha256,
    });
  } catch (error) {
    throw new Error("protected effect requires its exact product measure receipt authority", {
      cause: error,
    });
  }
}

function measurementIdFromProductMeasureReceipt(receiptJson: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(receiptJson);
  } catch {
    throw new Error("product measure receipt authority has invalid source JSON");
  }
  const body = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>).body
    : null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("product measure receipt authority has no source body");
  }
  return requiredString(body as Record<string, unknown>, "measurement_id");
}

function productMeasureAuthorityKey(tenantId: string, scope: string, operationId: string): string {
  return stableStringify([tenantId, scope, operationId]);
}

function productMeasureOperationKey(row: LiteProductMeasureOperationRecord): string {
  return productMeasureAuthorityKey(row.tenant_id, row.scope, row.operation_id);
}

export function assertProductMeasureReceiptAuthoritySetIntegrity(db: SqliteDatabase): void {
  const selectOperations = (operationKind: string): LiteProductMeasureOperationRecord[] => db.prepare(
    `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
            receipt_json, commit_id, created_at
     FROM lite_runtime_write_operations WHERE operation_kind = ?
     ORDER BY tenant_id, scope, operation_id`,
  ).all(operationKind) as LiteProductMeasureOperationRecord[];
  const operations = selectOperations(PRODUCT_MEASURE_OPERATION_KIND);
  const authorityByOperation = new Map(selectOperations(
    PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
  ).map((row) => [productMeasureOperationKey(row), row]));
  const markedMeasurementRows = db.prepare(
    `SELECT measurement.* FROM lite_product_measurements AS measurement
     WHERE EXISTS (
       SELECT 1 FROM json_each(measurement.runtime_evidence_ids_json) AS evidence
       WHERE evidence.type = 'text' AND substr(evidence.value, 1, ?) = ?
     )
     ORDER BY measurement.tenant_id, measurement.scope, measurement.measurement_id`,
  ).all(
    PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX.length,
    PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX,
  ) as LiteProductMeasurementDbRecord[];
  const measurementByOperation = new Map<string, ReturnType<typeof productMeasurementFromDbRecord>>();
  for (const row of markedMeasurementRows) {
    const measurement = productMeasurementFromDbRecord(row);
    const encodedRefs = measurement.runtime_evidence_ids.filter((value) =>
      value.startsWith(PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX)
    );
    const reference = encodedRefs.length === 1
      ? parseProductMeasureOperationEvidenceReference(encodedRefs[0]!)
      : null;
    if (!reference) throw new Error("product measurement has invalid operation authority evidence");
    const key = productMeasureAuthorityKey(
      measurement.tenant_id,
      measurement.scope,
      reference.operationId,
    );
    if (measurementByOperation.has(key)) {
      throw new Error("product measure operation authority resolves to multiple measurements");
    }
    measurementByOperation.set(key, measurement);
  }
  const effectExpectedMeasurementRows = db.prepare(
    `SELECT measurement.* FROM lite_product_measurements AS measurement
     WHERE EXISTS (
       SELECT 1 FROM json_each(measurement.runtime_evidence_ids_json) AS evidence
       WHERE evidence.type = 'text' AND substr(evidence.value, 1, ?) = ?
     )
     ORDER BY measurement.tenant_id, measurement.scope, measurement.measurement_id`,
  ).all(
    EFFECT_EXPECTED_V1_EVIDENCE_PREFIX.length,
    EFFECT_EXPECTED_V1_EVIDENCE_PREFIX,
  ) as LiteProductMeasurementDbRecord[];
  for (const row of effectExpectedMeasurementRows) {
    const measurement = productMeasurementFromDbRecord(row);
    assertEffectExpectedV1Evidence(measurement);
    const effectCount = Number((db.prepare(
      `SELECT COUNT(*) AS count FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_kind = 'effect_measured'
         AND source_kind = 'product_measurement' AND source_id = ?`,
    ).get(measurement.tenant_id, measurement.scope, measurement.measurement_id) as
      | { count: number }
      | undefined)?.count ?? 0);
    if (effectCount !== 1) {
      throw new Error("product measurement effect expectation cardinality is invalid");
    }
  }
  if (operations.length !== authorityByOperation.size
    || operations.length !== measurementByOperation.size) {
    throw new Error("product measure receipt authority set is not one-to-one");
  }
  for (const operation of operations) {
    const measurementId = measurementIdFromProductMeasureReceipt(operation.receipt_json);
    const key = productMeasureOperationKey(operation);
    const measurement = measurementByOperation.get(key);
    const operationEvidence = measurement?.runtime_evidence_ids
      .map(parseProductMeasureOperationEvidenceReference)
      .find((value) => value?.operationId === operation.operation_id) ?? null;
    if (!measurement
      || measurement.measurement_id !== measurementId
      || operationEvidence?.requestSha256 !== operation.request_sha256) {
      throw new Error("product measure receipt authority measurement identity is missing or invalid");
    }
    assertProductMeasureReceiptAuthority({
      originalOperation: operation,
      authorityOperation: authorityByOperation.get(key) ?? null,
      measurement,
    });
    const effectCount = Number((db.prepare(
      `SELECT COUNT(*) AS count FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_kind = 'effect_measured'
         AND source_kind = 'product_measurement' AND source_id = ?`,
    ).get(operation.tenant_id, operation.scope, measurement.measurement_id) as
      | { count: number }
      | undefined)?.count ?? 0);
    const requiresEffect = measurement.source === "product_trace"
      && measurement.evidence_status === "sufficient"
      && measurement.baseline_episode_id !== null
      && measurement.after_episode_id !== null;
    if (effectCount !== (requiresEffect ? 1 : 0)) {
      throw new Error("product measurement effect authority cardinality is invalid");
    }
    authorityByOperation.delete(key);
    measurementByOperation.delete(key);
  }
  const duplicateEffectAuthority = db.prepare(
    `SELECT 1 FROM lite_learning_episode_events
     WHERE event_kind = 'effect_measured' AND source_kind = 'product_measurement'
     GROUP BY tenant_id, scope, source_id HAVING COUNT(*) > 1 LIMIT 1`,
  ).get();
  if (authorityByOperation.size !== 0 || measurementByOperation.size !== 0) {
    throw new Error("product measure receipt authority set contains an orphan root");
  }
  if (duplicateEffectAuthority) throw new Error("product measurement has ambiguous effect authority");
}

function digestEvidenceReference(
  value: string,
  prefix: "tool_feedback_event:" | "tool_feedback_receipt:",
): Readonly<{ id: string; sha256: string }> | null {
  if (!value.startsWith(prefix)) return null;
  const binding = value.slice(prefix.length);
  const separator = binding.lastIndexOf(":");
  const id = separator > 0 ? binding.slice(0, separator) : "";
  const sha256 = separator > 0 ? binding.slice(separator + 1) : "";
  return id.length > 0 && /^[0-9a-f]{64}$/u.test(sha256)
    ? { id, sha256 }
    : null;
}

function measurementToolFeedbackEvidence(
  runtimeEvidenceIds: readonly string[],
): Readonly<{
  eventId: string;
  eventSha256: string;
  operationId: string;
  operationReceiptSha256: string;
}> | null {
  const eventRefs = runtimeEvidenceIds.filter((value) => value.startsWith("tool_feedback_event:"));
  const receiptRefs = runtimeEvidenceIds.filter((value) => value.startsWith("tool_feedback_receipt:"));
  if (eventRefs.length !== 1 || receiptRefs.length !== 1) return null;
  const event = digestEvidenceReference(eventRefs[0]!, "tool_feedback_event:");
  const receipt = digestEvidenceReference(receiptRefs[0]!, "tool_feedback_receipt:");
  return event && receipt
    ? {
        eventId: event.id,
        eventSha256: event.sha256,
        operationId: receipt.id,
        operationReceiptSha256: receipt.sha256,
      }
    : null;
}

export function assertMeasurementToolFeedbackAuthorityBinding(args: Readonly<{
  runtimeEvidenceIds: readonly string[];
  measurementCreatedAt: string;
  effectRecordedAt: string;
  authority: Extract<
    LiteLearningProtectedToolFeedbackAuthorityResolution,
    Readonly<{ status: "available" }>
  >;
}>): void {
  const evidence = measurementToolFeedbackEvidence(args.runtimeEvidenceIds);
  if (evidence === null) {
    throw new Error("export-eligible measurement effect lacks exact tool feedback evidence refs");
  }
  if (args.authority.eventId !== evidence.eventId
    || args.authority.eventSha256 !== evidence.eventSha256
    || args.authority.operationId !== evidence.operationId
    || args.authority.operationReceiptSha256 !== evidence.operationReceiptSha256) {
    throw new Error("export-eligible measurement effect tool feedback evidence was replaced");
  }
  if (args.authority.recordedAt > args.measurementCreatedAt
    || args.measurementCreatedAt > args.effectRecordedAt) {
    throw new Error("export-eligible measurement effect feedback and measurement time order is invalid");
  }
}

function eventFromRow(row: LiteLearningAuthorityRow): EventWithoutDigest {
  return LearningEpisodeEventWithoutDigestSchema.parse({
    contract_version: "aionis_learning_episode_event_v1",
    tenant_id: row.tenant_id,
    scope: row.scope,
    event_id: row.event_id,
    episode_id: row.episode_id,
    episode_sequence: row.episode_sequence,
    event_kind: row.event_kind,
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_sha256: row.source_sha256,
    previous_event_sha256: row.previous_event_sha256,
    payload_sha256: row.payload_sha256,
    item_set_sha256: row.item_set_sha256,
    source_commit_id: row.source_commit_id,
    supersedes_event_id: row.supersedes_event_id,
    operation_id: row.operation_id,
    run_id: row.run_id,
    collection_class: row.collection_class,
    recorded_at: row.recorded_at,
  });
}

function effectPayloadFromRow(
  row: LiteLearningAuthorityRow,
  event: EventWithoutDigest,
): EffectMeasuredV1 {
  const payloadJson = requiredString(row, "payload_json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson);
  } catch {
    throw new Error("measurement effect payload is invalid JSON");
  }
  if (stableStringify(decoded) !== payloadJson
    || sha256Hex(payloadJson) !== event.payload_sha256
    || row.event_sha256 !== learningEpisodeEventDigest(event)) {
    throw new Error("measurement effect event or payload digest mismatch");
  }
  const payload = LearningEpisodePayloadV1Schema.parse(decoded);
  if (event.event_kind !== "effect_measured"
    || payload.contract_version !== "aionis_learning_effect_v1") {
    throw new Error("measurement effect authority requires an effect event");
  }
  return payload;
}

function measurementExposureCandidate(
  source: NonNullable<ReturnType<typeof resolveLiteLearningFeedbackSource>>,
): MeasurementExposureCandidate {
  const experimentRevision = source.eventRow.experiment_revision;
  if (experimentRevision !== null
    && (typeof experimentRevision !== "number"
      || !Number.isSafeInteger(experimentRevision)
      || experimentRevision < 1)) {
    throw new Error("learning measurement exposure has invalid experiment_revision");
  }
  return {
    guideTraceId: source.payload.guide_trace_id,
    episodeId: source.event.episode_id,
    eventId: source.event.event_id,
    eventSha256: requiredString(source.eventRow, "event_sha256"),
    recordedAt: source.event.recorded_at,
    runId: source.event.run_id,
    headSequence: source.headSequence,
    headEventSha256: source.headEventSha256,
    collectionClass: source.event.collection_class,
    collectionPrincipalSha256: nullableAuthorityString(
      source.eventRow,
      "collection_principal_sha256",
    ),
    collectorId: nullableAuthorityString(source.eventRow, "collector_id"),
    collectorVersion: nullableAuthorityString(source.eventRow, "collector_version"),
    experimentId: nullableAuthorityString(source.eventRow, "experiment_id"),
    experimentRevision: experimentRevision as number | null,
    candidatePolicyId: nullableAuthorityString(source.eventRow, "candidate_policy_id"),
    candidatePolicyVersion: nullableAuthorityString(source.eventRow, "candidate_policy_version"),
    hostTaskEnvelope: source.payload.host_task_envelope === null
      ? null
      : {
          host_task_id: source.payload.host_task_envelope.host_task_id,
          task_signature: source.payload.host_task_envelope.task_signature,
          task_family: source.payload.host_task_envelope.task_family,
          repository_signature: source.payload.host_task_envelope.repository_signature,
          source_task_sha256: source.payload.host_task_envelope.source_task_sha256,
        },
    hostTaskIdentitySha256: source.payload.host_task_envelope === null
      ? null
      : sha256Hex(stableStringify({
          host_task_id: source.payload.host_task_envelope.host_task_id,
          task_signature: source.payload.host_task_envelope.task_signature,
          task_family: source.payload.host_task_envelope.task_family,
          repository_signature: source.payload.host_task_envelope.repository_signature,
          source_task_sha256: source.payload.host_task_envelope.source_task_sha256,
        })),
    promotionEligible: Number(source.eventRow.promotion_eligible) === 1,
    eventRow: source.eventRow,
  };
}

function measurementExposureByEpisodeId(
  db: SqliteDatabase,
  args: Readonly<{ tenantId: string; scope: string; episodeId: string }>,
): MeasurementExposureCandidate | null {
  const identity = db.prepare(
    `SELECT source_id FROM lite_learning_episode_events
     WHERE tenant_id = ? AND scope = ? AND episode_id = ?
       AND event_kind = 'exposure_committed'`,
  ).get(args.tenantId, args.scope, args.episodeId) as { source_id: unknown } | undefined;
  if (!identity) return null;
  if (typeof identity.source_id !== "string" || identity.source_id.length === 0) {
    throw new Error("learning measurement exposure has invalid guide trace identity");
  }
  const expectedEpisodeId = learningEpisodeId({
    tenantId: args.tenantId,
    scope: args.scope,
    guideTraceId: identity.source_id,
  });
  if (expectedEpisodeId !== args.episodeId) {
    throw new Error("learning measurement exposure deterministic episode identity mismatch");
  }
  const source = resolveLiteLearningFeedbackSource(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    guideTraceId: identity.source_id,
  });
  if (!source || source.event.episode_id !== args.episodeId) {
    throw new Error("learning measurement exposure could not be resolved exactly");
  }
  return measurementExposureCandidate(source);
}

function measurementProvenance(
  baseline: LiteLearningMeasurementEpisodeExposure,
  after: LiteLearningMeasurementEpisodeExposure,
): LiteLearningMeasurementEpisodePairAvailable["provenance"] {
  const reasonCodes: LiteLearningMeasurementProvenanceReasonCode[] = [];
  if (baseline.collectionClass !== "eligible_host") reasonCodes.push("baseline_not_eligible_host");
  if (after.collectionClass !== "eligible_host") reasonCodes.push("after_not_eligible_host");
  if (baseline.collectionPrincipalSha256 === null || after.collectionPrincipalSha256 === null) {
    reasonCodes.push("collection_principal_missing");
  } else if (baseline.collectionPrincipalSha256 !== after.collectionPrincipalSha256) {
    reasonCodes.push("collection_principal_mismatch");
  }
  if (baseline.collectorId !== after.collectorId
    || baseline.collectorVersion !== after.collectorVersion) {
    reasonCodes.push("collector_mismatch");
  }
  if (baseline.experimentId === null || after.experimentId === null
    || baseline.experimentRevision === null || after.experimentRevision === null) {
    reasonCodes.push("experiment_identity_missing");
  } else if (baseline.experimentId !== after.experimentId
    || baseline.experimentRevision !== after.experimentRevision) {
    reasonCodes.push("experiment_identity_mismatch");
  }
  if (baseline.candidatePolicyId !== after.candidatePolicyId
    || baseline.candidatePolicyVersion !== after.candidatePolicyVersion) {
    reasonCodes.push("candidate_policy_mismatch");
  }
  if (baseline.hostTaskEnvelope === null) reasonCodes.push("baseline_host_task_envelope_missing");
  if (after.hostTaskEnvelope === null) reasonCodes.push("after_host_task_envelope_missing");
  if (baseline.hostTaskEnvelope !== null && after.hostTaskEnvelope !== null) {
    if (baseline.hostTaskEnvelope.host_task_id !== after.hostTaskEnvelope.host_task_id) {
      reasonCodes.push("host_task_id_mismatch");
    }
    if (baseline.hostTaskEnvelope.task_signature !== after.hostTaskEnvelope.task_signature) {
      reasonCodes.push("task_signature_mismatch");
    }
    if (baseline.hostTaskEnvelope.task_family !== after.hostTaskEnvelope.task_family) {
      reasonCodes.push("task_family_mismatch");
    }
    if (baseline.hostTaskIdentitySha256 !== after.hostTaskIdentitySha256) {
      reasonCodes.push("host_task_identity_mismatch");
    }
  }
  if (!baseline.promotionEligible) reasonCodes.push("baseline_not_promotion_eligible");
  if (!after.promotionEligible) reasonCodes.push("after_not_promotion_eligible");
  const promotionEligible = reasonCodes.length === 0;
  return {
    collectionClass: promotionEligible ? "eligible_host" : "unverified",
    collectionPrincipalSha256: promotionEligible ? baseline.collectionPrincipalSha256 : null,
    experimentId: promotionEligible ? baseline.experimentId : null,
    experimentRevision: promotionEligible ? baseline.experimentRevision : null,
    promotionEligible,
    reasonCodes,
  };
}

function resolveLiteLearningMeasurementEpisodePairByEpisodeIds(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    baselineEpisodeId: string;
    afterEpisodeId: string;
  }>,
): LiteLearningMeasurementEpisodePairResolution {
  const unavailable = (
    reasonCode: LiteLearningMeasurementEpisodePairUnavailableReason,
  ): LiteLearningMeasurementEpisodePairResolution => ({
    status: "unavailable",
    baselineEpisodeId: args.baselineEpisodeId,
    afterEpisodeId: args.afterEpisodeId,
    reasonCode,
  });
  if (args.baselineEpisodeId === args.afterEpisodeId) return unavailable("episode_ids_not_distinct");
  const baselineCandidate = measurementExposureByEpisodeId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.baselineEpisodeId,
  });
  if (!baselineCandidate) return unavailable("baseline_exposure_missing");
  const afterCandidate = measurementExposureByEpisodeId(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: args.afterEpisodeId,
  });
  if (!afterCandidate) return unavailable("after_exposure_missing");
  if (baselineCandidate.recordedAt >= afterCandidate.recordedAt) {
    return unavailable("exposure_order_invalid");
  }
  if (baselineCandidate.runId === null || afterCandidate.runId === null) {
    return unavailable("exposure_run_missing");
  }
  if (baselineCandidate.runId !== afterCandidate.runId) {
    return unavailable("exposure_run_mismatch");
  }
  const baseline: LiteLearningMeasurementEpisodeExposure = {
    ...baselineCandidate,
    runId: baselineCandidate.runId,
  };
  const after: LiteLearningMeasurementEpisodeExposure = {
    ...afterCandidate,
    runId: afterCandidate.runId,
  };
  return {
    status: "available",
    baseline,
    after,
    provenance: measurementProvenance(baseline, after),
  };
}

export function resolveLiteLearningMeasurementEpisodePair(
  db: SqliteDatabase,
  args: Readonly<{
    tenantId: string;
    scope: string;
    baselineGuideTraceId: string;
    afterGuideTraceId: string;
  }>,
): LiteLearningMeasurementEpisodePairResolution {
  return resolveLiteLearningMeasurementEpisodePairByEpisodeIds(db, {
    tenantId: args.tenantId,
    scope: args.scope,
    baselineEpisodeId: learningEpisodeId({
      tenantId: args.tenantId,
      scope: args.scope,
      guideTraceId: args.baselineGuideTraceId,
    }),
    afterEpisodeId: learningEpisodeId({
      tenantId: args.tenantId,
      scope: args.scope,
      guideTraceId: args.afterGuideTraceId,
    }),
  });
}

export function createLiteLearningMeasurementAuthority(
  dependencies: LiteLearningMeasurementAuthorityDependencies,
): Readonly<{
  buildEffectEventRow(args: {
    event: EventWithoutDigest;
    payload: FreshEffectMeasuredV1;
    pair: LiteLearningMeasurementEpisodePairAvailable;
  }): LiteLearningAuthorityRow;
  validateEffectMeasurement(
    db: SqliteDatabase,
    event: EventWithoutDigest,
    row: LiteLearningAuthorityRow,
    payload: EffectMeasuredV1,
  ): void;
  resolveMeasurementEffectAuthority(
    db: SqliteDatabase,
    args: Readonly<{
      tenantId: string;
      scope: string;
      measurementId: string;
      measurementDigest: string;
    }>,
  ): LiteLearningMeasurementEffectAuthorityResolution;
  assertMeasurementOperationReceiptAuthority(
    db: SqliteDatabase,
    args: Readonly<{
      tenantId: string;
      scope: string;
      measurementId: string;
      operationId: string;
      operationReceiptSha256: string;
    }>,
  ): void;
}> {
  const eventColumns = [...dependencies.eventColumns];
  const buildEffectEventRow = (args: {
    event: EventWithoutDigest;
    payload: FreshEffectMeasuredV1;
    pair: LiteLearningMeasurementEpisodePairAvailable;
  }): LiteLearningAuthorityRow => {
    const event = LearningEpisodeEventWithoutDigestSchema.parse(args.event);
    const payload = LearningEpisodePayloadV1Schema.parse(args.payload) as EffectMeasuredV1;
    const payloadJson = stableStringify(payload);
    const emptyItemSetSha256 = sha256Hex(stableStringify([]));
    if (event.event_kind !== "effect_measured"
      || event.source_kind !== "product_measurement"
      || payload.contract_version !== "aionis_learning_effect_v1") {
      throw new Error("measurement effect row builder accepts product measurement effects only");
    }
    if (payload.operation_receipt_sha256 === undefined) {
      throw new Error("new measurement effect requires an explicit operation receipt binding");
    }
    if (event.tenant_id !== args.pair.after.eventRow.tenant_id
      || event.scope !== args.pair.after.eventRow.scope
      || event.episode_id !== args.pair.after.episodeId
      || event.episode_sequence !== args.pair.after.headSequence + 1
      || event.previous_event_sha256 !== args.pair.after.headEventSha256
      || event.source_id !== payload.measurement_id
      || event.source_sha256 !== payload.measurement_record_sha256
      || event.payload_sha256 !== sha256Hex(payloadJson)
      || event.item_set_sha256 !== emptyItemSetSha256
      || event.source_commit_id !== null
      || event.supersedes_event_id !== null
      || event.run_id !== args.pair.after.runId
      || event.collection_class !== args.pair.provenance.collectionClass
      || payload.baseline_episode_id !== args.pair.baseline.episodeId
      || payload.after_episode_id !== args.pair.after.episodeId
      || event.recorded_at < args.pair.after.recordedAt) {
      throw new Error("measurement effect event does not match its authoritative episode pair");
    }
    if (payload.eligible_for_skill_export && !args.pair.provenance.promotionEligible) {
      throw new Error("measurement effect cannot export from unverified episode provenance");
    }
    if (payload.eligible_for_skill_export && event.operation_id === null) {
      throw new Error("export-eligible measurement effect requires a protected operation id");
    }
    if ((event.operation_id === null) !== (payload.operation_receipt_sha256 === null)) {
      throw new Error("measurement effect operation and receipt digest protection must match");
    }
    const row = Object.fromEntries(
      eventColumns
        .filter((column) => column !== "row_id")
        .map((column) => [column, args.pair.after.eventRow[column] ?? null]),
    ) as LiteLearningAuthorityRow;
    Object.assign(row, {
      tenant_id: event.tenant_id,
      scope: event.scope,
      event_id: event.event_id,
      episode_id: event.episode_id,
      episode_sequence: event.episode_sequence,
      event_kind: event.event_kind,
      source_kind: event.source_kind,
      source_id: event.source_id,
      source_sha256: event.source_sha256,
      previous_event_sha256: event.previous_event_sha256,
      event_sha256: learningEpisodeEventDigest(event),
      payload_sha256: event.payload_sha256,
      payload_json: payloadJson,
      item_set_sha256: event.item_set_sha256,
      source_commit_id: event.source_commit_id,
      supersedes_event_id: event.supersedes_event_id,
      operation_id: event.operation_id,
      run_id: event.run_id,
      collection_class: event.collection_class,
      promotion_eligible: 0,
      recorded_at: event.recorded_at,
    });
    dependencies.assertEventRowShape(row);
    return row;
  };

  const validateEffectMeasurement = (
    db: SqliteDatabase,
    event: EventWithoutDigest,
    row: LiteLearningAuthorityRow,
    payload: EffectMeasuredV1,
  ): void => {
    if (event.item_set_sha256 !== sha256Hex(stableStringify([]))) {
      throw new Error("effect measurement events require the canonical empty item set");
    }
    const measurement = db.prepare(
      `SELECT measurement_id, tenant_id, scope, source, measurement_digest,
              effect_report_json, eligible_for_skill_export, evidence_status,
              runtime_evidence_ids_json, eligibility_reasons_json, created_by,
              created_at, baseline_episode_id, after_episode_id, record_sha256
       FROM lite_product_measurements WHERE measurement_id = ?`,
    ).get(payload.measurement_id) as LiteProductMeasurementDbRecord | undefined;
    if (!measurement) {
      throw new Error("effect event does not match its immutable product measurement");
    }
    const operationReceiptSha256 = payload.operation_receipt_sha256;
    const isLegacyEffectReceipt = operationReceiptSha256 === undefined;
    if (isLegacyEffectReceipt) {
      if (measurement.tenant_id !== event.tenant_id
        || measurement.scope !== event.scope
        || measurement.baseline_episode_id !== payload.baseline_episode_id
        || measurement.after_episode_id !== payload.after_episode_id
        || measurement.record_sha256 !== payload.measurement_record_sha256
        || measurement.evidence_status !== payload.evidence_status
        || Number(measurement.eligible_for_skill_export)
          !== (payload.eligible_for_skill_export ? 1 : 0)) {
        throw new Error("historical effect event does not match its v1 product measurement");
      }
      return;
    }
    const persistedMeasurement = productMeasurementFromDbRecord(measurement);
    assertEffectExpectedV1Evidence(persistedMeasurement);
    if (persistedMeasurement.tenant_id !== event.tenant_id
      || persistedMeasurement.scope !== event.scope
      || persistedMeasurement.source !== "product_trace"
      || persistedMeasurement.baseline_episode_id !== payload.baseline_episode_id
      || persistedMeasurement.after_episode_id !== payload.after_episode_id
      || persistedMeasurement.record_sha256 !== payload.measurement_record_sha256
      || persistedMeasurement.evidence_status !== payload.evidence_status
      || persistedMeasurement.eligible_for_skill_export !== payload.eligible_for_skill_export) {
      throw new Error("effect event does not match its immutable product measurement");
    }
    if (payload.evidence_status !== "sufficient") {
      throw new Error("effect event requires a sufficient product-trace measurement");
    }
    const pair = resolveLiteLearningMeasurementEpisodePairByEpisodeIds(db, {
      tenantId: event.tenant_id,
      scope: event.scope,
      baselineEpisodeId: payload.baseline_episode_id,
      afterEpisodeId: payload.after_episode_id,
    });
    if (pair.status === "unavailable") {
      if (pair.reasonCode === "baseline_exposure_missing") {
        throw new Error("effect measurement baseline exposure is missing");
      }
      if (pair.reasonCode === "after_exposure_missing") {
        throw new Error("effect measurement after exposure is missing");
      }
      throw new Error(`effect measurement episode pair is invalid: ${pair.reasonCode}`);
    }
    if (event.source_kind !== "product_measurement"
      || event.source_id !== payload.measurement_id
      || event.source_sha256 !== payload.measurement_record_sha256
      || event.episode_id !== pair.after.episodeId
      || event.run_id !== pair.after.runId
      || event.collection_class !== pair.provenance.collectionClass
      || event.source_commit_id !== null
      || event.supersedes_event_id !== null
      || event.recorded_at < pair.after.recordedAt) {
      throw new Error("effect event does not bind its authoritative measurement episode pair");
    }
    if (payload.eligible_for_skill_export && !pair.provenance.promotionEligible) {
      throw new Error("effect measurement cannot export from unverified episode provenance");
    }
    if ((event.operation_id === null) !== (operationReceiptSha256 === null)) {
      throw new Error("measurement effect operation and receipt digest protection must match");
    }
    if (event.operation_id !== null && operationReceiptSha256 !== null) {
      assertProtectedProductMeasureReceipt(db, {
        tenantId: event.tenant_id,
        scope: event.scope,
        operationId: event.operation_id,
        operationReceiptSha256,
        measurement: persistedMeasurement,
      });
    }
    if (payload.eligible_for_skill_export) {
      if (event.operation_id === null) {
        throw new Error("export-eligible measurement effect requires a protected operation id");
      }
      const feedbackEvidence = measurementToolFeedbackEvidence(
        persistedMeasurement.runtime_evidence_ids,
      );
      if (feedbackEvidence === null) {
        throw new Error("export-eligible measurement effect lacks exact tool feedback evidence refs");
      }
      const feedbackAuthority = resolveLiteLearningProtectedPositiveToolFeedbackAuthority(db, {
        tenantId: event.tenant_id,
        scope: event.scope,
        episodeId: pair.after.episodeId,
        guideTraceId: pair.after.guideTraceId,
        runId: pair.after.runId,
        expectedDecisionId: null,
        expectedEventId: feedbackEvidence.eventId,
        expectedEventSha256: feedbackEvidence.eventSha256,
        expectedOperationId: feedbackEvidence.operationId,
        expectedOperationReceiptSha256: feedbackEvidence.operationReceiptSha256,
      });
      if (feedbackAuthority.status !== "available") {
        throw new Error(
          `export-eligible measurement effect requires protected positive tool feedback: ${feedbackAuthority.reasonCode}`,
        );
      }
      assertMeasurementToolFeedbackAuthorityBinding({
        runtimeEvidenceIds: persistedMeasurement.runtime_evidence_ids,
        measurementCreatedAt: persistedMeasurement.created_at,
        effectRecordedAt: event.recorded_at,
        authority: feedbackAuthority,
      });
    }
    const effectOwnedFields = new Set([
      "row_id", "tenant_id", "scope", "event_id", "episode_id", "episode_sequence",
      "event_kind", "source_kind", "source_id", "source_sha256", "previous_event_sha256",
      "event_sha256", "payload_sha256", "payload_json", "item_set_sha256",
      "source_commit_id", "supersedes_event_id", "operation_id", "run_id",
      "collection_class", "promotion_eligible", "recorded_at",
    ]);
    for (const field of eventColumns) {
      if (!effectOwnedFields.has(field) && !valuesEqual(row[field], pair.after.eventRow[field])) {
        throw new Error(`effect event authority does not inherit after exposure: ${field}`);
      }
    }
    if (Number(row.promotion_eligible) !== 0) {
      throw new Error("effect event cannot claim exposure promotion eligibility");
    }
  };

  const resolveMeasurementEffectAuthority = (
    db: SqliteDatabase,
    args: Readonly<{
      tenantId: string;
      scope: string;
      measurementId: string;
      measurementDigest: string;
    }>,
  ): LiteLearningMeasurementEffectAuthorityResolution => {
    const measurementRow = db.prepare(
      `SELECT * FROM lite_product_measurements
       WHERE tenant_id = ? AND scope = ? AND measurement_id = ?`,
    ).get(args.tenantId, args.scope, args.measurementId) as
      | LiteProductMeasurementDbRecord
      | undefined;
    if (!measurementRow) return { status: "unavailable", reasonCode: "measurement_missing" };
    if (measurementRow.measurement_digest !== args.measurementDigest) {
      return { status: "unavailable", reasonCode: "measurement_digest_mismatch" };
    }
    if (Number(measurementRow.eligible_for_skill_export) !== 1) {
      return { status: "unavailable", reasonCode: "measurement_not_export_eligible" };
    }
    const effectRows = db.prepare(
      `SELECT * FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_kind = 'effect_measured'
         AND source_kind = 'product_measurement' AND source_id = ?
       ORDER BY row_id`,
    ).all(args.tenantId, args.scope, args.measurementId) as LiteLearningAuthorityRow[];
    if (effectRows.length === 0) return { status: "unavailable", reasonCode: "effect_missing" };
    if (effectRows.length !== 1) {
      throw new Error("measurement has ambiguous effect authority");
    }
    const effectRow = effectRows[0]!;
    const event = eventFromRow(effectRow);
    const payload = effectPayloadFromRow(effectRow, event);
    validateEffectMeasurement(db, event, effectRow, payload);
    if (payload.operation_receipt_sha256 === undefined) {
      return { status: "unavailable", reasonCode: "effect_receipt_authority_missing" };
    }
    const measurement = productMeasurementFromDbRecord(measurementRow);
    if (event.operation_id === null || measurement.record_sha256 === null) {
      throw new Error("export-eligible measurement effect authority is incomplete");
    }
    return {
      status: "available",
      measurementId: measurement.measurement_id,
      measurementDigest: measurement.measurement_digest,
      measurementRecordSha256: measurement.record_sha256,
      effectEventId: event.event_id,
      episodeId: event.episode_id,
      operationId: event.operation_id,
    };
  };

  const assertMeasurementOperationReceiptAuthority = (
    db: SqliteDatabase,
    args: Readonly<{
      tenantId: string;
      scope: string;
      measurementId: string;
      operationId: string;
      operationReceiptSha256: string;
    }>,
  ): void => {
    const measurementRow = db.prepare(
      `SELECT * FROM lite_product_measurements
       WHERE tenant_id = ? AND scope = ? AND measurement_id = ?`,
    ).get(args.tenantId, args.scope, args.measurementId) as
      | LiteProductMeasurementDbRecord
      | undefined;
    if (!measurementRow) throw new Error("protected measure receipt measurement is missing");
    const measurement = productMeasurementFromDbRecord(measurementRow);
    assertProtectedProductMeasureReceipt(db, {
      tenantId: args.tenantId,
      scope: args.scope,
      operationId: args.operationId,
      operationReceiptSha256: args.operationReceiptSha256,
      measurement,
    });
    const effectRows = db.prepare(
      `SELECT * FROM lite_learning_episode_events
       WHERE tenant_id = ? AND scope = ? AND event_kind = 'effect_measured'
         AND source_kind = 'product_measurement' AND source_id = ?
       ORDER BY row_id`,
    ).all(args.tenantId, args.scope, args.measurementId) as LiteLearningAuthorityRow[];
    const requiresEffect = measurement.source === "product_trace"
      && measurement.evidence_status === "sufficient"
      && measurement.baseline_episode_id !== null
      && measurement.after_episode_id !== null;
    if (effectRows.length === 0) {
      if (requiresEffect) throw new Error("protected product-trace measurement effect is missing");
      return;
    }
    if (effectRows.length !== 1) throw new Error("protected measurement has ambiguous effect authority");
    const row = effectRows[0]!;
    const event = eventFromRow(row);
    const payload = effectPayloadFromRow(row, event);
    if (event.operation_id !== args.operationId
      || payload.operation_receipt_sha256 !== args.operationReceiptSha256) {
      throw new Error("protected measurement effect does not bind its exact operation receipt");
    }
    validateEffectMeasurement(db, event, row, payload);
  };

  return Object.freeze({
    buildEffectEventRow,
    validateEffectMeasurement,
    resolveMeasurementEffectAuthority,
    assertMeasurementOperationReceiptAuthority,
  });
}
