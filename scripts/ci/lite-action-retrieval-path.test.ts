import test from "node:test";
import assert from "node:assert/strict";
import { choosePathRecommendation } from "../../src/memory/action-retrieval.ts";

test("action retrieval prefers explicit current action over conditional fallback surfaces", () => {
  const path = choosePathRecommendation({
    queryText: "Resume the implementation task. Use the current target file workflow before broad discovery.",
    context: {
      task_kind: "implementation",
      goal: "recover the current target file first",
    },
    selectedTool: "read",
    recommendedWorkflows: [
      {
        anchor_id: "workflow:current",
        contract_trust: "advisory",
        anchor_level: "L2",
        promotion_state: "stable",
        workflow_signature: "current-target-recovery",
        task_family: "implementation",
        title: "Current recovery workflow",
        summary: "For the current implementation task, read src/current-target.ts and the prior verifier note before broad discovery.",
        tool_set: ["read", "edit", "test"],
        target_files: ["src/current-target.ts"],
        file_path: "src/current-target.ts",
        next_action: "Read src/current-target.ts and the prior verifier note before broad discovery.",
        confidence: 0.82,
      },
      {
        anchor_id: "workflow:fallback",
        contract_trust: "advisory",
        anchor_level: "L2",
        promotion_state: "stable",
        workflow_signature: "fallback-target-recovery",
        task_family: "implementation",
        title: "Adjacent recovery note",
        summary: "Context recovery note: it does not name the current target file.",
        tool_set: ["read", "search"],
        target_files: ["src/fallback-target.ts"],
        file_path: "src/fallback-target.ts",
        next_action: "Inspect src/fallback-target.ts only if the current target file is absent.",
        confidence: 0.98,
      },
    ],
    candidateWorkflows: [],
  });

  assert.equal(path.anchor_id, "workflow:current");
  assert.equal(path.file_path, "src/current-target.ts");
  assert.equal(path.target_files[0], "src/current-target.ts");
  assert.match(path.reason ?? "", /stable workflow memory matched this request/);
  assert.doesNotMatch(path.reason ?? "", /conditional_fallback_next_action/);
});

