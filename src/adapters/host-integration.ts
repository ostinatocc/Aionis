import type {
  AionisExecutionMemoryAdapter,
  ExecutionMemoryAgentRef,
  ExecutionMemoryAgentRole,
  ExecutionMemoryGuideInput,
  ExecutionMemoryMeasureInput,
  ExecutionMemoryOperatorSnapshotInput,
  ExecutionMemoryOutcomeInput,
  ExecutionMemoryOutcomeResult,
  ExecutionMemoryRunRef,
  ExecutionMemoryRunStartInput,
  ExecutionMemoryStepInput,
} from "./execution-memory.js";
import { exposedUseNowMemoryIds } from "./execution-memory.js";
import type {
  AionisCommandPosture,
  AionisGuideMode,
  AionisJsonObject,
} from "../sdk.js";
import {
  commandPostureFromGuide,
  inspectFirstMemoryIdsFromGuide,
  mustNotMemoryIdsFromGuide,
  rehydrateFirstMemoryIdsFromGuide,
  shouldContinueMemoryIdsFromGuide,
} from "../sdk.js";

export type HostIntegrationTemplateKind =
  | "generic_agent_loop"
  | "multi_agent_loop"
  | "coding_agent_loop";

export const HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION = "aionis_host_integration_template_v1" as const;

export const HOST_INTEGRATION_TEMPLATES = {
  contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
  templates: {
    generic_agent_loop: {
      required_hooks: ["startRun", "beforeRun", "afterRun", "measure", "snapshot"],
      persisted_state: [
        "run_id",
        "task_signature",
        "guide_run_id",
        "last_guide_trace_id",
        "last_use_now_memory_ids",
        "last_command_posture",
        "last_agent_context",
      ],
      agent_surface: "agent_context",
    },
    multi_agent_loop: {
      required_hooks: ["plannerStart", "workerStep", "verifierStep", "reviewerGuide", "reviewerOutcome", "measure", "snapshot"],
      persisted_state: ["team_id", "run_id", "task_signature", "guide_run_id", "last_guide_trace_id", "last_command_posture", "last_agent_context"],
      roles: ["planner", "worker", "verifier", "reviewer"],
    },
    coding_agent_loop: {
      required_hooks: ["beforePatch", "afterPatch", "measure", "snapshot"],
      persisted_state: ["run_id", "task_signature", "repo_root", "target_files", "guide_run_id", "last_command_posture", "last_agent_context"],
      agent_surface: "agent_context",
    },
  },
} as const;

export type HostRunState = ExecutionMemoryRunRef & ExecutionMemoryAgentRef & {
  contract_version: typeof HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION;
  template: HostIntegrationTemplateKind;
  guide_run_id?: string;
  last_guide_trace_id?: string;
  last_use_now_memory_ids: string[];
  last_command_posture: AionisCommandPosture[];
  last_must_not_memory_ids: string[];
  last_should_continue_memory_ids: string[];
  last_inspect_first_memory_ids: string[];
  last_rehydrate_first_memory_ids: string[];
  last_agent_context?: unknown;
  last_outcome?: string;
  repo_root?: string;
  target_files?: string[];
};

export type HostTemplateDefaults = ExecutionMemoryAgentRef & {
  context?: AionisJsonObject;
  tool_candidates?: string[];
  limit?: number;
  include_packets?: boolean;
  mode?: AionisGuideMode;
};

export type HostRunStartInput = ExecutionMemoryRunStartInput & {
  state?: HostRunState;
};

export type HostStepInput = ExecutionMemoryStepInput & {
  state?: HostRunState;
};

export type HostGuideInput = ExecutionMemoryGuideInput & {
  state?: HostRunState;
};

export type HostOutcomeInput = ExecutionMemoryOutcomeInput & {
  state?: HostRunState;
};

export type HostMeasureInput = ExecutionMemoryMeasureInput & {
  state?: HostRunState;
};

export type HostSnapshotInput = ExecutionMemoryOperatorSnapshotInput & {
  state?: HostRunState;
};

export type HostObserveHookResult<TObserve = unknown> = {
  observe: TObserve;
  state: HostRunState;
};

export type HostGuideHookResult<TGuide = unknown> = {
  guide: TGuide;
  agent_context: unknown | null;
  command_posture: AionisCommandPosture[];
  must_not_memory_ids: string[];
  should_continue_memory_ids: string[];
  inspect_first_memory_ids: string[];
  rehydrate_first_memory_ids: string[];
  state: HostRunState;
};

export type HostOutcomeHookResult<TObserve = unknown, TFeedback = unknown> = {
  outcome: ExecutionMemoryOutcomeResult<TObserve, TFeedback>;
  state: HostRunState;
};

export type GenericAgentHostTemplate = {
  contract_version: typeof HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION;
  template: "generic_agent_loop";
  startRun<TObserve = unknown>(input: HostRunStartInput): Promise<HostObserveHookResult<TObserve>>;
  observeStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>>;
  beforeRun<TGuide = unknown>(input: HostGuideInput): Promise<HostGuideHookResult<TGuide>>;
  afterRun<TObserve = unknown, TFeedback = unknown>(
    input: HostOutcomeInput,
  ): Promise<HostOutcomeHookResult<TObserve, TFeedback>>;
  measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure>;
  snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot>;
};

export type MultiAgentHostTemplate = {
  contract_version: typeof HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION;
  template: "multi_agent_loop";
  plannerStart<TObserve = unknown>(input: HostRunStartInput): Promise<HostObserveHookResult<TObserve>>;
  workerStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>>;
  verifierStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>>;
  reviewerGuide<TGuide = unknown>(input: HostGuideInput): Promise<HostGuideHookResult<TGuide>>;
  reviewerOutcome<TObserve = unknown, TFeedback = unknown>(
    input: HostOutcomeInput,
  ): Promise<HostOutcomeHookResult<TObserve, TFeedback>>;
  measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure>;
  snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot>;
};

export type CodingBeforePatchInput = HostGuideInput & {
  repo_root?: string;
  target_files?: string[];
  patch_goal?: string;
};

export type CodingAfterPatchInput = HostOutcomeInput & {
  repo_root?: string;
  target_files?: string[];
  changed_files?: string[];
};

export type CodingAgentHostTemplate = {
  contract_version: typeof HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION;
  template: "coding_agent_loop";
  beforePatch<TGuide = unknown>(input: CodingBeforePatchInput): Promise<HostGuideHookResult<TGuide>>;
  afterPatch<TObserve = unknown, TFeedback = unknown>(
    input: CodingAfterPatchInput,
  ): Promise<HostOutcomeHookResult<TObserve, TFeedback>>;
  measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure>;
  snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot>;
};

function stripUndefined<T extends Record<string, unknown>>(value: T): AionisJsonObject {
  const out: AionisJsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) out[key] = entry;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const entry = asRecord(value)?.[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function agentContext(value: unknown): unknown | null {
  return asRecord(value)?.agent_context ?? null;
}

function guideCommandSurfaces(guide: unknown): {
  command_posture: AionisCommandPosture[];
  must_not_memory_ids: string[];
  should_continue_memory_ids: string[];
  inspect_first_memory_ids: string[];
  rehydrate_first_memory_ids: string[];
} {
  return {
    command_posture: commandPostureFromGuide(guide),
    must_not_memory_ids: mustNotMemoryIdsFromGuide(guide),
    should_continue_memory_ids: shouldContinueMemoryIdsFromGuide(guide),
    inspect_first_memory_ids: inspectFirstMemoryIdsFromGuide(guide),
    rehydrate_first_memory_ids: rehydrateFirstMemoryIdsFromGuide(guide),
  };
}

function stateFromGuide(args: {
  template: HostIntegrationTemplateKind;
  input: ExecutionMemoryRunRef & ExecutionMemoryAgentRef;
  previous?: HostRunState;
  guide: unknown;
  repo_root?: string;
  target_files?: string[];
}): HostRunState {
  const commandSurfaces = guideCommandSurfaces(args.guide);
  return {
    contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
    template: args.template,
    run_id: args.input.run_id,
    task_id: args.input.task_id ?? args.previous?.task_id,
    task_signature: args.input.task_signature,
    task_family: args.input.task_family ?? args.previous?.task_family,
    workflow_signature: args.input.workflow_signature ?? args.previous?.workflow_signature,
    agent_id: args.input.agent_id ?? args.previous?.agent_id,
    team_id: args.input.team_id ?? args.previous?.team_id,
    role: args.input.role ?? args.previous?.role,
    guide_run_id: args.input.run_id,
    last_guide_trace_id: stringField(args.guide, "guide_trace_id") ?? args.previous?.last_guide_trace_id,
    last_use_now_memory_ids: exposedUseNowMemoryIds(args.guide),
    last_command_posture: commandSurfaces.command_posture,
    last_must_not_memory_ids: commandSurfaces.must_not_memory_ids,
    last_should_continue_memory_ids: commandSurfaces.should_continue_memory_ids,
    last_inspect_first_memory_ids: commandSurfaces.inspect_first_memory_ids,
    last_rehydrate_first_memory_ids: commandSurfaces.rehydrate_first_memory_ids,
    last_agent_context: agentContext(args.guide) ?? args.previous?.last_agent_context,
    last_outcome: args.previous?.last_outcome,
    repo_root: args.repo_root ?? args.previous?.repo_root,
    target_files: args.target_files ?? args.previous?.target_files,
  };
}

function stateFromObserve(args: {
  template: HostIntegrationTemplateKind;
  input: ExecutionMemoryRunRef & ExecutionMemoryAgentRef & { outcome?: string; target_files?: string[] };
  previous?: HostRunState;
  repo_root?: string;
}): HostRunState {
  return {
    contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
    template: args.template,
    run_id: args.input.run_id,
    task_id: args.input.task_id ?? args.previous?.task_id,
    task_signature: args.input.task_signature,
    task_family: args.input.task_family ?? args.previous?.task_family,
    workflow_signature: args.input.workflow_signature ?? args.previous?.workflow_signature,
    agent_id: args.input.agent_id ?? args.previous?.agent_id,
    team_id: args.input.team_id ?? args.previous?.team_id,
    role: args.input.role ?? args.previous?.role,
    guide_run_id: args.previous?.guide_run_id,
    last_guide_trace_id: args.previous?.last_guide_trace_id,
    last_use_now_memory_ids: args.previous?.last_use_now_memory_ids ?? [],
    last_command_posture: args.previous?.last_command_posture ?? [],
    last_must_not_memory_ids: args.previous?.last_must_not_memory_ids ?? [],
    last_should_continue_memory_ids: args.previous?.last_should_continue_memory_ids ?? [],
    last_inspect_first_memory_ids: args.previous?.last_inspect_first_memory_ids ?? [],
    last_rehydrate_first_memory_ids: args.previous?.last_rehydrate_first_memory_ids ?? [],
    last_agent_context: args.previous?.last_agent_context,
    last_outcome: args.input.outcome ?? args.previous?.last_outcome,
    repo_root: args.repo_root ?? args.previous?.repo_root,
    target_files: args.input.target_files ?? args.previous?.target_files,
  };
}

function withDefaults<T extends ExecutionMemoryAgentRef & {
  context?: AionisJsonObject;
  tool_candidates?: string[];
  limit?: number;
  include_packets?: boolean;
  mode?: AionisGuideMode;
}>(input: T, defaults: HostTemplateDefaults | undefined): T {
  if (!defaults) return input;
  const mergedContext = defaults.context || input.context
    ? stripUndefined({
      ...(defaults.context ?? {}),
      ...(input.context ?? {}),
    })
    : undefined;
  return {
    ...input,
    agent_id: input.agent_id ?? defaults.agent_id,
    team_id: input.team_id ?? defaults.team_id,
    role: input.role ?? defaults.role,
    context: mergedContext,
    tool_candidates: input.tool_candidates ?? defaults.tool_candidates,
    limit: input.limit ?? defaults.limit,
    include_packets: input.include_packets ?? defaults.include_packets,
    mode: input.mode ?? defaults.mode,
  };
}

function forceRole<T extends ExecutionMemoryAgentRef>(input: T, role: ExecutionMemoryAgentRole): T {
  return {
    ...input,
    role: input.role ?? role,
  };
}

export function createGenericAgentHostTemplate(
  adapter: AionisExecutionMemoryAdapter,
  defaults?: HostTemplateDefaults,
): GenericAgentHostTemplate {
  return {
    contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
    template: "generic_agent_loop",

    async startRun<TObserve = unknown>(input: HostRunStartInput): Promise<HostObserveHookResult<TObserve>> {
      const { state, ...memoryInput } = input;
      const effective = withDefaults(memoryInput, defaults);
      const observe = await adapter.observeRunStart<TObserve>(effective);
      return {
        observe,
        state: stateFromObserve({
          template: "generic_agent_loop",
          input: effective,
          previous: state,
        }),
      };
    },

    async observeStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>> {
      const { state, ...memoryInput } = input;
      const effective = withDefaults(memoryInput, defaults);
      const observe = await adapter.observeStep<TObserve>(effective);
      return {
        observe,
        state: stateFromObserve({
          template: "generic_agent_loop",
          input: effective,
          previous: state,
        }),
      };
    },

    async beforeRun<TGuide = unknown>(input: HostGuideInput): Promise<HostGuideHookResult<TGuide>> {
      const { state, ...guideInput } = input;
      const effective = withDefaults(guideInput, defaults);
      const guide = await adapter.guideNext<TGuide>(effective);
      const commandSurfaces = guideCommandSurfaces(guide);
      return {
        guide,
        agent_context: agentContext(guide),
        ...commandSurfaces,
        state: stateFromGuide({
          template: "generic_agent_loop",
          input: effective,
          previous: state,
          guide,
        }),
      };
    },

    async afterRun<TObserve = unknown, TFeedback = unknown>(
      input: HostOutcomeInput,
    ): Promise<HostOutcomeHookResult<TObserve, TFeedback>> {
      const { state, ...outcomeInput } = input;
      const effective = withDefaults(outcomeInput, defaults);
      const outcome = await adapter.observeOutcome<TObserve, TFeedback>({
        ...effective,
        guide_run_id: effective.guide_run_id ?? state?.guide_run_id,
        guide_trace_id: effective.guide_trace_id ?? state?.last_guide_trace_id,
      });
      return {
        outcome,
        state: stateFromObserve({
          template: "generic_agent_loop",
          input: effective,
          previous: state,
        }),
      };
    },

    async measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure> {
      const { state: _state, ...measureInput } = input;
      return adapter.measureRun<TMeasure>(measureInput);
    },

    async snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot> {
      const { state, ...snapshotInput } = input;
      return adapter.operatorSnapshotRun<TSnapshot>({
        ...snapshotInput,
        guide_run_id: snapshotInput.guide_run_id ?? state?.guide_run_id,
        guide_trace_id: snapshotInput.guide_trace_id ?? state?.last_guide_trace_id,
        agent_context: snapshotInput.agent_context ?? state?.last_agent_context,
      });
    },
  };
}

export function createMultiAgentHostTemplate(
  adapter: AionisExecutionMemoryAdapter,
  defaults?: HostTemplateDefaults,
): MultiAgentHostTemplate {
  const generic = createGenericAgentHostTemplate(adapter, defaults);

  return {
    contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
    template: "multi_agent_loop",

    async plannerStart<TObserve = unknown>(input: HostRunStartInput): Promise<HostObserveHookResult<TObserve>> {
      const result = await generic.startRun<TObserve>(forceRole(input, "planner"));
      return {
        ...result,
        state: { ...result.state, template: "multi_agent_loop" },
      };
    },

    async workerStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>> {
      const result = await generic.observeStep<TObserve>(forceRole(input, "worker"));
      return {
        ...result,
        state: { ...result.state, template: "multi_agent_loop" },
      };
    },

    async verifierStep<TObserve = unknown>(input: HostStepInput): Promise<HostObserveHookResult<TObserve>> {
      const result = await generic.observeStep<TObserve>(forceRole(input, "verifier"));
      return {
        ...result,
        state: { ...result.state, template: "multi_agent_loop" },
      };
    },

    async reviewerGuide<TGuide = unknown>(input: HostGuideInput): Promise<HostGuideHookResult<TGuide>> {
      const result = await generic.beforeRun<TGuide>(forceRole(input, "reviewer"));
      return {
        ...result,
        state: { ...result.state, template: "multi_agent_loop" },
      };
    },

    async reviewerOutcome<TObserve = unknown, TFeedback = unknown>(
      input: HostOutcomeInput,
    ): Promise<HostOutcomeHookResult<TObserve, TFeedback>> {
      const result = await generic.afterRun<TObserve, TFeedback>(forceRole(input, "reviewer"));
      return {
        ...result,
        state: { ...result.state, template: "multi_agent_loop" },
      };
    },

    async measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure> {
      return generic.measure<TMeasure>(input);
    },

    async snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot> {
      return generic.snapshot<TSnapshot>(input);
    },
  };
}

export function createCodingAgentHostTemplate(
  adapter: AionisExecutionMemoryAdapter,
  defaults?: HostTemplateDefaults,
): CodingAgentHostTemplate {
  const generic = createGenericAgentHostTemplate(adapter, {
    ...defaults,
    role: defaults?.role ?? "worker",
  });

  return {
    contract_version: HOST_INTEGRATION_TEMPLATE_CONTRACT_VERSION,
    template: "coding_agent_loop",

    async beforePatch<TGuide = unknown>(input: CodingBeforePatchInput): Promise<HostGuideHookResult<TGuide>> {
      const { repo_root, target_files, patch_goal, context, state, ...guideInput } = input;
      const effectiveContext = stripUndefined({
        ...(context ?? {}),
        repo_root: repo_root ?? state?.repo_root,
        target_files: target_files ?? state?.target_files,
        patch_goal,
      });
      const result = await generic.beforeRun<TGuide>({
        ...guideInput,
        state,
        context: effectiveContext,
      });
      return {
        ...result,
        state: {
          ...result.state,
          template: "coding_agent_loop",
          repo_root: repo_root ?? state?.repo_root,
          target_files: target_files ?? state?.target_files,
        },
      };
    },

    async afterPatch<TObserve = unknown, TFeedback = unknown>(
      input: CodingAfterPatchInput,
    ): Promise<HostOutcomeHookResult<TObserve, TFeedback>> {
      const { repo_root, changed_files, slots, state, ...outcomeInput } = input;
      const targetFiles = outcomeInput.target_files ?? state?.target_files ?? changed_files;
      const result = await generic.afterRun<TObserve, TFeedback>({
        ...outcomeInput,
        state,
        target_files: targetFiles,
        slots: stripUndefined({
          ...(slots ?? {}),
          repo_root: repo_root ?? state?.repo_root,
          changed_files,
        }),
      });
      return {
        ...result,
        state: {
          ...result.state,
          template: "coding_agent_loop",
          repo_root: repo_root ?? state?.repo_root,
          target_files: targetFiles,
        },
      };
    },

    async measure<TMeasure = unknown>(input: HostMeasureInput): Promise<TMeasure> {
      return generic.measure<TMeasure>(input);
    },

    async snapshot<TSnapshot = unknown>(input: HostSnapshotInput): Promise<TSnapshot> {
      return generic.snapshot<TSnapshot>(input);
    },
  };
}
