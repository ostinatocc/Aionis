import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { createRequestGuards } from "./support/create-request-guards-test-config.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { runRuntimeMaintenanceLite } from "../../src/memory/runtime-maintenance.ts";
import { applyPreparedMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { registerMemoryFeedbackToolRoutes } from "./support/register-memory-feedback-tool-test-routes.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";
import { stableUuid } from "../../src/util/uuid.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-runtime-maintenance-"));
  return path.join(dir, `${name}.sqlite`);
}

const writeOpts = {
  defaultScope: "default",
  defaultTenantId: "default",
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
};

function dailyRuntimeEntropyControls() {
  return {
    controls_version: "runtime_entropy_controls_v1",
    recall: {
      breadth: "balanced",
      recommended_limit: 10,
      recommended_ranked_limit: 80,
      recommended_max_nodes: 96,
      recommended_max_edges: 100,
      reason: "Medium entropy keeps recall balanced.",
    },
    verifier: {
      verification_depth: "normal",
      schedule: "normal",
      runtime_verifier_required: false,
      reason: "Normal verification is sufficient.",
    },
    promotion: {
      promotion_threshold: "normal",
      mutation_authority: "scoped",
      minimum_observations: 2,
      stable_promotion_allowed: false,
      reason: "Keep promotion scoped until stronger evidence exists.",
    },
    maintenance: {
      recommended_profile: "daily",
      run_after_task: false,
      reason: "No fresh post-action material requires immediate maintenance.",
    },
    source_code_change_allowed: false,
  };
}

function buildRequestGuards() {
  return createRequestGuards({
    env: {
      AIONIS_EDITION: "lite",
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: false,
      LITE_LOCAL_ACTOR_ID: "local-user",
      MEMORY_TENANT_ID: "default",
      MEMORY_SCOPE: "default",
      APP_ENV: "test",
      ADMIN_TOKEN: "",
      TRUST_PROXY: false,
      TRUSTED_PROXY_CIDRS: [],
      RATE_LIMIT_ENABLED: false,
      RATE_LIMIT_BYPASS_LOOPBACK: false,
      WRITE_RATE_LIMIT_MAX_WAIT_MS: 0,
    } as any,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });
}

test("runtime maintenance reports before and after learning, reuse, and forgetting effects", async () => {
  const dbPath = tmpDbPath("maintenance");
  const store = createLiteWriteStore(dbPath);
  const tenantId = "tenant1";
  const scope = "runtime-maintenance-scope";
  const scopeKey = `tenant:${tenantId}::scope:${scope}`;
  const retiredPolicyId = stableUuid(`${scopeKey}:node:runtime-maintenance:retired-policy`);
  const contestedPatternId = stableUuid(`${scopeKey}:node:runtime-maintenance:contested-pattern`);
  const retainedWorkflowId = stableUuid(`${scopeKey}:node:runtime-maintenance:retained-workflow`);
  const freshEvidenceId = stableUuid(`${scopeKey}:node:runtime-maintenance:fresh-evidence`);
  const staleEvidenceId = stableUuid(`${scopeKey}:node:runtime-maintenance:stale-evidence`);
  const now = "2026-05-23T00:00:00.000Z";

  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: tenantId,
        scope,
        actor: "runtime-maintenance-test",
        input_text: "seed observable maintenance state",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            id: retiredPolicyId,
            client_id: "runtime-maintenance:retired-policy",
            type: "concept",
            tier: "cold",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Retired policy memory",
            text_summary: "Retired policy with negative evidence should be archived by maintenance.",
            slots: {
              summary_kind: "policy_memory",
              compression_layer: "L4",
              policy_memory_state: "retired",
              feedback_negative: 4,
              feedback_quality: -0.8,
            },
            salience: 0.2,
            importance: 0.2,
            confidence: 0.2,
          },
          {
            id: contestedPatternId,
            client_id: "runtime-maintenance:contested-pattern",
            type: "concept",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Contested pattern memory",
            text_summary: "Contested pattern should be demoted before archive.",
            slots: {
              summary_kind: "pattern_anchor",
              compression_layer: "L3",
              anchor_v1: {
                anchor_kind: "pattern",
                credibility_state: "contested",
              },
              feedback_positive: 1,
              feedback_negative: 2,
              feedback_quality: -0.2,
            },
            salience: 0.55,
            importance: 0.55,
            confidence: 0.55,
          },
          {
            id: retainedWorkflowId,
            client_id: "runtime-maintenance:retained-workflow",
            type: "procedure",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Retained workflow memory",
            text_summary: "Workflow with positive reuse evidence should stay visible.",
            slots: {
              summary_kind: "workflow_anchor",
              compression_layer: "L2",
              feedback_positive: 2,
              feedback_quality: 0.9,
              anchor_v1: {
                anchor_kind: "workflow",
                workflow_promotion: {
                  promotion_state: "stable",
                },
                metrics: {
                  usage_count: 5,
                  reuse_success_count: 3,
                  reuse_failure_count: 0,
                  distinct_run_count: 2,
                  last_used_at: now,
                },
              },
            },
            salience: 0.8,
            importance: 0.8,
            confidence: 0.9,
          },
          {
            id: freshEvidenceId,
            client_id: "runtime-maintenance:fresh-evidence",
            type: "evidence",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Fresh execution evidence",
            text_summary: "Fresh low-level execution evidence should remain visible during immediate maintenance.",
            slots: {},
            salience: 0.48,
            importance: 0.52,
            confidence: 0.58,
          },
          {
            id: staleEvidenceId,
            client_id: "runtime-maintenance:stale-evidence",
            type: "evidence",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Stale execution evidence",
            text_summary: "Stale low-level execution evidence may be cooled by controlled forgetting.",
            slots: {},
            salience: 0.48,
            importance: 0.52,
            confidence: 0.58,
          },
        ],
        edges: [],
      },
      scope,
      "default",
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await applyPreparedMemoryWrite(store, prepared, {
      maxTextLen: writeOpts.maxTextLen,
      piiRedaction: writeOpts.piiRedaction,
      allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
    });
    const directDb = createSqliteDatabase(dbPath);
    try {
      directDb.prepare("UPDATE lite_memory_nodes SET created_at = ? WHERE scope = ? AND id = ?")
        .run("2020-01-01T00:00:00.000Z", scopeKey, staleEvidenceId);
    } finally {
      directDb.close();
    }

    const out = await runRuntimeMaintenanceLite(store, {
      tenant_id: tenantId,
      scope,
      actor: "runtime-maintenance-test",
      mode: "apply",
      surfaces: ["forgetting"],
      limit: 10,
      snapshot_limit: 20,
    }, writeOpts);

    assert.equal(out.ok, true);
    assert.equal(out.maintenance_profile, "immediate");
    assert.equal(out.profile_policy.low_level_grace_hours, 24);
    assert.deepEqual(out.profile_policy.default_surfaces, ["workflow", "pattern", "policy", "forgetting"]);
    assert.deepEqual(out.diagnostics.effective_surfaces, ["forgetting"]);
    assert.equal(out.diagnostics.effective_limit, 10);
    assert.equal(out.diagnostics.decisions.applied_count, 3);
    assert.equal(out.diagnostics.decisions.fresh_low_level_protected_count, 1);
    assert.equal(out.diagnostics.decisions.stale_low_level_mutation_count, 1);
    assert.equal(out.diagnostics.decisions.high_level_mutation_count, 2);
    assert.equal(out.diagnostics.decisions.explicit_lifecycle_mutation_count, 2);
    assert.equal(out.applied_count, 3);
    assert.equal(out.source_code_change_allowed, false);
    assert.equal(out.before.tier_counts.hot, 4);
    assert.equal(out.before.tier_counts.cold, 1);
    assert.equal(out.before.runtime_signal_trend_summary.summary_version, "runtime_signal_trend_summary_v1");
    assert.equal(out.before.runtime_signal_trend_summary.source_code_change_allowed, false);
    assert.equal(out.after.tier_counts.hot, 2);
    assert.equal(out.after.tier_counts.warm, 2);
    assert.equal(out.after.tier_counts.archive, 1);
    assert.equal(out.delta.tier_counts.hot, -2);
    assert.equal(out.delta.tier_counts.warm, 2);
    assert.equal(out.delta.tier_counts.archive, 1);
    assert.equal(out.effect_summary.memory_demotions, 2);
    assert.equal(out.effect_summary.memory_archives, 1);
    assert.equal(out.effect_summary.hot_visibility_delta, -2);
    assert.equal(out.effect_summary.archive_visibility_delta, 1);
    assert.equal(out.effect_summary.memory_reuse_signals.usage_count_total, 5);
    assert.equal(out.effect_summary.memory_reuse_signals.reuse_success_total, 3);
    assert.equal(out.effect_summary.memory_reuse_signals.feedback_positive_total, 3);
    assert.equal(out.after.learning_loop_action_counts.demote_memory, 2);
    assert.equal(out.after.learning_loop_action_counts.archive_memory, 1);
    assert.equal(out.learning_loop.decisions.every((entry) => entry.source_code_change_allowed === false), true);
    const freshDecision = out.learning_loop.decisions.find((entry) => entry.target_id === freshEvidenceId);
    assert.equal(freshDecision?.action, "monitor");
    assert.equal(freshDecision?.applied, false);
    assert.match(freshDecision?.reasons.join(" ") ?? "", /fresh_low_level_memory_grace_period/);
    const freshRows = await store.findNodes({
      scope: scopeKey,
      id: freshEvidenceId,
      limit: 1,
      offset: 0,
    });
    const freshRow = freshRows.rows[0];
    assert.equal(freshRow?.tier, "hot");
    assert.equal("learning_loop_v1" in (freshRow?.slots ?? {}), false);
    const staleDecision = out.learning_loop.decisions.find((entry) => entry.target_id === staleEvidenceId);
    assert.equal(staleDecision?.action, "demote_memory");
    assert.equal(staleDecision?.applied, true);
    assert.match(staleDecision?.reasons.join(" ") ?? "", /memory_age_exceeds_forgetting_grace_period/);
    const staleRows = await store.findNodes({
      scope: scopeKey,
      id: staleEvidenceId,
      limit: 1,
      offset: 0,
    });
    assert.equal(staleRows.rows[0]?.tier, "warm");
  } finally {
    await store.close();
  }
});

test("runtime maintenance profiles apply different low-level forgetting horizons", async () => {
  const dbPath = tmpDbPath("profile-horizons");
  const store = createLiteWriteStore(dbPath);
  const tenantId = "tenant1";
  const scope = "runtime-maintenance-profile-scope";
  const scopeKey = `tenant:${tenantId}::scope:${scope}`;
  const evidenceId = stableUuid(`${scopeKey}:node:runtime-maintenance:profile-evidence`);

  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: tenantId,
        scope,
        actor: "runtime-maintenance-test",
        input_text: "seed profile horizon evidence",
        auto_embed: false,
        distill: { enabled: false },
        nodes: [
          {
            id: evidenceId,
            client_id: "runtime-maintenance:profile-evidence",
            type: "evidence",
            tier: "hot",
            memory_lane: "shared",
            producer_agent_id: "runtime-maintenance-test",
            title: "Two-day execution evidence",
            text_summary: "Two-day-old low-level execution evidence should be stale for daily but fresh for long-horizon maintenance.",
            slots: {},
            salience: 0.48,
            importance: 0.52,
            confidence: 0.58,
          },
        ],
        edges: [],
      },
      scope,
      "default",
      {
        maxTextLen: writeOpts.maxTextLen,
        piiRedaction: writeOpts.piiRedaction,
        allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
      },
      null,
    );
    sealAuthorityReceiptsForPreparedWrite(prepared);
    await applyPreparedMemoryWrite(store, prepared, {
      maxTextLen: writeOpts.maxTextLen,
      piiRedaction: writeOpts.piiRedaction,
      allowCrossScopeEdges: writeOpts.allowCrossScopeEdges,
    });
    const twoDaysOld = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
    const directDb = createSqliteDatabase(dbPath);
    try {
      directDb.prepare("UPDATE lite_memory_nodes SET created_at = ? WHERE scope = ? AND id = ?")
        .run(twoDaysOld, scopeKey, evidenceId);
    } finally {
      directDb.close();
    }

    const longHorizon = await runRuntimeMaintenanceLite(store, {
      tenant_id: tenantId,
      scope,
      actor: "runtime-maintenance-test",
      mode: "dry_run",
      maintenance_profile: "long_horizon",
      surfaces: ["forgetting"],
      limit: 10,
      snapshot_limit: 20,
    }, writeOpts);
    assert.equal(longHorizon.maintenance_profile, "long_horizon");
    assert.equal(longHorizon.profile_policy.low_level_grace_hours, 168);
    assert.equal(longHorizon.diagnostics.effective_limit, 10);
    assert.equal(longHorizon.diagnostics.decisions.fresh_low_level_protected_count, 1);
    assert.equal(longHorizon.diagnostics.decisions.dry_run_mutation_candidate_count, 0);
    assert.equal(longHorizon.applied_count, 0);
    const longDecision = longHorizon.learning_loop.decisions.find((entry) => entry.target_id === evidenceId);
    assert.equal(longDecision?.action, "monitor");
    assert.match(longDecision?.reasons.join(" ") ?? "", /fresh_low_level_memory_grace_period/);

    const daily = await runRuntimeMaintenanceLite(store, {
      tenant_id: tenantId,
      scope,
      actor: "runtime-maintenance-test",
      mode: "dry_run",
      maintenance_profile: "daily",
      surfaces: ["forgetting"],
      limit: 10,
      snapshot_limit: 20,
    }, writeOpts);
    assert.equal(daily.maintenance_profile, "daily");
    assert.equal(daily.profile_policy.low_level_grace_hours, 24);
    assert.equal(daily.diagnostics.decisions.stale_low_level_mutation_count, 1);
    assert.equal(daily.diagnostics.decisions.dry_run_mutation_candidate_count, 1);
    const dailyDecision = daily.learning_loop.decisions.find((entry) => entry.target_id === evidenceId);
    assert.equal(dailyDecision?.action, "demote_memory");
    assert.equal(dailyDecision?.applied, false);
    assert.match(dailyDecision?.reasons.join(" ") ?? "", /memory_age_exceeds_forgetting_grace_period/);
  } finally {
    await store.close();
  }
});

test("runtime maintenance profile endpoints expose scheduler-ready entrypoints", async () => {
  const app = Fastify();
  const store = createLiteWriteStore(tmpDbPath("profile-routes"));
  try {
    const guards = buildRequestGuards();
    registerRuntimeErrorHandler(app);
    registerMemoryFeedbackToolRoutes({
      app,
      env: {
        AIONIS_EDITION: "lite",
        MEMORY_SCOPE: "default",
        MEMORY_TENANT_ID: "default",
        LITE_LOCAL_ACTOR_ID: "local-user",
        MAX_TEXT_LEN: 10000,
        PII_REDACTION: false,
        ALLOW_CROSS_SCOPE_EDGES: false,
      } as any,
      embedder: null,
      liteWriteStore: store,
      requireMemoryPrincipal: guards.requireMemoryPrincipal,
      withIdentityFromRequest: guards.withIdentityFromRequest,
      enforceRateLimit: guards.enforceRateLimit,
      enforceTenantQuota: guards.enforceTenantQuota,
      tenantFromBody: guards.tenantFromBody,
      acquireInflightSlot: guards.acquireInflightSlot,
    });

    const entropyDefaulted = await app.inject({
      method: "POST",
      url: "/v1/memory/runtime-maintenance/run",
      payload: {
        tenant_id: "default",
        scope: "default",
        mode: "dry_run",
        runtime_entropy_controls: dailyRuntimeEntropyControls(),
      },
    });
    assert.equal(entropyDefaulted.statusCode, 200);
    const entropyDefaultedBody = entropyDefaulted.json();
    assert.equal(entropyDefaultedBody.maintenance_profile, "daily");
    assert.equal(entropyDefaultedBody.runtime_entropy_maintenance_defaults.applied, true);
    assert.equal(entropyDefaultedBody.runtime_entropy_maintenance_defaults.reason, "applied");
    assert.equal(entropyDefaultedBody.runtime_entropy_maintenance_defaults.recommended_profile, "daily");
    assert.equal(entropyDefaultedBody.runtime_entropy_maintenance_defaults.run_after_task, false);

    const daily = await app.inject({
      method: "POST",
      url: "/v1/memory/runtime-maintenance/daily",
      payload: {
        tenant_id: "default",
        scope: "default",
        mode: "dry_run",
      },
    });
    assert.equal(daily.statusCode, 200);
    const dailyBody = daily.json();
    assert.equal(dailyBody.maintenance_profile, "daily");
    assert.equal(dailyBody.profile_policy.default_limit, 100);
    assert.equal(dailyBody.diagnostics.effective_limit, 100);

    const longHorizon = await app.inject({
      method: "POST",
      url: "/v1/memory/runtime-maintenance/long-horizon",
      payload: {
        tenant_id: "default",
        scope: "default",
        mode: "dry_run",
        maintenance_profile: "immediate",
        runtime_entropy_controls: dailyRuntimeEntropyControls(),
      },
    });
    assert.equal(longHorizon.statusCode, 200);
    const longHorizonBody = longHorizon.json();
    assert.equal(longHorizonBody.maintenance_profile, "long_horizon");
    assert.equal(longHorizonBody.runtime_entropy_maintenance_defaults.applied, false);
    assert.equal(longHorizonBody.runtime_entropy_maintenance_defaults.reason, "explicit_maintenance_profile");
    assert.equal(longHorizonBody.runtime_entropy_maintenance_defaults.recommended_profile, "daily");
    assert.deepEqual(longHorizonBody.profile_policy.default_surfaces, ["policy", "forgetting"]);
    assert.deepEqual(longHorizonBody.diagnostics.effective_surfaces, ["policy", "forgetting"]);
  } finally {
    await app.close();
    await store.close();
  }
});
