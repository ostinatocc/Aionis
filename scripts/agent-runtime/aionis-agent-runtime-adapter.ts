import type { JsonObject } from "../real-llm-eval/report-runtime-effect-rollup.js";

export type AgentRuntimeHost = {
  host_kind: string;
  agent_id: string;
  adapter_id: string;
};

export type AgentRuntimeTask = {
  task_id: string;
  task_family: string | null;
  query_text: string;
  context: JsonObject;
  edit_boundary_context: JsonObject;
  candidates: string[];
  execution_evidence?: JsonObject[];
  execution_result_summary?: JsonObject;
};

export type AgentRuntimeIdentity = {
  tenant_id: string;
  scope: string;
  actor: string;
  consumer_agent_id: string;
  producer_agent_id: string;
  owner_agent_id: string;
  memory_lane: "private" | "shared";
  run_id: string;
};

export type AionisAgentRuntimeContextPacket = JsonObject & {
  context_version: "aionis_agent_runtime_context_packet_v1";
  role: "advisory_runtime_evidence_not_agent_execution";
  adapter: AgentRuntimeHost;
  runtime_routes: {
    experience_intelligence: string;
    planning_context: string;
    context_assemble: string;
    tools_select: string;
  };
  experience_intelligence: JsonObject;
  planning: JsonObject;
  assembly: JsonObject;
  tools: JsonObject;
};

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 32))}\n...[truncated ${text.length - limit} chars]`;
}

async function postRuntime(baseUrl: string, route: string, payload: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as JsonObject : {};
  if (!response.ok) {
    throw new Error(`Runtime ${route} failed: ${response.status} ${truncate(JSON.stringify(parsed), 2000)}`);
  }
  return parsed;
}

function runtimeCommonPayload(args: {
  identity: AgentRuntimeIdentity;
  task: AgentRuntimeTask;
  contextCharBudget: number;
}): JsonObject {
  return {
    ...args.identity,
    query_text: args.task.query_text,
    context: {
      ...args.task.context,
      task_id: args.task.task_id,
      task_family: args.task.task_family,
    },
    execution_evidence: args.task.execution_evidence ?? [],
    execution_result_summary: args.task.execution_result_summary ?? {},
    edit_boundary_context: args.task.edit_boundary_context,
    candidates: args.task.candidates,
    tool_candidates: args.task.candidates,
    include_shadow: true,
    return_debug: true,
    include_slots: true,
    context_char_budget: args.contextCharBudget,
    context_optimization_profile: "aggressive",
  };
}

export async function buildAionisAgentRuntimeContext(args: {
  baseUrl: string;
  identity: AgentRuntimeIdentity;
  host: AgentRuntimeHost;
  task: AgentRuntimeTask;
  contextCharBudget?: number;
}): Promise<AionisAgentRuntimeContextPacket> {
  const common = runtimeCommonPayload({
    identity: args.identity,
    task: args.task,
    contextCharBudget: args.contextCharBudget ?? 16000,
  });
  const [experienceIntelligence, planning, assembly, tools] = await Promise.all([
    postRuntime(args.baseUrl, "/v1/memory/experience/intelligence", common),
    postRuntime(args.baseUrl, "/v1/memory/planning/context", common),
    postRuntime(args.baseUrl, "/v1/memory/context/assemble", common),
    postRuntime(args.baseUrl, "/v1/memory/tools/select", {
      ...args.identity,
      context: common.context,
      candidates: args.task.candidates,
      include_shadow: true,
    }),
  ]);

  return {
    context_version: "aionis_agent_runtime_context_packet_v1",
    role: "advisory_runtime_evidence_not_agent_execution",
    adapter: args.host,
    runtime_routes: {
      experience_intelligence: "/v1/memory/experience/intelligence",
      planning_context: "/v1/memory/planning/context",
      context_assemble: "/v1/memory/context/assemble",
      tools_select: "/v1/memory/tools/select",
    },
    experience_intelligence: experienceIntelligence,
    planning,
    assembly,
    tools,
  };
}
