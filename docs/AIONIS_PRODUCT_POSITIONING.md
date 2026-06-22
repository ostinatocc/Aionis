# Aionis Product Positioning

Status: external product positioning guide

Aionis is a state-adjudicated memory runtime for agents that need to keep
working.

Aionis is the Runtime layer that decides which memory state is safe and useful
before compiling the next Agent context. It brings lifecycle, authority,
feedback attribution, and audit to agent memory.

## One-Line Pitch

Memory becomes state before context.

## Short Pitch

Aionis turns agent history into governed execution state. It keeps the accepted
route, action boundary, reusable procedures, and rehydrate pointers available
as shorter Agent context, with a receipt for every memory decision.

Aionis turns plans, decisions, failures, and acceptance checks into reusable
execution memory.

## Longer Pitch

Most agent memory systems retrieve related history and hope the model handles
the rest. Aionis adds a Runtime decision layer before the Agent sees memory.

It adjudicates whether memory is current, stale, contested, failed, reusable, or
worth rehydrating. Then it compiles the result into clear Agent-facing surfaces:
`use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`.

The strongest Aionis surface is execution memory: branch-aware memory of plans,
actions, verifier outcomes, failed attempts, passed continuations, handoffs, and
feedback attribution. This makes Aionis especially useful for long-running
agents and multi-agent systems where the next Agent must inherit actionable
state without replaying full history.

## Category

Aionis should define itself as:

```text
state-adjudicated memory runtime
```

Aionis is not recall-only memory. It is the Runtime boundary that turns memory
into governed state before the next Agent context is compiled.

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

High-quality plans are execution memory assets when they preserve resolved
decisions, acceptance checks, failed branches, active targets, execution
boundaries, and evidence attribution. A strong planner can create the plan, but
Aionis keeps that plan executable across cheaper workers, future sessions, and
other Agent roles.

### 3. Safe Compression

Shorter context is not enough. A useful agent memory runtime must compress while
preserving:

1. current state
2. negative memory
3. stale or contested warnings
4. rehydration pointers
5. audit evidence

Aionis should describe context compression as state-preserving context
compilation.

Wrong-branch handling is part of this safety model. Failed branches are retained
as governed counter-evidence, while the strongest current product claim is
route-safe, execution-ready context at much lower context cost than
full-history transfer.

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

Aionis can sit in front of a team's existing memory store. Mem0, Zep, vector
databases, markdown notes, logs, and internal memory stores can all provide
candidates while Aionis provides admission.

Memory Firewall protects the context boundary. Plan-as-memory is the execution
memory asset that crosses sessions, agents, and models. The two product surfaces
share the same admission gates and solve different jobs.

The product framing is:

```text
Use your existing backend for retrieval. Use Aionis to govern what reaches the Agent.
```

For Mem0 specifically, the wedge is simple:

```text
Mem0 search -> Aionis governMem0SearchResults -> governed Agent context
```

This lets Aionis enter teams that already have a memory backend. The value is
state-governed admission: failed, stale, contested, untrusted, suppressed, or
rehydrate-required memories are routed away from direct Agent instructions.

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

For simple one-shot chat or document Q&A, teams can start with ordinary recall.
Aionis becomes valuable when memory affects future actions, carries lifecycle
state, or needs auditability.

## Messaging Guidelines

Use this language:

1. `state-adjudicated memory runtime`
2. `Memory becomes state before context.`
3. `govern memory state before compiling context`
4. `execution memory for long-running and multi-agent agents`
5. `route-safe context compression`
6. `auditable memory use receipts`
7. `state-preserving context compilation`
8. `use Mem0 for retrieval, use Aionis as the Memory Firewall`
9. `plans, decisions, failures, and acceptance checks become reusable execution memory`
10. `strong models make better plans; Aionis keeps those plans executable across cheaper agents and future sessions`
11. `failed branches become counter-evidence`

Reserve absolute claims for validated reports:

1. `best memory system`
2. `guarantees task success`
3. `beats all baselines`
4. `solves long-horizon agents`

The product should sound ambitious without claiming benchmark dominance that
has not been proven.

## README-Sized Copy

Use this when space is limited:

```text
Aionis is a state-adjudicated memory runtime for agents that need to keep
working. It turns long execution history into route-safe, auditable Agent
context: current state, reusable procedures, risk surfaces, and rehydrate
pointers without replaying full history.
```

## Website-Sized Copy

Use this for landing pages or longer product descriptions:

```text
Most agent memory retrieves related history. Aionis adjudicates memory state.

Before the next Agent sees context, Aionis decides what is current, stale,
contested, failed, reusable, or worth rehydrating. Then it compiles the result
into a compact Agent contract and records a memory use receipt for operators.

For long-running and multi-agent systems, this means execution state survives
session cuts, context stays shorter, handoffs are safer, and memory use remains
auditable.
```

## Product Claims

Aionis can claim:

1. state-governed memory before context compilation
2. branch-aware execution memory
3. route-safe context compression with recorded baselines
4. feedback attribution to exposed memory IDs
5. read-only memory use receipt and operator snapshot surfaces
6. failed-branch isolation as a safety mechanism in product quickstarts and e2es
7. backend-agnostic Memory Firewall for retrieved external candidates

Keep these as research roadmap claims until further evidence exists:

1. guaranteed external task success
2. universal benchmark superiority
3. model-level reasoning improvements independent of host behavior
4. automatic promotion of one task's repair into global rules

The right claim is category definition plus implemented product proof.
