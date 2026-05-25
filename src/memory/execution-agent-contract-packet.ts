import { z } from "zod";
import {
  ExecutionContractProvenanceV1Schema,
  ExecutionContractV1Schema,
  type ExecutionContractV1,
} from "./execution-contract.js";
import { type ServiceLifecycleConstraintV1 } from "../execution/types.js";

const StringList = z.array(z.string().trim().min(1)).default([]);

export const ExecutionAgentContractPacketModeSchema = z.enum(["contract_only", "workflow_expanded"]);
export type ExecutionAgentContractPacketMode = z.infer<typeof ExecutionAgentContractPacketModeSchema>;

export const ExecutionAgentContractPacketRenderAudienceSchema = z.enum(["operator_diagnostic", "agent_minimal"]);
export type ExecutionAgentContractPacketRenderAudience = z.infer<
  typeof ExecutionAgentContractPacketRenderAudienceSchema
>;

export const ExecutionAgentContractPacketEscalationReasonSchema = z.enum([
  "explicit_workflow_expanded_requested",
  "verification_failed",
  "compact_contract_marked_insufficient",
  "compact_contract_missing_target_files",
  "compact_contract_missing_next_action",
  "compact_contract_missing_acceptance_checks",
  "unresolved_blockers_present",
]);
export type ExecutionAgentContractPacketEscalationReason = z.infer<
  typeof ExecutionAgentContractPacketEscalationReasonSchema
>;

export const ExecutionAgentContractPacketV1Schema = z.object({
  packet_version: z.literal("execution_agent_contract_packet_v1"),
  mode: ExecutionAgentContractPacketModeSchema,
  action_discipline: z.object({
    execution_mode: z.enum(["contract_locked", "exploratory_allowed"]),
    first_action: z.string().trim().min(1),
    max_pre_edit_confirmation_steps: z.number().int().nonnegative().nullable(),
    allowed_work_surface: StringList,
    required_validation: StringList,
    prohibited_actions: StringList,
    stop_conditions: StringList,
  }).strict(),
  contract: z.object({
    contract_trust: z.enum(["authoritative", "advisory", "observational"]).nullable(),
    task_family: z.string().trim().min(1).nullable(),
    task_prompt: z.string().trim().min(1).nullable(),
    task_signature: z.string().trim().min(1).nullable(),
    workflow_signature: z.string().trim().min(1).nullable(),
    target_files: StringList,
    next_action: z.string().trim().min(1).nullable(),
    acceptance_checks: StringList,
    lifecycle_constraints: StringList,
    validation_boundary: StringList,
    authority_boundary: StringList,
    success_invariants: StringList,
    dependency_requirements: StringList,
    environment_assumptions: StringList,
    must_hold_after_exit: StringList,
    external_visibility_requirements: StringList,
  }).strict(),
  expanded: z.object({
    selected_tool: z.string().trim().min(1).nullable(),
    workflow_steps: StringList,
    pattern_hints: StringList,
    provenance: ExecutionContractProvenanceV1Schema,
  }).strict().nullable(),
  escalation: z.object({
    requested_mode: ExecutionAgentContractPacketModeSchema,
    effective_mode: ExecutionAgentContractPacketModeSchema,
    escalated: z.boolean(),
    reasons: z.array(ExecutionAgentContractPacketEscalationReasonSchema).default([]),
    unresolved_blockers: StringList,
  }).strict(),
}).strict();
export type ExecutionAgentContractPacketV1 = z.infer<typeof ExecutionAgentContractPacketV1Schema>;

function uniqueStrings(values: Array<string | null | undefined>, limit = 64): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= limit) break;
  }
  return out;
}

function lifecycleConstraintLabel(constraint: ServiceLifecycleConstraintV1): string {
  const flags = uniqueStrings([
    constraint.must_survive_agent_exit ? "must_survive_agent_exit" : null,
    constraint.revalidate_from_fresh_shell ? "revalidate_from_fresh_shell" : null,
    constraint.detach_then_probe ? "detach_then_probe" : null,
    constraint.endpoint ? `endpoint=${constraint.endpoint}` : null,
    constraint.launch_reference ? `launch=${constraint.launch_reference}` : null,
  ], 8);
  return flags.length > 0 ? `${constraint.label}:${flags.join(",")}` : constraint.label;
}

function lifecycleConstraints(contract: ExecutionContractV1): string[] {
  return uniqueStrings([
    ...contract.service_lifecycle_constraints.map(lifecycleConstraintLabel),
    ...contract.outcome.must_hold_after_exit,
    ...contract.outcome.external_visibility_requirements,
  ], 32);
}

function isPackagePublishValidate(contract: ExecutionContractV1): boolean {
  return contract.task_family === "package_publish_validate";
}

function isGitDeployWebserver(contract: ExecutionContractV1): boolean {
  return contract.task_family === "git_deploy_webserver";
}

function acceptanceMentionsFreshShellPlaceholder(contract: ExecutionContractV1): boolean {
  return contract.outcome.acceptance_checks.some((check) => /<fresh-shell-endpoint>/i.test(check));
}

function hasServiceLifecycleConstraint(contract: ExecutionContractV1): boolean {
  return contract.service_lifecycle_constraints.some((constraint) =>
    constraint.must_survive_agent_exit
    || constraint.revalidate_from_fresh_shell
    || constraint.detach_then_probe
    || Boolean(constraint.endpoint)
  );
}

function validationBoundary(contract: ExecutionContractV1): string[] {
  return uniqueStrings([
    acceptanceMentionsFreshShellPlaceholder(contract)
      ? "fresh_shell_endpoint_placeholder_is_verifier_owned_not_an_agent_discovery_target"
      : null,
    isPackagePublishValidate(contract)
      ? "package_index_http_server_is_validation_transport_not_product_service"
      : null,
    isPackagePublishValidate(contract)
      ? "agent_may_use_a_single_scoped_local_server_for_local_install_checks_when_needed"
      : null,
    isPackagePublishValidate(contract)
      ? "do_not_require_package_index_transport_to_survive_agent_exit_without_service_lifecycle_constraint"
      : null,
    isPackagePublishValidate(contract)
      ? "final_clean_client_fresh_shell_install_is_owned_by_external_verifier"
      : null,
    isGitDeployWebserver(contract)
      ? "served_web_endpoint_is_external_visibility_boundary"
      : null,
    isGitDeployWebserver(contract)
      ? "git_or_hook_success_is_not_served_content_proof"
      : null,
    isGitDeployWebserver(contract)
      ? "publish_root_file_presence_is_not_served_content_proof"
      : null,
    isGitDeployWebserver(contract) && !hasServiceLifecycleConstraint(contract)
      ? "do_not_manage_webserver_lifecycle_without_declared_service_constraint"
      : null,
  ], 16);
}

function authorityBoundary(contract: ExecutionContractV1): string[] {
  return uniqueStrings([
    contract.contract_trust && contract.contract_trust !== "authoritative"
      ? `contract_trust=${contract.contract_trust}; treat as non-authoritative until acceptance evidence passes`
      : null,
    contract.outcome.acceptance_checks.length > 0
      ? "success_requires_declared_acceptance_checks"
      : "success_claim_is_advisory_without_acceptance_checks",
    contract.outcome.must_hold_after_exit.length > 0
      ? "after_exit_claim_requires_fresh_shell_revalidation"
      : null,
    contract.outcome.external_visibility_requirements.length > 0
      ? "external_visibility_must_be_verified_outside_agent_claim"
      : null,
    acceptanceMentionsFreshShellPlaceholder(contract)
      ? "fresh_shell_endpoint_placeholder_must_not_trigger_endpoint_discovery"
      : null,
    isGitDeployWebserver(contract)
      ? "deploy_claim_requires_served_endpoint_content_match"
      : null,
  ], 16);
}

function compactInsufficiencyReasons(contract: ExecutionContractV1): ExecutionAgentContractPacketEscalationReason[] {
  const reasons: ExecutionAgentContractPacketEscalationReason[] = [];
  if (contract.target_files.length === 0) reasons.push("compact_contract_missing_target_files");
  if (!contract.next_action) reasons.push("compact_contract_missing_next_action");
  if (contract.outcome.acceptance_checks.length === 0) reasons.push("compact_contract_missing_acceptance_checks");
  return reasons;
}

function hasLifecycleOrExternalValidation(contract: ExecutionContractV1): boolean {
  return contract.service_lifecycle_constraints.some((constraint) =>
    constraint.must_survive_agent_exit
    || constraint.revalidate_from_fresh_shell
    || constraint.detach_then_probe
    || Boolean(constraint.endpoint)
  )
    || contract.outcome.must_hold_after_exit.length > 0
    || contract.outcome.external_visibility_requirements.length > 0;
}

function maxPreEditConfirmationSteps(contract: ExecutionContractV1): number {
  const targetInspectionBudget = Math.max(1, Math.min(contract.target_files.length, 3));
  const acceptanceProbeBudget = contract.outcome.acceptance_checks.length > 0 ? 1 : 0;
  const lifecycleProbeBudget = hasLifecycleOrExternalValidation(contract) ? 1 : 0;
  return Math.max(2, Math.min(6, targetInspectionBudget + acceptanceProbeBudget + lifecycleProbeBudget));
}

function buildActionDiscipline(contract: ExecutionContractV1): ExecutionAgentContractPacketV1["action_discipline"] {
  const compactComplete =
    contract.target_files.length > 0
    && Boolean(contract.next_action)
    && contract.outcome.acceptance_checks.length > 0;
  const contractLocked = contract.contract_trust === "authoritative" && compactComplete;
  const acceptanceEvidenceFiles = contract.target_files.filter((file) =>
    /(^|\/)(tests?|spec|__tests__)\//i.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)
  );

  return {
    execution_mode: contractLocked ? "contract_locked" : "exploratory_allowed",
    first_action: contractLocked
      ? "inspect_declared_target_files_before_broad_discovery"
      : "fill_missing_contract_fields_before_claiming_authority",
    max_pre_edit_confirmation_steps: contractLocked ? maxPreEditConfirmationSteps(contract) : null,
    allowed_work_surface: uniqueStrings([
      ...contract.target_files,
      ...contract.outcome.acceptance_checks.map((check) => `validation:${check}`),
    ], 32),
    required_validation: contract.outcome.acceptance_checks,
    prohibited_actions: uniqueStrings([
      contractLocked ? "do_not_run_broad_repository_file_enumeration_before_declared_targets" : null,
      contractLocked ? "do_not_read_general_skill_or_preference_files_before_declared_targets" : null,
      contractLocked ? "do_not_expand_beyond_target_files_without_new_failing_evidence" : null,
      contractLocked ? "do_not_repeat_successful_acceptance_checks_without_new_evidence" : null,
      acceptanceMentionsFreshShellPlaceholder(contract)
        ? "do_not_discover_or_probe_random_fresh_shell_endpoints"
        : null,
      isPackagePublishValidate(contract)
        ? "do_not_treat_package_index_http_transport_as_service_lifecycle"
        : null,
      isPackagePublishValidate(contract)
        ? "do_not_retry_background_package_index_servers_without_new_bind_or_log_evidence"
        : null,
      isGitDeployWebserver(contract)
        ? "do_not_claim_success_from_git_or_hook_exit_without_served_endpoint_probe"
        : null,
      isGitDeployWebserver(contract) && !hasServiceLifecycleConstraint(contract)
        ? "do_not_restart_or_reconfigure_webserver_without_declared_lifecycle_target"
        : null,
      acceptanceEvidenceFiles.length > 0 ? `do_not_edit_acceptance_evidence:${acceptanceEvidenceFiles.join(",")}` : null,
    ], 16),
    stop_conditions: uniqueStrings([
      contract.outcome.acceptance_checks.length > 0
        ? "stop_after_required_validation_passes_and_report_evidence"
        : null,
      acceptanceMentionsFreshShellPlaceholder(contract)
        ? "do_not_search_for_placeholder_fresh_shell_endpoint; external_verifier_owns_final_fresh_shell_probe"
        : null,
      isPackagePublishValidate(contract)
        ? "after_package_artifact_index_and_installed_api_are_correct_do_not_keep_validation_transport_alive"
        : null,
      isGitDeployWebserver(contract)
        ? "after_served_endpoint_matches_deployed_revision_do_not_keep_reworking_hook_or_webserver"
        : null,
      "do_not_run_external_harness_verifier_from_inside_agent_attempt",
    ], 8),
  };
}

export function buildExecutionAgentContractPacketV1(args: {
  contract: ExecutionContractV1 | z.input<typeof ExecutionContractV1Schema>;
  task_prompt?: string | null;
  requested_mode?: ExecutionAgentContractPacketMode | null;
  verification_failed?: boolean;
  compact_contract_insufficient?: boolean;
  unresolved_blockers?: string[];
}): ExecutionAgentContractPacketV1 {
  const contract = ExecutionContractV1Schema.parse(args.contract);
  const requestedMode = args.requested_mode ?? "contract_only";
  const reasons = uniqueStrings([
    requestedMode === "workflow_expanded" ? "explicit_workflow_expanded_requested" : null,
    args.verification_failed ? "verification_failed" : null,
    args.compact_contract_insufficient ? "compact_contract_marked_insufficient" : null,
    ...compactInsufficiencyReasons(contract),
    ...(args.unresolved_blockers && args.unresolved_blockers.length > 0 ? ["unresolved_blockers_present"] : []),
  ] as Array<ExecutionAgentContractPacketEscalationReason | null>, 16) as ExecutionAgentContractPacketEscalationReason[];
  const effectiveMode: ExecutionAgentContractPacketMode = reasons.length > 0 ? "workflow_expanded" : "contract_only";

  return ExecutionAgentContractPacketV1Schema.parse({
    packet_version: "execution_agent_contract_packet_v1",
    mode: effectiveMode,
    action_discipline: buildActionDiscipline(contract),
    contract: {
      contract_trust: contract.contract_trust,
      task_family: contract.task_family,
      task_prompt: args.task_prompt ?? null,
      task_signature: contract.task_signature,
      workflow_signature: contract.workflow_signature,
      target_files: contract.target_files,
      next_action: contract.next_action,
      acceptance_checks: contract.outcome.acceptance_checks,
      lifecycle_constraints: lifecycleConstraints(contract),
      validation_boundary: validationBoundary(contract),
      authority_boundary: authorityBoundary(contract),
      success_invariants: contract.outcome.success_invariants,
      dependency_requirements: contract.outcome.dependency_requirements,
      environment_assumptions: contract.outcome.environment_assumptions,
      must_hold_after_exit: contract.outcome.must_hold_after_exit,
      external_visibility_requirements: contract.outcome.external_visibility_requirements,
    },
    expanded: effectiveMode === "workflow_expanded"
      ? {
          selected_tool: contract.selected_tool,
          workflow_steps: contract.workflow_steps,
          pattern_hints: contract.pattern_hints,
          provenance: contract.provenance,
        }
      : null,
    escalation: {
      requested_mode: requestedMode,
      effective_mode: effectiveMode,
      escalated: requestedMode !== effectiveMode,
      reasons,
      unresolved_blockers: uniqueStrings(args.unresolved_blockers ?? [], 16),
    },
  });
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(" | ") : "<none>";
}

function renderAgentMinimalContractPacketMarkdown(packet: ExecutionAgentContractPacketV1): string[] {
  const lines = [
    "Runtime contract:",
    `- task_family: ${packet.contract.task_family ?? "<unknown>"}`,
    `- target_files: ${formatList(packet.contract.target_files)}`,
    `- next_action: ${packet.contract.next_action ?? "<none>"}`,
    `- acceptance_checks: ${formatList(packet.contract.acceptance_checks)}`,
    `- lifecycle_constraints: ${formatList(packet.contract.lifecycle_constraints)}`,
    `- validation_boundary: ${formatList(packet.contract.validation_boundary)}`,
    `- authority_boundary: ${formatList(packet.contract.authority_boundary)}`,
    "",
    "Execution boundary:",
    `- execution_mode: ${packet.action_discipline.execution_mode}`,
    `- prohibited_actions: ${formatList(packet.action_discipline.prohibited_actions)}`,
    `- stop_conditions: ${formatList(packet.action_discipline.stop_conditions)}`,
  ].filter((line): line is string => Boolean(line));

  if (packet.mode === "workflow_expanded" && packet.expanded) {
    lines.push(
      "",
      "Expanded workflow:",
      ...packet.expanded.workflow_steps.map((step, index) => `${index + 1}. ${step}`),
    );
    if (packet.expanded.pattern_hints.length > 0) {
      lines.push("", "Pattern hints:", ...packet.expanded.pattern_hints.map((hint) => `- ${hint}`));
    }
    if (packet.escalation.reasons.length > 0) {
      lines.push("", `Escalation reasons: ${packet.escalation.reasons.join(", ")}`);
    }
  }

  return lines;
}

export function renderExecutionAgentContractPacketMarkdown(
  packetInput: ExecutionAgentContractPacketV1,
  options: { audience?: ExecutionAgentContractPacketRenderAudience } = {},
): string[] {
  const packet = ExecutionAgentContractPacketV1Schema.parse(packetInput);
  const audience = ExecutionAgentContractPacketRenderAudienceSchema.parse(options.audience ?? "operator_diagnostic");
  if (audience === "agent_minimal") {
    return renderAgentMinimalContractPacketMarkdown(packet);
  }
  const lines = [
    "Runtime contract:",
    `- task_family: ${packet.contract.task_family ?? "<unknown>"}`,
    packet.contract.task_prompt ? `- task_prompt: ${packet.contract.task_prompt}` : null,
    `- target_files: ${formatList(packet.contract.target_files)}`,
    `- next_action: ${packet.contract.next_action ?? "<none>"}`,
    `- acceptance_checks: ${formatList(packet.contract.acceptance_checks)}`,
    `- lifecycle_constraints: ${formatList(packet.contract.lifecycle_constraints)}`,
    `- validation_boundary: ${formatList(packet.contract.validation_boundary)}`,
    `- authority_boundary: ${formatList(packet.contract.authority_boundary)}`,
    "",
    "Action discipline:",
    `- execution_mode: ${packet.action_discipline.execution_mode}`,
    `- first_action: ${packet.action_discipline.first_action}`,
    `- max_pre_edit_confirmation_steps: ${packet.action_discipline.max_pre_edit_confirmation_steps ?? "<none>"}`,
    `- allowed_work_surface: ${formatList(packet.action_discipline.allowed_work_surface)}`,
    `- prohibited_actions: ${formatList(packet.action_discipline.prohibited_actions)}`,
    `- stop_conditions: ${formatList(packet.action_discipline.stop_conditions)}`,
  ].filter((line): line is string => Boolean(line));

  if (packet.mode === "workflow_expanded" && packet.expanded) {
    lines.push(
      "",
      "Expanded workflow:",
      ...packet.expanded.workflow_steps.map((step, index) => `${index + 1}. ${step}`),
    );
    if (packet.expanded.pattern_hints.length > 0) {
      lines.push("", "Pattern hints:", ...packet.expanded.pattern_hints.map((hint) => `- ${hint}`));
    }
    if (packet.escalation.reasons.length > 0) {
      lines.push("", `Escalation reasons: ${packet.escalation.reasons.join(", ")}`);
    }
  }

  return lines;
}
