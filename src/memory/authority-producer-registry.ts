export type RuntimeAuthorityLayer =
  | "Contract Compiler"
  | "Trust Gate"
  | "Orchestrator"
  | "Learning Loop"
  | "Schema Boundary";

export type RuntimeAuthorityBoundaryRole =
  | "registry_manifest"
  | "trust_gate_evaluator"
  | "authority_producer"
  | "authority_consumer"
  | "advisory_pattern_producer"
  | "read_side_summary"
  | "schema_boundary";

export type RuntimeAuthorityProducerKind =
  | "stable_workflow"
  | "authoritative_policy"
  | "advisory_pattern";

export type RuntimeAuthorityBoundaryDeclaration = {
  id: string;
  file: string;
  layer: RuntimeAuthorityLayer;
  role: RuntimeAuthorityBoundaryRole;
  producerKind?: RuntimeAuthorityProducerKind;
  authorityRules?: readonly string[];
  mayUseRuntimeAuthorityGate?: boolean;
  mayUseOutcomeContractGate?: boolean;
  mayAssessExecutionEvidence?: boolean;
  mayReadRawAuthoritySurface?: boolean;
  mayUseStableWorkflowLiteral?: boolean;
  mayUseStablePatternLiteral?: boolean;
  requiredSourceMarkers?: readonly string[];
};

export const RUNTIME_AUTHORITY_BOUNDARY_REGISTRY: readonly RuntimeAuthorityBoundaryDeclaration[] = [
  {
    id: "authority_boundary_manifest",
    file: "src/memory/authority-producer-registry.ts",
    layer: "Trust Gate",
    role: "registry_manifest",
  },
  {
    id: "trust_gate_core",
    file: "src/memory/authority-gate.ts",
    layer: "Trust Gate",
    role: "trust_gate_evaluator",
    mayUseRuntimeAuthorityGate: true,
    mayUseOutcomeContractGate: true,
    mayAssessExecutionEvidence: true,
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "contract_trust_gate",
    file: "src/memory/contract-trust.ts",
    layer: "Trust Gate",
    role: "trust_gate_evaluator",
    mayUseOutcomeContractGate: true,
  },
  {
    id: "execution_evidence_gate",
    file: "src/memory/execution-evidence.ts",
    layer: "Trust Gate",
    role: "trust_gate_evaluator",
    mayAssessExecutionEvidence: true,
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "authority_consumption",
    file: "src/memory/authority-consumption.ts",
    layer: "Trust Gate",
    role: "authority_consumer",
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "authority_visibility",
    file: "src/memory/authority-visibility.ts",
    layer: "Trust Gate",
    role: "authority_consumer",
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "execution_introspection",
    file: "src/memory/execution-introspection.ts",
    layer: "Orchestrator",
    role: "authority_consumer",
    mayUseOutcomeContractGate: true,
    mayReadRawAuthoritySurface: true,
    authorityRules: [
      "execution_introspection_reports_authority_decisions_read_only",
      "execution_introspection_must_not_promote_or_materialize_authority",
    ],
    requiredSourceMarkers: [
      "authority_decision_report",
      "buildRuntimeAuthorityDecisionReportFromGates",
      "combineAuthorityDecisionReports",
    ],
  },
  {
    id: "planning_summary_surfaces",
    file: "src/app/planning-summary-surfaces.ts",
    layer: "Orchestrator",
    role: "authority_consumer",
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "planning_summary",
    file: "src/app/planning-summary.ts",
    layer: "Orchestrator",
    role: "authority_consumer",
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "action_intelligence_runtime_contract",
    file: "src/memory/action-intelligence-runtime-contract.ts",
    layer: "Orchestrator",
    role: "authority_consumer",
    mayReadRawAuthoritySurface: true,
  },
  {
    id: "authority_decision_reporting",
    file: "src/memory/authority-decision-report.ts",
    layer: "Trust Gate",
    role: "read_side_summary",
    authorityRules: [
      "authority_decision_reporting_is_read_only",
      "authority_decision_reporting_must_not_grant_runtime_authority",
    ],
    requiredSourceMarkers: [
      "runtime_authority_decision_report_v1",
      "buildRuntimeAuthorityDecisionReportFromGates",
      "runtimeAuthorityReadSideRules",
    ],
  },
  {
    id: "action_retrieval_outcome_gate",
    file: "src/memory/action-retrieval.ts",
    layer: "Orchestrator",
    role: "authority_consumer",
    mayUseOutcomeContractGate: true,
    authorityRules: [
      "candidate_workflow_reuse_is_inspect_or_rehydrate_only",
      "candidate_workflow_must_not_emit_stable_workflow_tool_source",
      "candidate_workflow_must_not_contribute_stable_workflow_steps",
    ],
    requiredSourceMarkers: [
      "buildCandidateWorkflowInspectionNextAction",
      "workflowSupportsForRetrieval = path.source_kind === \"recommended_workflow\"",
      "return \"candidate\";",
    ],
  },
  {
    id: "policy_materialization_surface",
    file: "src/memory/policy-materialization-surface.ts",
    layer: "Trust Gate",
    role: "authority_consumer",
    authorityRules: [
      "trusted_pattern_only_guidance_is_advisory_candidate",
      "policy_default_requires_stable_workflow_or_live_authoritative_execution_contract",
      "candidate_workflow_must_not_emit_workflow_reuse_hint",
    ],
    requiredSourceMarkers: [
      "authoritativeExecutionContractSupports",
      "args.path.source_kind === \"recommended_workflow\"",
      "args.path.anchor_id && args.path.source_kind === \"recommended_workflow\"",
    ],
  },
  {
    id: "workflow_promotion_learning_control",
    file: "src/kernel/learning-promotion-kernel.ts",
    layer: "Trust Gate",
    role: "trust_gate_evaluator",
    mayUseOutcomeContractGate: true,
  },
  {
    id: "workflow_write_projection",
    file: "src/memory/workflow-write-projection.ts",
    layer: "Contract Compiler",
    role: "authority_producer",
    producerKind: "stable_workflow",
    mayUseRuntimeAuthorityGate: true,
    mayUseOutcomeContractGate: true,
    mayReadRawAuthoritySurface: true,
    mayUseStableWorkflowLiteral: true,
    requiredSourceMarkers: [
      "authorityGate.allows_authoritative",
      "authorityGate.allows_stable_promotion",
      "authorityGate: stableAuthorityGate",
      "outcomeContractGate: stableOutcomeContractGate",
      "executionEvidenceAssessment: stableExecutionEvidenceAssessment",
    ],
  },
  {
    id: "replay_learning_artifacts",
    file: "src/memory/replay-learning-artifacts.ts",
    layer: "Learning Loop",
    role: "authority_producer",
    producerKind: "stable_workflow",
    mayUseRuntimeAuthorityGate: true,
    mayUseOutcomeContractGate: true,
    mayReadRawAuthoritySurface: true,
    mayUseStableWorkflowLiteral: true,
    requiredSourceMarkers: [
      "args.shouldPromoteStableWorkflow",
      "authorityGate.allows_authoritative",
      "authorityGate.allows_stable_promotion",
      "authorityGate: stableAuthorityGate",
      "outcomeContractGate: stableOutcomeContractGate",
      "executionEvidenceAssessment: stableExecutionEvidenceAssessment",
    ],
  },
  {
    id: "learning_loop_summary",
    file: "src/memory/learning-loop.ts",
    layer: "Learning Loop",
    role: "read_side_summary",
    mayReadRawAuthoritySurface: true,
    mayUseStableWorkflowLiteral: true,
  },
  {
    id: "replay_stable_anchor_helpers",
    file: "src/memory/replay-stable-anchor-helpers.ts",
    layer: "Learning Loop",
    role: "authority_producer",
    producerKind: "stable_workflow",
    mayUseRuntimeAuthorityGate: true,
    mayReadRawAuthoritySurface: true,
    requiredSourceMarkers: [
      "authorityGatedReplayWorkflowContract",
      "authority.authorityGate.allows_authoritative",
      "authority.authorityGate.allows_stable_promotion",
      "executionEvidenceAssessment",
    ],
  },
  {
    id: "policy_memory",
    file: "src/memory/policy-memory.ts",
    layer: "Learning Loop",
    role: "authority_producer",
    producerKind: "authoritative_policy",
    mayUseRuntimeAuthorityGate: true,
    mayReadRawAuthoritySurface: true,
    requiredSourceMarkers: [
      "buildPolicyAuthoritySurfaces",
      "normalizePersistedPolicyLifecycleState",
      "authority.authorityGate.allows_authoritative",
    ],
  },
  {
    id: "tools_pattern_anchor",
    file: "src/memory/tools-pattern-anchor.ts",
    layer: "Learning Loop",
    role: "advisory_pattern_producer",
    producerKind: "advisory_pattern",
    mayUseStablePatternLiteral: true,
    authorityRules: [
      "trusted_pattern_guidance_is_advisory_not_authoritative_policy",
      "stable_pattern_must_not_bypass_policy_memory_authority_gate",
    ],
    requiredSourceMarkers: [
      "return \"advisory\";",
      "return \"observational\";",
      "promotion_gate_satisfied: promotionGateSatisfied",
      "revalidation_floor_satisfied: revalidationFloorSatisfied",
      "args.learningControlPatternStateOverride !== \"stable\"",
    ],
  },
  {
    id: "context_orchestrator_summary",
    file: "src/memory/context-orchestrator.ts",
    layer: "Orchestrator",
    role: "read_side_summary",
    mayUseStableWorkflowLiteral: true,
    mayUseStablePatternLiteral: true,
  },
  {
    id: "runtime_schemas",
    file: "src/memory/schemas.ts",
    layer: "Schema Boundary",
    role: "schema_boundary",
    mayReadRawAuthoritySurface: true,
  },
] as const satisfies readonly RuntimeAuthorityBoundaryDeclaration[];
