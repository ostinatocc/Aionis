import type { Env } from "../config.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import {
  buildAppliedPolicyLearningControlContract,
  buildLivePolicyLearningControlRouteContext,
} from "../app/policy-learning-control-route-context.js";
import {
  adjudicatePolicyMutationV1,
  buildPolicyMutationFromLearningControlApply,
} from "./policy-mutation-loop.js";
import { ruleFeedback } from "../memory/feedback.js";
import {
  suppressAnchorLite,
  suppressPatternAnchorLite,
  unsuppressAnchorLite,
  unsuppressPatternAnchorLite,
} from "../memory/pattern-operator-override.js";
import { applyPolicyMemoryLearningControlLite } from "../memory/policy-memory.js";
import { rehydrateAnchorPayloadLite } from "../memory/rehydrate-anchor.js";
import { runLearningLoopLite } from "../memory/learning-loop.js";
import {
  runRuntimeMaintenanceLite,
  type RuntimeMaintenanceProfile,
} from "../memory/runtime-maintenance.js";
import { updateRuleState } from "../memory/rules.js";
import { evaluateRules } from "../memory/rules-evaluate.js";
import {
  PolicyLearningControlApplyResponseSchema,
} from "../memory/schemas.js";
import { resolveTenantScope } from "../memory/tenant.js";
import { getToolsDecisionById } from "../memory/tools-decision.js";
import { toolSelectionFeedback } from "../memory/tools-feedback.js";
import { getToolsRunLifecycle, listToolsRuns } from "../memory/tools-run.js";
import { selectTools } from "../memory/tools-select.js";
import type { RecallStoreAccess } from "../store/recall-access.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";

export const LEARNING_LIFECYCLE_STATES = [
  "observed",
  "provisional",
  "trusted",
  "contested",
  "retired",
  "archived",
] as const;

export type LearningLifecycleState = typeof LEARNING_LIFECYCLE_STATES[number];

export type LiteLearningKernelStore =
  LiteWriteStore
  & NonNullable<NonNullable<Parameters<typeof updateRuleState>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof evaluateRules>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof selectTools>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof getToolsDecisionById>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof getToolsRunLifecycle>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof listToolsRuns>[3]>["liteWriteStore"]>
  & NonNullable<NonNullable<Parameters<typeof toolSelectionFeedback>[4]>["liteWriteStore"]>
  & Pick<LiteWriteStore, "findNodes" | "updateNodeAnchorState">
  & Parameters<typeof rehydrateAnchorPayloadLite>[0]
  & {
    withTx: <T>(fn: () => Promise<T>) => Promise<T>;
  };

export type LearningKernelControlProviders = {
  toolsFeedback?: NonNullable<Parameters<typeof toolSelectionFeedback>[4]>["learningControlReviewProviders"];
};

export type LearningKernelArgs = {
  env: Env;
  embedder: EmbeddingProvider | null;
  liteRecallAccess: RecallStoreAccess;
  liteWriteStore: LiteLearningKernelStore;
  learningControlProviders?: LearningKernelControlProviders;
};

export type LearningKernel = {
  recordRuleFeedback(body: unknown): Promise<unknown>;
  applyRuleState(body: unknown): Promise<unknown>;
  evaluateRulePolicy(body: unknown): Promise<unknown>;
  selectToolWithLearnedMemory(body: unknown): Promise<unknown>;
  readToolDecision(body: unknown): Promise<unknown>;
  readToolRun(body: unknown): Promise<unknown>;
  listToolRuns(body: unknown): Promise<unknown>;
  recordToolSelectionFeedback(body: unknown): Promise<unknown>;
  runLearningLoop(body: unknown): Promise<unknown>;
  runRuntimeMaintenance(body: unknown): Promise<unknown>;
  runRuntimeMaintenanceImmediate(body: unknown): Promise<unknown>;
  runRuntimeMaintenanceDaily(body: unknown): Promise<unknown>;
  runRuntimeMaintenanceLongHorizon(body: unknown): Promise<unknown>;
  applyPolicyLearningControl(body: unknown): Promise<unknown>;
  suppressLearnedAnchor(body: unknown): Promise<unknown>;
  unsuppressLearnedAnchor(body: unknown): Promise<unknown>;
  suppressLearnedPattern(body: unknown): Promise<unknown>;
  unsuppressLearnedPattern(body: unknown): Promise<unknown>;
  rehydrateLearnedAnchorPayload(body: unknown): Promise<unknown>;
};

function withRuntimeMaintenanceProfile(body: unknown, profile: RuntimeMaintenanceProfile): Record<string, unknown> {
  const base = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return {
    ...base,
    maintenance_profile: profile,
  };
}

export function createLearningKernel(args: LearningKernelArgs): LearningKernel {
  const {
    env,
    embedder,
    liteRecallAccess,
    liteWriteStore,
    learningControlProviders,
  } = args;

  return {
    recordRuleFeedback: (body) =>
      liteWriteStore.withTx(() =>
        ruleFeedback(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
          maxTextLen: env.MAX_TEXT_LEN,
          piiRedaction: env.PII_REDACTION,
          liteWriteStore,
        }),
      ),

    applyRuleState: (body) =>
      liteWriteStore.withTx(() =>
        updateRuleState(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
          liteWriteStore,
        }),
      ),

    evaluateRulePolicy: (body) =>
      evaluateRules(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        liteWriteStore,
      }),

    selectToolWithLearnedMemory: (body) =>
      selectTools(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        recallAccess: liteRecallAccess,
        embedder,
        liteWriteStore,
      }),

    readToolDecision: (body) =>
      getToolsDecisionById(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        liteWriteStore,
      }),

    readToolRun: (body) =>
      getToolsRunLifecycle(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        liteWriteStore,
      }),

    listToolRuns: (body) =>
      listToolsRuns(body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        liteWriteStore,
      }),

    recordToolSelectionFeedback: (body) =>
      toolSelectionFeedback(null, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, {
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        embedder,
        learningControlReviewProviders: learningControlProviders?.toolsFeedback,
        liteWriteStore,
      }),

    runLearningLoop: (body) =>
      runLearningLoopLite(liteWriteStore, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      }),

    runRuntimeMaintenance: (body) =>
      runRuntimeMaintenanceLite(liteWriteStore, body, {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      }),

    runRuntimeMaintenanceImmediate: (body) =>
      runRuntimeMaintenanceLite(liteWriteStore, withRuntimeMaintenanceProfile(body, "immediate"), {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      }),

    runRuntimeMaintenanceDaily: (body) =>
      runRuntimeMaintenanceLite(liteWriteStore, withRuntimeMaintenanceProfile(body, "daily"), {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      }),

    runRuntimeMaintenanceLongHorizon: (body) =>
      runRuntimeMaintenanceLite(liteWriteStore, withRuntimeMaintenanceProfile(body, "long_horizon"), {
        defaultScope: env.MEMORY_SCOPE,
        defaultTenantId: env.MEMORY_TENANT_ID,
        maxTextLen: env.MAX_TEXT_LEN,
        piiRedaction: env.PII_REDACTION,
        allowCrossScopeEdges: env.ALLOW_CROSS_SCOPE_EDGES,
      }),

    applyPolicyLearningControl: async (body) => {
      const { parsed, livePolicyContract, liveDerivedPolicy, learningControlContract } = await buildLivePolicyLearningControlRouteContext({
        body,
        env,
        embedder,
        liteRecallAccess,
        liteWriteStore,
      });
      const effectiveLearningControlContract =
        learningControlContract && (learningControlContract.action === parsed.action || learningControlContract.action === "none")
          ? learningControlContract
          : null;
      const tenancy = resolveTenantScope(
        { scope: parsed.scope, tenant_id: parsed.tenant_id },
        { defaultScope: env.MEMORY_SCOPE, defaultTenantId: env.MEMORY_TENANT_ID },
      );
      const applied = await liteWriteStore.withTx(() =>
        applyPolicyMemoryLearningControlLite(liteWriteStore, {
          tenant_id: tenancy.tenant_id,
          scope: tenancy.scope_key,
          policy_memory_id: parsed.policy_memory_id,
          action: parsed.action,
          actor: parsed.actor ?? null,
          reason: parsed.reason ?? null,
          learning_control_contract: effectiveLearningControlContract,
          live_policy_contract: livePolicyContract,
          live_derived_policy: liveDerivedPolicy,
        }),
      );
      const policyMutation = buildPolicyMutationFromLearningControlApply({
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        policy_memory_id: applied.policy_memory.node_id,
        action: parsed.action,
        actor: parsed.actor ?? null,
        reason: parsed.reason ?? null,
        previous_state: applied.previous_state,
        next_state: applied.next_state,
        learning_control_contract_present: effectiveLearningControlContract !== null,
        live_policy_contract_present: livePolicyContract !== null,
        contract_trust: applied.policy_memory.policy_contract.contract_trust ?? null,
        activation_mode: applied.policy_memory.policy_contract.activation_mode,
        selected_tool: applied.policy_memory.selected_tool,
        workflow_signature: applied.policy_memory.policy_contract.workflow_signature,
        file_path: applied.policy_memory.policy_contract.file_path,
      });
      const policyMutationAdjudication = adjudicatePolicyMutationV1(policyMutation);
      return PolicyLearningControlApplyResponseSchema.parse({
        ok: true,
        tenant_id: tenancy.tenant_id,
        scope: tenancy.scope,
        action: parsed.action,
        applied: true,
        actor: parsed.actor ?? null,
        reason: parsed.reason ?? null,
        policy_memory_id: applied.policy_memory.node_id,
        previous_state: applied.previous_state,
        next_state: applied.next_state,
        learning_control_contract:
          effectiveLearningControlContract
            ? effectiveLearningControlContract
            : buildAppliedPolicyLearningControlContract({
                parsed,
                appliedPolicyMemoryId: applied.policy_memory.node_id,
                previousState: applied.previous_state,
                nextState: applied.next_state,
                selectedTool: applied.policy_memory.selected_tool,
                filePath: applied.policy_memory.policy_contract.file_path,
                workflowSignature: applied.policy_memory.policy_contract.workflow_signature,
              }),
        live_policy_contract: livePolicyContract,
        policy_memory: applied.policy_memory,
        policy_mutation_v1: policyMutation,
        policy_mutation_adjudication_v1: policyMutationAdjudication,
      });
    },

    suppressLearnedAnchor: (body) =>
      liteWriteStore.withTx(() =>
        suppressAnchorLite({
          body,
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          liteWriteStore,
        }),
      ),

    unsuppressLearnedAnchor: (body) =>
      liteWriteStore.withTx(() =>
        unsuppressAnchorLite({
          body,
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          liteWriteStore,
        }),
      ),

    suppressLearnedPattern: (body) =>
      liteWriteStore.withTx(() =>
        suppressPatternAnchorLite({
          body,
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          liteWriteStore,
        }),
      ),

    unsuppressLearnedPattern: (body) =>
      liteWriteStore.withTx(() =>
        unsuppressPatternAnchorLite({
          body,
          defaultScope: env.MEMORY_SCOPE,
          defaultTenantId: env.MEMORY_TENANT_ID,
          liteWriteStore,
        }),
      ),

    rehydrateLearnedAnchorPayload: (body) =>
      rehydrateAnchorPayloadLite(liteWriteStore, body, env.MEMORY_SCOPE, env.MEMORY_TENANT_ID, env.LITE_LOCAL_ACTOR_ID),
  };
}
