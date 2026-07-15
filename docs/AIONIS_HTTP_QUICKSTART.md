# Aionis HTTP Quickstart

Status: curl-first product quickstart for the v0.3.9 Local Runtime Public Beta candidate

This quickstart shows the product loop without the TypeScript SDK:

```text
observe -> guide -> agent action -> feedback -> measure -> snapshot
```

It uses only public product routes:

```text
/v1/observe
/v1/guide
/v1/feedback
/v1/measure
/v1/rehydrate
/v1/operator/snapshot
```

`/v1/forget` remains available for advanced lifecycle control, but it is not
needed for the normal host loop.

For production Agent integrations, prefer the SDK `guideAgentContext()` or
`execution.guideAgentContextForRole()` helpers and pass their top-level
`agent_prompt` to the Agent. This HTTP guide is the lower-level Runtime contract.

## Start Runtime

`POST /v1/guide` uses semantic recall, so configure an embedding provider before
starting the Runtime.

OpenAI example:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
```

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```

Then start the Runtime:

```bash
npm install
npm run -s lite:start
```

Runnable HTTP smoke test:

```bash
npm run -s runtime:quickstart:http
```

Use the local Runtime URL:

```bash
export AIONIS_URL="http://127.0.0.1:3001"
export AIONIS_SCOPE="http-quickstart-$(date +%s)"
export AIONIS_AGENT_ID="agent-http-quickstart"
```

The examples use `jq` to save IDs and assemble JSON payloads.

## 1. Guide Before Memory

Ask Aionis for context before writing memory. This should produce no actionable
history in a fresh scope.

```bash
curl -sS -X POST "$AIONIS_URL/v1/guide" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"mode\": \"full_power\",
    \"query_text\": \"Continue the HTTP quickstart status update.\",
    \"consumer_agent_id\": \"$AIONIS_AGENT_ID\",
    \"limit\": 8,
    \"include_packets\": true
  }" | tee /tmp/aionis-before-guide.json | jq '.agent_context'
```

## 2. Observe Memory

Write an ordinary preference memory. The host reports what happened; Aionis
governs whether it can be used later.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d "{
    \"operation_id\": \"observe:$AIONIS_SCOPE:http-pref\",
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"auto_embed\": true,
    \"input_text\": \"HTTP_QUICKSTART_PREF: prefer concise product updates with concrete next steps.\",
    \"memory_lane\": \"private\",
    \"owner_agent_id\": \"$AIONIS_AGENT_ID\",
    \"memory\": {
      \"client_id\": \"http-quickstart-pref\",
      \"type\": \"self_model\",
      \"memory_kind\": \"general_memory\",
      \"title\": \"HTTP quickstart response preference\",
      \"text_summary\": \"HTTP_QUICKSTART_PREF: prefer concise product updates with concrete next steps.\",
      \"confidence\": 0.92,
      \"slots\": {
        \"source\": \"http_quickstart\",
        \"lifecycle_state\": \"active\"
      }
    }
  }" | tee /tmp/aionis-observe.json | jq '{operation_id, observed, post_commit_projections}'
```

Keep the generated `operation_id` with the logical write. If the connection is
lost, retry the exact request with the same ID to receive the stored receipt.
Do not reuse that ID for different content. Projection status `scheduled` means
the durable job committed; inspect `/health` for completion or retry state.

## 3. Guide After Memory

Ask for context again. If you are integrating without the SDK, pass only
`agent_context.prompt_text` or selected `agent_context` fields to the Agent.
Do not pass packets, traces, receipts, snapshots, raw slots, or raw payloads.

```bash
curl -sS -X POST "$AIONIS_URL/v1/guide" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"mode\": \"full_power\",
    \"query_text\": \"HTTP_QUICKSTART_PREF continue the product update.\",
    \"consumer_agent_id\": \"$AIONIS_AGENT_ID\",
    \"limit\": 8,
    \"include_packets\": true
  }" | tee /tmp/aionis-after-guide.json | jq '.agent_context'

export AIONIS_GUIDE_TRACE_ID="$(jq -r '.guide_trace_id' /tmp/aionis-after-guide.json)"
export AIONIS_USED_MEMORY_ID="$(jq -r '.agent_context.use_now_memory_ids[0]' /tmp/aionis-after-guide.json)"
```

The host should keep `guide_trace_id` and `use_now_memory_ids` outside the Agent
prompt. They are for feedback attribution.

## 4. Agent Action

Run your Agent with the compiled context. This quickstart simulates the Agent
step so the memory loop stays framework-free.

```bash
jq -r '.agent_context.prompt_text' /tmp/aionis-after-guide.json
echo "Simulated Agent: used the concise update preference."
```

## 5. Feedback

Report which exposed memory ID was actually used and what happened. Aionis
checks the `guide_trace_id` ledger before attributing feedback.

```bash
curl -sS -X POST "$AIONIS_URL/v1/feedback" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"reason\": \"The Agent used the exposed HTTP quickstart preference successfully.\",
    \"run_id\": \"run-http-quickstart-001\",
    \"outcome\": \"positive\",
    \"used_surface\": \"use_now\",
    \"guide_trace_id\": \"$AIONIS_GUIDE_TRACE_ID\",
    \"used_memory_ids\": [\"$AIONIS_USED_MEMORY_ID\"],
    \"verifier_status\": \"passed\",
    \"tool_status\": \"succeeded\"
  }" | tee /tmp/aionis-feedback.json | jq '.forget_effect'
```

## 6. Measure

Measure whether history changed the future context. `product_trace` accepts the
before guide, after guide, and feedback result. Do not assert
`sufficient_evidence` or invent `evidence_ids`: the Runtime derives evidence
sufficiency from its own durable guide, verifier, and feedback receipts.

```bash
jq -n \
  --slurpfile before /tmp/aionis-before-guide.json \
  --slurpfile after /tmp/aionis-after-guide.json \
  --slurpfile feedback /tmp/aionis-feedback.json \
  --arg scope "$AIONIS_SCOPE" \
  '{
    tenant_id: "default",
    scope: $scope,
    task: {
      task_id: "task-http-quickstart",
      run_id: "run-http-quickstart-001",
      task_signature: "http-quickstart",
      task_family: "developer_http_quickstart"
    },
    product_trace: {
      before_guide: $before[0],
      after_guide: $after[0],
      forget_result: $feedback[0]
    }
  }' > /tmp/aionis-measure-payload.json

curl -sS -X POST "$AIONIS_URL/v1/measure" \
  -H "content-type: application/json" \
  -d @/tmp/aionis-measure-payload.json \
  | tee /tmp/aionis-measure.json \
  | jq '{evidence_assessment, history_impact: .effect_report.history_impact}'
```

This framework-free quickstart does not produce a trusted Runtime verifier
receipt, so it is expected to remain diagnostic and ineligible for skill
export. Legacy client claims are accepted only for compatibility and reported
under `evidence_assessment.client_claims_ignored`; they never open the gate.

## 7. Snapshot

Read a compact operator snapshot. This is observability, not Agent prompt
content.

```bash
jq -n \
  --slurpfile after /tmp/aionis-after-guide.json \
  --slurpfile measure /tmp/aionis-measure.json \
  --arg scope "$AIONIS_SCOPE" \
  --arg guideTrace "$AIONIS_GUIDE_TRACE_ID" \
  '{
    tenant_id: "default",
    scope: $scope,
    run_id: "run-http-quickstart-001",
    task_signature: "http-quickstart",
    agent_context: $after[0].agent_context,
    guide_packet: $after[0].guide_packet,
    memory_decision_trace: $measure[0].memory_decision_trace,
    memory_decision_audit: $measure[0].memory_decision_audit,
    effect_report: $measure[0].effect_report,
    guide_trace_id: $guideTrace,
    include_markdown: false
  }' > /tmp/aionis-snapshot-payload.json

curl -sS -X POST "$AIONIS_URL/v1/operator/snapshot" \
  -H "content-type: application/json" \
  -d @/tmp/aionis-snapshot-payload.json \
  | jq '.operator_snapshot.memory_use_receipt'
```

## Optional: Rehydrate

Use `/v1/rehydrate` when compact context says an archived memory or anchor
payload must be expanded before exact reuse.

```bash
curl -sS -X POST "$AIONIS_URL/v1/observe" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"auto_embed\": true,
    \"input_text\": \"HTTP_QUICKSTART_ARCHIVE: archived workflow can be restored when the same continuation returns.\",
    \"memory_lane\": \"shared\",
    \"memory\": {
      \"client_id\": \"http-quickstart-archived-workflow\",
      \"type\": \"procedure\",
      \"tier\": \"archive\",
      \"memory_kind\": \"execution_workflow\",
      \"title\": \"HTTP quickstart archived workflow\",
      \"text_summary\": \"HTTP_QUICKSTART_ARCHIVE: archived workflow can be restored when the same continuation returns.\",
      \"confidence\": 0.83
    }
  }" | tee /tmp/aionis-archive-observe.json >/dev/null

export AIONIS_ARCHIVE_MEMORY_ID="$(jq -r '.memory_write.nodes[0].id' /tmp/aionis-archive-observe.json)"

curl -sS -X POST "$AIONIS_URL/v1/rehydrate" \
  -H "content-type: application/json" \
  -d "{
    \"tenant_id\": \"default\",
    \"scope\": \"$AIONIS_SCOPE\",
    \"target\": \"archive\",
    \"memory_ids\": [\"$AIONIS_ARCHIVE_MEMORY_ID\"],
    \"target_tier\": \"hot\",
    \"reason\": \"The same continuation returned and needs this archived workflow.\"
  }" | jq '.forget_effect'
```

## Product Boundary

Do not pass these to the Agent by default:

1. `memory_packet`
2. `guide_packet`
3. `memory_decision_trace`
4. `memory_decision_audit`
5. raw memory rows
6. raw slots

The Agent receives compiled context. Operators and hosts inspect receipts,
traces, measures, and snapshots.
