import type { OutcomeContractGate } from "./contract-trust.js";
import type { ExecutionEvidenceAssessmentV1 } from "./execution-evidence.js";
import {
  RUNTIME_AUTHORITY_BOUNDARY_REGISTRY,
  type RuntimeAuthorityBoundaryDeclaration,
} from "./authority-producer-registry.js";

export type RuntimeAuthorityDecisionSurface =
  | "outcome_contract_gate"
  | "execution_evidence_gate"
  | "stable_promotion_gate"
  | "false_confidence_gate"
  | "candidate_workflow_reuse"
  | "trusted_pattern_policy_materialization"
  | "policy_default_materialization";

export type RuntimeAuthorityDecisionDisposition =
  | "allowed"
  | "blocked"
  | "advisory_only"
  | "inspect_or_rehydrate_only"
  | "unblocked_false_confidence";

export type RuntimeAuthorityDecisionEffect =
  | "authoritative_allowed"
  | "stable_promotion_allowed"
  | "advisory_only"
  | "inspection_required"
  | "blocked"
  | "none";

export type RuntimeAuthorityDecisionV1 = {
  decision_version: "runtime_authority_decision_v1";
  decision_id: string;
  surface: RuntimeAuthorityDecisionSurface;
  subject: string;
  disposition: RuntimeAuthorityDecisionDisposition;
  authority_effect: RuntimeAuthorityDecisionEffect;
  reasons: string[];
  rule_refs: string[];
  source_ids: string[];
  recommended_action: string;
};

export type RuntimeAuthorityDecisionSummaryV1 = {
  summary_version: "runtime_authority_decision_summary_v1";
  total_decisions: number;
  allowed_count: number;
  blocked_count: number;
  advisory_only_count: number;
  inspect_or_rehydrate_count: number;
  unblocked_false_confidence_count: number;
  decisions_by_surface: Record<RuntimeAuthorityDecisionSurface, {
    total: number;
    allowed: number;
    blocked: number;
    advisory_only: number;
    inspect_or_rehydrate_only: number;
    unblocked_false_confidence: number;
  }>;
  blocked_by_reason: Record<string, number>;
};

export type RuntimeAuthorityReadSideRuleReportV1 = {
  source_id: string;
  file: string;
  layer: RuntimeAuthorityBoundaryDeclaration["layer"];
  role: RuntimeAuthorityBoundaryDeclaration["role"];
  authority_rules: string[];
};

export type RuntimeAuthorityDecisionReportV1 = {
  report_version: "runtime_authority_decision_report_v1";
  summary: RuntimeAuthorityDecisionSummaryV1;
  read_side_rules: RuntimeAuthorityReadSideRuleReportV1[];
  decisions: RuntimeAuthorityDecisionV1[];
};

const AUTHORITY_DECISION_SURFACES: RuntimeAuthorityDecisionSurface[] = [
  "outcome_contract_gate",
  "execution_evidence_gate",
  "stable_promotion_gate",
  "false_confidence_gate",
  "candidate_workflow_reuse",
  "trusted_pattern_policy_materialization",
  "policy_default_materialization",
];

function authorityBoundary(sourceId: string): RuntimeAuthorityBoundaryDeclaration | null {
  return RUNTIME_AUTHORITY_BOUNDARY_REGISTRY.find((entry) => entry.id === sourceId) ?? null;
}

function authorityRules(...sourceIds: string[]): string[] {
  const rules = new Set<string>();
  for (const sourceId of sourceIds) {
    for (const rule of authorityBoundary(sourceId)?.authorityRules ?? []) {
      rules.add(rule);
    }
  }
  return [...rules];
}

function nonEmptyReasons(reasons: readonly string[], fallback: string): string[] {
  const normalized = reasons.map((reason) => reason.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [fallback];
}

function decision(args: Omit<RuntimeAuthorityDecisionV1, "decision_version">): RuntimeAuthorityDecisionV1 {
  return {
    decision_version: "runtime_authority_decision_v1",
    ...args,
    reasons: nonEmptyReasons(args.reasons, "unspecified_authority_decision"),
    rule_refs: [...new Set(args.rule_refs)].sort(),
    source_ids: [...new Set(args.source_ids)].sort(),
  };
}

export function runtimeAuthorityReadSideRules(): RuntimeAuthorityReadSideRuleReportV1[] {
  return RUNTIME_AUTHORITY_BOUNDARY_REGISTRY
    .filter((entry) => (entry.authorityRules ?? []).length > 0)
    .map((entry) => ({
      source_id: entry.id,
      file: entry.file,
      layer: entry.layer,
      role: entry.role,
      authority_rules: [...(entry.authorityRules ?? [])],
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
}

export function summarizeRuntimeAuthorityDecisions(
  decisions: readonly RuntimeAuthorityDecisionV1[],
): RuntimeAuthorityDecisionSummaryV1 {
  const decisionsBySurface = Object.fromEntries(
    AUTHORITY_DECISION_SURFACES.map((surface) => [
      surface,
      {
        total: 0,
        allowed: 0,
        blocked: 0,
        advisory_only: 0,
        inspect_or_rehydrate_only: 0,
        unblocked_false_confidence: 0,
      },
    ]),
  ) as RuntimeAuthorityDecisionSummaryV1["decisions_by_surface"];
  const blockedByReason: Record<string, number> = {};

  for (const entry of decisions) {
    const surface = decisionsBySurface[entry.surface];
    surface.total += 1;
    if (entry.disposition === "allowed") surface.allowed += 1;
    if (entry.disposition === "blocked") surface.blocked += 1;
    if (entry.disposition === "advisory_only") surface.advisory_only += 1;
    if (entry.disposition === "inspect_or_rehydrate_only") surface.inspect_or_rehydrate_only += 1;
    if (entry.disposition === "unblocked_false_confidence") surface.unblocked_false_confidence += 1;
    if (entry.disposition !== "allowed") {
      for (const reason of entry.reasons) {
        blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
      }
    }
  }

  return {
    summary_version: "runtime_authority_decision_summary_v1",
    total_decisions: decisions.length,
    allowed_count: decisions.filter((entry) => entry.disposition === "allowed").length,
    blocked_count: decisions.filter((entry) => entry.disposition === "blocked").length,
    advisory_only_count: decisions.filter((entry) => entry.disposition === "advisory_only").length,
    inspect_or_rehydrate_count: decisions.filter((entry) => entry.disposition === "inspect_or_rehydrate_only").length,
    unblocked_false_confidence_count: decisions.filter((entry) => entry.disposition === "unblocked_false_confidence").length,
    decisions_by_surface: decisionsBySurface,
    blocked_by_reason: Object.fromEntries(Object.entries(blockedByReason).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function buildRuntimeAuthorityDecisionReport(
  decisions: readonly RuntimeAuthorityDecisionV1[],
): RuntimeAuthorityDecisionReportV1 {
  return {
    report_version: "runtime_authority_decision_report_v1",
    summary: summarizeRuntimeAuthorityDecisions(decisions),
    read_side_rules: runtimeAuthorityReadSideRules(),
    decisions: [...decisions],
  };
}

export function buildRuntimeAuthorityDecisionReportFromGates(args: {
  subject: string;
  outcomeContractGate: OutcomeContractGate;
  executionEvidenceAssessment: ExecutionEvidenceAssessmentV1;
  stablePromotionAllowed: boolean;
  falseConfidenceDetected: boolean;
  candidateWorkflowVisible?: boolean;
  trustedPatternOnlyVisible?: boolean;
  policyDefaultAttempted?: boolean;
}): RuntimeAuthorityDecisionReportV1 {
  const decisions: RuntimeAuthorityDecisionV1[] = [];
  const outcomeReasons = nonEmptyReasons(args.outcomeContractGate.reasons, "outcome_contract_gate_passed");
  const evidenceReasons = nonEmptyReasons(args.executionEvidenceAssessment.reasons, "execution_evidence_gate_passed");

  decisions.push(decision({
    decision_id: `${args.subject}:outcome_contract_gate`,
    surface: "outcome_contract_gate",
    subject: args.subject,
    disposition: args.outcomeContractGate.allows_authoritative ? "allowed" : "blocked",
    authority_effect: args.outcomeContractGate.allows_authoritative ? "authoritative_allowed" : "blocked",
    reasons: outcomeReasons,
    rule_refs: [],
    source_ids: ["contract_trust_gate"],
    recommended_action: args.outcomeContractGate.allows_authoritative
      ? "Outcome contract can be considered for authoritative use when execution evidence also passes."
      : "Keep the workflow advisory until outcome contract requirements are complete.",
  }));

  decisions.push(decision({
    decision_id: `${args.subject}:execution_evidence_gate`,
    surface: "execution_evidence_gate",
    subject: args.subject,
    disposition: args.executionEvidenceAssessment.allows_authoritative ? "allowed" : "blocked",
    authority_effect: args.executionEvidenceAssessment.allows_authoritative ? "authoritative_allowed" : "blocked",
    reasons: evidenceReasons,
    rule_refs: [],
    source_ids: ["execution_evidence_gate"],
    recommended_action: args.executionEvidenceAssessment.allows_authoritative
      ? "Execution evidence can support authority for this scenario."
      : "Keep the workflow advisory until validation and lifecycle evidence pass.",
  }));

  decisions.push(decision({
    decision_id: `${args.subject}:stable_promotion_gate`,
    surface: "stable_promotion_gate",
    subject: args.subject,
    disposition: args.stablePromotionAllowed ? "allowed" : "blocked",
    authority_effect: args.stablePromotionAllowed ? "stable_promotion_allowed" : "advisory_only",
    reasons: args.stablePromotionAllowed
      ? ["outcome_contract_and_execution_evidence_allow_stable_promotion"]
      : [
          ...(!args.outcomeContractGate.allows_authoritative ? outcomeReasons.map((reason) => `outcome_contract:${reason}`) : []),
          ...(!args.executionEvidenceAssessment.allows_stable_promotion ? evidenceReasons.map((reason) => `execution_evidence:${reason}`) : []),
          ...(args.falseConfidenceDetected ? ["false_confidence_detected"] : []),
        ],
    rule_refs: [
      "authoritative_runtime_memory_requires_outcome_contract_and_execution_evidence",
    ],
    source_ids: ["workflow_write_projection", "replay_learning_artifacts", "replay_stable_anchor_helpers"],
    recommended_action: args.stablePromotionAllowed
      ? "Stable workflow promotion may proceed for this scenario."
      : "Do not promote this scenario to stable workflow memory.",
  }));

  decisions.push(decision({
    decision_id: `${args.subject}:false_confidence_gate`,
    surface: "false_confidence_gate",
    subject: args.subject,
    disposition: args.falseConfidenceDetected
      ? args.stablePromotionAllowed ? "unblocked_false_confidence" : "blocked"
      : "allowed",
    authority_effect: args.falseConfidenceDetected
      ? args.stablePromotionAllowed ? "blocked" : "advisory_only"
      : "none",
    reasons: args.falseConfidenceDetected ? ["false_confidence_detected"] : ["false_confidence_not_detected"],
    rule_refs: ["false_confidence_is_runtime_defect_not_presentation_issue"],
    source_ids: ["execution_evidence_gate", "trust_gate_core"],
    recommended_action: args.falseConfidenceDetected
      ? "Keep authority blocked until false confidence evidence is resolved."
      : "No false-confidence action required.",
  }));

  if (args.candidateWorkflowVisible) {
    decisions.push(decision({
      decision_id: `${args.subject}:candidate_workflow_reuse`,
      surface: "candidate_workflow_reuse",
      subject: args.subject,
      disposition: "inspect_or_rehydrate_only",
      authority_effect: "inspection_required",
      reasons: ["candidate_workflow_is_not_stable_authority"],
      rule_refs: authorityRules("action_retrieval_outcome_gate"),
      source_ids: ["action_retrieval_outcome_gate"],
      recommended_action: "Inspect or rehydrate the candidate workflow before reuse; do not emit stable workflow authority.",
    }));
  }

  if (args.trustedPatternOnlyVisible) {
    decisions.push(decision({
      decision_id: `${args.subject}:trusted_pattern_policy_materialization`,
      surface: "trusted_pattern_policy_materialization",
      subject: args.subject,
      disposition: "advisory_only",
      authority_effect: "advisory_only",
      reasons: ["trusted_pattern_only_guidance_is_not_authoritative_policy"],
      rule_refs: authorityRules("policy_materialization_surface", "tools_pattern_anchor"),
      source_ids: ["policy_materialization_surface", "tools_pattern_anchor"],
      recommended_action: "Use trusted-pattern-only guidance as advisory tool preference unless stable workflow or authoritative execution contract support exists.",
    }));
  }

  if (args.policyDefaultAttempted) {
    decisions.push(decision({
      decision_id: `${args.subject}:policy_default_materialization`,
      surface: "policy_default_materialization",
      subject: args.subject,
      disposition: args.stablePromotionAllowed ? "allowed" : "blocked",
      authority_effect: args.stablePromotionAllowed ? "authoritative_allowed" : "advisory_only",
      reasons: args.stablePromotionAllowed
        ? ["stable_workflow_or_authoritative_execution_contract_supports_default_policy"]
        : ["policy_default_requires_stable_workflow_or_live_authoritative_execution_contract"],
      rule_refs: authorityRules("policy_materialization_surface"),
      source_ids: ["policy_materialization_surface"],
      recommended_action: args.stablePromotionAllowed
        ? "Default policy materialization is eligible for this scenario."
        : "Keep policy materialization as advisory/candidate rather than default policy.",
    }));
  }

  return buildRuntimeAuthorityDecisionReport(decisions);
}
