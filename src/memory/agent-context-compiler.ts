import {
  AionisAgentContextSchema,
  parseAionisAgentContext,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisClaimLedgerProjection,
  type AionisGuidePacket,
  type AionisLifecycleCandidateSignal,
  type AionisMemoryPacket,
  type AionisRiskLevel,
  type AionisTaskContextProfile,
} from "./product-output-contract.js";

import type {
  AionisMemoryDecisionSurface,
  GovernanceDecisionV1,
} from "./governance-contract.js";

import { renderAionisAgentPrompt, type AgentContextRenderProfile } from "./agent-context-renderer.js";

import {
  inferLifecycleCandidateSignals,
  lifecycleCandidateDirectUseUnsafe,
  lifecycleCandidateRuntimeOwnedProducer,
} from "./lifecycle-candidate-inference.js";

import {
  MemoryLifecycleRelationTraceEvidence,
  MemoryPacketEntry,
  NormalizedAgentPromptExecutionScope,
  boundedExecutionEvidenceStrings,
  compactStrings,
  contractEntryIsCurrentState,
  contractEntryIsHandoff,
  contractEntryIsProcedure,
  extractPathTargets,
  governanceDecisionForMemoryEntry,
  governanceScopeMatchForEntry,
  lifecycleCandidateMemoryDirectUseAdmissible,
  lifecycleCandidateMemoryDirectUseUnsafe,
  lifecycleCandidateRehydrateEligible,
  lifecycleCandidateSignalsByMemoryId,
  lifecycleDecisionForEntry,
  memoryEntryBlocked,
  memoryEntryInspectBeforeUse,
  stringValue,
  textMatchesMemoryEntry,
} from "./product-output/memory-packet.js";



export type AgentContextTaskRoleContext = {
  agent_role: AionisAgentContext["agent_role"];
  task_context_profile: AionisAgentContext["task_context_profile"];
};

export type AgentContextCompilerInput = {
  base_context: AionisAgentContext;
  governance_decisions: GovernanceDecisionV1[];
  current_execution_state: AionisAgentContext | null;
  claim_projection: AionisClaimLedgerProjection | null;
  task_role_context: AgentContextTaskRoleContext;
  render_profile: AgentContextRenderProfile;
};

function uniqueStrings(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function riskRank(value: AionisAgentContext["risk"]["negative_transfer_risk"]): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function maxRisk(
  left: AionisAgentContext["risk"]["negative_transfer_risk"],
  right: AionisAgentContext["risk"]["negative_transfer_risk"],
): AionisAgentContext["risk"]["negative_transfer_risk"] {
  return riskRank(left) >= riskRank(right) ? left : right;
}

function authorityRank(value: AionisAgentContext["authority"]): number {
  switch (value) {
    case "trusted": return 4;
    case "advisory": return 3;
    case "candidate": return 2;
    case "blocked": return 1;
    case "none": return 0;
  }
}

function maxAuthority(
  left: AionisAgentContext["authority"],
  right: AionisAgentContext["authority"],
): AionisAgentContext["authority"] {
  return authorityRank(left) >= authorityRank(right) ? left : right;
}

function promptAliases(context: AionisAgentContext): AionisAgentContext["prompt_aliases"] {
  const surfaceById = new Map<string, AionisAgentContext["prompt_aliases"][number]["surface"]>();
  const directCurrentId = context.command_posture.find((row) =>
    row.posture === "should_continue"
    && (row.surface === "current" || row.execution_state?.summary_kind === "current_state")
  )?.memory_id;
  const inspectCurrentId = directCurrentId ? undefined : context.command_posture.find((row) =>
    row.posture === "inspect_first"
    && (row.surface === "current" || row.execution_state?.summary_kind === "current_state")
  )?.memory_id;
  const currentId = directCurrentId ?? inspectCurrentId ?? context.use_now_memory_ids[0];
  for (const row of context.command_posture) {
    const surface = row.memory_id === currentId
      ? "current"
      : row.surface === "procedure"
        ? "procedure"
        : row.surface === "inspect_before_use"
          ? "inspect"
          : row.surface === "do_not_use"
            ? "avoid"
            : row.surface === "rehydrate" ? "rehydrate" : "other";
    surfaceById.set(row.memory_id, surface);
  }
  for (const id of context.use_now_memory_ids) if (!surfaceById.has(id)) surfaceById.set(id, id === currentId ? "current" : "other");
  for (const id of context.inspect_before_use_memory_ids) if (!surfaceById.has(id)) surfaceById.set(id, "inspect");
  for (const id of context.do_not_use_memory_ids) if (!surfaceById.has(id)) surfaceById.set(id, "avoid");
  for (const hint of context.rehydrate_hints) surfaceById.set(hint.memory_id, "rehydrate");
  const orderedIds = uniqueStrings([
    ...(currentId ? [currentId] : []),
    ...context.command_posture.filter((row) => row.surface === "procedure").map((row) => row.memory_id),
    ...context.inspect_before_use_memory_ids,
    ...context.do_not_use_memory_ids,
    ...context.rehydrate_hints.map((hint) => hint.memory_id),
    ...context.command_posture.map((row) => row.memory_id),
    ...context.memory_ids,
  ], 10);
  return orderedIds.map((memoryId, index) => ({
    alias: `m${index + 1}`,
    memory_id: memoryId,
    surface: surfaceById.get(memoryId) ?? "other",
  }));
}

function safeExecutionLines(values: string[], prefixes: string[]): string[] {
  return values.filter((value) => prefixes.some((prefix) => value.startsWith(prefix)));
}

function mergeExecutionContext(
  base: AionisAgentContext,
  execution: AionisAgentContext | null,
  decisionIds: Set<string>,
): AionisAgentContext {
  if (!execution) return base;
  const useNow = safeExecutionLines(execution.use_now, ["Current active path:", "Passed solution:", "Continuity handoff:"]);
  const doNotUse = safeExecutionLines(execution.do_not_use, ["Avoid failed branch:"]);
  if (useNow.length === 0 && doNotUse.length === 0) return base;
  const allowed = (id: string) => decisionIds.has(id);
  const commandPosture = [
    ...execution.command_posture.filter((row) => allowed(row.memory_id)),
    ...base.command_posture,
  ];
  const commandKeys = new Set<string>();
  const mergedCommandPosture = commandPosture.filter((row) => {
    const key = `${row.posture}:${row.memory_id}`;
    if (commandKeys.has(key)) return false;
    commandKeys.add(key);
    return true;
  }).slice(0, 14);
  return AionisAgentContextSchema.parse({
    ...base,
    summary: base.history_used && execution.history_used
      ? "Aionis recovered semantic memory and full-power execution context for this run."
      : execution.history_used ? execution.summary : base.summary,
    history_used: base.history_used || execution.history_used,
    actionable_history_used: base.actionable_history_used || execution.actionable_history_used,
    authority: maxAuthority(base.authority, useNow.length > 0 ? "advisory" : "candidate"),
    target_files: uniqueStrings([...execution.target_files, ...base.target_files], 8),
    use_now: uniqueStrings([...useNow, ...base.use_now], 8),
    do_not_use: uniqueStrings([...doNotUse, ...base.do_not_use], 8),
    memory_ids: uniqueStrings([...base.memory_ids, ...execution.memory_ids.filter(allowed)], 10),
    use_now_memory_ids: uniqueStrings([...base.use_now_memory_ids, ...execution.use_now_memory_ids.filter(allowed)], 10),
    inspect_before_use_memory_ids: uniqueStrings([...base.inspect_before_use_memory_ids, ...execution.inspect_before_use_memory_ids.filter(allowed)], 10),
    do_not_use_memory_ids: uniqueStrings([...base.do_not_use_memory_ids, ...execution.do_not_use_memory_ids.filter(allowed)], 10),
    rehydrate_hints: [
      ...base.rehydrate_hints,
      ...execution.rehydrate_hints.filter((hint) => allowed(hint.memory_id)),
    ].filter((hint, index, rows) => rows.findIndex((row) => row.memory_id === hint.memory_id) === index).slice(0, 6),
    command_posture: mergedCommandPosture,
    risk: {
      negative_transfer_risk: maxRisk(base.risk.negative_transfer_risk, doNotUse.length > 0 ? "medium" : "low"),
      blocked_authority_count: base.risk.blocked_authority_count,
      stale_memory_count: Math.max(base.risk.stale_memory_count, execution.risk.stale_memory_count),
      reasons: uniqueStrings([
        ...base.risk.reasons,
        ...execution.risk.reasons.filter((reason) => reason === "failed_execution_branches_kept_out_of_use_now"),
        "full_power_execution_context_merged",
      ], 8),
    },
    evidence_refs: {
      memory_ids: uniqueStrings([...base.evidence_refs.memory_ids, ...execution.evidence_refs.memory_ids.filter(allowed)], 10),
      workflow_ids: uniqueStrings([...base.evidence_refs.workflow_ids, ...execution.evidence_refs.workflow_ids], 10),
      evidence_count: base.evidence_refs.evidence_count + execution.evidence_refs.evidence_count,
    },
  });
}

function claimLine(item: AionisClaimLedgerProjection["use_now"][number]): string {
  const slot = item.slot_key ?? `${item.subject_key}.${item.predicate}`;
  return `Claim ledger ${item.surface}: claim_id=${item.claim_id} slot=${slot} authority=${item.authority} status=${item.status} reason=${item.reason_code} value=${item.value_text}`;
}

function mergeClaimProjection(
  base: AionisAgentContext,
  projection: AionisClaimLedgerProjection | null,
): AionisAgentContext {
  if (!projection || (
    projection.use_now.length === 0
    && projection.inspect_before_use.length === 0
    && projection.do_not_use.length === 0
  )) return base;
  const claimUse = projection.use_now.map(claimLine);
  const claimInspect = projection.inspect_before_use.map(claimLine);
  const claimBlocked = projection.do_not_use.map(claimLine);
  const requiresInspection = claimInspect.length > 0 || claimBlocked.length > 0;
  const projectedAuthority: AionisAgentContext["authority"] = projection.use_now.some((row) => row.authority === "trusted")
    ? "trusted" : claimUse.length > 0 ? "advisory" : "candidate";
  return AionisAgentContextSchema.parse({
    ...base,
    history_used: true,
    actionable_history_used: base.actionable_history_used || claimUse.length > 0,
    recommended_posture: requiresInspection
      ? "inspect_before_use"
      : claimUse.length > 0 && base.recommended_posture === "ignore_history" ? "use_as_context" : base.recommended_posture,
    authority: maxAuthority(base.authority, projectedAuthority),
    summary: base.summary === "No reusable Aionis memory was found for this request."
      ? "Aionis recovered claim-ledger state for this request." : base.summary,
    use_now: uniqueStrings([...claimUse, ...base.use_now], 10),
    inspect_before_use: uniqueStrings([...base.inspect_before_use, ...claimInspect], 10),
    do_not_use: uniqueStrings([...claimBlocked, ...base.do_not_use], 10),
    risk: {
      ...base.risk,
      negative_transfer_risk: requiresInspection ? maxRisk(base.risk.negative_transfer_risk, "medium") : base.risk.negative_transfer_risk,
      reasons: uniqueStrings([
        ...base.risk.reasons,
        "claim_ledger_projection_applied",
        ...(claimBlocked.length > 0 ? ["claim_ledger_blocked_or_superseded_claims_kept_out_of_use_now"] : []),
        ...(claimInspect.length > 0 ? ["claim_ledger_contested_claims_require_inspection"] : []),
      ], 8),
    },
  });
}

function enforceDecisionSurfaces(
  context: AionisAgentContext,
  decisions: GovernanceDecisionV1[],
): AionisAgentContext {
  const known = new Set(decisions.map((decision) => decision.memory_id));
  const ids = (surface: GovernanceDecisionV1["surface"]) => decisions
    .filter((decision) => decision.surface === surface)
    .map((decision) => decision.memory_id);
  const useNow = uniqueStrings([
    ...context.use_now_memory_ids.filter((id) => !known.has(id)),
    ...ids("use_now"),
  ], 10);
  const inspect = uniqueStrings([
    ...context.inspect_before_use_memory_ids.filter((id) => !known.has(id)),
    ...ids("inspect_before_use"),
  ], 10);
  const blocked = uniqueStrings([
    ...context.do_not_use_memory_ids.filter((id) => !known.has(id)),
    ...ids("do_not_use"),
  ], 10);
  const rehydrate = new Set([
    ...context.rehydrate_hints.filter((hint) => !known.has(hint.memory_id)).map((hint) => hint.memory_id),
    ...ids("rehydrate"),
  ]);
  return AionisAgentContextSchema.parse({
    ...context,
    memory_ids: uniqueStrings([
      ...context.memory_ids,
      ...decisions.filter((decision) => decision.surface !== "not_agent_facing").map((decision) => decision.memory_id),
    ], 10),
    use_now_memory_ids: useNow,
    inspect_before_use_memory_ids: inspect,
    do_not_use_memory_ids: blocked,
    command_posture: context.command_posture.filter((row) => {
      if (!known.has(row.memory_id)) return true;
      if (row.posture === "should_continue") return useNow.includes(row.memory_id);
      if (row.posture === "inspect_first") return inspect.includes(row.memory_id);
      if (row.posture === "must_not") return blocked.includes(row.memory_id);
      if (row.posture === "rehydrate_first") return rehydrate.has(row.memory_id);
      return true;
    }),
    rehydrate_hints: context.rehydrate_hints.filter((hint) => rehydrate.has(hint.memory_id)),
  });
}

export function compileAionisAgentContext(input: AgentContextCompilerInput): AionisAgentContext {
  const roleContext = AionisAgentContextSchema.parse({
    ...input.base_context,
    agent_role: input.task_role_context.agent_role,
    agent_context_mode: input.render_profile.mode,
    task_context_profile: input.task_role_context.task_context_profile,
  });
  const decisionIds = new Set([
    ...input.governance_decisions.map((decision) => decision.memory_id),
    ...(input.current_execution_state?.memory_ids ?? []),
  ]);
  const mergedExecution = mergeExecutionContext(roleContext, input.current_execution_state, decisionIds);
  const mergedClaims = mergeClaimProjection(mergedExecution, input.claim_projection);
  const governed = enforceDecisionSurfaces(mergedClaims, input.governance_decisions);
  const withAliases = AionisAgentContextSchema.parse({
    ...governed,
    prompt_aliases: input.render_profile.detail === "standard" ? [] : promptAliases(governed),
  });
  return AionisAgentContextSchema.parse({
    ...withAliases,
    prompt_text: renderAionisAgentPrompt({ context: withAliases, profile: input.render_profile }),
  });
}

export type BuildAionisAgentContextArgs = {
  tenant_id: string;
  scope: string;
  agent_role?: AionisAgentRole | null;
  memory_packet?: AionisMemoryPacket | null;
  guide_packet?: AionisGuidePacket | null;
  execution_scope?: AgentContextExecutionScope | null;
  query_intent_override?: string | null;
  agent_context_mode?: "standard" | "compact_agent" | null;
  context_char_budget?: number | null;
  context_compaction_profile?: "balanced" | "aggressive" | null;
  task_context_profile?: AionisTaskContextProfile | null;
  current_execution_state?: AionisAgentContext | null;
  claim_projection?: AionisClaimLedgerProjection | null;
  render_detail?: "standard" | "full_power" | "contract" | "compact" | null;
};

export type AgentContextExecutionScope = {
  task_signature?: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
};

export type ApplyAionisInspectBeforeUseActiveProjectionArgs = {
  agent_context: AionisAgentContext;
  memory_packet?: AionisMemoryPacket | null;
  candidate_memory_ids: string[];
  reason: string;
  context_char_budget?: number | null;
  context_compaction_profile?: "balanced" | "aggressive" | null;
};

const EXECUTION_ACCEPTANCE_CONSTRAINT_CUES = /\b(?:acceptance|accepted|assert|check|checksum|column|contain|contains|created|downloaded|exact|exist|exists|expected|extract|extracted|format|hash|include|includes|installed|invariant|layout|must|output|passed|preserve|required|requires|retain|saved|schema|source|structure|test|verifier|written)\b/i;

const EXECUTION_ACCEPTANCE_GENERIC_REWARD = /^verifier\s+reward:?\s*1(?:\.0+)?$/i;

const EXECUTION_ACCEPTANCE_MAX_CONSTRAINT_CHARS = 240;

function executionAcceptanceConstraintChunks(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const numberedAsLines = normalized.replace(/\s+(?=\d+\.\s+)/g, "\n");
  const chunks = numberedAsLines
    .split(/\s+\|\s+/g)
    .flatMap((entry) => entry.split("\n"))
    .flatMap((entry) => entry.split(/(?<=[.!?])\s+/g))
    .map((chunk) => chunk.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.slice(0, EXECUTION_ACCEPTANCE_MAX_CONSTRAINT_CHARS).trim());
  return compactStrings(chunks);
}

function executionAcceptanceConstraintScore(value: string): number {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || !EXECUTION_ACCEPTANCE_CONSTRAINT_CUES.test(text)) return -1;
  const textWithoutPathLiterals = text.replace(/\/[A-Za-z0-9_./@+-]+|[A-Za-z0-9_.@+-]+\/[A-Za-z0-9_./@+-]+/g, " ");
  const hasNormativeConstraint = /\b(?:must|required|requires|expected|exact|invariant|assert|checksum|hash|schema|format|layout|structure)\b/i.test(text);
  const hasStateChangingEvidence = /\b(?:downloaded|extract|extracted|installed|created|written|saved)\b/i.test(text);
  let score = 0;
  if (/\/[A-Za-z0-9_./@+-]+|[A-Za-z0-9_.@+-]+\/[A-Za-z0-9_./@+-]+/.test(text)) score += 4;
  if (hasNormativeConstraint) score += 4;
  if (/\b(?:source|downloaded|extract|extracted|installed|created|written|saved|preserve|retain|contain|contains|include|includes|exist|exists)\b/i.test(textWithoutPathLiterals)) score += 5;
  if (hasStateChangingEvidence) score += 3;
  if (/\b(?:verifier|test|check|passed|acceptance)\b/i.test(text)) score += 2;
  if (EXECUTION_ACCEPTANCE_GENERIC_REWARD.test(text)) score -= 4;
  if (/\bpaths?:/i.test(text) && !hasNormativeConstraint && !hasStateChangingEvidence) score -= 3;
  if (text.length < 12) score -= 2;
  return score;
}

function executionAcceptanceOverlapKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?:;,]+$/g, "")
    .trim();
}

function executionAcceptanceConstraintsOverlap(left: string, right: string): boolean {
  const leftKey = executionAcceptanceOverlapKey(left);
  const rightKey = executionAcceptanceOverlapKey(right);
  if (leftKey.length < 24 || rightKey.length < 24) return false;
  return leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function executionEntryAccepted(entry: MemoryPacketEntry): boolean {
  const role = entry.execution_state?.execution_outcome_role;
  if (role === "passed_solution") return true;
  if (role === "failed_branch" || role === "blocked") return false;
  const summary = entry.summary.toLowerCase();
  if (/\b(?:outcome|status|result|verdict)\s*=\s*(?:failed|failure|blocked|rejected)\b/.test(summary)) return false;
  if (/\b(?:verifier\s+)?reward\s*=\s*0(?:\.0+)?\b/.test(summary)) return false;
  return /\b(?:outcome|status|result|verdict)\s*=\s*(?:succeeded|success|passed|accepted|completed)\b/.test(summary)
    || /\b(?:verifier\s+)?reward\s*=\s*1(?:\.0+)?\b/.test(summary)
    || /\b(?:all|focused|official)\s+(?:checks|tests|verifiers?)\s+passed\b/.test(summary);
}

function inferredExecutionAcceptanceConstraints(entry: MemoryPacketEntry): string[] {
  if (!executionEntryAccepted(entry)) return [];
  const state = entry.execution_state;
  const rawCandidates = compactStrings([
    ...(state?.workflow_steps ?? []),
    ...(state?.acceptance_checks ?? []),
    ...(state?.verification_summary ?? []),
    ...(state?.artifact_hints ?? []),
    entry.summary,
  ]).flatMap(executionAcceptanceConstraintChunks);
  const scored = rawCandidates
    .map((value, index) => ({
      value: value.replace(/\s+/g, " ").trim(),
      index,
      score: executionAcceptanceConstraintScore(value),
    }))
    .filter((entry) => entry.score >= 4)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: string[] = [];
  for (const entry of scored) {
    if (selected.some((value) => executionAcceptanceConstraintsOverlap(value, entry.value))) continue;
    selected.push(entry.value);
    if (selected.length >= 8) break;
  }
  return boundedExecutionEvidenceStrings(selected, 8);
}

function executionAcceptanceChecksForCommandPosture(entry: MemoryPacketEntry | null | undefined): string[] {
  const explicit = boundedExecutionEvidenceStrings(entry?.execution_state?.acceptance_checks ?? [], 8);
  if (!entry) return explicit;
  const inferred = inferredExecutionAcceptanceConstraints(entry);
  if (inferred.length === 0) return explicit;
  const generic = explicit.filter((value) => EXECUTION_ACCEPTANCE_GENERIC_REWARD.test(value));
  const specific = explicit.filter((value) => !EXECUTION_ACCEPTANCE_GENERIC_REWARD.test(value));
  return boundedExecutionEvidenceStrings([
    ...inferred,
    ...specific,
    ...generic,
  ], 8);
}

function normalizeAgentPromptExecutionScope(
  scope?: AgentContextExecutionScope | null,
): NormalizedAgentPromptExecutionScope {
  return {
    task_signature: stringValue(scope?.task_signature),
    task_family: stringValue(scope?.task_family),
    workflow_signature: stringValue(scope?.workflow_signature),
  };
}

function pushUniqueRouteTarget<T extends { target: string }>(
  rows: T[],
  seen: Set<string>,
  row: T,
  maxItems: number,
): void {
  if (rows.length >= maxItems) return;
  const target = row.target.trim();
  if (!target) return;
  const key = target.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ ...row, target });
}

function routeTargetMatchesExplicitTarget(target: string, explicitTargets: Set<string>): boolean {
  if (explicitTargets.size === 0) return true;
  const normalizedTarget = normalizePathTarget(target)?.toLowerCase();
  if (!normalizedTarget) return false;
  for (const explicit of explicitTargets) {
    const normalizedExplicit = normalizePathTarget(explicit)?.toLowerCase();
    if (!normalizedExplicit) continue;
    if (normalizedTarget === normalizedExplicit) return true;
    if (normalizedTarget.startsWith(`${normalizedExplicit}/`)) return true;
    if (normalizedExplicit.startsWith(`${normalizedTarget}/`)) return true;
    if (
      normalizedExplicit.includes("/")
      && normalizedTarget.includes(`/${normalizedExplicit}/`)
    ) return true;
  }
  return false;
}

function buildAgentRouteContract(args: {
  targetFiles: string[];
  commandPosture: AionisAgentContext["command_posture"];
}): AionisAgentContext["route_contract"] {
  const activeTargets: AionisAgentContext["route_contract"]["active_targets"] = [];
  const pendingArtifacts: AionisAgentContext["route_contract"]["pending_artifacts"] = [];
  const referenceOnlyTargets: AionisAgentContext["route_contract"]["reference_only_targets"] = [];
  const blockedDirectionTargets: AionisAgentContext["route_contract"]["blocked_direction_targets"] = [];
  const evidenceSources: AionisAgentContext["route_contract"]["evidence_sources"] = [];
  const blockedRoutes: AionisAgentContext["route_contract"]["blocked_routes"] = [];
  const activeSeen = new Set<string>();
  const referenceSeen = new Set<string>();
  const blockedSeen = new Set<string>();
  const evidenceSeen = new Set<string>();
  const blockedRouteSeen = new Set<string>();
  const explicitTargetSet = new Set(args.targetFiles.map((target) => target.trim().toLowerCase()).filter(Boolean));
  const shouldContinueEntries = args.commandPosture.filter((entry) =>
    entry.posture === "should_continue"
    && (entry.surface === "current" || entry.surface === "procedure")
  );
  const routeEntries = shouldContinueEntries.filter((entry) =>
    explicitTargetSet.size === 0
    || entry.target_files.some((target) => routeTargetMatchesExplicitTarget(target, explicitTargetSet))
  );

  for (const entry of routeEntries) {
    for (const target of entry.target_files) {
      pushUniqueRouteTarget(activeTargets, activeSeen, {
        target,
        source_memory_id: entry.memory_id,
        source: "should_continue",
        artifact_status: "may_be_absent",
        missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
        reason: entry.instruction,
      }, 6);
    }
  }
  if (activeTargets.length === 0 && args.commandPosture.length === 0) {
    for (const target of args.targetFiles) {
      pushUniqueRouteTarget(activeTargets, activeSeen, {
        target,
        source: "target_files",
        artifact_status: "may_be_absent",
        missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
        reason: "Target file is part of the active execution route.",
      }, 6);
    }
  }

  for (const target of activeTargets) {
    pushUniqueRouteTarget(pendingArtifacts, new Set(pendingArtifacts.map((entry) => entry.target.toLowerCase())), {
      target: target.target,
      source_memory_id: target.source_memory_id,
      source: target.source,
      status: "unknown_until_host_observation",
      when: "if_active_target_is_missing",
      allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
      preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
      terminal_inspect_allowed: false,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
      reason: "If the active route target is absent, absence alone is not stale proof; create, restore, or rehydrate before reporting conflict or falling back.",
    }, 6);
  }

  const activeTargetKeys = new Set(activeTargets.map((entry) => entry.target.toLowerCase()));
  for (const entry of args.commandPosture) {
    const source = entry.posture === "inspect_first"
      ? "inspect_first"
      : entry.posture === "must_not"
        ? "must_not"
        : null;
    if (!source) continue;
    for (const target of entry.target_files) {
      const normalized = target.trim().toLowerCase();
      if (!normalized || activeTargetKeys.has(normalized)) continue;
      const row = {
        target,
        source_memory_id: entry.memory_id,
        source,
        reason: entry.instruction,
      } as const;
      if (source === "inspect_first") {
        pushUniqueRouteTarget(referenceOnlyTargets, referenceSeen, row, 6);
        pushUniqueRouteTarget(evidenceSources, evidenceSeen, {
          ...row,
          evidence_use: "reference_only",
          direction_policy: "must_not_be_primary_route",
        }, 6);
      } else {
        pushUniqueRouteTarget(blockedDirectionTargets, blockedSeen, row, 6);
        pushUniqueRouteTarget(blockedRoutes, blockedRouteSeen, {
          ...row,
          direction_policy: "blocked_route",
          evidence_use: "counter_evidence_only",
        }, 6);
      }
    }
  }

  return {
    active_targets: activeTargets,
    pending_artifacts: pendingArtifacts,
    reference_only_targets: referenceOnlyTargets,
    blocked_direction_targets: blockedDirectionTargets,
    evidence_sources: evidenceSources,
    blocked_routes: blockedRoutes,
    conflict_policy: "do_not_treat_missing_active_target_as_superseded",
    fallback_policy: "do_not_promote_reference_or_blocked_targets",
    action_policy: {
      missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"],
      terminal_inspect_allowed: false,
      reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation",
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate",
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent",
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict",
    },
  };
}

function entryById(entries: MemoryPacketEntry[]): Map<string, MemoryPacketEntry> {
  return new Map(entries.map((entry) => [entry.memory_id, entry]));
}

function selfVerifiedActiveHandoffDirectUseEligible(entry: MemoryPacketEntry): boolean {
  if (memoryEntryBlocked(entry)) return false;
  if (entry.lifecycle_state === "contested" || entry.lifecycle_state === "rehydration_candidate") return false;
  if (!memoryEntryIsExecutionScoped(entry)) return false;
  if (!contractEntryIsHandoff(entry) && !contractEntryIsCurrentState(entry)) return false;
  if (entry.target_files.length === 0) return false;
  if (!entry.execution_state?.next_action_hint) return false;
  if (entry.confidence < 0.7) return false;
  const text = `${entry.title ?? ""} ${entry.summary} ${entry.execution_state.execution_kind ?? ""} ${entry.execution_state.next_action_hint}`.toLowerCase();
  const activeContinuationKind =
    /\bactive[_ -]?continuation[_ -]?handoff\b/.test(text)
    || /\bverified[_ -]?session[_ -]?handoff\b/.test(text);
  const verifiedOutcome =
    /\bverified\b.{0,120}\b(?:passed|validation|acceptance|route|handoff|implementation)\b/.test(text)
    || /\b(?:acceptance check|validation command|validation)\b.{0,80}\bpassed\b/.test(text)
    || /\bpassed\b.{0,80}\b(?:acceptance check|validation command|validation)\b/.test(text);
  return activeContinuationKind && verifiedOutcome;
}

function verifiedHandoffDirectUseEligible(entry: MemoryPacketEntry, verifiedHandoffMemoryIds: Set<string>): boolean {
  const recoveredVerified = verifiedHandoffMemoryIds.has(entry.memory_id)
    && !memoryEntryBlocked(entry)
    && entry.lifecycle_state !== "contested"
    && entry.lifecycle_state !== "rehydration_candidate"
    && memoryEntryIsExecutionScoped(entry)
    && contractEntryIsHandoff(entry)
    && entry.target_files.length > 0;
  return recoveredVerified || selfVerifiedActiveHandoffDirectUseEligible(entry);
}

function memoryEntryRehydrateEligible(entry: MemoryPacketEntry): boolean {
  return entry.lifecycle_state === "rehydration_candidate" || entry.lifecycle_state === "archived"
    || entry.execution_state?.transition_kind === "request_rehydrate";
}

function memoryEntryRehydrateSurface(entry: MemoryPacketEntry): boolean {
  return lifecycleDecisionForEntry(entry).requires_rehydrate;
}

function queryRequestsRehydration(value: string | null | undefined): boolean {
  const text = typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
  if (!text) return false;
  return /\brequest(?:s|ed|ing)?\s+(?:the\s+)?rehydrat/.test(text)
    || /\bneeds?\s+(?:the\s+)?(?:exact|raw|full|file-level|source)[^.!?\n]{0,80}\b(?:diff|trace|trajectory|payload|evidence|history|context)\b/.test(text)
    || /\b(?:exact|raw|full|file-level|source)[^.!?\n]{0,80}\b(?:diff|trace|trajectory|payload|evidence|history|context)\b/.test(text)
    || /\bexpand(?:ed|ing)?\s+(?:the\s+)?(?:raw\s+|full\s+)?(?:trace|trajectory|payload|evidence|history|context)\b/.test(text);
}

function memoryEntryUsable(entry: MemoryPacketEntry): boolean {
  return (entry.authority === "trusted" || entry.authority === "advisory")
    && entry.lifecycle_state === "active";
}

function memoryEntryIsExecutionScoped(entry: MemoryPacketEntry): boolean {
  return entry.domain === "execution"
    || entry.memory_type === "execution_memory"
    || entry.memory_type === "procedure";
}

function memoryEntryAgentPromptScopeAllowed(args: {
  entry: MemoryPacketEntry;
  executionScope: NormalizedAgentPromptExecutionScope;
  verifiedHandoffMemoryIds: Set<string>;
}): boolean {
  if (verifiedHandoffDirectUseEligible(args.entry, args.verifiedHandoffMemoryIds)) return true;
  return governanceScopeMatchForEntry({ entry: args.entry, executionScope: args.executionScope }) !== "unrelated";
}

function filterMemoryEntriesForAgentPromptScope(args: {
  memoryEntries: MemoryPacketEntry[];
  executionScope: NormalizedAgentPromptExecutionScope;
  verifiedHandoffMemoryIds: Set<string>;
}): {
  promptEntries: MemoryPacketEntry[];
  excludedEntries: MemoryPacketEntry[];
} {
  const promptEntries: MemoryPacketEntry[] = [];
  const excludedEntries: MemoryPacketEntry[] = [];
  for (const entry of args.memoryEntries) {
    if (memoryEntryAgentPromptScopeAllowed({
      entry,
      executionScope: args.executionScope,
      verifiedHandoffMemoryIds: args.verifiedHandoffMemoryIds,
    })) {
      promptEntries.push(entry);
    } else {
      excludedEntries.push(entry);
    }
  }
  return { promptEntries, excludedEntries };
}

function memoryEntryLabel(entry: MemoryPacketEntry): string {
  return compactStrings([entry.title, entry.memory_id])[0] ?? entry.memory_id;
}

function memoryEntryAuditLabel(entry: MemoryPacketEntry): string {
  const label = memoryEntryLabel(entry);
  return label === entry.memory_id ? entry.memory_id : `${label} (${entry.memory_id})`;
}

function memoryEntryUseNowLine(entry: MemoryPacketEntry, deniedPathTargets: Set<string> = new Set()): string | null {
  const prefix = entry.memory_type === "preference"
    ? "Preference"
    : entry.memory_type === "project_context"
      ? "Project memory"
      : entry.domain === "execution"
        ? "Execution memory"
        : "Memory";
  const summary = sanitizeAgentFacingSummary(entry.summary, deniedPathTargets);
  if (!summary) return null;
  return `${prefix}: ${summary}`.slice(0, 520);
}

function memoryEntryInspectLine(entry: MemoryPacketEntry): string {
  return `Inspect memory before use: ${memoryEntryLabel(entry)}`.slice(0, 220);
}

function workflowUseNowLine(text: string): boolean {
  return /^\s*Workflow\s+(trusted|advisory):/i.test(text);
}

function backgroundWorkflowUseNowLine(text: string): boolean {
  return workflowUseNowLine(text)
    && (
      /\bbackground\s+repository\s+activity\b/i.test(text)
      || /\bunrelated\s+continuation\s+context\b/i.test(text)
    );
}

function rawGuideLinePromptScopeAllowed(args: {
  line: string;
  surface: "use_now" | "inspect_before_use" | "do_not_use";
  executionScope: NormalizedAgentPromptExecutionScope;
  promptEntries: MemoryPacketEntry[];
  excludedEntries: MemoryPacketEntry[];
}): boolean {
  if (!args.executionScope.task_signature && !args.executionScope.task_family && !args.executionScope.workflow_signature) return true;
  if (args.promptEntries.some((entry) => textMatchesMemoryEntry(args.line, entry))) return true;
  if (args.excludedEntries.some((entry) => textMatchesMemoryEntry(args.line, entry))) return false;
  if (args.surface !== "use_now") return false;
  if (workflowUseNowLine(args.line) || backgroundWorkflowUseNowLine(args.line)) return false;
  if (/^\s*Recovered state:/i.test(args.line)) return args.promptEntries.length > 0;
  return false;
}

function filterRawGuideLinesForAgentPromptScope(args: {
  lines: string[];
  surface: "use_now" | "inspect_before_use" | "do_not_use";
  executionScope: NormalizedAgentPromptExecutionScope;
  promptEntries: MemoryPacketEntry[];
  excludedEntries: MemoryPacketEntry[];
}): string[] {
  return args.lines.filter((line) => rawGuideLinePromptScopeAllowed({
    line,
    surface: args.surface,
    executionScope: args.executionScope,
    promptEntries: args.promptEntries,
    excludedEntries: args.excludedEntries,
  }));
}

function agentPromptMemoryIdAllowed(args: {
  memoryId: string;
  memoryEntriesById: Map<string, MemoryPacketEntry>;
  executionScope: NormalizedAgentPromptExecutionScope;
  verifiedHandoffMemoryIds: Set<string>;
}): boolean {
  if (!args.executionScope.task_signature && !args.executionScope.task_family && !args.executionScope.workflow_signature) return true;
  const entry = args.memoryEntriesById.get(args.memoryId);
  if (!entry) return false;
  return memoryEntryAgentPromptScopeAllowed({
    entry,
    executionScope: args.executionScope,
    verifiedHandoffMemoryIds: args.verifiedHandoffMemoryIds,
  });
}

function executionEvidenceUseNowLine(text: string): boolean {
  return /^\s*(Passed solution|Current active path):/i.test(text);
}

const TRUSTED_WORKFLOW_CONFLICT_WORDS = [
  "conflict",
  "conflicting",
  "contradict",
  "contradiction",
  "inconsistent",
  "incompatible",
  "stale",
  "outdated",
  "obsolete",
  "wrong",
  "invalid",
  "known-bad",
  "known bad",
  "false hypothesis",
  "false positive",
];

function workflowConflictSignals(entry: MemoryPacketEntry): string[] {
  const text = compactStrings([entry.title, entry.summary]).join("\n").toLowerCase();
  return TRUSTED_WORKFLOW_CONFLICT_WORDS.filter((word) => text.includes(word));
}

function sentenceChunks(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function containsDeniedPathTarget(text: string, deniedPathTargets: Set<string>): boolean {
  if (deniedPathTargets.size === 0) return false;
  return extractPathTargets(text).some((target) => deniedPathTargets.has(target));
}

function sanitizeAgentFacingSummary(summary: string, deniedPathTargets: Set<string>): string {
  const compacted = summary.replace(/\s+/g, " ").trim();
  if (!compacted || deniedPathTargets.size === 0) return compacted;
  const kept = sentenceChunks(compacted).filter((chunk) =>
    !containsDeniedPathTarget(chunk, deniedPathTargets)
  );
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function deniedAgentActionPathTargets(entries: MemoryPacketEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (!memoryEntryBlocked(entry) && !memoryEntryInspectBeforeUse(entry)) continue;
    for (const target of extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`)) {
      out.add(target);
    }
  }
  return out;
}

function sameTargetSet(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
}

function normalizePathTarget(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/[),.;:]+$/g, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  return normalized.length > 0 ? normalized : null;
}

function memoryEntryPathTargets(entry: MemoryPacketEntry): string[] {
  const structuredTargets = compactStrings(entry.target_files.map(normalizePathTarget));
  if (structuredTargets.length > 0) return structuredTargets;
  return compactStrings(extractPathTargets(`${entry.title ?? ""}\n${entry.summary}`).map(normalizePathTarget));
}

type PremiseFirewallProjection = {
  inspectBeforeUse: string[];
  doNotUse: string[];
  inspectBeforeUseMemoryIds: string[];
  doNotUseMemoryIds: string[];
  riskReasons: string[];
};

const EMPTY_PREMISE_FIREWALL_PROJECTION: PremiseFirewallProjection = {
  inspectBeforeUse: [],
  doNotUse: [],
  inspectBeforeUseMemoryIds: [],
  doNotUseMemoryIds: [],
  riskReasons: [],
};

const PREMISE_QUERY_CUES = [
  "assume",
  "based on",
  "continue",
  "deprecated",
  "former",
  "initial",
  "legacy",
  "obsolete",
  "old",
  "outdated",
  "previous",
  "prior",
  "stale",
  "use",
];

const PREMISE_FIREWALL_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "based",
  "continue",
  "current",
  "from",
  "into",
  "memory",
  "please",
  "prior",
  "project",
  "query",
  "should",
  "that",
  "this",
  "use",
  "with",
  "work",
]);

function normalizePremiseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function premiseTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizePremiseText(value).replace(/[/_.:-]+/g, " ").match(/[a-z0-9]{4,}/g) ?? []) {
    const token = raw.replace(/^[._-]+|[._-]+$/g, "");
    if (!token || PREMISE_FIREWALL_STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

function premiseTokenOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function queryHasPremiseCue(query: string): boolean {
  const normalized = ` ${normalizePremiseText(query)} `;
  return PREMISE_QUERY_CUES.some((cue) =>
    normalized.includes(` ${normalizePremiseText(cue)} `)
  );
}

function queryMentionsPathTarget(query: string, target: string): boolean {
  const normalizedQuery = normalizePremiseText(query).replace(/^\.\/+/, "");
  const normalizedTarget = normalizePremiseText(target).replace(/^\.\/+/, "");
  return normalizedTarget.length >= 5 && normalizedQuery.includes(normalizedTarget);
}

function queryMentionsMemoryEntry(query: string, entry: MemoryPacketEntry): boolean {
  const normalizedQuery = normalizePremiseText(query);
  if (!normalizedQuery) return false;
  if (normalizedQuery.includes(normalizePremiseText(entry.memory_id))) return true;
  if (memoryEntryPathTargets(entry).some((target) => queryMentionsPathTarget(query, target))) return true;

  const title = normalizePremiseText(entry.title ?? "");
  if (title.length >= 8 && normalizedQuery.includes(title)) return true;

  if (!queryHasPremiseCue(query)) return false;
  const queryTokens = premiseTokens(query);
  const titleTokens = premiseTokens(entry.title ?? "");
  if (titleTokens.size > 0 && premiseTokenOverlap(queryTokens, titleTokens) >= 2) return true;
  const memoryTokens = premiseTokens(`${entry.title ?? ""}\n${entry.summary}`);
  return premiseTokenOverlap(queryTokens, memoryTokens) >= 3;
}

function relationEvidenceByTarget(
  evidenceTrail: AionisMemoryPacket["evidence_trail"],
): Map<string, MemoryLifecycleRelationTraceEvidence> {
  const out = new Map<string, MemoryLifecycleRelationTraceEvidence>();
  for (const evidence of evidenceTrail) {
    const relation = evidence.lifecycle_relation;
    if (!relation || relation.gate.accepted !== true) continue;
    out.set(relation.target_memory_id, relation);
  }
  return out;
}

function buildPremiseFirewallProjection(args: {
  queryIntent: string | null;
  memoryEntries: MemoryPacketEntry[];
  evidenceTrail: AionisMemoryPacket["evidence_trail"];
}): PremiseFirewallProjection {
  const query = args.queryIntent?.trim();
  if (!query || args.memoryEntries.length === 0) return EMPTY_PREMISE_FIREWALL_PROJECTION;

  const byId = new Map(args.memoryEntries.map((entry) => [entry.memory_id, entry]));
  const relationsByTarget = relationEvidenceByTarget(args.evidenceTrail);
  const inspectBeforeUse: string[] = [];
  const doNotUse: string[] = [];
  const inspectBeforeUseMemoryIds: string[] = [];
  const doNotUseMemoryIds: string[] = [];
  const riskReasons: string[] = [];

  for (const entry of args.memoryEntries) {
    if (!queryMentionsMemoryEntry(query, entry)) continue;
    const relation = relationsByTarget.get(entry.memory_id) ?? null;
    if (relation) {
      const source = byId.get(relation.source_memory_id);
      const sourceLabel = source ? memoryEntryAuditLabel(source) : relation.source_memory_id;
      inspectBeforeUse.push(
        `Premise risk: query mentions ${memoryEntryAuditLabel(entry)}, but newer/current memory ${sourceLabel} ${relation.lifecycle_relation} it; inspect before relying on that premise.`,
      );
      inspectBeforeUseMemoryIds.push(entry.memory_id);
      riskReasons.push("premise_firewall_query_conflicts_with_current_memory");
      continue;
    }
    if (memoryEntryBlocked(entry)) {
      doNotUse.push(
        `Premise risk: query mentions blocked memory ${memoryEntryAuditLabel(entry)}; keep that premise out of direct use.`,
      );
      doNotUseMemoryIds.push(entry.memory_id);
      riskReasons.push("premise_firewall_query_mentions_blocked_memory");
      continue;
    }
    if (memoryEntryInspectBeforeUse(entry)) {
      inspectBeforeUse.push(
        `Premise risk: query mentions ${memoryEntryAuditLabel(entry)}, but this memory is ${entry.lifecycle_state}/${entry.authority}; inspect before relying on that premise.`,
      );
      inspectBeforeUseMemoryIds.push(entry.memory_id);
      riskReasons.push("premise_firewall_query_mentions_uncertain_memory");
    }
  }

  return {
    inspectBeforeUse: compactStrings(inspectBeforeUse).slice(0, 4),
    doNotUse: compactStrings(doNotUse).slice(0, 4),
    inspectBeforeUseMemoryIds: compactStrings(inspectBeforeUseMemoryIds).slice(0, 10),
    doNotUseMemoryIds: compactStrings(doNotUseMemoryIds).slice(0, 10),
    riskReasons: compactStrings(riskReasons).slice(0, 4),
  };
}

function trustedWorkflowConflictAudit(entries: MemoryPacketEntry[]): {
  hasConflict: boolean;
  conflictedEntries: MemoryPacketEntry[];
  reasons: string[];
} {
  const workflowEntries = entries.filter((entry) =>
    memoryEntryUsable(entry)
    && entry.domain === "execution"
    && (entry.memory_type === "execution_memory" || entry.memory_type === "procedure")
    && entry.authority === "trusted",
  );
  if (workflowEntries.length < 2) {
    return { hasConflict: false, conflictedEntries: [], reasons: [] };
  }

  const selfDisclaimed = workflowEntries.some((entry) => workflowConflictSignals(entry).length > 0);
  const entriesWithTargets = workflowEntries
    .map(memoryEntryPathTargets)
    .filter((targets) => targets.length > 0);
  let hasTargetConflict = false;
  for (let index = 0; index < entriesWithTargets.length; index += 1) {
    for (let next = index + 1; next < entriesWithTargets.length; next += 1) {
      const left = entriesWithTargets[index];
      const right = entriesWithTargets[next];
      if (left && right && !sameTargetSet(left, right)) hasTargetConflict = true;
    }
  }
  return {
    hasConflict: true,
    conflictedEntries: workflowEntries,
    reasons: compactStrings([
      selfDisclaimed ? "trusted_workflow_self_disclaimed_conflict" : null,
      hasTargetConflict ? "trusted_workflow_target_conflict" : null,
      "multiple_trusted_workflows_require_inspection",
    ]),
  };
}

function memoryContractInspectBeforeUse(entry: MemoryPacketEntry): boolean {
  return entry.memory_contract.use_policy === "evidence_only";
}

function memoryContractInspectLine(entry: MemoryPacketEntry): string {
  return `Memory contract: ${memoryEntryAuditLabel(entry)} is ${entry.memory_contract.use_policy}; ${entry.memory_contract.allowed_scope}; inspect before direct reuse.`;
}

function lifecycleCandidateSignalLabels(signals: AionisLifecycleCandidateSignal[]): string[] {
  return compactStrings(signals.map((signal) => signal.signal_type));
}

function lifecycleCandidateInspectLine(args: {
  entry: MemoryPacketEntry;
  signals: AionisLifecycleCandidateSignal[];
}): string {
  return `Lifecycle candidate: ${memoryEntryAuditLabel(args.entry)} has ${lifecycleCandidateSignalLabels(args.signals).join("+")} evidence; inspect before direct use.`;
}

function passedExecutionRouteDirectUseProtected(entry: MemoryPacketEntry): boolean {
  return memoryEntryUsable(entry)
    && memoryEntryIsExecutionScoped(entry)
    && entry.memory_contract.use_policy === "direct_use"
    && entry.execution_state?.execution_outcome_role === "passed_solution"
    && (contractEntryIsCurrentState(entry) || contractEntryIsProcedure(entry))
    && entry.target_files.length > 0;
}

function lifecycleCandidateHardUnsafeForPassedRoute(signals: AionisLifecycleCandidateSignal[]): boolean {
  return signals.some((signal) =>
    lifecycleCandidateDirectUseUnsafe(signal)
    && (signal.signal_type === "negative" || signal.signal_type === "contested")
  );
}

function lifecycleCandidateMemoryDirectUseProtected(args: {
  entry: MemoryPacketEntry;
  signals: AionisLifecycleCandidateSignal[];
}): boolean {
  if (passedExecutionRouteDirectUseProtected(args.entry)) {
    return !lifecycleCandidateHardUnsafeForPassedRoute(args.signals);
  }
  if (lifecycleCandidateMemoryDirectUseUnsafe(args.signals)) return false;
  const hasCurrentOrProcedureSignal = args.signals.some((signal) =>
    lifecycleCandidateRuntimeOwnedProducer(signal)
    && signal.confidence >= 0.76
    && (signal.signal_type === "current" || signal.signal_type === "procedure")
  );
  if (!hasCurrentOrProcedureSignal) return false;
  return memoryEntryUsable(args.entry) || lifecycleCandidateMemoryDirectUseAdmissible(args);
}

function lifecycleCandidateInspectMemoryIds(signals: AionisLifecycleCandidateSignal[]): string[] {
  const byId = lifecycleCandidateSignalsByMemoryId(signals);
  return compactStrings(
    [...byId.entries()]
      .filter(([, entries]) => lifecycleCandidateMemoryDirectUseUnsafe(entries))
      .map(([memoryId]) => memoryId),
  );
}

function lifecycleCandidateRehydrateHints(args: {
  entries: MemoryPacketEntry[];
  signals: AionisLifecycleCandidateSignal[];
  rehydrationRequested: boolean;
}): AionisAgentContext["rehydrate_hints"] {
  const signalsById = lifecycleCandidateSignalsByMemoryId(args.signals);
  return args.entries
    .filter((entry) => lifecycleCandidateRehydrateEligible({
      entry,
      signals: signalsById.get(entry.memory_id) ?? [],
    }))
    .map((entry) => ({
      memory_id: entry.memory_id,
      reason: "Lifecycle candidate points to raw evidence, trace, payload, or pointer evidence; rehydrate before relying on summary-only context.",
      required: args.rehydrationRequested,
    }))
    .slice(0, 6);
}

function buildAgentContextCommandPostures(args: {
  memoryEntries: MemoryPacketEntry[];
  useNowMemoryIds: string[];
  optionalContextMemoryIds: string[];
  inspectBeforeUseMemoryIds: string[];
  doNotUseMemoryIds: string[];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
}): AionisAgentContext["command_posture"] {
  const entries = entryById(args.memoryEntries);
  const rehydrateIds = new Set(args.rehydrateHints.map((hint) => hint.memory_id));
  const seen = new Set<string>();
  const rows: AionisAgentContext["command_posture"] = [];
  const push = (row: AionisAgentContext["command_posture"][number]) => {
    const key = `${row.posture}:${row.memory_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      ...row,
      target_files: compactStrings(row.target_files).slice(0, 6),
      workflow_steps: compactStrings(row.workflow_steps).slice(0, 3),
      acceptance_checks: compactStrings(row.acceptance_checks).slice(0, 3),
      verification_summary: compactStrings(row.verification_summary).slice(0, 2),
      artifact_hints: compactStrings(row.artifact_hints).slice(0, 2),
    });
  };
  const entryFiles = (entry: MemoryPacketEntry | null | undefined): string[] =>
    compactStrings(entry?.target_files ?? []).slice(0, 6);
  const entryExecutionEvidence = (entry: MemoryPacketEntry | null | undefined) => ({
    workflow_steps: compactStrings(entry?.execution_state?.workflow_steps ?? []).slice(0, 3),
    acceptance_checks: executionAcceptanceChecksForCommandPosture(entry).slice(0, 3),
    verification_summary: compactStrings(entry?.execution_state?.verification_summary ?? []).slice(0, 2),
    artifact_hints: compactStrings(entry?.execution_state?.artifact_hints ?? []).slice(0, 2),
    ...(entry?.execution_state ? {
      execution_state: {
        summary_kind: entry.execution_state.summary_kind,
        transition_kind: entry.execution_state.transition_kind,
        actor_role: entry.execution_state.actor_role,
        handoff_target: entry.execution_state.handoff_target,
        next_action_hint: entry.execution_state.next_action_hint,
        execution_outcome_role: entry.execution_state.execution_outcome_role,
      },
    } : {}),
  });
  const label = (memoryId: string): string => {
    const entry = entries.get(memoryId);
    return entry ? memoryEntryAuditLabel(entry) : memoryId;
  };

  for (const memoryId of args.doNotUseMemoryIds) {
    const entry = entries.get(memoryId);
    push({
      posture: "must_not",
      surface: "do_not_use",
      memory_id: memoryId,
      instruction: "Do not continue, extend, cite as authority, or revive this memory as usable next-action guidance; if inspected, treat it only as counter-evidence or reference.",
      reason: entry
        ? `${memoryEntryAuditLabel(entry)} is classified as blocked, failed, stale, suppressed, or do-not-use history.`
        : `${memoryId} is classified as do-not-use history.`,
      target_files: entryFiles(entry),
      ...entryExecutionEvidence(entry),
    });
  }

  for (const hint of args.rehydrateHints) {
    const entry = entries.get(hint.memory_id);
    push({
      posture: "rehydrate_first",
      surface: "rehydrate",
      memory_id: hint.memory_id,
      instruction: "Recover the raw payload or execution trace before relying on exact details.",
      reason: hint.reason,
      target_files: entryFiles(entry),
      ...entryExecutionEvidence(entry),
    });
  }

  for (const memoryId of args.inspectBeforeUseMemoryIds) {
    if (rehydrateIds.has(memoryId)) continue;
    const entry = entries.get(memoryId);
    push({
      posture: "inspect_first",
      surface: "inspect_before_use",
      memory_id: memoryId,
      instruction: "Inspect only as risk or evidence; do not use as the primary implementation route or override should_continue guidance.",
      reason: `${label(memoryId)} is candidate, contested, stale-risk, or otherwise not direct-use safe.`,
      target_files: entryFiles(entry),
      ...entryExecutionEvidence(entry),
    });
  }

  for (const memoryId of args.useNowMemoryIds) {
    const entry = entries.get(memoryId);
    if (entry && (contractEntryIsCurrentState(entry) || contractEntryIsProcedure(entry))) {
      const current = contractEntryIsCurrentState(entry);
      push({
        posture: "should_continue",
        surface: current ? "current" : "procedure",
        memory_id: memoryId,
        instruction: current
          ? "Prefer continuing this current active state before widening discovery."
          : "Reuse this accepted execution procedure when the current task scope matches.",
        reason: `${memoryEntryAuditLabel(entry)} survived lifecycle, authority, and negative-transfer gates for direct use.`,
        target_files: entryFiles(entry),
        ...entryExecutionEvidence(entry),
      });
      continue;
    }
    push({
      posture: "optional_context",
      surface: "use_now",
      memory_id: memoryId,
      instruction: "Use as contextual support only; do not override current evidence or higher-authority state.",
      reason: `${label(memoryId)} is available in use_now but is not an execution-state command.`,
      target_files: entryFiles(entry),
      ...entryExecutionEvidence(entry),
    });
  }

  for (const memoryId of args.optionalContextMemoryIds) {
    if (args.useNowMemoryIds.includes(memoryId)) continue;
    if (args.inspectBeforeUseMemoryIds.includes(memoryId)) continue;
    if (args.doNotUseMemoryIds.includes(memoryId)) continue;
    if (rehydrateIds.has(memoryId)) continue;
    const entry = entries.get(memoryId);
    push({
      posture: "optional_context",
      surface: "context",
      memory_id: memoryId,
      instruction: "Use as background context only; do not treat this as the active route or next implementation command.",
      reason: entry
        ? `${memoryEntryAuditLabel(entry)} is active context but lacks current-state, procedure, accepted-route, or handoff evidence for direct action.`
        : `${memoryId} is optional context and lacks direct-action authority.`,
      target_files: entryFiles(entry),
      ...entryExecutionEvidence(entry),
    });
  }

  return rows.slice(0, 14);
}

function executionStateRehydrateHints(args: {
  entries: MemoryPacketEntry[];
  rehydrationRequested: boolean;
}): AionisAgentContext["rehydrate_hints"] {
  return args.entries
    .filter(memoryEntryRehydrateSurface)
    .map((entry) => ({
      memory_id: entry.memory_id,
      reason: entry.execution_state?.transition_kind === "request_rehydrate"
        ? "Execution state requests payload rehydration before relying on raw or exact evidence."
        : "Memory is a rehydration candidate; expand payload before relying on summary-only context.",
      required: args.rehydrationRequested,
    }))
    .slice(0, 6);
}

function riskAtLeast(current: AionisRiskLevel, minimum: AionisRiskLevel): AionisRiskLevel {
  const rank: Record<AionisRiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return rank[current] >= rank[minimum] ? current : minimum;
}

function compileAgentContextSurfaces(args: {
  rawUseNow: string[];
  rawInspectBeforeUse: string[];
  rawDoNotUse: string[];
  rawTargetFiles: string[];
  memoryEntries: MemoryPacketEntry[];
  rawActionableHistoryUsed: boolean;
  rawRecommendedPosture: AionisAgentContext["recommended_posture"];
  rawAuthority: AionisAgentContext["authority"];
  rawRisk: AionisAgentContext["risk"];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
  premiseFirewall: PremiseFirewallProjection;
  lifecycleCandidateSignals: AionisLifecycleCandidateSignal[];
  verifiedHandoffMemoryIds: Set<string>;
  executionScope: NormalizedAgentPromptExecutionScope;
}): {
  historyUsed: boolean;
  actionableHistoryUsed: boolean;
  recommendedPosture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
  targetFiles: string[];
  useNow: string[];
  inspectBeforeUse: string[];
  doNotUse: string[];
  useNowMemoryIds: string[];
  optionalContextMemoryIds: string[];
  inspectBeforeUseMemoryIds: string[];
  doNotUseMemoryIds: string[];
  risk: AionisAgentContext["risk"];
  governanceDecisions: GovernanceDecisionV1[];
} {
  const rehydrateHintIds = new Set(args.rehydrateHints.map((hint) => hint.memory_id));
  const rehydrateSurfaceIds = new Set([
    ...rehydrateHintIds,
    ...args.memoryEntries.filter(memoryEntryRehydrateSurface).map((entry) => entry.memory_id),
  ]);
  const lifecycleCandidateSignalsById = lifecycleCandidateSignalsByMemoryId(args.lifecycleCandidateSignals);
  const lifecycleCandidateAdmittedUseNowIds = new Set(
    args.memoryEntries
      .filter((entry) => lifecycleCandidateMemoryDirectUseAdmissible({
        entry,
        signals: lifecycleCandidateSignalsById.get(entry.memory_id) ?? [],
      }))
      .map((entry) => entry.memory_id),
  );
  const lifecycleCandidateDirectUseProtectedIds = new Set(
    args.memoryEntries
      .filter((entry) => lifecycleCandidateMemoryDirectUseProtected({
        entry,
        signals: lifecycleCandidateSignalsById.get(entry.memory_id) ?? [],
      }))
      .map((entry) => entry.memory_id),
  );
  const verifiedHandoffDirectUseIds = new Set(
    args.memoryEntries
      .filter((entry) => verifiedHandoffDirectUseEligible(entry, args.verifiedHandoffMemoryIds))
      .map((entry) => entry.memory_id),
  );
  const usableEntries = args.memoryEntries.filter((entry) =>
    !rehydrateSurfaceIds.has(entry.memory_id)
    && !memoryEntryBlocked(entry)
    && (
      memoryEntryUsable(entry)
      || lifecycleCandidateAdmittedUseNowIds.has(entry.memory_id)
      || verifiedHandoffDirectUseEligible(entry, args.verifiedHandoffMemoryIds)
    )
  );
  const deniedPathTargets = deniedAgentActionPathTargets(args.memoryEntries);
  const hasUsableMemory = usableEntries.length > 0;
  const hasRawGuideSurface =
    args.rawTargetFiles.length > 0
    || args.rawUseNow.length > 0
    || args.rawInspectBeforeUse.length > 0
    || args.rawDoNotUse.length > 0
    || args.rehydrateHints.length > 0;
  const trustedConflict = trustedWorkflowConflictAudit(args.memoryEntries);
  const trustedWorkflowConflictInspectIds = new Set(
    trustedConflict.conflictedEntries.map((entry) => entry.memory_id),
  );
  const premiseInspectIds = new Set(args.premiseFirewall.inspectBeforeUseMemoryIds.filter((memoryId) =>
    !lifecycleCandidateDirectUseProtectedIds.has(memoryId)
    && !verifiedHandoffDirectUseIds.has(memoryId)
  ));
  const premiseDoNotUseIds = new Set(args.premiseFirewall.doNotUseMemoryIds);
  const premiseInspectBeforeUse = args.premiseFirewall.inspectBeforeUse.filter((line) =>
    !args.memoryEntries.some((entry) =>
      (lifecycleCandidateDirectUseProtectedIds.has(entry.memory_id) || verifiedHandoffDirectUseIds.has(entry.memory_id))
      && textMatchesMemoryEntry(line, entry)
    )
  );
  const premiseRiskReasons = premiseInspectIds.size > 0
    || premiseDoNotUseIds.size > 0
    || premiseInspectBeforeUse.length > 0
    || args.premiseFirewall.doNotUse.length > 0
      ? args.premiseFirewall.riskReasons
      : [];
  const lifecycleCandidateInspectIds = new Set(lifecycleCandidateInspectMemoryIds(args.lifecycleCandidateSignals).filter((memoryId) =>
    !lifecycleCandidateDirectUseProtectedIds.has(memoryId)
    && !verifiedHandoffDirectUseIds.has(memoryId)
  ));
  const memoryContractRiskReasonList = compactStrings([
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "evidence_only") ? "memory_contract_evidence_only_kept_out_of_use_now" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "inspect_before_use") ? "memory_contract_requires_inspection" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "do_not_use") ? "memory_contract_blocks_direct_use" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.evidence_requirement === "requires_more_evidence") ? "memory_contract_requires_more_evidence" : null,
  ]).slice(0, 4);
  const governanceDecisions = args.memoryEntries.map((entry) => governanceDecisionForMemoryEntry({
    entry,
    executionScope: args.executionScope,
    premiseConflict: premiseDoNotUseIds.has(entry.memory_id)
      ? "block"
      : premiseInspectIds.has(entry.memory_id) ? "inspect" : "none",
    trustedWorkflowConflict: trustedWorkflowConflictInspectIds.has(entry.memory_id),
    verifiedRecoveredHandoff: verifiedHandoffDirectUseIds.has(entry.memory_id),
    rehydrateRequested: rehydrateSurfaceIds.has(entry.memory_id),
    projectedSurface: args.rawUseNow.some((line) =>
      !backgroundWorkflowUseNowLine(line) && textMatchesMemoryEntry(line, entry)
    ) ? "use_now" : null,
    lifecycleCandidate: lifecycleCandidateRehydrateEligible({
      entry,
      signals: lifecycleCandidateSignalsById.get(entry.memory_id) ?? [],
    })
      ? "rehydrate"
      : lifecycleCandidateAdmittedUseNowIds.has(entry.memory_id)
        ? "direct_use"
        : lifecycleCandidateInspectIds.has(entry.memory_id) ? "inspect_before_use" : "none",
  }));
  const decisionByMemoryId = new Map(governanceDecisions.map((decision) => [decision.memory_id, decision]));
  const entriesForSurface = (surface: AionisMemoryDecisionSurface): MemoryPacketEntry[] =>
    args.memoryEntries.filter((entry) => decisionByMemoryId.get(entry.memory_id)?.surface === surface);
  const blockedEntries = entriesForSurface("do_not_use");
  const inspectDecisionEntries = entriesForSurface("inspect_before_use");
  const directUseMemoryEntries = entriesForSurface("use_now");
  const optionalContextEntries = args.memoryEntries.filter((entry) =>
    decisionByMemoryId.get(entry.memory_id)?.reason_codes.includes("optional_context_only")
  );
  const deniedNormalizedPathTargets = new Set(compactStrings([...deniedPathTargets].map(normalizePathTarget)));
  const memoryUseNow = compactStrings(directUseMemoryEntries.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)));
  const memoryUseNowPathTargets = compactStrings(memoryUseNow.flatMap(extractPathTargets));
  const memoryUseNowStructuredTargets = compactStrings(
    directUseMemoryEntries
      .flatMap(memoryEntryPathTargets)
      .filter((target) => {
        const normalized = normalizePathTarget(target);
        return !normalized || !deniedNormalizedPathTargets.has(normalized);
      }),
  );
  const memoryUseNowPathTargetSet = new Set(memoryUseNowPathTargets);

  const inspectLineForEntry = (entry: MemoryPacketEntry): string => {
    if (memoryContractInspectBeforeUse(entry)) return memoryContractInspectLine(entry);
    const signals = lifecycleCandidateSignalsById.get(entry.memory_id) ?? [];
    if (lifecycleCandidateMemoryDirectUseUnsafe(signals)) return lifecycleCandidateInspectLine({ entry, signals });
    if (trustedWorkflowConflictInspectIds.has(entry.memory_id)) {
      return `Inspect conflicting trusted workflow: ${memoryEntryLabel(entry)}`;
    }
    return memoryEntryInspectLine(entry);
  };
  const movedToInspect: string[] = [];
  const movedToDoNotUse: string[] = [];
  const filteredUseNow = args.rawUseNow.filter((line) => {
    const memory = args.memoryEntries.find((entry) => textMatchesMemoryEntry(line, entry));
    const surface = memory ? decisionByMemoryId.get(memory.memory_id)?.surface : null;
    if (memory && surface === "do_not_use") movedToDoNotUse.push(`Blocked memory: ${memoryEntryLabel(memory)}`);
    if (memory && surface === "inspect_before_use") movedToInspect.push(inspectLineForEntry(memory));
    if (surface && surface !== "use_now") return false;
    if (executionEvidenceUseNowLine(line)) return true;
    if (backgroundWorkflowUseNowLine(line)) return false;
    return directUseMemoryEntries.length > 0 || args.rawTargetFiles.length > 0 || args.memoryEntries.length === 0;
  });

  const rawTargetFiles = args.rawTargetFiles.filter((target) =>
    !deniedPathTargets.has(target) || memoryUseNowPathTargetSet.has(target)
  );
  const targetFiles = hasUsableMemory || rawTargetFiles.length > 0
      ? compactStrings([
        ...rawTargetFiles,
        ...memoryUseNowStructuredTargets,
        ...memoryUseNowPathTargets,
      ]).slice(0, 8)
    : [];
  const inspectBeforeUse = compactStrings([
    ...args.rawInspectBeforeUse,
    ...premiseInspectBeforeUse,
    ...movedToInspect,
    ...inspectDecisionEntries.map(inspectLineForEntry),
  ]).slice(0, 5);
  const doNotUse = compactStrings([
    ...args.rawDoNotUse,
    ...args.premiseFirewall.doNotUse,
    ...movedToDoNotUse,
    ...blockedEntries.map((entry) => `Blocked memory: ${memoryEntryLabel(entry)}`),
  ]).slice(0, 5);

  const hasRiskSurface = inspectBeforeUse.length > args.rawInspectBeforeUse.length
    || doNotUse.length > args.rawDoNotUse.length
    || inspectDecisionEntries.length > 0
    || blockedEntries.length > 0;
  const historyUsed = hasUsableMemory
    || inspectDecisionEntries.length > 0
    || blockedEntries.length > 0
    || hasRawGuideSurface;
  const actionableHistoryUsed =
    args.rawActionableHistoryUsed
    || governanceDecisions.some((decision) => decision.surface !== "not_agent_facing")
    || args.rehydrateHints.length > 0;
  let negativeTransferRisk = args.rawRisk.negative_transfer_risk;
  if (blockedEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "high");
  else if (inspectDecisionEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "medium");

  const requiredRehydration = args.rehydrateHints.some((hint) => hint.required);
  const recommendedPosture: AionisAgentContext["recommended_posture"] = !actionableHistoryUsed
    ? "ignore_history"
    : hasRiskSurface
      ? "inspect_before_use"
      : requiredRehydration
        ? "rehydrate_before_use"
      : args.rawRecommendedPosture === "ignore_history"
        ? "use_as_context"
        : args.rawRecommendedPosture;

  const usableAuthority: AionisAgentContext["authority"] = args.rawAuthority === "trusted"
    ? "trusted"
    : args.rawAuthority === "advisory"
      ? "advisory"
      : usableEntries.some((entry) => entry.authority === "trusted")
    ? "trusted"
    : usableEntries.some((entry) => entry.authority === "advisory")
      ? "advisory"
      : args.rawAuthority;

  const authority: AionisAgentContext["authority"] = !actionableHistoryUsed
    ? "none"
    : trustedConflict.hasConflict && hasUsableMemory
      ? "advisory"
      : hasUsableMemory
      ? usableAuthority === "none" ? "advisory" : usableAuthority
      : blockedEntries.length > 0
        ? "blocked"
        : inspectDecisionEntries.length > 0
          ? "candidate"
          : args.rawAuthority;

  return {
    historyUsed,
    actionableHistoryUsed,
    recommendedPosture,
    authority,
    targetFiles,
    useNow: compactStrings([
      ...filteredUseNow,
      ...directUseMemoryEntries.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)),
    ]).slice(0, 6),
    inspectBeforeUse,
    doNotUse,
    useNowMemoryIds: compactStrings(directUseMemoryEntries.map((entry) => entry.memory_id)).slice(0, 10),
    optionalContextMemoryIds: compactStrings(optionalContextEntries.map((entry) => entry.memory_id)).slice(0, 10),
    inspectBeforeUseMemoryIds: compactStrings(inspectDecisionEntries.map((entry) => entry.memory_id)).slice(0, 10),
    doNotUseMemoryIds: compactStrings(blockedEntries.map((entry) => entry.memory_id)).slice(0, 10),
    governanceDecisions,
    risk: {
      negative_transfer_risk: negativeTransferRisk,
      blocked_authority_count: args.rawRisk.blocked_authority_count + blockedEntries.length,
      stale_memory_count: args.rawRisk.stale_memory_count,
      reasons: compactStrings([
        trustedConflict.hasConflict ? "trusted_workflow_conflict_requires_inspection" : null,
        ...trustedConflict.reasons,
        inspectDecisionEntries.some(memoryEntryInspectBeforeUse) ? "candidate_or_contested_memory_kept_out_of_use_now" : null,
        lifecycleCandidateAdmittedUseNowIds.size > 0 ? "lifecycle_candidate_current_or_procedure_admitted" : null,
        blockedEntries.length > 0 ? "blocked_or_suppressed_memory_kept_out_of_use_now" : null,
        lifecycleCandidateInspectIds.size > 0 ? "lifecycle_candidate_kept_out_of_use_now" : null,
        args.rehydrateHints.length > 0 ? "rehydration_hint_available" : null,
        requiredRehydration ? "rehydration_required_before_use" : null,
        ...memoryContractRiskReasonList,
        ...premiseRiskReasons,
        ...args.rawRisk.reasons,
      ]).slice(0, 5),
    },
  };
}

export function buildAionisAgentContext(args: BuildAionisAgentContextArgs): AionisAgentContext {
  const guide = args.guide_packet ?? null;
  const memory = args.memory_packet ?? null;
  const agentRole = args.agent_role ?? "agent";
  const agentContextMode = args.agent_context_mode === "compact_agent" ? "compact_agent" : "standard";
  const guideBrief = guide?.guide_brief ?? null;
  const memoryEntryCount = memory?.relevant_memories.length ?? 0;
  const rawHistoryUsed = guideBrief?.history_used === true || memoryEntryCount > 0;
  const rawActionableHistoryUsed = guideBrief?.actionable_history_used === true;
  const rawTargetFiles = compactStrings([
    ...(guide?.recovered_state.target_files ?? []),
  ]).slice(0, 8);
  const rehydrateHintIds = new Set<string>();
  const memoryEntriesById = new Map((memory?.relevant_memories ?? []).map((entry) => [entry.memory_id, entry]));
  const rehydrationRequested =
    guideBrief?.recommended_posture === "rehydrate_before_use"
    || queryRequestsRehydration(args.query_intent_override)
    || queryRequestsRehydration(memory?.query.intent ?? null);
  const lifecycleCandidateSignals = inferLifecycleCandidateSignals({
    entries: memory?.relevant_memories ?? [],
    query_intent: args.query_intent_override ?? memory?.query.intent ?? null,
  });
  const rawRehydrateHints: AionisAgentContext["rehydrate_hints"] = [
    ...(guide?.memory_lifecycle.rehydration_hints ?? []),
    ...(guideBrief?.rehydrate ?? []),
    ...(memory?.lifecycle.rehydration_hints ?? []).map((hint) => ({
      memory_id: hint.memory_id,
      reason: hint.reason,
      required: hint.required,
    })),
    ...executionStateRehydrateHints({
      entries: memory?.relevant_memories ?? [],
      rehydrationRequested,
    }),
    ...lifecycleCandidateRehydrateHints({
      entries: memory?.relevant_memories ?? [],
      signals: lifecycleCandidateSignals,
      rehydrationRequested,
    }),
  ].filter((hint) => {
    if (rehydrateHintIds.has(hint.memory_id)) return false;
    rehydrateHintIds.add(hint.memory_id);
    return true;
  }).slice(0, 6);
  const rawMemoryIds = compactStrings([
    ...(guide?.memory_lifecycle.used_memory_ids ?? []),
    ...(memory?.lifecycle.used_memory_ids ?? []),
    ...rawRehydrateHints.map((entry) => entry.memory_id),
  ]).slice(0, 10);
  const recoveredStateHasVerifiedHandoff =
    guide?.recovered_state.resumable === true
    && rawTargetFiles.length > 0
    && (guide?.recovered_state.acceptance_checks.length ?? 0) > 0;
  const verifiedHandoffMemoryIds = new Set<string>();
  if (recoveredStateHasVerifiedHandoff) {
    for (const memoryId of guide?.recovered_state.handoff_ids ?? []) {
      if (memoryId) verifiedHandoffMemoryIds.add(memoryId);
    }
    const rawTargetSet = new Set(rawTargetFiles.map((target) => target.trim().toLowerCase()).filter(Boolean));
    const recoveredMemoryIdSet = new Set(rawMemoryIds);
    for (const entry of memory?.relevant_memories ?? []) {
      if (!recoveredMemoryIdSet.has(entry.memory_id)) continue;
      if (!contractEntryIsHandoff(entry)) continue;
      if (!entry.target_files.some((target) => routeTargetMatchesExplicitTarget(target, rawTargetSet))) continue;
      verifiedHandoffMemoryIds.add(entry.memory_id);
    }
  }
  const executionScope = normalizeAgentPromptExecutionScope(args.execution_scope);
  const { promptEntries, excludedEntries } = filterMemoryEntriesForAgentPromptScope({
    memoryEntries: memory?.relevant_memories ?? [],
    executionScope,
    verifiedHandoffMemoryIds,
  });
  const rehydrateHints = rawRehydrateHints.filter((hint) => {
    if (!agentPromptMemoryIdAllowed({
      memoryId: hint.memory_id,
      memoryEntriesById,
      executionScope,
      verifiedHandoffMemoryIds,
    })) return false;
    const entry = memoryEntriesById.get(hint.memory_id);
    const lifecycleSignals = lifecycleCandidateSignals.filter((signal) => signal.memory_id === hint.memory_id);
    return (!entry
        || memoryEntryRehydrateEligible(entry)
        || lifecycleCandidateRehydrateEligible({ entry, signals: lifecycleSignals }))
      && (
        hint.required
        || rehydrationRequested
        || (entry
          ? memoryEntryRehydrateSurface(entry) || lifecycleCandidateRehydrateEligible({ entry, signals: lifecycleSignals })
          : false)
      );
  });
  const memoryIds = rawMemoryIds.filter((memoryId) => agentPromptMemoryIdAllowed({
    memoryId,
    memoryEntriesById,
    executionScope,
    verifiedHandoffMemoryIds,
  })).slice(0, 10);
  const promptTargetFiles = executionScope.task_signature && promptEntries.length === 0
    ? []
    : rawTargetFiles;
  const workflowIds = compactStrings(
    guide?.guidance.workflow_candidates.map((entry) => entry.workflow_id) ?? [],
  ).slice(0, 10);
  const evidenceCount =
    (memory?.evidence_trail.length ?? 0)
    + (guide?.proven_facts.length ?? 0)
    + (guide?.guidance.workflow_candidates.reduce((sum, entry) => sum + entry.evidence_count, 0) ?? 0);
  const risk = {
    negative_transfer_risk:
      guide?.risk.negative_transfer_risk
      ?? memory?.risk.negative_transfer_risk
      ?? "low",
    blocked_authority_count: guide?.risk.blocked_authority_count ?? 0,
    stale_memory_count:
      guide?.risk.stale_memory_count
      ?? memory?.forgetting_state.stale_memory_count
      ?? memory?.risk.stale_memory_count
      ?? 0,
    reasons: compactStrings(guide?.risk.reasons ?? []).slice(0, 5),
  };
  const rawSummary =
    guideBrief?.history_used === true
      ? guideBrief.summary
      : memoryEntryCount > 0
        ? "Relevant Aionis memory is available as compact context."
        : "No usable Aionis history was recovered.";
  const rawRecommendedPosture =
    guideBrief?.recommended_posture
    ?? (rawHistoryUsed ? "use_as_context" : "ignore_history");
  const rawAuthority = guideBrief?.authority ?? "candidate";
  const surfaces = compileAgentContextSurfaces({
    rawUseNow: filterRawGuideLinesForAgentPromptScope({
      lines: compactStrings(guideBrief?.use_now ?? []).slice(0, 8),
      surface: "use_now",
      executionScope,
      promptEntries,
      excludedEntries,
    }),
    rawInspectBeforeUse: filterRawGuideLinesForAgentPromptScope({
      lines: compactStrings(guideBrief?.inspect_before_use ?? []).slice(0, 8),
      surface: "inspect_before_use",
      executionScope,
      promptEntries,
      excludedEntries,
    }),
    rawDoNotUse: filterRawGuideLinesForAgentPromptScope({
      lines: compactStrings(guideBrief?.do_not_use ?? []).slice(0, 8),
      surface: "do_not_use",
      executionScope,
      promptEntries,
      excludedEntries,
    }),
    rawTargetFiles: promptTargetFiles,
    memoryEntries: promptEntries,
    rawActionableHistoryUsed,
    rawRecommendedPosture,
    rawAuthority,
    rawRisk: risk,
    rehydrateHints,
    premiseFirewall: buildPremiseFirewallProjection({
      queryIntent: args.query_intent_override ?? memory?.query.intent ?? null,
      memoryEntries: promptEntries,
      evidenceTrail: memory?.evidence_trail ?? [],
    }),
    lifecycleCandidateSignals: lifecycleCandidateSignals.filter((signal) =>
      agentPromptMemoryIdAllowed({
        memoryId: signal.memory_id,
        memoryEntriesById,
        executionScope,
        verifiedHandoffMemoryIds,
      })
    ),
    verifiedHandoffMemoryIds,
    executionScope,
  });
  const summary = surfaces.historyUsed
    ? rawSummary
    : "No usable Aionis history was recovered for the Agent context.";
  const commandPosture = buildAgentContextCommandPostures({
    memoryEntries: promptEntries,
    useNowMemoryIds: surfaces.useNowMemoryIds,
    optionalContextMemoryIds: surfaces.optionalContextMemoryIds,
    inspectBeforeUseMemoryIds: surfaces.inspectBeforeUseMemoryIds,
    doNotUseMemoryIds: surfaces.doNotUseMemoryIds,
    rehydrateHints,
  });
  const routeContract = buildAgentRouteContract({
    targetFiles: surfaces.targetFiles,
    commandPosture,
  });
  const baseContext = parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: guide?.tenant_id ?? memory?.tenant_id ?? args.tenant_id,
    scope: guide?.scope ?? memory?.scope ?? args.scope,
    agent_role: agentRole,
    agent_context_mode: agentContextMode,
    task_context_profile: args.task_context_profile ?? "general",
    prompt_text: "pending",
    summary,
    history_used: surfaces.historyUsed,
    actionable_history_used: surfaces.actionableHistoryUsed,
    recommended_posture: surfaces.recommendedPosture,
    authority: surfaces.authority,
    target_files: surfaces.targetFiles,
    use_now: surfaces.useNow,
    inspect_before_use: surfaces.inspectBeforeUse,
    do_not_use: surfaces.doNotUse,
    memory_ids: memoryIds,
    use_now_memory_ids: surfaces.useNowMemoryIds,
    inspect_before_use_memory_ids: surfaces.inspectBeforeUseMemoryIds,
    do_not_use_memory_ids: surfaces.doNotUseMemoryIds,
    command_posture: commandPosture,
    route_contract: routeContract,
    prompt_aliases: [],
    rehydrate_hints: rehydrateHints,
    risk: surfaces.risk,
    evidence_refs: {
      memory_ids: memoryIds,
      workflow_ids: workflowIds,
      evidence_count: evidenceCount,
    },
  });
  return compileAionisAgentContext({
    base_context: baseContext,
    governance_decisions: surfaces.governanceDecisions,
    current_execution_state: args.current_execution_state ?? null,
    claim_projection: args.claim_projection ?? null,
    task_role_context: {
      agent_role: agentRole,
      task_context_profile: args.task_context_profile ?? "general",
    },
    render_profile: {
      mode: agentContextMode,
      detail: args.render_detail
        ?? (agentContextMode === "compact_agent"
          ? "contract"
          : args.context_compaction_profile === "aggressive" ? "contract" : "standard"),
      context_char_budget: args.context_char_budget ?? null,
    },
  });
}

export function applyAionisInspectBeforeUseActiveProjection(
  args: ApplyAionisInspectBeforeUseActiveProjectionArgs,
): AionisAgentContext {
  const memory = args.memory_packet ?? null;
  const currentUseNowIds = new Set(args.agent_context.use_now_memory_ids);
  const candidateIds = new Set(compactStrings(args.candidate_memory_ids));
  const memoryEntries = memory?.relevant_memories ?? [];
  const entriesToMove = memoryEntries.filter((entry) =>
    candidateIds.has(entry.memory_id)
    && currentUseNowIds.has(entry.memory_id)
  );
  if (entriesToMove.length === 0) return args.agent_context;

  const movingIds = new Set(entriesToMove.map((entry) => entry.memory_id));
  const deniedPathTargets = deniedAgentActionPathTargets(memoryEntries);
  const generatedUseNowLines = new Set(compactStrings(
    entriesToMove.map((entry) => memoryEntryUseNowLine(entry, deniedPathTargets)),
  ));
  const movedInspectLines = compactStrings(entriesToMove.map(memoryEntryInspectLine));
  const useNow = compactStrings(args.agent_context.use_now.filter((entry) =>
    !generatedUseNowLines.has(entry)
  )).slice(0, 6);
  const inspectBeforeUse = compactStrings([
    ...args.agent_context.inspect_before_use,
    ...movedInspectLines,
  ]).slice(0, 5);
  const useNowMemoryIds = compactStrings(args.agent_context.use_now_memory_ids.filter((memoryId) =>
    !movingIds.has(memoryId)
  )).slice(0, 10);
  const inspectBeforeUseMemoryIds = compactStrings([
    ...args.agent_context.inspect_before_use_memory_ids,
    ...entriesToMove.map((entry) => entry.memory_id),
  ]).slice(0, 10);
  const negativeTransferRisk = riskAtLeast(args.agent_context.risk.negative_transfer_risk, "medium");
  const risk = {
    ...args.agent_context.risk,
    negative_transfer_risk: negativeTransferRisk,
    reasons: compactStrings([
      ...args.agent_context.risk.reasons,
      args.reason,
    ]).slice(0, 5),
  };
  const authority: AionisAgentContext["authority"] = args.agent_context.authority === "trusted"
    ? "advisory"
    : args.agent_context.authority;
  const recommendedPosture: AionisAgentContext["recommended_posture"] = args.agent_context.history_used
    ? "inspect_before_use"
    : args.agent_context.recommended_posture;
  const commandPosture = buildAgentContextCommandPostures({
    memoryEntries,
    useNowMemoryIds,
    optionalContextMemoryIds: args.agent_context.command_posture
      .filter((entry) => entry.posture === "optional_context" && !movingIds.has(entry.memory_id))
      .map((entry) => entry.memory_id),
    inspectBeforeUseMemoryIds,
    doNotUseMemoryIds: args.agent_context.do_not_use_memory_ids,
    rehydrateHints: args.agent_context.rehydrate_hints,
  });
  const routeContract = buildAgentRouteContract({
    targetFiles: args.agent_context.target_files,
    commandPosture,
  });
  const projected = parseAionisAgentContext({
    ...args.agent_context,
    prompt_text: "pending",
    recommended_posture: recommendedPosture,
    authority,
    use_now: useNow,
    inspect_before_use: inspectBeforeUse,
    use_now_memory_ids: useNowMemoryIds,
    inspect_before_use_memory_ids: inspectBeforeUseMemoryIds,
    command_posture: commandPosture,
    route_contract: routeContract,
    risk,
  });
  return parseAionisAgentContext({
    ...projected,
    prompt_text: renderAionisAgentPrompt({
      context: projected,
      profile: {
        mode: projected.agent_context_mode,
        detail: projected.agent_context_mode === "compact_agent" ? "compact" : "standard",
        context_char_budget: args.context_char_budget ?? null,
      },
    }),
  });
}
