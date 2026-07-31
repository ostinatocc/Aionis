import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";

import { sha256Hex } from "../util/crypto.js";
import {
  CanonicalL1EpisodeV1Schema,
} from "../learning/canonical-l1-contract.js";
import {
  ContrastiveL2HypothesisV1Schema,
} from "../learning/contrastive-l2-contract.js";
import {
  HeldoutL3SkillVersionV1Schema,
} from "../learning/heldout-l3-contract.js";
import {
  ExecutionEpisodeCanonicalUtcTimestampSchema,
  ExecutionEpisodeSha256Schema,
} from "./execution-episode.js";

export const EXECUTION_PREDICATE_MAX_DEPTH = 8;
export const EXECUTION_PREDICATE_MAX_NODES = 64;
export const EXECUTION_PREDICATE_MAX_CHILDREN = 16;
export const EXECUTION_PROCEDURE_MAX_PARAMETERS = 64;
export const EXECUTION_PROCEDURE_MAX_STEPS = 128;
export const EXECUTION_PROCEDURE_MAX_BINDINGS_PER_STEP = 64;
export const EXECUTION_SKILL_MAX_EVIDENCE_REFS = 4_096;

function exactBoundedString(
  label: string,
  maxUtf8Bytes: number,
): z.ZodEffects<z.ZodString, string, string> {
  return z.string().min(1).max(maxUtf8Bytes).superRefine((value, context) => {
    if (
      value !== value.trim()
      || Buffer.byteLength(value, "utf8") > maxUtf8Bytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${label} must be exact, trimmed, and at most ${maxUtf8Bytes} UTF-8 bytes`,
      });
    }
  });
}

const BoundedIdSchema = exactBoundedString("Identifier", 256);
const BoundedVersionSchema = exactBoundedString("Version", 256);
const BoundedReferenceSchema = exactBoundedString("Reference", 2_048);
const BoundedDescriptionSchema = exactBoundedString("Description", 16_384);
const BoundedCompactTextSchema = exactBoundedString("Compact text", 4_096);
const BoundedEnumValueSchema = exactBoundedString("Bounded enum value", 256);
const BoundedFieldIdSchema = exactBoundedString("Field identifier", 256);
const BoundedBindingKeySchema = exactBoundedString("Binding key", 256);

const BoundedLiteralValueSchema = z.union([
  z.number().finite(),
  z.boolean(),
  BoundedEnumValueSchema,
]);

function canonicalDigest<T>(schema: z.ZodType<T>, value: T): string {
  return sha256Hex(stableStringify(schema.parse(value)));
}

function canonicalCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function addSortedUniqueIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (canonicalCompare(values[index - 1]!, values[index]!) >= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: "Values must be unique and sorted by unsigned UTF-8 bytes",
      });
    }
  }
}

function addUniqueStringIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Duplicate value: ${value}`,
      });
    }
    seen.add(value);
  }
}

function addUniqueIdIssues<T>(
  values: readonly T[],
  idOf: (value: T) => string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const id = idOf(value);
    if (seen.has(id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Duplicate identifier: ${id}`,
      });
    }
    seen.add(id);
  }
}

function addDigestIssue(
  actual: string,
  expected: string,
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
): void {
  if (actual !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `${label} does not match its canonical content`,
    });
  }
}

function addMaterialDigestIssue(
  actual: string,
  schema: z.ZodTypeAny,
  fullValue: Record<string, unknown>,
  digestField: string,
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
): void {
  const material = { ...fullValue };
  delete material[digestField];
  const parsed = schema.safeParse(material);
  if (!parsed.success) return;
  addDigestIssue(
    actual,
    sha256Hex(stableStringify(parsed.data)),
    context,
    path,
    label,
  );
}

export const EmbeddingProjectionRefV1Schema = z.object({
  contract_version: z.literal("embedding_projection_ref_v1"),
  projection_id: BoundedIdSchema,
  provider: BoundedIdSchema,
  model: BoundedIdSchema,
  model_config_sha256: ExecutionEpisodeSha256Schema,
  dimension: z.number().int().positive().max(1_000_000),
  input_sha256: ExecutionEpisodeSha256Schema,
  normalization: z.enum(["none", "l2"]),
  projection_version: BoundedVersionSchema,
  vector_ref: BoundedReferenceSchema,
}).strict();

export type EmbeddingProjectionRefV1 = z.infer<
  typeof EmbeddingProjectionRefV1Schema
>;

const BoundedFeatureSnapshotMaterialBaseV1Schema = z.object({
  contract_version: z.literal("bounded_feature_snapshot_v1"),
  feature_schema_id: BoundedIdSchema,
  feature_schema_version: BoundedVersionSchema,
  values: z.array(z.object({
    feature_id: BoundedFieldIdSchema,
    value: BoundedLiteralValueSchema,
    evidence_ref: BoundedReferenceSchema,
  }).strict()).max(1_024),
}).strict();

type BoundedFeatureSnapshotMaterialV1 = z.infer<
  typeof BoundedFeatureSnapshotMaterialBaseV1Schema
>;

function refineBoundedFeatureSnapshotMaterialV1(
  value: BoundedFeatureSnapshotMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(
    value.values.map((entry) => entry.feature_id),
    context,
    ["values"],
  );
}

const BoundedFeatureSnapshotMaterialV1Schema =
  BoundedFeatureSnapshotMaterialBaseV1Schema.superRefine(
    refineBoundedFeatureSnapshotMaterialV1,
  );

export const BoundedFeatureSnapshotV1Schema =
  BoundedFeatureSnapshotMaterialBaseV1Schema.extend({
    snapshot_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineBoundedFeatureSnapshotMaterialV1(value, context);
    addMaterialDigestIssue(
      value.snapshot_sha256,
      BoundedFeatureSnapshotMaterialV1Schema,
      value,
      "snapshot_sha256",
      context,
      ["snapshot_sha256"],
      "Feature snapshot digest",
    );
  });

export type BoundedFeatureSnapshotV1 = z.infer<
  typeof BoundedFeatureSnapshotV1Schema
>;

export function boundedFeatureSnapshotDigest(
  value: Omit<BoundedFeatureSnapshotV1, "snapshot_sha256">,
): string {
  return canonicalDigest(BoundedFeatureSnapshotMaterialV1Schema, value);
}

const ExperienceCohortMaterialBaseV1Schema = z.object({
  contract_version: z.literal("experience_cohort_v1"),
  cohort_id: BoundedIdSchema,
  target_problem_embedding: EmbeddingProjectionRefV1Schema,
  environment_features: BoundedFeatureSnapshotV1Schema,
  initial_state_features: BoundedFeatureSnapshotV1Schema,
  capability_descriptor_refs: z.array(BoundedReferenceSchema).max(1_024),
  source_successful_episode_ids: z.array(BoundedIdSchema)
    .min(1)
    .max(100_000),
  source_failed_episode_ids: z.array(BoundedIdSchema).max(100_000),
  source_counterexample_episode_ids: z.array(BoundedIdSchema).max(100_000),
  excluded_episode_ids: z.array(z.object({
    episode_id: BoundedIdSchema,
    reason: BoundedDescriptionSchema,
  }).strict()).max(100_000),
  construction_policy_sha256: ExecutionEpisodeSha256Schema,
}).strict();

type ExperienceCohortMaterialV1 = z.infer<
  typeof ExperienceCohortMaterialBaseV1Schema
>;

function refineExperienceCohortMaterialV1(
  value: ExperienceCohortMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(
    value.capability_descriptor_refs,
    context,
    ["capability_descriptor_refs"],
  );
  for (const key of [
    "source_successful_episode_ids",
    "source_failed_episode_ids",
    "source_counterexample_episode_ids",
  ] as const) {
    addSortedUniqueIssues(value[key], context, [key]);
  }
  addSortedUniqueIssues(
    value.excluded_episode_ids.map((entry) => entry.episode_id),
    context,
    ["excluded_episode_ids"],
  );

  const included = new Set([
    ...value.source_successful_episode_ids,
    ...value.source_failed_episode_ids,
    ...value.source_counterexample_episode_ids,
  ]);
  if (
    included.size
    !== value.source_successful_episode_ids.length
      + value.source_failed_episode_ids.length
      + value.source_counterexample_episode_ids.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An episode may occupy only one source evidence role",
    });
  }
  for (const [index, entry] of value.excluded_episode_ids.entries()) {
    if (included.has(entry.episode_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excluded_episode_ids", index, "episode_id"],
        message: "An excluded episode cannot also be source evidence",
      });
    }
  }
}

const ExperienceCohortMaterialV1Schema =
  ExperienceCohortMaterialBaseV1Schema.superRefine(
    refineExperienceCohortMaterialV1,
  );

export const ExperienceCohortV1Schema =
  ExperienceCohortMaterialBaseV1Schema.extend({
    cohort_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineExperienceCohortMaterialV1(value, context);
    addMaterialDigestIssue(
      value.cohort_sha256,
      ExperienceCohortMaterialV1Schema,
      value,
      "cohort_sha256",
      context,
      ["cohort_sha256"],
      "Experience cohort digest",
    );
  });

export type ExperienceCohortV1 = z.infer<typeof ExperienceCohortV1Schema>;

export function experienceCohortDigest(
  value: Omit<ExperienceCohortV1, "cohort_sha256">,
): string {
  return canonicalDigest(ExperienceCohortMaterialV1Schema, value);
}

const FieldRefOperandV1Schema = z.object({
  kind: z.literal("field_ref"),
  feature_schema_id: BoundedIdSchema,
  field_id: BoundedFieldIdSchema,
}).strict();

const ParameterRefOperandV1Schema = z.object({
  kind: z.literal("parameter_ref"),
  parameter_id: BoundedIdSchema,
}).strict();

const SchemaLiteralOperandV1Schema = z.object({
  kind: z.literal("schema_literal"),
  value_schema_ref: BoundedReferenceSchema,
  value: BoundedLiteralValueSchema,
}).strict();

export const ExecutionOperandV1Schema = z.discriminatedUnion("kind", [
  FieldRefOperandV1Schema,
  ParameterRefOperandV1Schema,
  SchemaLiteralOperandV1Schema,
]);

export type ExecutionOperandV1 = z.infer<typeof ExecutionOperandV1Schema>;

export const ReusableExecutionOperandV1Schema = z.discriminatedUnion("kind", [
  FieldRefOperandV1Schema,
  ParameterRefOperandV1Schema,
]);

export type ReusableExecutionOperandV1 = z.infer<
  typeof ReusableExecutionOperandV1Schema
>;

export type ExecutionPredicateV1 =
  | { op: "exists"; operand: ExecutionOperandV1 }
  | { op: "is_true" | "is_false"; operand: ExecutionOperandV1 }
  | {
    op: "equals";
    left: ExecutionOperandV1;
    right: ExecutionOperandV1;
  }
  | {
    op: "version_satisfies";
    version: ExecutionOperandV1;
    range_schema_ref: string;
    range: string;
  }
  | { op: "capability_available"; capability_id: string }
  | { op: "all" | "any"; children: ExecutionPredicateV1[] }
  | { op: "not"; child: ExecutionPredicateV1 };

export type ReusableExecutionPredicateV1 =
  | { op: "exists"; operand: ReusableExecutionOperandV1 }
  | {
    op: "is_true" | "is_false";
    operand: ReusableExecutionOperandV1;
  }
  | {
    op: "equals";
    left: ReusableExecutionOperandV1;
    right: ReusableExecutionOperandV1;
  }
  | {
    op: "version_satisfies";
    version: ReusableExecutionOperandV1;
    range_schema_ref: string;
    range: string;
  }
  | { op: "capability_available"; capability_id: string }
  | { op: "all" | "any"; children: ReusableExecutionPredicateV1[] }
  | { op: "not"; child: ReusableExecutionPredicateV1 };

function predicateSize(
  predicate: ExecutionPredicateV1 | ReusableExecutionPredicateV1,
  depth = 1,
): { depth: number; nodes: number } {
  if (predicate.op === "all" || predicate.op === "any") {
    return predicate.children.reduce(
      (current, child) => {
        const childSize = predicateSize(child, depth + 1);
        return {
          depth: Math.max(current.depth, childSize.depth),
          nodes: current.nodes + childSize.nodes,
        };
      },
      { depth, nodes: 1 },
    );
  }
  if (predicate.op === "not") {
    const childSize = predicateSize(predicate.child, depth + 1);
    return {
      depth: Math.max(depth, childSize.depth),
      nodes: 1 + childSize.nodes,
    };
  }
  return { depth, nodes: 1 };
}

function addPredicateSizeIssues(
  predicate: ExecutionPredicateV1 | ReusableExecutionPredicateV1,
  context: z.RefinementCtx,
): void {
  const size = predicateSize(predicate);
  if (size.depth > EXECUTION_PREDICATE_MAX_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Predicate depth exceeds ${EXECUTION_PREDICATE_MAX_DEPTH}`,
    });
  }
  if (size.nodes > EXECUTION_PREDICATE_MAX_NODES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Predicate node count exceeds ${EXECUTION_PREDICATE_MAX_NODES}`,
    });
  }
}

export const ExecutionPredicateV1Schema: z.ZodType<ExecutionPredicateV1> =
  z.lazy(() => z.discriminatedUnion("op", [
    z.object({
      op: z.literal("exists"),
      operand: ExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.enum(["is_true", "is_false"]),
      operand: ExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.literal("equals"),
      left: ExecutionOperandV1Schema,
      right: ExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.literal("version_satisfies"),
      version: ExecutionOperandV1Schema,
      range_schema_ref: BoundedReferenceSchema,
      range: BoundedVersionSchema,
    }).strict(),
    z.object({
      op: z.literal("capability_available"),
      capability_id: BoundedIdSchema,
    }).strict(),
    z.object({
      op: z.enum(["all", "any"]),
      children: z.array(ExecutionPredicateV1Schema)
        .min(1)
        .max(EXECUTION_PREDICATE_MAX_CHILDREN),
    }).strict(),
    z.object({
      op: z.literal("not"),
      child: ExecutionPredicateV1Schema,
    }).strict(),
  ])).superRefine(addPredicateSizeIssues);

export const ReusableExecutionPredicateV1Schema:
z.ZodType<ReusableExecutionPredicateV1> =
  z.lazy(() => z.discriminatedUnion("op", [
    z.object({
      op: z.literal("exists"),
      operand: ReusableExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.enum(["is_true", "is_false"]),
      operand: ReusableExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.literal("equals"),
      left: ReusableExecutionOperandV1Schema,
      right: ReusableExecutionOperandV1Schema,
    }).strict(),
    z.object({
      op: z.literal("version_satisfies"),
      version: ReusableExecutionOperandV1Schema,
      range_schema_ref: BoundedReferenceSchema,
      range: BoundedVersionSchema,
    }).strict(),
    z.object({
      op: z.literal("capability_available"),
      capability_id: BoundedIdSchema,
    }).strict(),
    z.object({
      op: z.enum(["all", "any"]),
      children: z.array(ReusableExecutionPredicateV1Schema)
        .min(1)
        .max(EXECUTION_PREDICATE_MAX_CHILDREN),
    }).strict(),
    z.object({
      op: z.literal("not"),
      child: ReusableExecutionPredicateV1Schema,
    }).strict(),
  ])).superRefine(addPredicateSizeIssues);

export const CapabilityDescriptorV1Schema = z.object({
  contract_version: z.literal("capability_descriptor_v1"),
  capability_id: BoundedIdSchema,
  version: BoundedVersionSchema,
  input_schema_ref: BoundedReferenceSchema,
  output_schema_ref: BoundedReferenceSchema,
  side_effect_class: z.enum(["none", "reversible", "irreversible"]),
  evidence_ref: BoundedReferenceSchema,
}).strict();

export type CapabilityDescriptorV1 = z.infer<
  typeof CapabilityDescriptorV1Schema
>;

const CapabilityResolverV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("host_callback"),
    callback_id: BoundedIdSchema,
    callback_version: BoundedVersionSchema,
  }).strict(),
  z.object({
    kind: z.literal("manifest_module"),
    module_ref: BoundedReferenceSchema,
    module_sha256: ExecutionEpisodeSha256Schema,
  }).strict(),
]);

const HostCapabilityRegistryEntryMaterialV1Schema = z.object({
  contract_version: z.literal("host_capability_registry_entry_v1"),
  capability: CapabilityDescriptorV1Schema,
  resolver: CapabilityResolverV1Schema,
  registered_by: BoundedIdSchema,
}).strict();

export const HostCapabilityRegistryEntryV1Schema =
  HostCapabilityRegistryEntryMaterialV1Schema.extend({
    registration_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    addMaterialDigestIssue(
      value.registration_sha256,
      HostCapabilityRegistryEntryMaterialV1Schema,
      value,
      "registration_sha256",
      context,
      ["registration_sha256"],
      "Capability registration digest",
    );
  });

export type HostCapabilityRegistryEntryV1 = z.infer<
  typeof HostCapabilityRegistryEntryV1Schema
>;

export function hostCapabilityRegistryEntryDigest(
  value: Omit<HostCapabilityRegistryEntryV1, "registration_sha256">,
): string {
  return canonicalDigest(HostCapabilityRegistryEntryMaterialV1Schema, value);
}

export const BindingExpressionV1Schema = z.discriminatedUnion("kind", [
  ParameterRefOperandV1Schema,
  FieldRefOperandV1Schema,
  SchemaLiteralOperandV1Schema,
]);

export type BindingExpressionV1 = z.infer<typeof BindingExpressionV1Schema>;

export const ReusableBindingExpressionV1Schema = z.discriminatedUnion("kind", [
  ParameterRefOperandV1Schema,
  FieldRefOperandV1Schema,
]);

export type ReusableBindingExpressionV1 = z.infer<
  typeof ReusableBindingExpressionV1Schema
>;

export const SkillParameterV1Schema = z.object({
  contract_version: z.literal("skill_parameter_v1"),
  parameter_id: BoundedIdSchema,
  value_type: z.enum(["string", "number", "boolean", "artifact_ref"]),
  source: z.enum(["task", "subject_state", "environment", "agent"]),
  source_field: z.object({
    feature_schema_id: BoundedIdSchema,
    field_id: BoundedFieldIdSchema,
  }).strict(),
  required: z.boolean(),
}).strict();

export type SkillParameterV1 = z.infer<typeof SkillParameterV1Schema>;

const ParameterBindingReceiptMaterialBaseV1Schema = z.object({
  contract_version: z.literal("parameter_binding_receipt_v1"),
  receipt_id: BoundedIdSchema,
  artifact_kind: z.enum(["L2_hypothesis", "L3_skill"]),
  artifact_id: BoundedIdSchema,
  artifact_version: z.number().int().positive(),
  current_state_sha256: ExecutionEpisodeSha256Schema,
  bindings: z.array(z.object({
    parameter_id: BoundedIdSchema,
    value_ref: BoundedReferenceSchema,
    authority: z.enum([
      "runtime_adapter",
      "signed_host_adapter",
      "explicit_agent",
    ]),
    evidence_ref: BoundedReferenceSchema,
  }).strict()).max(EXECUTION_PROCEDURE_MAX_PARAMETERS),
  unresolved_parameter_ids: z.array(BoundedIdSchema)
    .max(EXECUTION_PROCEDURE_MAX_PARAMETERS),
}).strict();

type ParameterBindingReceiptMaterialV1 = z.infer<
  typeof ParameterBindingReceiptMaterialBaseV1Schema
>;

function refineParameterBindingReceiptMaterialV1(
  value: ParameterBindingReceiptMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(
    value.bindings.map((binding) => binding.parameter_id),
    context,
    ["bindings"],
  );
  addSortedUniqueIssues(
    value.unresolved_parameter_ids,
    context,
    ["unresolved_parameter_ids"],
  );
  const boundIds = new Set(value.bindings.map((binding) => binding.parameter_id));
  for (const [index, parameterId] of value.unresolved_parameter_ids.entries()) {
    if (boundIds.has(parameterId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unresolved_parameter_ids", index],
        message: "A parameter cannot be both bound and unresolved",
      });
    }
  }
}

const ParameterBindingReceiptMaterialV1Schema =
  ParameterBindingReceiptMaterialBaseV1Schema.superRefine(
    refineParameterBindingReceiptMaterialV1,
  );

export const ParameterBindingReceiptV1Schema =
  ParameterBindingReceiptMaterialBaseV1Schema.extend({
    binding_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineParameterBindingReceiptMaterialV1(value, context);
    addMaterialDigestIssue(
      value.binding_sha256,
      ParameterBindingReceiptMaterialV1Schema,
      value,
      "binding_sha256",
      context,
      ["binding_sha256"],
      "Parameter binding digest",
    );
  });

export type ParameterBindingReceiptV1 = z.infer<
  typeof ParameterBindingReceiptV1Schema
>;

export function parameterBindingReceiptDigest(
  value: Omit<ParameterBindingReceiptV1, "binding_sha256">,
): string {
  return canonicalDigest(ParameterBindingReceiptMaterialV1Schema, value);
}

const ReusableInputBindingsV1Schema = z.record(
  BoundedBindingKeySchema,
  ReusableBindingExpressionV1Schema,
).superRefine((value, context) => {
  if (Object.keys(value).length > EXECUTION_PROCEDURE_MAX_BINDINGS_PER_STEP) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `Input bindings exceed ${EXECUTION_PROCEDURE_MAX_BINDINGS_PER_STEP}`,
    });
  }
});

export const ProcedureStepV1Schema = z.object({
  contract_version: z.literal("procedure_step_v1"),
  step_id: BoundedIdSchema,
  capability_id: BoundedIdSchema,
  input_bindings: ReusableInputBindingsV1Schema,
  preconditions: z.array(ReusableExecutionPredicateV1Schema)
    .max(EXECUTION_PREDICATE_MAX_CHILDREN),
  expected_transition_ids: z.array(BoundedIdSchema)
    .min(1)
    .max(EXECUTION_PROCEDURE_MAX_STEPS),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(
    value.expected_transition_ids,
    context,
    ["expected_transition_ids"],
  );
});

export type ProcedureStepV1 = z.infer<typeof ProcedureStepV1Schema>;

export const ExpectedTransitionV1Schema = z.object({
  contract_version: z.literal("expected_transition_v1"),
  transition_id: BoundedIdSchema,
  predicate: ReusableExecutionPredicateV1Schema,
}).strict();

export type ExpectedTransitionV1 = z.infer<
  typeof ExpectedTransitionV1Schema
>;

export const VerificationStepV1Schema = z.object({
  contract_version: z.literal("verification_step_v1"),
  verification_id: BoundedIdSchema,
  capability_id: BoundedIdSchema,
  input_bindings: ReusableInputBindingsV1Schema,
  pass_predicate: ReusableExecutionPredicateV1Schema,
}).strict();

export type VerificationStepV1 = z.infer<typeof VerificationStepV1Schema>;

const CapabilityInvocationReceiptMaterialV1Schema = z.object({
  contract_version: z.literal("capability_invocation_receipt_v1"),
  receipt_id: BoundedIdSchema,
  capability_id: BoundedIdSchema,
  capability_version: BoundedVersionSchema,
  registry_entry_sha256: ExecutionEpisodeSha256Schema,
  binding_receipt_id: BoundedIdSchema,
  request_artifact_ref: BoundedReferenceSchema,
  result_artifact_ref: BoundedReferenceSchema,
  action_event_id: BoundedIdSchema,
}).strict();

export const CapabilityInvocationReceiptV1Schema =
  CapabilityInvocationReceiptMaterialV1Schema.extend({
    receipt_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    addMaterialDigestIssue(
      value.receipt_sha256,
      CapabilityInvocationReceiptMaterialV1Schema,
      value,
      "receipt_sha256",
      context,
      ["receipt_sha256"],
      "Capability invocation receipt digest",
    );
  });

export type CapabilityInvocationReceiptV1 = z.infer<
  typeof CapabilityInvocationReceiptV1Schema
>;

export function capabilityInvocationReceiptDigest(
  value: Omit<CapabilityInvocationReceiptV1, "receipt_sha256">,
): string {
  return canonicalDigest(CapabilityInvocationReceiptMaterialV1Schema, value);
}

export const TerminationConditionV1Schema = z.object({
  contract_version: z.literal("termination_condition_v1"),
  condition_id: BoundedIdSchema,
  kind: z.enum(["success", "stop", "handoff"]),
  predicate: ReusableExecutionPredicateV1Schema,
}).strict();

export type TerminationConditionV1 = z.infer<
  typeof TerminationConditionV1Schema
>;

export const RecoveryBranchV1Schema = z.object({
  contract_version: z.literal("recovery_branch_v1"),
  branch_id: BoundedIdSchema,
  trigger: ReusableExecutionPredicateV1Schema,
  step_ids: z.array(BoundedIdSchema)
    .min(1)
    .max(EXECUTION_PROCEDURE_MAX_STEPS),
  termination_condition_ids: z.array(BoundedIdSchema)
    .min(1)
    .max(EXECUTION_PROCEDURE_MAX_STEPS),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.step_ids, context, ["step_ids"]);
  addSortedUniqueIssues(
    value.termination_condition_ids,
    context,
    ["termination_condition_ids"],
  );
});

export type RecoveryBranchV1 = z.infer<typeof RecoveryBranchV1Schema>;

export const EvidencePatternV1Schema = z.object({
  contract_version: z.literal("evidence_pattern_v1"),
  description: BoundedDescriptionSchema,
  predicate: ReusableExecutionPredicateV1Schema,
  source_evidence_refs: z.array(BoundedReferenceSchema)
    .min(1)
    .max(EXECUTION_SKILL_MAX_EVIDENCE_REFS),
  uncertainty: z.number().min(0).max(1).nullable(),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(
    value.source_evidence_refs,
    context,
    ["source_evidence_refs"],
  );
});

export type EvidencePatternV1 = z.infer<typeof EvidencePatternV1Schema>;

export const FailureModeV1Schema = z.object({
  contract_version: z.literal("failure_mode_v1"),
  failure_mode_id: BoundedIdSchema,
  description: BoundedDescriptionSchema,
  detection: z.array(ReusableExecutionPredicateV1Schema)
    .min(1)
    .max(EXECUTION_PREDICATE_MAX_CHILDREN),
  evidence_refs: z.array(BoundedReferenceSchema)
    .min(1)
    .max(EXECUTION_SKILL_MAX_EVIDENCE_REFS),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.evidence_refs, context, ["evidence_refs"]);
});

export type FailureModeV1 = z.infer<typeof FailureModeV1Schema>;

export const CounterexampleRefV1Schema = z.object({
  contract_version: z.literal("counterexample_ref_v1"),
  episode_id: BoundedIdSchema,
  intervention_id: BoundedIdSchema.nullable(),
  evidence_refs: z.array(BoundedReferenceSchema)
    .min(1)
    .max(EXECUTION_SKILL_MAX_EVIDENCE_REFS),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.evidence_refs, context, ["evidence_refs"]);
});

export type CounterexampleRefV1 = z.infer<typeof CounterexampleRefV1Schema>;

export const VersionConstraintV1Schema = z.object({
  contract_version: z.literal("version_constraint_v1"),
  capability_id: BoundedIdSchema,
  range: BoundedVersionSchema,
}).strict();

export type VersionConstraintV1 = z.infer<typeof VersionConstraintV1Schema>;

function visitPredicateOperands(
  predicate: ReusableExecutionPredicateV1,
  visitor: (operand: ReusableExecutionOperandV1) => void,
): void {
  if (
    predicate.op === "exists"
    || predicate.op === "is_true"
    || predicate.op === "is_false"
  ) {
    visitor(predicate.operand);
    return;
  }
  if (predicate.op === "equals") {
    visitor(predicate.left);
    visitor(predicate.right);
    return;
  }
  if (predicate.op === "version_satisfies") {
    visitor(predicate.version);
    return;
  }
  if (predicate.op === "all" || predicate.op === "any") {
    for (const child of predicate.children) {
      visitPredicateOperands(child, visitor);
    }
    return;
  }
  if (predicate.op === "not") {
    visitPredicateOperands(predicate.child, visitor);
  }
}

const ProcedureContentBaseV1Schema = z.object({
  contract_version: z.literal("procedure_content_v1"),
  goal_pattern: BoundedDescriptionSchema,
  applicability: z.object({
    semantic_description: BoundedDescriptionSchema,
    required_state: z.array(ReusableExecutionPredicateV1Schema)
      .max(EXECUTION_PREDICATE_MAX_CHILDREN),
    required_capabilities: z.array(BoundedIdSchema)
      .min(1)
      .max(1_024),
    compatible_environments: z.array(ReusableExecutionPredicateV1Schema)
      .max(EXECUTION_PREDICATE_MAX_CHILDREN),
    incompatible_conditions: z.array(ReusableExecutionPredicateV1Schema)
      .max(EXECUTION_PREDICATE_MAX_CHILDREN),
  }).strict(),
  diagnosis: z.object({
    decisive_observations: z.array(EvidencePatternV1Schema)
      .min(1)
      .max(1_024),
    failure_modes: z.array(FailureModeV1Schema).min(1).max(1_024),
    discriminating_checks: z.array(VerificationStepV1Schema)
      .min(1)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
  }).strict(),
  procedure: z.object({
    parameters: z.array(SkillParameterV1Schema)
      .max(EXECUTION_PROCEDURE_MAX_PARAMETERS),
    steps: z.array(ProcedureStepV1Schema)
      .min(1)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
    expected_transitions: z.array(ExpectedTransitionV1Schema)
      .min(1)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
    termination: z.array(TerminationConditionV1Schema)
      .min(1)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
    verification: z.array(VerificationStepV1Schema)
      .min(1)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
    recovery: z.array(RecoveryBranchV1Schema)
      .max(EXECUTION_PROCEDURE_MAX_STEPS),
  }).strict(),
  boundaries: z.object({
    does_not_apply: z.array(ReusableExecutionPredicateV1Schema)
      .min(1)
      .max(EXECUTION_PREDICATE_MAX_CHILDREN),
    known_counterexamples: z.array(CounterexampleRefV1Schema).max(100_000),
    version_constraints: z.array(VersionConstraintV1Schema).max(1_024),
  }).strict(),
  unresolved_assumptions: z.array(BoundedDescriptionSchema).max(1_024),
}).strict();

export const ProcedureContentV1Schema =
  ProcedureContentBaseV1Schema.superRefine((value, context) => {
    addSortedUniqueIssues(
      value.applicability.required_capabilities,
      context,
      ["applicability", "required_capabilities"],
    );
    addSortedUniqueIssues(
      value.unresolved_assumptions,
      context,
      ["unresolved_assumptions"],
    );
    addUniqueIdIssues(
      value.procedure.parameters,
      (parameter) => parameter.parameter_id,
      context,
      ["procedure", "parameters"],
    );
    addUniqueIdIssues(
      value.procedure.steps,
      (step) => step.step_id,
      context,
      ["procedure", "steps"],
    );
    addUniqueIdIssues(
      value.procedure.expected_transitions,
      (transition) => transition.transition_id,
      context,
      ["procedure", "expected_transitions"],
    );
    addUniqueIdIssues(
      value.procedure.termination,
      (condition) => condition.condition_id,
      context,
      ["procedure", "termination"],
    );
    addUniqueIdIssues(
      value.procedure.verification,
      (verification) => verification.verification_id,
      context,
      ["procedure", "verification"],
    );
    addUniqueIdIssues(
      value.diagnosis.discriminating_checks,
      (verification) => verification.verification_id,
      context,
      ["diagnosis", "discriminating_checks"],
    );
    addUniqueIdIssues(
      value.procedure.recovery,
      (branch) => branch.branch_id,
      context,
      ["procedure", "recovery"],
    );
    addUniqueIdIssues(
      value.diagnosis.failure_modes,
      (failureMode) => failureMode.failure_mode_id,
      context,
      ["diagnosis", "failure_modes"],
    );

    const parameterIds = new Set(
      value.procedure.parameters.map((parameter) => parameter.parameter_id),
    );
    const capabilityIds = new Set(
      value.applicability.required_capabilities,
    );
    const transitionIds = new Set(
      value.procedure.expected_transitions.map(
        (transition) => transition.transition_id,
      ),
    );
    const stepIds = new Set(
      value.procedure.steps.map((step) => step.step_id),
    );
    const terminationIds = new Set(
      value.procedure.termination.map((condition) => condition.condition_id),
    );
    const nonSuccessTerminationIds = new Set(
      value.procedure.termination.filter(
        (condition) => condition.kind !== "success",
      ).map((condition) => condition.condition_id),
    );
    if (
      value.procedure.recovery.length > 0
      && nonSuccessTerminationIds.size === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["procedure", "termination"],
        message:
          "A procedure with recovery branches requires a stop or handoff termination condition",
      });
    }

    const checkOperand = (
      operand: ReusableExecutionOperandV1,
      path: (string | number)[],
    ): void => {
      if (
        operand.kind === "parameter_ref"
        && !parameterIds.has(operand.parameter_id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Unknown procedure parameter: ${operand.parameter_id}`,
        });
      }
    };

    const checkPredicate = (
      predicate: ReusableExecutionPredicateV1,
      path: (string | number)[],
    ): void => {
      visitPredicateOperands(
        predicate,
        (operand) => checkOperand(operand, path),
      );
      if (
        predicate.op === "capability_available"
        && !capabilityIds.has(predicate.capability_id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `Predicate references undeclared capability: ${predicate.capability_id}`,
        });
      }
    };

    const predicateGroups: Array<{
      predicates: ReusableExecutionPredicateV1[];
      path: (string | number)[];
    }> = [
      {
        predicates: value.applicability.required_state,
        path: ["applicability", "required_state"],
      },
      {
        predicates: value.applicability.compatible_environments,
        path: ["applicability", "compatible_environments"],
      },
      {
        predicates: value.applicability.incompatible_conditions,
        path: ["applicability", "incompatible_conditions"],
      },
      {
        predicates: value.boundaries.does_not_apply,
        path: ["boundaries", "does_not_apply"],
      },
    ];
    for (const group of predicateGroups) {
      for (const [index, predicate] of group.predicates.entries()) {
        checkPredicate(predicate, [...group.path, index]);
      }
    }

    const allVerificationSteps = [
      ...value.diagnosis.discriminating_checks.map((entry, index) => ({
        entry,
        path: ["diagnosis", "discriminating_checks", index] as (
          string | number
        )[],
      })),
      ...value.procedure.verification.map((entry, index) => ({
        entry,
        path: ["procedure", "verification", index] as (string | number)[],
      })),
    ];

    for (const [index, step] of value.procedure.steps.entries()) {
      if (!capabilityIds.has(step.capability_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["procedure", "steps", index, "capability_id"],
          message: `Step uses undeclared capability: ${step.capability_id}`,
        });
      }
      for (const [bindingKey, binding] of Object.entries(step.input_bindings)) {
        checkOperand(
          binding,
          ["procedure", "steps", index, "input_bindings", bindingKey],
        );
      }
      for (const [predicateIndex, predicate] of step.preconditions.entries()) {
        checkPredicate(
          predicate,
          ["procedure", "steps", index, "preconditions", predicateIndex],
        );
      }
      for (
        const [transitionIndex, transitionId]
        of step.expected_transition_ids.entries()
      ) {
        if (!transitionIds.has(transitionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "procedure",
              "steps",
              index,
              "expected_transition_ids",
              transitionIndex,
            ],
            message: `Unknown expected transition: ${transitionId}`,
          });
        }
      }
    }

    for (const { entry, path } of allVerificationSteps) {
      if (!capabilityIds.has(entry.capability_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "capability_id"],
          message:
            `Verification uses undeclared capability: ${entry.capability_id}`,
        });
      }
      for (const [bindingKey, binding] of Object.entries(entry.input_bindings)) {
        checkOperand(binding, [...path, "input_bindings", bindingKey]);
      }
      checkPredicate(entry.pass_predicate, [...path, "pass_predicate"]);
    }

    for (const [index, transition] of value.procedure.expected_transitions.entries()) {
      checkPredicate(
        transition.predicate,
        ["procedure", "expected_transitions", index, "predicate"],
      );
    }
    for (const [index, condition] of value.procedure.termination.entries()) {
      checkPredicate(
        condition.predicate,
        ["procedure", "termination", index, "predicate"],
      );
    }
    for (const [index, observation] of value.diagnosis.decisive_observations.entries()) {
      checkPredicate(
        observation.predicate,
        ["diagnosis", "decisive_observations", index, "predicate"],
      );
    }
    for (const [index, failureMode] of value.diagnosis.failure_modes.entries()) {
      for (const [detectionIndex, detection] of failureMode.detection.entries()) {
        checkPredicate(
          detection,
          [
            "diagnosis",
            "failure_modes",
            index,
            "detection",
            detectionIndex,
          ],
        );
      }
    }
    for (const [index, branch] of value.procedure.recovery.entries()) {
      checkPredicate(
        branch.trigger,
        ["procedure", "recovery", index, "trigger"],
      );
      for (const [stepIndex, stepId] of branch.step_ids.entries()) {
        if (!stepIds.has(stepId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["procedure", "recovery", index, "step_ids", stepIndex],
            message: `Unknown recovery step: ${stepId}`,
          });
        }
      }
      for (
        const [conditionIndex, conditionId]
        of branch.termination_condition_ids.entries()
      ) {
        if (!terminationIds.has(conditionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "procedure",
              "recovery",
              index,
              "termination_condition_ids",
              conditionIndex,
            ],
            message: `Unknown termination condition: ${conditionId}`,
          });
        }
      }
      if (
        !branch.termination_condition_ids.some(
          (conditionId) => nonSuccessTerminationIds.has(conditionId),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "procedure",
            "recovery",
            index,
            "termination_condition_ids",
          ],
          message:
            "Every recovery branch must bind a stop or handoff termination condition",
        });
      }
    }
    for (
      const [index, constraint]
      of value.boundaries.version_constraints.entries()
    ) {
      if (!capabilityIds.has(constraint.capability_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["boundaries", "version_constraints", index, "capability_id"],
          message:
            `Version constraint uses undeclared capability: ${constraint.capability_id}`,
        });
      }
    }
  });

export type ProcedureContentV1 = z.infer<typeof ProcedureContentV1Schema>;

export function procedureContentDigest(value: ProcedureContentV1): string {
  return canonicalDigest(ProcedureContentV1Schema, value);
}

export const ProcedureHypothesisV2Schema = z.object({
  contract_version: z.literal("procedure_hypothesis_v2"),
  hypothesis_id: BoundedIdSchema,
  layer: z.literal("L2"),
  version: z.number().int().positive(),
  status: z.enum(["candidate", "in_validation", "rejected", "contested"]),
  content: ProcedureContentV1Schema,
  evidence: z.object({
    source_episode_ids: z.array(BoundedIdSchema).min(1).max(100_000),
    contrast_episode_ids: z.array(BoundedIdSchema).min(1).max(100_000),
    negative_neighbor_episode_ids: z.array(BoundedIdSchema).max(100_000),
    verifier_refs: z.array(BoundedReferenceSchema)
      .min(1)
      .max(EXECUTION_SKILL_MAX_EVIDENCE_REFS),
    compiler_model: BoundedIdSchema,
    compiler_prompt_sha256: ExecutionEpisodeSha256Schema,
    content_sha256: ExecutionEpisodeSha256Schema,
  }).strict(),
  production_prompt_eligible: z.literal(false),
  validation_prompt_eligible: z.literal(true),
}).strict().superRefine((value, context) => {
  for (const key of [
    "source_episode_ids",
    "contrast_episode_ids",
    "negative_neighbor_episode_ids",
    "verifier_refs",
  ] as const) {
    addSortedUniqueIssues(value.evidence[key], context, ["evidence", key]);
  }
  const roles = [
    value.evidence.source_episode_ids,
    value.evidence.contrast_episode_ids,
    value.evidence.negative_neighbor_episode_ids,
  ];
  const evidenceIds = roles.flat();
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Episode evidence roles must be disjoint",
    });
  }
  const parsedContent = ProcedureContentV1Schema.safeParse(value.content);
  if (parsedContent.success) {
    addDigestIssue(
      value.evidence.content_sha256,
      procedureContentDigest(parsedContent.data),
      context,
      ["evidence", "content_sha256"],
      "Hypothesis content digest",
    );
  }
});

export type ProcedureHypothesisV2 = z.infer<
  typeof ProcedureHypothesisV2Schema
>;

const LimitedDeliveryScopeMaterialBaseV1Schema = z.object({
  contract_version: z.literal("limited_delivery_scope_v1"),
  scope_id: BoundedIdSchema,
  subject_kinds: z.array(BoundedIdSchema).min(1).max(256),
  semantic_task_signature_refs: z.array(BoundedReferenceSchema)
    .min(1)
    .max(100_000),
  environment_predicates: z.array(ReusableExecutionPredicateV1Schema)
    .max(EXECUTION_PREDICATE_MAX_CHILDREN),
  expires_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

type LimitedDeliveryScopeMaterialV1 = z.infer<
  typeof LimitedDeliveryScopeMaterialBaseV1Schema
>;

function refineLimitedDeliveryScopeMaterialV1(
  value: LimitedDeliveryScopeMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(value.subject_kinds, context, ["subject_kinds"]);
  addSortedUniqueIssues(
    value.semantic_task_signature_refs,
    context,
    ["semantic_task_signature_refs"],
  );
}

const LimitedDeliveryScopeMaterialV1Schema =
  LimitedDeliveryScopeMaterialBaseV1Schema.superRefine(
    refineLimitedDeliveryScopeMaterialV1,
  );

export const LimitedDeliveryScopeV1Schema =
  LimitedDeliveryScopeMaterialBaseV1Schema.extend({
    scope_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineLimitedDeliveryScopeMaterialV1(value, context);
    addMaterialDigestIssue(
      value.scope_sha256,
      LimitedDeliveryScopeMaterialV1Schema,
      value,
      "scope_sha256",
      context,
      ["scope_sha256"],
      "Limited delivery scope digest",
    );
  });

export type LimitedDeliveryScopeV1 = z.infer<
  typeof LimitedDeliveryScopeV1Schema
>;

export function limitedDeliveryScopeDigest(
  value: Omit<LimitedDeliveryScopeV1, "scope_sha256">,
): string {
  return canonicalDigest(LimitedDeliveryScopeMaterialV1Schema, value);
}

const SkillValidationProtocolMaterialBaseV1Schema = z.object({
  contract_version: z.literal("skill_validation_protocol_v1"),
  protocol_id: z.literal("validation_protocol_v1"),
  protocol_version: BoundedVersionSchema,
  design: z.literal("cloned_paired_block"),
  estimator: z.literal("signature_stratified_paired_risk_difference"),
  interval: z.literal(
    "deterministic_stratified_paired_percentile_bootstrap",
  ),
  bootstrap_replicates: z.literal(50_000),
  familywise_alpha: z.literal(0.05),
  minimum_relevant_uplift: z.literal(0.08),
  minimum_power: z.literal(0.8),
  minimum_validated_pairs: z.literal(24),
  minimum_semantic_signatures: z.literal(3),
  minimum_pairs_per_signature: z.literal(8),
  severe_regression_codes: z.array(BoundedIdSchema).min(1).max(256),
  missing_block_policy: z.literal(
    "arm_failure_or_locked_reserve_replacement",
  ),
  contamination_policy: z.literal(
    "invalidate_whole_pair_and_contest_if_post_exposure",
  ),
}).strict();

type SkillValidationProtocolMaterialV1 = z.infer<
  typeof SkillValidationProtocolMaterialBaseV1Schema
>;

function refineSkillValidationProtocolMaterialV1(
  value: SkillValidationProtocolMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(
    value.severe_regression_codes,
    context,
    ["severe_regression_codes"],
  );
}

const SkillValidationProtocolMaterialV1Schema =
  SkillValidationProtocolMaterialBaseV1Schema.superRefine(
    refineSkillValidationProtocolMaterialV1,
  );

export const SkillValidationProtocolV1Schema =
  SkillValidationProtocolMaterialBaseV1Schema.extend({
    protocol_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineSkillValidationProtocolMaterialV1(value, context);
    addMaterialDigestIssue(
      value.protocol_sha256,
      SkillValidationProtocolMaterialV1Schema,
      value,
      "protocol_sha256",
      context,
      ["protocol_sha256"],
      "Validation protocol digest",
    );
  });

export type SkillValidationProtocolV1 = z.infer<
  typeof SkillValidationProtocolV1Schema
>;

export function skillValidationProtocolDigest(
  value: Omit<SkillValidationProtocolV1, "protocol_sha256">,
): string {
  return canonicalDigest(SkillValidationProtocolMaterialV1Schema, value);
}

const SkillValidationReceiptMaterialBaseV1Schema = z.object({
  contract_version: z.literal("skill_validation_receipt_v1"),
  receipt_id: BoundedIdSchema,
  hypothesis_id: BoundedIdSchema,
  hypothesis_version: z.number().int().positive(),
  hypothesis_content_sha256: ExecutionEpisodeSha256Schema,
  protocol_sha256: ExecutionEpisodeSha256Schema,
  split_manifest_sha256: ExecutionEpisodeSha256Schema,
  validation_policy_id: BoundedIdSchema,
  validation_policy_version: BoundedVersionSchema,
  assignment_receipts_sha256: ExecutionEpisodeSha256Schema,
  validation_design: z.literal("cloned_paired_block"),
  randomization_unit: z.literal("paired_base_task"),
  paired_base_task_ids_sha256: ExecutionEpisodeSha256Schema,
  estimator_id: BoundedIdSchema,
  estimator_version: BoundedVersionSchema,
  analysis_code_sha256: ExecutionEpisodeSha256Schema,
  validation_family_id: BoundedIdSchema,
  validation_family_size: z.number().int().positive().max(1_000_000),
  adjusted_alpha: z.number().positive().max(0.05),
  power_simulation_ref: BoundedReferenceSchema.nullable(),
  power_simulation_sha256: ExecutionEpisodeSha256Schema.nullable(),
  valid_pair_count: z.number().int().nonnegative().max(1_000_000),
  treatment_episode_ids: z.array(BoundedIdSchema).max(1_000_000),
  control_episode_ids: z.array(BoundedIdSchema).max(1_000_000),
  excluded_episode_ids: z.array(z.object({
    episode_id: BoundedIdSchema,
    reason: BoundedDescriptionSchema,
  }).strict()).max(1_000_000),
  outcome_summary_sha256: ExecutionEpisodeSha256Schema,
  verified_success_uplift: z.number().min(-1).max(1),
  uplift_lower_bound: z.number().min(-1).max(1),
  negative_transfer_rate: z.number().min(0).max(1),
  negative_transfer_upper_bound: z.number().min(0).max(1),
  mean_prompt_tokens: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  gate_result: z.enum(["passed", "limited", "failed", "contested"]),
  limited_delivery_scope: LimitedDeliveryScopeV1Schema.nullable(),
  created_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

type SkillValidationReceiptMaterialV1 = z.infer<
  typeof SkillValidationReceiptMaterialBaseV1Schema
>;

function refineSkillValidationReceiptMaterialV1(
  value: SkillValidationReceiptMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(
    value.treatment_episode_ids,
    context,
    ["treatment_episode_ids"],
  );
  addSortedUniqueIssues(
    value.control_episode_ids,
    context,
    ["control_episode_ids"],
  );
  addSortedUniqueIssues(
    value.excluded_episode_ids.map((entry) => entry.episode_id),
    context,
    ["excluded_episode_ids"],
  );
  if (
    value.treatment_episode_ids.length !== value.valid_pair_count
    || value.control_episode_ids.length !== value.valid_pair_count
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["valid_pair_count"],
      message: "Each valid pair must bind one treatment and one control episode",
    });
  }
  const episodeIds = [
    ...value.treatment_episode_ids,
    ...value.control_episode_ids,
    ...value.excluded_episode_ids.map((entry) => entry.episode_id),
  ];
  if (new Set(episodeIds).size !== episodeIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Validation episode roles must be disjoint",
    });
  }
  if (
    (value.power_simulation_ref === null)
    !== (value.power_simulation_sha256 === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["power_simulation_ref"],
      message: "Power simulation reference and digest must be both present or null",
    });
  }
  if (
    value.gate_result === "limited"
    && value.limited_delivery_scope === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["limited_delivery_scope"],
      message: "A limited gate requires an executable limited delivery scope",
    });
  }
  if (
    value.gate_result !== "limited"
    && value.limited_delivery_scope !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["limited_delivery_scope"],
      message: "Only a limited gate may carry a limited delivery scope",
    });
  }
  if (value.uplift_lower_bound > value.verified_success_uplift) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["uplift_lower_bound"],
      message: "Uplift lower bound cannot exceed the point estimate",
    });
  }
  if (value.negative_transfer_upper_bound < value.negative_transfer_rate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["negative_transfer_upper_bound"],
      message:
        "Negative-transfer upper bound cannot be below the point estimate",
    });
  }
}

const SkillValidationReceiptMaterialV1Schema =
  SkillValidationReceiptMaterialBaseV1Schema.superRefine(
    refineSkillValidationReceiptMaterialV1,
  );

export const SkillValidationReceiptV1Schema =
  SkillValidationReceiptMaterialBaseV1Schema.extend({
    receipt_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineSkillValidationReceiptMaterialV1(value, context);
    addMaterialDigestIssue(
      value.receipt_sha256,
      SkillValidationReceiptMaterialV1Schema,
      value,
      "receipt_sha256",
      context,
      ["receipt_sha256"],
      "Skill validation receipt digest",
    );
  });

export type SkillValidationReceiptV1 = z.infer<
  typeof SkillValidationReceiptV1Schema
>;

export function skillValidationReceiptDigest(
  value: Omit<SkillValidationReceiptV1, "receipt_sha256">,
): string {
  return canonicalDigest(SkillValidationReceiptMaterialV1Schema, value);
}

export const ValidatedExecutionSkillStatusV1Schema = z.enum([
  "validated",
  "limited",
  "contested",
  "deprecated",
]);

export type ValidatedExecutionSkillStatusV1 = z.infer<
  typeof ValidatedExecutionSkillStatusV1Schema
>;

export const ValidatedExecutionSkillV1Schema = z.object({
  contract_version: z.literal("validated_execution_skill_v1"),
  skill_id: BoundedIdSchema,
  layer: z.literal("L3"),
  version: z.number().int().positive(),
  status: ValidatedExecutionSkillStatusV1Schema,
  source_hypothesis_id: BoundedIdSchema,
  source_hypothesis_version: z.number().int().positive(),
  source_hypothesis_content_sha256: ExecutionEpisodeSha256Schema,
  content: ProcedureContentV1Schema,
  content_sha256: ExecutionEpisodeSha256Schema,
  execution_form: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("agent_guidance"),
    }).strict(),
    z.object({
      kind: z.literal("manifest"),
      manifest_ref: BoundedReferenceSchema,
      manifest_sha256: ExecutionEpisodeSha256Schema,
    }).strict(),
  ]),
  validation: z.object({
    receipt_id: BoundedIdSchema,
    receipt_sha256: ExecutionEpisodeSha256Schema,
  }).strict(),
  limited_delivery_scope: LimitedDeliveryScopeV1Schema.nullable(),
  lifecycle_receipt_id: BoundedIdSchema.nullable(),
  delivery: z.object({
    compact_summary: BoundedCompactTextSchema,
    estimated_tokens: z.number().int().positive().max(1_000_000),
    disclosure_levels: z.array(z.enum([
      "summary",
      "procedure",
      "evidence",
    ])).min(1).max(3),
  }).strict(),
}).strict().superRefine((value, context) => {
  const parsedContent = ProcedureContentV1Schema.safeParse(value.content);
  if (!parsedContent.success) return;
  const contentSha256 = procedureContentDigest(parsedContent.data);
  addDigestIssue(
    value.content_sha256,
    contentSha256,
    context,
    ["content_sha256"],
    "Validated skill content digest",
  );
  addDigestIssue(
    value.source_hypothesis_content_sha256,
    contentSha256,
    context,
    ["source_hypothesis_content_sha256"],
    "Source hypothesis content digest",
  );
  addUniqueStringIssues(
    value.delivery.disclosure_levels,
    context,
    ["delivery", "disclosure_levels"],
  );
  if (
    value.status === "limited"
    && value.limited_delivery_scope === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["limited_delivery_scope"],
      message: "A limited skill requires a limited delivery scope",
    });
  }
  if (
    value.status !== "limited"
    && value.limited_delivery_scope !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["limited_delivery_scope"],
      message: "Only a limited skill may carry a limited delivery scope",
    });
  }
  if (
    (value.status === "contested" || value.status === "deprecated")
    && value.lifecycle_receipt_id === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lifecycle_receipt_id"],
      message: "Contested and deprecated versions require a lifecycle receipt",
    });
  }
});

export type ValidatedExecutionSkillV1 = z.infer<
  typeof ValidatedExecutionSkillV1Schema
>;

const SkillLifecycleReceiptMaterialBaseV1Schema = z.object({
  contract_version: z.literal("skill_lifecycle_receipt_v1"),
  receipt_id: BoundedIdSchema,
  skill_id: BoundedIdSchema,
  from_version: z.number().int().positive(),
  to_version: z.number().int().positive(),
  from_status: ValidatedExecutionSkillStatusV1Schema,
  to_status: ValidatedExecutionSkillStatusV1Schema,
  policy_id: BoundedIdSchema,
  policy_version: BoundedVersionSchema,
  evidence_refs: z.array(BoundedReferenceSchema)
    .min(1)
    .max(EXECUTION_SKILL_MAX_EVIDENCE_REFS),
  reason_code: BoundedIdSchema,
  created_at: ExecutionEpisodeCanonicalUtcTimestampSchema,
}).strict();

type SkillLifecycleReceiptMaterialV1 = z.infer<
  typeof SkillLifecycleReceiptMaterialBaseV1Schema
>;

function refineSkillLifecycleReceiptMaterialV1(
  value: SkillLifecycleReceiptMaterialV1,
  context: z.RefinementCtx,
): void {
  addSortedUniqueIssues(value.evidence_refs, context, ["evidence_refs"]);
  if (value.to_version !== value.from_version + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_version"],
      message: "Lifecycle transitions create exactly the next immutable version",
    });
  }
  if (
    (value.from_status !== "limited" && value.from_status !== "validated")
    || (value.to_status !== "contested" && value.to_status !== "deprecated")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to_status"],
      message:
        "Lifecycle receipts only move limited/validated skills to contested/deprecated",
    });
  }
}

const SkillLifecycleReceiptMaterialV1Schema =
  SkillLifecycleReceiptMaterialBaseV1Schema.superRefine(
    refineSkillLifecycleReceiptMaterialV1,
  );

export const SkillLifecycleReceiptV1Schema =
  SkillLifecycleReceiptMaterialBaseV1Schema.extend({
    receipt_sha256: ExecutionEpisodeSha256Schema,
  }).strict().superRefine((value, context) => {
    refineSkillLifecycleReceiptMaterialV1(value, context);
    addMaterialDigestIssue(
      value.receipt_sha256,
      SkillLifecycleReceiptMaterialV1Schema,
      value,
      "receipt_sha256",
      context,
      ["receipt_sha256"],
      "Skill lifecycle receipt digest",
    );
  });

export type SkillLifecycleReceiptV1 = z.infer<
  typeof SkillLifecycleReceiptV1Schema
>;

export function skillLifecycleReceiptDigest(
  value: Omit<SkillLifecycleReceiptV1, "receipt_sha256">,
): string {
  return canonicalDigest(SkillLifecycleReceiptMaterialV1Schema, value);
}

export const ExecutionLearningArtifactV1Schema = z.union([
  CanonicalL1EpisodeV1Schema,
  ContrastiveL2HypothesisV1Schema,
  HeldoutL3SkillVersionV1Schema,
  ExperienceCohortV1Schema,
  ProcedureHypothesisV2Schema,
  SkillValidationReceiptV1Schema,
  ValidatedExecutionSkillV1Schema,
  SkillLifecycleReceiptV1Schema,
]);

export type ExecutionLearningArtifactV1 = z.infer<
  typeof ExecutionLearningArtifactV1Schema
>;

export const EXECUTION_SKILL_CONTRACT_SCHEMAS = {
  bounded_feature_snapshot_v1: BoundedFeatureSnapshotV1Schema,
  canonical_l1_episode_v1: CanonicalL1EpisodeV1Schema,
  contrastive_l2_hypothesis_v1: ContrastiveL2HypothesisV1Schema,
  heldout_l3_skill_version_v1: HeldoutL3SkillVersionV1Schema,
  capability_descriptor_v1: CapabilityDescriptorV1Schema,
  capability_invocation_receipt_v1: CapabilityInvocationReceiptV1Schema,
  counterexample_ref_v1: CounterexampleRefV1Schema,
  embedding_projection_ref_v1: EmbeddingProjectionRefV1Schema,
  evidence_pattern_v1: EvidencePatternV1Schema,
  execution_learning_artifact_v1: ExecutionLearningArtifactV1Schema,
  execution_operand_v1: ExecutionOperandV1Schema,
  execution_predicate_v1: ExecutionPredicateV1Schema,
  expected_transition_v1: ExpectedTransitionV1Schema,
  experience_cohort_v1: ExperienceCohortV1Schema,
  failure_mode_v1: FailureModeV1Schema,
  host_capability_registry_entry_v1: HostCapabilityRegistryEntryV1Schema,
  limited_delivery_scope_v1: LimitedDeliveryScopeV1Schema,
  parameter_binding_receipt_v1: ParameterBindingReceiptV1Schema,
  procedure_content_v1: ProcedureContentV1Schema,
  procedure_hypothesis_v2: ProcedureHypothesisV2Schema,
  procedure_step_v1: ProcedureStepV1Schema,
  recovery_branch_v1: RecoveryBranchV1Schema,
  skill_lifecycle_receipt_v1: SkillLifecycleReceiptV1Schema,
  skill_parameter_v1: SkillParameterV1Schema,
  skill_validation_protocol_v1: SkillValidationProtocolV1Schema,
  skill_validation_receipt_v1: SkillValidationReceiptV1Schema,
  termination_condition_v1: TerminationConditionV1Schema,
  validated_execution_skill_v1: ValidatedExecutionSkillV1Schema,
  verification_step_v1: VerificationStepV1Schema,
  version_constraint_v1: VersionConstraintV1Schema,
} as const;
