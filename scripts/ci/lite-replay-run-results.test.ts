import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayFailureOutputSignature,
  buildReplayGuidedPartialOutputSignature,
  buildReplayPendingOutputSignature,
  buildReplaySuccessOutputSignature,
  isReplayExecutionPassed,
  resolveReplayExecutionFailureReason,
} from "../../src/memory/replay-run-results.ts";
import { normalizeReplayExecutionBackend } from "../../src/memory/replay-execution-helpers.ts";

const execution = {
  ok: true,
  status: "success" as const,
  command: "npm",
  argv: ["npm", "test"],
  stdout: "ok",
  stderr: "",
  exit_code: 0,
  duration_ms: 1200,
  timed_out: false,
  error: null,
};

const signature = {
  check: "stdout_contains",
  ok: true,
  message: "matched",
};

const postconditions = [
  { kind: "command_success", state: "pass" as const, ok: true, message: "passed", input: {} },
];

test("replay run result helpers classify pass and failure reasons", () => {
  assert.equal(
    isReplayExecutionPassed({
      execution,
      signature,
      postconditions,
    }),
    true,
  );
  assert.equal(
    resolveReplayExecutionFailureReason({
      ...execution,
      ok: false,
      status: "timeout",
    }),
    "execution_timeout",
  );
  assert.equal(
    resolveReplayExecutionFailureReason({
      ...execution,
      ok: false,
      status: "failed",
      error: "non_zero_exit",
    }),
    "non_zero_exit",
  );
});

test("replay execution backend defaults to sandbox sync", () => {
  assert.equal(normalizeReplayExecutionBackend(null), "sandbox_sync");
  assert.equal(normalizeReplayExecutionBackend("unknown"), "sandbox_sync");
  assert.equal(normalizeReplayExecutionBackend("local_process"), "local_process");
});

test("replay run result helpers build stable output signature envelopes", () => {
  assert.deepEqual(
    buildReplayPendingOutputSignature({
      reason: "sandbox_async_execution_pending",
      executionBackend: "sandbox_async",
      sandboxRunId: "run-123",
      sandboxStatus: "queued",
    }),
    {
      reason: "sandbox_async_execution_pending",
      execution_backend: "sandbox_async",
      sandbox_run_id: "run-123",
      sandbox_status: "queued",
    },
  );

  const success = buildReplaySuccessOutputSignature({
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "local_process",
    sandboxRunId: null,
    sensitiveReview: null,
    execution,
    resultSummary: { summary: "ok" },
    signature,
  });
  assert.equal(success.command, "npm");
  assert.equal(success.execution_backend, "local_process");
  assert.equal(success.result_summary.summary, "ok");

  const failure = buildReplayFailureOutputSignature({
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "local_process",
    sandboxRunId: null,
    sensitiveReview: null,
    execution,
    resultSummary: { summary: "failed" },
    signature,
    preconditions: [],
    postconditions,
  });
  assert.equal(Array.isArray(failure.postconditions), true);

  const partial = buildReplayGuidedPartialOutputSignature({
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "local_process",
    sandboxRunId: null,
    sensitiveReview: null,
    execution,
    resultSummary: { summary: "partial" },
    signature,
    postconditions,
    repair: { kind: "agent_repair_request" },
  });
  assert.equal((partial.repair as { kind: string }).kind, "agent_repair_request");
});
