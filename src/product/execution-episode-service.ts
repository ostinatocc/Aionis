import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import stableStringify from "fast-json-stable-stringify";

import {
  WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
  WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
} from "../execution/workspace-state-capture.js";
import {
  cleanupInterruptedVerifierSubjectMaterialization,
  type VerifierSubjectMaterializationV1,
} from "../execution/verifier-subject-materialization.js";
import {
  createSubjectStateAdapterRegistry,
  type SubjectStateAdapterRegistry,
} from "../execution/subject-state-adapter-registry.js";
import {
  stateContentRef,
  type CapturedSubjectStateV2,
  type ExecutionSubjectV1,
  type StateDeltaV1,
  type StateSnapshotV2,
  type SubjectStateAdapter,
} from "../execution/subject-state-adapter.js";
import {
  createWorkspaceSubjectStateAdapter,
  type WorkspaceSubjectAdapterInputV2,
} from "../execution/workspace-subject-state-adapter.js";
import {
  STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
  STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
  createStructuredArtifactSubjectStateAdapter,
  type StructuredArtifactSubjectAdapterInputV1,
} from "../execution/structured-artifact-subject-state-adapter.js";
import {
  SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
  SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
  createSqliteDatabaseSubjectStateAdapter,
  type SqliteDatabaseSubjectAdapterInputV1,
} from "../execution/sqlite-database-subject-state-adapter.js";
import type {
  RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1,
  RuntimeEpisodeVerifierOpenLaunchAttemptV1,
} from "../execution/verifier-launch-attempt.js";
import {
  materializeRuntimeOwnedEvidenceInCurrentTransaction,
} from "../execution/runtime-owned-evidence.js";
import {
  runtimeEpisodeVerifierExecutionEvidence,
  runtimeEpisodeVerifierFailureAttribution,
  type RuntimeEpisodeVerifierDefinitionIdentityV1,
  type RuntimeEpisodeVerifierLaunchV1,
  type RuntimeEpisodeVerifierRegistry,
} from "../execution/runtime-episode-verifier-registry.js";
import {
  deriveExecutionTaskClusterV1,
} from "../execution/task-cluster.js";
import {
  synchronizeCurrentExecutionStateHeadV2,
} from "../execution/current-execution-state.js";
import type {
  ExecutionStateStore,
} from "../execution/state-store.js";
import {
  ActionMutationReceiptV1Schema,
  AgentDecisionEventV1Schema,
  DecisionEpisodeV1Schema,
  ExecutionEpisodeSubjectIdentityV1Schema,
  ExecutionEpisodeSubjectStateSpecV2Schema,
  ExecutionEpisodeTaskManifestV1Schema,
  PlannedActionEventV1Schema,
  ProgressStateEventV1Schema,
  SemanticEventAuthorityV1Schema,
  SemanticObservationEventV1Schema,
  StateSnapshotV1Schema,
  VerifierInvocationV1Schema,
  VerifierOutcomeReceiptV1Schema,
  buildDecisiveEvidenceExcerptV1,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
  executionEpisodeTaskManifestDigest,
  verifierInvocationDigest,
  verifierOutcomeEvidenceDigest,
  type ActionMutationReceiptV1,
  type AgentDecisionEventV1,
  type DecisiveEvidenceExcerptV1,
  type DecisionEpisodeV1,
  type EvidenceArtifactRefV1,
  type ExecutionEpisodeEventEnvelopeV1,
  type ExecutionCostReceiptV1,
  type ExecutionEpisodeSubjectIdentityV1,
  type ExecutionEpisodeSubjectStateSpecV2,
  type ExecutionEpisodeTerminationV1,
  type PlannedActionEventV1,
  type ProgressStateEventV1,
  type SemanticEventAuthorityV1,
  type SemanticObservationEventV1,
  type StateSnapshotV1,
  type VerifierInvocationV1,
  type VerifierOutcomeReceiptV1,
} from "../memory/execution-episode.js";
import {
  HostTaskEnvelopeV1Schema,
  hostTaskEnvelopeDigest,
  type HostTaskEnvelopeV1,
} from "../execution/host-task-contract.js";
import type {
  LiteEvidenceArtifactStore,
} from "../store/lite-evidence-artifact-store.js";
import type {
  LiteExecutionSessionLeaseStore,
} from "../store/lite-execution-session-lease-store.js";
import {
  runtimeVerifierInvocationReservationDigest,
  type LiteExecutionEpisodeCostInputV1,
  type LiteExecutionEpisodeAppendResult,
  type LiteExecutionEpisodeReplay,
  type LiteExecutionEpisodeStore,
} from "../store/lite-execution-episode-store.js";
import type { SqliteTransactionRunner } from "../store/sqlite-transaction-runner.js";

const MAX_ID_UTF8_BYTES = 256;
const MAX_MODEL_CONFIG_BYTES = 1024 * 1024;
const REDACTION_POLICY = "execution_episode_runtime_redaction_v1";
const RETENTION_POLICY = "execution_episode_replay_v1";
const JSON_MEDIA_TYPE = "application/json";
const BINARY_MEDIA_TYPE = "application/octet-stream";
const UTF8_ENCODING = "utf-8";
const BINARY_ENCODING = "binary";
const SEMANTIC_EVIDENCE_KINDS =
  new Set<ExecutionEpisodeSemanticEvidenceKindV1>([
    "feature_vector",
    "prompt",
    "tool_request",
    "tool_result",
    "manifest",
  ]);
const HOST_SEMANTIC_AUTHORITY_KEYS = new Set(["kind", "actorId"]);
const MODEL_SEMANTIC_AUTHORITY_KEYS = new Set([
  "kind",
  "actorId",
  "modelId",
  "derivationSha256",
  "uncertainty",
]);
const EXECUTION_COST_KEYS = new Set([
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "tokenUsageAuthority",
  "usageReceiptBytes",
  "usageReceiptMediaType",
  "usageReceiptEncoding",
  "monetaryCostMicros",
  "currency",
  "producerId",
]);

const BEGIN_KEYS = new Set([
  "tenantId",
  "publicScope",
  "storeScope",
  "operationId",
  "taskEnvelope",
  "sourceTaskBytes",
  "runId",
  "modelId",
  "modelConfig",
  "budget",
  "workspaceRoot",
  "subjectStateSpec",
  "requiredVerifierId",
  "continuationId",
]);

const ACTION_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "actionKind",
  "toolName",
  "requestBytes",
  "resultBytes",
]);

const RESTORE_SNAPSHOT_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "targetSnapshotId",
]);

const SEMANTIC_OBSERVATION_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "observation",
  "authority",
  "evidenceKind",
  "evidenceBytes",
  "evidenceMediaType",
  "evidenceEncoding",
  "decisiveEvidence",
]);

const AGENT_DECISION_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "decision",
  "reasons",
  "alternativesRejected",
  "authority",
  "evidenceKind",
  "evidenceBytes",
  "evidenceMediaType",
  "evidenceEncoding",
  "decisiveEvidence",
]);

const PROGRESS_STATE_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "itemId",
  "state",
  "statement",
  "authority",
  "evidenceKind",
  "evidenceBytes",
  "evidenceMediaType",
  "evidenceEncoding",
  "decisiveEvidence",
]);

const PLANNED_ACTION_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "actionId",
  "intent",
  "justification",
  "preconditions",
  "authority",
  "evidenceKind",
  "evidenceBytes",
  "evidenceMediaType",
  "evidenceEncoding",
  "decisiveEvidence",
]);

const RESUME_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "workspaceRoot",
  "continuationId",
]);

const VERIFIER_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
]);

const CLOSE_KEYS = new Set([
  "tenantId",
  "storeScope",
  "episodeId",
  "operationId",
  "workspaceRoot",
  "expectedCurrentStateSnapshotId",
  "termination",
  "verifierReceiptId",
  "outcomeDetails",
  "cost",
]);

export class ExecutionEpisodeServiceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "ExecutionEpisodeServiceError";
    this.code = code;
  }
}

export type ExecutionEpisodeBeginInputV1 = Readonly<{
  tenantId: string;
  publicScope: string;
  storeScope: string;
  operationId: string;
  taskEnvelope: HostTaskEnvelopeV1;
  sourceTaskBytes: Uint8Array;
  runId: string;
  modelId: string;
  modelConfig: unknown;
  budget: DecisionEpisodeV1["budget"];
  workspaceRoot: string;
  subjectStateSpec?: ExecutionEpisodeSubjectStateSpecV2;
  requiredVerifierId: string;
  continuationId?: string;
}>;

export type ExecutionEpisodeBeginResultV1 = Readonly<{
  episode: DecisionEpisodeV1;
  initial_state_snapshot: StateSnapshotV1;
  initial_state_snapshot_v2: StateSnapshotV2;
  event: ExecutionEpisodeEventEnvelopeV1;
  replayed: boolean;
}>;

export type ExecutionEpisodeRecordActionInputV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  operationId: string;
  workspaceRoot: string;
  expectedCurrentStateSnapshotId: string;
  actionKind: string;
  toolName?: string;
  requestBytes: Uint8Array;
  resultBytes: Uint8Array;
}>;

export type ExecutionEpisodeRecordActionResultV1 = Readonly<{
  action: ActionMutationReceiptV1;
  /**
   * The exact state produced by this action. This remains stable when an old
   * operation is replayed after later actions have advanced the episode.
   */
  state_after_snapshot: StateSnapshotV1;
  state_after_snapshot_v2: StateSnapshotV2;
  /**
   * The episode head at response time. SDK handles must advance from this
   * field rather than from the historical action result.
   */
  current_state_snapshot: StateSnapshotV1;
  current_state_snapshot_v2: StateSnapshotV2;
  event: ExecutionEpisodeEventEnvelopeV1;
  replayed: boolean;
}>;

export type ExecutionEpisodeRestoreSnapshotInputV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  operationId: string;
  workspaceRoot: string;
  expectedCurrentStateSnapshotId: string;
  targetSnapshotId: string;
}>;

export type ExecutionEpisodeRestoreSnapshotResultV1 =
  ExecutionEpisodeRecordActionResultV1 & Readonly<{
    recovery_target_snapshot: StateSnapshotV1;
    recovery_target_snapshot_v2: StateSnapshotV2;
    restored_exact: true;
  }>;

export type ExecutionEpisodeSemanticAuthorityInputV1 =
  | Readonly<{
    kind: "host_declared";
    actorId: string;
  }>
  | Readonly<{
    kind: "model_derived";
    actorId: string;
    modelId: string;
    derivationSha256: string;
    uncertainty: number;
  }>;

export type ExecutionEpisodeSemanticEvidenceKindV1 =
  | "feature_vector"
  | "prompt"
  | "tool_request"
  | "tool_result"
  | "manifest";

export type ExecutionEpisodeDecisiveEvidenceInputV1 = Readonly<{
  sourceRef: string;
  excerpt: string;
}>;

type ExecutionEpisodeSemanticInputBaseV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  operationId: string;
  workspaceRoot: string;
  expectedCurrentStateSnapshotId: string;
  authority: ExecutionEpisodeSemanticAuthorityInputV1;
  evidenceKind: ExecutionEpisodeSemanticEvidenceKindV1;
  evidenceBytes: Uint8Array;
  evidenceMediaType?: string;
  evidenceEncoding?: string;
  decisiveEvidence?: readonly ExecutionEpisodeDecisiveEvidenceInputV1[];
}>;

export type ExecutionEpisodeRecordObservationInputV1 =
  ExecutionEpisodeSemanticInputBaseV1 & Readonly<{
    observation: string;
  }>;

export type ExecutionEpisodeRecordDecisionInputV1 =
  ExecutionEpisodeSemanticInputBaseV1 & Readonly<{
    decision: string;
    reasons: readonly string[];
    alternativesRejected: readonly string[];
  }>;

export type ExecutionEpisodeRecordProgressInputV1 =
  ExecutionEpisodeSemanticInputBaseV1 & Readonly<{
    itemId: string;
    state: ProgressStateEventV1["state"];
    statement: string;
  }>;

export type ExecutionEpisodeRecordPlannedActionInputV1 =
  ExecutionEpisodeSemanticInputBaseV1 & Readonly<{
    actionId: string;
    intent: string;
    justification: string;
    preconditions: readonly string[];
  }>;

export type ExecutionEpisodeRecordSemanticResultV1<
  TSemanticEvent,
> = Readonly<{
  semantic_event: TSemanticEvent;
  current_state_snapshot: StateSnapshotV1;
  current_state_snapshot_v2: StateSnapshotV2;
  event: ExecutionEpisodeEventEnvelopeV1;
  replayed: boolean;
}>;

type SemanticExecutionEventV1 =
  | SemanticObservationEventV1
  | AgentDecisionEventV1
  | ProgressStateEventV1
  | PlannedActionEventV1;

export type ExecutionEpisodeResumeInputV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  workspaceRoot: string;
  continuationId?: string;
}>;

export type ExecutionEpisodeResumeResultV1 = Readonly<{
  replay: LiteExecutionEpisodeReplay;
  current_state_snapshot: StateSnapshotV1;
  current_state_snapshot_v2: StateSnapshotV2;
}>;

export type ExecutionEpisodeRunVerifierInputV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  operationId: string;
  workspaceRoot: string;
  expectedCurrentStateSnapshotId: string;
}>;

export type ExecutionEpisodeRunVerifierResultV1 = Readonly<{
  invocation: VerifierInvocationV1;
  outcome: VerifierOutcomeReceiptV1;
  verified_state_snapshot: StateSnapshotV1;
  verified_state_snapshot_v2: StateSnapshotV2;
  current_state_snapshot: StateSnapshotV1;
  current_state_snapshot_v2: StateSnapshotV2;
  event: ExecutionEpisodeEventEnvelopeV1;
  replayed: boolean;
}>;

export type ExecutionEpisodeCostInputV1 = Readonly<{
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  tokenUsageAuthority: "provider_total" | "signed_host_receipt";
  usageReceiptBytes: Uint8Array;
  usageReceiptMediaType?: string;
  usageReceiptEncoding?: string;
  monetaryCostMicros?: number;
  currency?: string;
  producerId: string;
}>;

export type ExecutionEpisodeCloseInputV1 = Readonly<{
  tenantId: string;
  storeScope: string;
  episodeId: string;
  operationId: string;
  workspaceRoot: string;
  expectedCurrentStateSnapshotId: string;
  termination: ExecutionEpisodeTerminationV1;
  verifierReceiptId?: string;
  outcomeDetails?: readonly string[];
  cost?: ExecutionEpisodeCostInputV1;
}>;

export type ExecutionEpisodeService = Readonly<{
  recoverInterruptedVerifierLaunches(): Promise<Readonly<{
    recovered_count: number;
    cleanup_failure_count: number;
  }>>;
  begin(
    input: ExecutionEpisodeBeginInputV1,
  ): Promise<ExecutionEpisodeBeginResultV1>;
  resume(
    input: ExecutionEpisodeResumeInputV1,
  ): Promise<ExecutionEpisodeResumeResultV1>;
  recordAction(
    input: ExecutionEpisodeRecordActionInputV1,
  ): Promise<ExecutionEpisodeRecordActionResultV1>;
  restoreSnapshot(
    input: ExecutionEpisodeRestoreSnapshotInputV1,
  ): Promise<ExecutionEpisodeRestoreSnapshotResultV1>;
  recordObservation(
    input: ExecutionEpisodeRecordObservationInputV1,
  ): Promise<
    ExecutionEpisodeRecordSemanticResultV1<SemanticObservationEventV1>
  >;
  recordDecision(
    input: ExecutionEpisodeRecordDecisionInputV1,
  ): Promise<
    ExecutionEpisodeRecordSemanticResultV1<AgentDecisionEventV1>
  >;
  recordProgress(
    input: ExecutionEpisodeRecordProgressInputV1,
  ): Promise<
    ExecutionEpisodeRecordSemanticResultV1<ProgressStateEventV1>
  >;
  recordPlannedAction(
    input: ExecutionEpisodeRecordPlannedActionInputV1,
  ): Promise<
    ExecutionEpisodeRecordSemanticResultV1<PlannedActionEventV1>
  >;
  runVerifier(
    input: ExecutionEpisodeRunVerifierInputV1,
  ): Promise<ExecutionEpisodeRunVerifierResultV1>;
  close(
    input: ExecutionEpisodeCloseInputV1,
  ): Promise<LiteExecutionEpisodeAppendResult>;
}>;

export type ExecutionEpisodeServiceDependencies = Readonly<{
  artifactStore: LiteEvidenceArtifactStore;
  episodeStore: LiteExecutionEpisodeStore;
  stateStore: ExecutionStateStore;
  sessionLeaseStore?: LiteExecutionSessionLeaseStore;
  verifierRegistry: RuntimeEpisodeVerifierRegistry;
  subjectAdapterRegistry?: SubjectStateAdapterRegistry;
  runtimeInstanceId?: string;
}>;

function fail(code: string): never {
  throw new ExecutionEpisodeServiceError(code);
}

function assertPlainExactKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  operation: string,
): asserts value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
    || Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail(`execution_episode_${operation}_input_invalid`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length !== 0) {
    fail(`execution_episode_${operation}_unknown_fields`);
  }
}

function assertExactId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") > MAX_ID_UTF8_BYTES
  ) {
    fail(`execution_episode_${label}_invalid`);
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJsonBytes(value: unknown, label: string): Buffer {
  let canonical: string | undefined;
  try {
    canonical = stableStringify(value);
  } catch {
    fail(`execution_episode_${label}_not_canonical_json`);
  }
  if (typeof canonical !== "string") {
    fail(`execution_episode_${label}_not_canonical_json`);
  }
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.byteLength > MAX_MODEL_CONFIG_BYTES) {
    fail(`execution_episode_${label}_too_large`);
  }
  return bytes;
}

function canonicalSemanticAuthorityInput(
  value: unknown,
): ExecutionEpisodeSemanticAuthorityInputV1 {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return fail("execution_episode_semantic_authority_invalid");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "host_declared") {
    assertPlainExactKeys(
      value,
      HOST_SEMANTIC_AUTHORITY_KEYS,
      "semantic_authority",
    );
    assertExactId(value.actorId, "semantic_actor_id");
    return Object.freeze({
      kind,
      actorId: value.actorId,
    });
  }
  if (kind === "model_derived") {
    assertPlainExactKeys(
      value,
      MODEL_SEMANTIC_AUTHORITY_KEYS,
      "semantic_authority",
    );
    assertExactId(value.actorId, "semantic_actor_id");
    assertExactId(value.modelId, "semantic_model_id");
    if (
      typeof value.derivationSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.derivationSha256)
      || typeof value.uncertainty !== "number"
      || !Number.isFinite(value.uncertainty)
      || value.uncertainty < 0
      || value.uncertainty > 1
    ) {
      return fail("execution_episode_semantic_model_authority_invalid");
    }
    return Object.freeze({
      kind,
      actorId: value.actorId,
      modelId: value.modelId,
      derivationSha256: value.derivationSha256,
      uncertainty: value.uncertainty,
    });
  }
  return fail("execution_episode_semantic_authority_invalid");
}

function semanticAuthorityWithEvidence(
  authority: ExecutionEpisodeSemanticAuthorityInputV1,
  evidenceRef: EvidenceArtifactRefV1,
): SemanticEventAuthorityV1 {
  if (authority.kind === "host_declared") {
    return SemanticEventAuthorityV1Schema.parse({
      contract_version: "semantic_event_authority_v1",
      kind: authority.kind,
      actor_id: authority.actorId,
      model_id: null,
      derivation_sha256: null,
      uncertainty: null,
      evidence_refs: [evidenceRef],
    });
  }
  return SemanticEventAuthorityV1Schema.parse({
    contract_version: "semantic_event_authority_v1",
    kind: authority.kind,
    actor_id: authority.actorId,
    model_id: authority.modelId,
    derivation_sha256: authority.derivationSha256,
    uncertainty: authority.uncertainty,
    evidence_refs: [evidenceRef],
  });
}

function semanticEvidenceContainsExactExcerpt(
  evidenceBytes: Buffer,
  excerpt: string,
): boolean {
  const evidenceText = evidenceBytes.toString("utf8");
  if (!Buffer.from(evidenceText, "utf8").equals(evidenceBytes)) {
    return false;
  }
  if (evidenceText.includes(excerpt)) {
    return true;
  }
  const jsonEscapedExcerpt = JSON.stringify(excerpt).slice(1, -1);
  return evidenceText.includes(jsonEscapedExcerpt);
}

function decisiveEvidenceForArtifact(
  value: readonly ExecutionEpisodeDecisiveEvidenceInputV1[] | undefined,
  evidenceBytes: Buffer,
  evidenceArtifact: EvidenceArtifactRefV1,
): readonly DecisiveEvidenceExcerptV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) {
    return fail("execution_episode_decisive_evidence_invalid");
  }
  const decisiveEvidence = value.map((entry) => {
    assertPlainExactKeys(
      entry,
      new Set(["sourceRef", "excerpt"]),
      "decisive_evidence",
    );
    if (
      typeof entry.sourceRef !== "string"
      || entry.sourceRef.length === 0
      || entry.sourceRef !== entry.sourceRef.trim()
      || Buffer.byteLength(entry.sourceRef, "utf8") > 512
      || typeof entry.excerpt !== "string"
      || entry.excerpt.length === 0
      || entry.excerpt !== entry.excerpt.trim()
      || Buffer.byteLength(entry.excerpt, "utf8") > 2_048
    ) {
      return fail("execution_episode_decisive_evidence_invalid");
    }
    if (
      !semanticEvidenceContainsExactExcerpt(
        evidenceBytes,
        entry.excerpt,
      )
    ) {
      return fail(
        "execution_episode_decisive_evidence_not_bound_to_artifact",
      );
    }
    return buildDecisiveEvidenceExcerptV1({
      sourceRef: entry.sourceRef,
      excerpt: entry.excerpt,
      evidenceArtifact,
    });
  });
  const identities = decisiveEvidence.map((entry) => entry.evidence_id);
  if (new Set(identities).size !== identities.length) {
    return fail("execution_episode_decisive_evidence_duplicate");
  }
  return Object.freeze(decisiveEvidence);
}

function assertSemanticAuthorityReplayMatches(
  actual: SemanticEventAuthorityV1,
  expected: ExecutionEpisodeSemanticAuthorityInputV1,
  evidence: {
    kind: ExecutionEpisodeSemanticEvidenceKindV1;
    sha256: string;
    mediaType: string;
    encoding: string;
  },
): void {
  const reference = actual.evidence_refs[0];
  if (
    actual.evidence_refs.length !== 1
    || reference === undefined
    || reference.kind !== evidence.kind
    || reference.sha256 !== evidence.sha256
    || reference.media_type !== evidence.mediaType
    || reference.encoding !== evidence.encoding
    || actual.kind !== expected.kind
    || actual.actor_id !== expected.actorId
  ) {
    fail("execution_episode_semantic_operation_conflict");
  }
  if (
    expected.kind === "host_declared"
    && (
      actual.model_id !== null
      || actual.derivation_sha256 !== null
      || actual.uncertainty !== null
    )
  ) {
    fail("execution_episode_semantic_operation_conflict");
  }
  if (
    expected.kind === "model_derived"
    && (
      actual.model_id !== expected.modelId
      || actual.derivation_sha256 !== expected.derivationSha256
      || actual.uncertainty !== expected.uncertainty
    )
  ) {
    fail("execution_episode_semantic_operation_conflict");
  }
}

type CanonicalExecutionEpisodeCostInputV1 = Readonly<{
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  tokenUsageAuthority: "provider_total" | "signed_host_receipt";
  usageReceiptBytes: Buffer;
  usageReceiptSha256: string;
  usageReceiptMediaType: string;
  usageReceiptEncoding: string;
  monetaryCostMicros?: number;
  currency?: string;
  producerId: string;
}>;

function canonicalExecutionCostInput(
  value: unknown,
): CanonicalExecutionEpisodeCostInputV1 | undefined {
  if (value === undefined) return undefined;
  assertPlainExactKeys(value, EXECUTION_COST_KEYS, "cost");
  assertExactId(value.provider, "cost_provider");
  assertExactId(value.model, "cost_model");
  assertExactId(value.producerId, "cost_producer_id");
  if (
    value.tokenUsageAuthority !== "provider_total"
    && value.tokenUsageAuthority !== "signed_host_receipt"
  ) {
    return fail("execution_episode_cost_authority_invalid");
  }
  const numericValues = [
    value.inputTokens,
    value.outputTokens,
    ...(value.cachedInputTokens === undefined
      ? []
      : [value.cachedInputTokens]),
    ...(value.monetaryCostMicros === undefined
      ? []
      : [value.monetaryCostMicros]),
  ];
  if (
    numericValues.some(
      (item) =>
        typeof item !== "number"
        || !Number.isSafeInteger(item)
        || item < 0,
    )
    || (
      typeof value.cachedInputTokens === "number"
      && typeof value.inputTokens === "number"
      && value.cachedInputTokens > value.inputTokens
    )
    || ((value.monetaryCostMicros === undefined)
      !== (value.currency === undefined))
  ) {
    return fail("execution_episode_cost_values_invalid");
  }
  if (value.currency !== undefined) {
    assertExactId(value.currency, "cost_currency");
  }
  const usageReceiptBytes = canonicalBytes(
    value.usageReceiptBytes,
    "usage_receipt",
  );
  if (usageReceiptBytes.byteLength === 0) {
    return fail("execution_episode_usage_receipt_empty");
  }
  const usageReceiptMediaType =
    value.usageReceiptMediaType ?? JSON_MEDIA_TYPE;
  const usageReceiptEncoding =
    value.usageReceiptEncoding ?? UTF8_ENCODING;
  assertExactId(usageReceiptMediaType, "usage_receipt_media_type");
  assertExactId(usageReceiptEncoding, "usage_receipt_encoding");
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    ...(value.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: value.cachedInputTokens as number }),
    tokenUsageAuthority: value.tokenUsageAuthority,
    usageReceiptBytes,
    usageReceiptSha256: sha256Bytes(usageReceiptBytes),
    usageReceiptMediaType,
    usageReceiptEncoding,
    ...(value.monetaryCostMicros === undefined
      ? {}
      : { monetaryCostMicros: value.monetaryCostMicros as number }),
    ...(value.currency === undefined
      ? {}
      : { currency: value.currency }),
    producerId: value.producerId,
  });
}

function costInputForExistingReceipt(
  input: CanonicalExecutionEpisodeCostInputV1 | undefined,
  receipt: ExecutionCostReceiptV1 | undefined,
): LiteExecutionEpisodeCostInputV1 | undefined {
  if (input === undefined) {
    if (
      receipt !== undefined
      && receipt.token_usage_authority !== "unavailable"
    ) {
      return fail("execution_episode_cost_operation_conflict");
    }
    return undefined;
  }
  if (
    receipt === undefined
    || receipt.provider !== input.provider
    || receipt.model !== input.model
    || receipt.input_tokens !== input.inputTokens
    || receipt.output_tokens !== input.outputTokens
    || receipt.cached_input_tokens !== (input.cachedInputTokens ?? null)
    || receipt.token_usage_authority !== input.tokenUsageAuthority
    || receipt.monetary_cost_micros
      !== (input.monetaryCostMicros ?? null)
    || receipt.currency !== (input.currency ?? null)
    || receipt.producer_id !== input.producerId
    || receipt.raw_usage_ref === undefined
    || receipt.raw_usage_ref.sha256 !== input.usageReceiptSha256
    || receipt.raw_usage_ref.media_type !== input.usageReceiptMediaType
    || receipt.raw_usage_ref.encoding !== input.usageReceiptEncoding
  ) {
    return fail("execution_episode_cost_operation_conflict");
  }
  return {
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: input.cachedInputTokens }),
    tokenUsageAuthority: input.tokenUsageAuthority,
    rawUsageRef: receipt.raw_usage_ref,
    ...(input.monetaryCostMicros === undefined
      ? {}
      : { monetaryCostMicros: input.monetaryCostMicros }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    producerId: input.producerId,
  };
}

function deterministicId(prefix: string, material: unknown): string {
  return `${prefix}_${sha256Bytes(Buffer.from(stableStringify(material), "utf8"))}`;
}

function evidenceOperationId(parentOperationId: string, stage: string): string {
  return deterministicId("eeo", {
    contract_version: "execution_episode_evidence_operation_id_v1",
    parent_operation_id: parentOperationId,
    stage,
  });
}

function serverTimestamp(): string {
  return new Date().toISOString();
}

function canonicalSubjectRoot(subjectRoot: unknown): string {
  if (
    typeof subjectRoot !== "string"
    || subjectRoot.length === 0
    || subjectRoot.includes("\u0000")
    || subjectRoot.includes("\r")
    || subjectRoot.includes("\n")
    || Buffer.byteLength(subjectRoot, "utf8") > 4 * 1024
  ) {
    fail("execution_episode_subject_root_invalid");
  }
  try {
    return realpathSync.native(subjectRoot);
  } catch {
    return fail("execution_episode_subject_root_unavailable");
  }
}

function canonicalSubjectStateSpec(
  value: unknown,
): ExecutionEpisodeSubjectStateSpecV2 {
  return ExecutionEpisodeSubjectStateSpecV2Schema.parse(
    value ?? {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
  );
}

function subjectRootDigest(subjectRoot: string): string {
  return sha256Bytes(Buffer.from(subjectRoot, "utf8"));
}

function subjectKindForSpec(
  subjectStateSpec: ExecutionEpisodeSubjectStateSpecV2,
): DecisionEpisodeV1["subject_identity"]["state_kind"] {
  switch (subjectStateSpec.contract_version) {
    case "workspace_subject_state_spec_v2":
      return "workspace";
    case "structured_artifact_subject_state_spec_v1":
      return "artifact";
    case "sqlite_database_subject_state_spec_v1":
      return "database";
  }
}

function captureAlgorithmForSpec(
  subjectStateSpec: ExecutionEpisodeSubjectStateSpecV2,
): Readonly<{ id: string; version: string }> {
  switch (subjectStateSpec.contract_version) {
    case "workspace_subject_state_spec_v2":
      return {
        id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
        version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
      };
    case "structured_artifact_subject_state_spec_v1":
      return {
        id: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
        version: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
      };
    case "sqlite_database_subject_state_spec_v1":
      return {
        id: SQLITE_DATABASE_CAPTURE_ALGORITHM_ID,
        version: SQLITE_DATABASE_CAPTURE_ALGORITHM_VERSION,
      };
  }
}

function subjectIdentityForLocalSubject(
  subjectRoot: string,
  subjectStateSpec: ExecutionEpisodeSubjectStateSpecV2,
): ExecutionEpisodeSubjectIdentityV1 {
  const algorithm = captureAlgorithmForSpec(subjectStateSpec);
  const material = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: subjectKindForSpec(subjectStateSpec),
    canonical_root_sha256: subjectRootDigest(subjectRoot),
    capture_algorithm_id: algorithm.id,
    capture_algorithm_version: algorithm.version,
    subject_state_spec: subjectStateSpec,
    subject_state_spec_sha256:
      executionEpisodeSubjectStateSpecDigest(subjectStateSpec),
  };
  return ExecutionEpisodeSubjectIdentityV1Schema.parse({
    ...material,
    identity_sha256: executionEpisodeSubjectIdentityDigest(material),
  });
}

type LocalSubjectAdapterInputV1 =
  | WorkspaceSubjectAdapterInputV2
  | StructuredArtifactSubjectAdapterInputV1
  | SqliteDatabaseSubjectAdapterInputV1;

function localSubjectAdapterInput(
  subjectRoot: string,
  subjectStateSpec: ExecutionEpisodeSubjectStateSpecV2,
): LocalSubjectAdapterInputV1 {
  switch (subjectStateSpec.contract_version) {
    case "workspace_subject_state_spec_v2":
      return Object.freeze({
        workspace_root: subjectRoot,
        subject_state_spec: subjectStateSpec,
      });
    case "structured_artifact_subject_state_spec_v1":
      return Object.freeze({
        artifact_path: subjectRoot,
        subject_state_spec: subjectStateSpec,
      });
    case "sqlite_database_subject_state_spec_v1":
      return Object.freeze({
        database_path: subjectRoot,
        subject_state_spec: subjectStateSpec,
      });
  }
}

function assertExecutionSubjectMatchesLegacyIdentity(
  subject: ExecutionSubjectV1,
  identity: ExecutionEpisodeSubjectIdentityV1,
): void {
  if (
    subject.kind !== identity.state_kind
    || subject.identity_sha256 !== identity.identity_sha256
  ) {
    fail("execution_episode_subject_adapter_identity_mismatch");
  }
}

function assertSubjectRootMatchesEpisode(
  subjectRoot: string,
  episode: DecisionEpisodeV1,
): void {
  if (
    subjectRootDigest(subjectRoot)
      !== episode.subject_identity.canonical_root_sha256
  ) {
    fail("execution_episode_subject_identity_mismatch");
  }
}

function canonicalBytes(value: unknown, label: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    fail(`execution_episode_${label}_bytes_invalid`);
  }
  return Buffer.from(value);
}

function canonicalReasons(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 64) {
    fail("execution_episode_outcome_details_invalid");
  }
  for (const value of values) {
    if (
      typeof value !== "string"
      || value.length === 0
      || value !== value.trim()
      || Buffer.byteLength(value, "utf8") > 2048
    ) {
      fail("execution_episode_outcome_details_invalid");
    }
  }
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function currentStateSnapshot(
  replay: LiteExecutionEpisodeReplay,
): StateSnapshotV1 {
  for (let index = replay.events.length - 1; index >= 0; index -= 1) {
    const payload = replay.events[index]?.payload;
    if (
      payload?.event_kind === "action_observed"
      && payload.state_after_snapshot.snapshot_id
        === replay.current_state_snapshot_id
    ) {
      return payload.state_after_snapshot;
    }
    if (
      payload?.event_kind === "episode_closed"
      && payload.final_state_snapshot?.snapshot_id
        === replay.current_state_snapshot_id
    ) {
      return payload.final_state_snapshot;
    }
  }
  const started = replay.events[0]?.payload;
  if (
    started?.event_kind === "episode_started"
    && started.initial_state_snapshot.snapshot_id
      === replay.current_state_snapshot_id
  ) {
    return started.initial_state_snapshot;
  }
  return fail("execution_episode_current_state_snapshot_unresolvable");
}

function replayStateSnapshots(
  replay: LiteExecutionEpisodeReplay,
): StateSnapshotV1[] {
  const candidates: StateSnapshotV1[] = [];
  for (const event of replay.events) {
    const payload = event.payload;
    switch (payload.event_kind) {
      case "episode_started":
        candidates.push(payload.initial_state_snapshot);
        break;
      case "action_observed":
        candidates.push(
          payload.state_before_snapshot,
          payload.state_after_snapshot,
        );
        break;
      case "verifier_recorded":
        candidates.push(payload.verified_state_snapshot);
        break;
      case "episode_closed":
        if (payload.final_state_snapshot !== undefined) {
          candidates.push(payload.final_state_snapshot);
        }
        break;
      case "decision_committed":
      case "semantic_observation_recorded":
      case "agent_decision_recorded":
      case "progress_state_recorded":
      case "planned_action_recorded":
        break;
    }
  }
  return candidates;
}

function replayStateSnapshot(
  replay: LiteExecutionEpisodeReplay,
  snapshotId: string,
): StateSnapshotV1 | null {
  let found: StateSnapshotV1 | null = null;
  for (const candidate of replayStateSnapshots(replay)) {
    if (candidate.snapshot_id !== snapshotId) continue;
    if (
      found !== null
      && stableStringify(found) !== stableStringify(candidate)
    ) {
      return fail("execution_episode_snapshot_identity_conflict");
    }
    found = candidate;
  }
  return found;
}

function assertCaptureMatchesSnapshot(
  capture: CapturedSubjectStateV2,
  snapshot: StateSnapshotV1,
): void {
  if (
    capture.snapshot.subject.kind !== snapshot.state_kind
    || capture.snapshot.algorithm_id !== snapshot.algorithm_id
    || capture.snapshot.algorithm_version !== snapshot.algorithm_version
    || capture.snapshot.environment_sha256 !== snapshot.environment_digest
    || capture.snapshot.content_sha256 !== snapshot.content_digest
    || capture.snapshot.content_sha256 !== snapshot.artifact_ref.sha256
    || capture.artifact.declared_sha256 !== snapshot.artifact_ref.sha256
    || capture.artifact.declared_byte_length
      !== snapshot.artifact_ref.byte_length
    || capture.artifact.media_type !== snapshot.artifact_ref.media_type
    || capture.artifact.encoding !== snapshot.artifact_ref.encoding
  ) {
    fail("execution_episode_subject_state_drift");
  }
}

function captureMatchesSnapshot(
  capture: CapturedSubjectStateV2,
  snapshot: StateSnapshotV1,
): boolean {
  return (
    capture.snapshot.subject.kind === snapshot.state_kind
    && capture.snapshot.algorithm_id === snapshot.algorithm_id
    && capture.snapshot.algorithm_version === snapshot.algorithm_version
    && capture.snapshot.environment_sha256
      === snapshot.environment_digest
    && capture.snapshot.content_sha256 === snapshot.content_digest
    && capture.snapshot.content_sha256 === snapshot.artifact_ref.sha256
    && capture.artifact.declared_sha256 === snapshot.artifact_ref.sha256
    && capture.artifact.declared_byte_length
      === snapshot.artifact_ref.byte_length
    && capture.artifact.media_type === snapshot.artifact_ref.media_type
    && capture.artifact.encoding === snapshot.artifact_ref.encoding
  );
}

function replayEquivalentStateSnapshot(
  replay: LiteExecutionEpisodeReplay,
  capture: CapturedSubjectStateV2,
): StateSnapshotV1 | null {
  let found: StateSnapshotV1 | null = null;
  for (const candidate of replayStateSnapshots(replay)) {
    if (!captureMatchesSnapshot(capture, candidate)) continue;
    if (
      found !== null
      && found.snapshot_id !== candidate.snapshot_id
    ) {
      return fail(
        "execution_episode_equivalent_snapshot_identity_conflict",
      );
    }
    found = candidate;
  }
  return found;
}

function snapshotFromCapture(args: {
  episodeId: string;
  operationId: string;
  capture: CapturedSubjectStateV2;
  artifactRef: StateSnapshotV1["artifact_ref"];
  capturedAt: string;
}): StateSnapshotV1 {
  return StateSnapshotV1Schema.parse({
    contract_version: "state_snapshot_v1",
    snapshot_id: args.capture.snapshot.snapshot_id,
    algorithm_id: args.capture.snapshot.algorithm_id,
    algorithm_version: args.capture.snapshot.algorithm_version,
    state_kind: args.capture.snapshot.subject.kind,
    environment_digest: args.capture.snapshot.environment_sha256,
    content_digest: args.capture.snapshot.content_sha256,
    artifact_ref: args.artifactRef,
    captured_at: args.capturedAt,
  });
}

function stateSnapshotV2FromStored(
  snapshot: StateSnapshotV1,
  subject: ExecutionSubjectV1,
): StateSnapshotV2 {
  return {
    contract_version: "state_snapshot_v2",
    snapshot_id: snapshot.snapshot_id,
    subject,
    captured_at: snapshot.captured_at,
    algorithm_id: snapshot.algorithm_id,
    algorithm_version: snapshot.algorithm_version,
    environment_sha256: snapshot.environment_digest,
    content_ref: stateContentRef(snapshot.content_digest),
    content_sha256: snapshot.content_digest,
    content_media_type: snapshot.artifact_ref.media_type,
    content_encoding: snapshot.artifact_ref.encoding,
    capture_authority: "runtime_adapter",
    attestation_ref: null,
  };
}

function executionSubjectFromEpisode(
  episode: DecisionEpisodeV1,
): ExecutionSubjectV1 {
  return episode.execution_subject
    ?? fail("execution_episode_subject_v2_missing");
}

function stateSnapshotV2FromEpisode(
  snapshot: StateSnapshotV1,
  episode: DecisionEpisodeV1,
): StateSnapshotV2 {
  return stateSnapshotV2FromStored(
    snapshot,
    executionSubjectFromEpisode(episode),
  );
}

function findOperationEvent(
  replay: LiteExecutionEpisodeReplay,
  operationId: string,
  eventKind: ExecutionEpisodeEventEnvelopeV1["payload"]["event_kind"],
): ExecutionEpisodeEventEnvelopeV1 | null {
  return replay.events.find((event) =>
    event.operation_id === operationId
    && event.payload.event_kind === eventKind) ?? null;
}

function beginReplayResult(
  replay: LiteExecutionEpisodeReplay,
  operationId: string,
): ExecutionEpisodeBeginResultV1 | null {
  const event = findOperationEvent(replay, operationId, "episode_started");
  if (!event || event.payload.event_kind !== "episode_started") return null;
  return {
    episode: event.payload.episode,
    initial_state_snapshot: event.payload.initial_state_snapshot,
    initial_state_snapshot_v2: stateSnapshotV2FromEpisode(
      event.payload.initial_state_snapshot,
      event.payload.episode,
    ),
    event,
    replayed: true,
  };
}

function actionReplayResult(
  replay: LiteExecutionEpisodeReplay,
  operationId: string,
): ExecutionEpisodeRecordActionResultV1 | null {
  const event = findOperationEvent(replay, operationId, "action_observed");
  if (!event || event.payload.event_kind !== "action_observed") return null;
  const current = currentStateSnapshot(replay);
  return {
    action: event.payload.action,
    state_after_snapshot: event.payload.state_after_snapshot,
    state_after_snapshot_v2: stateSnapshotV2FromEpisode(
      event.payload.state_after_snapshot,
      replay.episode,
    ),
    current_state_snapshot: current,
    current_state_snapshot_v2: stateSnapshotV2FromEpisode(
      current,
      replay.episode,
    ),
    event,
    replayed: true,
  };
}

function verifierReplayResult(
  replay: LiteExecutionEpisodeReplay,
  operationId: string,
): ExecutionEpisodeRunVerifierResultV1 | null {
  const event = findOperationEvent(replay, operationId, "verifier_recorded");
  if (!event || event.payload.event_kind !== "verifier_recorded") return null;
  const current = currentStateSnapshot(replay);
  return {
    invocation: event.payload.invocation,
    outcome: event.payload.outcome,
    verified_state_snapshot: event.payload.verified_state_snapshot,
    verified_state_snapshot_v2: stateSnapshotV2FromEpisode(
      event.payload.verified_state_snapshot,
      replay.episode,
    ),
    current_state_snapshot: current,
    current_state_snapshot_v2: stateSnapshotV2FromEpisode(
      current,
      replay.episode,
    ),
    event,
    replayed: true,
  };
}

function assertVerifiedCompletion(
  replay: LiteExecutionEpisodeReplay,
  termination: ExecutionEpisodeTerminationV1,
  verifierReceiptId: string | undefined,
): void {
  if (termination !== "completed") return;
  if (verifierReceiptId === undefined) {
    return fail("execution_episode_completion_verifier_required");
  }
  let outcome: VerifierOutcomeReceiptV1 | null = null;
  for (let index = replay.events.length - 1; index >= 0; index -= 1) {
    const event = replay.events[index];
    if (
      event?.payload.event_kind === "verifier_recorded"
      && event.payload.outcome.verifier_receipt_id === verifierReceiptId
    ) {
      outcome = event.payload.outcome;
      break;
    }
  }
  if (outcome === null) {
    return fail("execution_episode_completion_verifier_missing");
  }
  if (
    outcome.verified_state_snapshot_id
    !== replay.current_state_snapshot_id
  ) {
    return fail("execution_episode_completion_verifier_stale");
  }
  if (
    outcome.status !== "passed"
    || outcome.verifier_kind === "llm_judge_diagnostic"
  ) {
    return fail("execution_episode_completion_verifier_not_passed");
  }
}

function assertVerifierReplayCurrent(
  result: ExecutionEpisodeRunVerifierResultV1,
  replay: LiteExecutionEpisodeReplay,
  capture: CapturedSubjectStateV2,
): void {
  const current = currentStateSnapshot(replay);
  if (
    result.invocation.target_state_snapshot_id !== current.snapshot_id
    || result.outcome.verified_state_snapshot_id !== current.snapshot_id
  ) {
    fail("execution_episode_verifier_target_state_stale");
  }
  assertCaptureMatchesSnapshot(capture, current);
}

function assertEpisodeOpen(replay: LiteExecutionEpisodeReplay): void {
  if (replay.closed) fail("execution_episode_already_closed");
}

function assertBeginReplayMatches(
  result: ExecutionEpisodeBeginResultV1,
  expected: {
    tenantId: string;
    publicScope: string;
    storeScope: string;
    taskEnvelopeDigest: string;
    runId: string;
    modelId: string;
    modelConfigDigest: string;
    budget: DecisionEpisodeV1["budget"];
    sourceTaskDigest: string;
    subjectIdentityDigest: string;
    requiredVerifierId: string;
    requiredVerifierDefinitionDigest: string;
  },
): void {
  const episode = result.episode;
  if (
    episode.tenant_id !== expected.tenantId
    || episode.public_scope !== expected.publicScope
    || episode.store_scope !== expected.storeScope
    || episode.task_envelope_digest !== expected.taskEnvelopeDigest
    || episode.run_id !== expected.runId
    || episode.model_id !== expected.modelId
    || episode.model_config_digest !== expected.modelConfigDigest
    || episode.source_task_ref.sha256 !== expected.sourceTaskDigest
    || episode.subject_identity.identity_sha256
      !== expected.subjectIdentityDigest
    || episode.required_verifier.verifier_id
      !== expected.requiredVerifierId
    || episode.required_verifier.verifier_definition_sha256
      !== expected.requiredVerifierDefinitionDigest
    || stableStringify(episode.budget) !== stableStringify(expected.budget)
  ) {
    fail("execution_episode_begin_operation_conflict");
  }
}

function assertActionReplayMatches(
  result: ExecutionEpisodeRecordActionResultV1,
  expected: {
    actionKind: string;
    toolName?: string;
    requestDigest: string;
    resultDigest: string;
    expectedStateBeforeSnapshotId: string;
  },
): void {
  if (
    result.action.action_kind !== expected.actionKind
    || result.action.tool_name !== expected.toolName
    || result.action.request_digest !== expected.requestDigest
    || result.action.result_digest !== expected.resultDigest
    || result.action.state_before_snapshot_id
      !== expected.expectedStateBeforeSnapshotId
  ) {
    fail("execution_episode_action_operation_conflict");
  }
}

function assertVerifierReplayMatches(
  result: ExecutionEpisodeRunVerifierResultV1,
  identity: RuntimeEpisodeVerifierDefinitionIdentityV1,
): void {
  if (
    result.invocation.verifier_kind !== identity.verifier_kind
    || result.invocation.verifier_id !== identity.verifier_id
    || result.invocation.verifier_definition_sha256
      !== identity.definition_sha256
    || result.invocation.verifier_version !== identity.verifier_version
    || result.invocation.verifier_issuer_id !== identity.verifier_issuer_id
    || result.invocation.verifier_config_digest
      !== identity.verifier_config_digest
    || result.invocation.verifier_program_digest
      !== identity.verifier_program_digest
  ) {
    fail("execution_episode_verifier_operation_conflict");
  }
}

function assertVerifierInvocationMatches(
  invocation: VerifierInvocationV1,
  identity: RuntimeEpisodeVerifierDefinitionIdentityV1,
  expected: {
    episodeId: string;
    invocationId: string;
    targetState: StateSnapshotV1;
  },
): void {
  if (
    invocation.episode_id !== expected.episodeId
    || invocation.verifier_invocation_id !== expected.invocationId
    || invocation.verifier_id !== identity.verifier_id
    || invocation.verifier_definition_sha256 !== identity.definition_sha256
    || invocation.verifier_kind !== identity.verifier_kind
    || invocation.verifier_version !== identity.verifier_version
    || invocation.verifier_issuer_id !== identity.verifier_issuer_id
    || invocation.verifier_program_digest
      !== identity.verifier_program_digest
    || invocation.verifier_config_digest
      !== identity.verifier_config_digest
    || invocation.verifier_environment_digest
      !== expected.targetState.environment_digest
    || invocation.target_state_snapshot_id
      !== expected.targetState.snapshot_id
    || invocation.target_state_snapshot_algorithm_version
      !== expected.targetState.algorithm_version
  ) {
    fail("execution_episode_verifier_invocation_conflict");
  }
}

function runnerOutputBytes(launch: RuntimeEpisodeVerifierLaunchV1): Buffer {
  return Buffer.from(
    stableStringify(runtimeEpisodeVerifierExecutionEvidence(launch)),
    "utf8",
  );
}

export function createExecutionEpisodeService(
  dependencies: ExecutionEpisodeServiceDependencies,
): ExecutionEpisodeService {
  const {
    artifactStore,
    episodeStore,
    stateStore,
    sessionLeaseStore,
    verifierRegistry,
  } = dependencies;
  const subjectAdapterRegistry = dependencies.subjectAdapterRegistry
    ?? createSubjectStateAdapterRegistry([
      createWorkspaceSubjectStateAdapter(),
      createStructuredArtifactSubjectStateAdapter(),
      createSqliteDatabaseSubjectStateAdapter(),
    ]);
  const runtimeInstanceId = dependencies.runtimeInstanceId
    ?? `eri_${randomUUID()}`;
  assertExactId(runtimeInstanceId, "runtime_instance_id");
  const transaction = artifactStore.transactionRunner();
  if (transaction !== episodeStore.transactionRunner()) {
    throw new Error(
      "execution_episode_service_requires_one_shared_transaction_runner",
    );
  }
  if (
    stateStore.transactionRunner !== null
    && transaction !== stateStore.transactionRunner
  ) {
    throw new Error(
      "execution_episode_service_requires_shared_current_state_transaction",
    );
  }
  if (
    sessionLeaseStore
    && transaction !== sessionLeaseStore.transactionRunner()
  ) {
    throw new Error(
      "execution_episode_service_requires_shared_session_lease_transaction",
    );
  }

  async function resolveLocalSubject(
    subjectRoot: string,
    episode: DecisionEpisodeV1,
  ): Promise<Readonly<{
    adapter: SubjectStateAdapter;
    subject: ExecutionSubjectV1;
    adapterInput: LocalSubjectAdapterInputV1;
  }>> {
    const adapterInput = localSubjectAdapterInput(
      subjectRoot,
      episode.subject_identity.subject_state_spec,
    );
    const identified = await (
      episode.execution_subject
        ? subjectAdapterRegistry.assertSubject(
          episode.execution_subject,
        )
        : subjectAdapterRegistry.resolveForKind(
          episode.subject_identity.state_kind,
        )
    ).identify(adapterInput);
    const subject = episode.execution_subject ?? identified;
    if (stableStringify(subject) !== stableStringify(identified)) {
      return fail("execution_episode_subject_adapter_identity_mismatch");
    }
    assertExecutionSubjectMatchesLegacyIdentity(
      subject,
      episode.subject_identity,
    );
    return Object.freeze({
      adapter: subjectAdapterRegistry.assertSubject(subject),
      subject,
      adapterInput,
    });
  }

  async function captureEpisodeSubject(
    subjectRoot: string,
    episode: DecisionEpisodeV1,
    snapshotIdentitySeed: string,
    capturedAt: string,
  ): Promise<CapturedSubjectStateV2> {
    const resolved = await resolveLocalSubject(
      subjectRoot,
      episode,
    );
    return await resolved.adapter.capture({
      subject: resolved.subject,
      adapter_input: resolved.adapterInput,
      snapshot_identity_seed: snapshotIdentitySeed,
      captured_at: capturedAt,
    });
  }

  async function synchronizeCurrentExecutionState(
    replay: LiteExecutionEpisodeReplay,
    sourceTaskBytes?: Buffer,
    explicitContinuationId?: string,
  ) {
    if (!transaction.inTransaction()) {
      throw new Error(
        "current_execution_state_projection_requires_episode_transaction",
      );
    }
    const sessionLease = explicitContinuationId
      ? null
      : await sessionLeaseStore?.getByEpisode({
        tenantId: replay.episode.tenant_id,
        scope: replay.episode.store_scope,
        episodeId: replay.episode.episode_id,
      }) ?? null;
    return await synchronizeCurrentExecutionStateHeadV2({
      replay,
      stateStore,
      artifactStore,
      ...(sourceTaskBytes ? { sourceTaskBytes } : {}),
      ...((explicitContinuationId ?? sessionLease?.binding.continuation_id)
        ? {
          continuationId:
            explicitContinuationId
            ?? sessionLease!.binding.continuation_id,
        }
        : {}),
    });
  }

  async function recordSemanticEvent<
    TSemanticEvent extends SemanticExecutionEventV1,
  >(args: Readonly<{
    input: ExecutionEpisodeSemanticInputBaseV1;
    keys: ReadonlySet<string>;
    label: string;
    eventKind:
      | "semantic_observation_recorded"
      | "agent_decision_recorded"
      | "progress_state_recorded"
      | "planned_action_recorded";
    extract: (
      event: ExecutionEpisodeEventEnvelopeV1,
    ) => TSemanticEvent | null;
    assertPayloadMatches: (event: TSemanticEvent) => void;
    build: (
      authority: SemanticEventAuthorityV1,
      decisiveEvidence: readonly DecisiveEvidenceExcerptV1[] | undefined,
      recordedAt: string,
    ) => Omit<TSemanticEvent, "semantic_event_id">;
    append: (
      value: Omit<TSemanticEvent, "semantic_event_id">,
    ) => Promise<LiteExecutionEpisodeAppendResult>;
  }>): Promise<ExecutionEpisodeRecordSemanticResultV1<TSemanticEvent>> {
    const { input } = args;
    assertPlainExactKeys(input, args.keys, args.label);
    assertExactId(input.tenantId, "tenant_id");
    assertExactId(input.storeScope, "store_scope");
    assertExactId(input.episodeId, "episode_id");
    assertExactId(input.operationId, "operation_id");
    assertExactId(
      input.expectedCurrentStateSnapshotId,
      "expected_current_state_snapshot_id",
    );
    if (!SEMANTIC_EVIDENCE_KINDS.has(input.evidenceKind)) {
      return fail("execution_episode_semantic_evidence_kind_invalid");
    }
    const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);
    const evidenceBytes = canonicalBytes(
      input.evidenceBytes,
      "semantic_evidence",
    );
    if (evidenceBytes.byteLength === 0) {
      return fail("execution_episode_semantic_evidence_empty");
    }
    const evidenceMediaType =
      input.evidenceMediaType ?? BINARY_MEDIA_TYPE;
    const evidenceEncoding = input.evidenceEncoding ?? BINARY_ENCODING;
    assertExactId(evidenceMediaType, "semantic_evidence_media_type");
    assertExactId(evidenceEncoding, "semantic_evidence_encoding");
    const evidenceSha256 = sha256Bytes(evidenceBytes);
    const authorityInput =
      canonicalSemanticAuthorityInput(input.authority);

    const assertReplayMatches = (semantic: TSemanticEvent): void => {
      if (
        semantic.episode_id !== input.episodeId
        || semantic.target_state_snapshot_id
          !== input.expectedCurrentStateSnapshotId
      ) {
        return fail("execution_episode_semantic_operation_conflict");
      }
      assertSemanticAuthorityReplayMatches(
        semantic.authority,
        authorityInput,
        {
          kind: input.evidenceKind,
          sha256: evidenceSha256,
          mediaType: evidenceMediaType,
          encoding: evidenceEncoding,
        },
      );
      const reference = semantic.authority.evidence_refs[0];
      if (!reference) {
        return fail("execution_episode_semantic_operation_conflict");
      }
      const expectedDecisiveEvidence = decisiveEvidenceForArtifact(
        input.decisiveEvidence,
        evidenceBytes,
        reference,
      );
      if (
        stableStringify(semantic.decisive_evidence ?? [])
          !== stableStringify(expectedDecisiveEvidence ?? [])
      ) {
        return fail("execution_episode_semantic_operation_conflict");
      }
      args.assertPayloadMatches(semantic);
    };

    const replayResult = (
      replay: LiteExecutionEpisodeReplay,
    ): ExecutionEpisodeRecordSemanticResultV1<TSemanticEvent> | null => {
      const event = findOperationEvent(
        replay,
        input.operationId,
        args.eventKind,
      );
      if (!event) return null;
      const semantic = args.extract(event);
      if (!semantic) {
        return fail("execution_episode_semantic_operation_conflict");
      }
      assertReplayMatches(semantic);
      const current = currentStateSnapshot(replay);
      return {
        semantic_event: semantic,
        current_state_snapshot: current,
        current_state_snapshot_v2: stateSnapshotV2FromEpisode(
          current,
          replay.episode,
        ),
        event,
        replayed: true,
      };
    };

    const existingEpisode = await episodeStore.getEpisode({
      tenantId: input.tenantId,
      scope: input.storeScope,
      episodeId: input.episodeId,
    });
    if (!existingEpisode) return fail("execution_episode_missing");
    assertSubjectRootMatchesEpisode(
      workspaceRoot,
      existingEpisode.episode,
    );
    const existing = replayResult(existingEpisode);
    if (existing) return existing;
    assertEpisodeOpen(existingEpisode);
    if (
      existingEpisode.current_state_snapshot_id
      !== input.expectedCurrentStateSnapshotId
    ) {
      return fail("execution_episode_semantic_event_target_state_stale");
    }

    return await transaction.run(async () => {
      const replay = await episodeStore.replayEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
      });
      const retried = replayResult(replay);
      if (retried) return retried;
      assertEpisodeOpen(replay);
      const current = currentStateSnapshot(replay);
      if (
        current.snapshot_id !== input.expectedCurrentStateSnapshotId
      ) {
        return fail("execution_episode_semantic_event_target_state_stale");
      }
      assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
      assertCaptureMatchesSnapshot(
        await captureEpisodeSubject(
          workspaceRoot,
          replay.episode,
          current.snapshot_id,
          serverTimestamp(),
        ),
        current,
      );
      const evidenceRef =
        await materializeRuntimeOwnedEvidenceInCurrentTransaction(
          artifactStore,
          {
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
            operationId: evidenceOperationId(
              input.operationId,
              `${args.label}-evidence`,
            ),
            kind: input.evidenceKind,
            bytes: evidenceBytes,
            mediaType: evidenceMediaType,
            encoding: evidenceEncoding,
            redactionPolicy: REDACTION_POLICY,
            retentionPolicy: RETENTION_POLICY,
          },
        );
      const recordedAt = serverTimestamp();
      const decisiveEvidence = decisiveEvidenceForArtifact(
        input.decisiveEvidence,
        evidenceBytes,
        evidenceRef,
      );
      const semanticWithoutId = args.build(
        semanticAuthorityWithEvidence(authorityInput, evidenceRef),
        decisiveEvidence,
        recordedAt,
      );
      const appended = await args.append(semanticWithoutId);
      const semantic = args.extract(appended.event);
      if (!semantic) {
        throw new Error("execution_episode_semantic_append_projection_invalid");
      }
      await synchronizeCurrentExecutionState(
        await episodeStore.replayEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        }),
      );
      return {
        semantic_event: semantic,
        current_state_snapshot: current,
        current_state_snapshot_v2: stateSnapshotV2FromEpisode(
          current,
          replay.episode,
        ),
        event: appended.event,
        replayed: appended.replayed,
      };
    });
  }

  async function terminalizeInterruptedAttempt(
    open: RuntimeEpisodeVerifierOpenLaunchAttemptV1,
  ): Promise<ExecutionEpisodeRunVerifierResultV1> {
    const lastEvent = open.events.at(-1);
    if (!lastEvent) {
      throw new Error(
        "execution_verifier_recovery_launch_event_missing",
      );
    }
    const ownerAborted =
      open.attempt.owner_instance_id === runtimeInstanceId;
    const terminalReason = ownerAborted
      ? "runtime_episode_verifier_owner_aborted_before_result"
      : open.events.some((event) =>
        event.payload.event_kind === "spawn_observed")
        ? "runtime_episode_verifier_recovered_process_interrupted"
        : "runtime_episode_verifier_recovered_launch_ambiguous";
    const recoveredAt = new Date(Math.max(
      Date.now(),
      Date.parse(lastEvent.recorded_at),
    )).toISOString();
    const evidence:
      RuntimeEpisodeVerifierInterruptedLaunchEvidenceV1 =
        Object.freeze({
          contract_version:
            "runtime_episode_verifier_interrupted_launch_evidence_v1",
          attempt: open.attempt,
          observed_events: open.events,
          terminal_reason: terminalReason,
          recovery_instance_id: runtimeInstanceId,
          recovery_process_id: process.pid,
          recovered_at: recoveredAt,
        });
    const bytes = Buffer.from(stableStringify(evidence), "utf8");
    const recorded = await transaction.run(async () => {
      const outputRef =
        await materializeRuntimeOwnedEvidenceInCurrentTransaction(
          artifactStore,
          {
            tenantId: open.attempt.tenant_id,
            scope: open.attempt.scope,
            episodeId: open.attempt.episode_id,
            operationId: evidenceOperationId(
              open.attempt.outcome_operation_id,
              `verifier-interrupted-${open.attempt.attempt_ordinal}`,
            ),
            kind: "verifier_output",
            bytes,
            mediaType: JSON_MEDIA_TYPE,
            encoding: UTF8_ENCODING,
            redactionPolicy: REDACTION_POLICY,
            retentionPolicy: RETENTION_POLICY,
          },
        );
      const interrupted = await episodeStore.recordInterruptedVerifierOutcome({
        tenantId: open.attempt.tenant_id,
        scope: open.attempt.scope,
        episodeId: open.attempt.episode_id,
        launchAttemptId: open.attempt.launch_attempt_id,
        recoveryInstanceId: runtimeInstanceId,
        recoveryProcessId: process.pid,
        recoveredAt,
        verifierOutputRef: outputRef,
        interruptedEvidence: evidence,
      });
      await synchronizeCurrentExecutionState(
        await episodeStore.replayEpisode({
          tenantId: open.attempt.tenant_id,
          scope: open.attempt.scope,
          episodeId: open.attempt.episode_id,
        }),
      );
      return interrupted;
    });
    const replay = await episodeStore.replayEpisode({
      tenantId: open.attempt.tenant_id,
      scope: open.attempt.scope,
      episodeId: open.attempt.episode_id,
    });
    return Object.freeze({
      invocation: recorded.invocation,
      outcome: recorded.outcome,
      verified_state_snapshot: recorded.verifiedStateSnapshot,
      verified_state_snapshot_v2: stateSnapshotV2FromEpisode(
        recorded.verifiedStateSnapshot,
        replay.episode,
      ),
      current_state_snapshot: recorded.verifiedStateSnapshot,
      current_state_snapshot_v2: stateSnapshotV2FromEpisode(
        recorded.verifiedStateSnapshot,
        replay.episode,
      ),
      event: recorded.append.event,
      replayed: recorded.append.replayed,
    });
  }

  const service: ExecutionEpisodeService = Object.freeze({
    async recoverInterruptedVerifierLaunches() {
      const openAttempts =
        await episodeStore.listOpenVerifierLaunchAttempts();
      let recoveredCount = 0;
      let cleanupFailureCount = 0;
      for (const open of openAttempts) {
        // This Runtime is intentionally single-process. A different durable
        // Runtime instance never inherits ownership merely because its PID is
        // alive or has been reused after a reboot.
        if (open.attempt.owner_instance_id === runtimeInstanceId) {
          continue;
        }
        await terminalizeInterruptedAttempt(open);
        recoveredCount += 1;
        try {
          cleanupInterruptedVerifierSubjectMaterialization({
            materializedSubjectRoot:
              open.attempt.materialized_subject_root,
            materializedScratchRoot:
              open.attempt.materialized_scratch_root,
          });
        } catch {
          cleanupFailureCount += 1;
        }
      }
      return Object.freeze({
        recovered_count: recoveredCount,
        cleanup_failure_count: cleanupFailureCount,
      });
    },

    async begin(input) {
      assertPlainExactKeys(input, BEGIN_KEYS, "begin");
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.publicScope, "public_scope");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.operationId, "operation_id");
      assertExactId(input.runId, "run_id");
      assertExactId(input.modelId, "model_id");
      assertExactId(input.requiredVerifierId, "required_verifier_id");
      if (input.continuationId !== undefined) {
        assertExactId(input.continuationId, "continuation_id");
      }
      const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);
      const subjectStateSpec = canonicalSubjectStateSpec(
        input.subjectStateSpec,
      );
      const subjectIdentity = subjectIdentityForLocalSubject(
        workspaceRoot,
        subjectStateSpec,
      );
      const subjectAdapter = subjectAdapterRegistry.resolveForKind(
        subjectIdentity.state_kind,
      );
      const executionSubject = await subjectAdapter.identify(
        localSubjectAdapterInput(workspaceRoot, subjectStateSpec),
      );
      assertExecutionSubjectMatchesLegacyIdentity(
        executionSubject,
        subjectIdentity,
      );
      const verifierEntry = verifierRegistry.resolve(input.requiredVerifierId);
      if (!verifierEntry) {
        return fail("execution_episode_required_verifier_unknown");
      }
      if (verifierEntry.identity.reward_role !== "primary") {
        return fail("execution_episode_primary_verifier_required");
      }
      const requiredVerifier = {
        contract_version: "execution_episode_required_verifier_v1" as const,
        verifier_id: verifierEntry.identity.verifier_id,
        verifier_definition_sha256:
          verifierEntry.identity.definition_sha256,
      };
      const taskEnvelope = HostTaskEnvelopeV1Schema.parse(input.taskEnvelope);
      const taskEnvelopeBytes = canonicalJsonBytes(
        taskEnvelope,
        "task_envelope",
      );
      const taskDigest = hostTaskEnvelopeDigest(taskEnvelope);
      if (taskDigest !== sha256Bytes(taskEnvelopeBytes)) {
        return fail("execution_episode_task_envelope_digest_unstable");
      }
      const sourceTaskBytes = canonicalBytes(
        input.sourceTaskBytes,
        "source_task",
      );
      const sourceTaskDigest = sha256Bytes(sourceTaskBytes);
      if (sourceTaskDigest !== taskEnvelope.source_task_sha256) {
        return fail("execution_episode_source_task_digest_mismatch");
      }
      const modelConfigBytes = canonicalJsonBytes(
        input.modelConfig,
        "model_config",
      );
      const modelConfigDigest = sha256Bytes(modelConfigBytes);
      const episodeId = deterministicId("eep", {
        contract_version: "execution_episode_identity_v1",
        tenant_id: input.tenantId,
        public_scope: input.publicScope,
        store_scope: input.storeScope,
        operation_id: input.operationId,
        task_envelope_digest: taskDigest,
        run_id: input.runId,
        model_id: input.modelId,
        model_config_digest: modelConfigDigest,
        budget: input.budget,
        source_task_sha256: sourceTaskDigest,
        subject_identity_sha256: subjectIdentity.identity_sha256,
        required_verifier_id: requiredVerifier.verifier_id,
        required_verifier_definition_sha256:
          requiredVerifier.verifier_definition_sha256,
      });

      const existing = await episodeStore.getEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId,
      });
      if (existing) {
        const replay = beginReplayResult(existing, input.operationId);
        if (!replay) {
          return fail("execution_episode_begin_operation_conflict");
        }
        assertBeginReplayMatches(replay, {
          tenantId: input.tenantId,
          publicScope: input.publicScope,
          storeScope: input.storeScope,
          taskEnvelopeDigest: taskDigest,
          runId: input.runId,
          modelId: input.modelId,
          modelConfigDigest,
          budget: input.budget,
          sourceTaskDigest,
          subjectIdentityDigest: subjectIdentity.identity_sha256,
          requiredVerifierId: requiredVerifier.verifier_id,
          requiredVerifierDefinitionDigest:
            requiredVerifier.verifier_definition_sha256,
        });
        return replay;
      }

      return await transaction.run(async () => {
        const reopened = await episodeStore.getEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId,
        });
        if (reopened) {
          const replay = beginReplayResult(reopened, input.operationId);
          if (!replay) {
            return fail("execution_episode_begin_operation_conflict");
          }
          assertBeginReplayMatches(replay, {
            tenantId: input.tenantId,
            publicScope: input.publicScope,
            storeScope: input.storeScope,
            taskEnvelopeDigest: taskDigest,
            runId: input.runId,
            modelId: input.modelId,
            modelConfigDigest,
            budget: input.budget,
            sourceTaskDigest,
            subjectIdentityDigest: subjectIdentity.identity_sha256,
            requiredVerifierId: requiredVerifier.verifier_id,
            requiredVerifierDefinitionDigest:
              requiredVerifier.verifier_definition_sha256,
          });
          return replay;
        }

        const openedAt = serverTimestamp();
        const capture = await subjectAdapter.capture({
          subject: executionSubject,
          adapter_input:
            localSubjectAdapterInput(workspaceRoot, subjectStateSpec),
          snapshot_identity_seed: input.operationId,
          captured_at: openedAt,
        });
        if (
          capture.snapshot.algorithm_id
            !== subjectIdentity.capture_algorithm_id
          || capture.snapshot.algorithm_version
            !== subjectIdentity.capture_algorithm_version
        ) {
          return fail("execution_episode_subject_capture_identity_mismatch");
        }
        const taskEnvelopeRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "task-envelope",
              ),
              kind: "manifest",
              bytes: taskEnvelopeBytes,
              mediaType: JSON_MEDIA_TYPE,
              encoding: UTF8_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const sourceTaskRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "source-task",
              ),
              kind: "prompt",
              bytes: sourceTaskBytes,
              mediaType: BINARY_MEDIA_TYPE,
              encoding: BINARY_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const modelConfigRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "model-config",
              ),
              kind: "manifest",
              bytes: modelConfigBytes,
              mediaType: JSON_MEDIA_TYPE,
              encoding: UTF8_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const stateRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "initial-state",
              ),
              kind: "state_snapshot",
              bytes: capture.artifact.bytes,
              mediaType: capture.artifact.media_type,
              encoding: capture.artifact.encoding,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const initialStateSnapshot = snapshotFromCapture({
          episodeId,
          operationId: input.operationId,
          capture,
          artifactRef: stateRef,
          capturedAt: openedAt,
        });
        const taskCluster = deriveExecutionTaskClusterV1(taskEnvelope);
        const taskManifest = ExecutionEpisodeTaskManifestV1Schema.parse({
          contract_version: "execution_episode_task_manifest_v1",
          host_task_envelope: taskEnvelope,
          source_task_ref: sourceTaskRef,
          model: {
            model_id: input.modelId,
            model_config_digest: modelConfigDigest,
            model_config_ref: modelConfigRef,
          },
          subject: {
            state_kind: subjectIdentity.state_kind,
            capture_algorithm_id: capture.snapshot.algorithm_id,
            capture_algorithm_version:
              capture.snapshot.algorithm_version,
            subject_state_spec: subjectStateSpec,
            expected_initial_content_digest:
              capture.snapshot.content_sha256,
            execution_subject: executionSubject,
          },
          required_verifier: requiredVerifier,
        });
        const taskManifestBytes = canonicalJsonBytes(
          taskManifest,
          "task_manifest",
        );
        const taskManifestDigest = executionEpisodeTaskManifestDigest(
          taskManifest,
        );
        if (taskManifestDigest !== sha256Bytes(taskManifestBytes)) {
          return fail("execution_episode_task_manifest_digest_unstable");
        }
        const taskManifestRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "task-manifest",
              ),
              kind: "manifest",
              bytes: taskManifestBytes,
              mediaType: JSON_MEDIA_TYPE,
              encoding: UTF8_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const episode = DecisionEpisodeV1Schema.parse({
          contract_version: "decision_episode_v1",
          episode_id: episodeId,
          tenant_id: input.tenantId,
          public_scope: input.publicScope,
          store_scope: input.storeScope,
          task_id: taskEnvelope.host_task_id,
          task_envelope_digest: taskDigest,
          task_envelope_ref: taskEnvelopeRef,
          task_manifest_digest: taskManifestDigest,
          task_manifest_ref: taskManifestRef,
          source_task_ref: sourceTaskRef,
          task_cluster_id: taskCluster.task_cluster_id,
          task_cluster_policy_version:
            taskCluster.task_cluster_policy_version,
          run_id: input.runId,
          model_id: input.modelId,
          model_config_digest: modelConfigDigest,
          model_config_ref: modelConfigRef,
          environment_digest: capture.snapshot.environment_sha256,
          subject_identity: subjectIdentity,
          execution_subject: executionSubject,
          required_verifier: requiredVerifier,
          initial_state_snapshot_id: initialStateSnapshot.snapshot_id,
          budget: input.budget,
          opened_at: openedAt,
        });
        const appended = await episodeStore.beginEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          operationId: input.operationId,
          episode,
          initialStateSnapshot,
        });
        await synchronizeCurrentExecutionState(
          await episodeStore.replayEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId,
          }),
          sourceTaskBytes,
          input.continuationId,
        );
        return {
          episode,
          initial_state_snapshot: initialStateSnapshot,
          initial_state_snapshot_v2: stateSnapshotV2FromStored(
            initialStateSnapshot,
            executionSubject,
          ),
          event: appended.event,
          replayed: appended.replayed,
        };
      });
    },

    async resume(input) {
      assertPlainExactKeys(input, RESUME_KEYS, "resume");
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.episodeId, "episode_id");
      if (input.continuationId !== undefined) {
        assertExactId(input.continuationId, "continuation_id");
      }
      const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);
      return await transaction.run(async () => {
        const replay = await episodeStore.replayEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        });
        assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
        const current = currentStateSnapshot(replay);
        assertCaptureMatchesSnapshot(
          await captureEpisodeSubject(
            workspaceRoot,
            replay.episode,
            current.snapshot_id,
            serverTimestamp(),
          ),
          current,
        );
        await synchronizeCurrentExecutionState(
          replay,
          undefined,
          input.continuationId,
        );
        return {
          replay,
          current_state_snapshot: current,
          current_state_snapshot_v2: stateSnapshotV2FromEpisode(
            current,
            replay.episode,
          ),
        };
      });
    },

    async restoreSnapshot(input) {
      assertPlainExactKeys(
        input,
        RESTORE_SNAPSHOT_KEYS,
        "restore_snapshot",
      );
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.episodeId, "episode_id");
      assertExactId(input.operationId, "operation_id");
      assertExactId(
        input.expectedCurrentStateSnapshotId,
        "expected_current_state_snapshot_id",
      );
      assertExactId(
        input.targetSnapshotId,
        "target_snapshot_id",
      );
      const subjectRoot = canonicalSubjectRoot(input.workspaceRoot);
      const replay = await episodeStore.replayEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
      });
      assertEpisodeOpen(replay);
      assertSubjectRootMatchesEpisode(subjectRoot, replay.episode);
      const current = currentStateSnapshot(replay);
      const target = replayStateSnapshot(
        replay,
        input.targetSnapshotId,
      );
      if (!target) {
        return fail(
          "execution_episode_snapshot_restore_target_missing",
        );
      }
      const requestBytes = Buffer.from(stableStringify({
        contract_version: "execution_snapshot_restore_request_v1",
        episode_id: input.episodeId,
        expected_current_state_snapshot_id:
          input.expectedCurrentStateSnapshotId,
        target_snapshot_id: target.snapshot_id,
        target_content_sha256: target.content_digest,
        target_environment_sha256: target.environment_digest,
      }), "utf8");
      const resultBytes = Buffer.from(stableStringify({
        contract_version: "execution_snapshot_restore_result_v1",
        episode_id: input.episodeId,
        target_snapshot_id: target.snapshot_id,
        restored_content_sha256: target.content_digest,
        restored_environment_sha256: target.environment_digest,
        restore_authority: "runtime_subject_adapter",
      }), "utf8");
      const existing = actionReplayResult(
        replay,
        input.operationId,
      );
      if (existing) {
        const replayed = await service.recordAction({
          tenantId: input.tenantId,
          storeScope: input.storeScope,
          episodeId: input.episodeId,
          operationId: input.operationId,
          workspaceRoot: subjectRoot,
          expectedCurrentStateSnapshotId:
            input.expectedCurrentStateSnapshotId,
          actionKind: "state_snapshot_restore",
          toolName: "aionis_runtime_subject_adapter",
          requestBytes,
          resultBytes,
        });
        return {
          ...replayed,
          recovery_target_snapshot: target,
          recovery_target_snapshot_v2:
            stateSnapshotV2FromEpisode(target, replay.episode),
          restored_exact: true,
        };
      }
      if (
        current.snapshot_id
          !== input.expectedCurrentStateSnapshotId
      ) {
        return fail(
          "execution_episode_snapshot_restore_target_state_stale",
        );
      }
      const resolved = await resolveLocalSubject(
        subjectRoot,
        replay.episode,
      );
      const currentArtifactBytes =
        await artifactStore.readArtifactBytes({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
          artifactId: current.artifact_ref.artifact_id,
        });
      const targetArtifactBytes =
        await artifactStore.readArtifactBytes({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
          artifactId: target.artifact_ref.artifact_id,
        });
      const currentV2 = stateSnapshotV2FromStored(
        current,
        resolved.subject,
      );
      const targetV2 = stateSnapshotV2FromStored(
        target,
        resolved.subject,
      );
      const live = await resolved.adapter.capture({
        subject: resolved.subject,
        adapter_input: resolved.adapterInput,
        snapshot_identity_seed:
          `restore-preflight:${input.operationId}`,
        captured_at: serverTimestamp(),
      });
      const liveMatchesCurrent = captureMatchesSnapshot(live, current);
      const liveMatchesTarget = captureMatchesSnapshot(live, target);
      if (!liveMatchesCurrent && !liveMatchesTarget) {
        return fail("execution_episode_subject_state_drift");
      }
      let restoreApplied = false;
      try {
        if (!liveMatchesTarget) {
          await resolved.adapter.restoreSnapshot({
            subject: resolved.subject,
            adapter_input: resolved.adapterInput,
            snapshot: targetV2,
            snapshot_artifact_bytes: targetArtifactBytes,
          });
          restoreApplied = true;
        }
        const restoredCapture = await resolved.adapter.capture({
          subject: resolved.subject,
          adapter_input: resolved.adapterInput,
          snapshot_identity_seed:
            `restore-confirm:${input.operationId}`,
          captured_at: serverTimestamp(),
        });
        if (!captureMatchesSnapshot(restoredCapture, target)) {
          return fail(
            "execution_episode_snapshot_restore_verification_failed",
          );
        }
        const recorded = await service.recordAction({
          tenantId: input.tenantId,
          storeScope: input.storeScope,
          episodeId: input.episodeId,
          operationId: input.operationId,
          workspaceRoot: subjectRoot,
          expectedCurrentStateSnapshotId:
            input.expectedCurrentStateSnapshotId,
          actionKind: "state_snapshot_restore",
          toolName: "aionis_runtime_subject_adapter",
          requestBytes,
          resultBytes,
        });
        if (
          recorded.state_after_snapshot.content_digest
            !== target.content_digest
          || recorded.state_after_snapshot.environment_digest
            !== target.environment_digest
        ) {
          return fail(
            "execution_episode_snapshot_restore_record_mismatch",
          );
        }
        return {
          ...recorded,
          recovery_target_snapshot: target,
          recovery_target_snapshot_v2: targetV2,
          restored_exact: true,
        };
      } catch (error) {
        const afterFailure = await episodeStore.getEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        });
        const recorded = afterFailure
          ? actionReplayResult(afterFailure, input.operationId)
          : null;
        if (!recorded && (restoreApplied || liveMatchesTarget)) {
          try {
            await resolved.adapter.restoreSnapshot({
              subject: resolved.subject,
              adapter_input: resolved.adapterInput,
              snapshot: currentV2,
              snapshot_artifact_bytes: currentArtifactBytes,
            });
          } catch {
            return fail(
              "execution_episode_snapshot_restore_rollback_failed",
            );
          }
        }
        throw error;
      }
    },

    async recordAction(input) {
      assertPlainExactKeys(input, ACTION_KEYS, "action");
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.episodeId, "episode_id");
      assertExactId(input.operationId, "operation_id");
      assertExactId(
        input.expectedCurrentStateSnapshotId,
        "expected_current_state_snapshot_id",
      );
      assertExactId(input.actionKind, "action_kind");
      if (input.toolName !== undefined) {
        assertExactId(input.toolName, "tool_name");
      }
      const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);
      const requestBytes = canonicalBytes(input.requestBytes, "request");
      const resultBytes = canonicalBytes(input.resultBytes, "result");
      const requestDigest = sha256Bytes(requestBytes);
      const resultDigest = sha256Bytes(resultBytes);
      const existingEpisode = await episodeStore.getEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
      });
      if (!existingEpisode) return fail("execution_episode_missing");
      assertSubjectRootMatchesEpisode(
        workspaceRoot,
        existingEpisode.episode,
      );
      const existing = actionReplayResult(
        existingEpisode,
        input.operationId,
      );
      if (existing) {
        assertActionReplayMatches(existing, {
          actionKind: input.actionKind,
          toolName: input.toolName,
          requestDigest,
          resultDigest,
          expectedStateBeforeSnapshotId:
            input.expectedCurrentStateSnapshotId,
        });
        return existing;
      }
      assertEpisodeOpen(existingEpisode);
      if (
        existingEpisode.current_state_snapshot_id
        !== input.expectedCurrentStateSnapshotId
      ) {
        return fail("execution_episode_action_target_state_stale");
      }

      return await transaction.run(async () => {
        const replay = await episodeStore.replayEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        });
        const retried = actionReplayResult(replay, input.operationId);
        if (retried) {
          assertActionReplayMatches(retried, {
            actionKind: input.actionKind,
            toolName: input.toolName,
            requestDigest,
            resultDigest,
            expectedStateBeforeSnapshotId:
              input.expectedCurrentStateSnapshotId,
          });
          return retried;
        }
        assertEpisodeOpen(replay);
        const stateBefore = currentStateSnapshot(replay);
        if (
          stateBefore.snapshot_id
          !== input.expectedCurrentStateSnapshotId
        ) {
          return fail("execution_episode_action_target_state_stale");
        }
        assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
        const occurredAt = serverTimestamp();
        const capture = await captureEpisodeSubject(
          workspaceRoot,
          replay.episode,
          input.operationId,
          occurredAt,
        );
        const mutation = (
          capture.snapshot.content_sha256 !== stateBefore.content_digest
          || capture.snapshot.environment_sha256
            !== stateBefore.environment_digest
          || capture.snapshot.algorithm_id !== stateBefore.algorithm_id
          || capture.snapshot.algorithm_version
            !== stateBefore.algorithm_version
        );
        const requestRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "request",
              ),
              kind: "tool_request",
              bytes: requestBytes,
              mediaType: BINARY_MEDIA_TYPE,
              encoding: BINARY_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const resultRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "result",
              ),
              kind: "tool_result",
              bytes: resultBytes,
              mediaType: BINARY_MEDIA_TYPE,
              encoding: BINARY_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        let stateAfter = stateBefore;
        let stateDelta: StateDeltaV1 | undefined;
        let stateDeltaRef: EvidenceArtifactRefV1 | undefined;
        if (mutation) {
          const existingState =
            replayStateSnapshot(
              replay,
              capture.snapshot.snapshot_id,
            )
            ?? replayEquivalentStateSnapshot(replay, capture);
          if (existingState !== null) {
            assertCaptureMatchesSnapshot(capture, existingState);
            stateAfter = existingState;
          } else {
            const stateRef =
              await materializeRuntimeOwnedEvidenceInCurrentTransaction(
                artifactStore,
                {
                  tenantId: input.tenantId,
                  scope: input.storeScope,
                  episodeId: input.episodeId,
                  operationId: evidenceOperationId(
                    input.operationId,
                    "state-after",
                  ),
                  kind: "state_snapshot",
                  bytes: capture.artifact.bytes,
                  mediaType: capture.artifact.media_type,
                  encoding: capture.artifact.encoding,
                  redactionPolicy: REDACTION_POLICY,
                  retentionPolicy: RETENTION_POLICY,
                },
              );
            stateAfter = snapshotFromCapture({
              episodeId: input.episodeId,
              operationId: input.operationId,
              capture,
              artifactRef: stateRef,
              capturedAt: occurredAt,
            });
          }
          const resolvedSubject = await resolveLocalSubject(
            workspaceRoot,
            replay.episode,
          );
          const beforeBytes = await artifactStore.readArtifactBytes({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
            artifactId: stateBefore.artifact_ref.artifact_id,
          });
          const beforeCapture: CapturedSubjectStateV2 = Object.freeze({
            snapshot: stateSnapshotV2FromStored(
              stateBefore,
              resolvedSubject.subject,
            ),
            artifact: Object.freeze({
              bytes: beforeBytes,
              declared_sha256: stateBefore.artifact_ref.sha256,
              declared_byte_length: stateBefore.artifact_ref.byte_length,
              media_type: stateBefore.artifact_ref.media_type,
              encoding: stateBefore.artifact_ref.encoding,
            }),
          });
          assertCaptureMatchesSnapshot(capture, stateAfter);
          const afterCapture: CapturedSubjectStateV2 = Object.freeze({
            snapshot: stateSnapshotV2FromStored(
              stateAfter,
              resolvedSubject.subject,
            ),
            artifact: capture.artifact,
          });
          const deltaCapture = await resolvedSubject.adapter.diff({
            before: beforeCapture,
            after: afterCapture,
          });
          stateDeltaRef =
            await materializeRuntimeOwnedEvidenceInCurrentTransaction(
              artifactStore,
              {
                tenantId: input.tenantId,
                scope: input.storeScope,
                episodeId: input.episodeId,
                operationId: evidenceOperationId(
                  input.operationId,
                  "state-delta",
                ),
                kind: "workspace_diff",
                bytes: deltaCapture.artifact.bytes,
                mediaType: deltaCapture.artifact.media_type,
                encoding: deltaCapture.artifact.encoding,
                redactionPolicy: REDACTION_POLICY,
                retentionPolicy: RETENTION_POLICY,
              },
            );
          stateDelta = deltaCapture.delta;
        }
        const sequence = replay.events.reduce(
          (count, event) =>
            count + (event.payload.event_kind === "action_observed" ? 1 : 0),
          0,
        );
        const action = ActionMutationReceiptV1Schema.parse({
          contract_version: "action_mutation_receipt_v1",
          action_id: deterministicId("ear", {
            contract_version: "execution_action_identity_v1",
            episode_id: input.episodeId,
            operation_id: input.operationId,
          }),
          episode_id: input.episodeId,
          sequence,
          action_kind: input.actionKind,
          ...(input.toolName ? { tool_name: input.toolName } : {}),
          request_digest: requestRef.sha256,
          request_ref: requestRef,
          result_digest: resultRef.sha256,
          result_ref: resultRef,
          state_before_snapshot_id: stateBefore.snapshot_id,
          state_after_snapshot_id: stateAfter.snapshot_id,
          ...(stateDelta && stateDeltaRef
            ? {
              state_delta: stateDelta,
              state_delta_ref: stateDeltaRef,
            }
            : {}),
          mutation,
          occurred_at: occurredAt,
        });
        const appended = await episodeStore.appendAction({
          tenantId: input.tenantId,
          scope: input.storeScope,
          operationId: input.operationId,
          action,
          stateBeforeSnapshot: stateBefore,
          stateAfterSnapshot: stateAfter,
        });
        await synchronizeCurrentExecutionState(
          await episodeStore.replayEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
          }),
        );
        return {
          action,
          state_after_snapshot: stateAfter,
          state_after_snapshot_v2: stateSnapshotV2FromEpisode(
            stateAfter,
            replay.episode,
          ),
          current_state_snapshot: stateAfter,
          current_state_snapshot_v2: stateSnapshotV2FromEpisode(
            stateAfter,
            replay.episode,
          ),
          event: appended.event,
          replayed: appended.replayed,
        };
      });
    },

    async recordObservation(input) {
      return await recordSemanticEvent({
        input,
        keys: SEMANTIC_OBSERVATION_KEYS,
        label: "semantic_observation",
        eventKind: "semantic_observation_recorded",
        extract: (event) =>
          event.payload.event_kind === "semantic_observation_recorded"
            ? event.payload.observation
            : null,
        assertPayloadMatches: (observation) => {
          if (observation.observation !== input.observation) {
            fail("execution_episode_semantic_operation_conflict");
          }
        },
        build: (authority, decisiveEvidence, recordedAt) => ({
          episode_id: input.episodeId,
          observation: input.observation,
          target_state_snapshot_id:
            input.expectedCurrentStateSnapshotId,
          authority,
          ...(decisiveEvidence && decisiveEvidence.length > 0
            ? { decisive_evidence: [...decisiveEvidence] }
            : {}),
          recorded_at: recordedAt,
        }),
        append: async (observation) =>
          await episodeStore.appendSemanticObservation({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            observation,
          }),
      });
    },

    async recordDecision(input) {
      return await recordSemanticEvent({
        input,
        keys: AGENT_DECISION_KEYS,
        label: "agent_decision",
        eventKind: "agent_decision_recorded",
        extract: (event) =>
          event.payload.event_kind === "agent_decision_recorded"
            ? event.payload.decision
            : null,
        assertPayloadMatches: (decision) => {
          if (
            decision.decision !== input.decision
            || stableStringify(decision.reasons)
              !== stableStringify(input.reasons)
            || stableStringify(decision.alternatives_rejected)
              !== stableStringify(input.alternativesRejected)
          ) {
            fail("execution_episode_semantic_operation_conflict");
          }
        },
        build: (authority, decisiveEvidence, recordedAt) => ({
          episode_id: input.episodeId,
          decision: input.decision,
          reasons: [...input.reasons],
          alternatives_rejected: [...input.alternativesRejected],
          target_state_snapshot_id:
            input.expectedCurrentStateSnapshotId,
          authority,
          ...(decisiveEvidence && decisiveEvidence.length > 0
            ? { decisive_evidence: [...decisiveEvidence] }
            : {}),
          recorded_at: recordedAt,
        }),
        append: async (decision) =>
          await episodeStore.appendAgentDecision({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            decision,
          }),
      });
    },

    async recordProgress(input) {
      return await recordSemanticEvent({
        input,
        keys: PROGRESS_STATE_KEYS,
        label: "progress_state",
        eventKind: "progress_state_recorded",
        extract: (event) =>
          event.payload.event_kind === "progress_state_recorded"
            ? event.payload.progress
            : null,
        assertPayloadMatches: (progress) => {
          if (
            progress.item_id !== input.itemId
            || progress.state !== input.state
            || progress.statement !== input.statement
          ) {
            fail("execution_episode_semantic_operation_conflict");
          }
        },
        build: (authority, decisiveEvidence, recordedAt) => ({
          episode_id: input.episodeId,
          item_id: input.itemId,
          state: input.state,
          statement: input.statement,
          target_state_snapshot_id:
            input.expectedCurrentStateSnapshotId,
          authority,
          ...(decisiveEvidence && decisiveEvidence.length > 0
            ? { decisive_evidence: [...decisiveEvidence] }
            : {}),
          recorded_at: recordedAt,
        }),
        append: async (progress) =>
          await episodeStore.appendProgressState({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            progress,
          }),
      });
    },

    async recordPlannedAction(input) {
      return await recordSemanticEvent({
        input,
        keys: PLANNED_ACTION_KEYS,
        label: "planned_action",
        eventKind: "planned_action_recorded",
        extract: (event) =>
          event.payload.event_kind === "planned_action_recorded"
            ? event.payload.planned_action
            : null,
        assertPayloadMatches: (plannedAction) => {
          if (
            plannedAction.action_id !== input.actionId
            || plannedAction.intent !== input.intent
            || plannedAction.justification !== input.justification
            || stableStringify(plannedAction.preconditions)
              !== stableStringify(input.preconditions)
          ) {
            fail("execution_episode_semantic_operation_conflict");
          }
        },
        build: (authority, decisiveEvidence, recordedAt) => ({
          episode_id: input.episodeId,
          action_id: input.actionId,
          intent: input.intent,
          justification: input.justification,
          preconditions: [...input.preconditions],
          target_state_snapshot_id:
            input.expectedCurrentStateSnapshotId,
          authority,
          ...(decisiveEvidence && decisiveEvidence.length > 0
            ? { decisive_evidence: [...decisiveEvidence] }
            : {}),
          recorded_at: recordedAt,
        }),
        append: async (plannedAction) =>
          await episodeStore.appendPlannedAction({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            plannedAction,
          }),
      });
    },

    async runVerifier(input) {
      assertPlainExactKeys(input, VERIFIER_KEYS, "verifier");
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.episodeId, "episode_id");
      assertExactId(input.operationId, "operation_id");
      assertExactId(
        input.expectedCurrentStateSnapshotId,
        "expected_current_state_snapshot_id",
      );
      const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);

      const existingEpisode = await episodeStore.getEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
      });
      if (!existingEpisode) return fail("execution_episode_missing");
      assertSubjectRootMatchesEpisode(
        workspaceRoot,
        existingEpisode.episode,
      );
      if (
        existingEpisode.current_state_snapshot_id
        !== input.expectedCurrentStateSnapshotId
      ) {
        return fail("execution_episode_verifier_target_state_stale");
      }
      const requiredVerifier = existingEpisode.episode.required_verifier;
      const entry = verifierRegistry.resolve(requiredVerifier.verifier_id);
      if (
        !entry
        || entry.identity.verifier_id !== requiredVerifier.verifier_id
        || entry.identity.definition_sha256
          !== requiredVerifier.verifier_definition_sha256
      ) {
        return fail("execution_episode_verifier_registry_identity_changed");
      }
      const existing = verifierReplayResult(
        existingEpisode,
        input.operationId,
      );
      if (existing) {
        assertVerifierReplayMatches(existing, entry.identity);
        const replayCurrent = currentStateSnapshot(existingEpisode);
        assertVerifierReplayCurrent(
          existing,
          existingEpisode,
          await captureEpisodeSubject(
            workspaceRoot,
            existingEpisode.episode,
            replayCurrent.snapshot_id,
            serverTimestamp(),
          ),
        );
        return existing;
      }
      assertEpisodeOpen(existingEpisode);
      const programDigest = entry.identity.verifier_program_digest;
      const invocationId = deterministicId("evi", {
        contract_version: "execution_verifier_invocation_identity_v1",
        episode_id: input.episodeId,
        operation_id: input.operationId,
        verifier_definition_sha256: entry.identity.definition_sha256,
      });
      const runnerInstanceId = deterministicId("evr", {
        contract_version: "execution_verifier_runner_instance_identity_v1",
        verifier_invocation_id: invocationId,
        verifier_definition_sha256: entry.identity.definition_sha256,
      });

      let invocation!: VerifierInvocationV1;
      let verifiedState!: StateSnapshotV1;
      let completedReplay: ExecutionEpisodeRunVerifierResultV1 | null = null;
      await transaction.run(async () => {
        const replay = await episodeStore.replayEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        });
        if (
          replay.current_state_snapshot_id
          !== input.expectedCurrentStateSnapshotId
        ) {
          return fail("execution_episode_verifier_target_state_stale");
        }
        const retried = verifierReplayResult(replay, input.operationId);
        if (retried) {
          assertVerifierReplayMatches(retried, entry.identity);
          const replayCurrent = currentStateSnapshot(replay);
          assertVerifierReplayCurrent(
            retried,
            replay,
            await captureEpisodeSubject(
              workspaceRoot,
              replay.episode,
              replayCurrent.snapshot_id,
              serverTimestamp(),
            ),
          );
          completedReplay = retried;
          return;
        }
        assertEpisodeOpen(replay);
        assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
        verifiedState = currentStateSnapshot(replay);
        const before = await captureEpisodeSubject(
          workspaceRoot,
          replay.episode,
          verifiedState.snapshot_id,
          serverTimestamp(),
        );
        assertCaptureMatchesSnapshot(before, verifiedState);
        const persisted = await episodeStore.getVerifierInvocation({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
          verifierInvocationId: invocationId,
        });
        if (persisted) {
          assertVerifierInvocationMatches(
            persisted,
            entry.identity,
            {
              episodeId: input.episodeId,
              invocationId,
              targetState: verifiedState,
            },
          );
          invocation = persisted;
          return;
        }
        const invokedAt = serverTimestamp();
        const verifierInputBytes = Buffer.from(stableStringify({
          contract_version: "execution_episode_verifier_input_v1",
          episode_id: input.episodeId,
          verifier_definition_identity: entry.identity,
          target_state_snapshot: verifiedState,
        }), "utf8");
        const verifierInputRef =
          await materializeRuntimeOwnedEvidenceInCurrentTransaction(
            artifactStore,
            {
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
              operationId: evidenceOperationId(
                input.operationId,
                "verifier-input",
              ),
              kind: "verifier_input",
              bytes: verifierInputBytes,
              mediaType: JSON_MEDIA_TYPE,
              encoding: UTF8_ENCODING,
              redactionPolicy: REDACTION_POLICY,
              retentionPolicy: RETENTION_POLICY,
            },
          );
        const reservationDigest = runtimeVerifierInvocationReservationDigest({
          episodeId: input.episodeId,
          verifierInvocationId: invocationId,
          verifierId: entry.identity.verifier_id,
          verifierDefinitionSha256: entry.identity.definition_sha256,
          verifierRunnerInstanceId: runnerInstanceId,
          verifierProgramDigest: programDigest,
          verifierConfigDigest: entry.identity.verifier_config_digest,
          verifierEnvironmentDigest: verifiedState.environment_digest,
          targetStateSnapshotId: verifiedState.snapshot_id,
          targetStateSnapshotAlgorithmVersion:
            verifiedState.algorithm_version,
        });
        invocation = VerifierInvocationV1Schema.parse({
          contract_version: "verifier_invocation_v1",
          verifier_invocation_id: invocationId,
          episode_id: input.episodeId,
          verifier_id: entry.identity.verifier_id,
          verifier_definition_sha256: entry.identity.definition_sha256,
          verifier_kind: entry.identity.verifier_kind,
          verifier_version: entry.identity.verifier_version,
          verifier_issuer_id: entry.identity.verifier_issuer_id,
          verifier_runner_instance_id: runnerInstanceId,
          launch_authority: {
            kind: "runtime_launched",
            runtime_reservation_digest: reservationDigest,
          },
          verifier_program_digest: programDigest,
          verifier_config_digest: entry.identity.verifier_config_digest,
          verifier_environment_digest: verifiedState.environment_digest,
          target_state_snapshot_id: verifiedState.snapshot_id,
          target_state_snapshot_algorithm_version:
            verifiedState.algorithm_version,
          verifier_input_ref: verifierInputRef,
          invoked_at: invokedAt,
        });
        await episodeStore.reserveVerifierInvocation({
          tenantId: input.tenantId,
          scope: input.storeScope,
          invocation,
        });
      });
      if (completedReplay !== null) return completedReplay;

      const snapshotArtifactBytes = await artifactStore.readArtifactBytes({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
        artifactId: verifiedState.artifact_ref.artifact_id,
      });
      const resolvedVerifierSubject = await resolveLocalSubject(
        workspaceRoot,
        existingEpisode.episode,
      );
      const adapterMaterialization =
        await resolvedVerifierSubject.adapter.materializeForVerifier({
          snapshot: stateSnapshotV2FromStored(
            verifiedState,
            resolvedVerifierSubject.subject,
          ),
          snapshot_artifact_bytes: snapshotArtifactBytes,
        });
      const materialization = adapterMaterialization.native_handle as VerifierSubjectMaterializationV1;
      let launchAttemptId: string | null = null;
      try {
        const immediatelyBeforeLaunch = await captureEpisodeSubject(
          workspaceRoot,
          existingEpisode.episode,
          verifiedState.snapshot_id,
          serverTimestamp(),
        );
        assertCaptureMatchesSnapshot(immediatelyBeforeLaunch, verifiedState);
        const authorization =
          await episodeStore.authorizeVerifierInvocationLaunch({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
            verifierInvocationId: invocation.verifier_invocation_id,
            sourceSubjectRoot: workspaceRoot,
            materialization,
          });
        if (
          verifierInvocationDigest(authorization.invocation)
            !== verifierInvocationDigest(invocation)
        ) {
          return fail("execution_episode_verifier_authorization_conflict");
        }
        launchAttemptId = `rvla_${sha256Bytes(Buffer.from(
          stableStringify({
            contract_version:
              "execution_verifier_launch_attempt_identity_v1",
            episode_id: input.episodeId,
            verifier_invocation_id: invocation.verifier_invocation_id,
            runtime_instance_id: runtimeInstanceId,
            nonce: randomUUID(),
          }),
          "utf8",
        ))}`;
        const durableLaunchAttemptId = launchAttemptId;
        const launch = await verifierRegistry.launch(
          authorization.authority,
          materialization,
          {
            launch_attempt_id: durableLaunchAttemptId,
            async persist_prepared_launch(prepared) {
              await transaction.run(async () => {
                await episodeStore.prepareVerifierLaunchAttempt({
                  tenantId: input.tenantId,
                  scope: input.storeScope,
                  outcomeOperationId: input.operationId,
                  ownerInstanceId: runtimeInstanceId,
                  ownerProcessId: process.pid,
                  preparedLaunch: prepared,
                });
              });
            },
            async persist_spawn_observation(observation) {
              await transaction.run(async () => {
                await episodeStore.appendVerifierSpawnObservation({
                  tenantId: input.tenantId,
                  scope: input.storeScope,
                  episodeId: input.episodeId,
                  verifierInvocationId:
                    invocation.verifier_invocation_id,
                  launchAttemptId: durableLaunchAttemptId,
                  ownerInstanceId: runtimeInstanceId,
                  ownerProcessId: process.pid,
                  observation,
                });
              });
            },
          },
        );
        const outputBytes = runnerOutputBytes(launch);
        return await transaction.run(async () => {
          const replay = await episodeStore.replayEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
          });
          const retried = verifierReplayResult(replay, input.operationId);
          if (retried) {
            assertVerifierReplayMatches(retried, entry.identity);
            const replayCurrent = currentStateSnapshot(replay);
            assertVerifierReplayCurrent(
              retried,
              replay,
              await captureEpisodeSubject(
                workspaceRoot,
                replay.episode,
                replayCurrent.snapshot_id,
                serverTimestamp(),
              ),
            );
            return retried;
          }
          assertEpisodeOpen(replay);
          assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
          const current = currentStateSnapshot(replay);
          if (current.snapshot_id !== verifiedState.snapshot_id) {
            return fail("execution_episode_verifier_target_state_stale");
          }
          const after = await captureEpisodeSubject(
            workspaceRoot,
            replay.episode,
            verifiedState.snapshot_id,
            serverTimestamp(),
          );
          assertCaptureMatchesSnapshot(after, verifiedState);
          const outputRef =
            await materializeRuntimeOwnedEvidenceInCurrentTransaction(
              artifactStore,
              {
                tenantId: input.tenantId,
                scope: input.storeScope,
                episodeId: input.episodeId,
                operationId: evidenceOperationId(
                  input.operationId,
                  "verifier-output",
                ),
                kind: "verifier_output",
                bytes: outputBytes,
                mediaType: JSON_MEDIA_TYPE,
                encoding: UTF8_ENCODING,
                redactionPolicy: REDACTION_POLICY,
                retentionPolicy: RETENTION_POLICY,
              },
            );
          const material = {
            contract_version: "verifier_outcome_receipt_v1" as const,
            verifier_receipt_id: deterministicId("evc", {
              contract_version: "execution_verifier_receipt_identity_v1",
              episode_id: input.episodeId,
              verifier_invocation_id: invocation.verifier_invocation_id,
              runtime_launch_sha256:
                launch.launch_identity.launch_sha256,
            }),
            episode_id: input.episodeId,
            verifier_id: invocation.verifier_id,
            verifier_definition_sha256:
              invocation.verifier_definition_sha256,
            verifier_kind: invocation.verifier_kind,
            verifier_version: invocation.verifier_version,
            verifier_issuer_id: invocation.verifier_issuer_id,
            verifier_runner_instance_id:
              invocation.verifier_runner_instance_id,
            verifier_invocation_id: invocation.verifier_invocation_id,
            verifier_invocation_digest: verifierInvocationDigest(invocation),
            verifier_program_digest: invocation.verifier_program_digest,
            verifier_config_digest: invocation.verifier_config_digest,
            verifier_environment_digest:
              invocation.verifier_environment_digest,
            verified_state_snapshot_id: verifiedState.snapshot_id,
            verified_state_snapshot_algorithm_version:
              verifiedState.algorithm_version,
            verifier_input_ref: invocation.verifier_input_ref,
            verifier_output_ref: outputRef,
            execution_exit_code: launch.result.exit_code,
            status: launch.effective_status,
            infrastructure_failure_reasons:
              [...launch.infrastructure_failure_reasons],
            infrastructure_failure_attribution:
              runtimeEpisodeVerifierFailureAttribution(launch),
            completed_at: launch.result.completed_at,
          };
          const evidenceDigest = verifierOutcomeEvidenceDigest(material);
          const outcome = VerifierOutcomeReceiptV1Schema.parse({
            ...material,
            attestation: {
              kind: "runtime_launched",
              runtime_launch_sha256:
                launch.launch_identity.launch_sha256,
            },
            evidence_digest: evidenceDigest,
          });
          const appended = await episodeStore.recordVerifierOutcome({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            invocation,
            outcome,
            verifiedStateSnapshot: verifiedState,
            runtimeExecutionEvidence: launch,
          });
          await synchronizeCurrentExecutionState(
            await episodeStore.replayEpisode({
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
            }),
          );
          return {
            invocation,
            outcome,
            verified_state_snapshot: verifiedState,
            verified_state_snapshot_v2: stateSnapshotV2FromEpisode(
              verifiedState,
              replay.episode,
            ),
            current_state_snapshot: verifiedState,
            current_state_snapshot_v2: stateSnapshotV2FromEpisode(
              verifiedState,
              replay.episode,
            ),
            event: appended.event,
            replayed: appended.replayed,
          };
        });
      } catch (error) {
        if (launchAttemptId !== null) {
          const open =
            await episodeStore.getOpenVerifierLaunchAttempt({
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
              verifierInvocationId:
                invocation.verifier_invocation_id,
            });
          if (
            open
            && open.attempt.launch_attempt_id === launchAttemptId
            && open.attempt.owner_instance_id === runtimeInstanceId
          ) {
            return await terminalizeInterruptedAttempt(open);
          }
        }
        throw error;
      } finally {
        adapterMaterialization.cleanup();
      }
    },

    async close(input) {
      assertPlainExactKeys(input, CLOSE_KEYS, "close");
      assertExactId(input.tenantId, "tenant_id");
      assertExactId(input.storeScope, "store_scope");
      assertExactId(input.episodeId, "episode_id");
      assertExactId(input.operationId, "operation_id");
      assertExactId(
        input.expectedCurrentStateSnapshotId,
        "expected_current_state_snapshot_id",
      );
      if (input.verifierReceiptId !== undefined) {
        assertExactId(input.verifierReceiptId, "verifier_receipt_id");
      }
      const workspaceRoot = canonicalSubjectRoot(input.workspaceRoot);
      const outcomeDetails = canonicalReasons(input.outcomeDetails);
      const costInput = canonicalExecutionCostInput(input.cost);
      const existingEpisode = await episodeStore.getEpisode({
        tenantId: input.tenantId,
        scope: input.storeScope,
        episodeId: input.episodeId,
      });
      if (!existingEpisode) return fail("execution_episode_missing");
      assertSubjectRootMatchesEpisode(
        workspaceRoot,
        existingEpisode.episode,
      );
      if (
        existingEpisode.current_state_snapshot_id
        !== input.expectedCurrentStateSnapshotId
      ) {
        return fail("execution_episode_close_target_state_stale");
      }
      const existing = findOperationEvent(
        existingEpisode,
        input.operationId,
        "episode_closed",
      );
      if (existing) {
        if (existing.payload.event_kind !== "episode_closed") {
          return fail("execution_episode_close_operation_conflict");
        }
        const existingCost = costInputForExistingReceipt(
          costInput,
          existing.payload.cost_receipt,
        );
        return await transaction.run(async () => {
          const closed = await episodeStore.closeEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            operationId: input.operationId,
            episodeId: input.episodeId,
            termination: input.termination,
            ...(input.verifierReceiptId
              ? { verifierReceiptId: input.verifierReceiptId }
              : {}),
            outcomeDetails,
            ...(existingCost ? { cost: existingCost } : {}),
          });
          await synchronizeCurrentExecutionState(
            await episodeStore.replayEpisode({
              tenantId: input.tenantId,
              scope: input.storeScope,
              episodeId: input.episodeId,
            }),
          );
          return closed;
        });
      }
      assertEpisodeOpen(existingEpisode);
      assertVerifiedCompletion(
        existingEpisode,
        input.termination,
        input.verifierReceiptId,
      );

      return await transaction.run(async () => {
        const replay = await episodeStore.replayEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          episodeId: input.episodeId,
        });
        assertEpisodeOpen(replay);
        assertSubjectRootMatchesEpisode(workspaceRoot, replay.episode);
        const current = currentStateSnapshot(replay);
        if (
          current.snapshot_id !== input.expectedCurrentStateSnapshotId
        ) {
          return fail("execution_episode_close_target_state_stale");
        }
        assertVerifiedCompletion(
          replay,
          input.termination,
          input.verifierReceiptId,
        );
        const capture = await captureEpisodeSubject(
          workspaceRoot,
          replay.episode,
          current.snapshot_id,
          serverTimestamp(),
        );
        assertCaptureMatchesSnapshot(capture, current);
        let cost: LiteExecutionEpisodeCostInputV1 | undefined;
        if (costInput !== undefined) {
          const rawUsageRef =
            await materializeRuntimeOwnedEvidenceInCurrentTransaction(
              artifactStore,
              {
                tenantId: input.tenantId,
                scope: input.storeScope,
                episodeId: input.episodeId,
                operationId: evidenceOperationId(
                  input.operationId,
                  "usage-receipt",
                ),
                kind: "usage_receipt",
                bytes: costInput.usageReceiptBytes,
                mediaType: costInput.usageReceiptMediaType,
                encoding: costInput.usageReceiptEncoding,
                redactionPolicy: REDACTION_POLICY,
                retentionPolicy: RETENTION_POLICY,
              },
            );
          cost = {
            provider: costInput.provider,
            model: costInput.model,
            inputTokens: costInput.inputTokens,
            outputTokens: costInput.outputTokens,
            ...(costInput.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: costInput.cachedInputTokens }),
            tokenUsageAuthority: costInput.tokenUsageAuthority,
            rawUsageRef,
            ...(costInput.monetaryCostMicros === undefined
              ? {}
              : { monetaryCostMicros: costInput.monetaryCostMicros }),
            ...(costInput.currency === undefined
              ? {}
              : { currency: costInput.currency }),
            producerId: costInput.producerId,
          };
        }
        const closed = await episodeStore.closeEpisode({
          tenantId: input.tenantId,
          scope: input.storeScope,
          operationId: input.operationId,
          episodeId: input.episodeId,
          termination: input.termination,
          ...(input.verifierReceiptId
            ? { verifierReceiptId: input.verifierReceiptId }
            : {}),
          outcomeDetails,
          ...(cost ? { cost } : {}),
        });
        await synchronizeCurrentExecutionState(
          await episodeStore.replayEpisode({
            tenantId: input.tenantId,
            scope: input.storeScope,
            episodeId: input.episodeId,
          }),
        );
        return closed;
      });
    },
  });
  return service;
}
