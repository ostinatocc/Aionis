import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type ContinuationContractV1,
  type Sha256,
} from "../continuation/contract.js";
import { verifyClosedContinuationExposureProjectionV1 } from
  "../continuation/contract-verifier.js";
import type { EpisodeEventRefV1, EpisodeEventV1 } from
  "../continuation/episode.js";
import type { RenderedContinuationProjectionV1 } from
  "../continuation/renderer.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../continuation/task-envelope.js";
import type {
  ContinuationRuntimeV1AuthorityStore,
} from "../store/continuation-runtime-v1-authority-types.js";
import type { ContinuationRuntimeV1Database } from
  "../store/continuation-runtime-v1-database.js";
import type { ContinuationRuntimeV1EpisodeStore } from
  "../store/continuation-runtime-v1-episode-store.js";
import type { createContinuationRuntimeV1DurableJobEnqueuer } from
  "../store/continuation-runtime-v1-durable-job-enqueuer.js";
import {
  buildArchivedMemoryProjectionV1,
  ContinuationRuntimeV1MemoryHeadConflictError,
  type MemoryItemMutationV1,
} from "../store/continuation-runtime-v1-memory-contract.js";
import { createContinuationRuntimeV1MemoryStore } from
  "../store/continuation-runtime-v1-memory-store.js";
import type { ContinuationRuntimeV1ObservationStore } from
  "../store/continuation-runtime-v1-observation-store.js";
import {
  ContinuationRuntimeV1OperationActorConflictError,
  ContinuationRuntimeV1OperationConflictError,
  assertContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1AuthorityWriteContext,
  type ContinuationRuntimeV1OperationRecord,
  type ContinuationRuntimeV1OperationStore,
} from "../store/continuation-runtime-v1-operation-store.js";
import { deriveContinuationRuntimeV1OperationResultV1 } from
  "../store/continuation-runtime-v1-operation-result-derivation.js";
import type { ContinuationRuntimeV1OperationResultV1 } from
  "../store/continuation-runtime-v1-operation-result.js";
import {
  ContinuationRuntimeV1PolicyAmbiguityError,
  ContinuationRuntimeV1PolicyUnavailableError,
  type ContinuationRuntimeV1PolicyAuthority,
} from "../store/continuation-runtime-v1-policy-authority.js";
import {
  type ContinuationRuntimeV1Application,
  ContinuationRuntimeV1ApplicationError,
  type ContinuationRuntimeV1AuthorityBindingSelector,
  type ContinuationRuntimeV1DecisionBindingSelector,
  type ContinuationRuntimeV1Readiness,
  type ContinuationRuntimeV1SnapshotBindingSelector,
} from "./application.js";
import type { ContinuationRuntimeV1Principal } from "./auth.js";
import {
  type AuthenticatedDecisionQueryV1,
  type AuthorityDecisionCommandV1,
  type CreateContinuationCommandV1,
  type RecordObservationsCommandV1,
  type RecordOutcomeCommandV1,
  type RuntimeV1MutationCommand,
  type VerifiedAuthorityCommandBindingV1,
  type VerifiedDecisionCommandBindingV1,
  type VerifiedSnapshotCommandBindingV1,
} from "./command.js";
import { operationRequestFromVerifiedCommandV1 } from "./operation-request.js";
import {
  ContinuationRuntimeV1CandidatePolicyCapacityError,
  ContinuationRuntimeV1CandidateSourceCapacityError,
  type ContinuationRuntimeV1DecisionAssemblyService,
} from "./decision-assembly.js";
import { admitRecordObservationsMemoryProposalsV1 } from
  "./memory-proposal-admission.js";
import type { ContinuationRuntimeV1DecisionReader } from
  "./decision-reader.js";
import {
  buildContinuationRuntimeV1EmbeddingJobPayload,
  continuationRuntimeV1CapsuleRef,
} from "./embedding-job-contract.js";
import { buildContinuationRuntimeV1RetentionJobPayload } from
  "./retention-job-contract.js";

type MemoryStore = ReturnType<typeof createContinuationRuntimeV1MemoryStore>;
type DurableJobStore = Pick<
  ReturnType<typeof createContinuationRuntimeV1DurableJobEnqueuer>,
  "enqueue"
>;

export type ContinuationRuntimeV1ApplicationServiceDependencies = Readonly<{
  tenantId: string;
  trustRootSha256: Sha256;
  database: ContinuationRuntimeV1Database;
  operationStore: ContinuationRuntimeV1OperationStore;
  durableJobStore: DurableJobStore;
  observationStore: ContinuationRuntimeV1ObservationStore;
  memoryStore: MemoryStore;
  policyAuthority: ContinuationRuntimeV1PolicyAuthority;
  authorityStore: ContinuationRuntimeV1AuthorityStore;
  episodeStore: ContinuationRuntimeV1EpisodeStore;
  decisionAssembly: ContinuationRuntimeV1DecisionAssemblyService;
  decisionReader: ContinuationRuntimeV1DecisionReader;
  now?: () => string;
}>;

type ExposureProjection = Readonly<{
  event: EpisodeEventV1 & Readonly<{ event_kind: "contract_exposed" }>;
  contract: ContinuationContractV1;
  renderResult: RenderedContinuationProjectionV1;
}>;

const ZERO_SHA256 = "0".repeat(64) as Sha256;

function applicationError(statusCode: number, code: string): never {
  throw new ContinuationRuntimeV1ApplicationError(statusCode, code);
}

function assertPrincipal(
  principal: ContinuationRuntimeV1Principal,
  tenantId: string,
  expectedKind: "trusted_host" | "operator" | "either",
): void {
  if (principal.tenant_id !== tenantId) applicationError(403, "forbidden");
  if (expectedKind !== "either" && principal.principal_kind !== expectedKind) {
    applicationError(403, "forbidden");
  }
}

function isErrorWithMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

async function translateApplicationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ContinuationRuntimeV1ApplicationError) throw error;
    if (error instanceof ContinuationRuntimeV1OperationConflictError
      || error instanceof ContinuationRuntimeV1OperationActorConflictError) {
      applicationError(409, "operation_conflict");
    }
    if (error instanceof ContinuationRuntimeV1MemoryHeadConflictError
      || isErrorWithMessage(error, "continuation_runtime_v1_authority_head_conflict")) {
      applicationError(409, "authority_conflict");
    }
    if (error instanceof ContinuationRuntimeV1PolicyUnavailableError) {
      applicationError(503, "policy_unavailable");
    }
    if (error instanceof ContinuationRuntimeV1PolicyAmbiguityError) {
      applicationError(503, "policy_ambiguous");
    }
    if (error instanceof ContinuationRuntimeV1CandidatePolicyCapacityError) {
      applicationError(503, "candidate_policy_capacity_exceeded");
    }
    if (error instanceof ContinuationRuntimeV1CandidateSourceCapacityError) {
      applicationError(503, "candidate_source_capacity_exceeded");
    }
    throw error;
  }
}

function operationBinding(
  database: ContinuationRuntimeV1Database,
  context: ContinuationRuntimeV1AuthorityWriteContext,
) {
  const binding = assertContinuationRuntimeV1AuthorityWriteContext(context, database);
  return {
    tenantId: binding.tenantId,
    scope: binding.scope,
    operationKind: binding.operationKind,
    operationId: binding.operationId,
    requestSha256: binding.requestSha256,
    actorKind: binding.actorKind,
    actorPrincipalSha256: binding.actorPrincipalSha256,
  } as const;
}

function deriveDeclaredResult(
  database: ContinuationRuntimeV1Database,
  context: ContinuationRuntimeV1AuthorityWriteContext,
): ContinuationRuntimeV1OperationResultV1 {
  return deriveContinuationRuntimeV1OperationResultV1(
    database,
    operationBinding(database, context),
    "before_receipt_insert",
  );
}

async function readDurableOperation(
  store: ContinuationRuntimeV1OperationStore,
  command: RuntimeV1MutationCommand,
): Promise<ContinuationRuntimeV1OperationRecord> {
  const record = await store.read({
    tenantId: command.tenant_id,
    scope: command.scope,
    operationKind: command.operation_kind,
    operationId: command.operation_id,
  });
  if (!record
    || record.request_sha256 !== command.command_sha256
    || record.receipt.operation_kind !== command.operation_kind
    || record.receipt.operation_id !== command.operation_id
    || record.receipt.tenant_id !== command.tenant_id
    || record.receipt.scope !== command.scope
    || record.receipt.actor_kind !== command.actor_kind
    || record.receipt.actor_principal_sha256 !== command.actor_principal_sha256
    || record.receipt.request_sha256 !== command.command_sha256) {
    throw new Error("continuation_runtime_v1_application_operation_receipt_mismatch");
  }
  return record;
}

async function executeAndRead(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
  command: RuntimeV1MutationCommand,
  produce: (
    context: ContinuationRuntimeV1AuthorityWriteContext,
  ) => Promise<ContinuationRuntimeV1OperationResultV1>,
): Promise<ContinuationRuntimeV1OperationRecord> {
  const request = operationRequestFromVerifiedCommandV1(command);
  await dependencies.operationStore.execute({
    tenantId: command.tenant_id,
    scope: command.scope,
    operationKind: command.operation_kind,
    operationId: command.operation_id,
    actorKind: command.actor_kind,
    actorPrincipalSha256: command.actor_principal_sha256,
    request,
    produce,
  });
  return readDurableOperation(dependencies.operationStore, command);
}

function operationReceiptProjection(record: ContinuationRuntimeV1OperationRecord) {
  return {
    operation_receipt_sha256: record.receipt_sha256,
    operation_receipt: record.receipt,
  } as const;
}

function eventRef(event: EpisodeEventV1): EpisodeEventRefV1 {
  return canonicalContinuationClone({
    event_sequence: event.event_sequence,
    event_id: event.event_id,
    event_kind: event.event_kind,
    event_sha256: event.event_sha256,
  });
}

function sameEventRef(event: EpisodeEventV1, ref: EpisodeEventRefV1): boolean {
  return canonicalContinuationJson(eventRef(event)) === canonicalContinuationJson(ref);
}

function eventsFromReceipt(
  events: readonly EpisodeEventV1[],
  refs: readonly EpisodeEventRefV1[],
): readonly EpisodeEventV1[] {
  const selected = refs.map((ref) => {
    const matches = events.filter((event) => sameEventRef(event, ref));
    if (matches.length !== 1) {
      throw new Error("continuation_runtime_v1_application_event_receipt_mismatch");
    }
    return matches[0]!;
  });
  return canonicalContinuationClone(selected);
}

function exposureProjection(events: readonly EpisodeEventV1[]): ExposureProjection {
  const exposures = events.filter(
    (event): event is EpisodeEventV1 & Readonly<{ event_kind: "contract_exposed" }> =>
      event.event_kind === "contract_exposed",
  );
  if (exposures.length !== 1) {
    throw new Error("continuation_runtime_v1_application_exposure_cardinality_invalid");
  }
  const event = exposures[0]!;
  if (event.payload.payload_kind !== "contract_exposed_v1") {
    throw new Error("continuation_runtime_v1_application_exposure_payload_invalid");
  }
  const verified = verifyClosedContinuationExposureProjectionV1({
    contract: event.payload.continuation_contract,
    renderResult: event.payload.render_result,
  });
  if (verified.contract.identity.decision_id !== event.context.decision_id
    || verified.contract.contract_sha256 !== event.context.contract_sha256
    || verified.renderResult.render_result_sha256 !== event.render_result_sha256) {
    throw new Error("continuation_runtime_v1_application_exposure_binding_invalid");
  }
  return { event, contract: verified.contract, renderResult: verified.renderResult };
}

function assertExpectedAuthorityHead(
  head: Awaited<ReturnType<ContinuationRuntimeV1AuthorityStore["readHead"]>>,
  expected: Readonly<{ revision: number; head_sha256: Sha256 }>,
): asserts head is NonNullable<typeof head> {
  if (!head
    || head.head_revision !== expected.revision
    || head.head_sha256 !== expected.head_sha256) {
    applicationError(409, "authority_conflict");
  }
}

async function applyLifecycleDecision(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
  context: ContinuationRuntimeV1AuthorityWriteContext,
  command: AuthorityDecisionCommandV1,
  decision: Extract<AuthorityDecisionCommandV1["body"]["decision"], {
    kind: "lifecycle_suppress" | "lifecycle_restore" | "lifecycle_quarantine"
      | "lifecycle_archive";
  }>,
): Promise<void> {
  const authorityHead = await dependencies.authorityStore.readHead({
    tenant_id: command.tenant_id,
    authority_subject_sha256: command.authority_subject_sha256!,
  });
  assertExpectedAuthorityHead(authorityHead, command.body.expected_head);
  const memoryHead = await dependencies.memoryStore.readHead(
    command.tenant_id,
    command.scope,
  );
  if (!memoryHead
    || memoryHead.head_revision !== decision.expected_memory_head.revision
    || memoryHead.head_sha256 !== decision.expected_memory_head.head_sha256) {
    applicationError(409, "memory_head_conflict");
  }
  const persisted = await dependencies.memoryStore.readMemoryItem(
    command.tenant_id,
    command.scope,
    decision.memory_id,
  );
  if (!persisted) applicationError(404, "memory_not_found");
  const transitionAllowed = decision.kind === "lifecycle_suppress"
    ? persisted.lifecycle === "active"
    : decision.kind === "lifecycle_quarantine"
      ? persisted.lifecycle === "active" || persisted.lifecycle === "suppressed"
    : decision.kind === "lifecycle_archive"
      ? persisted.lifecycle === "active" || persisted.lifecycle === "suppressed"
      : persisted.lifecycle === "suppressed";
  if (!transitionAllowed) {
    applicationError(422, "lifecycle_transition_rejected");
  }
  const lifecycle = decision.kind === "lifecycle_restore"
    ? "active" as const
    : decision.kind === "lifecycle_quarantine"
      ? "quarantined" as const
    : decision.kind === "lifecycle_archive"
      ? "archived" as const
      : "suppressed" as const;
  const archived = decision.kind === "lifecycle_archive";
  const rehydrationRef = archived ? decision.rehydration_ref : null;
  const mutation: MemoryItemMutationV1 = canonicalContinuationClone({
    memory_id: persisted.memory_id as string,
    memory_kind: persisted.memory_kind as string,
    lifecycle,
    authority: persisted.authority as MemoryItemMutationV1["authority"],
    hydrated: !archived,
    projection: archived
      ? buildArchivedMemoryProjectionV1({
        memory_id: persisted.memory_id as string,
        source_projection_sha256: persisted.projection_sha256 as string,
        rehydration_ref: rehydrationRef!,
      })
      : persisted.projection as MemoryItemMutationV1["projection"],
    rehydration_ref: rehydrationRef,
    expires_at: persisted.expires_at as string | null,
  });
  await dependencies.memoryStore.appendMemoryRevision(context, {
    expected_head_revision: memoryHead.head_revision,
    items: [mutation],
    relations: [],
    capsules: [],
  });
  if (archived) {
    const payload = buildContinuationRuntimeV1RetentionJobPayload();
    const dedupeSha256 = canonicalContinuationSha256({
      schema_version: "lifecycle_archive_retention_job_dedupe_v1",
      operation_id: command.operation_id,
      operation_request_sha256: command.command_sha256,
      memory_id: decision.memory_id,
      rehydration_ref: decision.rehydration_ref,
    });
    await dependencies.durableJobStore.enqueue(context, {
      task_family: command.task_family,
      authority_subject_sha256: command.authority_subject_sha256!,
      job_kind: "retention",
      dedupe_key: `lifecycle-archive-retention-${dedupeSha256}`,
      priority: 0,
      max_attempts: 3,
      payload,
      available_at: dependencies.now?.() ?? new Date().toISOString(),
    });
  }
}

async function applyAuthorityDecision(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
  context: ContinuationRuntimeV1AuthorityWriteContext,
  command: AuthorityDecisionCommandV1,
): Promise<void> {
  const decision = command.body.decision;
  const expected = command.body.expected_head;
  const subject = command.authority_subject_sha256!;
  if (decision.kind === "lifecycle_suppress"
    || decision.kind === "lifecycle_restore"
    || decision.kind === "lifecycle_quarantine"
    || decision.kind === "lifecycle_archive") {
    await applyLifecycleDecision(dependencies, context, command, decision);
    return;
  }
  if (decision.kind === "candidate_advance") {
    await dependencies.authorityStore.advanceCandidate(context, {
      authority_subject_sha256: subject,
      candidate_ref: decision.candidate,
      target_state: decision.target_state,
      reason_codes: decision.reason_codes,
      evidence_sha256s: decision.evidence_sha256s,
      expected_head_revision: expected.revision,
      expected_head_sha256: expected.head_sha256,
    });
    return;
  }
  if (decision.kind === "branch_merge") {
    await dependencies.authorityStore.mergeCandidate(context, {
      authority_subject_sha256: subject,
      candidate_ref: decision.candidate,
      effect_certificate_sha256: decision.effect_certificate_sha256,
      expected_head_revision: expected.revision,
      expected_head_sha256: expected.head_sha256,
    });
    return;
  }
  if (decision.kind === "branch_reject"
    || decision.kind === "branch_quarantine"
    || decision.kind === "branch_expire") {
    const targetState = decision.kind === "branch_reject"
      ? "rejected" as const
      : decision.kind === "branch_quarantine"
        ? "quarantined" as const
        : "expired" as const;
    await dependencies.authorityStore.terminateCandidate(context, {
      authority_subject_sha256: subject,
      candidate_ref: decision.candidate,
      target_state: targetState,
      reason_codes: decision.reason_codes,
      evidence_sha256s: decision.evidence_sha256s,
      expected_head_revision: expected.revision,
      expected_head_sha256: expected.head_sha256,
    });
    return;
  }
  if (decision.kind === "authority_revert") {
    await dependencies.authorityStore.revertAuthority(context, {
      authority_subject_sha256: subject,
      revert_to_authority_ref: decision.target,
      reason_codes: decision.reason_codes,
      evidence_sha256s: decision.evidence_sha256s,
      expected_head_revision: expected.revision,
      expected_head_sha256: expected.head_sha256,
    });
    return;
  }
  if (decision.kind === "policy_rotate" && "artifact_ref" in decision) {
    await dependencies.authorityStore.rotatePolicies(context, {
      policy_rotation_artifact_ref: decision.artifact_ref,
      expected_head_revision: expected.revision,
      expected_head_sha256: expected.head_sha256,
    });
    return;
  }
  throw new Error("continuation_runtime_v1_application_authority_decision_unreachable");
}

async function readiness(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
  now: string,
): Promise<ContinuationRuntimeV1Readiness> {
  try {
    const subjects = await dependencies.database.read(() => {
      const meta = dependencies.database.db.prepare(
        "SELECT database_instance_id FROM runtime_meta WHERE singleton = 1",
      ).get() as { database_instance_id?: unknown } | undefined;
      if (meta?.database_instance_id !== dependencies.database.databaseInstanceId) {
        throw new Error("continuation_runtime_v1_application_database_identity_invalid");
      }
      return dependencies.database.db.prepare(`SELECT DISTINCT authority_subject_sha256
        FROM authority_artifacts
        WHERE tenant_id = ?
          AND artifact_kind IN ('compiler_policy', 'evidence_policy')
          AND trust_root_sha256 = ?
          AND valid_from <= ?
          AND (expires_at IS NULL OR ? < expires_at)`)
        .all(dependencies.tenantId, dependencies.trustRootSha256, now, now) as
          readonly { authority_subject_sha256?: unknown }[];
    });
    const candidates = new Set<Sha256>([ZERO_SHA256]);
    for (const row of subjects) {
      if (typeof row.authority_subject_sha256 === "string") {
        assertSha256(row.authority_subject_sha256, "readiness authority subject");
        candidates.add(row.authority_subject_sha256);
      }
    }
    for (const subject of candidates) {
      try {
        await dependencies.policyAuthority.resolveCurrent({
          tenant_id: dependencies.tenantId,
          authority_subject_sha256: subject,
          artifact_kind: "compiler_policy",
          at: now,
        });
        await dependencies.policyAuthority.resolveCurrent({
          tenant_id: dependencies.tenantId,
          authority_subject_sha256: subject,
          artifact_kind: "evidence_policy",
          at: now,
        });
        return { ready: true, reason_codes: [] };
      } catch (error) {
        if (error instanceof ContinuationRuntimeV1PolicyUnavailableError) continue;
        if (error instanceof ContinuationRuntimeV1PolicyAmbiguityError) {
          return { ready: false, reason_codes: ["policy_bundle_ambiguous"] };
        }
        throw error;
      }
    }
    return { ready: false, reason_codes: ["policy_bundle_unavailable"] };
  } catch {
    return { ready: false, reason_codes: ["readiness_authority_check_failed"] };
  }
}

function validateDependencies(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
): void {
  if (!dependencies || typeof dependencies !== "object"
    || !dependencies.tenantId || dependencies.tenantId !== dependencies.tenantId.trim()) {
    throw new Error("continuation_runtime_v1_application_dependencies_invalid");
  }
  assertSha256(dependencies.trustRootSha256, "application trust root");
  const requiredMethods: Readonly<Record<string, readonly string[]>> = {
    database: ["read"],
    operationStore: ["execute", "read"],
    durableJobStore: ["enqueue"],
    observationStore: ["put", "read"],
    memoryStore: ["appendMemoryRevision", "readHead", "readMemoryItem"],
    policyAuthority: ["resolveCurrent"],
    authorityStore: [
      "advanceCandidate",
      "createIsolatedCandidateDraft",
      "ensureGenesis",
      "mergeCandidate",
      "readHead",
      "revertAuthority",
      "rotatePolicies",
      "terminateCandidate",
    ],
    episodeStore: ["appendExposure", "appendOutcomeBundle", "readDecision"],
    decisionAssembly: ["assemble"],
    decisionReader: ["read"],
  };
  for (const [name, methods] of Object.entries(requiredMethods)) {
    const value = dependencies[name as keyof typeof dependencies];
    if (!value || typeof value !== "object") {
      throw new Error(`continuation_runtime_v1_application_${name}_invalid`);
    }
    for (const method of methods) {
      if (typeof (value as unknown as Record<string, unknown>)[method] !== "function") {
        throw new Error(
          `continuation_runtime_v1_application_${name}_${method}_invalid`,
        );
      }
    }
  }
}

export function createContinuationRuntimeV1ApplicationService(
  dependencies: ContinuationRuntimeV1ApplicationServiceDependencies,
): ContinuationRuntimeV1Application {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date().toISOString());

  return Object.freeze({
    readiness: () => readiness(dependencies, now()),

    resolveSnapshotBinding: (selector: ContinuationRuntimeV1SnapshotBindingSelector) =>
      translateApplicationErrors(async (): Promise<VerifiedSnapshotCommandBindingV1> => {
        assertPrincipal(selector.principal, dependencies.tenantId, "trusted_host");
        const persisted = await dependencies.observationStore.read({
          tenant_id: selector.principal.tenant_id,
          scope: selector.scope,
          world_snapshot_id: selector.world_snapshot_id,
        });
        if (!persisted
          || persisted.snapshot.world_snapshot_sha256 !== selector.world_snapshot_sha256
          || persisted.snapshot.collection_principal_sha256
            !== selector.principal.principal_sha256) {
          applicationError(404, "snapshot_not_found");
        }
        return canonicalContinuationClone({
          tenant_id: selector.principal.tenant_id,
          scope: selector.scope,
          actor_kind: "trusted_host" as const,
          actor_principal_sha256: selector.principal.principal_sha256,
          task_family: persisted.snapshot.host_task_envelope.task_family,
          authority_subject_sha256: persisted.snapshot.authority_subject_sha256,
          world_snapshot_id: persisted.snapshot.world_snapshot_id,
          world_snapshot_sha256: persisted.snapshot.world_snapshot_sha256,
        });
      }),

    resolveDecisionBinding: (selector: ContinuationRuntimeV1DecisionBindingSelector) =>
      translateApplicationErrors(async (): Promise<VerifiedDecisionCommandBindingV1> => {
        assertPrincipal(selector.principal, dependencies.tenantId, "either");
        if ((selector.purpose === "record_outcome") !== (selector.operation_id !== null)
          || (selector.purpose === "record_outcome"
            && selector.principal.principal_kind !== "trusted_host")) {
          applicationError(403, "forbidden");
        }
        const events = await dependencies.episodeStore.readDecision(
          selector.principal.tenant_id,
          selector.scope,
          selector.decision_id,
        );
        if (events.length === 0) applicationError(404, "decision_not_found");
        const exposure = exposureProjection(events);
        if (exposure.contract.identity.decision_id !== selector.decision_id
          || (selector.principal.principal_kind === "trusted_host"
            && exposure.contract.identity.collection_principal_sha256
              !== selector.principal.principal_sha256)) {
          applicationError(404, "decision_not_found");
        }
        return canonicalContinuationClone({
          tenant_id: selector.principal.tenant_id,
          scope: selector.scope,
          actor_kind: selector.principal.principal_kind,
          actor_principal_sha256: selector.principal.principal_sha256,
          task_family: exposure.contract.identity.task_family,
          authority_subject_sha256:
            exposure.contract.authority.authority_subject_sha256,
          decision_id: selector.decision_id,
          contract_sha256: exposure.contract.contract_sha256,
          render_result_sha256: exposure.renderResult.render_result_sha256,
          exposure_receipt_sha256: exposure.event.event_sha256,
          host_task_envelope_sha256:
            exposure.contract.identity.host_task_envelope_sha256,
        });
      }),

    resolveAuthorityBinding: (selector: ContinuationRuntimeV1AuthorityBindingSelector) =>
      translateApplicationErrors(async (): Promise<VerifiedAuthorityCommandBindingV1> => {
        assertPrincipal(selector.principal, dependencies.tenantId, "operator");
        const expectedSubject = continuationAuthoritySubjectSha256V1({
          tenant_id: selector.principal.tenant_id,
          scope: selector.scope,
          task_family: selector.task_family,
        });
        if (expectedSubject !== selector.authority_subject_sha256) {
          applicationError(403, "forbidden");
        }
        const head = await dependencies.authorityStore.readHead({
          tenant_id: selector.principal.tenant_id,
          authority_subject_sha256: expectedSubject,
        });
        if (!head || head.source_operation.scope !== selector.scope) {
          applicationError(404, "authority_not_found");
        }
        return canonicalContinuationClone({
          tenant_id: selector.principal.tenant_id,
          scope: selector.scope,
          actor_kind: "operator" as const,
          actor_principal_sha256: selector.principal.principal_sha256,
          task_family: selector.task_family,
          authority_subject_sha256: expectedSubject,
        });
      }),

    recordObservations: (command: RecordObservationsCommandV1) =>
      translateApplicationErrors(async () => {
        const record = await executeAndRead(dependencies, command, async (context) => {
          const persisted = await dependencies.observationStore.put(context, {
            host_task_envelope: command.body.host_task,
            collector_observations: command.body.collector_observations,
            signed_observations: command.body.signed_observations,
          });
          const admission = admitRecordObservationsMemoryProposalsV1({
            command,
            host_task_envelope: persisted.snapshot.host_task_envelope,
            world_snapshot: persisted.snapshot,
          });
          const head = await dependencies.memoryStore.readHead(
            command.tenant_id,
            command.scope,
          );
          const mutationCount = admission.mutation.items.length
            + admission.mutation.relations.length
            + admission.mutation.capsules.length;
          let appendedCapsules = [] as Awaited<ReturnType<
            MemoryStore["appendMemoryRevision"]
          >>["capsules"];
          if (head === null || mutationCount > 0) {
            const appended = await dependencies.memoryStore.appendMemoryRevision(context, {
              expected_head_revision: head?.head_revision ?? null,
              ...admission.mutation,
            });
            appendedCapsules = appended.capsules;
          }
          if (appendedCapsules.length > 0) {
            const payload = buildContinuationRuntimeV1EmbeddingJobPayload(
              appendedCapsules.map(continuationRuntimeV1CapsuleRef),
            );
            const payloadSha256 = canonicalContinuationSha256(payload);
            const dedupeSha256 = canonicalContinuationSha256({
              schema_version: "record_observations_embedding_job_dedupe_v1",
              operation_id: command.operation_id,
              operation_request_sha256: command.command_sha256,
              payload_sha256: payloadSha256,
            });
            await dependencies.durableJobStore.enqueue(context, {
              task_family: persisted.snapshot.host_task_envelope.task_family,
              authority_subject_sha256:
                persisted.snapshot.authority_subject_sha256,
              job_kind: "embedding",
              dedupe_key: `record-observations-embedding-${dedupeSha256}`,
              priority: 0,
              max_attempts: 3,
              payload,
              available_at: now(),
            });
          }
          const genesis = await dependencies.authorityStore.ensureGenesis(context);
          if (admission.candidate_capsule_ids.length > 0) {
            const candidate = await dependencies.authorityStore.createIsolatedCandidateDraft(context, {
              expected_head_revision: genesis.head.head_revision,
              expected_head_sha256: genesis.head.head_sha256,
            });
            if (candidate === null) {
              throw new Error(
                "continuation_runtime_v1_application_candidate_draft_missing",
              );
            }
          }
          return deriveDeclaredResult(dependencies.database, context);
        });
        if (record.receipt.result.schema_version !== "record_observations_result_v1") {
          throw new Error("continuation_runtime_v1_application_operation_result_kind_mismatch");
        }
        return canonicalContinuationClone({
          schema_version: "record_observations_response_v1" as const,
          observation_batch_id: command.operation_id,
          result: record.receipt.result,
          ...operationReceiptProjection(record),
        });
      }),

    createContinuation: (command: CreateContinuationCommandV1) =>
      translateApplicationErrors(async () => {
        const record = await executeAndRead(dependencies, command, async (context) => {
          const capability = await dependencies.decisionAssembly.assemble(context, {
            world_snapshot_ref: command.body.world_snapshot_ref,
            obligations: command.body.obligations,
            render_budget: command.body.render_budget_bytes,
          });
          await dependencies.episodeStore.appendExposure(context, capability);
          return deriveDeclaredResult(dependencies.database, context);
        });
        if (record.receipt.result.schema_version !== "create_continuation_result_v1") {
          throw new Error("continuation_runtime_v1_application_operation_result_kind_mismatch");
        }
        const events = await dependencies.episodeStore.readDecision(
          command.tenant_id,
          command.scope,
          record.receipt.result.decision_id,
        );
        const durableEvents = eventsFromReceipt(events, record.receipt.result.event_refs);
        const exposure = exposureProjection(durableEvents);
        return canonicalContinuationClone({
          schema_version: "create_continuation_response_v1" as const,
          decision_id: exposure.contract.identity.decision_id,
          continuation_contract: exposure.contract,
          render_result: exposure.renderResult,
          exposure_receipt: eventRef(exposure.event),
          ...operationReceiptProjection(record),
        });
      }),

    recordOutcome: (command: RecordOutcomeCommandV1) =>
      translateApplicationErrors(async () => {
        const record = await executeAndRead(dependencies, command, async (context) => {
          await dependencies.episodeStore.appendOutcomeBundle(context, {
            decision_id: command.body.decision_ref.decision_id,
            use_receipt: command.body.use_receipt,
            outcome_receipt: command.body.outcome_receipt,
          });
          return deriveDeclaredResult(dependencies.database, context);
        });
        if (record.receipt.result.schema_version !== "record_outcome_result_v1") {
          throw new Error("continuation_runtime_v1_application_operation_result_kind_mismatch");
        }
        const events = await dependencies.episodeStore.readDecision(
          command.tenant_id,
          command.scope,
          record.receipt.result.decision_id,
        );
        const durableEvents = eventsFromReceipt(events, record.receipt.result.event_refs);
        return canonicalContinuationClone({
          schema_version: "record_outcome_response_v1" as const,
          episode_id: record.receipt.result.episode_id,
          decision_id: record.receipt.result.decision_id,
          events: durableEvents,
          event_refs: record.receipt.result.event_refs,
          ledger_head: record.receipt.result.event_refs.at(-1) ?? null,
          ...operationReceiptProjection(record),
        });
      }),

    decideAuthority: (command: AuthorityDecisionCommandV1) =>
      translateApplicationErrors(async () => {
        const record = await executeAndRead(dependencies, command, async (context) => {
          await applyAuthorityDecision(dependencies, context, command);
          return deriveDeclaredResult(dependencies.database, context);
        });
        if (record.receipt.result.schema_version !== "authority_decision_result_v1") {
          throw new Error("continuation_runtime_v1_application_operation_result_kind_mismatch");
        }
        return canonicalContinuationClone({
          schema_version: "authority_decision_response_v1" as const,
          result: record.receipt.result,
          ...operationReceiptProjection(record),
        });
      }),

    readDecision: (query: AuthenticatedDecisionQueryV1) =>
      translateApplicationErrors(async () => {
        const result = await dependencies.decisionReader.read(query);
        return canonicalContinuationClone(result);
      }),
  });
}
