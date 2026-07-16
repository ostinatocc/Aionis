import { randomUUID } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { stableUuid } from "../util/uuid.js";
import { badRequest, HttpError } from "../util/http.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import {
  hashExecutionContext,
  hashPolicy,
  normalizeToolCandidates,
  uniqueRuleIds,
} from "./execution-provenance.js";
import {
  buildMaterializationContextFromFeedback,
  decideToolsFeedbackLearning,
  extractWorkflowFeedbackTarget,
  resolveFeedbackContractTrustForMaterialization,
  shouldMaterializePolicyMemoryFromContractTrust,
  type WorkflowFeedbackTarget,
} from "../kernel/learning-decision-kernel.js";
import {
  DerivedPolicySurfaceSchema,
  ExperienceIntelligenceRequest,
  MemoryFormPatternRequest,
  PolicyContractSchema,
  ToolsFeedbackRequest,
  ToolsFeedbackResponseSchema,
  type ContractTrust,
  type MemoryFormPatternSemanticReviewResult,
  type MemoryAnchorV1,
  type ToolsFeedbackInput,
  type ToolsFeedbackLearningControlInput,
  type ToolsFeedbackFormPatternLearningControlDecisionTrace,
  type ToolsFeedbackLearningControlPreview,
  type ToolsFeedbackResponse,
} from "./schemas.js";
import type { FormPatternLearningControlReviewProvider } from "./learning-control-provider-types.js";
import { buildExecutionMemoryIntrospectionLite } from "./execution-introspection.js";
import { buildPolicyMaterializationSurface } from "./policy-materialization-surface.js";
import { evaluateRulesAppliedOnly } from "./rules-evaluate.js";
import { resolveTenantScope } from "./tenant.js";
import { buildAionisUri, parseAionisUri } from "./uri.js";
import {
  persistPreparedToolsDecisionPatternAnchor,
  prepareToolsDecisionPatternAnchor,
  type PreparedToolsDecisionPatternAnchor,
} from "./tools-pattern-anchor.js";
import {
  persistPreparedPolicyMemoryFeedback,
  persistPreparedPolicyMemorySnapshot,
  preparePolicyMemoryFeedbackLite,
  preparePolicyMemorySnapshot,
  type PreparedPolicyMemoryFeedback,
  type PreparedPolicyMemorySnapshot,
} from "./policy-memory.js";
import { normalizeContractTrust as normalizeContractTrustValue } from "./contract-trust.js";
import { extractExecutionEvidenceFromSlots } from "./execution-evidence.js";
import {
  appendLearningControlRuntimePolicyAppliedStage,
  buildControlledStateDecisionTrace,
  deriveControlledStateRaiseRuntimeApply,
} from "./learning-control-shared.js";
import {
  buildFormPatternSemanticReviewPacket,
  deriveFormPatternLearningControlPolicyEffect,
} from "./learning-control-form-pattern.js";
import { runFormPatternLearningControlPreview } from "./learning-control-form-pattern-shared.js";
import type { LiteRuleCandidateRow, LiteWriteStore } from "../store/lite-write-store.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { WriteStoreAccess } from "../store/write-access.js";
import { completeLiteInlineEmbeddings } from "./lite-projected-write-commit.js";
import type { PreparedWrite } from "./write.js";
import {
  buildToolRuleEvaluationSource,
  readToolRuleEvaluationProvenance,
  type ToolRuleEvaluationProvenance,
  type ToolRuleEvaluationSource,
} from "./tool-rule-evaluation-provenance.js";

export { buildMaterializationContextFromFeedback } from "../kernel/learning-decision-kernel.js";

type FeedbackOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  embedder?: EmbeddingProvider | null;
  learningControlReviewProviders?: {
    form_pattern?: FormPatternLearningControlReviewProvider | null;
  };
  recallAccess?: RecallStoreAccess | null;
  liteWriteStore?: LiteWriteStore | null;
};

type DecisionRow = {
  id: string;
  scope: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: any;
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
  commit_id: string | null;
};

type LiteNodeLookup = Pick<LiteWriteStore, "findNodes">;

function isToolTouched(paths: string[]): boolean {
  for (const p of paths) {
    if (p === "tool" || p.startsWith("tool.")) return true;
  }
  return false;
}

function sameRuleIds(left: readonly string[], right: readonly string[]): boolean {
  return stableStringify([...new Set(left)].sort()) === stableStringify([...new Set(right)].sort());
}

function normalizeToolName(v: string): string {
  return String(v ?? "").trim();
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const next = nullableString(item);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function serviceLifecycleList(value: unknown, limit = 16): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const key = [
      nullableString(record.label) ?? "",
      nullableString(record.endpoint) ?? "",
      nullableString(record.launch_reference) ?? "",
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
    if (out.length >= limit) break;
  }
  return out;
}

function extractContextConsumerAgentId(context: unknown): string | null {
  const ctx = asRecord(context);
  const agent = asRecord(ctx?.agent);
  return nullableString(ctx?.agent_id) ?? nullableString(agent?.id);
}

function extractContextConsumerTeamId(context: unknown): string | null {
  const ctx = asRecord(context);
  const agent = asRecord(ctx?.agent);
  return nullableString(ctx?.team_id) ?? nullableString(agent?.team_id);
}

function buildExperienceQueryTextFromFeedback(args: {
  context: unknown;
  inputText: string | null;
  note: string | null;
  selectedTool: string;
  workflowFeedbackTarget: WorkflowFeedbackTarget;
}): string {
  const ctx = asRecord(args.context);
  const task = asRecord(ctx?.task);
  const error = asRecord(ctx?.error);
  const values = [
    nullableString(ctx?.goal),
    nullableString(task?.goal),
    nullableString(ctx?.objective),
    nullableString(task?.objective),
    nullableString(ctx?.task_signature),
    nullableString(task?.signature),
    args.workflowFeedbackTarget.taskFamily,
    nullableString(ctx?.workflow_signature),
    args.workflowFeedbackTarget.workflowSignature,
    args.workflowFeedbackTarget.filePath,
    args.workflowFeedbackTarget.nextAction,
    args.workflowFeedbackTarget.targetFiles.join(" "),
    args.workflowFeedbackTarget.workflowSteps.join(" "),
    args.workflowFeedbackTarget.patternHints.join(" "),
    nullableString(error?.signature),
    nullableString(error?.code),
    args.note,
    args.inputText,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length === 0) return `feedback policy snapshot for ${args.selectedTool}`;
  return values.slice(0, 8).join(" | ");
}

function mergeWorkflowFeedbackIntoPolicySurfaces(args: {
  policyContract: Record<string, unknown>;
  derivedPolicy: Record<string, unknown>;
  workflowFeedbackTarget: WorkflowFeedbackTarget;
  contractTrust: ContractTrust | null;
}) {
  const contractTrust =
    args.contractTrust
    ?? normalizeContractTrustValue(args.policyContract.contract_trust)
    ?? normalizeContractTrustValue(args.derivedPolicy.contract_trust)
    ?? null;
  const targetFiles =
    stringList(args.policyContract.target_files, 24).length > 0
      ? stringList(args.policyContract.target_files, 24)
      : stringList(args.derivedPolicy.target_files, 24).length > 0
        ? stringList(args.derivedPolicy.target_files, 24)
        : args.workflowFeedbackTarget.targetFiles;
  const filePath =
    nullableString(args.policyContract.file_path)
    ?? nullableString(args.derivedPolicy.file_path)
    ?? args.workflowFeedbackTarget.filePath;
  const nextAction =
    nullableString(args.policyContract.next_action)
    ?? args.workflowFeedbackTarget.nextAction;
  const workflowSignature =
    nullableString(args.policyContract.workflow_signature)
    ?? nullableString(args.derivedPolicy.workflow_signature)
    ?? args.workflowFeedbackTarget.workflowSignature;
  const taskFamily =
    nullableString(args.policyContract.task_family)
    ?? nullableString(args.derivedPolicy.task_family)
    ?? args.workflowFeedbackTarget.taskFamily;
  const workflowSteps =
    stringList(args.policyContract.workflow_steps, 24).length > 0
      ? stringList(args.policyContract.workflow_steps, 24)
      : Array.isArray(args.derivedPolicy.workflow_steps)
        ? stringList(args.derivedPolicy.workflow_steps, 24)
        : args.workflowFeedbackTarget.workflowSteps;
  const patternHints =
    Array.isArray(args.policyContract.pattern_hints) && args.policyContract.pattern_hints.length > 0
      ? stringList(args.policyContract.pattern_hints, 24)
      : Array.isArray(args.derivedPolicy.pattern_hints)
        ? stringList(args.derivedPolicy.pattern_hints, 24)
        : args.workflowFeedbackTarget.patternHints;
  const serviceLifecycleConstraints =
    Array.isArray(args.policyContract.service_lifecycle_constraints) && args.policyContract.service_lifecycle_constraints.length > 0
      ? serviceLifecycleList(args.policyContract.service_lifecycle_constraints, 16)
      : Array.isArray(args.derivedPolicy.service_lifecycle_constraints) && args.derivedPolicy.service_lifecycle_constraints.length > 0
        ? serviceLifecycleList(args.derivedPolicy.service_lifecycle_constraints, 16)
        : args.workflowFeedbackTarget.serviceLifecycleConstraints;

  return {
    policyContract: PolicyContractSchema.parse({
      ...args.policyContract,
      ...(contractTrust ? { contract_trust: contractTrust } : {}),
      ...(contractTrust === "advisory" ? { policy_state: "candidate", activation_mode: "hint" } : {}),
      ...(taskFamily ? { task_family: taskFamily } : {}),
      ...(workflowSignature ? { workflow_signature: workflowSignature } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      target_files: targetFiles,
      ...(nextAction ? { next_action: nextAction } : {}),
      ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
      ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
      ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    }),
    derivedPolicy: DerivedPolicySurfaceSchema.parse({
      ...args.derivedPolicy,
      ...(contractTrust ? { contract_trust: contractTrust } : {}),
      ...(contractTrust === "advisory" ? { policy_state: "candidate" } : {}),
      ...(taskFamily ? { task_family: taskFamily } : {}),
      ...(workflowSignature ? { workflow_signature: workflowSignature } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      target_files: targetFiles,
      ...(workflowSteps.length > 0 ? { workflow_steps: workflowSteps } : {}),
      ...(patternHints.length > 0 ? { pattern_hints: patternHints } : {}),
      ...(serviceLifecycleConstraints.length > 0 ? { service_lifecycle_constraints: serviceLifecycleConstraints } : {}),
    }),
  };
}

type PreparedFeedbackPolicyMaterialization = {
  prepared: PreparedPolicyMemorySnapshot;
  response: NonNullable<ToolsFeedbackResponse["policy_memory"]>;
};

async function prepareLitePolicyMemoryFromFeedback(args: {
  parsed: ToolsFeedbackInput;
  tenancy: { tenant_id: string; scope: string };
  actor: string;
  inputText: string | null;
  note: string | null;
  inputSha: string;
  selectedTool: string;
  normalizedCandidates: string[];
  workflowFeedbackTarget: WorkflowFeedbackTarget;
  commitId: string;
  defaultScope: string;
  defaultTenantId: string;
  opts: FeedbackOptions;
  prospectivePattern?: PreparedToolsDecisionPatternAnchor | null;
}): Promise<PreparedFeedbackPolicyMaterialization | null> {
  if (!args.opts.liteWriteStore) return null;
  const contractTrust = resolveFeedbackContractTrustForMaterialization(args.parsed.context);
  if (!shouldMaterializePolicyMemoryFromContractTrust(contractTrust)) return null;

  const consumerAgentId = extractContextConsumerAgentId(args.parsed.context) ?? args.actor;
  const consumerTeamId = extractContextConsumerTeamId(args.parsed.context);
  const queryText = buildExperienceQueryTextFromFeedback({
    context: args.parsed.context,
    inputText: args.inputText,
    note: args.note,
    selectedTool: args.selectedTool,
    workflowFeedbackTarget: args.workflowFeedbackTarget,
  });
  const materializationContext = buildMaterializationContextFromFeedback({
    context: args.parsed.context,
    workflowFeedbackTarget: args.workflowFeedbackTarget,
  });
  const experienceParsed = ExperienceIntelligenceRequest.parse({
    tenant_id: args.tenancy.tenant_id,
    scope: args.tenancy.scope,
    consumer_agent_id: consumerAgentId ?? undefined,
    consumer_team_id: consumerTeamId ?? undefined,
    run_id: args.parsed.run_id,
    query_text: queryText,
    context: materializationContext,
    candidates: args.normalizedCandidates,
    include_shadow: args.parsed.include_shadow,
    rules_limit: args.parsed.rules_limit,
    strict: true,
    reorder_candidates: true,
    workflow_limit: 8,
  });
  const baseIntrospection = await buildExecutionMemoryIntrospectionLite(
    args.opts.liteWriteStore as LiteWriteStore,
    {
      tenant_id: args.tenancy.tenant_id,
      scope: args.tenancy.scope,
      consumer_agent_id: consumerAgentId ?? undefined,
      consumer_team_id: consumerTeamId ?? undefined,
      limit: experienceParsed.workflow_limit,
    },
    args.defaultScope,
    args.defaultTenantId,
    consumerAgentId ?? null,
  );
  const prospectivePattern = args.prospectivePattern?.result ?? null;
  const prospectivePatternSlots = args.prospectivePattern?.update?.slots
    ?? args.prospectivePattern?.prepared_write?.nodes[0]?.slots
    ?? null;
  const prospectivePatternEntry = prospectivePattern
    ? {
        anchor_id: prospectivePattern.node_id,
        anchor_level: prospectivePattern.anchor.anchor_level,
        selected_tool: prospectivePattern.anchor.selected_tool,
        task_family: prospectivePattern.anchor.task_family ?? null,
        pattern_state: prospectivePattern.anchor.pattern_state ?? "provisional",
        credibility_state: prospectivePattern.anchor.credibility_state ?? "candidate",
        trusted: (prospectivePattern.anchor.credibility_state ?? "candidate") === "trusted",
        summary: prospectivePattern.anchor.summary,
        contract_trust: prospectivePattern.anchor.contract_trust ?? null,
        execution_contract_v1: prospectivePatternSlots?.execution_contract_v1 ?? null,
        confidence: args.prospectivePattern?.update?.confidence
          ?? args.prospectivePattern?.prepared_write?.nodes[0]?.confidence
          ?? null,
      }
    : null;
  const introspection = prospectivePatternEntry
    ? {
        ...baseIntrospection,
        trusted_patterns: [
          ...(Array.isArray(baseIntrospection.trusted_patterns)
            ? baseIntrospection.trusted_patterns.filter((entry) => entry.anchor_id !== prospectivePatternEntry.anchor_id)
            : []),
          ...(prospectivePatternEntry.trusted ? [prospectivePatternEntry] : []),
        ],
        contested_patterns: [
          ...(Array.isArray(baseIntrospection.contested_patterns)
            ? baseIntrospection.contested_patterns.filter((entry) => entry.anchor_id !== prospectivePatternEntry.anchor_id)
            : []),
          ...(prospectivePatternEntry.credibility_state === "contested" ? [prospectivePatternEntry] : []),
        ],
      }
    : baseIntrospection;
  const trustedPatternAnchorIds = (Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : [])
    .filter((entry) => nullableString((entry as Record<string, unknown>)?.selected_tool) === args.selectedTool)
    .map((entry) => nullableString((entry as Record<string, unknown>)?.anchor_id))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const contestedPatternAnchorIds = (Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : [])
    .filter((entry) => nullableString((entry as Record<string, unknown>)?.selected_tool) === args.selectedTool)
    .map((entry) => nullableString((entry as Record<string, unknown>)?.anchor_id))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (prospectivePattern?.anchor.selected_tool === args.selectedTool) {
    const target = (prospectivePattern.anchor.credibility_state ?? "candidate") === "contested"
      ? contestedPatternAnchorIds
      : (prospectivePattern.anchor.pattern_state ?? "provisional") === "stable"
        ? trustedPatternAnchorIds
        : null;
    if (target && !target.includes(prospectivePattern.node_id)) target.push(prospectivePattern.node_id);
  }
  const tools = {
    tenant_id: args.tenancy.tenant_id,
    scope: args.tenancy.scope,
    candidates: args.normalizedCandidates,
    selection: {
      selected: args.selectedTool,
      ordered: args.normalizedCandidates,
      preferred: [args.selectedTool],
      allowed: args.normalizedCandidates,
      denied: [],
    },
    execution_kernel: {},
    rules: {
      considered: 0,
      matched: 0,
    },
    pattern_matches: {
      matched: trustedPatternAnchorIds.length + contestedPatternAnchorIds.length,
      trusted: trustedPatternAnchorIds.length,
      preferred_tools: trustedPatternAnchorIds.length > 0 ? [args.selectedTool] : [],
      anchors: [],
    },
    decision: {
      decision_id: args.commitId,
      decision_uri: buildAionisUri({
        tenant_id: args.tenancy.tenant_id,
        scope: args.tenancy.scope,
        type: "decision",
        id: args.commitId,
      }),
      run_id: args.parsed.run_id ?? null,
      selected_tool: args.selectedTool,
      source_rule_ids: [],
      pattern_summary: {
        matched_pattern_count: trustedPatternAnchorIds.length + contestedPatternAnchorIds.length,
        trusted_pattern_count: trustedPatternAnchorIds.length,
        contested_pattern_count: contestedPatternAnchorIds.length,
        used_trusted_pattern_anchor_ids: trustedPatternAnchorIds,
        skipped_contested_pattern_anchor_ids: contestedPatternAnchorIds,
        skipped_suppressed_pattern_anchor_ids: [],
      },
    },
    selection_summary: {
      selected_tool: args.selectedTool,
      ordered_candidates: args.normalizedCandidates,
      allowed_candidates: args.normalizedCandidates,
      denied_candidates: [],
      preferred_candidates: trustedPatternAnchorIds.length > 0 ? [args.selectedTool] : [],
      strict_mode_applied: true,
      selection_source: trustedPatternAnchorIds.length > 0 ? "trusted_pattern" : "feedback_materialization",
      provenance_explanation: trustedPatternAnchorIds.length > 0
        ? `selected tool: ${args.selectedTool}; trusted pattern support available during policy-memory materialization`
        : `selected tool: ${args.selectedTool}; feedback-confirmed materialization path`,
    },
  };
  const policyMaterialization = buildPolicyMaterializationSurface({
    parsed: experienceParsed,
    tools: tools as any,
    introspection,
  });
  if (!policyMaterialization.policyContract || !policyMaterialization.derivedPolicy) return null;
  if (policyMaterialization.policyContract.selected_tool !== args.selectedTool) return null;
  const enrichedPolicy = mergeWorkflowFeedbackIntoPolicySurfaces({
    policyContract: policyMaterialization.policyContract as Record<string, unknown>,
    derivedPolicy: policyMaterialization.derivedPolicy as Record<string, unknown>,
    workflowFeedbackTarget: args.workflowFeedbackTarget,
    contractTrust,
  });
  const executionEvidence = extractExecutionEvidenceFromSlots({
    slots: materializationContext,
  });
  const policyContractWithEvidence = PolicyContractSchema.parse({
    ...enrichedPolicy.policyContract,
    ...(executionEvidence ? { execution_evidence_v1: executionEvidence } : {}),
  });

  const prepared = await preparePolicyMemorySnapshot({
    tenant_id: args.tenancy.tenant_id,
    scope: args.tenancy.scope,
    actor: args.actor,
    input_text: queryText,
    input_sha256: args.inputSha,
    task_signature: args.workflowFeedbackTarget.taskSignature,
    error_signature: args.workflowFeedbackTarget.errorSignature,
    workflow_signature: args.workflowFeedbackTarget.workflowSignature,
    policy_contract: policyContractWithEvidence,
    derived_policy: enrichedPolicy.derivedPolicy,
    feedback_commit_id: args.commitId,
  }, {
    defaultScope: args.defaultScope,
    defaultTenantId: args.defaultTenantId,
    maxTextLen: args.opts.maxTextLen,
    piiRedaction: args.opts.piiRedaction,
    embedder: args.opts.embedder ?? null,
    writeAccess: args.opts.liteWriteStore as unknown as WriteStoreAccess,
    liteWriteStore: args.opts.liteWriteStore,
  });

  return {
    prepared,
    response: {
    node_id: prepared.result.node_id,
    node_uri: buildAionisUri({
      tenant_id: args.tenancy.tenant_id,
      scope: args.tenancy.scope,
      type: "concept",
      id: prepared.result.node_id,
    }),
    client_id: prepared.result.client_id,
    policy_memory_signature: prepared.result.policy_memory_signature,
    selected_tool: prepared.result.policy_contract.selected_tool,
    policy_state: prepared.result.policy_contract.policy_state,
    policy_memory_state: prepared.result.policy_contract.policy_memory_state,
    activation_mode: prepared.result.policy_contract.activation_mode,
    policy_contract: prepared.result.policy_contract,
    },
  };
}

async function lookupLiteNodeExample(
  liteWriteStore: LiteNodeLookup,
  scope: string,
  nodeId: string,
): Promise<{ node_id: string; title?: string | null; summary?: string | null } | null> {
  const { rows } = await liteWriteStore.findNodes({
    scope,
    id: nodeId,
    consumerAgentId: null,
    consumerTeamId: null,
    limit: 1,
    offset: 0,
  });
  const row = rows[0];
  if (!row) return null;
  return {
    node_id: nodeId,
    title: nullableString(row.title),
    summary: nullableString(row.text_summary),
  };
}

async function buildToolsFeedbackFormPatternLearningControlPreview(args: {
  liteWriteStore: LiteNodeLookup;
  scope: string;
  inputText: string | null;
  inputSha256: string;
  sourceRuleIds: string[];
  anchor: MemoryAnchorV1;
  learningControlReview?: ToolsFeedbackLearningControlInput["form_pattern"] | null;
  reviewProvider?: FormPatternLearningControlReviewProvider | null;
}): Promise<ToolsFeedbackLearningControlPreview | null> {
  const sourceNodeIds = uniqueRuleIds(args.sourceRuleIds).slice(0, 6);
  if (sourceNodeIds.length < 2) return null;

  const input = MemoryFormPatternRequest.parse({
    source_node_ids: sourceNodeIds,
    ...(nullableString(args.anchor.task_signature)
      ? { task_signature: nullableString(args.anchor.task_signature)! }
      : {}),
    ...(nullableString(args.anchor.error_signature)
      ? { error_signature: nullableString(args.anchor.error_signature)! }
      : {}),
    ...(nullableString(args.anchor.pattern_signature)
      ? { pattern_signature: nullableString(args.anchor.pattern_signature)! }
      : {}),
    input_text: args.inputText ?? args.anchor.summary ?? "form pattern from tools feedback",
    input_sha256: args.inputSha256,
  });

  const sourceExamples = (
    await Promise.all(sourceNodeIds.map((nodeId) => lookupLiteNodeExample(args.liteWriteStore, args.scope, nodeId)))
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return {
    form_pattern: await runFormPatternLearningControlPreview({
      input,
      sourceExamples,
      reviewResult: args.learningControlReview?.review_result ?? null,
      reviewProvider: args.reviewProvider ?? undefined,
      derivePolicyEffect: ({ review, admissibility }) =>
        deriveFormPatternLearningControlPolicyEffect({
          basePatternState: args.anchor.pattern_state ?? "provisional",
          review,
          admissibility,
        }),
      buildDecisionTrace: ({ reviewResult, admissibility, policyEffect }) => {
        const trace = buildControlledStateDecisionTrace({
          reviewResult,
          admissibility,
          policyEffect,
          includePolicyEffectReasonCode: !policyEffect.applies,
          baseState: policyEffect.base_pattern_state,
          effectiveState: policyEffect.effective_pattern_state,
        });
        return {
          ...trace,
          trace_version: "form_pattern_learning_control_trace_v1",
          base_pattern_state: trace.baseState,
          effective_pattern_state: trace.effectiveState,
          runtime_apply_changed_pattern_state: false,
          stage_order: trace.stage_order as ToolsFeedbackFormPatternLearningControlDecisionTrace["stage_order"],
          reason_codes: trace.reason_codes,
        };
      },
    }),
  };
}

function assertDecisionCompatible(
  decision: DecisionRow,
  parsed: { run_id?: string; selected_tool: string; decision_id?: string },
  normalizedCandidates: string[],
) {
  const selectedTool = normalizeToolName(parsed.selected_tool);
  if ((decision.selected_tool ?? "") !== selectedTool) {
    badRequest("decision_selected_tool_mismatch", "decision_id does not match selected_tool", {
      decision_id: parsed.decision_id,
      decision_selected_tool: decision.selected_tool,
      request_selected_tool: selectedTool,
    });
  }

  const wantCandidates = stableStringify(normalizedCandidates);
  const gotCandidates = stableStringify(Array.isArray(decision.candidates_json) ? decision.candidates_json : []);
  if (wantCandidates !== gotCandidates) {
    badRequest("decision_candidates_mismatch", "decision_id does not match candidates", {
      decision_id: parsed.decision_id,
    });
  }

  if (parsed.run_id && decision.run_id && parsed.run_id !== decision.run_id) {
    badRequest("decision_run_id_mismatch", "decision_id run_id does not match feedback run_id", {
      decision_id: parsed.decision_id,
      decision_run_id: decision.run_id,
      request_run_id: parsed.run_id,
    });
  }
}

function decisionRowSha256(decision: DecisionRow | null): string | null {
  return decision ? sha256Hex(stableStringify(decision)) : null;
}

function sourceRuleIdsFromEvaluation(
  provenance: ToolRuleEvaluationProvenance,
  includeShadow: boolean,
  target: "tool" | "all",
): string[] {
  const sources = includeShadow
    ? [...provenance.active_sources, ...provenance.shadow_sources]
    : provenance.active_sources;
  return uniqueRuleIds(
    sources
      .filter((source) => target === "all" || isToolTouched(source.touched_paths))
      .map((source) => source.rule_node_id),
  );
}

async function findToolRuleEvaluationDrift(
  provenance: ToolRuleEvaluationProvenance,
  attributedRuleNodeIds: readonly string[],
  scope: string,
  liteWriteStore: LiteWriteStore,
): Promise<{ rule_node_id: string; reason: string } | null> {
  const attributedRuleNodeIdSet = new Set(attributedRuleNodeIds);
  const provenanceSources = [...provenance.active_sources, ...provenance.shadow_sources];
  const provenanceSourceById = new Map(provenanceSources.map((source) => [source.rule_node_id, source]));
  const missingRuleNodeId = [...attributedRuleNodeIdSet]
    .find((ruleNodeId) => !provenanceSourceById.has(ruleNodeId));
  if (missingRuleNodeId) return { rule_node_id: missingRuleNodeId, reason: "rule_not_in_served_provenance" };
  const expectedSources = provenanceSources.filter((source) => attributedRuleNodeIdSet.has(source.rule_node_id));
  for (const expected of expectedSources) {
    const row = await liteWriteStore.getRuleDef(scope, expected.rule_node_id);
    if (!row) return { rule_node_id: expected.rule_node_id, reason: "rule_missing" };
    let current: ToolRuleEvaluationSource;
    try {
      current = buildToolRuleEvaluationSource(row);
    } catch {
      return { rule_node_id: expected.rule_node_id, reason: "rule_invalid" };
    }
    if (stableStringify(current) !== stableStringify(expected)) {
      return { rule_node_id: expected.rule_node_id, reason: "rule_changed" };
    }
  }
  return null;
}

type PreparedDecisionPlan = {
  expected_sha256: string | null;
  create: boolean;
  decision_link_mode: "provided" | "inferred" | "created_from_feedback";
  before: DecisionRow | null;
  after: DecisionRow;
};

type PreparedRuleFeedbackInsert = {
  id: string;
  rule_node_id: string;
};

export type PreparedToolSelectionFeedback = {
  schema_version: "prepared_tool_selection_feedback_v1";
  parsed: ToolsFeedbackInput;
  default_scope: string;
  default_tenant_id: string;
  tenant_id: string;
  scope: string;
  scope_key: string;
  actor: string;
  normalized_candidates: string[];
  selected_tool: string;
  input_text: string | null;
  input_sha256: string;
  note: string | null;
  workflow_feedback_target: WorkflowFeedbackTarget;
  source_rule_ids: string[];
  rules_applied_sha256: string;
  served_rule_evaluation: ToolRuleEvaluationProvenance | null;
  context_sha256: string;
  policy_sha256: string;
  decision: PreparedDecisionPlan;
  parent_commit_id: string | null;
  parent_commit_hash: string;
  commit_id: string;
  commit_hash: string;
  commit_diff_json: string;
  feedback_created_at: string;
  rule_feedback: PreparedRuleFeedbackInsert[];
  pattern: PreparedToolsDecisionPatternAnchor | null;
  policy_snapshot: PreparedPolicyMemorySnapshot | null;
  policy_feedback: PreparedPolicyMemoryFeedback | null;
  policy_materialized_response: ToolsFeedbackResponse["policy_memory"] | null;
  learning_control_preview: ToolsFeedbackLearningControlPreview | null;
};

export type ToolSelectionFeedbackFinalizePlan = {
  prepared_writes: PreparedWrite[];
};

export type PersistedToolSelectionFeedback = {
  response: ToolsFeedbackResponse;
  run_id: string | null;
  decision_id: string;
  commit_id: string;
  commit_hash: string;
  finalize_plan: ToolSelectionFeedbackFinalizePlan;
};

export type ToolSelectionFeedbackFinalizeResult = {
  embeddings: Array<{
    attempted: number;
    updated: number;
    failed: number;
    error?: string;
  }>;
};

function patternResponse(
  prepared: PreparedToolsDecisionPatternAnchor | null,
  tenantId: string,
  scope: string,
): ToolsFeedbackResponse["pattern_anchor"] | null {
  if (!prepared) return null;
  const out = prepared.result;
  return {
    node_id: out.node_id,
    node_uri: buildAionisUri({
      tenant_id: tenantId,
      scope,
      type: "concept",
      id: out.node_id,
    }),
    client_id: out.client_id,
    pattern_signature: out.pattern_signature,
    anchor_kind: "pattern",
    anchor_level: "L3",
    pattern_state: out.anchor.pattern_state ?? "provisional",
    credibility_state: out.anchor.credibility_state ?? "candidate",
    maintenance: out.anchor.maintenance ?? undefined,
    promotion: out.anchor.promotion ?? undefined,
    promotion_evidence_ledger_v1: out.anchor.promotion_evidence_ledger_v1 ?? undefined,
  };
}

export async function prepareToolSelectionFeedback(
  _client: null,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: FeedbackOptions,
): Promise<PreparedToolSelectionFeedback> {
  const parsed = ToolsFeedbackRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  let linkedDecisionId = parsed.decision_id ?? null;
  if (parsed.decision_uri) {
    const uriParts = parseAionisUri(parsed.decision_uri);
    if (uriParts.type !== "decision") {
      badRequest("invalid_decision_uri_type", "decision_uri must use type=decision", {
        decision_uri: parsed.decision_uri,
        type: uriParts.type,
      });
    }
    if (uriParts.tenant_id !== tenancy.tenant_id || uriParts.scope !== tenancy.scope) {
      badRequest("decision_uri_scope_mismatch", "decision_uri tenant/scope does not match request scope", {
        decision_uri: parsed.decision_uri,
        uri_tenant_id: uriParts.tenant_id,
        uri_scope: uriParts.scope,
        request_tenant_id: tenancy.tenant_id,
        request_scope: tenancy.scope,
      });
    }
    if (linkedDecisionId && linkedDecisionId !== uriParts.id) {
      badRequest("decision_uri_id_mismatch", "decision_uri id conflicts with decision_id", {
        decision_id: linkedDecisionId,
        decision_uri: parsed.decision_uri,
      });
    }
    linkedDecisionId = uriParts.id;
  }

  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("prepareToolSelectionFeedback requires lite write store");

  const actor = parsed.actor ?? "system";
  const normalizedCandidates = normalizeToolCandidates(parsed.candidates);
  const selectedTool = normalizeToolName(parsed.selected_tool);
  const inputText = parsed.input_text ? normalizeText(parsed.input_text, opts.maxTextLen) : undefined;
  const redactedInput = opts.piiRedaction && inputText ? redactPII(inputText).text : inputText;
  const inputSha = parsed.input_sha256 ?? sha256Hex(redactedInput!);
  const noteNorm = parsed.note ? normalizeText(parsed.note, opts.maxTextLen) : undefined;
  const note = opts.piiRedaction && noteNorm ? redactPII(noteNorm).text : noteNorm;
  const workflowFeedbackTarget = extractWorkflowFeedbackTarget(parsed.context);

  const rawContextSha256 = hashExecutionContext(parsed.context);
  let decisionBefore: DecisionRow | null = linkedDecisionId
    ? await liteWriteStore.getExecutionDecision({ scope, id: linkedDecisionId })
    : null;
  let decisionLinkMode: PreparedDecisionPlan["decision_link_mode"] = linkedDecisionId ? "provided" : "inferred";
  if (linkedDecisionId && !decisionBefore) {
    badRequest("decision_not_found_in_scope", "decision_id was not found in this scope", {
      decision_id: linkedDecisionId,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
    });
  }

  const servedBindingRequested = parsed.guide_rule_evaluation_sha256 !== undefined
    || parsed.guide_context_sha256 !== undefined;
  let servedRuleEvaluation: ToolRuleEvaluationProvenance | null = null;
  let activeSources: Array<{
    rule_node_id: string;
    state: "active" | "shadow";
    commit_id: string;
    touched_paths: string[];
  }>;
  let shadowSources: typeof activeSources;
  let contextSha256: string;
  let policySha256: string;
  let rulesAppliedSha256: string;

  if (servedBindingRequested) {
    if (!decisionBefore
      || !parsed.guide_rule_evaluation_sha256
      || !parsed.guide_context_sha256
      || !parsed.guide_policy_sha256
      || !parsed.guide_source_rule_ids) {
      throw new HttpError(
        409,
        "guide_tool_selection_provenance_unavailable",
        "the served tool decision does not expose complete rule evaluation provenance",
        { guide_trace_id: parsed.guide_trace_id ?? null },
      );
    }
    servedRuleEvaluation = readToolRuleEvaluationProvenance(decisionBefore.metadata_json);
    if (!servedRuleEvaluation) {
      throw new HttpError(
        409,
        "guide_tool_selection_provenance_unavailable",
        "the served tool decision does not expose complete rule evaluation provenance",
        { guide_trace_id: parsed.guide_trace_id ?? null, decision_id: decisionBefore.id },
      );
    }
    const activeRuleIds = uniqueRuleIds(
      servedRuleEvaluation.active_sources.map((source) => source.rule_node_id),
    );
    const guideRuleIds = uniqueRuleIds(parsed.guide_source_rule_ids);
    const provenanceMismatch = servedRuleEvaluation.provenance_sha256 !== parsed.guide_rule_evaluation_sha256
      || servedRuleEvaluation.effective_context_sha256 !== parsed.guide_context_sha256
      || servedRuleEvaluation.policy_sha256 !== parsed.guide_policy_sha256
      || decisionBefore.context_sha256 !== servedRuleEvaluation.effective_context_sha256
      || decisionBefore.policy_sha256 !== servedRuleEvaluation.policy_sha256
      || !sameRuleIds(decisionBefore.source_rule_ids, activeRuleIds)
      || !sameRuleIds(guideRuleIds, activeRuleIds)
      || (parsed.include_shadow && !servedRuleEvaluation.include_shadow);
    if (provenanceMismatch) {
      throw new HttpError(409, "guide_tool_selection_mismatch", "tool feedback no longer matches the served guide selection", {
        guide_trace_id: parsed.guide_trace_id ?? null,
        reason: "rule_evaluation_provenance_mismatch",
      });
    }
    const drift = await findToolRuleEvaluationDrift(
      servedRuleEvaluation,
      sourceRuleIdsFromEvaluation(servedRuleEvaluation, parsed.include_shadow, parsed.target),
      scope,
      liteWriteStore,
    );
    if (drift) {
      throw new HttpError(409, "guide_tool_selection_mismatch", "tool feedback no longer matches the served guide selection", {
        guide_trace_id: parsed.guide_trace_id ?? null,
        reason: drift.reason,
        rule_node_id: drift.rule_node_id,
      });
    }
    activeSources = servedRuleEvaluation.active_sources;
    shadowSources = parsed.include_shadow ? servedRuleEvaluation.shadow_sources : [];
    contextSha256 = servedRuleEvaluation.effective_context_sha256;
    policySha256 = servedRuleEvaluation.policy_sha256;
    rulesAppliedSha256 = servedRuleEvaluation.provenance_sha256;
  } else {
    const rules = await evaluateRulesAppliedOnly({
      scope: tenancy.scope,
      tenant_id: parsed.tenant_id,
      default_tenant_id: defaultTenantId,
      context: parsed.context,
      include_shadow: parsed.include_shadow,
      limit: parsed.rules_limit,
    }, { liteWriteStore });
    activeSources = ((rules.applied as any)?.sources as typeof activeSources) ?? [];
    shadowSources = parsed.include_shadow
      ? (((rules.applied as any)?.shadow_sources as typeof shadowSources) ?? [])
      : [];
    contextSha256 = rawContextSha256;
    policySha256 = hashPolicy((rules.applied as any)?.policy ?? {});
    rulesAppliedSha256 = sha256Hex(stableStringify(rules.applied));
    if (!decisionBefore) {
      decisionBefore = await liteWriteStore.findExecutionDecisionForFeedback({
        scope,
        runId: parsed.run_id ?? null,
        selectedTool,
        candidatesJson: normalizedCandidates,
        contextSha256,
      });
    }
  }

  const decisionSourceRuleIds = uniqueRuleIds(activeSources.map((source) => source.rule_node_id));
  const sourceRuleIds = servedRuleEvaluation
    ? sourceRuleIdsFromEvaluation(servedRuleEvaluation, parsed.include_shadow, parsed.target)
    : uniqueRuleIds(
        [...activeSources, ...shadowSources]
          .filter((source) => parsed.target === "all" || isToolTouched(source.touched_paths ?? []))
          .filter((source) => (parsed.include_shadow ? true : source.state === "active"))
          .map((source) => source.rule_node_id),
      );
  const learningDecision = decideToolsFeedbackLearning({
    context: parsed.context,
    outcome: parsed.outcome,
    sourceRuleIds,
    workflowFeedbackTarget,
  });

  const createDecision = !decisionBefore;
  if (!decisionBefore) {
    decisionLinkMode = "created_from_feedback";
    decisionBefore = {
      id: randomUUID(),
      scope,
      run_id: parsed.run_id ?? null,
      selected_tool: selectedTool,
      candidates_json: normalizedCandidates,
      context_sha256: contextSha256,
      policy_sha256: policySha256,
      source_rule_ids: decisionSourceRuleIds,
      metadata_json: { source: "feedback_derived" },
      created_at: new Date().toISOString(),
      commit_id: null,
    };
  }
  const plannedDecision = decisionBefore;
  assertDecisionCompatible(plannedDecision, parsed, normalizedCandidates);
  const guideSourceRuleIds = parsed.guide_source_rule_ids
    ? uniqueRuleIds(parsed.guide_source_rule_ids)
    : null;
  const guideSourceRuleIdSet = guideSourceRuleIds ? new Set(guideSourceRuleIds) : null;
  const allowedGuideRuleIdSet = servedRuleEvaluation
    ? new Set([
        ...servedRuleEvaluation.active_sources,
        ...(parsed.include_shadow ? servedRuleEvaluation.shadow_sources : []),
      ].map((source) => source.rule_node_id))
    : guideSourceRuleIdSet;
  const attributedRulesOutsideGuide = allowedGuideRuleIdSet
    ? sourceRuleIds.filter((ruleNodeId) => !allowedGuideRuleIdSet.has(ruleNodeId))
    : [];
  const guidePolicyMismatch = parsed.guide_policy_sha256
    ? plannedDecision.policy_sha256 !== parsed.guide_policy_sha256
      || policySha256 !== parsed.guide_policy_sha256
    : false;
  const guideRuleMismatch = guideSourceRuleIds
    ? !sameRuleIds(plannedDecision.source_rule_ids, guideSourceRuleIds)
      || !sameRuleIds(decisionSourceRuleIds, guideSourceRuleIds)
      || attributedRulesOutsideGuide.length > 0
      || (!servedRuleEvaluation && parsed.target === "all"
        && !sameRuleIds(sourceRuleIds, guideSourceRuleIds))
    : false;
  if (guidePolicyMismatch || guideRuleMismatch) {
    throw new HttpError(409, "guide_tool_selection_mismatch", "tool feedback no longer matches the served guide selection", {
      guide_trace_id: parsed.guide_trace_id ?? null,
      policy_mismatch: guidePolicyMismatch,
      source_rule_ids_mismatch: guideRuleMismatch,
      guide_policy_sha256: parsed.guide_policy_sha256 ?? null,
      decision_policy_sha256: plannedDecision.policy_sha256,
      evaluated_policy_sha256: policySha256,
      guide_source_rule_ids: guideSourceRuleIds,
      decision_source_rule_ids: plannedDecision.source_rule_ids,
      evaluated_decision_source_rule_ids: decisionSourceRuleIds,
      attributed_source_rule_ids: sourceRuleIds,
      attributed_rules_outside_guide: attributedRulesOutsideGuide,
    });
  }
  const decisionAfterRun: DecisionRow = {
    ...plannedDecision,
    run_id: parsed.run_id ?? plannedDecision.run_id,
  };

  const parent = await liteWriteStore.latestCommit(scope);
  const parentCommitHash = parent?.commit_hash ?? "";
  const parentCommitId = parent?.id ?? null;
  const diff = {
    tool_feedback: [{
      decision_id: decisionAfterRun.id,
      decision_link_mode: decisionLinkMode,
      run_id: parsed.run_id ?? null,
      outcome: parsed.outcome,
      selected_tool: selectedTool,
      candidates: normalizedCandidates,
      rule_node_ids: sourceRuleIds,
      target: parsed.target,
      include_shadow: parsed.include_shadow,
    }],
  };
  const commitDiffJson = JSON.stringify(diff);
  const diffSha = sha256Hex(stableStringify(diff));
  const commitHash = sha256Hex(stableStringify({
    parentHash: parentCommitHash,
    inputSha,
    diffSha,
    scope,
    actor,
    kind: "tool_feedback",
  }));
  const commitId = stableUuid(`lite:commit:${commitHash}`);
  const decisionAfter: DecisionRow = { ...decisionAfterRun, commit_id: commitId };
  const feedbackCreatedAt = new Date().toISOString();

  let pattern: PreparedToolsDecisionPatternAnchor | null = null;
  let learningControlPreview: ToolsFeedbackLearningControlPreview | null = null;
  const patternFeedbackOutcome = parsed.outcome === "positive" || parsed.outcome === "negative"
    ? parsed.outcome
    : null;
  if (patternFeedbackOutcome && learningDecision.shouldWritePatternAnchor) {
    const patternArgs = {
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      actor,
      input_text: redactedInput ?? null,
      input_sha256: inputSha,
      note: note ?? null,
      context: parsed.context,
      selected_tool: selectedTool,
      candidates: normalizedCandidates,
      source_rule_ids: sourceRuleIds,
      decision: decisionAfter,
      feedback_commit_id: commitId,
      feedback_outcome: patternFeedbackOutcome,
    } as const;
    pattern = await prepareToolsDecisionPatternAnchor({
      ...patternArgs,
      learning_control_pattern_state_override: null,
    }, {
      defaultScope,
      defaultTenantId,
      maxTextLen: opts.maxTextLen,
      piiRedaction: opts.piiRedaction,
      embedder: opts.embedder ?? null,
      writeAccess: liteWriteStore,
      liteWriteStore,
    });
    if (pattern) {
      learningControlPreview = await buildToolsFeedbackFormPatternLearningControlPreview({
        liteWriteStore,
        scope,
        inputText: redactedInput ?? null,
        inputSha256: inputSha,
        sourceRuleIds,
        anchor: pattern.result.anchor,
        learningControlReview: parsed.learning_control_review?.form_pattern ?? null,
        reviewProvider: opts.learningControlReviewProviders?.form_pattern ?? undefined,
      });
      if (parsed.learning_control_review?.form_pattern?.review_result && !learningControlPreview) {
        badRequest(
          "form_pattern_learning_control_preview_unavailable",
          "form_pattern learning_control review requires at least two source nodes",
          { source_rule_count: sourceRuleIds.length },
        );
      }
      const formPatternPreview = learningControlPreview?.form_pattern ?? null;
      const applyGate = deriveControlledStateRaiseRuntimeApply({
        policyEffect: formPatternPreview?.policy_effect ?? null,
        effectiveState: formPatternPreview?.policy_effect?.effective_pattern_state,
        appliedState: "stable",
      });
      if (formPatternPreview && applyGate.runtimeApplyRequested && applyGate.controlledOverrideState) {
        pattern = await prepareToolsDecisionPatternAnchor({
          ...patternArgs,
          learning_control_pattern_state_override: applyGate.controlledOverrideState,
        }, {
          defaultScope,
          defaultTenantId,
          maxTextLen: opts.maxTextLen,
          piiRedaction: opts.piiRedaction,
          embedder: opts.embedder ?? null,
          writeAccess: liteWriteStore,
          liteWriteStore,
        });
        if (pattern) {
          formPatternPreview.decision_trace.runtime_apply_changed_pattern_state =
            (pattern.result.anchor.pattern_state ?? "provisional") === "stable";
          formPatternPreview.decision_trace.stage_order =
            appendLearningControlRuntimePolicyAppliedStage(formPatternPreview.decision_trace.stage_order);
        }
      }
    }
  }

  const materializedPolicy = parsed.outcome === "positive"
    ? await prepareLitePolicyMemoryFromFeedback({
        parsed,
        tenancy,
        actor,
        inputText: redactedInput ?? null,
        note: note ?? null,
        inputSha,
        selectedTool,
        normalizedCandidates,
        workflowFeedbackTarget,
        commitId,
        defaultScope,
        defaultTenantId,
        opts,
        prospectivePattern: pattern,
      })
    : null;
  const policyFeedback = parsed.outcome === "positive" || parsed.outcome === "negative"
    ? await preparePolicyMemoryFeedbackLite(liteWriteStore, {
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        selected_tool: selectedTool,
        task_signature: workflowFeedbackTarget.taskSignature,
        error_signature: workflowFeedbackTarget.errorSignature,
        workflow_signature: workflowFeedbackTarget.workflowSignature,
        outcome: parsed.outcome,
        run_id: parsed.run_id ?? null,
        reason: note ?? null,
        input_sha256: inputSha,
        commit_id: commitId,
        feedback_at: feedbackCreatedAt,
      }, {
        materialized_snapshot: materializedPolicy?.prepared ?? null,
      })
    : null;

  return {
    schema_version: "prepared_tool_selection_feedback_v1",
    parsed,
    default_scope: defaultScope,
    default_tenant_id: defaultTenantId,
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    scope_key: scope,
    actor,
    normalized_candidates: normalizedCandidates,
    selected_tool: selectedTool,
    input_text: redactedInput ?? null,
    input_sha256: inputSha,
    note: note ?? null,
    workflow_feedback_target: workflowFeedbackTarget,
    source_rule_ids: sourceRuleIds,
    rules_applied_sha256: rulesAppliedSha256,
    served_rule_evaluation: servedRuleEvaluation,
    context_sha256: contextSha256,
    policy_sha256: policySha256,
    decision: {
      expected_sha256: createDecision ? null : decisionRowSha256(plannedDecision),
      create: createDecision,
      decision_link_mode: decisionLinkMode,
      before: createDecision ? null : plannedDecision,
      after: decisionAfter,
    },
    parent_commit_id: parentCommitId,
    parent_commit_hash: parentCommitHash,
    commit_id: commitId,
    commit_hash: commitHash,
    commit_diff_json: commitDiffJson,
    feedback_created_at: feedbackCreatedAt,
    rule_feedback: sourceRuleIds.map((ruleNodeId) => ({
      id: randomUUID(),
      rule_node_id: ruleNodeId,
    })),
    pattern,
    policy_snapshot: materializedPolicy?.prepared ?? null,
    policy_feedback: policyFeedback,
    policy_materialized_response: materializedPolicy?.response ?? null,
    learning_control_preview: learningControlPreview,
  };
}

async function assertPreparedToolFeedbackStillCurrent(
  prepared: PreparedToolSelectionFeedback,
  liteWriteStore: LiteWriteStore,
): Promise<void> {
  if (prepared.served_rule_evaluation) {
    const drift = await findToolRuleEvaluationDrift(
      prepared.served_rule_evaluation,
      prepared.source_rule_ids,
      prepared.scope_key,
      liteWriteStore,
    );
    if (drift) {
      throw new HttpError(409, "tool_feedback_prepare_conflict", "tool feedback rule attribution changed after prepare", {
        reason: drift.reason,
        rule_node_id: drift.rule_node_id,
      });
    }
  } else {
    const currentRules = await evaluateRulesAppliedOnly({
      scope: prepared.scope,
      tenant_id: prepared.parsed.tenant_id,
      default_tenant_id: prepared.default_tenant_id,
      context: prepared.parsed.context,
      include_shadow: prepared.parsed.include_shadow,
      limit: prepared.parsed.rules_limit,
    }, { liteWriteStore });
    if (sha256Hex(stableStringify(currentRules.applied)) !== prepared.rules_applied_sha256) {
      throw new HttpError(409, "tool_feedback_prepare_conflict", "tool feedback rule attribution changed after prepare", {
        reason: "rule_attribution_changed",
      });
    }
  }

  const latest = await liteWriteStore.latestCommit(prepared.scope_key);
  if ((latest?.id ?? null) !== prepared.parent_commit_id
    || (latest?.commit_hash ?? "") !== prepared.parent_commit_hash) {
    throw new HttpError(409, "tool_feedback_prepare_conflict", "tool feedback parent commit changed after prepare", {
      reason: "parent_commit_changed",
    });
  }

  const currentDecision = await liteWriteStore.getExecutionDecision({
    scope: prepared.scope_key,
    id: prepared.decision.after.id,
  });
  if (decisionRowSha256(currentDecision) !== prepared.decision.expected_sha256) {
    throw new HttpError(409, "tool_feedback_prepare_conflict", "tool feedback decision changed after prepare", {
      reason: "decision_changed",
      decision_id: prepared.decision.after.id,
    });
  }
  if (prepared.decision.create) {
    const inferred = await liteWriteStore.findExecutionDecisionForFeedback({
      scope: prepared.scope_key,
      runId: prepared.parsed.run_id ?? null,
      selectedTool: prepared.selected_tool,
      candidatesJson: prepared.normalized_candidates,
      contextSha256: prepared.context_sha256,
    });
    if (inferred) {
      throw new HttpError(409, "tool_feedback_prepare_conflict", "a matching tool decision appeared after prepare", {
        reason: "inferred_decision_appeared",
        decision_id: inferred.id,
      });
    }
  }
}

function rethrowPreparedMutationConflict(error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error);
  if (reason.endsWith("_prepare_conflict")) {
    throw new HttpError(409, "tool_feedback_prepare_conflict", "tool feedback memory state changed after prepare", {
      reason,
    });
  }
  throw error;
}

export async function persistToolSelectionFeedback(
  prepared: PreparedToolSelectionFeedback,
  opts: FeedbackOptions,
): Promise<PersistedToolSelectionFeedback> {
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("persistToolSelectionFeedback requires lite write store");
  if (!liteWriteStore.transactionRunner().inTransaction()) {
    throw new Error("persistToolSelectionFeedback requires an active shared transaction");
  }
  await assertPreparedToolFeedbackStillCurrent(prepared, liteWriteStore);

  let decision = prepared.decision.after;
  if (prepared.decision.create) {
    await liteWriteStore.insertExecutionDecision({
      id: decision.id,
      scope: prepared.scope_key,
      decisionKind: "tools_select",
      runId: decision.run_id,
      selectedTool: decision.selected_tool,
      candidatesJson: decision.candidates_json,
      contextSha256: decision.context_sha256,
      policySha256: decision.policy_sha256,
      sourceRuleIds: decision.source_rule_ids,
      metadataJson: decision.metadata_json,
      commitId: null,
      createdAt: decision.created_at,
    });
  } else if (prepared.parsed.run_id && !prepared.decision.before?.run_id) {
    const linked = await liteWriteStore.updateExecutionDecisionLink({
      scope: prepared.scope_key,
      id: decision.id,
      runId: prepared.parsed.run_id,
    });
    if (!linked) throw new Error("tool_feedback_decision_link_failed");
    decision = linked;
  }

  const commitId = await liteWriteStore.insertCommit({
    scope: prepared.scope_key,
    parentCommitId: prepared.parent_commit_id,
    inputSha256: prepared.input_sha256,
    diffJson: prepared.commit_diff_json,
    actor: prepared.actor,
    modelVersion: null,
    promptVersion: null,
    commitHash: prepared.commit_hash,
  });
  if (commitId !== prepared.commit_id) throw new Error("tool_feedback_commit_id_mismatch");

  const committedDecision = await liteWriteStore.updateExecutionDecisionLink({
    scope: prepared.scope_key,
    id: decision.id,
    commitId,
  });
  if (!committedDecision) throw new Error("tool_feedback_decision_commit_link_failed");
  decision = committedDecision;
  for (const feedback of prepared.rule_feedback) {
    await liteWriteStore.insertRuleFeedback({
      id: feedback.id,
      scope: prepared.scope_key,
      ruleNodeId: feedback.rule_node_id,
      runId: prepared.parsed.run_id ?? null,
      outcome: prepared.parsed.outcome,
      note: prepared.note,
      source: "tools_feedback",
      decisionId: decision.id,
      commitId,
      createdAt: prepared.feedback_created_at,
    });
  }
  await liteWriteStore.updateRuleFeedbackAggregates({
    scope: prepared.scope_key,
    outcome: prepared.parsed.outcome,
    ruleNodeIds: prepared.source_rule_ids,
  });

  try {
    if (prepared.pattern) {
      await persistPreparedToolsDecisionPatternAnchor(prepared.pattern, {
        liteWriteStore,
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
      });
    }
    if (prepared.policy_snapshot) {
      await persistPreparedPolicyMemorySnapshot(prepared.policy_snapshot, {
        liteWriteStore,
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
      });
    }
    if (prepared.policy_feedback) {
      await persistPreparedPolicyMemoryFeedback(prepared.policy_feedback, liteWriteStore);
    }
  } catch (error) {
    rethrowPreparedMutationConflict(error);
  }

  const response = ToolsFeedbackResponseSchema.parse({
    ok: true,
    scope: prepared.scope,
    tenant_id: prepared.tenant_id,
    updated_rules: prepared.source_rule_ids.length,
    rule_node_ids: prepared.source_rule_ids,
    commit_id: commitId,
    commit_uri: buildAionisUri({
      tenant_id: prepared.tenant_id,
      scope: prepared.scope,
      type: "commit",
      id: commitId,
    }),
    commit_hash: prepared.commit_hash,
    decision_id: decision.id,
    decision_uri: buildAionisUri({
      tenant_id: prepared.tenant_id,
      scope: prepared.scope,
      type: "decision",
      id: decision.id,
    }),
    decision_link_mode: prepared.decision.decision_link_mode,
    decision_policy_sha256: decision.policy_sha256,
    pattern_anchor: patternResponse(prepared.pattern, prepared.tenant_id, prepared.scope),
    policy_memory: prepared.policy_feedback?.result ?? prepared.policy_materialized_response,
    learning_control_preview: prepared.learning_control_preview,
  } satisfies ToolsFeedbackResponse);

  const preparedWrites = [
    prepared.pattern?.prepared_write ?? null,
    prepared.policy_snapshot?.prepared_write ?? null,
  ].filter((entry): entry is PreparedWrite => entry !== null);
  return {
    response,
    run_id: prepared.parsed.run_id ?? null,
    decision_id: decision.id,
    commit_id: commitId,
    commit_hash: prepared.commit_hash,
    finalize_plan: { prepared_writes: preparedWrites },
  };
}

export async function finalizeToolSelectionFeedback(
  persisted: PersistedToolSelectionFeedback,
  opts: FeedbackOptions,
): Promise<ToolSelectionFeedbackFinalizeResult> {
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("finalizeToolSelectionFeedback requires lite write store");
  if (liteWriteStore.transactionRunner().inTransaction()) {
    throw new Error("finalizeToolSelectionFeedback must run after commit");
  }
  const embeddings: ToolSelectionFeedbackFinalizeResult["embeddings"] = [];
  for (const preparedWrite of persisted.finalize_plan.prepared_writes) {
    const result = await completeLiteInlineEmbeddings({
      prepared: preparedWrite,
      embedder: opts.embedder ?? null,
      liteWriteStore,
    });
    if (result) embeddings.push(result);
  }
  return { embeddings };
}

export async function toolSelectionFeedback(
  client: null,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: FeedbackOptions,
): Promise<ToolsFeedbackResponse> {
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) throw new Error("toolSelectionFeedback requires lite write store");
  if (liteWriteStore.transactionRunner().inTransaction()) {
    throw new Error("toolSelectionFeedback must be entered outside a transaction so prepare can run before BEGIN");
  }
  const prepared = await prepareToolSelectionFeedback(client, body, defaultScope, defaultTenantId, opts);
  const persisted = await liteWriteStore.withTx(() => persistToolSelectionFeedback(prepared, opts));
  await finalizeToolSelectionFeedback(persisted, opts);
  return persisted.response;
}
