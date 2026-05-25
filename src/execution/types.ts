import { z } from "zod";

export const ExecutionStage = z.enum(["triage", "patch", "review", "resume"]);
export type ExecutionStage = z.infer<typeof ExecutionStage>;

export const ExecutionRole = z.enum(["orchestrator", "triage", "patch", "review", "resume"]);
export type ExecutionRole = z.infer<typeof ExecutionRole>;

const StringList = z.array(z.string().min(1)).default([]);

export const ServiceLifecycleKind = z.enum(["generic", "http", "tcp", "process"]);
export type ServiceLifecycleKind = z.infer<typeof ServiceLifecycleKind>;

export const ServiceLifecycleConstraintV1Schema = z.object({
  version: z.literal(1),
  service_kind: ServiceLifecycleKind.default("generic"),
  label: z.string().trim().min(1),
  launch_reference: z.string().trim().min(1).nullable().default(null),
  endpoint: z.string().trim().min(1).nullable().default(null),
  must_survive_agent_exit: z.boolean().default(false),
  revalidate_from_fresh_shell: z.boolean().default(false),
  detach_then_probe: z.boolean().default(false),
  health_checks: StringList,
  teardown_notes: StringList,
});
export type ServiceLifecycleConstraintV1 = z.infer<typeof ServiceLifecycleConstraintV1Schema>;

export const ReviewerContractSchema = z.object({
  standard: z.string().trim().min(1),
  required_outputs: StringList,
  acceptance_checks: StringList,
  rollback_required: z.boolean().default(false),
});
export type ReviewerContract = z.infer<typeof ReviewerContractSchema>;

export const ResumeAnchorSchema = z.object({
  anchor: z.string().trim().min(1),
  file_path: z.string().trim().min(1).nullable().default(null),
  symbol: z.string().trim().min(1).nullable().default(null),
  repo_root: z.string().trim().min(1).nullable().default(null),
});
export type ResumeAnchor = z.infer<typeof ResumeAnchorSchema>;

export const ExecutionStateV1Schema = z.object({
  state_id: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  task_brief: z.string().trim().min(1),
  current_stage: ExecutionStage,
  active_role: ExecutionRole,
  owned_files: StringList,
  modified_files: StringList,
  pending_validations: StringList,
  completed_validations: StringList,
  last_accepted_hypothesis: z.string().trim().min(1).nullable().default(null),
  rejected_paths: StringList,
  unresolved_blockers: StringList,
  rollback_notes: StringList,
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).default([]),
  reviewer_contract: ReviewerContractSchema.nullable().default(null),
  resume_anchor: ResumeAnchorSchema.nullable().default(null),
  updated_at: z.string().datetime(),
  version: z.literal(1),
});
export type ExecutionStateV1 = z.infer<typeof ExecutionStateV1Schema>;

export const ExecutionPacketV1Schema = z.object({
  version: z.literal(1),
  state_id: z.string().trim().min(1),
  current_stage: ExecutionStage,
  active_role: ExecutionRole,
  task_brief: z.string().trim().min(1),
  target_files: StringList,
  next_action: z.string().trim().min(1).nullable().default(null),
  hard_constraints: StringList,
  accepted_facts: StringList,
  rejected_paths: StringList,
  pending_validations: StringList,
  unresolved_blockers: StringList,
  rollback_notes: StringList,
  service_lifecycle_constraints: z.array(ServiceLifecycleConstraintV1Schema).max(16).default([]),
  review_contract: ReviewerContractSchema.nullable().default(null),
  resume_anchor: ResumeAnchorSchema.nullable().default(null),
  artifact_refs: StringList,
  evidence_refs: StringList,
});
export type ExecutionPacketV1 = z.infer<typeof ExecutionPacketV1Schema>;

const DerivedSourceMode = z.enum(["memory_only", "packet_backed"]);
const RecordSource = z.enum(["strategy_summary", "execution_packet", "collaboration_summary"]);
const RefKind = z.enum(["artifact", "evidence"]);

export const ExecutionDelegationPacketRecordV1Schema = z.object({
  version: z.literal(1),
  role: z.string().trim().min(1),
  mission: z.string().trim().min(1),
  working_set: StringList,
  acceptance_checks: StringList,
  output_contract: z.string().trim().min(1),
  preferred_artifact_refs: StringList,
  inherited_evidence: StringList,
  routing_reason: z.string().trim().min(1),
  task_family: z.string().trim().min(1).nullable().default(null),
  family_scope: z.string().trim().min(1),
  source_mode: DerivedSourceMode,
}).strict();
export type ExecutionDelegationPacketRecordV1 = z.infer<typeof ExecutionDelegationPacketRecordV1Schema>;

export const ExecutionDelegationReturnRecordV1Schema = z.object({
  version: z.literal(1),
  role: z.string().trim().min(1),
  status: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  evidence: StringList,
  working_set: StringList,
  acceptance_checks: StringList,
  source_mode: DerivedSourceMode,
}).strict();
export type ExecutionDelegationReturnRecordV1 = z.infer<typeof ExecutionDelegationReturnRecordV1Schema>;

export const ExecutionArtifactRoutingRecordV1Schema = z.object({
  version: z.literal(1),
  ref: z.string().trim().min(1),
  ref_kind: RefKind,
  route_role: z.string().trim().min(1),
  route_intent: z.string().trim().min(1),
  route_mode: DerivedSourceMode,
  task_family: z.string().trim().min(1).nullable().default(null),
  family_scope: z.string().trim().min(1),
  routing_reason: z.string().trim().min(1),
  source: RecordSource,
}).strict();
export type ExecutionArtifactRoutingRecordV1 = z.infer<typeof ExecutionArtifactRoutingRecordV1Schema>;

export const ControlProfileName = z.enum(["triage", "patch", "review", "resume"]);
export type ControlProfileName = z.infer<typeof ControlProfileName>;

export const ControlProfileV1Schema = z.object({
  version: z.literal(1),
  profile: ControlProfileName,
  max_same_tool_streak: z.number().int().positive(),
  max_no_progress_streak: z.number().int().positive(),
  max_duplicate_observation_streak: z.number().int().positive(),
  max_steps: z.number().int().positive(),
  allow_broad_scan: z.boolean(),
  allow_broad_test: z.boolean(),
  escalate_on_blocker: z.boolean(),
  reviewer_ready_required: z.boolean(),
});
export type ControlProfileV1 = z.infer<typeof ControlProfileV1Schema>;
