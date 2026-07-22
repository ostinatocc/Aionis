import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationSha256,
  type Sha256,
} from "../continuation/contract.js";

export type ContinuationRuntimeV1WorkerRole =
  | "embedding"
  | "ann"
  | "effect"
  | "retention";

export type ContinuationRuntimeV1WorkerPrincipal = Readonly<{
  actor_kind: "worker";
  actor_principal_sha256: Sha256;
  worker_role: ContinuationRuntimeV1WorkerRole;
}>;

export function continuationRuntimeV1WorkerPrincipal(args: Readonly<{
  database_instance_id: Sha256;
  worker_role: ContinuationRuntimeV1WorkerRole;
}>): ContinuationRuntimeV1WorkerPrincipal {
  if (args === null || typeof args !== "object" || Array.isArray(args)
    || Reflect.ownKeys(args).length !== 2
    || !Object.prototype.hasOwnProperty.call(args, "database_instance_id")
    || !Object.prototype.hasOwnProperty.call(args, "worker_role")) {
    throw new Error("continuation_runtime_v1_worker_identity_shape_invalid");
  }
  const keys = Reflect.ownKeys(args);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (typeof key !== "string"
      || !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)) {
      throw new Error("continuation_runtime_v1_worker_identity_shape_invalid");
    }
  }
  assertSha256(args.database_instance_id, "database_instance_id");
  if (args.worker_role !== "embedding"
    && args.worker_role !== "ann"
    && args.worker_role !== "effect"
    && args.worker_role !== "retention") {
    throw new Error("continuation_runtime_v1_worker_role_invalid");
  }
  return canonicalContinuationClone({
    actor_kind: "worker" as const,
    actor_principal_sha256: canonicalContinuationSha256({
      schema_version: "continuation_runtime_worker_principal_v1",
      database_instance_id: args.database_instance_id,
      worker_role: args.worker_role,
    }),
    worker_role: args.worker_role,
  });
}
