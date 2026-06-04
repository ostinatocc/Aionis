import { randomUUID } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { badRequest } from "../util/http.js";
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
import { writeToolsDecisionPatternAnchor } from "./tools-pattern-anchor.js";
import { applyPolicyMemoryFeedbackLite, writePolicyMemorySnapshot } from "./policy-memory.js";
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

export { buildMaterializationContextFromFeedback } from "../kernel/learning-decision-kernel.js";

type FeedbackOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  embedder?: EmbeddingProvider | null;
  learningControlReviewProviders?: {
    form_pattern?: FormPatternLearningControlReviewProvider | null;
  };
  recallAccess?: RecallStoreAccess | null;
  liteWriteStore?: Pick<
    LiteWriteStore,
    | "findExecutionDecisionForFeedback"
    | "getExecutionDecision"
    | "insertExecutionDecision"
    | "findNodes"
    | "latestCommit"
    | "insertCommit"
    | "insertRuleFeedback"
    | "updateNodeAnchorState"
    | "updateExecutionDecisionLink"
    | "updateRuleFeedbackAggregates"
    | "listRuleCandidates"
  > | null;
};

type DecisionRow = {
  id: string;
  scope: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: any;
  context_sha256: string;
  policy_sha256: string;
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

async function materializeLitePolicyMemoryFromFeedback(args: {
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
}): Promise<ToolsFeedbackResponse["policy_memory"] | null> {
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
  const introspection = await buildExecutionMemoryIntrospectionLite(
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
  const trustedPatternAnchorIds = (Array.isArray(introspection.trusted_patterns) ? introspection.trusted_patterns : [])
    .filter((entry) => nullableString((entry as Record<string, unknown>)?.selected_tool) === args.selectedTool)
    .map((entry) => nullableString((entry as Record<string, unknown>)?.anchor_id))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const contestedPatternAnchorIds = (Array.isArray(introspection.contested_patterns) ? introspection.contested_patterns : [])
    .filter((entry) => nullableString((entry as Record<string, unknown>)?.selected_tool) === args.selectedTool)
    .map((entry) => nullableString((entry as Record<string, unknown>)?.anchor_id))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
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

  const persisted = await writePolicyMemorySnapshot({
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
    node_id: persisted.node_id,
    node_uri: buildAionisUri({
      tenant_id: args.tenancy.tenant_id,
      scope: args.tenancy.scope,
      type: "concept",
      id: persisted.node_id,
    }),
    client_id: persisted.client_id,
    policy_memory_signature: persisted.policy_memory_signature,
    selected_tool: persisted.policy_contract.selected_tool,
    policy_state: persisted.policy_contract.policy_state,
    policy_memory_state: persisted.policy_contract.policy_memory_state,
    activation_mode: persisted.policy_contract.activation_mode,
    policy_contract: persisted.policy_contract,
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
    task_signature: nullableString(args.anchor.task_signature),
    error_signature: nullableString(args.anchor.error_signature),
    pattern_signature: nullableString(args.anchor.pattern_signature),
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

export async function toolSelectionFeedback(
  _client: null,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: FeedbackOptions,
) {
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
  const actor = parsed.actor ?? "system";
  const normalizedCandidates = normalizeToolCandidates(parsed.candidates);
  const selectedTool = normalizeToolName(parsed.selected_tool);

  const inputText = parsed.input_text ? normalizeText(parsed.input_text, opts.maxTextLen) : undefined;
  const redactedInput = opts.piiRedaction && inputText ? redactPII(inputText).text : inputText;
  const inputSha = parsed.input_sha256 ?? sha256Hex(redactedInput!);

  const noteNorm = parsed.note ? normalizeText(parsed.note, opts.maxTextLen) : undefined;
  const note = opts.piiRedaction && noteNorm ? redactPII(noteNorm).text : noteNorm;
  const workflowFeedbackTarget = extractWorkflowFeedbackTarget(parsed.context);
  const liteWriteStore = opts.liteWriteStore;
  if (!liteWriteStore) {
    throw new Error("toolSelectionFeedback requires lite write store");
  }

  // Re-evaluate rules for attribution to avoid trusting client-provided sources.
  const rules = await evaluateRulesAppliedOnly({
    scope: tenancy.scope,
    tenant_id: parsed.tenant_id,
    default_tenant_id: defaultTenantId,
    context: parsed.context,
    include_shadow: parsed.include_shadow,
    limit: parsed.rules_limit,
  }, {
    liteWriteStore: liteWriteStore ?? null,
  });

  const activeSources: Array<{ rule_node_id: string; state: "active" | "shadow"; commit_id: string; touched_paths: string[] }> =
    ((rules.applied as any)?.sources as any[]) ?? [];
  const shadowSources: Array<{ rule_node_id: string; state: "active" | "shadow"; commit_id: string; touched_paths: string[] }> =
    parsed.include_shadow ? (((rules.applied as any)?.shadow_sources as any[]) ?? []) : [];
  const sources: Array<{ rule_node_id: string; state: "active" | "shadow"; commit_id: string; touched_paths: string[] }> = [
    ...activeSources,
    ...shadowSources,
  ];

  const targetRuleIds = sources
    .filter((s) => parsed.target === "all" || isToolTouched(s.touched_paths ?? []))
    .filter((s) => (parsed.include_shadow ? true : s.state === "active"))
    .map((s) => s.rule_node_id);

  const uniq = uniqueRuleIds(targetRuleIds);
  const learningDecision = decideToolsFeedbackLearning({
    context: parsed.context,
    outcome: parsed.outcome,
    sourceRuleIds: uniq,
    workflowFeedbackTarget,
  });

  const contextSha256 = hashExecutionContext(parsed.context);
  const policySha256 = hashPolicy((rules.applied as any)?.policy ?? {});
  const candidatesJson = JSON.stringify(normalizedCandidates);
  let patternAnchor: NonNullable<ToolsFeedbackResponse["pattern_anchor"]> | null = null;
  let policyMemory: ToolsFeedbackResponse["policy_memory"] | null = null;
  let learningControlPreview: ToolsFeedbackLearningControlPreview | null = null;

  {
    let decision = linkedDecisionId
      ? await liteWriteStore.getExecutionDecision({ scope, id: linkedDecisionId })
      : await liteWriteStore.findExecutionDecisionForFeedback({
          scope,
          runId: parsed.run_id ?? null,
          selectedTool,
          candidatesJson: normalizedCandidates,
          contextSha256,
        });
    let decision_link_mode: "provided" | "inferred" | "created_from_feedback" = linkedDecisionId ? "provided" : "inferred";

    if (linkedDecisionId && !decision) {
      badRequest("decision_not_found_in_scope", "decision_id was not found in this scope", {
        decision_id: linkedDecisionId,
        scope: tenancy.scope,
        tenant_id: tenancy.tenant_id,
      });
    }

    if (!decision) {
      const created = await liteWriteStore.insertExecutionDecision({
        id: randomUUID(),
        scope,
        decisionKind: "tools_select",
        runId: parsed.run_id ?? null,
        selectedTool,
        candidatesJson: normalizedCandidates,
        contextSha256,
        policySha256,
        sourceRuleIds: uniq,
        metadataJson: { source: "feedback_derived" },
        commitId: null,
      });
      decision = await liteWriteStore.getExecutionDecision({ scope, id: created.id });
      decision_link_mode = "created_from_feedback";
    }

    assertDecisionCompatible(decision!, parsed, normalizedCandidates);

    if (parsed.run_id && !decision!.run_id) {
      decision = await liteWriteStore.updateExecutionDecisionLink({
        scope,
        id: decision!.id,
        runId: parsed.run_id,
      });
      assertDecisionCompatible(decision!, parsed, normalizedCandidates);
    }

    const parent = await liteWriteStore.latestCommit(scope);
    const parentHash = parent?.commit_hash ?? "";
    const parentId = parent?.id ?? null;
    const diff = {
      tool_feedback: [
        {
          decision_id: decision!.id,
          decision_link_mode,
          run_id: parsed.run_id ?? null,
          outcome: parsed.outcome,
          selected_tool: selectedTool,
          candidates: normalizedCandidates,
          rule_node_ids: uniq,
          target: parsed.target,
        },
      ],
    };
    const diffSha = sha256Hex(stableStringify(diff));
    const commitHash = sha256Hex(stableStringify({ parentHash, inputSha, diffSha, scope, actor, kind: "tool_feedback" }));
    const commit_id = await liteWriteStore.insertCommit({
      scope,
      parentCommitId: parentId,
      inputSha256: inputSha,
      diffJson: JSON.stringify(diff),
      actor,
      modelVersion: null,
      promptVersion: null,
      commitHash,
    });

    decision = await liteWriteStore.updateExecutionDecisionLink({
      scope,
      id: decision!.id,
      commitId: commit_id,
    });

    const feedbackCreatedAt = new Date().toISOString();
    for (const rule_node_id of uniq) {
      await liteWriteStore.insertRuleFeedback({
        id: randomUUID(),
        scope,
        ruleNodeId: rule_node_id,
        runId: parsed.run_id ?? null,
        outcome: parsed.outcome,
        note: note ?? null,
        source: "tools_feedback",
        decisionId: decision!.id,
        commitId: commit_id,
        createdAt: feedbackCreatedAt,
      });
    }
    await liteWriteStore.updateRuleFeedbackAggregates({
      scope,
      outcome: parsed.outcome,
      ruleNodeIds: uniq,
    });

    const patternFeedbackOutcome = parsed.outcome === "positive" || parsed.outcome === "negative"
      ? parsed.outcome
      : null;
    if (patternFeedbackOutcome && learningDecision.shouldWritePatternAnchor) {
      let anchorOut = await writeToolsDecisionPatternAnchor({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        actor,
        input_text: redactedInput ?? null,
        input_sha256: inputSha,
        note: note ?? null,
        context: parsed.context,
        selected_tool: selectedTool,
        candidates: normalizedCandidates,
        source_rule_ids: uniq,
        decision: decision!,
        feedback_commit_id: commit_id,
        feedback_outcome: patternFeedbackOutcome,
        learning_control_pattern_state_override: null,
      }, {
        defaultScope,
        defaultTenantId,
        maxTextLen: opts.maxTextLen,
        piiRedaction: opts.piiRedaction,
        embedder: opts.embedder ?? null,
        writeAccess: liteWriteStore as unknown as WriteStoreAccess,
        liteWriteStore: liteWriteStore ?? null,
      });
      if (anchorOut) {
        learningControlPreview = await buildToolsFeedbackFormPatternLearningControlPreview({
          liteWriteStore: liteWriteStore,
          scope,
          inputText: redactedInput ?? null,
          inputSha256: inputSha,
          sourceRuleIds: uniq,
          anchor: anchorOut.anchor,
          learningControlReview: parsed.learning_control_review?.form_pattern ?? null,
          reviewProvider: opts.learningControlReviewProviders?.form_pattern ?? undefined,
        });
        if (parsed.learning_control_review?.form_pattern?.review_result && !learningControlPreview) {
          badRequest("form_pattern_learning_control_preview_unavailable", "form_pattern learning_control review requires at least two source nodes", {
            source_rule_count: uniq.length,
          });
        }
        const formPatternPreview = learningControlPreview?.form_pattern ?? null;
        const applyGate = deriveControlledStateRaiseRuntimeApply({
          policyEffect: formPatternPreview?.policy_effect ?? null,
          effectiveState: formPatternPreview?.policy_effect?.effective_pattern_state,
          appliedState: "stable",
        });
        if (formPatternPreview && applyGate.runtimeApplyRequested && applyGate.controlledOverrideState) {
          const applied = await writeToolsDecisionPatternAnchor({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            actor,
            input_text: redactedInput ?? null,
            input_sha256: inputSha,
            note: note ?? null,
            context: parsed.context,
            selected_tool: selectedTool,
            candidates: normalizedCandidates,
            source_rule_ids: uniq,
            decision: decision!,
            feedback_commit_id: commit_id,
            feedback_outcome: patternFeedbackOutcome,
            learning_control_pattern_state_override: applyGate.controlledOverrideState,
          }, {
            defaultScope,
            defaultTenantId,
            maxTextLen: opts.maxTextLen,
            piiRedaction: opts.piiRedaction,
            embedder: opts.embedder ?? null,
            writeAccess: liteWriteStore as unknown as WriteStoreAccess,
            liteWriteStore: liteWriteStore ?? null,
          });
          if (applied) {
            anchorOut = applied;
            formPatternPreview.decision_trace.runtime_apply_changed_pattern_state =
              (anchorOut.anchor.pattern_state ?? "provisional") === "stable";
            const nextStageOrder: ToolsFeedbackFormPatternLearningControlDecisionTrace["stage_order"] =
              appendLearningControlRuntimePolicyAppliedStage(formPatternPreview.decision_trace.stage_order);
            formPatternPreview.decision_trace.stage_order = nextStageOrder;
          }
        }
        patternAnchor = {
          node_id: anchorOut.node_id,
          node_uri: buildAionisUri({
            tenant_id: tenancy.tenant_id,
            scope: tenancy.scope,
            type: "concept",
            id: anchorOut.node_id,
          }),
          client_id: anchorOut.client_id,
          pattern_signature: anchorOut.pattern_signature,
          anchor_kind: "pattern",
          anchor_level: "L3",
          pattern_state: anchorOut.anchor.pattern_state ?? "provisional",
          credibility_state: anchorOut.anchor.credibility_state ?? "candidate",
          maintenance: anchorOut.anchor.maintenance ?? undefined,
          promotion: anchorOut.anchor.promotion ?? undefined,
          promotion_evidence_ledger_v1: anchorOut.anchor.promotion_evidence_ledger_v1 ?? undefined,
        };
      }
    }

    if (parsed.outcome === "positive") {
      const materializedPolicyMemory = await materializeLitePolicyMemoryFromFeedback({
        parsed,
        tenancy,
        actor,
        inputText: redactedInput ?? null,
        note: note ?? null,
        inputSha,
        selectedTool,
        normalizedCandidates,
        workflowFeedbackTarget,
        commitId: commit_id,
        defaultScope,
        defaultTenantId,
        opts,
      });
      policyMemory = await applyPolicyMemoryFeedbackLite(liteWriteStore, {
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
        commit_id,
        feedback_at: feedbackCreatedAt,
      }) ?? materializedPolicyMemory;
    } else if (parsed.outcome === "negative") {
      policyMemory = await applyPolicyMemoryFeedbackLite(liteWriteStore, {
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
        commit_id,
        feedback_at: feedbackCreatedAt,
      });
    }

    return ToolsFeedbackResponseSchema.parse({
      ok: true,
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
      updated_rules: uniq.length,
      rule_node_ids: uniq,
      commit_id,
      commit_uri: buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "commit",
        id: commit_id,
      }),
      commit_hash: commitHash,
      decision_id: decision!.id,
      decision_uri: buildAionisUri({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        type: "decision",
        id: decision!.id,
      }),
      decision_link_mode,
      decision_policy_sha256: decision!.policy_sha256,
      pattern_anchor: patternAnchor,
      policy_memory: policyMemory,
      learning_control_preview: learningControlPreview,
    } satisfies ToolsFeedbackResponse);
  }
}
