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

The next batch is a 52-record audited expansion:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/fixtures/phase2-gradient-expanded52-audited.jsonl
```

It was generated from an audited Phase 1 manifest:

```bash
cd /Volumes/ziel/AionisRuntime-evals
npm run -s external-agent-e2e:generate-phase2-gradient -- \
  --manifest external-agent-e2e/fixtures/phase1-traps-expanded13-audited.jsonl \
  --output external-agent-e2e/fixtures/phase2-gradient-expanded52-audited.jsonl
```

The check-only plan is:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/external-credibility-expanded52-audited-plan-2026-07-01/
```

Plan status:

| Item | Count |
| --- | ---: |
| Planned records | 52 |
| Base traps | 13 |
| Ready base traps | 13 |
| Candidate base traps | 0 |
| Repositories | 3 |
| History levels | 4 |
| Arms | 5 |

Repository mix:

| Repository | Base traps |
| --- | ---: |
| `vitejs/vite` | 3 |
| `vercel/next.js` | 7 |
| `microsoft/playwright` | 3 |

Three candidate base traps were promoted into the audited manifest after source
audit, local detector triage, and preflight:

| Candidate base trap | Source audit status | Blockers |
| --- | --- | ---: |
| `vercel-next.js-3caee03f2a66-source-trap-1` | `manual_review_required` | 0 |
| `vercel-next.js-dc856d6c337e-source-trap-4` | `manual_review_required` | 0 |
| `microsoft-playwright-c758b15077ef-source-trap-3` | `manual_review_required` | 0 |

The expanded audited manifest passed validation with 13 ready traps:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/fixtures/phase1-traps-expanded13-audited.jsonl
```

Full preflight passed against GitHub source commits:

```text
/Volumes/ziel/AionisRuntime-evals/external-agent-e2e/reports/trap-preflight-2026-07-01T06-17-11-629Z/
```

Preflight result:

| Checked | OK | Failed |
| ---: | ---: | ---: |
| 13 | 13 | 0 |

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
  --manifest external-agent-e2e/fixtures/phase2-gradient-expanded52-audited.jsonl \
  --report-dir external-agent-e2e/reports/external-credibility-expanded52-audited-plan-2026-07-01 \
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
  --manifest external-agent-e2e/fixtures/phase2-gradient-expanded52-audited.jsonl \
  --report-dir external-agent-e2e/reports/<run-id> \
  --arms no_memory,full_history,bm25_retrieval,mem0,aionis \
  --base-url "$AIONIS_BASE_URL"
```

## Next Step

The immediate next step is not another Runtime change. It is the 52-record
five-arm run:

1. Start Runtime with the current release build.
2. Ensure the Mem0 dependency environment is available.
3. Run the 52-record five-arm batch.
4. Generate a context-stability report with the same tables as the 40-case
   baseline.
