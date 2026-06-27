# Aionis External Messaging Contract

This contract keeps public Aionis language aligned with the product that exists
in code. It applies to the website, README top sections, Docs landing pages,
package READMEs, release posts, and marketplace copy.

## Canonical Positioning

Aionis gives agents shorter, cleaner, auditable execution context that carries
across sessions, agents, devices, and model switches.

Aionis is an execution memory Runtime. It records evidence from agent work,
governs which memories can influence the next action, compiles admitted state
into compact context, attributes feedback to the memories that were exposed,
and preserves an audit trail for operators.

## Product Pillars

Use these as the public hierarchy:

1. **Governed execution context**: accepted route, current state, blocked
   alternatives, procedures, rehydrate pointers, and receipts instead of raw
   history dumps.
2. **Continuity across agents and sessions**: carry useful state across
   compaction, handoff, model switches, devices, and agent roles.
3. **Admission learning loop**: guide exposure, actual use, feedback outcome,
   and measurement become an auditable dataset for improving admission quality.
4. **Controlled forgetting and rehydration**: stale, unsafe, archived, or
   pointer-only memories remain governed rather than silently disappearing or
   leaking into direct instructions.
5. **Flight Recorder**: replay what memory the agent could see, what was
   suppressed, why it was routed that way, and what happened afterward.
6. **Trace-derived skill candidates**: successful execution traces can become
   reviewable skill candidates without bypassing admission and review gates.

## Integration Framing

Aionis is agent-host agnostic in product language. Say:

- Connect Aionis to Claude Code, Codex, Cursor, OpenClaw, Hermes Agent, custom
  agents, LangChain-style loops, SDK hosts, HTTP services, MCP clients, or file
  reading agents.
- Use SDK/HTTP when you control the loop.
- Use MCP when an agent host supports MCP tools.
- Use AIFS when the agent reads workspace files more reliably than it calls
  tools.
- Use native plugins when a host supports lifecycle hooks.

Do not make one host sound like the product center. Claude Code, MCP, AIFS, SDK,
HTTP, and future plugins are integration surfaces for the same Runtime.

## Preferred Claims

- "Clean execution state, not more history."
- "Shorter context with current state, governed alternatives, rehydrate
  pointers, and audit receipts."
- "Aionis turns plans, decisions, validation results, handoffs, and feedback
  into reusable execution memory."
- "Aionis lets existing memory backends keep retrieval while Aionis governs
  admission before prompt use."
- "Aionis records which memory was exposed, used, suppressed, rehydrated, and
  followed by which outcome."

## Avoid

Avoid public-first copy that leads with negation or weak boundaries:

- "Aionis is not..."
- "Aionis does not..."
- "Aionis is just..."
- "Claude Code is only..."
- "MCP-only..."
- "entry point" as the main description for a product surface
- "first available plugin" as the main story
- "not a cloud/SaaS/model router/agent" in top-level marketing copy

Internal architecture docs may state boundaries when they prevent misuse. Public
product copy should lead with what users get.

## Rewrite Patterns

| Weak wording | Product wording |
|---|---|
| Aionis is not bound to any agent. | Connect Aionis to the agents and frameworks you already use. |
| Claude Code is just a plugin entry. | Use Aionis with Claude Code to inject governed context and record execution evidence automatically. |
| MCP-only hosts need manual context. | MCP gives compatible hosts a direct tool bridge to Aionis guide, observe, handoff, and Flight Recorder. |
| Aionis does not replace retrieval. | Keep retrieval where it works; let Aionis govern admission before memory reaches the agent. |
| Aionis is not another agent. | Aionis supplies the execution-memory boundary around your agent loop. |

## Page Structure

Public pages should follow this order:

1. User pain and outcome.
2. Aionis capability.
3. Integration path.
4. Evidence and benchmark link.
5. Implementation details.

If a page must state a limitation, place it after the user has already
understood the value and the supported path.
