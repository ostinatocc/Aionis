import {
  canonicalContinuationClone,
  canonicalContinuationJson,
  compareCanonicalUtf8,
  assertCanonicalUtcMillis,
  assertSha256,
  assertUnicodeScalarString,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
  type Sha256,
} from "../continuation/contract.js";
import {
  compileContinuationV1,
} from "../continuation/compiler.js";
import {
  ContinuationCompilerSelectedCapsuleCapacityErrorV1,
  evaluateContinuationSelectionV1,
} from "../continuation/selection-evaluation.js";
import {
  CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1,
  CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1,
  retrieveContinuationCandidatesV1,
  type ContinuationCandidateRetrievalReceiptV1,
} from "../continuation/candidate-retrieval.js";
import {
  renderContinuationProjectionV1,
  type RenderedContinuationProjectionV1,
} from "../continuation/renderer.js";
import type {
  AuthorityBranchManifestV1,
  AuthorityBranchRevisionRefV1,
} from "../continuation/authority-branch.js";
import {
  assertContinuationRuntimeV1ExperimentCohortAuthority,
  type ExperimentCohortAuthorityV1,
} from "../store/continuation-runtime-v1-experiment-cohort-authority.js";
import {
  assertContinuationRuntimeV1AuthorityArtifactReader,
  type ContinuationRuntimeV1AuthorityArtifactReader,
} from "../store/continuation-runtime-v1-authority-artifact-reader.js";
import {
  assertContinuationRuntimeV1AuthorityStore,
} from "../store/continuation-runtime-v1-authority-store.js";
import type { ContinuationRuntimeV1AuthorityStore } from
  "../store/continuation-runtime-v1-authority-types.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import {
  assertContinuationRuntimeV1EffectCertificateReader,
  type ContinuationRuntimeV1EffectCertificateReader,
} from "../store/continuation-runtime-v1-effect-certificate-reader.js";
import {
  ContinuationRuntimeV1CurrentServingProjectionCapacityError,
} from "../store/continuation-runtime-v1-memory-contract.js";
import {
  assertContinuationRuntimeV1MemoryStore,
  createContinuationRuntimeV1MemoryStore,
} from "../store/continuation-runtime-v1-memory-store.js";
import {
  assertContinuationRuntimeV1ObservationStore,
  type ContinuationRuntimeV1ObservationStore,
} from "../store/continuation-runtime-v1-observation-store.js";
import {
  assertContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1AuthorityWriteBinding,
  type ContinuationRuntimeV1AuthorityWriteContext,
} from "../store/continuation-runtime-v1-operation-store.js";
import {
  assertContinuationRuntimeV1PolicyAuthority,
  type ContinuationRuntimeV1PolicyAuthority,
} from "../store/continuation-runtime-v1-policy-authority.js";
import {
  continuationRuntimeV1BranchRefFromManifest,
  materializeContinuationCandidatesV1,
} from "./continuation-candidate-materializer.js";

declare const VERIFIED_COMPILED_CONTINUATION_CAPABILITY: unique symbol;

export type VerifiedCompiledContinuationCapabilityV1 = Readonly<{
  readonly [VERIFIED_COMPILED_CONTINUATION_CAPABILITY]:
    "verified_compiled_continuation_capability_v1";
}>;

export type AssembleContinuationDecisionV1Args = Readonly<{
  world_snapshot_ref: Readonly<{
    world_snapshot_id: string;
    world_snapshot_sha256: Sha256;
  }>;
  obligations: readonly ContinuationObligationV1[];
  render_budget: number;
}>;

export type ContinuationRuntimeV1DecisionAssemblyService = Readonly<{
  assemble(
    context: ContinuationRuntimeV1AuthorityWriteContext,
    args: AssembleContinuationDecisionV1Args,
  ): Promise<VerifiedCompiledContinuationCapabilityV1>;
}>;

export class ContinuationRuntimeV1CandidatePolicyCapacityError extends Error {
  readonly receipt: ContinuationCandidateRetrievalReceiptV1;

  constructor(receipt: ContinuationCandidateRetrievalReceiptV1) {
    super("continuation_runtime_v1_candidate_policy_capacity_exceeded");
    this.name = "ContinuationRuntimeV1CandidatePolicyCapacityError";
    this.receipt = receipt;
  }
}

export class ContinuationRuntimeV1CandidateSourceCapacityError extends Error {
  readonly continuityCandidateCount: number;
  readonly learningCandidateCount: number;
  readonly sourceCandidateCount: number;
  readonly sourceCandidateLimit = CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1;
  readonly sourceCandidateBytes: number;
  readonly sourceCandidateBytesLimit =
    CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1;

  constructor(
    continuityCandidateCount: number,
    learningCandidateCount: number,
    sourceCandidateBytes = 0,
  ) {
    super("continuation_runtime_v1_candidate_source_capacity_exceeded");
    this.name = "ContinuationRuntimeV1CandidateSourceCapacityError";
    this.continuityCandidateCount = continuityCandidateCount;
    this.learningCandidateCount = learningCandidateCount;
    this.sourceCandidateCount = continuityCandidateCount + learningCandidateCount;
    this.sourceCandidateBytes = sourceCandidateBytes;
  }
}

export function assertContinuationRuntimeV1CandidateSourceCapacity(
  continuityCandidateCount: number,
  learningCandidateCount: number,
  sourceCandidateBytes = 0,
): void {
  if (!Number.isSafeInteger(continuityCandidateCount)
    || continuityCandidateCount < 0
    || !Number.isSafeInteger(learningCandidateCount)
    || learningCandidateCount < 0
    || !Number.isSafeInteger(sourceCandidateBytes)
    || sourceCandidateBytes < 0) {
    fail("candidate_source_count_invalid");
  }
  if (continuityCandidateCount + learningCandidateCount
      > CONTINUATION_CANDIDATE_SOURCE_LIMIT_V1
    || sourceCandidateBytes > CONTINUATION_CANDIDATE_SOURCE_BYTES_LIMIT_V1) {
    throw new ContinuationRuntimeV1CandidateSourceCapacityError(
      continuityCandidateCount,
      learningCandidateCount,
      sourceCandidateBytes,
    );
  }
}

export type ConsumedCompiledContinuationV1 = Readonly<{
  continuation_contract: ContinuationContractV1;
  render_result: RenderedContinuationProjectionV1;
}>;

type MemoryStore = ReturnType<typeof createContinuationRuntimeV1MemoryStore>;

type AssemblyDependencies = Readonly<{
  database: ContinuationRuntimeV1Database;
  observationStore: ContinuationRuntimeV1ObservationStore;
  memoryStore: MemoryStore;
  artifactStore: ContinuationRuntimeV1AuthorityArtifactReader;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  effectCertificateReader: ContinuationRuntimeV1EffectCertificateReader;
  authorityStore: ContinuationRuntimeV1AuthorityStore;
  experimentCohortAuthority: ExperimentCohortAuthorityV1;
}>;

type CapabilityRecord = Readonly<{
  owner: ContinuationRuntimeV1DecisionAssemblyService;
  database: ContinuationRuntimeV1Database;
  context: ContinuationRuntimeV1AuthorityWriteContext;
  binding: ContinuationRuntimeV1AuthorityWriteBinding;
  contract: ContinuationContractV1;
  renderResult: RenderedContinuationProjectionV1;
}> & { consumed: boolean };

const ARG_KEYS = Object.freeze([
  "obligations",
  "render_budget",
  "world_snapshot_ref",
] as const);
const SNAPSHOT_REF_KEYS = Object.freeze([
  "world_snapshot_id", "world_snapshot_sha256",
] as const);
const ASSEMBLY_CONTEXTS = new WeakSet<object>();
const CAPABILITIES = new WeakMap<object, CapabilityRecord>();
const SERVICES = new WeakMap<object, AssemblyDependencies>();

function fail(code: string): never {
  throw new Error(`continuation_runtime_v1_decision_assembly_${code}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field}_shape_invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(expectedKeys);
  if ((prototype !== Object.prototype && prototype !== null)
    || ownKeys.some((key) => typeof key !== "string")
    || ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => !expected.has(key as string))) {
    fail(`${field}_shape_invalid`);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function exactArray(
  value: unknown,
  maximum: number,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum) fail(`${field}_shape_invalid`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1
    || ownKeys.some((key) => typeof key !== "string")) {
    fail(`${field}_shape_invalid`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail(`${field}_shape_invalid`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertUnicodeScalarString(value, `decision assembly ${field}`);
  if (!value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 256) fail(`${field}_invalid`);
  return value;
}

function sha(value: unknown, field: string): Sha256 {
  if (typeof value !== "string") fail(`${field}_invalid`);
  assertSha256(value, `decision assembly ${field}`);
  return value;
}

function parseArgs(value: unknown): AssembleContinuationDecisionV1Args {
  const record = exactRecord(value, ARG_KEYS, "args");
  const snapshot = exactRecord(
    record.world_snapshot_ref,
    SNAPSHOT_REF_KEYS,
    "world_snapshot_ref",
  );
  if (!Number.isSafeInteger(record.render_budget)
    || (record.render_budget as number) < 1_024
    || (record.render_budget as number) > 65_536) fail("render_budget_invalid");
  const obligations = exactArray(record.obligations, 64, "obligations");
  return canonicalContinuationClone({
    world_snapshot_ref: {
      world_snapshot_id: text(snapshot.world_snapshot_id, "world_snapshot_id"),
      world_snapshot_sha256: sha(
        snapshot.world_snapshot_sha256,
        "world_snapshot_sha256",
      ),
    },
    obligations: obligations as readonly ContinuationObligationV1[],
    render_budget: record.render_budget as number,
  });
}

function branchRef(
  value: AuthorityBranchRevisionRefV1,
): ContinuationContractV1["authority"]["served_learning_branch"] {
  return canonicalContinuationClone({
    branch_id: value.branch_id,
    branch_revision: value.branch_revision,
    manifest_sha256: value.manifest_sha256,
  });
}

function fullManifestRef(
  manifest: AuthorityBranchManifestV1,
): AuthorityBranchRevisionRefV1 {
  return continuationRuntimeV1BranchRefFromManifest(manifest);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalContinuationJson(left) === canonicalContinuationJson(right);
}

function identity(
  operationId: string,
  snapshot: Awaited<ReturnType<ContinuationRuntimeV1ObservationStore["read"]>> & {},
): ContinuationContractV1["identity"] {
  const value = snapshot.snapshot;
  const envelope = value.host_task_envelope;
  return canonicalContinuationClone({
    decision_id: operationId,
    tenant_id: value.tenant_id,
    scope: value.scope,
    episode_id: envelope.episode_id,
    run_id: envelope.run_id,
    host_task_id: envelope.host_task_id,
    host_task_envelope_sha256: envelope.host_task_envelope_sha256,
    collection_principal_sha256: value.collection_principal_sha256,
    consumer_agent_id: envelope.consumer_agent_id,
    consumer_team_id: envelope.consumer_team_id,
    task_family: envelope.task_family,
    task_signature: envelope.task_signature,
    workflow_signature: envelope.workflow_signature,
    workspace_signature: envelope.workspace_signature,
    source_task_sha256: envelope.source_task_sha256,
    source_event_sha256: envelope.source_event_sha256,
    world_snapshot_id: value.world_snapshot_id,
    world_snapshot_sha256: value.world_snapshot_sha256,
  });
}

function assertDependencies(dependencies: AssemblyDependencies): void {
  assertContinuationRuntimeV1AuthorityArtifactReader(
    dependencies.artifactStore,
    dependencies.database,
  );
  assertContinuationRuntimeV1PolicyAuthority(
    dependencies.policyAuthority,
    dependencies.database,
    dependencies.artifactStore,
  );
  assertContinuationRuntimeV1EffectCertificateReader(
    dependencies.effectCertificateReader,
    dependencies.database,
    dependencies.artifactStore,
    dependencies.policyAuthority,
  );
  assertContinuationRuntimeV1AuthorityStore(
    dependencies.authorityStore,
    dependencies.database,
    dependencies.artifactStore,
    dependencies.policyAuthority,
    dependencies.effectCertificateReader,
  );
  assertContinuationRuntimeV1ObservationStore(
    dependencies.observationStore,
    dependencies.database,
  );
  assertContinuationRuntimeV1MemoryStore(
    dependencies.memoryStore,
    dependencies.database,
  );
  assertContinuationRuntimeV1ExperimentCohortAuthority(
    dependencies.experimentCohortAuthority,
    dependencies.database,
    dependencies.artifactStore,
    dependencies.policyAuthority,
  );
}

export function assertContinuationRuntimeV1DecisionAssemblyService(
  value: unknown,
  dependencies: AssemblyDependencies,
): asserts value is ContinuationRuntimeV1DecisionAssemblyService {
  assertDependencies(dependencies);
  if (value === null || typeof value !== "object") fail("service_invalid");
  const record = SERVICES.get(value);
  if (!record
    || record.database !== dependencies.database
    || record.observationStore !== dependencies.observationStore
    || record.memoryStore !== dependencies.memoryStore
    || record.artifactStore !== dependencies.artifactStore
    || record.policyAuthority !== dependencies.policyAuthority
    || record.effectCertificateReader !== dependencies.effectCertificateReader
    || record.authorityStore !== dependencies.authorityStore
    || record.experimentCohortAuthority !== dependencies.experimentCohortAuthority) {
    fail("service_invalid");
  }
}

export function createContinuationRuntimeV1DecisionAssemblyService(
  dependencies: AssemblyDependencies,
): ContinuationRuntimeV1DecisionAssemblyService {
  assertDependencies(dependencies);
  let service!: ContinuationRuntimeV1DecisionAssemblyService;
  service = Object.freeze({
    async assemble(context, value) {
      const args = parseArgs(value);
      const binding = assertContinuationRuntimeV1AuthorityWriteContext(
        context,
        dependencies.database,
      );
      if (binding.operationKind !== "create_continuation"
        || binding.actorKind !== "trusted_host") fail("operation_context_forbidden");
      if (ASSEMBLY_CONTEXTS.has(context as object)) fail("operation_context_already_used");
      ASSEMBLY_CONTEXTS.add(context as object);
      const compiledAt = dependencies.database.mintAuthorityTime(null);
      assertCanonicalUtcMillis(compiledAt, "decision assembly compiled_at");

      const persistedSnapshot = await dependencies.observationStore.read({
        tenant_id: binding.tenantId,
        scope: binding.scope,
        world_snapshot_id: args.world_snapshot_ref.world_snapshot_id,
      });
      if (!persistedSnapshot
        || persistedSnapshot.snapshot.world_snapshot_sha256
          !== args.world_snapshot_ref.world_snapshot_sha256
        || persistedSnapshot.snapshot.collection_principal_sha256
          !== binding.actorPrincipalSha256
        || persistedSnapshot.snapshot.created_at > compiledAt
        || compiledAt >= persistedSnapshot.snapshot.expires_at) {
        fail("world_snapshot_not_current_or_authenticated");
      }
      const decisionIdentity = identity(binding.operationId, persistedSnapshot);
      const subject = persistedSnapshot.snapshot.authority_subject_sha256;
      const memoryHead = await dependencies.memoryStore.readHead(
        binding.tenantId,
        binding.scope,
      );
      if (!memoryHead) fail("memory_head_missing");
      const authorityHead = await dependencies.authorityStore.readHead({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
      });
      if (!authorityHead || authorityHead.source_operation.scope !== binding.scope) {
        fail("authority_head_missing");
      }
      const authoritativeRevision = await dependencies.authorityStore.readRevision({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        branch_id: authorityHead.target.branch_id,
        branch_revision: authorityHead.target.branch_revision,
      });
      if (!authoritativeRevision
        || !same(fullManifestRef(authoritativeRevision.manifest), authorityHead.target)) {
        fail("authority_head_target_missing");
      }

      const compilerCapability = await dependencies.policyAuthority.resolveExact({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        artifact_kind: "compiler_policy",
        artifact_ref: authoritativeRevision.manifest.compiler_policy_ref,
        at: compiledAt,
      });
      const evidenceCapability = await dependencies.policyAuthority.resolveExact({
        tenant_id: binding.tenantId,
        authority_subject_sha256: subject,
        artifact_kind: "evidence_policy",
        artifact_ref: authoritativeRevision.manifest.evidence_policy_ref,
        at: compiledAt,
      });
      const compilerRef = dependencies.policyAuthority.ref(compilerCapability);
      const evidenceRef = dependencies.policyAuthority.ref(evidenceCapability);
      const compilerPolicy = dependencies.policyAuthority.payload(compilerCapability);

      const cohortCapability = await dependencies.experimentCohortAuthority.resolveActive({
        tenant_id: binding.tenantId,
        scope: binding.scope,
        authority_subject_sha256: subject,
        task_family: decisionIdentity.task_family,
        host_principal_sha256: binding.actorPrincipalSha256,
        at: compiledAt,
      });
      let candidateManifest: AuthorityBranchManifestV1 | null = null;
      let experimentCohortRef:
        ContinuationContractV1["authority"]["experiment_cohort_ref"] = null;
      if (cohortCapability !== null) {
        const cohort = dependencies.experimentCohortAuthority.payload(cohortCapability);
        experimentCohortRef = dependencies.experimentCohortAuthority.ref(cohortCapability);
        if (!same(cohort.control_learning_ref, authorityHead.target)
          || !same(cohort.compiler_policy_ref, compilerRef)
          || !same(cohort.evidence_policy_ref, evidenceRef)) {
          fail("active_cohort_context_drift");
        }
        const candidateRevision = await dependencies.authorityStore.readRevision({
          tenant_id: binding.tenantId,
          authority_subject_sha256: subject,
          branch_id: cohort.candidate_learning_ref.branch_id,
          branch_revision: cohort.candidate_learning_ref.branch_revision,
        });
        if (!candidateRevision
          || candidateRevision.manifest.branch_kind !== "candidate"
          || candidateRevision.manifest.state !== "active_candidate"
          || !same(
            fullManifestRef(candidateRevision.manifest),
            cohort.candidate_learning_ref,
          )
          || !same(candidateRevision.manifest.base_authoritative_ref, authorityHead.target)
          || !same(candidateRevision.manifest.compiler_policy_ref, compilerRef)
          || !same(candidateRevision.manifest.evidence_policy_ref, evidenceRef)) {
          fail("active_candidate_not_serviceable");
        }
        candidateManifest = candidateRevision.manifest;
      }
      const learningRefsByKey = new Map<string, CapsuleRefV1>();
      for (const manifest of candidateManifest === null
        ? [authoritativeRevision.manifest]
        : [authoritativeRevision.manifest, candidateManifest]) {
        for (const capsuleBinding of manifest.capsule_bindings) {
          const ref = capsuleBinding.capsule;
          learningRefsByKey.set(canonicalContinuationJson(ref), ref);
        }
      }
      const learningCapsuleRefs = [...learningRefsByKey.values()].sort(
        (left, right) => compareCanonicalUtf8(
          canonicalContinuationJson(left),
          canonicalContinuationJson(right),
        ),
      );
      let memoryProjection: Awaited<ReturnType<
        MemoryStore["readCurrentServingProjection"]
      >>;
      try {
        memoryProjection = await dependencies.memoryStore.readCurrentServingProjection({
          tenant_id: binding.tenantId,
          scope: binding.scope,
          task_family: decisionIdentity.task_family,
          memory_scope_head_revision: memoryHead.head_revision,
          memory_scope_head_sha256: memoryHead.head_sha256,
          evaluated_at: compiledAt,
          learning_capsule_refs: learningCapsuleRefs,
        });
      } catch (error) {
        if (error
          instanceof ContinuationRuntimeV1CurrentServingProjectionCapacityError) {
          throw new ContinuationRuntimeV1CandidateSourceCapacityError(
            error.minimumContinuityCandidateCount,
            0,
          );
        }
        throw error;
      }
      const preflightArm = (manifest: AuthorityBranchManifestV1) => {
        const sourceCandidates = materializeContinuationCandidatesV1({
          scope: binding.scope,
          served_manifest: manifest,
          memory_projection: memoryProjection,
          evaluated_at: compiledAt,
        });
        const continuityCandidateCount = sourceCandidates.filter((candidate) =>
          candidate.provenance.lane === "verified_continuity").length;
        assertContinuationRuntimeV1CandidateSourceCapacity(
          continuityCandidateCount,
          sourceCandidates.length - continuityCandidateCount,
          Buffer.byteLength(
            canonicalContinuationJson(sourceCandidates),
            "utf8",
          ),
        );
        const retrieval = retrieveContinuationCandidatesV1({
          schema_version: "continuation_candidate_retrieval_input_v1",
          identity: decisionIdentity,
          obligations: args.obligations,
          candidates: sourceCandidates,
          evaluated_at: compiledAt,
          policy: compilerPolicy,
        });
        if (retrieval.status === "protected_overflow") {
          throw new ContinuationRuntimeV1CandidatePolicyCapacityError(
            retrieval.receipt,
          );
        }
        try {
          // Candidate validation, conflict/supersession analysis and mandatory
          // selected-capsule capacity are independent of the eventual serving
          // assignment.  Run them for every eligible arm before deriving the
          // HMAC assignment so an unserviceable arm cannot bias randomization.
          evaluateContinuationSelectionV1({
            schema_version: "continuation_selection_input_v1",
            identity: decisionIdentity,
            fence: {
              authority_subject_sha256: subject,
              evaluated_learning_branch: branchRef(fullManifestRef(manifest)),
              memory_scope_head_revision: memoryHead.head_revision,
              memory_scope_head_sha256: memoryHead.head_sha256,
              compiler_policy_payload_sha256: compilerRef.payload_sha256,
            },
            obligations: args.obligations,
            candidates: retrieval.candidates,
            observation_snapshot: persistedSnapshot.snapshot,
            evaluated_at: compiledAt,
            render_budget: args.render_budget,
            projection_frame_bytes: 0,
            forced_excluded_capsule_refs: [],
            policy: compilerPolicy,
          });
        } catch (error) {
          if (error instanceof ContinuationCompilerSelectedCapsuleCapacityErrorV1) {
            throw new ContinuationRuntimeV1CandidatePolicyCapacityError(
              retrieval.receipt,
            );
          }
          throw error;
        }
        return retrieval;
      };
      let servedManifest = authoritativeRevision.manifest;
      let servedRetrieval: ReturnType<typeof preflightArm>;
      let assignmentReceipt:
        ContinuationContractV1["authority"]["serving_assignment_receipt"] = null;
      let servingMode: ContinuationContractV1["authority"]["serving_mode"] =
        "authoritative_unassigned";
      if (cohortCapability === null) {
        servedRetrieval = preflightArm(authoritativeRevision.manifest);
      } else {
        if (candidateManifest === null || experimentCohortRef === null) {
          fail("active_candidate_not_serviceable");
        }
        const controlRetrieval = preflightArm(authoritativeRevision.manifest);
        const candidateRetrieval = preflightArm(candidateManifest);
        assignmentReceipt = dependencies.experimentCohortAuthority.deriveAssignment(
          cohortCapability,
          {
            assignment_basis: {
              schema_version: "serving_assignment_basis_v1",
              experiment_cohort_ref: experimentCohortRef,
              create_continuation_operation_id: binding.operationId,
              operation_request_sha256: binding.requestSha256,
              decision_id: decisionIdentity.decision_id,
              episode_id: decisionIdentity.episode_id,
              run_id: decisionIdentity.run_id,
              host_task_id: decisionIdentity.host_task_id,
              host_task_envelope_sha256:
                decisionIdentity.host_task_envelope_sha256,
              host_principal_sha256: binding.actorPrincipalSha256,
              task_family: decisionIdentity.task_family,
              source_task_sha256: decisionIdentity.source_task_sha256,
              world_snapshot_ref: args.world_snapshot_ref,
              memory_scope_head_ref: {
                revision: memoryHead.head_revision,
                head_sha256: memoryHead.head_sha256,
              },
            },
            assigned_at: compiledAt,
          },
        );
        servingMode = assignmentReceipt.arm === "candidate"
          ? "assigned_candidate"
          : "assigned_control";
        if (assignmentReceipt.arm === "candidate") {
          servedManifest = candidateManifest;
          servedRetrieval = candidateRetrieval;
        } else {
          servedRetrieval = controlRetrieval;
        }
      }
      const retrieval = servedRetrieval;
      const candidates = servedRetrieval.candidates;
      const authority = canonicalContinuationClone({
        authority_subject_sha256: subject,
        authoritative_learning_head: branchRef(authorityHead.target),
        served_learning_branch: branchRef(fullManifestRef(servedManifest)),
        serving_mode: servingMode,
        experiment_cohort_ref: experimentCohortRef,
        serving_assignment_receipt: assignmentReceipt,
        compiler_policy_ref: compilerRef,
        evidence_policy_ref: evidenceRef,
        memory_scope_head_revision: memoryHead.head_revision,
        memory_scope_head_sha256: memoryHead.head_sha256,
      });
      let contract: ContinuationContractV1;
      try {
        contract = compileContinuationV1({
          schema_version: "continuation_compile_input_v1",
          identity: decisionIdentity,
          authority,
          obligations: args.obligations,
          candidates,
          candidate_retrieval_receipt: retrieval.receipt,
          observation_snapshot: persistedSnapshot.snapshot,
          compiled_at: compiledAt,
          render_budget: args.render_budget,
          policy: compilerPolicy,
        });
      } catch (error) {
        if (error instanceof ContinuationCompilerSelectedCapsuleCapacityErrorV1) {
          throw new ContinuationRuntimeV1CandidatePolicyCapacityError(
            retrieval.receipt,
          );
        }
        throw error;
      }
      const selected = new Set(contract.selected_capsules.map(
        (item) => canonicalContinuationJson(item.capsule),
      ));
      const selectedCapsules: ExecutionCapsuleV1[] = candidates.flatMap((candidate) =>
        selected.has(canonicalContinuationJson({
          capsule_id: candidate.capsule.capsule_id,
          capsule_revision: candidate.capsule.capsule_revision,
          capsule_sha256: candidate.capsule.capsule_sha256,
        })) ? [candidate.capsule] : []
      );
      const renderResult = renderContinuationProjectionV1({
        contract,
        capsules: selectedCapsules,
      });

      const capability = Object.freeze(Object.create(null)) as object;
      CAPABILITIES.set(capability, {
        owner: service,
        database: dependencies.database,
        context,
        binding,
        contract,
        renderResult,
        consumed: false,
      });
      return capability as VerifiedCompiledContinuationCapabilityV1;
    },
  });
  SERVICES.set(service, dependencies);
  return service;
}

export function consumeVerifiedCompiledContinuationCapabilityV1(
  capability: VerifiedCompiledContinuationCapabilityV1,
  database: ContinuationRuntimeV1Database,
  context: ContinuationRuntimeV1AuthorityWriteContext,
): ConsumedCompiledContinuationV1 {
  if (capability === null || typeof capability !== "object") fail("capability_invalid");
  const record = CAPABILITIES.get(capability);
  if (!record || record.database !== database || record.context !== context) {
    fail("capability_invalid");
  }
  const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
  if (binding.transactionIdentity !== record.binding.transactionIdentity
    || binding.tenantId !== record.binding.tenantId
    || binding.scope !== record.binding.scope
    || binding.operationKind !== record.binding.operationKind
    || binding.operationId !== record.binding.operationId
    || binding.requestSha256 !== record.binding.requestSha256
    || binding.actorKind !== record.binding.actorKind
    || binding.actorPrincipalSha256 !== record.binding.actorPrincipalSha256) {
    fail("capability_context_mismatch");
  }
  if (record.consumed) fail("capability_already_consumed");
  record.consumed = true;
  return canonicalContinuationClone({
    continuation_contract: record.contract,
    render_result: record.renderResult,
  });
}
