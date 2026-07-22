import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type HostObservationV1,
} from "../../src/continuation/contract.ts";
import { buildSignedObserverObservationV1 } from
  "../../src/continuation/observation-attestation.ts";
import {
  buildHostTaskEnvelopeV1,
  continuationAuthoritySubjectSha256V1,
  type HostTaskEnvelopeInputV1,
  type HostTaskEnvelopeV1,
} from "../../src/continuation/task-envelope.ts";
import { openContinuationRuntimeV1Database } from
  "../../src/store/continuation-runtime-v1-database.ts";
import {
  createContinuationRuntimeV1ObservationStore,
  type CollectorObservationInputV1,
  type PutObservationSnapshotV1,
} from "../../src/store/continuation-runtime-v1-observation-store.ts";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationKind,
} from "../../src/store/continuation-runtime-v1-operation-store.ts";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../../src/store/continuation-runtime-v1-operation-result-derivation.ts";

const TENANT = "tenant-a";
const SCOPE = "scope-a";
const COLLECTOR = "b".repeat(64);
const BOOTSTRAP_TIME = "2026-07-21T09:00:00.000Z";
const SNAPSHOT_TIME = "2026-07-21T10:03:00.000Z";
const EXTERNAL_VERIFIER = generateKeyPairSync("ed25519");

function taskEnvelopeInput(
  changes: Partial<HostTaskEnvelopeInputV1> = {},
): HostTaskEnvelopeInputV1 {
  return {
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
    issued_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-21T12:00:00.000Z",
    ...changes,
  };
}

function taskEnvelope(
  changes: Partial<HostTaskEnvelopeInputV1> = {},
  domain: Readonly<{ tenant_id: string; scope: string }> = {
    tenant_id: TENANT,
    scope: SCOPE,
  },
): HostTaskEnvelopeV1 {
  const raw = taskEnvelopeInput(changes);
  return buildHostTaskEnvelopeV1(raw, {
    ...domain,
    authority_subject_sha256: continuationAuthoritySubjectSha256V1({
      ...domain,
      task_family: raw.task_family,
    }),
  });
}

function rawTaskEnvelope(value: HostTaskEnvelopeV1): HostTaskEnvelopeInputV1 {
  const {
    authority_subject_sha256: _authoritySubjectSha256,
    host_task_envelope_sha256: _hostTaskEnvelopeSha256,
    schema_version: _schemaVersion,
    scope: _scope,
    tenant_id: _tenantId,
    ...input
  } = value;
  return input;
}

function observation(args: Readonly<{
  id: string;
  probeId?: string;
  observedAt?: string;
  expiresAt?: string;
}>): CollectorObservationInputV1 {
  return {
    schema_version: "collector_observation_v1",
    observation_id: args.id,
    probe_id: args.probeId ?? `probe-${args.id}`,
    probe_spec_sha256: "3".repeat(64),
    observed_at: args.observedAt ?? "2026-07-21T10:01:00.000Z",
    expires_at: args.expiresAt ?? "2026-07-21T11:00:00.000Z",
    value: {
      kind: "capability" as const,
      capability_id: `capability-${args.id}`,
      version: "1.0.0",
      presence: "present" as const,
    },
    evidence_sha256: "4".repeat(64),
  };
}

function signedObservation(args: Readonly<{
  id: string;
  operationId: string;
  envelope: HostTaskEnvelopeV1;
  worldSnapshotId?: string;
  envelopeSha256?: string;
  observedAt?: string;
  expiresAt?: string;
}>): HostObservationV1 {
  return buildSignedObserverObservationV1({
    schema_version: "host_observation_v1",
    observation_id: args.id,
    probe_id: `probe-${args.id}`,
    probe_spec_sha256: "3".repeat(64),
    observer: "external_verifier",
    host_task_envelope_sha256: args.envelopeSha256
      ?? args.envelope.host_task_envelope_sha256,
    world_snapshot_id: args.worldSnapshotId ?? args.operationId,
    observed_at: args.observedAt ?? "2026-07-21T10:01:00.000Z",
    expires_at: args.expiresAt ?? "2026-07-21T11:00:00.000Z",
    value: {
      kind: "capability",
      capability_id: `capability-${args.id}`,
      version: "1.0.0",
      presence: "present",
    },
    evidence_sha256: "4".repeat(64),
  }, EXTERNAL_VERIFIER.privateKey);
}

function input(
  _operationId: string,
  collectorObservations: readonly CollectorObservationInputV1[] = [],
  envelope = taskEnvelope(),
  signedObservations: readonly HostObservationV1[] = [],
): PutObservationSnapshotV1 {
  return {
    host_task_envelope: rawTaskEnvelope(envelope),
    collector_observations: collectorObservations,
    signed_observations: signedObservations,
  };
}

function fixture(
  tenantId = TENANT,
  scope = SCOPE,
) {
  const directory = mkdtempSync(join(tmpdir(), "aionis-v1-observations-"));
  const path = join(directory, "runtime.sqlite");
  let authorityClock = BOOTSTRAP_TIME;
  const database = openContinuationRuntimeV1Database(path, {
    databaseInstanceId: "a".repeat(64),
    authorityNow: () => authorityClock,
  });
  authorityClock = SNAPSHOT_TIME;
  const store = createContinuationRuntimeV1ObservationStore(database);
  const operations = createContinuationRuntimeV1OperationStore(database);
  return { directory, path, database, store, operations, tenantId, scope };
}

async function closeFixture(value: ReturnType<typeof fixture>): Promise<void> {
  await value.database.close();
  rmSync(value.directory, { recursive: true, force: true });
}

async function executePut(
  value: ReturnType<typeof fixture>,
  operationId: string,
  putInput: PutObservationSnapshotV1,
  operationKind: ContinuationRuntimeV1OperationKind = "record_observations",
) {
  let persisted: Awaited<ReturnType<typeof value.store.put>> | null = null;
  await value.operations.execute({
    tenantId: value.tenantId,
    scope: value.scope,
    operationKind,
    operationId,
    actorKind: "trusted_host",
    actorPrincipalSha256: COLLECTOR,
    request: { test_operation_id: operationId },
    produce: async (context) => {
      persisted = await value.store.put(context, putInput);
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        value.database,
      );
      return deriveContinuationRuntimeV1OperationResultV1(
        value.database,
        binding,
        "before_receipt_insert",
      );
    },
  });
  return persisted!;
}

async function persistedFixture(operationId: string) {
  const value = fixture();
  const envelope = taskEnvelope();
  const putInput = input(operationId, [
    observation({ id: "observation-a" }),
  ], envelope);
  const persisted = await executePut(value, operationId, putInput);
  return { ...value, persisted };
}

test("observation store derives an ordered or empty snapshot and survives reopen", async () => {
  const value = fixture();
  try {
    const envelope = taskEnvelope();
    const operationId = "observation-operation-ordered";
    const persisted = await executePut(value, operationId, input(operationId, [
      observation({
        id: "observation-z",
        observedAt: "2026-07-21T10:02:00.000Z",
      }),
      observation({
        id: "observation-a",
        observedAt: "2026-07-21T10:01:00.000Z",
      }),
    ], envelope));
    assert.equal(persisted.snapshot.tenant_id, TENANT);
    assert.equal(persisted.snapshot.scope, SCOPE);
    assert.equal(persisted.snapshot.world_snapshot_id, operationId);
    assert.equal(persisted.snapshot.collection_principal_sha256, COLLECTOR);
    assert.equal(persisted.snapshot.created_at, SNAPSHOT_TIME);
    assert.equal(persisted.snapshot.observed_from, "2026-07-21T10:01:00.000Z");
    assert.equal(persisted.snapshot.observed_through, "2026-07-21T10:02:00.000Z");
    assert.deepEqual(
      persisted.snapshot.observations.map((item) => item.observation_id),
      ["observation-a", "observation-z"],
    );
    assert.equal(persisted.source_operation.operation_id, operationId);
    assert.equal(persisted.source_operation.actor_kind, "trusted_host");
    assert.equal(persisted.source_operation.actor_principal_sha256, COLLECTOR);
    assert.ok(Object.isFrozen(persisted));
    assert.ok(Object.isFrozen(persisted.snapshot.host_task_envelope));
    assert.ok(Object.isFrozen(persisted.snapshot.observations));

    const emptyOperationId = "observation-operation-empty";
    const empty = await executePut(
      value,
      emptyOperationId,
      input(emptyOperationId, [], envelope),
    );
    assert.equal(empty.snapshot.observed_from, SNAPSHOT_TIME);
    assert.equal(empty.snapshot.observed_through, SNAPSHOT_TIME);
    assert.equal(empty.snapshot.expires_at, envelope.expires_at);

    await value.database.close();
    const reopened = openContinuationRuntimeV1Database(value.path);
    const reopenedStore = createContinuationRuntimeV1ObservationStore(reopened);
    assert.deepEqual(await reopenedStore.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: operationId,
    }), persisted);
    assert.deepEqual(await reopenedStore.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: emptyOperationId,
    }), empty);
    assert.equal(await reopenedStore.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "missing",
    }), null);
    await reopened.close();
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("write authority is opaque, database-bound, kind-bound, expiring, and one-shot", async () => {
  const first = fixture();
  const second = fixture();
  try {
    const forgedInput = input("forged-operation");
    await assert.rejects(
      first.store.put(
        {} as ContinuationRuntimeV1AuthorityWriteContext,
        forgedInput,
      ),
      /write_context_unrecognized/u,
    );

    await assert.rejects(first.operations.execute({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "record_observations",
      operationId: "wrong-database",
      actorKind: "trusted_host",
      actorPrincipalSha256: COLLECTOR,
      request: { test_operation_id: "wrong-database" },
      produce: (context) => second.store.put(context, input("wrong-database")),
    }), /write_context_database_mismatch/u);

    let expired: ContinuationRuntimeV1AuthorityWriteContext | null = null;
    await first.operations.execute({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "record_observations",
      operationId: "expired-context",
      actorKind: "trusted_host",
      actorPrincipalSha256: COLLECTOR,
      request: { test_operation_id: "expired-context" },
      produce: async (context) => {
        expired = context;
        await first.store.put(context, input("expired-context"));
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          first.database,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          first.database,
          binding,
          "before_receipt_insert",
        );
      },
    });
    await assert.rejects(
      first.store.put(expired!, input("expired-context")),
      /write_context_expired/u,
    );

    await assert.rejects(
      executePut(
        first,
        "wrong-kind",
        input("wrong-kind"),
        "record_outcome",
      ),
      /operation_authority_invalid/u,
    );

    const operationId = "one-shot";
    await first.operations.execute({
      tenantId: TENANT,
      scope: SCOPE,
      operationKind: "record_observations",
      operationId,
      actorKind: "trusted_host",
      actorPrincipalSha256: COLLECTOR,
      request: { test_operation_id: operationId },
      produce: async (context) => {
        const persisted = await first.store.put(context, input(operationId));
        await assert.rejects(
          first.store.put(context, input(operationId)),
          /context_already_used/u,
        );
        assert.equal(persisted.snapshot.world_snapshot_id, operationId);
        const binding = assertContinuationRuntimeV1AuthorityWriteContext(
          context,
          first.database,
        );
        return deriveContinuationRuntimeV1OperationResultV1(
          first.database,
          binding,
          "before_receipt_insert",
        );
      },
    });
    assert.ok(await first.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: operationId,
    }));
  } finally {
    await closeFixture(first);
    await closeFixture(second);
  }
});

test("put rejects unknown fields, symbols, and accessors before reading them", async () => {
  const value = fixture();
  try {
    const attempt = async (operationId: string, putInput: unknown) => {
      await value.operations.execute({
        tenantId: TENANT,
        scope: SCOPE,
        operationKind: "record_observations",
        operationId,
        actorKind: "trusted_host",
        actorPrincipalSha256: COLLECTOR,
        request: { test_operation_id: operationId },
        produce: (context) => value.store.put(context, putInput as PutObservationSnapshotV1),
      });
    };
    await assert.rejects(
      attempt("unknown-input", { ...input("unknown-input"), caller_created_at: SNAPSHOT_TIME }),
      /put_input_shape_invalid/u,
    );
    const symbolInput = { ...input("symbol-input") } as Record<PropertyKey, unknown>;
    symbolInput[Symbol("unknown")] = true;
    await assert.rejects(
      attempt("symbol-input", symbolInput),
      /put_input_shape_invalid/u,
    );
    const markerInjection = input("marker-injection");
    await assert.rejects(
      attempt("marker-injection", {
        ...markerInjection,
        collector_observations: [{
          ...observation({ id: "marker-injection" }),
          observer: "external_verifier",
          observer_principal_sha256: "f".repeat(64),
        }],
      }),
      /collector_observation_shape_invalid/u,
    );
    await assert.rejects(
      attempt("unsigned-role-in-signed-channel", {
        ...input("unsigned-role-in-signed-channel"),
        signed_observations: [{ observer: "trusted_host_collector" } as HostObservationV1],
      }),
      /signed_observer_role_invalid/u,
    );
    for (const [field, injectedValue] of [
      ["tenant_id", TENANT],
      ["scope", SCOPE],
      ["authority_subject_sha256", "f".repeat(64)],
    ] as const) {
      await assert.rejects(
        attempt(`host-domain-injection-${field}`, {
          ...input(`host-domain-injection-${field}`),
          host_task_envelope: {
            ...taskEnvelopeInput(),
            [field]: injectedValue,
          },
        }),
        /host task envelope input contains unknown or missing fields/u,
      );
    }
    let getterCalls = 0;
    const accessor = { observations: [] } as Record<string, unknown>;
    Object.defineProperty(accessor, "host_task_envelope", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return taskEnvelope();
      },
    });
    await assert.rejects(
      attempt("accessor-input", accessor),
      /put_input_shape_invalid/u,
    );
    assert.equal(getterCalls, 0);
  } finally {
    await closeFixture(value);
  }
});

test("tenant A verifier signature cannot replay across tenant, scope, or authority subject", async () => {
  const tenantB = fixture("tenant-b", SCOPE);
  const scopeB = fixture(TENANT, "scope-b");
  const subjectB = fixture();
  const operationId = "cross-domain-replay";
  const tenantAEnvelope = taskEnvelope();
  const tenantASignature = signedObservation({
    id: "tenant-a-signed-observation",
    operationId,
    envelope: tenantAEnvelope,
  });
  try {
    await assert.rejects(
      executePut(
        tenantB,
        operationId,
        input(operationId, [], tenantAEnvelope, [tenantASignature]),
      ),
      /observation_binding_invalid/u,
    );
    await assert.rejects(
      executePut(
        scopeB,
        operationId,
        input(operationId, [], tenantAEnvelope, [tenantASignature]),
      ),
      /observation_binding_invalid/u,
    );
    const differentSubjectEnvelope = taskEnvelope({ task_family: "deploy" });
    assert.notEqual(
      tenantAEnvelope.authority_subject_sha256,
      differentSubjectEnvelope.authority_subject_sha256,
    );
    await assert.rejects(
      executePut(
        subjectB,
        operationId,
        input(operationId, [], differentSubjectEnvelope, [tenantASignature]),
      ),
      /observation_binding_invalid/u,
    );
  } finally {
    await closeFixture(tenantB);
    await closeFixture(scopeB);
    await closeFixture(subjectB);
  }
});

test("world snapshot validation rejects digest, binding, task-time, future, and stale facts", async () => {
  const value = fixture();
  try {
    const attempt = async (
      operationId: string,
      envelope: HostTaskEnvelopeV1,
      signed: HostObservationV1,
    ) => {
      await executePut(value, operationId, input(operationId, [], envelope, [signed]));
    };
    const badDigestEnvelope = taskEnvelope();
    const badDigestBase = signedObservation({
      id: "bad-digest",
      operationId: "bad-digest",
      envelope: badDigestEnvelope,
    });
    await assert.rejects(
      attempt("bad-digest", badDigestEnvelope, {
        ...badDigestBase,
        observation_sha256: "0".repeat(64),
      }),
      /host_observation_digest_mismatch/u,
    );
    const wrongWorldEnvelope = taskEnvelope();
    await assert.rejects(
      attempt("bad-world-binding", wrongWorldEnvelope, signedObservation({
        id: "bad-world-binding",
        operationId: "bad-world-binding",
        worldSnapshotId: "another-operation",
        envelope: wrongWorldEnvelope,
      })),
      /observation_binding_invalid/u,
    );
    const wrongEnvelope = taskEnvelope();
    await assert.rejects(
      attempt("bad-envelope-binding", wrongEnvelope, signedObservation({
        id: "bad-envelope-binding",
        operationId: "bad-envelope-binding",
        envelopeSha256: "f".repeat(64),
        envelope: wrongEnvelope,
      })),
      /observation_binding_invalid/u,
    );
    const expired = taskEnvelope({ expires_at: SNAPSHOT_TIME });
    await assert.rejects(
      executePut(value, "expired-task", input("expired-task", [], expired)),
      /task_envelope_not_current/u,
    );
    const future = taskEnvelope({
      issued_at: "2026-07-21T10:04:00.000Z",
      expires_at: "2026-07-21T12:00:00.000Z",
    });
    await assert.rejects(
      executePut(value, "future-task", input("future-task", [], future)),
      /task_envelope_not_current/u,
    );
    const futureObservationEnvelope = taskEnvelope();
    await assert.rejects(
      attempt("future-observation", futureObservationEnvelope, signedObservation({
        id: "future-observation",
        operationId: "future-observation",
        envelope: futureObservationEnvelope,
        observedAt: "2026-07-21T10:04:00.000Z",
        expiresAt: "2026-07-21T11:00:00.000Z",
      })),
      /observation_stale_or_future/u,
    );
    const staleObservationEnvelope = taskEnvelope();
    await assert.rejects(
      attempt("stale-observation", staleObservationEnvelope, signedObservation({
        id: "stale-observation",
        operationId: "stale-observation",
        envelope: staleObservationEnvelope,
        expiresAt: SNAPSHOT_TIME,
      })),
      /observation_stale_or_future/u,
    );
  } finally {
    await closeFixture(value);
  }
});

test("read fails closed on snapshot digest or full task-envelope tampering", async () => {
  const digestValue = await persistedFixture("tamper-digest");
  try {
    digestValue.database.db.exec("DROP TRIGGER observation_snapshots_no_update");
    digestValue.database.db.prepare(
      "UPDATE observation_snapshots SET world_snapshot_sha256 = ?",
    ).run("f".repeat(64));
    await assert.rejects(digestValue.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "tamper-digest",
    }), /snapshot_digest_or_window/u);
  } finally {
    await closeFixture(digestValue);
  }

  const envelopeValue = await persistedFixture("tamper-envelope");
  try {
    envelopeValue.database.db.exec("DROP TRIGGER observation_snapshots_no_update");
    const foreignEnvelope = taskEnvelope({ host_task_id: "foreign-task" });
    envelopeValue.database.db.prepare(
      "UPDATE observation_snapshots SET host_task_envelope_json = ?",
    ).run(canonicalContinuationJson(foreignEnvelope));
    await assert.rejects(envelopeValue.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "tamper-envelope",
    }), /host_task_envelope_binding/u);
  } finally {
    await closeFixture(envelopeValue);
  }
});

test("read fails closed when the exact operation parent is missing or lineage drifts", async () => {
  const missing = await persistedFixture("missing-parent");
  try {
    missing.database.db.exec("DROP TRIGGER operations_no_delete");
    missing.database.db.exec("PRAGMA foreign_keys = OFF");
    missing.database.db.prepare(
      "DELETE FROM operations WHERE operation_id = ?",
    ).run("missing-parent");
    await assert.rejects(missing.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "missing-parent",
    }), /source_operation_missing/u);
  } finally {
    await closeFixture(missing);
  }

  const drift = await persistedFixture("lineage-drift");
  try {
    drift.database.db.exec("DROP TRIGGER observation_snapshots_no_update");
    drift.database.db.exec("PRAGMA foreign_keys = OFF");
    drift.database.db.prepare(
      "UPDATE observation_snapshots SET source_operation_id = ?",
    ).run("foreign-operation");
    await assert.rejects(drift.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "lineage-drift",
    }), /source_operation_identity/u);
  } finally {
    await closeFixture(drift);
  }
});

test("read revalidates operation actor identity and canonical receipt", async () => {
  const actor = await persistedFixture("actor-tamper");
  try {
    actor.database.db.exec("DROP TRIGGER operations_no_update");
    actor.database.db.prepare(
      "UPDATE operations SET actor_principal_sha256 = ? WHERE operation_id = ?",
    ).run("e".repeat(64), "actor-tamper");
    await assert.rejects(actor.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "actor-tamper",
    }), /source_operation_binding/u);
  } finally {
    await closeFixture(actor);
  }

  const receipt = await persistedFixture("receipt-tamper");
  try {
    receipt.database.db.exec("DROP TRIGGER operations_no_update");
    receipt.database.db.prepare(
      "UPDATE operations SET receipt_sha256 = ? WHERE operation_id = ?",
    ).run("e".repeat(64), "receipt-tamper");
    await assert.rejects(receipt.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "receipt-tamper",
    }), /source_operation_receipt/u);
  } finally {
    await closeFixture(receipt);
  }

  const result = await persistedFixture("result-tamper");
  try {
    result.database.db.exec("DROP TRIGGER operations_no_update");
    const row = result.database.db.prepare(
      "SELECT receipt_json FROM operations WHERE operation_id = ?",
    ).get("result-tamper") as { receipt_json: string };
    const parsed = JSON.parse(row.receipt_json) as Record<string, unknown>;
    parsed.result = {
      world_snapshot_id: "another-snapshot",
      world_snapshot_sha256: "d".repeat(64),
    };
    const receiptJson = canonicalContinuationJson(parsed);
    result.database.db.prepare(
      `UPDATE operations
          SET receipt_json = ?, receipt_sha256 = ?
        WHERE operation_id = ?`,
    ).run(
      receiptJson,
      canonicalContinuationSha256(parsed),
      "result-tamper",
    );
    await assert.rejects(result.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "result-tamper",
    }), /source_operation_result/u);
  } finally {
    await closeFixture(result);
  }
});

test("read identity is exact and accessor-free", async () => {
  const value = fixture();
  try {
    await assert.rejects(value.store.read({
      tenant_id: TENANT,
      scope: SCOPE,
      world_snapshot_id: "missing",
      unknown: true,
    } as never), /read_input_shape_invalid/u);
    let getterCalls = 0;
    const accessor = {
      tenant_id: TENANT,
      scope: SCOPE,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "world_snapshot_id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "missing";
      },
    });
    await assert.rejects(
      value.store.read(accessor as never),
      /read_input_shape_invalid/u,
    );
    assert.equal(getterCalls, 0);
  } finally {
    await closeFixture(value);
  }
});
