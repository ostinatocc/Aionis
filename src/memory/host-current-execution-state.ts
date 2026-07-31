import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";

export type HostCurrentExecutionStateContextV1 = Readonly<{
  contract_version: "host_current_execution_state_context_v1";
  state_id: string;
  instruction: string;
  reason: string;
  target_files: readonly string[];
  acceptance_checks: readonly string[];
  verification_summary: readonly string[];
  artifact_hints: readonly string[];
  actor_role: string | null;
  next_action_hint: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized) return normalized;
  }
  return null;
}

function stringList(values: unknown[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const entries = Array.isArray(value) ? value : [];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const normalized = entry.replace(/\s+/g, " ").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function compileHostCurrentExecutionStateContextV1(args: {
  executionState: unknown;
  executionPacket: unknown;
}): HostCurrentExecutionStateContextV1 | null {
  const state = asRecord(args.executionState) ?? {};
  const packet = asRecord(args.executionPacket) ?? {};
  const resumeAnchor =
    asRecord(packet.resume_anchor) ?? asRecord(state.resume_anchor) ?? {};
  const targetFiles = stringList([
    packet.target_files,
    state.modified_files,
    state.owned_files,
  ], 16);
  const acceptanceChecks = stringList([
    packet.pending_validations,
    state.pending_validations,
    packet.hard_constraints,
    state.hard_constraints,
  ], 16).map((entry) => truncate(entry, 512));
  const completedValidations = stringList([
    packet.completed_validations,
    state.completed_validations,
  ], 12).map((entry) => truncate(entry, 512));
  const acceptedFacts = stringList([
    packet.accepted_facts,
    state.accepted_facts,
  ], 12);
  const blockers = stringList([
    packet.unresolved_blockers,
    state.unresolved_blockers,
  ], 8);
  const rejectedPaths = stringList([
    packet.rejected_paths,
    state.rejected_paths,
  ], 8);
  const rollbackNotes = stringList([
    packet.rollback_notes,
    state.rollback_notes,
  ], 8);
  const artifactHints = stringList([
    packet.artifact_refs,
    packet.evidence_refs,
    state.artifact_refs,
    state.evidence_refs,
  ], 16).map((entry) => truncate(entry, 512));
  const nextAction = stringValue(
    packet.next_action,
    state.next_action,
    state.continuation_hint,
  );
  const stage = stringValue(
    packet.current_stage,
    state.current_stage,
  );
  const actorRole = stringValue(
    packet.active_role,
    state.active_role,
    state.actor_role,
  );
  const taskBrief = stringValue(packet.task_brief, state.task_brief);
  const anchor = stringValue(resumeAnchor.anchor);
  const explicitStateId = stringValue(packet.state_id, state.state_id);
  const hasCurrentState =
    explicitStateId !== null
    || nextAction !== null
    || stage !== null
    || actorRole !== null
    || anchor !== null
    || targetFiles.length > 0
    || acceptanceChecks.length > 0
    || completedValidations.length > 0
    || acceptedFacts.length > 0
    || blockers.length > 0
    || rejectedPaths.length > 0
    || rollbackNotes.length > 0
    || artifactHints.length > 0;
  if (!hasCurrentState) return null;

  const material = {
    contract_version: "host_current_execution_state_material_v1",
    state_id: explicitStateId,
    stage,
    actor_role: actorRole,
    task_brief: taskBrief,
    next_action: nextAction,
    resume_anchor: anchor,
    target_files: targetFiles,
    acceptance_checks: acceptanceChecks,
    completed_validations: completedValidations,
    accepted_facts: acceptedFacts,
    blockers,
    rejected_paths: rejectedPaths,
    rollback_notes: rollbackNotes,
    artifact_hints: artifactHints,
  };
  const stateId =
    `host_current_state:${sha256Hex(stableStringify(material))}`;
  const instruction = truncate(
    nextAction
      ? `Continue from the exact host-reported current state: ${nextAction}`
      : "Inspect the exact host-reported current state before choosing the next action.",
    512,
  );
  const reasonParts = [
    stage ? `stage=${stage}` : null,
    actorRole ? `active_role=${actorRole}` : null,
    anchor ? `resume_anchor=${anchor}` : null,
    taskBrief ? `task=${truncate(taskBrief, 180)}` : null,
    acceptedFacts.length > 0
      ? `host_reported_facts=${acceptedFacts.slice(0, 4).join(" | ")}`
      : null,
    blockers.length > 0
      ? `unresolved_blockers=${blockers.slice(0, 4).join(" | ")}`
      : null,
    rejectedPaths.length > 0
      ? `rejected_paths=${rejectedPaths.slice(0, 3).join(" | ")}`
      : null,
    rollbackNotes.length > 0
      ? `rollback_notes=${rollbackNotes.slice(0, 3).join(" | ")}`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return {
    contract_version: "host_current_execution_state_context_v1",
    state_id: stateId,
    instruction,
    reason: truncate(
      reasonParts.length > 0
        ? `Host-supplied current execution state; ${reasonParts.join("; ")}`
        : "Host-supplied current execution state.",
      1_024,
    ),
    target_files: targetFiles,
    acceptance_checks: acceptanceChecks,
    verification_summary: completedValidations,
    artifact_hints: artifactHints,
    actor_role: actorRole,
    next_action_hint: nextAction ? truncate(nextAction, 400) : null,
  };
}
