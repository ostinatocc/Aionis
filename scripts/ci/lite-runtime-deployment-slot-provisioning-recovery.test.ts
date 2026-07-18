import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";

import stableStringify from "fast-json-stable-stringify";

import {
  migrateLiteRuntimeAuthorityIdentity,
} from "../../src/store/lite-learning-episode-ledger.js";
import {
  abortLiteRuntimeDeploymentSlotAuthorityProvisioning,
  acquireLiteRuntimeDeploymentSlotExclusiveLease,
  classifyLiteRuntimeDeploymentSlotAuthorityProvisioning,
  installLiteRuntimeDeploymentSlotProvisioningPhysicalMutationObserverForTesting,
  inspectLiteRuntimeDeploymentSlotCheckpointGeneration,
  inspectLiteRuntimeDeploymentSlotExclusiveLease,
  provisionLiteRuntimeDeploymentSlotAuthority,
  releaseLiteRuntimeDeploymentSlotExclusiveLease,
  reserveLiteRuntimeDeploymentSlotCheckpointGeneration,
  resumeLiteRuntimeDeploymentSlotAuthorityProvisioning,
  LiteRuntimeDeploymentSlotAuthorityError,
  type LiteRuntimeDeploymentSlotProvisioningDurablePhase,
  type LiteRuntimeDeploymentSlotProvisioningPhysicalMutation,
} from "../../src/store/lite-runtime-deployment-slot-authority.js";
import {
  installLiteRuntimeDeploymentSlotProvisioningJournalFaultObserverForTesting,
  PROVISIONING_JOURNAL_FAULT_POINTS,
  type LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint,
} from "../../src/store/lite-runtime-deployment-slot-provisioning-journal.js";
import {
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  inspectLiteRuntimeDeploymentSlotPathCapability,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
  prepareLiteRuntimeDeploymentSlotPathForProvisioning,
  provisionLiteRuntimeDeploymentSlotPathAuthorityRoot,
  type LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
  type LiteRuntimeDeploymentSlotPathCapability,
  type LiteRuntimeDeploymentSlotPathInspection,
} from "../../src/store/lite-runtime-deployment-slot-path-authority.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  pinLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "../../src/store/lite-runtime-protected-authority-database.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECOVERY_CHILD = fileURLToPath(new URL(
  "./support/lite-runtime-deployment-slot-provisioning-recovery-child.ts",
  import.meta.url,
));
const DEPLOYMENT_SLOT = "recovery-runtime-primary";
const PROVISIONING_TIME = new Date("2026-07-18T04:00:00.000Z");
const ACQUIRE_TIME = new Date("2026-07-18T08:00:00.000Z");
const RELEASE_TIME = new Date("2026-07-18T08:01:00.000Z");
const CRASH_PHASES = [
  "intent_durable",
  "pair_inodes_durable",
  "carrier_ready",
  "state_ready",
  "initial_witness_ready",
  "committed",
] as const satisfies readonly LiteRuntimeDeploymentSlotProvisioningDurablePhase[];
const BOOTSTRAP_MUTEX_CRASH_POINTS = [
  "bootstrap_mutex_file_durable",
  "bootstrap_mutex_transaction_dirty",
  "bootstrap_mutex_schema_committed",
] as const satisfies readonly LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint[];
const BOOTSTRAP_CRASH_POINTS = PROVISIONING_JOURNAL_FAULT_POINTS.filter(
  (point) => point.startsWith("bootstrap_")
    && !(BOOTSTRAP_MUTEX_CRASH_POINTS as readonly string[]).includes(point)
    && point !== "bootstrap_scratch_cleanup_locked",
);
const RECEIPT_CRASH_POINTS = PROVISIONING_JOURNAL_FAULT_POINTS.filter(
  (point) => point.startsWith("receipt_"),
);
const LINKED_RECEIPT_CRASH_POINTS = [
  "receipt_final_linked",
  "receipt_parent_synced",
] as const satisfies readonly LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint[];

type CrashPhase = typeof CRASH_PHASES[number];
type ChildAction = "abort" | "provision" | "resume";
type ChildTarget = LiteRuntimeDeploymentSlotProvisioningDurablePhase
  | LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint;

type Fixture = Readonly<{
  directory: string;
  rootPath: string;
  rootManifestSha256: string;
  rootCapability: LiteRuntimeDeploymentSlotPathAuthorityRootCapability;
  slotPath: LiteRuntimeDeploymentSlotPathCapability;
  slotInspection: LiteRuntimeDeploymentSlotPathInspection;
  runtimeDatabasePath: string;
  runtimeDatabasePin: LiteRuntimeProtectedAuthorityDatabasePin;
}>;

type ChildExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function initializeRuntimeDatabase(path: string, identitySeed: string): void {
  const databaseInstanceId = sha256(identitySeed);
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE runtime_recovery_probe (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value TEXT NOT NULL
      );
      INSERT INTO runtime_recovery_probe(singleton, value)
      VALUES (1, 'real-filesystem-recovery');
    `);
    migrateLiteRuntimeAuthorityIdentity(database, {
      now: new Date("2026-07-18T03:59:00.000Z"),
      randomBytesFactory: () => Buffer.from(databaseInstanceId, "hex"),
    });
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
}

function createFixture(t: TestContext, label: string): Fixture {
  const directory = realpathSync(mkdtempSync(join(
    realpathSync(tmpdir()),
    `aionis-slot-recovery-${label}-`,
  )));
  chmodSync(directory, 0o700);
  const rootPath = join(directory, "launcher-authority");
  mkdirSync(rootPath, { mode: 0o700 });
  chmodSync(rootPath, 0o700);
  const provisionedRoot = provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    now: new Date("2026-07-18T03:58:00.000Z"),
  });
  const rootCapability = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    expectedRootManifestSha256: provisionedRoot.root_manifest_sha256,
  });
  const slotPath = deriveLiteRuntimeDeploymentSlotPathCapability(
    rootCapability,
    DEPLOYMENT_SLOT,
  );
  const slotInspection = inspectLiteRuntimeDeploymentSlotPathCapability(slotPath);
  const runtimeDatabasePath = join(directory, "runtime.sqlite");
  initializeRuntimeDatabase(
    runtimeDatabasePath,
    `recovery-runtime-database:${label}`,
  );
  const runtimeDatabasePin = pinLiteRuntimeProtectedAuthorityDatabase(
    runtimeDatabasePath,
  );
  t.after(() => {
    try {
      closeLiteRuntimeProtectedAuthorityDatabasePin(runtimeDatabasePin);
    } catch {
      // A failing test may already have closed the pin.
    }
    try {
      closeLiteRuntimeDeploymentSlotPathAuthorityRoot(rootCapability);
    } catch {
      // A failing test may have retained or closed the root first.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    rootPath,
    rootManifestSha256: provisionedRoot.root_manifest_sha256,
    rootCapability,
    slotPath,
    slotInspection,
    runtimeDatabasePath,
    runtimeDatabasePin,
  };
}

function childArgs(args: Readonly<{
  fixture: Fixture;
  action: ChildAction;
  observerMode: "hold" | "kill";
  target: ChildTarget;
  holdReadyPath?: string;
  targetOccurrence?: number;
}>): string[] {
  return [
    "--import",
    "tsx",
    RECOVERY_CHILD,
    args.fixture.rootPath,
    args.fixture.rootManifestSha256,
    DEPLOYMENT_SLOT,
    args.fixture.runtimeDatabasePath,
    args.action,
    args.observerMode,
    args.target,
    args.holdReadyPath ?? "",
    String(args.targetOccurrence ?? 1),
  ];
}

function crashAtPhase(args: Readonly<{
  fixture: Fixture;
  action: ChildAction;
  phase: LiteRuntimeDeploymentSlotProvisioningDurablePhase;
}>): void {
  const child = spawnSync(process.execPath, childArgs({
    fixture: args.fixture,
    action: args.action,
    target: args.phase,
    observerMode: "kill",
  }), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, null, child.stderr || child.stdout);
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
}

function startHoldingRecovery(args: Readonly<{
  fixture: Fixture;
  action: ChildAction;
  target: ChildTarget;
  holdReadyPath: string;
}>): Readonly<{ process: ChildProcess; exit: Promise<ChildExit> }> {
  const child = spawn(process.execPath, childArgs({
    fixture: args.fixture,
    action: args.action,
    target: args.target,
    holdReadyPath: args.holdReadyPath,
    observerMode: "hold",
  }), {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<ChildExit>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal, stderr }));
  });
  return { process: child, exit };
}

function crashAtJournalFault(args: Readonly<{
  fixture: Fixture;
  action: ChildAction;
  point: LiteRuntimeDeploymentSlotProvisioningJournalFaultPoint;
  targetOccurrence?: number;
}>): void {
  const child = spawnSync(process.execPath, childArgs({
    fixture: args.fixture,
    action: args.action,
    target: args.point,
    targetOccurrence: args.targetOccurrence,
    observerMode: "kill",
  }), {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (args.targetOccurrence ?? 1) > 1 ? 90_000 : 30_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, null, child.stderr || child.stdout);
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
}

async function within<T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(10);
  }
}

async function killHoldingChild(
  child: Readonly<{ process: ChildProcess; exit: Promise<ChildExit> }>,
): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill("SIGKILL");
  }
  const exit = await within(child.exit, "held recovery child exit");
  assert.equal(exit.code, null, exit.stderr);
  assert.equal(exit.signal, "SIGKILL", exit.stderr);
}

function assertNoSibling(fixture: Fixture): void {
  const shard = dirname(fixture.slotInspection.slot_directory_path);
  assert.deepEqual(
    readdirSync(shard).sort(),
    [basename(fixture.slotInspection.slot_directory_path)],
  );
}

function assertLinkedReceiptPublication(
  fixture: Fixture,
  receiptIndex: number,
): void {
  const finalName = `${String(receiptIndex).padStart(4, "0")}.json`;
  const names = readdirSync(
    fixture.slotInspection.provisioning_phase_directory_path,
  ).sort();
  assert.equal(names.includes(finalName), true);
  assert.equal(
    names.filter((name) => name.startsWith(`.${finalName}.`)
      && name.endsWith(".pending")).length,
    1,
  );
}

function fileIdentity(path: string): Readonly<{
  device: string;
  inode: string;
  links: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  bytesSha256: string;
}> {
  const stat = lstatSync(path, { bigint: true });
  assert.equal(stat.isFile(), true, path);
  return Object.freeze({
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    links: stat.nlink.toString(10),
    mode: (stat.mode & 0o7777n).toString(8),
    size: stat.size.toString(10),
    mtimeNs: stat.mtimeNs.toString(10),
    ctimeNs: stat.ctimeNs.toString(10),
    bytesSha256: sha256(readFileSync(path)),
  });
}

function bootstrapPublicationSnapshot(fixture: Fixture): unknown {
  const journalPath = fixture.slotInspection.provisioning_journal_path;
  const stagingPath = `${journalPath}.bootstrap`;
  return Object.freeze({
    names: readdirSync(fixture.slotInspection.slot_directory_path).sort(),
    final: existsSync(journalPath) ? fileIdentity(journalPath) : null,
    staging: existsSync(stagingPath) ? fileIdentity(stagingPath) : null,
  });
}

function assertStrictBootstrapMutexAndSingleIntent(fixture: Fixture): void {
  const journalPath = fixture.slotInspection.provisioning_journal_path;
  const mutexPath = `${journalPath}.bootstrap-lock`;
  const mutexStat = lstatSync(mutexPath, { bigint: true });
  assert.equal(mutexStat.isFile(), true);
  assert.equal(mutexStat.nlink, 1n);
  assert.equal(mutexStat.mode & 0o7777n, 0o600n);
  if (typeof process.getuid === "function") {
    assert.equal(mutexStat.uid, BigInt(process.getuid()));
  }
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    assert.equal(existsSync(`${mutexPath}${suffix}`), false);
  }

  const mutex = new DatabaseSync(mutexPath, { readOnly: true });
  try {
    const persistentPragmas = mutex.prepare(`
      SELECT
        (SELECT application_id FROM pragma_application_id) AS application_id,
        (SELECT user_version FROM pragma_user_version) AS user_version,
        (SELECT journal_mode FROM pragma_journal_mode) AS journal_mode,
        (SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')
          AS object_count
    `).get() as Record<string, unknown> | undefined;
    assert.deepEqual({ ...persistentPragmas }, {
      application_id: 0x4149504d,
      user_version: 1,
      journal_mode: "delete",
      object_count: 1,
    });
    assert.deepEqual(
      (mutex.prepare(`
        SELECT singleton, contract_version
        FROM lite_runtime_deployment_slot_provisioning_bootstrap_mutex
      `).all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
      [{
        singleton: 1,
        contract_version:
          "aionis_lite_runtime_deployment_slot_provisioning_bootstrap_mutex_v1",
      }],
    );
    assert.deepEqual(
      (mutex.prepare("PRAGMA integrity_check").all() as
        Array<Record<string, unknown>>).map((row) => ({ ...row })),
      [{ integrity_check: "ok" }],
    );
  } finally {
    mutex.close();
  }

  const journal = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const row = journal.prepare(`
      SELECT COUNT(*) AS intent_count
      FROM lite_runtime_deployment_slot_provisioning_intent
    `).get() as Record<string, unknown> | undefined;
    assert.deepEqual({ ...row }, { intent_count: 1 });
  } finally {
    journal.close();
  }
}

function slotTreeSnapshot(rootPath: string): unknown {
  const walk = (directoryPath: string, prefix: string): unknown[] =>
    readdirSync(directoryPath).sort().flatMap((name) => {
      const path = join(directoryPath, name);
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) {
        return [{
          path: relativePath,
          type: "directory",
          device: stat.dev.toString(10),
          inode: stat.ino.toString(10),
          links: stat.nlink.toString(10),
          mode: (stat.mode & 0o7777n).toString(8),
          mtimeNs: stat.mtimeNs.toString(10),
          ctimeNs: stat.ctimeNs.toString(10),
        }, ...walk(path, relativePath)];
      }
      return [{
        path: relativePath,
        type: "file",
        identity: fileIdentity(path),
      }];
    });
  return walk(rootPath, "");
}

function pairPhysicalSnapshot(fixture: Fixture) {
  return Object.freeze({
    state: fileIdentity(fixture.slotInspection.authority_state_path),
    carrier: fileIdentity(fixture.slotInspection.lease_carrier_path),
  });
}

function provisioningArtifactSnapshot(fixture: Fixture): unknown {
  const receipts = readdirSync(
    fixture.slotInspection.provisioning_phase_directory_path,
  )
    .sort()
    .map((name) => {
      const path = join(
        fixture.slotInspection.provisioning_phase_directory_path,
        name,
      );
      return { name, identity: fileIdentity(path) };
    });
  return Object.freeze({
    journal: fileIdentity(fixture.slotInspection.provisioning_journal_path),
    receipts,
  });
}

function queryRows(database: DatabaseSync, sql: string): unknown {
  return JSON.parse(stableStringify(database.prepare(sql).all())) as unknown;
}

function committedSemanticSnapshot(fixture: Fixture): unknown {
  const statePath = fixture.slotInspection.authority_state_path;
  const carrierPath = fixture.slotInspection.lease_carrier_path;
  const state = new DatabaseSync(statePath, { readOnly: true });
  let stateRows: unknown;
  try {
    stateRows = {
      registration: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_registration ORDER BY singleton",
      ),
      operations: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_operations ORDER BY operation_id",
      ),
      leases: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_lease_epochs ORDER BY length(lease_epoch), lease_epoch",
      ),
      reservations: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_checkpoint_reservations ORDER BY length(checkpoint_generation), checkpoint_generation",
      ),
      abandonments: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_reservation_abandonments ORDER BY reservation_id",
      ),
      completions: queryRows(
        state,
        "SELECT * FROM lite_runtime_deployment_slot_binding_completions ORDER BY length(checkpoint_generation), checkpoint_generation",
      ),
    };
  } finally {
    state.close();
  }
  const carrier = new DatabaseSync(carrierPath, { readOnly: true });
  let carrierRows: unknown;
  try {
    carrierRows = {
      identity: queryRows(
        carrier,
        "SELECT * FROM lite_runtime_deployment_slot_lease_identity ORDER BY singleton",
      ),
      witnesses: queryRows(
        carrier,
        "SELECT * FROM lite_runtime_deployment_slot_state_witnesses ORDER BY length(witness_epoch), witness_epoch",
      ),
    };
  } finally {
    carrier.close();
  }
  return JSON.parse(stableStringify({
    physical: pairPhysicalSnapshot(fixture),
    provisioning: provisioningArtifactSnapshot(fixture),
    state: stateRows,
    carrier: carrierRows,
  })) as unknown;
}

function assertGenesisState(fixture: Fixture): void {
  const state = new DatabaseSync(
    fixture.slotInspection.authority_state_path,
    { readOnly: true },
  );
  try {
    const counts = state.prepare(`
      SELECT
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_registration)
          AS registrations,
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_operations)
          AS operations,
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_lease_epochs)
          AS leases,
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_checkpoint_reservations)
          AS reservations,
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_reservation_abandonments)
          AS abandonments,
        (SELECT COUNT(*) FROM lite_runtime_deployment_slot_binding_completions)
          AS completions
    `).get() as Record<string, number> | undefined;
    assert.deepEqual({ ...counts }, {
      registrations: 1,
      operations: 0,
      leases: 0,
      reservations: 0,
      abandonments: 0,
      completions: 0,
    });
  } finally {
    state.close();
  }
  const carrier = new DatabaseSync(
    fixture.slotInspection.lease_carrier_path,
    { readOnly: true },
  );
  try {
    const witnesses = carrier.prepare(`
      SELECT witness_epoch
      FROM lite_runtime_deployment_slot_state_witnesses
      ORDER BY length(witness_epoch), witness_epoch
    `).all() as Array<Readonly<{ witness_epoch: string }>>;
    assert.deepEqual(witnesses.map((row) => row.witness_epoch), ["1"]);
  } finally {
    carrier.close();
  }
}

async function resumeWithoutNewIdentity(fixture: Fixture) {
  return await Promise.resolve(resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: () => {
      throw new Error("recovery must use the durable provisioning intent");
    },
  }));
}

async function resumeAllowingUnpublishedBootstrapIdentity(fixture: Fixture) {
  let randomCall = 0;
  return await Promise.resolve(resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => {
      randomCall += 1;
      return Buffer.alloc(size, 0x60 + randomCall);
    },
  }));
}

async function assertFirstLeaseAndGeneration(fixture: Fixture, label: string): Promise<void> {
  assertGenesisState(fixture);
  const lease = await Promise.resolve(acquireLiteRuntimeDeploymentSlotExclusiveLease({
    slotPath: fixture.slotPath,
    now: ACQUIRE_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x71),
  }));
  assert.equal(inspectLiteRuntimeDeploymentSlotExclusiveLease(lease).lease_epoch, "1");
  const operationId = `first-after-recovery-${label}`;
  const reservation = await Promise.resolve(
    reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
      lease,
      operationId,
      operationRequestSha256: sha256(`request:${operationId}`),
      now: ACQUIRE_TIME,
      randomBytesFactory: (size) => Buffer.alloc(size, 0x72),
    }),
  );
  assert.equal(reservation.kind, "reserved");
  if (reservation.kind !== "reserved") {
    throw new Error("expected a fresh generation after provisioning recovery");
  }
  assert.equal(
    inspectLiteRuntimeDeploymentSlotCheckpointGeneration(reservation.reservation)
      .checkpoint_generation,
    "1",
  );
  await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease, {
    now: RELEASE_TIME,
  });
  const carrier = new DatabaseSync(
    fixture.slotInspection.lease_carrier_path,
    { readOnly: true },
  );
  try {
    const witnesses = carrier.prepare(`
      SELECT witness_epoch
      FROM lite_runtime_deployment_slot_state_witnesses
      ORDER BY length(witness_epoch), witness_epoch
    `).all() as Array<Readonly<{ witness_epoch: string }>>;
    assert.deepEqual(witnesses.map((row) => row.witness_epoch), ["1", "2"]);
  } finally {
    carrier.close();
  }
}

test("D3a.3a.1 journal bootstrap publication survives every internal SIGKILL window", {
  concurrency: 1,
}, async (t) => {
  for (const point of BOOTSTRAP_CRASH_POINTS) {
    await t.test(point, async (pointTest) => {
      const fixture = createFixture(pointTest, `bootstrap-${point}`);
      crashAtJournalFault({ fixture, action: "provision", point });
      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.recovery_action, "resume");
      assert.equal(classified.last_durable_phase, null);
      assert.equal(
        classified.rollback_resistance,
        "current_lineage_only_without_provisioning_journal_rollback",
      );
      const committed = point === "bootstrap_publication_inspected"
        || point === "bootstrap_staging_created"
        || point === "bootstrap_sqlite_opened"
        || point === "bootstrap_transaction_dirty"
        ? await resumeAllowingUnpublishedBootstrapIdentity(fixture)
        : await resumeWithoutNewIdentity(fixture);
      assert.equal(committed.deployment_slot, DEPLOYMENT_SLOT);
      assert.equal(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }).classification,
        "committed",
      );
      assert.equal(
        existsSync(`${fixture.slotInspection.provisioning_journal_path}.bootstrap`),
        false,
      );
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 bootstrap mutex creation survives every internal SIGKILL window", {
  concurrency: 1,
  timeout: 180_000,
}, async (t) => {
  for (const point of BOOTSTRAP_MUTEX_CRASH_POINTS) {
    await t.test(point, async (pointTest) => {
      const fixture = createFixture(pointTest, `bootstrap-mutex-${point}`);
      crashAtJournalFault({ fixture, action: "provision", point });

      const mutexPath =
        `${fixture.slotInspection.provisioning_journal_path}.bootstrap-lock`;
      assert.equal(existsSync(mutexPath), true);
      assert.equal(
        existsSync(fixture.slotInspection.provisioning_journal_path),
        false,
      );
      assert.equal(
        existsSync(`${fixture.slotInspection.provisioning_journal_path}.bootstrap`),
        false,
      );
      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.recovery_action, "resume");
      assert.equal(classified.last_durable_phase, null);

      const committed = await resumeAllowingUnpublishedBootstrapIdentity(fixture);
      assert.equal(committed.deployment_slot, DEPLOYMENT_SLOT);
      assert.equal(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }).classification,
        "committed",
      );
      assertStrictBootstrapMutexAndSingleIntent(fixture);
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 foreign Runtime bootstrap ownership fails before publication mutation", {
  concurrency: 1,
  timeout: 180_000,
}, async (t) => {
  for (const point of [
    "bootstrap_transaction_committed",
    "bootstrap_final_linked",
  ] as const) {
    await t.test(point, async (pointTest) => {
      const fixture = createFixture(pointTest, `foreign-runtime-${point}`);
      const foreignRuntimeDatabasePath = join(
        fixture.directory,
        `foreign-${point}.sqlite`,
      );
      initializeRuntimeDatabase(
        foreignRuntimeDatabasePath,
        `foreign-runtime-database:${point}`,
      );
      crashAtJournalFault({
        fixture: Object.freeze({
          ...fixture,
          runtimeDatabasePath: foreignRuntimeDatabasePath,
        }),
        action: "provision",
        point,
      });

      const before = bootstrapPublicationSnapshot(fixture);
      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.last_durable_phase, null);
      assert.equal(classified.recovery_action, "resume");
      assert.deepEqual(bootstrapPublicationSnapshot(fixture), before);

      await assert.rejects(
        async () => await resumeWithoutNewIdentity(fixture),
        /Runtime|database|pin|identity|mismatch|recovery/iu,
      );
      assert.deepEqual(bootstrapPublicationSnapshot(fixture), before);
      assert.equal(
        existsSync(fixture.slotInspection.provisioning_phase_directory_path),
        false,
      );
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 bootstrap mutex prevents a stale absent inspection", async (t) => {
  const fixture = createFixture(t, "concurrent-bootstrap-winner");
  prepareLiteRuntimeDeploymentSlotPathForProvisioning(fixture.slotPath);
  let nestedContended = false;
  let disposeObserver: () => void = () => undefined;
  disposeObserver =
    installLiteRuntimeDeploymentSlotProvisioningJournalFaultObserverForTesting(
      (point) => {
        if (point !== "bootstrap_publication_inspected") return;
        disposeObserver();
        try {
          resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
            slotPath: fixture.slotPath,
            runtimeDatabasePin: fixture.runtimeDatabasePin,
            now: PROVISIONING_TIME,
            randomBytesFactory: (size) => Buffer.alloc(size, 0x31),
          });
        } catch (error) {
          assert.equal(
            error instanceof LiteRuntimeDeploymentSlotAuthorityError
              ? error.code
              : null,
            "lite_runtime_deployment_slot_authority_recovery_contended",
          );
          nestedContended = true;
        }
      },
    );
  try {
    const replayed = resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
      runtimeDatabasePin: fixture.runtimeDatabasePin,
      now: PROVISIONING_TIME,
      randomBytesFactory: (size) => Buffer.alloc(size, 0x32),
    });
    assert.equal(replayed.deployment_slot, DEPLOYMENT_SLOT);
    assert.equal(nestedContended, true);
  } finally {
    disposeObserver();
  }
  assert.equal(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }).classification,
    "committed",
  );
  assert.equal(
    existsSync(`${fixture.slotInspection.provisioning_journal_path}.bootstrap`),
    false,
  );
  assert.deepEqual(
    readdirSync(fixture.slotInspection.provisioning_phase_directory_path).sort(),
    ["0001.json", "0002.json", "0003.json", "0004.json", "0005.json", "0006.json"],
  );
  assertGenesisState(fixture);
  assertNoSibling(fixture);
});

test("D3a.3a.1 bootstrap mutex survives holder SIGKILL before journal creation", {
  timeout: 90_000,
}, async (t) => {
  const fixture = createFixture(t, "bootstrap-mutex-holder");
  prepareLiteRuntimeDeploymentSlotPathForProvisioning(fixture.slotPath);
  const readyPath = join(fixture.directory, "bootstrap-mutex-held.json");
  const holder = startHoldingRecovery({
    fixture,
    action: "resume",
    target: "bootstrap_publication_inspected",
    holdReadyPath: readyPath,
  });
  t.after(async () => {
    if (holder.process.exitCode === null && holder.process.signalCode === null) {
      holder.process.kill("SIGKILL");
      await holder.exit.catch(() => undefined);
    }
  });
  await waitForPath(readyPath);
  await assert.rejects(
    async () => await resumeAllowingUnpublishedBootstrapIdentity(fixture),
    (error: unknown) => error instanceof LiteRuntimeDeploymentSlotAuthorityError
      && error.code
        === "lite_runtime_deployment_slot_authority_recovery_contended",
  );
  await killHoldingChild(holder);

  await resumeAllowingUnpublishedBootstrapIdentity(fixture);
  assert.equal(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }).classification,
    "committed",
  );
  assert.equal(
    existsSync(
      `${fixture.slotInspection.provisioning_journal_path}.bootstrap-lock`,
    ),
    true,
  );
  assertGenesisState(fixture);
  assertNoSibling(fixture);
});

test("D3a.3a.1 published winner never unlinks an active bootstrap loser", async (t) => {
  const fixture = createFixture(t, "active-bootstrap-loser");
  await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x37),
  }));
  const stagingPath = `${fixture.slotInspection.provisioning_journal_path}.bootstrap`;
  const scratch = new DatabaseSync(stagingPath);
  let transactionOpen = false;
  try {
    scratch.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE active_loser_probe(value TEXT NOT NULL);
    `);
    scratch.close();
    chmodSync(stagingPath, 0o600);

    const activeScratch = new DatabaseSync(stagingPath);
    try {
      activeScratch.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      activeScratch.exec("INSERT INTO active_loser_probe(value) VALUES ('dirty')");
      const rollbackJournalPath = `${stagingPath}-journal`;
      assert.equal(existsSync(rollbackJournalPath), true);
      chmodSync(rollbackJournalPath, 0o600);
      const stagingBefore = fileIdentity(stagingPath);
      const rollbackBefore = fileIdentity(rollbackJournalPath);

      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.last_durable_phase, "committed");
      assert.equal(classified.recovery_action, "resume");
      await assert.rejects(
        async () => await resumeWithoutNewIdentity(fixture),
        (error: unknown) => error instanceof LiteRuntimeDeploymentSlotAuthorityError
          && error.code
            === "lite_runtime_deployment_slot_authority_recovery_contended",
      );
      assert.deepEqual(fileIdentity(stagingPath), stagingBefore);
      assert.deepEqual(fileIdentity(rollbackJournalPath), rollbackBefore);

      activeScratch.exec("ROLLBACK");
      transactionOpen = false;
    } finally {
      if (transactionOpen) {
        try { activeScratch.exec("ROLLBACK"); } catch { /* preserve failure */ }
      }
      activeScratch.close();
    }
  } finally {
    try { scratch.close(); } catch { /* already closed after schema creation */ }
  }

  const replayed = await resumeWithoutNewIdentity(fixture);
  assert.equal(replayed.deployment_slot, DEPLOYMENT_SLOT);
  assert.equal(existsSync(stagingPath), false);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  assert.equal(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }).classification,
    "committed",
  );
  assertGenesisState(fixture);
  assertNoSibling(fixture);
});

test("D3a.3a.1 published prefixes tolerate and clean independent bootstrap scratch", {
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  for (const phase of [
    "intent_durable",
    "pair_inodes_durable",
    "carrier_ready",
  ] as const satisfies readonly LiteRuntimeDeploymentSlotProvisioningDurablePhase[]) {
    await t.test(phase, async (phaseTest) => {
      const fixture = createFixture(phaseTest, `published-scratch-${phase}`);
      crashAtPhase({ fixture, action: "provision", phase });
      const stagingPath =
        `${fixture.slotInspection.provisioning_journal_path}.bootstrap`;
      const scratch = new DatabaseSync(stagingPath);
      try {
        scratch.exec(`
          PRAGMA journal_mode = DELETE;
          CREATE TABLE stale_bootstrap_probe(value TEXT NOT NULL);
        `);
      } finally {
        scratch.close();
      }
      chmodSync(stagingPath, 0o600);

      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.last_durable_phase, phase);
      assert.equal(classified.recovery_action, "resume");
      await resumeWithoutNewIdentity(fixture);
      assert.equal(existsSync(stagingPath), false);
      assert.equal(existsSync(`${stagingPath}-journal`), false);
      assert.equal(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }).classification,
        "committed",
      );
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 scratch cleanup SIGKILL cannot orphan a rollback journal", async (t) => {
  const fixture = createFixture(t, "scratch-cleanup-sigkill");
  await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x39),
  }));
  const stagingPath = `${fixture.slotInspection.provisioning_journal_path}.bootstrap`;
  const scratch = new DatabaseSync(stagingPath);
  try {
    scratch.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE cleanup_crash_probe(value TEXT NOT NULL);
    `);
  } finally {
    scratch.close();
  }
  chmodSync(stagingPath, 0o600);

  crashAtJournalFault({
    fixture,
    action: "resume",
    point: "bootstrap_staging_unlinked",
  });
  assert.equal(existsSync(stagingPath), false);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  });
  assert.equal(classified.classification, "committed");
  assert.equal(classified.last_durable_phase, "committed");
  await resumeWithoutNewIdentity(fixture);
  assertGenesisState(fixture);
  assertNoSibling(fixture);
});

test("D3a.3a.1 scratch cleanup retains bootstrap mutex after closing SQLite", {
  timeout: 90_000,
}, async (t) => {
  const fixture = createFixture(t, "scratch-cleanup-exclusive-lock");
  await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x3a),
  }));
  const stagingPath = `${fixture.slotInspection.provisioning_journal_path}.bootstrap`;
  const scratch = new DatabaseSync(stagingPath);
  try {
    scratch.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE cleanup_lock_probe(value TEXT NOT NULL);
    `);
  } finally {
    scratch.close();
  }
  chmodSync(stagingPath, 0o600);

  const readyPath = join(fixture.directory, "scratch-cleanup-lock-held.json");
  const holder = startHoldingRecovery({
    fixture,
    action: "resume",
    target: "bootstrap_scratch_cleanup_locked",
    holdReadyPath: readyPath,
  });
  t.after(async () => {
    if (holder.process.exitCode === null && holder.process.signalCode === null) {
      holder.process.kill("SIGKILL");
      await holder.exit.catch(() => undefined);
    }
  });
  await waitForPath(readyPath);
  assert.equal(existsSync(stagingPath), true);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  await assert.rejects(
    async () => await resumeWithoutNewIdentity(fixture),
    (error: unknown) => error instanceof LiteRuntimeDeploymentSlotAuthorityError
      && error.code
        === "lite_runtime_deployment_slot_authority_recovery_contended",
  );
  await killHoldingChild(holder);

  assert.equal(existsSync(stagingPath), true);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  await resumeWithoutNewIdentity(fixture);
  assert.equal(existsSync(stagingPath), false);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  assertGenesisState(fixture);
  assertNoSibling(fixture);
});

test("D3a.3a.1 receipt publication exposes only absent or complete finals across SIGKILL", {
  concurrency: 1,
}, async (t) => {
  for (const point of RECEIPT_CRASH_POINTS) {
    await t.test(point, async (pointTest) => {
      const fixture = createFixture(pointTest, `receipt-${point}`);
      crashAtJournalFault({ fixture, action: "provision", point });
      const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(classified.classification, "incomplete");
      assert.equal(classified.recovery_action, "resume");
      await resumeWithoutNewIdentity(fixture);
      assert.equal(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }).classification,
        "committed",
      );
      assert.deepEqual(
        readdirSync(fixture.slotInspection.provisioning_phase_directory_path)
          .sort(),
        ["0001.json", "0002.json", "0003.json", "0004.json", "0005.json", "0006.json"],
      );
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 linked terminal receipt publication remains non-terminal until cleanup", {
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  for (const point of LINKED_RECEIPT_CRASH_POINTS) {
    await t.test(`committed ${point} occurrence 6`, async (pointTest) => {
      const fixture = createFixture(pointTest, `linked-committed-${point}`);
      crashAtJournalFault({
        fixture,
        action: "provision",
        point,
        targetOccurrence: 6,
      });
      assertLinkedReceiptPublication(fixture, 6);

      const interrupted = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(interrupted.classification, "incomplete");
      assert.equal(interrupted.last_durable_phase, "initial_witness_ready");
      assert.equal(interrupted.recovery_action, "resume");

      await resumeWithoutNewIdentity(fixture);
      const recovered = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(recovered.classification, "committed");
      assert.equal(recovered.last_durable_phase, "committed");
      assert.equal(recovered.recovery_action, "none");
      assert.deepEqual(
        readdirSync(fixture.slotInspection.provisioning_phase_directory_path)
          .sort(),
        ["0001.json", "0002.json", "0003.json", "0004.json", "0005.json", "0006.json"],
      );
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }

  for (const point of LINKED_RECEIPT_CRASH_POINTS) {
    await t.test(`aborted ${point} occurrence 2`, async (pointTest) => {
      const fixture = createFixture(pointTest, `linked-aborted-${point}`);
      crashAtJournalFault({
        fixture,
        action: "provision",
        point: "bootstrap_staging_unlinked",
      });
      const durableIntent = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(durableIntent.classification, "incomplete");
      assert.equal(durableIntent.last_durable_phase, null);

      crashAtJournalFault({
        fixture,
        action: "abort",
        point,
        targetOccurrence: 2,
      });
      assertLinkedReceiptPublication(fixture, 2);

      const interrupted = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.notEqual(interrupted.classification, "aborted");
      assert.equal(interrupted.classification, "incomplete");
      assert.equal(interrupted.last_durable_phase, "intent_durable");
      assert.equal(interrupted.recovery_action, "resume");

      const recovered = abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(recovered.classification, "aborted");
      assert.equal(recovered.last_durable_phase, "aborted");
      assert.equal(recovered.recovery_action, "none");
      assert.deepEqual(
        readdirSync(fixture.slotInspection.provisioning_phase_directory_path)
          .sort(),
        ["0001.json", "0002.json"],
      );
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 abort discards a valid unpublished next-phase staging receipt", {
  concurrency: 1,
  timeout: 90_000,
}, async (t) => {
  const fixture = createFixture(t, "abort-unpublished-receipt");
  crashAtPhase({ fixture, action: "provision", phase: "intent_durable" });
  crashAtJournalFault({
    fixture,
    action: "resume",
    point: "receipt_staging_synced",
  });
  const beforeAbort = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  });
  assert.equal(beforeAbort.classification, "incomplete");
  assert.equal(beforeAbort.last_durable_phase, "intent_durable");
  const aborted = abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  });
  assert.equal(aborted.classification, "aborted");
  assert.equal(aborted.last_durable_phase, "aborted");
  assert.deepEqual(
    readdirSync(fixture.slotInspection.provisioning_phase_directory_path).sort(),
    ["0001.json", "0002.json"],
  );
  assertNoSibling(fixture);
});

test("D3a.3a.1 abort cleans independent bootstrap scratch before tombstoning", async (t) => {
  const fixture = createFixture(t, "abort-bootstrap-scratch");
  crashAtPhase({ fixture, action: "provision", phase: "intent_durable" });
  const stagingPath = `${fixture.slotInspection.provisioning_journal_path}.bootstrap`;
  const scratch = new DatabaseSync(stagingPath);
  try {
    scratch.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE abort_scratch_probe(value TEXT NOT NULL);
    `);
  } finally {
    scratch.close();
  }
  chmodSync(stagingPath, 0o600);
  const aborted = abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  });
  assert.equal(aborted.classification, "aborted");
  assert.equal(aborted.last_durable_phase, "aborted");
  assert.equal(aborted.recovery_action, "none");
  assert.equal(existsSync(stagingPath), false);
  assert.equal(existsSync(`${stagingPath}-journal`), false);
  assertNoSibling(fixture);
});

test("D3a.3a.1 every provisioning durable phase survives real SIGKILL", {
  concurrency: 1,
  timeout: 600_000,
}, async (t) => {
  for (const phase of CRASH_PHASES) {
    await t.test(phase, async (phaseTest) => {
      const fixture = createFixture(phaseTest, `provision-${phase}`);
      crashAtPhase({ fixture, action: "provision", phase });
      const classified = await Promise.resolve(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      );
      assert.equal(
        classified.classification,
        phase === "committed" ? "committed" : "incomplete",
      );
      assert.equal(classified.last_durable_phase, phase);
      assert.equal(
        classified.recovery_action,
        phase === "committed" ? "none" : "resume",
      );
      assert.equal(
        classified.provisioning_journal_path,
        fixture.slotInspection.provisioning_journal_path,
      );
      assert.equal(
        classified.provisioning_phase_directory_path,
        fixture.slotInspection.provisioning_phase_directory_path,
      );
      assertNoSibling(fixture);

      const recovered = await resumeWithoutNewIdentity(fixture);
      const committed = await Promise.resolve(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      );
      assert.equal(committed.classification, "committed");
      assert.equal(committed.last_durable_phase, "committed");
      assert.equal(committed.recovery_action, "none");
      assert.deepEqual(committed.provisioning_inspection, recovered);
      const beforeReplay = committedSemanticSnapshot(fixture);
      const exactReplay = await resumeWithoutNewIdentity(fixture);
      assert.deepEqual(exactReplay, recovered);
      assert.deepEqual(committedSemanticSnapshot(fixture), beforeReplay);
      assertNoSibling(fixture);
      await assertFirstLeaseAndGeneration(fixture, phase);
    });
  }
});

test("D3a.3a.1 recovery is itself restartable after SIGKILL at every later phase", {
  concurrency: 1,
  timeout: 600_000,
}, async (t) => {
  for (const phase of CRASH_PHASES.slice(1)) {
    await t.test(phase, async (phaseTest) => {
      const fixture = createFixture(phaseTest, `resume-${phase}`);
      crashAtPhase({
        fixture,
        action: "provision",
        phase: "intent_durable",
      });
      crashAtPhase({ fixture, action: "resume", phase });
      const classified = await Promise.resolve(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      );
      assert.equal(
        classified.classification,
        phase === "committed" ? "committed" : "incomplete",
      );
      assert.equal(classified.last_durable_phase, phase);
      assert.equal(
        classified.recovery_action,
        phase === "committed" ? "none" : "resume",
      );
      const recovered = await resumeWithoutNewIdentity(fixture);
      const exactReplay = await resumeWithoutNewIdentity(fixture);
      assert.deepEqual(exactReplay, recovered);
      assertNoSibling(fixture);
      await assertFirstLeaseAndGeneration(fixture, `resume-${phase}`);
    });
  }
});

test("D3a.3a.1 an early recovery lock excludes another process and survives holder SIGKILL", {
  concurrency: 1,
  timeout: 90_000,
}, async (t) => {
  const fixture = createFixture(t, "concurrent-recovery");
  crashAtPhase({
    fixture,
    action: "provision",
    phase: "intent_durable",
  });
  const readyPath = join(fixture.directory, "recovery-lock-held.json");
  const holder = startHoldingRecovery({
    fixture,
    action: "resume",
    target: "pair_inodes_durable",
    holdReadyPath: readyPath,
  });
  t.after(async () => {
    if (holder.process.exitCode === null && holder.process.signalCode === null) {
      holder.process.kill("SIGKILL");
      await holder.exit.catch(() => undefined);
    }
  });
  await waitForPath(readyPath);
  const pairBeforeContention = pairPhysicalSnapshot(fixture);
  await assert.rejects(
    async () => await resumeWithoutNewIdentity(fixture),
    /busy|lock|recover|exclusive/iu,
  );
  assert.deepEqual(pairPhysicalSnapshot(fixture), pairBeforeContention);
  assertNoSibling(fixture);
  await killHoldingChild(holder);

  await resumeWithoutNewIdentity(fixture);
  assertNoSibling(fixture);
  await assertFirstLeaseAndGeneration(fixture, "concurrent-recovery");
});

test("D3a.3a.1 lost journal savepoint blocks every authority mutation", {
  concurrency: 1,
  timeout: 600_000,
}, async (t) => {
  const mutations = [
    ["create_lease_carrier_inode", "intent_durable"],
    ["create_durable_state_inode", "intent_durable"],
    ["initialize_lease_carrier", "pair_inodes_durable"],
    ["initialize_durable_state", "carrier_ready"],
    ["ensure_initial_carrier_witness", "state_ready"],
  ] as const satisfies readonly (readonly [
    LiteRuntimeDeploymentSlotProvisioningPhysicalMutation,
    LiteRuntimeDeploymentSlotProvisioningDurablePhase,
  ])[];

  for (const [mutation, expectedLastPhase] of mutations) {
    await t.test(mutation, async (mutationTest) => {
      const fixture = createFixture(mutationTest, `lost-savepoint-${mutation}`);
      let beforeMutation: unknown = null;
      let hitCount = 0;
      let disposeObserver: () => void = () => undefined;
      disposeObserver =
        installLiteRuntimeDeploymentSlotProvisioningPhysicalMutationObserverForTesting(
          (observedMutation) => {
            if (observedMutation !== mutation) return;
            hitCount += 1;
            beforeMutation = slotTreeSnapshot(
              fixture.slotInspection.slot_directory_path,
            );
            disposeObserver();
            return "invalidate_journal_savepoint";
          },
        );
      try {
        let randomCall = 0;
        await assert.rejects(
          async () => await Promise.resolve(
            provisionLiteRuntimeDeploymentSlotAuthority({
              slotPath: fixture.slotPath,
              runtimeDatabasePin: fixture.runtimeDatabasePin,
              now: PROVISIONING_TIME,
              randomBytesFactory: (size) => {
                randomCall += 1;
                return Buffer.alloc(size, 0x20 + randomCall);
              },
            }),
          ),
          (error: unknown) => error instanceof LiteRuntimeDeploymentSlotAuthorityError
            && error.code
              === "lite_runtime_deployment_slot_authority_recovery_contended",
        );
      } finally {
        disposeObserver();
      }
      assert.equal(hitCount, 1);
      assert.ok(beforeMutation);
      assert.deepEqual(
        slotTreeSnapshot(fixture.slotInspection.slot_directory_path),
        beforeMutation,
      );
      const interrupted = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      });
      assert.equal(interrupted.classification, "incomplete");
      assert.equal(interrupted.last_durable_phase, expectedLastPhase);
      assert.equal(interrupted.recovery_action, "resume");
      await resumeWithoutNewIdentity(fixture);
      assert.equal(
        classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }).classification,
        "committed",
      );
      assertGenesisState(fixture);
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 abort is durable, non-deleting, and blocks current-lineage reuse", {
  concurrency: 1,
  timeout: 60_000,
}, async (t) => {
  const fixture = createFixture(t, "abort-tombstone");
  crashAtPhase({
    fixture,
    action: "provision",
    phase: "pair_inodes_durable",
  });
  const pairBeforeAbort = pairPhysicalSnapshot(fixture);
  crashAtPhase({ fixture, action: "abort", phase: "aborted" });
  const classified = await Promise.resolve(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }),
  );
  assert.equal(classified.classification, "aborted");
  assert.equal(classified.last_durable_phase, "aborted");
  assert.equal(classified.recovery_action, "none");
  assert.deepEqual(pairPhysicalSnapshot(fixture), pairBeforeAbort);
  assertNoSibling(fixture);

  await Promise.resolve(abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  }));
  assert.deepEqual(pairPhysicalSnapshot(fixture), pairBeforeAbort);
  await assert.rejects(
    async () => await resumeWithoutNewIdentity(fixture),
    /abort|tombstone|reuse|provision|recovery/iu,
  );
  await assert.rejects(
    async () => await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
      slotPath: fixture.slotPath,
      runtimeDatabasePin: fixture.runtimeDatabasePin,
      now: PROVISIONING_TIME,
    })),
    /abort|tombstone|reuse|provision|exists|recovery/iu,
  );
  assert.deepEqual(pairPhysicalSnapshot(fixture), pairBeforeAbort);
  assertNoSibling(fixture);
});

test("D3a.3a.1 committed recovery never deletes or rewinds burned generations", {
  concurrency: 1,
  timeout: 60_000,
}, async (t) => {
  const fixture = createFixture(t, "committed-generation-preservation");
  let randomCall = 0;
  const provisioned = await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => {
      randomCall += 1;
      return Buffer.alloc(size, 0x50 + randomCall);
    },
  }));
  const firstLease = await Promise.resolve(acquireLiteRuntimeDeploymentSlotExclusiveLease({
    slotPath: fixture.slotPath,
    now: ACQUIRE_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x61),
  }));
  const firstOperationId = "recovery-preserved-burn-1";
  const firstReservation = await Promise.resolve(
    reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
      lease: firstLease,
      operationId: firstOperationId,
      operationRequestSha256: sha256(`request:${firstOperationId}`),
      now: ACQUIRE_TIME,
      randomBytesFactory: (size) => Buffer.alloc(size, 0x62),
    }),
  );
  assert.equal(firstReservation.kind, "reserved");
  if (firstReservation.kind !== "reserved") throw new Error("expected generation 1");
  assert.equal(
    inspectLiteRuntimeDeploymentSlotCheckpointGeneration(firstReservation.reservation)
      .checkpoint_generation,
    "1",
  );
  await releaseLiteRuntimeDeploymentSlotExclusiveLease(firstLease, {
    now: RELEASE_TIME,
  });

  const beforeRecovery = committedSemanticSnapshot(fixture);
  const replay = await resumeWithoutNewIdentity(fixture);
  assert.deepEqual(replay, provisioned);
  assert.deepEqual(committedSemanticSnapshot(fixture), beforeRecovery);
  await assert.rejects(
    async () => await Promise.resolve(
      abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      }),
    ),
    /commit|complete|abort|authority/iu,
  );
  assert.deepEqual(committedSemanticSnapshot(fixture), beforeRecovery);

  const secondLease = await Promise.resolve(acquireLiteRuntimeDeploymentSlotExclusiveLease({
    slotPath: fixture.slotPath,
    now: new Date("2026-07-18T08:02:00.000Z"),
    randomBytesFactory: (size) => Buffer.alloc(size, 0x63),
  }));
  await assert.rejects(
    async () => await Promise.resolve(
      reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
        lease: secondLease,
        operationId: firstOperationId,
        operationRequestSha256: sha256(`request:${firstOperationId}`),
        now: new Date("2026-07-18T08:02:00.000Z"),
      }),
    ),
    /burn|consum|reservation|operation/iu,
  );
  const secondOperationId = "recovery-preserved-generation-2";
  const secondReservation = await Promise.resolve(
    reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
      lease: secondLease,
      operationId: secondOperationId,
      operationRequestSha256: sha256(`request:${secondOperationId}`),
      now: new Date("2026-07-18T08:02:00.000Z"),
      randomBytesFactory: (size) => Buffer.alloc(size, 0x64),
    }),
  );
  assert.equal(secondReservation.kind, "reserved");
  if (secondReservation.kind !== "reserved") throw new Error("expected generation 2");
  assert.equal(
    inspectLiteRuntimeDeploymentSlotCheckpointGeneration(secondReservation.reservation)
      .checkpoint_generation,
    "2",
  );
  await releaseLiteRuntimeDeploymentSlotExclusiveLease(secondLease, {
    now: new Date("2026-07-18T08:03:00.000Z"),
  });
  assertNoSibling(fixture);
});

test("D3a.3a.1 absent slots remain unmodified and require provisioning", async (t) => {
  const fixture = createFixture(t, "absent-classification");
  const classified = await Promise.resolve(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }),
  );
  assert.equal(classified.classification, "absent");
  assert.equal(classified.last_durable_phase, null);
  assert.equal(classified.recovery_action, "provision");
  assert.equal(classified.provisioning_intent_sha256, null);
  assert.equal(existsSync(fixture.slotInspection.slot_directory_path), false);
});

test("D3a.3a.1 Runtime pin cannot alias bootstrap scratch or mutex namespaces", {
  concurrency: 1,
}, async (t) => {
  for (const suffix of [".bootstrap", ".bootstrap-lock"] as const) {
    await t.test(suffix, async (namespaceTest) => {
      const fixture = createFixture(namespaceTest, `runtime-alias-${suffix.slice(1)}`);
      prepareLiteRuntimeDeploymentSlotPathForProvisioning(fixture.slotPath);
      const aliasedRuntimePath =
        `${fixture.slotInspection.provisioning_journal_path}${suffix}`;
      initializeRuntimeDatabase(
        aliasedRuntimePath,
        `runtime-alias:${suffix}`,
      );
      const aliasedRuntimePin = pinLiteRuntimeProtectedAuthorityDatabase(
        aliasedRuntimePath,
      );
      try {
        const before = slotTreeSnapshot(
          fixture.slotInspection.slot_directory_path,
        );
        for (const operation of [
          () => provisionLiteRuntimeDeploymentSlotAuthority({
            slotPath: fixture.slotPath,
            runtimeDatabasePin: aliasedRuntimePin,
            now: PROVISIONING_TIME,
          }),
          () => resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
            slotPath: fixture.slotPath,
            runtimeDatabasePin: aliasedRuntimePin,
            now: PROVISIONING_TIME,
          }),
        ]) {
          await assert.rejects(
            async () => await Promise.resolve(operation()),
            (error: unknown) => error instanceof LiteRuntimeDeploymentSlotAuthorityError
              && error.code
                === "lite_runtime_deployment_slot_authority_path_conflict",
          );
          assert.deepEqual(
            slotTreeSnapshot(fixture.slotInspection.slot_directory_path),
            before,
          );
        }
      } finally {
        closeLiteRuntimeProtectedAuthorityDatabasePin(aliasedRuntimePin);
      }
      assertNoSibling(fixture);
    });
  }
});

test("D3a.3a.1 committed replay still requires the exact live Runtime pin", async (t) => {
  const fixture = createFixture(t, "committed-runtime-pin");
  await Promise.resolve(provisionLiteRuntimeDeploymentSlotAuthority({
    slotPath: fixture.slotPath,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: PROVISIONING_TIME,
    randomBytesFactory: (size) => Buffer.alloc(size, 0x58),
  }));
  const before = committedSemanticSnapshot(fixture);

  const wrongRuntimePath = join(fixture.directory, "wrong-runtime.sqlite");
  initializeRuntimeDatabase(wrongRuntimePath, "wrong-committed-runtime-pin");
  const wrongRuntimePin = pinLiteRuntimeProtectedAuthorityDatabase(wrongRuntimePath);
  try {
    await assert.rejects(
      async () => await Promise.resolve(
        resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
          runtimeDatabasePin: wrongRuntimePin,
          now: PROVISIONING_TIME,
        }),
      ),
      /Runtime|database|pin|identity|mismatch/iu,
    );
  } finally {
    closeLiteRuntimeProtectedAuthorityDatabasePin(wrongRuntimePin);
  }
  assert.deepEqual(committedSemanticSnapshot(fixture), before);

  closeLiteRuntimeProtectedAuthorityDatabasePin(fixture.runtimeDatabasePin);
  await assert.rejects(
    async () => await Promise.resolve(
      resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
        runtimeDatabasePin: fixture.runtimeDatabasePin,
        now: PROVISIONING_TIME,
      }),
    ),
    /closed|pin|database|Runtime|identity/iu,
  );
  assert.deepEqual(committedSemanticSnapshot(fixture), before);
  assertNoSibling(fixture);
});

test("D3a.3a.1 journal and authority identity tampering are zero-mutation manual cases", {
  concurrency: 1,
  timeout: 90_000,
}, async (t) => {
  await t.test("hard-linked provisioning journal", async (tamperTest) => {
    const fixture = createFixture(tamperTest, "journal-hardlink");
    crashAtPhase({
      fixture,
      action: "provision",
      phase: "intent_durable",
    });
    const journal = fixture.slotInspection.provisioning_journal_path;
    const alias = `${journal}.hardlink`;
    linkSync(journal, alias);
    const journalBefore = fileIdentity(journal);
    const aliasBefore = fileIdentity(alias);
    const classified = await Promise.resolve(
      classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      }),
    );
    assert.equal(classified.classification, "ambiguous_or_corrupt");
    assert.equal(classified.recovery_action, "manual_intervention");
    assert.deepEqual(fileIdentity(journal), journalBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    await assert.rejects(
      async () => await resumeWithoutNewIdentity(fixture),
      /ambiguous|corrupt|hard.?link|manual|journal|identity|untrusted|recovery/iu,
    );
    await assert.rejects(
      async () => await Promise.resolve(
        abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      ),
      /ambiguous|corrupt|hard.?link|manual|journal|identity|untrusted|recovery/iu,
    );
    assert.deepEqual(fileIdentity(journal), journalBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    assertNoSibling(fixture);
  });

  await t.test("hard-linked state identity", async (tamperTest) => {
    const fixture = createFixture(tamperTest, "state-hardlink");
    crashAtPhase({
      fixture,
      action: "provision",
      phase: "state_ready",
    });
    const statePath = fixture.slotInspection.authority_state_path;
    const alias = `${statePath}.hardlink`;
    linkSync(statePath, alias);
    const stateBefore = fileIdentity(statePath);
    const aliasBefore = fileIdentity(alias);
    const carrierBefore = fileIdentity(fixture.slotInspection.lease_carrier_path);
    const classified = await Promise.resolve(
      classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      }),
    );
    assert.equal(classified.classification, "ambiguous_or_corrupt");
    assert.equal(classified.recovery_action, "manual_intervention");
    assert.deepEqual(fileIdentity(statePath), stateBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    assert.deepEqual(
      fileIdentity(fixture.slotInspection.lease_carrier_path),
      carrierBefore,
    );
    await assert.rejects(
      async () => await resumeWithoutNewIdentity(fixture),
      /ambiguous|corrupt|hard.?link|manual|state|identity|untrusted|recovery/iu,
    );
    await assert.rejects(
      async () => await Promise.resolve(
        abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      ),
      /ambiguous|corrupt|hard.?link|manual|state|identity|untrusted|recovery/iu,
    );
    assert.deepEqual(fileIdentity(statePath), stateBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    assert.deepEqual(
      fileIdentity(fixture.slotInspection.lease_carrier_path),
      carrierBefore,
    );
    assertNoSibling(fixture);
  });

  await t.test("hard-linked last durable phase receipt", async (tamperTest) => {
    const fixture = createFixture(tamperTest, "receipt-hardlink");
    crashAtPhase({
      fixture,
      action: "provision",
      phase: "carrier_ready",
    });
    const phaseDirectory = fixture.slotInspection.provisioning_phase_directory_path;
    const receipts = readdirSync(phaseDirectory)
      .map((name) => join(phaseDirectory, name))
      .filter((path) => lstatSync(path).isFile())
      .sort();
    assert.ok(receipts.length >= 1);
    const lastReceipt = receipts.at(-1)!;
    const alias = `${lastReceipt}.hardlink`;
    linkSync(lastReceipt, alias);
    const receiptBefore = fileIdentity(lastReceipt);
    const aliasBefore = fileIdentity(alias);
    const classified = await Promise.resolve(
      classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
        slotPath: fixture.slotPath,
      }),
    );
    assert.equal(classified.classification, "ambiguous_or_corrupt");
    assert.equal(classified.recovery_action, "manual_intervention");
    assert.deepEqual(fileIdentity(lastReceipt), receiptBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    await assert.rejects(
      async () => await resumeWithoutNewIdentity(fixture),
      /ambiguous|corrupt|hard.?link|manual|receipt|phase|untrusted|recovery/iu,
    );
    await assert.rejects(
      async () => await Promise.resolve(
        abortLiteRuntimeDeploymentSlotAuthorityProvisioning({
          slotPath: fixture.slotPath,
        }),
      ),
      /ambiguous|corrupt|hard.?link|manual|receipt|phase|untrusted|recovery/iu,
    );
    assert.deepEqual(fileIdentity(lastReceipt), receiptBefore);
    assert.deepEqual(fileIdentity(alias), aliasBefore);
    assertNoSibling(fixture);
  });
});
