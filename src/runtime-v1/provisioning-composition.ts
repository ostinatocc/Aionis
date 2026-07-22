import {
  canonicalContinuationClone,
} from "../continuation/contract.js";
import { assertContinuationRuntimeV1Host } from
  "../continuation/host-contract.js";
import { createContinuationRuntimeV1AuthorityArtifactProvisioner } from
  "../store/continuation-runtime-v1-authority-artifact-provisioner.js";
import { openContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import {
  createContinuationRuntimeV1OperationStore,
  type ContinuationRuntimeV1OperationExecution,
} from "../store/continuation-runtime-v1-operation-store.js";
import {
  loadContinuationRuntimeV1ProvisioningConfig,
  publicContinuationRuntimeV1ProvisioningConfig,
  type PublicContinuationRuntimeV1ProvisioningConfig,
} from "./provisioning-config.js";
import {
  assertOfflineProvisioningCommandV1,
  createContinuationRuntimeV1OfflineProvisioningService,
  type OfflineProvisioningCommandV1,
} from "./provisioning.js";
import { loadContinuationRuntimeV1TrustRoot } from "./trust-root.js";

export type ContinuationRuntimeV1ProvisioningExecution = Readonly<{
  publicConfig: PublicContinuationRuntimeV1ProvisioningConfig;
  operation: ContinuationRuntimeV1OperationExecution;
}>;

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_provisioning_composition_${code}`);
}

function copyWireCommand(
  value: unknown,
  assignmentSeed: Uint8Array | null,
): OfflineProvisioningCommandV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    fail("command_must_be_plain_object");
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("command_symbol_key_forbidden");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("command_data_properties_required");
    }
    if (key === "assignment_seed") fail("assignment_seed_in_command_forbidden");
    output[key] = descriptor.value;
  }
  const kind = output.kind;
  if (kind === "experiment_cohort_install") {
    if (assignmentSeed === null || assignmentSeed.byteLength !== 32) {
      fail("cohort_assignment_seed_required");
    }
    output.assignment_seed = Buffer.from(assignmentSeed);
  } else if (assignmentSeed !== null) {
    fail("assignment_seed_for_non_cohort_forbidden");
  }
  return output as OfflineProvisioningCommandV1;
}

/**
 * Executes exactly one offline provisioning command and closes SQLite before
 * returning. The caller supplies cohort seed bytes over a separate channel;
 * command JSON, operation request, receipt, and logs can never contain them.
 */
export async function executeContinuationRuntimeV1Provisioning(
  environment: unknown,
  wireCommand: unknown,
  assignmentSeed: Uint8Array | null,
): Promise<ContinuationRuntimeV1ProvisioningExecution> {
  assertContinuationRuntimeV1Host();
  const config = loadContinuationRuntimeV1ProvisioningConfig(environment);
  if ((config.assignmentSeedFd === null) !== (assignmentSeed === null)) {
    fail("assignment_seed_channel_mismatch");
  }
  const publicConfig = publicContinuationRuntimeV1ProvisioningConfig(config);
  const command = copyWireCommand(wireCommand, assignmentSeed);
  try {
    assertOfflineProvisioningCommandV1(command);
    const trustRoot = loadContinuationRuntimeV1TrustRoot(config);
    const database = openContinuationRuntimeV1Database(config.dataPath);
    try {
      const artifacts = createContinuationRuntimeV1AuthorityArtifactProvisioner(
        database,
        trustRoot,
      );
      const operations = createContinuationRuntimeV1OperationStore(database);
      const service = createContinuationRuntimeV1OfflineProvisioningService(
        database,
        artifacts,
        operations,
      );
      const operation = await service.provision(command);
      return canonicalContinuationClone({
        publicConfig,
        operation,
      });
    } finally {
      await database.close();
    }
  } finally {
    if (command.kind === "experiment_cohort_install") {
      command.assignment_seed.fill(0);
    }
  }
}
