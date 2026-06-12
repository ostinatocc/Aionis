import assert from "node:assert/strict";
import test from "node:test";
import {
  AionisClient,
  AionisClientError,
  activeRouteTargetsFromGuide,
  agentContextFromGuide,
  agentPromptFromGuide,
  blockedDirectionRouteTargetsFromGuide,
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  createAionisClient,
  feedbackFromGuide,
  mustNotMemoryIdsFromGuide,
  measureInputFromGuideLoop,
  memoryIdsFromGuide,
  pendingArtifactTargetsFromGuide,
  referenceOnlyRouteTargetsFromGuide,
  routeContractFromGuide,
  shouldContinueMemoryIdsFromGuide,
  snapshotInputFromGuideLoop,
} from "../../src/sdk.ts";

test("AionisClient wraps the product facade APIs with scope defaults", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true, path: String(input) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001/",
    apiKey: "test-key",
    tenant_id: "tenant-a",
    scope: "scope-a",
    headers: { "x-client": "sdk-test" },
    fetchImpl: fakeFetch,
  });

  await client.observe({ input_text: "Observed event." });
  await client.guide({ context: { task: "continue" } }, { scope: "scope-b" });
  await client.forget({ operation: "suppress", target: "memory", memory_id: "mem-1" });
  await client.feedback({
    reason: "Agent used exposed memory successfully.",
    run_id: "run-feedback",
    outcome: "positive",
    used_surface: "use_now",
    guide_trace_id: "guide-trace-feedback",
    used_memory_ids: ["mem-used"],
  });
  await client.rehydrate({
    reason: "Expand archived payload before exact use.",
    anchor_uri: "aionis://anchor/payload-1",
    mode: "partial",
  });
  await client.measure({ baseline: { score: 0.3 }, aionis: { score: 0.7 } });
  await client.snapshot({ run_id: "run-operator", include_markdown: true });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/rehydrate",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["x-client"], "sdk-test");

  const observeBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(observeBody.tenant_id, "tenant-a");
  assert.equal(observeBody.scope, "scope-a");
  assert.equal(observeBody.input_text, "Observed event.");

  const guideBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
  assert.equal(guideBody.tenant_id, "tenant-a");
  assert.equal(guideBody.scope, "scope-b");
  assert.equal(guideBody.mode, "full_power");

  const feedbackBody = JSON.parse(String(calls[3]?.init.body)) as Record<string, unknown>;
  assert.equal(feedbackBody.operation, undefined);
  assert.equal(feedbackBody.target, undefined);
  assert.equal(feedbackBody.guide_trace_id, "guide-trace-feedback");
  assert.deepEqual(feedbackBody.used_memory_ids, ["mem-used"]);

  const rehydrateBody = JSON.parse(String(calls[4]?.init.body)) as Record<string, unknown>;
  assert.equal(rehydrateBody.operation, undefined);
  assert.equal(rehydrateBody.anchor_uri, "aionis://anchor/payload-1");
  assert.equal(rehydrateBody.mode, "partial");

  const snapshotBody = JSON.parse(String(calls[6]?.init.body)) as Record<string, unknown>;
  assert.equal(snapshotBody.tenant_id, "tenant-a");
  assert.equal(snapshotBody.scope, "scope-a");
  assert.equal(snapshotBody.run_id, "run-operator");
});

test("AionisClient defaults guide to full_power and allows explicit guide mode control", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const defaultClient = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  await defaultClient.guide({ query_text: "continue" });
  await defaultClient.guide({ query_text: "legacy", mode: "standard" });
  await defaultClient.guide({ query_text: "context explicit", context_mode: "standard" });
  await defaultClient.guide({ query_text: "compact execution context", context_mode: "compact_agent" });
  await defaultClient.guide({ query_text: "request override" }, { guide_mode: "standard" });
  await defaultClient.guide({ query_text: "raw route body" }, { guide_mode: null });

  const standardClient = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    default_guide_mode: "standard",
    fetchImpl: fakeFetch,
  });
  await standardClient.guide({ query_text: "client legacy default" });

  assert.equal(calls[0]?.mode, "full_power");
  assert.equal(calls[1]?.mode, "standard");
  assert.equal(calls[2]?.context_mode, "standard");
  assert.equal(calls[2]?.mode, undefined);
  assert.equal(calls[3]?.context_mode, "compact_agent");
  assert.equal(calls[3]?.mode, "full_power");
  assert.equal(calls[4]?.mode, "standard");
  assert.equal(calls[5]?.mode, undefined);
  assert.equal(calls[6]?.mode, "standard");
});

test("AionisClient remember writes ordinary memory through observe", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.remember({
    kind: "preference",
    text: "Prefer concise status updates with concrete evidence.",
    title: "Status preference",
    client_id: "pref-status",
    memory_lane: "private",
    owner_agent_id: "agent-1",
    confidence: 0.9,
    slots: { source: "user" },
  });

  assert.equal(calls[0]?.url, "http://127.0.0.1:3001/v1/observe");
  const body = calls[0]?.body ?? {};
  assert.equal(body.tenant_id, "tenant-a");
  assert.equal(body.scope, "scope-a");
  assert.equal(body.auto_embed, true);
  assert.equal(body.input_text, "Prefer concise status updates with concrete evidence.");
  assert.equal(body.memory_kind, "general_memory");
  assert.equal(body.memory_lane, "private");
  assert.equal(body.owner_agent_id, "agent-1");

  const memory = body.memory as Record<string, unknown>;
  assert.equal(memory.client_id, "pref-status");
  assert.equal(memory.type, "self_model");
  assert.equal(memory.memory_kind, "general_memory");
  assert.equal(memory.title, "Status preference");
  assert.equal(memory.text_summary, "Prefer concise status updates with concrete evidence.");
  assert.equal(memory.confidence, 0.9);
  const slots = memory.slots as Record<string, unknown>;
  assert.equal(slots.source, "user");
  assert.equal(slots.memory_kind, "general_memory");
  assert.equal(slots.lifecycle_state, "active");
  assert.equal("state" in slots, false);
  assert.equal(slots.compression_layer, "L2");
});

test("agent prompt helpers expose only agent_context from guide responses", () => {
  const guide = {
    guide_trace_id: "guide-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      use_now_memory_ids: ["mem-1"],
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(agentContextFromGuide<Record<string, unknown>>(guide).use_now_memory_ids, ["mem-1"]);
  assert.throws(() => agentPromptFromGuide({ memory_packet: {} }), /missing agent_context/);
});

test("SDK product-loop helpers keep guide feedback attribution explicit", () => {
  const guide = {
    guide_trace_id: "guide-product-loop",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      memory_ids: ["mem-1", "mem-2"],
      use_now_memory_ids: ["mem-1"],
      inspect_before_use_memory_ids: ["mem-2"],
      do_not_use_memory_ids: ["mem-3"],
      rehydrate_hints: [{ memory_id: "mem-4", reason: "Needs raw payload." }],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-1",
          instruction: "Continue current state.",
          reason: "Current state is active.",
          target_files: ["src/current.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-5",
          instruction: "Do not reuse stale memory.",
          reason: "Memory is stale.",
          target_files: ["src/stale.ts"],
        },
      ],
      route_contract: {
        active_targets: [
          {
            target: "src/current.ts",
            source_memory_id: "mem-1",
            source: "should_continue",
            artifact_status: "may_be_absent",
            missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          },
        ],
        pending_artifacts: [
          {
            target: "src/current.ts",
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
            target: "src/reference.ts",
            source_memory_id: "mem-6",
            source: "inspect_first",
          },
        ],
        blocked_direction_targets: [
          {
            target: "src/stale.ts",
            source_memory_id: "mem-5",
            source: "must_not",
          },
        ],
        fallback_policy: "do_not_promote_reference_or_blocked_targets",
      },
    },
  };

  assert.deepEqual(memoryIdsFromGuide(guide), ["mem-1", "mem-2", "mem-3", "mem-4", "mem-5", "mem-6"]);
  assert.deepEqual(commandPostureMemoryIdsFromGuide(guide), ["mem-1", "mem-5"]);
  assert.deepEqual(shouldContinueMemoryIdsFromGuide(guide), ["mem-1"]);
  assert.deepEqual(mustNotMemoryIdsFromGuide(guide), ["mem-5"]);
  assert.equal(commandPostureFromGuide(guide, "must_not")[0]?.reason, "Memory is stale.");
  assert.equal(routeContractFromGuide(guide)?.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
  assert.equal(routeContractFromGuide(guide)?.fallback_policy, "do_not_promote_reference_or_blocked_targets");
  assert.deepEqual(routeContractFromGuide(guide)?.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(routeContractFromGuide(guide)?.pending_artifacts[0]?.terminal_inspect_allowed, false);
  assert.deepEqual(activeRouteTargetsFromGuide(guide), ["src/current.ts"]);
  assert.deepEqual(pendingArtifactTargetsFromGuide(guide), ["src/current.ts"]);
  assert.deepEqual(referenceOnlyRouteTargetsFromGuide(guide), ["src/reference.ts"]);
  assert.deepEqual(blockedDirectionRouteTargetsFromGuide(guide), ["src/stale.ts"]);
  assert.deepEqual(feedbackFromGuide({
    guide,
    reason: "Agent used mem-1 successfully.",
    run_id: "run-product-loop",
    outcome: "positive",
    used_memory_ids: ["mem-1"],
    verifier_status: "passed",
    tool_status: "succeeded",
  }), {
    reason: "Agent used mem-1 successfully.",
    run_id: "run-product-loop",
    outcome: "positive",
    used_surface: "use_now",
    guide_trace_id: "guide-product-loop",
    used_memory_ids: ["mem-1"],
    verifier_status: "passed",
    tool_status: "succeeded",
  });
  assert.throws(
    () => feedbackFromGuide({
      guide,
      reason: "Bad attribution.",
      run_id: "run-product-loop",
      outcome: "positive",
      used_memory_ids: ["mem-not-shown"],
    }),
    /not exposed by guide/,
  );
});

test("SDK product-loop helpers assemble measure and snapshot inputs without leaking prompt internals", () => {
  const beforeGuide = {
    guide_trace_id: "guide-before",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\nstate role=agent history=fresh",
      use_now_memory_ids: [],
    },
  };
  const afterGuide = {
    guide_trace_id: "guide-after",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      use_now_memory_ids: ["mem-1"],
    },
    guide_packet: {
      contract_version: "aionis_guide_packet_v1",
    },
    memory_packet: {
      raw: "operator-only",
    },
  };
  const feedback = {
    product_action: "feedback",
    operation: "activate",
    forget_effect: {
      changed_count: 1,
    },
  };
  const measureInput = measureInputFromGuideLoop({
    task: {
      task_id: "task-product-loop",
      run_id: "run-product-loop",
      task_signature: "product-loop",
      task_family: "developer_sdk",
    },
    before_guide: beforeGuide,
    after_guide: afterGuide,
    feedback_result: feedback,
    sufficient_evidence: true,
    evidence_ids: ["feedback:run-product-loop"],
  });

  assert.equal((measureInput.task as Record<string, unknown>).run_id, "run-product-loop");
  const productTrace = measureInput.product_trace as Record<string, unknown>;
  assert.equal(productTrace.before_guide, beforeGuide);
  assert.equal(productTrace.after_guide, afterGuide);
  assert.equal(productTrace.forget_result, feedback);
  assert.equal(productTrace.sufficient_evidence, true);

  const measureResult = {
    effect_report: {
      contract_version: "aionis_effect_report_v1",
    },
    memory_decision_trace: {
      contract_version: "aionis_memory_decision_trace_v1",
    },
    memory_decision_audit: {
      contract_version: "aionis_memory_decision_audit_report_v1",
    },
  };
  const snapshotInput = snapshotInputFromGuideLoop({
    run_id: "run-product-loop",
    task_signature: "product-loop",
    task_family: "developer_sdk",
    guide: afterGuide,
    measure_result: measureResult,
    include_markdown: true,
  });

  assert.equal(snapshotInput.run_id, "run-product-loop");
  assert.equal(snapshotInput.agent_context, afterGuide.agent_context);
  assert.equal(snapshotInput.guide_packet, afterGuide.guide_packet);
  assert.equal(snapshotInput.memory_decision_trace, measureResult.memory_decision_trace);
  assert.equal(snapshotInput.memory_decision_audit, measureResult.memory_decision_audit);
  assert.equal(snapshotInput.effect_report, measureResult.effect_report);
  assert.equal(snapshotInput.guide_trace_id, "guide-after");
  assert.equal("memory_packet" in snapshotInput, false);
});

test("AionisClient health and structured error handling", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (String(input).endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
  };
  const client = new AionisClient({
    baseUrl: "http://localhost:3001",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(await client.health(), { ok: true });
  await assert.rejects(
    () => client.observe({}),
    (error) => {
      assert.ok(error instanceof AionisClientError);
      assert.equal(error.status, 400);
      assert.equal(error.path, "/v1/observe");
      assert.deepEqual(error.response, { error: "bad_request" });
      return true;
    },
  );
  assert.equal(calls[0]?.init.method, "GET");
});
