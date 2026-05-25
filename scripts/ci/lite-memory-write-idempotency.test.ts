import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareMemoryWrite, applyMemoryWrite } from "../../src/memory/write.ts";
import { createLiteWriteStore } from "../../src/store/lite-write-store.ts";

function tmpDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-lite-write-"));
  return path.join(dir, `${name}.sqlite`);
}

async function prepareSingleNodeWrite(title: string, textSummary: string) {
  return prepareMemoryWrite(
    {
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      producer_agent_id: "local-user",
      owner_agent_id: "local-user",
      input_text: `${title}\n${textSummary}`,
      auto_embed: false,
      nodes: [
        {
          client_id: "procedure:stable-client-id",
          type: "procedure",
          title,
          text_summary: textSummary,
          slots: { kind: "idempotency-regression" },
        },
      ],
    },
    "default",
    "default",
    {
      maxTextLen: 10_000,
      piiRedaction: false,
      allowCrossScopeEdges: false,
    },
    null,
  );
}

test("memory/write allows exact client_id replay but rejects changed duplicate node content", async () => {
  const store = createLiteWriteStore(tmpDbPath("idempotency"));
  try {
    const firstPrepared = await prepareSingleNodeWrite("Original procedure", "Inspect, patch, and rerun targeted tests.");
    const first = await store.withTx(() =>
      applyMemoryWrite({} as any, firstPrepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        shadowDualWriteEnabled: false,
        shadowDualWriteStrict: false,
        write_access: store,
      }),
    );

    const replayPrepared = await prepareSingleNodeWrite("Original procedure", "Inspect, patch, and rerun targeted tests.");
    const replay = await store.withTx(() =>
      applyMemoryWrite({} as any, replayPrepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        shadowDualWriteEnabled: false,
        shadowDualWriteStrict: false,
        write_access: store,
      }),
    );

    assert.equal(replay.commit_id, first.commit_id);
    assert.equal(replay.nodes[0]?.id, first.nodes[0]?.id);

    const changedPrepared = await prepareSingleNodeWrite("Changed procedure", "This should not overwrite the existing node.");
    await assert.rejects(
      () =>
        store.withTx(() =>
          applyMemoryWrite({} as any, changedPrepared, {
            maxTextLen: 10_000,
            piiRedaction: false,
            allowCrossScopeEdges: false,
            shadowDualWriteEnabled: false,
            shadowDualWriteStrict: false,
            write_access: store,
          }),
        ),
      (err: any) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "duplicate_node_id_conflict");
        assert.equal(err.details.node_id, first.nodes[0]?.id);
        assert.equal(err.details.client_id, "procedure:stable-client-id");
        return true;
      },
    );

    const { rows } = await store.findNodes({
      scope: "default",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    const stored = rows.find((row) => row.client_id === "procedure:stable-client-id");
    assert.equal(stored?.title, "Original procedure");
    assert.equal(stored?.text_summary, "Inspect, patch, and rerun targeted tests.");
  } finally {
    await store.close();
  }
});

test("lite findNodes preserves literal text and slotsContains filtering", async () => {
  const store = createLiteWriteStore(tmpDbPath("find-nodes-filtering"));
  try {
    const prepared = await prepareMemoryWrite(
      {
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        producer_agent_id: "local-user",
        owner_agent_id: "local-user",
        input_text: "seed findNodes filtering fixtures",
        auto_embed: false,
        nodes: [
          {
            client_id: "policy-memory:functions.exec_command",
            type: "concept",
            title: "Literal 100%_match",
            text_summary: "Policy memory fixture for exec_command.",
            slots: {
              summary_kind: "policy_memory",
              selected_tool: "functions.exec_command",
            },
          },
          {
            client_id: "policy-memory:functions.apply_patch",
            type: "concept",
            title: "Literal 1000 match",
            text_summary: "Policy memory fixture for apply_patch.",
            slots: {
              summary_kind: "policy_memory",
              selected_tool: "functions.apply_patch",
            },
          },
        ],
      },
      "default",
      "default",
      {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
      },
      null,
    );
    await store.withTx(() =>
      applyMemoryWrite({} as any, prepared, {
        maxTextLen: 10_000,
        piiRedaction: false,
        allowCrossScopeEdges: false,
        shadowDualWriteEnabled: false,
        shadowDualWriteStrict: false,
        write_access: store,
      }),
    );

    const byClient = await store.findNodes({
      scope: "default",
      type: "concept",
      clientId: "policy-memory:functions.exec_command",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.equal(byClient.rows.length, 1);
    assert.equal(byClient.rows[0]?.title, "Literal 100%_match");

    const literalLike = await store.findNodes({
      scope: "default",
      titleContains: "100%_",
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(literalLike.rows.map((row) => row.client_id), ["policy-memory:functions.exec_command"]);

    const bySlots = await store.findNodes({
      scope: "default",
      type: "concept",
      slotsContains: {
        summary_kind: "policy_memory",
        selected_tool: "functions.exec_command",
      },
      consumerAgentId: "local-user",
      consumerTeamId: null,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(bySlots.rows.map((row) => row.client_id), ["policy-memory:functions.exec_command"]);
  } finally {
    await store.close();
  }
});
