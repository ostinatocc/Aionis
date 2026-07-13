import { randomUUID } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import {
  evaluateAionisEffect,
  type AionisEffectObservation,
} from "../kernel/effect-evaluator.js";
import { sha256Hex } from "../util/crypto.js";
import { buildAionisEffectReport } from "../memory/product-output/learning-effect.js";
import {
  AionisAgentRoleSchema,
  AionisAgentContextSchema,
  AionisTaskContextProfileSchema,
  AionisEffectReportSchema,
  AionisExternalMemoryCandidateSchema,
  AionisGuidePacketSchema,
  AionisMemoryPacketSchema,
  AionisProcedureMemoryDraftV1Schema,
  type AionisEffectReport,
  type AionisAgentContext,
  type AionisAgentRole,
  type AionisTaskContextProfile,
  type AionisClaimLedgerProjection,
  type AionisMemoryDecisionAuditReport,
  type AionisMemoryDecisionTrace,
  type AionisGuidePacket,
  type AionisMemoryPacket,
  type AionisProcedureMemoryDraftV1,
} from "../memory/product-output-contract.js";
import type {
  ProductMeasurementRecord,
  SkillCandidateReviewAccess,
  SkillCandidateReviewRow,
  SkillCandidateReviewStatus,
  TraceDerivedSkillTrainingCandidate,
} from "../store/memory-store.js";
import { productMeasurementDigest, stableJsonDigest } from "../store/memory-store.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import {
  ProductForgetInput,
  ProductForgetTarget,
  ProductMeasureGuideSnapshotSchema,
  ProductMeasureRequest,
  ProductMeasureTraceSchema,
  ProductSkillCandidateEnqueueRequest,
  finiteNumber,
  objectValue,
  parseGuideExposureLedger,
  productMemoryDecisionOutputs,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  uniqueStrings,
} from "./product-services.js";
import type {
  ProductGuideExposureLedger,
  ProductMeasureRequestInput,
  ProductServiceResult,
  ProductServices,
  ProductSkillCandidateEnqueueInput,
} from "./product-services.js";

function compactProductPromptText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

type ProductMeasureInput = z.infer<typeof ProductMeasureRequest>;

type ProductMeasureTraceInput = z.infer<typeof ProductMeasureTraceSchema>;

type ProductMeasureGuideSnapshot = z.infer<typeof ProductMeasureGuideSnapshotSchema>;

function productMeasureContextItems(snapshot: ProductMeasureGuideSnapshot): number {
  const explicit = finiteNumber(snapshot.context_items);
  if (explicit !== null) return explicit;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.relevant_memories.length ?? 0)
    + (guidePacket?.guidance.workflow_candidates.length ?? 0)
    + (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.memory_lifecycle.rehydration_hints.length ?? 0);
}

function productMeasureUsefulContextItems(snapshot: ProductMeasureGuideSnapshot): number {
  const explicit = finiteNumber(snapshot.useful_context_items);
  if (explicit !== null) return explicit;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  const usefulMemories = memoryPacket?.relevant_memories.filter((memory) =>
    memory.authority !== "blocked"
    && memory.lifecycle_state !== "suppressed"
    && memory.lifecycle_state !== "archived",
  ).length ?? 0;
  const usefulWorkflows = guidePacket?.guidance.workflow_candidates.filter((workflow) => workflow.authority !== "blocked").length ?? 0;
  return usefulMemories
    + usefulWorkflows
    + (guidePacket?.proven_facts.length ?? 0);
}

function productMeasureHistoricalContextCount(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.relevant_memories.length ?? 0)
    + (guidePacket?.guidance.workflow_candidates.length ?? 0)
    + (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.memory_lifecycle.rehydration_hints.length ?? 0);
}

function productMeasureRecoveredFactCount(snapshot: ProductMeasureGuideSnapshot): number {
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  if (!guidePacket && !memoryPacket) return 0;
  return (guidePacket?.proven_facts.length ?? 0)
    + (guidePacket?.recovered_state.resumable ? 1 : 0)
    + (guidePacket?.recovered_state.target_files.length ?? 0)
    + (guidePacket?.recovered_state.acceptance_checks.length ?? 0)
    + (memoryPacket?.relevant_memories.length ?? 0);
}

function productMeasureVerifiedFactCount(snapshot: ProductMeasureGuideSnapshot): number {
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  return (guidePacket?.proven_facts.length ?? 0)
    + (memoryPacket?.evidence_trail.length ?? 0)
    + (guidePacket?.history_contributions.handoff.source_count ?? 0)
    + (guidePacket?.history_contributions.replay.source_count ?? 0);
}

function productMeasureExpectedCount(explicit: unknown, observed: number): number {
  const expected = finiteNumber(explicit);
  if (expected !== null && expected > 0) return expected;
  return Math.max(observed, 1);
}

function productMeasureRepeatedDiscovery(snapshot: ProductMeasureGuideSnapshot, baseline: boolean): number {
  const explicit = finiteNumber(snapshot.repeated_discovery_steps);
  if (explicit !== null) return explicit;
  const guidePacket = snapshot.guide_packet ?? null;
  const memoryPacket = snapshot.memory_packet ?? null;
  const actionableHistoryUsed =
    snapshot.agent_context?.actionable_history_used === true
    || guidePacket?.guide_brief.actionable_history_used === true;
  const reducesDiscovery = guidePacket?.guide_brief.expected_product_effects.reduces_repeated_discovery === true;
  if (actionableHistoryUsed && reducesDiscovery) return 0;
  const actionableHistory =
    (memoryPacket?.relevant_memories.length ?? 0) > 0
    || (guidePacket?.guidance.workflow_candidates.length ?? 0) > 0
    || (guidePacket?.proven_facts.length ?? 0) > 0
    || guidePacket?.recovered_state.resumable === true;
  if (actionableHistory) return 1;
  return baseline ? 4 : 3;
}

function productMeasureStaleSurfaced(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return Math.max(
    memoryPacket?.forgetting_state.stale_memory_count ?? 0,
    memoryPacket?.risk.stale_memory_count ?? 0,
    guidePacket?.risk.stale_memory_count ?? 0,
  );
}

function productMeasureStaleSuppressed(snapshot: ProductMeasureGuideSnapshot): number {
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  return (memoryPacket?.forgetting_state.suppressed_count ?? 0)
    + (guidePacket?.memory_lifecycle.suppressed_memory_ids.length ?? 0)
    + (guidePacket?.guide_brief.do_not_use.length ?? 0);
}

function productMeasureForgetChanged(trace: ProductMeasureTraceInput, action: ProductForgetInput["operation"], target?: ProductForgetTarget): number {
  const effect = trace.forget_result?.forget_effect;
  if (!effect) return 0;
  if (effect.action && effect.action !== action) return 0;
  if (target && effect.target && effect.target !== target) return 0;
  return finiteNumber(effect.changed_count) ?? 0;
}

function productMeasureObservationFromGuideSnapshot(args: {
  snapshot: ProductMeasureGuideSnapshot;
  trace: ProductMeasureTraceInput;
  baseline: boolean;
}): AionisEffectObservation {
  const { snapshot, trace, baseline } = args;
  const memoryPacket = snapshot.memory_packet ?? null;
  const guidePacket = snapshot.guide_packet ?? null;
  let contextItems = productMeasureContextItems(snapshot);
  let usefulContextItems = productMeasureUsefulContextItems(snapshot);
  const recoveredFacts = productMeasureRecoveredFactCount(snapshot);
  const verifiedFacts = productMeasureVerifiedFactCount(snapshot);
  if (
    baseline
    && finiteNumber(snapshot.context_items) === null
    && finiteNumber(snapshot.useful_context_items) === null
    && productMeasureHistoricalContextCount(snapshot) === 0
  ) {
    contextItems = 1;
    usefulContextItems = 0;
  }
  const workflowCandidates = guidePacket?.guidance.workflow_candidates ?? [];
  const trustedWorkflowCount = workflowCandidates.filter((workflow) => workflow.authority === "trusted").length;
  const weakTrustedWorkflowCount = workflowCandidates.filter((workflow) =>
    workflow.authority === "trusted" && workflow.evidence_count <= 0,
  ).length;
  const blockedAuthorityCount = guidePacket?.risk.blocked_authority_count ?? 0;
  const inspectOrBlockedCount =
    (guidePacket?.guide_brief.inspect_before_use.length ?? 0)
    + (guidePacket?.guide_brief.do_not_use.length ?? 0)
    + blockedAuthorityCount;
  const staleSuppressed = productMeasureStaleSuppressed(snapshot)
    + (baseline ? 0 : productMeasureForgetChanged(trace, "suppress", "pattern"));
  const archivedRehydrated = baseline ? 0 : (
    productMeasureForgetChanged(trace, "rehydrate", "archive")
    + productMeasureForgetChanged(trace, "rehydrate", "payload")
  );
  const unverifiedPacketAuthority = guidePacket?.guide_brief.authority === "trusted"
    && (memoryPacket?.evidence_trail.length ?? 0) === 0
    && (guidePacket?.proven_facts.length ?? 0) === 0
    ? 1
    : 0;

  return {
    label: baseline ? "product_trace.before_guide" : "product_trace.after_guide",
    continuity: {
      repeatedDiscoverySteps: productMeasureRepeatedDiscovery(snapshot, baseline),
      continuityGuidanceCorrect:
        guidePacket?.guide_brief.expected_product_effects.reduces_repeated_discovery === true
        || recoveredFacts > 0,
      recoveredStateFacts: recoveredFacts,
      expectedStateFacts: productMeasureExpectedCount(snapshot.expected_state_facts, recoveredFacts),
      recoveredStateApplicable: true,
      verifiedFactsCarried: verifiedFacts,
      verifiedFactsExpected: productMeasureExpectedCount(snapshot.verified_facts_expected, verifiedFacts),
      verifiedFactsApplicable: true,
    },
    learning: {
      workflowReused: workflowCandidates.length > 0,
      stableWorkflowReused: trustedWorkflowCount > 0,
      provisionalMemoriesWritten: workflowCandidates.filter((workflow) => workflow.authority === "candidate" || workflow.authority === "advisory").length,
      trustedPromotions: trustedWorkflowCount,
      weakEvidencePromoted: weakTrustedWorkflowCount,
      counterEvidenceDemotions: staleSuppressed > 0 ? staleSuppressed : 0,
    },
    forgetting: {
      contextItems,
      usefulContextItems,
      staleMemorySurfaced: productMeasureStaleSurfaced(snapshot),
      staleMemorySuppressed: staleSuppressed,
      archivedMemoryRehydratedOnDemand: archivedRehydrated,
      unnecessaryRehydrations: 0,
      staleMemoryControlApplicable: productMeasureStaleSurfaced(snapshot) + staleSuppressed > 0,
      rehydrationApplicable: archivedRehydrated > 0,
    },
    learning_control: {
      weakEvidenceBlocked: inspectOrBlockedCount,
      authorityRequiresEvidence: true,
      blockedAuthorityVisible: true,
      unverifiedAuthorityApplied: weakTrustedWorkflowCount + unverifiedPacketAuthority,
    },
  };
}

function productMeasureInputs(parsed: ProductMeasureInput): {
  baseline: AionisEffectObservation;
  aionis: AionisEffectObservation;
  source: "manual_observations" | "product_trace";
  evidenceIds: string[];
  comparison: ProductMeasureInput["comparison"];
} {
  if (parsed.product_trace) {
    const trace = parsed.product_trace;
    const baseline = trace.baseline
      ? trace.baseline as AionisEffectObservation
      : productMeasureObservationFromGuideSnapshot({
        snapshot: trace.before_guide as ProductMeasureGuideSnapshot,
        trace,
        baseline: true,
      });
    const aionis = productMeasureObservationFromGuideSnapshot({
      snapshot: trace.after_guide,
      trace,
      baseline: false,
    });
    return {
      baseline,
      aionis,
      source: "product_trace",
      evidenceIds: [],
      comparison: {
        mode: parsed.comparison?.mode ?? "observe_only_vs_active",
        baseline_run_id: parsed.comparison?.baseline_run_id ?? null,
        aionis_run_id: parsed.comparison?.aionis_run_id ?? null,
        sufficient_evidence: false,
      },
    };
  }
  return {
    baseline: parsed.baseline as AionisEffectObservation,
    aionis: parsed.aionis as AionisEffectObservation,
    source: "manual_observations",
    evidenceIds: [],
    comparison: {
      ...(parsed.comparison ?? {}),
      sufficient_evidence: false,
    },
  };
}

function productTraceDerivedSkillCandidates(report: AionisEffectReport): TraceDerivedSkillTrainingCandidate[] {
  return report.training_candidates.filter((candidate): candidate is TraceDerivedSkillTrainingCandidate => {
    const skill = candidate.trace_derived_skill;
    return candidate.candidate_type === "trace_derived_skill"
      && !!skill
      && skill.contract_version === "aionis_trace_derived_skill_candidate_v1";
  });
}

type ProductMeasureEvidenceStore = Pick<
  LiteWriteStore,
  "getProductGuideReceipt" | "listRuleFeedbackByRun"
>;

function asProductMeasureEvidenceStore(value: ProductMeasureEvidenceStore | null | undefined): ProductMeasureEvidenceStore | null {
  if (!value) return null;
  return typeof value.getProductGuideReceipt === "function"
    && typeof value.listRuleFeedbackByRun === "function"
    ? value
    : null;
}

type ProductMeasureEvidenceAssessment = {
  status: "sufficient" | "insufficient";
  sufficient_evidence: boolean;
  eligible_for_skill_export: boolean;
  provenance: "runtime_verified" | "manual_unverified" | "unverified_product_trace";
  runtime_evidence_ids: string[];
  reasons: string[];
  client_claims_ignored: {
    sufficient_evidence: boolean | null;
    evidence_id_count: number;
  };
};

type ProductMeasureEvidenceResolution = ProductMeasureEvidenceAssessment & {
  verified_observations?: {
    baseline: AionisEffectObservation;
    aionis: AionisEffectObservation;
  };
  verified_kernel_report?: ReturnType<typeof evaluateAionisEffect>;
};

type ResolvedGuideReceipt = {
  ledger: ProductGuideExposureLedger;
  evidence_id: string;
  created_at: string;
};

const PRODUCT_SKILL_EXPORT_MIN_EFFECT_DELTA = 0.1;
const PRODUCT_SKILL_EXPORT_MIN_AIONIS_SCORE = 0.7;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function snapshotGuideTraceId(snapshot: ProductMeasureGuideSnapshot | undefined): string | null {
  return stringValue(objectValue(snapshot)?.guide_trace_id);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function snapshotReceiptMismatchReasons(
  snapshot: ProductMeasureGuideSnapshot,
  receipt: ProductGuideExposureLedger,
): string[] {
  const reasons: string[] = [];
  const snapshotRecord = objectValue(snapshot);
  const context = snapshot.agent_context ?? null;
  if (stringValue(snapshotRecord?.guide_trace_id) !== receipt.guide_trace_id) reasons.push("guide_trace_id_mismatch");
  if (stringValue(snapshotRecord?.tenant_id) !== receipt.tenant_id) reasons.push("guide_tenant_mismatch");
  if (stringValue(snapshotRecord?.scope) !== receipt.scope) reasons.push("guide_scope_mismatch");
  if (!context) return [...reasons, "agent_context_missing"];
  if (context.history_used !== receipt.history_used) reasons.push("history_used_mismatch");
  if (context.actionable_history_used !== receipt.actionable_history_used) reasons.push("actionable_history_used_mismatch");
  if (context.recommended_posture !== receipt.recommended_posture) reasons.push("recommended_posture_mismatch");
  if (context.authority !== receipt.authority) reasons.push("authority_mismatch");
  if (!sameStringSet(context.memory_ids, receipt.memory_ids)) reasons.push("memory_ids_mismatch");
  if (!sameStringSet(context.use_now_memory_ids, receipt.use_now_memory_ids)) reasons.push("use_now_memory_ids_mismatch");
  if (!sameStringSet(context.inspect_before_use_memory_ids, receipt.inspect_before_use_memory_ids)) {
    reasons.push("inspect_before_use_memory_ids_mismatch");
  }
  if (!sameStringSet(context.do_not_use_memory_ids, receipt.do_not_use_memory_ids)) {
    reasons.push("do_not_use_memory_ids_mismatch");
  }
  return reasons;
}

async function resolveGuideReceipt(args: {
  store: ProductMeasureEvidenceStore;
  tenantId: string;
  scope: string;
  guideTraceId: string;
}): Promise<ResolvedGuideReceipt | null> {
  const row = await args.store.getProductGuideReceipt({
    tenantId: args.tenantId,
    scope: args.scope,
    guideTraceId: args.guideTraceId,
  });
  if (!row || !row.commit_id) return null;
  let rawLedger: unknown;
  try {
    rawLedger = JSON.parse(row.ledger_json);
  } catch {
    return null;
  }
  const expectedDigest = sha256Hex(stableStringify(rawLedger));
  if (expectedDigest !== row.ledger_sha256) return null;
  const ledger = parseGuideExposureLedger(rawLedger);
  if (
    !ledger
    || ledger.guide_trace_id !== row.guide_trace_id
    || ledger.tenant_id !== row.tenant_id
    || ledger.scope !== row.scope
    || ledger.query_sha256 !== row.query_sha256
    || ledger.context_sha256 !== row.context_sha256
  ) return null;
  return {
    ledger,
    evidence_id: `guide_receipt:${ledger.guide_trace_id}:${expectedDigest}`,
    created_at: row.created_at,
  };
}

function insufficientEvidenceAssessment(args: {
  parsed: ProductMeasureInput;
  provenance: ProductMeasureEvidenceAssessment["provenance"];
  reasons: string[];
  runtimeEvidenceIds?: string[];
}): ProductMeasureEvidenceAssessment {
  return {
    status: "insufficient",
    sufficient_evidence: false,
    eligible_for_skill_export: false,
    provenance: args.provenance,
    runtime_evidence_ids: args.runtimeEvidenceIds ?? [],
    reasons: uniqueStrings(args.reasons),
    client_claims_ignored: {
      sufficient_evidence: args.parsed.comparison?.sufficient_evidence
        ?? args.parsed.product_trace?.sufficient_evidence
        ?? null,
      evidence_id_count: (args.parsed.evidence_ids?.length ?? 0)
        + (args.parsed.product_trace?.evidence_ids?.length ?? 0),
    },
  };
}

async function assessProductMeasureEvidence(args: {
  parsed: ProductMeasureInput;
  source: "manual_observations" | "product_trace";
  tenantId: string;
  scope: string;
  store: ProductMeasureEvidenceStore | null;
}): Promise<ProductMeasureEvidenceResolution> {
  if (args.source === "manual_observations") {
    return insufficientEvidenceAssessment({
      parsed: args.parsed,
      provenance: "manual_unverified",
      reasons: ["manual_observations_are_not_export_evidence"],
    });
  }
  const trace = args.parsed.product_trace;
  const runId = stringValue(args.parsed.task?.run_id);
  const beforeTraceId = snapshotGuideTraceId(trace?.before_guide);
  const afterTraceId = snapshotGuideTraceId(trace?.after_guide);
  const initialReasons = [
    ...(!args.store ? ["runtime_evidence_store_unavailable"] : []),
    ...(!trace?.before_guide ? ["before_guide_missing"] : []),
    ...(!beforeTraceId ? ["before_guide_receipt_id_missing"] : []),
    ...(!afterTraceId ? ["after_guide_receipt_id_missing"] : []),
    ...(beforeTraceId && afterTraceId && beforeTraceId === afterTraceId ? ["guide_receipts_must_be_distinct"] : []),
    ...(!runId ? ["task_run_id_missing"] : []),
  ];
  if (initialReasons.length > 0 || !args.store || !trace?.before_guide || !beforeTraceId || !afterTraceId || !runId) {
    return insufficientEvidenceAssessment({
      parsed: args.parsed,
      provenance: "unverified_product_trace",
      reasons: initialReasons,
    });
  }

  const [beforeReceipt, afterReceipt] = await Promise.all([
    resolveGuideReceipt({ store: args.store, tenantId: args.tenantId, scope: args.scope, guideTraceId: beforeTraceId }),
    resolveGuideReceipt({ store: args.store, tenantId: args.tenantId, scope: args.scope, guideTraceId: afterTraceId }),
  ]);
  const runtimeEvidenceIds = uniqueStrings([
    beforeReceipt?.evidence_id,
    afterReceipt?.evidence_id,
  ]);
  const reasons: string[] = [];
  if (!beforeReceipt) reasons.push("before_guide_receipt_not_verified");
  if (!afterReceipt) reasons.push("after_guide_receipt_not_verified");
  if (!beforeReceipt || !afterReceipt) {
    return insufficientEvidenceAssessment({
      parsed: args.parsed,
      provenance: "unverified_product_trace",
      reasons,
      runtimeEvidenceIds,
    });
  }

  if (beforeReceipt.ledger.run_id !== runId || afterReceipt.ledger.run_id !== runId) reasons.push("guide_receipt_run_mismatch");
  if (beforeReceipt.ledger.query_sha256 !== afterReceipt.ledger.query_sha256) reasons.push("guide_receipt_query_mismatch");
  if (beforeReceipt.ledger.context_sha256 !== afterReceipt.ledger.context_sha256) reasons.push("guide_receipt_context_mismatch");
  if (beforeReceipt.ledger.task_binding_sha256 !== afterReceipt.ledger.task_binding_sha256) reasons.push("guide_receipt_task_binding_mismatch");
  if (beforeReceipt.ledger.consumer_agent_id !== afterReceipt.ledger.consumer_agent_id) reasons.push("guide_receipt_consumer_mismatch");
  if (beforeReceipt.ledger.consumer_team_id !== afterReceipt.ledger.consumer_team_id) reasons.push("guide_receipt_team_mismatch");
  const beforeCreatedAt = Date.parse(beforeReceipt.created_at);
  const afterCreatedAt = Date.parse(afterReceipt.created_at);
  if (!Number.isFinite(beforeCreatedAt) || !Number.isFinite(afterCreatedAt) || beforeCreatedAt >= afterCreatedAt) {
    reasons.push("guide_receipts_not_strictly_ordered");
  }
  reasons.push(...snapshotReceiptMismatchReasons(trace.before_guide, beforeReceipt.ledger).map((entry) => `before:${entry}`));
  reasons.push(...snapshotReceiptMismatchReasons(trace.after_guide, afterReceipt.ledger).map((entry) => `after:${entry}`));
  if (!afterReceipt.ledger.actionable_history_used || afterReceipt.ledger.use_now_memory_ids.length === 0) {
    reasons.push("after_guide_has_no_actionable_runtime_history");
  }
  const beforeObservation = beforeReceipt.ledger.effect_observation_v1;
  const afterObservation = afterReceipt.ledger.effect_observation_v1;
  const beforeObservationValid = !!beforeObservation
    && !!beforeReceipt.ledger.effect_observation_sha256
    && sha256Hex(stableStringify(beforeObservation)) === beforeReceipt.ledger.effect_observation_sha256;
  const afterObservationValid = !!afterObservation
    && !!afterReceipt.ledger.effect_observation_sha256
    && sha256Hex(stableStringify(afterObservation)) === afterReceipt.ledger.effect_observation_sha256;
  if (!beforeObservationValid) reasons.push("before_effect_observation_digest_mismatch");
  if (!afterObservationValid) reasons.push("after_effect_observation_digest_mismatch");
  const toolSelection = afterReceipt.ledger.tool_selection;
  if (!toolSelection || toolSelection.run_id !== runId) reasons.push("after_guide_tool_selection_receipt_missing");

  const runtimeVerification = afterReceipt.ledger.runtime_verification_v1;
  if (!runtimeVerification) {
    reasons.push("trusted_runtime_verification_receipt_missing");
  } else {
    if (runtimeVerification.execution_state !== "executed") reasons.push("runtime_verification_not_fully_executed");
    if (runtimeVerification.result_count <= 0 || runtimeVerification.verifier_ids.length === 0) {
      reasons.push("runtime_verification_result_missing");
    }
    if (!runtimeVerification.authoritative_evidence_ready || !runtimeVerification.validation_passed) {
      reasons.push("runtime_verification_not_passed");
    }
    if (runtimeVerification.validation_boundary !== "runtime_orchestrator") {
      reasons.push("runtime_verification_boundary_untrusted");
    }
    if (runtimeVerification.false_confidence_detected) reasons.push("runtime_verification_false_confidence_detected");
    if (runtimeVerification.run_id !== runId) reasons.push("runtime_verification_run_binding_mismatch");
    runtimeEvidenceIds.push(`runtime_verification:${afterReceipt.ledger.guide_trace_id}:${runtimeVerification.surface_sha256}`);
  }

  const feedback = await args.store.listRuleFeedbackByRun({ scope: args.scope, runId, limit: 200 });
  const positiveFeedback = toolSelection
    ? feedback.rows.find((row) =>
        row.outcome === "positive"
        && row.source === "tools_feedback"
        && row.decision_id === toolSelection.decision_id
      )
    : null;
  if (!positiveFeedback) reasons.push("positive_linked_tool_feedback_missing");
  if (feedback.negative > 0) reasons.push("negative_feedback_present_for_run");
  if (positiveFeedback) {
    const feedbackCreatedAt = Date.parse(positiveFeedback.created_at);
    if (!Number.isFinite(feedbackCreatedAt) || !Number.isFinite(afterCreatedAt) || feedbackCreatedAt <= afterCreatedAt) {
      reasons.push("tool_feedback_not_after_guide_receipt");
    }
  }

  const verifiedKernelReport = beforeObservationValid && afterObservationValid && beforeObservation && afterObservation
    ? evaluateAionisEffect({
        baseline: beforeObservation,
        aionis: afterObservation,
        minEffectDelta: PRODUCT_SKILL_EXPORT_MIN_EFFECT_DELTA,
        minAionisScore: PRODUCT_SKILL_EXPORT_MIN_AIONIS_SCORE,
      })
    : null;
  const incompleteKernels = verifiedKernelReport?.kernel_scores.filter((score) =>
    score.metrics.measurement_complete !== true
    || score.regressions.some((entry) => entry.startsWith("missing_metric:") || entry.startsWith("unknown_ratio:"))
  ) ?? [];
  if (!verifiedKernelReport || incompleteKernels.length > 0) {
    reasons.push(...incompleteKernels.map((score) => `incomplete_kernel:${score.capability_id}`));
  }
  if (!verifiedKernelReport || verifiedKernelReport.status !== "pass") reasons.push("effect_evaluator_not_passed");

  if (reasons.length > 0) {
    return {
      ...insufficientEvidenceAssessment({
      parsed: args.parsed,
      provenance: "unverified_product_trace",
      reasons,
      runtimeEvidenceIds,
      }),
      ...(verifiedKernelReport && beforeObservation && afterObservation ? {
        verified_observations: {
          baseline: beforeObservation,
          aionis: afterObservation,
        },
        verified_kernel_report: verifiedKernelReport,
      } : {}),
    };
  }
  return {
    status: "sufficient",
    sufficient_evidence: true,
    eligible_for_skill_export: true,
    provenance: "runtime_verified",
    runtime_evidence_ids: uniqueStrings(runtimeEvidenceIds),
    reasons: ["paired_runtime_guide_receipts_and_runtime_verifier_receipt_verified"],
    client_claims_ignored: {
      sufficient_evidence: args.parsed.comparison?.sufficient_evidence
        ?? args.parsed.product_trace?.sufficient_evidence
        ?? null,
      evidence_id_count: (args.parsed.evidence_ids?.length ?? 0)
        + (args.parsed.product_trace?.evidence_ids?.length ?? 0),
    },
    verified_observations: {
      baseline: beforeObservation!,
      aionis: afterObservation!,
    },
    verified_kernel_report: verifiedKernelReport ?? undefined,
  };
}

function productSkillCandidateReviewResponse(args: {
  route: string;
  tenantId: string;
  scope: string;
  rows: unknown[];
  inserted?: number;
  updated?: number;
}) {
  return {
    contract_version: "aionis_trace_derived_skill_review_result_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    candidates: args.rows,
    candidate_count: args.rows.length,
    inserted_count: args.inserted ?? undefined,
    updated_count: args.updated ?? undefined,
    safety: {
      agent_prompt_included: false,
      memory_runtime_mutation: false,
      required_gate: "admission_and_promotion_gate",
    },
    source_map: {
      routes_used: [args.route],
      internal_surfaces_used: ["trace_derived_skill_candidate_review"],
      omitted_internal_surfaces: [
        "agent_prompt_text",
        "raw_memory_rows",
        "raw_slots",
        "raw_embedding_vectors",
      ],
    },
  };
}

function productTraceDerivedProcedureSummary(row: SkillCandidateReviewRow): string {
  return compactProductPromptText([
    `Procedure: ${row.procedure_steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`,
    `Reviewed procedure candidate: ${row.skill_name}.`,
    row.acceptance_checks.length > 0 ? `Acceptance checks: ${row.acceptance_checks.join("; ")}.` : null,
    row.applies_when.length > 0 ? `Applies when: ${row.applies_when.join("; ")}.` : null,
    row.does_not_apply_when.length > 0 ? `Do not apply when: ${row.does_not_apply_when.join("; ")}.` : null,
    row.failure_counterexamples.length > 0 ? `Counterexamples: ${row.failure_counterexamples.join("; ")}.` : null,
  ].filter((entry): entry is string => !!entry).join("\n"), 4096);
}

function productTraceDerivedProcedureTitle(skillName: string): string {
  return compactProductPromptText(`Reviewed procedure: ${skillName}`, 200);
}

function productTraceDerivedSkillProcedureDraft(row: SkillCandidateReviewRow): AionisProcedureMemoryDraftV1 {
  return AionisProcedureMemoryDraftV1Schema.parse({
    contract_version: "aionis_procedure_memory_draft_v1",
    source_candidate_id: row.candidate_id,
    source: "trace_derived_skill",
    memory_kind: "procedure",
    authority_state: "reviewed_candidate",
    skill_name: row.skill_name,
    title: productTraceDerivedProcedureTitle(row.skill_name),
    summary: productTraceDerivedProcedureSummary(row),
    source_trace_ids: row.source_trace_ids,
    source_signal_ids: row.source_signal_ids,
    applies_when: row.applies_when,
    does_not_apply_when: row.does_not_apply_when,
    procedure_steps: row.procedure_steps,
    target_files: row.target_files,
    acceptance_checks: row.acceptance_checks,
    failure_counterexamples: row.failure_counterexamples,
    evidence_refs: row.evidence_refs,
    review: {
      review_status: "promoted",
      reviewer_id: row.reviewer_id,
      review_reason: row.review_reason,
      reviewed_at: row.reviewed_at,
      candidate_reason: compactProductPromptText(row.reason, 2048),
      label: row.label,
      promotion_status: "promotion_ready",
      export_ready: true,
    },
    write_policy: {
      requires_observe_commit: true,
      agent_prompt_included: false,
      runtime_mutation: false,
      required_gate: "observe_commit_and_admission_gate",
    },
  });
}

function productTraceDerivedSkillObservePayload(args: {
  tenantId: string;
  scope: string;
  draft: AionisProcedureMemoryDraftV1;
}): Record<string, unknown> {
  const taskSignature = `trace_derived_skill:${sha256Hex(args.draft.skill_name).slice(0, 16)}`;
  const workflowSignature = `trace_derived_skill:${args.draft.source_candidate_id}`;
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    auto_embed: true,
    memory_kind: "execution_workflow",
    input_text: args.draft.summary,
    execution: {
      client_id: `trace-derived-skill:${args.draft.source_candidate_id}`,
      task_family: "trace_derived_skill",
      task_signature: taskSignature,
      workflow_signature: workflowSignature,
      title: args.draft.title,
      summary: args.draft.summary,
      workflow_steps: args.draft.procedure_steps,
      target_files: args.draft.target_files,
      acceptance_checks: args.draft.acceptance_checks,
      continuation_hint: args.draft.procedure_steps[0],
      confidence: 0.72,
      evidence_ref: args.draft.evidence_refs[0] ?? args.draft.source_trace_ids[0],
      raw_ref: args.draft.source_candidate_id,
      slots: {
        contract_trust: "advisory",
        summary_kind: "reviewed_procedure",
        compression_layer: "L2",
        target_files: args.draft.target_files,
        workflow_steps: args.draft.procedure_steps,
        next_action: args.draft.procedure_steps[0] ?? null,
        execution_native_v1: {
          schema_version: "execution_native_v1",
          execution_kind: "workflow_anchor",
          execution_outcome_role: "passed_solution",
          summary_kind: "reviewed_procedure",
          compression_layer: "L2",
          contract_trust: "advisory",
          task_family: "trace_derived_skill",
          task_signature: taskSignature,
          workflow_signature: workflowSignature,
          anchor_kind: "workflow",
          anchor_level: "L2",
          target_files: args.draft.target_files,
          next_action: args.draft.procedure_steps[0] ?? null,
          workflow_steps: args.draft.procedure_steps,
          rehydration: {
            default_mode: "summary_only",
            payload_cost_hint: "low",
            recommended_when: [],
          },
        },
        trace_derived_skill_memory_v1: {
          contract_version: "trace_derived_skill_memory_v1",
          source_candidate_id: args.draft.source_candidate_id,
          skill_name: args.draft.skill_name,
          source_trace_ids: args.draft.source_trace_ids,
          source_signal_ids: args.draft.source_signal_ids,
          applies_when: args.draft.applies_when,
          does_not_apply_when: args.draft.does_not_apply_when,
          failure_counterexamples: args.draft.failure_counterexamples,
          evidence_refs: args.draft.evidence_refs,
          reviewed_at: args.draft.review.reviewed_at,
        },
        applies_when: args.draft.applies_when,
        does_not_apply_when: args.draft.does_not_apply_when,
        failure_counterexamples: args.draft.failure_counterexamples,
        evidence_refs: args.draft.evidence_refs,
        source_trace_ids: args.draft.source_trace_ids,
        source_signal_ids: args.draft.source_signal_ids,
      },
    },
  };
}

function productSkillCandidateMaterializeResponse(args: {
  tenantId: string;
  scope: string;
  candidateId: string;
  draft: AionisProcedureMemoryDraftV1;
  observePayload: Record<string, unknown>;
}) {
  return {
    contract_version: "aionis_skill_candidate_materialize_result_v1",
    tenant_id: args.tenantId,
    scope: args.scope,
    candidate_id: args.candidateId,
    draft: args.draft,
    recommended_observe_payload: args.observePayload,
    safety: {
      agent_prompt_included: false,
      memory_runtime_mutation: false,
      requires_observe_commit: true,
      required_gate: "observe_commit_and_admission_gate",
    },
    source_map: {
      routes_used: ["/v1/skills/candidates/:id/materialize"],
      internal_surfaces_used: [
        "trace_derived_skill_candidate_review",
        "procedure_memory_draft",
        "recommended_observe_payload",
      ],
      omitted_internal_surfaces: [
        "memory_write",
        "agent_prompt_text",
        "raw_memory_rows",
        "raw_embedding_vectors",
      ],
    },
  };
}

async function validateCandidateMeasurementBinding(args: {
  access: SkillCandidateReviewAccess;
  row: SkillCandidateReviewRow;
}): Promise<{ ok: true; measurement: ProductMeasurementRecord } | { ok: false; reason: string }> {
  if (!args.row.measurement_id || !args.row.measurement_digest) {
    return { ok: false, reason: "candidate_has_no_persisted_measurement" };
  }
  if (!args.row.eligible_for_promotion) {
    return { ok: false, reason: "candidate_is_not_eligible_for_promotion" };
  }
  const measurement = await args.access.getMeasurement({
    tenantId: args.row.tenant_id,
    scope: args.row.scope,
    measurementId: args.row.measurement_id,
  });
  if (!measurement) return { ok: false, reason: "measurement_record_not_found" };
  if (measurement.measurement_digest !== args.row.measurement_digest) {
    return { ok: false, reason: "measurement_digest_mismatch" };
  }
  if (productMeasurementDigest(measurement) !== measurement.measurement_digest) {
    return { ok: false, reason: "measurement_record_digest_invalid" };
  }
  if (!measurement.eligible_for_skill_export || measurement.evidence_status !== "sufficient") {
    return { ok: false, reason: "measurement_is_not_export_eligible" };
  }
  if (stableJsonDigest(args.row.candidate) !== args.row.candidate_digest) {
    return { ok: false, reason: "candidate_digest_mismatch" };
  }
  const authoritativeCandidate = productTraceDerivedSkillCandidates(measurement.effect_report)
    .some((candidate) => stableJsonDigest(candidate) === args.row.candidate_digest);
  if (!authoritativeCandidate) return { ok: false, reason: "candidate_not_present_in_measurement" };
  if (
    args.row.label !== "positive"
    || !args.row.export_ready
    || args.row.promotion_status !== "promotion_ready"
  ) {
    return { ok: false, reason: "candidate_is_not_export_ready_positive_evidence" };
  }
  return { ok: true, measurement };
}

export type ProductMeasureServiceDependencies = {
  defaultTenantId: string;
  defaultScope: string;
  skillCandidateReviewAccess?: SkillCandidateReviewAccess | null;
  runtimeEvidenceStore?: ProductMeasureEvidenceStore | null;
};

export function createProductMeasureService(
  dependencies: ProductMeasureServiceDependencies,
): ProductServices["measure"] {
  const access = dependencies.skillCandidateReviewAccess ?? null;
  return {
    async execute(parsed: ProductMeasureRequestInput, context): Promise<ProductServiceResult> {
      try {
        const measureInput = productMeasureInputs(parsed);
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
        const evidenceResolution = await assessProductMeasureEvidence({
          parsed,
          source: measureInput.source,
          tenantId,
          scope,
          store: asProductMeasureEvidenceStore(dependencies.runtimeEvidenceStore),
        });
        const evaluationBaseline = evidenceResolution.verified_observations?.baseline ?? measureInput.baseline;
        const evaluationAionis = evidenceResolution.verified_observations?.aionis ?? measureInput.aionis;
        const kernelReport = evidenceResolution.verified_kernel_report ?? evaluateAionisEffect({
          baseline: evaluationBaseline,
          aionis: evaluationAionis,
          minEffectDelta: PRODUCT_SKILL_EXPORT_MIN_EFFECT_DELTA,
          minAionisScore: PRODUCT_SKILL_EXPORT_MIN_AIONIS_SCORE,
        });
        const {
          verified_observations: _verifiedObservations,
          verified_kernel_report: _verifiedKernelReport,
          ...evidenceAssessment
        } = evidenceResolution;
        const decisionOutputs = parsed.product_trace
          ? productMemoryDecisionOutputs({
              tenant_id: tenantId,
              scope,
              trace: parsed.product_trace,
              routes_used: ["/v1/measure"],
            })
          : null;
        const effectReport = buildAionisEffectReport({
          tenant_id: tenantId,
          scope,
          task: parsed.task,
          report: kernelReport,
          comparison: {
            ...(measureInput.comparison ?? {}),
            sufficient_evidence: evidenceAssessment.sufficient_evidence,
          },
          evidence_ids: evidenceAssessment.runtime_evidence_ids,
          feedback_signal_review: decisionOutputs?.memoryDecisionAudit.feedback_signal_review ?? null,
        });
        const parsedEffectReport = AionisEffectReportSchema.parse(effectReport);
        const measurementId = `measurement:${randomUUID()}`;
        const measurementRecordWithoutDigest = {
          measurement_id: measurementId,
          tenant_id: tenantId,
          scope,
          source: measureInput.source,
          effect_report: parsedEffectReport,
          eligible_for_skill_export: evidenceAssessment.eligible_for_skill_export,
          evidence_status: evidenceAssessment.status,
          runtime_evidence_ids: evidenceAssessment.runtime_evidence_ids,
          eligibility_reasons: evidenceAssessment.reasons,
          created_by: context.actorId,
          created_at: new Date().toISOString(),
        };
        const measurementDigest = productMeasurementDigest(measurementRecordWithoutDigest);
        const measurementRecord: ProductMeasurementRecord = {
          ...measurementRecordWithoutDigest,
          measurement_digest: measurementDigest,
        };
        let measurementPersisted = false;
        if (access) {
          await access.recordMeasurement({ record: measurementRecord });
          measurementPersisted = true;
        }
        return productServiceSuccess({
          contract_version: "aionis_measure_result_v1",
          tenant_id: tenantId,
          scope,
          measurement_id: measurementId,
          measurement_digest: measurementDigest,
          measurement_persisted: measurementPersisted,
          evidence_assessment: evidenceAssessment,
          measurement_input: {
            source: measureInput.source,
            baseline: evaluationBaseline,
            aionis: evaluationAionis,
          },
          effect_report: parsedEffectReport,
          ...(decisionOutputs ? {
            memory_decision_trace: decisionOutputs.memoryDecisionTrace,
            memory_decision_audit: decisionOutputs.memoryDecisionAudit,
          } : {}),
          kernel_report: kernelReport,
          source_map: {
            routes_used: ["/v1/measure"],
            internal_surfaces_used: [
              ...(measureInput.source === "product_trace" ? ["product_trace_projection"] : []),
              ...(decisionOutputs
                ? ["memory_decision_trace", "memory_use_receipt", "memory_admission_record", "memory_decision_audit_report"]
                : []),
              "effect_evaluator",
              "product_effect_report",
            ],
          },
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async enqueueSkillCandidates(parsed: ProductSkillCandidateEnqueueInput) {
      if (!access) {
        return productServiceFailure({
          statusCode: 503,
          error: "skill_candidate_review_unavailable",
          message: "trace-derived skill candidate review store is not available for this Runtime",
        });
      }
      try {
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
        const measurementId = parsed.measurement_id ?? parsed.measure_result?.measurement_id;
        if (!measurementId) {
          return productServiceFailure({
            statusCode: 400,
            error: "measurement_id_required",
            message: "a persisted Runtime measurement_id is required to enqueue skill candidates",
          });
        }
        const measurement = await access.getMeasurement({ tenantId, scope, measurementId });
        if (!measurement) {
          return productServiceFailure({
            statusCode: 404,
            error: "measurement_not_found",
            message: "measurement_id does not resolve to a persisted Runtime measurement in this tenant/scope",
            details: { measurement_id: measurementId },
          });
        }
        if (
          parsed.measure_result
          && parsed.measure_result.measurement_digest !== measurement.measurement_digest
        ) {
          return productServiceFailure({
            statusCode: 409,
            error: "measurement_digest_mismatch",
            message: "measure_result does not match the persisted Runtime measurement",
            details: { measurement_id: measurementId },
          });
        }
        const suppliedReport = objectValue(parsed.measure_result)?.effect_report;
        if (
          suppliedReport !== undefined
          && stableJsonDigest(suppliedReport) !== stableJsonDigest(measurement.effect_report)
        ) {
          return productServiceFailure({
            statusCode: 409,
            error: "measurement_report_tampered",
            message: "measure_result.effect_report differs from the persisted Runtime measurement",
            details: { measurement_id: measurementId },
          });
        }
        if (
          productMeasurementDigest(measurement) !== measurement.measurement_digest
          || !measurement.eligible_for_skill_export
          || measurement.evidence_status !== "sufficient"
        ) {
          return productServiceFailure({
            statusCode: 409,
            error: "measurement_not_skill_export_eligible",
            message: "the persisted measurement does not contain sufficient Runtime-owned outcome evidence",
            details: {
              measurement_id: measurementId,
              evidence_status: measurement.evidence_status,
              eligibility_reasons: measurement.eligibility_reasons,
            },
          });
        }
        const candidates = productTraceDerivedSkillCandidates(measurement.effect_report);
        const queued = await access.enqueueTraceDerivedSkillCandidates({
          tenantId,
          scope,
          candidates,
          measurementId,
          measurementDigest: measurement.measurement_digest,
          eligibleForPromotion: true,
        });
        return productServiceSuccess(productSkillCandidateReviewResponse({
          route: "/v1/skills/candidates",
          tenantId,
          scope,
          rows: queued.rows,
          inserted: queued.inserted,
          updated: queued.updated,
        }));
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async listSkillCandidates(parsed) {
      if (!access) {
        return productServiceFailure({
          statusCode: 503,
          error: "skill_candidate_review_unavailable",
          message: "trace-derived skill candidate review store is not available for this Runtime",
        });
      }
      try {
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
        const listed = await access.listTraceDerivedSkillCandidates({
          tenantId,
          scope,
          reviewStatus: parsed.status as SkillCandidateReviewStatus | "all",
          limit: parsed.limit,
        });
        return productServiceSuccess(productSkillCandidateReviewResponse({
          route: "/v1/skills/candidates",
          tenantId,
          scope,
          rows: listed.rows,
        }));
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async reviewSkillCandidate(args) {
      if (!access) {
        return productServiceFailure({
          statusCode: 503,
          error: "skill_candidate_review_unavailable",
          message: "trace-derived skill candidate review store is not available for this Runtime",
        });
      }
      try {
        const tenantId = args.input.tenant_id ?? dependencies.defaultTenantId;
        const scope = args.input.scope ?? dependencies.defaultScope;
        const current = await access.getTraceDerivedSkillCandidate({
          tenantId,
          scope,
          candidateId: args.candidateId,
        });
        if (!current) {
          return productServiceFailure({
            statusCode: 404,
            error: "skill_candidate_not_found",
            message: "trace-derived skill candidate was not found in this tenant/scope",
            details: { candidate_id: args.candidateId },
          });
        }
        if (current.review_status !== "pending_review") {
          return productServiceFailure({
            statusCode: 409,
            error: "skill_candidate_state_conflict",
            message: "trace-derived skill candidate is no longer pending review",
            details: {
              candidate_id: args.candidateId,
              review_status: current.review_status,
              row_version: current.row_version,
            },
          });
        }
        if (args.reviewStatus === "promoted") {
          const binding = await validateCandidateMeasurementBinding({ access, row: current });
          if (!binding.ok) {
            return productServiceFailure({
              statusCode: 409,
              error: "skill_candidate_ineligible",
              message: "trace-derived skill candidate is not backed by an eligible persisted Runtime measurement",
              details: { candidate_id: args.candidateId, reason: binding.reason },
            });
          }
        }
        const row = await access.reviewTraceDerivedSkillCandidate({
          tenantId,
          scope,
          candidateId: args.candidateId,
          reviewStatus: args.reviewStatus,
          reviewerId: args.reviewerId,
          reason: args.input.reason,
          expectedVersion: current.row_version,
        });
        if (!row) {
          return productServiceFailure({
            statusCode: 409,
            error: "skill_candidate_state_conflict",
            message: "trace-derived skill candidate changed while the review was being recorded",
            details: { candidate_id: args.candidateId, expected_version: current.row_version },
          });
        }
        return productServiceSuccess(productSkillCandidateReviewResponse({
          route: args.route,
          tenantId,
          scope,
          rows: [row],
        }));
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },

    async materializeSkillCandidate(args) {
      if (!access) {
        return productServiceFailure({
          statusCode: 503,
          error: "skill_candidate_review_unavailable",
          message: "trace-derived skill candidate review store is not available for this Runtime",
        });
      }
      try {
        const tenantId = args.input.tenant_id ?? dependencies.defaultTenantId;
        const scope = args.input.scope ?? dependencies.defaultScope;
        const row = await access.getTraceDerivedSkillCandidate({
          tenantId,
          scope,
          candidateId: args.candidateId,
        });
        if (!row) {
          return productServiceFailure({
            statusCode: 404,
            error: "skill_candidate_not_found",
            message: "trace-derived skill candidate was not found in this tenant/scope",
            details: { candidate_id: args.candidateId },
          });
        }
        if (row.review_status !== "promoted") {
          return productServiceFailure({
            statusCode: 409,
            error: "skill_candidate_not_promoted",
            message: "trace-derived skill candidate must be promoted before materialization",
            details: { candidate_id: args.candidateId, review_status: row.review_status },
          });
        }
        const binding = await validateCandidateMeasurementBinding({ access, row });
        if (!binding.ok) {
          return productServiceFailure({
            statusCode: 409,
            error: "skill_candidate_not_materializable",
            message: "trace-derived skill candidate is no longer backed by eligible persisted Runtime evidence",
            details: {
              candidate_id: args.candidateId,
              reason: binding.reason,
            },
          });
        }
        const draft = productTraceDerivedSkillProcedureDraft(row);
        const observePayload = productTraceDerivedSkillObservePayload({ tenantId, scope, draft });
        return productServiceSuccess(productSkillCandidateMaterializeResponse({
          tenantId,
          scope,
          candidateId: args.candidateId,
          draft,
          observePayload,
        }));
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
