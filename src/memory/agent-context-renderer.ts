import type { AionisAgentContext, AionisTaskContextProfile } from "./product-output-contract.js";

export type AgentContextRenderProfile = {
  mode: "standard" | "compact_agent";
  detail: "standard" | "full_power" | "contract" | "compact";
  context_char_budget: number | null;
};

function compactText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

function taskProfileLine(profile: AionisTaskContextProfile, compact: boolean): string | null {
  switch (profile) {
    case "coding_verifier":
      return compact
        ? "task coding_verifier: run non-excluded acceptance checks; no skip/deselect unless task says so"
        : "task_profile: coding_verifier; tests and verifiers are acceptance evidence; do not skip, deselect, or ignore non-excluded checks.";
    case "document_integrity":
      return compact
        ? "task document_integrity: preserve original file identity; verify moved/copied documents"
        : "task_profile: document_integrity; preserve original file bytes, names, and identity unless transformation is explicitly required.";
    case "long_qa":
      return compact
        ? "task long_qa: answer from covered evidence; rehydrate missing source spans"
        : "task_profile: long_qa; answer from covered evidence and rehydrate missing source spans before finalizing.";
    case "multi_agent_handoff":
      return compact
        ? "task multi_agent_handoff: preserve owner/role/current handoff"
        : "task_profile: multi_agent_handoff; preserve role ownership, current handoff state, and verifier/reviewer boundaries.";
    case "loop_engineering":
      return compact
        ? "task loop_engineering: preserve plan/iteration/validator/repair/stop reason"
        : "task_profile: loop_engineering; preserve plan, iteration, validation result, repair attempt, and stop reason.";
    case "general": return null;
  }
}

function roleFocusLine(role: AionisAgentContext["agent_role"]): string | null {
  switch (role) {
    case "planner": return "role_focus: plan from current state, assign bounded next work, and inspect risk before widening scope";
    case "worker": return "role_focus: execute use_now items, inspect uncertain history, and avoid do_not_use branches";
    case "verifier": return "role_focus: verify acceptance checks, treat history as claims to check, and preserve failure evidence";
    case "reviewer": return "role_focus: review branch status, continue the active passed path, and keep failed branches as counter-evidence";
    case "agent": return null;
  }
}

function postureLabel(value: AionisAgentContext["recommended_posture"]): string {
  switch (value) {
    case "reuse_supported_history": return "reuse";
    case "use_as_context": return "context";
    case "inspect_before_use": return "inspect";
    case "rehydrate_before_use": return "rehydrate";
    case "ignore_history": return "ignore";
  }
}

function commandPostureLine(
  context: AionisAgentContext,
  compact: boolean,
  aliases?: Map<string, string>,
): string | null {
  const labels = compact
    ? { must_not: "no", should_continue: "go", inspect_first: "chk", rehydrate_first: "raw", optional_context: "ctx" }
    : { must_not: "must_not", should_continue: "should_continue", inspect_first: "inspect_first", rehydrate_first: "rehydrate_first", optional_context: "optional_context" };
  const grouped = new Map<string, string[]>();
  for (const row of context.command_posture) {
    const values = grouped.get(row.posture) ?? [];
    values.push(aliases?.get(row.memory_id) ?? row.memory_id);
    grouped.set(row.posture, values);
  }
  const parts = Object.entries(labels).flatMap(([posture, label]) => {
    const values = grouped.get(posture)?.slice(0, compact ? 3 : 4) ?? [];
    return values.length > 0 ? [`${label}=${values.join(",")}`] : [];
  });
  return parts.length > 0 ? `${compact ? "cmd" : "command_posture:"} ${parts.join(" ")}` : null;
}

function routeLines(context: AionisAgentContext, compact: boolean): string[] {
  const active = context.route_contract.active_targets.slice(0, compact ? 1 : 4).map((row) => row.target);
  const reference = context.route_contract.reference_only_targets.slice(0, compact ? 1 : 3).map((row) => row.target);
  const blocked = context.route_contract.blocked_direction_targets.slice(0, compact ? 1 : 3).map((row) => row.target);
  if (active.length === 0 && reference.length === 0 && blocked.length === 0) return [];
  const route = compact
    ? `route ${uniqueStrings([
        active.length > 0 ? "conflict=missing_active_not_superseded" : null,
        active.length > 0 ? "missing_action=create/restore/rehydrate/report" : null,
        active.length > 0 ? "exec=route_safe_patch_raw_if_needed" : null,
        active.length > 0 ? "after_raw=continue_if_consistent" : null,
        active.length > 0 ? "old_ref_not_supersede=1" : null,
        active.length > 0 ? `active=${active.join(",")}` : null,
        reference.length > 0 ? `ref_only=${reference.join(",")}` : null,
        blocked.length > 0 ? `block_dir=${blocked.join(",")}` : null,
        "no_fallback_to_ref=1",
      ]).join(" ")}`
    : `route_contract: ${uniqueStrings([
        active.length > 0 ? "conflict_policy=do_not_treat_missing_active_target_as_superseded" : null,
        active.length > 0 ? "if_active_target_missing=create_or_restore_or_rehydrate_or_report_conflict_before_fallback" : null,
        active.length > 0 ? "executable_evidence=route_safe_but_patch_may_require_rehydrate" : null,
        active.length > 0 ? "after_rehydrate=continue_allowed_action_if_task_consistent" : null,
        active.length > 0 ? "old_or_reference_target_presence_does_not_supersede_active_route" : null,
        active.length > 0 ? `active_targets=${active.join(",")}` : null,
        reference.length > 0 ? `reference_only_targets=${reference.join(",")}` : null,
        blocked.length > 0 ? `blocked_direction_targets=${blocked.join(",")}` : null,
        "fallback_policy=do_not_promote_reference_or_blocked_targets",
      ]).join("; ")}`;
  if (active.length === 0) return [route];
  const order = context.route_contract.action_policy.missing_active_target_preferred_order.join(">");
  return [route, compact
    ? `action missing_active=${order} terminal_inspect=0 raw_then_continue=1 conflict_after_raw_only=1 ref_fallback_raw_or_confirm=1`
    : `action_policy: missing_active_target_order=${order}; terminal_inspect_allowed=false; executable_evidence_policy=route_safe_but_patch_may_require_rehydrate; after_rehydrate_policy=continue_allowed_action_if_task_consistent; report_conflict_requires=rehydrate_unavailable_or_evidence_conflict; reference_fallback_requires=explicit_raw_evidence_or_operator_confirmation`];
}

function executionContractLine(context: AionisAgentContext): string | null {
  const postures = new Set(context.command_posture.map((row) => row.posture));
  const hasContinue = postures.has("should_continue");
  const hasInspect = postures.has("inspect_first");
  const hasBlocked = postures.has("must_not");
  const hasRehydrate = postures.has("rehydrate_first");
  const parts = uniqueStrings([
    hasContinue ? "SHOULD_CONTINUE is the primary next route when present" : null,
    hasContinue ? "Missing SHOULD_CONTINUE target is not stale proof; create, restore, rehydrate, or report conflict before fallback" : null,
    hasContinue && (hasInspect || hasBlocked) ? "Existing INSPECT_FIRST/MUST_NOT targets do not supersede SHOULD_CONTINUE just because they exist" : null,
    hasInspect ? "INSPECT_FIRST is reference-only evidence and must not replace SHOULD_CONTINUE" : null,
    hasBlocked ? "MUST_NOT blocks direction; inspect only as counter-evidence when necessary" : null,
    hasRehydrate ? "REHYDRATE_FIRST recovers raw evidence before exact use, then continue the consistent active route" : null,
  ]);
  return parts.length > 0 ? `execution_contract: ${parts.join("; ")}` : null;
}

function executionPriorityLine(context: AionisAgentContext): string | null {
  const postures = new Set(context.command_posture.map((row) => row.posture));
  const hasContinue = postures.has("should_continue");
  const hasInspect = postures.has("inspect_first");
  const hasBlocked = postures.has("must_not");
  const hasRehydrate = postures.has("rehydrate_first");
  const parts = uniqueStrings([
    hasContinue && hasInspect ? "go>chk" : null,
    hasContinue ? "go=primary_next_route" : null,
    hasContinue ? "missing_go=create_restore_raw_or_report_conflict_no_old" : null,
    hasRehydrate ? "raw_then_continue=1" : null,
    hasContinue && (hasInspect || hasBlocked) ? "old_ref_not_supersede_go=1" : null,
    hasInspect ? "chk=reference_only_not_primary" : null,
    hasBlocked ? "no=blocked_direction" : null,
  ]);
  return parts.length > 0 ? `priority: ${parts.join("; ")}` : null;
}

function evidenceLines(context: AionisAgentContext, compact: boolean, aliases?: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const fields = [
    ["workflow_steps", "step"],
    ["acceptance_checks", "check"],
    ["verification_summary", "verify"],
    ["artifact_hints", "artifact"],
  ] as const;
  for (const row of context.command_posture) {
    if (row.posture !== "should_continue" && row.posture !== "must_not") continue;
    for (const [field, label] of fields) {
      if (row.posture === "must_not" && field !== "verification_summary") continue;
      for (const value of row[field]) {
        const text = compactText(value, compact ? 78 : 180);
        if (!text || seen.has(`${label}:${text}`)) continue;
        seen.add(`${label}:${text}`);
        out.push(`${row.posture === "must_not" ? "avoid_verify" : label}: id=${aliases?.get(row.memory_id) ?? row.memory_id} n=${text}`);
        if (out.length >= (compact ? 5 : 10)) return out;
      }
    }
  }
  return out;
}

function aliasMap(context: AionisAgentContext): Map<string, string> {
  if (context.prompt_aliases.length > 0) {
    return new Map(context.prompt_aliases.map((row) => [row.memory_id, row.alias]));
  }
  return new Map(context.memory_ids.slice(0, 10).map((memoryId, index) => [memoryId, `m${index + 1}`]));
}

function executionMeta(
  context: AionisAgentContext,
  row: AionisAgentContext["command_posture"][number] | undefined,
): string {
  const state = row?.execution_state;
  if (!state) return "";
  const transition = state.transition_kind === "handoff_to_actor"
    && state.handoff_target === context.agent_role
      ? "accept_handoff"
      : state.transition_kind;
  return uniqueStrings([
    state.summary_kind ? `k=${state.summary_kind}` : null,
    transition ? `tr=${transition}` : null,
    state.actor_role ? `role=${state.actor_role}` : null,
    state.handoff_target ? `to=${state.handoff_target}` : null,
  ]).map((value) => ` ${value}`).join("");
}

function acceptedReferenceLines(context: AionisAgentContext, aliases: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const row of context.command_posture) {
    if (row.posture !== "optional_context" && row.posture !== "inspect_first") continue;
    const accepted = row.execution_state?.execution_outcome_role === "passed_solution";
    const evidence = uniqueStrings([
      ...row.artifact_hints,
      ...row.verification_summary,
      ...row.acceptance_checks,
    ]);
    if (!accepted) continue;
    for (const value of evidence.slice(0, 2)) {
      lines.push(`accepted: id=${aliases.get(row.memory_id) ?? row.memory_id} ref=1 primary=0 n=${compactText(value, 170)}`);
    }
  }
  return lines.slice(0, 2);
}

function truncateToBudget(value: string, budget: number | null): string {
  if (!budget || budget <= 0 || value.length <= budget) return value;
  if (budget <= 1) return value.slice(0, budget);
  return `${value.slice(0, budget - 1).trimEnd()}…`;
}

function renderStandard(context: AionisAgentContext): string {
  const inline = (label: string, values: string[], limit: number, chars: number): string | null => {
    const rows = values.slice(0, limit).map((value) => compactText(value, chars));
    return rows.length > 0 ? `${label}: ${rows.join(" | ")}` : null;
  };
  return uniqueStrings([
    "AIONIS_AGENT_CONTEXT v1",
    `state: role=${context.agent_role} history=${context.history_used ? "yes" : "no"} actionable_history=${context.actionable_history_used ? "yes" : "no"} posture=${context.recommended_posture} authority=${context.authority} risk=${context.risk.negative_transfer_risk}`,
    roleFocusLine(context.agent_role),
    taskProfileLine(context.task_context_profile, false),
    commandPostureLine(context, false),
    executionContractLine(context),
    ...routeLines(context, false),
    `summary: ${compactText(context.summary, 140)}`,
    inline("target_files", context.target_files, 6, 120),
    inline("use_now", context.use_now, 4, 220),
    ...evidenceLines(context, false),
    inline("inspect_before_use", context.inspect_before_use, 3, 140),
    inline("do_not_use", context.do_not_use, 3, 140),
    context.rehydrate_hints.length > 0
      ? `rehydrate_if_needed: ${context.rehydrate_hints.slice(0, 3).map((hint) => `${hint.memory_id}${hint.required ? "!" : ""}:${compactText(hint.reason, 100)}`).join(" | ")}`
      : null,
    context.memory_ids.length > 0 ? `memory_ids: ${context.memory_ids.slice(0, 6).join(",")}` : null,
  ]).join("\n");
}

function renderContract(context: AionisAgentContext, compact: boolean, compactHeader: boolean): string {
  const aliases = aliasMap(context);
  const isCurrent = (row: AionisAgentContext["command_posture"][number]) =>
    row.surface === "current" || row.execution_state?.summary_kind === "current_state";
  const directCurrentRow = context.command_posture.find((row) => row.posture === "should_continue" && isCurrent(row));
  const inspectCurrentRow = directCurrentRow
    ? undefined
    : context.command_posture.find((row) => row.posture === "inspect_first" && isCurrent(row));
  const currentRow = directCurrentRow ?? inspectCurrentRow;
  const directCurrentLine = context.use_now.find((line) => line.startsWith("Current active path:")) ?? context.use_now[0];
  const inspectCurrentLine = context.inspect_before_use.find((line) => /current active path/i.test(line));
  const currentLine = directCurrentRow ? directCurrentLine : inspectCurrentRow ? inspectCurrentLine : directCurrentLine;
  const fallbackCurrentId = context.use_now_memory_ids[0] ?? context.inspect_before_use_memory_ids[0];
  const currentId = currentRow?.memory_id ?? fallbackCurrentId;
  const currentFiles = currentRow?.target_files.length || context.target_files.length
    ? ` f=${(currentRow?.target_files.length ? currentRow.target_files : context.target_files).slice(0, compact ? 1 : 3).join(",")}`
    : "";
  const currentGate = inspectCurrentRow && !directCurrentRow ? " gate=inspect ref=1 primary=0" : "";
  const currentMeta = executionMeta(context, currentRow);
  const nextAction = currentRow?.execution_state?.next_action_hint;
  const currentContractLine = currentId || currentLine
    ? `current:${currentId ? ` id=${aliases.get(currentId) ?? currentId}` : ""}${currentFiles}${currentGate}${currentMeta}${currentLine ? ` n=${compactText(currentLine, compact ? 90 : 160)}` : ""}`
    : null;
  const indexedLine = (values: string[], ids: string[], memoryId: string): string | null => {
    const index = ids.indexOf(memoryId);
    return index >= 0 ? values[index] ?? null : null;
  };
  const rowLine = (
    label: "procedure" | "inspect" | "avoid",
    row: AionisAgentContext["command_posture"][number],
    fallback: string | null,
  ): string => {
    const files = row.target_files.length > 0 ? ` f=${row.target_files.slice(0, compact ? 1 : 3).join(",")}` : "";
    const constraint = label === "inspect"
      ? " ref=1 primary=0"
      : label === "avoid" ? " dir=blocked ref=counter" : "";
    return `${label}: id=${aliases.get(row.memory_id) ?? row.memory_id}${files}${constraint}${executionMeta(context, row)}${fallback ? ` n=${compactText(fallback, compact ? 90 : 150)}` : ""}`;
  };
  const procedureRows = context.command_posture.filter((row) => row.posture === "should_continue" && row.surface === "procedure");
  const inspectRows = context.command_posture.filter((row) => row.posture === "inspect_first" && row !== inspectCurrentRow);
  const avoidRows = context.command_posture.filter((row) => row.posture === "must_not");
  const procedureLines = procedureRows.slice(0, compact ? 1 : 3).map((row) => rowLine(
    "procedure",
    row,
    indexedLine(context.use_now, context.use_now_memory_ids, row.memory_id),
  ));
  const inspectLines = inspectRows.slice(0, compact ? 1 : 3).map((row) => rowLine(
    "inspect",
    row,
    indexedLine(context.inspect_before_use, context.inspect_before_use_memory_ids, row.memory_id),
  ));
  const avoidLines = avoidRows.slice(0, compact ? 1 : 3).map((row) => rowLine(
    "avoid",
    row,
    indexedLine(context.do_not_use, context.do_not_use_memory_ids, row.memory_id),
  ));
  const fallbackProcedures = context.use_now_memory_ids.length === 0
    ? context.use_now.filter((line) => line !== directCurrentLine).slice(0, compact ? 1 : 3)
        .map((line) => `procedure: note=${compactText(line, compact ? 90 : 130)}`)
    : [];
  const rehydrateLines = context.rehydrate_hints.slice(0, compact ? 2 : 3).map((hint) => {
    const row = context.command_posture.find((entry) => entry.memory_id === hint.memory_id && entry.posture === "rehydrate_first");
    return `rehydrate: id=${aliases.get(hint.memory_id) ?? hint.memory_id}${hint.required ? " req=1" : ""}${executionMeta(context, row)} n=${compactText(hint.reason, compact ? 50 : 70)}`;
  });
  return uniqueStrings([
    compactHeader ? "AIONIS_CTX compact_agent" : "AIONIS_CTX v2",
    `state r=${context.agent_role} h=${context.history_used ? 1 : 0} a=${context.actionable_history_used ? 1 : 0} p=${postureLabel(context.recommended_posture)} auth=${({ trusted: "trust", advisory: "adv", candidate: "cand", blocked: "block", none: "none" } as const)[context.authority]} risk=${({ high: "hi", medium: "med", low: "low" } as const)[context.risk.negative_transfer_risk]}`,
    taskProfileLine(context.task_context_profile, compact),
    commandPostureLine(context, true, aliases),
    executionPriorityLine(context),
    ...routeLines(context, true),
    ...acceptedReferenceLines(context, aliases),
    ...evidenceLines(context, true, aliases),
    context.actionable_history_used
      ? `next${nextAction ? ` act=${compactText(nextAction, compact ? 90 : 160)}` : ""} ${compact ? "role" : "actor_role"}=${context.agent_role}`
      : null,
    compact ? null : `summary ${compactText(context.summary, 160)}`,
    currentContractLine,
    ...procedureLines,
    ...fallbackProcedures,
    ...inspectLines,
    ...avoidLines,
    ...rehydrateLines,
  ]).join("\n");
}

function renderFullPower(context: AionisAgentContext): string {
  const current = context.use_now.filter((line) => line.startsWith("Current active path:"));
  const procedures = context.use_now.filter((line) => !line.startsWith("Current active path:"));
  const noteLines = (label: string, values: string[], limit: number, maxChars: number) =>
    values.slice(0, limit).map((value) => `${label}: note=${compactText(value, maxChars)}`);
  return uniqueStrings([
    "AIONIS_CTX v2",
    `state r=${context.agent_role} h=${context.history_used ? 1 : 0} a=${context.actionable_history_used ? 1 : 0} p=${postureLabel(context.recommended_posture)} auth=${context.authority} risk=${context.risk.negative_transfer_risk}`,
    taskProfileLine(context.task_context_profile, false),
    commandPostureLine(context, true, aliasMap(context)),
    executionPriorityLine(context),
    ...routeLines(context, true),
    ...evidenceLines(context, true, aliasMap(context)),
    context.actionable_history_used ? `next actor_role=${context.agent_role}` : null,
    `summary ${compactText(context.summary, 160)}`,
    context.target_files.length > 0 ? `files ${context.target_files.slice(0, 6).join(",")}` : null,
    ...noteLines("current", current.length > 0 ? current : context.use_now.slice(0, 1), 2, 160),
    ...noteLines("procedure", procedures, 3, 130),
    ...noteLines("inspect", context.inspect_before_use, 3, 100),
    ...noteLines("avoid", context.do_not_use, 3, 100),
    context.rehydrate_hints.length > 0
      ? `rehydrate: ${context.rehydrate_hints.slice(0, 3).map((hint) => `id=${hint.memory_id}${hint.required ? " req=1" : ""} n=${compactText(hint.reason, 70)}`).join(" | ")}`
      : null,
  ]).join("\n");
}

export function renderAionisAgentPrompt(input: {
  context: AionisAgentContext;
  profile: AgentContextRenderProfile;
}): string {
  const prompt = input.profile.detail === "full_power"
    ? renderFullPower(input.context)
    : input.profile.mode === "compact_agent" || input.profile.detail === "contract"
      ? renderContract(
        input.context,
        true,
        input.profile.mode === "compact_agent" && input.profile.detail === "compact",
      )
      : renderStandard(input.context);
  return truncateToBudget(prompt, input.profile.context_char_budget);
}
