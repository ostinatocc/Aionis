import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionPacketV1Schema } from "../../src/execution/types.ts";
import { ExecutionTreeV1Schema } from "../../src/execution/tree.ts";
import { ExecutionStateTransitionV1Schema } from "../../src/execution/transitions.ts";
import {
  EXECUTION_STRING_LIST_ITEM_MAX_LENGTH,
  EXECUTION_STRING_LIST_MAX_ITEMS,
} from "../../src/execution/schema-limits.ts";

function packetFixture() {
  return {
    version: 1,
    state_id: "state-1",
    current_stage: "review",
    active_role: "review",
    task_brief: "Review bounded execution packet lists.",
    target_files: ["src/execution/types.ts"],
    next_action: null,
    hard_constraints: [],
    accepted_facts: [],
    rejected_paths: [],
    pending_validations: ["npm run -s typecheck"],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    review_contract: null,
    resume_anchor: null,
    artifact_refs: [],
    evidence_refs: [],
  };
}

test("execution packet string lists reject oversized arrays and items", () => {
  assert.throws(() => {
    ExecutionPacketV1Schema.parse({
      ...packetFixture(),
      pending_validations: Array.from({ length: EXECUTION_STRING_LIST_MAX_ITEMS + 1 }, (_, index) => `check-${index}`),
    });
  });

  assert.throws(() => {
    ExecutionPacketV1Schema.parse({
      ...packetFixture(),
      target_files: ["x".repeat(EXECUTION_STRING_LIST_ITEM_MAX_LENGTH + 1)],
    });
  });
});

test("execution tree and transition string lists share execution list limits", () => {
  assert.throws(() => {
    ExecutionTreeV1Schema.parse({
      version: 1,
      tree_id: "tree-1",
      scope: "default",
      task_brief: "Review bounded execution tree lists.",
      root_raw_node_id: "root-raw",
      root_summary_node_id: "root-summary",
      current_raw_node_id: "root-raw",
      current_summary_node_id: "root-summary",
      next_step_id: 1,
      nodes: {
        "root-raw": {
          version: 1,
          node_id: "root-raw",
          layer: "raw",
          step_id: 0,
          parent_id: null,
          child_ids: Array.from({ length: EXECUTION_STRING_LIST_MAX_ITEMS + 1 }, (_, index) => `child-${index}`),
          content: {
            kind: "root",
            title: "Root",
            action: null,
            observation: null,
            summary: null,
            tool_name: null,
            at: null,
            refs: [],
          },
          cover_node_ids: [],
          diagnostic_note: null,
          status: "active",
          validated: false,
        },
      },
      updated_at: new Date().toISOString(),
    });
  });

  assert.throws(() => {
    ExecutionStateTransitionV1Schema.parse({
      transition_id: "transition-1",
      state_id: "state-1",
      scope: "default",
      actor_role: "review",
      at: new Date().toISOString(),
      type: "validation_added",
      validations: ["x".repeat(EXECUTION_STRING_LIST_ITEM_MAX_LENGTH + 1)],
    });
  });
});
