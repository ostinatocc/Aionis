import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  compareCanonicalUtf8,
  type Sha256,
} from "./contract.js";

export type HostCapsuleUseV1 = Readonly<{
  capsule_scope: string;
  capsule_id: string;
  capsule_revision: number;
  capsule_sha256: Sha256;
  surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate";
  use_state: "used" | "not_used" | "unknown";
}>;

export type HostUseReceiptV1 = Readonly<{
  schema_version: "host_capsule_use_receipt_v1";
  decision_id: string;
  use_id: string;
  observed_at: string;
  render_result_sha256: Sha256;
  capsule_uses: readonly HostCapsuleUseV1[];
  evidence_sha256: Sha256;
}>;

export type OutcomeReceiptV1 = Readonly<{
  schema_version: "host_outcome_receipt_v1";
  decision_id: string;
  observed_at: string;
  outcome: "succeeded" | "failed" | "partial" | "unknown";
  outcome_code: string;
  evidence_sha256: Sha256;
  summary: string | null;
}>;

const USE_RECEIPT_KEYS = Object.freeze([
  "capsule_uses",
  "decision_id",
  "evidence_sha256",
  "observed_at",
  "render_result_sha256",
  "schema_version",
  "use_id",
] as const);
const USE_KEYS = Object.freeze([
  "capsule_id",
  "capsule_revision",
  "capsule_scope",
  "capsule_sha256",
  "surface",
  "use_state",
] as const);
const OUTCOME_KEYS = Object.freeze([
  "decision_id",
  "evidence_sha256",
  "observed_at",
  "outcome",
  "outcome_code",
  "schema_version",
  "summary",
] as const);
const SURFACES = new Set<HostCapsuleUseV1["surface"]>([
  "use_now", "inspect_before_use", "do_not_use", "rehydrate",
]);
const USE_STATES = new Set<HostCapsuleUseV1["use_state"]>([
  "used", "not_used", "unknown",
]);
const OUTCOMES = new Set<OutcomeReceiptV1["outcome"]>([
  "succeeded", "failed", "partial", "unknown",
]);

function fail(field: string): never {
  throw new Error(`continuation_outcome_${field}_invalid`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if (keys.length !== expected.size
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) fail(field);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(field);
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, maximum: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) fail(field);
  const keys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.length !== expected.size
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) fail(field);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(field);
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string") fail(field);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) fail(field);
  return value;
}

function nullableSummary(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("summary");
  assertUnicodeScalarString(value, "summary");
  if (/\u0000|\u007f/u.test(value) || Buffer.byteLength(value, "utf8") > 4_096) {
    fail("summary");
  }
  return value;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(field);
  try { assertSha256(value, field); } catch { fail(field); }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field);
  try { assertCanonicalUtcMillis(value, field); } catch { fail(field); }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(field);
  return value as number;
}

function useIdentity(value: HostCapsuleUseV1): string {
  return canonicalContinuationJson([
    value.capsule_scope,
    value.capsule_id,
    value.capsule_revision,
    value.capsule_sha256,
  ]);
}

function parseUse(value: unknown): HostCapsuleUseV1 {
  const record = exactRecord(value, USE_KEYS, "capsule_use");
  if (typeof record.surface !== "string"
    || !SURFACES.has(record.surface as HostCapsuleUseV1["surface"])
    || typeof record.use_state !== "string"
    || !USE_STATES.has(record.use_state as HostCapsuleUseV1["use_state"])) {
    fail("capsule_use_state");
  }
  return canonicalContinuationClone({
    capsule_scope: text(record.capsule_scope, "capsule_scope"),
    capsule_id: text(record.capsule_id, "capsule_id"),
    capsule_revision: positiveInteger(record.capsule_revision, "capsule_revision"),
    capsule_sha256: sha256(record.capsule_sha256, "capsule_sha256"),
    surface: record.surface,
    use_state: record.use_state,
  }) as HostCapsuleUseV1;
}

export function verifyHostUseReceiptV1(value: unknown): HostUseReceiptV1 {
  const record = exactRecord(value, USE_RECEIPT_KEYS, "use_receipt");
  if (record.schema_version !== "host_capsule_use_receipt_v1") {
    fail("use_receipt_schema");
  }
  const uses = exactArray(record.capsule_uses, 256, "capsule_uses")
    .map(parseUse)
    .sort((left, right) => compareCanonicalUtf8(useIdentity(left), useIdentity(right)));
  for (let index = 1; index < uses.length; index += 1) {
    if (useIdentity(uses[index - 1]!) === useIdentity(uses[index]!)) {
      fail("capsule_use_duplicate");
    }
  }
  return canonicalContinuationClone({
    schema_version: "host_capsule_use_receipt_v1" as const,
    decision_id: text(record.decision_id, "use_decision_id"),
    use_id: text(record.use_id, "use_id"),
    observed_at: timestamp(record.observed_at, "use_observed_at"),
    render_result_sha256: sha256(
      record.render_result_sha256,
      "use_render_result_sha256",
    ),
    capsule_uses: uses,
    evidence_sha256: sha256(record.evidence_sha256, "use_evidence_sha256"),
  });
}

export function verifyOutcomeReceiptV1(value: unknown): OutcomeReceiptV1 {
  const record = exactRecord(value, OUTCOME_KEYS, "outcome_receipt");
  if (record.schema_version !== "host_outcome_receipt_v1"
    || typeof record.outcome !== "string"
    || !OUTCOMES.has(record.outcome as OutcomeReceiptV1["outcome"])) {
    fail("outcome_receipt_schema");
  }
  return canonicalContinuationClone({
    schema_version: "host_outcome_receipt_v1" as const,
    decision_id: text(record.decision_id, "outcome_decision_id"),
    observed_at: timestamp(record.observed_at, "outcome_observed_at"),
    outcome: record.outcome,
    outcome_code: text(record.outcome_code, "outcome_code"),
    evidence_sha256: sha256(record.evidence_sha256, "outcome_evidence_sha256"),
    summary: nullableSummary(record.summary),
  }) as OutcomeReceiptV1;
}
