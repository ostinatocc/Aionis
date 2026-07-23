import {
  assertCanonicalUtcMillis,
  assertUnicodeScalarString,
} from "../continuation/contract.js";
import {
  assertContinuationRuntimeV1AuthorityClock,
  type ContinuationRuntimeV1AuthorityClock,
} from "../store/continuation-runtime-v1-database.js";
import { continuationRuntimeV1EmbeddingBaseUrl } from "./config-support.js";
import { withContinuationRuntimeV1StableFileBytes } from "./stable-file.js";
import type { ContinuationRuntimeV1EmbeddingWorkerConfig } from
  "./worker-config.js";

export const CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH = 64;
export const CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_TEXT_BYTES = 32_768;
export const CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH_TEXT_BYTES = 262_144;
export const CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_VECTOR_COMPONENTS = 1_048_576;

const MAX_LEASE_HORIZON_MS = 24 * 60 * 60 * 1_000;
const RESPONSE_ENVELOPE_BYTES = 65_536;
const RESPONSE_BYTES_PER_COMPONENT = 32;
const ABSOLUTE_RESPONSE_BODY_LIMIT_BYTES = 34 * 1_024 * 1_024;
const CONFIG_KEYS = Object.freeze([
  "apiKeyFilePath", "baseUrl", "dimensions", "model",
] as const);
const INPUT_KEYS = Object.freeze([
  "lease_deadline_at", "schema_version", "signal", "texts",
] as const);
const RESPONSE_KEYS = Object.freeze(["data", "model", "object", "usage"] as const);
const DATA_KEYS = Object.freeze(["embedding", "index", "object"] as const);
const USAGE_KEYS = Object.freeze(["prompt_tokens", "total_tokens"] as const);

export type ContinuationRuntimeV1EmbeddingProviderErrorCode =
  | "configuration_invalid"
  | "input_invalid"
  | "request_aborted"
  | "lease_deadline_exceeded"
  | "transport_failure"
  | "provider_http_failure"
  | "provider_response_too_large"
  | "provider_response_malformed"
  | "provider_response_model_mismatch"
  | "provider_response_dimensions_mismatch"
  | "provider_response_vector_invalid";

export class ContinuationRuntimeV1EmbeddingProviderError extends Error {
  constructor(readonly code: ContinuationRuntimeV1EmbeddingProviderErrorCode) {
    super(`continuation_runtime_v1_embedding_provider_${code}`);
    this.name = "ContinuationRuntimeV1EmbeddingProviderError";
  }
}

export type ContinuationRuntimeV1EmbeddingBatchInput = Readonly<{
  schema_version: "embedding_batch_input_v1";
  texts: readonly string[];
  lease_deadline_at: string;
  signal: AbortSignal;
}>;

export type ContinuationRuntimeV1EmbeddingBatchResult = Readonly<{
  schema_version: "embedding_batch_result_v1";
  model: string;
  dimensions: number;
  vectors: readonly (readonly number[])[];
}>;

export type ContinuationRuntimeV1EmbeddingProvider = Readonly<{
  embed(
    input: ContinuationRuntimeV1EmbeddingBatchInput,
  ): Promise<ContinuationRuntimeV1EmbeddingBatchResult>;
}>;

function fail(code: ContinuationRuntimeV1EmbeddingProviderErrorCode): never {
  throw new ContinuationRuntimeV1EmbeddingProviderError(code);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: ContinuationRuntimeV1EmbeddingProviderErrorCode,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) fail(code);
  const actual = Reflect.ownKeys(value);
  const expected = new Set(keys);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !expected.has(key))) fail(code);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    out[key] = descriptor.value;
  }
  return out;
}

function boundedText(
  value: unknown,
  maximum: number,
  code: ContinuationRuntimeV1EmbeddingProviderErrorCode,
): string {
  if (typeof value !== "string") fail(code);
  try { assertUnicodeScalarString(value, "embedding text"); } catch { fail(code); }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maximum || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

export type ContinuationRuntimeV1EmbeddingCredential = Readonly<{
  destroy(): void;
  withAuthorizationHeader<T>(consume: (header: string) => T): T;
}>;

export function loadContinuationRuntimeV1EmbeddingCredential(
  config: ContinuationRuntimeV1EmbeddingWorkerConfig,
): ContinuationRuntimeV1EmbeddingCredential {
  return withContinuationRuntimeV1StableFileBytes(
    config.apiKeyFilePath, [16, 2_048], "runtime", "private",
    () => fail("configuration_invalid"), (bytes) => {
      if (bytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
        fail("configuration_invalid");
      }
      let secret: Buffer | null = Buffer.from(bytes);
      return Object.freeze({
        destroy(): void {
          secret?.fill(0);
          secret = null;
        },
        withAuthorizationHeader<T>(consume: (header: string) => T): T {
          if (secret === null) fail("configuration_invalid");
          return consume(`Bearer ${secret.toString("ascii")}`);
        },
      });
    },
  );
}

function denseArray(
  value: unknown,
  maximum: number,
  code: ContinuationRuntimeV1EmbeddingProviderErrorCode,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0 || value.length > maximum) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1
    || keys.some((key) => typeof key !== "string")) fail(code);
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    out.push(descriptor.value);
  }
  return out;
}

function parseConfig(value: ContinuationRuntimeV1EmbeddingWorkerConfig) {
  const record = exactRecord(value, CONFIG_KEYS, "configuration_invalid");
  let baseUrl: string;
  try {
    baseUrl = continuationRuntimeV1EmbeddingBaseUrl(
      boundedText(record.baseUrl, 2_048, "configuration_invalid"),
      () => fail("configuration_invalid"),
    );
  } catch {
    fail("configuration_invalid");
  }
  const model = boundedText(record.model, 256, "configuration_invalid");
  boundedText(record.apiKeyFilePath, 4_096, "configuration_invalid");
  if (!Number.isSafeInteger(record.dimensions)
    || (record.dimensions as number) < 1
    || (record.dimensions as number) > 65_536) fail("configuration_invalid");
  return Object.freeze({ baseUrl, model, dimensions: record.dimensions as number });
}

function parseInput(value: ContinuationRuntimeV1EmbeddingBatchInput) {
  const record = exactRecord(value, INPUT_KEYS, "input_invalid");
  if (record.schema_version !== "embedding_batch_input_v1"
    || !(record.signal instanceof AbortSignal)
    || typeof record.lease_deadline_at !== "string") fail("input_invalid");
  try {
    assertCanonicalUtcMillis(record.lease_deadline_at, "embedding lease deadline");
  } catch {
    fail("input_invalid");
  }
  const texts = denseArray(
    record.texts,
    CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH,
    "input_invalid",
  ).map((entry) => {
    if (typeof entry !== "string") fail("input_invalid");
    try { assertUnicodeScalarString(entry, "embedding input"); } catch { fail("input_invalid"); }
    const bytes = Buffer.byteLength(entry, "utf8");
    if (bytes === 0 || bytes > CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_TEXT_BYTES) {
      fail("input_invalid");
    }
    return entry;
  });
  const totalBytes = texts.reduce(
    (sum, text) => sum + Buffer.byteLength(text, "utf8"),
    0,
  );
  if (totalBytes > CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_BATCH_TEXT_BYTES) {
    fail("input_invalid");
  }
  return {
    texts,
    signal: record.signal,
    leaseDeadlineAt: record.lease_deadline_at,
  };
}

function authorityNowMilliseconds(authorityNow: () => string): number {
  try {
    const value = authorityNow(); assertCanonicalUtcMillis(value, "embedding authority clock");
    return Date.parse(value);
  } catch { fail("configuration_invalid"); }
}

function abortAuthority(signal: AbortSignal, deadlineAt: string, authorityNow: () => string) {
  const now = authorityNowMilliseconds(authorityNow);
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now) fail("lease_deadline_exceeded");
  if (deadline - now > MAX_LEASE_HORIZON_MS) fail("input_invalid");
  if (signal.aborted) fail("request_aborted");
  const controller = new AbortController();
  let code: "request_aborted" | "lease_deadline_exceeded" | null = null;
  const externalAbort = () => {
    if (!controller.signal.aborted) {
      code = "request_aborted";
      controller.abort();
    }
  };
  signal.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      code = "lease_deadline_exceeded";
      controller.abort();
    }
  }, deadline - now);
  timer.unref();
  return {
    signal: controller.signal,
    abortedCode: () => code,
    assertWithinDeadline: () => {
      if (authorityNowMilliseconds(authorityNow) >= deadline) {
        fail("lease_deadline_exceeded");
      }
    },
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", externalAbort);
    },
  };
}

async function boundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length)
    || Number(length) > maximumBytes)) {
    try { await response.body?.cancel(); } catch { /* redacted below */ }
    fail("provider_response_too_large");
  }
  if (!response.body) fail("provider_response_malformed");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        try { await reader.cancel(); } catch { /* emit only stable code */ }
        fail("provider_response_too_large");
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1EmbeddingProviderError) throw error;
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("provider_response_malformed");
  }
  return value as number;
}

function parseResponse(
  raw: string,
  model: string,
  dimensions: number,
  batchSize: number,
): readonly (readonly number[])[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { fail("provider_response_malformed"); }
  const envelope = exactRecord(parsed, RESPONSE_KEYS, "provider_response_malformed");
  if (envelope.object !== "list") fail("provider_response_malformed");
  if (envelope.model !== model) fail("provider_response_model_mismatch");
  const usage = exactRecord(envelope.usage, USAGE_KEYS, "provider_response_malformed");
  nonNegativeInteger(usage.prompt_tokens);
  nonNegativeInteger(usage.total_tokens);
  const data = denseArray(envelope.data, batchSize, "provider_response_malformed");
  if (data.length !== batchSize) fail("provider_response_malformed");
  const vectors: Array<readonly number[] | undefined> = Array(batchSize);
  for (const entry of data) {
    const item = exactRecord(entry, DATA_KEYS, "provider_response_malformed");
    if (item.object !== "embedding" || !Number.isSafeInteger(item.index)
      || (item.index as number) < 0 || (item.index as number) >= batchSize
      || vectors[item.index as number] !== undefined) {
      fail("provider_response_malformed");
    }
    if (!Array.isArray(item.embedding)
      || Object.getPrototypeOf(item.embedding) !== Array.prototype) {
      fail("provider_response_vector_invalid");
    }
    if (item.embedding.length !== dimensions) {
      fail("provider_response_dimensions_mismatch");
    }
    const vector = denseArray(
      item.embedding,
      dimensions,
      "provider_response_vector_invalid",
    ).map((component) => {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        fail("provider_response_vector_invalid");
      }
      return component;
    });
    vectors[item.index as number] = Object.freeze(vector);
  }
  if (vectors.some((vector) => vector === undefined)) {
    fail("provider_response_malformed");
  }
  return Object.freeze(vectors as readonly (readonly number[])[]);
}

export function createContinuationRuntimeV1EmbeddingProvider(
  workerConfig: ContinuationRuntimeV1EmbeddingWorkerConfig,
  credential: ContinuationRuntimeV1EmbeddingCredential,
  authorityNow: ContinuationRuntimeV1AuthorityClock,
): ContinuationRuntimeV1EmbeddingProvider {
  try { assertContinuationRuntimeV1AuthorityClock(authorityNow); } catch {
    fail("configuration_invalid");
  }
  if (!credential || typeof credential.withAuthorizationHeader !== "function"
    || typeof credential.destroy !== "function") fail("configuration_invalid");
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(workerConfig);
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1EmbeddingProviderError) throw error;
    fail("configuration_invalid");
  }
  return Object.freeze({
    async embed(
      value: ContinuationRuntimeV1EmbeddingBatchInput,
    ): Promise<ContinuationRuntimeV1EmbeddingBatchResult> {
      let input: ReturnType<typeof parseInput>;
      try {
        input = parseInput(value);
      } catch (error) {
        if (error instanceof ContinuationRuntimeV1EmbeddingProviderError) throw error;
        fail("input_invalid");
      }
      if (input.texts.length * config.dimensions
        > CONTINUATION_RUNTIME_V1_EMBEDDING_MAX_VECTOR_COMPONENTS) {
        fail("input_invalid");
      }
      const authority = abortAuthority(input.signal, input.leaseDeadlineAt, authorityNow);
      const maximumResponseBytes = Math.min(
        ABSOLUTE_RESPONSE_BODY_LIMIT_BYTES,
        RESPONSE_ENVELOPE_BYTES
          + input.texts.length * config.dimensions * RESPONSE_BYTES_PER_COMPONENT,
      );
      try {
        const response = await credential.withAuthorizationHeader((authorization) => (
          fetch(`${config.baseUrl}/embeddings`, {
            method: "POST",
            redirect: "error",
            headers: { accept: "application/json", authorization,
              "content-type": "application/json" },
            body: JSON.stringify({
              model: config.model,
              input: input.texts,
              dimensions: config.dimensions,
              encoding_format: "float",
            }),
            signal: authority.signal,
          })
        ));
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* emit only stable code */ }
          fail("provider_http_failure");
        }
        const raw = await boundedResponseBody(response, maximumResponseBytes);
        const vectors = parseResponse(
          raw,
          config.model,
          config.dimensions,
          input.texts.length,
        );
        authority.assertWithinDeadline();
        return Object.freeze({
          schema_version: "embedding_batch_result_v1" as const,
          model: config.model,
          dimensions: config.dimensions,
          vectors,
        });
      } catch (error) {
        if (error instanceof ContinuationRuntimeV1EmbeddingProviderError) throw error;
        const aborted = authority.abortedCode();
        if (aborted !== null) fail(aborted);
        fail("transport_failure");
      } finally {
        authority.cleanup();
      }
    },
  });
}
