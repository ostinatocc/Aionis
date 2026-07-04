import { z } from "zod";
import { ExecutionStringListSchema } from "./schema-limits.js";

const StringList = ExecutionStringListSchema;

export const ExecutionTreeLayer = z.enum(["raw", "summary"]);
export type ExecutionTreeLayer = z.infer<typeof ExecutionTreeLayer>;

export const ExecutionTreeNodeStatus = z.enum(["active", "failed", "inactive"]);
export type ExecutionTreeNodeStatus = z.infer<typeof ExecutionTreeNodeStatus>;

export const ExecutionTreeNodeContentV1Schema = z.object({
  kind: z.enum(["root", "action_observation", "summary"]),
  title: z.string().trim().min(1).nullable().default(null),
  action: z.string().trim().min(1).nullable().default(null),
  observation: z.string().trim().min(1).nullable().default(null),
  summary: z.string().trim().min(1).nullable().default(null),
  tool_name: z.string().trim().min(1).nullable().default(null),
  at: z.string().datetime().nullable().default(null),
  refs: StringList,
}).strict();
export type ExecutionTreeNodeContentV1 = z.infer<typeof ExecutionTreeNodeContentV1Schema>;

export const ExecutionTreeNodeV1Schema = z.object({
  version: z.literal(1),
  node_id: z.string().trim().min(1),
  layer: ExecutionTreeLayer,
  step_id: z.number().int().min(0),
  parent_id: z.string().trim().min(1).nullable().default(null),
  child_ids: StringList,
  content: ExecutionTreeNodeContentV1Schema,
  cover_node_ids: StringList,
  diagnostic_note: z.string().trim().min(1).nullable().default(null),
  status: ExecutionTreeNodeStatus.default("active"),
  validated: z.boolean().default(false),
}).strict();
export type ExecutionTreeNodeV1 = z.infer<typeof ExecutionTreeNodeV1Schema>;

export const ExecutionTreeV1Schema = z.object({
  version: z.literal(1),
  tree_id: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  task_brief: z.string().trim().min(1),
  root_raw_node_id: z.string().trim().min(1),
  root_summary_node_id: z.string().trim().min(1),
  current_raw_node_id: z.string().trim().min(1),
  current_summary_node_id: z.string().trim().min(1),
  next_step_id: z.number().int().positive(),
  nodes: z.record(ExecutionTreeNodeV1Schema),
  updated_at: z.string().datetime(),
}).strict();
export type ExecutionTreeV1 = z.infer<typeof ExecutionTreeV1Schema>;

const BaseExecutionTreeOperationSchema = z.object({
  operation_id: z.string().trim().min(1),
  tree_id: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  actor_role: z.string().trim().min(1).nullable().default(null),
  at: z.string().datetime(),
});

export const ExecutionTreeGrowOperationV1Schema = BaseExecutionTreeOperationSchema.extend({
  type: z.literal("grow"),
  action: z.string().trim().min(1),
  observation: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable().default(null),
  tool_name: z.string().trim().min(1).nullable().default(null),
  refs: StringList,
});

export const ExecutionTreeCompressOperationV1Schema = BaseExecutionTreeOperationSchema.extend({
  type: z.literal("compress"),
  summary: z.string().trim().min(1),
  title: z.string().trim().min(1).nullable().default(null),
});

export const ExecutionTreeMaintainOperationV1Schema = BaseExecutionTreeOperationSchema.extend({
  type: z.literal("maintain"),
  passed: z.boolean(),
  target_summary_node_id: z.string().trim().min(1).optional(),
  diagnostic_note: z.string().trim().min(1).nullable().default(null),
});

export const ExecutionTreeReviseOperationV1Schema = BaseExecutionTreeOperationSchema.extend({
  type: z.literal("revise"),
  target_summary_node_id: z.string().trim().min(1),
  diagnostic_note: z.string().trim().min(1).nullable().default(null),
});

export const ExecutionTreeOperationV1Schema = z.discriminatedUnion("type", [
  ExecutionTreeGrowOperationV1Schema,
  ExecutionTreeCompressOperationV1Schema,
  ExecutionTreeMaintainOperationV1Schema,
  ExecutionTreeReviseOperationV1Schema,
]);
export type ExecutionTreeOperationV1 = z.infer<typeof ExecutionTreeOperationV1Schema>;

const ExecutionTreeStateEntryV1Schema = z.object({
  node_id: z.string().trim().min(1),
  step_id: z.number().int().min(0),
  title: z.string().trim().min(1).nullable(),
  summary: z.string().trim().min(1).nullable(),
  action: z.string().trim().min(1).nullable(),
  observation: z.string().trim().min(1).nullable(),
  status: ExecutionTreeNodeStatus,
  validated: z.boolean(),
  diagnostic_note: z.string().trim().min(1).nullable(),
}).strict();

export const ExecutionTreeStateV1Schema = z.object({
  state_version: z.literal("execution_tree_state_v1"),
  tree_id: z.string().trim().min(1),
  current_summary_node_id: z.string().trim().min(1),
  current_raw_node_id: z.string().trim().min(1),
  compressed_state: z.array(ExecutionTreeStateEntryV1Schema),
  raw_state: z.array(ExecutionTreeStateEntryV1Schema),
  execution_hints: z.array(ExecutionTreeStateEntryV1Schema),
}).strict();
export type ExecutionTreeStateV1 = z.infer<typeof ExecutionTreeStateV1Schema>;

function cloneTree(input: ExecutionTreeV1): ExecutionTreeV1 {
  return ExecutionTreeV1Schema.parse(JSON.parse(JSON.stringify(input)));
}

function requireNode(tree: ExecutionTreeV1, nodeId: string): ExecutionTreeNodeV1 {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`execution tree node not found: ${tree.scope}/${tree.tree_id}/${nodeId}`);
  return node;
}

function assertOperationTarget(tree: ExecutionTreeV1, operation: ExecutionTreeOperationV1): void {
  if (tree.tree_id !== operation.tree_id) {
    throw new Error(`execution tree operation tree_id mismatch: expected ${tree.tree_id}, got ${operation.tree_id}`);
  }
  if (tree.scope !== operation.scope) {
    throw new Error(`execution tree operation scope mismatch: expected ${tree.scope}, got ${operation.scope}`);
  }
}

function nodeId(prefix: string, stepId: number): string {
  return `${prefix}:${stepId}`;
}

function appendChild(tree: ExecutionTreeV1, parentId: string, childId: string): void {
  const parent = requireNode(tree, parentId);
  if (parent.child_ids.includes(childId)) return;
  tree.nodes[parentId] = {
    ...parent,
    child_ids: parent.child_ids.concat([childId]),
  };
}

function contentKey(content: ExecutionTreeNodeContentV1): string {
  return JSON.stringify({
    kind: content.kind,
    action: content.action,
    observation: content.observation,
    tool_name: content.tool_name,
    refs: content.refs,
  });
}

function pathToRoot(tree: ExecutionTreeV1, nodeId: string): ExecutionTreeNodeV1[] {
  const path: ExecutionTreeNodeV1[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new Error(`execution tree cycle detected at ${current}`);
    seen.add(current);
    const node = requireNode(tree, current);
    path.push(node);
    current = node.parent_id;
  }
  return path.reverse();
}

function summaryPath(tree: ExecutionTreeV1): ExecutionTreeNodeV1[] {
  return pathToRoot(tree, tree.current_summary_node_id).filter((node) => node.layer === "summary");
}

function rawPath(tree: ExecutionTreeV1): ExecutionTreeNodeV1[] {
  return pathToRoot(tree, tree.current_raw_node_id).filter((node) => node.layer === "raw");
}

function traceRawSegment(tree: ExecutionTreeV1, boundaryRawNodeId: string, currentRawNodeId: string): ExecutionTreeNodeV1[] {
  const path = pathToRoot(tree, currentRawNodeId).filter((node) => node.layer === "raw");
  const boundaryIndex = path.findIndex((node) => node.node_id === boundaryRawNodeId);
  if (boundaryIndex < 0) {
    throw new Error(`execution tree raw boundary is not on active path: ${boundaryRawNodeId}`);
  }
  return path.slice(boundaryIndex + 1);
}

function lastCoverNodeId(summaryNode: ExecutionTreeNodeV1): string {
  const id = summaryNode.cover_node_ids.at(-1);
  if (!id) throw new Error(`summary node has no raw boundary: ${summaryNode.node_id}`);
  return id;
}

function markNodesFailed(tree: ExecutionTreeV1, nodeIds: readonly string[], diagnosticNote: string | null): void {
  for (const nodeIdValue of nodeIds) {
    const node = requireNode(tree, nodeIdValue);
    tree.nodes[node.node_id] = {
      ...node,
      status: "failed",
      diagnostic_note: node.diagnostic_note ?? diagnosticNote,
    };
  }
}

function toStateEntry(node: ExecutionTreeNodeV1): z.infer<typeof ExecutionTreeStateEntryV1Schema> {
  return ExecutionTreeStateEntryV1Schema.parse({
    node_id: node.node_id,
    step_id: node.step_id,
    title: node.content.title,
    summary: node.content.summary,
    action: node.content.action,
    observation: node.content.observation,
    status: node.status,
    validated: node.validated,
    diagnostic_note: node.diagnostic_note,
  });
}

export function createExecutionTreeV1(input: {
  tree_id: string;
  scope: string;
  task_brief: string;
  at?: string | null;
}): ExecutionTreeV1 {
  const at = input.at ?? new Date().toISOString();
  const rawRootId = "raw:0";
  const summaryRootId = "summary:0";
  return ExecutionTreeV1Schema.parse({
    version: 1,
    tree_id: input.tree_id,
    scope: input.scope,
    task_brief: input.task_brief,
    root_raw_node_id: rawRootId,
    root_summary_node_id: summaryRootId,
    current_raw_node_id: rawRootId,
    current_summary_node_id: summaryRootId,
    next_step_id: 1,
    updated_at: at,
    nodes: {
      [rawRootId]: {
        version: 1,
        node_id: rawRootId,
        layer: "raw",
        step_id: 0,
        parent_id: null,
        child_ids: [],
        cover_node_ids: [],
        diagnostic_note: null,
        status: "active",
        validated: true,
        content: {
          kind: "root",
          title: "Execution Root",
          action: null,
          observation: null,
          summary: null,
          tool_name: null,
          at,
          refs: [],
        },
      },
      [summaryRootId]: {
        version: 1,
        node_id: summaryRootId,
        layer: "summary",
        step_id: 0,
        parent_id: null,
        child_ids: [],
        cover_node_ids: [rawRootId],
        diagnostic_note: null,
        status: "active",
        validated: true,
        content: {
          kind: "root",
          title: "Summary Root",
          action: null,
          observation: null,
          summary: null,
          tool_name: null,
          at,
          refs: [],
        },
      },
    },
  });
}

export function growExecutionTreeV1(treeInput: ExecutionTreeV1, operationInput: z.infer<typeof ExecutionTreeGrowOperationV1Schema>): ExecutionTreeV1 {
  const tree = cloneTree(treeInput);
  const operation = ExecutionTreeGrowOperationV1Schema.parse(operationInput);
  assertOperationTarget(tree, operation);
  const parent = requireNode(tree, tree.current_raw_node_id);
  const nextContent = ExecutionTreeNodeContentV1Schema.parse({
    kind: "action_observation",
    title: operation.title,
    action: operation.action,
    observation: operation.observation,
    summary: null,
    tool_name: operation.tool_name,
    at: operation.at,
    refs: operation.refs,
  });
  const nextKey = contentKey(nextContent);
  const reusableChild = parent.child_ids
    .map((childId) => requireNode(tree, childId))
    .find((child) => child.layer === "raw" && child.status !== "failed" && contentKey(child.content) === nextKey);

  if (reusableChild) {
    tree.current_raw_node_id = reusableChild.node_id;
    tree.updated_at = operation.at;
    return ExecutionTreeV1Schema.parse(tree);
  }

  const stepId = tree.next_step_id;
  const id = nodeId("raw", stepId);
  tree.nodes[id] = ExecutionTreeNodeV1Schema.parse({
    version: 1,
    node_id: id,
    layer: "raw",
    step_id: stepId,
    parent_id: parent.node_id,
    child_ids: [],
    cover_node_ids: [],
    diagnostic_note: null,
    status: "active",
    validated: false,
    content: nextContent,
  });
  appendChild(tree, parent.node_id, id);
  tree.current_raw_node_id = id;
  tree.next_step_id = stepId + 1;
  tree.updated_at = operation.at;
  return ExecutionTreeV1Schema.parse(tree);
}

export function compressExecutionTreeV1(
  treeInput: ExecutionTreeV1,
  operationInput: z.infer<typeof ExecutionTreeCompressOperationV1Schema>,
): ExecutionTreeV1 {
  const tree = cloneTree(treeInput);
  const operation = ExecutionTreeCompressOperationV1Schema.parse(operationInput);
  assertOperationTarget(tree, operation);
  const currentSummary = requireNode(tree, tree.current_summary_node_id);
  if (currentSummary.layer !== "summary") throw new Error(`current summary pointer is not a summary node: ${currentSummary.node_id}`);
  const boundaryRawNodeId = lastCoverNodeId(currentSummary);
  const coveredRawNodes = traceRawSegment(tree, boundaryRawNodeId, tree.current_raw_node_id);
  if (coveredRawNodes.length === 0) {
    throw new Error("execution tree cannot compress an empty raw segment");
  }
  const coverNodeIds = coveredRawNodes.map((node) => node.node_id);
  const existingSummary = currentSummary.child_ids
    .map((childId) => requireNode(tree, childId))
    .find((child) => child.layer === "summary" && child.status !== "failed" && JSON.stringify(child.cover_node_ids) === JSON.stringify(coverNodeIds));
  const nextContent = ExecutionTreeNodeContentV1Schema.parse({
    kind: "summary",
    title: operation.title,
    action: null,
    observation: null,
    summary: operation.summary,
    tool_name: null,
    at: operation.at,
    refs: [],
  });

  if (existingSummary) {
    tree.nodes[existingSummary.node_id] = {
      ...existingSummary,
      content: nextContent,
      validated: false,
      diagnostic_note: null,
      status: "active",
    };
    tree.current_summary_node_id = existingSummary.node_id;
    tree.updated_at = operation.at;
    return ExecutionTreeV1Schema.parse(tree);
  }

  const stepId = tree.next_step_id;
  const id = nodeId("summary", stepId);
  tree.nodes[id] = ExecutionTreeNodeV1Schema.parse({
    version: 1,
    node_id: id,
    layer: "summary",
    step_id: stepId,
    parent_id: currentSummary.node_id,
    child_ids: [],
    cover_node_ids: coverNodeIds,
    diagnostic_note: null,
    status: "active",
    validated: false,
    content: nextContent,
  });
  appendChild(tree, currentSummary.node_id, id);
  tree.current_summary_node_id = id;
  tree.next_step_id = stepId + 1;
  tree.updated_at = operation.at;
  return ExecutionTreeV1Schema.parse(tree);
}

export function maintainExecutionTreeV1(
  treeInput: ExecutionTreeV1,
  operationInput: z.infer<typeof ExecutionTreeMaintainOperationV1Schema>,
): ExecutionTreeV1 {
  const tree = cloneTree(treeInput);
  const operation = ExecutionTreeMaintainOperationV1Schema.parse(operationInput);
  assertOperationTarget(tree, operation);
  const targetId = operation.target_summary_node_id ?? tree.current_summary_node_id;
  const target = requireNode(tree, targetId);
  if (target.layer !== "summary") throw new Error(`maintain target is not a summary node: ${target.node_id}`);
  tree.nodes[target.node_id] = {
    ...target,
    validated: operation.passed,
    status: operation.passed ? "active" : "failed",
    diagnostic_note: operation.passed ? null : operation.diagnostic_note ?? "summary validation failed",
  };
  if (!operation.passed) {
    markNodesFailed(tree, target.cover_node_ids, operation.diagnostic_note ?? "summary validation failed");
  }
  tree.updated_at = operation.at;
  return ExecutionTreeV1Schema.parse(tree);
}

export function reviseExecutionTreeV1(
  treeInput: ExecutionTreeV1,
  operationInput: z.infer<typeof ExecutionTreeReviseOperationV1Schema>,
): ExecutionTreeV1 {
  const tree = cloneTree(treeInput);
  const operation = ExecutionTreeReviseOperationV1Schema.parse(operationInput);
  assertOperationTarget(tree, operation);
  const failedSummary = requireNode(tree, operation.target_summary_node_id);
  if (failedSummary.layer !== "summary") throw new Error(`revise target is not a summary node: ${failedSummary.node_id}`);
  if (!failedSummary.parent_id) throw new Error("execution tree cannot revise the summary root");
  const restoreSummary = requireNode(tree, failedSummary.parent_id);
  if (restoreSummary.layer !== "summary") throw new Error(`revise restore target is not a summary node: ${restoreSummary.node_id}`);
  const diagnosticNote = operation.diagnostic_note ?? failedSummary.diagnostic_note ?? "branch revised";

  tree.nodes[failedSummary.node_id] = {
    ...failedSummary,
    status: "failed",
    diagnostic_note: diagnosticNote,
    validated: false,
  };
  markNodesFailed(tree, failedSummary.cover_node_ids, diagnosticNote);
  tree.current_summary_node_id = restoreSummary.node_id;
  tree.current_raw_node_id = lastCoverNodeId(restoreSummary);
  tree.updated_at = operation.at;
  return ExecutionTreeV1Schema.parse(tree);
}

export function applyExecutionTreeOperationV1(
  treeInput: ExecutionTreeV1,
  operationInput: ExecutionTreeOperationV1,
): ExecutionTreeV1 {
  const operation = ExecutionTreeOperationV1Schema.parse(operationInput);
  switch (operation.type) {
    case "grow":
      return growExecutionTreeV1(treeInput, operation);
    case "compress":
      return compressExecutionTreeV1(treeInput, operation);
    case "maintain":
      return maintainExecutionTreeV1(treeInput, operation);
    case "revise":
      return reviseExecutionTreeV1(treeInput, operation);
    default: {
      const exhaustive: never = operation;
      throw new Error(`unsupported execution tree operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function deriveExecutionTreeStateV1(treeInput: ExecutionTreeV1): ExecutionTreeStateV1 {
  const tree = ExecutionTreeV1Schema.parse(treeInput);
  const summaries = summaryPath(tree)
    .filter((node) => node.node_id !== tree.root_summary_node_id)
    .filter((node) => node.status === "active")
    .map(toStateEntry);
  const currentSummary = requireNode(tree, tree.current_summary_node_id);
  const rawBoundary = lastCoverNodeId(currentSummary);
  const rawEntries = traceRawSegment(tree, rawBoundary, tree.current_raw_node_id)
    .filter((node) => node.status === "active")
    .map(toStateEntry);
  const hintNodes = new Map<string, ExecutionTreeNodeV1>();
  for (const childId of currentSummary.child_ids) {
    hintNodes.set(childId, requireNode(tree, childId));
  }
  const currentRaw = requireNode(tree, tree.current_raw_node_id);
  for (const childId of currentRaw.child_ids) {
    hintNodes.set(childId, requireNode(tree, childId));
  }
  for (const node of Object.values(tree.nodes)) {
    if (node.status === "failed" && node.diagnostic_note) {
      hintNodes.set(node.node_id, node);
    }
  }
  const executionHints = Array.from(hintNodes.values())
    .filter((node) => node.node_id !== tree.current_summary_node_id && node.node_id !== tree.current_raw_node_id)
    .sort((left, right) => left.step_id - right.step_id || left.node_id.localeCompare(right.node_id))
    .map(toStateEntry);

  return ExecutionTreeStateV1Schema.parse({
    state_version: "execution_tree_state_v1",
    tree_id: tree.tree_id,
    current_summary_node_id: tree.current_summary_node_id,
    current_raw_node_id: tree.current_raw_node_id,
    compressed_state: summaries,
    raw_state: rawEntries,
    execution_hints: executionHints,
  });
}
