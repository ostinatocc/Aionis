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
import {
  PolicyMutationAdjudicationV1Schema,
  PolicyMutationV1Schema,
} from "../../src/kernel/policy-mutation-loop.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerMemoryWriteRoutes } from "../../src/routes/memory-write.ts";
import {
  ExecutionMemoryIntrospectionResponseSchema,
  PlanningContextRouteContractSchema,
  PromotionEvidenceLedgerV1Schema,
} from "../../src/memory/schemas.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import {
  createExecutionTreeV1,
  createLiteExecutionTreeStore,
  type ExecutionTreeOperationV1,
} from "../../src/execution/index.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-write-workflow-projection-"));
  return path.join(dir, `${name}.sqlite`);
}

function countExecutionTreeRows(dbPath: string): number {
  const db = createSqliteDatabase(dbPath);
  try {
    const row = db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM lite_execution_trees").get();
    return Number(row.count);
  } finally {
    db.close();
  }
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
    RUNTIME_VERIFIER_EXECUTION_ENABLED: false,
    ...overrides,
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
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
  registerMemoryWriteRoutes({
    app: args.app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: null,
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
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

function buildExecutionWritePayload(args: {
  eventId: string;
  title: string;
  inputText: string;
  taskBrief: string;
  stateId: string;
  filePath: string;
  modifiedFiles: string[];
  ownedFiles?: string[];
  pendingValidations?: string[];
  contractTrust?: "authoritative" | "advisory" | "observational";
  serviceLifecycleConstraints?: Array<Record<string, unknown>>;
  executionResultSummary?: Record<string, unknown>;
  executionEvidence?: Array<Record<string, unknown>>;
  workflowPromotionLearningControlReview?: Record<string, unknown>;
}) {
  const updatedAt = "2026-03-21T12:00:00.000Z";
  const pendingValidations = args.pendingValidations ?? ["npm run -s test:lite -- export"];
  return {
    tenant_id: "default",
    scope: "default",
    input_text: args.inputText,
    auto_embed: true,
    memory_lane: "private",
    nodes: [
      {
        client_id: `execution-event:${args.eventId}`,
        type: "event",
        title: args.title,
        text_summary: args.taskBrief,
        slots: {
          summary_kind: "handoff",
          ...(args.contractTrust ? { contract_trust: args.contractTrust } : {}),
          execution_state_v1: {
            version: 1,
            state_id: args.stateId,
            scope: `aionis://execution/${args.stateId}`,
            task_brief: args.taskBrief,
            current_stage: "patch",
            active_role: "patch",
            owned_files: args.ownedFiles ?? [],
            modified_files: args.modifiedFiles,
            pending_validations: pendingValidations,
            completed_validations: [],
            last_accepted_hypothesis: null,
            rejected_paths: [],
            unresolved_blockers: [],
            rollback_notes: [],
            service_lifecycle_constraints: args.serviceLifecycleConstraints ?? [],
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
            task_brief: args.taskBrief,
            target_files: args.modifiedFiles,
            next_action: `Patch ${args.filePath} and rerun export tests`,
            hard_constraints: [],
            accepted_facts: [],
            rejected_paths: [],
            pending_validations: pendingValidations,
            unresolved_blockers: [],
            rollback_notes: [],
            service_lifecycle_constraints: args.serviceLifecycleConstraints ?? [],
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
          ...(args.executionResultSummary
            ? { execution_result_summary: args.executionResultSummary }
            : {}),
          ...(args.executionEvidence
            ? { execution_evidence: args.executionEvidence }
            : {}),
          ...(args.workflowPromotionLearningControlReview
            ? { workflow_promotion_learning_control_review: args.workflowPromotionLearningControlReview }
            : {}),
        },
      },
    ],
    edges: [],
  };
}

function buildPacketOnlyWritePayload(args: {
  eventId: string;
  title: string;
  inputText: string;
  taskBrief: string;
  stateId: string;
  filePath: string;
  targetFiles: string[];
}) {
  return {
    tenant_id: "default",
    scope: "default",
    input_text: args.inputText,
    auto_embed: true,
    memory_lane: "private",
    nodes: [
      {
        client_id: `packet-only-event:${args.eventId}`,
        type: "event",
        title: args.title,
        text_summary: args.taskBrief,
        slots: {
          summary_kind: "handoff",
          execution_packet_v1: {
            version: 1,
            state_id: args.stateId,
            current_stage: "patch",
            active_role: "patch",
            task_brief: args.taskBrief,
            target_files: args.targetFiles,
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
        },
      },
    ],
    edges: [],
  };
}

function buildLightweightHandoffWritePayload(args: {
  eventId: string;
  title: string;
  inputText: string;
  taskBrief: string;
  filePath: string;
  targetFiles: string[];
}) {
  return {
    tenant_id: "default",
    scope: "default",
    input_text: args.inputText,
    auto_embed: true,
    memory_lane: "private",
    nodes: [
      {
        client_id: `lightweight-handoff-event:${args.eventId}`,
        type: "event",
        title: args.title,
        text_summary: args.taskBrief,
        slots: {
          summary_kind: "handoff",
          handoff_kind: "patch_handoff",
          anchor: `resume:${args.filePath}`,
          file_path: args.filePath,
          repo_root: "/Volumes/ziel/Aionisgo",
          target_files: args.targetFiles,
          next_action: `Patch ${args.filePath} and rerun export tests`,
          acceptance_checks: ["npm run -s test:lite -- export"],
        },
      },
    ],
    edges: [],
  };
}

function passedExecutionEvidence(ref: string): {
  executionResultSummary: Record<string, unknown>;
  executionEvidence: Array<Record<string, unknown>>;
} {
  return {
    executionResultSummary: {
      status: "passed",
      summary: "Validation completed successfully.",
      validation_passed: true,
    },
    executionEvidence: [{
      ref,
      validation_passed: true,
    }],
  };
}

function serviceLifecycleConstraint(): Record<string, unknown> {
  return {
    version: 1,
    service_kind: "http",
    label: "service:http://127.0.0.1:8080/health",
    launch_reference: "nohup npm run start > /tmp/aionis-service.log 2>&1 &",
    endpoint: "http://127.0.0.1:8080/health",
    must_survive_agent_exit: true,
    revalidate_from_fresh_shell: true,
    detach_then_probe: true,
    health_checks: ["curl -fsS http://127.0.0.1:8080/health"],
    teardown_notes: [],
  };
}

function runtimeVerifierCommand() {
  return `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`;
}

function runtimeVerifierServiceConstraint(command = runtimeVerifierCommand()): Record<string, unknown> {
  return {
    version: 1,
    service_kind: "process",
    label: "runtime-verifier-parent-proof",
    launch_reference: "launchctl bootstrap gui/501 /tmp/com.aionis.runtime-verifier.plist",
    endpoint: null,
    must_survive_agent_exit: true,
    revalidate_from_fresh_shell: true,
    detach_then_probe: true,
    health_checks: [command],
    teardown_notes: [],
  };
}

function runtimeVerifierExecutionPacket(args: {
  stateId: string;
  taskBrief: string;
  filePath: string;
  command?: string;
}) {
  const command = args.command ?? runtimeVerifierCommand();
  const serviceConstraint = runtimeVerifierServiceConstraint(command);
  return {
    version: 1,
    state_id: args.stateId,
    current_stage: "review",
    active_role: "review",
    task_brief: args.taskBrief,
    target_files: [args.filePath],
    next_action: `Verify ${args.filePath} from the runtime parent after the agent exits.`,
    hard_constraints: ["do not trust agent self-verification for after-exit service proof"],
    accepted_facts: [],
    rejected_paths: [],
    pending_validations: [command],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [serviceConstraint],
    review_contract: null,
    resume_anchor: {
      anchor: `resume:${args.filePath}`,
      file_path: args.filePath,
      symbol: null,
      repo_root: "/Volumes/ziel/Aionisgo",
    },
    artifact_refs: [],
    evidence_refs: ["agent:return:claimed_success"],
  };
}

async function runtimeVerifierEvidenceFromPlanning(args: {
  app: ReturnType<typeof Fastify>;
  stateId: string;
  taskBrief: string;
  filePath: string;
  command?: string;
}) {
  const response = await args.app.inject({
    method: "POST",
    url: "/v1/memory/planning/context",
    payload: {
      tenant_id: "default",
      scope: "default",
      query_text: args.taskBrief,
      context: {},
      tool_candidates: ["bash", "test"],
      execution_packet_v1: runtimeVerifierExecutionPacket({
        stateId: args.stateId,
        taskBrief: args.taskBrief,
        filePath: args.filePath,
        command: args.command,
      }),
      runtime_verification: {
        mode: "execute",
        agent_lifecycle_state: "agent_exited",
        agent_claimed_success: true,
        timeout_ms: 10_000,
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = PlanningContextRouteContractSchema.parse(response.json());
  const runtimeVerification = body.execution_kernel.runtime_verification;
  assert.ok(runtimeVerification);
  assert.equal(runtimeVerification.execution_state, "executed", JSON.stringify(runtimeVerification.blocked_requests));
  assert.equal(runtimeVerification.summary.authoritative_evidence_ready, true);
  assert.ok(runtimeVerification.evidence_for_trust_gate);
  return runtimeVerification.evidence_for_trust_gate as Record<string, unknown>;
}

function memoryWriteTreeOperation(
  input: Omit<ExecutionTreeOperationV1, "tree_id" | "scope" | "actor_role">,
): ExecutionTreeOperationV1 {
  return {
    tree_id: "tree-memory-write-runtime",
    scope: "aionis://execution-tree/memory-write-runtime",
    actor_role: "patch",
    ...input,
  } as ExecutionTreeOperationV1;
}

test("memory/write persists execution tree slots through runtime side effects", async () => {
  const dbPath = tmpDbPath("write-execution-tree");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const executionTreeStore = createLiteExecutionTreeStore(dbPath);
  const tree = createExecutionTreeV1({
    tree_id: "tree-memory-write-runtime",
    scope: "aionis://execution-tree/memory-write-runtime",
    task_brief: "Persist execution tree through memory write",
    at: "2026-03-21T12:00:00.000Z",
  });
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      executionTreeStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "Persist execution tree continuity through normal memory write.",
        execution_tree_disabled: true,
        memory_lane: "private",
        nodes: [{
          client_id: "execution-tree-write-event",
          type: "event",
          title: "Execution tree write",
          text_summary: "Tree slots should update the tree store",
          slots: {
            execution_tree_v1: tree,
            execution_tree_operations_v1: [
              memoryWriteTreeOperation({
                operation_id: "memory-write-tree-grow-1",
                type: "grow",
                at: "2026-03-21T12:01:00.000Z",
                action: "inspect memory write tree slot",
                observation: "normal memory write applied the execution tree operation",
                title: null,
                tool_name: "bash",
                refs: [],
              }),
            ],
          },
        }],
        edges: [],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const stored = executionTreeStore.get(tree.scope, tree.tree_id);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.tree.nodes[stored.tree.current_raw_node_id]?.content.action, "inspect memory write tree slot");
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("memory/write auto-creates execution tree from execution continuity slots", async () => {
  const dbPath = tmpDbPath("write-auto-execution-tree");
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: "auto-tree-write-event",
        title: "Auto execution tree write",
        inputText: "Persist implicit execution tree continuity through normal memory write.",
        taskBrief: "Auto-create execution tree from continuity slots",
        stateId: "state:auto-memory-write-tree",
        filePath: "src/routes/auto-tree-write.ts",
        modifiedFiles: ["src/routes/auto-tree-write.ts"],
        pendingValidations: [],
        executionResultSummary: {
          status: "passed",
          summary: "Memory write continuity generated a branch-aware tree.",
        },
      }),
    });
    assert.equal(response.statusCode, 200, response.body);
    const stored = executionTreeStore.get(
      "aionis://execution/state:auto-memory-write-tree",
      "execution-tree:state:auto-memory-write-tree",
    );
    assert.equal(stored?.revision, 4);
    assert.equal(stored?.tree.current_summary_node_id, "summary:2");
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("memory/write does not auto-create execution tree for ordinary preference fact or general memory", async () => {
  const dbPath = tmpDbPath("write-ordinary-memory-no-execution-tree");
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

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: {
        tenant_id: "default",
        scope: "default",
        input_text: "Record ordinary user preference, project fact, and general context without execution state.",
        auto_embed: true,
        memory_lane: "private",
        nodes: [
          {
            client_id: "ordinary-preference-no-tree",
            type: "rule",
            title: "User response preference",
            text_summary: "The user prefers concise status summaries.",
            slots: {
              memory_type: "preference",
              preference: "concise status summaries",
              source: "user_stated",
            },
          },
          {
            client_id: "ordinary-fact-no-tree",
            type: "concept",
            title: "Runtime project fact",
            text_summary: "Aionis Runtime is the local memory runtime under test.",
            slots: {
              memory_type: "fact",
              fact_scope: "project",
              source: "operator_note",
            },
          },
          {
            client_id: "ordinary-general-context-no-tree",
            type: "entity",
            title: "General project context",
            text_summary: "General memory can be recalled without becoming execution state.",
            slots: {
              memory_type: "general",
              topic: "runtime memory",
              source: "operator_note",
            },
          },
        ],
        edges: [],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.nodes.length, 3);
    assert.equal(countExecutionTreeRows(dbPath), 0);
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("memory/write respects root execution_tree_disabled for default auto tree", async () => {
  const dbPath = tmpDbPath("write-auto-execution-tree-disabled");
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
      ...buildExecutionWritePayload({
        eventId: "auto-tree-write-disabled-event",
        title: "Disabled auto execution tree write",
        inputText: "Persist execution continuity without default tree side effects.",
        taskBrief: "Do not auto-create execution tree when request disables defaults",
        stateId: "state:auto-memory-write-tree-disabled",
        filePath: "src/routes/auto-tree-write-disabled.ts",
        modifiedFiles: ["src/routes/auto-tree-write-disabled.ts"],
        pendingValidations: [],
        executionResultSummary: {
          status: "passed",
          summary: "Memory write continuity stayed available without automatic tree storage.",
        },
      }),
      execution_tree_disabled: true,
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.ok(body.nodes.length > 0);
    assert.equal(
      executionTreeStore.get(
        "aionis://execution/state:auto-memory-write-tree-disabled",
        "execution-tree:state:auto-memory-write-tree-disabled",
      ),
      null,
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("memory/write respects EXECUTION_TREE_DEFAULT_ENABLED=false for default auto tree", async () => {
  const dbPath = tmpDbPath("write-auto-execution-tree-env-disabled");
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
      envOverrides: { EXECUTION_TREE_DEFAULT_ENABLED: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: "auto-tree-write-env-disabled-event",
        title: "Env disabled auto execution tree write",
        inputText: "Persist execution continuity while environment disables default tree side effects.",
        taskBrief: "Do not auto-create execution tree when environment disables defaults",
        stateId: "state:auto-memory-write-tree-env-disabled",
        filePath: "src/routes/auto-tree-write-env-disabled.ts",
        modifiedFiles: ["src/routes/auto-tree-write-env-disabled.ts"],
        pendingValidations: [],
        executionResultSummary: {
          status: "passed",
          summary: "Memory write continuity stayed available while environment disabled automatic tree storage.",
        },
      }),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      executionTreeStore.get(
        "aionis://execution/state:auto-memory-write-tree-env-disabled",
        "execution-tree:state:auto-memory-write-tree-env-disabled",
      ),
      null,
    );
  } finally {
    await app.close();
    await liteWriteStore.close();
    await liteRecallStore.close();
    await executionTreeStore.close();
  }
});

test("memory/write keeps workflow candidates promotion-ready until learning_control admits stable workflow promotion", async () => {
  const dbPath = tmpDbPath("projection");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver",
        inputText: "continue fixing export resolver",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "authoritative",
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

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
    assert.equal(firstBody.workflow_signals.length, 1);
    assert.equal(firstBody.workflow_signals[0]?.promotion_ready, false);
    assert.match(firstBody.planning_summary.planner_explanation, /candidate workflows visible but not yet promoted/i);
    assert.ok(!("layered_context" in (firstBody as Record<string, unknown>)));

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver again",
        inputText: "continue fixing export resolver second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
      }),
    });
    assert.equal(secondWrite.statusCode, 200);
    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const stableWorkflowNode = storedStable.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      return projection?.auto_promoted === true;
    }) ?? null;
    assert.equal(stableWorkflowNode, null);
    const storedCandidates = await liteWriteStore.findNodes({
      scope: "default",
      type: "event",
      slotsContains: {
        summary_kind: "workflow_candidate",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const latestCandidate = storedCandidates.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      return projection?.source_node_id != null;
    }) ?? null;
    assert.ok(latestCandidate);
    const candidateProjection = (latestCandidate?.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (candidateProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const reviewPacket = (promotePreview.review_packet ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;
    const policyEffect = (promotePreview.policy_effect ?? {}) as Record<string, unknown>;
    assert.equal(reviewPacket.operation, "promote_memory");
    assert.equal(reviewPacket.requested_target_kind, "workflow");
    assert.equal(reviewPacket.requested_target_level, "L2");
    assert.equal(decisionTrace.review_supplied, false);
    assert.deepEqual(decisionTrace.stage_order, ["review_packet_built", "policy_effect_derived"]);
    assert.equal(policyEffect.applies, false);
    assert.equal(policyEffect.reason_code, "review_not_supplied");

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
    assert.equal(secondBody.planner_packet.sections.recommended_workflows.length, 0);
    assert.equal(secondBody.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(secondBody.workflow_signals.length, 1);
    assert.equal(secondBody.workflow_signals[0]?.promotion_state, "candidate");
    assert.equal(secondBody.workflow_signals[0]?.promotion_ready, true);
    assert.match(secondBody.planning_summary.planner_explanation, /promotion-ready workflow candidates:/i);

    const introspectAfterSecondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });
    assert.equal(introspectAfterSecondWrite.statusCode, 200);
    const introspectBody = ExecutionMemoryIntrospectionResponseSchema.parse(introspectAfterSecondWrite.json());
    assert.equal(introspectBody.recommended_workflows.length, 0);
    assert.equal(introspectBody.candidate_workflows.length, 1);
    assert.equal(introspectBody.workflow_signal_summary.stable_workflow_count, 0);
    assert.equal(introspectBody.workflow_signal_summary.promotion_ready_workflow_count, 1);
    assert.equal(introspectBody.inventory.raw_workflow_candidate_count, 2);
    assert.equal(introspectBody.inventory.suppressed_candidate_workflow_count, 1);
    assert.equal((introspectBody.candidate_workflows[0] as any)?.distillation_origin, "execution_write_projection");
    assert.equal((introspectBody.candidate_workflows[0] as any)?.preferred_promotion_target, "workflow");

    const fixedSourcePayload = buildExecutionWritePayload({
      eventId: "fixed-source-event",
      title: "Patch export resolver retry",
      inputText: "continue fixing export resolver retry",
      taskBrief: "Recover durable workflow from failed validation",
      stateId: "state:fixed-retry",
      filePath: "src/routes/export.ts",
      modifiedFiles: ["src/routes/export.ts"],
    });

    const initialFixedSourceWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: fixedSourcePayload,
    });
    assert.equal(initialFixedSourceWrite.statusCode, 200);

    const retryWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: fixedSourcePayload,
    });
    assert.equal(retryWrite.statusCode, 200);

    const retryIntrospect = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });
    assert.equal(retryIntrospect.statusCode, 200);
    const retryBody = ExecutionMemoryIntrospectionResponseSchema.parse(retryIntrospect.json());
    assert.equal(retryBody.recommended_workflows.length, 0);
    assert.equal(retryBody.candidate_workflows.length, 1);
    assert.equal(retryBody.workflow_signal_summary.stable_workflow_count, 0);
    assert.equal(retryBody.workflow_signal_summary.promotion_ready_workflow_count, 1);
    assert.equal(retryBody.inventory.raw_workflow_candidate_count, 3);
    assert.equal(retryBody.inventory.suppressed_candidate_workflow_count, 2);
    assert.equal((retryBody.candidate_workflows[0] as any)?.distillation_origin, "execution_write_projection");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write stable workflow learning_control preview evaluates admitted review results and records runtime apply", async () => {
  const dbPath = tmpDbPath("projection-learning_control-review");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver",
        inputText: "continue fixing export resolver",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        ...passedExecutionEvidence("evidence://export/learning_control-review/run-1"),
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver with learning_control review",
        inputText: "continue fixing export resolver second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "authoritative",
        ...passedExecutionEvidence("evidence://export/learning_control-review/run-2"),
        workflowPromotionLearningControlReview: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "stable workflow promotion is strategically valuable here",
                confidence: 0.92,
                strategic_value: "high",
              },
            },
          },
        },
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const stableWorkflowNode = storedStable.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      return projection?.auto_promoted === true;
    }) ?? null;
    assert.ok(stableWorkflowNode);

    const stableProjection = (stableWorkflowNode.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (stableProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const reviewResult = (promotePreview.review_result ?? {}) as Record<string, unknown>;
    const admissibility = (promotePreview.admissibility ?? {}) as Record<string, unknown>;
    const policyEffect = (promotePreview.policy_effect ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;

    assert.equal(reviewResult.review_version, "promote_memory_semantic_review_v1");
    assert.equal(admissibility.admissible, true);
    assert.equal(policyEffect.applies, true);
    assert.equal(policyEffect.reason_code, "high_confidence_workflow_promotion");
    assert.equal(decisionTrace.review_supplied, true);
    assert.equal(decisionTrace.admissibility_evaluated, true);
    assert.equal(decisionTrace.admissible, true);
    assert.equal(decisionTrace.runtime_apply_changed_promotion_state, true);
    assert.deepEqual(decisionTrace.stage_order, [
      "review_packet_built",
      "review_result_received",
      "admissibility_evaluated",
      "policy_effect_derived",
      "runtime_policy_applied",
    ]);
    assert.equal(stableProjection.learning_control_promotion_state_override, "stable");
    const policyMutation = PolicyMutationV1Schema.parse(stableWorkflowNode.slots?.policy_mutation_v1);
    const policyMutationAdjudication = PolicyMutationAdjudicationV1Schema.parse(
      stableWorkflowNode.slots?.policy_mutation_adjudication_v1,
    );
    assert.equal(policyMutation.stage, "promote");
    assert.equal(policyMutation.target.kind, "workflow_memory");
    assert.equal(policyMutation.target.target_id, stableWorkflowNode.id);
    assert.equal(policyMutation.proposed_effect, "stable");
    assert.equal(policyMutation.source_code_change_allowed, false);
    assert.equal(policyMutationAdjudication.admissible, true);
    assert.equal(policyMutationAdjudication.source_code_change_allowed, false);
    const promotionLedger = PromotionEvidenceLedgerV1Schema.parse(stableWorkflowNode.slots?.promotion_evidence_ledger_v1);
    assert.equal(promotionLedger.transition, "L1_to_L2");
    assert.equal(promotionLedger.target_kind, "workflow");
    assert.equal(promotionLedger.verdict, "promotion_admitted");
    assert.equal(promotionLedger.learning_control_admitted, true);
    assert.equal(promotionLedger.source_code_change_allowed, false);
    assert.equal((stableWorkflowNode.slots?.anchor_v1 as Record<string, any>)?.promotion_evidence_ledger_v1?.ledger_id, promotionLedger.ledger_id);
    assert.equal((stableWorkflowNode.slots?.execution_native_v1 as Record<string, any>)?.promotion_evidence_ledger_v1?.ledger_id, promotionLedger.ledger_id);

    const planning = await app.inject({
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
    assert.equal(planning.statusCode, 200);
    const planningBody = PlanningContextRouteContractSchema.parse(planning.json());
    assert.equal(planningBody.planner_packet.sections.recommended_workflows.length, 1);
    assert.equal(planningBody.workflow_signals[0]?.promotion_state, "stable");

    const introspection = await app.inject({
      method: "POST",
      url: "/v1/memory/execution/introspect",
      payload: {
        tenant_id: "default",
        scope: "default",
        limit: 8,
      },
    });
    assert.equal(introspection.statusCode, 200, introspection.body);
    const introspectionBody = ExecutionMemoryIntrospectionResponseSchema.parse(introspection.json());
    const cognitiveMutations = (introspectionBody.cognitive_structure_v1 as any).policy_mutations ?? [];
    assert.equal(cognitiveMutations.length, 1);
    assert.equal(PolicyMutationV1Schema.parse(cognitiveMutations[0]).target.target_id, stableWorkflowNode.id);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write consumes runtime verifier evidence from planning_context for stable workflow promotion", async () => {
  const dbPath = tmpDbPath("projection-runtime-verifier-evidence");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({
      app,
      liteWriteStore,
      liteRecallStore,
      envOverrides: { RUNTIME_VERIFIER_EXECUTION_ENABLED: true },
    });

    const command = runtimeVerifierCommand();
    const serviceConstraint = runtimeVerifierServiceConstraint(command);
    const taskBrief = "Fix service publish validation with runtime verifier evidence";
    const filePath = "src/routes/service.ts";
    const firstEvidence = await runtimeVerifierEvidenceFromPlanning({
      app,
      stateId: `runtime-verifier:${randomUUID()}`,
      taskBrief,
      filePath,
      command,
    });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch service publish path with runtime verifier evidence",
        inputText: "continue fixing service publish path with runtime verifier evidence",
        taskBrief,
        stateId: `state:${randomUUID()}`,
        filePath,
        modifiedFiles: [filePath],
        pendingValidations: [command],
        contractTrust: "authoritative",
        serviceLifecycleConstraints: [serviceConstraint],
        executionEvidence: [firstEvidence],
      }),
    });
    assert.equal(firstWrite.statusCode, 200, firstWrite.body);

    const secondEvidence = await runtimeVerifierEvidenceFromPlanning({
      app,
      stateId: `runtime-verifier:${randomUUID()}`,
      taskBrief,
      filePath,
      command,
    });
    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch service publish path with runtime verifier evidence again",
        inputText: "continue fixing service publish path with runtime verifier evidence second run",
        taskBrief,
        stateId: `state:${randomUUID()}`,
        filePath,
        modifiedFiles: [filePath],
        pendingValidations: [command],
        contractTrust: "authoritative",
        serviceLifecycleConstraints: [serviceConstraint],
        executionEvidence: [secondEvidence],
        workflowPromotionLearningControlReview: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "runtime verifier evidence proves the workflow outcome after agent exit",
                confidence: 0.93,
                strategic_value: "high",
              },
            },
          },
        },
      }),
    });
    assert.equal(secondWrite.statusCode, 200, secondWrite.body);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const stableWorkflowNode = storedStable.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      return projection?.auto_promoted === true;
    }) ?? null;
    assert.ok(stableWorkflowNode);
    const authorityGate = stableWorkflowNode.slots?.authority_gate_v1 as Record<string, unknown>;
    const evidenceAssessment = stableWorkflowNode.slots?.execution_evidence_assessment as Record<string, unknown>;
    const stableEvidence = stableWorkflowNode.slots?.execution_evidence_v1 as Record<string, unknown>;
    assert.equal(authorityGate.allows_authoritative, true);
    assert.equal(authorityGate.allows_stable_promotion, true);
    assert.equal(evidenceAssessment.status, "succeeded");
    assert.equal(evidenceAssessment.allows_stable_promotion, true);
    assert.equal(stableEvidence.validation_boundary, "runtime_orchestrator");
    assert.equal(stableEvidence.after_exit_revalidated, true);
    assert.equal(stableEvidence.fresh_shell_probe_passed, true);
    assert.ok((stableEvidence.evidence_refs as string[]).some((ref) => ref.startsWith("runtime_verifier:")));

    const planning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: taskBrief,
        context: {
          goal: taskBrief,
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(planning.statusCode, 200, planning.body);
    const planningBody = PlanningContextRouteContractSchema.parse(planning.json());
    assert.equal(planningBody.planner_packet.sections.recommended_workflows.length, 1);
    assert.equal(planningBody.workflow_signals[0]?.promotion_state, "stable");
    assert.equal(planningBody.workflow_signals[0]?.authority_visibility?.allows_stable_promotion, true);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write stable workflow learning_control blocks promotion when execution evidence fails lifecycle revalidation", async () => {
  const dbPath = tmpDbPath("projection-learning_control-evidence-blocked");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const serviceConstraint = serviceLifecycleConstraint();
    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch service publish path",
        inputText: "continue fixing service publish path",
        taskBrief: "Fix service publish validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/service.ts",
        modifiedFiles: ["src/routes/service.ts"],
        contractTrust: "authoritative",
        serviceLifecycleConstraints: [serviceConstraint],
        executionResultSummary: {
          status: "passed",
          summary: "Service validation passed and survived the agent exit.",
          validation_passed: true,
          after_exit_revalidated: true,
          fresh_shell_probe_passed: true,
          validation_boundary: "external_verifier",
        },
        executionEvidence: [{
          ref: "evidence://service/run-1",
          validation_passed: true,
          after_exit_revalidated: true,
          fresh_shell_probe_passed: true,
          validation_boundary: "external_verifier",
        }],
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch service publish path with failed lifecycle evidence",
        inputText: "continue fixing service publish path second run",
        taskBrief: "Fix service publish validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/service.ts",
        modifiedFiles: ["src/routes/service.ts"],
        contractTrust: "authoritative",
        serviceLifecycleConstraints: [serviceConstraint],
        executionResultSummary: {
          status: "passed",
          summary: "Agent-side validation looked green, but lifecycle revalidation failed.",
          validation_passed: true,
          after_exit_revalidated: false,
          fresh_shell_probe_passed: false,
          validation_boundary: "external_verifier",
        },
        executionEvidence: [{
          ref: "evidence://service/run-2",
          validation_passed: true,
          after_exit_revalidated: false,
          fresh_shell_probe_passed: false,
          validation_boundary: "external_verifier",
          failure_reason: "service_not_reachable_after_agent_exit",
        }],
        workflowPromotionLearningControlReview: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "stable workflow promotion would normally be valuable here",
                confidence: 0.92,
                strategic_value: "high",
              },
            },
          },
        },
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    assert.equal(storedStable.rows.length, 0);

    const storedCandidates = await liteWriteStore.findNodes({
      scope: "default",
      type: "event",
      slotsContains: {
        summary_kind: "workflow_candidate",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const reviewedCandidate = storedCandidates.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      const preview = (projection?.learning_control_preview ?? null) as Record<string, unknown> | null;
      return preview?.promote_memory != null;
    }) ?? null;
    assert.ok(reviewedCandidate);
    const assessment = reviewedCandidate.slots?.execution_evidence_assessment as Record<string, unknown>;
    assert.equal(assessment.status, "failed");
    assert.equal(assessment.allows_stable_promotion, false);
    assert.ok((assessment.reasons as string[]).includes("after_exit_revalidation_failed"));
    assert.ok((assessment.reasons as string[]).includes("fresh_shell_probe_failed"));

    const reviewedProjection = (reviewedCandidate.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (reviewedProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const policyEffect = (promotePreview.policy_effect ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;

    assert.equal(policyEffect.applies, false);
    assert.equal(policyEffect.reason_code, "execution_evidence_insufficient");
    assert.equal(policyEffect.effective_promotion_state, "candidate");
    assert.ok((decisionTrace.reason_codes as string[]).includes("execution_evidence_insufficient"));
    assert.ok((decisionTrace.reason_codes as string[]).includes("execution_evidence:after_exit_revalidation_failed"));
    assert.equal(decisionTrace.runtime_apply_changed_promotion_state, false);

    const planning = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "fix service publish validation",
        context: {
          goal: "fix service publish validation",
        },
        tool_candidates: ["bash", "edit", "test"],
      },
    });
    assert.equal(planning.statusCode, 200);
    const planningBody = PlanningContextRouteContractSchema.parse(planning.json());
    assert.equal(planningBody.planning_summary.authority_visibility_summary.authoritative_blocked_count, 1);
    assert.equal(planningBody.planning_summary.authority_visibility_summary.execution_evidence_failed_count, 1);
    assert.match(
      planningBody.planning_summary.planner_explanation ?? "",
      /authority blocked: 1; blocker=execution_evidence:after_exit_revalidation_failed/,
    );
    const blockedWorkflow = planningBody.workflow_signals.find((entry: any) =>
      entry?.authority_visibility?.primary_blocker === "execution_evidence:after_exit_revalidation_failed"
    ) as any;
    assert.equal(blockedWorkflow?.authority_visibility?.execution_evidence_status, "failed");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write stable workflow learning_control can use internal evidence provider without explicit review", async () => {
  const dbPath = tmpDbPath("projection-learning_control-provider");
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

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver",
        inputText: "continue fixing export resolver",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "authoritative",
        ...passedExecutionEvidence("evidence://export/evidence-provider/run-1"),
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver with provider",
        inputText: "continue fixing export resolver second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "authoritative",
        ...passedExecutionEvidence("evidence://export/evidence-provider/run-2"),
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const stableWorkflowNode = storedStable.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      return projection?.auto_promoted === true;
    }) ?? null;
    assert.ok(stableWorkflowNode);

    const stableProjection = (stableWorkflowNode.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (stableProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const reviewResult = (promotePreview.review_result ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;

    assert.equal(reviewResult.review_version, "promote_memory_semantic_review_v1");
    assert.equal(reviewResult.adjudication?.reason, "evidence provider found workflow-signature evidence");
    assert.equal(promotePreview.admissibility?.admissible, true);
    assert.equal(promotePreview.policy_effect?.applies, true);
    assert.equal(promotePreview.policy_effect?.effective_promotion_state, "stable");
    assert.equal(decisionTrace.review_supplied, true);
    assert.equal(decisionTrace.runtime_apply_changed_promotion_state, true);
    assert.equal(stableProjection.learning_control_promotion_state_override, "stable");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write does not auto-promote advisory workflow projections to stable anchors", async () => {
  const dbPath = tmpDbPath("projection-advisory-no-stable");
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

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver advisory run 1",
        inputText: "continue fixing export resolver with weaker continuity evidence",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "advisory",
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver advisory run 2",
        inputText: "continue fixing export resolver with weaker continuity evidence second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "advisory",
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    assert.equal(storedStable.rows.length, 0);

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
    assert.equal(introspectBody.recommended_workflows.length, 0);
    assert.equal(introspectBody.candidate_workflows.length, 1);
    assert.equal((introspectBody.candidate_workflows[0] as any)?.contract_trust, "advisory");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write learning_control review does not override advisory workflow projections into stable anchors", async () => {
  const dbPath = tmpDbPath("projection-advisory-learning_control-blocked");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver advisory learning_control run 1",
        inputText: "continue fixing export resolver with weaker continuity evidence",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "advisory",
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver advisory learning_control run 2",
        inputText: "continue fixing export resolver with weaker continuity evidence second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        contractTrust: "advisory",
        workflowPromotionLearningControlReview: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "stable workflow promotion is strategically valuable here",
                confidence: 0.92,
                strategic_value: "high",
              },
            },
          },
        },
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    assert.equal(storedStable.rows.length, 0);

    const storedCandidates = await liteWriteStore.findNodes({
      scope: "default",
      type: "event",
      slotsContains: {
        summary_kind: "workflow_candidate",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const reviewedCandidate = storedCandidates.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      const preview = (projection?.learning_control_preview ?? null) as Record<string, unknown> | null;
      return preview?.promote_memory != null;
    }) ?? null;
    assert.ok(reviewedCandidate);
    const reviewedProjection = (reviewedCandidate?.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (reviewedProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const policyEffect = (promotePreview.policy_effect ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;

    assert.equal(promotePreview.admissibility?.admissible, true);
    assert.equal(policyEffect.applies, false);
    assert.equal(policyEffect.reason_code, "contract_trust_below_authoritative");
    assert.equal(policyEffect.effective_promotion_state, "candidate");
    assert.equal(decisionTrace.runtime_apply_changed_promotion_state, false);
    assert.ok(Array.isArray(decisionTrace.reason_codes));
    assert.ok(decisionTrace.reason_codes.includes("contract_trust_below_authoritative"));

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
    assert.equal(introspectBody.recommended_workflows.length, 0);
    assert.equal(introspectBody.candidate_workflows.length, 1);
    assert.equal((introspectBody.candidate_workflows[0] as any)?.contract_trust, "advisory");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write learning_control review does not promote authoritative workflow without sufficient outcome contract", async () => {
  const dbPath = tmpDbPath("projection-authoritative-outcome-blocked");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver thin authoritative run 1",
        inputText: "continue fixing export resolver with thin authoritative continuity evidence",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        pendingValidations: [],
        contractTrust: "authoritative",
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildExecutionWritePayload({
        eventId: randomUUID(),
        title: "Patch export resolver thin authoritative run 2",
        inputText: "continue fixing export resolver with thin authoritative continuity evidence second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        modifiedFiles: ["src/routes/export.ts"],
        pendingValidations: [],
        contractTrust: "authoritative",
        workflowPromotionLearningControlReview: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "stable workflow promotion is strategically valuable here",
                confidence: 0.92,
                strategic_value: "high",
              },
            },
          },
        },
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

    const storedStable = await liteWriteStore.findNodes({
      scope: "default",
      type: "procedure",
      slotsContains: {
        summary_kind: "workflow_anchor",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    assert.equal(storedStable.rows.length, 0);

    const storedCandidates = await liteWriteStore.findNodes({
      scope: "default",
      type: "event",
      slotsContains: {
        summary_kind: "workflow_candidate",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 20,
      offset: 0,
    });
    const reviewedCandidate = storedCandidates.rows.find((row) => {
      const projection = (row.slots?.workflow_write_projection ?? null) as Record<string, unknown> | null;
      const preview = (projection?.learning_control_preview ?? null) as Record<string, unknown> | null;
      return preview?.promote_memory != null;
    }) ?? null;
    assert.ok(reviewedCandidate);
    const reviewedProjection = (reviewedCandidate?.slots?.workflow_write_projection ?? {}) as Record<string, unknown>;
    const learningControlPreview = (reviewedProjection.learning_control_preview ?? {}) as Record<string, unknown>;
    const promotePreview = (learningControlPreview.promote_memory ?? {}) as Record<string, unknown>;
    const policyEffect = (promotePreview.policy_effect ?? {}) as Record<string, unknown>;
    const decisionTrace = (promotePreview.decision_trace ?? {}) as Record<string, unknown>;

    assert.equal(promotePreview.admissibility?.admissible, true);
    assert.equal(policyEffect.applies, false);
    assert.equal(policyEffect.reason_code, "outcome_contract_insufficient");
    assert.equal((policyEffect.outcome_contract_gate as any)?.status, "insufficient");
    assert.ok((policyEffect.outcome_contract_gate as any)?.reasons?.includes("missing_verifiable_success_outcome"));
    assert.equal(policyEffect.effective_promotion_state, "candidate");
    assert.equal(decisionTrace.runtime_apply_changed_promotion_state, false);
    assert.ok(Array.isArray(decisionTrace.reason_codes));
    assert.ok(decisionTrace.reason_codes.includes("outcome_contract_insufficient"));
    assert.ok(decisionTrace.reason_codes.includes("outcome_contract:missing_verifiable_success_outcome"));
    assert.equal((reviewedCandidate?.slots?.outcome_contract_gate as any)?.status, "insufficient");
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write also projects packet-only execution continuity writes into workflow candidates", async () => {
  const dbPath = tmpDbPath("packet-only-projection");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildPacketOnlyWritePayload({
        eventId: randomUUID(),
        title: "Packet-only export repair",
        inputText: "continue packet-only export repair",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        targetFiles: ["src/routes/export.ts"],
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

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
    assert.equal(firstBody.workflow_signals[0]?.promotion_ready, false);

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildPacketOnlyWritePayload({
        eventId: randomUUID(),
        title: "Packet-only export repair second run",
        inputText: "continue packet-only export repair second run",
        taskBrief: "Recover durable workflow from failed validation",
        stateId: `state:${randomUUID()}`,
        filePath: "src/routes/export.ts",
        targetFiles: ["src/routes/export.ts"],
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

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
    assert.equal(secondBody.planner_packet.sections.recommended_workflows.length, 0);
    assert.equal(secondBody.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(secondBody.workflow_signals[0]?.promotion_state, "candidate");
    assert.equal(secondBody.workflow_signals[0]?.promotion_ready, true);

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
    assert.equal(introspectBody.recommended_workflows.length, 0);
    assert.equal(introspectBody.candidate_workflows.length, 1);
    assert.match(introspectBody.operator_surface.merged_text, /promotion-ready workflows=1/i);
    assert.match(introspectBody.operator_surface.merged_text, /candidate workflow:/i);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});

test("memory/write projects lightweight handoff-style continuity through the generic workflow producer", async () => {
  const dbPath = tmpDbPath("lightweight-handoff-projection");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildLightweightHandoffWritePayload({
        eventId: randomUUID(),
        title: "Lightweight export repair handoff",
        inputText: "continue lightweight export repair",
        taskBrief: "Recover durable workflow from failed validation",
        filePath: "src/routes/export.ts",
        targetFiles: ["src/routes/export.ts"],
      }),
    });
    assert.equal(firstWrite.statusCode, 200);

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

    const secondWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/write",
      payload: buildLightweightHandoffWritePayload({
        eventId: randomUUID(),
        title: "Lightweight export repair handoff second run",
        inputText: "continue lightweight export repair second run",
        taskBrief: "Recover durable workflow from failed validation",
        filePath: "src/routes/export.ts",
        targetFiles: ["src/routes/export.ts"],
      }),
    });
    assert.equal(secondWrite.statusCode, 200);

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
    assert.equal(secondBody.planner_packet.sections.recommended_workflows.length, 0);
    assert.equal(secondBody.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(secondBody.workflow_signals[0]?.promotion_state, "candidate");
    assert.equal(secondBody.workflow_signals[0]?.promotion_ready, true);
  } finally {
    await app.close();
    await liteWriteStore.close();
  }
});
