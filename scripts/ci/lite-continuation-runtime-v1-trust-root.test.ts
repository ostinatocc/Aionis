import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { authorityArtifactPublicKeySha256 } from
  "../../src/continuation/authority-artifact.js";
import { loadContinuationRuntimeV1TrustRoot } from
  "../../src/runtime-v1/trust-root.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aionis-v1-trust-"));
  const pair = generateKeyPairSync("ed25519");
  const path = join(directory, "root.pem");
  writeFileSync(path, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  return {
    directory,
    pair,
    path,
    digest: authorityArtifactPublicKeySha256(pair.publicKey),
  };
}

test("trust root loader pins an immutable Ed25519 public-key identity", () => {
  const value = fixture();
  try {
    const key = loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: value.path,
      trustRootSha256: value.digest,
    });
    assert.equal(key.type, "public");
    assert.equal(key.asymmetricKeyType, "ed25519");
    assert.equal(authorityArtifactPublicKeySha256(key), value.digest);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("wrong pins, writable files, symlinks, private keys, and non-Ed25519 keys fail closed", () => {
  const value = fixture();
  try {
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: value.path,
      trustRootSha256: "0".repeat(64),
    }), /pin_mismatch/u);

    chmodSync(value.path, 0o622);
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: value.path,
      trustRootSha256: value.digest,
    }), /file_posture_invalid/u);
    chmodSync(value.path, 0o600);

    const link = join(value.directory, "root-link.pem");
    symlinkSync(value.path, link);
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: link,
      trustRootSha256: value.digest,
    }), /file_posture_invalid/u);

    const hardlink = join(value.directory, "root-hardlink.pem");
    linkSync(value.path, hardlink);
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: value.path,
      trustRootSha256: value.digest,
    }), /file_posture_invalid/u);
    rmSync(hardlink);

    const privatePath = join(value.directory, "private.pem");
    writeFileSync(privatePath, value.pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: privatePath,
      trustRootSha256: value.digest,
    }), /public_key_pem_required|key_invalid|must_be_ed25519_public_key/u);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPath = join(value.directory, "rsa.pem");
    writeFileSync(rsaPath, rsa.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    assert.throws(() => loadContinuationRuntimeV1TrustRoot({
      trustRootPublicKeyPath: rsaPath,
      trustRootSha256: authorityArtifactPublicKeySha256(value.pair.publicKey),
    }), /must_be_ed25519_public_key/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
