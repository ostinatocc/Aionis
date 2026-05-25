import type { EmbeddingProvider } from "../embeddings/types.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  mergeExecutionContractsWithActionSurface,
  parseExecutionContract,
  type ExecutionContractV1,
} from "./execution-contract.js";
import { recoverHandoff } from "./handoff.js";
import { buildContinuityReviewPackLite, buildEvolutionReviewPackLite } from "./reviewer-packs.js";
import {
  AgentMemoryInspectRequest,
  AgentMemoryInspectResponseSchema,
  AgentMemoryReviewPackResponseSchema,
  AgentMemoryResumePackResponseSchema,
  AgentMemoryHandoffPackResponseSchema,
  type AgentMemoryInspectInput,
  type AgentMemoryInspectResponse,
  type AgentMemoryHandoffPackResponse,
  type AgentMemoryReviewPackResponse,
  type AgentMemoryResumePackResponse,
} from "./schemas.js";

export type AgentMemoryInspectLiteArgs = {
  liteWriteStore: LiteWriteStore;
  liteRecallAccess: RecallStoreAccess;
  embedder: EmbeddingProvider | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  defaultActorId?: string | null;
  executionStateStore?: ExecutionStateStore | null;
};

type AgentMemoryRecoveredContinuity = Record<string, unknown> | null;

export type AgentMemoryInspectBuildContext = {
  inspect?: Promise<AgentMemoryInspectResponse>;
  reviewPack?: Promise<AgentMemoryReviewPackResponse>;
  resumePack?: Promise<AgentMemoryResumePackResponse>;
  handoffPack?: Promise<AgentMemoryHandoffPackResponse>;
  recoveredContinuity?: Promise<AgentMemoryRecoveredContinuity>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function mergeContractsInOrder(contracts: Array<ExecutionContractV1 | null>): ExecutionContractV1 | null {
  let current: ExecutionContractV1 | null = null;
  for (const contract of contracts) {
    if (!contract) continue;
    if (!current) {
      current = contract;
      continue;
    }
    current = mergeExecutionContractsWithActionSurface({
      existing: current,
      incoming: contract,
      preference: "incoming",
    });
  }
  return current;
}

function getOrCreateContextValue<TKey extends keyof AgentMemoryInspectBuildContext>(
  ctx: AgentMemoryInspectBuildContext | undefined,
  key: TKey,
  factory: () => NonNullable<AgentMemoryInspectBuildContext[TKey]>,
): NonNullable<AgentMemoryInspectBuildContext[TKey]> {
  if (!ctx) return factory();
  const existing = ctx[key];
  if (existing) return existing as NonNullable<AgentMemoryInspectBuildContext[TKey]>;
  const created = factory();
  ctx[key] = created;
  return created;
}

function readPolicyLearningControlApplyPayload(
  inspect: AgentMemoryInspectResponse | { evolution_inspect?: Record<string, unknown> | null; evolution_review_pack?: Record<string, unknown> | null; policy_learning_control_apply_payload?: unknown },
) {
  const direct = asRecord((inspect as { policy_learning_control_apply_payload?: unknown }).policy_learning_control_apply_payload);
  if (direct) return direct;
  const fromReview = asRecord(asRecord((inspect as { evolution_review_pack?: unknown }).evolution_review_pack)?.policy_learning_control_apply_payload);
  if (fromReview) return fromReview;
  return asRecord(asRecord((inspect as { evolution_inspect?: unknown }).evolution_inspect)?.policy_learning_control_apply_payload);
}

function readPolicyLearningControlApplyResult(
  inspect: AgentMemoryInspectResponse | { evolution_inspect?: Record<string, unknown> | null; evolution_review_pack?: Record<string, unknown> | null; policy_learning_control_apply_result?: unknown },
) {
  const direct = asRecord((inspect as { policy_learning_control_apply_result?: unknown }).policy_learning_control_apply_result);
  if (direct) return direct;
  const fromReview = asRecord(asRecord((inspect as { evolution_review_pack?: unknown }).evolution_review_pack)?.policy_learning_control_apply_result);
  if (fromReview) return fromReview;
  return asRecord(asRecord((inspect as { evolution_inspect?: unknown }).evolution_inspect)?.policy_learning_control_apply_result);
}

function supportsContinuityInspect(parsed: AgentMemoryInspectInput) {
  return !!parsed.handoff_id
    || !!parsed.handoff_uri
    || !!parsed.anchor
    || !!parsed.repo_root
    || !!parsed.file_path
    || !!parsed.symbol;
}

function hasExplicitContinuityLocator(parsed: AgentMemoryInspectInput) {
  return !!parsed.handoff_id || !!parsed.handoff_uri || !!parsed.anchor;
}

function isHandoffNotFoundError(error: unknown) {
  return !!error
    && typeof error === "object"
    && (
      (error as { code?: unknown }).code === "handoff_not_found"
      || (error as { statusCode?: unknown }).statusCode === 404
    );
}

async function buildRecoveredContinuityLiteInner(
  args: AgentMemoryInspectLiteArgs,
): Promise<AgentMemoryRecoveredContinuity> {
  const parsed = AgentMemoryInspectRequest.parse(args.body) as AgentMemoryInspectInput;
  if (!supportsContinuityInspect(parsed)) return null;
  try {
    return await recoverHandoff({
      liteWriteStore: args.liteWriteStore,
      executionStateStore: args.executionStateStore ?? null,
      input: parsed,
      defaultScope: args.defaultScope,
      defaultTenantId: args.defaultTenantId,
      consumerAgentId: parsed.consumer_agent_id ?? null,
      consumerTeamId: parsed.consumer_team_id ?? null,
    }) as Record<string, unknown>;
  } catch (error) {
    if (!hasExplicitContinuityLocator(parsed) && isHandoffNotFoundError(error)) return null;
    throw error;
  }
}

async function readRecoveredContinuityLite(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryRecoveredContinuity> {
  return getOrCreateContextValue(ctx, "recoveredContinuity", () => buildRecoveredContinuityLiteInner(args));
}

async function buildAgentMemoryInspectLiteInner(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryInspectResponse> {
  const parsed = AgentMemoryInspectRequest.parse(args.body) as AgentMemoryInspectInput;
  const evolutionReviewPack = await buildEvolutionReviewPackLite({
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallAccess,
    embedder: args.embedder,
    body: parsed,
    defaultScope: args.defaultScope,
    defaultTenantId: args.defaultTenantId,
    defaultActorId: args.defaultActorId ?? null,
  });

  const continuityAvailable = supportsContinuityInspect(parsed);
  const continuityReviewPack = continuityAvailable
    ? await (async () => {
        try {
          return await buildContinuityReviewPackLite({
            liteWriteStore: args.liteWriteStore,
            body: parsed,
            defaultScope: args.defaultScope,
            defaultTenantId: args.defaultTenantId,
            consumerAgentId: parsed.consumer_agent_id ?? null,
            consumerTeamId: parsed.consumer_team_id ?? null,
            executionStateStore: args.executionStateStore ?? null,
          });
        } catch (error) {
          if (!hasExplicitContinuityLocator(parsed) && isHandoffNotFoundError(error)) return null;
          throw error;
        }
      })()
    : null;
  const recoveredContinuity = continuityAvailable ? await readRecoveredContinuityLite(args, ctx) : null;

  const continuityInspect = continuityReviewPack?.continuity_inspect ?? null;
  const continuityPack = continuityReviewPack?.continuity_review_pack ?? null;
  const evolutionInspect = evolutionReviewPack.evolution_inspect;
  const evolutionPack = evolutionReviewPack.evolution_review_pack;
  const derivedPolicy = evolutionInspect.derived_policy ?? evolutionPack.derived_policy ?? null;
  const policyContract = evolutionInspect.policy_contract ?? evolutionPack.policy_contract ?? null;
  const policyReview = evolutionInspect.policy_review ?? evolutionPack.policy_review;
  const policyLearningControlContract =
    evolutionInspect.policy_learning_control_contract
    ?? evolutionPack.policy_learning_control_contract;
  const policyLearningControlApplyPayload =
    evolutionInspect.policy_learning_control_apply_payload
    ?? evolutionPack.policy_learning_control_apply_payload
    ?? null;
  const policyLearningControlApplyResult =
    evolutionInspect.policy_learning_control_apply_result
    ?? evolutionPack.policy_learning_control_apply_result
    ?? null;

  const handoffRelatedItems = continuityPack?.latest_handoff ? 1 : 0;
  const resumeRelatedItems = continuityPack?.latest_resume ? 1 : 0;
  const recoveredExecutionReady = asRecord(recoveredContinuity?.execution_ready_handoff);

  return AgentMemoryInspectResponseSchema.parse({
    summary_version: "agent_memory_inspect_v1",
    tenant_id: evolutionReviewPack.tenant_id,
    scope: evolutionReviewPack.scope,
    query_text: evolutionReviewPack.query_text,
    continuity_inspect: continuityInspect,
    continuity_review_pack: continuityPack,
    evolution_inspect: evolutionInspect,
    evolution_review_pack: evolutionPack,
    derived_policy: derivedPolicy,
    policy_contract: policyContract,
    policy_review: policyReview,
    policy_learning_control_contract: policyLearningControlContract,
    policy_learning_control_apply_payload: policyLearningControlApplyPayload,
    policy_learning_control_apply_result: policyLearningControlApplyResult,
    agent_memory_summary: {
      summary_version: "agent_memory_inspect_summary_v1",
      has_continuity: continuityAvailable && !!continuityPack,
      latest_handoff_anchor: continuityPack?.latest_handoff?.anchor ?? null,
      latest_resume_source_kind: continuityPack?.latest_resume?.source_kind ?? null,
      selected_tool: evolutionInspect.evolution_summary.selected_tool,
      recommended_file_path:
        evolutionInspect.evolution_summary.recommended_file_path
        ?? firstString(recoveredExecutionReady?.file_path),
      recommended_next_action:
        evolutionInspect.evolution_summary.recommended_next_action
        ?? firstString(recoveredExecutionReady?.next_action),
      history_applied: evolutionInspect.evolution_summary.history_applied,
      stable_workflow_count: evolutionInspect.evolution_summary.stable_workflow_count,
      promotion_ready_workflow_count: evolutionInspect.evolution_summary.promotion_ready_workflow_count,
      trusted_pattern_count: evolutionInspect.evolution_summary.trusted_pattern_count,
      suppressed_pattern_count: evolutionInspect.evolution_summary.suppressed_pattern_count,
      distilled_evidence_count: evolutionInspect.evolution_summary.distilled_evidence_count,
      distilled_fact_count: evolutionInspect.evolution_summary.distilled_fact_count,
      handoff_related_items: handoffRelatedItems,
      resume_related_items: resumeRelatedItems,
      derived_policy_source_kind: derivedPolicy?.source_kind ?? null,
      derived_policy_selected_tool: derivedPolicy?.selected_tool ?? null,
      derived_policy_state: derivedPolicy?.policy_state ?? null,
      policy_activation_mode: policyContract?.activation_mode ?? null,
      policy_review_recommended: policyReview.review_recommended,
      active_policy_count: policyReview.active_policy_count,
      contested_policy_count: policyReview.contested_policy_count,
      retired_policy_count: policyReview.retired_policy_count,
      selected_policy_memory_state: policyReview.selected_policy_memory_state,
      policy_learning_control_action: policyLearningControlContract.action,
      policy_learning_control_review_required: policyLearningControlContract.review_required,
      policy_learning_control_apply_payload: policyLearningControlApplyPayload,
      policy_learning_control_auto_applied: policyLearningControlApplyResult?.ok === true,
    },
  });
}

export async function buildAgentMemoryInspectLite(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryInspectResponse> {
  return getOrCreateContextValue(ctx, "inspect", () => buildAgentMemoryInspectLiteInner(args, ctx));
}

export async function buildAgentMemoryReviewPackLite(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryReviewPackResponse> {
  return getOrCreateContextValue(ctx, "reviewPack", async () => {
    const inspect = await buildAgentMemoryInspectLite(args, ctx);
    const continuityPack = inspect.continuity_review_pack;
    const continuityContract = continuityPack?.review_contract ?? null;
    const evolutionContract = inspect.evolution_review_pack.review_contract;
    const packExecutionContract = mergeContractsInOrder([
      parseExecutionContract(evolutionContract.execution_contract_v1),
      parseExecutionContract(continuityContract?.execution_contract_v1),
    ]);
    const summary = inspect.agent_memory_summary;
    const derivedPolicy = inspect.derived_policy ?? inspect.evolution_review_pack.derived_policy ?? inspect.evolution_inspect.derived_policy ?? null;
    const policyContract = inspect.policy_contract ?? inspect.evolution_review_pack.policy_contract ?? inspect.evolution_inspect.policy_contract ?? null;
    const policyReview = inspect.policy_review ?? inspect.evolution_review_pack.policy_review ?? inspect.evolution_inspect.policy_review;
    const policyLearningControlContract =
      inspect.policy_learning_control_contract
      ?? inspect.evolution_review_pack.policy_learning_control_contract
      ?? inspect.evolution_inspect.policy_learning_control_contract;
    const policyLearningControlApplyPayload = readPolicyLearningControlApplyPayload(inspect);
    const policyLearningControlApplyResult = readPolicyLearningControlApplyResult(inspect);

    return AgentMemoryReviewPackResponseSchema.parse({
      summary_version: "agent_memory_review_pack_v1",
      tenant_id: inspect.tenant_id,
      scope: inspect.scope,
      query_text: inspect.query_text,
      agent_memory_inspect: inspect,
      agent_memory_review_pack: {
        pack_version: "agent_memory_review_pack_v1",
        execution_contract_v1: packExecutionContract,
        selected_tool: firstString(packExecutionContract?.selected_tool, evolutionContract.selected_tool),
        recommended_file_path: firstString(packExecutionContract?.file_path, evolutionContract.file_path, summary.recommended_file_path),
        recommended_next_action: firstString(packExecutionContract?.next_action, evolutionContract.next_action, summary.recommended_next_action),
        latest_handoff_anchor: summary.latest_handoff_anchor,
        latest_resume_source_kind: summary.latest_resume_source_kind,
        stable_workflow_anchor_id: evolutionContract.stable_workflow_anchor_id,
        promotion_ready_anchor_ids: evolutionContract.promotion_ready_anchor_ids,
        trusted_pattern_anchor_ids: evolutionContract.trusted_pattern_anchor_ids,
        contested_pattern_anchor_ids: evolutionContract.contested_pattern_anchor_ids,
        suppressed_pattern_anchor_ids: evolutionContract.suppressed_pattern_anchor_ids,
        handoff_target_files:
          Array.isArray(packExecutionContract?.target_files) && packExecutionContract.target_files.length > 0
            ? packExecutionContract.target_files
            : Array.isArray(continuityContract?.target_files)
              ? continuityContract.target_files
              : [],
        acceptance_checks:
          Array.isArray(packExecutionContract?.outcome.acceptance_checks) && packExecutionContract.outcome.acceptance_checks.length > 0
            ? packExecutionContract.outcome.acceptance_checks
            : Array.isArray(continuityContract?.acceptance_checks)
              ? continuityContract.acceptance_checks
              : [],
        must_change: Array.isArray(continuityContract?.must_change) ? continuityContract.must_change : [],
        must_remove: Array.isArray(continuityContract?.must_remove) ? continuityContract.must_remove : [],
        must_keep: Array.isArray(continuityContract?.must_keep) ? continuityContract.must_keep : [],
        rollback_required: continuityContract?.rollback_required === true,
        derived_policy: derivedPolicy,
        policy_contract: policyContract,
        policy_review: policyReview,
        policy_learning_control_contract: policyLearningControlContract,
        policy_learning_control_apply_payload: policyLearningControlApplyPayload,
        policy_learning_control_apply_result: policyLearningControlApplyResult,
      },
    });
  });
}

export async function buildAgentMemoryResumePackLite(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryResumePackResponse> {
  return getOrCreateContextValue(ctx, "resumePack", async () => {
    const inspect = await buildAgentMemoryInspectLite(args, ctx);
    const recoveredContinuity = await readRecoveredContinuityLite(args, ctx);
    const continuityPack = inspect.continuity_review_pack;
    const continuityContract = continuityPack?.review_contract ?? null;
    const recoveredHandoff = recoveredContinuity;
    const handoffData = asRecord(recoveredContinuity?.handoff);
    const executionReadyHandoff = asRecord(recoveredContinuity?.execution_ready_handoff);
    const evolutionContract = inspect.evolution_review_pack.review_contract;
    const packExecutionContract = mergeContractsInOrder([
      parseExecutionContract(evolutionContract.execution_contract_v1),
      parseExecutionContract(continuityContract?.execution_contract_v1),
      parseExecutionContract(recoveredContinuity?.execution_contract_v1),
    ]);
    const summary = inspect.agent_memory_summary;
    const derivedPolicy = inspect.derived_policy ?? inspect.evolution_review_pack.derived_policy ?? inspect.evolution_inspect.derived_policy ?? null;
    const policyContract = inspect.policy_contract ?? inspect.evolution_review_pack.policy_contract ?? inspect.evolution_inspect.policy_contract ?? null;
    const policyLearningControlApplyPayload = readPolicyLearningControlApplyPayload(inspect);
    const policyLearningControlApplyResult = readPolicyLearningControlApplyResult(inspect);

    return AgentMemoryResumePackResponseSchema.parse({
      summary_version: "agent_memory_resume_pack_v1",
      tenant_id: inspect.tenant_id,
      scope: inspect.scope,
      query_text: inspect.query_text,
      agent_memory_inspect: inspect,
      agent_memory_resume_pack: {
        pack_version: "agent_memory_resume_pack_v1",
        execution_contract_v1: packExecutionContract,
        latest_handoff_anchor: summary.latest_handoff_anchor,
        latest_resume_source_kind: summary.latest_resume_source_kind,
        resume_selected_tool: firstString(packExecutionContract?.selected_tool, evolutionContract.selected_tool),
        resume_file_path:
          packExecutionContract?.file_path
          ?? firstString(executionReadyHandoff?.file_path)
          ?? firstString(handoffData?.file_path)
          ?? evolutionContract.file_path
          ?? summary.recommended_file_path,
        resume_target_files:
          Array.isArray(packExecutionContract?.target_files) && packExecutionContract.target_files.length > 0
            ? packExecutionContract.target_files
            : Array.isArray(continuityContract?.target_files) && continuityContract.target_files.length > 0
            ? continuityContract.target_files
            : evolutionContract.target_files,
        resume_next_action:
          packExecutionContract?.next_action
          ?? continuityContract?.next_action
          ?? firstString(executionReadyHandoff?.next_action)
          ?? firstString(handoffData?.next_action)
          ?? evolutionContract.next_action
          ?? summary.recommended_next_action,
        stable_workflow_anchor_id: evolutionContract.stable_workflow_anchor_id,
        promotion_ready_anchor_ids: evolutionContract.promotion_ready_anchor_ids,
        trusted_pattern_anchor_ids: evolutionContract.trusted_pattern_anchor_ids,
        suppressed_pattern_anchor_ids: evolutionContract.suppressed_pattern_anchor_ids,
        rollback_required: continuityContract?.rollback_required === true,
        recovered_handoff: recoveredHandoff,
        execution_ready_handoff: executionReadyHandoff,
        derived_policy: derivedPolicy,
        policy_contract: policyContract,
        policy_learning_control_apply_payload: policyLearningControlApplyPayload,
        policy_learning_control_apply_result: policyLearningControlApplyResult,
      },
    });
  });
}

export async function buildAgentMemoryHandoffPackLite(
  args: AgentMemoryInspectLiteArgs,
  ctx?: AgentMemoryInspectBuildContext,
): Promise<AgentMemoryHandoffPackResponse> {
  return getOrCreateContextValue(ctx, "handoffPack", async () => {
    const inspect = await buildAgentMemoryInspectLite(args, ctx);
    const recoveredContinuity = await readRecoveredContinuityLite(args, ctx);
    const continuityPack = inspect.continuity_review_pack;
    const latestHandoff = continuityPack?.latest_handoff ?? null;
    const continuityContract = continuityPack?.review_contract ?? null;
    const recoveredHandoff = recoveredContinuity;
    const executionReadyHandoff = asRecord(recoveredContinuity?.execution_ready_handoff);
    const handoffData = asRecord(recoveredContinuity?.handoff);
    const evolutionContract = inspect.evolution_review_pack.review_contract;
    const packExecutionContract = mergeContractsInOrder([
      parseExecutionContract(evolutionContract.execution_contract_v1),
      parseExecutionContract(continuityContract?.execution_contract_v1),
      parseExecutionContract(recoveredContinuity?.execution_contract_v1),
    ]);
    const derivedPolicy = inspect.derived_policy ?? inspect.evolution_review_pack.derived_policy ?? inspect.evolution_inspect.derived_policy ?? null;
    const policyContract = inspect.policy_contract ?? inspect.evolution_review_pack.policy_contract ?? inspect.evolution_inspect.policy_contract ?? null;
    const policyLearningControlApplyPayload = readPolicyLearningControlApplyPayload(inspect);
    const policyLearningControlApplyResult = readPolicyLearningControlApplyResult(inspect);

    return AgentMemoryHandoffPackResponseSchema.parse({
      summary_version: "agent_memory_handoff_pack_v1",
      tenant_id: inspect.tenant_id,
      scope: inspect.scope,
      query_text: inspect.query_text,
      agent_memory_inspect: inspect,
      agent_memory_handoff_pack: {
        pack_version: "agent_memory_handoff_pack_v1",
        execution_contract_v1: packExecutionContract,
        latest_handoff_anchor: inspect.agent_memory_summary.latest_handoff_anchor,
        handoff_kind:
          latestHandoff?.handoff_kind
          ?? firstString(handoffData?.handoff_kind)
          ?? null,
        handoff_file_path:
          packExecutionContract?.file_path
          ?? latestHandoff?.file_path
          ?? firstString(executionReadyHandoff?.file_path)
          ?? firstString(handoffData?.file_path)
          ?? evolutionContract.file_path
          ?? null,
        handoff_repo_root:
          latestHandoff?.repo_root
          ?? firstString(handoffData?.repo_root)
          ?? null,
        handoff_symbol:
          latestHandoff?.symbol
          ?? firstString(handoffData?.symbol)
          ?? null,
        handoff_target_files:
          Array.isArray(packExecutionContract?.target_files) && packExecutionContract.target_files.length > 0
            ? packExecutionContract.target_files
            : Array.isArray(continuityContract?.target_files) && continuityContract.target_files.length > 0
            ? continuityContract.target_files
            : evolutionContract.target_files,
        handoff_next_action:
          packExecutionContract?.next_action
          ?? continuityContract?.next_action
          ?? latestHandoff?.next_action
          ?? firstString(executionReadyHandoff?.next_action)
          ?? firstString(handoffData?.next_action)
          ?? evolutionContract.next_action
          ?? null,
        acceptance_checks:
          Array.isArray(packExecutionContract?.outcome.acceptance_checks) && packExecutionContract.outcome.acceptance_checks.length > 0
            ? packExecutionContract.outcome.acceptance_checks
            : Array.isArray(continuityContract?.acceptance_checks)
              ? continuityContract.acceptance_checks
              : [],
        must_change: Array.isArray(continuityContract?.must_change) ? continuityContract.must_change : [],
        must_remove: Array.isArray(continuityContract?.must_remove) ? continuityContract.must_remove : [],
        must_keep: Array.isArray(continuityContract?.must_keep) ? continuityContract.must_keep : [],
        rollback_required: continuityContract?.rollback_required === true,
        stable_workflow_anchor_id: evolutionContract.stable_workflow_anchor_id,
        trusted_pattern_anchor_ids: evolutionContract.trusted_pattern_anchor_ids,
        suppressed_pattern_anchor_ids: evolutionContract.suppressed_pattern_anchor_ids,
        recovered_handoff: recoveredHandoff,
        execution_ready_handoff: executionReadyHandoff,
        derived_policy: derivedPolicy,
        policy_contract: policyContract,
        policy_learning_control_apply_payload: policyLearningControlApplyPayload,
        policy_learning_control_apply_result: policyLearningControlApplyResult,
      },
    });
  });
}
