import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  StructuredArtifactSubjectStateSpecV1Schema,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
  type StructuredArtifactSubjectStateSpecV1,
} from "../memory/execution-episode.js";
import {
  materializeVerifierFileSubjectFromSnapshot,
} from "./verifier-subject-materialization.js";
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
  type StateSnapshotV2,
  type SubjectStateAdapter,
} from "./subject-state-adapter.js";

export const STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_ID =
  "structured_artifact_subject_v1";
export const STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_VERSION = "1";
export const STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID =
  "aionis_structured_artifact_state_capture";
export const STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION = "1";
export const STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE =
  "application/json";
export const STRUCTURED_ARTIFACT_DELTA_MEDIA_TYPE =
  "application/vnd.aionis.structured-artifact-delta.v1+json";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_NODES = 1_000_000;
const MAX_JSON_DEPTH = 512;
const MAX_CHANGED_FIELDS = 200_000;

type JsonPrimitive = null | boolean | number | string;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type StructuredArtifactSubjectAdapterInputV1 = Readonly<{
  artifact_path: string;
  subject_state_spec?: StructuredArtifactSubjectStateSpecV1;
}>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalInput(value: unknown): Readonly<{
  artifact_path: string;
  subject_state_spec: StructuredArtifactSubjectStateSpecV1;
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
    throw new Error("structured_artifact_subject_adapter_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length < 1
    || keys.length > 2
    || !Object.hasOwn(record, "artifact_path")
    || keys.some(
      (key) => key !== "artifact_path" && key !== "subject_state_spec",
    )
    || typeof record.artifact_path !== "string"
    || record.artifact_path.length === 0
    || record.artifact_path.includes("\u0000")
    || record.artifact_path.includes("\r")
    || record.artifact_path.includes("\n")
    || Buffer.byteLength(record.artifact_path, "utf8") > 4 * 1024
  ) {
    throw new Error("structured_artifact_subject_adapter_input_invalid");
  }
  let artifactPath: string;
  try {
    artifactPath = realpathSync.native(record.artifact_path);
    const stats = lstatSync(artifactPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("not_regular_file");
    }
  } catch {
    throw new Error("structured_artifact_subject_adapter_path_unavailable");
  }
  const subjectStateSpec = StructuredArtifactSubjectStateSpecV1Schema.parse(
    record.subject_state_spec ?? {
      contract_version: "structured_artifact_subject_state_spec_v1",
      format: "json",
      capture_scope: "entire_artifact",
    },
  );
  return Object.freeze({
    artifact_path: artifactPath,
    subject_state_spec: subjectStateSpec,
  });
}

const STRUCTURED_ARTIFACT_CAPABILITIES =
  SubjectCapabilityDescriptorV1Schema.parse({
    contract_version: "subject_capability_descriptor_v1",
    subject_kind: "artifact",
    capabilities: [
      "capture",
      "delta",
      "restore",
      "runtime_owned_capture",
      "verifier_materialization",
    ],
    snapshot_media_types: [STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE],
    delta_media_types: [STRUCTURED_ARTIFACT_DELTA_MEDIA_TYPE],
  });

function subjectFromInput(input: ReturnType<typeof canonicalInput>) {
  const identityMaterial = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: "artifact" as const,
    canonical_root_sha256: sha256(
      Buffer.from(input.artifact_path, "utf8"),
    ),
    capture_algorithm_id: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
    capture_algorithm_version:
      STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
    subject_state_spec: input.subject_state_spec,
    subject_state_spec_sha256:
      executionEpisodeSubjectStateSpecDigest(input.subject_state_spec),
  };
  const identitySha256 =
    executionEpisodeSubjectIdentityDigest(identityMaterial);
  const capabilitySha256 = subjectCapabilityDescriptorDigest(
    STRUCTURED_ARTIFACT_CAPABILITIES,
  );
  return ExecutionSubjectV1Schema.parse({
    contract_version: "execution_subject_v1",
    subject_id: executionSubjectId(identitySha256),
    kind: "artifact",
    adapter_id: STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_ID,
    adapter_version: STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_VERSION,
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
    throw new Error("structured_artifact_subject_adapter_identity_mismatch");
  }
}

function parseJson(bytes: Uint8Array): JsonValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("structured_artifact_subject_utf8_invalid");
  }
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new Error("structured_artifact_subject_utf8_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("structured_artifact_subject_json_invalid");
  }
  const stack: Array<Readonly<{
    value: unknown;
    depth: number;
  }>> = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new Error("structured_artifact_subject_json_limits_exceeded");
    }
    if (
      current.value === null
      || typeof current.value === "string"
      || typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        throw new Error("structured_artifact_subject_json_number_invalid");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (
      typeof current.value !== "object"
      || Object.getPrototypeOf(current.value) !== Object.prototype
    ) {
      throw new Error("structured_artifact_subject_json_value_invalid");
    }
    for (const item of Object.values(
      current.value as Record<string, unknown>,
    )) {
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return parsed as JsonValue;
}

function readArtifactOnce(path: string): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.size > MAX_ARTIFACT_BYTES
      || before.size < 0
    ) {
      throw new Error("structured_artifact_subject_size_invalid");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.byteLength !== after.size
    ) {
      throw new Error("structured_artifact_subject_changed_during_capture");
    }
    parseJson(bytes);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readStableArtifact(path: string): Buffer {
  const first = readArtifactOnce(path);
  const second = readArtifactOnce(path);
  if (!first.equals(second)) {
    throw new Error("structured_artifact_subject_changed_during_capture");
  }
  return second;
}

function jsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function changedField(path: readonly string[]): string {
  const reference = path.length === 0
    ? "json:$"
    : `json:/${path.map(jsonPointerToken).join("/")}`;
  if (Buffer.byteLength(reference, "utf8") <= 2_048) return reference;
  return `json:sha256:${sha256(Buffer.from(reference, "utf8"))}`;
}

function jsonChangedFields(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): string[] {
  const before = parseJson(beforeBytes);
  const after = parseJson(afterBytes);
  const changed = new Set<string>();
  const stack: Array<Readonly<{
    before: JsonValue | undefined;
    after: JsonValue | undefined;
    path: readonly string[];
    beforePresent: boolean;
    afterPresent: boolean;
  }>> = [{
    before,
    after,
    path: [],
    beforePresent: true,
    afterPresent: true,
  }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      !current.beforePresent
      || !current.afterPresent
      || current.before === null
      || current.after === null
      || typeof current.before !== "object"
      || typeof current.after !== "object"
      || Array.isArray(current.before) !== Array.isArray(current.after)
    ) {
      if (
        current.beforePresent !== current.afterPresent
        || !Object.is(current.before, current.after)
      ) {
        changed.add(changedField(current.path));
      }
      continue;
    }
    if (Array.isArray(current.before) && Array.isArray(current.after)) {
      if (current.before.length !== current.after.length) {
        changed.add(changedField([...current.path, "length"]));
      }
      const length = Math.max(current.before.length, current.after.length);
      for (let index = 0; index < length; index += 1) {
        stack.push({
          before: current.before[index],
          after: current.after[index],
          path: [...current.path, String(index)],
          beforePresent: index < current.before.length,
          afterPresent: index < current.after.length,
        });
      }
    } else {
      const beforeRecord = current.before as Record<string, JsonValue>;
      const afterRecord = current.after as Record<string, JsonValue>;
      const keys = [...new Set([
        ...Object.keys(beforeRecord),
        ...Object.keys(afterRecord),
      ])].sort(compareUtf8);
      for (const key of keys) {
        stack.push({
          before: beforeRecord[key],
          after: afterRecord[key],
          path: [...current.path, key],
          beforePresent: Object.hasOwn(beforeRecord, key),
          afterPresent: Object.hasOwn(afterRecord, key),
        });
      }
    }
    if (changed.size > MAX_CHANGED_FIELDS) {
      return ["json:$bulk-change"];
    }
  }
  if (
    changed.size === 0
    && !Buffer.from(beforeBytes).equals(Buffer.from(afterBytes))
  ) {
    changed.add("json:$serialization");
  }
  return [...changed].sort(compareUtf8);
}

function capturedArtifact(
  captured: CapturedSubjectStateV2,
): Buffer {
  if (
    captured.snapshot.content_media_type
      !== STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE
    || captured.snapshot.content_encoding !== "utf-8"
    || sha256(captured.artifact.bytes)
      !== captured.snapshot.content_sha256
  ) {
    throw new Error("structured_artifact_subject_snapshot_invalid");
  }
  parseJson(captured.artifact.bytes);
  return captured.artifact.bytes;
}

function assertRestorableSnapshot(
  snapshot: StateSnapshotV2,
  subject: ExecutionSubjectV1,
  bytes: Uint8Array,
): Buffer {
  const content = Buffer.from(bytes);
  if (
    stableStringify(snapshot.subject) !== stableStringify(subject)
    || snapshot.algorithm_id !== STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID
    || snapshot.algorithm_version
      !== STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION
    || snapshot.environment_sha256 !== ENVIRONMENT_SHA256
    || snapshot.content_media_type
      !== STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE
    || snapshot.content_encoding !== "utf-8"
    || snapshot.content_sha256 !== sha256(content)
  ) {
    throw new Error(
      "structured_artifact_subject_restore_snapshot_invalid",
    );
  }
  parseJson(content);
  return content;
}

const ENVIRONMENT_SHA256 = sha256(Buffer.from(stableStringify({
  contract_version: "structured_artifact_capture_environment_v1",
  algorithm_id: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
  algorithm_version: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
  format: "json",
  max_artifact_bytes: MAX_ARTIFACT_BYTES,
  max_json_depth: MAX_JSON_DEPTH,
  max_json_nodes: MAX_JSON_NODES,
}), "utf8"));

export function createStructuredArtifactSubjectStateAdapter():
SubjectStateAdapter {
  const adapter: SubjectStateAdapter = {
    adapterId: STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_ID,
    adapterVersion: STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_VERSION,
    capabilities: STRUCTURED_ARTIFACT_CAPABILITIES,

    supports(subjectKind) {
      return subjectKind === "artifact";
    },

    async identify(input) {
      return subjectFromInput(canonicalInput(input));
    },

    async capture(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      const bytes = readStableArtifact(adapterInput.artifact_path);
      const contentSha256 = sha256(bytes);
      const snapshot = StateSnapshotV2Schema.parse({
        contract_version: "state_snapshot_v2",
        snapshot_id: deterministicSubjectContractId("ess2", {
          contract_version: "state_snapshot_identity_v2",
          subject_id: input.subject.subject_id,
          snapshot_identity_seed: input.snapshot_identity_seed,
          algorithm_id: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
          algorithm_version:
            STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
          environment_sha256: ENVIRONMENT_SHA256,
          content_sha256: contentSha256,
        }),
        subject: input.subject,
        captured_at: input.captured_at,
        algorithm_id: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_ID,
        algorithm_version: STRUCTURED_ARTIFACT_CAPTURE_ALGORITHM_VERSION,
        environment_sha256: ENVIRONMENT_SHA256,
        content_ref: stateContentRef(contentSha256),
        content_sha256: contentSha256,
        content_media_type: STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE,
        content_encoding: "utf-8",
        capture_authority: "runtime_adapter",
        attestation_ref: null,
      });
      return Object.freeze({
        snapshot,
        artifact: Object.freeze({
          bytes,
          declared_sha256: contentSha256,
          declared_byte_length: bytes.byteLength,
          media_type: STRUCTURED_ARTIFACT_STATE_MEDIA_TYPE,
          encoding: "utf-8",
        }),
      });
    },

    async diff(input): Promise<CapturedSubjectDeltaV1> {
      if (
        input.before.snapshot.subject.subject_id
          !== input.after.snapshot.subject.subject_id
      ) {
        throw new Error(
          "structured_artifact_subject_adapter_delta_subject_mismatch",
        );
      }
      const fields = jsonChangedFields(
        capturedArtifact(input.before),
        capturedArtifact(input.after),
      );
      const contentBytes = Buffer.from(stableStringify({
        contract_version: "structured_artifact_delta_content_v1",
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
        delta_id: deterministicSubjectContractId("esd1", {
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
        content_media_type: STRUCTURED_ARTIFACT_DELTA_MEDIA_TYPE,
        content_encoding: "utf-8",
      });
      return Object.freeze({
        delta,
        artifact: Object.freeze({
          bytes: contentBytes,
          declared_sha256: contentSha256,
          declared_byte_length: contentBytes.byteLength,
          media_type: STRUCTURED_ARTIFACT_DELTA_MEDIA_TYPE,
          encoding: "utf-8",
        }),
      });
    },

    async restoreSnapshot(input) {
      const adapterInput = canonicalInput(input.adapter_input);
      const expectedSubject = subjectFromInput(adapterInput);
      assertSubjectMatches(input.subject, expectedSubject);
      const bytes = assertRestorableSnapshot(
        input.snapshot,
        input.subject,
        input.snapshot_artifact_bytes,
      );
      const currentMode =
        lstatSync(adapterInput.artifact_path).mode & 0o777;
      const temporaryPath = join(
        dirname(adapterInput.artifact_path),
        `.${basename(adapterInput.artifact_path)}.aionis-restore-${
          randomUUID()
        }.tmp`,
      );
      try {
        writeFileSync(temporaryPath, bytes, {
          flag: "wx",
          mode: currentMode,
        });
        chmodSync(temporaryPath, currentMode);
        renameSync(temporaryPath, adapterInput.artifact_path);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
      const restored = readStableArtifact(adapterInput.artifact_path);
      if (
        sha256(restored) !== input.snapshot.content_sha256
        || !restored.equals(bytes)
      ) {
        throw new Error(
          "structured_artifact_subject_restore_verification_failed",
        );
      }
    },

    async materializeForVerifier(input) {
      if (
        input.snapshot.subject.adapter_id
          !== STRUCTURED_ARTIFACT_SUBJECT_ADAPTER_ID
      ) {
        throw new Error(
          "structured_artifact_subject_materialization_subject_mismatch",
        );
      }
      parseJson(input.snapshot_artifact_bytes);
      const native = materializeVerifierFileSubjectFromSnapshot({
        snapshotArtifactBytes: input.snapshot_artifact_bytes,
        sourceContentDigest: input.snapshot.content_sha256,
        sourceEnvironmentDigest: input.snapshot.environment_sha256,
        subjectStateSpec: {
          contract_version: "structured_artifact_subject_state_spec_v1",
          format: "json",
          capture_scope: "entire_artifact",
        },
        stateKind: "artifact",
        algorithmId: input.snapshot.algorithm_id,
        algorithmVersion: input.snapshot.algorithm_version,
        subjectFileName: "artifact.json",
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
