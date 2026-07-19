# Aionis Learning Authority

This internal extension owns filesystem-bound external-evidence verification,
fixed-experiment provisioning and gate mutation, protected SQLite writer
capabilities, durable receipt publication, and operator commands. The focused
Runtime daemon does not import this package; authority flows depend inward on
the Runtime's generic evidence, validation, and database contracts.

The package is typechecked with `tsconfig.tools.json` and has an independent
complexity budget. Keeping it outside `src/` prevents deployment authority and
fixed evidence-ingestion machinery from silently re-entering the daemon.
