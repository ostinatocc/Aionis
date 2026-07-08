import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAionisAgentContext,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";

test("AgentContext keeps same-workflow execution memory visible but not direct-use by default", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue current task",
    },
    nodes: [
      {
        id: "mem-current-task",
        type: "procedure",
        title: "Current task accepted path",
        text_summary: "CURRENT_TASK_ONLY accepted implementation path in src/current.ts.",
        tier: "hot",
        slots: {
          contract_trust: "authoritative",
          task_signature: "task-current",
          workflow_signature: "workflow-shared",
          target_files: ["src/current.ts"],
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_workflow",
            task_signature: "task-current",
            workflow_signature: "workflow-shared",
            target_files: ["src/current.ts"],
          },
        },
        confidence: 0.92,
        salience: 0.95,
      },
      {
        id: "mem-other-task-success",
        type: "procedure",
        title: "Other task successful path",
        text_summary: "OTHER_TASK_SUCCESS reused path from another task in src/other.ts.",
        tier: "hot",
        slots: {
          contract_trust: "authoritative",
          task_signature: "task-other",
          workflow_signature: "workflow-shared",
          target_files: ["src/other.ts"],
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_workflow",
            task_signature: "task-other",
            workflow_signature: "workflow-shared",
            target_files: ["src/other.ts"],
          },
        },
        confidence: 0.93,
        salience: 0.99,
      },
      {
        id: "mem-other-task-failure",
        type: "procedure",
        title: "Other task failed path",
        text_summary: "OTHER_TASK_FAILURE failed branch from another task in src/failed.ts.",
        tier: "hot",
        slots: {
          lifecycle_state: "suppressed",
          task_signature: "task-other",
          workflow_signature: "workflow-shared",
          target_files: ["src/failed.ts"],
          execution_native_v1: {
            schema_version: "execution_native_v1",
            execution_kind: "execution_workflow",
            task_signature: "task-other",
            workflow_signature: "workflow-shared",
            target_files: ["src/failed.ts"],
          },
        },
        confidence: 0.9,
        salience: 0.9,
      },
    ],
    ranked: [
      { id: "mem-other-task-success", score: 0.99 },
      { id: "mem-current-task", score: 0.98 },
      { id: "mem-other-task-failure", score: 0.97 },
    ],
  });

  assert.equal(
    memoryPacket.relevant_memories.some((entry) => entry.memory_id === "mem-other-task-success"),
    true,
  );
  assert.equal(
    memoryPacket.relevant_memories.some((entry) => entry.memory_id === "mem-other-task-failure"),
    true,
  );

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    execution_scope: {
      task_signature: "task-current",
      workflow_signature: "workflow-shared",
    },
    query_intent_override: "continue current task",
  });

  const promptSurface = [
    agentContext.prompt_text,
    ...agentContext.use_now,
    ...agentContext.inspect_before_use,
    ...agentContext.do_not_use,
    ...agentContext.command_posture.map((row) => `${row.instruction} ${row.reason}`),
  ].join("\n");

  assert.match(promptSurface, /Current task accepted path/);
  assert.match(promptSurface, /Other task successful path/);
  assert.match(promptSurface, /Other task failed path/);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-other-task-success"), false);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-current-task"), true);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-other-task-success"), true);
  assert.equal(agentContext.do_not_use_memory_ids.includes("mem-other-task-failure"), true);
  assert.deepEqual(agentContext.target_files, []);
});
