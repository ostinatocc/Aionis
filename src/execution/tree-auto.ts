import { createHash } from "node:crypto";
import {
  ExecutionPacketV1Schema,
  ExecutionStateV1Schema,
  type ExecutionPacketV1,
  type ExecutionStateV1,
} from "./types.js";
import {
  createExecutionTreeV1,
  ExecutionTreeV1Schema,
  type ExecutionTreeOperationV1,
  type ExecutionTreeV1,
} from "./tree.js";
import type { ExecutionTreeStore } from "./tree-store.js";
import { buildExecutionPacketV1 } from "./packet.js";

export type AutoExecutionTreeApplyResult = {
  tree: ExecutionTreeV1;
  operations: ExecutionTreeOperationV1[];
};

type AutoExecutionTreeSource = {
  tree: ExecutionTreeV1;
  state: ExecutionStateV1 | null;
  packet: ExecutionPacketV1 | null;
  slots: Record<string, unknown>;
  title?: string | null;
  textSummary?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function stringList(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const next = firstString(entry);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = firstString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 20);
}

function parseExecutionState(value: unknown): ExecutionStateV1 | null {
  const parsed = ExecutionStateV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseExecutionPacket(value: unknown): ExecutionPacketV1 | null {
  const parsed = ExecutionPacketV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseExecutionTree(value: unknown): ExecutionTreeV1 | null {
  const parsed = ExecutionTreeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function hasExplicitTreeOperations(slots: Record<string, unknown>): boolean {
  return Array.isArray(slots.execution_tree_operations_v1) && slots.execution_tree_operations_v1.length > 0;
}

function readBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function isExecutionTreeDefaultDisabled(slots: Record<string, unknown> | null | undefined): boolean {
  if (!slots) return false;
  return readBooleanFlag(slots.execution_tree_disabled)
    || readBooleanFlag(slots.execution_tree_default_disabled);
}

function hasAutoContinuitySignal(args: {
  state: ExecutionStateV1 | null;
  packet: ExecutionPacketV1 | null;
  slots: Record<string, unknown>;
}): boolean {
  return !!args.state
    || !!args.packet
    || !!asRecord(args.slots.execution_result_summary)
    || extractRefsFromRecords(args.slots.execution_artifacts).length > 0
    || extractRefsFromRecords(args.slots.execution_evidence).length > 0;
}

export function createExecutionTreeFromExecutionStateV1(stateInput: ExecutionStateV1): ExecutionTreeV1 {
  const state = ExecutionStateV1Schema.parse(stateInput);
  return createExecutionTreeV1({
    tree_id: `execution-tree:${state.state_id}`,
    scope: state.scope,
    task_brief: state.task_brief,
    at: state.updated_at,
  });
}

function extractRefsFromRecords(value: unknown, limit = 16): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    refs.push(
      firstString(
        record.ref,
        record.uri,
        record.id,
        record.path,
        record.file_path,
        record.artifact_ref,
        record.evidence_ref,
      ) ?? "",
    );
  }
  return uniqueStrings(refs, limit);
}

function deriveRefs(source: AutoExecutionTreeSource): string[] {
  return uniqueStrings([
    ...extractRefsFromRecords(source.slots.execution_artifacts),
    ...extractRefsFromRecords(source.slots.execution_evidence),
    ...stringList(source.packet?.artifact_refs),
    ...stringList(source.packet?.evidence_refs),
    firstString(source.slots.raw_ref),
    firstString(source.slots.evidence_ref),
  ], 24);
}

function deriveAction(source: AutoExecutionTreeSource): string {
  return firstString(
    source.slots.next_action,
    source.packet?.next_action,
    source.textSummary,
    source.state ? `Advance ${source.state.current_stage} as ${source.state.active_role}` : null,
    source.packet ? `Advance ${source.packet.current_stage} as ${source.packet.active_role}` : null,
    `Advance execution tree ${source.tree.tree_id}`,
  )!;
}

function compactResultSummary(value: unknown): string | null {
  const summary = asRecord(value);
  if (!summary) return null;
  const preferred = firstString(
    summary.summary,
    summary.result_summary,
    summary.message,
    summary.outcome_summary,
    summary.status_detail,
    summary.status,
    summary.outcome,
    summary.result,
    summary.verdict,
  );
  if (preferred) return preferred;
  const fields = Object.entries(summary)
    .slice(0, 8)
    .map(([key, raw]) => {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        return `${key}=${String(raw)}`;
      }
      return null;
    })
    .filter((value): value is string => !!value);
  return fields.length > 0 ? fields.join("; ") : null;
}

function deriveObservation(source: AutoExecutionTreeSource): string {
  const resultSummary = compactResultSummary(source.slots.execution_result_summary);
  const completedValidations = uniqueStrings([
    ...stringList(source.state?.completed_validations),
    ...stringList(source.packet?.accepted_facts).filter((value) => value.startsWith("completed_validation:")),
  ], 8);
  const pendingValidations = uniqueStrings([
    ...stringList(source.state?.pending_validations),
    ...stringList(source.packet?.pending_validations),
  ], 8);
  const blockers = uniqueStrings([
    ...stringList(source.state?.unresolved_blockers),
    ...stringList(source.packet?.unresolved_blockers),
  ], 8);
  const lines = [
    resultSummary,
    completedValidations.length > 0 ? `completed_validations=${completedValidations.join(" | ")}` : null,
    pendingValidations.length > 0 ? `pending_validations=${pendingValidations.join(" | ")}` : null,
    blockers.length > 0 ? `blockers=${blockers.join(" | ")}` : null,
    source.state ? `stage=${source.state.current_stage}; role=${source.state.active_role}` : null,
  ].filter((value): value is string => !!value);
  return lines.length > 0 ? lines.join("; ") : `Observed execution progress for ${source.tree.task_brief}`;
}

function hasCompressionSignal(source: AutoExecutionTreeSource): boolean {
  return !!asRecord(source.slots.execution_result_summary)
    || extractRefsFromRecords(source.slots.execution_artifacts).length > 0
    || extractRefsFromRecords(source.slots.execution_evidence).length > 0
    || stringList(source.state?.completed_validations).length > 0;
}

function classifyOutcomeText(value: string): "passed" | "failed" | null {
  const statusText = value.toLowerCase();
  const failed = /\b(failed|failure|failures|error|errors|errored|blocked|rejected|invalid|unsuccessful)\b/.test(statusText);
  const passed = /\b(passed|pass|success|successful|succeeded|ok|complete|completed|accepted)\b/.test(statusText);
  const negatedFailure =
    /\b(not|no|without|never)\s+(failed|failure|failures|error|errors|errored|blocked|rejected|invalid|unsuccessful)\b/.test(statusText)
    || /\b(failed|failure|failures|error|errors|errored|blocked|rejected|invalid|unsuccessful)\s+(not|never)\s+(observed|found|detected|present)\b/.test(statusText);
  const negatedSuccess =
    /\b(not|no|without|never)\s+(passed|pass|success|successful|succeeded|ok|complete|completed|accepted)\b/.test(statusText)
    || /\b(passed|pass|success|successful|succeeded|ok|complete|completed|accepted)\s+(not|never)\s+(observed|found|detected|present)\b/.test(statusText);
  if (failed && !negatedFailure) return "failed";
  if (passed && !negatedSuccess) return "passed";
  return null;
}

function readOutcomeFromRecord(record: Record<string, unknown> | null): "passed" | "failed" | null {
  if (!record) return null;
  const statusText = firstString(record.status, record.outcome, record.result, record.verdict, record.state)?.toLowerCase() ?? "";
  const textOutcome = statusText ? classifyOutcomeText(statusText) : null;
  if (textOutcome) return textOutcome;
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (typeof value !== "boolean") continue;
    if (normalizedKey.includes("passed") || normalizedKey.includes("success") || normalizedKey === "ok") {
      return value ? "passed" : "failed";
    }
  }
  return null;
}

function deriveOutcome(source: AutoExecutionTreeSource): "passed" | "failed" | null {
  const direct = readOutcomeFromRecord(asRecord(source.slots.execution_result_summary));
  if (direct) return direct;
  const evidence = Array.isArray(source.slots.execution_evidence) ? source.slots.execution_evidence : [];
  for (const entry of evidence) {
    const outcome = readOutcomeFromRecord(asRecord(entry));
    if (outcome) return outcome;
  }
  if (source.state?.unresolved_blockers.length) return "failed";
  if (source.state?.completed_validations.length && source.state.pending_validations.length === 0) return "passed";
  return null;
}

function operationId(source: AutoExecutionTreeSource, type: ExecutionTreeOperationV1["type"]): string {
  const resultSummary = compactResultSummary(source.slots.execution_result_summary);
  return `${source.tree.tree_id}:auto:${digest({
    state_id: source.state?.state_id ?? source.packet?.state_id ?? null,
    at: source.state?.updated_at ?? null,
    action: deriveAction(source),
    observation: deriveObservation(source),
    result_summary: resultSummary,
    title: source.title ?? null,
    text_summary: source.textSummary ?? null,
  })}:${type}`;
}

function operationAt(source: AutoExecutionTreeSource): string {
  return source.state?.updated_at ?? new Date().toISOString();
}

function operationActorRole(source: AutoExecutionTreeSource): string | null {
  return source.state?.active_role ?? source.packet?.active_role ?? null;
}

function buildGrowOperation(source: AutoExecutionTreeSource): ExecutionTreeOperationV1 {
  return {
    operation_id: operationId(source, "grow"),
    tree_id: source.tree.tree_id,
    scope: source.tree.scope,
    actor_role: operationActorRole(source),
    at: operationAt(source),
    type: "grow",
    title: firstString(source.title, source.state?.current_stage, source.packet?.current_stage),
    action: deriveAction(source),
    observation: deriveObservation(source),
    tool_name: null,
    refs: deriveRefs(source),
  };
}

function buildCompressOperation(source: AutoExecutionTreeSource): ExecutionTreeOperationV1 {
  return {
    operation_id: operationId(source, "compress"),
    tree_id: source.tree.tree_id,
    scope: source.tree.scope,
    actor_role: operationActorRole(source),
    at: operationAt(source),
    type: "compress",
    title: firstString(source.title, "Execution progress"),
    summary: deriveObservation(source),
  };
}

function buildMaintainOperation(
  source: AutoExecutionTreeSource,
  outcome: "passed" | "failed",
): ExecutionTreeOperationV1 {
  return {
    operation_id: operationId(source, "maintain"),
    tree_id: source.tree.tree_id,
    scope: source.tree.scope,
    actor_role: operationActorRole(source),
    at: operationAt(source),
    type: "maintain",
    passed: outcome === "passed",
    target_summary_node_id: source.tree.current_summary_node_id,
    diagnostic_note: outcome === "failed" ? deriveObservation(source) : null,
  };
}

function buildReviseOperation(source: AutoExecutionTreeSource): ExecutionTreeOperationV1 {
  return {
    operation_id: operationId(source, "revise"),
    tree_id: source.tree.tree_id,
    scope: source.tree.scope,
    actor_role: operationActorRole(source),
    at: operationAt(source),
    type: "revise",
    target_summary_node_id: source.tree.current_summary_node_id,
    diagnostic_note: deriveObservation(source),
  };
}

function resolveSource(args: {
  slots: Record<string, unknown> | null;
  tree?: ExecutionTreeV1 | null;
  title?: string | null;
  textSummary?: string | null;
}): AutoExecutionTreeSource | null {
  const slots = args.slots ?? {};
  if (isExecutionTreeDefaultDisabled(slots)) return null;
  if (hasExplicitTreeOperations(slots)) return null;
  const explicitTree = args.tree ?? parseExecutionTree(slots.execution_tree_v1);
  const state = parseExecutionState(slots.execution_state_v1);
  const packet = parseExecutionPacket(slots.execution_packet_v1) ?? (state ? buildExecutionPacketV1({ state }) : null);
  if (!hasAutoContinuitySignal({ state, packet, slots })) return null;
  const tree = explicitTree ?? (state ? createExecutionTreeFromExecutionStateV1(state) : null);
  if (!tree) return null;
  return {
    tree,
    state,
    packet,
    slots,
    title: args.title,
    textSummary: args.textSummary,
  };
}

export function applyAutoExecutionTreeFromSlots(args: {
  executionTreeStore?: ExecutionTreeStore | null;
  slots: Record<string, unknown> | null;
  title?: string | null;
  textSummary?: string | null;
}): AutoExecutionTreeApplyResult | null {
  if (!args.executionTreeStore) return null;
  const source = resolveSource({
    slots: args.slots,
    title: args.title,
    textSummary: args.textSummary,
  });
  if (!source) return null;

  let stored = args.executionTreeStore.get(source.tree.scope, source.tree.tree_id);
  if (!stored) {
    stored = args.executionTreeStore.put(source.tree);
  }

  const applied: ExecutionTreeOperationV1[] = [];
  const apply = (operation: ExecutionTreeOperationV1) => {
    stored = args.executionTreeStore!.applyOperation(operation);
    applied.push(operation);
    source.tree = stored.tree;
  };

  apply(buildGrowOperation(source));

  if (hasCompressionSignal(source)) {
    apply(buildCompressOperation(source));
    const outcome = deriveOutcome(source);
    if (outcome) {
      apply(buildMaintainOperation(source, outcome));
      if (outcome === "failed" && source.tree.current_summary_node_id !== source.tree.root_summary_node_id) {
        apply(buildReviseOperation(source));
      }
    }
  }

  return {
    tree: stored.tree,
    operations: applied,
  };
}
