import stableStringify from "fast-json-stable-stringify";

import type {
  LiteFindNodeRow,
  LiteWriteStore,
} from "../store/lite-write-store.js";
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
import { resolveTenantScope } from "./tenant.js";

type MemorySuppressionRecord = {
  contract_version: "memory_suppression_v1";
  suppressed: boolean;
  previous_lifecycle_state: string;
  reason: string;
  updated_at: string;
  updated_by: string;
};

export type MemorySuppressionRequest = {
  tenant_id?: string;
  scope?: string;
  actor?: string;
  consumer_team_id?: string;
  reason: string;
  memory_ids?: string[];
  node_ids?: string[];
  client_ids?: string[];
  anchor_id?: string;
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(
    values
      .map((value) => value?.trim())
      .filter((value): value is string => !!value),
  )];
}

function suppressionRecord(
  slots: Record<string, unknown>,
): MemorySuppressionRecord | null {
  const value = slots.memory_suppression_v1;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.contract_version !== "memory_suppression_v1"
    || typeof record.suppressed !== "boolean"
    || typeof record.previous_lifecycle_state !== "string"
    || typeof record.reason !== "string"
    || typeof record.updated_at !== "string"
    || typeof record.updated_by !== "string"
  ) {
    return null;
  }
  return record as MemorySuppressionRecord;
}

async function resolveSuppressionRows(args: {
  store: LiteWriteStore;
  scope: string;
  actor: string;
  consumerTeamId: string | null;
  request: MemorySuppressionRequest;
}): Promise<{
  rows: LiteFindNodeRow[];
  missingNodeIds: string[];
  missingClientIds: string[];
}> {
  const rows = new Map<string, LiteFindNodeRow>();
  const nodeIds = uniqueStrings([
    ...(args.request.memory_ids ?? []),
    ...(args.request.node_ids ?? []),
    args.request.anchor_id,
  ]);
  const clientIds = uniqueStrings(args.request.client_ids ?? []);
  const missingNodeIds: string[] = [];
  const missingClientIds: string[] = [];

  for (const id of nodeIds) {
    const found = await args.store.findNodes({
      scope: args.scope,
      id,
      consumerAgentId: args.actor,
      consumerTeamId: args.consumerTeamId,
      limit: 1,
      offset: 0,
    });
    const row = found.rows[0];
    if (row) rows.set(row.id, row);
    else missingNodeIds.push(id);
  }
  for (const clientId of clientIds) {
    const found = await args.store.findNodes({
      scope: args.scope,
      clientId,
      consumerAgentId: args.actor,
      consumerTeamId: args.consumerTeamId,
      limit: 1,
      offset: 0,
    });
    const row = found.rows[0];
    if (row) rows.set(row.id, row);
    else missingClientIds.push(clientId);
  }
  if (rows.size === 0) {
    throw new HttpError(
      404,
      "memory_suppression_target_not_found",
      "No requested memory was found in the current tenant and scope.",
      {
        missing_memory_ids: missingNodeIds,
        missing_client_ids: missingClientIds,
      },
    );
  }
  return {
    rows: [...rows.values()],
    missingNodeIds,
    missingClientIds,
  };
}

export async function setMemorySuppressionLite(args: {
  request: MemorySuppressionRequest;
  suppress: boolean;
  defaultScope: string;
  defaultTenantId: string;
  liteWriteStore: LiteWriteStore;
}): Promise<unknown> {
  const tenancy = resolveTenantScope(
    {
      scope: args.request.scope,
      tenant_id: args.request.tenant_id,
    },
    {
      defaultScope: args.defaultScope,
      defaultTenantId: args.defaultTenantId,
    },
  );
  const actor = args.request.actor?.trim() || "system";
  const resolved = await resolveSuppressionRows({
    store: args.liteWriteStore,
    scope: tenancy.scope_key,
    actor,
    consumerTeamId: args.request.consumer_team_id ?? null,
    request: args.request,
  });
  const result = await runAppliedAuthorityMutationV2({
    store: args.liteWriteStore,
    scope: tenancy.scope_key,
    actor,
    inputSha256: sha256Hex(stableStringify({
      contract_version: "memory_suppression_request_v1",
      suppress: args.suppress,
      reason: args.request.reason,
      memory_ids: resolved.rows.map((row) => row.id).sort(),
    })),
    plan: async ({ appliedAt }) => {
      const patches: NodeAuthorityPatchV2[] = [];
      const mutations: ReturnType<
        typeof buildNodeAuthorityMutationV2
      >[] = [];
      const changedIds: string[] = [];
      const unchangedIds: string[] = [];

      for (const row of resolved.rows) {
        const current = suppressionRecord(row.slots);
        const currentlySuppressed =
          row.slots.lifecycle_state === "suppressed"
          || current?.suppressed === true;
        if (currentlySuppressed === args.suppress) {
          unchangedIds.push(row.id);
          continue;
        }
        const before = (
          await args.liteWriteStore.nodeStatesByIds(
            tenancy.scope_key,
            [row.id],
          )
        ).get(row.id);
        if (!before) {
          throw new Error(`memory_suppression_target_missing:${row.id}`);
        }
        assertNodeDecisionRowMatchesAuthorityState(
          row,
          before,
          "memory_suppression_row_changed",
        );
        const {
          operator_override_v1: _legacyOverride,
          ...slotsWithoutLegacyOverride
        } = row.slots;
        const previousLifecycleState = current?.previous_lifecycle_state
          ?? (
            typeof row.slots.lifecycle_state === "string"
            && row.slots.lifecycle_state !== "suppressed"
              ? row.slots.lifecycle_state
              : "active"
          );
        const record: MemorySuppressionRecord = {
          contract_version: "memory_suppression_v1",
          suppressed: args.suppress,
          previous_lifecycle_state: previousLifecycleState,
          reason: args.request.reason,
          updated_at: appliedAt,
          updated_by: actor,
        };
        const patch: NodeAuthorityPatchV2 = {
          id: row.id,
          slots: {
            ...slotsWithoutLegacyOverride,
            lifecycle_state: args.suppress
              ? "suppressed"
              : previousLifecycleState,
            memory_suppression_v1: record,
          },
          textSummary: row.text_summary,
          salience: row.salience,
          importance: row.importance,
          confidence: row.confidence,
        };
        patches.push(patch);
        mutations.push(buildNodeAuthorityMutationV2({
          before,
          patch,
          requestedEvidence: {
            memory_suppression: {
              suppress: args.suppress,
              reason: args.request.reason,
            },
            side_effects: NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
          },
        }));
        changedIds.push(row.id);
      }

      const response = {
        contract_version: "memory_suppression_result_v1",
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        suppressed: args.suppress,
        changed_memory_ids: changedIds,
        unchanged_memory_ids: unchangedIds,
        missing_memory_ids: resolved.missingNodeIds,
        missing_client_ids: resolved.missingClientIds,
      };
      if (patches.length === 0) {
        return { status: "no_op" as const, value: response };
      }
      return {
        status: "mutate" as const,
        authorityKind: "memory_suppression",
        mutations,
        apply: async ({ commitId }) => {
          await applyNodeAuthorityPatchesV2({
            store: args.liteWriteStore,
            scope: tenancy.scope_key,
            patches,
            commitId,
          });
          return response;
        },
        verify: async ({ commitId }) =>
          verifyNodeAuthorityPatchesV2({
            store: args.liteWriteStore,
            scope: tenancy.scope_key,
            patches,
            commitId,
            errorLabel: "memory_suppression",
          }),
      };
    },
  });
  return result.value;
}
