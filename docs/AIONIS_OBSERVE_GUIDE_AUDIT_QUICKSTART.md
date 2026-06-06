# Aionis Observe Guide Audit Quickstart

Status: product quickstart for the focused local Runtime

This quickstart shows the shortest product path:

`observe -> guide -> audit`

It is not an Agent harness, benchmark runner, demo app, or external framework
adapter. It only shows how a host should call the product facade.

## Start Runtime

`POST /v1/guide` uses semantic recall, so the Runtime needs an embedding
provider. `POST /v1/observe` can write memory without one, but this quickstart
needs both `observe` and `guide`.

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```

OpenAI-compatible example:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-provider-key"
export OPENAI_EMBED_BASE_URL="https://api.openai.com/v1"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
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

## 1. Observe Old Memory

Write a prior working note. It is useful history, but later evidence will
contradict it.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d '{
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
  }'
```

## 2. Observe Correcting Memory

Write a newer memory that explicitly corrects the old route.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d '{
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
  }'
```

## 3. Guide The Agent

Ask Aionis for compact Agent context. `include_packets: true` is used here
because the next audit call needs the full guide output. The Agent itself should
still receive only `agent_context.prompt_text` or selected `agent_context`
fields.

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

1. The Agent sees compact context only.
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
