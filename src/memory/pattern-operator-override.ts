import stableStringify from "fast-json-stable-stringify";

import type { LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { runAppliedAuthorityMutationV2 } from "./applied-authority-mutation.js";
import {
  NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
  applyNodeAuthorityPatchesV2,
  assertNodeDecisionRowMatchesAuthorityState,
  buildNodeAuthorityMutationV2,
  verifyNodeAuthorityPatchesV2,
  type NodeAuthorityPatchV2,
} from "./node-authority-mutation.js";
import {
  AnchorSuppressRequest,
  AnchorSuppressResponseSchema,
  AnchorUnsuppressRequest,
  PatternOperatorOverrideSchema,
  PatternSuppressRequest,
  PatternSuppressResponseSchema,
  PatternUnsuppressRequest,
  type PatternOperatorOverride,
} from "./schemas.js";
import {
  resolveNodeAnchorKind,
  resolveNodeExecutionKind,
  resolveNodePatternExecutionSurface,
} from "./node-execution-surface.js";
import { resolveTenantScope } from "./tenant.js";
import { buildAionisUri } from "./uri.js";

type OperatorOverrideAction =
  | "pattern_suppress"
  | "pattern_unsuppress"
  | "anchor_suppress"
  | "anchor_unsuppress";

type OperatorOverrideAuthorityFence = {
  expectedHeadRevision?: number;
  expectedHeadCommitId?: string | null;
};

type OperatorOverrideMutationRequest = {
  action: OperatorOverrideAction;
  anchorId: string;
  actor: string;
  reason: string | null;
  mode: "shadow_learn" | "hard_freeze";
  until: string | null;
};

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

export function readAnchorOperatorOverride(slots: Record<string, unknown>): PatternOperatorOverride | null {
  const parsed = PatternOperatorOverrideSchema.safeParse(slots.operator_override_v1);
  return parsed.success ? parsed.data : null;
}

export function readPatternOperatorOverride(slots: Record<string, unknown>): PatternOperatorOverride | null {
  return readAnchorOperatorOverride(slots);
}

export function isAnchorSuppressed(override: PatternOperatorOverride | null, now = Date.now()): boolean {
  if (!override || override.suppressed !== true) return false;
  if (!override.until) return true;
  const untilMs = Date.parse(override.until);
  return Number.isFinite(untilMs) && untilMs > now;
}

export function isPatternSuppressed(override: PatternOperatorOverride | null, now = Date.now()): boolean {
  return isAnchorSuppressed(override, now);
}

function isManagedOperatorAnchor(args: {
  nodeType: string;
  anchorKind: string | null;
  executionKind: string | null;
}): boolean {
  if (args.anchorKind === "pattern" && args.nodeType === "concept") return true;
  if (args.anchorKind === "workflow" && args.nodeType === "procedure") return true;
  return (
    args.nodeType === "procedure"
    && (args.executionKind === "workflow_anchor" || args.executionKind === "workflow_candidate")
  );
}

async function loadPatternAnchorNode(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes">;
  scope: string;
  anchorId: string;
  actor: string;
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

async function loadOperatorAnchorNode(args: {
  liteWriteStore: Pick<LiteWriteStore, "findNodes">;
  scope: string;
  anchorId: string;
  actor: string;
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
    throw new HttpError(404, "anchor_not_found", "anchor not found", {
      anchor_id: args.anchorId,
    });
  }
  const slots = asRecord(row.slots);
  const anchorKind = resolveNodeAnchorKind(slots);
  const executionKind = resolveNodeExecutionKind(slots);
  if (!isManagedOperatorAnchor({ nodeType: row.type, anchorKind, executionKind })) {
    throw new HttpError(400, "operator_anchor_required", "target node is not a suppressible execution anchor", {
      anchor_id: args.anchorId,
      node_type: row.type,
      anchor_kind: anchorKind,
      execution_kind: executionKind,
    });
  }
  const patternSurface = resolveNodePatternExecutionSurface({ slots });
  return { row, slots, anchorKind, patternSurface };
}

function normalizeOperatorActor(value: string | undefined): string {
  const normalized = value?.normalize("NFC").trim() ?? "";
  return normalized || "system";
}

function normalizeOperatorReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.normalize("NFC").trim();
}

function normalizeOperatorUntil(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function suppressAction(action: OperatorOverrideAction): boolean {
  return action === "pattern_suppress" || action === "anchor_suppress";
}

function operatorOverrideInputSha256(scope: string, request: OperatorOverrideMutationRequest): string {
  return sha256Hex(stableStringify({
    action: request.action,
    scope,
    anchor_id: request.anchorId,
    reason: request.reason,
    mode: request.mode,
    until: request.until,
  }));
}

function sameOperatorOverrideIntent(
  current: PatternOperatorOverride | null,
  request: OperatorOverrideMutationRequest,
): current is PatternOperatorOverride {
  if (!current) return false;
  const isSuppress = suppressAction(request.action);
  return current.suppressed === isSuppress
    && current.reason === request.reason
    && current.mode === request.mode
    && current.until === request.until
    && current.updated_by === request.actor
    && current.last_action === (isSuppress ? "suppress" : "unsuppress");
}

function patternOverrideResponse(args: {
  tenantId: string;
  scope: string;
  row: Awaited<ReturnType<typeof loadPatternAnchorNode>>["row"];
  patternSurface: Awaited<ReturnType<typeof loadPatternAnchorNode>>["patternSurface"];
  override: PatternOperatorOverride;
}) {
  return PatternSuppressResponseSchema.parse({
    tenant_id: args.tenantId,
    scope: args.scope,
    anchor_id: args.row.id,
    anchor_uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
    selected_tool: args.patternSurface.selected_tool,
    pattern_state: args.patternSurface.pattern_state,
    credibility_state: args.patternSurface.credibility_state,
    operator_override: args.override,
  });
}

function anchorOverrideResponse(args: {
  tenantId: string;
  scope: string;
  row: Awaited<ReturnType<typeof loadOperatorAnchorNode>>["row"];
  anchorKind: string | null;
  patternSurface: Awaited<ReturnType<typeof loadOperatorAnchorNode>>["patternSurface"];
  override: PatternOperatorOverride;
}) {
  return AnchorSuppressResponseSchema.parse({
    tenant_id: args.tenantId,
    scope: args.scope,
    anchor_id: args.row.id,
    anchor_uri: buildAionisUri({
      tenant_id: args.tenantId,
      scope: args.scope,
      type: args.row.type,
      id: args.row.id,
    }),
    anchor_kind: args.anchorKind,
    node_type: args.row.type,
    selected_tool: args.patternSurface.selected_tool,
    pattern_state: args.patternSurface.pattern_state,
    credibility_state: args.patternSurface.credibility_state,
    operator_override: args.override,
  });
}

async function runOperatorOverrideAuthority(args: {
  liteWriteStore: LiteWriteStore;
  scope: string;
  tenantId: string;
  targetContract: "pattern" | "anchor";
  request: OperatorOverrideMutationRequest;
} & OperatorOverrideAuthorityFence) {
  const authority = await runAppliedAuthorityMutationV2({
    store: args.liteWriteStore,
    scope: args.scope,
    inputSha256: operatorOverrideInputSha256(args.scope, args.request),
    actor: args.request.actor,
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
    plan: async ({ appliedAt }) => {
      const loaded = args.targetContract === "pattern"
        ? await loadPatternAnchorNode({
            liteWriteStore: args.liteWriteStore,
            scope: args.scope,
            anchorId: args.request.anchorId,
            actor: args.request.actor,
          }).then((entry) => ({
            ...entry,
            slots: asRecord(entry.row.slots),
            anchorKind: "pattern" as string | null,
          }))
        : await loadOperatorAnchorNode({
            liteWriteStore: args.liteWriteStore,
            scope: args.scope,
            anchorId: args.request.anchorId,
            actor: args.request.actor,
          });
      const row = loaded.row;
      const slots = loaded.slots;
      const anchorKind = loaded.anchorKind;
      const before = (await args.liteWriteStore.nodeStatesByIds(args.scope, [row.id])).get(row.id);
      if (!before) throw new Error(`operator_override_authority_target_missing:${row.id}`);
      assertNodeDecisionRowMatchesAuthorityState(row, before, "operator_override_authority_row_changed");

      const currentOverride = readAnchorOperatorOverride(slots);
      const buildResponse = (override: PatternOperatorOverride) => args.targetContract === "pattern"
        ? patternOverrideResponse({
            tenantId: args.tenantId,
            scope: args.scope,
            row,
            patternSurface: loaded.patternSurface,
            override,
          })
        : anchorOverrideResponse({
            tenantId: args.tenantId,
            scope: args.scope,
            row,
            anchorKind,
            patternSurface: loaded.patternSurface,
            override,
          });
      if (sameOperatorOverrideIntent(currentOverride, args.request)) {
        return { status: "no_op" as const, value: buildResponse(currentOverride) };
      }

      const isSuppress = suppressAction(args.request.action);
      const nextOverride = buildOperatorOverride({
        suppressed: isSuppress,
        reason: args.request.reason,
        mode: args.request.mode,
        until: args.request.until,
        updatedAt: appliedAt,
        updatedBy: args.request.actor,
        lastAction: isSuppress ? "suppress" : "unsuppress",
      });
      const patch: NodeAuthorityPatchV2 = {
        id: row.id,
        slots: {
          ...slots,
          operator_override_v1: nextOverride,
        },
        textSummary: row.text_summary,
        salience: row.salience,
        importance: row.importance,
        confidence: row.confidence,
      };
      const response = buildResponse(nextOverride);
      return {
        status: "mutate" as const,
        authorityKind: "operator_anchor_override",
        mutations: [buildNodeAuthorityMutationV2({
          before,
          patch,
          requestedEvidence: {
            operator_override_action: {
              action: args.request.action,
              target_contract: args.targetContract,
              actor: args.request.actor,
              reason: args.request.reason,
              mode: args.request.mode,
              until: args.request.until,
              anchor_kind: anchorKind,
            },
            side_effects: NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
          },
        })],
        apply: async ({ commitId }) => {
          await applyNodeAuthorityPatchesV2({
            store: args.liteWriteStore,
            scope: args.scope,
            patches: [patch],
            commitId,
          });
          return response;
        },
        verify: async ({ commitId }) => verifyNodeAuthorityPatchesV2({
          store: args.liteWriteStore,
          scope: args.scope,
          patches: [patch],
          commitId,
          errorLabel: "operator_override_authority",
        }),
      };
    },
  });
  return authority.value;
}

export async function suppressPatternAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
} & OperatorOverrideAuthorityFence) {
  const parsed = PatternSuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  return runOperatorOverrideAuthority({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    targetContract: "pattern",
    request: {
      action: "pattern_suppress",
      anchorId: parsed.anchor_id,
      actor: normalizeOperatorActor(parsed.actor),
      reason: normalizeOperatorReason(parsed.reason),
      mode: parsed.mode,
      until: normalizeOperatorUntil(parsed.until),
    },
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
  });
}

export async function suppressAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
} & OperatorOverrideAuthorityFence) {
  const parsed = AnchorSuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  return runOperatorOverrideAuthority({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    targetContract: "anchor",
    request: {
      action: "anchor_suppress",
      anchorId: parsed.anchor_id,
      actor: normalizeOperatorActor(parsed.actor),
      reason: normalizeOperatorReason(parsed.reason),
      mode: parsed.mode,
      until: normalizeOperatorUntil(parsed.until),
    },
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
  });
}

export async function unsuppressPatternAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
} & OperatorOverrideAuthorityFence) {
  const parsed = PatternUnsuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  return runOperatorOverrideAuthority({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    targetContract: "pattern",
    request: {
      action: "pattern_unsuppress",
      anchorId: parsed.anchor_id,
      actor: normalizeOperatorActor(parsed.actor),
      reason: normalizeOperatorReason(parsed.reason),
      mode: "shadow_learn",
      until: null,
    },
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
  });
}

export async function unsuppressAnchorLite(args: {
  body: unknown;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
} & OperatorOverrideAuthorityFence) {
  const parsed = AnchorUnsuppressRequest.parse(args.body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: args.defaultScope, defaultTenantId: args.defaultTenantId },
  );
  return runOperatorOverrideAuthority({
    liteWriteStore: args.liteWriteStore,
    scope: tenancy.scope_key,
    tenantId: tenancy.tenant_id,
    targetContract: "anchor",
    request: {
      action: "anchor_unsuppress",
      anchorId: parsed.anchor_id,
      actor: normalizeOperatorActor(parsed.actor),
      reason: normalizeOperatorReason(parsed.reason),
      mode: "shadow_learn",
      until: null,
    },
    ...(args.expectedHeadRevision !== undefined
      ? { expectedHeadRevision: args.expectedHeadRevision }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId")
      ? { expectedHeadCommitId: args.expectedHeadCommitId ?? null }
      : {}),
  });
}
