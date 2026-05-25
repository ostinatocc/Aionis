import { z } from "zod";

export const PolicyMutationScopeSchema = z.enum([
  "exact_task",
  "task_family",
  "repository",
  "ecosystem",
  "global",
]);
export type PolicyMutationScope = z.infer<typeof PolicyMutationScopeSchema>;

export const PolicyMutationStageSchema = z.enum([
  "observe",
  "propose",
  "adjudicate",
  "apply",
  "suppress",
  "reject",
  "monitor",
  "promote",
  "demote",
  "forget",
]);
export type PolicyMutationStage = z.infer<typeof PolicyMutationStageSchema>;

export const PolicyMutationTargetKindSchema = z.enum([
  "execution_memory",
  "workflow_memory",
  "policy_memory",
  "rule_memory",
  "forgetting_state",
  "authority_state",
]);
export type PolicyMutationTargetKind = z.infer<typeof PolicyMutationTargetKindSchema>;

export const PolicyMutationEvidenceGradeSchema = z.enum([
  "real_verifier_pass",
  "real_integration_pass",
  "real_provider_runtime_pass",
  "deterministic_contract_pass",
  "synthetic_fixture_pass",
  "failed_verifier",
  "provider_failure",
  "protocol_failure",
  "user_feedback",
]);
export type PolicyMutationEvidenceGrade = z.infer<typeof PolicyMutationEvidenceGradeSchema>;

export const PolicyMutationEvidenceOutcomeSchema = z.enum([
  "success",
  "failure",
  "counter_evidence",
  "inconclusive",
]);
export type PolicyMutationEvidenceOutcome = z.infer<typeof PolicyMutationEvidenceOutcomeSchema>;

export const PolicyMutationAuthorityEffectSchema = z.enum([
  "none",
  "candidate",
  "advisory",
  "active",
  "default",
  "stable",
  "suppressed",
  "retired",
  "archived",
]);
export type PolicyMutationAuthorityEffect = z.infer<typeof PolicyMutationAuthorityEffectSchema>;

export const PolicyLearningControlMutationActionSchema = z.enum(["refresh", "retire", "reactivate"]);
export type PolicyLearningControlMutationAction = z.infer<typeof PolicyLearningControlMutationActionSchema>;

export const PolicyMemoryLifecycleStateForMutationSchema = z.enum(["active", "contested", "retired"]);
export type PolicyMemoryLifecycleStateForMutation = z.infer<typeof PolicyMemoryLifecycleStateForMutationSchema>;

export const PolicyMutationContractTrustSchema = z.enum(["authoritative", "advisory", "observational"]);
export type PolicyMutationContractTrust = z.infer<typeof PolicyMutationContractTrustSchema>;

export const PolicyMutationExecutionEvidenceStatusSchema = z.enum(["succeeded", "failed", "incomplete", "unknown"]);
export type PolicyMutationExecutionEvidenceStatus = z.infer<typeof PolicyMutationExecutionEvidenceStatusSchema>;

export const WorkflowPromotionMutationOriginSchema = z.enum([
  "execution_write_projection",
  "replay_learning_projection",
]);
export type WorkflowPromotionMutationOrigin = z.infer<typeof WorkflowPromotionMutationOriginSchema>;

export const ReplayLearningProjectionMutationStatusSchema = z.enum(["queued", "applied", "skipped", "failed"]);
export type ReplayLearningProjectionMutationStatus = z.infer<typeof ReplayLearningProjectionMutationStatusSchema>;

export const PolicyMutationEvidenceV1Schema = z.object({
  evidence_id: z.string().min(1),
  grade: PolicyMutationEvidenceGradeSchema,
  outcome: PolicyMutationEvidenceOutcomeSchema,
  source_ref: z.string().min(1),
  verifier_command: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  claims: z.array(z.string().min(1)).max(24).default([]),
}).strict();
export type PolicyMutationEvidenceV1 = z.infer<typeof PolicyMutationEvidenceV1Schema>;

export const PolicyMutationTargetV1Schema = z.object({
  kind: PolicyMutationTargetKindSchema,
  target_id: z.string().nullable().default(null),
  scope: PolicyMutationScopeSchema,
  scope_ref: z.string().nullable().default(null),
  memory_key: z.string().nullable().default(null),
}).strict();
export type PolicyMutationTargetV1 = z.infer<typeof PolicyMutationTargetV1Schema>;

export const PolicyMutationAdjudicationDecisionSchema = z.enum([
  "pending",
  "admit",
  "reject",
  "suppress",
  "monitor",
]);
export type PolicyMutationAdjudicationDecision = z.infer<typeof PolicyMutationAdjudicationDecisionSchema>;

export const PolicyMutationAdjudicationInputSchema = z.object({
  decision: PolicyMutationAdjudicationDecisionSchema,
  reviewer: z.enum(["runtime", "operator", "learning_control", "model_candidate"]).default("runtime"),
  reasons: z.array(z.string().min(1)).min(1).max(32),
  confidence: z.number().min(0).max(1),
}).strict();
export type PolicyMutationAdjudicationInput = z.infer<typeof PolicyMutationAdjudicationInputSchema>;

const broadAuthorityEffects = new Set<PolicyMutationAuthorityEffect>(["active", "default", "stable"]);
const terminalMutationStages = new Set<PolicyMutationStage>(["apply", "suppress", "reject", "promote", "demote", "forget"]);

function evidenceHasSuccess(evidence: PolicyMutationEvidenceV1[]): boolean {
  return evidence.some((entry) => entry.outcome === "success" && (
    entry.grade === "real_verifier_pass"
    || entry.grade === "real_integration_pass"
    || entry.grade === "real_provider_runtime_pass"
    || entry.grade === "deterministic_contract_pass"
  ));
}

function evidenceHasProviderOrProtocolOnlyFailure(evidence: PolicyMutationEvidenceV1[]): boolean {
  return evidence.length > 0 && evidence.every((entry) => (
    entry.grade === "provider_failure"
    || entry.grade === "protocol_failure"
  ));
}

export const PolicyMutationV1Schema = z.object({
  mutation_version: z.literal("policy_mutation_v1"),
  mutation_id: z.string().min(1),
  stage: PolicyMutationStageSchema,
  target: PolicyMutationTargetV1Schema,
  proposed_effect: PolicyMutationAuthorityEffectSchema,
  source_event_ref: z.string().min(1),
  evidence: z.array(PolicyMutationEvidenceV1Schema).min(1).max(64),
  evidence_refs: z.array(z.string().min(1)).min(1).max(64),
  promotion_evidence_refs: z.array(z.string().min(1)).max(64).default([]),
  holdout_evidence_refs: z.array(z.string().min(1)).max(64).default([]),
  counter_evidence_refs: z.array(z.string().min(1)).max(64).default([]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  expected_effect: z.string().min(1),
  escape_conditions: z.array(z.string().min(1)).min(1).max(24),
  rollback_plan: z.array(z.string().min(1)).min(1).max(24),
  forgetting_plan: z.array(z.string().min(1)).min(1).max(24),
  adjudication: PolicyMutationAdjudicationInputSchema,
  source_code_change_allowed: z.literal(false).default(false),
  project_specific_content_destination: z.enum([
    "execution_memory",
    "workflow_candidate",
    "policy_memory",
    "rule_candidate",
    "counter_evidence",
    "forgetting_signal",
    "evaluation_report",
  ]),
}).strict().superRefine((mutation, ctx) => {
  const wantsBroadAuthority = broadAuthorityEffects.has(mutation.proposed_effect);
  const hasSuccess = evidenceHasSuccess(mutation.evidence);

  if (terminalMutationStages.has(mutation.stage) && mutation.adjudication.decision === "pending") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adjudication", "decision"],
      message: "terminal policy mutations require an explicit learning-control decision",
    });
  }

  if (wantsBroadAuthority && !hasSuccess) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposed_effect"],
      message: "active/default/stable authority requires successful non-provider evidence",
    });
  }

  if (wantsBroadAuthority && evidenceHasProviderOrProtocolOnlyFailure(mutation.evidence)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "provider/protocol-only evidence cannot create broad policy authority",
    });
  }

  if (mutation.stage === "promote" && mutation.adjudication.decision !== "admit") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["adjudication", "decision"],
      message: "promotion requires an admit decision",
    });
  }

  if (mutation.stage === "promote" && mutation.promotion_evidence_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["promotion_evidence_refs"],
      message: "promotion requires explicit promotion evidence references",
    });
  }

  if (mutation.target.scope === "global" && wantsBroadAuthority && mutation.holdout_evidence_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["holdout_evidence_refs"],
      message: "global authority requires holdout or regression evidence",
    });
  }
});
export type PolicyMutationV1 = z.infer<typeof PolicyMutationV1Schema>;

export const PolicyMutationAdjudicationV1Schema = z.object({
  adjudication_version: z.literal("policy_mutation_adjudication_v1"),
  mutation_id: z.string().min(1),
  admissible: z.boolean(),
  decision: PolicyMutationAdjudicationDecisionSchema,
  current_stage: PolicyMutationStageSchema.nullable(),
  next_stage: PolicyMutationStageSchema,
  proposed_effect: PolicyMutationAuthorityEffectSchema.nullable(),
  target_kind: PolicyMutationTargetKindSchema.nullable(),
  blocked_authority: z.boolean(),
  reasons: z.array(z.string().min(1)).min(1).max(32),
  source_code_change_allowed: z.literal(false),
}).strict();
export type PolicyMutationAdjudicationV1 = z.infer<typeof PolicyMutationAdjudicationV1Schema>;

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function policyMutationIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "-").replace(/-+/g, "-").slice(0, 96);
}

function policyMutationScopeForLearningControl(args: {
  workflow_signature?: string | null;
  file_path?: string | null;
}): PolicyMutationScope {
  if (firstNonEmptyString(args.workflow_signature)) return "task_family";
  if (firstNonEmptyString(args.file_path)) return "repository";
  return "repository";
}

function learningControlEffect(args: {
  action: PolicyLearningControlMutationAction;
  next_state: PolicyMemoryLifecycleStateForMutation;
  contract_trust?: PolicyMutationContractTrust | null;
  activation_mode?: "hint" | "default" | null;
  has_deterministic_contract_evidence: boolean;
}): PolicyMutationAuthorityEffect {
  if (args.action === "retire" || args.next_state === "retired") return "retired";
  if (args.next_state === "contested") return "advisory";
  if (
    args.action === "reactivate"
    && args.contract_trust === "authoritative"
    && args.activation_mode === "default"
    && args.has_deterministic_contract_evidence
  ) {
    return "active";
  }
  return "advisory";
}

function policyMutationEvidenceRefs(...values: Array<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values.flat()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 64) break;
  }
  return out;
}

function workflowPromotionScopeRef(args: {
  workflow_signature?: string | null;
  task_signature?: string | null;
  source_node_id?: string | null;
  scope: string;
}): string {
  return firstNonEmptyString(
    args.workflow_signature,
    args.task_signature,
    args.source_node_id ? `source_node:${args.source_node_id}` : null,
    `memory_scope:${args.scope}`,
  ) ?? `memory_scope:${args.scope}`;
}

export function buildPolicyMutationFromWorkflowPromotion(args: {
  scope: string;
  workflow_memory_id: string;
  workflow_signature?: string | null;
  task_signature?: string | null;
  source_node_id?: string | null;
  origin: WorkflowPromotionMutationOrigin;
  observed_count?: number | null;
  required_observations?: number | null;
  authority_gate_allows_stable_promotion?: boolean | null;
  learning_control_admissible?: boolean | null;
  runtime_apply_changed_promotion_state?: boolean | null;
  execution_evidence_status?: PolicyMutationExecutionEvidenceStatus | null;
  execution_evidence_refs?: string[];
}): PolicyMutationV1 {
  const sourceEventRef = `${args.origin}:promote_workflow:${args.workflow_memory_id}`;
  const mutationId = [
    "policy_mutation",
    "workflow",
    policyMutationIdPart(args.workflow_memory_id),
    args.origin,
    "stable",
  ].join(":");
  const deterministicEvidenceId = `${mutationId}:promotion_gate`;
  const runtimeEvidenceId = `${mutationId}:execution_evidence`;
  const evidence: PolicyMutationEvidenceV1[] = [
    PolicyMutationEvidenceV1Schema.parse({
      evidence_id: deterministicEvidenceId,
      grade: "deterministic_contract_pass",
      outcome: args.authority_gate_allows_stable_promotion === false ? "inconclusive" : "success",
      source_ref: `${sourceEventRef}:authority_gate`,
      verifier_command: null,
      confidence: args.authority_gate_allows_stable_promotion === false ? 0.52 : 0.86,
      claims: [
        `workflow_promotion_origin:${args.origin}`,
        `observations:${Math.max(0, Math.trunc(Number(args.observed_count ?? 0)))}`
          + `/required:${Math.max(0, Math.trunc(Number(args.required_observations ?? 0)))}`,
      ],
    }),
  ];
  if (args.execution_evidence_status === "succeeded") {
    evidence.push(PolicyMutationEvidenceV1Schema.parse({
      evidence_id: runtimeEvidenceId,
      grade: "real_verifier_pass",
      outcome: "success",
      source_ref: firstNonEmptyString(...(args.execution_evidence_refs ?? [])) ?? `${sourceEventRef}:execution_evidence`,
      verifier_command: null,
      confidence: 0.9,
      claims: [
        "execution_evidence_allows_stable_promotion",
        `workflow_memory:${args.workflow_memory_id}`,
      ],
    }));
  }
  const evidenceRefs = policyMutationEvidenceRefs(
    evidence.map((entry) => entry.evidence_id),
    args.execution_evidence_refs ?? [],
  );

  return PolicyMutationV1Schema.parse({
    mutation_version: "policy_mutation_v1",
    mutation_id: mutationId,
    stage: "promote",
    target: {
      kind: "workflow_memory",
      target_id: args.workflow_memory_id,
      scope: firstNonEmptyString(args.workflow_signature) ? "task_family" : "repository",
      scope_ref: workflowPromotionScopeRef({
        scope: args.scope,
        workflow_signature: args.workflow_signature ?? null,
        task_signature: args.task_signature ?? null,
        source_node_id: args.source_node_id ?? null,
      }),
      memory_key: "workflow_promotion",
    },
    proposed_effect: "stable",
    source_event_ref: sourceEventRef,
    evidence,
    evidence_refs: evidenceRefs,
    promotion_evidence_refs: evidenceRefs,
    holdout_evidence_refs: [],
    counter_evidence_refs: [],
    confidence: args.execution_evidence_status === "succeeded" ? 0.9 : 0.86,
    rationale: "learning control and runtime authority gates promoted workflow memory to stable authority",
    expected_effect: "future planning can reuse this stable workflow without changing runtime source",
    escape_conditions: [
      "future execution evidence fails for this workflow",
      "learning control suppresses or retires the workflow memory",
    ],
    rollback_plan: [
      "demote or suppress workflow memory if reuse produces counter-evidence",
    ],
    forgetting_plan: [
      "archive stale stable workflow memory after repeated non-use or contradiction",
    ],
    adjudication: {
      decision: "admit",
      reviewer: "learning_control",
      reasons: [
        "workflow_promotion_gate_committed_stable_memory",
        "mutation_targets_runtime_memory_not_source",
      ],
      confidence: args.execution_evidence_status === "succeeded" ? 0.9 : 0.86,
    },
    source_code_change_allowed: false,
    project_specific_content_destination: "workflow_candidate",
  });
}

export function buildPolicyMutationFromReplayLearningProjection(args: {
  scope: string;
  playbook_id: string;
  playbook_version: number;
  status: ReplayLearningProjectionMutationStatus;
  generated_rule_node_id?: string | null;
  generated_episode_node_id?: string | null;
  generated_workflow_node_id?: string | null;
  rule_state?: "draft" | "shadow" | null;
  learning_control_admissible?: boolean | null;
  policy_effect_applies?: boolean | null;
}): PolicyMutationV1 | null {
  if (args.status !== "applied" || !firstNonEmptyString(args.generated_rule_node_id)) return null;
  const ruleNodeId = firstNonEmptyString(args.generated_rule_node_id)!;
  const sourceEventRef = `replay_learning_projection:${args.playbook_id}:v${args.playbook_version}`;
  const mutationId = [
    "policy_mutation",
    "replay_learning_rule",
    policyMutationIdPart(ruleNodeId),
    args.rule_state === "shadow" ? "shadow" : "draft",
  ].join(":");
  const projectionEvidenceId = `${mutationId}:projection_applied`;
  const learningControlEvidenceId = `${mutationId}:learning_control`;
  const evidence: PolicyMutationEvidenceV1[] = [
    PolicyMutationEvidenceV1Schema.parse({
      evidence_id: projectionEvidenceId,
      grade: "deterministic_contract_pass",
      outcome: "success",
      source_ref: sourceEventRef,
      verifier_command: null,
      confidence: 0.8,
      claims: [
        "replay_learning_projection_applied",
        `rule_state:${args.rule_state === "shadow" ? "shadow" : "draft"}`,
      ],
    }),
  ];
  if (args.learning_control_admissible === true || args.policy_effect_applies === true) {
    evidence.push(PolicyMutationEvidenceV1Schema.parse({
      evidence_id: learningControlEvidenceId,
      grade: "user_feedback",
      outcome: "success",
      source_ref: `${sourceEventRef}:learning_control_preview`,
      verifier_command: null,
      confidence: 0.76,
      claims: [
        "learning_control_review_admitted_replay_learning_projection",
      ],
    }));
  }
  const proposedEffect: PolicyMutationAuthorityEffect = args.rule_state === "shadow" ? "advisory" : "candidate";
  const evidenceRefs = policyMutationEvidenceRefs(
    evidence.map((entry) => entry.evidence_id),
    args.generated_episode_node_id ? `episode:${args.generated_episode_node_id}` : null,
    args.generated_workflow_node_id ? `workflow:${args.generated_workflow_node_id}` : null,
  );

  return PolicyMutationV1Schema.parse({
    mutation_version: "policy_mutation_v1",
    mutation_id: mutationId,
    stage: "apply",
    target: {
      kind: "rule_memory",
      target_id: ruleNodeId,
      scope: "repository",
      scope_ref: `replay_playbook:${args.playbook_id}`,
      memory_key: "replay_learning_rule_state",
    },
    proposed_effect: proposedEffect,
    source_event_ref: sourceEventRef,
    evidence,
    evidence_refs: evidenceRefs,
    promotion_evidence_refs: [],
    holdout_evidence_refs: [],
    counter_evidence_refs: [],
    confidence: args.rule_state === "shadow" ? 0.8 : 0.68,
    rationale: "replay learning projection created or updated reusable rule memory",
    expected_effect: "future tool selection can use replay-derived rule memory under learning-control authority",
    escape_conditions: [
      "future replay-derived rule conflicts with stronger memory",
      "operator or runtime feedback demotes the generated rule",
    ],
    rollback_plan: [
      "demote replay-derived rule to draft or disable it if counter-evidence appears",
    ],
    forgetting_plan: [
      "archive replay-derived rule memory when its source playbook becomes stale",
    ],
    adjudication: {
      decision: "admit",
      reviewer: "learning_control",
      reasons: [
        "replay_learning_projection_committed_rule_memory",
        "mutation_targets_runtime_memory_not_source",
      ],
      confidence: args.rule_state === "shadow" ? 0.8 : 0.68,
    },
    source_code_change_allowed: false,
    project_specific_content_destination: "rule_candidate",
  });
}

export function buildPolicyMutationFromLearningControlApply(args: {
  tenant_id: string;
  scope: string;
  policy_memory_id: string;
  action: PolicyLearningControlMutationAction;
  actor?: string | null;
  reason?: string | null;
  previous_state: PolicyMemoryLifecycleStateForMutation;
  next_state: PolicyMemoryLifecycleStateForMutation;
  learning_control_contract_present?: boolean;
  live_policy_contract_present?: boolean;
  contract_trust?: PolicyMutationContractTrust | null;
  activation_mode?: "hint" | "default" | null;
  selected_tool?: string | null;
  workflow_signature?: string | null;
  file_path?: string | null;
}): PolicyMutationV1 {
  const actor = firstNonEmptyString(args.actor) ?? "learning_control";
  const scopeRef = firstNonEmptyString(args.workflow_signature)
    ?? firstNonEmptyString(args.file_path)
    ?? `memory_scope:${args.scope}`;
  const mutationId = [
    "policy_mutation",
    policyMutationIdPart(args.policy_memory_id),
    args.action,
    args.previous_state,
    args.next_state,
  ].join(":");
  const sourceEventRef = `policy_learning_control_apply:${args.action}:${args.policy_memory_id}`;
  const operatorEvidenceId = `${mutationId}:operator_feedback`;
  const contractEvidenceId = `${mutationId}:contract_check`;
  const hasDeterministicContractEvidence =
    args.learning_control_contract_present === true
    || args.live_policy_contract_present === true;
  const proposedEffect = learningControlEffect({
    action: args.action,
    next_state: args.next_state,
    contract_trust: args.contract_trust ?? null,
    activation_mode: args.activation_mode ?? null,
    has_deterministic_contract_evidence: hasDeterministicContractEvidence,
  });
  const evidence: PolicyMutationEvidenceV1[] = [
    PolicyMutationEvidenceV1Schema.parse({
      evidence_id: operatorEvidenceId,
      grade: "user_feedback",
      outcome: args.action === "retire" ? "counter_evidence" : "success",
      source_ref: `${sourceEventRef}:actor:${actor}`,
      verifier_command: null,
      confidence: args.action === "retire" ? 0.74 : 0.68,
      claims: [
        `learning_control_action:${args.action}`,
        `policy_memory_state:${args.previous_state}->${args.next_state}`,
      ],
    }),
  ];
  if (hasDeterministicContractEvidence) {
    evidence.push(PolicyMutationEvidenceV1Schema.parse({
      evidence_id: contractEvidenceId,
      grade: "deterministic_contract_pass",
      outcome: "success",
      source_ref: `${sourceEventRef}:contract`,
      verifier_command: null,
      confidence: 0.82,
      claims: [
        "learning_control_contract_matched_policy_memory",
        `policy_memory_state:${args.next_state}`,
      ],
    }));
  }

  const evidenceRefs = evidence.map((entry) => entry.evidence_id);
  const reason = firstNonEmptyString(args.reason);
  const rationaleParts = [
    `learning_control applied ${args.action} to policy memory`,
    `state ${args.previous_state} -> ${args.next_state}`,
    reason ? "operator reason was captured as runtime memory data" : null,
  ].filter((part): part is string => !!part);

  return PolicyMutationV1Schema.parse({
    mutation_version: "policy_mutation_v1",
    mutation_id: mutationId,
    stage: "apply",
    target: {
      kind: "policy_memory",
      target_id: args.policy_memory_id,
      scope: policyMutationScopeForLearningControl({
        workflow_signature: args.workflow_signature ?? null,
        file_path: args.file_path ?? null,
      }),
      scope_ref: scopeRef,
      memory_key: "policy_memory_state",
    },
    proposed_effect: proposedEffect,
    source_event_ref: sourceEventRef,
    evidence,
    evidence_refs: evidenceRefs,
    promotion_evidence_refs: proposedEffect === "active" ? [contractEvidenceId] : [],
    holdout_evidence_refs: [],
    counter_evidence_refs: args.action === "retire" ? [operatorEvidenceId] : [],
    confidence: hasDeterministicContractEvidence ? 0.82 : 0.7,
    rationale: rationaleParts.join("; "),
    expected_effect: `policy memory lifecycle records ${args.action} without changing runtime source`,
    escape_conditions: [
      "future verified execution contradicts this policy memory",
      "operator learning control retires or suppresses this policy memory",
    ],
    rollback_plan: [
      args.action === "retire"
        ? "reactivate policy memory through learning control after fresh evidence"
        : "retire policy memory through learning control if future evidence contradicts it",
    ],
    forgetting_plan: [
      "move stale or repeatedly contradicted policy memory toward retired or archived state",
    ],
    adjudication: {
      decision: "admit",
      reviewer: "learning_control",
      reasons: [
        "learning_control_apply_committed_policy_memory_state",
        "mutation_targets_runtime_memory_not_source",
      ],
      confidence: hasDeterministicContractEvidence ? 0.82 : 0.7,
    },
    source_code_change_allowed: false,
    project_specific_content_destination: "policy_memory",
  });
}

function nextStageForAdmittedMutation(stage: PolicyMutationStage): PolicyMutationStage {
  if (stage === "observe") return "propose";
  if (stage === "propose") return "adjudicate";
  if (stage === "adjudicate") return "apply";
  if (stage === "apply") return "monitor";
  if (stage === "monitor") return "promote";
  return stage;
}

export function adjudicatePolicyMutationV1(input: unknown): PolicyMutationAdjudicationV1 {
  const parsed = PolicyMutationV1Schema.safeParse(input);
  if (!parsed.success) {
    return PolicyMutationAdjudicationV1Schema.parse({
      adjudication_version: "policy_mutation_adjudication_v1",
      mutation_id: typeof input === "object" && input && "mutation_id" in input ? String((input as { mutation_id?: unknown }).mutation_id) : "invalid",
      admissible: false,
      decision: "reject",
      current_stage: null,
      next_stage: "reject",
      proposed_effect: null,
      target_kind: null,
      blocked_authority: true,
      reasons: parsed.error.issues.slice(0, 8).map((issue) => issue.message),
      source_code_change_allowed: false,
    });
  }

  const mutation = parsed.data;
  const wantsBroadAuthority = broadAuthorityEffects.has(mutation.proposed_effect);
  const hasSuccess = evidenceHasSuccess(mutation.evidence);
  const providerOrProtocolOnly = evidenceHasProviderOrProtocolOnlyFailure(mutation.evidence);
  const reasons = [...mutation.adjudication.reasons];

  if (mutation.adjudication.decision === "reject") {
    reasons.push("learning_control_rejected_mutation");
    return PolicyMutationAdjudicationV1Schema.parse({
      adjudication_version: "policy_mutation_adjudication_v1",
      mutation_id: mutation.mutation_id,
      admissible: false,
      decision: "reject",
      current_stage: mutation.stage,
      next_stage: "reject",
      proposed_effect: mutation.proposed_effect,
      target_kind: mutation.target.kind,
      blocked_authority: true,
      reasons,
      source_code_change_allowed: false,
    });
  }

  if (providerOrProtocolOnly && wantsBroadAuthority) {
    reasons.push("provider_or_protocol_only_evidence_quarantined");
    return PolicyMutationAdjudicationV1Schema.parse({
      adjudication_version: "policy_mutation_adjudication_v1",
      mutation_id: mutation.mutation_id,
      admissible: false,
      decision: "reject",
      current_stage: mutation.stage,
      next_stage: "reject",
      proposed_effect: mutation.proposed_effect,
      target_kind: mutation.target.kind,
      blocked_authority: true,
      reasons,
      source_code_change_allowed: false,
    });
  }

  if (wantsBroadAuthority && !hasSuccess) {
    reasons.push("broad_authority_requires_success_evidence");
    return PolicyMutationAdjudicationV1Schema.parse({
      adjudication_version: "policy_mutation_adjudication_v1",
      mutation_id: mutation.mutation_id,
      admissible: false,
      decision: "reject",
      current_stage: mutation.stage,
      next_stage: "reject",
      proposed_effect: mutation.proposed_effect,
      target_kind: mutation.target.kind,
      blocked_authority: true,
      reasons,
      source_code_change_allowed: false,
    });
  }

  if (mutation.adjudication.decision === "suppress") {
    reasons.push("learning_control_suppression_requested");
    return PolicyMutationAdjudicationV1Schema.parse({
      adjudication_version: "policy_mutation_adjudication_v1",
      mutation_id: mutation.mutation_id,
      admissible: true,
      decision: "suppress",
      current_stage: mutation.stage,
      next_stage: "suppress",
      proposed_effect: mutation.proposed_effect,
      target_kind: mutation.target.kind,
      blocked_authority: true,
      reasons,
      source_code_change_allowed: false,
    });
  }

  const decision = mutation.adjudication.decision === "pending" ? "monitor" : mutation.adjudication.decision;
  reasons.push("policy_mutation_targets_runtime_memory_not_source_code");
  return PolicyMutationAdjudicationV1Schema.parse({
    adjudication_version: "policy_mutation_adjudication_v1",
    mutation_id: mutation.mutation_id,
    admissible: decision === "admit" || decision === "monitor",
    decision,
    current_stage: mutation.stage,
    next_stage: decision === "admit" ? nextStageForAdmittedMutation(mutation.stage) : "monitor",
    proposed_effect: mutation.proposed_effect,
    target_kind: mutation.target.kind,
    blocked_authority: wantsBroadAuthority && mutation.adjudication.decision !== "admit",
    reasons,
    source_code_change_allowed: false,
  });
}
