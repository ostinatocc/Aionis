# Claude Code Aionis MCP Demo Prompt

Use the MCP server named `aionis` before doing any implementation work.

1. Call `aionis_health`.
2. Call `aionis_record_step` once for a failed route:
   - `run_id`: `claude-code-demo-local`
   - `task_signature`: `claude-code-demo-continuation`
   - `task_family`: `claude_code_mcp_demo`
   - `workflow_signature`: `claude-code-demo-workflow`
   - `agent_id`: `claude-code`
   - `role`: `worker`
   - `title`: `Claude Code broad route failed`
   - `summary`: `The broad legacy route touched src/legacy/checkout.ts and failed verifier checks. Do not continue that route.`
   - `outcome`: `failed`
   - `target_files`: `["src/legacy/checkout.ts"]`
3. Call `aionis_record_step` once for an accepted route:
   - `run_id`: `claude-code-demo-local`
   - `task_signature`: `claude-code-demo-continuation`
   - `task_family`: `claude_code_mcp_demo`
   - `workflow_signature`: `claude-code-demo-workflow`
   - `agent_id`: `claude-code`
   - `role`: `worker`
   - `title`: `Claude Code scoped route accepted`
   - `summary`: `The scoped route in packages/api/src/checkout.ts passed verifier checks. Continue this route.`
   - `outcome`: `succeeded`
   - `target_files`: `["packages/api/src/checkout.ts"]`
4. Call `aionis_context`:
   - `run_id`: `claude-code-demo-local`
   - `task_signature`: `claude-code-demo-continuation`
   - `task_family`: `claude_code_mcp_demo`
   - `workflow_signature`: `claude-code-demo-workflow`
   - `agent_id`: `claude-code`
   - `role`: `reviewer`
   - `query_text`: `Continue the accepted checkout route without repeating the failed legacy route.`
   - `context_mode`: `compact_agent`
   - `budget_profile`: `compact`
   - `repo_state.existing_files`: `["packages/api/src/checkout.ts"]`
   - `repo_state.missing_files`: `["src/legacy/checkout.ts"]`

Do not edit files in this demo. After the tool calls, summarize:

- which memory IDs Aionis says to continue
- which memory IDs Aionis says not to use or inspect first
- whether feedback is optional
- whether the context includes a memory use receipt and admission record
