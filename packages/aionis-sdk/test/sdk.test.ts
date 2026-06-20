import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRouteTargetsFromGuide,
  agentPromptFromGuide,
  blockedDirectionRouteTargetsFromGuide,
  blockedRoutesFromGuide,
  commandPostureFromGuide,
  commandPostureMemoryIdsFromGuide,
  compileCodingAgentContext,
  compileExecutionAgentContext,
  createAionisClient,
  evidenceSourcesFromGuide,
  feedbackFromGuide,
  inspectFirstMemoryIdsFromGuide,
  mem0SearchResultsToAionisCandidates,
  memoryAdmissionDatasetJsonlFromGuide,
  memoryAdmissionDatasetRowsFromGuide,
  memoryAdmissionRecordFromGuide,
  memoryIdsFromGuide,
  memoryUseReceiptFromGuide,
  mustNotMemoryIdsFromGuide,
  pendingArtifactTargetsFromGuide,
  planAssetObserveEvents,
  referenceOnlyRouteTargetsFromGuide,
  rehydrateHintsFromGuide,
  routeContractFromGuide,
  shouldContinueMemoryIdsFromGuide,
} from "../src/index.ts";

test("@aionis/sdk wraps product facade routes", async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001/",
    apiKey: "test-key",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.guide({ query_text: "continue" });
  await client.governMemory({
    query_text: "Govern external candidates.",
    candidates: [
      {
        external_memory_id: "mem0:current",
        source_backend: "mem0",
        text: "Current project state.",
      },
    ],
  });
  await client.governMem0SearchResults({
    query_text: "Govern Mem0 search results.",
    mem0_results: {
      results: [
        {
          id: "row-1",
          memory: "Current route from Mem0.",
          metadata: {
            external_memory_id: "mem0:row-1",
            lifecycle_hint: "current",
            authority_source_trust: "trusted",
            authority_scope: "project",
            authority_evidence_requirement: "none",
          },
        },
      ],
    },
  });
  await client.feedback({
    reason: "used memory",
    run_id: "run-1",
    outcome: "positive",
    used_surface: "use_now",
    used_memory_ids: ["mem-1"],
  });
  await client.snapshot({ run_id: "run-1" });
  await client.flightRecorder({
    run_id: "run-1",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      memory_ids: ["mem-1"],
    },
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/memory/govern",
    "http://127.0.0.1:3001/v1/memory/govern",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/operator/snapshot",
    "http://127.0.0.1:3001/v1/audit/flight-recorder",
  ]);
  assert.equal(calls[0]?.body.tenant_id, "tenant-a");
  assert.equal(calls[0]?.body.scope, "scope-a");
  assert.equal(calls[0]?.body.mode, "full_power");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer test-key");
  assert.equal(calls[0]?.headers.get("x-api-key"), "test-key");
  assert.equal(calls[1]?.body.tenant_id, "tenant-a");
  assert.equal(calls[1]?.body.scope, "scope-a");
  assert.equal(calls[1]?.body.query_text, "Govern external candidates.");
  assert.equal(calls[2]?.body.tenant_id, "tenant-a");
  assert.equal(calls[2]?.body.scope, "scope-a");
  assert.equal(calls[2]?.body.query_text, "Govern Mem0 search results.");
  assert.equal(calls[2]?.body.mode, "firewall");
  assert.equal(calls[2]?.body.context_mode, "compact_agent");
  assert.equal(calls[2]?.body.include_records, true);
  assert.equal((calls[2]?.body.candidates as Array<Record<string, unknown>>)[0]?.external_memory_id, "mem0:row-1");
  assert.equal(calls[5]?.body.tenant_id, "tenant-a");
  assert.equal(calls[5]?.body.scope, "scope-a");
  assert.equal(calls[5]?.body.run_id, "run-1");
});

test("@aionis/sdk maps Mem0 search results to backend-agnostic admission candidates", () => {
  const candidates = mem0SearchResultsToAionisCandidates({
    results: [
      {
        id: "mem0-row-current",
        memory: "Current accepted target is packages/api/src/checkout.ts.",
        score: 0.92,
        metadata: {
          external_memory_id: "mem0:checkout:current-route",
          title: "Current checkout route",
          target_files_json: "[\"packages/api/src/checkout.ts\"]",
          evidence_refs_json: "[\"mem0://checkout/current-route\"]",
          lifecycle_hint: "current",
          authority_source_trust: "trusted",
          authority_scope: "project",
          authority_evidence_requirement: "none",
        },
      },
      {
        id: "mem0-row-unsafe",
        memory: "Legacy checkout rewrite failed verifier checks.",
      },
    ],
  });

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0], {
    external_memory_id: "mem0:checkout:current-route",
    source_backend: "mem0",
    text: "Current accepted target is packages/api/src/checkout.ts.",
    metadata: {
      external_memory_id: "mem0:checkout:current-route",
      title: "Current checkout route",
      target_files_json: "[\"packages/api/src/checkout.ts\"]",
      evidence_refs_json: "[\"mem0://checkout/current-route\"]",
      lifecycle_hint: "current",
      authority_source_trust: "trusted",
      authority_scope: "project",
      authority_evidence_requirement: "none",
      target_files: ["packages/api/src/checkout.ts"],
      mem0_score: 0.92,
      mem0_row_id: "mem0-row-current",
    },
    authority: {
      source_trust: "trusted",
      scope: "project",
      evidence_requirement: "none",
    },
    lifecycle_hint: "current",
    evidence_refs: ["mem0://checkout/current-route"],
  });
  assert.equal(candidates[1]?.external_memory_id, "mem0:mem0-row-unsafe");
  assert.deepEqual(candidates[1]?.authority, {
    source_trust: "unknown",
    scope: "unknown",
    evidence_requirement: "inspect_before_use",
  });
  assert.equal(candidates[1]?.lifecycle_hint, "unknown");
});

test("@aionis/sdk builds plan asset observe events", () => {
  const events = planAssetObserveEvents({
    run_id: "run-plan-1",
    task_signature: "feature-flag-service",
    task_family: "coding",
    workflow_signature: "planner-worker-demo",
    planner: {
      agent_id: "planner-claude",
      model: "strong-planner-model",
    },
    plan: {
      title: "Feature flag service plan",
      summary: "Build sticky rollout evaluation with audit logging.",
      artifact_ref: "plan.md",
      decisions: [
        {
          decision_id: "decision:bucket-math",
          statement: "Use deterministic 10,000 bucket hashing by flag key and user id.",
          rationale: "Growing rollout percentages preserves already-enabled users.",
          target_files: ["packages/api/src/flags.ts"],
        },
      ],
      acceptance_checks: [
        "same user gets same result across repeated calls",
        "20% to 40% rollout preserves original 20%",
      ],
      execution_boundaries: [
        "do not store per-user rollout state",
        "do not store plaintext API keys",
      ],
      failed_branches: [
        {
          branch_id: "failed:random-rollout",
          statement: "Random per-request rollout assignment is invalid.",
          reason: "It violates sticky rollout.",
          target_files: ["packages/api/src/random-rollout.ts"],
        },
      ],
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.role, "planner");
  assert.equal(events[0]?.outcome, "succeeded");
  assert.deepEqual(events[0]?.target_files, ["packages/api/src/flags.ts"]);
  assert.deepEqual(events[0]?.acceptance_checks?.slice(0, 1), [
    "same user gets same result across repeated calls",
  ]);
  assert.match(events[0]?.summary ?? "", /PLAN_AS_MEMORY_ASSET/);
  assert.match(events[0]?.summary ?? "", /PLAN_DECISION decision:bucket-math/);
  assert.match(events[0]?.summary ?? "", /PLAN_ACCEPTANCE_CHECK 1/);
  assert.match(events[0]?.summary ?? "", /PLAN_EXECUTION_BOUNDARY 1/);
  assert.equal((events[0]?.slots?.plan_asset_v1 as Record<string, unknown>)?.planner_model, "strong-planner-model");

  assert.equal(events[1]?.outcome, "failed");
  assert.equal(events[1]?.title, "Rejected plan branch: failed:random-rollout");
  assert.deepEqual(events[1]?.target_files, ["packages/api/src/random-rollout.ts"]);
  assert.match(events[1]?.summary ?? "", /counter-evidence/);
  assert.equal((events[1]?.slots?.plan_asset_v1 as Record<string, unknown>)?.rejected_branch_id, "failed:random-rollout");
});

test("@aionis/sdk guide helpers keep Agent prompt and feedback attribution bounded", () => {
  const guide = {
    guide_trace_id: "guide-1",
    consumer_agent_id: "sdk-agent",
    agent_context: {
      contract_version: "aionis_agent_context_v1",
      prompt_text: "AIONIS_CTX v2\ncurrent: n=Use scoped memory.",
      memory_ids: ["mem-1"],
      use_now_memory_ids: ["mem-1"],
      inspect_before_use_memory_ids: ["mem-2"],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-1",
          instruction: "Continue the current branch.",
          reason: "The branch is active.",
          target_files: ["src/a.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-3",
          instruction: "Do not reuse the failed branch.",
          reason: "The branch failed verification.",
          target_files: ["src/old.ts"],
        },
        {
          posture: "inspect_first",
          surface: "inspect_before_use",
          memory_id: "mem-2",
          instruction: "Inspect before relying on this candidate.",
          reason: "The memory is candidate-only.",
          target_files: [],
        },
      ],
      route_contract: {
        active_targets: [
          {
            target: "src/a.ts",
            source_memory_id: "mem-1",
            source: "should_continue",
            artifact_status: "may_be_absent",
            missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          },
        ],
        pending_artifacts: [
          {
            target: "src/a.ts",
            source_memory_id: "mem-1",
            source: "should_continue",
            status: "unknown_until_host_observation",
            when: "if_active_target_is_missing",
            allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
            preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
            terminal_inspect_allowed: false,
          },
        ],
        reference_only_targets: [
          {
            target: "src/candidate.ts",
            source_memory_id: "mem-2",
            source: "inspect_first",
          },
        ],
        blocked_direction_targets: [
          {
            target: "src/old.ts",
            source_memory_id: "mem-3",
            source: "must_not",
          },
        ],
        evidence_sources: [
          {
            target: "src/candidate.ts",
            source_memory_id: "mem-2",
            source: "inspect_first",
            evidence_use: "reference_only",
            direction_policy: "must_not_be_primary_route",
          },
        ],
        blocked_routes: [
          {
            target: "src/old.ts",
            source_memory_id: "mem-3",
            source: "must_not",
            direction_policy: "blocked_route",
            evidence_use: "counter_evidence_only",
          },
        ],
        fallback_policy: "do_not_promote_reference_or_blocked_targets",
      },
    },
    memory_packet: {
      raw: "operator-only",
    },
  };

  assert.equal(agentPromptFromGuide(guide), "AIONIS_CTX v2\ncurrent: n=Use scoped memory.");
  assert.deepEqual(memoryIdsFromGuide(guide), ["mem-1", "mem-2", "mem-3"]);
  assert.deepEqual(commandPostureMemoryIdsFromGuide(guide), ["mem-1", "mem-3", "mem-2"]);
  assert.deepEqual(shouldContinueMemoryIdsFromGuide(guide), ["mem-1"]);
  assert.deepEqual(mustNotMemoryIdsFromGuide(guide), ["mem-3"]);
  assert.deepEqual(inspectFirstMemoryIdsFromGuide(guide), ["mem-2"]);
  assert.deepEqual(commandPostureFromGuide(guide, "must_not")[0]?.instruction, "Do not reuse the failed branch.");
  assert.equal(routeContractFromGuide(guide)?.conflict_policy, "do_not_treat_missing_active_target_as_superseded");
  assert.equal(routeContractFromGuide(guide)?.fallback_policy, "do_not_promote_reference_or_blocked_targets");
  assert.deepEqual(routeContractFromGuide(guide)?.action_policy.missing_active_target_preferred_order, ["create", "restore", "rehydrate", "report_conflict"]);
  assert.equal(routeContractFromGuide(guide)?.pending_artifacts[0]?.terminal_inspect_allowed, false);
  assert.equal(routeContractFromGuide(guide)?.pending_artifacts[0]?.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
  assert.equal(routeContractFromGuide(guide)?.pending_artifacts[0]?.report_conflict_requires, "rehydrate_unavailable_or_evidence_conflict");
  assert.equal(routeContractFromGuide(guide)?.action_policy.executable_evidence_policy, "route_safe_but_patch_may_require_rehydrate");
  assert.equal(routeContractFromGuide(guide)?.action_policy.after_rehydrate_policy, "continue_allowed_action_if_task_consistent");
  assert.equal(routeContractFromGuide(guide)?.action_policy.report_conflict_requires, "rehydrate_unavailable_or_evidence_conflict");
  assert.deepEqual(activeRouteTargetsFromGuide(guide), ["src/a.ts"]);
  assert.deepEqual(pendingArtifactTargetsFromGuide(guide), ["src/a.ts"]);
  assert.deepEqual(referenceOnlyRouteTargetsFromGuide(guide), ["src/candidate.ts"]);
  assert.deepEqual(blockedDirectionRouteTargetsFromGuide(guide), ["src/old.ts"]);
  assert.deepEqual(evidenceSourcesFromGuide(guide), [
    {
      target: "src/candidate.ts",
      source_memory_id: "mem-2",
      source: "inspect_first",
      evidence_use: "reference_only",
      direction_policy: "must_not_be_primary_route",
    },
  ]);
  assert.deepEqual(blockedRoutesFromGuide(guide), [
    {
      target: "src/old.ts",
      source_memory_id: "mem-3",
      source: "must_not",
      direction_policy: "blocked_route",
      evidence_use: "counter_evidence_only",
    },
  ]);
  const feedback = feedbackFromGuide({
    guide,
    reason: "Agent used mem-1.",
    run_id: "run-1",
    outcome: "positive",
    used_memory_ids: ["mem-1"],
  });
  assert.equal(feedback.guide_trace_id, "guide-1");
  assert.equal(feedback.actor, "sdk-agent");
  assert.throws(
    () => feedbackFromGuide({
      guide,
      reason: "Agent used an unexposed memory.",
      run_id: "run-1",
      outcome: "positive",
      used_memory_ids: ["mem-4"],
    }),
    /not exposed by guide/,
  );
});

test("@aionis/sdk compiles a contract-style execution Agent context", () => {
  const guide = {
    guide_trace_id: "guide-route-1",
    agent_context: {
      prompt_text: "AIONIS_CTX v2\nuse current branch. inspect legacy branch only as reference.",
      memory_ids: ["mem-current", "mem-inspect", "mem-blocked", "mem-archive"],
      use_now_memory_ids: ["mem-current"],
      inspect_before_use_memory_ids: ["mem-inspect"],
      do_not_use_memory_ids: ["mem-blocked"],
      command_posture: [
        {
          posture: "should_continue",
          surface: "current",
          memory_id: "mem-current",
          instruction: "Continue the bundledDev migration.",
          reason: "Accepted active route.",
          target_files: ["packages/vite/src/node/server/bundledDev.ts"],
        },
        {
          posture: "inspect_first",
          surface: "inspect_before_use",
          memory_id: "mem-inspect",
          instruction: "Read fullBundleEnvironment only as legacy reference.",
          reason: "Superseded source path.",
          target_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
        },
        {
          posture: "must_not",
          surface: "do_not_use",
          memory_id: "mem-blocked",
          instruction: "Do not implement the old fullBundleEnvironment route.",
          reason: "Failed branch.",
          target_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
        },
        {
          posture: "rehydrate_first",
          surface: "rehydrate",
          memory_id: "mem-archive",
          instruction: "Rehydrate original patch payload before exact copy.",
          reason: "Compact context may omit long hunks.",
          target_files: ["packages/vite/src/node/server/bundledDev.ts"],
        },
      ],
      route_contract: {
        active_targets: [
          {
            target: "packages/vite/src/node/server/bundledDev.ts",
            source_memory_id: "mem-current",
            source: "should_continue",
            artifact_status: "may_be_absent",
            missing_policy: "restore_or_create_if_task_consistent_or_rehydrate",
          },
        ],
        pending_artifacts: [
          {
            target: "packages/vite/src/node/server/bundledDev.ts",
            source_memory_id: "mem-current",
            source: "should_continue",
            status: "unknown_until_host_observation",
            when: "if_active_target_is_missing",
            allowed_actions: ["create", "restore", "rehydrate", "report_conflict"],
            preferred_action_order: ["create", "restore", "rehydrate", "report_conflict"],
            terminal_inspect_allowed: false,
          },
        ],
        reference_only_targets: [
          {
            target: "packages/vite/src/node/server/environments/fullBundleEnvironment.ts",
            source_memory_id: "mem-inspect",
            source: "inspect_first",
          },
        ],
        blocked_direction_targets: [
          {
            target: "packages/vite/src/node/server/environments/fullBundleEnvironment.ts",
            source_memory_id: "mem-blocked",
            source: "must_not",
          },
        ],
      },
      rehydrate_hints: [
        {
          memory_id: "mem-archive",
          reason: "Exact accepted patch payload is archived.",
          required: true,
        },
      ],
      risk: {
        reasons: ["legacy route is superseded"],
      },
    },
  };

  const compiled = compileExecutionAgentContext({
    guide,
    task: {
      task_signature: "vite-bundled-dev",
      query_text: "Continue the migration.",
    },
    repo_state: {
      missing_files: ["packages/vite/src/node/server/bundledDev.ts"],
      existing_files: ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"],
    },
    budget_profile: "balanced",
  });

  assert.equal(compiled.contract_version, "aionis_execution_agent_context_v1");
  assert.equal(compiled.budget_profile, "balanced");
  assert.deepEqual(compiled.use_now_memory_ids, ["mem-current"]);
  assert.deepEqual(compiled.inspect_before_use_memory_ids, ["mem-inspect"]);
  assert.deepEqual(compiled.do_not_use_memory_ids, ["mem-blocked"]);
  assert.deepEqual(compiled.active_targets, ["packages/vite/src/node/server/bundledDev.ts"]);
  assert.deepEqual(compiled.missing_active_targets, ["packages/vite/src/node/server/bundledDev.ts"]);
  assert.deepEqual(compiled.reference_only_targets, ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"]);
  assert.deepEqual(compiled.blocked_direction_targets, ["packages/vite/src/node/server/environments/fullBundleEnvironment.ts"]);
  assert.equal(compiled.execution_warnings[0]?.code, "missing_active_target");
  assert.match(compiled.agent_prompt, /AIONIS_EXECUTION_AGENT_CONTEXT v1/);
  assert.match(compiled.agent_prompt, /If an active target is missing, treat it as pending work/);
  assert.match(compiled.agent_prompt, /packages\/vite\/src\/node\/server\/bundledDev\.ts/);
  assert.match(compiled.agent_prompt, /BLOCKED_DIRECTION_TARGETS/);
  assert.match(compiled.agent_prompt, /fullBundleEnvironment\.ts/);
  assert.match(compiled.agent_prompt, /BASE_AIONIS_CONTEXT/);
  assert.deepEqual(rehydrateHintsFromGuide(guide), [{
    memory_id: "mem-archive",
    reason: "Exact accepted patch payload is archived.",
    required: true,
  }]);
  assert.equal(memoryUseReceiptFromGuide(guide).agent_prompt_included, false);
  assert.deepEqual(memoryUseReceiptFromGuide(guide).rehydrate_memory_ids, ["mem-archive"]);
  assert.equal(memoryAdmissionRecordFromGuide(guide).contract_version, "aionis_memory_admission_record_v1");
  assert.equal(memoryAdmissionRecordFromGuide(guide).tenant_id, "default");
  assert.equal(memoryAdmissionRecordFromGuide(guide).scope, "default");
  assert.deepEqual(
    memoryAdmissionRecordFromGuide(guide).entries.map((entry) => [entry.memory_id, entry.admission_action]),
    [
      ["mem-current", "use_now"],
      ["mem-inspect", "inspect_before_use"],
      ["mem-blocked", "do_not_use"],
      ["mem-archive", "rehydrate"],
    ],
  );
  assert.equal(compiled.memory_admission_record.contract_version, "aionis_memory_admission_record_v1");
  assert.equal(compiled.memory_admission_record.tenant_id, "default");
  assert.equal(compiled.memory_admission_record.scope, "default");
  assert.equal(compiled.memory_admission_record.candidate_memory_count, 4);

  const coding = compileCodingAgentContext({ guide, include_base_prompt: false, max_prompt_chars: 2_000 });
  assert.equal(coding.base_prompt, guide.agent_context.prompt_text);
  assert.doesNotMatch(coding.agent_prompt, /BASE_AIONIS_CONTEXT/);
});

test("@aionis/sdk exports admission dataset rows and JSONL without prompt payload", () => {
  const guide = {
    memory_decision_trace: {
      admission_record: {
        contract_version: "aionis_memory_admission_record_v1",
        intended_use: "memory_admission_audit_dataset",
        source: "memory_decision_trace",
        agent_prompt_included: false,
        runtime_mutation: false,
        tenant_id: "tenant-a",
        scope: "scope-a",
        guide_trace_id: "guide-dataset-1",
        prompt_char_count: 345,
        history_used: true,
        actionable_history_used: true,
        candidate_memory_count: 4,
        prompt_included_memory_count: 3,
        agent_used_memory_count: 1,
        entries: [
          {
            memory_id: "mem-positive",
            title: "Accepted branch",
            domain: "execution",
            memory_type: "execution_memory",
            lifecycle_state: "active",
            authority: "trusted",
            admission_action: "use_now",
            decision_kind: "used",
            actionable: true,
            prompt_included: true,
            agent_used: true,
            feedback_outcome: "positive",
            attribution_strength: "positive_attribution",
            reason_codes: ["current_active_state"],
            evidence_ids: ["evidence-1"],
          },
          {
            memory_id: "mem-unused",
            title: "Visible but unused",
            domain: "general",
            memory_type: "fact",
            lifecycle_state: "active",
            authority: "advisory",
            admission_action: "inspect_before_use",
            decision_kind: "downgraded",
            actionable: false,
            prompt_included: true,
            agent_used: false,
            feedback_outcome: null,
            attribution_strength: null,
            reason_codes: ["inspect_before_use"],
            evidence_ids: [],
          },
          {
            memory_id: "mem-blocked",
            title: "Blocked stale branch",
            domain: "execution",
            memory_type: "execution_memory",
            lifecycle_state: "contested",
            authority: "blocked",
            admission_action: "do_not_use",
            decision_kind: "blocked",
            actionable: false,
            prompt_included: true,
            agent_used: false,
            feedback_outcome: null,
            attribution_strength: null,
            reason_codes: ["stale_memory"],
            evidence_ids: ["evidence-2"],
          },
          {
            memory_id: "mem-rehydrate",
            title: "Archived patch payload",
            domain: "execution",
            memory_type: "evidence",
            lifecycle_state: "rehydration_candidate",
            authority: "advisory",
            admission_action: "rehydrate",
            decision_kind: "rehydrate",
            actionable: false,
            prompt_included: true,
            agent_used: false,
            feedback_outcome: null,
            attribution_strength: null,
            reason_codes: ["payload_archived"],
            evidence_ids: ["evidence-3"],
          },
        ],
        summary: "Admission record for dataset export.",
      },
    },
    agent_context: {
      prompt_text: "SECRET_PROMPT_PAYLOAD_SHOULD_NOT_EXPORT",
      memory_ids: ["mem-positive"],
    },
  };

  const rows = memoryAdmissionDatasetRowsFromGuide(guide, {
    run_id: "run-1",
    task_id: "task-1",
    task_signature: "dataset-export",
  });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.outcome_label), [
    "positive_use",
    "unused_exposed",
    "blocked_or_suppressed",
    "rehydrate_requested",
  ]);
  assert.equal(rows[0]?.tenant_id, "tenant-a");
  assert.equal(rows[0]?.scope, "scope-a");
  assert.equal(rows[0]?.run_id, "run-1");
  assert.equal(rows[0]?.task_signature, "dataset-export");
  assert.equal(rows[0]?.policy_id, "AIONIS_ADMISSION_POLICY_V1");
  assert.equal(rows[0]?.policy_mode, "deterministic_admission");
  assert.equal(rows[0]?.agent_prompt_included, false);
  assert.equal(rows[0]?.runtime_mutation, false);

  const jsonl = memoryAdmissionDatasetJsonlFromGuide(guide, { run_id: "run-1" });
  assert.equal(jsonl.split("\n").filter(Boolean).length, 4);
  assert.doesNotMatch(jsonl, /SECRET_PROMPT_PAYLOAD_SHOULD_NOT_EXPORT/);
  assert.equal(JSON.parse(jsonl.split("\n")[0] ?? "{}").contract_version, "aionis_memory_admission_dataset_row_v1");
});

test("@aionis/sdk compact execution compiler respects prompt budget", () => {
  const longPrompt = "base ".repeat(1_000);
  const guide = {
    guide_trace_id: "guide-compact-1",
    agent_context: {
      prompt_text: longPrompt,
      memory_ids: ["mem-1"],
      use_now_memory_ids: ["mem-1"],
      command_posture: [],
      route_contract: {
        active_targets: [],
        pending_artifacts: [],
        reference_only_targets: [],
        blocked_direction_targets: [],
      },
    },
  };

  const compiled = compileExecutionAgentContext({
    guide,
    budget_profile: "compact",
    max_prompt_chars: 1_200,
  });

  assert.equal(compiled.agent_prompt.length <= 1_200, true);
  assert.equal(compiled.memory_use_receipt.history_used, true);
  assert.equal(compiled.memory_use_receipt.actionable_history_used, true);
  assert.deepEqual(compiled.memory_use_receipt.use_now_memory_ids, ["mem-1"]);
});

test("@aionis/sdk compact agent context keeps default full_power guide mode", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    fetchImpl: fakeFetch,
  });

  await client.execution.guideForRole({
    agent_id: "agent-compact",
    run_id: "run-compact",
    task_signature: "compact-agent",
    query_text: "Continue from current execution state.",
    context_mode: "compact_agent",
  });

  assert.equal(calls[0]?.mode, "full_power");
  assert.equal(calls[0]?.context_mode, "compact_agent");
});

test("@aionis/sdk execution helpers wrap observe, guide, feedback, measure, and snapshot", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({
      ok: true,
      guide_trace_id: "guide-exec-1",
      agent_context: {
        prompt_text: "AIONIS_CTX v2\ncurrent use_now=passed branch",
        memory_ids: ["mem-exec-1"],
        use_now_memory_ids: ["mem-exec-1"],
      },
      effect_report: {
        history_impact: { impact_direction: "positive" },
      },
      memory_decision_trace: {
        memory_use_receipt: { contract_version: "aionis_memory_use_receipt_v1" },
      },
    }), { status: 200 });
  };
  const client = createAionisClient({
    baseUrl: "http://127.0.0.1:3001",
    tenant_id: "tenant-a",
    scope: "scope-a",
    fetchImpl: fakeFetch,
  });

  await client.execution.observeStep({
    agent_id: "worker-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Implement adapter",
    summary: "Worker implemented the checkout adapter.",
    outcome: "succeeded",
    target_files: ["src/checkout.ts"],
    acceptance_checks: ["unit tests pass"],
  });

  await client.execution.handoff({
    agent_id: "planner-1",
    team_id: "checkout-team",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer handoff",
    summary: "Continue the verified branch and avoid broad legacy search.",
    continuation_hint: "review boundary and continue passed branch",
  });

  const guide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: "reviewer-1",
    team_id: "checkout-team",
    role: "reviewer",
    run_id: "run-1",
    task_signature: "checkout-migration",
    query_text: "Continue the checkout migration from current state.",
  });

  const feedback = await client.execution.feedbackFromOutcome({
    agent_id: "reviewer-1",
    run_id: "run-1",
    task_signature: "checkout-migration",
    title: "Reviewer continued branch",
    summary: "Reviewer used the current execution memory.",
    outcome: "succeeded",
    guide,
    used_memory_ids: ["mem-exec-1"],
  });

  const measure = await client.execution.measureRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    after_guide: guide,
    feedback_result: feedback,
    sufficient_evidence: true,
  });

  await client.execution.snapshotRun({
    run_id: "run-1",
    task_signature: "checkout-migration",
    guide,
    measure_result: measure,
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/observe",
    "http://127.0.0.1:3001/v1/guide",
    "http://127.0.0.1:3001/v1/feedback",
    "http://127.0.0.1:3001/v1/measure",
    "http://127.0.0.1:3001/v1/operator/snapshot",
  ]);

  assert.equal(calls[0]?.body.memory_lane, "private");
  assert.equal((calls[0]?.body.execution as Record<string, unknown>).outcome, "succeeded");
  assert.deepEqual((calls[0]?.body.execution as Record<string, unknown>).target_files, ["src/checkout.ts"]);

  assert.equal(calls[1]?.body.memory_lane, "shared");
  assert.equal(calls[1]?.body.owner_team_id, "checkout-team");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).handoff_kind, "task_handoff");
  assert.equal((calls[1]?.body.handoff as Record<string, unknown>).anchor, "checkout-migration:run-1:planner-1");

  assert.equal(calls[2]?.body.mode, "full_power");
  assert.equal(calls[2]?.body.agent_role, "reviewer");
  assert.equal(calls[2]?.body.consumer_agent_id, "reviewer-1");
  assert.equal(calls[2]?.body.consumer_team_id, "checkout-team");

  assert.equal(calls[3]?.body.guide_trace_id, "guide-exec-1");
  assert.deepEqual(calls[3]?.body.used_memory_ids, ["mem-exec-1"]);
  assert.equal(calls[3]?.body.outcome, "positive");
  assert.equal(calls[3]?.body.verifier_status, "passed");
  assert.equal(calls[3]?.body.tool_status, "succeeded");

  assert.equal((calls[4]?.body.task as Record<string, unknown>).task_signature, "checkout-migration");
  assert.equal((calls[5]?.body.agent_context as Record<string, unknown>).prompt_text, "AIONIS_CTX v2\ncurrent use_now=passed branch");
});
