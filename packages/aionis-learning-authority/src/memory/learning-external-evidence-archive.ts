import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import stableStringify from "fast-json-stable-stringify";

import {
  parseCanonicalLearningExternalAttemptChainJson,
  parseCanonicalLearningExternalEvidenceReportJson,
  parseCanonicalLearningExternalEvidenceRunBundleJson,
  parseCanonicalLearningExternalLifecycleAuthorityProjectionJson,
  parseCanonicalLearningExternalRunnerOutputManifestJson,
  parseCanonicalLearningExternalTerminalRunManifestJson,
  validateLearningExternalEvidenceContractSetV1,
  type LearningExternalEvidenceValidatedContractSetV1,
} from "./learning-external-evidence.js";
import {
  learningExternalPublicRunAuthorityDigest,
  parseCanonicalLearningExternalPublicRunAuthorityJson,
  type LearningExternalPublicRunAuthorityV1,
} from "./learning-external-public-authority.js";

/*
 * The v1 archive is a deterministic, non-extracting byte envelope:
 *
 *   magic
 *   uint32be run_bundle_manifest_length
 *   canonical run-bundle manifest bytes
 *   uint32be member_count
 *   repeated in manifest path order:
 *     uint16be path_utf8_length
 *     canonical relative POSIX path bytes
 *     uint64be member_byte_length
 *     raw member bytes
 *
 * A binary envelope avoids base64 expansion and JavaScript string-size limits
 * for a source/supporting member. Paths are labels checked against the signed
 * manifest; this module never resolves or extracts them. The archive digest is
 * SHA-256 of the exact outer bytes and therefore sits strictly outside the run
 * bundle manifest, preserving the existing acyclic content graph.
 */
export const LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC =
  "AIONIS_LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1\n";

const ARCHIVE_MAGIC_BYTES = Buffer.from(
  LEARNING_EXTERNAL_EVIDENCE_ARCHIVE_V1_MAGIC,
  "ascii",
);
const MAX_RUN_BUNDLE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_MEMBERS = 4_096;
const MAX_MEMBER_PATH_BYTES = 512;
const MAX_BUNDLE_MEMBER_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = ARCHIVE_MAGIC_BYTES.byteLength
  + 4
  + MAX_RUN_BUNDLE_MANIFEST_BYTES
  + 4
  + (MAX_BUNDLE_MEMBERS * (2 + MAX_MEMBER_PATH_BYTES + 8))
  + MAX_BUNDLE_BYTES;

const STRUCTURED_MEMBER_LIMITS = Object.freeze({
  report: 512 * 1024,
  attempt_chain: 8 * 1024 * 1024,
  runner_output_manifest: 1024 * 1024,
  terminal_run_manifest: 1024 * 1024,
  lifecycle_authority_projection: 4 * 1024 * 1024,
  public_run_authority: 32 * 1024 * 1024,
} as const);

type StructuredMemberRole = keyof typeof STRUCTURED_MEMBER_LIMITS;

export type LearningExternalEvidenceArchiveByteSourceV1 = Readonly<{
  byteLength: number;
  readExactly(offset: number, length: number): Uint8Array;
}>;

const archiveProofBrand: unique symbol = Symbol("learning-external-evidence-archive-proof-v1");

export type LearningExternalEvidenceArchiveProofV1 = Readonly<{
  [archiveProofBrand]: "aionis_learning_external_evidence_archive_proof_v1";
}>;

export type LearningExternalEvidenceArchiveProofProjectionV1 = Readonly<{
  contract_version: "aionis_learning_external_evidence_archive_proof_projection_v1";
  raw_archive_sha256: string;
  raw_archive_byte_length: number;
  run_bundle_manifest_sha256: string;
  public_run_authority_sha256: string;
  evidence_binding_sha256: string;
}>;

const archiveProofRegistry = new WeakMap<object, LearningExternalEvidenceArchiveProofProjectionV1>();

export type LearningExternalEvidenceArchiveValidationV1 = Readonly<{
  contracts: LearningExternalEvidenceValidatedContractSetV1;
  publicRunAuthority: LearningExternalPublicRunAuthorityV1;
  rawArchiveSha256: string;
  rawArchiveByteLength: number;
  runBundleManifestSha256: string;
  proof: LearningExternalEvidenceArchiveProofV1;
}>;

function archiveError(reason: string): Error {
  return new Error(`learning_external_evidence_archive_invalid:${reason}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceBytes(
  source: LearningExternalEvidenceArchiveByteSourceV1,
  sourceByteLength: number,
  offset: number,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 0
    || offset > sourceByteLength
    || length > sourceByteLength - offset) {
    throw archiveError("truncated_or_out_of_bounds");
  }
  let bytes: Uint8Array;
  try {
    bytes = source.readExactly(offset, length);
  } catch {
    throw archiveError("source_read_failed");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw archiveError("source_read_not_exact");
  }
  if (Object.prototype.toString.call(bytes.buffer) === "[object SharedArrayBuffer]") {
    throw archiveError("source_read_shared_mutable_bytes");
  }
  return bytes;
}

function bufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function uint16be(bytes: Uint8Array): number {
  return bufferView(bytes).readUInt16BE(0);
}

function uint32be(bytes: Uint8Array): number {
  return bufferView(bytes).readUInt32BE(0);
}

function uint64be(bytes: Uint8Array): number {
  const value = bufferView(bytes).readBigUInt64BE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw archiveError("member_length_not_safe_integer");
  }
  return Number(value);
}

function decodeCanonicalPath(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEMBER_PATH_BYTES) {
    throw archiveError("member_path_length");
  }
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw archiveError("member_path_utf8");
  }
  if (!bufferView(bytes).equals(Buffer.from(path, "utf8"))) {
    throw archiveError("member_path_noncanonical_utf8");
  }
  const parts = path.split("/");
  if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(path)
    || path !== path.trim()
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw archiveError("member_path_alias");
  }
  return path;
}

function allocateStructuredMember(role: StructuredMemberRole, byteLength: number): Buffer {
  if (byteLength > STRUCTURED_MEMBER_LIMITS[role]) {
    throw archiveError(`${role}_byte_limit`);
  }
  return Buffer.allocUnsafe(byteLength);
}

function isStructuredMemberRole(value: string): value is StructuredMemberRole {
  return Object.hasOwn(STRUCTURED_MEMBER_LIMITS, value);
}

function parseStructuredMember(role: StructuredMemberRole, bytes: Uint8Array): unknown {
  switch (role) {
    case "report":
      return parseCanonicalLearningExternalEvidenceReportJson(bytes);
    case "attempt_chain":
      return parseCanonicalLearningExternalAttemptChainJson(bytes);
    case "runner_output_manifest":
      return parseCanonicalLearningExternalRunnerOutputManifestJson(bytes);
    case "terminal_run_manifest":
      return parseCanonicalLearningExternalTerminalRunManifestJson(bytes);
    case "lifecycle_authority_projection":
      return parseCanonicalLearningExternalLifecycleAuthorityProjectionJson(bytes);
    case "public_run_authority":
      return parseCanonicalLearningExternalPublicRunAuthorityJson(bytes);
  }
}

function exactCanonicalObject(label: string, actual: unknown, expected: unknown): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw archiveError(`public_authority_${label}_mismatch`);
  }
}

function issueArchiveProof(
  projection: LearningExternalEvidenceArchiveProofProjectionV1,
): LearningExternalEvidenceArchiveProofV1 {
  const proof = Object.freeze(Object.create(null)) as LearningExternalEvidenceArchiveProofV1;
  archiveProofRegistry.set(proof, Object.freeze({ ...projection }));
  return proof;
}

export function readLearningExternalEvidenceArchiveProofV1(
  proof: unknown,
): LearningExternalEvidenceArchiveProofProjectionV1 {
  if ((typeof proof !== "object" && typeof proof !== "function") || proof === null) {
    throw archiveError("unrecognized_proof");
  }
  const projection = archiveProofRegistry.get(proof);
  if (!projection) throw archiveError("unrecognized_proof");
  return projection;
}

export function learningExternalEvidenceArchiveSourceFromBytes(
  bytes: Uint8Array,
): LearningExternalEvidenceArchiveByteSourceV1 {
  if (!(bytes instanceof Uint8Array)) throw archiveError("expected_bytes");
  if (Object.prototype.toString.call(bytes.buffer) === "[object SharedArrayBuffer]") {
    throw archiveError("shared_mutable_bytes");
  }
  return Object.freeze({
    byteLength: bytes.byteLength,
    readExactly(offset: number, length: number): Uint8Array {
      if (!Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length < 0
        || offset > bytes.byteLength
        || length > bytes.byteLength - offset) {
        throw archiveError("truncated_or_out_of_bounds");
      }
      return bytes.subarray(offset, offset + length);
    },
  });
}

export function verifyLearningExternalEvidenceArchiveV1(
  source: LearningExternalEvidenceArchiveByteSourceV1,
): LearningExternalEvidenceArchiveValidationV1 {
  if (!source || typeof source !== "object" || typeof source.readExactly !== "function") {
    throw archiveError("expected_byte_source");
  }
  const sourceByteLength = source.byteLength;
  if (!Number.isSafeInteger(sourceByteLength)
    || sourceByteLength < ARCHIVE_MAGIC_BYTES.byteLength + 12
    || sourceByteLength > MAX_ARCHIVE_BYTES) {
    throw archiveError("archive_byte_length");
  }

  const outerHash = createHash("sha256");
  let offset = 0;
  const readFrame = (length: number): Uint8Array => {
    const bytes = sourceBytes(source, sourceByteLength, offset, length);
    outerHash.update(bytes);
    offset += length;
    return bytes;
  };
  const readBuffered = (length: number): Buffer => {
    const target = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunkLength = Math.min(READ_CHUNK_BYTES, length - written);
      const chunk = readFrame(chunkLength);
      bufferView(chunk).copy(target, written);
      written += chunkLength;
    }
    return target;
  };

  const magic = readFrame(ARCHIVE_MAGIC_BYTES.byteLength);
  if (!bufferView(magic).equals(ARCHIVE_MAGIC_BYTES)) {
    throw archiveError("magic");
  }
  const manifestLength = uint32be(readFrame(4));
  if (manifestLength === 0 || manifestLength > MAX_RUN_BUNDLE_MANIFEST_BYTES) {
    throw archiveError("run_bundle_manifest_byte_length");
  }
  const manifestBytes = readBuffered(manifestLength);
  const runBundle = parseCanonicalLearningExternalEvidenceRunBundleJson(manifestBytes);
  const runBundleManifestSha256 = sha256(manifestBytes);

  const memberCount = uint32be(readFrame(4));
  if (memberCount > MAX_BUNDLE_MEMBERS) throw archiveError("member_count_limit");
  if (memberCount !== runBundle.members.length) {
    throw archiveError(memberCount < runBundle.members.length
      ? "missing_member"
      : "extra_member");
  }

  const parsedStructuredMembers = new Map<StructuredMemberRole, unknown>();
  const seenPaths = new Set<string>();
  let aggregateMemberBytes = 0;
  for (let index = 0; index < memberCount; index += 1) {
    const expected = runBundle.members[index]!;
    const pathLength = uint16be(readFrame(2));
    const path = decodeCanonicalPath(readFrame(pathLength));
    if (seenPaths.has(path)) throw archiveError("duplicate_member_path");
    seenPaths.add(path);
    if (path !== expected.path) {
      const existsElsewhere = runBundle.members.some((member) => member.path === path);
      throw archiveError(existsElsewhere ? "member_order" : "member_path_alias");
    }

    const memberLength = uint64be(readFrame(8));
    if (memberLength > MAX_BUNDLE_MEMBER_BYTES) throw archiveError("member_byte_limit");
    aggregateMemberBytes += memberLength;
    if (!Number.isSafeInteger(aggregateMemberBytes)
      || aggregateMemberBytes > MAX_BUNDLE_BYTES) {
      throw archiveError("aggregate_member_byte_limit");
    }
    if (memberLength !== expected.byte_length) {
      throw archiveError("member_byte_length_mismatch");
    }

    const role = expected.role;
    const structuredRole = isStructuredMemberRole(role) ? role : null;
    const structuredBytes = structuredRole !== null
      ? allocateStructuredMember(structuredRole, memberLength)
      : null;
    const memberHash = createHash("sha256");
    let memberOffset = 0;
    while (memberOffset < memberLength) {
      const chunkLength = Math.min(READ_CHUNK_BYTES, memberLength - memberOffset);
      const chunk = readFrame(chunkLength);
      memberHash.update(chunk);
      if (structuredBytes) bufferView(chunk).copy(structuredBytes, memberOffset);
      memberOffset += chunkLength;
    }
    if (memberHash.digest("hex") !== expected.sha256) {
      throw archiveError("member_sha256_mismatch");
    }
    if (structuredBytes && structuredRole !== null) {
      parsedStructuredMembers.set(
        structuredRole,
        parseStructuredMember(structuredRole, structuredBytes),
      );
    }
  }
  if (offset !== sourceByteLength) throw archiveError("trailing_bytes");

  const lifecycleAuthorityProjection = parsedStructuredMembers.get(
    "lifecycle_authority_projection",
  );
  const report = parsedStructuredMembers.get("report");
  const attemptChain = parsedStructuredMembers.get("attempt_chain");
  const runnerOutputManifest = parsedStructuredMembers.get("runner_output_manifest");
  const terminalRunManifest = parsedStructuredMembers.get("terminal_run_manifest");
  const publicRunAuthority = parsedStructuredMembers.get("public_run_authority") as
    LearningExternalPublicRunAuthorityV1 | undefined;
  if (!lifecycleAuthorityProjection || !report || !attemptChain || !runnerOutputManifest
    || !terminalRunManifest || !publicRunAuthority) {
    throw archiveError("missing_structured_member");
  }

  const publicRunAuthoritySha256 = learningExternalPublicRunAuthorityDigest(
    publicRunAuthority,
  );
  const contracts = validateLearningExternalEvidenceContractSetV1({
    lifecycleAuthorityProjection,
    report,
    attemptChain,
    runnerOutputManifest,
    terminalRunManifest,
    publicRunAuthoritySha256,
    runBundle,
  });
  const payload = publicRunAuthority.payload;
  exactCanonicalObject("report", report, payload.report);
  exactCanonicalObject("attempt_chain", attemptChain, payload.attempt_chain);
  exactCanonicalObject(
    "runner_output_manifest",
    runnerOutputManifest,
    payload.runner_output_manifest,
  );
  exactCanonicalObject(
    "terminal_run_manifest",
    terminalRunManifest,
    payload.terminal_run_manifest,
  );
  exactCanonicalObject(
    "lifecycle_authority_projection",
    lifecycleAuthorityProjection,
    payload.lifecycle_authority_projection,
  );

  const rawArchiveSha256 = outerHash.digest("hex");
  const proof = issueArchiveProof({
    contract_version: "aionis_learning_external_evidence_archive_proof_projection_v1",
    raw_archive_sha256: rawArchiveSha256,
    raw_archive_byte_length: sourceByteLength,
    run_bundle_manifest_sha256: runBundleManifestSha256,
    public_run_authority_sha256: publicRunAuthoritySha256,
    evidence_binding_sha256: runBundle.evidence_binding_sha256,
  });
  return Object.freeze({
    contracts,
    publicRunAuthority,
    rawArchiveSha256,
    rawArchiveByteLength: sourceByteLength,
    runBundleManifestSha256,
    proof,
  });
}

export function verifyLearningExternalEvidenceArchiveBytesV1(
  bytes: Uint8Array,
): LearningExternalEvidenceArchiveValidationV1 {
  return verifyLearningExternalEvidenceArchiveV1(
    learningExternalEvidenceArchiveSourceFromBytes(bytes),
  );
}
