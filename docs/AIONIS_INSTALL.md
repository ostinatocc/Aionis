# Install Aionis

Status: product install path for Runtime plus SDK packages

## One Command

After the installer package is published to npm:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create --provider minimax --quickstart sdk
```

For raw HTTP users:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create --provider minimax --quickstart http
```

For multi-agent execution memory:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create --provider minimax --quickstart multi-agent
```

The installer does not change Runtime core. It performs product setup:

1. clone `https://github.com/ostinatocc/Aionis.git`
2. run `npm install`
3. write `.env` with the selected embedding provider
4. build `@aionis/sdk` and `@aionis/create`
5. run the selected quickstart when an API key is available

## Local Development Before npm Publish

From this repo:

```bash
npm install
npm run -s packages:build
npm run -s packages:test
```

Run the installer locally:

```bash
npx tsx packages/create-aionis/src/index.ts ./Aionis-local \
  --provider minimax \
  --quickstart none
```

## SDK Package

After `@aionis/sdk` is published:

```bash
npm install @aionis/sdk
```

```ts
import {
  agentPromptFromGuide,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
} from "@aionis/sdk";
```

Use the SDK only as a facade over the product routes. The Runtime still owns
memory governance, context compilation, feedback attribution, measurement, and
operator snapshots.
