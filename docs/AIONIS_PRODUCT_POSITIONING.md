# Aionis Product Positioning

Status: external product positioning guide

Aionis is a state-adjudicated memory runtime for agents that need to keep
working.

It is not recall-only memory. It is not a vector database wrapper. It is not a
benchmark runner. Aionis is the Runtime layer that decides which memory state is
safe and useful before compiling the next Agent context.

## One-Line Pitch

Memory is not recall. Memory is state.

## Short Pitch

Aionis turns agent history into governed execution state. It remembers what
worked, keeps failed or stale branches from leaking back into prompts, compiles
shorter Agent context, and gives operators a receipt for every memory decision.

## Longer Pitch

Most agent memory systems retrieve related history and hope the model handles
the rest. Aionis adds a Runtime decision layer before the Agent sees memory.

It adjudicates whether memory is current, stale, contested, failed, reusable, or
worth rehydrating. Then it compiles the result into clear Agent-facing surfaces:
`use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`.

The strongest Aionis surface is execution memory: branch-aware memory of plans,
actions, verifier outcomes, failed attempts, passed continuations, handoffs, and
feedback attribution. This makes Aionis especially useful for long-running
agents and multi-agent systems where the next Agent must inherit state without
repeating old mistakes.

## Category

Aionis should define itself as:

```text
state-adjudicated memory runtime
```

Not:

1. recall memory
2. vector memory
3. RAG framework
4. agent framework
5. benchmark system
6. prompt compression library

Aionis can work with Agent frameworks and retrieval systems, but its product
job is different: govern memory state, compile context, attribute feedback, and
make memory use auditable.

## Positioning Pillars

### 1. State Before Context

Raw recall asks, "What history is similar?"

Aionis asks, "What is the state of this memory, and should the Agent use it?"

The product value is the state gate before context compilation.

### 2. Execution Memory As The Moat

Execution memory is not just a summary of prior work. It carries branch state:

1. passed paths
2. failed branches
3. current active path
4. verifier outcomes
5. handoff boundaries
6. reusable workflow candidates
7. feedback attribution

This is the differentiated Aionis surface. It is what makes Aionis useful for
multi-agent systems, coding agents, workflow agents, and long-running
automation.

### 3. Safe Compression

Shorter context is not enough. A useful agent memory runtime must compress while
preserving:

1. current state
2. negative memory
3. stale or contested warnings
4. rehydration pointers
5. audit evidence

Aionis should describe context compression as state-preserving context
compilation, not generic summarization.

### 4. Auditable Memory Use

Agent memory should be inspectable. Aionis exposes memory use receipts and
operator snapshots so hosts can see:

1. which memories were used
2. which were blocked
3. which require inspection
4. which need rehydration
5. why feedback was attributed
6. whether history helped or hurt

### 5. Memory Firewall For Existing Backends

Aionis does not need to replace a team's memory store. It can sit in front of
Mem0, Zep, vector databases, markdown notes, logs, or internal memory stores as
the admission layer.

The product framing is:

```text
Use your existing backend for retrieval. Use Aionis to govern what reaches the Agent.
```

For Mem0 specifically, the wedge is simple:

```text
Mem0 search -> Aionis governMem0SearchResults -> governed Agent context
```

This lets Aionis enter teams that already have a memory backend. The value is
not "store memories better than Mem0"; the value is preventing failed, stale,
contested, untrusted, suppressed, or rehydrate-required memories from becoming
direct Agent instructions.

## Aionis vs Alternatives

| Approach | What it does | What Aionis adds |
|---|---|---|
| Long context | Passes more history to the model. | Compiles only governed memory state into the Agent surface. |
| Vector recall / RAG | Retrieves related text. | Separates current, stale, contested, failed, and rehydratable memory before use. |
| Recall memory products | Store and retrieve user or task memories. | Adds lifecycle, authority, feedback attribution, and operator audit. |
| Mem0 / Zep-style memory backends | Retrieve useful memory candidates. | Governs candidate admission before prompt use without replacing the backend. |
| Workflow memory | Stores successful procedures. | Also keeps failed branches as counter-evidence and tracks active path state. |
| Prompt summarization | Compresses text. | Preserves execution state, negative memory, rehydration pointers, and receipts. |
| Agent frameworks | Orchestrate tools, roles, and model calls. | Supplies governed memory context without owning orchestration. |

## Aionis vs Recall Memory

Recall memory says:

```text
Here is related history.
```

Aionis says:

```text
Here is the governed state of memory:
use this now, inspect this first, avoid this branch, rehydrate this payload.
```

That distinction is the product.

## Who Should Use Aionis?

Aionis is a strong fit for:

1. long-running coding agents
2. multi-agent planner / worker / verifier / reviewer systems
3. support and operations agents that must remember outcomes
4. workflow agents that should avoid repeated discovery
5. products that need memory audit trails
6. agent hosts that want feedback attribution and controlled forgetting

Aionis is not the best first tool for:

1. one-shot chat
2. simple document Q&A
3. pure vector search
4. systems where the Agent should see every raw trace
5. products that do not need memory lifecycle or auditability

## Messaging Guidelines

Use this language:

1. `state-adjudicated memory runtime`
2. `Memory is not recall. Memory is state.`
3. `govern memory state before compiling context`
4. `execution memory for long-running and multi-agent agents`
5. `failed branches become counter-evidence, not prompt pollution`
6. `auditable memory use receipts`
7. `state-preserving context compilation`
8. `use Mem0 for retrieval, use Aionis as the Memory Firewall`

Avoid this language:

1. `best memory system`
2. `guarantees task success`
3. `beats all baselines`
4. `solves long-horizon agents`
5. `just RAG`
6. `just prompt compression`

The product should sound ambitious without claiming benchmark dominance that
has not been proven.

## README-Sized Copy

Use this when space is limited:

```text
Aionis is a state-adjudicated memory runtime for agents that need to keep
working. It remembers what worked, blocks failed or stale branches from leaking
back into prompts, compiles shorter Agent context, and gives operators a
receipt for every memory decision.
```

## Website-Sized Copy

Use this for landing pages or longer product descriptions:

```text
Most agent memory retrieves related history. Aionis adjudicates memory state.

Before the next Agent sees context, Aionis decides what is current, stale,
contested, failed, reusable, or worth rehydrating. Then it compiles the result
into a compact Agent contract and records a memory use receipt for operators.

For long-running and multi-agent systems, this means fewer repeated mistakes,
shorter context, safer handoffs, and auditable execution memory.
```

## Product Claim Boundary

Aionis can claim:

1. state-governed memory before context compilation
2. branch-aware execution memory
3. failed-branch isolation in product quickstarts and e2es
4. feedback attribution to exposed memory IDs
5. read-only memory use receipt and operator snapshot surfaces
6. state-preserving context compression baselines recorded in docs
7. backend-agnostic Memory Firewall for retrieved external candidates

Aionis should not claim:

1. guaranteed external task success
2. universal benchmark superiority
3. model-level reasoning improvements independent of host behavior
4. automatic promotion of one task's repair into global rules

The right claim is category definition plus implemented product proof, not
unbounded benchmark marketing.
