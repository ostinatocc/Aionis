# Aionis Memory Firewall Launch Post

Status: reusable external launch copy

## Core Message

Use Mem0 for retrieval. Use Aionis as the Memory Firewall.

Most agent memory systems answer: "What memory is related?"

Aionis answers the next question before the Agent acts: "Is this memory current,
failed, stale, contested, untrusted, or only safe after rehydration?"

## Short Launch Post

We just added a drop-in Mem0 path to Aionis.

Mem0 can keep doing retrieval. Aionis sits between retrieved memory and the
Agent prompt as a Memory Firewall.

```text
Mem0 search -> Aionis governMem0SearchResults -> governed Agent context
```

In a 12-scenario real local Mem0 A/B:

| Arm | Wrong direct-use | Current route recall | Audit coverage |
| --- | ---: | ---: | ---: |
| Mem0 raw | 83.3% | 100.0% | 0.0% |
| Mem0 + Aionis Firewall | 0.0% | 100.0% | 100.0% |

The important part: Mem0 retrieved the current route in every case, but it also
retrieved unsafe memories in 10 cases. Aionis preserved the current route while
keeping failed, stale, contested, suppressed, untrusted, and rehydrate-required
memories out of direct Agent instructions.

Memory is not recall. Memory is state.

## Longer Launch Post

Agents do not only need to remember more. They need to stop acting on the wrong
memory.

That is the gap Aionis is built for.

Retrieval systems like Mem0 are useful because they bring back related history.
But related history is not automatically safe history. A failed branch can be
semantically close to the next task. A stale note can mention the exact file the
Agent is about to edit. A contested memory can look confident while newer
evidence says not to use it.

Aionis adds an admission layer after retrieval and before prompt use:

```text
retrieve candidates -> adjudicate state -> compile Agent context -> audit receipt
```

The Agent does not receive one blob of recalled text. It receives governed
surfaces:

```text
use_now | inspect_before_use | do_not_use | rehydrate
```

The new SDK path is:

```ts
const mem0Results = await mem0.search("continue the task", {
  user_id,
  top_k: 10,
});

const governed = await aionis.governMem0SearchResults({
  query_text: "Continue without repeating failed branches.",
  mem0_results: mem0Results,
});

await agent.run(governed.agent_context.prompt_text);
```

In our first real local Mem0 A/B, Mem0 retrieved the accepted current route in
12/12 cases. It also retrieved unsafe memories 10 times. Raw Mem0 context leaked
wrong direct-use in 83.3% of cases. Mem0 plus Aionis Memory Firewall kept wrong
direct-use at 0% while preserving 100% current-route recall.

This does not mean Aionis replaces Mem0. The point is the opposite:

Mem0 is retrieval. Aionis is memory governance.

Use both.

## Developer Copy

Install:

```bash
npm install @aionis/sdk
```

Use with Mem0:

```ts
import { createAionisClient } from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "my-agent",
});

const mem0Results = await mem0.search("continue the task", {
  user_id: "my-agent",
  top_k: 10,
});

const governed = await aionis.governMem0SearchResults({
  query_text: "Continue without repeating failed branches.",
  mem0_results: mem0Results,
});

const prompt = governed.agent_context.prompt_text;
const audit = {
  memory_firewall: governed.memory_firewall,
  memory_use_receipt: governed.memory_use_receipt,
  memory_admission_records: governed.memory_admission_records,
};
```

## One-Liners

- Mem0 helps Agents remember. Aionis decides whether what was remembered is safe
  to act on now.
- Retrieval answers relevance. Aionis answers admissibility.
- A failed branch can be relevant. Aionis keeps it from becoming an instruction.
- Memory is not recall. Memory is state.
- Keep your memory backend. Govern what reaches the Agent.

## Boundary Copy

This is a small product evidence snapshot, not a broad benchmark. The A/B used
real local Mem0 `Memory.add/search` with `infer=false`. It measures admission
after retrieval, not final external Agent task success, Mem0 cloud quality, or
Mem0 LLM extraction.

The claim is deliberately narrow and useful:

When a memory backend retrieves mixed current and unsafe history, Aionis can
serve as the admission layer that keeps unsafe memory out of direct Agent
instructions while preserving the current route.

## Links

- SDK: `@aionis/sdk`
- MCP bridge: `@aionis/mcp`
- One-command installer: `@aionis/create`
- Product report: [AIONIS_MEM0_FIREWALL_AB_REPORT.md](AIONIS_MEM0_FIREWALL_AB_REPORT.md)
- Memory Firewall docs: [AIONIS_MEMORY_FIREWALL.md](AIONIS_MEMORY_FIREWALL.md)
