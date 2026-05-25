import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayGuidedGateStepArtifacts,
  buildReplayStrictGateStepArtifacts,
} from "../../src/memory/replay-run-gate-step-outcomes.ts";

test("replay run gate step outcome helpers preserve strict blocked metadata", () => {
  const strict = buildReplayStrictGateStepArtifacts({
    stepIndex: 2,
    toolName: "bash",
    reason: "command_not_allowed_or_missing",
    command: "python",
    allowedCommands: ["npm", "node"],
  });
  assert.equal(strict.writeOutputSignature.reason, "command_not_allowed_or_missing");
  assert.deepEqual(strict.writeOutputSignature.allowed_commands, ["npm", "node"]);
});

test("replay run gate step outcome helpers preserve guided blocked metadata", () => {
  const guided = buildReplayGuidedGateStepArtifacts({
    stepIndex: 3,
    toolName: "bash",
    readiness: "blocked",
    reason: "sensitive_command_requires_override",
    command: "rm",
    argv: ["rm", "-rf", "/tmp/demo"],
    sensitiveReview: {
      command: "rm",
      argv: ["rm", "-rf", "/tmp/demo"],
      reason: "destructive rm -rf",
      risk_level: "high",
      required_param: "params.allow_sensitive_exec=true",
    },
    repair: { summary_version: "repair_patch_v1" },
  });
  assert.equal(guided.writeOutputSignature.reason, "sensitive_command_requires_override");
  assert.equal((guided.writeOutputSignature.repair as { summary_version: string }).summary_version, "repair_patch_v1");
});
