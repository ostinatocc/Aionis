import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER = readFileSync(path.join(ROOT, "scripts/aider-eval/run-aider-aionis-eval.ts"), "utf8");
const ADAPTER = readFileSync(path.join(ROOT, "scripts/agent-runtime/aionis-agent-runtime-adapter.ts"), "utf8");

test("Aider eval consumes the generic Aionis Agent Runtime adapter", () => {
  assert.match(RUNNER, /buildAionisAgentRuntimeContext/);
  assert.match(RUNNER, /aionis_aider_context_packet_v1/);
  assert.match(RUNNER, /aider-eval-adapter-v1/);
  assert.match(RUNNER, /experience_intelligence/);
  assert.match(RUNNER, /runtime_entropy_profile/);
  assert.match(ADAPTER, /AionisAgentRuntimeContextPacket/);
});

test("Aider eval keeps LLM semantic repair outside Runtime authority", () => {
  assert.match(RUNNER, /The LLM\/Agent owns semantic repair and final code choices/);
  assert.match(RUNNER, /runtime_may_not_block_exploration: true/);
  assert.match(RUNNER, /runtime_owned_semantic_patch_generation/);
  assert.match(RUNNER, /project_specific_runtime_source_rules/);
});

test("Aider eval uses scriptable non-interactive Aider without auto-commits", () => {
  assert.match(RUNNER, /"--message-file"/);
  assert.match(RUNNER, /"--yes"/);
  assert.match(RUNNER, /"--no-auto-commits"/);
  assert.match(RUNNER, /"--no-dirty-commits"/);
  assert.match(RUNNER, /--aider-arg/);
  assert.match(RUNNER, /--aider-timeout-ms/);
  assert.match(RUNNER, /git", \["-C", workspaceDir, "diff", "--binary", "HEAD"\]/);
});

test("Aider eval cleans tracked setup side effects before measuring Agent edits", () => {
  assert.match(RUNNER, /"diff", "--quiet", "HEAD"/);
  assert.match(RUNNER, /"restore", "--source=HEAD", "--staged", "--worktree", "\."/);
});

test("Aider eval persists real verifier evidence and quarantines external failures", () => {
  assert.match(RUNNER, /aider_verifier_evidence_v1/);
  assert.match(RUNNER, /runtime_learning_quarantined/);
  assert.match(RUNNER, /provider_failure/);
  assert.match(RUNNER, /provider_warning_present/);
  assert.match(RUNNER, /non_target_file_writes/);
  assert.match(RUNNER, /\/v1\/memory\/runtime-maintenance\/run/);
});

test("Aider eval runner does not contain project-specific task fixes", () => {
  assert.equal(RUNNER.includes("marked-pedantic-colon-strong"), false);
  assert.equal(RUNNER.includes("date-fns-parse-x-token-rejects-z"), false);
  assert.equal(RUNNER.includes("ISOTimezoneParser"), false);
  assert.equal(RUNNER.includes("emStrong"), false);
});
