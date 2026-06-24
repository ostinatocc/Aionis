export function admissionCandidatePolicyFixtureJsonl(): string {
  const rows: unknown[] = [];
  const taskCount = 12;
  const cyclesPerTask = 5;
  let rowIndex = 0;

  for (let task = 0; task < taskCount; task += 1) {
    const taskSignature = `admission-dataset-fixture:task-${String(task).padStart(2, "0")}`;
    for (let cycle = 0; cycle < cyclesPerTask; cycle += 1) {
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-positive`,
        sourceBackend: "aionis",
        memoryOrigin: "aionis",
        memoryType: "project_context",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "positive_use",
        feedbackOutcome: "positive",
        agentUsed: true,
        reasonCodes: ["lifecycle_active", "available_for_agent_use"],
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-negative-aionis-no-prior`,
        sourceBackend: "aionis",
        memoryOrigin: "aionis",
        memoryType: "project_context",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "negative_use",
        feedbackOutcome: "negative",
        agentUsed: true,
        reasonCodes: ["lifecycle_active", "available_for_agent_use"],
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-negative-aionis-contradicted`,
        sourceBackend: "aionis",
        memoryOrigin: "aionis",
        memoryType: "project_context",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "negative_use",
        feedbackOutcome: "negative",
        agentUsed: true,
        reasonCodes: ["lifecycle_active", "prior_negative_feedback"],
        closedLoopEffectState: "contradicted",
        priorContradictedUseCount: 1,
        repeatedNegativePosture: true,
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-negative-external`,
        sourceBackend: "mem0",
        memoryOrigin: "external",
        memoryType: "fact",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "negative_use",
        feedbackOutcome: "negative",
        agentUsed: true,
        reasonCodes: ["lifecycle_active", "external_candidate"],
        closedLoopEffectState: "contradicted",
        priorContradictedUseCount: 1,
        repeatedNegativePosture: true,
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-unused-external`,
        sourceBackend: "zep",
        memoryOrigin: "external",
        memoryType: "project_context",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "unused_exposed",
        feedbackOutcome: null,
        agentUsed: false,
        reasonCodes: ["lifecycle_active", "external_candidate"],
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-blocked`,
        sourceBackend: "archive",
        memoryOrigin: "external",
        memoryType: "fact",
        lifecycleState: "suppressed",
        authority: "blocked",
        admissionAction: "do_not_use",
        decisionKind: "blocked",
        outcomeLabel: "blocked_or_suppressed",
        feedbackOutcome: null,
        agentUsed: false,
        actionable: false,
        reasonCodes: ["lifecycle_suppressed", "blocked_authority"],
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `${task}-${cycle}-rehydrate`,
        sourceBackend: "aionis",
        memoryOrigin: "aionis",
        memoryType: "execution_memory",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "rehydrate",
        decisionKind: "rehydrate",
        outcomeLabel: "rehydrate_requested",
        feedbackOutcome: null,
        agentUsed: false,
        actionable: false,
        reasonCodes: ["rehydrate_required"],
        closedLoopEffectState: "rehydrate_requested",
        priorRehydrateRequestedCount: 1,
      }));
    }
  }

  for (let task = 0; task < 6; task += 1) {
    const taskSignature = `admission-dataset-fixture:noise-${String(task).padStart(2, "0")}`;
    for (let cycle = 0; cycle < cyclesPerTask; cycle += 1) {
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `noise-${task}-${cycle}-unused-external`,
        sourceBackend: "mem0",
        memoryOrigin: "external",
        memoryType: "project_context",
        lifecycleState: "active",
        authority: "advisory",
        admissionAction: "use_now",
        decisionKind: "used",
        outcomeLabel: "unused_exposed",
        feedbackOutcome: null,
        agentUsed: false,
        reasonCodes: ["lifecycle_active", "external_candidate"],
      }));
      rows.push(row({
        taskSignature,
        rowIndex: rowIndex++,
        suffix: `noise-${task}-${cycle}-blocked`,
        sourceBackend: "archive",
        memoryOrigin: "external",
        memoryType: "fact",
        lifecycleState: "suppressed",
        authority: "blocked",
        admissionAction: "do_not_use",
        decisionKind: "blocked",
        outcomeLabel: "blocked_or_suppressed",
        feedbackOutcome: null,
        agentUsed: false,
        actionable: false,
        reasonCodes: ["lifecycle_suppressed", "blocked_authority"],
      }));
    }
  }

  return rows.map((entry) => JSON.stringify(entry)).join("\n");
}

function row(args: {
  taskSignature: string;
  rowIndex: number;
  suffix: string;
  sourceBackend: string;
  memoryOrigin: "aionis" | "external";
  memoryType: string;
  lifecycleState: string;
  authority: string;
  admissionAction: string;
  decisionKind: string;
  outcomeLabel: string;
  feedbackOutcome: string | null;
  agentUsed: boolean;
  actionable?: boolean;
  reasonCodes: string[];
  closedLoopEffectState?: string;
  priorSupportedUseCount?: number;
  priorContradictedUseCount?: number;
  priorRehydrateRequestedCount?: number;
  repeatedNegativePosture?: boolean;
}): Record<string, unknown> {
  return {
    contract_version: "aionis_memory_admission_dataset_row_v1",
    intended_use: "memory_admission_policy_training_or_audit",
    source: "memory_admission_record",
    agent_prompt_included: false,
    runtime_mutation: false,
    policy_id: "AIONIS_ADMISSION_POLICY_V1",
    policy_version: "2026-06-17",
    policy_mode: "deterministic_admission",
    runtime_version: "test-fixture",
    tenant_id: "default",
    scope: `admission-dataset-fixture:${args.taskSignature}`,
    guide_trace_id: `guide-fixture-${args.suffix}`,
    run_id: `run-fixture-${args.suffix}`,
    task_id: `task-fixture-${args.suffix}`,
    task_signature: args.taskSignature,
    row_index: args.rowIndex,
    memory_id: `mem-fixture-${args.suffix}`,
    title: `Admission fixture ${args.suffix}`,
    memory_origin: args.memoryOrigin,
    source_backend: args.sourceBackend,
    domain: "general",
    memory_type: args.memoryType,
    lifecycle_state: args.lifecycleState,
    authority: args.authority,
    admission_action: args.admissionAction,
    decision_kind: args.decisionKind,
    actionable: args.actionable ?? true,
    prompt_included: true,
    agent_used: args.agentUsed,
    feedback_outcome: args.feedbackOutcome,
    attribution_strength: args.feedbackOutcome ? "test_attribution" : null,
    outcome_label: args.outcomeLabel,
    reason_codes: args.reasonCodes,
    evidence_ids: [`evidence-fixture-${args.suffix}`],
    prompt_char_count: 512,
    history_used: true,
    actionable_history_used: true,
    prior_supported_use_count: args.priorSupportedUseCount ?? 0,
    prior_contradicted_use_count: args.priorContradictedUseCount ?? 0,
    prior_rehydrate_requested_count: args.priorRehydrateRequestedCount ?? 0,
    closed_loop_effect_state: args.closedLoopEffectState ?? "no_prior",
    repeated_negative_posture: args.repeatedNegativePosture ?? false,
  };
}
