import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import type { Env } from "../config.js";
import {
  AionisAgentRoleSchema,
  type AionisAgentContext,
  type AionisAgentRole,
} from "../memory/runtime-product-contract.js";
import {
  HostTaskEnvelopeV1Schema,
  HostUseReceiptV1Schema,
} from "../execution/host-task-contract.js";
import {
  EpisodeBudgetV1Schema,
  ExecutionEpisodeSubjectStateSpecV2Schema,
  ExecutionEpisodeTerminationV1Schema,
} from "../memory/execution-episode.js";
import type { LiteWriteStore } from "../store/lite-write-store.js";
import { sha256Hex } from "../util/crypto.js";
import type { AuthPrincipal } from "../util/auth.js";
import { createErrorResponse, HttpError } from "../util/http.js";

export function productErrorResponse(args: {
  status: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  topLevel?: Record<string, unknown>;
}) {
  return {
    ...createErrorResponse({
      status: args.status,
      error: args.error,
      message: args.message,
      details: {
        contract: "error_v1",
        ...(args.details ?? {}),
      },
    }),
    ...(args.topLevel ?? {}),
  };
}

const LooseObject = z.record(z.unknown());

const StringList = z.array(z.string().trim().min(1)).max(256).default([]);

const ProductEpisodeBase64 = z.string()
  .max(4 * 1024 * 1024)
  .superRefine((value, context) => {
    if (
      value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(value)
      || Buffer.from(value, "base64").toString("base64") !== value
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be canonical padded base64",
      });
    }
  });

const ProductEpisodeWorkspaceRoot = z.string()
  .min(1)
  .max(4 * 1024)
  .refine(
    (value) =>
      !value.includes("\u0000")
      && !value.includes("\r")
      && !value.includes("\n"),
    "workspace_root contains forbidden control characters",
  );

const ProductWriteIdentityShape = {
  actor: z.string().trim().min(1).optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().trim().min(1).optional(),
  owner_agent_id: z.string().trim().min(1).optional(),
  owner_team_id: z.string().trim().min(1).optional(),
};

export const ProductObserveRequest = z.object({
  operation_id: z.string().trim().min(1).max(256).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  input_text: z.string().trim().min(1).optional(),
  memory_kind: z.enum(["general_memory", "execution_workflow"]).optional(),
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  model_version: z.string().trim().min(1).optional(),
  prompt_version: z.string().trim().min(1).optional(),
  auto_embed: z.boolean().optional(),
  memory_lane: z.enum(["private", "shared"]).optional(),
  producer_agent_id: z.string().trim().min(1).optional(),
  owner_agent_id: z.string().trim().min(1).optional(),
  owner_team_id: z.string().trim().min(1).optional(),
  force_reembed: z.boolean().optional(),
  nodes: z.array(LooseObject).optional(),
  edges: z.array(LooseObject).optional(),
  memory: LooseObject.optional(),
  execution: z.object({
    client_id: z.string().trim().min(1).optional(),
    run_id: z.string().trim().min(1).optional(),
    task_id: z.string().trim().min(1).optional(),
    task_family: z.string().trim().min(1).optional(),
    task_signature: z.string().trim().min(1).optional(),
    workflow_signature: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    summary: z.string().trim().min(1).optional(),
    outcome: z.enum(["succeeded", "failed", "blocked", "interrupted", "unknown"]).optional(),
    tool_execution_status: z.enum(["succeeded", "failed", "unknown"]).optional(),
    task_outcome: z.enum([
      "verified_pass",
      "verified_failure",
      "unresolved",
      "infrastructure",
    ]).optional(),
    execution_outcome_role: z.enum([
      "passed_solution",
      "failed_branch",
      "blocked",
      "unknown",
    ]).optional(),
    outcome_authority: z.enum([
      "runtime_verifier",
      "external_verifier",
      "explicit_branch_evaluation",
      "none",
    ]).optional(),
    verifier_receipt_id: z.string().trim().min(1).max(256).optional(),
    target_state_snapshot_id: z.string().trim().min(1).max(256).optional(),
    workflow_steps: StringList.optional(),
    steps: StringList.optional(),
    target_files: StringList.optional(),
    files: StringList.optional(),
    tool_set: StringList.optional(),
    tools: StringList.optional(),
    acceptance_checks: StringList.optional(),
    verifier: StringList.optional(),
    continuation_hint: z.string().trim().min(1).optional(),
    resume_hint: z.string().trim().min(1).optional(),
    reuse_hint: z.string().trim().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence_ref: z.string().trim().min(1).optional(),
    raw_ref: z.string().trim().min(1).optional(),
    evidence: z.array(LooseObject).max(64).optional(),
    artifacts: z.array(LooseObject).max(64).optional(),
    verification: LooseObject.optional(),
    slots: LooseObject.optional(),
  }).strict().optional(),
}).strict();

const ProductExecutionEpisodeIdentityShape = {
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  workspace_root: ProductEpisodeWorkspaceRoot,
};

export const ProductExecutionSessionLeaseContextV1 = z.object({
  contract_version:
    z.literal("execution_session_lease_context_v1"),
  session_key: z.string().trim().min(1).max(256),
  continuation_id: z.string().trim().min(1).max(256),
  holder_id: z.string().trim().min(1).max(256),
  lease_id: z.string().trim().min(1).max(256),
  lease_revision: z.number().int().positive(),
  lease_operation_id: z.string().trim().min(1).max(256),
  lease_ttl_ms: z.number().int().min(1_000).max(86_400_000).optional(),
}).strict();

const ProductSemanticEventAuthority = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("host_declared"),
    actor_id: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("model_derived"),
    actor_id: z.string().trim().min(1).max(256),
    model_id: z.string().trim().min(1).max(256),
    derivation_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    uncertainty: z.number().finite().min(0).max(1),
  }).strict(),
]);

const ProductDecisiveEvidence = z.array(z.object({
  source_ref: z.string().trim().min(1).max(512),
  excerpt: z.string().trim().min(1).max(2_048),
}).strict()).max(12);

const ProductSemanticEventCommonShape = {
  observation_kind: z.literal("execution_episode"),
  operation_id: z.string().trim().min(1).max(256),
  ...ProductExecutionEpisodeIdentityShape,
  episode_id: z.string().trim().min(1).max(256),
  expected_current_state_snapshot_id:
    z.string().trim().min(1).max(256),
  authority: ProductSemanticEventAuthority,
  evidence_kind: z.enum([
    "feature_vector",
    "prompt",
    "tool_request",
    "tool_result",
    "manifest",
  ]),
  evidence_base64: ProductEpisodeBase64.refine(
    (value) => value.length > 0,
    "semantic evidence must be non-empty",
  ),
  evidence_media_type: z.string().trim().min(1).max(256).optional(),
  evidence_encoding: z.string().trim().min(1).max(256).optional(),
  decisive_evidence: ProductDecisiveEvidence.optional(),
  session_lease_v1: ProductExecutionSessionLeaseContextV1.optional(),
};

const ProductSemanticStatement = z.string().trim().min(1).max(16 * 1024);
const ProductSemanticStatementList = z.array(
  ProductSemanticStatement,
).max(64);

export const ProductExecutionEpisodeObserveRequest =
  z.discriminatedUnion("event_kind", [
    z.object({
      observation_kind: z.literal("execution_episode"),
      event_kind: z.literal("episode_started"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      task_envelope_v1: HostTaskEnvelopeV1Schema,
      source_task_base64: ProductEpisodeBase64,
      run_id: z.string().trim().min(1).max(256),
      model_id: z.string().trim().min(1).max(256),
      model_config: z.unknown().refine(
        (value) => value !== undefined,
        "model_config is required",
      ),
      budget: EpisodeBudgetV1Schema,
      subject_state_spec_v2:
        ExecutionEpisodeSubjectStateSpecV2Schema.optional(),
      required_verifier_id: z.string().trim().min(1).max(256),
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_episode"),
      event_kind: z.literal("episode_resumed"),
      ...ProductExecutionEpisodeIdentityShape,
      episode_id: z.string().trim().min(1).max(256),
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_episode"),
      event_kind: z.enum(["action_observed", "state_mutation"]),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      episode_id: z.string().trim().min(1).max(256),
      expected_current_state_snapshot_id:
        z.string().trim().min(1).max(256),
      action_kind: z.string().trim().min(1).max(120),
      tool_name: z.string().trim().min(1).max(256).optional(),
      request_base64: ProductEpisodeBase64,
      result_base64: ProductEpisodeBase64,
      session_lease_v1:
        ProductExecutionSessionLeaseContextV1.optional(),
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_episode"),
      event_kind: z.literal("snapshot_restored"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      episode_id: z.string().trim().min(1).max(256),
      expected_current_state_snapshot_id:
        z.string().trim().min(1).max(256),
      target_snapshot_id: z.string().trim().min(1).max(256),
      session_lease_v1:
        ProductExecutionSessionLeaseContextV1.optional(),
    }).strict(),
    z.object({
      ...ProductSemanticEventCommonShape,
      event_kind: z.literal("semantic_observation_recorded"),
      observation: ProductSemanticStatement,
    }).strict(),
    z.object({
      ...ProductSemanticEventCommonShape,
      event_kind: z.literal("agent_decision_recorded"),
      decision: ProductSemanticStatement,
      reasons: ProductSemanticStatementList.min(1),
      alternatives_rejected: ProductSemanticStatementList,
    }).strict(),
    z.object({
      ...ProductSemanticEventCommonShape,
      event_kind: z.literal("progress_state_recorded"),
      item_id: z.string().trim().min(1).max(256),
      state: z.enum(["completed", "failed", "unresolved", "blocked"]),
      statement: ProductSemanticStatement,
    }).strict(),
    z.object({
      ...ProductSemanticEventCommonShape,
      event_kind: z.literal("planned_action_recorded"),
      action_id: z.string().trim().min(1).max(256),
      intent: ProductSemanticStatement,
      justification: ProductSemanticStatement,
      preconditions: ProductSemanticStatementList,
    }).strict(),
  ]);

const ProductExecutionSessionTtlMs =
  z.number().int().min(1_000).max(86_400_000).optional();

const ProductExecutionSessionLeaseIdentityShape = {
  session_key: z.string().trim().min(1).max(256),
  holder_id: z.string().trim().min(1).max(256),
  lease_id: z.string().trim().min(1).max(256),
  lease_revision: z.number().int().positive(),
};

export const ProductExecutionSessionObserveRequest =
  z.discriminatedUnion("event_kind", [
    z.object({
      observation_kind: z.literal("execution_session"),
      event_kind: z.literal("session_begin"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      session_key: z.string().trim().min(1).max(256),
      continuation_id: z.string().trim().min(1).max(256),
      holder_id: z.string().trim().min(1).max(256),
      lease_ttl_ms: ProductExecutionSessionTtlMs,
      task_envelope_v1: HostTaskEnvelopeV1Schema,
      source_task_base64: ProductEpisodeBase64,
      run_id: z.string().trim().min(1).max(256),
      model_id: z.string().trim().min(1).max(256),
      model_config: z.unknown().refine(
        (value) => value !== undefined,
        "model_config is required",
      ),
      budget: EpisodeBudgetV1Schema,
      subject_state_spec_v2:
        ExecutionEpisodeSubjectStateSpecV2Schema.optional(),
      required_verifier_id: z.string().trim().min(1).max(256),
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_session"),
      event_kind: z.literal("session_resume"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      session_key: z.string().trim().min(1).max(256),
      holder_id: z.string().trim().min(1).max(256),
      lease_ttl_ms: ProductExecutionSessionTtlMs,
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_session"),
      event_kind: z.literal("session_renew"),
      operation_id: z.string().trim().min(1).max(256),
      tenant_id: z.string().trim().min(1).optional(),
      scope: z.string().trim().min(1).optional(),
      ...ProductExecutionSessionLeaseIdentityShape,
      lease_ttl_ms: ProductExecutionSessionTtlMs,
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_session"),
      event_kind: z.literal("session_handoff"),
      operation_id: z.string().trim().min(1).max(256),
      tenant_id: z.string().trim().min(1).optional(),
      scope: z.string().trim().min(1).optional(),
      ...ProductExecutionSessionLeaseIdentityShape,
      to_holder_id: z.string().trim().min(1).max(256),
      evidence_refs:
        z.array(z.string().trim().min(1).max(256)).max(256).default([]),
      lease_ttl_ms: ProductExecutionSessionTtlMs,
    }).strict(),
    z.object({
      observation_kind: z.literal("execution_session"),
      event_kind: z.literal("session_release"),
      operation_id: z.string().trim().min(1).max(256),
      tenant_id: z.string().trim().min(1).optional(),
      scope: z.string().trim().min(1).optional(),
      ...ProductExecutionSessionLeaseIdentityShape,
    }).strict(),
  ]);

export const ProductObserveRouteRequest = z.union([
  ProductExecutionSessionObserveRequest,
  ProductExecutionEpisodeObserveRequest,
  ProductObserveRequest,
]);

const ProductExecutionCostInput = z.object({
  provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  token_usage_authority: z.enum([
    "provider_total",
    "signed_host_receipt",
  ]),
  usage_receipt_base64: ProductEpisodeBase64.refine(
    (value) => value.length > 0,
    "usage receipt must be non-empty",
  ),
  usage_receipt_media_type:
    z.string().trim().min(1).max(256).optional(),
  usage_receipt_encoding:
    z.string().trim().min(1).max(256).optional(),
  monetary_cost_micros: z.number().int().nonnegative().optional(),
  currency: z.string().trim().min(1).max(120).optional(),
  producer_id: z.string().trim().min(1).max(256),
}).strict().superRefine((value, context) => {
  if (
    value.cached_input_tokens !== undefined
    && value.cached_input_tokens > value.input_tokens
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cached_input_tokens"],
      message: "cached_input_tokens cannot exceed input_tokens",
    });
  }
  if (
    (value.monetary_cost_micros === undefined)
    !== (value.currency === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["currency"],
      message: "monetary cost and currency must be supplied together",
    });
  }
});

export const ProductExecutionEpisodeOutcomeRequest =
  z.discriminatedUnion("event_kind", [
    z.object({
      feedback_kind: z.literal("episode_outcome"),
      event_kind: z.literal("run_verifier"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      episode_id: z.string().trim().min(1).max(256),
      expected_current_state_snapshot_id:
        z.string().trim().min(1).max(256),
      session_lease_v1:
        ProductExecutionSessionLeaseContextV1.optional(),
    }).strict(),
    z.object({
      feedback_kind: z.literal("episode_outcome"),
      event_kind: z.literal("episode_closed"),
      operation_id: z.string().trim().min(1).max(256),
      ...ProductExecutionEpisodeIdentityShape,
      episode_id: z.string().trim().min(1).max(256),
      expected_current_state_snapshot_id:
        z.string().trim().min(1).max(256),
      termination: ExecutionEpisodeTerminationV1Schema,
      verifier_receipt_id: z.string().trim().min(1).max(256).optional(),
      outcome_details: z.array(
        z.string().trim().min(1).max(2048),
      ).max(64).optional(),
      cost: ProductExecutionCostInput.optional(),
      session_lease_v1:
        ProductExecutionSessionLeaseContextV1.optional(),
    }).strict(),
  ]);

export const ProductGuideRequest = z.object({
  operation_id: z.string().trim().min(1).max(256).optional(),
  episode_id: z.string().trim().min(1).max(256).optional(),
  expected_current_state_snapshot_id:
    z.string().trim().min(1).max(256).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  query_text: z.string().trim().min(1),
  agent_role: AionisAgentRoleSchema.optional(),
  context: z.unknown().optional(),
  run_id: z.string().trim().min(1).optional(),
  consumer_agent_id: z.string().trim().min(1).optional(),
  consumer_team_id: z.string().trim().min(1).optional(),
  context_char_budget: z.number().int().positive().max(1000000).optional(),
  execution_state_v1: z.unknown().optional(),
  execution_packet_v1: z.unknown().optional(),
  host_task_envelope_v1: HostTaskEnvelopeV1Schema.optional(),
  include_packets: z.boolean().optional(),
  session_lease_v1: ProductExecutionSessionLeaseContextV1.optional(),
}).strict().superRefine((value, context) => {
  if (
    (value.episode_id === undefined)
    !== (value.expected_current_state_snapshot_id === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.episode_id === undefined
        ? ["episode_id"]
        : ["expected_current_state_snapshot_id"],
      message:
        "episode_id and expected_current_state_snapshot_id must be supplied together",
    });
  }
  if (value.episode_id !== undefined && value.operation_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation_id"],
      message: "execution-episode guide requires operation_id",
    });
  }
  if (value.episode_id !== undefined && value.run_id === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_id"],
      message: "execution-episode guide requires run_id",
    });
  }
  if (
    value.session_lease_v1 !== undefined
    && value.episode_id === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session_lease_v1"],
      message: "execution-session guide requires episode identity",
    });
  }
});

export const ProductForgetRequest = z.object({
  operation: z.enum(["suppress", "unsuppress", "rehydrate", "activate"]),
  target: z.enum(["archive", "payload", "memory"]).optional(),
  tenant_id: z.string().trim().min(1).optional(),
  scope: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  consumer_agent_id: z.string().trim().min(1).optional(),
  consumer_team_id: z.string().trim().min(1).optional(),
  operation_id: z.string().trim().min(1).max(256).optional(),
  reason: z.string().trim().min(1),
  memory_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  node_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  client_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  guide_trace_id: z.string().trim().min(1).optional(),
  used_memory_ids: z.array(z.string().trim().min(1)).max(200).optional(),
  anchor_id: z.string().trim().min(1).optional(),
  anchor_uri: z.string().trim().min(1).optional(),
  target_tier: z.enum(["warm", "hot"]).optional(),
  outcome: z.enum(["positive", "negative", "neutral"]).optional(),
  activate: z.boolean().optional(),
  run_id: z.string().trim().min(1).optional(),
  used_surface: z.enum(["use_now", "inspect_before_use", "do_not_use", "explicit_host_assertion"]).optional(),
  verifier_status: z.enum(["passed", "failed", "not_run", "unknown"]).optional(),
  tool_status: z.enum(["succeeded", "failed", "not_run", "unknown"]).optional(),
  runtime_signal_refs: z.array(z.string().trim().min(1)).max(32).optional(),
  host_use_receipt_v1: HostUseReceiptV1Schema.optional(),
  mode: z.enum(["summary_only", "partial", "full", "differential"]).optional(),
  include_linked_decisions: z.boolean().optional(),
  payload: LooseObject.optional(),
}).strict().superRefine((value, ctx) => {
  const memoryIdCount =
    (value.memory_ids?.length ?? 0)
    + (value.node_ids?.length ?? 0)
    + (value.client_ids?.length ?? 0)
    + (value.used_memory_ids?.length ?? 0);
  const payloadAnchorId = typeof value.payload?.anchor_id === "string" && value.payload.anchor_id.trim().length > 0;
  const payloadAnchorUri = typeof value.payload?.anchor_uri === "string" && value.payload.anchor_uri.trim().length > 0;
  const anchorPresent = !!value.anchor_id || !!value.anchor_uri || payloadAnchorId || payloadAnchorUri;
  if (value.operation !== "activate" && (value.operation_id || value.host_use_receipt_v1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.host_use_receipt_v1 ? "host_use_receipt_v1" : "operation_id"],
      message: "feedback operation identity and host-use receipts are accepted only for activate",
    });
  }
  if (
    (value.operation === "suppress" || value.operation === "unsuppress")
    && memoryIdCount === 0
    && !value.anchor_id
    && !payloadAnchorId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_ids"],
      message: "suppress and unsuppress require memory_ids, node_ids, client_ids, or anchor_id",
    });
  }
  if (value.operation === "activate" && memoryIdCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_ids"],
      message: "activate requires memory_ids, node_ids, client_ids, or guide_trace_id with used_memory_ids",
    });
  }
  if (value.operation === "activate" && value.guide_trace_id && (value.client_ids?.length ?? 0) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["client_ids"],
      message: "guide_trace_id attribution uses memory node ids; client_ids are not accepted in the same activation",
    });
  }
  if (value.operation === "activate" && value.guide_trace_id && (value.used_memory_ids?.length ?? 0) === 0 && (value.memory_ids?.length ?? 0) === 0 && (value.node_ids?.length ?? 0) === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_memory_ids"],
      message: "guide_trace_id activation requires used_memory_ids or memory_ids so feedback is attributed to exposed memory only",
    });
  }
  if (value.operation === "activate" && !value.run_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["run_id"],
      message: "activate requires run_id so feedback can be attributed to a real run",
    });
  }
  if (value.operation === "activate" && !value.outcome) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "activate requires outcome so memory feedback is not lost as neutral default",
    });
  }
  if (value.operation === "activate" && !value.used_surface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_surface"],
      message: "activate requires used_surface so feedback is attributed only to memory actually used by the host",
    });
  }
  if (
    value.operation === "activate"
    && value.outcome
    && value.outcome !== "neutral"
    && value.used_surface
    && value.used_surface !== "use_now"
    && value.used_surface !== "explicit_host_assertion"
    && !value.host_use_receipt_v1
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["used_surface"],
      message: "non-neutral activation feedback requires use_now or explicit_host_assertion attribution",
    });
  }
  if (value.operation === "activate" && value.host_use_receipt_v1) {
    const receipt = value.host_use_receipt_v1;
    if (!value.operation_id || value.operation_id !== receipt.operation_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operation_id"],
        message: "host_use_receipt_v1 requires its exact protected operation_id",
      });
    }
    if (!value.guide_trace_id || value.guide_trace_id !== receipt.guide_trace_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["guide_trace_id"],
        message: "host_use_receipt_v1 guide_trace_id must match the feedback request",
      });
    }
    if (!value.run_id || value.run_id !== receipt.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run_id"],
        message: "host_use_receipt_v1 run_id must match the feedback request",
      });
    }
    if ((value.memory_ids?.length ?? 0) > 0 || (value.node_ids?.length ?? 0) > 0 || (value.client_ids?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "host_use_receipt_v1 feedback accepts only the exact used_memory_ids subject set",
      });
    }
    const suppliedRequestIds = value.used_memory_ids ?? [];
    if (new Set(suppliedRequestIds).size !== suppliedRequestIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "host_use_receipt_v1 feedback does not allow duplicate subjects",
      });
    }
    const requestIds = [...new Set(suppliedRequestIds)].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    const receiptIds = receipt.items.map((item) => item.memory_id);
    if (stableStringify(requestIds) !== stableStringify(receiptIds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["used_memory_ids"],
        message: "used_memory_ids must exactly match the canonical host-use receipt item set",
      });
    }
    const outcomes = new Set(receipt.items.map((item) => item.outcome));
    const surfaces = new Set(receipt.items.map((item) => item.used_surface));
    if (outcomes.size !== 1 || surfaces.size !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host_use_receipt_v1", "items"],
        message: "one feedback operation requires homogeneous receipt outcome and used_surface values",
      });
    }
    if (receipt.items[0]?.outcome !== value.outcome || receipt.items[0]?.used_surface !== value.used_surface) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host_use_receipt_v1", "items"],
        message: "host-use receipt outcome and used_surface must match the feedback request",
      });
    }
    if (value.verifier_status !== "passed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifier_status"],
        message: "host_use_receipt_v1 feedback requires verifier_status passed",
      });
    }
  }
  if (value.operation === "rehydrate" && memoryIdCount === 0 && !anchorPresent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_ids"],
      message: "rehydrate requires memory_ids, node_ids, client_ids, anchor_id, or anchor_uri",
    });
  }
});

export type InternalDispatchResult =
  | { ok: true; statusCode: number; path: string; body: unknown }
  | { ok: false; statusCode: number; path: string; body: unknown };

export function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export type ProductForgetInput = z.infer<typeof ProductForgetRequest>;

export type ProductForgetTarget = NonNullable<ProductForgetInput["target"]>;

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
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

export type ProductGuideExposureLedger = {
  contract_version: "aionis_guide_exposure_v1";
  guide_trace_id: string;
  feedback_episode_id: string;
  feedback_exposure_event_id: string;
  tenant_id: string;
  scope: string;
  run_id: string | null;
  consumer_agent_id: string | null;
  consumer_team_id: string | null;
  host_task_id: string | null;
  host_task_envelope_sha256: string | null;
  collector_id: string | null;
  collector_version: string | null;
  query_sha256: string;
  context_sha256: string;
  task_binding_sha256: string;
  memory_ids: string[];
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  rehydrate_memory_ids: string[];
  prompt_char_count: number;
  history_used: boolean;
  actionable_history_used: boolean;
  recommended_posture: AionisAgentContext["recommended_posture"];
  authority: AionisAgentContext["authority"];
};

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => typeof entry === "string" ? entry : null));
}

export function parseGuideExposureLedger(value: unknown): ProductGuideExposureLedger | null {
  const record = objectValue(value);
  if (!record || record.contract_version !== "aionis_guide_exposure_v1") return null;
  const guideTraceId = typeof record.guide_trace_id === "string" && record.guide_trace_id.trim()
    ? record.guide_trace_id.trim()
    : null;
  const feedbackEpisodeId = typeof record.feedback_episode_id === "string"
    && /^lep_[0-9a-f]{64}$/.test(record.feedback_episode_id)
    ? record.feedback_episode_id
    : null;
  const feedbackExposureEventId = typeof record.feedback_exposure_event_id === "string"
    && /^lexposure_[0-9a-f]{64}$/.test(record.feedback_exposure_event_id)
    ? record.feedback_exposure_event_id
    : null;
  const tenantId = typeof record.tenant_id === "string" && record.tenant_id.trim() ? record.tenant_id.trim() : null;
  const scope = typeof record.scope === "string" && record.scope.trim() ? record.scope.trim() : null;
  const querySha = typeof record.query_sha256 === "string" && record.query_sha256.trim() ? record.query_sha256.trim() : null;
  const contextSha = typeof record.context_sha256 === "string" && record.context_sha256.trim() ? record.context_sha256.trim() : null;
  const taskBindingSha = typeof record.task_binding_sha256 === "string" && /^[a-f0-9]{64}$/.test(record.task_binding_sha256)
    ? record.task_binding_sha256
    : null;
  const recommendedPosture = record.recommended_posture;
  const authority = record.authority;
  if (
    !guideTraceId
    || !feedbackEpisodeId
    || !feedbackExposureEventId
    || !tenantId
    || !scope
    || !querySha
    || !contextSha
    || !taskBindingSha
  ) return null;
  if (
    recommendedPosture !== "reuse_supported_history"
    && recommendedPosture !== "use_as_context"
    && recommendedPosture !== "inspect_before_use"
    && recommendedPosture !== "rehydrate_before_use"
    && recommendedPosture !== "ignore_history"
  ) return null;
  if (
    authority !== "trusted"
    && authority !== "advisory"
    && authority !== "candidate"
    && authority !== "blocked"
    && authority !== "none"
  ) return null;
  return {
    contract_version: "aionis_guide_exposure_v1",
    guide_trace_id: guideTraceId,
    feedback_episode_id: feedbackEpisodeId,
    feedback_exposure_event_id: feedbackExposureEventId,
    tenant_id: tenantId,
    scope,
    run_id: typeof record.run_id === "string" && record.run_id.trim() ? record.run_id.trim() : null,
    consumer_agent_id: typeof record.consumer_agent_id === "string" && record.consumer_agent_id.trim() ? record.consumer_agent_id.trim() : null,
    consumer_team_id: typeof record.consumer_team_id === "string" && record.consumer_team_id.trim() ? record.consumer_team_id.trim() : null,
    host_task_id: typeof record.host_task_id === "string" && record.host_task_id.trim() ? record.host_task_id.trim() : null,
    host_task_envelope_sha256: typeof record.host_task_envelope_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(record.host_task_envelope_sha256)
      ? record.host_task_envelope_sha256
      : null,
    collector_id: typeof record.collector_id === "string" && record.collector_id.trim() ? record.collector_id.trim() : null,
    collector_version: typeof record.collector_version === "string" && record.collector_version.trim()
      ? record.collector_version.trim()
      : null,
    query_sha256: querySha,
    context_sha256: contextSha,
    task_binding_sha256: taskBindingSha,
    memory_ids: stringArrayField(record.memory_ids),
    use_now_memory_ids: stringArrayField(record.use_now_memory_ids),
    inspect_before_use_memory_ids: stringArrayField(record.inspect_before_use_memory_ids),
    do_not_use_memory_ids: stringArrayField(record.do_not_use_memory_ids),
    rehydrate_memory_ids: stringArrayField(record.rehydrate_memory_ids),
    prompt_char_count: Math.max(0, Math.trunc(Number(record.prompt_char_count) || 0)),
    history_used: record.history_used === true,
    actionable_history_used: record.actionable_history_used === true,
    recommended_posture: recommendedPosture,
    authority,
  };
}

export function guideExposureServedMemoryIds(ledger: Pick<
  ProductGuideExposureLedger,
  | "memory_ids"
  | "use_now_memory_ids"
  | "inspect_before_use_memory_ids"
  | "do_not_use_memory_ids"
  | "rehydrate_memory_ids"
>): Set<string> {
  return new Set([
    ...ledger.memory_ids,
    ...ledger.use_now_memory_ids,
    ...ledger.inspect_before_use_memory_ids,
    ...ledger.do_not_use_memory_ids,
    ...ledger.rehydrate_memory_ids,
  ]);
}

export async function findGuideExposureLedger(args: {
  liteWriteStore: LiteWriteStore;
  env: Env;
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  consumerAgentId: string;
  consumerTeamId?: string | null;
}): Promise<ProductGuideExposureLedger | null> {
  const row = await args.liteWriteStore.getProductGuideReceipt({
    tenantId: args.tenant_id,
    scope: args.scope,
    guideTraceId: args.guide_trace_id,
  });
  if (!row || !row.commit_id) return null;
  let rawLedger: unknown;
  try {
    rawLedger = JSON.parse(row.ledger_json);
  } catch {
    return null;
  }
  if (sha256Hex(stableStringify(rawLedger)) !== row.ledger_sha256) return null;
  const ledger = parseGuideExposureLedger(rawLedger);
  if (
    !ledger
    || ledger.guide_trace_id !== row.guide_trace_id
    || ledger.tenant_id !== row.tenant_id
    || ledger.scope !== row.scope
    || ledger.query_sha256 !== row.query_sha256
    || ledger.context_sha256 !== row.context_sha256
  ) return null;
  if (ledger.consumer_agent_id !== null && ledger.consumer_agent_id !== args.consumerAgentId) return null;
  if (args.consumerTeamId !== undefined && ledger.consumer_team_id !== args.consumerTeamId) return null;
  return ledger;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type ProductObserveInput = z.infer<typeof ProductObserveRequest>;
export type ProductExecutionEpisodeObserveInput = z.infer<
  typeof ProductExecutionEpisodeObserveRequest
>;
export type ProductExecutionSessionObserveInput = z.infer<
  typeof ProductExecutionSessionObserveRequest
>;
export type ProductObserveRouteInput = z.infer<
  typeof ProductObserveRouteRequest
>;
export type ProductExecutionEpisodeOutcomeInput = z.infer<
  typeof ProductExecutionEpisodeOutcomeRequest
>;
export type ProductGuideInput = z.infer<typeof ProductGuideRequest>;
export type ProductLifecycleSurface = "forget" | "feedback" | "rehydrate";

export type ProductServiceResult<T = unknown> =
  | { ok: true; statusCode: number; body: T }
  | { ok: false; statusCode: number; body: unknown };

export function productServiceSuccess<T>(body: T, statusCode = 200): ProductServiceResult<T> {
  return { ok: true, statusCode, body };
}

export function productServiceFailure(args: {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
  topLevel?: Record<string, unknown>;
}): ProductServiceResult<never> {
  return {
    ok: false,
    statusCode: args.statusCode,
    body: productErrorResponse({
      status: args.statusCode,
      error: args.error,
      message: args.message,
      details: args.details,
      topLevel: args.topLevel,
    }),
  };
}

export function productServiceDependencyFailure(
  surface: string,
  statusCode = 500,
): ProductServiceResult<never> {
  return productServiceFailure({
    statusCode,
    error: "product_dependency_failed",
    message: "A product facade dependency failed.",
    details: {
      surface,
      upstream_status: statusCode,
      retryable: statusCode === 429 || statusCode >= 500,
    },
  });
}

export function productServiceFailureFromUnknown(error: unknown): ProductServiceResult<never> {
  if (error instanceof HttpError) {
    return productServiceFailure({
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      details: objectValue(error.details) ?? undefined,
    });
  }
  if (error instanceof z.ZodError) {
    return productServiceFailure({
      statusCode: 400,
      error: "invalid_request",
      message: "invalid request",
      details: {
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  return productServiceFailure({
    statusCode: 500,
    error: "internal_error",
    message: "Aionis product service failed.",
  });
}

export type ProductObserveExecutionContext = {
  principal: AuthPrincipal | null;
};

export type ProductLifecycleExecutionContext = {
  principal: AuthPrincipal | null;
};

export type ProductServices = {
  executionSession: {
    observe(
      input: ProductExecutionSessionObserveInput,
    ): Promise<ProductServiceResult>;
  };
  executionEpisode: {
    observe(
      input: ProductExecutionEpisodeObserveInput,
    ): Promise<ProductServiceResult>;
    outcome(
      input: ProductExecutionEpisodeOutcomeInput,
    ): Promise<ProductServiceResult>;
  };
  observe: {
    guardOrder(input: ProductObserveInput): "guards_first" | "inflight_first";
    execute(input: ProductObserveInput, context: ProductObserveExecutionContext): Promise<ProductServiceResult>;
  };
  guide: {
    execute(input: ProductGuideInput): Promise<ProductServiceResult>;
  };
  lifecycle: {
    execute(
      input: ProductForgetInput,
      surface: ProductLifecycleSurface,
      context: ProductLifecycleExecutionContext,
    ): Promise<ProductServiceResult>;
  };
};
