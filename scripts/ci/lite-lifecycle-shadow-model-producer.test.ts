import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAionisAgentContext,
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";
import {
  buildLifecycleShadowCandidatePromptPayload,
  createHttpLifecycleShadowCandidateProducer,
  validateLifecycleShadowCandidateSignals,
} from "../../src/memory/lifecycle-shadow-model-producer.ts";
import {
  LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
} from "../../src/memory/learning-control-model-client-http-contract.ts";
import type { LifecycleCandidateEntry } from "../../src/memory/lifecycle-candidate-inference.ts";

const entries: LifecycleCandidateEntry[] = [
  {
    memory_id: "mem-current",
    title: "Checkout current note",
    summary: "The branch spent time in src/checkout/adapter.ts and later the thread continued from this adapter path.",
    memory_type: "procedure",
    domain: "execution",
    lifecycle_state: "active",
    authority: "candidate",
    target_files: ["src/checkout/adapter.ts"],
    execution_state: {
      execution_kind: "execution_workflow",
      transition_kind: "resume_current_state",
    },
  },
  {
    memory_id: "mem-old",
    title: "Checkout old route",
    summary: "The legacy branch around src/checkout/legacy.ts was explored, but the team later went a different direction.",
    memory_type: "procedure",
    domain: "execution",
    lifecycle_state: "active",
    authority: "candidate",
    target_files: ["src/checkout/legacy.ts"],
    execution_state: {
      execution_kind: "execution_workflow",
      transition_kind: "inspect_before_use",
    },
  },
];

test("LLM shadow lifecycle validator accepts only grounded candidate signals", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries,
    query_intent: "continue checkout work from the current adapter path",
    response: {
      candidates: [
        {
          memory_id: "mem-old",
          signal_type: "negative",
          confidence: 0.74,
          evidence_span: {
            source_field: "text_summary",
            quote: "the team later went a different direction",
          },
          reason: "The candidate describes a prior route that did not remain current.",
        },
        {
          memory_id: "missing-id",
          signal_type: "current",
          confidence: 0.91,
          evidence_span: {
            source_field: "query",
            quote: "current adapter path",
          },
          reason: "Unknown ids are not accepted.",
        },
        {
          memory_id: "mem-current",
          signal_type: "current",
          confidence: 0.9,
          evidence_span: {
            source_field: "text_summary",
            quote: "this phrase does not exist in the memory",
          },
          reason: "Ungrounded quotes are not accepted.",
        },
      ],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.producer, "llm_shadow_v1");
  assert.equal(signals[0]?.memory_id, "mem-old");
  assert.equal(signals[0]?.signal_type, "negative");
});

test("LLM shadow lifecycle prompt payload exposes evidence fields without admission actions", () => {
  const payload = buildLifecycleShadowCandidatePromptPayload({
    entries,
    query_intent: "continue checkout work from the current adapter path",
  });
  assert.equal(payload.operation, "memory_lifecycle_shadow_candidate");
  assert.equal(payload.entries.length, 2);
  assert.equal(Object.hasOwn(payload.entries[0] ?? {}, "slots_text"), true);
  const payloadText = JSON.stringify(payload);
  assert.equal(payloadText.includes("use_now"), false);
  assert.equal(payloadText.includes("do_not_use"), false);
});

test("HTTP LLM shadow lifecycle producer validates strict grounded JSON candidates", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /audit-only lifecycle candidate signals/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [{
              memory_id: "mem-old",
              signal_type: "negative",
              confidence: 0.81,
              evidence_span: {
                source_field: "text_summary",
                quote: "went a different direction",
              },
              reason: "The memory says this route was not the selected continuation.",
            }],
          }),
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const producer = createHttpLifecycleShadowCandidateProducer({
    config: {
      transport: LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5000,
      maxTokens: 800,
      temperature: 0,
    },
    fetchImpl,
  });
  const signals = await producer({
    entries,
    query_intent: "continue checkout work from the current adapter path",
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.producer, "llm_shadow_v1");
  assert.equal(signals[0]?.signal_type, "negative");
});

test("LLM shadow lifecycle candidates stay trace-only and do not mutate agent context", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue checkout work from the current adapter path",
    },
    nodes: [
      {
        id: "mem-old",
        type: "procedure",
        title: "Checkout route note",
        text_summary: "A separate exploration note around src/checkout/legacy.ts says the team discussed a different direction during review.",
        slots: {
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout",
            workflow_signature: "checkout",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
    ],
    ranked: [{ id: "mem-old", score: 0.99 }],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const beforeUseNowIds = [...agentContext.use_now_memory_ids];
  const beforeInspectIds = [...agentContext.inspect_before_use_memory_ids];
  const shadowSignals = validateLifecycleShadowCandidateSignals({
    entries: memoryPacket.relevant_memories,
    query_intent: memoryPacket.query.intent,
    response: {
      candidates: [{
        memory_id: "mem-old",
        signal_type: "negative",
        confidence: 0.78,
        evidence_span: {
          source_field: "text_summary",
          quote: "discussed a different direction",
        },
        reason: "This is a model-produced shadow candidate and must not gate direct use.",
      }],
    },
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
    lifecycle_candidate_shadow_signals: shadowSignals,
  });
  assert.equal(trace.lifecycle_candidate_summary.present, true);
  assert.equal(trace.lifecycle_candidate_summary.authority_mutation, false);
  assert.equal(trace.lifecycle_candidate_summary.agent_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.signal_payload_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.gated_count, 0);
  assert.ok(trace.lifecycle_candidate_summary.shadow_only_memory_ids.includes("mem-old"));
  assert.ok(trace.lifecycle_candidate_summary.signals.some((signal) => signal.producer === "llm_shadow_v1"));
  assert.deepEqual(agentContext.use_now_memory_ids, beforeUseNowIds);
  assert.deepEqual(agentContext.inspect_before_use_memory_ids, beforeInspectIds);
});
