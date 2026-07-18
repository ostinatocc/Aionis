import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeServices } from "../../src/app/runtime-services.ts";
import { loadEnv, type Env } from "../../src/config.ts";
import { createRuntimeConfig } from "../../src/config/runtime-config.ts";
import {
  LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES,
  LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES,
} from "../../src/store/lite-learning-episode-ledger.ts";
import {
  createLiteSkillCandidateReviewStore,
  createLiteSkillCandidateReviewStoreFromDatabase,
} from "../../src/store/lite-skill-candidate-review-store.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteWriteStore, createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../../src/store/sqlite.ts";
import { inspectLiteRuntimeSchema } from "../../src/store/lite-runtime-schema.ts";
import {
  productMeasurementDigest,
  productMeasurementRecordDigest,
  type ProductMeasurementRecord,
  type TraceDerivedSkillTrainingCandidate,
} from "../../src/store/memory-store.ts";
import { buildAionisEffectReport } from "../../src/memory/product-output/learning-effect.ts";
import { evaluateAionisEffect } from "../../src/kernel/effect-evaluator.ts";
import {
  LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE,
  LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS,
} from "../../src/store/lite-runtime-authority-adoption-contract.ts";

function tmpDbPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aionis-skill-candidate-review-")), `${name}.sqlite`);
}

async function withIsolatedEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

async function runtimeAssemblyEnv(writePath: string, replayPath: string): Promise<Env> {
  return await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      MEMORY_AUTH_MODE: "off",
      MEMORY_TENANT_ID: "measurement-assembly-tenant",
      MEMORY_SCOPE: "measurement-assembly/default",
      LITE_LOCAL_ACTOR_ID: "measurement-assembly-local",
      LITE_WRITE_SQLITE_PATH: writePath,
      LITE_REPLAY_SQLITE_PATH: replayPath,
      SANDBOX_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RECALL_ANN_PROVIDER: "off",
      RECALL_SUBSTRATE_SIDECAR_ENABLED: "false",
      WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: "false",
    },
    () => loadEnv(),
  );
}

type RuntimeServices = Awaited<ReturnType<typeof createRuntimeServices>>;

async function closeRuntimeServices(services: RuntimeServices): Promise<void> {
  services.sandboxExecutor.shutdown();
  await services.executionTreeStore.close();
  await services.executionStateStore.close();
  await services.liteSkillCandidateReviewStore.close();
  await services.liteClaimLedgerStore.close();
  await services.liteRecallStore.close();
  await services.liteReplayStore?.close();
  await services.liteWriteStore.close();
  await services.store.close();
}

async function createCompleteV2RuntimeFixture(dbPath: string): Promise<void> {
  const initialized = createLiteWriteStore(dbPath, { annProjectionEnabled: false });
  await initialized.close();

  const db = createSqliteDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const trigger of LITE_LEARNING_LEDGER_REQUIRED_TRIGGER_NAMES) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    for (const trigger of Object.keys(LITE_RUNTIME_AUTHORITY_ADOPTION_TRIGGERS)) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    // v6 adoption bindings reference manifests, so the downgrade fixture must
    // remove them in dependency order before presenting a complete v2 shape.
    db.exec(`DROP TABLE IF EXISTS ${LITE_RUNTIME_AUTHORITY_ADOPTION_BINDING_TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${LITE_RUNTIME_AUTHORITY_ADOPTION_MANIFEST_TABLE}`);
    for (const table of [...LITE_LEARNING_LEDGER_REQUIRED_TABLE_NAMES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const column of ["record_sha256", "after_episode_id", "baseline_episode_id"]) {
      db.exec(`ALTER TABLE lite_product_measurements DROP COLUMN ${column}`);
    }
    db.prepare(
      `UPDATE lite_runtime_schema_metadata
       SET version = 2, updated_at = ?
       WHERE component = 'write_projection'`,
    ).run("2026-07-14T00:00:00.000Z");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  const classified = createSqliteDatabase(dbPath);
  try {
    assert.equal(inspectLiteRuntimeSchema(classified).classification, "supported_previous_v2");
  } finally {
    classified.close();
  }
}

function candidate(input: { skillName?: string; sourceTraceId?: string } = {}): TraceDerivedSkillTrainingCandidate {
  return {
    candidate_type: "trace_derived_skill",
    source_ids: [input.sourceTraceId ?? "effect_kernel:continuity", "run:run-aionis"],
    label: "positive",
    export_ready: true,
    reason: "Positive continuity evidence produced a governed trace-derived skill candidate.",
    trace_derived_skill: {
      contract_version: "aionis_trace_derived_skill_candidate_v1",
      skill_name: input.skillName ?? "Continue verified execution state across sessions",
      source_trace_ids: [input.sourceTraceId ?? "effect_kernel:continuity", "run:run-aionis"],
      source_signal_ids: ["continuity_guidance_matches_expected"],
      applies_when: ["task_signature:runtime-continuation", "future_session_needs_verified_continuation"],
      does_not_apply_when: ["No validation evidence is available for the source trace."],
      procedure_steps: [
        "Recover the current Aionis guide before continuing the task.",
        "Run the recorded acceptance checks before treating the continuation as reusable.",
      ],
      target_files: ["src/runtime.ts"],
      acceptance_checks: ["npm test passed"],
      failure_counterexamples: ["legacy route failed verifier"],
      evidence_refs: ["ev-1"],
      authority_state: "candidate",
      promotion_status: "promotion_ready",
      export_policy: {
        agent_prompt_included: false,
        runtime_mutation: false,
        required_gate: "admission_and_promotion_gate",
      },
    },
  };
}

function measurement(
  candidates: TraceDerivedSkillTrainingCandidate[],
  options: {
    measurementId?: string;
    baselineEpisodeId?: string | null;
    afterEpisodeId?: string | null;
    includeRecordDigest?: boolean;
  } = {},
): ProductMeasurementRecord {
  const effectReport = buildAionisEffectReport({
    tenant_id: "tenant-a",
    scope: "scope-a",
    comparison: { mode: "baseline_vs_aionis", sufficient_evidence: true },
    evidence_ids: ["guide_receipt:before", "guide_receipt:after", "tool_feedback:positive"],
    report: evaluateAionisEffect({
      baseline: {
        continuity: {
          repeatedDiscoverySteps: 4,
          continuityGuidanceCorrect: false,
          recoveredStateFacts: 0,
          expectedStateFacts: 4,
          verifiedFactsCarried: 0,
          verifiedFactsExpected: 4,
        },
        learning: {
          workflowReused: false,
          stableWorkflowReused: false,
          provisionalMemoriesWritten: 1,
          trustedPromotions: 0,
          weakEvidencePromoted: 0,
          counterEvidenceDemotions: 0,
        },
        forgetting: {
          contextItems: 4,
          usefulContextItems: 1,
          staleMemorySurfaced: 1,
          staleMemorySuppressed: 0,
          archivedMemoryRehydratedOnDemand: 0,
          unnecessaryRehydrations: 1,
        },
        learning_control: {
          weakEvidenceBlocked: 0,
          authorityRequiresEvidence: false,
          blockedAuthorityVisible: false,
          unverifiedAuthorityApplied: 1,
        },
      },
      aionis: {
        continuity: {
          repeatedDiscoverySteps: 0,
          continuityGuidanceCorrect: true,
          recoveredStateFacts: 4,
          expectedStateFacts: 4,
          verifiedFactsCarried: 4,
          verifiedFactsExpected: 4,
        },
        learning: {
          workflowReused: true,
          stableWorkflowReused: true,
          provisionalMemoriesWritten: 0,
          trustedPromotions: 1,
          weakEvidencePromoted: 0,
          counterEvidenceDemotions: 1,
        },
        forgetting: {
          contextItems: 4,
          usefulContextItems: 4,
          staleMemorySurfaced: 0,
          staleMemorySuppressed: 1,
          archivedMemoryRehydratedOnDemand: 1,
          unnecessaryRehydrations: 0,
        },
        learning_control: {
          weakEvidenceBlocked: 1,
          authorityRequiresEvidence: true,
          blockedAuthorityVisible: true,
          unverifiedAuthorityApplied: 0,
        },
      },
    }),
  });
  effectReport.training_candidates = candidates;
  const recordWithoutDigest = {
    measurement_id: options.measurementId ?? "measurement:test-runtime",
    tenant_id: "tenant-a",
    scope: "scope-a",
    source: "product_trace",
    effect_report: effectReport,
    eligible_for_skill_export: true,
    evidence_status: "sufficient",
    runtime_evidence_ids: ["guide_receipt:before", "guide_receipt:after", "tool_feedback:positive"],
    eligibility_reasons: ["runtime evidence verified"],
    created_by: "aionis-runtime",
    created_at: "2026-06-26T00:30:00.000Z",
  } as const;
  const recordWithoutFullDigest = {
    ...recordWithoutDigest,
    measurement_digest: productMeasurementDigest(recordWithoutDigest),
    baseline_episode_id: options.baselineEpisodeId ?? null,
    after_episode_id: options.afterEpisodeId ?? null,
  };
  return {
    ...recordWithoutFullDigest,
    record_sha256: options.includeRecordDigest
      ? productMeasurementRecordDigest(recordWithoutFullDigest)
      : null,
  };
}

test("product measurement full-record digest binds identity source episode pair and content digest", () => {
  const base = {
    measurement_id: "measurement:digest-a",
    tenant_id: "tenant-a",
    scope: "scope-a",
    source: "product_trace" as const,
    baseline_episode_id: `lep_${"1".repeat(64)}`,
    after_episode_id: `lep_${"2".repeat(64)}`,
    measurement_digest: "a".repeat(64),
    created_by: "actor:digest-a",
    created_at: "2026-06-26T00:30:00.000Z",
  };
  const digest = productMeasurementRecordDigest(base);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  for (const changed of [
    { ...base, measurement_id: "measurement:digest-b" },
    { ...base, tenant_id: "tenant-b" },
    { ...base, scope: "scope-b" },
    { ...base, source: "manual_observations" as const },
    { ...base, baseline_episode_id: `lep_${"3".repeat(64)}` },
    { ...base, after_episode_id: `lep_${"4".repeat(64)}` },
    { ...base, measurement_digest: "b".repeat(64) },
    { ...base, created_by: "actor:digest-b" },
    { ...base, created_at: "2026-06-26T00:31:00.000Z" },
  ]) {
    assert.notEqual(productMeasurementRecordDigest(changed), digest);
  }
});

test("product measurement integrity rejects noncanonical creation time even with a matching full-record digest", async () => {
  const valid = measurement([candidate()], {
    measurementId: "measurement:invalid-created-at",
    baselineEpisodeId: `lep_${"1".repeat(64)}`,
    afterEpisodeId: `lep_${"2".repeat(64)}`,
    includeRecordDigest: true,
  });
  const invalid = {
    ...valid,
    created_at: "2026-06-26T00:30:00Z",
  };
  invalid.record_sha256 = productMeasurementRecordDigest(invalid);

  const store = createLiteSkillCandidateReviewStore(tmpDbPath("invalid-created-at"));
  try {
    await assert.rejects(
      store.createSkillCandidateReviewAccess().recordMeasurement({ record: invalid }),
      /expected a canonical UTC millisecond timestamp/,
    );
  } finally {
    await store.close();
  }
});

test("trace-derived skill review store queues candidates idempotently", async () => {
  const store = createLiteSkillCandidateReviewStore(tmpDbPath("queue"));
  const access = store.createSkillCandidateReviewAccess();
  try {
    const record = measurement([candidate()]);
    const persisted = await access.recordMeasurement({ record });
    assert.equal(persisted.baseline_episode_id, null);
    assert.equal(persisted.after_episode_id, null);
    assert.equal(persisted.record_sha256, null);
    const first = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:00:00.000Z",
    });
    const second = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates: [candidate()],
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:05:00.000Z",
    });

    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 0);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(first.rows[0]?.candidate_id, second.rows[0]?.candidate_id);
    assert.equal(second.rows[0]?.review_status, "pending_review");
    assert.equal(second.rows[0]?.candidate.trace_derived_skill.export_policy.agent_prompt_included, false);

    const listed = await access.listTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      reviewStatus: "pending_review",
      limit: 10,
    });
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0]?.skill_name, "Continue verified execution state across sessions");
  } finally {
    await store.close();
  }
});

test("trace-derived skill review store records promote and reject decisions without changing candidate payload", async () => {
  const store = createLiteSkillCandidateReviewStore(tmpDbPath("review"));
  const access = store.createSkillCandidateReviewAccess();
  try {
    const candidates = [
      candidate({ sourceTraceId: "effect_kernel:continuity" }),
      candidate({ skillName: "Reuse verified workflow", sourceTraceId: "effect_kernel:learning" }),
    ];
    const record = measurement(candidates);
    await access.recordMeasurement({ record });
    const queued = await access.enqueueTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidates,
      measurementId: record.measurement_id,
      measurementDigest: record.measurement_digest,
      eligibleForPromotion: true,
      now: "2026-06-26T01:00:00.000Z",
    });
    const promoted = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[0]!.candidate_id,
      reviewStatus: "promoted",
      reviewerId: "operator-1",
      reason: "Strong evidence and matching task family.",
      expectedVersion: queued.rows[0]!.row_version,
      now: "2026-06-26T02:00:00.000Z",
    });
    const rejected = await access.reviewTraceDerivedSkillCandidate({
      tenantId: "tenant-a",
      scope: "scope-a",
      candidateId: queued.rows[1]!.candidate_id,
      reviewStatus: "rejected",
      reviewerId: "operator-1",
      reason: "Needs more cross-task evidence.",
      expectedVersion: queued.rows[1]!.row_version,
      now: "2026-06-26T02:05:00.000Z",
    });

    assert.equal(promoted?.review_status, "promoted");
    assert.equal(promoted?.reviewer_id, "operator-1");
    assert.equal(promoted?.reviewed_at, "2026-06-26T02:00:00.000Z");
    assert.equal(promoted?.candidate.trace_derived_skill.authority_state, "candidate");
    assert.equal(promoted?.candidate.trace_derived_skill.export_policy.runtime_mutation, false);
    assert.equal(rejected?.review_status, "rejected");

    const all = await access.listTraceDerivedSkillCandidates({
      tenantId: "tenant-a",
      scope: "scope-a",
      reviewStatus: "all",
      limit: 10,
    });
    assert.equal(all.rows.length, 2);
    assert.deepEqual(new Set(all.rows.map((row) => row.review_status)), new Set(["promoted", "rejected"]));
  } finally {
    await store.close();
  }
});

test("normal Runtime assembly shares the main write transaction for fresh and upgraded v2 databases", async (t) => {
  for (const fixture of ["fresh", "v2"] as const) {
    await t.test(fixture, async () => {
      const writePath = tmpDbPath(`runtime-assembly-${fixture}-write`);
      const replayPath = tmpDbPath(`runtime-assembly-${fixture}-replay`);
      if (fixture === "v2") await createCompleteV2RuntimeFixture(writePath);
      const env = await runtimeAssemblyEnv(writePath, replayPath);
      let services: RuntimeServices | null = null;
      try {
        services = await createRuntimeServices(createRuntimeConfig(env));
        assert.equal(
          services.skillCandidateReviewAccess.transactionRunner(),
          services.liteWriteStore.transactionRunner(),
          "measurement/review access must not open an independent Runtime writer",
        );
        const schemaDb = createSqliteDatabase(writePath);
        try {
          const report = inspectLiteRuntimeSchema(schemaDb);
          assert.equal(report.classification, "current");
          assert.equal(report.detected_version, 6);
        } finally {
          schemaDb.close();
        }
      } finally {
        if (services) await closeRuntimeServices(services);
        fs.rmSync(path.dirname(writePath), { recursive: true, force: true });
        fs.rmSync(path.dirname(replayPath), { recursive: true, force: true });
      }
    });
  }
});

test("shared skill review factory requires caller-owned schema migration", async () => {
  const dbPath = tmpDbPath("shared-schema-owner");
  const database = createLiteRuntimeDatabase(dbPath);
  try {
    const before = database.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    assert.throws(
      () => createLiteSkillCandidateReviewStoreFromDatabase(database),
      /lite_skill_candidate_review_schema_preflight_failed/,
    );
    const after = database.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    assert.deepEqual(after, before);
  } finally {
    await database.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("shared skill review factory performs no DDL after central current-schema preflight", async () => {
  const dbPath = tmpDbPath("shared-no-post-preflight-ddl");
  const database = createLiteRuntimeDatabase(dbPath);
  const writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  let store: ReturnType<typeof createLiteSkillCandidateReviewStoreFromDatabase> | null = null;
  try {
    const schemaVersionBefore = database.db.prepare(
      "PRAGMA schema_version",
    ).get() as { schema_version: number };
    const schemaBefore = database.db.prepare(
      `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all();
    const observedDdl: string[] = [];
    const rejectDdl = (sql: string): void => {
      if (/^\s*(?:ALTER|CREATE|DROP)\b/iu.test(sql)) {
        observedDdl.push(sql);
        throw new Error(`unexpected shared-factory DDL: ${sql}`);
      }
    };
    const ddlGuardDb: SqliteDatabase = {
      exec(sql) {
        rejectDdl(sql);
        return database.db.exec(sql);
      },
      prepare<T = any>(sql: string) {
        rejectDdl(sql);
        return database.db.prepare<T>(sql);
      },
      close() {
        throw new Error("shared factory must not close the caller-owned SQLite connection");
      },
    };
    store = createLiteSkillCandidateReviewStoreFromDatabase({ ...database, db: ddlGuardDb });
    assert.deepEqual(observedDdl, []);
    assert.deepEqual(
      database.db.prepare("PRAGMA schema_version").get(),
      schemaVersionBefore,
    );
    assert.deepEqual(
      database.db.prepare(
        `SELECT type, name, tbl_name AS table_name, sql
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      ).all(),
      schemaBefore,
    );

    await store.close();
    store = null;
    assert.equal(
      (database.db.prepare("SELECT 1 AS value").get() as { value: number }).value,
      1,
      "closing a shared review store must not close the Runtime database",
    );
  } finally {
    await store?.close();
    await writeStore.close();
    await database.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("standalone review schema cannot create or serve a partial v3 measurement shape", async () => {
  const dbPath = tmpDbPath("standalone-schema-boundary");
  const store = createLiteSkillCandidateReviewStore(dbPath);
  await store.close();

  const database = createSqliteDatabase(dbPath);
  try {
    const columns = () => (database.prepare(
      "PRAGMA table_info('lite_product_measurements')",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ["baseline_episode_id", "after_episode_id", "record_sha256"]) {
      assert.equal(columns().includes(column), false, `standalone schema leaked v3 column ${column}`);
    }
    assert.equal(inspectLiteRuntimeSchema(database).classification, "uninitialized");

    database.exec("ALTER TABLE lite_product_measurements ADD COLUMN baseline_episode_id TEXT");
    const report = inspectLiteRuntimeSchema(database);
    assert.equal(report.classification, "incompatible");
    assert.match(report.problems.join("\n"), /v3-only measurement columns/);
  } finally {
    database.close();
  }

  const partial = createLiteRuntimeDatabase(dbPath);
  try {
    assert.throws(
      () => createLiteSkillCandidateReviewStoreFromDatabase(partial),
      /v3 measurement linkage columns exist without write schema metadata v3/,
    );
  } finally {
    await partial.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("shared v3 measurement store persists authoritative episode links and reads legacy null links", async () => {
  const dbPath = tmpDbPath("shared-v3-measurement-links");
  const database = createLiteRuntimeDatabase(dbPath);
  const writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
  let store: ReturnType<typeof createLiteSkillCandidateReviewStoreFromDatabase> | null = null;
  try {
    store = createLiteSkillCandidateReviewStoreFromDatabase(database);
    const access = store.createSkillCandidateReviewAccess();
    const linked = measurement([candidate()], {
      measurementId: "measurement:linked",
      baselineEpisodeId: `lep_${"1".repeat(64)}`,
      afterEpisodeId: `lep_${"2".repeat(64)}`,
      includeRecordDigest: true,
    });

    assert.deepEqual(await access.recordMeasurement({ record: linked }), linked);
    const storedLinks = database.db.prepare(
      `SELECT baseline_episode_id, after_episode_id, record_sha256
       FROM lite_product_measurements WHERE measurement_id = ?`,
    ).get(linked.measurement_id) as Record<string, unknown>;
    assert.equal(storedLinks.baseline_episode_id, linked.baseline_episode_id);
    assert.equal(storedLinks.after_episode_id, linked.after_episode_id);
    assert.equal(storedLinks.record_sha256, linked.record_sha256);
    assert.deepEqual(await access.getMeasurement({
      tenantId: linked.tenant_id,
      scope: linked.scope,
      measurementId: linked.measurement_id,
    }), linked);

    database.db.prepare(
      `UPDATE lite_product_measurements
       SET effect_report_json = json_set(
         effect_report_json,
         '$.history_impact.explanation',
         'tampered measurement effect report'
       )
       WHERE measurement_id = ?`,
    ).run(linked.measurement_id);
    await assert.rejects(
      access.getMeasurement({
        tenantId: linked.tenant_id,
        scope: linked.scope,
        measurementId: linked.measurement_id,
      }),
      /persisted measurement digest does not match its effect evidence/,
    );
    database.db.prepare(
      `UPDATE lite_product_measurements SET effect_report_json = ?
       WHERE measurement_id = ?`,
    ).run(JSON.stringify(linked.effect_report), linked.measurement_id);

    const changedPair = {
      ...linked,
      after_episode_id: `lep_${"3".repeat(64)}`,
    };
    await assert.rejects(
      access.recordMeasurement({
        record: {
          ...changedPair,
          record_sha256: productMeasurementRecordDigest(changedPair),
        },
      }),
      /measurement id already exists with a different record digest/,
    );
    await assert.rejects(
      access.recordMeasurement({
        record: {
          ...linked,
          record_sha256: "f".repeat(64),
        },
      }),
      /measurement record digest does not match/,
    );

    const legacy = measurement([candidate()], { measurementId: "measurement:legacy-v3" });
    database.db.prepare(
      `INSERT INTO lite_product_measurements (
        measurement_id, tenant_id, scope, source, measurement_digest,
        effect_report_json, eligible_for_skill_export, evidence_status,
        runtime_evidence_ids_json, eligibility_reasons_json, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      legacy.measurement_id,
      legacy.tenant_id,
      legacy.scope,
      legacy.source,
      legacy.measurement_digest,
      JSON.stringify(legacy.effect_report),
      legacy.eligible_for_skill_export ? 1 : 0,
      legacy.evidence_status,
      JSON.stringify(legacy.runtime_evidence_ids),
      JSON.stringify(legacy.eligibility_reasons),
      legacy.created_by,
      legacy.created_at,
    );
    const loadedLegacy = await access.getMeasurement({
      tenantId: legacy.tenant_id,
      scope: legacy.scope,
      measurementId: legacy.measurement_id,
    });
    assert.equal(loadedLegacy?.baseline_episode_id, null);
    assert.equal(loadedLegacy?.after_episode_id, null);
    assert.equal(loadedLegacy?.record_sha256, null);
  } finally {
    await store?.close();
    await writeStore.close();
    await database.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test("shared measurement access joins the Runtime transaction and rolls back sibling writes", async () => {
  const dbPath = tmpDbPath("shared-transaction");
  let failBeforeCommit = false;
  const database = createLiteRuntimeDatabase(dbPath, {
    faultInjector(phase) {
      if (failBeforeCommit && phase === "before_commit") {
        throw new Error("injected shared measurement before_commit failure");
      }
    },
  });
  let store: ReturnType<typeof createLiteSkillCandidateReviewStoreFromDatabase> | null = null;
  let writeStore: ReturnType<typeof createLiteWriteStoreFromDatabase> | null = null;
  try {
    writeStore = createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false });
    const runtimeWriteStore = writeStore;
    store = createLiteSkillCandidateReviewStoreFromDatabase(database);
    const access = store.createSkillCandidateReviewAccess();
    assert.equal(access.transactionRunner(), database.transaction);
    assert.equal(access.transactionRunner(), runtimeWriteStore.transactionRunner());

    const record = measurement([candidate()]);
    failBeforeCommit = true;
    await assert.rejects(
      runtimeWriteStore.withTx(async () => {
        await access.recordMeasurement({ record });
        await runtimeWriteStore.insertWriteOperation({
          tenantId: "tenant-a",
          scope: "scope-a",
          operationKind: "shared_measurement_uow_test",
          operationId: "measurement-operation-before-commit",
          requestSha256: "a".repeat(64),
          receiptJson: JSON.stringify({ status: "must_rollback" }),
          commitId: null,
        });
      }),
      /injected shared measurement before_commit failure/,
    );
    failBeforeCommit = false;

    await store.close();
    store = null;
    assert.equal(
      (database.db.prepare("SELECT 1 AS value").get() as { value: number }).value,
      1,
      "closing a shared store must not close the caller-owned Runtime database",
    );
  } finally {
    failBeforeCommit = false;
    await store?.close();
    await writeStore?.close();
    await database.close();
  }

  const reopened = createSqliteDatabase(dbPath);
  try {
    const measurementCount = reopened.prepare(
      "SELECT COUNT(*) AS count FROM lite_product_measurements",
    ).get() as { count: number };
    const siblingCount = reopened.prepare(
      "SELECT COUNT(*) AS count FROM lite_runtime_write_operations",
    ).get() as { count: number };
    assert.equal(measurementCount.count, 0);
    assert.equal(siblingCount.count, 0);
  } finally {
    reopened.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
