# @aionis/create

One-command installer for Aionis Runtime and SDK.

Run:

```bash
npx @aionis/create@latest --provider minimax --quickstart sdk
```

With a key:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart sdk
```

The installer clones the Runtime repo, installs dependencies and workspace SDK
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart.

Common first runs:

```bash
npx @aionis/create@latest my-aionis --provider minimax --skip-quickstart
MINIMAX_API_KEY="your-key" npx @aionis/create@latest --provider minimax --quickstart multi-agent
```
