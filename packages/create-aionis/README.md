# @aionis/create

One-command installer for Aionis Runtime and SDK.

After this package is published, users can run:

```bash
npx @aionis/create --provider minimax --quickstart sdk
```

With a key:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create --provider minimax --quickstart sdk
```

The installer clones the Runtime repo, installs dependencies and workspace SDK
packages, writes `.env`, builds the publishable packages, then optionally runs a
quickstart.
