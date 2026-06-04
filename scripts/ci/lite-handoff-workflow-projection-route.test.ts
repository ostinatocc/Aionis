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
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import {
  ExecutionMemoryIntrospectionResponseSchema,
  ExperienceIntelligenceResponseSchema,
  PlanningContextRouteContractSchema,
} from "../../src/memory/schemas.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createLiteExecutionStateStore } from "../../src/execution/state-store.ts";
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
    AUTO_TOPIC_CLUSTER_ON_WRITE: false,
    TOPIC_CLUSTER_ASYNC_ON_WRITE: true,
    MEMORY_WRITE_REQUIRE_NODES: false,
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
