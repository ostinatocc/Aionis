#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const AGENT_ID = "http-quickstart-agent";
const PREF_MARKER = "HTTP_QUICKSTART_ACTIVE_PREF";
const ARCHIVE_MARKER = "HTTP_QUICKSTART_ARCHIVE_MEMORY";

class HttpQuickstartError extends Error {
  readonly status: number;
  readonly path: string;
  readonly response: unknown;

  constructor(status: number, requestPath: string, response: unknown) {
    super(`Aionis HTTP quickstart request failed: ${status} ${requestPath}`);
    this.name = "HttpQuickstartError";
    this.status = status;
    this.path = requestPath;
    this.response = response;
  }
}

function apiKey(): string | null {
  return process.env.AIONIS_HTTP_QUICKSTART_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} did not return a memory node id`);
  return id;
}

function headers(): Record<string, string> {
  const key = apiKey();
  return {
    "content-type": "application/json",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function get<T>(baseUrl: string, requestPath: string): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "GET",
    headers: headers(),
  });
  const body = await responseBody(response);
  if (!response.ok) throw new HttpQuickstartError(response.status, requestPath, body);
  return body as T;
}

async function post<T>(baseUrl: string, requestPath: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const payload = await responseBody(response);
  if (!response.ok) throw new HttpQuickstartError(response.status, requestPath, payload);
  return payload as T;
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_use_receipt",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

function agentContext(guide: unknown, label: string): Record<string, unknown> {
  const context = asRecord(asRecord(guide)?.agent_context);
  assertCondition(context?.contract_version === "aionis_agent_context_v1", `${label} missing agent_context v1`);
  return context;
}

async function main() {
  const runId = `http-quickstart-${randomUUID().slice(0, 8)}`;
  const scope = `http-quickstart:${runId}`;
  const session = await openRuntime();
  try {
    await get<Record<string, unknown>>(session.baseUrl, "/health");

    const beforeGuide = await post<Record<string, unknown>>(session.baseUrl, "/v1/guide", {
      tenant_id: "default",
      scope,
      mode: "full_power",
      query_text: `${PREF_MARKER} before HTTP quickstart memory exists`,
      consumer_agent_id: AGENT_ID,
      limit: 6,
      include_packets: true,
    });
    const beforeContext = agentContext(beforeGuide, "before HTTP quickstart guide");
    assertCondition(beforeContext.actionable_history_used === false, "fresh HTTP quickstart guide had actionable history");
    assertPromptBoundary(String(beforeContext.prompt_text ?? ""), "before HTTP quickstart guide");

    const preference = await post<Record<string, unknown>>(session.baseUrl, "/v1/observe", {
      tenant_id: "default",
      scope,
      auto_embed: true,
      input_text: `${PREF_MARKER}: prefer concise product updates with concrete next steps.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      memory: {
        client_id: `http-quickstart-pref:${runId}`,
        type: "self_model",
        memory_kind: "general_memory",
        title: "HTTP quickstart response preference",
        text_summary: `${PREF_MARKER}: prefer concise product updates with concrete next steps.`,
        confidence: 0.92,
        slots: {
          source: "http_quickstart",
          lifecycle_state: "active",
        },
      },
    });
    const preferenceId = firstNodeId(preference, "HTTP preference observe");

    const afterGuide = await post<Record<string, unknown>>(session.baseUrl, "/v1/guide", {
      tenant_id: "default",
      scope,
      mode: "full_power",
      query_text: `${PREF_MARKER} continue the HTTP quickstart product update`,
      consumer_agent_id: AGENT_ID,
      limit: 8,
      include_packets: true,
    });
    const afterContext = agentContext(afterGuide, "after HTTP quickstart guide");
    const promptText = String(afterContext.prompt_text ?? "");
    assertPromptBoundary(promptText, "after HTTP quickstart guide");
    const useNowIds = textArray(afterContext.use_now_memory_ids);
    const useNow = textArray(afterContext.use_now);
    assertCondition(afterContext.actionable_history_used === true, "HTTP guide did not expose actionable memory");
    assertCondition(useNowIds.includes(preferenceId), "HTTP preference was not exposed in use_now memory IDs");
    assertCondition(useNow.some((entry) => entry.includes(PREF_MARKER)), "HTTP preference marker missing from use_now");

    const guideTraceId = asRecord(afterGuide)?.guide_trace_id;
    assertCondition(typeof guideTraceId === "string" && guideTraceId.length > 0, "HTTP guide missing guide_trace_id");

    const feedback = await post<Record<string, unknown>>(session.baseUrl, "/v1/feedback", {
      tenant_id: "default",
      scope,
      reason: "The Agent used the exposed HTTP quickstart preference successfully.",
      run_id: `run:${runId}:feedback`,
      outcome: "positive",
      used_surface: "use_now",
      guide_trace_id: guideTraceId,
      used_memory_ids: [preferenceId],
      verifier_status: "passed",
      tool_status: "succeeded",
    });

    const measure = await post<Record<string, unknown>>(session.baseUrl, "/v1/measure", {
      tenant_id: "default",
      scope,
      task: {
        task_id: `task:${runId}`,
        run_id: runId,
        task_signature: "http-quickstart",
        task_family: "developer_http_quickstart",
      },
      product_trace: {
        before_guide: beforeGuide,
        after_guide: afterGuide,
        forget_result: feedback,
        sufficient_evidence: true,
        evidence_ids: [
          `memory:${preferenceId}`,
          `feedback:${runId}`,
        ],
      },
    });
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const decisionTrace = asRecord(measure.memory_decision_trace);
    const receipt = asRecord(decisionTrace?.memory_use_receipt);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "HTTP measure did not return result v1");
    assertCondition(historyImpact?.impact_direction === "positive", "HTTP measure did not report positive history impact");
    assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "HTTP measure missing memory use receipt");

    const snapshot = await post<Record<string, unknown>>(session.baseUrl, "/v1/operator/snapshot", {
      tenant_id: "default",
      scope,
      run_id: runId,
      task_signature: "http-quickstart",
      task_family: "developer_http_quickstart",
      agent_context: afterContext,
      guide_packet: afterGuide.guide_packet,
      memory_decision_trace: measure.memory_decision_trace,
      memory_decision_audit: measure.memory_decision_audit,
      effect_report: measure.effect_report,
      guide_trace_id: guideTraceId,
      include_markdown: false,
    });
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const snapshotReceipt = asRecord(operatorSnapshot?.memory_use_receipt);
    assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "HTTP snapshot missing operator snapshot v1");
    assertCondition(snapshotReceipt?.contract_version === "aionis_memory_use_receipt_v1", "HTTP snapshot missing receipt");

    const archived = await post<Record<string, unknown>>(session.baseUrl, "/v1/observe", {
      tenant_id: "default",
      scope,
      auto_embed: true,
      input_text: `${ARCHIVE_MARKER}: archived workflow can be restored when the same continuation returns.`,
      memory_lane: "shared",
      memory: {
        client_id: `http-quickstart-archive:${runId}`,
        type: "procedure",
        tier: "archive",
        memory_kind: "execution_workflow",
        title: "HTTP quickstart archived workflow",
        text_summary: `${ARCHIVE_MARKER}: archived workflow can be restored when the same continuation returns.`,
        confidence: 0.83,
        slots: {
          source: "http_quickstart",
          lifecycle_state: "archived",
        },
      },
    });
    const archiveMemoryId = firstNodeId(archived, "HTTP archived workflow observe");
    const rehydrate = await post<Record<string, unknown>>(session.baseUrl, "/v1/rehydrate", {
      tenant_id: "default",
      scope,
      target: "archive",
      memory_ids: [archiveMemoryId],
      target_tier: "hot",
      reason: "The same continuation returned and needs this archived workflow.",
    });
    const rehydrateEffect = asRecord(rehydrate.forget_effect);
    assertCondition(rehydrate.product_action === "rehydrate", "HTTP rehydrate did not return product action");
    assertCondition(rehydrate.operation === "rehydrate", "HTTP rehydrate did not return rehydrate operation");
    assertCondition(rehydrateEffect?.changed_count === 1, "HTTP rehydrate did not move the archived memory");

    const feedbackEffect = asRecord(feedback.forget_effect);
    const guideTrace = asRecord(feedbackEffect?.guide_trace);
    const result = {
      contract_version: "aionis_http_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      integration_path: {
        transport: "raw_http_fetch",
        product_loop: "observe -> guide -> agent action -> feedback -> measure -> snapshot -> rehydrate",
      },
      agent_context: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        prompt_char_count: promptText.length,
        prompt_preview: promptText.slice(0, 800),
        use_now_memory_ids: useNowIds,
      },
      memory_governance: {
        preference_memory_id: preferenceId,
        feedback_attributed_memory_count: guideTrace?.attributed_memory_count ?? null,
        measure_history_impact: historyImpact.impact_direction,
      },
      operator_audit: {
        memory_use_receipt_visible: true,
        receipt_decision_summary_count: recordArray(receipt.decision_summaries).length,
        snapshot_receipt_visible: true,
        snapshot_runtime_mutation: operatorSnapshot.runtime_mutation,
      },
      rehydration: {
        archive_memory_id: archiveMemoryId,
        product_action: rehydrate.product_action,
        operation: rehydrate.operation,
        changed_count: rehydrateEffect?.changed_count ?? null,
      },
      checks: {
        starts_without_actionable_history: beforeContext.actionable_history_used === false,
        guide_exposes_preference: useNowIds.includes(preferenceId),
        agent_prompt_boundary_preserved: true,
        feedback_attributed: guideTrace?.attributed_memory_count === 1,
        positive_history_impact_measured: historyImpact.impact_direction === "positive",
        operator_snapshot_read_only: operatorSnapshot.runtime_mutation === false,
        rehydrate_product_route_used: rehydrate.product_action === "rehydrate"
          && rehydrate.operation === "rehydrate",
        rehydrate_moved_archive: rehydrateEffect?.changed_count === 1,
      },
    };

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    closeRuntime(session);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${formatE2eError(err)}\n`);
    process.exitCode = 1;
  });
}
