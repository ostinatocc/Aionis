import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffWriteBody } from "../../src/memory/handoff.ts";

test("handoff/store preserves explicit admission signal weights on stored handoff node", () => {
  const write = buildHandoffWriteBody({
    tenant_id: "default",
    scope: "scope-handoff-weights",
    actor: "claude-code",
    memory_lane: "private",
    anchor: "claude-code:session:verified",
    handoff_kind: "task_handoff",
    title: "Claude Code verified session handoff",
    summary: "Claude Code completed a verified implementation route. npm test passed.",
    handoff_text: "Continue from the verified edited implementation surface.",
    target_files: ["src/math.js"],
    acceptance_checks: ["npm test passed"],
    next_action: "Continue through src/math.js and keep npm test as the acceptance check.",
    salience: 0.86,
    importance: 0.88,
    confidence: 0.95,
  });

  assert.equal(write.nodes?.[0]?.salience, 0.86);
  assert.equal(write.nodes?.[0]?.importance, 0.88);
  assert.equal(write.nodes?.[0]?.confidence, 0.95);
  assert.equal(write.nodes?.[0]?.slots?.summary_kind, "handoff");
});
