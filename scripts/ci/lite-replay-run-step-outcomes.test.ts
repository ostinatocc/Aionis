import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayGuidedPartialStepArtifacts,
  buildReplayPendingStepArtifacts,
  buildReplayStrictFailureStepArtifacts,
  buildReplaySuccessStepArtifacts,
} from "../../src/memory/replay-run-step-outcomes.ts";

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

test("replay run step outcome helpers build pending and success envelopes", () => {
  const pending = buildReplayPendingStepArtifacts({
    stepIndex: 1,
    toolName: "bash",
    mode: "guided",
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "sandbox_async",
    sandboxRunId: "run-123",
    sandboxStatus: "queued",
    reason: "sandbox_async_execution_pending",
  });
  assert.equal(pending.writeStatus, "partial");
  assert.equal(pending.repairApplied, true);

  const success = buildReplaySuccessStepArtifacts({
    stepIndex: 1,
    toolName: "bash",
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "local_process",
    sandboxRunId: null,
    sensitiveReview: null,
    execution,
    resultSummary: { summary: "ok" },
    signature,
    postconditions,
  });
  assert.equal(success.writeOutputSignature.command, "npm");
  assert.equal((success.report as { tool_name?: string | null }).tool_name, "bash");
});

test("replay run step outcome helpers build failure and guided partial envelopes", () => {
  const failure = buildReplayStrictFailureStepArtifacts({
    stepIndex: 2,
    toolName: "bash",
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
    error: "execution_failed",
  });
  assert.equal(failure.writeOutputSignature.command, "npm");

  const guided = buildReplayGuidedPartialStepArtifacts({
    stepIndex: 2,
    toolName: "bash",
    command: "npm",
    argv: ["npm", "test"],
    executionBackend: "local_process",
    sandboxRunId: null,
    sensitiveReview: null,
    execution,
    resultSummary: { summary: "partial" },
    signature,
    postconditions,
    repair: { summary_version: "repair_patch_v1" },
  });
  assert.equal((guided.writeOutputSignature.repair as { summary_version: string }).summary_version, "repair_patch_v1");
});
