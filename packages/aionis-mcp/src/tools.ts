import {
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  compileExecutionAgentContext,
  createAionisClient,
  inspectFirstMemoryIdsFromGuide,
  mustNotMemoryIdsFromGuide,
  rehydrateFirstMemoryIdsFromGuide,
  routeContractFromGuide,
  shouldContinueMemoryIdsFromGuide,
  type AionisClient,
  type AionisAgentFlightRecorderRequest,
  type AionisExecutionAgentRole,
  type AionisExecutionContextBudgetProfile,
  type AionisExecutionOutcomeStatus,
  type AionisExecutionRepoState,
  type AionisExternalMemoryCandidate,
  type AionisFeedbackOutcome,
  type AionisFeedbackUsedSurface,
  type AionisGuideContextMode,
  type AionisGuideMode,
  type AionisHandoffKind,
  type AionisJsonObject,
  type AionisMemoryLane,
  type AionisRememberKind,
  type AionisRememberLifecycleState,
  type AionisRememberTier,
  type AionisToolStatus,
} from "@aionis/sdk";
import { clientOptionsFromMcpConfig, type AionisMcpConfig } from "./config.js";

export const AIONIS_MCP_TOOL_NAMES = [
  "aionis_context",
  "aionis_record_step",
  "aionis_handoff",
  "aionis_remember",
  "aionis_govern_memory",
  "aionis_measure",
  "aionis_snapshot",
  "aionis_flight_recorder",
  "aionis_health",
] as const;

export type AionisMcpToolName = typeof AIONIS_MCP_TOOL_NAMES[number];
export type JsonRecord = Record<string, unknown>;

export type AionisMcpClient = Pick<AionisClient, "remember" | "measure" | "snapshot" | "health"> & {
  governMemory: AionisClient["governMemory"];
  flightRecorder: AionisClient["flightRecorder"];
  execution: Pick<
    AionisClient["execution"],
    "observeStep" | "handoff" | "guideForRole" | "observeOutcome" | "measureRun" | "snapshotRun"
  >;
};

export type AionisContextInput = {
  run_id: string;
  task_signature: string;
  query_text: string;
  task_id?: string;
  task_family?: string;
  workflow_signature?: string;
  agent_id?: string;
  team_id?: string;
  role?: AionisExecutionAgentRole;
  tenant_id?: string;
  scope?: string;
  memory_lane?: AionisMemoryLane;
  title?: string;
  summary?: string;
  outcome?: AionisExecutionOutcomeStatus;
  target_files?: string[];
  tool_candidates?: string[];
  context?: JsonRecord;
  guide?: JsonRecord;
  limit?: number;
  mode?: AionisGuideMode;
  context_mode?: AionisGuideContextMode;
  context_char_budget?: number;
  context_token_budget?: number;
  context_compaction_profile?: "balanced" | "aggressive";
  context_optimization_profile?: "balanced" | "aggressive";
  repo_state?: AionisExecutionRepoState;
  budget_profile?: AionisExecutionContextBudgetProfile;
  max_prompt_chars?: number;
  include_base_prompt?: boolean;
  additional_instructions?: string[];
};

export type AionisRecordStepInput = {
  run_id: string;
  task_signature: string;
  title: string;
  summary: string;
  task_id?: string;
  task_family?: string;
  workflow_signature?: string;
  agent_id?: string;
  team_id?: string;
  role?: AionisExecutionAgentRole;
  tenant_id?: string;
  scope?: string;
  memory_lane?: AionisMemoryLane;
  outcome?: AionisExecutionOutcomeStatus;
  target_files?: string[];
  workflow_steps?: string[];
  tool_set?: string[];
  acceptance_checks?: string[];
  continuation_hint?: string;
  resume_hint?: string;
  reuse_hint?: string;
  confidence?: number;
  raw_ref?: string;
  evidence_ref?: string;
  guide?: unknown;
  guide_trace_id?: string;
  used_memory_ids?: string[];
  feedback?: boolean;
  feedback_outcome?: AionisFeedbackOutcome;
  used_surface?: AionisFeedbackUsedSurface;
  tool_status?: AionisToolStatus;
  feedback_reason?: string;
};

export type AionisHandoffInput = AionisRecordStepInput & {
  handoff_kind?: AionisHandoffKind;
  anchor?: string;
  handoff_text?: string;
  risk?: string;
  tags?: string[];
  next_action?: string;
  must_change?: string[];
  must_remove?: string[];
  must_keep?: string[];
};

export type AionisRememberInput = {
  text: string;
  kind?: AionisRememberKind;
  title?: string;
  client_id?: string;
  memory_lane?: AionisMemoryLane;
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  lifecycle_state?: AionisRememberLifecycleState;
  tier?: AionisRememberTier;
  confidence?: number;
  salience?: number;
  importance?: number;
  auto_embed?: boolean;
  raw_ref?: string;
  evidence_ref?: string;
  target_files?: string[];
  slots?: JsonRecord;
  tenant_id?: string;
  scope?: string;
};

export type AionisGovernMemoryInput = {
  query_text: string;
  run_id?: string;
  tenant_id?: string;
  scope?: string;
  mode?: "standard" | "strict" | "firewall";
  context_mode?: "standard" | "compact_agent";
  include_records?: boolean;
  candidates: AionisExternalMemoryCandidate[];
};

export type AionisMeasureInput = {
  run_id: string;
  task_signature: string;
  task_id?: string;
  task_family?: string;
  workflow_signature?: string;
  tenant_id?: string;
  scope?: string;
  before_guide?: unknown;
  after_guide: unknown;
  feedback_result?: unknown;
  sufficient_evidence?: boolean;
  evidence_ids?: string[];
  product_trace?: JsonRecord;
};

export type AionisSnapshotInput = {
  run_id: string;
  task_signature?: string;
  task_id?: string;
  task_family?: string;
  workflow_signature?: string;
  tenant_id?: string;
  scope?: string;
  guide?: unknown;
  measure_result?: unknown;
  include_markdown?: boolean;
  extra?: JsonRecord;
};

export type AionisFlightRecorderInput = AionisAgentFlightRecorderRequest & {
  tenant_id?: string;
  scope?: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonRecord;
};

export function createAionisMcpClient(config: AionisMcpConfig): AionisClient {
  return createAionisClient(clientOptionsFromMcpConfig(config));
}

function result(payload: JsonRecord): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function optionalRepoState(value: unknown, label: string): AionisExecutionRepoState | undefined {
  if (value === undefined) return undefined;
  const state = asRecord(value, label);
  const existing_files = optionalStringArray(state.existing_files, `${label}.existing_files`);
  const missing_files = optionalStringArray(state.missing_files, `${label}.missing_files`);
  if (state.files !== undefined) {
    if (!Array.isArray(state.files)) throw new Error(`${label}.files must be an array`);
    for (const [index, file] of state.files.entries()) {
      const entry = asRecord(file, `${label}.files[${index}]`);
      if (typeof entry.target !== "string") throw new Error(`${label}.files[${index}].target must be a string`);
      if (typeof entry.exists !== "boolean") throw new Error(`${label}.files[${index}].exists must be a boolean`);
      if (entry.reason !== undefined && typeof entry.reason !== "string") {
        throw new Error(`${label}.files[${index}].reason must be a string`);
      }
    }
  }
  return {
    ...state,
    existing_files,
    missing_files,
    files: state.files as AionisExecutionRepoState["files"],
  };
}

function contextInput(args: unknown): AionisContextInput {
  const input = asRecord(args, "aionis_context input");
  return {
    ...input,
    run_id: String(input.run_id ?? ""),
    task_signature: String(input.task_signature ?? ""),
    query_text: String(input.query_text ?? ""),
    target_files: optionalStringArray(input.target_files, "target_files"),
    tool_candidates: optionalStringArray(input.tool_candidates, "tool_candidates"),
    additional_instructions: optionalStringArray(input.additional_instructions, "additional_instructions"),
    repo_state: optionalRepoState(input.repo_state, "repo_state"),
  } as AionisContextInput;
}

function recordStepInput(args: unknown): AionisRecordStepInput {
  const input = asRecord(args, "aionis_record_step input");
  return {
    ...input,
    run_id: String(input.run_id ?? ""),
    task_signature: String(input.task_signature ?? ""),
    title: String(input.title ?? ""),
    summary: String(input.summary ?? ""),
    target_files: optionalStringArray(input.target_files, "target_files"),
    workflow_steps: optionalStringArray(input.workflow_steps, "workflow_steps"),
    tool_set: optionalStringArray(input.tool_set, "tool_set"),
    acceptance_checks: optionalStringArray(input.acceptance_checks, "acceptance_checks"),
    used_memory_ids: optionalStringArray(input.used_memory_ids, "used_memory_ids"),
  } as AionisRecordStepInput;
}

function handoffInput(args: unknown): AionisHandoffInput {
  const input = recordStepInput(args);
  return {
    ...input,
    tags: optionalStringArray((args as JsonRecord).tags, "tags"),
    must_change: optionalStringArray((args as JsonRecord).must_change, "must_change"),
    must_remove: optionalStringArray((args as JsonRecord).must_remove, "must_remove"),
    must_keep: optionalStringArray((args as JsonRecord).must_keep, "must_keep"),
  } as AionisHandoffInput;
}

function rememberInput(args: unknown): AionisRememberInput {
  const input = asRecord(args, "aionis_remember input");
  return {
    ...input,
    text: String(input.text ?? ""),
    target_files: optionalStringArray(input.target_files, "target_files"),
  } as AionisRememberInput;
}

function governMemoryInput(args: unknown): AionisGovernMemoryInput {
  const input = asRecord(args, "aionis_govern_memory input");
  if (!Array.isArray(input.candidates)) throw new Error("candidates must be an array");
  return {
    ...input,
    query_text: String(input.query_text ?? ""),
    candidates: input.candidates as AionisExternalMemoryCandidate[],
  } as AionisGovernMemoryInput;
}

function measureInput(args: unknown): AionisMeasureInput {
  const input = asRecord(args, "aionis_measure input");
  return {
    ...input,
    run_id: String(input.run_id ?? ""),
    task_signature: String(input.task_signature ?? ""),
    evidence_ids: optionalStringArray(input.evidence_ids, "evidence_ids"),
  } as AionisMeasureInput;
}

function snapshotInput(args: unknown): AionisSnapshotInput {
  const input = asRecord(args, "aionis_snapshot input");
  return {
    ...input,
    run_id: String(input.run_id ?? ""),
    task_signature: typeof input.task_signature === "string" ? input.task_signature : undefined,
  } as AionisSnapshotInput;
}

function flightRecorderInput(args: unknown): AionisFlightRecorderInput {
  const input = asRecord(args, "aionis_flight_recorder input");
  return { ...input } as AionisFlightRecorderInput;
}

function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function feedbackEnabled(input: AionisRecordStepInput): boolean {
  if (input.feedback === false) return false;
  return Boolean(input.guide || input.guide_trace_id) && Boolean(input.used_memory_ids?.length);
}

export async function handleAionisMcpTool(
  client: AionisMcpClient,
  name: AionisMcpToolName,
  args: unknown,
): Promise<ToolResult> {
  if (name === "aionis_context") {
    const input = contextInput(args);
    requireNonEmpty(input.run_id, "run_id");
    requireNonEmpty(input.task_signature, "task_signature");
    requireNonEmpty(input.query_text, "query_text");

    let observed: unknown = null;
    if (input.title?.trim() && input.summary?.trim()) {
      observed = await client.execution.observeStep({
        run_id: input.run_id,
        task_id: input.task_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
        agent_id: input.agent_id,
        team_id: input.team_id,
        role: input.role,
        tenant_id: input.tenant_id,
        scope: input.scope,
        memory_lane: input.memory_lane,
        title: input.title,
        summary: input.summary,
        outcome: input.outcome ?? "unknown",
        target_files: input.target_files,
      });
    }

    const guide = await client.execution.guideForRole({
      run_id: input.run_id,
      task_id: input.task_id,
      task_signature: input.task_signature,
      task_family: input.task_family,
      workflow_signature: input.workflow_signature,
      agent_id: input.agent_id,
      team_id: input.team_id,
      role: input.role,
      tenant_id: input.tenant_id,
      scope: input.scope,
      query_text: input.query_text,
      context: input.context,
      tool_candidates: input.tool_candidates,
      limit: input.limit,
      mode: input.mode,
      context_mode: input.context_mode,
      context_char_budget: input.context_char_budget,
      context_token_budget: input.context_token_budget,
      context_compaction_profile: input.context_compaction_profile,
      context_optimization_profile: input.context_optimization_profile,
      guide: input.guide,
    });
    const executionContext = compileExecutionAgentContext({
      guide,
      task: {
        run_id: input.run_id,
        task_id: input.task_id,
        task_signature: input.task_signature,
        query_text: input.query_text,
      },
      repo_state: input.repo_state,
      budget_profile: input.budget_profile,
      max_prompt_chars: input.max_prompt_chars,
      include_base_prompt: input.include_base_prompt,
      additional_instructions: input.additional_instructions,
    });
    return result({
      ok: true,
      observed,
      guide,
      agent_prompt: executionContext.agent_prompt,
      execution_context: executionContext,
      memory_use_receipt: executionContext.memory_use_receipt,
      memory_admission_record: executionContext.memory_admission_record,
      rehydrate_requests: executionContext.rehydrate_requests,
      execution_warnings: executionContext.execution_warnings,
      command_posture: commandPostureFromGuide(guide),
      command_posture_memory_ids: commandPostureMemoryIdsFromGuide(guide),
      route_contract: routeContractFromGuide(guide),
      must_not_memory_ids: mustNotMemoryIdsFromGuide(guide),
      should_continue_memory_ids: shouldContinueMemoryIdsFromGuide(guide),
      inspect_first_memory_ids: inspectFirstMemoryIdsFromGuide(guide),
      rehydrate_first_memory_ids: rehydrateFirstMemoryIdsFromGuide(guide),
      drop_in_mode: true,
      feedback_required: false,
    });
  }

  if (name === "aionis_record_step") {
    const input = recordStepInput(args);
    requireNonEmpty(input.run_id, "run_id");
    requireNonEmpty(input.task_signature, "task_signature");
    requireNonEmpty(input.title, "title");
    requireNonEmpty(input.summary, "summary");
    const payload = await client.execution.observeOutcome({
      ...input,
      feedback: feedbackEnabled(input),
    });
    return result({ ok: true, ...payload, feedback_required: false });
  }

  if (name === "aionis_handoff") {
    const input = handoffInput(args);
    requireNonEmpty(input.run_id, "run_id");
    requireNonEmpty(input.task_signature, "task_signature");
    requireNonEmpty(input.title, "title");
    requireNonEmpty(input.summary, "summary");
    const handoff = await client.execution.handoff(input);
    return result({ ok: true, handoff });
  }

  if (name === "aionis_remember") {
    const input = rememberInput(args);
    requireNonEmpty(input.text, "text");
    const { tenant_id: tenantId, scope, ...body } = input;
    const remembered = await client.remember(body, { tenant_id: tenantId, scope });
    return result({ ok: true, remembered });
  }

  if (name === "aionis_govern_memory") {
    const input = governMemoryInput(args);
    requireNonEmpty(input.query_text, "query_text");
    if (input.candidates.length === 0) throw new Error("candidates is required");
    const { tenant_id: tenantId, scope, ...body } = input;
    const governed = await client.governMemory(body, { tenant_id: tenantId, scope });
    const governedRecord = governed as unknown as JsonRecord;
    return result({
      ok: true,
      governed,
      agent_context: governedRecord.agent_context,
      memory_use_receipt: governedRecord.memory_use_receipt,
      memory_firewall: governedRecord.memory_firewall,
      memory_admission_records: governedRecord.memory_admission_records,
      admission_summary: governedRecord.admission_summary,
    });
  }

  if (name === "aionis_measure") {
    const input = measureInput(args);
    requireNonEmpty(input.run_id, "run_id");
    requireNonEmpty(input.task_signature, "task_signature");
    const measure = await client.execution.measureRun(input);
    return result({ ok: true, measure });
  }

  if (name === "aionis_snapshot") {
    const input = snapshotInput(args);
    requireNonEmpty(input.run_id, "run_id");
    if (input.task_signature && input.guide && input.measure_result) {
      const snapshot = await client.execution.snapshotRun({
        run_id: input.run_id,
        task_id: input.task_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
        tenant_id: input.tenant_id,
        scope: input.scope,
        guide: input.guide,
        measure_result: input.measure_result,
        include_markdown: input.include_markdown,
        extra: input.extra,
      });
      return result({ ok: true, snapshot });
    }
    const snapshot = await client.snapshot({
      run_id: input.run_id,
      task_signature: input.task_signature,
      task_id: input.task_id,
      task_family: input.task_family,
      workflow_signature: input.workflow_signature,
      include_markdown: input.include_markdown,
      ...(input.extra ?? {}),
    }, {
      tenant_id: input.tenant_id,
      scope: input.scope,
    });
    return result({ ok: true, snapshot });
  }

  if (name === "aionis_flight_recorder") {
    const input = flightRecorderInput(args);
    const { tenant_id: tenantId, scope, ...body } = input;
    const replay = await client.flightRecorder(body, { tenant_id: tenantId, scope });
    const replayRecord = replay as unknown as JsonRecord;
    return result({
      ok: true,
      replay,
      agent_flight_recorder: replayRecord.agent_flight_recorder,
    });
  }

  if (name === "aionis_health") {
    const health = await client.health();
    return result({ ok: true, health });
  }

  throw new Error(`Unknown Aionis MCP tool: ${name}`);
}
