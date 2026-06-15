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
  lifecycleCandidateRuntimeOwnedProducer,
  type LifecycleCandidateEntry,
} from "../../src/memory/lifecycle-candidate-inference.ts";

function executionEntry(input: {
  memory_id: string;
  title?: string;
  summary: string;
  target_files?: string[];
}): LifecycleCandidateEntry {
  return {
    memory_id: input.memory_id,
    title: input.title ?? `Runtime note ${input.memory_id}`,
    summary: input.summary,
    memory_type: "procedure",
    domain: "execution",
    lifecycle_state: "active",
    authority: "trusted",
    target_files: input.target_files ?? ["src/runtime/path-a.ts"],
  };
}

test("semantic shadow holdout captures indirect lifecycle surfaces without granting runtime authority", () => {
  const signals = inferLifecycleCandidateSignals({
    entries: [
      executionEntry({
        memory_id: "negative-paraphrase",
        summary: "The thread eventually ended up taking another path around src/api/new-path.ts; keep src/api/path-a.ts as context for what happened.",
        target_files: ["src/api/path-a.ts"],
      }),
      executionEntry({
        memory_id: "negative-cross-lingual",
        title: "执行记录 src/api/path-b.ts",
        summary: "这条路线后来没走通，最后还是回到 src/api/new-path.ts 继续；该记录只作为背景参考。",
        target_files: ["src/api/path-b.ts"],
      }),
      executionEntry({
        memory_id: "current-paraphrase",
        summary: "The handoff settles around src/auth/session.ts for the next round.",
        target_files: ["src/auth/session.ts"],
      }),
      executionEntry({
        memory_id: "procedure-paraphrase",
        summary: "The part to reuse is inspect src/auth/session.ts, verify nearby tests, and keep the edit scoped.",
        target_files: ["src/auth/session.ts"],
      }),
      executionEntry({
        memory_id: "rehydrate-paraphrase",
        summary: "Open the complete evidence record if the summary is not enough for src/auth/session.ts.",
        target_files: ["trace://auth-session/full", "src/auth/session.ts"],
      }),
    ],
  });

  const shadowSignals = signals.filter((signal) => signal.producer === "semantic_shadow_v1");
  const signalTypesFor = (memoryId: string) =>
    shadowSignals.filter((signal) => signal.memory_id === memoryId).map((signal) => signal.signal_type);

  assert.ok(signalTypesFor("negative-paraphrase").includes("negative"));
  assert.ok(signalTypesFor("negative-cross-lingual").includes("negative"));
  assert.ok(signalTypesFor("current-paraphrase").includes("current"));
  assert.ok(signalTypesFor("procedure-paraphrase").includes("procedure"));
  assert.ok(signalTypesFor("rehydrate-paraphrase").includes("rehydrate"));
  assert.equal(shadowSignals.some(lifecycleCandidateDirectUseUnsafe), false);
  assert.equal(shadowSignals.some(lifecycleCandidateRuntimeOwnedProducer), false);
});

test("semantic shadow holdout does not trigger on ordinary memory lanes", () => {
  const signals = inferLifecycleCandidateSignals({
    entries: [
      {
        memory_id: "fact-with-route-language",
        title: "Project note",
        summary: "The work eventually ended up taking another path, but this is a plain factual note about a meeting.",
        memory_type: "fact",
        domain: "general",
        lifecycle_state: "active",
        authority: "advisory",
      },
      {
        memory_id: "preference-with-raw-language",
        title: "User wording preference",
        summary: "The user prefers complete evidence records in status updates.",
        memory_type: "preference",
        domain: "general",
        lifecycle_state: "active",
        authority: "advisory",
      },
      {
        memory_id: "project-context-with-cn-language",
        title: "项目背景",
        summary: "团队讨论过这条路线后来没走通这句话的翻译方式，但这不是执行记忆。",
        memory_type: "project_context",
        domain: "general",
        lifecycle_state: "active",
        authority: "advisory",
      },
    ],
  });

  assert.deepEqual(signals, []);
});

test("semantic shadow holdout remains audit-only in compiled agent context", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-shadow-holdout",
    query: {
      source: "text",
      intent: "continue the auth session work",
    },
    nodes: [
      {
        id: "shadow-current",
        type: "procedure",
        title: "Auth session note",
        text_summary: "The handoff settles around src/auth/session.ts for the next round.",
        slots: {
          target_files: ["src/auth/session.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "auth-session",
            workflow_signature: "auth-session-shadow-current",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.9,
      },
      {
        id: "shadow-negative",
        type: "procedure",
        title: "Auth session alternate note",
        text_summary: "The thread eventually ended up taking another path around src/auth/session.ts; keep src/auth/branch-a.ts as context for what happened.",
        slots: {
          target_files: ["src/auth/branch-a.ts"],
          execution_native_v1: {
            execution_kind: "execution_workflow",
            task_signature: "auth-session",
            workflow_signature: "auth-session-shadow-negative",
            contract_trust: "authoritative",
          },
        },
        confidence: 0.9,
        salience: 0.88,
      },
    ],
    ranked: [
      { id: "shadow-current", score: 0.99 },
      { id: "shadow-negative", score: 0.98 },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-shadow-holdout",
    memory_packet: memoryPacket,
  });
  const trace = buildAionisMemoryDecisionTrace({
    tenant_id: "tenant-local",
    scope: "repo-shadow-holdout",
    before_guide: null,
    after_guide: {
      memory_packet: memoryPacket,
      agent_context: agentContext,
    },
  });

  const shadowSignals = trace.lifecycle_candidate_summary.signals.filter((signal) =>
    signal.producer === "semantic_shadow_v1"
  );
  assert.ok(shadowSignals.length >= 2);
  assert.equal(trace.lifecycle_candidate_summary.authority_mutation, false);
  assert.equal(trace.lifecycle_candidate_summary.agent_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.signal_payload_prompt_included, false);
  assert.equal(trace.lifecycle_candidate_summary.surface_effect_prompt_included, false);
  assert.deepEqual(trace.lifecycle_candidate_summary.gated_memory_ids, []);
  assert.ok(trace.lifecycle_candidate_summary.shadow_only_memory_ids.includes("shadow-current"));
  assert.ok(trace.lifecycle_candidate_summary.shadow_only_memory_ids.includes("shadow-negative"));
  assert.equal(agentContext.risk.reasons.includes("lifecycle_candidate_kept_out_of_use_now"), false);
  assert.equal(agentContext.risk.reasons.includes("lifecycle_candidate_current_or_procedure_admitted"), false);
});
