import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAionisAgentContext,
  buildAionisMemoryDecisionTrace,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";
import {
  inferLifecycleCandidateSignals,
  lifecycleCandidateDirectUseUnsafe,
} from "../../src/memory/lifecycle-candidate-inference.ts";

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

test("rule lifecycle candidate producer treats retired routes and accepted-evidence conflicts as unsafe", () => {
  const signals = inferLifecycleCandidateSignals({
    entries: [
      {
        memory_id: "mem-current",
        title: "Latest accepted execution state",
        summary: "Latest accepted state: pick up at packages/runtime/current.ts. Keep out of the immediate action plan restart from superseded or retired route assumptions.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["packages/runtime/current.ts"],
      },
      {
        memory_id: "mem-procedure",
        title: "Reusable runtime procedure",
        summary: "Reusable procedure: inspect packages/runtime/current.ts and verify nearby tests before continuing.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["packages/runtime/current.ts"],
      },
      {
        memory_id: "mem-retired",
        title: "Check broad branch around packages/runtime/old.ts",
        summary: "Evaluation note: a broad continuation around packages/runtime/old.ts is treated as a retired route for this handoff. Keep it out of direct next-action context.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["packages/runtime/old.ts"],
      },
      {
        memory_id: "mem-contested",
        title: "disagreeing continuation around packages/runtime/old.ts",
        summary: "A prior memory says continue through packages/runtime/old.ts, but accepted commit evidence points to packages/runtime/current.ts. Audit before adopting and prefer the accepted state unless raw evidence says otherwise.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["packages/runtime/old.ts"],
      },
    ],
  });

  const signalsFor = (memoryId: string) => signals.filter((signal) => signal.memory_id === memoryId);
  assert.ok(signalsFor("mem-retired").some((signal) =>
    signal.signal_type === "negative" && lifecycleCandidateDirectUseUnsafe(signal)
  ));
  assert.ok(signalsFor("mem-contested").some((signal) =>
    signal.signal_type === "contested" && lifecycleCandidateDirectUseUnsafe(signal)
  ));
  assert.equal(signalsFor("mem-current").some(lifecycleCandidateDirectUseUnsafe), false);
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

  const contractContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
    context_compaction_profile: "aggressive",
  });
  assert.equal(
    contractContext.prompt_aliases.find((entry) => entry.memory_id === "mem-current-scrubbed")?.surface,
    "current",
  );
  assert.equal(
    contractContext.prompt_aliases.find((entry) => entry.memory_id === "mem-procedure-scrubbed")?.surface,
    "procedure",
  );
});

test("lifecycle candidates keep retired and contradicted execution routes inspect-first", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Continue from the accepted execution state and avoid obsolete broad branches.",
    },
    nodes: [
      {
        id: "mem-current-route",
        type: "procedure",
        title: "Latest accepted runtime state",
        text_summary: "Latest accepted state: the approved handoff point is packages/runtime/current.ts. Keep out of the immediate action plan restart from superseded or retired route assumptions.",
        slots: {
          target_files: ["packages/runtime/current.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "runtime-continuation",
            workflow_signature: "runtime-continuation",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
      {
        id: "mem-procedure-route",
        type: "procedure",
        title: "Reusable runtime procedure",
        text_summary: "Reusable procedure: inspect packages/runtime/current.ts; keep changes scoped to the current target; run or review tests near packages/runtime/current.ts.",
        slots: {
          target_files: ["packages/runtime/current.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "runtime-continuation",
            workflow_signature: "runtime-continuation",
          },
        },
        confidence: 0.72,
        salience: 0.88,
      },
      {
        id: "mem-retired-route",
        type: "procedure",
        title: "Check broad branch around packages/runtime/old.ts",
        text_summary: "Evaluation note: a broad continuation around packages/runtime/old.ts is treated as a retired route for this handoff. Keep it out of direct next-action context.",
        slots: {
          target_files: ["packages/runtime/old.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "runtime-continuation",
            workflow_signature: "runtime-retired-route",
          },
        },
        confidence: 0.72,
        salience: 0.87,
      },
      {
        id: "mem-contested-route",
        type: "procedure",
        title: "disagreeing continuation around packages/runtime/old.ts",
        text_summary: "A prior memory says continue through packages/runtime/old.ts, but accepted commit evidence points to packages/runtime/current.ts. Audit before adopting and prefer the accepted state unless raw evidence says otherwise.",
        slots: {
          target_files: ["packages/runtime/old.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "runtime-continuation",
            workflow_signature: "runtime-contested-route",
          },
        },
        confidence: 0.72,
        salience: 0.86,
      },
    ],
    ranked: [
      { id: "mem-current-route", score: 0.99 },
      { id: "mem-procedure-route", score: 0.98 },
      { id: "mem-retired-route", score: 0.97 },
      { id: "mem-contested-route", score: 0.96 },
    ],
  });

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.ok(agentContext.use_now_memory_ids.includes("mem-current-route"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-procedure-route"));
  assert.equal(agentContext.use_now_memory_ids.includes("mem-retired-route"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-contested-route"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-retired-route"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-contested-route"));
  assert.ok(agentContext.risk.reasons.includes("lifecycle_candidate_kept_out_of_use_now"));
  assert.equal(agentContext.prompt_text.includes("use_now:"), true);
  assert.equal(agentContext.prompt_text.includes("inspect_before_use:"), true);

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const currentDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-current-route");
  const retiredDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-retired-route");
  const contestedDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-contested-route");
  assert.equal(currentDecision?.agent_surface, "use_now");
  assert.equal(retiredDecision?.agent_surface, "inspect_before_use");
  assert.equal(contestedDecision?.agent_surface, "inspect_before_use");
  assert.ok(retiredDecision?.reason_codes.includes("lifecycle_candidate_direct_use_gated"));
  assert.ok(contestedDecision?.reason_codes.includes("lifecycle_candidate_direct_use_gated"));
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

test("rehydrate lifecycle candidates surface explicit raw evidence requests without direct use", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "The next agent needs exact raw diff evidence before acting. Request the rehydrate pointer for src/checkout/adapter.ts; do not rely only on summary context.",
    },
    nodes: [
      {
        id: "mem-current",
        type: "procedure",
        title: "Current execution state",
        text_summary: "Latest accepted state: continue at src/checkout/adapter.ts and verify tests/checkout/adapter.test.ts.",
        slots: {
          target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
      {
        id: "mem-procedure",
        type: "procedure",
        title: "Reusable execution procedure",
        text_summary: "Procedure: inspect src/checkout/adapter.ts; keep changes scoped; run or review tests/checkout/adapter.test.ts.",
        slots: {
          target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
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
        id: "mem-trace",
        type: "procedure",
        title: "Raw execution trace pointer",
        text_summary: "Open this pointer when the next agent needs exact patch details, review trace, or per-file proof for src/checkout/adapter.ts.",
        slots: {
          target_files: [
            "trace://checkout-migration/raw",
            "src/checkout/adapter.ts",
            "tests/checkout/adapter.test.ts",
          ],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.86,
      },
    ],
    ranked: [
      { id: "mem-current", score: 0.99 },
      { id: "mem-procedure", score: 0.98 },
      { id: "mem-trace", score: 0.97 },
    ],
  });

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(agentContext.recommended_posture, "inspect_before_use");
  assert.ok(agentContext.rehydrate_hints.some((hint) => hint.memory_id === "mem-trace" && hint.required));
  assert.equal(agentContext.use_now_memory_ids.includes("mem-trace"), false);
  assert.ok(agentContext.use_now_memory_ids.includes("mem-current"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-procedure"));
  assert.ok(agentContext.risk.reasons.includes("rehydration_required_before_use"));
  assert.match(agentContext.prompt_text, /rehydrate_if_needed/);

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const traceDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-trace");
  assert.equal(traceDecision?.agent_surface, "rehydrate");
  assert.equal(traceDecision?.decision_kind, "rehydrate");
  assert.ok(traceDecision?.reason_codes.includes("lifecycle_candidate_rehydrate"));
  assert.ok(traceDecision?.reason_codes.includes("requires_differential_rehydration"));
  assert.ok(trace.lifecycle_candidate_summary.gated_memory_ids.includes("mem-trace"));
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, true);
});

test("rehydrate lifecycle candidates do not promote ordinary or stale raw references", () => {
  const ordinaryMemoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Need exact raw diff evidence before acting.",
    },
    nodes: [
      {
        id: "fact-raw",
        type: "entity",
        title: "Raw style preference",
        text_summary: "The user sometimes asks for raw logs in status updates.",
        confidence: 0.83,
        salience: 0.82,
      },
    ],
  });
  const ordinaryContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: ordinaryMemoryPacket,
  });
  assert.deepEqual(ordinaryContext.rehydrate_hints, []);

  const staleMemoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Need exact raw diff evidence before acting.",
    },
    nodes: [
      {
        id: "mem-stale-trace",
        type: "procedure",
        title: "Outdated raw execution trace pointer",
        text_summary: "Outdated pointer to raw trace for src/checkout/legacy.ts; inspect before reuse.",
        slots: {
          target_files: ["src/checkout/legacy.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-legacy",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
    ],
  });
  const staleContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: staleMemoryPacket,
  });
  assert.deepEqual(staleContext.rehydrate_hints, []);
  assert.equal(staleContext.use_now_memory_ids.includes("mem-stale-trace"), false);
  assert.ok(staleContext.inspect_before_use_memory_ids.includes("mem-stale-trace"));
});

test("lifecycle candidates use target-file relations without benchmark wording cues", () => {
  const directSignals = inferLifecycleCandidateSignals({
    entries: [
      {
        memory_id: "mem-cluster-a",
        title: "Note A",
        summary: "The small change surface was prepared and checked.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
      },
      {
        memory_id: "mem-cluster-b",
        title: "Note B",
        summary: "The same change surface has a short apply-and-verify sequence.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
      },
      {
        memory_id: "mem-subset",
        title: "Note C",
        summary: "A narrower alternate edit touched only the verification surface.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["tests/checkout/adapter.test.ts"],
      },
      {
        memory_id: "mem-subset-b",
        title: "Note D",
        summary: "Another alternate note also touched only the verification surface.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["tests/checkout/adapter.test.ts"],
      },
      {
        memory_id: "mem-disjoint",
        title: "Note E",
        summary: "A broader alternate edit touched another file family.",
        memory_type: "procedure",
        domain: "execution",
        lifecycle_state: "active",
        authority: "candidate",
        target_files: ["src/checkout/legacy.ts"],
      },
    ],
  });
  assert.ok(directSignals.some((signal) =>
    signal.memory_id === "mem-cluster-a"
    && signal.signal_type === "current"
    && signal.evidence_span.source_field === "slots"
  ));
  assert.ok(directSignals.some((signal) =>
    signal.memory_id === "mem-disjoint"
    && signal.signal_type === "contested"
    && signal.evidence_span.source_field === "slots"
  ));
  assert.ok(directSignals.some((signal) =>
    signal.memory_id === "mem-subset"
    && signal.signal_type === "contested"
    && signal.evidence_span.source_field === "slots"
  ));
  assert.ok(directSignals.some((signal) =>
    signal.memory_id === "mem-subset-b"
    && signal.signal_type === "contested"
    && signal.evidence_span.source_field === "slots"
  ));

  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue the repo task",
    },
    nodes: [
      {
        id: "mem-cluster-a",
        type: "procedure",
        title: "Note A",
        text_summary: "The small change surface was prepared and checked.",
        slots: {
          target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.89,
      },
      {
        id: "mem-cluster-b",
        type: "procedure",
        title: "Note B",
        text_summary: "The same change surface has a short apply-and-verify sequence.",
        slots: {
          target_files: ["src/checkout/adapter.ts", "tests/checkout/adapter.test.ts"],
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
        id: "mem-subset",
        type: "procedure",
        title: "Note C",
        text_summary: "A narrower alternate edit touched only the verification surface.",
        slots: {
          target_files: ["tests/checkout/adapter.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.875,
      },
      {
        id: "mem-subset-b",
        type: "procedure",
        title: "Note D",
        text_summary: "Another alternate note also touched only the verification surface.",
        slots: {
          target_files: ["tests/checkout/adapter.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.872,
      },
      {
        id: "mem-disjoint",
        type: "procedure",
        title: "Note E",
        text_summary: "A broader alternate edit touched another file family.",
        slots: {
          target_files: ["src/checkout/legacy.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "checkout-migration",
            workflow_signature: "checkout-migration",
          },
        },
        confidence: 0.72,
        salience: 0.87,
      },
    ],
    ranked: [
      { id: "mem-cluster-a", score: 0.98 },
      { id: "mem-cluster-b", score: 0.97 },
      { id: "mem-subset", score: 0.965 },
      { id: "mem-subset-b", score: 0.962 },
      { id: "mem-disjoint", score: 0.96 },
    ],
  });
  assert.equal(memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-cluster-a")?.authority, "candidate");
  assert.equal(memoryPacket.relevant_memories.find((entry) => entry.memory_id === "mem-disjoint")?.authority, "candidate");

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  assert.ok(agentContext.use_now_memory_ids.includes("mem-cluster-a"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-cluster-b"));
  assert.equal(agentContext.use_now_memory_ids.includes("mem-subset"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-subset-b"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-disjoint"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-subset"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-subset-b"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-disjoint"));

  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-a",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });
  const clusterDecision = trace.memory_decisions.find((entry) => entry.memory_id === "mem-cluster-a");
  assert.ok(clusterDecision?.reason_codes.includes("lifecycle_candidate_direct_use_admitted"));
  assert.ok(trace.lifecycle_candidate_summary.gated_memory_ids.includes("mem-subset"));
  assert.ok(trace.lifecycle_candidate_summary.gated_memory_ids.includes("mem-subset-b"));
  assert.ok(trace.lifecycle_candidate_summary.gated_memory_ids.includes("mem-disjoint"));
});

test("lifecycle candidates preserve parallel active target clusters", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue both active workstreams",
    },
    nodes: [
      {
        id: "mem-api-a",
        type: "procedure",
        title: "API surface note A",
        text_summary: "Active state for the API surface is ready to continue.",
        slots: {
          target_files: ["src/api/router.ts", "tests/api/router.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "parallel-workstreams",
            workflow_signature: "api-workstream",
          },
        },
        confidence: 0.72,
        salience: 0.92,
      },
      {
        id: "mem-api-b",
        type: "procedure",
        title: "API surface note B",
        text_summary: "The API surface has a scoped apply and verify sequence.",
        slots: {
          target_files: ["src/api/router.ts", "tests/api/router.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "parallel-workstreams",
            workflow_signature: "api-workstream",
          },
        },
        confidence: 0.72,
        salience: 0.91,
      },
      {
        id: "mem-api-c",
        type: "procedure",
        title: "API surface note C",
        text_summary: "A third API note confirms the same target surface.",
        slots: {
          target_files: ["src/api/router.ts", "tests/api/router.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "parallel-workstreams",
            workflow_signature: "api-workstream",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
      {
        id: "mem-worker-a",
        type: "procedure",
        title: "Worker surface note A",
        text_summary: "Active state for the worker surface is ready to continue.",
        slots: {
          target_files: ["src/worker/queue.ts", "tests/worker/queue.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "parallel-workstreams",
            workflow_signature: "worker-workstream",
          },
        },
        confidence: 0.72,
        salience: 0.89,
      },
      {
        id: "mem-worker-b",
        type: "procedure",
        title: "Worker surface note B",
        text_summary: "The worker surface has a scoped apply and verify sequence.",
        slots: {
          target_files: ["src/worker/queue.ts", "tests/worker/queue.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "parallel-workstreams",
            workflow_signature: "worker-workstream",
          },
        },
        confidence: 0.72,
        salience: 0.88,
      },
    ],
    ranked: [
      { id: "mem-api-a", score: 0.99 },
      { id: "mem-api-b", score: 0.98 },
      { id: "mem-api-c", score: 0.97 },
      { id: "mem-worker-a", score: 0.96 },
      { id: "mem-worker-b", score: 0.95 },
    ],
  });

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.ok(agentContext.use_now_memory_ids.includes("mem-api-a"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-worker-a"));
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-worker-a"), false);
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-worker-b"), false);
});

test("lifecycle candidates keep unsupported alternate target clusters inspect-first when an affirmative cluster exists", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "Continue from the accepted worker state and do not restart from the alternate route.",
    },
    nodes: [
      {
        id: "mem-current-a",
        type: "procedure",
        title: "Current worker state",
        text_summary: "Latest accepted state: continue at src/worker/current.ts and verify tests/worker/current.test.ts.",
        slots: {
          target_files: ["src/worker/current.ts", "tests/worker/current.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "target-cluster-selection",
            workflow_signature: "current-worker",
          },
        },
        confidence: 0.72,
        salience: 0.92,
      },
      {
        id: "mem-procedure-a",
        type: "procedure",
        title: "Reusable worker procedure",
        text_summary: "Procedure: inspect src/worker/current.ts; keep changes scoped; run or review tests/worker/current.test.ts.",
        slots: {
          target_files: ["src/worker/current.ts", "tests/worker/current.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "target-cluster-selection",
            workflow_signature: "current-worker",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
      {
        id: "mem-alt-a",
        type: "procedure",
        title: "Check alternate route",
        text_summary: "A broad continuation around src/worker/legacy.ts was recorded for comparison.",
        slots: {
          target_files: ["src/worker/legacy.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "target-cluster-selection",
            workflow_signature: "alternate-worker",
          },
        },
        confidence: 0.72,
        salience: 0.89,
      },
      {
        id: "mem-alt-b",
        type: "procedure",
        title: "Alternate route note",
        text_summary: "Another broad note around src/worker/legacy.ts was recorded for comparison.",
        slots: {
          target_files: ["src/worker/legacy.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "target-cluster-selection",
            workflow_signature: "alternate-worker",
          },
        },
        confidence: 0.72,
        salience: 0.88,
      },
    ],
    ranked: [
      { id: "mem-current-a", score: 0.99 },
      { id: "mem-procedure-a", score: 0.98 },
      { id: "mem-alt-a", score: 0.97 },
      { id: "mem-alt-b", score: 0.96 },
    ],
  });

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.ok(agentContext.use_now_memory_ids.includes("mem-current-a"));
  assert.ok(agentContext.use_now_memory_ids.includes("mem-procedure-a"));
  assert.equal(agentContext.use_now_memory_ids.includes("mem-alt-a"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-alt-b"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-alt-a"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-alt-b"));
});

test("lifecycle candidates do not admit same target-set negative or stale clusters", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue from safe execution state",
    },
    nodes: [
      {
        id: "mem-negative-a",
        type: "procedure",
        title: "Rejected worker route",
        text_summary: "Rejected route for src/worker/queue.ts and tests/worker/queue.test.ts; inspect before reuse.",
        slots: {
          target_files: ["src/worker/queue.ts", "tests/worker/queue.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "negative-cluster",
            workflow_signature: "worker-negative",
          },
        },
        confidence: 0.72,
        salience: 0.9,
      },
      {
        id: "mem-negative-b",
        type: "procedure",
        title: "Outdated worker route",
        text_summary: "Outdated route for src/worker/queue.ts and tests/worker/queue.test.ts; inspect before reuse.",
        slots: {
          target_files: ["src/worker/queue.ts", "tests/worker/queue.test.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "negative-cluster",
            workflow_signature: "worker-negative",
          },
        },
        confidence: 0.72,
        salience: 0.89,
      },
    ],
    ranked: [
      { id: "mem-negative-a", score: 0.99 },
      { id: "mem-negative-b", score: 0.98 },
    ],
  });

  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });

  assert.equal(agentContext.use_now_memory_ids.includes("mem-negative-a"), false);
  assert.equal(agentContext.use_now_memory_ids.includes("mem-negative-b"), false);
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-negative-a"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-negative-b"));
});
