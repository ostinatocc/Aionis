#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentContextFromGuide,
  agentPromptFromGuide,
  compileExecutionAgentContext,
  createAionisClient,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
  type AionisMemoryAdmissionRecord,
} from "../../src/sdk.ts";
import {
  asRecord,
  assertCondition,
} from "./runtime-agent-loop.ts";
import {
  closeRuntime,
  openRuntime,
} from "./multi-agent-execution-memory-loop.ts";
import { formatE2eError } from "./e2e-error.ts";

const AGENT_ID = "sdk-quickstart-agent";
const PREF_MARKER = "SDK_QUICKSTART_ACTIVE_PREF";
const PROJECT_MARKER = "SDK_QUICKSTART_PROJECT_FACT";

function apiKey(): string | null {
  return process.env.AIONIS_SDK_QUICKSTART_API_KEY?.trim()
    || process.env.AIONIS_PRODUCT_E2E_API_KEY?.trim()
    || process.env.AIONIS_API_KEY?.trim()
    || null;
}

function embeddingModel(session: Awaited<ReturnType<typeof openRuntime>>): string | null {
  if (session.mode === "external") {
    return process.env.AIONIS_SDK_QUICKSTART_EXPECTED_EMBEDDING_MODEL?.trim() || null;
  }
  switch (session.embedding?.provider) {
    case "dashscope":
      return process.env.DASHSCOPE_EMBEDDING_MODEL?.trim() || "text-embedding-v4";
    case "minimax":
      return process.env.MINIMAX_EMBED_MODEL?.trim() || "embo-01";
    case "openai":
      return process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
    default:
      return null;
  }
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

function optionalObserveNodeId(observeBody: unknown): string | null {
  const write = asRecord(asRecord(observeBody)?.memory_write);
  const nodes = recordArray(write?.nodes);
  const id = nodes[0]?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
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

async function main() {
  const runId = `sdk-quickstart-${randomUUID().slice(0, 8)}`;
  const scope = `sdk-quickstart:${runId}`;
  const taskSignature = "sdk-quickstart";
  const taskFamily = "developer_sdk_quickstart";
  const guideQuery = `${PREF_MARKER} ${PROJECT_MARKER} continue SDK quickstart integration`;
  const guideContext = {
    agent_id: AGENT_ID,
    task_kind: "continuity_recovery",
    task_signature: taskSignature,
    goal: guideQuery,
  };
  const measurementExecutionPacket = {
    version: 1,
    state_id: `state:${runId}:measurement`,
    current_stage: "review",
    active_role: "review",
    task_brief: guideQuery,
    target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
    next_action: "Run the Runtime-owned focused verifier.",
    hard_constraints: [],
    accepted_facts: [],
    rejected_paths: [],
    pending_validations: ["npm run -s typecheck"],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    review_contract: null,
    resume_anchor: null,
    artifact_refs: [],
    evidence_refs: [`evidence://sdk-quickstart/${runId}/runtime-verifier`],
  };
  // This quickstart owns its spawned verifier gate. External Runtime callers
  // must configure the same capability on the Runtime they point to.
  process.env.RUNTIME_VERIFIER_EXECUTION_ENABLED = "true";
  const session = await openRuntime();
  try {
    const aionis = createAionisClient({
      baseUrl: session.baseUrl,
      apiKey: apiKey() ?? undefined,
      tenant_id: "default",
      scope,
    });
    await aionis.health();

    const initialGuide = await aionis.guide<Record<string, unknown>>({
      operation_id: `guide:sdk-quickstart:${runId}:initial`,
      run_id: `${runId}:initial`,
      query_text: guideQuery,
      consumer_agent_id: AGENT_ID,
      context: guideContext,
      limit: 2,
      include_packets: true,
    });
    const beforeContext = agentContextFromGuide<Record<string, unknown>>(initialGuide);
    assertPromptBoundary(agentPromptFromGuide(initialGuide), "initial SDK quickstart guide");
    assertCondition(
      beforeContext.actionable_history_used === false,
      "fresh SDK quickstart guide unexpectedly exposed actionable history",
    );

    const beforeGuide = await aionis.guide<Record<string, unknown>>({
      operation_id: `guide:sdk-quickstart:${runId}:before`,
      run_id: runId,
      query_text: guideQuery,
      consumer_agent_id: AGENT_ID,
      context: guideContext,
      execution_packet_v1: measurementExecutionPacket,
      tool_candidates: ["read", "edit", "test"],
      limit: 6,
      include_packets: true,
    });
    assertPromptBoundary(agentPromptFromGuide(beforeGuide), "before SDK quickstart guide");

    const preference = await aionis.remember<Record<string, unknown>>({
      kind: "preference",
      client_id: `sdk-quickstart-preference:${runId}`,
      title: "SDK quickstart response preference",
      text: `${PREF_MARKER}: prefer concise product updates with concrete next steps and cite the active memory when relevant.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      confidence: 0.92,
      slots: { source: "sdk_quickstart" },
    });
    const preferenceId = firstNodeId(preference, "SDK preference remember");

    const projectFact = await aionis.remember<Record<string, unknown>>({
      kind: "project_context",
      client_id: `sdk-quickstart-project:${runId}`,
      title: "SDK quickstart project fact",
      text: `${PROJECT_MARKER}: the active integration target is docs/AIONIS_SDK_QUICKSTART.md and scripts/e2e/developer-sdk-quickstart.ts.`,
      memory_lane: "private",
      owner_agent_id: AGENT_ID,
      target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
      confidence: 0.94,
      slots: { source: "sdk_quickstart" },
    });
    const projectFactId = firstNodeId(projectFact, "SDK project fact remember");

    const inspectedQuickstartDocument = readFileSync(
      new URL("../../docs/AIONIS_SDK_QUICKSTART.md", import.meta.url),
      "utf8",
    );
    assertCondition(
      inspectedQuickstartDocument.includes("SDK v0.3.19")
        && inspectedQuickstartDocument.includes("operation_id"),
      "SDK quickstart inspection did not find the expected v0.3.19 protected-measure contract",
    );
    const verifiedExecutionStep = await aionis.execution.observeStep<Record<string, unknown>>({
      operation_id: `observe:sdk-quickstart:${runId}:verified-step`,
      auto_embed: true,
      agent_id: AGENT_ID,
      run_id: runId,
      task_id: `task:${runId}`,
      task_signature: taskSignature,
      task_family: taskFamily,
      workflow_signature: "sdk-quickstart-execution-context",
      title: guideQuery,
      summary: `${guideQuery} recovered and inspected the active SDK v0.3.19 quickstart document.`,
      outcome: "succeeded",
      target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
      workflow_steps: [
        "Recover the persisted SDK guide state.",
        "Read docs/AIONIS_SDK_QUICKSTART.md.",
        "Verify the v0.3.19 and protected operation identity guidance.",
      ],
      acceptance_checks: [
        "the document declares SDK v0.3.19",
        "the document includes protected operation_id guidance",
      ],
      continuation_hint: "Continue from the inspected SDK quickstart contract.",
      confidence: 0.95,
      evidence: [{
        ref: `evidence://sdk-quickstart/${runId}/document-inspection`,
        summary: "The host read and inspected the SDK v0.3.19 quickstart document.",
      }],
    });
    assertCondition(
      optionalObserveNodeId(verifiedExecutionStep) !== null,
      "SDK verified execution step was not stored",
    );

    const afterGuide = await aionis.guide<Record<string, unknown>>({
      operation_id: `guide:sdk-quickstart:${runId}:after`,
      run_id: runId,
      query_text: guideQuery,
      consumer_agent_id: AGENT_ID,
      context: guideContext,
      execution_packet_v1: measurementExecutionPacket,
      runtime_verification: {
        version: 1,
        mode: "execute",
        agent_lifecycle_state: "agent_exited",
        include_pending_validations: true,
        validation_boundary: "runtime_orchestrator",
        timeout_ms: 120_000,
        max_requests: 4,
        cwd: null,
        agent_claimed_success: true,
      },
      tool_candidates: ["read", "edit", "test"],
      limit: 8,
      include_packets: true,
    });
    const afterContext = agentContextFromGuide<Record<string, unknown>>(afterGuide);
    const promptText = agentPromptFromGuide(afterGuide);
    assertPromptBoundary(promptText, "after SDK quickstart guide");
    const useNowIds = textArray(afterContext.use_now_memory_ids);
    const useNow = textArray(afterContext.use_now);
    assertCondition(afterContext.actionable_history_used === true, "SDK quickstart guide did not expose actionable memory");
    assertCondition(useNowIds.includes(preferenceId), "SDK preference was not exposed in use_now memory IDs");
    assertCondition(useNowIds.includes(projectFactId), "SDK project fact was not exposed in use_now memory IDs");
    assertCondition(
      useNow.some((entry) => entry.includes(PREF_MARKER)) || promptText.includes(PREF_MARKER),
      "SDK preference marker missing from Agent-facing context",
    );
    assertCondition(
      useNow.some((entry) => entry.includes(PROJECT_MARKER)) || promptText.includes(PROJECT_MARKER),
      "SDK project marker missing from Agent-facing context",
    );

    const toolSelection = asRecord(afterGuide.tool_selection);
    assertCondition(
      toolSelection?.contract_version === "aionis_tool_selection_receipt_v1",
      "SDK quickstart after-guide missing persisted tool-selection receipt",
    );
    assertCondition(
      toolSelection.selected_tool === "read",
      `SDK quickstart expected Runtime-governed read selection, received ${String(toolSelection.selected_tool)}`,
    );
    const toolCandidates = textArray(toolSelection.candidates);
    assertCondition(toolCandidates.length > 0, "SDK quickstart tool-selection receipt has no candidates");
    const selectedToolDocument = readFileSync(
      new URL("../../docs/AIONIS_SDK_QUICKSTART.md", import.meta.url),
      "utf8",
    );
    const selectedToolDocumentVerified = selectedToolDocument.includes("SDK v0.3.19")
      && selectedToolDocument.includes("operation_id");
    assertCondition(
      selectedToolDocumentVerified,
      "Runtime-governed read did not recover the expected SDK v0.3.19 quickstart contract",
    );
    const feedback = await aionis.feedback<Record<string, unknown>>(feedbackFromGuide({
      guide: afterGuide,
      reason: "The exposed project fact supplied docs/AIONIS_SDK_QUICKSTART.md, which the Runtime-governed read actually opened and verified.",
      run_id: `run:${runId}:feedback`,
      outcome: "positive",
      used_memory_ids: [projectFactId],
    }));
    const toolFeedback = await aionis.feedback<Record<string, unknown>>({
      feedback_kind: "tool_selection",
      operation_id: `feedback:sdk-quickstart:tool:${runId}`,
      guide_trace_id: String(toolSelection.guide_trace_id ?? afterGuide.guide_trace_id),
      decision_id: String(toolSelection.decision_id),
      run_id: String(toolSelection.run_id),
      selected_tool: "read",
      candidates: toolCandidates,
      outcome: "positive",
      consumer_agent_id: AGENT_ID,
      context: guideContext,
      input_text: "The selected read tool recovered and verified docs/AIONIS_SDK_QUICKSTART.md before positive feedback.",
    });
    assertCondition(
      toolFeedback.contract_version === "aionis_feedback_result_v1",
      "SDK quickstart protected tool feedback did not return result v1",
    );

    const measureOperationId = `measure:sdk-quickstart:${runId}`;
    const measureRequest = measureInputFromGuideLoop({
      operation_id: measureOperationId,
      task: {
        task_id: `task:${runId}`,
        run_id: runId,
        task_signature: taskSignature,
        task_family: taskFamily,
      },
      before_guide: beforeGuide,
      after_guide: afterGuide,
      feedback_result: feedback,
      sufficient_evidence: false,
      evidence_ids: [
        `caller-only:${runId}:must-not-open-measure-gate`,
      ],
    });
    const measure = await aionis.measure<Record<string, unknown>>(measureRequest);
    const effectReport = asRecord(measure.effect_report);
    const historyImpact = asRecord(effectReport?.history_impact);
    const decisionTrace = asRecord(measure.memory_decision_trace);
    const receipt = asRecord(decisionTrace?.memory_use_receipt);
    const admissionRecord = asRecord(decisionTrace?.admission_record);
    const evidenceAssessment = asRecord(measure.evidence_assessment);
    const clientClaimsIgnored = asRecord(evidenceAssessment?.client_claims_ignored);
    const measureSourceMap = asRecord(measure.source_map);
    const measureInternalSurfaces = textArray(measureSourceMap?.internal_surfaces_used);
    const runtimeEvidenceIds = textArray(evidenceAssessment?.runtime_evidence_ids);
    const beforeAttribution = asRecord(beforeGuide.feedback_attribution_v1);
    const afterAttribution = asRecord(afterGuide.feedback_attribution_v1);
    assertCondition(measure.contract_version === "aionis_measure_result_v1", "SDK quickstart measure did not return result v1");
    assertCondition(measure.operation_id === measureOperationId, "SDK quickstart measure lost protected operation identity");
    assertCondition(measure.measurement_persisted === true, "SDK quickstart measure did not persist its immutable measurement");
    assertCondition(
      typeof measure.measurement_id === "string" && measure.measurement_id.length > 0,
      "SDK quickstart measure did not return measurement identity",
    );
    assertCondition(
      typeof measure.measurement_digest === "string" && /^[0-9a-f]{64}$/u.test(measure.measurement_digest),
      "SDK quickstart measure did not return canonical measurement digest",
    );
    const measureReplay = await aionis.measure<Record<string, unknown>>(measureRequest);
    assertCondition(
      JSON.stringify(measureReplay) === JSON.stringify(measure),
      "SDK quickstart protected measure did not replay its exact durable receipt",
    );
    assertCondition(
      evidenceAssessment?.status === "sufficient" && evidenceAssessment.provenance === "runtime_verified",
      `SDK quickstart measure did not pass Runtime-owned evidence verification: ${JSON.stringify({
        evidenceAssessment,
        kernelReport: measure.kernel_report,
      })}`,
    );
    assertCondition(
      clientClaimsIgnored?.sufficient_evidence === false
        && clientClaimsIgnored.evidence_id_count === 1
        && !runtimeEvidenceIds.some((id) => id.startsWith("caller-only:")),
      `SDK quickstart caller evidence claim incorrectly affected Runtime authority: ${JSON.stringify({ clientClaimsIgnored, runtimeEvidenceIds })}`,
    );
    assertCondition(
      beforeAttribution?.status === "available"
        && afterAttribution?.status === "available"
        && typeof beforeAttribution.episode_id === "string"
        && typeof afterAttribution.episode_id === "string"
        && beforeAttribution.episode_id !== afterAttribution.episode_id,
      "SDK quickstart measure did not expose a distinct persisted episode pair",
    );
    assertCondition(
      runtimeEvidenceIds.filter((id) => id.startsWith("effect_expected_v1:")).length === 1
        && measureInternalSurfaces.includes("learning_episode_pair")
        && measureInternalSurfaces.includes("learning_effect_event"),
      `SDK quickstart measure did not persist verified effect-to-episode binding: ${JSON.stringify({ runtimeEvidenceIds, measureInternalSurfaces })}`,
    );
    assertCondition(historyImpact?.impact_direction === "positive", `SDK quickstart measure did not report positive history impact: ${JSON.stringify(historyImpact)}`);
    assertCondition(receipt?.contract_version === "aionis_memory_use_receipt_v1", "SDK quickstart measure missing memory use receipt");
    assertCondition(admissionRecord?.contract_version === "aionis_memory_admission_record_v1", "SDK quickstart measure missing admission record");

    const admissionDatasetRows = memoryAdmissionDatasetRowsFromRecord(admissionRecord as unknown as AionisMemoryAdmissionRecord, {
      run_id: runId,
      task_id: `task:${runId}`,
      task_signature: "sdk-quickstart",
    });
    const admissionDatasetJsonl = memoryAdmissionDatasetJsonlFromRows(admissionDatasetRows);
    const attributedProjectFactRow = admissionDatasetRows.find((entry) => entry.memory_id === projectFactId);
    assertCondition(admissionDatasetRows.length > 0, "SDK quickstart admission dataset export produced no rows");
    assertCondition(
      admissionDatasetJsonl.split("\n").filter(Boolean).length === admissionDatasetRows.length,
      "SDK quickstart admission dataset JSONL line count mismatch",
    );
    assertCondition(
      attributedProjectFactRow?.outcome_label === "positive_use",
      "SDK quickstart admission dataset did not join positive feedback attribution",
    );
    assertCondition(!admissionDatasetJsonl.includes("prompt_text"), "SDK quickstart admission dataset leaked prompt_text");
    assertCondition(!admissionDatasetJsonl.includes("prompt_preview"), "SDK quickstart admission dataset leaked prompt preview");

    const snapshot = await aionis.snapshot<Record<string, unknown>>(snapshotInputFromGuideLoop({
      run_id: runId,
      task_signature: taskSignature,
      task_family: taskFamily,
      guide: afterGuide,
      measure_result: measure,
      include_markdown: false,
    }));
    const operatorSnapshot = asRecord(snapshot.operator_snapshot);
    const snapshotReceipt = asRecord(operatorSnapshot?.memory_use_receipt);
    const snapshotAdmissionRecord = asRecord(operatorSnapshot?.memory_admission_record);
    assertCondition(operatorSnapshot?.contract_version === "aionis_operator_snapshot_v1", "SDK quickstart snapshot missing snapshot v1");
    assertCondition(snapshotReceipt?.contract_version === "aionis_memory_use_receipt_v1", "SDK quickstart snapshot missing receipt");
    assertCondition(snapshotAdmissionRecord?.contract_version === "aionis_memory_admission_record_v1", "SDK quickstart snapshot missing admission record");

    const executionHandoff = await aionis.execution.handoff<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: runId,
      task_signature: taskSignature,
      task_family: taskFamily,
      workflow_signature: "sdk-quickstart-execution-context",
      title: "SDK quickstart execution handoff",
      summary: `${PROJECT_MARKER}: continue the SDK quickstart docs update without broad rediscovery.`,
      outcome: "succeeded",
      target_files: ["docs/AIONIS_SDK_QUICKSTART.md", "scripts/e2e/developer-sdk-quickstart.ts"],
      continuation_hint: "Use the SDK execution context compiler as the Agent prompt path.",
      acceptance_checks: ["compiled execution context is generated", "feedback remains attributed"],
      evidence_ref: `evidence://sdk-quickstart/${runId}/execution-handoff`,
    });
    const handoffStored = !!asRecord(executionHandoff.handoff);
    assertCondition(handoffStored, "SDK execution handoff was not stored");
    const executionHandoffId = optionalObserveNodeId(executionHandoff);

    const executionGuide = await aionis.execution.guideForRole<Record<string, unknown>>({
      agent_id: AGENT_ID,
      run_id: `run:${runId}:execution-context`,
      task_signature: taskSignature,
      task_family: taskFamily,
      workflow_signature: "sdk-quickstart-execution-context",
      query_text: `${PROJECT_MARKER} continue the SDK quickstart execution-memory path`,
      context_mode: "compact_agent",
      limit: 10,
      include_packets: true,
    });
    const compiledContext = aionis.execution.compileAgentContext({
      guide: executionGuide,
      task: {
        run_id: runId,
        task_signature: taskSignature,
        query_text: "Continue the SDK quickstart execution-memory path.",
      },
      repo_state: {
        existing_files: [
          "docs/AIONIS_SDK_QUICKSTART.md",
          "scripts/e2e/developer-sdk-quickstart.ts",
        ],
        missing_files: [],
      },
      budget_profile: "balanced",
    });
    assertPromptBoundary(compiledContext.agent_prompt, "compiled SDK execution context");
    assertCondition(
      compiledContext.agent_prompt.includes("AIONIS_EXECUTION_AGENT_CONTEXT v1"),
      "SDK quickstart did not render execution Agent context contract",
    );
    assertCondition(
      compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
      "SDK execution context missing memory use receipt",
    );
    assertCondition(
      compiledContext.memory_use_receipt.history_used === true,
      "SDK execution context did not preserve memory-use audit state",
    );
    assertCondition(
      compiledContext.prompt_char_count > 0,
      "SDK execution context produced empty Agent prompt",
    );
    assertCondition(
      compiledContext.missing_active_targets.length === 0
        && !compiledContext.execution_warnings.some((entry) => entry.code === "missing_active_target"),
      "SDK execution context contradicted the files verified by the real read tool",
    );

    const feedbackEffect = asRecord(feedback.forget_effect);
    const guideTrace = asRecord(feedbackEffect?.guide_trace);
    const result = {
      contract_version: "aionis_sdk_quickstart_result_v1",
      run_id: runId,
      runtime: {
        mode: session.mode,
        base_url: session.baseUrl,
        embedding_provider: session.embedding?.provider ?? "external_runtime",
        embedding_model: embeddingModel(session),
      },
      integration_path: {
        sdk_client: "createAionisClient",
        product_loop: "remember -> guideAgentContext -> agent_prompt -> feedback -> measure -> snapshot",
        execution_context_compiler: "aionis.execution.compileAgentContext",
      },
      agent_context: {
        before_actionable_history_used: beforeContext.actionable_history_used,
        after_actionable_history_used: afterContext.actionable_history_used,
        prompt_char_count: promptText.length,
        prompt_preview: promptText.slice(0, 800),
        use_now_memory_ids: useNowIds,
      },
      execution_context_compiler: {
        contract_version: compiledContext.contract_version,
        budget_profile: compiledContext.budget_profile,
        metadata_prompt_char_count: compiledContext.prompt_char_count,
        route_contract_present: compiledContext.route_contract !== null,
        active_targets: compiledContext.active_targets,
        missing_active_targets: compiledContext.missing_active_targets,
        blocked_direction_targets: compiledContext.blocked_direction_targets,
        rehydrate_request_count: compiledContext.rehydrate_requests.length,
        warning_codes: compiledContext.execution_warnings.map((entry) => entry.code),
        memory_use_receipt_visible: compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
      },
      memory_governance: {
        preference_memory_id: preferenceId,
        project_fact_memory_id: projectFactId,
        execution_handoff_memory_id: executionHandoffId,
        execution_handoff_stored: handoffStored,
        feedback_attributed_memory_count: guideTrace?.attributed_memory_count ?? null,
        measure_history_impact: historyImpact.impact_direction,
        measure_operation_id: measure.operation_id,
        measurement_id: measure.measurement_id,
        measurement_digest: measure.measurement_digest,
        measurement_persisted: measure.measurement_persisted,
        measure_exact_replay: JSON.stringify(measureReplay) === JSON.stringify(measure),
        measure_evidence_status: evidenceAssessment.status,
        measure_evidence_provenance: evidenceAssessment.provenance,
        ignored_caller_sufficient_evidence_value: clientClaimsIgnored.sufficient_evidence,
        caller_evidence_id_count_ignored: clientClaimsIgnored.evidence_id_count,
        baseline_episode_id: beforeAttribution.episode_id,
        after_episode_id: afterAttribution.episode_id,
        effect_episode_binding_persisted: measureInternalSurfaces.includes("learning_effect_event"),
        governed_tool_selected: toolSelection.selected_tool,
        governed_tool_document_verified: selectedToolDocumentVerified,
      },
      admission_dataset_export: {
        contract_version: "aionis_memory_admission_dataset_row_v1",
        row_count: admissionDatasetRows.length,
        jsonl_line_count: admissionDatasetJsonl.split("\n").filter(Boolean).length,
        positive_use_count: admissionDatasetRows.filter((entry) => entry.outcome_label === "positive_use").length,
        blocked_or_suppressed_count: admissionDatasetRows.filter((entry) => entry.outcome_label === "blocked_or_suppressed").length,
        prompt_payload_excluded: !admissionDatasetJsonl.includes("prompt_text"),
        raw_slots_excluded: !admissionDatasetJsonl.includes("raw_slots") && !admissionDatasetJsonl.includes("\"slots\""),
        example_jsonl_line: admissionDatasetJsonl.split("\n").find(Boolean) ?? null,
      },
      operator_audit: {
        memory_use_receipt_visible: true,
        receipt_decision_summary_count: recordArray(receipt.decision_summaries).length,
        memory_admission_record_visible: true,
        snapshot_receipt_visible: true,
        snapshot_admission_record_visible: true,
        snapshot_runtime_mutation: operatorSnapshot.runtime_mutation,
      },
      checks: {
        starts_without_actionable_history: beforeContext.actionable_history_used === false,
        guide_exposes_preference: useNowIds.includes(preferenceId),
        guide_exposes_project_fact: useNowIds.includes(projectFactId),
        agent_prompt_boundary_preserved: true,
        execution_context_compiler_used: compiledContext.contract_version === "aionis_execution_agent_context_v1",
        execution_context_receipt_visible: compiledContext.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
        execution_context_repo_state_verified: compiledContext.missing_active_targets.length === 0
          && !compiledContext.execution_warnings.some((entry) => entry.code === "missing_active_target"),
        feedback_attributed: guideTrace?.attributed_memory_count === 1,
        admission_dataset_exported: admissionDatasetRows.length > 0,
        admission_dataset_feedback_joined: attributedProjectFactRow?.outcome_label === "positive_use",
        admission_dataset_prompt_payload_excluded: !admissionDatasetJsonl.includes("prompt_text"),
        positive_history_impact_measured: historyImpact.impact_direction === "positive",
        protected_measure_identity_preserved: measure.operation_id === measureOperationId,
        immutable_measurement_persisted: measure.measurement_persisted === true,
        protected_measure_exact_replay: JSON.stringify(measureReplay) === JSON.stringify(measure),
        runtime_verified_measure_evidence: evidenceAssessment.status === "sufficient"
          && evidenceAssessment.provenance === "runtime_verified",
        caller_measure_claim_did_not_open_gate: clientClaimsIgnored.sufficient_evidence === false
          && clientClaimsIgnored.evidence_id_count === 1
          && !runtimeEvidenceIds.some((id) => id.startsWith("caller-only:")),
        verified_effect_episode_binding_persisted: runtimeEvidenceIds.some((id) => id.startsWith("effect_expected_v1:"))
          && measureInternalSurfaces.includes("learning_episode_pair")
          && measureInternalSurfaces.includes("learning_effect_event"),
        runtime_governed_tool_executed: toolSelection.selected_tool === "read"
          && selectedToolDocumentVerified,
        operator_snapshot_read_only: operatorSnapshot.runtime_mutation === false,
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
