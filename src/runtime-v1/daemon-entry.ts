import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import {
  startContinuationRuntimeV1Daemon,
  type RunningContinuationRuntimeV1Daemon,
} from "./daemon-composition.js";
import type { ContinuationRuntimeV1ShutdownResult } from
  "./process-lifecycle.js";

type DaemonLifecycleEvent = Readonly<Record<string, CanonicalJson>>;

function writeLifecycleEvent(event: DaemonLifecycleEvent): void {
  process.stdout.write(`${canonicalContinuationJson(event)}\n`);
}

function safeStartupFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("continuation_runtime_v1_host_")) {
    return "host_unsupported";
  }
  if (message.startsWith("continuation_runtime_v1_daemon_config_invalid:")) {
    return "daemon_config_invalid";
  }
  if (message.startsWith("continuation_runtime_v1_trust_root_")) {
    return "trust_root_invalid";
  }
  if (message === "continuation_runtime_v1_daemon_listen_failed") {
    return "http_listen_failed";
  }
  if (message === "continuation_runtime_v1_daemon_startup_cleanup_failed") {
    return "startup_cleanup_failed";
  }
  return "daemon_composition_failed";
}

/**
 * Runs the HTTP daemon until SIGINT or SIGTERM completes the ordered shutdown
 * lifecycle. Only the public redacted configuration and stable lifecycle
 * result are emitted; exception text and filesystem paths never cross this
 * process boundary.
 */
export async function runContinuationRuntimeV1Daemon(
  environment: unknown = { ...process.env },
): Promise<ContinuationRuntimeV1ShutdownResult> {
  const running: RunningContinuationRuntimeV1Daemon =
    await startContinuationRuntimeV1Daemon(environment);
  writeLifecycleEvent({
    schema_version: "continuation_runtime_daemon_lifecycle_v1",
    event: "listening",
    public_config: running.publicConfig as unknown as CanonicalJson,
  });
  const result = await running.lifecycle.waitForShutdown();
  writeLifecycleEvent({
    schema_version: "continuation_runtime_daemon_lifecycle_v1",
    event: "shutdown_complete",
    shutdown: result as unknown as CanonicalJson,
  });
  return result;
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsEntrypoint) {
  try {
    await runContinuationRuntimeV1Daemon();
  } catch (error) {
    process.exitCode = 1;
    writeLifecycleEvent({
      schema_version: "continuation_runtime_daemon_lifecycle_v1",
      event: "startup_failed",
      failure_code: safeStartupFailureCode(error),
    });
  }
}
