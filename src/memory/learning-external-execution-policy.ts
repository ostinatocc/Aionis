import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "./learning-episode-ledger.js";

export const LEARNING_EXTERNAL_EXECUTION_POLICY_KEY = "external-execution-v1" as const;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export type LearningExternalExecutionPolicyRegistryEntry = Readonly<{
  registry_key: typeof LEARNING_EXTERNAL_EXECUTION_POLICY_KEY;
  database_instance_id: string;
  policy: DeepReadonly<ExternalExecutionPolicyV1>;
  policy_sha256: string;
}>;

export type LearningExternalExecutionPolicyResolveInput = Readonly<{
  registryKey: string;
  databaseInstanceId: string;
}>;

export type LearningExternalExecutionPolicyRegistry = Readonly<{
  registry_status: "unregistered" | "registered";
  resolve(
    input: LearningExternalExecutionPolicyResolveInput,
  ): LearningExternalExecutionPolicyRegistryEntry | null;
}>;

export function createLearningExternalExecutionPolicyRegistryEntry(args: {
  registryKey: string;
  databaseInstanceId: string;
  policy: unknown;
}): LearningExternalExecutionPolicyRegistryEntry {
  if (args.registryKey !== LEARNING_EXTERNAL_EXECUTION_POLICY_KEY) {
    throw new Error(`Unknown learning external execution policy key: ${args.registryKey}`);
  }
  if (!/^[0-9a-f]{64}$/.test(args.databaseInstanceId)) {
    throw new Error("Learning external execution policy requires a canonical database instance ID");
  }
  const policy = ExternalExecutionPolicyV1Schema.parse(args.policy);
  if (policy.runtime_authority_attestor.expected_database_instance_id !== args.databaseInstanceId) {
    throw new Error("Learning external execution policy database lineage mismatch");
  }
  const policySha256 = externalExecutionPolicyDigest(policy);
  return deepFreeze({
    registry_key: LEARNING_EXTERNAL_EXECUTION_POLICY_KEY,
    database_instance_id: args.databaseInstanceId,
    policy,
    policy_sha256: policySha256,
  });
}

export function createLearningExternalExecutionPolicyRegistry(
  entries: readonly LearningExternalExecutionPolicyRegistryEntry[],
): LearningExternalExecutionPolicyRegistry {
  const canonicalEntries = entries.map((entry) => {
    const canonical = createLearningExternalExecutionPolicyRegistryEntry({
      registryKey: entry.registry_key,
      databaseInstanceId: entry.database_instance_id,
      policy: entry.policy,
    });
    if (canonical.policy_sha256 !== entry.policy_sha256) {
      throw new Error("Learning external execution policy registry entry digest mismatch");
    }
    return canonical;
  });
  const byIdentity = new Map<string, LearningExternalExecutionPolicyRegistryEntry>();
  for (const entry of canonicalEntries) {
    const identity = `${entry.registry_key}\u0000${entry.database_instance_id}`;
    if (byIdentity.has(identity)) {
      throw new Error("Duplicate learning external execution policy registry entry");
    }
    byIdentity.set(identity, entry);
  }
  return Object.freeze({
    registry_status: canonicalEntries.length === 0 ? "unregistered" : "registered",
    resolve(input: LearningExternalExecutionPolicyResolveInput) {
      return byIdentity.get(`${input.registryKey}\u0000${input.databaseInstanceId}`) ?? null;
    },
  });
}

export const PRODUCTION_LEARNING_EXTERNAL_EXECUTION_POLICY_REGISTRY =
  createLearningExternalExecutionPolicyRegistry([]);
