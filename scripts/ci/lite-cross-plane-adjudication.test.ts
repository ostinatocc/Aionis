import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAionisAgentContext,
  buildAionisMemoryPacket,
} from "../../src/memory/product-output-assembler.ts";
import type {
  AionisAgentContext,
  AionisMemoryPacket,
} from "../../src/memory/product-output-contract.ts";

type ProductNode = Parameters<typeof buildAionisMemoryPacket>[0]["nodes"][number];

function buildContext(nodes: ProductNode[]): {
  memoryPacket: AionisMemoryPacket;
  agentContext: AionisAgentContext;
} {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-cross-plane",
    query: {
      source: "text",
      intent: "continue governed runtime task with execution memory",
    },
    nodes,
    source_map: {
      routes_used: ["/v1/memory/recall_text"],
      internal_surfaces_used: ["recall", "memory_lifecycle_adjudicator", "agent_context_compiler"],
    },
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-cross-plane",
    memory_packet: memoryPacket,
  });
  return { memoryPacket, agentContext };
}

function memoryById(packet: AionisMemoryPacket, memoryId: string): AionisMemoryPacket["relevant_memories"][number] {
  const entry = packet.relevant_memories.find((memory) => memory.memory_id === memoryId);
  assert.ok(entry, `expected memory ${memoryId}`);
  return entry;
}

function postureById(context: AionisAgentContext, memoryId: string): AionisAgentContext["command_posture"][number] {
  const entry = context.command_posture.find((row) => row.memory_id === memoryId);
  assert.ok(entry, `expected command posture for ${memoryId}`);
  return entry;
}

test("cross-plane adjudication keeps conservative planes above direct-use signals", () => {
  const { memoryPacket, agentContext } = buildContext([
    {
      id: "mem-hot-contested",
      type: "concept",
      title: "Hot but contested memory",
      text_summary: "HOT_CONTESTED_MARKER current project route for src/hot.ts",
      tier: "hot",
      confidence: 0.95,
      salience: 0.95,
      slots: {
        lifecycle_state: "contested",
        target_files: ["src/hot.ts"],
        compression_layer: "L2",
      },
    },
    {
      id: "mem-stable-inspect",
      type: "procedure",
      title: "Stable procedure awaiting learning-control inspection",
      text_summary: "Reusable procedure: STABLE_INSPECT_MARKER for src/stable.ts",
      tier: "hot",
      confidence: 0.95,
      salience: 0.95,
      slots: {
        lifecycle_state: "active",
        feedback_learning_control_posture: "inspect_before_use",
        contract_trust: "authoritative",
        execution_native_v1: {
          execution_kind: "procedure",
          summary_kind: "procedure",
          contract_trust: "authoritative",
          target_files: ["src/stable.ts"],
          next_action: "reuse stable procedure",
        },
      },
    },
    {
      id: "mem-current-rehydrate",
      type: "procedure",
      title: "Current active path requires raw trace",
      text_summary: "CURRENT_REHYDRATE_MARKER current active path for src/raw.ts",
      tier: "hot",
      confidence: 0.96,
      salience: 0.96,
      raw_ref: "raw-trace:mem-current-rehydrate",
      slots: {
        lifecycle_state: "rehydration_candidate",
        contract_trust: "authoritative",
        rehydration_default_mode: "full",
        execution_native_v1: {
          execution_kind: "current_active_path",
          summary_kind: "current_state",
          contract_trust: "authoritative",
          target_files: ["src/raw.ts"],
          next_action: "continue current active path after raw trace",
        },
      },
    },
    {
      id: "mem-retired-trusted-pattern",
      type: "procedure",
      title: "Retired trusted pattern",
      text_summary: "RETIRED_TRUSTED_PATTERN_MARKER reusable procedure for src/old-policy.ts",
      tier: "hot",
      confidence: 0.98,
      salience: 0.98,
      slots: {
        policy_memory_state: "retired",
        contract_trust: "authoritative",
        execution_native_v1: {
          execution_kind: "procedure",
          summary_kind: "procedure",
          pattern_state: "stable",
          credibility_state: "trusted",
          contract_trust: "authoritative",
          target_files: ["src/old-policy.ts"],
          next_action: "reuse retired trusted pattern",
        },
      },
    },
    {
      id: "mem-positive-countered",
      type: "concept",
      title: "Positive memory with repeated counter signals",
      text_summary: "POSITIVE_COUNTERED_MARKER useful project context for src/countered.ts",
      tier: "hot",
      confidence: 0.94,
      salience: 0.94,
      slots: {
        lifecycle_state: "active",
        feedback_positive: 4,
        weak_counter_signal_count: 2,
        target_files: ["src/countered.ts"],
        compression_layer: "L2",
      },
    },
    {
      id: "mem-explicit-archived",
      type: "concept",
      title: "Explicit archived memory",
      text_summary: "EXPLICIT_ARCHIVED_MARKER old context for src/archive.ts",
      tier: "hot",
      confidence: 0.99,
      salience: 0.99,
      slots: {
        lifecycle_state: "archived",
        contract_trust: "authoritative",
        target_files: ["src/archive.ts"],
        compression_layer: "L2",
      },
    },
  ]);

  assert.equal(memoryById(memoryPacket, "mem-hot-contested").lifecycle_state, "contested");
  assert.equal(memoryById(memoryPacket, "mem-stable-inspect").lifecycle_state, "candidate");
  assert.equal(memoryById(memoryPacket, "mem-current-rehydrate").lifecycle_state, "rehydration_candidate");
  assert.equal(memoryById(memoryPacket, "mem-retired-trusted-pattern").lifecycle_state, "archived");
  assert.equal(memoryById(memoryPacket, "mem-positive-countered").lifecycle_state, "contested");
  assert.equal(memoryById(memoryPacket, "mem-explicit-archived").lifecycle_state, "archived");

  for (const memoryId of [
    "mem-hot-contested",
    "mem-stable-inspect",
    "mem-current-rehydrate",
    "mem-retired-trusted-pattern",
    "mem-positive-countered",
    "mem-explicit-archived",
  ]) {
    assert.equal(agentContext.use_now_memory_ids.includes(memoryId), false, `${memoryId} must not enter use_now`);
  }

  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-hot-contested"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-stable-inspect"));
  assert.ok(agentContext.inspect_before_use_memory_ids.includes("mem-positive-countered"));

  assert.ok(agentContext.do_not_use_memory_ids.includes("mem-retired-trusted-pattern"));
  assert.ok(agentContext.do_not_use_memory_ids.includes("mem-explicit-archived"));

  assert.ok(agentContext.rehydrate_hints.some((hint) => hint.memory_id === "mem-current-rehydrate"));
  assert.equal(agentContext.inspect_before_use_memory_ids.includes("mem-current-rehydrate"), false);
  assert.equal(agentContext.do_not_use_memory_ids.includes("mem-current-rehydrate"), false);

  assert.equal(postureById(agentContext, "mem-hot-contested").posture, "inspect_first");
  assert.equal(postureById(agentContext, "mem-stable-inspect").posture, "inspect_first");
  assert.equal(postureById(agentContext, "mem-current-rehydrate").posture, "rehydrate_first");
  assert.equal(postureById(agentContext, "mem-retired-trusted-pattern").posture, "must_not");
  assert.equal(postureById(agentContext, "mem-positive-countered").posture, "inspect_first");
  assert.equal(postureById(agentContext, "mem-explicit-archived").posture, "must_not");

  assert.ok(agentContext.risk.reasons.includes("candidate_or_contested_memory_kept_out_of_use_now"));
  assert.ok(agentContext.risk.reasons.includes("blocked_or_suppressed_memory_kept_out_of_use_now"));
});
