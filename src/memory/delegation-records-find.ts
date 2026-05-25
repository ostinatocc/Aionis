import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  DelegationRecordsAggregateRequest,
  DelegationRecordsFindRequest,
  ExecutionDelegationRecordsSummarySchema,
  type DelegationRecordsAggregateInput,
  type DelegationRecordsAggregateResponse,
  type DelegationRecordFindEntry,
  type DelegationRecordsFindInput,
  type DelegationRecordsFindResponse,
} from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import { buildAionisUri } from "./uri.js";

type NormalizedDelegationRecordsQueryInput = {
  tenant_id?: string;
  scope?: string;
  record_id?: string;
  run_id?: string;
  handoff_anchor?: string;
  handoff_uri?: string;
  route_role?: string;
  task_family?: string;
  family_scope?: string;
  record_mode?: "memory_only" | "packet_backed";
  memory_lane?: "private" | "shared";
  consumer_agent_id?: string;
  consumer_team_id?: string;
  include_payload: boolean;
  limit: number;
  offset: number;
};

type ParsedDelegationRecordEntry = {
  uri: string;
  node_id: string;
  client_id: string | null;
  record_id: string | null;
  title: string | null;
  text_summary: string | null;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
  run_id: string | null;
  handoff_anchor: string | null;
  handoff_uri: string | null;
  route_role: string;
  task_family: string | null;
  family_scope: string;
  record_mode: "memory_only" | "packet_backed";
  tags: string[];
  delegation_records_v1: ReturnType<typeof ExecutionDelegationRecordsSummarySchema.parse>;
  execution_side_outputs: {
    result_present: boolean;
    artifact_count: number;
    evidence_count: number;
    execution_state_v1_present: boolean;
    execution_packet_v1_present: boolean;
  };
  execution_result_summary: Record<string, unknown> | null;
  execution_artifacts: Array<Record<string, unknown>>;
  execution_evidence: Array<Record<string, unknown>>;
  execution_state_v1: Record<string, unknown> | null;
  execution_packet_v1: Record<string, unknown> | null;
};

type CollectedDelegationRecords = {
  entries: ParsedDelegationRecordEntry[];
  invalidRecordCount: number;
  recordModes: string[];
  memoryLanes: string[];
  routeRoles: string[];
  taskFamilies: string[];
  missingRecordTypes: string[];
  returnStatuses: string[];
  artifactSources: string[];
  runIds: Set<string>;
  handoffAnchors: Set<string>;
  packetCount: number;
  returnCount: number;
  artifactRoutingCount: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = typeof item === "string" ? item.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function incrementCount(map: Map<string, number>, key: string) {
  const normalized = key.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function toSortedCountRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Array.from(map.keys()).sort()) {
    out[key] = map.get(key)!;
  }
  return out;
}

function buildSortedCounts(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) incrementCount(counts, value);
  return toSortedCountRecord(counts);
}

function normalizeDelegationRecordsQueryInput(
  parsed: Pick<
    DelegationRecordsFindInput,
    | "tenant_id"
    | "scope"
    | "record_id"
    | "run_id"
    | "handoff_anchor"
    | "handoff_uri"
    | "route_role"
    | "task_family"
    | "family_scope"
    | "record_mode"
    | "memory_lane"
    | "consumer_agent_id"
    | "consumer_team_id"
    | "limit"
    | "offset"
  > & { include_payload?: boolean },
): NormalizedDelegationRecordsQueryInput {
  return {
    tenant_id: parsed.tenant_id?.trim(),
    scope: parsed.scope?.trim(),
    record_id: parsed.record_id?.trim(),
    run_id: parsed.run_id?.trim(),
    handoff_anchor: parsed.handoff_anchor?.trim(),
    handoff_uri: parsed.handoff_uri?.trim(),
    route_role: parsed.route_role?.trim(),
    task_family: parsed.task_family?.trim(),
    family_scope: parsed.family_scope?.trim(),
    record_mode: parsed.record_mode,
    memory_lane: parsed.memory_lane,
    consumer_agent_id: parsed.consumer_agent_id?.trim(),
    consumer_team_id: parsed.consumer_team_id?.trim(),
    include_payload: parsed.include_payload === true,
    limit: parsed.limit,
    offset: parsed.offset,
  };
}

function buildDelegationRecordSlotsContains(input: NormalizedDelegationRecordsQueryInput) {
  const out: Record<string, unknown> = {
    summary_kind: "delegation_records",
  };
  if (input.record_id) out.record_id = input.record_id;
  if (input.run_id) out.run_id = input.run_id;
  if (input.handoff_anchor) out.handoff_anchor = input.handoff_anchor;
  if (input.handoff_uri) out.handoff_uri = input.handoff_uri;
  if (input.route_role) out.route_role = input.route_role;
  if (input.task_family) out.task_family = input.task_family;
  if (input.family_scope) out.family_scope = input.family_scope;
  if (input.record_mode) out.record_mode = input.record_mode;
  return out;
}

function buildDelegationRecordFiltersApplied(input: NormalizedDelegationRecordsQueryInput) {
  const filters: string[] = [];
  if (input.record_id) filters.push("record_id");
  if (input.run_id) filters.push("run_id");
  if (input.handoff_anchor) filters.push("handoff_anchor");
  if (input.handoff_uri) filters.push("handoff_uri");
  if (input.route_role) filters.push("route_role");
  if (input.task_family) filters.push("task_family");
  if (input.family_scope) filters.push("family_scope");
  if (input.record_mode) filters.push("record_mode");
  if (input.memory_lane) filters.push("memory_lane");
  return filters;
}

async function queryDelegationRecordRowsLite(
  liteWriteStore: LiteWriteStore,
  scope: string,
  input: NormalizedDelegationRecordsQueryInput,
) {
  return await liteWriteStore.findNodes({
    scope,
    type: "event",
    memoryLane: input.memory_lane,
    slotsContains: buildDelegationRecordSlotsContains(input),
    consumerAgentId: input.consumer_agent_id ?? null,
    consumerTeamId: input.consumer_team_id ?? null,
    limit: input.limit,
    offset: input.offset,
  });
}

function parseDelegationRecordRow(
  row: Awaited<ReturnType<LiteWriteStore["findNodes"]>>["rows"][number],
  tenantId: string,
  scope: string,
): ParsedDelegationRecordEntry | null {
  const slots = asRecord(row.slots);
  const delegationRecords = ExecutionDelegationRecordsSummarySchema.safeParse(slots.delegation_records_v1);
  if (!delegationRecords.success) return null;

  const parsedDelegation = delegationRecords.data;
  const runId = typeof slots.run_id === "string" ? slots.run_id : null;
  const handoffAnchor = typeof slots.handoff_anchor === "string" ? slots.handoff_anchor : null;
  const handoffUri = typeof slots.handoff_uri === "string" ? slots.handoff_uri : null;
  const routeRole = typeof slots.route_role === "string" ? slots.route_role : parsedDelegation.route_role;
  const taskFamily =
    typeof slots.task_family === "string"
      ? slots.task_family
      : parsedDelegation.delegation_packets[0]?.task_family ?? null;
  const familyScope =
    typeof slots.family_scope === "string"
      ? slots.family_scope
      : parsedDelegation.delegation_packets[0]?.family_scope ?? scope;
  const recordMode =
    typeof slots.record_mode === "string" && (slots.record_mode === "memory_only" || slots.record_mode === "packet_backed")
      ? slots.record_mode
      : parsedDelegation.record_mode;
  const tags = stringList(slots.tags, 32);
  const executionArtifacts = Array.isArray(slots.execution_artifacts)
    ? slots.execution_artifacts.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const executionEvidence = Array.isArray(slots.execution_evidence)
    ? slots.execution_evidence.filter(
        (value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const executionResultSummary =
    slots.execution_result_summary && typeof slots.execution_result_summary === "object" && !Array.isArray(slots.execution_result_summary)
      ? (slots.execution_result_summary as Record<string, unknown>)
      : null;
  const executionStateV1 =
    slots.execution_state_v1 && typeof slots.execution_state_v1 === "object" && !Array.isArray(slots.execution_state_v1)
      ? (slots.execution_state_v1 as Record<string, unknown>)
      : null;
  const executionPacketV1 =
    slots.execution_packet_v1 && typeof slots.execution_packet_v1 === "object" && !Array.isArray(slots.execution_packet_v1)
      ? (slots.execution_packet_v1 as Record<string, unknown>)
      : null;

  return {
    uri: buildAionisUri({
      tenant_id: tenantId,
      scope,
      type: "event",
      id: row.id,
    }),
    node_id: row.id,
    client_id: row.client_id,
    record_id: typeof slots.record_id === "string" ? slots.record_id : null,
    title: row.title,
    text_summary: row.text_summary,
    memory_lane: row.memory_lane,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    commit_id: row.commit_id,
    run_id: runId,
    handoff_anchor: handoffAnchor,
    handoff_uri: handoffUri,
    route_role: routeRole,
    task_family: taskFamily,
    family_scope: familyScope,
    record_mode: recordMode,
    tags,
    delegation_records_v1: parsedDelegation,
    execution_side_outputs: {
      result_present: executionResultSummary !== null,
      artifact_count: executionArtifacts.length,
      evidence_count: executionEvidence.length,
      execution_state_v1_present: executionStateV1 !== null,
      execution_packet_v1_present: executionPacketV1 !== null,
    },
    execution_result_summary: executionResultSummary,
    execution_artifacts: executionArtifacts,
    execution_evidence: executionEvidence,
    execution_state_v1: executionStateV1,
    execution_packet_v1: executionPacketV1,
  };
}

function collectDelegationRecordEntries(
  rows: Awaited<ReturnType<LiteWriteStore["findNodes"]>>["rows"],
  tenantId: string,
  scope: string,
): CollectedDelegationRecords {
  const entries: ParsedDelegationRecordEntry[] = [];
  const recordModes: string[] = [];
  const memoryLanes: string[] = [];
  const routeRoles: string[] = [];
  const taskFamilies: string[] = [];
  const missingRecordTypes: string[] = [];
  const returnStatuses: string[] = [];
  const artifactSources: string[] = [];
  const runIds = new Set<string>();
  const handoffAnchors = new Set<string>();
  let packetCount = 0;
  let returnCount = 0;
  let artifactRoutingCount = 0;
  let invalidRecordCount = 0;

  for (const row of rows) {
    const entry = parseDelegationRecordRow(row, tenantId, scope);
    if (!entry) {
      invalidRecordCount += 1;
      continue;
    }
    entries.push(entry);
    packetCount += entry.delegation_records_v1.packet_count;
    returnCount += entry.delegation_records_v1.return_count;
    artifactRoutingCount += entry.delegation_records_v1.artifact_routing_count;
    recordModes.push(entry.record_mode);
    memoryLanes.push(entry.memory_lane);
    routeRoles.push(entry.route_role);
    if (entry.task_family) taskFamilies.push(entry.task_family);
    if (entry.run_id) runIds.add(entry.run_id);
    if (entry.handoff_anchor) handoffAnchors.add(entry.handoff_anchor);
    missingRecordTypes.push(...entry.delegation_records_v1.missing_record_types);
    returnStatuses.push(...entry.delegation_records_v1.delegation_returns.map((record) => record.status));
    artifactSources.push(...entry.delegation_records_v1.artifact_routing_records.map((record) => record.source));
  }

  return {
    entries,
    invalidRecordCount,
    recordModes,
    memoryLanes,
    routeRoles,
    taskFamilies,
    missingRecordTypes,
    returnStatuses,
    artifactSources,
    runIds,
    handoffAnchors,
    packetCount,
    returnCount,
    artifactRoutingCount,
  };
}

function buildDelegationRecordsFindEntries(
  entries: ParsedDelegationRecordEntry[],
  includePayload: boolean,
): DelegationRecordFindEntry[] {
  return entries.map((entry) => {
    const out: DelegationRecordFindEntry = {
      uri: entry.uri,
      node_id: entry.node_id,
      client_id: entry.client_id,
      record_id: entry.record_id,
      title: entry.title,
      text_summary: entry.text_summary,
      memory_lane: entry.memory_lane,
      producer_agent_id: entry.producer_agent_id,
      owner_agent_id: entry.owner_agent_id,
      owner_team_id: entry.owner_team_id,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      commit_id: entry.commit_id,
      run_id: entry.run_id,
      handoff_anchor: entry.handoff_anchor,
      handoff_uri: entry.handoff_uri,
      route_role: entry.route_role,
      task_family: entry.task_family,
      family_scope: entry.family_scope,
      record_mode: entry.record_mode,
      tags: entry.tags,
      delegation_records_v1: entry.delegation_records_v1,
      execution_side_outputs: entry.execution_side_outputs,
    };
    if (includePayload) {
      out.execution_result_summary = entry.execution_result_summary;
      out.execution_artifacts = entry.execution_artifacts;
      out.execution_evidence = entry.execution_evidence;
      out.execution_state_v1 = entry.execution_state_v1;
      out.execution_packet_v1 = entry.execution_packet_v1;
    }
    return out;
  });
}

function buildRouteRoleBuckets(entries: ParsedDelegationRecordEntry[]) {
  const buckets = new Map<string, {
    recordCount: number;
    packetCount: number;
    returnCount: number;
    artifactRoutingCount: number;
    recordModes: Map<string, number>;
    taskFamilies: Map<string, number>;
    returnStatuses: Map<string, number>;
    artifactSources: Map<string, number>;
  }>();

  for (const entry of entries) {
    const key = entry.route_role;
    if (!buckets.has(key)) {
      buckets.set(key, {
        recordCount: 0,
        packetCount: 0,
        returnCount: 0,
        artifactRoutingCount: 0,
        recordModes: new Map<string, number>(),
        taskFamilies: new Map<string, number>(),
        returnStatuses: new Map<string, number>(),
        artifactSources: new Map<string, number>(),
      });
    }
    const bucket = buckets.get(key)!;
    bucket.recordCount += 1;
    bucket.packetCount += entry.delegation_records_v1.packet_count;
    bucket.returnCount += entry.delegation_records_v1.return_count;
    bucket.artifactRoutingCount += entry.delegation_records_v1.artifact_routing_count;
    incrementCount(bucket.recordModes, entry.record_mode);
    if (entry.task_family) incrementCount(bucket.taskFamilies, entry.task_family);
    for (const record of entry.delegation_records_v1.delegation_returns) incrementCount(bucket.returnStatuses, record.status);
    for (const record of entry.delegation_records_v1.artifact_routing_records) incrementCount(bucket.artifactSources, record.source);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => b[1].recordCount - a[1].recordCount || a[0].localeCompare(b[0]))
    .map(([key, bucket]) => ({
      key,
      record_count: bucket.recordCount,
      packet_count: bucket.packetCount,
      return_count: bucket.returnCount,
      artifact_routing_count: bucket.artifactRoutingCount,
      record_mode_counts: toSortedCountRecord(bucket.recordModes),
      task_family_counts: toSortedCountRecord(bucket.taskFamilies),
      return_status_counts: toSortedCountRecord(bucket.returnStatuses),
      artifact_source_counts: toSortedCountRecord(bucket.artifactSources),
    }));
}

function buildTaskFamilyBuckets(entries: ParsedDelegationRecordEntry[]) {
  const buckets = new Map<string, {
    recordCount: number;
    packetCount: number;
    returnCount: number;
    artifactRoutingCount: number;
    recordModes: Map<string, number>;
    routeRoles: Map<string, number>;
    returnStatuses: Map<string, number>;
    artifactSources: Map<string, number>;
  }>();

  for (const entry of entries) {
    if (!entry.task_family) continue;
    const key = entry.task_family;
    if (!buckets.has(key)) {
      buckets.set(key, {
        recordCount: 0,
        packetCount: 0,
        returnCount: 0,
        artifactRoutingCount: 0,
        recordModes: new Map<string, number>(),
        routeRoles: new Map<string, number>(),
        returnStatuses: new Map<string, number>(),
        artifactSources: new Map<string, number>(),
      });
    }
    const bucket = buckets.get(key)!;
    bucket.recordCount += 1;
    bucket.packetCount += entry.delegation_records_v1.packet_count;
    bucket.returnCount += entry.delegation_records_v1.return_count;
    bucket.artifactRoutingCount += entry.delegation_records_v1.artifact_routing_count;
    incrementCount(bucket.recordModes, entry.record_mode);
    incrementCount(bucket.routeRoles, entry.route_role);
    for (const record of entry.delegation_records_v1.delegation_returns) incrementCount(bucket.returnStatuses, record.status);
    for (const record of entry.delegation_records_v1.artifact_routing_records) incrementCount(bucket.artifactSources, record.source);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => b[1].recordCount - a[1].recordCount || a[0].localeCompare(b[0]))
    .map(([key, bucket]) => ({
      key,
      record_count: bucket.recordCount,
      packet_count: bucket.packetCount,
      return_count: bucket.returnCount,
      artifact_routing_count: bucket.artifactRoutingCount,
      record_mode_counts: toSortedCountRecord(bucket.recordModes),
      route_role_counts: toSortedCountRecord(bucket.routeRoles),
      return_status_counts: toSortedCountRecord(bucket.returnStatuses),
      artifact_source_counts: toSortedCountRecord(bucket.artifactSources),
    }));
}

function buildTopArtifactRefs(entries: ParsedDelegationRecordEntry[]) {
  const stats = new Map<string, {
    ref: string;
    ref_kind: "artifact" | "evidence";
    count: number;
    sourceCounts: Map<string, number>;
  }>();
  for (const entry of entries) {
    for (const record of entry.delegation_records_v1.artifact_routing_records) {
      const key = `${record.ref_kind}\u0000${record.ref}`;
      if (!stats.has(key)) {
        stats.set(key, {
          ref: record.ref,
          ref_kind: record.ref_kind,
          count: 0,
          sourceCounts: new Map<string, number>(),
        });
      }
      const stat = stats.get(key)!;
      stat.count += 1;
      incrementCount(stat.sourceCounts, record.source);
    }
  }
  return Array.from(stats.values())
    .sort((a, b) => b.count - a.count || a.ref.localeCompare(b.ref))
    .slice(0, 10)
    .map((stat) => ({
      ref: stat.ref,
      ref_kind: stat.ref_kind,
      count: stat.count,
      source_counts: toSortedCountRecord(stat.sourceCounts),
    }));
}

function buildTopStringStats(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) incrementCount(counts, value);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([value, count]) => ({ value, count }));
}

function normalizeReturnStatus(status: string): "completed" | "blocked" | "failed" | "in_progress" | "other" {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return "other";
  if (
    normalized === "passed"
    || normalized === "pass"
    || normalized === "completed"
    || normalized === "complete"
    || normalized === "success"
    || normalized === "succeeded"
    || normalized === "approved"
    || normalized === "resolved"
    || normalized === "ok"
  ) {
    return "completed";
  }
  if (
    normalized === "blocked"
    || normalized === "needs_changes"
    || normalized === "rejected"
    || normalized === "action_required"
    || normalized.includes("block")
  ) {
    return "blocked";
  }
  if (
    normalized === "failed"
    || normalized === "error"
    || normalized === "errored"
    || normalized === "timed_out"
    || normalized === "timeout"
    || normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "aborted"
    || normalized.includes("fail")
  ) {
    return "failed";
  }
  if (
    normalized === "pending"
    || normalized === "queued"
    || normalized === "running"
    || normalized === "in_progress"
    || normalized === "open"
    || normalized.includes("progress")
  ) {
    return "in_progress";
  }
  return "other";
}

function deriveRecordOutcome(entry: ParsedDelegationRecordEntry): "completed" | "blocked" | "failed" | "in_progress" | "missing_return" | "other" {
  if (entry.delegation_records_v1.delegation_returns.length === 0) return "missing_return";
  const normalized = entry.delegation_records_v1.delegation_returns.map((record) => normalizeReturnStatus(record.status));
  if (normalized.includes("blocked")) return "blocked";
  if (normalized.includes("failed")) return "failed";
  if (normalized.includes("in_progress")) return "in_progress";
  if (normalized.includes("completed")) return "completed";
  return "other";
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function patternOutcomePriority(outcome: ReturnType<typeof deriveRecordOutcome>) {
  switch (outcome) {
    case "completed":
      return 5;
    case "in_progress":
      return 4;
    case "blocked":
      return 3;
    case "other":
      return 2;
    case "failed":
      return 1;
    case "missing_return":
      return 0;
  }
}

function shouldReplacePatternSample(
  current: {
    outcome: ReturnType<typeof deriveRecordOutcome>;
    record_mode: "memory_only" | "packet_backed";
    created_at: string;
  } | null,
  next: {
    outcome: ReturnType<typeof deriveRecordOutcome>;
    record_mode: "memory_only" | "packet_backed";
    created_at: string;
  },
) {
  if (!current) return true;
  const outcomeDelta = patternOutcomePriority(next.outcome) - patternOutcomePriority(current.outcome);
  if (outcomeDelta !== 0) return outcomeDelta > 0;
  const recordModeDelta = Number(next.record_mode === "packet_backed") - Number(current.record_mode === "packet_backed");
  if (recordModeDelta !== 0) return recordModeDelta > 0;
  return next.created_at.localeCompare(current.created_at) < 0;
}

function buildTopReusablePatterns(entries: ParsedDelegationRecordEntry[]) {
  const groups = new Map<string, {
    route_role: string;
    task_family: string;
    record_count: number;
    record_mode_counts: Map<string, number>;
    record_outcome_counts: Map<string, number>;
    sample_meta: {
      outcome: ReturnType<typeof deriveRecordOutcome>;
      record_mode: "memory_only" | "packet_backed";
      created_at: string;
    } | null;
    sample_mission: string | null;
    sample_acceptance_checks: string[];
    sample_working_set_files: string[];
    sample_artifact_refs: string[];
  }>();

  for (const entry of entries) {
    if (!entry.task_family) continue;
    const key = `${entry.route_role}\u0000${entry.task_family}`;
    if (!groups.has(key)) {
      const firstPacket = entry.delegation_records_v1.delegation_packets[0] ?? null;
      groups.set(key, {
        route_role: entry.route_role,
        task_family: entry.task_family,
        record_count: 0,
        record_mode_counts: new Map<string, number>(),
        record_outcome_counts: new Map<string, number>(),
        sample_meta: null,
        sample_mission: firstPacket?.mission ?? null,
        sample_acceptance_checks: firstPacket ? [...firstPacket.acceptance_checks] : [],
        sample_working_set_files: firstPacket ? [...firstPacket.working_set] : [],
        sample_artifact_refs: firstPacket ? [...firstPacket.preferred_artifact_refs] : [],
      });
    }
    const group = groups.get(key)!;
    const outcome = deriveRecordOutcome(entry);
    group.record_count += 1;
    incrementCount(group.record_mode_counts, entry.record_mode);
    incrementCount(group.record_outcome_counts, outcome);
    if (shouldReplacePatternSample(group.sample_meta, {
      outcome,
      record_mode: entry.record_mode,
      created_at: entry.created_at,
    })) {
      const firstPacket = entry.delegation_records_v1.delegation_packets[0] ?? null;
      group.sample_meta = {
        outcome,
        record_mode: entry.record_mode,
        created_at: entry.created_at,
      };
      group.sample_mission = firstPacket?.mission ?? null;
      group.sample_acceptance_checks = firstPacket ? [...firstPacket.acceptance_checks] : [];
      group.sample_working_set_files = firstPacket ? [...firstPacket.working_set] : [];
      group.sample_artifact_refs = firstPacket ? [...firstPacket.preferred_artifact_refs] : [];
    }
  }

  return Array.from(groups.values())
    .sort((a, b) =>
      b.record_count - a.record_count
      || (b.record_outcome_counts.get("completed") ?? 0) - (a.record_outcome_counts.get("completed") ?? 0)
      || a.route_role.localeCompare(b.route_role)
      || a.task_family.localeCompare(b.task_family),
    )
    .slice(0, 10)
    .map((group) => ({
      route_role: group.route_role,
      task_family: group.task_family,
      record_count: group.record_count,
      record_mode_counts: toSortedCountRecord(group.record_mode_counts),
      record_outcome_counts: toSortedCountRecord(group.record_outcome_counts),
      sample_mission: group.sample_mission,
      sample_acceptance_checks: group.sample_acceptance_checks,
      sample_working_set_files: group.sample_working_set_files,
      sample_artifact_refs: group.sample_artifact_refs,
    }));
}

function pickSingleScopedValue(counts: Record<string, number>) {
  const entries = Object.entries(counts);
  if (entries.length !== 1) return null;
  return entries[0]?.[0] ?? null;
}

function formatRecommendationScope(routeRole: string | null, taskFamily: string | null) {
  if (routeRole && taskFamily) return `${routeRole} / ${taskFamily}`;
  if (routeRole) return `${routeRole} route`;
  if (taskFamily) return taskFamily;
  return "current delegation slice";
}

function buildDelegationLearningRecommendations(args: {
  matchedRecords: number;
  routeRoleCounts: Record<string, number>;
  taskFamilyCounts: Record<string, number>;
  missingRecordTypeCounts: Record<string, number>;
  recordOutcomeCounts: Record<string, number>;
  recordsWithPayloadArtifacts: number;
  recordsWithPayloadEvidence: number;
  topReusablePatterns: ReturnType<typeof buildTopReusablePatterns>;
}) {
  if (args.matchedRecords <= 0) return [];

  const recommendations: Array<{
    recommendation_kind: "capture_missing_returns" | "review_blocked_pattern" | "increase_artifact_capture" | "promote_reusable_pattern";
    priority: "high" | "medium" | "low";
    route_role: string | null;
    task_family: string | null;
    recommended_action: string;
    rationale: string;
    sample_mission: string | null;
    sample_acceptance_checks: string[];
    sample_working_set_files: string[];
    sample_artifact_refs: string[];
  }> = [];
  const defaultRouteRole = pickSingleScopedValue(args.routeRoleCounts);
  const defaultTaskFamily = pickSingleScopedValue(args.taskFamilyCounts);
  const defaultScope = formatRecommendationScope(defaultRouteRole, defaultTaskFamily);
  const missingReturnCount = args.recordOutcomeCounts.missing_return ?? 0;

  if (missingReturnCount > 0 || (args.missingRecordTypeCounts.delegation_returns ?? 0) > 0) {
    recommendations.push({
      recommendation_kind: "capture_missing_returns",
      priority: missingReturnCount >= Math.ceil(args.matchedRecords / 2) ? "high" : "medium",
      route_role: defaultRouteRole,
      task_family: defaultTaskFamily,
      recommended_action: `Capture delegation returns consistently for ${defaultScope}.`,
      rationale: `${missingReturnCount} matching records are still missing delegation returns, so the learning loop cannot close cleanly.`,
      sample_mission: null,
      sample_acceptance_checks: [],
      sample_working_set_files: [],
      sample_artifact_refs: [],
    });
  }

  for (const pattern of args.topReusablePatterns.slice(0, 3)) {
    const completedCount = pattern.record_outcome_counts.completed ?? 0;
    const blockedCount = pattern.record_outcome_counts.blocked ?? 0;
    const patternScope = formatRecommendationScope(pattern.route_role, pattern.task_family);

    if (blockedCount > 0 && blockedCount >= completedCount) {
      recommendations.push({
        recommendation_kind: "review_blocked_pattern",
        priority: blockedCount >= Math.max(1, completedCount) ? "high" : "medium",
        route_role: pattern.route_role,
        task_family: pattern.task_family,
        recommended_action: `Review the blocked delegation pattern for ${patternScope} before reusing it broadly.`,
        rationale: `${blockedCount} captured records for this pattern ended blocked, so its routing contract still needs tightening.`,
        sample_mission: pattern.sample_mission,
        sample_acceptance_checks: pattern.sample_acceptance_checks,
        sample_working_set_files: pattern.sample_working_set_files,
        sample_artifact_refs: pattern.sample_artifact_refs,
      });
    }
  }

  if (
    args.recordsWithPayloadArtifacts < args.matchedRecords
    || args.recordsWithPayloadEvidence < args.matchedRecords
  ) {
    recommendations.push({
      recommendation_kind: "increase_artifact_capture",
      priority: "medium",
      route_role: defaultRouteRole,
      task_family: defaultTaskFamily,
      recommended_action: `Capture artifacts and evidence more consistently for ${defaultScope}.`,
      rationale: `Only ${args.recordsWithPayloadArtifacts}/${args.matchedRecords} records carried payload artifacts and ${args.recordsWithPayloadEvidence}/${args.matchedRecords} carried payload evidence.`,
      sample_mission: args.topReusablePatterns[0]?.sample_mission ?? null,
      sample_acceptance_checks: args.topReusablePatterns[0]?.sample_acceptance_checks ?? [],
      sample_working_set_files: args.topReusablePatterns[0]?.sample_working_set_files ?? [],
      sample_artifact_refs: args.topReusablePatterns[0]?.sample_artifact_refs ?? [],
    });
  }

  for (const pattern of args.topReusablePatterns.slice(0, 3)) {
    const completedCount = pattern.record_outcome_counts.completed ?? 0;
    if (pattern.record_count < 2 || completedCount <= 0) continue;
    const patternScope = formatRecommendationScope(pattern.route_role, pattern.task_family);
    recommendations.push({
      recommendation_kind: "promote_reusable_pattern",
      priority: completedCount >= pattern.record_count / 2 ? "medium" : "low",
      route_role: pattern.route_role,
      task_family: pattern.task_family,
      recommended_action: `Promote the ${patternScope} delegation pattern into a reusable host recipe.`,
      rationale: `${completedCount} successful captures already include reusable checks, working-set files, and artifact refs for this pattern.`,
      sample_mission: pattern.sample_mission,
      sample_acceptance_checks: pattern.sample_acceptance_checks,
      sample_working_set_files: pattern.sample_working_set_files,
      sample_artifact_refs: pattern.sample_artifact_refs,
    });
  }

  return recommendations.slice(0, 6);
}

function buildDelegationRecordsAggregateSummary(
  collected: CollectedDelegationRecords,
  hasMore: boolean,
  filtersApplied: string[],
) {
  const acceptanceChecks: string[] = [];
  const workingSetFiles: string[] = [];
  const normalizedReturnStatuses: string[] = [];
  const recordOutcomes: string[] = [];
  let recordsWithReturns = 0;
  let recordsWithMissingTypes = 0;
  let recordsWithPayloadResult = 0;
  let recordsWithPayloadArtifacts = 0;
  let recordsWithPayloadEvidence = 0;
  let recordsWithPayloadState = 0;
  let recordsWithPayloadPacket = 0;

  for (const entry of collected.entries) {
    const recordOutcome = deriveRecordOutcome(entry);
    recordOutcomes.push(recordOutcome);
    if (entry.delegation_records_v1.return_count > 0) recordsWithReturns += 1;
    if (entry.delegation_records_v1.missing_record_types.length > 0) recordsWithMissingTypes += 1;
    if (entry.execution_side_outputs.result_present) recordsWithPayloadResult += 1;
    if (entry.execution_side_outputs.artifact_count > 0) recordsWithPayloadArtifacts += 1;
    if (entry.execution_side_outputs.evidence_count > 0) recordsWithPayloadEvidence += 1;
    if (entry.execution_side_outputs.execution_state_v1_present) recordsWithPayloadState += 1;
    if (entry.execution_side_outputs.execution_packet_v1_present) recordsWithPayloadPacket += 1;
    for (const packet of entry.delegation_records_v1.delegation_packets) {
      acceptanceChecks.push(...packet.acceptance_checks);
      workingSetFiles.push(...packet.working_set);
    }
    for (const ret of entry.delegation_records_v1.delegation_returns) {
      normalizedReturnStatuses.push(normalizeReturnStatus(ret.status));
      acceptanceChecks.push(...ret.acceptance_checks);
      workingSetFiles.push(...ret.working_set);
    }
  }

  const recordModeCounts = buildSortedCounts(collected.recordModes);
  const memoryLaneCounts = buildSortedCounts(collected.memoryLanes);
  const routeRoleCounts = buildSortedCounts(collected.routeRoles);
  const taskFamilyCounts = buildSortedCounts(collected.taskFamilies);
  const missingRecordTypeCounts = buildSortedCounts(collected.missingRecordTypes);
  const returnStatusCounts = buildSortedCounts(collected.returnStatuses);
  const normalizedReturnStatusCounts = buildSortedCounts(normalizedReturnStatuses);
  const recordOutcomeCounts = buildSortedCounts(recordOutcomes);
  const artifactSourceCounts = buildSortedCounts(collected.artifactSources);
  const topReusablePatterns = buildTopReusablePatterns(collected.entries);
  const learningRecommendations = buildDelegationLearningRecommendations({
    matchedRecords: collected.entries.length,
    routeRoleCounts,
    taskFamilyCounts,
    missingRecordTypeCounts,
    recordOutcomeCounts,
    recordsWithPayloadArtifacts,
    recordsWithPayloadEvidence,
    topReusablePatterns,
  });

  return {
    summary_version: "delegation_records_aggregate_summary_v1" as const,
    matched_records: collected.entries.length,
    truncated: hasMore,
    invalid_records: collected.invalidRecordCount,
    filters_applied: filtersApplied,
    record_mode_counts: recordModeCounts,
    memory_lane_counts: memoryLaneCounts,
    route_role_counts: routeRoleCounts,
    task_family_counts: taskFamilyCounts,
    missing_record_type_counts: missingRecordTypeCounts,
    return_status_counts: returnStatusCounts,
    normalized_return_status_counts: normalizedReturnStatusCounts,
    record_outcome_counts: recordOutcomeCounts,
    artifact_source_counts: artifactSourceCounts,
    packet_count: collected.packetCount,
    return_count: collected.returnCount,
    artifact_routing_count: collected.artifactRoutingCount,
    run_id_count: collected.runIds.size,
    handoff_anchor_count: collected.handoffAnchors.size,
    records_with_returns: recordsWithReturns,
    records_with_missing_types: recordsWithMissingTypes,
    records_with_payload_result: recordsWithPayloadResult,
    records_with_payload_artifacts: recordsWithPayloadArtifacts,
    records_with_payload_evidence: recordsWithPayloadEvidence,
    records_with_payload_state: recordsWithPayloadState,
    records_with_payload_packet: recordsWithPayloadPacket,
    completion_rate: rate(recordOutcomes.filter((value) => value === "completed").length, collected.entries.length),
    blocked_rate: rate(recordOutcomes.filter((value) => value === "blocked").length, collected.entries.length),
    missing_return_rate: rate(recordOutcomes.filter((value) => value === "missing_return").length, collected.entries.length),
    route_role_buckets: buildRouteRoleBuckets(collected.entries),
    task_family_buckets: buildTaskFamilyBuckets(collected.entries),
    top_reusable_patterns: topReusablePatterns,
    learning_recommendations: learningRecommendations,
    top_artifact_refs: buildTopArtifactRefs(collected.entries),
    top_acceptance_checks: buildTopStringStats(acceptanceChecks),
    top_working_set_files: buildTopStringStats(workingSetFiles),
  };
}

export async function findDelegationRecordsLite(
  liteWriteStore: LiteWriteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
): Promise<DelegationRecordsFindResponse> {
  const parsed = DelegationRecordsFindRequest.parse(body);
  const input = normalizeDelegationRecordsQueryInput(parsed);
  const tenancy = resolveTenantScope(
    { tenant_id: input.tenant_id, scope: input.scope },
    { defaultScope, defaultTenantId },
  );
  const result = await queryDelegationRecordRowsLite(liteWriteStore, tenancy.scope_key, input);
  const collected = collectDelegationRecordEntries(result.rows, tenancy.tenant_id, tenancy.scope_key);

  return {
    summary_version: "delegation_records_find_v1",
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope_key,
    records: buildDelegationRecordsFindEntries(collected.entries, input.include_payload),
    summary: {
      summary_version: "delegation_records_find_summary_v1",
      returned_records: collected.entries.length,
      has_more: result.has_more,
      invalid_records: collected.invalidRecordCount,
      filters_applied: buildDelegationRecordFiltersApplied(input),
      record_mode_counts: buildSortedCounts(collected.recordModes),
      memory_lane_counts: buildSortedCounts(collected.memoryLanes),
      route_role_counts: buildSortedCounts(collected.routeRoles),
      task_family_counts: buildSortedCounts(collected.taskFamilies),
      missing_record_type_counts: buildSortedCounts(collected.missingRecordTypes),
      return_status_counts: buildSortedCounts(collected.returnStatuses),
      artifact_source_counts: buildSortedCounts(collected.artifactSources),
      packet_count: collected.packetCount,
      return_count: collected.returnCount,
      artifact_routing_count: collected.artifactRoutingCount,
      run_id_count: collected.runIds.size,
      handoff_anchor_count: collected.handoffAnchors.size,
    },
  };
}

export async function aggregateDelegationRecordsLite(
  liteWriteStore: LiteWriteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
): Promise<DelegationRecordsAggregateResponse> {
  const parsed = DelegationRecordsAggregateRequest.parse(body);
  const input = normalizeDelegationRecordsQueryInput({
    ...parsed,
    include_payload: false,
    offset: 0,
  } satisfies DelegationRecordsAggregateInput & { include_payload: boolean; offset: number });
  const tenancy = resolveTenantScope(
    { tenant_id: input.tenant_id, scope: input.scope },
    { defaultScope, defaultTenantId },
  );
  const result = await queryDelegationRecordRowsLite(liteWriteStore, tenancy.scope_key, input);
  const collected = collectDelegationRecordEntries(result.rows, tenancy.tenant_id, tenancy.scope_key);

  return {
    summary_version: "delegation_records_aggregate_v1",
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope_key,
    summary: buildDelegationRecordsAggregateSummary(
      collected,
      result.has_more,
      buildDelegationRecordFiltersApplied(input),
    ),
  };
}
