export const REPLAY_STORE_ACCESS_CAPABILITY_VERSION = 1 as const;

export type ReplayNodeRow = {
  id: string;
  type: "event" | "entity" | "topic" | "rule" | "evidence" | "concept" | "procedure" | "self_model";
  title: string | null;
  text_summary: string | null;
  slots: any;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
};

export type ReplayRunNodeRow = ReplayNodeRow;

export type ReplayPlaybookRow = ReplayNodeRow & {
  version_num: number;
  playbook_status: string | null;
  playbook_id: string | null;
};

export type ReplayVisibilityArgs = {
  consumerAgentId: string | null;
  consumerTeamId: string | null;
};

export interface ReplayStoreAccess {
  readonly capability_version: typeof REPLAY_STORE_ACCESS_CAPABILITY_VERSION;
  findRunNodeByRunId(scope: string, runId: string, visibility: ReplayVisibilityArgs): Promise<ReplayRunNodeRow | null>;
  findStepNodeById(scope: string, stepId: string, visibility: ReplayVisibilityArgs): Promise<ReplayNodeRow | null>;
  findLatestStepNodeByIndex(
    scope: string,
    runId: string,
    stepIndex: number,
    visibility: ReplayVisibilityArgs,
  ): Promise<ReplayNodeRow | null>;
  listReplayNodesByRunId(scope: string, runId: string, visibility: ReplayVisibilityArgs): Promise<ReplayNodeRow[]>;
  listReplayPlaybookVersions(scope: string, playbookId: string, visibility: ReplayVisibilityArgs): Promise<ReplayPlaybookRow[]>;
  getReplayPlaybookVersion(
    scope: string,
    playbookId: string,
    version: number,
    visibility: ReplayVisibilityArgs,
  ): Promise<ReplayPlaybookRow | null>;
}

export function assertReplayStoreAccessContract(access: ReplayStoreAccess): void {
  if (access.capability_version !== REPLAY_STORE_ACCESS_CAPABILITY_VERSION) {
    throw new Error(
      `replay access capability version mismatch: expected=${REPLAY_STORE_ACCESS_CAPABILITY_VERSION} got=${String(
        (access as any).capability_version,
      )}`,
    );
  }
  const requiredMethods = [
    "findRunNodeByRunId",
    "findStepNodeById",
    "findLatestStepNodeByIndex",
    "listReplayNodesByRunId",
    "listReplayPlaybookVersions",
    "getReplayPlaybookVersion",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof (access as any)[method] !== "function") {
      throw new Error(`replay access missing required method: ${method}`);
    }
  }
}
