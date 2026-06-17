import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const AionisClaimConflictPolicySchema = z.enum([
  "singleton_latest",
  "multi_value",
  "accumulative_evidence",
  "manual_or_inspect",
]);

export const AionisClaimAuthoritySchema = z.enum([
  "evidence_only",
  "advisory",
  "trusted",
  "blocked",
]);

export const AionisClaimKindSchema = z.enum([
  "ordinary_fact",
  "preference",
  "project_fact",
  "execution_fact",
  "external_fact",
]);

export const AionisClaimWriteSchema = z
  .object({
    contract_version: z.literal("aionis_claim_write_v1"),
    client_id: nonEmptyString.optional(),
    subject_key: nonEmptyString,
    predicate: nonEmptyString,
    value: z.unknown(),
    value_text: z.string().trim().max(2_000).optional(),
    slot_key: nonEmptyString.optional(),
    claim_kind: AionisClaimKindSchema.default("ordinary_fact"),
    conflict_policy: AionisClaimConflictPolicySchema.default("manual_or_inspect"),
    authority: AionisClaimAuthoritySchema.default("advisory"),
    confidence: z.number().min(0).max(1).default(0.5),
    valid_from: z.string().datetime().optional(),
    evidence_refs: z.array(nonEmptyString).max(32).default([]),
    source_memory_id: nonEmptyString.optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((claim, ctx) => {
    if (claim.conflict_policy === "singleton_latest" && !claim.slot_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slot_key"],
        message: "singleton_latest claims require slot_key",
      });
    }
    if (claim.authority === "trusted" && claim.evidence_refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_refs"],
        message: "trusted claims require evidence_refs",
      });
    }
  });

export type AionisClaimConflictPolicy = z.infer<typeof AionisClaimConflictPolicySchema>;
export type AionisClaimAuthority = z.infer<typeof AionisClaimAuthoritySchema>;
export type AionisClaimKind = z.infer<typeof AionisClaimKindSchema>;
export type AionisClaimWrite = z.infer<typeof AionisClaimWriteSchema>;

