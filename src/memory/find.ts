import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";
import { badRequest } from "../util/http.js";
import { MemoryFindRequest, type MemoryFindInput } from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import { AIONIS_URI_NODE_TYPES, buildAionisUri, parseAionisUri } from "./uri.js";

type NodeRow = {
  id: string;
  type: string;
  client_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots: any;
  tier: string;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: string | null;
  embedding_model: string | null;
  raw_ref: string | null;
  evidence_ref: string | null;
  salience: number;
  importance: number;
  confidence: number;
  last_activated: string | null;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
  topic_state: string | null;
  member_count: number | null;
};

type NodeDTO = {
  uri: string;
  id: string;
  client_id: string | null;
  type: string;
  title: string | null;
  text_summary: string | null;
  topic_state?: string | null;
  member_count?: number | null;
  slots?: unknown;
  slots_preview?: Record<string, unknown> | null;
  tier?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string | null;
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  embedding_status?: string | null;
  embedding_model?: string | null;
  raw_ref?: string | null;
  evidence_ref?: string | null;
  created_at?: string;
  updated_at?: string;
  last_activated?: string | null;
  salience?: number;
  importance?: number;
  confidence?: number;
  commit_id?: string | null;
};

type FindSummary = {
  summary_version: "find_summary_v1";
  returned_nodes: number;
  has_more: boolean;
  type_counts: Record<string, number>;
  tier_counts: Record<string, number>;
  memory_lane_counts: Record<string, number>;
  slots_mode: "full" | "preview" | "none";
  meta_included: boolean;
  filters_applied: string[];
};

function pickSlotsPreview(slots: unknown, maxKeys: number): Record<string, unknown> | null {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return null;
  const obj = slots as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, maxKeys)) out[k] = obj[k];
  return out;
}

function requireCompatibleFilter(field: string, a: string | undefined, b: string | undefined) {
  if (!a || !b) return;
  if (a === b) return;
  badRequest("conflicting_filters", `${field} conflicts with URI`, { field, uri_value: a, request_value: b });
}

function normalizeFindInput(parsed: MemoryFindInput): {
  tenant_id?: string;
  scope?: string;
  type?: string;
  id?: string;
  limit: number;
  offset: number;
  client_id?: string;
  title_contains?: string;
  text_contains?: string;
  memory_lane?: "private" | "shared";
  slots_contains?: Record<string, unknown>;
  consumer_agent_id?: string;
  consumer_team_id?: string;
  include_meta: boolean;
  include_slots: boolean;
  include_slots_preview: boolean;
  slots_preview_keys: number;
} {
  let uriParts: ReturnType<typeof parseAionisUri> | null = null;
  if (parsed.uri) {
    uriParts = parseAionisUri(parsed.uri);
    if (!AIONIS_URI_NODE_TYPES.includes(uriParts.type as (typeof AIONIS_URI_NODE_TYPES)[number])) {
      badRequest("invalid_aionis_uri_type_for_endpoint", "find only accepts node URI types", {
        type: uriParts.type,
        allowed_types: AIONIS_URI_NODE_TYPES,
      });
    }
  }

  const requestTenant = parsed.tenant_id?.trim();
  const requestScope = parsed.scope?.trim();
  const requestType = parsed.type?.trim();
  const requestId = parsed.id?.trim();

  requireCompatibleFilter("tenant_id", uriParts?.tenant_id, requestTenant);
  requireCompatibleFilter("scope", uriParts?.scope, requestScope);
  requireCompatibleFilter("type", uriParts?.type, requestType);
  requireCompatibleFilter("id", uriParts?.id, requestId);

  const titleContains = parsed.title_contains?.trim();
  const textContains = parsed.text_contains?.trim();
  const clientId = parsed.client_id?.trim();
  const consumerAgentId = parsed.consumer_agent_id?.trim();
  const consumerTeamId = parsed.consumer_team_id?.trim();

  return {
    tenant_id: uriParts?.tenant_id ?? requestTenant,
    scope: uriParts?.scope ?? requestScope,
    type: uriParts?.type ?? requestType,
    id: uriParts?.id ?? requestId,
    client_id: clientId || undefined,
    title_contains: titleContains || undefined,
    text_contains: textContains || undefined,
    memory_lane: parsed.memory_lane,
    slots_contains: parsed.slots_contains,
    consumer_agent_id: consumerAgentId || undefined,
    consumer_team_id: consumerTeamId || undefined,
    limit: parsed.limit,
    offset: parsed.offset,
    include_meta: parsed.include_meta,
    include_slots: parsed.include_slots,
    include_slots_preview: parsed.include_slots_preview,
    slots_preview_keys: parsed.slots_preview_keys,
  };
}

function toNodeDto(row: NodeRow, scope: string, tenantId: string, input: ReturnType<typeof normalizeFindInput>): NodeDTO {
  const out: NodeDTO = {
    uri: buildAionisUri({ tenant_id: tenantId, scope, type: row.type, id: row.id }),
    id: row.id,
    client_id: row.client_id,
    type: row.type,
    title: row.title,
    text_summary: row.text_summary,
  };
  if (row.type === "topic") {
    out.topic_state = row.topic_state ?? "active";
    out.member_count = row.member_count;
  }
  if (input.include_slots) {
    out.slots = row.slots;
  } else if (input.include_slots_preview) {
    out.slots_preview = pickSlotsPreview(row.slots, input.slots_preview_keys);
  }
  if (input.include_meta) {
    out.tier = row.tier;
    out.memory_lane = row.memory_lane;
    out.producer_agent_id = row.producer_agent_id;
    out.owner_agent_id = row.owner_agent_id;
    out.owner_team_id = row.owner_team_id;
    out.embedding_status = row.embedding_status;
    out.embedding_model = row.embedding_model;
    out.raw_ref = row.raw_ref;
    out.evidence_ref = row.evidence_ref;
    out.created_at = row.created_at;
    out.updated_at = row.updated_at;
    out.last_activated = row.last_activated;
    out.salience = row.salience;
    out.importance = row.importance;
    out.confidence = row.confidence;
    out.commit_id = row.commit_id;
  }
  return out;
}

function buildSortedCounts(rows: NodeRow[], pick: (row: NodeRow) => string | null | undefined): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = pick(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const key of Array.from(counts.keys()).sort()) out[key] = counts.get(key)!;
  return out;
}

function buildFindSummary(
  rows: NodeRow[],
  input: ReturnType<typeof normalizeFindInput>,
  parsed: MemoryFindInput,
  hasMore: boolean,
): FindSummary {
  const filtersApplied: string[] = [];
  if (parsed.uri) filtersApplied.push("uri");
  if (input.id) filtersApplied.push("id");
  if (input.client_id) filtersApplied.push("client_id");
  if (input.type) filtersApplied.push("type");
  if (input.title_contains) filtersApplied.push("title_contains");
  if (input.text_contains) filtersApplied.push("text_contains");
  if (input.memory_lane) filtersApplied.push("memory_lane");
  if (input.slots_contains) filtersApplied.push("slots_contains");
  if (input.consumer_agent_id) filtersApplied.push("consumer_agent_id");
  if (input.consumer_team_id) filtersApplied.push("consumer_team_id");
  return {
    summary_version: "find_summary_v1",
    returned_nodes: rows.length,
    has_more: hasMore,
    type_counts: buildSortedCounts(rows, (row) => row.type),
    tier_counts: buildSortedCounts(rows, (row) => row.tier),
    memory_lane_counts: buildSortedCounts(rows, (row) => row.memory_lane),
    slots_mode: input.include_slots ? "full" : input.include_slots_preview ? "preview" : "none",
    meta_included: input.include_meta,
    filters_applied: filtersApplied,
  };
}

export async function memoryFindLite(
  liteWriteStore: LiteWriteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
) {
  const parsed = MemoryFindRequest.parse(body);
  const input = normalizeFindInput(parsed);
  const tenancy = resolveTenantScope(
    {
      scope: input.scope,
      tenant_id: input.tenant_id,
    },
    { defaultScope, defaultTenantId },
  );

  const out = await liteWriteStore.findNodes({
    scope: tenancy.scope_key,
    id: input.id ?? null,
    type: input.type ?? null,
    clientId: input.client_id ?? null,
    titleContains: input.title_contains ?? null,
    textContains: input.text_contains ?? null,
    memoryLane: input.memory_lane ?? null,
    slotsContains: input.slots_contains ?? null,
    consumerAgentId: input.consumer_agent_id ?? null,
    consumerTeamId: input.consumer_team_id ?? null,
    limit: input.limit,
    offset: input.offset,
  });
  const rows = out.rows as LiteFindNodeRow[];

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    mode: "find",
    filters: {
      uri: parsed.uri ?? null,
      id: input.id ?? null,
      client_id: input.client_id ?? null,
      type: input.type ?? null,
      title_contains: input.title_contains ?? null,
      text_contains: input.text_contains ?? null,
      memory_lane: input.memory_lane ?? null,
      slots_contains: input.slots_contains ?? null,
      consumer_agent_id: input.consumer_agent_id ?? null,
      consumer_team_id: input.consumer_team_id ?? null,
    },
    nodes: rows.map((row) => toNodeDto(row, tenancy.scope, tenancy.tenant_id, input)),
    find_summary: buildFindSummary(rows, input, parsed, out.has_more),
    page: {
      limit: input.limit,
      offset: input.offset,
      returned: rows.length,
      has_more: out.has_more,
    },
  };
}
