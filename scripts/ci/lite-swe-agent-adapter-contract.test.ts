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

test("SWE-agent eval preserves submitted staged patches as evidence", () => {
  assert.match(RUNNER, /git", \["-C", workspaceDir, "diff", "--binary", "HEAD"\]/);
  assert.match(RUNNER, /git", \["-C", workspaceDir, "diff", "--name-only", "HEAD"\]/);
});

test("SWE-agent eval enforces task call budgets", () => {
  assert.match(RUNNER, /--agent\.model\.per_instance_call_limit=\$\{Math\.floor\(Number\(args\.task\.max_steps\)\)\}/);
});

test("SWE-agent eval converts assisted negative transfer into scoped context downgrade", () => {
  assert.match(RUNNER, /aionis_agent_context_feedback_v1/);
  assert.match(RUNNER, /aionis_prior_negative_transfer_evidence_packet_v1/);
  assert.match(RUNNER, /prior_assisted_negative_transfer_present/);
  assert.match(RUNNER, /semantic_evidence_downgraded_by_counter_evidence/);
  assert.match(RUNNER, /downgrade_future_aionis_context_for_scope/);
  assert.match(RUNNER, /recommended_next_assistance_mode: "minimal_boundary"/);
});

test("SWE-agent eval reuses prior reports as evidence, not project-specific Runtime code", () => {
  assert.match(RUNNER, /--prior-report/);
  assert.match(RUNNER, /readPriorTaskReports/);
  assert.match(RUNNER, /measurement_feedback_not_runtime_rule/);
  assert.equal(RUNNER.includes("marked-pedantic-colon-strong"), false);
  assert.equal(RUNNER.includes("markedjs"), false);
});

test("SWE-agent eval keeps downgraded negative-transfer context compact", () => {
  assert.match(RUNNER, /negativeTransferControl\.suppress_surfaces = \[\]/);
  assert.match(RUNNER, /contract\.forbidden_edit_files = \[\]/);
  assert.match(RUNNER, /fitted\.compact_execution_contract = \{/);
  assert.match(RUNNER, /prior_negative_transfer_count: negativeTransferControl\.prior_negative_transfer_count/);
});
