import type { ExecutionPacketV1, ExecutionStateV1 } from "../execution/index.js";
import { ExecutionDelegationRecordsSummarySchema, type ExecutionDelegationRecordsSummary } from "./schemas.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

type DelegationRecordCandidate = {
  summary: ExecutionDelegationRecordsSummary;
  freshness: string | null;
};

export type DelegationRecordLookup = {
  runId: string | null;
  handoffAnchor: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (next) return next;
  }
  return null;
}

function pushDelegationRecordCandidate(
  value: unknown,
  freshness: string | null,
  out: DelegationRecordCandidate[],
) {
  const parsed = ExecutionDelegationRecordsSummarySchema.safeParse(value);
  if (!parsed.success) return;
  out.push({
    summary: parsed.data,
    freshness,
  });
}

function collectDelegationRecordCandidates(source: unknown, out: DelegationRecordCandidate[]) {
  if (Array.isArray(source)) {
    for (const item of source) {
      collectDelegationRecordCandidates(item, out);
    }
    return;
  }
  if (!source || typeof source !== "object") return;
  const record = asRecord(source);
  const freshness = firstString(record.updated_at, record.created_at);
  pushDelegationRecordCandidate(record, freshness, out);
  pushDelegationRecordCandidate(record.delegation_records_v1, freshness, out);
  const slots = asRecord(record.slots);
  pushDelegationRecordCandidate(slots.delegation_records_v1, freshness, out);
}

function compareDelegationRecordCandidates(a: DelegationRecordCandidate, b: DelegationRecordCandidate) {
  const packetBackedDelta =
    Number(b.summary.record_mode === "packet_backed") - Number(a.summary.record_mode === "packet_backed");
  if (packetBackedDelta !== 0) return packetBackedDelta;
  const returnCountDelta = b.summary.return_count - a.summary.return_count;
  if (returnCountDelta !== 0) return returnCountDelta;
  const packetCountDelta = b.summary.packet_count - a.summary.packet_count;
  if (packetCountDelta !== 0) return packetCountDelta;
  const artifactRoutingCountDelta = b.summary.artifact_routing_count - a.summary.artifact_routing_count;
  if (artifactRoutingCountDelta !== 0) return artifactRoutingCountDelta;
  return (b.freshness ?? "").localeCompare(a.freshness ?? "");
}

export function buildDelegationRecordLookup(args: {
  run_id?: unknown;
  execution_packet?: ExecutionPacketV1 | null;
  execution_state?: ExecutionStateV1 | null;
}): DelegationRecordLookup {
  return {
    runId: firstString(args.run_id),
    handoffAnchor: firstString(
      args.execution_packet?.resume_anchor?.anchor,
      args.execution_state?.resume_anchor?.anchor,
    ),
  };
}

export function pickPreferredDelegationRecordsSummary(source: unknown): ExecutionDelegationRecordsSummary | null {
  const candidates: DelegationRecordCandidate[] = [];
  collectDelegationRecordCandidates(source, candidates);
  if (candidates.length === 0) return null;
  candidates.sort(compareDelegationRecordCandidates);
  return candidates[0]?.summary ?? null;
}

function dedupeDelegationRecordRows(rows: LiteFindNodeRow[], limit: number) {
  const seen = new Set<string>();
  const out: LiteFindNodeRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  out.sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at));
  return out.slice(0, limit);
}

export async function findDelegationRecordNodeRowsLite(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes">;
  scope: string;
  consumerAgentId?: string | null;
  consumerTeamId?: string | null;
  lookup: DelegationRecordLookup;
  limit?: number;
}): Promise<LiteFindNodeRow[]> {
  const limit = Math.max(args.limit ?? 4, 1);
  const lookups: Array<Record<string, unknown>> = [];
  if (args.lookup.runId) {
    lookups.push({
      summary_kind: "delegation_records",
      run_id: args.lookup.runId,
    });
  }
  if (args.lookup.handoffAnchor) {
    lookups.push({
      summary_kind: "delegation_records",
      handoff_anchor: args.lookup.handoffAnchor,
    });
  }
  if (lookups.length === 0) return [];

  const batches = await Promise.all(
    lookups.map((slotsContains) =>
      args.liteWriteStore.findNodes({
        scope: args.scope,
        type: "event",
        slotsContains,
        consumerAgentId: args.consumerAgentId ?? null,
        consumerTeamId: args.consumerTeamId ?? null,
        limit: Math.max(limit, 4),
        offset: 0,
      })),
  );
  return dedupeDelegationRecordRows(
    batches.flatMap((batch) => batch.rows),
    limit,
  );
}

export async function listRecentDelegationRecordNodeRowsLite(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes">;
  scope: string;
  consumerAgentId?: string | null;
  consumerTeamId?: string | null;
  limit?: number;
}): Promise<LiteFindNodeRow[]> {
  const batch = await args.liteWriteStore.findNodes({
    scope: args.scope,
    type: "event",
    slotsContains: {
      summary_kind: "delegation_records",
    },
    consumerAgentId: args.consumerAgentId ?? null,
    consumerTeamId: args.consumerTeamId ?? null,
    limit: Math.max(args.limit ?? 8, 1),
    offset: 0,
  });
  return dedupeDelegationRecordRows(batch.rows, Math.max(args.limit ?? 8, 1));
}
