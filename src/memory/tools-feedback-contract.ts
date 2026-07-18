import type { WorkflowFeedbackTarget } from "../kernel/learning-decision-kernel.js";
import type {
  PreparedPolicyMemoryFeedback,
  PreparedPolicyMemorySnapshot,
} from "./policy-memory.js";
import type {
  ToolsFeedbackInput,
  ToolsFeedbackLearningControlPreview,
  ToolsFeedbackResponse,
} from "./schemas.js";
import type { ToolRuleEvaluationProvenance } from "./tool-rule-evaluation-provenance.js";
import type { PreparedToolsDecisionPatternAnchor } from "./tools-pattern-anchor.js";

export type ToolFeedbackDecisionRow = {
  id: string;
  scope: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: unknown[];
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
  commit_id: string | null;
};

export type PreparedToolFeedbackDecisionPlan = {
  expected_sha256: string | null;
  create: boolean;
  decision_link_mode: "provided" | "inferred" | "created_from_feedback";
  before: ToolFeedbackDecisionRow | null;
  after: ToolFeedbackDecisionRow;
};

export type PreparedToolFeedbackRuleInsert = {
  id: string;
  rule_node_id: string;
};

export type PreparedToolSelectionFeedback = {
  schema_version: "prepared_tool_selection_feedback_v2";
  parsed: ToolsFeedbackInput;
  default_scope: string;
  default_tenant_id: string;
  tenant_id: string;
  scope: string;
  scope_key: string;
  actor: string;
  normalized_candidates: string[];
  selected_tool: string;
  input_text: string | null;
  input_sha256: string;
  note: string | null;
  workflow_feedback_target: WorkflowFeedbackTarget;
  source_rule_ids: string[];
  rules_applied_sha256: string;
  served_rule_evaluation: ToolRuleEvaluationProvenance | null;
  context_sha256: string;
  policy_sha256: string;
  decision: PreparedToolFeedbackDecisionPlan;
  expected_head_commit_id: string | null;
  expected_head_revision: number;
  feedback_created_at: string;
  rule_feedback: PreparedToolFeedbackRuleInsert[];
  pattern: PreparedToolsDecisionPatternAnchor | null;
  policy_snapshot: PreparedPolicyMemorySnapshot | null;
  policy_feedback: PreparedPolicyMemoryFeedback | null;
  policy_materialized_response: ToolsFeedbackResponse["policy_memory"] | null;
  learning_control_preview: ToolsFeedbackLearningControlPreview | null;
};
