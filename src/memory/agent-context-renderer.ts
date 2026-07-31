import type { AionisAgentContext } from "./runtime-product-contract.js";

function compactText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
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

function evidenceLines(
  context: AionisAgentContext,
  compact: boolean,
  aliases?: Map<string, string>,
  includeOptionalCurrent = true,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const fields = [
    ["workflow_steps", "step"],
    ["acceptance_checks", "check"],
    ["verification_summary", "verify"],
    ["artifact_hints", "artifact"],
  ] as const;
  for (const row of context.command_posture) {
    const unresolvedCurrentCompletion =
      (
        row.posture === "inspect_first"
        || (includeOptionalCurrent && row.posture === "optional_context")
      )
      && row.execution_state?.transition_kind === "resume_current_state"
      && row.execution_state.execution_outcome_role === "unknown";
    if (row.posture !== "should_continue" && row.posture !== "must_not" && !unresolvedCurrentCompletion) continue;
    for (const [field, label] of fields) {
      if (row.posture === "must_not" && field !== "verification_summary") continue;
      if (unresolvedCurrentCompletion && field !== "acceptance_checks") continue;
      for (const value of row[field]) {
        const text = compactText(value, compact ? 78 : 180);
        const evidenceLabel = row.posture === "must_not"
          ? "avoid_verify"
          : unresolvedCurrentCompletion ? "verify_before_done" : label;
        if (!text || seen.has(`${evidenceLabel}:${text}`)) continue;
        seen.add(`${evidenceLabel}:${text}`);
        out.push(`${evidenceLabel}: id=${aliases?.get(row.memory_id) ?? row.memory_id} n=${text}`);
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

function optionalHostCurrentStateRow(
  context: AionisAgentContext,
): AionisAgentContext["command_posture"][number] | undefined {
  return context.command_posture.find((row) =>
    row.posture === "optional_context"
    && row.memory_id.startsWith("host_current_state:")
    && (row.surface === "current"
      || row.execution_state?.summary_kind === "current_state")
    && row.execution_state?.transition_kind === "resume_current_state"
    && row.execution_state.execution_outcome_role === "unknown"
  );
}

function optionalHostCurrentStateDetailLines(args: {
  row: AionisAgentContext["command_posture"][number] | undefined;
  compact: boolean;
  alias?: string;
  includeStateSummary: boolean;
}): string[] {
  const row = args.row;
  if (!row) return [];
  const id = args.alias ?? row.memory_id;
  const detailChars = args.compact ? 78 : 180;
  return uniqueStrings([
    args.includeStateSummary
      ? `current_state: id=${id} outcome=unknown historical_memory=0 actionable=0 n=${compactText(`${row.instruction} ${row.reason}`, args.compact ? 110 : 240)}`
      : null,
    row.execution_state?.next_action_hint
      ? `current_next: id=${id} actionable=0 hint=${compactText(row.execution_state.next_action_hint, args.compact ? 90 : 160)}`
      : null,
    ...row.workflow_steps.slice(0, args.compact ? 1 : 3).map((value) =>
      `current_step: id=${id} n=${compactText(value, detailChars)}`
    ),
    ...row.acceptance_checks.slice(0, args.compact ? 2 : 5).map((value) =>
      `current_check: id=${id} n=${compactText(value, detailChars)}`
    ),
    ...row.verification_summary.slice(0, args.compact ? 1 : 3).map((value) =>
      `current_host_reported_validation: id=${id} outcome=unknown n=${compactText(value, detailChars)}`
    ),
    ...row.artifact_hints.slice(0, args.compact ? 2 : 4).map((value) =>
      `current_evidence: id=${id} n=${compactText(value, detailChars)}`
    ),
  ]);
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

function renderContract(context: AionisAgentContext, compact: boolean, compactHeader: boolean): string {
  const aliases = aliasMap(context);
  const isCurrent = (row: AionisAgentContext["command_posture"][number]) =>
    row.surface === "current" || row.execution_state?.summary_kind === "current_state";
  const directCurrentRow = context.command_posture.find((row) => row.posture === "should_continue" && isCurrent(row));
  const inspectCurrentRow = directCurrentRow
    ? undefined
    : context.command_posture.find((row) => row.posture === "inspect_first" && isCurrent(row));
  const optionalCurrentRow = directCurrentRow || inspectCurrentRow
    ? undefined
    : optionalHostCurrentStateRow(context);
  const currentRow = directCurrentRow ?? inspectCurrentRow ?? optionalCurrentRow;
  const directCurrentLine = context.use_now.find((line) => line.startsWith("Current active path:")) ?? context.use_now[0];
  const inspectCurrentLine = context.inspect_before_use.find((line) => /current active path/i.test(line));
  const currentLine = directCurrentRow
    ? directCurrentLine
    : inspectCurrentRow
      ? inspectCurrentLine
      : optionalCurrentRow
        ? `${optionalCurrentRow.instruction} ${optionalCurrentRow.reason}`
        : context.actionable_history_used ? directCurrentLine : undefined;
  const fallbackCurrentId = context.actionable_history_used ? context.use_now_memory_ids[0] : undefined;
  const currentId = currentRow?.memory_id ?? fallbackCurrentId;
  const currentFiles = currentRow?.target_files.length || context.target_files.length
    ? ` f=${(currentRow?.target_files.length ? currentRow.target_files : context.target_files).slice(0, compact ? 1 : 3).join(",")}`
    : "";
  const currentGate = inspectCurrentRow && !directCurrentRow
    ? " gate=inspect ref=1 primary=0"
    : optionalCurrentRow
      ? " source=host_current_state outcome=unknown historical_memory=0 actionable=0"
      : "";
  const currentMeta = executionMeta(context, currentRow);
  const actionableNextAction = directCurrentRow?.execution_state?.next_action_hint;
  const currentContractLine = currentId || currentLine
    ? `current:${currentId ? ` id=${aliases.get(currentId) ?? currentId}` : ""}${currentFiles}${currentGate}${currentMeta}${currentLine ? ` n=${compactText(currentLine, compact ? 90 : 160)}` : ""}`
    : null;
  const currentStateDetailLines = optionalHostCurrentStateDetailLines({
    row: optionalCurrentRow,
    compact,
    alias: optionalCurrentRow
      ? aliases.get(optionalCurrentRow.memory_id) ?? optionalCurrentRow.memory_id
      : undefined,
    includeStateSummary: false,
  });
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
  const rehydrateLines = context.rehydrate_hints.slice(0, compact ? 2 : 3).map((hint) => {
    const row = context.command_posture.find((entry) => entry.memory_id === hint.memory_id && entry.posture === "rehydrate_first");
    return `rehydrate: id=${aliases.get(hint.memory_id) ?? hint.memory_id}${hint.required ? " req=1" : ""}${executionMeta(context, row)} n=${compactText(hint.reason, compact ? 50 : 70)}`;
  });
  return uniqueStrings([
    compactHeader ? "AIONIS_CTX compact_agent" : "AIONIS_CTX v2",
    `state r=${context.agent_role} h=${context.history_used ? 1 : 0} a=${context.actionable_history_used ? 1 : 0} p=${postureLabel(context.recommended_posture)} auth=${({ trusted: "trust", advisory: "adv", candidate: "cand", blocked: "block", none: "none" } as const)[context.authority]} risk=${({ high: "hi", medium: "med", low: "low" } as const)[context.risk.negative_transfer_risk]}`,
    commandPostureLine(context, true, aliases),
    ...acceptedReferenceLines(context, aliases),
    ...evidenceLines(context, true, aliases, false),
    context.actionable_history_used
      ? `next${actionableNextAction ? ` act=${compactText(actionableNextAction, compact ? 90 : 160)}` : ""} ${compact ? "role" : "actor_role"}=${context.agent_role}`
      : null,
    compact ? null : `summary ${compactText(context.summary, 160)}`,
    currentContractLine,
    ...currentStateDetailLines,
    ...procedureLines,
    ...inspectLines,
    ...avoidLines,
    ...rehydrateLines,
  ]).join("\n");
}

export function renderAionisAgentPrompt(input: {
  context: AionisAgentContext;
  context_char_budget: number | null;
}): string {
  const memoryPrompt = renderContract(input.context, true, true);
  const currentState =
    input.context.current_execution_state_render?.text ?? null;
  if (!currentState) {
    return truncateToBudget(
      memoryPrompt,
      input.context_char_budget,
    );
  }
  const combined = `${currentState}\n\n${memoryPrompt}`;
  const budget = input.context_char_budget;
  if (!budget || budget <= 0 || combined.length <= budget) return combined;
  if (currentState.length >= budget) {
    return truncateToBudget(currentState, budget);
  }
  const separator = "\n\n";
  const remaining = Math.max(0, budget - currentState.length - separator.length);
  if (remaining === 0) return currentState;
  return `${currentState}${separator}${truncateToBudget(memoryPrompt, remaining)}`;
}
