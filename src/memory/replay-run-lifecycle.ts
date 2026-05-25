export function buildReplayPlaybookRunStartBody(input: {
  tenantId: string;
  scope: string;
  actor?: string;
  replayCallIdentity: Record<string, unknown>;
  replayRunId: string;
  playbookId: string;
  playbookVersion: number;
  mode: "simulate" | "strict" | "guided";
  contextSnapshotRef: string;
  executionBackend?: string | null;
  sandboxProjectId?: string | null;
  sensitiveReviewMode?: string | null;
  guidedRepairStrategy?: string | null;
}): Record<string, unknown> {
  return {
    tenant_id: input.tenantId,
    scope: input.scope,
    actor: input.actor,
    ...input.replayCallIdentity,
    run_id: input.replayRunId,
    goal: `Replay playbook ${input.playbookId} v${input.playbookVersion}${input.mode === "simulate" ? " (simulate)" : ""}`,
    context_snapshot_ref: input.contextSnapshotRef,
    metadata: {
      replay_mode: input.mode,
      execution_backend: input.executionBackend ?? null,
      replay_project_id: input.sandboxProjectId ?? null,
      sensitive_review_mode: input.sensitiveReviewMode ?? null,
      source_playbook_id: input.playbookId,
      source_playbook_version: input.playbookVersion,
      guided_repair_strategy: input.mode === "guided" ? input.guidedRepairStrategy ?? null : null,
    },
  };
}

export function buildReplayPlaybookRunEndBody(input: {
  tenantId: string;
  scope: string;
  actor?: string;
  replayCallIdentity: Record<string, unknown>;
  replayRunId: string;
  playbookId: string;
  playbookVersion: number;
  mode: "simulate" | "strict" | "guided";
  runStatus: "success" | "failed" | "partial";
  summary: string;
  metrics: Record<string, unknown>;
  successCriteria?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    tenant_id: input.tenantId,
    scope: input.scope,
    actor: input.actor,
    ...input.replayCallIdentity,
    run_id: input.replayRunId,
    status: input.runStatus,
    summary: input.summary,
    ...(input.successCriteria ? { success_criteria: input.successCriteria } : {}),
    metrics: input.metrics,
    metadata: {
      replay_mode: input.mode,
      source_playbook_id: input.playbookId,
      source_playbook_version: input.playbookVersion,
    },
  };
}
