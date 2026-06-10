import { z } from "zod";
import { memoryFindLite } from "../memory/find.js";
import {
  parseAionisAgentContext,
  type AionisAgentContext,
} from "../memory/product-output-contract.js";
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
  include_agent_context: z.boolean().default(true),
  context_mode: z.enum(["execution_evidence", "full_power"]).default("execution_evidence"),
  prompt_detail: z.enum(["compact", "full"]).default("compact"),
  agent_context_char_budget: z.number().int().positive().max(50_000).default(4_096),
  max_active_entries: z.number().int().positive().max(48).default(16),
  max_validated_evidence: z.number().int().positive().max(50).default(8),
  max_supporting_evidence: z.number().int().positive().max(50).default(8),
  max_failed_branches: z.number().int().positive().max(50).default(8),
  max_rehydration_refs: z.number().int().positive().max(100).default(32),
  max_raw_trace_entries: z.number().int().positive().max(24).default(4),
  max_raw_evidence_entries: z.number().int().positive().max(80).default(16),
  max_gated_abstractions: z.number().int().positive().max(80).default(12),
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

type RawEvidenceEntry = {
  source: "execution_tree_raw" | "memory";
  node_id: string;
  owner_node_id?: string | null;
  uri?: string | null;
  type?: string | null;
  title?: string | null;
  summary?: string | null;
  action?: string | null;
  observation?: string | null;
  status?: string | null;
  outcome?: OutcomeClass;
  refs: string[];
  raw_ref?: string | null;
  evidence_ref?: string | null;
  evidence_contract: "raw_execution_trace" | "raw_memory_evidence";
};

type GatedAbstractionEntry = {
  source: "memory";
  node_id: string;
  uri: string;
  type: string;
  title: string | null;
  summary: string | null;
  summary_kind: string | null;
  lifecycle_state: string;
  authority: string;
  gate_state: "admitted" | "candidate" | "contested" | "blocked";
  use_contract: "bounded_guidance" | "candidate_only_needs_raw_evidence" | "candidate_only_with_counterexamples" | "do_not_use";
  gate_reason: string;
  applies_when: string[];
  does_not_apply_when: string[];
  counterexamples: string[];
  source_episode_refs: string[];
  promotion_reason: string | null;
  promotion_state: string | null;
  source_evidence_refs: string[];
};

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

function memorySourceEvidenceRefs(node: MemoryNodeDTO): string[] {
  return uniqueStrings([
    node.raw_ref,
    node.evidence_ref,
    ...collectEvidenceRefsFromSlots(node.slots),
  ], 32);
}

function recordStringList(...values: unknown[]): string[] {
  const out: string[] = [];
  const pushValue = (value: unknown) => {
    const single = stringValue(value);
    if (single) {
      out.push(single);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const ref = firstString(record.ref, record.uri, record.raw_ref, record.evidence_ref, record.node_id, record.id);
    if (ref) out.push(ref);
  };
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) pushValue(item);
    } else {
      pushValue(value);
    }
  }
  return uniqueStrings(out, 32);
}

function nestedSlotRecords(slots: unknown): Record<string, unknown>[] {
  const root = asRecord(slots);
  if (!root) return [];
  return [
    root,
    asRecord(root.execution_native_v1),
    asRecord(root.promotion),
    asRecord(root.workflow_promotion),
    asRecord(root.policy_evolution),
    asRecord(root.distillation),
    asRecord(root.abstraction_boundary_v1),
    asRecord(root.promotion_evidence_ledger_v1),
    asRecord(root.contract_trust),
  ].filter((record): record is Record<string, unknown> => !!record);
}

function firstNestedString(slots: unknown, keys: string[]): string | null {
  for (const record of nestedSlotRecords(slots)) {
    for (const key of keys) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function nestedStringList(slots: unknown, keys: string[]): string[] {
  const out: string[] = [];
  for (const record of nestedSlotRecords(slots)) {
    for (const key of keys) out.push(...recordStringList(record[key]));
  }
  return uniqueStrings(out, 32);
}

function summaryKindFromSlots(slots: unknown): string | null {
  return firstNestedString(slots, [
    "summary_kind",
    "execution_kind",
    "anchor_kind",
    "source_kind",
    "preferred_promotion_target",
  ]);
}

function lifecycleStateFromNode(node: MemoryNodeDTO): string {
  return firstNestedString(node.slots, [
    "lifecycle_state",
    "memory_state",
    "policy_memory_state",
    "credibility_state",
    "promotion_state",
    "maintenance_state",
  ]) ?? "active";
}

function promotionStateFromNode(node: MemoryNodeDTO): string | null {
  return firstNestedString(node.slots, [
    "promotion_state",
    "policy_state",
    "policy_memory_state",
    "credibility_state",
    "abstraction_state",
    "maintenance_state",
  ]);
}

function authorityFromNode(node: MemoryNodeDTO): string {
  return firstNestedString(node.slots, [
    "authority",
    "authority_effect",
    "authority_scope",
    "activation_mode",
  ]) ?? "advisory";
}

function promotionReasonFromNode(node: MemoryNodeDTO): string | null {
  return firstNestedString(node.slots, [
    "promotion_reason",
    "admission_reason",
    "last_transition",
    "last_transition_reason",
    "source_kind",
  ]);
}

function nodeAppliesWhen(node: MemoryNodeDTO): string[] {
  return nestedStringList(node.slots, [
    "applies_when",
    "applicable_when",
    "activation_conditions",
    "pattern_hints",
    "workflow_steps",
    "key_steps",
  ]);
}

function nodeDoesNotApplyWhen(node: MemoryNodeDTO): string[] {
  return nestedStringList(node.slots, [
    "does_not_apply_when",
    "not_applicable_when",
    "exceptions",
    "negative_conditions",
    "blocked_conditions",
  ]);
}

function nodeCounterexamples(node: MemoryNodeDTO): string[] {
  return nestedStringList(node.slots, [
    "counterexamples",
    "counter_evidence",
    "counter_evidence_refs",
    "counterexample_refs",
    "failed_examples",
  ]);
}

function nodeSourceEpisodeRefs(node: MemoryNodeDTO): string[] {
  return uniqueStrings([
    ...nestedStringList(node.slots, [
      "source_episode_refs",
      "source_event_refs",
      "source_node_refs",
      "source_refs",
      "promotion_evidence_refs",
      "evidence_refs",
      "citations",
    ]),
    ...memorySourceEvidenceRefs(node),
  ], 32);
}

function isAbstractionMemoryNode(node: MemoryNodeDTO): boolean {
  const summaryKind = summaryKindFromSlots(node.slots);
  if (summaryKind) {
    const normalized = summaryKind.toLowerCase();
    if (
      normalized.includes("abstraction")
      || normalized.includes("anchor")
      || normalized.includes("policy")
      || normalized.includes("distillation")
      || normalized.includes("workflow")
      || normalized.includes("pattern")
      || normalized.includes("compression")
    ) return true;
  }
  if (nodeAppliesWhen(node).length > 0 || nodeDoesNotApplyWhen(node).length > 0 || nodeCounterexamples(node).length > 0) return true;
  return node.type === "procedure" || node.type === "rule";
}

function gateForAbstraction(entry: {
  lifecycleState: string;
  promotionState: string | null;
  sourceEpisodeRefs: string[];
  counterexamples: string[];
}): Pick<GatedAbstractionEntry, "gate_state" | "use_contract" | "gate_reason"> {
  const lifecycle = entry.lifecycleState.toLowerCase();
  const promotion = (entry.promotionState ?? "").toLowerCase();
  if (
    lifecycle.includes("archive")
    || lifecycle.includes("retired")
    || lifecycle.includes("stale")
    || lifecycle.includes("blocked")
    || promotion.includes("retired")
    || promotion.includes("blocked")
  ) {
    return {
      gate_state: "blocked",
      use_contract: "do_not_use",
      gate_reason: "lifecycle_or_promotion_state_blocks_reuse",
    };
  }
  if (lifecycle.includes("contested") || promotion.includes("contested") || entry.counterexamples.length > 0) {
    return {
      gate_state: "contested",
      use_contract: "candidate_only_with_counterexamples",
      gate_reason: "counterexamples_or_contested_state_require_careful_use",
    };
  }
  if (entry.sourceEpisodeRefs.length === 0) {
    return {
      gate_state: "candidate",
      use_contract: "candidate_only_needs_raw_evidence",
      gate_reason: "abstraction_has_no_source_episode_refs",
    };
  }
  return {
    gate_state: "admitted",
    use_contract: "bounded_guidance",
    gate_reason: "source_episode_refs_available",
  };
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
  const consolidationGuardBlockedNodeIds: string[] = [];
  for (const node of args.nodes) {
    const outcome = classifyExecutionOutcome(node.slots);
    const rehydrationRefs = memoryRehydrationRefs(node);
    const sourceEvidenceRefs = memorySourceEvidenceRefs(node);
    const hasExecutionOutcome = outcome !== "unknown";
    const evidenceBacked = sourceEvidenceRefs.length > 0;
    const promotionAllowed = !hasExecutionOutcome || evidenceBacked;
    const promotionBlockedReason = promotionAllowed ? null : "memory_execution_summary_without_raw_or_evidence_refs";
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
      rehydration_refs: rehydrationRefs,
      source_evidence_refs: sourceEvidenceRefs,
      evidence_backed: evidenceBacked,
      raw_trace_backed: false,
      supporting_raw_trace_count: 0,
      promotion_allowed: promotionAllowed,
      promotion_blocked: !promotionAllowed,
      promotion_blocked_reason: promotionBlockedReason,
      consolidation_guard: hasExecutionOutcome
        ? {
            policy: "require_raw_or_evidence_refs_for_execution_memory_promotion",
            evidence_backed: evidenceBacked,
            promotion_allowed: promotionAllowed,
            blocked_reason: promotionBlockedReason,
          }
        : null,
    };
    if (outcome === "passed") {
      if (promotionAllowed) {
        if (validated.length < args.parsed.max_validated_evidence) validated.push(base);
      } else {
        consolidationGuardBlockedNodeIds.push(node.id);
        if (supporting.length < args.parsed.max_supporting_evidence) supporting.push(base);
      }
    } else if (outcome === "failed") {
      if (promotionAllowed && failed.length < args.parsed.max_failed_branches) {
        failed.push({
          ...base,
          branch_role: "failed" as const,
          diagnostic_note: diagnosticNote(node),
          avoid_next_action: true,
        });
      } else if (!promotionAllowed) {
        consolidationGuardBlockedNodeIds.push(node.id);
        if (supporting.length < args.parsed.max_supporting_evidence) {
          supporting.push({
            ...base,
            branch_role: "failed" as const,
            diagnostic_note: diagnosticNote(node),
            avoid_next_action: false,
          });
        }
      }
    } else if (supporting.length < args.parsed.max_supporting_evidence) {
      supporting.push(base);
    }
  }
  return { validated, failed, supporting, consolidationGuardBlockedNodeIds };
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

function rawEvidenceFromTreeAndMemory(args: {
  activeRaw: ReturnType<typeof stateEntries>;
  passedSolutions: unknown[];
  failedBranches: unknown[];
  memoryNodes: MemoryNodeDTO[];
  maxEntries: number;
}): RawEvidenceEntry[] {
  const out = new Map<string, RawEvidenceEntry>();
  const remember = (entry: RawEvidenceEntry) => {
    if (out.size >= args.maxEntries && !out.has(entry.node_id)) return;
    out.set(entry.node_id, entry);
  };

  for (const entry of args.activeRaw) {
    remember({
      source: "execution_tree_raw",
      node_id: entry.node_id,
      owner_node_id: null,
      title: entry.title,
      action: entry.action,
      observation: entry.observation,
      status: entry.status,
      refs: [],
      evidence_contract: "raw_execution_trace",
    });
  }

  for (const trace of supportingRawTraceFromRecords([...args.passedSolutions, ...args.failedBranches])) {
    const nodeId = stringValue(trace.node_id);
    if (!nodeId) continue;
    remember({
      source: "execution_tree_raw",
      node_id: nodeId,
      owner_node_id: stringValue(trace.owner_node_id),
      title: stringValue(trace.title),
      action: stringValue(trace.action),
      observation: stringValue(trace.observation),
      status: stringValue(trace.status),
      refs: recordStringArray(trace, "refs"),
      evidence_contract: "raw_execution_trace",
    });
  }

  for (const node of args.memoryNodes) {
    if (out.size >= args.maxEntries) break;
    const refs = memorySourceEvidenceRefs(node);
    if (node.type !== "event" && node.type !== "evidence" && refs.length === 0) continue;
    const slots = asRecord(node.slots);
    const result = asRecord(slots?.execution_result_summary);
    remember({
      source: "memory",
      node_id: node.id,
      uri: node.uri,
      type: node.type,
      title: node.title,
      summary: firstString(result?.summary, result?.solution_summary, result?.message, node.text_summary),
      outcome: classifyExecutionOutcome(node.slots),
      refs,
      raw_ref: node.raw_ref ?? null,
      evidence_ref: node.evidence_ref ?? null,
      evidence_contract: "raw_memory_evidence",
    });
  }

  return Array.from(out.values()).slice(0, args.maxEntries);
}

function gatedAbstractionsFromMemoryNodes(nodes: MemoryNodeDTO[], maxEntries: number): GatedAbstractionEntry[] {
  const out: GatedAbstractionEntry[] = [];
  for (const node of nodes) {
    if (out.length >= maxEntries) break;
    if (!isAbstractionMemoryNode(node)) continue;
    const lifecycleState = lifecycleStateFromNode(node);
    const promotionState = promotionStateFromNode(node);
    const counterexamples = nodeCounterexamples(node);
    const sourceEpisodeRefs = nodeSourceEpisodeRefs(node);
    const gate = gateForAbstraction({
      lifecycleState,
      promotionState,
      sourceEpisodeRefs,
      counterexamples,
    });
    out.push({
      source: "memory",
      node_id: node.id,
      uri: node.uri,
      type: node.type,
      title: node.title,
      summary: node.text_summary ? truncate(node.text_summary, 1_200) : null,
      summary_kind: summaryKindFromSlots(node.slots),
      lifecycle_state: lifecycleState,
      authority: authorityFromNode(node),
      ...gate,
      applies_when: nodeAppliesWhen(node),
      does_not_apply_when: nodeDoesNotApplyWhen(node),
      counterexamples,
      source_episode_refs: sourceEpisodeRefs,
      promotion_reason: promotionReasonFromNode(node),
      promotion_state: promotionState,
      source_evidence_refs: memorySourceEvidenceRefs(node),
    });
  }
  return out;
}

function hasEvidenceBacking(record: unknown): boolean {
  const item = asRecord(record);
  if (!item) return false;
  if (item.evidence_backed === true) return true;
  return recordStringArray(item, "source_evidence_refs").length > 0
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

function compactAgentText(value: unknown, maxChars: number): string | null {
  const text = stringValue(value);
  if (!text) return null;
  return truncate(text.replace(/\s+/g, " ").trim(), maxChars);
}

function recordFirstText(record: Record<string, unknown>, keys: string[], maxChars: number): string | null {
  for (const key of keys) {
    const text = compactAgentText(record[key], maxChars);
    if (text) return text;
  }
  return null;
}

function addAgentLine(lines: string[], line: string | null | undefined, maxLines: number): void {
  if (!line || lines.length >= maxLines) return;
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized || lines.includes(normalized)) return;
  lines.push(normalized);
}

function executionRecordNodeId(record: Record<string, unknown>): string | null {
  return firstString(record.node_id, record.uri, record.id);
}

function executionUseNowLine(
  label: "Current active path" | "Passed solution",
  record: Record<string, unknown>,
): string | null {
  const text = recordFirstText(record, ["summary", "observation", "action", "title"], 260);
  if (!text) return null;
  const nodeId = executionRecordNodeId(record);
  const suffix = nodeId ? ` node=${nodeId}` : "";
  return `${label}: ${text}${suffix}`;
}

function failedBranchLine(record: Record<string, unknown>): string | null {
  const text = recordFirstText(record, ["diagnostic_note", "summary", "observation", "title"], 220);
  if (!text) return null;
  const nodeId = executionRecordNodeId(record);
  const suffix = nodeId ? ` node=${nodeId}` : "";
  return `Avoid failed branch: ${text}${suffix}`;
}

function admittedAbstractionLine(entry: GatedAbstractionEntry): string | null {
  const summary = compactAgentText(entry.summary, 220);
  if (!summary) return null;
  const applies = entry.applies_when.length > 0
    ? ` applies_when=${truncate(entry.applies_when.join(" | "), 180)}`
    : "";
  const excludes = entry.does_not_apply_when.length > 0
    ? ` does_not_apply_when=${truncate(entry.does_not_apply_when.join(" | "), 180)}`
    : "";
  return `Bounded guidance: ${summary} node=${entry.node_id}${applies}${excludes}`;
}

function gatedAbstractionInspectLine(entry: GatedAbstractionEntry): string {
  return `Inspect gated abstraction before use: node=${entry.node_id} gate=${entry.gate_state} use=${entry.use_contract} reason=${truncate(entry.gate_reason, 160)}`;
}

function gatedAbstractionBlockedLine(entry: GatedAbstractionEntry): string {
  return `Do not use gated abstraction: node=${entry.node_id} reason=${truncate(entry.gate_reason, 160)}`;
}

function agentPromptPostureLabel(value: AionisAgentContext["recommended_posture"]): string {
  switch (value) {
    case "ignore_history": return "ignore";
    case "rehydrate_before_use": return "rehydrate";
    case "inspect_before_use": return "inspect";
    case "reuse_supported_history": return "reuse";
    case "use_as_context": return "context";
  }
}

function agentPromptAuthorityLabel(value: AionisAgentContext["authority"]): string {
  switch (value) {
    case "trusted": return "trust";
    case "advisory": return "adv";
    case "candidate": return "cand";
    case "blocked": return "block";
    case "none": return "none";
  }
}

function agentPromptRiskLabel(value: AionisAgentContext["risk"]["negative_transfer_risk"]): string {
  switch (value) {
    case "high": return "hi";
    case "medium": return "med";
    case "low": return "low";
  }
}

function buildExecutionAgentPrompt(args: {
  summary: string;
  historyUsed: boolean;
  actionableHistoryUsed: boolean;
  recommendedPosture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
  negativeTransferRisk: AionisAgentContext["risk"]["negative_transfer_risk"];
  useNow: string[];
  inspectBeforeUse: string[];
  doNotUse: string[];
  rehydrateHints: AionisAgentContext["rehydrate_hints"];
  memoryIds: string[];
  budget: number;
}): string {
  const render = (profile: {
    summaryChars: number;
    currentItems: number;
    currentChars: number;
    procedureItems: number;
    procedureChars: number;
    inspectItems: number;
    inspectChars: number;
    avoidItems: number;
    avoidChars: number;
    rehydrateItems: number;
    rehydrateChars: number;
    memoryIdItems: number;
  }) => {
    const line = (label: string, values: string[], maxItems: number, maxChars: number): string[] => {
      if (maxItems <= 0) return [];
      return values.slice(0, maxItems).map((value) => `${label}: note=${truncate(value, maxChars)}`);
    };
    const currentLines = args.useNow.filter((value) => value.startsWith("Current active path:"));
    const procedureLines = args.useNow.filter((value) => !value.startsWith("Current active path:"));
    const nextActionSource = currentLines[0] ?? args.useNow[0] ?? args.inspectBeforeUse[0] ?? null;
    const nextAction = nextActionSource
      ? nextActionSource.replace(/^(?:Current active path|Passed solution|Admitted abstraction|Inspect gated abstraction before use):\s*/i, "")
      : null;
    return uniqueStrings([
      "AIONIS_CTX v2",
      `state r=agent h=${args.historyUsed ? 1 : 0} a=${args.actionableHistoryUsed ? 1 : 0} p=${agentPromptPostureLabel(args.recommendedPosture)} auth=${agentPromptAuthorityLabel(args.authority)} risk=${agentPromptRiskLabel(args.negativeTransferRisk)}`,
      args.actionableHistoryUsed
        ? `next ${nextAction ? `action=${truncate(nextAction, profile.currentChars)} ` : ""}actor_role=agent`
        : null,
      `summary ${truncate(args.summary, profile.summaryChars)}`,
      ...line("current", currentLines.length > 0 ? currentLines : args.useNow.slice(0, 1), profile.currentItems, profile.currentChars),
      ...line("procedure", procedureLines, profile.procedureItems, profile.procedureChars),
      ...line("inspect", args.inspectBeforeUse, profile.inspectItems, profile.inspectChars),
      ...line("avoid", args.doNotUse, profile.avoidItems, profile.avoidChars),
      args.rehydrateHints.length > 0 && profile.rehydrateItems > 0
        ? `rehydrate: ${args.rehydrateHints
          .slice(0, profile.rehydrateItems)
          .map((entry) => `id=${truncate(entry.memory_id, 90)} reason=${truncate(entry.reason, profile.rehydrateChars)}`)
          .join(" | ")}`
        : null,
      args.memoryIds.length > 0 && profile.memoryIdItems > 0
        ? `ids ${args.memoryIds.slice(0, profile.memoryIdItems).join(",")}`
        : null,
    ], 16).join("\n");
  };

  const profiles = [
    { summaryChars: 240, currentItems: 2, currentChars: 200, procedureItems: 3, procedureChars: 180, inspectItems: 3, inspectChars: 130, avoidItems: 3, avoidChars: 130, rehydrateItems: 3, rehydrateChars: 80, memoryIdItems: 10 },
    { summaryChars: 150, currentItems: 1, currentChars: 140, procedureItems: 2, procedureChars: 120, inspectItems: 2, inspectChars: 90, avoidItems: 2, avoidChars: 90, rehydrateItems: 2, rehydrateChars: 60, memoryIdItems: 8 },
    { summaryChars: 100, currentItems: 1, currentChars: 100, procedureItems: 1, procedureChars: 90, inspectItems: 1, inspectChars: 70, avoidItems: 1, avoidChars: 70, rehydrateItems: 1, rehydrateChars: 50, memoryIdItems: 6 },
  ];
  let lastPrompt = "";
  for (const profile of profiles) {
    const prompt = render(profile);
    lastPrompt = prompt;
    if (prompt.length <= args.budget) return prompt;
  }
  return truncate(lastPrompt, args.budget);
}

function buildExecutionAgentContext(args: {
  tenantId: string;
  scope: string;
  tree: ExecutionTreeV1 | null;
  activeCompressed: ReturnType<typeof stateEntries>;
  activeRaw: ReturnType<typeof stateEntries>;
  passedSolutions: unknown[];
  failedBranches: unknown[];
  rawEvidence: RawEvidenceEntry[];
  gatedAbstractions: GatedAbstractionEntry[];
  rehydrationRefs: string[];
  selectionTrace: Record<string, unknown>;
  budget: number;
}): AionisAgentContext {
  const useNow: string[] = [];
  const inspectBeforeUse: string[] = [];
  const doNotUse: string[] = [];
  const memoryIds: string[] = [];
  const workflowIds: string[] = [];

  if (args.tree?.tree_id) workflowIds.push(args.tree.tree_id);

  for (const entry of args.activeCompressed.slice(-1) as Array<Record<string, unknown>>) {
    addAgentLine(useNow, executionUseNowLine("Current active path", entry), 4);
    const nodeId = executionRecordNodeId(entry);
    if (nodeId) memoryIds.push(nodeId);
  }
  if (useNow.length === 0) {
    for (const entry of args.activeRaw.slice(-1) as Array<Record<string, unknown>>) {
      addAgentLine(useNow, executionUseNowLine("Current active path", entry), 4);
      const nodeId = executionRecordNodeId(entry);
      if (nodeId) memoryIds.push(nodeId);
    }
  }

  for (const entry of args.passedSolutions.filter(hasEvidenceBacking).slice(0, 3) as Array<Record<string, unknown>>) {
    addAgentLine(useNow, executionUseNowLine("Passed solution", entry), 5);
    const nodeId = executionRecordNodeId(entry);
    if (nodeId) memoryIds.push(nodeId);
  }

  for (const entry of args.failedBranches.slice(0, 3) as Array<Record<string, unknown>>) {
    addAgentLine(doNotUse, failedBranchLine(entry), 4);
    const nodeId = executionRecordNodeId(entry);
    if (nodeId) memoryIds.push(nodeId);
  }

  let admittedAbstractionCount = 0;
  let inspectAbstractionCount = 0;
  let blockedAbstractionCount = 0;
  for (const entry of args.gatedAbstractions) {
    memoryIds.push(entry.node_id);
    if (entry.gate_state === "admitted" && entry.use_contract === "bounded_guidance") {
      admittedAbstractionCount += 1;
      addAgentLine(useNow, admittedAbstractionLine(entry), 5);
    } else if (entry.gate_state === "blocked" || entry.use_contract === "do_not_use") {
      blockedAbstractionCount += 1;
      addAgentLine(doNotUse, gatedAbstractionBlockedLine(entry), 4);
    } else {
      inspectAbstractionCount += 1;
      addAgentLine(inspectBeforeUse, gatedAbstractionInspectLine(entry), 4);
    }
  }

  const rehydrateHints = args.rehydrationRefs.slice(0, 4).map((ref) => ({
    memory_id: ref,
    reason: "Raw execution evidence is available outside the compact agent context.",
    required: false,
  }));
  const historyUsed = useNow.length > 0 || inspectBeforeUse.length > 0 || doNotUse.length > 0 || rehydrateHints.length > 0;
  const actionableHistoryUsed = historyUsed;
  const negativeTransferRisk: AionisAgentContext["risk"]["negative_transfer_risk"] =
    blockedAbstractionCount > 0
      ? "high"
      : doNotUse.length > 0 || inspectBeforeUse.length > 0
        ? "medium"
        : "low";
  const recommendedPosture: AionisAgentContext["recommended_posture"] = !historyUsed
    ? "ignore_history"
    : inspectBeforeUse.length > 0 && useNow.length === 0
      ? "inspect_before_use"
      : "reuse_supported_history";
  const authority: AionisAgentContext["authority"] = !historyUsed
    ? "none"
    : useNow.length > 0
      ? "advisory"
      : blockedAbstractionCount > 0 && inspectBeforeUse.length === 0
        ? "blocked"
        : "candidate";
  const summary = historyUsed
    ? [
        "Execution evidence was compiled into a compact agent context.",
        `${useNow.length} direct guidance item(s), ${doNotUse.length} avoidance item(s), ${inspectBeforeUse.length} inspect-first item(s).`,
        `${args.rawEvidence.length} raw evidence item(s) and full selection trace remain on audit fields, not in the agent prompt.`,
      ].join(" ")
    : "No usable execution history was recovered for the agent context.";
  const compactMemoryIds = uniqueStrings(memoryIds, 16);
  const compactWorkflowIds = uniqueStrings(workflowIds, 8);
  const promptText = buildExecutionAgentPrompt({
    summary,
    historyUsed,
    actionableHistoryUsed,
    recommendedPosture,
    authority,
    negativeTransferRisk,
    useNow,
    inspectBeforeUse,
    doNotUse,
    rehydrateHints,
    memoryIds: compactMemoryIds,
    budget: args.budget,
  });

  return parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    prompt_text: promptText,
    summary,
    history_used: historyUsed,
    actionable_history_used: actionableHistoryUsed,
    recommended_posture: recommendedPosture,
    authority,
    target_files: [],
    use_now: useNow,
    inspect_before_use: inspectBeforeUse,
    do_not_use: doNotUse,
    memory_ids: compactMemoryIds,
    use_now_memory_ids: compactMemoryIds.filter((id) => useNow.some((line) => line.includes(id))).slice(0, 10),
    inspect_before_use_memory_ids: compactMemoryIds.filter((id) => inspectBeforeUse.some((line) => line.includes(id))).slice(0, 10),
    do_not_use_memory_ids: compactMemoryIds.filter((id) => doNotUse.some((line) => line.includes(id))).slice(0, 10),
    rehydrate_hints: rehydrateHints,
    risk: {
      negative_transfer_risk: negativeTransferRisk,
      blocked_authority_count: blockedAbstractionCount,
      stale_memory_count: 0,
      reasons: uniqueStrings([
        doNotUse.length > 0 ? "failed_execution_branches_kept_out_of_use_now" : null,
        inspectAbstractionCount > 0 ? "candidate_or_contested_abstractions_require_inspection" : null,
        admittedAbstractionCount > 0 ? "admitted_abstractions_are_bounded_guidance_only" : null,
      ], 6),
    },
    evidence_refs: {
      memory_ids: compactMemoryIds,
      workflow_ids: compactWorkflowIds,
      evidence_count:
        args.passedSolutions.length
        + args.failedBranches.length
        + args.rawEvidence.length
        + args.gatedAbstractions.length
        + (typeof args.selectionTrace.raw_trace_count === "number" ? args.selectionTrace.raw_trace_count : 0),
    },
  });
}

function buildPromptText(args: {
  activeCompressed: ReturnType<typeof stateEntries>;
  activeRaw: ReturnType<typeof stateEntries>;
  validatedEvidence: unknown[];
  supportingEvidence: unknown[];
  failedBranches: unknown[];
  rawEvidence: RawEvidenceEntry[];
  gatedAbstractions: GatedAbstractionEntry[];
  rehydrationRefs: string[];
  selectionTrace: Record<string, unknown>;
  contextMode: "execution_evidence" | "full_power";
  promptDetail: "compact" | "full";
}) {
  const lines: string[] = [];
  lines.push("AIONIS_EXECUTION_EVIDENCE_CONTEXT v1");
  if (args.contextMode === "full_power") {
    lines.push("mode=full_power");
    lines.push("contract: PASSED_SOLUTIONS are reusable only when evidence-backed; FAILED_BRANCHES are counter-evidence; RAW_EVIDENCE is first-class source material; GATED_ABSTRACTIONS require applies_when/does_not_apply_when boundaries.");
  }
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
      const promotionBlockedReason = stringValue(entry.promotion_blocked_reason);
      lines.push(`- node=${entry.node_id ?? ""} title=${entry.title ?? ""} summary=${entry.summary ?? ""}${promotionBlockedReason ? ` promotion_blocked=${promotionBlockedReason}` : ""}`);
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

  if (args.contextMode === "full_power") {
    lines.push("");
    lines.push("RAW_EVIDENCE");
    if (args.rawEvidence.length === 0) lines.push("- none");
    for (const entry of args.rawEvidence) {
      const text = firstString(entry.summary, entry.observation, entry.action, entry.title) ?? "";
      const refs = uniqueStrings([
        ...(entry.refs ?? []),
        entry.raw_ref ?? null,
        entry.evidence_ref ?? null,
      ], 12);
      lines.push(`- source=${entry.source} node=${entry.node_id} contract=${entry.evidence_contract} outcome=${entry.outcome ?? entry.status ?? "unknown"} text=${truncate(text, args.promptDetail === "full" ? 1_000 : 500)} refs=${refs.join(",")}`);
    }

    lines.push("");
    lines.push("GATED_ABSTRACTIONS");
    if (args.gatedAbstractions.length === 0) lines.push("- none");
    for (const entry of args.gatedAbstractions) {
      const applies = entry.applies_when.length > 0 ? entry.applies_when.join(" | ") : "unspecified";
      const excludes = entry.does_not_apply_when.length > 0 ? entry.does_not_apply_when.join(" | ") : "unspecified";
      const counterexamples = entry.counterexamples.length > 0 ? entry.counterexamples.join(" | ") : "none";
      lines.push(`- node=${entry.node_id} kind=${entry.summary_kind ?? entry.type} gate=${entry.gate_state} use=${entry.use_contract} title=${entry.title ?? ""} summary=${entry.summary ?? ""} applies_when=${truncate(applies, 400)} does_not_apply_when=${truncate(excludes, 400)} counterexamples=${truncate(counterexamples, 400)} source_refs=${entry.source_episode_refs.slice(0, 8).join(",")} reason=${entry.gate_reason}`);
    }

    lines.push("");
    lines.push("TRACE");
    lines.push(`- selection=${args.selectionTrace.source ?? "unknown"} memory_enabled=${args.selectionTrace.memory_enabled ?? false} memory_nodes=${args.selectionTrace.memory_nodes_considered ?? 0} guard_blocked=${args.selectionTrace.memory_consolidation_guard_blocked_count ?? 0}`);
    lines.push(`- counts passed=${args.selectionTrace.passed_solution_count ?? 0} failed=${args.selectionTrace.failed_branch_count ?? 0} raw=${args.rawEvidence.length} abstractions=${args.gatedAbstractions.length} rehydration_refs=${args.rehydrationRefs.length}`);
    lines.push("- policy raw evidence is not automatically a passed solution; failed branch raw traces explain what to avoid; gated abstractions are advisory unless admitted and source-backed.");
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
  const rawEvidence = parsed.context_mode === "full_power"
    ? rawEvidenceFromTreeAndMemory({
        activeRaw,
        passedSolutions,
        failedBranches,
        memoryNodes: memory.nodes,
        maxEntries: parsed.max_raw_evidence_entries,
      })
    : [];
  const gatedAbstractions = parsed.context_mode === "full_power"
    ? gatedAbstractionsFromMemoryNodes(memory.nodes, parsed.max_gated_abstractions)
    : [];
  const selectionTrace = {
    source: "execution_tree_first_memory_evidence_rehydration",
    context_mode: parsed.context_mode,
    memory_enabled: parsed.include_memory_evidence,
    memory_filters_considered: memory.filtersConsidered,
    direct_refs_considered: memory.directRefsConsidered,
    memory_nodes_considered: memory.nodes.length,
    memory_consolidation_guard_blocked_count: memoryEvidence.consolidationGuardBlockedNodeIds.length,
    memory_consolidation_guard_blocked_node_ids: memoryEvidence.consolidationGuardBlockedNodeIds,
    passed_solution_count: passedSolutions.length,
    supporting_evidence_count: memoryEvidence.supporting.length,
    failed_branch_count: failedBranches.length,
    raw_evidence_count: rawEvidence.length,
    gated_abstraction_count: gatedAbstractions.length,
    gated_abstraction_admitted_count: gatedAbstractions.filter((entry) => entry.gate_state === "admitted").length,
    gated_abstraction_candidate_count: gatedAbstractions.filter((entry) => entry.gate_state === "candidate").length,
    gated_abstraction_contested_count: gatedAbstractions.filter((entry) => entry.gate_state === "contested").length,
    gated_abstraction_blocked_count: gatedAbstractions.filter((entry) => entry.gate_state === "blocked").length,
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
  };
  const fullPowerTrace = parsed.context_mode === "full_power"
    ? {
        trace_version: "execution_context_full_power_trace_v1",
        sections: {
          current_active_path: activeCompressed.length + activeRaw.length,
          passed_solutions: passedSolutions.length,
          failed_branches: failedBranches.length,
          raw_evidence: rawEvidence.length,
          gated_abstractions: gatedAbstractions.length,
          supporting_evidence: memoryEvidence.supporting.length,
          rehydration_refs: rehydrationRefs.length,
        },
        contracts: [
          "passed_solutions_require_validation_or_evidence_backing",
          "failed_branches_are_counter_evidence_not_reusable_solutions",
          "raw_evidence_is_first_class_source_material",
          "gated_abstractions_are_bounded_by_applies_when_does_not_apply_when_counterexamples",
          "summary_only_execution_memory_is_blocked_from_promotion",
        ],
        selection_trace: selectionTrace,
      }
    : null;

  const promptText = parsed.include_prompt_text
    ? buildPromptText({
        activeCompressed,
        activeRaw,
        validatedEvidence: passedSolutions,
        supportingEvidence: memoryEvidence.supporting,
        failedBranches,
        rawEvidence,
        gatedAbstractions,
        rehydrationRefs,
        selectionTrace,
        contextMode: parsed.context_mode,
        promptDetail: parsed.prompt_detail,
      })
    : null;
  const agentContext = parsed.include_agent_context
    ? buildExecutionAgentContext({
        tenantId,
        scope,
        tree,
        activeCompressed,
        activeRaw,
        passedSolutions,
        failedBranches,
        rawEvidence,
        gatedAbstractions,
        rehydrationRefs,
        selectionTrace,
        budget: parsed.agent_context_char_budget,
      })
    : null;

  return {
    contract_version: "execution_evidence_context_v1",
    context_mode: parsed.context_mode,
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
    raw_evidence: rawEvidence,
    gated_abstractions: gatedAbstractions,
    rehydration_refs: rehydrationRefs,
    prompt_text: promptText,
    agent_context: agentContext,
    full_power_trace: fullPowerTrace,
    selection_trace: selectionTrace,
  };
}
