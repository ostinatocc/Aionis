import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRouteTargetsFromGuide,
  agentPromptFromGuide,
  blockedDirectionRouteTargetsFromGuide,
  blockedRoutesFromGuide,
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  compileCodingAgentContext,
  compileExecutionAgentContext,
  createAionisClient,
  evidenceSourcesFromGuide,
  feedbackFromGuide,
  inspectFirstMemoryIdsFromGuide,
  memoryIdsFromGuide,
  memoryUseReceiptFromGuide,
  mustNotMemoryIdsFromGuide,
  pendingArtifactTargetsFromGuide,
  referenceOnlyRouteTargetsFromGuide,
  rehydrateHintsFromGuide,
  routeContractFromGuide,
  shouldContinueMemoryIdsFromGuide,
} from "../src/index.ts";

test("@aionis/sdk wraps product facade routes", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001/",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.guide({ query_text: "continue" });
  await client.feedback({
    reason: "used memory",
    run_id: "run-1",
    outcome: "positive",
    used_surface: "use_now",
    used_memory_ids: ["mem-1"],
  });
  await client.snapshot({ run_id: "run-1" });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);
  assert.equal(calls[0]?.body.tenant_id, "tenant-a");
  assert.equal(calls[0]?.body.scope, "scope-a");
  assert.equal(calls[0]?.body.mode, "full_power");
});

test("@aionis/sdk guide helpers keep Agent prompt and feedback attribution bounded", () => {
  const guide = {
    guide_trace_id: "guide-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      memory_ids: ["mem-1"],
      use_now_memory_ids: ["mem-1"],
      inspect_before_use_memory_ids: ["mem-2"],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-1",
          instruction: "Continue the current branch.",
          reason: "The branch is active.",
          target_files: ["src/a.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-3",
          instruction: "Do not reuse the failed branch.",
          reason: "The branch failed verification.",
          target_files: ["src/old.ts"],
        },
        {
          posture: "inspect_first",
          surface: "inspect_before_use",
          memory_id: "mem-2",
          instruction: "Inspect before relying on this candidate.",
          reason: "The memory is candidate-only.",
          target_files: [],
        },
      ],
      route_contract: {
        active_targets: [
          {
            target: "src/a.ts",
            source_memory_id: "mem-1",
            source: "should_continue",
            artifact_status: "may_be_absent",
            missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          },
        ],
        pending_artifacts: [
          {
            target: "src/a.ts",
            source_memory_id: "mem-1",
            source: "should_continue",
            status: "unknown_until_host_observation",
            when: "if_active_target_is_missing",
            allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
            preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
            terminal_inspect_allowed: false,
          },
        ],
        reference_only_targets: [
          {
            target: "src/candidate.ts",
            source_memory_id: "mem-2",
            source: "inspect_first",
          },
        ],
        blocked_direction_targets: [
          {
            target: "src/old.ts",
            source_memory_id: "mem-3",
            source: "must_not",
          },
        ],
        evidence_sources: [
          {
            target: "src/candidate.ts",
            source_memory_id: "mem-2",
            source: "inspect_first",
            evidence_use: "reference_only",
            direction_policy: "must_not_be_primary_route",
          },
        ],
        blocked_routes: [
          {
            target: "src/old.ts",
            source_memory_id: "mem-3",
            source: "must_not",
            direction_policy: "blocked_route",
            evidence_use: "counter_evidence_only",
          },
        ],
        fallback_policy: "do_not_promote_reference_or_blocked_targets",
      },
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(memoryIdsFromGuide(guide), ["mem-1", "mem-2", "mem-3"]);
  assert.deepEqual(commandPostureMemoryIdsFromGuide(guide), ["mem-1", "mem-3", "mem-2"]);
  assert.deepEqual(shouldContinueMemoryIdsFromGuide(guide), ["mem-1"]);
  assert.deepEqual(mustNotMemoryIdsFromGuide(guide), ["mem-3"]);
  assert.deepEqual(inspectFirstMemoryIdsFromGuide(guide), ["mem-2"]);
  assert.deepEqual(commandPostureFromGuide(guide, "must_not")[0]?.instruction, "Do not reuse the failed branch.");
  assert.equal(routeContractFromGuide(guide)?.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
  assert.equal(routeContractFromGuide(guide)?.fallback_policy, "do_not_promote_reference_or_blocked_targets");
  assert.deepEqual(routeContractFromGuide(guide)?.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(routeContractFromGuide(guide)?.pending_artifacts[0]?.terminal_inspect_allowed, false);
  assert.deepEqual(activeRouteTargetsFromGuide(guide), ["src/a.ts"]);
  assert.deepEqual(pendingArtifactTargetsFromGuide(guide), ["src/a.ts"]);
  assert.deepEqual(referenceOnlyRouteTargetsFromGuide(guide), ["src/candidate.ts"]);
  assert.deepEqual(blockedDirectionRouteTargetsFromGuide(guide), ["src/old.ts"]);
  assert.deepEqual(evidenceSourcesFromGuide(guide), [
    {
      target: "src/candidate.ts",
      source_memory_id: "mem-2",
      source: "inspect_first",
      evidence_use: "reference_only",
      direction_policy: "must_not_be_primary_route",
    },
  ]);
  assert.deepEqual(blockedRoutesFromGuide(guide), [
    {
      target: "src/old.ts",
      source_memory_id: "mem-3",
      source: "must_not",
      direction_policy: "blocked_route",
      evidence_use: "counter_evidence_only",
    },
  ]);
  assert.deepEqual(feedbackFromGuide({
    guide,
    reason: "Agent used mem-1.",
    run_id: "run-1",
    outcome: "positive",
    used_memory_ids: ["mem-1"],
  }).guide_trace_id, "guide-1");
  assert.throws(
    () => feedbackFromGuide({
      guide,
      reason: "Agent used an unexposed memory.",
      run_id: "run-1",
      outcome: "positive",
      used_memory_ids: ["mem-4"],
    }),
    /not exposed by guide/,
  );
});

test("@aionis/sdk compiles a contract-style execution Agent context", () => {
  const guide = {
    guide_trace_id: "guide-route-1",
    agent_context: {
      prompt_text: "AIONIS_CTX v2\nuse current branch. inspect legacy branch only as reference.",
      memory_ids: ["mem-current", "mem-inspect", "mem-blocked", "mem-archive"],
      use_now_memory_ids: ["mem-current"],
      inspect_before_use_memory_ids: ["mem-inspect"],
      do_not_use_memory_ids: ["mem-blocked"],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-current",
          instruction: "Continue the bundledDev migration.",
          reason: "Accepted active route.",
          target_files: ["packages/vite/src/node/server/bundledDev.ts"],
        },
        {
          posture: "inspect_first",
          surface: "inspect_before_use",
          memory_id: "mem-inspect",
          instruction: "Read fullBundleEnvironment only as legacy reference.",
          reason: "Superseded source path.",
          target_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-blocked",
          instruction: "Do not implement the old fullBundleEnvironment route.",
          reason: "Failed branch.",
          target_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
        },
        {
          posture: "rehydrate_first",
          surface: "rehydrate",
          memory_id: "mem-archive",
          instruction: "Rehydrate original patch payload before exact copy.",
          reason: "Compact context may omit long hunks.",
          target_files: ["packages/vite/src/node/server/bundledDev.ts"],
        },
      ],
      route_contract: {
        active_targets: [
          {
            target: "packages/vite/src/node/server/bundledDev.ts",
            source_memory_id: "mem-current",
            source: "should_continue",
            artifact_status: "may_be_absent",
            missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          },
        ],
        pending_artifacts: [
          {
            target: "packages/vite/src/node/server/bundledDev.ts",
            source_memory_id: "mem-current",
            source: "should_continue",
            status: "unknown_until_host_observation",
            when: "if_active_target_is_missing",
            allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
            preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
            terminal_inspect_allowed: false,
          },
        ],
        reference_only_targets: [
          {
            target: "packages/vite/src/node/server/environments/fullBundleEnvironment.ts",
            source_memory_id: "mem-inspect",
            source: "inspect_first",
          },
        ],
        blocked_direction_targets: [
          {
            target: "packages/vite/src/node/server/environments/fullBundleEnvironment.ts",
            source_memory_id: "mem-blocked",
            source: "must_not",
          },
        ],
      },
      rehydrate_hints: [
        {
          memory_id: "mem-archive",
          reason: "Exact accepted patch payload is archived.",
          required: true,
        },
      ],
      risk: {
        reasons: ["legacy route is superseded"],
      },
    },
  };

  const compiled = compileExecutionAgentContext({
    guide,
    task: {
      task_signature: "vite-bundled-dev",
      query_text: "Continue the migration.",
    },
    repo_state: {
      missing_files: ["packages/vite/src/node/server/bundledDev.ts"],
      existing_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
    },
    budget_profile: "balanced",
  });

  assert.equal(compiled.contract_version, "aionis_execution_agent_context_v1");
  assert.equal(compiled.budget_profile, "balanced");
  assert.deepEqual(compiled.use_now_memory_ids, ["mem-current"]);
  assert.deepEqual(compiled.inspect_before_use_memory_ids, ["mem-inspect"]);
  assert.deepEqual(compiled.do_not_use_memory_ids, ["mem-blocked"]);
  assert.deepEqual(compiled.active_targets, ["packages/vite/src/node/server/bundledDev.ts"]);
  assert.deepEqual(compiled.missing_active_targets, ["packages/vite/src/node/server/bundledDev.ts"]);
  assert.deepEqual(compiled.reference_only_targets, ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"]);
  assert.deepEqual(compiled.blocked_direction_targets, ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"]);
  assert.equal(compiled.execution_warnings[0]?.code, "missing_active_target");
  assert.match(compiled.agent_prompt, /AIONIS_EXECUTION_AGENT_CONTEXT v1/);
  assert.match(compiled.agent_prompt, /If an active target is missing, treat it as pending work/);
  assert.match(compiled.agent_prompt, /packages\/vite\/src\/node\/server\/bundledDev\.ts/);
  assert.match(compiled.agent_prompt, /BLOCKED_DIRECTION_TARGETS/);
  assert.match(compiled.agent_prompt, /fullBundleEnvironment\.ts/);
  assert.match(compiled.agent_prompt, /BASE_AIONIS_CONTEXT/);
  assert.deepEqual(rehydrateHintsFromGuide(guide), [{
    memory_id: "mem-archive",
    reason: "Exact accepted patch payload is archived.",
    required: true,
  }]);
  assert.equal(memoryUseReceiptFromGuide(guide).agent_prompt_included, false);
  assert.deepEqual(memoryUseReceiptFromGuide(guide).rehydrate_memory_ids, ["mem-archive"]);

  const coding = compileCodingAgentContext({ guide, include_base_prompt: false, max_prompt_chars: 2_000 });
  assert.equal(coding.base_prompt, guide.agent_context.prompt_text);
  assert.doesNotMatch(coding.agent_prompt, /BASE_AIONIS_CONTEXT/);
});

test("@aionis/sdk compact execution compiler respects prompt budget", () => {
  const longPrompt = "base ".repeat(1_000);
  const guide = {
    guide_trace_id: "guide-compact-1",
    agent_context: {
      prompt_text: longPrompt,
      memory_ids: ["mem-1"],
      use_now_memory_ids: ["mem-1"],
      command_posture: [],
      route_contract: {
        active_targets: [],
        pending_artifacts: [],
        reference_only_targets: [],
        blocked_direction_targets: [],
      },
    },
  };

  const compiled = compileExecutionAgentContext({
    guide,
    budget_profile: "compact",
    max_prompt_chars: 1_200,
  });

  assert.equal(compiled.agent_prompt.length <= 1_200, true);
  assert.equal(compiled.memory_use_receipt.history_used, true);
  assert.equal(compiled.memory_use_receipt.actionable_history_used, true);
  assert.deepEqual(compiled.memory_use_receipt.use_now_memory_ids, ["mem-1"]);
});

test("@aionis/sdk compact agent context keeps default full_power guide mode", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  await client.execution.guideForRole({
    agent_id: "agent-compact",
    run_id: "run-compact",
    task_signature: "compact-agent",
    query_text: "Continue from current execution state.",
    context_mode: "compact_agent",
  });

  assert.equal(calls[0]?.mode, "full_power");
  assert.equal(calls[0]?.context_mode, "compact_agent");
});

test("@aionis/sdk execution helpers wrap observe, guide, feedback, measure, and snapshot", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({
      ok: true,
      guide_trace_id: "guide-exec-1",
      agent_context: {
        prompt_text: "AIONIS_CTX v2\ncurrent use_now=passed branch",
        memory_ids: ["mem-exec-1"],
        use_now_memory_ids: ["mem-exec-1"],
      },
      effect_report: {
        history_impact: { impact_direction: "positive" },
      },
      memory_decision_trace: {
        memory_use_receipt: { contract_version: "aionis_memory_use_receipt_v1" },
      },
    }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.execution.observeStep({
    agent_id: "worker-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Implement adapter",
    summary: "Worker implemented the checkout adapter.",
    outcome: "succeeded",
    target_files: ["src/checkout.ts"],
    acceptance_checks: ["unit tests pass"],
  });

  await client.execution.handoff({
    agent_id: "planner-1",
    team_id: "checkout-team",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer handoff",
    summary: "Continue the verified branch and avoid broad legacy search.",
    continuation_hint: "review boundary and continue passed branch",
  });

  const guide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: "reviewer-1",
    team_id: "checkout-team",
    role: "reviewer",
    run_id: "run-1",
    task_signature: "checkout-migration",
    query_text: "Continue the checkout migration from current state.",
  });

  const feedback = await client.execution.feedbackFromOutcome({
    agent_id: "reviewer-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer continued branch",
    summary: "Reviewer used the current execution memory.",
    outcome: "succeeded",
    guide,
    used_memory_ids: ["mem-exec-1"],
  });

  const measure = await client.execution.measureRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    after_guide: guide,
    feedback_result: feedback,
    sufficient_evidence: true,
  });

  await client.execution.snapshotRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    guide,
    measure_result: measure,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);

  assert.equal(calls[0]?.body.memory_lane, "private");
  assert.equal((calls[0]?.body.execution as Record<string, unknown>).outcome, "succeeded");
  assert.deepEqual((calls[0]?.body.execution as Record<string, unknown>).target_files, ["src/checkout.ts"]);

  assert.equal(calls[1]?.body.memory_lane, "shared");
  assert.equal(calls[1]?.body.owner_team_id, "checkout-team");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).handoff_kind, "task_handoff");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).anchor, "checkout-migration:run-1:planner-1");

  assert.equal(calls[2]?.body.mode, "full_power");
  assert.equal(calls[2]?.body.agent_role, "reviewer");
  assert.equal(calls[2]?.body.consumer_agent_id, "reviewer-1");
  assert.equal(calls[2]?.body.consumer_team_id, "checkout-team");

  assert.equal(calls[3]?.body.guide_trace_id, "guide-exec-1");
  assert.deepEqual(calls[3]?.body.used_memory_ids, ["mem-exec-1"]);
  assert.equal(calls[3]?.body.outcome, "positive");
  assert.equal(calls[3]?.body.verifier_status, "passed");
  assert.equal(calls[3]?.body.tool_status, "succeeded");

  assert.equal((calls[4]?.body.task as Record<string, unknown>).task_signature, "checkout-migration");
  assert.equal((calls[5]?.body.agent_context as Record<string, unknown>).prompt_text, "AIONIS_CTX v2\ncurrent use_now=passed branch");
});
