import {
  canonicalContinuationClone,
  type Sha256,
} from "../continuation/contract.js";
import {
  continuationRuntimeV1AbsolutePath,
  continuationRuntimeV1EnvPresent,
  continuationRuntimeV1Integer,
  continuationRuntimeV1RequiredSha256,
  strictContinuationRuntimeV1Environment,
} from "./config-support.js";

/**
 * The one-shot offline provisioner deliberately has no HTTP, host credential,
 * provider credential, worker lease, effect signer, or root private-key
 * configuration surface.
 */
export const CONTINUATION_RUNTIME_V1_PROVISIONING_ENV_FIELDS = Object.freeze([
  "AIONIS_DATA_PATH",
  "AIONIS_PROVISIONING_SEED_FD",
  "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH",
  "AIONIS_TRUST_ROOT_SHA256",
] as const);

export type ContinuationRuntimeV1ProvisioningConfig = Readonly<{
  dataPath: string;
  trustRootPublicKeyPath: string;
  trustRootSha256: Sha256;
  assignmentSeedFd: number | null;
}>;

export type PublicContinuationRuntimeV1ProvisioningConfig = Readonly<{
  dataPathConfigured: true;
  trustRootPublicKeyPathConfigured: true;
  trustRootSha256: Sha256;
  assignmentSeedFdConfigured: boolean;
}>;

function fail(message: string): never {
  throw new Error(`continuation_runtime_v1_provisioning_config_invalid:${message}`);
}

export function loadContinuationRuntimeV1ProvisioningConfig(
  value: unknown,
): ContinuationRuntimeV1ProvisioningConfig {
  const env = strictContinuationRuntimeV1Environment(
    value,
    CONTINUATION_RUNTIME_V1_PROVISIONING_ENV_FIELDS,
    fail,
  );
  return canonicalContinuationClone({
    dataPath: continuationRuntimeV1AbsolutePath(env, "AIONIS_DATA_PATH", fail),
    trustRootPublicKeyPath: continuationRuntimeV1AbsolutePath(
      env,
      "AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH",
      fail,
    ),
    trustRootSha256: continuationRuntimeV1RequiredSha256(
      env,
      "AIONIS_TRUST_ROOT_SHA256",
      fail,
    ),
    assignmentSeedFd: continuationRuntimeV1EnvPresent(
      env,
      "AIONIS_PROVISIONING_SEED_FD",
    )
      ? continuationRuntimeV1Integer(
          env,
          "AIONIS_PROVISIONING_SEED_FD",
          3,
          3,
          1024,
          fail,
        )
      : null,
  });
}

export function publicContinuationRuntimeV1ProvisioningConfig(
  config: ContinuationRuntimeV1ProvisioningConfig,
): PublicContinuationRuntimeV1ProvisioningConfig {
  return canonicalContinuationClone({
    dataPathConfigured: true as const,
    trustRootPublicKeyPathConfigured: true as const,
    trustRootSha256: config.trustRootSha256,
    assignmentSeedFdConfigured: config.assignmentSeedFd !== null,
  });
}
