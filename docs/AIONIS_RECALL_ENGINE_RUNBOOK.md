# Aionis Recall Engine Runbook

Status: product runbook for candidate retrieval, source traces, and guide
diagnostics

The Recall Engine is the candidate retrieval layer below Aionis governance. It
answers:

```text
Which memories might matter, and why were they retrieved?
```

It does not answer:

```text
May this memory instruct the Agent now?
```

That decision still belongs to Aionis admission: lifecycle, authority, scope,
source trust, feedback attribution, rehydration state, and risk gates compile a
candidate into `use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`.

## Operating Modes

`RECALL_ENGINE_MODE` controls route-level candidate generation.

| Mode | Behavior | Default |
|---|---|---|
| `semantic_scan` | Uses the existing bounded semantic candidate path, including exact recovery and optional ANN-sidecar behavior when configured. | Lite |
| `hybrid` | Merges semantic, lexical, structured, execution-native, graph, and recent candidates with source traces before governance. | Server |

Use `semantic_scan` when you want the smallest local Lite posture. Use `hybrid`
when the Runtime is serving SDK/MCP clients and should recover candidates from
paths, workflow signatures, failure modes, target files, and other execution
signals in addition to embeddings.

Example:

```bash
RECALL_ENGINE_MODE=hybrid npm run -s dev
```

Server Edition defaults to `hybrid` because the managed-server e2e verifies that
broader retrieval remains below admission governance. Lite defaults to
`semantic_scan` so local demos keep the narrower retrieval posture unless the
developer opts in.

## Candidate Sources

Source traces explain why a memory was retrieved. They are read-only evidence
about candidate generation.

| Source | Meaning |
|---|---|
| `semantic` | Embedding or bounded semantic similarity found the candidate. |
| `lexical` | Keyword, path, symbol, command, or phrase matching found it. |
| `structured` | Structured task, workflow, repo, target file, failure, verifier, or acceptance-check fields matched. |
| `execution_native` | Execution-native index fields linked the candidate to an active, failed, stale, or accepted branch. |
| `graph` | Existing memory edges linked the candidate to an already retrieved seed. |
| `recent` | Hot working-set or recently activated state kept a selected candidate visible. In hybrid mode this augments primary candidates, or acts as fallback when no primary seed exists. |
| `exact_recovery` | Cold or low-salience exact recovery found a candidate missed by bounded semantic scan. |
| `ann` | Optional ANN sidecar proposed the candidate, then SQLite scope and visibility checks re-admitted the ID as a candidate. |
| `substrate` | Optional Substrate sidecar proposed the candidate ID from mirrored durable evidence, then Runtime SQLite scope, visibility, and governance reloaded the candidate. |

These source traces can appear in:

- `memory_packet.relevant_memories[].recall_sources`
- `memory_decision_trace.memory_decisions[].recall_sources`
- `memory_use_receipt.decision_summaries[].recall_sources`
- `memory_admission_record.entries[].recall_sources`
- operator snapshots through the embedded receipt/admission record
- Agent Flight Recorder replay fields

They must not be treated as prompt instructions or memory authority.

## Troubleshooting Decision Tree

Use this order when a host says "Aionis did not use the right memory."

### 1. Did candidate retrieval find it?

Check the guide trace, memory use receipt, admission record, or Flight Recorder
for the memory ID and its `recall_sources`.

If the memory is absent from every recall trace, this is a candidate retrieval
miss. Check:

- `tenant_id` and `scope` match the write path
- `RECALL_ENGINE_MODE` is the expected mode
- `query_text` is present for lexical/semantic recall
- `structured_recall_context` carries task/workflow/target-file/failure-mode
  fields when the host knows them
- embeddings were actually written for semantic recall
- the memory is not archived or outside visibility/scope limits
- recall eval source coverage and p50/p95 latency

Do not fix a retrieval miss by weakening admission gates.

### 2. Was it retrieved but not admitted?

If the memory appears in recall traces but not in any Agent-facing surface, this
is an admission decision, not a retrieval failure. Check:

- lifecycle state: failed, stale, contested, superseded, suppressed, archived
- source trust and scope contract
- evidence requirement and rehydration requirement
- premise/firewall risk reasons
- feedback attribution from prior guides

The correct result may be `do_not_use` or `rehydrate`, especially for failed,
stale, contaminated, or payload-required memory.

### 3. Was it routed to `inspect_before_use`?

`inspect_before_use` means Aionis found possibly relevant evidence but did not
grant direct action authority. This is normal for:

- ambiguous or unknown-source candidates
- contested memories
- memories with insufficient evidence
- external memory firewall candidates without lifecycle authority
- old branches that are readable as reference but not directions

If the Agent needs this evidence to proceed, the host should either ask for
rehydration or give the Agent an explicit inspect step. Do not count inspect
placement as wrong direct use.

### 4. Was it routed to `rehydrate`?

`rehydrate` means the compact context is intentionally not enough. The host
should fetch the raw evidence, payload, or source artifact pointed to by the
rehydrate hint, then continue the Agent step with the expanded evidence.

If a task fails because the Agent refused to edit without enough details, check
whether the memory was already flagged for rehydration before increasing global
context budgets.

### 5. Was it in `use_now` but the Agent ignored it?

If the memory is in `use_now`, retrieval and admission succeeded. The remaining
issue is usually host prompt integration or Agent compliance. Check:

- the host actually passed `agent_context.prompt_text` or the relevant
  structured fields to the Agent
- compact prompt mode did not drop the current active target
- the Agent did not abandon a current route because a pending artifact was
  missing from the file system
- feedback reported whether the exposed memory was actually used
- Flight Recorder shows what the Agent could see at decision time

Do not turn one Agent's refusal into a Runtime hard rule.

### 6. Did full history work but Aionis did not?

Classify the failure before changing Runtime behavior:

| Symptom | Likely class |
|---|---|
| Expected memory absent from all recall traces | Candidate retrieval gap |
| Memory retrieved but blocked/suppressed | Admission or lifecycle evidence issue |
| Memory in `inspect_before_use` but Agent needed concrete edit details | Evidence sufficiency or rehydrate gap |
| Memory in `use_now` but Agent ignored it | Host prompt or Agent compliance issue |
| Agent used blocked memory anyway | Host prompt contamination or Agent misuse |

This classification protects Aionis from adding task-specific constraints after
one failed run.

## Required Checks

Before changing recall behavior, run the focused retrieval and product checks:

```bash
npm run -s recall:eval -- --deterministic-latency
npm run -s runtime:e2e:recall-source-governance
npm run -s runtime:e2e:managed-server-hybrid-recall
npm run -s test:focused
```

For config posture and route-level mode regressions:

```bash
npx tsx --test scripts/ci/lite-config-posture.test.ts scripts/ci/server-config-posture.test.ts scripts/ci/lite-recall-store-access.test.ts
```

For a no-key product troubleshooting example:

```bash
npm run -s runtime:e2e:recall-troubleshooting
```

The committed example result is
[examples/recall-engine-troubleshooting-result.json](examples/recall-engine-troubleshooting-result.json).

For ANN provider comparison:

```bash
npm run -s recall:ann:compare -- --deterministic-latency
npm run -s recall:ann:scale
```

For a fresh local install with the optional persisted Zvec candidate sidecar:

```bash
npx aionis setup --with-zvec-ann
# or
npx @aionis/create@latest .aionis-runtime --with-zvec-ann
```

The committed scale diagnostic is
[examples/zvec-recall-scale-comparison/summary.md](examples/zvec-recall-scale-comparison/summary.md).
It isolates candidate retrieval only: Zvec/local ANN can recover a low-salience
semantic needle that bounded SQLite scan misses, while SQLite remains the fact
source and admission/governance stay out of scope.

For optional Substrate sidecar candidate recall, first mirror Runtime evidence
with `@aionis/substrate`, install the optional package inside the Runtime
directory, then start Runtime with:

```bash
npm install --save-dev @aionis/substrate@latest
```

```bash
RECALL_ENGINE_MODE=hybrid \
RECALL_SUBSTRATE_SIDECAR_ENABLED=true \
RECALL_SUBSTRATE_PATH=.aionis-substrate/substrate.sqlite \
npm run -s lite:start
```

Substrate only proposes candidate IDs. Runtime reloads them from Runtime SQLite
before any guide/admission output is compiled.

Expected managed-server hybrid recall result:

- accepted route reaches `use_now`
- failed/stale branches are not direct-use
- recall source families include semantic, lexical, structured,
  execution-native, graph, recent, and optional sidecar sources
- source-level admission is preserved: stronger candidate coverage does not
  promote failed or stale execution memory into `use_now`
- receipt/admission record/operator snapshot carry source traces
- Agent Flight Recorder replays accepted, failed, and stale source traces
  without including Agent prompt payload
- source traces remain read-only and do not mutate admission

## When To Add ANN

Do not add or swap ANN backends merely because one case missed retrieval. Add a
real ANN backend only after source-aware metrics show that semantic candidate
coverage or latency is the bottleneck and lexical/structured/execution-native
sources are already measured.

ANN remains candidate generation. SQLite remains the local fact source, and
Aionis governance remains the memory authority.
