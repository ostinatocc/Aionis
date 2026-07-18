import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";

import stableStringify from "fast-json-stable-stringify";

import {
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  inspectLiteRuntimeDeploymentSlotPathCapability,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
  provisionLiteRuntimeDeploymentSlotPathAuthorityRoot,
} from "../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-path-authority.js";
import {
  acquireLiteRuntimeDeploymentSlotProvisioningJournalLock,
  appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt,
  createLiteRuntimeDeploymentSlotProvisioningJournal,
  LiteRuntimeDeploymentSlotProvisioningJournalError,
  readLiteRuntimeDeploymentSlotProvisioningJournal,
  readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts,
  releaseLiteRuntimeDeploymentSlotProvisioningJournalLock,
  type LiteRuntimeDeploymentSlotProvisioningIntent,
  type LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest,
} from "../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-provisioning-journal.js";

const INTENT_TABLE = "lite_runtime_deployment_slot_provisioning_intent";
const CREATED_AT = "2026-07-18T04:00:00.000Z";

type Fixture = Readonly<{
  directory: string;
  journalPath: string;
  phaseDirectoryPath: string;
  intent: LiteRuntimeDeploymentSlotProvisioningIntent;
}>;

type AppendArguments = Parameters<
  typeof appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt
>[0];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(
  t: TestContext,
  label: string,
  createdAt = CREATED_AT,
): Fixture {
  const directory = realpathSync(mkdtempSync(join(
    realpathSync(tmpdir()),
    `aionis-provisioning-journal-integrity-${label}-`,
  )));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const journalPath = join(directory, "provisioning.sqlite");
  const authorityStatePath = join(directory, "authority.sqlite");
  const intentWithoutDigest: LiteRuntimeDeploymentSlotProvisioningIntentWithoutDigest = {
    contract_version:
      "aionis_lite_runtime_deployment_slot_provisioning_intent_v1",
    deployment_slot: `journal-integrity-${label}`,
    launcher_root_instance_id: sha256(`${label}:launcher-root-instance`),
    launcher_root_manifest_sha256: sha256(`${label}:launcher-root-manifest`),
    slot_path_mapping_sha256: sha256(`${label}:slot-path-mapping`),
    authority_state_path: authorityStatePath,
    lease_carrier_path: `${authorityStatePath}.lease`,
    database_realpath: join(directory, "runtime.sqlite"),
    database_instance_id: sha256(`${label}:database-instance`),
    database_file_device: "1",
    database_file_inode: "2",
    authority_instance_id: sha256(`${label}:authority-instance`),
    carrier_instance_id: sha256(`${label}:carrier-instance`),
    first_binding_anchor_sha256: sha256(`${label}:first-binding-anchor`),
    created_at: createdAt,
  };
  const intent = createLiteRuntimeDeploymentSlotProvisioningJournal({
    journalPath,
    intentWithoutDigest,
  });
  return {
    directory,
    journalPath,
    phaseDirectoryPath: join(directory, "provisioning-phases"),
    intent,
  };
}

function rawIntentJson(database: DatabaseSync): string {
  return stableStringify(database.prepare(`SELECT * FROM ${INTENT_TABLE}`).get());
}

function invokeAppend(args: unknown): ReturnType<
  typeof appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt
> {
  return appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt(
    args as AppendArguments,
  );
}

function assertInvalidJournalFailure(
  action: () => unknown,
  message: RegExp,
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError);
    assert.equal(
      error.code,
      "lite_runtime_deployment_slot_provisioning_journal_invalid",
    );
    assert.match(error.message, message);
    return true;
  });
}

function assertNoReceipt(fixture: Fixture): void {
  assert.deepEqual(
    readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      intent: fixture.intent,
    }),
    [],
  );
  assert.equal(existsSync(fixture.phaseDirectoryPath), false);
}

function readRecoveryContract(directory: string): Readonly<{
  slotProvisioningRecovery: string;
  provisioningRollbackResistance: string;
}> {
  const rootPath = join(directory, "conditional-recovery-contract-root");
  mkdirSync(rootPath, { mode: 0o700 });
  chmodSync(rootPath, 0o700);
  const provisioned = provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    now: new Date("2026-07-18T03:59:00.000Z"),
  });
  const root = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    expectedRootManifestSha256: provisioned.root_manifest_sha256,
  });
  try {
    const slot = deriveLiteRuntimeDeploymentSlotPathCapability(
      root,
      "journal-integrity-rollback-contract",
    );
    const inspection = inspectLiteRuntimeDeploymentSlotPathCapability(slot);
    return Object.freeze({
      slotProvisioningRecovery: inspection.slot_provisioning_recovery,
      provisioningRollbackResistance:
        inspection.provisioning_rollback_resistance,
    });
  } finally {
    closeLiteRuntimeDeploymentSlotPathAuthorityRoot(root);
  }
}

test("journal singleton intent rejects every SQLite replacement path without changing bytes or values", (t) => {
  const fixture = createFixture(t, "intent-immutable");
  const originalIntent = fixture.intent;
  const originalJournalBytes = readFileSync(fixture.journalPath);
  const database = new DatabaseSync(fixture.journalPath);
  try {
    // This deliberately disables recursive DELETE triggers. The independent
    // BEFORE INSERT guard must still stop both forms of SQLite REPLACE.
    database.exec("PRAGMA recursive_triggers = OFF");
    const originalRow = rawIntentJson(database);
    const replacementProjection = `
      SELECT
        singleton,
        contract_version,
        deployment_slot || '-replacement',
        launcher_root_instance_id,
        launcher_root_manifest_sha256,
        slot_path_mapping_sha256,
        authority_state_path,
        lease_carrier_path,
        database_realpath,
        database_instance_id,
        database_file_device,
        database_file_inode,
        authority_instance_id,
        carrier_instance_id,
        first_binding_anchor_sha256,
        created_at,
        intent_sha256
      FROM ${INTENT_TABLE}
    `;
    const mutations = [
      [
        "UPDATE",
        `UPDATE ${INTENT_TABLE}
         SET deployment_slot = deployment_slot || '-updated'
         WHERE singleton = 1`,
      ],
      ["DELETE", `DELETE FROM ${INTENT_TABLE} WHERE singleton = 1`],
      ["REPLACE", `REPLACE INTO ${INTENT_TABLE} ${replacementProjection}`],
      [
        "INSERT OR REPLACE",
        `INSERT OR REPLACE INTO ${INTENT_TABLE} ${replacementProjection}`,
      ],
    ] as const;

    for (const [label, sql] of mutations) {
      assert.throws(
        () => database.exec(sql),
        /deployment_slot_provisioning_intent_is_immutable/u,
        `${label} must be rejected by the journal schema`,
      );
      assert.equal(rawIntentJson(database), originalRow, `${label} changed intent values`);
      assert.deepEqual(
        readFileSync(fixture.journalPath),
        originalJournalBytes,
        `${label} changed durable journal bytes`,
      );
    }
  } finally {
    database.close();
  }

  assert.deepEqual(readFileSync(fixture.journalPath), originalJournalBytes);
  assert.deepEqual(
    readLiteRuntimeDeploymentSlotProvisioningJournal(fixture.journalPath),
    originalIntent,
  );
  assert.equal(existsSync(`${fixture.journalPath}-journal`), false);
  assert.equal(existsSync(`${fixture.journalPath}-wal`), false);
  assert.equal(existsSync(`${fixture.journalPath}-shm`), false);
});

test("append rejects missing, forged, released, and wrong-directory locks with zero receipts", (t) => {
  const fixture = createFixture(t, "lock-capability");
  const appendWithoutLock = Object.freeze({
    phaseDirectoryPath: fixture.phaseDirectoryPath,
    phase: "intent_durable",
    evidence: Object.freeze({ probe: "missing-lock" }),
    recordedAt: new Date(CREATED_AT),
  });

  assertInvalidJournalFailure(
    () => invokeAppend(appendWithoutLock),
    /requires a live lock capability/u,
  );
  assertNoReceipt(fixture);

  assertInvalidJournalFailure(
    () => invokeAppend({
      ...appendWithoutLock,
      evidence: Object.freeze({ probe: "forged-lock" }),
      lock: Object.freeze(Object.create(null)),
    }),
    /forged, released, or detached/u,
  );
  assertNoReceipt(fixture);

  const releasedLock = acquireLiteRuntimeDeploymentSlotProvisioningJournalLock(
    {
      journalPath: fixture.journalPath,
      expectedIntentSha256: fixture.intent.intent_sha256,
    },
  );
  releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(releasedLock);
  assertInvalidJournalFailure(
    () => invokeAppend({
      ...appendWithoutLock,
      evidence: Object.freeze({ probe: "released-lock" }),
      lock: releasedLock,
    }),
    /forged, released, or detached/u,
  );
  assertNoReceipt(fixture);

  const wrongPhaseDirectoryPath = join(fixture.directory, "wrong-phases");
  const liveLock = acquireLiteRuntimeDeploymentSlotProvisioningJournalLock(
    {
      journalPath: fixture.journalPath,
      expectedIntentSha256: fixture.intent.intent_sha256,
    },
  );
  try {
    assertInvalidJournalFailure(
      () => appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
        lock: liveLock,
        phaseDirectoryPath: wrongPhaseDirectoryPath,
        phase: "intent_durable",
        evidence: Object.freeze({ probe: "wrong-phase-directory" }),
        recordedAt: new Date(CREATED_AT),
      }),
      /lock is not bound to this phase directory/u,
    );
  } finally {
    releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(liveLock);
  }
  assertNoReceipt(fixture);
  assert.equal(existsSync(wrongPhaseDirectoryPath), false);
});

test("lock acquisition rejects a different expected intent with zero receipt mutation", (t) => {
  const fixture = createFixture(t, "lock-intent-binding");
  const journalBytesBefore = readFileSync(fixture.journalPath);
  const receiptsBefore = readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
    phaseDirectoryPath: fixture.phaseDirectoryPath,
    intent: fixture.intent,
  });
  assert.deepEqual(receiptsBefore, []);
  assert.equal(existsSync(fixture.phaseDirectoryPath), false);

  assert.throws(
    () => acquireLiteRuntimeDeploymentSlotProvisioningJournalLock({
      journalPath: fixture.journalPath,
      expectedIntentSha256: sha256("different-selected-intent"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof LiteRuntimeDeploymentSlotProvisioningJournalError);
      assert.equal(
        error.code,
        "lite_runtime_deployment_slot_provisioning_journal_conflict",
      );
      assert.match(error.message, /lock binds a different intent/u);
      return true;
    },
  );

  assert.equal(existsSync(fixture.phaseDirectoryPath), false);
  assert.deepEqual(
    readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      intent: fixture.intent,
    }),
    receiptsBefore,
  );
  assert.deepEqual(readFileSync(fixture.journalPath), journalBytesBefore);
  assert.equal(existsSync(`${fixture.journalPath}-journal`), false);
  assert.equal(existsSync(`${fixture.journalPath}-wal`), false);
  assert.equal(existsSync(`${fixture.journalPath}-shm`), false);

  const correctlyBoundLock = acquireLiteRuntimeDeploymentSlotProvisioningJournalLock({
    journalPath: fixture.journalPath,
    expectedIntentSha256: fixture.intent.intent_sha256,
  });
  releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(correctlyBoundLock);
  assert.equal(existsSync(fixture.phaseDirectoryPath), false);
});

test("receipt timestamps stay monotonic when the supplied clock moves backward", (t) => {
  const fixture = createFixture(t, "monotonic-time");
  const lock = acquireLiteRuntimeDeploymentSlotProvisioningJournalLock(
    {
      journalPath: fixture.journalPath,
      expectedIntentSha256: fixture.intent.intent_sha256,
    },
  );
  try {
    const first = appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
      lock,
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      phase: "intent_durable",
      evidence: Object.freeze({ sequence: 1 }),
      recordedAt: new Date("2026-07-17T00:00:00.000Z"),
    });
    assert.equal(first.recorded_at, fixture.intent.created_at);

    const second = appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
      lock,
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      phase: "pair_inodes_durable",
      evidence: Object.freeze({ sequence: 2 }),
      recordedAt: new Date("2026-07-18T05:00:00.000Z"),
    });
    assert.equal(second.recorded_at, "2026-07-18T05:00:00.000Z");

    const third = appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
      lock,
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      phase: "carrier_ready",
      evidence: Object.freeze({ sequence: 3 }),
      recordedAt: new Date("2026-07-18T03:00:00.000Z"),
    });
    assert.equal(third.recorded_at, second.recorded_at);
  } finally {
    releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(lock);
  }

  assert.deepEqual(
    readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      intent: fixture.intent,
    }).map((receipt) => receipt.recorded_at),
    [
      "2026-07-18T04:00:00.000Z",
      "2026-07-18T05:00:00.000Z",
      "2026-07-18T05:00:00.000Z",
    ],
  );
});

test("deleting the final valid receipt exposes only the documented current-lineage rollback gap", (t) => {
  const fixture = createFixture(t, "shorter-prefix");
  const recoveryContract = readRecoveryContract(fixture.directory);
  assert.equal(
    recoveryContract.slotProvisioningRecovery,
    "conditional_process_live_classify_resume_abort_v1",
  );
  assert.equal(
    recoveryContract.provisioningRollbackResistance,
    "current_lineage_only_without_provisioning_journal_rollback",
  );

  const lock = acquireLiteRuntimeDeploymentSlotProvisioningJournalLock(
    {
      journalPath: fixture.journalPath,
      expectedIntentSha256: fixture.intent.intent_sha256,
    },
  );
  try {
    appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
      lock,
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      phase: "intent_durable",
      evidence: Object.freeze({ sequence: 1 }),
      recordedAt: new Date(CREATED_AT),
    });
    appendLiteRuntimeDeploymentSlotProvisioningPhaseReceipt({
      lock,
      phaseDirectoryPath: fixture.phaseDirectoryPath,
      phase: "aborted",
      evidence: Object.freeze({ sequence: 2, reason: "test-abort" }),
      recordedAt: new Date("2026-07-18T04:01:00.000Z"),
    });
  } finally {
    releaseLiteRuntimeDeploymentSlotProvisioningJournalLock(lock);
  }

  const fullPrefix = readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
    phaseDirectoryPath: fixture.phaseDirectoryPath,
    intent: fixture.intent,
  });
  assert.deepEqual(fullPrefix.map((receipt) => receipt.phase), [
    "intent_durable",
    "aborted",
  ]);
  assert.deepEqual(readdirSync(fixture.phaseDirectoryPath).sort(), [
    "0001.json",
    "0002.json",
  ]);

  unlinkSync(join(fixture.phaseDirectoryPath, "0002.json"));

  const shorterPrefix = readLiteRuntimeDeploymentSlotProvisioningPhaseReceipts({
    phaseDirectoryPath: fixture.phaseDirectoryPath,
    intent: fixture.intent,
  });
  assert.deepEqual(shorterPrefix.map((receipt) => receipt.phase), [
    "intent_durable",
  ]);
  assert.deepEqual(shorterPrefix[0], fullPrefix[0]);
  assert.notDeepEqual(shorterPrefix, fullPrefix);
  assert.equal(
    recoveryContract.provisioningRollbackResistance,
    "current_lineage_only_without_provisioning_journal_rollback",
    "a valid shorter prefix demonstrates the declared rollback gap; it does not establish tamper detection",
  );
});
