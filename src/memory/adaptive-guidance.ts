import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import {
  ServiceLifecycleConstraintV1Schema,
  type ServiceLifecycleConstraintV1,
} from "../execution/types.js";
import { parseExecutionContract } from "./execution-contract.js";
import {
  AdaptiveGuidanceOverlayV1Schema,
  type AdaptiveGuidanceCandidateV1,
  type AdaptiveGuidanceDecompositionV1,
  type AdaptiveGuidanceInstructionV1,
  type AdaptiveGuidanceOverlayV1,
  type AdaptiveGuidanceSourceKind,
  type ActionRetrievalUncertainty,
  type ExecutionMemoryIntrospectionResponse,
  type ExperienceIntelligenceInput,
} from "./schemas.js";

type CandidateSource = {
  sourceKind: AdaptiveGuidanceSourceKind;
  record: Record<string, unknown>;
};

type ScoredCandidate = AdaptiveGuidanceCandidateV1 & {
  internal_overlap_count: number;
  internal_tool_aligned: boolean;
  internal_file_aligned: boolean;
  internal_family_aligned: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Number(value.toFixed(4));
}

function uniqueStrings(values: unknown[], limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown) => {
    if (out.length >= limit) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (record) {
      visit(record.id);
      visit(record.node_id);
      visit(record.anchor_id);
      visit(record.evidence_ref);
      visit(record.ref);
      visit(record.uri);
      return;
    }
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };
  for (const value of values) visit(value);
  return out;
}

function stringList(value: unknown, limit = 64): string[] {
  return Array.isArray(value) ? uniqueStrings(value, limit) : [];
}

function normalizeLifecycleConstraints(value: unknown, limit = 16): ServiceLifecycleConstraintV1[] {
  if (!Array.isArray(value)) return [];
  const out: ServiceLifecycleConstraintV1[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = ServiceLifecycleConstraintV1Schema.safeParse(entry);
    if (!parsed.success) continue;
    const key = [
      parsed.data.service_kind,
      parsed.data.label,
      parsed.data.endpoint ?? "",
      parsed.data.launch_reference ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= limit) break;
  }
  return out;
}

const GUIDANCE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "this",
  "that",
  "these",
  "those",
  "please",
  "make",
  "need",
  "needs",
  "use",
  "using",
]);

function tokenize(value: unknown, limit = 96): string[] {
  const text = typeof value === "string" ? value : "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    const normalized = token.trim();
    if (normalized.length < 2 || GUIDANCE_STOPWORDS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function collectContextFileHints(context: unknown): string[] {
  const record = asRecord(context) ?? {};
  const state = asRecord(record.execution_state_v1) ?? asRecord(record.execution_state) ?? {};
  const packet = asRecord(record.execution_packet_v1) ?? asRecord(record.execution_packet) ?? {};
  return uniqueStrings([
    record.file_path,
    record.target_file,
    record.target_files,
    record.modified_files,
    state.owned_files,
    state.modified_files,
    state.target_files,
    asRecord(state.resume_anchor)?.file_path,
    packet.target_files,
  ], 32);
}

function collectContextToolHints(context: unknown, candidates: string[]): string[] {
  const record = asRecord(context) ?? {};
  const contract = parseExecutionContract(record.execution_contract_v1);
  return uniqueStrings([
    record.selected_tool,
    record.likely_tool,
    contract?.selected_tool,
    candidates,
  ], 32);
}

function hashId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Hex(stableStringify(value)).slice(0, 24)}`;
}

function subtaskId(role: string, queryText: string, terms: string[]): string {
  return hashId(`adaptive-subtask-${role}`, { queryText, terms });
}

export function buildAdaptiveGuidanceDecomposition(args: {
  parsed: ExperienceIntelligenceInput;
}): AdaptiveGuidanceDecompositionV1 {
  const context = asRecord(args.parsed.context) ?? {};
  const queryTerms = tokenize(args.parsed.query_text, 96);
  const fileHints = collectContextFileHints(args.parsed.context);
  const toolHints = collectContextToolHints(args.parsed.context, args.parsed.candidates);
  const taskFamily = firstString(
    context.task_family,
    context.task_kind,
    parseExecutionContract(context.execution_contract_v1)?.task_family,
  );
  const subtasks = [
    {
      subtask_id: subtaskId("task_intent", args.parsed.query_text, queryTerms),
      role: "task_intent" as const,
      query_text: args.parsed.query_text,
      match_terms: queryTerms.slice(0, 32),
    },
    ...(toolHints.length > 0 ? [{
      subtask_id: subtaskId("tool_selection", args.parsed.query_text, toolHints),
      role: "tool_selection" as const,
      query_text: `Select execution route for ${toolHints.join(" ")}`,
      match_terms: toolHints.slice(0, 32),
    }] : []),
    ...(fileHints.length > 0 ? [{
      subtask_id: subtaskId("file_focus", args.parsed.query_text, fileHints),
      role: "file_focus" as const,
      query_text: `Focus on ${fileHints.join(" ")}`,
      match_terms: fileHints.slice(0, 32),
    }] : []),
    ...(/[._-]?(test|verify|validation|lint|typecheck|build|acceptance)[._-]?/i.test(args.parsed.query_text)
      || stringList(context.acceptance_checks, 24).length > 0
      ? [{
          subtask_id: subtaskId("verification", args.parsed.query_text, ["verification", ...stringList(context.acceptance_checks, 24)]),
          role: "verification" as const,
          query_text: "Preserve verification and acceptance checks",
          match_terms: uniqueStrings(["verification", "test", "lint", "typecheck", context.acceptance_checks], 32),
        }]
      : []),
    ...(args.parsed.execution_state_v1 || context.execution_state_v1 || context.recovery_contract_v1
      ? [{
          subtask_id: subtaskId("continuity", args.parsed.query_text, ["continuity", "recovery", "resume"]),
          role: "continuity" as const,
          query_text: "Recover prior execution state before acting",
          match_terms: ["continuity", "recovery", "resume"],
        }]
      : []),
  ].slice(0, 8);

  return {
    summary_version: "adaptive_guidance_decomposition_v1",
    query_text: args.parsed.query_text,
    task_family: taskFamily,
    query_terms: queryTerms,
    file_hints: fileHints,
    tool_hints: toolHints,
    subtasks,
  };
}

function sourceRecords(introspection: ExecutionMemoryIntrospectionResponse): CandidateSource[] {
  const out: CandidateSource[] = [];
  const pushMany = (sourceKind: AdaptiveGuidanceSourceKind, values: unknown[]) => {
    for (const value of values) {
      const record = asRecord(value);
      if (!record) continue;
      out.push({ sourceKind, record });
    }
  };
  pushMany("stable_workflow", introspection.recommended_workflows);
  pushMany("candidate_workflow", introspection.candidate_workflows);
  pushMany("trusted_pattern", introspection.trusted_patterns);
  pushMany("contested_pattern", introspection.contested_patterns);
  for (const value of introspection.supporting_knowledge) {
    const record = asRecord(value);
    if (!record) continue;
    const kind = firstString(record.kind, record.summary_kind, record.execution_kind);
    out.push({
      sourceKind:
        kind === "continuity_carrier" || kind === "handoff" || kind === "session_event" || kind === "session"
          ? "continuity_carrier"
          : "supporting_knowledge",
      record,
    });
  }
  return out;
}

function defaultConfidence(sourceKind: AdaptiveGuidanceSourceKind): number {
  if (sourceKind === "stable_workflow") return 0.72;
  if (sourceKind === "trusted_pattern") return 0.68;
  if (sourceKind === "candidate_workflow") return 0.5;
  if (sourceKind === "continuity_carrier") return 0.46;
  if (sourceKind === "supporting_knowledge") return 0.38;
  return 0.22;
}

function promotionBlockers(sourceKind: AdaptiveGuidanceSourceKind): string[] {
  const base = [
    "requires_runtime_signal_attribution",
    "requires_learning_control_gate",
    "requires_repeated_outcome_evidence",
  ];
  if (sourceKind === "contested_pattern") return ["contested_source", "requires_counter_evidence_review", ...base];
  if (sourceKind === "supporting_knowledge") return ["supporting_knowledge_is_not_policy", ...base];
  if (sourceKind === "continuity_carrier") return ["continuity_carrier_is_not_policy", ...base];
  return base;
}

function candidateFromSource(source: CandidateSource): AdaptiveGuidanceCandidateV1 | null {
  const record = source.record;
  const contract = parseExecutionContract(record.execution_contract_v1);
  const anchorId = firstString(
    record.anchor_id,
    record.node_id,
    record.id,
    contract?.provenance.source_anchor,
  );
  const targetFiles = uniqueStrings([
    contract?.target_files,
    record.target_files,
    record.modified_files,
    record.file_path,
  ], 32);
  const selectedTool = firstString(contract?.selected_tool, record.selected_tool, record.tool, record.likely_tool);
  const filePath = firstString(contract?.file_path, record.file_path, targetFiles[0] ?? null);
  const nextAction = firstString(contract?.next_action, record.next_action, record.recommended_next_action, record.summary);
  const workflowSteps = uniqueStrings([
    contract?.workflow_steps,
    record.workflow_steps,
    record.steps,
  ], 32);
  const patternHints = uniqueStrings([
    contract?.pattern_hints,
    record.pattern_hints,
    record.hints,
  ], 32);
  const title = firstString(record.title, record.name);
  const summary = firstString(record.summary, record.text_summary, record.description, nextAction);
  if (!selectedTool && !filePath && targetFiles.length === 0 && !nextAction && workflowSteps.length === 0 && !summary) {
    return null;
  }
  const confidence = clamp01(
    numeric(record.confidence)
    ?? numeric(record.score)
    ?? numeric(record.feedback_quality)
    ?? defaultConfidence(source.sourceKind),
  );
  return {
    summary_version: "adaptive_guidance_candidate_v1",
    candidate_id: hashId("adaptive-guidance-candidate", {
      sourceKind: source.sourceKind,
      anchorId,
      selectedTool,
      filePath,
      nextAction,
      workflowSignature: firstString(record.workflow_signature, contract?.workflow_signature),
    }),
    source_kind: source.sourceKind,
    source_anchor_id: anchorId,
    authority: "advisory_candidate",
    contract_trust: "observational",
    selected_tool: selectedTool,
    task_family: firstString(record.task_family, contract?.task_family),
    workflow_signature: firstString(record.workflow_signature, contract?.workflow_signature),
    title,
    summary,
    file_path: filePath,
    target_files: targetFiles,
    next_action: nextAction,
    workflow_steps: workflowSteps,
    pattern_hints: patternHints,
    service_lifecycle_constraints: normalizeLifecycleConstraints(
      contract?.service_lifecycle_constraints && contract.service_lifecycle_constraints.length > 0
        ? contract.service_lifecycle_constraints
        : record.service_lifecycle_constraints,
    ),
    evidence_refs: uniqueStrings([contract?.provenance.evidence_refs, record.evidence_refs, record.evidence_ref], 32),
    source_refs: uniqueStrings([anchorId, record.node_id, record.id, contract?.provenance.source_anchor], 32),
    confidence,
    score: 0,
    match_reasons: [],
    promotion_blockers: promotionBlockers(source.sourceKind),
    source_code_change_allowed: false,
  };
}

function candidateText(candidate: AdaptiveGuidanceCandidateV1): string {
  return [
    candidate.selected_tool,
    candidate.task_family,
    candidate.workflow_signature,
    candidate.title,
    candidate.summary,
    candidate.file_path,
    ...candidate.target_files,
    candidate.next_action,
    ...candidate.workflow_steps,
    ...candidate.pattern_hints,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
}

function scoreCandidate(args: {
  candidate: AdaptiveGuidanceCandidateV1;
  decomposition: AdaptiveGuidanceDecompositionV1;
  selectedTool?: string | null;
  selectedFilePath?: string | null;
  stablePathAnchorId?: string | null;
}): ScoredCandidate {
  const candidateTerms = new Set(tokenize(candidateText(args.candidate), 128));
  const queryTerms = args.decomposition.query_terms;
  const overlapTerms = queryTerms.filter((term) => candidateTerms.has(term));
  const fileHints = new Set(args.decomposition.file_hints);
  const candidateFiles = new Set([
    args.candidate.file_path,
    ...args.candidate.target_files,
  ].filter((value): value is string => !!value));
  const fileAligned =
    (args.selectedFilePath && candidateFiles.has(args.selectedFilePath))
    || [...candidateFiles].some((file) => fileHints.has(file) || [...fileHints].some((hint) => file.includes(hint) || hint.includes(file)));
  const toolAligned = !!args.selectedTool && args.candidate.selected_tool === args.selectedTool;
  const familyAligned =
    !!args.decomposition.task_family
    && !!args.candidate.task_family
    && args.decomposition.task_family === args.candidate.task_family;
  const sourceWeight =
    args.candidate.source_kind === "stable_workflow" ? 0.14
    : args.candidate.source_kind === "trusted_pattern" ? 0.12
    : args.candidate.source_kind === "candidate_workflow" ? 0.08
    : args.candidate.source_kind === "continuity_carrier" ? 0.06
    : args.candidate.source_kind === "supporting_knowledge" ? 0.03
    : -0.18;
  const sameStablePath = args.stablePathAnchorId && args.candidate.source_anchor_id === args.stablePathAnchorId;
  const score = clamp01(
    args.candidate.confidence * 0.42
    + Math.min(overlapTerms.length, 8) * 0.035
    + (toolAligned ? 0.18 : 0)
    + (fileAligned ? 0.14 : 0)
    + (familyAligned ? 0.08 : 0)
    + (sameStablePath ? 0.06 : 0)
    + sourceWeight,
  );
  const reasons = uniqueStrings([
    overlapTerms.length > 0 ? `query_overlap=${overlapTerms.slice(0, 8).join(",")}` : null,
    toolAligned ? `tool_aligned=${args.selectedTool}` : null,
    fileAligned ? "file_focus_aligned" : null,
    familyAligned ? `task_family_aligned=${args.decomposition.task_family}` : null,
    sameStablePath ? "stable_path_anchor_aligned" : null,
    `source=${args.candidate.source_kind}`,
  ], 16);
  return {
    ...args.candidate,
    score,
    match_reasons: reasons,
    internal_overlap_count: overlapTerms.length,
    internal_tool_aligned: toolAligned,
    internal_file_aligned: Boolean(fileAligned),
    internal_family_aligned: familyAligned,
  };
}

function selectCandidates(scored: ScoredCandidate[]): {
  selected: AdaptiveGuidanceCandidateV1[];
  skippedReasons: string[];
} {
  const sorted = [...scored].sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  const selected = sorted.filter((candidate) => {
    if (candidate.source_kind === "contested_pattern") return candidate.score >= 0.34;
    if (candidate.internal_tool_aligned || candidate.internal_file_aligned || candidate.internal_family_aligned) return candidate.score >= 0.24;
    return candidate.score >= 0.32 && candidate.internal_overlap_count > 0;
  }).slice(0, 5);
  const skippedReasons = uniqueStrings(sorted.slice(selected.length, selected.length + 12).map((candidate) => {
    if (candidate.source_kind === "contested_pattern") return `skipped_contested_candidate:${candidate.source_anchor_id ?? candidate.candidate_id}`;
    if (candidate.internal_overlap_count === 0 && !candidate.internal_tool_aligned && !candidate.internal_file_aligned) {
      return `skipped_low_task_match:${candidate.source_anchor_id ?? candidate.candidate_id}`;
    }
    return `skipped_lower_score:${candidate.source_anchor_id ?? candidate.candidate_id}`;
  }), 32);
  return {
    selected: selected.map(publicCandidate),
    skippedReasons,
  };
}

function publicCandidate(candidate: ScoredCandidate): AdaptiveGuidanceCandidateV1 {
  const {
    internal_overlap_count: _overlap,
    internal_tool_aligned: _toolAligned,
    internal_file_aligned: _fileAligned,
    internal_family_aligned: _familyAligned,
    ...publicFields
  } = candidate;
  return publicFields;
}

function instructionId(candidateId: string, priority: string, instruction: string): string {
  return hashId(`adaptive-guidance-instruction-${priority}`, { candidateId, instruction });
}

function buildInstructions(candidates: AdaptiveGuidanceCandidateV1[]): AdaptiveGuidanceInstructionV1[] {
  const out: AdaptiveGuidanceInstructionV1[] = [];
  for (const candidate of candidates) {
    const anchorIds = candidate.source_anchor_id ? [candidate.source_anchor_id] : [];
    const primaryText = firstString(
      candidate.next_action,
      candidate.workflow_steps[0],
      candidate.summary,
      candidate.title,
    );
    if (primaryText) {
      out.push({
        instruction_id: instructionId(candidate.candidate_id, "primary", primaryText),
        priority: candidate.source_kind === "contested_pattern" ? "verification" : "primary",
        instruction: candidate.source_kind === "contested_pattern"
          ? `Treat this prior signal as contested before acting: ${primaryText}`
          : primaryText,
        selected_tool: candidate.selected_tool,
        file_path: candidate.file_path,
        task_family: candidate.task_family,
        source_candidate_ids: [candidate.candidate_id],
        source_anchor_ids: anchorIds,
        evidence_refs: candidate.evidence_refs,
        contract_trust: "observational",
      });
    }
    if (candidate.target_files.length > 0 || candidate.file_path) {
      const files = uniqueStrings([candidate.file_path, candidate.target_files], 8);
      const instruction = `Inspect current state for ${files.join(", ")} before applying the recalled step.`;
      out.push({
        instruction_id: instructionId(candidate.candidate_id, "supporting", instruction),
        priority: "supporting",
        instruction,
        selected_tool: candidate.selected_tool,
        file_path: candidate.file_path,
        task_family: candidate.task_family,
        source_candidate_ids: [candidate.candidate_id],
        source_anchor_ids: anchorIds,
        evidence_refs: candidate.evidence_refs,
        contract_trust: "observational",
      });
    }
    if (candidate.pattern_hints.length > 0) {
      const instruction = `Carry forward observed pattern hints: ${candidate.pattern_hints.slice(0, 4).join("; ")}`;
      out.push({
        instruction_id: instructionId(candidate.candidate_id, "verification", instruction),
        priority: "verification",
        instruction,
        selected_tool: candidate.selected_tool,
        file_path: candidate.file_path,
        task_family: candidate.task_family,
        source_candidate_ids: [candidate.candidate_id],
        source_anchor_ids: anchorIds,
        evidence_refs: candidate.evidence_refs,
        contract_trust: "observational",
      });
    }
    if (out.length >= 16) break;
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    if (seen.has(entry.instruction)) return false;
    seen.add(entry.instruction);
    return true;
  }).slice(0, 16);
}

export function buildAdaptiveGuidanceOverlay(args: {
  parsed: ExperienceIntelligenceInput;
  introspection: ExecutionMemoryIntrospectionResponse;
  selectedTool?: string | null;
  selectedFilePath?: string | null;
  stablePathAnchorId?: string | null;
}): AdaptiveGuidanceOverlayV1 {
  const decomposition = buildAdaptiveGuidanceDecomposition({ parsed: args.parsed });
  const candidates = sourceRecords(args.introspection)
    .map(candidateFromSource)
    .filter((candidate): candidate is AdaptiveGuidanceCandidateV1 => candidate !== null);
  const scored = candidates.map((candidate) => scoreCandidate({
    candidate,
    decomposition,
    selectedTool: args.selectedTool,
    selectedFilePath: args.selectedFilePath,
    stablePathAnchorId: args.stablePathAnchorId,
  }));
  const selectedResult = selectCandidates(scored);
  const selected = selectedResult.selected;
  const instructions = buildInstructions(selected);
  const activationState =
    candidates.length === 0
      ? "empty"
      : selected.length > 0 && instructions.length > 0
        ? "active"
        : "blocked";
  const hasContestedSelection = selected.some((candidate) => candidate.source_kind === "contested_pattern");
  const recommendedActions = uniqueStrings([
    selected.length > 0 ? "inspect_context" : null,
    selected.length === 0 && candidates.length > 0 ? "widen_recall" : null,
    hasContestedSelection ? "request_operator_review" : null,
  ], 8).filter(
    (entry): entry is "widen_recall" | "inspect_context" | "request_operator_review" =>
      entry === "widen_recall" || entry === "inspect_context" || entry === "request_operator_review",
  );

  return AdaptiveGuidanceOverlayV1Schema.parse({
    summary_version: "adaptive_guidance_overlay_v1",
    activation_state: activationState,
    query_text: args.parsed.query_text,
    decomposition,
    candidate_count: candidates.length,
    selected_candidate_count: selected.length,
    skipped_candidate_count: Math.max(0, candidates.length - selected.length),
    skipped_reasons: selectedResult.skippedReasons,
    selected_candidates: selected,
    adapted_instructions: instructions,
    authority_visibility: {
      summary_version: "adaptive_guidance_authority_v1",
      contract_trust: "observational",
      may_override_policy: false,
      may_promote_directly: false,
      required_promotion_path: "runtime_signal_attribution_and_learning_control_gate",
      blocked_authority_levels: ["authoritative", "advisory"],
    },
    attribution_plan: {
      summary_version: "adaptive_guidance_attribution_plan_v1",
      candidate_ids: selected.map((candidate) => candidate.candidate_id),
      expected_signal_kind: "adaptive_guidance_outcome",
      feedback_slots: [
        "adaptive_guidance_outcome_v1",
        "execution_result_summary.adaptive_guidance_outcome_v1",
        "execution_evidence[].adaptive_guidance_outcome_v1",
      ],
      positive_authority_effect: "promotion_evidence_candidate",
      negative_authority_effect: "counter_evidence",
    },
    uncertainty_adjustment: {
      summary_version: "adaptive_guidance_uncertainty_adjustment_v1",
      confidence_delta: selected.length > 0 ? 0.04 : 0,
      recommended_actions: recommendedActions,
      reason: selected.length > 0
        ? `adaptive_guidance_selected=${selected.length}`
        : candidates.length > 0
          ? "adaptive_guidance_candidates_not_task_aligned"
          : null,
    },
    source_code_change_allowed: false,
  });
}

export function applyAdaptiveGuidanceToUncertainty(args: {
  uncertainty: ActionRetrievalUncertainty;
  overlay: AdaptiveGuidanceOverlayV1;
  hasStableWorkflow: boolean;
}): ActionRetrievalUncertainty {
  if (args.overlay.selected_candidate_count === 0) return args.uncertainty;
  const confidence = clamp01(args.uncertainty.confidence + args.overlay.uncertainty_adjustment.confidence_delta);
  const reasons = uniqueStrings([
    ...args.uncertainty.reasons,
    args.overlay.uncertainty_adjustment.reason,
  ], 32);
  const recommendedActions = uniqueStrings([
    ...args.uncertainty.recommended_actions,
    ...args.overlay.uncertainty_adjustment.recommended_actions,
  ], 8).filter(
    (entry): entry is ActionRetrievalUncertainty["recommended_actions"][number] =>
      entry === "proceed"
      || entry === "widen_recall"
      || entry === "rehydrate_payload"
      || entry === "inspect_context"
      || entry === "request_operator_review",
  );
  const level: ActionRetrievalUncertainty["level"] =
    args.uncertainty.level === "high"
    && confidence >= 0.48
    && args.hasStableWorkflow
      ? "moderate"
      : args.uncertainty.level;
  return {
    ...args.uncertainty,
    level,
    confidence,
    evidence_gap_count: Math.max(0, args.uncertainty.evidence_gap_count - (args.hasStableWorkflow ? 1 : 0)),
    reasons,
    recommended_actions: recommendedActions.length > 0 ? recommendedActions : args.uncertainty.recommended_actions,
  };
}
