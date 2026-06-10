#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAionisClient } from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
  postRuntimeJson,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const CONSUMER_AGENT_ID = "local-user";
const ACTIVE_PREF_MARKER = "ORDINARY_MEMORY_E2E_ACTIVE_PREF";
const OLD_FACT_MARKER = "ORDINARY_MEMORY_E2E_OLD_FACT";
const CURRENT_FACT_MARKER = "ORDINARY_MEMORY_E2E_CURRENT_FACT";
const PROJECT_NOTE_MARKER = "ORDINARY_MEMORY_E2E_PROJECT_NOTE";
const CANDIDATE_MARKER = "ORDINARY_MEMORY_E2E_CANDIDATE";
const SUPPRESSED_MARKER = "ORDINARY_MEMORY_E2E_SUPPRESSED";
const HIDDEN_PRIVATE_MARKER = "ORDINARY_MEMORY_E2E_HIDDEN_PRIVATE";

type AionisClient = ReturnType<typeof createAionisClient>;

type OrdinaryMemorySeed = {
  clientId: string;
  type: "concept" | "rule" | "procedure" | "evidence";
  title: string;
  text: string;
  confidence: number;
  lifecycleState?: "active" | "candidate" | "contested" | "suppressed" | "demoted" | "archived";
  memoryLane?: "private" | "shared";
  ownerAgentId?: string;
  ownerTeamId?: string;
  slots?: Record<string, unknown>;
};

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
}

function apiKey(): string | null {
  return process.env.AIONIS_ORDINARY_MEMORY_E2E_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function agentContext(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  assertCondition(record?.contract_version === "aionis_agent_context_v1", `${label} did not return agent_context v1`);
  assertCondition(typeof record.prompt_text === "string" && record.prompt_text.length > 0, `${label} missing prompt_text`);
  return record;
}

function assertPromptBoundary(promptText: string, label: string): void {
  for (const forbidden of [
    "memory_decision_trace",
    "memory_decision_audit",
    "memory_use_receipt",
    "decision_summaries",
    "decision_reviews",
    "raw_memory_rows",
    "raw_slots",
  ]) {
    assertCondition(!promptText.includes(forbidden), `${label} prompt leaked ${forbidden}`);
  }
}

function firstNodeId(observeBody: Record<string, unknown>, label: string): string {
  const write = asRecord(observeBody.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  assertCondition(typeof id === "string" && id.length > 0, `${label} observe did not return node id`);
  return id;
}

function assertNoExecutionTreeProjection(observeBody: Record<string, unknown>, label: string): void {
  const tree = observeBody.execution_tree_v1;
  const operations = observeBody.execution_tree_operations_v1;
  assertCondition(tree === undefined || tree === null, `${label} ordinary memory unexpectedly returned execution_tree_v1`);
  assertCondition(
    !Array.isArray(operations) || operations.length === 0,
    `${label} ordinary memory unexpectedly returned execution_tree_operations_v1`,
  );
}

function memoryDecision(trace: Record<string, unknown>, memoryId: string): Record<string, unknown> {
  const decisions = recordArray(trace.memory_decisions);
  const decision = decisions.find((entry) => entry.memory_id === memoryId);
  assertCondition(decision, `missing decision for memory ${memoryId}`);
  return decision;
}

function receiptDecision(receipt: Record<string, unknown>, memoryId: string): Record<string, unknown> {
  const decisions = recordArray(receipt.decision_summaries);
  const decision = decisions.find((entry) => entry.memory_id === memoryId);
  assertCondition(decision, `missing receipt decision for memory ${memoryId}`);
  return decision;
}

async function observeOrdinaryMemory(
  client: AionisClient,
  args: { runId: string },
  seed: OrdinaryMemorySeed,
): Promise<string> {
  const lifecycleState = seed.lifecycleState ?? "active";
  const observeBody = await client.observe<Record<string, unknown>>({
    auto_embed: true,
    input_text: seed.text,
    memory_kind: "general_memory",
    memory_lane: seed.memoryLane,
    owner_agent_id: seed.ownerAgentId,
    owner_team_id: seed.ownerTeamId,
    memory: {
      client_id: `${seed.clientId}:${args.runId}`,
      type: seed.type,
      memory_kind: "general_memory",
      title: seed.title,
      text_summary: seed.text,
      confidence: seed.confidence,
      slots: {
        memory_kind: "general_memory",
        lifecycle_state: lifecycleState,
        state: lifecycleState,
        compression_layer: "L2",
        ...(seed.slots ?? {}),
      },
    },
  });
  assertNoExecutionTreeProjection(observeBody, seed.title);
  return firstNodeId(observeBody, seed.title);
}

async function runOrdinaryMemoryLoop(args: {
  baseUrl: string;
  apiKey: string | null;
  runId: string;
  scope: string;
}) {
  const client = createAionisClient({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? undefined,
    tenant_id: "default",
    scope: args.scope,
  });
  await client.health();

  const queryText = `${ACTIVE_PREF_MARKER} ${OLD_FACT_MARKER} how should the Agent continue ordinary memory work?`;
  const beforeGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: queryText,
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 8,
    include_packets: true,
  });
  const beforeContext = agentContext(beforeGuide.agent_context, "before ordinary guide");
  assertPromptBoundary(String(beforeContext.prompt_text), "before ordinary guide");

  const activePreferenceId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-active-pref",
    type: "rule",
    title: "Ordinary memory response preference",
    text: `${ACTIVE_PREF_MARKER}: prefer concise product-facing status with direct next steps and cite memory evidence when available.`,
    confidence: 0.91,
  });

  const preferenceGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: `${ACTIVE_PREF_MARKER} concise product-facing status direct next steps`,
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 8,
    include_packets: true,
  });
  const preferenceContext = agentContext(preferenceGuide.agent_context, "ordinary preference guide");
  const preferenceUseNow = textArray(preferenceContext.use_now);
  const preferenceUseNowIds = textArray(preferenceContext.use_now_memory_ids);
  const preferenceDiagnostic = JSON.stringify({
    history_used: preferenceContext.history_used,
    actionable_history_used: preferenceContext.actionable_history_used,
    use_now_memory_ids: preferenceUseNowIds,
    use_now: preferenceUseNow,
  });
  assertPromptBoundary(String(preferenceContext.prompt_text), "ordinary preference guide");
  assertCondition(preferenceContext.history_used === true, "preference guide did not use history");
  assertCondition(
    preferenceContext.actionable_history_used === true,
    `preference guide did not expose actionable ordinary memory: ${preferenceDiagnostic}`,
  );
  assertCondition(
    preferenceUseNowIds.includes(activePreferenceId),
    `active ordinary preference was not in preference use_now: ${preferenceDiagnostic}`,
  );
  assertCondition(
    preferenceUseNow.some((entry) => entry.includes(ACTIVE_PREF_MARKER)),
    "active preference marker missing from preference use_now",
  );

  const preferenceTraceResult = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/debug/memory-decision-trace",
    apiKey: args.apiKey,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      product_trace: {
        before_guide: beforeGuide,
        after_guide: preferenceGuide,
      },
    },
  });
  const preferenceTrace = asRecord(preferenceTraceResult.memory_decision_trace);
  assertCondition(preferenceTrace?.contract_version === "aionis_memory_decision_trace_v1", "preference trace missing decision trace");
  const preferenceReceipt = asRecord(preferenceTrace.memory_use_receipt);
  assertCondition(preferenceReceipt?.contract_version === "aionis_memory_use_receipt_v1", "preference trace missing receipt");
  const activeDecision = memoryDecision(preferenceTrace, activePreferenceId);
  const activeReceipt = receiptDecision(preferenceReceipt, activePreferenceId);
  assertCondition(activeDecision.agent_surface === "use_now", "active preference decision was not use_now");
  assertCondition(activeReceipt.actionable === true, "active preference receipt was not actionable");

  const oldFactId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-old-fact",
    type: "concept",
    title: "Old ordinary project fact",
    text: `${OLD_FACT_MARKER}: earlier note said the ordinary-memory integration target was legacy/memory/old-context.ts before later evidence was reviewed.`,
    confidence: 0.88,
  });

  const currentFactId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-current-fact",
    type: "concept",
    title: "Current ordinary project fact",
    text: `${CURRENT_FACT_MARKER}: later corrected project memory contradicts the earlier ordinary-memory target; current target is src/memory/product-output-assembler.ts and docs/AIONIS_PRODUCT_OUTPUT_CONTRACT.md.`,
    confidence: 0.94,
  });

  const correctionGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: `${OLD_FACT_MARKER} ordinary-memory integration target`,
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 8,
    include_packets: true,
  });
  const afterContext = agentContext(correctionGuide.agent_context, "ordinary correction guide");
  const afterPrompt = String(afterContext.prompt_text);
  assertPromptBoundary(afterPrompt, "ordinary correction guide");

  const useNow = textArray(afterContext.use_now);
  const inspectBeforeUse = textArray(afterContext.inspect_before_use);
  const doNotUse = textArray(afterContext.do_not_use);
  const useNowIds = textArray(afterContext.use_now_memory_ids);
  const inspectIds = textArray(afterContext.inspect_before_use_memory_ids);
  const surfaceDiagnostic = JSON.stringify({
    history_used: afterContext.history_used,
    actionable_history_used: afterContext.actionable_history_used,
    use_now_memory_ids: useNowIds,
    inspect_before_use_memory_ids: inspectIds,
    use_now: useNow,
    inspect_before_use: inspectBeforeUse,
  });
  assertCondition(afterContext.history_used === true, "ordinary guide did not use history");
  assertCondition(
    afterContext.actionable_history_used === true,
    `correction guide did not expose actionable ordinary memory: ${surfaceDiagnostic}`,
  );
  assertCondition(
    useNowIds.includes(currentFactId),
    `current ordinary fact was not in use_now: ${surfaceDiagnostic}`,
  );
  assertCondition(
    inspectIds.includes(oldFactId),
    `old ordinary fact was not downgraded to inspect_before_use: ${surfaceDiagnostic}`,
  );
  assertCondition(useNow.some((entry) => entry.includes(CURRENT_FACT_MARKER)), "current fact marker missing from use_now");
  assertCondition(!useNow.some((entry) => entry.includes(OLD_FACT_MARKER)), "old fact leaked into use_now");
  assertCondition(
    inspectBeforeUse.some((entry) => entry.includes(oldFactId) || entry.includes("Old ordinary project fact")),
    "old fact was not visible as inspect-first evidence",
  );
  assertCondition(afterPrompt.includes(CURRENT_FACT_MARKER), "agent prompt missing current ordinary fact");
  assertCondition(!afterPrompt.includes("legacy/memory/old-context.ts"), "agent prompt leaked stale old target path");

  const debugTrace = await postRuntimeJson({
    baseUrl: args.baseUrl,
    pathName: "/v1/debug/memory-decision-trace",
    apiKey: args.apiKey,
    payload: {
      tenant_id: "default",
      scope: args.scope,
      product_trace: {
        before_guide: beforeGuide,
        after_guide: correctionGuide,
      },
    },
  });
  const trace = asRecord(debugTrace.memory_decision_trace);
  assertCondition(trace?.contract_version === "aionis_memory_decision_trace_v1", "debug trace missing decision trace");
  assertCondition(trace.agent_prompt_included === false, "decision trace must not be agent prompt content");
  assertCondition(trace.runtime_mutation === false, "decision trace must be read-only");
  const receipt = asRecord(trace.memory_use_receipt);
  assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "trace missing memory use receipt");
  assertCondition(receipt.agent_prompt_included === false, "memory use receipt must not be prompt content");
  assertCondition(receipt.runtime_mutation === false, "memory use receipt must be read-only");

  const oldDecision = memoryDecision(trace, oldFactId);
  const currentDecision = memoryDecision(trace, currentFactId);
  assertCondition(currentDecision.agent_surface === "use_now", "current fact decision was not use_now");
  assertCondition(oldDecision.agent_surface === "inspect_before_use", "old fact decision was not inspect_before_use");
  assertCondition(oldDecision.decision_kind === "downgraded", "old fact decision was not downgraded");
  assertCondition(
    textArray(oldDecision.reason_codes).includes("premise_firewall_query_risk")
      || textArray(oldDecision.reason_codes).includes("lifecycle_relation_evidence"),
    "old fact decision did not explain stale/contradiction risk",
  );

  const oldReceipt = receiptDecision(receipt, oldFactId);
  const currentReceipt = receiptDecision(receipt, currentFactId);
  assertCondition(currentReceipt.actionable === true, "current fact receipt was not actionable");
  assertCondition(oldReceipt.actionable === false, "old fact receipt should not be actionable");
  assertCondition(oldReceipt.agent_surface === "inspect_before_use", "old fact receipt did not preserve inspect surface");

  const projectNoteId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-project-note",
    type: "concept",
    title: "Ordinary memory project note",
    text: `${PROJECT_NOTE_MARKER}: ordinary memory product docs live in docs/AIONIS_PRODUCT_API_USAGE.md and should stay product-facing.`,
    confidence: 0.9,
  });
  const candidateNoteId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-candidate-note",
    type: "concept",
    title: "Candidate ordinary note",
    text: `${CANDIDATE_MARKER}: candidate note says run a broad migration before touching product docs; inspect before direct use.`,
    confidence: 0.56,
    lifecycleState: "candidate",
  });
  const suppressedNoteId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-suppressed-note",
    type: "concept",
    title: "Suppressed ordinary note",
    text: `${SUPPRESSED_MARKER}: suppressed note says ordinary memory should bypass receipt and write raw trace into prompt.`,
    confidence: 0.84,
    lifecycleState: "suppressed",
  });
  const hiddenPrivateId = await observeOrdinaryMemory(client, args, {
    clientId: "ordinary-memory-hidden-private",
    type: "concept",
    title: "Hidden private ordinary note",
    text: `${HIDDEN_PRIVATE_MARKER}: private note visible only to other-agent and never to local-user.`,
    confidence: 0.89,
    memoryLane: "private",
    ownerAgentId: "other-agent",
  });

  const holdoutGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: [
      PROJECT_NOTE_MARKER,
      CANDIDATE_MARKER,
      SUPPRESSED_MARKER,
      "ordinary memory product holdout",
    ].join(" "),
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 12,
    include_packets: true,
  });
  const holdoutContext = agentContext(holdoutGuide.agent_context, "ordinary holdout guide");
  const holdoutPrompt = String(holdoutContext.prompt_text);
  const holdoutUseNow = textArray(holdoutContext.use_now);
  const holdoutInspect = textArray(holdoutContext.inspect_before_use);
  const holdoutDoNotUse = textArray(holdoutContext.do_not_use);
  const holdoutUseNowIds = textArray(holdoutContext.use_now_memory_ids);
  const holdoutInspectIds = textArray(holdoutContext.inspect_before_use_memory_ids);
  const holdoutDoNotUseIds = textArray(holdoutContext.do_not_use_memory_ids);
  const holdoutDiagnostic = JSON.stringify({
    use_now_memory_ids: holdoutUseNowIds,
    inspect_before_use_memory_ids: holdoutInspectIds,
    do_not_use_memory_ids: holdoutDoNotUseIds,
    use_now: holdoutUseNow,
    inspect_before_use: holdoutInspect,
    do_not_use: holdoutDoNotUse,
  });
  assertPromptBoundary(holdoutPrompt, "ordinary holdout guide");
  assertCondition(holdoutContext.history_used === true, "ordinary holdout guide did not use history");
  assertCondition(
    holdoutUseNowIds.includes(projectNoteId),
    `active ordinary project note was not in use_now: ${holdoutDiagnostic}`,
  );
  assertCondition(
    holdoutUseNow.some((entry) => entry.includes(PROJECT_NOTE_MARKER)),
    "active ordinary project marker missing from use_now",
  );
  assertCondition(
    holdoutInspectIds.includes(candidateNoteId),
    `candidate ordinary memory was not inspect-first: ${holdoutDiagnostic}`,
  );
  assertCondition(
    !holdoutUseNowIds.includes(candidateNoteId) && !holdoutUseNow.some((entry) => entry.includes(CANDIDATE_MARKER)),
    "candidate ordinary memory leaked into use_now",
  );
  assertCondition(
    holdoutDoNotUseIds.includes(suppressedNoteId),
    `suppressed ordinary memory was not do_not_use: ${holdoutDiagnostic}`,
  );
  assertCondition(
    !holdoutUseNowIds.includes(suppressedNoteId) && !holdoutUseNow.some((entry) => entry.includes(SUPPRESSED_MARKER)),
    "suppressed ordinary memory leaked into use_now",
  );

  const hiddenOwnerGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: `${HIDDEN_PRIVATE_MARKER} ordinary memory private visibility`,
    consumer_agent_id: "other-agent",
    limit: 8,
    include_packets: true,
  });
  const hiddenOwnerContext = agentContext(hiddenOwnerGuide.agent_context, "hidden private owner guide");
  assertPromptBoundary(String(hiddenOwnerContext.prompt_text), "hidden private owner guide");
  assertCondition(
    textArray(hiddenOwnerContext.memory_ids).includes(hiddenPrivateId),
    "owner agent could not recover its private ordinary memory",
  );

  const hiddenLocalGuide = await client.guide<Record<string, unknown>>({
    mode: "standard",
    query_text: `${HIDDEN_PRIVATE_MARKER} ${PROJECT_NOTE_MARKER} ordinary memory private visibility`,
    consumer_agent_id: CONSUMER_AGENT_ID,
    limit: 12,
    include_packets: true,
  });
  const hiddenLocalContext = agentContext(hiddenLocalGuide.agent_context, "hidden private local guide");
  const hiddenLocalPrompt = String(hiddenLocalContext.prompt_text);
  const hiddenLocalSurfaces = [
    ...textArray(hiddenLocalContext.use_now),
    ...textArray(hiddenLocalContext.inspect_before_use),
    ...textArray(hiddenLocalContext.do_not_use),
  ];
  assertPromptBoundary(hiddenLocalPrompt, "hidden private local guide");
  assertCondition(
    textArray(hiddenLocalContext.memory_ids).includes(projectNoteId),
    "local user did not recover visible project note during private visibility check",
  );
  assertCondition(
    !textArray(hiddenLocalContext.memory_ids).includes(hiddenPrivateId),
    "local user recovered another agent's private ordinary memory",
  );
  assertCondition(!hiddenLocalPrompt.includes(HIDDEN_PRIVATE_MARKER), "local prompt leaked hidden private marker");
  assertCondition(
    !hiddenLocalSurfaces.some((entry) => entry.includes(HIDDEN_PRIVATE_MARKER)),
    "local surfaces leaked hidden private marker",
  );

  const feedback = await client.feedback<Record<string, unknown>>({
    reason: "Agent used the current corrected ordinary fact exposed by the correction guide.",
    run_id: `run:${args.runId}:ordinary-memory-feedback`,
    outcome: "positive",
    used_surface: "use_now",
    guide_trace_id: String(correctionGuide.guide_trace_id ?? ""),
    used_memory_ids: [currentFactId],
  });
  const feedbackEffect = asRecord(feedback.forget_effect);
  assertCondition(feedback.operation === "activate", "feedback did not map to activate");
  assertCondition(feedbackEffect !== null, "feedback did not return forget_effect");

  const measure = await client.measure<Record<string, unknown>>({
    task: {
      task_id: `task:${args.runId}:ordinary-memory`,
      run_id: `run:${args.runId}:ordinary-memory`,
      task_signature: `ordinary-memory:${args.runId}`,
      task_family: "ordinary_memory_product_loop",
    },
    product_trace: {
      before_guide: beforeGuide,
      after_guide: correctionGuide,
      forget_result: feedback,
      sufficient_evidence: true,
      evidence_ids: [
        `product_trace:ordinary-memory:${args.runId}`,
        `memory:${currentFactId}`,
      ],
    },
  });
  const measureTrace = asRecord(measure.memory_decision_trace);
  const measureReceipt = asRecord(measureTrace?.memory_use_receipt);
  assertCondition(measure.contract_version === "aionis_measure_result_v1", "measure did not return result v1");
  assertCondition(measureTrace?.contract_version === "aionis_memory_decision_trace_v1", "measure missing memory decision trace");
  assertCondition(measureReceipt?.contract_version === "aionis_memory_use_receipt_v1", "measure missing memory use receipt");
  assertCondition(
    recordArray(measureReceipt.decision_summaries).some((entry) => entry.memory_id === oldFactId && entry.agent_surface === "inspect_before_use"),
    "measure receipt did not preserve old fact inspect decision",
  );

  const operatorSnapshot = await client.operatorSnapshot<Record<string, unknown>>({
    run_id: `run:${args.runId}:ordinary-memory`,
    task_signature: `ordinary-memory:${args.runId}`,
    task_family: "ordinary_memory_product_loop",
    agent_context: afterContext,
    guide_packet: correctionGuide.guide_packet,
    memory_decision_trace: measure.memory_decision_trace,
    memory_decision_audit: measure.memory_decision_audit,
    effect_report: measure.effect_report,
    guide_trace_id: correctionGuide.guide_trace_id,
    include_markdown: true,
  });
  const snapshot = asRecord(operatorSnapshot.operator_snapshot);
  const snapshotReceipt = asRecord(snapshot?.memory_use_receipt);
  assertCondition(snapshot?.contract_version === "aionis_operator_snapshot_v1", "operator snapshot missing snapshot v1");
  assertCondition(snapshotReceipt?.contract_version === "aionis_memory_use_receipt_v1", "operator snapshot missing receipt");

  return {
    before_history_used: beforeContext.history_used,
    before_actionable_history_used: beforeContext.actionable_history_used,
    preference_history_used: preferenceContext.history_used,
    preference_actionable_history_used: preferenceContext.actionable_history_used,
    correction_history_used: afterContext.history_used,
    correction_actionable_history_used: afterContext.actionable_history_used,
    active_preference_id: activePreferenceId,
    old_fact_id: oldFactId,
    current_fact_id: currentFactId,
    project_note_id: projectNoteId,
    candidate_note_id: candidateNoteId,
    suppressed_note_id: suppressedNoteId,
    hidden_private_id: hiddenPrivateId,
    preference_use_now_memory_ids: preferenceUseNowIds,
    correction_use_now_memory_ids: useNowIds,
    correction_inspect_before_use_memory_ids: inspectIds,
    holdout_use_now_memory_ids: holdoutUseNowIds,
    holdout_inspect_before_use_memory_ids: holdoutInspectIds,
    holdout_do_not_use_memory_ids: holdoutDoNotUseIds,
    hidden_owner_memory_ids: textArray(hiddenOwnerContext.memory_ids),
    hidden_local_memory_ids: textArray(hiddenLocalContext.memory_ids),
    do_not_use_count: doNotUse.length,
    holdout_do_not_use_count: holdoutDoNotUseIds.length,
    preference_prompt_chars: String(preferenceContext.prompt_text).length,
    correction_prompt_chars: afterPrompt.length,
    holdout_prompt_chars: holdoutPrompt.length,
    preference_receipt_decision_summary_count: recordArray(preferenceReceipt.decision_summaries).length,
    correction_receipt_decision_summary_count: recordArray(receipt.decision_summaries).length,
    active_preference_surface: activeDecision.agent_surface,
    old_fact_surface: oldDecision.agent_surface,
    current_fact_surface: currentDecision.agent_surface,
    project_note_surface: "use_now",
    candidate_note_surface: "inspect_before_use",
    suppressed_note_surface: "do_not_use",
    private_owner_visible: textArray(hiddenOwnerContext.memory_ids).includes(hiddenPrivateId),
    private_cross_agent_hidden: !textArray(hiddenLocalContext.memory_ids).includes(hiddenPrivateId),
    feedback_changed_count: asRecord(feedbackEffect?.guide_trace)?.attributed_memory_count ?? feedbackEffect?.changed_count ?? null,
    measure_receipt_visible: true,
    operator_snapshot_receipt_visible: true,
  };
}

async function main() {
  const runId = `ordinary-memory-${randomUUID().slice(0, 8)}`;
  const scope = `ordinary-memory-product-e2e:${runId}`;
  const session = await openRuntime();
  try {
    const ordinaryMemoryLoop = await runOrdinaryMemoryLoop({
      baseUrl: session.baseUrl,
      apiKey: apiKey(),
      runId,
      scope,
    });
    const result = {
      contract_version: "aionis_ordinary_memory_product_e2e_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
      },
      product_loop: "observe ordinary memory -> guide -> trace/receipt -> feedback -> measure -> snapshot",
      ordinary_memory_loop: ordinaryMemoryLoop,
      checks: {
        real_runtime_loop: true,
        fresh_scope_has_no_actionable_memory: ordinaryMemoryLoop.before_actionable_history_used === false,
        active_preference_direct_use:
          ordinaryMemoryLoop.preference_use_now_memory_ids.includes(ordinaryMemoryLoop.active_preference_id),
        current_fact_direct_use:
          ordinaryMemoryLoop.correction_use_now_memory_ids.includes(ordinaryMemoryLoop.current_fact_id),
        stale_or_contradicted_fact_inspect_first:
          ordinaryMemoryLoop.correction_inspect_before_use_memory_ids.includes(ordinaryMemoryLoop.old_fact_id),
        active_project_note_direct_use:
          ordinaryMemoryLoop.holdout_use_now_memory_ids.includes(ordinaryMemoryLoop.project_note_id),
        candidate_memory_inspect_first:
          ordinaryMemoryLoop.holdout_inspect_before_use_memory_ids.includes(ordinaryMemoryLoop.candidate_note_id),
        suppressed_memory_do_not_use:
          ordinaryMemoryLoop.holdout_do_not_use_memory_ids.includes(ordinaryMemoryLoop.suppressed_note_id),
        private_owner_can_recover:
          ordinaryMemoryLoop.hidden_owner_memory_ids.includes(ordinaryMemoryLoop.hidden_private_id),
        private_cross_agent_hidden:
          !ordinaryMemoryLoop.hidden_local_memory_ids.includes(ordinaryMemoryLoop.hidden_private_id),
        receipt_decision_summaries_visible:
          ordinaryMemoryLoop.preference_receipt_decision_summary_count >= 1
          && ordinaryMemoryLoop.correction_receipt_decision_summary_count >= 2,
        measure_receipt_visible: ordinaryMemoryLoop.measure_receipt_visible,
        operator_snapshot_receipt_visible: ordinaryMemoryLoop.operator_snapshot_receipt_visible,
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
