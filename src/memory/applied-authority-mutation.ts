import stableStringify from "fast-json-stable-stringify";

import type { LiteWriteStore } from "../store/lite-write-store.js";
import type { WriteScopeHead } from "../store/write-access.js";
import {
  buildCanonicalAppliedAuthorityMutationV2,
  canonicalAuthorityMutationVerificationProjection,
  canonicalizeAuthorityMutationVerificationV2,
  canonicalV2CommitHash,
  type CanonicalAppliedAuthorityMutationV2,
  type CanonicalAuthorityMutationVerificationV2,
  type CanonicalAuthorityTableMutationV2,
} from "../store/write-commit-authority.js";
import { sha256Hex } from "../util/crypto.js";
import { HttpError } from "../util/http.js";

export type AppliedAuthorityMutationPlanContext = Readonly<{
  head: WriteScopeHead | null;
  appliedAt: string;
}>;

export type AppliedAuthorityMutationApplyContext = Readonly<{
  head: WriteScopeHead | null;
  appliedAt: string;
  commitId: string;
  commitHash: string;
  revision: number;
  mutation: CanonicalAppliedAuthorityMutationV2;
}>;

export type AppliedAuthorityMutationVerifyContext<T> = AppliedAuthorityMutationApplyContext & Readonly<{
  value: T;
}>;

export type AppliedAuthorityMutationNoOpPlan<T> = Readonly<{
  status: "no_op";
  value: T;
}>;

export type AppliedAuthorityMutationWritePlan<T> = Readonly<{
  status: "mutate";
  authorityKind: string;
  mutations: readonly CanonicalAuthorityTableMutationV2[];
  apply(context: AppliedAuthorityMutationApplyContext): Promise<T>;
  verify(
    context: AppliedAuthorityMutationVerifyContext<T>,
  ): Promise<readonly CanonicalAuthorityMutationVerificationV2[]>;
}>;

export type AppliedAuthorityMutationPlan<T> =
  | AppliedAuthorityMutationNoOpPlan<T>
  | AppliedAuthorityMutationWritePlan<T>;

export type AppliedAuthorityMutationCoordinatorStore = Pick<
  LiteWriteStore,
  | "withTx"
  | "readScopeHead"
  | "insertCommit"
  | "compareAndSwapScopeHead"
  | "authorityTransactionChangeCount"
>;

export type RunAppliedAuthorityMutationV2Args<T> = Readonly<{
  store: AppliedAuthorityMutationCoordinatorStore;
  scope: string;
  inputSha256: string;
  actor: string;
  modelVersion?: string | null;
  promptVersion?: string | null;
  appliedAt?: string;
  expectedHeadRevision?: number;
  expectedHeadCommitId?: string | null;
  plan(
    context: AppliedAuthorityMutationPlanContext,
  ): Promise<AppliedAuthorityMutationPlan<T>>;
}>;

export type AppliedAuthorityMutationResult<T> = Readonly<{
  status: "applied" | "no_op";
  commitId: string;
  commitHash: string;
  revision: number;
  value: T;
}>;

function scopeHeadConflict(
  message: string,
  args: {
    scope: string;
    expectedRevision?: number;
    expectedCommitId?: string | null;
    current: WriteScopeHead | null;
  },
): never {
  throw new HttpError(409, "scope_head_conflict", message, {
    scope: args.scope,
    expected_revision: args.expectedRevision,
    expected_commit_id: args.expectedCommitId,
    current_revision: args.current?.revision ?? 0,
    current_commit_id: args.current?.commitId ?? null,
  });
}

function assertCoordinatorInput<T>(args: RunAppliedAuthorityMutationV2Args<T>): void {
  if (!args.scope.trim()) throw new Error("applied_authority_scope_required");
  if (!args.inputSha256.trim()) throw new Error("applied_authority_input_sha256_required");
  if (!args.actor.trim()) throw new Error("applied_authority_actor_required");
  if (args.expectedHeadRevision !== undefined
    && (!Number.isSafeInteger(args.expectedHeadRevision) || args.expectedHeadRevision < 0)) {
    throw new Error("applied_authority_expected_head_revision_invalid");
  }
  if (args.appliedAt !== undefined) {
    const appliedAtMillis = new Date(args.appliedAt).getTime();
    if (!Number.isFinite(appliedAtMillis)
      || new Date(appliedAtMillis).toISOString() !== args.appliedAt) {
      throw new Error("applied_authority_applied_at_invalid");
    }
  }
}

/**
 * The only v2 table-authority mutation entry point. Planning and verification
 * are read-only; commit insertion, domain apply, exact read-after verification,
 * and head CAS share one transaction and cannot be selectively omitted.
 */
export async function runAppliedAuthorityMutationV2<T>(
  args: RunAppliedAuthorityMutationV2Args<T>,
): Promise<AppliedAuthorityMutationResult<T>> {
  assertCoordinatorInput(args);
  return await args.store.withTx(async () => {
    const head = await args.store.readScopeHead(args.scope);
    const currentRevision = head?.revision ?? 0;
    const currentCommitId = head?.commitId ?? null;
    const expectedCommitWasProvided = Object.prototype.hasOwnProperty.call(args, "expectedHeadCommitId");
    if ((args.expectedHeadRevision !== undefined && args.expectedHeadRevision !== currentRevision)
      || (expectedCommitWasProvided && (args.expectedHeadCommitId ?? null) !== currentCommitId)) {
      scopeHeadConflict("applied authority mutation was prepared from a stale scope head", {
        scope: args.scope,
        expectedRevision: args.expectedHeadRevision,
        expectedCommitId: args.expectedHeadCommitId,
        current: head,
      });
    }

    const appliedAt = args.appliedAt ?? new Date().toISOString();
    const changesBeforePlan = args.store.authorityTransactionChangeCount();
    const plan = await args.plan({ head, appliedAt });
    if (args.store.authorityTransactionChangeCount() !== changesBeforePlan) {
      throw new Error("applied_authority_plan_must_be_read_only");
    }

    if (plan.status === "no_op") {
      if (!head) throw new Error("applied_authority_no_op_without_head");
      return {
        status: "no_op",
        commitId: head.commitId,
        commitHash: head.commitHash,
        revision: head.revision,
        value: plan.value,
      };
    }

    const mutation = buildCanonicalAppliedAuthorityMutationV2({
      appliedAt,
      authorityKind: plan.authorityKind,
      mutations: plan.mutations,
    });
    const diffJson = stableStringify(mutation);
    const mutationDigest = sha256Hex(diffJson);
    const revision = currentRevision + 1;
    const commitHash = canonicalV2CommitHash({
      digestVersion: 2,
      revision,
      parentHash: head?.commitHash ?? "",
      inputSha256: args.inputSha256,
      mutationDigest,
      scope: args.scope,
      actor: args.actor,
      modelVersion: args.modelVersion ?? null,
      promptVersion: args.promptVersion ?? null,
    });
    const legacyAnchorCommitId = head?.digestVersion === 1
      ? head.commitId
      : head?.legacyAnchorCommitId ?? null;
    const commitId = await args.store.insertCommit({
      scope: args.scope,
      parentCommitId: currentCommitId,
      inputSha256: args.inputSha256,
      diffJson,
      actor: args.actor,
      modelVersion: args.modelVersion ?? null,
      promptVersion: args.promptVersion ?? null,
      commitHash,
      digestVersion: 2,
      revision,
      mutationDigest,
      legacyAnchorCommitId,
      createdAt: appliedAt,
    });

    const applyContext: AppliedAuthorityMutationApplyContext = {
      head,
      appliedAt,
      commitId,
      commitHash,
      revision,
      mutation,
    };
    const value = await plan.apply(applyContext);
    const changesBeforeVerify = args.store.authorityTransactionChangeCount();
    const verified = canonicalizeAuthorityMutationVerificationV2(
      await plan.verify({ ...applyContext, value }),
    );
    if (args.store.authorityTransactionChangeCount() !== changesBeforeVerify) {
      throw new Error("applied_authority_verify_must_be_read_only");
    }
    const expected = canonicalAuthorityMutationVerificationProjection(mutation.mutations);
    if (stableStringify(verified) !== stableStringify(expected)) {
      throw new Error("applied_authority_read_after_verification_mismatch");
    }

    const cas = await args.store.compareAndSwapScopeHead({
      scope: args.scope,
      commitId,
      expectedRevision: currentRevision,
      expectedCommitId: currentCommitId,
    });
    if (cas.status === "conflict") {
      scopeHeadConflict("authoritative scope head changed before mutation commit", {
        scope: args.scope,
        expectedRevision: currentRevision,
        expectedCommitId: currentCommitId,
        current: cas.current,
      });
    }
    return {
      status: "applied",
      commitId,
      commitHash,
      revision,
      value,
    };
  });
}
