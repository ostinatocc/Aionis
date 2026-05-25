import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import {
  buildDistillationMetadata,
  buildWorkflowMaintenanceMetadata,
  buildWorkflowPromotionMetadata,
} from "./evolution-operators.js";
import { ExecutionNativeV1Schema, MemoryAnchorV1Schema } from "./schemas.js";
import {
  buildReplayProjectionExecutionContract,
  deriveReplayWorkflowContractFromSlots,
} from "./replay-workflow-contract.js";
import {
  buildRuntimeAuthorityGate,
  downgradeAuthoritativeTrust,
} from "./authority-gate.js";
import {
  adjudicatePolicyMutationV1,
  buildPolicyMutationFromWorkflowPromotion,
} from "../kernel/policy-mutation-loop.js";

export type ReplayLearningProjectionSource = {
  tenant_id: string;
  scope: string;
  scope_key: string;
  actor: string;
  playbook_id: string;
  playbook_version: number;
  playbook_node_id: string;
  playbook_title: string | null;
  playbook_summary: string | null;
  playbook_slots: Record<string, unknown>;
  source_commit_id: string | null;
  metrics?: {
    total_steps?: number;
    success_ratio?: number;
  };
};

export type ReplayLearningProjectionArtifacts = {
  ruleClientId: string;
  episodeClientId: string;
  workflowClientId: string;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  shouldPromoteStableWorkflow: boolean;
};

export const REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS = 2;

function stableNodeIdFromClientId(scope: string, clientId: string): string {
  return stableUuid(`${scope}:node:${clientId.trim()}`);
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function uniqueStrings(values: unknown[], max = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const s = toStringOrNull(value);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function derivePreferredTools(slots: Record<string, unknown>, maxTools: number): string[] {
  const steps = Array.isArray(slots.steps_template) ? slots.steps_template : [];
  const toolNames: unknown[] = [];
  for (const step of steps) {
    const stepObj = asObject(step);
    if (!stepObj) continue;
    toolNames.push(stepObj.tool_name);
  }
  return uniqueStrings(toolNames, Math.max(1, maxTools));
}

export function deriveReplayLearningWorkflowSignature(playbookId: string, slots: Record<string, unknown>): string {
  const steps = Array.isArray(slots.steps_template)
    ? slots.steps_template.map((step) => {
        const obj = asObject(step) ?? {};
        return {
          tool_name: toStringOrNull(obj.tool_name),
          safety_level: toStringOrNull(obj.safety_level),
          preconditions: Array.isArray(obj.preconditions) ? obj.preconditions.length : 0,
          postconditions: Array.isArray(obj.postconditions) ? obj.postconditions.length : 0,
        };
      })
    : [];
  return `replay_learning_workflow:${sha256Hex(stableStringify({ playbook_id: playbookId, steps })).slice(0, 24)}`;
}

function deriveReplayLearningKeySteps(slots: Record<string, unknown>): string[] {
  const stepsTemplate = Array.isArray(slots.steps_template) ? slots.steps_template : [];
  return stepsTemplate
    .map((step) => {
      const obj = asObject(step) ?? {};
      const stepIndex = Number(obj.step_index ?? 0) || null;
      const toolName = toStringOrNull(obj.tool_name);
      if (!toolName) return null;
      return stepIndex != null ? `step_${stepIndex}:${toolName}` : toolName;
    })
    .filter((value): value is string => !!value)
    .slice(0, 12);
}

function buildReplayLearningStableWorkflowAnchor(args: {
  scopeKey: string;
  clientId: string;
  playbookId: string;
  playbookTitle: string | null;
  playbookSummary: string | null;
  playbookSlots: Record<string, unknown>;
  sourceNodeId: string;
  sourceCommitId: string | null;
  workflowSignature: string;
  observedCount: number;
  episodeNodeId: string | null;
  promotedAt: string;
}) {
  const toolSet = derivePreferredTools(args.playbookSlots, 64);
  const workflowContract = deriveReplayWorkflowContractFromSlots(args.playbookSlots);
  const sourceRunId = toStringOrNull(args.playbookSlots.source_run_id);
  const createdFromRunIds = Array.isArray(args.playbookSlots.created_from_run_ids)
    ? args.playbookSlots.created_from_run_ids.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const summary =
    args.playbookSummary
    ?? args.playbookTitle
    ?? `Replay learned workflow for playbook ${args.playbookId}`;
  const payloadCostHint: "low" | "medium" | "high" =
    toolSet.length <= 2 ? "low" : toolSet.length <= 5 ? "medium" : "high";
  const anchorNodeId = stableNodeIdFromClientId(args.scopeKey, args.clientId);
  return MemoryAnchorV1Schema.parse({
    anchor_kind: "workflow",
    anchor_level: "L2",
    ...(workflowContract.contract_trust ? { contract_trust: workflowContract.contract_trust } : {}),
    task_signature: `replay_playbook:${args.playbookId}`,
    task_class: "replay_learning",
    ...(workflowContract.task_family ? { task_family: workflowContract.task_family } : {}),
    workflow_signature: args.workflowSignature,
    summary,
    tool_set: toolSet,
    key_steps: workflowContract.workflow_steps.length > 0 ? workflowContract.workflow_steps : deriveReplayLearningKeySteps(args.playbookSlots),
    ...(workflowContract.target_files.length > 0 ? { target_files: workflowContract.target_files } : {}),
    ...(workflowContract.next_action ? { next_action: workflowContract.next_action } : {}),
    ...(workflowContract.pattern_hints.length > 0 ? { pattern_hints: workflowContract.pattern_hints } : {}),
    ...(workflowContract.service_lifecycle_constraints.length > 0
      ? { service_lifecycle_constraints: workflowContract.service_lifecycle_constraints }
      : {}),
    outcome: {
      status: "success",
      result_class: "replay_learning_stable",
      success_score: 0.9,
    },
    source: {
      source_kind: "playbook",
      node_id: anchorNodeId,
      run_id: sourceRunId,
      playbook_id: args.playbookId,
      commit_id: args.sourceCommitId,
    },
    payload_refs: {
      node_ids: [args.sourceNodeId, args.episodeNodeId].filter((value): value is string => !!value),
      decision_ids: [],
      run_ids: sourceRunId ? [sourceRunId, ...createdFromRunIds.filter((runId) => runId !== sourceRunId)] : createdFromRunIds,
      step_ids: [],
      commit_ids: [args.sourceCommitId].filter((value): value is string => !!value),
    },
    rehydration: {
      default_mode: "partial",
      payload_cost_hint: payloadCostHint,
      recommended_when: [
        "workflow_summary_is_not_enough",
        "need_exact_replay_learning_episode_context",
        "irreversible_action_requires_exact_sequence",
      ],
    },
    recall_features: {
      tool_tags: toolSet,
      outcome_tags: ["replay_learning", "stable"],
      keywords: [args.playbookTitle, summary, args.playbookId].filter((value): value is string => !!value).slice(0, 8),
    },
    metrics: {
      usage_count: 0,
      reuse_success_count: 0,
      reuse_failure_count: 0,
      last_used_at: null,
    },
    maintenance: {
      ...buildWorkflowMaintenanceMetadata({
        promotion_state: "stable",
        at: args.promotedAt,
      }),
    },
    workflow_promotion: buildWorkflowPromotionMetadata({
      promotion_state: "stable",
      promotion_origin: "replay_learning_auto_promotion",
      required_observations: REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
      observed_count: args.observedCount,
      source_status: null,
      at: args.promotedAt,
    }),
    schema_version: "anchor_v1",
  });
}

export function buildReplayLearningProjectionArtifacts(args: {
  source: ReplayLearningProjectionSource;
  matcherFingerprint: string;
  policyFingerprint: string;
  duplicateRuleNodeId: string | null;
  workflowSignature: string;
  preferTools: string[];
  shouldCreateRule: boolean;
  shouldCreateEpisode: boolean;
  shouldPromoteStableWorkflow: boolean;
  observedWorkflowCount: number;
  projectedAt: string;
  ttlExpiresAt: string;
}): ReplayLearningProjectionArtifacts {
  const ruleClientId = `replay:learning:rule:${args.source.playbook_id}:${args.matcherFingerprint}:${args.policyFingerprint}`;
  const episodeClientId = `replay:learning:episode:${args.source.playbook_id}:v${args.source.playbook_version}`;
  const workflowClientId = `replay:learning:workflow:${args.source.playbook_id}:${args.workflowSignature}`;
  const rawWorkflowContract = deriveReplayWorkflowContractFromSlots(args.source.playbook_slots);
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const initialCandidateExecutionContract = buildReplayProjectionExecutionContract({
    base: rawWorkflowContract,
    task_signature: `replay_playbook:${args.source.playbook_id}`,
    workflow_signature: args.workflowSignature,
    source_anchor: episodeClientId,
    notes: ["replay_learning_candidate_projection"],
  });
  const initialAuthority = buildRuntimeAuthorityGate({
    executionContract: initialCandidateExecutionContract,
    requestedTrust: rawWorkflowContract.contract_trust,
    slots: args.source.playbook_slots,
    metrics: args.source.metrics,
  });
  const effectiveWorkflowTrust = downgradeAuthoritativeTrust({
    requestedTrust: rawWorkflowContract.contract_trust,
    authorityGate: initialAuthority.authorityGate,
  });
  const workflowContract =
    rawWorkflowContract.contract_trust !== effectiveWorkflowTrust
      ? {
          ...rawWorkflowContract,
          contract_trust: effectiveWorkflowTrust,
        }
      : rawWorkflowContract;
  const candidateExecutionContract = workflowContract === rawWorkflowContract
    ? initialCandidateExecutionContract
    : buildReplayProjectionExecutionContract({
        base: workflowContract,
        task_signature: `replay_playbook:${args.source.playbook_id}`,
        workflow_signature: args.workflowSignature,
        source_anchor: episodeClientId,
        notes: [
          "replay_learning_candidate_projection",
          "execution_evidence_downgraded_authoritative_contract",
        ],
      });
  const finalAuthority = workflowContract === rawWorkflowContract
    ? initialAuthority
    : buildRuntimeAuthorityGate({
        executionContract: candidateExecutionContract,
        requestedTrust: workflowContract.contract_trust,
        slots: args.source.playbook_slots,
        metrics: args.source.metrics,
      });
  const {
    authorityGate,
    outcomeContractGate,
    executionEvidence,
    executionEvidenceAssessment,
  } = finalAuthority;
  const shouldPromoteStableWorkflow =
    args.shouldPromoteStableWorkflow
    && authorityGate.allows_authoritative
    && authorityGate.allows_stable_promotion;

  if (args.shouldCreateRule) {
    nodes.push({
      client_id: ruleClientId,
      type: "rule",
      title: args.source.playbook_title ? `Replay Rule: ${args.source.playbook_title}` : `Replay Rule ${args.source.playbook_id.slice(0, 8)}`,
      text_summary: `Generated from replay playbook ${args.source.playbook_id} v${args.source.playbook_version}`,
      slots: {
        if: asObject(args.source.playbook_slots.matchers) ?? {},
        then: {
          tool: {
            prefer: args.preferTools,
          },
          extensions: {
            replay: {
              source: "replay_learning_v1",
              playbook_id: args.source.playbook_id,
              playbook_version: args.source.playbook_version,
            },
          },
        },
        exceptions: [],
        rule_scope: "global",
        replay_learning: {
          generated_by: "replay_learning_v1",
          source_playbook_id: args.source.playbook_id,
          source_playbook_version: args.source.playbook_version,
          source_playbook_node_id: args.source.playbook_node_id,
          matcher_fingerprint: args.matcherFingerprint,
          policy_fingerprint: args.policyFingerprint,
          projected_at: args.projectedAt,
        },
      },
    });
    edges.push({
      type: "derived_from",
      src: { client_id: ruleClientId },
      dst: { id: args.source.playbook_node_id },
    });
  }

  if (args.shouldCreateEpisode) {
    nodes.push({
      client_id: episodeClientId,
      type: "event",
      title: args.source.playbook_title ? `Replay Episode: ${args.source.playbook_title}` : `Replay Episode ${args.source.playbook_id.slice(0, 8)}`,
      text_summary:
        args.source.playbook_summary
        ?? `Replay repair learning episode for playbook ${args.source.playbook_id} v${args.source.playbook_version}`,
      slots: {
        replay_learning_episode: true,
        summary_kind: shouldPromoteStableWorkflow ? "replay_learning_episode" : "workflow_candidate",
        compression_layer: "L1",
        lifecycle_state: "active",
        ttl_expires_at: args.ttlExpiresAt,
        archive_candidate: true,
        execution_contract_v1: candidateExecutionContract,
        outcome_contract_gate: outcomeContractGate,
        ...(executionEvidence ? { execution_evidence_v1: executionEvidence } : {}),
        execution_evidence_assessment: executionEvidenceAssessment,
        authority_gate_v1: authorityGate,
        ...(!shouldPromoteStableWorkflow
          ? {
              execution_native_v1: {
                ...ExecutionNativeV1Schema.parse({
                  schema_version: "execution_native_v1",
                  execution_kind: "workflow_candidate",
                  summary_kind: "workflow_candidate",
                  compression_layer: "L1",
                  ...(workflowContract.contract_trust ? { contract_trust: workflowContract.contract_trust } : {}),
                  task_signature: `replay_playbook:${args.source.playbook_id}`,
                  ...(workflowContract.task_family ? { task_family: workflowContract.task_family } : {}),
                  workflow_signature: args.workflowSignature,
                  anchor_kind: "workflow",
                  anchor_level: "L1",
                  ...(workflowContract.target_files.length > 0 ? { target_files: workflowContract.target_files } : {}),
                  ...(workflowContract.next_action ? { next_action: workflowContract.next_action } : {}),
                  ...(workflowContract.workflow_steps.length > 0 ? { workflow_steps: workflowContract.workflow_steps } : {}),
                  ...(workflowContract.pattern_hints.length > 0 ? { pattern_hints: workflowContract.pattern_hints } : {}),
                  ...(workflowContract.service_lifecycle_constraints.length > 0
                    ? { service_lifecycle_constraints: workflowContract.service_lifecycle_constraints }
                    : {}),
                  outcome_contract_gate: outcomeContractGate,
                  workflow_promotion: buildWorkflowPromotionMetadata({
                    promotion_state: "candidate",
                    promotion_origin: "replay_learning_episode",
                    required_observations: REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
                    observed_count: args.observedWorkflowCount,
                    source_status: null,
                    at: args.projectedAt,
                  }),
                  maintenance: buildWorkflowMaintenanceMetadata({
                    promotion_state: "candidate",
                    at: args.projectedAt,
                  }),
                  distillation: buildDistillationMetadata({
                    source_kind: "replay_learning",
                    distillation_kind: "workflow_candidate",
                    at: args.projectedAt,
                    source_node_id: args.source.playbook_node_id,
                  }),
                }),
              },
            }
          : {}),
        ...(args.duplicateRuleNodeId ? { source_rule_node_id: args.duplicateRuleNodeId } : {}),
        replay_learning: {
          generated_by: "replay_learning_v1",
          source_playbook_id: args.source.playbook_id,
          source_playbook_version: args.source.playbook_version,
          source_playbook_node_id: args.source.playbook_node_id,
          source_commit_id: args.source.source_commit_id,
          ...(args.duplicateRuleNodeId ? { source_rule_node_id: args.duplicateRuleNodeId } : {}),
          matcher_fingerprint: args.matcherFingerprint,
          policy_fingerprint: args.policyFingerprint,
          projected_at: args.projectedAt,
        },
      },
    });
    edges.push({
      type: "derived_from",
      src: { client_id: episodeClientId },
      dst: { id: args.source.playbook_node_id },
    });
  }

  if (shouldPromoteStableWorkflow) {
    const episodeNodeId = args.shouldCreateEpisode ? stableNodeIdFromClientId(args.source.scope_key, episodeClientId) : null;
    const workflowAnchor = buildReplayLearningStableWorkflowAnchor({
      scopeKey: args.source.scope_key,
      clientId: workflowClientId,
      playbookId: args.source.playbook_id,
      playbookTitle: args.source.playbook_title,
      playbookSummary: args.source.playbook_summary,
      playbookSlots: args.source.playbook_slots,
      sourceNodeId: args.source.playbook_node_id,
      sourceCommitId: args.source.source_commit_id,
      workflowSignature: args.workflowSignature,
      observedCount: args.observedWorkflowCount,
      episodeNodeId,
      promotedAt: args.projectedAt,
    });
    const stableExecutionContract = buildReplayProjectionExecutionContract({
      base: workflowContract,
      task_signature: workflowAnchor.task_signature,
      workflow_signature: workflowAnchor.workflow_signature ?? args.workflowSignature,
      source_anchor: workflowClientId,
      file_path: workflowAnchor.file_path ?? null,
      notes: ["replay_learning_stable_projection"],
    });
    const {
      authorityGate: stableAuthorityGate,
      outcomeContractGate: stableOutcomeContractGate,
      executionEvidence: stableExecutionEvidence,
      executionEvidenceAssessment: stableExecutionEvidenceAssessment,
    } = buildRuntimeAuthorityGate({
      executionContract: stableExecutionContract,
      requestedTrust: workflowContract.contract_trust,
      slots: args.source.playbook_slots,
      metrics: args.source.metrics,
      evidence: executionEvidence,
    });
    const stableWorkflowNodeId = stableNodeIdFromClientId(args.source.scope_key, workflowClientId);
    const policyMutation = buildPolicyMutationFromWorkflowPromotion({
      scope: args.source.scope,
      workflow_memory_id: stableWorkflowNodeId,
      workflow_signature: workflowAnchor.workflow_signature ?? args.workflowSignature,
      task_signature: workflowAnchor.task_signature,
      source_node_id: args.source.playbook_node_id,
      origin: "replay_learning_projection",
      observed_count: args.observedWorkflowCount,
      required_observations: REPLAY_LEARNING_WORKFLOW_REQUIRED_OBSERVATIONS,
      authority_gate_allows_stable_promotion: stableAuthorityGate.allows_stable_promotion,
      learning_control_admissible: true,
      runtime_apply_changed_promotion_state: true,
      execution_evidence_status: stableExecutionEvidenceAssessment.status,
      execution_evidence_refs: stableExecutionEvidence?.evidence_refs ?? [],
    });
    const policyMutationAdjudication = adjudicatePolicyMutationV1(policyMutation);
    nodes.push({
      client_id: workflowClientId,
      type: "procedure",
      title: args.source.playbook_title ? `Replay Learned Workflow: ${args.source.playbook_title}` : `Replay Learned Workflow ${args.source.playbook_id.slice(0, 8)}`,
      text_summary: workflowAnchor.summary,
      slots: {
        summary_kind: "workflow_anchor",
        compression_layer: "L2",
        anchor_v1: workflowAnchor,
        execution_contract_v1: stableExecutionContract,
        outcome_contract_gate: stableOutcomeContractGate,
        ...(stableExecutionEvidence ? { execution_evidence_v1: stableExecutionEvidence } : {}),
        execution_evidence_assessment: stableExecutionEvidenceAssessment,
        authority_gate_v1: stableAuthorityGate,
        policy_mutation_v1: policyMutation,
        policy_mutation_adjudication_v1: policyMutationAdjudication,
        execution_native_v1: ExecutionNativeV1Schema.parse({
          schema_version: "execution_native_v1",
          execution_kind: "workflow_anchor",
          summary_kind: "workflow_anchor",
          compression_layer: "L2",
          ...(workflowContract.contract_trust ? { contract_trust: workflowContract.contract_trust } : {}),
          task_signature: workflowAnchor.task_signature,
          ...(workflowAnchor.task_family ? { task_family: workflowAnchor.task_family } : {}),
          workflow_signature: workflowAnchor.workflow_signature,
          anchor_kind: "workflow",
          anchor_level: "L2",
          ...(workflowAnchor.target_files ? { target_files: workflowAnchor.target_files } : {}),
          ...(workflowAnchor.next_action !== undefined ? { next_action: workflowAnchor.next_action } : {}),
          ...(workflowAnchor.key_steps ? { workflow_steps: workflowAnchor.key_steps } : {}),
          ...(workflowAnchor.pattern_hints ? { pattern_hints: workflowAnchor.pattern_hints } : {}),
          ...(workflowAnchor.service_lifecycle_constraints
            ? { service_lifecycle_constraints: workflowAnchor.service_lifecycle_constraints }
            : {}),
          outcome_contract_gate: stableOutcomeContractGate,
          workflow_promotion: workflowAnchor.workflow_promotion,
          maintenance: workflowAnchor.maintenance,
          rehydration: workflowAnchor.rehydration,
          distillation: buildDistillationMetadata({
            source_kind: "replay_learning",
            distillation_kind: "workflow_candidate",
            at: args.projectedAt,
            source_node_id: args.source.playbook_node_id,
          }),
        }),
        replay_learning: {
          generated_by: "replay_learning_v1",
          source_playbook_id: args.source.playbook_id,
          promoted_from_playbook_version: args.source.playbook_version,
          source_playbook_node_id: args.source.playbook_node_id,
          source_commit_id: args.source.source_commit_id,
          workflow_signature: args.workflowSignature,
          observed_count: args.observedWorkflowCount,
          promoted_at: args.projectedAt,
        },
      },
    });
    edges.push({
      type: "derived_from",
      src: { client_id: workflowClientId },
      dst: { id: args.source.playbook_node_id },
    });
    if (args.shouldCreateEpisode) {
      edges.push({
        type: "derived_from",
        src: { client_id: workflowClientId },
        dst: { client_id: episodeClientId },
      });
    }
  }

  return {
    ruleClientId,
    episodeClientId,
    workflowClientId,
    nodes,
    edges,
    shouldPromoteStableWorkflow,
  };
}
