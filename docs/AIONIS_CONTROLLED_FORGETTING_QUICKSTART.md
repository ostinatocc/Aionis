# Aionis Controlled Forgetting Quickstart

Status: curl-first controlled forgetting quickstart for the focused local Runtime

Forget is a core Aionis capability. Aionis should not accumulate every memory
forever, and it should not silently delete source evidence. Controlled
forgetting gives hosts and operators explicit lifecycle control:

```text
observe memory -> guide -> suppress / unsuppress / rehydrate -> measure -> snapshot
```

This quickstart uses the public product route `/v1/forget` for explicit
lifecycle control. `/v1/feedback` and `/v1/rehydrate` are productized
forgetting/lifecycle paths for common host loops; `/v1/forget` is the direct
API when suppressing, unsuppressing, activating, or otherwise controlling memory
state is the product action.

## Start Runtime

`POST /v1/guide` uses semantic recall, so configure an embedding provider before
starting the Runtime.

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"

npm install
npm run -s lite:start

export AIONIS_URL="http://127.0.0.1:3001"
export AIONIS_SCOPE="forget-quickstart-$(date +%s)"
export AIONIS_AGENT_ID="agent-forget-quickstart"
```

MiniMax is also supported with `EMBEDDING_PROVIDER=minimax` and
`MINIMAX_API_KEY`.

The examples use `jq` to save IDs and assemble JSON payloads.

## 1. Observe An Old Memory

Write a useful-looking but outdated memory.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"auto_embed\": true,
    \"input_text\": \"FORGET_QS_OLD checkout work appeared to belong in legacy/payments/old-checkout.ts before later evidence.\",
    \"memory\": {
      \"client_id\": \"forget-quickstart-old-checkout\",
      \"type\": \"concept\",
      \"memory_kind\": \"general_memory\",
      \"title\": \"Old checkout route\",
      \"text_summary\": \"FORGET_QS_OLD checkout work appeared to belong in legacy/payments/old-checkout.ts before later evidence.\",
      \"confidence\": 0.91
    }
  }" | tee /tmp/aionis-forget-old.json | jq '.observed'

export AIONIS_OLD_MEMORY_ID="$(jq -r '.memory_write.nodes[0].id' /tmp/aionis-forget-old.json)"
```

## 2. Observe Correcting Evidence

Write newer evidence that contradicts the old memory. The relation graph lets
Aionis downgrade the old memory instead of treating both notes as equally safe.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"auto_embed\": true,
    \"input_text\": \"FORGET_QS_CURRENT later evidence contradicted the old checkout route. Current change surface is src/payments/checkout.ts and tests/checkout.test.ts.\",
    \"memory\": {
      \"client_id\": \"forget-quickstart-current-checkout\",
      \"type\": \"concept\",
      \"memory_kind\": \"general_memory\",
      \"title\": \"Current checkout route\",
      \"text_summary\": \"FORGET_QS_CURRENT later evidence contradicted the old checkout route. Current change surface is src/payments/checkout.ts and tests/checkout.test.ts.\",
      \"confidence\": 0.94
    }
  }" | tee /tmp/aionis-forget-current.json | jq '.memory_write.edges'
```

## 3. Guide With The Old Premise

Ask a query that mentions the old premise. Aionis should keep the old memory out
of direct use when newer/current evidence contradicts it.

```bash
curl -sS -X POST "$AIONIS_URL/v1/guide" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"query_text\": \"FORGET_QS_OLD legacy/payments/old-checkout.ts checkout validation\",
    \"consumer_agent_id\": \"$AIONIS_AGENT_ID\",
    \"limit\": 8,
    \"include_packets\": true
  }" | tee /tmp/aionis-forget-before-suppress-guide.json | jq '{
    use_now: .agent_context.use_now,
    inspect_before_use: .agent_context.inspect_before_use,
    do_not_use: .agent_context.do_not_use,
    risk: .agent_context.risk
  }'
```

## 4. Suppress The Old Memory

Use `/v1/forget` when the host or operator knows the old memory should not be
used until reviewed.

```bash
curl -sS -X POST "$AIONIS_URL/v1/forget" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"operation\": \"suppress\",
    \"target\": \"pattern\",
    \"anchor_id\": \"$AIONIS_OLD_MEMORY_ID\",
    \"mode\": \"shadow_learn\",
    \"reason\": \"Old checkout route was contradicted by newer evidence; suppress before direct reuse.\"
  }" | tee /tmp/aionis-forget-suppress.json | jq '.forget_effect'
```

## 5. Guide After Suppression

Ask again. The suppressed memory should remain governed and should not become a
direct instruction.

```bash
curl -sS -X POST "$AIONIS_URL/v1/guide" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"query_text\": \"FORGET_QS_OLD legacy/payments/old-checkout.ts checkout validation\",
    \"consumer_agent_id\": \"$AIONIS_AGENT_ID\",
    \"limit\": 8,
    \"include_packets\": true
  }" | tee /tmp/aionis-forget-after-suppress-guide.json | jq '{
    use_now: .agent_context.use_now,
    inspect_before_use: .agent_context.inspect_before_use,
    do_not_use: .agent_context.do_not_use,
    receipt_ready: (.memory_packet != null)
  }'
```

## 6. Measure Forgetting Effect

Measure the before/after guide effect and include the suppress result in
`product_trace.forget_result`. This measures lifecycle behavior; it does not
claim export-grade evidence.

```bash
jq -n \
  --slurpfile before /tmp/aionis-forget-before-suppress-guide.json \
  --slurpfile after /tmp/aionis-forget-after-suppress-guide.json \
  --slurpfile suppress /tmp/aionis-forget-suppress.json \
  --arg scope "$AIONIS_SCOPE" \
  '{
    tenant_id: "default",
    scope: $scope,
    task: {
      task_id: "task-controlled-forgetting",
      run_id: "run-controlled-forgetting-001",
      task_signature: "controlled-forgetting-quickstart",
      task_family: "developer_controlled_forgetting_quickstart"
    },
    product_trace: {
      before_guide: $before[0],
      after_guide: $after[0],
      forget_result: $suppress[0]
    }
  }' > /tmp/aionis-forget-measure-payload.json

curl -sS -X POST "$AIONIS_URL/v1/measure" \
  -H "content-type: application/json" \
  -d @/tmp/aionis-forget-measure-payload.json \
  | tee /tmp/aionis-forget-measure.json \
  | jq '{evidence_assessment, forgetting_effect: .effect_report.forgetting_effect}'
```

The Runtime, not the caller, decides evidence sufficiency. Legacy
`sufficient_evidence` and `evidence_ids` request fields are retained only as
ignored client claims and cannot produce export-ready learning candidates.

## 7. Unsuppress After Review

If an operator reviews the memory and decides it can be considered again, use
`unsuppress`. This is lifecycle control, not silent deletion or irreversible
loss.

```bash
curl -sS -X POST "$AIONIS_URL/v1/forget" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"operation\": \"unsuppress\",
    \"target\": \"pattern\",
    \"anchor_id\": \"$AIONIS_OLD_MEMORY_ID\",
    \"reason\": \"Operator reviewed the old memory; allow future guides to consider it under normal lifecycle gates.\"
  }" | jq '.forget_effect'
```

## Product Boundary

Controlled forgetting must be evidence-preserving:

1. suppress stale or harmful memory instead of deleting source evidence silently
2. keep contradicted memory out of direct-use prompt surfaces
3. rehydrate archived payload only when needed
4. unsuppress reviewed memory when it becomes valid again
5. expose memory-use receipts and measure forgetting effect

Do not treat `/v1/forget` as a secondary route. It is the explicit
lifecycle-control API for one of Aionis's core product capabilities.
