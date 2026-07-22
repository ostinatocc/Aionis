import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationSha256,
  canonicalSha256Without,
  compareCanonicalUtf8,
  type Sha256,
} from "./contract.js";

const MAX_HOST_TASK_ENVELOPE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export type HostTaskEnvelopeInputV1 = Readonly<{
  host_task_id: string;
  episode_id: string;
  run_id: string;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  task_family: string;
  task_signature: string;
  workflow_signature: string | null;
  workspace_signature: string;
  source_task_sha256: Sha256;
  source_event_sha256: Sha256;
  issued_at: string;
  expires_at: string;
}>;

/**
 * Security domain supplied by the authenticated transport boundary, never by
 * the host task request body. Keeping it as a separate argument makes an
 * accidental object spread from request JSON fail the exact-shape checks.
 */
export type AuthenticatedTaskDomainV1 = Readonly<{
  tenant_id: string;
  scope: string;
  authority_subject_sha256: Sha256;
}>;

export type AuthenticatedHostScopeV1 = Readonly<{
  tenant_id: string;
  scope: string;
}>;

export type HostTaskEnvelopeV1 = HostTaskEnvelopeInputV1
  & AuthenticatedTaskDomainV1 & Readonly<{
  schema_version: "host_task_envelope_v1";
  host_task_envelope_sha256: Sha256;
}>;

const INPUT_KEYS = Object.freeze([
  "consumer_agent_id",
  "consumer_team_id",
  "episode_id",
  "expires_at",
  "host_task_id",
  "issued_at",
  "run_id",
  "source_event_sha256",
  "source_task_sha256",
  "task_family",
  "task_signature",
  "workflow_signature",
  "workspace_signature",
] as const);

const ENVELOPE_KEYS = Object.freeze([
  ...INPUT_KEYS,
  "authority_subject_sha256",
  "host_task_envelope_sha256",
  "schema_version",
  "scope",
  "tenant_id",
].sort(compareCanonicalUtf8));

const DOMAIN_KEYS = Object.freeze([
  "authority_subject_sha256",
  "scope",
  "tenant_id",
] as const);

function assertExactKeys(value: unknown, keys: readonly string[], field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error(`${field} contains unknown or missing fields`);
  }
  const actual = (ownKeys as string[]).sort(compareCanonicalUtf8);
  const expected = [...keys].sort(compareCanonicalUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} contains unknown or missing fields`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${field} must contain only enumerable data properties`);
    }
  }
}

function assertText(value: unknown, maxBytes: number, field: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} must be bounded canonical UTF-8 text`);
  }
}

function assertNullableText(
  value: unknown,
  maxBytes: number,
  field: string,
): asserts value is string | null {
  if (value !== null) assertText(value, maxBytes, field);
}

function assertInput(value: unknown): asserts value is HostTaskEnvelopeInputV1 {
  assertExactKeys(value, INPUT_KEYS, "host task envelope input");
  const input = value as Record<string, unknown>;
  for (const field of ["host_task_id", "episode_id", "run_id", "task_family"] as const) {
    assertText(input[field], 256, `host_task_envelope.${field}`);
  }
  assertText(input.task_signature, 512, "host_task_envelope.task_signature");
  assertText(input.workspace_signature, 512, "host_task_envelope.workspace_signature");
  assertNullableText(input.workflow_signature, 512, "host_task_envelope.workflow_signature");
  assertNullableText(input.consumer_agent_id, 256, "host_task_envelope.consumer_agent_id");
  assertNullableText(input.consumer_team_id, 256, "host_task_envelope.consumer_team_id");
  if (typeof input.source_task_sha256 !== "string"
    || typeof input.source_event_sha256 !== "string") {
    throw new Error("host task envelope source digests must be text");
  }
  assertSha256(input.source_task_sha256, "host_task_envelope.source_task_sha256");
  assertSha256(input.source_event_sha256, "host_task_envelope.source_event_sha256");
  if (typeof input.issued_at !== "string" || typeof input.expires_at !== "string") {
    throw new Error("host task envelope timestamps must be text");
  }
  assertCanonicalUtcMillis(input.issued_at, "host_task_envelope.issued_at");
  assertCanonicalUtcMillis(input.expires_at, "host_task_envelope.expires_at");
  const lifetimeMs = Date.parse(input.expires_at) - Date.parse(input.issued_at);
  if (lifetimeMs <= 0 || lifetimeMs > MAX_HOST_TASK_ENVELOPE_LIFETIME_MS) {
    throw new Error(
      "host_task_envelope.expires_at must be later than issued_at and at most 24 hours later",
    );
  }
}

function parseAuthenticatedDomain(
  value: unknown,
  taskFamily: string,
): AuthenticatedTaskDomainV1 {
  assertExactKeys(value, DOMAIN_KEYS, "authenticated task domain");
  const domain = value as Record<string, unknown>;
  assertText(domain.tenant_id, 256, "authenticated_task_domain.tenant_id");
  assertText(domain.scope, 256, "authenticated_task_domain.scope");
  if (typeof domain.authority_subject_sha256 !== "string") {
    throw new Error("authenticated_task_domain.authority_subject_sha256 must be text");
  }
  assertSha256(
    domain.authority_subject_sha256,
    "authenticated_task_domain.authority_subject_sha256",
  );
  const expectedSubject = continuationAuthoritySubjectSha256V1({
    tenant_id: domain.tenant_id,
    scope: domain.scope,
    task_family: taskFamily,
  });
  if (domain.authority_subject_sha256 !== expectedSubject) {
    throw new Error(
      "authenticated task domain authority subject does not match tenant, scope, and task family",
    );
  }
  return canonicalContinuationClone({
    tenant_id: domain.tenant_id,
    scope: domain.scope,
    authority_subject_sha256: domain.authority_subject_sha256,
  });
}

export function buildHostTaskEnvelopeV1(
  value: HostTaskEnvelopeInputV1,
  authenticatedDomain: AuthenticatedTaskDomainV1,
): HostTaskEnvelopeV1 {
  assertInput(value);
  const domain = parseAuthenticatedDomain(authenticatedDomain, value.task_family);
  const body = {
    schema_version: "host_task_envelope_v1" as const,
    ...domain,
    ...value,
  };
  return canonicalContinuationClone({
    ...body,
    host_task_envelope_sha256: canonicalContinuationSha256(body),
  });
}

/**
 * Production ingress helper. Only tenant and scope come from authentication;
 * the authority subject is deterministically derived after the request body
 * has passed its exact-shape validation.
 */
export function buildHostTaskEnvelopeFromAuthenticatedScopeV1(
  value: HostTaskEnvelopeInputV1,
  authenticatedScope: AuthenticatedHostScopeV1,
): HostTaskEnvelopeV1 {
  assertInput(value);
  assertExactKeys(authenticatedScope, ["scope", "tenant_id"], "authenticated host scope");
  const scope = authenticatedScope as Readonly<Record<string, unknown>>;
  assertText(scope.tenant_id, 256, "authenticated_host_scope.tenant_id");
  assertText(scope.scope, 256, "authenticated_host_scope.scope");
  return buildHostTaskEnvelopeV1(value, {
    tenant_id: scope.tenant_id,
    scope: scope.scope,
    authority_subject_sha256: continuationAuthoritySubjectSha256V1({
      tenant_id: scope.tenant_id,
      scope: scope.scope,
      task_family: value.task_family,
    }),
  });
}

export function verifyHostTaskEnvelopeV1(value: unknown): HostTaskEnvelopeV1 {
  assertExactKeys(value, ENVELOPE_KEYS, "host task envelope");
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "host_task_envelope_v1"
    || typeof record.host_task_envelope_sha256 !== "string") {
    throw new Error("host task envelope version or digest is invalid");
  }
  assertSha256(record.host_task_envelope_sha256, "host_task_envelope_sha256");
  const input = Object.fromEntries(
    INPUT_KEYS.map((key) => [key, record[key]]),
  ) as HostTaskEnvelopeInputV1;
  const domain = Object.fromEntries(
    DOMAIN_KEYS.map((key) => [key, record[key]]),
  ) as AuthenticatedTaskDomainV1;
  const built = buildHostTaskEnvelopeV1(input, domain);
  if (built.host_task_envelope_sha256 !== record.host_task_envelope_sha256
    || canonicalSha256Without(
      value as Readonly<Record<string, unknown>>,
      "host_task_envelope_sha256",
    ) !== record.host_task_envelope_sha256) {
    throw new Error("host task envelope digest is invalid");
  }
  return built;
}

/**
 * Authority is selected by Runtime from the authenticated tenant/scope and
 * coarse task family. Task and workspace signatures remain applicability
 * fences; making them branch identities would fragment evidence into one-off
 * subjects and prevent learning across equivalent tasks.
 */
export function continuationAuthoritySubjectSha256V1(args: Readonly<{
  tenant_id: string;
  scope: string;
  task_family: string;
}>): Sha256 {
  assertExactKeys(args, ["tenant_id", "scope", "task_family"], "authority subject input");
  assertText(args.tenant_id, 256, "authority_subject.tenant_id");
  assertText(args.scope, 256, "authority_subject.scope");
  assertText(args.task_family, 256, "authority_subject.task_family");
  return canonicalContinuationSha256({
    schema_version: "continuation_authority_subject_v1",
    tenant_id: args.tenant_id,
    scope: args.scope,
    task_family: args.task_family,
  });
}
