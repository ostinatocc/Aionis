import {
  canonicalContinuationClone,
  canonicalContinuationSha256,
  type Sha256,
} from "../continuation/contract.js";

/**
 * Retention jobs intentionally carry no memory id, capsule membership, sidecar
 * reference, or filesystem path. The authority operation that created the job
 * is the only source from which a worker may resolve cleanup targets.
 */
export type ContinuationRuntimeV1RetentionJobPayloadV1 = Readonly<{
  schema_version: "retention_job_payload_v1";
}>;

export class ContinuationRuntimeV1RetentionJobContractError extends Error {
  constructor() {
    super("continuation_runtime_v1_retention_job_contract_invalid");
    this.name = "ContinuationRuntimeV1RetentionJobContractError";
  }
}

function fail(): never {
  throw new ContinuationRuntimeV1RetentionJobContractError();
}

export function parseContinuationRuntimeV1RetentionJobPayload(
  value: unknown,
): ContinuationRuntimeV1RetentionJobPayloadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "schema_version") fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "schema_version");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
    || descriptor.value !== "retention_job_payload_v1") fail();
  return canonicalContinuationClone({
    schema_version: "retention_job_payload_v1" as const,
  });
}

export function buildContinuationRuntimeV1RetentionJobPayload():
ContinuationRuntimeV1RetentionJobPayloadV1 {
  return parseContinuationRuntimeV1RetentionJobPayload({
    schema_version: "retention_job_payload_v1",
  });
}

export function continuationRuntimeV1RetentionJobPayloadSha256(
  value: ContinuationRuntimeV1RetentionJobPayloadV1,
): Sha256 {
  return canonicalContinuationSha256(
    parseContinuationRuntimeV1RetentionJobPayload(value),
  );
}
