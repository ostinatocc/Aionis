import type { Db } from "../db.js";
import { withClient, withTx } from "../db.js";

export type MemoryRequestTelemetryInput = {
  tenant_id: string;
  scope: string;
  endpoint: "write" | "recall" | "recall_text" | "planning_context" | "context_assemble";
  status_code: number;
  latency_ms: number;
  api_key_prefix?: string | null;
  request_id?: string | null;
};

export type ContextAssemblyLayerName = "facts" | "episodes" | "rules" | "decisions" | "tools" | "citations";

export type MemoryContextAssemblyLayerTelemetryInput = {
  layer_name: ContextAssemblyLayerName;
  source_count: number;
  kept_count: number;
  dropped_count: number;
  budget_chars: number;
  used_chars: number;
  max_items: number;
};

export type MemoryContextAssemblyTelemetryInput = {
  tenant_id: string;
  scope: string;
  endpoint: "planning_context" | "context_assemble";
  layered_output: boolean;
  latency_ms: number;
  request_id?: string | null;
  total_budget_chars: number;
  used_chars: number;
  remaining_chars: number;
  source_items: number;
  kept_items: number;
  dropped_items: number;
  layers_with_content: number;
  merge_trace_included: boolean;
  selection_policy_name?: string | null;
  selection_policy_source?: string | null;
  selected_memory_layers?: string[];
  trust_anchor_layers?: string[];
  requested_allowed_layers?: string[];
  layers: MemoryContextAssemblyLayerTelemetryInput[];
};

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const item of value) {
    const normalized = trimOrNull(item);
    if (normalized) out.push(normalized);
  }
  return out.length > 0 ? out : fallback;
}

function boundedInt(input: number, max = 10_000_000): number {
  if (!Number.isFinite(input)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(input)));
}

function boundedMs(input: number): number {
  if (!Number.isFinite(input)) return 0;
  return Math.max(0, input);
}

export async function recordMemoryRequestTelemetry(db: Db, input: MemoryRequestTelemetryInput): Promise<void> {
  const tenantId = trimOrNull(input.tenant_id);
  const scope = trimOrNull(input.scope);
  const endpoint = trimOrNull(input.endpoint);
  if (!tenantId || !scope || !endpoint) return;
  const statusCode = Number.isFinite(input.status_code) ? Math.trunc(input.status_code) : 0;
  const latencyMs = Number.isFinite(input.latency_ms) ? Math.max(0, input.latency_ms) : 0;
  const apiKeyPrefix = trimOrNull(input.api_key_prefix);
  const requestId = trimOrNull(input.request_id);
  try {
    await withClient(db, async (client) => {
      await client.query(
        `
        INSERT INTO memory_request_telemetry (
          tenant_id, scope, endpoint, status_code, latency_ms, api_key_prefix, request_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [tenantId, scope, endpoint, statusCode, latencyMs, apiKeyPrefix, requestId],
      );
    });
  } catch (err: any) {
    const code = String(err?.code ?? "");
    if (code === "42P01") return;
    if (code === "23514" && (endpoint === "planning_context" || endpoint === "context_assemble")) return;
    throw err;
  }
}

export async function recordMemoryContextAssemblyTelemetry(
  db: Db,
  input: MemoryContextAssemblyTelemetryInput,
): Promise<void> {
  const tenantId = trimOrNull(input.tenant_id);
  const scope = trimOrNull(input.scope);
  const endpoint = trimOrNull(input.endpoint);
  if (!tenantId || !scope) return;
  if (endpoint !== "planning_context" && endpoint !== "context_assemble") return;

  const requestId = trimOrNull(input.request_id);
  const layeredOutput = input.layered_output === true;
  const totalBudgetChars = boundedInt(input.total_budget_chars);
  const usedChars = boundedInt(input.used_chars);
  const remainingChars = boundedInt(input.remaining_chars);
  const sourceItems = boundedInt(input.source_items);
  const keptItems = boundedInt(input.kept_items);
  const droppedItems = boundedInt(input.dropped_items);
  const layersWithContent = boundedInt(input.layers_with_content, 10_000);
  const mergeTraceIncluded = input.merge_trace_included === true;
  const latencyMs = boundedMs(input.latency_ms);
  const selectionPolicyName = trimOrNull(input.selection_policy_name);
  const selectionPolicySourceRaw = trimOrNull(input.selection_policy_source);
  const selectionPolicySource =
    selectionPolicySourceRaw === "endpoint_default" || selectionPolicySourceRaw === "request_override"
      ? selectionPolicySourceRaw
      : null;
  const selectedMemoryLayers = asStringArray(input.selected_memory_layers, []).filter((layer) =>
    ["L0", "L1", "L2", "L3", "L4", "L5"].includes(layer),
  );
  const trustAnchorLayers = asStringArray(input.trust_anchor_layers, []).filter((layer) =>
    ["L0", "L1", "L2", "L3", "L4", "L5"].includes(layer),
  );
  const requestedAllowedLayers = asStringArray(input.requested_allowed_layers, []).filter((layer) =>
    ["L0", "L1", "L2", "L3", "L4", "L5"].includes(layer),
  );
  const selectedMemoryLayersJson = JSON.stringify(selectedMemoryLayers);
  const trustAnchorLayersJson = JSON.stringify(trustAnchorLayers);
  const requestedAllowedLayersJson = JSON.stringify(requestedAllowedLayers);
  const headInsertSavepoint = "memory_context_assembly_head_insert_sp";

  const layers = (Array.isArray(input.layers) ? input.layers : [])
    .map((layer) => ({
      layer_name: layer.layer_name,
      source_count: boundedInt(layer.source_count),
      kept_count: boundedInt(layer.kept_count),
      dropped_count: boundedInt(layer.dropped_count),
      budget_chars: boundedInt(layer.budget_chars),
      used_chars: boundedInt(layer.used_chars),
      max_items: boundedInt(layer.max_items, 10_000),
    }))
    .filter((layer) => ["facts", "episodes", "rules", "decisions", "tools", "citations"].includes(layer.layer_name));

  try {
    await withTx(db, async (client) => {
      const attempts: Array<{ sql: string; params: unknown[] }> = [
        {
          sql: `
            INSERT INTO memory_context_assembly_telemetry (
              tenant_id, scope, endpoint, layered_output, request_id,
              total_budget_chars, used_chars, remaining_chars,
              source_items, kept_items, dropped_items, layers_with_content,
              merge_trace_included, selection_policy_name, selection_policy_source,
              selected_memory_layers_json, trust_anchor_layers_json, requested_allowed_layers_json,
              latency_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            RETURNING id
          `,
          params: [
            tenantId, scope, endpoint, layeredOutput, requestId,
            totalBudgetChars, usedChars, remainingChars,
            sourceItems, keptItems, droppedItems, layersWithContent,
            mergeTraceIncluded, selectionPolicyName, selectionPolicySource,
            selectedMemoryLayersJson, trustAnchorLayersJson, requestedAllowedLayersJson,
            latencyMs,
          ],
        },
        {
          sql: `
            INSERT INTO memory_context_assembly_telemetry (
              tenant_id, scope, endpoint, layered_output, request_id,
              total_budget_chars, used_chars, remaining_chars,
              source_items, kept_items, dropped_items, layers_with_content,
              merge_trace_included, latency_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id
          `,
          params: [
            tenantId, scope, endpoint, layeredOutput, requestId,
            totalBudgetChars, usedChars, remainingChars,
            sourceItems, keptItems, droppedItems, layersWithContent,
            mergeTraceIncluded, latencyMs,
          ],
        },
        {
          sql: `
            INSERT INTO memory_context_assembly_telemetry (
              tenant_id, scope, endpoint, request_id,
              total_budget_chars, used_chars, remaining_chars,
              source_items, kept_items, dropped_items, layers_with_content,
              merge_trace_included, latency_ms
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id
          `,
          params: [
            tenantId, scope, endpoint, requestId,
            totalBudgetChars, usedChars, remainingChars,
            sourceItems, keptItems, droppedItems, layersWithContent,
            mergeTraceIncluded, latencyMs,
          ],
        },
      ];

      let telemetryId = 0;
      let lastError: unknown = null;
      for (const attempt of attempts) {
        await client.query(`SAVEPOINT ${headInsertSavepoint}`);
        try {
          const q = await client.query(attempt.sql, attempt.params);
          await client.query(`RELEASE SAVEPOINT ${headInsertSavepoint}`);
          telemetryId = Number(q.rows[0]?.id ?? 0);
          lastError = null;
          break;
        } catch (err: any) {
          await client.query(`ROLLBACK TO SAVEPOINT ${headInsertSavepoint}`);
          await client.query(`RELEASE SAVEPOINT ${headInsertSavepoint}`);
          if (String(err?.code ?? "") !== "42703") throw err;
          lastError = err;
        }
      }

      if (!Number.isFinite(telemetryId) || telemetryId <= 0) {
        if (lastError) throw lastError;
        return;
      }

      for (const layer of layers) {
        await client.query(
          `
          INSERT INTO memory_context_assembly_layer_telemetry (
            telemetry_id, tenant_id, scope, endpoint, layer_name,
            source_count, kept_count, dropped_count, budget_chars, used_chars, max_items
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            telemetryId,
            tenantId,
            scope,
            endpoint,
            layer.layer_name,
            layer.source_count,
            layer.kept_count,
            layer.dropped_count,
            layer.budget_chars,
            layer.used_chars,
            layer.max_items,
          ],
        );
      }
    });
  } catch (err: any) {
    if (String(err?.code ?? "") === "42P01") return;
    throw err;
  }
}
