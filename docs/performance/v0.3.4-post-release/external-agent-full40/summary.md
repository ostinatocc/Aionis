# External Agent E2E Phase 2 Gradient

Run: `full40-five-arm-v0.3.4-fix-e5cc4dc-2026-07-11`

- Requested records: 40
- Started records: 40
- Completed records: 40
- Prepared-only records: 0
- Failed records: 0
- Pending records: 0
- Run status: complete

## Protocol Qualification

This artifact freezes the manifest and agent script hashes, but the original
run did not record the multi-step agent environment controls. Inspection of the
retained decision artifacts shows that `rehydrate` terminated the agent instead
of continuing as a tool step; `AIONIS_E2E_REHYDRATE_CONTINUES` defaults to
disabled when it is not explicitly set. The context, direction, safety, and
token measurements below remain valid same-run evidence. The 0% executable
action-completion rows are protocol-inconclusive rather than isolated evidence
of a Runtime or model regression.

## By Level And Arm

| Level | Arm | Runs | Wrong write rate | Wrong attention rate | Accepted direction rate | Action completion rate | Rediscovery steps | Initial context chars | Prompt tokens | Completion tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tidy | no_memory | 10 | 0% | 80% | 20% | 0% | 8 | 8,869 | 123,208 | 57,715 |
| tidy | full_history | 10 | 0% | 0% | 100% | 0% | 0 | 35,656 | 42,161 | 21,181 |
| tidy | bm25_retrieval | 10 | 0% | 0% | 100% | 0% | 0 | 37,499 | 55,525 | 18,325 |
| tidy | mem0 | 10 | 0% | 0% | 100% | 0% | 0 | 113,608 | 110,214 | 19,002 |
| tidy | aionis | 10 | 0% | 0% | 100% | 0% | 0 | 55,943 | 46,934 | 16,549 |
| separated | no_memory | 10 | 20% | 90% | 10% | 20% | 13 | 8,867 | 104,215 | 51,274 |
| separated | full_history | 10 | 0% | 0% | 100% | 0% | 0 | 95,927 | 116,974 | 28,067 |
| separated | bm25_retrieval | 10 | 0% | 0% | 100% | 0% | 0 | 70,186 | 77,378 | 21,143 |
| separated | mem0 | 10 | 0% | 0% | 100% | 0% | 0 | 173,084 | 153,417 | 22,181 |
| separated | aionis | 10 | 0% | 0% | 100% | 0% | 0 | 56,563 | 67,685 | 18,397 |
| implicit | no_memory | 10 | 0% | 100% | 0% | 0% | 10 | 8,868 | 107,902 | 42,083 |
| implicit | full_history | 10 | 0% | 0% | 100% | 0% | 0 | 278,592 | 215,112 | 19,992 |
| implicit | bm25_retrieval | 10 | 0% | 0% | 100% | 0% | 0 | 73,785 | 81,010 | 24,628 |
| implicit | mem0 | 10 | 0% | 0% | 100% | 0% | 0 | 184,457 | 130,062 | 13,976 |
| implicit | aionis | 10 | 0% | 0% | 100% | 0% | 0 | 50,712 | 46,569 | 15,929 |
| buried | no_memory | 10 | 0% | 90% | 10% | 10% | 9 | 8,869 | 79,500 | 39,781 |
| buried | full_history | 10 | 0% | 0% | 100% | 0% | 0 | 942,081 | 422,001 | 14,058 |
| buried | bm25_retrieval | 10 | 0% | 0% | 100% | 0% | 0 | 75,072 | 82,201 | 22,577 |
| buried | mem0 | 10 | 0% | 10% | 90% | 0% | 1 | 167,504 | 127,518 | 18,917 |
| buried | aionis | 10 | 0% | 0% | 100% | 0% | 0 | 51,119 | 39,307 | 12,475 |

The canonical source report contains 40 unique successful records and all five
arms for every record. This checked-in summary intentionally excludes raw
prompts, model text, and per-record payloads; those remain in the source report
directory recorded by `comparison.json`.
