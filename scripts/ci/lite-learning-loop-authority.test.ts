import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sealAuthorityReceiptsForPreparedWrite } from "./authority-fixture-helpers.ts";
import { runLearningLoopLite } from "../../src/memory/learning-loop.ts";
import { PolicyContractSchema } from "../../src/memory/schemas.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { SELF_COMMIT_REFERENCE } from "../../src/memory/write-serialization.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabase,
} from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import type { WriteExistingNodeState } from "../../src/store/write-access.ts";
import { APPLIED_AUTHORITY_TABLE_CONTRACTS } from "../../src/store/write-commit-authority.ts";
import { stableUuid } from "../../src/util/uuid.ts";

const writeOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

const loopOptions = {
  defaultScope: "default",
  defaultTenantId: "default",
  ...writeOptions,
};

type Fixture = {
  directory: string;
  database: LiteRuntimeDatabase;
  store: LiteWriteStore;
};

type CommitRow = {
  id: string;
  parent_commit_id: string | null;
  diff_json: string;
  commit_hash: string;
  digest_version: number;
  revision: number;
  mutation_digest: string;
};

function openFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-learning-loop-authority-"));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  return {
    directory,
    database,
    store: createLiteWriteStoreFromDatabase(database),
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.store.close();
  await fixture.database.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

async function seedNodes(
  fixture: Fixture,
  nodes: Array<Record<string, unknown>>,
  inputText: string,
): Promise<void> {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope: "default",
    actor: "learning-loop-authority-test",
    input_text: inputText,
    auto_embed: false,
    distill: { enabled: false },
    nodes,
    edges: [],
  }, "default", "default", writeOptions, null);
  sealAuthorityReceiptsForPreparedWrite(prepared);
  await fixture.store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: fixture.store,
  }));
}

function commits(fixture: Fixture): CommitRow[] {
  return fixture.database.db.prepare(
    `SELECT id, parent_commit_id, diff_json, commit_hash, digest_version,
            revision, mutation_digest
     FROM lite_memory_commits
     WHERE scope = 'default'
     ORDER BY revision ASC`,
  ).all() as CommitRow[];
}

async function nodeState(store: LiteWriteStore, id: string): Promise<WriteExistingNodeState> {
  const state = (await store.nodeStatesByIds("default", [id])).get(id);
  assert.ok(state);
  return state;
}

function assertNodeAuthorityCommit(row: CommitRow, authorityKind: string): Record<string, any> {
  assert.equal(row.digest_version, 2);
  const diff = JSON.parse(row.diff_json) as Record<string, any>;
  assert.equal(diff.contract, "aionis_applied_authority_mutation_v2");
  assert.equal(diff.digest_version, 2);
  assert.equal(diff.authority_kind, authorityKind);
  assert.equal(diff.mutations.length, 1);
  const mutation = diff.mutations[0] as Record<string, any>;
  assert.equal(mutation.table, "lite_memory_nodes");
  assert.equal(mutation.operation, "update");
  const rowKeys = [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_nodes.rowKeys].sort();
  assert.deepEqual(Object.keys(mutation.before).sort(), rowKeys);
  assert.deepEqual(Object.keys(mutation.after).sort(), rowKeys);
  assert.equal(mutation.after.commit_id, SELF_COMMIT_REFERENCE);
  return mutation;
}

test("controlled forgetting commits two nodes as consecutive v2 authority revisions", async () => {
  const fixture = openFixture();
  const archiveId = stableUuid("default:node:learning-loop-authority:archive");
  const demoteId = stableUuid("default:node:learning-loop-authority:demote");
  try {
    await seedNodes(fixture, [
      {
        id: archiveId,
        client_id: "learning-loop-authority:archive",
        type: "concept",
        tier: "cold",
        memory_lane: "shared",
        producer_agent_id: "learning-loop-authority-test",
        title: "Retired policy memory",
        text_summary: "A retired high-level policy should move to archive.",
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
        id: demoteId,
        client_id: "learning-loop-authority:demote",
        type: "concept",
        tier: "hot",
        memory_lane: "shared",
        producer_agent_id: "learning-loop-authority-test",
        title: "Contested pattern memory",
        text_summary: "A contested pattern should cool by one tier.",
        slots: {
          summary_kind: "pattern_anchor",
          compression_layer: "L3",
          anchor_v1: { anchor_kind: "pattern", credibility_state: "contested" },
          feedback_positive: 1,
          feedback_negative: 2,
          feedback_quality: -0.2,
        },
        salience: 0.55,
        importance: 0.55,
        confidence: 0.55,
      },
    ], "seed consecutive controlled forgetting nodes");

    const result = await runLearningLoopLite(fixture.store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-authority-test",
      mode: "apply",
      surfaces: ["forgetting"],
      limit: 10,
    }, loopOptions);
    assert.equal(result.applied_count, 2);

    const rows = commits(fixture);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.digest_version), [2, 2, 2]);
    assert.deepEqual(rows.map((row) => row.revision), [1, 2, 3]);
    assert.deepEqual(rows.map((row) => row.parent_commit_id), [null, rows[0]!.id, rows[1]!.id]);
    const firstMutation = assertNodeAuthorityCommit(rows[1]!, "learning_loop_controlled_forgetting");
    const secondMutation = assertNodeAuthorityCommit(rows[2]!, "learning_loop_controlled_forgetting");
    assert.deepEqual(
      new Set([firstMutation.identity.id, secondMutation.identity.id]),
      new Set([archiveId, demoteId]),
    );
    assert.deepEqual(
      new Set(result.decisions.filter((entry) => entry.applied).map((entry) => entry.commit_id)),
      new Set([rows[1]!.id, rows[2]!.id]),
    );

    const archived = await nodeState(fixture.store, archiveId);
    const demoted = await nodeState(fixture.store, demoteId);
    assert.equal(archived.tier, "archive");
    assert.equal(demoted.tier, "warm");
    assert.equal(new Set([archived.commitId, demoted.commitId]).size, 2);
    assert.deepEqual(new Set([archived.commitId, demoted.commitId]), new Set([rows[1]!.id, rows[2]!.id]));
  } finally {
    await closeFixture(fixture);
  }
});

test("policy retirement persists lifecycle, mutation, and adjudication in one v2 node commit", async () => {
  const fixture = openFixture();
  const policyId = stableUuid("default:node:learning-loop-authority:policy-retirement");
  try {
    const contract = PolicyContractSchema.parse({
      summary_version: "policy_contract_v1",
      policy_kind: "tool_preference",
      source_kind: "trusted_pattern",
      policy_state: "stable",
      contract_trust: "authoritative",
      policy_memory_state: "active",
      activation_mode: "default",
      materialization_state: "persisted",
      history_applied: true,
      selected_tool: "read",
      avoid_tools: [],
      workflow_signature: "workflow:learning-loop-policy-retirement",
      file_path: null,
      target_files: [],
      next_action: "Use read while this policy remains active.",
      rehydration_mode: null,
      confidence: 0.82,
      source_anchor_ids: [policyId],
      policy_memory_id: policyId,
      reason: "Seed an active policy with enough negative feedback for retirement.",
    });
    await seedNodes(fixture, [{
      id: policyId,
      client_id: "learning-loop-authority:policy-retirement",
      type: "concept",
      tier: "warm",
      memory_lane: "shared",
      producer_agent_id: "learning-loop-authority-test",
      title: "Policy memory ready for retirement",
      text_summary: "Active policy memory with repeated negative feedback.",
      slots: {
        summary_kind: "policy_memory",
        compression_layer: "L4",
        materialization_state: "persisted",
        policy_memory_state: "active",
        policy_memory_signature: "policy:learning-loop-authority",
        selected_tool: "read",
        workflow_signature: contract.workflow_signature,
        source_anchor_ids: contract.source_anchor_ids,
        feedback_positive: 0,
        feedback_negative: 3,
        feedback_quality: -1,
        policy_contract_v1: contract,
      },
      salience: 0.65,
      importance: 0.7,
      confidence: 0.82,
    }], "seed policy retirement authority node");

    const result = await runLearningLoopLite(fixture.store, {
      tenant_id: "default",
      scope: "default",
      actor: "learning-loop-authority-test",
      mode: "apply",
      surfaces: ["policy"],
      limit: 10,
    }, loopOptions);
    assert.equal(result.applied_count, 1);
    const retirement = result.decisions.find((entry) => entry.target_id === policyId);
    assert.equal(retirement?.action, "retire_policy");
    assert.equal(retirement?.applied, true);
    assert.ok(retirement?.commit_id);
    assert.ok(retirement?.policy_mutation_v1);
    assert.ok(retirement?.policy_mutation_adjudication_v1);

    const rows = commits(fixture);
    assert.equal(rows.length, 2, "retirement is one commit, not lifecycle then decoration");
    assert.deepEqual(rows.map((row) => row.digest_version), [2, 2]);
    assert.deepEqual(rows.map((row) => row.revision), [1, 2]);
    assert.equal(rows[1]!.parent_commit_id, rows[0]!.id);
    const mutation = assertNodeAuthorityCommit(rows[1]!, "learning_loop_policy_retirement");
    assert.equal(mutation.identity.id, policyId);
    assert.equal(mutation.after.commit_id, SELF_COMMIT_REFERENCE);
    assert.equal(mutation.after.slots_json.policy_memory_state, "retired");
    assert.equal(mutation.after.slots_json.policy_contract_v1.policy_memory_state, "retired");
    assert.equal(mutation.after.slots_json.learning_loop_v1.action, "retire_policy");
    assert.ok(mutation.after.slots_json.policy_mutation_v1);
    assert.ok(mutation.after.slots_json.policy_mutation_adjudication_v1);

    const persisted = await nodeState(fixture.store, policyId);
    const persistedSlots = JSON.parse(persisted.slotsJson) as Record<string, any>;
    assert.equal(persisted.commitId, rows[1]!.id);
    assert.equal(persistedSlots.policy_memory_state, "retired");
    assert.equal(persistedSlots.policy_contract_v1.policy_memory_state, "retired");
    assert.equal(retirement?.commit_id, persisted.commitId);
  } finally {
    await closeFixture(fixture);
  }
});

test("controlled forgetting read-after mismatch rolls back node, commit, head, and side effects", async () => {
  const fixture = openFixture();
  const nodeId = stableUuid("default:node:learning-loop-authority:rollback");
  try {
    await seedNodes(fixture, [{
      id: nodeId,
      client_id: "learning-loop-authority:rollback",
      type: "concept",
      tier: "hot",
      memory_lane: "shared",
      producer_agent_id: "learning-loop-authority-test",
      title: "Rollback controlled forgetting",
      text_summary: "Trigger-induced divergence must roll back the authority transaction.",
      slots: {
        summary_kind: "pattern_anchor",
        compression_layer: "L3",
        anchor_v1: { anchor_kind: "pattern", credibility_state: "contested" },
        feedback_positive: 0,
        feedback_negative: 3,
        feedback_quality: -1,
      },
      salience: 0.5,
      importance: 0.5,
      confidence: 0.5,
    }], "seed controlled forgetting rollback node");
    const beforeNode = await nodeState(fixture.store, nodeId);
    const beforeHead = await fixture.store.readScopeHead("default");
    const beforeCommits = commits(fixture);
    const beforeProjectionJobs = fixture.database.db.prepare(
      "SELECT * FROM lite_memory_projection_jobs WHERE scope = 'default' ORDER BY job_kind, node_id",
    ).all();

    fixture.database.db.exec(`
      CREATE TRIGGER corrupt_learning_loop_authority_read_after
      AFTER UPDATE OF tier, slots_json, confidence ON lite_memory_nodes
      WHEN NEW.scope = 'default' AND NEW.id = '${nodeId}'
      BEGIN
        UPDATE lite_memory_nodes
        SET confidence = NEW.confidence - 0.125
        WHERE scope = NEW.scope AND id = NEW.id;
      END
    `);

    await assert.rejects(
      () => runLearningLoopLite(fixture.store, {
        tenant_id: "default",
        scope: "default",
        actor: "learning-loop-authority-test",
        mode: "apply",
        surfaces: ["forgetting"],
        limit: 10,
      }, loopOptions),
      /applied_authority_read_after_verification_mismatch/,
    );

    assert.deepEqual(await nodeState(fixture.store, nodeId), beforeNode);
    assert.deepEqual(await fixture.store.readScopeHead("default"), beforeHead);
    assert.deepEqual(commits(fixture), beforeCommits);
    assert.deepEqual(fixture.database.db.prepare(
      "SELECT * FROM lite_memory_projection_jobs WHERE scope = 'default' ORDER BY job_kind, node_id",
    ).all(), beforeProjectionJobs);
  } finally {
    await closeFixture(fixture);
  }
});
