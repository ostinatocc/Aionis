import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { sha256Hex } from "../util/crypto.js";
import { parsePolicyPatch, policyTouchedPaths } from "./rule-policy.js";

export const TOOL_RULE_EVALUATION_PROVENANCE_METADATA_KEY = "tool_rule_evaluation_provenance_v1" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CanonicalIdentifierSchema = z.string().min(1).max(512).refine(
  (value) => value === value.trim(),
  "Expected identifier without surrounding whitespace",
);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function isCanonicalStrings(values: readonly string[]): boolean {
  const canonical = canonicalStrings(values);
  return canonical.length === values.length && canonical.every((value, index) => value === values[index]);
}

const CanonicalTouchedPathsSchema = z.array(CanonicalIdentifierSchema).max(256).superRefine((values, context) => {
  if (!isCanonicalStrings(values)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "touched_paths must be unique and use canonical UTF-8 byte ordering",
    });
  }
});

export const ToolRuleEvaluationSourceSchema = z.object({
  rule_node_id: CanonicalIdentifierSchema,
  state: z.enum(["active", "shadow"]),
  commit_id: CanonicalIdentifierSchema,
  touched_paths: CanonicalTouchedPathsSchema,
  row_sha256: Sha256Schema,
}).strict();

export type ToolRuleEvaluationSource = z.infer<typeof ToolRuleEvaluationSourceSchema>;

export type ToolRuleEvaluationSourceRow = {
  rule_node_id: string;
  state: "draft" | "shadow" | "active" | "disabled";
  rule_scope: "global" | "team" | "agent";
  target_agent_id: string | null;
  target_team_id: string | null;
  rule_memory_lane: "private" | "shared";
  rule_owner_agent_id: string | null;
  rule_owner_team_id: string | null;
  if_json: Record<string, unknown>;
  then_json: Record<string, unknown>;
  exceptions_json: unknown[];
  rule_slots: Record<string, unknown>;
  rule_commit_id?: string | null;
  commit_id?: string | null;
};

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function resolveToolRuleRankControls(
  ruleSlots: Record<string, unknown>,
): { priority: number; weight: number } {
  const ruleMeta = ruleSlots.rule_meta;
  const meta = ruleMeta && typeof ruleMeta === "object" && !Array.isArray(ruleMeta)
    ? ruleMeta as Record<string, unknown>
    : {};
  return {
    priority: clamp(Math.trunc(finiteNumber(meta.priority ?? ruleSlots.priority, 0)), -100, 100),
    weight: clamp(finiteNumber(meta.weight ?? ruleSlots.weight, 1), 0, 2),
  };
}

export function buildToolRuleEvaluationSource(row: ToolRuleEvaluationSourceRow): ToolRuleEvaluationSource {
  if (row.state !== "active" && row.state !== "shadow") {
    throw new Error("tool rule evaluation provenance requires an active or shadow rule");
  }
  const commitId = row.rule_commit_id ?? row.commit_id;
  if (!commitId) throw new Error("tool rule evaluation provenance requires a rule commit id");
  const thenJson = parsePolicyPatch(row.then_json);
  const touchedPaths = canonicalStrings(policyTouchedPaths(thenJson));
  const rankControls = resolveToolRuleRankControls(row.rule_slots);
  const rowSha256 = sha256Hex(stableStringify({
    rule_node_id: row.rule_node_id,
    state: row.state,
    rule_scope: row.rule_scope,
    target_agent_id: row.target_agent_id,
    target_team_id: row.target_team_id,
    rule_memory_lane: row.rule_memory_lane,
    rule_owner_agent_id: row.rule_owner_agent_id,
    rule_owner_team_id: row.rule_owner_team_id,
    if_json: row.if_json,
    then_json: thenJson,
    exceptions_json: row.exceptions_json,
    commit_id: commitId,
    rank_controls: rankControls,
    touched_paths: touchedPaths,
  }));
  return ToolRuleEvaluationSourceSchema.parse({
    rule_node_id: row.rule_node_id,
    state: row.state,
    commit_id: commitId,
    touched_paths: touchedPaths,
    row_sha256: rowSha256,
  });
}

function sourceCanonicalKey(source: ToolRuleEvaluationSource): string {
  return stableStringify([
    source.rule_node_id,
    source.state,
    source.commit_id,
    source.touched_paths,
    source.row_sha256,
  ]);
}

export function canonicalToolRuleEvaluationSources(
  values: readonly ToolRuleEvaluationSource[],
): ToolRuleEvaluationSource[] {
  const parsed = values.map((value) => ToolRuleEvaluationSourceSchema.parse(value));
  return parsed.sort((left, right) => compareUtf8(sourceCanonicalKey(left), sourceCanonicalKey(right)));
}

function isCanonicalSources(values: readonly ToolRuleEvaluationSource[]): boolean {
  const canonical = canonicalToolRuleEvaluationSources(values);
  return canonical.length === values.length
    && canonical.every((source, index) => stableStringify(source) === stableStringify(values[index]));
}

const ToolRuleEvaluationProvenanceBodyShape = {
  schema_version: z.literal("tool_rule_evaluation_provenance_v1"),
  effective_context_sha256: Sha256Schema,
  policy_sha256: Sha256Schema,
  include_shadow: z.boolean(),
  rules_limit: z.number().int().positive().max(200),
  active_sources: z.array(ToolRuleEvaluationSourceSchema).max(200),
  shadow_sources: z.array(ToolRuleEvaluationSourceSchema).max(200),
} as const;

const ToolRuleEvaluationProvenanceBodySchema = z.object(ToolRuleEvaluationProvenanceBodyShape).strict().superRefine((value, context) => {
  if (!isCanonicalSources(value.active_sources)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["active_sources"],
      message: "active_sources must be unique and use canonical UTF-8 byte ordering",
    });
  }
  if (!isCanonicalSources(value.shadow_sources)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shadow_sources"],
      message: "shadow_sources must be unique and use canonical UTF-8 byte ordering",
    });
  }
  if (value.active_sources.some((source) => source.state !== "active")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["active_sources"], message: "Expected active sources" });
  }
  if (value.shadow_sources.some((source) => source.state !== "shadow")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["shadow_sources"], message: "Expected shadow sources" });
  }
  if (!value.include_shadow && value.shadow_sources.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shadow_sources"],
      message: "shadow_sources must be empty when include_shadow is false",
    });
  }
  const sourceIds = [...value.active_sources, ...value.shadow_sources].map((source) => source.rule_node_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["active_sources"],
      message: "rule_node_id must be unique across active_sources and shadow_sources",
    });
  }
});

export type ToolRuleEvaluationProvenanceBody = z.infer<typeof ToolRuleEvaluationProvenanceBodySchema>;

export function toolRuleEvaluationProvenanceSha256(
  value: ToolRuleEvaluationProvenanceBody & { provenance_sha256?: string },
): string {
  const body = ToolRuleEvaluationProvenanceBodySchema.parse({
    schema_version: value.schema_version,
    effective_context_sha256: value.effective_context_sha256,
    policy_sha256: value.policy_sha256,
    include_shadow: value.include_shadow,
    rules_limit: value.rules_limit,
    active_sources: value.active_sources,
    shadow_sources: value.shadow_sources,
  });
  return sha256Hex(stableStringify(body));
}

export const ToolRuleEvaluationProvenanceSchema = z.object({
  ...ToolRuleEvaluationProvenanceBodyShape,
  provenance_sha256: Sha256Schema,
}).strict().superRefine((value, context) => {
  const body = ToolRuleEvaluationProvenanceBodySchema.safeParse({
    schema_version: value.schema_version,
    effective_context_sha256: value.effective_context_sha256,
    policy_sha256: value.policy_sha256,
    include_shadow: value.include_shadow,
    rules_limit: value.rules_limit,
    active_sources: value.active_sources,
    shadow_sources: value.shadow_sources,
  });
  if (!body.success) {
    for (const issue of body.error.issues) context.addIssue(issue);
    return;
  }
  if (toolRuleEvaluationProvenanceSha256(value) !== value.provenance_sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provenance_sha256"],
      message: "provenance_sha256 does not match the canonical provenance body",
    });
  }
});

export type ToolRuleEvaluationProvenance = z.infer<typeof ToolRuleEvaluationProvenanceSchema>;

export function buildToolRuleEvaluationProvenance(args: {
  effective_context_sha256: string;
  policy_sha256: string;
  include_shadow: boolean;
  rules_limit: number;
  active_sources: readonly ToolRuleEvaluationSource[];
  shadow_sources: readonly ToolRuleEvaluationSource[];
}): ToolRuleEvaluationProvenance {
  const body = ToolRuleEvaluationProvenanceBodySchema.parse({
    schema_version: "tool_rule_evaluation_provenance_v1",
    effective_context_sha256: args.effective_context_sha256,
    policy_sha256: args.policy_sha256,
    include_shadow: args.include_shadow,
    rules_limit: args.rules_limit,
    active_sources: canonicalToolRuleEvaluationSources(args.active_sources),
    shadow_sources: canonicalToolRuleEvaluationSources(args.shadow_sources),
  });
  return ToolRuleEvaluationProvenanceSchema.parse({
    ...body,
    provenance_sha256: toolRuleEvaluationProvenanceSha256(body),
  });
}

export function verifyToolRuleEvaluationProvenance(value: unknown): value is ToolRuleEvaluationProvenance {
  return ToolRuleEvaluationProvenanceSchema.safeParse(value).success;
}

export function readToolRuleEvaluationProvenance(
  metadata: Record<string, unknown> | null | undefined,
): ToolRuleEvaluationProvenance | null {
  const parsed = ToolRuleEvaluationProvenanceSchema.safeParse(
    metadata?.[TOOL_RULE_EVALUATION_PROVENANCE_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}
