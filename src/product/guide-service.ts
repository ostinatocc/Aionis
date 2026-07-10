import { randomUUID } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import { z } from "zod";

import {
  parseAdmissionCandidatePolicyProfileRules,
  type AionisAdmissionCandidatePolicyProfileRule,
  type Env,
} from "../config.js";

import { sha256Hex } from "../util/crypto.js";

import {
  buildAionisMemoryPacket,
  type BuildAionisMemoryPacketArgs,
} from "../memory/product-output/memory-packet.js";

import {
  AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS,
  buildAionisMemoryDecisionAuditReport,
  buildAionisMemoryDecisionTrace,
} from "../memory/product-output/decision-trace.js";

import {
  AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON,
  buildAionisAgentFlightRecorderReport,
  buildAionisOperatorSnapshot,
  buildClaimLedgerProjection,
  resolveAionisAdmissionCandidatePolicyActiveProjection,
  type AionisAdmissionCandidatePolicyActiveProjection,
} from "../memory/product-output/operator-projections.js";

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

import type { ClaimLedgerAccess, ClaimLedgerRow } from "../store/memory-store.js";

import type { LiteExecutionNativeNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

import type { ExecutionTreeStore } from "../execution/tree-store.js";

import { buildExecutionEvidenceContextLite } from "../execution/evidence-context.js";

import {
  applyAionisInspectBeforeUseActiveProjection,
  buildAionisAgentContext,
} from "../memory/agent-context-compiler.js";

import { resolveTenantScope } from "../memory/tenant.js";

import {
  InternalDispatchResult,
  ProductGuideExposureLedger,
  ProductGuideRequest,
  findHistoricalGuideExposureLedgers,
  findMemoryNodeSlots,
  guideExposureSurfaceIds,
  nonNegativeInt,
  objectValue,
  sameGuideExposureConsumer,
  stripUndefined,
  uniqueStrings,
} from "./product-services.js";

import type {
  ProductGuideExecutionContext,
  ProductGuideInput,
  ProductMemoryAdmissionInput,
  ProductServiceResult,
  ProductServices,
} from "./product-services.js";

import {
  productServiceDependencyFailure,
  productServiceFailure,
  productServiceFailureFromUnknown,
  productServiceSuccess,
} from "./product-services.js";

import {
  inferLifecycleCandidateSignals,
  lifecycleCandidateDirectUseUnsafe,
} from "../memory/lifecycle-candidate-inference.js";

import {
  buildAionisMemoryAdmissionShadowPolicyReportFromRecord,
} from "../memory/product-output/decision-trace.js";

import {
  parseAionisAgentContext,
  parseAionisMemoryAdmissionRecord,
  parseAionisMemoryFirewallSummary,
  parseAionisMemoryUseReceipt,
  type AionisExternalMemoryCandidate,
  type AionisExternalMemoryLifecycleHint,
  type AionisGuidanceAuthority,
  type AionisMemoryAdmissionRecord,
  type AionisMemoryDecisionSurface,
  type AionisMemoryDomain,
  type AionisMemoryFirewallSummary,
  type AionisMemoryUseReceipt,
  type AionisRiskLevel,
} from "../memory/product-output-contract.js";



const CLAIM_LEDGER_GUIDE_LIVE_LIMIT = 12;

const CLAIM_LEDGER_GUIDE_SUPERSEDED_SLOT_LIMIT = 8;

const CLAIM_LEDGER_GUIDE_SUPERSEDED_PER_SLOT_LIMIT = 4;

const PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT = 256;

const PRODUCT_GUIDE_STRUCTURED_EXECUTION_PACKET_LIMIT = 16;

function isPlanningContextNoEmbeddingProvider(result: InternalDispatchResult): boolean {
  if (result.ok) return false;
  const body = objectValue(result.body);
  const details = objectValue(body?.details);
  return result.statusCode === 400
    && body?.error === "no_embedding_provider"
    && details?.surface === "planning_context";
}

function productGuideAgentRole(parsed: z.infer<typeof ProductGuideRequest>): AionisAgentRole {
  if (parsed.agent_role) return parsed.agent_role;
  const context = objectValue(parsed.context);
  const contextRole = context?.agent_role;
  const parsedContextRole = AionisAgentRoleSchema.safeParse(contextRole);
  return parsedContextRole.success ? parsedContextRole.data : "agent";
}

function productGuidePremiseFirewallVisible(agentContext: AionisAgentContext): boolean {
  return agentContext.risk.reasons.some((reason) => reason.startsWith("premise_firewall_"))
    || agentContext.inspect_before_use.some((entry) => entry.startsWith("Premise risk:"))
    || agentContext.do_not_use.some((entry) => entry.startsWith("Premise risk:"));
}

function productGuideMemoryContractVisible(memoryPacket: AionisMemoryPacket | null): boolean {
  return memoryPacket?.relevant_memories.some((entry) => !!entry.memory_contract) === true;
}

function productGuideFullPowerRequested(parsed: z.infer<typeof ProductGuideRequest>): boolean {
  return parsed.mode === "full_power" || parsed.context_mode === "full_power" || parsed.context_mode === "compact_agent";
}

function productGuideAgentContextMode(parsed: z.infer<typeof ProductGuideRequest>): AionisAgentContext["agent_context_mode"] {
  return parsed.context_mode === "compact_agent" ? "compact_agent" : "standard";
}

function productGuideTaskContextProfile(parsed: z.infer<typeof ProductGuideRequest>): AionisTaskContextProfile {
  if (parsed.task_context_profile) return parsed.task_context_profile;
  const context = objectValue(parsed.context);
  const parsedContextProfile = AionisTaskContextProfileSchema.safeParse(context?.task_context_profile);
  return parsedContextProfile.success ? parsedContextProfile.data : "general";
}

type ProductTaskContextProfileCompilerPolicy = {
  contextCharBudget: number | null;
  executionContextCharBudget: number;
  filesLimit: number;
  currentLimit: number;
  procedureLimit: number;
  inspectLimit: number;
  avoidLimit: number;
  rehydrateLimit: number;
  currentMaxChars: number;
  procedureMaxChars: number;
  inspectMaxChars: number;
  avoidMaxChars: number;
  rehydrateReasonMaxChars: number;
};

function productGuideTaskContextProfileCompilerPolicy(args: {
  profile: AionisTaskContextProfile;
  agentContextMode: AionisAgentContext["agent_context_mode"];
  explicitContextCharBudget?: number | null;
}): ProductTaskContextProfileCompilerPolicy {
  const compactAgent = args.agentContextMode === "compact_agent";
  const explicitBudget =
    typeof args.explicitContextCharBudget === "number" && args.explicitContextCharBudget > 0
      ? Math.trunc(args.explicitContextCharBudget)
      : null;
  const base: ProductTaskContextProfileCompilerPolicy = {
    contextCharBudget: explicitBudget,
    executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
    filesLimit: compactAgent ? 2 : 4,
    currentLimit: compactAgent ? 1 : 2,
    procedureLimit: compactAgent ? 1 : 3,
    inspectLimit: compactAgent ? 1 : 3,
    avoidLimit: 3,
    rehydrateLimit: compactAgent ? 2 : 3,
    currentMaxChars: compactAgent ? 90 : 160,
    procedureMaxChars: compactAgent ? 90 : 130,
    inspectMaxChars: compactAgent ? 70 : 100,
    avoidMaxChars: compactAgent ? 90 : 100,
    rehydrateReasonMaxChars: compactAgent ? 50 : 70,
  };

  switch (args.profile) {
    case "coding_verifier":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        filesLimit: compactAgent ? 4 : 6,
        procedureLimit: compactAgent ? 1 : 2,
        inspectLimit: compactAgent ? 2 : 3,
        avoidLimit: compactAgent ? 2 : 3,
        procedureMaxChars: compactAgent ? 110 : 150,
        inspectMaxChars: compactAgent ? 95 : 130,
      };
    case "document_integrity":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 6144 : 8192),
        executionContextCharBudget: Math.min(explicitBudget ?? 6144, 50_000),
        filesLimit: compactAgent ? 5 : 8,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 3 : 4,
        avoidLimit: compactAgent ? 2 : 3,
        rehydrateLimit: compactAgent ? 3 : 4,
        inspectMaxChars: compactAgent ? 95 : 130,
      };
    case "long_qa":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 8192 : 12000),
        executionContextCharBudget: Math.min(explicitBudget ?? 8192, 50_000),
        currentLimit: compactAgent ? 1 : 2,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 4 : 6,
        avoidLimit: compactAgent ? 2 : 3,
        rehydrateLimit: compactAgent ? 4 : 6,
        currentMaxChars: compactAgent ? 120 : 180,
        procedureMaxChars: compactAgent ? 120 : 160,
        inspectMaxChars: compactAgent ? 120 : 180,
        rehydrateReasonMaxChars: compactAgent ? 75 : 100,
      };
    case "multi_agent_handoff":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        currentLimit: compactAgent ? 2 : 3,
        procedureLimit: compactAgent ? 2 : 3,
        inspectLimit: compactAgent ? 1 : 2,
        avoidLimit: compactAgent ? 2 : 3,
      };
    case "loop_engineering":
      return {
        ...base,
        contextCharBudget: explicitBudget ?? (compactAgent ? 4096 : 6144),
        executionContextCharBudget: Math.min(explicitBudget ?? 4096, 50_000),
        currentLimit: compactAgent ? 2 : 3,
        procedureLimit: compactAgent ? 2 : 4,
        inspectLimit: compactAgent ? 2 : 3,
        avoidLimit: compactAgent ? 2 : 3,
        procedureMaxChars: compactAgent ? 110 : 150,
      };
    case "general":
      return base;
  }
}

type AdmissionCandidatePolicyGuideModeResolution = {
  mode: "off" | "shadow" | "active";
  source: "global_env" | "profile_rule" | "off";
  profile_id?: string;
};

function selectorMatches(ruleValues: readonly string[] | undefined, actual: string | null): boolean {
  if (!ruleValues || ruleValues.length === 0) return true;
  if (!actual) return false;
  return ruleValues.includes(actual);
}

function prefixSelectorMatches(prefixes: readonly string[] | undefined, actual: string | null): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  if (!actual) return false;
  return prefixes.some((prefix) => actual.startsWith(prefix));
}

function stringFromContext(context: Record<string, unknown> | null, key: string): string | null {
  const value = context?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function admissionCandidatePolicyProfileRuleMatches(args: {
  rule: AionisAdmissionCandidatePolicyProfileRule;
  parsed: z.infer<typeof ProductGuideRequest>;
  scope: string;
  agentRole: AionisAgentRole;
}): boolean {
  const context = objectValue(args.parsed.context);
  const contextMode = args.parsed.context_mode ?? "standard";
  const guideMode = args.parsed.mode ?? "standard";
  return selectorMatches(args.rule.scopes, args.scope)
    && prefixSelectorMatches(args.rule.scope_prefixes, args.scope)
    && selectorMatches(args.rule.task_families, stringFromContext(context, "task_family"))
    && selectorMatches(args.rule.task_signatures, stringFromContext(context, "task_signature"))
    && selectorMatches(args.rule.agent_roles, args.agentRole)
    && selectorMatches(args.rule.context_modes, contextMode)
    && selectorMatches(args.rule.guide_modes, guideMode);
}

function resolveAdmissionCandidatePolicyGuideMode(args: {
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  scope: string;
  agentRole: AionisAgentRole;
}): AdmissionCandidatePolicyGuideModeResolution {
  if (args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE === "shadow"
    || args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE === "active") {
    return {
      mode: args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE,
      source: "global_env",
    };
  }
  const rules = parseAdmissionCandidatePolicyProfileRules(
    args.env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON ?? "[]",
  );
  const matched = rules.find((rule) =>
    admissionCandidatePolicyProfileRuleMatches({
      rule,
      parsed: args.parsed,
      scope: args.scope,
      agentRole: args.agentRole,
    })
  );
  if (!matched) return { mode: "off", source: "off" };
  return {
    mode: matched.mode,
    source: "profile_rule",
    profile_id: matched.profile_id,
  };
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function nestedStringField(value: unknown, key: string): string | null {
  const record = objectValue(value);
  return firstStringValue(record?.[key]);
}

function productGuideExecutionSignatures(parsed: z.infer<typeof ProductGuideRequest>): {
  taskSignature: string | null;
  taskFamily: string | null;
  workflowSignature: string | null;
} {
  const context = objectValue(parsed.context);
  return {
    taskSignature: firstStringValue(
      context?.task_signature,
      nestedStringField(parsed.execution_packet_v1, "task_signature"),
      nestedStringField(parsed.execution_state_v1, "task_signature"),
    ),
    taskFamily: firstStringValue(
      context?.task_family,
      nestedStringField(parsed.execution_packet_v1, "task_family"),
      nestedStringField(parsed.execution_state_v1, "task_family"),
    ),
    workflowSignature: firstStringValue(
      context?.workflow_signature,
      nestedStringField(parsed.execution_packet_v1, "workflow_signature"),
      nestedStringField(parsed.execution_state_v1, "workflow_signature"),
    ),
  };
}

function productGuideExecutionMemoryFilters(parsed: z.infer<typeof ProductGuideRequest>): Array<Record<string, unknown>> {
  const { taskSignature, taskFamily, workflowSignature } = productGuideExecutionSignatures(parsed);
  const filters: Array<Record<string, unknown>> = [];
  if (taskSignature) filters.push({ slots_contains: { task_signature: taskSignature }, limit: 20 });
  if (taskFamily) filters.push({ slots_contains: { task_family: taskFamily }, limit: 20 });
  if (workflowSignature) filters.push({ slots_contains: { workflow_signature: workflowSignature }, limit: 20 });
  return filters.slice(0, 3);
}

function nestedObjectField(value: unknown, key: string): Record<string, unknown> | null {
  const record = objectValue(value);
  return objectValue(record?.[key]);
}

function structuredRecallRehydrationMode(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    executionNative.rehydration_default_mode,
    objectValue(executionNative.rehydration)?.default_mode,
    nestedObjectField(row.slots.anchor_v1, "rehydration")?.default_mode,
  );
}

function structuredRecallExecutionStatus(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    objectValue(row.slots.execution_result_summary)?.status,
    objectValue(executionNative.outcome)?.status,
  );
}

function structuredRecallExecutionOutcomeRole(row: LiteExecutionNativeNodeRow): string | null {
  const executionNative = row.execution_native as Record<string, unknown>;
  return firstStringValue(
    executionNative.execution_outcome_role,
    executionNative.outcome_role,
    objectValue(row.slots.execution_observation_v1)?.execution_outcome_role,
    objectValue(row.slots.execution_observation_v1)?.outcome_role,
    objectValue(row.slots.execution_result_summary)?.execution_outcome_role,
  );
}

function productGuideStructuredReusableWorkflowAnchor(row: LiteExecutionNativeNodeRow): boolean {
  const executionNative = row.execution_native as Record<string, unknown>;
  const outcomeRole = structuredRecallExecutionOutcomeRole(row);
  const trust = firstStringValue(executionNative.contract_trust, row.slots.contract_trust);
  const layer = firstStringValue(executionNative.compression_layer, row.slots.compression_layer);
  const summaryKind = firstStringValue(executionNative.summary_kind, row.slots.summary_kind);
  const targetFiles = Array.isArray(executionNative.target_files) ? executionNative.target_files : [];
  const hasTargetSurface = targetFiles.some((entry) => typeof entry === "string" && entry.trim().length > 0)
    || !!firstStringValue(executionNative.file_path);
  return summaryKind === "workflow_anchor"
    && outcomeRole === "passed_solution"
    && hasTargetSurface
    && (trust === "authoritative" || trust === "advisory")
    && (layer === "L2" || layer === "L3" || layer === "L4" || layer === "L5" || layer === null);
}

function productGuideStructuredControlNode(row: LiteExecutionNativeNodeRow): boolean {
  const executionNative = row.execution_native as Record<string, unknown>;
  const lifecycle = firstStringValue(row.slots.lifecycle_state);
  const status = structuredRecallExecutionStatus(row);
  const rehydrationMode = structuredRecallRehydrationMode(row);
  const tier = firstStringValue(row.tier);
  const trust = firstStringValue(executionNative.contract_trust, row.slots.contract_trust);
  const layer = firstStringValue(executionNative.compression_layer, row.slots.compression_layer);
  const summaryKind = firstStringValue(executionNative.summary_kind, row.slots.summary_kind);
  const reusableWorkflowAnchor = productGuideStructuredReusableWorkflowAnchor(row);
  const currentStateKind =
    summaryKind === "current_state"
    || summaryKind === "current_active_path"
    || summaryKind === "active_state";
  const activeStateCarrier = (
    currentStateKind
    && (status === "passed" || status === "succeeded" || lifecycle === "active" || lifecycle === null)
  )
    && (trust === "authoritative" || trust === "advisory")
    && (layer === "L2" || layer === "L3" || layer === "L4" || layer === "L5" || layer === null);
  return lifecycle === "suppressed"
    || lifecycle === "disabled"
    || lifecycle === "contested"
    || lifecycle === "candidate"
    || lifecycle === "rehydration_candidate"
    || status === "failed"
    || status === "blocked"
    || status === "contested"
    || !!rehydrationMode
    || tier === "cold"
    || tier === "archive"
    || reusableWorkflowAnchor
    || activeStateCarrier;
}

type ProductGuideStructuredExecutionMatch = {
  directTaskMatch: boolean;
  workflowContinuationMatch: boolean;
};

function productGuideStructuredControlSlots(
  row: LiteExecutionNativeNodeRow,
  args: ProductGuideStructuredExecutionMatch,
): Record<string, unknown> {
  const slots: Record<string, unknown> = { ...row.slots };
  const lifecycle = firstStringValue(slots.lifecycle_state);
  const status = structuredRecallExecutionStatus(row);
  const rehydrationMode = structuredRecallRehydrationMode(row);
  const workflowAnchor = productGuideStructuredReusableWorkflowAnchor(row);
  const activeWorkflowAnchor = workflowAnchor && (args.directTaskMatch || args.workflowContinuationMatch);
  const referenceOnlyWorkflowAnchor = workflowAnchor && !activeWorkflowAnchor;
  const executionNative: Record<string, unknown> = objectValue(slots.execution_native_v1)
    ? { ...(objectValue(slots.execution_native_v1) as Record<string, unknown>) }
    : { ...row.execution_native };

  if (!firstStringValue(executionNative.rehydration_default_mode) && rehydrationMode) {
    executionNative.rehydration_default_mode = rehydrationMode;
  }
  if (activeWorkflowAnchor) {
    executionNative.summary_kind = "current_state";
    executionNative.guide_projection_kind = args.directTaskMatch
      ? "passed_workflow_anchor_active_route"
      : "passed_workflow_anchor_workflow_continuation";
  } else if (referenceOnlyWorkflowAnchor) {
    executionNative.guide_projection_kind = "workflow_anchor_reference_only";
  }
  slots.execution_native_v1 = executionNative;

  if (status === "failed" || status === "blocked" || lifecycle === "disabled") {
    slots.lifecycle_state = "suppressed";
  } else if (referenceOnlyWorkflowAnchor) {
    slots.lifecycle_state = "candidate";
  } else if (status === "contested" && !lifecycle) {
    slots.lifecycle_state = "contested";
  } else if (rehydrationMode && !lifecycle) {
    slots.lifecycle_state = "rehydration_candidate";
  }

  return slots;
}

function recallSourceKey(value: unknown): string {
  const record = objectValue(value);
  if (!record) return stableStringify(value) ?? String(value);
  return stableStringify({
    kind: record.kind,
    index_name: record.index_name,
    reason: record.reason,
    matched_fields: Array.isArray(record.matched_fields) ? record.matched_fields : [],
  }) ?? String(value);
}

function mergeRecallSourceArrays(left: unknown, right: unknown): unknown[] {
  const out: unknown[] = Array.isArray(left) ? [...left] : [];
  const seen = new Set(out.map((entry) => recallSourceKey(entry)));
  for (const entry of Array.isArray(right) ? right : []) {
    const key = recallSourceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

type ProductMemoryPacketEntry = AionisMemoryPacket["relevant_memories"][number];

function mergeStructuredExecutionControlEntry(
  base: ProductMemoryPacketEntry,
  structured: ProductMemoryPacketEntry,
): ProductMemoryPacketEntry {
  return {
    ...base,
    authority: structured.authority,
    lifecycle_state: structured.lifecycle_state,
    target_files: structured.target_files.length > 0 ? structured.target_files : base.target_files,
    execution_state: structured.execution_state ?? base.execution_state,
    memory_contract: structured.memory_contract,
    recall_sources: mergeRecallSourceArrays(
      base.recall_sources,
      structured.recall_sources,
    ) as ProductMemoryPacketEntry["recall_sources"],
  };
}

function mergedMemoryPacketLifecycle(args: {
  entries: ProductMemoryPacketEntry[];
  base: AionisMemoryPacket["lifecycle"];
  supplemental: AionisMemoryPacket["lifecycle"];
}): AionisMemoryPacket["lifecycle"] {
  const rehydrationHintsById = new Map([
    ...args.base.rehydration_hints,
    ...args.supplemental.rehydration_hints,
  ].map((hint) => [hint.memory_id, hint]));
  return {
    used_memory_ids: args.entries
      .filter((entry) => entry.authority !== "blocked")
      .map((entry) => entry.memory_id),
    candidate_memory_ids: args.entries
      .filter((entry) => entry.authority === "candidate")
      .map((entry) => entry.memory_id),
    suppressed_memory_ids: args.entries
      .filter((entry) => entry.lifecycle_state === "suppressed" || entry.authority === "blocked")
      .map((entry) => entry.memory_id),
    archived_memory_ids: args.entries
      .filter((entry) => entry.lifecycle_state === "archived")
      .map((entry) => entry.memory_id),
    rehydration_hints: args.entries
      .filter((entry) => entry.lifecycle_state === "rehydration_candidate")
      .map((entry) => rehydrationHintsById.get(entry.memory_id) ?? {
        memory_id: entry.memory_id,
        mode: "differential" as const,
        reason: "Cold memory was relevant enough to recall, but payload should be rehydrated only if needed.",
        required: false,
      }),
  };
}

function mergeAionisMemoryPackets(
  base: AionisMemoryPacket | null,
  supplemental: AionisMemoryPacket | null,
): { packet: AionisMemoryPacket | null; changed: boolean } {
  if (!supplemental || supplemental.relevant_memories.length === 0) return { packet: base, changed: false };
  if (!base) return { packet: supplemental, changed: true };

  const seenMemoryIds = new Set(base.relevant_memories.map((entry) => entry.memory_id));
  const supplementalById = new Map(supplemental.relevant_memories.map((entry) => [entry.memory_id, entry]));
  let structuredProjectionChanged = false;
  const baseMemoriesWithMergedSources = base.relevant_memories.map((entry) => {
    const duplicate = supplementalById.get(entry.memory_id);
    if (!duplicate) return entry;
    const merged = mergeStructuredExecutionControlEntry(entry, duplicate);
    if (stableStringify(merged) !== stableStringify(entry)) structuredProjectionChanged = true;
    return merged;
  });
  const relevantMemories = [
    ...baseMemoriesWithMergedSources,
    ...supplemental.relevant_memories.filter((entry) => {
      if (seenMemoryIds.has(entry.memory_id)) return false;
      seenMemoryIds.add(entry.memory_id);
      return true;
    }),
  ];
  const changed = relevantMemories.length > base.relevant_memories.length || structuredProjectionChanged;
  if (!changed) return { packet: base, changed: false };

  const evidenceIds = new Set<string>();
  const evidenceTrail = [...base.evidence_trail, ...supplemental.evidence_trail].filter((entry) => {
    if (evidenceIds.has(entry.evidence_id)) return false;
    evidenceIds.add(entry.evidence_id);
    return true;
  });
  const contradictionWarnings = [
    ...base.contradiction_warnings,
    ...supplemental.contradiction_warnings.filter((entry) =>
      !base.contradiction_warnings.some((existing) =>
        existing.memory_id === entry.memory_id && existing.suggested_action === entry.suggested_action
      )
    ),
  ];
  const domains = new Set(relevantMemories.map((entry) => entry.domain));
  const memoryFamily: AionisMemoryPacket["memory_family"] =
    relevantMemories.length === 0
      ? "empty"
      : domains.size > 1
        ? "mixed"
        : domains.has("execution")
          ? "execution"
          : "general_cognitive";
  const staleMemoryCount = relevantMemories.filter((entry) =>
    entry.lifecycle_state === "suppressed"
    || entry.lifecycle_state === "demoted"
    || entry.lifecycle_state === "archived"
  ).length;
  const lifecycle = mergedMemoryPacketLifecycle({
    entries: relevantMemories,
    base: base.lifecycle,
    supplemental: supplemental.lifecycle,
  });

  return {
    packet: AionisMemoryPacketSchema.parse({
      ...base,
      memory_family: memoryFamily,
      relevant_memories: relevantMemories,
      evidence_trail: evidenceTrail,
      lifecycle,
      contradiction_warnings: contradictionWarnings,
      forgetting_state: {
        stale_memory_count: staleMemoryCount,
        suppressed_count: relevantMemories.filter((entry) => entry.lifecycle_state === "suppressed").length,
        archived_count: relevantMemories.filter((entry) => entry.lifecycle_state === "archived").length,
        rehydration_candidate_count: lifecycle.rehydration_hints.length,
      },
      behavior_impact: {
        will_shape_behavior:
          base.behavior_impact.will_shape_behavior || supplemental.behavior_impact.will_shape_behavior,
        changed_fields: uniqueStrings([
          ...base.behavior_impact.changed_fields,
          ...supplemental.behavior_impact.changed_fields,
          "structured_execution_control_recall",
        ]),
        expected_effects: Array.from(new Set([
          ...base.behavior_impact.expected_effects,
          ...supplemental.behavior_impact.expected_effects,
        ])),
        explanation: `${base.behavior_impact.explanation} Full-power guide also merged task-scoped execution control memory for safer context compilation.`,
      },
      risk: {
        negative_transfer_risk: maxRisk(
          base.risk.negative_transfer_risk,
          supplemental.risk.negative_transfer_risk,
        ),
        contradiction_count: contradictionWarnings.length,
        low_confidence_count: relevantMemories.filter((entry) => entry.confidence < 0.6).length,
        stale_memory_count: staleMemoryCount,
        reasons: mergeGuideStrings([
          ...base.risk.reasons,
          ...supplemental.risk.reasons,
          "full_power_structured_execution_control_memory_present",
        ], 8),
      },
      source_map: {
        routes_used: uniqueStrings([
          ...base.source_map.routes_used,
          ...supplemental.source_map.routes_used,
        ]),
        internal_surfaces_used: uniqueStrings([
          ...base.source_map.internal_surfaces_used,
          ...supplemental.source_map.internal_surfaces_used,
          "full_power_structured_execution_recall",
        ]),
        omitted_internal_surfaces: uniqueStrings([
          ...base.source_map.omitted_internal_surfaces,
          ...supplemental.source_map.omitted_internal_surfaces,
        ]),
      },
    }),
    changed: true,
  };
}

async function buildProductGuideStructuredExecutionPacket(args: {
  liteWriteStore: LiteWriteStore;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  public_scope: string;
  store_scope: string;
}): Promise<AionisMemoryPacket | null> {
  const { taskSignature, taskFamily, workflowSignature } = productGuideExecutionSignatures(args.parsed);
  if (!taskSignature && !taskFamily && !workflowSignature) return null;

  const batches = await Promise.all([
    taskSignature
      ? args.liteWriteStore.findExecutionNativeNodes({
          scope: args.store_scope,
          taskSignature,
          consumerAgentId: args.parsed.consumer_agent_id ?? null,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
          limit: PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT,
          offset: 0,
        })
      : Promise.resolve({ rows: [] as LiteExecutionNativeNodeRow[], has_more: false }),
    taskFamily
      ? args.liteWriteStore.findExecutionNativeNodes({
          scope: args.store_scope,
          taskFamily,
          consumerAgentId: args.parsed.consumer_agent_id ?? null,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
          limit: PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT,
          offset: 0,
        })
      : Promise.resolve({ rows: [] as LiteExecutionNativeNodeRow[], has_more: false }),
    workflowSignature
      ? args.liteWriteStore.findExecutionNativeNodes({
          scope: args.store_scope,
          workflowSignature,
          consumerAgentId: args.parsed.consumer_agent_id ?? null,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
          limit: PRODUCT_GUIDE_STRUCTURED_EXECUTION_PREFETCH_LIMIT,
          offset: 0,
        })
      : Promise.resolve({ rows: [] as LiteExecutionNativeNodeRow[], has_more: false }),
  ]);
  const taskMatchedIds = new Set(batches[0].rows.map((row) => row.id));
  const workflowMatchedIds = new Set(batches[2].rows.map((row) => row.id));
  const rowsById = new Map<string, LiteExecutionNativeNodeRow>();
  for (const row of batches.flatMap((batch) => batch.rows)) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  const rows = Array.from(rowsById.values())
    .filter(productGuideStructuredControlNode)
    .slice(0, PRODUCT_GUIDE_STRUCTURED_EXECUTION_PACKET_LIMIT);
  if (rows.length === 0) return null;

  const matchForRow = (row: LiteExecutionNativeNodeRow): ProductGuideStructuredExecutionMatch => {
    const directTaskMatch = taskMatchedIds.has(row.id);
    const workflowContinuationMatch = !directTaskMatch && workflowMatchedIds.has(row.id);
    return {
      directTaskMatch,
      workflowContinuationMatch,
    };
  };
  const nodes: BuildAionisMemoryPacketArgs["nodes"] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    text_summary: row.text_summary,
    tier: row.tier,
    slots: productGuideStructuredControlSlots(row, matchForRow(row)),
    raw_ref: row.raw_ref,
    evidence_ref: row.evidence_ref,
    commit_id: row.commit_id,
    producer_agent_id: row.producer_agent_id,
    owner_agent_id: row.owner_agent_id,
    owner_team_id: row.owner_team_id,
    confidence: row.confidence,
    salience: row.salience,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  const matchedFields = uniqueStrings([
    taskSignature ? "task_signature" : null,
    taskFamily ? "task_family" : null,
    workflowSignature ? "workflow_signature" : null,
  ]);

  return buildAionisMemoryPacket({
    tenant_id: args.tenant_id,
    scope: args.public_scope,
    actor: {
      consumer_agent_id: args.parsed.consumer_agent_id ?? null,
      consumer_team_id: args.parsed.consumer_team_id ?? null,
      producer_agent_ids: [],
    },
    query: {
      source: "text",
      intent: args.parsed.query_text,
    },
    nodes,
    ranked: nodes.map((node, index) => ({
      id: node.id,
      score: Math.max(0.5, 0.99 - index * 0.01),
    })),
    recall_sources_by_memory_id: Object.fromEntries(nodes.map((node, index) => [
      node.id,
      [{
        kind: "execution_native",
        score: Math.max(0.5, 0.99 - index * 0.01),
        reason: "structured_execution_signature_recall",
        matched_fields: matchedFields,
        index_name: "lite_memory_execution_native_index",
      }],
    ])),
    source_map: {
      routes_used: ["/v1/guide"],
      internal_surfaces_used: [
        "structured_execution_signature_recall",
        "memory_contract_projection",
        "semantic_forgetting_surface",
      ],
      omitted_internal_surfaces: [
        "raw_embedding_vectors",
        "raw_slots",
        "full_payloads",
      ],
    },
  });
}

function riskRank(value: AionisAgentContext["risk"]["negative_transfer_risk"]): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function maxRisk(
  left: AionisAgentContext["risk"]["negative_transfer_risk"],
  right: AionisAgentContext["risk"]["negative_transfer_risk"],
): AionisAgentContext["risk"]["negative_transfer_risk"] {
  return riskRank(left) >= riskRank(right) ? left : right;
}

function mergeGuideStrings(values: string[], limit: number): string[] {
  return uniqueStrings(values).slice(0, limit);
}

function claimLedgerProjectionHasPromptSurface(projection: AionisClaimLedgerProjection | null): projection is AionisClaimLedgerProjection {
  return !!projection && (
    projection.use_now.length > 0
    || projection.inspect_before_use.length > 0
    || projection.do_not_use.length > 0
  );
}

async function buildProductGuideClaimLedgerProjection(args: {
  claimLedgerAccess: ClaimLedgerAccess | null | undefined;
  tenantId: string;
  scope: string;
  queryText?: string | null;
}): Promise<AionisClaimLedgerProjection | null> {
  if (!args.claimLedgerAccess) return null;
  const live = await args.claimLedgerAccess.findLiveClaims({
    tenantId: args.tenantId,
    scope: args.scope,
    limit: CLAIM_LEDGER_GUIDE_LIVE_LIMIT,
  });
  const slotKeys = uniqueStrings(live.rows.map((row) => row.slot_key)).slice(
    0,
    CLAIM_LEDGER_GUIDE_SUPERSEDED_SLOT_LIMIT,
  );
  const supersededRows: ClaimLedgerRow[] = [];
  const supersededIds = new Set<string>();
  for (const slotKey of slotKeys) {
    const superseded = await args.claimLedgerAccess.findSupersededClaims({
      tenantId: args.tenantId,
      scope: args.scope,
      slotKey,
      limit: CLAIM_LEDGER_GUIDE_SUPERSEDED_PER_SLOT_LIMIT,
    });
    for (const row of superseded.rows) {
      if (supersededIds.has(row.claim_id)) continue;
      supersededIds.add(row.claim_id);
      supersededRows.push(row);
    }
  }
  if (live.rows.length === 0 && supersededRows.length === 0) return null;
  return buildClaimLedgerProjection({
    liveClaims: live.rows,
    supersededClaims: supersededRows,
    queryText: args.queryText,
    limit: CLAIM_LEDGER_GUIDE_LIVE_LIMIT,
  });
}

function buildGuideTraceId(): string {
  return `guide_trace:${randomUUID()}`;
}

function buildGuideExposureLedger(args: {
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): ProductGuideExposureLedger {
  return {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: args.guideTraceId,
    tenant_id: args.tenant_id,
    scope: args.scope,
    run_id: args.parsed.run_id ?? null,
    consumer_agent_id: args.parsed.consumer_agent_id ?? null,
    consumer_team_id: args.parsed.consumer_team_id ?? null,
    query_sha256: sha256Hex(args.parsed.query_text),
    context_sha256: sha256Hex(stableStringify(args.parsed.context ?? {})),
    memory_ids: args.agentContext.memory_ids,
    use_now_memory_ids: args.agentContext.use_now_memory_ids,
    inspect_before_use_memory_ids: args.agentContext.inspect_before_use_memory_ids,
    do_not_use_memory_ids: args.agentContext.do_not_use_memory_ids,
    rehydrate_memory_ids: args.agentContext.rehydrate_hints.map((hint) => hint.memory_id),
    prompt_char_count: args.agentContext.prompt_text.length,
    history_used: args.agentContext.history_used,
    actionable_history_used: args.agentContext.actionable_history_used,
    recommended_posture: args.agentContext.recommended_posture,
    authority: args.agentContext.authority,
  };
}

function hasAnyAttributedUse(slots: Record<string, unknown>): boolean {
  return nonNegativeInt(slots.attributed_use_count) > 0
    || nonNegativeInt(slots.positive_attributed_use_count) > 0
    || nonNegativeInt(slots.feedback_positive) > 0
    || nonNegativeInt(slots.feedback_negative) > 0;
}

function parseAgentContextObservedTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function resolveRepeatedUnusedActiveProjectionIds(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  actor: string;
  currentLedger: ProductGuideExposureLedger;
  historicalLedgers: ProductGuideExposureLedger[];
}): Promise<string[]> {
  const exposureThreshold = 2;
  const useNowIds = uniqueStrings(args.currentLedger.use_now_memory_ids);
  const candidates: string[] = [];
  for (const memoryId of useNowIds) {
    let useNowExposureCount = 0;
    for (const ledger of args.historicalLedgers) {
      if (ledger.guide_trace_id === args.currentLedger.guide_trace_id) continue;
      if (!sameGuideExposureConsumer(ledger, args.currentLedger)) continue;
      if (guideExposureSurfaceIds(ledger, "use_now_memory_ids").has(memoryId)) {
        useNowExposureCount += 1;
      }
    }
    if (useNowExposureCount < exposureThreshold) continue;
    const slots = await findMemoryNodeSlots({
      liteWriteStore: args.liteWriteStore,
      env: args.env,
      tenant_id: args.tenant_id,
      scope: args.scope,
      memory_id: memoryId,
      actor: args.actor,
      consumerTeamId: args.currentLedger.consumer_team_id,
    });
    if (hasAnyAttributedUse(slots)) continue;
    candidates.push(memoryId);
  }
  return uniqueStrings(candidates);
}

async function resolveTimeDecayActiveProjectionIds(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  actor: string;
  consumerTeamId: string | null;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
}): Promise<string[]> {
  const memoryEntries = args.memoryPacket?.relevant_memories ?? [];
  const observedTimes = memoryEntries
    .map((entry) => parseAgentContextObservedTime(entry.observed_at))
    .filter((entry): entry is number => entry !== null);
  if (observedTimes.length === 0) return [];
  const referenceObservedTime = Math.max(...observedTimes);
  const currentUseNowIds = new Set(args.agentContext.use_now_memory_ids);
  const candidates: string[] = [];
  for (const entry of memoryEntries) {
    if (!currentUseNowIds.has(entry.memory_id)) continue;
    if (entry.lifecycle_state !== "active") continue;
    if (entry.authority !== "trusted" && entry.authority !== "advisory") continue;
    const observedTime = parseAgentContextObservedTime(entry.observed_at);
    if (observedTime === null || observedTime >= referenceObservedTime) continue;
    const ageDays = Math.floor((referenceObservedTime - observedTime) / (24 * 60 * 60 * 1000));
    if (ageDays < AIONIS_CONFIDENCE_DECAY_TIME_THRESHOLD_DAYS) continue;
    const slots = await findMemoryNodeSlots({
      liteWriteStore: args.liteWriteStore,
      env: args.env,
      tenant_id: args.tenant_id,
      scope: args.scope,
      memory_id: entry.memory_id,
      actor: args.actor,
      consumerTeamId: args.consumerTeamId,
    });
    if (nonNegativeInt(slots.positive_attributed_use_count) > 0) continue;
    candidates.push(entry.memory_id);
  }
  return uniqueStrings(candidates);
}

async function resolveInspectBeforeUseActiveProjectionIds(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): Promise<string[]> {
  const actor = args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID;
  const currentLedger = buildGuideExposureLedger({
    parsed: args.parsed,
    tenant_id: args.tenant_id,
    scope: args.scope,
    agentContext: args.agentContext,
    guideTraceId: args.guideTraceId,
  });
  const historicalLedgers = await findHistoricalGuideExposureLedgers({
    liteWriteStore: args.liteWriteStore,
    env: args.env,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
  });
  const repeatedUnusedIds = await resolveRepeatedUnusedActiveProjectionIds({
    liteWriteStore: args.liteWriteStore,
    env: args.env,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    currentLedger,
    historicalLedgers,
  });
  const timeDecayIds = await resolveTimeDecayActiveProjectionIds({
    liteWriteStore: args.liteWriteStore,
    env: args.env,
    tenant_id: args.tenant_id,
    scope: args.scope,
    actor,
    consumerTeamId: args.parsed.consumer_team_id ?? null,
    memoryPacket: args.memoryPacket,
    agentContext: args.agentContext,
  });
  return uniqueStrings([...repeatedUnusedIds, ...timeDecayIds]);
}

async function resolveAdmissionCandidatePolicyGuideProjection(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  parsed: z.infer<typeof ProductGuideRequest>;
  tenant_id: string;
  scope: string;
  memoryPacket: AionisMemoryPacket | null;
  agentContext: AionisAgentContext;
  mode: "shadow" | "active";
}): Promise<AionisAdmissionCandidatePolicyActiveProjection | null> {
  const currentUseNowIds = uniqueStrings(args.agentContext.use_now_memory_ids);
  if (!args.memoryPacket) return null;
  const actor = args.parsed.consumer_agent_id ?? args.env.LITE_LOCAL_ACTOR_ID;
  const slotByMemoryId = new Map<string, Record<string, unknown>>();
  for (const memoryId of currentUseNowIds) {
    try {
      slotByMemoryId.set(
        memoryId,
        await findMemoryNodeSlots({
          liteWriteStore: args.liteWriteStore,
          env: args.env,
          tenant_id: args.tenant_id,
          scope: args.scope,
          memory_id: memoryId,
          actor,
          consumerTeamId: args.parsed.consumer_team_id ?? null,
        }),
      );
    } catch {
      slotByMemoryId.set(memoryId, {});
    }
  }
  const projection = resolveAionisAdmissionCandidatePolicyActiveProjection({
    agent_context: args.agentContext,
    memory_packet: args.memoryPacket,
    slot_by_memory_id: slotByMemoryId,
    mode: args.mode,
  });
  if (projection.hard_boundary_upgrade_count > 0) return null;
  return projection;
}

export type AionisMemoryAdmissionGatewayMode = "standard" | "strict" | "firewall";

export type AionisMemoryAdmissionGatewayContextMode = "standard" | "compact_agent";

export type GovernExternalMemoryCandidatesArgs = {
  tenant_id?: string | null;
  scope?: string | null;
  run_id?: string | null;
  query_text: string;
  candidates: AionisExternalMemoryCandidate[];
  mode?: AionisMemoryAdmissionGatewayMode | null;
  context_mode?: AionisMemoryAdmissionGatewayContextMode | null;
  now?: string | null;
};

export type AionisMemoryAdmissionGatewayResult = {
  contract_version: "aionis_memory_admission_gateway_result_v1";
  tenant_id: string;
  scope: string;
  run_id: string | null;
  mode: AionisMemoryAdmissionGatewayMode;
  agent_context: AionisAgentContext;
  memory_use_receipt: AionisMemoryUseReceipt;
  memory_admission_records: AionisMemoryAdmissionRecord;
  memory_firewall?: AionisMemoryFirewallSummary;
  admission_summary: {
    contract_version: "aionis_external_memory_admission_summary_v1";
    candidate_count: number;
    use_now_count: number;
    inspect_before_use_count: number;
    do_not_use_count: number;
    rehydrate_count: number;
    source_backends: string[];
    runtime_mutation: false;
    agent_prompt_included: false;
    reason: string;
  };
  source_map: {
    routes_used: string[];
    internal_surfaces_used: string[];
    omitted_internal_surfaces: string[];
  };
};

type externalAdmissionAdmittedCandidate = {
  candidate: AionisExternalMemoryCandidate;
  action: AionisMemoryDecisionSurface;
  decision_kind: "used" | "downgraded" | "blocked" | "rehydrate" | "not_agent_facing";
  authority: AionisGuidanceAuthority;
  lifecycle_state: AionisMemoryAdmissionRecord["entries"][number]["lifecycle_state"];
  domain: AionisMemoryDomain;
  memory_type: AionisMemoryAdmissionRecord["entries"][number]["memory_type"];
  title: string | null;
  target_files: string[];
  reason_codes: string[];
  prompt_text: string;
};

const externalAdmissionTARGET_PATH_PATTERN = /(?:^|[\s"'`])(?:src|app|lib|packages|tests?|scripts|docs|services|routes|components)\//i;

function externalAdmissionCompactStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function externalAdmissionTextValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function externalAdmissionStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return externalAdmissionCompactStrings(value.map((entry) => typeof entry === "string" ? entry : null)).slice(0, 64);
}

function externalAdmissionTruncateText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function externalAdmissionTitleForCandidate(candidate: AionisExternalMemoryCandidate): string | null {
  return externalAdmissionTextValue(candidate.metadata.title)
    ?? externalAdmissionTextValue(candidate.metadata.name)
    ?? externalAdmissionTruncateText(candidate.text, 96);
}

function externalAdmissionTargetFilesForCandidate(candidate: AionisExternalMemoryCandidate): string[] {
  return externalAdmissionCompactStrings([
    ...externalAdmissionStringArray(candidate.metadata.target_files),
    ...externalAdmissionStringArray(candidate.metadata.files),
    ...externalAdmissionStringArray(candidate.metadata.paths),
  ]).slice(0, 32);
}

function externalAdmissionDomainForCandidate(candidate: AionisExternalMemoryCandidate): AionisMemoryDomain {
  const explicit = externalAdmissionTextValue(candidate.metadata.domain);
  if (explicit === "execution" || explicit === "general") return explicit;
  if (candidate.lifecycle_hint === "procedure") return "execution";
  if (externalAdmissionTargetFilesForCandidate(candidate).length > 0 || externalAdmissionTARGET_PATH_PATTERN.test(candidate.text)) return "execution";
  return "general";
}

function externalAdmissionMemoryTypeForCandidate(
  candidate: AionisExternalMemoryCandidate,
): AionisMemoryAdmissionRecord["entries"][number]["memory_type"] {
  const explicit = externalAdmissionTextValue(candidate.metadata.memory_type);
  if (
    explicit === "fact"
    || explicit === "preference"
    || explicit === "project_context"
    || explicit === "procedure"
    || explicit === "event"
    || explicit === "evidence"
    || explicit === "rule"
    || explicit === "execution_memory"
    || explicit === "unknown"
  ) {
    return explicit;
  }
  if (candidate.lifecycle_hint === "procedure") return "procedure";
  if (externalAdmissionDomainForCandidate(candidate) === "execution") return "execution_memory";
  return "unknown";
}

function externalAdmissionLifecycleStateForCandidate(
  candidate: AionisExternalMemoryCandidate,
  action: AionisMemoryDecisionSurface,
): AionisMemoryAdmissionRecord["entries"][number]["lifecycle_state"] {
  if (action === "rehydrate") return "rehydration_candidate";
  switch (candidate.lifecycle_hint) {
    case "current":
    case "procedure":
      return "active";
    case "failed":
    case "contested":
      return "contested";
    case "stale":
      return "demoted";
    case "suppressed":
      return "suppressed";
    case "archived":
      return "archived";
    case "unknown":
      return "unknown";
  }
}

function externalAdmissionUnsafeLifecycleHint(hint: AionisExternalMemoryLifecycleHint): boolean {
  return hint === "failed" || hint === "stale" || hint === "contested";
}

function externalAdmissionActionForCandidate(args: {
  candidate: AionisExternalMemoryCandidate;
  mode: AionisMemoryAdmissionGatewayMode;
  unsafeTextSignal: boolean;
}): AionisMemoryDecisionSurface {
  const { candidate, mode, unsafeTextSignal } = args;
  const requirement = candidate.authority.evidence_requirement;
  const trust = candidate.authority.source_trust;
  const lifecycle = candidate.lifecycle_hint;
  if (requirement === "blocked" || lifecycle === "suppressed" || lifecycle === "archived") return "do_not_use";
  if (requirement === "rehydrate_before_use") return "rehydrate";
  if (unsafeTextSignal || externalAdmissionUnsafeLifecycleHint(lifecycle)) {
    return mode === "firewall" ? "do_not_use" : "inspect_before_use";
  }
  if (requirement === "inspect_before_use") return "inspect_before_use";
  const trustedEnough = mode === "strict" || mode === "firewall"
    ? trust === "trusted"
    : trust === "trusted" || trust === "known";
  if (trustedEnough && (lifecycle === "current" || lifecycle === "procedure")) return "use_now";
  return "inspect_before_use";
}

function externalAdmissionDecisionKindForAction(action: AionisMemoryDecisionSurface): externalAdmissionAdmittedCandidate["decision_kind"] {
  switch (action) {
    case "use_now": return "used";
    case "inspect_before_use": return "downgraded";
    case "do_not_use": return "blocked";
    case "rehydrate": return "rehydrate";
    case "not_agent_facing": return "not_agent_facing";
  }
}

function externalAdmissionAuthorityForAction(action: AionisMemoryDecisionSurface): AionisGuidanceAuthority {
  switch (action) {
    case "use_now": return "trusted";
    case "inspect_before_use": return "advisory";
    case "rehydrate": return "advisory";
    case "do_not_use": return "blocked";
    case "not_agent_facing": return "none";
  }
}

function externalAdmissionPromptLineForCandidate(candidate: AionisExternalMemoryCandidate, action: AionisMemoryDecisionSurface): string {
  const title = externalAdmissionTitleForCandidate(candidate) ?? candidate.external_memory_id;
  const refs = candidate.evidence_refs.length > 0 ? ` refs=${candidate.evidence_refs.slice(0, 3).join(",")}` : "";
  const body = action === "do_not_use"
    ? `${title}; reason=${candidate.lifecycle_hint}/${candidate.authority.evidence_requirement}${refs}`
    : `${title}: ${externalAdmissionTruncateText(candidate.text, action === "use_now" ? 480 : 360)}${refs}`;
  return `[${candidate.external_memory_id}] ${body}`;
}

function externalAdmissionAdmittedCandidates(args: {
  candidates: AionisExternalMemoryCandidate[];
  mode: AionisMemoryAdmissionGatewayMode;
}): externalAdmissionAdmittedCandidate[] {
  const signals = inferLifecycleCandidateSignals({
    entries: args.candidates.map((candidate) => ({
      memory_id: candidate.external_memory_id,
      title: externalAdmissionTitleForCandidate(candidate),
      summary: candidate.text,
      memory_type: externalAdmissionMemoryTypeForCandidate(candidate),
      domain: externalAdmissionDomainForCandidate(candidate),
      lifecycle_state: candidate.lifecycle_hint,
      authority: candidate.authority.source_trust,
      target_files: externalAdmissionTargetFilesForCandidate(candidate),
    })),
  });
  const unsafeSignalIds = new Set(signals.filter(lifecycleCandidateDirectUseUnsafe).map((signal) => signal.memory_id));
  return args.candidates.map((candidate) => {
    const action = externalAdmissionActionForCandidate({
      candidate,
      mode: args.mode,
      unsafeTextSignal: unsafeSignalIds.has(candidate.external_memory_id),
    });
    const targetFiles = externalAdmissionTargetFilesForCandidate(candidate);
    const reasonCodes = externalAdmissionCompactStrings([
      "external_candidate_admission",
      `mode:${args.mode}`,
      `source_backend:${candidate.source_backend}`,
      `source_trust:${candidate.authority.source_trust}`,
      `scope:${candidate.authority.scope}`,
      `evidence_requirement:${candidate.authority.evidence_requirement}`,
      `lifecycle_hint:${candidate.lifecycle_hint}`,
      unsafeSignalIds.has(candidate.external_memory_id) ? "lifecycle_candidate_signal:unsafe_direct_use" : null,
      action === "use_now" ? "trusted_current_or_procedure_candidate" : null,
      action === "inspect_before_use" ? "candidate_requires_inspection_before_direct_use" : null,
      action === "do_not_use" ? "candidate_blocked_from_agent_action" : null,
      action === "rehydrate" ? "candidate_requires_rehydration_before_exact_use" : null,
    ]);
    return {
      candidate,
      action,
      decision_kind: externalAdmissionDecisionKindForAction(action),
      authority: externalAdmissionAuthorityForAction(action),
      lifecycle_state: externalAdmissionLifecycleStateForCandidate(candidate, action),
      domain: externalAdmissionDomainForCandidate(candidate),
      memory_type: externalAdmissionMemoryTypeForCandidate(candidate),
      title: externalAdmissionTitleForCandidate(candidate),
      target_files: targetFiles,
      reason_codes: reasonCodes,
      prompt_text: externalAdmissionPromptLineForCandidate(candidate, action),
    };
  });
}

function externalAdmissionPostureForExternal(entries: externalAdmissionAdmittedCandidate[]): AionisAgentContext["recommended_posture"] {
  if (entries.some((entry) => entry.action === "use_now")) return "reuse_supported_history";
  if (entries.some((entry) => entry.action === "rehydrate")) return "rehydrate_before_use";
  if (entries.some((entry) => entry.action === "inspect_before_use")) return "inspect_before_use";
  if (entries.some((entry) => entry.action === "do_not_use")) return "ignore_history";
  return "ignore_history";
}

function externalAdmissionContextAuthorityForExternal(entries: externalAdmissionAdmittedCandidate[]): AionisGuidanceAuthority {
  if (entries.some((entry) => entry.action === "inspect_before_use" || entry.action === "rehydrate")) return "advisory";
  if (entries.some((entry) => entry.action === "do_not_use")) return "blocked";
  if (entries.some((entry) => entry.action === "use_now")) return "trusted";
  return "none";
}

function externalAdmissionRiskLevelForExternal(entries: externalAdmissionAdmittedCandidate[]): AionisRiskLevel {
  if (entries.some((entry) => entry.action === "do_not_use" || externalAdmissionUnsafeLifecycleHint(entry.candidate.lifecycle_hint))) return "high";
  if (entries.some((entry) => entry.action === "inspect_before_use" || entry.action === "rehydrate")) return "medium";
  return "low";
}

function externalAdmissionEntryUnsafeForDirectUse(entry: externalAdmissionAdmittedCandidate): boolean {
  return externalAdmissionUnsafeLifecycleHint(entry.candidate.lifecycle_hint)
    || entry.candidate.lifecycle_hint === "suppressed"
    || entry.candidate.lifecycle_hint === "archived"
    || entry.candidate.authority.evidence_requirement === "blocked"
    || entry.reason_codes.includes("lifecycle_candidate_signal:unsafe_direct_use");
}

function externalAdmissionBuildMemoryFirewallSummary(entries: externalAdmissionAdmittedCandidate[]): AionisMemoryFirewallSummary {
  const directUse = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const blocked = entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = entries.filter((entry) => entry.action === "rehydrate");
  const unsafe = entries.filter(externalAdmissionEntryUnsafeForDirectUse);
  const unsafeDirectUse = unsafe.filter((entry) => entry.action === "use_now");
  const externallyUntrusted = entries.filter((entry) =>
    entry.candidate.authority.source_trust === "unknown" || entry.candidate.authority.source_trust === "untrusted"
  );
  const externallyUntrustedDirectUse = externallyUntrusted.filter((entry) => entry.action === "use_now");
  const rehydrateRequired = entries.filter((entry) => entry.candidate.authority.evidence_requirement === "rehydrate_before_use");
  const missedRehydrate = rehydrateRequired.filter((entry) => entry.action !== "rehydrate");
  const explicitBlocks = entries.filter((entry) =>
    entry.candidate.lifecycle_hint === "suppressed"
    || entry.candidate.lifecycle_hint === "archived"
    || entry.candidate.authority.evidence_requirement === "blocked"
  );
  const missedExplicitBlocks = explicitBlocks.filter((entry) => entry.action !== "do_not_use");
  const claim = (claimText: string, status: "pass" | "warn" | "fail", evidence: string) => ({
    claim: claimText,
    status,
    evidence,
  });
  return parseAionisMemoryFirewallSummary({
    contract_version: "aionis_memory_firewall_summary_v1",
    intended_use: "memory_firewall_audit",
    mode: "firewall",
    candidate_count: entries.length,
    direct_use_count: directUse.length,
    inspect_count: inspect.length,
    blocked_count: blocked.length,
    rehydrate_count: rehydrate.length,
    unsafe_candidate_count: unsafe.length,
    unsafe_direct_use_count: unsafeDirectUse.length,
    runtime_mutation: false,
    agent_prompt_included: false,
    risk_flags: externalAdmissionCompactStrings([
      unsafe.length > 0 ? `unsafe_candidate_count:${unsafe.length}` : null,
      unsafeDirectUse.length > 0 ? `unsafe_direct_use_count:${unsafeDirectUse.length}` : null,
      blocked.length > 0 ? `blocked_count:${blocked.length}` : null,
      inspect.length > 0 ? `inspect_count:${inspect.length}` : null,
      rehydrate.length > 0 ? `rehydrate_count:${rehydrate.length}` : null,
      externallyUntrusted.length > 0 ? `untrusted_or_unknown_count:${externallyUntrusted.length}` : null,
    ]),
    claims: [
      claim(
        "Unsafe lifecycle candidates cannot enter direct use.",
        unsafeDirectUse.length === 0 ? "pass" : "fail",
        `${unsafeDirectUse.length}/${unsafe.length} unsafe candidates entered use_now.`,
      ),
      claim(
        "Suppressed, archived, or policy-blocked candidates are blocked.",
        missedExplicitBlocks.length === 0 ? "pass" : "fail",
        `${explicitBlocks.length - missedExplicitBlocks.length}/${explicitBlocks.length} explicit block candidates routed to do_not_use.`,
      ),
      claim(
        "Unknown or untrusted external sources do not direct the Agent.",
        externallyUntrusted.length === 0
          ? "warn"
          : externallyUntrustedDirectUse.length === 0
            ? "pass"
            : "fail",
        `${externallyUntrustedDirectUse.length}/${externallyUntrusted.length} unknown or untrusted candidates entered use_now.`,
      ),
      claim(
        "Rehydrate-required candidates stay pointer-only until expanded.",
        rehydrateRequired.length === 0
          ? "warn"
          : missedRehydrate.length === 0
            ? "pass"
            : "fail",
        `${rehydrate.length}/${rehydrateRequired.length} rehydrate-required candidates routed to rehydrate.`,
      ),
      claim(
        "Firewall admission is read-only.",
        "pass",
        "Runtime mutation is false and external candidates are not written to memory nodes.",
      ),
    ],
    summary: `Memory Firewall routed ${entries.length} external candidates into ${directUse.length} use_now, ${inspect.length} inspect, ${blocked.length} do_not_use, and ${rehydrate.length} rehydrate decisions; unsafe direct-use count is ${unsafeDirectUse.length}.`,
  });
}

function externalAdmissionSectionLines(title: string, entries: externalAdmissionAdmittedCandidate[]): string[] {
  if (entries.length === 0) return [];
  return [
    `${title}:`,
    ...entries.map((entry) => `- ${entry.prompt_text}`),
  ];
}

function externalAdmissionBuildPrompt(args: {
  query_text: string;
  entries: externalAdmissionAdmittedCandidate[];
  mode: AionisMemoryAdmissionGatewayMode;
  context_mode: AionisMemoryAdmissionGatewayContextMode;
}): string {
  const useNow = args.entries.filter((entry) => entry.action === "use_now");
  const inspect = args.entries.filter((entry) => entry.action === "inspect_before_use");
  const doNotUse = args.entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = args.entries.filter((entry) => entry.action === "rehydrate");
  const header = [
    "AIONIS_EXTERNAL_MEMORY_ADMISSION v1",
    `mode=${args.mode} context=${args.context_mode}`,
    "contract: external memory is advisory until admitted; follow use_now only, inspect inspect_before_use before action, never act from do_not_use, and rehydrate before exact use when requested.",
    `query: ${externalAdmissionTruncateText(args.query_text, 320)}`,
  ];
  return [
    ...header,
    ...externalAdmissionSectionLines("USE_NOW", useNow),
    ...externalAdmissionSectionLines("INSPECT_BEFORE_USE", inspect),
    ...externalAdmissionSectionLines("DO_NOT_USE", doNotUse),
    ...externalAdmissionSectionLines("REHYDRATE", rehydrate),
  ].join("\n");
}

function externalAdmissionRouteContractForExternal(entries: externalAdmissionAdmittedCandidate[]): AionisAgentContext["route_contract"] {
  const active = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const blocked = entries.filter((entry) => entry.action === "do_not_use");
  const targetRows = (rows: externalAdmissionAdmittedCandidate[], source: "should_continue" | "inspect_first" | "must_not") =>
    rows.flatMap((entry) => entry.target_files.map((target) => ({
      target,
      source_memory_id: entry.candidate.external_memory_id,
      source,
      reason: entry.reason_codes.join(","),
    })));
  const activeTargets = targetRows(active, "should_continue").map((entry) => ({
    ...entry,
    artifact_status: "unknown" as const,
    missing_policy: "restore_or_create_if_task_consistent_or_rehydrate" as const,
  }));
  const referenceOnlyTargets = targetRows(inspect, "inspect_first");
  const blockedDirectionTargets = targetRows(blocked, "must_not");
  return {
    active_targets: activeTargets,
    pending_artifacts: activeTargets.map((entry) => ({
      target: entry.target,
      source_memory_id: entry.source_memory_id,
      source: entry.source,
      reason: entry.reason,
      status: "unknown_until_host_observation" as const,
      when: "if_active_target_is_missing" as const,
      allowed_actions: ["create", "restore", "rehydrate", "report_conflict"] as const,
      preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"] as const,
      terminal_inspect_allowed: false as const,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate" as const,
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent" as const,
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict" as const,
    })),
    reference_only_targets: referenceOnlyTargets,
    blocked_direction_targets: blockedDirectionTargets,
    evidence_sources: referenceOnlyTargets.map((entry) => ({
      ...entry,
      evidence_use: "reference_only" as const,
      direction_policy: "must_not_be_primary_route" as const,
    })),
    blocked_routes: blockedDirectionTargets.map((entry) => ({
      ...entry,
      direction_policy: "blocked_route" as const,
      evidence_use: "counter_evidence_only" as const,
    })),
    conflict_policy: "do_not_treat_missing_active_target_as_superseded" as const,
    fallback_policy: "do_not_promote_reference_or_blocked_targets" as const,
    action_policy: {
      missing_active_target_preferred_order: ["create", "restore", "rehydrate", "report_conflict"] as const,
      terminal_inspect_allowed: false as const,
      reference_fallback_requires: "explicit_raw_evidence_or_operator_confirmation" as const,
      executable_evidence_policy: "route_safe_but_patch_may_require_rehydrate" as const,
      after_rehydrate_policy: "continue_allowed_action_if_task_consistent" as const,
      report_conflict_requires: "rehydrate_unavailable_or_evidence_conflict" as const,
    },
  };
}

export function governExternalMemoryCandidates(
  args: GovernExternalMemoryCandidatesArgs,
): AionisMemoryAdmissionGatewayResult {
  const tenantId = args.tenant_id?.trim() || "default";
  const scope = args.scope?.trim() || "default";
  const runId = args.run_id?.trim() || null;
  const mode = args.mode ?? "standard";
  const contextMode = args.context_mode ?? "compact_agent";
  const candidates = args.candidates.map((candidate) => AionisExternalMemoryCandidateSchema.parse(candidate));
  const entries = externalAdmissionAdmittedCandidates({ candidates, mode });
  const useNow = entries.filter((entry) => entry.action === "use_now");
  const inspect = entries.filter((entry) => entry.action === "inspect_before_use");
  const doNotUse = entries.filter((entry) => entry.action === "do_not_use");
  const rehydrate = entries.filter((entry) => entry.action === "rehydrate");
  const promptText = externalAdmissionBuildPrompt({
    query_text: args.query_text,
    entries,
    mode,
    context_mode: contextMode,
  });
  const promptCharCount = promptText.length;
  const targetFiles = externalAdmissionCompactStrings(entries.flatMap((entry) => entry.target_files));
  const memoryIds = externalAdmissionCompactStrings(entries.map((entry) => entry.candidate.external_memory_id));
  const riskLevel = externalAdmissionRiskLevelForExternal(entries);
  const agentContext = parseAionisAgentContext({
    contract_version: "aionis_agent_context_v1",
    tenant_id: tenantId,
    scope,
    agent_role: "agent",
    agent_context_mode: contextMode,
    prompt_text: promptText,
    summary: `Aionis admitted ${entries.length} external memory candidates from ${externalAdmissionCompactStrings(entries.map((entry) => entry.candidate.source_backend)).length} backend(s).`,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    recommended_posture: externalAdmissionPostureForExternal(entries),
    authority: externalAdmissionContextAuthorityForExternal(entries),
    target_files: targetFiles,
    use_now: useNow.map((entry) => entry.prompt_text),
    inspect_before_use: inspect.map((entry) => entry.prompt_text),
    do_not_use: doNotUse.map((entry) => entry.prompt_text),
    memory_ids: memoryIds,
    use_now_memory_ids: useNow.map((entry) => entry.candidate.external_memory_id),
    inspect_before_use_memory_ids: inspect.map((entry) => entry.candidate.external_memory_id),
    do_not_use_memory_ids: doNotUse.map((entry) => entry.candidate.external_memory_id),
    command_posture: entries.map((entry) => ({
      posture: entry.action === "use_now"
        ? "should_continue"
        : entry.action === "inspect_before_use"
          ? "inspect_first"
          : entry.action === "do_not_use"
            ? "must_not"
            : "rehydrate_first",
      surface: entry.action,
      memory_id: entry.candidate.external_memory_id,
      instruction: entry.action === "use_now"
        ? "Use this admitted external memory as active context."
        : entry.action === "inspect_before_use"
          ? "Inspect this external memory before letting it direct action."
          : entry.action === "do_not_use"
            ? "Do not use this external memory to direct the Agent."
            : "Rehydrate the source evidence before exact use.",
      reason: entry.reason_codes.join(","),
      target_files: entry.target_files,
    })),
    route_contract: externalAdmissionRouteContractForExternal(entries),
    prompt_aliases: entries.map((entry) => ({
      alias: entry.title ?? entry.candidate.external_memory_id,
      memory_id: entry.candidate.external_memory_id,
      surface: entry.action === "use_now"
        ? (entry.candidate.lifecycle_hint === "procedure" ? "procedure" : "current")
        : entry.action === "inspect_before_use"
          ? "inspect"
          : entry.action === "do_not_use"
            ? "avoid"
            : "rehydrate",
    })),
    rehydrate_hints: rehydrate.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      reason: "External memory requires raw/source evidence before exact use.",
      required: true,
    })),
    risk: {
      negative_transfer_risk: riskLevel,
      blocked_authority_count: doNotUse.length,
      stale_memory_count: entries.filter((entry) => entry.candidate.lifecycle_hint === "stale").length,
      reasons: externalAdmissionCompactStrings([
        ...entries
          .filter((entry) => entry.action !== "use_now")
          .flatMap((entry) => entry.reason_codes),
      ]).slice(0, 32),
    },
    evidence_refs: {
      memory_ids: memoryIds,
      workflow_ids: [],
      evidence_count: entries.reduce((total, entry) => total + entry.candidate.evidence_refs.length, 0),
    },
  });
  const receipt = parseAionisMemoryUseReceipt({
    contract_version: "aionis_memory_use_receipt_v1",
    intended_use: "memory_use_audit",
    agent_prompt_included: false,
    runtime_mutation: false,
    guide_trace_id: `external-admission:${runId ?? randomUUID()}`,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    prompt_char_count: promptCharCount,
    exposed_memory_ids: memoryIds,
    use_now_memory_ids: useNow.map((entry) => entry.candidate.external_memory_id),
    inspect_before_use_memory_ids: inspect.map((entry) => entry.candidate.external_memory_id),
    do_not_use_memory_ids: doNotUse.map((entry) => entry.candidate.external_memory_id),
    rehydrate_memory_ids: rehydrate.map((entry) => entry.candidate.external_memory_id),
    attributed_memory_ids: [],
    unattributed_recalled_memory_ids: [],
    read_only_signal_memory_ids: entries
      .filter((entry) => entry.action !== "use_now")
      .map((entry) => entry.candidate.external_memory_id),
    decision_summaries: entries.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      agent_surface: entry.action,
      decision_kind: entry.decision_kind,
      actionable: entry.action === "use_now",
      reason_codes: entry.reason_codes,
    })),
    risk_flags: externalAdmissionCompactStrings([
      riskLevel !== "low" ? `negative_transfer_risk:${riskLevel}` : null,
      ...entries.filter((entry) => entry.action !== "use_now").flatMap((entry) => entry.reason_codes),
    ]).slice(0, 64),
    summary: `Aionis routed ${entries.length} external memory candidates into ${useNow.length} use_now, ${inspect.length} inspect_before_use, ${doNotUse.length} do_not_use, and ${rehydrate.length} rehydrate decisions; receipt is read-only and excluded from the Agent prompt.`,
  });
  const baseAdmissionRecord = parseAionisMemoryAdmissionRecord({
    contract_version: "aionis_memory_admission_record_v1",
    intended_use: "memory_admission_audit_dataset",
    source: "external_candidate_admission",
    agent_prompt_included: false,
    runtime_mutation: false,
    tenant_id: tenantId,
    scope,
    guide_trace_id: receipt.guide_trace_id,
    prompt_char_count: promptCharCount,
    history_used: entries.length > 0,
    actionable_history_used: useNow.length > 0,
    candidate_memory_count: entries.length,
    prompt_included_memory_count: entries.length,
    agent_used_memory_count: 0,
    entries: entries.map((entry) => ({
      memory_id: entry.candidate.external_memory_id,
      title: entry.title,
      memory_origin: "external",
      source_backend: entry.candidate.source_backend,
      domain: entry.domain,
      memory_type: entry.memory_type,
      lifecycle_state: entry.lifecycle_state,
      authority: entry.authority,
      admission_action: entry.action,
      decision_kind: entry.decision_kind,
      actionable: entry.action === "use_now",
      prompt_included: true,
      agent_used: false,
      feedback_outcome: null,
      attribution_strength: null,
      reason_codes: entry.reason_codes,
      evidence_ids: entry.candidate.evidence_refs,
    })),
    summary: `Aionis recorded ${entries.length} external memory admission decisions; record is read-only, backend-agnostic, and excluded from the Agent prompt.`,
  });
  const admissionRecord = parseAionisMemoryAdmissionRecord({
    ...baseAdmissionRecord,
    shadow_policy_report: buildAionisMemoryAdmissionShadowPolicyReportFromRecord(
      baseAdmissionRecord,
      "external_candidate_admission",
    ),
  });
  const memoryFirewall = mode === "firewall" ? externalAdmissionBuildMemoryFirewallSummary(entries) : undefined;
  return {
    contract_version: "aionis_memory_admission_gateway_result_v1",
    tenant_id: tenantId,
    scope,
    run_id: runId,
    mode,
    agent_context: agentContext,
    memory_use_receipt: receipt,
    memory_admission_records: admissionRecord,
    ...(memoryFirewall ? { memory_firewall: memoryFirewall } : {}),
    admission_summary: {
      contract_version: "aionis_external_memory_admission_summary_v1",
      candidate_count: entries.length,
      use_now_count: useNow.length,
      inspect_before_use_count: inspect.length,
      do_not_use_count: doNotUse.length,
      rehydrate_count: rehydrate.length,
      source_backends: externalAdmissionCompactStrings(entries.map((entry) => entry.candidate.source_backend)),
      runtime_mutation: false,
      agent_prompt_included: false,
      reason: "External candidates were routed through Aionis admission surfaces without writing Runtime memory.",
    },
    source_map: {
      routes_used: ["/v1/memory/govern"],
      internal_surfaces_used: ["external_candidate_admission", "memory_use_receipt", "memory_admission_record"],
      omitted_internal_surfaces: ["semantic_recall", "memory_write", "raw_external_payload_store"],
    },
  };
}

type ProductGuideMemoryWritePort = {
  commit(body: unknown, options?: {
    executionTreeDefaultDisabled?: boolean;
    startedAt?: number;
  }): Promise<{ response: unknown }>;
};

export type ProductGuideServiceDependencies = {
  env: Env;
  liteWriteStore: LiteWriteStore;
  executionTreeStore?: ExecutionTreeStore | null;
  claimLedgerAccess?: ClaimLedgerAccess | null;
  memoryWrite: ProductGuideMemoryWritePort | null;
};

async function persistGuideExposure(args: {
  dependencies: ProductGuideServiceDependencies;
  parsed: ProductGuideInput;
  tenantId: string;
  scope: string;
  agentContext: AionisAgentContext;
  guideTraceId: string;
}): Promise<ProductServiceResult> {
  if (!args.dependencies.memoryWrite) {
    return productServiceDependencyFailure("memory_write_service");
  }
  const ledger = buildGuideExposureLedger({
    parsed: args.parsed,
    tenant_id: args.tenantId,
    scope: args.scope,
    agentContext: args.agentContext,
    guideTraceId: args.guideTraceId,
  });
  const ledgerSha = sha256Hex(stableStringify(ledger));
  try {
    await args.dependencies.memoryWrite.commit({
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.parsed.consumer_agent_id ?? args.dependencies.env.LITE_LOCAL_ACTOR_ID,
    input_text: `Aionis guide exposure ledger ${args.guideTraceId}`,
    input_sha256: ledgerSha,
    auto_embed: false,
    distill: { enabled: false },
    nodes: [stripUndefined({
      client_id: args.guideTraceId,
      type: "evidence",
      tier: "archive",
      memory_lane: "shared",
      producer_agent_id: "aionis-runtime",
      owner_agent_id: args.parsed.consumer_agent_id ?? args.dependencies.env.LITE_LOCAL_ACTOR_ID,
      owner_team_id: args.parsed.consumer_team_id,
      title: "Guide exposure ledger",
      text_summary: `Guide exposure ledger ${args.guideTraceId}`,
      salience: 0,
      importance: 0,
      confidence: 1,
      slots: { guide_exposure_v1: ledger, not_agent_facing: true },
    })],
    edges: [],
  }, {
    executionTreeDefaultDisabled: false,
    startedAt: performance.now(),
    });
  } catch (error) {
    return productServiceDependencyFailure(
      "memory_write_service",
      productServiceFailureFromUnknown(error).statusCode,
    );
  }
  return productServiceSuccess(null);
}

async function executeProductGuide(args: {
  dependencies: ProductGuideServiceDependencies;
  parsed: ProductGuideInput;
  context: ProductGuideExecutionContext;
}): Promise<ProductServiceResult> {
  const { dependencies, parsed, context } = args;
  const { env, liteWriteStore, executionTreeStore, claimLedgerAccess } = dependencies;
  const payload: ProductGuideInput = { ...parsed, context: parsed.context ?? {} };
  let guideResult: InternalDispatchResult;
  try {
    guideResult = {
      ok: true,
      statusCode: 200,
      path: "planning_context_service",
      body: await context.planningContext(payload),
    };
  } catch (error) {
    const failure = productServiceFailureFromUnknown(error);
    guideResult = {
      ok: false,
      statusCode: failure.statusCode,
      path: "planning_context_service",
      body: failure.body,
    };
  }
  const planningContextEmbeddingUnavailable = isPlanningContextNoEmbeddingProvider(guideResult);
  if (!guideResult.ok && !planningContextEmbeddingUnavailable) {
    return productServiceDependencyFailure(guideResult.path, guideResult.statusCode);
  }

  const guideBody = objectValue(guideResult.body) ?? {};
  const recall = objectValue(guideBody.recall) ?? {};
  let memoryPacket: AionisMemoryPacket | null = recall.aionis_memory_packet
    ? AionisMemoryPacketSchema.parse(recall.aionis_memory_packet)
    : null;
  const guidePacket: AionisGuidePacket | null = guideBody.aionis_guide_packet
    ? AionisGuidePacketSchema.parse(guideBody.aionis_guide_packet)
    : null;
  const agentRole = productGuideAgentRole(parsed);
  const tenantId = String(guideBody.tenant_id ?? parsed.tenant_id ?? env.MEMORY_TENANT_ID);
  const scope = String(guideBody.scope ?? parsed.scope ?? env.MEMORY_SCOPE);
  const tenancy = resolveTenantScope(
    { tenant_id: tenantId, scope },
    { defaultTenantId: env.MEMORY_TENANT_ID, defaultScope: env.MEMORY_SCOPE },
  );
  const fullPowerRequested = productGuideFullPowerRequested(parsed);
  const agentContextMode = productGuideAgentContextMode(parsed);
  const taskContextProfile = productGuideTaskContextProfile(parsed);
  const taskContextProfilePolicy = productGuideTaskContextProfileCompilerPolicy({
    profile: taskContextProfile,
    agentContextMode,
    explicitContextCharBudget: parsed.context_char_budget,
  });
  const executionSignatures = productGuideExecutionSignatures(parsed);
  let fullPowerStructuredMemoryMerged = false;
  if (fullPowerRequested) {
    const structuredExecutionPacket = await buildProductGuideStructuredExecutionPacket({
      liteWriteStore,
      parsed,
      tenant_id: tenantId,
      public_scope: scope,
      store_scope: tenancy.scope_key,
    });
    const mergedPacket = mergeAionisMemoryPackets(memoryPacket, structuredExecutionPacket);
    memoryPacket = mergedPacket.packet;
    fullPowerStructuredMemoryMerged = mergedPacket.changed;
  }

  let executionAgentContext: AionisAgentContext | null = null;
  let fullPowerExecutionContextMerged = false;
  if (fullPowerRequested) {
    const executionBody = context.applyIdentity(stripUndefined({
      tenant_id: tenantId,
      scope,
      consumer_agent_id: parsed.consumer_agent_id,
      consumer_team_id: parsed.consumer_team_id,
      execution_tree_v1: parsed.execution_tree_v1,
      context_mode: "full_power",
      prompt_detail: "compact",
      include_memory_evidence: true,
      include_prompt_text: false,
      include_agent_context: true,
      agent_context_char_budget: taskContextProfilePolicy.executionContextCharBudget,
      memory_filters: productGuideExecutionMemoryFilters(parsed),
    }), "execution_context_assemble");
    let executionContextResult: Awaited<ReturnType<typeof buildExecutionEvidenceContextLite>>;
    try {
      executionContextResult = await buildExecutionEvidenceContextLite({
        liteWriteStore,
        executionTreeStore: executionTreeStore ?? null,
        body: executionBody,
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
      });
    } catch (error) {
      return productServiceDependencyFailure(
        "execution_context_service",
        productServiceFailureFromUnknown(error).statusCode,
      );
    }
    const executionContextBody = objectValue(executionContextResult);
    executionAgentContext = executionContextBody?.agent_context
      ? AionisAgentContextSchema.parse(executionContextBody.agent_context)
      : null;
    fullPowerExecutionContextMerged = !!executionAgentContext && (
      executionAgentContext.use_now.some((line) =>
        line.startsWith("Current active path:")
        || line.startsWith("Passed solution:")
        || line.startsWith("Continuity handoff:")
      )
      || executionAgentContext.do_not_use.some((line) => line.startsWith("Avoid failed branch:"))
    );
  }

  const claimLedgerProjection = await buildProductGuideClaimLedgerProjection({
    claimLedgerAccess,
    tenantId,
    scope,
    queryText: parsed.query_text,
  });
  const claimLedgerContextProjectionApplied = claimLedgerProjectionHasPromptSurface(claimLedgerProjection);
  let agentContext = buildAionisAgentContext({
    tenant_id: tenantId,
    scope,
    agent_role: agentRole,
    memory_packet: memoryPacket,
    guide_packet: guidePacket,
    execution_scope: {
      task_signature: executionSignatures.taskSignature,
      task_family: executionSignatures.taskFamily,
      workflow_signature: executionSignatures.workflowSignature,
    },
    query_intent_override: parsed.query_text,
    agent_context_mode: agentContextMode,
    context_char_budget: taskContextProfilePolicy.contextCharBudget,
    context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
    task_context_profile: taskContextProfile,
    current_execution_state: executionAgentContext,
    claim_projection: claimLedgerProjection,
    render_detail: agentContextMode === "compact_agent"
      ? "compact"
      : fullPowerExecutionContextMerged || claimLedgerContextProjectionApplied ? "full_power" : "standard",
  });
  const guideTraceId = buildGuideTraceId();
  let activeProjectionApplied = false;
  if (env.AIONIS_INSPECT_BEFORE_USE_MODE === "active") {
    const activeProjectionMemoryIds = await resolveInspectBeforeUseActiveProjectionIds({
      liteWriteStore,
      env,
      parsed,
      tenant_id: tenantId,
      scope,
      memoryPacket,
      agentContext,
      guideTraceId,
    });
    const projectedContext = applyAionisInspectBeforeUseActiveProjection({
      agent_context: agentContext,
      memory_packet: memoryPacket,
      candidate_memory_ids: activeProjectionMemoryIds,
      reason: "inspect_before_use_active_projection",
      context_char_budget: taskContextProfilePolicy.contextCharBudget,
      context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
    });
    activeProjectionApplied = projectedContext !== agentContext;
    agentContext = projectedContext;
  }

  let admissionCandidatePolicyProjection: AionisAdmissionCandidatePolicyActiveProjection | null = null;
  let admissionCandidatePolicyProjectionApplied = false;
  const admissionCandidatePolicyMode = resolveAdmissionCandidatePolicyGuideMode({
    env,
    parsed,
    scope,
    agentRole,
  });
  if (admissionCandidatePolicyMode.mode === "shadow" || admissionCandidatePolicyMode.mode === "active") {
    admissionCandidatePolicyProjection = await resolveAdmissionCandidatePolicyGuideProjection({
      liteWriteStore,
      env,
      parsed,
      tenant_id: tenantId,
      scope,
      memoryPacket,
      agentContext,
      mode: admissionCandidatePolicyMode.mode,
    });
    if (admissionCandidatePolicyMode.mode === "active" && admissionCandidatePolicyProjection) {
      const projectedContext = applyAionisInspectBeforeUseActiveProjection({
        agent_context: agentContext,
        memory_packet: memoryPacket,
        candidate_memory_ids: admissionCandidatePolicyProjection.downgraded_memory_ids,
        reason: AIONIS_ADMISSION_CANDIDATE_POLICY_ACTIVE_PROJECTION_REASON,
        context_char_budget: taskContextProfilePolicy.contextCharBudget,
        context_compaction_profile: parsed.context_compaction_profile ?? parsed.context_optimization_profile ?? null,
      });
      admissionCandidatePolicyProjectionApplied = projectedContext !== agentContext;
      agentContext = projectedContext;
    }
  }
  const exposureWrite = await persistGuideExposure({
    dependencies,
    parsed,
    tenantId,
    scope,
    agentContext,
    guideTraceId,
  });
  if (!exposureWrite.ok) return exposureWrite;

  const includePackets = parsed.include_packets === true;
  const premiseFirewallVisible = productGuidePremiseFirewallVisible(agentContext);
  const memoryContractVisible = productGuideMemoryContractVisible(memoryPacket);
  return productServiceSuccess({
    contract_version: "aionis_guide_result_v1",
    tenant_id: tenantId,
    scope,
    consumer_agent_id: parsed.consumer_agent_id ?? env.LITE_LOCAL_ACTOR_ID,
    ...(parsed.consumer_team_id ? { consumer_team_id: parsed.consumer_team_id } : {}),
    guide_trace_id: guideTraceId,
    agent_context: agentContext,
    ...(claimLedgerProjection ? { claim_ledger_projection: claimLedgerProjection } : {}),
    ...(admissionCandidatePolicyProjection ? { admission_candidate_policy_projection: admissionCandidatePolicyProjection } : {}),
    ...(includePackets ? { memory_packet: memoryPacket, guide_packet: guidePacket } : {}),
    source_map: {
      routes_used: ["/v1/guide"],
      internal_surfaces_used: [
        ...(planningContextEmbeddingUnavailable ? ["planning_context_embedding_unavailable"] : ["recall"]),
        "planning_context_service",
        "product_packets",
        "agent_context_compiler",
        ...(agentRole !== "agent" ? ["role_aware_agent_context"] : []),
        ...(fullPowerRequested ? ["full_power_execution_context"] : []),
        ...(fullPowerStructuredMemoryMerged ? ["full_power_structured_execution_recall"] : []),
        ...(fullPowerExecutionContextMerged ? ["full_power_agent_context_merge"] : []),
        ...(claimLedgerProjection ? ["claim_ledger_projection"] : []),
        ...(claimLedgerContextProjectionApplied ? ["claim_ledger_agent_context_projection"] : []),
        ...(agentContextMode === "compact_agent" ? ["compact_agent_context"] : []),
        ...(activeProjectionApplied ? ["inspect_before_use_active_projection"] : []),
        ...(admissionCandidatePolicyProjection && admissionCandidatePolicyMode.mode === "shadow"
          ? ["admission_candidate_policy_shadow_projection"] : []),
        ...(admissionCandidatePolicyProjectionApplied ? ["admission_candidate_policy_active_projection"] : []),
        ...(admissionCandidatePolicyProjection && admissionCandidatePolicyMode.source === "profile_rule"
          ? [`admission_candidate_policy_profile_${admissionCandidatePolicyMode.mode}_projection`] : []),
        ...(memoryContractVisible ? ["memory_contract"] : []),
        ...(premiseFirewallVisible ? ["premise_firewall"] : []),
        "guide_exposure_ledger",
      ],
      omitted_internal_surfaces: [
        "internal_planning_details",
        "internal_learning_diagnostics",
        "internal_execution_recommendation_details",
        "internal_cost_diagnostics",
        ...(fullPowerRequested ? [
          "full_power_execution_prompt_text",
          "full_power_raw_evidence",
          "full_power_gated_abstractions",
          "full_power_trace",
        ] : []),
        ...(includePackets ? [] : ["memory_packet", "guide_packet"]),
        ...(planningContextEmbeddingUnavailable ? ["semantic_planning_recall"] : []),
      ],
      admission_candidate_policy: {
        mode: admissionCandidatePolicyMode.mode,
        source: admissionCandidatePolicyMode.source,
        ...(admissionCandidatePolicyMode.profile_id ? { profile_id: admissionCandidatePolicyMode.profile_id } : {}),
      },
    },
  });
}

export function createProductGuideService(
  dependencies: ProductGuideServiceDependencies,
): ProductServices["guide"] {
  return {
    async execute(parsed, context) {
      try {
        return await executeProductGuide({ dependencies, parsed, context });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
    async govern(parsed: ProductMemoryAdmissionInput) {
      try {
        const tenantId = parsed.tenant_id ?? dependencies.env.MEMORY_TENANT_ID;
        const scope = parsed.scope ?? dependencies.env.MEMORY_SCOPE;
        const external = governExternalMemoryCandidates({
          tenant_id: tenantId,
          scope,
          run_id: parsed.run_id,
          query_text: parsed.query_text,
          candidates: parsed.candidates,
          mode: parsed.mode,
          context_mode: parsed.context_mode,
        });
        return productServiceSuccess({
          contract_version: external.contract_version,
          tenant_id: tenantId,
          scope,
          run_id: external.run_id,
          mode: external.mode,
          agent_context: external.agent_context,
          memory_use_receipt: external.memory_use_receipt,
          ...(parsed.include_records === true ? { memory_admission_records: external.memory_admission_records } : {}),
          ...(external.memory_firewall ? { memory_firewall: external.memory_firewall } : {}),
          admission_summary: external.admission_summary,
          source_map: external.source_map,
        });
      } catch (error) {
        return productServiceFailureFromUnknown(error);
      }
    },
  };
}
