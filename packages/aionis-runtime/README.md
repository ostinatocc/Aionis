# @ostinato/aionis-runtime

Focused local Runtime package for Aionis execution continuity, learning-controlled self-learning, and controlled forgetting.

## Start

```bash
npx @ostinato/aionis-runtime@latest start
```

Local defaults:

1. `AIONIS_EDITION=lite`
2. `AIONIS_MODE=local`
3. `AIONIS_LISTEN_HOST=127.0.0.1`
4. `MEMORY_AUTH_MODE=off`
5. `TENANT_QUOTA_ENABLED=false`
6. `LITE_INSPECTOR_ENABLED=false`
7. `SANDBOX_ENABLED=false`

## Focus

The package keeps only the local Runtime kernel path:

1. execution continuity and recovery
2. replay-derived learning candidates
3. lifecycle, promotion, suppression, and forgetting
4. Lite storage with a path toward a clean Postgres store port

Run the focused validation from the repository root:

```bash
npm run -s test:focused
```
