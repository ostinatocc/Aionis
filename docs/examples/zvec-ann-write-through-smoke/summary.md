# Zvec ANN Write-Through Smoke

This smoke verifies that Zvec is a candidate sidecar synchronized after SQLite commits, not only at process startup.

- Provider: `zvec`
- Rebuild on start: `false`
- Runtime routes: `/v1/observe`, `/v1/memory/recall`

| Check | Result |
|---|---:|
| weak_write_inline_embedding_updated | pass |
| before_target_uses_ann_without_exact_recovery | pass |
| target_visible_after_running_write_without_restart | pass |
| target_removed_after_embedding_failed_mutation | pass |

Summary JSON: `summary.json`
