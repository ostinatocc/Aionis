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
  LIFECYCLE_SHADOW_MODEL_FALLBACK_PROTOCOL_ATTEMPTS,
  LIFECYCLE_SHADOW_MODEL_MIN_OUTPUT_TOKENS,
  LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS,
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

test("LLM shadow lifecycle validator rejects generic source-only rehydrate candidates", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-source",
        title: "GitHub source note",
        summary: "Real GitHub source from remix-run/react-router commit 18b5e998c9d3.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["packages/router/history.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "resume_current_state",
        },
      },
    ],
    query_intent: "continue the current router work",
    response: {
      candidates: [{
        memory_id: "mem-source",
        signal_type: "rehydrate",
        confidence: 0.82,
        evidence_span: {
          source_field: "text_summary",
          quote: "Real GitHub source from remix-run/react-router commit 18b5e998c9d3",
        },
        reason: "The memory mentions source material.",
      }],
    },
  });
  assert.deepEqual(signals, []);
});

test("LLM shadow lifecycle validator accepts query-requested rehydrate for raw pointers", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-trace",
        title: "Raw execution trace pointer",
        summary: "Trace pointer for src/checkout/adapter.ts with raw execution evidence.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["trace://checkout-migration/raw", "src/checkout/adapter.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "inspect_before_use",
        },
      },
    ],
    query_intent: "Need exact raw diff evidence before acting; open the pointer if available.",
    response: {
      candidates: [{
        memory_id: "mem-trace",
        signal_type: "rehydrate",
        confidence: 0.84,
        evidence_span: {
          source_field: "text_summary",
          quote: "raw execution evidence",
        },
        reason: "The current query requests exact raw evidence and this memory can serve it.",
      }],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "rehydrate");
  assert.equal(signals[0]?.producer, "llm_shadow_v1");
});

test("LLM shadow lifecycle validator accepts explicit evidence pointer handoff queries", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-trace",
        title: "Pointer for exact evidence",
        summary: "This entry is a pointer to the exact supporting material for src/http/server.ts. Use it when a summary is not enough and the raw commit evidence must be opened.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["github://example/repo/commit/abc123", "src/http/server.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "inspect_before_use",
        },
      },
    ],
    query_intent: "Continue this repository handoff around src/http/server.ts. The history includes branch notes and evidence pointers; choose the live continuation.",
    response: {
      candidates: [{
        memory_id: "mem-trace",
        signal_type: "rehydrate",
        confidence: 0.84,
        evidence_span: {
          source_field: "text_summary",
          quote: "pointer to the exact supporting material",
        },
        reason: "The query explicitly mentions evidence pointers and this memory is the exact evidence pointer.",
      }],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "rehydrate");
});

test("LLM shadow lifecycle validator does not turn ordinary source into rehydrate on pointer queries", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-source",
        title: "Repository source note",
        summary: "Real GitHub source from example/repo commit abc123. Changed files include src/http/server.ts. Source URL: https://github.com/example/repo/commit/abc123.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["src/http/server.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "resume_current_state",
        },
      },
    ],
    query_intent: "Continue this repository handoff around src/http/server.ts. The history includes branch notes and evidence pointers; choose the live continuation.",
    response: {
      candidates: [{
        memory_id: "mem-source",
        signal_type: "rehydrate",
        confidence: 0.84,
        evidence_span: {
          source_field: "text_summary",
          quote: "Real GitHub source",
        },
        reason: "The query mentions evidence pointers, but this is only an ordinary source note.",
      }],
    },
  });
  assert.deepEqual(signals, []);
});

test("LLM shadow lifecycle validator does not treat generic open requests as rehydrate", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-trace",
        title: "Raw execution trace pointer",
        summary: "Trace pointer for src/checkout/adapter.ts with raw execution evidence.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["trace://checkout-migration/raw", "src/checkout/adapter.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "inspect_before_use",
        },
      },
    ],
    query_intent: "Open the current checkout issue and continue the implementation plan.",
    response: {
      candidates: [{
        memory_id: "mem-trace",
        signal_type: "rehydrate",
        confidence: 0.84,
        evidence_span: {
          source_field: "text_summary",
          quote: "raw execution evidence",
        },
        reason: "The query says open, but not open raw evidence.",
      }],
    },
  });
  assert.deepEqual(signals, []);
});

test("LLM shadow lifecycle validator accepts explicit memory rehydrate requirements", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-raw",
        title: "Pointer for exact evidence",
        summary: "This entry is only a pointer to the exact supporting material. The raw commit evidence must be opened before direct use.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["trace://checkout-migration/raw", "src/checkout/adapter.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "inspect_before_use",
        },
      },
    ],
    query_intent: "continue checkout work from the current adapter path",
    response: {
      candidates: [{
        memory_id: "mem-raw",
        signal_type: "rehydrate",
        confidence: 0.86,
        evidence_span: {
          source_field: "text_summary",
          quote: "raw commit evidence must be opened",
        },
        reason: "The memory explicitly says raw evidence must be opened.",
      }],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "rehydrate");
});

test("LLM shadow lifecycle validator rejects conditional rehydrate pointers without query demand", () => {
  const signals = validateLifecycleShadowCandidateSignals({
    entries: [
      {
        memory_id: "mem-conditional",
        title: "Raw commit trace pointer",
        summary: "Use it when a summary is not enough and the raw commit evidence must be opened.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["trace://checkout-migration/raw", "src/checkout/adapter.ts"],
        execution_state: {
          execution_kind: "execution_workflow",
          transition_kind: "inspect_before_use",
        },
      },
    ],
    query_intent: "continue checkout work from the current adapter path",
    response: {
      candidates: [{
        memory_id: "mem-conditional",
        signal_type: "rehydrate",
        confidence: 0.86,
        evidence_span: {
          source_field: "text_summary",
          quote: "raw commit evidence must be opened",
        },
        reason: "The memory is a conditional pointer, but the query does not request raw evidence.",
      }],
    },
  });
  assert.deepEqual(signals, []);
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
  assert.match(payload.response_contract.rehydrate_guard, /ordinary source\/supporting memories/);
  assert.equal(payload.derived_hints.query_requests_rehydrate, false);
});

test("LLM shadow lifecycle prompt payload marks explicit rehydrate query demand", () => {
  const payload = buildLifecycleShadowCandidatePromptPayload({
    entries,
    query_intent: "Need exact raw diff evidence before acting; open the pointer if available.",
  });
  assert.equal(payload.derived_hints.query_requests_rehydrate, true);
});

test("LLM shadow lifecycle prompt payload marks explicit evidence pointer query demand", () => {
  const payload = buildLifecycleShadowCandidatePromptPayload({
    entries,
    query_intent: "Continue the handoff. The history includes branch notes and evidence pointers.",
  });
  assert.equal(payload.derived_hints.query_requests_rehydrate, true);
  assert.match(payload.response_contract.rehydrate_guard, /evidence\/trace\/payload pointers/);
  assert.match(payload.response_contract.coverage_requirement, /every clearly grounded lifecycle candidate/);
});

test("HTTP LLM shadow lifecycle producer validates strict grounded JSON candidates", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.model, "test-model");
    assert.equal(body.max_tokens, LIFECYCLE_SHADOW_MODEL_MIN_OUTPUT_TOKENS);
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

test("HTTP LLM shadow lifecycle producer retries unparseable protocol responses only", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: "",
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [{
              memory_id: "mem-current",
              signal_type: "current",
              confidence: 0.81,
              evidence_span: {
                source_field: "text_summary",
                quote: "continued from this adapter path",
              },
              reason: "The retry produced a parseable grounded candidate.",
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
  assert.equal(callCount, 2);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "current");
});

test("HTTP LLM shadow lifecycle producer retries nonempty invalid candidate responses", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              candidates: [{
                memory_id: "mem-current",
                signal_type: "current",
                confidence: "high",
                evidence_span: {
                  source_field: "text_summary",
                  quote: "continued from this adapter path",
                },
                reason: "The candidate is semantically plausible but violates the numeric confidence contract.",
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [{
              memory_id: "mem-current",
              signal_type: "current",
              confidence: 0.81,
              evidence_span: {
                source_field: "text_summary",
                quote: "continued from this adapter path",
              },
              reason: "The retry produced a parseable grounded candidate.",
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
  assert.equal(callCount, 2);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "current");
});

test("HTTP LLM shadow lifecycle producer does not retry explicit empty candidate responses", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ candidates: [] }),
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
  assert.equal(callCount, 1);
  assert.deepEqual(signals, []);
});

test("HTTP LLM shadow lifecycle producer can recover through compact fallback prompt", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (callCount <= LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS) {
      assert.match(body.messages[0].content, /audit-only lifecycle candidate signals/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              candidates: [{
                memory_id: "mem-current",
                signal_type: "current",
                confidence: "high",
                evidence_span: {
                  source_field: "text_summary",
                  quote: "continued from this adapter path",
                },
                reason: "Primary prompt response violates the numeric confidence contract.",
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.match(body.messages[0].content, /^JSON only/);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [{
              memory_id: "mem-current",
              signal_type: "current",
              confidence: 0.82,
              evidence_span: {
                source_field: "text_summary",
                quote: "continued from this adapter path",
              },
              reason: "Fallback prompt produced a valid grounded candidate.",
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
  assert.equal(
    callCount,
    LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS
      + LIFECYCLE_SHADOW_MODEL_FALLBACK_PROTOCOL_ATTEMPTS,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.signal_type, "current");
});

test("HTTP LLM shadow lifecycle producer retries missing rehydrate coverage when opportunity is explicit", async () => {
  const rehydrateEntries: LifecycleCandidateEntry[] = [
    entries[0]!,
    {
      memory_id: "mem-trace",
      title: "Pointer for exact evidence",
      summary: "This entry is a pointer to the exact supporting material for src/checkout/adapter.ts. Use it when a summary is not enough and the raw commit evidence must be opened.",
      memory_type: "procedure",
      domain: "execution",
      lifecycle_state: "active",
      authority: "candidate",
      target_files: ["github://example/repo/commit/abc123", "src/checkout/adapter.ts"],
      execution_state: {
        execution_kind: "execution_workflow",
        transition_kind: "inspect_before_use",
      },
    },
  ];
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              candidates: [{
                memory_id: "mem-current",
                signal_type: "current",
                confidence: 0.82,
                evidence_span: {
                  source_field: "text_summary",
                  quote: "continued from this adapter path",
                },
                reason: "The first response misses rehydrate coverage.",
              }],
            }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            candidates: [{
              memory_id: "mem-trace",
              signal_type: "rehydrate",
              confidence: 0.84,
              evidence_span: {
                source_field: "text_summary",
                quote: "pointer to the exact supporting material",
              },
              reason: "The retry covers the explicit evidence pointer opportunity.",
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
    entries: rehydrateEntries,
    query_intent: "Continue this repository handoff. The history includes branch notes and evidence pointers.",
  });
  assert.equal(callCount, 2);
  assert.equal(signals.length, 2);
  assert.ok(signals.some((signal) =>
    signal.memory_id === "mem-current" && signal.signal_type === "current"
  ));
  assert.ok(signals.some((signal) =>
    signal.memory_id === "mem-trace" && signal.signal_type === "rehydrate"
  ));
});

test("HTTP LLM shadow lifecycle producer bounds repeated protocol failures", async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "",
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
  assert.equal(
    callCount,
    LIFECYCLE_SHADOW_MODEL_PROTOCOL_ATTEMPTS
      + LIFECYCLE_SHADOW_MODEL_FALLBACK_PROTOCOL_ATTEMPTS,
  );
  assert.deepEqual(signals, []);
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
