import type { ReplayNodeRow } from "../store/replay-access.js";
import { buildAionisUri } from "./uri.js";

function asObject(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function buildReplayTimelineEntry(args: {
  tenantId: string;
  scope: string;
  row: ReplayNodeRow;
  replayKind: string;
  commitUri: string | null;
}) {
  return {
    uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
    node_id: args.row.id,
    type: args.row.type,
    replay_kind: args.replayKind,
    title: args.row.title,
    text_summary: args.row.text_summary,
    created_at: args.row.created_at,
    commit_id: args.row.commit_id,
    commit_uri: args.commitUri,
  };
}

export function collectReplayArtifactRefs(stepResultRows: ReplayNodeRow[], includeArtifacts: boolean) {
  if (!includeArtifacts) return [] as string[];
  return stepResultRows.flatMap((row) => {
    const slotsObj = asObject(row.slots);
    const refs = slotsObj?.artifact_refs;
    if (!Array.isArray(refs)) return [];
    return refs.map((v) => toStringOrNull(v)).filter((v): v is string => !!v);
  });
}

export function buildReplayRunGetRunSurface(args: {
  tenantId: string;
  scope: string;
  runId: string;
  runNode: ReplayNodeRow | null;
  lastRunEnd: ReplayNodeRow | null;
  runStatus: string;
  runGoal: string | null;
}) {
  return {
    run_id: args.runId,
    status: args.runStatus,
    goal: args.runGoal,
    run_node_id: args.runNode?.id ?? null,
    run_uri:
      args.runNode?.id != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: args.runNode.type,
            id: args.runNode.id,
          })
        : null,
    started_at: args.runNode?.created_at ?? null,
    ended_at: args.lastRunEnd?.created_at ?? null,
  };
}

export function buildReplayRunGetStepSurface(args: {
  tenantId: string;
  scope: string;
  row: ReplayNodeRow;
  result: ReplayNodeRow | null;
}) {
  const slotsObj = asObject(args.row.slots);
  const sid = toStringOrNull(slotsObj?.step_id) ?? args.row.id;
  const resultSlots = asObject(args.result?.slots);
  return {
    step_id: sid,
    step_index: Number(slotsObj?.step_index ?? 0) || null,
    tool_name: toStringOrNull(slotsObj?.tool_name),
    status: toStringOrNull(resultSlots?.status) ?? "pending",
    safety_level: toStringOrNull(slotsObj?.safety_level),
    repair_applied: Boolean(resultSlots?.repair_applied ?? false),
    preconditions: Array.isArray(slotsObj?.preconditions) ? slotsObj?.preconditions : [],
    postconditions: Array.isArray(resultSlots?.postconditions) ? resultSlots?.postconditions : [],
    artifact_refs: Array.isArray(resultSlots?.artifact_refs) ? resultSlots?.artifact_refs : [],
    step_uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
    created_at: args.row.created_at,
    result_uri:
      args.result != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: args.result.type,
            id: args.result.id,
          })
        : null,
  };
}

export function buildReplayRunGetCounters(args: {
  totalNodes: number;
  stepNodes: number;
  stepResultNodes: number;
  artifactRefs: number;
}) {
  return {
    total_nodes: args.totalNodes,
    step_nodes: args.stepNodes,
    step_result_nodes: args.stepResultNodes,
    artifact_refs: args.artifactRefs,
  };
}

export function buildReplayCompileSlots(args: {
  playbookId: string;
  playbookName: string;
  version: number;
  matchers: Record<string, unknown>;
  successCriteria: Record<string, unknown>;
  riskProfile: string | null | undefined;
  sourceRunId: string;
  stepsTemplate: unknown[];
  summary: Record<string, unknown>;
  metadata: Record<string, unknown>;
  executionContractHints?: Record<string, unknown>;
}) {
  return {
    replay_kind: "playbook",
    playbook_id: args.playbookId,
    name: args.playbookName,
    version: args.version,
    status: "draft",
    matchers: args.matchers,
    success_criteria: args.successCriteria,
    risk_profile: args.riskProfile,
    created_from_run_ids: [args.sourceRunId],
    source_run_id: args.sourceRunId,
    ...(args.executionContractHints ?? {}),
    policy_constraints: {},
    steps_template: args.stepsTemplate,
    compile_summary: args.summary,
    metadata: args.metadata,
  };
}

export function buildReplayCompileWriteRequest(args: {
  tenantId: string;
  scope: string;
  actor: string;
  inputText: string;
  writeIdentity: Record<string, unknown>;
  playbookCid: string;
  playbookName: string;
  textSummary: string;
  slots: Record<string, unknown>;
  runNode: ReplayNodeRow | null;
  stepRows: ReplayNodeRow[];
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: args.inputText,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: args.playbookCid,
        type: "procedure" as const,
        title: args.playbookName,
        text_summary: args.textSummary,
        slots: args.slots,
      },
    ],
    edges: [
      ...(args.runNode
        ? [
            {
              type: "derived_from" as const,
              src: { client_id: args.playbookCid },
              dst: { id: args.runNode.id },
            },
          ]
        : []),
      ...args.stepRows.map((row) => ({
        type: "derived_from" as const,
        src: { client_id: args.playbookCid },
        dst: { id: row.id },
      })),
    ],
  };
}

export function buildReplayCompileResult(args: {
  tenantId: string;
  scope: string;
  playbookId: string;
  version: number;
  sourceRunId: string;
  playbookNodeId: string | null;
  summary: Record<string, unknown>;
  usage: Record<string, unknown>;
  commitId: string;
  commitUri: string;
  commitHash: string | null;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    playbook_id: args.playbookId,
    version: args.version,
    status: "draft",
    source_run_id: args.sourceRunId,
    playbook_node_id: args.playbookNodeId,
    playbook_uri:
      args.playbookNodeId != null
        ? buildAionisUri({
            tenant_id: args.tenantId,
            scope: args.scope,
            type: "procedure",
            id: args.playbookNodeId,
          })
        : null,
    compile_summary: args.summary,
    usage: args.usage,
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
  };
}
