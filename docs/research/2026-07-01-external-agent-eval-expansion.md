# External Agent Eval Expansion - July 2026

This note records the next external-agent evidence expansion after the 40-case
five-arm context-stability run.

## Current Baseline

The current strongest external-agent evidence package is:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/external-credibility-five-arm-all40-rehydrate-mem0deps-2026-06-28/
```

That run compared five arms:

- `no_memory`
- `full_history`
- `bm25_retrieval`
- `mem0`
- `aionis`

The product-relevant result was context stability:

| Arm | Runs | Action completion | Accepted direction | Prompt tokens | Total tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full History | 40 | 97.5% | 100.0% | 1,684,567 | 1,821,808 |
| BM25 Retrieval | 40 | 100.0% | 100.0% | 651,377 | 802,620 |
| Mem0 | 40 | 100.0% | 100.0% | 1,096,738 | 1,248,053 |
| Aionis | 40 | 100.0% | 100.0% | 650,482 | 794,196 |

Aionis preserved 40/40 continuation completion while using 61.4% fewer prompt
tokens than Full History and 40.7% fewer prompt tokens than Mem0. On buried
histories, Aionis preserved 100% completion with 83.0% fewer prompt tokens than
Full History.

## Expansion Batch

The next batch is a 52-record candidate expansion:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/fixtures/phase2-gradient-expanded52-candidate.jsonl
```

It was generated from the Phase 1 trap manifest with candidate records included:

```bash
cd /Volumes/ziel/AionisRuntime-evals
npm run -s external-agent-e2e:generate-phase2-gradient -- \
  --include-candidates \
  --output external-agent-e2e/fixtures/phase2-gradient-expanded52-candidate.jsonl
```

The check-only plan is:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/external-credibility-expanded52-plan-2026-07-01/
```

Plan status:

| Item | Count |
| --- | ---: |
| Planned records | 52 |
| Base traps | 13 |
| Ready base traps | 10 |
| Candidate base traps | 3 |
| Repositories | 3 |
| History levels | 4 |
| Arms | 5 |

Repository mix:

| Repository | Base traps |
| --- | ---: |
| `vitejs/vite` | 3 |
| `vercel/next.js` | 7 |
| `microsoft/playwright` | 3 |

The three candidate base traps are not public-claim evidence yet. They must pass
source audit and detector review before the expanded run is used as an external
product claim.

Initial source audit was run for the three candidate base traps:

| Candidate base trap | Source audit status | Blockers |
| --- | --- | ---: |
| `vercel-next.js-3caee03f2a66-source-trap-1` | `manual_review_required` | 0 |
| `vercel-next.js-dc856d6c337e-source-trap-4` | `manual_review_required` | 0 |
| `microsoft-playwright-c758b15077ef-source-trap-3` | `manual_review_required` | 0 |

The source audit result only proves that the referenced GitHub evidence commit
and target-file changes are structurally plausible. It does not promote these
candidate traps to public evidence by itself.

## Metrics For The Expansion

Lead metrics:

- action completion
- accepted-direction recognition
- prompt tokens / total tokens / context chars
- audit trace coverage
- rehydrate surface coverage
- context sufficiency failures

Guardrail metrics:

- unsafe direct-use
- stale or contested direct-use
- wrong-write / wrong-target actions
- terminal conflict rate

The headline remains governed context stability: shorter, cleaner, auditable
execution context that preserves current route state. Failed-path reuse remains
a guardrail, not the main product claim.

## Run Commands

Check the planned 52 records without paid model calls:

```bash
cd /Volumes/ziel/AionisRuntime-evals
npm run -s external-agent-e2e:phase2-gradient -- \
  --manifest external-agent-e2e/fixtures/phase2-gradient-expanded52-candidate.jsonl \
  --report-dir external-agent-e2e/reports/external-credibility-expanded52-plan-2026-07-01 \
  --arms no_memory,full_history,bm25_retrieval,mem0,aionis \
  --check-only
```

Run the existing 40-record ready-control batch:

```bash
cd /Volumes/ziel/AionisRuntime-evals
npm run -s external-agent-e2e:phase2-gradient -- \
  --manifest external-agent-e2e/fixtures/phase2-gradient-traps.jsonl \
  --report-dir external-agent-e2e/reports/<run-id> \
  --arms no_memory,full_history,bm25_retrieval,mem0,aionis \
  --base-url "$AIONIS_BASE_URL"
```

Run the 52-record expanded batch after candidate audit:

```bash
cd /Volumes/ziel/AionisRuntime-evals
npm run -s external-agent-e2e:phase2-gradient -- \
  --manifest external-agent-e2e/fixtures/phase2-gradient-expanded52-candidate.jsonl \
  --report-dir external-agent-e2e/reports/<run-id> \
  --arms no_memory,full_history,bm25_retrieval,mem0,aionis \
  --base-url "$AIONIS_BASE_URL"
```

## Next Step

The immediate next step is not another Runtime change. It is candidate audit:

1. Review the 3 candidate base traps.
2. Confirm deterministic detectors and source evidence.
3. Promote them to ready only if they pass audit.
4. Run 5-arm on the expanded set.
5. Generate a context-stability report with the same tables as the 40-case
   baseline.
