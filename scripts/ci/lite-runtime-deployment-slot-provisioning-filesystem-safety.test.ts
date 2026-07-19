import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  migrateLiteRuntimeAuthorityIdentity,
} from "../../src/store/lite-learning-episode-ledger.js";
import {
  classifyLiteRuntimeDeploymentSlotAuthorityProvisioning,
  installLiteRuntimeDeploymentSlotProvisioningObserverForTesting,
  provisionLiteRuntimeDeploymentSlotAuthority,
  resumeLiteRuntimeDeploymentSlotAuthorityProvisioning,
  type LiteRuntimeDeploymentSlotProvisioningDurablePhase,
} from "../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-authority.js";
import {
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  inspectLiteRuntimeDeploymentSlotPathCapability,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
  provisionLiteRuntimeDeploymentSlotPathAuthorityRoot,
  type LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
  type LiteRuntimeDeploymentSlotPathCapability,
  type LiteRuntimeDeploymentSlotPathInspection,
} from "../../tools/runtime-deployment-authority/lite-runtime-deployment-slot-path-authority.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  pinLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "../../packages/aionis-learning-authority/src/store/lite-runtime-protected-authority-database.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECOVERY_CHILD = fileURLToPath(new URL(
  "./support/lite-runtime-deployment-slot-provisioning-recovery-child.ts",
  import.meta.url,
));
const DEPLOYMENT_SLOT = "filesystem-safety-runtime-primary";
const PROVISIONING_TIME = new Date("2026-07-18T04:00:00.000Z");

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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture(t: TestContext, label: string): Fixture {
  const directory = realpathSync(mkdtempSync(join(
    realpathSync(homedir()),
    `aionis-slot-filesystem-${label}-`,
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
  const databaseInstanceId = sha256(`filesystem-runtime-database:${label}`);
  const database = new DatabaseSync(runtimeDatabasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE runtime_filesystem_probe (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value TEXT NOT NULL
      );
      INSERT INTO runtime_filesystem_probe(singleton, value)
      VALUES (1, 'protected-sidecar-boundary');
    `);
    migrateLiteRuntimeAuthorityIdentity(database, {
      now: new Date("2026-07-18T03:59:00.000Z"),
      randomBytesFactory: () => Buffer.from(databaseInstanceId, "hex"),
    });
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  chmodSync(runtimeDatabasePath, 0o600);
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

function crashProvisionAt(
  fixture: Fixture,
  phase: LiteRuntimeDeploymentSlotProvisioningDurablePhase,
): void {
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    RECOVERY_CHILD,
    fixture.rootPath,
    fixture.rootManifestSha256,
    DEPLOYMENT_SLOT,
    fixture.runtimeDatabasePath,
    "provision",
    "kill",
    phase,
    "",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, null, child.stderr || child.stdout);
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
}

function artifactSnapshot(path: string): Readonly<Record<string, unknown>> {
  const stat = lstatSync(path, { bigint: true });
  return Object.freeze({
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    links: stat.nlink.toString(10),
    mode: (stat.mode & 0o7777n).toString(8),
    size: stat.size.toString(10),
    kind: stat.isFile()
      ? "file"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isFIFO()
          ? "fifo"
          : "other",
    bytes_sha256: stat.isFile() ? sha256(readFileSync(path)) : null,
    symlink_target: stat.isSymbolicLink() ? readlinkSync(path) : null,
  });
}

function snapshots(paths: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    paths.map((path) => [path, artifactSnapshot(path)]),
  ));
}

function assertManualRecoveryWithoutMutation(
  fixture: Fixture,
  trackedPaths: readonly string[],
): void {
  const before = snapshots(trackedPaths);
  const classified = classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
    slotPath: fixture.slotPath,
  });
  assert.equal(classified.classification, "ambiguous_or_corrupt");
  assert.equal(classified.recovery_action, "manual_intervention");
  assert.deepEqual(snapshots(trackedPaths), before);
  assert.throws(
    () => resumeLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
      runtimeDatabasePin: fixture.runtimeDatabasePin,
      now: PROVISIONING_TIME,
    }),
    /ambiguous|corrupt|integrity|manual|recover|sidecar|untrusted/iu,
  );
  assert.deepEqual(snapshots(trackedPaths), before);
}

test("authority pair creation overrides a restrictive umask before its durable receipt", {
  concurrency: 1,
}, (t) => {
  const fixture = createFixture(t, "restrictive-umask");
  let pairModes: Readonly<{ carrier: bigint; state: bigint }> | null = null;
  let previousUmask: number | null = null;
  const disposeObserver =
    installLiteRuntimeDeploymentSlotProvisioningObserverForTesting((phase) => {
      if (phase === "intent_durable" && previousUmask === null) {
        previousUmask = process.umask(0o200);
        return;
      }
      if (phase !== "pair_inodes_durable") return;
      pairModes = Object.freeze({
        carrier: lstatSync(
          fixture.slotInspection.lease_carrier_path,
          { bigint: true },
        ).mode & 0o7777n,
        state: lstatSync(
          fixture.slotInspection.authority_state_path,
          { bigint: true },
        ).mode & 0o7777n,
      });
      if (previousUmask !== null) {
        process.umask(previousUmask);
        previousUmask = null;
      }
    });
  try {
    provisionLiteRuntimeDeploymentSlotAuthority({
      slotPath: fixture.slotPath,
      runtimeDatabasePin: fixture.runtimeDatabasePin,
      now: PROVISIONING_TIME,
      randomBytesFactory: (size) => Buffer.alloc(size, 0x51),
    });
  } finally {
    if (previousUmask !== null) process.umask(previousUmask);
    disposeObserver();
  }
  assert.deepEqual(pairModes, { carrier: 0o600n, state: 0o600n });
  assert.equal(
    lstatSync(fixture.slotInspection.lease_carrier_path, { bigint: true }).mode
      & 0o7777n,
    0o600n,
  );
  assert.equal(
    lstatSync(fixture.slotInspection.authority_state_path, { bigint: true }).mode
      & 0o7777n,
    0o600n,
  );
  assert.equal(
    classifyLiteRuntimeDeploymentSlotAuthorityProvisioning({
      slotPath: fixture.slotPath,
    }).classification,
    "committed",
  );
});

test("orphan WAL and SHM fail closed while the authority main file is absent", {
  concurrency: 1,
  timeout: 60_000,
}, async (t) => {
  for (const suffix of ["-wal", "-shm"] as const) {
    await t.test(suffix, (orphanTest) => {
      const fixture = createFixture(orphanTest, `orphan${suffix}`);
      crashProvisionAt(fixture, "intent_durable");
      const main = fixture.slotInspection.authority_state_path;
      assert.equal(existsSync(main), false);
      const orphan = `${main}${suffix}`;
      writeFileSync(orphan, `orphan:${suffix}`, { flag: "wx", mode: 0o600 });
      chmodSync(orphan, 0o600);
      assertManualRecoveryWithoutMutation(fixture, [orphan]);
      assert.equal(existsSync(main), false);
    });
  }
});

test("protected recovery rejects malicious authority sidecars before SQLite opens", {
  concurrency: 1,
  timeout: 120_000,
  skip: process.platform === "win32",
}, async (t) => {
  for (const kind of [
    "hardlink",
    "symlink",
    "fifo",
    "lone-wal",
    "lone-shm",
  ] as const) {
    await t.test(kind, (sidecarTest) => {
      const fixture = createFixture(sidecarTest, `sidecar-${kind}`);
      crashProvisionAt(fixture, "pair_inodes_durable");
      const state = fixture.slotInspection.authority_state_path;
      const carrier = fixture.slotInspection.lease_carrier_path;
      const wal = `${state}-wal`;
      const shm = `${state}-shm`;
      const tracked = [state, carrier];

      if (kind === "hardlink") {
        const source = join(fixture.directory, "attacker-wal-source");
        writeFileSync(source, "attacker-hardlink-wal", { flag: "wx", mode: 0o600 });
        chmodSync(source, 0o600);
        linkSync(source, wal);
        writeFileSync(shm, "paired-shm", { flag: "wx", mode: 0o600 });
        chmodSync(shm, 0o600);
        tracked.push(source, wal, shm);
      } else if (kind === "symlink") {
        const target = join(fixture.directory, "attacker-wal-target");
        writeFileSync(target, "attacker-symlink-wal", { flag: "wx", mode: 0o600 });
        chmodSync(target, 0o600);
        symlinkSync(target, wal);
        writeFileSync(shm, "paired-shm", { flag: "wx", mode: 0o600 });
        chmodSync(shm, 0o600);
        tracked.push(target, wal, shm);
      } else if (kind === "fifo") {
        execFileSync("mkfifo", [wal]);
        chmodSync(wal, 0o600);
        writeFileSync(shm, "paired-shm", { flag: "wx", mode: 0o600 });
        chmodSync(shm, 0o600);
        tracked.push(wal, shm);
      } else if (kind === "lone-wal") {
        writeFileSync(wal, "lone-wal", { flag: "wx", mode: 0o600 });
        chmodSync(wal, 0o600);
        tracked.push(wal);
      } else {
        writeFileSync(shm, "lone-shm", { flag: "wx", mode: 0o600 });
        chmodSync(shm, 0o600);
        tracked.push(shm);
      }

      assertManualRecoveryWithoutMutation(fixture, tracked);
    });
  }
});
