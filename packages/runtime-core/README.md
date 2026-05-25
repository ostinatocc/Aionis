# @ostinato/aionis-rtc

Shared runtime-core boundary for Aionis Runtime.

## Install

```bash
npm install @ostinato/aionis-rtc
```

This package is intentionally small. Its purpose is to define the stable shared boundary for core runtime contracts.

Current responsibilities:

1. shared runtime ownership metadata
2. shared-surface identifiers
3. boundary contracts used across runtime surfaces
4. continuity, learning-control, and local runtime shell boundaries

Later phases can move additional bootstrapping and runtime implementation here once the boundary is stable.

## Local workflow

```bash
cd /path/to/AionisRuntime
npm install
npm run runtime-core:build
```

## Release checks

```bash
npm run runtime-core:pack:dry-run
npm run runtime-core:publish:dry-run
npm run runtime-core:release:check
```
