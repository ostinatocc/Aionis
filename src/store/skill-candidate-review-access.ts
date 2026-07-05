import type { AionisTraceDerivedSkillCandidate } from "../memory/product-output-contract.js";

export const SKILL_CANDIDATE_REVIEW_ACCESS_CAPABILITY_VERSION = 1;

export type SkillCandidateReviewStatus = "pending_review" | "promoted" | "rejected";

export type TraceDerivedSkillTrainingCandidate = {
  candidate_type: "trace_derived_skill";
  source_ids: string[];
  label: "positive" | "negative" | "neutral" | "blocked" | "insufficient_evidence";
  export_ready: boolean;
  reason: string;
  trace_derived_skill: AionisTraceDerivedSkillCandidate;
};

export type SkillCandidateReviewRow = {
  candidate_id: string;
  tenant_id: string;
  scope: string;
  review_status: SkillCandidateReviewStatus;
  skill_name: string;
  label: TraceDerivedSkillTrainingCandidate["label"];
  export_ready: boolean;
  promotion_status: TraceDerivedSkillTrainingCandidate["trace_derived_skill"]["promotion_status"];
  reason: string;
  source_ids: string[];
  source_trace_ids: string[];
  source_signal_ids: string[];
  applies_when: string[];
  does_not_apply_when: string[];
  procedure_steps: string[];
  target_files: string[];
  acceptance_checks: string[];
  failure_counterexamples: string[];
  evidence_refs: string[];
  candidate: TraceDerivedSkillTrainingCandidate;
  reviewer_id: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
};

export type SkillCandidateReviewAccess = {
  enqueueTraceDerivedSkillCandidates(args: {
    tenantId: string;
    scope: string;
    candidates: TraceDerivedSkillTrainingCandidate[];
    source: "measure_result" | "effect_report" | "manual";
    now?: string;
  }): Promise<{ rows: SkillCandidateReviewRow[]; inserted: number; updated: number }>;
  listTraceDerivedSkillCandidates(args: {
    tenantId: string;
    scope: string;
    reviewStatus?: SkillCandidateReviewStatus | "all";
    limit: number;
  }): Promise<{ rows: SkillCandidateReviewRow[] }>;
  getTraceDerivedSkillCandidate(args: {
    tenantId: string;
    scope: string;
    candidateId: string;
  }): Promise<SkillCandidateReviewRow | null>;
  reviewTraceDerivedSkillCandidate(args: {
    tenantId: string;
    scope: string;
    candidateId: string;
    reviewStatus: Exclude<SkillCandidateReviewStatus, "pending_review">;
    reviewerId?: string | null;
    reason?: string | null;
    now?: string;
  }): Promise<SkillCandidateReviewRow | null>;
  close(): Promise<void>;
};
