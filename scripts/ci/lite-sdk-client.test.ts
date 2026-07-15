import assert from "node:assert/strict";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";
import {
  AionisClient,
  AionisClientError,
  AionisGuideFeedbackError,
  activeRouteTargetsFromGuide,
  agentContextFromGuide,
  agentPromptFromGuide,
  blockedDirectionRouteTargetsFromGuide,
  blockedRoutesFromGuide,
  buildHostTaskEnvelopeV1,
  buildHostUseReceiptV1,
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  createAionisClient,
  evidenceSourcesFromGuide,
  feedbackAttributionFromGuide,
  feedbackFromGuide,
  hostTaskEnvelopeDigest,
  hostUseReceiptDigest,
  mustNotMemoryIdsFromGuide,
  measureInputFromGuideLoop,
  memoryIdsFromGuide,
  parseGuideFeedbackAttributionV1,
  parseHostTaskEnvelopeV1,
  parseHostUseReceiptV1,
  pendingArtifactTargetsFromGuide,
  planAssetObserveEvents,
  referenceOnlyRouteTargetsFromGuide,
  routeContractFromGuide,
  shouldContinueMemoryIdsFromGuide,
  snapshotInputFromGuideLoop,
} from "../../src/sdk.ts";
import {
  hostTaskEnvelopeDigest as coreHostTaskEnvelopeDigest,
  hostUseReceiptDigest as coreHostUseReceiptDigest,
  learningDecisionSurfaceDigest,
  learningEpisodeId,
} from "../../src/memory/learning-episode-ledger.js";
import { sha256Hex } from "../../src/util/crypto.js";

const GUIDE_HOST_TASK_ENVELOPE = {
  contract_version: "host_task_envelope_v1",
  host_task_id: "sdk-guide-protected-task",
  collector_id: "sdk-test-collector",
  collector_version: "1.0.0",
  task_family: "sdk-guide",
  task_signature: "sdk-guide-protected-task-signature",
  repository_signature: "sdk-guide-repository-signature",
  source_task_sha256: "1".repeat(64),
  source_event_sha256: "2".repeat(64),
  created_at: "2026-07-14T00:00:00.000Z",
} as const;

const SDK_RECEIPT_DIGESTS = {
  config: "3".repeat(64),
  content: "4".repeat(64),
  evidence: "5".repeat(64),
  trace: "6".repeat(64),
} as const;

function sdkGuideFeedbackAttribution(args: {
  tenantId: string;
  scope: string;
  guideTraceId: string;
  items: Array<{
    memory_id: string;
    served_surface: "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate";
  }>;
}) {
  const items = [...args.items].sort((left, right) =>
    Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
  );
  return {
    contract_version: "aionis_guide_feedback_attribution_v1" as const,
    status: "available" as const,
    guide_trace_id: args.guideTraceId,
    episode_id: learningEpisodeId({
      tenantId: args.tenantId,
      scope: args.scope,
      guideTraceId: args.guideTraceId,
    }),
    exposure_event_id: `lexposure_${sha256Hex(stableStringify({
      tenant_id: args.tenantId,
      scope: args.scope,
      guide_trace_id: args.guideTraceId,
    }))}`,
    item_set_sha256: sha256Hex(stableStringify(items)),
    served_surface_sha256: learningDecisionSurfaceDigest(items.map((item) => ({
      memory_id: item.memory_id,
      action: item.served_surface,
    }))),
    projection_complete: true,
    projection_incomplete_reason_codes: [],
    items,
  };
}

function sdkReceiptItem(memoryId: string, overrides: Record<string, unknown> = {}) {
  return {
    memory_id: memoryId,
    used_surface: "inspect_before_use" as const,
    outcome: "positive" as const,
    action_outcome: "accepted_completed" as const,
    verifier_kind: "instrumented_agent_trace" as const,
    verifier_version: "1.0.0",
    verifier_config_sha256: SDK_RECEIPT_DIGESTS.config,
    verifier_status: "passed" as const,
    content_evidence_sha256: SDK_RECEIPT_DIGESTS.content,
    evidence_ref_sha256: SDK_RECEIPT_DIGESTS.evidence,
    ...overrides,
  };
}

function assertGuideFeedbackError(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AionisGuideFeedbackError);
    assert.equal(error.code, code);
    return true;
  });
}

function sdkReceiptBody(items = [sdkReceiptItem("memory-b"), sdkReceiptItem("memory-a")]) {
  return {
    contract_version: "host_use_receipt_v1" as const,
    receipt_id: "sdk-receipt-1",
    guide_trace_id: "sdk-guide-receipt-1",
    episode_id: learningEpisodeId({
      tenantId: "tenant-sdk",
      scope: "scope-sdk",
      guideTraceId: "sdk-guide-receipt-1",
    }),
    operation_id: "sdk-feedback-operation-1",
    run_id: "sdk-run-receipt-1",
    host_task_id: GUIDE_HOST_TASK_ENVELOPE.host_task_id,
    host_task_envelope_sha256: coreHostTaskEnvelopeDigest(GUIDE_HOST_TASK_ENVELOPE),
    collector_id: GUIDE_HOST_TASK_ENVELOPE.collector_id,
    collector_version: GUIDE_HOST_TASK_ENVELOPE.collector_version,
    host_trace_sha256: SDK_RECEIPT_DIGESTS.trace,
    observed_at: "2026-07-14T00:01:00.000Z",
    items,
  };
}

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
  await client.governMemory({
    query_text: "Govern external memories before prompt use.",
    candidates: [
      {
        external_memory_id: "mem0:current",
        source_backend: "mem0",
        text: "Current project state.",
        authority: {
          source_trust: "trusted",
          scope: "project",
          evidence_requirement: "none",
        },
        lifecycle_hint: "current",
      },
    ],
    include_records: true,
  });
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
  await client.flightRecorder({
    run_id: "run-flight",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      memory_ids: ["mem-current"],
    },
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/memory/govern",
    "http://127.0.0.1:3001/v1/forget",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/rehydrate",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
    "http://127.0.0.1:3001/v1/audit/flight-recorder",
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

  const governBody = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
  assert.equal(governBody.tenant_id, "tenant-a");
  assert.equal(governBody.scope, "scope-a");
  assert.equal(governBody.query_text, "Govern external memories before prompt use.");
  assert.equal(Array.isArray(governBody.candidates), true);

  const flightRecorderBody = JSON.parse(String(calls[8]?.init.body)) as Record<string, unknown>;
  assert.equal(flightRecorderBody.tenant_id, "tenant-a");
  assert.equal(flightRecorderBody.scope, "scope-a");
  assert.equal(flightRecorderBody.run_id, "run-flight");

  const feedbackBody = JSON.parse(String(calls[4]?.init.body)) as Record<string, unknown>;
  assert.equal(feedbackBody.operation, undefined);
  assert.equal(feedbackBody.target, undefined);
  assert.equal(feedbackBody.guide_trace_id, "guide-trace-feedback");
  assert.deepEqual(feedbackBody.used_memory_ids, ["mem-used"]);

  const rehydrateBody = JSON.parse(String(calls[5]?.init.body)) as Record<string, unknown>;
  assert.equal(rehydrateBody.operation, undefined);
  assert.equal(rehydrateBody.anchor_uri, "aionis://anchor/payload-1");
  assert.equal(rehydrateBody.mode, "partial");

  const snapshotBody = JSON.parse(String(calls[7]?.init.body)) as Record<string, unknown>;
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

test("SDK guide and role helpers preserve protected guide identity without upgrading legacy calls", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({
      contract_version: "aionis_guide_result_v1",
      tenant_id: "tenant-sdk",
      scope: "scope-sdk",
      operation_id: body.operation_id ?? null,
      guide_trace_id: `guide-${calls.length}`,
      agent_context: {
        contract_version: "aionis_agent_context_v1",
        prompt_text: "AIONIS_CTX v2\ncurrent: note=protected SDK guide",
        memory_ids: [],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-sdk",
    scope: "scope-sdk",
    fetchImpl: fakeFetch,
  });

  await client.guide({
    query_text: "Direct protected guide.",
    operation_id: "sdk-guide-direct-operation",
    host_task_envelope_v1: GUIDE_HOST_TASK_ENVELOPE,
  });
  await client.execution.guideForRole({
    run_id: "sdk-role-run",
    task_signature: GUIDE_HOST_TASK_ENVELOPE.task_signature,
    task_family: GUIDE_HOST_TASK_ENVELOPE.task_family,
    workflow_signature: "sdk-role-workflow",
    query_text: "Protected guide for a worker role.",
    agent_id: "worker-sdk",
    role: "worker",
    operation_id: "sdk-guide-role-operation",
    host_task_envelope_v1: GUIDE_HOST_TASK_ENVELOPE,
    guide: { operation_id: "sdk-guide-role-escape-must-not-override" },
  });
  await client.execution.guideAgentContextForRole({
    run_id: "sdk-role-context-run",
    task_signature: GUIDE_HOST_TASK_ENVELOPE.task_signature,
    task_family: GUIDE_HOST_TASK_ENVELOPE.task_family,
    workflow_signature: "sdk-role-context-workflow",
    query_text: "Protected agent context for a verifier role.",
    agent_id: "verifier-sdk",
    role: "verifier",
    operation_id: "sdk-guide-role-context-operation",
    host_task_envelope_v1: GUIDE_HOST_TASK_ENVELOPE,
  }, undefined, {
    prompt_format: "runtime_compact",
  });
  await client.execution.guideForRole({
    run_id: "sdk-role-escape-run",
    task_signature: "sdk-role-escape-signature",
    task_family: "sdk-guide",
    query_text: "Preserve the existing guide escape hatch.",
    agent_id: "worker-sdk",
    role: "worker",
    guide: {
      operation_id: "sdk-guide-role-escape-operation",
      host_task_envelope_v1: GUIDE_HOST_TASK_ENVELOPE,
    },
  });
  await client.guide({ query_text: "Legacy unprotected guide." });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/guide",
  ]);
  assert.equal(calls[0]?.body.operation_id, "sdk-guide-direct-operation");
  assert.deepEqual(calls[0]?.body.host_task_envelope_v1, GUIDE_HOST_TASK_ENVELOPE);
  assert.equal(calls[1]?.body.operation_id, "sdk-guide-role-operation");
  assert.deepEqual(calls[1]?.body.host_task_envelope_v1, GUIDE_HOST_TASK_ENVELOPE);
  assert.equal(calls[2]?.body.operation_id, "sdk-guide-role-context-operation");
  assert.deepEqual(calls[2]?.body.host_task_envelope_v1, GUIDE_HOST_TASK_ENVELOPE);
  assert.equal(calls[3]?.body.operation_id, "sdk-guide-role-escape-operation");
  assert.deepEqual(calls[3]?.body.host_task_envelope_v1, GUIDE_HOST_TASK_ENVELOPE);
  assert.equal(Object.hasOwn(calls[4]?.body ?? {}, "operation_id"), false);
  assert.equal(Object.hasOwn(calls[4]?.body ?? {}, "host_task_envelope_v1"), false);
});

test("SDK strict host envelope and receipt contracts match Runtime canonical digests", () => {
  const envelope = buildHostTaskEnvelopeV1(GUIDE_HOST_TASK_ENVELOPE);
  assert.deepEqual(parseHostTaskEnvelopeV1(envelope), GUIDE_HOST_TASK_ENVELOPE);
  assert.equal(hostTaskEnvelopeDigest(envelope), coreHostTaskEnvelopeDigest(GUIDE_HOST_TASK_ENVELOPE));
  assert.throws(
    () => parseHostTaskEnvelopeV1({ ...envelope, assignment_arm: "candidate" }),
    /unexpected field assignment_arm/,
  );
  assert.throws(
    () => parseHostTaskEnvelopeV1({ ...envelope, created_at: "2026-07-14T00:00:00Z" }),
    /canonical UTC timestamp/,
  );

  const receipt = buildHostUseReceiptV1(sdkReceiptBody());
  assert.deepEqual(receipt.items.map((item) => item.memory_id), ["memory-a", "memory-b"]);
  const { receipt_sha256: receiptSha256, ...receiptBody } = receipt;
  assert.equal(receiptSha256, hostUseReceiptDigest(receiptBody));
  assert.equal(receiptSha256, coreHostUseReceiptDigest(receiptBody));
  assert.deepEqual(parseHostUseReceiptV1(receipt), receipt);
  assert.throws(
    () => parseHostUseReceiptV1({ ...receipt, receipt_sha256: "7".repeat(64) }),
    /digest does not match/,
  );
  assert.throws(
    () => parseHostUseReceiptV1({ ...receipt, raw_host_trace: "must-never-cross-the-contract" }),
    /unexpected field raw_host_trace/,
  );
  assert.throws(
    () => hostUseReceiptDigest({ ...receiptBody, items: [...receiptBody.items].reverse() }),
    /sorted by UTF-8 memory_id bytes/,
  );
  assert.doesNotThrow(() => buildHostUseReceiptV1(sdkReceiptBody([
    sdkReceiptItem("memory-a", { verifier_version: "界".repeat(40) }),
    sdkReceiptItem("memory-b", { verifier_version: "界".repeat(40) }),
  ])));
  assert.throws(
    () => buildHostUseReceiptV1(sdkReceiptBody([
      sdkReceiptItem("memory-a", { verifier_version: "界".repeat(41) }),
      sdkReceiptItem("memory-b", { verifier_version: "界".repeat(41) }),
    ])),
    /120 UTF-8 bytes/i,
  );
});

test("feedbackFromGuide binds protected homogeneous receipts to the exact served surface", () => {
  const guide = {
    contract_version: "aionis_guide_result_v1",
    tenant_id: "tenant-sdk",
    scope: "scope-sdk",
    guide_trace_id: "sdk-guide-receipt-1",
    feedback_attribution_v1: sdkGuideFeedbackAttribution({
      tenantId: "tenant-sdk",
      scope: "scope-sdk",
      guideTraceId: "sdk-guide-receipt-1",
      items: [
        { memory_id: "memory-a", served_surface: "inspect_before_use" },
        { memory_id: "memory-b", served_surface: "inspect_before_use" },
        { memory_id: "memory-control", served_surface: "use_now" },
      ],
    }),
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      memory_ids: ["memory-a", "memory-b", "memory-control"],
      use_now_memory_ids: ["memory-control"],
      inspect_before_use_memory_ids: ["memory-a", "memory-b"],
      do_not_use_memory_ids: [],
    },
  };
  const receipt = buildHostUseReceiptV1(sdkReceiptBody());
  const feedback = feedbackFromGuide({
    guide,
    operation_id: "sdk-feedback-operation-1",
    host_use_receipt_v1: receipt,
    reason: "The instrumented host inspected and used the served evidence.",
    run_id: "sdk-run-receipt-1",
    outcome: "positive",
    used_memory_ids: ["memory-b", "memory-a"],
  });

  assert.equal(feedback.operation_id, "sdk-feedback-operation-1");
  assert.equal(feedback.used_surface, "inspect_before_use");
  assert.equal(feedback.verifier_status, "passed");
  assert.deepEqual(feedback.used_memory_ids, ["memory-a", "memory-b"]);
  assert.deepEqual(feedback.host_use_receipt_v1, receipt);
  assert.deepEqual(
    parseGuideFeedbackAttributionV1(guide.feedback_attribution_v1),
    guide.feedback_attribution_v1,
  );
  assert.deepEqual(feedbackAttributionFromGuide(guide), guide.feedback_attribution_v1);

  assert.throws(
    () => feedbackFromGuide({
      guide,
      operation_id: "different-feedback-operation",
      host_use_receipt_v1: receipt,
      reason: "Wrong operation binding.",
      run_id: "sdk-run-receipt-1",
      outcome: "positive",
      used_memory_ids: ["memory-a", "memory-b"],
    }),
    /operation_id must match/,
  );
  assert.throws(
    () => feedbackFromGuide({
      guide,
      operation_id: "sdk-feedback-operation-1",
      host_use_receipt_v1: receipt,
      reason: "Wrong exact served surface.",
      run_id: "sdk-run-receipt-1",
      outcome: "positive",
      used_surface: "use_now",
      used_memory_ids: ["memory-a", "memory-b"],
    }),
    /used_surface must match/,
  );
  assert.equal(feedbackFromGuide({
    guide: {
      ...guide,
      agent_context: {
        ...guide.agent_context,
        use_now_memory_ids: ["memory-b", "memory-control"],
        inspect_before_use_memory_ids: ["memory-a"],
      },
    },
    operation_id: "sdk-feedback-operation-1",
    host_use_receipt_v1: receipt,
    reason: "Persisted attribution remains authoritative over agent-context drift.",
    run_id: "sdk-run-receipt-1",
    outcome: "positive",
    used_memory_ids: ["memory-a", "memory-b"],
  }).used_surface, "inspect_before_use");
  assert.throws(
    () => feedbackFromGuide({
      guide: {
        ...guide,
        feedback_attribution_v1: sdkGuideFeedbackAttribution({
          tenantId: "tenant-sdk",
          scope: "scope-sdk",
          guideTraceId: "sdk-guide-receipt-1",
          items: [
            { memory_id: "memory-a", served_surface: "use_now" },
            { memory_id: "memory-b", served_surface: "use_now" },
            { memory_id: "memory-control", served_surface: "use_now" },
          ],
        }),
      },
      operation_id: "sdk-feedback-operation-1",
      host_use_receipt_v1: receipt,
      reason: "The receipt surface must match the guide's served surface.",
      run_id: "sdk-run-receipt-1",
      outcome: "positive",
      used_memory_ids: ["memory-a", "memory-b"],
    }),
    /guide_feedback_served_surface_mismatch/,
  );
  const heterogeneousReceipt = buildHostUseReceiptV1(sdkReceiptBody([
    sdkReceiptItem("memory-a"),
    sdkReceiptItem("memory-b", { outcome: "negative" }),
  ]));
  assert.throws(
    () => feedbackFromGuide({
      guide,
      operation_id: "sdk-feedback-operation-1",
      host_use_receipt_v1: heterogeneousReceipt,
      reason: "Mixed evidence cannot become one feedback operation.",
      run_id: "sdk-run-receipt-1",
      outcome: "positive",
      used_memory_ids: ["memory-a", "memory-b"],
    }),
    /homogeneous receipt outcome and used_surface/,
  );
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

test("SDK plan asset profile maps plans into execution memory observe events", () => {
  const events = planAssetObserveEvents({
    run_id: "run-plan-profile",
    task_signature: "checkout-migration",
    task_family: "coding",
    workflow_signature: "planner-worker",
    planner: {
      agent_id: "planner-1",
      team_id: "team-a",
      model: "strong-planner",
    },
    plan: {
      plan_id: "plan:checkout-migration",
      title: "Checkout migration plan",
      summary: "Continue the scoped adapter route and keep the old route reference-only.",
      artifact_ref: "plan.md",
      decisions: [
        {
          decision_id: "decision:scoped-adapter",
          statement: "Patch packages/api/src/checkout.ts as the active target.",
          target_files: ["packages/api/src/checkout.ts"],
        },
      ],
      acceptance_checks: [
        "verifier accepts scoped checkout route",
        "legacy broad route remains reference-only",
      ],
      execution_boundaries: [
        "do not revive src/legacy/checkout.ts as primary route",
      ],
      failed_branches: [
        {
          branch_id: "failed:legacy-route",
          statement: "Legacy broad route failed verifier checks.",
          reason: "It touched unrelated checkout modules.",
          target_files: ["src/legacy/checkout.ts"],
        },
      ],
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.agent_id, "planner-1");
  assert.equal(events[0]?.team_id, "team-a");
  assert.equal(events[0]?.outcome, "succeeded");
  assert.equal(events[0]?.continuation_hint?.includes("adjudicated execution memory"), true);
  assert.deepEqual(events[0]?.target_files, ["packages/api/src/checkout.ts"]);
  assert.equal((events[0]?.slots?.plan_asset_v1 as Record<string, unknown>)?.plan_id, "plan:checkout-migration");
  assert.equal((events[0]?.slots?.plan_asset_v1 as Record<string, unknown>)?.rejected_branch_count, 1);

  assert.equal(events[1]?.outcome, "failed");
  assert.equal(events[1]?.continuation_hint, "Do not continue this rejected plan branch as the primary route.");
  assert.deepEqual(events[1]?.target_files, ["src/legacy/checkout.ts"]);
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
    tenant_id: "tenant-product-loop",
    scope: "scope-product-loop",
    guide_trace_id: "guide-product-loop",
    feedback_attribution_v1: sdkGuideFeedbackAttribution({
      tenantId: "tenant-product-loop",
      scope: "scope-product-loop",
      guideTraceId: "guide-product-loop",
      items: [
        { memory_id: "mem-1", served_surface: "use_now" },
        { memory_id: "mem-2", served_surface: "inspect_before_use" },
        { memory_id: "mem-3", served_surface: "do_not_use" },
        { memory_id: "mem-4", served_surface: "rehydrate" },
      ],
    }),
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
        evidence_sources: [
          {
            target: "src/reference.ts",
            source_memory_id: "mem-6",
            source: "inspect_first",
            evidence_use: "reference_only",
            direction_policy: "must_not_be_primary_route",
          },
        ],
        blocked_routes: [
          {
            target: "src/stale.ts",
            source_memory_id: "mem-5",
            source: "must_not",
            direction_policy: "blocked_route",
            evidence_use: "counter_evidence_only",
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
  assert.deepEqual(evidenceSourcesFromGuide(guide).map((entry) => entry.target), ["src/reference.ts"]);
  assert.deepEqual(blockedRoutesFromGuide(guide).map((entry) => entry.target), ["src/stale.ts"]);
  assert.equal(evidenceSourcesFromGuide(guide)[0]?.direction_policy, "must_not_be_primary_route");
  assert.equal(blockedRoutesFromGuide(guide)[0]?.evidence_use, "counter_evidence_only");
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
  assertGuideFeedbackError(
    "guide_feedback_unknown_memory",
    () => feedbackFromGuide({
      guide,
      reason: "Bad attribution.",
      run_id: "run-product-loop",
      outcome: "positive",
      used_memory_ids: ["mem-not-shown"],
    }),
  );
});

test("SDK guide feedback helpers fail closed on every non-exact attribution path", () => {
  const tenantId = "tenant-sdk-strict";
  const scope = "scope-sdk-strict";
  const guideTraceId = "guide-sdk-strict";
  const attribution = sdkGuideFeedbackAttribution({
    tenantId,
    scope,
    guideTraceId,
    items: [
      { memory_id: "mem-inspect", served_surface: "inspect_before_use" },
      { memory_id: "mem-rehydrate", served_surface: "rehydrate" },
      { memory_id: "mem-use", served_surface: "use_now" },
    ],
  });
  const guide = {
    tenant_id: tenantId,
    scope,
    guide_trace_id: guideTraceId,
    feedback_attribution_v1: attribution,
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      memory_ids: ["mem-context-only", "mem-inspect", "mem-use"],
      use_now_memory_ids: ["mem-context-only", "mem-use"],
      inspect_before_use_memory_ids: ["mem-inspect"],
      do_not_use_memory_ids: [],
      rehydrate_hints: [{ memory_id: "mem-rehydrate", reason: "Needs expansion." }],
    },
  };
  const feedback = (overrides: Record<string, unknown> = {}) => feedbackFromGuide({
    guide,
    reason: "Strict attribution test.",
    run_id: "run-sdk-strict",
    outcome: "positive",
    used_memory_ids: ["mem-use"],
    ...overrides,
  } as any);

  assert.equal(feedback().used_surface, "use_now");
  assertGuideFeedbackError(
    "guide_feedback_attribution_missing",
    () => feedback({ guide: { ...guide, feedback_attribution_v1: undefined } }),
  );
  assertGuideFeedbackError(
    "guide_feedback_attribution_unavailable",
    () => feedback({
      guide: {
        ...guide,
        feedback_attribution_v1: {
          contract_version: "aionis_guide_feedback_attribution_v1",
          status: "unavailable",
          guide_trace_id: guideTraceId,
          reason_code: "learning_exposure_not_persisted",
        },
      },
    }),
  );
  assertGuideFeedbackError(
    "guide_feedback_context_only_memory",
    () => feedback({ used_memory_ids: ["mem-context-only"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_unknown_memory",
    () => feedback({ used_memory_ids: ["mem-never-served"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_unknown_memory",
    () => feedback({
      guide: { ...guide, agent_context: undefined },
      used_memory_ids: ["mem-never-served"],
    }),
  );
  assertGuideFeedbackError(
    "guide_feedback_unknown_memory",
    () => feedback({ used_memory_ids: ["mem-context-only", "mem-never-served"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_duplicate_memory",
    () => feedback({ used_memory_ids: ["mem-use", "mem-use"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_mixed_served_surfaces",
    () => feedback({ used_memory_ids: ["mem-use", "mem-inspect"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_rehydrate_not_feedbackable",
    () => feedback({ used_memory_ids: ["mem-rehydrate"] }),
  );
  assertGuideFeedbackError(
    "guide_feedback_explicit_assertion_not_exact",
    () => feedback({ used_surface: "explicit_host_assertion" }),
  );
  assertGuideFeedbackError(
    "guide_feedback_served_surface_mismatch",
    () => feedback({ used_surface: "inspect_before_use" }),
  );
  assertGuideFeedbackError(
    "guide_feedback_host_receipt_required",
    () => feedback({ used_memory_ids: ["mem-inspect"] }),
  );
  assert.equal(feedback({
    outcome: "neutral",
    used_memory_ids: ["mem-inspect"],
  }).used_surface, "inspect_before_use");
  assertGuideFeedbackError(
    "guide_feedback_attribution_invalid",
    () => feedback({
      guide: {
        ...guide,
        feedback_attribution_v1: {
          ...attribution,
          served_surface_sha256: "f".repeat(64),
        },
      },
    }),
  );
  assertGuideFeedbackError(
    "guide_feedback_attribution_invalid",
    () => feedback({
      guide: {
        ...guide,
        feedback_attribution_v1: {
          ...attribution,
          projection_complete: false,
          projection_incomplete_reason_codes: Array.from(
            { length: 33 },
            (_, index) => `reason-${String(index).padStart(2, "0")}`,
          ),
        },
      },
    }),
  );

  const incompleteAttribution = {
    ...sdkGuideFeedbackAttribution({
      tenantId,
      scope,
      guideTraceId,
      items: [{ memory_id: "mem-use", served_surface: "use_now" }],
    }),
    projection_complete: false,
    projection_incomplete_reason_codes: ["recorded_surface_item_omitted"],
  };
  assert.equal(feedback({
    guide: { ...guide, feedback_attribution_v1: incompleteAttribution },
  }).used_surface, "use_now");

  const emptyIncompleteAttribution = {
    ...sdkGuideFeedbackAttribution({ tenantId, scope, guideTraceId, items: [] }),
    projection_complete: false,
    projection_incomplete_reason_codes: ["recorded_surface_item_omitted"],
  };
  assertGuideFeedbackError(
    "guide_feedback_context_only_memory",
    () => feedback({
      guide: { ...guide, feedback_attribution_v1: emptyIncompleteAttribution },
      used_memory_ids: ["mem-context-only"],
    }),
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
