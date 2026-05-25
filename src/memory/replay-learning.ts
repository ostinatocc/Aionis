import type pg from "pg";
import stableStringify from "fast-json-stable-stringify";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { EmbeddedMemoryRuntime } from "../store/embedded-memory-runtime.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { createPostgresWriteStoreAccess, type WriteStoreAccess } from "../store/write-access.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import {
  REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
  buildReplayLearningProjectionArtifacts,
  derivePreferredTools,
  deriveReplayLearningWorkflowSignature,
  type ReplayLearningProjectionArtifacts,
  type ReplayLearningProjectionSource,
} from "./replay-learning-artifacts.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import { resolveNodeWorkflowSignature } from "./node-execution-surface.js";
import { mirrorPreparedWriteToEmbeddedRuntime } from "./embedded-write-bridge.js";
import { updateRuleState } from "./rules.js";
import { buildAionisUri } from "./uri.js";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "./write.js";

export {
  REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
  buildReplayLearningProjectionArtifacts,
  deriveReplayLearningWorkflowSignature,
  type ReplayLearningProjectionArtifacts,
  type ReplayLearningProjectionSource,
} from "./replay-learning-artifacts.js";

type ReplayLearningProjectionMode = "rule_and_episode" | "episode_only";
type ReplayLearningProjectionDelivery = "async_outbox" | "sync_inline";
type ReplayLearningProjectionTargetRuleState = "draft" | "shadow";

export type ReplayLearningProjectionResolvedConfig = {
  enabled: boolean;
  mode: ReplayLearningProjectionMode;
  delivery: ReplayLearningProjectionDelivery;
  target_rule_state: ReplayLearningProjectionTargetRuleState;
  min_total_steps: number;
  min_success_ratio: number;
  max_matcher_bytes: number;
  max_tool_prefer: number;
  episode_ttl_days: number;
};

export type ReplayLearningWarning = {
  code: "overlapping_rules_detected" | "duplicate_rule_fingerprint_skipped" | "episode_gc_policy_attached";
  message: string;
  related_rule_node_ids?: string[];
};

export type ReplayLearningProjectionResult = {
  triggered: boolean;
  delivery: ReplayLearningProjectionDelivery;
  status: "queued" | "applied" | "skipped" | "failed";
  reason?: string;
  job_key?: string;
  generated_rule_node_id?: string;
  generated_rule_uri?: string;
  generated_episode_node_id?: string;
  generated_episode_uri?: string;
  generated_workflow_node_id?: string;
  generated_workflow_uri?: string;
  rule_state?: "draft" | "shadow";
  commit_id?: string;
  commit_uri?: string;
  warnings?: ReplayLearningWarning[];
};

type ReplayLearningWriteOptions = {
  defaultScope: string;
  defaultTenantId: string;
  maxTextLen: number;
  piiRedaction: boolean;
  allowCrossScopeEdges: boolean;
  shadowDualWriteEnabled: boolean;
  shadowDualWriteStrict: boolean;
  writeAccessShadowMirrorV2: boolean;
  embedder: EmbeddingProvider | null;
  embeddedRuntime?: EmbeddedMemoryRuntime | null;
  writeAccess?: WriteStoreAccess | null;
};

export type ReplayLearningProjectionPayload = {
  tenant_id: string;
  scope: string;
  scope_key: string;
  actor: string;
  playbook_id: string;
  playbook_version: number;
  source_commit_id: string | null;
  config: ReplayLearningProjectionResolvedConfig;
  fault_injection_mode?: "retryable_error" | "fatal_error";
};

type ExistingReplayLearningRule = {
  rule_node_id: string;
  matcher_fingerprint: string | null;
  policy_fingerprint: string | null;
  state: string | null;
};

type ExistingReplayLearningEpisode = {
  node_id: string;
};

function asLiteReplayLearningStore(writeAccess?: WriteStoreAccess | null): LiteWriteStore | null {
  if (
    !writeAccess
    || typeof (writeAccess as LiteWriteStore).findNodes !== "function"
    || typeof (writeAccess as LiteWriteStore).getRuleDef !== "function"
    || typeof (writeAccess as LiteWriteStore).insertOutboxEvent !== "function"
    || typeof (writeAccess as LiteWriteStore).updateNodeAnchorState !== "function"
  ) {
    return null;
  }
  return writeAccess as LiteWriteStore;
}

function requirePostgresClient(client: pg.PoolClient | null, context: string): pg.PoolClient {
  if (!client) {
    throw new Error(`${context} requires a postgres client when no lite write access is provided`);
  }
  return client;
}

function projectionWriteAccessForClient(
  client: pg.PoolClient | null,
  writeOpts: ReplayLearningWriteOptions,
): WriteStoreAccess {
  const writeAccess = writeOpts.writeAccess ?? (
    client
      ? createPostgresWriteStoreAccess(client, {
          capabilities: { shadow_mirror_v2: writeOpts.writeAccessShadowMirrorV2 },
        })
      : null
  );
  if (!writeAccess) {
    throw new Error("replay learning projection requires writeAccess when no postgres client is provided");
  }
  return writeAccess;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function normalizeRuleState(raw: unknown): "draft" | "shadow" {
  return raw === "shadow" ? "shadow" : "draft";
}

function parseTotalSteps(slots: Record<string, unknown>, sourceMetrics?: { total_steps?: number }): number {
  const fromMetrics = Number(sourceMetrics?.total_steps ?? NaN);
  if (Number.isFinite(fromMetrics)) return Math.max(0, Math.trunc(fromMetrics));
  const steps = Array.isArray(slots.steps_template) ? slots.steps_template.length : 0;
  return Math.max(0, Math.trunc(steps));
}

function parseSuccessRatio(sourceMetrics?: { success_ratio?: number }): number {
  const ratio = Number(sourceMetrics?.success_ratio ?? NaN);
  if (!Number.isFinite(ratio)) return 1;
  return Math.max(0, Math.min(1, ratio));
}

function fingerprintJson(v: unknown): string {
  return sha256Hex(stableStringify(v ?? {}));
}

async function listExistingReplayLearningRules(
  client: pg.PoolClient | null,
  scope: string,
  playbookId: string,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<ExistingReplayLearningRule[]> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (liteWriteStore) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      type: "rule",
      slotsContains: {
        replay_learning: {
          generated_by: "replay_learning_v1",
          source_playbook_id: playbookId,
        },
      },
      consumerAgentId: consumerAgentId ?? null,
      consumerTeamId: consumerTeamId ?? null,
      limit: 200,
      offset: 0,
    });
    const out: ExistingReplayLearningRule[] = [];
    for (const row of rows) {
      const slots = asObject(row.slots) ?? {};
      const replayLearning = asObject(slots.replay_learning) ?? {};
      const ruleDef = await liteWriteStore.getRuleDef(scope, row.id);
      out.push({
        rule_node_id: row.id,
        matcher_fingerprint: toStringOrNull(replayLearning.matcher_fingerprint),
        policy_fingerprint: toStringOrNull(replayLearning.policy_fingerprint),
        state: ruleDef?.state ?? null,
      });
    }
    return out;
  }
  const out = await requirePostgresClient(client, "list existing replay learning rules").query<{
    rule_node_id: string;
    matcher_fingerprint: string | null;
    policy_fingerprint: string | null;
    state: string | null;
  }>(
    `
    SELECT
      n.id::text AS rule_node_id,
      nullif(trim(coalesce(n.slots->'replay_learning'->>'matcher_fingerprint', '')), '') AS matcher_fingerprint,
      nullif(trim(coalesce(n.slots->'replay_learning'->>'policy_fingerprint', '')), '') AS policy_fingerprint,
      d.state::text AS state
    FROM memory_nodes n
    LEFT JOIN memory_rule_defs d
      ON d.scope = n.scope
     AND d.rule_node_id = n.id
    WHERE n.scope = $1
      AND n.type = 'rule'::memory_node_type
      AND coalesce(n.slots->'replay_learning'->>'generated_by', '') = 'replay_learning_v1'
      AND coalesce(n.slots->'replay_learning'->>'source_playbook_id', '') = $2
    ORDER BY n.created_at DESC
    LIMIT 200
    `,
    [scope, playbookId],
  );
  return out.rows.map((row) => ({
    rule_node_id: row.rule_node_id,
    matcher_fingerprint: row.matcher_fingerprint,
    policy_fingerprint: row.policy_fingerprint,
    state: row.state,
  }));
}

async function findExistingReplayLearningEpisode(
  client: pg.PoolClient | null,
  scope: string,
  playbookId: string,
  playbookVersion: number,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<ExistingReplayLearningEpisode | null> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (liteWriteStore) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      type: "event",
      slotsContains: {
        replay_learning_episode: true,
        replay_learning: {
          source_playbook_id: playbookId,
          source_playbook_version: playbookVersion,
        },
      },
      consumerAgentId: consumerAgentId ?? null,
      consumerTeamId: consumerTeamId ?? null,
      limit: 1,
      offset: 0,
    });
    const row = rows[0];
    return row ? { node_id: row.id } : null;
  }
  const out = await requirePostgresClient(client, "find existing replay learning episode").query<{ node_id: string }>(
    `
    SELECT n.id::text AS node_id
    FROM memory_nodes n
    WHERE n.scope = $1
      AND n.type = 'event'::memory_node_type
      AND coalesce(n.slots->>'replay_learning_episode', '') = 'true'
      AND coalesce(n.slots->'replay_learning'->>'source_playbook_id', '') = $2
      AND coalesce(n.slots->'replay_learning'->>'source_playbook_version', '') = $3
    ORDER BY n.created_at DESC
    LIMIT 1
    `,
    [scope, playbookId, String(playbookVersion)],
  );
  if ((out.rowCount ?? 0) < 1) return null;
  return { node_id: out.rows[0].node_id };
}

async function countReplayLearningWorkflowObservations(
  client: pg.PoolClient | null,
  scope: string,
  playbookId: string,
  workflowSignature: string,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<number> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (liteWriteStore) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      type: "event",
      slotsContains: {
        replay_learning_episode: true,
        replay_learning: {
          source_playbook_id: playbookId,
        },
      },
      consumerAgentId: consumerAgentId ?? null,
      consumerTeamId: consumerTeamId ?? null,
      limit: 200,
      offset: 0,
    });
    const observedVersions = new Set<string>();
    for (const row of rows) {
      const slots = asObject(row.slots) ?? {};
      const replayLearning = asObject(slots.replay_learning) ?? {};
      if (resolveNodeWorkflowSignature({ slots }) !== workflowSignature) continue;
      const versionValue = replayLearning.source_playbook_version;
      const versionKey = typeof versionValue === "number"
        ? String(Math.trunc(versionValue))
        : toStringOrNull(versionValue);
      if (versionKey) observedVersions.add(versionKey);
    }
    return observedVersions.size;
  }
  const out = await requirePostgresClient(client, "count replay learning workflow observations").query<{ observed_count: string | number | null }>(
    `
    SELECT COUNT(DISTINCT nullif(trim(coalesce(n.slots->'replay_learning'->>'source_playbook_version', '')), ''))::text AS observed_count
    FROM memory_nodes n
    WHERE n.scope = $1
      AND n.type = 'event'::memory_node_type
      AND coalesce(n.slots->>'replay_learning_episode', '') = 'true'
      AND coalesce(n.slots->'replay_learning'->>'source_playbook_id', '') = $2
      AND coalesce(n.slots->'execution_contract_v1'->>'workflow_signature', '') = $3
    `,
    [scope, playbookId, workflowSignature],
  );
  const raw = Number(out.rows[0]?.observed_count ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.trunc(raw));
}

export function classifyReplayLearningProjectionError(err: unknown): {
  error_class: "retryable" | "fatal";
  error_code: string;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError) {
    const fatal = new Set([
      "replay_learning_matcher_too_large",
      "replay_learning_invalid_matchers",
      "replay_learning_invalid_policy_patch",
      "replay_learning_playbook_not_found",
      "replay_learning_playbook_version_not_found",
      "replay_learning_injected_fatal",
    ]);
    return {
      error_class: fatal.has(err.code) ? "fatal" : "retryable",
      error_code: err.code,
      message,
    };
  }
  if (/invalid|schema|zod|matchers|too_large|too large/i.test(message)) {
    return { error_class: "fatal", error_code: "replay_learning_invalid_payload", message };
  }
  return { error_class: "retryable", error_code: "replay_learning_projection_failed", message };
}

export async function enqueueReplayLearningProjectionOutbox(
  client: pg.PoolClient | null,
  input: {
    scopeKey: string;
    commitId: string;
    payload: ReplayLearningProjectionPayload;
    writeAccess?: WriteStoreAccess | null;
  },
): Promise<{ job_key: string }> {
  const payloadJson = stableStringify(input.payload);
  const payloadSha = sha256Hex(payloadJson);
  const jobKey = sha256Hex(
    stableStringify({
      v: 1,
      scope: input.scopeKey,
      event_type: "replay_learning_projection",
      playbook_id: input.payload.playbook_id,
      playbook_version: input.payload.playbook_version,
      source_commit_id: input.payload.source_commit_id ?? "",
      payload_sha256: payloadSha,
    }),
  );
  if (input.writeAccess) {
    await input.writeAccess.insertOutboxEvent({
      scope: input.scopeKey,
      commitId: input.commitId,
      eventType: "replay_learning_projection",
      jobKey,
      payloadSha256: payloadSha,
      payloadJson,
    });
  } else {
    await requirePostgresClient(client, "enqueue replay learning projection outbox").query(
      `INSERT INTO memory_outbox (scope, commit_id, event_type, job_key, payload_sha256, payload)
       VALUES ($1, $2, 'replay_learning_projection', $3, $4, $5::jsonb)
       ON CONFLICT (scope, event_type, job_key) DO NOTHING`,
      [input.scopeKey, input.commitId, jobKey, payloadSha, payloadJson],
    );
  }
  return { job_key: jobKey };
}

async function loadReplayPlaybookNode(
  client: pg.PoolClient | null,
  scopeKey: string,
  playbookId: string,
  version: number,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<{
  playbook_node_id: string;
  title: string | null;
  text_summary: string | null;
  slots: Record<string, unknown>;
} | null> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (liteWriteStore) {
    const { rows } = await liteWriteStore.findNodes({
      scope: scopeKey,
      type: "procedure",
      slotsContains: {
        replay_kind: "playbook",
        playbook_id: playbookId,
        version,
      },
      consumerAgentId: consumerAgentId ?? null,
      consumerTeamId: consumerTeamId ?? null,
      limit: 1,
      offset: 0,
    });
    const row = rows[0];
    if (!row) return null;
    return {
      playbook_node_id: row.id,
      title: row.title,
      text_summary: row.text_summary,
      slots: asObject(row.slots) ?? {},
    };
  }
  const out = await requirePostgresClient(client, "load replay playbook node").query<{
    playbook_node_id: string;
    title: string | null;
    text_summary: string | null;
    slots: unknown;
  }>(
    `
    SELECT
      id::text AS playbook_node_id,
      title,
      text_summary,
      slots
    FROM memory_nodes
    WHERE scope = $1
      AND slots->>'replay_kind' = 'playbook'
      AND slots->>'playbook_id' = $2
      AND (
        CASE
          WHEN coalesce(slots->>'version', '') ~ '^[0-9]+$' THEN (slots->>'version')::int
          ELSE 1
        END
      ) = $3
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [scopeKey, playbookId, version],
  );
  if ((out.rowCount ?? 0) < 1) return null;
  const row = out.rows[0];
  return {
    playbook_node_id: row.playbook_node_id,
    title: row.title,
    text_summary: row.text_summary,
    slots: asObject(row.slots) ?? {},
  };
}

export async function applyReplayLearningProjectionFromPayload(
  client: pg.PoolClient | null,
  payload: ReplayLearningProjectionPayload,
  writeOpts: ReplayLearningWriteOptions,
): Promise<ReplayLearningProjectionResult> {
  if (process.env.REPLAY_LEARNING_FAULT_INJECTION_ENABLED === "true") {
    if (payload.fault_injection_mode === "retryable_error") {
      throw new Error("replay_learning_injected_retryable");
    }
    if (payload.fault_injection_mode === "fatal_error") {
      throw new HttpError(
        400,
        "replay_learning_injected_fatal",
        "replay learning injected fatal fault for smoke validation",
      );
    }
  }
  const loaded = await loadReplayPlaybookNode(
    client,
    payload.scope_key,
    payload.playbook_id,
    payload.playbook_version,
    writeOpts.writeAccess,
    payload.actor,
    null,
  );
  if (!loaded) {
    throw new HttpError(
      404,
      "replay_learning_playbook_version_not_found",
      "replay learning projection source playbook version is not found",
      {
        playbook_id: payload.playbook_id,
        playbook_version: payload.playbook_version,
        scope: payload.scope,
      },
    );
  }
  return await applyReplayLearningProjection(
    client,
    {
      tenant_id: payload.tenant_id,
      scope: payload.scope,
      scope_key: payload.scope_key,
      actor: payload.actor,
      playbook_id: payload.playbook_id,
      playbook_version: payload.playbook_version,
      playbook_node_id: loaded.playbook_node_id,
      playbook_title: loaded.title,
      playbook_summary: loaded.text_summary,
      playbook_slots: loaded.slots,
      source_commit_id: payload.source_commit_id,
    },
    payload.config,
    writeOpts,
  );
}

export async function applyReplayLearningProjection(
  client: pg.PoolClient | null,
  source: ReplayLearningProjectionSource,
  config: ReplayLearningProjectionResolvedConfig,
  writeOpts: ReplayLearningWriteOptions,
): Promise<ReplayLearningProjectionResult> {
  if (!config.enabled) {
    return {
      triggered: false,
      delivery: config.delivery,
      status: "skipped",
      reason: "learning_projection_disabled",
    };
  }

  const totalSteps = parseTotalSteps(source.playbook_slots, source.metrics);
  if (totalSteps < config.min_total_steps) {
    return {
      triggered: false,
      delivery: config.delivery,
      status: "skipped",
      reason: "min_total_steps_not_met",
    };
  }
  const successRatio = parseSuccessRatio(source.metrics);
  if (successRatio < config.min_success_ratio) {
    return {
      triggered: false,
      delivery: config.delivery,
      status: "skipped",
      reason: "min_success_ratio_not_met",
    };
  }

  const warnings: ReplayLearningWarning[] = [];
  const workflowSignature = deriveReplayLearningWorkflowSignature(source.playbook_id, source.playbook_slots);
  const matchers = asObject(source.playbook_slots.matchers) ?? {};
  const matcherJson = stableStringify(matchers);
  if (Buffer.byteLength(matcherJson, "utf8") > config.max_matcher_bytes) {
    throw new HttpError(400, "replay_learning_matcher_too_large", "replay learning matchers exceed max bytes", {
      max_matcher_bytes: config.max_matcher_bytes,
      actual_matcher_bytes: Buffer.byteLength(matcherJson, "utf8"),
    });
  }
  const matcherFingerprint = fingerprintJson(matchers);

  const preferTools = derivePreferredTools(source.playbook_slots, config.max_tool_prefer);
  const thenPatch = {
    tool: {
      prefer: preferTools,
    },
    extensions: {
      replay: {
        source: "replay_learning_v1",
        playbook_id: source.playbook_id,
        playbook_version: source.playbook_version,
      },
    },
  };
  const policyFingerprint = fingerprintJson(thenPatch);
  const liteWriteStore = asLiteReplayLearningStore(writeOpts.writeAccess);
  const existingRulesByScope = await listExistingReplayLearningRules(
    client,
    source.scope_key,
    source.playbook_id,
    writeOpts.writeAccess,
    source.actor,
    null,
  );
  const duplicateRule = existingRulesByScope.find(
    (r) => r.matcher_fingerprint === matcherFingerprint && r.policy_fingerprint === policyFingerprint,
  );
  const overlapping = existingRulesByScope
    .filter((r) => r.matcher_fingerprint === matcherFingerprint && r.policy_fingerprint !== policyFingerprint)
    .map((r) => r.rule_node_id);

  if (duplicateRule) {
    warnings.push({
      code: "duplicate_rule_fingerprint_skipped",
      message: "duplicate replay-learning rule fingerprint detected; new rule projection skipped",
      related_rule_node_ids: [duplicateRule.rule_node_id],
    });
  }
  if (overlapping.length > 0) {
    warnings.push({
      code: "overlapping_rules_detected",
      message: "overlapping replay-learning rules detected for this playbook matcher",
      related_rule_node_ids: overlapping.slice(0, 20),
    });
  }

  const existingEpisode = await findExistingReplayLearningEpisode(
    client,
    source.scope_key,
    source.playbook_id,
    source.playbook_version,
    writeOpts.writeAccess,
    source.actor,
    null,
  );

  const shouldCreateRule = config.mode === "rule_and_episode" && !duplicateRule && preferTools.length > 0;
  const shouldCreateEpisode = !existingEpisode;
  if (config.mode === "rule_and_episode" || config.mode === "episode_only") {
    warnings.push({
      code: "episode_gc_policy_attached",
      message: "replay-learning episode is attached with lifecycle and archive policy metadata",
    });
  }

  let generatedRuleNodeId: string | undefined;
  let generatedEpisodeNodeId: string | undefined;
  let generatedWorkflowNodeId: string | undefined;
  let commitId: string | undefined;
  let commitUri: string | undefined;
  const observedWorkflowCountBeforeWrite = await countReplayLearningWorkflowObservations(
    client,
    source.scope_key,
    source.playbook_id,
    workflowSignature,
    writeOpts.writeAccess,
    source.actor,
    null,
  );
  const observedWorkflowCount = observedWorkflowCountBeforeWrite + (shouldCreateEpisode ? 1 : 0);
  const shouldPromoteStableWorkflow =
    shouldCreateEpisode && observedWorkflowCount >= REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS;

  if (duplicateRule) generatedRuleNodeId = duplicateRule.rule_node_id;
  if (existingEpisode) generatedEpisodeNodeId = existingEpisode.node_id;

  const ttlExpiresAt = new Date(Date.now() + clampInt(config.episode_ttl_days, 1, 3650) * 24 * 3600 * 1000).toISOString();
  const projectedAt = new Date().toISOString();
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint,
    policyFingerprint,
    duplicateRuleNodeId: duplicateRule?.rule_node_id ?? null,
    workflowSignature,
    preferTools,
    shouldCreateRule,
    shouldCreateEpisode,
    shouldPromoteStableWorkflow,
    observedWorkflowCount,
    projectedAt,
    ttlExpiresAt,
  });
  const { ruleClientId, episodeClientId, workflowClientId, nodes, edges } = plan;

  if (nodes.length > 0) {
    const writeReq = {
      tenant_id: source.tenant_id,
      scope: source.scope,
      actor: source.actor || "replay_learning_projection",
      input_text: `replay learning projection for ${source.playbook_id} v${source.playbook_version}`,
      auto_embed: false,
      memory_lane: "private" as const,
      producer_agent_id: source.actor || "replay_learning_projection",
      owner_agent_id: source.actor || "replay_learning_projection",
      nodes,
      edges,
    };
    const prepared = await prepareMemoryWrite(
      writeReq,
      writeOpts.defaultScope,
      writeOpts.defaultTenantId,
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
      writeOpts.embedder,
    );
    const out = await applyPreparedMemoryWrite(projectionWriteAccessForClient(client, writeOpts), prepared, {
      maxTextLen: writeOpts.maxTextLen,
      piiRedaction: writeOpts.piiRedaction,
      allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      shadowDualWriteEnabled: writeOpts.shadowDualWriteEnabled,
      shadowDualWriteStrict: writeOpts.shadowDualWriteStrict,
    });
    await mirrorPreparedWriteToEmbeddedRuntime({ embeddedRuntime: writeOpts.embeddedRuntime, prepared, out });
    const createdRule = out.nodes.find((n) => n.client_id === ruleClientId);
    const createdEpisode = out.nodes.find((n) => n.client_id === episodeClientId);
    const createdWorkflow = out.nodes.find((n) => n.client_id === workflowClientId);
    if (createdRule) generatedRuleNodeId = createdRule.id;
    if (createdEpisode) generatedEpisodeNodeId = createdEpisode.id;
    if (createdWorkflow) generatedWorkflowNodeId = createdWorkflow.id;
    commitId = out.commit_id;
    commitUri = out.commit_uri ?? buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "commit", id: out.commit_id });
  }

  let finalRuleState: "draft" | "shadow" = "draft";
  if (generatedRuleNodeId && config.target_rule_state === "shadow") {
    const stateOut = await updateRuleState(
      client,
      {
        tenant_id: source.tenant_id,
        scope: source.scope,
        actor: source.actor || "replay_learning_projection",
        rule_node_id: generatedRuleNodeId,
        state: "shadow",
        input_text: `promote replay learning rule to shadow ${source.playbook_id} v${source.playbook_version}`,
      },
      writeOpts.defaultScope,
      writeOpts.defaultTenantId,
      { embeddedRuntime: writeOpts.embeddedRuntime, liteWriteStore },
    );
    finalRuleState = "shadow";
    commitId = stateOut.commit_id;
    commitUri = buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "commit", id: stateOut.commit_id });
  }

  if (generatedRuleNodeId && generatedEpisodeNodeId) {
    if (liteWriteStore) {
      const episodeNode = await liteWriteStore.resolveNode({
        scope: source.scope_key,
        id: generatedEpisodeNodeId,
        type: "event",
        consumerAgentId: source.actor,
        consumerTeamId: null,
      });
      if (episodeNode) {
        const lifecycle = resolveNodeLifecycleSignals({
          type: episodeNode.type,
          tier: episodeNode.tier,
          title: episodeNode.title,
          text_summary: episodeNode.text_summary,
          slots: {
            ...(asObject(episodeNode.slots) ?? {}),
            source_rule_node_id: generatedRuleNodeId,
            replay_learning: {
              ...(asObject(asObject(episodeNode.slots)?.replay_learning) ?? {}),
              source_rule_node_id: generatedRuleNodeId,
            },
          },
          salience: episodeNode.salience,
          importance: episodeNode.importance,
          confidence: episodeNode.confidence,
          raw_ref: episodeNode.raw_ref ?? null,
          evidence_ref: episodeNode.evidence_ref ?? null,
        });
        await liteWriteStore.updateNodeAnchorState({
          scope: source.scope_key,
          id: generatedEpisodeNodeId,
          slots: lifecycle.slots,
          textSummary: episodeNode.text_summary,
          salience: lifecycle.salience,
          importance: lifecycle.importance,
          confidence: lifecycle.confidence,
          commitId: commitId ?? null,
        });
      }
    } else {
      await requirePostgresClient(client, "attach replay learning source rule").query(
        `
        UPDATE memory_nodes n
        SET slots =
          jsonb_set(
            jsonb_set(
              coalesce(n.slots, '{}'::jsonb),
              '{source_rule_node_id}',
              to_jsonb($2::text),
              true
            ),
            '{replay_learning,source_rule_node_id}',
            to_jsonb($2::text),
            true
          )
        WHERE n.id = $1::uuid
        `,
        [generatedEpisodeNodeId, generatedRuleNodeId],
      );
    }
  }

  const ruleUri =
    generatedRuleNodeId != null
      ? buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "rule", id: generatedRuleNodeId })
      : undefined;
  const episodeUri =
    generatedEpisodeNodeId != null
      ? buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "event", id: generatedEpisodeNodeId })
      : undefined;
  const workflowUri =
    generatedWorkflowNodeId != null
      ? buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "procedure", id: generatedWorkflowNodeId })
      : undefined;

  if (!generatedRuleNodeId && !generatedEpisodeNodeId && !generatedWorkflowNodeId) {
    return {
      triggered: true,
      delivery: config.delivery,
      status: "skipped",
      reason: "already_projected",
      warnings,
    };
  }

  return {
    triggered: true,
    delivery: config.delivery,
    status: "applied",
    generated_rule_node_id: generatedRuleNodeId,
    generated_rule_uri: ruleUri,
    generated_episode_node_id: generatedEpisodeNodeId,
    generated_episode_uri: episodeUri,
    generated_workflow_node_id: generatedWorkflowNodeId,
    generated_workflow_uri: workflowUri,
    rule_state: generatedRuleNodeId ? normalizeRuleState(finalRuleState) : undefined,
    commit_id: commitId,
    commit_uri: commitUri,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function buildReplayLearningProjectionDefaults(input: {
  enabled: boolean;
  mode: ReplayLearningProjectionMode;
  delivery: ReplayLearningProjectionDelivery;
  targetRuleState: ReplayLearningProjectionTargetRuleState;
  minTotalSteps: number;
  minSuccessRatio: number;
  maxMatcherBytes: number;
  maxToolPrefer: number;
  episodeTtlDays: number;
}): ReplayLearningProjectionResolvedConfig {
  return {
    enabled: input.enabled,
    mode: input.mode,
    delivery: input.delivery,
    target_rule_state: input.targetRuleState,
    min_total_steps: clampInt(input.minTotalSteps, 0, 500),
    min_success_ratio: Math.max(0, Math.min(1, Number(input.minSuccessRatio))),
    max_matcher_bytes: clampInt(input.maxMatcherBytes, 1, 1024 * 1024),
    max_tool_prefer: clampInt(input.maxToolPrefer, 1, 64),
    episode_ttl_days: clampInt(input.episodeTtlDays, 1, 3650),
  };
}
