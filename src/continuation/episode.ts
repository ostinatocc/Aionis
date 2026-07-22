import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  compareCanonicalUtf8,
  type CanonicalJson,
  type Sha256,
} from "./contract.js";

export type EpisodeEventKindV1 =
  | "contract_exposed"
  | "capsule_use_observed"
  | "outcome_observed"
  | "effect_certified";

export type InfluenceEpisodeEventKindV1 = Extract<
  EpisodeEventKindV1,
  "contract_exposed" | "capsule_use_observed" | "outcome_observed" | "effect_certified"
>;

export type EpisodeEventRefV1 = Readonly<{
  event_sequence: number;
  event_id: string;
  event_kind: EpisodeEventKindV1;
  event_sha256: Sha256;
}>;

export type EpisodeDecisionContextV1 = Readonly<{
  context_kind: "decision";
  decision_id: string;
  run_id: string;
  host_task_envelope_sha256: Sha256;
  contract_sha256: Sha256;
  coverage_certificate_sha256: Sha256;
  render_result_sha256: Sha256;
  authority_subject_sha256: Sha256;
  branch_manifest_sha256: Sha256;
}>;

export type EpisodeEventContextV1 = EpisodeDecisionContextV1;

export type EpisodeSourceOperationV1 = Readonly<{
  operation_kind:
    | "create_continuation"
    | "record_outcome"
    | "worker_completion";
  operation_id: string;
  request_sha256: Sha256;
}>;

export type EpisodeEventPayloadV1 =
  | Readonly<{
    payload_kind: "contract_exposed_v1";
    continuation_contract: Readonly<{ readonly [key: string]: CanonicalJson }>;
    render_result: Readonly<{ readonly [key: string]: CanonicalJson }>;
  }>
  | Readonly<{
    payload_kind: "capsule_use_observed_v1";
    use_receipt: Readonly<{ readonly [key: string]: CanonicalJson }>;
  }>
  | Readonly<{
    payload_kind: "outcome_observed_v1";
    outcome_receipt: Readonly<{ readonly [key: string]: CanonicalJson }>;
  }>
  | Readonly<{
    payload_kind: "effect_certified_v1";
    evidence_member: EffectEvidenceMemberRefV1;
  }>;

export type EpisodeEventInputV1 = Readonly<{
  tenant_id: string;
  scope: string;
  episode_id: string;
  event_sequence: number;
  event_id: string;
  event_kind: EpisodeEventKindV1;
  source_operation: EpisodeSourceOperationV1;
  previous_event_ref: EpisodeEventRefV1 | null;
  cause_event_ref: EpisodeEventRefV1 | null;
  context: EpisodeEventContextV1;
  render_result_sha256: Sha256;
  effect_certificate_sha256: Sha256 | null;
  effect_member_sequence: number | null;
  capsule_fact_count: number | null;
  capsule_fact_set_sha256: Sha256 | null;
  payload: EpisodeEventPayloadV1;
  created_at: string;
}>;

export type EpisodeEventV1 = EpisodeEventInputV1 & Readonly<{
  schema_version: "episode_event_v1";
  payload_sha256: Sha256;
  event_sha256: Sha256;
}>;

export type EffectEvidenceMemberInputV1 = Readonly<{
  scope: string;
  episode_id: string;
  decision_id: string;
  terminal_event: EpisodeEventRefV1 & Readonly<{
    event_kind: "contract_exposed" | "outcome_observed";
  }>;
}>;

export type EffectEvidenceMemberRefV1 = EffectEvidenceMemberInputV1 & Readonly<{
  member_sequence: number;
}>;

export type EffectEvidenceMemberSetV1 = Readonly<{
  schema_version: "effect_evidence_member_set_v1";
  members: readonly EffectEvidenceMemberRefV1[];
  eligible_decision_count: number;
  eligible_decision_set_sha256: Sha256;
}>;

export type EpisodeCapsuleSurfaceV1 =
  | "use_now"
  | "inspect_before_use"
  | "do_not_use"
  | "rehydrate";

export type EpisodeCapsuleFactInputV1 = Readonly<{
  capsule_scope: string;
  capsule_id: string;
  capsule_revision: number;
  capsule_sha256: Sha256;
  surface: EpisodeCapsuleSurfaceV1;
  use_state: "used" | "not_used" | "unknown" | null;
}>;

export type EpisodeCapsuleFactMemberV1 = EpisodeCapsuleFactInputV1 & Readonly<{
  fact_sequence: number;
}>;

export type EpisodeCapsuleFactSetV1 = Readonly<{
  schema_version: "episode_capsule_fact_set_v1";
  event_kind: "contract_exposed" | "capsule_use_observed";
  facts: readonly EpisodeCapsuleFactMemberV1[];
  capsule_fact_count: number;
  capsule_fact_set_sha256: Sha256;
}>;

export type EpisodeCapsuleFactRecordInputV1 = Readonly<{
  tenant_id: string;
  scope: string;
  episode_id: string;
  event_ref: EpisodeEventRefV1 & Readonly<{
    event_kind: "contract_exposed" | "capsule_use_observed";
  }>;
  fact: EpisodeCapsuleFactMemberV1;
}>;

export type EpisodeCapsuleFactV1 = EpisodeCapsuleFactRecordInputV1 & Readonly<{
  schema_version: "episode_capsule_fact_v1";
  fact_sha256: Sha256;
}>;

export type EpisodeContractErrorCode =
  | "invalid_episode_contract"
  | "episode_digest_mismatch";

export class EpisodeContractError extends Error {
  readonly code: EpisodeContractErrorCode;

  constructor(code: EpisodeContractErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "EpisodeContractError";
    this.code = code;
  }
}

const MAX_EVENT_PAYLOAD_BYTES = 1_048_576;
const MAX_EFFECT_MEMBERS = 4_096;
const MAX_CAPSULE_FACTS = 256;

const EVENT_REF_KEYS = Object.freeze([
  "event_id", "event_kind", "event_sequence", "event_sha256",
] as const);
const DECISION_KEYS = Object.freeze([
  "authority_subject_sha256",
  "branch_manifest_sha256",
  "context_kind",
  "contract_sha256",
  "coverage_certificate_sha256",
  "decision_id",
  "host_task_envelope_sha256",
  "render_result_sha256",
  "run_id",
] as const);
const SOURCE_OPERATION_KEYS = Object.freeze([
  "operation_id", "operation_kind", "request_sha256",
] as const);
const EVENT_INPUT_KEYS = Object.freeze([
  "capsule_fact_count",
  "capsule_fact_set_sha256",
  "cause_event_ref",
  "created_at",
  "context",
  "effect_certificate_sha256",
  "effect_member_sequence",
  "episode_id",
  "event_id",
  "event_kind",
  "event_sequence",
  "payload",
  "previous_event_ref",
  "render_result_sha256",
  "scope",
  "source_operation",
  "tenant_id",
] as const);
const EXPOSURE_PAYLOAD_KEYS = Object.freeze([
  "continuation_contract", "payload_kind", "render_result",
] as const);
const USE_PAYLOAD_KEYS = Object.freeze(["payload_kind", "use_receipt"] as const);
const OUTCOME_PAYLOAD_KEYS = Object.freeze(["outcome_receipt", "payload_kind"] as const);
const EFFECT_PAYLOAD_KEYS = Object.freeze(["evidence_member", "payload_kind"] as const);
const EVENT_KEYS = Object.freeze([
  ...EVENT_INPUT_KEYS, "event_sha256", "payload_sha256", "schema_version",
] as const);
const EFFECT_MEMBER_INPUT_KEYS = Object.freeze([
  "decision_id", "episode_id", "scope", "terminal_event",
] as const);
const EFFECT_MEMBER_KEYS = Object.freeze([
  ...EFFECT_MEMBER_INPUT_KEYS, "member_sequence",
] as const);
const EFFECT_MEMBER_SET_KEYS = Object.freeze([
  "eligible_decision_count",
  "eligible_decision_set_sha256",
  "members",
  "schema_version",
] as const);
const CAPSULE_FACT_INPUT_KEYS = Object.freeze([
  "capsule_id",
  "capsule_revision",
  "capsule_scope",
  "capsule_sha256",
  "surface",
  "use_state",
] as const);
const CAPSULE_FACT_MEMBER_KEYS = Object.freeze([
  ...CAPSULE_FACT_INPUT_KEYS, "fact_sequence",
] as const);
const CAPSULE_FACT_SET_KEYS = Object.freeze([
  "capsule_fact_count",
  "capsule_fact_set_sha256",
  "event_kind",
  "facts",
  "schema_version",
] as const);
const CAPSULE_FACT_RECORD_INPUT_KEYS = Object.freeze([
  "episode_id", "event_ref", "fact", "scope", "tenant_id",
] as const);
const CAPSULE_FACT_RECORD_KEYS = Object.freeze([
  ...CAPSULE_FACT_RECORD_INPUT_KEYS, "fact_sha256", "schema_version",
] as const);

function fail(message: string): never {
  throw new EpisodeContractError("invalid_episode_contract", message);
}

function wrapInvalid<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EpisodeContractError) throw error;
    throw new EpisodeContractError(
      "invalid_episode_contract",
      error instanceof Error ? error.message : "episode contract validation failed",
      { cause: error },
    );
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
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
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(`${field} must contain only string-keyed data properties`);
  }
  const actual = ownKeys as string[];
  const expected = new Set(expectedKeys);
  if (actual.length !== expectedKeys.length
    || actual.some((key) => !expected.has(key))
    || expectedKeys.some((key) => !actual.includes(key))) {
    fail(`${field} contains unknown or missing fields`);
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `${field} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactArray(value: unknown, maxLength: number, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${field} must be a plain array`);
  }
  if (value.length > maxLength) fail(`${field} exceeds ${maxLength} entries`);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
    || ownKeys.length !== expected.size) {
    fail(`${field} must be dense and contain no extra properties`);
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field} must contain only enumerable data elements`);
    }
    out.push(descriptor.value);
  }
  return out;
}

function boundedText(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string") fail(`${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${field} must contain 1-${maxBytes} canonical UTF-8 bytes and no C0 or DEL controls`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function boundedCount(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(`${field} must be a safe integer between 0 and ${maximum}`);
  }
  return value as number;
}

function sha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field} must be a SHA-256 digest`);
  assertSha256(value, field);
  return value;
}

function nullableSha256(value: unknown, field: string): Sha256 | null {
  return value === null ? null : sha256(value, field);
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a timestamp`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function eventKind(value: unknown, field: string): EpisodeEventKindV1 {
  if (value !== "contract_exposed" && value !== "capsule_use_observed"
    && value !== "outcome_observed" && value !== "effect_certified") {
    fail(`${field} is not a closed episode event kind`);
  }
  return value;
}

function eventRef(value: unknown, field: string): EpisodeEventRefV1 {
  const record = exactRecord(value, EVENT_REF_KEYS, field);
  return {
    event_sequence: positiveInteger(record.event_sequence, `${field}.event_sequence`),
    event_id: boundedText(record.event_id, `${field}.event_id`),
    event_kind: eventKind(record.event_kind, `${field}.event_kind`),
    event_sha256: sha256(record.event_sha256, `${field}.event_sha256`),
  };
}

function nullableEventRef(value: unknown, field: string): EpisodeEventRefV1 | null {
  return value === null ? null : eventRef(value, field);
}

function decisionContext(value: unknown): EpisodeDecisionContextV1 {
  const record = exactRecord(value, DECISION_KEYS, "decision");
  if (record.context_kind !== "decision") fail("decision context_kind is invalid");
  return {
    context_kind: "decision",
    decision_id: boundedText(record.decision_id, "decision.decision_id"),
    run_id: boundedText(record.run_id, "decision.run_id"),
    host_task_envelope_sha256: sha256(
      record.host_task_envelope_sha256,
      "decision.host_task_envelope_sha256",
    ),
    contract_sha256: sha256(record.contract_sha256, "decision.contract_sha256"),
    coverage_certificate_sha256: sha256(
      record.coverage_certificate_sha256,
      "decision.coverage_certificate_sha256",
    ),
    render_result_sha256: sha256(
      record.render_result_sha256,
      "decision.render_result_sha256",
    ),
    authority_subject_sha256: sha256(
      record.authority_subject_sha256,
      "decision.authority_subject_sha256",
    ),
    branch_manifest_sha256: sha256(
      record.branch_manifest_sha256,
      "decision.branch_manifest_sha256",
    ),
  };
}

function sourceOperation(value: unknown): EpisodeSourceOperationV1 {
  const record = exactRecord(value, SOURCE_OPERATION_KEYS, "source_operation");
  if (record.operation_kind !== "create_continuation"
    && record.operation_kind !== "record_outcome"
    && record.operation_kind !== "worker_completion") {
    fail("source_operation.operation_kind is not closed");
  }
  return {
    operation_kind: record.operation_kind,
    operation_id: boundedText(record.operation_id, "source_operation.operation_id"),
    request_sha256: sha256(record.request_sha256, "source_operation.request_sha256"),
  };
}

function assertControlFree(value: CanonicalJson, field: string): void {
  if (typeof value === "string") {
    if (/[\u0000-\u001f\u007f]/u.test(value)) fail(`${field} contains C0 or DEL controls`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    for (const child of value) assertControlFree(child, field);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/[\u0000-\u001f\u007f]/u.test(key)) fail(`${field} contains C0 or DEL controls`);
    assertControlFree(child, field);
  }
}

function canonicalObject(value: unknown, field: string, maxBytes: number): EpisodeEventPayloadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a canonical JSON object`);
  }
  const json = canonicalContinuationJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes < 2 || bytes > maxBytes) fail(`${field} exceeds its canonical byte bound`);
  const cloned = canonicalContinuationClone(value) as Readonly<{
    readonly [key: string]: CanonicalJson;
  }>;
  assertControlFree(cloned, field);
  return cloned as EpisodeEventPayloadV1;
}

function effectMemberRef(value: unknown, field: string): EffectEvidenceMemberRefV1 {
  const record = exactRecord(value, EFFECT_MEMBER_KEYS, field);
  return {
    ...parseEffectMemberInput(Object.fromEntries(
      EFFECT_MEMBER_INPUT_KEYS.map((key) => [key, record[key]]),
    )),
    member_sequence: positiveInteger(record.member_sequence, `${field}.member_sequence`),
  };
}

function parseEventPayload(kind: EpisodeEventKindV1, value: unknown): EpisodeEventPayloadV1 {
  let payload: EpisodeEventPayloadV1;
  if (kind === "contract_exposed") {
    const record = exactRecord(value, EXPOSURE_PAYLOAD_KEYS, "contract exposure payload");
    if (record.payload_kind !== "contract_exposed_v1") fail("exposure payload_kind is invalid");
    payload = {
      payload_kind: "contract_exposed_v1",
      continuation_contract: canonicalObject(
        record.continuation_contract,
        "continuation_contract",
        MAX_EVENT_PAYLOAD_BYTES,
      ),
      render_result: canonicalObject(
        record.render_result,
        "render_result",
        MAX_EVENT_PAYLOAD_BYTES,
      ),
    };
  } else if (kind === "capsule_use_observed") {
    const record = exactRecord(value, USE_PAYLOAD_KEYS, "capsule use payload");
    if (record.payload_kind !== "capsule_use_observed_v1") fail("use payload_kind is invalid");
    payload = {
      payload_kind: "capsule_use_observed_v1",
      use_receipt: canonicalObject(record.use_receipt, "use_receipt", MAX_EVENT_PAYLOAD_BYTES),
    };
  } else if (kind === "outcome_observed") {
    const record = exactRecord(value, OUTCOME_PAYLOAD_KEYS, "outcome payload");
    if (record.payload_kind !== "outcome_observed_v1") fail("outcome payload_kind is invalid");
    payload = {
      payload_kind: "outcome_observed_v1",
      outcome_receipt: canonicalObject(
        record.outcome_receipt,
        "outcome_receipt",
        MAX_EVENT_PAYLOAD_BYTES,
      ),
    };
  } else {
    const record = exactRecord(value, EFFECT_PAYLOAD_KEYS, "effect membership payload");
    if (record.payload_kind !== "effect_certified_v1") fail("effect payload_kind is invalid");
    payload = {
      payload_kind: "effect_certified_v1",
      evidence_member: effectMemberRef(record.evidence_member, "effect evidence_member"),
    };
  }
  const json = canonicalContinuationJson(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    fail(`event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} canonical bytes`);
  }
  return canonicalContinuationClone(payload);
}

function parseEventInput(value: unknown): EpisodeEventInputV1 {
  const record = exactRecord(value, EVENT_INPUT_KEYS, "episode event input");
  const kind = eventKind(record.event_kind, "event_kind");
  const sequence = positiveInteger(record.event_sequence, "event_sequence");
  const previous = nullableEventRef(record.previous_event_ref, "previous_event_ref");
  const cause = nullableEventRef(record.cause_event_ref, "cause_event_ref");
  const source = sourceOperation(record.source_operation);
  const effectMemberSequence = record.effect_member_sequence === null
    ? null
    : positiveInteger(record.effect_member_sequence, "effect_member_sequence");
  const capsuleFactCount = record.capsule_fact_count === null
    ? null
    : boundedCount(record.capsule_fact_count, "capsule_fact_count", MAX_CAPSULE_FACTS);
  const capsuleFactSetSha256 = nullableSha256(
    record.capsule_fact_set_sha256,
    "capsule_fact_set_sha256",
  );

  if ((sequence === 1 && previous !== null)
    || (sequence > 1 && previous?.event_sequence !== sequence - 1)) {
    fail("previous_event_ref must identify the immediately preceding episode event");
  }
  if (cause !== null && cause.event_sequence >= sequence) {
    fail("cause_event_ref must identify an earlier episode event");
  }
  const validSource = kind === "contract_exposed"
    ? source.operation_kind === "create_continuation"
    : kind === "capsule_use_observed" || kind === "outcome_observed"
      ? source.operation_kind === "record_outcome"
      : source.operation_kind === "worker_completion";
  if (!validSource) fail(`${kind} has an invalid source operation kind`);

  const expectedCause = kind === "contract_exposed"
    ? null
    : kind === "capsule_use_observed"
      ? "contract_exposed"
      : kind === "outcome_observed"
        ? "capsule_use_observed"
        : null;
  if ((expectedCause === null && kind === "contract_exposed" && cause !== null)
    || (expectedCause !== null && cause?.event_kind !== expectedCause)
    || (kind === "effect_certified"
      && cause?.event_kind !== "contract_exposed"
      && cause?.event_kind !== "outcome_observed")) {
    fail(`${kind} has an invalid cause_event_ref`);
  }

  const render = sha256(record.render_result_sha256, "render_result_sha256");
  const certificate = nullableSha256(
    record.effect_certificate_sha256,
    "effect_certificate_sha256",
  );
  const hasFacts = kind === "contract_exposed" || kind === "capsule_use_observed";
  if ((kind === "effect_certified") !== (certificate !== null)
    || (kind === "effect_certified") !== (effectMemberSequence !== null)) {
    fail("only effect_certified requires certificate identity and member sequence");
  }
  if (hasFacts !== (capsuleFactCount !== null)
    || hasFacts !== (capsuleFactSetSha256 !== null)) {
    fail("only exposure and use events require a complete capsule fact-set header");
  }

  const context = decisionContext(record.context);
  if (render !== context.render_result_sha256) {
    fail("event render_result_sha256 must equal its decision context");
  }
  const payload = parseEventPayload(kind, record.payload);
  if (kind === "effect_certified") {
    const member = (payload as Extract<
      EpisodeEventPayloadV1,
      { payload_kind: "effect_certified_v1" }
    >).evidence_member;
    if (member.scope !== record.scope
      || member.episode_id !== record.episode_id
      || member.decision_id !== context.decision_id
      || member.member_sequence !== effectMemberSequence
      || canonicalContinuationJson(member.terminal_event)
        !== canonicalContinuationJson(cause)) {
      fail("effect membership payload must exactly bind event scope, decision, sequence, and cause");
    }
  }

  return {
    tenant_id: boundedText(record.tenant_id, "tenant_id"),
    scope: boundedText(record.scope, "scope"),
    episode_id: boundedText(record.episode_id, "episode_id"),
    event_sequence: sequence,
    event_id: boundedText(record.event_id, "event_id"),
    event_kind: kind,
    source_operation: source,
    previous_event_ref: previous,
    cause_event_ref: cause,
    context,
    render_result_sha256: render,
    effect_certificate_sha256: certificate,
    effect_member_sequence: effectMemberSequence,
    capsule_fact_count: capsuleFactCount,
    capsule_fact_set_sha256: capsuleFactSetSha256,
    payload,
    created_at: timestamp(record.created_at, "created_at"),
  };
}

function assembleEvent(input: EpisodeEventInputV1): EpisodeEventV1 {
  const payloadSha256 = canonicalContinuationSha256(input.payload);
  const body = {
    schema_version: "episode_event_v1" as const,
    ...input,
    payload_sha256: payloadSha256,
  };
  return canonicalContinuationClone({
    ...body,
    event_sha256: canonicalContinuationSha256(body),
  });
}

export function buildEpisodeEventV1(value: EpisodeEventInputV1): EpisodeEventV1 {
  return wrapInvalid(() => assembleEvent(parseEventInput(value)));
}

export function verifyEpisodeEventV1(value: unknown): EpisodeEventV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, EVENT_KEYS, "episode event");
    if (record.schema_version !== "episode_event_v1") fail("episode event schema_version is invalid");
    const suppliedPayloadSha256 = sha256(record.payload_sha256, "payload_sha256");
    const suppliedEventSha256 = sha256(record.event_sha256, "event_sha256");
    const input = Object.fromEntries(EVENT_INPUT_KEYS.map((key) => [key, record[key]]));
    const rebuilt = assembleEvent(parseEventInput(input));
    if (rebuilt.payload_sha256 !== suppliedPayloadSha256
      || rebuilt.event_sha256 !== suppliedEventSha256
      || canonicalSha256Without(
        value as Readonly<Record<string, unknown>>,
        "event_sha256",
      ) !== suppliedEventSha256) {
      throw new EpisodeContractError(
        "episode_digest_mismatch",
        "episode event digests do not authenticate the exact canonical event",
      );
    }
    return rebuilt;
  });
}

export function episodeEventRefV1(value: EpisodeEventV1): EpisodeEventRefV1 {
  const event = verifyEpisodeEventV1(value);
  return canonicalContinuationClone({
    event_sequence: event.event_sequence,
    event_id: event.event_id,
    event_kind: event.event_kind,
    event_sha256: event.event_sha256,
  });
}

export function verifyEpisodeEventBundleV1(value: unknown): readonly EpisodeEventV1[] {
  return wrapInvalid(() => {
    const events = exactArray(value, 4_096, "episode event bundle").map(verifyEpisodeEventV1);
    if (events.length === 0) fail("episode event bundle must not be empty");
    const first = events[0]!;
    const byRef = new Map<string, EpisodeEventV1>();
    const decisionKinds = new Set<string>();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.tenant_id !== first.tenant_id || event.scope !== first.scope
        || event.episode_id !== first.episode_id || event.event_sequence !== index + 1) {
        fail("episode event bundle must be one complete, contiguous episode chain");
      }
      const previous = index === 0 ? null : episodeEventRefV1(events[index - 1]!);
      if (canonicalContinuationJson(event.previous_event_ref)
        !== canonicalContinuationJson(previous)) {
        fail("episode event bundle previous-event chain is inconsistent");
      }
      if (event.cause_event_ref !== null) {
        const cause = byRef.get(canonicalContinuationJson(event.cause_event_ref));
        if (!cause) fail("episode event cause does not resolve to an earlier exact event");
        if (event.context.context_kind !== "decision"
          || cause.context.context_kind !== "decision"
          || canonicalContinuationJson(event.context)
            !== canonicalContinuationJson(cause.context)) {
          fail("episode event cause and dependent event must bind the same decision context");
        }
        if (event.event_kind === "outcome_observed"
          && canonicalContinuationJson(event.source_operation)
            !== canonicalContinuationJson(cause.source_operation)) {
          fail("use and outcome events must belong to one exact record_outcome operation");
        }
      }
      if (event.context.context_kind === "decision"
        && event.event_kind !== "effect_certified") {
        const key = canonicalContinuationJson([
          event.context.decision_id,
          event.event_kind,
        ]);
        if (decisionKinds.has(key)) fail("decision contains a duplicate influence event kind");
        decisionKinds.add(key);
      }
      const ref = canonicalContinuationJson(episodeEventRefV1(event));
      if (byRef.has(ref)) fail("episode event bundle contains a duplicate exact event ref");
      byRef.set(ref, event);
    }
    for (const event of events) {
      if (event.event_kind !== "capsule_use_observed") continue;
      const hasOutcome = events.some((candidate) => candidate.event_kind === "outcome_observed"
        && candidate.context.context_kind === "decision"
        && event.context.context_kind === "decision"
        && candidate.context.decision_id === event.context.decision_id
        && canonicalContinuationJson(candidate.cause_event_ref)
          === canonicalContinuationJson(episodeEventRefV1(event))
        && canonicalContinuationJson(candidate.source_operation)
          === canonicalContinuationJson(event.source_operation));
      if (!hasOutcome) fail("a completed record_outcome bundle requires both use and outcome events");
    }
    return canonicalContinuationClone(events);
  });
}

function parseEffectMemberInput(value: unknown): EffectEvidenceMemberInputV1 {
  const record = exactRecord(value, EFFECT_MEMBER_INPUT_KEYS, "effect evidence member input");
  const terminal = eventRef(record.terminal_event, "terminal_event");
  if (terminal.event_kind !== "contract_exposed" && terminal.event_kind !== "outcome_observed") {
    fail("effect evidence terminal_event must be an exposure or outcome");
  }
  return {
    scope: boundedText(record.scope, "effect member scope"),
    episode_id: boundedText(record.episode_id, "effect member episode_id"),
    decision_id: boundedText(record.decision_id, "effect member decision_id"),
    terminal_event: terminal as EffectEvidenceMemberInputV1["terminal_event"],
  };
}

function compareEffectMembers(
  left: EffectEvidenceMemberInputV1,
  right: EffectEvidenceMemberInputV1,
): number {
  return compareCanonicalUtf8(left.scope, right.scope)
    || compareCanonicalUtf8(left.episode_id, right.episode_id)
    || compareCanonicalUtf8(left.decision_id, right.decision_id);
}

function effectMemberIdentity(value: EffectEvidenceMemberInputV1): string {
  return canonicalContinuationJson([value.scope, value.episode_id, value.decision_id]);
}

function assembleEffectMemberSet(inputs: readonly EffectEvidenceMemberInputV1[]): EffectEvidenceMemberSetV1 {
  const sorted = [...inputs].sort(compareEffectMembers);
  for (let index = 1; index < sorted.length; index += 1) {
    if (effectMemberIdentity(sorted[index - 1]!) === effectMemberIdentity(sorted[index]!)) {
      fail("effect evidence members contain a duplicate decision identity");
    }
  }
  const members: EffectEvidenceMemberRefV1[] = sorted.map((member, index) => ({
    ...member,
    member_sequence: index + 1,
  }));
  return canonicalContinuationClone({
    schema_version: "effect_evidence_member_set_v1" as const,
    members,
    eligible_decision_count: members.length,
    eligible_decision_set_sha256: canonicalContinuationSha256(members),
  });
}

export function buildEffectEvidenceMemberSetV1(
  values: readonly EffectEvidenceMemberInputV1[],
): EffectEvidenceMemberSetV1 {
  return wrapInvalid(() => assembleEffectMemberSet(
    exactArray(values, MAX_EFFECT_MEMBERS, "effect evidence members")
      .map((value) => parseEffectMemberInput(value)),
  ));
}

export function verifyEffectEvidenceMemberSetV1(value: unknown): EffectEvidenceMemberSetV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, EFFECT_MEMBER_SET_KEYS, "effect evidence member set");
    if (record.schema_version !== "effect_evidence_member_set_v1") {
      fail("effect evidence member set schema_version is invalid");
    }
    const rawMembers = exactArray(record.members, MAX_EFFECT_MEMBERS, "effect evidence members");
    const parsed = rawMembers.map((member, index) => {
      const memberRecord = exactRecord(member, EFFECT_MEMBER_KEYS, `effect evidence member ${index}`);
      const sequence = positiveInteger(memberRecord.member_sequence, `member ${index} sequence`);
      const input = parseEffectMemberInput(Object.fromEntries(
        EFFECT_MEMBER_INPUT_KEYS.map((key) => [key, memberRecord[key]]),
      ));
      return { input, sequence };
    });
    const rebuilt = assembleEffectMemberSet(parsed.map(({ input }) => input));
    const count = boundedCount(
      record.eligible_decision_count,
      "eligible_decision_count",
      MAX_EFFECT_MEMBERS,
    );
    const digest = sha256(record.eligible_decision_set_sha256, "eligible_decision_set_sha256");
    if (parsed.some(({ sequence }, index) => sequence !== index + 1)
      || count !== rebuilt.eligible_decision_count
      || digest !== rebuilt.eligible_decision_set_sha256
      || canonicalContinuationJson(record.members) !== canonicalContinuationJson(rebuilt.members)) {
      throw new EpisodeContractError(
        "episode_digest_mismatch",
        "effect evidence member set is not canonical or its digest is inconsistent",
      );
    }
    return rebuilt;
  });
}

function capsuleSurface(value: unknown): EpisodeCapsuleSurfaceV1 {
  if (value !== "use_now" && value !== "inspect_before_use"
    && value !== "do_not_use" && value !== "rehydrate") {
    fail("capsule fact surface is not closed");
  }
  return value;
}

function parseCapsuleFactInput(value: unknown): EpisodeCapsuleFactInputV1 {
  const record = exactRecord(value, CAPSULE_FACT_INPUT_KEYS, "capsule fact input");
  if (record.use_state !== null && record.use_state !== "used"
    && record.use_state !== "not_used" && record.use_state !== "unknown") {
    fail("capsule fact use_state is not closed");
  }
  return {
    capsule_scope: boundedText(record.capsule_scope, "capsule_scope"),
    capsule_id: boundedText(record.capsule_id, "capsule_id"),
    capsule_revision: positiveInteger(record.capsule_revision, "capsule_revision"),
    capsule_sha256: sha256(record.capsule_sha256, "capsule_sha256"),
    surface: capsuleSurface(record.surface),
    use_state: record.use_state,
  };
}

function compareCapsuleFacts(left: EpisodeCapsuleFactInputV1, right: EpisodeCapsuleFactInputV1): number {
  return compareCanonicalUtf8(left.capsule_scope, right.capsule_scope)
    || compareCanonicalUtf8(left.capsule_id, right.capsule_id)
    || left.capsule_revision - right.capsule_revision
    || compareCanonicalUtf8(left.capsule_sha256, right.capsule_sha256);
}

function capsuleFactIdentity(value: EpisodeCapsuleFactInputV1): string {
  return canonicalContinuationJson([
    value.capsule_scope,
    value.capsule_id,
    value.capsule_revision,
  ]);
}

function assembleCapsuleFactSet(
  kind: "contract_exposed" | "capsule_use_observed",
  inputs: readonly EpisodeCapsuleFactInputV1[],
): EpisodeCapsuleFactSetV1 {
  const sorted = [...inputs].sort(compareCapsuleFacts);
  for (let index = 1; index < sorted.length; index += 1) {
    if (capsuleFactIdentity(sorted[index - 1]!) === capsuleFactIdentity(sorted[index]!)) {
      fail("capsule fact set contains a duplicate capsule revision identity");
    }
  }
  if (sorted.some((fact) => kind === "contract_exposed"
    ? fact.use_state !== null
    : fact.use_state === null)) {
    fail("capsule fact use_state is inconsistent with its event kind");
  }
  const facts: EpisodeCapsuleFactMemberV1[] = sorted.map((fact, index) => ({
    ...fact,
    fact_sequence: index + 1,
  }));
  return canonicalContinuationClone({
    schema_version: "episode_capsule_fact_set_v1" as const,
    event_kind: kind,
    facts,
    capsule_fact_count: facts.length,
    capsule_fact_set_sha256: canonicalContinuationSha256(facts),
  });
}

export function buildEpisodeCapsuleFactSetV1(
  eventKindValue: "contract_exposed" | "capsule_use_observed",
  values: readonly EpisodeCapsuleFactInputV1[],
): EpisodeCapsuleFactSetV1 {
  return wrapInvalid(() => {
    if (eventKindValue !== "contract_exposed" && eventKindValue !== "capsule_use_observed") {
      fail("capsule fact set event kind is invalid");
    }
    return assembleCapsuleFactSet(
      eventKindValue,
      exactArray(values, MAX_CAPSULE_FACTS, "capsule facts").map(parseCapsuleFactInput),
    );
  });
}

export function verifyEpisodeCapsuleFactSetV1(value: unknown): EpisodeCapsuleFactSetV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, CAPSULE_FACT_SET_KEYS, "capsule fact set");
    if (record.schema_version !== "episode_capsule_fact_set_v1"
      || (record.event_kind !== "contract_exposed"
        && record.event_kind !== "capsule_use_observed")) {
      fail("capsule fact set schema or event kind is invalid");
    }
    const rawFacts = exactArray(record.facts, MAX_CAPSULE_FACTS, "capsule facts");
    const parsed = rawFacts.map((fact, index) => {
      const factRecord = exactRecord(fact, CAPSULE_FACT_MEMBER_KEYS, `capsule fact ${index}`);
      return {
        input: parseCapsuleFactInput(Object.fromEntries(
          CAPSULE_FACT_INPUT_KEYS.map((key) => [key, factRecord[key]]),
        )),
        sequence: positiveInteger(factRecord.fact_sequence, `capsule fact ${index} sequence`),
      };
    });
    const rebuilt = assembleCapsuleFactSet(record.event_kind, parsed.map(({ input }) => input));
    const count = boundedCount(record.capsule_fact_count, "capsule_fact_count", MAX_CAPSULE_FACTS);
    const digest = sha256(record.capsule_fact_set_sha256, "capsule_fact_set_sha256");
    if (parsed.some(({ sequence }, index) => sequence !== index + 1)
      || count !== rebuilt.capsule_fact_count
      || digest !== rebuilt.capsule_fact_set_sha256
      || canonicalContinuationJson(record.facts) !== canonicalContinuationJson(rebuilt.facts)) {
      throw new EpisodeContractError(
        "episode_digest_mismatch",
        "capsule fact set is not canonical or its digest is inconsistent",
      );
    }
    return rebuilt;
  });
}

function parseCapsuleFactMember(value: unknown): EpisodeCapsuleFactMemberV1 {
  const record = exactRecord(value, CAPSULE_FACT_MEMBER_KEYS, "capsule fact member");
  return {
    ...parseCapsuleFactInput(Object.fromEntries(
      CAPSULE_FACT_INPUT_KEYS.map((key) => [key, record[key]]),
    )),
    fact_sequence: positiveInteger(record.fact_sequence, "fact_sequence"),
  };
}

function parseCapsuleFactRecordInput(value: unknown): EpisodeCapsuleFactRecordInputV1 {
  const record = exactRecord(value, CAPSULE_FACT_RECORD_INPUT_KEYS, "capsule fact record input");
  const ref = eventRef(record.event_ref, "event_ref");
  if (ref.event_kind !== "contract_exposed" && ref.event_kind !== "capsule_use_observed") {
    fail("capsule facts may bind only exposure or use events");
  }
  const fact = parseCapsuleFactMember(record.fact);
  if ((ref.event_kind === "contract_exposed") !== (fact.use_state === null)) {
    fail("capsule fact use_state does not match its event kind");
  }
  return {
    tenant_id: boundedText(record.tenant_id, "tenant_id"),
    scope: boundedText(record.scope, "scope"),
    episode_id: boundedText(record.episode_id, "episode_id"),
    event_ref: ref as EpisodeCapsuleFactRecordInputV1["event_ref"],
    fact,
  };
}

function assembleCapsuleFactRecord(input: EpisodeCapsuleFactRecordInputV1): EpisodeCapsuleFactV1 {
  const body = {
    schema_version: "episode_capsule_fact_v1" as const,
    ...input,
  };
  return canonicalContinuationClone({
    ...body,
    fact_sha256: canonicalContinuationSha256(body),
  });
}

export function buildEpisodeCapsuleFactV1(
  value: EpisodeCapsuleFactRecordInputV1,
): EpisodeCapsuleFactV1 {
  return wrapInvalid(() => assembleCapsuleFactRecord(parseCapsuleFactRecordInput(value)));
}

export function verifyEpisodeCapsuleFactV1(value: unknown): EpisodeCapsuleFactV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, CAPSULE_FACT_RECORD_KEYS, "capsule fact record");
    if (record.schema_version !== "episode_capsule_fact_v1") {
      fail("capsule fact record schema_version is invalid");
    }
    const supplied = sha256(record.fact_sha256, "fact_sha256");
    const input = Object.fromEntries(
      CAPSULE_FACT_RECORD_INPUT_KEYS.map((key) => [key, record[key]]),
    );
    const rebuilt = assembleCapsuleFactRecord(parseCapsuleFactRecordInput(input));
    if (rebuilt.fact_sha256 !== supplied
      || canonicalSha256Without(
        value as Readonly<Record<string, unknown>>,
        "fact_sha256",
      ) !== supplied) {
      throw new EpisodeContractError(
        "episode_digest_mismatch",
        "capsule fact digest does not authenticate the exact canonical fact",
      );
    }
    return rebuilt;
  });
}
