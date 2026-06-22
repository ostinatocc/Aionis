# @aionis/create

One-command installer for Aionis Runtime, SDK, MCP bridge, and optional Claude
Code lifecycle hooks.

Docs: [https://docs.aionis.work/get-started/install](https://docs.aionis.work/get-started/install)

Run:

```bash
npx @aionis/create@latest
```

The default run installs Aionis and starts the no-key first-value demo. It shows
the Memory Firewall blocking failed and stale memory before you configure an
embedding provider.

Run the full SDK quickstart with OpenAI-compatible embeddings:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart sdk
```

Install without running any quickstart:

```bash
npx @aionis/create@latest my-aionis --skip-quickstart
```

Install Runtime into a side directory and onboard Claude Code globally:

```bash
npx @aionis/create@latest .aionis-runtime \
  --with-claude-code \
  --claude-code-dir . \
  --claude-code-base-url http://127.0.0.1:3001
```

The installer clones the Runtime repo, installs dependencies and workspace
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart and runs Claude Code onboarding. The installed repo includes
`@aionis/sdk` for application integration, `@aionis/mcp` for MCP clients, and
`@aionis/claude-code` for Claude Code lifecycle integration.

If no embedding key is detected, the installer writes `EMBEDDING_PROVIDER=none`
so the local Runtime can start immediately. That no-key mode is enough for the
first-value demo, MCP wiring, execution-memory smoke tests, and Memory Firewall
candidate governance. Configure semantic recall later by setting
`EMBEDDING_PROVIDER=openai` plus `OPENAI_API_KEY`, or
`EMBEDDING_PROVIDER=minimax` plus `MINIMAX_API_KEY`, in the generated `.env`.

Common first runs:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart multi-agent
```

After install, pick the integration path:

- SDK: [https://docs.aionis.work/integrations/sdk](https://docs.aionis.work/integrations/sdk)
- Claude Code hooks: [https://docs.aionis.work/integrations/claude-code](https://docs.aionis.work/integrations/claude-code)
- MCP for Claude Code / Cursor: [https://docs.aionis.work/integrations/mcp](https://docs.aionis.work/integrations/mcp)
- Memory Firewall: [https://docs.aionis.work/products/memory-firewall](https://docs.aionis.work/products/memory-firewall)
