import { buildAionisUri } from "./uri.js";

type ReplayPlaybookStatus = "draft" | "shadow" | "active" | "disabled";

type ReplayWriteIdentityLike = Record<string, unknown>;

type ReplayProcedureWriteRequestArgs = {
  tenantId: string;
  scope: string;
  actor: string;
  inputText: string;
  writeIdentity: ReplayWriteIdentityLike;
  clientId: string;
  title: string;
  textSummary: string;
  slots: Record<string, unknown>;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  sourceNodeId: string;
};

type ReplayPlaybookVersionResultArgs = {
  tenantId: string;
  scope: string;
  playbookId: string;
  fromVersion: number;
  toVersion: number;
  status: ReplayPlaybookStatus;
  nodeId: string | null;
  commitId: string;
  commitUri: string;
  commitHash: string | null;
  extra?: Record<string, unknown>;
};

function buildReplayPlaybookNodeUri(tenantId: string, scope: string, nodeId: string | null) {
  if (!nodeId) return null;
  return buildAionisUri({
    tenant_id: tenantId,
    scope,
    type: "procedure",
    id: nodeId,
  });
}

export function buildReplayPromotedSlots(args: {
  sourceSlots: Record<string, unknown>;
  playbookId: string;
  version: number;
  status: ReplayPlaybookStatus;
  sourceVersion: number;
  promotedAt: string;
  note: string | null;
  metadata: Record<string, unknown>;
}) {
  return {
    ...args.sourceSlots,
    replay_kind: "playbook",
    playbook_id: args.playbookId,
    version: args.version,
    status: args.status,
    promoted_from_version: args.sourceVersion,
    promoted_at: args.promotedAt,
    promotion_note: args.note,
    promotion_metadata: args.metadata,
  };
}

export function buildReplayRepairedSlots(args: {
  nextSlots: Record<string, unknown>;
  playbookId: string;
  version: number;
  status: ReplayPlaybookStatus;
  sourceVersion: number;
  repairedAt: string;
  note: string | null;
  patch: Record<string, unknown>;
  summary: Record<string, unknown>;
  reviewRequired: boolean;
  actor: string;
  targetStatus: ReplayPlaybookStatus;
  metadata: Record<string, unknown>;
}) {
  return {
    ...args.nextSlots,
    replay_kind: "playbook",
    playbook_id: args.playbookId,
    version: args.version,
    status: args.status,
    repaired_from_version: args.sourceVersion,
    repaired_at: args.repairedAt,
    repair_note: args.note,
    repair_patch: args.patch,
    repair_summary: args.summary,
    repair_review: {
      state: args.reviewRequired ? "pending_review" : "approved",
      review_required: args.reviewRequired,
      requested_at: args.repairedAt,
      requested_by: args.actor,
      requested_target_status: args.targetStatus,
      note: args.note,
    },
    repair_metadata: args.metadata,
  };
}

export function buildReplayReviewedSlots(args: {
  sourceSlots: Record<string, unknown>;
  sourceReview: Record<string, unknown>;
  playbookId: string;
  version: number;
  status: ReplayPlaybookStatus;
  sourceVersion: number;
  reviewedAt: string;
  actor: string;
  action: string;
  note: string | null;
  autoShadowValidate: boolean;
  shadowValidationMode: string;
  shadowValidationMaxSteps: number;
  autoPromoteOnPass: boolean;
  autoPromoteTargetStatus: ReplayPlaybookStatus;
  autoPromoteGate: Record<string, unknown> | null;
  targetStatusOnApprove: ReplayPlaybookStatus;
  metadata: Record<string, unknown>;
  reviewState: string;
  shadowValidation: Record<string, unknown> | null;
}) {
  return {
    ...args.sourceSlots,
    replay_kind: "playbook",
    playbook_id: args.playbookId,
    version: args.version,
    status: args.status,
    reviewed_from_version: args.sourceVersion,
    reviewed_at: args.reviewedAt,
    repair_review: {
      ...args.sourceReview,
      state: args.reviewState,
      action: args.action,
      reviewed_at: args.reviewedAt,
      reviewed_by: args.actor,
      review_note: args.note,
      auto_shadow_validate: args.autoShadowValidate,
      shadow_validation_mode: args.shadowValidationMode,
      shadow_validation_max_steps: args.shadowValidationMaxSteps,
      auto_promote_on_pass: args.autoPromoteOnPass,
      auto_promote_target_status: args.autoPromoteTargetStatus,
      auto_promote_gate: args.autoPromoteGate,
      target_status_on_approve: args.targetStatusOnApprove,
      review_metadata: args.metadata,
    },
    shadow_validation_last: args.shadowValidation ?? args.sourceSlots.shadow_validation_last ?? null,
  };
}

export function buildReplayAutoPromotedSlots(args: {
  reviewedSlots: Record<string, unknown>;
  version: number;
  status: ReplayPlaybookStatus;
  triggeredAt: string;
  fromVersion: number;
  toVersion: number;
  fromStatus: ReplayPlaybookStatus;
  gate: Record<string, unknown>;
}) {
  return {
    ...args.reviewedSlots,
    version: args.version,
    status: args.status,
    auto_promotion: {
      triggered: true,
      triggered_at: args.triggeredAt,
      from_version: args.fromVersion,
      to_version: args.toVersion,
      from_status: args.fromStatus,
      to_status: args.status,
      gate: args.gate,
    },
  };
}

export function buildReplayPlaybookProcedureWriteRequest(args: ReplayProcedureWriteRequestArgs) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    actor: args.actor,
    input_text: args.inputText,
    auto_embed: false,
    ...args.writeIdentity,
    nodes: [
      {
        client_id: args.clientId,
        type: "procedure" as const,
        title: args.title,
        text_summary: args.textSummary,
        slots: args.slots,
        ...(args.embedding && args.embeddingModel
          ? { embedding: args.embedding, embedding_model: args.embeddingModel }
          : {}),
      },
    ],
    edges: [
      {
        type: "derived_from" as const,
        src: { client_id: args.clientId },
        dst: { id: args.sourceNodeId },
      },
    ],
  };
}

export function buildReplayPlaybookVersionResult(args: ReplayPlaybookVersionResultArgs) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    playbook_id: args.playbookId,
    from_version: args.fromVersion,
    to_version: args.toVersion,
    status: args.status,
    playbook_node_id: args.nodeId,
    playbook_uri: buildReplayPlaybookNodeUri(args.tenantId, args.scope, args.nodeId),
    commit_id: args.commitId,
    commit_uri: args.commitUri,
    commit_hash: args.commitHash,
    ...(args.extra ?? {}),
  };
}

export function buildReplayPlaybookNoopPromoteResult(args: {
  tenantId: string;
  scope: string;
  playbookId: string;
  fromVersion: number;
  toVersion: number;
  status: ReplayPlaybookStatus;
  nodeId: string;
  unchanged: boolean;
  reason: string;
}) {
  return {
    tenant_id: args.tenantId,
    scope: args.scope,
    playbook_id: args.playbookId,
    from_version: args.fromVersion,
    to_version: args.toVersion,
    status: args.status,
    unchanged: args.unchanged,
    reason: args.reason,
    playbook_node_id: args.nodeId,
    playbook_uri: buildReplayPlaybookNodeUri(args.tenantId, args.scope, args.nodeId),
  };
}
