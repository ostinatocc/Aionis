import {
  resolveExecutionPacketAssembly,
  type ExecutionPacketAssemblyMode,
  type ExecutionPacketV1,
  type ExecutionStateV1,
} from "../execution/index.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import {
  readExecutionStateSlot,
  readExecutionTransitionsSlot,
} from "../memory/execution-slot-surface.js";

type ExecutionContinuityStaticBlock = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  intents: string[];
  priority: number;
  always_include: boolean;
};

export type ExecutionContinuitySideOutputsInput = {
  execution_result_summary?: unknown;
  execution_artifacts?: unknown;
  execution_evidence?: unknown;
};

export type ExecutionContinuityPacketInput = ExecutionContinuitySideOutputsInput & {
  static_context_blocks?: ExecutionContinuityStaticBlock[];
  execution_packet_v1?: ExecutionPacketV1;
  execution_state_v1?: ExecutionStateV1;
};

export type ExecutionContinuityContextInput = ExecutionContinuitySideOutputsInput & {
  context?: unknown;
};

export type ExecutionContinuityKernelContext = {
  packet: ExecutionPacketV1 | null;
  source_mode: ExecutionPacketAssemblyMode;
  state_first_assembly: boolean;
};

export type ExecutionContinuityKernel = {
  assembleContinuityContext(input: ExecutionContinuityContextInput): Record<string, unknown>;
  recoverExecutionState(input: {
    execution_packet_v1?: ExecutionPacketV1;
    execution_state_v1?: ExecutionStateV1;
  }): ExecutionContinuityKernelContext;
  buildNextActionPacket(input: ExecutionContinuityPacketInput): ExecutionContinuityStaticBlock[];
  applyTransitionsFromSlots(input: {
    executionStateStore?: ExecutionStateStore | null;
    writeSlots: Record<string, unknown> | null;
  }): Array<Record<string, unknown>> | undefined;
};

function toStaticContextBlock(id: string, title: string, content: string): ExecutionContinuityStaticBlock {
  return {
    id,
    title,
    content,
    tags: ["execution-packet", "continuity"],
    intents: ["resume", "review", "continuity"],
    priority: 95,
    always_include: true,
  };
}

export function executionPacketToStaticBlocks(packet: ExecutionPacketV1): ExecutionContinuityStaticBlock[] {
  const blocks = [
    toStaticContextBlock(
      `execution-packet-${packet.state_id}-brief`,
      "Execution Brief",
      [
        `current_stage=${packet.current_stage}`,
        `active_role=${packet.active_role}`,
        `task_brief=${packet.task_brief}`,
        packet.target_files.length > 0 ? `target_files=${packet.target_files.join(" | ")}` : null,
        packet.next_action ? `next_action=${packet.next_action}` : null,
        packet.hard_constraints.length > 0 ? `hard_constraints=${packet.hard_constraints.join(" | ")}` : null,
        packet.pending_validations.length > 0 ? `pending_validations=${packet.pending_validations.join(" | ")}` : null,
      ].filter(Boolean).join("; "),
    ),
    toStaticContextBlock(
      `execution-packet-${packet.state_id}-state`,
      "Execution State",
      [
        packet.accepted_facts.length > 0 ? `accepted_facts=${packet.accepted_facts.join(" | ")}` : null,
        packet.rejected_paths.length > 0 ? `rejected_paths=${packet.rejected_paths.join(" | ")}` : null,
        packet.unresolved_blockers.length > 0 ? `unresolved_blockers=${packet.unresolved_blockers.join(" | ")}` : null,
        packet.rollback_notes.length > 0 ? `rollback_notes=${packet.rollback_notes.join(" | ")}` : null,
        packet.evidence_refs.length > 0 ? `evidence_refs=${packet.evidence_refs.join(" | ")}` : null,
      ].filter(Boolean).join("; "),
    ),
  ].filter((block) => block.content.trim().length > 0);

  if (packet.review_contract) {
    blocks.push(
      toStaticContextBlock(
        `execution-packet-${packet.state_id}-review`,
        "Reviewer Contract",
        [
          `standard=${packet.review_contract.standard}`,
          packet.review_contract.required_outputs.length > 0 ? `required_outputs=${packet.review_contract.required_outputs.join(" | ")}` : null,
          packet.review_contract.acceptance_checks.length > 0 ? `acceptance_checks=${packet.review_contract.acceptance_checks.join(" | ")}` : null,
          `rollback_required=${packet.review_contract.rollback_required ? "true" : "false"}`,
        ].filter(Boolean).join("; "),
      ),
    );
  }

  if (packet.resume_anchor) {
    blocks.push(
      toStaticContextBlock(
        `execution-packet-${packet.state_id}-resume`,
        "Resume Anchor",
        [
          `anchor=${packet.resume_anchor.anchor}`,
          packet.resume_anchor.file_path ? `file_path=${packet.resume_anchor.file_path}` : null,
          packet.resume_anchor.symbol ? `symbol=${packet.resume_anchor.symbol}` : null,
          packet.resume_anchor.repo_root ? `repo_root=${packet.resume_anchor.repo_root}` : null,
        ].filter(Boolean).join("; "),
      ),
    );
  }

  if (packet.service_lifecycle_constraints.length > 0) {
    blocks.push(
      toStaticContextBlock(
        `execution-packet-${packet.state_id}-service-lifecycle`,
        "Service Lifecycle Constraints",
        packet.service_lifecycle_constraints.map((constraint) => [
          `label=${constraint.label}`,
          `service_kind=${constraint.service_kind}`,
          constraint.endpoint ? `endpoint=${constraint.endpoint}` : null,
          `must_survive_agent_exit=${constraint.must_survive_agent_exit ? "true" : "false"}`,
          `revalidate_from_fresh_shell=${constraint.revalidate_from_fresh_shell ? "true" : "false"}`,
          `detach_then_probe=${constraint.detach_then_probe ? "true" : "false"}`,
          constraint.health_checks.length > 0 ? `health_checks=${constraint.health_checks.join(" | ")}` : null,
        ].filter(Boolean).join("; ")).join("\n"),
      ),
    );
  }

  return blocks;
}

export function normalizeExecutionContinuitySideOutputs(parsed: ExecutionContinuitySideOutputsInput) {
  const executionResultSummary =
    parsed.execution_result_summary && typeof parsed.execution_result_summary === "object" && !Array.isArray(parsed.execution_result_summary)
      ? (parsed.execution_result_summary as Record<string, unknown>)
      : null;
  const executionArtifacts = Array.isArray(parsed.execution_artifacts)
    ? parsed.execution_artifacts.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const executionEvidence = Array.isArray(parsed.execution_evidence)
    ? parsed.execution_evidence.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  return {
    executionResultSummary,
    executionArtifacts,
    executionEvidence,
  };
}

function sideOutputToLine(prefix: string, value: Record<string, unknown>) {
  const fields = ["ref", "uri", "claim", "kind", "type", "label"]
    .map((key) => (typeof value[key] === "string" && value[key].length > 0 ? `${key}=${String(value[key])}` : null))
    .filter(Boolean);
  return `${prefix}${fields.length > 0 ? ` ${fields.join("; ")}` : ""}`.trim();
}

export function executionContinuityToStaticBlocks(parsed: ExecutionContinuitySideOutputsInput) {
  const sideOutputs = normalizeExecutionContinuitySideOutputs(parsed);
  const blocks: ExecutionContinuityStaticBlock[] = [];

  const contentLines: string[] = [];
  if (sideOutputs.executionResultSummary) {
    const summaryLine = Object.entries(sideOutputs.executionResultSummary)
      .slice(0, 8)
      .map(([key, value]) => `${key}=${typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)}`)
      .join("; ");
    if (summaryLine) contentLines.push(`summary: ${summaryLine}`);
  }
  if (sideOutputs.executionArtifacts.length > 0) {
    contentLines.push(...sideOutputs.executionArtifacts.slice(0, 5).map((artifact, index) => sideOutputToLine(`artifact_${index + 1}:`, artifact)));
  }
  if (sideOutputs.executionEvidence.length > 0) {
    contentLines.push(...sideOutputs.executionEvidence.slice(0, 5).map((evidence, index) => sideOutputToLine(`evidence_${index + 1}:`, evidence)));
  }

  if (contentLines.length > 0) {
    blocks.push(
      toStaticContextBlock(
        "execution-side-outputs",
        "Execution Side Outputs",
        contentLines.join("\n"),
      ),
    );
  }

  return { blocks, sideOutputs };
}

export function buildExecutionContinuityContext(parsed: ExecutionContinuityContextInput): Record<string, unknown> {
  const base =
    parsed.context && typeof parsed.context === "object" && !Array.isArray(parsed.context) ? { ...(parsed.context as Record<string, unknown>) } : {};
  const { sideOutputs } = executionContinuityToStaticBlocks(parsed);
  if (sideOutputs.executionResultSummary && !("execution_result_summary" in base)) {
    base.execution_result_summary = sideOutputs.executionResultSummary;
  }
  if (sideOutputs.executionArtifacts.length > 0 && !("execution_artifacts" in base)) {
    base.execution_artifacts = sideOutputs.executionArtifacts;
  }
  if (sideOutputs.executionEvidence.length > 0 && !("execution_evidence" in base)) {
    base.execution_evidence = sideOutputs.executionEvidence;
  }
  return base;
}

export function mergeExecutionPacketStaticBlocks(parsed: ExecutionContinuityPacketInput): ExecutionContinuityStaticBlock[] {
  const base = Array.isArray(parsed.static_context_blocks) ? parsed.static_context_blocks : [];
  const continuityBlocks = executionContinuityToStaticBlocks(parsed).blocks;
  const { packet } = resolveExecutionPacketAssembly(parsed);
  if (!packet) return [...continuityBlocks, ...base];
  return [...executionPacketToStaticBlocks(packet), ...continuityBlocks, ...base];
}

export function resolveExecutionKernelContext(parsed: {
  execution_packet_v1?: ExecutionPacketV1;
  execution_state_v1?: ExecutionStateV1;
}): ExecutionContinuityKernelContext {
  const { packet, source_mode } = resolveExecutionPacketAssembly(parsed);
  return {
    packet,
    source_mode,
    state_first_assembly: source_mode === "state_first",
  };
}

export function applyExecutionContinuityTransitionsFromSlots(args: {
  executionStateStore?: ExecutionStateStore | null;
  writeSlots: Record<string, unknown> | null;
}): Array<Record<string, unknown>> | undefined {
  const executionState = readExecutionStateSlot(args.writeSlots);
  if (!args.executionStateStore || !executionState) {
    return undefined;
  }
  let storedState = args.executionStateStore.put(executionState);
  const transitions = readExecutionTransitionsSlot(args.writeSlots);
  if (!transitions) return undefined;
  const appliedTransitions: Array<Record<string, unknown>> = [];
  for (const parsed of transitions) {
    const transition = {
      ...parsed,
      expected_revision: storedState.revision,
    };
    storedState = args.executionStateStore.applyTransition(transition);
    appliedTransitions.push(transition as Record<string, unknown>);
  }
  return appliedTransitions;
}

export const executionContinuityKernel: ExecutionContinuityKernel = {
  assembleContinuityContext: buildExecutionContinuityContext,
  recoverExecutionState: resolveExecutionKernelContext,
  buildNextActionPacket: mergeExecutionPacketStaticBlocks,
  applyTransitionsFromSlots: applyExecutionContinuityTransitionsFromSlots,
};
