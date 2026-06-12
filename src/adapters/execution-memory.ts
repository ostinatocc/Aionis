import type {
  ExecutionTreeOperationV1,
  ExecutionTreeV1,
} from "../execution/index.js";
import type {
  AionisGuideContextMode,
  AionisGuideMode,
  AionisGuideRequestOptions,
  AionisJsonObject,
  AionisRequestOptions,
} from "../sdk.js";

export type ExecutionMemoryAgentRole = "agent" | "planner" | "worker" | "verifier" | "reviewer";

export const EXECUTION_MEMORY_ADAPTER_CONTRACT_VERSION = "aionis_execution_memory_adapter_v1" as const;

export const EXECUTION_MEMORY_ADAPTER_CONTRACT = {
  contract_version: EXECUTION_MEMORY_ADAPTER_CONTRACT_VERSION,
  host_required: [
    "client",
    "agent_id_or_default_agent_id",
    "run_id",
    "task_signature",
    "title",
    "summary",
  ],
  guide_required: [
    "query_text",
    "agent_id_or_default_agent_id",
    "run_id",
    "task_signature",
  ],
  shared_memory_required: [
    "team_id_or_default_team_id",
  ],
  advanced_optional: [
    "execution_tree_v1",
    "execution_tree_operations_v1",
    "guide_run_id",
    "guide_trace_id",
    "used_memory_ids",
    "runtime_signal_refs",
    "before_guide",
    "after_guide",
    "forget_result",
    "measure_result",
    "execution_context",
    "operator_snapshot",
  ],
  agent_surface: "agent_context",
  default_guide_mode: "full_power",
} as const;

export type ExecutionMemoryClient = {
  observe<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
  guide<T = unknown>(body: AionisJsonObject, options?: AionisGuideRequestOptions): Promise<T>;
  forget<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
  feedback?<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
  rehydrate?<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
  measure<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
  operatorSnapshot<T = unknown>(body: AionisJsonObject, options?: AionisRequestOptions): Promise<T>;
};

export type ExecutionMemoryAdapterOptions = {
  client: ExecutionMemoryClient;
  tenant_id?: string;
  scope?: string;
  team_id?: string;
  default_agent_id?: string;
  default_agent_role?: ExecutionMemoryAgentRole;
  default_memory_lane?: "private" | "shared";
  default_limit?: number;
  default_guide_mode?: AionisGuideMode;
  include_packets_by_default?: boolean;
};

export type ExecutionMemoryAgentRef = {
  agent_id?: string;
  team_id?: string;
  role?: ExecutionMemoryAgentRole;
};

export type ExecutionMemoryRunRef = {
  run_id: string;
  task_id?: string;
  task_signature: string;
  task_family?: string;
  workflow_signature?: string;
};

export type ExecutionMemoryHostRequiredFields = ExecutionMemoryRunRef & {
  title: string;
  summary: string;
};

export type ExecutionMemoryHostAgentIdentity = {
  agent_id: string;
  role: ExecutionMemoryAgentRole;
  team_id?: string;
};

export type ExecutionMemoryHostAdvancedFields = {
  tenant_id?: string;
  scope?: string;
  memory_lane?: "private" | "shared";
  auto_embed?: boolean;
  target_files?: string[];
  workflow_steps?: string[];
  tool_set?: string[];
  acceptance_checks?: string[];
  continuation_hint?: string;
  confidence?: number;
  raw_ref?: string;
  evidence_ref?: string;
  evidence?: unknown[];
  verification?: unknown;
  slots?: AionisJsonObject;
  execution?: AionisJsonObject;
};

export type ExecutionMemoryBaseInput = ExecutionMemoryRunRef & ExecutionMemoryAgentRef & {
  tenant_id?: string;
  scope?: string;
  memory_lane?: "private" | "shared";
  auto_embed?: boolean;
};

export type ExecutionMemoryRunStartInput = ExecutionMemoryBaseInput & {
  title: string;
  summary: string;
  target_files?: string[];
  workflow_steps?: string[];
  tool_set?: string[];
  acceptance_checks?: string[];
  continuation_hint?: string;
  confidence?: number;
  evidence?: unknown[];
  input_text?: string;
  execution?: AionisJsonObject;
};

export type ExecutionMemoryStepInput = ExecutionMemoryBaseInput & {
  title: string;
  summary: string;
  outcome?: string;
  target_files?: string[];
  workflow_steps?: string[];
  tool_set?: string[];
  acceptance_checks?: string[];
  continuation_hint?: string;
  confidence?: number;
  raw_ref?: string;
  evidence_ref?: string;
  evidence?: unknown[];
  verification?: unknown;
  slots?: AionisJsonObject;
  input_text?: string;
  execution?: AionisJsonObject;
  handoff?: AionisJsonObject & {
    execution_tree_v1?: ExecutionTreeV1;
    execution_tree_operations_v1?: ExecutionTreeOperationV1[];
  };
};

export type ExecutionMemoryGuideInput = ExecutionMemoryRunRef & ExecutionMemoryAgentRef & {
  tenant_id?: string;
  scope?: string;
  query_text: string;
  context?: AionisJsonObject;
  execution_tree_v1?: ExecutionTreeV1 | null;
  tool_candidates?: string[];
  limit?: number;
  include_packets?: boolean;
  mode?: AionisGuideMode;
  context_mode?: AionisGuideContextMode;
  guide?: AionisJsonObject;
};

export type ExecutionMemoryOutcomeInput = ExecutionMemoryStepInput & {
  guide_run_id?: string;
  used_memory_ids?: string[];
  guide_trace_id?: string;
  feedback?: boolean;
  feedback_outcome?: "positive" | "negative" | "neutral";
  used_surface?: "use_now" | "inspect_before_use" | "do_not_use" | "explicit_host_assertion";
  verifier_status?: "passed" | "failed" | "unknown";
  tool_status?: "succeeded" | "failed" | "unknown";
  runtime_signal_refs?: string[];
  feedback_reason?: string;
};

export type ExecutionMemoryMeasureInput = ExecutionMemoryRunRef & {
  tenant_id?: string;
  scope?: string;
  before_guide?: unknown;
  after_guide?: unknown;
  forget_result?: unknown;
  sufficient_evidence?: boolean;
  evidence_ids?: string[];
  task?: AionisJsonObject;
  product_trace?: AionisJsonObject;
};

export type ExecutionMemoryOperatorSnapshotInput = ExecutionMemoryRunRef & {
  tenant_id?: string;
  scope?: string;
  guide_run_id?: string;
  agent_context?: unknown;
  guide_packet?: unknown;
  memory_decision_trace?: unknown;
  memory_decision_audit?: unknown;
  effect_report?: unknown;
  execution_context?: unknown;
  guide_trace_id?: string;
  measure_result?: unknown;
  include_markdown?: boolean;
  source_map?: AionisJsonObject;
  snapshot?: AionisJsonObject;
};

export type ExecutionMemoryOutcomeResult<TObserve = unknown, TFeedback = unknown> = {
  observe: TObserve;
  feedback: TFeedback | null;
};

function stripUndefined<T extends Record<string, unknown>>(value: T): AionisJsonObject {
  const out: AionisJsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) out[key] = entry;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | null {
  const record = asRecord(value);
  const entry = record?.[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function requiredString(value: string | undefined, message: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function observeTree(value: unknown): ExecutionTreeV1 | null {
  const body = asRecord(value);
  const handoffTree = asRecord(asRecord(body?.handoff)?.execution_tree_v1);
  if (handoffTree) return handoffTree as ExecutionTreeV1;
  const topTree = asRecord(body?.execution_tree_v1);
  return topTree ? topTree as ExecutionTreeV1 : null;
}

function guideTraceId(value: unknown): string | null {
  return stringField(value, "guide_trace_id");
}

function guideUseNowMemoryIds(value: unknown): string[] {
  const context = asRecord(asRecord(value)?.agent_context);
  return stringArray(context?.use_now_memory_ids);
}

function positiveOutcome(outcome: string | undefined): boolean {
  return !!outcome && /^(?:succeeded|success|passed|pass|ok|completed)$/i.test(outcome.trim());
}

function negativeOutcome(outcome: string | undefined): boolean {
  return !!outcome && /^(?:failed|failure|error|rejected|blocked)$/i.test(outcome.trim());
}

function feedbackOutcome(input: ExecutionMemoryOutcomeInput): "positive" | "negative" | "neutral" {
  if (input.feedback_outcome) return input.feedback_outcome;
  if (positiveOutcome(input.outcome)) return "positive";
  if (negativeOutcome(input.outcome)) return "negative";
  return "neutral";
}

function verifierStatus(input: ExecutionMemoryOutcomeInput): "passed" | "failed" | "unknown" {
  if (input.verifier_status) return input.verifier_status;
  if (positiveOutcome(input.outcome)) return "passed";
  if (negativeOutcome(input.outcome)) return "failed";
  return "unknown";
}

function toolStatus(input: ExecutionMemoryOutcomeInput): "succeeded" | "failed" | "unknown" {
  if (input.tool_status) return input.tool_status;
  if (positiveOutcome(input.outcome)) return "succeeded";
  if (negativeOutcome(input.outcome)) return "failed";
  return "unknown";
}

function executionResultSummary(input: ExecutionMemoryStepInput): AionisJsonObject | null {
  if (!input.outcome) return null;
  return stripUndefined({
    status: positiveOutcome(input.outcome) ? "passed" : negativeOutcome(input.outcome) ? "failed" : input.outcome,
    summary: input.summary,
    evidence_refs: input.evidence_ref ? [input.evidence_ref] : undefined,
  });
}

export class AionisExecutionMemoryAdapter {
  private readonly client: ExecutionMemoryClient;
  private readonly defaults: Omit<ExecutionMemoryAdapterOptions, "client">;
  private currentExecutionTree: ExecutionTreeV1 | null = null;
  private readonly guidesByRunId = new Map<string, unknown[]>();
  private readonly feedbackByRunId = new Map<string, unknown>();
  private readonly measureByRunId = new Map<string, unknown>();

  constructor(options: ExecutionMemoryAdapterOptions) {
    this.client = options.client;
    this.defaults = {
      tenant_id: options.tenant_id,
      scope: options.scope,
      team_id: options.team_id,
      default_agent_id: options.default_agent_id,
      default_agent_role: options.default_agent_role,
      default_memory_lane: options.default_memory_lane ?? "shared",
      default_limit: options.default_limit ?? 10,
      default_guide_mode: options.default_guide_mode ?? "full_power",
      include_packets_by_default: options.include_packets_by_default ?? true,
    };
  }

  async observeRunStart<T = unknown>(input: ExecutionMemoryRunStartInput): Promise<T> {
    return this.observeExecution<T>({
      ...input,
      outcome: "unknown",
    });
  }

  async observeStep<T = unknown>(input: ExecutionMemoryStepInput): Promise<T> {
    if (input.handoff) {
      const body = this.observeBase(input);
      const response = await this.client.observe<T>({
        ...body,
        handoff: this.handoffPayload(input),
      }, this.requestOptions(input));
      this.rememberTree(response);
      return response;
    }
    return this.observeExecution<T>(input);
  }

  async guideNext<T = unknown>(input: ExecutionMemoryGuideInput): Promise<T> {
    const teamId = this.teamId(input);
    this.assertSharedTeamBoundary(this.defaults.default_memory_lane ?? "shared", teamId);
    const legacyContextModeAsGuideMode =
      input.context_mode === "standard" || input.context_mode === "full_power" ? input.context_mode : undefined;
    const agentContextMode = input.context_mode === "compact_agent" ? "compact_agent" : undefined;
    const response = await this.client.guide<T>({
      query_text: input.query_text,
      agent_role: this.role(input),
      consumer_agent_id: this.agentId(input),
      consumer_team_id: teamId,
      context: {
        task_signature: input.task_signature,
        ...(input.task_family ? { task_family: input.task_family } : {}),
        ...(input.workflow_signature ? { workflow_signature: input.workflow_signature } : {}),
        ...(input.context ?? {}),
      },
      execution_tree_v1: input.execution_tree_v1 ?? this.currentExecutionTree ?? undefined,
      tool_candidates: input.tool_candidates,
      limit: input.limit ?? this.defaults.default_limit,
      include_packets: input.include_packets ?? this.defaults.include_packets_by_default,
      mode: input.mode ?? legacyContextModeAsGuideMode ?? this.defaults.default_guide_mode ?? "full_power",
      ...(agentContextMode ? { context_mode: agentContextMode } : {}),
      ...(input.guide ?? {}),
    }, this.requestOptions(input));
    this.rememberGuide(input.run_id, response);
    return response;
  }

  async observeOutcome<TObserve = unknown, TFeedback = unknown>(
    input: ExecutionMemoryOutcomeInput,
  ): Promise<ExecutionMemoryOutcomeResult<TObserve, TFeedback>> {
    const observe = await this.observeStep<TObserve>(input);
    const feedback = input.feedback === false ? null : await this.feedbackForOutcome<TFeedback>(input);
    return { observe, feedback };
  }

  async measureRun<T = unknown>(input: ExecutionMemoryMeasureInput): Promise<T> {
    const guides = this.guidesByRunId.get(input.run_id) ?? [];
    const beforeGuide = input.before_guide ?? guides[0] ?? null;
    const afterGuide = input.after_guide ?? guides.at(-1) ?? null;
    const forgetResult = input.forget_result ?? this.feedbackByRunId.get(input.run_id) ?? null;
    const response = await this.client.measure<T>({
      task: {
        task_id: input.task_id,
        run_id: input.run_id,
        task_signature: input.task_signature,
        task_family: input.task_family,
        workflow_signature: input.workflow_signature,
        ...(input.task ?? {}),
      },
      product_trace: {
        before_guide: beforeGuide,
        after_guide: afterGuide,
        forget_result: forgetResult,
        sufficient_evidence: input.sufficient_evidence ?? true,
        evidence_ids: input.evidence_ids ?? [],
        ...(input.product_trace ?? {}),
      },
    }, this.requestOptions(input));
    this.measureByRunId.set(input.run_id, response);
    return response;
  }

  async operatorSnapshotRun<T = unknown>(input: ExecutionMemoryOperatorSnapshotInput): Promise<T> {
    const guideRunId = input.guide_run_id ?? input.run_id;
    const guide = this.lastGuide(guideRunId) ?? this.lastGuide(input.run_id);
    const guideRecord = asRecord(guide);
    const measureResult = input.measure_result ?? this.measureByRunId.get(input.run_id) ?? null;
    const measureRecord = asRecord(measureResult);
    return this.client.operatorSnapshot<T>({
      run_id: input.run_id,
      task_signature: input.task_signature,
      task_family: input.task_family,
      workflow_signature: input.workflow_signature,
      agent_context: input.agent_context ?? guideRecord?.agent_context,
      guide_packet: input.guide_packet ?? guideRecord?.guide_packet,
      memory_decision_trace: input.memory_decision_trace ?? measureRecord?.memory_decision_trace,
      memory_decision_audit: input.memory_decision_audit ?? measureRecord?.memory_decision_audit,
      effect_report: input.effect_report ?? measureRecord?.effect_report,
      execution_context: input.execution_context,
      guide_trace_id: input.guide_trace_id ?? guideTraceId(guide),
      include_markdown: input.include_markdown ?? true,
      source_map: input.source_map,
      ...(input.snapshot ?? {}),
    }, this.requestOptions(input));
  }

  get execution_tree_v1(): ExecutionTreeV1 | null {
    return this.currentExecutionTree;
  }

  private async observeExecution<T = unknown>(input: ExecutionMemoryStepInput): Promise<T> {
    const response = await this.client.observe<T>({
      ...this.observeBase(input),
      input_text: input.input_text ?? `${input.title}\n${input.summary}`,
      execution: this.executionPayload(input),
    }, this.requestOptions(input));
    this.rememberTree(response);
    return response;
  }

  private async feedbackForOutcome<T = unknown>(input: ExecutionMemoryOutcomeInput): Promise<T | null> {
    const usedMemoryIds = input.used_memory_ids ?? [];
    if (usedMemoryIds.length === 0) return null;
    const feedbackRunId = input.guide_run_id ?? input.run_id;
    const lastGuide = this.lastGuide(feedbackRunId);
    const traceId = input.guide_trace_id ?? guideTraceId(lastGuide);
    if (!traceId) return null;
    const feedbackBody = {
      target: "memory",
      actor: this.agentId(input),
      guide_trace_id: traceId,
      used_memory_ids: usedMemoryIds,
      run_id: input.run_id,
      outcome: feedbackOutcome(input),
      used_surface: input.used_surface ?? "use_now",
      verifier_status: verifierStatus(input),
      tool_status: toolStatus(input),
      runtime_signal_refs: input.runtime_signal_refs,
      reason: input.feedback_reason ?? input.summary,
    };
    const requestOptions = this.requestOptions(input);
    const response = this.client.feedback
      ? await this.client.feedback<T>(feedbackBody, requestOptions)
      : await this.client.forget<T>({
        operation: "activate",
        ...feedbackBody,
      }, requestOptions);
    this.feedbackByRunId.set(feedbackRunId, response);
    return response;
  }

  private observeBase(input: ExecutionMemoryBaseInput): AionisJsonObject {
    const memoryLane = this.memoryLane(input);
    const teamId = this.teamId(input);
    this.assertSharedTeamBoundary(memoryLane, teamId);
    return stripUndefined({
      auto_embed: input.auto_embed ?? true,
      memory_lane: memoryLane,
      producer_agent_id: this.agentId(input),
      owner_team_id: teamId,
    });
  }

  private executionPayload(input: ExecutionMemoryStepInput): AionisJsonObject {
    const result = executionResultSummary(input);
    return stripUndefined({
      run_id: input.run_id,
      task_id: input.task_id,
      task_family: input.task_family,
      task_signature: input.task_signature,
      workflow_signature: input.workflow_signature,
      title: input.title,
      summary: input.summary,
      outcome: input.outcome,
      target_files: input.target_files,
      workflow_steps: input.workflow_steps,
      tool_set: input.tool_set,
      acceptance_checks: input.acceptance_checks,
      continuation_hint: input.continuation_hint,
      confidence: input.confidence,
      raw_ref: input.raw_ref,
      evidence_ref: input.evidence_ref,
      evidence: input.evidence,
      verification: input.verification,
      slots: {
        task_signature: input.task_signature,
        ...(result ? { execution_result_summary: result } : {}),
        ...(input.slots ?? {}),
      },
      ...(input.execution ?? {}),
    });
  }

  private handoffPayload(input: ExecutionMemoryStepInput): AionisJsonObject {
    const memoryLane = this.memoryLane(input);
    const teamId = this.teamId(input);
    this.assertSharedTeamBoundary(memoryLane, teamId);
    return stripUndefined({
      memory_lane: memoryLane,
      producer_agent_id: this.agentId(input),
      owner_team_id: teamId,
      task_signature: input.task_signature,
      title: input.title,
      summary: input.summary,
      ...(input.handoff ?? {}),
    });
  }

  private agentId(input: ExecutionMemoryAgentRef): string {
    return requiredString(
      input.agent_id ?? this.defaults.default_agent_id,
      "ExecutionMemoryAdapter requires agent_id on the call or default_agent_id in adapter options.",
    );
  }

  private teamId(input: ExecutionMemoryAgentRef): string | undefined {
    const value = input.team_id ?? this.defaults.team_id;
    return value?.trim() || undefined;
  }

  private role(input: ExecutionMemoryAgentRef): ExecutionMemoryAgentRole {
    return input.role ?? this.defaults.default_agent_role ?? "agent";
  }

  private requestOptions(input: { tenant_id?: string; scope?: string }): AionisRequestOptions {
    return stripUndefined({
      tenant_id: input.tenant_id ?? this.defaults.tenant_id,
      scope: input.scope ?? this.defaults.scope,
    });
  }

  private memoryLane(input: { memory_lane?: "private" | "shared" }): "private" | "shared" {
    return input.memory_lane ?? this.defaults.default_memory_lane ?? "shared";
  }

  private assertSharedTeamBoundary(memoryLane: "private" | "shared", teamId: string | undefined): void {
    if (memoryLane === "shared" && !teamId) {
      throw new Error(
        "ExecutionMemoryAdapter requires team_id or default team_id for shared multi-agent memory; use memory_lane: \"private\" for single-agent memory.",
      );
    }
  }

  private rememberGuide(runId: string, guide: unknown): void {
    const current = this.guidesByRunId.get(runId) ?? [];
    this.guidesByRunId.set(runId, current.concat([guide]));
  }

  private lastGuide(runId: string): unknown | null {
    const guides = this.guidesByRunId.get(runId) ?? [];
    return guides.at(-1) ?? null;
  }

  private rememberTree(response: unknown): void {
    const tree = observeTree(response);
    if (tree) this.currentExecutionTree = tree;
  }
}

export function createExecutionMemoryAdapter(options: ExecutionMemoryAdapterOptions): AionisExecutionMemoryAdapter {
  return new AionisExecutionMemoryAdapter(options);
}

export function exposedUseNowMemoryIds(guide: unknown): string[] {
  return guideUseNowMemoryIds(guide);
}
