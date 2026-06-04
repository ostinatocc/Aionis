import { randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { buildAionisUri } from "./uri.js";
import { resolveTenantScope } from "./tenant.js";
import { prepareMemoryWrite } from "./write.js";
import { DelegationRecordsWriteRequest, type DelegationRecordsWriteInput } from "./schemas.js";
import { commitLitePreparedWriteWithProjection, type LiteProjectedWriteStore } from "./lite-projected-write-commit.js";
import type { LiteLearningControlRuntimeProviders } from "../app/learning-control-runtime-providers.js";

type DelegationRecordsWriteOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
  embedder: EmbeddingProvider | null;
  liteWriteStore: LiteProjectedWriteStore;
  learningControlReviewProviders?: LiteLearningControlRuntimeProviders["workflowProjection"];
};

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function buildDelegationRecordTitle(input: DelegationRecordsWriteInput): string {
  return firstNonEmpty(
    input.title,
    input.delegation_records_v1.delegation_returns[0]?.summary,
    input.delegation_records_v1.delegation_packets[0]?.mission,
  ) ?? `Delegation records ${input.delegation_records_v1.route_role}`;
}

function buildDelegationRecordSummary(input: DelegationRecordsWriteInput): string {
  return firstNonEmpty(
    input.summary,
    input.delegation_records_v1.delegation_returns[0]?.summary,
    input.delegation_records_v1.delegation_packets[0]?.mission,
  ) ?? `Persisted delegation records for ${input.delegation_records_v1.route_role}`;
}

function buildDelegationRecordInputText(input: DelegationRecordsWriteInput, summary: string): string {
  return firstNonEmpty(
    input.input_text,
    input.delegation_records_v1.delegation_returns[0]?.summary,
    input.delegation_records_v1.delegation_packets[0]?.mission,
    summary,
  ) ?? "persist delegation records";
}

function buildDelegationRecordClientId(recordId: string): string {
  return `delegation_records:${encodeURIComponent(recordId)}`;
}

export async function writeDelegationRecords(
  body: unknown,
  opts: DelegationRecordsWriteOptions,
) {
  const parsed = DelegationRecordsWriteRequest.parse(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const recordId = parsed.record_id?.trim() || randomUUID();
  const title = buildDelegationRecordTitle(parsed);
  const textSummary = buildDelegationRecordSummary(parsed);
  const inputText = buildDelegationRecordInputText(parsed, textSummary);
  const routeRole = parsed.route_role?.trim() || parsed.delegation_records_v1.route_role;
  const taskFamily =
    parsed.task_family?.trim() || parsed.delegation_records_v1.delegation_packets[0]?.task_family || null;
  const familyScope =
    parsed.delegation_records_v1.delegation_packets[0]?.family_scope
    || parsed.execution_state_v1?.scope
    || parsed.scope
    || opts.defaultScope;
  const slots = {
    summary_kind: "delegation_records",
    record_id: recordId,
    run_id: parsed.run_id ?? null,
    handoff_anchor: parsed.handoff_anchor ?? null,
    handoff_uri: parsed.handoff_uri ?? null,
    route_role: routeRole,
    task_family: taskFamily,
    family_scope: familyScope,
    record_mode: parsed.delegation_records_v1.record_mode,
    packet_count: parsed.delegation_records_v1.packet_count,
    return_count: parsed.delegation_records_v1.return_count,
    artifact_routing_count: parsed.delegation_records_v1.artifact_routing_count,
    tags: uniqueStrings(parsed.tags ?? [], 16),
    delegation_records_v1: parsed.delegation_records_v1,
    ...(parsed.execution_result_summary ? { execution_result_summary: parsed.execution_result_summary } : {}),
    ...(parsed.execution_artifacts ? { execution_artifacts: parsed.execution_artifacts } : {}),
    ...(parsed.execution_evidence ? { execution_evidence: parsed.execution_evidence } : {}),
    ...(parsed.execution_state_v1 ? { execution_state_v1: parsed.execution_state_v1 } : {}),
    ...(parsed.execution_packet_v1 ? { execution_packet_v1: parsed.execution_packet_v1 } : {}),
  };

  const prepared = await prepareMemoryWrite(
    {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      actor: parsed.actor ?? "delegation_records_api",
      input_text: inputText,
      auto_embed: false,
      memory_lane: parsed.memory_lane,
      producer_agent_id: parsed.producer_agent_id,
      owner_agent_id: parsed.owner_agent_id,
      owner_team_id: parsed.owner_team_id,
      nodes: [
        {
          client_id: buildDelegationRecordClientId(recordId),
          type: "event" as const,
          title,
          text_summary: textSummary,
          slots,
        },
      ],
      edges: [],
    },
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
      },
    })
  ).out;

  const recordNode = out.nodes[0] ?? null;
  return {
    summary_version: "delegation_records_write_v1" as const,
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    commit_id: out.commit_id,
    commit_uri: out.commit_uri ?? null,
    record_event: recordNode
      ? {
          node_id: recordNode.id,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "event",
            id: recordNode.id,
          }),
          client_id: recordNode.client_id ?? buildDelegationRecordClientId(recordId),
          record_id: recordId,
          memory_lane: parsed.memory_lane,
          run_id: parsed.run_id ?? null,
          handoff_anchor: parsed.handoff_anchor ?? null,
          route_role: routeRole,
          task_family: taskFamily,
          family_scope: familyScope,
          record_mode: parsed.delegation_records_v1.record_mode,
        }
      : null,
    delegation_records_v1: parsed.delegation_records_v1,
    execution_result_summary: parsed.execution_result_summary ?? null,
    execution_artifacts: parsed.execution_artifacts ?? [],
    execution_evidence: parsed.execution_evidence ?? [],
    execution_state_v1: parsed.execution_state_v1 ?? null,
    execution_packet_v1: parsed.execution_packet_v1 ?? null,
  };
}
