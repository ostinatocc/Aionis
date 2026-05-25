import type {
  AionisActionRetrievalRequest,
  AionisActionRetrievalResponse,
  AionisAgentMemoryHandoffPackRequest,
  AionisAgentMemoryHandoffPackResponse,
  AionisAgentMemoryInspectRequest,
  AionisAgentMemoryInspectResponse,
  AionisAgentMemoryResumePackRequest,
  AionisAgentMemoryResumePackResponse,
  AionisAgentMemoryReviewPackRequest,
  AionisAgentMemoryReviewPackResponse,
  AionisAnchorRehydratePayloadRequest,
  AionisArchiveRehydrateRequest,
  AionisContextAssembleResponse,
  AionisContextAssembleRequest,
  AionisContinuityReviewPackRequest,
  AionisContinuityReviewPackResponse,
  AionisExecutionIntrospectRequest,
  AionisExecutionIntrospectResponse,
  AionisExperienceIntelligenceRequest,
  AionisExperienceIntelligenceResponse,
  AionisEvolutionReviewPackRequest,
  AionisEvolutionReviewPackResponse,
  AionisDelegationRecordsAggregateRequest,
  AionisDelegationRecordsAggregateResponse,
  AionisDelegationRecordsFindRequest,
  AionisDelegationRecordsFindResponse,
  AionisDelegationRecordsWriteRequest,
  AionisDelegationRecordsWriteResponse,
  AionisHandoffRecoverRequest,
  AionisHandoffStoreRequest,
  AionisHealthResponse,
  AionisKickoffRecommendationRequest,
  AionisKickoffRecommendationResponse,
  AionisTaskStartRequest,
  AionisTaskStartResponse,
  AionisMemoryFeedbackRequest,
  AionisMemoryFindRequest,
  AionisMemoryPackExportRequest,
  AionisMemoryPackImportRequest,
  AionisMemoryRecallRequest,
  AionisMemoryRecallTextRequest,
  AionisMemoryResolveRequest,
  AionisMemoryWriteRequest,
  AionisMemoryWriteResponse,
  AionisNodesActivateRequest,
  AionisPatternSuppressRequest,
  AionisPatternUnsuppressRequest,
  AionisPlanningContextResponse,
  AionisPlanningContextRequest,
  AionisPolicyLearningControlApplyRequest,
  AionisPolicyLearningControlApplyResponse,
  AionisReplayPlaybookCandidateRequest,
  AionisReplayPlaybookCompileFromRunRequest,
  AionisReplayPlaybookDispatchRequest,
  AionisReplayPlaybookGetRequest,
  AionisReplayPlaybookPromoteRequest,
  AionisReplayPlaybookRepairRequest,
  AionisReplayPlaybookRepairReviewRequest,
  AionisReplayPlaybookRunRequest,
  AionisReplayRunEndRequest,
  AionisReplayRunGetRequest,
  AionisReplayRunStartRequest,
  AionisReplayStepAfterRequest,
  AionisReplayStepBeforeRequest,
  AionisRetrieveWorkflowContractRequest,
  AionisRetrieveWorkflowContractResponse,
  AionisRuntimeBoundaryInventoryResponse,
  AionisRuleStateRequest,
  AionisRulesEvaluateRequest,
  AionisRuntimeResponse,
  AionisSandboxExecuteRequest,
  AionisSandboxRunArtifactRequest,
  AionisSandboxRunCancelRequest,
  AionisSandboxRunGetRequest,
  AionisSandboxRunLogsRequest,
  AionisSandboxSessionCreateRequest,
  AionisSessionCreateRequest,
  AionisSessionEventsQuery,
  AionisSessionEventWriteRequest,
  AionisSessionListQuery,
  AionisStoreExecutionOutcomeRequest,
  AionisStoreExecutionOutcomeResponse,
  AionisTaskStartPlanRequest,
  AionisTaskStartPlanResponse,
  AionisToolsDecisionRequest,
  AionisToolsFeedbackRequest,
  AionisToolsFeedbackResponse,
  AionisToolsRunRequest,
  AionisToolsRunsListRequest,
  AionisToolsSelectRequest,
} from "./contracts.js";
import { AIONIS_SHARED_ROUTE_PATHS } from "./routes.js";
import { createRetrieveWorkflowContractMethod, createStoreExecutionOutcomeMethod } from "./execution-facade.js";
import { createTaskStartPlanMethod } from "./task-start-plan.js";
import { toTaskStartResponse } from "./task-start.js";
import { createAionisRuntimeHttpClient } from "./transport/http.js";
import type { AionisClientOptions, AionisHttpClient, AionisQueryPayload, AionisRequestPayload } from "./types.js";

function createPostMethod<TRequest extends AionisRequestPayload, TResponse = AionisRuntimeResponse>(
  client: AionisHttpClient,
  path: string,
) {
  return async function call(payload: TRequest): Promise<TResponse> {
    return await client.post<TRequest, TResponse>({ path, payload });
  };
}

function createGetMethod<TQuery extends AionisQueryPayload, TResponse = AionisRuntimeResponse>(
  client: AionisHttpClient,
  path: string,
) {
  return async function call(query?: TQuery): Promise<TResponse> {
    return await client.get<TQuery, TResponse>({ path, query });
  };
}

function createSessionEventsMethod(client: AionisHttpClient) {
  return async function sessionEvents(payload: AionisSessionEventsQuery): Promise<AionisRuntimeResponse> {
    const { session_id, ...query } = payload;
    return await client.get<typeof query, AionisRuntimeResponse>({
      path: `/v1/memory/sessions/${encodeURIComponent(session_id)}/events`,
      query,
    });
  };
}

function createTaskStartMethod(client: AionisHttpClient) {
  return async function taskStart(payload: AionisTaskStartRequest): Promise<AionisTaskStartResponse> {
    const response = await client.post<AionisTaskStartRequest, AionisKickoffRecommendationResponse>({
      path: AIONIS_SHARED_ROUTE_PATHS.kickoffRecommendation,
      payload,
    });
    return toTaskStartResponse(response);
  };
}

export function createAionisRuntimeClient(options: AionisClientOptions) {
  const http = createAionisRuntimeHttpClient(options);

  return {
    system: {
      health: createGetMethod<Record<string, never>, AionisHealthResponse>(http, "/health"),
      boundaryInventory: createGetMethod<Record<string, never>, AionisRuntimeBoundaryInventoryResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.runtimeBoundaryInventory,
      ),
    },
    handoff: {
      store: createPostMethod<AionisHandoffStoreRequest>(http, "/v1/handoff/store"),
      recover: createPostMethod<AionisHandoffRecoverRequest>(http, "/v1/handoff/recover"),
    },
    memory: {
      write: createPostMethod<AionisMemoryWriteRequest, AionisMemoryWriteResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.memoryWrite,
      ),
      recall: createPostMethod<AionisMemoryRecallRequest>(http, "/v1/memory/recall"),
      recallText: createPostMethod<AionisMemoryRecallTextRequest>(http, "/v1/memory/recall_text"),
      find: createPostMethod<AionisMemoryFindRequest>(http, "/v1/memory/find"),
      resolve: createPostMethod<AionisMemoryResolveRequest>(http, "/v1/memory/resolve"),
      feedback: createPostMethod<AionisMemoryFeedbackRequest>(http, "/v1/memory/feedback"),
      planningContext: createPostMethod<AionisPlanningContextRequest, AionisPlanningContextResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.planningContext,
      ),
      contextAssemble: createPostMethod<AionisContextAssembleRequest, AionisContextAssembleResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.contextAssemble,
      ),
      actionRetrieval: createPostMethod<AionisActionRetrievalRequest, AionisActionRetrievalResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.actionRetrieval,
      ),
      experienceIntelligence: createPostMethod<AionisExperienceIntelligenceRequest, AionisExperienceIntelligenceResponse>(
        http,
        "/v1/memory/experience/intelligence",
      ),
      kickoffRecommendation: createPostMethod<AionisKickoffRecommendationRequest, AionisKickoffRecommendationResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.kickoffRecommendation,
      ),
      taskStart: createTaskStartMethod(http),
      taskStartPlan: createTaskStartPlanMethod(http) as (
        payload: AionisTaskStartPlanRequest,
      ) => Promise<AionisTaskStartPlanResponse>,
      executionIntrospect: createPostMethod<AionisExecutionIntrospectRequest, AionisExecutionIntrospectResponse>(
        http,
        AIONIS_SHARED_ROUTE_PATHS.executionIntrospect,
      ),
      storeExecutionOutcome: createStoreExecutionOutcomeMethod(http) as (
        payload: AionisStoreExecutionOutcomeRequest,
      ) => Promise<AionisStoreExecutionOutcomeResponse>,
      retrieveWorkflowContract: createRetrieveWorkflowContractMethod(http) as (
        payload: AionisRetrieveWorkflowContractRequest,
      ) => Promise<AionisRetrieveWorkflowContractResponse>,
      delegationRecords: {
        aggregate: createPostMethod<AionisDelegationRecordsAggregateRequest, AionisDelegationRecordsAggregateResponse>(
          http,
          "/v1/memory/delegation/records/aggregate",
        ),
        find: createPostMethod<AionisDelegationRecordsFindRequest, AionisDelegationRecordsFindResponse>(
          http,
          "/v1/memory/delegation/records/find",
        ),
        write: createPostMethod<AionisDelegationRecordsWriteRequest, AionisDelegationRecordsWriteResponse>(
          http,
          "/v1/memory/delegation/records",
        ),
      },
      reviewPacks: {
        continuity: createPostMethod<AionisContinuityReviewPackRequest, AionisContinuityReviewPackResponse>(
          http,
          "/v1/memory/continuity/review-pack",
        ),
        evolution: createPostMethod<AionisEvolutionReviewPackRequest, AionisEvolutionReviewPackResponse>(
          http,
          AIONIS_SHARED_ROUTE_PATHS.evolutionReviewPack,
        ),
      },
      agent: {
        inspect: createPostMethod<AionisAgentMemoryInspectRequest, AionisAgentMemoryInspectResponse>(
          http,
          AIONIS_SHARED_ROUTE_PATHS.agentInspect,
        ),
        reviewPack: createPostMethod<AionisAgentMemoryReviewPackRequest, AionisAgentMemoryReviewPackResponse>(
          http,
          "/v1/memory/agent/review-pack",
        ),
        resumePack: createPostMethod<AionisAgentMemoryResumePackRequest, AionisAgentMemoryResumePackResponse>(
          http,
          "/v1/memory/agent/resume-pack",
        ),
        handoffPack: createPostMethod<AionisAgentMemoryHandoffPackRequest, AionisAgentMemoryHandoffPackResponse>(
          http,
          "/v1/memory/agent/handoff-pack",
        ),
      },
      sessions: {
        create: createPostMethod<AionisSessionCreateRequest>(http, "/v1/memory/sessions"),
        list: createGetMethod<AionisSessionListQuery>(http, "/v1/memory/sessions"),
        writeEvent: createPostMethod<AionisSessionEventWriteRequest>(http, "/v1/memory/events"),
        events: createSessionEventsMethod(http),
      },
      packs: {
        exportPack: createPostMethod<AionisMemoryPackExportRequest>(http, "/v1/memory/packs/export"),
        importPack: createPostMethod<AionisMemoryPackImportRequest>(http, "/v1/memory/packs/import"),
      },
      archive: {
        rehydrate: createPostMethod<AionisArchiveRehydrateRequest>(http, "/v1/memory/archive/rehydrate"),
      },
      nodes: {
        activate: createPostMethod<AionisNodesActivateRequest>(http, "/v1/memory/nodes/activate"),
      },
      rules: {
        state: createPostMethod<AionisRuleStateRequest>(http, "/v1/memory/rules/state"),
        evaluate: createPostMethod<AionisRulesEvaluateRequest>(http, "/v1/memory/rules/evaluate"),
      },
      policies: {
        learningControlApply: createPostMethod<AionisPolicyLearningControlApplyRequest, AionisPolicyLearningControlApplyResponse>(
          http,
          "/v1/memory/policies/learning-control/apply",
        ),
      },
      tools: {
        select: createPostMethod<AionisToolsSelectRequest>(http, AIONIS_SHARED_ROUTE_PATHS.toolsSelect),
        decision: createPostMethod<AionisToolsDecisionRequest>(http, "/v1/memory/tools/decision"),
        run: createPostMethod<AionisToolsRunRequest>(http, "/v1/memory/tools/run"),
        runsList: createPostMethod<AionisToolsRunsListRequest>(http, "/v1/memory/tools/runs/list"),
        feedback: createPostMethod<AionisToolsFeedbackRequest, AionisToolsFeedbackResponse>(
          http,
          AIONIS_SHARED_ROUTE_PATHS.toolsFeedback,
        ),
        rehydratePayload: createPostMethod<AionisAnchorRehydratePayloadRequest>(http, "/v1/memory/tools/rehydrate_payload"),
      },
      patterns: {
        suppress: createPostMethod<AionisPatternSuppressRequest>(http, "/v1/memory/patterns/suppress"),
        unsuppress: createPostMethod<AionisPatternUnsuppressRequest>(http, "/v1/memory/patterns/unsuppress"),
      },
      anchors: {
        rehydratePayload: createPostMethod<AionisAnchorRehydratePayloadRequest>(
          http,
          AIONIS_SHARED_ROUTE_PATHS.anchorsRehydratePayload,
        ),
      },
      replay: {
        run: {
          start: createPostMethod<AionisReplayRunStartRequest>(http, "/v1/memory/replay/run/start"),
          end: createPostMethod<AionisReplayRunEndRequest>(http, "/v1/memory/replay/run/end"),
          get: createPostMethod<AionisReplayRunGetRequest>(http, "/v1/memory/replay/runs/get"),
        },
        step: {
          before: createPostMethod<AionisReplayStepBeforeRequest>(http, "/v1/memory/replay/step/before"),
          after: createPostMethod<AionisReplayStepAfterRequest>(http, "/v1/memory/replay/step/after"),
        },
        playbooks: {
          compileFromRun: createPostMethod<AionisReplayPlaybookCompileFromRunRequest>(http, "/v1/memory/replay/playbooks/compile_from_run"),
          get: createPostMethod<AionisReplayPlaybookGetRequest>(http, "/v1/memory/replay/playbooks/get"),
          candidate: createPostMethod<AionisReplayPlaybookCandidateRequest>(http, "/v1/memory/replay/playbooks/candidate"),
          promote: createPostMethod<AionisReplayPlaybookPromoteRequest>(http, "/v1/memory/replay/playbooks/promote"),
          run: createPostMethod<AionisReplayPlaybookRunRequest>(http, "/v1/memory/replay/playbooks/run"),
          dispatch: createPostMethod<AionisReplayPlaybookDispatchRequest>(http, "/v1/memory/replay/playbooks/dispatch"),
          repair: createPostMethod<AionisReplayPlaybookRepairRequest>(http, "/v1/memory/replay/playbooks/repair"),
          repairReview: createPostMethod<AionisReplayPlaybookRepairReviewRequest>(
            http,
            AIONIS_SHARED_ROUTE_PATHS.replayPlaybookRepairReview,
          ),
        },
      },
      sandbox: {
        sessions: {
          create: createPostMethod<AionisSandboxSessionCreateRequest>(http, "/v1/memory/sandbox/sessions"),
        },
        execute: createPostMethod<AionisSandboxExecuteRequest>(http, "/v1/memory/sandbox/execute"),
        runs: {
          get: createPostMethod<AionisSandboxRunGetRequest>(http, "/v1/memory/sandbox/runs/get"),
          logs: createPostMethod<AionisSandboxRunLogsRequest>(http, "/v1/memory/sandbox/runs/logs"),
          artifact: createPostMethod<AionisSandboxRunArtifactRequest>(http, "/v1/memory/sandbox/runs/artifact"),
          cancel: createPostMethod<AionisSandboxRunCancelRequest>(http, "/v1/memory/sandbox/runs/cancel"),
        },
      },
    },
  };
}

export const createAionisClient = createAionisRuntimeClient;
export type AionisRuntimeClient = ReturnType<typeof createAionisRuntimeClient>;
