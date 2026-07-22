import {
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  compareCanonicalUtf8,
  type AuthorityArtifactRefV1,
  type AuthorityBranchRefV1,
  type CapsuleRefV1,
  type Sha256,
} from "./contract.js";

export type AuthorityBranchKindV1 = "authoritative" | "candidate";

export type AuthorityBranchStateV1 =
  | "authoritative"
  | "draft"
  | "shadow"
  | "eligible"
  | "active_candidate"
  | "merged"
  | "rejected"
  | "quarantined"
  | "expired";

export type AuthorityBranchRevisionRefV1 = AuthorityBranchRefV1 & Readonly<{
  branch_kind: AuthorityBranchKindV1;
  state: AuthorityBranchStateV1;
}>;

export type AuthoritativeBranchRevisionRefV1 = AuthorityBranchRevisionRefV1 & Readonly<{
  branch_kind: "authoritative";
  state: "authoritative";
}>;

export type AuthorityBranchCapsuleBindingV1 = Readonly<{
  capsule_scope: string;
  capsule: CapsuleRefV1;
  disposition: "include" | "exclude" | "prohibit";
  admission_authority: "candidate" | "authoritative";
}>;

/**
 * Immutable provenance for learning capsules admitted from one trusted-host
 * observation. The enclosing candidate draft's source_operation supplies the
 * exact operation tuple; both roots must be children of that same
 * record_observations write. Verified continuity never enters an authority
 * branch: DecisionAssembly projects it directly from an exact memory head.
 */
export type TrustedObservationAdmissionRefV1 = Readonly<{
  schema_version: "trusted_observation_admission_ref_v1";
  observation_snapshot_ref: Readonly<{
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
    host_task_envelope_sha256: Sha256;
  }>;
  memory_revision_ref: Readonly<{
    revision: number;
    commit_id: string;
    commit_sha256: Sha256;
    mutation_sha256: Sha256;
    head_sha256: Sha256;
    item_count: number;
    item_set_sha256: Sha256;
    relation_count: number;
    relation_set_sha256: Sha256;
    capsule_count: number;
    capsule_set_sha256: Sha256;
  }>;
}>;

export type AuthorityBranchManifestInputV1 = Readonly<{
  tenant_id: string;
  authority_subject_sha256: Sha256;
  branch_id: string;
  branch_revision: number;
  branch_kind: AuthorityBranchKindV1;
  state: AuthorityBranchStateV1;
  base_authoritative_ref: AuthoritativeBranchRevisionRefV1 | null;
  previous_revision_ref: AuthorityBranchRevisionRefV1 | null;
  capsule_bindings: readonly AuthorityBranchCapsuleBindingV1[];
  compiler_policy_ref: AuthorityArtifactRefV1;
  evidence_policy_ref: AuthorityArtifactRefV1;
  effect_certificate_sha256: Sha256 | null;
  reverts_authority_ref: AuthoritativeBranchRevisionRefV1 | null;
  policy_rotation_artifact_ref: AuthorityArtifactRefV1 | null;
  trusted_observation_admission_ref: TrustedObservationAdmissionRefV1 | null;
  created_at: string;
}>;

export type AuthorityBranchManifestV1 = AuthorityBranchManifestInputV1 & Readonly<{
  schema_version: "authority_branch_manifest_v1";
  manifest_sha256: Sha256;
}>;

export type AuthorityBranchManifestErrorCode =
  | "invalid_authority_branch_manifest"
  | "authority_branch_manifest_digest_mismatch";

export class AuthorityBranchManifestError extends Error {
  readonly code: AuthorityBranchManifestErrorCode;

  constructor(
    code: AuthorityBranchManifestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AuthorityBranchManifestError";
    this.code = code;
  }
}

const MANIFEST_MAX_BYTES = 262_144;
const MAX_CAPSULE_BINDINGS = 4_096;

const INPUT_KEYS = Object.freeze([
  "authority_subject_sha256",
  "base_authoritative_ref",
  "branch_id",
  "branch_kind",
  "branch_revision",
  "capsule_bindings",
  "compiler_policy_ref",
  "created_at",
  "effect_certificate_sha256",
  "evidence_policy_ref",
  "policy_rotation_artifact_ref",
  "previous_revision_ref",
  "reverts_authority_ref",
  "state",
  "tenant_id",
  "trusted_observation_admission_ref",
] as const);

const MANIFEST_KEYS = Object.freeze([
  ...INPUT_KEYS,
  "manifest_sha256",
  "schema_version",
] as const);

const REVISION_REF_KEYS = Object.freeze([
  "branch_id",
  "branch_kind",
  "branch_revision",
  "manifest_sha256",
  "state",
] as const);

const BINDING_KEYS = Object.freeze([
  "admission_authority",
  "capsule",
  "capsule_scope",
  "disposition",
] as const);

const CAPSULE_REF_KEYS = Object.freeze([
  "capsule_id",
  "capsule_revision",
  "capsule_sha256",
] as const);

const POLICY_REF_KEYS = Object.freeze([
  "artifact_sha256",
  "payload_sha256",
] as const);

const OBSERVATION_ADMISSION_KEYS = Object.freeze([
  "memory_revision_ref", "observation_snapshot_ref", "schema_version",
] as const);

const OBSERVATION_SNAPSHOT_REF_KEYS = Object.freeze([
  "host_task_envelope_sha256", "world_snapshot_id", "world_snapshot_sha256",
] as const);

const MEMORY_REVISION_REF_KEYS = Object.freeze([
  "capsule_count", "capsule_set_sha256", "commit_id", "commit_sha256",
  "head_sha256", "item_count", "item_set_sha256", "mutation_sha256",
  "relation_count", "relation_set_sha256", "revision",
] as const);

const CANDIDATE_STATES = new Set<AuthorityBranchStateV1>([
  "draft",
  "shadow",
  "eligible",
  "active_candidate",
  "merged",
  "rejected",
  "quarantined",
  "expired",
]);

const CANDIDATE_TRANSITIONS = new Map<AuthorityBranchStateV1, ReadonlySet<AuthorityBranchStateV1>>([
  ["draft", new Set(["shadow", "rejected", "quarantined", "expired"])],
  ["shadow", new Set(["eligible", "rejected", "quarantined", "expired"])],
  ["eligible", new Set(["active_candidate", "rejected", "quarantined", "expired"])],
  ["active_candidate", new Set(["merged", "rejected", "quarantined", "expired"])],
]);

function fail(message: string): never {
  throw new AuthorityBranchManifestError("invalid_authority_branch_manifest", message);
}

function wrapInvalid<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AuthorityBranchManifestError) throw error;
    throw new AuthorityBranchManifestError(
      "invalid_authority_branch_manifest",
      error instanceof Error ? error.message : "authority branch manifest validation failed",
      { cause: error },
    );
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(`${label} must contain only string-keyed data properties`);
  }
  const actual = ownKeys as string[];
  const expected = new Set(expectedKeys);
  if (actual.length !== expectedKeys.length
    || actual.some((key) => !expected.has(key))
    || expectedKeys.some((key) => !actual.includes(key))) {
    fail(`${label} contains unknown or missing fields`);
  }
  const detached = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    assertUnicodeScalarString(key, `${label} key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${label} must contain only enumerable data properties`);
    }
    detached[key] = descriptor.value;
  }
  return detached;
}

function exactBindingArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("capsule_bindings must be a plain array");
  }
  if (value.length > MAX_CAPSULE_BINDINGS) {
    fail(`capsule_bindings exceeds ${MAX_CAPSULE_BINDINGS} entries`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
    || ownKeys.length !== expected.size) {
    fail("capsule_bindings must be a dense array without extra properties");
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("capsule_bindings must contain only enumerable data elements");
    }
    out.push(descriptor.value);
  }
  return out;
}

function boundedText(value: unknown, field: string, maxBytes = 256): string {
  if (typeof value !== "string") fail(`${field} must be text`);
  assertUnicodeScalarString(value, field);
  if (value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${field} must contain 1-${maxBytes} canonical UTF-8 bytes and no C0 or DEL controls`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requiredSha256(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field} must be a SHA-256 digest`);
  assertSha256(value, field);
  return value;
}

function optionalSha256(value: unknown, field: string): Sha256 | null {
  return value === null ? null : requiredSha256(value, field);
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a timestamp`);
  assertCanonicalUtcMillis(value, field);
  return value;
}

function branchKind(value: unknown, field: string): AuthorityBranchKindV1 {
  if (value !== "authoritative" && value !== "candidate") {
    fail(`${field} is not a closed V1 branch kind`);
  }
  return value;
}

function branchState(value: unknown, field: string): AuthorityBranchStateV1 {
  if (value !== "authoritative" && !CANDIDATE_STATES.has(value as AuthorityBranchStateV1)) {
    fail(`${field} is not a closed V1 branch state`);
  }
  return value as AuthorityBranchStateV1;
}

function assertKindState(
  kind: AuthorityBranchKindV1,
  state: AuthorityBranchStateV1,
  field: string,
): void {
  if ((kind === "authoritative" && state !== "authoritative")
    || (kind === "candidate" && !CANDIDATE_STATES.has(state))) {
    fail(`${field} branch kind and state are inconsistent`);
  }
}

function revisionRef(value: unknown, field: string): AuthorityBranchRevisionRefV1 {
  const record = exactRecord(value, REVISION_REF_KEYS, field);
  const kind = branchKind(record.branch_kind, `${field}.branch_kind`);
  const state = branchState(record.state, `${field}.state`);
  const revision = positiveSafeInteger(record.branch_revision, `${field}.branch_revision`);
  assertKindState(kind, state, field);
  if (kind === "candidate"
    && ((revision === 1 && state !== "draft") || (revision > 1 && state === "draft"))) {
    fail(`${field} candidate revision/state pairing is impossible`);
  }
  return {
    branch_id: boundedText(record.branch_id, `${field}.branch_id`),
    branch_revision: revision,
    manifest_sha256: requiredSha256(record.manifest_sha256, `${field}.manifest_sha256`),
    branch_kind: kind,
    state,
  };
}

function authoritativeRef(
  value: unknown,
  field: string,
): AuthoritativeBranchRevisionRefV1 {
  const parsed = revisionRef(value, field);
  if (parsed.branch_kind !== "authoritative" || parsed.state !== "authoritative") {
    fail(`${field} must identify an authoritative branch revision`);
  }
  return parsed as AuthoritativeBranchRevisionRefV1;
}

function capsuleRef(value: unknown, field: string): CapsuleRefV1 {
  const record = exactRecord(value, CAPSULE_REF_KEYS, field);
  return {
    capsule_id: boundedText(record.capsule_id, `${field}.capsule_id`),
    capsule_revision: positiveSafeInteger(record.capsule_revision, `${field}.capsule_revision`),
    capsule_sha256: requiredSha256(record.capsule_sha256, `${field}.capsule_sha256`),
  };
}

function authorityArtifactRef(value: unknown, field: string): AuthorityArtifactRefV1 {
  const record = exactRecord(value, POLICY_REF_KEYS, field);
  return {
    artifact_sha256: requiredSha256(record.artifact_sha256, `${field}.artifact_sha256`),
    payload_sha256: requiredSha256(record.payload_sha256, `${field}.payload_sha256`),
  };
}

function nullableAuthorityArtifactRef(
  value: unknown,
  field: string,
): AuthorityArtifactRefV1 | null {
  return value === null ? null : authorityArtifactRef(value, field);
}

function trustedObservationAdmissionRef(
  value: unknown,
): TrustedObservationAdmissionRefV1 {
  const record = exactRecord(
    value,
    OBSERVATION_ADMISSION_KEYS,
    "trusted_observation_admission_ref",
  );
  if (record.schema_version !== "trusted_observation_admission_ref_v1") {
    fail("trusted_observation_admission_ref schema_version is invalid");
  }
  const snapshot = exactRecord(
    record.observation_snapshot_ref,
    OBSERVATION_SNAPSHOT_REF_KEYS,
    "trusted_observation_admission_ref.observation_snapshot_ref",
  );
  const memory = exactRecord(
    record.memory_revision_ref,
    MEMORY_REVISION_REF_KEYS,
    "trusted_observation_admission_ref.memory_revision_ref",
  );
  return {
    schema_version: "trusted_observation_admission_ref_v1",
    observation_snapshot_ref: {
      world_snapshot_id: boundedText(
        snapshot.world_snapshot_id,
        "trusted_observation_admission_ref.world_snapshot_id",
      ),
      world_snapshot_sha256: requiredSha256(
        snapshot.world_snapshot_sha256,
        "trusted_observation_admission_ref.world_snapshot_sha256",
      ),
      host_task_envelope_sha256: requiredSha256(
        snapshot.host_task_envelope_sha256,
        "trusted_observation_admission_ref.host_task_envelope_sha256",
      ),
    },
    memory_revision_ref: {
      revision: positiveSafeInteger(
        memory.revision,
        "trusted_observation_admission_ref.memory_revision",
      ),
      commit_id: boundedText(
        memory.commit_id,
        "trusted_observation_admission_ref.commit_id",
      ),
      commit_sha256: requiredSha256(
        memory.commit_sha256,
        "trusted_observation_admission_ref.commit_sha256",
      ),
      mutation_sha256: requiredSha256(
        memory.mutation_sha256,
        "trusted_observation_admission_ref.mutation_sha256",
      ),
      head_sha256: requiredSha256(
        memory.head_sha256,
        "trusted_observation_admission_ref.head_sha256",
      ),
      item_count: nonNegativeSafeInteger(
        memory.item_count,
        "trusted_observation_admission_ref.item_count",
      ),
      item_set_sha256: requiredSha256(
        memory.item_set_sha256,
        "trusted_observation_admission_ref.item_set_sha256",
      ),
      relation_count: nonNegativeSafeInteger(
        memory.relation_count,
        "trusted_observation_admission_ref.relation_count",
      ),
      relation_set_sha256: requiredSha256(
        memory.relation_set_sha256,
        "trusted_observation_admission_ref.relation_set_sha256",
      ),
      capsule_count: nonNegativeSafeInteger(
        memory.capsule_count,
        "trusted_observation_admission_ref.capsule_count",
      ),
      capsule_set_sha256: requiredSha256(
        memory.capsule_set_sha256,
        "trusted_observation_admission_ref.capsule_set_sha256",
      ),
    },
  };
}

function nullableTrustedObservationAdmissionRef(
  value: unknown,
): TrustedObservationAdmissionRefV1 | null {
  return value === null ? null : trustedObservationAdmissionRef(value);
}

function disposition(value: unknown): AuthorityBranchCapsuleBindingV1["disposition"] {
  if (value !== "include" && value !== "exclude" && value !== "prohibit") {
    fail("capsule binding disposition is not a closed V1 value");
  }
  return value;
}

function admissionAuthority(
  value: unknown,
): AuthorityBranchCapsuleBindingV1["admission_authority"] {
  if (value !== "candidate" && value !== "authoritative") {
    fail("capsule binding admission_authority is not a closed V1 value");
  }
  return value;
}

function capsuleBinding(value: unknown, index: number): AuthorityBranchCapsuleBindingV1 {
  const field = `capsule_bindings[${index}]`;
  const record = exactRecord(value, BINDING_KEYS, field);
  return {
    capsule_scope: boundedText(record.capsule_scope, `${field}.capsule_scope`),
    capsule: capsuleRef(record.capsule, `${field}.capsule`),
    disposition: disposition(record.disposition),
    admission_authority: admissionAuthority(record.admission_authority),
  };
}

function compareBindings(
  left: AuthorityBranchCapsuleBindingV1,
  right: AuthorityBranchCapsuleBindingV1,
): number {
  let compared = compareCanonicalUtf8(left.capsule_scope, right.capsule_scope);
  if (compared !== 0) return compared;
  compared = compareCanonicalUtf8(left.capsule.capsule_id, right.capsule.capsule_id);
  if (compared !== 0) return compared;
  if (left.capsule.capsule_revision !== right.capsule.capsule_revision) {
    return left.capsule.capsule_revision < right.capsule.capsule_revision ? -1 : 1;
  }
  return compareCanonicalUtf8(left.disposition, right.disposition);
}

function capsuleBindings(value: unknown): readonly AuthorityBranchCapsuleBindingV1[] {
  const parsed = exactBindingArray(value).map((entry, index) => capsuleBinding(entry, index));
  const seen = new Set<string>();
  for (const binding of parsed) {
    const identity = canonicalContinuationJson([
      binding.capsule_scope,
      binding.capsule.capsule_id,
    ]);
    if (seen.has(identity)) {
      fail("a branch may bind only one revision of a capsule identity");
    }
    seen.add(identity);
  }
  return parsed.sort(compareBindings);
}

function nullableRevisionRef(
  value: unknown,
  field: string,
): AuthorityBranchRevisionRefV1 | null {
  return value === null ? null : revisionRef(value, field);
}

function nullableAuthoritativeRef(
  value: unknown,
  field: string,
): AuthoritativeBranchRevisionRefV1 | null {
  return value === null ? null : authoritativeRef(value, field);
}

function assertRevisionConsistency(input: AuthorityBranchManifestInputV1): void {
  assertKindState(input.branch_kind, input.state, "manifest");
  if (input.branch_kind === "authoritative") {
    if (input.base_authoritative_ref !== null) {
      fail("authoritative branches must not have a base_authoritative_ref");
    }
  } else {
    if (input.base_authoritative_ref === null) {
      fail("candidate branches require a base_authoritative_ref");
    }
    if (input.base_authoritative_ref.branch_id === input.branch_id) {
      fail("candidate branch_id must differ from its base authoritative branch_id");
    }
  }

  if (input.branch_revision === 1) {
    if (input.previous_revision_ref !== null) {
      fail("genesis branch revision must not have a previous_revision_ref");
    }
    if (input.branch_kind === "candidate" && input.state !== "draft") {
      fail("candidate revision 1 must be draft");
    }
  } else {
    const previous = input.previous_revision_ref;
    if (previous === null) fail("later branch revisions require previous_revision_ref");
    if (previous.branch_id !== input.branch_id
      || previous.branch_revision !== input.branch_revision - 1
      || previous.branch_kind !== input.branch_kind) {
      fail("previous_revision_ref must identify the immediately preceding revision of the same branch and kind");
    }
    if (input.branch_kind === "authoritative") {
      if (previous.state !== "authoritative" || input.state !== "authoritative") {
        fail("authoritative revisions require an authoritative previous revision");
      }
    } else {
      const allowed = CANDIDATE_TRANSITIONS.get(previous.state);
      if (!allowed?.has(input.state)) {
        fail(`candidate transition ${previous.state} -> ${input.state} is closed`);
      }
    }
  }

  if (input.branch_kind === "candidate") {
    if (input.policy_rotation_artifact_ref !== null) {
      fail("candidate revisions must not carry policy_rotation_artifact_ref");
    }
    if ((input.state === "merged") !== (input.effect_certificate_sha256 !== null)) {
      fail("only merged candidate revisions require effect_certificate_sha256");
    }
  }
  if (input.reverts_authority_ref !== null) {
    if (input.branch_kind !== "authoritative" || input.state !== "authoritative") {
      fail("only authoritative revisions may carry reverts_authority_ref");
    }
    if (input.branch_revision === 1) {
      fail("a revert must create a later authoritative revision");
    }
    if (input.reverts_authority_ref.branch_id !== input.branch_id
      || input.reverts_authority_ref.branch_revision >= input.branch_revision) {
      fail("reverts_authority_ref must identify an earlier revision of the same authoritative branch");
    }
  }
  if (input.policy_rotation_artifact_ref !== null
    && (input.branch_kind !== "authoritative" || input.branch_revision === 1)) {
    fail("only later authoritative revisions may carry policy_rotation_artifact_ref");
  }
  if (input.trusted_observation_admission_ref !== null
    && !(input.branch_kind === "candidate"
      && input.branch_revision === 1
      && input.state === "draft")) {
    fail("trusted_observation_admission_ref is valid only on an isolated candidate draft");
  }
  if (input.branch_kind === "authoritative") {
    const causeCount = Number(input.effect_certificate_sha256 !== null)
      + Number(input.reverts_authority_ref !== null)
      + Number(input.policy_rotation_artifact_ref !== null);
    if ((input.branch_revision === 1 && causeCount !== 0)
      || (input.branch_revision > 1 && causeCount !== 1)) {
      fail("authoritative revisions require exactly one closed authority cause after genesis");
    }
  }
}

function parseInput(value: unknown): AuthorityBranchManifestInputV1 {
  const record = exactRecord(value, INPUT_KEYS, "authority branch manifest input");
  const kind = branchKind(record.branch_kind, "branch_kind");
  const state = branchState(record.state, "state");
  const parsed: AuthorityBranchManifestInputV1 = {
    tenant_id: boundedText(record.tenant_id, "tenant_id"),
    authority_subject_sha256: requiredSha256(
      record.authority_subject_sha256,
      "authority_subject_sha256",
    ),
    branch_id: boundedText(record.branch_id, "branch_id"),
    branch_revision: positiveSafeInteger(record.branch_revision, "branch_revision"),
    branch_kind: kind,
    state,
    base_authoritative_ref: nullableAuthoritativeRef(
      record.base_authoritative_ref,
      "base_authoritative_ref",
    ),
    previous_revision_ref: nullableRevisionRef(
      record.previous_revision_ref,
      "previous_revision_ref",
    ),
    capsule_bindings: capsuleBindings(record.capsule_bindings),
    compiler_policy_ref: authorityArtifactRef(record.compiler_policy_ref, "compiler_policy_ref"),
    evidence_policy_ref: authorityArtifactRef(record.evidence_policy_ref, "evidence_policy_ref"),
    effect_certificate_sha256: optionalSha256(
      record.effect_certificate_sha256,
      "effect_certificate_sha256",
    ),
    reverts_authority_ref: nullableAuthoritativeRef(
      record.reverts_authority_ref,
      "reverts_authority_ref",
    ),
    policy_rotation_artifact_ref: nullableAuthorityArtifactRef(
      record.policy_rotation_artifact_ref,
      "policy_rotation_artifact_ref",
    ),
    trusted_observation_admission_ref: nullableTrustedObservationAdmissionRef(
      record.trusted_observation_admission_ref,
    ),
    created_at: canonicalTimestamp(record.created_at, "created_at"),
  };
  assertRevisionConsistency(parsed);
  return parsed;
}

function assembleManifest(input: AuthorityBranchManifestInputV1): AuthorityBranchManifestV1 {
  const body = {
    schema_version: "authority_branch_manifest_v1" as const,
    ...input,
  };
  const manifest = {
    ...body,
    manifest_sha256: canonicalContinuationSha256(body),
  };
  if (Buffer.byteLength(canonicalContinuationJson(manifest), "utf8") > MANIFEST_MAX_BYTES) {
    fail(`authority branch manifest exceeds ${MANIFEST_MAX_BYTES} canonical UTF-8 bytes`);
  }
  return canonicalContinuationClone(manifest);
}

export function buildAuthorityBranchManifestV1(
  value: AuthorityBranchManifestInputV1,
): AuthorityBranchManifestV1 {
  return wrapInvalid(() => assembleManifest(parseInput(value)));
}

export function verifyAuthorityBranchManifestV1(value: unknown): AuthorityBranchManifestV1 {
  return wrapInvalid(() => {
    const record = exactRecord(value, MANIFEST_KEYS, "authority branch manifest");
    if (record.schema_version !== "authority_branch_manifest_v1") {
      fail("authority branch manifest schema_version is invalid");
    }
    const suppliedDigest = requiredSha256(record.manifest_sha256, "manifest_sha256");
    const input = Object.fromEntries(INPUT_KEYS.map((key) => [key, record[key]]));
    const rebuilt = assembleManifest(parseInput(input));
    if (rebuilt.manifest_sha256 !== suppliedDigest
      || canonicalSha256Without(
        value as Readonly<Record<string, unknown>>,
        "manifest_sha256",
      ) !== suppliedDigest) {
      throw new AuthorityBranchManifestError(
        "authority_branch_manifest_digest_mismatch",
        "manifest_sha256 does not authenticate the exact canonical manifest body",
      );
    }
    return rebuilt;
  });
}
