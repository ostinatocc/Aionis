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
  EffectMeasuredV1Schema,
  type EventWithoutDigest,
  type FreshEffectMeasuredV1,
} from "../memory/learning-episode-ledger.js";
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
import {
  productMeasurementDigest,
  productMeasurementRecordDigest,
  stableJsonDigest,
} from "../store/memory-store.js";
import {
  buildLiteMeasurementEffectEventRow,
  type LiteLearningEpisodeLedgerAccess,
  type LiteLearningMeasurementEpisodePairAvailable,
  type LiteLearningMeasurementEpisodePairResolution,
  type LiteLearningProtectedToolFeedbackAuthorityResolution,
} from "../store/lite-learning-episode-ledger.js";
import { effectExpectedV1EvidenceReference } from "../store/lite-learning-measurement-authority.js";
import {
  PRODUCT_MEASURE_OPERATION_KIND,
  PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
  assertProductMeasureReceiptAuthority,
  assertProductMeasureResultMatchesMeasurement,
  buildProductMeasureReceiptAuthority,
  productMeasureOperationEvidenceReference,
  type LiteProductMeasureOperationRecord,
} from "../store/lite-product-measurement-record.js";
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
import { HttpError } from "../util/http.js";
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
  "getProductGuideReceipt"
>;

type ProductMeasureAtomicWrite = Pick<
  LiteWriteStore,
  "withTx" | "getWriteOperation" | "insertWriteOperation" | "transactionRunner"
>;

const PRODUCT_MEASURE_OPERATION_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;

type ProductMeasureOperationIdentity = Readonly<{
  tenantId: string;
  scope: string;
  operationId: string;
  requestSha256: string;
}>;

function asProductMeasureAtomicWrite(
  value: ProductMeasureAtomicWrite | null | undefined,
): ProductMeasureAtomicWrite | null {
  if (!value) return null;
  return typeof value.withTx === "function"
    && typeof value.getWriteOperation === "function"
    && typeof value.insertWriteOperation === "function"
    && typeof value.transactionRunner === "function"
    ? value
    : null;
}

function productMeasureOperationIdentity(args: {
  parsed: ProductMeasureInput;
  tenantId: string;
  scope: string;
  actorId: string;
}): ProductMeasureOperationIdentity | null {
  if (!args.parsed.operation_id) return null;
  const normalizedRequest: Record<string, unknown> = {
    ...args.parsed,
    tenant_id: args.tenantId,
    scope: args.scope,
    runtime_actor_id: args.actorId,
  };
  delete normalizedRequest.operation_id;
  return {
    tenantId: args.tenantId,
    scope: args.scope,
    operationId: args.parsed.operation_id,
    requestSha256: sha256Hex(stableStringify(normalizedRequest)),
  };
}

function assertProductMeasureOperationMatches(args: {
  identity: ProductMeasureOperationIdentity;
  storedRequestSha256: string;
}): void {
  if (args.identity.requestSha256 === args.storedRequestSha256) return;
  throw new HttpError(
    409,
    "measure_operation_id_conflict",
    "operation_id was already used for a different measure request",
    { operation_id: args.identity.operationId },
  );
}

function parseStoredProductMeasureOperationResult(args: {
  identity: ProductMeasureOperationIdentity;
  receiptJson: string;
}): ProductServiceResult {
  if (Buffer.byteLength(args.receiptJson, "utf8") > PRODUCT_MEASURE_OPERATION_RECEIPT_MAX_BYTES) {
    throw new HttpError(500, "protected_measure_receipt_invalid", "stored protected measure receipt is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.receiptJson);
  } catch {
    throw new HttpError(500, "protected_measure_receipt_invalid", "stored protected measure receipt is invalid");
  }
  if (stableStringify(parsed) !== args.receiptJson) {
    throw new HttpError(500, "protected_measure_receipt_invalid", "stored protected measure receipt is not canonical");
  }
  const result = objectValue(parsed);
  const body = objectValue(result?.body);
  if (
    result?.ok !== true
    || result.statusCode !== 200
    || body?.contract_version !== "aionis_measure_result_v1"
    || body.operation_id !== args.identity.operationId
    || body.tenant_id !== args.identity.tenantId
    || body.scope !== args.identity.scope
    || typeof body.measurement_id !== "string"
    || !/^[0-9a-f]{64}$/u.test(String(body.measurement_digest ?? ""))
  ) {
    throw new HttpError(500, "protected_measure_receipt_invalid", "stored protected measure receipt is invalid");
  }
  return parsed as ProductServiceResult;
}

async function assertStoredProductMeasureOperationAuthority(args: Readonly<{
  result: ProductServiceResult;
  identity: ProductMeasureOperationIdentity;
  originalOperation: LiteProductMeasureOperationRecord;
  atomicWrite: ProductMeasureAtomicWrite;
  access: SkillCandidateReviewAccess;
  ledger: LiteLearningEpisodeLedgerAccess | null;
}>): Promise<void> {
  try {
    const result = objectValue(args.result);
    const body = objectValue(result?.body);
    const measurementId = stringValue(body?.measurement_id);
    if (!measurementId) throw new Error("protected measure receipt has no measurement id");
    const measurement = await args.access.getMeasurement({
      tenantId: args.identity.tenantId,
      scope: args.identity.scope,
      measurementId,
    });
    if (!measurement) throw new Error("protected measure receipt measurement is missing");
    assertProductMeasureResultMatchesMeasurement({
      result: args.result,
      operationId: args.identity.operationId,
      measurement,
    });
    const measurementInput = objectValue(body?.measurement_input);
    const baseline = objectValue(measurementInput?.baseline);
    const aionis = objectValue(measurementInput?.aionis);
    if (!baseline || !aionis) throw new Error("protected measure receipt observations are invalid");
    const expectedKernelReport = evaluateAionisEffect({
      baseline: baseline as AionisEffectObservation,
      aionis: aionis as AionisEffectObservation,
      minEffectDelta: PRODUCT_SKILL_EXPORT_MIN_EFFECT_DELTA,
      minAionisScore: PRODUCT_SKILL_EXPORT_MIN_AIONIS_SCORE,
    });
    if (stableStringify(body?.kernel_report) !== stableStringify(expectedKernelReport)) {
      throw new Error("protected measure receipt kernel report was modified");
    }
    const authorityOperation = await args.atomicWrite.getWriteOperation({
      tenantId: args.identity.tenantId,
      scope: args.identity.scope,
      operationKind: PRODUCT_MEASURE_RECEIPT_AUTHORITY_OPERATION_KIND,
      operationId: args.identity.operationId,
    });
    assertProductMeasureReceiptAuthority({
      originalOperation: args.originalOperation,
      authorityOperation,
      measurement,
      expectedRequestSha256: args.identity.requestSha256,
    });
    if (args.ledger) {
      await args.ledger.assertMeasurementOperationReceiptAuthority({
        tenantId: args.identity.tenantId,
        scope: args.identity.scope,
        measurementId,
        operationId: args.identity.operationId,
        operationReceiptSha256: sha256Hex(args.originalOperation.receipt_json),
      });
    }
  } catch {
    throw new HttpError(
      500,
      "protected_measure_receipt_invalid",
      "stored protected measure receipt does not match its immutable Runtime authority",
    );
  }
}

function asProductMeasureEvidenceStore(value: ProductMeasureEvidenceStore | null | undefined): ProductMeasureEvidenceStore | null {
  if (!value) return null;
  return typeof value.getProductGuideReceipt === "function"
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
  verified_receipt_run_id?: string;
  verified_tool_feedback_binding?: Readonly<{
    guideTraceId: string;
    runId: string;
    decisionId: string;
  }>;
};

type ProductMeasureEpisodeBinding = Readonly<{
  pair: LiteLearningMeasurementEpisodePairAvailable | null;
  toolFeedbackAuthority: LiteLearningProtectedToolFeedbackAuthorityResolution | null;
  reasons: string[];
}>;

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
    || ledger.run_id !== row.run_id
    || ledger.consumer_agent_id !== row.consumer_agent_id
    || ledger.consumer_team_id !== row.consumer_team_id
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
  const claimedRunId = stringValue(args.parsed.task?.run_id);
  const beforeTraceId = snapshotGuideTraceId(trace?.before_guide);
  const afterTraceId = snapshotGuideTraceId(trace?.after_guide);
  const initialReasons = [
    ...(!args.store ? ["runtime_evidence_store_unavailable"] : []),
    ...(!trace?.before_guide ? ["before_guide_missing"] : []),
    ...(!beforeTraceId ? ["before_guide_receipt_id_missing"] : []),
    ...(!afterTraceId ? ["after_guide_receipt_id_missing"] : []),
    ...(beforeTraceId && afterTraceId && beforeTraceId === afterTraceId ? ["guide_receipts_must_be_distinct"] : []),
  ];
  if (initialReasons.length > 0 || !args.store || !trace?.before_guide || !beforeTraceId || !afterTraceId) {
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

  const receiptRunId = beforeReceipt.ledger.run_id === afterReceipt.ledger.run_id
    ? beforeReceipt.ledger.run_id
    : null;
  const runId = claimedRunId ?? receiptRunId;
  if (!receiptRunId || (claimedRunId !== null && claimedRunId !== receiptRunId)) {
    reasons.push("guide_receipt_run_mismatch");
  }
  if (!runId) {
    return insufficientEvidenceAssessment({
      parsed: args.parsed,
      provenance: "unverified_product_trace",
      reasons: [...reasons, "guide_receipt_run_missing"],
      runtimeEvidenceIds,
    });
  }
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
  const verifiedToolFeedbackBinding = toolSelection?.run_id === runId
    ? {
        guideTraceId: afterReceipt.ledger.guide_trace_id,
        runId,
        decisionId: toolSelection.decision_id,
      }
    : undefined;

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
      ...(receiptRunId ? { verified_receipt_run_id: receiptRunId } : {}),
      ...(verifiedToolFeedbackBinding
        ? { verified_tool_feedback_binding: verifiedToolFeedbackBinding }
        : {}),
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
    verified_receipt_run_id: receiptRunId ?? undefined,
    verified_tool_feedback_binding: verifiedToolFeedbackBinding,
  };
}

type ClaimedGuideEpisodeIdentity =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "available"; guideTraceId: string; episodeId: string }>;

function claimedGuideEpisodeIdentity(
  snapshot: ProductMeasureGuideSnapshot | undefined,
): ClaimedGuideEpisodeIdentity {
  const snapshotRecord = objectValue(snapshot);
  if (!snapshotRecord || !("feedback_attribution_v1" in snapshotRecord)) return { status: "absent" };
  const attribution = objectValue(snapshotRecord.feedback_attribution_v1);
  if (attribution?.status !== "available") return { status: "invalid" };
  const guideTraceId = stringValue(attribution.guide_trace_id);
  const episodeId = stringValue(attribution.episode_id);
  return guideTraceId && episodeId
    ? { status: "available", guideTraceId, episodeId }
    : { status: "invalid" };
}

function measurementTaskIdentityMismatchReasons(
  task: ProductMeasureInput["task"],
  pair: LiteLearningMeasurementEpisodePairAvailable,
): string[] {
  const envelope = pair.after.hostTaskEnvelope;
  if (!task || !envelope) return [];
  return [
    task.run_id !== undefined && task.run_id !== null && task.run_id !== pair.after.runId
      ? "measurement_task_run_id_mismatch" : null,
    task.task_id !== undefined && task.task_id !== null && task.task_id !== envelope.host_task_id
      ? "measurement_task_id_mismatch" : null,
    task.task_signature !== undefined && task.task_signature !== null
      && task.task_signature !== envelope.task_signature
      ? "measurement_task_signature_mismatch" : null,
    task.task_family !== undefined && task.task_family !== null
      && task.task_family !== envelope.task_family
      ? "measurement_task_family_mismatch" : null,
  ].filter((reason): reason is string => reason !== null);
}

function productMeasureReportTask(args: {
  parsedTask: ProductMeasureInput["task"];
  source: "manual_observations" | "product_trace";
  pair: LiteLearningMeasurementEpisodePairAvailable | null;
}): ProductMeasureInput["task"] {
  if (args.source === "manual_observations" || !args.pair) return args.parsedTask;
  const envelope = args.pair.after.hostTaskEnvelope;
  return {
    task_id: envelope?.host_task_id ?? null,
    run_id: args.pair.after.runId,
    task_signature: envelope?.task_signature ?? null,
    task_family: envelope?.task_family ?? null,
    workflow_signature: null,
  };
}

async function resolveProductMeasureEpisodeBinding(args: {
  parsed: ProductMeasureInput;
  source: "manual_observations" | "product_trace";
  tenantId: string;
  scope: string;
  ledger: LiteLearningEpisodeLedgerAccess | null;
  verifiedReceiptRunId: ProductMeasureEvidenceResolution["verified_receipt_run_id"];
  toolFeedbackBinding: ProductMeasureEvidenceResolution["verified_tool_feedback_binding"];
}): Promise<ProductMeasureEpisodeBinding> {
  if (args.source === "manual_observations") {
    return { pair: null, toolFeedbackAuthority: null, reasons: [] };
  }
  const trace = args.parsed.product_trace;
  const baselineGuideTraceId = snapshotGuideTraceId(trace?.before_guide);
  const afterGuideTraceId = snapshotGuideTraceId(trace?.after_guide);
  if (!args.ledger) {
    return {
      pair: null,
      toolFeedbackAuthority: null,
      reasons: ["measurement_episode_ledger_unavailable"],
    };
  }
  if (!baselineGuideTraceId || !afterGuideTraceId) {
    return {
      pair: null,
      toolFeedbackAuthority: null,
      reasons: ["measurement_episode_trace_pair_missing"],
    };
  }
  const resolved: LiteLearningMeasurementEpisodePairResolution = await args.ledger.resolveMeasurementEpisodePair({
    tenantId: args.tenantId,
    scope: args.scope,
    baselineGuideTraceId,
    afterGuideTraceId,
  });
  if (resolved.status !== "available") {
    return {
      pair: null,
      toolFeedbackAuthority: null,
      reasons: [`measurement_episode_pair:${resolved.reasonCode}`],
    };
  }
  if (args.verifiedReceiptRunId !== undefined
    && (resolved.baseline.runId !== args.verifiedReceiptRunId
      || resolved.after.runId !== args.verifiedReceiptRunId)) {
    return {
      pair: null,
      toolFeedbackAuthority: null,
      reasons: ["measurement_episode_receipt_run_mismatch"],
    };
  }
  const baselineClaim = claimedGuideEpisodeIdentity(trace?.before_guide);
  const afterClaim = claimedGuideEpisodeIdentity(trace?.after_guide);
  const claimMismatch = [
    baselineClaim.status === "invalid" || (baselineClaim.status === "available" && (
      baselineClaim.guideTraceId !== baselineGuideTraceId
      || baselineClaim.episodeId !== resolved.baseline.episodeId
    )) ? "before_guide_episode_attribution_mismatch" : null,
    afterClaim.status === "invalid" || (afterClaim.status === "available" && (
      afterClaim.guideTraceId !== afterGuideTraceId
      || afterClaim.episodeId !== resolved.after.episodeId
    )) ? "after_guide_episode_attribution_mismatch" : null,
  ].filter((reason): reason is string => reason !== null);
  if (claimMismatch.length > 0) {
    return { pair: null, toolFeedbackAuthority: null, reasons: claimMismatch };
  }
  const taskMismatch = measurementTaskIdentityMismatchReasons(args.parsed.task, resolved);
  if (taskMismatch.length > 0) {
    return { pair: null, toolFeedbackAuthority: null, reasons: taskMismatch };
  }
  const toolFeedbackAuthority = args.toolFeedbackBinding
    && args.toolFeedbackBinding.guideTraceId === resolved.after.guideTraceId
    && args.toolFeedbackBinding.runId === resolved.after.runId
    ? await args.ledger.resolveMeasurementToolFeedbackAuthority({
        tenantId: args.tenantId,
        scope: args.scope,
        episodeId: resolved.after.episodeId,
        guideTraceId: resolved.after.guideTraceId,
        runId: resolved.after.runId,
        expectedDecisionId: args.toolFeedbackBinding.decisionId,
      })
    : null;
  return {
    pair: resolved,
    toolFeedbackAuthority,
    reasons: resolved.provenance.reasonCodes.map((reason) => `measurement_episode_pair:${reason}`),
  };
}

function bindProductMeasureEvidence(args: {
  evidence: ProductMeasureEvidenceAssessment;
  source: "manual_observations" | "product_trace";
  binding: ProductMeasureEpisodeBinding;
  operationProtected: boolean;
}): ProductMeasureEvidenceAssessment {
  if (args.source === "manual_observations") return args.evidence;
  if (!args.binding.pair) {
    return {
      ...args.evidence,
      status: "insufficient",
      sufficient_evidence: false,
      eligible_for_skill_export: false,
      provenance: "unverified_product_trace",
      reasons: uniqueStrings([
        ...args.evidence.reasons,
        ...args.binding.reasons,
        ...(!args.operationProtected ? ["measurement_operation_identity_unprotected"] : []),
      ]),
    };
  }
  const promotionEligible = args.binding.pair.provenance.promotionEligible;
  const toolFeedbackAuthority = args.binding.toolFeedbackAuthority;
  const protectedPositiveFeedback = toolFeedbackAuthority?.status === "available";
  const unprotectedPositiveFeedback = toolFeedbackAuthority?.status === "unavailable"
    && toolFeedbackAuthority.reasonCode === "feedback_operation_unprotected";
  const verifiedPositiveFeedback = protectedPositiveFeedback || unprotectedPositiveFeedback;
  const toolFeedbackAuthorityReason = toolFeedbackAuthority?.status === "unavailable"
    ? toolFeedbackAuthority.reasonCode
    : toolFeedbackAuthority === null
      ? "feedback_missing"
      : null;
  const sufficientEvidence = args.evidence.sufficient_evidence && verifiedPositiveFeedback;
  return {
    ...args.evidence,
    status: sufficientEvidence ? "sufficient" : "insufficient",
    sufficient_evidence: sufficientEvidence,
    provenance: sufficientEvidence ? args.evidence.provenance : "unverified_product_trace",
    eligible_for_skill_export: args.evidence.eligible_for_skill_export
      && promotionEligible
      && protectedPositiveFeedback
      && args.operationProtected,
    runtime_evidence_ids: uniqueStrings([
      ...args.evidence.runtime_evidence_ids,
      ...(args.binding.toolFeedbackAuthority?.status === "available"
        ? [
            `tool_feedback_event:${args.binding.toolFeedbackAuthority.eventId}:${args.binding.toolFeedbackAuthority.eventSha256}`,
            `tool_feedback_receipt:${args.binding.toolFeedbackAuthority.operationId}:${args.binding.toolFeedbackAuthority.operationReceiptSha256}`,
          ]
        : []),
    ]),
    reasons: uniqueStrings([
      ...args.evidence.reasons,
      ...args.binding.reasons,
      ...(!promotionEligible ? ["measurement_episode_pair_not_promotion_eligible"] : []),
      ...(toolFeedbackAuthorityReason !== null
        ? [`measurement_tool_feedback_authority:${toolFeedbackAuthorityReason}`]
        : []),
      ...(!args.operationProtected ? ["measurement_operation_identity_unprotected"] : []),
    ]),
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
  ledger: LiteLearningEpisodeLedgerAccess | null;
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
  if (!measurement.record_sha256
    || productMeasurementRecordDigest(measurement) !== measurement.record_sha256) {
    return { ok: false, reason: "measurement_full_record_digest_invalid" };
  }
  if (!measurement.baseline_episode_id || !measurement.after_episode_id) {
    return { ok: false, reason: "measurement_episode_pair_missing" };
  }
  if (!measurement.eligible_for_skill_export || measurement.evidence_status !== "sufficient") {
    return { ok: false, reason: "measurement_is_not_export_eligible" };
  }
  if (!args.ledger) {
    return { ok: false, reason: "measurement_effect_authority_unavailable" };
  }
  const effectAuthority = await args.ledger.resolveMeasurementEffectAuthority({
    tenantId: args.row.tenant_id,
    scope: args.row.scope,
    measurementId: measurement.measurement_id,
    measurementDigest: measurement.measurement_digest,
  });
  if (effectAuthority.status !== "available") {
    return {
      ok: false,
      reason: `measurement_effect_authority_${effectAuthority.reasonCode}`,
    };
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
  learningEpisodeLedgerAccess?: LiteLearningEpisodeLedgerAccess | null;
};

export function createProductMeasureService(
  dependencies: ProductMeasureServiceDependencies,
): ProductServices["measure"] {
  const access = dependencies.skillCandidateReviewAccess ?? null;
  const atomicWrite = asProductMeasureAtomicWrite(
    dependencies.runtimeEvidenceStore as (ProductMeasureEvidenceStore & ProductMeasureAtomicWrite) | null | undefined,
  );
  const learningEpisodeLedgerAccess = dependencies.learningEpisodeLedgerAccess ?? null;
  if (learningEpisodeLedgerAccess && atomicWrite
    && learningEpisodeLedgerAccess.transactionRunner() !== atomicWrite.transactionRunner()) {
    throw new Error("measure ledger and write store must share one Runtime transaction runner");
  }
  if (learningEpisodeLedgerAccess && access
    && learningEpisodeLedgerAccess.transactionRunner() !== access.transactionRunner()) {
    throw new Error("measure ledger and measurement store must share one Runtime transaction runner");
  }
  return {
    async execute(parsed: ProductMeasureRequestInput, context): Promise<ProductServiceResult> {
      try {
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
        const identity = productMeasureOperationIdentity({
          parsed,
          tenantId,
          scope,
          actorId: context.actorId,
        });
        if (identity) {
          if (!atomicWrite || !access
            || atomicWrite.transactionRunner() !== access.transactionRunner()) {
            throw new HttpError(
              503,
              "measure_atomic_write_unavailable",
              "protected measure requires one shared Runtime measurement transaction",
            );
          }
        }

        const measureInput = productMeasureInputs(parsed);
        const persist = async (): Promise<ProductServiceResult> => {
          if (identity && atomicWrite) {
            const raced = await atomicWrite.getWriteOperation({
              tenantId,
              scope,
              operationKind: PRODUCT_MEASURE_OPERATION_KIND,
              operationId: identity.operationId,
            });
            if (raced) {
              assertProductMeasureOperationMatches({
                identity,
                storedRequestSha256: raced.request_sha256,
              });
              const replayed = parseStoredProductMeasureOperationResult({
                identity,
                receiptJson: raced.receipt_json,
              });
              await assertStoredProductMeasureOperationAuthority({
                result: replayed,
                identity,
                originalOperation: raced,
                atomicWrite,
                access: access!,
                ledger: learningEpisodeLedgerAccess,
              });
              return replayed;
            }
            const strandedMeasurement = await access!.getMeasurementByOperationId({
              tenantId,
              scope,
              operationId: identity.operationId,
            });
            if (strandedMeasurement) {
              assertProductMeasureOperationMatches({
                identity,
                storedRequestSha256: strandedMeasurement.requestSha256,
              });
              throw new HttpError(
                500,
                "protected_measure_receipt_invalid",
                "protected measure operation authority is incomplete",
              );
            }
          }

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
            verified_receipt_run_id: verifiedReceiptRunId,
            verified_tool_feedback_binding: verifiedToolFeedbackBinding,
            ...preflightEvidenceAssessment
          } = evidenceResolution;
          const decisionOutputs = parsed.product_trace
            ? productMemoryDecisionOutputs({
                tenant_id: tenantId,
                scope,
                trace: parsed.product_trace,
                routes_used: ["/v1/measure"],
              })
            : null;
          const episodeBinding = await resolveProductMeasureEpisodeBinding({
            parsed,
            source: measureInput.source,
            tenantId,
            scope,
            ledger: learningEpisodeLedgerAccess,
            verifiedReceiptRunId,
            toolFeedbackBinding: verifiedToolFeedbackBinding,
          });
          const boundEvidenceAssessment = bindProductMeasureEvidence({
            evidence: preflightEvidenceAssessment,
            source: measureInput.source,
            binding: episodeBinding,
            operationProtected: identity !== null,
          });
          const measurementId = `measurement:${randomUUID()}`;
          const effectExpectedEvidence = measureInput.source === "product_trace"
            && boundEvidenceAssessment.status === "sufficient"
            && episodeBinding.pair
            && learningEpisodeLedgerAccess
            ? effectExpectedV1EvidenceReference({
                tenantId,
                scope,
                measurementId,
                baselineEpisodeId: episodeBinding.pair.baseline.episodeId,
                afterEpisodeId: episodeBinding.pair.after.episodeId,
              })
            : null;
          const evidenceAssessment = {
            ...boundEvidenceAssessment,
            runtime_evidence_ids: uniqueStrings([
              ...boundEvidenceAssessment.runtime_evidence_ids,
              ...(identity ? [productMeasureOperationEvidenceReference({
                  operationId: identity.operationId,
                  requestSha256: identity.requestSha256,
                })] : []),
              ...(effectExpectedEvidence ? [effectExpectedEvidence] : []),
            ]),
          };
          const effectReport = buildAionisEffectReport({
            tenant_id: tenantId,
            scope,
            task: productMeasureReportTask({
              parsedTask: parsed.task,
              source: measureInput.source,
              pair: episodeBinding.pair,
            }),
            report: kernelReport,
            comparison: {
              ...(measureInput.comparison ?? {}),
              sufficient_evidence: evidenceAssessment.sufficient_evidence,
            },
            evidence_ids: evidenceAssessment.runtime_evidence_ids,
            feedback_signal_review: decisionOutputs?.memoryDecisionAudit.feedback_signal_review ?? null,
          });
          const parsedEffectReport = AionisEffectReportSchema.parse(effectReport);

          const baselineEpisodeId = episodeBinding.pair?.baseline.episodeId ?? null;
          const afterEpisodeId = episodeBinding.pair?.after.episodeId ?? null;
          const createdAt = new Date().toISOString();
          const measurementRecordWithoutDigest = {
            measurement_id: measurementId,
            tenant_id: tenantId,
            scope,
            source: measureInput.source,
            baseline_episode_id: baselineEpisodeId,
            after_episode_id: afterEpisodeId,
            effect_report: parsedEffectReport,
            eligible_for_skill_export: evidenceAssessment.eligible_for_skill_export,
            evidence_status: evidenceAssessment.status,
            runtime_evidence_ids: evidenceAssessment.runtime_evidence_ids,
            eligibility_reasons: evidenceAssessment.reasons,
            created_by: context.actorId,
            created_at: createdAt,
          } satisfies Omit<ProductMeasurementRecord, "measurement_digest" | "record_sha256">;
          const measurementDigest = productMeasurementDigest(measurementRecordWithoutDigest);
          const measurementRecordBase = {
            ...measurementRecordWithoutDigest,
            measurement_digest: measurementDigest,
          };
          const measurementRecordSha256 = productMeasurementRecordDigest(measurementRecordBase);
          const measurementRecord: ProductMeasurementRecord = {
            ...measurementRecordBase,
            record_sha256: measurementRecordSha256,
          };
          let measurementPersisted = false;
          if (access) {
            await access.recordMeasurement({ record: measurementRecord });
            measurementPersisted = true;
          }
          const episodePair = episodeBinding.pair;
          const measurementLedger = learningEpisodeLedgerAccess;
          const effectEventPersisted = effectExpectedEvidence !== null;
          const result = productServiceSuccess({
            contract_version: "aionis_measure_result_v1",
            ...(identity ? { operation_id: identity.operationId } : {}),
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
                ...(episodeBinding.pair ? ["learning_episode_pair"] : []),
                ...(effectEventPersisted ? ["learning_effect_event"] : []),
                "effect_evaluator",
                "product_effect_report",
              ],
            },
          });
          let canonicalResult: ProductServiceResult = result;
          let operationReceiptSha256: string | null = null;
          if (identity && atomicWrite) {
            const receiptJson = stableStringify(result);
            if (Buffer.byteLength(receiptJson, "utf8") > PRODUCT_MEASURE_OPERATION_RECEIPT_MAX_BYTES) {
              throw new HttpError(
                413,
                "protected_measure_response_too_large",
                "protected measure response exceeds the canonical receipt size limit",
                { max_bytes: PRODUCT_MEASURE_OPERATION_RECEIPT_MAX_BYTES },
              );
            }
            const receiptAuthority = buildProductMeasureReceiptAuthority({
              tenantId,
              scope,
              operationId: identity.operationId,
              productMeasureRequestSha256: identity.requestSha256,
              operationReceiptJson: receiptJson,
              measurement: measurementRecord,
            });
            operationReceiptSha256 = receiptAuthority.operationReceiptSha256;
            canonicalResult = JSON.parse(receiptJson) as ProductServiceResult;
            await atomicWrite.insertWriteOperation({
              tenantId,
              scope,
              operationKind: PRODUCT_MEASURE_OPERATION_KIND,
              operationId: identity.operationId,
              requestSha256: identity.requestSha256,
              receiptJson,
              commitId: receiptAuthority.commitId,
            });
            await atomicWrite.insertWriteOperation({
              tenantId,
              scope,
              operationKind: receiptAuthority.operationKind,
              operationId: identity.operationId,
              requestSha256: receiptAuthority.requestSha256,
              receiptJson: receiptAuthority.receiptJson,
              commitId: receiptAuthority.commitId,
            });
          }
          const preparedEffectEvent = (
            effectEventPersisted
            && episodePair
            && measurementLedger
          ) ? (() => {
            const parsedEffectPayload = EffectMeasuredV1Schema.parse({
              contract_version: "aionis_learning_effect_v1",
              measurement_id: measurementId,
              measurement_record_sha256: measurementRecordSha256,
              operation_receipt_sha256: operationReceiptSha256,
              baseline_episode_id: episodePair.baseline.episodeId,
              after_episode_id: episodePair.after.episodeId,
              evidence_status: evidenceAssessment.status,
              eligible_for_skill_export: evidenceAssessment.eligible_for_skill_export,
            });
            if (parsedEffectPayload.operation_receipt_sha256 === undefined) {
              throw new Error("fresh measurement effect lost its operation receipt binding");
            }
            const effectPayload: FreshEffectMeasuredV1 = {
              ...parsedEffectPayload,
              operation_receipt_sha256: parsedEffectPayload.operation_receipt_sha256,
            };
            const payloadJson = stableStringify(effectPayload);
            const event: EventWithoutDigest = {
              contract_version: "aionis_learning_episode_event_v1",
              tenant_id: tenantId,
              scope,
              event_id: `leffect_${sha256Hex(stableStringify({
                tenant_id: tenantId,
                scope,
                measurement_id: measurementId,
                measurement_record_sha256: measurementRecordSha256,
              }))}`,
              episode_id: episodePair.after.episodeId,
              episode_sequence: episodePair.after.headSequence + 1,
              event_kind: "effect_measured",
              source_kind: "product_measurement",
              source_id: measurementId,
              source_sha256: measurementRecordSha256,
              previous_event_sha256: episodePair.after.headEventSha256,
              payload_sha256: sha256Hex(payloadJson),
              item_set_sha256: sha256Hex(stableStringify([])),
              source_commit_id: null,
              supersedes_event_id: null,
              operation_id: identity?.operationId ?? null,
              run_id: episodePair.after.runId,
              collection_class: episodePair.provenance.collectionClass,
              recorded_at: createdAt,
            };
            return {
              row: buildLiteMeasurementEffectEventRow({
                event,
                payload: effectPayload,
                pair: episodePair,
              }),
              event,
              payload: effectPayload,
            };
          })() : null;
          if (preparedEffectEvent && measurementLedger) {
            await measurementLedger.appendEpisodeEvent(preparedEffectEvent);
          }
          return canonicalResult;
        };

        const productTraceRequiresAtomicLedger = measureInput.source === "product_trace"
          && learningEpisodeLedgerAccess !== null;
        if (productTraceRequiresAtomicLedger && (!atomicWrite || !access)) {
          throw new HttpError(
            503,
            "measure_atomic_write_unavailable",
            "episode-bound measure requires one shared Runtime measurement transaction",
          );
        }
        return (identity || productTraceRequiresAtomicLedger) && atomicWrite
          ? await atomicWrite.withTx(persist)
          : await persist();
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
        const enqueueCandidates = async (): Promise<ProductServiceResult> => {
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
            || !measurement.record_sha256
            || productMeasurementRecordDigest(measurement) !== measurement.record_sha256
            || !measurement.baseline_episode_id
            || !measurement.after_episode_id
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
          if (!learningEpisodeLedgerAccess) {
            return productServiceFailure({
              statusCode: 503,
              error: "measurement_effect_authority_unavailable",
              message: "the Runtime learning episode ledger is required to verify skill export authority",
            });
          }
          const effectAuthority = await learningEpisodeLedgerAccess.resolveMeasurementEffectAuthority({
            tenantId,
            scope,
            measurementId,
            measurementDigest: measurement.measurement_digest,
          });
          if (effectAuthority.status !== "available") {
            return productServiceFailure({
              statusCode: 409,
              error: "measurement_not_skill_export_eligible",
              message: "the persisted measurement is not backed by a verified Runtime effect authority",
              details: {
                measurement_id: measurementId,
                authority_reason: effectAuthority.reasonCode,
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
        };
        return learningEpisodeLedgerAccess
          ? await learningEpisodeLedgerAccess.transactionRunner().run(enqueueCandidates)
          : await enqueueCandidates();
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
        const reviewCandidate = async (): Promise<ProductServiceResult> => {
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
            const binding = await validateCandidateMeasurementBinding({
              access,
              ledger: learningEpisodeLedgerAccess,
              row: current,
            });
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
        };
        return learningEpisodeLedgerAccess
          ? await learningEpisodeLedgerAccess.transactionRunner().run(reviewCandidate)
          : await reviewCandidate();
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
        const materializeCandidate = async (): Promise<ProductServiceResult> => {
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
          const binding = await validateCandidateMeasurementBinding({
            access,
            ledger: learningEpisodeLedgerAccess,
            row,
          });
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
        };
        return learningEpisodeLedgerAccess
          ? await learningEpisodeLedgerAccess.transactionRunner().run(materializeCandidate)
          : await materializeCandidate();
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
