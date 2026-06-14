# Aionis Memory Firewall

Aionis Memory Firewall governs candidate memories before they can influence an
Agent prompt. It is designed for teams that already use Mem0, Zep, Pinecone,
pgvector, markdown notes, logs, or an internal memory store, but need a
state-adjudicated admission layer in front of that memory.

Use it when the main risk is not forgetting, but remembering the wrong thing:

- failed branches that look semantically relevant
- stale implementation notes
- contested memories with newer counter-evidence
- suppressed or policy-blocked memory
- raw evidence pointers that must be rehydrated before exact use
- unknown external sources that should not direct action

Memory Firewall is exposed through the backend-agnostic gateway:

```http
POST /v1/memory/govern
```

Runnable SDK quickstart:

```bash
npm run -s runtime:quickstart:memory-firewall
```

Example output:
[docs/examples/memory-firewall-quickstart-result.json](examples/memory-firewall-quickstart-result.json).

Set `mode` to `firewall`:

```json
{
  "tenant_id": "default",
  "scope": "checkout-agent",
  "run_id": "run-001",
  "query_text": "Continue the checkout migration without reusing failed branches.",
  "mode": "firewall",
  "include_records": true,
  "candidates": [
    {
      "external_memory_id": "mem0:current-route",
      "source_backend": "mem0",
      "text": "Current accepted target is packages/api/src/checkout.ts.",
      "metadata": {
        "target_files": ["packages/api/src/checkout.ts"]
      },
      "authority": {
        "source_trust": "trusted",
        "scope": "project",
        "evidence_requirement": "none"
      },
      "lifecycle_hint": "current"
    },
    {
      "external_memory_id": "zep:failed-route",
      "source_backend": "zep",
      "text": "The legacy route failed verifier checks.",
      "authority": {
        "source_trust": "trusted",
        "scope": "project",
        "evidence_requirement": "none"
      },
      "lifecycle_hint": "failed"
    }
  ]
}
```

The response still returns the normal Aionis surfaces:

```text
use_now | inspect_before_use | do_not_use | rehydrate
```

In firewall mode it also returns:

```json
{
  "memory_firewall": {
    "contract_version": "aionis_memory_firewall_summary_v1",
    "mode": "firewall",
    "direct_use_count": 1,
    "inspect_count": 0,
    "blocked_count": 1,
    "rehydrate_count": 0,
    "unsafe_direct_use_count": 0,
    "runtime_mutation": false,
    "agent_prompt_included": false
  }
}
```

## What It Enforces

Memory Firewall has one hard product boundary: unsafe external memory cannot
silently become an Agent instruction.

In `firewall` mode:

- trusted current/procedure memory can enter `use_now`
- unknown or untrusted memory stays `inspect_before_use`
- failed, stale, contested, suppressed, archived, or policy-blocked memory does
  not enter direct-use
- rehydrate-required memory stays pointer-only until source evidence is opened
- the route does not write external candidates into Aionis memory

This is not semantic ranking. A candidate can be highly relevant and still be
blocked if its state says it is unsafe for action.

## What It Does Not Guarantee

Memory Firewall does not replace the Agent reasoning loop. It cannot guarantee
the Agent will obey the prompt, nor can it prove an external memory is true when
the source backend provides no evidence. Its job is to expose an auditable
admission decision before memory reaches the Agent.

Use `memory_use_receipt` and `memory_admission_records` to log the decision, then
feed outcomes back through the normal Aionis feedback loop when the host can
observe whether the memory helped or hurt.

## SDK Usage

```ts
import { createAionisClient } from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: "http://127.0.0.1:3001",
  tenant_id: "default",
  scope: "checkout-agent",
});

const result = await aionis.governMemory({
  query_text: "Continue the checkout migration.",
  mode: "firewall",
  include_records: true,
  candidates: [
    {
      external_memory_id: "mem0:current-route",
      source_backend: "mem0",
      text: "Current accepted target is packages/api/src/checkout.ts.",
      authority: {
        source_trust: "trusted",
        scope: "project",
        evidence_requirement: "none",
      },
      lifecycle_hint: "current",
    },
  ],
});

const agentContext = result.agent_context;
const audit = result.memory_firewall;
```

Only pass `agent_context.prompt_text` or selected `agent_context` fields to the
Agent. Keep `memory_firewall`, `memory_use_receipt`, and
`memory_admission_records` in host/operator logs.
