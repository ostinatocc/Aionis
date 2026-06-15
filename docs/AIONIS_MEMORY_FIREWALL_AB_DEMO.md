# Aionis Memory Firewall A/B Demo

Status: runnable product demo for backend-agnostic memory governance

This demo compares two ways to pass retrieved external memory into an Agent:

1. **Raw Retrieval**: every retrieved memory is placed in direct Agent context.
2. **Aionis Memory Firewall**: the same retrieved memories pass through
   `governMemory(mode="firewall")` before prompt use.

It is designed for teams that already use Mem0, Zep, a vector DB, markdown
notes, logs, or an internal memory store. Aionis does not replace retrieval in
this demo. It governs what retrieved memory is allowed to do.

## Run

```bash
npm run -s runtime:e2e:memory-firewall-ab
```

The script starts or targets a real Runtime, then runs six deterministic
scenarios covering:

- failed branch ranked above current memory
- stale premise retrieved with current memory
- contested broad rewrite retrieved with a valid procedure
- rehydrate-required raw evidence pointer
- unknown external note
- current/procedure-only negative controls

## What It Measures

| Metric | Meaning |
|---|---|
| `wrong_direct_use_rate` | Scenario rate where unsafe retrieved memory becomes direct Agent context. |
| `primary_route_chosen_rate` | Whether the first actionable route is current/procedure rather than failed/stale/contested. |
| `current_route_recall_rate` | Whether current/procedure memory remains available after governance. |
| `audit_coverage_rate` | Whether the arm produces receipt/admission/firewall audit output. |
| `mean_context_chars` | Approximate context size for the arm. |

The expected product shape:

```text
Raw Retrieval: high recall, but unsafe memories can enter direct-use.
Aionis Firewall: preserves current/procedure recall, blocks unsafe direct-use, adds audit records.
```

## Example Result

See:
[examples/memory-firewall-ab-demo-result.json](examples/memory-firewall-ab-demo-result.json).

## Boundary

This demo measures admission after retrieval. It does not claim that Aionis
improves Mem0/Zep/vector retrieval quality, and it does not measure final
external Agent task success.

The product claim is narrower and more useful:

> Use your existing memory backend for retrieval; use Aionis Memory Firewall to
> adjudicate whether retrieved memory can act now.

For Mem0-specific evidence, see
[AIONIS_MEM0_FIREWALL_AB_REPORT.md](AIONIS_MEM0_FIREWALL_AB_REPORT.md).
