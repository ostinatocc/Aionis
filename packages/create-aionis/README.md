# @aionis/create

One-command installer for Aionis Runtime, SDK, and MCP bridge.

Run:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart sdk
```

Install without running a quickstart:

```bash
npx @aionis/create@latest my-aionis --provider minimax --skip-quickstart
```

The installer clones the Runtime repo, installs dependencies and workspace
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart. The installed repo includes `@aionis/sdk` for application
integration and `@aionis/mcp` for Claude Code / Cursor style MCP clients.

Runtime startup needs the selected embedding provider key. If you install
without a key or skip the quickstart, set `MINIMAX_API_KEY` in the generated
`.env` before running `npm run -s lite:start`.

Common first runs:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart multi-agent
```
