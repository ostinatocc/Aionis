import type { RecallCandidate, RecallEdgeRow, RecallNodeRow } from "../store/recall-access.js";
import { isWorkflowPromotionReady, recallAnchorMeta } from "./recall-action-packet.js";

type NodeRow = RecallNodeRow;
type EdgeRow = RecallEdgeRow;

function edgeTypeWeight(type: string): number {
  if (type === "derived_from") return 1.0;
  if (type === "part_of") return 0.9;
  return 0.6;
}

export function actionRecallPriority(node: NodeRow): number {
  const meta = recallAnchorMeta(node);
  if (!meta.anchorKind) {
    if (node.type === "procedure") return 4;
    if (node.type === "rule") return 8;
    if (node.type === "concept" || node.type === "topic" || node.type === "entity") return 10;
    return 12;
  }
  if (meta.anchorKind === "workflow") {
    if (meta.executionKind === "workflow_candidate" || meta.workflowPromotion?.promotion_state === "candidate") {
      return isWorkflowPromotionReady(meta.workflowPromotion) ? 1 : 2;
    }
    return 0;
  }
  if (meta.anchorKind === "pattern") {
    if (meta.patternState === "stable" && !meta.counterEvidenceOpen) return 3;
    return 4;
  }
  if (meta.anchorKind === "decision") return 5;
  if (meta.anchorKind === "execution") return 6;
  return 7;
}

export function prioritizeRankedForActionRecall(
  ranked: Array<{ id: string; activation: number; score: number }>,
  nodes: Map<string, NodeRow>,
) {
  return [...ranked].sort((a, b) => {
    const aNode = nodes.get(a.id);
    const bNode = nodes.get(b.id);
    const aPriority = aNode ? actionRecallPriority(aNode) : 99;
    const bPriority = bNode ? actionRecallPriority(bNode) : 99;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return b.score - a.score || a.id.localeCompare(b.id);
  });
}

export function spreadActivation(
  seeds: RecallCandidate[],
  nodes: Map<string, NodeRow>,
  edges: EdgeRow[],
  hops: number,
) {
  const activationById = new Map<string, number>();
  for (const seed of seeds) {
    const activation = Math.max(0, Math.min(1, 0.75 * seed.similarity + 0.25 * seed.salience));
    activationById.set(seed.id, activation);
  }

  const adjacency = new Map<string, EdgeRow[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.src_id)) adjacency.set(edge.src_id, []);
    if (!adjacency.has(edge.dst_id)) adjacency.set(edge.dst_id, []);
    adjacency.get(edge.src_id)!.push(edge);
    adjacency.get(edge.dst_id)!.push(edge);
  }

  for (let iteration = 0; iteration < hops; iteration++) {
    const next = new Map(activationById);
    for (const [nodeId, activation] of activationById.entries()) {
      const nodeEdges = adjacency.get(nodeId) ?? [];
      for (const edge of nodeEdges) {
        const otherId = edge.src_id === nodeId ? edge.dst_id : edge.src_id;
        const edgeWeight = edgeTypeWeight(edge.type) * edge.weight * edge.confidence;
        const propagated = activation * edgeWeight * 0.5;
        next.set(otherId, Math.max(next.get(otherId) ?? 0, propagated));
      }
    }
    for (const [nodeId, activation] of next.entries()) {
      activationById.set(nodeId, Math.max(activationById.get(nodeId) ?? 0, activation));
    }
  }

  return Array.from(activationById.entries())
    .map(([id, activation]) => {
      const node = nodes.get(id);
      const confidence = node?.confidence ?? 0.5;
      const salience = node?.salience ?? 0.5;
      const score = 0.7 * activation + 0.15 * confidence + 0.15 * salience;
      return { id, activation, score };
    })
    .sort((a, b) => b.score - a.score);
}
