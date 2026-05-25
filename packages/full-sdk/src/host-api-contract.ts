import { AIONIS_SHARED_ROUTE_PATHS } from "./routes.js";

export type AionisHostApiFacadeKind =
  | "task_start_plan"
  | "execution_outcome_write"
  | "workflow_contract_read"
  | "runtime_introspection_read";

export type AionisHostApiDebugPolicy =
  | "none"
  | "explicit_opt_in";

export type AionisHostApiFacadeContract = {
  sdk_method: string;
  facade_kind: AionisHostApiFacadeKind;
  request_contract: string;
  response_contract: string;
  host_calls_facade: boolean;
  route_paths: readonly string[];
  stable_response_fields: readonly string[];
  optional_debug_fields: readonly string[];
  debug_policy: AionisHostApiDebugPolicy;
  authority_semantics: string;
};

export type AionisHostExecutionMemoryApiContract = {
  contract_version: "host_execution_memory_api_contract_v1";
  scope: "execution_memory_host_loop";
  public_loop: readonly [
    "memory.taskStartPlan",
    "host.execute_and_validate",
    "memory.storeExecutionOutcome",
    "memory.retrieveWorkflowContract",
  ];
  host_responsibility: readonly string[];
  runtime_responsibility: readonly string[];
  facades: readonly AionisHostApiFacadeContract[];
};

export const AIONIS_HOST_EXECUTION_MEMORY_API_CONTRACT = {
  contract_version: "host_execution_memory_api_contract_v1",
  scope: "execution_memory_host_loop",
  public_loop: [
    "memory.taskStartPlan",
    "host.execute_and_validate",
    "memory.storeExecutionOutcome",
    "memory.retrieveWorkflowContract",
  ],
  host_responsibility: [
    "execute returned guidance in the real environment",
    "validate the result with task-appropriate acceptance checks",
    "record after-exit and fresh-shell evidence when the outcome requires external durability",
  ],
  runtime_responsibility: [
    "compile host input and execution history into reusable execution contracts",
    "gate authority through outcome contracts and execution evidence",
    "keep candidate workflow and trusted-pattern guidance advisory until authority gates pass",
  ],
  facades: [
    {
      sdk_method: "memory.taskStartPlan",
      facade_kind: "task_start_plan",
      request_contract: "AionisTaskStartPlanRequest",
      response_contract: "AionisTaskStartPlanResponse",
      host_calls_facade: true,
      route_paths: [
        AIONIS_SHARED_ROUTE_PATHS.kickoffRecommendation,
        AIONIS_SHARED_ROUTE_PATHS.planningContext,
      ],
      stable_response_fields: [
        "summary_version",
        "resolution_source",
        "tenant_id",
        "scope",
        "query_text",
        "kickoff_recommendation",
        "gate_action",
        "action_retrieval_uncertainty",
        "first_action",
        "planner_explanation",
        "planner_packet",
        "rationale",
      ],
      optional_debug_fields: [],
      debug_policy: "none",
      authority_semantics: "first_action is startup guidance; it is not reusable authority until the host stores validated outcome evidence.",
    },
    {
      sdk_method: "memory.storeExecutionOutcome",
      facade_kind: "execution_outcome_write",
      request_contract: "AionisStoreExecutionOutcomeRequest",
      response_contract: "AionisStoreExecutionOutcomeResponse",
      host_calls_facade: true,
      route_paths: [
        "/v1/memory/replay/run/start",
        "/v1/memory/replay/step/before",
        "/v1/memory/replay/step/after",
        "/v1/memory/replay/run/end",
        "/v1/memory/replay/playbooks/compile_from_run",
        "/v1/memory/replay/playbooks/run",
      ],
      stable_response_fields: [
        "summary_version",
        "tenant_id",
        "scope",
        "run_id",
        "status",
        "started",
        "steps",
        "steps[].before",
        "steps[].after",
        "ended",
        "playbook_compile",
        "playbook_simulation",
      ],
      optional_debug_fields: [],
      debug_policy: "none",
      authority_semantics: "stored evidence can feed learning, but authority is still decided later by retrieveWorkflowContract authority_summary.",
    },
    {
      sdk_method: "memory.retrieveWorkflowContract",
      facade_kind: "workflow_contract_read",
      request_contract: "AionisRetrieveWorkflowContractRequest",
      response_contract: "AionisRetrieveWorkflowContractResponse",
      host_calls_facade: true,
      route_paths: [
        AIONIS_SHARED_ROUTE_PATHS.executionIntrospect,
      ],
      stable_response_fields: [
        "summary_version",
        "tenant_id",
        "scope",
        "selected_source",
        "execution_contract_v1",
        "contract_trust",
        "outcome_contract_gate",
        "authority_visibility",
        "authority_summary",
      ],
      optional_debug_fields: [
        "selected_workflow",
        "introspection",
      ],
      debug_policy: "explicit_opt_in",
      authority_semantics: "authority_summary is the host-facing authority decision; full introspection is debug-only and omitted by default.",
    },
    {
      sdk_method: "memory.executionIntrospect",
      facade_kind: "runtime_introspection_read",
      request_contract: "AionisExecutionIntrospectRequest",
      response_contract: "AionisExecutionIntrospectResponse",
      host_calls_facade: true,
      route_paths: [
        AIONIS_SHARED_ROUTE_PATHS.executionIntrospect,
      ],
      stable_response_fields: [
        "summary_version",
        "tenant_id",
        "scope",
        "recommended_workflows",
        "candidate_workflows",
        "trusted_patterns",
        "contested_patterns",
        "workflow_signals",
        "pattern_signals",
        "authority_decision_report",
        "execution_summary",
      ],
      optional_debug_fields: [
        "demo_surface",
        "continuity_projection_report",
        "supporting_knowledge",
      ],
      debug_policy: "explicit_opt_in",
      authority_semantics: "introspection explains runtime state and read-side authority decisions; it does not grant authority by itself.",
    },
  ],
} as const satisfies AionisHostExecutionMemoryApiContract;

export function getAionisHostExecutionMemoryApiContract(): AionisHostExecutionMemoryApiContract {
  return AIONIS_HOST_EXECUTION_MEMORY_API_CONTRACT;
}
