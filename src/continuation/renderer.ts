import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type SelectedCapsuleV1,
  type Sha256,
} from "./contract.js";

export const CONTINUATION_PROJECTION_FORMAT_V1 = "aionis-agent-context-v1" as const;

export type ContinuationProjectionCapsuleV1 = Readonly<{
  capsule: CapsuleRefV1;
  surface: SelectedCapsuleV1["surface"];
  coverage_bindings: SelectedCapsuleV1["coverage_bindings"];
  satisfied_probe_ids: readonly string[];
  projection: ExecutionCapsuleV1["projection"];
}>;

export type ContinuationAgentProjectionV1 = Readonly<{
  schema_version: "continuation_agent_projection_v1";
  format: typeof CONTINUATION_PROJECTION_FORMAT_V1;
  identity: ContinuationContractV1["identity"];
  authority: ContinuationContractV1["authority"];
  obligations: readonly ContinuationObligationV1[];
  selected_capsules: readonly ContinuationProjectionCapsuleV1[];
  /** Exact archived capsule refs whose bodies were deliberately not rendered. */
  rehydration_capsule_refs: readonly CapsuleRefV1[];
  /** E=execute, I=inspect, R=rehydrate, B=block, U=report_unresolved. */
  safe_fallback_code: "E" | "I" | "R" | "B" | "U";
  contract_sha256: Sha256;
  coverage_certificate_sha256: Sha256;
}>;

export type RenderedContinuationProjectionV1 =
  | Readonly<{
    status: "rendered";
    format: typeof CONTINUATION_PROJECTION_FORMAT_V1;
    content: string;
    projection_sha256: Sha256;
    required_bytes: number;
    budget_bytes: number;
    render_result_sha256: Sha256;
  }>
  | Readonly<{
    status: "not_renderable";
    format: typeof CONTINUATION_PROJECTION_FORMAT_V1;
    content: null;
    projection_sha256: null;
    required_bytes: number;
    budget_bytes: number;
    render_result_sha256: Sha256;
  }>;

type RenderedContinuationProjectionBodyV1 =
  | Omit<Extract<RenderedContinuationProjectionV1, { status: "rendered" }>, "render_result_sha256">
  | Omit<Extract<RenderedContinuationProjectionV1, { status: "not_renderable" }>, "render_result_sha256">;

function finalizeRenderResult<T extends RenderedContinuationProjectionBodyV1>(
  body: T,
): T & Readonly<{ render_result_sha256: Sha256 }> {
  return canonicalContinuationClone({
    ...body,
    render_result_sha256: canonicalContinuationSha256(body),
  });
}

function exactRenderResultRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("continuation render result must be a plain record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuation render result must be a plain record");
  }
  const status = Object.getOwnPropertyDescriptor(value, "status");
  if (!status || !status.enumerable || !("value" in status)
    || (status.value !== "rendered" && status.value !== "not_renderable")) {
    throw new Error("continuation render result status is invalid");
  }
  const expected = [
    "budget_bytes",
    "content",
    "format",
    "projection_sha256",
    "render_result_sha256",
    "required_bytes",
    "status",
  ].sort(compareCanonicalUtf8);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error("continuation render result shape is invalid");
  }
  const actual = [...ownKeys as string[]].sort(compareCanonicalUtf8);
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error("continuation render result shape is invalid");
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("continuation render result shape is invalid");
    }
    record[key] = descriptor.value;
  }
  return record;
}

export function verifyRenderedContinuationProjectionV1(
  value: unknown,
): RenderedContinuationProjectionV1 {
  const record = exactRenderResultRecord(value);
  if (record.format !== CONTINUATION_PROJECTION_FORMAT_V1
    || !Number.isSafeInteger(record.required_bytes)
    || !Number.isSafeInteger(record.budget_bytes)
    || (record.required_bytes as number) < 0
    || (record.budget_bytes as number) < 1_024
    || (record.budget_bytes as number) > 65_536
    || typeof record.render_result_sha256 !== "string") {
    throw new Error("continuation render result fields are invalid");
  }
  assertSha256(record.render_result_sha256, "render_result_sha256");
  if (canonicalSha256Without(
    value as Readonly<Record<string, unknown>>,
    "render_result_sha256",
  ) !== record.render_result_sha256) {
    throw new Error("continuation render result digest mismatch");
  }
  if (record.status === "rendered") {
    if (typeof record.content !== "string"
      || typeof record.projection_sha256 !== "string"
      || (record.required_bytes as number) > (record.budget_bytes as number)
      || Buffer.byteLength(record.content, "utf8") !== record.required_bytes) {
      throw new Error("rendered continuation result is inconsistent");
    }
    assertSha256(record.projection_sha256, "projection_sha256");
    let projection: unknown;
    try {
      projection = JSON.parse(record.content) as unknown;
    } catch (error) {
      throw new Error("rendered continuation projection is invalid JSON", { cause: error });
    }
    if (canonicalContinuationJson(projection) !== record.content
      || canonicalContinuationSha256(projection) !== record.projection_sha256) {
      throw new Error("rendered continuation projection digest mismatch");
    }
  } else if (record.content !== null
    || record.projection_sha256 !== null
    || (record.required_bytes as number) <= (record.budget_bytes as number)) {
    throw new Error("non-renderable continuation result is inconsistent");
  }
  return canonicalContinuationClone(value as RenderedContinuationProjectionV1);
}

export type ContinuationProjectionPlanV1 = Readonly<{
  identity: ContinuationContractV1["identity"];
  authority: ContinuationContractV1["authority"];
  obligations: readonly ContinuationObligationV1[];
  selected_capsules: readonly Readonly<{
    selection: SelectedCapsuleV1;
    capsule: ExecutionCapsuleV1;
  }>[];
  rehydration_capsule_refs: readonly CapsuleRefV1[];
  safe_fallback_mode: ContinuationContractV1["safe_fallback"]["mode"];
  contract_sha256: Sha256;
  coverage_certificate_sha256: Sha256;
}>;

const ZERO_SHA256 = "0".repeat(64);

function capsuleRefKey(ref: CapsuleRefV1): string {
  return `${ref.capsule_id}\0${ref.capsule_revision}\0${ref.capsule_sha256}`;
}

function fallbackCode(
  mode: ContinuationContractV1["safe_fallback"]["mode"],
): ContinuationAgentProjectionV1["safe_fallback_code"] {
  if (mode === "execute") return "E";
  if (mode === "inspect") return "I";
  if (mode === "rehydrate") return "R";
  if (mode === "block") return "B";
  return "U";
}

function projectionCapsule(args: {
  selection: SelectedCapsuleV1;
  capsule: ExecutionCapsuleV1;
}): ContinuationProjectionCapsuleV1 {
  if (capsuleRefKey(args.selection.capsule) !== capsuleRefKey(args.capsule)) {
    throw new Error("continuation renderer capsule ref does not match its selected surface");
  }
  if (canonicalSha256Without(args.capsule, "capsule_sha256") !== args.capsule.capsule_sha256
    || canonicalSha256Without(args.capsule.projection, "projection_sha256")
      !== args.capsule.projection.projection_sha256) {
    throw new Error("continuation renderer capsule digest mismatch");
  }
  return {
    capsule: args.selection.capsule,
    surface: args.selection.surface,
    coverage_bindings: args.selection.coverage_bindings,
    satisfied_probe_ids: args.selection.satisfied_probe_ids,
    projection: args.capsule.projection,
  };
}

function projectionBody(plan: ContinuationProjectionPlanV1): ContinuationAgentProjectionV1 {
  const selected = canonicalUniqueSet(plan.selected_capsules, (item) => capsuleRefKey(item.selection.capsule));
  const rehydrationCapsuleRefs = canonicalUniqueSet(
    plan.rehydration_capsule_refs,
    capsuleRefKey,
  );
  return {
    schema_version: "continuation_agent_projection_v1",
    format: CONTINUATION_PROJECTION_FORMAT_V1,
    identity: plan.identity,
    authority: plan.authority,
    obligations: plan.obligations,
    selected_capsules: selected.map(projectionCapsule),
    rehydration_capsule_refs: rehydrationCapsuleRefs,
    safe_fallback_code: fallbackCode(plan.safe_fallback_mode),
    contract_sha256: plan.contract_sha256,
    coverage_certificate_sha256: plan.coverage_certificate_sha256,
  };
}

export function continuationProjectionCapsuleBytesV1(args: {
  selection: SelectedCapsuleV1;
  capsule: ExecutionCapsuleV1;
}): number {
  return Buffer.byteLength(canonicalContinuationJson(projectionCapsule(args)), "utf8");
}

export function continuationProjectionFrameBytesV1(args: {
  identity: ContinuationContractV1["identity"];
  authority: ContinuationContractV1["authority"];
  obligations: readonly ContinuationObligationV1[];
  rehydration_capsule_refs: readonly CapsuleRefV1[];
}): number {
  return Buffer.byteLength(canonicalContinuationJson(projectionBody({
    ...args,
    selected_capsules: [],
    safe_fallback_mode: "report_unresolved",
    contract_sha256: ZERO_SHA256,
    coverage_certificate_sha256: ZERO_SHA256,
  })), "utf8");
}

/** Additional canonical frame bytes introduced by body-free rehydration refs. */
export function continuationProjectionRehydrationRefsBytesV1(
  refs: readonly CapsuleRefV1[],
): number {
  const canonicalRefs = canonicalUniqueSet(refs, capsuleRefKey);
  return Buffer.byteLength(canonicalContinuationJson(canonicalRefs), "utf8") - 2;
}

export function measureContinuationProjectionBytesV1(plan: Omit<
  ContinuationProjectionPlanV1,
  "contract_sha256" | "coverage_certificate_sha256"
>): number {
  return Buffer.byteLength(canonicalContinuationJson(projectionBody({
    ...plan,
    contract_sha256: ZERO_SHA256,
    coverage_certificate_sha256: ZERO_SHA256,
  })), "utf8");
}

export function renderContinuationProjectionV1(args: {
  contract: ContinuationContractV1;
  capsules: readonly ExecutionCapsuleV1[];
}): RenderedContinuationProjectionV1 {
  if (canonicalSha256Without(args.contract, "contract_sha256") !== args.contract.contract_sha256) {
    throw new Error("continuation renderer contract digest mismatch");
  }
  const certificate = args.contract.coverage_certificate;
  if (canonicalSha256Without(certificate, "certificate_sha256") !== certificate.certificate_sha256) {
    throw new Error("continuation renderer coverage certificate digest mismatch");
  }
  const selected = canonicalUniqueSet(args.contract.selected_capsules, (item) => capsuleRefKey(item.capsule));
  if (selected.some((item, index) => capsuleRefKey(item.capsule)
    !== capsuleRefKey(args.contract.selected_capsules[index]!.capsule))) {
    throw new Error("continuation renderer selected capsules are not in canonical order");
  }
  const capsules = canonicalUniqueSet(args.capsules, capsuleRefKey);
  if (capsules.length !== selected.length) {
    throw new Error("continuation renderer requires the exact selected capsule set");
  }
  const capsulesByRef = new Map(capsules.map((capsule) => [capsuleRefKey(capsule), capsule]));
  const selectedCapsules = selected.map((selection) => {
    const capsule = capsulesByRef.get(capsuleRefKey(selection.capsule));
    if (!capsule) throw new Error("continuation renderer is missing a selected capsule");
    return { selection, capsule };
  });
  const rehydrationCapsuleRefs = canonicalUniqueSet(
    args.contract.excluded_capsules.flatMap((excluded) =>
      excluded.reason_codes.includes("lifecycle_archived_rehydration_required")
        ? [excluded.capsule]
        : []
    ),
    capsuleRefKey,
  );
  const content = canonicalContinuationJson(projectionBody({
    identity: args.contract.identity,
    authority: args.contract.authority,
    obligations: args.contract.obligations,
    selected_capsules: selectedCapsules,
    rehydration_capsule_refs: rehydrationCapsuleRefs,
    safe_fallback_mode: args.contract.safe_fallback.mode,
    contract_sha256: args.contract.contract_sha256,
    coverage_certificate_sha256: certificate.certificate_sha256,
  }));
  const requiredBytes = Buffer.byteLength(content, "utf8");
  if (requiredBytes !== certificate.required_render_bytes) {
    throw new Error("continuation renderer byte count does not match the coverage certificate");
  }
  const budgetBytes = args.contract.compiler.render_budget;
  if (requiredBytes > budgetBytes) {
    if (certificate.budget_satisfied) {
      throw new Error("continuation renderer budget state contradicts the coverage certificate");
    }
    return finalizeRenderResult({
      status: "not_renderable",
      format: CONTINUATION_PROJECTION_FORMAT_V1,
      content: null,
      projection_sha256: null,
      required_bytes: requiredBytes,
      budget_bytes: budgetBytes,
    });
  }
  if (!certificate.budget_satisfied) {
    throw new Error("continuation renderer budget state contradicts the coverage certificate");
  }
  return finalizeRenderResult({
    status: "rendered",
    format: CONTINUATION_PROJECTION_FORMAT_V1,
    content,
    projection_sha256: canonicalContinuationSha256(projectionBody({
      identity: args.contract.identity,
      authority: args.contract.authority,
      obligations: args.contract.obligations,
      selected_capsules: selectedCapsules,
      rehydration_capsule_refs: rehydrationCapsuleRefs,
      safe_fallback_mode: args.contract.safe_fallback.mode,
      contract_sha256: args.contract.contract_sha256,
      coverage_certificate_sha256: certificate.certificate_sha256,
    })),
    required_bytes: requiredBytes,
    budget_bytes: budgetBytes,
  });
}

export function compareContinuationProjectionCapsulesV1(
  left: ContinuationProjectionCapsuleV1,
  right: ContinuationProjectionCapsuleV1,
): number {
  return compareCanonicalUtf8(capsuleRefKey(left.capsule), capsuleRefKey(right.capsule));
}
