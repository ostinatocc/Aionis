import {
  LearningExperimentProvisioningError,
  createLiteLearningExperimentProvisioner,
} from "../../../src/store/lite-learning-experiment-provisioning.js";
import {
  CONFIRMATORY_DEFAULT_TENANT_ID,
  CONFIRMATORY_NOW,
  createConfirmatoryPassedRegistry,
  createConfirmatoryProvisionInput,
  openConfirmatoryFixtureRuntime,
  sha256,
} from "./learning-experiment-confirmatory-fixture.js";

type ParentCommand = Readonly<{ type: "go" }>;

const databasePath = process.argv[2];
const childIndexRaw = process.argv[3];
if (!databasePath || !childIndexRaw || !process.send) {
  throw new Error("confirmatory provision child requires DB path, child index, and IPC");
}
const childIndex = Number(childIndexRaw);
if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex > 255) {
  throw new Error("confirmatory provision child index must be one byte");
}

const runtime = openConfirmatoryFixtureRuntime(databasePath);
const entropySizes: number[] = [];
const provisioner = createLiteLearningExperimentProvisioner({
  database: runtime.database,
  writeStore: runtime.writeStore,
  dependencies: {
    registry: createConfirmatoryPassedRegistry(),
    defaultTenantId: CONFIRMATORY_DEFAULT_TENANT_ID,
    now: () => CONFIRMATORY_NOW,
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
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("confirmatory child start barrier timed out")), 20_000);
    process.once("message", (message: ParentCommand) => {
      clearTimeout(timeout);
      if (!message || message.type !== "go") {
        reject(new Error("confirmatory child received an invalid start command"));
        return;
      }
      resolve();
    });
  });
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
