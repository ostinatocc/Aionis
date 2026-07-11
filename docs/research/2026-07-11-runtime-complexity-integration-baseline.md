# Runtime Complexity Integration Baseline

Recorded: 2026-07-11

## Status

The complexity-reduction and temporary-transport-removal work is integrated on
local Runtime `main`. Runtime is a validated release candidate, but it is not
release-ready until the Docker gate runs and release coordinates are advanced
from the immutable v0.3.3 train.

No remote push, tag, package version bump, npm publish, Docker publish, or
GitHub release was performed during this integration.

## Integrated revisions

| Repository | Local revision | Remote posture at record time |
|---|---|---|
| Runtime | `0d54490` plus the release-smoke alignment in this baseline commit | local `main` was 38 commits ahead of `origin/main` before this commit |
| `@aionis/sdk` | `7b631aa` | local `main` is 3 commits ahead of `origin/main` |

The previous Runtime main-worktree edits are preserved in
`stash@{0}` with message
`pre-merge duplicate runtime complexity work 2026-07-11`. Their contents were
confirmed to match commits already integrated on the branch before the
fast-forward.

## Verification evidence

| Gate | Result |
|---|---|
| Runtime main typecheck | Pass |
| Runtime SDK ownership check | Pass |
| Runtime complexity budget | Pass: 283 modules, 120,748 lines, 19 routes, 177 environment fields, 0 import cycles |
| Runtime public Lite smoke | Pass |
| Full Runtime Lite suite at integrated revision | 63/63 JavaScript checks and 822/822 TypeScript tests passed, 0 skips |
| SDK source ownership and package suite | Pass; 14/14 tests |
| Release metadata and Docker binding contracts | Pass; 7/7 tests |
| Local candidate package entrypoints | Pass with local SDK, MCP, and Create; SDK product loop and MCP stdio loop succeeded |
| Candidate fresh install | Pass from local Runtime `main`; installer, no-key Runtime startup, MCP context, receipt, and workspace scope succeeded |
| Docker image build and container health | Blocked by local Docker Desktop daemon not responding |

The candidate fresh-install smoke now accepts
`AIONIS_FRESH_INSTALL_RUNTIME_REF`. Without an explicit ref, the installer
correctly validates the stable default tag, which is not evidence for an
unreleased Runtime candidate. The smoke also asserts the current SDK default
prompt contract, `AIONIS_EXECUTION_AGENT_CONTEXT v1`; compact Runtime guide
mode does not implicitly select the `runtime_compact` final prompt format.

## Release blockers and decisions

1. Start or repair Docker Desktop, then run the documented image build,
   container health check, and cleanup commands.
2. Choose new immutable release coordinates. The current source cannot be
   published again as v0.3.3. A compatible patch train such as Runtime v0.3.4
   and SDK 0.3.14 is plausible, but requires owner approval before editing
   release metadata.
3. Push Runtime and SDK only after the version decision and Docker gate.
4. Decide whether the clean local release branches in CLI, Create, and Claude
   Code should be merged/pushed as part of the same train. They currently have
   no configured upstream branch.
5. Place the Manifest and eval consumer changes under their intended source
   ownership; those local directories are not Git repositories.
6. After publishing, run the published CLI smoke against the exact new package
   version before announcing the release.

## Recommended release order

1. Complete Docker candidate verification.
2. Approve and apply Runtime/SDK version coordinates and release notes.
3. Re-run release metadata, Runtime smoke, SDK package, and candidate install
   gates.
4. Push SDK first, then Runtime and any dependent package changes in the
   documented dependency order.
5. Run exact-version published-package and CLI smoke tests.
6. Create immutable tags and release artifacts only after all previous gates
   pass.

