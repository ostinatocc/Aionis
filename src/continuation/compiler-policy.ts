import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  compareCanonicalUtf8,
  type Sha256,
} from "./contract.js";

export const CONTINUATION_COMPILER_POLICY_SCHEMA_V1 =
  "continuation_compiler_policy_v1" as const;

export type ContinuationCompilerPolicyV1 = Readonly<{
  schema_version: "continuation_compiler_policy_v1";
  tenant_id: string;
  authority_subject_sha256: Sha256 | null;
  candidate_limit: number;
  continuity_candidate_limit: number;
  learning_candidate_limit: number;
  selected_capsule_limit: number;
  obligation_limit: number;
  max_render_budget: number;
  hard_coverage_weight: number;
  advisory_coverage_weight: number;
  authority_bonus: Readonly<Record<"candidate" | "verified" | "authoritative", number>>;
  freshness_bonus: readonly [number, number, number, number];
  freshness_max_age_ms: readonly [number, number, number];
  trusted_observer_principals: Readonly<{
    trusted_host_collector: readonly Sha256[];
    external_verifier: readonly Sha256[];
  }>;
}>;

export class ContinuationCompilerPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_continuation_compiler_policy: ${message}`, options);
    this.name = "ContinuationCompilerPolicyError";
  }
}

const POLICY_MAX_BYTES = 32_768;
const MAX_POLICY_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const POLICY_KEYS = Object.freeze([
  "advisory_coverage_weight",
  "authority_bonus",
  "authority_subject_sha256",
  "candidate_limit",
  "continuity_candidate_limit",
  "freshness_bonus",
  "freshness_max_age_ms",
  "hard_coverage_weight",
  "learning_candidate_limit",
  "max_render_budget",
  "obligation_limit",
  "selected_capsule_limit",
  "schema_version",
  "tenant_id",
  "trusted_observer_principals",
] as const);
const AUTHORITY_BONUS_KEYS = Object.freeze([
  "authoritative", "candidate", "verified",
] as const);
const TRUSTED_OBSERVER_KEYS = Object.freeze([
  "external_verifier", "trusted_host_collector",
] as const);

function fail(message: string): never {
  throw new ContinuationCompilerPolicyError(message);
}

function wrap<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ContinuationCompilerPolicyError) throw error;
    throw new ContinuationCompilerPolicyError(
      error instanceof Error ? error.message : "compiler policy validation failed",
      { cause: error },
    );
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== keys.length
    || ownKeys.some((key) => !expected.has(key as string))) {
    fail(`${field} contains unknown or missing fields`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    assertUnicodeScalarString(key, `${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactArray(value: unknown, length: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== length) fail(`${field} must be an exact ${length}-tuple`);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
    || ownKeys.length !== expected.size) fail(`${field} must be dense without extra fields`);
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data elements`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field} is not canonical bounded text`);
  return value;
}

function nullableSha256(value: unknown, field: string): Sha256 | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a SHA-256 digest or null`);
  assertSha256(value, field);
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum || (value as number) > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function bonusRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, number>> {
  const record = exactRecord(value, keys, field);
  return Object.fromEntries(keys.map((key) => [
    key,
    boundedInteger(record[key], `${field}.${key}`, 0, 1_000_000),
  ]));
}

function principalSet(value: unknown, field: string): readonly Sha256[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > 64) fail(`${field} must be a plain array with at most 64 entries`);
  const entries = exactArray(value, value.length, field).map((entry, index) => {
    if (typeof entry !== "string") fail(`${field}[${index}] must be a SHA-256 digest`);
    assertSha256(entry, `${field}[${index}]`);
    return entry;
  });
  const sorted = [...entries].sort(compareCanonicalUtf8);
  if (sorted.some((entry, index) => index > 0 && entry === sorted[index - 1])) {
    fail(`${field} contains duplicate principals`);
  }
  if (canonicalContinuationJson(entries) !== canonicalContinuationJson(sorted)) {
    fail(`${field} must use canonical UTF-8 order`);
  }
  return sorted;
}

function parse(value: unknown): ContinuationCompilerPolicyV1 {
  const record = exactRecord(value, POLICY_KEYS, "compiler policy");
  if (record.schema_version !== CONTINUATION_COMPILER_POLICY_SCHEMA_V1) {
    fail("schema_version is invalid");
  }
  const freshnessBonus = exactArray(record.freshness_bonus, 4, "freshness_bonus")
    .map((entry, index) => boundedInteger(
      entry,
      `freshness_bonus[${index}]`,
      0,
      1_000_000,
    )) as unknown as readonly [number, number, number, number];
  const freshnessAges = exactArray(
    record.freshness_max_age_ms,
    3,
    "freshness_max_age_ms",
  ).map((entry, index) => boundedInteger(
    entry,
    `freshness_max_age_ms[${index}]`,
    1,
    MAX_POLICY_AGE_MS,
  )) as unknown as readonly [number, number, number];
  if (!(freshnessAges[0] < freshnessAges[1] && freshnessAges[1] < freshnessAges[2])) {
    fail("freshness_max_age_ms must be strictly increasing");
  }
  const authorityBonus = bonusRecord(
    record.authority_bonus,
    AUTHORITY_BONUS_KEYS,
    "authority_bonus",
  );
  const observers = exactRecord(
    record.trusted_observer_principals,
    TRUSTED_OBSERVER_KEYS,
    "trusted_observer_principals",
  );
  const candidateLimit = boundedInteger(record.candidate_limit, "candidate_limit", 2, 256);
  const continuityCandidateLimit = boundedInteger(
    record.continuity_candidate_limit,
    "continuity_candidate_limit",
    1,
    255,
  );
  const learningCandidateLimit = boundedInteger(
    record.learning_candidate_limit,
    "learning_candidate_limit",
    1,
    255,
  );
  if (continuityCandidateLimit + learningCandidateLimit !== candidateLimit) {
    fail("continuity_candidate_limit plus learning_candidate_limit must equal candidate_limit");
  }
  const selectedCapsuleLimit = boundedInteger(
    record.selected_capsule_limit,
    "selected_capsule_limit",
    1,
    64,
  );
  if (selectedCapsuleLimit > candidateLimit) {
    fail("selected_capsule_limit must not exceed candidate_limit");
  }
  const parsed: ContinuationCompilerPolicyV1 = {
    schema_version: CONTINUATION_COMPILER_POLICY_SCHEMA_V1,
    tenant_id: boundedText(record.tenant_id, "tenant_id"),
    authority_subject_sha256: nullableSha256(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    candidate_limit: candidateLimit,
    continuity_candidate_limit: continuityCandidateLimit,
    learning_candidate_limit: learningCandidateLimit,
    selected_capsule_limit: selectedCapsuleLimit,
    obligation_limit: boundedInteger(record.obligation_limit, "obligation_limit", 1, 64),
    max_render_budget: boundedInteger(
      record.max_render_budget,
      "max_render_budget",
      1_024,
      65_536,
    ),
    hard_coverage_weight: boundedInteger(
      record.hard_coverage_weight,
      "hard_coverage_weight",
      0,
      1_000_000,
    ),
    advisory_coverage_weight: boundedInteger(
      record.advisory_coverage_weight,
      "advisory_coverage_weight",
      0,
      1_000_000,
    ),
    authority_bonus: {
      candidate: authorityBonus.candidate!,
      verified: authorityBonus.verified!,
      authoritative: authorityBonus.authoritative!,
    },
    freshness_bonus: freshnessBonus,
    freshness_max_age_ms: freshnessAges,
    trusted_observer_principals: {
      trusted_host_collector: principalSet(
        observers.trusted_host_collector,
        "trusted_observer_principals.trusted_host_collector",
      ),
      external_verifier: principalSet(
        observers.external_verifier,
        "trusted_observer_principals.external_verifier",
      ),
    },
  };
  if (Buffer.byteLength(canonicalContinuationJson(parsed), "utf8") > POLICY_MAX_BYTES) {
    fail(`canonical payload exceeds ${POLICY_MAX_BYTES} bytes`);
  }
  return canonicalContinuationClone(parsed);
}

export function buildContinuationCompilerPolicyV1(
  value: ContinuationCompilerPolicyV1,
): ContinuationCompilerPolicyV1 {
  return wrap(() => parse(value));
}

export function verifyContinuationCompilerPolicyV1(
  value: unknown,
): ContinuationCompilerPolicyV1 {
  return wrap(() => parse(value));
}
