import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { badRequest } from "../util/http.js";
import { resolveTenantScope } from "./tenant.js";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "./write.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { MemoryPackExportRequest, MemoryPackImportRequest } from "./schemas.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { buildAionisUri } from "./uri.js";

type PackOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
  shadowDualWriteEnabled: boolean;
  shadowDualWriteStrict: boolean;
  embedder: EmbeddingProvider | null;
  liteWriteStore: LiteWriteStore;
};

type ExportNodeRow = {
  id: string;
  client_id: string | null;
  type: string;
  tier: string;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  title: string | null;
  text_summary: string | null;
  slots: any;
  raw_ref: string | null;
  evidence_ref: string | null;
  salience: number;
  importance: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  commit_id: string | null;
};

type ExportEdgeRow = {
  id: string;
  type: string;
  src_id: string;
  dst_id: string;
  src_type: string | null;
  dst_type: string | null;
  src_client_id: string | null;
  dst_client_id: string | null;
  weight: number;
  confidence: number;
  decay_rate: number;
  created_at: string;
  commit_id: string | null;
};

type ExportCommitRow = {
  id: string;
  parent_id: string | null;
  input_sha256: string;
  actor: string;
  model_version: string | null;
  prompt_version: string | null;
  created_at: string;
  commit_hash: string;
};

type ExportDecisionRow = {
  id: string;
  decision_kind: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: any;
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids: string[];
  metadata_json: any;
  created_at: string;
  commit_id: string | null;
};

function computePackHash(payload: unknown): string {
  return sha256Hex(stableStringify(payload));
}

export async function exportMemoryPack(body: unknown, opts: PackOptions) {
  const parsed = MemoryPackExportRequest.parse(body);
  const tenancy = resolveTenantScope(
    { tenant_id: parsed.tenant_id, scope: parsed.scope },
    { defaultScope: opts.defaultScope, defaultTenantId: opts.defaultTenantId },
  );
  const maxRows = parsed.max_rows;

  let nodes: ExportNodeRow[] = [];
  let edges: ExportEdgeRow[] = [];
  let commits: ExportCommitRow[] = [];
  let decisions: ExportDecisionRow[] = [];
  let nodesHasMore = false;
  let edgesHasMore = false;
  let commitsHasMore = false;
  let decisionsHasMore = false;

  const snapshot = await opts.liteWriteStore.exportPackSnapshot({
    scope: tenancy.scope_key,
    includeNodes: parsed.include_nodes,
    includeEdges: parsed.include_edges,
    includeCommits: parsed.include_commits,
    includeDecisions: parsed.include_decisions,
    maxRows,
  });
  nodes = snapshot.nodes;
  edges = snapshot.edges.map((e) => ({
    ...e,
    src_type: null,
    dst_type: null,
  }));
  commits = snapshot.commits;
  decisions = [];
  nodesHasMore = snapshot.truncated.nodes;
  edgesHasMore = snapshot.truncated.edges;
  commitsHasMore = snapshot.truncated.commits;
  decisionsHasMore = snapshot.truncated.decisions;

  const nodeUriById = new Map<string, string>();
  for (const n of nodes) {
    nodeUriById.set(
      n.id,
      buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: n.type,
        id: n.id,
      }),
    );
  }

  const pack = {
    version: "aionis_pack_v1" as const,
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    nodes: parsed.include_meta
      ? nodes.map((n) => ({
          ...n,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: n.type,
            id: n.id,
          }),
          commit_uri: n.commit_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: n.commit_id,
              })
            : null,
        }))
      : nodes.map((n) => ({
          id: n.id,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: n.type,
            id: n.id,
          }),
          client_id: n.client_id,
          type: n.type,
          title: n.title,
          text_summary: n.text_summary,
          slots: n.slots,
        })),
    edges: parsed.include_meta
      ? edges.map((e) => ({
          ...e,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "edge",
            id: e.id,
          }),
          src_uri: e.src_type
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: e.src_type,
                id: e.src_id,
              })
            : (nodeUriById.get(e.src_id) ?? null),
          dst_uri: e.dst_type
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: e.dst_type,
                id: e.dst_id,
              })
            : (nodeUriById.get(e.dst_id) ?? null),
          commit_uri: e.commit_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: e.commit_id,
              })
            : null,
        }))
      : edges.map((e) => ({
          id: e.id,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "edge",
            id: e.id,
          }),
          type: e.type,
          src_id: e.src_id,
          dst_id: e.dst_id,
          src_uri: e.src_type
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: e.src_type,
                id: e.src_id,
              })
            : (nodeUriById.get(e.src_id) ?? null),
          dst_uri: e.dst_type
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: e.dst_type,
                id: e.dst_id,
              })
            : (nodeUriById.get(e.dst_id) ?? null),
          src_client_id: e.src_client_id,
          dst_client_id: e.dst_client_id,
          weight: e.weight,
          confidence: e.confidence,
        })),
    commits: parsed.include_meta
      ? commits.map((c) => ({
          ...c,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "commit",
            id: c.id,
          }),
          parent_uri: c.parent_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: c.parent_id,
              })
            : null,
        }))
      : commits.map((c) => ({
          id: c.id,
          uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "commit",
            id: c.id,
          }),
          parent_id: c.parent_id,
          parent_uri: c.parent_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: c.parent_id,
              })
            : null,
          commit_hash: c.commit_hash,
        })),
    decisions: parsed.include_meta
      ? decisions.map((d) => ({
          ...d,
          decision_uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "decision",
            id: d.id,
          }),
          commit_uri: d.commit_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: d.commit_id,
              })
            : null,
        }))
      : decisions.map((d) => ({
          decision_id: d.id,
          decision_uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "decision",
            id: d.id,
          }),
          decision_kind: d.decision_kind,
          run_id: d.run_id,
          selected_tool: d.selected_tool,
          commit_id: d.commit_id,
          commit_uri: d.commit_id
            ? buildAionisUri({
                tenant_id: tenancy.tenant_id,
                scope: tenancy.scope,
                type: "commit",
                id: d.commit_id,
              })
            : null,
          created_at: d.created_at,
        })),
  };
  const packHash = computePackHash(pack);

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    manifest: {
      version: "aionis_pack_manifest_v1",
      pack_version: pack.version,
      sha256: packHash,
      generated_at: new Date().toISOString(),
      counts: {
        nodes: pack.nodes.length,
        edges: pack.edges.length,
        commits: pack.commits.length,
        decisions: pack.decisions.length,
      },
      truncated: {
        nodes: nodesHasMore,
        edges: edgesHasMore,
        commits: commitsHasMore,
        decisions: decisionsHasMore,
      },
      max_rows: maxRows,
    },
    pack,
  };
}

export async function importMemoryPack(body: unknown, opts: PackOptions) {
  const parsed = MemoryPackImportRequest.parse(body);
  const pack = parsed.pack;
  const packHash = computePackHash(pack);
  if (parsed.manifest_sha256 && parsed.manifest_sha256 !== packHash) {
    badRequest("pack_hash_mismatch", "manifest_sha256 does not match pack payload hash", {
      expected: parsed.manifest_sha256,
      actual: packHash,
    });
  }

  const tenantId = (parsed.tenant_id ?? pack.tenant_id).trim();
  const scope = (parsed.scope ?? pack.scope).trim();
  if (parsed.tenant_id && parsed.tenant_id.trim() !== pack.tenant_id) {
    badRequest("pack_scope_mismatch", "tenant_id conflicts with pack tenant_id");
  }
  if (parsed.scope && parsed.scope.trim() !== pack.scope) {
    badRequest("pack_scope_mismatch", "scope conflicts with pack scope");
  }

  const nodeClientById = new Map<string, string>();
  const shortHash = packHash.slice(0, 16);
  const nodes = pack.nodes.map((n) => {
    const cid = n.client_id?.trim() || `pack:${shortHash}:node:${n.id}`;
    nodeClientById.set(n.id, cid);
    return {
      client_id: cid,
      type: n.type,
      tier: n.tier,
      memory_lane: n.memory_lane,
      producer_agent_id: n.producer_agent_id ?? undefined,
      owner_agent_id: n.owner_agent_id ?? undefined,
      owner_team_id: n.owner_team_id ?? undefined,
      title: n.title ?? undefined,
      text_summary: n.text_summary ?? undefined,
      slots: n.slots ?? {},
      raw_ref: n.raw_ref ?? undefined,
      evidence_ref: n.evidence_ref ?? undefined,
      salience: n.salience,
      importance: n.importance,
      confidence: n.confidence,
    };
  });

  const edges = pack.edges.map((e) => {
    const srcClient = e.src_client_id?.trim() || nodeClientById.get(e.src_id);
    const dstClient = e.dst_client_id?.trim() || nodeClientById.get(e.dst_id);
    if (!srcClient || !dstClient) {
      badRequest("pack_edge_reference_missing", "edge references missing src/dst client mapping", {
        edge_id: e.id,
        src_id: e.src_id,
        dst_id: e.dst_id,
      });
    }
    return {
      type: e.type,
      src: { client_id: srcClient },
      dst: { client_id: dstClient },
      weight: e.weight,
      confidence: e.confidence,
      decay_rate: e.decay_rate,
    };
  });

  if (parsed.verify_only) {
    return {
      ok: true,
      verified: true,
      imported: false,
      tenant_id: tenantId,
      scope,
      pack_sha256: packHash,
      planned: {
        nodes: nodes.length,
        edges: edges.length,
        commits_in_pack: pack.commits.length,
        decisions_in_pack: pack.decisions.length,
      },
    };
  }

  const writeReq = {
    tenant_id: tenantId,
    scope,
    actor: parsed.actor ?? "pack_import",
    input_text: `pack import ${packHash}`,
    auto_embed: parsed.auto_embed,
    nodes,
    edges,
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
  const out = await opts.liteWriteStore.withTx(() => applyPreparedMemoryWrite(opts.liteWriteStore, prepared, {
    maxTextLen: opts.maxTextLen,
    piiRedaction: opts.piiRedaction,
    allowCrossScopeEdges: opts.allowCrossScopeEdges,
    shadowDualWriteEnabled: opts.shadowDualWriteEnabled,
    shadowDualWriteStrict: opts.shadowDualWriteStrict,
  }));

  return {
    ok: true,
    verified: true,
    imported: true,
    tenant_id: out.tenant_id ?? tenantId,
    scope: out.scope ?? scope,
    pack_sha256: packHash,
    commit_id: out.commit_id,
    commit_hash: out.commit_hash,
    nodes: out.nodes.length,
    edges: out.edges.length,
    embedding_backfill: out.embedding_backfill ?? null,
  };
}
