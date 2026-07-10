import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { registerMemoryAccessRoutes } from "./support/register-memory-access-test-routes.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import {
  ContextAssembleRouteContractSchema,
  ExecutionMemoryIntrospectionResponseSchema,
  ExperienceIntelligenceResponseSchema,
  PlanningContextRouteContractSchema,
} from "../../src/memory/schemas.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  createLiteExecutionTreeStore,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-handoff-workflow-projection-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildEnv(overrides: Record<string, unknown> = {}) {
  return {
    AIONIS_EDITION: "lite",
    MEMORY_AUTH_MODE: "off",
    TENANT_QUOTA_ENABLED: false,
    LITE_LOCAL_ACTOR_ID: "local-user",
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    APP_ENV: "test",
    ADMIN_TOKEN: "",
    TRUST_PROXY: false,
    TRUSTED_PROXY_CIDRS: [],
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_BYPASS_LOOPBACK: false,
    WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
    RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    MAX_TEXT_LEN: 10_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    ...overrides,
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  executionStateStore?: ReturnType<typeof createLiteExecutionStateStore> | null;
  executionTreeStore?: ReturnType<typeof createLiteExecutionTreeStore> | null;
  envOverrides?: Record<string, unknown>;
}) {
  const env = buildEnv(args.envOverrides);
  const guards = createRequestGuards({
    env,
    embedder: DeterministicEmbeddingProvider,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });

  registerRuntimeErrorHandler(args.app);

  registerHandoffRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: args.executionStateStore ?? null,
    executionTreeStore: args.executionTreeStore ?? null,
  });

  registerMemoryContextRuntimeRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    recallTextEmbedBatcher: { stats: () => null },
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    enforceRecallTextEmbedQuota: guards.enforceRecallTextEmbedQuota,
    buildRecallAuth: guards.buildRecallAuth,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    hasExplicitRecallKnobs: () => false,
    resolveRecallProfile: () => ({ profile: "balanced", source: "test" }),
    resolveExplicitRecallMode: () => ({
      mode: null,
      profile: "balanced",
      defaults: {},
      applied: false,
      reason: "test_default",
      source: "test",
    }),
    resolveClassAwareRecallProfile: (_endpoint, _body, baseProfile) => ({
      profile: baseProfile,
      defaults: {},
      enabled: false,
      applied: false,
      reason: "test_default",
      source: "test",
      workload_class: null,
      signals: [],
    }),
    withRecallProfileDefaults: (body) => ({ ...(body as Record<string, unknown>) }),
    resolveRecallStrategy: () => ({ strategy: "local", defaults: {}, applied: false }),
    resolveAdaptiveRecallProfile: (profile) => ({ profile, defaults: {}, applied: false, reason: "test_default" }),
    resolveAdaptiveRecallHardCap: () => ({ defaults: {}, applied: false, reason: "test_default" }),
    inferRecallStrategyFromKnobs: () => "local",
    buildRecallTrajectory: () => ({ strategy: "local" }),
    embedRecallTextQuery: async (provider, queryText) => {
      const [vec] = await provider.embed([queryText]);
      return {
        vec,
        ms: 0,
        cache_hit: false,
        singleflight_join: false,
        queue_wait_ms: 0,
        batch_size: 1,
      };
    },
    mapRecallTextEmbeddingError: () => ({
      statusCode: 500,
      code: "embed_failed",
      message: "embedding failed",
    }),
    recordContextAssemblyTelemetryBestEffort: async () => {},
  });

  registerMemoryAccessRoutes({
    app: args.app,
    env,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: args.executionStateStore ?? null,
  });
}

function buildHandoffPayload(args: {
  stateId: string;
  title: string;
  summary: string;
  filePath: string;
  trajectory?: {
    run_id?: string;
    title?: string;
    task_family?: string;
    steps: Array<Record<string, unknown>>;
  };
  trajectoryHints?: {
    repo_root?: string;
    target_files?: string[];
    acceptance_checks?: string[];
  };
}) {
  const updatedAt = "2026-03-21T12:00:00.000Z";
  return {
    tenant_id: "default",
    scope: "default",
    memory_lane: "private",
    anchor: `resume:${args.filePath}`,
    file_path: args.filePath,
    repo_root: "/Volumes/ziel/Aionisgo",
    handoff_kind: "patch_handoff",
    title: args.title,
    summary: args.summary,
    handoff_text: `Continue ${args.summary}`,
    target_files: [args.filePath],
    next_action: `Patch ${args.filePath} and rerun export tests`,
    execution_result_summary: {
      status: "passed",
      summary: `Validation passed for ${args.summary}`,
      validation_passed: true,
      after_exit_revalidated: true,
      fresh_shell_probe_passed: true,
      validation_boundary: "external_verifier",
    },
    execution_evidence: [{
      ref: `evidence://handoff/${args.stateId}`,
      validation_passed: true,
      after_exit_revalidated: true,
      fresh_shell_probe_passed: true,
      validation_boundary: "external_verifier",
    }],
    execution_state_v1: {
      version: 1,
      state_id: args.stateId,
      scope: `aionis://execution/${args.stateId}`,
      task_brief: args.summary,
      current_stage: "patch",
      active_role: "patch",
      owned_files: [],
      modified_files: [args.filePath],
      pending_validations: ["npm run -s test:lite -- export"],
      completed_validations: [],
      last_accepted_hypothesis: null,
      rejected_paths: [],
      unresolved_blockers: [],
      rollback_notes: [],
      reviewer_contract: null,
      resume_anchor: {
        anchor: `resume:${args.filePath}`,
        file_path: args.filePath,
        symbol: null,
        repo_root: "/Volumes/ziel/Aionisgo",
      },
      updated_at: updatedAt,
    },
    execution_packet_v1: {
      version: 1,
      state_id: args.stateId,
      current_stage: "patch",
      active_role: "patch",
      task_brief: args.summary,
      target_files: [args.filePath],
      next_action: `Patch ${args.filePath} and rerun export tests`,
      hard_constraints: [],
      accepted_facts: [],
      rejected_paths: [],
      pending_validations: ["npm run -s test:lite -- export"],
      unresolved_blockers: [],
      rollback_notes: [],
      review_contract: null,
      resume_anchor: {
        anchor: `resume:${args.filePath}`,
        file_path: args.filePath,
        symbol: null,
        repo_root: "/Volumes/ziel/Aionisgo",
      },
      artifact_refs: [],
      evidence_refs: [],
    },
    ...(args.trajectory ? { trajectory: args.trajectory } : {}),
    ...(args.trajectoryHints ? { trajectory_hints: args.trajectoryHints } : {}),
  };
}

function handoffTreeOperation(
  input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-handoff-runtime",
    scope: "aionis://execution-tree/handoff-runtime",
    actor_role: "patch",
    ...input,
  } as ExecutionTreeOperationV1;
}

function planningTreeOperation(
  input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-planning-runtime",
    scope: "aionis://execution-tree/planning-runtime",
    actor_role: "patch",
    ...input,
  } as ExecutionTreeOperationV1;
}

function buildPlanningExecutionTreeWithFailedBranch() {
  let tree = createExecutionTreeV1({
    tree_id: "tree-planning-runtime",
    scope: "aionis://execution-tree/planning-runtime",
    task_brief: "Keep planning continuation branch-aware",
    at: "2026-03-21T12:00:00.000Z",
  });
  for (const operation of [
    planningTreeOperation({
      operation_id: "planning-tree-grow-1",
      type: "grow",
      at: "2026-03-21T12:01:00.000Z",
      action: "inspect narrow continuation boundary",
      observation: "current branch should keep the focused runtime boundary",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    planningTreeOperation({
      operation_id: "planning-tree-compress-1",
      type: "compress",
      at: "2026-03-21T12:02:00.000Z",
      title: "focused runtime boundary",
      summary: "Focused boundary is the accepted continuation path.",
    }),
    planningTreeOperation({
      operation_id: "planning-tree-grow-bad",
      type: "grow",
      at: "2026-03-21T12:03:00.000Z",
      action: "rewrite broad runtime surface",
      observation: "broad branch mixed unrelated runtime responsibilities",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
    planningTreeOperation({
      operation_id: "planning-tree-compress-bad",
      type: "compress",
      at: "2026-03-21T12:04:00.000Z",
      title: "broad rejected branch",
      summary: "Broad runtime rewrite was rejected.",
    }),
    planningTreeOperation({
      operation_id: "planning-tree-maintain-bad",
      type: "maintain",
      at: "2026-03-21T12:05:00.000Z",
      passed: false,
      target_summary_node_id: "summary:4",
      diagnostic_note: "broad branch is an avoidance hint, not the next action",
    }),
    planningTreeOperation({
      operation_id: "planning-tree-revise-bad",
      type: "revise",
      at: "2026-03-21T12:06:00.000Z",
      target_summary_node_id: "summary:4",
      diagnostic_note: "resume from focused boundary",
    }),
    planningTreeOperation({
      operation_id: "planning-tree-grow-current",
      type: "grow",
      at: "2026-03-21T12:07:00.000Z",
      action: "continue the restored focused branch",
      observation: "current branch is ready for the next patch",
      title: null,
      tool_name: "bash",
      refs: [],
    }),
  ] as ExecutionTreeOperationV1[]) {
    tree = applyExecutionTreeOperationV1(tree, operation);
  }
  return tree;
}

test("planning/context injects execution tree current branch without promoting failed branch as next-action context", async () => {
  const dbPath = tmpDbPath("planning-tree-static-context");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const handoffPayload = buildHandoffPayload({
    stateId: "state:planning-tree-static-context",
    title: "Planning tree static context",
    summary: "Continue the focused runtime branch",
    filePath: "src/routes/memory-context-runtime.ts",
  });
  const tree = buildPlanningExecutionTreeWithFailedBranch();
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
    });

    const planning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "continue the current focused runtime branch",
        context: {
          goal: "continue the current focused runtime branch",
        },
        tool_candidates: ["bash", "edit", "test"],
        return_layered_context: true,
        execution_state_v1: handoffPayload.execution_state_v1,
        execution_tree_v1: tree,
      },
    });
    assert.equal(planning.statusCode, 200, planning.body);

    const body = PlanningContextRouteContractSchema.parse(planning.json()) as Record<string, unknown>;
    const executionTreeEffectSummary = (body.planning_summary as any).execution_tree_effect_summary;
    assert.ok(executionTreeEffectSummary);
    assert.equal(executionTreeEffectSummary.summary_version, "execution_tree_effect_summary_v1");
    assert.equal(executionTreeEffectSummary.tree_present, true);
    assert.equal(executionTreeEffectSummary.current_compressed_node_count, 1);
    assert.equal(executionTreeEffectSummary.current_raw_node_count, 1);
    assert.ok(executionTreeEffectSummary.failed_branch_hint_count > 0);
    assert.equal(executionTreeEffectSummary.selected_current_block_count, 2);
    assert.equal(executionTreeEffectSummary.selected_failed_hint_block_count, 0);
    assert.equal(executionTreeEffectSummary.failed_branch_isolated, true);
    assert.equal(executionTreeEffectSummary.next_action_contamination_risk, "none");
    assert.equal(executionTreeEffectSummary.effect_posture, "branch_isolated");
    assert.deepEqual((body.execution_kernel as any).execution_tree_effect_summary, executionTreeEffectSummary);
    assert.deepEqual((body.execution_summary as any).execution_tree_effect_summary, executionTreeEffectSummary);
    assert.equal((body as any).execution_evidence_context.contract_version, "execution_evidence_context_v1");
    assert.equal((body as any).execution_evidence_context.tree.present, true);
    assert.match(JSON.stringify((body as any).execution_evidence_context.current_active_path), /Focused boundary is the accepted continuation path/);
    assert.match(JSON.stringify((body as any).execution_evidence_context.failed_branches), /Broad runtime rewrite was rejected/);
    assert.ok((body as any).execution_evidence_context.selection_trace.raw_trace_count >= 1);
    assert.ok((body as any).aionis_guide_packet.guide_brief.use_now.some((entry: string) =>
      entry.includes("Current active path") && entry.includes("Focused boundary is the accepted continuation path")
    ));
    assert.ok((body as any).aionis_guide_packet.guide_brief.do_not_use.some((entry: string) =>
      entry.includes("Failed branch to avoid") && entry.includes("Broad runtime rewrite was rejected")
    ));
    assert.ok((body as any).aionis_guide_packet.source_map.internal_surfaces_used.includes("execution_evidence_context"));

    const layeredContext = body.layered_context as Record<string, unknown>;
    const layers = layeredContext.layers as Record<string, unknown>;
    const staticLayer = layers.static as Record<string, unknown>;
    const staticItems = Array.isArray(staticLayer.items) ? staticLayer.items.map(String) : [];
    const staticText = staticItems.join("\n");
    assert.match(staticText, /Execution Evidence Active And Passed/);
    assert.match(staticText, /CURRENT_ACTIVE_PATH/);
    assert.match(staticText, /branch_role=current_compressed_path; use_for_next_action=true/);
    assert.match(staticText, /Focused boundary is the accepted continuation path/);
    assert.match(staticText, /branch_role=current_raw_path; use_for_next_action=true/);
    assert.match(staticText, /continue the restored focused branch/);
    assert.doesNotMatch(staticText, /branch_role=failed_or_alternate_branch; use_for_next_action=false/);
    assert.doesNotMatch(staticText, /branch_role=failed_branch; use_for_next_action=false/);
    assert.doesNotMatch(staticText, /avoid_branch=true/);
    assert.doesNotMatch(staticText, /Broad runtime rewrite was rejected/);

    const staticInjection = layeredContext.static_injection as Record<string, unknown>;
    const selectedIds = Array.isArray(staticInjection.selected_ids) ? staticInjection.selected_ids.map(String) : [];
    assert.ok(selectedIds.some((id) => id.endsWith("-compressed-state")));
    assert.ok(selectedIds.some((id) => id.endsWith("-raw-state")));
    assert.ok(!selectedIds.some((id) => id.endsWith("-hints")));

    const selectionTrace = Array.isArray(staticInjection.selection_trace)
      ? staticInjection.selection_trace as Array<Record<string, unknown>>
      : [];
    const hintTrace = selectionTrace.find((entry) => String(entry.id).endsWith("-hints"));
    assert.ok(hintTrace);
    assert.equal(hintTrace.selected, false);
    assert.ok(Array.isArray(hintTrace.reasons));
    const evidenceFailedTrace = selectionTrace.find((entry) => String(entry.id).endsWith("-failed-branches"));
    assert.ok(evidenceFailedTrace);
    assert.equal(evidenceFailedTrace.selected, false);

    const assemble = await app.inject({
      method: "POST",
      url: "/v1/memory/context/assemble",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "continue the current focused runtime branch",
        context: {
          goal: "continue the current focused runtime branch",
        },
        tool_candidates: ["bash", "edit", "test"],
        return_layered_context: true,
        execution_state_v1: handoffPayload.execution_state_v1,
        execution_tree_v1: tree,
      },
    });
    assert.equal(assemble.statusCode, 200, assemble.body);
    const assembleBody = ContextAssembleRouteContractSchema.parse(assemble.json()) as Record<string, unknown>;
    const assemblyTreeEffectSummary = (assembleBody.assembly_summary as any).execution_tree_effect_summary;
    assert.ok(assemblyTreeEffectSummary);
    assert.equal(assemblyTreeEffectSummary.effect_posture, "branch_isolated");
    assert.equal(assemblyTreeEffectSummary.failed_branch_isolated, true);
    assert.equal(assemblyTreeEffectSummary.next_action_contamination_risk, "none");
    assert.deepEqual((assembleBody.execution_kernel as any).execution_tree_effect_summary, assemblyTreeEffectSummary);
    assert.deepEqual((assembleBody.execution_summary as any).execution_tree_effect_summary, assemblyTreeEffectSummary);
    assert.equal((assembleBody as any).execution_evidence_context.contract_version, "execution_evidence_context_v1");
    assert.ok((assembleBody as any).aionis_guide_packet.guide_brief.do_not_use.some((entry: string) =>
      entry.includes("Failed branch to avoid")
    ));
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
  }
});

test("handoff/recover uses request consumer identity for private lite handoffs", async () => {
  const dbPath = tmpDbPath("handoff-recover-private");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
    });

    const payload = buildHandoffPayload({
      stateId: `state:${randomUUID()}`,
      title: "Private task handoff",
      summary: "Resume a private task handoff by explicit anchor",
      filePath: "src/routes/private-task.ts",
    });

    const store = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(store.statusCode, 200);

    const recover = await app.inject({
      method: "POST",
      url: "/v1/handoff/recover",
      payload: {
        tenant_id: "default",
        scope: "default",
        consumer_agent_id: "local-user",
        handoff_kind: "patch_handoff",
        anchor: payload.anchor,
        repo_root: payload.repo_root,
        file_path: payload.file_path,
      },
    });
    assert.equal(recover.statusCode, 200);
    const body = recover.json();
    assert.equal(body.handoff.anchor, payload.anchor);
    assert.equal(body.handoff.file_path, payload.file_path);
    assert.equal(body.handoff.next_action, "Patch src/routes/private-task.ts and rerun export tests");
    assert.deepEqual(body.execution_ready_handoff.target_files, ["src/routes/private-task.ts"]);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("handoff/store persists execution tree operations and recover exposes latest stored tree", async () => {
  const dbPath = tmpDbPath("handoff-tree-runtime");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const tree = createExecutionTreeV1({
    tree_id: "tree-handoff-runtime",
    scope: "aionis://execution-tree/handoff-runtime",
    task_brief: "Keep handoff recovery branch-aware",
    at: "2026-03-21T12:00:00.000Z",
  });
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionTreeStore,
    });

    const payload = {
      ...buildHandoffPayload({
        stateId: "state:handoff-tree-runtime",
        title: "Tree-backed handoff",
        summary: "Persist branch-aware handoff execution state",
        filePath: "src/routes/tree-backed-handoff.ts",
      }),
      execution_tree_disabled: true,
      execution_tree_v1: tree,
      execution_tree_operations_v1: [
        handoffTreeOperation({
          operation_id: "handoff-tree-grow-1",
          type: "grow",
          at: "2026-03-21T12:01:00.000Z",
          action: "inspect tree-backed handoff",
          observation: "handoff captured a branch-aware raw step",
          title: null,
          tool_name: "bash",
          refs: [],
        }),
      ],
    };

    const store = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(store.statusCode, 200, store.body);
    const storeBody = store.json();
    assert.equal(storeBody.execution_tree_v1.tree_id, tree.tree_id);
    assert.equal(storeBody.execution_tree_v1.current_raw_node_id, "raw:1");
    assert.equal(storeBody.execution_tree_v1.nodes["raw:1"].content.action, "inspect tree-backed handoff");
    assert.equal(storeBody.execution_tree_operations_v1.length, 1);
    assert.equal(executionTreeStore.get(tree.scope, tree.tree_id)?.revision, 2);

    executionTreeStore.applyOperation(handoffTreeOperation({
      operation_id: "handoff-tree-compress-1",
      type: "compress",
      at: "2026-03-21T12:02:00.000Z",
      title: "branch-aware handoff",
      summary: "Handoff recovery exposes the latest execution tree store revision.",
    }));

    const recover = await app.inject({
      method: "POST",
      url: "/v1/handoff/recover",
      payload: {
        tenant_id: "default",
        scope: "default",
        consumer_agent_id: "local-user",
        handoff_kind: "patch_handoff",
        anchor: payload.anchor,
        repo_root: payload.repo_root,
        file_path: payload.file_path,
      },
    });
    assert.equal(recover.statusCode, 200, recover.body);
    const recovered = recover.json();
    assert.equal(recovered.execution_tree_v1.current_summary_node_id, "summary:2");
    assert.equal(
      recovered.execution_tree_v1.nodes["summary:2"].content.summary,
      "Handoff recovery exposes the latest execution tree store revision.",
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("handoff/store auto-creates execution tree from execution continuity slots", async () => {
  const dbPath = tmpDbPath("handoff-tree-auto");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionTreeStore,
    });

    const payload = buildHandoffPayload({
      stateId: "state:handoff-tree-auto",
      title: "Auto tree handoff",
      summary: "Auto-create branch-aware tree from handoff continuity",
      filePath: "src/routes/auto-tree-handoff.ts",
    });
    const store = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(store.statusCode, 200, store.body);
    const stored = store.json();
    assert.equal(stored.execution_tree_v1.tree_id, "execution-tree:state:handoff-tree-auto");
    assert.equal(stored.execution_tree_operations_v1.length, 3);
    assert.equal(
      executionTreeStore.get("aionis://execution/state:handoff-tree-auto", "execution-tree:state:handoff-tree-auto")?.revision,
      4,
    );

    const recover = await app.inject({
      method: "POST",
      url: "/v1/handoff/recover",
      payload: {
        tenant_id: "default",
        scope: "default",
        consumer_agent_id: "local-user",
        handoff_kind: "patch_handoff",
        anchor: payload.anchor,
        repo_root: payload.repo_root,
        file_path: payload.file_path,
      },
    });
    assert.equal(recover.statusCode, 200, recover.body);
    const recovered = recover.json();
    assert.equal(recovered.execution_tree_v1.tree_id, "execution-tree:state:handoff-tree-auto");
    assert.equal(recovered.execution_tree_v1.current_summary_node_id, "summary:2");
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("handoff/store auto-creates execution tree for task_handoff by default", async () => {
  const dbPath = tmpDbPath("task-handoff-tree-default");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionTreeStore,
    });

    const payload = {
      ...buildHandoffPayload({
        stateId: "state:task-handoff-tree-default",
        title: "Task handoff tree default",
        summary: "Resume task-level execution state with default branch tracking",
        filePath: "src/routes/task-tree-default.ts",
      }),
      handoff_kind: "task_handoff",
    };
    delete (payload as Record<string, unknown>).file_path;
    delete (payload as Record<string, unknown>).target_files;

    const store = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(store.statusCode, 200, store.body);
    const stored = store.json();
    assert.equal(stored.handoff.handoff_kind, "task_handoff");
    assert.equal(stored.execution_tree_v1.tree_id, "execution-tree:state:task-handoff-tree-default");
    assert.equal(stored.execution_tree_operations_v1.length, 3);
    assert.equal(
      executionTreeStore.get("aionis://execution/state:task-handoff-tree-default", "execution-tree:state:task-handoff-tree-default")?.revision,
      4,
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("handoff/store respects execution_tree_disabled for default auto tree", async () => {
  const dbPath = tmpDbPath("handoff-tree-disabled");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionTreeStore,
    });

    const payload = {
      ...buildHandoffPayload({
        stateId: "state:handoff-tree-disabled",
        title: "Disabled auto tree handoff",
        summary: "Store continuity without default execution tree side effect",
        filePath: "src/routes/disabled-auto-tree-handoff.ts",
      }),
      execution_tree_disabled: true,
    };
    const store = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(store.statusCode, 200, store.body);
    const stored = store.json();
    assert.equal(stored.execution_tree_v1, undefined);
    assert.equal(stored.execution_tree_operations_v1, undefined);
    assert.equal(
      executionTreeStore.get("aionis://execution/state:handoff-tree-disabled", "execution-tree:state:handoff-tree-disabled"),
      null,
    );

    const recover = await app.inject({
      method: "POST",
      url: "/v1/handoff/recover",
      payload: {
        tenant_id: "default",
        scope: "default",
        consumer_agent_id: "local-user",
        handoff_kind: "patch_handoff",
        anchor: payload.anchor,
        repo_root: payload.repo_root,
        file_path: payload.file_path,
      },
    });
    assert.equal(recover.statusCode, 200, recover.body);
    const recovered = recover.json();
    assert.equal(recovered.execution_tree_v1, undefined);
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("handoff/store is idempotent for repeated execution transition anchors", async () => {
  const dbPath = tmpDbPath("handoff-transition-idempotency");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionStateStore = createLiteExecutionStateStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionStateStore,
    });

    const payload = buildHandoffPayload({
      stateId: "state:repeatable-handoff",
      title: "Repeatable handoff",
      summary: "Persist the same execution-backed handoff more than once",
      filePath: "src/routes/repeatable.ts",
    });

    const firstStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(firstStore.statusCode, 200, firstStore.body);
    const firstBody = firstStore.json();
    assert.equal(firstBody.execution_transitions_v1.length, 1);
    assert.equal(executionStateStore.get("aionis://execution/state:repeatable-handoff", "state:repeatable-handoff")?.revision, 2);

    const secondStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(secondStore.statusCode, 200, secondStore.body);
    const secondBody = secondStore.json();
    assert.equal(secondBody.execution_transitions_v1.length, 1);
    assert.equal(executionStateStore.get("aionis://execution/state:repeatable-handoff", "state:repeatable-handoff")?.revision, 2);
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionStateStore.close();
  }
});

test("handoff/store allows stable anchors to evolve with new execution transition intent", async () => {
  const dbPath = tmpDbPath("handoff-transition-evolution");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionStateStore = createLiteExecutionStateStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionStateStore,
    });

    const basePayload = {
      tenant_id: "default",
      scope: "default",
      memory_lane: "private",
      anchor: "resume:stable-anchor-evolves",
      file_path: "src/routes/stable-anchor.ts",
      repo_root: "/Volumes/ziel/Aionisgo",
      handoff_kind: "patch_handoff",
      title: "Stable anchor handoff",
      summary: "First run captured a verifier failure",
      handoff_text: "Continue from the first run evidence",
      target_files: ["src/routes/stable-anchor.ts"],
      next_action: "Inspect first failure before retrying",
      acceptance_checks: ["npm run -s test:lite -- stable-anchor"],
    };

    const firstStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: basePayload,
    });
    assert.equal(firstStore.statusCode, 200, firstStore.body);
    const firstBody = firstStore.json();
    assert.equal(firstBody.execution_transitions_v1.length, 2);
    assert.equal(executionStateStore.get("aionis://handoff/resume:stable-anchor-evolves", "handoff-anchor:resume:stable-anchor-evolves")?.revision, 3);

    const evolvedStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: {
        ...basePayload,
        summary: "Second run captured a narrower verifier failure",
        handoff_text: "Continue from the second run evidence",
        next_action: "Inspect second failure before retrying",
      },
    });
    assert.equal(evolvedStore.statusCode, 200, evolvedStore.body);
    const evolvedBody = evolvedStore.json();
    assert.equal(evolvedBody.execution_transitions_v1.length, 2);
    assert.equal(executionStateStore.get("aionis://handoff/resume:stable-anchor-evolves", "handoff-anchor:resume:stable-anchor-evolves")?.revision, 4);
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionStateStore.close();
  }
});

test("handoff/store projects workflow memory into planner guidance through the generic Lite producer", async () => {
  const dbPath = tmpDbPath("handoff-projection");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      envOverrides: {
        WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: true,
      },
    });

    const firstStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: buildHandoffPayload({
        stateId: `state:${randomUUID()}`,
        title: "Export repair handoff",
        summary: "Recover durable workflow from failed validation",
        filePath: "src/routes/export.ts",
      }),
    });
    assert.equal(firstStore.statusCode, 200);

    const continuityRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "execution_native",
      compressionLayer: "L0",
      limit: 10,
      offset: 0,
    });
    const storedHandoff = continuityRows.rows.find((row) => row.execution_native.summary_kind === "handoff");
    assert.ok(storedHandoff);
    assert.equal(storedHandoff?.execution_native.file_path, "src/routes/export.ts");
    assert.deepEqual(storedHandoff?.execution_native.target_files, ["src/routes/export.ts"]);
    assert.equal(storedHandoff?.execution_native.next_action, "Patch src/routes/export.ts and rerun export tests");

    const firstPlanning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "recover durable workflow from failed validation",
        context: {
          goal: "recover durable workflow from failed validation",
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(firstPlanning.statusCode, 200);
    const firstBody = PlanningContextRouteContractSchema.parse(firstPlanning.json());
    assert.equal(firstBody.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(firstBody.planner_packet.sections.recommended_workflows.length, 0);
    assert.equal(firstBody.workflow_signals[0]?.promotion_ready, false);
    assert.equal(firstBody.planning_summary.distillation_signal_summary.origin_counts.handoff_continuity_carrier, 1);
    assert.match(firstBody.planner_packet.sections.candidate_workflows[0] ?? "", /distillation=handoff_continuity_carrier/i);
    const projectedRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      executionKind: "workflow_candidate",
      limit: 8,
      offset: 0,
    });
    assert.equal(projectedRows.rows.length, 1);
    assert.equal(
      (projectedRows.rows[0]?.slots?.execution_native_v1 as any)?.distillation?.distillation_origin,
      "handoff_continuity_carrier",
    );

    const secondStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: buildHandoffPayload({
        stateId: `state:${randomUUID()}`,
        title: "Export repair handoff second run",
        summary: "Recover durable workflow from failed validation",
        filePath: "src/routes/export.ts",
      }),
    });
    assert.equal(secondStore.statusCode, 200);

    const secondPlanning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "recover durable workflow from failed validation",
        context: {
          goal: "recover durable workflow from failed validation",
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(secondPlanning.statusCode, 200);
    const secondBody = PlanningContextRouteContractSchema.parse(secondPlanning.json());
    assert.equal(secondBody.planner_packet.sections.recommended_workflows.length, 1);
    assert.equal(secondBody.planner_packet.sections.candidate_workflows.length, 0);
    assert.equal(secondBody.workflow_signals[0]?.promotion_state, "stable");
    assert.equal(secondBody.planning_summary.distillation_signal_summary.origin_counts.handoff_continuity_carrier, 1);
    assert.match(secondBody.planning_summary.planner_explanation, /workflow guidance:/i);

    const introspect = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });
    assert.equal(introspect.statusCode, 200);
    const introspectBody = ExecutionMemoryIntrospectionResponseSchema.parse(introspect.json());
    assert.equal(introspectBody.recommended_workflows.length, 1);
    assert.equal(introspectBody.candidate_workflows.length, 0);
    assert.equal(introspectBody.continuity_carrier_summary.handoff_count, 2);
    assert.equal(introspectBody.continuity_carrier_summary.session_event_count, 0);
    assert.equal(introspectBody.distillation_signal_summary.origin_counts.handoff_continuity_carrier, 1);
    assert.ok(introspectBody.operator_surface.sections.workflows.some((line) => line.includes("distillation=handoff_continuity_carrier")));
    assert.match(introspectBody.operator_surface.merged_text, /Recover durable workflow from failed validation/i);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("handoff/store keeps long workflow candidate titles inside learning-control schema limits", async () => {
  const dbPath = tmpDbPath("handoff-long-title");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      envOverrides: {
        WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: true,
      },
    });

    const longSummary = [
      "Repair the real Agent evaluator persistence path after a provider-interrupted assisted run writes a detailed handoff",
      "with verifier evidence, target files, protocol diagnostics, execution state, execution packet, and next action text",
      "long enough to overflow candidate_examples title validation during workflow promotion review.",
    ].join(" ");

    const firstStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: buildHandoffPayload({
        stateId: `state:${randomUUID()}`,
        title: "Long workflow candidate title",
        summary: longSummary,
        filePath: "src/memory/product-output-assembler.ts",
      }),
    });
    assert.equal(firstStore.statusCode, 200);

    const secondStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: buildHandoffPayload({
        stateId: `state:${randomUUID()}`,
        title: "Long workflow candidate title",
        summary: longSummary,
        filePath: "src/memory/product-output-assembler.ts",
      }),
    });
    assert.equal(secondStore.statusCode, 200, secondStore.body);

    const candidateRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "workflow_candidate",
      limit: 10,
      offset: 0,
    });
    assert.ok(candidateRows.rows.length > 0);
    assert.ok(candidateRows.rows.every((row) => row.title.length <= 200));
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("trajectory-backed handoff promotion preserves recovery compiler fields into workflow memory", async () => {
  const dbPath = tmpDbPath("handoff-trajectory-projection");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      envOverrides: {
        WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: true,
      },
    });

    const payload = buildHandoffPayload({
      stateId: `state:${randomUUID()}`,
      title: "Preview server recovery handoff",
      summary: "Repair preview server and keep validation alive after agent exit",
      filePath: "scripts/export-preview.ts",
      trajectory: {
        run_id: `run:${randomUUID()}`,
        title: "Preview server failed validation",
        task_family: "service_publish_validate",
        steps: [
          {
            role: "assistant",
            kind: "analysis",
            text: "Update scripts/export-preview.ts and package.json, then rerun the preview validation path.",
          },
          {
            role: "tool",
            tool_name: "bash",
            command: "python -m http.server 8080 --directory dist &",
          },
          {
            role: "tool",
            tool_name: "bash",
            command: "curl http://localhost:8080/health",
          },
          {
            role: "tool",
            tool_name: "bash",
            command: "npm test -- export-preview",
          },
        ],
      },
      trajectoryHints: {
        repo_root: "/Volumes/ziel/Aionisgo",
        target_files: ["scripts/export-preview.ts", "package.json"],
        acceptance_checks: [
          "curl http://localhost:8080/health",
          "npm test -- export-preview",
        ],
      },
    });

    const firstStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload,
    });
    assert.equal(firstStore.statusCode, 200);

    const continuityRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      executionKind: "execution_native",
      compressionLayer: "L0",
      limit: 10,
      offset: 0,
    });
    const storedHandoff = continuityRows.rows.find((row) => row.execution_native.summary_kind === "handoff");
    assert.ok(storedHandoff);
    assert.equal(storedHandoff?.execution_native.task_family, "service_publish_validate");
    assert.ok(storedHandoff?.execution_native.task_signature);
    assert.ok(storedHandoff?.execution_native.workflow_signature);
    assert.deepEqual(storedHandoff?.execution_native.target_files, ["scripts/export-preview.ts", "package.json"]);
    assert.ok(storedHandoff?.execution_native.workflow_steps?.some((step) => step.includes("python -m http.server 8080")));
    assert.ok(storedHandoff?.execution_native.pattern_hints?.includes("revalidate_service_from_fresh_shell"));
    assert.equal(storedHandoff?.execution_native.service_lifecycle_constraints?.[0]?.must_survive_agent_exit, true);
    assert.equal(storedHandoff?.execution_native.service_lifecycle_constraints?.[0]?.revalidate_from_fresh_shell, true);

    const firstPlanning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair preview server and keep validation alive after agent exit",
        context: {
          goal: "repair preview server and keep validation alive after agent exit",
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(firstPlanning.statusCode, 200);

    const projectedRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      executionKind: "workflow_candidate",
      limit: 8,
      offset: 0,
    });
    assert.equal(projectedRows.rows.length, 1);
    assert.equal(projectedRows.rows[0]?.execution_native.task_family, "service_publish_validate");
    assert.deepEqual(
      [...(projectedRows.rows[0]?.execution_native.target_files ?? [])].sort(),
      ["package.json", "scripts/export-preview.ts"],
    );
    assert.equal(projectedRows.rows[0]?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.equal(projectedRows.rows[0]?.slots.execution_contract_v1?.task_family, "service_publish_validate");
    assert.deepEqual(
      [...(projectedRows.rows[0]?.slots.execution_contract_v1?.target_files ?? [])].sort(),
      ["package.json", "scripts/export-preview.ts"],
    );
    assert.ok(projectedRows.rows[0]?.execution_native.workflow_steps?.some((step) => step.includes("python -m http.server 8080")));
    assert.ok(projectedRows.rows[0]?.execution_native.pattern_hints?.includes("revalidate_service_from_fresh_shell"));
    assert.equal(projectedRows.rows[0]?.execution_native.service_lifecycle_constraints?.[0]?.must_survive_agent_exit, true);

    const experience = await app.inject({
      method: "POST",
      url: "/v1/memory/experience/intelligence",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair preview server and keep validation alive after agent exit",
        context: {
          goal: "repair preview server and keep validation alive after agent exit",
        },
        candidates: ["bash", "edit", "test"],
        trajectory: payload.trajectory,
        trajectory_hints: payload.trajectory_hints,
      },
    });
    assert.equal(experience.statusCode, 200, experience.body);
    const experienceBody = ExperienceIntelligenceResponseSchema.parse(JSON.parse(experience.body));
    const trace = experienceBody.experience_adaptation_trace;
    assert.equal(trace.summary_version, "execution_experience_adaptation_trace_v1");
    assert.equal(trace.trajectory.present, true);
    assert.equal(trace.trajectory.compiled, true);
    assert.equal(trace.trajectory.task_family, "service_publish_validate");
    assert.ok(trace.trajectory.workflow_signature);
    assert.equal(trace.experience_sources.candidate_workflow_count, 1);
    assert.equal(trace.task_decomposition.task_family, "service_publish_validate");
    assert.equal(trace.retrieval.path_source_kind, "candidate_workflow");
    assert.ok(trace.retrieval.evidence_entry_count >= 1);
    assert.equal(trace.adaptation.activation_state, "active");
    assert.ok(trace.adaptation.selected_candidate_ids.length >= 1);
    assert.equal(trace.adaptation.promotion_requires_candidate_binding, true);
    assert.ok(trace.stages.some((stage) => stage.stage === "feedback_attribution" && stage.status === "ready"));

    const secondStore = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: buildHandoffPayload({
        stateId: `state:${randomUUID()}`,
        title: "Preview server recovery handoff second run",
        summary: "Repair preview server and keep validation alive after agent exit",
        filePath: "scripts/export-preview.ts",
        trajectory: payload.trajectory,
        trajectoryHints: payload.trajectory_hints,
      }),
    });
    assert.equal(secondStore.statusCode, 200);

    const secondPlanning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "repair preview server and keep validation alive after agent exit",
        context: {
          goal: "repair preview server and keep validation alive after agent exit",
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(secondPlanning.statusCode, 200);

    const stableRows = await liteWriteStore.findExecutionNativeNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      executionKind: "workflow_anchor",
      limit: 8,
      offset: 0,
    });
    assert.equal(stableRows.rows.length, 1);
    assert.equal(stableRows.rows[0]?.execution_native.task_family, "service_publish_validate");
    assert.deepEqual(
      [...(stableRows.rows[0]?.execution_native.target_files ?? [])].sort(),
      ["package.json", "scripts/export-preview.ts"],
    );
    assert.equal(stableRows.rows[0]?.slots.execution_contract_v1?.schema_version, "execution_contract_v1");
    assert.deepEqual(
      [...(stableRows.rows[0]?.slots.execution_contract_v1?.target_files ?? [])].sort(),
      ["package.json", "scripts/export-preview.ts"],
    );
    assert.ok(stableRows.rows[0]?.execution_native.workflow_steps?.some((step) => step.includes("python -m http.server 8080")));
    assert.ok(stableRows.rows[0]?.execution_native.pattern_hints?.includes("revalidate_service_from_fresh_shell"));
    assert.equal(stableRows.rows[0]?.execution_native.service_lifecycle_constraints?.[0]?.must_survive_agent_exit, true);
    assert.equal(
      ((stableRows.rows[0]?.slots?.anchor_v1 as any)?.service_lifecycle_constraints?.[0]?.detach_then_probe) ?? false,
      true,
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});
