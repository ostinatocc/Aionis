import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { z } from "zod/v3";
import { handleAionisMcpTool, type AionisMcpClient, type AionisMcpToolName } from "./tools.js";

function packageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const role = z.enum(["agent", "planner", "worker", "verifier", "reviewer"]).optional();
const outcome = z.enum(["succeeded", "failed", "blocked", "interrupted", "unknown"]).optional();
const guideMode = z.enum(["standard", "full_power"]).optional();
const guideContextMode = z.enum(["standard", "full_power", "compact_agent"]).optional();
const externalAdmissionMode = z.enum(["standard", "strict", "firewall"]).optional();
const externalAdmissionContextMode = z.enum(["standard", "compact_agent"]).optional();
const memoryLane = z.enum(["private", "shared"]).optional();
const stringArray = z.array(z.string()).optional();
const jsonObject = z.record(z.unknown()).optional();
const guideValue = z.unknown().optional();
const repoState = z.object({
  existing_files: stringArray,
  missing_files: stringArray,
  files: z.array(z.object({
    target: z.string(),
    exists: z.boolean(),
    reason: z.string().optional(),
  })).optional(),
}).optional();

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
};

const runShape = {
  run_id: z.string().describe("Stable run/session id."),
  task_id: z.string().optional(),
  task_signature: z.string().describe("Stable task or workflow signature."),
  task_family: z.string().optional(),
  workflow_signature: z.string().optional(),
  agent_id: z.string().optional(),
  team_id: z.string().optional(),
  role,
  tenant_id: z.string().optional(),
  scope: z.string().optional(),
};

const stepShape = {
  ...runShape,
  memory_lane: memoryLane,
  title: z.string(),
  summary: z.string(),
  outcome,
  target_files: stringArray,
  workflow_steps: stringArray,
  tool_set: stringArray,
  acceptance_checks: stringArray,
  continuation_hint: z.string().optional(),
  resume_hint: z.string().optional(),
  reuse_hint: z.string().optional(),
  confidence: z.number().optional(),
  raw_ref: z.string().optional(),
  evidence_ref: z.string().optional(),
};

function register(
  server: McpServer,
  client: AionisMcpClient,
  name: AionisMcpToolName,
  config: ToolConfig,
): void {
  server.registerTool(name, config, async (args) => handleAionisMcpTool(client, name, args));
}

export function createAionisMcpServer(client: AionisMcpClient): McpServer {
  const server = new McpServer({
    name: "aionis-mcp",
    version: packageVersion(),
  });

  register(server, client, "aionis_context", {
    title: "Get Aionis Agent Context",
    description: "Compile governed Aionis execution memory for the current agent turn. Feedback is optional.",
    inputSchema: {
      ...runShape,
      query_text: z.string(),
      memory_lane: memoryLane,
      title: z.string().optional().describe("Optional current observation title to record before guidance."),
      summary: z.string().optional().describe("Optional current observation summary to record before guidance."),
      outcome,
      target_files: stringArray,
      tool_candidates: stringArray,
      context: jsonObject,
      guide: jsonObject,
      limit: z.number().int().positive().optional(),
      mode: guideMode,
      context_mode: guideContextMode,
      context_char_budget: z.number().int().positive().optional(),
      context_token_budget: z.number().int().positive().optional(),
      context_compaction_profile: z.enum(["balanced", "aggressive"]).optional(),
      context_optimization_profile: z.enum(["balanced", "aggressive"]).optional(),
      repo_state: repoState.describe("Optional host-observed file presence for execution-context warnings."),
      budget_profile: z.enum(["compact", "balanced", "high_recall"]).optional(),
      max_prompt_chars: z.number().int().positive().optional(),
      include_base_prompt: z.boolean().optional(),
      additional_instructions: stringArray,
    },
  });

  register(server, client, "aionis_record_step", {
    title: "Record Aionis Execution Step",
    description: "Record a planner/worker/verifier/reviewer execution step and optionally attribute feedback.",
    inputSchema: {
      ...stepShape,
      guide: guideValue,
      guide_trace_id: z.string().optional(),
      used_memory_ids: stringArray,
      feedback: z.boolean().optional(),
      feedback_outcome: z.enum(["positive", "negative", "neutral"]).optional(),
      used_surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"]).optional(),
      tool_status: z.enum(["succeeded", "failed", "not_run", "unknown"]).optional(),
      feedback_reason: z.string().optional(),
    },
  });

  register(server, client, "aionis_handoff", {
    title: "Record Aionis Handoff",
    description: "Record a branch-aware multi-agent handoff for cross-session continuation.",
    inputSchema: {
      ...stepShape,
      handoff_kind: z.enum(["patch_handoff", "review_handoff", "task_handoff"]).optional(),
      anchor: z.string().optional(),
      handoff_text: z.string().optional(),
      risk: z.string().optional(),
      tags: stringArray,
      next_action: z.string().optional(),
      must_change: stringArray,
      must_remove: stringArray,
      must_keep: stringArray,
    },
  });

  register(server, client, "aionis_remember", {
    title: "Remember In Aionis",
    description: "Store ordinary project memory through the Aionis governed observe path.",
    inputSchema: {
      text: z.string(),
      kind: z.enum(["fact", "preference", "project_context", "procedure", "event", "evidence"]).optional(),
      title: z.string().optional(),
      client_id: z.string().optional(),
      memory_lane: memoryLane,
      producer_agent_id: z.string().optional(),
      owner_agent_id: z.string().optional(),
      owner_team_id: z.string().optional(),
      lifecycle_state: z.enum(["active", "candidate", "contested", "suppressed", "demoted", "archived"]).optional(),
      tier: z.enum(["hot", "warm", "cold", "archive"]).optional(),
      confidence: z.number().optional(),
      salience: z.number().optional(),
      importance: z.number().optional(),
      auto_embed: z.boolean().optional(),
      raw_ref: z.string().optional(),
      evidence_ref: z.string().optional(),
      target_files: stringArray,
      slots: jsonObject,
      tenant_id: z.string().optional(),
      scope: z.string().optional(),
    },
  });

  register(server, client, "aionis_govern_memory", {
    title: "Govern External Memory",
    description: "Route Mem0, Zep, vector DB, markdown, or other external memory candidates through Aionis admission surfaces before prompt use.",
    inputSchema: {
      query_text: z.string(),
      run_id: z.string().optional(),
      tenant_id: z.string().optional(),
      scope: z.string().optional(),
      mode: externalAdmissionMode,
      context_mode: externalAdmissionContextMode,
      include_records: z.boolean().optional(),
      candidates: z.array(z.object({
        external_memory_id: z.string(),
        source_backend: z.string(),
        text: z.string(),
        metadata: z.record(z.unknown()).optional(),
        authority: z.object({
          source_trust: z.enum(["trusted", "known", "untrusted", "unknown"]).optional(),
          scope: z.enum(["user", "project", "team", "org", "global", "unknown"]).optional(),
          evidence_requirement: z.enum(["none", "inspect_before_use", "rehydrate_before_use", "blocked"]).optional(),
        }).optional(),
        lifecycle_hint: z.enum(["current", "procedure", "failed", "stale", "contested", "suppressed", "archived", "unknown"]).optional(),
        evidence_refs: z.array(z.string()).optional(),
      })),
    },
  });

  register(server, client, "aionis_measure", {
    title: "Measure Aionis Run",
    description: "Measure guide and feedback impact for a run.",
    inputSchema: {
      run_id: z.string(),
      task_signature: z.string(),
      task_id: z.string().optional(),
      task_family: z.string().optional(),
      workflow_signature: z.string().optional(),
      tenant_id: z.string().optional(),
      scope: z.string().optional(),
      before_guide: guideValue,
      after_guide: z.unknown(),
      feedback_result: guideValue,
      sufficient_evidence: z.boolean().optional(),
      evidence_ids: stringArray,
      product_trace: jsonObject,
    },
  });

  register(server, client, "aionis_snapshot", {
    title: "Get Aionis Operator Snapshot",
    description: "Return an auditable operator snapshot. If guide and measure_result are supplied, uses the run snapshot helper.",
    inputSchema: {
      run_id: z.string(),
      task_signature: z.string().optional(),
      task_id: z.string().optional(),
      task_family: z.string().optional(),
      workflow_signature: z.string().optional(),
      tenant_id: z.string().optional(),
      scope: z.string().optional(),
      guide: guideValue,
      measure_result: guideValue,
      include_markdown: z.boolean().optional(),
      extra: jsonObject,
    },
  });

  register(server, client, "aionis_flight_recorder", {
    title: "Replay Aionis Agent Decision",
    description: "Return a read-only Agent Flight Recorder report showing what memory the Agent could see at decision time.",
    inputSchema: {
      tenant_id: z.string().optional(),
      scope: z.string().optional(),
      guide_trace_id: z.string().optional(),
      run_id: z.string().optional(),
      product_trace: jsonObject,
      agent_context: jsonObject,
      memory_decision_trace: jsonObject,
      memory_use_receipt: jsonObject,
      memory_admission_record: jsonObject,
      operator_snapshot: jsonObject,
      feedback_result: jsonObject,
      decision_time: z.string().optional(),
    },
  });

  register(server, client, "aionis_health", {
    title: "Check Aionis Runtime Health",
    description: "Check whether the configured Aionis Runtime is reachable.",
    inputSchema: {},
  });

  return server;
}
