import { GovernanceDecisionV1Schema, type AionisGuidanceAuthority, type AionisMemoryDecisionSurface, type GovernanceDecisionV1 } from "./governance-contract.js";
import type { LifecycleDecisionInput, MemoryLifecycleState } from "./memory-lifecycle-adjudicator.js";
export type MemoryStateInput = {
  memory_id: string; authority: AionisGuidanceAuthority; lifecycle_state: MemoryLifecycleState;
  domain: "general" | "execution"; execution_kind: "current_state" | "procedure" | "handoff" | "other" | null;
  execution_effect?: "positive" | "negative" | "unknown" | null;
  memory_contract: "direct_use" | "inspect_before_use" | "evidence_only" | "do_not_use"; target_files: string[];
};

export type GovernanceRequestContext = {
  scope_match: "unscoped" | "exact_task" | "workflow" | "task_family" | "unrelated";
  rehydrate_requested: boolean;
};

function uniqueStrings(values: Array<string | null | undefined>, limit: number): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))].slice(0, limit);
}

const SURFACE_REASON: Record<AionisMemoryDecisionSurface, string> = { use_now: "available_for_agent_use", inspect_before_use: "kept_out_of_direct_use", do_not_use: "blocked_from_agent_use", rehydrate: "requires_differential_rehydration", not_agent_facing: "not_agent_facing" };

export type GovernanceDecisionInput = {
  memory: MemoryStateInput;
  request: GovernanceRequestContext;
  lifecycle: LifecycleDecisionInput;
};

export function decideGovernedMemory(input: GovernanceDecisionInput): GovernanceDecisionV1 {
  const { memory, request, lifecycle } = input;
  const baseReasons = uniqueStrings([
    ...lifecycle.reason_codes,
    memory.authority === "candidate" ? "candidate_authority" : memory.authority === "blocked" ? "blocked_authority" : `authority_${memory.authority}`,
    `scope_${request.scope_match}`,
  ], 12);
  const finish = (surface: AionisMemoryDecisionSurface, reasons: Array<string | null> = []): GovernanceDecisionV1 =>
    GovernanceDecisionV1Schema.parse({
      memory_id: memory.memory_id,
      surface,
      authority: memory.authority,
      lifecycle_state: memory.lifecycle_state,
      actionable: surface === "use_now",
      reason_codes: uniqueStrings([...baseReasons, ...reasons, SURFACE_REASON[surface]], 16),
      target_files: uniqueStrings(memory.target_files.map((value) => value.slice(0, 2048)), 16),
      requires_rehydrate: surface === "rehydrate",
    });

  const blockReasons = uniqueStrings([
    memory.memory_contract === "do_not_use" ? "memory_contract_do_not_use" : null,
    memory.domain === "execution" && memory.execution_effect === "negative" ? "execution_effect_negative" : null,
  ], 4);
  if (lifecycle.blocks_use || memory.authority === "blocked" || blockReasons.length > 0) return finish("do_not_use", blockReasons);

  const rehydrateReasons = uniqueStrings([
    request.rehydrate_requested ? "request_rehydrate" : null,
  ], 3);
  if (lifecycle.requires_rehydrate || rehydrateReasons.length > 0) return finish("rehydrate", rehydrateReasons);

  if (request.scope_match === "unrelated") return finish("not_agent_facing", ["scope_excluded_from_agent_context"]);

  const exactTaskContinuation =
    memory.domain === "execution"
    && memory.execution_kind === "current_state"
    && memory.execution_effect === "unknown"
    && request.scope_match === "exact_task"
    && memory.memory_contract === "direct_use";
  const contextualInspectReasons = uniqueStrings([
    memory.domain === "execution" && memory.execution_effect !== "positive" ? "execution_effect_not_verified" : null,
    exactTaskContinuation ? "exact_task_continuation_state_available" : null,
  ], 5);
  if (contextualInspectReasons.length > 0) {
    return finish("inspect_before_use", contextualInspectReasons);
  }

  const policyInspectReasons = uniqueStrings([
    memory.memory_contract === "evidence_only" ? "memory_contract_evidence_only" : null,
    memory.memory_contract === "inspect_before_use" ? "memory_contract_requires_inspection" : null,
  ], 3);
  if (policyInspectReasons.length > 0) return finish("inspect_before_use", policyInspectReasons);
  if (lifecycle.requires_inspection || memory.authority === "candidate") {
    return finish("inspect_before_use", [
      lifecycle.requires_inspection ? "lifecycle_requires_inspection" : "authority_requires_inspection",
    ]);
  }
  const usableAuthority = memory.authority === "trusted" || memory.authority === "advisory";
  const directUseEligible = usableAuthority
    && memory.lifecycle_state === "active"
    && memory.memory_contract === "direct_use"
    && (memory.domain === "general" || memory.execution_kind === "current_state" || memory.execution_kind === "procedure");
  if (directUseEligible) return finish("use_now", ["direct_use_eligible"]);
  if (usableAuthority && memory.lifecycle_state === "active") return finish("not_agent_facing", ["optional_context_only"]);
  return finish("not_agent_facing");
}
