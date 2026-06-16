# @aionis/create

One-command installer for Aionis Runtime, SDK, and MCP bridge.

Docs: [https://docs.aionis.work/get-started/install](https://docs.aionis.work/get-started/install)

Run:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart sdk
```

Install without running a quickstart:

```bash
npx @aionis/create@latest my-aionis --provider openai --skip-quickstart
```

The installer clones the Runtime repo, installs dependencies and workspace
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart. The installed repo includes `@aionis/sdk` for application
integration and `@aionis/mcp` for Claude Code / Cursor style MCP clients.

Runtime startup needs the selected embedding provider key. If you install
without a key or skip the quickstart, set `OPENAI_API_KEY` in the generated
`.env` before running `npm run -s lite:start`. MiniMax remains supported with
`--provider minimax` and `MINIMAX_API_KEY`.

Common first runs:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart multi-agent
```

After install, pick the integration path:

- SDK: [https://docs.aionis.work/integrations/sdk](https://docs.aionis.work/integrations/sdk)
- MCP for Claude Code / Cursor: [https://docs.aionis.work/integrations/mcp](https://docs.aionis.work/integrations/mcp)
- Memory Firewall: [https://docs.aionis.work/products/memory-firewall](https://docs.aionis.work/products/memory-firewall)
