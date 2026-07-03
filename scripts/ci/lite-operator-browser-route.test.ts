import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Env } from "../../src/config.ts";
import { registerOperatorSnapshotRoutes } from "../../src/routes/operator-snapshot.ts";
import type { LiteFindNodeRow, LiteWriteStore } from "../../src/store/lite-write-store.ts";

function guideExposureNode(slots: Record<string, unknown>): LiteFindNodeRow {
  return {
    id: "node-guide-exposure",
    type: "event",
    client_id: null,
    title: "Guide exposure",
    text_summary: "Guide exposure",
    slots,
    tier: "episodic",
    memory_lane: "shared",
    producer_agent_id: "claude-code",
    owner_agent_id: null,
    owner_team_id: null,
    embedding_status: null,
    embedding_model: null,
    raw_ref: null,
    evidence_ref: null,
    salience: 0.5,
    importance: 0.5,
    confidence: 0.5,
    last_activated: null,
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
    commit_id: null,
    topic_state: null,
    member_count: null,
  };
}

function memoryNode(id: string): LiteFindNodeRow {
  return {
    id,
    type: "execution_memory",
    client_id: "client-mem-1",
    title: "Checkout migration route",
    text_summary: "Continue with the bundledDev route and inspect old adapter before use.",
    slots: {
      lifecycle_state: "current",
      authority_state: "trusted",
      source_kind: "runtime",
      target_files: ["src/bundledDev.ts"],
      task_signature: "checkout-migration",
      workflow_signature: "checkout-migration-v4",
      raw_prompt_text: "must not leak",
      api_key: "must not leak",
    },
    tier: "semantic",
    memory_lane: "shared",
    producer_agent_id: "claude-code",
    owner_agent_id: null,
    owner_team_id: "checkout",
    embedding_status: "ready",
    embedding_model: "minimax:embo-01",
    raw_ref: "raw://mem-1",
    evidence_ref: "evidence://mem-1",
    salience: 0.8,
    importance: 0.7,
    confidence: 0.9,
    last_activated: "2026-07-03T00:00:00.000Z",
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
    commit_id: "commit-1",
    topic_state: "active",
    member_count: 2,
  };
}

function createTestStore(): LiteWriteStore {
  return {
    listOperatorScopes: async (args) => {
      const rows = [
        {
          scope: "ws:checkout-migration:abc123",
          memory_count: 12,
          guide_trace_count: 2,
          run_count: 1,
          actor_count: 2,
          latest_memory_at: "2026-07-03T00:00:00.000Z",
        },
        {
          scope: "tenant:team-a::scope:shared-project",
          memory_count: 3,
          guide_trace_count: 1,
          run_count: 1,
          actor_count: 1,
          latest_memory_at: "2026-07-02T00:00:00.000Z",
        },
      ];
      if (args.tenantId === "team-a") return rows.slice(1);
      if (args.tenantId === "default") return rows.slice(0, 1);
      return rows;
    },
    listOperatorGuideExposures: async (args) => {
      assert.equal(args.scope, "ws:checkout-migration:abc123");
      if (args.runId) assert.equal(args.runId, "run-1");
      return [
        guideExposureNode({
          guide_exposure_v1: {
            contract_version: "aionis_guide_exposure_v1",
            guide_trace_id: "guide-1",
            tenant_id: "default",
            scope: "ws:checkout-migration:abc123",
            run_id: "run-1",
            consumer_agent_id: "claude-code",
            memory_ids: ["mem-1", "mem-2", "mem-3"],
            use_now_memory_ids: ["mem-1"],
            inspect_before_use_memory_ids: ["mem-2"],
            do_not_use_memory_ids: ["mem-3"],
            rehydrate_memory_ids: [],
            prompt_char_count: 2048,
            history_used: true,
            actionable_history_used: true,
            recommended_posture: "reuse_supported_history",
            authority: "trusted",
            query_sha256: "query",
            context_sha256: "context",
          },
        }),
      ];
    },
    listExecutionRuns: async () => [
      {
        run_id: "run-1",
        decision_count: 2,
        latest_decision_at: "2026-07-03T00:01:00.000Z",
        latest_selected_tool: "Bash",
        feedback_total: 1,
        latest_feedback_at: "2026-07-03T00:02:00.000Z",
      },
    ],
    listExecutionDecisionsByRun: async () => ({
      count: 2,
      latest_created_at: "2026-07-03T00:01:00.000Z",
      rows: [],
    }),
    listRuleFeedbackByRun: async () => ({
      total: 1,
      positive: 1,
      negative: 0,
      neutral: 0,
      linked_decision_count: 1,
      tools_feedback_count: 1,
      latest_feedback_at: "2026-07-03T00:02:00.000Z",
      rows: [],
    }),
    findNodes: async (args) => {
      assert.equal(args.scope, "ws:checkout-migration:abc123");
      if (args.id === "mem-1") return { rows: [memoryNode("mem-1")], has_more: false };
      return { rows: [], has_more: false };
    },
  } as unknown as LiteWriteStore;
}

test("operator browser routes expose workspaces, runs, and run detail without raw slots", async () => {
  const app = Fastify();
  registerOperatorSnapshotRoutes({
    app,
    env: {
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
    } as Env,
    liteWriteStore: createTestStore(),
    requireMemoryPrincipal: async () => null,
    withIdentityFromRequest: (_req, body) => body,
    enforceRateLimit: async () => undefined,
    enforceTenantQuota: async () => undefined,
    tenantFromBody: () => "default",
    acquireInflightSlot: async () => ({ release: () => undefined }),
  });

  const workspaces = await app.inject({
    method: "GET",
    url: "/v1/operator/workspaces",
  });
  assert.equal(workspaces.statusCode, 200);
  const workspacePayload = workspaces.json();
  assert.equal(workspacePayload.contract_version, "aionis_operator_workspaces_result_v1");
  assert.equal(workspacePayload.tenant_id, null);
  assert.equal(workspacePayload.tenants.length, 2);
  assert.equal(workspacePayload.workspaces.length, 2);
  assert.equal(workspacePayload.workspaces[0].scope, "ws:checkout-migration:abc123");

  const teamWorkspaces = await app.inject({
    method: "GET",
    url: "/v1/operator/workspaces?tenant_id=team-a",
  });
  assert.equal(teamWorkspaces.statusCode, 200);
  const teamWorkspacePayload = teamWorkspaces.json();
  assert.equal(teamWorkspacePayload.tenant_id, "team-a");
  assert.equal(teamWorkspacePayload.tenants.length, 1);
  assert.equal(teamWorkspacePayload.workspaces.length, 1);
  assert.equal(teamWorkspacePayload.workspaces[0].scope, "shared-project");

  const runs = await app.inject({
    method: "GET",
    url: "/v1/operator/runs?scope=ws%3Acheckout-migration%3Aabc123",
  });
  assert.equal(runs.statusCode, 200);
  const runsPayload = runs.json();
  assert.equal(runsPayload.contract_version, "aionis_operator_runs_result_v1");
  assert.equal(runsPayload.runs[0].run_id, "run-1");
  assert.equal(runsPayload.runs[0].use_now_count, 1);
  assert.equal(runsPayload.runs[0].do_not_use_count, 1);

  const detail = await app.inject({
    method: "GET",
    url: "/v1/operator/runs/run-1?scope=ws%3Acheckout-migration%3Aabc123",
  });
  assert.equal(detail.statusCode, 200);
  const detailPayload = detail.json();
  assert.equal(detailPayload.contract_version, "aionis_operator_run_detail_result_v1");
  assert.equal(detailPayload.guide_traces[0].guide_trace_id, "guide-1");
  assert.equal(detailPayload.guide_traces[0].prompt_char_count, 2048);
  assert.equal("slots" in detailPayload.guide_traces[0], false);

  const memory = await app.inject({
    method: "GET",
    url: "/v1/operator/memories/mem-1?scope=ws%3Acheckout-migration%3Aabc123",
  });
  assert.equal(memory.statusCode, 200);
  const memoryPayload = memory.json();
  assert.equal(memoryPayload.contract_version, "aionis_operator_memory_detail_result_v1");
  assert.equal(memoryPayload.memory.id, "mem-1");
  assert.equal(memoryPayload.memory.lifecycle_state, "current");
  assert.equal(memoryPayload.memory.authority_state, "trusted");
  assert.deepEqual(memoryPayload.memory.target_files, ["src/bundledDev.ts"]);
  assert.equal("slots" in memoryPayload.memory, false);
  assert.equal("raw_prompt_text" in memoryPayload.memory.slot_summary, false);
  assert.equal("api_key" in memoryPayload.memory.slot_summary, false);
});
