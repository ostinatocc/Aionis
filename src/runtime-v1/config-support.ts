import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  assertUnicodeScalarString,
  type Sha256,
} from "../continuation/contract.js";

export type ContinuationRuntimeV1LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export type ContinuationRuntimeV1Environment = Readonly<
  Record<string, string | undefined>
>;

type ConfigFailure = (message: string) => never;

const LOG_LEVELS = new Set<string>([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

function assertEnvironmentRecord(
  value: unknown,
  fail: ConfigFailure,
): asserts value is ContinuationRuntimeV1Environment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("environment_must_be_a_plain_record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("environment_must_be_a_plain_record");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("environment_contains_symbol_key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("environment_must_contain_only_enumerable_data_properties");
    }
    if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      fail(`${key}_must_be_text`);
    }
  }
}

export function strictContinuationRuntimeV1Environment(
  value: unknown,
  allowedFields: readonly string[],
  fail: ConfigFailure,
): ContinuationRuntimeV1Environment {
  assertEnvironmentRecord(value, fail);
  const allowed = new Set<string>(allowedFields);
  const unknownAionisFields = Object.keys(value)
    .filter((field) => field.startsWith("AIONIS_") && !allowed.has(field))
    .sort();
  if (unknownAionisFields.length > 0) {
    fail(`unknown_AIONIS_fields:${unknownAionisFields.join(",")}`);
  }
  return value;
}

export function continuationRuntimeV1EnvPresent(
  env: ContinuationRuntimeV1Environment,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(env, field) && env[field] !== undefined;
}

export function continuationRuntimeV1RequiredText(
  env: ContinuationRuntimeV1Environment,
  field: string,
  maxBytes: number,
  fail: ConfigFailure,
  minBytes = 1,
): string {
  const value = env[field];
  if (typeof value !== "string") fail(`${field}_required`);
  assertUnicodeScalarString(value, field);
  const bytes = Buffer.byteLength(value, "utf8");
  if (value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || bytes < minBytes
    || bytes > maxBytes) {
    fail(`${field}_must_be_bounded_canonical_text`);
  }
  return value;
}

export function continuationRuntimeV1OptionalText(
  env: ContinuationRuntimeV1Environment,
  field: string,
  fallback: string,
  maxBytes: number,
  fail: ConfigFailure,
): string {
  return continuationRuntimeV1EnvPresent(env, field)
    ? continuationRuntimeV1RequiredText(env, field, maxBytes, fail)
    : fallback;
}

export function continuationRuntimeV1RequiredToken(
  env: ContinuationRuntimeV1Environment,
  field: string,
  maxBytes: number,
  minBytes: number,
  fail: ConfigFailure,
): string {
  const value = continuationRuntimeV1RequiredText(
    env,
    field,
    maxBytes,
    fail,
    minBytes,
  );
  if (/\s/u.test(value)) fail(`${field}_must_not_contain_whitespace`);
  return value;
}

export function continuationRuntimeV1Integer(
  env: ContinuationRuntimeV1Environment,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  fail: ConfigFailure,
): number {
  if (!continuationRuntimeV1EnvPresent(env, field)) return fallback;
  const value = continuationRuntimeV1RequiredText(env, field, 32, fail);
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${field}_must_be_a_canonical_integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${field}_out_of_range`);
  }
  return parsed;
}

export function continuationRuntimeV1AbsolutePath(
  env: ContinuationRuntimeV1Environment,
  field: string,
  fail: ConfigFailure,
): string {
  const value = continuationRuntimeV1RequiredText(env, field, 4096, fail);
  if (!isAbsolute(value) || resolve(value) !== value) {
    fail(`${field}_must_be_an_absolute_normalized_path`);
  }
  return value;
}

export function continuationRuntimeV1Sha256(value: string): Sha256 {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function continuationRuntimeV1RequiredSha256(
  env: ContinuationRuntimeV1Environment,
  field: string,
  fail: ConfigFailure,
): Sha256 {
  const value = continuationRuntimeV1RequiredText(env, field, 64, fail);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${field}_must_be_a_lowercase_SHA256`);
  }
  return value;
}

export function continuationRuntimeV1LogLevel(
  env: ContinuationRuntimeV1Environment,
  fail: ConfigFailure,
): ContinuationRuntimeV1LogLevel {
  const value = continuationRuntimeV1OptionalText(
    env,
    "AIONIS_LOG_LEVEL",
    "info",
    16,
    fail,
  );
  if (!LOG_LEVELS.has(value)) fail("AIONIS_LOG_LEVEL_is_not_supported");
  return value as ContinuationRuntimeV1LogLevel;
}

export function continuationRuntimeV1EmbeddingBaseUrl(
  value: string,
  fail: ConfigFailure,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("AIONIS_EMBEDDING_BASE_URL_must_be_an_absolute_url");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    fail("AIONIS_EMBEDDING_BASE_URL_must_not_contain_credentials_query_or_fragment");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("AIONIS_EMBEDDING_BASE_URL_requires_https_or_loopback_http");
  }
  if (url.toString() !== value && url.toString() !== `${value}/`) {
    fail("AIONIS_EMBEDDING_BASE_URL_must_be_canonical");
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
