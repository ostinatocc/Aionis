import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import stableStringify from "fast-json-stable-stringify";
import { prepareMemoryWrite, applyMemoryWrite } from "../../src/memory/write.ts";
import {
  SELF_COMMIT_REFERENCE,
  buildCanonicalAppliedWriteMutation,
  canonicalAppliedMutationJson,
  type CanonicalAppliedWriteMutationV2,
  type CanonicalEdgeMutationV2,
} from "../../src/memory/write-serialization.ts";
import { createLiteRuntimeDatabase } from "../../src/store/lite-runtime-database.ts";
import { createLiteWriteStoreFromDatabase } from "../../src/store/lite-write-store.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

const writeOptions = {
  maxTextLen: 10_000,
  piiRedaction: false,
  allowCrossScopeEdges: false,
} as const;

type CommitRow = {
  id: string;
  parent_commit_id: string | null;
  input_sha256: string;
  diff_json: string;
  actor: string;
  model_version: string | null;
  prompt_version: string | null;
  commit_hash: string;
  created_at: string;
  digest_version: number;
  revision: number;
  mutation_digest: string;
  legacy_anchor_commit_id: string | null;
};

type EdgeRow = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  metadata_json: string;
  commit_id: string;
  created_at: string;
};

type NodeRow = {
  id: string;
  scope: string;
  client_id: string | null;
  type: string;
  tier: string;
  title: string | null;
  text_summary: string | null;
  slots_json: string;
  raw_ref: string | null;
  evidence_ref: string | null;
  embedding_vector_json: string | null;
  embedding_model: string | null;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: "pending" | "ready" | "failed";
  embedding_last_error: string | null;
  salience: number;
  importance: number;
  confidence: number;
  redaction_version: number;
  commit_id: string;
  created_at: string;
};

type RuleDefRow = {
  rule_node_id: string;
  scope: string;
  state: "draft" | "shadow" | "active" | "disabled";
  if_json: string;
  then_json: string;
  exceptions_json: string;
  rule_scope: "global" | "agent" | "team";
  target_agent_id: string | null;
  target_team_id: string | null;
  positive_count: number;
  negative_count: number;
  commit_id: string;
  created_at: string;
  updated_at: string;
};

function writeBody(args: {
  input: string;
  weight: number;
  confidence: number;
  decayRate: number;
  metadata: Record<string, unknown>;
}) {
  return {
    tenant_id: "default",
    scope: "canonical-mutation",
    actor: "canonical-test",
    model_version: "canonical-model-v1",
    prompt_version: "canonical-prompt-v1",
    input_text: args.input,
    auto_embed: false,
    memory_lane: "shared" as const,
    nodes: [
      {
        client_id: "canonical-source",
        type: "concept",
        title: "Canonical source",
        text_summary: "The source node remains byte-for-byte stable across edge mutations.",
        slots: { zeta: 2, alpha: { second: true, first: true } },
      },
      {
        client_id: "canonical-target",
        type: "concept",
        title: "Canonical target",
        text_summary: "The target node remains byte-for-byte stable across edge mutations.",
        slots: { role: "target" },
      },
    ],
    edges: [
      {
        type: "related_to",
        src: { client_id: "canonical-source" },
        dst: { client_id: "canonical-target" },
        weight: args.weight,
        confidence: args.confidence,
        decay_rate: args.decayRate,
        metadata: args.metadata,
      },
    ],
  };
}

async function prepare(body: ReturnType<typeof writeBody>) {
  return prepareMemoryWrite(body, "default", "default", writeOptions, null);
}

function ruleWriteBody(args: {
  scope: string;
  ruleScope?: "global" | "agent" | "team";
  targetAgentId?: string;
  targetTeamId?: string;
  thenTool?: string;
}) {
  return {
    tenant_id: "default",
    scope: args.scope,
    actor: "rule-authority-test",
    input_text: "canonical rule definition authority write",
    auto_embed: false,
    memory_lane: "shared" as const,
    nodes: [{
      client_id: "canonical-authority-rule",
      type: "rule",
      title: "Canonical authority rule",
      text_summary: "Use the governed tool when the request is eligible.",
      slots: {
        rule_state: "shadow",
        if: { request_kind: "governed", nested: { z: 2, a: 1 } },
        then: { tool: args.thenTool ?? "safe-tool" },
        exceptions: [{ reason: "operator_override" }],
        rule_scope: args.ruleScope ?? "global",
        ...(args.targetAgentId === undefined ? {} : { target_agent_id: args.targetAgentId }),
        ...(args.targetTeamId === undefined ? {} : { target_team_id: args.targetTeamId }),
      },
    }],
    edges: [],
  };
}

function authorityRowCounts(database: ReturnType<typeof createLiteRuntimeDatabase>): Record<string, number> {
  return Object.fromEntries([
    "lite_memory_commits",
    "lite_memory_nodes",
    "lite_memory_edges",
    "lite_memory_rule_defs",
    "lite_memory_scope_heads",
  ].map((table) => [
    table,
    Number((database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
  ]));
}

function decodeMutation(row: CommitRow): CanonicalAppliedWriteMutationV2 {
  const mutation = JSON.parse(row.diff_json) as CanonicalAppliedWriteMutationV2;
  assert.equal(mutation.contract, "aionis_applied_write_mutation_v2");
  assert.equal(mutation.digest_version, 2);
  assert.equal(row.digest_version, 2);
  assert.equal(row.created_at, mutation.applied_at);
  assert.equal(row.mutation_digest, sha256Hex(row.diff_json));
  assert.equal(row.mutation_digest, sha256Hex(stableStringify(mutation)));
  return mutation;
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
  );
}

test("canonical applied mutation follows resolved SQLite edge state and keeps a strict v2 chain", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-canonical-mutation-"));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database);
  try {
    const bodies = [
      writeBody({
        input: "canonical edge initial insert",
        weight: 0.2,
        confidence: 0.3,
        decayRate: 0.1,
        metadata: { version: 1, nested: { z: 2, a: 1 } },
      }),
      writeBody({
        input: "canonical edge weight increase",
        weight: 0.8,
        confidence: 0.3,
        decayRate: 0.1,
        metadata: { nested: { a: 1, z: 2 }, version: 1 },
      }),
      writeBody({
        input: "canonical edge confidence increase",
        weight: 0.8,
        confidence: 0.9,
        decayRate: 0.1,
        metadata: { version: 1, nested: { z: 2, a: 1 } },
      }),
      writeBody({
        input: "canonical edge decay replacement",
        weight: 0.8,
        confidence: 0.9,
        decayRate: 0.7,
        metadata: { version: 1, nested: { z: 2, a: 1 } },
      }),
      writeBody({
        input: "canonical edge metadata replacement with lower monotonic requests",
        weight: 0.1,
        confidence: 0.1,
        decayRate: 0.7,
        metadata: { version: 2, nested: { a: 3 } },
      }),
    ];

    const preparedWrites = [];
    const results = [];
    for (const body of bodies) {
      const prepared = await prepare(body);
      preparedWrites.push(prepared);
      results.push(await store.withTx(() => applyMemoryWrite(prepared, {
        ...writeOptions,
        write_access: store,
      })));
    }

    assert.equal(new Set(results.map((result) => result.commit_id)).size, bodies.length);
    assert.equal(new Set(results.map((result) => result.commit_hash)).size, bodies.length);
    assert.equal(results[1]?.edges[0]?.id, results[0]?.edges[0]?.id, "upsert receipt must expose the persisted edge id");

    const commits = database.db.prepare(
      `SELECT id, parent_commit_id, input_sha256, diff_json, actor,
              model_version, prompt_version, commit_hash, created_at,
              digest_version, revision, mutation_digest, legacy_anchor_commit_id
       FROM lite_memory_commits
       WHERE scope = ?
       ORDER BY revision ASC`,
    ).all("canonical-mutation") as CommitRow[];
    assert.equal(commits.length, bodies.length);

    let parentHash = "";
    for (const [index, row] of commits.entries()) {
      const mutation = decodeMutation(row);
      assert.equal(row.revision, index + 1);
      assert.equal(row.parent_commit_id, index === 0 ? null : commits[index - 1]?.id);
      assert.equal(mutation.nodes.length, index === 0 ? 2 : 0);
      assert.equal(mutation.edges.length, 1);
      assert.equal(mutation.rule_defs.length, 0, "non-rule writes must not claim rule-def authority");
      const expectedHash = sha256Hex(stableStringify({
        digest_version: 2,
        revision: row.revision,
        parent_hash: parentHash,
        input_sha256: row.input_sha256,
        mutation_digest: row.mutation_digest,
        scope: "canonical-mutation",
        actor: row.actor,
        model_version: row.model_version,
        prompt_version: row.prompt_version,
      }));
      assert.equal(row.commit_hash, expectedHash);
      parentHash = row.commit_hash;
    }

    const weightMutation = decodeMutation(commits[1]!).edges[0] as CanonicalEdgeMutationV2;
    assert.equal(weightMutation.before?.weight, 0.2);
    assert.equal(weightMutation.requested.weight, 0.8);
    assert.equal(weightMutation.after.weight, 0.8);
    assert.equal(weightMutation.before?.commit_id, commits[0]?.id);
    assert.equal(weightMutation.after.commit_id, SELF_COMMIT_REFERENCE);

    const confidenceMutation = decodeMutation(commits[2]!).edges[0] as CanonicalEdgeMutationV2;
    assert.equal(confidenceMutation.before?.confidence, 0.3);
    assert.equal(confidenceMutation.after.confidence, 0.9);

    const decayMutation = decodeMutation(commits[3]!).edges[0] as CanonicalEdgeMutationV2;
    assert.equal(decayMutation.before?.decay_rate, 0.1);
    assert.equal(decayMutation.after.decay_rate, 0.7);

    const metadataMutation = decodeMutation(commits[4]!).edges[0] as CanonicalEdgeMutationV2;
    assert.equal(metadataMutation.requested.weight, 0.1);
    assert.equal(metadataMutation.requested.confidence, 0.1);
    assert.equal(metadataMutation.after.weight, 0.8, "MAX-resolved weight must be explicit in diff");
    assert.equal(metadataMutation.after.confidence, 0.9, "MAX-resolved confidence must be explicit in diff");
    assert.deepEqual(metadataMutation.after.metadata_json, { nested: { a: 3 }, version: 2 });

    const persistedEdge = database.db.prepare(
      `SELECT id, scope, type, src_id, dst_id, weight, confidence,
              decay_rate, metadata_json, commit_id, created_at
       FROM lite_memory_edges
       WHERE scope = ?`,
    ).get("canonical-mutation") as EdgeRow;
    assert.deepEqual({
      id: persistedEdge.id,
      scope: persistedEdge.scope,
      type: persistedEdge.type,
      src_id: persistedEdge.src_id,
      dst_id: persistedEdge.dst_id,
      weight: persistedEdge.weight,
      confidence: persistedEdge.confidence,
      decay_rate: persistedEdge.decay_rate,
      metadata_json: JSON.parse(persistedEdge.metadata_json),
      commit_id: SELF_COMMIT_REFERENCE,
      created_at: persistedEdge.created_at,
    }, metadataMutation.after);
    assert.equal(persistedEdge.commit_id, commits[4]?.id);

    const firstPrepared = preparedWrites[0]!;
    const stableMutation = decodeMutation(commits[0]!);
    const sourceNodeMutation = stableMutation.nodes.find(
      (entry) => entry.requested.title === "Canonical source",
    );
    assert.ok(sourceNodeMutation);
    const sourceSlots = sourceNodeMutation.requested.slots_json as Record<string, unknown>;
    assert.equal(sourceSlots.zeta, 2);
    assert.deepEqual(sourceSlots.alpha, { first: true, second: true });

    const persistedNodes = database.db.prepare(
      `SELECT id, scope, client_id, type, tier, title, text_summary, slots_json,
              raw_ref, evidence_ref, embedding_vector_json, embedding_model,
              memory_lane, producer_agent_id, owner_agent_id, owner_team_id,
              embedding_status, embedding_last_error, salience, importance,
              confidence, redaction_version, commit_id, created_at
       FROM lite_memory_nodes
       WHERE scope = ?`,
    ).all("canonical-mutation") as NodeRow[];
    assert.equal(persistedNodes.length, stableMutation.nodes.length);
    for (const row of persistedNodes) {
      const planned = stableMutation.nodes.find((entry) => entry.after.id === row.id);
      assert.ok(planned);
      assert.deepEqual({
        id: row.id,
        scope: row.scope,
        client_id: row.client_id,
        type: row.type,
        tier: row.tier,
        title: row.title,
        text_summary: row.text_summary,
        slots_json: JSON.parse(row.slots_json),
        raw_ref: row.raw_ref,
        evidence_ref: row.evidence_ref,
        embedding_vector_json: row.embedding_vector_json === null ? null : JSON.parse(row.embedding_vector_json),
        embedding_model: row.embedding_model,
        memory_lane: row.memory_lane,
        producer_agent_id: row.producer_agent_id,
        owner_agent_id: row.owner_agent_id,
        owner_team_id: row.owner_team_id,
        embedding_status: row.embedding_status,
        embedding_last_error: row.embedding_last_error,
        salience: row.salience,
        importance: row.importance,
        confidence: row.confidence,
        redaction_version: row.redaction_version,
        commit_id: SELF_COMMIT_REFERENCE,
        created_at: row.created_at,
      }, planned.after);
      assert.equal(row.commit_id, commits[0]?.id);
    }

    const reorderedNodes = [...stableMutation.nodes].reverse().map((entry) => ({
      ...entry,
      requested: {
        ...entry.requested,
        slots_json: reverseObjectKeyOrder(entry.requested.slots_json),
      },
      after: {
        ...entry.after,
        slots_json: reverseObjectKeyOrder(entry.after.slots_json),
      },
    }));
    const reordered = buildCanonicalAppliedWriteMutation(firstPrepared, false, {
      applied_at: stableMutation.applied_at,
      nodes: reorderedNodes,
      edges: [...stableMutation.edges].reverse(),
      rule_defs: [...stableMutation.rule_defs].reverse(),
    });
    assert.equal(canonicalAppliedMutationJson(reordered), commits[0]?.diff_json);

    const commitCountBeforeReplay = commits.length;
    const reorderedReplayBody = writeBody({
      input: "canonical edge metadata replacement with lower monotonic requests",
      weight: 0.1,
      confidence: 0.1,
      decayRate: 0.7,
      metadata: { nested: { a: 3 }, version: 2 },
    });
    (reorderedReplayBody.nodes[0] as any).slots = {
      alpha: { first: true, second: true },
      zeta: 2,
    };
    const replayPrepared = await prepare(reorderedReplayBody);
    const replay = await store.withTx(() => applyMemoryWrite(replayPrepared, {
      ...writeOptions,
      write_access: store,
    }));
    assert.equal(replay.commit_id, results[4]?.commit_id);
    assert.equal(replay.commit_hash, results[4]?.commit_hash);
    const commitCountAfterReplay = Number((database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_memory_commits WHERE scope = ?",
    ).get("canonical-mutation") as { count: number }).count);
    assert.equal(commitCountAfterReplay, commitCountBeforeReplay);
    assert.equal((await store.readScopeHead("canonical-mutation"))?.revision, 5);

    const stalePrepared = await prepare(writeBody({
      input: "stale canonical edge projection",
      weight: 0.8,
      confidence: 0.9,
      decayRate: 0.7,
      metadata: { version: 3 },
    }));
    await assert.rejects(
      () => store.withTx(() => applyMemoryWrite(stalePrepared, {
        ...writeOptions,
        write_access: store,
        expectedHeadRevision: 4,
      })),
      (error: any) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "scope_head_conflict");
        assert.equal(error.details.expected_revision, 4);
        assert.equal(error.details.current_revision, 5);
        return true;
      },
    );
    assert.equal((await store.readScopeHead("canonical-mutation"))?.revision, 5);
  } finally {
    await store.close();
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rule writes bind the full 14-column rule definition to the canonical mutation and replay as a no-op", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-canonical-rule-def-"));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database);
  try {
    const body = ruleWriteBody({
      scope: "canonical-rule-def",
      ruleScope: "agent",
      targetAgentId: "agent-7",
    });
    const prepared = await prepareMemoryWrite(body, "default", "default", writeOptions, null);
    const result = await store.withTx(() => applyMemoryWrite(prepared, {
      ...writeOptions,
      write_access: store,
    }));
    const commit = database.db.prepare(
      `SELECT id, parent_commit_id, input_sha256, diff_json, actor,
              model_version, prompt_version, commit_hash, created_at,
              digest_version, revision, mutation_digest, legacy_anchor_commit_id
       FROM lite_memory_commits
       WHERE id = ?`,
    ).get(result.commit_id) as CommitRow;
    const mutation = decodeMutation(commit);
    assert.equal(mutation.nodes.length, 1);
    assert.equal(mutation.edges.length, 0);
    assert.equal(mutation.rule_defs.length, 1);

    const ruleMutation = mutation.rule_defs[0]!;
    const expectedKeys = [
      "commit_id", "created_at", "exceptions_json", "if_json", "negative_count",
      "positive_count", "rule_node_id", "rule_scope", "scope", "state",
      "target_agent_id", "target_team_id", "then_json", "updated_at",
    ];
    assert.equal(ruleMutation.operation, "insert");
    assert.equal(ruleMutation.before, null);
    assert.deepEqual(Object.keys(ruleMutation.requested).sort(), expectedKeys);
    assert.deepEqual(Object.keys(ruleMutation.after).sort(), expectedKeys);
    assert.deepEqual(ruleMutation.requested, ruleMutation.after);
    assert.equal(ruleMutation.after.commit_id, SELF_COMMIT_REFERENCE);
    assert.equal(ruleMutation.after.created_at, mutation.applied_at);
    assert.equal(ruleMutation.after.updated_at, mutation.applied_at);
    assert.equal(ruleMutation.after.rule_scope, "agent");
    assert.equal(ruleMutation.after.target_agent_id, "agent-7");
    assert.equal(ruleMutation.after.positive_count, 0);
    assert.equal(ruleMutation.after.negative_count, 0);

    const persisted = database.db.prepare(
      `SELECT rule_node_id, scope, state, if_json, then_json, exceptions_json,
              rule_scope, target_agent_id, target_team_id, positive_count,
              negative_count, commit_id, created_at, updated_at
       FROM lite_memory_rule_defs
       WHERE rule_node_id = ?`,
    ).get(ruleMutation.after.rule_node_id) as RuleDefRow;
    assert.deepEqual({
      rule_node_id: persisted.rule_node_id,
      scope: persisted.scope,
      state: persisted.state,
      if_json: JSON.parse(persisted.if_json),
      then_json: JSON.parse(persisted.then_json),
      exceptions_json: JSON.parse(persisted.exceptions_json),
      rule_scope: persisted.rule_scope,
      target_agent_id: persisted.target_agent_id,
      target_team_id: persisted.target_team_id,
      positive_count: persisted.positive_count,
      negative_count: persisted.negative_count,
      commit_id: SELF_COMMIT_REFERENCE,
      created_at: persisted.created_at,
      updated_at: persisted.updated_at,
    }, ruleMutation.after);
    assert.equal(persisted.commit_id, result.commit_id);

    const ruleOnlyChange = structuredClone(mutation);
    ruleOnlyChange.rule_defs[0]!.requested.then_json = { tool: "different-tool" };
    ruleOnlyChange.rule_defs[0]!.after.then_json = { tool: "different-tool" };
    assert.notEqual(
      sha256Hex(stableStringify(ruleOnlyChange)),
      commit.mutation_digest,
      "changing only a rule-def field must change the mutation digest",
    );

    const replayPrepared = await prepareMemoryWrite(body, "default", "default", writeOptions, null);
    const replay = await store.withTx(() => applyMemoryWrite(replayPrepared, {
      ...writeOptions,
      write_access: store,
    }));
    assert.equal(replay.commit_id, result.commit_id);
    assert.equal(replay.commit_hash, result.commit_hash);
    assert.deepEqual(authorityRowCounts(database), {
      lite_memory_commits: 1,
      lite_memory_nodes: 1,
      lite_memory_edges: 0,
      lite_memory_rule_defs: 1,
      lite_memory_scope_heads: 1,
    });
    assert.equal((await store.readScopeHead("canonical-rule-def"))?.revision, 1);
  } finally {
    await store.close();
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("agent and team rule targets fail during planning before commit insertion", async () => {
  for (const ruleScope of ["agent", "team"] as const) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-rule-target-${ruleScope}-`));
    const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
    const store = createLiteWriteStoreFromDatabase(database);
    try {
      database.db.exec(
        `CREATE TRIGGER reject_commit_touch_${ruleScope}
         BEFORE INSERT ON lite_memory_commits
         BEGIN
           SELECT RAISE(ABORT, 'commit_insert_was_touched');
         END`,
      );
      const prepared = await prepareMemoryWrite(
        ruleWriteBody({ scope: `missing-${ruleScope}-target`, ruleScope }),
        "default",
        "default",
        writeOptions,
        null,
      );
      await assert.rejects(
        () => store.withTx(() => applyMemoryWrite(prepared, {
          ...writeOptions,
          write_access: store,
        })),
        ruleScope === "agent"
          ? /agent-scoped rule requires slots\.target_agent_id/
          : /team-scoped rule requires slots\.target_team_id/,
      );
      assert.deepEqual(authorityRowCounts(database), {
        lite_memory_commits: 0,
        lite_memory_nodes: 0,
        lite_memory_edges: 0,
        lite_memory_rule_defs: 0,
        lite_memory_scope_heads: 0,
      });
    } finally {
      await store.close();
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("exact read-after fences roll back real SQLite node, edge, and rule-def tampering", async () => {
  const cases = [
    {
      label: "node",
      trigger: `CREATE TRIGGER tamper_node_after_insert
        AFTER INSERT ON lite_memory_nodes
        BEGIN
          UPDATE lite_memory_nodes SET confidence = 0.123 WHERE id = NEW.id;
        END`,
      body: {
        tenant_id: "default",
        scope: "tamper-node",
        input_text: "tamper node authority",
        auto_embed: false,
        memory_lane: "shared" as const,
        nodes: [{ client_id: "tamper-node", type: "concept", title: "Tamper node" }],
        edges: [],
      },
      error: /memory_write_node_exact_read_after_mismatch/,
    },
    {
      label: "edge",
      trigger: `CREATE TRIGGER tamper_edge_after_insert
        AFTER INSERT ON lite_memory_edges
        BEGIN
          UPDATE lite_memory_edges SET weight = 0.123 WHERE id = NEW.id;
        END`,
      body: {
        ...writeBody({
          input: "tamper edge authority",
          weight: 0.8,
          confidence: 0.7,
          decayRate: 0.2,
          metadata: { exact: true },
        }),
        scope: "tamper-edge",
      },
      error: /memory_write_edge_exact_read_after_mismatch/,
    },
    {
      label: "rule-def",
      trigger: `CREATE TRIGGER tamper_rule_def_after_insert
        AFTER INSERT ON lite_memory_rule_defs
        BEGIN
          UPDATE lite_memory_rule_defs SET then_json = '{"tampered":true}'
          WHERE rule_node_id = NEW.rule_node_id;
        END`,
      body: ruleWriteBody({ scope: "tamper-rule-def" }),
      error: /memory_write_rule_def_exact_read_after_mismatch/,
    },
  ];

  for (const fixture of cases) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `aionis-${fixture.label}-read-after-`));
    const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
    const store = createLiteWriteStoreFromDatabase(database);
    try {
      database.db.exec(fixture.trigger);
      const prepared = await prepareMemoryWrite(
        fixture.body,
        "default",
        "default",
        writeOptions,
        null,
      );
      await assert.rejects(
        () => store.withTx(() => applyMemoryWrite(prepared, {
          ...writeOptions,
          write_access: store,
        })),
        fixture.error,
      );
      assert.deepEqual(authorityRowCounts(database), {
        lite_memory_commits: 0,
        lite_memory_nodes: 0,
        lite_memory_edges: 0,
        lite_memory_rule_defs: 0,
        lite_memory_scope_heads: 0,
      });
    } finally {
      await store.close();
      await database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("strict rule-def insertion rejects an in-transaction duplicate and rolls back the whole write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-rule-def-strict-insert-"));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database);
  try {
    database.db.exec(
      `CREATE TRIGGER inject_rule_def_after_rule_node
       AFTER INSERT ON lite_memory_nodes
       WHEN NEW.type = 'rule'
       BEGIN
         INSERT INTO lite_memory_rule_defs
           (rule_node_id, scope, state, if_json, then_json, exceptions_json,
            rule_scope, target_agent_id, target_team_id, positive_count,
            negative_count, commit_id, created_at, updated_at)
         VALUES
           (NEW.id, NEW.scope, 'shadow',
            '{"nested":{"a":1,"z":2},"request_kind":"governed"}',
            '{"tool":"safe-tool"}', '[{"reason":"operator_override"}]',
            'global', NULL, NULL, 0, 0, NEW.commit_id, NEW.created_at, NEW.created_at);
       END`,
    );
    const prepared = await prepareMemoryWrite(
      ruleWriteBody({ scope: "strict-rule-def-insert" }),
      "default",
      "default",
      writeOptions,
      null,
    );
    await assert.rejects(
      () => store.withTx(() => applyMemoryWrite(prepared, {
        ...writeOptions,
        write_access: store,
      })),
      /UNIQUE constraint failed: lite_memory_rule_defs\.rule_node_id/,
    );
    assert.deepEqual(authorityRowCounts(database), {
      lite_memory_commits: 0,
      lite_memory_nodes: 0,
      lite_memory_edges: 0,
      lite_memory_rule_defs: 0,
      lite_memory_scope_heads: 0,
    });
  } finally {
    await store.close();
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("memory write rejects duplicate edge identities before SQLite can diverge from the mutation plan", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-canonical-duplicate-edge-"));
  const database = createLiteRuntimeDatabase(path.join(directory, "runtime.sqlite"));
  const store = createLiteWriteStoreFromDatabase(database);
  try {
    const prepared = await prepareMemoryWrite({
      ...writeBody({
        input: "duplicate edge identity must fail closed",
        weight: 0.2,
        confidence: 0.3,
        decayRate: 0.1,
        metadata: { version: 1 },
      }),
      edges: [
        {
          type: "related_to",
          src: { client_id: "canonical-source" },
          dst: { client_id: "canonical-target" },
          weight: 0.2,
        },
        {
          type: "related_to",
          src: { client_id: "canonical-source" },
          dst: { client_id: "canonical-target" },
          weight: 0.9,
        },
      ],
    }, "default", "default", writeOptions, null);

    await assert.rejects(
      () => store.withTx(() => applyMemoryWrite(prepared, {
        ...writeOptions,
        write_access: store,
      })),
      (error: any) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "duplicate_edge_identity_in_batch");
        assert.equal(error.details.first_index, 0);
        assert.equal(error.details.duplicate_index, 1);
        return true;
      },
    );
    assert.equal(Number((database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_memory_commits",
    ).get() as { count: number }).count), 0);
  } finally {
    await store.close();
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
