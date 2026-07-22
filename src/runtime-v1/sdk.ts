import {
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import type {
  AuthorityDecisionBodyV1,
  CapsuleBranchRefV1,
  CreateContinuationBodyV1,
  DecisionQueryBodyV1,
  RecordObservationsBodyV1,
  RecordOutcomeBodyV1,
} from "./command.js";

export type AionisRuntimeV1ClientConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  requestBodyLimitBytes: number;
  responseBodyLimitBytes: number;
}>;

export type AionisRuntimeV1CallOptions = Readonly<{
  requestId?: string;
  signal?: AbortSignal;
}>;

type MutationInput<T> = Readonly<{
  operationId: string;
  scope: string;
  body: T;
  options?: AionisRuntimeV1CallOptions;
}>;

export type AionisRuntimeV1AuthorityDecisionInput = MutationInput<AuthorityDecisionBodyV1>
  & Readonly<{ taskFamily: string }>;

export type AionisRuntimeV1ReadDecisionInput = Readonly<{
  decisionId: string;
  scope: string;
  view: DecisionQueryBodyV1["view"];
  excludeCapsule: DecisionQueryBodyV1["exclude_capsule"];
  substituteBranch: CapsuleBranchRefV1 | null;
  options?: AionisRuntimeV1CallOptions;
}>;

export type AionisRuntimeV1Client = Readonly<{
  recordObservations(
    input: MutationInput<RecordObservationsBodyV1>,
  ): Promise<CanonicalJson>;
  createContinuation(
    input: MutationInput<CreateContinuationBodyV1>,
  ): Promise<CanonicalJson>;
  recordOutcome(input: MutationInput<RecordOutcomeBodyV1>): Promise<CanonicalJson>;
  decideAuthority(input: AionisRuntimeV1AuthorityDecisionInput): Promise<CanonicalJson>;
  readDecision(input: AionisRuntimeV1ReadDecisionInput): Promise<CanonicalJson>;
}>;

export class AionisRuntimeV1ClientError extends Error {
  constructor(
    readonly kind: "configuration" | "aborted" | "timeout" | "transport"
      | "protocol" | "runtime",
    readonly code: string,
    readonly statusCode: number | null = null,
    readonly operationId: string | null = null,
    readonly requestId: string | null = null,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AionisRuntimeV1ClientError";
  }
}

const CONFIG_KEYS = Object.freeze([
  "apiKey", "baseUrl", "requestBodyLimitBytes", "responseBodyLimitBytes", "timeoutMs",
] as const);
const MUTATION_KEYS = new Set(["body", "operationId", "options", "scope"]);
const AUTHORITY_KEYS = new Set([...MUTATION_KEYS, "taskFamily"]);
const READ_KEYS = new Set([
  "decisionId", "excludeCapsule", "options", "scope", "substituteBranch", "view",
]);
const OPTION_KEYS = new Set(["requestId", "signal"]);

function clientError(
  kind: AionisRuntimeV1ClientError["kind"],
  code: string,
  options?: ErrorOptions,
): never {
  throw new AionisRuntimeV1ClientError(kind, code, null, null, null, options);
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    clientError("configuration", `${field}_shape_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !keys.includes(key))) {
    clientError("configuration", `${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      clientError("configuration", `${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string") clientError("configuration", `${field}_invalid`);
  try { assertUnicodeScalarString(value, field); } catch (error) {
    clientError("configuration", `${field}_invalid`, { cause: error });
  }
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) {
    clientError("configuration", `${field}_invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > maximum) clientError("configuration", `${field}_invalid`);
  return value as number;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    clientError("configuration", `${field}_invalid`);
  }
  return value;
}

function parseConfig(value: unknown): AionisRuntimeV1ClientConfig & Readonly<{ origin: string }> {
  const record = exactRecord(value, new Set(CONFIG_KEYS), CONFIG_KEYS, "config");
  const baseUrl = text(record.baseUrl, "base_url", 2_048);
  let url: URL;
  try { url = new URL(baseUrl); } catch (error) {
    clientError("configuration", "base_url_invalid", { cause: error });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")) {
    clientError("configuration", "base_url_invalid");
  }
  const apiKey = text(record.apiKey, "api_key", 512);
  if (apiKey.length < 32 || /\s/u.test(apiKey)) clientError("configuration", "api_key_invalid");
  return Object.freeze({
    baseUrl,
    origin: url.origin,
    apiKey,
    timeoutMs: integer(record.timeoutMs, "timeout_ms", 100, 300_000),
    requestBodyLimitBytes: integer(record.requestBodyLimitBytes,
      "request_body_limit_bytes", 16_384, 5_242_880),
    responseBodyLimitBytes: integer(record.responseBodyLimitBytes,
      "response_body_limit_bytes", 1_024, 5_242_880),
  });
}

function callOptions(value: unknown): AionisRuntimeV1CallOptions {
  if (value === undefined) return Object.freeze({});
  const record = exactRecord(value, OPTION_KEYS, [], "call_options");
  if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) {
    clientError("configuration", "signal_invalid");
  }
  if (record.requestId !== undefined
    && (typeof record.requestId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(record.requestId))) {
    clientError("configuration", "request_id_invalid");
  }
  return Object.freeze({
    ...(record.requestId === undefined ? {} : { requestId: record.requestId as string }),
    ...(record.signal === undefined ? {} : { signal: record.signal as AbortSignal }),
  });
}

function mutationInput(value: unknown, authority = false) {
  const record = exactRecord(
    value,
    authority ? AUTHORITY_KEYS : MUTATION_KEYS,
    authority
      ? ["body", "operationId", "scope", "taskFamily"]
      : ["body", "operationId", "scope"],
    authority ? "authority_input" : "mutation_input",
  );
  let body: CanonicalJson;
  try { body = canonicalContinuationClone(record.body as CanonicalJson); } catch (error) {
    clientError("configuration", "body_invalid", { cause: error });
  }
  return {
    operationId: text(record.operationId, "operation_id"),
    scope: text(record.scope, "scope"),
    body,
    options: callOptions(record.options),
    ...(authority ? { taskFamily: text(record.taskFamily, "task_family") } : {}),
  };
}

function capsuleRef(value: unknown): DecisionQueryBodyV1["exclude_capsule"] {
  if (value === null) return null;
  const record = exactRecord(
    value,
    new Set(["capsule_id", "capsule_revision", "capsule_sha256"]),
    ["capsule_id", "capsule_revision", "capsule_sha256"],
    "exclude_capsule",
  );
  return canonicalContinuationClone({
    capsule_id: text(record.capsule_id, "capsule_id"),
    capsule_revision: integer(record.capsule_revision,
      "capsule_revision", 1, Number.MAX_SAFE_INTEGER),
    capsule_sha256: sha256(record.capsule_sha256, "capsule_sha256"),
  });
}

function branchRef(value: unknown): CapsuleBranchRefV1 | null {
  if (value === null) return null;
  const record = exactRecord(
    value,
    new Set(["branch_id", "branch_revision", "manifest_sha256"]),
    ["branch_id", "branch_revision", "manifest_sha256"],
    "substitute_branch",
  );
  return canonicalContinuationClone({
    branch_id: text(record.branch_id, "branch_id"),
    branch_revision: integer(record.branch_revision,
      "branch_revision", 1, Number.MAX_SAFE_INTEGER),
    manifest_sha256: sha256(record.manifest_sha256, "manifest_sha256"),
  });
}

async function readBounded(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null
    && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    clientError("protocol", "response_body_too_large");
  }
  if (!response.body) clientError("protocol", "response_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      clientError("protocol", "response_body_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (error) {
    clientError("protocol", "response_utf8_invalid", { cause: error });
  }
}

function parseResponseJson(textValue: string): CanonicalJson {
  let parsed: unknown;
  try { parsed = JSON.parse(textValue) as unknown; } catch (error) {
    clientError("protocol", "response_json_invalid", { cause: error });
  }
  try { return canonicalContinuationClone(parsed as CanonicalJson); } catch (error) {
    clientError("protocol", "response_json_invalid", { cause: error });
  }
}

function runtimeError(value: CanonicalJson, status: number): never {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    clientError("protocol", "error_envelope_invalid");
  }
  const record = value as Readonly<Record<string, CanonicalJson>>;
  const error = record.error;
  if (record.schema_version !== "continuation_runtime_http_error_v1"
    || Object.keys(record).length !== 2
    || error === null || typeof error !== "object" || Array.isArray(error)) {
    clientError("protocol", "error_envelope_invalid");
  }
  const detail = error as Readonly<Record<string, CanonicalJson>>;
  if (Object.keys(detail).length !== 3 || typeof detail.code !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(detail.code)
    || (detail.operation_id !== null && typeof detail.operation_id !== "string")
    || (detail.request_id !== null && typeof detail.request_id !== "string")) {
    clientError("protocol", "error_envelope_invalid");
  }
  throw new AionisRuntimeV1ClientError(
    "runtime",
    detail.code,
    status,
    detail.operation_id,
    detail.request_id,
  );
}

function queryUrl(origin: string, input: AionisRuntimeV1ReadDecisionInput): string {
  const query = new URLSearchParams();
  query.set("scope", text(input.scope, "scope"));
  query.set("view", input.view);
  if (input.excludeCapsule !== null) {
    query.set("exclude_capsule_id", input.excludeCapsule.capsule_id);
    query.set("exclude_capsule_revision", String(input.excludeCapsule.capsule_revision));
    query.set("exclude_capsule_sha256", input.excludeCapsule.capsule_sha256);
  }
  if (input.substituteBranch !== null) {
    query.set("substitute_branch_id", input.substituteBranch.branch_id);
    query.set("substitute_branch_revision", String(input.substituteBranch.branch_revision));
    query.set("substitute_manifest_sha256", input.substituteBranch.manifest_sha256);
  }
  return `${origin}/v1/decisions/${encodeURIComponent(text(input.decisionId, "decision_id"))}?${query}`;
}

export function createAionisRuntimeV1Client(value: AionisRuntimeV1ClientConfig): AionisRuntimeV1Client {
  const config = parseConfig(value);
  const request = async (
    method: "GET" | "POST",
    url: string,
    body: CanonicalJson | null,
    options: AionisRuntimeV1CallOptions,
  ): Promise<CanonicalJson> => {
    const encoded = body === null ? null : canonicalContinuationJson(body);
    if (encoded !== null && Buffer.byteLength(encoded, "utf8") > config.requestBodyLimitBytes) {
      clientError("configuration", "request_body_too_large");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          ...(encoded === null ? {} : { "content-type": "application/json" }),
          ...(options.requestId === undefined ? {} : { "x-request-id": options.requestId }),
        },
        ...(encoded === null ? {} : { body: encoded }),
        signal: controller.signal,
      });
      const mediaType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!/^application\/json(?:;\s*charset=utf-8)?$/u.test(mediaType)) {
        clientError("protocol", "response_content_type_invalid");
      }
      const responseBody = parseResponseJson(
        await readBounded(response, config.responseBodyLimitBytes),
      );
      if (response.status === 200) return responseBody;
      if (response.status < 400 || response.status > 599) {
        clientError("protocol", "response_status_invalid");
      }
      runtimeError(responseBody, response.status);
    } catch (error) {
      if (error instanceof AionisRuntimeV1ClientError) throw error;
      if (timedOut) clientError("timeout", "request_timeout", { cause: error });
      if (options.signal?.aborted) clientError("aborted", "request_aborted", { cause: error });
      clientError("transport", "request_failed", { cause: error });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  const mutate = async (path: string, value: unknown, authority = false) => {
    const input = mutationInput(value, authority);
    return request("POST", `${config.origin}${path}`, canonicalContinuationClone({
      operation_id: input.operationId,
      scope: input.scope,
      ...(authority ? { task_family: input.taskFamily! } : {}),
      body: input.body,
    }), input.options);
  };

  return Object.freeze({
    recordObservations: (input) => mutate("/v1/observations", input),
    createContinuation: (input) => mutate("/v1/continuations", input),
    recordOutcome: (input) => mutate("/v1/outcomes", input),
    decideAuthority: (input) => mutate("/v1/authority-decisions", input, true),
    readDecision: async (value) => {
      const record = exactRecord(value, READ_KEYS, [
        "decisionId", "excludeCapsule", "scope", "substituteBranch", "view",
      ], "read_input");
      const options = callOptions(record.options);
      if (record.view !== "summary" && record.view !== "full"
        && record.view !== "counterfactual") clientError("configuration", "view_invalid");
      const exclude = capsuleRef(record.excludeCapsule);
      const substitute = branchRef(record.substituteBranch);
      if (record.view !== "counterfactual"
        && (exclude !== null || substitute !== null)) {
        clientError("configuration", "counterfactual_selector_invalid");
      }
      return await request("GET", queryUrl(config.origin, {
        decisionId: text(record.decisionId, "decision_id"),
        scope: text(record.scope, "scope"),
        view: record.view,
        excludeCapsule: exclude,
        substituteBranch: substitute,
        options,
      }), null, options);
    },
  });
}
