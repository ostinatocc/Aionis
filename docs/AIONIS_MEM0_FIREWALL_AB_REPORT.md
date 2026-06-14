# Mem0 + Aionis Memory Firewall A/B Report

Status: product evidence snapshot for backend-agnostic memory governance

Run: `real-mem0-firewall-ab-2026-06-14T10-59-45-111463+00-00`

## Claim

Aionis does not replace Mem0. It adds a Memory Firewall in front of Mem0
retrieval, so recalled memories are state-adjudicated before they become Agent
instructions.

In this 12-scenario local Mem0 A/B, Mem0 retrieved the current route in every
case. It also retrieved unsafe memories in 10 cases. Aionis preserved current
route recall while preventing those unsafe memories from entering direct use.

## Result

| Arm | Wrong direct-use | Primary route chosen | Current route recall | Audit coverage | Mean chars |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mem0 raw | 83.3% | 58.3% | 100.0% | 0.0% | 560 |
| Mem0 + Aionis Firewall | 0.0% | 100.0% | 100.0% | 100.0% | 722 |

## Interpretation

Mem0 raw retrieval had high recall but no admission boundary. When failed,
stale, contested, suppressed, untrusted, or rehydrate-required memories were
retrieved alongside the current route, the raw arm made every returned memory
available as direct Agent context.

Aionis received the exact same retrieved memories, then routed them into:

```text
use_now | inspect_before_use | do_not_use | rehydrate
```

The current route stayed usable in all cases. Unsafe memories were blocked,
kept inspect-first, or kept pointer-only for rehydration. The Aionis arm also
produced `memory_use_receipt`, `memory_admission_records`, and
`memory_firewall` audit output.

## Retrieval Boundary

This report separates retrieval quality from admission quality:

- Mem0 primary route retrieved: 12/12
- Mem0 forbidden memories retrieved: 10 total
- Unmapped Mem0 result rows: 0 average
- Aionis governed only memories returned by Mem0 search

If Mem0 does not retrieve the current route, Aionis cannot recover it through
this route. The product claim here is admission after retrieval, not better
retrieval.

## Scenario Coverage

The 12 scenarios cover:

- failed branch ranked above current route
- stale premise retrieved with current route
- contested broad rewrite
- rehydrate-required raw evidence pointer
- unknown/untrusted note
- suppressed experiment
- current-only negative controls
- procedure-only negative controls

## SDK Path

For Mem0 users, the drop-in path is:

```ts
const mem0Results = await mem0.search("continue the task", {
  user_id,
  top_k: 10,
});

const governed = await aionis.governMem0SearchResults({
  query_text: "Continue without repeating failed branches.",
  mem0_results: mem0Results,
});

await agent.run(governed.agent_context.prompt_text);

hostLog.write({
  memory_firewall: governed.memory_firewall,
  memory_use_receipt: governed.memory_use_receipt,
  memory_admission_records: governed.memory_admission_records,
});
```

`governMem0SearchResults()` defaults to firewall mode and compact Agent context.
Unlabeled Mem0 rows are inspect-first by default. Direct use requires trusted
authority metadata plus a current or procedure lifecycle hint.

## Methodology

Each scenario wrote fixture memories into local Mem0, called Mem0
`Memory.search`, and then compared two arms:

1. **Mem0 raw**: every returned Mem0 memory is placed in direct Agent context.
2. **Mem0 + Aionis Firewall**: the same returned Mem0 memories are sent to
   `POST /v1/memory/govern` with `mode: "firewall"` before prompt use.

The Aionis arm did not write Mem0 candidates into Aionis memory. It used the
public product API only.

## Boundaries

This is a small product evidence snapshot, not a broad benchmark.

- It is a real local Mem0 `Memory.add/search` run.
- It used Mem0 with `infer=false`; it does not measure Mem0 LLM extraction.
- It does not measure final external Agent task success.
- It does not measure Mem0 cloud service quality.
- It should not be used to justify task-specific Runtime rules.
- It validates the product wedge: backend retrieval plus Aionis admission
  governance.

## One-Line Product Takeaway

Mem0 helps Agents remember. Aionis decides whether what was remembered is safe
to act on now.

Reusable launch copy:
[AIONIS_MEM0_FIREWALL_LAUNCH_POST.md](AIONIS_MEM0_FIREWALL_LAUNCH_POST.md).
