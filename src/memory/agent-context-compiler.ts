import { AionisAgentContextSchema, type AionisAgentContext, type AionisClaimLedgerProjection } from "./product-output-contract.js";
import type { GovernanceDecisionV1 } from "./governance-contract.js";
import { renderAionisAgentPrompt, type AgentContextRenderProfile } from "./agent-context-renderer.js";

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
