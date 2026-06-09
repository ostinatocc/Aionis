import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import {
  applyExecutionTreeOperationV1,
  createExecutionTreeV1,
  createLiteExecutionTreeStore,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "../../src/execution/index.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-execution-evidence-context-"));
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
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    LEARNING_CONTROL_MODEL_CLIENT_BASE_URL: "",
    LEARNING_CONTROL_MODEL_CLIENT_API_KEY: "",
    LEARNING_CONTROL_MODEL_CLIENT_MODEL: "",
    LEARNING_CONTROL_MODEL_CLIENT_TRANSPORT: "auto",
    LEARNING_CONTROL_MODEL_CLIENT_OPENAI_EXTRA_BODY_JSON: "",
    REPLAY_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    REPLAY_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    TOOLS_LEARNING_CONTROL_HTTP_MODEL_FORM_PATTERN_PROVIDER_ENABLED: false,
    TOOLS_LEARNING_CONTROL_EVIDENCE_FORM_PATTERN_PROVIDER_ENABLED: false,
    ...overrides,
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
  executionTreeStore: ReturnType<typeof createLiteExecutionTreeStore>;
}) {
  const env = buildEnv();
  const guards = createRequestGuards({
    env,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });

  registerRuntimeErrorHandler(args.app);
  registerMemoryWriteRoutes({
    app: args.app,
    env,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: null,
    executionTreeStore: args.executionTreeStore,
  });

  registerMemoryAccessRoutes({
    app: args.app,
    env,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    executionTreeStore: args.executionTreeStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

function op(tree: ExecutionTreeV1, operation: Omit<ExecutionTreeOperationV1, "tree_id" | "scope">): ExecutionTreeV1 {
  return applyExecutionTreeOperationV1(tree, {
    ...operation,
    tree_id: tree.tree_id,
    scope: tree.scope,
  } as ExecutionTreeOperationV1);
}

function buildRevisedTree(): ExecutionTreeV1 {
  let tree = createExecutionTreeV1({
    tree_id: "execution-tree:evidence-context-route",
    scope: "aionis://execution/evidence-context-route",
    task_brief: "Solve a long-horizon benchmark task without reusing failed attempts.",
    at: "2026-06-08T00:00:00.000Z",
  });
  tree = op(tree, {
    type: "grow",
    operation_id: "grow-wrong-candidate",
    actor_role: "worker",
    at: "2026-06-08T00:01:00.000Z",
    action: "Try FAILED_TREE_MARKER candidate formula A",
    observation: "Formula A double-counts the tax component on validation row 2.",
    title: "Wrong candidate",
    refs: ["trace://candidate-a/raw"],
  });
  tree = op(tree, {
    type: "compress",
    operation_id: "compress-wrong-candidate",
    actor_role: "worker",
    at: "2026-06-08T00:02:00.000Z",
    title: "FAILED_TREE_MARKER formula A",
    summary: "FAILED_TREE_MARKER formula A looked plausible but double-counted tax.",
  });
  const failedSummaryNodeId = tree.current_summary_node_id;
  tree = op(tree, {
    type: "maintain",
    operation_id: "maintain-wrong-candidate",
    actor_role: "verifier",
    at: "2026-06-08T00:03:00.000Z",
    passed: false,
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "FAILED_TREE_MARKER validation rejected formula A.",
  });
  tree = op(tree, {
    type: "revise",
    operation_id: "revise-wrong-candidate",
    actor_role: "worker",
    at: "2026-06-08T00:04:00.000Z",
    target_summary_node_id: failedSummaryNodeId,
    diagnostic_note: "FAILED_TREE_MARKER abandon formula A and branch from root.",
  });
  tree = op(tree, {
    type: "grow",
    operation_id: "grow-passed-candidate",
    actor_role: "worker",
    at: "2026-06-08T00:05:00.000Z",
    action: "Use formula B after removing duplicated tax.",
    observation: "Formula B matches all validation rows.",
    title: "Passed candidate",
    refs: ["trace://candidate-b/raw"],
  });
  tree = op(tree, {
    type: "compress",
    operation_id: "compress-passed-candidate",
    actor_role: "worker",
    at: "2026-06-08T00:06:00.000Z",
    title: "PASSED_ACTIVE_PATH formula B",
    summary: "PASSED_ACTIVE_PATH formula B computes subtotal + single tax + shipping.",
  });
  tree = op(tree, {
    type: "maintain",
    operation_id: "maintain-passed-candidate",
    actor_role: "verifier",
    at: "2026-06-08T00:07:00.000Z",
    passed: true,
    target_summary_node_id: tree.current_summary_node_id,
    diagnostic_note: null,
  });
  return tree;
}

async function post(app: ReturnType<typeof Fastify>, url: string, payload: unknown) {
  const res = await app.inject({
    method: "POST",
    url,
    payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as any;
}

test("execution context assemble separates passed solutions, failed branches, and active path", async () => {
  const dbPath = tmpDbPath("route");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const app = Fastify();
  registerApp({ app, liteWriteStore, liteRecallStore, executionTreeStore });
  const tree = buildRevisedTree();
  executionTreeStore.put(tree);

  await post(app, "/v1/memory/write", {
    tenant_id: "default",
    scope: "default",
    input_text: "Execution evidence context route fixture.",
    auto_embed: false,
    memory_lane: "private",
    nodes: [
      {
        client_id: "passed-solution-context-route",
        type: "event",
        title: "Passed solution evidence",
        text_summary: "PASSED_SOLUTIONS_MARKER formula B was verified on all validation rows.",
        raw_ref: "raw://passed-solution",
        evidence_ref: "evidence://passed-solution",
        slots: {
          task_signature: "execution-context-route",
          execution_result_summary: {
            status: "passed",
            summary: "PASSED_SOLUTIONS_MARKER use formula B: subtotal + single tax + shipping.",
            evidence_refs: ["trace://passed-solution/verifier"],
          },
          execution_evidence: [
            { ref: "trace://passed-solution/verifier", kind: "verification" },
          ],
        },
      },
      {
        client_id: "failed-branch-context-route",
        type: "event",
        title: "Failed branch evidence",
        text_summary: "FAILED_MEMORY_MARKER formula A failed validation.",
        evidence_ref: "evidence://failed-branch",
        slots: {
          task_signature: "execution-context-route",
          execution_result_summary: {
            status: "failed",
            summary: "FAILED_MEMORY_MARKER do not reuse formula A.",
            diagnostic_note: "FAILED_MEMORY_MARKER formula A double-counts tax.",
            evidence_refs: ["trace://failed-branch/verifier"],
          },
        },
      },
      {
        client_id: "negated-failure-boundary-context-route",
        type: "event",
        title: "Negated failure wording",
        text_summary: "NEGATED_FAILURE_MARKER no failure detected wording should not be a failed branch.",
        slots: {
          task_signature: "execution-context-route",
          execution_result_summary: {
            status: "no failure detected",
            summary: "NEGATED_FAILURE_MARKER parser boundary text.",
          },
        },
      },
    ],
    edges: [],
  });

  const body = await post(app, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    tree_id: tree.tree_id,
    tree_scope: tree.scope,
    memory_filters: [
      {
        type: "event",
        slots_contains: { task_signature: "execution-context-route" },
        limit: 20,
      },
    ],
  });

  assert.equal(body.contract_version, "execution_evidence_context_v1");
  assert.equal(body.tree.present, true);
  assert.equal(body.tree.source, "store");
  assert.ok(
    body.current_active_path.compressed_state.some((entry: any) => String(entry.summary).includes("PASSED_ACTIVE_PATH")),
    "active path must contain the repaired passed summary",
  );
  assert.ok(
    body.passed_solutions.some((entry: any) => String(entry.summary).includes("PASSED_SOLUTIONS_MARKER")),
    "passed solution evidence must be promoted into PASSED_SOLUTIONS",
  );
  const failedSerialized = JSON.stringify(body.failed_branches);
  assert.match(failedSerialized, /FAILED_TREE_MARKER/);
  assert.match(failedSerialized, /trace:\/\/candidate-a\/raw/);
  assert.match(failedSerialized, /FAILED_MEMORY_MARKER/);
  assert.doesNotMatch(failedSerialized, /NEGATED_FAILURE_MARKER/);
  assert.match(body.prompt_text, /CURRENT_ACTIVE_PATH/);
  assert.match(body.prompt_text, /PASSED_SOLUTIONS/);
  assert.match(body.prompt_text, /EPISODIC_TRACES/);
  assert.match(body.prompt_text, /trace:\/\/candidate-b\/raw/);
  assert.match(body.prompt_text, /FAILED_BRANCHES/);
  assert.match(JSON.stringify(body.rehydration_refs), /trace:\/\/passed-solution\/verifier/);
  assert.match(JSON.stringify(body.rehydration_refs), /trace:\/\/candidate-b\/raw/);
  assert.ok(body.selection_trace.raw_trace_count >= 2);
  assert.ok(body.selection_trace.evidence_backed_passed_solution_count >= 1);
  assert.ok(body.selection_trace.evidence_backed_failed_branch_count >= 1);
  assert.ok(body.selection_trace.raw_trace_backed_passed_solution_count >= 1);
  assert.ok(body.selection_trace.raw_trace_backed_failed_branch_count >= 1);

  await app.close();
});

test("execution context assemble promotes validated active tree nodes without memory evidence", async () => {
  const dbPath = tmpDbPath("tree-passed-solutions");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const app = Fastify();
  registerApp({ app, liteWriteStore, liteRecallStore, executionTreeStore });
  const tree = buildRevisedTree();
  executionTreeStore.put(tree);

  const body = await post(app, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    tree_id: tree.tree_id,
    tree_scope: tree.scope,
    include_memory_evidence: false,
    max_validated_evidence: 4,
  });

  assert.equal(body.selection_trace.memory_enabled, false);
  assert.equal(body.selection_trace.memory_nodes_considered, 0);
  assert.ok(
    body.passed_solutions.some((entry: any) =>
      entry.source === "execution_tree"
      && String(entry.summary).includes("PASSED_ACTIVE_PATH formula B")
      && entry.validated === true
      && Array.isArray(entry.supporting_raw_refs)
      && entry.supporting_raw_refs.includes("trace://candidate-b/raw")
      && Array.isArray(entry.supporting_raw_trace)
      && entry.supporting_raw_trace.some((trace: any) => String(trace.action).includes("Use formula B"))
    ),
    "validated active tree summary must be promoted into PASSED_SOLUTIONS without memory evidence",
  );
  assert.equal(body.validated_evidence.length, body.passed_solutions.length);
  assert.doesNotMatch(JSON.stringify(body.passed_solutions), /FAILED_TREE_MARKER/);
  assert.match(body.prompt_text, /PASSED_SOLUTIONS[\s\S]*PASSED_ACTIVE_PATH formula B/);
  assert.match(body.prompt_text, /EPISODIC_TRACES[\s\S]*Use formula B after removing duplicated tax/);
  assert.match(body.prompt_text, /FAILED_BRANCHES[\s\S]*FAILED_TREE_MARKER/);
  assert.match(JSON.stringify(body.failed_branches), /trace:\/\/candidate-a\/raw/);
  assert.equal(body.selection_trace.evidence_backed_passed_solution_count, 1);
  assert.equal(body.selection_trace.raw_trace_backed_passed_solution_count, 1);
  assert.ok(body.selection_trace.failed_branch_raw_trace_count >= 1);
  assert.ok(body.selection_trace.evidence_backed_failed_branch_count >= 1);
  assert.ok(body.selection_trace.raw_trace_backed_failed_branch_count >= 1);

  await app.close();
});

test("execution context consolidation guard keeps summary-only execution memory supporting-only", async () => {
  const dbPath = tmpDbPath("summary-only-guard");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const app = Fastify();
  registerApp({ app, liteWriteStore, liteRecallStore, executionTreeStore });

  await post(app, "/v1/memory/write", {
    tenant_id: "default",
    scope: "default",
    input_text: "Summary-only execution memories without raw or evidence refs.",
    auto_embed: false,
    memory_lane: "private",
    nodes: [
      {
        client_id: "summary-only-passed-memory",
        type: "event",
        title: "Summary-only passed memory",
        text_summary: "SUMMARY_ONLY_PASSED_MARKER claims formula C passed without raw backing.",
        slots: {
          task_signature: "summary-only-consolidation-guard",
          execution_result_summary: {
            status: "passed",
            summary: "SUMMARY_ONLY_PASSED_MARKER formula C allegedly passed.",
          },
        },
      },
      {
        client_id: "summary-only-failed-memory",
        type: "event",
        title: "Summary-only failed memory",
        text_summary: "SUMMARY_ONLY_FAILED_MARKER claims formula D failed without raw backing.",
        slots: {
          task_signature: "summary-only-consolidation-guard",
          execution_result_summary: {
            status: "failed",
            summary: "SUMMARY_ONLY_FAILED_MARKER formula D allegedly failed.",
            diagnostic_note: "SUMMARY_ONLY_FAILED_MARKER no raw verifier trace attached.",
          },
        },
      },
    ],
    edges: [],
  });

  const body = await post(app, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    memory_filters: [
      {
        slots_contains: { task_signature: "summary-only-consolidation-guard" },
        limit: 20,
      },
    ],
  });

  assert.equal(body.tree.present, false);
  assert.deepEqual(body.passed_solutions, []);
  assert.deepEqual(body.failed_branches, []);
  assert.equal(body.supporting_evidence.length, 2);
  assert.match(JSON.stringify(body.supporting_evidence), /SUMMARY_ONLY_PASSED_MARKER/);
  assert.match(JSON.stringify(body.supporting_evidence), /SUMMARY_ONLY_FAILED_MARKER/);
  assert.ok(body.supporting_evidence.every((entry: any) => entry.promotion_blocked === true));
  assert.ok(body.supporting_evidence.every((entry: any) =>
    entry.promotion_blocked_reason === "memory_execution_summary_without_raw_or_evidence_refs"
  ));
  assert.match(body.prompt_text, /PASSED_SOLUTIONS\n- none/);
  assert.match(body.prompt_text, /FAILED_BRANCHES\n- none/);
  assert.match(body.prompt_text, /SUPPORTING_EVIDENCE[\s\S]*promotion_blocked=memory_execution_summary_without_raw_or_evidence_refs/);
  assert.equal(body.selection_trace.memory_consolidation_guard_blocked_count, 2);
  assert.equal(body.selection_trace.evidence_backed_passed_solution_count, 0);
  assert.equal(body.selection_trace.evidence_backed_failed_branch_count, 0);

  await app.close();
});

test("ordinary preference and fact memory does not create execution tree context", async () => {
  const dbPath = tmpDbPath("negative");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const app = Fastify();
  registerApp({ app, liteWriteStore, liteRecallStore, executionTreeStore });

  assert.equal(executionTreeStore.listByScope("default").length, 0);
  await post(app, "/v1/memory/write", {
    tenant_id: "default",
    scope: "default",
    input_text: "Ordinary preference and fact memories without execution outcome.",
    auto_embed: false,
    memory_lane: "private",
    nodes: [
      {
        client_id: "ordinary-preference-memory",
        type: "rule",
        title: "Preference memory",
        text_summary: "Prefer concise benchmark reports.",
        slots: {
          task_signature: "ordinary-memory-negative-control",
          category: "preference",
        },
      },
      {
        client_id: "ordinary-fact-memory",
        type: "concept",
        title: "Fact memory",
        text_summary: "The local benchmark folder is named Mgbench.",
        slots: {
          task_signature: "ordinary-memory-negative-control",
          wording: "no failure detected in this generic note",
        },
      },
    ],
    edges: [],
  });
  assert.equal(executionTreeStore.listByScope("default").length, 0);

  const body = await post(app, "/v1/execution/context/assemble", {
    tenant_id: "default",
    scope: "default",
    memory_filters: [
      {
        slots_contains: { task_signature: "ordinary-memory-negative-control" },
        limit: 20,
      },
    ],
  });

  assert.equal(body.tree.present, false);
  assert.deepEqual(body.current_active_path.compressed_state, []);
  assert.deepEqual(body.current_active_path.raw_state, []);
  assert.deepEqual(body.passed_solutions, []);
  assert.deepEqual(body.failed_branches, []);
  assert.equal(body.supporting_evidence.length, 2);
  assert.match(body.prompt_text, /FAILED_BRANCHES\n- none/);
  assert.equal(body.selection_trace.raw_trace_count, 0);
  assert.equal(body.selection_trace.evidence_backed_passed_solution_count, 0);
  assert.equal(body.selection_trace.evidence_backed_failed_branch_count, 0);
  assert.equal(body.selection_trace.raw_trace_backed_passed_solution_count, 0);
  assert.equal(body.selection_trace.raw_trace_backed_failed_branch_count, 0);

  await app.close();
});
