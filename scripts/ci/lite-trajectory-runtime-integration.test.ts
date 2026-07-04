import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { PlanningContextRequest, PlanningContextRouteContractSchema } from "../../src/memory/schemas.ts";
import { buildTrajectoryCompileLite } from "../../src/memory/trajectory-compile.ts";
import { applyTrajectoryCompileExecutionKernel, augmentTrajectoryAwareRequest } from "../../src/memory/trajectory-compile-runtime.ts";
import { registerMemoryContextRuntimeRoutes } from "../../src/routes/memory-context-runtime.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-trajectory-runtime-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildEnv() {
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
    MEMORY_RECALL_TEXT_CONTEXT_TOKEN_BUDGET_DEFAULT: 4096,
    MEMORY_RECALL_STAGE1_EXACT_RECOVERY_ON_EMPTY: true,
    MEMORY_RECALL_ADAPTIVE_HARD_CAP_WAIT_MS: 0,
    MEMORY_PLANNING_CONTEXT_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_CONTEXT_ASSEMBLE_OPTIMIZATION_PROFILE_DEFAULT: "balanced",
    MEMORY_WRITE_REQUIRE_NODES: false,
  } as any;
}

async function buildApp() {
  const dbPath = tmpDbPath("runtime");
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  const env = buildEnv();
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

  const app = Fastify();
  registerRuntimeErrorHandler(app);

  registerMemoryContextRuntimeRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore,
    liteRecallAccess: liteRecallStore.createRecallAccess(),
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

  registerHandoffRoutes({
    app,
    env,
    embedder: DeterministicEmbeddingProvider,
    liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: null,
  });

  await app.ready();
  return app;
}

function externalArtifactVisibilityTrajectory() {
  return {
    title: "Recover external artifact visibility",
    task_family: "external_artifact_visibility",
    steps: [
      {
        role: "assistant",
        text: "Investigating why vectorops can no longer be installed from the local package index after the worker exits.",
      },
      {
        role: "tool",
        tool_name: "bash",
        command: "python scripts/build_and_serve.py",
      },
      {
        role: "tool",
        tool_name: "bash",
        command: "curl -fsS http://localhost:8080/simple/vectorops/",
      },
      {
        role: "tool",
        tool_name: "bash",
        command: "pip install --index-url http://localhost:8080/simple vectorops==0.1.0",
      },
      {
        role: "assistant",
        text: "Update scripts/build_and_serve.py, /app/src/vectorops/__init__.py, and /app/pyproject.toml, then relaunch the service in detached mode and rerun curl plus pip install from a fresh shell.",
      },
    ],
  };
}

function runtimeVerifierCommand() {
  return `${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`;
}

function runtimeVerifierExecutionPacket(command = runtimeVerifierCommand()) {
  return {
    version: 1,
    state_id: "runtime-verifier-packet-1",
    current_stage: "review",
    active_role: "review",
    task_brief: "Verify the detached service outcome from the runtime parent",
    target_files: ["scripts/status-server.mjs"],
    next_action: "Run the parent runtime verifier from a fresh shell after the agent exits.",
    hard_constraints: ["do not trust agent self-verification for after-exit service proof"],
    accepted_facts: [],
    rejected_paths: [],
    pending_validations: [command],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "process",
        label: "status-service-parent-proof",
        launch_reference: "launchctl bootstrap gui/501 /tmp/com.aionis.status.plist",
        endpoint: null,
        must_survive_agent_exit: true,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: [command],
        teardown_notes: [],
      },
    ],
    review_contract: null,
    resume_anchor: null,
    artifact_refs: [],
    evidence_refs: ["agent:return:claimed_success"],
  };
}

function strictRuntimeEntropyControls() {
  return {
    controls_version: "runtime_entropy_controls_v1",
    recall: {
      breadth: "wide",
      recommended_limit: 20,
      recommended_ranked_limit: 160,
      recommended_max_nodes: 160,
      recommended_max_edges: 100,
      reason: "High entropy requires wider recall before action.",
    },
    verifier: {
      verification_depth: "strict",
      schedule: "strict",
      runtime_verifier_required: true,
      reason: "Strict runtime verifier evidence is required before promotion.",
    },
    promotion: {
      promotion_threshold: "high",
      mutation_authority: "candidate_only",
      minimum_observations: 3,
      stable_promotion_allowed: false,
      reason: "Keep learning candidate-only until broader evidence exists.",
    },
    maintenance: {
      recommended_profile: "immediate",
      run_after_task: true,
      reason: "Preserve fresh execution evidence after task exit.",
    },
    source_code_change_allowed: false,
  };
}

test("trajectory-aware augmentation upgrades thin placeholders and refreshes stale compile summary", () => {
  const parsed = PlanningContextRequest.parse({
    tenant_id: "default",
    scope: "default",
    query_text: "Recover the local package index so clean clients can install vectorops again.",
    context: {
      task_family: null,
      target_files: [],
      next_action: null,
      workflow_steps: [],
      pattern_hints: [],
      recovery_contract_v1: {
        task_family: null,
        task_signature: "stale-task",
        workflow_signature: "stale-workflow",
        contract: {
          target_files: [],
          acceptance_checks: [],
          next_action: null,
          workflow_steps: [],
          pattern_hints: [],
          service_lifecycle_constraints: [],
          noise_markers: [],
        },
      },
    },
    execution_result_summary: {
      trajectory_compile_v1: {
        task_family: "stale_family",
        task_signature: "stale-task",
        workflow_signature: "stale-workflow",
        target_file_count: 0,
        acceptance_check_count: 0,
        service_constraint_count: 0,
        likely_tool: "bash",
      },
    },
    tool_candidates: ["bash", "grep", "python"],
    trajectory: externalArtifactVisibilityTrajectory(),
    trajectory_hints: {
      repo_root: "/app",
    },
  });

  const augmented = augmentTrajectoryAwareRequest({
    parsed,
    parse: PlanningContextRequest.parse,
    defaultScope: "default",
    defaultTenantId: "default",
  }).parsed;

  const context = augmented.context as Record<string, unknown>;
  const executionContract = context.execution_contract_v1 as Record<string, unknown>;
  const recoveryContract = context.recovery_contract_v1 as Record<string, unknown>;
  const recoveryBody = recoveryContract.contract as Record<string, unknown>;
  const summary = (augmented.execution_result_summary as Record<string, unknown>).trajectory_compile_v1 as Record<string, unknown>;
  const contractSummary = (augmented.execution_result_summary as Record<string, unknown>).execution_contract_v1 as Record<string, unknown>;

  assert.equal(context.task_family, "external_artifact_visibility");
  assert.equal(executionContract.schema_version, "execution_contract_v1");
  assert.equal(executionContract.task_family, "external_artifact_visibility");
  assert.ok(Array.isArray(context.target_files));
  assert.ok((context.target_files as string[]).includes("scripts/build_and_serve.py"));
  assert.ok(Array.isArray(recoveryBody.target_files));
  assert.ok((recoveryBody.target_files as string[]).includes("/app/src/vectorops/__init__.py"));
  assert.match(String(recoveryBody.next_action), /fresh shell/i);
  assert.ok(Array.isArray((executionContract.outcome as Record<string, unknown>).must_hold_after_exit));
  assert.ok(
    ((executionContract.outcome as Record<string, unknown>).must_hold_after_exit as string[])
      .some((entry) => entry.includes("service_survives_agent_exit")),
  );
  assert.ok(
    ((executionContract.outcome as Record<string, unknown>).dependency_requirements as string[])
      .some((entry) => entry.includes("artifacts and index metadata")),
  );
  assert.ok(
    ((executionContract.outcome as Record<string, unknown>).environment_assumptions as string[])
      .includes("validation_can_run_from_fresh_shell"),
  );
  assert.equal(summary.task_family, "external_artifact_visibility");
  assert.equal(contractSummary.task_family, "external_artifact_visibility");
  assert.ok(Number(contractSummary.dependency_requirement_count) > 0);
  assert.ok(Number(contractSummary.environment_assumption_count) > 0);
  assert.notEqual(summary.workflow_signature, "stale-workflow");
});

test("trajectory-aware execution kernel keeps completed validations out of pending state", () => {
  const compiled = buildTrajectoryCompileLite({
    query_text: "Recover the local package index so clean clients can install vectorops again.",
    trajectory: externalArtifactVisibilityTrajectory(),
  }, {
    defaultScope: "default",
    defaultTenantId: "default",
  });

  const result = applyTrajectoryCompileExecutionKernel({
    compiled,
    queryText: compiled.query_text,
    repoRoot: "/app",
    executionState: {
      version: 1,
      state_id: "resume:vectorops",
      scope: "default",
      task_brief: "Recover the local package index",
      current_stage: "resume",
      active_role: "resume",
      owned_files: [],
      modified_files: [],
      pending_validations: [
        "curl -fsS http://localhost:8080/simple/vectorops/",
      ],
      completed_validations: [
        "pip install --index-url http://localhost:8080/simple vectorops==0.1.0",
      ],
      last_accepted_hypothesis: null,
      rejected_paths: [],
      unresolved_blockers: [],
      rollback_notes: [],
      service_lifecycle_constraints: [],
      reviewer_contract: null,
      resume_anchor: null,
      updated_at: new Date().toISOString(),
    },
  });

  assert.ok(
    !result.execution_state_v1.pending_validations.includes("pip install --index-url http://localhost:8080/simple vectorops==0.1.0"),
  );
  assert.ok(
    result.execution_state_v1.completed_validations.includes("pip install --index-url http://localhost:8080/simple vectorops==0.1.0"),
  );
  assert.ok(
    !result.execution_packet_v1.pending_validations.includes("pip install --index-url http://localhost:8080/simple vectorops==0.1.0"),
  );
});

test("planning/context compiles trajectory into execution kernel inputs", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Recover the local package index so clean clients can install vectorops again.",
        context: {},
        tool_candidates: ["bash", "grep", "python"],
        trajectory: externalArtifactVisibilityTrajectory(),
        trajectory_hints: {
          repo_root: "/app",
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = PlanningContextRouteContractSchema.parse(JSON.parse(response.body));
    assert.equal(body.execution_kernel.execution_packet_v1_present, true);
    assert.equal(body.execution_summary.collaboration_summary.packet_present, true);
    assert.ok(body.execution_summary.collaboration_summary.target_file_count >= 2);
    assert.ok(body.execution_summary.collaboration_summary.acceptance_check_count >= 2);
    assert.equal(body.execution_summary.collaboration_summary.resume_anchor_present, true);
  } finally {
    await app.close();
  }
});

test("planning/context plans runtime verifier requests from execution packet without self-verification evidence", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Verify the detached service from the runtime parent after the agent exits.",
        context: {},
        tool_candidates: ["bash", "test"],
        execution_packet_v1: runtimeVerifierExecutionPacket(),
        runtime_verification: {
          mode: "plan",
          agent_lifecycle_state: "agent_exited",
        },
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = PlanningContextRouteContractSchema.parse(JSON.parse(response.body));
    const runtimeVerification = body.execution_kernel.runtime_verification;
    assert.ok(runtimeVerification);
    assert.equal(runtimeVerification.requested_mode, "plan");
    assert.equal(runtimeVerification.execution_state, "planned");
    assert.equal(runtimeVerification.request_count, 1);
    assert.equal(runtimeVerification.result_count, 0);
    assert.equal(runtimeVerification.evidence_for_trust_gate, null);
    assert.equal(runtimeVerification.summary.authoritative_evidence_ready, false);
    assert.ok(runtimeVerification.summary.reason_codes.includes("planned_not_executed"));
    assert.equal(runtimeVerification.requests[0]?.after_agent_exit, true);
    assert.equal(runtimeVerification.requests[0]?.fresh_shell, true);
    assert.equal(runtimeVerification.requests[0]?.validation_boundary, "runtime_orchestrator");
  } finally {
    await app.close();
  }
});

test("planning/context applies runtime entropy verifier defaults without executing verifier commands", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Plan strict runtime verification from carried entropy controls.",
        context: {},
        tool_candidates: ["bash", "test"],
        execution_packet_v1: runtimeVerifierExecutionPacket(),
        runtime_entropy_controls: strictRuntimeEntropyControls(),
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = PlanningContextRouteContractSchema.parse(JSON.parse(response.body));
    const runtimeVerification = body.execution_kernel.runtime_verification;
    assert.ok(runtimeVerification);
    assert.equal(runtimeVerification.requested_mode, "plan");
    assert.equal(runtimeVerification.execution_state, "planned");
    assert.equal(runtimeVerification.result_count, 0);
    assert.ok(runtimeVerification.summary.reason_codes.includes("planned_not_executed"));
    const verifierDefaults = (body.recall as Record<string, any>).observability?.adaptive?.runtime_entropy_verifier_defaults;
    assert.equal(verifierDefaults?.applied, true);
    assert.equal(verifierDefaults?.reason, "applied");
    assert.equal(verifierDefaults?.verifier_schedule, "strict");
    assert.equal(verifierDefaults?.runtime_verifier_required, true);
    assert.equal(verifierDefaults?.defaults?.mode, "plan");
    assert.equal(verifierDefaults?.defaults?.max_requests, 16);
  } finally {
    await app.close();
  }
});

test("planning/context blocks after-exit runtime verifier execution until agent exit is confirmed", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Verify the detached service from the runtime parent after the agent exits.",
        context: {},
        tool_candidates: ["bash", "test"],
        execution_packet_v1: runtimeVerifierExecutionPacket(),
        runtime_verification: {
          mode: "execute",
          agent_lifecycle_state: "agent_running",
          agent_claimed_success: true,
          timeout_ms: 10_000,
        },
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = PlanningContextRouteContractSchema.parse(JSON.parse(response.body));
    const runtimeVerification = body.execution_kernel.runtime_verification;
    assert.ok(runtimeVerification);
    assert.equal(runtimeVerification.execution_state, "blocked");
    assert.equal(runtimeVerification.request_count, 1);
    assert.equal(runtimeVerification.executable_request_count, 0);
    assert.equal(runtimeVerification.blocked_request_count, 1);
    assert.equal(runtimeVerification.result_count, 0);
    assert.equal(runtimeVerification.evidence_for_trust_gate, null);
    assert.equal(runtimeVerification.blocked_requests[0]?.reason, "agent_exit_not_confirmed");
    assert.ok(runtimeVerification.summary.reason_codes.includes("agent_exit_not_confirmed"));
  } finally {
    await app.close();
  }
});

test("planning/context executes runtime verifier after confirmed agent exit and feeds evidence to execution side outputs", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/planning/context",
      payload: {
        tenant_id: "default",
        scope: "default",
        query_text: "Verify the detached service from the runtime parent after the agent exits.",
        context: {},
        tool_candidates: ["bash", "test"],
        execution_packet_v1: runtimeVerifierExecutionPacket(),
        runtime_verification: {
          mode: "execute",
          agent_lifecycle_state: "agent_exited",
          agent_claimed_success: true,
          timeout_ms: 10_000,
        },
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = PlanningContextRouteContractSchema.parse(JSON.parse(response.body));
    const runtimeVerification = body.execution_kernel.runtime_verification;
    assert.ok(runtimeVerification);
    assert.equal(runtimeVerification.execution_state, "executed");
    assert.equal(runtimeVerification.request_count, 1);
    assert.equal(runtimeVerification.executable_request_count, 1);
    assert.equal(runtimeVerification.blocked_request_count, 0);
    assert.equal(runtimeVerification.result_count, 1);
    assert.equal(runtimeVerification.results[0]?.command_result.stdout_tail, "ok");
    assert.equal(runtimeVerification.evidence_for_trust_gate?.validation_boundary, "runtime_orchestrator");
    assert.equal(runtimeVerification.evidence_for_trust_gate?.validation_passed, true);
    assert.equal(runtimeVerification.evidence_for_trust_gate?.after_exit_revalidated, true);
    assert.equal(runtimeVerification.evidence_for_trust_gate?.fresh_shell_probe_passed, true);
    assert.equal(runtimeVerification.evidence_for_trust_gate?.false_confidence_detected, false);
    assert.equal(runtimeVerification.summary.authoritative_evidence_ready, true);
    assert.ok(runtimeVerification.summary.reason_codes.includes("after_exit_revalidated"));
    assert.ok(runtimeVerification.summary.reason_codes.includes("fresh_shell_probe_passed"));
    assert.equal(body.execution_summary.collaboration_summary.side_output_evidence_count, 1);
  } finally {
    await app.close();
  }
});

test("handoff/store compiles trajectory into effective contract and lifecycle constraints", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor: "resume:/app/scripts/build_and_serve.py",
        file_path: "/app/scripts/build_and_serve.py",
        repo_root: "/app",
        handoff_kind: "patch_handoff",
        title: "Recover external artifact handoff",
        summary: "Recover the local package index so clean clients can install vectorops again.",
        handoff_text: "Patch the narrow artifact path and validate it from a fresh shell.",
        trajectory: externalArtifactVisibilityTrajectory(),
        trajectory_hints: {
          repo_root: "/app",
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as Record<string, any>;
    assert.ok(Array.isArray(body.handoff?.target_files));
    assert.ok(body.handoff.target_files.includes("scripts/build_and_serve.py"));
    assert.ok(body.handoff.target_files.includes("/app/src/vectorops/__init__.py"));
    assert.ok(Array.isArray(body.handoff?.acceptance_checks));
    assert.ok(body.handoff.acceptance_checks.some((entry: string) => entry.includes("curl -fsS http://localhost:8080/simple/vectorops/")));
    assert.ok(body.handoff.acceptance_checks.some((entry: string) => entry.includes("pip install --index-url http://localhost:8080/simple vectorops==0.1.0")));
    assert.equal(body.execution_contract_v1.schema_version, "execution_contract_v1");
    assert.equal(body.execution_contract_v1.task_family, "external_artifact_visibility");
    assert.ok(Array.isArray(body.execution_contract_v1.outcome.acceptance_checks));
    assert.ok(body.execution_contract_v1.outcome.success_invariants.includes("clean_consumer_install_succeeds"));
    assert.ok(body.execution_contract_v1.outcome.dependency_requirements.some((entry: string) => entry.includes("artifacts and index metadata")));
    assert.ok(body.execution_contract_v1.outcome.environment_assumptions.includes("validation_can_run_from_fresh_shell"));
    assert.ok(body.execution_contract_v1.outcome.must_hold_after_exit.some((entry: string) => entry.includes("service_survives_agent_exit")));
    assert.equal(body.execution_packet_v1.service_lifecycle_constraints.length, 1);
    assert.equal(body.execution_packet_v1.service_lifecycle_constraints[0].must_survive_agent_exit, true);
    assert.ok(body.execution_result_summary?.trajectory_compile_v1);
    assert.ok(body.execution_result_summary?.execution_contract_v1);
  } finally {
    await app.close();
  }
});
