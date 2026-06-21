# Aionis First-Value Demo

Status: no-key local product demo for first-time users

This is the fastest way to see what Aionis does before wiring a real Agent,
embedding provider, SDK integration, or external memory backend.

It compares two prompt paths over the same retrieved history:

1. **Raw Retrieval**: every retrieved memory becomes direct Agent context.
2. **Aionis Admission**: the same candidates pass through
   `governMemory(mode="firewall")` before prompt use.

The demo works without an LLM or embedding API key. It starts a temporary Lite
Runtime with `EMBEDDING_PROVIDER=none`, sends external memory candidates to the
product API, prints the result, and refreshes
`docs/examples/first-value-demo-result.json`.

## Run

```bash
npm run -s runtime:demo:first-value
```

The default installer runs the same demo:

```bash
npx @aionis/create@latest
```

## What You Should See

The input history contains:

- a current accepted route
- a failed broad rewrite
- a stale legacy target
- an archived verifier trace that requires rehydration
- an unknown helper note

Aionis should compile the context so that:

- current route enters `use_now`
- failed route enters `do_not_use`
- stale route enters `do_not_use`
- unknown note stays `inspect_before_use`
- archived trace stays pointer-only under `rehydrate`
- memory-use receipt and admission record are visible to the host/operator
- audit records remain host/operator evidence

## Why This Exists

The full Aionis loop is:

```text
observe -> guide -> agent action -> feedback -> measure -> snapshot
```

That is the production integration path. A new developer can see the first value
before wiring the whole loop.

This demo isolates the first adoption moment:

> Raw retrieval can surface relevant but unsafe history. Aionis decides which
> retrieved memories are allowed to act now.

## Example Result

See:
[examples/first-value-demo-result.json](examples/first-value-demo-result.json).

## What This Demonstrates

This demo proves the first adoption moment: Aionis can turn raw retrieved
history into governed Agent context and produce an audit receipt for that
decision.

After this demo, run the SDK quickstart with an embedding provider:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
npm run -s runtime:quickstart:sdk
```
