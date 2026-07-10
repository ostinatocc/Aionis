import { GovernanceDecisionV1Schema, type AionisGuidanceAuthority, type AionisMemoryDecisionSurface, type GovernanceDecisionV1 } from "./governance-contract.js";
import type { AuthorityConsumptionStateV1 } from "./authority-consumption.js";
import type { LifecycleDecisionInput, MemoryLifecycleState } from "./memory-lifecycle-adjudicator.js";
export type MemoryStateInput = {
  memory_id: string; authority: AionisGuidanceAuthority; lifecycle_state: MemoryLifecycleState;
  domain: "general" | "execution"; execution_kind: "current_state" | "procedure" | "handoff" | "other" | null;
  memory_contract: "direct_use" | "inspect_before_use" | "evidence_only" | "do_not_use"; target_files: string[];
};

export type GovernanceRequestContext = {
  scope_match: "unscoped" | "exact_task" | "workflow" | "task_family" | "unrelated"; premise_conflict: "none" | "inspect" | "block";
  trusted_workflow_conflict: boolean; verified_recovered_handoff: boolean; rehydrate_requested: boolean;
  lifecycle_candidate: "none" | "direct_use" | "inspect_before_use" | "rehydrate"; projected_surface: AionisMemoryDecisionSurface | null;
};
export type FeedbackPostureInput = { posture: "none" | "positive_attribution" | "weak_counter_signal" | "repeated_weak_counter_signal" | "strong_counter_signal" | "inspect_before_use" };

function uniqueStrings(values: Array<string | null | undefined>, limit: number): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))].slice(0, limit);
}

const SURFACE_REASON: Record<AionisMemoryDecisionSurface, string> = { use_now: "available_for_agent_use", inspect_before_use: "kept_out_of_direct_use", do_not_use: "blocked_from_agent_use", rehydrate: "requires_differential_rehydration", not_agent_facing: "not_agent_facing" };

export type GovernanceDecisionInput = { memory: MemoryStateInput; request: GovernanceRequestContext; lifecycle: LifecycleDecisionInput; authority: AuthorityConsumptionStateV1; feedback: FeedbackPostureInput };

export function decideGovernedMemory(input: GovernanceDecisionInput): GovernanceDecisionV1 {
  const { memory, request, lifecycle, authority, feedback } = input;
  const baseReasons = uniqueStrings([
    ...lifecycle.reason_codes,
    memory.authority === "candidate" ? "candidate_authority" : memory.authority === "blocked" ? "blocked_authority" : `authority_${memory.authority}`,
    `scope_${request.scope_match}`,
    feedback.posture === "none" ? null : `feedback_${feedback.posture}`,
    authority.requires_inspection && memory.authority !== "blocked" ? "authority_consumption_requires_inspection" : null,
    authority.blocks_promotion_readiness ? "authority_consumption_blocks_promotion_readiness" : null,
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
    request.premise_conflict === "block" ? "premise_conflict_block" : null,
    request.projected_surface === "do_not_use" ? "agent_context_projection_do_not_use" : null,
  ], 3);
  if (lifecycle.blocks_use || memory.authority === "blocked" || blockReasons.length > 0) return finish("do_not_use", blockReasons);

  const rehydrateReasons = uniqueStrings([
    request.rehydrate_requested ? "request_rehydrate" : null,
    request.lifecycle_candidate === "rehydrate" ? "lifecycle_candidate_rehydrate" : null,
    request.projected_surface === "rehydrate" ? "agent_context_projection_rehydrate" : null,
  ], 3);
  if (lifecycle.requires_rehydrate || rehydrateReasons.length > 0) return finish("rehydrate", rehydrateReasons);

  const feedbackRequiresInspection = ["repeated_weak_counter_signal", "strong_counter_signal", "inspect_before_use"].includes(feedback.posture);
  if (feedbackRequiresInspection || authority.requires_inspection || authority.blocks_promotion_readiness) return finish("inspect_before_use");
  if (request.verified_recovered_handoff) return finish("use_now", ["verified_recovered_handoff"]);
  if (request.scope_match === "unrelated") return finish("not_agent_facing", ["scope_excluded_from_agent_context"]);
  if (request.projected_surface === "inspect_before_use") return finish("inspect_before_use", ["agent_context_projection_inspect_before_use"]);

  const inspectReasons = uniqueStrings([
    request.premise_conflict === "inspect" ? "premise_conflict_requires_inspection" : null,
    request.trusted_workflow_conflict ? "trusted_workflow_conflict_requires_inspection" : null,
    request.lifecycle_candidate === "inspect_before_use" ? "lifecycle_candidate_direct_use_gated" : null,
    memory.memory_contract === "evidence_only" ? "memory_contract_evidence_only" : null,
    memory.memory_contract === "inspect_before_use" && request.lifecycle_candidate !== "direct_use" ? "memory_contract_requires_inspection" : null,
  ], 5);
  if (inspectReasons.length > 0) return finish("inspect_before_use", inspectReasons);
  if (request.lifecycle_candidate === "direct_use") return finish("use_now", ["lifecycle_candidate_direct_use_admitted"]);
  if (lifecycle.requires_inspection || memory.authority === "candidate") {
    return finish("inspect_before_use", [
      lifecycle.requires_inspection ? "lifecycle_requires_inspection" : "authority_requires_inspection",
    ]);
  }
  if (request.projected_surface === "use_now") return finish("use_now", ["agent_context_projection_use_now"]);

  const usableAuthority = memory.authority === "trusted" || memory.authority === "advisory";
  const directUseEligible = usableAuthority
    && memory.lifecycle_state === "active"
    && memory.memory_contract === "direct_use"
    && (memory.domain === "general" || memory.execution_kind === "current_state" || memory.execution_kind === "procedure");
  if (directUseEligible) return finish("use_now", ["direct_use_eligible"]);
  if (usableAuthority && memory.lifecycle_state === "active") return finish("not_agent_facing", ["optional_context_only"]);
  return finish("not_agent_facing");
}
