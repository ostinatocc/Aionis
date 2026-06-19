# Admission Active Cross-Repo Tool E2E Paired27 Rerun

Date: 2026-06-18

Status: product evidence report, wrong-write regression resolved; route-adherence and attention-scope issues remain

## Purpose

This rerun tested the patch that preserves Aionis `execution_memory`
accepted-continuation entries in the active admission projection. The prior
paired27 active run regressed because accepted execution-memory route evidence
was downgraded from `use_now` to `inspect_before_use`, which removed
`should_continue` / `active_targets` from the prompt-facing route contract.

The rerun used the same 27 trap IDs from the previous active paired run:

- real Runtime `/v1/observe` and `/v1/guide`;
- `AIONIS_ADMISSION_CANDIDATE_POLICY_MODE=active`;
- real MiniMax embeddings;
- real DeepSeek file-choice Agent;
- active-only `aionis` arm;
- fresh Lite SQLite files for this rerun;
- same paired27 manifest derived from the previous active run.

Reports:

- active rerun results:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-active-paired27-rerun-execmem-2026-06-18/phase2-gradient-results.jsonl`
- active rerun summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-active-paired27-rerun-execmem-2026-06-18/summary.md`
- active rerun after file-choice normalizer fix:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-active-paired27-rerun-normalizer-2026-06-18/summary.md`

## Paired Result

| Metric | Policy off | Active before patch | Active after execution-memory patch | Active after normalizer fix |
|---|---:|---:|---:|---:|
| Paired records | 27 | 27 | 27 | 27 |
| Wrong-write records | 2 | 7 | 1 | 0 |
| Wrong-attention records | 2 | 7 | 1 | 13 |
| Accepted-direction records | 25 | 17 | 26 | 26 |
| Action-completion records | 26 | 25 | 27 | 26 |
| Report-conflict records | 0 | 2 | 0 | 0 |
| Terminal-inspect records | 1 | 0 | 0 | 1 |
| Rediscovery steps | 6 | 21 | 3 | 13 |
| Prompt tokens | 358,491 | 353,341 | 358,575 | 358,545 |
| Completion tokens | 30,099 | 43,092 | 29,988 | 28,115 |
| Total tokens | 388,590 | 396,433 | 388,563 | 386,660 |

The execution-memory patch recovered the prompt-facing route contract. The
follow-up normalizer fix then removed the last observed wrong-write by allowing
the file-choice Agent to keep safe repo-relative `create` / `restore` targets
that are not already in the candidate file list.

The `wrong-attention` column is not directly comparable between the execution
memory patch run and the normalizer-fix run. The normalizer now preserves
`evidence_source` for edit/create decisions, which exposes cases where the Agent
correctly writes the active target while using the retired path as reference
evidence. Those records should be split into `reference_attention` vs
`direction_attention` before they are used as a rollout blocker.

## Normalizer Artifact Resolved

The residual failure from the execution-memory patch run was:

- `vercel-next.js-a0dd23235851-source-trap-3__separated`

Inspection showed that the raw DeepSeek decision did not choose the rejected
`noop_kv.rs` branch. It chose either the accepted `key_value_database.rs` route
or a safe new persistence implementation path. The old harness normalized
non-candidate create paths to `candidateFiles[0]`, and in this trap the first
candidate was the rejected `noop_kv.rs` path. That produced a false
wrong-write.

After the normalizer fix, the same trap chose:

- `turbopack/crates/turbo-tasks-backend/src/database/key_value_database.rs`

with `wrong_branch_write_hit=false`, `wrong_branch_attention_hit=false`, and
`accepted_direction_hit=true`.

## Remaining Failures

One true route-adherence failure remains in the normalizer-fix run:

- `vercel-next.js-4c3cdf61de11-source-trap-5__buried`

The Agent terminal-inspected:

- `turbopack/crates/turbo-tasks/src/raw_vc.rs`

instead of continuing the accepted active target:

- `turbopack/crates/turbo-tasks/src/vc/raw.rs`

This is not a wrong-write safety failure. It is a right-history abandonment /
route-adherence failure under buried context.

## Product Decision

- The prior active projection wrong-write regression is fixed in the paired27
  rerun after the harness normalizer correction.
- The candidate should remain out of default active Runtime mode.
- The broad rollout gate stays blocked until route-adherence and attention-scope
  semantics are separated and retested.
- Do not add a task-specific rule for `noop_kv.rs` or this repository.
- Feed the remaining buried terminal-inspect case into the admission dataset
  and route-adherence analysis as counter-evidence.

## Next Work

1. Split the E2E attention metric into:
   - reference attention: retired path used as source evidence while writing the
     active route;
   - direction attention: retired path selected as the route or primary action.
2. Inspect the buried terminal-inspect case to determine whether the guide
   omitted active-route evidence or the Agent ignored it.
3. If a general fix is justified, keep it at the product-contract level:
   improve route-adherence wording for buried contexts without encoding
   repository-specific file names or task solutions.
4. Rerun paired27 after the attention metric split before changing promotion
   status.
