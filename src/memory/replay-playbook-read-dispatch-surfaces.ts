import type { ReplayPlaybookRow } from "../store/replay-access.js";
import { buildReplayCostSignals } from "./cost-signals.js";
import { buildAionisUri } from "./uri.js";

function asObject(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function buildReplayPlaybookGetSurface(args: {
  tenantId: string;
  scope: string;
  playbookId: string;
  row: ReplayPlaybookRow;
  commitUri: string | null;
}) {
  const slotsObj = asObject(args.row.slots) ?? {};
  return {
    playbook_id: args.playbookId,
    name: args.row.title,
    text_summary: args.row.text_summary,
    version: args.row.version_num,
    status: args.row.playbook_status ?? "draft",
    matchers: asObject(slotsObj.matchers) ?? {},
    success_criteria: asObject(slotsObj.success_criteria) ?? {},
    risk_profile: toStringOrNull(slotsObj.risk_profile) ?? "medium",
    source_run_id: toStringOrNull(slotsObj.source_run_id),
    steps_template: Array.isArray(slotsObj.steps_template) ? slotsObj.steps_template : [],
    compile_summary: asObject(slotsObj.compile_summary) ?? {},
    uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
    node_id: args.row.id,
    commit_id: args.row.commit_id,
    commit_uri: args.commitUri,
    created_at: args.row.created_at,
    updated_at: args.row.updated_at,
  };
}

export function buildReplayPlaybookCandidateSurface(args: {
  tenantId: string;
  scope: string;
  playbookId: string;
  row: ReplayPlaybookRow;
  deterministicGate: Record<string, unknown>;
  nextAction: string | null;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    playbook: {
      playbook_id: args.playbookId,
      version: args.row.version_num,
      status: args.row.playbook_status ?? "draft",
      name: args.row.title,
      uri: buildAionisUri({
        tenant_id: args.tenantId,
        scope: args.scope,
        type: args.row.type,
        id: args.row.id,
      }),
      node_id: args.row.id,
    },
    candidate: {
      eligible_for_deterministic_replay: Boolean(args.deterministicGate.matched),
      recommended_mode: args.deterministicGate.effective_mode,
      next_action: args.nextAction,
      mismatch_reasons: args.deterministicGate.mismatch_reasons,
      rejectable: Boolean(args.deterministicGate.enabled && args.deterministicGate.decision === "rejected"),
    },
    deterministic_gate: args.deterministicGate,
    cost_signals: buildReplayCostSignals({ deterministic_gate: args.deterministicGate }),
  };
}

export function buildReplayDispatchSurface(args: {
  tenantId: string;
  scope: string;
  decision: "deterministic_replay_executed" | "candidate_only" | "fallback_replay_executed";
  primaryInferenceSkipped: boolean;
  fallbackExecuted: boolean;
  candidate: unknown;
  replay: unknown;
  deterministicGate: Record<string, unknown> | null;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    dispatch: {
      decision: args.decision,
      primary_inference_skipped: args.primaryInferenceSkipped,
      fallback_executed: args.fallbackExecuted,
    },
    candidate: args.candidate,
    replay: args.replay,
    cost_signals: buildReplayCostSignals({
      deterministic_gate: args.deterministicGate,
      dispatch: { fallback_executed: args.fallbackExecuted },
    }),
  };
}
