import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalContinuationJson,
  type CanonicalJson,
} from "../continuation/contract.js";
import {
  startContinuationRuntimeV1Worker,
  type RunningContinuationRuntimeV1Worker,
} from "./worker-composition.js";
import type { ContinuationRuntimeV1ShutdownResult } from
  "./process-lifecycle.js";

type WorkerLifecycleEvent = Readonly<Record<string, CanonicalJson>>;

function writeLifecycleEvent(event: WorkerLifecycleEvent): void {
  process.stdout.write(`${canonicalContinuationJson(event)}\n`);
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("continuation_runtime_v1_host_")) {
    return "host_unsupported";
  }
  if (message.startsWith("continuation_runtime_v1_worker_config_invalid:")) {
    return "worker_config_invalid";
  }
  if (message.startsWith("continuation_runtime_v1_trust_root_")) {
    return "trust_root_invalid";
  }
  if (message === "continuation_runtime_v1_worker_composition_worker_role_unavailable") {
    return "worker_role_unavailable";
  }
  if (message === "continuation_runtime_v1_worker_loop_failed") {
    return "worker_loop_failed";
  }
  if (message === "continuation_runtime_v1_worker_loop_stopped_unexpectedly") {
    return "worker_loop_stopped_unexpectedly";
  }
  if (message === "continuation_runtime_v1_worker_composition_startup_cleanup_failed") {
    return "startup_cleanup_failed";
  }
  return "worker_composition_failed";
}

type LoopOutcome = Readonly<{
  status: "stopped" | "failed";
}>;

async function settleUnexpectedLoop(
  running: RunningContinuationRuntimeV1Worker,
  outcome: LoopOutcome,
): Promise<never> {
  if (!running.lifecycle.shutdownRequested()) {
    await running.lifecycle.requestShutdown("SIGTERM");
  } else {
    await running.lifecycle.waitForShutdown();
  }
  throw new Error(outcome.status === "failed"
    ? "continuation_runtime_v1_worker_loop_failed"
    : "continuation_runtime_v1_worker_loop_stopped_unexpectedly");
}

/** Runs one role-confined worker until its ordered signal shutdown completes. */
export async function runContinuationRuntimeV1Worker(
  environment: unknown = { ...process.env },
): Promise<ContinuationRuntimeV1ShutdownResult> {
  const running = await startContinuationRuntimeV1Worker(environment);
  writeLifecycleEvent({
    schema_version: "continuation_runtime_worker_lifecycle_v1",
    event: "polling",
    public_config: running.publicConfig as unknown as CanonicalJson,
  });

  const loopOutcome = running.workerLoop.then<LoopOutcome, LoopOutcome>(
    () => Object.freeze({ status: "stopped" as const }),
    () => Object.freeze({ status: "failed" as const }),
  );
  const first = await Promise.race([
    loopOutcome.then((outcome) => Object.freeze({
      kind: "loop" as const,
      outcome,
    })),
    running.lifecycle.waitForShutdown().then((shutdown) => Object.freeze({
      kind: "shutdown" as const,
      shutdown,
    })),
  ]);

  if (first.kind === "loop" && !running.lifecycle.shutdownRequested()) {
    return await settleUnexpectedLoop(running, first.outcome);
  }
  const shutdown = first.kind === "shutdown"
    ? first.shutdown
    : await running.lifecycle.waitForShutdown();
  const finalLoop = first.kind === "loop" ? first.outcome : await loopOutcome;
  if (finalLoop.status === "failed") {
    throw new Error("continuation_runtime_v1_worker_loop_failed");
  }
  writeLifecycleEvent({
    schema_version: "continuation_runtime_worker_lifecycle_v1",
    event: "shutdown_complete",
    shutdown: shutdown as unknown as CanonicalJson,
  });
  return shutdown;
}

const invokedAsEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsEntrypoint) {
  try {
    await runContinuationRuntimeV1Worker();
  } catch (error) {
    process.exitCode = 1;
    writeLifecycleEvent({
      schema_version: "continuation_runtime_worker_lifecycle_v1",
      event: "failed",
      failure_code: safeFailureCode(error),
    });
  }
}
