import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  persistInitialExecutionDecisionAuthority,
  type InitialExecutionDecisionWrite,
} from "../../src/memory/execution-decision-authority.ts";
import { selectTools } from "../../src/memory/tools-select.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import { APPLIED_AUTHORITY_TABLE_CONTRACTS } from "../../src/store/write-commit-authority.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

type Fixture = Readonly<{
  directory: string;
  database: ReturnType<typeof createLiteRuntimeDatabase>;
  store: LiteWriteStore;
}>;

type CommitRow = Readonly<{
  id: string;
  scope: string;
  parent_commit_id: string | null;
  input_sha256: string;
  diff_json: string;
  actor: string;
  commit_hash: string;
  digest_version: number;
  revision: number;
  mutation_digest: string;
  created_at: string;
}>;

function openFixture(name: string): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-decision-authority-${name}-`));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  return {
    directory,
    database,
    store: createLiteWriteStoreFromDatabase(database, { annProjectionEnabled: false }),
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.store.close();
  await fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function commits(fixture: Fixture, scope?: string): CommitRow[] {
  return fixture.database.db.prepare(
    `SELECT id, scope, parent_commit_id, input_sha256, diff_json, actor,
            commit_hash, digest_version, revision, mutation_digest, created_at
     FROM lite_memory_commits
     ${scope ? "WHERE scope = ?" : ""}
     ORDER BY scope ASC, revision ASC`,
  ).all(...(scope ? [scope] : [])) as CommitRow[];
}

function decision(args: {
  id: string;
  scope: string;
  selectedTool?: string;
  createdAt?: string;
}): InitialExecutionDecisionWrite {
  return {
    id: args.id,
    scope: args.scope,
    decisionKind: "tools_select",
    runId: `run:${args.scope}`,
    selectedTool: args.selectedTool ?? "read",
    candidatesJson: ["read", "bash"],
    contextSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    sourceRuleIds: [],
    metadataJson: { strict: true, nested: { first: 1, second: 2 } },
    commitId: null,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
}

test("direct tools select creates a first v2 head with the complete decision row", async () => {
  const fixture = openFixture("direct-select");
  const scope = "decision-authority-direct";
  try {
    const result = await selectTools({
      tenant_id: "default",
      scope,
      run_id: "run:decision-authority-direct",
      context: { task_signature: "decision-authority-direct" },
      candidates: ["read", "bash"],
      include_shadow: false,
      rules_limit: 20,
      strict: true,
      reorder_candidates: false,
    }, "default", "default", {
      liteWriteStore: fixture.store,
      actor: "decision-authority-test",
    });

    const row = await fixture.store.getExecutionDecision({
      scope,
      id: result.decision.decision_id,
    });
    assert.ok(row);
    assert.equal(row.created_at, result.decision.created_at);
    assert.equal(row.selected_tool, result.decision.selected_tool);
    assert.equal(row.commit_id !== null, true);

    const rows = commits(fixture, scope);
    assert.equal(rows.length, 1);
    const commit = rows[0]!;
    assert.equal(commit.parent_commit_id, null);
    assert.equal(commit.digest_version, 2);
    assert.equal(commit.revision, 1);
    assert.equal(commit.actor, "decision-authority-test");
    assert.equal(commit.mutation_digest, sha256Hex(commit.diff_json));
    assert.equal(commit.id, row.commit_id);
    const head = await fixture.store.readScopeHead(scope);
    assert.ok(head);
    assert.equal(head.scope, scope);
    assert.equal(head.commitId, commit.id);
    assert.equal(head.commitHash, commit.commit_hash);
    assert.equal(head.revision, 1);
    assert.equal(head.digestVersion, 2);
    assert.equal(head.legacyAnchorCommitId, null);
    assert.equal(head.persisted, true);
    assert.equal(Number.isFinite(Date.parse(head.updatedAt)), true);

    const diff = JSON.parse(commit.diff_json) as Record<string, any>;
    assert.equal(diff.authority_kind, "execution_decision_initial_receipt");
    assert.equal(diff.mutations.length, 1);
    assert.equal(diff.mutations[0].operation, "insert");
    assert.equal(diff.mutations[0].before, null);
    assert.equal(diff.mutations[0].after.commit_id, "$self");
    assert.deepEqual(
      Object.keys(diff.mutations[0].after).sort(),
      [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_execution_decisions.rowKeys].sort(),
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("decision id collisions fail closed and never replace a row from another scope", async () => {
  const fixture = openFixture("collision");
  const id = "00000000-0000-4000-8000-000000000001";
  try {
    const first = await persistInitialExecutionDecisionAuthority({
      store: fixture.store,
      decision: decision({ id, scope: "decision-authority-a", selectedTool: "read" }),
      actor: "decision-authority-test",
    });
    const original = await fixture.store.getExecutionDecision({
      scope: "decision-authority-a",
      id,
    });
    assert.ok(original);

    await assert.rejects(
      persistInitialExecutionDecisionAuthority({
        store: fixture.store,
        decision: decision({ id, scope: "decision-authority-a", selectedTool: "bash" }),
        actor: "decision-authority-test",
      }),
      /execution_decision_initial_id_collision/u,
    );
    await assert.rejects(
      persistInitialExecutionDecisionAuthority({
        store: fixture.store,
        decision: decision({ id, scope: "decision-authority-b", selectedTool: "bash" }),
        actor: "decision-authority-test",
      }),
      /UNIQUE constraint failed: lite_memory_execution_decisions\.id/u,
    );

    assert.deepEqual(
      await fixture.store.getExecutionDecision({ scope: "decision-authority-a", id }),
      original,
    );
    assert.equal(
      await fixture.store.getExecutionDecision({ scope: "decision-authority-b", id }),
      null,
    );
    assert.equal(await fixture.store.readScopeHead("decision-authority-b"), null);
    assert.deepEqual(commits(fixture).map((row) => row.id), [first.authority_commit.commit_id]);
  } finally {
    await closeFixture(fixture);
  }
});

test("decision exact read-after rejects trigger tampering and rolls back row commit and head", async () => {
  const fixture = openFixture("tamper");
  const scope = "decision-authority-tamper";
  const id = "00000000-0000-4000-8000-000000000002";
  try {
    fixture.database.db.exec(`
      CREATE TRIGGER tamper_execution_decision_after_insert
      AFTER INSERT ON lite_memory_execution_decisions
      BEGIN
        UPDATE lite_memory_execution_decisions
        SET policy_sha256 = '${"f".repeat(64)}'
        WHERE id = NEW.id;
      END;
    `);

    await assert.rejects(
      persistInitialExecutionDecisionAuthority({
        store: fixture.store,
        decision: decision({ id, scope }),
        actor: "decision-authority-test",
      }),
      /applied_authority_read_after_verification_mismatch/u,
    );
    assert.equal(await fixture.store.getExecutionDecision({ scope, id }), null);
    assert.equal(await fixture.store.readScopeHead(scope), null);
    assert.deepEqual(commits(fixture, scope), []);
  } finally {
    await closeFixture(fixture);
  }
});
