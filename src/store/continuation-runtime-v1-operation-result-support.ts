import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  compareCanonicalUtf8,
  type CanonicalJson,
  type Sha256,
} from "../continuation/contract.js";
import type {
  DurableJobCreationOperationRefV1,
  ExperimentCohortInstallAuthorityDecisionResultV1,
  ContinuationRuntimeV1OperationResultSetV1,
  ContinuationRuntimeV1OperationResultV1,
  PolicyBundleInstallAuthorityDecisionResultV1,
} from "./continuation-runtime-v1-operation-result.js";

export type OperationResultRow = Readonly<Record<string, unknown>>;

export function operationResultFail(code: string): never {
  throw new Error(`continuation_runtime_v1_operation_result_${code}`);
}

export function operationResultExact(
  value: unknown,
  keys: readonly string[],
  field: string,
): OperationResultRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    operationResultFail(`${field}_shape_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const wanted = [...keys].sort(compareCanonicalUtf8);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== wanted.length) {
    operationResultFail(`${field}_shape_invalid`);
  }
  const actual = [...ownKeys as string[]].sort(compareCanonicalUtf8);
  if (actual.some((key, index) => key !== wanted[index])) {
    operationResultFail(`${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      operationResultFail(`${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function operationResultArray(
  value: unknown,
  maximum: number,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) {
    operationResultFail(`${field}_array_invalid`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1
    || ownKeys.some((key) => typeof key !== "string")) {
    operationResultFail(`${field}_array_invalid`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      operationResultFail(`${field}_array_invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

export function operationResultText(
  value: unknown,
  field: string,
  maximumBytes = 256,
): string {
  if (typeof value !== "string") operationResultFail(`${field}_text_invalid`);
  assertUnicodeScalarString(value, `operation result ${field}`);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    operationResultFail(`${field}_text_invalid`);
  }
  return value;
}

export function operationResultSha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") operationResultFail(`${field}_sha256_invalid`);
  try {
    assertSha256(value, `operation result ${field}`);
  } catch (error) {
    throw new Error(
      `continuation_runtime_v1_operation_result_${field}_sha256_invalid`,
      { cause: error },
    );
  }
  return value;
}

export function operationResultInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum) {
    operationResultFail(`${field}_integer_invalid`);
  }
  return value as number;
}

export function operationResultCanonicalJson(
  value: unknown,
  field: string,
): CanonicalJson {
  if (typeof value !== "string") operationResultFail(`${field}_json_invalid`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    operationResultFail(`${field}_json_invalid`);
  }
  if (canonicalContinuationJson(parsed) !== value) {
    operationResultFail(`${field}_json_noncanonical`);
  }
  return parsed as CanonicalJson;
}

export function canonicalOperationResultSetV1<TRef extends CanonicalJson>(
  refs: readonly TRef[],
): ContinuationRuntimeV1OperationResultSetV1<TRef> {
  const sorted = refs.map((ref) => canonicalContinuationClone(ref)).sort(
    (left, right) => compareCanonicalUtf8(
      canonicalContinuationJson(left),
      canonicalContinuationJson(right),
    ),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (canonicalContinuationJson(sorted[index - 1])
      === canonicalContinuationJson(sorted[index])) {
      operationResultFail("duplicate_set_ref");
    }
  }
  return canonicalContinuationClone({
    count: sorted.length,
    set_sha256: canonicalContinuationSha256(sorted),
    refs: sorted,
  });
}

export function assertContinuationRuntimeV1OperationResultDeclaration(
  declared: unknown,
  derived: ContinuationRuntimeV1OperationResultV1,
): asserts declared is ContinuationRuntimeV1OperationResultV1 {
  let declaredJson: string;
  try {
    declaredJson = canonicalContinuationJson(declared);
  } catch (error) {
    throw new Error(
      "continuation_runtime_v1_operation_result_declaration_not_canonical",
      { cause: error },
    );
  }
  if (declaredJson !== canonicalContinuationJson(derived)) {
    throw new Error(
      "continuation_runtime_v1_operation_result_declaration_mismatch",
    );
  }
}

function artifactRef(value: unknown, field: string): Readonly<{
  artifact_sha256: Sha256;
  payload_sha256: Sha256;
}> {
  const record = operationResultExact(
    value,
    ["artifact_sha256", "payload_sha256"],
    field,
  );
  return canonicalContinuationClone({
    artifact_sha256: operationResultSha256(
      record.artifact_sha256,
      `${field}_artifact`,
    ),
    payload_sha256: operationResultSha256(
      record.payload_sha256,
      `${field}_payload`,
    ),
  });
}

function durableJobCreationRef(
  value: unknown,
  field: string,
): DurableJobCreationOperationRefV1 {
  const record = operationResultExact(value, [
    "authority_subject_sha256", "definition_sha256", "job_id", "job_kind",
    "payload_sha256", "task_family",
  ], field);
  if (record.job_kind !== "embedding" && record.job_kind !== "ann"
    && record.job_kind !== "effect" && record.job_kind !== "retention") {
    operationResultFail(`${field}_kind_invalid`);
  }
  return canonicalContinuationClone({
    task_family: operationResultText(record.task_family, `${field}_task_family`),
    authority_subject_sha256: operationResultSha256(
      record.authority_subject_sha256,
      `${field}_authority_subject`,
    ),
    job_id: operationResultText(record.job_id, `${field}_job_id`),
    job_kind: record.job_kind,
    payload_sha256: operationResultSha256(
      record.payload_sha256,
      `${field}_payload`,
    ),
    definition_sha256: operationResultSha256(
      record.definition_sha256,
      `${field}_definition`,
    ),
  });
}

export function projectExperimentCohortInstallAuthorityDecisionResultV1(
  value: unknown,
): ExperimentCohortInstallAuthorityDecisionResultV1 {
  const record = operationResultExact(value, [
    "effect_job_ref",
    "experiment_cohort_ref",
    "decision_kind",
    "schema_version",
  ], "experiment_cohort_install");
  if (record.schema_version !== "authority_decision_result_v1"
    || record.decision_kind !== "experiment_cohort_install") {
    operationResultFail("experiment_cohort_install_discriminator_invalid");
  }
  const effectJobRef = durableJobCreationRef(record.effect_job_ref, "effect_job_ref");
  if (effectJobRef.job_kind !== "effect") {
    operationResultFail("experiment_cohort_install_job_kind_invalid");
  }
  return canonicalContinuationClone({
    schema_version: "authority_decision_result_v1" as const,
    decision_kind: "experiment_cohort_install" as const,
    experiment_cohort_ref: artifactRef(
      record.experiment_cohort_ref,
      "experiment_cohort_install_ref",
    ),
    effect_job_ref: {
      ...effectJobRef,
      job_kind: "effect" as const,
    },
  });
}

export function projectPolicyBundleInstallAuthorityDecisionResultV1(
  value: unknown,
): PolicyBundleInstallAuthorityDecisionResultV1 {
  const record = operationResultExact(value, [
    "compiler_policy_ref",
    "decision_kind",
    "evidence_policy_ref",
    "schema_version",
  ], "policy_bundle_install");
  if (record.schema_version !== "authority_decision_result_v1"
    || record.decision_kind !== "policy_bundle_install") {
    operationResultFail("policy_bundle_install_discriminator_invalid");
  }
  return canonicalContinuationClone({
    schema_version: "authority_decision_result_v1" as const,
    decision_kind: "policy_bundle_install" as const,
    compiler_policy_ref: artifactRef(
      record.compiler_policy_ref,
      "compiler_policy_ref",
    ),
    evidence_policy_ref: artifactRef(
      record.evidence_policy_ref,
      "evidence_policy_ref",
    ),
  });
}
