# Aionis Continuation SDK

This package is the strict Node.js transport client for Aionis Continuation
Runtime V1. The runnable Runtime is delivered as an OCI image; it is not part
of this npm package.

The package exports `createAionisRuntimeV1Client` and
`AionisRuntimeV1ClientError`. A client exposes exactly five methods:

- `recordObservations`
- `createContinuation`
- `recordOutcome`
- `decideAuthority`
- `readDecision`

```ts
import { createAionisRuntimeV1Client } from "@aionis/continuation-sdk";

const runtime = createAionisRuntimeV1Client({
  baseUrl: "http://127.0.0.1:3000",
  apiKey: process.env.AIONIS_HOST_API_KEY!,
  timeoutMs: 10_000,
  requestBodyLimitBytes: 1_048_576,
  responseBodyLimitBytes: 4_194_304,
});
```

The client does not compile policy, infer authority, retry mutations, or
translate legacy payloads. Package publication remains disabled while the V1
external release gates are pending.
