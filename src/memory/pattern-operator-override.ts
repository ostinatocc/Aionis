import type { LiteWriteStore } from "../store/lite-write-store.js";
import { HttpError } from "../util/http.js";
import {
  PatternOperatorOverrideSchema,
  PatternSuppressRequest,
  PatternSuppressResponseSchema,
  PatternUnsuppressRequest,
  type PatternOperatorOverride,
} from "./schemas.js";
import { resolveNodePatternExecutionSurface } from "./node-execution-surface.js";
import { resolveTenantScope } from "./tenant.js";
import { buildAionisUri } from "./uri.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function buildOperatorOverride(args: {
  suppressed: boolean;
  reason: string | null;
  mode: "shadow_learn" | "hard_freeze";
  until: string | null;
  updatedAt: string;
  updatedBy: string | null;
  lastAction: "suppress" | "unsuppress";
}): PatternOperatorOverride {
  return PatternOperatorOverrideSchema.parse({
    schema_version: "operator_override_v1",
    suppressed: args.suppressed,
    reason: args.reason,
    mode: args.mode,
    until: args.until,
    updated_at: args.updatedAt,
    updated_by: args.updatedBy,
    last_action: args.lastAction,
  });
}

export function readPatternOperatorOverride(slots: Record<string, unknown>): PatternOperatorOverride | null {
  const parsed = PatternOperatorOverrideSchema.safeParse(slots.operator_override_v1);
  return parsed.success ? parsed.data : null;
}

export function isPatternSuppressed(override: PatternOperatorOverride | null, now = Date.now()): boolean {
  if (!override || override.suppressed !== true) return false;
  if (!override.until) return true;
  const untilMs = Date.parse(override.until);
  return Number.isFinite(untilMs) && untilMs > now;
}

async function loadPatternAnchorNode(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes">;
  scope: string;
  anchorId: string;
  actor: string | null;
}) {
  const { rows } = await args.liteWriteStore.findNodes({
    scope: args.scope,
    id: args.anchorId,
    consumerAgentId: args.actor,
    consumerTeamId: null,
    limit: 1,
    offset: 0,
  });
  const row = rows[0] ?? null;
  if (!row) {
    throw new HttpError(404, "pattern_anchor_not_found", "pattern anchor not found", {
      anchor_id: args.anchorId,
    });
  }
  const patternSurface = resolveNodePatternExecutionSurface({
    slots: asRecord(row.slots),
  });
  if (row.type !== "concept" || patternSurface.anchor_kind !== "pattern") {
    throw new HttpError(400, "pattern_anchor_required", "target node is not a pattern anchor", {
      anchor_id: args.anchorId,
      node_type: row.type,
    });
  }
  return { row, patternSurface };
}

async function updatePatternOperatorOverride(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">;
  scope: string;
  tenantId: string;
  actor: string | null;
  anchorId: string;
  nextOverride: PatternOperatorOverride;
}) {
  const { row, patternSurface } = await loadPatternAnchorNode({
    liteWriteStore: args.liteWriteStore,
    scope: args.scope,
    anchorId: args.anchorId,
    actor: args.actor,
  });
  const nextSlots = {
    ...asRecord(row.slots),
    operator_override_v1: args.nextOverride,
  };
  await args.liteWriteStore.updateNodeAnchorState({
    scope: args.scope,
    id: row.id,
    slots: nextSlots,
    textSummary: row.text_summary ?? "",
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    commitId: row.commit_id ?? null,
  });
  return PatternSuppressResponseSchema.parse({
    tenant_id: args.tenantId,
    scope: args.scope,
    anchor_id: row.id,
    anchor_uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: row.type,
      id: row.id,
    }),
    selected_tool: patternSurface.selected_tool,
    pattern_state: patternSurface.pattern_state,
    credibility_state: patternSurface.credibility_state,
    operator_override: args.nextOverride,
  });
}

export async function suppressPatternAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">;
}) {
  const parsed = PatternSuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  const now = new Date().toISOString();
  return updatePatternOperatorOverride({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    actor: parsed.actor ?? null,
    anchorId: parsed.anchor_id,
    nextOverride: buildOperatorOverride({
      suppressed: true,
      reason: parsed.reason,
      mode: parsed.mode,
      until: parsed.until ?? null,
      updatedAt: now,
      updatedBy: parsed.actor ?? null,
      lastAction: "suppress",
    }),
  });
}

export async function unsuppressPatternAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">;
}) {
  const parsed = PatternUnsuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  const now = new Date().toISOString();
  return updatePatternOperatorOverride({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    actor: parsed.actor ?? null,
    anchorId: parsed.anchor_id,
    nextOverride: buildOperatorOverride({
      suppressed: false,
      reason: parsed.reason ?? null,
      mode: "shadow_learn",
      until: null,
      updatedAt: now,
      updatedBy: parsed.actor ?? null,
      lastAction: "unsuppress",
    }),
  });
}
