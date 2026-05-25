import {
  resolveArchiveRelocationPlan,
  resolveSemanticForgettingDecision,
} from "../kernel/forgetting-kernel.js";
import { resolveNodePriorityProfile } from "./importance-dynamics.js";

export type ResolveNodeLifecycleSignalsArgs = {
  type: string;
  tier?: string | null;
  title?: string | null;
  text_summary?: string | null;
  slots?: Record<string, unknown> | null;
  salience?: number | null;
  importance?: number | null;
  confidence?: number | null;
  raw_ref?: string | null;
  evidence_ref?: string | null;
  reference_time?: string | number | Date | null;
};

export type ResolvedNodeLifecycleSignals = {
  slots: Record<string, unknown>;
  salience: number;
  importance: number;
  confidence: number;
};

export function resolveNodeLifecycleSignals(
  args: ResolveNodeLifecycleSignalsArgs,
): ResolvedNodeLifecycleSignals {
  const slots = { ...(args.slots ?? {}) };
  const profile = resolveNodePriorityProfile({
    type: args.type,
    tier: args.tier ?? "hot",
    title: args.title ?? null,
    text_summary: args.text_summary ?? null,
    slots,
    salience: args.salience ?? null,
    importance: args.importance ?? null,
    confidence: args.confidence ?? null,
    reference_time: args.reference_time ?? null,
  });
  const forgetting = resolveSemanticForgettingDecision({
    type: args.type,
    tier: args.tier ?? "hot",
    title: args.title ?? null,
    text_summary: args.text_summary ?? null,
    slots,
    salience: profile.salience,
    importance: profile.importance,
    confidence: profile.confidence,
    reference_time: args.reference_time ?? null,
  });
  slots.semantic_forgetting_v1 = forgetting;
  slots.archive_relocation_v1 = resolveArchiveRelocationPlan({
    forgetting,
    slots,
    raw_ref: args.raw_ref ?? null,
    evidence_ref: args.evidence_ref ?? null,
  });
  return {
    slots,
    salience: profile.salience,
    importance: profile.importance,
    confidence: profile.confidence,
  };
}
