import type {
  AionisExecutionIntrospectRequest,
  AionisExecutionIntrospectResponse,
  AionisReplayPlaybookCompileFromRunRequest,
  AionisReplayPlaybookRunRequest,
  AionisReplayRunEndRequest,
  AionisReplayRunStartRequest,
  AionisReplayStepAfterRequest,
  AionisReplayStepBeforeRequest,
  AionisRetrieveWorkflowContractRequest,
  AionisRetrieveWorkflowContractResponse,
  AionisRuntimeResponse,
  AionisStoreExecutionOutcomeRequest,
  AionisStoreExecutionOutcomeResponse,
  AionisWorkflowContractAuthoritySummary,
} from "./contracts.js";
import { AIONIS_SHARED_ROUTE_PATHS } from "./routes.js";
import type { AionisHttpClient } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function sharedReplayFields(payload: AionisStoreExecutionOutcomeRequest) {
  return {
    tenant_id: payload.tenant_id,
    scope: payload.scope,
    actor: payload.actor,
    consumer_agent_id: payload.consumer_agent_id,
    consumer_team_id: payload.consumer_team_id,
    memory_lane: payload.memory_lane,
    producer_agent_id: payload.producer_agent_id,
    owner_agent_id: payload.owner_agent_id,
    owner_team_id: payload.owner_team_id,
  };
}

function replayPath(kind: "start" | "before" | "after" | "end"): string {
  if (kind === "start") return "/v1/memory/replay/run/start";
  if (kind === "before") return "/v1/memory/replay/step/before";
  if (kind === "after") return "/v1/memory/replay/step/after";
  return "/v1/memory/replay/run/end";
}

export function createStoreExecutionOutcomeMethod(client: AionisHttpClient) {
  return async function storeExecutionOutcome(
    payload: AionisStoreExecutionOutcomeRequest,
  ): Promise<AionisStoreExecutionOutcomeResponse> {
    const started = await client.post<AionisReplayRunStartRequest, AionisRuntimeResponse>({
      path: replayPath("start"),
      payload: {
        ...sharedReplayFields(payload),
        run_id: payload.run_id,
        goal: payload.goal,
        context_snapshot_ref: payload.context_snapshot_ref,
        context_snapshot_hash: payload.context_snapshot_hash,
        metadata: payload.metadata,
      },
    });
    const runId = stringValue(asRecord(started)?.run_id) ?? stringValue(payload.run_id);
    if (!runId) {
      throw new Error("storeExecutionOutcome could not resolve replay run_id from run start response");
    }

    const steps: AionisStoreExecutionOutcomeResponse["steps"] = [];
    for (const [index, step] of (payload.steps ?? []).entries()) {
      const stepIndex = step.step_index ?? index + 1;
      const before = await client.post<AionisReplayStepBeforeRequest, AionisRuntimeResponse>({
        path: replayPath("before"),
        payload: {
          ...sharedReplayFields(payload),
          run_id: runId,
          step_id: step.step_id,
          decision_id: step.decision_id,
          step_index: stepIndex,
          tool_name: step.tool_name,
          tool_input: step.tool_input,
          expected_output_signature: step.expected_output_signature,
          preconditions: step.preconditions,
          retry_policy: step.retry_policy,
          safety_level: step.safety_level,
          metadata: step.metadata,
        },
      });
      const stepId = stringValue(asRecord(before)?.step_id) ?? stringValue(step.step_id);
      const after = await client.post<AionisReplayStepAfterRequest, AionisRuntimeResponse>({
        path: replayPath("after"),
        payload: {
          ...sharedReplayFields(payload),
          run_id: runId,
          step_id: stepId ?? undefined,
          step_index: stepIndex,
          status: step.status,
          output_signature: step.output_signature,
          postconditions: step.postconditions,
          artifact_refs: step.artifact_refs,
          repair_applied: step.repair_applied,
          repair_note: step.repair_note,
          error: step.error,
          metadata: step.metadata,
        },
      });
      steps.push({
        step_index: stepIndex,
        step_id: stringValue(asRecord(after)?.step_id) ?? stepId,
        before,
        after,
      });
    }

    const ended = await client.post<AionisReplayRunEndRequest, AionisRuntimeResponse>({
      path: replayPath("end"),
      payload: {
        ...sharedReplayFields(payload),
        run_id: runId,
        status: payload.status,
        summary: payload.summary,
        success_criteria: payload.success_criteria,
        metrics: payload.metrics,
        metadata: payload.metadata,
      },
    });

    let playbookCompile: AionisRuntimeResponse | null = null;
    let playbookSimulation: AionisRuntimeResponse | null = null;
    if (payload.compile_playbook === true) {
      playbookCompile = await client.post<AionisReplayPlaybookCompileFromRunRequest, AionisRuntimeResponse>({
        path: "/v1/memory/replay/playbooks/compile_from_run",
        payload: {
          ...sharedReplayFields(payload),
          run_id: runId,
          success_criteria: payload.success_criteria,
          metadata: payload.metadata,
          ...(payload.compile ?? {}),
        },
      });
      const playbookId = stringValue(asRecord(playbookCompile)?.playbook_id);
      if (playbookId && payload.simulate_playbook === true) {
        playbookSimulation = await client.post<AionisReplayPlaybookRunRequest, AionisRuntimeResponse>({
          path: "/v1/memory/replay/playbooks/run",
          payload: {
            ...sharedReplayFields(payload),
            playbook_id: playbookId,
            mode: "simulate",
            ...(payload.simulate ?? {}),
          },
        });
      }
    }

    return {
      summary_version: "store_execution_outcome_v1",
      tenant_id: stringValue(asRecord(ended)?.tenant_id) ?? stringValue(asRecord(started)?.tenant_id) ?? payload.tenant_id ?? null,
      scope: stringValue(asRecord(ended)?.scope) ?? stringValue(asRecord(started)?.scope) ?? payload.scope ?? null,
      run_id: runId,
      status: payload.status,
      started,
      steps,
      ended,
      playbook_compile: playbookCompile,
      playbook_simulation: playbookSimulation,
    };
  };
}

function workflowContract(workflow: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(workflow.execution_contract_v1) ?? asRecord(workflow.execution_contract) ?? null;
}

function workflowContractTrust(
  workflow: Record<string, unknown> | null,
  contract: Record<string, unknown> | null,
): string | null {
  return stringValue(workflow?.contract_trust)
    ?? stringValue(contract?.contract_trust)
    ?? stringValue(asRecord(contract?.outcome)?.contract_trust);
}

function workflowAuthorityVisibility(workflow: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(workflow?.authority_visibility) ?? null;
}

function workflowOutcomeContractGate(
  workflow: Record<string, unknown> | null,
  contract: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(workflow?.outcome_contract_gate)
    ?? asRecord(contract?.outcome_contract_gate)
    ?? asRecord(asRecord(contract?.outcome)?.outcome_contract_gate);
}

function buildAuthoritySummary(
  workflow: Record<string, unknown> | null,
  contract: Record<string, unknown> | null,
): AionisWorkflowContractAuthoritySummary {
  const authorityVisibility = workflowAuthorityVisibility(workflow);
  const outcomeContractGate = workflowOutcomeContractGate(workflow, contract);
  const visibilityStatus = stringValue(authorityVisibility?.status);
  const gateStatus = stringValue(outcomeContractGate?.status);
  const outcomeReasons =
    stringList(authorityVisibility?.outcome_contract_reasons).length > 0
      ? stringList(authorityVisibility?.outcome_contract_reasons)
      : stringList(outcomeContractGate?.reasons);
  return {
    summary_version: "workflow_contract_authority_summary_v1",
    contract_trust: workflowContractTrust(workflow, contract),
    status:
      visibilityStatus === "sufficient" || visibilityStatus === "insufficient"
        ? visibilityStatus
        : "unknown",
    allows_authoritative: booleanValue(authorityVisibility?.allows_authoritative),
    allows_stable_promotion: booleanValue(authorityVisibility?.allows_stable_promotion),
    authority_blocked: booleanValue(authorityVisibility?.authority_blocked),
    stable_promotion_blocked: booleanValue(authorityVisibility?.stable_promotion_blocked),
    primary_blocker: stringValue(authorityVisibility?.primary_blocker),
    outcome_contract_status:
      gateStatus === "sufficient" || gateStatus === "insufficient"
        ? gateStatus
        : "unknown",
    outcome_contract_allows_authoritative: booleanValue(outcomeContractGate?.allows_authoritative),
    outcome_contract_reasons: outcomeReasons,
    execution_evidence_status: stringValue(authorityVisibility?.execution_evidence_status),
    execution_evidence_reasons: stringList(authorityVisibility?.execution_evidence_reasons),
    false_confidence_detected: booleanValue(authorityVisibility?.false_confidence_detected),
  };
}

function workflowMatches(workflow: Record<string, unknown>, request: AionisRetrieveWorkflowContractRequest): boolean {
  const contract = workflowContract(workflow);
  const targetFiles = new Set([
    ...stringList(workflow.target_files),
    ...stringList(contract?.target_files),
  ]);
  const anchorId = stringValue(workflow.anchor_id) ?? stringValue(workflow.node_id) ?? stringValue(workflow.id);
  const workflowSignature = stringValue(workflow.workflow_signature) ?? stringValue(contract?.workflow_signature);
  const taskFamily = stringValue(workflow.task_family) ?? stringValue(contract?.task_family);
  const filePath = stringValue(workflow.file_path) ?? stringValue(contract?.file_path);
  return (
    (!request.anchor_id || anchorId === request.anchor_id)
    && (!request.workflow_signature || workflowSignature === request.workflow_signature)
    && (!request.task_family || taskFamily === request.task_family)
    && (!request.file_path || filePath === request.file_path || targetFiles.has(request.file_path))
  );
}

export function createRetrieveWorkflowContractMethod(client: AionisHttpClient) {
  return async function retrieveWorkflowContract(
    payload: AionisRetrieveWorkflowContractRequest,
  ): Promise<AionisRetrieveWorkflowContractResponse> {
    const introspection = await client.post<AionisExecutionIntrospectRequest, AionisExecutionIntrospectResponse>({
      path: AIONIS_SHARED_ROUTE_PATHS.executionIntrospect,
      payload: {
        tenant_id: payload.tenant_id,
        scope: payload.scope,
        consumer_agent_id: payload.consumer_agent_id,
        consumer_team_id: payload.consumer_team_id,
        run_id: payload.run_id,
        session_id: payload.session_id,
        limit: payload.limit,
      },
    });
    const recommended = Array.isArray(introspection.recommended_workflows)
      ? introspection.recommended_workflows.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry)
      : [];
    const candidate = Array.isArray(introspection.candidate_workflows)
      ? introspection.candidate_workflows.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry)
      : [];
    const selectedRecommended = recommended.find((workflow) => workflowMatches(workflow, payload)) ?? null;
    const selectedCandidate = selectedRecommended
      ? null
      : candidate.find((workflow) => workflowMatches(workflow, payload)) ?? null;
    const selectedWorkflow = selectedRecommended ?? selectedCandidate;
    const executionContract = selectedWorkflow ? workflowContract(selectedWorkflow) : null;
    const authorityVisibility = workflowAuthorityVisibility(selectedWorkflow);
    const outcomeContractGate = workflowOutcomeContractGate(selectedWorkflow, executionContract);

    return {
      summary_version: "retrieve_workflow_contract_v1",
      tenant_id: introspection.tenant_id ?? payload.tenant_id ?? null,
      scope: introspection.scope ?? payload.scope ?? null,
      selected_source: selectedRecommended ? "recommended_workflows" : selectedCandidate ? "candidate_workflows" : "none",
      selected_workflow: selectedWorkflow,
      execution_contract_v1: executionContract,
      contract_trust: workflowContractTrust(selectedWorkflow, executionContract),
      outcome_contract_gate: outcomeContractGate,
      authority_visibility: authorityVisibility,
      authority_summary: buildAuthoritySummary(selectedWorkflow, executionContract),
      introspection: payload.include_introspection === true ? introspection : null,
    };
  };
}
