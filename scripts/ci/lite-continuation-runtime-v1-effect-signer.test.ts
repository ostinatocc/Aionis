import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadContinuationRuntimeV1EffectSigner } from
  "../../src/runtime-v1/effect-signer.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aionis-v1-effect-signer-"));
  const pair = generateKeyPairSync("ed25519");
  const path = join(directory, "signer.pem");
  writeFileSync(
    path,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const publicKey = createPublicKey(pair.privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    directory,
    pair,
    path,
    spki,
    digest: createHash("sha256").update(spki).digest("hex"),
  };
}

test("effect signer fails closed before opening a key on unsupported platforms", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: "/must/not/be/opened",
      signerSha256: "0".repeat(64),
    }), /platform_unsupported/u);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("effect signer loads only the pinned dedicated Ed25519 private key", () => {
  const value = fixture();
  try {
    const signer = loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: value.digest,
    });
    assert.equal(signer.privateKey.type, "private");
    assert.equal(signer.privateKey.asymmetricKeyType, "ed25519");
    assert.equal(signer.principalSha256, value.digest);
    assert.equal(signer.publicKeySpkiBase64url, value.spki.toString("base64url"));
    assert.ok(Object.isFrozen(signer));
    chmodSync(value.path, 0o400);
    assert.doesNotThrow(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: value.digest,
    }));
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("effect signer rejects wrong pin, weak mode, links, public/RSA keys, and PEM extras", () => {
  const value = fixture();
  try {
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: "0".repeat(64),
    }), /pin_mismatch/u);

    chmodSync(value.path, 0o640);
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: value.digest,
    }), /file_posture_invalid/u);
    chmodSync(value.path, 0o600);

    chmodSync(value.path, 0o700);
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: value.digest,
    }), /file_posture_invalid/u);
    chmodSync(value.path, 0o600);

    const symbolic = join(value.directory, "symbolic.pem");
    symlinkSync(value.path, symbolic);
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: symbolic,
      signerSha256: value.digest,
    }), /file_posture_invalid/u);

    const hard = join(value.directory, "hard.pem");
    linkSync(value.path, hard);
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: value.path,
      signerSha256: value.digest,
    }), /file_posture_invalid/u);
    rmSync(hard);

    const publicPath = join(value.directory, "public.pem");
    writeFileSync(
      publicPath,
      value.pair.publicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o600 },
    );
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: publicPath,
      signerSha256: value.digest,
    }), /pkcs8_pem_required/u);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPath = join(value.directory, "rsa.pem");
    writeFileSync(
      rsaPath,
      rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: rsaPath,
      signerSha256: value.digest,
    }), /must_be_ed25519_private_key/u);

    const extraPath = join(value.directory, "extra.pem");
    writeFileSync(
      extraPath,
      `${value.pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string}\nextra`,
      { mode: 0o600 },
    );
    assert.throws(() => loadContinuationRuntimeV1EffectSigner({
      signerPrivateKeyPath: extraPath,
      signerSha256: value.digest,
    }), /pkcs8_pem_required/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("effect signer never copies private PEM bytes into an immutable JS string", () => {
  const source = readFileSync(new URL(
    "../../src/runtime-v1/effect-signer.ts",
    import.meta.url,
  ), "utf8");
  const reader = readFileSync(new URL(
    "../../src/runtime-v1/stable-file.ts",
    import.meta.url,
  ), "utf8");
  assert.equal(source.includes("bytes.toString"), false);
  assert.equal(reader.includes("bytes?.fill(0)"), true);
});
