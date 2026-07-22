import {
  buildAuthorityBranchManifestV1,
  type AuthorityBranchCapsuleBindingV1,
  type AuthorityBranchManifestV1,
  type AuthorityBranchRevisionRefV1,
  type AuthoritativeBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import {
  assertSha256,
  assertUnicodeScalarString,
  canonicalContinuationClone,
  canonicalContinuationJson,
  compareCanonicalUtf8,
  type AuthorityBranchRefV1,
  type Sha256,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1Database } from
  "./continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1AuthorityArtifactReader } from
  "./continuation-runtime-v1-authority-artifact-reader.js";
import { assertContinuationRuntimeV1CohortHeadMutationAllowed } from
  "./continuation-runtime-v1-cohort-freeze.js";
import type { ContinuationRuntimeV1PolicyAuthority } from
  "./continuation-runtime-v1-policy-authority.js";
import {
  ContinuationRuntimeV1AuthorityHeadConflictError,
  type AdvanceAuthorityCandidateV1Args,
  type AppendAuthorityDecisionV1Result,
  type AuthorityBranchRevisionRecordV1,
  type AuthorityHeadV1,
  type MergeAuthorityCandidateV1Args,
  type MergeAuthorityCandidateV1Result,
  type RevertAuthorityV1Args,
  type TerminateAuthorityCandidateV1Args,
} from "./continuation-runtime-v1-authority-types.js";
import {
  assertWritableAuthorityBindingsV1,
  buildAuthorityHeadV1,
  insertAuthorityBranchV1,
  updateAuthorityHeadV1,
  type ValidatedAuthorityBindingCauseV1,
} from "./continuation-runtime-v1-authority-write-projection.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  continuationRuntimeV1OperationLineage,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationLineageV1,
} from "./continuation-runtime-v1-operation-store.js";

type AuthoritySnapshot = Readonly<{
  head: AuthorityHeadV1;
  target: AuthorityBranchRevisionRecordV1;
}>;

export type AuthorityWorkflowDependenciesV1 = Readonly<{
  database: ContinuationRuntimeV1Database;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  claimOperatorContext: (context: ContinuationRuntimeV1AuthorityWriteContext) => void;
  readHead: (
    tenantId: string,
    subject: Sha256,
    pending?: ContinuationRuntimeV1OperationLineageV1 | null,
  ) => Promise<AuthoritySnapshot | null>;
  readRevision: (
    tenantId: string,
    subject: Sha256,
    branchId: string,
    revision: number,
    pending?: ContinuationRuntimeV1OperationLineageV1 | null,
  ) => Promise<AuthorityBranchRevisionRecordV1 | null>;
  validateCause: (
    manifest: AuthorityBranchManifestV1,
    current: AuthoritySnapshot,
    pending: ContinuationRuntimeV1OperationLineageV1,
  ) => Promise<ValidatedAuthorityBindingCauseV1>;
}>;

const BASIC_REF_KEYS = Object.freeze([
  "branch_id", "branch_revision", "manifest_sha256",
] as const);

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_authority_workflow_${code}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_shape_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const expected = [...keys].sort(compareCanonicalUtf8);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== expected.length
    || [...ownKeys as string[]].sort(compareCanonicalUtf8)
      .some((key, index) => key !== expected[index])) {
    fail(`${field}_shape_invalid`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `authority workflow ${field}`);
  if (!value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  try {
    assertSha256(value, `authority workflow ${field}`);
  } catch (error) {
    throw new Error(`continuation_runtime_v1_authority_workflow_${field}_invalid`, {
      cause: error,
    });
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field}_invalid`);
  return value as number;
}

function basicRef(value: unknown, field: string): AuthorityBranchRefV1 {
  const record = exactRecord(value, BASIC_REF_KEYS, field);
  return {
    branch_id: text(record.branch_id, `${field}_branch_id`),
    branch_revision: positiveInteger(record.branch_revision, `${field}_revision`),
    manifest_sha256: sha(record.manifest_sha256, `${field}_manifest`),
  };
}

function evidenceSet(
  value: unknown,
  field: "reason_codes" | "evidence_sha256s",
): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > 128
    || Reflect.ownKeys(value).length !== value.length + 1) {
    fail(`${field}_invalid`);
  }
  const parsed = value.map((entry, index) => field === "reason_codes"
    ? text(entry, `${field}_${index}`)
    : sha(entry, `${field}_${index}`));
  if (parsed.some((entry, index) => index > 0
    && compareCanonicalUtf8(parsed[index - 1]!, entry) >= 0)) {
    fail(`${field}_not_canonical_set`);
  }
  return parsed;
}

function fullRef(manifest: AuthorityBranchManifestV1): AuthorityBranchRevisionRefV1 {
  return canonicalContinuationClone({
    branch_id: manifest.branch_id,
    branch_revision: manifest.branch_revision,
    manifest_sha256: manifest.manifest_sha256,
    branch_kind: manifest.branch_kind,
    state: manifest.state,
  });
}

function authoritativeRef(
  manifest: AuthorityBranchManifestV1,
): AuthoritativeBranchRevisionRefV1 {
  if (manifest.branch_kind !== "authoritative" || manifest.state !== "authoritative") {
    fail("authoritative_ref_invalid");
  }
  return fullRef(manifest) as AuthoritativeBranchRevisionRefV1;
}

function promoteBindings(
  bindings: readonly AuthorityBranchCapsuleBindingV1[],
): readonly AuthorityBranchCapsuleBindingV1[] {
  // Branch promotion grants serving authority to the exact behavior measured
  // by the effect certificate. It must not rewrite immutable capsule admission
  // provenance from candidate to authoritative.
  return canonicalContinuationClone(bindings);
}

async function assertLearningCapacity(
  dependencies: AuthorityWorkflowDependenciesV1,
  manifest: AuthorityBranchManifestV1,
): Promise<void> {
  const capability = await dependencies.policyAuthority.resolveExact({
    tenant_id: manifest.tenant_id,
    authority_subject_sha256: manifest.authority_subject_sha256,
    artifact_kind: "compiler_policy",
    artifact_ref: manifest.compiler_policy_ref,
    at: manifest.created_at,
  });
  const limit = dependencies.policyAuthority.payload(capability)
    .learning_candidate_limit;
  if (manifest.capsule_bindings.length > limit) {
    fail("learning_branch_capacity_exceeded");
  }
}

function assertCas(
  current: AuthoritySnapshot | null,
  expectedRevision: number,
  expectedSha256: Sha256,
): asserts current is AuthoritySnapshot {
  if (!current || current.head.head_revision !== expectedRevision
    || current.head.head_sha256 !== expectedSha256) {
    throw new ContinuationRuntimeV1AuthorityHeadConflictError(
      expectedRevision,
      current?.head.head_revision ?? null,
      expectedSha256,
      current?.head.head_sha256 ?? null,
    );
  }
}

function candidateIsLatest(
  database: ContinuationRuntimeV1Database,
  tenantId: string,
  subject: Sha256,
  candidate: AuthorityBranchManifestV1,
): boolean {
  const row = database.db.prepare(`SELECT MAX(branch_revision) AS latest_revision
    FROM branch_revisions
    WHERE tenant_id=? AND authority_subject_sha256=? AND branch_id=?
      AND branch_kind='candidate'`).get(
        tenantId,
        subject,
        candidate.branch_id,
      ) as Readonly<{ latest_revision: unknown }>;
  return row.latest_revision === candidate.branch_revision;
}

type CandidateWorkflowInput = Readonly<{
  authoritySubject: Sha256;
  candidateRef: AuthorityBranchRefV1;
  expectedHeadRevision: number;
  expectedHeadSha256: Sha256;
}>;

async function loadCandidateContext(
  dependencies: AuthorityWorkflowDependenciesV1,
  tenantId: string,
  input: CandidateWorkflowInput,
): Promise<Readonly<{
  current: AuthoritySnapshot;
  candidate: AuthorityBranchRevisionRecordV1;
}>> {
  const current = await dependencies.readHead(tenantId, input.authoritySubject);
  assertCas(current, input.expectedHeadRevision, input.expectedHeadSha256);
  const candidate = await dependencies.readRevision(
    tenantId,
    input.authoritySubject,
    input.candidateRef.branch_id,
    input.candidateRef.branch_revision,
  );
  if (!candidate
    || candidate.manifest.branch_kind !== "candidate"
    || canonicalContinuationJson(input.candidateRef)
      !== canonicalContinuationJson({
        branch_id: candidate.manifest.branch_id,
        branch_revision: candidate.manifest.branch_revision,
        manifest_sha256: candidate.manifest.manifest_sha256,
      })
    || !candidateIsLatest(
      dependencies.database,
      tenantId,
      input.authoritySubject,
      candidate.manifest,
    )
    || canonicalContinuationJson(candidate.manifest.base_authoritative_ref)
      !== canonicalContinuationJson(current.head.target)) {
    fail("candidate_not_current_or_exact");
  }
  return { current, candidate };
}

function transitionManifest(args: Readonly<{
  tenantId: string;
  candidate: AuthorityBranchRevisionRecordV1;
  targetState: "shadow" | "eligible" | "active_candidate"
    | "rejected" | "quarantined" | "expired" | "merged";
  effectCertificateSha256: Sha256 | null;
  createdAt: string;
}>): AuthorityBranchManifestV1 {
  const previous = args.candidate.manifest;
  return buildAuthorityBranchManifestV1({
    tenant_id: args.tenantId,
    authority_subject_sha256: previous.authority_subject_sha256,
    branch_id: previous.branch_id,
    branch_revision: previous.branch_revision + 1,
    branch_kind: "candidate",
    state: args.targetState,
    base_authoritative_ref: previous.base_authoritative_ref,
    previous_revision_ref: fullRef(previous),
    capsule_bindings: previous.capsule_bindings,
    compiler_policy_ref: previous.compiler_policy_ref,
    evidence_policy_ref: previous.evidence_policy_ref,
    effect_certificate_sha256: args.effectCertificateSha256,
    reverts_authority_ref: null,
    policy_rotation_artifact_ref: null,
    trusted_observation_admission_ref: null,
    created_at: args.createdAt,
  });
}

async function persistCandidateTransition(
  dependencies: AuthorityWorkflowDependenciesV1,
  lineage: ContinuationRuntimeV1OperationLineageV1,
  current: AuthoritySnapshot,
  manifest: AuthorityBranchManifestV1,
): Promise<AppendAuthorityDecisionV1Result> {
  if (manifest.state === "eligible" || manifest.state === "active_candidate"
    || manifest.state === "merged") {
    await assertLearningCapacity(dependencies, manifest);
  }
  const cause = await dependencies.validateCause(manifest, current, lineage);
  assertWritableAuthorityBindingsV1(
    dependencies.database,
    manifest,
    lineage.scope,
    null,
    manifest.created_at,
    cause,
  );
  insertAuthorityBranchV1(dependencies.database, lineage, manifest);
  const persisted = await dependencies.readRevision(
    lineage.tenant_id,
    manifest.authority_subject_sha256,
    manifest.branch_id,
    manifest.branch_revision,
    lineage,
  );
  if (!persisted || persisted.manifest.manifest_sha256 !== manifest.manifest_sha256) {
    fail("candidate_transition_postwrite_mismatch");
  }
  return canonicalContinuationClone({
    revision: persisted,
    head: current.head,
    head_advanced: false,
  });
}

function operatorLineage(
  dependencies: AuthorityWorkflowDependenciesV1,
  context: ContinuationRuntimeV1AuthorityWriteContext,
): ContinuationRuntimeV1OperationLineageV1 {
  const binding = assertContinuationRuntimeV1AuthorityWriteContext(
    context,
    dependencies.database,
  );
  if (binding.operationKind !== "authority_decision" || binding.actorKind !== "operator") {
    fail("operation_forbidden");
  }
  dependencies.claimOperatorContext(context);
  return continuationRuntimeV1OperationLineage(binding);
}

function parseAdvance(value: unknown): AdvanceAuthorityCandidateV1Args {
  const record = exactRecord(value, [
    "authority_subject_sha256", "candidate_ref", "evidence_sha256s",
    "expected_head_revision", "expected_head_sha256", "reason_codes",
    "target_state",
  ], "advance_args");
  if (record.target_state !== "shadow" && record.target_state !== "eligible"
    && record.target_state !== "active_candidate") fail("advance_target_invalid");
  return {
    authority_subject_sha256: sha(record.authority_subject_sha256, "authority_subject"),
    candidate_ref: basicRef(record.candidate_ref, "candidate_ref"),
    target_state: record.target_state,
    reason_codes: evidenceSet(record.reason_codes, "reason_codes"),
    evidence_sha256s: evidenceSet(record.evidence_sha256s, "evidence_sha256s") as Sha256[],
    expected_head_revision: positiveInteger(record.expected_head_revision, "head_revision"),
    expected_head_sha256: sha(record.expected_head_sha256, "head_sha256"),
  };
}

function parseTerminate(value: unknown): TerminateAuthorityCandidateV1Args {
  const record = exactRecord(value, [
    "authority_subject_sha256", "candidate_ref", "evidence_sha256s",
    "expected_head_revision", "expected_head_sha256", "reason_codes",
    "target_state",
  ], "terminate_args");
  if (record.target_state !== "rejected" && record.target_state !== "quarantined"
    && record.target_state !== "expired") fail("terminate_target_invalid");
  return {
    authority_subject_sha256: sha(record.authority_subject_sha256, "authority_subject"),
    candidate_ref: basicRef(record.candidate_ref, "candidate_ref"),
    target_state: record.target_state,
    reason_codes: evidenceSet(record.reason_codes, "reason_codes"),
    evidence_sha256s: evidenceSet(record.evidence_sha256s, "evidence_sha256s") as Sha256[],
    expected_head_revision: positiveInteger(record.expected_head_revision, "head_revision"),
    expected_head_sha256: sha(record.expected_head_sha256, "head_sha256"),
  };
}

export function createContinuationRuntimeV1AuthorityWorkflows(
  dependencies: AuthorityWorkflowDependenciesV1,
) {
  return Object.freeze({
    async advanceCandidate(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: AdvanceAuthorityCandidateV1Args,
    ): Promise<AppendAuthorityDecisionV1Result> {
      const args = parseAdvance(value);
      const lineage = operatorLineage(dependencies, context);
      const loaded = await loadCandidateContext(dependencies, lineage.tenant_id, {
        authoritySubject: args.authority_subject_sha256,
        candidateRef: args.candidate_ref,
        expectedHeadRevision: args.expected_head_revision,
        expectedHeadSha256: args.expected_head_sha256,
      });
      const at = dependencies.database.mintAuthorityTime(
        loaded.candidate.manifest.created_at,
      );
      return persistCandidateTransition(
        dependencies,
        lineage,
        loaded.current,
        transitionManifest({
          tenantId: lineage.tenant_id,
          candidate: loaded.candidate,
          targetState: args.target_state,
          effectCertificateSha256: null,
          createdAt: at,
        }),
      );
    },

    async terminateCandidate(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: TerminateAuthorityCandidateV1Args,
    ): Promise<AppendAuthorityDecisionV1Result> {
      const args = parseTerminate(value);
      const lineage = operatorLineage(dependencies, context);
      const loaded = await loadCandidateContext(dependencies, lineage.tenant_id, {
        authoritySubject: args.authority_subject_sha256,
        candidateRef: args.candidate_ref,
        expectedHeadRevision: args.expected_head_revision,
        expectedHeadSha256: args.expected_head_sha256,
      });
      const at = dependencies.database.mintAuthorityTime(
        loaded.candidate.manifest.created_at,
      );
      return persistCandidateTransition(
        dependencies,
        lineage,
        loaded.current,
        transitionManifest({
          tenantId: lineage.tenant_id,
          candidate: loaded.candidate,
          targetState: args.target_state,
          effectCertificateSha256: null,
          createdAt: at,
        }),
      );
    },

    async mergeCandidate(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: MergeAuthorityCandidateV1Args,
    ): Promise<MergeAuthorityCandidateV1Result> {
      const record = exactRecord(value, [
        "authority_subject_sha256", "candidate_ref", "effect_certificate_sha256",
        "expected_head_revision", "expected_head_sha256",
      ], "merge_args");
      const args = {
        authoritySubject: sha(record.authority_subject_sha256, "authority_subject"),
        candidateRef: basicRef(record.candidate_ref, "candidate_ref"),
        effectCertificateSha256: sha(record.effect_certificate_sha256, "effect_certificate"),
        expectedHeadRevision: positiveInteger(record.expected_head_revision, "head_revision"),
        expectedHeadSha256: sha(record.expected_head_sha256, "head_sha256"),
      };
      const lineage = operatorLineage(dependencies, context);
      const loaded = await loadCandidateContext(dependencies, lineage.tenant_id, args);
      if (loaded.candidate.manifest.state !== "active_candidate") {
        fail("merge_candidate_not_active");
      }
      const candidateAt = dependencies.database.mintAuthorityTime(
        loaded.candidate.manifest.created_at,
      );
      await assertContinuationRuntimeV1CohortHeadMutationAllowed(
        dependencies.database,
        dependencies.artifactStore,
        {
          tenant_id: lineage.tenant_id,
          authority_subject_sha256: args.authoritySubject,
          control_ref: loaded.current.head.target,
          at: candidateAt,
        },
      );
      const candidateManifest = transitionManifest({
        tenantId: lineage.tenant_id,
        candidate: loaded.candidate,
        targetState: "merged",
        effectCertificateSha256: args.effectCertificateSha256,
        createdAt: candidateAt,
      });
      const candidateResult = await persistCandidateTransition(
        dependencies,
        lineage,
        loaded.current,
        candidateManifest,
      );
      const authorityAt = dependencies.database.mintAuthorityTime(
        loaded.current.target.manifest.created_at > candidateAt
          ? loaded.current.target.manifest.created_at
          : candidateAt,
      );
      const authorityManifest = buildAuthorityBranchManifestV1({
        tenant_id: lineage.tenant_id,
        authority_subject_sha256: args.authoritySubject,
        branch_id: loaded.current.head.target.branch_id,
        branch_revision: loaded.current.head.target.branch_revision + 1,
        branch_kind: "authoritative",
        state: "authoritative",
        base_authoritative_ref: null,
        previous_revision_ref: loaded.current.head.target,
        capsule_bindings: promoteBindings(candidateManifest.capsule_bindings),
        compiler_policy_ref: candidateManifest.compiler_policy_ref,
        evidence_policy_ref: candidateManifest.evidence_policy_ref,
        effect_certificate_sha256: args.effectCertificateSha256,
        reverts_authority_ref: null,
        policy_rotation_artifact_ref: null,
        trusted_observation_admission_ref: null,
        created_at: authorityAt,
      });
      await assertLearningCapacity(dependencies, authorityManifest);
      const cause = await dependencies.validateCause(
        authorityManifest,
        loaded.current,
        lineage,
      );
      assertWritableAuthorityBindingsV1(
        dependencies.database,
        authorityManifest,
        lineage.scope,
        null,
        authorityAt,
        cause,
      );
      insertAuthorityBranchV1(dependencies.database, lineage, authorityManifest);
      const nextHead = buildAuthorityHeadV1(
        lineage.tenant_id,
        args.authoritySubject,
        loaded.current.head.head_revision + 1,
        authorityManifest,
        lineage,
        authorityAt,
      );
      if (!updateAuthorityHeadV1(
        dependencies.database,
        nextHead,
        args.expectedHeadRevision,
        args.expectedHeadSha256,
      )) {
        throw new ContinuationRuntimeV1AuthorityHeadConflictError(
          args.expectedHeadRevision,
          null,
          args.expectedHeadSha256,
          null,
        );
      }
      const persistedAuthority = await dependencies.readRevision(
        lineage.tenant_id,
        args.authoritySubject,
        authorityManifest.branch_id,
        authorityManifest.branch_revision,
        lineage,
      );
      const persistedHead = await dependencies.readHead(
        lineage.tenant_id,
        args.authoritySubject,
        lineage,
      );
      if (!persistedAuthority || !persistedHead
        || persistedAuthority.manifest.manifest_sha256
          !== authorityManifest.manifest_sha256
        || persistedHead.head.head_sha256 !== nextHead.head_sha256) {
        fail("merge_postwrite_mismatch");
      }
      return canonicalContinuationClone({
        candidate_revision: candidateResult.revision,
        authoritative_revision: persistedAuthority,
        head: persistedHead.head,
      });
    },

    async revertAuthority(
      context: ContinuationRuntimeV1AuthorityWriteContext,
      value: RevertAuthorityV1Args,
    ): Promise<AppendAuthorityDecisionV1Result> {
      const record = exactRecord(value, [
        "authority_subject_sha256", "evidence_sha256s", "expected_head_revision",
        "expected_head_sha256", "reason_codes", "revert_to_authority_ref",
      ], "revert_args");
      evidenceSet(record.reason_codes, "reason_codes");
      evidenceSet(record.evidence_sha256s, "evidence_sha256s");
      const subject = sha(record.authority_subject_sha256, "authority_subject");
      const expectedRevision = positiveInteger(record.expected_head_revision, "head_revision");
      const expectedSha256 = sha(record.expected_head_sha256, "head_sha256");
      const targetRef = basicRef(record.revert_to_authority_ref, "revert_ref");
      const lineage = operatorLineage(dependencies, context);
      const current = await dependencies.readHead(lineage.tenant_id, subject);
      assertCas(current, expectedRevision, expectedSha256);
      const target = await dependencies.readRevision(
        lineage.tenant_id,
        subject,
        targetRef.branch_id,
        targetRef.branch_revision,
      );
      if (!target || target.manifest.branch_kind !== "authoritative"
        || target.manifest.state !== "authoritative"
        || canonicalContinuationJson(targetRef) !== canonicalContinuationJson({
          branch_id: target.manifest.branch_id,
          branch_revision: target.manifest.branch_revision,
          manifest_sha256: target.manifest.manifest_sha256,
        })) fail("revert_target_invalid");
      const at = dependencies.database.mintAuthorityTime(current.head.updated_at);
      await assertContinuationRuntimeV1CohortHeadMutationAllowed(
        dependencies.database,
        dependencies.artifactStore,
        {
          tenant_id: lineage.tenant_id,
          authority_subject_sha256: subject,
          control_ref: current.head.target,
          at,
        },
      );
      const manifest = buildAuthorityBranchManifestV1({
        tenant_id: lineage.tenant_id,
        authority_subject_sha256: subject,
        branch_id: current.head.target.branch_id,
        branch_revision: current.head.target.branch_revision + 1,
        branch_kind: "authoritative",
        state: "authoritative",
        base_authoritative_ref: null,
        previous_revision_ref: current.head.target,
        capsule_bindings: target.manifest.capsule_bindings,
        compiler_policy_ref: current.target.manifest.compiler_policy_ref,
        evidence_policy_ref: current.target.manifest.evidence_policy_ref,
        effect_certificate_sha256: null,
        reverts_authority_ref: authoritativeRef(target.manifest),
        policy_rotation_artifact_ref: null,
        trusted_observation_admission_ref: null,
        created_at: at,
      });
      await assertLearningCapacity(dependencies, manifest);
      const cause = await dependencies.validateCause(manifest, current, lineage);
      assertWritableAuthorityBindingsV1(
        dependencies.database,
        manifest,
        lineage.scope,
        null,
        at,
        cause,
      );
      insertAuthorityBranchV1(dependencies.database, lineage, manifest);
      const head = buildAuthorityHeadV1(
        lineage.tenant_id,
        subject,
        current.head.head_revision + 1,
        manifest,
        lineage,
        at,
      );
      if (!updateAuthorityHeadV1(
        dependencies.database,
        head,
        expectedRevision,
        expectedSha256,
      )) {
        throw new ContinuationRuntimeV1AuthorityHeadConflictError(
          expectedRevision,
          null,
          expectedSha256,
          null,
        );
      }
      const persisted = await dependencies.readRevision(
        lineage.tenant_id,
        subject,
        manifest.branch_id,
        manifest.branch_revision,
        lineage,
      );
      const persistedHead = await dependencies.readHead(
        lineage.tenant_id,
        subject,
        lineage,
      );
      if (!persisted || !persistedHead
        || persisted.manifest.manifest_sha256 !== manifest.manifest_sha256
        || persistedHead.head.head_sha256 !== head.head_sha256) {
        fail("revert_postwrite_mismatch");
      }
      return canonicalContinuationClone({
        revision: persisted,
        head: persistedHead.head,
        head_advanced: true,
      });
    },
  });
}
