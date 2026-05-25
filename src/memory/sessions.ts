import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { HttpError } from "../util/http.js";
import {
  MemoryEventWriteRequest,
  MemorySessionCreateRequest,
  MemorySessionsListRequest,
  MemorySessionEventsListRequest,
  type MemoryEventWriteInput,
  type MemorySessionCreateInput,
  type MemorySessionsListInput,
  type MemorySessionEventsListInput,
} from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import { prepareMemoryWrite } from "./write.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { buildAionisUri } from "./uri.js";
import { commitLitePreparedWriteWithProjection } from "./lite-projected-write-commit.js";
import type { LiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";

type SessionWriteOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
  shadowDualWriteEnabled: boolean;
  shadowDualWriteStrict: boolean;
  embedder: EmbeddingProvider | null;
  liteWriteStore: LiteWriteStore;
  learningControlReviewProviders?: LiteLearningControlRuntimeProviders["workflowProjection"];
};

type SessionEventListOptions = {
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
};

type SessionListOptions = SessionEventListOptions;

type SessionRow = {
  id: string;
  client_id?: string | null;
  title: string | null;
  text_summary: string | null;
  memory_lane: "private" | "shared";
  owner_agent_id: string | null;
  owner_team_id: string | null;
  created_at?: string;
  updated_at?: string;
};

type SessionListRow = {
  id: string;
  client_id: string | null;
  title: string | null;
  text_summary: string | null;
  memory_lane: "private" | "shared";
  owner_agent_id: string | null;
  owner_team_id: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
  event_count: number;
};

function sessionKey(v: string): string {
  return encodeURIComponent(v.trim());
}

function sessionClientId(sessionId: string): string {
  return `session:${sessionKey(sessionId)}`;
}

function sessionEventClientId(sessionId: string, eventId: string): string {
  return `session_event:${sessionKey(sessionId)}:${sessionKey(eventId)}`;
}

function sessionIdFromClientId(clientId: string | null | undefined): string | null {
  const raw = typeof clientId === "string" ? clientId.trim() : "";
  if (!raw.startsWith("session:")) return null;
  const encoded = raw.slice("session:".length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function pickSlotsPreview(slots: unknown, maxKeys: number): Record<string, unknown> | null {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return null;
  const obj = slots as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, maxKeys)) out[k] = obj[k];
  return out;
}

function normalizeSessionCreateInput(body: unknown): MemorySessionCreateInput {
  return MemorySessionCreateRequest.parse(body);
}

function normalizeEventWriteInput(body: unknown): MemoryEventWriteInput {
  return MemoryEventWriteRequest.parse(body);
}

function normalizeSessionsListInput(input: unknown): MemorySessionsListInput {
  return MemorySessionsListRequest.parse(input);
}

function normalizeSessionEventsListInput(input: unknown): MemorySessionEventsListInput {
  return MemorySessionEventsListRequest.parse(input);
}

function normalizedIdentity(input: { owner_agent_id?: string; owner_team_id?: string; producer_agent_id?: string }) {
  const ownerAgentId = input.owner_agent_id?.trim() || null;
  const ownerTeamId = input.owner_team_id?.trim() || null;
  const producerAgentId = input.producer_agent_id?.trim() || null;
  return {
    owner_agent_id: ownerAgentId,
    owner_team_id: ownerTeamId,
    producer_agent_id: producerAgentId,
    writer_agent_id: ownerAgentId ?? producerAgentId,
  };
}

function assertSessionWriteAllowed(
  session: SessionRow,
  writer: { writer_agent_id: string | null; owner_team_id: string | null },
): void {
  if (session.memory_lane === "shared") return;
  const agentMatch =
    !!session.owner_agent_id && !!writer.writer_agent_id && session.owner_agent_id === writer.writer_agent_id;
  const teamMatch = !!session.owner_team_id && !!writer.owner_team_id && session.owner_team_id === writer.owner_team_id;
  if (agentMatch || teamMatch) return;
  throw new HttpError(403, "session_owner_mismatch", "cannot append events to a private session owned by another principal");
}

function sessionListItem(
  tenancy: { tenant_id: string; scope: string },
  row: SessionListRow,
  includeMeta: boolean,
): Record<string, unknown> {
  const sessionId = sessionIdFromClientId(row.client_id) ?? row.id;
  const out: Record<string, unknown> = {
    session_id: sessionId,
    node_id: row.id,
    title: row.title,
    text_summary: row.text_summary,
    uri: buildAionisUri({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      type: "topic",
      id: row.id,
    }),
    last_event_at: row.last_event_at,
    event_count: row.event_count,
  };
  if (includeMeta) {
    out.memory_lane = row.memory_lane;
    out.owner_agent_id = row.owner_agent_id;
    out.owner_team_id = row.owner_team_id;
    out.created_at = row.created_at;
    out.updated_at = row.updated_at;
    out.client_id = row.client_id;
  }
  return out;
}

export async function createSession(body: unknown, opts: SessionWriteOptions) {
  const parsed = normalizeSessionCreateInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const sid = parsed.session_id.trim();
  const sessionCid = sessionClientId(sid);
  const title = parsed.title?.trim() || `Session ${sid}`;
  const textSummary = parsed.text_summary?.trim() || title;
  const inputText = parsed.input_text?.trim() || `create session ${sid}`;
  const sessionSlots = {
    system_kind: "session",
    session_id: sid,
    ...(parsed.metadata ?? {}),
    ...(parsed.execution_result_summary ? { execution_result_summary: parsed.execution_result_summary } : {}),
    ...(parsed.execution_evidence ? { execution_evidence: parsed.execution_evidence } : {}),
    ...(parsed.execution_state_v1 ? { execution_state_v1: parsed.execution_state_v1 } : {}),
    ...(parsed.execution_packet_v1 ? { execution_packet_v1: parsed.execution_packet_v1 } : {}),
    ...(parsed.execution_transitions_v1 ? { execution_transitions_v1: parsed.execution_transitions_v1 } : {}),
  };

  const writeReq = {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "session_api",
    input_text: inputText,
    auto_embed: parsed.auto_embed ?? true,
    memory_lane: parsed.memory_lane,
    producer_agent_id: parsed.producer_agent_id,
    owner_agent_id: parsed.owner_agent_id,
    owner_team_id: parsed.owner_team_id,
    nodes: [
      {
        client_id: sessionCid,
        type: "topic" as const,
        title,
        text_summary: textSummary,
        slots: sessionSlots,
      },
    ],
    edges: [],
  };

  const prepared = await prepareMemoryWrite(
    writeReq,
    opts.defaultScope,
    opts.defaultTenantId,
    {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges,
    },
    opts.embedder,
  );
  const out = (
    await commitLitePreparedWriteWithProjection({
      prepared,
      liteWriteStore: opts.liteWriteStore,
      embedder: opts.embedder,
      learningControlReviewProviders: opts.learningControlReviewProviders,
      writeOptions: {
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
        allowCrossScopeEdges: opts.allowCrossScopeEdges,
        shadowDualWriteEnabled: opts.shadowDualWriteEnabled,
        shadowDualWriteStrict: opts.shadowDualWriteStrict,
        associativeLinkOrigin: "session_create",
      },
    })
  ).out;

  const node = out.nodes.find((n) => n.client_id === sessionCid) ?? out.nodes[0] ?? null;
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    session_id: sid,
    session_node_id: node?.id ?? null,
    session_uri:
      node?.id != null
        ? buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "topic",
            id: node.id,
          })
        : null,
    commit_id: out.commit_id,
    commit_uri:
      out.commit_uri ??
      buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "commit",
        id: out.commit_id,
      }),
    commit_hash: out.commit_hash,
    nodes: out.nodes,
    edges: out.edges,
    embedding_backfill: out.embedding_backfill ?? null,
  };
}

export async function writeSessionEvent(body: unknown, opts: SessionWriteOptions) {
  const parsed = normalizeEventWriteInput(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const sid = parsed.session_id.trim();
  const eid = parsed.event_id?.trim() || randomUUID();
  const sessionCid = sessionClientId(sid);
  const eventCid = sessionEventClientId(sid, eid);
  const writerIdentity = normalizedIdentity({
    owner_agent_id: parsed.owner_agent_id,
    owner_team_id: parsed.owner_team_id,
    producer_agent_id: parsed.producer_agent_id,
  });
  const existingSession = await opts.liteWriteStore.findLatestNodeByClientId(tenancy.scope_key, "topic", sessionCid);
  if (existingSession) {
    assertSessionWriteAllowed(existingSession, writerIdentity);
  }
  const effectiveLane = existingSession?.memory_lane ?? parsed.memory_lane;
  const effectiveOwnerAgentId = existingSession?.owner_agent_id ?? parsed.owner_agent_id;
  const effectiveOwnerTeamId = existingSession?.owner_team_id ?? parsed.owner_team_id;
  const title = parsed.title?.trim() || null;
  const textSummary = parsed.text_summary?.trim() || parsed.input_text?.trim() || parsed.title?.trim() || `session event ${eid}`;
  const inputText = parsed.input_text?.trim() || textSummary;
  const sessionSlots = {
    system_kind: "session",
    session_id: sid,
  };
  const eventSlots = {
    system_kind: "session_event",
    session_id: sid,
    event_id: eid,
    ...(parsed.metadata ?? {}),
    ...(parsed.execution_result_summary ? { execution_result_summary: parsed.execution_result_summary } : {}),
    ...(parsed.execution_evidence ? { execution_evidence: parsed.execution_evidence } : {}),
    ...(parsed.execution_state_v1 ? { execution_state_v1: parsed.execution_state_v1 } : {}),
    ...(parsed.execution_packet_v1 ? { execution_packet_v1: parsed.execution_packet_v1 } : {}),
    ...(parsed.execution_transitions_v1 ? { execution_transitions_v1: parsed.execution_transitions_v1 } : {}),
  };

  const writeReq = {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    actor: parsed.actor ?? "event_api",
    input_text: inputText,
    auto_embed: parsed.auto_embed ?? true,
    memory_lane: effectiveLane,
    producer_agent_id: parsed.producer_agent_id,
    owner_agent_id: effectiveOwnerAgentId,
    owner_team_id: effectiveOwnerTeamId,
    nodes: [
      {
        client_id: sessionCid,
        type: "topic" as const,
        title: `Session ${sid}`,
        text_summary: `Session ${sid}`,
        slots: sessionSlots,
      },
      {
        client_id: eventCid,
        type: "event" as const,
        title: title ?? undefined,
        text_summary: textSummary,
        slots: eventSlots,
      },
    ],
    edges: [
      {
        type: "part_of" as const,
        src: { client_id: eventCid },
        dst: { client_id: sessionCid },
        weight: parsed.edge_weight ?? 1,
        confidence: parsed.edge_confidence ?? 1,
      },
    ],
  };

  const prepared = await prepareMemoryWrite(
    writeReq,
    opts.defaultScope,
    opts.defaultTenantId,
    {
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      allowCrossScopeEdges: opts.allowCrossScopeEdges,
    },
    opts.embedder,
  );
  const out = (
    await commitLitePreparedWriteWithProjection({
      prepared,
      liteWriteStore: opts.liteWriteStore,
      embedder: opts.embedder,
      learningControlReviewProviders: opts.learningControlReviewProviders,
      writeOptions: {
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
        allowCrossScopeEdges: opts.allowCrossScopeEdges,
        shadowDualWriteEnabled: opts.shadowDualWriteEnabled,
        shadowDualWriteStrict: opts.shadowDualWriteStrict,
      },
    })
  ).out;

  const eventNode = out.nodes.find((n) => n.client_id === eventCid) ?? null;
  const sessionNode = out.nodes.find((n) => n.client_id === sessionCid) ?? null;
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    session_id: sid,
    event_id: eid,
    event_node_id: eventNode?.id ?? null,
    session_node_id: sessionNode?.id ?? null,
    event_uri:
      eventNode?.id != null
        ? buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "event",
            id: eventNode.id,
          })
        : null,
    session_uri:
      sessionNode?.id != null
        ? buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "topic",
            id: sessionNode.id,
          })
        : null,
    commit_id: out.commit_id,
    commit_uri:
      out.commit_uri ??
      buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "commit",
        id: out.commit_id,
      }),
    commit_hash: out.commit_hash,
    nodes: out.nodes,
    edges: out.edges,
    embedding_backfill: out.embedding_backfill ?? null,
  };
}

export async function listSessions(input: unknown, opts: SessionListOptions) {
  const parsed = normalizeSessionsListInput(input);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const lite = await opts.liteWriteStore.listSessions({
    scope: tenancy.scope_key,
    consumerAgentId: parsed.consumer_agent_id ?? null,
    consumerTeamId: parsed.consumer_team_id ?? null,
    ownerAgentId: parsed.owner_agent_id ?? null,
    ownerTeamId: parsed.owner_team_id ?? null,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    sessions: lite.sessions.map((row) => sessionListItem(tenancy, row, parsed.include_meta)),
    page: {
      limit: parsed.limit,
      offset: parsed.offset,
      returned: lite.sessions.length,
      has_more: lite.has_more,
    },
  };
}

export async function listSessionEvents(input: unknown, opts: SessionEventListOptions) {
  const parsed = normalizeSessionEventsListInput(input);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const sid = parsed.session_id.trim();
  const sessionCid = sessionClientId(sid);
  const lite = await opts.liteWriteStore.listSessionEvents({
    scope: tenancy.scope_key,
    sessionClientId: sessionCid,
    consumerAgentId: parsed.consumer_agent_id ?? null,
    consumerTeamId: parsed.consumer_team_id ?? null,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  if (!lite.session) {
    return {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      session: null,
      events: [],
      page: {
        limit: parsed.limit,
        offset: parsed.offset,
        returned: 0,
        has_more: false,
      },
    };
  }

  const events = lite.events.map((row) => {
    const out: Record<string, unknown> = {
      uri: buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "event",
        id: row.id,
      }),
      id: row.id,
      client_id: row.client_id,
      event_id: typeof row.slots?.event_id === "string" ? row.slots.event_id : null,
      type: row.type,
      title: row.title,
      text_summary: row.text_summary,
      edge_weight: row.edge_weight,
      edge_confidence: row.edge_confidence,
    };
    if (parsed.include_slots) out.slots = row.slots;
    else if (parsed.include_slots_preview) out.slots_preview = pickSlotsPreview(row.slots, parsed.slots_preview_keys);
    if (parsed.include_meta) {
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
  });

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    session: {
      session_id: sid,
      node_id: lite.session.id,
      title: lite.session.title,
      text_summary: lite.session.text_summary,
      uri: buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "topic",
        id: lite.session.id,
      }),
    },
    events,
    page: {
      limit: parsed.limit,
      offset: parsed.offset,
      returned: events.length,
      has_more: lite.has_more,
    },
  };
}
