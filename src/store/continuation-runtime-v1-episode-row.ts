import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationJson,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import {
  verifyEpisodeEventV1,
  type EpisodeEventRefV1,
  type EpisodeEventV1,
} from "../continuation/episode.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";

export type ContinuationRuntimeV1SqlRow = Readonly<Record<string, unknown>>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_effect_certificate_${code}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `episode row ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `episode row ${field}`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field}_invalid`);
  }
  return value as number;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertCanonicalUtcMillis(value, `episode row ${field}`);
  return value;
}

function objectJson(
  value: unknown,
  field: string,
): Readonly<Record<string, CanonicalJson>> {
  if (typeof value !== "string") fail(`corrupt:${field}_type`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail(`corrupt:${field}_json`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || canonicalContinuationJson(parsed) !== value) {
    fail(`corrupt:${field}_canonical`);
  }
  return parsed as Readonly<Record<string, CanonicalJson>>;
}

function eventRowBySequence(
  database: ContinuationRuntimeV1Database,
  row: ContinuationRuntimeV1SqlRow,
  sequence: unknown,
): ContinuationRuntimeV1SqlRow | null {
  if (sequence === null) return null;
  return database.db.prepare(`SELECT * FROM episode_events
    WHERE tenant_id = ? AND scope = ? AND episode_id = ? AND event_sequence = ?`).get(
    row.tenant_id,
    row.scope,
    row.episode_id,
    sequence,
  ) as ContinuationRuntimeV1SqlRow | undefined ?? null;
}

function eventRefFromRow(
  row: ContinuationRuntimeV1SqlRow,
  field: string,
): EpisodeEventRefV1 {
  return {
    event_sequence: positiveInteger(row.event_sequence, `${field}_sequence`),
    event_id: text(row.event_id, `${field}_id`),
    event_kind: row.event_kind as EpisodeEventRefV1["event_kind"],
    event_sha256: sha(row.event_sha256, `${field}_sha256`),
  };
}

export function decodeContinuationRuntimeV1EpisodeEventRow(
  database: ContinuationRuntimeV1Database,
  row: ContinuationRuntimeV1SqlRow,
): EpisodeEventV1 {
  const previousRow = eventRowBySequence(database, row, row.previous_event_sequence);
  const causeRow = eventRowBySequence(database, row, row.cause_event_sequence);
  if ((row.previous_event_sequence === null) !== (previousRow === null)
    || (row.cause_event_sequence === null) !== (causeRow === null)) {
    fail("corrupt:event_reference_missing");
  }
  const previous = previousRow === null
    ? null
    : eventRefFromRow(previousRow, "previous_event");
  const cause = causeRow === null ? null : eventRefFromRow(causeRow, "cause_event");
  if ((previous !== null && (
    previous.event_sequence !== row.previous_event_sequence
    || previous.event_sha256 !== row.previous_event_sha256
  )) || (cause !== null && (
    cause.event_sequence !== row.cause_event_sequence
    || cause.event_id !== row.cause_event_id
    || cause.event_kind !== row.cause_event_kind
    || cause.event_sha256 !== row.cause_event_sha256
  ))) fail("corrupt:event_reference_projection");
  return verifyEpisodeEventV1({
    schema_version: "episode_event_v1",
    tenant_id: text(row.tenant_id, "corrupt:event_tenant_id"),
    scope: text(row.scope, "corrupt:event_scope"),
    episode_id: text(row.episode_id, "corrupt:event_episode_id"),
    event_sequence: positiveInteger(row.event_sequence, "corrupt:event_sequence"),
    event_id: text(row.event_id, "corrupt:event_id"),
    event_kind: row.event_kind,
    source_operation: {
      operation_kind: row.source_operation_kind,
      operation_id: text(row.source_operation_id, "corrupt:event_operation_id"),
      request_sha256: sha(row.source_request_sha256, "corrupt:event_request_sha256"),
    },
    previous_event_ref: previous,
    cause_event_ref: cause,
    context: {
      context_kind: "decision",
      decision_id: text(row.decision_id, "corrupt:event_decision_id"),
      run_id: text(row.run_id, "corrupt:event_run_id"),
      host_task_envelope_sha256: sha(
        row.host_task_envelope_sha256,
        "corrupt:event_host_task_envelope_sha256",
      ),
      contract_sha256: sha(row.contract_sha256, "corrupt:event_contract_sha256"),
      coverage_certificate_sha256: sha(
        row.coverage_certificate_sha256,
        "corrupt:event_coverage_certificate_sha256",
      ),
      render_result_sha256: sha(
        row.render_result_sha256,
        "corrupt:event_render_result_sha256",
      ),
      authority_subject_sha256: sha(
        row.authority_subject_sha256,
        "corrupt:event_authority_subject_sha256",
      ),
      branch_manifest_sha256: sha(
        row.branch_manifest_sha256,
        "corrupt:event_branch_manifest_sha256",
      ),
    },
    render_result_sha256: sha(
      row.render_result_sha256,
      "corrupt:event_render_result_sha256",
    ),
    effect_certificate_sha256: row.effect_certificate_sha256,
    effect_member_sequence: row.effect_member_sequence,
    capsule_fact_count: row.capsule_fact_count,
    capsule_fact_set_sha256: row.capsule_fact_set_sha256,
    payload: objectJson(row.payload_json, "event_payload_json"),
    created_at: time(row.created_at, "corrupt:event_created_at"),
    payload_sha256: sha(row.payload_sha256, "corrupt:event_payload_sha256"),
    event_sha256: sha(row.event_sha256, "corrupt:event_sha256"),
  });
}
