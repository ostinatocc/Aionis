import type { ServiceLifecycleConstraintV1 } from "../execution/types.js";
import {
  buildExecutionContractFromProjection,
  deriveExecutionContractFromSlots,
  type ExecutionContractV1,
  type ExecutionContractProvenanceKind,
} from "./execution-contract.js";
import type { ContractTrust } from "./contract-trust.js";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: Array<string | null | undefined>, max = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= max) break;
  }
  return out;
}

function deriveTemplateKeySteps(stepsRaw: unknown): string[] {
  if (!Array.isArray(stepsRaw)) return [];
  return uniqueStrings(
    stepsRaw.map((step) => {
      const obj = asObject(step) ?? {};
      const stepIndex = Number(obj.step_index ?? 0) || null;
      const toolName = toStringOrNull(obj.tool_name);
      if (!toolName) return null;
      return stepIndex != null ? `step_${stepIndex}:${toolName}` : toolName;
    }),
    16,
  );
}

export type ReplayWorkflowContract = {
  execution_contract_v1: ExecutionContractV1 | null;
  contract_trust: ContractTrust | null;
  task_family: string | null;
  target_files: string[];
  next_action: string | null;
  workflow_steps: string[];
  pattern_hints: string[];
  service_lifecycle_constraints: ServiceLifecycleConstraintV1[];
};

export function deriveReplayWorkflowContractFromSlots(
  slots: Record<string, unknown>,
  provenance?: {
    source_kind?: ExecutionContractProvenanceKind;
    source_summary_version?: string | null;
    source_anchor?: string | null;
    evidence_refs?: string[];
    notes?: string[];
  },
): ReplayWorkflowContract {
  const executionContract = deriveExecutionContractFromSlots({
    slots,
    provenance: provenance ?? {
      source_kind: "slot_projection",
      notes: ["replay_workflow_contract_projection"],
    },
  });

  return {
    execution_contract_v1: executionContract,
    contract_trust: executionContract?.contract_trust ?? null,
    task_family: executionContract?.task_family ?? null,
    target_files: executionContract?.target_files ?? [],
    next_action: executionContract?.next_action ?? null,
    workflow_steps:
      executionContract?.workflow_steps && executionContract.workflow_steps.length > 0
        ? executionContract.workflow_steps
        : deriveTemplateKeySteps(slots.steps_template),
    pattern_hints: executionContract?.pattern_hints ?? [],
    service_lifecycle_constraints: executionContract?.service_lifecycle_constraints ?? [],
  };
}

export function buildReplayProjectionExecutionContract(args: {
  base: ReplayWorkflowContract;
  task_signature: string;
  workflow_signature: string;
  source_anchor: string;
  selected_tool?: string | null;
  file_path?: string | null;
  notes?: string[];
  provenance_source_kind?: ExecutionContractProvenanceKind;
}): ExecutionContractV1 {
  return buildExecutionContractFromProjection({
    contract_trust: args.base.contract_trust,
    task_family: args.base.task_family,
    task_signature: args.task_signature,
    workflow_signature: args.workflow_signature,
    selected_tool: args.selected_tool ?? null,
    file_path: args.file_path ?? args.base.execution_contract_v1?.file_path ?? args.base.target_files[0] ?? null,
    target_files: args.base.target_files,
    next_action: args.base.next_action,
    workflow_steps: args.base.workflow_steps,
    pattern_hints: args.base.pattern_hints,
    service_lifecycle_constraints: args.base.service_lifecycle_constraints,
    acceptance_checks: args.base.execution_contract_v1?.outcome.acceptance_checks ?? [],
    success_invariants: args.base.execution_contract_v1?.outcome.success_invariants ?? [],
    dependency_requirements: args.base.execution_contract_v1?.outcome.dependency_requirements ?? [],
    environment_assumptions: args.base.execution_contract_v1?.outcome.environment_assumptions ?? [],
    must_hold_after_exit: args.base.execution_contract_v1?.outcome.must_hold_after_exit ?? [],
    external_visibility_requirements: args.base.execution_contract_v1?.outcome.external_visibility_requirements ?? [],
    provenance: {
      source_kind: args.provenance_source_kind ?? "workflow_projection",
      source_anchor: args.source_anchor,
      notes: args.notes ?? [],
    },
  });
}
