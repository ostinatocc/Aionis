import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContinuationSha256,
  type HostObservationV1,
} from "../../src/continuation/contract.js";
import {
  buildWorldObservationSnapshotV1,
  verifyWorldObservationSnapshotV1,
} from "../../src/continuation/world-snapshot.js";
import {
  buildHostTaskEnvelopeV1,
  continuationAuthoritySubjectSha256V1,
} from "../../src/continuation/task-envelope.js";

const PRINCIPAL = "b".repeat(64);
const AUTHORITY_SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: "tenant-a",
  scope: "scope-a",
  task_family: "repair",
});
const HOST_TASK_ENVELOPE = buildHostTaskEnvelopeV1({
  host_task_id: "task-a",
  episode_id: "episode-a",
  run_id: "run-a",
  consumer_agent_id: "agent-a",
  consumer_team_id: null,
  task_family: "repair",
  task_signature: "task-signature-a",
  workflow_signature: null,
  workspace_signature: "workspace-a",
  source_task_sha256: "1".repeat(64),
  source_event_sha256: "2".repeat(64),
  issued_at: "2026-07-21T01:00:00.000Z",
  expires_at: "2026-07-21T04:00:00.000Z",
}, {
  tenant_id: "tenant-a",
  scope: "scope-a",
  authority_subject_sha256: AUTHORITY_SUBJECT,
});
const ENVELOPE = HOST_TASK_ENVELOPE.host_task_envelope_sha256;

function observation(id: string, probe: string, at: string, expires: string): HostObservationV1 {
  const body = {
    schema_version: "host_observation_v1" as const,
    observation_id: id,
    probe_id: probe,
    probe_spec_sha256: "c".repeat(64),
    observer: "trusted_host_collector" as const,
    observer_principal_sha256: PRINCIPAL,
    host_task_envelope_sha256: ENVELOPE,
    world_snapshot_id: "operation-1",
    observed_at: at,
    expires_at: expires,
    value: {
      kind: "capability" as const,
      capability_id: `capability-${probe}`,
      version: "1.0.0",
      presence: "present" as const,
    },
    evidence_sha256: "d".repeat(64),
    attestation: { kind: "authenticated_collector" as const },
  };
  return { ...body, observation_sha256: canonicalContinuationSha256(body) };
}

function rehashObservation(
  value: HostObservationV1,
  changes: Partial<Omit<HostObservationV1, "observation_sha256">>,
): HostObservationV1 {
  const { observation_sha256: _ignored, ...body } = { ...value, ...changes };
  return { ...body, observation_sha256: canonicalContinuationSha256(body) };
}

function input() {
  return {
    tenant_id: "tenant-a",
    scope: "scope-a",
    authority_subject_sha256: AUTHORITY_SUBJECT,
    world_snapshot_id: "operation-1",
    host_task_envelope: HOST_TASK_ENVELOPE,
    collection_principal_sha256: PRINCIPAL,
    observations: [
      observation("observation-b", "probe-b", "2026-07-21T01:00:02.000Z", "2026-07-21T02:00:00.000Z"),
      observation("observation-a", "probe-a", "2026-07-21T01:00:01.000Z", "2026-07-21T03:00:00.000Z"),
    ],
    created_at: "2026-07-21T01:00:03.000Z",
  };
}

test("world snapshot is one canonical, derived, immutable observation authority", () => {
  const first = buildWorldObservationSnapshotV1(input());
  const second = buildWorldObservationSnapshotV1({
    ...input(),
    observations: [...input().observations].reverse(),
  });
  assert.equal(first.world_snapshot_sha256, second.world_snapshot_sha256);
  assert.deepEqual(first.observations.map((item) => item.observation_id), [
    "observation-a",
    "observation-b",
  ]);
  assert.equal(first.observed_from, "2026-07-21T01:00:01.000Z");
  assert.equal(first.observed_through, "2026-07-21T01:00:02.000Z");
  assert.equal(first.expires_at, "2026-07-21T02:00:00.000Z");
  assert.deepEqual(verifyWorldObservationSnapshotV1(first), first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.observations));
});

test("snapshot rejects domain replay and digest binds collector, runtime time, and exact observation refs", () => {
  const baseline = buildWorldObservationSnapshotV1(input());
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(), tenant_id: "tenant-b",
  }), /authenticated_domain_mismatch/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(), scope: "scope-b",
  }), /authenticated_domain_mismatch/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(), authority_subject_sha256: "f".repeat(64),
  }), /authenticated_domain_mismatch/u);
  assert.notEqual(buildWorldObservationSnapshotV1({
    ...input(), created_at: "2026-07-21T01:00:04.000Z",
  }).world_snapshot_sha256, baseline.world_snapshot_sha256);
  const changedCollector = "e".repeat(64);
  const collectorInput = input();
  assert.notEqual(
    buildWorldObservationSnapshotV1({
      ...collectorInput,
      collection_principal_sha256: changedCollector,
      observations: collectorInput.observations.map((item) => rehashObservation(item, {
        observer_principal_sha256: changedCollector,
      })),
    }).world_snapshot_sha256,
    baseline.world_snapshot_sha256,
  );
});

test("an empty snapshot is valid without inventing a probe and is bounded by the task envelope", () => {
  const value = buildWorldObservationSnapshotV1({ ...input(), observations: [] });
  assert.equal(value.observed_from, value.created_at);
  assert.equal(value.observed_through, value.created_at);
  assert.equal(value.expires_at, HOST_TASK_ENVELOPE.expires_at);
  assert.deepEqual(verifyWorldObservationSnapshotV1(value), value);
});

test("snapshot rejects duplicate probes, duplicate ids, foreign bindings, and stale/future facts", () => {
  const first = input().observations[0]!;
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [first, { ...first }],
  }), /canonical set contains a duplicate key/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [first, observation("other", first.probe_id, first.observed_at, first.expires_at)],
  }), /duplicate_probe/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [rehashObservation(first, { world_snapshot_id: "other" })],
  }), /binding_invalid/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [rehashObservation(first, {
      observer_principal_sha256: "e".repeat(64),
    })],
  }), /collector_principal_mismatch/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    created_at: "2026-07-21T01:00:00.000Z",
  }), /stale_or_future/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [rehashObservation(first, {
      observed_at: "2026-07-20T23:59:59.999Z",
    })],
  }), /stale_or_future/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    observations: [rehashObservation(first, {
      expires_at: "2026-07-21T04:00:00.001Z",
    })],
  }), /stale_or_future/u);
  assert.throws(() => buildWorldObservationSnapshotV1({
    ...input(),
    created_at: "2026-07-21T02:00:00.000Z",
  }), /stale_or_future/u);
});

test("verification rejects unknown fields, accessors, and digest or derived-window tampering", () => {
  const value = buildWorldObservationSnapshotV1(input());
  assert.throws(() => verifyWorldObservationSnapshotV1({ ...value, extra: true }), /shape_invalid/u);
  assert.throws(() => verifyWorldObservationSnapshotV1({
    ...value,
    observed_from: "2026-07-21T01:00:00.000Z",
  }), /digest_or_window_mismatch/u);
  assert.throws(() => verifyWorldObservationSnapshotV1({
    ...value,
    world_snapshot_sha256: "f".repeat(64),
  }), /digest_or_window_mismatch/u);
  const accessor = { ...value } as Record<string, unknown>;
  Object.defineProperty(accessor, "scope", { enumerable: true, get: () => "scope-a" });
  assert.throws(() => verifyWorldObservationSnapshotV1(accessor), /shape_invalid/u);
});
