import stableStringify from "fast-json-stable-stringify";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { runAppliedAuthorityMutationV2 } from "./applied-authority-mutation.js";
import {
  REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
  buildReplayLearningProjectionArtifacts,
  derivePreferredTools,
  deriveReplayLearningWorkflowSignature,
  type ReplayLearningProjectionArtifacts,
  type ReplayLearningProjectionSource,
} from "./replay-learning-artifacts.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import {
  NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
  applyNodeAuthorityPatchesV2,
  assertNodeDecisionRowMatchesAuthorityState,
  buildNodeAuthorityMutationV2,
  captureNodeAuthorityHeadFence,
  verifyNodeAuthorityPatchesV2,
  type NodeAuthorityPatchV2,
} from "./node-authority-mutation.js";
import { resolveNodeWorkflowSignature } from "./node-execution-surface.js";
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
type ReplayLearningProjectionDelivery = "sync_inline";
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
  status: "applied" | "skipped" | "failed";
  reason?: string;
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
  embedder: EmbeddingProvider | null;
  writeAccess?: WriteStoreAccess | null;
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
    || typeof (writeAccess as LiteWriteStore).updateNodeAnchorState !== "function"
  ) {
    return null;
  }
  return writeAccess as LiteWriteStore;
}

function projectionWriteAccessForClient(
  writeOpts: ReplayLearningWriteOptions,
): WriteStoreAccess {
  const writeAccess = writeOpts.writeAccess ?? null;
  if (!writeAccess) {
    throw new Error("replay learning projection requires explicit writeAccess");
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

async function attachReplayLearningSourceRule(args: {
  store: LiteWriteStore;
  source: ReplayLearningProjectionSource;
  episodeNodeId: string;
  ruleNodeId: string;
}) {
  const actor = args.source.actor || "replay_learning_projection";
  const headFence = await captureNodeAuthorityHeadFence(args.store, args.source.scope_key, {});
  return await runAppliedAuthorityMutationV2<void>({
    store: args.store,
    scope: args.source.scope_key,
    inputSha256: sha256Hex(stableStringify({
      operation: "replay_learning_source_rule_attachment_v2",
      scope: args.source.scope_key,
      episode_node_id: args.episodeNodeId,
      rule_node_id: args.ruleNodeId,
      source_playbook_id: args.source.playbook_id,
      source_playbook_version: args.source.playbook_version,
    })),
    actor,
    expectedHeadRevision: headFence.expectedHeadRevision,
    expectedHeadCommitId: headFence.expectedHeadCommitId,
    plan: async ({ appliedAt }) => {
      const episodeRows = await args.store.findNodes({
        scope: args.source.scope_key,
        id: args.episodeNodeId,
        type: "event",
        consumerAgentId: actor,
        consumerTeamId: null,
        limit: 1,
        offset: 0,
      });
      const ruleRows = await args.store.findNodes({
        scope: args.source.scope_key,
        id: args.ruleNodeId,
        type: "rule",
        consumerAgentId: actor,
        consumerTeamId: null,
        limit: 1,
        offset: 0,
      });
      const episode = episodeRows.rows[0] ?? null;
      const rule = ruleRows.rows[0] ?? null;
      if (!episode || !rule) {
        throw new HttpError(
          404,
          "replay_learning_attachment_target_not_found",
          "replay learning episode or source rule was not found in this scope/visibility",
          {
            episode_node_id: args.episodeNodeId,
            rule_node_id: args.ruleNodeId,
            scope: args.source.scope_key,
          },
        );
      }

      const states = await args.store.nodeStatesByIds(args.source.scope_key, [episode.id, rule.id]);
      const episodeState = states.get(episode.id);
      const ruleState = states.get(rule.id);
      if (!episodeState || !ruleState) {
        throw new Error("replay_learning_attachment_authority_target_missing");
      }
      assertNodeDecisionRowMatchesAuthorityState(
        episode, episodeState, "replay_learning_attachment_episode_state_changed",
      );
      assertNodeDecisionRowMatchesAuthorityState(rule, ruleState, "replay_learning_attachment_rule_state_changed");

      const episodeSlots = asObject(episode.slots) ?? {};
      const episodeLearning = asObject(episodeSlots.replay_learning) ?? {};
      const ruleLearning = asObject(rule.slots?.replay_learning) ?? {};
      const samePlaybook =
        episodeSlots.replay_learning_episode === true
        && episodeLearning.generated_by === "replay_learning_v1"
        && episodeLearning.source_playbook_id === args.source.playbook_id
        && Number(episodeLearning.source_playbook_version) === args.source.playbook_version
        && ruleLearning.generated_by === "replay_learning_v1"
        && ruleLearning.source_playbook_id === args.source.playbook_id;
      if (!samePlaybook) {
        throw new HttpError(
          409,
          "replay_learning_attachment_target_changed",
          "replay learning attachment targets no longer match the requested playbook",
          {
            episode_node_id: episode.id,
            rule_node_id: rule.id,
            source_playbook_id: args.source.playbook_id,
            source_playbook_version: args.source.playbook_version,
          },
        );
      }

      if (
        episodeSlots.source_rule_node_id === rule.id
        && episodeLearning.source_rule_node_id === rule.id
      ) {
        return { status: "no_op" as const, value: undefined };
      }

      const lifecycle = resolveNodeLifecycleSignals({
        type: episode.type,
        tier: episode.tier,
        title: episode.title,
        text_summary: episode.text_summary,
        slots: {
          ...episodeSlots,
          source_rule_node_id: rule.id,
          replay_learning: {
            ...episodeLearning,
            source_rule_node_id: rule.id,
          },
        },
        salience: episode.salience,
        importance: episode.importance,
        confidence: episode.confidence,
        raw_ref: episode.raw_ref ?? null,
        evidence_ref: episode.evidence_ref ?? null,
        reference_time: appliedAt,
      });
      const patch: NodeAuthorityPatchV2 = {
        id: episode.id,
        slots: lifecycle.slots,
        textSummary: episode.text_summary,
        salience: lifecycle.salience,
        importance: lifecycle.importance,
        confidence: lifecycle.confidence,
      };
      return {
        status: "mutate" as const,
        authorityKind: "replay_learning_source_rule_attachment",
        mutations: [buildNodeAuthorityMutationV2({
          before: episodeState,
          patch,
          requestedEvidence: {
            side_effects: NODE_AUTHORITY_UPDATE_SIDE_EFFECTS,
            operation_context: {
              source_playbook_id: args.source.playbook_id,
              source_playbook_version: args.source.playbook_version,
              episode_node_id: episode.id,
              rule_node_id: rule.id,
            },
          },
        })],
        apply: async ({ commitId }) => {
          await applyNodeAuthorityPatchesV2({
            store: args.store,
            scope: args.source.scope_key,
            patches: [patch],
            commitId,
          });
        },
        verify: async ({ commitId }) => verifyNodeAuthorityPatchesV2({
          store: args.store,
          scope: args.source.scope_key,
          patches: [patch],
          commitId,
          errorLabel: "replay_learning_attachment",
        }),
      };
    },
  });
}

async function listExistingReplayLearningRules(
  scope: string,
  playbookId: string,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<ExistingReplayLearningRule[]> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (!liteWriteStore) throw new Error("listExistingReplayLearningRules requires lite write store");
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

async function findExistingReplayLearningEpisode(
  scope: string,
  playbookId: string,
  playbookVersion: number,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<ExistingReplayLearningEpisode | null> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (!liteWriteStore) throw new Error("findExistingReplayLearningEpisode requires lite write store");
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

async function countReplayLearningWorkflowObservations(
  scope: string,
  playbookId: string,
  workflowSignature: string,
  writeAccess?: WriteStoreAccess | null,
  consumerAgentId?: string | null,
  consumerTeamId?: string | null,
): Promise<number> {
  const liteWriteStore = asLiteReplayLearningStore(writeAccess);
  if (!liteWriteStore) throw new Error("countReplayLearningWorkflowObservations requires lite write store");
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

export async function applyReplayLearningProjection(
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
    if (!liteWriteStore) throw new Error("replay learning projection requires lite write store");
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
    const out = await liteWriteStore.withTx(() => applyPreparedMemoryWrite(
      projectionWriteAccessForClient(writeOpts),
      prepared,
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
    ));
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
      { liteWriteStore },
    );
    finalRuleState = "shadow";
    commitId = stateOut.commit_id;
    commitUri = buildAionisUri({ tenant_id: source.tenant_id, scope: source.scope, type: "commit", id: stateOut.commit_id });
  }

  if (generatedRuleNodeId && generatedEpisodeNodeId) {
    if (!liteWriteStore) throw new Error("replay learning source-rule attachment requires lite write store");
    const attachment = await attachReplayLearningSourceRule({
      store: liteWriteStore,
      source,
      episodeNodeId: generatedEpisodeNodeId,
      ruleNodeId: generatedRuleNodeId,
    });
    commitId = attachment.commitId;
    commitUri = buildAionisUri({
      tenant_id: source.tenant_id,
      scope: source.scope,
      type: "commit",
      id: attachment.commitId,
    });
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
