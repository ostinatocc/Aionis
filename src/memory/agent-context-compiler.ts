import {
  AionisAgentContextSchema,
  parseAionisAgentContext,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisMemoryPacket,
  type AionisRiskLevel,
} from "./runtime-product-contract.js";

import type {
  AionisMemoryDecisionSurface,
  GovernanceDecisionV1,
} from "./governance-contract.js";

import { renderAionisAgentPrompt } from "./agent-context-renderer.js";
import {
  DEFAULT_CURRENT_STATE_RENDER_POLICY_V1,
  renderCurrentExecutionStateV2,
} from "../execution/current-execution-state.js";
import type {
  CurrentExecutionStateRenderV1,
  CurrentExecutionStateV2,
} from "../execution/types.js";
import type {
  HostCurrentExecutionStateContextV1,
} from "./host-current-execution-state.js";

import {
  MemoryPacketEntry,
  NormalizedAgentPromptExecutionScope,
  compactStrings,
  contractEntryIsCurrentState,
  contractEntryIsProcedure,
  governanceDecisionForMemoryEntry,
  governanceScopeMatchForEntry,
  lifecycleDecisionForEntry,
  memoryEntryBlocked,
  memoryEntryInspectBeforeUse,
  stringValue,
} from "./product-output/memory-packet.js";



export type AgentContextTaskRoleContext = {
  agent_role: AionisAgentContext["agent_role"];
};

export type AgentContextCompilerInput = {
  base_context: AionisAgentContext;
  governance_decisions: GovernanceDecisionV1[];
  canonical_current_execution_state: CurrentExecutionStateV2 | null;
  canonical_current_execution_state_render:
    CurrentExecutionStateRenderV1 | null;
  host_current_execution_state: HostCurrentExecutionStateContextV1 | null;
  task_role_context: AgentContextTaskRoleContext;
  context_char_budget: number | null;
};

function uniqueStrings(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
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
  const optionalCurrentId = directCurrentId || inspectCurrentId ? undefined : context.command_posture.find((row) =>
    row.posture === "optional_context"
    && row.surface === "current"
    && row.execution_state?.transition_kind === "resume_current_state"
    && row.execution_state.execution_outcome_role === "unknown"
  )?.memory_id;
  const currentId = directCurrentId
    ?? inspectCurrentId
    ?? optionalCurrentId
    ?? context.use_now_memory_ids[0];
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
  for (const id of context.use_now_memory_ids) {
    if (!surfaceById.has(id)) {
      surfaceById.set(id, id === currentId ? "current" : "other");
    }
  }
  for (const id of context.inspect_before_use_memory_ids) {
    if (!surfaceById.has(id)) surfaceById.set(id, "inspect");
  }
  for (const id of context.do_not_use_memory_ids) {
    if (!surfaceById.has(id)) surfaceById.set(id, "avoid");
  }
  for (const hint of context.rehydrate_hints) {
    surfaceById.set(hint.memory_id, "rehydrate");
  }
  const orderedIds = uniqueStrings([
    ...(currentId ? [currentId] : []),
    ...context.command_posture
      .filter((row) => row.surface === "procedure")
      .map((row) => row.memory_id),
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


function mergeHostCurrentExecutionState(
  base: AionisAgentContext,
  current: HostCurrentExecutionStateContextV1 | null,
): AionisAgentContext {
  if (!current) return base;
  const commandPosture = [
    {
      posture: "optional_context" as const,
      surface: "current" as const,
      memory_id: current.state_id,
      instruction: current.instruction,
      reason: current.reason,
      target_files: [...current.target_files],
      workflow_steps: [],
      acceptance_checks: [...current.acceptance_checks],
      verification_summary: [...current.verification_summary],
      artifact_hints: [...current.artifact_hints],
      execution_state: {
        summary_kind: "current_state",
        transition_kind: "resume_current_state" as const,
        actor_role: current.actor_role,
        handoff_target: null,
        next_action_hint: current.next_action_hint,
        execution_outcome_role: "unknown" as const,
      },
    },
    ...base.command_posture.filter((entry) =>
      entry.memory_id !== current.state_id),
  ].slice(0, 14);
  const targetFiles = uniqueStrings([
    ...current.target_files,
    ...base.target_files,
  ], 8);
  return AionisAgentContextSchema.parse({
    ...base,
    summary: base.history_used
      ? base.summary
      : "Aionis carried the Host's current execution state without claiming a verified task outcome or reusable history.",
    target_files: targetFiles,
    command_posture: commandPosture,
    risk: {
      ...base.risk,
      reasons: uniqueStrings([
        ...base.risk.reasons,
        "host_current_execution_state_carried_without_task_outcome_claim",
      ], 8),
    },
  });
}

function mergeCanonicalCurrentExecutionState(
  base: AionisAgentContext,
  current: CurrentExecutionStateV2 | null,
  rendered: CurrentExecutionStateRenderV1 | null,
): AionisAgentContext {
  if (!current) return base;
  if (!rendered || rendered.state_sha256 !== current.state_sha256) {
    throw new Error(
      "canonical current execution state requires its exact bounded render",
    );
  }
  return AionisAgentContextSchema.parse({
    ...base,
    current_execution_state: current,
    current_execution_state_render: rendered,
    summary: base.history_used
      ? base.summary
      : "Aionis restored the authoritative current execution state; no reusable historical skill was assumed.",
    risk: {
      ...base.risk,
      reasons: uniqueStrings([
        ...base.risk.reasons,
        "authoritative_current_execution_state_projected_from_episode_events",
      ], 8),
    },
  });
}

function enforceDecisionSurfaces(
  context: AionisAgentContext,
  decisions: GovernanceDecisionV1[],
): AionisAgentContext {
  const known = new Set(decisions.map((decision) => decision.memory_id));
  const currentStateFactIds = new Set(
    context.command_posture
      .filter((row) => row.posture === "optional_context" && row.surface === "current")
      .map((row) => row.memory_id),
  );
  const currentStateDecisionIds = new Set(
    decisions
      .filter((decision) =>
        decision.reason_codes.includes("exact_task_continuation_state_available")
      )
      .map((decision) => decision.memory_id),
  );
  const ids = (surface: GovernanceDecisionV1["surface"]) => decisions
    .filter((decision) => decision.surface === surface)
    .map((decision) => decision.memory_id);
  const useNow = uniqueStrings([
    ...context.use_now_memory_ids.filter((id) => !known.has(id)),
    ...ids("use_now"),
  ], 10);
  const inspect = uniqueStrings([
    ...context.inspect_before_use_memory_ids.filter((id) => !known.has(id)),
    ...ids("inspect_before_use").filter((id) =>
      !currentStateFactIds.has(id) && !currentStateDecisionIds.has(id)
    ),
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
  });
  const mergedCanonicalCurrentState = mergeCanonicalCurrentExecutionState(
    roleContext,
    input.canonical_current_execution_state,
    input.canonical_current_execution_state_render,
  );
  const mergedCurrentState = mergeHostCurrentExecutionState(
    mergedCanonicalCurrentState,
    input.canonical_current_execution_state
      ? null
      : input.host_current_execution_state,
  );
  const governed = enforceDecisionSurfaces(
    mergedCurrentState,
    input.governance_decisions,
  );
  const withAliases = AionisAgentContextSchema.parse({
    ...governed,
    actionable_history_used:
      governed.use_now_memory_ids.length > 0,
    prompt_aliases: promptAliases(governed),
  });
  const normalized = AionisAgentContextSchema.parse({
    ...withAliases,
    actionable_history_used:
      withAliases.use_now_memory_ids.length > 0,
  });
  return AionisAgentContextSchema.parse({
    ...normalized,
    prompt_text: renderAionisAgentPrompt({
      context: normalized,
      context_char_budget: input.context_char_budget,
    }),
  });
}

export type BuildAionisAgentContextArgs = {
  tenant_id: string;
  scope: string;
  agent_role?: AionisAgentRole | null;
  memory_packet?: AionisMemoryPacket | null;
  execution_scope?: AgentContextExecutionScope | null;
  context_char_budget?: number | null;
  canonical_current_execution_state?: CurrentExecutionStateV2 | null;
  canonical_current_execution_state_render?:
    CurrentExecutionStateRenderV1 | null;
  host_current_execution_state?: HostCurrentExecutionStateContextV1 | null;
};

export type AgentContextExecutionScope = {
  task_signature?: string | null;
  task_family?: string | null;
  workflow_signature?: string | null;
};

function executionAcceptanceChecksForCommandPosture(entry: MemoryPacketEntry | null | undefined): string[] {
  return compactStrings(entry?.execution_state?.acceptance_checks ?? []).slice(0, 8);
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

function entryById(entries: MemoryPacketEntry[]): Map<string, MemoryPacketEntry> {
  return new Map(entries.map((entry) => [entry.memory_id, entry]));
}

function memoryEntryRehydrateEligible(entry: MemoryPacketEntry): boolean {
  return entry.lifecycle_state === "rehydration_candidate" || entry.lifecycle_state === "archived"
    || entry.execution_state?.transition_kind === "request_rehydrate";
}

function memoryEntryRehydrateSurface(entry: MemoryPacketEntry): boolean {
  return lifecycleDecisionForEntry(entry).requires_rehydrate;
}

function memoryEntryUsable(entry: MemoryPacketEntry): boolean {
  return (entry.authority === "trusted" || entry.authority === "advisory")
    && entry.lifecycle_state === "active";
}

function memoryEntryAgentPromptScopeAllowed(args: {
  entry: MemoryPacketEntry;
  executionScope: NormalizedAgentPromptExecutionScope;
}): boolean {
  return governanceScopeMatchForEntry({ entry: args.entry, executionScope: args.executionScope }) !== "unrelated";
}

function filterMemoryEntriesForAgentPromptScope(args: {
  memoryEntries: MemoryPacketEntry[];
  executionScope: NormalizedAgentPromptExecutionScope;
}): MemoryPacketEntry[] {
  return args.memoryEntries.filter((entry) =>
    memoryEntryAgentPromptScopeAllowed({
      entry,
      executionScope: args.executionScope,
    })
  );
}

function memoryEntryLabel(entry: MemoryPacketEntry): string {
  return compactStrings([entry.title, entry.memory_id])[0] ?? entry.memory_id;
}

function memoryEntryAuditLabel(entry: MemoryPacketEntry): string {
  const label = memoryEntryLabel(entry);
  return label === entry.memory_id ? entry.memory_id : `${label} (${entry.memory_id})`;
}

function memoryEntryUseNowLine(entry: MemoryPacketEntry): string | null {
  const prefix = entry.memory_type === "preference"
    ? "Preference"
    : entry.memory_type === "project_context"
      ? "Project memory"
      : entry.domain === "execution"
        ? "Execution memory"
        : "Memory";
  const summary = entry.summary.replace(/\s+/g, " ").trim();
  if (!summary) return null;
  return `${prefix}: ${summary}`.slice(0, 520);
}

function memoryEntryInspectLine(entry: MemoryPacketEntry): string {
  return `Inspect memory before use: ${memoryEntryLabel(entry)}`.slice(0, 220);
}

function agentPromptMemoryIdAllowed(args: {
  memoryId: string;
  memoryEntriesById: Map<string, MemoryPacketEntry>;
  executionScope: NormalizedAgentPromptExecutionScope;
}): boolean {
  if (!args.executionScope.task_signature && !args.executionScope.task_family && !args.executionScope.workflow_signature) return true;
  const entry = args.memoryEntriesById.get(args.memoryId);
  if (!entry) return false;
  return memoryEntryAgentPromptScopeAllowed({
    entry,
    executionScope: args.executionScope,
  });
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
  return compactStrings(entry.target_files.map(normalizePathTarget));
}

function memoryContractInspectBeforeUse(entry: MemoryPacketEntry): boolean {
  return entry.memory_contract.use_policy === "evidence_only";
}

function memoryContractInspectLine(entry: MemoryPacketEntry): string {
  return `Memory contract: ${memoryEntryAuditLabel(entry)} is ${entry.memory_contract.use_policy}; ${entry.memory_contract.allowed_scope}; inspect before direct reuse.`;
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
      acceptance_checks: compactStrings(row.acceptance_checks).slice(0, 8),
      verification_summary: compactStrings(row.verification_summary).slice(0, 2),
      artifact_hints: compactStrings(row.artifact_hints).slice(0, 2),
    });
  };
  const entryFiles = (entry: MemoryPacketEntry | null | undefined): string[] =>
    compactStrings(entry?.target_files ?? []).slice(0, 6);
  const entryExecutionEvidence = (entry: MemoryPacketEntry | null | undefined) => ({
    workflow_steps: compactStrings(entry?.execution_state?.workflow_steps ?? []).slice(0, 3),
    acceptance_checks: executionAcceptanceChecksForCommandPosture(entry).slice(0, 8),
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
    const unresolvedCurrentState = !!entry
      && contractEntryIsCurrentState(entry)
      && entry.execution_state?.transition_kind === "resume_current_state"
      && entry.execution_state.execution_outcome_role === "unknown";
    if (entry && unresolvedCurrentState) {
      push({
        posture: "optional_context",
        surface: "current",
        memory_id: memoryId,
        instruction: "Treat this as authoritative current-workspace state, not as proof that the present implementation route is correct; inspect, validate, and revise or replace the route when evidence requires.",
        reason: `Current state snapshot: ${entry.summary.replace(/\s+/g, " ").trim().slice(0, 520)}`,
        target_files: entryFiles(entry),
        ...entryExecutionEvidence(entry),
      });
      continue;
    }
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
}): AionisAgentContext["rehydrate_hints"] {
  return args.entries
    .filter(memoryEntryRehydrateSurface)
    .map((entry) => ({
      memory_id: entry.memory_id,
      reason: entry.execution_state?.transition_kind === "request_rehydrate"
        ? "Execution state requests payload rehydration before relying on raw or exact evidence."
        : "Memory is a rehydration candidate; expand payload before relying on summary-only context.",
      required:
        entry.execution_state?.transition_kind === "request_rehydrate",
    }))
    .slice(0, 6);
}

function riskAtLeast(current: AionisRiskLevel, minimum: AionisRiskLevel): AionisRiskLevel {
  const rank: Record<AionisRiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return rank[current] >= rank[minimum] ? current : minimum;
}

function compileAgentContextSurfaces(args: {
  memoryEntries: MemoryPacketEntry[];
  rawRisk: AionisAgentContext["risk"];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
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
  const usableEntries = args.memoryEntries.filter((entry) =>
    !rehydrateSurfaceIds.has(entry.memory_id)
    && !memoryEntryBlocked(entry)
    && memoryEntryUsable(entry)
  );
  const hasUsableMemory = usableEntries.length > 0;
  const memoryContractRiskReasonList = compactStrings([
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "evidence_only") ? "memory_contract_evidence_only_kept_out_of_use_now" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "inspect_before_use") ? "memory_contract_requires_inspection" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.use_policy === "do_not_use") ? "memory_contract_blocks_direct_use" : null,
    args.memoryEntries.some((entry) => entry.memory_contract.evidence_requirement === "requires_more_evidence") ? "memory_contract_requires_more_evidence" : null,
  ]).slice(0, 4);
  const governanceDecisions = args.memoryEntries.map((entry) => governanceDecisionForMemoryEntry({
    entry,
    executionScope: args.executionScope,
    rehydrateRequested: rehydrateSurfaceIds.has(entry.memory_id),
  }));
  const decisionByMemoryId = new Map(governanceDecisions.map((decision) => [decision.memory_id, decision]));
  const entriesForSurface = (surface: AionisMemoryDecisionSurface): MemoryPacketEntry[] =>
    args.memoryEntries.filter((entry) => decisionByMemoryId.get(entry.memory_id)?.surface === surface);
  const blockedEntries = entriesForSurface("do_not_use");
  const currentStateDecisionIds = new Set(
    governanceDecisions
      .filter((decision) =>
        decision.surface === "inspect_before_use"
        && decision.reason_codes.includes("exact_task_continuation_state_available")
      )
      .map((decision) => decision.memory_id),
  );
  const latestCurrentStateEntry = args.memoryEntries
    .filter((entry) => currentStateDecisionIds.has(entry.memory_id))
    .reduce<MemoryPacketEntry | null>((latest, entry) => {
      if (!latest) return entry;
      const latestObservedAt = Date.parse(latest.observed_at ?? "") || 0;
      const entryObservedAt = Date.parse(entry.observed_at ?? "") || 0;
      return entryObservedAt > latestObservedAt ? entry : latest;
    }, null);
  const currentStateContextIds = new Set(
    latestCurrentStateEntry ? [latestCurrentStateEntry.memory_id] : [],
  );
  const inspectDecisionEntries = entriesForSurface("inspect_before_use")
    .filter((entry) => !currentStateDecisionIds.has(entry.memory_id));
  const directUseMemoryEntries = entriesForSurface("use_now");
  const optionalContextEntries = args.memoryEntries.filter((entry) =>
    currentStateContextIds.has(entry.memory_id)
    || decisionByMemoryId.get(entry.memory_id)?.reason_codes.includes("optional_context_only")
  );
  const memoryUseNow = compactStrings(directUseMemoryEntries.map(memoryEntryUseNowLine));
  const memoryUseNowStructuredTargets = compactStrings(
    directUseMemoryEntries
      .flatMap(memoryEntryPathTargets),
  );
  const inspectLineForEntry = (entry: MemoryPacketEntry): string => {
    if (memoryContractInspectBeforeUse(entry)) return memoryContractInspectLine(entry);
    return memoryEntryInspectLine(entry);
  };
  const targetFiles = hasUsableMemory
      ? memoryUseNowStructuredTargets.slice(0, 8)
    : [];
  const inspectBeforeUse = compactStrings([
    ...inspectDecisionEntries.map(inspectLineForEntry),
  ]).slice(0, 5);
  const doNotUse = compactStrings([
    ...blockedEntries.map((entry) => `Blocked memory: ${memoryEntryLabel(entry)}`),
  ]).slice(0, 5);

  const hasRiskSurface = inspectBeforeUse.length > 0 || doNotUse.length > 0;
  const historyUsed = hasUsableMemory
    || inspectDecisionEntries.length > 0
    || blockedEntries.length > 0
    || args.rehydrateHints.length > 0;
  const actionableHistoryUsed = directUseMemoryEntries.length > 0;
  let negativeTransferRisk = args.rawRisk.negative_transfer_risk;
  if (blockedEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "high");
  else if (inspectDecisionEntries.length > 0) negativeTransferRisk = riskAtLeast(negativeTransferRisk, "medium");

  const requiredRehydration = args.rehydrateHints.some((hint) => hint.required);
  const recommendedPosture: AionisAgentContext["recommended_posture"] = hasRiskSurface
      ? "inspect_before_use"
      : requiredRehydration
        ? "rehydrate_before_use"
        : actionableHistoryUsed
          ? "use_as_context"
          : historyUsed
            ? "use_as_context"
            : "ignore_history";

  const usableAuthority: AionisAgentContext["authority"] =
    usableEntries.some((entry) => entry.authority === "trusted")
    ? "trusted"
    : usableEntries.some((entry) => entry.authority === "advisory")
      ? "advisory"
      : "candidate";

  const authority: AionisAgentContext["authority"] = !historyUsed
    ? "none"
    : !actionableHistoryUsed && blockedEntries.length > 0
      ? "blocked"
    : !actionableHistoryUsed && inspectDecisionEntries.length > 0
        ? "candidate"
      : hasUsableMemory
      ? usableAuthority
      : blockedEntries.length > 0
        ? "blocked"
        : inspectDecisionEntries.length > 0
          ? "candidate"
          : "candidate";

  return {
    historyUsed,
    actionableHistoryUsed,
    recommendedPosture,
    authority,
    targetFiles,
    useNow: memoryUseNow.slice(0, 6),
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
        inspectDecisionEntries.some(memoryEntryInspectBeforeUse) ? "candidate_or_contested_memory_kept_out_of_use_now" : null,
        blockedEntries.length > 0 ? "blocked_or_suppressed_memory_kept_out_of_use_now" : null,
        args.rehydrateHints.length > 0 ? "rehydration_hint_available" : null,
        requiredRehydration ? "rehydration_required_before_use" : null,
        ...memoryContractRiskReasonList,
        ...args.rawRisk.reasons,
      ]).slice(0, 5),
    },
  };
}

export function buildAionisAgentContext(args: BuildAionisAgentContextArgs): AionisAgentContext {
  const memory = args.memory_packet ?? null;
  const memoryEntries = (memory?.relevant_memories ?? []).map((entry) => {
    if (
      entry.source_layer !== "L0"
      && entry.source_layer !== "L1"
    ) {
      return entry;
    }
    return {
      ...entry,
      memory_contract: {
        ...entry.memory_contract,
        allowed_scope: "supporting_evidence_only" as const,
        use_policy: "evidence_only" as const,
        confirmation_required: true,
        reasons: compactStrings([
          ...entry.memory_contract.reasons,
          "historical_l0_l1_is_supporting_evidence_only",
        ]),
      },
    };
  });
  const agentRole = args.agent_role ?? "agent";
  const canonicalCurrentStateRender =
    args.canonical_current_execution_state_render ?? (
      args.canonical_current_execution_state
        ? renderCurrentExecutionStateV2({
            state: args.canonical_current_execution_state,
            policy: {
              ...DEFAULT_CURRENT_STATE_RENDER_POLICY_V1,
              max_chars: args.context_char_budget
                ? Math.max(
                    512,
                    Math.min(
                      DEFAULT_CURRENT_STATE_RENDER_POLICY_V1.max_chars,
                      Math.floor(args.context_char_budget * 0.65),
                    ),
                  )
                : DEFAULT_CURRENT_STATE_RENDER_POLICY_V1.max_chars,
            },
          })
        : null
    );
  const memoryEntryCount = memory?.relevant_memories.length ?? 0;
  const rehydrateHintIds = new Set<string>();
  const memoryEntriesById = new Map(
    memoryEntries.map((entry) => [entry.memory_id, entry]),
  );
  const rawRehydrateHints: AionisAgentContext["rehydrate_hints"] = [
    ...(memory?.lifecycle.rehydration_hints ?? []).map((hint) => ({
      memory_id: hint.memory_id,
      reason: hint.reason,
      required: hint.required,
    })),
    ...executionStateRehydrateHints({
      entries: memoryEntries,
    }),
  ].filter((hint) => {
    if (rehydrateHintIds.has(hint.memory_id)) return false;
    rehydrateHintIds.add(hint.memory_id);
    return true;
  }).slice(0, 6);
  const rawMemoryIds = compactStrings([
    ...(memory?.lifecycle.used_memory_ids ?? []),
    ...rawRehydrateHints.map((entry) => entry.memory_id),
  ]).slice(0, 10);
  const executionScope = normalizeAgentPromptExecutionScope(args.execution_scope);
  const promptEntries = filterMemoryEntriesForAgentPromptScope({
    memoryEntries,
    executionScope,
  });
  const rehydrateHints = rawRehydrateHints.filter((hint) => {
    if (!agentPromptMemoryIdAllowed({
      memoryId: hint.memory_id,
      memoryEntriesById,
      executionScope,
    })) return false;
    const entry = memoryEntriesById.get(hint.memory_id);
    return (!entry || memoryEntryRehydrateEligible(entry))
      && (
        hint.required
        || (entry ? memoryEntryRehydrateSurface(entry) : false)
      );
  });
  const memoryIds = rawMemoryIds.filter((memoryId) => agentPromptMemoryIdAllowed({
    memoryId,
    memoryEntriesById,
    executionScope,
  })).slice(0, 10);
  const workflowIds: string[] = [];
  const evidenceCount = memory?.evidence_trail.length ?? 0;
  const risk = {
    negative_transfer_risk:
      memory?.risk.negative_transfer_risk
      ?? "low",
    blocked_authority_count: 0,
    stale_memory_count:
      memory?.forgetting_state.stale_memory_count
      ?? memory?.risk.stale_memory_count
      ?? 0,
    reasons: [] as string[],
  };
  const rawSummary = memoryEntryCount > 0
    ? "Relevant Aionis memory is available as compact context."
    : "No usable Aionis history was recovered.";
  const surfaces = compileAgentContextSurfaces({
    memoryEntries: promptEntries,
    rawRisk: risk,
    rehydrateHints,
    executionScope,
  });
  const summary = !surfaces.historyUsed
    ? "No usable Aionis history was recovered for the Agent context."
    : surfaces.recommendedPosture === "inspect_before_use"
      ? "Relevant Aionis history is available as evidence, but it is not validated as a direct execution route; inspect and verify before reuse."
      : surfaces.recommendedPosture === "rehydrate_before_use"
        ? "Relevant Aionis history exists, but raw evidence must be rehydrated before exact reuse."
        : surfaces.recommendedPosture === "use_as_context" && !surfaces.actionableHistoryUsed
          ? "Relevant Aionis history is available as context, but it is not validated as direct execution guidance."
          : rawSummary;
  const commandPosture = buildAgentContextCommandPostures({
    memoryEntries: promptEntries,
    useNowMemoryIds: surfaces.useNowMemoryIds,
    optionalContextMemoryIds: surfaces.optionalContextMemoryIds,
    inspectBeforeUseMemoryIds: surfaces.inspectBeforeUseMemoryIds,
    doNotUseMemoryIds: surfaces.doNotUseMemoryIds,
    rehydrateHints,
  });
  const baseContext = parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: memory?.tenant_id ?? args.tenant_id,
    scope: memory?.scope ?? args.scope,
    agent_role: agentRole,
    ...(args.canonical_current_execution_state
      && canonicalCurrentStateRender
      ? {
          current_execution_state:
            args.canonical_current_execution_state,
          current_execution_state_render:
            canonicalCurrentStateRender,
        }
      : {}),
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
    canonical_current_execution_state:
      args.canonical_current_execution_state ?? null,
    canonical_current_execution_state_render:
      canonicalCurrentStateRender,
    host_current_execution_state:
      args.host_current_execution_state ?? null,
    task_role_context: {
      agent_role: agentRole,
    },
    context_char_budget: args.context_char_budget ?? null,
  });
}
