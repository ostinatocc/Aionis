# @aionis/create

One-command installer for Aionis Runtime, SDK, and MCP bridge.

Run:

```bash
npx @aionis/create@latest --provider minimax --quickstart sdk
```

With a key:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart sdk
```

The installer clones the Runtime repo, installs dependencies and workspace
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart. The installed repo includes `@aionis/sdk` for application
integration and `@aionis/mcp` for Claude Code / Cursor style MCP clients.

Common first runs:

```bash
npx @aionis/create@latest my-aionis --provider minimax --skip-quickstart
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart multi-agent
```
