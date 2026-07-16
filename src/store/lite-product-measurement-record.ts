import stableStringify from "fast-json-stable-stringify";

import { CanonicalLearningUtcTimestampSchema } from "../memory/learning-episode-ledger.js";
import { AionisEffectReportSchema } from "../memory/product-output-contract.js";
import { sha256Hex } from "../util/crypto.js";
import type { ProductMeasurementRecord } from "./memory-store.js";
import {
  productMeasurementDigest,
  productMeasurementRecordDigest,
} from "./memory-store.js";

export const PRODUCT_MEASURE_OPERATION_KIND = "product_measure_v1";
export const PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND =
  "product_measure_receipt_authority_v1";
export const PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX = "product_measure_operation:";
const PRODUCT_MEASURE_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

export type LiteProductMeasureOperationRecord = Readonly<{
  tenant_id: string;
  scope: string;
  operation_kind: string;
  operation_id: string;
  request_sha256: string;
  receipt_json: string;
  commit_id: string | null;
  created_at?: string;
}>;

export type BuiltProductMeasureReceiptAuthority = Readonly<{
  operationKind: typeof PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND;
  requestSha256: string;
  receiptJson: string;
  commitId: null;
  operationReceiptSha256: string;
}>;

export type ProductMeasureOperationEvidenceReference = Readonly<{
  operationId: string;
  requestSha256: string;
}>;

export function productMeasureOperationEvidenceReference(args: Readonly<{
  operationId: string;
  requestSha256: string;
}>): string {
  if (!args.operationId || args.operationId.length > 256) {
    throw new Error("product measure operation evidence has invalid operation id");
  }
  assertDigest(args.requestSha256, "product measure request digest");
  return `${PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX}${args.operationId}:${args.requestSha256}`;
}

export function parseProductMeasureOperationEvidenceReference(
  value: string,
): ProductMeasureOperationEvidenceReference | null {
  if (!value.startsWith(PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX)) return null;
  const binding = value.slice(PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX.length);
  const separator = binding.lastIndexOf(":");
  const operationId = separator > 0 ? binding.slice(0, separator) : "";
  const requestSha256 = separator > 0 ? binding.slice(separator + 1) : "";
  return operationId.length > 0 && operationId.length <= 256 && /^[0-9a-f]{64}$/u.test(requestSha256)
    ? { operationId, requestSha256 }
    : null;
}

export type LiteProductMeasurementDbRecord = Readonly<{
  measurement_id: string;
  tenant_id: string;
  scope: string;
  source: ProductMeasurementRecord["source"];
  measurement_digest: string;
  baseline_episode_id?: string | null;
  after_episode_id?: string | null;
  record_sha256?: string | null;
  effect_report_json: string;
  eligible_for_skill_export: number;
  evidence_status: ProductMeasurementRecord["evidence_status"];
  runtime_evidence_ids_json: string;
  eligibility_reasons_json: string;
  created_by: string;
  created_at: string;
}>;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value as string[]
    : null;
}

export function assertProductMeasureResultMatchesMeasurement(args: Readonly<{
  result: unknown;
  operationId: string;
  measurement: ProductMeasurementRecord;
}>): void {
  const result = objectValue(args.result);
  const body = objectValue(result?.body);
  const evidence = objectValue(body?.evidence_assessment);
  const measurementInput = objectValue(body?.measurement_input);
  const runtimeEvidenceIds = stringArray(evidence?.runtime_evidence_ids);
  const reasons = stringArray(evidence?.reasons);
  const measurement = args.measurement;
  if (result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== "aionis_measure_result_v1"
    || body.operation_id !== args.operationId
    || body.tenant_id !== measurement.tenant_id
    || body.scope !== measurement.scope
    || body.measurement_id !== measurement.measurement_id
    || body.measurement_digest !== measurement.measurement_digest
    || body.measurement_persisted !== true
    || measurementInput?.source !== measurement.source
    || evidence?.status !== measurement.evidence_status
    || evidence.sufficient_evidence !== (measurement.evidence_status === "sufficient")
    || evidence.eligible_for_skill_export !== measurement.eligible_for_skill_export
    || runtimeEvidenceIds === null
    || reasons === null
    || stableStringify(runtimeEvidenceIds) !== stableStringify(measurement.runtime_evidence_ids)
    || stableStringify(reasons) !== stableStringify(measurement.eligibility_reasons)
    || stableStringify(body.effect_report) !== stableStringify(measurement.effect_report)) {
    throw new Error("protected measure receipt does not match its immutable measurement");
  }
}

function assertDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`protected measure receipt authority has invalid ${field}`);
  }
}

function parseCanonicalProductMeasureReceipt(receiptJson: string): unknown {
  if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_MEASURE_RECEIPT_MAX_BYTES) {
    throw new Error("protected measure receipt exceeds its canonical size limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(receiptJson);
  } catch {
    throw new Error("protected measure receipt is not canonical JSON");
  }
  if (stableStringify(decoded) !== receiptJson) {
    throw new Error("protected measure receipt is not canonical JSON");
  }
  return decoded;
}

export function buildProductMeasureReceiptAuthority(args: Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  productMeasureRequestSha256: string;
  operationReceiptJson: string;
  measurement: ProductMeasurementRecord;
}>): BuiltProductMeasureReceiptAuthority {
  if (!args.tenantId || !args.scope || !args.operationId) {
    throw new Error("protected measure receipt authority has incomplete operation identity");
  }
  assertDigest(args.productMeasureRequestSha256, "product measure request digest");
  assertProductMeasurementRecordIntegrity(args.measurement);
  if (args.measurement.tenant_id !== args.tenantId
    || args.measurement.scope !== args.scope
    || args.measurement.record_sha256 === null) {
    throw new Error("protected measure receipt authority has invalid measurement identity");
  }
  const decoded = parseCanonicalProductMeasureReceipt(args.operationReceiptJson);
  assertProductMeasureResultMatchesMeasurement({
    result: decoded,
    operationId: args.operationId,
    measurement: args.measurement,
  });
  const operationReceiptSha256 = sha256Hex(args.operationReceiptJson);
  const receiptJson = stableStringify({
    contract_version: "aionis_product_measure_receipt_authority_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    operation_id: args.operationId,
    product_measure_request_sha256: args.productMeasureRequestSha256,
    product_measure_receipt_sha256: operationReceiptSha256,
    measurement_id: args.measurement.measurement_id,
    measurement_digest: args.measurement.measurement_digest,
    measurement_record_sha256: args.measurement.record_sha256,
  });
  const requestSha256 = sha256Hex(receiptJson);
  return Object.freeze({
    operationKind: PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
    requestSha256,
    receiptJson,
    commitId: null,
    operationReceiptSha256,
  });
}

export function assertProductMeasureReceiptAuthority(args: Readonly<{
  originalOperation: LiteProductMeasureOperationRecord;
  authorityOperation: LiteProductMeasureOperationRecord | null;
  measurement: ProductMeasurementRecord;
  expectedRequestSha256?: string;
  expectedOperationReceiptSha256?: string;
}>): BuiltProductMeasureReceiptAuthority {
  const original = args.originalOperation;
  if (original.operation_kind !== PRODUCT_MEASURE_OPERATION_KIND
    || original.tenant_id !== args.measurement.tenant_id
    || original.scope !== args.measurement.scope
    || (args.expectedRequestSha256 !== undefined
      && original.request_sha256 !== args.expectedRequestSha256)) {
    throw new Error("protected measure operation does not match its authority identity");
  }
  const encodedOperationEvidence = args.measurement.runtime_evidence_ids.filter((value) =>
    value.startsWith(PRODUCT_MEASURE_OPERATION_EVIDENCE_PREFIX)
  );
  const operationEvidence = encodedOperationEvidence.length === 1
    ? parseProductMeasureOperationEvidenceReference(encodedOperationEvidence[0]!)
    : null;
  if (operationEvidence?.operationId !== original.operation_id
    || operationEvidence.requestSha256 !== original.request_sha256) {
    throw new Error("protected measure operation does not match its measurement authority evidence");
  }
  const built = buildProductMeasureReceiptAuthority({
    tenantId: original.tenant_id,
    scope: original.scope,
    operationId: original.operation_id,
    productMeasureRequestSha256: original.request_sha256,
    operationReceiptJson: original.receipt_json,
    measurement: args.measurement,
  });
  if (args.expectedOperationReceiptSha256 !== undefined
    && built.operationReceiptSha256 !== args.expectedOperationReceiptSha256) {
    throw new Error("protected measure operation receipt digest does not match its authority");
  }
  const authority = args.authorityOperation;
  if (!authority
    || authority.tenant_id !== original.tenant_id
    || authority.scope !== original.scope
    || authority.operation_kind !== built.operationKind
    || authority.operation_id !== original.operation_id
    || authority.request_sha256 !== built.requestSha256
    || authority.receipt_json !== built.receiptJson
    || authority.commit_id !== built.commitId
    || original.commit_id !== null) {
    throw new Error("protected measure operation receipt authority root is missing or invalid");
  }
  return built;
}

function parseStringArray(raw: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`persisted measurement contains invalid ${field} JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) =>
    typeof entry !== "string" || entry.length === 0
  )) {
    throw new Error(`persisted measurement contains invalid ${field}`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`persisted measurement contains invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

export function assertProductMeasurementRecordIntegrity(
  measurement: ProductMeasurementRecord,
): void {
  if (!CanonicalLearningUtcTimestampSchema.safeParse(measurement.created_at).success) {
    throw new Error(
      "persisted measurement contains invalid created_at; expected a canonical UTC millisecond timestamp",
    );
  }
  if (productMeasurementDigest(measurement) !== measurement.measurement_digest) {
    throw new Error("persisted measurement digest does not match its effect evidence");
  }
  const hasBaselineEpisode = measurement.baseline_episode_id !== null;
  const hasAfterEpisode = measurement.after_episode_id !== null;
  if (hasBaselineEpisode !== hasAfterEpisode) {
    throw new Error("persisted measurement contains a partial episode pair");
  }
  if (hasBaselineEpisode && measurement.record_sha256 === null) {
    throw new Error("episode-linked measurements require a full record digest");
  }
  if (measurement.record_sha256 !== null
    && productMeasurementRecordDigest(measurement) !== measurement.record_sha256) {
    throw new Error("persisted measurement record digest does not match its immutable fields");
  }
}

export function productMeasurementFromDbRecord(
  record: LiteProductMeasurementDbRecord,
): ProductMeasurementRecord {
  if (record.source !== "manual_observations" && record.source !== "product_trace") {
    throw new Error("persisted measurement contains invalid source");
  }
  if (record.evidence_status !== "sufficient" && record.evidence_status !== "insufficient") {
    throw new Error("persisted measurement contains invalid evidence status");
  }
  if (record.eligible_for_skill_export !== 0 && record.eligible_for_skill_export !== 1) {
    throw new Error("persisted measurement contains invalid export eligibility");
  }
  let effectReportRaw: unknown;
  try {
    effectReportRaw = JSON.parse(record.effect_report_json);
  } catch {
    throw new Error("persisted measurement contains invalid effect report JSON");
  }
  const measurement: ProductMeasurementRecord = {
    measurement_id: requiredString(record.measurement_id, "measurement_id"),
    tenant_id: requiredString(record.tenant_id, "tenant_id"),
    scope: requiredString(record.scope, "scope"),
    source: record.source,
    measurement_digest: requiredString(record.measurement_digest, "measurement_digest"),
    baseline_episode_id: nullableString(record.baseline_episode_id, "baseline_episode_id"),
    after_episode_id: nullableString(record.after_episode_id, "after_episode_id"),
    record_sha256: nullableString(record.record_sha256, "record_sha256"),
    effect_report: AionisEffectReportSchema.parse(effectReportRaw),
    eligible_for_skill_export: record.eligible_for_skill_export === 1,
    evidence_status: record.evidence_status,
    runtime_evidence_ids: parseStringArray(
      record.runtime_evidence_ids_json,
      "runtime evidence ids",
    ),
    eligibility_reasons: parseStringArray(
      record.eligibility_reasons_json,
      "eligibility reasons",
    ),
    created_by: requiredString(record.created_by, "created_by"),
    created_at: requiredString(record.created_at, "created_at"),
  };
  assertProductMeasurementRecordIntegrity(measurement);
  return measurement;
}
