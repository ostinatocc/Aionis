# Runtime Complexity Integration Baseline

Recorded: 2026-07-11

## Status

The complexity-reduction and temporary-transport-removal work is integrated on
local Runtime `main`. Runtime is a validated v0.3.4 release candidate. The
Docker build and container-health gate now pass; remote publication remains
intentionally pending.

No remote push, tag, npm publish, Docker publish, or GitHub release was
performed during this integration. Candidate package versions were updated
locally only.

## Integrated revisions

| Repository | Local revision | Remote posture at record time |
|---|---|---|
| Runtime | `b0adb47` plus the v0.3.4 candidate preparation commit | local `main` was 39 commits ahead of `origin/main` before candidate preparation |
| `@aionis/sdk` | `7b631aa` plus the 0.3.14 candidate version commit | local `main` was 3 commits ahead of `origin/main` before candidate preparation |
| `@aionis/create` | 0.3.6 candidate on `aionis/release-train-pin` | branch has no configured upstream |
| `@aionis/manifest` | 0.1.1 source candidate | local directory is not a Git repository |

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
| SDK 0.3.14 source ownership, package suite, and pack | Pass; 14/14 tests and dry-run tarball verified |
| Create 0.3.6 package suite and pack | Pass; 27/27 tests and dry-run tarball verified |
| Manifest 0.1.1 package suite and pack | Pass; 9/9 tests and dry-run tarball verified |
| Release metadata and Docker binding contracts | Pass; 7/7 tests |
| Local candidate package entrypoints | Pass with local SDK, MCP, and Create; SDK product loop and MCP stdio loop succeeded |
| Candidate fresh install | Pass from local Runtime `main`; installer, no-key Runtime startup, MCP context, receipt, and workspace scope succeeded |
| Docker image build and container health | Pass after a non-destructive Docker Desktop engine restart; image `aionis:release-smoke` built and `/healthz` passed on a loopback-only port |

The candidate fresh-install smoke now accepts
`AIONIS_FRESH_INSTALL_RUNTIME_REF`. Without an explicit ref, the installer
correctly validates the stable default tag, which is not evidence for an
unreleased Runtime candidate. The smoke also asserts the current SDK default
prompt contract, `AIONIS_EXECUTION_AGENT_CONTEXT v1`; compact Runtime guide
mode does not implicitly select the `runtime_compact` final prompt format.

## Release blockers and decisions

1. Push Runtime, SDK, and Create only after review of the prepared candidate
   commits.
2. Decide whether the clean local release branches in CLI and Claude
   Code should be merged/pushed as part of the same train. They currently have
   no configured upstream branch.
3. Place the Manifest and eval consumer changes under their intended source
   ownership; those local directories are not Git repositories.
4. After publishing, run the published CLI smoke against the exact new package
   version before announcing the release.

## Recommended release order

1. Review and commit the prepared candidate coordinates.
2. Push SDK first, then Create, Runtime, and any dependent package changes in the
   documented dependency order.
3. Run exact-version published-package and CLI smoke tests.
4. Create immutable tags and release artifacts only after all previous gates
   pass.
