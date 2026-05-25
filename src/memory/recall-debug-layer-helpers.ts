import type { RecallNodeRow } from "../store/recall-access.js";
import type { MemoryLayerId, MemoryLayerPolicy } from "./layer-policy.js";
import { resolveNodeCompressionLayer } from "./node-execution-surface.js";

type NodeRow = RecallNodeRow;

export function parseVectorText(v: string, maxPreviewDims: number): { dims: number; preview: number[] } {
  const s = v.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) throw new Error("unexpected vector text");
  const body = s.slice(1, -1).trim();
  if (!body) return { dims: 0, preview: [] };
  const parts = body.split(",");
  const preview: number[] = [];
  for (let i = 0; i < parts.length && i < maxPreviewDims; i++) {
    preview.push(Number(parts[i]));
  }
  return { dims: parts.length, preview };
}

export function isDraftTopic(node: NodeRow): boolean {
  return node.type === "topic" && (node.topic_state ?? "active") === "draft";
}

export function resolveCompressionLayer(node: NodeRow): MemoryLayerId | null {
  return resolveNodeCompressionLayer({
    type: node.type,
    slots: node.slots ?? null,
  });
}

export function allowedLayersForPolicy(layerPolicy: MemoryLayerPolicy | null): Set<MemoryLayerId> | null {
  if (!layerPolicy || layerPolicy.source !== "request_override") return null;
  return new Set<MemoryLayerId>([
    ...layerPolicy.preferred_layers,
    ...layerPolicy.fallback_layers,
    ...layerPolicy.trust_anchor_layers,
  ]);
}

export function pickSlotsPreview(slots: unknown, maxKeys: number): Record<string, unknown> | null {
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) return null;
  const obj = slots as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, maxKeys)) out[k] = obj[k];
  return out;
}
