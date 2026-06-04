import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createRequestGuards } from "../../src/app/request-guards.ts";
import { registerRuntimeErrorHandler } from "../../src/server/http-server.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";
import { buildHandoffWriteBody } from "../../src/memory/handoff.ts";
import { registerHandoffRoutes } from "../../src/routes/handoff.ts";
import { registerMemoryAccessRoutes } from "../../src/routes/memory-access.ts";
import { ContinuityReviewPackResponseSchema } from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";
import { InflightGate } from "../../src/util/inflight_gate.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-continuity-review-pack-"));
  return path.join(dir, `${name}.sqlite`);
}

function buildEnv() {
  return {
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
    RECALL_TEXT_EMBED_RATE_LIMIT_MAX_WAIT_MS: 0,
    MAX_TEXT_LEN: 10000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
  } as any;
}

function registerApp(args: {
  app: ReturnType<typeof Fastify>;
  liteWriteStore: ReturnType<typeof createLiteWriteStore>;
  liteRecallStore: ReturnType<typeof createLiteRecallStore>;
}) {
  const env = buildEnv();
  const guards = createRequestGuards({
    env,
    embedder: null,
    recallLimiter: null,
    debugEmbedLimiter: null,
    writeLimiter: null,
    recallTextEmbedLimiter: null,
    recallInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
    writeInflightGate: new InflightGate({ maxInflight: 8, maxQueue: 8, queueTimeoutMs: 100 }),
  });

  registerRuntimeErrorHandler(args.app);
  registerHandoffRoutes({
    app: args.app,
    env,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest as any,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
    executionStateStore: null,
  });
  registerMemoryAccessRoutes({
    app: args.app,
    env,
    embedder: null,
    liteWriteStore: args.liteWriteStore,
    liteRecallAccess: args.liteRecallStore.createRecallAccess(),
    requireMemoryPrincipal: guards.requireMemoryPrincipal,
    withIdentityFromRequest: guards.withIdentityFromRequest,
    enforceRateLimit: guards.enforceRateLimit,
    enforceTenantQuota: guards.enforceTenantQuota,
    tenantFromBody: guards.tenantFromBody,
    acquireInflightSlot: guards.acquireInflightSlot,
  });
}

test("memory continuity review-pack route wraps recovered handoff into reviewer-friendly contract", async () => {
  const dbPath = tmpDbPath("continuity-review-pack");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });

    const storeResp = await app.inject({
      method: "POST",
      url: "/v1/handoff/store",
      payload: {
        tenant_id: "default",
        scope: "default",
        memory_lane: "shared",
        anchor: "resume:src/routes/export.ts",
        file_path: "src/routes/export.ts",
        repo_root: "/repo",
        handoff_kind: "patch_handoff",
        title: "Fix export route",
        summary: "Repair export failure and keep tests green",
        handoff_text: "Fix export route and rerun targeted tests",
        target_files: ["src/routes/export.ts"],
        next_action: "Patch src/routes/export.ts and rerun export tests",
        must_change: ["src/routes/export.ts"],
        must_remove: ["stale export recovery"],
        must_keep: ["existing success path"],
        acceptance_checks: ["npm run -s test:lite -- export"],
        execution_result_summary: {
          status: "passed",
          summary: "Export patch applied and targeted tests passed",
        },
        execution_artifacts: [{ ref: "artifact://export/patch" }],
        execution_evidence: [{ ref: "evidence://export/test" }],
      },
    });
    assert.equal(storeResp.statusCode, 200, storeResp.body);
    const stored = storeResp.json();
    assert.equal(stored.delegation_records_v1.summary_version, "execution_delegation_records_v1");
    assert.equal(stored.delegation_records_v1.record_mode, "memory_only");
    assert.equal(stored.delegation_records_v1.packet_count, 1);
    assert.equal(stored.delegation_records_v1.return_count, 1);
    assert.deepEqual(stored.delegation_records_v1.missing_record_types, []);
    assert.equal(stored.delegation_records_v1.delegation_returns[0]?.status, "passed");
    assert.equal(
      stored.delegation_records_v1.delegation_returns[0]?.summary,
      "Export patch applied and targeted tests passed",
    );
    assert.ok(
      stored.delegation_records_v1.artifact_routing_records.some(
        (record: Record<string, unknown>) => record.ref === "artifact://export/patch",
      ),
    );
    assert.ok(
      stored.delegation_records_v1.artifact_routing_records.some(
        (record: Record<string, unknown>) => record.ref === "evidence://export/test",
      ),
    );

    const recoverResp = await app.inject({
      method: "POST",
      url: "/v1/handoff/recover",
      payload: {
        tenant_id: "default",
        scope: "default",
        handoff_uri: stored.handoff?.uri,
      },
    });
    assert.equal(recoverResp.statusCode, 200, recoverResp.body);
    const recovered = recoverResp.json();
    assert.deepEqual(recovered.delegation_records_v1, stored.delegation_records_v1);

    const reviewResp = await app.inject({
      method: "POST",
      url: "/v1/memory/continuity/review-pack",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor: "resume:src/routes/export.ts",
        file_path: "src/routes/export.ts",
        repo_root: "/repo",
        handoff_kind: "patch_handoff",
      },
    });
    assert.equal(reviewResp.statusCode, 200, reviewResp.body);
    const parsed = ContinuityReviewPackResponseSchema.parse(JSON.parse(reviewResp.body));
    assert.equal(parsed.continuity_review_pack.pack_version, "continuity_review_pack_v1");
    assert.equal(parsed.continuity_review_pack.review_contract?.rollback_required, true);
    assert.deepEqual(parsed.continuity_review_pack.review_contract?.must_remove, ["stale export recovery"]);
    assert.deepEqual(parsed.continuity_review_pack.review_contract?.must_keep, ["existing success path"]);
    assert.deepEqual(parsed.continuity_review_pack.review_contract?.acceptance_checks, ["npm run -s test:lite -- export"]);
    assert.equal(parsed.continuity_review_pack.latest_handoff?.anchor, "resume:src/routes/export.ts");
  } finally {
    await app.close();
  }
});

test("memory continuity review-pack route prefers canonical contract over stale handoff fields", async () => {
  const dbPath = tmpDbPath("continuity-review-pack-canonical-contract");
  const app = Fastify();
  const liteWriteStore = createLiteWriteStore(dbPath);
  const liteRecallStore = createLiteRecallStore(dbPath);
  try {
    registerApp({ app, liteWriteStore, liteRecallStore });
    const handoffWrite = buildHandoffWriteBody({
      tenant_id: "default",
      scope: "default",
      memory_lane: "shared",
      actor: "local-user",
      anchor: "resume:src/routes/stale-export.ts",
      file_path: "src/routes/stale-export.ts",
      repo_root: "/repo",
      handoff_kind: "patch_handoff",
      title: "Fix stale export route",
      summary: "Stale handoff fields conflict with canonical contract",
      handoff_text: "Stale handoff text should not steer review contract",
      target_files: ["src/routes/stale-export.ts"],
      next_action: "Stale next action should not steer review contract",
      acceptance_checks: ["npm run -s test:stale-export"],
    });
    const slots = handoffWrite.nodes?.[0]?.slots as Record<string, unknown>;
    slots.execution_contract_v1 = buildExecutionContractFromProjection({
      contract_trust: "authoritative",
      task_family: "task:canonical_continuity_review",
      task_signature: "canonical-continuity-review",
      workflow_signature: "execution_workflow:canonical-continuity-review",
      selected_tool: "edit",
      file_path: "src/routes/canonical-export.ts",
      target_files: ["src/routes/canonical-export.ts"],
      next_action: "Canonical review contract next action",
      acceptance_checks: ["npm run -s test:canonical-export"],
      provenance: {
        source_kind: "manual_context",
        source_summary_version: "execution_contract_v1",
        source_anchor: "canonical-continuity-review-test",
        evidence_refs: [],
        notes: ["continuity review contract must prefer execution_contract_v1"],
      },
    });
    const prepared = await prepareMemoryWrite(
      handoffWrite,
      "default",
      "default",
      {
        maxTextLen: 10000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    await liteWriteStore.withTx(() => applyMemoryWrite(prepared, {
      maxTextLen: 10000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
      write_access: liteWriteStore,
    }));

    const reviewResp = await app.inject({
      method: "POST",
      url: "/v1/memory/continuity/review-pack",
      payload: {
        tenant_id: "default",
        scope: "default",
        anchor: "resume:src/routes/stale-export.ts",
        file_path: "src/routes/stale-export.ts",
        repo_root: "/repo",
        handoff_kind: "patch_handoff",
      },
    });
    assert.equal(reviewResp.statusCode, 200, reviewResp.body);
    const parsed = ContinuityReviewPackResponseSchema.parse(JSON.parse(reviewResp.body));
    assert.equal(
      parsed.continuity_review_pack.review_contract?.execution_contract_v1?.file_path,
      "src/routes/canonical-export.ts",
    );
    assert.deepEqual(
      parsed.continuity_review_pack.review_contract?.execution_contract_v1?.target_files,
      ["src/routes/canonical-export.ts"],
    );
    assert.deepEqual(parsed.continuity_review_pack.review_contract?.target_files, ["src/routes/canonical-export.ts"]);
    assert.equal(parsed.continuity_review_pack.review_contract?.next_action, "Canonical review contract next action");
    assert.deepEqual(parsed.continuity_review_pack.review_contract?.acceptance_checks, ["npm run -s test:canonical-export"]);
  } finally {
    await app.close();
  }
});
