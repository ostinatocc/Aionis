import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  ExecutionEpisodeCanonicalUtcTimestampSchema,
  ExecutionEpisodeSha256Schema,
} from "../memory/execution-episode.js";
import { sha256Hex } from "../util/crypto.js";

const ExactIdSchema = z.string().trim().min(1).max(256);

export const ContrastiveL2FeatureV1Schema = z.enum([
  "mutation_action_count",
  "total_action_count",
]);

export type ContrastiveL2FeatureV1 = z.infer<
  typeof ContrastiveL2FeatureV1Schema
>;

const ContrastiveL2EpisodeEvidenceV1Schema = z.object({
  episode_id: ExactIdSchema,
  task_cluster_id: ExactIdSchema,
  l1_sha256: ExecutionEpisodeSha256Schema,
  verifier_receipt_id: ExactIdSchema,
  feature_value: z.number().int().nonnegative(),
}).strict();

const ContrastiveL2AbstractionMaterialV1Schema = z.object({
  abstraction_id: ExactIdSchema,
  feature_id: ContrastiveL2FeatureV1Schema,
  relation: z.enum([
    "successes_strictly_lower",
    "successes_strictly_higher",
  ]),
  successful_range: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }).strict(),
  contrast_range: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }).strict(),
  portable_instruction: z.object({
    operation: z.enum([
      "bound_mutation_actions",
      "bound_total_actions",
    ]),
    comparator: z.enum(["lte", "gte"]),
    threshold: z.number().int().nonnegative(),
  }).strict(),
  success_evidence: z.array(ContrastiveL2EpisodeEvidenceV1Schema)
    .min(2)
    .max(100_000),
  contrast_evidence: z.array(ContrastiveL2EpisodeEvidenceV1Schema)
    .min(1)
    .max(100_000),
}).strict();

export const ContrastiveL2AbstractionV1Schema =
  ContrastiveL2AbstractionMaterialV1Schema.extend({
    abstraction_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    const { abstraction_sha256, ...material } = value;
    if (
      abstraction_sha256
      !== sha256Hex(stableStringify(
        ContrastiveL2AbstractionMaterialV1Schema.parse(material),
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["abstraction_sha256"],
        message: "Abstraction digest does not bind its evidence",
      });
    }
    for (const [key, evidence] of [
      ["success_evidence", value.success_evidence],
      ["contrast_evidence", value.contrast_evidence],
    ] as const) {
      for (let index = 1; index < evidence.length; index += 1) {
        if (
          Buffer.compare(
            Buffer.from(evidence[index - 1]!.episode_id, "utf8"),
            Buffer.from(evidence[index]!.episode_id, "utf8"),
          ) >= 0
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "Abstraction evidence must be unique and sorted",
          });
          break;
        }
      }
    }
  });

export type ContrastiveL2AbstractionV1 = z.infer<
  typeof ContrastiveL2AbstractionV1Schema
>;

export function contrastiveL2AbstractionDigest(
  value: Omit<ContrastiveL2AbstractionV1, "abstraction_sha256">,
): string {
  return sha256Hex(stableStringify(
    ContrastiveL2AbstractionMaterialV1Schema.parse(value),
  ));
}

const ContrastiveL2SourceEpisodeV1Schema = z.object({
  episode_id: ExactIdSchema,
  task_cluster_id: ExactIdSchema,
  l1_sha256: ExecutionEpisodeSha256Schema,
  verifier_receipt_id: ExactIdSchema,
  closed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

const ContrastiveL2HypothesisMaterialV1Schema = z.object({
  contract_version: z.literal("contrastive_l2_hypothesis_v1"),
  layer: z.literal("L2"),
  hypothesis_id: ExactIdSchema,
  version: z.literal(1),
  status: z.literal("candidate"),
  cohort: z.object({
    tenant_id: ExactIdSchema,
    subject_kind: ExactIdSchema,
    verifier_kind: ExactIdSchema,
    intervention_kind: z.literal("state_only"),
  }).strict(),
  source_successes: z.array(ContrastiveL2SourceEpisodeV1Schema)
    .min(2)
    .max(100_000),
  contrast_failures: z.array(ContrastiveL2SourceEpisodeV1Schema)
    .min(1)
    .max(100_000),
  abstractions: z.array(ContrastiveL2AbstractionV1Schema)
    .min(1)
    .max(16),
  procedure: z.object({
    mode: z.literal("structural_guardrails"),
    abstraction_ids: z.array(ExactIdSchema).min(1).max(16),
    terminal_verifier_kind: ExactIdSchema,
  }).strict(),
  compiler: z.object({
    compiler_id: z.literal("contrastive_l2_compiler_v1"),
    policy_sha256: ExecutionEpisodeSha256Schema,
    source_dataset_sha256: ExecutionEpisodeSha256Schema,
  }).strict(),
  literal_boundary: z.object({
    policy: z.literal("structural_fields_only_v1"),
    task_text_copied: z.literal(false),
    source_path_copied: z.literal(false),
    request_or_result_content_copied: z.literal(false),
  }).strict(),
  evidence_cutoff_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
  production_prompt_eligible: z.literal(false),
  validation_prompt_eligible: z.literal(true),
}).strict();

export const ContrastiveL2HypothesisV1Schema =
  ContrastiveL2HypothesisMaterialV1Schema.extend({
    hypothesis_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    const { hypothesis_sha256, ...material } = value;
    if (
      hypothesis_sha256
      !== sha256Hex(stableStringify(
        ContrastiveL2HypothesisMaterialV1Schema.parse(material),
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hypothesis_sha256"],
        message: "Hypothesis digest does not bind its canonical content",
      });
    }

    for (const [key, evidence] of [
      ["source_successes", value.source_successes],
      ["contrast_failures", value.contrast_failures],
    ] as const) {
      for (let index = 1; index < evidence.length; index += 1) {
        if (
          Buffer.compare(
            Buffer.from(evidence[index - 1]!.episode_id, "utf8"),
            Buffer.from(evidence[index]!.episode_id, "utf8"),
          ) >= 0
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: "Source evidence must be unique and sorted",
          });
          break;
        }
      }
    }

    const allSources = [
      ...value.source_successes,
      ...value.contrast_failures,
    ];
    if (
      new Set(allSources.map((entry) => entry.episode_id)).size
      !== allSources.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contrast_failures"],
        message: "Success and failure evidence must be disjoint",
      });
    }
    if (
      new Set(allSources.map((entry) => entry.task_cluster_id)).size < 3
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_successes"],
        message: "A portable L2 candidate requires three task clusters",
      });
    }

    const abstractionIds = value.abstractions.map((entry) =>
      entry.abstraction_id);
    if (
      stableStringify(value.procedure.abstraction_ids)
      !== stableStringify(abstractionIds)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["procedure", "abstraction_ids"],
        message: "Procedure must reference every abstraction in order",
      });
    }

    const expectedSuccessIds = value.source_successes.map((entry) =>
      entry.episode_id);
    const expectedFailureIds = value.contrast_failures.map((entry) =>
      entry.episode_id);
    for (const [index, abstraction] of value.abstractions.entries()) {
      if (
        stableStringify(
          abstraction.success_evidence.map((entry) => entry.episode_id),
        ) !== stableStringify(expectedSuccessIds)
        || stableStringify(
          abstraction.contrast_evidence.map((entry) => entry.episode_id),
        ) !== stableStringify(expectedFailureIds)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["abstractions", index],
          message: "Every abstraction must trace to the complete cohort",
        });
      }
    }
  });

export type ContrastiveL2HypothesisV1 = z.infer<
  typeof ContrastiveL2HypothesisV1Schema
>;

export function contrastiveL2HypothesisDigest(
  value: Omit<ContrastiveL2HypothesisV1, "hypothesis_sha256">,
): string {
  return sha256Hex(stableStringify(
    ContrastiveL2HypothesisMaterialV1Schema.parse(value),
  ));
}
