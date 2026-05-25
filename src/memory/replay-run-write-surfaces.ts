import { buildAionisUri } from "./uri.js";

export function runClientId(runId: string): string {
  return `replay:run:${runId}`;
}

export function stepClientId(runId: string, stepId: string): string {
  return `replay:step:${runId}:${stepId}`;
}

export function stepResultClientId(runId: string, stepId: string | null, status: string): string {
  return `replay:step_result:${runId}:${stepId ?? "na"}:${status}`;
}

export function runEndClientId(runId: string): string {
  return `replay:run_end:${runId}`;
}

export function buildReplayRunStartWriteRequest(args: {
  tenantId: string;
  scope: string;
  actor: string;
  goal: string;
  runId: string;
  nowIso: string;
  writeIdentity: Record<string, unknown>;
  metadata: Record<string, unknown>;
  contextSnapshotRef: string | null;
  contextSnapshotHash: string | null;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: args.goal,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: runClientId(args.runId),
        type: "event" as const,
        title: `Replay Run ${args.runId.slice(0, 8)}`,
        text_summary: args.goal,
        slots: {
          replay_kind: "run",
          run_id: args.runId,
          goal: args.goal,
          status: "started",
          started_at: args.nowIso,
          context_snapshot_ref: args.contextSnapshotRef,
          context_snapshot_hash: args.contextSnapshotHash,
          metadata: args.metadata,
        },
      },
    ],
    edges: [],
  };
}

export function buildReplayRunStartResult(args: {
  tenantId: string;
  scope: string;
  runId: string;
  runNodeId: string | null;
  commitId: string;
  commitUri: string;
  commitHash: string;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    run_id: args.runId,
    status: "started",
    run_node_id: args.runNodeId,
    run_uri:
      args.runNodeId != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: "event",
            id: args.runNodeId,
          })
        : null,
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
  };
}

export function buildReplayStepBeforeWriteRequest(args: {
  tenantId: string;
  scope: string;
  actor: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  decisionId: string | null;
  toolName: string;
  toolInput: unknown;
  expectedOutputSignature: unknown;
  preconditions: unknown[];
  retryPolicy: Record<string, unknown> | null;
  safetyLevel: string;
  metadata: Record<string, unknown>;
  runNodeId: string;
  writeIdentity: Record<string, unknown>;
}) {
  const stepCid = stepClientId(args.runId, args.stepId);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: `step before ${args.toolName}`,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: stepCid,
        type: "procedure" as const,
        title: `Step ${args.stepIndex}: ${args.toolName}`,
        text_summary: `Replay step ${args.stepIndex} prepared for ${args.toolName}`,
        slots: {
          replay_kind: "step",
          phase: "before",
          run_id: args.runId,
          step_id: args.stepId,
          decision_id: args.decisionId,
          step_index: args.stepIndex,
          tool_name: args.toolName,
          tool_input: args.toolInput,
          expected_output_signature: args.expectedOutputSignature,
          preconditions: args.preconditions,
          retry_policy: args.retryPolicy,
          safety_level: args.safetyLevel,
          status: "pending",
          metadata: args.metadata,
        },
      },
    ],
    edges: [
      {
        type: "part_of" as const,
        src: { client_id: stepCid },
        dst: { id: args.runNodeId },
      },
    ],
  };
}

export function buildReplayStepBeforeResult(args: {
  tenantId: string;
  scope: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  stepNodeId: string | null;
  commitId: string;
  commitUri: string;
  commitHash: string;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    run_id: args.runId,
    step_id: args.stepId,
    step_index: args.stepIndex,
    status: "pending",
    step_node_id: args.stepNodeId,
    step_uri:
      args.stepNodeId != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: "procedure",
            id: args.stepNodeId,
          })
        : null,
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
  };
}

export function buildReplayStepAfterWriteRequest(args: {
  tenantId: string;
  scope: string;
  actor: string;
  runId: string;
  stepId: string | null;
  stepIndex: number | null;
  status: string;
  outputSignature: unknown;
  postconditions: unknown[];
  artifactRefs: unknown[];
  repairApplied: boolean;
  repairNote: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  runNodeId: string;
  stepNodeId: string | null;
  writeIdentity: Record<string, unknown>;
}) {
  const resultCid = stepResultClientId(args.runId, args.stepId, args.status);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: `step after ${args.status}`,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: resultCid,
        type: "evidence" as const,
        title: `Step ${args.stepIndex ?? "?"} ${args.status}`,
        text_summary: args.error ?? args.repairNote ?? `Replay step outcome: ${args.status}`,
        slots: {
          replay_kind: "step_result",
          phase: "after",
          run_id: args.runId,
          step_id: args.stepId,
          step_index: args.stepIndex,
          status: args.status,
          output_signature: args.outputSignature,
          postconditions: args.postconditions,
          artifact_refs: args.artifactRefs,
          repair_applied: args.repairApplied,
          repair_note: args.repairNote,
          error: args.error,
          metadata: args.metadata,
        },
      },
    ],
    edges: [
      {
        type: "part_of" as const,
        src: { client_id: resultCid },
        dst: { id: args.runNodeId },
      },
      ...(args.stepNodeId
        ? [
            {
              type: "related_to" as const,
              src: { client_id: resultCid },
              dst: { id: args.stepNodeId },
            },
          ]
        : []),
    ],
  };
}

export function buildReplayStepAfterResult(args: {
  tenantId: string;
  scope: string;
  runId: string;
  stepId: string | null;
  status: string;
  repairApplied: boolean;
  resultNodeId: string | null;
  commitId: string;
  commitUri: string;
  commitHash: string;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    run_id: args.runId,
    step_id: args.stepId,
    status: args.status,
    replay_fallback_triggered: args.repairApplied,
    step_result_node_id: args.resultNodeId,
    step_result_uri:
      args.resultNodeId != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: "evidence",
            id: args.resultNodeId,
          })
        : null,
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
  };
}

export function buildReplayRunEndWriteRequest(args: {
  tenantId: string;
  scope: string;
  actor: string;
  runId: string;
  status: string;
  summary: string | null;
  successCriteria: Record<string, unknown>;
  metrics: Record<string, unknown>;
  metadata: Record<string, unknown>;
  endedAt: string;
  runNodeId: string;
  writeIdentity: Record<string, unknown>;
}) {
  const endCid = runEndClientId(args.runId);
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: args.summary ?? `run ${args.status}`,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: endCid,
        type: "event" as const,
        title: `Replay Run End ${args.status}`,
        text_summary: args.summary ?? `Replay run ended with status=${args.status}`,
        slots: {
          replay_kind: "run_end",
          run_id: args.runId,
          status: args.status,
          summary: args.summary,
          success_criteria: args.successCriteria,
          metrics: args.metrics,
          metadata: args.metadata,
          ended_at: args.endedAt,
        },
      },
    ],
    edges: [
      {
        type: "part_of" as const,
        src: { client_id: endCid },
        dst: { id: args.runNodeId },
      },
    ],
  };
}

export function buildReplayRunEndResult(args: {
  tenantId: string;
  scope: string;
  runId: string;
  status: string;
  endNodeId: string | null;
  commitId: string;
  commitUri: string;
  commitHash: string;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    run_id: args.runId,
    status: args.status,
    run_end_node_id: args.endNodeId,
    run_end_uri:
      args.endNodeId != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: "event",
            id: args.endNodeId,
          })
        : null,
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
  };
}
