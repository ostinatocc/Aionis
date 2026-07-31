import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from
  "node:http";
import test from "node:test";
import {
  createAionisClient,
  type AionisExecutionEpisodeHandleV1,
} from "../../src/sdk.ts";

const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";

function executionEpisodeHandle(): AionisExecutionEpisodeHandleV1 {
  return {
    contract_version: "aionis_execution_episode_handle_v1",
    episode_id: "episode-sdk-attach",
    tenant_id: "tenant-sdk-attach",
    scope: "scope-sdk-attach",
    task_id: "task-sdk-attach",
    task_envelope_digest: "1".repeat(64),
    run_id: "run-sdk-attach",
    workspace_root: "/tmp/aionis-sdk-attach-workspace",
    workspace_root_sha256: "2".repeat(64),
    current_state_snapshot_id: "state-sdk-before-tool",
    required_verifier: {
      contract_version: "execution_episode_required_verifier_v1",
      verifier_id: "verifier-sdk-attach",
      verifier_definition_sha256: "3".repeat(64),
    },
    closed: false,
  };
}

async function requestBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as
    Record<string, unknown>;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("execution.attachEpisode is local and episode guideAgentContext sends one bound guide before evidence resolve", async (t) => {
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const handle = executionEpisodeHandle();
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const path = request.url ?? "";
    calls.push({ path, body });
    if (
      path === "/v1/observe"
      && body.event_kind === "action_observed"
    ) {
      sendJson(response, {
        current_state_snapshot: {
          snapshot_id: "state-sdk-after-tool",
        },
      });
      return;
    }
    if (path === "/v1/guide") {
      sendJson(response, {
        tenant_id: handle.tenant_id,
        scope: handle.scope,
        guide_trace_id: "guide-trace-sdk-attach",
        agent_context: {
          contract_version: "aionis_agent_context_v1",
          agent_context_mode: "standard",
          prompt_text: "AIONIS_CTX v2\ncontinue the verified route.",
          use_now_memory_ids: [],
          inspect_before_use_memory_ids: [],
          do_not_use_memory_ids: [],
          rehydrate_hints: [{
            memory_id: EVIDENCE_ID,
            reason: "Recover exact continuation evidence.",
            required: true,
          }],
          memory_ids: [EVIDENCE_ID],
        },
      });
      return;
    }
    if (path === "/v1/memory/resolve") {
      sendJson(response, {
        tenant_id: handle.tenant_id,
        scope: handle.scope,
        uri: body.uri,
        type: "event",
        node: {
          id: EVIDENCE_ID,
          type: "event",
          title: "Exact continuation evidence",
          text_summary: "Continue from the verified tool result.",
          slots: {
            handoff_text:
              "ATTACHED_EPISODE_EVIDENCE: continue from the exact post-tool workspace.",
          },
        },
      });
      return;
    }
    sendJson(response, { unexpected_path: path });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createAionisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    tenant_id: handle.tenant_id,
    scope: handle.scope,
  });

  const episode = client.execution.attachEpisode(handle);
  assert.equal(calls.length, 0);

  handle.episode_id = "caller-mutated-episode";
  handle.current_state_snapshot_id = "caller-mutated-state";
  handle.required_verifier.verifier_id = "caller-mutated-verifier";

  await episode.recordAction({
    operation_id: "operation-sdk-post-tool",
    action_kind: "tool_result",
    tool_name: "edit_file",
    request: "Apply the requested edit.",
    result: "Workspace bytes already changed before this callback.",
  });
  assert.equal(episode.currentStateSnapshotId, "state-sdk-after-tool");

  const context = await episode.guideAgentContext({
    operation_id: "operation-sdk-episode-guide",
    query_text: "Continue from the exact post-tool state.",
    consumer_agent_id: "worker-sdk-attach",
  }, undefined, {
    max_prompt_chars: 20_000,
  });

  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/observe",
    "/v1/guide",
    "/v1/memory/resolve",
  ]);
  assert.equal(
    calls.filter((call) => call.path === "/v1/guide").length,
    1,
  );
  assert.equal(calls[0]?.body.episode_id, "episode-sdk-attach");
  assert.equal(
    calls[0]?.body.expected_current_state_snapshot_id,
    "state-sdk-before-tool",
  );
  assert.equal(calls[1]?.body.episode_id, "episode-sdk-attach");
  assert.equal(
    calls[1]?.body.expected_current_state_snapshot_id,
    "state-sdk-after-tool",
  );
  assert.equal(calls[1]?.body.run_id, "run-sdk-attach");
  assert.equal(calls[1]?.body.tenant_id, "tenant-sdk-attach");
  assert.equal(calls[1]?.body.scope, "scope-sdk-attach");
  assert.equal(calls[2]?.body.consumer_agent_id, "worker-sdk-attach");
  assert.match(
    context.agent_prompt,
    /ATTACHED_EPISODE_EVIDENCE/,
  );
  assert.equal(context.resolved_evidence.length, 1);
  assert.equal(episode.handle.episode_id, "episode-sdk-attach");
  assert.equal(
    episode.handle.required_verifier.verifier_id,
    "verifier-sdk-attach",
  );

  const callCountBeforeDrift = calls.length;
  await assert.rejects(
    episode.guideAgentContext({
      operation_id: "operation-sdk-drifted-guide",
      query_text: "This must fail locally.",
      episode_id: "different-episode",
    }),
    /guide identity cannot change/,
  );
  await assert.rejects(
    episode.guideAgentContext({
      operation_id: "operation-sdk-drifted-state",
      query_text: "This must also fail locally.",
      expected_current_state_snapshot_id: "different-state",
    }),
    /guide target state cannot change/,
  );
  assert.equal(calls.length, callCountBeforeDrift);
});

test("execution.attachEpisode rejects non-exact handles without fetch while resumeEpisode still resumes through Runtime", async (t) => {
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const handle = executionEpisodeHandle();
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const path = request.url ?? "";
    calls.push({ path, body });
    sendJson(response, {
      episode: {
        episode_id: handle.episode_id,
        tenant_id: handle.tenant_id,
        public_scope: handle.scope,
        task_id: handle.task_id,
        task_envelope_digest: handle.task_envelope_digest,
        run_id: handle.run_id,
        subject_identity: {
          canonical_root_sha256: handle.workspace_root_sha256,
        },
        required_verifier: handle.required_verifier,
      },
      current_state_snapshot: {
        snapshot_id: handle.current_state_snapshot_id,
      },
      closed: false,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createAionisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  assert.throws(
    () => client.execution.attachEpisode({
      ...handle,
      injected_identity: "must-not-survive",
    } as AionisExecutionEpisodeHandleV1),
    /Invalid serialized execution episode handle/,
  );
  assert.throws(
    () => client.execution.attachEpisode({
      ...handle,
      required_verifier: {
        ...handle.required_verifier,
        injected_verifier_identity: "must-not-survive",
      },
    } as AionisExecutionEpisodeHandleV1),
    /Invalid serialized execution episode handle/,
  );
  assert.equal(calls.length, 0);

  const resumed = await client.execution.resumeEpisode(handle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/v1/observe");
  assert.equal(calls[0]?.body.event_kind, "episode_resumed");
  assert.equal(calls[0]?.body.episode_id, handle.episode_id);
  assert.equal(resumed.episodeId, handle.episode_id);
});
