import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildActionRecallPacket } from "../../src/memory/recall-action-packet.ts";
import { buildExecutionMemoryIntrospectionLite } from "../../src/memory/execution-introspection.ts";
import { ExecutionNativeV1Schema } from "../../src/memory/schemas.ts";
import { resolveNodeExecutionOutcomeRole } from "../../src/memory/node-execution-surface.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import type { RecallNodeRow } from "../../src/store/recall-access.ts";

const FAILED_WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-execution-outcome-role-"));
  return path.join(dir, `${name}.sqlite`);
}

function recallNode(slots: Record<string, unknown>): RecallNodeRow {
  return {
    id: FAILED_WORKFLOW_ID,
    scope: "default",
    type: "procedure",
    tier: "L2",
    memory_lane: "shared",
    producer_agent_id: null,
    owner_agent_id: null,
    owner_team_id: null,
    title: "Legacy branch that failed verifier",
    text_summary: "The legacy branch touched the wrong adapter and verifier rejected it.",
    slots,
    embedding_status: "ready",
    embedding_model: "deterministic-test",
    topic_state: null,
    member_count: null,
    raw_ref: null,
    evidence_ref: null,
    salience: 0.8,
    importance: 0.8,
    confidence: 0.8,
    last_activated: null,
    created_at: "2026-06-12T00:00:00.000Z",
    updated_at: "2026-06-12T00:00:00.000Z",
    commit_id: null,
  };
}

function workflowAnchorSlots(executionOutcomeRole: "passed_solution" | "failed_branch" | "blocked" | "unknown") {
  return {
    summary_kind: "workflow_anchor",
    compression_layer: "L2",
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: "workflow_anchor",
      execution_outcome_role: executionOutcomeRole,
      summary_kind: "workflow_anchor",
      compression_layer: "L2",
      task_signature: "adapter-recovery",
      workflow_signature: "adapter-recovery-legacy-branch",
      anchor_kind: "workflow",
      anchor_level: "L2",
    },
  };
}

test("execution_native_v1 preserves explicit execution outcome role", () => {
  const parsed = ExecutionNativeV1Schema.parse({
    schema_version: "execution_native_v1",
    execution_kind: "workflow_anchor",
    execution_outcome_role: "failed_branch",
  });
  assert.equal(parsed.execution_outcome_role, "failed_branch");
});

test("execution outcome role resolver does not treat negated failure text as failed branch", () => {
  assert.equal(
    resolveNodeExecutionOutcomeRole({
      execution_observation_v1: {
        outcome: "no failure",
      },
    }),
    "unknown",
  );
  assert.equal(
    resolveNodeExecutionOutcomeRole({
      execution_observation_v1: {
        outcome: "failed",
      },
    }),
    "failed_branch",
  );
});

test("action recall demotes failed workflow anchors out of recommended workflows", () => {
  const packet = buildActionRecallPacket({
    tenant_id: "default",
    scope: "default",
    nodes: [recallNode(workflowAnchorSlots("failed_branch"))],
    runtimeToolHints: [],
    contextItems: [],
  });

  assert.equal(packet.recommended_workflows.length, 0);
  assert.equal(packet.candidate_workflows.length, 1);
  assert.equal(packet.candidate_workflows[0]?.anchor_id, FAILED_WORKFLOW_ID);
  assert.equal(packet.candidate_workflows[0]?.execution_outcome_role, "failed_branch");
  assert.equal(packet.candidate_workflows[0]?.promotion_ready, false);
});

test("execution introspection does not recommend failed workflow anchors", async () => {
  const dbPath = tmpDbPath("failed-workflow-anchor");
  const liteWriteStore = createLiteWriteStore(dbPath);
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "seed failed workflow anchor",
        auto_embed: false,
        nodes: [
          {
            id: FAILED_WORKFLOW_ID,
            type: "procedure",
            memory_lane: "shared",
            title: "Legacy branch that failed verifier",
            text_summary: "The legacy branch touched the wrong adapter and verifier rejected it.",
            slots: workflowAnchorSlots("failed_branch"),
          },
        ],
        edges: [],
      },
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );

    await liteWriteStore.withTx(() =>
      applyMemoryWrite(prepared, {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        associativeLinkOrigin: "memory_write",
        write_access: liteWriteStore,
      }),
    );

    const introspection = await buildExecutionMemoryIntrospectionLite(
      liteWriteStore,
      {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
      "default",
      "default",
      "local-user",
    );

    assert.equal(introspection.recommended_workflows.length, 0);
    assert.equal(introspection.candidate_workflows.length, 1);
    assert.equal((introspection.candidate_workflows[0] as any)?.anchor_id, FAILED_WORKFLOW_ID);
    assert.equal((introspection.candidate_workflows[0] as any)?.execution_outcome_role, "failed_branch");
  } finally {
    await liteWriteStore.close();
  }
});
