import { z } from "zod";
import { memoryFindLite } from "../memory/find.js";
import { memoryResolveLite } from "../memory/resolve.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  ExecutionTreeV1Schema,
  deriveExecutionTreeStateV1,
  type ExecutionTreeStateV1,
  type ExecutionTreeV1,
} from "./tree.js";
import type { ExecutionTreeStore } from "./tree-store.js";

const NodeType = z.enum(["event", "entity", "topic", "rule", "evidence", "concept", "procedure", "self_model"]);
const MemoryLane = z.enum(["private", "shared"]);

const ExecutionEvidenceMemoryFilterSchema = z.object({
  type: NodeType.optional(),
  id: z.string().uuid().optional(),
  client_id: z.string().min(1).optional(),
  title_contains: z.string().min(1).optional(),
  text_contains: z.string().min(1).optional(),
  slots_contains: z.record(z.any()).optional(),
  memory_lane: MemoryLane.optional(),
  limit: z.number().int().positive().max(200).default(20),
}).strict();

export const ExecutionEvidenceContextRequestSchema = z.object({
  tenant_id: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  consumer_agent_id: z.string().min(1).optional(),
  consumer_team_id: z.string().min(1).optional(),
  execution_tree_v1: ExecutionTreeV1Schema.optional(),
  tree_id: z.string().min(1).optional(),
  tree_scope: z.string().min(1).optional(),
  state_id: z.string().min(1).optional(),
  memory_lane: MemoryLane.optional(),
  evidence_node_uris: z.array(z.string().min(1)).max(100).default([]),
  evidence_node_ids: z.array(z.string().uuid()).max(100).default([]),
  memory_filters: z.array(ExecutionEvidenceMemoryFilterSchema).max(12).default([]),
  include_memory_evidence: z.boolean().default(true),
  include_prompt_text: z.boolean().default(true),
  prompt_detail: z.enum(["compact", "full"]).default("compact"),
  max_active_entries: z.number().int().positive().max(48).default(16),
  max_validated_evidence: z.number().int().positive().max(50).default(8),
  max_supporting_evidence: z.number().int().positive().max(50).default(8),
  max_failed_branches: z.number().int().positive().max(50).default(8),
  max_rehydration_refs: z.number().int().positive().max(100).default(32),
  max_raw_trace_entries: z.number().int().positive().max(24).default(4),
  evidence_char_budget: z.number().int().positive().max(100_000).default(12_000),
}).strict();

export type ExecutionEvidenceContextRequest = z.infer<typeof ExecutionEvidenceContextRequestSchema>;

type MemoryNodeDTO = {
  uri: string;
  id: string;
  client_id: string | null;
  type: string;
  title: string | null;
  text_summary: string | null;
  slots?: unknown;
  tier?: string;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string | null;
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  raw_ref?: string | null;
  evidence_ref?: string | null;
  created_at?: string;
  updated_at?: string;
  confidence?: number;
};

type OutcomeClass = "passed" | "failed" | "unknown";

type Budget = {
  take: (value: string | null | undefined, maxChars: number) => string | null;
  remaining: () => number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => !!item);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const out = stringValue(value);
    if (out) return out;
  }
  return null;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function createBudget(maxChars: number): Budget {
  let remaining = maxChars;
  return {
    take(value: string | null | undefined, maxCharsPerEntry: number) {
      if (!value || remaining <= 0) return null;
      const capped = truncate(value, Math.min(maxCharsPerEntry, remaining));
      remaining = Math.max(0, remaining - capped.length);
      return capped;
    },
    remaining() {
      return remaining;
    },
  };
}

function uniqueStrings(values: Array<string | null | undefined>, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function classifyOutcomeText(text: string | null): OutcomeClass {
  if (!text) return "unknown";
  const normalized = text.toLowerCase();
  const negatedFailure =
    /\bnot\s+(?:failed|failing|failure)\b/.test(normalized)
    || /\bno\s+(?:known\s+)?(?:failure|failures|failed|failing|error|errors|regression|regressions|blocker|blockers)\b/.test(normalized)
    || /\bwithout\s+(?:failure|failures|error|errors|regression|regressions)\b/.test(normalized)
    || /\b(?:failed|failing|failure|failures|error|errors)\s*[:=]\s*(?:false|no|0)\b/.test(normalized);
  const negatedSuccess =
    /\bnot\s+(?:passed|passing|accepted|valid|verified|successful|success|succeeded|resolved|fixed)\b/.test(normalized)
    || /\bno\s+(?:success|accepted|valid|verified|resolution|fix)\b/.test(normalized);
  const hasSuccess =
    /\b(?:passed|passing|accepted|valid|verified|successful|success|succeeded|resolved|fixed|completed|ok)\b/.test(normalized);
  const hasFailure =
    /\b(?:failed|failing|failure|failures|error|errors|wrong|invalid|rejected|blocked|blocker|blockers|regression|regressions|timeout|crash|crashed)\b/.test(normalized);

  if (hasSuccess && !negatedSuccess) return "passed";
  if (hasFailure && !negatedFailure) return "failed";
  return "unknown";
}

function classifyExecutionOutcome(slots: unknown): OutcomeClass {
  const slotRecord = asRecord(slots);
  if (!slotRecord) return "unknown";
  const result = asRecord(slotRecord.execution_result_summary);
  if (!result) return "unknown";

  for (const key of ["passed", "success", "ok", "validated", "failed", "failure"] as const) {
    const value = result[key];
    if (typeof value !== "boolean") continue;
    if (key === "failed" || key === "failure") return value ? "failed" : "unknown";
    if (value) return "passed";
  }

  for (const key of ["status", "outcome", "result", "verdict", "state"] as const) {
    const classified = classifyOutcomeText(stringValue(result[key]));
    if (classified !== "unknown") return classified;
  }

  for (const key of ["summary", "message", "diagnostic_note", "diagnostic", "notes"] as const) {
    const classified = classifyOutcomeText(stringValue(result[key]));
    if (classified !== "unknown") return classified;
  }
  return "unknown";
}

function evidenceSummary(node: MemoryNodeDTO, budget: Budget): string | null {
  const slots = asRecord(node.slots);
  const result = asRecord(slots?.execution_result_summary);
  const summary = firstString(
    result?.summary,
    result?.solution_summary,
    result?.solution,
    result?.answer,
    result?.message,
    node.text_summary,
  );
  return budget.take(summary, 1_800);
}

function diagnosticNote(node: MemoryNodeDTO): string | null {
  const slots = asRecord(node.slots);
  const result = asRecord(slots?.execution_result_summary);
  return firstString(
    result?.diagnostic_note,
    result?.diagnostic,
    result?.error,
    result?.reason,
    result?.message,
  );
}

function collectEvidenceRefsFromSlots(slots: unknown): string[] {
  const root = asRecord(slots);
  if (!root) return [];
  const out: string[] = [];
  const result = asRecord(root.execution_result_summary);
  out.push(...stringArray(result?.evidence_refs));
  out.push(...stringArray(result?.artifact_refs));

  const packet = asRecord(root.execution_packet_v1);
  out.push(...stringArray(packet?.evidence_refs));
  out.push(...stringArray(packet?.artifact_refs));

  const evidence = root.execution_evidence;
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      const record = asRecord(item);
      if (!record) continue;
      const directRef = firstString(record.ref, record.uri, record.url, record.path, record.evidence_ref, record.raw_ref);
      if (directRef) out.push(directRef);
      out.push(...stringArray(record.evidence_refs));
      out.push(...stringArray(record.artifact_refs));
      out.push(...stringArray(record.refs));
    }
  }

  out.push(...stringArray(root.evidence_refs));
  out.push(...stringArray(root.artifact_refs));
  return out.filter((value): value is string => !!value);
}

function memoryRehydrationRefs(node: MemoryNodeDTO): string[] {
  return uniqueStrings([
    node.uri,
    node.raw_ref,
    node.evidence_ref,
    ...collectEvidenceRefsFromSlots(node.slots),
  ], 32);
}

function stateEntries(
  entries: ExecutionTreeStateV1["compressed_state"],
  maxEntries: number,
) {
  return entries.slice(-maxEntries).map((entry) => ({
    source: "execution_tree" as const,
    node_id: entry.node_id,
    step_id: entry.step_id,
    title: entry.title,
    summary: entry.summary ? truncate(entry.summary, 1_200) : null,
    action: entry.action ? truncate(entry.action, 700) : null,
    observation: entry.observation ? truncate(entry.observation, 900) : null,
    status: entry.status,
    validated: entry.validated,
    diagnostic_note: entry.diagnostic_note,
  }));
}

function rawTraceForTreeNode(tree: ExecutionTreeV1 | null, nodeId: string, maxEntries: number) {
  if (!tree) return [];
  const node = tree.nodes[nodeId] ?? null;
  if (!node) return [];
  const rawNodeIds = node.layer === "raw" ? [node.node_id] : node.cover_node_ids;
  return rawNodeIds
    .map((rawNodeId) => tree.nodes[rawNodeId] ?? null)
    .filter((rawNode): rawNode is NonNullable<typeof rawNode> => !!rawNode && rawNode.layer === "raw")
    .slice(-maxEntries)
    .map((rawNode) => ({
      source: "execution_tree_raw" as const,
      node_id: rawNode.node_id,
      step_id: rawNode.step_id,
      title: rawNode.content.title,
      action: rawNode.content.action ? truncate(rawNode.content.action, 700) : null,
      observation: rawNode.content.observation ? truncate(rawNode.content.observation, 900) : null,
      status: rawNode.status,
      refs: rawNode.content.refs,
    }));
}

function refsForTreeNode(tree: ExecutionTreeV1 | null, nodeId: string, maxRawTraceEntries: number) {
  if (!tree) return [];
  const node = tree.nodes[nodeId] ?? null;
  return uniqueStrings([
    ...(node?.content.refs ?? []),
    ...rawTraceForTreeNode(tree, nodeId, maxRawTraceEntries).flatMap((entry) => entry.refs),
  ], 32);
}

function coveredRawNodeIdsForTreeNode(tree: ExecutionTreeV1 | null, nodeId: string, maxRawTraceEntries: number) {
  return rawTraceForTreeNode(tree, nodeId, maxRawTraceEntries).map((entry) => entry.node_id);
}

function failedTreeBranches(tree: ExecutionTreeV1 | null, state: ExecutionTreeStateV1 | null, maxBranches: number, maxRawTraceEntries: number) {
  if (!tree || !state) return [];
  return state.execution_hints
    .filter((entry) => entry.status === "failed")
    .slice(0, maxBranches)
    .map((entry) => {
      const rawTrace = rawTraceForTreeNode(tree, entry.node_id, maxRawTraceEntries);
      const supportingRawRefs = refsForTreeNode(tree, entry.node_id, maxRawTraceEntries);
      return {
        source: "execution_tree" as const,
        branch_role: "failed" as const,
        node_id: entry.node_id,
        step_id: entry.step_id,
        title: entry.title,
        summary: entry.summary ? truncate(entry.summary, 1_200) : null,
        action: entry.action ? truncate(entry.action, 700) : null,
        observation: entry.observation ? truncate(entry.observation, 900) : null,
        diagnostic_note: entry.diagnostic_note,
        covered_raw_node_ids: coveredRawNodeIdsForTreeNode(tree, entry.node_id, maxRawTraceEntries),
        supporting_raw_refs: supportingRawRefs,
        supporting_raw_trace: rawTrace,
        supporting_raw_trace_count: rawTrace.length,
        evidence_backed: supportingRawRefs.length > 0,
        raw_trace_backed: rawTrace.length > 0,
        refs: supportingRawRefs,
        avoid_next_action: true,
      };
    });
}

function validatedTreeSolutions(args: {
  tree: ExecutionTreeV1 | null;
  entries: ReturnType<typeof stateEntries>;
  maxSolutions: number;
  maxRawTraceEntries: number;
}) {
  if (!args.tree) return [];
  return args.entries
    .filter((entry) => entry.status === "active" && entry.validated)
    .slice(-args.maxSolutions)
    .map((entry) => {
      const rawTrace = rawTraceForTreeNode(args.tree, entry.node_id, args.maxRawTraceEntries);
      const supportingRawRefs = refsForTreeNode(args.tree, entry.node_id, args.maxRawTraceEntries);
      return {
        source: "execution_tree" as const,
        node_id: entry.node_id,
        step_id: entry.step_id,
        title: entry.title,
        summary: firstString(entry.summary, entry.observation, entry.action, entry.title),
        action: entry.action,
        observation: entry.observation,
        outcome: "passed" as const,
        confidence: null,
        created_at: null,
        covered_raw_node_ids: rawTrace.map((traceEntry) => traceEntry.node_id),
        supporting_raw_refs: supportingRawRefs,
        supporting_raw_trace: rawTrace,
        supporting_raw_trace_count: rawTrace.length,
        evidence_backed: supportingRawRefs.length > 0,
        raw_trace_backed: rawTrace.length > 0,
        rehydration_refs: supportingRawRefs,
        validated: true,
      };
    });
}

async function collectMemoryNodes(args: {
  liteWriteStore: LiteWriteStore;
  parsed: ExecutionEvidenceContextRequest;
  defaultScope: string;
  defaultTenantId: string;
}): Promise<{ nodes: MemoryNodeDTO[]; filtersConsidered: number; directRefsConsidered: number }> {
  const { liteWriteStore, parsed, defaultScope, defaultTenantId } = args;
  const nodes = new Map<string, MemoryNodeDTO>();
  const remember = (node: unknown) => {
    const record = asRecord(node);
    if (!record) return;
    const id = stringValue(record.id);
    const uri = stringValue(record.uri);
    if (!id || !uri) return;
    nodes.set(id, {
      uri,
      id,
      client_id: stringValue(record.client_id),
      type: stringValue(record.type) ?? "event",
      title: stringValue(record.title),
      text_summary: stringValue(record.text_summary),
      slots: record.slots,
      tier: stringValue(record.tier) ?? undefined,
      memory_lane: record.memory_lane === "shared" ? "shared" : record.memory_lane === "private" ? "private" : undefined,
      producer_agent_id: stringValue(record.producer_agent_id),
      owner_agent_id: stringValue(record.owner_agent_id),
      owner_team_id: stringValue(record.owner_team_id),
      raw_ref: stringValue(record.raw_ref),
      evidence_ref: stringValue(record.evidence_ref),
      created_at: stringValue(record.created_at) ?? undefined,
      updated_at: stringValue(record.updated_at) ?? undefined,
      confidence: typeof record.confidence === "number" ? record.confidence : undefined,
    });
  };

  for (const uri of parsed.evidence_node_uris) {
    const resolved = await memoryResolveLite(liteWriteStore, {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      uri,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      include_meta: true,
      include_slots: true,
    }, defaultScope, defaultTenantId);
    remember(asRecord(resolved)?.node);
  }

  for (const id of parsed.evidence_node_ids) {
    const found = await memoryFindLite(liteWriteStore, {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      id,
      memory_lane: parsed.memory_lane,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      include_meta: true,
      include_slots: true,
      limit: 1,
    }, defaultScope, defaultTenantId);
    for (const node of Array.isArray(asRecord(found)?.nodes) ? asRecord(found)!.nodes as unknown[] : []) remember(node);
  }

  for (const filter of parsed.memory_filters) {
    const found = await memoryFindLite(liteWriteStore, {
      tenant_id: parsed.tenant_id,
      scope: parsed.scope,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      type: filter.type,
      id: filter.id,
      client_id: filter.client_id,
      title_contains: filter.title_contains,
      text_contains: filter.text_contains,
      slots_contains: filter.slots_contains,
      memory_lane: filter.memory_lane ?? parsed.memory_lane,
      include_meta: true,
      include_slots: true,
      limit: filter.limit,
    }, defaultScope, defaultTenantId);
    for (const node of Array.isArray(asRecord(found)?.nodes) ? asRecord(found)!.nodes as unknown[] : []) remember(node);
  }

  return {
    nodes: Array.from(nodes.values()),
    filtersConsidered: parsed.memory_filters.length,
    directRefsConsidered: parsed.evidence_node_uris.length + parsed.evidence_node_ids.length,
  };
}

function resolveTree(args: {
  parsed: ExecutionEvidenceContextRequest;
  executionTreeStore?: ExecutionTreeStore | null;
  defaultScope: string;
}): { tree: ExecutionTreeV1 | null; source: "inline" | "store" | "none"; lookup_scopes: string[] } {
  const { parsed, executionTreeStore, defaultScope } = args;
  if (parsed.execution_tree_v1) {
    return { tree: parsed.execution_tree_v1, source: "inline", lookup_scopes: [parsed.execution_tree_v1.scope] };
  }
  if (!executionTreeStore) return { tree: null, source: "none", lookup_scopes: [] };

  const treeId = parsed.tree_id ?? (parsed.state_id ? `execution-tree:${parsed.state_id}` : null);
  if (!treeId) return { tree: null, source: "none", lookup_scopes: [] };
  const lookupScopes = uniqueStrings([
    parsed.tree_scope,
    parsed.scope,
    defaultScope,
    parsed.state_id ? `aionis://execution/${parsed.state_id}` : null,
  ], 8);
  for (const scope of lookupScopes) {
    const stored = executionTreeStore.get(scope, treeId);
    if (stored) return { tree: stored.tree, source: "store", lookup_scopes: lookupScopes };
  }
  return { tree: null, source: "none", lookup_scopes: lookupScopes };
}

function buildMemoryEvidence(args: {
  nodes: MemoryNodeDTO[];
  parsed: ExecutionEvidenceContextRequest;
  budget: Budget;
}) {
  const validated = [];
  const failed = [];
  const supporting = [];
  for (const node of args.nodes) {
    const outcome = classifyExecutionOutcome(node.slots);
    const refs = memoryRehydrationRefs(node);
    const base = {
      source: "memory" as const,
      node_id: node.id,
      uri: node.uri,
      type: node.type,
      client_id: node.client_id,
      title: node.title,
      summary: evidenceSummary(node, args.budget),
      outcome,
      confidence: node.confidence ?? null,
      created_at: node.created_at ?? null,
      rehydration_refs: refs,
      evidence_backed: refs.length > 0,
      raw_trace_backed: false,
      supporting_raw_trace_count: 0,
    };
    if (outcome === "passed") {
      if (validated.length < args.parsed.max_validated_evidence) validated.push(base);
    } else if (outcome === "failed") {
      if (failed.length < args.parsed.max_failed_branches) {
        failed.push({
          ...base,
          branch_role: "failed" as const,
          diagnostic_note: diagnosticNote(node),
          avoid_next_action: true,
        });
      }
    } else if (supporting.length < args.parsed.max_supporting_evidence) {
      supporting.push(base);
    }
  }
  return { validated, failed, supporting };
}

function recordStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
}

function supportingRawTraceFromRecords(records: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const record of records as Array<Record<string, unknown>>) {
    const trace = Array.isArray(record.supporting_raw_trace) ? record.supporting_raw_trace : [];
    for (const entry of trace) {
      const traceEntry = asRecord(entry);
      if (!traceEntry) continue;
      out.push({
        owner_node_id: record.node_id,
        ...traceEntry,
      });
    }
  }
  return out;
}

function hasEvidenceBacking(record: unknown): boolean {
  const item = asRecord(record);
  if (!item) return false;
  if (item.evidence_backed === true) return true;
  return recordStringArray(item, "rehydration_refs").length > 0
    || recordStringArray(item, "supporting_raw_refs").length > 0
    || recordStringArray(item, "refs").length > 0
    || (Array.isArray(item.supporting_raw_trace) && item.supporting_raw_trace.length > 0);
}

function hasRawTraceBacking(record: unknown): boolean {
  const item = asRecord(record);
  if (!item) return false;
  if (item.raw_trace_backed === true) return true;
  return Array.isArray(item.supporting_raw_trace) && item.supporting_raw_trace.length > 0;
}

function buildPromptText(args: {
  activeCompressed: ReturnType<typeof stateEntries>;
  activeRaw: ReturnType<typeof stateEntries>;
  validatedEvidence: unknown[];
  supportingEvidence: unknown[];
  failedBranches: unknown[];
  rehydrationRefs: string[];
  promptDetail: "compact" | "full";
}) {
  const lines: string[] = [];
  lines.push("AIONIS_EXECUTION_EVIDENCE_CONTEXT v1");
  lines.push("");
  lines.push("CURRENT_ACTIVE_PATH");
  if (args.activeCompressed.length === 0 && args.activeRaw.length === 0) lines.push("- none");
  for (const entry of args.activeCompressed) {
    lines.push(`- [compressed] node=${entry.node_id} step=${entry.step_id} validated=${entry.validated} summary=${entry.summary ?? entry.title ?? ""}`);
  }
  if (args.promptDetail === "full") {
    for (const entry of args.activeRaw) {
      lines.push(`- [raw] node=${entry.node_id} step=${entry.step_id} action=${entry.action ?? ""} observation=${entry.observation ?? ""}`);
    }
  } else {
    for (const entry of args.activeRaw.slice(-3)) {
      lines.push(`- [raw] node=${entry.node_id} step=${entry.step_id} action=${entry.action ?? entry.title ?? ""}`);
    }
  }

  lines.push("");
  lines.push("PASSED_SOLUTIONS");
  if (args.validatedEvidence.length === 0) lines.push("- none");
  for (const entry of args.validatedEvidence as Array<Record<string, unknown>>) {
    const refs = uniqueStrings([
      ...recordStringArray(entry, "rehydration_refs"),
      ...recordStringArray(entry, "supporting_raw_refs"),
    ], 12);
    const rawNodeIds = recordStringArray(entry, "covered_raw_node_ids");
    lines.push(`- node=${entry.node_id ?? ""} title=${entry.title ?? ""} summary=${entry.summary ?? ""} refs=${refs.join(",")} raw_nodes=${rawNodeIds.join(",")}`);
  }

  const episodicTraces = supportingRawTraceFromRecords(args.validatedEvidence);
  if (episodicTraces.length > 0) {
    lines.push("");
    lines.push("EPISODIC_TRACES");
    for (const trace of episodicTraces) {
      const refs = recordStringArray(trace, "refs");
      lines.push(`- owner=${trace.owner_node_id ?? ""} raw=${trace.node_id ?? ""} action=${trace.action ?? ""} observation=${trace.observation ?? ""} refs=${refs.join(",")}`);
    }
  }

  if (args.promptDetail === "full" || args.supportingEvidence.length > 0) {
    lines.push("");
    lines.push("SUPPORTING_EVIDENCE");
    if (args.supportingEvidence.length === 0) lines.push("- none");
    for (const entry of args.supportingEvidence as Array<Record<string, unknown>>) {
      lines.push(`- node=${entry.node_id ?? ""} title=${entry.title ?? ""} summary=${entry.summary ?? ""}`);
    }
  }

  lines.push("");
  lines.push("FAILED_BRANCHES");
  if (args.failedBranches.length === 0) lines.push("- none");
  for (const entry of args.failedBranches as Array<Record<string, unknown>>) {
    if (args.promptDetail === "full") {
      const refs = uniqueStrings([
        ...recordStringArray(entry, "refs"),
        ...recordStringArray(entry, "supporting_raw_refs"),
      ], 12);
      lines.push(`- source=${entry.source ?? ""} node=${entry.node_id ?? ""} diagnostic=${entry.diagnostic_note ?? ""} summary=${entry.summary ?? ""} action=${entry.action ?? ""} raw_refs=${refs.join(",")}`);
    } else {
      const refs = uniqueStrings([
        ...recordStringArray(entry, "refs"),
        ...recordStringArray(entry, "supporting_raw_refs"),
      ], 12);
      lines.push(`- source=${entry.source ?? ""} node=${entry.node_id ?? ""} diagnostic=${entry.diagnostic_note ?? entry.summary ?? ""} raw_refs=${refs.join(",")}`);
    }
  }

  if (args.promptDetail === "full" || args.rehydrationRefs.length > 0) {
    lines.push("");
    lines.push("REHYDRATION_REFS");
    if (args.rehydrationRefs.length === 0) lines.push("- none");
    for (const ref of args.rehydrationRefs) lines.push(`- ${ref}`);
  }
  return lines.join("\n");
}

export async function buildExecutionEvidenceContextLite(args: {
  liteWriteStore: LiteWriteStore;
  executionTreeStore?: ExecutionTreeStore | null;
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
}) {
  const parsed = ExecutionEvidenceContextRequestSchema.parse(args.body);
  const tenantId = parsed.tenant_id ?? args.defaultTenantId;
  const scope = parsed.scope ?? args.defaultScope;
  const treeResolution = resolveTree({
    parsed,
    executionTreeStore: args.executionTreeStore,
    defaultScope: args.defaultScope,
  });
  const tree = treeResolution.tree;
  const state = tree ? deriveExecutionTreeStateV1(tree) : null;
  const activeCompressed = stateEntries(state?.compressed_state ?? [], parsed.max_active_entries);
  const activeRaw = stateEntries(state?.raw_state ?? [], parsed.max_active_entries);
  const treeFailedBranches = failedTreeBranches(tree, state, parsed.max_failed_branches, parsed.max_raw_trace_entries);

  const budget = createBudget(parsed.evidence_char_budget);
  const memory = parsed.include_memory_evidence
    ? await collectMemoryNodes({
        liteWriteStore: args.liteWriteStore,
        parsed,
        defaultScope: args.defaultScope,
        defaultTenantId: args.defaultTenantId,
      })
    : { nodes: [], filtersConsidered: 0, directRefsConsidered: 0 };
  const memoryEvidence = buildMemoryEvidence({
    nodes: memory.nodes,
    parsed,
    budget,
  });
  const treeValidatedSolutions = validatedTreeSolutions({
    tree,
    entries: activeCompressed,
    maxSolutions: parsed.max_validated_evidence,
    maxRawTraceEntries: parsed.max_raw_trace_entries,
  });
  const passedSolutions = [
    ...treeValidatedSolutions,
    ...memoryEvidence.validated.slice(0, Math.max(0, parsed.max_validated_evidence - treeValidatedSolutions.length)),
  ];

  const failedBranches = [
    ...treeFailedBranches,
    ...memoryEvidence.failed.slice(0, Math.max(0, parsed.max_failed_branches - treeFailedBranches.length)),
  ];
  const rehydrationRefs = uniqueStrings([
    ...activeCompressed.flatMap((entry) => refsForTreeNode(tree, entry.node_id, parsed.max_raw_trace_entries)),
    ...activeRaw.flatMap((entry) => refsForTreeNode(tree, entry.node_id, parsed.max_raw_trace_entries)),
    ...treeFailedBranches.flatMap((entry) => entry.refs),
    ...passedSolutions.flatMap((entry) => entry.rehydration_refs),
    ...memoryEvidence.supporting.flatMap((entry) => entry.rehydration_refs),
    ...memoryEvidence.failed.flatMap((entry) => entry.rehydration_refs),
  ], parsed.max_rehydration_refs);
  const passedRawTraceCount = supportingRawTraceFromRecords(passedSolutions).length;
  const failedRawTraceCount = supportingRawTraceFromRecords(failedBranches).length;
  const evidenceBackedPassedSolutionCount = passedSolutions.filter(hasEvidenceBacking).length;
  const evidenceBackedFailedBranchCount = failedBranches.filter(hasEvidenceBacking).length;
  const rawTraceBackedPassedSolutionCount = passedSolutions.filter(hasRawTraceBacking).length;
  const rawTraceBackedFailedBranchCount = failedBranches.filter(hasRawTraceBacking).length;

  const promptText = parsed.include_prompt_text
    ? buildPromptText({
        activeCompressed,
        activeRaw,
        validatedEvidence: passedSolutions,
        supportingEvidence: memoryEvidence.supporting,
        failedBranches,
        rehydrationRefs,
        promptDetail: parsed.prompt_detail,
      })
    : null;

  return {
    contract_version: "execution_evidence_context_v1",
    tenant_id: tenantId,
    scope,
    tree: {
      present: !!tree,
      source: treeResolution.source,
      tree_id: tree?.tree_id ?? parsed.tree_id ?? (parsed.state_id ? `execution-tree:${parsed.state_id}` : null),
      scope: tree?.scope ?? parsed.tree_scope ?? null,
      lookup_scopes: treeResolution.lookup_scopes,
      current_summary_node_id: state?.current_summary_node_id ?? null,
      current_raw_node_id: state?.current_raw_node_id ?? null,
      compressed_count: state?.compressed_state.length ?? 0,
      raw_count: state?.raw_state.length ?? 0,
      hint_count: state?.execution_hints.length ?? 0,
    },
    current_active_path: {
      compressed_state: activeCompressed,
      raw_state: activeRaw,
    },
    passed_solutions: passedSolutions,
    validated_evidence: passedSolutions,
    supporting_evidence: memoryEvidence.supporting,
    failed_branches: failedBranches,
    rehydration_refs: rehydrationRefs,
    prompt_text: promptText,
    selection_trace: {
      source: "execution_tree_first_memory_evidence_rehydration",
      memory_enabled: parsed.include_memory_evidence,
      memory_filters_considered: memory.filtersConsidered,
      direct_refs_considered: memory.directRefsConsidered,
      memory_nodes_considered: memory.nodes.length,
      passed_solution_count: passedSolutions.length,
      supporting_evidence_count: memoryEvidence.supporting.length,
      failed_branch_count: failedBranches.length,
      raw_trace_budget_entries_per_node: parsed.max_raw_trace_entries,
      raw_trace_count: passedRawTraceCount + failedRawTraceCount,
      passed_solution_raw_trace_count: passedRawTraceCount,
      failed_branch_raw_trace_count: failedRawTraceCount,
      evidence_backed_passed_solution_count: evidenceBackedPassedSolutionCount,
      evidence_backed_failed_branch_count: evidenceBackedFailedBranchCount,
      raw_trace_backed_passed_solution_count: rawTraceBackedPassedSolutionCount,
      raw_trace_backed_failed_branch_count: rawTraceBackedFailedBranchCount,
      tree_lookup_source: treeResolution.source,
      evidence_budget_remaining_chars: budget.remaining(),
    },
  };
}
