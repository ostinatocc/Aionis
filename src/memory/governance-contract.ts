import { z } from "zod";

export const AionisGuidanceAuthoritySchema = z.enum(["trusted", "advisory", "candidate", "blocked", "none"]);
export type AionisGuidanceAuthority = z.infer<typeof AionisGuidanceAuthoritySchema>;

export const AionisMemoryDecisionSurfaceSchema = z.enum([
  "use_now",
  "inspect_before_use",
  "do_not_use",
  "rehydrate",
  "not_agent_facing",
]);
export type AionisMemoryDecisionSurface = z.infer<typeof AionisMemoryDecisionSurfaceSchema>;

const GovernanceDecisionFields = {
  memory_id: z.string().min(1),
  authority: AionisGuidanceAuthoritySchema,
  lifecycle_state: z.string().min(1),
  reason_codes: z.array(z.string().min(1).max(128)).max(16),
  target_files: z.array(z.string().min(1).max(2048)).max(16),
};

export const GovernanceDecisionV1Schema = z.discriminatedUnion("surface", [
  z.object({
    ...GovernanceDecisionFields,
    surface: z.literal("use_now"),
    actionable: z.literal(true),
    requires_rehydrate: z.literal(false),
  }).strict(),
  z.object({
    ...GovernanceDecisionFields,
    surface: z.enum(["inspect_before_use", "do_not_use", "not_agent_facing"]),
    actionable: z.literal(false),
    requires_rehydrate: z.literal(false),
  }).strict(),
  z.object({
    ...GovernanceDecisionFields,
    surface: z.literal("rehydrate"),
    actionable: z.literal(false),
    requires_rehydrate: z.literal(true),
  }).strict(),
]);
export type GovernanceDecisionV1 = z.infer<typeof GovernanceDecisionV1Schema>;
