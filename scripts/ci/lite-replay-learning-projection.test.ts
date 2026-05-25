import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildReplayLearningProjectionArtifacts, buildReplayLearningProjectionDefaults } from "../../src/memory/replay-learning.ts";

function baseSource(playbookSlotOverrides: Record<string, unknown> = {}) {
  return {
    tenant_id: "default",
    scope: "default",
    scope_key: "default",
    actor: "local-user",
    playbook_id: randomUUID(),
    playbook_version: 2,
    playbook_node_id: randomUUID(),
    playbook_title: "Fix export failure",
    playbook_summary: "Replay repair learning episode for export failure",
    playbook_slots: {
      matchers: {
        task_kind: "repair_export",
      },
      source_run_id: randomUUID(),
      created_from_run_ids: [randomUUID()],
      steps_template: [
        {
          step_index: 1,
          tool_name: "edit",
          preconditions: [],
          postconditions: [],
          safety_level: "needs_confirm",
        },
        {
          step_index: 2,
          tool_name: "test",
          preconditions: [],
          postconditions: [],
          safety_level: "observe_only",
        },
      ],
      ...playbookSlotOverrides,
    },
    source_commit_id: randomUUID(),
    metrics: {
      total_steps: 2,
      success_ratio: 1,
    },
  };
}

test("replay-learning projection artifacts produce candidate workflow before promotion threshold", () => {
  const source = baseSource();
  const projectedAt = "2026-03-20T00:00:00Z";
  const defaults = buildReplayLearningProjectionDefaults({
    enabled: true,
    mode: "rule_and_episode",
    delivery: "sync_inline",
    targetRuleState: "draft",
    minTotalSteps: 1,
    minSuccessRatio: 1,
    maxMatcherBytes: 4096,
    maxToolPrefer: 8,
    episodeTtlDays: 30,
  });
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: false,
    observedWorkflowCount: defaults.min_total_steps,
    projectedAt,
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId);
  assert.ok(episode);
  assert.equal(plan.shouldPromoteStableWorkflow, false);
  assert.equal(episode?.type, "event");
  assert.equal(episode?.slots?.summary_kind, "workflow_candidate");
  assert.equal(episode?.slots?.execution_contract_v1?.schema_version, "execution_contract_v1");
  assert.equal(episode?.slots?.execution_contract_v1?.workflow_signature, "replay-learning-workflow-sig");
  assert.equal(episode?.slots?.execution_native_v1?.execution_kind, "workflow_candidate");
  assert.equal(episode?.slots?.execution_native_v1?.workflow_promotion?.promotion_state, "candidate");
  assert.equal(episode?.slots?.execution_native_v1?.workflow_promotion?.observed_count, 1);
  assert.equal(episode?.slots?.execution_native_v1?.distillation?.distillation_origin, "replay_learning_episode");
  assert.equal(episode?.slots?.execution_native_v1?.distillation?.preferred_promotion_target, "workflow");
  assert.equal(workflow, undefined);
});

test("replay-learning projection artifacts auto-promote to stable workflow when observation threshold, outcome gate, and explicit evidence are met", () => {
  const source = baseSource({
    contract_trust: "authoritative",
    task_family: "task:repair_export",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    acceptance_checks: ["npm run -s test:lite -- export"],
    success_invariants: ["all_acceptance_checks_pass"],
    execution_evidence_v1: {
      validation_passed: true,
      evidence_refs: ["test:replay-learning:export-validation"],
    },
  });
  const projectedAt = "2026-03-20T00:00:00Z";
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt,
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId) as Record<string, any> | undefined;
  assert.ok(episode);
  assert.ok(workflow);
  assert.equal(plan.shouldPromoteStableWorkflow, true);
  assert.equal(episode?.type, "event");
  assert.equal(episode?.slots?.summary_kind, "replay_learning_episode");
  assert.equal(episode?.slots?.execution_native_v1, undefined);
  assert.equal(workflow?.type, "procedure");
  assert.equal(workflow?.slots?.summary_kind, "workflow_anchor");
  assert.equal(workflow?.slots?.execution_contract_v1?.schema_version, "execution_contract_v1");
  assert.equal(workflow?.slots?.execution_contract_v1?.workflow_signature, "replay-learning-workflow-sig");
  assert.equal(workflow?.slots?.execution_native_v1?.execution_kind, "workflow_anchor");
  assert.equal(workflow?.slots?.execution_native_v1?.workflow_promotion?.promotion_origin, "replay_learning_auto_promotion");
  assert.equal(workflow?.slots?.execution_native_v1?.workflow_promotion?.promotion_state, "stable");
  assert.equal(workflow?.slots?.execution_native_v1?.workflow_promotion?.observed_count, 2);
  assert.equal(workflow?.slots?.execution_native_v1?.workflow_promotion?.required_observations, 2);
  assert.equal(workflow?.slots?.execution_native_v1?.distillation?.distillation_origin, "replay_learning_episode");
  assert.equal(workflow?.slots?.execution_native_v1?.distillation?.preferred_promotion_target, "workflow");
  assert.equal(workflow?.slots?.outcome_contract_gate?.allows_authoritative, true);
  assert.ok(plan.edges.some((edge) => (edge as any).src?.client_id === plan.workflowClientId && (edge as any).dst?.client_id === plan.episodeClientId));
});

test("replay-learning projection artifacts do not auto-promote stable workflow from metrics-only evidence", () => {
  const source = baseSource({
    contract_trust: "authoritative",
    task_family: "task:repair_export",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun export tests.",
    acceptance_checks: ["npm run -s test:lite -- export"],
    success_invariants: ["all_acceptance_checks_pass"],
  });
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt: "2026-03-20T00:00:00Z",
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId);
  assert.ok(episode);
  assert.equal(plan.shouldPromoteStableWorkflow, false);
  assert.equal(workflow, undefined);
  assert.equal(episode?.slots?.summary_kind, "workflow_candidate");
  assert.equal(episode?.slots?.execution_contract_v1?.contract_trust, "advisory");
  assert.equal(episode?.slots?.execution_evidence_assessment?.status, "incomplete");
  assert.equal(episode?.slots?.execution_evidence_assessment?.allows_stable_promotion, false);
  assert.ok(episode?.slots?.execution_evidence_assessment?.reasons?.includes("missing_explicit_execution_evidence"));
});

test("replay-learning projection artifacts do not auto-promote stable workflow without outcome contract", () => {
  const source = baseSource();
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt: "2026-03-20T00:00:00Z",
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId);
  assert.ok(episode);
  assert.equal(plan.shouldPromoteStableWorkflow, false);
  assert.equal(workflow, undefined);
  assert.equal(episode?.slots?.summary_kind, "workflow_candidate");
  assert.equal(episode?.slots?.outcome_contract_gate?.status, "insufficient");
  assert.ok(episode?.slots?.outcome_contract_gate?.reasons?.includes("missing_verifiable_success_outcome"));
});

test("replay-learning projection artifacts keep low-trust workflows at candidate level", () => {
  const source = baseSource({
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: "execution_native",
      summary_kind: "handoff",
      compression_layer: "L0",
      contract_trust: "advisory",
      task_family: "service_publish_validate",
      target_files: ["scripts/build_and_serve.py"],
      next_action: "Restart the package index and revalidate from a fresh shell.",
    },
  });
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt: "2026-03-20T00:00:00Z",
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId);
  assert.ok(episode);
  assert.equal(plan.shouldPromoteStableWorkflow, false);
  assert.equal(workflow, undefined);
  assert.equal(episode?.slots?.summary_kind, "workflow_candidate");
  assert.equal(episode?.slots?.execution_contract_v1?.contract_trust, "advisory");
  assert.equal(episode?.slots?.execution_native_v1?.contract_trust, "advisory");
  assert.equal(episode?.slots?.execution_native_v1?.workflow_promotion?.promotion_state, "candidate");
});

test("replay-learning projection artifacts preserve richer recovery contract fields", () => {
  const source = baseSource({
    contract_trust: "authoritative",
    task_family: "service_publish_validate",
    target_files: ["scripts/build_and_serve.py", "pyproject.toml"],
    next_action: "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
    workflow_steps: [
      "python scripts/build_and_serve.py --port 8080",
      "curl http://localhost:8080/simple/vectorops/",
    ],
    pattern_hints: [
      "publish_then_install_from_clean_client_path",
      "revalidate_service_from_fresh_shell",
    ],
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "http",
        label: "service:http://localhost:8080/simple/vectorops/",
        launch_reference: "python scripts/build_and_serve.py --port 8080",
        endpoint: "http://localhost:8080/simple/vectorops/",
        must_survive_agent_exit: true,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: ["curl http://localhost:8080/simple/vectorops/"],
        teardown_notes: [],
      },
    ],
    execution_native_v1: {
      schema_version: "execution_native_v1",
      execution_kind: "execution_native",
      summary_kind: "handoff",
      compression_layer: "L0",
      contract_trust: "authoritative",
      task_family: "service_publish_validate",
      target_files: ["scripts/build_and_serve.py", "pyproject.toml"],
      next_action: "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
      workflow_steps: [
        "python scripts/build_and_serve.py --port 8080",
        "pip install --index-url http://localhost:8080/simple vectorops==0.1.0",
      ],
      pattern_hints: [
        "publish_then_install_from_clean_client_path",
        "revalidate_service_from_fresh_shell",
      ],
      service_lifecycle_constraints: [
        {
          version: 1,
          service_kind: "http",
          label: "service:http://localhost:8080/simple/vectorops/",
          launch_reference: "python scripts/build_and_serve.py --port 8080",
          endpoint: "http://localhost:8080/simple/vectorops/",
          must_survive_agent_exit: true,
          revalidate_from_fresh_shell: true,
          detach_then_probe: true,
          health_checks: ["curl http://localhost:8080/simple/vectorops/"],
          teardown_notes: [],
        },
      ],
    },
    execution_result_summary: {
      trajectory_compile_v1: {
        task_family: "service_publish_validate",
      },
    },
    execution_evidence_v1: {
      validation_passed: true,
      after_exit_revalidated: true,
      fresh_shell_probe_passed: true,
      validation_boundary: "external_verifier",
      evidence_refs: ["test:replay-learning:fresh-shell-install"],
    },
  });
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt: "2026-03-20T00:00:00Z",
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId) as Record<string, any> | undefined;
  assert.ok(workflow);
  assert.equal(workflow?.slots?.execution_contract_v1?.schema_version, "execution_contract_v1");
  assert.equal(workflow?.slots?.execution_contract_v1?.contract_trust, "authoritative");
  assert.equal(workflow?.slots?.execution_contract_v1?.task_family, "service_publish_validate");
  assert.deepEqual(workflow?.slots?.execution_contract_v1?.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
  assert.equal(workflow?.slots?.anchor_v1?.contract_trust, "authoritative");
  assert.equal(workflow?.slots?.anchor_v1?.task_family, "service_publish_validate");
  assert.deepEqual(workflow?.slots?.anchor_v1?.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
  assert.equal(
    workflow?.slots?.anchor_v1?.next_action,
    "Update scripts/build_and_serve.py, restart the package index, and rerun validation from a fresh shell.",
  );
  assert.ok(workflow?.slots?.anchor_v1?.key_steps?.includes("python scripts/build_and_serve.py --port 8080"));
  assert.ok(workflow?.slots?.anchor_v1?.pattern_hints?.includes("revalidate_service_from_fresh_shell"));
  assert.equal(workflow?.slots?.anchor_v1?.service_lifecycle_constraints?.[0]?.must_survive_agent_exit, true);
  assert.equal(workflow?.slots?.execution_native_v1?.contract_trust, "authoritative");
  assert.equal(workflow?.slots?.execution_native_v1?.task_family, "service_publish_validate");
  assert.deepEqual(workflow?.slots?.execution_native_v1?.target_files, ["scripts/build_and_serve.py", "pyproject.toml"]);
  assert.ok(workflow?.slots?.execution_native_v1?.workflow_steps?.includes("python scripts/build_and_serve.py --port 8080"));
  assert.ok(workflow?.slots?.execution_native_v1?.pattern_hints?.includes("publish_then_install_from_clean_client_path"));
  assert.equal(workflow?.slots?.execution_native_v1?.service_lifecycle_constraints?.[0]?.revalidate_from_fresh_shell, true);
  assert.equal(workflow?.slots?.execution_evidence_assessment?.allows_stable_promotion, true);
});

test("replay-learning projection artifacts keep failed after-exit evidence at advisory candidate level", () => {
  const source = baseSource({
    contract_trust: "authoritative",
    task_family: "service_publish_validate",
    target_files: ["scripts/build_and_serve.py"],
    next_action: "Restart the package index and rerun validation from a fresh shell.",
    acceptance_checks: ["curl http://localhost:8080/simple/vectorops/"],
    success_invariants: ["fresh_shell_revalidation_passes"],
    must_hold_after_exit: ["service_endpoint_still_serves_after_exit:http://localhost:8080/simple/vectorops/"],
    external_visibility_requirements: ["endpoint_reachable:http://localhost:8080/simple/vectorops/"],
    service_lifecycle_constraints: [
      {
        version: 1,
        service_kind: "http",
        label: "service:http://localhost:8080/simple/vectorops/",
        launch_reference: "nohup python scripts/build_and_serve.py --port 8080 >/tmp/index.log 2>&1 &",
        endpoint: "http://localhost:8080/simple/vectorops/",
        must_survive_agent_exit: true,
        revalidate_from_fresh_shell: true,
        detach_then_probe: true,
        health_checks: ["curl http://localhost:8080/simple/vectorops/"],
        teardown_notes: [],
      },
    ],
    execution_evidence_v1: {
      validation_passed: true,
      after_exit_revalidated: false,
      fresh_shell_probe_passed: false,
      failure_reason: "fresh_shell_probe_connection_refused_after_agent_exit",
      false_confidence_detected: true,
      evidence_refs: ["test:replay-learning:failed-fresh-shell-probe"],
    },
  });
  const plan = buildReplayLearningProjectionArtifacts({
    source,
    matcherFingerprint: "matcher-fp",
    policyFingerprint: "policy-fp",
    duplicateRuleNodeId: null,
    workflowSignature: "replay-learning-workflow-sig",
    preferTools: ["edit", "test"],
    shouldCreateRule: true,
    shouldCreateEpisode: true,
    shouldPromoteStableWorkflow: true,
    observedWorkflowCount: 2,
    projectedAt: "2026-03-20T00:00:00Z",
    ttlExpiresAt: "2026-04-19T00:00:00Z",
  });

  const episode = plan.nodes.find((node) => node.client_id === plan.episodeClientId) as Record<string, any> | undefined;
  const workflow = plan.nodes.find((node) => node.client_id === plan.workflowClientId);
  assert.ok(episode);
  assert.equal(plan.shouldPromoteStableWorkflow, false);
  assert.equal(workflow, undefined);
  assert.equal(episode?.slots?.summary_kind, "workflow_candidate");
  assert.equal(episode?.slots?.execution_contract_v1?.contract_trust, "advisory");
  assert.equal(episode?.slots?.execution_native_v1?.contract_trust, "advisory");
  assert.equal(episode?.slots?.execution_native_v1?.workflow_promotion?.promotion_state, "candidate");
  assert.equal(episode?.slots?.execution_evidence_assessment?.status, "failed");
  assert.equal(episode?.slots?.execution_evidence_assessment?.allows_stable_promotion, false);
  assert.ok(episode?.slots?.execution_evidence_assessment?.reasons?.includes("after_exit_revalidation_failed"));
});
