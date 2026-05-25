# Contributing

## Baseline

Use Node `22.x`.

Recommended setup:

```bash
nvm use
npm ci
npm run build
npm run lite:test
npm run lite:smoke
```

## Scope

This repository contains the Aionis Core kernel and its local runtime shell.

Core responsibilities:

1. task start, handoff, and replay kernel surfaces
2. shared memory, learning control, and runtime contracts
3. SDK and runtime boundary packages
4. contributor-facing local runtime shell

Keep changes aligned with that scope. Multi-tenant control-plane and server-only control surfaces do not belong here.

## Pull Request Expectations

Before opening a PR:

1. run `npm run build`
2. run `npm run lite:test`
3. run `npm run lite:smoke` for runtime-affecting changes
4. update docs when API, health, or operator behavior changes

## Contract Changes

If you change external behavior, keep these contracts coherent:

1. automation response envelopes
2. health response envelopes
3. error response envelopes
4. local runtime route boundary semantics
