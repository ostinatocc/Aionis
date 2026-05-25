# Aionis Focused Runtime Lite Shell

This directory owns the local runtime shell used to boot Aionis Runtime in development.

Current state:

1. It owns the local runtime shell entrypoint and startup script.
2. It launches the root runtime source tree through `tsx`.
3. It keeps local shell startup behavior isolated from the shared core packages.
4. It does not depend on a copied `dist/index.js` launcher artifact.

Current commands:

```bash
npm --prefix apps/lite run build
npm --prefix apps/lite run start
npm --prefix apps/lite run start:print-env
```

Current runtime model:

1. root `src/index.ts` is the runtime source entrypoint
2. `apps/lite/src/index.js` is the local runtime shell launcher
3. `apps/lite/scripts/start-lite-app.sh` owns local shell startup behavior
4. root `scripts/start-lite.sh` delegates to the Lite app startup script
5. startup runs directly from source and does not require a prebuilt wrapper artifact

Default local identity:

1. local shell startup exports `LITE_LOCAL_ACTOR_ID=local-user` unless overridden
2. replay/playbook routes use that actor when no auth principal is present
3. replay playbook runs use the same identity, so local continuity flows work without extra identity payloads

Useful override:

```bash
LITE_LOCAL_ACTOR_ID=lucio npm --prefix apps/lite run start
```

Default local product boundary:

1. the shell starts only the local Runtime kernel
2. inspector/playground/docs apps are not part of this focused copy
3. `LITE_INSPECTOR_ENABLED=false` by default
4. sandbox remains available only as a validation substrate, not as a product surface

Default local memory lifecycle behavior:

1. Lite exposes `POST /v1/memory/archive/rehydrate`
2. Lite exposes `POST /v1/memory/nodes/activate`
3. the public SDK can call these through `aionis.memory.archive.rehydrate(...)` and `aionis.memory.nodes.activate(...)`
