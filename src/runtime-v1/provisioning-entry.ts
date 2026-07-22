import { readSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import { assertContinuationRuntimeV1Host } from
  "../continuation/host-contract.js";
import { executeContinuationRuntimeV1Provisioning } from
  "./provisioning-composition.js";
import { loadContinuationRuntimeV1ProvisioningConfig } from
  "./provisioning-config.js";
import {
  assertPrivateAssignmentSeedDescriptor,
  assertPrivateAssignmentSeedDescriptorStable,
} from
  "./provisioning-seed-descriptor.js";

const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_provisioning_entry_${code}`);
}

function readBoundedDescriptor(descriptor: number, maximum: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - total));
    const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > maximum) {
      chunk.fill(0);
      for (const previous of chunks) previous.fill(0);
      fail("input_too_large");
    }
    chunks.push(chunk.subarray(0, count));
  }
  const output = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  return output;
}

function parseCommand(input: Buffer): unknown {
  if (input.byteLength < 2 || input.includes(0)) fail("command_encoding_invalid");
  const text = input.toString("utf8");
  if (Buffer.from(text, "utf8").compare(input) !== 0) fail("command_encoding_invalid");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("command_json_invalid");
  }
  let canonical: string;
  try {
    canonical = canonicalContinuationJson(value);
  } catch {
    fail("command_canonical_value_invalid");
  }
  if (text !== canonical && text !== `${canonical}\n`) {
    fail("command_must_use_canonical_json");
  }
  return value;
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("continuation_runtime_v1_host_")) {
    return "host_unsupported";
  }
  if (message.startsWith("continuation_runtime_v1_provisioning_config_invalid:")) {
    return "provisioning_config_invalid";
  }
  if (message.startsWith("continuation_runtime_v1_trust_root_")) {
    return "trust_root_invalid";
  }
  if (message.startsWith("continuation_runtime_v1_provisioning_entry_")) {
    return "provisioning_input_invalid";
  }
  if (message.startsWith("continuation_runtime_v1_offline_provisioning_")) {
    return "provisioning_command_rejected";
  }
  return "provisioning_failed";
}

function emit(value: Readonly<Record<string, CanonicalJson>>): void {
  process.stdout.write(`${canonicalContinuationJson(value)}\n`);
}

/** Reads one seedless JSON command from stdin and, only for cohort install, 32
 * secret bytes from the configured inherited descriptor. */
export async function runContinuationRuntimeV1Provisioning(
  environment: unknown = { ...process.env },
): Promise<void> {
  assertContinuationRuntimeV1Host();
  const config = loadContinuationRuntimeV1ProvisioningConfig(environment);
  const commandInput = readBoundedDescriptor(0, MAX_COMMAND_BYTES);
  let assignmentSeed: Buffer | null = null;
  try {
    if (config.assignmentSeedFd !== null) {
      const seedDescriptor = assertPrivateAssignmentSeedDescriptor(
        config.assignmentSeedFd,
      );
      assignmentSeed = readBoundedDescriptor(config.assignmentSeedFd, 32);
      assertPrivateAssignmentSeedDescriptorStable(
        config.assignmentSeedFd,
        seedDescriptor,
      );
      if (assignmentSeed.byteLength !== 32) fail("assignment_seed_length_invalid");
    }
    const result = await executeContinuationRuntimeV1Provisioning(
      environment,
      parseCommand(commandInput),
      assignmentSeed,
    );
    emit({
      schema_version: "continuation_runtime_provisioning_event_v1",
      event: "provisioning_complete",
      public_config: result.publicConfig as unknown as CanonicalJson,
      operation: result.operation as unknown as CanonicalJson,
    });
  } finally {
    commandInput.fill(0);
    assignmentSeed?.fill(0);
  }
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsEntrypoint) {
  try {
    await runContinuationRuntimeV1Provisioning();
  } catch (error) {
    process.exitCode = 1;
    emit({
      schema_version: "continuation_runtime_provisioning_event_v1",
      event: "provisioning_failed",
      failure_code: safeFailureCode(error),
    });
  }
}
