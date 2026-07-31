import {
  ExecutionEpisodeServiceError,
  type ExecutionEpisodeService,
  type ExecutionEpisodeSemanticAuthorityInputV1,
} from "./execution-episode-service.js";
import {
  ExecutionSessionLeaseStoreError,
} from "../store/lite-execution-session-lease-store.js";
import type {
  ExecutionAgentSessionCredentialsV1,
  ExecutionTurnTransactionService,
} from "./execution-turn-transaction-service.js";
import {
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  type ProductExecutionEpisodeObserveInput,
  type ProductExecutionEpisodeOutcomeInput,
  type ProductServices,
} from "./product-services.js";
import { resolveTenantScope } from "../memory/tenant.js";

export type ProductExecutionEpisodeTransportDependencies = Readonly<{
  defaultTenantId: string;
  defaultScope: string;
  executionEpisodeService: ExecutionEpisodeService;
  executionTurnService?: ExecutionTurnTransactionService;
}>;

function episodeFailure(error: unknown) {
  if (error instanceof ExecutionSessionLeaseStoreError) {
    const code = error.code;
    return productServiceFailure({
      statusCode:
        code.includes("_missing")
          ? 404
          : code.includes("_conflict")
            || code.includes("_expired")
            || code.includes("_stale")
              ? 409
              : 400,
      error: code,
      message: "Execution session operation was rejected.",
    });
  }
  if (!(error instanceof ExecutionEpisodeServiceError)) {
    return productServiceFailureFromUnknown(error);
  }
  const code = error.code;
  const statusCode = code.includes("_missing")
    ? 404
    : (
      code.includes("_conflict")
      || code.includes("_drift")
      || code.includes("_stale")
      || code.includes("_already_")
      || code.includes("_identity_mismatch")
      || code.includes("_identity_changed")
    )
      ? 409
      : (
        code.includes("_unavailable")
        || code.includes("_infrastructure")
      )
        ? 503
        : 400;
  return productServiceFailure({
    statusCode,
    error: code,
    message: "Execution episode operation was rejected.",
  });
}

function tenancy(
  dependencies: ProductExecutionEpisodeTransportDependencies,
  input: { tenant_id?: string; scope?: string },
) {
  return resolveTenantScope(input, {
    defaultTenantId: dependencies.defaultTenantId,
    defaultScope: dependencies.defaultScope,
  });
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function semanticAuthority(
  value:
    | Readonly<{ kind: "host_declared"; actor_id: string }>
    | Readonly<{
      kind: "model_derived";
      actor_id: string;
      model_id: string;
      derivation_sha256: string;
      uncertainty: number;
    }>,
): ExecutionEpisodeSemanticAuthorityInputV1 {
  if (value.kind === "host_declared") {
    return {
      kind: value.kind,
      actorId: value.actor_id,
    };
  }
  return {
    kind: value.kind,
    actorId: value.actor_id,
    modelId: value.model_id,
    derivationSha256: value.derivation_sha256,
    uncertainty: value.uncertainty,
  };
}

type SessionLeaseContext = Readonly<{
  session_key: string;
  continuation_id: string;
  holder_id: string;
  lease_id: string;
  lease_revision: number;
  lease_operation_id: string;
  lease_ttl_ms?: number;
}>;

function sessionCredentials(
  identity: ReturnType<typeof resolveTenantScope>,
  value: SessionLeaseContext,
): ExecutionAgentSessionCredentialsV1 {
  return {
    tenantId: identity.tenant_id,
    storeScope: identity.scope_key,
    sessionKey: value.session_key,
    holderId: value.holder_id,
    leaseId: value.lease_id,
    leaseRevision: value.lease_revision,
  };
}

export function createProductExecutionEpisodeTransportService(
  dependencies: ProductExecutionEpisodeTransportDependencies,
): ProductServices["executionEpisode"] {
  const runLeased = async <T>(
    identity: ReturnType<typeof resolveTenantScope>,
    lease: SessionLeaseContext | undefined,
    episodeId: string,
    operationBinding: unknown,
    execute: () => Promise<T>,
  ): Promise<Readonly<{
    result: T;
    session: unknown | null;
    current_state: unknown | null;
  }>> => {
    if (!lease) {
      return {
        result: await execute(),
        session: null,
        current_state: null,
      };
    }
    if (!dependencies.executionTurnService) {
      throw new Error(
        "execution_session_turn_service_unavailable",
      );
    }
    const leased = await dependencies.executionTurnService.runLeased({
      credentials: sessionCredentials(identity, lease),
      leaseOperationId: lease.lease_operation_id,
      operationBinding,
      expectedEpisodeId: episodeId,
      expectedContinuationId: lease.continuation_id,
      ...(lease.lease_ttl_ms === undefined
        ? {}
        : { leaseTtlMs: lease.lease_ttl_ms }),
      execute,
    });
    return {
      result: leased.result,
      session: leased.session,
      current_state: leased.current_state,
    };
  };

  return {
    async observe(input: ProductExecutionEpisodeObserveInput) {
      try {
        const identity = tenancy(dependencies, input);
        if (input.event_kind === "episode_started") {
          const result = await dependencies.executionEpisodeService.begin({
            tenantId: identity.tenant_id,
            publicScope: identity.scope,
            storeScope: identity.scope_key,
            operationId: input.operation_id,
            taskEnvelope: input.task_envelope_v1,
            sourceTaskBytes: decodeBase64(input.source_task_base64),
            runId: input.run_id,
            modelId: input.model_id,
            modelConfig: input.model_config,
            budget: input.budget,
            workspaceRoot: input.workspace_root,
            subjectStateSpec: input.subject_state_spec_v2,
            requiredVerifierId: input.required_verifier_id,
          });
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode: result.episode,
            current_state_snapshot: result.initial_state_snapshot,
            current_state_snapshot_v2:
              result.initial_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
          });
        }
        if (input.event_kind === "episode_resumed") {
          const result = await dependencies.executionEpisodeService.resume({
            tenantId: identity.tenant_id,
            storeScope: identity.scope_key,
            episodeId: input.episode_id,
            workspaceRoot: input.workspace_root,
          });
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode: result.replay.episode,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            closed: result.replay.closed,
            reward: result.replay.reward,
            cost_receipt: result.replay.cost_receipt,
            reward_eligible: result.replay.reward_eligible,
            selector_eligible: result.replay.selector_eligible,
            replayed: true,
          });
        }
        if (input.event_kind === "snapshot_restored") {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.restoreSnapshot({
                tenantId: identity.tenant_id,
                storeScope: identity.scope_key,
                episodeId: input.episode_id,
                operationId: input.operation_id,
                workspaceRoot: input.workspace_root,
                expectedCurrentStateSnapshotId:
                  input.expected_current_state_snapshot_id,
                targetSnapshotId: input.target_snapshot_id,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            action: result.action,
            recovery_target_snapshot:
              result.recovery_target_snapshot,
            recovery_target_snapshot_v2:
              result.recovery_target_snapshot_v2,
            state_after_snapshot: result.state_after_snapshot,
            state_after_snapshot_v2:
              result.state_after_snapshot_v2,
            current_state_snapshot:
              result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            restored_exact: result.restored_exact,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        const semanticInput = (
          input.event_kind === "semantic_observation_recorded"
          || input.event_kind === "agent_decision_recorded"
          || input.event_kind === "progress_state_recorded"
          || input.event_kind === "planned_action_recorded"
        )
          ? {
            tenantId: identity.tenant_id,
            storeScope: identity.scope_key,
            episodeId: input.episode_id,
            operationId: input.operation_id,
            workspaceRoot: input.workspace_root,
            expectedCurrentStateSnapshotId:
              input.expected_current_state_snapshot_id,
            authority: semanticAuthority(input.authority),
            evidenceKind: input.evidence_kind,
            evidenceBytes: decodeBase64(input.evidence_base64),
            ...(input.decisive_evidence
              ? {
                decisiveEvidence: input.decisive_evidence.map(
                  (entry) => ({
                    sourceRef: entry.source_ref,
                    excerpt: entry.excerpt,
                  }),
                ),
              }
              : {}),
            ...(input.evidence_media_type
              ? { evidenceMediaType: input.evidence_media_type }
              : {}),
            ...(input.evidence_encoding
              ? { evidenceEncoding: input.evidence_encoding }
              : {}),
          }
          : null;
        if (
          input.event_kind === "semantic_observation_recorded"
          && semanticInput
        ) {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.recordObservation({
              ...semanticInput,
              observation: input.observation,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            semantic_event: result.semantic_event,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        if (
          input.event_kind === "agent_decision_recorded"
          && semanticInput
        ) {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.recordDecision({
              ...semanticInput,
              decision: input.decision,
              reasons: input.reasons,
              alternativesRejected: input.alternatives_rejected,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            semantic_event: result.semantic_event,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        if (
          input.event_kind === "progress_state_recorded"
          && semanticInput
        ) {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.recordProgress({
              ...semanticInput,
              itemId: input.item_id,
              state: input.state,
              statement: input.statement,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            semantic_event: result.semantic_event,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        if (
          input.event_kind === "planned_action_recorded"
          && semanticInput
        ) {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.recordPlannedAction({
              ...semanticInput,
              actionId: input.action_id,
              intent: input.intent,
              justification: input.justification,
              preconditions: input.preconditions,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_observe_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            semantic_event: result.semantic_event,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        if (
          input.event_kind !== "action_observed"
          && input.event_kind !== "state_mutation"
        ) {
          throw new Error(
            "execution_episode_observe_event_dispatch_incomplete",
          );
        }
        const leased = await runLeased(
          identity,
          input.session_lease_v1,
          input.episode_id,
          input,
          async () =>
            await dependencies.executionEpisodeService.recordAction({
              tenantId: identity.tenant_id,
              storeScope: identity.scope_key,
              episodeId: input.episode_id,
              operationId: input.operation_id,
              workspaceRoot: input.workspace_root,
              expectedCurrentStateSnapshotId:
                input.expected_current_state_snapshot_id,
              actionKind: input.action_kind,
              toolName: input.tool_name,
              requestBytes: decodeBase64(input.request_base64),
              resultBytes: decodeBase64(input.result_base64),
            }),
        );
        const result = leased.result;
        return productServiceSuccess({
          contract_version:
            "aionis_execution_episode_observe_result_v1",
          event_kind: input.event_kind,
          tenant_id: identity.tenant_id,
          scope: identity.scope,
          episode_id: input.episode_id,
          action: result.action,
          state_after_snapshot: result.state_after_snapshot,
          state_after_snapshot_v2: result.state_after_snapshot_v2,
          current_state_snapshot: result.current_state_snapshot,
          current_state_snapshot_v2: result.current_state_snapshot_v2,
          event: result.event,
          replayed: result.replayed,
          session: leased.session,
          current_execution_state: leased.current_state,
        });
      } catch (error) {
        return episodeFailure(error);
      }
    },

    async outcome(input: ProductExecutionEpisodeOutcomeInput) {
      try {
        const identity = tenancy(dependencies, input);
        if (input.event_kind === "run_verifier") {
          const leased = await runLeased(
            identity,
            input.session_lease_v1,
            input.episode_id,
            input,
            async () =>
              await dependencies.executionEpisodeService.runVerifier({
                tenantId: identity.tenant_id,
                storeScope: identity.scope_key,
                episodeId: input.episode_id,
                operationId: input.operation_id,
                workspaceRoot: input.workspace_root,
                expectedCurrentStateSnapshotId:
                  input.expected_current_state_snapshot_id,
              }),
          );
          const result = leased.result;
          return productServiceSuccess({
            contract_version:
              "aionis_execution_episode_outcome_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            episode_id: input.episode_id,
            invocation: result.invocation,
            outcome: result.outcome,
            verified_state_snapshot: result.verified_state_snapshot,
            verified_state_snapshot_v2:
              result.verified_state_snapshot_v2,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            event: result.event,
            replayed: result.replayed,
            session: leased.session,
            current_execution_state: leased.current_state,
          });
        }
        const closeInput = {
          operationId: input.operation_id,
          workspaceRoot: input.workspace_root,
          expectedCurrentStateSnapshotId:
            input.expected_current_state_snapshot_id,
          termination: input.termination,
          verifierReceiptId: input.verifier_receipt_id,
          outcomeDetails: input.outcome_details,
          ...(input.cost
            ? {
              cost: {
                provider: input.cost.provider,
                model: input.cost.model,
                inputTokens: input.cost.input_tokens,
                outputTokens: input.cost.output_tokens,
                ...(input.cost.cached_input_tokens === undefined
                  ? {}
                  : {
                    cachedInputTokens:
                      input.cost.cached_input_tokens,
                  }),
                tokenUsageAuthority:
                  input.cost.token_usage_authority,
                usageReceiptBytes: decodeBase64(
                  input.cost.usage_receipt_base64,
                ),
                ...(input.cost.usage_receipt_media_type
                  ? {
                    usageReceiptMediaType:
                      input.cost.usage_receipt_media_type,
                  }
                  : {}),
                ...(input.cost.usage_receipt_encoding
                  ? {
                    usageReceiptEncoding:
                      input.cost.usage_receipt_encoding,
                  }
                  : {}),
                ...(input.cost.monetary_cost_micros === undefined
                  ? {}
                  : {
                    monetaryCostMicros:
                      input.cost.monetary_cost_micros,
                  }),
                ...(input.cost.currency
                  ? { currency: input.cost.currency }
                  : {}),
                producerId: input.cost.producer_id,
              },
            }
            : {}),
        };
        let result;
        let session: unknown | null = null;
        let currentExecutionState: unknown | null = null;
        if (input.session_lease_v1) {
          if (!dependencies.executionTurnService) {
            throw new Error(
              "execution_session_turn_service_unavailable",
            );
          }
          const closed =
            await dependencies.executionTurnService.closeAndRelease({
              credentials: sessionCredentials(
                identity,
                input.session_lease_v1,
              ),
              close: closeInput,
              releaseOperationId:
                input.session_lease_v1.lease_operation_id,
            });
          result = closed.result;
          session = closed.session;
          currentExecutionState = closed.current_state;
        } else {
          result = await dependencies.executionEpisodeService.close({
            tenantId: identity.tenant_id,
            storeScope: identity.scope_key,
            episodeId: input.episode_id,
            ...closeInput,
          });
        }
        return productServiceSuccess({
          contract_version:
            "aionis_execution_episode_outcome_result_v1",
          event_kind: input.event_kind,
          tenant_id: identity.tenant_id,
          scope: identity.scope,
          episode_id: input.episode_id,
          event: result.event,
          reward: result.event.payload.event_kind === "episode_closed"
            ? result.event.payload.reward
            : null,
          cost_receipt:
            result.event.payload.event_kind === "episode_closed"
              ? result.event.payload.cost_receipt ?? null
              : null,
          replayed: result.replayed,
          session,
          current_execution_state: currentExecutionState,
        });
      } catch (error) {
        return episodeFailure(error);
      }
    },
  };
}
