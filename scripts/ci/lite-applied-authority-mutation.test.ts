import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import stableStringify from "fast-json-stable-stringify";

import {
  runAppliedAuthorityMutationV2,
} from "../../src/memory/applied-authority-mutation.ts";
import {
  persistInitialExecutionDecisionAuthority,
} from "../../src/memory/execution-decision-authority.ts";
import { ruleFeedback } from "../../src/memory/feedback.ts";
import {
  ruleDefAuthorityRow,
  type RuleDefAuthorityRow,
} from "../../src/memory/rule-authority-mutation.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { applyMemoryWrite, prepareMemoryWrite } from "../../src/memory/write.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import {
  createLiteWriteStoreFromDatabase,
  type LiteWriteStore,
} from "../../src/store/lite-write-store.ts";
import type { WriteExistingNodeState } from "../../src/store/write-access.ts";
import {
  APPLIED_AUTHORITY_TABLE_CONTRACTS,
  buildCanonicalAppliedAuthorityMutationV2,
  materializeAppliedAuthorityRow,
  normalizeAppliedAuthorityRow,
} from "../../src/store/write-commit-authority.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

const writeOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type Fixture = {
  directory: string;
  database: ReturnType<typeof createLiteRuntimeDatabase>;
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
  created_at: string;
};

async function openFixture(): Promise<Fixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-applied-authority-"));
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

async function seedRule(fixture: Fixture, scope: string): Promise<string> {
  const prepared = await prepareMemoryWrite({
    tenant_id: "default",
    scope,
    actor: "authority-test",
    input_text: "Seed the rule used by the applied authority mutation tests.",
    auto_embed: false,
    memory_lane: "shared",
    nodes: [{
      client_id: "authority-rule",
      type: "rule",
      tier: "warm",
      title: "Authority test rule",
      text_summary: "Prefer read for authority mutation verification.",
      slots: {
        if: { task_kind: { $eq: "authority_test" } },
        then: { tool: { prefer: ["read"] } },
        exceptions: [],
        rule_scope: "global",
      },
    }],
    edges: [],
  }, "default", "default", writeOptions, null);
  const result = await fixture.store.withTx(() => applyMemoryWrite(prepared, {
    ...writeOptions,
    write_access: fixture.store,
  }));
  const ruleNodeId = result.nodes[0]?.id;
  assert.ok(ruleNodeId);
  return ruleNodeId;
}

function commits(fixture: Fixture, scope: string): CommitRow[] {
  return fixture.database.db.prepare(
    `SELECT id, parent_commit_id, diff_json, commit_hash, digest_version,
            revision, mutation_digest, created_at
     FROM lite_memory_commits
     WHERE scope = ?
     ORDER BY revision ASC`,
  ).all(scope) as CommitRow[];
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

function nodeAuthorityRow(state: WriteExistingNodeState): Record<string, unknown> {
  return {
    id: state.id,
    scope: state.scope,
    client_id: state.clientId,
    type: state.type,
    tier: state.tier,
    title: state.title,
    text_summary: state.textSummary,
    slots_json: JSON.parse(state.slotsJson),
    raw_ref: state.rawRef,
    evidence_ref: state.evidenceRef,
    embedding_vector_json: state.embeddingVector === null ? null : JSON.parse(state.embeddingVector),
    embedding_model: state.embeddingModel,
    memory_lane: state.memoryLane,
    producer_agent_id: state.producerAgentId,
    owner_agent_id: state.ownerAgentId,
    owner_team_id: state.ownerTeamId,
    embedding_status: state.embeddingStatus,
    embedding_last_error: state.embeddingLastError,
    salience: state.salience,
    importance: state.importance,
    confidence: state.confidence,
    redaction_version: state.redactionVersion,
    commit_id: state.commitId,
    created_at: state.createdAt,
  };
}

test("rule state and feedback use one exact v2 authority chain and stable no-op head", async () => {
  const fixture = await openFixture();
  const scope = "authority-rules";
  try {
    const ruleNodeId = await seedRule(fixture, scope);
    const activated = await updateRuleState({
      tenant_id: "default",
      scope,
      actor: "authority-test",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "Activate the authority test rule.",
    }, "default", "default", { liteWriteStore: fixture.store });
    const beforeNoOp = await fixture.store.getRuleDef(scope, ruleNodeId);
    assert.ok(beforeNoOp);

    const replay = await updateRuleState({
      tenant_id: "default",
      scope,
      actor: "authority-test",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "Repeat the same authoritative rule state.",
    }, "default", "default", { liteWriteStore: fixture.store });
    assert.equal(replay.commit_id, activated.commit_id);
    assert.equal(replay.commit_hash, activated.commit_hash);
    assert.deepEqual(await fixture.store.getRuleDef(scope, ruleNodeId), beforeNoOp);

    const feedback = await ruleFeedback({
      tenant_id: "default",
      scope,
      actor: "authority-test",
      rule_node_id: ruleNodeId,
      run_id: "run:authority-test",
      outcome: "positive",
      note: "The selected rule improved the run.",
      input_text: "Record positive authority feedback.",
    }, "default", "default", {
      ...writeOptions,
      liteWriteStore: fixture.store,
    });

    const rows = commits(fixture, scope);
    assert.equal(rows.length, 3, "seed + state transition + feedback; no-op creates no commit");
    for (const [index, row] of rows.entries()) {
      assert.equal(row.digest_version, 2);
      assert.equal(row.revision, index + 1);
      assert.equal(row.parent_commit_id, index === 0 ? null : rows[index - 1]?.id);
      assert.equal(row.mutation_digest, sha256Hex(row.diff_json));
    }

    const stateCommit = rows[1]!;
    const stateMutation = JSON.parse(stateCommit.diff_json) as Record<string, any>;
    assert.equal(stateMutation.contract, "aionis_applied_authority_mutation_v2");
    assert.equal(stateMutation.authority_kind, "rule_state_change");
    assert.equal(stateMutation.applied_at, stateCommit.created_at);
    assert.equal(stateMutation.mutations.length, 1);
    assert.deepEqual(
      sortedKeys(stateMutation.mutations[0].after),
      [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_rule_defs.rowKeys].sort(),
    );
    assert.equal(stateMutation.mutations[0].after.commit_id, "$self");

    const feedbackCommit = rows[2]!;
    const feedbackMutation = JSON.parse(feedbackCommit.diff_json) as Record<string, any>;
    assert.equal(feedbackMutation.authority_kind, "rule_feedback");
    assert.deepEqual(
      feedbackMutation.mutations.map((mutation: any) => mutation.table),
      ["lite_memory_rule_defs", "lite_memory_rule_feedback"],
    );
    assert.deepEqual(
      sortedKeys(feedbackMutation.mutations[1].after),
      [...APPLIED_AUTHORITY_TABLE_CONTRACTS.lite_memory_rule_feedback.rowKeys].sort(),
    );

    const actualRule = await fixture.store.getRuleDef(scope, ruleNodeId);
    const actualFeedback = await fixture.store.getRuleFeedback(scope, feedback.feedback_id);
    assert.ok(actualRule);
    assert.ok(actualFeedback);
    assert.equal(actualRule.positive_count, 1);
    assert.equal(actualRule.negative_count, 0);
    assert.equal(actualRule.commit_id, feedback.commit_id);
    assert.equal(actualRule.updated_at, feedbackMutation.applied_at);
    assert.equal(actualFeedback.commit_id, feedback.commit_id);
    assert.equal(actualFeedback.created_at, feedbackMutation.applied_at);
    assert.equal(feedback.commit_id, feedbackCommit.id);
    assert.equal(feedback.commit_hash, feedbackCommit.commit_hash);
  } finally {
    await closeFixture(fixture);
  }
});

test("authority read-after mismatch and mutating plan roll back domain rows, commit, and head", async () => {
  const fixture = await openFixture();
  const scope = "authority-rollback";
  try {
    const ruleNodeId = await seedRule(fixture, scope);
    await updateRuleState({
      tenant_id: "default",
      scope,
      actor: "authority-test",
      rule_node_id: ruleNodeId,
      state: "active",
      input_text: "Activate the rollback rule.",
    }, "default", "default", { liteWriteStore: fixture.store });

    const rowBefore = await fixture.store.getRuleDef(scope, ruleNodeId);
    const headBefore = await fixture.store.readScopeHead(scope);
    const commitsBefore = commits(fixture, scope);
    assert.ok(rowBefore);
    assert.ok(headBefore);

    await assert.rejects(
      () => runAppliedAuthorityMutationV2<void>({
        store: fixture.store,
        scope,
        inputSha256: sha256Hex("mismatched read-after verification"),
        actor: "authority-test",
        expectedHeadRevision: headBefore.revision,
        expectedHeadCommitId: headBefore.commitId,
        plan: async ({ appliedAt }) => {
          const current = await fixture.store.getRuleDef(scope, ruleNodeId);
          assert.ok(current);
          const before = ruleDefAuthorityRow(current);
          const expectedAfter: RuleDefAuthorityRow = {
            ...current,
            state: "disabled",
            commit_id: "$self",
            updated_at: appliedAt,
          };
          const after = ruleDefAuthorityRow(expectedAfter);
          const identity = { scope, rule_node_id: ruleNodeId };
          return {
            status: "mutate",
            authorityKind: "rule_state_change",
            mutations: [{
              table: "lite_memory_rule_defs",
              identity,
              operation: "update",
              before,
              after,
            }],
            apply: async ({ commitId }) => {
              await fixture.store.upsertRuleState({
                scope,
                ruleNodeId,
                state: "shadow",
                ifJson: current.if_json,
                thenJson: current.then_json,
                exceptionsJson: current.exceptions_json,
                ruleScope: current.rule_scope,
                targetAgentId: current.target_agent_id,
                targetTeamId: current.target_team_id,
                positiveCount: current.positive_count,
                negativeCount: current.negative_count,
                commitId,
                createdAt: current.created_at,
                updatedAt: appliedAt,
              });
            },
            verify: async ({ commitId }) => {
              const actual = await fixture.store.getRuleDef(scope, ruleNodeId);
              assert.ok(actual);
              return [{
                table: "lite_memory_rule_defs",
                identity,
                after: normalizeAppliedAuthorityRow(
                  "lite_memory_rule_defs",
                  ruleDefAuthorityRow(actual),
                  commitId,
                ),
              }];
            },
          };
        },
      }),
      /applied_authority_read_after_verification_mismatch/,
    );
    assert.deepEqual(await fixture.store.getRuleDef(scope, ruleNodeId), rowBefore);
    assert.deepEqual(await fixture.store.readScopeHead(scope), headBefore);
    assert.deepEqual(commits(fixture, scope), commitsBefore);

    await assert.rejects(
      () => runAppliedAuthorityMutationV2<void>({
        store: fixture.store,
        scope,
        inputSha256: sha256Hex("illegal planning write"),
        actor: "authority-test",
        plan: async ({ appliedAt }) => {
          await fixture.store.upsertRuleState({
            scope,
            ruleNodeId,
            state: "disabled",
            ifJson: rowBefore.if_json,
            thenJson: rowBefore.then_json,
            exceptionsJson: rowBefore.exceptions_json,
            ruleScope: rowBefore.rule_scope,
            targetAgentId: rowBefore.target_agent_id,
            targetTeamId: rowBefore.target_team_id,
            positiveCount: rowBefore.positive_count,
            negativeCount: rowBefore.negative_count,
            commitId: rowBefore.commit_id,
            createdAt: rowBefore.created_at,
            updatedAt: appliedAt,
          });
          return { status: "no_op", value: undefined };
        },
      }),
      /applied_authority_plan_must_be_read_only/,
    );
    assert.deepEqual(await fixture.store.getRuleDef(scope, ruleNodeId), rowBefore);
    assert.deepEqual(await fixture.store.readScopeHead(scope), headBefore);
    assert.deepEqual(commits(fixture, scope), commitsBefore);
  } finally {
    await closeFixture(fixture);
  }
});

test("$self is materialized only at authority reference paths and literal user values survive read-after verification", async () => {
  const fixture = await openFixture();
  const scope = "authority-self-reference-paths";
  const appliedAt = "2026-07-19T00:00:00.000Z";
  try {
    const slots = {
      literal: "$self",
      nested: {
        literal: "$self",
        coincidentally_a_commit_id: "authority-commit-id",
      },
    };
    const nodeAfter = {
      id: "self-literal-node",
      scope,
      client_id: null,
      type: "procedure",
      tier: "warm",
      title: "Literal self reference",
      text_summary: "The literal $self in slots is user data.",
      slots_json: slots,
      raw_ref: null,
      evidence_ref: null,
      embedding_vector_json: null,
      embedding_model: null,
      memory_lane: "shared",
      producer_agent_id: null,
      owner_agent_id: null,
      owner_team_id: null,
      embedding_status: "pending",
      embedding_last_error: null,
      salience: 0.4,
      importance: 0.5,
      confidence: 0.6,
      redaction_version: 0,
      commit_id: "$self",
      created_at: appliedAt,
    };
    const nodeIdentity = { scope, id: nodeAfter.id };
    const nodeAuthority = await runAppliedAuthorityMutationV2<void>({
      store: fixture.store,
      scope,
      inputSha256: sha256Hex("authority self reference path regression"),
      actor: "authority-test",
      plan: async () => ({
        status: "mutate",
        authorityKind: "self_reference_path_guard",
        mutations: [{
          table: "lite_memory_nodes",
          identity: nodeIdentity,
          operation: "insert",
          before: null,
          after: nodeAfter,
        }],
        apply: async ({ commitId }) => {
          const materialized = materializeAppliedAuthorityRow(
            "lite_memory_nodes",
            nodeAfter,
            commitId,
          );
          await fixture.store.insertNode({
            id: String(materialized.id),
            scope: String(materialized.scope),
            clientId: null,
            type: String(materialized.type),
            tier: String(materialized.tier),
            title: String(materialized.title),
            textSummary: String(materialized.text_summary),
            slotsJson: JSON.stringify(materialized.slots_json),
            rawRef: null,
            evidenceRef: null,
            embeddingVector: null,
            embeddingModel: null,
            memoryLane: "shared",
            producerAgentId: null,
            ownerAgentId: null,
            ownerTeamId: null,
            embeddingStatus: "pending",
            embeddingLastError: null,
            salience: 0.4,
            importance: 0.5,
            confidence: 0.6,
            redactionVersion: 0,
            commitId,
            createdAt: appliedAt,
          });
        },
        verify: async ({ commitId }) => {
          const state = (await fixture.store.nodeStatesByIds(scope, [nodeAfter.id])).get(nodeAfter.id);
          assert.ok(state);
          return [{
            table: "lite_memory_nodes",
            identity: nodeIdentity,
            after: normalizeAppliedAuthorityRow(
              "lite_memory_nodes",
              nodeAuthorityRow(state),
              commitId,
            ),
          }];
        },
      }),
    });
    assert.equal(nodeAuthority.status, "applied");
    const storedNode = (await fixture.store.nodeStatesByIds(scope, [nodeAfter.id])).get(nodeAfter.id);
    assert.ok(storedNode);
    assert.deepEqual(JSON.parse(storedNode.slotsJson), slots);
    assert.equal(storedNode.commitId, nodeAuthority.commitId);

    const decision = await persistInitialExecutionDecisionAuthority({
      store: fixture.store,
      actor: "authority-test",
      decision: {
        id: "self-literal-decision",
        scope,
        decisionKind: "tools_select",
        runId: null,
        selectedTool: "read",
        candidatesJson: [{
          tool: "$self",
          metadata: { literal: "$self", coincidentally_a_commit_id: nodeAuthority.commitId },
        }],
        contextSha256: "a".repeat(64),
        policySha256: "b".repeat(64),
        sourceRuleIds: [],
        metadataJson: {
          literal: "$self",
          nested: { coincidentally_a_commit_id: nodeAuthority.commitId },
        },
        commitId: null,
        createdAt: "2026-07-19T00:00:01.000Z",
      },
    });
    assert.equal(decision.authority_commit.revision, 2);
    const storedDecision = await fixture.store.getExecutionDecision({ scope, id: "self-literal-decision" });
    assert.ok(storedDecision);
    assert.deepEqual(storedDecision.candidates_json, [{
      tool: "$self",
      metadata: { literal: "$self", coincidentally_a_commit_id: nodeAuthority.commitId },
    }]);
    assert.deepEqual(storedDecision.metadata_json, {
      literal: "$self",
      nested: { coincidentally_a_commit_id: nodeAuthority.commitId },
    });

    const normalized = normalizeAppliedAuthorityRow(
      "lite_memory_execution_decisions",
      {
        ...storedDecision,
        commit_id: decision.authority_commit.commit_id,
        candidates_json: [{ nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id } }],
        metadata_json: { nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id } },
        source_rule_ids_json: storedDecision.source_rule_ids,
      },
      decision.authority_commit.commit_id,
    );
    assert.equal(normalized.commit_id, "$self");
    assert.deepEqual(normalized.candidates_json, [{
      nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id },
    }]);
    assert.deepEqual(normalized.metadata_json, {
      nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id },
    });

    const operationReferencePaths = materializeAppliedAuthorityRow(
      "lite_runtime_write_operations",
      {
        tenant_id: "default",
        scope,
        operation_kind: "self_reference_path_guard",
        operation_id: "self-reference-operation",
        request_sha256: "c".repeat(64),
        receipt_json: {
          result_commit_id: "$self",
          literal: "$self",
          nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id },
        },
        commit_id: "$self",
        created_at: "2026-07-19T00:00:02.000Z",
      },
      decision.authority_commit.commit_id,
    );
    assert.equal(operationReferencePaths.commit_id, decision.authority_commit.commit_id);
    assert.deepEqual(operationReferencePaths.receipt_json, {
      result_commit_id: decision.authority_commit.commit_id,
      literal: "$self",
      nested: { coincidentally_a_commit_id: decision.authority_commit.commit_id },
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("authority table registry rejects unknown, partial, and disallowed table mutations", () => {
  const appliedAt = "2026-07-18T00:00:00.000Z";
  const feedbackAfter = {
    id: "feedback-1",
    scope: "authority-contract",
    rule_node_id: "rule-1",
    run_id: null,
    outcome: "positive",
    note: null,
    source: "rule_feedback",
    decision_id: null,
    commit_id: "$self",
    created_at: appliedAt,
  };
  const { created_at: _createdAt, ...partialFeedbackAfter } = feedbackAfter;

  assert.throws(() => buildCanonicalAppliedAuthorityMutationV2({
    appliedAt,
    authorityKind: "tamper_test",
    mutations: [{
      table: "lite_memory_unregistered",
      identity: { scope: "authority-contract", id: "unknown-1" },
      operation: "insert",
      before: null,
      after: { id: "unknown-1", scope: "authority-contract", commit_id: "$self" },
    }],
  }), /authority_table_not_registered/);

  assert.throws(() => buildCanonicalAppliedAuthorityMutationV2({
    appliedAt,
    authorityKind: "tamper_test",
    mutations: [{
      table: "lite_memory_rule_feedback",
      identity: { scope: "authority-contract", id: "feedback-1" },
      operation: "insert",
      before: null,
      after: partialFeedbackAfter,
    }],
  }), /authority_after_row_keys_invalid|authority_after/);

  assert.throws(() => buildCanonicalAppliedAuthorityMutationV2({
    appliedAt,
    authorityKind: "tamper_test",
    mutations: [{
      table: "lite_memory_rule_feedback",
      identity: { scope: "authority-contract", id: "feedback-1" },
      operation: "update",
      before: feedbackAfter,
      after: feedbackAfter,
    }],
  }), /authority_operation_invalid/);

  const canonical = buildCanonicalAppliedAuthorityMutationV2({
    appliedAt,
    authorityKind: "tamper_test",
    mutations: [{
      table: "lite_memory_rule_feedback",
      identity: { scope: "authority-contract", id: "feedback-1" },
      operation: "insert",
      before: null,
      after: feedbackAfter,
    }],
  });
  assert.equal(stableStringify(canonical), stableStringify(JSON.parse(stableStringify(canonical))));
});
