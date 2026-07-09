import assert from "node:assert/strict";
import test from "node:test";
import { createAionisClient } from "../../src/sdk.ts";

const INSPECT_ID = "11111111-1111-4111-8111-111111111111";
const REHYDRATE_ID = "22222222-2222-4222-8222-222222222222";

test("SDK guideAgentContext renders execution contract and resolved evidence by default", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/v1/guide")) {
      return new Response(JSON.stringify({
        tenant_id: "tenant-a",
        scope: "scope-a",
        guide_trace_id: "guide-trace-a",
        agent_context: {
          contract_version: "aionis_agent_context_v1",
          agent_context_mode: "standard",
          prompt_text: "AIONIS_CTX v2\ninspect_before_use and rehydrate pointers are available.",
          use_now_memory_ids: [],
          inspect_before_use_memory_ids: [INSPECT_ID],
          do_not_use_memory_ids: [],
          rehydrate_hints: [{ memory_id: REHYDRATE_ID, reason: "Exact change evidence is required.", required: true }],
          memory_ids: [INSPECT_ID, REHYDRATE_ID],
        },
      }), { status: 200 });
    }
    if (url.endsWith("/v1/memory/resolve")) {
      const uri = String(body.uri);
      const memoryId = uri.includes(INSPECT_ID) ? INSPECT_ID : REHYDRATE_ID;
      return new Response(JSON.stringify({
        tenant_id: "tenant-a",
        scope: "scope-a",
        uri,
        type: "event",
        node: {
          id: memoryId,
          uri,
          type: "event",
          title: memoryId === INSPECT_ID ? "Inspect evidence" : "Rehydrate evidence",
          text_summary: "Compact summary",
          slots: {
            handoff_text: memoryId === INSPECT_ID
              ? "INSPECT_EVIDENCE: inspect the route boundary before acting."
              : "REHYDRATE_EVIDENCE: apply the exact accepted patch hunk.",
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };

  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  const result = await client.guideAgentContext({
    query_text: "Continue with exact evidence.",
    consumer_agent_id: "worker-a",
    consumer_team_id: "team-a",
  }, undefined, {
    max_prompt_chars: 20_000,
  });

  assert.equal(result.contract_version, "aionis_sdk_agent_context_with_evidence_v1");
  assert.equal(result.guide_trace_id, "guide-trace-a");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/memory/resolve",
    "http://127.0.0.1:3001/v1/memory/resolve",
  ]);
  assert.equal(calls[0]?.body.mode, "full_power");
  assert.equal(calls[1]?.body.include_slots, true);
  assert.equal(calls[1]?.body.include_meta, true);
  assert.match(String(calls[1]?.body.uri), /aionis:\/\/tenant-a\/scope-a\/event\//);
  assert.equal(result.resolved_evidence.length, 2);
  assert.deepEqual(result.resolved_evidence.map((entry) => entry.surface), ["inspect_before_use", "rehydrate"]);
  assert.match(result.agent_prompt, /AIONIS_EXECUTION_AGENT_CONTEXT/);
  assert.doesNotMatch(result.agent_prompt, /BASE_AIONIS_CONTEXT/);
  assert.doesNotMatch(result.agent_prompt, /AIONIS_CTX v2/);
  assert.match(result.agent_prompt, /AIONIS_RESOLVED_EVIDENCE v1/);
  assert.match(result.agent_prompt, /INSPECT_EVIDENCE/);
  assert.match(result.agent_prompt, /REHYDRATE_EVIDENCE/);
  assert.equal(result.resolved_evidence.some((entry) => entry.evidence_text.includes("INSPECT_EVIDENCE")), true);
  assert.equal(result.resolved_evidence.some((entry) => entry.evidence_text.includes("REHYDRATE_EVIDENCE")), true);
  assert.equal(result.unresolved_memory_ids.length, 0);
});

test("SDK guideAgentContext can return Runtime compact prompt without stacking SDK contract", async () => {
  const runtimePrompt = "AIONIS_CTX v2\nstate r=agent h=1 a=1 p=act auth=ok risk=lo\ncurrent: note=continue accepted route";
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({
      ok: true,
      guide_trace_id: "guide-compact-runtime",
      agent_context: {
        prompt_text: runtimePrompt,
        memory_ids: [],
      },
    }), { status: 200 });
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  const result = await client.guideAgentContext({
    query_text: "Continue compact.",
  }, undefined, {
    prompt_format: "runtime_compact",
  });

  assert.equal(result.compiled_context.prompt_format, "runtime_compact");
  assert.equal(result.agent_prompt, runtimePrompt);
  assert.doesNotMatch(result.agent_prompt, /AIONIS_EXECUTION_AGENT_CONTEXT/);
  assert.doesNotMatch(result.agent_prompt, /BASE_AIONIS_CONTEXT/);
});
