# v0.3.4 External Agent/MGBench Cost Gate

Status: **approved pilot completed; 10/10 traps completed and the three-arm
evidence contract passed**.

## Completed no-cost preflight

| Check | Result |
| --- | --- |
| Trap manifest validation | Pass |
| Total records | 14 |
| Active records | 13 |
| Ready traps | 10 |
| Candidate traps | 3 |
| Real repository/source preflight | 10/10 pass |
| Model readiness | Pass |
| Cost estimation | Pass |

Preflight report:

- `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/reports/trap-preflight-2026-07-11T06-53-53-296Z`

## Frozen run configuration

| Field | Value |
| --- | --- |
| Config | `external-agent-e2e/configs/phase1-run-config.json` |
| Manifest | `external-agent-e2e/fixtures/phase1-traps.jsonl` |
| Model profile | `deepseek-v4-flash-direct` |
| Endpoint | `https://api.deepseek.com/chat/completions` |
| Model | `deepseek-v4-flash` |
| Arms | `no_memory`, `full_history`, `aionis` |
| Initial seeds | `1` |
| Required traps | 10 |
| Episodes per arm/trap | 2 |
| Estimated episode runs | 60 |

## Estimated and actual usage

| Field | Upper bound |
| --- | ---: |
| Input tokens | 48,000,000 |
| Output tokens | 3,600,000 |
| Input cache-miss price hint | $0.14 / 1M tokens |
| Output price hint | $0.28 / 1M tokens |
| Estimated total | **$7.73** |
| Configured budget | $50.00 |
| Actual prompt tokens | 378,040 |
| Actual completion tokens | 33,397 |
| Actual total tokens | 411,437 |
| Conservative configured-price estimate | **$0.0623** |

The credential was supplied through a no-echo temporary process, was not
written to the repository or an `.env` file, and was removed after the paid
runner exited. The billing estimate applies the configured price hints to the
reported token counts; it is not a provider invoice.

## Execution outcome

The user explicitly approved the frozen 10-trap, three-arm, one-seed pilot.
The run completed all 10 traps with zero runner failures. Aionis accepted the
correct direction in 10/10 cases, executed no wrong branch, and recorded one
rediscovery step. Full History also accepted 10/10 with no wrong-branch action
but recorded five rediscovery steps. No Memory accepted 9/10, executed one
wrong branch, and recorded four rediscovery steps.

Detailed evidence:

- `docs/performance/v0.3.4-post-release/external-agent-pilot/summary.md`
- `/Volumes/ziel/new.aionis/AionisRuntime-evals/external-agent-e2e/reports/phase1-v0.3.4-fix-e5cc4dc-2026-07-11`

This approved run is a Phase 1 pilot. It does not satisfy the implementation
plan's separate 40-case, five-arm regression gate.
