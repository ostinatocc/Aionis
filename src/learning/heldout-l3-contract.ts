import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { ExecutionEpisodeSha256Schema } from
  "../memory/execution-episode.js";
import { sha256Hex } from "../util/crypto.js";

const ExactIdSchema = z.string().trim().min(1).max(256);

const HeldoutL3CellMaterialV1Schema = z.object({
  contract_version: z.literal("heldout_l3_cell_receipt_v1"),
  cell_id: ExactIdSchema,
  task_id: ExactIdSchema,
  task_source_id: ExactIdSchema,
  task_seed_sha256: ExecutionEpisodeSha256Schema,
  arm: z.enum(["state_only", "state_plus_candidate_skill"]),
  candidate_context_sha256:
    ExecutionEpisodeSha256Schema.nullable(),
  requested_model_version_label: ExactIdSchema,
  provider_api_model_id: ExactIdSchema,
  served_model_id: ExactIdSchema,
  system_fingerprint: ExactIdSchema,
  model_receipt_chain_sha256: ExecutionEpisodeSha256Schema,
  episode_id: ExactIdSchema,
  verifier_receipt_id: ExactIdSchema,
  verified_success: z.union([z.literal(0), z.literal(1)]),
  outcome_class: z.enum(["verified_pass", "verified_failure"]),
  total_tokens: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
  source_summary_sha256: ExecutionEpisodeSha256Schema,
  evidence_completion_authority: z.enum([
    "source_summary",
    "runtime_reopen_integrity_supplement",
  ]),
  integrity_supplement_sha256:
    ExecutionEpisodeSha256Schema.nullable(),
  evidence_complete: z.literal(true),
}).strict();

export const HeldoutL3CellReceiptV1Schema =
  HeldoutL3CellMaterialV1Schema.extend({
    cell_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    const { cell_sha256, ...material } = value;
    if (
      cell_sha256 !== sha256Hex(stableStringify(
        HeldoutL3CellMaterialV1Schema.parse(material),
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cell_sha256"],
        message: "Held-out cell digest does not bind its evidence",
      });
    }
    if (
      (value.arm === "state_only")
      !== (value.candidate_context_sha256 === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidate_context_sha256"],
        message: "Only the candidate arm may contain candidate context",
      });
    }
    if (
      value.verified_success
      !== (value.outcome_class === "verified_pass" ? 1 : 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verified_success"],
        message: "Verified success must match the outcome class",
      });
    }
    if (
      (value.evidence_completion_authority === "source_summary")
      !== (value.integrity_supplement_sha256 === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["integrity_supplement_sha256"],
        message:
          "Supplement authority requires a supplement digest, and summary authority forbids one",
      });
    }
  });

export type HeldoutL3CellReceiptV1 = z.infer<
  typeof HeldoutL3CellReceiptV1Schema
>;

export function heldoutL3CellDigest(
  value: Omit<HeldoutL3CellReceiptV1, "cell_sha256">,
): string {
  return sha256Hex(stableStringify(
    HeldoutL3CellMaterialV1Schema.parse(value),
  ));
}

const HeldoutL3TaskPairV1Schema = z.object({
  task_id: ExactIdSchema,
  task_source_id: ExactIdSchema,
  task_seed_sha256: ExecutionEpisodeSha256Schema,
  control: HeldoutL3CellReceiptV1Schema,
  candidate: HeldoutL3CellReceiptV1Schema,
  verified_success_delta: z.union([
    z.literal(-1),
    z.literal(0),
    z.literal(1),
  ]),
  token_delta: z.number().int(),
  tool_call_delta: z.number().int(),
  elapsed_ms_delta: z.number().int(),
}).strict();

const HeldoutL3SkillVersionMaterialV1Schema = z.object({
  contract_version: z.literal("heldout_l3_skill_version_v1"),
  layer: z.literal("L3"),
  skill_id: ExactIdSchema,
  version: z.literal(1),
  status: z.enum(["validated", "rejected", "contested"]),
  source_hypothesis_id: ExactIdSchema,
  source_hypothesis_sha256: ExecutionEpisodeSha256Schema,
  candidate_context_sha256: ExecutionEpisodeSha256Schema,
  protocol_sha256: ExecutionEpisodeSha256Schema,
  model_authority: z.object({
    requested_model_version_label: ExactIdSchema,
    provider_api_model_id: ExactIdSchema,
    served_model_id: ExactIdSchema,
    system_fingerprint: ExactIdSchema,
  }).strict(),
  task_pairs: z.array(HeldoutL3TaskPairV1Schema).min(1).max(10_000),
  aggregate: z.object({
    distinct_task_source_count: z.number().int().positive(),
    control_verified_pass_count: z.number().int().nonnegative(),
    candidate_verified_pass_count: z.number().int().nonnegative(),
    positive_transfer_count: z.number().int().nonnegative(),
    negative_transfer_count: z.number().int().nonnegative(),
    total_token_delta: z.number().int(),
    total_tool_call_delta: z.number().int(),
    total_elapsed_ms_delta: z.number().int(),
  }).strict(),
  decision_policy: z.literal(
    "two_source_verified_uplift_no_negative_transfer_v1",
  ),
  decision_reason_codes: z.array(ExactIdSchema).min(1).max(32),
  production_prompt_eligible: z.boolean(),
  validation_prompt_eligible: z.boolean(),
}).strict();

export const HeldoutL3SkillVersionV1Schema =
  HeldoutL3SkillVersionMaterialV1Schema.extend({
    skill_version_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    const { skill_version_sha256, ...material } = value;
    if (
      skill_version_sha256 !== sha256Hex(stableStringify(
        HeldoutL3SkillVersionMaterialV1Schema.parse(material),
      ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skill_version_sha256"],
        message: "L3 skill version digest does not bind its evidence",
      });
    }
    for (let index = 1; index < value.task_pairs.length; index += 1) {
      if (
        Buffer.compare(
          Buffer.from(value.task_pairs[index - 1]!.task_id, "utf8"),
          Buffer.from(value.task_pairs[index]!.task_id, "utf8"),
        ) >= 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["task_pairs"],
          message: "Held-out task pairs must be unique and sorted",
        });
        break;
      }
    }
    for (
      let index = 1;
      index < value.decision_reason_codes.length;
      index += 1
    ) {
      if (
        Buffer.compare(
          Buffer.from(
            value.decision_reason_codes[index - 1]!,
            "utf8",
          ),
          Buffer.from(value.decision_reason_codes[index]!, "utf8"),
        ) >= 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decision_reason_codes"],
          message: "Decision reasons must be unique and sorted",
        });
        break;
      }
    }
    if (
      value.production_prompt_eligible
      !== (value.status === "validated")
      || value.validation_prompt_eligible
      !== (value.status === "contested")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["production_prompt_eligible"],
        message: "Prompt eligibility must follow the L3 status",
      });
    }
  });

export type HeldoutL3SkillVersionV1 = z.infer<
  typeof HeldoutL3SkillVersionV1Schema
>;

export function heldoutL3SkillVersionDigest(
  value: Omit<HeldoutL3SkillVersionV1, "skill_version_sha256">,
): string {
  return sha256Hex(stableStringify(
    HeldoutL3SkillVersionMaterialV1Schema.parse(value),
  ));
}
