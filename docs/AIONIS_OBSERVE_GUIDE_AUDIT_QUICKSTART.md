# Aionis Observe Guide Audit Quickstart

Status: product quickstart for the v0.3.11 candidate Runtime

This quickstart shows the shortest product path:

`observe -> guide -> audit`

It is not an Agent harness, benchmark runner, demo app, or external framework
adapter. It only shows how a host should call the product facade.

For the full host loop with feedback, measurement, operator snapshot, and
single-agent / multi-agent / coding-agent templates, see
[AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md).
For a curl-first loop over the public product routes, see
[AIONIS_HTTP_QUICKSTART.md](AIONIS_HTTP_QUICKSTART.md).
For explicit controlled forgetting with suppress, unsuppress, and measure, see
[AIONIS_CONTROLLED_FORGETTING_QUICKSTART.md](AIONIS_CONTROLLED_FORGETTING_QUICKSTART.md).

## Start Runtime

`POST /v1/guide` uses semantic recall, so the Runtime needs an embedding
provider. `POST /v1/observe` can write memory without one, but this quickstart
needs both `observe` and `guide`.

OpenAI-compatible example:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-provider-key"
export OPENAI_EMBED_BASE_URL="https://api.openai.com/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
```

DashScope `text-embedding-v4` example:

```bash
export EMBEDDING_PROVIDER="dashscope"
export DASHSCOPE_API_KEY="your-dashscope-key"
export DASHSCOPE_EMBEDDING_MODEL="text-embedding-v4"
```

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```

Then start the local Runtime:

```bash
npm install
npm run -s lite:start
```

Default local URL:

```bash
export AIONIS_URL="http://127.0.0.1:3001"
```

If `POST /v1/guide` returns `no_embedding_provider`, configure one of the
embedding providers above and restart the Runtime.

The commands below use `jq` only to inspect JSON responses.

## SDK Product Loop

For the smallest developer-facing SDK loop, run:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="$AIONIS_URL"
npm run -s runtime:quickstart:sdk
```

This verifies `remember -> guide -> agent prompt -> feedback -> measure ->
snapshot` through `src/sdk.ts` and prints a compact JSON summary. The full SDK
guide is [AIONIS_SDK_QUICKSTART.md](AIONIS_SDK_QUICKSTART.md).

For the broader product SDK path, use the product loop e2e:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="$AIONIS_URL"
npm run -s runtime:e2e:product-loop
```

This runs a real Runtime loop through `observe`, `guide`, `rehydrate`, and
`measure`. It passes only compact `agent_context.prompt_text` to a simulated
Agent step, observes the Agent outcome, measures the before/after guide effect,
and checks that execution-tree audit surfaces stay out of the Agent prompt.

If `AIONIS_PRODUCT_E2E_BASE_URL` is not set, the script starts an isolated local
Runtime on a random port and uses the embedding provider from the environment.

## Golden Product Loop

For the full product proof path, run:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="$AIONIS_URL"
npm run -s runtime:e2e:golden-product-loop
```

This verifies `observe -> guide -> agent action -> outcome feedback -> measure
-> snapshot` over a real Runtime. It shows that a fresh scope has no actionable
history, later execution memory changes the reviewer guide, failed branches stay
isolated, and the operator snapshot explains memory use, feedback attribution,
measured effect, and trace-to-procedure readiness.

Details and a compact result example are in
[AIONIS_GOLDEN_PRODUCT_LOOP.md](AIONIS_GOLDEN_PRODUCT_LOOP.md).

## Ordinary Memory Product Loop

For the general cognitive memory path, run:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="$AIONIS_URL"
npm run -s runtime:e2e:ordinary-memory
```

This verifies ordinary preference/fact/project memory over a real Runtime:
active ordinary memory can enter `use_now`, newer corrected facts can push old
facts to `inspect_before_use`, and `memory_use_receipt.decision_summaries`
explain each decision without entering the Agent prompt. The same loop also
checks candidate memory stays inspect-first, suppressed memory stays
`do_not_use`, private ordinary memory does not cross agent ownership boundaries,
and ordinary memory writes do not create execution trees.

## Host Template E2Es

For release-level host integration checks, run the real Runtime host-template
e2es:

```bash
npm run -s runtime:e2e:single-agent-host-template
npm run -s runtime:e2e:multi-agent-host-template
npm run -s runtime:e2e:multi-agent-host-template-fresh
```

These scripts verify the full host contract:

1. fresh scopes keep `actionable_history_used: false`
2. ordinary private memory guides a single Agent only when owner/consumer
   identity is aligned
3. shared team memory guides multi-agent roles inside the team boundary
4. feedback attribution uses `guide_trace_id` plus IDs the instrumented host
   observed as used and Runtime verifies against persisted guide exposure
5. `measure` reports history impact
6. operator snapshot remains read-only and operator-facing

## Multi-Agent Developer Quickstart

For the shortest developer-facing multi-agent product path, run:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="$AIONIS_URL"
npm run -s runtime:quickstart:multi-agent
```

This runs the SDK client, execution-memory adapter, and
`createMultiAgentHostTemplate` over a real Runtime. It writes planner, worker,
verifier, and reviewer execution evidence; gives the reviewer the SDK
`agent_prompt`; records feedback attribution; measures history impact; and
returns a bounded JSON summary with:

1. whether the fresh guide had actionable history
2. whether the reviewer guide used actionable execution memory
3. prompt contract version, prompt size, and prompt preview
4. visible `use_now` IDs for correlation plus exact host-observed IDs used for
   attribution
5. failed-branch isolation status
6. memory use receipt, feedback attribution, effect, and trace-to-procedure
   operator surfaces

If `AIONIS_PRODUCT_E2E_BASE_URL` is not set, the script starts an isolated local
Runtime and uses the embedding provider from the environment.

## Real Agent Downstream Demo

To validate that governed Aionis execution context changes a real LLM Agent's
next action, run:

```bash
export AIONIS_AGENT_E2E_TRIALS_PER_SCENARIO=3
npm run -s runtime:e2e:agent-suite
```

This starts an isolated Runtime, writes branch-aware execution history, compares
`baseline`, `long_context`, and `aionis` groups, and writes a summary under
`.tmp/runtime-agent-e2e/`. The `product_demo` section checks that Aionis:

1. restores the verified active path for the Agent
2. keeps failed branches out of direct use
3. gives the Agent shorter execution context than raw long history
4. records evidence-backed feedback after the Agent acts

This is a downstream Agent-context demo, not a claim that Aionis owns external
task execution.

## 1. Observe Old Memory

Write a prior working note. It is useful history, but later evidence will
contradict it.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d '{
    "operation_id": "observe:quickstart:old-checkout-route",
    "tenant_id": "default",
    "scope": "quickstart",
    "auto_embed": true,
    "memory": {
      "client_id": "quickstart-old-checkout-route",
      "type": "concept",
      "memory_kind": "general_memory",
      "title": "Initial checkout route",
      "text_summary": "QUICKSTART_OLD_ROUTE Initial checkout work looked like it belonged in legacy/payments/old-checkout.ts. This was an early working note before later evidence.",
      "confidence": 0.91
    }
  }' | jq '{operation_id, observed, post_commit_projections}'
```

## 2. Observe Correcting Memory

Write a newer memory that explicitly corrects the old route.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d '{
    "operation_id": "observe:quickstart:current-checkout-route",
    "tenant_id": "default",
    "scope": "quickstart",
    "auto_embed": true,
    "memory": {
      "client_id": "quickstart-current-checkout-route",
      "type": "concept",
      "memory_kind": "general_memory",
      "title": "Corrected checkout route",
      "text_summary": "QUICKSTART_CURRENT_ROUTE Later repository evidence corrected the earlier checkout note. The legacy route should be treated as an unverified prior; current checkout work belongs in src/payments/checkout.ts.",
      "confidence": 0.94
    }
  }' | jq '{operation_id, observed, post_commit_projections}'
```

Each ID belongs to one logical write. Retry the exact request with the same ID
after an ambiguous network failure; never reuse it for different content.
Projection `scheduled` means the durable job exists, not that embedding or ANN
work completed synchronously.

## 3. Guide The Agent

Ask Aionis for governed Agent context. `include_packets: true` is used here
because the next audit call needs the full guide output. SDK hosts should give
the Agent `guideAgentContext().agent_prompt`; this direct HTTP example prints
the lower-level Runtime `agent_context.prompt_text`.

```bash
GUIDE_JSON="$(
  curl -sS -X POST "$AIONIS_URL/v1/guide" \
    -H "content-type: application/json" \
    -d '{
      "tenant_id": "default",
      "scope": "quickstart",
      "query_text": "QUICKSTART_OLD_ROUTE checkout route",
      "consumer_agent_id": "local-user",
      "limit": 8,
      "include_packets": true
    }'
)"
```

Agent prompt surface:

```bash
printf "%s\n" "$GUIDE_JSON" | jq -r '.agent_context.prompt_text'
```

Expected product behavior:

1. The Agent sees governed context only, not raw packets or traces.
2. The old route should not be direct `use_now` guidance.
3. The old route should be visible for inspection if it remains relevant.
4. The prompt should not contain `memory_decision_trace`,
   `memory_decision_audit`, or `decision_reviews`.

## 4. Audit The Memory Decision

Ask Aionis why memory was used, downgraded, blocked, or marked for
rehydration.

```bash
printf "%s\n" "$GUIDE_JSON" \
  | jq '{tenant_id:"default", scope:"quickstart", product_trace:{after_guide:.}}' \
  | curl -sS -X POST "$AIONIS_URL/v1/audit/memory-decision-report" \
      -H "content-type: application/json" \
      -d @- \
  | jq '.memory_decision_audit.decision_reviews'
```

Expected audit behavior:

1. `used_memories` shows memory allowed into direct use.
2. `downgraded_memories` shows memory moved to inspect-before-use by newer
   evidence.
3. Each downgraded memory includes the memory that caused the downgrade,
   lifecycle relation, producer, gate, and signals.
4. `blocked_memories` and `rehydrate_memories` are present when lifecycle or
   payload state requires them.

## Product Boundary

Use this split in real integrations:

| Output | Consumer |
|---|---|
| `agent_context.prompt_text` | Agent prompt |
| `agent_context` structured fields | Host prompt builder / UI |
| `memory_packet` and `guide_packet` | Measurement or advanced integration |
| `memory_decision_trace` | Developer debug |
| `memory_decision_audit` | Operator/product audit |

Do not pass debug or audit surfaces to the Agent. They are for inspecting
Aionis, not for solving the task.
