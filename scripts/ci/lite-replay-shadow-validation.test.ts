import assert from "node:assert/strict";
import test from "node:test";

import { validatePlaybookShadowReadiness } from "../../src/memory/replay-repair-shadow-helpers.ts";

test("shadow validation accepts exact absolute command allowlist entries", async () => {
  const validation = await validatePlaybookShadowReadiness(
    [
      {
        step_index: 1,
        tool_name: "bash",
        tool_input: {
          command: "/usr/bin/python3",
          args: ["-V"],
        },
      },
    ],
    {
      enabled: true,
      mode: "local_process",
      allowedCommands: new Set(["/usr/bin/python3"]),
    },
  );

  assert.equal(validation.pass, true);
  assert.equal(validation.ready_steps, 1);
  assert.equal(validation.blocked_steps, 0);
});

test("shadow validation accepts basename allowlist entries for absolute commands", async () => {
  const validation = await validatePlaybookShadowReadiness(
    [
      {
        step_index: 1,
        tool_name: "bash",
        tool_input: {
          command: "/usr/bin/python3",
          args: ["-V"],
        },
      },
    ],
    {
      enabled: true,
      mode: "local_process",
      allowedCommands: new Set(["python3"]),
    },
  );

  assert.equal(validation.pass, true);
  assert.equal(validation.ready_steps, 1);
  assert.equal(validation.blocked_steps, 0);
});
