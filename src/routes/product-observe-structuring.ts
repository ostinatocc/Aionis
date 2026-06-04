import { createHash } from "node:crypto";

export type ProductObserveStructuringSummary = {
  schema_version: "aionis_observe_structuring_v1";
  mode: "auto";
  input_node_count: number;
  passthrough_node_count: number;
  already_structured_node_count: number;
  execution_workflow_count: number;
  general_memory_count: number;
  structured_nodes: Array<{
    client_id: string | null;
    type: string;
    classification: "already_structured" | "execution_workflow" | "general_memory" | "passthrough";
    execution_kind: string | null;
    source: "node" | "memory" | "memory.nodes";
  }>;
};

export type ProductObserveMemoryInput = {
  input_text?: string;
  nodes?: Record<string, unknown>[];
  memory?: Record<string, unknown>;
};

export type StructuredProductObserveMemoryInput = {
  input_text: string | undefined;
  nodes: Record<string, unknown>[] | undefined;
  summary: ProductObserveStructuringSummary;
};

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function productRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function productString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function productFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = productString(value);
    if (text) return text;
  }
  return null;
}

function productStringList(value: unknown, limit = 64): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const text = productString(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function productSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  if (slug) return slug;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function hasProductExecutionSurface(slots: Record<string, unknown> | null): boolean {
  return !!productRecord(slots?.execution_native_v1) || !!productRecord(slots?.anchor_v1);
}

function productMemoryKind(node: Record<string, unknown>, slots: Record<string, unknown> | null): string | null {
  return productFirstString(node.memory_kind, node.kind, slots?.memory_kind)?.toLowerCase() ?? null;
}

function productContractTrust(value: unknown): "authoritative" | "advisory" | "observational" | null {
  const text = productString(value);
  if (text === "authoritative" || text === "advisory" || text === "observational") return text;
  return null;
}

function isGeneralMemoryKind(kind: string | null): boolean {
  return kind === "general_memory" || kind === "general" || kind === "knowledge" || kind === "note";
}

function hasWorkflowInputSignal(node: Record<string, unknown>, slots: Record<string, unknown> | null): boolean {
  const targetFiles = [
    ...productStringList(node.target_files),
    ...productStringList(slots?.target_files),
  ];
  return !!productFirstString(
    node.workflow_signature,
    slots?.workflow_signature,
    node.task_signature,
    slots?.task_signature,
    node.next_action,
    slots?.next_action,
    node.file_path,
    slots?.file_path,
    targetFiles[0],
  ) || productStringList(node.tool_set).length > 0
    || productStringList(slots?.tool_set).length > 0
    || productStringList(node.workflow_steps).length > 0
    || productStringList(slots?.workflow_steps).length > 0;
}

function hasMemoryObjectSignal(memory: Record<string, unknown>): boolean {
  const slots = productRecord(memory.slots);
  return !!productMemoryKind(memory, slots)
    || !!productFirstString(
      memory.type,
      memory.title,
      memory.text_summary,
      memory.summary,
      memory.content,
      memory.workflow_signature,
      memory.task_signature,
      memory.next_action,
    )
    || productStringList(memory.target_files).length > 0
    || productStringList(memory.workflow_steps).length > 0
    || productStringList(memory.tool_set).length > 0;
}

function memoryObjectAsNode(memory: Record<string, unknown>): Record<string, unknown> {
  const slots = productRecord(memory.slots);
  const kind = productMemoryKind(memory, slots);
  const executionLike = kind === "execution_workflow" || kind === "workflow" || hasWorkflowInputSignal(memory, slots);
  return {
    ...memory,
    type: productFirstString(memory.type, executionLike ? "procedure" : "concept"),
    title: productFirstString(memory.title, memory.name, memory.summary, memory.text_summary, "Observed memory"),
    text_summary: productFirstString(memory.text_summary, memory.summary, memory.content, memory.title, "Observed memory"),
  };
}

function shouldStructureExecutionWorkflow(node: Record<string, unknown>, slots: Record<string, unknown> | null): boolean {
  const kind = productMemoryKind(node, slots);
  if (kind === "execution_workflow" || kind === "workflow") return true;
  return productFirstString(node.type) === "procedure" && hasWorkflowInputSignal(node, slots);
}

function structureExecutionWorkflowNode(node: Record<string, unknown>): Record<string, unknown> {
  const slots = { ...(productRecord(node.slots) ?? {}) };
  const title = productFirstString(node.title, slots.title, "Observed execution workflow") ?? "Observed execution workflow";
  const summary = productFirstString(node.text_summary, node.summary, slots.summary, title) ?? title;
  const filePath = productFirstString(node.file_path, slots.file_path);
  const targetFiles = productStringList([
    ...productStringList(node.target_files),
    ...productStringList(slots.target_files),
    ...(filePath ? [filePath] : []),
  ]);
  const toolSet = productStringList([
    ...productStringList(node.tool_set),
    ...productStringList(node.tools),
    ...productStringList(slots.tool_set),
  ]);
  const workflowSteps = productStringList([
    ...productStringList(node.workflow_steps),
    ...productStringList(slots.workflow_steps),
  ]);
  const patternHints = productStringList([
    ...productStringList(node.pattern_hints),
    ...productStringList(slots.pattern_hints),
  ]);
  const signatureBase = [title, summary, targetFiles.join(","), workflowSteps.join("|")].join("\n");
  const taskSignature = productFirstString(
    node.task_signature,
    slots.task_signature,
    `observed_task:${productSlug(signatureBase)}`,
  );
  const workflowSignature = productFirstString(
    node.workflow_signature,
    slots.workflow_signature,
    `observed_workflow:${productSlug(signatureBase)}`,
  );
  const nextAction = productFirstString(node.next_action, slots.next_action, summary);

  slots.summary_kind = productFirstString(slots.summary_kind, "workflow_anchor");
  slots.compression_layer = productFirstString(slots.compression_layer, "L2");
  slots.product_observe_v1 = {
    schema_version: "product_observe_v1",
    memory_kind: productMemoryKind(node, slots) ?? "execution_workflow",
    auto_structured: true,
    original_type: productFirstString(node.type),
  };
  slots.execution_native_v1 = {
    ...(productRecord(slots.execution_native_v1) ?? {}),
    schema_version: "execution_native_v1",
    execution_kind: "workflow_anchor",
    summary_kind: "workflow_anchor",
    compression_layer: "L2",
    contract_trust: productContractTrust(slots.contract_trust) ?? productContractTrust(node.contract_trust) ?? "advisory",
    task_signature: taskSignature,
    ...(productFirstString(node.task_family, slots.task_family) ? {
      task_family: productFirstString(node.task_family, slots.task_family),
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

  return stripUndefined({
    id: node.id,
    client_id: node.client_id,
    scope: node.scope,
    type: productFirstString(node.type, "procedure"),
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

function passthroughWriteNode(node: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined({
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
    slots: node.slots,
    raw_ref: node.raw_ref,
    evidence_ref: node.evidence_ref,
    embedding: node.embedding,
    embedding_model: node.embedding_model,
    salience: node.salience,
    importance: node.importance,
    confidence: node.confidence,
  });
}

function observeNodeInput(parsed: ProductObserveMemoryInput): {
  input: unknown[] | undefined;
  source: "node" | "memory" | "memory.nodes";
} {
  const memory = productRecord(parsed.memory);
  const memoryNodes = Array.isArray(memory?.nodes) ? memory.nodes : undefined;
  const memoryNode = memory && !memoryNodes && hasMemoryObjectSignal(memory) ? memoryObjectAsNode(memory) : null;
  if (parsed.nodes) return { input: parsed.nodes, source: "node" };
  if (memoryNodes) return { input: memoryNodes, source: "memory.nodes" };
  if (memoryNode) return { input: [memoryNode], source: "memory" };
  return { input: undefined, source: "node" };
}

function structureObserveNodes(parsed: ProductObserveMemoryInput): {
  nodes: Record<string, unknown>[] | undefined;
  summary: ProductObserveStructuringSummary;
} {
  const { input, source } = observeNodeInput(parsed);
  const summary: ProductObserveStructuringSummary = {
    schema_version: "aionis_observe_structuring_v1",
    mode: "auto",
    input_node_count: Array.isArray(input) ? input.length : 0,
    passthrough_node_count: 0,
    already_structured_node_count: 0,
    execution_workflow_count: 0,
    general_memory_count: 0,
    structured_nodes: [],
  };
  if (!Array.isArray(input)) return { nodes: parsed.nodes, summary };

  const nodes: Record<string, unknown>[] = [];
  for (const item of input) {
    const node = productRecord(item);
    if (!node) continue;
    const slots = productRecord(node.slots);
    const clientId = productString(node.client_id);
    const type = productFirstString(node.type, "unknown") ?? "unknown";
    if (hasProductExecutionSurface(slots)) {
      nodes.push(passthroughWriteNode(node));
      summary.already_structured_node_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type,
        classification: "already_structured",
        execution_kind: productFirstString(productRecord(slots?.execution_native_v1)?.execution_kind),
        source,
      });
      continue;
    }
    if (shouldStructureExecutionWorkflow(node, slots)) {
      const structured = structureExecutionWorkflowNode(node);
      nodes.push(structured);
      summary.execution_workflow_count += 1;
      summary.structured_nodes.push({
        client_id: clientId,
        type: productFirstString(structured.type, type) ?? type,
        classification: "execution_workflow",
        execution_kind: "workflow_anchor",
        source,
      });
      continue;
    }
    nodes.push(passthroughWriteNode(node));
    if (isGeneralMemoryKind(productMemoryKind(node, slots))) {
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

function observeInputText(parsed: ProductObserveMemoryInput, nodes: Record<string, unknown>[] | undefined): string | undefined {
  const memory = productRecord(parsed.memory);
  const nodeText = nodes
    ?.map((node) => productFirstString(node.text_summary, node.title))
    .filter((value): value is string => !!value)
    .slice(0, 8)
    .join("\n");
  return parsed.input_text
    ?? productString(memory?.input_text)
    ?? productFirstString(memory?.text_summary, memory?.summary, memory?.content, memory?.title)
    ?? productString(nodeText)
    ?? undefined;
}

export function structureProductObserveMemoryInput(
  parsed: ProductObserveMemoryInput,
): StructuredProductObserveMemoryInput {
  const structured = structureObserveNodes(parsed);
  return {
    input_text: observeInputText(parsed, structured.nodes),
    nodes: structured.nodes,
    summary: structured.summary,
  };
}
