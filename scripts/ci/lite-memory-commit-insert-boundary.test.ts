import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createLiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import type { WriteCommitInsertArgs } from "../../src/store/write-access.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_ROOT = path.join(ROOT, "src");
const LEGACY_SEAM = "insertLegacyV1CommitForMigrationOrTestFixture";

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
    });
}

function relativeToRoot(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function tempDatabase(name: string): { directory: string; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-commit-boundary-${name}-`));
  return { directory, databasePath: path.join(directory, "runtime.sqlite") };
}

const legacyPayload = {
  scope: "scope/legacy-runtime-rejection",
  parentCommitId: null,
  inputSha256: "1".repeat(64),
  diffJson: "{}",
  actor: "legacy-runtime-rejection-test",
  modelVersion: null,
  promptVersion: null,
  commitHash: "2".repeat(64),
};

test("WriteCommitInsertArgs is a digest-v2-only production contract", () => {
  const digestVersion: WriteCommitInsertArgs["digestVersion"] = 2;
  assert.equal(digestVersion, 2);

  // @ts-expect-error A legacy-shaped payload must not satisfy the production API.
  const rejectedLegacyShape: WriteCommitInsertArgs = legacyPayload;
  assert.equal(rejectedLegacyShape.digestVersion, undefined);
});

test("production source has exactly two direct commit insertion owners and no legacy seam caller", () => {
  const directInsertCounts = new Map<string, number>();
  const legacySeamCallers: string[] = [];
  const directInsertPattern = /\.\s*insertCommit\s*\(/gu;
  const legacySeamPattern = new RegExp(`\\.\\s*${LEGACY_SEAM}\\s*\\(`, "gu");

  for (const file of collectTypeScriptFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, "utf8");
    const relative = relativeToRoot(file);
    const directInsertCount = [...source.matchAll(directInsertPattern)].length;
    if (directInsertCount > 0) directInsertCounts.set(relative, directInsertCount);
    if (legacySeamPattern.test(source)) legacySeamCallers.push(relative);
  }

  assert.deepEqual([...directInsertCounts.entries()].sort(), [
    ["src/memory/applied-authority-mutation.ts", 1],
    ["src/memory/write.ts", 1],
  ]);
  assert.deepEqual(legacySeamCallers, []);

  const productionContract = fs.readFileSync(path.join(SRC_ROOT, "store", "write-access.ts"), "utf8");
  assert.doesNotMatch(productionContract, new RegExp(`\\b${LEGACY_SEAM}\\b`, "u"));
});

test("production execution-decision inserts are owned only by v2 authority coordinators", () => {
  const directInsertCounts = new Map<string, number>();
  const directInsertPattern = /\.\s*insertExecutionDecision\s*\(/gu;

  for (const file of collectTypeScriptFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, "utf8");
    const count = [...source.matchAll(directInsertPattern)].length;
    if (count > 0) directInsertCounts.set(relativeToRoot(file), count);
  }

  assert.deepEqual([...directInsertCounts.entries()].sort(), [
    ["src/memory/execution-decision-authority.ts", 1],
    ["src/memory/tools-feedback-applied-authority.ts", 1],
  ]);

  for (const forbidden of [
    "src/memory/tools-select.ts",
    "src/product/guide-service.ts",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, forbidden), "utf8"),
      directInsertPattern,
    );
  }
});

test("protected authority row writers stay behind their reviewed v2 coordinators", () => {
  const expectedOwners = new Map<string, Array<[string, number]>>([
    ["insertNode", [
      ["src/memory/tools-feedback-applied-authority.ts", 1],
      ["src/memory/write.ts", 1],
    ]],
    ["insertRuleDef", [["src/memory/write.ts", 1]]],
    ["upsertEdge", [["src/memory/write.ts", 1]]],
    ["updateNodeAnchorState", [
      ["src/memory/node-authority-mutation.ts", 1],
      ["src/memory/tools-feedback-applied-authority.ts", 1],
    ]],
    ["upsertRuleState", [["src/memory/rules.ts", 1]]],
    ["insertRuleFeedback", [
      ["src/memory/feedback.ts", 1],
      ["src/memory/tools-feedback-applied-authority.ts", 1],
    ]],
    ["updateRuleFeedbackAggregates", [
      ["src/memory/feedback.ts", 1],
      ["src/memory/tools-feedback-applied-authority.ts", 1],
    ]],
    ["updateExecutionDecisionLink", [
      ["src/memory/tools-feedback-applied-authority.ts", 1],
    ]],
  ]);
  const files = collectTypeScriptFiles(SRC_ROOT);

  for (const [method, expected] of expectedOwners) {
    const owners: Array<[string, number]> = [];
    const pattern = new RegExp(`\\.\\s*${method}\\s*\\(`, "gu");
    for (const file of files) {
      const count = [...fs.readFileSync(file, "utf8").matchAll(pattern)].length;
      if (count > 0) owners.push([relativeToRoot(file), count]);
    }
    assert.deepEqual(owners.sort(), expected, `${method} acquired an unreviewed production owner`);
  }
});

test("raw protected-table SQL stays in the write store and embedding projection changes no authority column", () => {
  const protectedTables = [
    "lite_memory_commits",
    "lite_memory_nodes",
    "lite_memory_edges",
    "lite_memory_rule_defs",
    "lite_memory_rule_feedback",
    "lite_memory_execution_decisions",
  ];
  const mutationPattern = new RegExp(
    `\\b(?:INSERT(?:\\s+OR\\s+[A-Z]+)?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(${protectedTables.join("|")})\\b`,
    "giu",
  );
  const allowedWriteStore = "src/store/lite-write-store.ts";
  const allowedProjection = "src/store/lite-projection-outbox.ts";
  const unexpected: Array<{ file: string; table: string }> = [];

  for (const file of collectTypeScriptFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, "utf8");
    const relative = relativeToRoot(file);
    for (const match of source.matchAll(mutationPattern)) {
      const table = match[1] ?? "unknown";
      if (relative === allowedWriteStore) continue;
      if (relative === allowedProjection && table === "lite_memory_nodes") continue;
      unexpected.push({ file: relative, table });
    }
  }
  assert.deepEqual(unexpected, []);

  const projectionSource = fs.readFileSync(path.join(ROOT, allowedProjection), "utf8");
  const projectionUpdates = [...projectionSource.matchAll(
    /UPDATE\s+lite_memory_nodes\s+SET([\s\S]*?)WHERE/giu,
  )];
  assert.ok(projectionUpdates.length > 0, "embedding projection must retain an explicit node update seam");
  const authorityColumns = [
    "client_id",
    "type",
    "tier",
    "title",
    "text_summary",
    "slots_json",
    "raw_ref",
    "evidence_ref",
    "memory_lane",
    "producer_agent_id",
    "owner_agent_id",
    "owner_team_id",
    "salience",
    "importance",
    "confidence",
    "redaction_version",
    "commit_id",
    "created_at",
  ];
  for (const update of projectionUpdates) {
    const setClause = update[1] ?? "";
    assert.match(setClause, /embedding_(?:vector_json|model|status|last_error)/u);
    for (const column of authorityColumns) {
      assert.doesNotMatch(
        setClause,
        new RegExp(`\\b${column}\\s*=`, "iu"),
        `embedding projection must not assign authority column ${column}`,
      );
    }
  }
});

test("production insertCommit rejects omitted and explicit v1 digests before touching SQLite", async () => {
  const temp = tempDatabase("runtime-rejection");
  const store = createLiteWriteStore(temp.databasePath, { annProjectionEnabled: false });
  try {
    const unsafeInsert = store.insertCommit.bind(store) as (
      args: Record<string, unknown>,
    ) => Promise<string>;

    await assert.rejects(
      unsafeInsert(legacyPayload),
      /lite_memory_commit_digest_v2_required/,
    );
    await assert.rejects(
      unsafeInsert({ ...legacyPayload, digestVersion: 1 }),
      /lite_memory_commit_digest_v2_required/,
    );

    const db = createSqliteDatabase(temp.databasePath);
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM lite_memory_commits",
      ).get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("explicit migration/test seam persists a readable v1 boundary without a v2 head", async () => {
  const temp = tempDatabase("legacy-seam");
  const store = createLiteWriteStore(temp.databasePath, { annProjectionEnabled: false });
  try {
    const createdAt = "2000-01-01T00:00:00.000Z";
    const commitId = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      ...legacyPayload,
      scope: "scope/legacy-seam",
      createdAt,
    });
    const replayCommitId = await store.insertLegacyV1CommitForMigrationOrTestFixture({
      ...legacyPayload,
      scope: "scope/legacy-seam",
      createdAt,
    });
    assert.equal(replayCommitId, commitId);

    assert.deepEqual(await store.readScopeHead("scope/legacy-seam"), {
      scope: "scope/legacy-seam",
      commitId,
      commitHash: legacyPayload.commitHash,
      revision: 0,
      digestVersion: 1,
      legacyAnchorCommitId: commitId,
      persisted: false,
      updatedAt: createdAt,
    });

    const db = createSqliteDatabase(temp.databasePath);
    try {
      const row = db.prepare(
        `SELECT digest_version, revision, mutation_digest, legacy_anchor_commit_id
         FROM lite_memory_commits
         WHERE id = ?`,
      ).get(commitId) as Record<string, unknown>;
      assert.deepEqual({ ...row }, {
        digest_version: 1,
        revision: null,
        mutation_digest: null,
        legacy_anchor_commit_id: null,
      });
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
