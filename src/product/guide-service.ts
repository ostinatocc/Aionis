import { randomUUID } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import { z } from "zod";

import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";

import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import {
  loadCurrentExecutionStateHeadV2,
  synchronizeCurrentExecutionStateHeadV2,
} from "../execution/current-execution-state.js";
import type { ExecutionStateStore } from "../execution/state-store.js";
import {
  DecisionCommittedReceiptV1Schema,
  decisionCommittedReceiptDigest,
  type DecisionCommittedReceiptV1,
} from "../memory/execution-episode.js";

import {
  buildAionisMemoryPacket,
} from "../memory/product-output/memory-packet.js";

import {
  AionisAgentRoleSchema,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisMemoryPacket,
} from "../memory/runtime-product-contract.js";

import type {
  RecallCandidate,
  RecallStoreAccess,
} from "../store/recall-access.js";

import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { LiteExecutionEpisodeStore } from
  "../store/lite-execution-episode-store.js";
import type { LiteEvidenceArtifactStore } from
  "../store/lite-evidence-artifact-store.js";

import {
  buildAionisAgentContext,
} from "../memory/agent-context-compiler.js";
import {
  compileHostCurrentExecutionStateContextV1,
} from "../memory/host-current-execution-state.js";

import { resolveTenantScope } from "../memory/tenant.js";

import {
  ProductGuideExposureLedger,
  ProductGuideRequest,
  objectValue,
  stripUndefined,
  uniqueStrings,
} from "./product-services.js";

import type {
  ProductGuideInput,
  ProductServiceResult,
  ProductServices,
} from "./product-services.js";

import {
  productServiceDependencyFailure,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
} from "./product-services.js";

const PRODUCT_GUIDE_RECALL_LIMIT = 24;

function productGuideAgentRole(parsed: z.infer<typeof ProductGuideRequest>): AionisAgentRole {
  if (parsed.agent_role) return parsed.agent_role;
  const context = objectValue(parsed.context);
  const contextRole = context?.agent_role;
  const parsedContextRole = AionisAgentRoleSchema.safeParse(contextRole);
  return parsedContextRole.success ? parsedContextRole.data : "agent";
}

function productGuideMemoryContractVisible(memoryPacket: AionisMemoryPacket | null): boolean {
  return memoryPacket?.relevant_memories.some((entry) => !!entry.memory_contract) === true;
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function nestedStringField(value: unknown, key: string): string | null {
  const record = objectValue(value);
  return firstStringValue(record?.[key]);
}

function productGuideExecutionSignatures(parsed: z.infer<typeof ProductGuideRequest>): {
  taskSignature: string | null;
  taskFamily: string | null;
  workflowSignature: string | null;
} {
  const context = objectValue(parsed.context);
  return {
    taskSignature: firstStringValue(
      context?.task_signature,
      nestedStringField(parsed.execution_packet_v1, "task_signature"),
      nestedStringField(parsed.execution_state_v1, "task_signature"),
    ),
    taskFamily: firstStringValue(
      context?.task_family,
      nestedStringField(parsed.execution_packet_v1, "task_family"),
      nestedStringField(parsed.execution_state_v1, "task_family"),
    ),
    workflowSignature: firstStringValue(
      context?.workflow_signature,
      nestedStringField(parsed.execution_packet_v1, "workflow_signature"),
      nestedStringField(parsed.execution_state_v1, "workflow_signature"),
    ),
  };
}

async function buildProductGuideMemoryPacket(args: {
  parsed: ProductGuideInput;
  tenantId: string;
  publicScope: string;
  storeScope: string;
  recallAccess: RecallStoreAccess | null;
  queryEmbedder: EmbeddingProvider | null;
}): Promise<{
  packet: AionisMemoryPacket | null;
  embeddingUnavailable: boolean;
}> {
  if (!args.recallAccess) {
    return { packet: null, embeddingUnavailable: true };
  }
  const queryProvider = args.queryEmbedder;
  let queryEmbedding: number[] | null = null;
  let embeddingUnavailable = queryProvider === null;
  if (queryProvider) {
    try {
      queryEmbedding = (await queryProvider.embed([args.parsed.query_text]))[0]
        ?? null;
      embeddingUnavailable = queryEmbedding === null;
    } catch {
      embeddingUnavailable = true;
    }
  }
  const signatures = productGuideExecutionSignatures(args.parsed);
  const candidates = await args.recallAccess.stage1HybridCandidates({
    scope: args.storeScope,
    limit: PRODUCT_GUIDE_RECALL_LIMIT,
    queryEmbedding,
    queryText: args.parsed.query_text,
    structured: {
      taskSignature: signatures.taskSignature,
      taskFamily: signatures.taskFamily,
      workflowSignature: signatures.workflowSignature,
    },
    allowedTiers: ["hot", "warm", "cold", "archive"],
    consumerAgentId: args.parsed.consumer_agent_id ?? null,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
  });
  if (candidates.length === 0) {
    return {
      packet: buildAionisMemoryPacket({
        tenant_id: args.tenantId,
        scope: args.publicScope,
        actor: {
          consumer_agent_id: args.parsed.consumer_agent_id ?? null,
          consumer_team_id: args.parsed.consumer_team_id ?? null,
          producer_agent_ids: [],
        },
        query: {
          source: queryEmbedding ? "embedding" : "text",
          intent: args.parsed.query_text,
          embedding_dims: queryEmbedding?.length ?? null,
        },
        nodes: [],
        source_map: {
          routes_used: ["/v1/guide"],
          internal_surfaces_used: ["recall"],
        },
      }),
      embeddingUnavailable,
    };
  }
  const candidateIds = candidates.map((candidate) => candidate.id);
  const fetchedNodes = await args.recallAccess.stage2Nodes({
    scope: args.storeScope,
    nodeIds: candidateIds,
    consumerAgentId: args.parsed.consumer_agent_id ?? null,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
    includeSlots: true,
  });
  const nodesById = new Map(fetchedNodes.map((node) => [node.id, node]));
  const nodes = candidateIds.flatMap((id) => {
    const node = nodesById.get(id);
    return node ? [node] : [];
  });
  const edges = await args.recallAccess.stage2Edges({
    scope: args.storeScope,
    seedIds: candidateIds,
    neighborhoodHops: 1,
    minEdgeWeight: 0,
    minEdgeConfidence: 0,
    hop1Budget: 128,
    hop2Budget: 0,
    edgeFetchBudget: 128,
  });
  const recallSources = Object.fromEntries(
    candidates.map((candidate: RecallCandidate) => [
      candidate.id,
      candidate.sources ?? [],
    ]),
  );
  return {
    packet: buildAionisMemoryPacket({
      tenant_id: args.tenantId,
      scope: args.publicScope,
      actor: {
        consumer_agent_id: args.parsed.consumer_agent_id ?? null,
        consumer_team_id: args.parsed.consumer_team_id ?? null,
        producer_agent_ids: uniqueStrings(
          nodes.map((node) => node.producer_agent_id ?? ""),
        ),
      },
      query: {
        source: queryEmbedding ? "embedding" : "text",
        intent: args.parsed.query_text,
        embedding_dims: queryEmbedding?.length ?? null,
      },
      nodes,
      ranked: candidates.map((candidate) => ({
        id: candidate.id,
        score: candidate.similarity,
      })),
      recall_sources_by_memory_id: recallSources,
      lifecycle_edges: edges,
      source_map: {
        routes_used: ["/v1/guide"],
        internal_surfaces_used: ["recall"],
      },
    }),
    embeddingUnavailable,
  };
}

function buildGuideTraceId(): string {
  return `guide_trace:${randomUUID()}`;
}

function buildGuideExposureLedger(args: {
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): ProductGuideExposureLedger {
  const feedbackIdentity = guideLearningExposureIdentity({
    tenantId: args.tenant_id,
    scope: args.scope,
    guideTraceId: args.guideTraceId,
  });
  const hostTaskEnvelope = args.parsed.host_task_envelope_v1 ?? null;
  const contextRecord = objectValue(args.parsed.context);
  const stableTaskBinding = {
    run_id: args.parsed.run_id ?? null,
    task_id: nestedStringField(contextRecord, "task_id"),
    task_signature: nestedStringField(contextRecord, "task_signature")
      ?? nestedStringField(args.parsed.execution_packet_v1, "task_signature")
      ?? nestedStringField(args.parsed.execution_state_v1, "task_signature"),
    execution_state_id: nestedStringField(args.parsed.execution_packet_v1, "state_id")
      ?? nestedStringField(args.parsed.execution_state_v1, "state_id"),
    query_sha256: sha256Hex(args.parsed.query_text),
  };
  return {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: args.guideTraceId,
    feedback_episode_id: feedbackIdentity.episodeId,
    feedback_exposure_event_id: feedbackIdentity.eventId,
    tenant_id: args.tenant_id,
    scope: args.scope,
    run_id: args.parsed.run_id ?? null,
    consumer_agent_id: args.parsed.consumer_agent_id ?? null,
    consumer_team_id: args.parsed.consumer_team_id ?? null,
    host_task_id: hostTaskEnvelope?.host_task_id ?? null,
    host_task_envelope_sha256: hostTaskEnvelope
      ? sha256Hex(stableStringify(hostTaskEnvelope))
      : null,
    collector_id: hostTaskEnvelope?.collector_id ?? null,
    collector_version: hostTaskEnvelope?.collector_version ?? null,
    query_sha256: sha256Hex(args.parsed.query_text),
    context_sha256: sha256Hex(stableStringify(args.parsed.context ?? {})),
    task_binding_sha256: sha256Hex(stableStringify(stableTaskBinding)),
    memory_ids: args.agentContext.memory_ids,
    use_now_memory_ids: args.agentContext.use_now_memory_ids,
    inspect_before_use_memory_ids: args.agentContext.inspect_before_use_memory_ids,
    do_not_use_memory_ids: args.agentContext.do_not_use_memory_ids,
    rehydrate_memory_ids: args.agentContext.rehydrate_hints.map((hint) => hint.memory_id),
    prompt_char_count: args.agentContext.prompt_text.length,
    history_used: args.agentContext.history_used,
    actionable_history_used: args.agentContext.actionable_history_used,
    recommended_posture: args.agentContext.recommended_posture,
    authority: args.agentContext.authority,
  };
}

const PRODUCT_GUIDE_OPERATION_KIND = "product_guide_v1";
const PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

const ProductGuideExecutionEpisodeLinkLegacyV1Schema = z.object({
  contract_version:
    z.literal("aionis_guide_execution_episode_link_v1"),
  scoring_status: z.literal("truth_bound"),
  training_eligible: z.literal(false),
  training_ineligibility_reason:
    z.literal("phase1_intervention_contract_incomplete"),
  episode_id: z.string().trim().min(1).max(256),
  decision_id: z.string().trim().min(1).max(256),
  decision_digest: z.string().regex(/^[0-9a-f]{64}$/),
  decision_event_id: z.string().trim().min(1).max(256),
  target_state_snapshot_id: z.string().trim().min(1).max(256),
}).strict();

const ProductGuideExecutionEpisodeLinkV2Schema = z.object({
  contract_version:
    z.literal("aionis_guide_execution_episode_link_v2"),
  scoring_status: z.literal("truth_bound"),
  l1_projection_contract: z.literal("canonical_l1_episode_v1"),
  l1_projection_status: z.literal("pending_episode_close"),
  training_eligible: z.literal(false),
  training_ineligibility_reason:
    z.literal("episode_outcome_pending"),
  episode_id: z.string().trim().min(1).max(256),
  decision_id: z.string().trim().min(1).max(256),
  decision_digest: z.string().regex(/^[0-9a-f]{64}$/),
  decision_event_id: z.string().trim().min(1).max(256),
  target_state_snapshot_id: z.string().trim().min(1).max(256),
}).strict();

const ProductGuideExecutionEpisodeLinkV1Schema = z.union([
  ProductGuideExecutionEpisodeLinkLegacyV1Schema,
  ProductGuideExecutionEpisodeLinkV2Schema,
]);

type ProductGuideExecutionEpisodeLinkV1 = z.infer<
  typeof ProductGuideExecutionEpisodeLinkV1Schema
>;

type ProductGuideOperationIdentity = Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  requestSha256: string;
}>;

function productGuideOperationIdentity(args: {
  parsed: ProductGuideInput;
  tenantId: string;
  scope: string;
}): ProductGuideOperationIdentity | null {
  if (!args.parsed.operation_id) return null;
  return {
    tenantId: args.tenantId,
    scope: args.scope,
    operationId: args.parsed.operation_id,
    requestSha256: productGuideRequestSha256(args),
  };
}

function productGuideRequestSha256(args: {
  parsed: ProductGuideInput;
  tenantId: string;
  scope: string;
}): string {
  const normalizedRequest: Record<string, unknown> = {
    ...args.parsed,
    tenant_id: args.tenantId,
    scope: args.scope,
    context: args.parsed.context ?? {},
  };
  delete normalizedRequest.operation_id;
  return sha256Hex(stableStringify(stripUndefined(normalizedRequest)));
}

function assertProductGuideOperationMatches(args: {
  identity: ProductGuideOperationIdentity;
  storedRequestSha256: string;
}): void {
  if (args.identity.requestSha256 === args.storedRequestSha256) return;
  throw new HttpError(
    409,
    "learning_episode_operation_conflict",
    "operation_id was already used for a different guide request",
    { operation_id: args.identity.operationId },
  );
}

function parseStoredProductGuideOperationResult(args: {
  identity: ProductGuideOperationIdentity;
  receiptJson: string;
  expectedEpisodeId?: string;
  expectedCurrentStateSnapshotId?: string;
}): ProductServiceResult {
  if (Buffer.byteLength(args.receiptJson, "utf8") > PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES) {
    throw new HttpError(500, "protected_guide_receipt_invalid", "stored protected guide receipt is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.receiptJson);
  } catch {
    throw new HttpError(500, "protected_guide_receipt_invalid", "stored protected guide receipt is invalid");
  }
  if (stableStringify(parsed) !== args.receiptJson) {
    throw new HttpError(500, "protected_guide_receipt_invalid", "stored protected guide receipt is not canonical");
  }
  const result = objectValue(parsed);
  const body = objectValue(result?.body);
  if (
    result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== "aionis_guide_result_v1"
    || body.operation_id !== args.identity.operationId
    || body.tenant_id !== args.identity.tenantId
    || body.scope !== args.identity.scope
    || typeof body.guide_trace_id !== "string"
    || body.guide_trace_id.length === 0
  ) {
    throw new HttpError(500, "protected_guide_receipt_invalid", "stored protected guide receipt is invalid");
  }
  if (body.feedback_attribution_v1 !== undefined) {
    try {
      assertStoredGuideFeedbackAttribution({
        value: body.feedback_attribution_v1,
        tenantId: args.identity.tenantId,
        scope: args.identity.scope,
        guideTraceId: body.guide_trace_id,
      });
    } catch {
      throw new HttpError(
        500,
        "protected_guide_receipt_invalid",
        "stored protected guide receipt is invalid",
      );
    }
  }
  const episodeLink = body.execution_episode_v1;
  if (args.expectedEpisodeId === undefined) {
    if (episodeLink !== undefined) {
      throw new HttpError(
        500,
        "protected_guide_receipt_invalid",
        "stored protected guide receipt has an unexpected execution episode",
      );
    }
  } else {
    try {
      const parsedLink =
        ProductGuideExecutionEpisodeLinkV1Schema.parse(episodeLink);
      if (
        parsedLink.episode_id !== args.expectedEpisodeId
        || parsedLink.target_state_snapshot_id
          !== args.expectedCurrentStateSnapshotId
      ) {
        throw new Error("guide execution episode identity mismatch");
      }
    } catch {
      throw new HttpError(
        500,
        "protected_guide_receipt_invalid",
        "stored protected guide receipt has an invalid execution episode link",
      );
    }
  }
  return parsed as ProductServiceResult;
}

export type ProductGuideServiceDependencies = {
  env: Env;
  liteWriteStore: LiteWriteStore;
  liteRecallAccess?: RecallStoreAccess | null;
  queryEmbedder?: EmbeddingProvider | null;
  executionEpisodeStore?: LiteExecutionEpisodeStore | null;
  evidenceArtifactStore?: LiteEvidenceArtifactStore | null;
  executionStateStore?: ExecutionStateStore | null;
};

type GuideExposureAction =
  | "use_now"
  | "inspect_before_use"
  | "do_not_use"
  | "rehydrate";

type GuideExposureItem = Readonly<{
  decision_completeness: "legacy_served_only";
  memory_id: string;
  memory_type: null;
  source_backend: null;
  recorded_action: null;
  candidate_action: null;
  served_action: GuideExposureAction;
  policy_changed: null;
  hard_boundary_preserved: null;
  prior_supported_use_count: null;
  prior_contradicted_use_count: null;
  prior_rehydrate_requested_count: null;
  prior_effect_state: null;
  repeated_negative_posture: null;
  learning_track: "unclassified";
  track_reason: "legacy_unclassified";
}>;

type ProductGuidePersistenceBranch = Readonly<{
  agentContext: AionisAgentContext;
  result: ProductServiceResult;
  receiptJson: string | null;
  exposureItems: readonly GuideExposureItem[];
}>;

function canonicalUtf8Ids(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function guideExposureSurfaceDigest(
  surface: readonly Readonly<{ memory_id: string; action: GuideExposureAction }>[],
): string {
  const ids = surface.map((entry) => entry.memory_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("guide exposure surface contains duplicate memory ids");
  }
  return sha256Hex(stableStringify(
    [...surface].sort((left, right) =>
      Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
    ),
  ));
}

function guideExposureItemSetDigest(
  items: readonly GuideExposureItem[],
): string {
  const ids = items.map((item) => item.memory_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("guide exposure item set contains duplicate memory ids");
  }
  return sha256Hex(stableStringify(
    [...items].sort((left, right) =>
      Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
    ),
  ));
}

function productGuideExposureItems(
  agentContext: AionisAgentContext,
): GuideExposureItem[] {
  const surfaceByMemoryId = new Map<string, "use_now" | "inspect_before_use" | "do_not_use" | "rehydrate">();
  for (const memoryId of agentContext.use_now_memory_ids) {
    surfaceByMemoryId.set(memoryId, "use_now");
  }
  for (const memoryId of agentContext.inspect_before_use_memory_ids) {
    surfaceByMemoryId.set(memoryId, "inspect_before_use");
  }
  for (const memoryId of agentContext.do_not_use_memory_ids) {
    surfaceByMemoryId.set(memoryId, "do_not_use");
  }
  for (const hint of agentContext.rehydrate_hints) {
    surfaceByMemoryId.set(hint.memory_id, "rehydrate");
  }
  return canonicalUtf8Ids([...surfaceByMemoryId.keys()]).map((memoryId) => ({
    decision_completeness: "legacy_served_only" as const,
    memory_id: memoryId,
    memory_type: null,
    source_backend: null,
    recorded_action: null,
    candidate_action: null,
    served_action: surfaceByMemoryId.get(memoryId)!,
    policy_changed: null,
    hard_boundary_preserved: null,
    prior_supported_use_count: null,
    prior_contradicted_use_count: null,
    prior_rehydrate_requested_count: null,
    prior_effect_state: null,
    repeated_negative_posture: null,
    learning_track: "unclassified" as const,
    track_reason: "legacy_unclassified" as const,
  }));
}

function productGuideCandidateSetDigest(
  exposureItems: readonly GuideExposureItem[],
): string {
  return sha256Hex(stableStringify({
    contract_version: "aionis_guide_candidate_set_v1",
    items: [...exposureItems]
      .map((item) => ({
        memory_id: item.memory_id,
        served_action: item.served_action,
      }))
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
      ),
  }));
}

function productGuideDecisionPolicyIdentity(): Readonly<{
  policyId: string;
  policyVersion: string;
  policyArtifactDigest: string;
}> {
  const contract = {
    contract_version: "aionis_runtime_memory_delivery_policy_v1",
    authority: "runtime_agent_context",
  };
  return {
    policyId: "aionis_runtime_memory_delivery",
    policyVersion: "1",
    policyArtifactDigest: sha256Hex(stableStringify(contract)),
  };
}


function productGuideExecutionDecisionOperationId(args: {
  episodeId: string;
  guideOperationId: string;
}): string {
  return `edop_${sha256Hex(stableStringify({
    contract_version: "aionis_guide_execution_decision_operation_v1",
    episode_id: args.episodeId,
    guide_operation_id: args.guideOperationId,
  }))}`;
}

function buildProductGuideExecutionDecision(args: {
  parsed: ProductGuideInput;
  guideTraceId: string;
  guideReceiptDigest: string;
  selected: ProductGuidePersistenceBranch;
  committedAt: string;
}): DecisionCommittedReceiptV1 {
  if (
    !args.parsed.episode_id
    || !args.parsed.expected_current_state_snapshot_id
    || !args.parsed.operation_id
  ) {
    throw new Error("execution episode guide decision identity is incomplete");
  }
  const policy = productGuideDecisionPolicyIdentity();
  const decisionId = `edc_${sha256Hex(stableStringify({
    contract_version: "aionis_guide_execution_decision_identity_v1",
    episode_id: args.parsed.episode_id,
    guide_operation_id: args.parsed.operation_id,
  }))}`;
  const material = {
    contract_version: "decision_committed_receipt_v1" as const,
    episode_id: args.parsed.episode_id,
    decision_id: decisionId,
    target_state_snapshot_id:
      args.parsed.expected_current_state_snapshot_id,
    guide_trace_id: args.guideTraceId,
    guide_receipt_digest: args.guideReceiptDigest,
    treatment_assignment_id: null,
    candidate_set_digest: productGuideCandidateSetDigest(
      args.selected.exposureItems,
    ),
    selected_candidate_ids: canonicalUtf8Ids(
      args.selected.exposureItems.map((item) => item.memory_id),
    ),
    policy_id: policy.policyId,
    policy_version: policy.policyVersion,
    policy_artifact_digest: policy.policyArtifactDigest,
    committed_at: args.committedAt,
  };
  return DecisionCommittedReceiptV1Schema.parse({
    ...material,
    decision_digest: decisionCommittedReceiptDigest(material),
  });
}

async function assertProductGuideExecutionEpisodeBinding(args: {
  store: LiteExecutionEpisodeStore;
  parsed: ProductGuideInput;
  tenantId: string;
  publicScope: string;
  storeScope: string;
}): Promise<void> {
  if (
    !args.parsed.episode_id
    || !args.parsed.expected_current_state_snapshot_id
    || !args.parsed.run_id
  ) {
    throw new HttpError(
      400,
      "execution_episode_guide_identity_incomplete",
      "Execution-episode guide identity is incomplete.",
    );
  }
  const replay = await args.store.getEpisode({
    tenantId: args.tenantId,
    scope: args.storeScope,
    episodeId: args.parsed.episode_id,
  });
  if (!replay) {
    throw new HttpError(
      404,
      "execution_episode_missing",
      "Execution episode was not found.",
    );
  }
  if (
    replay.episode.tenant_id !== args.tenantId
    || replay.episode.public_scope !== args.publicScope
    || replay.episode.store_scope !== args.storeScope
  ) {
    throw new HttpError(
      409,
      "execution_episode_guide_scope_mismatch",
      "Execution episode scope does not match the guide request.",
    );
  }
  if (replay.episode.run_id !== args.parsed.run_id) {
    throw new HttpError(
      409,
      "execution_episode_guide_run_mismatch",
      "Execution episode run does not match the guide request.",
    );
  }
  if (replay.closed) {
    throw new HttpError(
      409,
      "execution_episode_already_closed",
      "Cannot commit a guide decision to a closed execution episode.",
    );
  }
  if (
    replay.current_state_snapshot_id
      !== args.parsed.expected_current_state_snapshot_id
  ) {
    throw new HttpError(
      409,
      "execution_episode_decision_target_state_stale",
      "Guide target state is no longer the execution episode's current state.",
    );
  }
}

async function assertStoredProductGuideExecutionDecision(args: {
  store: LiteExecutionEpisodeStore;
  result: ProductServiceResult;
  tenantId: string;
  publicScope: string;
  storeScope: string;
  runId: string;
  episodeId: string;
  targetStateSnapshotId: string;
}): Promise<void> {
  if (!args.result.ok) {
    throw new Error("stored execution episode guide result is not successful");
  }
  const body = objectValue(args.result.body);
  const link = ProductGuideExecutionEpisodeLinkV1Schema.parse(
    body?.execution_episode_v1,
  );
  const replay = await args.store.getEpisode({
    tenantId: args.tenantId,
    scope: args.storeScope,
    episodeId: args.episodeId,
  });
  const event = replay?.events.find(
    (candidate) => candidate.event_id === link.decision_event_id,
  );
  if (
    !replay
    || replay.episode.public_scope !== args.publicScope
    || replay.episode.store_scope !== args.storeScope
    || replay.episode.run_id !== args.runId
    || link.episode_id !== args.episodeId
    || link.target_state_snapshot_id !== args.targetStateSnapshotId
    || event?.payload.event_kind !== "decision_committed"
    || event.payload.decision.decision_id !== link.decision_id
    || event.payload.decision.decision_digest !== link.decision_digest
    || event.payload.decision.target_state_snapshot_id
      !== link.target_state_snapshot_id
  ) {
    throw new HttpError(
      500,
      "protected_guide_receipt_invalid",
      "stored guide receipt is missing its exact execution decision",
    );
  }
}

type GuideFeedbackAttributionItemV1 = Readonly<{
  memory_id: string;
  served_surface: GuideExposureItem["served_action"];
}>;

type GuideFeedbackAttributionAvailableV1 = Readonly<{
  contract_version: "aionis_guide_feedback_attribution_v1";
  status: "available";
  guide_trace_id: string;
  episode_id: string;
  exposure_event_id: string;
  item_set_sha256: string;
  served_surface_sha256: string;
  projection_complete: boolean;
  projection_incomplete_reason_codes: readonly string[];
  items: readonly GuideFeedbackAttributionItemV1[];
}>;

type GuideFeedbackAttributionUnavailableV1 = Readonly<{
  contract_version: "aionis_guide_feedback_attribution_v1";
  status: "unavailable";
  guide_trace_id: string;
  reason_code: "learning_exposure_not_persisted";
}>;

type GuideFeedbackAttributionV1 =
  | GuideFeedbackAttributionAvailableV1
  | GuideFeedbackAttributionUnavailableV1;

const GuideFeedbackAttributionItemV1Schema = z.object({
  memory_id: z.string().trim().min(1).max(256),
  served_surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "rehydrate"]),
}).strict();

const GuideFeedbackAttributionV1Schema = z.discriminatedUnion("status", [
  z.object({
    contract_version: z.literal("aionis_guide_feedback_attribution_v1"),
    status: z.literal("available"),
    guide_trace_id: z.string().trim().min(1).max(256),
    episode_id: z.string().regex(/^lep_[0-9a-f]{64}$/),
    exposure_event_id: z.string().regex(/^lexposure_[0-9a-f]{64}$/),
    item_set_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    served_surface_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    projection_complete: z.boolean(),
    projection_incomplete_reason_codes: z.array(z.string().trim().min(1).max(120)).max(32),
    items: z.array(GuideFeedbackAttributionItemV1Schema).max(200),
  }).strict(),
  z.object({
    contract_version: z.literal("aionis_guide_feedback_attribution_v1"),
    status: z.literal("unavailable"),
    guide_trace_id: z.string().trim().min(1).max(256),
    reason_code: z.literal("learning_exposure_not_persisted"),
  }).strict(),
]);

function assertStoredGuideFeedbackAttribution(args: {
  value: unknown;
  tenantId: string;
  scope: string;
  guideTraceId: string;
}): void {
  const attribution = GuideFeedbackAttributionV1Schema.parse(args.value);
  if (attribution.guide_trace_id !== args.guideTraceId) {
    throw new Error("guide feedback attribution identity mismatch");
  }
  if (attribution.status === "unavailable") return;
  const identity = guideLearningExposureIdentity({
    tenantId: args.tenantId,
    scope: args.scope,
    guideTraceId: args.guideTraceId,
  });
  if (attribution.episode_id !== identity.episodeId
    || attribution.exposure_event_id !== identity.eventId) {
    throw new Error("guide feedback attribution episode identity mismatch");
  }
  const itemIds = attribution.items.map((item) => item.memory_id);
  const sortedItemIds = [...itemIds].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  if (new Set(itemIds).size !== itemIds.length
    || itemIds.some((memoryId, index) => memoryId !== sortedItemIds[index])) {
    throw new Error("guide feedback attribution items are not canonical");
  }
  if (attribution.served_surface_sha256 !== guideExposureSurfaceDigest(
    attribution.items.map((item) => ({
      memory_id: item.memory_id,
      action: item.served_surface,
    })),
  )) {
    throw new Error("guide feedback attribution surface digest mismatch");
  }
  const canonicalReasons = canonicalFeedbackReasonCodes(
    attribution.projection_incomplete_reason_codes,
  );
  if (canonicalReasons.length !== attribution.projection_incomplete_reason_codes.length
    || canonicalReasons.some(
      (reason, index) => reason !== attribution.projection_incomplete_reason_codes[index],
    )
    || attribution.projection_complete === (canonicalReasons.length > 0)) {
    throw new Error("guide feedback attribution completeness is not canonical");
  }
}

function guideLearningExposureIdentity(args: {
  tenantId: string;
  scope: string;
  guideTraceId: string;
}): { episodeId: string; eventId: string } {
  const identity = {
    tenant_id: args.tenantId,
    scope: args.scope,
    guide_trace_id: args.guideTraceId,
  };
  return {
    episodeId: `lep_${sha256Hex(stableStringify(identity))}`,
    eventId: `lexposure_${sha256Hex(stableStringify(identity))}`,
  };
}

function buildGuideFeedbackAttribution(args: {
  tenantId: string;
  scope: string;
  guideTraceId: string;
  exposureItems: readonly GuideExposureItem[];
}): GuideFeedbackAttributionV1 {
  const identity = guideLearningExposureIdentity(args);
  const items = args.exposureItems
    .map((item) => ({
      memory_id: item.memory_id,
      served_surface: item.served_action,
    }))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.memory_id, "utf8"), Buffer.from(right.memory_id, "utf8"))
    );
  return {
    contract_version: "aionis_guide_feedback_attribution_v1",
    status: "available",
    guide_trace_id: args.guideTraceId,
    episode_id: identity.episodeId,
    exposure_event_id: identity.eventId,
    item_set_sha256: guideExposureItemSetDigest(args.exposureItems),
    served_surface_sha256: guideExposureSurfaceDigest(
      items.map((item) => ({
        memory_id: item.memory_id,
        action: item.served_surface,
      })),
    ),
    projection_complete: true,
    projection_incomplete_reason_codes: [],
    items,
  };
}

function finalizeProductGuidePersistenceBranch(args: {
  branch: ProductGuidePersistenceBranch;
  feedbackAttribution: GuideFeedbackAttributionV1;
  operationIdentity: ProductGuideOperationIdentity | null;
  executionEpisodeLink: ProductGuideExecutionEpisodeLinkV1 | null;
}): ProductGuidePersistenceBranch {
  if (!args.branch.result.ok) {
    throw new Error("guide persistence branch must contain a successful product result");
  }
  const body = objectValue(args.branch.result.body);
  if (!body) throw new Error("guide persistence branch result body must be an object");
  const result = productServiceSuccess({
    ...body,
    feedback_attribution_v1: args.feedbackAttribution,
    ...(args.executionEpisodeLink
      ? { execution_episode_v1: args.executionEpisodeLink }
      : {}),
  }, args.branch.result.statusCode);
  if (!args.operationIdentity) {
    return { ...args.branch, result, receiptJson: null };
  }
  const receiptJson = stableStringify(result);
  if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES) {
    throw new HttpError(
      413,
      "protected_guide_response_too_large",
      "protected guide response exceeds the canonical receipt size limit",
      { max_bytes: PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES },
    );
  }
  return {
    ...args.branch,
    result: parseStoredProductGuideOperationResult({
      identity: args.operationIdentity,
      receiptJson,
      expectedEpisodeId: args.executionEpisodeLink?.episode_id,
      expectedCurrentStateSnapshotId:
        args.executionEpisodeLink?.target_state_snapshot_id,
    }),
    receiptJson,
  };
}

function canonicalFeedbackReasonCodes(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

async function persistGuideExposure(args: {
  dependencies: ProductGuideServiceDependencies;
  parsed: ProductGuideInput;
  tenantId: string;
  scope: string;
  storeScope: string;
  guideTraceId: string;
  operationIdentity: ProductGuideOperationIdentity | null;
  branch: ProductGuidePersistenceBranch;
}): Promise<ProductServiceResult> {
  try {
    const ledger = buildGuideExposureLedger({
      parsed: args.parsed,
      tenant_id: args.tenantId,
      scope: args.scope,
      agentContext: args.branch.agentContext,
      guideTraceId: args.guideTraceId,
    });
    const ledgerJson = stableStringify(ledger);
    const ledgerSha = sha256Hex(ledgerJson);

    const out = await args.dependencies.liteWriteStore.withTx(async () => {
      if (args.operationIdentity) {
        const raced = await args.dependencies.liteWriteStore.getWriteOperation({
          tenantId: args.operationIdentity.tenantId,
          scope: args.operationIdentity.scope,
          operationKind: PRODUCT_GUIDE_OPERATION_KIND,
          operationId: args.operationIdentity.operationId,
        });
        if (raced) {
          assertProductGuideOperationMatches({
            identity: args.operationIdentity,
            storedRequestSha256: raced.request_sha256,
          });
          const result = parseStoredProductGuideOperationResult({
            identity: args.operationIdentity,
            receiptJson: raced.receipt_json,
            expectedEpisodeId: args.parsed.episode_id,
            expectedCurrentStateSnapshotId:
              args.parsed.expected_current_state_snapshot_id,
          });
          if (
            args.parsed.episode_id
            && args.parsed.expected_current_state_snapshot_id
            && args.parsed.run_id
          ) {
            if (!args.dependencies.executionEpisodeStore) {
              throw new HttpError(
                503,
                "execution_episode_store_unavailable",
                "Execution episode authority is unavailable.",
              );
            }
            await assertStoredProductGuideExecutionDecision({
              store: args.dependencies.executionEpisodeStore,
              result,
              tenantId: args.tenantId,
              publicScope: args.scope,
              storeScope: args.storeScope,
              runId: args.parsed.run_id,
              episodeId: args.parsed.episode_id,
              targetStateSnapshotId:
                args.parsed.expected_current_state_snapshot_id,
            });
          }
          return { committedNew: false, result } as const;
        }
      }

      if (args.parsed.episode_id) {
        if (!args.dependencies.executionEpisodeStore) {
          throw new HttpError(
            503,
            "execution_episode_store_unavailable",
            "Execution episode authority is unavailable.",
          );
        }
        await assertProductGuideExecutionEpisodeBinding({
          store: args.dependencies.executionEpisodeStore,
          parsed: args.parsed,
          tenantId: args.tenantId,
          publicScope: args.scope,
          storeScope: args.storeScope,
        });
      }

      await args.dependencies.liteWriteStore.insertProductGuideReceipt({
        tenantId: args.tenantId,
        scope: args.scope,
        guideTraceId: args.guideTraceId,
        runId: ledger.run_id,
        consumerAgentId: ledger.consumer_agent_id,
        consumerTeamId: ledger.consumer_team_id,
        querySha256: ledger.query_sha256,
        contextSha256: ledger.context_sha256,
        ledgerSha256: ledgerSha,
        ledgerJson,
        commitId: ledgerSha,
      });

      const recordedAt = new Date().toISOString();
      let executionEpisodeLink: ProductGuideExecutionEpisodeLinkV1 | null =
        null;
      if (args.parsed.episode_id) {
        if (
          !args.dependencies.executionEpisodeStore
          || !args.dependencies.evidenceArtifactStore
          || !args.dependencies.executionStateStore
          || !args.parsed.operation_id
        ) {
          throw new Error(
            "execution episode guide authority is unavailable",
          );
        }
        const decision = buildProductGuideExecutionDecision({
          parsed: args.parsed,
          guideTraceId: args.guideTraceId,
          guideReceiptDigest: ledgerSha,
          selected: args.branch,
          committedAt: recordedAt,
        });
        const appended =
          await args.dependencies.executionEpisodeStore.appendDecision({
            tenantId: args.tenantId,
            scope: args.storeScope,
            operationId: productGuideExecutionDecisionOperationId({
              episodeId: args.parsed.episode_id,
              guideOperationId: args.parsed.operation_id,
            }),
            decision,
          });
        if (
          appended.event.payload.event_kind !== "decision_committed"
          || appended.event.payload.decision.decision_id
            !== decision.decision_id
          || appended.event.payload.decision.decision_digest
            !== decision.decision_digest
        ) {
          throw new Error(
            "execution episode decision append returned a different receipt",
          );
        }
        await synchronizeCurrentExecutionStateHeadV2({
          replay:
            await args.dependencies.executionEpisodeStore.replayEpisode({
              tenantId: args.tenantId,
              scope: args.storeScope,
              episodeId: args.parsed.episode_id,
            }),
          stateStore: args.dependencies.executionStateStore,
          artifactStore: args.dependencies.evidenceArtifactStore,
        });
        executionEpisodeLink =
          ProductGuideExecutionEpisodeLinkV1Schema.parse({
            contract_version:
              "aionis_guide_execution_episode_link_v2",
            scoring_status: "truth_bound",
            l1_projection_contract: "canonical_l1_episode_v1",
            l1_projection_status: "pending_episode_close",
            training_eligible: false,
            training_ineligibility_reason:
              "episode_outcome_pending",
            episode_id: decision.episode_id,
            decision_id: decision.decision_id,
            decision_digest: decision.decision_digest,
            decision_event_id: appended.event.event_id,
            target_state_snapshot_id:
              decision.target_state_snapshot_id,
          });
      }

      const finalized = finalizeProductGuidePersistenceBranch({
        branch: args.branch,
        feedbackAttribution: buildGuideFeedbackAttribution({
          tenantId: args.tenantId,
          scope: args.scope,
          guideTraceId: args.guideTraceId,
          exposureItems: args.branch.exposureItems,
        }),
        operationIdentity: args.operationIdentity,
        executionEpisodeLink,
      });
      if (args.operationIdentity) {
        if (!finalized.receiptJson) {
          throw new Error(
            "protected guide operation receipt was not prepared",
          );
        }
        await args.dependencies.liteWriteStore.insertWriteOperation({
          tenantId: args.operationIdentity.tenantId,
          scope: args.operationIdentity.scope,
          operationKind: PRODUCT_GUIDE_OPERATION_KIND,
          operationId: args.operationIdentity.operationId,
          requestSha256: args.operationIdentity.requestSha256,
          receiptJson: finalized.receiptJson,
          commitId: null,
        });
      }
      return {
        committedNew: true,
        result: finalized.result,
      } as const;
    });

    return out.result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return productServiceDependencyFailure(
      "guide_receipt_store",
      productServiceFailureFromUnknown(error).statusCode,
    );
  }
}


async function executeProductGuide(args: {
  dependencies: ProductGuideServiceDependencies;
  parsed: ProductGuideInput;
}): Promise<ProductServiceResult> {
  const { dependencies, parsed } = args;
  const { env, liteWriteStore } = dependencies;
  const authorityTenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultTenantId: env.MEMORY_TENANT_ID, defaultScope: env.MEMORY_SCOPE },
  );
  const operationIdentity = productGuideOperationIdentity({
    parsed,
    tenantId: authorityTenancy.tenant_id,
    scope: authorityTenancy.scope,
  });
  if (operationIdentity) {
    const stored = await liteWriteStore.getWriteOperation({
      tenantId: operationIdentity.tenantId,
      scope: operationIdentity.scope,
      operationKind: PRODUCT_GUIDE_OPERATION_KIND,
      operationId: operationIdentity.operationId,
    });
    if (stored) {
      assertProductGuideOperationMatches({
        identity: operationIdentity,
        storedRequestSha256: stored.request_sha256,
      });
      const result = parseStoredProductGuideOperationResult({
        identity: operationIdentity,
        receiptJson: stored.receipt_json,
        expectedEpisodeId: parsed.episode_id,
        expectedCurrentStateSnapshotId:
          parsed.expected_current_state_snapshot_id,
      });
      if (
        parsed.episode_id
        && parsed.expected_current_state_snapshot_id
        && parsed.run_id
      ) {
        if (!dependencies.executionEpisodeStore) {
          return productServiceDependencyFailure(
            "execution_episode_store",
            503,
          );
        }
        await assertStoredProductGuideExecutionDecision({
          store: dependencies.executionEpisodeStore,
          result,
          tenantId: authorityTenancy.tenant_id,
          publicScope: authorityTenancy.scope,
          storeScope: authorityTenancy.scope_key,
          runId: parsed.run_id,
          episodeId: parsed.episode_id,
          targetStateSnapshotId:
            parsed.expected_current_state_snapshot_id,
        });
      }
      return result;
    }
  }
  if (parsed.episode_id) {
    if (
      !dependencies.executionEpisodeStore
      || !dependencies.evidenceArtifactStore
      || !dependencies.executionStateStore
    ) {
      return productServiceDependencyFailure(
        "execution_episode_current_state_authority",
        503,
      );
    }
    await assertProductGuideExecutionEpisodeBinding({
      store: dependencies.executionEpisodeStore,
      parsed,
      tenantId: authorityTenancy.tenant_id,
      publicScope: authorityTenancy.scope,
      storeScope: authorityTenancy.scope_key,
    });
  }
  const agentRole = productGuideAgentRole(parsed);
  const tenantId = authorityTenancy.tenant_id;
  const scope = authorityTenancy.scope;
  const tenancy = resolveTenantScope(
    { tenant_id: tenantId, scope },
    { defaultTenantId: env.MEMORY_TENANT_ID, defaultScope: env.MEMORY_SCOPE },
  );
  const recalled = await buildProductGuideMemoryPacket({
    parsed,
    tenantId,
    publicScope: scope,
    storeScope: tenancy.scope_key,
    recallAccess: dependencies.liteRecallAccess ?? null,
    queryEmbedder: dependencies.queryEmbedder ?? null,
  });
  const memoryPacket = recalled.packet;
  const recallEmbeddingUnavailable = recalled.embeddingUnavailable;
  const executionSignatures = productGuideExecutionSignatures(parsed);

  const hostCurrentExecutionState =
    compileHostCurrentExecutionStateContextV1({
      executionState: parsed.execution_state_v1,
      executionPacket: parsed.execution_packet_v1,
    });
  let canonicalCurrentExecutionState = null;
  if (
    parsed.episode_id
    && parsed.expected_current_state_snapshot_id
    && dependencies.executionEpisodeStore
    && dependencies.evidenceArtifactStore
    && dependencies.executionStateStore
  ) {
    const replay = await dependencies.executionEpisodeStore.replayEpisode({
      tenantId,
      scope: tenancy.scope_key,
      episodeId: parsed.episode_id,
    });
    if (
      replay.current_state_snapshot_id
      !== parsed.expected_current_state_snapshot_id
    ) {
      throw new HttpError(
        409,
        "execution_episode_state_stale",
        "Execution episode state changed before current-state projection.",
      );
    }
    try {
      canonicalCurrentExecutionState =
        loadCurrentExecutionStateHeadV2({
          replay,
          stateStore: dependencies.executionStateStore,
          ...(parsed.session_lease_v1
            ? {
              continuationId:
                parsed.session_lease_v1.continuation_id,
            }
            : {}),
        }).state;
    } catch {
      throw new HttpError(
        409,
        "current_execution_state_head_mismatch",
        "The authoritative current-state head does not match the exact episode state.",
      );
    }
  }
  if (
    dependencies.executionStateStore
    && dependencies.executionStateStore.transactionRunner !== null
    && dependencies.executionStateStore.transactionRunner
      !== dependencies.liteWriteStore.transactionRunner()
  ) {
    throw new Error(
      "product guide current state store must share the guide receipt transaction runner",
    );
  }
  if (
    dependencies.evidenceArtifactStore
    && dependencies.evidenceArtifactStore.transactionRunner()
      !== dependencies.liteWriteStore.transactionRunner()
  ) {
    throw new Error(
      "product guide evidence store must share the guide receipt transaction runner",
    );
  }
  const agentContext = buildAionisAgentContext({
    tenant_id: tenantId,
    scope,
    agent_role: agentRole,
    memory_packet: memoryPacket,
    execution_scope: {
      task_signature: executionSignatures.taskSignature,
      task_family: executionSignatures.taskFamily,
      workflow_signature: executionSignatures.workflowSignature,
    },
    context_char_budget: parsed.context_char_budget ?? null,
    canonical_current_execution_state: canonicalCurrentExecutionState,
    host_current_execution_state: hostCurrentExecutionState,
  });
  const guideTraceId = buildGuideTraceId();

  const includePackets = parsed.include_packets === true;
  const memoryContractVisible =
    productGuideMemoryContractVisible(memoryPacket);
  const exposureItems = productGuideExposureItems(agentContext);
  const result = productServiceSuccess({
    contract_version: "aionis_guide_result_v1",
    ...(operationIdentity
      ? { operation_id: operationIdentity.operationId }
      : {}),
    tenant_id: tenantId,
    scope,
    consumer_agent_id:
      parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID,
    ...(parsed.consumer_team_id
      ? { consumer_team_id: parsed.consumer_team_id }
      : {}),
    guide_trace_id: guideTraceId,
    agent_context: agentContext,
    ...(includePackets
      ? { memory_packet: memoryPacket }
      : {}),
    source_map: {
      routes_used: ["/v1/guide"],
      internal_surfaces_used: [
        ...(recallEmbeddingUnavailable
          ? ["recall_embedding_unavailable"]
          : ["recall"]),
        "product_packets",
        "agent_context_compiler",
        ...(canonicalCurrentExecutionState
          ? ["canonical_current_execution_state_v2"]
          : []),
        ...(agentRole !== "agent"
          ? ["role_aware_agent_context"]
          : []),
        "compact_agent_context",
        "canonical_cold_l1_policy",
        ...(memoryContractVisible ? ["memory_contract"] : []),
        "guide_exposure_ledger",
        "feedback_attribution",
      ],
      omitted_internal_surfaces: [
        "internal_planning_details",
        "internal_execution_recommendation_details",
        "internal_cost_diagnostics",
        ...(includePackets ? [] : ["memory_packet"]),
        ...(recallEmbeddingUnavailable
          ? ["semantic_recall"]
          : []),
      ],
    },
  });
  if (
    operationIdentity
    && Buffer.byteLength(stableStringify(result), "utf8")
      > PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES
  ) {
    throw new HttpError(
      413,
      "protected_guide_response_too_large",
      "protected guide response exceeds the canonical receipt size limit",
      { max_bytes: PRODUCT_GUIDE_OPERATION_RECEIPT_MAX_BYTES },
    );
  }
  const branch: ProductGuidePersistenceBranch = {
    agentContext,
    result,
    receiptJson: null,
    exposureItems,
  };
  return await persistGuideExposure({
    dependencies,
    parsed,
    tenantId,
    scope,
    storeScope: tenancy.scope_key,
    guideTraceId,
    operationIdentity,
    branch,
  });
}


export function createProductGuideService(
  dependencies: ProductGuideServiceDependencies,
): ProductServices["guide"] {
  if (
    dependencies.executionEpisodeStore
    && dependencies.executionEpisodeStore.transactionRunner()
      !== dependencies.liteWriteStore.transactionRunner()
  ) {
    throw new Error(
      "product guide execution episode store must share the guide receipt transaction runner",
    );
  }
  return {
    async execute(parsed) {
      try {
        return await executeProductGuide({ dependencies, parsed });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
