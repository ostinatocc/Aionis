# Aionis Runtime SDK Examples

Focused examples for `@ostinato/aionis`.

Build the SDK first:

```bash
npm install
npm run -s sdk:build
```

Start the local Runtime:

```bash
npm run -s lite:start
```

Kept examples:

1. `00-core-path.ts` - smallest continuity loop: write, task start, handoff, replay
2. `01-recall-and-context.ts` - recall text and planning context
3. `02-replay-run-lifecycle.ts` - replay lifecycle used by learning
4. `03-sessions-and-handoff.ts` - session continuity and handoff
5. `06-host-bridge-context.ts` - host task context and stateful task session adapter
6. `07-agent-memory-inspect.ts` - inspect/review/resume/handoff packs
7. `08-self-evolving-task-start.ts` - repeated task starts improve from prior execution
8. `09-policy-memory-materialization.ts` - repeated feedback materializes policy memory
9. `10-policy-learning-control-loop.ts` - retire/reactivate policy memory
10. `11-continuity-provenance-proof.ts` - continuity carriers preserve provenance
11. `12-session-continuity-proof.ts` - sessions promote stable workflow guidance
12. `13-semantic-forgetting-proof.ts` - archive, rehydrate, and restore colder memory
13. `14-action-retrieval-and-gates.ts` - action retrieval and uncertainty gates

Removed examples:

1. automation product surface
2. sandbox product surface
3. public SDK dogfood loop tied to broad release validation
4. service lifecycle dogfood tied to external adapter proofing
