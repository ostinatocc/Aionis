import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import { ExecutionNativeV1Schema, MemoryAbstractionBoundaryV1Schema, MemoryAnchorV1Schema } from "./schemas.js";
import { deriveExecutionContractFromSlots } from "./execution-contract.js";
import { buildRuntimeSignalLedgerFromSlots } from "./runtime-signal-ledger.js";
import { runtimeAuthorityEvidenceRefsFromSlots } from "./authority-visibility.js";

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
    const record = asRecord(entry);
    const next = firstString(
      entry,
      record?.ref,
      record?.uri,
      record?.raw_ref,
      record?.evidence_ref,
      record?.node_id,
      record?.id,
    );
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueStringList(values: Array<string | null | undefined>, limit = 64): string[] {
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

function collectStringListFromRecords(records: Array<Record<string, unknown> | null>, keys: string[], limit = 64): string[] {
  const out: string[] = [];
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      out.push(...stringList(value, limit));
      const single = firstString(value);
      if (single) out.push(single);
    }
  }
  return uniqueStringList(out, limit);
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

function sourceRefsFromAnchor(anchor: ReturnType<typeof MemoryAnchorV1Schema.parse>): string[] {
  return uniqueStringList([
    anchor.source.node_id ?? null,
    anchor.source.decision_id ?? null,
    anchor.source.run_id ?? null,
    anchor.source.step_id ?? null,
    anchor.source.playbook_id ?? null,
    anchor.source.commit_id ?? null,
    ...anchor.payload_refs.node_ids,
    ...anchor.payload_refs.decision_ids,
    ...anchor.payload_refs.run_ids,
    ...anchor.payload_refs.step_ids,
    ...anchor.payload_refs.commit_ids,
  ], 128);
}

function collectSourceEpisodeRefs(args: {
  slots: Record<string, unknown>;
  executionNative: Record<string, unknown> | null;
  anchor: ReturnType<typeof MemoryAnchorV1Schema.parse> | null;
  rawRef?: string | null;
  evidenceRef?: string | null;
}): string[] {
  const distillation = asRecord(args.executionNative?.distillation) ?? asRecord(args.slots.distillation);
  const executionEvidence = asRecord(args.slots.execution_evidence_v1);
  const executionContract = asRecord(args.slots.execution_contract_v1);
  const provenance = asRecord(executionContract?.provenance);
  const ledger = asRecord(args.slots.promotion_evidence_ledger_v1) ?? asRecord(args.executionNative?.promotion_evidence_ledger_v1);
  return uniqueStringList([
    args.rawRef ?? null,
    args.evidenceRef ?? null,
    ...stringList(args.slots.source_episode_refs, 128),
    ...stringList(args.slots.source_event_refs, 128),
    ...stringList(args.slots.source_node_refs, 128),
    ...stringList(args.slots.source_refs, 128),
    firstString(args.slots.source_node_id),
    firstString(args.slots.source_evidence_node_id),
    firstString(args.slots.source_client_id),
    firstString(args.slots.source_sha256) ? `source_sha256:${firstString(args.slots.source_sha256)}` : null,
    firstString(distillation?.source_node_id),
    firstString(distillation?.source_evidence_node_id),
    ...stringList(provenance?.evidence_refs, 128),
    ...stringList(executionEvidence?.evidence_refs, 128),
    ...stringList(executionEvidence?.artifact_refs, 128),
    ...runtimeAuthorityEvidenceRefsFromSlots(args.slots),
    ...stringList(ledger?.promotion_evidence_refs, 128),
    ...(args.anchor ? sourceRefsFromAnchor(args.anchor) : []),
  ], 128);
}

function abstractionKindFrom(args: {
  type: string;
  summaryKind: string | null;
  executionNative: Record<string, unknown> | null;
  anchor: ReturnType<typeof MemoryAnchorV1Schema.parse> | null;
}): "workflow" | "pattern" | "policy" | "distillation" | "execution_native" | "unknown" {
  if (args.anchor?.anchor_kind === "workflow") return "workflow";
  if (args.anchor?.anchor_kind === "pattern") return "pattern";
  const executionKind = firstString(args.executionNative?.execution_kind);
  const summaryKind = (args.summaryKind ?? firstString(args.executionNative?.summary_kind) ?? "").toLowerCase();
  if (executionKind === "workflow_anchor" || executionKind === "workflow_candidate" || summaryKind.includes("workflow")) return "workflow";
  if (executionKind === "pattern_anchor" || summaryKind.includes("pattern")) return "pattern";
  if (summaryKind.includes("policy") || args.type === "rule") return "policy";
  if (executionKind === "distilled_evidence" || executionKind === "distilled_fact" || summaryKind.includes("distillation")) return "distillation";
  if (executionKind || args.summaryKind) return "execution_native";
  return "unknown";
}

function shouldAttachAbstractionBoundary(args: {
  abstractionKind: "workflow" | "pattern" | "policy" | "distillation" | "execution_native" | "unknown";
  slots: Record<string, unknown>;
  executionNative: Record<string, unknown> | null;
}) {
  if (args.abstractionKind !== "unknown" && args.abstractionKind !== "execution_native") return true;
  if (args.executionNative) return true;
  return stringList(args.slots.applies_when).length > 0
    || stringList(args.slots.does_not_apply_when).length > 0
    || stringList(args.slots.counterexamples).length > 0
    || stringList(args.slots.source_episode_refs).length > 0;
}

function buildAbstractionBoundary(args: {
  type: string;
  slots: Record<string, unknown>;
  title?: string | null;
  textSummary?: string | null;
  executionNative: Record<string, unknown> | null;
  anchor: ReturnType<typeof MemoryAnchorV1Schema.parse> | null;
  rawRef?: string | null;
  evidenceRef?: string | null;
}) {
  const summaryKind = firstString(args.slots.summary_kind, args.executionNative?.summary_kind);
  const executionContract = asRecord(args.slots.execution_contract_v1);
  const abstractionKind = abstractionKindFrom({
    type: args.type,
    summaryKind,
    executionNative: args.executionNative,
    anchor: args.anchor,
  });
  if (!shouldAttachAbstractionBoundary({ abstractionKind, slots: args.slots, executionNative: args.executionNative })) return null;

  const promotion = asRecord(args.executionNative?.promotion) ?? asRecord(args.slots.promotion);
  const workflowPromotion = asRecord(args.executionNative?.workflow_promotion) ?? asRecord(args.slots.workflow_promotion);
  const policyEvolution = asRecord(args.executionNative?.policy_evolution) ?? asRecord(args.slots.policy_evolution);
  const distillation = asRecord(args.executionNative?.distillation) ?? asRecord(args.slots.distillation);
  const ledger = asRecord(args.slots.promotion_evidence_ledger_v1) ?? asRecord(args.executionNative?.promotion_evidence_ledger_v1);
  const anchor = args.anchor;

  const appliesWhen = uniqueStringList([
    ...stringList(args.slots.applies_when),
    ...stringList(args.slots.applicable_when),
    ...stringList(args.slots.activation_conditions),
    ...stringList(args.executionNative?.workflow_steps),
    ...stringList(args.executionNative?.pattern_hints),
    ...(anchor?.key_steps ?? []),
    ...(anchor?.pattern_hints ?? []),
    ...(anchor?.rehydration?.recommended_when ?? []),
    firstString(args.executionNative?.task_signature, executionContract?.task_signature, anchor?.task_signature)
      ? `task_signature=${firstString(args.executionNative?.task_signature, executionContract?.task_signature, anchor?.task_signature)}`
      : null,
    firstString(args.executionNative?.task_family, executionContract?.task_family, anchor?.task_family)
      ? `task_family=${firstString(args.executionNative?.task_family, executionContract?.task_family, anchor?.task_family)}`
      : null,
    firstString(args.executionNative?.workflow_signature, executionContract?.workflow_signature, anchor?.workflow_signature)
      ? `workflow_signature=${firstString(args.executionNative?.workflow_signature, executionContract?.workflow_signature, anchor?.workflow_signature)}`
      : null,
    firstString(args.executionNative?.pattern_signature, anchor?.pattern_signature)
      ? `pattern_signature=${firstString(args.executionNative?.pattern_signature, anchor?.pattern_signature)}`
      : null,
    firstString(args.executionNative?.error_signature, executionContract?.error_signature, anchor?.error_signature)
      ? `error_signature=${firstString(args.executionNative?.error_signature, executionContract?.error_signature, anchor?.error_signature)}`
      : null,
    firstString(args.executionNative?.file_path, executionContract?.file_path, anchor?.file_path)
      ? `file_path=${firstString(args.executionNative?.file_path, executionContract?.file_path, anchor?.file_path)}`
      : null,
    ...stringList(args.executionNative?.target_files).map((file) => `target_file=${file}`),
    ...(anchor?.target_files ?? []).map((file) => `target_file=${file}`),
  ], 64);

  const doesNotApplyWhen = uniqueStringList([
    ...stringList(args.slots.does_not_apply_when),
    ...stringList(args.slots.not_applicable_when),
    ...stringList(args.slots.exceptions),
    ...stringList(args.slots.negative_conditions),
    ...stringList(args.slots.blocked_conditions),
    ...collectStringListFromRecords([executionContract], ["rejected_paths", "rollback_notes", "unresolved_blockers"], 32),
  ], 64);

  const negativeEvidenceClaims = Array.isArray(ledger?.evidence)
    ? ledger.evidence
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => !!entry && entry.polarity === "negative")
        .map((entry) => firstString(entry.claim, entry.source_ref))
        .filter((entry): entry is string => !!entry)
    : [];
  const counterEvidenceCount = Number(promotion?.counter_evidence_count ?? 0);
  const counterEvidenceOpen = promotion?.counter_evidence_open === true;
  const counterexamples = uniqueStringList([
    ...stringList(args.slots.counterexamples),
    ...stringList(args.slots.counter_evidence),
    ...stringList(args.slots.counter_evidence_refs),
    ...stringList(args.slots.counterexample_refs),
    ...negativeEvidenceClaims,
    counterEvidenceOpen || counterEvidenceCount > 0 ? `counter_evidence_count=${Math.max(0, counterEvidenceCount)}` : null,
  ], 64);

  const promotionState = firstString(
    workflowPromotion?.promotion_state,
    promotion?.credibility_state,
    policyEvolution?.policy_memory_state,
    policyEvolution?.policy_state,
    distillation?.abstraction_state,
    ledger?.promotion_state,
  );
  const promotionReason = firstString(
    args.slots.promotion_reason,
    args.slots.admission_reason,
    workflowPromotion?.last_transition,
    promotion?.last_transition,
    policyEvolution?.last_transition,
    distillation?.last_transition,
    Array.isArray(ledger?.reason_codes) ? ledger.reason_codes.join(",") : null,
    distillation?.source_kind ? `distilled_from_${distillation.source_kind}` : null,
    summaryKind ? `summary_kind=${summaryKind}` : null,
  );
  const sourceEpisodeRefs = collectSourceEpisodeRefs({
    slots: args.slots,
    executionNative: args.executionNative,
    anchor,
    rawRef: args.rawRef,
    evidenceRef: args.evidenceRef,
  });
  const sourceEvidenceRefs = uniqueStringList([
    args.rawRef ?? null,
    args.evidenceRef ?? null,
    ...stringList(args.slots.source_evidence_refs, 128),
    ...stringList(args.slots.evidence_refs, 128),
    ...stringList(args.slots.artifact_refs, 128),
    ...stringList(asRecord(args.slots.execution_evidence_v1)?.evidence_refs, 128),
    ...stringList(asRecord(args.slots.execution_evidence_v1)?.artifact_refs, 128),
    ...runtimeAuthorityEvidenceRefsFromSlots(args.slots),
  ], 128);

  return MemoryAbstractionBoundaryV1Schema.parse({
    boundary_version: "abstraction_boundary_v1",
    abstraction_kind: abstractionKind,
    applies_when: appliesWhen,
    does_not_apply_when: doesNotApplyWhen,
    counterexamples,
    source_episode_refs: sourceEpisodeRefs,
    promotion_reason: promotionReason,
    promotion_state: promotionState,
    source_evidence_refs: sourceEvidenceRefs,
    gate_contract: "raw_episode_first_bounded_abstraction",
  });
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
  refs?: { raw_ref?: string | null; evidence_ref?: string | null },
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
  const parsedExecutionNative = asRecord(out.execution_native_v1);
  const abstractionBoundary = buildAbstractionBoundary({
    type,
    slots: out,
    title,
    textSummary,
    executionNative: parsedExecutionNative,
    anchor: anchorParsed.success ? anchorParsed.data : null,
    rawRef: refs?.raw_ref ?? null,
    evidenceRef: refs?.evidence_ref ?? null,
  });
  if (abstractionBoundary) {
    out.abstraction_boundary_v1 = abstractionBoundary;
    out.applies_when = abstractionBoundary.applies_when;
    out.does_not_apply_when = abstractionBoundary.does_not_apply_when;
    out.counterexamples = abstractionBoundary.counterexamples;
    out.source_episode_refs = abstractionBoundary.source_episode_refs;
    out.promotion_reason = abstractionBoundary.promotion_reason;
    out.promotion_state = abstractionBoundary.promotion_state;
    out.source_evidence_refs = abstractionBoundary.source_evidence_refs;
    if (parsedExecutionNative) {
      out.execution_native_v1 = ExecutionNativeV1Schema.parse({
        ...parsedExecutionNative,
        abstraction_boundary_v1: abstractionBoundary,
      });
    }
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
