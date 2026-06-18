# Admission Active Cross-Repo Tool E2E Paired27

Date: 2026-06-18

Status: product evidence report, negative gate result

## Purpose

This run tested whether `candidate_project_context_closed_loop_inspect` should
move beyond narrow isolated active gray pilots into broader tool-executing Agent
usage.

The run was intentionally stricter than the earlier two Vite-only pilots:

- real Runtime `/v1/observe` and `/v1/guide`;
- real MiniMax embeddings;
- real DeepSeek file-choice Agent;
- real cloned repositories and file edits;
- active-vs-off paired comparison;
- cross-repository base trap families.

## Run Shape

The intended large run covered 10 base trap families and 4 hygiene levels per
mode. The off-mode run stopped at 28 records because one large Next.js checkout
failed during the harness/worktree phase:

- failed record: `vercel-next.js-8ef4258ab9fa-source-trap-6__buried`;
- failure class: harness/worktree infrastructure, not Runtime guide logic.

To keep the comparison fair, the active run used the exact 27 trap IDs that had
completed successfully in off mode.

Reports:

- off partial results:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-off-2026-06-18/phase2-gradient-results.jsonl`
- active paired results:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-active-paired27-2026-06-18/phase2-gradient-results.jsonl`
- active summary:
  `/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/admission-tool-e2e-crossrepo-active-paired27-2026-06-18/summary.md`

## Paired Result

| Metric | Policy off | Policy active |
|---|---:|---:|
| Paired records | 27 | 27 |
| Wrong-write records | 2 | 7 |
| Wrong-attention records | 2 | 7 |
| Accepted-direction records | 25 | 17 |
| Action-completion records | 26 | 25 |
| Report-conflict records | 0 | 2 |
| Terminal-inspect records | 1 | 0 |
| Prompt tokens | 358,491 | 353,341 |
| Completion tokens | 30,099 | 43,092 |
| Total tokens | 388,590 | 396,433 |

Active mode did not improve this paired cross-repository run. It increased
wrong writes from 2 to 7, reduced accepted-direction hits from 25 to 17, and
increased total tokens slightly.

## By Repository

| Repository | Records | Off wrong writes | Active wrong writes | Off completion | Active completion |
|---|---:|---:|---:|---:|---:|
| `vitejs/vite` | 12 | 0 | 0 | 11 | 11 |
| `vercel/next.js` | 15 | 2 | 7 | 15 | 14 |

The regression is concentrated in the Next.js/Turbopack trap families. The Vite
families stayed safe, which means the earlier two Vite pilots remain valid but
are not sufficient for broader promotion.

## Active Regressions

Active mode introduced or preserved wrong writes in these paired records:

- `vercel-next.js-a0dd23235851-source-trap-3__tidy`
- `vercel-next.js-a0dd23235851-source-trap-3__separated`
- `vercel-next.js-a0dd23235851-source-trap-3__implicit`
- `vercel-next.js-4c3cdf61de11-source-trap-5__separated`
- `vercel-next.js-4c3cdf61de11-source-trap-5__implicit`
- `vercel-next.js-8ef4258ab9fa-source-trap-6__separated`
- `vercel-next.js-8ef4258ab9fa-source-trap-6__implicit`

Active also produced two conservative exits:

- `vitejs-vite-4551a4b-banner-legacy-script__implicit`
- `vercel-next.js-4c3cdf61de11-source-trap-5__tidy`

## Interpretation

This is a negative promotion gate.

The candidate still has value as an isolated active gray policy on the two
previous Vite pilot families, but this cross-repository paired run shows it is
not ready for broader default activation. The active projection appears to
downgrade or reroute some useful current-path evidence in medium-hygiene
Next.js/Turbopack cases, which lets the Agent choose retired or wrong
replacement paths.

The result should not trigger a Runtime core rule change by itself. It should
feed the admission-policy evaluation loop as a task-level tool-executing
counterexample.

## Product Decision

- Keep `candidate_project_context_closed_loop_inspect` out of default active
  Runtime mode.
- Keep external backend governance in `shadow_only`.
- Continue isolated active gray only on known-passing guide profiles.
- Do not market the candidate as cross-repository tool-agent safe yet.
- Add these paired failures to the next admission dataset batch as
  task-level negative evidence.

## Next Work

1. Inspect the failed Next.js guide contexts and active projection source maps.
2. Identify whether the regression is caused by missing active-target evidence,
   over-downgraded current-path evidence, or route-contract wording.
3. Add a replay-safe admission feature or policy correction only if it is
   supported by multiple failures, not a single trap.
4. Rerun the same paired27 set before any promotion status upgrade.
