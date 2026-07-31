import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  WorkspaceExecutionEpisodeSubjectStateSpecV2Schema,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
} from "../memory/execution-episode.js";
import {
  materializeVerifierSubjectFromSnapshot,
} from "./verifier-subject-materialization.js";
import {
  captureExactWorkspaceState,
  decodeWorkspaceStateCaptureArtifact,
  WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
  WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
  WORKSPACE_STATE_CAPTURE_MEDIA_TYPE,
  type WorkspaceStateCaptureManifestV1,
  type WorkspaceSubjectStateSpecV2,
} from "./workspace-state-capture.js";
import {
  ExecutionSubjectV1Schema,
  StateDeltaV1Schema,
  StateSnapshotV2Schema,
  SubjectCapabilityDescriptorV1Schema,
  deterministicSubjectContractId,
  executionSubjectId,
  stateContentRef,
  stateDeltaContentRef,
  subjectCapabilityDescriptorDigest,
  subjectCapabilityDescriptorRef,
  type CapturedSubjectDeltaV1,
  type CapturedSubjectStateV2,
  type ExecutionSubjectV1,
  type SubjectStateAdapter,
} from "./subject-state-adapter.js";

export const WORKSPACE_SUBJECT_ADAPTER_ID = "workspace_subject_v2";
export const WORKSPACE_SUBJECT_ADAPTER_VERSION = "1";
export const WORKSPACE_STATE_DELTA_MEDIA_TYPE =
  "application/vnd.aionis.workspace-state-delta.v1+json";

export type WorkspaceSubjectAdapterInputV2 = Readonly<{
  workspace_root: string;
  subject_state_spec?: WorkspaceSubjectStateSpecV2;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInput(value: unknown): Readonly<{
  workspace_root: string;
  subject_state_spec: WorkspaceSubjectStateSpecV2;
}> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error("workspace_subject_adapter_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length < 1
    || keys.length > 2
    || !Object.hasOwn(record, "workspace_root")
    || keys.some(
      (key) => key !== "workspace_root" && key !== "subject_state_spec",
    )
  ) {
    throw new Error("workspace_subject_adapter_input_invalid");
  }
  if (
    typeof record.workspace_root !== "string"
    || record.workspace_root.length === 0
    || record.workspace_root.includes("\u0000")
    || record.workspace_root.includes("\r")
    || record.workspace_root.includes("\n")
    || Buffer.byteLength(record.workspace_root, "utf8") > 4 * 1024
  ) {
    throw new Error("workspace_subject_adapter_root_invalid");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync.native(record.workspace_root);
  } catch {
    throw new Error("workspace_subject_adapter_root_unavailable");
  }
  const subjectStateSpec =
    WorkspaceExecutionEpisodeSubjectStateSpecV2Schema.parse(
    record.subject_state_spec ?? {
      contract_version: "workspace_subject_state_spec_v2",
      additional_state_roots: [],
    },
  );
  return Object.freeze({
    workspace_root: workspaceRoot,
    subject_state_spec: subjectStateSpec,
  });
}

const WORKSPACE_CAPABILITIES = SubjectCapabilityDescriptorV1Schema.parse({
  contract_version: "subject_capability_descriptor_v1",
  subject_kind: "workspace",
  capabilities: [
    "capture",
    "delta",
    "restore",
    "runtime_owned_capture",
    "verifier_materialization",
  ],
  snapshot_media_types: [WORKSPACE_STATE_CAPTURE_MEDIA_TYPE],
  delta_media_types: [WORKSPACE_STATE_DELTA_MEDIA_TYPE],
});

function subjectFromInput(input: ReturnType<typeof canonicalInput>) {
  const identityMaterial = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: "workspace" as const,
    canonical_root_sha256: sha256(
      Buffer.from(input.workspace_root, "utf8"),
    ),
    capture_algorithm_id: WORKSPACE_STATE_CAPTURE_ALGORITHM_ID,
    capture_algorithm_version: WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION,
    subject_state_spec: input.subject_state_spec,
    subject_state_spec_sha256:
      executionEpisodeSubjectStateSpecDigest(input.subject_state_spec),
  };
  const identitySha256 =
    executionEpisodeSubjectIdentityDigest(identityMaterial);
  const capabilitySha256 = subjectCapabilityDescriptorDigest(
    WORKSPACE_CAPABILITIES,
  );
  return ExecutionSubjectV1Schema.parse({
    contract_version: "execution_subject_v1",
    subject_id: executionSubjectId(identitySha256),
    kind: "workspace",
    adapter_id: WORKSPACE_SUBJECT_ADAPTER_ID,
    adapter_version: WORKSPACE_SUBJECT_ADAPTER_VERSION,
    identity_sha256: identitySha256,
    capability_descriptor_ref:
      subjectCapabilityDescriptorRef(capabilitySha256),
    capability_descriptor_sha256: capabilitySha256,
  });
}

function assertSubjectMatches(
  expected: ExecutionSubjectV1,
  actual: ExecutionSubjectV1,
): void {
  if (stableStringify(expected) !== stableStringify(actual)) {
    throw new Error("workspace_subject_adapter_identity_mismatch");
  }
}

function manifest(
  captured: CapturedSubjectStateV2,
): WorkspaceStateCaptureManifestV1 {
  const bytes = decodeWorkspaceStateCaptureArtifact(captured.artifact.bytes);
  const value = JSON.parse(bytes.toString("utf8")) as
    WorkspaceStateCaptureManifestV1;
  if (
    value.contract_version !== "workspace_state_capture_manifest_v1"
    || value.algorithm_id !== WORKSPACE_STATE_CAPTURE_ALGORITHM_ID
    || value.algorithm_version !== WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION
  ) {
    throw new Error("workspace_subject_adapter_snapshot_invalid");
  }
  return value;
}

function changedFields(
  before: WorkspaceStateCaptureManifestV1,
  after: WorkspaceStateCaptureManifestV1,
): string[] {
  const changed = new Set<string>();
  if (
    stableStringify(before.repository)
    !== stableStringify(after.repository)
  ) {
    changed.add("repository");
  }
  if (
    stableStringify(before.capture_policy.subject_state_spec)
    !== stableStringify(after.capture_policy.subject_state_spec)
  ) {
    changed.add("capture_policy.subject_state_spec");
  }
  const beforeEntries = new Map(
    before.entries.map((entry) => [entry.path, stableStringify(entry)]),
  );
  const afterEntries = new Map(
    after.entries.map((entry) => [entry.path, stableStringify(entry)]),
  );
  for (
    const path of new Set([
      ...beforeEntries.keys(),
      ...afterEntries.keys(),
    ])
  ) {
    if (beforeEntries.get(path) !== afterEntries.get(path)) {
      changed.add(`entries/${path}`);
    }
  }
  return [...changed].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

const ABSENT_WORKING_TREE = Object.freeze({
  kind: "absent" as const,
});

function targetManifest(bytes: Uint8Array): WorkspaceStateCaptureManifestV1 {
  const manifestBytes = decodeWorkspaceStateCaptureArtifact(bytes);
  return JSON.parse(
    manifestBytes.toString("utf8"),
  ) as WorkspaceStateCaptureManifestV1;
}

function gitStateAuthority(
  value: WorkspaceStateCaptureManifestV1,
): string {
  return stableStringify({
    workspace_kind: value.workspace_kind,
    repository: value.repository,
    git_paths: value.entries
      .filter(
        (entry) =>
          entry.git_head !== null || entry.git_index.length > 0,
      )
      .map((entry) => ({
        path: entry.path,
        git_head: entry.git_head,
        git_index: entry.git_index,
      })),
  });
}

function absoluteWorkspacePath(root: string, path: string): string {
  const absolute = join(root, ...path.split("/"));
  const fromRoot = relative(root, absolute);
  if (
    fromRoot.length === 0
    || fromRoot === ".."
    || fromRoot.startsWith(`..${sep}`)
    || isAbsolute(fromRoot)
  ) {
    throw new Error("workspace_subject_restore_path_escape");
  }
  return absolute;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function applyWorkspaceManifest(
  liveRoot: string,
  current: WorkspaceStateCaptureManifestV1,
  target: WorkspaceStateCaptureManifestV1,
  materializedTargetRoot: string,
): void {
  const currentByPath = new Map(
    current.entries.map((entry) => [entry.path, entry]),
  );
  const targetByPath = new Map(
    target.entries.map((entry) => [entry.path, entry]),
  );
  const changedPaths = [...new Set([
    ...currentByPath.keys(),
    ...targetByPath.keys(),
  ])].filter((path) =>
    stableStringify(
      currentByPath.get(path)?.working_tree ?? ABSENT_WORKING_TREE,
    ) !== stableStringify(
      targetByPath.get(path)?.working_tree ?? ABSENT_WORKING_TREE,
    )
  );

  for (
    const path of [...changedPaths].sort((left, right) => {
      const depth = pathDepth(right) - pathDepth(left);
      return depth !== 0
        ? depth
        : Buffer.compare(
            Buffer.from(right, "utf8"),
            Buffer.from(left, "utf8"),
          );
    })
  ) {
    const currentWorking =
      currentByPath.get(path)?.working_tree ?? ABSENT_WORKING_TREE;
    const targetWorking =
      targetByPath.get(path)?.working_tree ?? ABSENT_WORKING_TREE;
    if (
      currentWorking.kind === "absent"
      || (
        currentWorking.kind === "directory"
        && targetWorking.kind === "directory"
      )
    ) {
      continue;
    }
    const livePath = absoluteWorkspacePath(liveRoot, path);
    let stats;
    try {
      stats = lstatSync(livePath);
    } catch {
      throw new Error("workspace_subject_restore_live_state_drift");
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      try {
        rmdirSync(livePath);
      } catch (error) {
        const code = (
          error as NodeJS.ErrnoException
        ).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") {
          throw error;
        }
      }
    } else {
      rmSync(livePath, { force: true });
    }
  }

  const targetDirectories = target.entries
    .filter((entry) => entry.working_tree.kind === "directory")
    .sort((left, right) => {
      const depth = pathDepth(left.path) - pathDepth(right.path);
      return depth !== 0
        ? depth
        : Buffer.compare(
            Buffer.from(left.path, "utf8"),
            Buffer.from(right.path, "utf8"),
          );
    });
  for (const entry of targetDirectories) {
    if (entry.working_tree.kind !== "directory") continue;
    const livePath = absoluteWorkspacePath(liveRoot, entry.path);
    const mode = Number.parseInt(
      entry.working_tree.mode_octal,
      8,
    );
    try {
      const stats = lstatSync(livePath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("workspace_subject_restore_path_type_conflict");
      }
    } catch (error) {
      if (
        error instanceof Error
        && error.message
          === "workspace_subject_restore_path_type_conflict"
      ) {
        throw error;
      }
      mkdirSync(livePath, { recursive: false, mode });
    }
    chmodSync(livePath, mode);
  }

  for (const path of changedPaths) {
    const entry = targetByPath.get(path);
    if (!entry || entry.working_tree.kind === "absent") continue;
    if (entry.working_tree.kind === "directory") continue;
    const livePath = absoluteWorkspacePath(liveRoot, path);
    const targetPath = absoluteWorkspacePath(
      materializedTargetRoot,
      path,
    );
    if (entry.working_tree.kind === "regular_file") {
      copyFileSync(
        targetPath,
        livePath,
        fsConstants.COPYFILE_EXCL,
      );
      chmodSync(
        livePath,
        Number.parseInt(entry.working_tree.mode_octal, 8),
      );
      continue;
    }
    symlinkSync(readlinkSync(targetPath), livePath);
  }
}

export function createWorkspaceSubjectStateAdapter(): SubjectStateAdapter {
  const adapter: SubjectStateAdapter = {
    adapterId: WORKSPACE_SUBJECT_ADAPTER_ID,
    adapterVersion: WORKSPACE_SUBJECT_ADAPTER_VERSION,
    capabilities: WORKSPACE_CAPABILITIES,

    supports(subjectKind) {
      return subjectKind === "workspace";
    },

    async identify(input) {
      return subjectFromInput(canonicalInput(input));
    },

    async capture(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      const capture = captureExactWorkspaceState({
        workspace_root: adapterInput.workspace_root,
        subject_state_spec: adapterInput.subject_state_spec,
      });
      const snapshot = StateSnapshotV2Schema.parse({
        contract_version: "state_snapshot_v2",
        snapshot_id: deterministicSubjectContractId("ess2", {
          contract_version: "state_snapshot_identity_v2",
          subject_id: input.subject.subject_id,
          snapshot_identity_seed: input.snapshot_identity_seed,
          algorithm_id: capture.algorithm_id,
          algorithm_version: capture.algorithm_version,
          environment_sha256: capture.environment_digest,
          content_sha256: capture.content_digest,
        }),
        subject: input.subject,
        captured_at: input.captured_at,
        algorithm_id: capture.algorithm_id,
        algorithm_version: capture.algorithm_version,
        environment_sha256: capture.environment_digest,
        content_ref: stateContentRef(capture.content_digest),
        content_sha256: capture.content_digest,
        content_media_type: capture.artifact.media_type,
        content_encoding: capture.artifact.encoding,
        capture_authority: "runtime_adapter",
        attestation_ref: null,
      });
      return Object.freeze({
        snapshot,
        artifact: Object.freeze({
          bytes: capture.artifact.bytes,
          declared_sha256: capture.artifact.declared_sha256,
          declared_byte_length: capture.artifact.declared_byte_length,
          media_type: capture.artifact.media_type,
          encoding: capture.artifact.encoding,
        }),
      });
    },

    async diff(input): Promise<CapturedSubjectDeltaV1> {
      if (
        input.before.snapshot.subject.subject_id
          !== input.after.snapshot.subject.subject_id
      ) {
        throw new Error("workspace_subject_adapter_delta_subject_mismatch");
      }
      const fields = changedFields(
        manifest(input.before),
        manifest(input.after),
      );
      const contentBytes = Buffer.from(stableStringify({
        contract_version: "workspace_state_delta_content_v1",
        subject_id: input.before.snapshot.subject.subject_id,
        before_snapshot_id: input.before.snapshot.snapshot_id,
        after_snapshot_id: input.after.snapshot.snapshot_id,
        before_content_sha256: input.before.snapshot.content_sha256,
        after_content_sha256: input.after.snapshot.content_sha256,
        changed_fields: fields,
      }), "utf8");
      const contentSha256 = sha256(contentBytes);
      const delta = StateDeltaV1Schema.parse({
        contract_version: "state_delta_v1",
        delta_id: deterministicSubjectContractId("esd", {
          contract_version: "state_delta_identity_v1",
          subject_id: input.before.snapshot.subject.subject_id,
          before_snapshot_id: input.before.snapshot.snapshot_id,
          after_snapshot_id: input.after.snapshot.snapshot_id,
          content_sha256: contentSha256,
        }),
        subject_id: input.before.snapshot.subject.subject_id,
        before_snapshot_id: input.before.snapshot.snapshot_id,
        after_snapshot_id: input.after.snapshot.snapshot_id,
        changed_fields: fields,
        content_ref: stateDeltaContentRef(contentSha256),
        content_sha256: contentSha256,
        content_media_type: WORKSPACE_STATE_DELTA_MEDIA_TYPE,
        content_encoding: "utf-8",
      });
      return Object.freeze({
        delta,
        artifact: Object.freeze({
          bytes: contentBytes,
          declared_sha256: contentSha256,
          declared_byte_length: contentBytes.byteLength,
          media_type: WORKSPACE_STATE_DELTA_MEDIA_TYPE,
          encoding: "utf-8",
        }),
      });
    },

    async restoreSnapshot(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      if (
        stableStringify(input.snapshot.subject)
          !== stableStringify(input.subject)
        || input.snapshot.algorithm_id
          !== WORKSPACE_STATE_CAPTURE_ALGORITHM_ID
        || input.snapshot.algorithm_version
          !== WORKSPACE_STATE_CAPTURE_ALGORITHM_VERSION
        || input.snapshot.content_media_type
          !== WORKSPACE_STATE_CAPTURE_MEDIA_TYPE
        || input.snapshot.content_sha256
          !== sha256(input.snapshot_artifact_bytes)
      ) {
        throw new Error(
          "workspace_subject_restore_snapshot_invalid",
        );
      }
      const materialized = materializeVerifierSubjectFromSnapshot({
        snapshotArtifactBytes: input.snapshot_artifact_bytes,
        sourceContentDigest: input.snapshot.content_sha256,
        sourceEnvironmentDigest: input.snapshot.environment_sha256,
      });
      try {
        const target = targetManifest(
          input.snapshot_artifact_bytes,
        );
        if (
          stableStringify(target.capture_policy.subject_state_spec)
            !== stableStringify(adapterInput.subject_state_spec)
        ) {
          throw new Error(
            "workspace_subject_restore_scope_mismatch",
          );
        }
        const current = captureExactWorkspaceState({
          workspace_root: adapterInput.workspace_root,
          subject_state_spec: adapterInput.subject_state_spec,
        });
        if (
          gitStateAuthority(current.manifest)
            !== gitStateAuthority(target)
        ) {
          throw new Error(
            "workspace_subject_restore_git_authority_changed",
          );
        }
        applyWorkspaceManifest(
          adapterInput.workspace_root,
          current.manifest,
          target,
          materialized.subject_root,
        );
        const restored = captureExactWorkspaceState({
          workspace_root: adapterInput.workspace_root,
          subject_state_spec: adapterInput.subject_state_spec,
        });
        if (
          restored.content_digest !== input.snapshot.content_sha256
          || restored.environment_digest
            !== input.snapshot.environment_sha256
          || !restored.artifact.bytes.equals(
            Buffer.from(input.snapshot_artifact_bytes),
          )
        ) {
          throw new Error(
            "workspace_subject_restore_verification_failed",
          );
        }
      } finally {
        materialized.cleanup();
      }
    },

    async materializeForVerifier(input) {
      if (input.snapshot.subject.adapter_id !== WORKSPACE_SUBJECT_ADAPTER_ID) {
        throw new Error(
          "workspace_subject_adapter_materialization_subject_mismatch",
        );
      }
      const native = materializeVerifierSubjectFromSnapshot({
        snapshotArtifactBytes: input.snapshot_artifact_bytes,
        sourceContentDigest: input.snapshot.content_sha256,
        sourceEnvironmentDigest: input.snapshot.environment_sha256,
      });
      return Object.freeze({
        contract_version: "subject_verifier_materialization_v1",
        subject: input.snapshot.subject,
        source_snapshot_id: input.snapshot.snapshot_id,
        source_content_sha256: input.snapshot.content_sha256,
        source_environment_sha256: input.snapshot.environment_sha256,
        materialization_id: native.materialization_id,
        subject_root: native.subject_root,
        scratch_root: native.scratch_root,
        native_handle: native,
        cleanup: native.cleanup,
      });
    },
  };
  return Object.freeze(adapter);
}
