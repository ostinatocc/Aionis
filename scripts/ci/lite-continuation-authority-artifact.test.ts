import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  AuthorityArtifactError,
  authorityArtifactPublicKeySha256,
  buildSignedAuthorityArtifactV1,
  verifySignedAuthorityArtifactV1,
  type SignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.ts";
import { canonicalContinuationSha256 } from "../../src/continuation/contract.ts";

const SIGNER_KEYS = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(64);

function buildInput() {
  return {
    tenant_id: "tenant-authority",
    artifact_id: "compiler-policy-main",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "compiler_policy_v1",
    authority_subject_sha256: SHA_A,
    payload: {
      payload: {
        algorithm: "bounded_greedy_coverage_v1",
        candidate_limit: 128,
        labels: ["连续性", "governed-learning"],
      },
      metadata: {
        issuer: "offline-authority",
        release: 1,
      },
    },
    valid_from: "2026-07-21T01:00:00.000Z",
    expires_at: "2026-08-21T01:00:00.000Z",
    created_at: "2026-07-21T00:00:00.000Z",
  } as const;
}

function mutableArtifact(value: SignedAuthorityArtifactV1): Record<string, any> {
  return JSON.parse(JSON.stringify(value)) as Record<string, any>;
}

function identityBody(value: SignedAuthorityArtifactV1 | Record<string, any>) {
  return {
    tenant_id: value.tenant_id,
    artifact_id: value.artifact_id,
    artifact_revision: value.artifact_revision,
    artifact_kind: value.artifact_kind,
    artifact_schema: value.artifact_schema,
    authority_subject_sha256: value.authority_subject_sha256,
    payload: value.payload,
    payload_sha256: value.payload_sha256,
    signer_principal_sha256: value.signer_principal_sha256,
    trust_root_sha256: value.trust_root_sha256,
    signature_algorithm: value.signature_algorithm,
    valid_from: value.valid_from,
    expires_at: value.expires_at,
    created_at: value.created_at,
  };
}

function assertAuthorityFailure(
  operation: () => unknown,
  code?: AuthorityArtifactError["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof AuthorityArtifactError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("signed authority artifact uses a real Ed25519 trust root and returns detached frozen authority", () => {
  const source = buildInput();
  const signed = buildSignedAuthorityArtifactV1(source, SIGNER_KEYS.privateKey);
  const root = authorityArtifactPublicKeySha256(SIGNER_KEYS.publicKey);
  const expectedRoot = createHash("sha256")
    .update(SIGNER_KEYS.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");

  assert.equal(root, expectedRoot);
  assert.equal(signed.payload_sha256, canonicalContinuationSha256(source.payload));
  assert.equal(signed.artifact_sha256, canonicalContinuationSha256(identityBody(signed)));
  assert.notEqual(signed.artifact_sha256, signed.payload_sha256);
  assert.equal(signed.signer_principal_sha256, root);
  assert.equal(signed.trust_root_sha256, root);
  assert.equal(signed.signature_algorithm, "ed25519");
  assert.equal(Buffer.from(signed.signature, "base64url").length, 64);
  assert.equal(signed.signature.includes("="), false);
  assert.equal(Object.isFrozen(signed), true);
  assert.equal(Object.isFrozen(signed.payload), true);
  assert.equal(Object.isFrozen((signed.payload as any).payload), true);

  (source.payload.payload as any).candidate_limit = 999;
  assert.equal((signed.payload as any).payload.candidate_limit, 128);

  const verified = verifySignedAuthorityArtifactV1(signed, SIGNER_KEYS.publicKey);
  assert.deepEqual(verified, signed);
  assert.notEqual(verified, signed);
  assert.notEqual(verified.payload, signed.payload);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen((verified.payload as any).metadata), true);
});

test("full artifact identity changes across id, revision, subject, and validity while payload identity remains stable", () => {
  const base = buildInput();
  const artifacts = [
    buildSignedAuthorityArtifactV1(base, SIGNER_KEYS.privateKey),
    buildSignedAuthorityArtifactV1({ ...base, artifact_id: "compiler-policy-renamed" }, SIGNER_KEYS.privateKey),
    buildSignedAuthorityArtifactV1({ ...base, artifact_revision: 2 }, SIGNER_KEYS.privateKey),
    buildSignedAuthorityArtifactV1({ ...base, authority_subject_sha256: "b".repeat(64) }, SIGNER_KEYS.privateKey),
    buildSignedAuthorityArtifactV1({
      ...base,
      valid_from: "2026-07-22T01:00:00.000Z",
      expires_at: "2026-08-22T01:00:00.000Z",
    }, SIGNER_KEYS.privateKey),
  ];
  assert.equal(new Set(artifacts.map((artifact) => artifact.payload_sha256)).size, 1);
  assert.equal(new Set(artifacts.map((artifact) => artifact.artifact_sha256)).size, artifacts.length);
  assert.equal(new Set(artifacts.map((artifact) => artifact.signature)).size, artifacts.length);
  for (const artifact of artifacts) {
    assert.equal(artifact.artifact_sha256, canonicalContinuationSha256(identityBody(artifact)));
    assert.deepEqual(verifySignedAuthorityArtifactV1(artifact, SIGNER_KEYS.publicKey), artifact);
  }
});

test("authority artifact kinds include signed policy rotation and remain closed", () => {
  for (const artifact_kind of [
    "compiler_policy", "evidence_policy", "experiment_cohort", "policy_rotation",
  ] as const) {
    const signed = buildSignedAuthorityArtifactV1({
      ...buildInput(),
      artifact_id: `artifact-${artifact_kind}`,
      artifact_kind,
      authority_subject_sha256: artifact_kind === "experiment_cohort"
        || artifact_kind === "policy_rotation" ? SHA_A : null,
      expires_at: null,
    }, SIGNER_KEYS.privateKey);
    assert.equal(
      verifySignedAuthorityArtifactV1(signed, SIGNER_KEYS.publicKey).artifact_kind,
      artifact_kind,
    );
  }
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    artifact_kind: "deployment_policy",
  }, SIGNER_KEYS.privateKey));

  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    artifact_kind: "experiment_cohort",
    authority_subject_sha256: null,
  }, SIGNER_KEYS.privateKey));

  const globalCompilerPolicy = buildSignedAuthorityArtifactV1({
    ...buildInput(),
    authority_subject_sha256: null,
  }, SIGNER_KEYS.privateKey);
  const forgedCohort = mutableArtifact(globalCompilerPolicy);
  forgedCohort.artifact_kind = "experiment_cohort";
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(forgedCohort, SIGNER_KEYS.publicKey),
    "invalid_authority_artifact",
  );
});

test("canonical key reordering produces the same digest, envelope, and deterministic Ed25519 signature", () => {
  const first = buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.privateKey);
  const base = buildInput();
  const reordered = {
    created_at: base.created_at,
    expires_at: base.expires_at,
    valid_from: base.valid_from,
    payload: {
      metadata: { release: 1, issuer: "offline-authority" },
      payload: {
        labels: ["连续性", "governed-learning"],
        candidate_limit: 128,
        algorithm: "bounded_greedy_coverage_v1",
      },
    },
    authority_subject_sha256: base.authority_subject_sha256,
    artifact_schema: base.artifact_schema,
    artifact_kind: base.artifact_kind,
    artifact_revision: base.artifact_revision,
    artifact_id: base.artifact_id,
    tenant_id: base.tenant_id,
  };
  const second = buildSignedAuthorityArtifactV1(reordered, SIGNER_KEYS.privateKey);
  assert.deepEqual(second, first);
  assert.deepEqual(verifySignedAuthorityArtifactV1(reorderedSigned(first), SIGNER_KEYS.publicKey), first);
});

function reorderedSigned(value: SignedAuthorityArtifactV1): Record<string, unknown> {
  return {
    signature: value.signature,
    created_at: value.created_at,
    expires_at: value.expires_at,
    valid_from: value.valid_from,
    signature_algorithm: value.signature_algorithm,
    trust_root_sha256: value.trust_root_sha256,
    signer_principal_sha256: value.signer_principal_sha256,
    artifact_sha256: value.artifact_sha256,
    payload_sha256: value.payload_sha256,
    payload: {
      metadata: { release: 1, issuer: "offline-authority" },
      payload: {
        labels: ["连续性", "governed-learning"],
        candidate_limit: 128,
        algorithm: "bounded_greedy_coverage_v1",
      },
    },
    authority_subject_sha256: value.authority_subject_sha256,
    artifact_schema: value.artifact_schema,
    artifact_kind: value.artifact_kind,
    artifact_revision: value.artifact_revision,
    artifact_id: value.artifact_id,
    tenant_id: value.tenant_id,
  };
}

test("payload and metadata tampering cannot reuse an artifact digest or signature", () => {
  const signed = buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.privateKey);

  const payloadTamper = mutableArtifact(signed);
  payloadTamper.payload.payload.candidate_limit = 129;
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(payloadTamper, SIGNER_KEYS.publicKey),
    "payload_digest_mismatch",
  );

  const metadataTamper = mutableArtifact(signed);
  metadataTamper.payload.metadata.release = 2;
  metadataTamper.payload_sha256 = canonicalContinuationSha256(metadataTamper.payload);
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(metadataTamper, SIGNER_KEYS.publicKey),
    "artifact_digest_mismatch",
  );

  const fullyRedigested = mutableArtifact(signed);
  fullyRedigested.payload.metadata.release = 3;
  fullyRedigested.payload_sha256 = canonicalContinuationSha256(fullyRedigested.payload);
  fullyRedigested.artifact_sha256 = canonicalContinuationSha256(identityBody(fullyRedigested));
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(fullyRedigested, SIGNER_KEYS.publicKey),
    "signature_invalid",
  );
});

test("signature, signer identity, trust root, and pinned key tampering fail closed", () => {
  const signed = buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.privateKey);

  const signatureTamper = mutableArtifact(signed);
  const bytes = Buffer.from(signatureTamper.signature, "base64url");
  bytes[0] ^= 0x01;
  signatureTamper.signature = bytes.toString("base64url");
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(signatureTamper, SIGNER_KEYS.publicKey),
    "signature_invalid",
  );

  const signerTamper = mutableArtifact(signed);
  signerTamper.signer_principal_sha256 = authorityArtifactPublicKeySha256(OTHER_KEYS.publicKey);
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(signerTamper, SIGNER_KEYS.publicKey),
    "artifact_digest_mismatch",
  );

  const rootTamper = mutableArtifact(signed);
  rootTamper.trust_root_sha256 = authorityArtifactPublicKeySha256(OTHER_KEYS.publicKey);
  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(rootTamper, SIGNER_KEYS.publicKey),
    "artifact_digest_mismatch",
  );

  assertAuthorityFailure(
    () => verifySignedAuthorityArtifactV1(signed, OTHER_KEYS.publicKey),
    "trust_root_mismatch",
  );
});

test("outer unknown fields and all non-Ed25519 or non-public trust keys are rejected", () => {
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({ ...buildInput(), extra: true }, SIGNER_KEYS.privateKey));
  const signed = buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.privateKey);
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1({ ...signed, extra: true }, SIGNER_KEYS.publicKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.publicKey));
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1(signed, SIGNER_KEYS.privateKey));

  const rsaKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1(buildInput(), rsaKeys.privateKey), "invalid_ed25519_key");
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1(signed, rsaKeys.publicKey), "invalid_ed25519_key");
});

test("canonical text, timestamps, validity, Unicode, and bounded artifact JSON are strict", () => {
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({ ...buildInput(), artifact_id: " padded " }, SIGNER_KEYS.privateKey));
  for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
    assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
      ...buildInput(),
      artifact_id: `bad${String.fromCodePoint(codePoint)}id`,
    }, SIGNER_KEYS.privateKey));
  }
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({ ...buildInput(), artifact_id: "bad\ud800id" }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    payload: { payload: { invalid_unicode: "bad\udc00" }, metadata: {} },
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    payload: { payload: { invisible: "line\nbreak" }, metadata: {} },
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    created_at: "2026-07-21T01:00:00.001Z",
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    valid_from: "2026-07-21T01:00:00Z",
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    expires_at: "2026-07-21T01:00:00.000Z",
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    payload: { payload: "x".repeat(262_144), metadata: {} },
  }, SIGNER_KEYS.privateKey));
  assertAuthorityFailure(() => buildSignedAuthorityArtifactV1({
    ...buildInput(),
    artifact_revision: -0,
  }, SIGNER_KEYS.privateKey));
});

test("noncanonical base64url and wrong signature length are rejected before cryptographic verification", () => {
  const signed = buildSignedAuthorityArtifactV1(buildInput(), SIGNER_KEYS.privateKey);
  const padded = mutableArtifact(signed);
  padded.signature = `${padded.signature}==`;
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1(padded, SIGNER_KEYS.publicKey));

  const standardBase64 = mutableArtifact(signed);
  standardBase64.signature = Buffer.from(standardBase64.signature, "base64url").toString("base64");
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1(standardBase64, SIGNER_KEYS.publicKey));

  const short = mutableArtifact(signed);
  short.signature = Buffer.alloc(63).toString("base64url");
  assertAuthorityFailure(() => verifySignedAuthorityArtifactV1(short, SIGNER_KEYS.publicKey));
});
