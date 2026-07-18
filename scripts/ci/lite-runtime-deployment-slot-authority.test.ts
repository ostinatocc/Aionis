import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import stableStringify from "fast-json-stable-stringify";

import {
  learningExternalEd25519PublicKeyDigest,
} from "../../src/memory/learning-external-authority.js";
import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "../../src/memory/learning-episode-ledger.js";
import {
  LearningRuntimeDatabaseBindingReceiptBodyV1Schema,
  LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema,
  learningRuntimeDatabaseBindingReceiptDigest,
  type LearningRuntimeDatabaseBindingReceiptBodyV1,
  type LearningRuntimeDatabaseBindingReceiptEnvelopeV1,
} from "../../src/memory/learning-runtime-database-binding.js";
import {
  migrateLiteRuntimeAuthorityIdentity,
} from "../../src/store/lite-learning-episode-ledger.js";
import {
  closeLiteRuntimeProtectedAuthorityDatabasePin,
  pinLiteRuntimeProtectedAuthorityDatabase,
  type LiteRuntimeProtectedAuthorityDatabasePin,
} from "../../src/store/lite-runtime-protected-authority-database.js";
import {
  acquireLiteRuntimeDeploymentSlotExclusiveLease as acquireLiteRuntimeDeploymentSlotExclusiveLeaseRaw,
  assertLiteRuntimeDeploymentSlotExclusiveLease,
  commitLiteRuntimeDeploymentSlotBindingCompletion,
  inspectLiteRuntimeDeploymentSlotCheckpointGeneration,
  inspectLiteRuntimeDeploymentSlotExclusiveLease,
  prepareLiteRuntimeDeploymentSlotBindingCompletion,
  provisionLiteRuntimeDeploymentSlotAuthority as provisionLiteRuntimeDeploymentSlotAuthorityRaw,
  releaseLiteRuntimeDeploymentSlotExclusiveLease as releaseLiteRuntimeDeploymentSlotExclusiveLeaseRaw,
  reserveLiteRuntimeDeploymentSlotCheckpointGeneration,
} from "../../src/store/lite-runtime-deployment-slot-authority.js";
import {
  closeLiteRuntimeDeploymentSlotPathAuthorityRoot,
  deriveLiteRuntimeDeploymentSlotPathCapability,
  inspectLiteRuntimeDeploymentSlotPathAuthorityRoot,
  inspectLiteRuntimeDeploymentSlotPathCapability,
  openLiteRuntimeDeploymentSlotPathAuthorityRoot,
  provisionLiteRuntimeDeploymentSlotPathAuthorityRoot,
  type LiteRuntimeDeploymentSlotPathAuthorityRootCapability,
  type LiteRuntimeDeploymentSlotPathCapability,
} from "../../src/store/lite-runtime-deployment-slot-path-authority.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LEASE_CHILD = fileURLToPath(
  new URL("./support/lite-runtime-deployment-slot-lease-child.ts", import.meta.url),
);
const DEPLOYMENT_SLOT = "acceptance-runtime-primary";
const DATABASE_INSTANCE_ID = sha256("d3a2-runtime-database-instance");
const MAX_U64_DECIMAL = "18446744073709551615";
const ACTIVE_CHILDREN = new Set<RunningChild>();
const DEFAULT_LEASE_ACQUIRED_AT = new Date("2026-07-17T08:00:00.000Z");
const DEFAULT_LEASE_RELEASED_AT = new Date("2026-07-17T08:00:00.000Z");
const SLOT_PATH_BY_AUTHORITY_STATE_PATH = new Map<
  string,
  LiteRuntimeDeploymentSlotPathCapability
>();

const LAUNCHER_KEYS = generateKeyPairSync("ed25519");
const ROTATED_LAUNCHER_KEYS = generateKeyPairSync("ed25519");
const ATTESTOR_KEYS = generateKeyPairSync("ed25519");
const BROKER_KEYS = generateKeyPairSync("ed25519");
const ATTACKER_KEYS = generateKeyPairSync("ed25519");

type LegacySlotPathArgs = Readonly<{
  authorityStatePath: string;
  deploymentSlot: string;
}>;

function resolveFixtureSlotPath(args: LegacySlotPathArgs) {
  const slotPath = SLOT_PATH_BY_AUTHORITY_STATE_PATH.get(args.authorityStatePath);
  if (!slotPath) {
    throw new Error(
      "launcher slot-path mapping mismatch: raw or redirected authority path is unavailable",
    );
  }
  const inspection = inspectLiteRuntimeDeploymentSlotPathCapability(slotPath);
  if (inspection.deployment_slot !== args.deploymentSlot) {
    throw new Error(
      "launcher slot-path mapping mismatch: deployment slot is bound by the opaque capability",
    );
  }
  return slotPath;
}

function acquireLiteRuntimeDeploymentSlotExclusiveLease(
  args: Omit<
    Parameters<typeof acquireLiteRuntimeDeploymentSlotExclusiveLeaseRaw>[0],
    "slotPath"
  > & LegacySlotPathArgs,
) {
  const { authorityStatePath, deploymentSlot, ...options } = args;
  return acquireLiteRuntimeDeploymentSlotExclusiveLeaseRaw({
    ...options,
    slotPath: resolveFixtureSlotPath({ authorityStatePath, deploymentSlot }),
    now: args.now ?? DEFAULT_LEASE_ACQUIRED_AT,
  });
}

function provisionLiteRuntimeDeploymentSlotAuthority(
  args: Omit<
    Parameters<typeof provisionLiteRuntimeDeploymentSlotAuthorityRaw>[0],
    "slotPath"
  > & LegacySlotPathArgs,
) {
  const { authorityStatePath, deploymentSlot, ...options } = args;
  return provisionLiteRuntimeDeploymentSlotAuthorityRaw({
    ...options,
    slotPath: resolveFixtureSlotPath({ authorityStatePath, deploymentSlot }),
  });
}

async function releaseLiteRuntimeDeploymentSlotExclusiveLease(
  capability: Parameters<
    typeof releaseLiteRuntimeDeploymentSlotExclusiveLeaseRaw
  >[0],
  options: Parameters<
    typeof releaseLiteRuntimeDeploymentSlotExclusiveLeaseRaw
  >[1] = {},
): Promise<void> {
  await releaseLiteRuntimeDeploymentSlotExclusiveLeaseRaw(capability, {
    ...options,
    now: options.now ?? DEFAULT_LEASE_RELEASED_AT,
  });
}

type Fixture = Readonly<{
  rootDirectory: string;
  rootPath: string;
  rootManifestSha256: string;
  rootCap: LiteRuntimeDeploymentSlotPathAuthorityRootCapability;
  slotPath: LiteRuntimeDeploymentSlotPathCapability;
  authorityStatePath: string;
  runtimeDatabasePath: string;
  databaseFileDevice: string;
  databaseFileInode: string;
  databaseMainFileByteLength: string;
  databaseMainFileSha256: string;
  runtimeDatabasePin: LiteRuntimeProtectedAuthorityDatabasePin;
}>;

type ChildMode =
  | "commit_and_hold"
  | "hold_carrier_transaction"
  | "hold_lease"
  | "hold_state_transaction"
  | "reserve_and_hold";

type ChildExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

type RunningChild = Readonly<{
  process: ChildProcess;
  leaseHeld: Promise<void>;
  generationReserved: Promise<Readonly<{
    operationId: string;
    checkpointGeneration: string;
  }>>;
  completionCommitted: Promise<Readonly<{
    checkpointGeneration: string;
    receiptSha256: string;
    receiptJson: string;
  }>>;
  carrierTransactionHeld: Promise<Readonly<{
    walByteLength: number;
  }>>;
  stateTransactionHeld: Promise<Readonly<{
    walByteLength: number;
  }>>;
  exit: Promise<ChildExit>;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlitePragmaScalar(
  database: DatabaseSync,
  name:
    | "application_id"
    | "journal_mode"
    | "journal_mode=DELETE"
    | "user_version",
): string | number {
  const row = database.prepare(`PRAGMA ${name}`).get() as
    Record<string, unknown> | undefined;
  assert.ok(row, `missing PRAGMA ${name}`);
  const values = Object.values(row);
  assert.equal(values.length, 1, `invalid PRAGMA ${name} row`);
  const value = values[0];
  assert.ok(
    typeof value === "string" || typeof value === "number",
    `invalid PRAGMA ${name} value`,
  );
  return value;
}

function checkpointStateAndReadMain(authorityStatePath: string): Buffer {
  const database = new DatabaseSync(authorityStatePath);
  try {
    assert.equal(sqlitePragmaScalar(database, "journal_mode"), "wal");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      Readonly<{ busy?: unknown; log?: unknown; checkpointed?: unknown }> | undefined;
    assert.equal(checkpoint?.busy, 0);
    assert.equal(checkpoint?.log, 0);
    assert.equal(checkpoint?.checkpointed, 0);
  } finally {
    database.close();
  }
  assert.equal(existsSync(`${authorityStatePath}-wal`), false);
  assert.equal(existsSync(`${authorityStatePath}-shm`), false);
  return readFileSync(authorityStatePath);
}

function rawEd25519PublicKeyBase64(publicKey: KeyObject): string {
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  assert.ok(spki.byteLength > 32);
  return spki.subarray(spki.byteLength - 32).toString("base64");
}

function createExternalExecutionPolicy(args: Readonly<{
  launcherPublicKey?: KeyObject;
  launcherKeyId?: string;
}> = {}): ExternalExecutionPolicyV1 {
  const launcherPublicKeyBase64 = rawEd25519PublicKeyBase64(
    args.launcherPublicKey ?? LAUNCHER_KEYS.publicKey,
  );
  const launcherPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    launcherPublicKeyBase64,
  );
  const attestorPublicKeyBase64 = rawEd25519PublicKeyBase64(ATTESTOR_KEYS.publicKey);
  const attestorPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    attestorPublicKeyBase64,
  );
  const brokerPublicKeyBase64 = rawEd25519PublicKeyBase64(BROKER_KEYS.publicKey);
  const brokerPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    brokerPublicKeyBase64,
  );
  const launcherKeyId = args.launcherKeyId ?? "launcher-key-1";
  const role = (
    roleName: "offline_paired" | "production_shadow" | "tool_e2e",
    credentialSessionClass:
      | "immutable_paired_eval"
      | "eligible_host_adapter"
      | "formal_tool_eval",
  ) => ({
    runner_principal_sha256: sha256(`runner-principal:${roleName}`),
    credential_session_class: credentialSessionClass,
    broker_policy_sha256: sha256(`broker-policy:${roleName}`),
    broker_binary_sha256: sha256(`broker-binary:${roleName}`),
    broker_public_key_base64: brokerPublicKeyBase64,
    broker_public_key_sha256: brokerPublicKeySha256,
    broker_key_id: `broker-key-${roleName}`,
    service_launcher_policy_sha256: sha256("launcher-policy"),
    service_launcher_binary_sha256: sha256("launcher-binary"),
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: launcherKeyId,
    supervisor_executable_sha256: sha256(`supervisor-executable:${roleName}`),
    supervisor_argv_policy_sha256: sha256(`supervisor-argv:${roleName}`),
    supervisor_sandbox_policy_sha256: sha256(`supervisor-sandbox:${roleName}`),
    receipt_signature_algorithm: "ed25519-v1" as const,
    credential_scope_sha256: sha256(`credential-scope:${roleName}`),
    supervisor_bind_ttl_seconds: 60,
    credential_session_hard_ttl_seconds: 120,
    credential_session_heartbeat_seconds: 10,
    credential_session_max_calls: 100,
    per_call_capability_ttl_seconds: 5,
    post_quiesce_finalize_ttl_seconds: 300,
  });
  return ExternalExecutionPolicyV1Schema.parse({
    policy_version: "external-execution-v1",
    runtime_authority_attestor: {
      service_identity: "runtime-authority-attestor",
      attestor_binary_sha256: sha256("attestor-binary"),
      attestor_policy_sha256: sha256("attestor-policy"),
      attestor_public_key_base64: attestorPublicKeyBase64,
      attestor_public_key_sha256: attestorPublicKeySha256,
      attestor_key_id: "attestor-key-1",
      service_launcher_policy_sha256: sha256("launcher-policy"),
      service_launcher_binary_sha256: sha256("launcher-binary"),
      service_launcher_public_key_base64: launcherPublicKeyBase64,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: launcherKeyId,
      receipt_signature_algorithm: "ed25519-v1",
      expected_database_instance_id: DATABASE_INSTANCE_ID,
    },
    roles: {
      offline_paired: role("offline_paired", "immutable_paired_eval"),
      production_shadow: role("production_shadow", "eligible_host_adapter"),
      tool_e2e: role("tool_e2e", "formal_tool_eval"),
    },
  });
}

const POLICY = createExternalExecutionPolicy();
const POLICY_SHA256 = externalExecutionPolicyDigest(POLICY);
const ROTATED_POLICY = createExternalExecutionPolicy({
  launcherPublicKey: ROTATED_LAUNCHER_KEYS.publicKey,
  launcherKeyId: "launcher-key-2",
});
const ROTATED_POLICY_SHA256 = externalExecutionPolicyDigest(ROTATED_POLICY);

function createFixture(label: string): Fixture {
  const rootDirectory = mkdtempSync(
    join(realpathSync(tmpdir()), `aionis-d3a3a-${label}-`),
  );
  chmodSync(rootDirectory, 0o700);
  const rootPath = join(rootDirectory, "launcher-authority");
  mkdirSync(rootPath, { mode: 0o700 });
  chmodSync(rootPath, 0o700);
  const provisionedRoot = provisionLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    now: new Date("2026-07-17T03:59:00.000Z"),
  });
  const rootCap = openLiteRuntimeDeploymentSlotPathAuthorityRoot({
    rootPath,
    expectedRootManifestSha256: provisionedRoot.root_manifest_sha256,
  });
  const rootInspection = inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(rootCap);
  const slotPath = deriveLiteRuntimeDeploymentSlotPathCapability(
    rootCap,
    DEPLOYMENT_SLOT,
  );
  const slotInspection = inspectLiteRuntimeDeploymentSlotPathCapability(slotPath);
  const authorityStatePath = slotInspection.authority_state_path;
  const runtimeDatabasePath = join(rootDirectory, "runtime.db");
  SLOT_PATH_BY_AUTHORITY_STATE_PATH.set(authorityStatePath, slotPath);
  const database = new DatabaseSync(runtimeDatabasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE runtime_probe (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value TEXT NOT NULL
      );
      INSERT INTO runtime_probe(singleton, value) VALUES (1, 'd3a2');
    `);
    migrateLiteRuntimeAuthorityIdentity(database, {
      now: new Date("2026-07-17T04:00:00.000Z"),
      randomBytesFactory: () => Buffer.from(DATABASE_INSTANCE_ID, "hex"),
    });
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  chmodSync(runtimeDatabasePath, 0o600);
  const stat = statSync(runtimeDatabasePath, { bigint: true });
  return {
    rootDirectory,
    rootPath,
    rootManifestSha256: rootInspection.root_manifest_sha256,
    rootCap,
    slotPath,
    authorityStatePath,
    runtimeDatabasePath,
    databaseFileDevice: stat.dev.toString(10),
    databaseFileInode: stat.ino.toString(10),
    databaseMainFileByteLength: stat.size.toString(10),
    databaseMainFileSha256: sha256(readFileSync(runtimeDatabasePath)),
    runtimeDatabasePin: pinLiteRuntimeProtectedAuthorityDatabase(runtimeDatabasePath),
  };
}

async function provisionFixture(
  fixture: Fixture,
  randomByte = 0x41,
) {
  let randomCall = 0;
  return await provisionLiteRuntimeDeploymentSlotAuthority({
    authorityStatePath: fixture.authorityStatePath,
    deploymentSlot: DEPLOYMENT_SLOT,
    runtimeDatabasePin: fixture.runtimeDatabasePin,
    now: new Date("2026-07-17T04:00:00.000Z"),
    randomBytesFactory: (size) => {
      randomCall += 1;
      return Buffer.alloc(size, (randomByte + randomCall) & 0xff);
    },
  });
}

function operationRequestSha256(operationId: string): string {
  return sha256(`deployment-slot-binding-operation:${operationId}`);
}

async function reserveGeneration(args: Readonly<{
  lease: Awaited<ReturnType<typeof acquireLiteRuntimeDeploymentSlotExclusiveLease>>;
  operationId: string;
}>) {
  const reservationSeed = Buffer.from(sha256(`reservation:${args.operationId}`), "hex");
  return await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
    lease: args.lease,
    operationId: args.operationId,
    operationRequestSha256: operationRequestSha256(args.operationId),
    now: new Date("2026-07-17T08:00:00.000Z"),
    randomBytesFactory: (size) => {
      assert.equal(size, reservationSeed.byteLength);
      return Buffer.from(reservationSeed);
    },
  });
}

async function reserveFresh(args: Readonly<{
  lease: Awaited<ReturnType<typeof acquireLiteRuntimeDeploymentSlotExclusiveLease>>;
  operationId: string;
}>) {
  const result = await reserveGeneration(args);
  assert.equal(result.kind, "reserved");
  if (result.kind !== "reserved") {
    throw new Error("expected fresh deployment-slot generation reservation");
  }
  return result.reservation;
}

async function completedReplay(args: Readonly<{
  lease: Awaited<ReturnType<typeof acquireLiteRuntimeDeploymentSlotExclusiveLease>>;
  operationId: string;
}>) {
  const result = await reserveGeneration(args);
  assert.equal(result.kind, "completed_replay");
  if (result.kind !== "completed_replay") {
    throw new Error("expected completed deployment-slot binding replay");
  }
  return result.completion;
}

function bindingBody(args: Readonly<{
  fixture: Fixture;
  policy: ExternalExecutionPolicyV1;
  checkpointGeneration: string;
  bindingChain: LearningRuntimeDatabaseBindingReceiptBodyV1["binding_chain"];
  issuedAt: string;
  overrides?: Partial<LearningRuntimeDatabaseBindingReceiptBodyV1>;
}>): LearningRuntimeDatabaseBindingReceiptBodyV1 {
  const expected = args.policy.runtime_authority_attestor;
  return LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
    contract_version: "aionis_learning_runtime_database_binding_receipt_body_v1",
    deployment_slot: DEPLOYMENT_SLOT,
    external_execution_policy_sha256: externalExecutionPolicyDigest(args.policy),
    database_instance_id: expected.expected_database_instance_id,
    database_file_device: args.fixture.databaseFileDevice,
    database_file_inode: args.fixture.databaseFileInode,
    checkpoint_generation: args.checkpointGeneration,
    database_main_file_byte_length: args.fixture.databaseMainFileByteLength,
    database_main_file_sha256: args.fixture.databaseMainFileSha256,
    wal_checkpoint_mode: "truncate",
    wal_checkpoint_busy: 0,
    wal_checkpoint_log_frame_count: 0,
    wal_checkpointed_frame_count: 0,
    wal_file_byte_length: "0",
    wal_checkpointed_and_truncated: true,
    writer_fence_inspection_sha256:
      sha256(`writer-fence:${args.checkpointGeneration}:${args.issuedAt}`),
    binding_chain: args.bindingChain,
    service_launcher_policy_sha256: expected.service_launcher_policy_sha256,
    service_launcher_binary_sha256: expected.service_launcher_binary_sha256,
    service_launcher_public_key_sha256: expected.service_launcher_public_key_sha256,
    service_launcher_key_id: expected.service_launcher_key_id,
    attestor_service_identity: expected.service_identity,
    attestor_binary_sha256: expected.attestor_binary_sha256,
    attestor_policy_sha256: expected.attestor_policy_sha256,
    attestor_public_key_sha256: expected.attestor_public_key_sha256,
    attestor_key_id: expected.attestor_key_id,
    issued_at: args.issuedAt,
    ...args.overrides,
  });
}

function signEnvelope(
  body: LearningRuntimeDatabaseBindingReceiptBodyV1,
  privateKey: KeyObject = LAUNCHER_KEYS.privateKey,
): LearningRuntimeDatabaseBindingReceiptEnvelopeV1 {
  return LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema.parse({
    body,
    signature_algorithm: "ed25519-v1",
    signature_base64: signMessage(
      null,
      Buffer.from(stableStringify(body), "utf8"),
      privateKey,
    ).toString("base64"),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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

function startLeaseChild(args: Readonly<{
  fixture: Fixture;
  mode: ChildMode;
  operationId?: string;
  completionConfigPath?: string;
}>): RunningChild {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    LEASE_CHILD,
    args.fixture.rootPath,
    args.fixture.rootManifestSha256,
    DEPLOYMENT_SLOT,
    args.mode,
    args.operationId ?? "",
    operationRequestSha256(args.operationId ?? "unused-child-operation"),
    args.completionConfigPath ?? "",
  ], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const leaseHeld = deferred<void>();
  const generationReserved = deferred<Readonly<{
    operationId: string;
    checkpointGeneration: string;
  }>>();
  const completionCommitted = deferred<Readonly<{
    checkpointGeneration: string;
    receiptSha256: string;
    receiptJson: string;
  }>>();
  const carrierTransactionHeld = deferred<Readonly<{
    walByteLength: number;
  }>>();
  const stateTransactionHeld = deferred<Readonly<{
    walByteLength: number;
  }>>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const typed = message as Readonly<Record<string, unknown>>;
    if (typed.type === "lease_held") leaseHeld.resolve();
    if (typed.type === "generation_reserved"
      && typeof typed.operationId === "string"
      && typeof typed.checkpointGeneration === "string") {
      generationReserved.resolve({
        operationId: typed.operationId,
        checkpointGeneration: typed.checkpointGeneration,
      });
    }
    if (typed.type === "completion_committed"
      && typeof typed.checkpointGeneration === "string"
      && typeof typed.receiptSha256 === "string"
      && typeof typed.receiptJson === "string") {
      completionCommitted.resolve({
        checkpointGeneration: typed.checkpointGeneration,
        receiptSha256: typed.receiptSha256,
        receiptJson: typed.receiptJson,
      });
    }
    if (typed.type === "state_transaction_held"
      && typeof typed.walByteLength === "number"
      && Number.isSafeInteger(typed.walByteLength)
      && typed.walByteLength >= 0) {
      stateTransactionHeld.resolve({ walByteLength: typed.walByteLength });
    }
    if (typed.type === "carrier_transaction_held"
      && typeof typed.walByteLength === "number"
      && Number.isSafeInteger(typed.walByteLength)
      && typed.walByteLength >= 0) {
      carrierTransactionHeld.resolve({ walByteLength: typed.walByteLength });
    }
    if (typed.type === "error") {
      const error = new Error(
        typeof typed.message === "string" ? typed.message : "deployment slot child failed",
      );
      leaseHeld.reject(error);
      generationReserved.reject(error);
      completionCommitted.reject(error);
      carrierTransactionHeld.reject(error);
      stateTransactionHeld.reject(error);
    }
  });
  const exit = new Promise<ChildExit>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      leaseHeld.reject(error);
      generationReserved.reject(error);
      completionCommitted.reject(error);
      carrierTransactionHeld.reject(error);
      stateTransactionHeld.reject(error);
      rejectExit(error);
    });
    child.once("close", (code, signal) => {
      resolveExit({ code, signal, stdout, stderr });
    });
  });
  const running = {
    process: child,
    leaseHeld: leaseHeld.promise,
    generationReserved: generationReserved.promise,
    completionCommitted: completionCommitted.promise,
    carrierTransactionHeld: carrierTransactionHeld.promise,
    stateTransactionHeld: stateTransactionHeld.promise,
    exit,
  };
  ACTIVE_CHILDREN.add(running);
  void exit.then(
    () => ACTIVE_CHILDREN.delete(running),
    () => ACTIVE_CHILDREN.delete(running),
  );
  return running;
}

async function killChild(child: RunningChild): Promise<ChildExit> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill("SIGKILL");
  }
  const exit = await within(child.exit, "deployment slot child SIGKILL exit");
  assert.equal(exit.code, null, exit.stderr);
  assert.equal(exit.signal, "SIGKILL", exit.stderr);
  return exit;
}

async function terminateActiveChildren(): Promise<void> {
  const active = [...ACTIVE_CHILDREN];
  for (const child of active) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill("SIGKILL");
    }
  }
  await Promise.all(active.map(async (child) => {
    await within(child.exit, "deployment slot child cleanup", 5_000).catch(() => undefined);
  }));
  ACTIVE_CHILDREN.clear();
}

function prepareCompletion(args: Readonly<{
  lease: Awaited<ReturnType<typeof acquireLiteRuntimeDeploymentSlotExclusiveLease>>;
  reservation: Awaited<ReturnType<
    typeof reserveLiteRuntimeDeploymentSlotCheckpointGeneration
  >>;
  envelope: LearningRuntimeDatabaseBindingReceiptEnvelopeV1;
  policy?: ExternalExecutionPolicyV1;
  policySha256?: string;
}>) {
  return prepareLiteRuntimeDeploymentSlotBindingCompletion({
    lease: args.lease,
    reservation: args.reservation,
    envelope: args.envelope,
    externalExecutionPolicy: args.policy ?? POLICY,
    registeredExternalExecutionPolicySha256: args.policySha256 ?? POLICY_SHA256,
  });
}

async function commitCompletion(args: Readonly<{
  lease: Awaited<ReturnType<typeof acquireLiteRuntimeDeploymentSlotExclusiveLease>>;
  reservation: Awaited<ReturnType<
    typeof reserveLiteRuntimeDeploymentSlotCheckpointGeneration
  >>;
  preparedCompletion: Awaited<ReturnType<
    typeof prepareLiteRuntimeDeploymentSlotBindingCompletion
  >>;
}>) {
  return await commitLiteRuntimeDeploymentSlotBindingCompletion({
    ...args,
    now: new Date("2026-07-17T08:00:00.000Z"),
  });
}

test("D3a.3a configured-root-mapped durable deployment-slot authority", { concurrency: 1 }, async (t) => {
  const roots = new Set<string>();
  const runtimePins = new Set<LiteRuntimeProtectedAuthorityDatabasePin>();
  const rootCapabilities = new Set<
    LiteRuntimeDeploymentSlotPathAuthorityRootCapability
  >();
  t.after(async () => {
    await terminateActiveChildren();
    for (const pin of runtimePins) {
      closeLiteRuntimeProtectedAuthorityDatabasePin(pin);
    }
    for (const rootCapability of rootCapabilities) {
      closeLiteRuntimeDeploymentSlotPathAuthorityRoot(rootCapability);
    }
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    SLOT_PATH_BY_AUTHORITY_STATE_PATH.clear();
  });
  const fixture = (label: string) => {
    const value = createFixture(label);
    roots.add(value.rootDirectory);
    runtimePins.add(value.runtimeDatabasePin);
    rootCapabilities.add(value.rootCap);
    return value;
  };

  await t.test("provision is one-shot and the first anchor survives reopen", async () => {
    const current = fixture("provision");
    const first = await provisionFixture(current);
    await assert.rejects(
      async () => await provisionFixture(current, 0x42),
      /already.provisioned|provision|exists/u,
    );
    assert.match(first.first_binding_anchor_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(first.deployment_slot, DEPLOYMENT_SLOT);
    assert.equal(first.database_instance_id, DATABASE_INSTANCE_ID);
    assert.equal(first.database_file_device, current.databaseFileDevice);
    assert.equal(first.database_file_inode, current.databaseFileInode);
    const slotInspection = inspectLiteRuntimeDeploymentSlotPathCapability(
      current.slotPath,
    );
    assert.equal(first.launcher_root_instance_id, slotInspection.root_instance_id);
    assert.equal(
      first.launcher_root_manifest_sha256,
      slotInspection.root_manifest_sha256,
    );
    assert.equal(
      first.slot_path_mapping_sha256,
      slotInspection.slot_path_mapping_sha256,
    );
    assert.equal(first.slot_path_mapping, "launcher_root_sha256_sharded_v1");
    assert.equal(
      first.slot_provisioning_recovery,
      "conditional_process_live_classify_resume_abort_v1",
    );
    assert.equal(
      first.provisioning_rollback_resistance,
      "current_lineage_only_without_provisioning_journal_rollback",
    );
    assert.equal(Object.isFrozen(first), true);
    const stateStat = lstatSync(current.authorityStatePath, { bigint: true });
    assert.equal(stateStat.isFile(), true);
    assert.equal(stateStat.nlink, 1n);
    assert.equal(stateStat.mode & 0o777n, 0o600n);

    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const leaseInspection = inspectLiteRuntimeDeploymentSlotExclusiveLease(lease);
    assert.equal(
      leaseInspection.first_binding_anchor_sha256,
      first.first_binding_anchor_sha256,
    );
    assert.equal(
      leaseInspection.slot_path_mapping_sha256,
      first.slot_path_mapping_sha256,
    );
    assert.equal(
      leaseInspection.filesystem_locking_verification,
      "required_not_established",
    );
    assert.equal(
      (leaseInspection.required_next_capabilities as readonly string[]).includes(
        "launcher_slot_path_mapping",
      ),
      false,
    );
    assert.equal(
      leaseInspection.required_next_capabilities.includes(
        "trusted_launcher_root_selection",
      ),
      true,
    );
    assert.equal(
      leaseInspection.required_next_capabilities.includes(
        "protected_slot_provisioning_recovery",
      ),
      false,
    );
    assert.equal(
      leaseInspection.required_next_capabilities.includes(
        "isolated_provisioning_lock_process",
      ),
      true,
    );
    assert.equal(
      leaseInspection.required_next_capabilities.includes(
        "nonrollback_provisioning_journal_authority",
      ),
      true,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: "another-slot",
      }),
      /slot|binding|mismatch/u,
    );
  });

  await t.test("launcher mapping makes caller-selected authority layouts unreachable", async (mappingTest) => {
    await mappingTest.test("the same exact slot derives the same root-confined path", () => {
      const current = fixture("deterministic-path");
      const first = inspectLiteRuntimeDeploymentSlotPathCapability(current.slotPath);
      const second = inspectLiteRuntimeDeploymentSlotPathCapability(
        deriveLiteRuntimeDeploymentSlotPathCapability(current.rootCap, DEPLOYMENT_SLOT),
      );
      assert.equal(second.authority_state_path, first.authority_state_path);
      assert.equal(second.lease_carrier_path, `${first.authority_state_path}.lease`);
      assert.equal(second.slot_path_mapping_sha256, first.slot_path_mapping_sha256);
      assert.equal(first.root_manifest_sha256, current.rootManifestSha256);
      assert.equal(first.authority_state_path.startsWith(`${current.rootPath}/`), true);
    });

    await mappingTest.test("path-like and Unicode-distinct slots remain digest-named and disjoint", () => {
      const current = fixture("exact-slot-bytes");
      const pathLike = inspectLiteRuntimeDeploymentSlotPathCapability(
        deriveLiteRuntimeDeploymentSlotPathCapability(current.rootCap, "../alternate-slot"),
      );
      const composed = inspectLiteRuntimeDeploymentSlotPathCapability(
        deriveLiteRuntimeDeploymentSlotPathCapability(current.rootCap, "caf\u00e9"),
      );
      const decomposed = inspectLiteRuntimeDeploymentSlotPathCapability(
        deriveLiteRuntimeDeploymentSlotPathCapability(current.rootCap, "cafe\u0301"),
      );
      for (const inspection of [pathLike, composed, decomposed]) {
        assert.equal(inspection.authority_state_path.startsWith(`${current.rootPath}/slots/v1/`), true);
        assert.equal(inspection.authority_state_path.endsWith("/state.sqlite"), true);
        assert.equal(inspection.authority_state_path.includes(".."), false);
      }
      assert.notEqual(pathLike.slot_sha256, composed.slot_sha256);
      assert.notEqual(composed.slot_sha256, decomposed.slot_sha256);
    });

    await mappingTest.test("a pre-existing digest slot directory requires explicit recovery", async () => {
      const current = fixture("preexisting-slot-directory");
      const inspection = inspectLiteRuntimeDeploymentSlotPathCapability(current.slotPath);
      mkdirSync(inspection.slot_directory_path, { recursive: true, mode: 0o700 });
      await assert.rejects(
        async () => await provisionFixture(current),
        /already exists|recovery|slot directory|provision/iu,
      );
      assert.equal(existsSync(current.authorityStatePath), false);
      assert.equal(existsSync(`${current.authorityStatePath}.lease`), false);
    });
  });

  await t.test("extended-year Dates fail before authority mutation", async (dateTest) => {
    const extendedYear = () => new Date("+010000-01-01T00:00:00.000Z");
    assert.equal(extendedYear().toISOString(), "+010000-01-01T00:00:00.000Z");

    await dateTest.test("provision rejects before creating either authority file", async () => {
      const current = fixture("extended-year-provision");
      let randomCalls = 0;
      await assert.rejects(
        async () => await provisionLiteRuntimeDeploymentSlotAuthority({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
          runtimeDatabasePin: current.runtimeDatabasePin,
          now: extendedYear(),
          randomBytesFactory: (size) => {
            randomCalls += 1;
            return Buffer.alloc(size, 0x51);
          },
        }),
        /non-canonical|invalid|time|date|year/iu,
      );
      assert.equal(randomCalls, 0);
      assert.equal(existsSync(current.authorityStatePath), false);
      assert.equal(existsSync(`${current.authorityStatePath}.lease`), false);

      await provisionFixture(current);
      const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      });
      assert.equal(inspectLiteRuntimeDeploymentSlotExclusiveLease(lease).lease_epoch, "1");
      await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    });

    await dateTest.test("acquire rejects before reserving a lease epoch", async () => {
      const current = fixture("extended-year-acquire");
      await provisionFixture(current);
      let randomCalls = 0;
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
          now: extendedYear(),
          randomBytesFactory: (size) => {
            randomCalls += 1;
            return Buffer.alloc(size, 0x52);
          },
        }),
        /non-canonical|invalid|time|date|year/iu,
      );
      assert.equal(randomCalls, 0);

      const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      });
      assert.equal(inspectLiteRuntimeDeploymentSlotExclusiveLease(lease).lease_epoch, "1");
      await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    });

    await dateTest.test("reserve rejects before creating an operation or generation", async () => {
      const current = fixture("extended-year-reserve");
      await provisionFixture(current);
      const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      });
      const operationId = "extended-year-reservation";
      let randomCalls = 0;
      await assert.rejects(
        async () => await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
          lease,
          operationId,
          operationRequestSha256: operationRequestSha256(operationId),
          now: extendedYear(),
          randomBytesFactory: (size) => {
            randomCalls += 1;
            return Buffer.alloc(size, 0x53);
          },
        }),
        /non-canonical|invalid|time|date|year/iu,
      );
      assert.equal(randomCalls, 0);

      const reservation = await reserveFresh({ lease, operationId });
      assert.equal(
        inspectLiteRuntimeDeploymentSlotCheckpointGeneration(reservation)
          .checkpoint_generation,
        "1",
      );
      await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    });
  });

  await t.test("authority connections enforce WAL and crash-durable PRAGMAs", async () => {
    const current = fixture("durability-pragmas");
    const provisioned = await provisionFixture(current);
    for (const [path, applicationId] of [
      [current.authorityStatePath, 0x41494f53],
      [provisioned.lease_carrier_path, 0x41494f4c],
    ] as const) {
      const database = new DatabaseSync(path);
      try {
        assert.equal(sqlitePragmaScalar(database, "journal_mode"), "wal");
        assert.equal(sqlitePragmaScalar(database, "application_id"), applicationId);
        assert.equal(sqlitePragmaScalar(database, "user_version"), 2);
        // These settings are connection-local. Leave an ordinary SQLite
        // connection at its weakest values; the production open must reapply
        // EXTRA/fullfsync/checkpoint_fullfsync before its own PRAGMA assertion.
        database.exec(`
          PRAGMA synchronous = OFF;
          PRAGMA fullfsync = OFF;
          PRAGMA checkpoint_fullfsync = OFF;
          PRAGMA foreign_keys = OFF;
          PRAGMA trusted_schema = ON;
        `);
      } finally {
        database.close();
      }
    }

    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
      now: new Date("2026-07-17T04:10:00.000Z"),
    });
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease, {
      now: new Date("2026-07-17T04:11:00.000Z"),
    });
  });

  await t.test("persistent state journal-mode drift fails closed", async () => {
    const current = fixture("journal-mode-drift");
    await provisionFixture(current);
    const database = new DatabaseSync(current.authorityStatePath);
    try {
      assert.equal(sqlitePragmaScalar(database, "journal_mode"), "wal");
      assert.equal(
        sqlitePragmaScalar(database, "journal_mode=DELETE"),
        "delete",
      );
    } finally {
      database.close();
    }
    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
        now: new Date("2026-07-17T04:10:00.000Z"),
      }),
      /journal|pragma|schema|integrity|failed closed/iu,
    );
  });

  await t.test("SIGKILL inside a WAL state transaction recovers without a phantom commit", async () => {
    const current = fixture("state-transaction-crash");
    await provisionFixture(current);
    const child = startLeaseChild({
      fixture: current,
      mode: "hold_state_transaction",
    });
    const held = await within(
      child.stateTransactionHeld,
      "child uncommitted state transaction",
    );
    assert.ok(held.walByteLength > 32, "child must spill uncommitted frames to WAL");
    await killChild(child);
    assert.equal(existsSync(`${current.authorityStatePath}-wal`), true);
    assert.equal(existsSync(`${current.authorityStatePath}-shm`), true);

    const recovered = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
      now: new Date("2026-07-17T04:20:00.000Z"),
    });
    const inspection = inspectLiteRuntimeDeploymentSlotExclusiveLease(recovered);
    assert.equal(inspection.lease_epoch, "1");
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(recovered, {
      now: new Date("2026-07-17T04:21:00.000Z"),
    });
  });

  await t.test("SIGKILL inside a WAL carrier transaction recovers without phantom witnesses", async () => {
    const current = fixture("carrier-transaction-crash");
    const provisioned = await provisionFixture(current);
    const child = startLeaseChild({
      fixture: current,
      mode: "hold_carrier_transaction",
    });
    const held = await within(
      child.carrierTransactionHeld,
      "child uncommitted carrier transaction",
    );
    assert.ok(held.walByteLength > 32, "child must spill phantom witnesses to WAL");
    await killChild(child);
    assert.equal(existsSync(`${provisioned.lease_carrier_path}-wal`), true);
    assert.equal(existsSync(`${provisioned.lease_carrier_path}-shm`), true);

    const recovered = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    assert.equal(
      inspectLiteRuntimeDeploymentSlotExclusiveLease(recovered).lease_epoch,
      "1",
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(recovered, {
      now: new Date("2026-07-17T08:00:00.000Z"),
    });

    const carrier = new DatabaseSync(provisioned.lease_carrier_path);
    try {
      const witnesses = carrier.prepare(
        `SELECT witness_epoch
         FROM lite_runtime_deployment_slot_state_witnesses
         ORDER BY length(witness_epoch), witness_epoch`,
      ).all() as Array<Readonly<{ witness_epoch: string }>>;
      assert.deepEqual(witnesses.map((row) => row.witness_epoch), ["1", "2"]);
    } finally {
      carrier.close();
    }
  });

  await t.test("clean-release carrier witness rejects an old same-inode state snapshot", async () => {
    const current = fixture("same-inode-state-rollback");
    await provisionFixture(current);
    const initialState = checkpointStateAndReadMain(current.authorityStatePath);
    const initialStat = statSync(current.authorityStatePath, { bigint: true });

    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
      now: new Date("2026-07-17T04:10:00.000Z"),
    });
    const reservation = await reserveFresh({
      lease,
      operationId: "same-inode-state-rollback",
    });
    assert.equal(
      inspectLiteRuntimeDeploymentSlotCheckpointGeneration(reservation)
        .checkpoint_generation,
      "1",
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease, {
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    checkpointStateAndReadMain(current.authorityStatePath);

    writeFileSync(current.authorityStatePath, initialState);
    const restoredStat = statSync(current.authorityStatePath, { bigint: true });
    assert.equal(restoredStat.dev, initialStat.dev);
    assert.equal(restoredStat.ino, initialStat.ino);
    assert.equal(sha256(readFileSync(current.authorityStatePath)), sha256(initialState));

    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
        now: new Date("2026-07-17T08:00:00.000Z"),
      }),
      /witness|rollback|rolled back|older|diverged|integrity|state/iu,
    );
  });

  await t.test("completed authority rejects a backward acquire cutoff", async () => {
    const current = fixture("causal-cutoff");
    const provisioned = await provisionFixture(current);
    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    const reservation = await reserveFresh({
      lease,
      operationId: "causal-cutoff-completion",
    });
    const envelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "1",
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    const preparedCompletion = await prepareCompletion({
      lease,
      reservation,
      envelope,
    });
    await commitCompletion({ lease, reservation, preparedCompletion });

    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease, {
      now: new Date("2026-07-17T08:00:00.000Z"),
    });
    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
        now: new Date("2026-07-17T07:59:59.999Z"),
      }),
      /backward|causal|chronolog|time|cutoff/iu,
    );
  });

  await t.test("exclusive lease contends across processes and is recovered by SIGKILL", async () => {
    const current = fixture("lease-crash");
    await provisionFixture(current);
    const holder = startLeaseChild({ fixture: current, mode: "hold_lease" });
    await within(holder.leaseHeld, "child deployment slot lease");

    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      }),
      /busy|lease|locked|exclusive/u,
    );

    await killChild(holder);
    const recovered = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    assert.equal(assertLiteRuntimeDeploymentSlotExclusiveLease(recovered).deployment_slot,
      DEPLOYMENT_SLOT);
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(recovered);
  });

  await t.test("a contended acquire releases its root retention before rejecting", async () => {
    const current = fixture("contended-root-retention");
    await provisionFixture(current);
    const holder = startLeaseChild({ fixture: current, mode: "hold_lease" });
    try {
      await within(holder.leaseHeld, "child deployment slot lease");
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
        }),
        /busy|lease|locked|exclusive/u,
      );

      closeLiteRuntimeDeploymentSlotPathAuthorityRoot(current.rootCap);
      rootCapabilities.delete(current.rootCap);
      assert.throws(
        () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(current.rootCap),
        /closed/iu,
      );
    } finally {
      await killChild(holder);
    }
  });

  await t.test("an active lease retains its root until release", async () => {
    const current = fixture("root-retention");
    await provisionFixture(current);
    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    assert.throws(
      () => closeLiteRuntimeDeploymentSlotPathAuthorityRoot(current.rootCap),
      /in use|retain|active lease/iu,
    );
    await assert.rejects(
      async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      }),
      /busy|lease|locked|exclusive/u,
    );
    assert.equal(
      assertLiteRuntimeDeploymentSlotExclusiveLease(lease).deployment_slot,
      DEPLOYMENT_SLOT,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    closeLiteRuntimeDeploymentSlotPathAuthorityRoot(current.rootCap);
    rootCapabilities.delete(current.rootCap);
    assert.throws(
      () => inspectLiteRuntimeDeploymentSlotPathAuthorityRoot(current.rootCap),
      /closed/iu,
    );
  });

  await t.test("SIGKILL after head commit replays the exact durable receipt", async () => {
    const current = fixture("completion-crash");
    const provisioned = await provisionFixture(current);
    const operationId = "completion-before-sigkill";
    const envelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "1",
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    const configPath = join(current.rootDirectory, "completion-child-config.json");
    writeFileSync(configPath, stableStringify({
      envelope,
      externalExecutionPolicy: POLICY,
      registeredExternalExecutionPolicySha256: POLICY_SHA256,
    }), { flag: "wx", mode: 0o600 });
    const child = startLeaseChild({
      fixture: current,
      mode: "commit_and_hold",
      operationId,
      completionConfigPath: configPath,
    });
    await within(child.leaseHeld, "completion child lease");
    const committed = await within(
      child.completionCommitted,
      "completion child durable head",
    );
    assert.equal(committed.checkpointGeneration, "1");
    assert.equal(
      committed.receiptSha256,
      learningRuntimeDatabaseBindingReceiptDigest(envelope),
    );
    assert.equal(committed.receiptJson, stableStringify(envelope));
    await killChild(child);

    const recoveredLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const replay = await completedReplay({ lease: recoveredLease, operationId });
    assert.equal(replay.exact_replay, true);
    assert.equal(replay.database_binding_receipt_sha256, committed.receiptSha256);
    assert.equal(replay.database_binding_receipt_json, committed.receiptJson);
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(recoveredLease);
  });

  await t.test("durable burns allow the first receipt to start at generation 3", async () => {
    const current = fixture("burned-generations");
    const provisioned = await provisionFixture(current);

    const crashed = startLeaseChild({
      fixture: current,
      mode: "reserve_and_hold",
      operationId: "binding-burned-1",
    });
    await within(crashed.leaseHeld, "burn generation child lease");
    const burnedOne = await within(
      crashed.generationReserved,
      "burn generation child reservation",
    );
    assert.equal(burnedOne.checkpointGeneration, "1");
    await killChild(crashed);

    const secondLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    await assert.rejects(
      async () => await reserveGeneration({
        lease: secondLease,
        operationId: "binding-burned-1",
      }),
      /burned|consumed|reservation/u,
    );
    const burnedTwo = await reserveFresh({
      lease: secondLease,
      operationId: "binding-burned-2",
    });
    assert.equal(
      inspectLiteRuntimeDeploymentSlotCheckpointGeneration(burnedTwo).checkpoint_generation,
      "2",
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(secondLease);

    const thirdLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    await assert.rejects(
      async () => await reserveGeneration({
        lease: thirdLease,
        operationId: "binding-burned-2",
      }),
      /burned|consumed|reservation/u,
    );
    const firstReservation = await reserveFresh({
      lease: thirdLease,
      operationId: "binding-first-3",
    });
    const reservationInspection = inspectLiteRuntimeDeploymentSlotCheckpointGeneration(
      firstReservation,
    );
    assert.equal(reservationInspection.checkpoint_generation, "3");
    assert.equal(reservationInspection.expected_binding_chain.chain_kind, "first");
    assert.equal(
      reservationInspection.slot_path_mapping_sha256,
      provisioned.slot_path_mapping_sha256,
    );
    if (reservationInspection.expected_binding_chain.chain_kind !== "first") {
      throw new Error("expected first deployment-slot binding chain");
    }
    assert.equal(
      reservationInspection.expected_binding_chain.first_binding_anchor_sha256,
      provisioned.first_binding_anchor_sha256,
    );
    const firstEnvelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "3",
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    const firstPrepared = await prepareCompletion({
      lease: thirdLease,
      reservation: firstReservation,
      envelope: firstEnvelope,
    });
    const firstCommitted = await commitCompletion({
      lease: thirdLease,
      reservation: firstReservation,
      preparedCompletion: firstPrepared,
    });
    assert.equal(firstCommitted.exact_replay, false);
    assert.equal(firstCommitted.checkpoint_generation, "3");
    assert.equal(
      firstCommitted.slot_path_mapping_sha256,
      provisioned.slot_path_mapping_sha256,
    );
    assert.equal(
      firstCommitted.slot_path_mapping,
      "launcher_root_sha256_sharded_v1",
    );
    assert.equal(
      firstCommitted.database_binding_receipt_sha256,
      learningRuntimeDatabaseBindingReceiptDigest(firstEnvelope),
    );
    assert.equal(firstCommitted.database_binding_receipt_json, stableStringify(firstEnvelope));
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(thirdLease);

    const replayLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const replayed = await completedReplay({
      lease: replayLease,
      operationId: "binding-first-3",
    });
    assert.equal(replayed.exact_replay, true);
    assert.equal(replayed.checkpoint_generation, "3");
    assert.equal(
      replayed.slot_path_mapping_sha256,
      firstCommitted.slot_path_mapping_sha256,
    );
    assert.equal(
      replayed.database_binding_receipt_sha256,
      firstCommitted.database_binding_receipt_sha256,
    );
    assert.equal(
      replayed.database_binding_receipt_json,
      firstCommitted.database_binding_receipt_json,
    );

    const successorReservation = await reserveFresh({
      lease: replayLease,
      operationId: "binding-successor-4",
    });
    const successorInspection = inspectLiteRuntimeDeploymentSlotCheckpointGeneration(
      successorReservation,
    );
    assert.equal(successorInspection.checkpoint_generation, "4");
    assert.equal(successorInspection.expected_binding_chain.chain_kind, "successor");
    if (successorInspection.expected_binding_chain.chain_kind !== "successor") {
      throw new Error("expected successor deployment-slot binding chain");
    }
    assert.equal(
      successorInspection.expected_binding_chain.previous_database_binding_receipt_sha256,
      firstCommitted.database_binding_receipt_sha256,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(replayLease);
  });

  await t.test("capabilities reject structural forgery, cloning, and revoked leases", async () => {
    const current = fixture("opaque");
    const provisioned = await provisionFixture(current);
    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const leaseInspection = inspectLiteRuntimeDeploymentSlotExclusiveLease(lease);
    assert.equal(leaseInspection.signing_eligible, false);
    assert.equal(Object.isFrozen(leaseInspection), true);
    const fakeLease = Object.freeze({ ...leaseInspection }) as never;
    assert.throws(
      () => assertLiteRuntimeDeploymentSlotExclusiveLease(fakeLease),
      /capability|invalid|lease/u,
    );
    await assert.rejects(
      async () => await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
        lease: fakeLease,
        operationId: "forged-lease",
        operationRequestSha256: operationRequestSha256("forged-lease"),
      }),
      /capability|invalid|lease/u,
    );

    const reservation = await reserveFresh({
      lease,
      operationId: "opaque-first",
    });
    const reservationInspection = inspectLiteRuntimeDeploymentSlotCheckpointGeneration(
      reservation,
    );
    const fakeReservation = Object.freeze({ ...reservationInspection }) as never;
    assert.throws(
      () => inspectLiteRuntimeDeploymentSlotCheckpointGeneration(fakeReservation),
      /capability|invalid|reservation/u,
    );
    const envelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: reservationInspection.checkpoint_generation,
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    await assert.rejects(
      async () => await prepareCompletion({
        lease,
        reservation: fakeReservation,
        envelope,
      }),
      /capability|invalid|reservation/u,
    );
    const prepared = await prepareCompletion({ lease, reservation, envelope });
    const fakePrepared = Object.freeze({ ...(prepared as object) }) as never;
    await assert.rejects(
      async () => await commitLiteRuntimeDeploymentSlotBindingCompletion({
        lease,
        reservation,
        preparedCompletion: fakePrepared,
      }),
      /capability|completion|invalid|prepared/u,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);
    assert.throws(
      () => assertLiteRuntimeDeploymentSlotExclusiveLease(lease),
      /closed|revoked|lease/u,
    );
    assert.throws(
      () => inspectLiteRuntimeDeploymentSlotCheckpointGeneration(reservation),
      /closed|revoked|lease|reservation/u,
    );
    await assert.rejects(
      async () => await commitCompletion({ lease, reservation, preparedCompletion: prepared }),
      /closed|revoked|lease/u,
    );
  });

  await t.test("successor survives policy and launcher-key rotation using stored history", async () => {
    const current = fixture("policy-rotation");
    const provisioned = await provisionFixture(current);
    const firstLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const firstReservation = await reserveFresh({
      lease: firstLease,
      operationId: "rotation-first",
    });
    const firstEnvelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "1",
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    const firstPrepared = await prepareCompletion({
      lease: firstLease,
      reservation: firstReservation,
      envelope: firstEnvelope,
    });
    const firstCommitted = await commitCompletion({
      lease: firstLease,
      reservation: firstReservation,
      preparedCompletion: firstPrepared,
    });
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(firstLease);

    const rotatedLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const rotatedReservation = await reserveFresh({
      lease: rotatedLease,
      operationId: "rotation-successor",
    });
    const rotatedEnvelope = signEnvelope(bindingBody({
      fixture: current,
      policy: ROTATED_POLICY,
      checkpointGeneration: "2",
      bindingChain: {
        chain_kind: "successor",
        previous_database_binding_receipt_sha256:
          firstCommitted.database_binding_receipt_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }), ROTATED_LAUNCHER_KEYS.privateKey);
    const rotatedPrepared = await prepareCompletion({
      lease: rotatedLease,
      reservation: rotatedReservation,
      envelope: rotatedEnvelope,
      policy: ROTATED_POLICY,
      policySha256: ROTATED_POLICY_SHA256,
    });
    const rotatedCommitted = await commitCompletion({
      lease: rotatedLease,
      reservation: rotatedReservation,
      preparedCompletion: rotatedPrepared,
    });
    assert.equal(rotatedCommitted.exact_replay, false);
    assert.equal(rotatedCommitted.checkpoint_generation, "2");
    assert.equal(rotatedCommitted.database_binding_receipt_sha256,
      learningRuntimeDatabaseBindingReceiptDigest(rotatedEnvelope));
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(rotatedLease);

    const reopened = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const inspection = inspectLiteRuntimeDeploymentSlotExclusiveLease(reopened);
    assert.equal(inspection.current_database_binding_receipt_sha256,
      rotatedCommitted.database_binding_receipt_sha256);
    assert.equal(inspection.current_checkpoint_generation, "2");
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(reopened);
  });

  await t.test("prepare and finalize reject wrong head, fork, identity, generation, and signer", async () => {
    const current = fixture("negative-completion");
    const provisioned = await provisionFixture(current);
    const firstLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const firstReservation = await reserveFresh({
      lease: firstLease,
      operationId: "negative-first",
    });
    const firstEnvelope = signEnvelope(bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "1",
      bindingChain: {
        chain_kind: "first",
        first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    }));
    const firstPrepared = await prepareCompletion({
      lease: firstLease,
      reservation: firstReservation,
      envelope: firstEnvelope,
    });
    const firstCommitted = await commitCompletion({
      lease: firstLease,
      reservation: firstReservation,
      preparedCompletion: firstPrepared,
    });
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(firstLease);

    const lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    const reservation = await reserveFresh({
      lease,
      operationId: "negative-successor",
    });
    const validBody = bindingBody({
      fixture: current,
      policy: POLICY,
      checkpointGeneration: "2",
      bindingChain: {
        chain_kind: "successor",
        previous_database_binding_receipt_sha256:
          firstCommitted.database_binding_receipt_sha256,
      },
      issuedAt: "2026-07-17T08:00:00.000Z",
    });
    const cases: ReadonlyArray<readonly [
      string,
      LearningRuntimeDatabaseBindingReceiptEnvelopeV1,
      RegExp,
    ]> = [
      ["wrong durable head", signEnvelope({
        ...validBody,
        binding_chain: {
          chain_kind: "successor",
          previous_database_binding_receipt_sha256: sha256("wrong-head"),
        },
      }), /head|previous|digest|durable-chain|binding/u],
      ["first-chain fork", signEnvelope({
        ...validBody,
        binding_chain: {
          chain_kind: "first",
          first_binding_anchor_sha256: provisioned.first_binding_anchor_sha256,
        },
      }), /chain|successor|head/u],
      ["database instance drift", signEnvelope({
        ...validBody,
        database_instance_id: sha256("drifted-instance"),
      }), /database_instance|identity|binding/u],
      ["device drift", signEnvelope({
        ...validBody,
        database_file_device: (BigInt(current.databaseFileDevice) + 1n).toString(10),
      }), /database_file_device|identity|durable-chain|binding/u],
      ["inode drift", signEnvelope({
        ...validBody,
        database_file_inode: (BigInt(current.databaseFileInode) + 1n).toString(10),
      }), /database_file_inode|identity|durable-chain|binding/u],
      ["wrong reserved generation", signEnvelope({
        ...validBody,
        checkpoint_generation: "3",
      }), /generation|durable-chain|binding/u],
      ["generation rollback", signEnvelope({
        ...validBody,
        checkpoint_generation: "1",
      }), /generation|durable-chain|binding/u],
      ["wrong signer", signEnvelope(validBody, ATTACKER_KEYS.privateKey), /signature|signer|verification/u],
    ];
    for (const [label, envelope, expected] of cases) {
      await assert.rejects(
        async () => await prepareCompletion({ lease, reservation, envelope }),
        expected,
        label,
      );
    }

    const validEnvelope = signEnvelope(validBody);
    const validPrepared = await prepareCompletion({ lease, reservation, envelope: validEnvelope });
    const alternateEnvelope = signEnvelope({
      ...validBody,
      database_main_file_sha256: sha256("alternate-valid-fork"),
    });
    const alternatePrepared = await prepareCompletion({
      lease,
      reservation,
      envelope: alternateEnvelope,
    });
    const committed = await commitCompletion({
      lease,
      reservation,
      preparedCompletion: validPrepared,
    });
    assert.equal(committed.exact_replay, false);
    await assert.rejects(
      async () => await commitCompletion({
        lease,
        reservation,
        preparedCompletion: alternatePrepared,
      }),
      /consumed|fork|head|completion|reservation/u,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease);

    const replayLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    await assert.rejects(
      async () => await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
        lease: replayLease,
        operationId: "negative-successor",
        operationRequestSha256: sha256("changed-operation-request"),
      }),
      /replay|request|digest|mismatch/u,
    );
    const replay = await completedReplay({
      lease: replayLease,
      operationId: "negative-successor",
    });
    assert.equal(
      replay.database_binding_receipt_sha256,
      committed.database_binding_receipt_sha256,
    );
    assert.equal(
      replay.database_binding_receipt_json,
      committed.database_binding_receipt_json,
    );
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(replayLease);
  });

  await t.test("state schema, bytes, symlink, and permissions fail closed", async (stateTest) => {
    await stateTest.test("group-writable state file", async () => {
      const current = fixture("state-mode");
      await provisionFixture(current);
      chmodSync(current.authorityStatePath, 0o660);
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
        }),
        /permission|mode|filesystem|untrusted|failed closed/iu,
      );
    });

    await stateTest.test("writable parent directory", async () => {
      const current = fixture("parent-mode");
      await provisionFixture(current);
      chmodSync(current.rootDirectory, 0o770);
      try {
        await assert.rejects(
          async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
            authorityStatePath: current.authorityStatePath,
            deploymentSlot: DEPLOYMENT_SLOT,
          }),
          /permission|directory|filesystem|untrusted|failed closed/iu,
        );
      } finally {
        chmodSync(current.rootDirectory, 0o700);
      }
    });

    await stateTest.test("schema version corruption", async () => {
      const current = fixture("schema-version");
      await provisionFixture(current);
      const database = new DatabaseSync(current.authorityStatePath);
      try {
        database.exec("PRAGMA user_version = 2147483647");
      } finally {
        database.close();
      }
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
        }),
        /schema|version|integrity|corrupt|pragma|sqlite/iu,
      );
    });

    await stateTest.test("truncated SQLite bytes", async () => {
      const current = fixture("truncated-state");
      await provisionFixture(current);
      truncateSync(current.authorityStatePath, 96);
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: current.authorityStatePath,
          deploymentSlot: DEPLOYMENT_SLOT,
        }),
        /sqlite|schema|integrity|corrupt|state|failed closed/iu,
      );
    });

    await stateTest.test("symlink alias", async () => {
      const current = fixture("state-symlink");
      await provisionFixture(current);
      const alias = join(current.rootDirectory, "slot-alias.sqlite");
      symlinkSync(current.authorityStatePath, alias);
      await assert.rejects(
        async () => await acquireLiteRuntimeDeploymentSlotExclusiveLease({
          authorityStatePath: alias,
          deploymentSlot: DEPLOYMENT_SLOT,
        }),
        /symlink|path|filesystem|identity|untrusted|failed closed/iu,
      );
    });
  });

  await t.test("the generation counter fails closed at unsigned-64 exhaustion", async () => {
    const current = fixture("generation-overflow");
    await provisionFixture(current);
    const seedLease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
      authorityStatePath: current.authorityStatePath,
      deploymentSlot: DEPLOYMENT_SLOT,
    });
    await releaseLiteRuntimeDeploymentSlotExclusiveLease(seedLease);
    const database = new DatabaseSync(current.authorityStatePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const epoch = database.prepare(
        `SELECT lease_epoch, lease_holder_token_sha256
         FROM lite_runtime_deployment_slot_lease_epochs
         ORDER BY length(lease_epoch) DESC, lease_epoch DESC
         LIMIT 1`,
      ).get() as {
        lease_epoch: string;
        lease_holder_token_sha256: string;
      } | undefined;
      assert.ok(epoch);
      database.prepare(
        `INSERT INTO lite_runtime_deployment_slot_operations
           (operation_id, operation_request_sha256, created_at)
         VALUES (?, ?, ?)`,
      ).run(
        "generation-overflow-seed",
        operationRequestSha256("generation-overflow-seed"),
        "2026-07-17T08:00:00.000Z",
      );
      database.prepare(
        `INSERT INTO lite_runtime_deployment_slot_checkpoint_reservations
           (reservation_id, operation_id, checkpoint_generation, lease_epoch,
            lease_holder_token_sha256, expected_previous_receipt_sha256, reserved_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        sha256("generation-overflow-reservation"),
        "generation-overflow-seed",
        MAX_U64_DECIMAL,
        epoch.lease_epoch,
        epoch.lease_holder_token_sha256,
        "2026-07-17T08:00:00.000Z",
      );
    } finally {
      database.close();
    }

    let lease: Awaited<ReturnType<
      typeof acquireLiteRuntimeDeploymentSlotExclusiveLease
    >> | null = null;
    try {
      lease = await acquireLiteRuntimeDeploymentSlotExclusiveLease({
        authorityStatePath: current.authorityStatePath,
        deploymentSlot: DEPLOYMENT_SLOT,
      });
      await assert.rejects(
        async () => await reserveLiteRuntimeDeploymentSlotCheckpointGeneration({
          lease: lease!,
          operationId: "generation-overflow",
          operationRequestSha256: operationRequestSha256("generation-overflow"),
        }),
        /generation|overflow|exhausted|integrity|corrupt/u,
      );
    } catch (error) {
      assert.match(String(error), /generation|overflow|exhausted|integrity|corrupt/u);
    } finally {
      if (lease) await releaseLiteRuntimeDeploymentSlotExclusiveLease(lease).catch(() => undefined);
    }
  });
});
