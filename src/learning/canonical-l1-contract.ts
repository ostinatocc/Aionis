import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import {
  EpisodeRewardV1Schema,
  ExecutionCostReceiptV1Schema,
  ExecutionEpisodeCanonicalUtcTimestampSchema,
  ExecutionEpisodeSha256Schema,
} from "../memory/execution-episode.js";
import { sha256Hex } from "../util/crypto.js";

const ExactIdSchema = z.string().trim().min(1).max(256);
const ExactReferenceSchema = z.string().trim().min(1).max(2_048);

export const CanonicalL1MemoryLayerV1Schema = z.enum([
  "ordinary_memory",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "unknown",
]);

export type CanonicalL1MemoryLayerV1 = z.infer<
  typeof CanonicalL1MemoryLayerV1Schema
>;

export const CanonicalL1InterventionKindV1Schema = z.enum([
  "state_only",
  "state_plus_memory",
  "state_plus_candidate_skill",
  "state_plus_validated_skill",
  "mixed_skill",
]);

export type CanonicalL1InterventionKindV1 = z.infer<
  typeof CanonicalL1InterventionKindV1Schema
>;

const CanonicalL1DeliveredMemoryV1Schema = z.object({
  memory_id: ExactIdSchema,
  served_surface: z.enum([
    "use_now",
    "inspect_before_use",
    "do_not_use",
    "rehydrate",
  ]),
  learning_layer: CanonicalL1MemoryLayerV1Schema,
  source_commit_id: ExactIdSchema.nullable(),
  artifact_sha256: ExecutionEpisodeSha256Schema.nullable(),
}).strict();

const CanonicalL1GuideInterventionV1Schema = z.object({
  decision_event_id: ExactIdSchema,
  decision_id: ExactIdSchema,
  decision_sha256: ExecutionEpisodeSha256Schema,
  target_state_snapshot_id: ExactIdSchema,
  guide_trace_id: ExactIdSchema,
  guide_receipt_sha256: ExecutionEpisodeSha256Schema,
  candidate_set_sha256: ExecutionEpisodeSha256Schema,
  policy_id: ExactIdSchema,
  policy_version: ExactIdSchema,
  intervention_kind: CanonicalL1InterventionKindV1Schema,
  delivered_memory: z.array(CanonicalL1DeliveredMemoryV1Schema).max(200),
  committed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

const CanonicalL1ActualUseV1Schema = z.object({
  feedback_operation_id: ExactIdSchema,
  feedback_request_sha256: ExecutionEpisodeSha256Schema,
  guide_trace_id: ExactIdSchema,
  memory_id: ExactIdSchema,
  served_surface: z.enum([
    "use_now",
    "inspect_before_use",
    "do_not_use",
    "rehydrate",
  ]),
  reported_surface: z.enum([
    "use_now",
    "inspect_before_use",
    "do_not_use",
    "explicit_host_assertion",
  ]),
  outcome: z.enum(["positive", "negative", "neutral"]),
  verifier_status: z.enum([
    "passed",
    "failed",
    "not_run",
    "unknown",
  ]).nullable(),
  tool_status: z.enum([
    "succeeded",
    "failed",
    "not_run",
    "unknown",
  ]).nullable(),
  verified_host_receipt: z.boolean(),
  runtime_signal_refs: z.array(ExactReferenceSchema).max(64),
  recorded_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

const CanonicalL1EpisodeMaterialV1Schema = z.object({
  contract_version: z.literal("canonical_l1_episode_v1"),
  dataset_version: z.literal("canonical_l1_dataset_v1"),
  layer: z.literal("L1"),
  l1_episode_id: ExactIdSchema,
  episode_id: ExactIdSchema,
  tenant_id: ExactIdSchema,
  public_scope: ExactIdSchema,
  store_scope: ExactIdSchema,
  task_id: ExactIdSchema,
  task_cluster_id: ExactIdSchema,
  task_cluster_policy_version: ExactIdSchema,
  task_envelope_sha256: ExecutionEpisodeSha256Schema,
  task_manifest_sha256: ExecutionEpisodeSha256Schema,
  source_task_ref: ExactReferenceSchema,
  run_id: ExactIdSchema,
  model_id: ExactIdSchema,
  model_config_sha256: ExecutionEpisodeSha256Schema,
  subject_kind: ExactIdSchema,
  subject_identity_sha256: ExecutionEpisodeSha256Schema,
  trajectory: z.array(z.object({
    event_id: ExactIdSchema,
    sequence: z.number().int().nonnegative(),
    action_id: ExactIdSchema,
    action_kind: ExactIdSchema,
    capability_id: ExactIdSchema,
    mutation: z.boolean(),
    request_ref: ExactReferenceSchema,
    result_ref: ExactReferenceSchema,
    state_before_snapshot_id: ExactIdSchema,
    state_after_snapshot_id: ExactIdSchema,
    state_delta_ref: ExactReferenceSchema.nullable(),
    occurred_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
  }).strict()).max(100_000),
  verifier: z.object({
    verifier_receipt_id: ExactIdSchema,
    verifier_id: ExactIdSchema,
    verifier_kind: ExactIdSchema,
    verifier_version: ExactIdSchema,
    verifier_program_sha256: ExecutionEpisodeSha256Schema,
    verifier_config_sha256: ExecutionEpisodeSha256Schema,
    verified_state_snapshot_id: ExactIdSchema,
    output_ref: ExactReferenceSchema,
    status: z.enum(["passed", "failed"]),
  }).strict(),
  event_count: z.number().int().positive(),
  event_chain_head_sha256: ExecutionEpisodeSha256Schema,
  intervention_kind: CanonicalL1InterventionKindV1Schema,
  interventions: z.array(CanonicalL1GuideInterventionV1Schema).max(10_000),
  actual_use: z.array(CanonicalL1ActualUseV1Schema).max(100_000),
  reward: EpisodeRewardV1Schema,
  cost_receipt: ExecutionCostReceiptV1Schema.nullable(),
  contamination: z.object({
    status: z.enum(["clean", "contaminated"]),
    reasons: z.array(ExactIdSchema).max(64),
  }).strict(),
  learning_eligibility: z.object({
    eligible: z.boolean(),
    reason_codes: z.array(ExactIdSchema).max(64),
  }).strict(),
  source_guide_receipt_sha256s: z.array(ExecutionEpisodeSha256Schema)
    .max(10_000),
  source_feedback_request_sha256s: z.array(ExecutionEpisodeSha256Schema)
    .max(100_000),
  closed_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

export const CanonicalL1EpisodeV1Schema =
  CanonicalL1EpisodeMaterialV1Schema.extend({
    l1_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    const { l1_sha256: supplied, ...material } = value;
    if (supplied !== sha256Hex(stableStringify(
      CanonicalL1EpisodeMaterialV1Schema.parse(material),
    ))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["l1_sha256"],
        message: "L1 digest does not bind the canonical episode row",
      });
    }
    for (const [path, values] of [
      ["source_guide_receipt_sha256s", value.source_guide_receipt_sha256s],
      [
        "source_feedback_request_sha256s",
        value.source_feedback_request_sha256s,
      ],
      ["contamination.reasons", value.contamination.reasons],
      [
        "learning_eligibility.reason_codes",
        value.learning_eligibility.reason_codes,
      ],
    ] as const) {
      for (let index = 1; index < values.length; index += 1) {
        if (Buffer.compare(
          Buffer.from(values[index - 1]!, "utf8"),
          Buffer.from(values[index]!, "utf8"),
        ) >= 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: path.split("."),
            message: "Canonical L1 sets must be unique and UTF-8 sorted",
          });
          break;
        }
      }
    }
  });

export type CanonicalL1EpisodeV1 = z.infer<
  typeof CanonicalL1EpisodeV1Schema
>;

export function canonicalL1EpisodeDigest(
  value: Omit<CanonicalL1EpisodeV1, "l1_sha256">,
): string {
  return sha256Hex(stableStringify(
    CanonicalL1EpisodeMaterialV1Schema.parse(value),
  ));
}
