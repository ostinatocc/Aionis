import type {
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";

import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalUniqueSet,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import {
  continuationAuthoritySubjectSha256V1,
} from "../continuation/task-envelope.js";
import {
  authenticateContinuationRuntimeV1,
  ContinuationRuntimeV1AuthenticationError,
  type ContinuationRuntimeV1Principal,
} from "./auth.js";
import {
  ContinuationRuntimeV1ApplicationError,
  type ContinuationRuntimeV1Application,
  type ContinuationRuntimeV1Readiness,
} from "./application.js";
import {
  buildAuthenticatedDecisionQueryV1,
  buildAuthorityDecisionCommandV1,
  buildCreateContinuationCommandV1,
  buildRecordObservationsCommandV1,
  buildRecordOutcomeCommandV1,
  parseRuntimeCommandScopeSelectorV1,
} from "./command.js";
import type { ContinuationRuntimeV1DaemonConfig } from "./config.js";
import type { ContinuationRuntimeV1HttpHandlerId } from "./http-surface.js";

const APPLICATION_KEYS = Object.freeze([
  "createContinuation",
  "decideAuthority",
  "readDecision",
  "readiness",
  "recordObservations",
  "recordOutcome",
  "resolveAuthorityBinding",
  "resolveDecisionBinding",
  "resolveSnapshotBinding",
] as const);
const MUTATION_ENVELOPE_KEYS = Object.freeze([
  "body", "operation_id", "scope",
] as const);
const AUTHORITY_ENVELOPE_KEYS = Object.freeze([
  "body", "operation_id", "scope", "task_family",
] as const);
const SNAPSHOT_REF_KEYS = Object.freeze([
  "world_snapshot_id", "world_snapshot_sha256",
] as const);
const DECISION_REF_KEYS = Object.freeze([
  "contract_sha256", "decision_id", "exposure_receipt_sha256",
] as const);
const READ_QUERY_KEYS = new Set<string>([
  "exclude_capsule_id",
  "exclude_capsule_revision",
  "exclude_capsule_sha256",
  "scope",
  "substitute_branch_id",
  "substitute_branch_revision",
  "substitute_manifest_sha256",
  "view",
]);
const EXCLUDE_QUERY_KEYS = Object.freeze([
  "exclude_capsule_id", "exclude_capsule_revision", "exclude_capsule_sha256",
] as const);
const SUBSTITUTE_QUERY_KEYS = Object.freeze([
  "substitute_branch_id", "substitute_branch_revision", "substitute_manifest_sha256",
] as const);

type MutationEnvelope = Readonly<{
  operation_id: string;
  scope: string;
  body: unknown;
}>;

type AuthorityEnvelope = MutationEnvelope & Readonly<{ task_family: string }>;

type ReadDecisionTransport = Readonly<{
  scope: string;
  command_body: Readonly<{
    view: "summary" | "full" | "counterfactual";
    exclude_capsule: null | Readonly<{
      capsule_id: string;
      capsule_revision: number;
      capsule_sha256: Sha256;
    }>;
    substitute_branch: null | Readonly<{
      branch_id: string;
      branch_revision: number;
      manifest_sha256: Sha256;
    }>;
  }>;
}>;

type ErrorEnvelope = Readonly<{
  schema_version: "continuation_runtime_http_error_v1";
  error: Readonly<{
    code: string;
    operation_id: string | null;
    request_id: string | null;
  }>;
}>;

function fail(field: string): never {
  throw new Error(`continuation_runtime_v1_http_transport_${field}_invalid`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
  allowFrameworkNullObject = false,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  const frameworkNullObject = allowFrameworkNullObject
    && prototype !== null
    && Object.getPrototypeOf(prototype) === null
    && Reflect.ownKeys(prototype).length === 0;
  if ((prototype !== Object.prototype && prototype !== null && !frameworkNullObject)
    || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) fail(field);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(field);
    result[key] = descriptor.value;
  }
  return result;
}

function openRecord(
  value: unknown,
  field: string,
  allowFrameworkNullObject = false,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const frameworkNullObject = allowFrameworkNullObject
    && prototype !== null
    && Object.getPrototypeOf(prototype) === null
    && Reflect.ownKeys(prototype).length === 0;
  if ((prototype !== Object.prototype && prototype !== null && !frameworkNullObject)
    || keys.some((key) => typeof key !== "string")) fail(field);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(field);
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, field: string, maximumBytes = 256): string {
  if (typeof value !== "string") fail(field);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) fail(field);
  return value;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(field);
  try { assertSha256(value, field); } catch { fail(field); }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) fail(field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(field);
  return parsed;
}

function mutationEnvelope(value: unknown): MutationEnvelope {
  const record = exactRecord(value, MUTATION_ENVELOPE_KEYS, "mutation_envelope");
  const operationId = text(record.operation_id, "operation_id");
  const scope = parseRuntimeCommandScopeSelectorV1({ scope: record.scope }).scope;
  openRecord(record.body, "command_body");
  return { operation_id: operationId, scope, body: record.body };
}

function authorityEnvelope(value: unknown): AuthorityEnvelope {
  const record = exactRecord(value, AUTHORITY_ENVELOPE_KEYS, "authority_envelope");
  const operationId = text(record.operation_id, "operation_id");
  const scope = parseRuntimeCommandScopeSelectorV1({ scope: record.scope }).scope;
  openRecord(record.body, "authority_command_body");
  return {
    operation_id: operationId,
    scope,
    task_family: text(record.task_family, "task_family"),
    body: record.body,
  };
}

function snapshotSelector(body: unknown): Readonly<{
  world_snapshot_id: string;
  world_snapshot_sha256: Sha256;
}> {
  const record = openRecord(body, "create_continuation_body");
  const ref = exactRecord(
    record.world_snapshot_ref,
    SNAPSHOT_REF_KEYS,
    "world_snapshot_ref",
  );
  return {
    world_snapshot_id: text(ref.world_snapshot_id, "world_snapshot_id"),
    world_snapshot_sha256: sha256(
      ref.world_snapshot_sha256,
      "world_snapshot_sha256",
    ),
  };
}

function outcomeDecisionId(body: unknown): string {
  const record = openRecord(body, "record_outcome_body");
  const ref = exactRecord(record.decision_ref, DECISION_REF_KEYS, "decision_ref");
  return text(ref.decision_id, "decision_id");
}

function requestId(request: FastifyRequest): string | null {
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(request.headers)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(request.headers, key);
    if (descriptor && descriptor.enumerable && "value" in descriptor
      && key.toLowerCase() === "x-request-id") values.push(descriptor.value);
  }
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(values[0])) return null;
  return values[0];
}

function errorEnvelope(
  request: FastifyRequest,
  code: string,
  operationId: string | null,
): ErrorEnvelope {
  return canonicalContinuationClone({
    schema_version: "continuation_runtime_http_error_v1" as const,
    error: {
      code,
      operation_id: operationId,
      request_id: requestId(request),
    },
  });
}

function setCallerRequestId(request: FastifyRequest, reply: FastifyReply): void {
  const value = requestId(request);
  if (value !== null) reply.header("x-request-id", value);
}

function errorMapping(error: unknown): Readonly<{ statusCode: number; code: string }> {
  if (error instanceof ContinuationRuntimeV1AuthenticationError) {
    return { statusCode: 401, code: "unauthorized" };
  }
  if (error instanceof ContinuationRuntimeV1ApplicationError) {
    return { statusCode: error.statusCode, code: error.code };
  }
  if (error instanceof Error
    && error.message.startsWith("continuation_runtime_v1_http_transport_")) {
    return { statusCode: 400, code: "invalid_request" };
  }
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const value = error as { code?: unknown; statusCode?: unknown };
    if (value.statusCode === 413 || value.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return { statusCode: 413, code: "payload_too_large" };
    }
    if (value.statusCode === 415) {
      return { statusCode: 415, code: "unsupported_media_type" };
    }
    if (value.statusCode === 400) {
      return { statusCode: 400, code: "invalid_request" };
    }
  }
  return { statusCode: 500, code: "internal_error" };
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  operationId: string | null,
): FastifyReply {
  const mapping = errorMapping(error);
  setCallerRequestId(request, reply);
  if (mapping.statusCode === 500) request.log.error({ err: error }, "v1 request failed");
  return reply.code(mapping.statusCode).send(
    errorEnvelope(request, mapping.code, operationId),
  );
}

function invalidCommand<T>(build: () => T): T {
  try {
    return build();
  } catch {
    throw new ContinuationRuntimeV1ApplicationError(400, "invalid_request");
  }
}

function canonicalResponse(value: CanonicalJson): CanonicalJson {
  const cloned = canonicalContinuationClone(value);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new Error("continuation_runtime_v1_http_application_response_invalid");
  }
  return cloned;
}

function assertApplication(value: unknown): asserts value is ContinuationRuntimeV1Application {
  const record = exactRecord(value, APPLICATION_KEYS, "application");
  if (APPLICATION_KEYS.some((key) => typeof record[key] !== "function")) fail("application");
}

function assertResolvedBinding(
  value: unknown,
  expectedKeys: readonly string[],
  expected: Readonly<{
    principal: ContinuationRuntimeV1Principal;
    scope: string;
    actor_kind: "trusted_host" | "operator";
    task_family: string | null;
  }>,
): void {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = exactRecord(value, expectedKeys, "resolved_binding");
  } catch {
    throw new Error("continuation_runtime_v1_http_resolved_binding_shape_invalid");
  }
  if (record.tenant_id !== expected.principal.tenant_id
    || record.scope !== expected.scope
    || record.actor_kind !== expected.actor_kind
    || record.actor_principal_sha256 !== expected.principal.principal_sha256
    || (expected.task_family !== null && record.task_family !== expected.task_family)) {
    throw new Error("continuation_runtime_v1_http_resolved_binding_identity_mismatch");
  }
  try {
    canonicalContinuationJson(record);
    text(record.task_family, "resolved_binding_task_family");
    assertSha256(
      record.actor_principal_sha256 as string,
      "resolved binding actor principal",
    );
    assertSha256(
      record.authority_subject_sha256 as string,
      "resolved binding authority subject",
    );
    const authoritySubject = continuationAuthoritySubjectSha256V1({
      tenant_id: record.tenant_id as string,
      scope: record.scope as string,
      task_family: record.task_family as string,
    });
    if (record.authority_subject_sha256 !== authoritySubject) {
      throw new Error("authority subject mismatch");
    }
    if (expectedKeys.includes("world_snapshot_id")) {
      text(record.world_snapshot_id, "resolved_binding_world_snapshot_id");
      assertSha256(
        record.world_snapshot_sha256 as string,
        "resolved binding world snapshot",
      );
    }
    if (expectedKeys.includes("decision_id")) {
      text(record.decision_id, "resolved_binding_decision_id");
      for (const key of [
        "contract_sha256",
        "exposure_receipt_sha256",
        "host_task_envelope_sha256",
        "render_result_sha256",
      ] as const) {
        assertSha256(record[key] as string, `resolved binding ${key}`);
      }
    }
  } catch {
    throw new Error("continuation_runtime_v1_http_resolved_binding_semantics_invalid");
  }
}

function parsePathDecisionId(value: unknown): string {
  const params = exactRecord(value, ["decision_id"], "decision_path", true);
  return text(params.decision_id, "decision_id");
}

function optionalQueryTriple(
  query: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly [string, number, Sha256] | null {
  const count = keys.filter((key) => Object.prototype.hasOwnProperty.call(query, key)).length;
  if (count === 0) return null;
  if (count !== keys.length) fail("decision_query_selector");
  return [
    text(query[keys[0]!], keys[0]!),
    positiveInteger(query[keys[1]!], keys[1]!),
    sha256(query[keys[2]!], keys[2]!),
  ];
}

function readDecisionTransport(value: unknown): ReadDecisionTransport {
  const query = openRecord(value, "decision_query", true);
  const keys = Object.keys(query);
  if (!keys.includes("scope") || !keys.includes("view")
    || keys.some((key) => !READ_QUERY_KEYS.has(key))) fail("decision_query");
  const scope = parseRuntimeCommandScopeSelectorV1({ scope: query.scope }).scope;
  const view = text(query.view, "decision_view");
  if (view !== "summary" && view !== "full" && view !== "counterfactual") {
    fail("decision_view");
  }
  const exclude = optionalQueryTriple(query, EXCLUDE_QUERY_KEYS);
  const substitute = optionalQueryTriple(query, SUBSTITUTE_QUERY_KEYS);
  if (view !== "counterfactual" && (exclude !== null || substitute !== null)) {
    fail("decision_query_counterfactual_selector");
  }
  return canonicalContinuationClone({
    scope,
    command_body: {
      view,
      exclude_capsule: exclude === null ? null : {
        capsule_id: exclude[0],
        capsule_revision: exclude[1],
        capsule_sha256: exclude[2],
      },
      substitute_branch: substitute === null ? null : {
        branch_id: substitute[0],
        branch_revision: substitute[1],
        manifest_sha256: substitute[2],
      },
    },
  });
}

function readiness(value: unknown): ContinuationRuntimeV1Readiness {
  const record = exactRecord(value, ["ready", "reason_codes"], "readiness_result");
  if (typeof record.ready !== "boolean" || !Array.isArray(record.reason_codes)
    || record.reason_codes.length > 32) fail("readiness_result");
  const reasons = record.reason_codes.map((reason) => text(reason, "readiness_reason"));
  const canonical = canonicalUniqueSet(reasons, (reason) => reason);
  if (canonical.length !== reasons.length
    || (record.ready && canonical.length !== 0)
    || (!record.ready && canonical.length === 0)) fail("readiness_result");
  return canonicalContinuationClone({ ready: record.ready, reason_codes: canonical });
}

async function sendSuccess(
  request: FastifyRequest,
  reply: FastifyReply,
  value: CanonicalJson,
): Promise<FastifyReply> {
  setCallerRequestId(request, reply);
  return reply.code(200).send(canonicalResponse(value));
}

export function continuationRuntimeV1HttpErrorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return sendError(request, reply, error, null);
}

export function continuationRuntimeV1HttpNotFoundHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  setCallerRequestId(request, reply);
  return reply.code(404).send(errorEnvelope(request, "not_found", null));
}

export function createContinuationRuntimeV1HttpHandlers(options: Readonly<{
  application: ContinuationRuntimeV1Application;
  config: ContinuationRuntimeV1DaemonConfig;
}>): Readonly<Record<ContinuationRuntimeV1HttpHandlerId, RouteHandlerMethod>> {
  assertApplication(options?.application);
  const application = options.application;
  const config = options.config;

  return Object.freeze({
    health: async (request, reply) => {
      setCallerRequestId(request, reply);
      return reply.code(200).send({
        schema_version: "continuation_runtime_health_v1",
        status: "alive",
      });
    },
    readiness: async (request, reply) => {
      try {
        const snapshot = readiness(await application.readiness());
        setCallerRequestId(request, reply);
        return reply.code(snapshot.ready ? 200 : 503).send({
          schema_version: "continuation_runtime_readiness_v1",
          status: snapshot.ready ? "ready" : "not_ready",
          reason_codes: snapshot.reason_codes,
        });
      } catch {
        setCallerRequestId(request, reply);
        return reply.code(503).send({
          schema_version: "continuation_runtime_readiness_v1",
          status: "not_ready",
          reason_codes: ["readiness_check_failed"],
        });
      }
    },
    record_observations: async (request, reply) => {
      let operationId: string | null = null;
      try {
        const principal = authenticateContinuationRuntimeV1(
          request.headers,
          config,
          "trusted_host",
        );
        const envelope = mutationEnvelope(request.body);
        operationId = envelope.operation_id;
        const command = invalidCommand(() => buildRecordObservationsCommandV1(
          envelope.operation_id,
          envelope.body,
          {
            tenant_id: principal.tenant_id,
            scope: envelope.scope,
            actor_kind: "trusted_host",
            actor_principal_sha256: principal.principal_sha256,
          },
        ));
        return await sendSuccess(
          request,
          reply,
          await application.recordObservations(command),
        );
      } catch (error) {
        return sendError(request, reply, error, operationId);
      }
    },
    create_continuation: async (request, reply) => {
      let operationId: string | null = null;
      try {
        const principal = authenticateContinuationRuntimeV1(
          request.headers,
          config,
          "trusted_host",
        );
        const envelope = mutationEnvelope(request.body);
        operationId = envelope.operation_id;
        const snapshot = snapshotSelector(envelope.body);
        const binding = await application.resolveSnapshotBinding({
          principal,
          operation_id: envelope.operation_id,
          scope: envelope.scope,
          ...snapshot,
        });
        assertResolvedBinding(binding, [
          "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
          "scope", "task_family", "tenant_id", "world_snapshot_id",
          "world_snapshot_sha256",
        ], {
          principal,
          scope: envelope.scope,
          actor_kind: "trusted_host",
          task_family: null,
        });
        if (binding.world_snapshot_id !== snapshot.world_snapshot_id
          || binding.world_snapshot_sha256 !== snapshot.world_snapshot_sha256) {
          throw new Error("continuation_runtime_v1_http_resolved_snapshot_mismatch");
        }
        const command = invalidCommand(() => buildCreateContinuationCommandV1(
          envelope.operation_id,
          envelope.body,
          binding,
        ));
        return await sendSuccess(
          request,
          reply,
          await application.createContinuation(command),
        );
      } catch (error) {
        return sendError(request, reply, error, operationId);
      }
    },
    record_outcome: async (request, reply) => {
      let operationId: string | null = null;
      try {
        const principal = authenticateContinuationRuntimeV1(
          request.headers,
          config,
          "trusted_host",
        );
        const envelope = mutationEnvelope(request.body);
        operationId = envelope.operation_id;
        const decisionId = outcomeDecisionId(envelope.body);
        const binding = await application.resolveDecisionBinding({
          principal,
          purpose: "record_outcome",
          operation_id: envelope.operation_id,
          scope: envelope.scope,
          decision_id: decisionId,
        });
        assertResolvedBinding(binding, [
          "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
          "contract_sha256", "decision_id", "exposure_receipt_sha256",
          "host_task_envelope_sha256", "render_result_sha256", "scope",
          "task_family", "tenant_id",
        ], {
          principal,
          scope: envelope.scope,
          actor_kind: "trusted_host",
          task_family: null,
        });
        if (binding.decision_id !== decisionId) {
          throw new Error("continuation_runtime_v1_http_resolved_decision_mismatch");
        }
        const command = invalidCommand(() => buildRecordOutcomeCommandV1(
          envelope.operation_id,
          envelope.body,
          binding,
        ));
        return await sendSuccess(
          request,
          reply,
          await application.recordOutcome(command),
        );
      } catch (error) {
        return sendError(request, reply, error, operationId);
      }
    },
    authority_decision: async (request, reply) => {
      let operationId: string | null = null;
      try {
        const principal = authenticateContinuationRuntimeV1(
          request.headers,
          config,
          "operator",
        );
        const envelope = authorityEnvelope(request.body);
        operationId = envelope.operation_id;
        const authoritySubject = continuationAuthoritySubjectSha256V1({
          tenant_id: principal.tenant_id,
          scope: envelope.scope,
          task_family: envelope.task_family,
        });
        const binding = await application.resolveAuthorityBinding({
          principal,
          operation_id: envelope.operation_id,
          scope: envelope.scope,
          task_family: envelope.task_family,
          authority_subject_sha256: authoritySubject,
        });
        assertResolvedBinding(binding, [
          "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
          "scope", "task_family", "tenant_id",
        ], {
          principal,
          scope: envelope.scope,
          actor_kind: "operator",
          task_family: envelope.task_family,
        });
        if (binding.authority_subject_sha256 !== authoritySubject) {
          throw new Error("continuation_runtime_v1_http_resolved_authority_subject_mismatch");
        }
        const command = invalidCommand(() => buildAuthorityDecisionCommandV1(
          envelope.operation_id,
          envelope.body,
          binding,
        ));
        return await sendSuccess(
          request,
          reply,
          await application.decideAuthority(command),
        );
      } catch (error) {
        return sendError(request, reply, error, operationId);
      }
    },
    read_decision: async (request, reply) => {
      try {
        const principal = authenticateContinuationRuntimeV1(
          request.headers,
          config,
          "trusted_host_or_operator",
        );
        const decisionId = parsePathDecisionId(request.params);
        const transport = readDecisionTransport(request.query);
        if (transport.command_body.view === "counterfactual"
          && principal.principal_kind !== "operator") {
          throw new ContinuationRuntimeV1ApplicationError(403, "forbidden");
        }
        const binding = await application.resolveDecisionBinding({
          principal,
          purpose: "read_decision",
          operation_id: null,
          scope: transport.scope,
          decision_id: decisionId,
        });
        assertResolvedBinding(binding, [
          "actor_kind", "actor_principal_sha256", "authority_subject_sha256",
          "contract_sha256", "decision_id", "exposure_receipt_sha256",
          "host_task_envelope_sha256", "render_result_sha256", "scope",
          "task_family", "tenant_id",
        ], {
          principal,
          scope: transport.scope,
          actor_kind: principal.principal_kind,
          task_family: null,
        });
        if (binding.decision_id !== decisionId) {
          throw new Error("continuation_runtime_v1_http_resolved_decision_mismatch");
        }
        const query = invalidCommand(() => buildAuthenticatedDecisionQueryV1(
          decisionId,
          transport.command_body,
          binding,
        ));
        return await sendSuccess(
          request,
          reply,
          await application.readDecision(query),
        );
      } catch (error) {
        return sendError(request, reply, error, null);
      }
    },
  });
}
