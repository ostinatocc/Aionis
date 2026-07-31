# Contributing

AionisRuntime has one product source closure rooted at:

- `src/runtime-entry.ts`;
- `src/sdk.ts`.

Every retained `src` module must be reachable from one of those entries and
must serve the Execution Memory product loop.

Before handing off a product change:

```bash
npm run -s typecheck
npm run -s sdk:check
npm run -s complexity:check
```

Product-effect claims require a real model, real tools, a real task, provider
receipts, and a Runtime-launched verifier. Mock or self-reported success is not
product evidence.

Do not add public operator, debug, audit, measure, replay-repair,
sandbox-repair, governance-control, or manual candidate routes.
