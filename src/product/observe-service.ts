import { z } from "zod";
import stableStringify from "fast-json-stable-stringify";

import type { ClaimLedgerAccess, ClaimLedgerRow } from "../store/memory-store.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { MemoryWriteRouteService } from "../routes/memory-write.js";
import type { HandoffRouteService } from "../routes/handoff.js";
import { HttpError } from "../util/http.js";

import {
  InternalDispatchResult,
  ProductObserveRequest,
  objectValue,
  productErrorResponse,
  stripUndefined,
  uniqueStrings,
} from "./product-services.js";

import {
  createHash,
  randomUUID,
} from "node:crypto";

import {
  normalizeExecutionOutcomeRoleFromValue,
} from "../memory/execution-outcome-role.js";
import { HandoffStoreRequest } from "../memory/schemas.js";
import type {
  ProductObserveInput,
  ProductObserveExecutionContext,
  ProductServiceResult,
  ProductServices,
} from "./product-services.js";
import {
  productServiceDependencyFailure,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
} from "./product-services.js";



type ProductObserveWriteIdentity = {
  tenantId: string;
  scope: string;
  actor?: string;
};

function mergeProductScope(
  identity: ProductObserveWriteIdentity,
  payload: Record<string, unknown> | undefined,
  options: { preserveNestedActor?: boolean } = {},
): Record<string, unknown> {
  const nestedActor = typeof payload?.actor === "string" && payload.actor.trim().length > 0
    ? payload.actor.trim()
    : undefined;
  return stripUndefined({
    ...(payload ?? {}),
    tenant_id: identity.tenantId,
    scope: identity.scope,
    actor: options.preserveNestedActor && nestedActor ? nestedActor : identity.actor,
  });
}

function assertObserveNestedIdentity(args: {
  parsed: ProductObserveInput;
  identity: ProductObserveWriteIdentity;
  enforceActor: boolean;
}): void {
  const expected: Record<"tenant_id" | "scope" | "actor", string | undefined> = {
    tenant_id: args.identity.tenantId,
    scope: args.identity.scope,
    actor: args.identity.actor,
  };
  for (const [surface, payload] of [
    ["memory", objectValue(args.parsed.memory)],
    ["handoff", objectValue(args.parsed.handoff)],
  ] as const) {
    if (!payload) continue;
    for (const key of ["tenant_id", "scope", "actor"] as const) {
      if (key === "actor" && !args.enforceActor) continue;
      const nested = typeof payload[key] === "string" ? payload[key].trim() : undefined;
      if (nested === undefined || nested === expected[key]) continue;
      throw new HttpError(
        400,
        "observe_nested_identity_conflict",
        `observe ${surface}.${key} must match the top-level observe identity`,
        {
          surface,
          field: key,
          top_level_value: expected[key] ?? null,
          nested_value: nested,
        },
      );
    }
  }
}

function observeWritePayload(
  parsed: z.infer<typeof ProductObserveRequest>,
  identity: ProductObserveWriteIdentity,
  options: { preserveNestedActor?: boolean } = {},
): {
  payload: Record<string, unknown>;
  structuring: ProductObserveStructuringSummary;
} | null {
  const hasInlineWrite =
    !!parsed.input_text
    || !!parsed.input_sha256
    || !!parsed.execution
    || (Array.isArray(parsed.nodes) && parsed.nodes.length > 0)
    || (Array.isArray(parsed.edges) && parsed.edges.length > 0);
  if (!parsed.memory && !hasInlineWrite) return null;
  const structured = structureProductObserveMemoryInput(parsed);
  const payload = mergeProductScope(identity, {
    ...(parsed.memory ?? {}),
    input_text: structured.input_text,
    input_sha256: parsed.input_sha256,
    model_version: parsed.model_version,
    prompt_version: parsed.prompt_version,
    auto_embed: parsed.auto_embed,
    memory_lane: parsed.memory_lane,
    producer_agent_id: parsed.producer_agent_id,
    owner_agent_id: parsed.owner_agent_id,
    owner_team_id: parsed.owner_team_id,
    force_reembed: parsed.force_reembed,
    distill: parsed.distill,
    edges: parsed.edges,
    nodes: structured.nodes,
  }, options);
  return {
    payload,
    structuring: structured.summary,
  };
}

function productObservedExecutionMemoryCount(summary: ProductObserveStructuringSummary | null | undefined): number {
  if (!summary) return 0;
  const alreadyStructuredExecutionCount = summary.structured_nodes.filter((node) =>
    node.classification === "already_structured"
    && node.source === "execution"
    && !!node.execution_kind
  ).length;
  return summary.execution_workflow_count + alreadyStructuredExecutionCount;
}

function parseStringListJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function firstWrittenMemoryNodeId(write: InternalDispatchResult | null): string | null {
  if (!write?.ok) return null;
  const body = objectValue(write.body);
  const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
  for (const node of nodes) {
    const record = objectValue(node);
    if (typeof record?.id === "string" && record.id.trim().length > 0) return record.id;
  }
  return null;
}

function buildClaimObserveReceipt(rows: ClaimLedgerRow[]) {
  const supersededClaimIds = uniqueStrings(rows.flatMap((row) => parseStringListJson(row.supersedes_claim_ids_json)));
  const contestedClaimIds = rows
    .filter((row) => row.status === "contested")
    .map((row) => row.claim_id);
  return {
    contract_version: "aionis_claim_observe_receipt_v1",
    written_count: rows.length,
    claim_ids: rows.map((row) => row.claim_id),
    superseded_claim_ids: supersededClaimIds,
    contested_claim_ids: contestedClaimIds,
    agent_prompt_included: false,
    runtime_mutation: true,
  };
}

async function writeProductObserveClaims(args: {
  claimLedgerAccess: ClaimLedgerAccess | null | undefined;
  claims: NonNullable<z.infer<typeof ProductObserveRequest>["claims"]>;
  write: InternalDispatchResult | null;
  tenantId: string;
  scope: string;
}) {
  const claims = args.claims;
  if (claims.length === 0) return null;
  if (!args.claimLedgerAccess) {
    return {
      ok: false as const,
      statusCode: 503,
      body: productErrorResponse({
        status: 503,
        error: "claim_ledger_unavailable",
        message: "claim ledger is not available for this Runtime",
      }),
    };
  }

  const sourceMemoryId = firstWrittenMemoryNodeId(args.write);
  const rows: ClaimLedgerRow[] = [];
  for (const claim of claims) {
    rows.push(await args.claimLedgerAccess.writeClaim({
      scope: args.scope,
      tenantId: args.tenantId,
      claim: {
        ...claim,
        source_memory_id: claim.source_memory_id ?? sourceMemoryId ?? undefined,
      },
    }));
  }
  return {
    ok: true as const,
    receipt: buildClaimObserveReceipt(rows),
  };
}

export type ProductObserveStructuringSummary = {
  schema_version: "aionis_observe_structuring_v1";
  mode: "auto";
  input_node_count: number;
  auto_text_node_count: number;
  passthrough_node_count: number;
  already_structured_node_count: number;
  execution_workflow_count: number;
  execution_observation_count: number;
  general_memory_count: number;
  structured_nodes: Array<{
    client_id: string | null;
    type: string;
    classification: "already_structured" | "execution_workflow" | "general_memory" | "passthrough";
    execution_kind: string | null;
    source: "node" | "memory" | "memory.nodes" | "input_text" | "execution";
  }>;
};

export type ProductObserveMemoryInput = {
  input_text?: string;
  memory_kind?: string;
  nodes?: Record<string, unknown>[];
  memory?: Record<string, unknown>;
  execution?: Record<string, unknown>;
};

export type StructuredProductObserveMemoryInput = {
  input_text: string | undefined;
  nodes: Record<string, unknown>[] | undefined;
  summary: ProductObserveStructuringSummary;
};

function observeStructureStripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function observeStructureProductRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function observeStructureProductString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function observeStructureProductFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = observeStructureProductString(value);
    if (text) return text;
  }
  return null;
}

function observeStructureProductStringList(value: unknown, limit = 64): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const text = observeStructureProductString(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function observeStructureProductRecordList(value: unknown, limit = 64): Record<string, unknown>[] {
  const input = Array.isArray(value) ? value : [];
  const out: Record<string, unknown>[] = [];
  for (const item of input) {
    const record = observeStructureProductRecord(item);
    if (!record) continue;
    out.push(record);
    if (out.length >= limit) break;
  }
  return out;
}

function observeStructureProductSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  if (slug) return slug;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function observeStructureProductTitleFromText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 96) return normalized;
  return `${normalized.slice(0, 93)}...`;
}

function observeStructureHasProductExecutionSurface(slots: Record<string, unknown> | null): boolean {
  return !!observeStructureProductRecord(slots?.execution_native_v1) || !!observeStructureProductRecord(slots?.anchor_v1);
}

function observeStructureProductMemoryKind(node: Record<string, unknown>, slots: Record<string, unknown> | null): string | null {
  return observeStructureProductFirstString(node.memory_kind, node.kind, slots?.memory_kind)?.toLowerCase() ?? null;
}

function observeStructureProductContractTrust(value: unknown): "authoritative" | "advisory" | "observational" | null {
  const text = observeStructureProductString(value);
  if (text === "authoritative" || text === "advisory" || text === "observational") return text;
  return null;
}

function observeStructureIsGeneralMemoryKind(kind: string | null): boolean {
  return kind === "general_memory" || kind === "general" || kind === "knowledge" || kind === "note";
}

function observeStructureHasWorkflowInputSignal(node: Record<string, unknown>, slots: Record<string, unknown> | null): boolean {
  const targetFiles = [
    ...observeStructureProductStringList(node.target_files),
    ...observeStructureProductStringList(slots?.target_files),
  ];
  return !!observeStructureProductFirstString(
    node.workflow_signature,
    slots?.workflow_signature,
    node.task_signature,
    slots?.task_signature,
    node.next_action,
    slots?.next_action,
    node.file_path,
    slots?.file_path,
    targetFiles[0],
  ) || observeStructureProductStringList(node.tool_set).length > 0
    || observeStructureProductStringList(slots?.tool_set).length > 0
    || observeStructureProductStringList(node.workflow_steps).length > 0
    || observeStructureProductStringList(slots?.workflow_steps).length > 0;
}

function observeStructureHasMemoryObjectSignal(memory: Record<string, unknown>): boolean {
  const slots = observeStructureProductRecord(memory.slots);
  return !!observeStructureProductMemoryKind(memory, slots)
    || !!observeStructureProductFirstString(
      memory.type,
      memory.title,
      memory.text_summary,
      memory.summary,
      memory.content,
      memory.workflow_signature,
      memory.task_signature,
      memory.next_action,
    )
    || observeStructureProductStringList(memory.target_files).length > 0
    || observeStructureProductStringList(memory.workflow_steps).length > 0
    || observeStructureProductStringList(memory.tool_set).length > 0;
}

function observeStructureMemoryObjectAsNode(memory: Record<string, unknown>): Record<string, unknown> {
  const slots = observeStructureProductRecord(memory.slots);
  const kind = observeStructureProductMemoryKind(memory, slots);
  const executionLike = kind === "execution_workflow" || kind === "workflow" || observeStructureHasWorkflowInputSignal(memory, slots);
  return {
    ...memory,
    type: observeStructureProductFirstString(memory.type, executionLike ? "procedure" : "concept"),
    title: observeStructureProductFirstString(memory.title, memory.name, memory.summary, memory.text_summary, "Observed memory"),
    text_summary: observeStructureProductFirstString(memory.text_summary, memory.summary, memory.content, memory.title, "Observed memory"),
  };
}

function observeStructureInputTextAsNode(parsed: ProductObserveMemoryInput): Record<string, unknown> | null {
  const text = observeStructureProductString(parsed.input_text);
  if (!text) return null;
  const memory = observeStructureProductRecord(parsed.memory);
  const slots = observeStructureProductRecord(memory?.slots);
  const kind = observeStructureProductFirstString(parsed.memory_kind, memory?.memory_kind, memory?.kind, slots?.memory_kind)
    ?.toLowerCase();
  const executionLike = kind === "execution_workflow" || kind === "workflow";
  const title = observeStructureProductFirstString(memory?.title, memory?.name, observeStructureProductTitleFromText(text)) ?? "Observed memory";
  return {
    client_id: observeStructureProductFirstString(memory?.client_id, `observe:text:${observeStructureProductSlug(text)}`),
    type: executionLike ? "procedure" : "concept",
    memory_kind: executionLike ? "execution_workflow" : "general_memory",
    title,
    text_summary: observeStructureProductFirstString(memory?.text_summary, memory?.summary, memory?.content, text) ?? text,
    confidence: typeof memory?.confidence === "number" ? memory.confidence : 0.6,
    slots: {
      ...(slots ?? {}),
      memory_kind: executionLike ? "execution_workflow" : "general_memory",
      product_observe_v1: {
        ...(observeStructureProductRecord(slots?.product_observe_v1) ?? {}),
        schema_version: "product_observe_v1",
        input_surface: "input_text",
        memory_kind: executionLike ? "execution_workflow" : "general_memory",
        auto_structured: true,
      },
    },
  };
}

function observeStructureExecutionObservationAsNode(parsed: ProductObserveMemoryInput): Record<string, unknown> | null {
  const execution = observeStructureProductRecord(parsed.execution);
  if (!execution) return null;
  const slots = { ...(observeStructureProductRecord(execution.slots) ?? {}) };
  const summary = observeStructureProductFirstString(execution.summary, parsed.input_text, execution.title, "Observed execution")
    ?? "Observed execution";
  const title = observeStructureProductFirstString(execution.title, summary, "Observed execution") ?? "Observed execution";
  const targetFiles = observeStructureProductStringList([
    ...observeStructureProductStringList(execution.target_files),
    ...observeStructureProductStringList(execution.files),
    ...observeStructureProductStringList(slots.target_files),
  ]);
  const toolSet = observeStructureProductStringList([
    ...observeStructureProductStringList(execution.tool_set),
    ...observeStructureProductStringList(execution.tools),
    ...observeStructureProductStringList(slots.tool_set),
  ]);
  const workflowSteps = observeStructureProductStringList([
    ...observeStructureProductStringList(execution.workflow_steps),
    ...observeStructureProductStringList(execution.steps),
    ...observeStructureProductStringList(slots.workflow_steps),
  ]);
  const acceptanceChecks = observeStructureProductStringList([
    ...observeStructureProductStringList(execution.acceptance_checks),
    ...observeStructureProductStringList(execution.verifier),
    ...observeStructureProductStringList(slots.acceptance_checks),
  ]);
  const evidence = observeStructureProductRecordList(execution.evidence, 32);
  const artifacts = observeStructureProductRecordList(execution.artifacts, 32);
  const signatureBase = [
    observeStructureProductFirstString(execution.client_id),
    observeStructureProductFirstString(execution.raw_ref),
    observeStructureProductFirstString(execution.run_id),
    observeStructureProductFirstString(slots.raw_ref),
    observeStructureProductFirstString(slots.run_id),
    observeStructureProductFirstString(execution.task_signature),
    observeStructureProductFirstString(execution.workflow_signature),
    title,
    summary,
    targetFiles.join(","),
    workflowSteps.join("|"),
  ].filter(Boolean).join("\n");
  const taskSignature = observeStructureProductFirstString(
    execution.task_signature,
    slots.task_signature,
    `observed_task:${observeStructureProductSlug(signatureBase)}`,
  );
  const workflowSignature = observeStructureProductFirstString(
    execution.workflow_signature,
    slots.workflow_signature,
    `observed_workflow:${observeStructureProductSlug(signatureBase)}`,
  );
  const continuationHint = observeStructureProductFirstString(
    execution.continuation_hint,
    execution.resume_hint,
    execution.reuse_hint,
    slots.continuation_hint,
    summary,
  );
  const executionOutcomeRole = normalizeExecutionOutcomeRoleFromValue(execution.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(slots.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(execution.outcome)
    ?? normalizeExecutionOutcomeRoleFromValue(slots.outcome);

  slots.memory_kind = "execution_workflow";
  slots.product_observe_v1 = {
    ...(observeStructureProductRecord(slots.product_observe_v1) ?? {}),
    schema_version: "product_observe_v1",
    input_surface: "execution",
    memory_kind: "execution_workflow",
    auto_structured: true,
  };
  slots.execution_observation_v1 = observeStructureStripUndefined({
    ...(observeStructureProductRecord(slots.execution_observation_v1) ?? {}),
    schema_version: "execution_observation_v1",
    run_id: observeStructureProductFirstString(execution.run_id, slots.run_id),
    task_id: observeStructureProductFirstString(execution.task_id, slots.task_id),
    outcome: observeStructureProductFirstString(execution.outcome, slots.outcome),
    execution_outcome_role: executionOutcomeRole ?? undefined,
    evidence,
    artifacts,
    acceptance_checks: acceptanceChecks,
    verification: observeStructureProductRecord(execution.verification) ?? observeStructureProductRecord(slots.verification),
  });

  return observeStructureStripUndefined({
    client_id: observeStructureProductFirstString(execution.client_id, `execution:${observeStructureProductSlug(signatureBase)}`),
    type: "procedure",
    memory_kind: "execution_workflow",
    title,
    text_summary: summary,
    task_family: observeStructureProductFirstString(execution.task_family, slots.task_family),
    task_signature: taskSignature,
    workflow_signature: workflowSignature,
    target_files: targetFiles,
    tool_set: toolSet,
    workflow_steps: workflowSteps,
    next_action: continuationHint,
    confidence: typeof execution.confidence === "number" ? execution.confidence : 0.7,
    slots,
    evidence_ref: observeStructureProductFirstString(execution.evidence_ref) ?? undefined,
    raw_ref: observeStructureProductFirstString(execution.raw_ref) ?? undefined,
  });
}

function observeStructureShouldStructureExecutionWorkflow(node: Record<string, unknown>, slots: Record<string, unknown> | null): boolean {
  const kind = observeStructureProductMemoryKind(node, slots);
  if (kind === "execution_workflow" || kind === "workflow") return true;
  return observeStructureProductFirstString(node.type) === "procedure" && observeStructureHasWorkflowInputSignal(node, slots);
}

function observeStructureStructureExecutionWorkflowNode(node: Record<string, unknown>): Record<string, unknown> {
  const slots = { ...(observeStructureProductRecord(node.slots) ?? {}) };
  const title = observeStructureProductFirstString(node.title, slots.title, "Observed execution workflow") ?? "Observed execution workflow";
  const summary = observeStructureProductFirstString(node.text_summary, node.summary, slots.summary, title) ?? title;
  const filePath = observeStructureProductFirstString(node.file_path, slots.file_path);
  const targetFiles = observeStructureProductStringList([
    ...observeStructureProductStringList(node.target_files),
    ...observeStructureProductStringList(slots.target_files),
    ...(filePath ? [filePath] : []),
  ]);
  const toolSet = observeStructureProductStringList([
    ...observeStructureProductStringList(node.tool_set),
    ...observeStructureProductStringList(node.tools),
    ...observeStructureProductStringList(slots.tool_set),
  ]);
  const workflowSteps = observeStructureProductStringList([
    ...observeStructureProductStringList(node.workflow_steps),
    ...observeStructureProductStringList(slots.workflow_steps),
  ]);
  const patternHints = observeStructureProductStringList([
    ...observeStructureProductStringList(node.pattern_hints),
    ...observeStructureProductStringList(slots.pattern_hints),
  ]);
  const signatureBase = [title, summary, targetFiles.join(","), workflowSteps.join("|")].join("\n");
  const taskSignature = observeStructureProductFirstString(
    node.task_signature,
    slots.task_signature,
    `observed_task:${observeStructureProductSlug(signatureBase)}`,
  );
  const workflowSignature = observeStructureProductFirstString(
    node.workflow_signature,
    slots.workflow_signature,
    `observed_workflow:${observeStructureProductSlug(signatureBase)}`,
  );
  const nextAction = observeStructureProductFirstString(node.next_action, slots.next_action, summary);
  const executionObservation = observeStructureProductRecord(slots.execution_observation_v1);
  const executionOutcomeRole = normalizeExecutionOutcomeRoleFromValue(node.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(slots.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(executionObservation?.execution_outcome_role)
    ?? normalizeExecutionOutcomeRoleFromValue(node.outcome)
    ?? normalizeExecutionOutcomeRoleFromValue(slots.outcome)
    ?? normalizeExecutionOutcomeRoleFromValue(executionObservation?.outcome);
  const contractTrust = observeStructureProductContractTrust(slots.contract_trust)
    ?? observeStructureProductContractTrust(node.contract_trust)
    ?? "advisory";

  slots.summary_kind = observeStructureProductFirstString(slots.summary_kind, "workflow_anchor");
  slots.compression_layer = observeStructureProductFirstString(slots.compression_layer, "L2");
  slots.contract_trust = contractTrust;
  slots.product_observe_v1 = {
    ...(observeStructureProductRecord(slots.product_observe_v1) ?? {}),
    schema_version: "product_observe_v1",
    memory_kind: observeStructureProductMemoryKind(node, slots) ?? "execution_workflow",
    auto_structured: true,
    original_type: observeStructureProductFirstString(node.type),
  };
  slots.execution_native_v1 = {
    ...(observeStructureProductRecord(slots.execution_native_v1) ?? {}),
    schema_version: "execution_native_v1",
    execution_kind: "workflow_anchor",
    ...(executionOutcomeRole ? { execution_outcome_role: executionOutcomeRole } : {}),
    summary_kind: "workflow_anchor",
    compression_layer: "L2",
    contract_trust: contractTrust,
    task_signature: taskSignature,
    ...(observeStructureProductFirstString(node.task_family, slots.task_family) ? {
      task_family: observeStructureProductFirstString(node.task_family, slots.task_family),
    } : {}),
    workflow_signature: workflowSignature,
    anchor_kind: "workflow",
    anchor_level: "L2",
    ...(toolSet.length > 0 ? { tool_set: toolSet } : {}),
    file_path: filePath ?? targetFiles[0] ?? null,
    ...(targetFiles.length > 0 ? { target_files: targetFiles } : {}),
    next_action: nextAction ?? null,
    ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
    ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
  };

  return observeStructureStripUndefined({
    id: node.id,
    client_id: node.client_id,
    scope: node.scope,
    type: observeStructureProductFirstString(node.type, "procedure"),
    tier: node.tier,
    memory_lane: node.memory_lane,
    producer_agent_id: node.producer_agent_id,
    owner_agent_id: node.owner_agent_id,
    owner_team_id: node.owner_team_id,
    title,
    text_summary: summary,
    slots,
    raw_ref: node.raw_ref,
    evidence_ref: node.evidence_ref,
    embedding: node.embedding,
    embedding_model: node.embedding_model,
    salience: node.salience,
    importance: node.importance,
    confidence: node.confidence,
  });
}

function observeStructurePassthroughWriteNode(node: Record<string, unknown>): Record<string, unknown> {
  const sourceSlots = observeStructureProductRecord(node.slots);
  const slots = sourceSlots ? { ...sourceSlots } : {};
  const kind = observeStructureProductMemoryKind(node, sourceSlots);
  if (observeStructureIsGeneralMemoryKind(kind)) {
    slots.memory_kind = kind;
    slots.product_observe_v1 = {
      ...(observeStructureProductRecord(slots.product_observe_v1) ?? {}),
      schema_version: "product_observe_v1",
      memory_kind: kind,
      auto_structured: observeStructureProductRecord(slots.product_observe_v1)?.auto_structured === true,
      original_type: observeStructureProductFirstString(node.type),
    };
  }
  return observeStructureStripUndefined({
    id: node.id,
    client_id: node.client_id,
    scope: node.scope,
    type: node.type,
    tier: node.tier,
    memory_lane: node.memory_lane,
    producer_agent_id: node.producer_agent_id,
    owner_agent_id: node.owner_agent_id,
    owner_team_id: node.owner_team_id,
    title: node.title,
    text_summary: node.text_summary,
    slots: Object.keys(slots).length > 0 ? slots : node.slots,
    raw_ref: node.raw_ref,
    evidence_ref: node.evidence_ref,
    embedding: node.embedding,
    embedding_model: node.embedding_model,
    salience: node.salience,
    importance: node.importance,
    confidence: node.confidence,
  });
}

function observeStructureObserveNodeInputs(parsed: ProductObserveMemoryInput): Array<{
  input: Record<string, unknown>;
  source: "node" | "memory" | "memory.nodes" | "input_text" | "execution";
}> {
  const out: Array<{
    input: Record<string, unknown>;
    source: "node" | "memory" | "memory.nodes" | "input_text" | "execution";
  }> = [];
  if (parsed.nodes) {
    for (const item of parsed.nodes) {
      const node = observeStructureProductRecord(item);
      if (node) out.push({ input: node, source: "node" });
    }
  }
  const memory = observeStructureProductRecord(parsed.memory);
  const memoryNodes = Array.isArray(memory?.nodes) ? memory.nodes : undefined;
  const memoryNode = memory && !memoryNodes && observeStructureHasMemoryObjectSignal(memory) ? observeStructureMemoryObjectAsNode(memory) : null;
  if (memoryNodes) {
    for (const item of memoryNodes) {
      const node = observeStructureProductRecord(item);
      if (node) out.push({ input: node, source: "memory.nodes" });
    }
  }
  if (memoryNode) out.push({ input: memoryNode, source: "memory" });
  const executionNode = observeStructureExecutionObservationAsNode(parsed);
  if (executionNode) out.push({ input: executionNode, source: "execution" });
  if (out.length === 0) {
    const inputTextNode = observeStructureInputTextAsNode(parsed);
    if (inputTextNode) out.push({ input: inputTextNode, source: "input_text" });
  }
  return out;
}

function observeStructureStructureObserveNodes(parsed: ProductObserveMemoryInput): {
  nodes: Record<string, unknown>[] | undefined;
  summary: ProductObserveStructuringSummary;
} {
  const inputs = observeStructureObserveNodeInputs(parsed);
  const summary: ProductObserveStructuringSummary = {
    schema_version: "aionis_observe_structuring_v1",
    mode: "auto",
    input_node_count: inputs.length,
    auto_text_node_count: 0,
    passthrough_node_count: 0,
    already_structured_node_count: 0,
    execution_workflow_count: 0,
    execution_observation_count: 0,
    general_memory_count: 0,
    structured_nodes: [],
  };
  if (inputs.length === 0) return { nodes: parsed.nodes, summary };

  const nodes: Record<string, unknown>[] = [];
  for (const item of inputs) {
    const node = item.input;
    const source = item.source;
    const slots = observeStructureProductRecord(node.slots);
    const clientId = observeStructureProductString(node.client_id);
    const type = observeStructureProductFirstString(node.type, "unknown") ?? "unknown";
    if (source === "input_text") summary.auto_text_node_count += 1;
    if (source === "execution") summary.execution_observation_count += 1;
    if (observeStructureHasProductExecutionSurface(slots)) {
      nodes.push(observeStructurePassthroughWriteNode(node));
      summary.already_structured_node_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type,
        classification: "already_structured",
        execution_kind: observeStructureProductFirstString(observeStructureProductRecord(slots?.execution_native_v1)?.execution_kind),
        source,
      });
      continue;
    }
    if (observeStructureShouldStructureExecutionWorkflow(node, slots)) {
      const structured = observeStructureStructureExecutionWorkflowNode(node);
      nodes.push(structured);
      summary.execution_workflow_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type: observeStructureProductFirstString(structured.type, type) ?? type,
        classification: "execution_workflow",
        execution_kind: "workflow_anchor",
        source,
      });
      continue;
    }
    nodes.push(observeStructurePassthroughWriteNode(node));
    if (observeStructureIsGeneralMemoryKind(observeStructureProductMemoryKind(node, slots))) {
      summary.general_memory_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type,
        classification: "general_memory",
        execution_kind: null,
        source,
      });
    } else {
      summary.passthrough_node_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type,
        classification: "passthrough",
        execution_kind: null,
        source,
      });
    }
  }

  return { nodes, summary };
}

function observeStructureObserveInputText(parsed: ProductObserveMemoryInput, nodes: Record<string, unknown>[] | undefined): string | undefined {
  const memory = observeStructureProductRecord(parsed.memory);
  const nodeText = nodes
    ?.map((node) => observeStructureProductFirstString(node.text_summary, node.title))
    .filter((value): value is string => !!value)
    .slice(0, 8)
    .join("\n");
  return parsed.input_text
    ?? observeStructureProductString(memory?.input_text)
    ?? observeStructureProductFirstString(memory?.text_summary, memory?.summary, memory?.content, memory?.title)
    ?? observeStructureProductString(nodeText)
    ?? undefined;
}

export function structureProductObserveMemoryInput(
  parsed: ProductObserveMemoryInput,
): StructuredProductObserveMemoryInput {
  const structured = observeStructureStructureObserveNodes(parsed);
  return {
    input_text: observeStructureObserveInputText(parsed, structured.nodes),
    nodes: structured.nodes,
    summary: structured.summary,
  };
}

type ProductMemoryWritePort = Pick<MemoryWriteRouteService, "transactionRunner" | "prepare" | "persist" | "receipt" | "finalize" | "commit">;
type ProductHandoffStorePort = Pick<HandoffRouteService, "transactionRunner" | "prepareStore" | "persistStore" | "receiptStore" | "finalizeStore" | "store">;
type ProductObserveAtomicWrite = Pick<
  LiteWriteStore,
  "withTx" | "getWriteOperation" | "insertWriteOperation" | "transactionRunner" | "annSyncEnabled"
>;

export type ProductObserveServiceDependencies = {
  defaultTenantId: string;
  defaultScope: string;
  memoryWrite: ProductMemoryWritePort | null;
  handoffStore: ProductHandoffStorePort | null;
  atomicWrite: ProductObserveAtomicWrite | null;
  claimLedgerAccess?: ClaimLedgerAccess | null;
};

const PRODUCT_OBSERVE_OPERATION_KIND = "product_observe_v1";

function productObserveOperationIdentity(parsed: ProductObserveInput): {
  operationId: string;
  requestSha256: string;
} {
  const request = { ...parsed } as Record<string, unknown>;
  const suppliedOperationId = typeof request.operation_id === "string" && request.operation_id.trim().length > 0
    ? request.operation_id.trim()
    : null;
  delete request.operation_id;
  const requestSha256 = createHash("sha256").update(stableStringify(request)).digest("hex");
  return {
    operationId: suppliedOperationId ?? `observe_${randomUUID()}`,
    requestSha256,
  };
}

function parseStoredObserveReceipt(raw: string): ProductServiceResult {
  const parsed = JSON.parse(raw) as ProductServiceResult;
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" || typeof parsed.statusCode !== "number") {
    throw new Error("stored observe operation receipt is invalid");
  }
  return parsed;
}

function assertObserveOperationMatches(args: {
  operationId: string;
  requestSha256: string;
  storedRequestSha256: string;
}): void {
  if (args.requestSha256 === args.storedRequestSha256) return;
  throw new HttpError(
    409,
    "observe_operation_id_conflict",
    "operation_id was already used for a different observe request",
    { operation_id: args.operationId },
  );
}

async function callObserveDependency<T>(
  surface: "memory_write_service" | "handoff_store_service",
  call: () => T | Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpError || error instanceof z.ZodError) throw error;
    throw new HttpError(
      502,
      "product_dependency_failed",
      "A product facade dependency failed.",
      {
        surface,
        upstream_status: 502,
        retryable: true,
      },
    );
  }
}

export function createProductObserveService(
  dependencies: ProductObserveServiceDependencies,
): ProductServices["observe"] {
  const atomicRunner = dependencies.atomicWrite?.transactionRunner() ?? null;
  if (dependencies.memoryWrite && (!atomicRunner || dependencies.memoryWrite.transactionRunner() !== atomicRunner)) {
    throw new Error("product observe memory write service must share the atomic write transaction runner");
  }
  if (dependencies.handoffStore && (!atomicRunner || dependencies.handoffStore.transactionRunner() !== atomicRunner)) {
    throw new Error("product observe handoff service must share the atomic write transaction runner");
  }
  if (
    dependencies.claimLedgerAccess
    && (!atomicRunner || dependencies.claimLedgerAccess.transactionRunner() !== atomicRunner)
  ) {
    throw new Error("product observe claim ledger must share the atomic write transaction runner");
  }
  return {
    guardOrder(parsed) {
      const hasInlineWrite =
        !!parsed.input_text
        || !!parsed.input_sha256
        || !!parsed.execution
        || (parsed.nodes?.length ?? 0) > 0
        || (parsed.edges?.length ?? 0) > 0;
      const claimOnly =
        (parsed.claims?.length ?? 0) > 0
        && !parsed.memory
        && !hasInlineWrite
        && !parsed.handoff;
      return claimOnly ? "inflight_first" : "guards_first";
    },
    async execute(
      parsed: ProductObserveInput,
      context: ProductObserveExecutionContext,
    ): Promise<ProductServiceResult> {
      try {
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
        const identity: ProductObserveWriteIdentity = {
          tenantId,
          scope,
          actor: parsed.actor,
        };
        const preserveNestedActor = context.principal === null;
        assertObserveNestedIdentity({ parsed, identity, enforceActor: !preserveNestedActor });
        const writeBundle = observeWritePayload(parsed, identity, { preserveNestedActor });
        const writePayload = writeBundle?.payload ?? null;
        const handoffPayload = parsed.handoff
          ? mergeProductScope(identity, parsed.handoff, { preserveNestedActor })
          : null;
        const hasClaims = (parsed.claims?.length ?? 0) > 0;
        if (!writePayload && !handoffPayload && !hasClaims) {
          return productServiceFailure({
            statusCode: 400,
            error: "observe_requires_memory_or_handoff",
            message: "observe requires memory input, handoff payload, or explicit claims",
          });
        }

        if (!dependencies.atomicWrite) return productServiceDependencyFailure("atomic_write_service", 503);
        if (writePayload && !dependencies.memoryWrite) return productServiceDependencyFailure("memory_write_service", 503);
        if (handoffPayload && !dependencies.handoffStore) return productServiceDependencyFailure("handoff_store_service", 503);
        if (hasClaims && !dependencies.claimLedgerAccess) return productServiceDependencyFailure("claim_ledger_service", 503);

        const { operationId, requestSha256 } = productObserveOperationIdentity(parsed);
        const stored = await dependencies.atomicWrite.getWriteOperation({
          tenantId,
          scope,
          operationKind: PRODUCT_OBSERVE_OPERATION_KIND,
          operationId,
        });
        if (stored) {
          assertObserveOperationMatches({
            operationId,
            requestSha256,
            storedRequestSha256: stored.request_sha256,
          });
          return parseStoredObserveReceipt(stored.receipt_json);
        }
        const memoryPlan = writePayload
          ? await callObserveDependency("memory_write_service", () => dependencies.memoryWrite!.prepare(writePayload, {
              executionTreeDefaultDisabled: false,
              startedAt: performance.now(),
            }))
          : null;
        const handoffRequest = handoffPayload ? HandoffStoreRequest.parse(handoffPayload) : null;
        const handoffPlan = handoffRequest
          ? await callObserveDependency("handoff_store_service", () => dependencies.handoffStore!.prepareStore(handoffRequest, {
              principal: context.principal,
              deferProjection: !!memoryPlan,
            }))
          : null;
        const claims = (parsed.claims ?? []).map((claim, index) => ({
          ...claim,
          client_id: claim.client_id ?? `${operationId}:claim:${index + 1}`,
        }));
        const embeddingScheduled = [memoryPlan?.prepared, handoffPlan?.prepared]
          .filter((value): value is NonNullable<typeof value> => !!value)
          .some((prepared) => prepared.auto_embed_effective && prepared.nodes.some((node) => !!node.embed_text));
        const annSyncScheduled = dependencies.atomicWrite.annSyncEnabled() && (!!memoryPlan || !!handoffPlan);

        const committed = await dependencies.atomicWrite.withTx(async () => {
          const raced = await dependencies.atomicWrite!.getWriteOperation({
            tenantId,
            scope,
            operationKind: PRODUCT_OBSERVE_OPERATION_KIND,
            operationId,
          });
          if (raced) {
            assertObserveOperationMatches({
              operationId,
              requestSha256,
              storedRequestSha256: raced.request_sha256,
            });
            return { result: parseStoredObserveReceipt(raced.receipt_json), committedNew: false } as const;
          }

          const memoryOut = memoryPlan
            ? await callObserveDependency("memory_write_service", () => dependencies.memoryWrite!.persist(memoryPlan))
            : null;
          const memoryResponse = memoryPlan && memoryOut
            ? await callObserveDependency("memory_write_service", () => dependencies.memoryWrite!.receipt(memoryPlan, memoryOut))
            : null;
          const write: InternalDispatchResult | null = memoryResponse
            ? { ok: true, statusCode: 200, path: "memory_write_service", body: memoryResponse }
            : null;

          const handoffPersisted = handoffPlan
            ? await callObserveDependency("handoff_store_service", () => dependencies.handoffStore!.persistStore(handoffPlan))
            : null;
          const handoffResponse = handoffPlan && handoffPersisted
            ? await callObserveDependency(
                "handoff_store_service",
                () => dependencies.handoffStore!.receiptStore(handoffPlan, handoffPersisted),
              )
            : null;
          const handoff: InternalDispatchResult | null = handoffResponse
            ? { ok: true, statusCode: 200, path: "handoff_store_service", body: handoffResponse }
            : null;

          const claimLedger = await writeProductObserveClaims({
            claimLedgerAccess: dependencies.claimLedgerAccess,
            claims,
            write,
            tenantId,
            scope,
          });
          if (claimLedger && !claimLedger.ok) {
            throw new HttpError(claimLedger.statusCode, "claim_ledger_unavailable", "claim ledger is not available");
          }

          const result = productServiceSuccess({
            contract_version: "aionis_observe_result_v1",
            operation_id: operationId,
            tenant_id: tenantId,
            scope,
            observed: {
              memory_written: !!write,
              handoff_stored: !!handoff,
              ...(claimLedger ? { claim_count: claimLedger.receipt.written_count } : {}),
              general_memory_count: writeBundle?.structuring.general_memory_count ?? 0,
              execution_memory_count: productObservedExecutionMemoryCount(writeBundle?.structuring),
              auto_text_memory_count: writeBundle?.structuring.auto_text_node_count ?? 0,
              execution_observation_count: writeBundle?.structuring.execution_observation_count ?? 0,
            },
            structured_memory: writeBundle?.structuring ?? null,
            ...(claimLedger ? { claim_ledger: claimLedger.receipt } : {}),
            memory_write: write?.body ?? null,
            handoff: handoff?.body ?? null,
            source_map: {
              routes_used: ["/v1/observe"],
              internal_surfaces_used: [
                ...(write ? ["memory_write"] : []),
                ...(handoff ? ["handoff_store"] : []),
                ...(claimLedger ? ["claim_ledger_write"] : []),
              ],
            },
            post_commit_projections: {
              semantic_commit: "committed",
              embedding: embeddingScheduled ? "scheduled" : "not_requested",
              ann_sync: annSyncScheduled ? "scheduled" : "not_requested",
            },
          });
          await dependencies.atomicWrite!.insertWriteOperation({
            tenantId,
            scope,
            operationKind: PRODUCT_OBSERVE_OPERATION_KIND,
            operationId,
            requestSha256,
            receiptJson: JSON.stringify(result),
            commitId: memoryOut?.commit_id ?? handoffPersisted?.out.commit_id ?? null,
          });
          return {
            result,
            committedNew: true,
            memoryOut,
            handoffPersisted,
          } as const;
        });

        if (committed.committedNew) {
          if (memoryPlan && committed.memoryOut) {
            await dependencies.memoryWrite!.finalize(memoryPlan, committed.memoryOut).catch((error) => {
              process.emitWarning(
                `Observe memory post-commit finalization failed: ${error instanceof Error ? error.message : String(error)}`,
                { code: "AIONIS_OBSERVE_POST_COMMIT_FAILED" },
              );
            });
          }
          if (handoffPlan && committed.handoffPersisted) {
            await dependencies.handoffStore!.finalizeStore(handoffPlan, committed.handoffPersisted).catch((error) => {
              process.emitWarning(
                `Observe handoff post-commit finalization failed: ${error instanceof Error ? error.message : String(error)}`,
                { code: "AIONIS_OBSERVE_POST_COMMIT_FAILED" },
              );
            });
          }
        }
        return committed.result;
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
