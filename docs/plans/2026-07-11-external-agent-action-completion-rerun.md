# External Agent Action-Completion Rerun Plan

Date: 2026-07-11

## Goal

Close the remaining external executable action-completion gate without changing
Runtime product behavior or converting one provider run into an Aionis rule.

## Evidence Correction

The July 11 five-arm report froze the trap manifest and multistep agent script,
but it did not freeze the agent environment controls. Retained decision traces
show `rehydrate` terminating immediately, while the harness defaults
`AIONIS_E2E_REHYDRATE_CONTINUES` to disabled. The prior 0/40 cross-arm result is
therefore execution-protocol-inconclusive, not a demonstrated Runtime
regression and not clean evidence of model-only drift.

## Step 1: Freeze run provenance and recovery

- Output: `run-provenance.json` for every Phase 2 report.
- Identity: manifest, phase runner, smoke runner, agent script hashes; arm and
  level order; episode source; command; model profile; request controls; Node,
  platform, and architecture.
- Recovery: atomic summary/checkpoint writes, recoverable truncated JSONL,
  archived pre-resume input, reusable-success filtering, and general
  infrastructure failure classes.
- Test: `npm run -s external-agent-e2e:harness-test` in
  `/Volumes/ziel/new.aionis/AionisRuntime-evals`.

## Step 2: Freeze the action-completion protocol

- Output: `external-agent-e2e/configs/action-completion-v0.3.5-run-config.json`.
- Model profile: `deepseek-v4-pro-direct`.
- Explicit controls include non-thinking JSON responses, six base steps,
  bounded retries, `AIONIS_E2E_REHYDRATE_CONTINUES=true`, patch-plan-first
  rehydration, and the existing executable-patch evidence gate.
- Limitation: DeepSeek V4 Pro is an explicit provider model/version label, not
  an immutable dated snapshot. Reports must retain returned model metadata and
  must not claim weight-immutable reproducibility.

## Step 3: Run no-key preflight

- Validate the 40-case manifest and model profile.
- Run the action-completion wrapper in `--check-only` mode.
- Prepare one real trap through the complete worktree/checkpoint path without a
  model call.
- Estimate likely V4 Pro cost from the prior full run's actual usage, separately
  from the conservative configured upper bound.

The prior five-arm run used 2,228,893 prompt tokens and 498,250 completion
tokens. At the checked profile's planning rates, replaying that usage with V4
Pro is approximately USD 1.403; this is a planning estimate, not a provider
receipt or a hard cap.

## Step 4: Run a four-record pilot

- Command: `npm run -s external-agent-e2e:action-completion -- --mode pilot`.
- Scope: one base trap across all four hygiene levels and all five arms.
- Required environment: exported `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`, and a
  ready candidate Runtime URL in `AIONIS_BASE_URL`.
- Gate: all four Aionis records complete an executable action, retain accepted
  direction, produce zero wrong-branch writes, and record consistent provenance
  and returned-model observations.

## Step 5: Run the fixed 40-case matrix

- Start only after the pilot gate passes.
- Command: `npm run -s external-agent-e2e:action-completion -- --mode full`.
- Resume only into the same report directory and only when provenance matches.
- Required Aionis result: 40/40 action completion, 40/40 accepted direction,
  zero wrong-branch writes, and zero rediscovery.
- Baseline arms remain evidence for same-run context and behavior comparison;
  external repository final correctness is not an Aionis product claim.

## Step 6: Publish the corrected decision

- Add the pilot/full provenance fingerprints, returned model metadata, usage,
  action-completion matrix, and any infrastructure incidents to the benchmark
  report.
- Keep context-stability evidence separate from executable action evidence.
- Do not change Runtime core behavior in response to an individual eval case.
