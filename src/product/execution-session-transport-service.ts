import { resolveTenantScope } from "../memory/tenant.js";
import {
  ExecutionSessionLeaseStoreError,
} from "../store/lite-execution-session-lease-store.js";
import {
  ExecutionTurnTransactionServiceError,
  type ExecutionAgentSessionCredentialsV1,
  type ExecutionTurnTransactionService,
} from "./execution-turn-transaction-service.js";
import {
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  type ProductExecutionSessionObserveInput,
  type ProductServices,
} from "./product-services.js";

export type ProductExecutionSessionTransportDependencies = Readonly<{
  defaultTenantId: string;
  defaultScope: string;
  executionTurnService: ExecutionTurnTransactionService;
}>;

function sessionFailure(error: unknown) {
  if (
    !(error instanceof ExecutionSessionLeaseStoreError)
    && !(error instanceof ExecutionTurnTransactionServiceError)
  ) {
    return productServiceFailureFromUnknown(error);
  }
  const code = error.code;
  const statusCode = code.includes("_missing")
    ? 404
    : (
      code.includes("_conflict")
      || code.includes("_expired")
      || code.includes("_stale")
      || code.includes("_closed")
      || code.includes("_mismatch")
      || code.includes("_same_holder")
      || code.includes("_not_expirable")
    )
      ? 409
      : 400;
  return productServiceFailure({
    statusCode,
    error: code,
    message: "Execution session operation was rejected.",
  });
}

function credentials(args: {
  identity: ReturnType<typeof resolveTenantScope>;
  input: {
    session_key: string;
    holder_id: string;
    lease_id: string;
    lease_revision: number;
  };
}): ExecutionAgentSessionCredentialsV1 {
  return {
    tenantId: args.identity.tenant_id,
    storeScope: args.identity.scope_key,
    sessionKey: args.input.session_key,
    holderId: args.input.holder_id,
    leaseId: args.input.lease_id,
    leaseRevision: args.input.lease_revision,
  };
}

export function createProductExecutionSessionTransportService(
  dependencies: ProductExecutionSessionTransportDependencies,
): ProductServices["executionSession"] {
  return {
    async observe(input: ProductExecutionSessionObserveInput) {
      try {
        const identity = resolveTenantScope(input, {
          defaultTenantId: dependencies.defaultTenantId,
          defaultScope: dependencies.defaultScope,
        });
        if (input.event_kind === "session_begin") {
          const result =
            await dependencies.executionTurnService.beginOrResume({
              tenantId: identity.tenant_id,
              publicScope: identity.scope,
              storeScope: identity.scope_key,
              operationId: input.operation_id,
              sessionKey: input.session_key,
              continuationId: input.continuation_id,
              holderId: input.holder_id,
              ...(input.lease_ttl_ms === undefined
                ? {}
                : { leaseTtlMs: input.lease_ttl_ms }),
              taskEnvelope: input.task_envelope_v1,
              sourceTaskBytes: Buffer.from(
                input.source_task_base64,
                "base64",
              ),
              runId: input.run_id,
              modelId: input.model_id,
              modelConfig: input.model_config,
              budget: input.budget,
              workspaceRoot: input.workspace_root,
              subjectStateSpec: input.subject_state_spec_v2,
              requiredVerifierId: input.required_verifier_id,
            });
          return productServiceSuccess({
            contract_version: "aionis_execution_session_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            session: result.session,
            episode: result.episode?.episode ?? null,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            episode_event: result.episode?.event ?? null,
            current_state: result.current_state,
            resumed: result.resumed,
          });
        }
        if (input.event_kind === "session_resume") {
          const result = await dependencies.executionTurnService.resume({
            credentials: {
              tenantId: identity.tenant_id,
              storeScope: identity.scope_key,
              sessionKey: input.session_key,
              holderId: input.holder_id,
            },
            operationId: input.operation_id,
            workspaceRoot: input.workspace_root,
            ...(input.lease_ttl_ms === undefined
              ? {}
              : { leaseTtlMs: input.lease_ttl_ms }),
          });
          return productServiceSuccess({
            contract_version: "aionis_execution_session_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            session: result.session,
            episode: result.episode?.episode ?? null,
            current_state_snapshot: result.current_state_snapshot,
            current_state_snapshot_v2:
              result.current_state_snapshot_v2,
            episode_event: result.episode?.event ?? null,
            current_state: result.current_state,
            resumed: true,
          });
        }
        const leaseCredentials = credentials({ identity, input });
        if (input.event_kind === "session_renew") {
          const result =
            await dependencies.executionTurnService.runLeased({
              credentials: leaseCredentials,
              leaseOperationId: input.operation_id,
              operationBinding: input,
              ...(input.lease_ttl_ms === undefined
                ? {}
                : { leaseTtlMs: input.lease_ttl_ms }),
              execute: async () => null,
            });
          return productServiceSuccess({
            contract_version: "aionis_execution_session_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            session: result.session,
            current_state: result.current_state,
          });
        }
        if (input.event_kind === "session_handoff") {
          const result = await dependencies.executionTurnService.handoff({
            credentials: leaseCredentials,
            operationId: input.operation_id,
            toHolderId: input.to_holder_id,
            evidenceRefs: input.evidence_refs,
            ...(input.lease_ttl_ms === undefined
              ? {}
              : { leaseTtlMs: input.lease_ttl_ms }),
          });
          return productServiceSuccess({
            contract_version: "aionis_execution_session_result_v1",
            event_kind: input.event_kind,
            tenant_id: identity.tenant_id,
            scope: identity.scope,
            session: result,
          });
        }
        const result = await dependencies.executionTurnService.release({
          credentials: leaseCredentials,
          operationId: input.operation_id,
        });
        return productServiceSuccess({
          contract_version: "aionis_execution_session_result_v1",
          event_kind: input.event_kind,
          tenant_id: identity.tenant_id,
          scope: identity.scope,
          session: result,
        });
      } catch (error) {
        return sessionFailure(error);
      }
    },
  };
}
