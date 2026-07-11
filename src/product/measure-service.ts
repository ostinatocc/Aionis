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
  SkillCandidateReviewAccess,
  SkillCandidateReviewRow,
  SkillCandidateReviewStatus,
  TraceDerivedSkillTrainingCandidate,
} from "../store/memory-store.js";
import {
  ProductForgetInput,
  ProductForgetTarget,
  ProductMeasureGuideSnapshotSchema,
  ProductMeasureRequest,
  ProductMeasureTraceSchema,
  ProductSkillCandidateEnqueueRequest,
  finiteNumber,
  objectValue,
  productMemoryDecisionOutputs,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
  uniqueStrings,
} from "./product-services.js";
import type {
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
      verifiedFactsCarried: verifiedFacts,
      verifiedFactsExpected: productMeasureExpectedCount(snapshot.verified_facts_expected, verifiedFacts),
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
      evidenceIds: compactProductMeasureEvidenceIds(parsed, trace),
      comparison: {
        mode: parsed.comparison?.mode ?? "observe_only_vs_active",
        baseline_run_id: parsed.comparison?.baseline_run_id ?? null,
        aionis_run_id: parsed.comparison?.aionis_run_id ?? null,
        sufficient_evidence: parsed.comparison?.sufficient_evidence ?? trace.sufficient_evidence ?? true,
      },
    };
  }
  return {
    baseline: parsed.baseline as AionisEffectObservation,
    aionis: parsed.aionis as AionisEffectObservation,
    source: "manual_observations",
    evidenceIds: parsed.evidence_ids ?? [],
    comparison: parsed.comparison,
  };
}

function productSkillCandidateEffectReportFromRequest(parsed: z.infer<typeof ProductSkillCandidateEnqueueRequest>): AionisEffectReport {
  if (parsed.effect_report !== undefined) {
    return AionisEffectReportSchema.parse(parsed.effect_report);
  }
  const measure = objectValue(parsed.measure_result);
  return AionisEffectReportSchema.parse(measure?.effect_report);
}

function productTraceDerivedSkillCandidates(report: AionisEffectReport): TraceDerivedSkillTrainingCandidate[] {
  return report.training_candidates.filter((candidate): candidate is TraceDerivedSkillTrainingCandidate => {
    const skill = candidate.trace_derived_skill;
    return candidate.candidate_type === "trace_derived_skill"
      && !!skill
      && skill.contract_version === "aionis_trace_derived_skill_candidate_v1";
  });
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

function compactProductMeasureEvidenceIds(parsed: ProductMeasureInput, trace: ProductMeasureTraceInput): string[] {
  return uniqueStrings([
    ...(parsed.evidence_ids ?? []),
    ...(trace.evidence_ids ?? []),
    ...(trace.before_guide?.memory_packet?.lifecycle.used_memory_ids ?? []).map((id) => `before:${id}`),
    ...(trace.after_guide.memory_packet?.lifecycle.used_memory_ids ?? []).map((id) => `after:${id}`),
    ...(trace.after_guide.guide_packet?.guidance.workflow_candidates ?? []).map((workflow) => `workflow:${workflow.workflow_id}`),
    ...(trace.forget_result?.forget_effect?.affected_memory_ids ?? []).map((id) => `forget:${id}`),
  ]);
}

export type ProductMeasureServiceDependencies = {
  defaultTenantId: string;
  defaultScope: string;
  skillCandidateReviewAccess?: SkillCandidateReviewAccess | null;
};

export function createProductMeasureService(
  dependencies: ProductMeasureServiceDependencies,
): ProductServices["measure"] {
  const access = dependencies.skillCandidateReviewAccess ?? null;
  return {
    async execute(parsed: ProductMeasureRequestInput): Promise<ProductServiceResult> {
      try {
        const measureInput = productMeasureInputs(parsed);
        const kernelReport = evaluateAionisEffect({
          baseline: measureInput.baseline,
          aionis: measureInput.aionis,
          minEffectDelta: parsed.minEffectDelta,
          minAionisScore: parsed.minAionisScore,
        });
        const tenantId = parsed.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? dependencies.defaultScope;
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
          comparison: measureInput.comparison,
          evidence_ids: measureInput.evidenceIds,
          feedback_signal_review: decisionOutputs?.memoryDecisionAudit.feedback_signal_review ?? null,
        });
        return productServiceSuccess({
          contract_version: "aionis_measure_result_v1",
          tenant_id: tenantId,
          scope,
          measurement_input: {
            source: measureInput.source,
            baseline: measureInput.baseline,
            aionis: measureInput.aionis,
          },
          effect_report: AionisEffectReportSchema.parse(effectReport),
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
        const report = productSkillCandidateEffectReportFromRequest(parsed);
        const tenantId = parsed.tenant_id ?? report.tenant_id ?? dependencies.defaultTenantId;
        const scope = parsed.scope ?? report.scope ?? dependencies.defaultScope;
        const candidates = productTraceDerivedSkillCandidates(report);
        const queued = await access.enqueueTraceDerivedSkillCandidates({
          tenantId,
          scope,
          candidates,
          source: parsed.measure_result !== undefined ? "measure_result" : "effect_report",
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
        const row = await access.reviewTraceDerivedSkillCandidate({
          tenantId,
          scope,
          candidateId: args.candidateId,
          reviewStatus: args.reviewStatus,
          reviewerId: args.input.reviewer_id ?? null,
          reason: args.input.reason ?? null,
        });
        if (!row) {
          return productServiceFailure({
            statusCode: 404,
            error: "skill_candidate_not_found",
            message: "trace-derived skill candidate was not found in this tenant/scope",
            details: { candidate_id: args.candidateId },
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
        if (!row.export_ready || row.promotion_status !== "promotion_ready" || row.label !== "positive") {
          return productServiceFailure({
            statusCode: 409,
            error: "skill_candidate_not_materializable",
            message: "trace-derived skill candidate is promoted but is not export-ready positive procedure evidence",
            details: {
              candidate_id: args.candidateId,
              export_ready: row.export_ready,
              promotion_status: row.promotion_status,
              label: row.label,
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
