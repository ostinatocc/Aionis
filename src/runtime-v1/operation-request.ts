import {
  canonicalContinuationClone,
  canonicalContinuationSha256,
  canonicalSha256Without,
} from "../continuation/contract.js";
import type {
  RuntimeV1CanonicalObject,
  RuntimeV1MutationCommand,
} from "./command-contract.js";

const OPERATION_REQUEST_CORE_KEYS = Object.freeze([
  "actor_kind",
  "actor_principal_sha256",
  "authority_subject_sha256",
  "body",
  "body_sha256",
  "operation_id",
  "operation_kind",
  "schema_version",
  "scope",
  "tenant_id",
] as const);

function fail(reason: string): never {
  throw new Error(
    `continuation_runtime_v1_command_operation_request_command_${reason}`,
  );
}

/**
 * Projects a verified command into the exact request owned by OperationStore.
 * The self digest is excluded, so the resulting canonical request digest is
 * exactly `command_sha256`; identity and actor fields remain covered instead
 * of being reduced to an unbound business body.
 */
export function operationRequestFromVerifiedCommandV1(
  value: RuntimeV1MutationCommand,
): RuntimeV1CanonicalObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("shape_invalid");
  }
  const expected = value.operation_kind === "worker_completion"
    ? [...OPERATION_REQUEST_CORE_KEYS, "command_sha256", "leased_job_binding"]
    : value.operation_kind === "authority_decision"
      ? [...OPERATION_REQUEST_CORE_KEYS, "command_sha256", "task_family"]
      : [...OPERATION_REQUEST_CORE_KEYS, "command_sha256"];
  const expectedKeys = new Set(expected);
  const keys = Reflect.ownKeys(value);
  if ((Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
    || keys.some((key) => typeof key !== "string")
    || keys.length !== expected.length
    || keys.some((key) => !expectedKeys.has(key as string))) {
    fail("shape_invalid");
  }
  const core = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("shape_invalid");
    }
    if (key !== "command_sha256") core[key] = descriptor.value;
  }
  if (value.schema_version !== "authenticated_runtime_command_v1"
    || canonicalContinuationSha256(value.body) !== value.body_sha256
    || canonicalSha256Without(value, "command_sha256") !== value.command_sha256
    || canonicalContinuationSha256(core) !== value.command_sha256) {
    fail("digest_invalid");
  }
  return canonicalContinuationClone(core as RuntimeV1CanonicalObject);
}
