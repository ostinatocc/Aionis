# Runtime Temporary Transport Removal Design

Date: 2026-07-10

Status: approved

Scope owner: `AionisRuntime-focused`

External consumer in scope: `AionisManifest`

## Decision

Remove the eight remaining temporary internal HTTP transports in two verified
tranches. The first tranche migrates recall and context consumers to the
canonical typed planning/recall services or the public `/v1/guide` product
contract. The second migrates AionisManifest's tool-selection loop to public
`/v1/guide` and `/v1/feedback`, then removes the four tool transports.

The phase exits only when all eight routes are absent from production
registration and the active route matrix. Temporary compatibility routes are
not renamed, hidden, or reclassified as operator APIs.

## Consumer Audit

The remaining temporary transports are:

- `/v1/memory/recall`
- `/v1/memory/recall_text`
- `/v1/memory/planning/context`
- `/v1/memory/context/assemble`
- `/v1/memory/tools/select`
- `/v1/memory/tools/decision`
- `/v1/memory/tools/run`
- `/v1/memory/tools/feedback`

The four recall/context routes have no SDK, CLI, MCP, AIFS, Claude Code, or
Substrate consumer. The native zvec write-through smoke uses raw recall only
to inspect ANN diagnostics. One active eval adapter calls `recall_text` for a
debug projection, while four eval scripts merely accept its retired source-map
name. AionisManifest calls `context/assemble` during resume.

The four tool routes have one external production consumer:
`AionisManifest/src/resume.ts`. It selects a tool, reads the stored decision
and run lifecycle, optionally writes attributed feedback, and rereads the run
lifecycle. No other supported integration package calls these routes.

## Target Product Flow

```mermaid
flowchart LR
  M["Manifest recovered continuity"] --> G["POST /v1/guide"]
  G --> P["Typed planning service"]
  P --> S["Tool selection and stored decision"]
  S --> R["Product tool-selection receipt"]
  R --> A["Manifest chooses the selected tool"]
  A --> F["POST /v1/feedback"]
  F --> V["Verify guide exposure and stored decision"]
  V --> L["Typed learning kernel feedback"]
  L --> O["Feedback result plus run lifecycle"]
```

`/v1/guide` already accepts `tool_candidates` and the planning service already
persists the same tool decision used by the old select route. The guide result
will expose a narrow `tool_selection` receipt containing decision id/URI,
run id, selected tool, candidates, policy hash, source rule ids, and creation
time. Raw rule evaluation, pattern diagnostics, and internal planning state
remain omitted.

The persisted guide exposure ledger will record the same receipt. A
`feedback_kind: "tool_selection"` request to the existing public
`/v1/feedback` route must match that ledger and the persisted decision before
the learning kernel may update rules, patterns, or policy memory. The response
will include the feedback result and post-feedback run lifecycle, so Manifest
does not need separate decision or run read routes.

Memory feedback remains the default `/v1/feedback` behavior. Tool feedback is
an explicit strict variant; it does not weaken memory-exposure attribution.

## Tranche 1: Recall and Context

The public product loop continues to use the typed planning context service.
Only its HTTP adapters are removed.

- The zvec smoke calls the typed recall operation directly so ANN diagnostics
  remain real without treating raw recall as a product API.
- The eval adapter uses `/v1/guide` product packets and source maps instead of
  a second debug request.
- AionisManifest moves from `context/assemble` to the guide request in the tool
  migration tranche.
- Route-only recall and context-assemble code is deleted. Planning service code
  needed by `/v1/guide` remains.

This tranche must preserve real embedding, SQLite truth reload, scope/tenant
isolation, prompt budgets, and product AgentContext behavior.

## Tranche 2: Manifest Tool Loop

AionisManifest resume will become a product-loop client:

1. Recover continuity as it does today.
2. Call `/v1/guide` with query, recovered context, run id, execution state, and
   tool candidates.
3. Read the narrow tool-selection receipt and AgentContext/GuidePacket output.
4. If feedback was requested, call `/v1/feedback` with the guide trace,
   decision receipt, selected tool, candidates, outcome, and execution context.
5. Derive its resume summary from the guide receipt and feedback lifecycle.

The Manifest result contract is versioned to v2 because its internal-route
response fields are replaced by public guide/feedback fields. CLI flags for
candidates and feedback remain supported.

The migration preserves tool ordering, strict candidate filtering, stored
decision identity, rule/pattern/policy feedback, outcome attribution, and run
lifecycle visibility. It removes four HTTP transports; it does not remove the
learning kernel.

## Failure and Security Behavior

- Guide responses without a stored tool decision omit `tool_selection`; they
  never synthesize an authoritative receipt.
- Tool feedback fails closed when the guide trace, tenant, scope, run,
  decision, selected tool, or candidates disagree.
- A feedback request cannot name a decision that was not exposed by its guide.
- Missing product service dependencies return structured product dependency
  errors.
- Embedding/provider failures retain existing planning and learning behavior.
- No fallback calls a retired internal route.

## Verification and Exit Criteria

- Product guide -> tool receipt -> feedback works through real Runtime HTTP and
  SQLite.
- Negative tests reject forged decision, selected-tool, candidate, run, scope,
  and guide-trace attribution.
- AionisManifest verify and a real Runtime resume loop pass through public
  product routes.
- Native zvec tests run without skip and continue to verify SQLite truth.
- Golden, ordinary-memory, multi-agent, negative-transfer, and judgment loops
  remain green.
- Full Lite suite, typecheck, SDK ownership, and external package tests pass.
- Active route matrix falls from 27 to 19; temporary inventory count becomes
  zero; import cycles remain zero.
- Source scans find no production or supported-consumer use of the eight
  retired paths.

Large-file work is deliberately excluded from this phase except where route
deletion removes real responsibility. A later tranche may simplify schemas,
SDK, replay, and stores, but mechanical file splitting is not an exit metric.
