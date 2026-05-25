import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveReplayCommandAllowlistGate,
  resolveReplayConfirmationGate,
  resolveReplayPreconditionGate,
  resolveReplaySensitiveCommandGate,
  resolveReplayUnsupportedToolGate,
} from "../../src/memory/replay-run-gates.ts";

test("replay run gate helpers classify failed and unknown preconditions", () => {
  assert.equal(
    resolveReplayPreconditionGate([
      { kind: "path_exists", state: "pass", ok: true, message: "file exists", input: {} },
      { kind: "command_success", state: "fail", ok: false, message: "serializer still failing", input: {} },
    ])?.reason,
    "preconditions_failed",
  );
  assert.equal(
    resolveReplayPreconditionGate([
      { kind: "git_clean", state: "unknown", ok: false, message: "git unavailable", input: {} },
    ])?.reason,
    "preconditions_unknown",
  );
});

test("replay run gate helpers classify confirmation and manual-only steps", () => {
  assert.equal(
    resolveReplayConfirmationGate({
      safetyLevel: "manual_only",
      autoConfirm: true,
    })?.reason,
    "manual_only_step",
  );
  assert.equal(
    resolveReplayConfirmationGate({
      safetyLevel: "needs_confirm",
      autoConfirm: false,
    })?.reason,
    "confirmation_required",
  );
  assert.equal(
    resolveReplayConfirmationGate({
      safetyLevel: "auto_ok",
      autoConfirm: false,
    }),
    null,
  );
});

test("replay run gate helpers classify unsupported tool and allowlist mismatches", () => {
  assert.equal(resolveReplayUnsupportedToolGate("bash"), null);
  assert.equal(
    resolveReplayUnsupportedToolGate("browser_use")?.reason,
    "unsupported_tool_for_command_executor",
  );
  assert.equal(
    resolveReplayCommandAllowlistGate({
      argv: ["npm", "test"],
      allowedCommands: new Set(["git"]),
    })?.reason,
    "command_not_allowed_or_missing",
  );
  assert.equal(
    resolveReplayCommandAllowlistGate({
      argv: ["npm", "test"],
      allowedCommands: new Set(["npm"]),
    }),
    null,
  );
  assert.equal(
    resolveReplayCommandAllowlistGate({
      argv: ["/usr/bin/python3", "-V"],
      allowedCommands: new Set(["/usr/bin/python3"]),
    }),
    null,
  );
  assert.equal(
    resolveReplayCommandAllowlistGate({
      argv: ["/usr/bin/python3", "-V"],
      allowedCommands: new Set(["python3"]),
    }),
    null,
  );
});

test("replay run gate helpers classify blocked sensitive commands", () => {
  assert.equal(
    resolveReplaySensitiveCommandGate({
      command: "rm",
      argv: ["rm", "-rf", "/tmp/demo"],
      sensitive: true,
      sensitiveReason: "destructive rm -rf",
      riskLevel: "high",
      sensitiveReviewMode: "block",
      allowSensitiveExec: false,
    })?.reason,
    "sensitive_command_requires_override",
  );
  assert.equal(
    resolveReplaySensitiveCommandGate({
      command: "rm",
      argv: ["rm", "-rf", "/tmp/demo"],
      sensitive: true,
      sensitiveReason: "destructive rm -rf",
      riskLevel: "high",
      sensitiveReviewMode: "warn",
      allowSensitiveExec: false,
    }),
    null,
  );
});
