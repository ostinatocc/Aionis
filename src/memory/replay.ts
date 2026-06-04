import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  type ReplayNodeRow,
  type ReplayVisibilityArgs,
  type ReplayStoreAccess,
} from "../store/replay-access.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import { HttpError } from "../util/http.js";
import { stableUuid } from "../util/uuid.js";
import {
  applyReplayLearningProjection,
  enqueueReplayLearningProjectionOutbox,
  type ReplayLearningProjectionResolvedConfig,
  type ReplayLearningProjectionResult,
} from "./replay-learning.js";
import {
  adjudicatePolicyMutationV1,
  buildPolicyMutationFromReplayLearningProjection,
  type PolicyMutationAdjudicationV1,
  type PolicyMutationV1,
} from "../kernel/policy-mutation-loop.js";
import { buildReplayCostSignals } from "./cost-signals.js";
import {
  ReplayPlaybookDispatchRequest,
  ReplayPlaybookCandidateRequest,
  ReplayPlaybookCompileRequest,
  ReplayPlaybookGetRequest,
  ReplayPlaybookPromoteRequest,
  ReplayPlaybookRepairRequest,
  ReplayPlaybookRepairReviewRequest,
  ReplayPlaybookRunRequest,
  ReplayRunEndRequest,
  ReplayRunGetRequest,
  ReplayRunStartRequest,
  ReplayStepAfterRequest,
  ReplayStepBeforeRequest,
  ExecutionNativeV1Schema,
  MemoryAnchorV1Schema,
  MemoryPromoteRequest,
  type ReplayRepairReviewLearningControlPreview,
  type ReplayPlaybookDispatchInput,
  type ReplayPlaybookCandidateInput,
  type ReplayPlaybookCompileInput,
  type ReplayPlaybookGetInput,
  type ReplayPlaybookPromoteInput,
  type ReplayPlaybookRepairInput,
  type ReplayPlaybookRepairReviewInput,
  type ReplayPlaybookRunInput,
  type ReplayRunEndInput,
  type ReplayRunGetInput,
  type ReplayRunStartInput,
  type ReplayStepAfterInput,
  type ReplayStepBeforeInput,
} from "./schemas.js";
import type { PromoteMemoryLearningControlReviewProvider } from "./learning-control-provider-types.js";
import { runPromoteMemoryLearningControlPreview } from "./learning-control-promote-memory-shared.js";
import { resolveTenantScope } from "./tenant.js";
import { summarizeToolResult } from "./tool-result-summary.js";
import { buildAionisUri } from "./uri.js";
import { applyReplayMemoryWrite } from "./replay-write.js";
import {
  clampInt,
  detectSensitiveCommand,
  evaluateExpectedSignature,
  evaluatePostcondition,
  evaluatePrecondition,
  executeReplayCommand,
  isAllowedReplayCommand,
  isSafeCommandReference,
  normalizeReplayExecutionBackend,
  normalizeReplaySensitiveReviewMode,
  sandboxResultToOutcome,
  type PreconditionResult,
  type ReplayExecutionBackend,
  type ReplaySensitiveReviewMode,
} from "./replay-execution-helpers.js";
import {
  asStringArray,
  isReplayCommandTool,
  mergeReplayUsage,
  parseStepArgv,
  type ReplayGuidedRepairStrategy,
} from "./replay-guided-repair.js";
import {
  dedupeReplayCompileSteps,
  enrichReplayCompileStepsWithQuality,
  enrichReplayCompileStepsWithVariables,
  evaluateReplayDeterministicGate,
  nextActionForReplayDeterministicGate,
  type ReplayDeterministicGateEvaluation,
  type ReplayDeterministicGateResolved,
} from "./replay-compile-helpers.js";
import {
  applyPlaybookRepairPatch,
  buildCommitUri,
  evaluateAutoPromoteGate,
  extractShadowValidationGateMetrics,
  validatePlaybookShadowReadiness,
} from "./replay-repair-shadow-helpers.js";
import {
  buildReplayAutoPromotedSlots,
  buildReplayPlaybookUnchangedPromoteResult,
  buildReplayPlaybookProcedureWriteRequest,
  buildReplayPlaybookVersionResult,
  buildReplayPromotedSlots,
  buildReplayRepairedSlots,
  buildReplayReviewedSlots,
} from "./replay-promotion-review-helpers.js";
import {
  buildReplayExecutionSummary,
  buildReplayExecutionSurface,
  buildReplayRunPlaybookSurface,
  buildReplayRunSurface,
  buildReplaySimulateSummary,
} from "./replay-run-surfaces.js";
import { simulateReplaySteps } from "./replay-run-simulate.js";
import {
  buildReplayCompileResult,
  buildReplayCompileSlots,
  buildReplayCompileWriteRequest,
  buildReplayRunGetCounters,
  buildReplayRunGetRunSurface,
  buildReplayRunGetStepSurface,
  buildReplayTimelineEntry,
  collectReplayArtifactRefs,
} from "./replay-read-compile-surfaces.js";
import {
  buildReplayDispatchSurface,
  buildReplayPlaybookCandidateSurface,
  buildReplayPlaybookGetSurface,
} from "./replay-playbook-read-dispatch-surfaces.js";
import {
  applyReplayLearningControlPolicyEffect,
  buildReplayLearningControlDecisionTrace,
  deriveReplayLearningControlPolicyEffect,
  hasExplicitReplayLearningProjectionTargetRuleState,
  resolveReplayLearningProjectionConfig,
} from "./replay-learning-control-helpers.js";
import {
  buildReplayPlaybookWorkflowNodeFields,
  buildStablePlaybookNodeFields,
  ensureStablePlaybookAnchorOnLatestNode,
} from "./replay-stable-anchor-helpers.js";
import {
  buildReplayRunEndResult,
  buildReplayRunEndWriteRequest,
  buildReplayRunStartResult,
  buildReplayRunStartWriteRequest,
  buildReplayStepAfterResult,
  buildReplayStepAfterWriteRequest,
  buildReplayStepBeforeResult,
  buildReplayStepBeforeWriteRequest,
  runClientId,
  runEndClientId,
  stepClientId,
  stepResultClientId,
} from "./replay-run-write-surfaces.js";
import {
  buildReplayPlaybookRunEndBody,
  buildReplayPlaybookRunStartBody,
} from "./replay-run-lifecycle.js";
import {
  resolveReplayCommandAllowlistGate,
  resolveReplayConfirmationGate,
  resolveReplayPreconditionGate,
  resolveReplaySensitiveCommandGate,
  resolveReplayUnsupportedToolGate,
} from "./replay-run-gates.js";
import {
  isReplayExecutionPassed,
  resolveReplayExecutionFailureReason,
} from "./replay-run-results.js";
import {
  applyReplayRunStepDelta,
  handleReplayGuidedFailureStep,
  handleReplayGuidedGateStep,
  handleReplayPendingStep,
  handleReplayStrictFailureStep,
  handleReplayStrictGateStep,
  handleReplaySuccessStep,
  type ReplayRunCounters,
} from "./replay-run-step-flow.js";

type ReplayWriteOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
  embedder: EmbeddingProvider | null;
  replayAccess?: ReplayStoreAccess | null;
  replayMirror?: import("./replay-write.js").ReplayWriteMirror | null;
  writeAccess?: WriteStoreAccess | null;
};

type ReplayReadOptions = {
  defaultScope: string;
  defaultTenantId: string;
  replayAccess?: ReplayStoreAccess | null;
};

type ReplayLocalExecutorOptions = {
  enabled: boolean;
  mode: "disabled" | "local_process";
  allowedCommands: Set<string>;
  workdir: string;
  timeoutMs: number;
  stdioMaxBytes: number;
};

type ReplayGuidedRepairOptions = {
  strategy: ReplayGuidedRepairStrategy;
  maxErrorChars: number;
};

type ReplayShadowValidationPolicyOptions = {
  executeTimeoutMs: number;
  executeStopOnFailure: boolean;
  sandboxTimeoutMs: number;
  sandboxStopOnFailure: boolean;
};

type ReplayPlaybookRunOptions = ReplayReadOptions & {
  writeOptions?: ReplayWriteOptions;
  localExecutor?: ReplayLocalExecutorOptions;
  guidedRepair?: ReplayGuidedRepairOptions;
  sandboxExecutor?: (input: {
    tenant_id: string;
    scope: string;
    project_id: string | null;
    argv: string[];
    timeout_ms: number;
    mode: "sync" | "async";
    metadata?: Record<string, unknown>;
  }) => Promise<{
    ok: boolean;
    status: string;
    stdout: string;
    stderr: string;
    exit_code: number | null;
    error: string | null;
    run_id?: string | null;
  }>;
  sandboxBudgetGuard?: (input: {
    tenant_id: string;
    scope: string;
    project_id: string | null;
  }) => Promise<void>;
};

type ReplayPlaybookReviewOptions = ReplayWriteOptions & {
  localExecutor?: ReplayLocalExecutorOptions;
  shadowValidationPolicy?: ReplayShadowValidationPolicyOptions;
  learningProjectionDefaults?: ReplayLearningProjectionResolvedConfig;
  learningControlReviewProviders?: {
    promote_memory?: PromoteMemoryLearningControlReviewProvider | null;
  };
  sandboxValidationExecutor?: (input: {
    tenant_id: string;
    scope: string;
    argv: string[];
    timeout_ms: number;
    mode?: "sync" | "async";
    metadata?: Record<string, unknown>;
  }) => Promise<{
    ok: boolean;
    status: string;
    stdout: string;
    stderr: string;
    exit_code: number | null;
    error: string | null;
    run_id?: string | null;
  }>;
};

function playbookClientId(playbookId: string, version: number): string {
  return `replay:playbook:${playbookId}:v${version}`;
}

function replayWriteNodeId(scopeKey: string, clientId: string): string {
  return stableUuid(`${scopeKey}:node:${clientId.trim()}`);
}

function parseRunStartInput(body: unknown): ReplayRunStartInput {
  return ReplayRunStartRequest.parse(body);
}

function parseStepBeforeInput(body: unknown): ReplayStepBeforeInput {
  return ReplayStepBeforeRequest.parse(body);
}

function parseStepAfterInput(body: unknown): ReplayStepAfterInput {
  return ReplayStepAfterRequest.parse(body);
}

function parseRunEndInput(body: unknown): ReplayRunEndInput {
  return ReplayRunEndRequest.parse(body);
}

function parseRunGetInput(body: unknown): ReplayRunGetInput {
  return ReplayRunGetRequest.parse(body);
}

function parsePlaybookCompileInput(body: unknown): ReplayPlaybookCompileInput {
  return ReplayPlaybookCompileRequest.parse(body);
}

function parsePlaybookGetInput(body: unknown): ReplayPlaybookGetInput {
  return ReplayPlaybookGetRequest.parse(body);
}

function parsePlaybookCandidateInput(body: unknown): ReplayPlaybookCandidateInput {
  return ReplayPlaybookCandidateRequest.parse(body);
}

function parsePlaybookDispatchInput(body: unknown): ReplayPlaybookDispatchInput {
  return ReplayPlaybookDispatchRequest.parse(body);
}

function parsePlaybookPromoteInput(body: unknown): ReplayPlaybookPromoteInput {
  return ReplayPlaybookPromoteRequest.parse(body);
}

function parsePlaybookRunInput(body: unknown): ReplayPlaybookRunInput {
  return ReplayPlaybookRunRequest.parse(body);
}

function parsePlaybookRepairInput(body: unknown): ReplayPlaybookRepairInput {
  return ReplayPlaybookRepairRequest.parse(body);
}

function parsePlaybookRepairReviewInput(body: unknown): ReplayPlaybookRepairReviewInput {
  return ReplayPlaybookRepairReviewRequest.parse(body);
}

type ReplayWriteIdentity = {
  memory_lane?: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
};

function replayVisibilityFromInput(input: {
  consumer_agent_id?: string | null;
  consumer_team_id?: string | null;
}): ReplayVisibilityArgs {
  return {
    consumerAgentId: toStringOrNull(input.consumer_agent_id) ?? null,
    consumerTeamId: toStringOrNull(input.consumer_team_id) ?? null,
  };
}

function replayWriteIdentityFromInput(
  input: {
    memory_lane?: string | null;
    producer_agent_id?: string | null;
    owner_agent_id?: string | null;
    owner_team_id?: string | null;
  },
  baseIdentity?: ReplayWriteIdentity,
): ReplayWriteIdentity {
  const memoryLane = toStringOrNull(input.memory_lane);
  const producerAgentId = toStringOrNull(input.producer_agent_id);
  const ownerAgentId = toStringOrNull(input.owner_agent_id);
  const ownerTeamId = toStringOrNull(input.owner_team_id);
  return {
    memory_lane: memoryLane === "shared" || memoryLane === "private" ? memoryLane : baseIdentity?.memory_lane,
    producer_agent_id: producerAgentId ?? baseIdentity?.producer_agent_id,
    owner_agent_id: ownerAgentId ?? baseIdentity?.owner_agent_id,
    owner_team_id: ownerTeamId ?? baseIdentity?.owner_team_id,
  };
}

function replayWriteIdentityFromRow(row: ReplayNodeRow): ReplayWriteIdentity {
  return {
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id ?? undefined,
    owner_agent_id: row.owner_agent_id ?? undefined,
    owner_team_id: row.owner_team_id ?? undefined,
  };
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function estimateTokenCountFromUnknown(v: unknown): number {
  let text = "";
  try {
    text = JSON.stringify(v ?? {});
  } catch {
    text = String(v ?? "");
  }
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function stringListFromUnknown(value: unknown, limit = 64): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueNonEmptyStrings(
    value.map((entry) => (typeof entry === "string" ? entry : null)),
    limit,
  );
}

function firstStringField(...values: unknown[]): string | null {
  for (const value of values) {
    const next = toStringOrNull(value);
    if (next) return next;
  }
  return null;
}

function commandFromToolInput(input: unknown): string | null {
  if (typeof input === "string") return toStringOrNull(input);
  const obj = asObject(input);
  if (!obj) return null;
  const explicit = firstStringField(obj.command, obj.cmd, obj.script);
  if (explicit) return explicit;
  if (Array.isArray(obj.argv)) {
    const argv = obj.argv
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (argv.length > 0) return argv.join(" ");
  }
  return null;
}

function isValidationCommand(command: string): boolean {
  return /\b(test|lint|typecheck|tsc|pytest|vitest|jest|tap|mocha|cargo test|go test)\b/i.test(command);
}

function artifactRefToPath(ref: string): string | null {
  const workspaceMatch = /^workspace:\/\/[^/]+\/(.+)$/i.exec(ref);
  if (workspaceMatch?.[1]) return workspaceMatch[1].replace(/^\/+/, "");
  const fileMatch = /^file:\/\/(.+)$/i.exec(ref);
  if (fileMatch?.[1]) return fileMatch[1].replace(/^\/+/, "");
  return null;
}

function collectPathHintsFromRecord(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  return uniqueNonEmptyStrings([
    toStringOrNull(record.file_path),
    toStringOrNull(record.path),
    toStringOrNull(record.file),
    toStringOrNull(record.target_file),
    ...stringListFromUnknown(record.target_files, 24),
    ...stringListFromUnknown(record.touched_files, 24),
    ...stringListFromUnknown(record.files, 24),
  ], 48);
}

function buildObservedOutputPostcondition(outputSignature: unknown): Record<string, unknown> | null {
  if (outputSignature == null) return null;
  if (typeof outputSignature === "object" && !Array.isArray(outputSignature) && Object.keys(outputSignature).length === 0) {
    return null;
  }
  return {
    kind: "observed_output_signature",
    signature: outputSignature,
  };
}

function collectReplayCompileExecutionContractHints(args: {
  playbookId: string;
  matchers: Record<string, unknown>;
  successCriteria: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stepsTemplate: Array<Record<string, unknown>>;
  stepRows: ReplayNodeRow[];
  resultByStepId: Map<string, ReplayNodeRow>;
}): Record<string, unknown> {
  const targetFiles: string[] = [];
  const acceptanceChecks: string[] = [];
  const environmentAssumptions: string[] = [];
  const dependencyRequirements: string[] = [];
  const patternHints: string[] = [];

  targetFiles.push(
    ...collectPathHintsFromRecord(args.metadata),
    ...collectPathHintsFromRecord(args.successCriteria),
  );
  acceptanceChecks.push(
    ...stringListFromUnknown(args.metadata.acceptance_checks, 24),
    ...stringListFromUnknown(args.successCriteria.acceptance_checks, 24),
  );
  const metadataVerifier = firstStringField(args.metadata.verifier_command, args.metadata.verifier);
  const successVerifier = firstStringField(args.successCriteria.verifier_command, args.successCriteria.verifier);
  if (metadataVerifier) acceptanceChecks.push(metadataVerifier);
  if (successVerifier) acceptanceChecks.push(successVerifier);
  environmentAssumptions.push(...stringListFromUnknown(args.metadata.environment_assumptions, 24));
  dependencyRequirements.push(...stringListFromUnknown(args.metadata.dependency_requirements, 24));
  patternHints.push(...stringListFromUnknown(args.metadata.pattern_hints, 24));

  for (const row of args.stepRows) {
    const slotsObj = asObject(row.slots) ?? {};
    const stepId = toStringOrNull(slotsObj.step_id) ?? row.id;
    const result = args.resultByStepId.get(stepId);
    const resultSlots = asObject(result?.slots) ?? {};
    const stepMetadata = asObject(slotsObj.metadata);
    const resultMetadata = asObject(resultSlots.metadata);
    targetFiles.push(
      ...collectPathHintsFromRecord(stepMetadata),
      ...collectPathHintsFromRecord(resultMetadata),
      ...stringListFromUnknown(resultSlots.artifact_refs, 24)
        .map((ref) => artifactRefToPath(ref))
        .filter((value): value is string => !!value),
    );
    const command = commandFromToolInput(slotsObj.tool_input);
    if (command && isValidationCommand(command)) acceptanceChecks.push(command);
  }

  const workflowSteps = uniqueNonEmptyStrings(
    args.stepsTemplate.map((step) => {
      const stepIndex = Number(step.step_index ?? 0) || null;
      const toolName = toStringOrNull(step.tool_name);
      if (!toolName) return null;
      return stepIndex != null ? `step_${stepIndex}:${toolName}` : toolName;
    }),
    24,
  );
  const firstTool = toStringOrNull(args.stepsTemplate[0]?.tool_name);
  const taskFamily = firstStringField(args.metadata.task_family, args.successCriteria.task_family, args.matchers.task_family);
  const nextAction = firstStringField(
    args.metadata.next_action,
    args.successCriteria.next_action,
    firstTool ? `Start from replay step 1 with ${firstTool}.` : null,
  );
  const contractTrust = firstStringField(args.metadata.contract_trust) ?? "advisory";

  return {
    contract_trust: contractTrust,
    ...(taskFamily ? { task_family: taskFamily } : {}),
    task_signature: firstStringField(args.metadata.task_signature, args.matchers.task_signature)
      ?? `replay_playbook:${args.playbookId}`,
    ...(firstTool ? { selected_tool: firstTool } : {}),
    target_files: uniqueNonEmptyStrings(targetFiles, 24),
    acceptance_checks: uniqueNonEmptyStrings(acceptanceChecks, 24),
    ...(dependencyRequirements.length > 0
      ? { dependency_requirements: uniqueNonEmptyStrings(dependencyRequirements, 24) }
      : {}),
    ...(environmentAssumptions.length > 0
      ? { environment_assumptions: uniqueNonEmptyStrings(environmentAssumptions, 24) }
      : {}),
    ...(nextAction ? { next_action: nextAction } : {}),
    workflow_steps: workflowSteps,
    ...(patternHints.length > 0 ? { pattern_hints: uniqueNonEmptyStrings(patternHints, 24) } : {}),
  };
}

function replayKindOf(row: ReplayNodeRow): string {
  const slotsObj = asObject(row.slots);
  const kind = slotsObj ? toStringOrNull(slotsObj.replay_kind) : null;
  return kind ?? "";
}

function requireReplayReadAccess(opts: ReplayReadOptions | ReplayWriteOptions) {
}

function requireReplayAccess(opts?: ReplayReadOptions | ReplayWriteOptions): ReplayStoreAccess {
  const replayAccess = opts?.replayAccess ?? null;
  if (!replayAccess) {
    throw new Error("replay access is required");
  }
  return replayAccess;
}

const UUID_V4_OR_VX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function asLiteReplayWriteStore(writeAccess?: WriteStoreAccess | null): LiteWriteStore | null {
  if (
    !writeAccess
    || typeof (writeAccess as LiteWriteStore).withTx !== "function"
    || typeof (writeAccess as LiteWriteStore).findNodes !== "function"
  ) {
    return null;
  }
  return writeAccess as LiteWriteStore;
}

export async function replayRunStart(body: unknown, opts: ReplayWriteOptions) {
  const parsed = parseRunStartInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const writeIdentity = replayWriteIdentityFromInput(parsed);
  const runId = parsed.run_id ?? randomUUID();
  const cid = runClientId(runId);
  const nowIso = new Date().toISOString();
  const writeReq = buildReplayRunStartWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_api",
    goal: parsed.goal,
    runId,
    nowIso,
    writeIdentity: writeIdentity as Record<string, unknown>,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
    contextSnapshotRef: parsed.context_snapshot_ref ?? null,
    contextSnapshotHash: parsed.context_snapshot_hash ?? null,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const node = out.nodes.find((n) => n.client_id === cid) ?? out.nodes[0] ?? null;
  return buildReplayRunStartResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    runId,
    runNodeId: node?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayStepBefore(body: unknown, opts: ReplayWriteOptions) {
  const parsed = parseStepBeforeInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const writeIdentity = replayWriteIdentityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const runNode = await replayAccess.findRunNodeByRunId(tenancy.scope_key, parsed.run_id, visibility);
  if (!runNode) {
    throw new HttpError(404, "replay_run_not_found", "run_id was not found in this scope", {
      run_id: parsed.run_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  const stepId = parsed.step_id ?? randomUUID();
  const stepCid = stepClientId(parsed.run_id, stepId);
  const writeReq = buildReplayStepBeforeWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_api",
    runId: parsed.run_id,
    stepId,
    stepIndex: parsed.step_index,
    decisionId: parsed.decision_id ?? null,
    toolName: parsed.tool_name,
    toolInput: parsed.tool_input,
    expectedOutputSignature: parsed.expected_output_signature ?? null,
    preconditions: parsed.preconditions,
    retryPolicy: parsed.retry_policy ?? null,
    safetyLevel: parsed.safety_level,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
    runNodeId: runNode.id,
    writeIdentity: writeIdentity as Record<string, unknown>,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const stepNode = out.nodes.find((n) => n.client_id === stepCid) ?? out.nodes[0] ?? null;
  return buildReplayStepBeforeResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    runId: parsed.run_id,
    stepId,
    stepIndex: parsed.step_index,
    stepNodeId: stepNode?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayStepAfter(body: unknown, opts: ReplayWriteOptions) {
  const parsed = parseStepAfterInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const writeIdentity = replayWriteIdentityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const runNode = await replayAccess.findRunNodeByRunId(tenancy.scope_key, parsed.run_id, visibility);
  if (!runNode) {
    throw new HttpError(404, "replay_run_not_found", "run_id was not found in this scope", {
      run_id: parsed.run_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  let stepNode: ReplayNodeRow | null = null;
  let resolvedStepId = parsed.step_id ?? null;
  if (resolvedStepId) {
    stepNode = await replayAccess.findStepNodeById(tenancy.scope_key, resolvedStepId, visibility);
  } else if (parsed.step_index != null) {
    stepNode = await replayAccess.findLatestStepNodeByIndex(tenancy.scope_key, parsed.run_id, parsed.step_index, visibility);
    resolvedStepId =
      toStringOrNull(asObject(stepNode?.slots)?.step_id)
      ?? (stepNode?.id ?? null);
  }
  if (!stepNode && !resolvedStepId) {
    throw new HttpError(
      400,
      "replay_step_reference_required",
      "step_id or step_index is required to record step outcome",
      { run_id: parsed.run_id },
    );
  }
  const resultCid = stepResultClientId(parsed.run_id, resolvedStepId, parsed.status);
  const writeReq = buildReplayStepAfterWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_api",
    runId: parsed.run_id,
    stepId: resolvedStepId,
    stepIndex: parsed.step_index ?? null,
    status: parsed.status,
    outputSignature: parsed.output_signature ?? null,
    postconditions: parsed.postconditions,
    artifactRefs: parsed.artifact_refs,
    repairApplied: parsed.repair_applied,
    repairNote: parsed.repair_note ?? null,
    error: parsed.error ?? null,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
    runNodeId: runNode.id,
    stepNodeId: stepNode?.id ?? null,
    writeIdentity: writeIdentity as Record<string, unknown>,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const resultNode = out.nodes.find((n) => n.client_id === resultCid) ?? out.nodes[0] ?? null;
  return buildReplayStepAfterResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    runId: parsed.run_id,
    stepId: resolvedStepId,
    status: parsed.status,
    repairApplied: parsed.repair_applied,
    resultNodeId: resultNode?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayRunEnd(body: unknown, opts: ReplayWriteOptions) {
  const parsed = parseRunEndInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const writeIdentity = replayWriteIdentityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const runNode = await replayAccess.findRunNodeByRunId(tenancy.scope_key, parsed.run_id, visibility);
  if (!runNode) {
    throw new HttpError(404, "replay_run_not_found", "run_id was not found in this scope", {
      run_id: parsed.run_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  const endCid = runEndClientId(parsed.run_id);
  const writeReq = buildReplayRunEndWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_api",
    runId: parsed.run_id,
    status: parsed.status,
    summary: parsed.summary ?? null,
    successCriteria: (parsed.success_criteria ?? {}) as Record<string, unknown>,
    metrics: (parsed.metrics ?? {}) as Record<string, unknown>,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
    endedAt: new Date().toISOString(),
    runNodeId: runNode.id,
    writeIdentity: writeIdentity as Record<string, unknown>,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const endNode = out.nodes.find((n) => n.client_id === endCid) ?? out.nodes[0] ?? null;
  return buildReplayRunEndResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    runId: parsed.run_id,
    status: parsed.status,
    endNodeId: endNode?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayRunGet(body: unknown, opts: ReplayReadOptions) {
  requireReplayReadAccess(opts);
  const parsed = parseRunGetInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const rows = await replayAccess.listReplayNodesByRunId(tenancy.scope_key, parsed.run_id, visibility);
  if (rows.length === 0) {
    throw new HttpError(404, "replay_run_not_found", "run_id was not found in this scope", {
      run_id: parsed.run_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }

  const runNode = rows.find((r) => replayKindOf(r) === "run") ?? null;
  const runEndRows = rows.filter((r) => replayKindOf(r) === "run_end");
  const lastRunEnd = runEndRows.length > 0 ? runEndRows[runEndRows.length - 1] : null;
  const stepRows = rows.filter((r) => replayKindOf(r) === "step");
  const stepResultRows = rows.filter((r) => replayKindOf(r) === "step_result");
  const resultByStepId = new Map<string, ReplayNodeRow>();
  for (const row of stepResultRows) {
    const sid = toStringOrNull(asObject(row.slots)?.step_id);
    if (!sid) continue;
    resultByStepId.set(sid, row);
  }
  const timeline = rows.map((row) =>
    buildReplayTimelineEntry({
      tenantId: tenancy.tenant_id,
      scope: tenancy.scope,
      row,
      replayKind: replayKindOf(row),
      commitUri: row.commit_id != null ? buildCommitUri(tenancy.tenant_id, tenancy.scope, row.commit_id) : null,
    }),
  );

  const artifacts = collectReplayArtifactRefs(stepResultRows, parsed.include_artifacts);

  const runStatus = toStringOrNull(asObject(lastRunEnd?.slots)?.status) ?? "in_progress";
  const runGoal = toStringOrNull(asObject(runNode?.slots)?.goal);

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    run: buildReplayRunGetRunSurface({
      tenantId: tenancy.tenant_id,
      scope: tenancy.scope,
      runId: parsed.run_id,
      runNode,
      lastRunEnd,
      runStatus,
      runGoal,
    }),
    steps: parsed.include_steps
      ? stepRows.map((row) => {
          const slotsObj = asObject(row.slots);
          const sid = toStringOrNull(slotsObj?.step_id) ?? row.id;
          return buildReplayRunGetStepSurface({
            tenantId: tenancy.tenant_id,
            scope: tenancy.scope,
            row,
            result: resultByStepId.get(sid) ?? null,
          });
        })
      : [],
    artifacts: parsed.include_artifacts ? artifacts : [],
    timeline,
    counters: buildReplayRunGetCounters({
      totalNodes: rows.length,
      stepNodes: stepRows.length,
      stepResultNodes: stepResultRows.length,
      artifactRefs: artifacts.length,
    }),
  };
}

export async function replayPlaybookCompileFromRun(body: unknown, opts: ReplayWriteOptions) {
  const parsed = parsePlaybookCompileInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  requireReplayReadAccess(opts);
  const replayAccess = requireReplayAccess(opts);
  const rows = await replayAccess.listReplayNodesByRunId(tenancy.scope_key, parsed.run_id, visibility);
  if (rows.length === 0) {
    throw new HttpError(404, "replay_run_not_found", "run_id was not found in this scope", {
      run_id: parsed.run_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  const runNode = rows.find((r) => replayKindOf(r) === "run") ?? null;
  const runEndRows = rows.filter((r) => replayKindOf(r) === "run_end");
  const lastRunEnd = runEndRows.length > 0 ? runEndRows[runEndRows.length - 1] : null;
  const runStatus = toStringOrNull(asObject(lastRunEnd?.slots)?.status);
  if (!parsed.allow_partial && runStatus !== "success") {
    throw new HttpError(
      400,
      "replay_compile_requires_successful_run",
      "compile_from_run requires run_end status=success unless allow_partial=true",
      {
        run_id: parsed.run_id,
        run_status: runStatus ?? "in_progress",
      },
    );
  }

  const stepRows = rows
    .filter((r) => replayKindOf(r) === "step")
    .sort((a, b) => {
      const aIdx = Number(asObject(a.slots)?.step_index ?? 0);
      const bIdx = Number(asObject(b.slots)?.step_index ?? 0);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.created_at.localeCompare(b.created_at);
    });
  if (stepRows.length === 0) {
    throw new HttpError(400, "replay_compile_no_steps", "run does not contain replay step nodes", {
      run_id: parsed.run_id,
    });
  }
  const resultByStepId = new Map<string, ReplayNodeRow>();
  for (const row of rows.filter((r) => replayKindOf(r) === "step_result")) {
    const sid = toStringOrNull(asObject(row.slots)?.step_id);
    if (!sid) continue;
    resultByStepId.set(sid, row);
  }

  const rawStepsTemplate = stepRows.map((row) => {
    const slotsObj = asObject(row.slots) ?? {};
    const stepId = toStringOrNull(slotsObj.step_id) ?? row.id;
    const result = resultByStepId.get(stepId);
    const resultSlots = asObject(result?.slots) ?? {};
    const observedOutputSignature = resultSlots.output_signature ?? null;
    const existingPostconditions = Array.isArray(resultSlots.postconditions) ? resultSlots.postconditions : [];
    const outputPostcondition = buildObservedOutputPostcondition(observedOutputSignature);
    return {
      step_index: Number(slotsObj.step_index ?? 0),
      tool_name: toStringOrNull(slotsObj.tool_name),
      tool_input_template: slotsObj.tool_input ?? {},
      expected_output_signature: slotsObj.expected_output_signature ?? observedOutputSignature,
      preconditions: Array.isArray(slotsObj.preconditions) ? slotsObj.preconditions : [],
      postconditions: outputPostcondition ? [...existingPostconditions, outputPostcondition] : existingPostconditions,
      retry_policy: asObject(slotsObj.retry_policy) ?? null,
      safety_level: toStringOrNull(slotsObj.safety_level) ?? "needs_confirm",
      replay_mode: "replay_first_reason_if_needed",
      last_outcome: toStringOrNull(resultSlots.status) ?? "pending",
      repair_applied_last_run: Boolean(resultSlots.repair_applied ?? false),
    };
  });
  const dedupe = dedupeReplayCompileSteps(rawStepsTemplate);
  const withVariables = enrichReplayCompileStepsWithVariables(dedupe.steps);
  const withQuality = enrichReplayCompileStepsWithQuality(withVariables.steps);
  const stepsTemplate = withQuality.steps;

  const playbookId = parsed.playbook_id ?? randomUUID();
  const version = parsed.version;
  const playbookName = parsed.name?.trim() || `replay_playbook_${parsed.run_id.slice(0, 8)}`;
  const runEndSlots = asObject(lastRunEnd?.slots);
  const successCriteria =
    parsed.success_criteria
    ?? (asObject(runEndSlots?.success_criteria) ?? {});
  const summaryBase = {
    source_run_id: parsed.run_id,
    source_run_status: runStatus ?? "in_progress",
    steps_total: stepsTemplate.length,
    source_steps_total: rawStepsTemplate.length,
    steps_dedup_removed: dedupe.removed_count,
    dedup_removed_step_indexes: dedupe.removed_step_indexes,
    steps_with_last_repair: stepsTemplate.filter((s) => s.repair_applied_last_run).length,
    parameterization: withVariables.summary,
    quality: withQuality.summary,
    recommendations: Array.from(
      new Set([
        ...withQuality.summary.recommendations,
        ...(dedupe.removed_count > 0
          ? ["review duplicate removal in compiled playbook; add explicit step markers when repeated actions are required"]
          : []),
      ]),
    ),
    generated_at: new Date().toISOString(),
  };
  const usage = {
    prompt_tokens: estimateTokenCountFromUnknown({
      run_id: parsed.run_id,
      run_status: runStatus ?? "in_progress",
      allow_partial: parsed.allow_partial,
      source_steps_total: rawStepsTemplate.length,
      source_steps: rawStepsTemplate,
      matchers: parsed.matchers ?? {},
      success_criteria: successCriteria,
      risk_profile: parsed.risk_profile,
      metadata: parsed.metadata ?? {},
    }),
    completion_tokens: estimateTokenCountFromUnknown({
      playbook_id: playbookId,
      playbook_name: playbookName,
      version,
      status: "draft",
      steps_template: stepsTemplate,
      compile_summary: summaryBase,
    }),
    source: "estimated_char_based_v1" as const,
  };
  const usageOut = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.prompt_tokens + usage.completion_tokens,
    source: usage.source,
  };
  const summary = {
    ...summaryBase,
    usage_estimate: usageOut,
  };
  const playbookCid = playbookClientId(playbookId, version);
  const writeIdentity = replayWriteIdentityFromInput(parsed, runNode ? replayWriteIdentityFromRow(runNode) : undefined);
  const matchers = (parsed.matchers ?? {}) as Record<string, unknown>;
  const metadata = (parsed.metadata ?? {}) as Record<string, unknown>;
  const executionContractHints = collectReplayCompileExecutionContractHints({
    playbookId,
    matchers,
    successCriteria: successCriteria as Record<string, unknown>,
    metadata,
    stepsTemplate,
    stepRows,
    resultByStepId,
  });
  const baseSlots = buildReplayCompileSlots({
    playbookId,
    playbookName,
    version,
    matchers,
    successCriteria: successCriteria as Record<string, unknown>,
    riskProfile: parsed.risk_profile,
    sourceRunId: parsed.run_id,
    stepsTemplate,
    summary,
    metadata,
    executionContractHints,
  });
  const workflowFields = await buildReplayPlaybookWorkflowNodeFields({
    embedder: null,
    scopeKey: tenancy.scope_key,
    playbookId,
    version,
    status: "draft",
    promotionOrigin: "replay_compile_from_run",
    requiredObservations: 2,
    observedCount: 1,
    title: playbookName,
    textSummary: `Replay playbook compiled from run ${parsed.run_id}`,
    clientId: playbookCid,
    commitId: null,
    sourceNodeId: null,
    sourceCommitId: null,
    slots: baseSlots,
  });

  const writeReq = buildReplayCompileWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_compiler",
    inputText: `compile playbook ${playbookName}`,
    writeIdentity: writeIdentity as unknown as Record<string, unknown>,
    playbookCid,
    playbookName,
    textSummary: `Replay playbook compiled from run ${parsed.run_id}`,
    slots: workflowFields.slots,
    runNode,
    stepRows,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const playbookNode = out.nodes.find((n) => n.client_id === playbookCid) ?? out.nodes[0] ?? null;
  return buildReplayCompileResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    playbookId,
    version,
    sourceRunId: parsed.run_id,
    playbookNodeId: playbookNode?.id ?? null,
    summary,
    usage: usageOut,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayPlaybookGet(body: unknown, opts: ReplayReadOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookGetInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const versions = await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility);
  const row = versions[0] ?? null;
  if (!row) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook_id was not found in this scope", {
      playbook_id: parsed.playbook_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    playbook: buildReplayPlaybookGetSurface({
      tenantId: tenancy.tenant_id,
      scope: tenancy.scope,
      playbookId: parsed.playbook_id,
      row,
      commitUri: row.commit_id != null ? buildCommitUri(tenancy.tenant_id, tenancy.scope, row.commit_id) : null,
    }),
  };
}

export async function replayPlaybookCandidate(body: unknown, opts: ReplayReadOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookCandidateInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const row =
    parsed.version != null
      ? await replayAccess.getReplayPlaybookVersion(tenancy.scope_key, parsed.playbook_id, parsed.version, visibility)
      : (await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility))[0] ?? null;
  if (!row) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook was not found in this scope", {
      playbook_id: parsed.playbook_id,
      version: parsed.version ?? null,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  const slotsObj = asObject(row.slots) ?? {};
  const deterministicGate = evaluateReplayDeterministicGate({
    requestedMode: "simulate",
    gateInput: parsed.deterministic_gate,
    playbookStatus: row.playbook_status,
    playbookSlots: slotsObj,
  });
  return buildReplayPlaybookCandidateSurface({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    playbookId: parsed.playbook_id,
    row,
    deterministicGate: deterministicGate as unknown as Record<string, unknown>,
    nextAction: nextActionForReplayDeterministicGate(deterministicGate),
  });
}

export async function replayPlaybookDispatch(body: unknown, opts: ReplayPlaybookRunOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookDispatchInput(body);
  const candidate = await replayPlaybookCandidate(
    {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      playbook_id: parsed.playbook_id,
      version: parsed.version,
      deterministic_gate: parsed.deterministic_gate,
    },
    opts,
  );
  const eligible = Boolean((candidate as any).candidate?.eligible_for_deterministic_replay);
  if (eligible) {
    const replay = await replayPlaybookRun(
      {
        tenant_id: parsed.tenant_id,
        scope: parsed.scope,
        project_id: parsed.project_id,
        actor: parsed.actor,
        consumer_agent_id: parsed.consumer_agent_id,
        consumer_team_id: parsed.consumer_team_id,
        memory_lane: parsed.memory_lane,
        producer_agent_id: parsed.producer_agent_id,
        owner_agent_id: parsed.owner_agent_id,
        owner_team_id: parsed.owner_team_id,
        playbook_id: parsed.playbook_id,
        version: parsed.version,
        mode: "simulate",
        deterministic_gate: parsed.deterministic_gate,
        params: parsed.params,
        max_steps: parsed.max_steps,
      },
      opts,
    );
    return buildReplayDispatchSurface({
      tenantId: (candidate as any).tenant_id,
      scope: (candidate as any).scope,
      decision: "deterministic_replay_executed",
      primaryInferenceSkipped: true,
      candidate,
      replay,
      deterministicGate: ((replay as any)?.deterministic_gate ?? null) as Record<string, unknown> | null,
    });
  }
  return buildReplayDispatchSurface({
    tenantId: (candidate as any).tenant_id,
    scope: (candidate as any).scope,
    decision: "candidate_only",
    primaryInferenceSkipped: false,
    candidate,
    replay: null,
    deterministicGate: ((candidate as any)?.deterministic_gate ?? null) as Record<string, unknown> | null,
  });
}

export async function replayPlaybookPromote(body: unknown, opts: ReplayWriteOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookPromoteInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const versions = await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility);
  const latest = versions[0] ?? null;
  if (!latest) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook_id was not found in this scope", {
      playbook_id: parsed.playbook_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }
  let source = latest;
  if (parsed.from_version != null) {
    const byVersion = await replayAccess.getReplayPlaybookVersion(
      tenancy.scope_key,
      parsed.playbook_id,
      parsed.from_version,
      visibility,
    );
    if (!byVersion) {
      throw new HttpError(404, "replay_playbook_version_not_found", "from_version was not found for this playbook", {
        playbook_id: parsed.playbook_id,
        from_version: parsed.from_version,
      });
    }
    source = byVersion;
  }

  const sourceSlots = asObject(source.slots) ?? {};
  const targetStatus = parsed.target_status;
  if ((source.playbook_status ?? "draft") === targetStatus && source === latest) {
    const normalizedStable = await ensureStablePlaybookAnchorOnLatestNode({
      embedder: opts.embedder,
      writeAccess: opts.writeAccess,
      replayMirror: opts.replayMirror,
      tenancy,
      visibility,
      playbookId: parsed.playbook_id,
      latest,
    });
    return buildReplayPlaybookUnchangedPromoteResult({
      tenantId: tenancy.tenant_id,
      scope: tenancy.scope,
      playbookId: parsed.playbook_id,
      fromVersion: source.version_num,
      toVersion: latest.version_num,
      status: (latest.playbook_status ?? "draft") as "draft" | "shadow" | "active" | "disabled",
      unchanged: !normalizedStable?.mutated,
      reason: normalizedStable?.mutated ? "normalized_latest_stable_anchor" : "already_target_status_on_latest",
      nodeId: normalizedStable?.node.id ?? source.id,
    });
  }

  const nextVersion = latest.version_num + 1;
  const promoteCid = playbookClientId(parsed.playbook_id, nextVersion);
  const writeIdentity = replayWriteIdentityFromInput(parsed, replayWriteIdentityFromRow(source));
  const promotedTitle = source.title ?? `replay_playbook_${parsed.playbook_id.slice(0, 8)}`;
  const promotedTextSummary = source.text_summary ?? `Replay playbook ${parsed.playbook_id}`;
  const promotedSlots = buildReplayPromotedSlots({
    sourceSlots,
    playbookId: parsed.playbook_id,
    version: nextVersion,
    status: targetStatus,
    sourceVersion: source.version_num,
    promotedAt: new Date().toISOString(),
    note: parsed.note ?? null,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
  });
  const promotedNodeFields = await buildStablePlaybookNodeFields({
    embedder: opts.embedder,
    scopeKey: tenancy.scope_key,
    playbookId: parsed.playbook_id,
    version: nextVersion,
    status: targetStatus,
    promotionOrigin: "replay_promote",
    title: promotedTitle,
    textSummary: promotedTextSummary,
    clientId: promoteCid,
    commitId: null,
    sourceNodeId: source.id,
    sourceCommitId: source.commit_id ?? null,
    slots: promotedSlots,
  });
  const writeReq = buildReplayPlaybookProcedureWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_promoter",
    inputText: `promote playbook ${parsed.playbook_id} to ${targetStatus}`,
    writeIdentity: writeIdentity as unknown as Record<string, unknown>,
    clientId: promoteCid,
    title: promotedTitle,
    textSummary: promotedTextSummary,
    slots: promotedNodeFields.slots,
    embedding: promotedNodeFields.embedding,
    embeddingModel: promotedNodeFields.embedding_model,
    sourceNodeId: source.id,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const promoted = out.nodes.find((n) => n.client_id === promoteCid) ?? out.nodes[0] ?? null;
  return buildReplayPlaybookVersionResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    playbookId: parsed.playbook_id,
    fromVersion: source.version_num,
    toVersion: nextVersion,
    status: targetStatus,
    nodeId: promoted?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
  });
}

export async function replayPlaybookRepair(body: unknown, opts: ReplayWriteOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookRepairInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const versions = await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility);
  const latest = versions[0] ?? null;
  if (!latest) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook_id was not found in this scope", {
      playbook_id: parsed.playbook_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }

  let source = latest;
  if (parsed.from_version != null) {
    const byVersion = await replayAccess.getReplayPlaybookVersion(
      tenancy.scope_key,
      parsed.playbook_id,
      parsed.from_version,
      visibility,
    );
    if (!byVersion) {
      throw new HttpError(404, "replay_playbook_version_not_found", "from_version was not found for this playbook", {
        playbook_id: parsed.playbook_id,
        from_version: parsed.from_version,
      });
    }
    source = byVersion;
  }

  const patchObj = asObject(parsed.patch) ?? {};
  const sourceSlots = asObject(source.slots) ?? {};
  const { nextSlots, summary } = applyPlaybookRepairPatch(sourceSlots, patchObj);
  const reviewRequired = parsed.review_required !== false;
  const emittedStatus = reviewRequired ? "draft" : parsed.target_status;
  const nextVersion = latest.version_num + 1;
  const repairCid = playbookClientId(parsed.playbook_id, nextVersion);
  const writeIdentity = replayWriteIdentityFromInput(parsed, replayWriteIdentityFromRow(source));

  const repairedSlots = buildReplayRepairedSlots({
    nextSlots,
    playbookId: parsed.playbook_id,
    version: nextVersion,
    status: emittedStatus,
    sourceVersion: source.version_num,
    repairedAt: new Date().toISOString(),
    note: parsed.note ?? null,
    patch: patchObj,
    summary,
    reviewRequired,
    actor: parsed.actor ?? "replay_repair",
    targetStatus: parsed.target_status,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
  });
  const writeReq = buildReplayPlaybookProcedureWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_repair",
    inputText: `repair playbook ${parsed.playbook_id} v${source.version_num}->v${nextVersion}`,
    writeIdentity: writeIdentity as unknown as Record<string, unknown>,
    clientId: repairCid,
    title: source.title ?? `replay_playbook_${parsed.playbook_id.slice(0, 8)}`,
    textSummary: source.text_summary ?? `Replay playbook ${parsed.playbook_id}`,
    slots: repairedSlots,
    sourceNodeId: source.id,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const repaired = out.nodes.find((n) => n.client_id === repairCid) ?? out.nodes[0] ?? null;
  return buildReplayPlaybookVersionResult({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    playbookId: parsed.playbook_id,
    fromVersion: source.version_num,
    toVersion: nextVersion,
    status: emittedStatus,
    nodeId: repaired?.id ?? null,
    commitId: out.commit_id,
    commitUri: out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id),
    commitHash: out.commit_hash,
    extra: {
      review_required: reviewRequired,
      review_state: reviewRequired ? "pending_review" : "approved",
      repair_summary: summary,
    },
  });
}

export async function replayPlaybookRepairReview(body: unknown, opts: ReplayPlaybookReviewOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookRepairReviewInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const versions = await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility);
  const latest = versions[0] ?? null;
  if (!latest) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook_id was not found in this scope", {
      playbook_id: parsed.playbook_id,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }

  const source =
    parsed.version != null
      ? await replayAccess.getReplayPlaybookVersion(tenancy.scope_key, parsed.playbook_id, parsed.version, visibility)
      : latest;
  if (!source) {
    throw new HttpError(404, "replay_playbook_version_not_found", "version was not found for this playbook", {
      playbook_id: parsed.playbook_id,
      version: parsed.version ?? null,
    });
  }

  const sourceSlots = asObject(source.slots) ?? {};
  const repairPatch = asObject(sourceSlots.repair_patch);
  if (!repairPatch) {
    throw new HttpError(
      400,
      "replay_repair_patch_missing",
      "review endpoint requires a repaired playbook version (repair_patch missing).",
      {
        playbook_id: parsed.playbook_id,
        version: source.version_num,
      },
    );
  }
  const sourceReview = asObject(sourceSlots.repair_review) ?? {};
  const sourceReviewState = toStringOrNull(sourceReview.state) ?? "pending_review";
  if (sourceReviewState !== "pending_review") {
    throw new HttpError(
      409,
      "replay_repair_not_pending_review",
      "playbook version is not in pending_review state",
      {
        playbook_id: parsed.playbook_id,
        version: source.version_num,
        review_state: sourceReviewState,
      },
    );
  }

  let shadowValidation: Record<string, unknown> | null = null;
  let nextStatus: "draft" | "shadow" | "active" | "disabled";
  let reviewState: string;
  if (parsed.action === "reject") {
    nextStatus = "draft";
    reviewState = "rejected";
  } else {
    let shadowPass = true;
    if (parsed.auto_shadow_validate) {
      const stepsRaw = Array.isArray(sourceSlots.steps_template) ? sourceSlots.steps_template : [];
      const validationMode = parsed.shadow_validation_mode;
      const shadowValidationPolicy = opts.shadowValidationPolicy ?? {
        executeTimeoutMs: opts.localExecutor?.timeoutMs ?? 15000,
        executeStopOnFailure: true,
        sandboxTimeoutMs: opts.localExecutor?.timeoutMs ?? 15000,
        sandboxStopOnFailure: true,
      };
      if (validationMode === "execute") {
        const paramsObj = asObject(parsed.shadow_validation_params) ?? {};
        const executeTimeoutMs = clampInt(
          Number(paramsObj.timeout_ms ?? shadowValidationPolicy.executeTimeoutMs),
          100,
          600000,
        );
        const executeStopOnFailure =
          paramsObj.stop_on_failure === undefined
            ? shadowValidationPolicy.executeStopOnFailure
            : paramsObj.stop_on_failure !== false;
        try {
          const runOut = await replayPlaybookRun(
            {
              tenant_id: tenancy.tenant_id,
              scope: tenancy.scope,
              playbook_id: parsed.playbook_id,
              version: source.version_num,
              mode: "strict",
              max_steps: parsed.shadow_validation_max_steps,
              params: {
                ...paramsObj,
                timeout_ms: executeTimeoutMs,
                allow_local_exec: true,
                record_run: false,
                auto_confirm: true,
                stop_on_failure: executeStopOnFailure,
              },
            },
            {
              defaultScope: opts.defaultScope,
              defaultTenantId: opts.defaultTenantId,
              writeOptions: opts,
              localExecutor: opts.localExecutor,
            },
          );
          const summaryObj = asObject((runOut as any).summary) ?? {};
          const failedSteps = Number(summaryObj.failed_steps ?? 0);
          shadowPass = Number.isFinite(failedSteps) && failedSteps === 0;
          const stepsOut = Array.isArray((runOut as any).steps) ? (runOut as any).steps.slice(0, 20) : [];
          shadowValidation = {
            mode: "execute",
            pass: shadowPass,
            validated_at: new Date().toISOString(),
            validator: "repair_review_auto_execute",
            timeout_ms: executeTimeoutMs,
            stop_on_failure: executeStopOnFailure,
            summary: summaryObj,
            steps_preview: stepsOut,
            max_steps: parsed.shadow_validation_max_steps,
          };
        } catch (err: any) {
          shadowPass = false;
          shadowValidation = {
            mode: "execute",
            pass: false,
            validated_at: new Date().toISOString(),
            validator: "repair_review_auto_execute",
            error: String(err?.message ?? err),
            timeout_ms: executeTimeoutMs,
            stop_on_failure: executeStopOnFailure,
            max_steps: parsed.shadow_validation_max_steps,
          };
        }
      } else if (validationMode === "execute_sandbox") {
        const paramsObj = asObject(parsed.shadow_validation_params) ?? {};
        const profileRaw = toStringOrNull(paramsObj.profile) ?? "balanced";
        const profile: "fast" | "balanced" | "thorough" =
          profileRaw === "fast" || profileRaw === "thorough" || profileRaw === "balanced" ? profileRaw : "balanced";
        const profileDefaults =
          profile === "fast"
            ? { timeoutMs: Math.min(shadowValidationPolicy.sandboxTimeoutMs, 6000), stopOnFailure: true }
            : profile === "thorough"
              ? { timeoutMs: Math.max(shadowValidationPolicy.sandboxTimeoutMs, 20000), stopOnFailure: false }
              : { timeoutMs: shadowValidationPolicy.sandboxTimeoutMs, stopOnFailure: shadowValidationPolicy.sandboxStopOnFailure };
        const executionModeRaw = toStringOrNull(paramsObj.execution_mode) ?? "sync";
        const sandboxExecMode: "sync" | "async" = executionModeRaw === "async_queue" ? "async" : "sync";
        const timeoutMs = clampInt(
          Number(paramsObj.timeout_ms ?? profileDefaults.timeoutMs),
          100,
          600000,
        );
        const stopOnFailure =
          paramsObj.stop_on_failure === undefined
            ? profileDefaults.stopOnFailure
            : paramsObj.stop_on_failure !== false;
        if (!opts.sandboxValidationExecutor) {
          shadowPass = false;
          shadowValidation = {
            mode: "execute_sandbox",
            pass: false,
            validated_at: new Date().toISOString(),
            validator: "repair_review_auto_execute_sandbox",
            error: "sandbox_validation_executor_not_configured",
          };
        } else {
          const checks: Array<Record<string, unknown>> = [];
          let succeededSteps = 0;
          let failedSteps = 0;
          let blockedSteps = 0;
          let unknownSteps = 0;
          let pendingSteps = 0;
          const stepsEval = stepsRaw.slice(0, parsed.shadow_validation_max_steps);
          for (const step of stepsEval) {
            const stepObj = asObject(step) ?? {};
            const stepIndex = Number(stepObj.step_index ?? 0) || null;
            const toolName = toStringOrNull(stepObj.tool_name);
            const preconditions = Array.isArray(stepObj.preconditions) ? stepObj.preconditions : [];
            const postconditions = Array.isArray(stepObj.postconditions) ? stepObj.postconditions : [];
            const expectedSignature = stepObj.expected_output_signature ?? null;
            const preChecks: PreconditionResult[] = [];
            for (const cond of preconditions) preChecks.push(await evaluatePrecondition(cond));
            const preFailed = preChecks.filter((c) => c.state === "fail");
            const preUnknown = preChecks.filter((c) => c.state === "unknown");
            if (preFailed.length > 0 || preUnknown.length > 0) {
              blockedSteps += 1;
              checks.push({
                step_index: stepIndex,
                tool_name: toolName,
                status: "blocked",
                reason: preFailed.length > 0 ? "preconditions_failed" : "preconditions_unknown",
                preconditions: preChecks,
              });
              if (stopOnFailure) break;
              continue;
            }
            if (!isReplayCommandTool(toolName)) {
              unknownSteps += 1;
              checks.push({
                step_index: stepIndex,
                tool_name: toolName,
                status: "unknown",
                reason: "unsupported_tool_for_sandbox_validation",
              });
              if (stopOnFailure) break;
              continue;
            }

            const argv = parseStepArgv(stepObj, toolName);
            const command = String(argv[0] ?? "").trim();
            if (argv.length === 0 || !command || !isSafeCommandReference(command)) {
              blockedSteps += 1;
              checks.push({
                step_index: stepIndex,
                tool_name: toolName,
                status: "blocked",
                reason: "invalid_command_argv",
                command,
                argv,
              });
              if (stopOnFailure) break;
              continue;
            }

            const startedAt = Date.now();
            let sandboxExec:
              | {
                  ok: boolean;
                  status: string;
                  stdout: string;
                  stderr: string;
                  exit_code: number | null;
                  error: string | null;
                  run_id?: string | null;
                }
              | null = null;
            try {
              sandboxExec = await opts.sandboxValidationExecutor({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                argv,
                timeout_ms: timeoutMs,
                mode: sandboxExecMode,
                metadata: {
                  source: "replay_shadow_validation",
                  playbook_id: parsed.playbook_id,
                  playbook_version: source.version_num,
                  step_index: stepIndex,
                  review_action: parsed.action,
                },
              });
            } catch (err: any) {
              sandboxExec = {
                ok: false,
                status: "failed",
                stdout: "",
                stderr: "",
                exit_code: null,
                error: String(err?.message ?? err),
                run_id: null,
              };
            }
            if (sandboxExecMode === "async" || sandboxExec.status === "queued" || sandboxExec.status === "running") {
              pendingSteps += 1;
              checks.push({
                step_index: stepIndex,
                tool_name: toolName,
                status: "pending",
                command,
                argv,
                sandbox_run_id: sandboxExec.run_id ?? null,
                sandbox_status: sandboxExec.status ?? "queued",
              });
              if (stopOnFailure) break;
              continue;
            }
            const outcome = sandboxResultToOutcome(sandboxExec, argv, Date.now() - startedAt);
            const signature = evaluateExpectedSignature(expectedSignature, outcome);
            const postChecks: PreconditionResult[] = [];
            for (const cond of postconditions) postChecks.push(await evaluatePostcondition(cond, outcome));
            const failedPost = postChecks.filter((c) => c.state === "fail");
            const unknownPost = postChecks.filter((c) => c.state === "unknown");
            const pass = outcome.ok && signature.ok && failedPost.length === 0 && unknownPost.length === 0;
            if (pass) {
              succeededSteps += 1;
            } else {
              failedSteps += 1;
            }
            checks.push({
              step_index: stepIndex,
              tool_name: toolName,
              status: pass ? "success" : "failed",
              command,
              argv,
              sandbox_run_id: sandboxExec.run_id ?? null,
              execution: outcome,
              signature,
              postconditions: postChecks,
            });
            if (!pass && stopOnFailure) break;
          }

          shadowPass =
            sandboxExecMode === "sync"
            && pendingSteps === 0
            && failedSteps === 0
            && blockedSteps === 0
            && unknownSteps === 0;
          shadowValidation = {
            mode: "execute_sandbox",
            pass: shadowPass,
            validated_at: new Date().toISOString(),
            validator: "repair_review_auto_execute_sandbox",
            profile,
            execution_mode: sandboxExecMode === "sync" ? "sync" : "async_queue",
            max_steps: parsed.shadow_validation_max_steps,
            timeout_ms: timeoutMs,
            stop_on_failure: stopOnFailure,
            summary: {
              total_steps: Math.min(stepsRaw.length, parsed.shadow_validation_max_steps),
              succeeded_steps: succeededSteps,
              failed_steps: failedSteps,
              blocked_steps: blockedSteps,
              unknown_steps: unknownSteps,
              pending_steps: pendingSteps,
            },
            pending: pendingSteps > 0,
            pending_reason: pendingSteps > 0 ? "async_queue_pending" : null,
            steps_preview: checks.slice(0, 20),
          };
        }
      } else {
        const validation = await validatePlaybookShadowReadiness(stepsRaw, opts.localExecutor);
        shadowValidation = {
          mode: "readiness",
          ...validation,
          validated_at: new Date().toISOString(),
          validator: "repair_review_auto_readiness",
        };
        shadowPass = validation.pass;
      }
    }
    if (parsed.auto_shadow_validate && !shadowPass) {
      nextStatus = "draft";
      reviewState = "approved_shadow_blocked";
    } else {
      nextStatus = parsed.target_status_on_approve;
      reviewState = "approved";
    }
  }

  const nextVersion = latest.version_num + 1;
  const reviewCid = playbookClientId(parsed.playbook_id, nextVersion);
  const reviewedAt = new Date().toISOString();
  const writeIdentity = replayWriteIdentityFromInput(parsed, replayWriteIdentityFromRow(source));
  const reviewedTitle = source.title ?? `replay_playbook_${parsed.playbook_id.slice(0, 8)}`;
  const reviewedTextSummary = source.text_summary ?? `Replay playbook ${parsed.playbook_id}`;
  const reviewedSlots = buildReplayReviewedSlots({
    sourceSlots,
    sourceReview,
    playbookId: parsed.playbook_id,
    version: nextVersion,
    status: nextStatus,
    sourceVersion: source.version_num,
    reviewedAt,
    actor: parsed.actor ?? "replay_review",
    action: parsed.action,
    note: parsed.note ?? null,
    autoShadowValidate: parsed.auto_shadow_validate,
    shadowValidationMode: parsed.shadow_validation_mode,
    shadowValidationMaxSteps: parsed.shadow_validation_max_steps,
    autoPromoteOnPass: parsed.auto_promote_on_pass,
    autoPromoteTargetStatus: parsed.auto_promote_target_status,
    autoPromoteGate: (parsed.auto_promote_gate as Record<string, unknown> | null) ?? null,
    targetStatusOnApprove: parsed.target_status_on_approve,
    metadata: (parsed.metadata ?? {}) as Record<string, unknown>,
    reviewState,
    shadowValidation,
  });
  const reviewedNodeFields = await buildStablePlaybookNodeFields({
    embedder: opts.embedder,
    scopeKey: tenancy.scope_key,
    playbookId: parsed.playbook_id,
    version: nextVersion,
    status: nextStatus,
    promotionOrigin: "replay_promote",
    title: reviewedTitle,
    textSummary: reviewedTextSummary,
    clientId: reviewCid,
    commitId: null,
    sourceNodeId: source.id,
    sourceCommitId: source.commit_id ?? null,
    slots: reviewedSlots,
  });
  const writeReq = buildReplayPlaybookProcedureWriteRequest({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "replay_review",
    inputText: `review playbook ${parsed.playbook_id} v${source.version_num} action=${parsed.action}`,
    writeIdentity: writeIdentity as unknown as Record<string, unknown>,
    clientId: reviewCid,
    title: reviewedTitle,
    textSummary: reviewedTextSummary,
    slots: reviewedNodeFields.slots,
    embedding: reviewedNodeFields.embedding,
    embeddingModel: reviewedNodeFields.embedding_model,
    sourceNodeId: source.id,
  });
  const { out } = await applyReplayMemoryWrite(writeReq, opts);
  const reviewed = out.nodes.find((n) => n.client_id === reviewCid) ?? out.nodes[0] ?? null;
  let finalStatus: "draft" | "shadow" | "active" | "disabled" = nextStatus;
  let finalVersion = nextVersion;
  let finalNodeId = reviewed?.id ?? null;
  let finalUri =
    reviewed?.id != null
      ? buildAionisUri({
          tenant_id: tenancy.tenant_id,
          scope: tenancy.scope,
          type: "procedure",
          id: reviewed.id,
        })
      : null;
  let finalCommitId = out.commit_id;
  let finalCommitUri = out.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, out.commit_id);
  let finalCommitHash = out.commit_hash;
  let autoPromotion: Record<string, unknown> | null = null;

  const autoPromoteRequested = parsed.action === "approve" && parsed.auto_promote_on_pass === true;
  if (autoPromoteRequested) {
    const gateEval = evaluateAutoPromoteGate(
      extractShadowValidationGateMetrics(shadowValidation),
      asObject(parsed.auto_promote_gate) ?? {},
    );
    if (parsed.auto_shadow_validate !== true) {
      autoPromotion = {
        attempted: true,
        promoted: false,
        reason: "auto_shadow_validate_required",
        gate: gateEval,
      };
    } else if (nextStatus !== parsed.target_status_on_approve) {
      autoPromotion = {
        attempted: true,
        promoted: false,
        reason: "review_not_in_target_status_on_approve",
        gate: gateEval,
      };
    } else if (!gateEval.pass) {
      autoPromotion = {
        attempted: true,
        promoted: false,
        reason: "gate_not_passed",
        gate: gateEval,
      };
    } else if (parsed.auto_promote_target_status === nextStatus) {
      autoPromotion = {
        attempted: true,
        promoted: false,
        reason: "already_target_status",
        gate: gateEval,
      };
    } else {
      const promoteVersion = nextVersion + 1;
      const promoteCid = playbookClientId(parsed.playbook_id, promoteVersion);
      const promoteSlots = buildReplayAutoPromotedSlots({
        reviewedSlots,
        version: promoteVersion,
        status: parsed.auto_promote_target_status,
        triggeredAt: new Date().toISOString(),
        fromVersion: nextVersion,
        toVersion: promoteVersion,
        fromStatus: nextStatus,
        gate: gateEval as Record<string, unknown>,
      });
      const promotedTitle = source.title ?? `replay_playbook_${parsed.playbook_id.slice(0, 8)}`;
      const promotedTextSummary = source.text_summary ?? `Replay playbook ${parsed.playbook_id}`;
      const promotedNodeFields = await buildStablePlaybookNodeFields({
        embedder: opts.embedder,
        scopeKey: tenancy.scope_key,
        playbookId: parsed.playbook_id,
        version: promoteVersion,
        status: parsed.auto_promote_target_status,
        promotionOrigin: "replay_promote",
        title: promotedTitle,
        textSummary: promotedTextSummary,
        clientId: promoteCid,
        commitId: null,
        sourceNodeId: reviewed?.id ?? source.id,
        sourceCommitId: out.commit_id ?? source.commit_id ?? null,
        slots: promoteSlots,
      });
      const promoteReq = buildReplayPlaybookProcedureWriteRequest({
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope,
        actor: parsed.actor ?? "replay_review",
        inputText: `auto promote playbook ${parsed.playbook_id} v${nextVersion}->v${promoteVersion}`,
        writeIdentity: writeIdentity as unknown as Record<string, unknown>,
        clientId: promoteCid,
        title: promotedTitle,
        textSummary: promotedTextSummary,
        slots: promotedNodeFields.slots,
        embedding: promotedNodeFields.embedding,
        embeddingModel: promotedNodeFields.embedding_model,
        sourceNodeId: reviewed?.id ?? source.id,
      });
      const { out: outPromote } = await applyReplayMemoryWrite(promoteReq, opts);
      const promotedNode = outPromote.nodes.find((n) => n.client_id === promoteCid) ?? outPromote.nodes[0] ?? null;
      finalStatus = parsed.auto_promote_target_status;
      finalVersion = promoteVersion;
      finalNodeId = promotedNode?.id ?? null;
      finalUri =
        promotedNode?.id != null
          ? buildAionisUri({
              tenant_id: tenancy.tenant_id,
              scope: tenancy.scope,
              type: "procedure",
              id: promotedNode.id,
            })
          : null;
      finalCommitId = outPromote.commit_id;
      finalCommitUri = outPromote.commit_uri ?? buildCommitUri(tenancy.tenant_id, tenancy.scope, outPromote.commit_id);
      finalCommitHash = outPromote.commit_hash;
      autoPromotion = {
        attempted: true,
        promoted: true,
        from_version: nextVersion,
        to_version: promoteVersion,
        to_status: parsed.auto_promote_target_status,
        gate: gateEval,
        playbook_node_id: finalNodeId,
        playbook_uri: finalUri,
        commit_id: outPromote.commit_id,
        commit_uri: finalCommitUri,
        commit_hash: outPromote.commit_hash,
      };
    }
  }

  const learningProjectionConfig = resolveReplayLearningProjectionConfig(
    asObject((parsed as any).learning_projection),
    opts.learningProjectionDefaults,
  );
  const explicitLearningProjectionTargetRuleState = hasExplicitReplayLearningProjectionTargetRuleState(
    asObject((parsed as any).learning_projection),
  );
  let effectiveLearningProjectionConfig = learningProjectionConfig;
  let learningProjectionResult: ReplayLearningProjectionResult | undefined;
  let learningControlPreview: ReplayRepairReviewLearningControlPreview | null = null;
  let policyMutation: PolicyMutationV1 | null = null;
  let policyMutationAdjudication: PolicyMutationAdjudicationV1 | null = null;
  if (parsed.action === "approve" && reviewState === "approved" && learningProjectionConfig.enabled) {
    const promoteInput = MemoryPromoteRequest.parse({
      candidate_node_ids: [finalNodeId ?? source.id],
      target_kind: "workflow",
      target_level: "L2",
      input_text: `promote replay repair review ${parsed.playbook_id} v${finalVersion}`,
    });
    const candidateExamples = [
      {
        node_id: finalNodeId ?? source.id,
        title: source.title ?? null,
        summary: source.text_summary ?? null,
        workflow_signature: toStringOrNull((reviewedSlots as any).workflow_signature) ?? null,
        outcome_status: nextStatus === "disabled" ? "disabled" : "success",
        success_score: 1,
      },
    ];
    const suppliedReview = asObject((parsed as any).learning_control_review)?.promote_memory
      && asObject(asObject((parsed as any).learning_control_review)?.promote_memory)?.review_result
      ? (asObject(asObject((parsed as any).learning_control_review)?.promote_memory)?.review_result as Record<string, unknown>)
      : null;
    learningControlPreview = {
      promote_memory: await runPromoteMemoryLearningControlPreview({
        input: promoteInput,
        candidateExamples,
        reviewResult: (suppliedReview as any) ?? null,
        reviewProvider: opts.learningControlReviewProviders?.promote_memory ?? undefined,
        derivePolicyEffect: ({ review, admissibility }) =>
          deriveReplayLearningControlPolicyEffect({
            baseTargetRuleState: learningProjectionConfig.target_rule_state,
            explicitTargetRuleState: explicitLearningProjectionTargetRuleState,
            review,
            admissibility,
          }),
        buildDecisionTrace: ({ reviewResult, admissibility, policyEffect }) => {
          const effectiveConfig = applyReplayLearningControlPolicyEffect({
            config: learningProjectionConfig,
            policyEffect,
          });
          effectiveLearningProjectionConfig = effectiveConfig;
          return buildReplayLearningControlDecisionTrace({
            reviewResult,
            admissibility,
            policyEffect: policyEffect ?? null,
            effectiveConfig,
          });
        },
      }),
    };
    effectiveLearningProjectionConfig = applyReplayLearningControlPolicyEffect({
      config: learningProjectionConfig,
      policyEffect: learningControlPreview.promote_memory.policy_effect ?? null,
    });
  }
  if (parsed.action !== "approve") {
    learningProjectionResult = {
      triggered: false,
      delivery: effectiveLearningProjectionConfig.delivery,
      status: "skipped",
      reason: "review_action_not_approve",
    };
  } else if (reviewState !== "approved") {
    learningProjectionResult = {
      triggered: false,
      delivery: effectiveLearningProjectionConfig.delivery,
      status: "skipped",
      reason: "review_not_approved",
    };
  } else if (!effectiveLearningProjectionConfig.enabled) {
    learningProjectionResult = {
      triggered: false,
      delivery: effectiveLearningProjectionConfig.delivery,
      status: "skipped",
      reason: "learning_projection_disabled",
    };
  } else if (effectiveLearningProjectionConfig.delivery === "async_outbox" && asLiteReplayWriteStore(opts.writeAccess)) {
    throw new HttpError(
      400,
      "replay_learning_async_outbox_unsupported_in_lite",
      "lite replay repair review requires sync_inline learning projection delivery",
      {
        delivery: effectiveLearningProjectionConfig.delivery,
        supported_delivery: "sync_inline",
      },
    );
  } else {
    const gateMetrics = extractShadowValidationGateMetrics(shadowValidation);
    const inferredTotalSteps = Array.isArray((reviewedSlots as any).steps_template)
      ? (reviewedSlots as any).steps_template.length
      : 0;
    const projectionSource = {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      scope_key: tenancy.scope_key,
      actor: parsed.actor ?? "replay_review",
      playbook_id: parsed.playbook_id,
      playbook_version: finalVersion,
      playbook_node_id: finalNodeId ?? source.id,
      playbook_title: source.title ?? null,
      playbook_summary: source.text_summary ?? null,
      playbook_slots: reviewedSlots as Record<string, unknown>,
      source_commit_id: finalCommitId,
      metrics: {
        total_steps: gateMetrics?.total_steps ?? inferredTotalSteps,
        success_ratio: gateMetrics?.success_ratio ?? 1,
      },
    };
    if (effectiveLearningProjectionConfig.delivery === "sync_inline") {
      try {
        learningProjectionResult = await applyReplayLearningProjection(projectionSource, effectiveLearningProjectionConfig, opts);
      } catch (err: any) {
        learningProjectionResult = {
          triggered: true,
          delivery: effectiveLearningProjectionConfig.delivery,
          status: "failed",
          reason: String(err?.code ?? err?.message ?? err),
        };
      }
    } else {
      try {
        const payload = {
          tenant_id: tenancy.tenant_id,
          scope: tenancy.scope,
          scope_key: tenancy.scope_key,
          actor: parsed.actor ?? "replay_review",
          playbook_id: parsed.playbook_id,
          playbook_version: finalVersion,
          source_commit_id: finalCommitId ?? null,
          config: effectiveLearningProjectionConfig,
        };
        const enq = await enqueueReplayLearningProjectionOutbox({
          scopeKey: tenancy.scope_key,
          commitId: finalCommitId,
          payload,
          writeAccess: opts.writeAccess,
        });
        learningProjectionResult = {
          triggered: true,
          delivery: effectiveLearningProjectionConfig.delivery,
          status: "queued",
          job_key: enq.job_key,
        };
      } catch (err: any) {
        learningProjectionResult = {
          triggered: true,
          delivery: effectiveLearningProjectionConfig.delivery,
          status: "failed",
          reason: String(err?.code ?? err?.message ?? err),
        };
      }
    }
  }
  if (learningProjectionResult) {
    policyMutation = buildPolicyMutationFromReplayLearningProjection({
      scope: tenancy.scope,
      playbook_id: parsed.playbook_id,
      playbook_version: finalVersion,
      status: learningProjectionResult.status,
      generated_rule_node_id: learningProjectionResult.generated_rule_node_id ?? null,
      generated_episode_node_id: learningProjectionResult.generated_episode_node_id ?? null,
      generated_workflow_node_id: learningProjectionResult.generated_workflow_node_id ?? null,
      rule_state: learningProjectionResult.rule_state ?? null,
      learning_control_admissible: learningControlPreview?.promote_memory.admissibility?.admissible === true,
      policy_effect_applies: learningControlPreview?.promote_memory.policy_effect?.applies === true,
    });
    policyMutationAdjudication = policyMutation ? adjudicatePolicyMutationV1(policyMutation) : null;
  }

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    playbook_id: parsed.playbook_id,
    reviewed_version: source.version_num,
    to_version: finalVersion,
    action: parsed.action,
    status: finalStatus,
    review_state: reviewState,
    shadow_validation: shadowValidation,
    auto_promotion: autoPromotion,
    playbook_node_id: finalNodeId,
    playbook_uri: finalUri,
    commit_id: finalCommitId,
    commit_uri: finalCommitUri,
    commit_hash: finalCommitHash,
    learning_projection_result: learningProjectionResult,
    learning_control_preview: learningControlPreview,
    policy_mutation_v1: policyMutation,
    policy_mutation_adjudication_v1: policyMutationAdjudication,
  };
}

export async function replayPlaybookRun(body: unknown, opts: ReplayPlaybookRunOptions) {
  requireReplayReadAccess(opts);
  const parsed = parsePlaybookRunInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const visibility = replayVisibilityFromInput(parsed);
  const replayAccess = requireReplayAccess(opts);
  const row =
    parsed.version != null
      ? await replayAccess.getReplayPlaybookVersion(tenancy.scope_key, parsed.playbook_id, parsed.version, visibility)
      : (await replayAccess.listReplayPlaybookVersions(tenancy.scope_key, parsed.playbook_id, visibility))[0] ?? null;
  if (!row) {
    throw new HttpError(404, "replay_playbook_not_found", "playbook was not found in this scope", {
      playbook_id: parsed.playbook_id,
      version: parsed.version ?? null,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }

  const replayCallIdentity = {
    consumer_agent_id: parsed.consumer_agent_id ?? undefined,
    consumer_team_id: parsed.consumer_team_id ?? undefined,
    memory_lane: parsed.memory_lane ?? row.memory_lane,
    producer_agent_id: parsed.producer_agent_id ?? row.producer_agent_id ?? undefined,
    owner_agent_id: parsed.owner_agent_id ?? row.owner_agent_id ?? undefined,
    owner_team_id: parsed.owner_team_id ?? row.owner_team_id ?? undefined,
  };
  const slotsObj = asObject(row.slots) ?? {};
  const stepsRaw = Array.isArray(slotsObj.steps_template) ? slotsObj.steps_template.slice(0, parsed.max_steps) : [];
  const paramsObj = asObject(parsed.params) ?? {};
  const deterministicGate = evaluateReplayDeterministicGate({
    requestedMode: parsed.mode,
    gateInput: parsed.deterministic_gate,
    playbookStatus: row.playbook_status,
    playbookSlots: slotsObj,
  });
  if (deterministicGate.enabled && !deterministicGate.matched && deterministicGate.decision === "rejected") {
    throw new HttpError(
      409,
      "replay_deterministic_gate_mismatch",
      "deterministic replay gate did not match the selected playbook version",
      {
        playbook_id: parsed.playbook_id,
        version: row.version_num,
        requested_mode: deterministicGate.requested_mode,
        playbook_status: deterministicGate.playbook_status,
        required_statuses: deterministicGate.required_statuses,
        status_match: deterministicGate.status_match,
        matchers_match: deterministicGate.matchers_match,
        policy_constraints_match: deterministicGate.policy_constraints_match,
        request_matcher_fingerprint: deterministicGate.request_matcher_fingerprint,
        playbook_matcher_fingerprint: deterministicGate.playbook_matcher_fingerprint,
        request_policy_fingerprint: deterministicGate.request_policy_fingerprint,
        playbook_policy_fingerprint: deterministicGate.playbook_policy_fingerprint,
      },
    );
  }
  const mode = deterministicGate.effective_mode;
  const stepReports: Array<Record<string, unknown>> = [];
  const recordRun = paramsObj.record_run !== false && Boolean(opts.writeOptions);
  const requestedRunIdRaw = toStringOrNull(paramsObj.run_id);
  const replayRunId = requestedRunIdRaw && UUID_V4_OR_VX.test(requestedRunIdRaw) ? requestedRunIdRaw : randomUUID();

  if (mode === "simulate") {
    let runStartOut: Record<string, unknown> | null = null;
    if (recordRun) {
      runStartOut = await replayRunStart(
        buildReplayPlaybookRunStartBody({
          tenantId: tenancy.tenant_id,
          scope: tenancy.scope,
          actor: parsed.actor ?? undefined,
          replayCallIdentity,
          replayRunId,
          playbookId: parsed.playbook_id,
          playbookVersion: row.version_num,
          mode: "simulate",
          contextSnapshotRef: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: row.type,
            id: row.id,
          }),
        }),
        opts.writeOptions!,
      ) as Record<string, unknown>;
    }
    const simulation = await simulateReplaySteps({
      stepsRaw,
      persistStep: recordRun
        ? async (stepInput) => {
            const before = await replayStepBefore(
              {
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                actor: parsed.actor ?? undefined,
                ...replayCallIdentity,
                run_id: replayRunId,
                step_index: stepInput.stepIndex,
                tool_name: stepInput.toolName,
                tool_input: stepInput.toolInput,
                expected_output_signature: stepInput.expectedOutputSignature,
                preconditions: stepInput.preconditions,
                retry_policy: stepInput.retryPolicy,
                safety_level: stepInput.safetyLevel,
                metadata: {
                  replay_mode: "simulate",
                  playbook_id: parsed.playbook_id,
                  playbook_version: row.version_num,
                },
              },
              opts.writeOptions!,
            ) as Record<string, unknown>;
            const persistedStepId = toStringOrNull(before.step_id);
            await replayStepAfter(
              {
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                actor: parsed.actor ?? undefined,
                ...replayCallIdentity,
                run_id: replayRunId,
                step_id: persistedStepId ?? undefined,
                step_index: stepInput.stepIndex,
                status: stepInput.readiness === "ready" ? "success" : "partial",
                output_signature: {
                  readiness: stepInput.readiness,
                  command: stepInput.command,
                  argv: stepInput.argv,
                },
                postconditions: [],
                artifact_refs: [],
                repair_applied: false,
                error: stepInput.error,
                metadata: {
                  replay_mode: "simulate",
                  readiness: stepInput.readiness,
                },
              },
              opts.writeOptions!,
            );
          }
        : null,
    });
    stepReports.push(...simulation.stepReports);
    const { readySteps, blockedSteps, unknownSteps } = simulation;
    const runStatus = blockedSteps > 0 || unknownSteps > 0 ? "partial" : "success";
    let runEndOut: Record<string, unknown> | null = null;
    if (recordRun) {
      runEndOut = await replayRunEnd(
        buildReplayPlaybookRunEndBody({
          tenantId: tenancy.tenant_id,
          scope: tenancy.scope,
          actor: parsed.actor ?? undefined,
          replayCallIdentity,
          replayRunId,
          playbookId: parsed.playbook_id,
          playbookVersion: row.version_num,
          mode: "simulate",
          runStatus,
          summary:
            runStatus === "success"
              ? "simulate replay readiness passed"
              : "simulate replay found blocked or unknown steps",
          metrics: {
            total_steps: stepsRaw.length,
            ready_steps: readySteps,
            blocked_steps: blockedSteps,
            unknown_steps: unknownSteps,
          },
        }),
        opts.writeOptions!,
      ) as Record<string, unknown>;
    }
    return {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      playbook: buildReplayRunPlaybookSurface({
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope,
        playbookId: parsed.playbook_id,
        row,
      }),
      mode: "simulate",
      deterministic_gate: deterministicGate,
      run: recordRun
        ? buildReplayRunSurface({
            runId: replayRunId,
            status: runStatus,
            runStartOut,
            runEndOut,
          })
        : null,
      execution_policy: {
        execution_backend: normalizeReplayExecutionBackend(toStringOrNull(paramsObj.execution_backend)),
        sensitive_review_mode: normalizeReplaySensitiveReviewMode(toStringOrNull(paramsObj.sensitive_review_mode)),
      },
      summary: buildReplaySimulateSummary({
        totalSteps: stepsRaw.length,
        readySteps: readySteps,
        blockedSteps: blockedSteps,
        unknownSteps: unknownSteps,
      }),
      steps: stepReports,
      execution: {
        inference_skipped: deterministicGate.inference_skipped,
        deterministic_gate_matched: deterministicGate.matched,
      },
      params_echo: parsed.params ?? {},
      cost_signals: buildReplayCostSignals({ deterministic_gate: deterministicGate }),
    };
  }

  const localExecutor = opts.localExecutor;
  const executionBackend = normalizeReplayExecutionBackend(toStringOrNull(paramsObj.execution_backend));
  const sandboxProjectId = toStringOrNull(parsed.project_id) ?? toStringOrNull(paramsObj.project_id);
  const sensitiveReviewMode = normalizeReplaySensitiveReviewMode(toStringOrNull(paramsObj.sensitive_review_mode));
  const allowSensitiveExec = paramsObj.allow_sensitive_exec === true;

  if (executionBackend === "sandbox_async" && mode === "strict") {
    throw new HttpError(
      400,
      "replay_strict_async_not_supported",
      "strict replay does not support async sandbox execution; use sandbox_sync or local_process.",
      { execution_backend: executionBackend },
    );
  }
  if (executionBackend === "local_process") {
    if (!localExecutor?.enabled || localExecutor.mode !== "local_process") {
      throw new HttpError(
        400,
        "replay_executor_not_enabled",
        "strict/guided replay with local_process requires SANDBOX_ENABLED=true and SANDBOX_EXECUTOR_MODE=local_process.",
        { execution_backend: executionBackend },
      );
    }
  } else if (!opts.sandboxExecutor) {
    throw new HttpError(
      400,
      "replay_sandbox_executor_not_enabled",
      "sandbox replay backend is not configured on this deployment",
      { execution_backend: executionBackend },
    );
  }
  if (!opts.writeOptions) {
    throw new HttpError(500, "replay_run_write_options_missing", "strict/guided replay requires write options wiring.");
  }
  if (paramsObj.allow_local_exec !== true) {
    throw new HttpError(
      400,
      "replay_local_exec_consent_required",
      "strict/guided replay requires params.allow_local_exec=true as explicit execution consent.",
      { execution_backend: executionBackend },
    );
  }

  const requestedCommands = asStringArray(paramsObj.allowed_commands);
  const requestedSet = requestedCommands.length > 0 ? new Set(requestedCommands) : null;
  const allowedCommands = new Set<string>();
  for (const cmd of (localExecutor?.allowedCommands ?? new Set<string>()).values()) {
    if (requestedSet && !isAllowedReplayCommand(cmd, requestedSet)) continue;
    allowedCommands.add(cmd);
  }
  if (allowedCommands.size === 0) {
    throw new HttpError(
      400,
      "replay_allowed_commands_empty",
      "No allowed commands remain for replay execution after allowlist filtering.",
      {
        requested_commands: requestedCommands,
      },
    );
  }
  const defaultGuidedRepairStrategy = opts.guidedRepair?.strategy ?? "agent_repair_request";
  const requestedGuidedRepairStrategy = toStringOrNull(paramsObj.guided_repair_strategy);
  if (requestedGuidedRepairStrategy && requestedGuidedRepairStrategy !== "agent_repair_request") {
    throw new HttpError(
      400,
      "replay_guided_repair_strategy_not_allowed",
      "Runtime guided repair only emits agent_repair_request evidence; semantic repair belongs to the Agent or external candidate producer.",
      {
        requested_strategy: requestedGuidedRepairStrategy,
        default_strategy: defaultGuidedRepairStrategy,
      },
    );
  }
  const guidedRepairStrategy: ReplayGuidedRepairStrategy =
    requestedGuidedRepairStrategy === "agent_repair_request" ? requestedGuidedRepairStrategy : defaultGuidedRepairStrategy;
  const guidedRepairMaxErrorChars = clampInt(
    Number(paramsObj.guided_repair_max_error_chars ?? opts.guidedRepair?.maxErrorChars ?? 1200),
    64,
    20000,
  );

  const timeoutMs = clampInt(Number(paramsObj.timeout_ms ?? localExecutor?.timeoutMs ?? 15000), 100, 600000);
  const stdioMaxBytes = clampInt(Number(paramsObj.stdio_max_bytes ?? localExecutor?.stdioMaxBytes ?? 65536), 1024, 1024 * 1024);
  const workdir = toStringOrNull(paramsObj.workdir) ?? localExecutor?.workdir ?? process.cwd();
  const autoConfirm = paramsObj.auto_confirm === true;
  const stopOnFailure = paramsObj.stop_on_failure !== false;
  if (executionBackend !== "local_process" && opts.sandboxBudgetGuard) {
    await opts.sandboxBudgetGuard({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      project_id: sandboxProjectId,
    });
  }

  let runStartOut: Record<string, unknown> | null = null;
  if (recordRun) {
    runStartOut = await replayRunStart(
      buildReplayPlaybookRunStartBody({
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope,
        actor: parsed.actor ?? undefined,
        replayCallIdentity,
        replayRunId,
        playbookId: parsed.playbook_id,
        playbookVersion: row.version_num,
        mode,
        contextSnapshotRef: buildAionisUri({
          tenant_id: tenancy.tenant_id,
          scope: tenancy.scope,
          type: row.type,
          id: row.id,
        }),
        executionBackend,
        sandboxProjectId,
        sensitiveReviewMode,
        guidedRepairStrategy,
      }),
      opts.writeOptions,
    ) as Record<string, unknown>;
  }

  const counters: ReplayRunCounters = {
    executedSteps: 0,
    succeededSteps: 0,
    failedSteps: 0,
    repairedSteps: 0,
    blockedSteps: 0,
    skippedSteps: 0,
    pendingSteps: 0,
  };
  const usageOut = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    source: "no_model_call",
  };

  const guidedRepairConfig = {
    strategy: guidedRepairStrategy,
    allowedCommands,
    maxErrorChars: guidedRepairMaxErrorChars,
  };

  const writeStepAfter = recordRun
    ? async (input: {
        stepId: string | null;
        stepIndex: number | null;
        status: "success" | "partial" | "failed";
        outputSignature: Record<string, unknown>;
        postconditions: PreconditionResult[];
        artifactRefs: unknown[];
        repairApplied: boolean;
        repairNote?: string;
        error?: string;
      }) => {
        await replayStepAfter(
          {
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            ...replayCallIdentity,
            run_id: replayRunId,
            step_id: input.stepId ?? undefined,
            step_index: input.stepIndex ?? undefined,
            status: input.status,
            output_signature: input.outputSignature,
            postconditions: input.postconditions,
            artifact_refs: input.artifactRefs,
            repair_applied: input.repairApplied,
            repair_note: input.repairNote,
            error: input.error,
          },
          opts.writeOptions!,
        );
      }
    : null;

  for (const step of stepsRaw) {
    const stepObj = asObject(step) ?? {};
    const stepIndex = Number(stepObj.step_index ?? 0) || null;
    const toolName = toStringOrNull(stepObj.tool_name);
    const safetyLevel = toStringOrNull(stepObj.safety_level) ?? "needs_confirm";
    const expectedSignature = stepObj.expected_output_signature ?? null;
    const toolInput = stepObj.tool_input_template ?? stepObj.tool_input ?? {};
    const preconditions = Array.isArray(stepObj.preconditions) ? stepObj.preconditions : [];
    const postconditions = Array.isArray(stepObj.postconditions) ? stepObj.postconditions : [];

    let persistedStepId: string | null = null;
    if (recordRun && stepIndex != null && toolName) {
      const before = await replayStepBefore(
        {
          tenant_id: tenancy.tenant_id,
          scope: tenancy.scope,
          ...replayCallIdentity,
          run_id: replayRunId,
          step_index: stepIndex,
          tool_name: toolName,
          tool_input: toolInput,
          expected_output_signature: expectedSignature,
          preconditions,
          safety_level: safetyLevel as "auto_ok" | "needs_confirm" | "manual_only",
          metadata: {
            replay_mode: mode,
            playbook_id: parsed.playbook_id,
            playbook_version: row.version_num,
          },
        },
        opts.writeOptions,
      ) as Record<string, unknown>;
      persistedStepId = toStringOrNull(before.step_id);
    }

    const preChecks: PreconditionResult[] = [];
    for (const cond of preconditions) preChecks.push(await evaluatePrecondition(cond));
    const preconditionGate = resolveReplayPreconditionGate(preChecks);
    if (preconditionGate) {
      if (mode === "strict") {
        const handled = await handleReplayStrictGateStep({
          gate: preconditionGate,
          stepId: persistedStepId,
          stepIndex,
          toolName,
          preconditions: preChecks,
          writeStepAfter,
          stopOnFailure,
          countBlocked: true,
        });
        stepReports.push(handled.report);
        applyReplayRunStepDelta(counters, handled.delta);
        if (handled.stop) break;
        continue;
      }
      const handled = await handleReplayGuidedGateStep({
        gate: preconditionGate,
        stepId: persistedStepId,
        stepIndex,
        toolName,
        stepObj,
        preconditions: preChecks,
        writeStepAfter,
        guidedRepair: guidedRepairConfig,
        countBlocked: true,
      });
      mergeReplayUsage(usageOut, handled.usage);
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const confirmationGate = resolveReplayConfirmationGate({
      safetyLevel,
      autoConfirm,
    });
    if (confirmationGate) {
      if (mode === "strict") {
        const handled = await handleReplayStrictGateStep({
          gate: confirmationGate,
          stepId: persistedStepId,
          stepIndex,
          toolName,
          writeStepAfter,
          stopOnFailure,
        });
        stepReports.push(handled.report);
        applyReplayRunStepDelta(counters, handled.delta);
        if (handled.stop) break;
        continue;
      }
      const handled = await handleReplayGuidedGateStep({
        gate: confirmationGate,
        stepId: persistedStepId,
        stepIndex,
        toolName,
        stepObj,
        writeStepAfter,
        guidedRepair: guidedRepairConfig,
      });
      mergeReplayUsage(usageOut, handled.usage);
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const unsupportedToolGate = resolveReplayUnsupportedToolGate(toolName);
    if (unsupportedToolGate) {
      if (mode === "strict") {
        const handled = await handleReplayStrictGateStep({
          gate: unsupportedToolGate,
          stepId: persistedStepId,
          stepIndex,
          toolName,
          writeStepAfter,
          stopOnFailure,
        });
        stepReports.push(handled.report);
        applyReplayRunStepDelta(counters, handled.delta);
        if (handled.stop) break;
        continue;
      }
      const handled = await handleReplayGuidedGateStep({
        gate: unsupportedToolGate,
        stepId: persistedStepId,
        stepIndex,
        toolName,
        stepObj,
        writeStepAfter,
        guidedRepair: guidedRepairConfig,
      });
      mergeReplayUsage(usageOut, handled.usage);
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const argv = parseStepArgv(stepObj, toolName);
    const command = String(argv[0] ?? "").trim();
    const commandAllowlistGate = resolveReplayCommandAllowlistGate({
      argv,
      allowedCommands,
    });
    if (commandAllowlistGate) {
      if (mode === "strict") {
        const handled = await handleReplayStrictGateStep({
          gate: commandAllowlistGate,
          stepId: persistedStepId,
          stepIndex,
          toolName,
          writeStepAfter,
          stopOnFailure,
        });
        stepReports.push(handled.report);
        applyReplayRunStepDelta(counters, handled.delta);
        if (handled.stop) break;
        continue;
      }
      const handled = await handleReplayGuidedGateStep({
        gate: commandAllowlistGate,
        stepId: persistedStepId,
        stepIndex,
        toolName,
        stepObj,
        writeStepAfter,
        guidedRepair: guidedRepairConfig,
      });
      mergeReplayUsage(usageOut, handled.usage);
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const sensitive = detectSensitiveCommand(command, argv);
    const sensitiveReviewInfo = sensitive.sensitive
      ? {
          command,
          argv,
          reason: sensitive.reason,
          risk_level: sensitive.risk_level,
          mode: sensitiveReviewMode,
          override_used: allowSensitiveExec,
        }
      : null;
    const sensitiveGate = resolveReplaySensitiveCommandGate({
      command,
      argv,
      sensitive: sensitive.sensitive,
      sensitiveReason: sensitive.reason,
      riskLevel: sensitive.risk_level,
      sensitiveReviewMode,
      allowSensitiveExec,
    });
    if (sensitiveGate) {
      if (mode === "strict") {
        const handled = await handleReplayStrictGateStep({
          gate: sensitiveGate,
          stepId: persistedStepId,
          stepIndex,
          toolName,
          writeStepAfter,
          stopOnFailure,
          countBlocked: true,
        });
        stepReports.push(handled.report);
        applyReplayRunStepDelta(counters, handled.delta);
        if (handled.stop) break;
        continue;
      }
      const handled = await handleReplayGuidedGateStep({
        gate: sensitiveGate,
        stepId: persistedStepId,
        stepIndex,
        toolName,
        stepObj,
        writeStepAfter,
        guidedRepair: guidedRepairConfig,
      });
      mergeReplayUsage(usageOut, handled.usage);
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const exec = await executeReplayCommand({
      backend: executionBackend,
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      project_id: sandboxProjectId,
      argv,
      timeout_ms: timeoutMs,
      local: { cwd: workdir, stdioMaxBytes },
      sandboxExecutor: opts.sandboxExecutor,
    });
    if (exec.pending || !exec.outcome) {
      const handled = await handleReplayPendingStep({
        stepId: persistedStepId,
        stepIndex,
        toolName,
        mode,
        command,
        argv,
        executionBackend,
        sandboxRunId: exec.sandbox_run_id,
        sandboxStatus: exec.raw_status,
        writeStepAfter,
        stopOnFailure,
      });
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      if (handled.stop) break;
      continue;
    }
    const execOutcome = exec.outcome;
    const resultSummary = summarizeToolResult({
      stdout: execOutcome.stdout,
      stderr: execOutcome.stderr,
      exit_code: execOutcome.exit_code,
      error: execOutcome.error,
      truncated: false,
    });
    const signature = evaluateExpectedSignature(expectedSignature, execOutcome);
    const postChecks: PreconditionResult[] = [];
    for (const cond of postconditions) postChecks.push(await evaluatePostcondition(cond, execOutcome));
    const executionPassed = isReplayExecutionPassed({
      execution: execOutcome,
      signature,
      postconditions: postChecks,
    });

    if (executionPassed) {
      const handled = await handleReplaySuccessStep({
        stepId: persistedStepId,
        stepIndex,
        toolName,
        command,
        argv,
        executionBackend,
        sandboxRunId: exec.sandbox_run_id,
        sensitiveReview: sensitiveReviewInfo,
        execution: execOutcome,
        resultSummary: resultSummary as Record<string, unknown>,
        signature,
        postconditions: postChecks,
        writeStepAfter,
      });
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      continue;
    }

    const failureReason = resolveReplayExecutionFailureReason(execOutcome);
    if (mode === "strict") {
      const handled = await handleReplayStrictFailureStep({
        stepId: persistedStepId,
        stepIndex,
        toolName,
        command,
        argv,
        executionBackend,
        sandboxRunId: exec.sandbox_run_id,
        sensitiveReview: sensitiveReviewInfo,
        execution: execOutcome,
        resultSummary: resultSummary as Record<string, unknown>,
        signature,
        preconditions: preChecks,
        postconditions: postChecks,
        error: failureReason,
        writeStepAfter,
        stopOnFailure,
      });
      stepReports.push(handled.report);
      applyReplayRunStepDelta(counters, handled.delta);
      if (handled.stop) break;
      continue;
    }

    const handled = await handleReplayGuidedFailureStep({
      stepId: persistedStepId,
      stepIndex,
      toolName,
      stepObj,
      command,
      argv,
      executionBackend,
      sandboxRunId: exec.sandbox_run_id,
      sensitiveReview: sensitiveReviewInfo,
      execution: execOutcome,
      resultSummary: resultSummary as Record<string, unknown>,
      signature,
      postconditions: postChecks,
      error: failureReason,
      writeStepAfter,
      guidedRepair: guidedRepairConfig,
    });
    mergeReplayUsage(usageOut, handled.usage);
    stepReports.push(handled.report);
    applyReplayRunStepDelta(counters, handled.delta);
  }

  const runStatus: "success" | "failed" | "partial" =
    mode === "strict"
      ? (counters.failedSteps > 0 ? "failed" : "success")
      : (counters.failedSteps > 0 ? "failed" : counters.repairedSteps > 0 || counters.skippedSteps > 0 ? "partial" : "success");

  let runEndOut: Record<string, unknown> | null = null;
  if (recordRun) {
    runEndOut = await replayRunEnd(
      buildReplayPlaybookRunEndBody({
        tenantId: tenancy.tenant_id,
        scope: tenancy.scope,
        actor: parsed.actor ?? undefined,
        replayCallIdentity,
        replayRunId,
        playbookId: parsed.playbook_id,
        playbookVersion: row.version_num,
        mode,
        runStatus,
        summary: `Replay ${mode} run completed: success=${counters.succeededSteps}, failed=${counters.failedSteps}, repaired=${counters.repairedSteps}, pending=${counters.pendingSteps}`,
        successCriteria: {
          mode,
          execution_backend: executionBackend,
          failed_steps: counters.failedSteps,
          repaired_steps: counters.repairedSteps,
          skipped_steps: counters.skippedSteps,
          pending_steps: counters.pendingSteps,
        },
        metrics: {
          total_steps: stepsRaw.length,
          executed_steps: counters.executedSteps,
          succeeded_steps: counters.succeededSteps,
          failed_steps: counters.failedSteps,
          repaired_steps: counters.repairedSteps,
          blocked_steps: counters.blockedSteps,
          skipped_steps: counters.skippedSteps,
          pending_steps: counters.pendingSteps,
        },
      }),
      opts.writeOptions,
    ) as Record<string, unknown>;
  }

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    playbook: buildReplayRunPlaybookSurface({
      tenantId: tenancy.tenant_id,
      scope: tenancy.scope,
      playbookId: parsed.playbook_id,
      row,
    }),
    mode,
    deterministic_gate: deterministicGate,
    run: buildReplayRunSurface({
      runId: replayRunId,
      status: runStatus,
      runStartOut,
      runEndOut,
    }),
    summary: buildReplayExecutionSummary({
      totalSteps: stepsRaw.length,
      executedSteps: counters.executedSteps,
      succeededSteps: counters.succeededSteps,
      failedSteps: counters.failedSteps,
      repairedSteps: counters.repairedSteps,
      blockedSteps: counters.blockedSteps,
      skippedSteps: counters.skippedSteps,
      pendingSteps: counters.pendingSteps,
    }),
    steps: stepReports,
    execution: buildReplayExecutionSurface({
      inferenceSkipped: deterministicGate.inference_skipped,
      deterministicGateMatched: deterministicGate.matched,
      executionBackend,
      localExecutorEnabled: localExecutor?.enabled === true,
      sandboxExecutorAvailable: typeof opts.sandboxExecutor === "function",
      sandboxProjectId,
      workdir,
      timeoutMs,
      stdioMaxBytes,
      allowedCommands: [...allowedCommands.values()],
      autoConfirm,
      stopOnFailure,
      recordRun,
      sensitiveReviewMode,
      allowSensitiveExec,
      guidedRepairStrategy,
      guidedRepairMaxErrorChars,
    }),
    params_echo: parsed.params ?? {},
    usage: usageOut,
    cost_signals: buildReplayCostSignals({ deterministic_gate: deterministicGate }),
  };
}
