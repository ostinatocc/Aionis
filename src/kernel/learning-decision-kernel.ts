import {
  normalizeContractTrust as normalizeContractTrustValue,
  resolveContractTrustForSteering,
} from "../memory/contract-trust.js";
import {
  buildExecutionContractContextOverlay,
  buildExecutionContractFromProjection,
  deriveExecutionContractFromSlots,
  mergeExecutionContractsWithActionSurface,
  projectExecutionContractToRecoveryContract,
} from "../memory/execution-contract.js";
import type { ContractTrust } from "../memory/schemas.js";

export type WorkflowFeedbackTarget = {
  taskSignature: string | null;
  errorSignature: string | null;
  workflowSignature: string | null;
  taskFamily: string | null;
  filePath: string | null;
  targetFiles: string[];
  nextAction: string | null;
  workflowSteps: string[];
  patternHints: string[];
  serviceLifecycleConstraints: Array<Record<string, unknown>>;
};

export type ToolsFeedbackLearningDecision = {
  workflowFeedbackTarget: WorkflowFeedbackTarget;
  contractTrustForMaterialization: ContractTrust | null;
  automaticAgentToolFeedback: boolean;
  shouldWritePatternAnchor: boolean;
  shouldMaterializePolicyMemory: boolean;
};

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

function mergeStringList(existing: unknown, incoming: string[], limit = 24): string[] {
  return stringList([
    ...stringList(existing, limit),
    ...incoming,
  ], limit);
}

function mergeServiceLifecycleList(existing: unknown, incoming: Array<Record<string, unknown>>, limit = 16): Array<Record<string, unknown>> {
  return serviceLifecycleList([
    ...serviceLifecycleList(existing, limit),
    ...incoming,
  ], limit);
}

function normalizeContractTrust(value: unknown): ContractTrust | null {
  return normalizeContractTrustValue(value);
}

export function resolveFeedbackExecutionContract(context: unknown) {
  const ctx = asRecord(context);
  if (!ctx) return null;
  return deriveExecutionContractFromSlots({
    slots: ctx,
    provenance: {
      source_kind: "manual_context",
      source_summary_version: "tools_feedback_context_v1",
      notes: ["tools_feedback:context_resolution"],
    },
  });
}

export function extractWorkflowFeedbackTarget(context: unknown): WorkflowFeedbackTarget {
  const ctx = asRecord(context);
  const executionContract = resolveFeedbackExecutionContract(context);
  const task = asRecord(ctx?.task);
  const error = asRecord(ctx?.error);
  const workflow = asRecord(ctx?.workflow);
  const execution = asRecord(ctx?.execution);
  const targetFiles = stringList([
    ...stringList(executionContract?.target_files, 24),
    ...stringList(ctx?.target_files, 24),
    ...stringList(workflow?.target_files, 24),
    ...stringList(execution?.target_files, 24),
  ], 24);
  const workflowSteps = stringList([
    ...stringList(executionContract?.workflow_steps, 24),
    ...stringList(ctx?.workflow_steps, 24),
    ...stringList(workflow?.workflow_steps, 24),
    ...stringList(execution?.workflow_steps, 24),
  ], 24);
  const patternHints = stringList([
    ...stringList(executionContract?.pattern_hints, 24),
    ...stringList(ctx?.pattern_hints, 24),
    ...stringList(workflow?.pattern_hints, 24),
    ...stringList(execution?.pattern_hints, 24),
  ], 24);
  const serviceLifecycleConstraints = [
    ...serviceLifecycleList(executionContract?.service_lifecycle_constraints, 16),
    ...serviceLifecycleList(ctx?.service_lifecycle_constraints, 16),
    ...serviceLifecycleList(workflow?.service_lifecycle_constraints, 16),
    ...serviceLifecycleList(execution?.service_lifecycle_constraints, 16),
  ].slice(0, 16);
  return {
    taskSignature:
      nullableString(executionContract?.task_signature)
      ?? nullableString(ctx?.task_signature)
      ?? nullableString(task?.signature)
      ?? nullableString(execution?.task_signature),
    errorSignature:
      nullableString(ctx?.error_signature)
      ?? nullableString(error?.signature)
      ?? nullableString(error?.code)
      ?? nullableString(execution?.error_signature),
    workflowSignature:
      nullableString(executionContract?.workflow_signature)
      ?? nullableString(ctx?.workflow_signature)
      ?? nullableString(workflow?.signature)
      ?? nullableString(execution?.workflow_signature),
    taskFamily:
      nullableString(executionContract?.task_family)
      ?? nullableString(ctx?.task_family)
      ?? nullableString(task?.family)
      ?? nullableString(execution?.task_family)
      ?? nullableString(ctx?.task_kind),
    filePath:
      nullableString(executionContract?.file_path)
      ?? nullableString(ctx?.file_path)
      ?? nullableString(workflow?.file_path)
      ?? nullableString(execution?.file_path)
      ?? targetFiles[0]
      ?? null,
    targetFiles,
    nextAction:
      nullableString(executionContract?.next_action)
      ?? nullableString(ctx?.next_action)
      ?? nullableString(workflow?.next_action)
      ?? nullableString(execution?.next_action),
    workflowSteps,
    patternHints,
    serviceLifecycleConstraints,
  };
}

export function extractFeedbackContractTrust(context: unknown): ContractTrust | null {
  const ctx = asRecord(context);
  const executionContract = resolveFeedbackExecutionContract(context);
  const firstStep = asRecord(ctx?.continuity_guidance);
  return normalizeContractTrust(ctx?.contract_trust)
    ?? normalizeContractTrust(executionContract?.contract_trust)
    ?? normalizeContractTrust(firstStep?.contract_trust)
    ?? null;
}

export function resolveFeedbackContractTrustForMaterialization(context: unknown): ContractTrust | null {
  const explicitTrust = extractFeedbackContractTrust(context);
  if (!explicitTrust) return null;
  return resolveContractTrustForSteering({
    computedTrust: explicitTrust,
    explicitTrust,
    executionContract: resolveFeedbackExecutionContract(context),
  });
}

export function extractFeedbackTelemetrySource(context: unknown): string | null {
  const ctx = asRecord(context);
  const telemetry = asRecord(ctx?.telemetry);
  return nullableString(ctx?.telemetry_source)
    ?? nullableString(telemetry?.source)
    ?? null;
}

export function isAutomaticAgentToolFeedback(context: unknown): boolean {
  const source = extractFeedbackTelemetrySource(context);
  return !!source && (
    source === "agent_post_tool_use"
    || source === "agent_post_tool_use_soak"
    || source.startsWith("agent_post_tool_use:")
  );
}

export function hasConcreteWorkflowFeedbackTarget(target: WorkflowFeedbackTarget): boolean {
  return !!(
    target.taskSignature
    || target.errorSignature
    || target.workflowSignature
    || target.filePath
    || target.targetFiles.length > 0
    || target.workflowSteps.length > 0
    || target.patternHints.length > 0
    || target.serviceLifecycleConstraints.length > 0
  );
}

export function shouldWriteToolsFeedbackPatternAnchor(args: {
  context: unknown;
  outcome: "positive" | "negative" | "neutral";
  sourceRuleIds: string[];
  workflowFeedbackTarget: WorkflowFeedbackTarget;
}): boolean {
  if (args.outcome !== "positive" && args.outcome !== "negative") return false;
  if (!isAutomaticAgentToolFeedback(args.context)) return true;
  if (args.sourceRuleIds.length > 0) return true;
  return hasConcreteWorkflowFeedbackTarget(args.workflowFeedbackTarget);
}

export function shouldMaterializePolicyMemoryFromContractTrust(contractTrust: ContractTrust | null): boolean {
  return !!contractTrust && contractTrust !== "observational";
}

export function decideToolsFeedbackLearning(args: {
  context: unknown;
  outcome: "positive" | "negative" | "neutral";
  sourceRuleIds: string[];
  workflowFeedbackTarget?: WorkflowFeedbackTarget;
}): ToolsFeedbackLearningDecision {
  const workflowFeedbackTarget = args.workflowFeedbackTarget ?? extractWorkflowFeedbackTarget(args.context);
  const contractTrustForMaterialization = resolveFeedbackContractTrustForMaterialization(args.context);
  return {
    workflowFeedbackTarget,
    contractTrustForMaterialization,
    automaticAgentToolFeedback: isAutomaticAgentToolFeedback(args.context),
    shouldWritePatternAnchor: shouldWriteToolsFeedbackPatternAnchor({
      context: args.context,
      outcome: args.outcome,
      sourceRuleIds: args.sourceRuleIds,
      workflowFeedbackTarget,
    }),
    shouldMaterializePolicyMemory: shouldMaterializePolicyMemoryFromContractTrust(contractTrustForMaterialization),
  };
}

export function buildMaterializationContextFromFeedback(args: {
  context: unknown;
  workflowFeedbackTarget: WorkflowFeedbackTarget;
}) {
  const base = asRecord(args.context) ? { ...(args.context as Record<string, unknown>) } : {};
  const existingExecutionContract = resolveFeedbackExecutionContract(base);
  const contractTrust = resolveFeedbackContractTrustForMaterialization(args.context);
  if (contractTrust) {
    base.contract_trust = contractTrust;
  }
  if (contractTrust === "observational") {
    if (existingExecutionContract) {
      base.execution_contract_v1 = mergeExecutionContractsWithActionSurface({
        existing: existingExecutionContract,
        incoming: buildExecutionContractFromProjection({
          contract_trust: "observational",
          provenance: {
            source_kind: "manual_context",
            source_summary_version: "tools_feedback_materialization_v1",
            source_anchor: null,
            evidence_refs: [],
            notes: ["feedback materialization kept contract observational"],
          },
        }),
        preference: "incoming",
      });
    }
    const recoveryContract = asRecord(base.recovery_contract_v1);
    if (recoveryContract) {
      base.recovery_contract_v1 = {
        ...recoveryContract,
        contract_trust: "observational",
      };
    }
    return base;
  }
  if (args.workflowFeedbackTarget.taskFamily) {
    base.task_family = nullableString(base.task_family) ?? args.workflowFeedbackTarget.taskFamily;
  }
  if (args.workflowFeedbackTarget.workflowSignature) {
    base.workflow_signature = nullableString(base.workflow_signature) ?? args.workflowFeedbackTarget.workflowSignature;
  }
  if (args.workflowFeedbackTarget.filePath) {
    base.file_path = nullableString(base.file_path) ?? args.workflowFeedbackTarget.filePath;
  }
  if (args.workflowFeedbackTarget.targetFiles.length > 0) {
    base.target_files = mergeStringList(base.target_files, args.workflowFeedbackTarget.targetFiles, 24);
  }
  if (args.workflowFeedbackTarget.nextAction) {
    base.next_action = nullableString(base.next_action) ?? args.workflowFeedbackTarget.nextAction;
  }
  if (args.workflowFeedbackTarget.workflowSteps.length > 0) {
    base.workflow_steps = mergeStringList(base.workflow_steps, args.workflowFeedbackTarget.workflowSteps, 24);
  }
  if (args.workflowFeedbackTarget.patternHints.length > 0) {
    base.pattern_hints = mergeStringList(base.pattern_hints, args.workflowFeedbackTarget.patternHints, 24);
  }
  if (args.workflowFeedbackTarget.serviceLifecycleConstraints.length > 0) {
    base.service_lifecycle_constraints = mergeServiceLifecycleList(
      base.service_lifecycle_constraints,
      args.workflowFeedbackTarget.serviceLifecycleConstraints,
      16,
    );
  }
  if (
    args.workflowFeedbackTarget.taskFamily
    || args.workflowFeedbackTarget.taskSignature
    || args.workflowFeedbackTarget.workflowSignature
    || args.workflowFeedbackTarget.targetFiles.length > 0
    || args.workflowFeedbackTarget.nextAction
    || args.workflowFeedbackTarget.workflowSteps.length > 0
    || args.workflowFeedbackTarget.patternHints.length > 0
    || args.workflowFeedbackTarget.serviceLifecycleConstraints.length > 0
  ) {
    const mergedExecutionContract = mergeExecutionContractsWithActionSurface({
      existing: existingExecutionContract,
      incoming: buildExecutionContractFromProjection({
        contract_trust: contractTrust,
        task_family: args.workflowFeedbackTarget.taskFamily,
        task_signature: args.workflowFeedbackTarget.taskSignature,
        workflow_signature: args.workflowFeedbackTarget.workflowSignature,
        file_path: args.workflowFeedbackTarget.filePath,
        target_files: args.workflowFeedbackTarget.targetFiles,
        next_action: args.workflowFeedbackTarget.nextAction,
        workflow_steps: args.workflowFeedbackTarget.workflowSteps,
        pattern_hints: args.workflowFeedbackTarget.patternHints,
        service_lifecycle_constraints: args.workflowFeedbackTarget.serviceLifecycleConstraints,
        provenance: {
          source_kind: "manual_context",
          source_summary_version: "tools_feedback_materialization_v1",
          source_anchor: null,
          evidence_refs: [],
          notes: ["workflow feedback target enriched canonical execution contract"],
        },
      }),
      preference: "incoming",
    });
    return buildExecutionContractContextOverlay({
      currentContext: base,
      contract: mergedExecutionContract,
      recoveryContract: projectExecutionContractToRecoveryContract({
        existing: base.recovery_contract_v1,
        contract: mergedExecutionContract,
        summaryVersion: "recovery_contract_v1",
      }),
    });
  }
  return base;
}
