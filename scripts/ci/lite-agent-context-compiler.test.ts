import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileAionisAgentContext } from "../../src/memory/agent-context-compiler.js";
import { renderAionisAgentPrompt } from "../../src/memory/agent-context-renderer.js";
import { GovernanceDecisionV1Schema, type GovernanceDecisionV1 } from "../../src/memory/governance-contract.js";
import { AionisAgentContextSchema, type AionisAgentContext } from "../../src/memory/product-output-contract.js";

const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function decision(
  memoryId: string,
  surface: GovernanceDecisionV1["surface"],
  targetFiles: string[] = [],
): GovernanceDecisionV1 {
  return GovernanceDecisionV1Schema.parse({
    memory_id: memoryId,
    surface,
    authority: surface === "do_not_use" ? "blocked" : surface === "inspect_before_use" ? "candidate" : "trusted",
    lifecycle_state: surface === "rehydrate" ? "rehydration_candidate" : "active",
    actionable: surface === "use_now",
    reason_codes: [`test_${surface}`],
    target_files: targetFiles,
    requires_rehydrate: surface === "rehydrate",
  });
}

function baseContext(): AionisAgentContext {
  return AionisAgentContextSchema.parse({
    contract_version: "aionis_agent_context_v1",
    tenant_id: "tenant-compiler",
    scope: "scope-compiler",
    agent_role: "agent",
    agent_context_mode: "standard",
    task_context_profile: "general",
    prompt_text: "pending",
    summary: "Recovered governed memory.",
    history_used: true,
    actionable_history_used: true,
    recommended_posture: "reuse_supported_history",
    authority: "trusted",
    target_files: ["src/current.ts"],
    use_now: ["Current active path: implement the accepted route"],
    inspect_before_use: ["Inspect memory before use: candidate branch"],
    do_not_use: ["Blocked memory: failed branch"],
    memory_ids: ["memory-use", "memory-inspect", "memory-block", "memory-rehydrate"],
    use_now_memory_ids: ["memory-use"],
    inspect_before_use_memory_ids: ["memory-inspect"],
    do_not_use_memory_ids: ["memory-block"],
    command_posture: [
      {
        posture: "should_continue",
        surface: "current",
        memory_id: "memory-use",
        instruction: "Continue the accepted route.",
        reason: "Accepted execution evidence.",
        target_files: ["src/current.ts"],
        workflow_steps: ["Apply the accepted change"],
        acceptance_checks: ["Run the focused verifier"],
        verification_summary: ["The prior route passed"],
        artifact_hints: ["src/current.ts"],
      },
      {
        posture: "inspect_first",
        surface: "inspect_before_use",
        memory_id: "memory-inspect",
        instruction: "Inspect only.",
        reason: "Candidate evidence.",
        target_files: ["src/candidate.ts"],
      },
      {
        posture: "must_not",
        surface: "do_not_use",
        memory_id: "memory-block",
        instruction: "Do not reuse.",
        reason: "Failed evidence.",
        target_files: ["src/failed.ts"],
      },
      {
        posture: "rehydrate_first",
        surface: "rehydrate",
        memory_id: "memory-rehydrate",
        instruction: "Recover raw evidence.",
        reason: "Summary is insufficient.",
        target_files: [],
      },
    ],
    route_contract: {
      active_targets: [{
        target: "src/current.ts",
        source_memory_id: "memory-use",
        source: "should_continue",
        reason: "Accepted route.",
        artifact_status: "may_be_absent",
        missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
      }],
      pending_artifacts: [],
      reference_only_targets: [],
      blocked_direction_targets: [],
      evidence_sources: [],
      blocked_routes: [],
      conflict_policy: "do_not_treat_missing_active_target_as_superseded",
      fallback_policy: "do_not_promote_reference_or_blocked_targets",
      action_policy: {
        missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"],
        terminal_inspect_allowed: false,
        reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
        executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
        after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
        report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
      },
    },
    prompt_aliases: [],
    rehydrate_hints: [{ memory_id: "memory-rehydrate", reason: "Recover raw evidence.", required: true }],
    risk: { negative_transfer_risk: "medium", blocked_authority_count: 1, stale_memory_count: 0, reasons: ["test_risk"] },
    evidence_refs: { memory_ids: ["memory-use", "memory-inspect", "memory-block", "memory-rehydrate"], workflow_ids: [], evidence_count: 4 },
  });
}

const decisions = [
  decision("memory-use", "use_now", ["src/current.ts"]),
  decision("memory-inspect", "inspect_before_use", ["src/candidate.ts"]),
  decision("memory-block", "do_not_use", ["src/failed.ts"]),
  decision("memory-rehydrate", "rehydrate"),
];

test("canonical compiler preserves governance surfaces across standard, full-power, compact, and role profiles", () => {
  const standard = compileAionisAgentContext({
    base_context: baseContext(),
    governance_decisions: decisions,
    current_execution_state: null,
    claim_projection: null,
    task_role_context: { agent_role: "agent", task_context_profile: "general" },
    render_profile: { mode: "standard", detail: "standard", context_char_budget: null },
  });
  const fullPower = compileAionisAgentContext({
    base_context: baseContext(),
    governance_decisions: decisions,
    current_execution_state: baseContext(),
    claim_projection: null,
    task_role_context: { agent_role: "reviewer", task_context_profile: "multi_agent_handoff" },
    render_profile: { mode: "standard", detail: "full_power", context_char_budget: 6_144 },
  });
  const compact = compileAionisAgentContext({
    base_context: baseContext(),
    governance_decisions: decisions,
    current_execution_state: null,
    claim_projection: null,
    task_role_context: { agent_role: "verifier", task_context_profile: "coding_verifier" },
    render_profile: { mode: "compact_agent", detail: "compact", context_char_budget: 4_096 },
  });

  for (const context of [standard, fullPower, compact]) {
    assert.deepEqual(context.use_now_memory_ids, ["memory-use"]);
    assert.deepEqual(context.inspect_before_use_memory_ids, ["memory-inspect"]);
    assert.deepEqual(context.do_not_use_memory_ids, ["memory-block"]);
    assert.deepEqual(context.rehydrate_hints.map((hint) => hint.memory_id), ["memory-rehydrate"]);
    assert.equal(context.prompt_text.includes("src/failed.ts") && context.prompt_text.includes("use_now"), false);
  }
  assert.match(standard.prompt_text, /AIONIS_AGENT_CONTEXT v1/);
  assert.match(fullPower.prompt_text, /AIONIS_CTX v2/);
  assert.match(fullPower.prompt_text, /multi_agent_handoff/);
  assert.match(compact.prompt_text, /AIONIS_CTX compact_agent/);
  assert.match(compact.prompt_text, /coding_verifier/);
});

test("renderer is deterministic, budget bounded, and cannot reclassify context surfaces", () => {
  const context = baseContext();
  const profile = { mode: "compact_agent", detail: "compact", context_char_budget: 320 } as const;
  const before = structuredClone(context);
  const first = renderAionisAgentPrompt({ context, profile });
  const second = renderAionisAgentPrompt({ context, profile });
  assert.equal(first, second);
  assert.ok(first.length <= 320);
  assert.deepEqual(context, before);
  assert.match(first, /AIONIS_CTX compact_agent/);
});

test("Runtime owns one compiler and one renderer without Product Facade fallbacks", () => {
  const assembler = fs.readFileSync(path.join(runtimeRoot, "src/memory/product-output-assembler.ts"), "utf8");
  const facade = fs.readFileSync(path.join(runtimeRoot, "src/routes/product-facade.ts"), "utf8");
  const renderer = fs.readFileSync(path.join(runtimeRoot, "src/memory/agent-context-renderer.ts"), "utf8");
  assert.doesNotMatch(assembler, /function renderAgentContextPrompt|function buildAgentContextPrompt/);
  assert.doesNotMatch(facade, /function renderMergedAgentPrompt|function mergeProductGuideAgentContexts|function applyClaimLedgerProjectionToAgentContext/);
  assert.equal((renderer.match(/export function renderAionisAgentPrompt\b/g) ?? []).length, 1);
});
