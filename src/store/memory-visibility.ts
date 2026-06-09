export type MemoryVisibilityRow = {
  memory_lane: "private" | "shared";
  owner_agent_id: string | null;
  owner_team_id: string | null;
};

export function memoryNodeVisible(
  row: MemoryVisibilityRow,
  consumerAgentId: string | null,
  consumerTeamId: string | null,
): boolean {
  if (row.memory_lane === "shared") {
    if (!row.owner_team_id) return true;
    return (!!consumerTeamId && row.owner_team_id === consumerTeamId)
      || (!!consumerAgentId && row.owner_agent_id === consumerAgentId);
  }

  return (!!consumerAgentId && row.owner_agent_id === consumerAgentId)
    || (!!consumerTeamId && row.owner_team_id === consumerTeamId);
}

