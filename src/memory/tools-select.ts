import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  hashExecutionContext,
  hashPolicy,
  normalizeToolCandidates,
  uniqueRuleIds,
} from "./execution-provenance.js";
import {
  ToolsSelectRequest,
  ToolsSelectRouteContractSchema,
  type ToolsSelectRouteContract,
} from "./schemas.js";
import { evaluateRulesAppliedOnly } from "./rules-evaluate.js";
import { resolveTenantScope } from "./tenant.js";
import { applyToolPolicy } from "./tool-selector.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { buildToolsSelectionSummary } from "./tools-lifecycle-summary.js";
import { buildAionisUri } from "./uri.js";
import { isPatternSuppressed, readPatternOperatorOverride } from "./pattern-operator-override.js";
import {
  ControlProfileV1Schema,
  ExecutionStateV1Schema,
  type ControlProfileV1,
  type ExecutionStateV1,
} from "../execution/types.js";
import { controlProfileDefaults } from "../execution/profiles.js";
import {
  applyFamilyAwareOrdering,
  DEFAULT_TOOL_REGISTRY_INDEX,
  mapCandidatesToFamilies,
} from "./tool-registry.js";
import type { RecallStoreAccess, RecallNodeRow } from "../store/recall-access.js";
import { resolvePatternTaskAffinity, type PatternAffinityLevel } from "./pattern-trust-shaping.js";
import {
  resolveNodePatternExecutionSurface,
} from "./node-execution-surface.js";

function inferBroadToolKind(name: string): "scan" | "test" | null {
  const lowered = name.toLowerCase();
  if (!lowered.includes("broad")) return null;
  if (lowered.includes("test")) return "test";
  if (lowered.includes("scan")) return "scan";
  return null;
}

function deriveControlProfileFromExecutionState(state: ExecutionStateV1): ControlProfileV1 {
  return controlProfileDefaults(state.current_stage);
}

function normalizeExecutionSideOutputs(raw: {
  execution_result_summary?: unknown;
  execution_artifacts?: unknown;
  execution_evidence?: unknown;
}) {
  const executionResultSummary =
    raw.execution_result_summary && typeof raw.execution_result_summary === "object" && !Array.isArray(raw.execution_result_summary)
      ? (raw.execution_result_summary as Record<string, unknown>)
      : null;
  const executionArtifacts = Array.isArray(raw.execution_artifacts)
    ? raw.execution_artifacts.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const executionEvidence = Array.isArray(raw.execution_evidence)
    ? raw.execution_evidence.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  return {
    executionResultSummary,
    executionArtifacts,
    executionEvidence,
  };
}

function mergeExecutionContinuityContext(
  rawContext: unknown,
  rawSideOutputs: {
    execution_result_summary?: unknown;
    execution_artifacts?: unknown;
    execution_evidence?: unknown;
  },
) {
  const context =
    rawContext && typeof rawContext === "object" && !Array.isArray(rawContext) ? { ...(rawContext as Record<string, unknown>) } : {};
  const sideOutputs = normalizeExecutionSideOutputs(rawSideOutputs);
  if (sideOutputs.executionResultSummary && !("execution_result_summary" in context)) {
    context.execution_result_summary = sideOutputs.executionResultSummary;
  }
  if (sideOutputs.executionArtifacts.length > 0 && !("execution_artifacts" in context)) {
    context.execution_artifacts = sideOutputs.executionArtifacts;
  }
  if (sideOutputs.executionEvidence.length > 0 && !("execution_evidence" in context)) {
    context.execution_evidence = sideOutputs.executionEvidence;
  }
  return { context, sideOutputs };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 16): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function prioritizeExplicitPreferred(candidates: string[], preferred: string[]): string[] {
  if (preferred.length === 0) return [...candidates];
  const preferredSet = new Set(preferred);
  const head = preferred.filter((tool) => candidates.includes(tool));
  const tail = candidates.filter((tool) => !preferredSet.has(tool));
  return head.concat(tail);
}

function uniqueSelectedTools(patterns: Array<{ selected_tool: string }>, limit = 16): string[] {
  return uniqueStrings(patterns.map((pattern) => pattern.selected_tool), limit);
}

function contextConsumerAgentId(context: unknown): string | null {
  const ctx = asRecord(context);
  const agent = asRecord(ctx?.agent);
  return firstString([ctx?.agent_id, agent?.id]);
}

function contextConsumerTeamId(context: unknown): string | null {
  const ctx = asRecord(context);
  const agent = asRecord(ctx?.agent);
  return firstString([ctx?.team_id, agent?.team_id]);
}

function buildToolsPatternQueryText(context: unknown, candidates: string[]): string {
  const ctx = asRecord(context);
  const task = asRecord(ctx?.task);
  const error = asRecord(ctx?.error);
  const cue = firstString([
    ctx?.task_signature,
    task?.signature,
    ctx?.goal,
    task?.goal,
    ctx?.objective,
    task?.objective,
    ctx?.task_kind,
    error?.signature,
    error?.code,
  ]);
  return [
    "tools_select_pattern",
    cue ? `task=${cue}` : null,
    `candidates=${candidates.join(" ")}`,
  ].filter(Boolean).join("\n");
}

type RecalledToolPattern = {
  node_id: string;
  title: string | null;
  summary: string | null;
  selected_tool: string;
  task_signature: string | null;
  task_family: string | null;
  error_family: string | null;
  tool_set: string[];
  pattern_state: "provisional" | "stable";
  credibility_state: "candidate" | "trusted" | "contested";
  trusted: boolean;
  suppressed: boolean;
  suppression_mode: "shadow_learn" | "hard_freeze" | null;
  suppression_reason: string | null;
  suppressed_until: string | null;
  counter_evidence_open: boolean;
  last_transition: string | null;
  maintenance_state: "observe" | "retain" | "review" | null;
  offline_priority: "none" | "promote_candidate" | "review_counter_evidence" | "retain_trusted" | null;
  distinct_run_count: number;
  required_distinct_runs: number;
  confidence: number;
  similarity: number;
  affinity_level: PatternAffinityLevel;
  affinity_score: number;
  trust_hardening: Record<string, unknown> | null;
};

async function recallToolSelectionPatterns(args: {
  recallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider;
  context: unknown;
  candidates: string[];
  scope: string;
}): Promise<RecalledToolPattern[]> {
  const queryText = buildToolsPatternQueryText(args.context, args.candidates);
  const [queryEmbedding] = await args.embedder.embed([queryText]);
  const consumerAgentId = contextConsumerAgentId(args.context);
  const consumerTeamId = contextConsumerTeamId(args.context);
  const ann = await args.recallAccess.stage1CandidatesAnn({
    queryEmbedding,
    scope: args.scope,
    oversample: 24,
    limit: 6,
    consumerAgentId,
    consumerTeamId,
  });
  const seeds = ann.length > 0
    ? ann
    : await args.recallAccess.stage1CandidatesExactRecovery({
        queryEmbedding,
        scope: args.scope,
        oversample: 24,
        limit: 6,
        consumerAgentId,
        consumerTeamId,
      });
  const candidateMap = new Map(seeds.map((seed) => [seed.id, seed]));
  if (candidateMap.size === 0) return [];
  const rows = await args.recallAccess.stage2Nodes({
    scope: args.scope,
    nodeIds: Array.from(candidateMap.keys()),
    consumerAgentId,
    consumerTeamId,
    includeSlots: true,
  });
  const out: RecalledToolPattern[] = [];
  const candidateSet = new Set(args.candidates);
  for (const row of rows) {
    if (row.type !== "concept") continue;
    const slots = asRecord(row.slots);
    const patternSurface = resolveNodePatternExecutionSurface({ slots });
    const anchorKind = patternSurface.anchor_kind;
    const anchorLevel = patternSurface.anchor_level;
    const selectedTool = patternSurface.selected_tool;
    const taskSignature = patternSurface.task_signature;
    const taskFamily = patternSurface.task_family;
    const errorFamily = patternSurface.error_family;
    const patternState = patternSurface.pattern_state === "stable" ? "stable" : "provisional";
    const toolSet = patternSurface.tool_set;
    const trustHardening = patternSurface.trust_hardening;
    const maintenance = patternSurface.maintenance;
    const operatorOverride = readPatternOperatorOverride(slots ?? {});
    const suppressed = isPatternSuppressed(operatorOverride);
    const distinctRunCount = Number(patternSurface.promotion.distinct_run_count ?? 0);
    const requiredDistinctRuns = Math.max(2, Number(patternSurface.promotion.required_distinct_runs ?? 2));
    const counterEvidenceOpen = patternSurface.promotion.counter_evidence_open;
    const credibilityStateRaw = patternSurface.credibility_state;
    const credibilityState: "candidate" | "trusted" | "contested" =
      credibilityStateRaw === "trusted" || credibilityStateRaw === "contested" || credibilityStateRaw === "candidate"
        ? credibilityStateRaw
        : counterEvidenceOpen
          ? "contested"
          : patternState === "stable"
            ? "trusted"
            : "candidate";
    if (anchorKind !== "pattern" || anchorLevel !== "L3" || !selectedTool || !candidateSet.has(selectedTool)) continue;
    const affinity = resolvePatternTaskAffinity({
      context: args.context,
      selectedTool,
      storedTaskSignature: taskSignature,
      storedTaskFamily: taskFamily,
      storedErrorFamily: errorFamily,
    });
    const seed = candidateMap.get(row.id);
    out.push({
      node_id: row.id,
      title: row.title,
      summary: row.text_summary,
      selected_tool: selectedTool,
      task_signature: taskSignature,
      task_family: taskFamily,
      error_family: errorFamily,
      tool_set: toolSet,
      pattern_state: patternState,
      credibility_state: credibilityState,
      trusted: credibilityState === "trusted" && !suppressed,
      suppressed,
      suppression_mode: operatorOverride?.mode ?? null,
      suppression_reason: operatorOverride?.reason ?? null,
      suppressed_until: operatorOverride?.until ?? null,
      counter_evidence_open: counterEvidenceOpen,
      last_transition: patternSurface.promotion.last_transition,
      maintenance_state: firstString([maintenance?.maintenance_state]) as any,
      offline_priority: firstString([maintenance?.offline_priority]) as any,
      distinct_run_count: Number.isFinite(distinctRunCount) ? distinctRunCount : 0,
      required_distinct_runs: requiredDistinctRuns,
      confidence: Number(row.confidence ?? 0),
      similarity: Number(seed?.similarity ?? 0),
      affinity_level: affinity.level,
      affinity_score: affinity.score,
      trust_hardening: trustHardening,
    });
  }
  return out.sort((a, b) =>
    Number(b.trusted) - Number(a.trusted)
    || b.affinity_score - a.affinity_score
    || b.similarity - a.similarity
    || b.confidence - a.confidence
    || a.node_id.localeCompare(b.node_id));
}

export function resolveExecutionKernelInputs(
  rawContext: unknown,
  rawExecutionState: unknown,
): {
  controlProfile: ControlProfileV1 | null;
  controlProfileOrigin: "continuity_delivered" | "state_derived" | "none";
  executionState: ExecutionStateV1 | null;
} {
  const context =
    rawContext && typeof rawContext === "object" ? (rawContext as Record<string, unknown>) : null;
  const parsedProfile = ControlProfileV1Schema.safeParse(context?.control_profile_v1);
  if (parsedProfile.success) {
    const parsedState = ExecutionStateV1Schema.safeParse(rawExecutionState);
    return {
      controlProfile: parsedProfile.data,
      controlProfileOrigin: "continuity_delivered",
      executionState: parsedState.success ? parsedState.data : null,
    };
  }

  const parsedState = ExecutionStateV1Schema.safeParse(rawExecutionState);
  if (parsedState.success) {
    return {
      controlProfile: deriveControlProfileFromExecutionState(parsedState.data),
      controlProfileOrigin: "state_derived",
      executionState: parsedState.data,
    };
  }

  return {
    controlProfile: null,
    controlProfileOrigin: "none",
    executionState: null,
  };
}

export function applyControlProfileCandidateFilter(
  candidates: string[],
  controlProfile: ControlProfileV1 | null,
): {
  filteredCandidates: string[];
  deniedByProfile: Array<{ name: string; reason: "deny_list" | "not_in_allow_list" | "control_profile" }>;
} {
  if (!controlProfile) {
    return { filteredCandidates: candidates, deniedByProfile: [] };
  }

  const filteredCandidates: string[] = [];
  const deniedByProfile: Array<{ name: string; reason: "deny_list" | "not_in_allow_list" | "control_profile" }> = [];

  for (const candidate of candidates) {
    const broadKind = inferBroadToolKind(candidate);
    if (broadKind === "scan" && controlProfile.allow_broad_scan === false) {
      deniedByProfile.push({ name: candidate, reason: "control_profile" });
      continue;
    }
    if (broadKind === "test" && controlProfile.allow_broad_test === false) {
      deniedByProfile.push({ name: candidate, reason: "control_profile" });
      continue;
    }
    filteredCandidates.push(candidate);
  }

  return { filteredCandidates, deniedByProfile };
}

function summarizeToolConflicts(explain: any): string[] {
  const conflicts = Array.isArray(explain?.conflicts) ? explain.conflicts : [];
  const out: string[] = [];
  for (const c of conflicts) {
    const code = String(c?.code ?? "conflict");
    const msg = String(c?.message ?? "");
    const winner = c?.winner_rule_node_id ? String(c.winner_rule_node_id) : "";
    let line = `[${code}] ${msg}`;
    if (winner) line += ` (winner=${winner})`;
    // Hard cap per line to keep logs/UI safe.
    if (line.length > 200) line = line.slice(0, 197) + "...";
    out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

export async function selectTools(
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: {
    liteWriteStore?: Pick<LiteWriteStore, "insertExecutionDecision" | "listRuleCandidates"> | null;
    recallAccess?: RecallStoreAccess | null;
    embedder?: EmbeddingProvider | null;
    persistDecision?: boolean;
  } = {},
): Promise<ToolsSelectRouteContract> {
  const parsed = ToolsSelectRequest.parse(body);
  const { context: evaluationContext, sideOutputs } = mergeExecutionContinuityContext(parsed.context, {
    execution_result_summary: parsed.execution_result_summary,
    execution_artifacts: parsed.execution_artifacts,
    execution_evidence: parsed.execution_evidence,
  });
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const normalizedCandidates = normalizeToolCandidates(parsed.candidates);
  const kernelInputs = resolveExecutionKernelInputs(evaluationContext, parsed.execution_state_v1);
  const { filteredCandidates, deniedByProfile } = applyControlProfileCandidateFilter(
    normalizedCandidates,
    kernelInputs.controlProfile,
  );
  const candidateFamilies = mapCandidatesToFamilies(DEFAULT_TOOL_REGISTRY_INDEX, filteredCandidates);

  const rules = await evaluateRulesAppliedOnly({
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    default_tenant_id: defaultTenantId,
    context: evaluationContext,
    include_shadow: parsed.include_shadow,
    limit: parsed.rules_limit,
  }, {
    liteWriteStore: opts.liteWriteStore ?? null,
  });

  const recalledPatterns =
    opts.recallAccess && opts.embedder && filteredCandidates.length > 0
      ? await recallToolSelectionPatterns({
          recallAccess: opts.recallAccess,
          embedder: opts.embedder,
          context: evaluationContext,
          candidates: filteredCandidates,
          scope: tenancy.scope_key,
        })
      : [];
  const trustedPatterns = recalledPatterns.filter((pattern) => pattern.trusted);
  const suppressedPatterns = recalledPatterns.filter((pattern) => pattern.suppressed);
  const contestedPatterns = recalledPatterns.filter((pattern) => !pattern.trusted && !pattern.suppressed);
  const affinityReusableTrustedPatterns = trustedPatterns.filter((pattern) => pattern.affinity_score > 0);
  const patternPreferred = uniqueStrings(
    affinityReusableTrustedPatterns.map((pattern) => pattern.selected_tool),
    filteredCandidates.length,
  );

  const explicitPreferred = Array.isArray((rules.applied as any)?.policy?.tool?.prefer)
    ? ((rules.applied as any).policy.tool.prefer as string[])
    : [];
  const mergedPreferred = uniqueStrings([...explicitPreferred, ...patternPreferred], filteredCandidates.length);
  const preferredOrderedCandidates = prioritizeExplicitPreferred(filteredCandidates, mergedPreferred);
  const recommendedOrderedCandidates = applyFamilyAwareOrdering(preferredOrderedCandidates, candidateFamilies, mergedPreferred);
  const orderedCandidates = parsed.reorder_candidates ? recommendedOrderedCandidates : filteredCandidates;

  const selection = applyToolPolicy(orderedCandidates, rules.applied.policy, { strict: parsed.strict });
  if (deniedByProfile.length > 0) {
    selection.denied = deniedByProfile.concat(selection.denied);
  }

  let shadow_selection: any = undefined;
  if (parsed.include_shadow) {
    shadow_selection = applyToolPolicy(filteredCandidates, (rules.applied as any).shadow_policy ?? {}, { strict: false });
    if (deniedByProfile.length > 0) {
      shadow_selection.denied = deniedByProfile.concat(shadow_selection.denied);
    }
  }

  const tool_conflicts_summary = summarizeToolConflicts((rules.applied as any)?.tool_explain);
  const shadow_tool_conflicts_summary = parsed.include_shadow
    ? summarizeToolConflicts((rules.applied as any)?.shadow_tool_explain)
    : undefined;
  const source_rule_ids = uniqueRuleIds((((rules.applied as any)?.sources as any[]) ?? []).map((s: any) => String(s?.rule_node_id)));
  const decision_id = randomUUID();
  const context_sha256 = hashExecutionContext(evaluationContext);
  const policy_sha256 = hashPolicy((rules.applied as any)?.policy ?? {});
  const selectedTool = selection.selected ?? null;
  const usedTrustedPatterns = selectedTool
    ? trustedPatterns.filter((pattern) => pattern.selected_tool === selectedTool)
    : [];
  const decisionMetadata = {
    strict: parsed.strict,
    include_shadow: parsed.include_shadow,
    rules_limit: parsed.rules_limit,
    reorder_candidates: parsed.reorder_candidates,
    matched_rules: rules.matched,
    tool_conflicts_summary,
    denied_by_control_profile: deniedByProfile.map((entry) => entry.name),
    control_profile_origin: kernelInputs.controlProfileOrigin,
    execution_stage: kernelInputs.executionState?.current_stage ?? null,
    execution_role: kernelInputs.executionState?.active_role ?? null,
    execution_result_summary_present: !!sideOutputs.executionResultSummary,
    execution_artifacts_count: sideOutputs.executionArtifacts.length,
    execution_evidence_count: sideOutputs.executionEvidence.length,
    candidate_families: candidateFamilies,
    pattern_preferred_tools: patternPreferred,
    matched_pattern_anchor_ids: recalledPatterns.map((pattern) => pattern.node_id),
    matched_stable_pattern_anchor_ids: trustedPatterns.map((pattern) => pattern.node_id),
    used_trusted_pattern_anchor_ids: usedTrustedPatterns.map((pattern) => pattern.node_id),
    used_trusted_pattern_tools: uniqueSelectedTools(usedTrustedPatterns),
    used_trusted_pattern_affinity_levels: uniqueStrings(usedTrustedPatterns.map((pattern) => pattern.affinity_level), 8),
    skipped_contested_pattern_anchor_ids: contestedPatterns.map((pattern) => pattern.node_id),
    skipped_contested_pattern_tools: uniqueSelectedTools(contestedPatterns),
    skipped_contested_pattern_affinity_levels: uniqueStrings(contestedPatterns.map((pattern) => pattern.affinity_level), 8),
    skipped_suppressed_pattern_anchor_ids: suppressedPatterns.map((pattern) => pattern.node_id),
    skipped_suppressed_pattern_tools: uniqueSelectedTools(suppressedPatterns),
    skipped_suppressed_pattern_affinity_levels: uniqueStrings(suppressedPatterns.map((pattern) => pattern.affinity_level), 8),
    ...(parsed.include_shadow ? { shadow_tool_conflicts_summary } : {}),
  };
  const decisionRes: { id: string; created_at: string | null } = opts.persistDecision === false
    ? { id: decision_id, created_at: null }
    : opts.liteWriteStore
      ? await opts.liteWriteStore.insertExecutionDecision({
        id: decision_id,
        scope: tenancy.scope_key,
        decisionKind: "tools_select",
        runId: parsed.run_id ?? null,
        selectedTool: selection.selected ?? null,
        candidatesJson: selection.candidates,
        contextSha256: context_sha256,
        policySha256: policy_sha256,
        sourceRuleIds: source_rule_ids,
        metadataJson: decisionMetadata,
        commitId: null,
      })
      : (() => {
        throw new Error("selectTools decision persistence requires liteWriteStore");
      })();
  const decision_created_at = decisionRes.created_at ?? null;


  const response = {
    scope: rules.scope,
    tenant_id: rules.tenant_id,
    candidates: selection.candidates,
    selection,
    execution_kernel: {
      control_profile_origin: kernelInputs.controlProfileOrigin,
      execution_state_v1_present: !!kernelInputs.executionState,
      execution_result_summary_present: !!sideOutputs.executionResultSummary,
      execution_artifacts_count: sideOutputs.executionArtifacts.length,
      execution_evidence_count: sideOutputs.executionEvidence.length,
      current_stage: kernelInputs.executionState?.current_stage ?? null,
      active_role: kernelInputs.executionState?.active_role ?? null,
      tool_registry_present: true,
      family_aware_ordering_applied: parsed.reorder_candidates
        && orderedCandidates.some((candidate, index) => candidate !== filteredCandidates[index]),
      candidate_families: candidateFamilies,
    },
    rules: {
      considered: rules.considered,
      matched: rules.matched,
      skipped_invalid_then: rules.skipped_invalid_then,
      invalid_then_sample: rules.invalid_then_sample,
      agent_visibility_summary: (rules as any).agent_visibility_summary,
      applied: rules.applied,
      tool_conflicts_summary,
      ...(parsed.include_shadow ? { shadow_selection } : {}),
      ...(parsed.include_shadow ? { shadow_tool_conflicts_summary } : {}),
    },
    pattern_matches: {
      matched: recalledPatterns.length,
        trusted: trustedPatterns.length,
        preferred_tools: patternPreferred,
        anchors: recalledPatterns.map((pattern) => ({
        node_id: pattern.node_id,
        selected_tool: pattern.selected_tool,
        task_signature: pattern.task_signature,
        task_family: pattern.task_family,
        error_family: pattern.error_family,
        pattern_state: pattern.pattern_state,
          credibility_state: pattern.credibility_state,
          trusted: pattern.trusted,
          suppressed: pattern.suppressed,
          suppression_mode: pattern.suppression_mode,
          suppression_reason: pattern.suppression_reason,
          suppressed_until: pattern.suppressed_until,
          counter_evidence_open: pattern.counter_evidence_open,
        last_transition: pattern.last_transition,
        maintenance_state: pattern.maintenance_state,
        offline_priority: pattern.offline_priority,
        distinct_run_count: pattern.distinct_run_count,
        required_distinct_runs: pattern.required_distinct_runs,
        trust_hardening: pattern.trust_hardening,
        similarity: pattern.similarity,
        confidence: pattern.confidence,
        affinity_level: pattern.affinity_level,
        affinity_score: pattern.affinity_score,
        title: pattern.title,
        summary: pattern.summary,
      })),
    },
    decision: {
      decision_id,
      decision_uri: buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "decision",
        id: decision_id,
      }),
      run_id: parsed.run_id ?? null,
      selected_tool: selection.selected ?? null,
      policy_sha256,
      source_rule_ids,
      created_at: decision_created_at,
      pattern_summary: {
        used_trusted_pattern_anchor_ids: usedTrustedPatterns.map((pattern) => pattern.node_id),
        used_trusted_pattern_tools: uniqueSelectedTools(usedTrustedPatterns),
        used_trusted_pattern_affinity_levels: uniqueStrings(usedTrustedPatterns.map((pattern) => pattern.affinity_level), 8),
        skipped_contested_pattern_anchor_ids: contestedPatterns.map((pattern) => pattern.node_id),
        skipped_contested_pattern_tools: uniqueSelectedTools(contestedPatterns),
        skipped_contested_pattern_affinity_levels: uniqueStrings(contestedPatterns.map((pattern) => pattern.affinity_level), 8),
        skipped_suppressed_pattern_anchor_ids: suppressedPatterns.map((pattern) => pattern.node_id),
        skipped_suppressed_pattern_tools: uniqueSelectedTools(suppressedPatterns),
        skipped_suppressed_pattern_affinity_levels: uniqueStrings(suppressedPatterns.map((pattern) => pattern.affinity_level), 8),
      },
    },
  };
  return ToolsSelectRouteContractSchema.parse({
    ...response,
    selection_summary: buildToolsSelectionSummary({
      selection: response.selection,
      rules: response.rules,
      pattern_matches: response.pattern_matches,
      source_rule_ids,
    }),
  });
}
