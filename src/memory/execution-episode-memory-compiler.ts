import { createHash } from "node:crypto";

import stableStringify from "fast-json-stable-stringify";

import {
  HostTaskEnvelopeV1Schema,
  type HostTaskEnvelopeV1,
} from "../execution/host-task-contract.js";
import {
  ExecutionNativeV1Schema,
  WriteNode,
} from "./schemas.js";
import {
  episodeRewardDigest,
  type EvidenceArtifactRefV1,
  type StateSnapshotV1,
} from "./execution-episode.js";
import type {
  LiteExecutionEpisodeReplay,
} from "../store/lite-execution-episode-store.js";
import {
  decodeWorkspaceStateCaptureArtifact,
} from "../execution/workspace-state-capture.js";
import type {
  CanonicalL1EpisodeV1,
} from "../learning/canonical-l1-contract.js";

export const EXECUTION_EPISODE_MEMORY_COMPILER_VERSION =
  "execution_episode_memory_compiler_v2" as const;
export const EXECUTION_EPISODE_MEMORY_OBSERVE_OPERATION_PREFIX =
  "canonical_l1_episode_v1:" as const;

const MAX_WORKFLOW_STEPS = 32;
const MAX_TARGET_FILES = 64;
const MAX_STEP_CHARS = 256;
const MAX_SOURCE_EVIDENCE_REFS = 32;
const MAX_SOURCE_EVIDENCE_REF_CHARS = 256;

type ArtifactReader = Readonly<{
  readArtifactBytes(args: {
    tenantId: string;
    scope: string;
    artifactId: string;
    episodeId: string;
  }): Promise<Buffer>;
}>;

type WorkspaceStateEntry = Readonly<{
  path: string;
  value: unknown;
}>;

export type ExecutionEpisodeMemoryDisposition =
  | "verified_solution"
  | "verified_failure"
  | "abstained";

export type CompiledExecutionEpisodeMemoryV1 = Readonly<{
  contract_version: "compiled_canonical_l1_episode_v1";
  compiler_version: typeof EXECUTION_EPISODE_MEMORY_COMPILER_VERSION;
  disposition: ExecutionEpisodeMemoryDisposition;
  episode_id: string;
  reward_id: string | null;
  reward_digest: string | null;
  task_envelope: HostTaskEnvelopeV1;
  changed_paths: readonly string[];
  action_count: number;
  mutating_action_count: number;
  source_evidence_refs: readonly string[];
  source_evidence_ref_count: number;
  source_evidence_refs_sha256: string;
  canonical_l1: CanonicalL1EpisodeV1 | null;
  abstain_reason: string | null;
  node: ReturnType<typeof WriteNode.parse> | null;
}>;

export class ExecutionEpisodeMemoryCompilerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ExecutionEpisodeMemoryCompilerError";
    this.code = code;
  }
}

export function executionEpisodeMemoryObserveOperationId(
  rewardDigest: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(rewardDigest)) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_reward_digest_invalid",
    );
  }
  return `${EXECUTION_EPISODE_MEMORY_OBSERVE_OPERATION_PREFIX}${rewardDigest}`;
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function artifactEvidenceRef(ref: EvidenceArtifactRefV1): string {
  return `${ref.kind}:${ref.artifact_id}:sha256:${ref.sha256}`;
}

type SourceEvidenceSummary = Readonly<{
  refs: readonly string[];
  full_count: number;
  full_sha256: string;
}>;

function compactArtifactEvidenceRef(
  ref: EvidenceArtifactRefV1,
  canonicalRef: string,
): string {
  if (canonicalRef.length <= MAX_SOURCE_EVIDENCE_REF_CHARS) {
    return canonicalRef;
  }
  return `${ref.kind}:artifact_ref_sha256:${sha256Value(canonicalRef)}`
    + `:content_sha256:${ref.sha256}`;
}

function compactStorageRef(
  kind: "task_manifest" | "verifier_output",
  storageRef: string,
): string {
  if (storageRef.length <= MAX_SOURCE_EVIDENCE_REF_CHARS) {
    return storageRef;
  }
  return `${kind}_storage_ref_sha256:${sha256Value(storageRef)}`;
}

async function readBoundArtifact(
  reader: ArtifactReader,
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    ref: EvidenceArtifactRefV1;
  },
): Promise<Buffer> {
  const bytes = await reader.readArtifactBytes({
    tenantId: args.tenantId,
    scope: args.scope,
    artifactId: args.ref.artifact_id,
    episodeId: args.episodeId,
  });
  if (
    bytes.byteLength !== args.ref.byte_length
    || sha256Bytes(bytes) !== args.ref.sha256
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_source_artifact_digest_mismatch",
    );
  }
  return bytes;
}

function parseJsonObject(bytes: Buffer, errorCode: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not_object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ExecutionEpisodeMemoryCompilerError(errorCode);
  }
}

function workspaceEntries(value: Record<string, unknown>): WorkspaceStateEntry[] {
  if (value.contract_version !== "workspace_state_capture_manifest_v1") {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_workspace_manifest_contract_invalid",
    );
  }
  if (!Array.isArray(value.entries)) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_workspace_manifest_entries_invalid",
    );
  }
  const entries: WorkspaceStateEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExecutionEpisodeMemoryCompilerError(
        "execution_episode_memory_workspace_entry_invalid",
      );
    }
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path || seen.has(path)) {
      throw new ExecutionEpisodeMemoryCompilerError(
        "execution_episode_memory_workspace_path_invalid",
      );
    }
    seen.add(path);
    entries.push({ path, value: record });
  }
  return entries;
}

async function workspaceChangedPaths(
  reader: ArtifactReader,
  args: {
    tenantId: string;
    scope: string;
    episodeId: string;
    before: StateSnapshotV1;
    after: StateSnapshotV1;
  },
): Promise<string[]> {
  if (
    args.before.algorithm_id !== args.after.algorithm_id
    || args.before.algorithm_version !== args.after.algorithm_version
    || args.before.state_kind !== "workspace"
    || args.after.state_kind !== "workspace"
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_workspace_snapshots_incomparable",
    );
  }
  const [beforeBytes, afterBytes] = await Promise.all([
    readBoundArtifact(reader, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId: args.episodeId,
      ref: args.before.artifact_ref,
    }),
    readBoundArtifact(reader, {
      tenantId: args.tenantId,
      scope: args.scope,
      episodeId: args.episodeId,
      ref: args.after.artifact_ref,
    }),
  ]);
  const beforeEntries = new Map(
    workspaceEntries(parseJsonObject(
      decodeWorkspaceStateCaptureArtifact(beforeBytes),
      "execution_episode_memory_initial_workspace_manifest_invalid",
    )).map((entry) => [entry.path, stableStringify(entry.value)]),
  );
  const afterEntries = new Map(
    workspaceEntries(parseJsonObject(
      decodeWorkspaceStateCaptureArtifact(afterBytes),
      "execution_episode_memory_final_workspace_manifest_invalid",
    )).map((entry) => [entry.path, stableStringify(entry.value)]),
  );
  const paths = new Set([...beforeEntries.keys(), ...afterEntries.keys()]);
  return [...paths]
    .filter((path) => beforeEntries.get(path) !== afterEntries.get(path))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
    .slice(0, MAX_TARGET_FILES);
}

function closeEvent(replay: LiteExecutionEpisodeReplay) {
  return [...replay.events].reverse().find(
    (event) => event.payload.event_kind === "episode_closed",
  ) ?? null;
}

function actionEvents(replay: LiteExecutionEpisodeReplay) {
  return replay.events
    .filter((event) => event.payload.event_kind === "action_observed")
    .sort((left, right) =>
      left.payload.event_kind === "action_observed"
      && right.payload.event_kind === "action_observed"
        ? left.payload.action.sequence - right.payload.action.sequence
        : 0);
}

function workflowSteps(
  replay: LiteExecutionEpisodeReplay,
  changedPaths: readonly string[],
): string[] {
  const changedPathText = changedPaths.length > 0
    ? changedPaths.slice(0, 8).join(", ")
    : null;
  return actionEvents(replay)
    .slice(0, MAX_WORKFLOW_STEPS)
    .map((event, index) => {
      if (event.payload.event_kind !== "action_observed") return "";
      const action = event.payload.action;
      const tool = truncate(
        action.tool_name ?? action.action_kind,
        96,
      );
      const effect = action.mutation
        ? changedPathText
          ? `workspace mutation; affected trajectory targets: ${changedPathText}`
          : "workspace mutation recorded"
        : "observation without workspace mutation";
      return truncate(
        `${index + 1}. ${tool} (${action.action_kind}): ${effect}.`,
        MAX_STEP_CHARS,
      );
    })
    .filter((entry) => entry.length > 0);
}

function sourceEvidenceSummary(
  replay: LiteExecutionEpisodeReplay,
): SourceEvidenceSummary {
  const refs: EvidenceArtifactRefV1[] = [
    replay.episode.task_envelope_ref,
    replay.episode.task_manifest_ref,
    replay.episode.source_task_ref,
  ];
  for (const event of replay.events) {
    if (event.payload.event_kind === "episode_started") {
      refs.push(event.payload.initial_state_snapshot.artifact_ref);
    } else if (event.payload.event_kind === "action_observed") {
      refs.push(
        event.payload.action.request_ref,
        event.payload.action.result_ref,
        event.payload.state_after_snapshot.artifact_ref,
      );
    } else if (event.payload.event_kind === "verifier_recorded") {
      refs.push(
        event.payload.invocation.verifier_input_ref,
        event.payload.outcome.verifier_output_ref,
        event.payload.verified_state_snapshot.artifact_ref,
      );
    } else if (
      event.payload.event_kind === "episode_closed"
      && event.payload.final_state_snapshot
    ) {
      refs.push(event.payload.final_state_snapshot.artifact_ref);
    }
  }
  const canonicalRefs = [...new Set(refs.map(artifactEvidenceRef))]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  const refByCanonical = new Map(
    refs.map((ref) => [artifactEvidenceRef(ref), ref] as const),
  );
  const boundedRefs = canonicalRefs
    .slice(0, MAX_SOURCE_EVIDENCE_REFS)
    .map((canonicalRef) => compactArtifactEvidenceRef(
      refByCanonical.get(canonicalRef)!,
      canonicalRef,
    ));
  return {
    refs: boundedRefs,
    full_count: canonicalRefs.length,
    full_sha256: sha256Value(canonicalRefs),
  };
}

function verifiedOutcomeBinding(replay: LiteExecutionEpisodeReplay): {
  verifierId: string;
  verifierVersion: string;
  verifierReceiptId: string;
  verifierOutputStorageRef: string;
  finalStateSnapshotId: string;
  verificationSummary: string;
} {
  const reward = replay.reward;
  if (
    !reward
    || (reward.outcome_class !== "verified_pass"
      && reward.outcome_class !== "verified_failure")
    || !reward.verifier_receipt_id
    || !reward.final_state_snapshot_id
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_verified_reward_binding_missing",
    );
  }
  const verifier = replay.events.find((event) =>
    event.payload.event_kind === "verifier_recorded"
    && event.payload.outcome.verifier_receipt_id
      === reward.verifier_receipt_id);
  if (
    !verifier
    || verifier.payload.event_kind !== "verifier_recorded"
    || verifier.payload.outcome.verified_state_snapshot_id
      !== reward.final_state_snapshot_id
    || verifier.payload.verified_state_snapshot.snapshot_id
      !== reward.final_state_snapshot_id
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_verifier_state_binding_invalid",
    );
  }
  const expectedStatus =
    reward.outcome_class === "verified_pass" ? "passed" : "failed";
  if (verifier.payload.outcome.status !== expectedStatus) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_verifier_reward_disagrees",
    );
  }
  return {
    verifierId: verifier.payload.outcome.verifier_id,
    verifierVersion: verifier.payload.outcome.verifier_version,
    verifierReceiptId: reward.verifier_receipt_id,
    verifierOutputStorageRef:
      verifier.payload.outcome.verifier_output_ref.storage_ref,
    finalStateSnapshotId: reward.final_state_snapshot_id,
    verificationSummary: truncate(
      `Independent verifier ${verifier.payload.outcome.verifier_id}`
      + `@${verifier.payload.outcome.verifier_version} ${expectedStatus}`
      + ` for exact state ${reward.final_state_snapshot_id};`
      + ` receipt ${reward.verifier_receipt_id}.`,
      MAX_STEP_CHARS,
    ),
  };
}

function abstainedResult(args: {
  replay: LiteExecutionEpisodeReplay;
  taskEnvelope: HostTaskEnvelopeV1;
  sourceEvidence: SourceEvidenceSummary;
  reason: string;
}): CompiledExecutionEpisodeMemoryV1 {
  return {
    contract_version: "compiled_canonical_l1_episode_v1",
    compiler_version: EXECUTION_EPISODE_MEMORY_COMPILER_VERSION,
    disposition: "abstained",
    episode_id: args.replay.episode.episode_id,
    reward_id: args.replay.reward?.reward_id ?? null,
    reward_digest: args.replay.reward
      ? episodeRewardDigest(args.replay.reward)
      : null,
    task_envelope: args.taskEnvelope,
    changed_paths: [],
    action_count: actionEvents(args.replay).length,
    mutating_action_count: actionEvents(args.replay)
      .filter((event) =>
        event.payload.event_kind === "action_observed"
        && event.payload.action.mutation).length,
    source_evidence_refs: args.sourceEvidence.refs,
    source_evidence_ref_count: args.sourceEvidence.full_count,
    source_evidence_refs_sha256: args.sourceEvidence.full_sha256,
    canonical_l1: null,
    abstain_reason: args.reason,
    node: null,
  };
}

export async function compileExecutionEpisodeMemoryV1(args: {
  replay: LiteExecutionEpisodeReplay;
  canonicalL1: CanonicalL1EpisodeV1;
  artifactReader: ArtifactReader;
  tenantId: string;
  scope: string;
}): Promise<CompiledExecutionEpisodeMemoryV1> {
  const replay = args.replay;
  if (
    replay.episode.tenant_id !== args.tenantId
    || replay.episode.store_scope !== args.scope
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_identity_mismatch",
    );
  }
  if (
    args.canonicalL1.episode_id !== replay.episode.episode_id
    || args.canonicalL1.reward.reward_id !== replay.reward?.reward_id
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "canonical_l1_episode_identity_mismatch",
    );
  }
  const taskEnvelopeBytes = await readBoundArtifact(args.artifactReader, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: replay.episode.episode_id,
    ref: replay.episode.task_envelope_ref,
  });
  const taskEnvelope = HostTaskEnvelopeV1Schema.parse(
    parseJsonObject(
      taskEnvelopeBytes,
      "execution_episode_memory_task_envelope_invalid",
    ),
  );
  const sourceEvidence = sourceEvidenceSummary(replay);
  const sourceRefs = sourceEvidence.refs;
  if (!replay.closed || !replay.reward) {
    return abstainedResult({
      replay,
      taskEnvelope,
      sourceEvidence,
      reason: "episode_not_closed_with_reward",
    });
  }
  if (
    replay.reward.outcome_class !== "verified_pass"
    && replay.reward.outcome_class !== "verified_failure"
  ) {
    return abstainedResult({
      replay,
      taskEnvelope,
      sourceEvidence,
      reason: `reward_not_verifier_backed:${replay.reward.outcome_class}`,
    });
  }
  const closed = closeEvent(replay);
  if (
    !closed
    || closed.payload.event_kind !== "episode_closed"
    || !closed.payload.final_state_snapshot
  ) {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_close_state_missing",
    );
  }
  const started = replay.events.find(
    (event) => event.payload.event_kind === "episode_started",
  );
  if (!started || started.payload.event_kind !== "episode_started") {
    throw new ExecutionEpisodeMemoryCompilerError(
      "execution_episode_memory_initial_state_missing",
    );
  }
  const binding = verifiedOutcomeBinding(replay);
  const changedPaths = await workspaceChangedPaths(args.artifactReader, {
    tenantId: args.tenantId,
    scope: args.scope,
    episodeId: replay.episode.episode_id,
    before: started.payload.initial_state_snapshot,
    after: closed.payload.final_state_snapshot,
  });
  const actions = actionEvents(replay);
  const steps = workflowSteps(replay, changedPaths);
  const role = replay.reward.outcome_class === "verified_pass"
    ? "passed_solution" as const
    : "failed_branch" as const;
  const disposition = replay.reward.outcome_class === "verified_pass"
    ? "verified_solution" as const
    : "verified_failure" as const;
  const workflowSignature = `episode_workflow:${sha256Value({
    task_signature: taskEnvelope.task_signature,
    repository_signature: taskEnvelope.repository_signature,
    action_kinds: actions.map((event) =>
      event.payload.event_kind === "action_observed"
        ? event.payload.action.action_kind
        : null),
    changed_paths: changedPaths,
    verifier_id: binding.verifierId,
    verifier_version: binding.verifierVersion,
  })}`;
  const rewardDigest = episodeRewardDigest(replay.reward);
  const clientId = `execution_episode_memory:${sha256Value({
    compiler_version: EXECUTION_EPISODE_MEMORY_COMPILER_VERSION,
    episode_id: replay.episode.episode_id,
    reward_digest: rewardDigest,
  })}`;
  const summary = truncate(
    `${disposition === "verified_solution" ? "Verified solution" : "Verified failed trajectory"}`
    + ` for ${taskEnvelope.task_family}/${taskEnvelope.task_signature};`
    + ` ${actions.length} recorded actions, ${changedPaths.length} changed paths;`
    + ` ${binding.verificationSummary}`,
    1_500,
  );
  const executionNative = ExecutionNativeV1Schema.parse({
    schema_version: "execution_native_v1",
    execution_kind: "execution_native",
    execution_outcome_role: role,
    summary_kind: "canonical_l1_episode",
    compression_layer: "L1",
    contract_trust: disposition === "verified_solution"
      ? "advisory"
      : "observational",
    task_signature: taskEnvelope.task_signature,
    task_family: taskEnvelope.task_family,
    workflow_signature: workflowSignature,
    tool_set: [...new Set(actions.map((event) =>
      event.payload.event_kind === "action_observed"
        ? truncate(
            event.payload.action.tool_name
              ?? event.payload.action.action_kind,
            128,
          )
        : "",
    ).filter((entry) => entry.length > 0))].slice(0, 64),
    file_path: changedPaths[0] ?? null,
    ...(changedPaths.length > 0 ? { target_files: changedPaths } : {}),
    ...(steps.length > 0 ? { workflow_steps: steps } : {}),
  });
  const node = WriteNode.parse({
    client_id: clientId,
    type: "event",
    title: disposition === "verified_solution"
      ? `Verified solution: ${taskEnvelope.task_family}`
      : `Verified failed branch: ${taskEnvelope.task_family}`,
    text_summary: summary,
    raw_ref: compactStorageRef(
      "task_manifest",
      replay.episode.task_manifest_ref.storage_ref,
    ),
    evidence_ref: compactStorageRef(
      "verifier_output",
      binding.verifierOutputStorageRef,
    ),
    confidence: 1,
    salience: disposition === "verified_solution" ? 0.9 : 0.75,
    importance: 0.9,
    slots: {
      memory_kind: "execution_memory",
      summary_kind: "canonical_l1_episode",
      compression_layer: "L1",
      execution_experience_class: "canonical_l1_episode",
      canonical_prompt_eligibility:
        "cold_inspect_only",
      contract_trust: executionNative.contract_trust,
      task_family: taskEnvelope.task_family,
      task_signature: taskEnvelope.task_signature,
      repository_signature: taskEnvelope.repository_signature,
      workflow_signature: workflowSignature,
      workflow_steps: steps,
      target_files: changedPaths,
      verification_summary: [binding.verificationSummary],
      artifacts: sourceRefs,
      evidence_refs: sourceRefs,
      evidence_ref_count: sourceEvidence.full_count,
      evidence_refs_sha256: sourceEvidence.full_sha256,
      execution_outcome_role: role,
      task_outcome: replay.reward.outcome_class,
      outcome_authority: "runtime_verifier",
      verifier_receipt_id: binding.verifierReceiptId,
      target_state_snapshot_id: binding.finalStateSnapshotId,
      execution_result_summary: {
        execution_outcome_role: role,
        task_outcome: replay.reward.outcome_class,
        outcome_authority: "runtime_verifier",
        verifier_receipt_id: binding.verifierReceiptId,
        target_state_snapshot_id: binding.finalStateSnapshotId,
        evidence_refs: sourceRefs,
        evidence_ref_count: sourceEvidence.full_count,
        evidence_refs_sha256: sourceEvidence.full_sha256,
      },
      execution_observation_v1: {
        schema_version: "execution_observation_v1",
        run_id: replay.episode.run_id,
        task_id: replay.episode.task_id,
        execution_outcome_role: role,
        task_outcome: replay.reward.outcome_class,
        outcome_authority: "runtime_verifier",
        verifier_receipt_id: binding.verifierReceiptId,
        target_state_snapshot_id: binding.finalStateSnapshotId,
        evidence_refs: sourceRefs,
        evidence_ref_count: sourceEvidence.full_count,
        evidence_refs_sha256: sourceEvidence.full_sha256,
        verification_summary: [binding.verificationSummary],
      },
      execution_learning_artifact_v1: args.canonicalL1,
      execution_native_v1: executionNative,
    },
  });

  return {
    contract_version: "compiled_canonical_l1_episode_v1",
    compiler_version: EXECUTION_EPISODE_MEMORY_COMPILER_VERSION,
    disposition,
    episode_id: replay.episode.episode_id,
    reward_id: replay.reward.reward_id,
    reward_digest: rewardDigest,
    task_envelope: taskEnvelope,
    changed_paths: changedPaths,
    action_count: actions.length,
    mutating_action_count: actions.filter((event) =>
      event.payload.event_kind === "action_observed"
      && event.payload.action.mutation).length,
    source_evidence_refs: sourceRefs,
    source_evidence_ref_count: sourceEvidence.full_count,
    source_evidence_refs_sha256: sourceEvidence.full_sha256,
    canonical_l1: args.canonicalL1,
    abstain_reason: null,
    node,
  };
}
