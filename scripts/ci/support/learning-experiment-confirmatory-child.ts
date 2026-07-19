import {
  LearningExperimentProvisioningError,
  createLiteLearningExperimentProvisioner,
} from "../../../tools/learning-experiments/lite-learning-experiment-provisioning.js";
import type { LiteRuntimeDatabaseFaultInjector } from
  "../../../src/store/lite-runtime-database.js";
import {
  CONFIRMATORY_DEFAULT_TENANT_ID,
  CONFIRMATORY_NOW,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProvisionInput,
  openConfirmatoryFixtureRuntime,
  sha256,
} from "./learning-experiment-confirmatory-fixture.js";

type ParentCommand = Readonly<{
  type: "go" | "release_lock";
}>;

type ChildRole = "holder" | "contender";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const databasePath = process.argv[2];
const childIndexRaw = process.argv[3];
const roleRaw = process.argv[4];
if (!databasePath || !childIndexRaw || !roleRaw || !process.send) {
  throw new Error("confirmatory provision child requires DB path, child index, role, and IPC");
}
const childIndex = Number(childIndexRaw);
if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex > 255) {
  throw new Error("confirmatory provision child index must be one byte");
}
if (roleRaw !== "holder" && roleRaw !== "contender") {
  throw new Error("confirmatory provision child role must be holder or contender");
}
const role: ChildRole = roleRaw;

const startGate = deferred();
const releaseLockGate = deferred();
process.on("message", (message: ParentCommand) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "go") startGate.resolve();
  if (message.type === "release_lock") releaseLockGate.resolve();
});

let heldBeforeCommit = false;
const authorityFaultInjector: LiteRuntimeDatabaseFaultInjector = async (phase) => {
  if (role !== "holder" || phase !== "before_commit" || heldBeforeCommit) return;
  heldBeforeCommit = true;
  process.send?.({ type: "lock_held", childIndex });
  await releaseLockGate.promise;
};
const runtime = openConfirmatoryFixtureRuntime(databasePath, {
  faultInjector: authorityFaultInjector,
});
const entropySizes: number[] = [];
let transactionAttemptingSent = false;
const provisioner = createLiteLearningExperimentProvisioner({
  database: runtime.database,
  writeStore: runtime.writeStore,
  dependencies: {
    registry: createConfirmatoryPassedRegistry(),
    defaultTenantId: CONFIRMATORY_DEFAULT_TENANT_ID,
    now: () => CONFIRMATORY_NOW,
    authorityFaultInjector,
    ...(role === "contender" ? {
      authorityBusyTimeoutMs: 250,
      onAuthorityTransactionAttempt: () => {
        if (transactionAttemptingSent) return;
        transactionAttemptingSent = true;
        process.send?.({ type: "transaction_attempting", childIndex });
      },
    } : {}),
    randomBytes: (size) => {
      entropySizes.push(size);
      if (size === 32) return new Uint8Array(32).fill(0x31 + childIndex);
      if (size === 48) return new Uint8Array(48).fill(0x91 + childIndex);
      throw new Error(`unexpected confirmatory child entropy size: ${String(size)}`);
    },
  },
});

process.send({ type: "ready", childIndex });

try {
  let rejectStartTimeout!: (error: Error) => void;
  const startTimeoutPromise = new Promise<never>((_, reject) => {
    rejectStartTimeout = reject;
  });
  const startTimeout = setTimeout(() => {
    rejectStartTimeout(new Error("confirmatory child start barrier timed out"));
  }, 20_000);
  try {
    await Promise.race([startGate.promise, startTimeoutPromise]);
  } finally {
    clearTimeout(startTimeout);
  }
  const result = await provisioner.provision(createConfirmatoryProvisionInput());
  await runtime.close();
  process.send({
    type: "result",
    ok: true,
    childIndex,
    replayed: result.replayed,
    receiptSha256: sha256(result.receiptJson),
    entropySizes,
  });
} catch (error) {
  try {
    await runtime.close();
  } catch {
    // Preserve the provisioning failure in the IPC result.
  }
  process.send({
    type: "result",
    ok: false,
    childIndex,
    code: error instanceof LearningExperimentProvisioningError ? error.code : null,
    message: error instanceof Error ? error.message : String(error),
    entropySizes,
  });
}

process.disconnect();
