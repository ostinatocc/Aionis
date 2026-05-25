import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionAgentContractPacketV1,
  renderExecutionAgentContractPacketMarkdown,
} from "../../src/memory/execution-agent-contract-packet.ts";
import { buildExecutionContractFromProjection } from "../../src/memory/execution-contract.ts";

function serviceConstraint(label: string) {
  return {
    version: 1 as const,
    service_kind: "generic" as const,
    label,
    launch_reference: null,
    endpoint: null,
    must_survive_agent_exit: label === "runtime-service",
    revalidate_from_fresh_shell: label === "runtime-service",
    detach_then_probe: label === "runtime-service",
    health_checks: [],
    teardown_notes: [],
  };
}

test("execution agent contract packet defaults to compact contract-only output", () => {
  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "service_publish_validate",
    target_files: ["scripts/server.mjs"],
    next_action: "Launch the service detached and probe /healthz from a fresh shell.",
    workflow_steps: [
      "Inspect service entrypoint.",
      "Launch detached with redirected stdio.",
      "Probe from a fresh shell.",
    ],
    pattern_hints: ["prefer nohup over foreground child processes"],
    service_lifecycle_constraints: [serviceConstraint("runtime-service")],
    acceptance_checks: ["curl -fsS http://127.0.0.1:4199/healthz"],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: "anchor_service",
      evidence_refs: ["evidence:service"],
      notes: ["compiled from failed service trajectory"],
    },
  });

  const packet = buildExecutionAgentContractPacketV1({
    contract,
    task_prompt: "Keep the service alive after worker exit.",
  });
  const markdown = renderExecutionAgentContractPacketMarkdown(packet).join("\n");

  assert.equal(packet.packet_version, "execution_agent_contract_packet_v1");
  assert.equal(packet.mode, "contract_only");
  assert.equal(packet.expanded, null);
  assert.deepEqual(packet.contract.target_files, ["scripts/server.mjs"]);
  assert.equal(packet.contract.next_action, "Launch the service detached and probe /healthz from a fresh shell.");
  assert.deepEqual(packet.contract.acceptance_checks, ["curl -fsS http://127.0.0.1:4199/healthz"]);
  assert.ok(packet.contract.lifecycle_constraints.some((constraint) => constraint.includes("must_survive_agent_exit")));
  assert.ok(packet.contract.authority_boundary.includes("success_requires_declared_acceptance_checks"));
  assert.ok(packet.contract.authority_boundary.includes("after_exit_claim_requires_fresh_shell_revalidation"));
  assert.equal(packet.action_discipline.execution_mode, "contract_locked");
  assert.equal(packet.action_discipline.first_action, "inspect_declared_target_files_before_broad_discovery");
  assert.equal(packet.action_discipline.max_pre_edit_confirmation_steps, 3);
  assert.ok(packet.action_discipline.prohibited_actions.includes("do_not_run_broad_repository_file_enumeration_before_declared_targets"));
  assert.ok(packet.action_discipline.prohibited_actions.includes("do_not_read_general_skill_or_preference_files_before_declared_targets"));
  assert.ok(packet.action_discipline.stop_conditions.includes("stop_after_required_validation_passes_and_report_evidence"));
  assert.match(markdown, /Runtime contract:/);
  assert.match(markdown, /Action discipline:/);
  assert.match(markdown, /execution_mode: contract_locked/);
  assert.match(markdown, /target_files: scripts\/server\.mjs/);
  assert.doesNotMatch(markdown, /Inspect service entrypoint/);
  assert.doesNotMatch(markdown, /prefer nohup/);
});

test("execution agent contract packet can render a short agent-facing contract", () => {
  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "service_publish_validate",
    target_files: ["scripts/server.mjs"],
    next_action: "Launch the service detached and probe /healthz from a fresh shell.",
    workflow_steps: [
      "Inspect service entrypoint.",
      "Launch detached with redirected stdio.",
      "Probe from a fresh shell.",
    ],
    pattern_hints: ["prefer nohup over foreground child processes"],
    service_lifecycle_constraints: [serviceConstraint("runtime-service")],
    acceptance_checks: ["curl -fsS http://127.0.0.1:4199/healthz"],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: "anchor_service",
      evidence_refs: ["evidence:service"],
      notes: ["compiled from failed service trajectory"],
    },
  });

  const packet = buildExecutionAgentContractPacketV1({
    contract,
    task_prompt: "Keep the service alive after worker exit.",
  });
  const operatorMarkdown = renderExecutionAgentContractPacketMarkdown(packet);
  const agentMarkdown = renderExecutionAgentContractPacketMarkdown(packet, { audience: "agent_minimal" });
  const rendered = agentMarkdown.join("\n");

  assert.ok(agentMarkdown.length < operatorMarkdown.length);
  assert.match(rendered, /Runtime contract:/);
  assert.match(rendered, /Execution boundary:/);
  assert.match(rendered, /target_files: scripts\/server\.mjs/);
  assert.match(rendered, /next_action: Launch the service detached/);
  assert.match(rendered, /acceptance_checks: curl -fsS http:\/\/127\.0\.0\.1:4199\/healthz/);
  assert.match(rendered, /must_survive_agent_exit/);
  assert.match(rendered, /authority_boundary: success_requires_declared_acceptance_checks/);
  assert.match(rendered, /do_not_run_broad_repository_file_enumeration_before_declared_targets/);
  assert.match(rendered, /stop_after_required_validation_passes_and_report_evidence/);
  assert.doesNotMatch(rendered, /task_prompt:/);
  assert.doesNotMatch(rendered, /Action discipline:/);
  assert.doesNotMatch(rendered, /first_action:/);
  assert.doesNotMatch(rendered, /allowed_work_surface:/);
  assert.doesNotMatch(rendered, /Inspect service entrypoint/);
  assert.doesNotMatch(rendered, /prefer nohup/);
});

test("execution agent contract packet expands only when compact contract is insufficient or failed", () => {
  const completeContract = buildExecutionContractFromProjection({
    task_family: "ai_code_ci_repair",
    target_files: ["src/pricing/discount.mjs", "tests/pricing/discount.test.mjs"],
    next_action: "Patch discount behavior and run the targeted pricing test.",
    workflow_steps: ["Read the failing test.", "Patch the implementation.", "Run the targeted test."],
    pattern_hints: ["avoid editing tests as success evidence"],
    acceptance_checks: ["npm test -- tests/pricing/discount.test.mjs"],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });
  const failedPacket = buildExecutionAgentContractPacketV1({
    contract: completeContract,
    verification_failed: true,
  });

  assert.equal(failedPacket.mode, "workflow_expanded");
  assert.equal(failedPacket.action_discipline.execution_mode, "exploratory_allowed");
  assert.ok(failedPacket.expanded);
  assert.deepEqual(failedPacket.expanded.workflow_steps, completeContract.workflow_steps);
  assert.ok(failedPacket.escalation.reasons.includes("verification_failed"));

  const incompleteContract = buildExecutionContractFromProjection({
    task_family: "ai_code_ci_repair",
    target_files: [],
    next_action: null,
    acceptance_checks: [],
    workflow_steps: ["Inspect the failing area before patching."],
    provenance: {
      source_kind: "manual_context",
      source_summary_version: null,
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });
  const insufficientPacket = buildExecutionAgentContractPacketV1({ contract: incompleteContract });

  assert.equal(insufficientPacket.mode, "workflow_expanded");
  assert.equal(insufficientPacket.action_discipline.execution_mode, "exploratory_allowed");
  assert.equal(insufficientPacket.action_discipline.max_pre_edit_confirmation_steps, null);
  assert.ok(insufficientPacket.escalation.reasons.includes("compact_contract_missing_target_files"));
  assert.ok(insufficientPacket.escalation.reasons.includes("compact_contract_missing_next_action"));
  assert.ok(insufficientPacket.escalation.reasons.includes("compact_contract_missing_acceptance_checks"));
});

test("execution agent contract packet marks acceptance evidence read-only under locked contracts", () => {
  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "ai_code_ci_repair",
    target_files: ["src/pricing/discount.mjs", "tests/pricing/discount.test.mjs"],
    next_action: "Patch discount behavior and run the targeted pricing test.",
    acceptance_checks: ["npm test -- tests/pricing/discount.test.mjs"],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });

  const packet = buildExecutionAgentContractPacketV1({ contract });

  assert.equal(packet.action_discipline.execution_mode, "contract_locked");
  assert.equal(packet.action_discipline.max_pre_edit_confirmation_steps, 3);
  assert.ok(packet.action_discipline.prohibited_actions.includes(
    "do_not_edit_acceptance_evidence:tests/pricing/discount.test.mjs",
  ));
  assert.ok(packet.action_discipline.allowed_work_surface.includes("src/pricing/discount.mjs"));
  assert.ok(packet.action_discipline.allowed_work_surface.includes("validation:npm test -- tests/pricing/discount.test.mjs"));
});

test("execution agent contract packet separates package validation transport from service lifecycle", () => {
  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "package_publish_validate",
    target_files: ["scripts/build_index.py", "src/vectorops/__init__.py"],
    next_action: "Fix the package artifact, payload, and simple-index outputs.",
    acceptance_checks: [
      "curl -fsS <fresh-shell-endpoint>/simple/vectorops/",
      "pip install --index-url <fresh-shell-endpoint>/simple vectorops==0.1.0",
      "python -c \"import vectorops; assert vectorops.ping() == 'vectorops-live'\"",
    ],
    external_visibility_requirements: [
      "package_install_visible_to_clean_client",
      "installed_api_visible_to_clean_client",
    ],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });

  const packet = buildExecutionAgentContractPacketV1({ contract });
  const markdown = renderExecutionAgentContractPacketMarkdown(packet).join("\n");

  assert.equal(packet.action_discipline.execution_mode, "contract_locked");
  assert.deepEqual(packet.contract.lifecycle_constraints, [
    "package_install_visible_to_clean_client",
    "installed_api_visible_to_clean_client",
  ]);
  assert.ok(packet.contract.validation_boundary.includes(
    "fresh_shell_endpoint_placeholder_is_verifier_owned_not_an_agent_discovery_target",
  ));
  assert.ok(packet.contract.validation_boundary.includes(
    "package_index_http_server_is_validation_transport_not_product_service",
  ));
  assert.ok(packet.contract.validation_boundary.includes(
    "final_clean_client_fresh_shell_install_is_owned_by_external_verifier",
  ));
  assert.ok(packet.contract.authority_boundary.includes(
    "fresh_shell_endpoint_placeholder_must_not_trigger_endpoint_discovery",
  ));
  assert.ok(packet.action_discipline.prohibited_actions.includes(
    "do_not_discover_or_probe_random_fresh_shell_endpoints",
  ));
  assert.ok(packet.action_discipline.prohibited_actions.includes(
    "do_not_treat_package_index_http_transport_as_service_lifecycle",
  ));
  assert.ok(packet.action_discipline.stop_conditions.includes(
    "do_not_search_for_placeholder_fresh_shell_endpoint; external_verifier_owns_final_fresh_shell_probe",
  ));
  assert.match(markdown, /validation_boundary:/);
  assert.match(markdown, /fresh_shell_endpoint_placeholder_is_verifier_owned_not_an_agent_discovery_target/);
});

test("execution agent contract packet separates deploy visibility from webserver lifecycle", () => {
  const contract = buildExecutionContractFromProjection({
    contract_trust: "authoritative",
    task_family: "git_deploy_webserver",
    target_files: ["hooks/post-receive", "www/main/index.html", "site/index.html"],
    next_action: "Repair hooks/post-receive so it publishes the deployed revision into www/main/index.html.",
    acceptance_checks: ["curl -fsS <fresh-shell-endpoint>/index.html"],
    external_visibility_requirements: [
      "served_web_content_matches_deployed_revision",
    ],
    provenance: {
      source_kind: "trajectory_compile",
      source_summary_version: "trajectory_compile_v1",
      source_anchor: null,
      evidence_refs: [],
      notes: [],
    },
  });

  const packet = buildExecutionAgentContractPacketV1({ contract });
  const markdown = renderExecutionAgentContractPacketMarkdown(packet).join("\n");

  assert.equal(packet.action_discipline.execution_mode, "contract_locked");
  assert.deepEqual(packet.contract.lifecycle_constraints, [
    "served_web_content_matches_deployed_revision",
  ]);
  assert.ok(packet.contract.validation_boundary.includes(
    "served_web_endpoint_is_external_visibility_boundary",
  ));
  assert.ok(packet.contract.validation_boundary.includes(
    "git_or_hook_success_is_not_served_content_proof",
  ));
  assert.ok(packet.contract.validation_boundary.includes(
    "do_not_manage_webserver_lifecycle_without_declared_service_constraint",
  ));
  assert.ok(packet.contract.authority_boundary.includes(
    "deploy_claim_requires_served_endpoint_content_match",
  ));
  assert.ok(packet.action_discipline.prohibited_actions.includes(
    "do_not_claim_success_from_git_or_hook_exit_without_served_endpoint_probe",
  ));
  assert.ok(packet.action_discipline.prohibited_actions.includes(
    "do_not_restart_or_reconfigure_webserver_without_declared_lifecycle_target",
  ));
  assert.ok(packet.action_discipline.stop_conditions.includes(
    "after_served_endpoint_matches_deployed_revision_do_not_keep_reworking_hook_or_webserver",
  ));
  assert.match(markdown, /validation_boundary:/);
  assert.match(markdown, /git_or_hook_success_is_not_served_content_proof/);
});
