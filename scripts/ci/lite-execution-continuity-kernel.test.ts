import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import type { ExecutionStateV1 } from "../../src/execution/types.ts";
import {
  applyExecutionContinuityTransitionsFromSlots,
  buildExecutionContinuityContext,
  executionContinuityKernel,
  executionPacketToStaticBlocks,
  mergeExecutionPacketStaticBlocks,
  resolveExecutionKernelContext,
} from "../../src/kernel/execution-continuity-kernel.ts";

const now = "2026-05-18T00:00:00.000Z";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-state-"));
  return path.join(dir, `${name}.sqlite`);
}

function sampleState(): ExecutionStateV1 {
  return {
    version: 1,
    state_id: "state-focused-continuity",
    scope: "focused-scope",
    task_brief: "Extract continuity kernel",
    current_stage: "patch",
    active_role: "patch",
    owned_files: ["src/kernel/execution-continuity-kernel.ts"],
    modified_files: ["src/routes/memory-context-runtime.ts"],
    pending_validations: ["npm run -s test:focused"],
    completed_validations: ["npm run -s build"],
    last_accepted_hypothesis: "route-owned continuity can move behind a pure kernel",
    rejected_paths: ["rewrite all context routes at once"],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: {
      standard: "focused kernel boundary",
      required_outputs: ["green focused tests"],
      acceptance_checks: ["continuity context remains stable"],
      rollback_required: false,
    },
    resume_anchor: {
      anchor: "Task 2 minimal extraction",
      file_path: "src/kernel/execution-continuity-kernel.ts",
      symbol: "executionContinuityKernel",
      repo_root: "/Volumes/ziel/AionisRuntime-focused",
    },
    updated_at: now,
  };
}

test("execution continuity kernel recovers state-first packet context", () => {
  const state = sampleState();
  const recovered = resolveExecutionKernelContext({ execution_state_v1: state });

  assert.equal(recovered.source_mode, "state_first");
  assert.equal(recovered.state_first_assembly, true);
  assert.equal(recovered.packet?.state_id, state.state_id);
  assert.equal(recovered.packet?.next_action, "Complete pending validations: npm run -s test:focused");
  assert.deepEqual(recovered.packet?.target_files, ["src/kernel/execution-continuity-kernel.ts"]);
});

test("execution continuity kernel builds always-included static context from packet and side outputs", () => {
  const packet = resolveExecutionKernelContext({ execution_state_v1: sampleState() }).packet;
  assert.ok(packet);

  const packetBlocks = executionPacketToStaticBlocks(packet);
  assert.ok(packetBlocks.some((block) => block.title === "Execution Brief" && block.content.includes("current_stage=patch")));
  assert.ok(packetBlocks.every((block) => block.always_include));

  const merged = mergeExecutionPacketStaticBlocks({
    execution_packet_v1: packet,
    execution_result_summary: { status: "passed", command: "npm run -s build" },
    execution_artifacts: [{ ref: "plan", uri: "docs/plans/2026-05-18-kernel-convergence.md" }],
    execution_evidence: [{ claim: "focused tests passed", kind: "test" }],
    static_context_blocks: [{
      id: "caller-context",
      title: "Caller Context",
      content: "preserved",
      tags: [],
      intents: [],
      priority: 1,
      always_include: false,
    }],
  });

  assert.equal(merged[0]?.title, "Execution Brief");
  assert.ok(merged.some((block) => block.id === "execution-side-outputs"));
  assert.equal(merged.at(-1)?.id, "caller-context");
});

test("execution continuity kernel injects side outputs into context without overwriting caller values", () => {
  const context = buildExecutionContinuityContext({
    context: {
      execution_result_summary: { status: "caller-owned" },
    },
    execution_result_summary: { status: "kernel-owned" },
    execution_artifacts: [{ ref: "artifact-a" }],
    execution_evidence: [{ claim: "evidence-a" }],
  });

  assert.deepEqual(context.execution_result_summary, { status: "caller-owned" });
  assert.deepEqual(context.execution_artifacts, [{ ref: "artifact-a" }]);
  assert.deepEqual(context.execution_evidence, [{ claim: "evidence-a" }]);
});

test("execution continuity kernel persists handoff transitions across reopened Lite SQLite stores", async () => {
  const dbPath = tmpDbPath("continuity");
  const store = createLiteExecutionStateStore(dbPath);
  const state = sampleState();
  try {
    const applied = applyExecutionContinuityTransitionsFromSlots({
      executionStateStore: store,
      writeSlots: {
        execution_state_v1: state,
        execution_transitions_v1: [{
          transition_id: "validation-completed-1",
          state_id: state.state_id,
          scope: state.scope,
          actor_role: "patch",
          at: "2026-05-18T00:01:00.000Z",
          type: "validation_completed",
          validations: ["npm run -s test:focused"],
        }],
      },
    });

    assert.equal(applied?.[0]?.expected_revision, 1);
    const stored = store.get(state.scope, state.state_id);
    assert.equal(stored?.revision, 2);
    assert.deepEqual(stored?.state.pending_validations, []);
    assert.ok(stored?.state.completed_validations.includes("npm run -s test:focused"));
  } finally {
    await store.close();
  }

  const reopened = createLiteExecutionStateStore(dbPath);
  try {
    const recovered = reopened.get(state.scope, state.state_id);
    assert.equal(recovered?.revision, 2);
    assert.deepEqual(recovered?.state.pending_validations, []);
    assert.ok(recovered?.state.completed_validations.includes("npm run -s test:focused"));
    assert.equal(recovered?.last_transition_type, "validation_completed");
  } finally {
    await reopened.close();
  }
});

test("execution continuity kernel facade exposes the extracted route decisions", () => {
  const state = sampleState();
  assert.equal(executionContinuityKernel.recoverExecutionState({ execution_state_v1: state }).source_mode, "state_first");
  assert.ok(executionContinuityKernel.buildNextActionPacket({ execution_state_v1: state }).length > 0);
  assert.deepEqual(
    executionContinuityKernel.assembleContinuityContext({ execution_result_summary: { ok: true } }).execution_result_summary,
    { ok: true },
  );
});
