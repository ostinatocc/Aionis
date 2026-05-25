import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER = readFileSync(path.join(ROOT, "scripts/swe-agent-eval/run-swe-agent-aionis-eval.ts"), "utf8");
const ADAPTER = readFileSync(path.join(ROOT, "scripts/agent-runtime/aionis-agent-runtime-adapter.ts"), "utf8");

test("SWE-agent eval consumes the generic Aionis Agent Runtime adapter", () => {
  assert.match(RUNNER, /buildAionisAgentRuntimeContext/);
  assert.match(RUNNER, /agent_runtime_adapter/);
  assert.match(RUNNER, /experience_intelligence/);
  assert.match(RUNNER, /action_intelligence/);
  assert.match(RUNNER, /experience_adaptation_trace/);
  assert.match(ADAPTER, /AionisAgentRuntimeContextPacket/);
  assert.match(ADAPTER, /AgentRuntimeHost/);
  assert.match(ADAPTER, /AgentRuntimeTask/);
  assert.match(ADAPTER, /\/v1\/memory\/experience\/intelligence/);
});

test("SWE-agent adapter does not revive legacy kickoff routing", () => {
  assert.equal(RUNNER.includes("/v1/memory/kickoff/recommendation"), false);
  assert.equal(ADAPTER.includes("/v1/memory/kickoff/recommendation"), false);
});
