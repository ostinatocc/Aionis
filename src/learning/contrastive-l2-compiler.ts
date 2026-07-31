import stableStringify from "fast-json-stable-stringify";

import { sha256Hex } from "../util/crypto.js";
import type { CanonicalL1EpisodeV1 } from "./canonical-l1-contract.js";
import {
  ContrastiveL2HypothesisV1Schema,
  contrastiveL2AbstractionDigest,
  contrastiveL2HypothesisDigest,
  type ContrastiveL2AbstractionV1,
  type ContrastiveL2FeatureV1,
  type ContrastiveL2HypothesisV1,
} from "./contrastive-l2-contract.js";

const COMPILER_POLICY = Object.freeze({
  compiler_id: "contrastive_l2_compiler_v1",
  input_contract: "canonical_l1_episode_v1",
  eligible_intervention: "state_only",
  minimum_successes: 2,
  minimum_failures: 1,
  minimum_distinct_task_clusters: 3,
  admitted_features: [
    "mutation_action_count",
    "total_action_count",
  ],
  separation_rule: "strict_non_overlapping_success_failure_ranges",
  literal_policy: "structural_fields_only_v1",
});

const COMPILER_POLICY_SHA256 = sha256Hex(stableStringify(COMPILER_POLICY));

export type ContrastiveL2AbstentionReason =
  | "insufficient_eligible_episodes"
  | "insufficient_successes"
  | "insufficient_failures"
  | "insufficient_distinct_task_clusters"
  | "no_strict_structural_difference";

export type ContrastiveL2CohortAbstention = Readonly<{
  status: "abstained";
  cohort_key: string;
  reason: ContrastiveL2AbstentionReason;
  eligible_episode_ids: readonly string[];
}>;

export type ContrastiveL2Compilation = Readonly<{
  compiler_policy_sha256: string;
  candidates: readonly ContrastiveL2HypothesisV1[];
  abstentions: readonly ContrastiveL2CohortAbstention[];
}>;

type EligibleEpisode = CanonicalL1EpisodeV1;

function canonicalCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function cohortKey(row: CanonicalL1EpisodeV1): string {
  return stableStringify({
    tenant_id: row.tenant_id,
    subject_kind: row.subject_kind,
    verifier_kind: row.verifier.verifier_kind,
    intervention_kind: row.intervention_kind,
  });
}

function isEligibleStateOnly(row: CanonicalL1EpisodeV1): boolean {
  return (
    row.learning_eligibility.eligible
    && row.contamination.status === "clean"
    && row.intervention_kind === "state_only"
    && row.actual_use.length === 0
    && (
      row.reward.outcome_class === "verified_pass"
      || row.reward.outcome_class === "verified_failure"
    )
    && row.verifier.status
      === (
        row.reward.outcome_class === "verified_pass"
          ? "passed"
          : "failed"
      )
  );
}

function featureValue(
  row: CanonicalL1EpisodeV1,
  feature: ContrastiveL2FeatureV1,
): number {
  switch (feature) {
    case "mutation_action_count":
      return row.trajectory.filter((step) => step.mutation).length;
    case "total_action_count":
      return row.trajectory.length;
  }
}

function range(values: readonly number[]): { min: number; max: number } {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function sourceEpisode(row: EligibleEpisode) {
  return {
    episode_id: row.episode_id,
    task_cluster_id: row.task_cluster_id,
    l1_sha256: row.l1_sha256,
    verifier_receipt_id: row.verifier.verifier_receipt_id,
    closed_at: row.closed_at,
  };
}

function abstractionEvidence(
  rows: readonly EligibleEpisode[],
  feature: ContrastiveL2FeatureV1,
) {
  return rows.map((row) => ({
    episode_id: row.episode_id,
    task_cluster_id: row.task_cluster_id,
    l1_sha256: row.l1_sha256,
    verifier_receipt_id: row.verifier.verifier_receipt_id,
    feature_value: featureValue(row, feature),
  }));
}

function compileAbstraction(args: {
  feature: ContrastiveL2FeatureV1;
  successes: readonly EligibleEpisode[];
  failures: readonly EligibleEpisode[];
}): ContrastiveL2AbstractionV1 | null {
  const successEvidence = abstractionEvidence(args.successes, args.feature);
  const contrastEvidence = abstractionEvidence(args.failures, args.feature);
  const successfulRange = range(
    successEvidence.map((entry) => entry.feature_value),
  );
  const contrastRange = range(
    contrastEvidence.map((entry) => entry.feature_value),
  );

  const lower = successfulRange.max < contrastRange.min;
  const higher = successfulRange.min > contrastRange.max;
  if (!lower && !higher) return null;

  const operation = args.feature === "mutation_action_count"
    ? "bound_mutation_actions" as const
    : "bound_total_actions" as const;
  const material = {
    abstraction_id: `l2a_${sha256Hex(stableStringify({
      feature_id: args.feature,
      success_l1_sha256s: successEvidence.map((entry) => entry.l1_sha256),
      contrast_l1_sha256s: contrastEvidence.map((entry) => entry.l1_sha256),
    }))}`,
    feature_id: args.feature,
    relation: lower
      ? "successes_strictly_lower" as const
      : "successes_strictly_higher" as const,
    successful_range: successfulRange,
    contrast_range: contrastRange,
    portable_instruction: {
      operation,
      comparator: lower ? "lte" as const : "gte" as const,
      threshold: lower ? successfulRange.max : successfulRange.min,
    },
    success_evidence: successEvidence,
    contrast_evidence: contrastEvidence,
  };
  return {
    ...material,
    abstraction_sha256: contrastiveL2AbstractionDigest(material),
  };
}

function abstain(
  key: string,
  rows: readonly EligibleEpisode[],
  reason: ContrastiveL2AbstentionReason,
): ContrastiveL2CohortAbstention {
  return {
    status: "abstained",
    cohort_key: key,
    reason,
    eligible_episode_ids: rows.map((row) => row.episode_id),
  };
}

function compileCohort(
  key: string,
  input: readonly EligibleEpisode[],
): ContrastiveL2HypothesisV1 | ContrastiveL2CohortAbstention {
  const rows = [...input].sort((left, right) =>
    canonicalCompare(left.episode_id, right.episode_id));
  if (rows.length < 3) {
    return abstain(key, rows, "insufficient_eligible_episodes");
  }
  const successes = rows.filter((row) =>
    row.reward.outcome_class === "verified_pass");
  const failures = rows.filter((row) =>
    row.reward.outcome_class === "verified_failure");
  if (successes.length < 2) {
    return abstain(key, rows, "insufficient_successes");
  }
  if (failures.length < 1) {
    return abstain(key, rows, "insufficient_failures");
  }
  if (
    new Set(rows.map((row) => row.task_cluster_id)).size < 3
  ) {
    return abstain(key, rows, "insufficient_distinct_task_clusters");
  }

  const abstractions = (
    COMPILER_POLICY.admitted_features as readonly ContrastiveL2FeatureV1[]
  ).flatMap((feature) => {
    const compiled = compileAbstraction({ feature, successes, failures });
    return compiled ? [compiled] : [];
  });
  if (abstractions.length === 0) {
    return abstain(key, rows, "no_strict_structural_difference");
  }

  const sourceDatasetSha256 = sha256Hex(stableStringify(
    rows.map((row) => row.l1_sha256),
  ));
  const hypothesisId = `l2h_${sha256Hex(stableStringify({
    compiler_policy_sha256: COMPILER_POLICY_SHA256,
    source_dataset_sha256: sourceDatasetSha256,
    abstraction_sha256s: abstractions.map((entry) =>
      entry.abstraction_sha256),
  }))}`;
  const material = {
    contract_version: "contrastive_l2_hypothesis_v1" as const,
    layer: "L2" as const,
    hypothesis_id: hypothesisId,
    version: 1 as const,
    status: "candidate" as const,
    cohort: {
      tenant_id: rows[0]!.tenant_id,
      subject_kind: rows[0]!.subject_kind,
      verifier_kind: rows[0]!.verifier.verifier_kind,
      intervention_kind: "state_only" as const,
    },
    source_successes: successes.map(sourceEpisode),
    contrast_failures: failures.map(sourceEpisode),
    abstractions,
    procedure: {
      mode: "structural_guardrails" as const,
      abstraction_ids: abstractions.map((entry) => entry.abstraction_id),
      terminal_verifier_kind: rows[0]!.verifier.verifier_kind,
    },
    compiler: {
      compiler_id: "contrastive_l2_compiler_v1" as const,
      policy_sha256: COMPILER_POLICY_SHA256,
      source_dataset_sha256: sourceDatasetSha256,
    },
    literal_boundary: {
      policy: "structural_fields_only_v1" as const,
      task_text_copied: false as const,
      source_path_copied: false as const,
      request_or_result_content_copied: false as const,
    },
    evidence_cutoff_at: rows.reduce(
      (latest, row) => row.closed_at > latest ? row.closed_at : latest,
      rows[0]!.closed_at,
    ),
    production_prompt_eligible: false as const,
    validation_prompt_eligible: true as const,
  };
  return ContrastiveL2HypothesisV1Schema.parse({
    ...material,
    hypothesis_sha256: contrastiveL2HypothesisDigest(material),
  });
}

export function compileContrastiveL2Hypotheses(
  input: readonly CanonicalL1EpisodeV1[],
): ContrastiveL2Compilation {
  const uniqueByEpisode = new Map<string, EligibleEpisode>();
  for (const row of input) {
    if (!isEligibleStateOnly(row)) continue;
    const existing = uniqueByEpisode.get(row.episode_id);
    if (existing && existing.l1_sha256 !== row.l1_sha256) {
      throw new Error(
        `contrastive_l2_episode_digest_conflict:${row.episode_id}`,
      );
    }
    uniqueByEpisode.set(row.episode_id, row);
  }

  const cohorts = new Map<string, EligibleEpisode[]>();
  for (const row of uniqueByEpisode.values()) {
    const key = cohortKey(row);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(row);
    cohorts.set(key, cohort);
  }

  const candidates: ContrastiveL2HypothesisV1[] = [];
  const abstentions: ContrastiveL2CohortAbstention[] = [];
  for (const key of [...cohorts.keys()].sort(canonicalCompare)) {
    const result = compileCohort(key, cohorts.get(key)!);
    if ("hypothesis_id" in result) candidates.push(result);
    else abstentions.push(result);
  }

  if (cohorts.size === 0) {
    abstentions.push(abstain(
      stableStringify({ cohort: "none" }),
      [],
      "insufficient_eligible_episodes",
    ));
  }

  return {
    compiler_policy_sha256: COMPILER_POLICY_SHA256,
    candidates,
    abstentions,
  };
}
