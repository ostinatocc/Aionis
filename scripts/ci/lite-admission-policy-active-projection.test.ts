import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAionisAdmissionCandidatePolicyActiveProjection,
} from "../../src/memory/product-output/operator-projections.js";
import {
  buildAionisAgentContext,
} from "../../src/memory/agent-context-compiler.js";
import { buildAionisMemoryPacket } from "../../src/memory/product-output/memory-packet.js";

test("admission candidate active projection only downgrades current use-now entries", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "continue admission candidate policy route",
    },
    nodes: [
      {
        id: "mem-project-supported",
        type: "topic",
        title: "Supported project context",
        text_summary: "Current project context is supported by prior positive feedback.",
        tier: "warm",
        confidence: 0.91,
        salience: 0.91,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-procedure-candidate",
        type: "procedure",
        title: "Procedure candidate",
        text_summary: "Procedure candidate should be inspected before direct prompt use by this policy.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-execution-current",
        type: "topic",
        title: "Accepted execution continuation",
        text_summary: "Verifier accepted this execution branch as the active continuation state.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
        slots: {
          execution_kind: "handoff",
        },
      },
      {
        id: "mem-execution-contradicted",
        type: "topic",
        title: "Contradicted execution continuation",
        text_summary: "Execution continuation with later negative feedback should be inspected.",
        tier: "warm",
        confidence: 0.88,
        salience: 0.88,
        created_at: "2026-06-01T00:00:00.000Z",
        slots: {
          execution_kind: "handoff",
        },
      },
      {
        id: "mem-project-contradicted",
        type: "topic",
        title: "Contradicted project context",
        text_summary: "Project context with repeated negative posture should not remain direct-use.",
        tier: "warm",
        confidence: 0.89,
        salience: 0.89,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const agentContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
    slot_by_memory_id: new Map([
      ["mem-project-supported", { positive_attributed_use_count: 2 }],
      ["mem-project-contradicted", { strong_counter_signal_count: 2 }],
      ["mem-execution-contradicted", { strong_counter_signal_count: 2 }],
    ]),
  });

  assert.equal(projection.runtime_mutation, false);
  assert.equal(projection.authority_mutation, false);
  assert.equal(projection.hard_boundary_upgrade_count, 0);
  assert.deepEqual(projection.downgraded_memory_ids, [
    "mem-procedure-candidate",
    "mem-execution-contradicted",
    "mem-project-contradicted",
  ]);
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-project-supported")?.shadow_action,
    "use_now",
  );
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-execution-current")?.shadow_action,
    "use_now",
  );
  assert.equal(
    projection.shadow_policy_report.decisions.find((entry) => entry.memory_id === "mem-project-contradicted")
      ?.closed_loop_effect_state,
    "contradicted",
  );
});

test("admission candidate active projection preserves non-use-now hard boundaries", () => {
  const memoryPacket = buildAionisMemoryPacket({
    tenant_id: "tenant-local",
    scope: "repo-a",
    query: {
      source: "text",
      intent: "preserve active projection hard boundaries",
    },
    nodes: [
      {
        id: "mem-use-now",
        type: "topic",
        title: "Use now memory",
        text_summary: "Direct project context remains direct-use.",
        tier: "warm",
        confidence: 0.91,
        salience: 0.91,
        created_at: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "mem-already-inspect",
        type: "procedure",
        title: "Already inspect memory",
        text_summary: "This memory is already on the inspect-before-use surface.",
        tier: "warm",
        confidence: 0.9,
        salience: 0.9,
        created_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
  const baseContext = buildAionisAgentContext({
    tenant_id: "tenant-local",
    scope: "repo-a",
    memory_packet: memoryPacket,
  });
  const agentContext = {
    ...baseContext,
    use_now_memory_ids: ["mem-use-now"],
    inspect_before_use_memory_ids: ["mem-already-inspect"],
  };
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: agentContext,
    memory_packet: memoryPacket,
  });

  assert.equal(projection.hard_boundary_upgrade_count, 0);
  assert.deepEqual(projection.downgraded_memory_ids, []);
  assert.deepEqual(
    projection.shadow_policy_report.decisions.map((entry) => [
      entry.memory_id,
      entry.recorded_action,
      entry.shadow_action,
    ]),
    [
      ["mem-use-now", "use_now", "use_now"],
      ["mem-already-inspect", "inspect_before_use", "inspect_before_use"],
    ],
  );
});
