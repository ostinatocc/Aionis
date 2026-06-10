import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAionisAgentContext,
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";
import { inferLifecycleCandidateSignals } from "../../src/memory/lifecycle-candidate-inference.ts";

test("rule lifecycle candidate producer ignores ordinary fact and preference memories", () => {
  const signals = inferLifecycleCandidateSignals({
    entries: [
      {
        memory_id: "fact-failed-word",
        title: "Deployment fact",
        summary: "The deployment failed once in staging, but this is only a factual incident note.",
        memory_type: "fact",
        domain: "general",
        lifecycle_state: "active",
        authority: "advisory",
      },
      {
        memory_id: "preference-raw-word",
        title: "Status preference",
        summary: "The user prefers raw details in status updates.",
        memory_type: "preference",
        domain: "general",
        lifecycle_state: "active",
        authority: "advisory",
      },
    ],
  });
  assert.deepEqual(signals, []);
});

test("lifecycle candidates move unlabelled failed execution branches out of direct use without hurting procedures", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue the checkout migration from current executable state",
    },
    nodes: [
      {
        id: "mem-current",
        type: "procedure",
        title: "Checkout current continuation",
        text_summary: "Current valid state: checkout migration is the accepted continuation. Resume from src/checkout/adapter.ts.",
        confidence: 0.82,
        salience: 0.9,
      },
      {
        id: "mem-failed",
        type: "procedure",
        title: "Checkout non-current branch",
        text_summary: "Evaluation note: broad retry through src/checkout/legacy.ts is treated as a non-current branch. Check before direct use.",
        confidence: 0.84,
        salience: 0.86,
      },
      {
        id: "mem-procedure",
        type: "procedure",
        title: "Checkout reusable procedure",
        text_summary: "Reusable procedure: inspect src/checkout/adapter.ts; keep changes scoped; run or review tests near checkout.",
        confidence: 0.84,
        salience: 0.88,
      },
    ],
    ranked: [
      { id: "mem-current", score: 0.99 },
      { id: "mem-failed", score: 0.98 },
      { id: "mem-procedure", score: 0.97 },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.ok(agentContext.use_now_memory_ids.includes("mem-current"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-procedure"));
  assert.equal(agentContext.use_now_memory_ids.includes("mem-failed"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-failed"));
  assert.ok(agentContext.risk.reasons.includes("lifecycle_candidate_kept_out_of_use_now"));

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  assert.equal(trace.lifecycle_candidate_summary.present, true);
  assert.equal(trace.lifecycle_candidate_summary.agent_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.signal_payload_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, true);
  assert.ok(trace.lifecycle_candidate_summary.gated_memory_ids.includes("mem-failed"));
  const failedDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-failed");
  assert.equal(failedDecision?.agent_surface, "inspect_before_use");
  assert.ok(failedDecision?.reason_codes.includes("lifecycle_candidate_direct_use_gated"));
});

test("lifecycle candidates admit scrubbed current and procedure candidates while isolating failed branches", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue from the accepted commit state",
    },
    nodes: [
      {
        id: "mem-current-scrubbed",
        type: "procedure",
        title: "Current commit state for checkout migration",
        text_summary: "Current valid state: checkout migration is the accepted continuation. Resume from src/checkout/adapter.ts. Check before direct use restart from older or non-current branch assumptions.",
        slots: {
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.88,
      },
      {
        id: "mem-failed-scrubbed",
        type: "procedure",
        title: "Check broad branch around src/checkout/legacy.ts",
        text_summary: "Evaluation note: broad continuation around src/checkout/legacy.ts is treated as a non-current branch. Check before direct use.",
        slots: {
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.86,
      },
      {
        id: "mem-procedure-scrubbed",
        type: "procedure",
        title: "Reusable procedure from checkout migration",
        text_summary: "Reusable procedure: inspect src/checkout/adapter.ts; keep changes scoped to the changed file family; run or review tests near src/checkout/adapter.ts; preserve failed/older branches as counter-evidence.",
        slots: {
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.88,
      },
    ],
    ranked: [
      { id: "mem-current-scrubbed", score: 0.98 },
      { id: "mem-failed-scrubbed", score: 0.97 },
      { id: "mem-procedure-scrubbed", score: 0.96 },
    ],
  });
  assert.equal(memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-current-scrubbed")?.authority, "candidate");
  assert.equal(memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-procedure-scrubbed")?.authority, "candidate");

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.ok(agentContext.use_now_memory_ids.includes("mem-current-scrubbed"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-procedure-scrubbed"));
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-current-scrubbed"), false);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-procedure-scrubbed"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-failed-scrubbed"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-failed-scrubbed"));
  assert.ok(agentContext.risk.reasons.includes("lifecycle_candidate_current_or_procedure_admitted"));

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const currentDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-current-scrubbed");
  const failedDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-failed-scrubbed");
  assert.equal(trace.lifecycle_candidate_summary.signal_payload_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, true);
  assert.equal(currentDecision?.agent_surface, "use_now");
  assert.ok(currentDecision?.reason_codes.includes("lifecycle_candidate_direct_use_admitted"));
  assert.equal(failedDecision?.agent_surface, "inspect_before_use");
  assert.ok(failedDecision?.reason_codes.includes("lifecycle_candidate_direct_use_gated"));
});

test("rehydrate lifecycle candidates stay shadow-only unless the memory is eligible", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue from the summary without requesting payload expansion",
    },
    nodes: [
      {
        id: "mem-raw-summary",
        type: "procedure",
        title: "Checkout source evidence pointer",
        text_summary: "Source evidence pointer references exact raw diff and file-level evidence for src/checkout/adapter.ts.",
        confidence: 0.83,
        salience: 0.82,
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.deepEqual(agentContext.rehydrate_hints, []);

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  assert.equal(trace.lifecycle_candidate_summary.present, true);
  assert.equal(trace.lifecycle_candidate_summary.signal_payload_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, false);
  assert.deepEqual(trace.lifecycle_candidate_summary.gated_memory_ids, []);
  assert.ok(trace.lifecycle_candidate_summary.shadow_only_memory_ids.includes("mem-raw-summary"));
});
