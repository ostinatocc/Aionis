import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { createReplayRepairReviewPolicy } from "../../src/app/replay-repair-review-policy.ts";
import { createReplayRuntimeOptionBuilders } from "../../src/app/replay-runtime-options.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import {
  PolicyMutationAdjudicationV1Schema,
  PolicyMutationV1Schema,
} from "../../src/kernel/policy-mutation-loop.ts";
import { PlanningContextRouteContractSchema, ReplayPlaybookRepairReviewResponseSchema } from "../../src/memory/schemas.ts";
import { replayPlaybookRepairReview, replayPlaybookRun } from "../../src/memory/replay.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { applyReplayMemoryWrite } from "../../src/memory/replay-write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteReplayStore } from "../../src/store/lite-replay-store.ts";
import { createLiteRuntimeStore } from "../../src/store/lite-runtime-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { createSandboxStore } from "../../src/store/sandbox-access.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-replay-learning_control-"));
  return path.join(dir, `${name}.sqlite`);
}

function createTestSandboxStore() {
  const runtimeStore = createLiteRuntimeStore(tmpDbPath("sandbox-runtime"));
  return {
    sandboxStore: createSandboxStore(runtimeStore),
    close: () => runtimeStore.close(),
  };
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
    MAX_TEXT_LEN: 10000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    SANDBOX_ENABLED: false,
    SANDBOX_EXECUTOR_MODE: "disabled",
    SANDBOX_EXECUTOR_TIMEOUT_MS: 15000,
    SANDBOX_STDIO_MAX_BYTES: 262144,
    SANDBOX_EXECUTOR_WORKDIR: process.cwd(),
    REPLAY_SHADOW_VALIDATE_EXECUTE_TIMEOUT_MS: 15000,
    REPLAY_SHADOW_VALIDATE_EXECUTE_STOP_ON_FAILURE: true,
    REPLAY_SHADOW_VALIDATE_SANDBOX_TIMEOUT_MS: 15000,
    REPLAY_SHADOW_VALIDATE_SANDBOX_STOP_ON_FAILURE: true,
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_PROFILE: "custom",
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_DEFAULT: false,
    REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_TARGET_STATUS: "active",
    REPLAY_REPAIR_REVIEW_GATE_REQUIRE_SHADOW_PASS: true,
    REPLAY_REPAIR_REVIEW_GATE_MIN_TOTAL_STEPS: 1,
    REPLAY_REPAIR_REVIEW_GATE_MAX_FAILED_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MAX_BLOCKED_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MAX_UNKNOWN_STEPS: 0,
    REPLAY_REPAIR_REVIEW_GATE_MIN_SUCCESS_RATIO: 1,
    REPLAY_REPAIR_REVIEW_POLICY_JSON: "{}",
    REPLAY_LEARNING_PROJECTION_ENABLED: true,
    REPLAY_LEARNING_PROJECTION_MODE: "rule_and_episode",
    REPLAY_LEARNING_PROJECTION_DELIVERY: "sync_inline",
    REPLAY_LEARNING_TARGET_RULE_STATE: "draft",
    REPLAY_LEARNING_MIN_TOTAL_STEPS: 1,
    REPLAY_LEARNING_MIN_SUCCESS_RATIO: 1,
    REPLAY_LEARNING_MAX_MATCHER_BYTES: 16384,
    REPLAY_LEARNING_MAX_TOOL_PREFER: 8,
    REPLAY_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    EPISODE_GC_TTL_DAYS: 30,
    REPLAY_GUIDED_REPAIR_STRATEGY: "agent_repair_request",
    REPLAY_GUIDED_REPAIR_MAX_ERROR_CHARS: 4000,
    ...overrides,
  } as any;
}

async function seedPendingReviewPlaybook(args: {
  writeDbPath: string;
  replayDbPath: string;
  playbookId: string;
  workflowSignature?: string | null;
  stepsTemplate?: unknown[];
}) {
  const liteWriteStore = createLiteWriteStore(args.writeDbPath);
  const liteReplayStore = createLiteReplayStore(args.replayDbPath);
  const sourceClientId = `replay:playbook:${args.playbookId}:v1`;
  const out = await applyReplayMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: `seed pending review playbook ${args.playbookId}`,
      auto_embed: false,
      memory_lane: "private",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      nodes: [
        {
          client_id: sourceClientId,
          type: "procedure",
          title: "Recover workflow validation failure",
          text_summary: "Replay playbook pending review",
          slots: {
            replay_kind: "playbook",
            playbook_id: args.playbookId,
            name: "Recover workflow validation failure",
            version: 1,
            status: "draft",
            matchers: { task_kind: "workflow_validation_recovery" },
            success_criteria: { status: "success" },
            risk_profile: "medium",
            source_run_id: randomUUID(),
            created_from_run_ids: [randomUUID()],
            compile_summary: {
              source_run_status: "success",
              validation_status: "success",
              total_steps: 2,
              successful_steps: 2,
              evidence_refs: ["seed_pending_review_playbook:successful_source_run"],
            },
            policy_constraints: {},
            ...(args.workflowSignature ? { workflow_signature: args.workflowSignature } : {}),
            steps_template: args.stepsTemplate ?? [
              {
                step_index: 1,
                tool_name: "edit",
                preconditions: [],
                postconditions: [],
                safety_level: "needs_confirm",
              },
              {
                step_index: 2,
                tool_name: "test",
                preconditions: [],
                postconditions: [],
                safety_level: "observe_only",
              },
            ],
            repair_patch: {
              note: "normalize export path",
            },
            repair_review: {
              state: "pending_review",
            },
          },
        },
      ],
      edges: [],
    },
    {
      defaultScope: "default",
      defaultTenantId: "default",
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      embedder: null,
      replayMirror: liteReplayStore,
      writeAccess: liteWriteStore,
    },
  );
  assert.ok(out.out.nodes[0]?.id);
  return { liteWriteStore, liteReplayStore };
}

function registerReplayReviewRoute(args: {
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteReplayStore: ReturnType<typeof createLiteReplayStore>;
  liteRecallStore?: ReturnType<typeof createLiteRecallStore> | null;
  envOverrides?: Record<string, unknown>;
  sandboxAllowedCommands?: Set<string> | string[];
}) {
  const env = buildEnv(args.envOverrides);
  const app = Fastify();
  registerRuntimeErrorHandler(app);
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
  const testSandbox = createTestSandboxStore();
  app.addHook("onClose", async () => {
    await testSandbox.close();
  });
  const runtimeOptions = createReplayRuntimeOptionBuilders({
    env,
    sandboxStore: testSandbox.sandboxStore,
    embedder: DeterministicEmbeddingProvider,
    embeddingSurfacePolicy: undefined,
    liteWriteStore: args.liteWriteStore,
    liteReplayAccess: args.liteReplayStore.createReplayAccess(),
    liteReplayStore: args.liteReplayStore,
    sandboxAllowedCommands: args.sandboxAllowedCommands ?? [],
    sandboxExecutor: {
      enqueue: () => {},
      executeSync: async () => {},
    },
    enforceSandboxTenantBudget: async () => {},
  });
  const { withReplayRepairReviewDefaults } = createReplayRepairReviewPolicy({
    env,
    tenantFromBody: guards.tenantFromBody,
    scopeFromBody: guards.scopeFromBody,
  });
  const withLocalReplayIdentity = (payload: Record<string, unknown>) => ({
    actor: "local-user",
    consumer_agent_id: "local-user",
    memory_lane: "private",
    producer_agent_id: "local-user",
    owner_agent_id: "local-user",
    ...payload,
  });

  const review = async (payload: Record<string, unknown>) => {
    const defaulted = withReplayRepairReviewDefaults(withLocalReplayIdentity(payload));
    const metadata = defaulted.body.metadata && typeof defaulted.body.metadata === "object"
      && !Array.isArray(defaulted.body.metadata)
      ? { ...(defaulted.body.metadata as Record<string, unknown>) }
      : {};
    defaulted.body.metadata = {
      ...metadata,
      auto_promote_policy_resolution: defaulted.resolution,
    };
    const options = runtimeOptions.buildReplayRepairReviewOptions();
    options.writeAccess = args.liteWriteStore;
    const out = await args.liteWriteStore.withTx(() => replayPlaybookRepairReview(defaulted.body, options));
    return {
      ...out,
      auto_promote_policy_resolution: defaulted.resolution,
    };
  };

  const run = async (payload: Record<string, unknown>, allowSandboxExecution: boolean) => {
    const reply = { header: () => undefined };
    const options = runtimeOptions.buildReplayPlaybookRunOptions(reply, "direct_replay_playbook_run", {
      allowSandboxExecution,
    });
    if (options.writeOptions) options.writeOptions.writeAccess = args.liteWriteStore;
    return replayPlaybookRun(withLocalReplayIdentity(payload), options);
  };

  if (args.liteRecallStore) {
    registerMemoryContextRuntimeRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        APP_ENV: "test",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10_000,
        PII_REDACTION: false,
        MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
        MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
        MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
        MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
        MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
      } as any,
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
      resolveRecallStrategy: () => ({
        strategy: "local",
        defaults: {},
        applied: false,
      }),
      resolveAdaptiveRecallProfile: (profile) => ({
        profile,
        defaults: {},
        applied: false,
        reason: "test_default",
      }),
      resolveAdaptiveRecallHardCap: () => ({
        defaults: {},
        applied: false,
        reason: "test_default",
      }),
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
        message: "embed failed",
      }),
      recordContextAssemblyTelemetryBestEffort: async () => {},
    });
  }

  return { app, runtimeOptions, review, run };
}

test("lite replay runtime defaults use sync_inline learning projection delivery", async () => {
  const env = buildEnv();
  const testSandbox = createTestSandboxStore();
  try {
    const runtimeOptions = createReplayRuntimeOptionBuilders({
      env,
      sandboxStore: testSandbox.sandboxStore,
      embedder: null,
      embeddingSurfacePolicy: undefined,
      liteWriteStore: null,
      liteReplayAccess: null,
      liteReplayStore: null,
      sandboxAllowedCommands: [],
      sandboxExecutor: {
        enqueue: () => {},
        executeSync: async () => {},
      },
      enforceSandboxTenantBudget: async () => {},
    });

    assert.equal(runtimeOptions.buildReplayRepairReviewOptions().learningProjectionDefaults?.delivery, "sync_inline");
  } finally {
    await testSandbox.close();
  }
});

test("replay playbook run requires admin token when sandbox admin-only execution is enabled", async () => {
  const dbPath = tmpDbPath("sandbox-admin-only-run");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath: dbPath,
    replayDbPath: tmpDbPath("sandbox-admin-only-run-replay"),
    playbookId,
    stepsTemplate: [
      {
        step_index: 1,
        tool_name: "command",
        tool_input_template: { argv: ["echo", "aionis-admin-only"] },
        preconditions: [],
        postconditions: [],
        safety_level: "auto_ok",
      },
    ],
  });
  const { app, run } = registerReplayReviewRoute({
    liteWriteStore,
    liteReplayStore,
    envOverrides: {
      SANDBOX_ENABLED: true,
      SANDBOX_ADMIN_ONLY: true,
      ADMIN_TOKEN: "admin-secret",
      SANDBOX_EXECUTOR_MODE: "local_process",
    },
    sandboxAllowedCommands: new Set(["echo"]),
  });
  const payload = {
    tenant_id: "default",
    scope: "default",
    playbook_id: playbookId,
    mode: "strict",
    deterministic_gate: { enabled: false },
    params: {
      allow_local_exec: true,
      execution_backend: "local_process",
      allowed_commands: ["echo"],
      record_run: false,
    },
  };
  try {
    await assert.rejects(
      () => run(payload, false),
      (error: any) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "replay_executor_not_enabled");
        return true;
      },
    );

    const allowed = await run(payload, true);
    assert.equal(allowed.mode, "strict");
  } finally {
    await app.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("lite replay repair review applies learning projection inline by default", async () => {
  const dbPath = tmpDbPath("repair-review-inline");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath: dbPath,
    replayDbPath: tmpDbPath("repair-review-inline-replay"),
    playbookId,
  });
  const { app, review } = registerReplayReviewRoute({ liteWriteStore, liteReplayStore });
  try {
    const body = ReplayPlaybookRepairReviewResponseSchema.parse(await review({
        tenant_id: "default",
        scope: "default",
        playbook_id: playbookId,
        action: "approve",
        auto_shadow_validate: false,
        target_status_on_approve: "shadow",
        learning_projection: {
          enabled: true,
        },
        learning_control_review: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "Replay review confirms stable workflow promotion",
                confidence: 0.82,
                strategic_value: "high",
              },
            },
          },
        },
    }));
    assert.equal(body.learning_projection_result.delivery, "sync_inline");
    assert.equal(body.learning_projection_result.status, "applied");
    assert.equal(body.learning_projection_result.rule_state, "shadow");
    assert.ok(body.learning_projection_result.generated_episode_node_id);
    assert.ok(body.learning_projection_result.generated_rule_node_id);
    assert.equal(body.learning_control_preview?.promote_memory.review_packet.operation, "promote_memory");
    assert.equal(body.learning_control_preview?.promote_memory.review_packet.requested_target_kind, "workflow");
    assert.equal(body.learning_control_preview?.promote_memory.review_packet.requested_target_level, "L2");
    assert.equal(body.learning_control_preview?.promote_memory.review_packet.deterministic_gate.gate_satisfied, true);
    assert.equal(body.learning_control_preview?.promote_memory.admissibility?.admissible, true);
    assert.equal(body.learning_control_preview?.promote_memory.admissibility?.accepted_mutation_count, 1);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.applies, true);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.base_target_rule_state, "draft");
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.review_suggested_target_rule_state, "shadow");
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.effective_target_rule_state, "shadow");
    assert.equal(
      body.learning_control_preview?.promote_memory.policy_effect?.reason_code,
      "high_strategic_value_workflow_promotion",
    );
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.trace_version, "replay_learning_control_trace_v1");
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.review_supplied, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.admissibility_evaluated, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.admissible, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.policy_effect_applies, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.runtime_apply_changed_target_rule_state, true);
    assert.deepEqual(body.learning_control_preview?.promote_memory.decision_trace?.stage_order, [
      "review_packet_built",
      "review_result_received",
      "admissibility_evaluated",
      "policy_effect_derived",
      "runtime_policy_applied",
    ]);
    const policyMutation = PolicyMutationV1Schema.parse(body.policy_mutation_v1);
    const policyMutationAdjudication = PolicyMutationAdjudicationV1Schema.parse(body.policy_mutation_adjudication_v1);
    assert.equal(policyMutation.stage, "apply");
    assert.equal(policyMutation.target.kind, "rule_memory");
    assert.equal(policyMutation.target.target_id, body.learning_projection_result.generated_rule_node_id);
    assert.equal(policyMutation.proposed_effect, "advisory");
    assert.equal(policyMutation.source_code_change_allowed, false);
    assert.equal(policyMutationAdjudication.admissible, true);
    assert.equal(policyMutationAdjudication.source_code_change_allowed, false);

    const { rows: ruleRows } = await liteWriteStore.findNodes({
      scope: "default",
      type: "rule",
      slotsContains: {
        replay_learning: {
          generated_by: "replay_learning_v1",
          source_playbook_id: playbookId,
        },
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.equal(ruleRows.length, 1);
    assert.equal(ruleRows[0]?.id, body.learning_projection_result.generated_rule_node_id);

    const { rows: episodeRows } = await liteWriteStore.findNodes({
      scope: "default",
      id: body.learning_projection_result.generated_episode_node_id,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.equal(episodeRows.length, 1);
    assert.equal(episodeRows[0]?.slots.replay_learning?.generated_by, "replay_learning_v1");
    assert.ok(episodeRows[0]?.slots.semantic_forgetting_v1);
    assert.ok(episodeRows[0]?.slots.archive_relocation_v1);
    assert.equal(episodeRows[0]?.owner_agent_id, "local-user");

    const { rows: anonymousEpisodeRows } = await liteWriteStore.findNodes({
      scope: "default",
      id: body.learning_projection_result.generated_episode_node_id,
      consumerAgentId: null,
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.equal(anonymousEpisodeRows.length, 0);

    const { rows: generatedRuleRows } = await liteWriteStore.findNodes({
      scope: "default",
      id: body.learning_projection_result.generated_rule_node_id,
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.equal(generatedRuleRows.length, 1);
    assert.ok(generatedRuleRows[0]?.slots.semantic_forgetting_v1);
    assert.ok(generatedRuleRows[0]?.slots.archive_relocation_v1);
    assert.equal(generatedRuleRows[0]?.owner_agent_id, "local-user");
  } finally {
    await app.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("lite replay repair review can use internal evidence learning_control provider without explicit review", async () => {
  const dbPath = tmpDbPath("repair-review-inline-evidence-provider");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath: dbPath,
    replayDbPath: tmpDbPath("repair-review-inline-evidence-provider-replay"),
    playbookId,
    workflowSignature: "wf:replay:export-fix",
  });
  const { app, review } = registerReplayReviewRoute({
    liteWriteStore,
    liteReplayStore,
    envOverrides: {
      REPLAY_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: true,
    },
  });
  try {
    const body = ReplayPlaybookRepairReviewResponseSchema.parse(await review({
        tenant_id: "default",
        scope: "default",
        playbook_id: playbookId,
        action: "approve",
        auto_shadow_validate: false,
        target_status_on_approve: "shadow",
        learning_projection: {
          enabled: true,
        },
    }));
    assert.equal(body.learning_projection_result.status, "applied");
    assert.equal(body.learning_projection_result.rule_state, "shadow");
    assert.equal(
      body.learning_control_preview?.promote_memory.review_result?.adjudication.reason,
      "evidence provider found workflow-signature evidence",
    );
    assert.equal(body.learning_control_preview?.promote_memory.review_result?.adjudication.confidence, 0.84);
    assert.equal(body.learning_control_preview?.promote_memory.admissibility?.admissible, true);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.applies, true);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.effective_target_rule_state, "shadow");
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.review_supplied, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.runtime_apply_changed_target_rule_state, true);
  } finally {
    await app.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("lite replay repair review keeps low-confidence learning_control review non-admissible without changing learning projection", async () => {
  const dbPath = tmpDbPath("repair-review-inline-low-confidence");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath: dbPath,
    replayDbPath: tmpDbPath("repair-review-inline-low-confidence-replay"),
    playbookId,
  });
  const { app, review } = registerReplayReviewRoute({ liteWriteStore, liteReplayStore });
  try {
    const body = ReplayPlaybookRepairReviewResponseSchema.parse(await review({
        tenant_id: "default",
        scope: "default",
        playbook_id: playbookId,
        action: "approve",
        auto_shadow_validate: false,
        target_status_on_approve: "shadow",
        learning_projection: {
          enabled: true,
        },
        learning_control_review: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "Maybe promote",
                confidence: 0.55,
              },
            },
          },
        },
    }));
    assert.equal(body.learning_projection_result.status, "applied");
    assert.equal(body.learning_projection_result.rule_state, "draft");
    assert.equal(body.learning_control_preview?.promote_memory.admissibility?.admissible, false);
    assert.deepEqual(body.learning_control_preview?.promote_memory.admissibility?.reason_codes, ["confidence_too_low"]);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.applies, false);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.effective_target_rule_state, "draft");
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.reason_code, "review_not_admissible");
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.admissible, false);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.policy_effect_applies, false);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.runtime_apply_changed_target_rule_state, false);
  } finally {
    await app.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("lite replay repair review preserves explicit target_rule_state over learning_control policy effect preview", async () => {
  const dbPath = tmpDbPath("repair-review-inline-explicit-target-state");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath: dbPath,
    replayDbPath: tmpDbPath("repair-review-inline-explicit-target-state-replay"),
    playbookId,
  });
  const { app, review } = registerReplayReviewRoute({ liteWriteStore, liteReplayStore });
  try {
    const body = ReplayPlaybookRepairReviewResponseSchema.parse(await review({
        tenant_id: "default",
        scope: "default",
        playbook_id: playbookId,
        action: "approve",
        auto_shadow_validate: false,
        target_status_on_approve: "shadow",
        learning_projection: {
          enabled: true,
          target_rule_state: "draft",
        },
        learning_control_review: {
          promote_memory: {
            review_result: {
              review_version: "promote_memory_semantic_review_v1",
              adjudication: {
                operation: "promote_memory",
                disposition: "recommend",
                target_kind: "workflow",
                target_level: "L2",
                reason: "Replay review confirms stable workflow promotion",
                confidence: 0.88,
                strategic_value: "high",
              },
            },
          },
        },
    }));
    assert.equal(body.learning_projection_result.status, "applied");
    assert.equal(body.learning_projection_result.rule_state, "draft");
    assert.equal(body.learning_control_preview?.promote_memory.admissibility?.admissible, true);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.applies, false);
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.base_target_rule_state, "draft");
    assert.equal(body.learning_control_preview?.promote_memory.policy_effect?.effective_target_rule_state, "draft");
    assert.equal(
      body.learning_control_preview?.promote_memory.policy_effect?.reason_code,
      "explicit_target_rule_state_preserved",
    );
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.admissible, true);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.policy_effect_applies, false);
    assert.equal(body.learning_control_preview?.promote_memory.decision_trace?.runtime_apply_changed_target_rule_state, false);
  } finally {
    await app.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});

test("lite replay repair review writes workflow memory that planning_context consumes on the default product surface", async () => {
  const writeDbPath = tmpDbPath("repair-review-planning-write");
  const replayDbPath = tmpDbPath("repair-review-planning-replay");
  const playbookId = randomUUID();
  const { liteWriteStore, liteReplayStore } = await seedPendingReviewPlaybook({
    writeDbPath,
    replayDbPath,
    playbookId,
  });
  const liteRecallStore = createLiteRecallStore(writeDbPath);
  const { app, review } = registerReplayReviewRoute({ liteWriteStore, liteReplayStore, liteRecallStore });
  try {
    const reviewBody = ReplayPlaybookRepairReviewResponseSchema.parse(await review({
        tenant_id: "default",
        scope: "default",
        playbook_id: playbookId,
        action: "approve",
        auto_shadow_validate: false,
        target_status_on_approve: "shadow",
        learning_projection: {
          enabled: true,
        },
    }));
    assert.equal(reviewBody.learning_projection_result.status, "applied");

    const planningRes = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "recover workflow validation failure",
        context: {
          task_kind: "workflow_validation_recovery",
          goal: "recover durable workflow from failed validation",
          error: {
            signature: "workflow-validation-mismatch",
          },
        },
        tool_candidates: ["bash", "edit", "test"],
        include_shadow: false,
        rules_limit: 20,
      },
    });

    assert.equal(planningRes.statusCode, 200);
    const planningBody = PlanningContextRouteContractSchema.parse(planningRes.json());
    assert.equal(planningBody.planner_packet.sections.recommended_workflows.length, 0);
    assert.equal(planningBody.planner_packet.sections.candidate_workflows.length, 1);
    assert.equal(planningBody.workflow_signals.length, 1);
    assert.equal(planningBody.workflow_signals[0]?.title, "Recover workflow validation failure");
    assert.equal(planningBody.workflow_signals[0]?.promotion_state, "candidate");
    assert.match(planningBody.planning_summary.planner_explanation, /candidate workflows visible but not yet promoted: Recover workflow validation failure/);
  } finally {
    await app.close();
    await liteRecallStore.close();
    await liteReplayStore.close();
    await liteWriteStore.close();
  }
});
