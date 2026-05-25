import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import { ExecutionNativeV1Schema, MemoryAnchorV1Schema } from "./schemas.js";
import { deriveExecutionContractFromSlots } from "./execution-contract.js";
import { buildRuntimeSignalLedgerFromSlots } from "./runtime-signal-ledger.js";

type WriteLifecycleNode = {
  type: string;
  tier?: "hot" | "warm" | "cold" | "archive";
  title?: string;
  text_summary?: string;
  slots: Record<string, unknown>;
  raw_ref?: string;
  evidence_ref?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
};

export function restoreStableSystemSlots(
  original: Record<string, unknown>,
  redacted: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...redacted };
  for (const key of ["summary_kind", "handoff_kind", "task_kind", "task_family", "anchor", "file_path", "repo_root", "symbol"]) {
    if (key in original) out[key] = original[key];
  }
  return out;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function firstContractTrust(...values: unknown[]): "authoritative" | "advisory" | "observational" | null {
  for (const value of values) {
    if (value === "authoritative" || value === "advisory" || value === "observational") return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

function serviceLifecycleList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .slice(0, 16);
}

function readTrajectoryCompileSummary(value: unknown): Record<string, unknown> | null {
  const summary = asRecord(value);
  return asRecord(summary?.trajectory_compile_v1);
}

function normalizeExecutionNativeSignatureLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractCompactExecutionSignatureValue(value: string | null | undefined): string | null {
  const normalized = firstString(value);
  if (!normalized) return null;
  const compact = normalized.match(/^([A-Za-z0-9._:/-]{1,256})(?:\s+.*)?$/);
  return compact?.[1] ?? normalized;
}

function deriveExecutionContractProvenance(args: {
  summaryKind: string | null;
  systemKind: string | null;
  hasAnchor: boolean;
  slots: Record<string, unknown>;
}) {
  const sourceAnchor = firstString(args.slots.anchor, args.slots.file_path);
  if (args.hasAnchor) {
    return {
      source_kind: "slot_projection" as const,
      source_anchor: sourceAnchor,
      notes: ["write_execution_native:anchor_normalization"],
    };
  }
  if (args.summaryKind === "write_distillation_fact" || args.summaryKind === "write_distillation_evidence") {
    return {
      source_kind: "write_distillation" as const,
      source_anchor: sourceAnchor,
      source_summary_version: "write_distillation_v1",
      notes: [`write_execution_native:${args.summaryKind}`],
    };
  }
  if (args.summaryKind === "handoff" || args.systemKind === "session_event" || args.systemKind === "session") {
    return {
      source_kind: "slot_projection" as const,
      source_anchor: sourceAnchor,
      notes: [`write_execution_native:${args.summaryKind ?? args.systemKind ?? "continuity_carrier"}`],
    };
  }
  return {
    source_kind: "slot_projection" as const,
    source_anchor: sourceAnchor,
    notes: ["write_execution_native:slot_normalization"],
  };
}

export function normalizeExecutionNativeSlots(
  type: string,
  slots: Record<string, unknown>,
  title?: string | null,
  textSummary?: string | null,
): Record<string, unknown> {
  const out = { ...slots };
  const existingExecutionNative = out.execution_native_v1;
  const existingParsed = ExecutionNativeV1Schema.safeParse(existingExecutionNative);
  const anchorParsed = MemoryAnchorV1Schema.safeParse(out.anchor_v1);
  const summaryKind = firstString(out.summary_kind);
  const systemKind = firstString(out.system_kind);
  const rawCompressionLayer = firstString(out.compression_layer);
  const compressionLayer =
    rawCompressionLayer === "L0" || rawCompressionLayer === "L1" || rawCompressionLayer === "L2"
      || rawCompressionLayer === "L3" || rawCompressionLayer === "L4" || rawCompressionLayer === "L5"
      ? rawCompressionLayer
      : anchorParsed.success
        ? anchorParsed.data.anchor_level
        : undefined;

  let executionNative: Record<string, unknown> | null = existingParsed.success ? { ...existingParsed.data } : null;
  if (anchorParsed.success) {
    const anchor = anchorParsed.data;
    const workflowPromotionState = firstString(anchor.workflow_promotion?.promotion_state);
    const executionKind =
      anchor.anchor_kind === "workflow"
        ? workflowPromotionState === "candidate"
          ? "workflow_candidate"
          : "workflow_anchor"
        : anchor.anchor_kind === "pattern"
          ? "pattern_anchor"
          : "execution_native";
    executionNative = {
      ...(executionNative ?? {}),
      schema_version: "execution_native_v1",
      execution_kind: executionKind,
      summary_kind:
        summaryKind
        ?? (executionKind === "workflow_anchor"
          ? "workflow_anchor"
          : executionKind === "workflow_candidate"
            ? "workflow_candidate"
          : executionKind === "pattern_anchor"
            ? "pattern_anchor"
            : null),
      compression_layer: compressionLayer,
      ...(firstContractTrust(anchor.contract_trust) ? { contract_trust: firstContractTrust(anchor.contract_trust) } : {}),
      task_signature: anchor.task_signature,
      ...(anchor.error_signature ? { error_signature: anchor.error_signature } : {}),
      ...(anchor.workflow_signature ? { workflow_signature: anchor.workflow_signature } : {}),
      ...(anchor.pattern_signature ? { pattern_signature: anchor.pattern_signature } : {}),
      anchor_kind: anchor.anchor_kind,
      anchor_level: anchor.anchor_level,
      tool_set: anchor.tool_set,
      ...(anchor.file_path !== undefined ? { file_path: anchor.file_path } : {}),
      ...(anchor.target_files ? { target_files: anchor.target_files } : {}),
      ...(anchor.next_action !== undefined ? { next_action: anchor.next_action } : {}),
      ...(anchor.key_steps ? { workflow_steps: anchor.key_steps } : {}),
      ...(anchor.pattern_hints ? { pattern_hints: anchor.pattern_hints } : {}),
      ...(anchor.service_lifecycle_constraints ? { service_lifecycle_constraints: anchor.service_lifecycle_constraints } : {}),
      ...(anchor.pattern_state ? { pattern_state: anchor.pattern_state } : {}),
      ...(anchor.credibility_state ? { credibility_state: anchor.credibility_state } : {}),
      ...(anchor.selected_tool !== undefined ? { selected_tool: anchor.selected_tool } : {}),
      ...(anchor.workflow_promotion ? { workflow_promotion: anchor.workflow_promotion } : {}),
      ...(anchor.promotion ? { promotion: anchor.promotion } : {}),
      ...(anchor.maintenance ? { maintenance: anchor.maintenance } : {}),
      ...(anchor.rehydration ? { rehydration: anchor.rehydration } : {}),
    };
  } else if (summaryKind === "write_distillation_evidence" || summaryKind === "write_distillation_fact") {
    const normalizedTitle = normalizeExecutionNativeSignatureLabel(title ?? null);
    const signatureValue = extractCompactExecutionSignatureValue(textSummary);
    const derivedFactSignatures =
      summaryKind === "write_distillation_fact" && signatureValue
        ? {
            ...(normalizedTitle === "task signature" ? { task_signature: signatureValue } : {}),
            ...(normalizedTitle === "error signature" ? { error_signature: signatureValue } : {}),
            ...(normalizedTitle === "workflow signature" ? { workflow_signature: signatureValue } : {}),
          }
        : {};
    executionNative = {
      ...(executionNative ?? {}),
      schema_version: "execution_native_v1",
      execution_kind: summaryKind === "write_distillation_evidence" ? "distilled_evidence" : "distilled_fact",
      summary_kind: summaryKind,
      compression_layer: compressionLayer ?? "L1",
      ...derivedFactSignatures,
    };
  } else if (summaryKind === "handoff" || systemKind === "session_event" || systemKind === "session") {
    const executionState = asRecord(out.execution_state_v1);
    const executionPacket = asRecord(out.execution_packet_v1);
    const trajectoryCompileSummary = readTrajectoryCompileSummary(out.execution_result_summary);
    const resumeAnchor = asRecord(executionState?.resume_anchor) ?? asRecord(executionPacket?.resume_anchor);
    const targetFiles = stringList(
      [
        ...stringList(out.target_files, 24),
        ...stringList(executionPacket?.target_files, 24),
        ...stringList(executionState?.owned_files, 24),
        ...stringList(executionState?.modified_files, 24),
      ],
      24,
    );
    const filePath = firstString(out.file_path, resumeAnchor?.file_path, targetFiles[0] ?? null);
    const nextAction = firstString(out.next_action, executionPacket?.next_action, out.handoff_text);
    const contractTrust = firstContractTrust(out.contract_trust, executionPacket?.contract_trust, executionState?.contract_trust);
    const taskFamily = firstString(out.task_family, out.task_kind, trajectoryCompileSummary?.task_family);
    const taskSignature = firstString(out.task_signature, trajectoryCompileSummary?.task_signature);
    const workflowSignature = firstString(out.workflow_signature, trajectoryCompileSummary?.workflow_signature);
    const patternHints = stringList(out.pattern_hints, 24);
    const workflowSteps = stringList(out.workflow_steps, 24);
    const serviceLifecycleConstraints = serviceLifecycleList(
      out.service_lifecycle_constraints ?? executionPacket?.service_lifecycle_constraints ?? executionState?.service_lifecycle_constraints,
    );
    executionNative = {
      ...(executionNative ?? {}),
      schema_version: "execution_native_v1",
      execution_kind: "execution_native",
      summary_kind: summaryKind ?? systemKind,
      compression_layer: compressionLayer ?? "L0",
      ...(contractTrust ? { contract_trust: contractTrust } : {}),
      ...(taskFamily ? { task_family: taskFamily } : {}),
      ...(taskSignature ? { task_signature: taskSignature } : {}),
      ...(workflowSignature ? { workflow_signature: workflowSignature } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      ...(targetFiles.length > 0 ? { target_files: targetFiles } : {}),
      ...(nextAction ? { next_action: nextAction } : {}),
      ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
      ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
      ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    };
  } else if (existingParsed.success) {
    executionNative = {
      ...existingParsed.data,
      ...(compressionLayer ? { compression_layer: compressionLayer } : {}),
      ...(summaryKind ? { summary_kind: summaryKind } : {}),
    };
  }

  if (executionNative) {
    const parsed = ExecutionNativeV1Schema.parse(executionNative);
    out.execution_native_v1 = parsed;
    if (!out.summary_kind && parsed.summary_kind) out.summary_kind = parsed.summary_kind;
    if (!out.compression_layer && parsed.compression_layer) out.compression_layer = parsed.compression_layer;
  }
  const normalizedExecutionContract = deriveExecutionContractFromSlots({
    slots: out,
    provenance: deriveExecutionContractProvenance({
      summaryKind,
      systemKind,
      hasAnchor: anchorParsed.success,
      slots: out,
    }),
  });
  if (normalizedExecutionContract) {
    out.execution_contract_v1 = normalizedExecutionContract;
  }
  const runtimeSignalLedger = buildRuntimeSignalLedgerFromSlots({ slots: out });
  if (runtimeSignalLedger) {
    out.runtime_signal_ledger_v1 = runtimeSignalLedger;
  }
  return out;
}

export function enrichPreparedNodeLifecycle<T extends WriteLifecycleNode>(node: T): T {
  const lifecycle = resolveNodeLifecycleSignals({
    type: node.type,
    tier: node.tier ?? "hot",
    title: node.title ?? null,
    text_summary: node.text_summary ?? null,
    slots: node.slots ?? {},
    salience: node.salience ?? null,
    importance: node.importance ?? null,
    confidence: node.confidence ?? null,
    raw_ref: node.raw_ref ?? null,
    evidence_ref: node.evidence_ref ?? null,
  });
  return {
    ...node,
    slots: lifecycle.slots,
    salience: lifecycle.salience,
    importance: lifecycle.importance,
    confidence: lifecycle.confidence,
  };
}
