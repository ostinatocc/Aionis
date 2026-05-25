import {
  buildExecutionPacketV1,
  ControlProfileV1Schema,
  ExecutionPacketV1Schema,
  ExecutionStateV1Schema,
  ServiceLifecycleConstraintV1Schema,
  type ControlProfileV1,
  type ExecutionPacketV1,
  type ExecutionStateV1,
  type ReviewerContract,
  type ResumeAnchor,
  type ServiceLifecycleConstraintV1,
} from "../execution/index.js";
import {
  buildExecutionContractContextOverlay,
  buildExecutionContractFromTrajectoryCompile,
  projectExecutionContractToRecoveryContract,
} from "./execution-contract.js";
import { buildTrajectoryCompileLite } from "./trajectory-compile.js";
import type {
  StaticContextBlock,
  TrajectoryCompileHintsInput,
  TrajectoryCompileResponse,
  TrajectoryCompileSourceInput,
} from "./schemas.js";

type MaybeString = string | null | undefined;

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<MaybeString>, limit = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueLifecycleConstraints(
  values: Array<ServiceLifecycleConstraintV1 | null | undefined>,
  limit = 16,
): ServiceLifecycleConstraintV1[] {
  const out: ServiceLifecycleConstraintV1[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const parsed = ServiceLifecycleConstraintV1Schema.parse(value);
    const key = [
      parsed.label,
      parsed.endpoint ?? "",
      parsed.launch_reference ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length >= limit) break;
  }
  return out;
}

function buildReviewerContract(args: {
  taskBrief: string;
  nextAction: string | null;
  targetFiles: string[];
  acceptanceChecks: string[];
  existing: ReviewerContract | null;
}): ReviewerContract | null {
  if (args.existing) {
    return {
      ...args.existing,
      required_outputs: uniqueStrings([
        ...args.existing.required_outputs,
        ...(args.nextAction ? [`next_action:${args.nextAction}`] : []),
        ...(args.targetFiles.length > 0 ? [`target_files:${args.targetFiles.join(", ")}`] : []),
      ], 12),
      acceptance_checks: uniqueStrings([
        ...args.existing.acceptance_checks,
        ...args.acceptanceChecks,
      ], 24),
    };
  }
  if (args.targetFiles.length === 0 && args.acceptanceChecks.length === 0 && !args.nextAction) return null;
  return {
    standard: args.taskBrief,
    required_outputs: uniqueStrings([
      ...(args.nextAction ? [`next_action:${args.nextAction}`] : []),
      ...(args.targetFiles.length > 0 ? [`target_files:${args.targetFiles.join(", ")}`] : []),
    ], 12),
    acceptance_checks: args.acceptanceChecks,
    rollback_required: false,
  };
}

function buildResumeAnchor(args: {
  existing: ResumeAnchor | null;
  targetFiles: string[];
  repoRoot?: string | null;
  stateId: string;
}): ResumeAnchor | null {
  if (args.existing) return args.existing;
  if (args.targetFiles.length === 0 && !args.repoRoot) return null;
  return {
    anchor: `trajectory:${args.stateId}`,
    file_path: args.targetFiles[0] ?? null,
    symbol: null,
    repo_root: args.repoRoot ?? null,
  };
}

function mergeCompiledRecoveryContract(args: {
  existing: unknown;
  compiled: TrajectoryCompileResponse;
}): Record<string, unknown> {
  return projectExecutionContractToRecoveryContract({
    existing: args.existing,
    contract: buildExecutionContractFromTrajectoryCompile(args.compiled),
    summaryVersion: args.compiled.summary_version,
    compilerVersion: args.compiled.compiler_version,
    promotionSeed: args.compiled.promotion_seed,
    noiseMarkers: args.compiled.contract.noise_markers,
  });
}

function mergeTrajectoryCompileContext(args: {
  currentContext: Record<string, unknown>;
  compiled: TrajectoryCompileResponse;
}): Record<string, unknown> {
  const contract = buildExecutionContractFromTrajectoryCompile(args.compiled);
  const recoveryContract = mergeCompiledRecoveryContract({
    existing: args.currentContext.recovery_contract_v1,
    compiled: args.compiled,
  });
  return buildExecutionContractContextOverlay({
    currentContext: args.currentContext,
    contract,
    recoveryContract,
  });
}

export function maybeBuildTrajectoryCompile(args: {
  tenantId?: string | null;
  scope?: string | null;
  actor?: string | null;
  queryText: string;
  trajectory?: TrajectoryCompileSourceInput | null;
  trajectoryHints?: TrajectoryCompileHintsInput | null;
  defaultScope: string;
  defaultTenantId: string;
}): TrajectoryCompileResponse | null {
  if (!args.trajectory) return null;
  return buildTrajectoryCompileLite(
    {
      tenant_id: args.tenantId ?? undefined,
      scope: args.scope ?? undefined,
      actor: args.actor ?? undefined,
      query_text: args.queryText,
      trajectory: args.trajectory,
      hints: args.trajectoryHints ?? undefined,
    },
    {
      defaultScope: args.defaultScope,
      defaultTenantId: args.defaultTenantId,
    },
  );
}

export function buildTrajectoryCompileContextOverlay(compiled: TrajectoryCompileResponse): Record<string, unknown> {
  const contract = buildExecutionContractFromTrajectoryCompile(compiled);
  return {
    task_kind: contract.task_family,
    task_family: contract.task_family,
    task_signature: contract.task_signature,
    workflow_signature: contract.workflow_signature,
    target_files: contract.target_files,
    acceptance_checks: contract.outcome.acceptance_checks,
    next_action: contract.next_action,
    workflow_steps: contract.workflow_steps,
    pattern_hints: contract.pattern_hints,
    likely_tool: contract.selected_tool,
    service_lifecycle_constraints: contract.service_lifecycle_constraints,
    execution_contract_v1: contract,
    recovery_contract_v1: projectExecutionContractToRecoveryContract({
      existing: null,
      contract,
      summaryVersion: compiled.summary_version,
      compilerVersion: compiled.compiler_version,
      promotionSeed: compiled.promotion_seed,
      noiseMarkers: compiled.contract.noise_markers,
    }),
  };
}

export function buildTrajectoryCompileStaticBlocks(compiled: TrajectoryCompileResponse): StaticContextBlock[] {
  const blocks: StaticContextBlock[] = [];
  const contractLines = [
    compiled.task_family ? `task_family=${compiled.task_family}` : null,
    compiled.contract.target_files.length > 0 ? `target_files=${compiled.contract.target_files.join(" | ")}` : null,
    compiled.contract.next_action ? `next_action=${compiled.contract.next_action}` : null,
    compiled.contract.acceptance_checks.length > 0
      ? `acceptance_checks=${compiled.contract.acceptance_checks.join(" | ")}`
      : null,
  ].filter((value): value is string => !!value);
  if (contractLines.length > 0) {
    blocks.push({
      id: `trajectory-compile-${compiled.workflow_signature ?? compiled.task_signature ?? "contract"}`,
      title: "Trajectory Recovery Contract",
      content: contractLines.join("; "),
      tags: ["trajectory-compile", "continuity", "recovery"],
      intents: ["resume", "review", "patch"],
      priority: 96,
      always_include: true,
    });
  }
  const workflowLines = [
    compiled.contract.workflow_steps.length > 0 ? `workflow_steps=${compiled.contract.workflow_steps.join(" | ")}` : null,
    compiled.contract.pattern_hints.length > 0 ? `pattern_hints=${compiled.contract.pattern_hints.join(" | ")}` : null,
    compiled.contract.likely_tool ? `likely_tool=${compiled.contract.likely_tool}` : null,
  ].filter((value): value is string => !!value);
  if (workflowLines.length > 0) {
    blocks.push({
      id: `trajectory-compile-${compiled.workflow_signature ?? compiled.task_signature ?? "workflow"}-workflow`,
      title: "Trajectory Workflow Signals",
      content: workflowLines.join("; "),
      tags: ["trajectory-compile", "workflow", "pattern"],
      intents: ["resume", "patch"],
      priority: 92,
      always_include: true,
    });
  }
  return blocks;
}

export function applyTrajectoryCompileExecutionKernel(args: {
  compiled: TrajectoryCompileResponse;
  queryText: string;
  executionState?: ExecutionStateV1 | null;
  executionPacket?: ExecutionPacketV1 | null;
  controlProfile?: ControlProfileV1 | null;
  repoRoot?: string | null;
  stateIdPrefix?: string;
}): {
  execution_state_v1: ExecutionStateV1;
  execution_packet_v1: ExecutionPacketV1;
  control_profile_v1: ControlProfileV1 | null;
  } {
  const existingState = args.executionState ? ExecutionStateV1Schema.parse(args.executionState) : null;
  const completedValidations = uniqueStrings(existingState?.completed_validations ?? [], 32);
  const completedValidationSet = new Set(completedValidations);
  const targetFiles = uniqueStrings([
    ...args.compiled.contract.target_files,
    ...(existingState?.owned_files ?? []),
    ...(existingState?.modified_files ?? []),
  ], 24);
  const knownAcceptanceChecks = uniqueStrings([
    ...args.compiled.contract.acceptance_checks,
    ...(existingState?.pending_validations ?? []),
    ...(existingState?.completed_validations ?? []),
  ], 32);
  const pendingAcceptanceChecks = uniqueStrings(
    knownAcceptanceChecks.filter((check) => !completedValidationSet.has(check)),
    32,
  );
  const lifecycle = uniqueLifecycleConstraints([
    ...args.compiled.contract.service_lifecycle_constraints,
    ...(existingState?.service_lifecycle_constraints ?? []),
  ], 16);
  const taskBrief = firstString(existingState?.task_brief, args.queryText) ?? "Resume the compiled recovery contract.";
  const stateId = firstString(
    existingState?.state_id,
    args.compiled.task_signature ? `${args.stateIdPrefix ?? "trajectory"}:${args.compiled.task_signature}` : null,
  ) ?? `${args.stateIdPrefix ?? "trajectory"}:recovery`;
  const scope = firstString(existingState?.scope, `${args.compiled.scope}/trajectory/${stateId}`) ?? args.compiled.scope;
  const reviewerContract = buildReviewerContract({
    taskBrief,
    nextAction: args.compiled.contract.next_action,
    targetFiles,
    acceptanceChecks: knownAcceptanceChecks,
    existing: existingState?.reviewer_contract ?? null,
  });
  const resumeAnchor = buildResumeAnchor({
    existing: existingState?.resume_anchor ?? null,
    targetFiles,
    repoRoot: args.repoRoot ?? null,
    stateId,
  });
  const state = ExecutionStateV1Schema.parse({
    version: 1,
    state_id: stateId,
    scope,
    task_brief: taskBrief,
    current_stage: existingState?.current_stage ?? "resume",
    active_role: existingState?.active_role ?? "resume",
    owned_files: targetFiles.length > 0 ? targetFiles : (existingState?.owned_files ?? []),
    modified_files: targetFiles.length > 0 ? targetFiles : (existingState?.modified_files ?? []),
    pending_validations: uniqueStrings([
      ...pendingAcceptanceChecks,
      ...(existingState?.pending_validations ?? []).filter((check) => !completedValidationSet.has(check)),
    ], 32),
    completed_validations: completedValidations,
    last_accepted_hypothesis: existingState?.last_accepted_hypothesis ?? null,
    rejected_paths: existingState?.rejected_paths ?? [],
    unresolved_blockers: existingState?.unresolved_blockers ?? [],
    rollback_notes: existingState?.rollback_notes ?? [],
    service_lifecycle_constraints: lifecycle,
    reviewer_contract: reviewerContract,
    resume_anchor: resumeAnchor,
    updated_at: existingState?.updated_at ?? new Date().toISOString(),
  });
  const existingPacket = args.executionPacket ? ExecutionPacketV1Schema.parse(args.executionPacket) : null;
  const packetBase = existingPacket ?? buildExecutionPacketV1({ state });
  const packet = ExecutionPacketV1Schema.parse({
    ...packetBase,
    version: 1,
    state_id: state.state_id,
    current_stage: state.current_stage,
    active_role: state.active_role,
    task_brief: state.task_brief,
    target_files: uniqueStrings([
      ...args.compiled.contract.target_files,
      ...packetBase.target_files,
      ...targetFiles,
    ], 24),
    next_action: firstString(args.compiled.contract.next_action, packetBase.next_action),
    pending_validations: uniqueStrings(
      [
        ...pendingAcceptanceChecks,
        ...packetBase.pending_validations.filter((check) => !completedValidationSet.has(check)),
      ],
      32,
    ),
    service_lifecycle_constraints: lifecycle,
    review_contract: packetBase.review_contract ?? reviewerContract,
    resume_anchor: packetBase.resume_anchor ?? resumeAnchor,
  });
  const controlProfile = args.controlProfile ? ControlProfileV1Schema.parse(args.controlProfile) : null;
  return {
    execution_state_v1: state,
    execution_packet_v1: packet,
    control_profile_v1: controlProfile,
  };
}

export function mergeTrajectoryCompileSummary(
  raw: unknown,
  compiled: TrajectoryCompileResponse,
): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  base.trajectory_compile_v1 = {
    task_family: compiled.task_family,
    task_signature: compiled.task_signature,
    workflow_signature: compiled.workflow_signature,
    target_file_count: compiled.contract.target_files.length,
    acceptance_check_count: compiled.contract.acceptance_checks.length,
    service_constraint_count: compiled.contract.service_lifecycle_constraints.length,
    likely_tool: compiled.contract.likely_tool,
  };
  const contract = buildExecutionContractFromTrajectoryCompile(compiled);
  base.execution_contract_v1 = {
    task_family: contract.task_family,
    task_signature: contract.task_signature,
    workflow_signature: contract.workflow_signature,
    target_file_count: contract.target_files.length,
    acceptance_check_count: contract.outcome.acceptance_checks.length,
    success_invariant_count: contract.outcome.success_invariants.length,
    dependency_requirement_count: contract.outcome.dependency_requirements.length,
    environment_assumption_count: contract.outcome.environment_assumptions.length,
    must_hold_after_exit_count: contract.outcome.must_hold_after_exit.length,
    external_visibility_requirement_count: contract.outcome.external_visibility_requirements.length,
    selected_tool: contract.selected_tool,
  };
  return base;
}

type TrajectoryAwareRequestShape = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  query_text: string;
  context?: unknown;
  static_context_blocks?: StaticContextBlock[];
  execution_result_summary?: unknown;
  execution_state_v1?: ExecutionStateV1;
  execution_packet_v1?: ExecutionPacketV1;
  trajectory?: TrajectoryCompileSourceInput;
  trajectory_hints?: TrajectoryCompileHintsInput;
};

export function augmentTrajectoryAwareRequest<TParsed extends TrajectoryAwareRequestShape>(args: {
  parsed: TParsed;
  parse: (input: unknown) => TParsed;
  defaultScope: string;
  defaultTenantId: string;
}): {
  parsed: TParsed;
  compiled: TrajectoryCompileResponse | null;
} {
  const compiled = maybeBuildTrajectoryCompile({
    tenantId: args.parsed.tenant_id ?? null,
    scope: args.parsed.scope ?? null,
    actor: args.parsed.actor ?? null,
    queryText: args.parsed.query_text,
    trajectory: args.parsed.trajectory ?? null,
    trajectoryHints: args.parsed.trajectory_hints ?? null,
    defaultScope: args.defaultScope,
    defaultTenantId: args.defaultTenantId,
  });
  if (!compiled) {
    return {
      parsed: args.parsed,
      compiled: null,
    };
  }
  const currentContext =
    args.parsed.context && typeof args.parsed.context === "object" && !Array.isArray(args.parsed.context)
      ? (args.parsed.context as Record<string, unknown>)
      : {};
  const executionKernel = applyTrajectoryCompileExecutionKernel({
    compiled,
    queryText: args.parsed.query_text,
    executionState: args.parsed.execution_state_v1 ?? null,
    executionPacket: args.parsed.execution_packet_v1 ?? null,
    repoRoot: args.parsed.trajectory_hints?.repo_root ?? null,
    stateIdPrefix: "trajectory",
  });
  return {
    parsed: args.parse({
      ...args.parsed,
      context: mergeTrajectoryCompileContext({
        currentContext,
        compiled,
      }),
      static_context_blocks: [
        ...buildTrajectoryCompileStaticBlocks(compiled),
        ...(Array.isArray(args.parsed.static_context_blocks) ? args.parsed.static_context_blocks : []),
      ],
      execution_result_summary: mergeTrajectoryCompileSummary(args.parsed.execution_result_summary, compiled),
      execution_state_v1: executionKernel.execution_state_v1,
      execution_packet_v1: executionKernel.execution_packet_v1,
    }),
    compiled,
  };
}
