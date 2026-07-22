import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

import type { Sha256 } from "../continuation/contract.js";
import { assertContinuationRuntimeV1Host } from
  "../continuation/host-contract.js";
import type { ContinuationRuntimeV1EffectWorkerConfig } from "./worker-config.js";

const MAX_PRIVATE_KEY_BYTES = 16_384;
const PKCS8_BEGIN = Buffer.from("-----BEGIN PRIVATE KEY-----\n", "ascii");
const PKCS8_END = Buffer.from("-----END PRIVATE KEY-----", "ascii");
const ENCRYPTED_PRIVATE_KEY = Buffer.from("ENCRYPTED PRIVATE KEY", "ascii");
const PUBLIC_KEY = Buffer.from("PUBLIC KEY", "ascii");
export type ContinuationRuntimeV1EffectSigner = Readonly<{
  privateKey: KeyObject;
  principalSha256: Sha256;
  publicKeySpkiBase64url: string;
}>;

function fail(code: string, cause?: unknown): never {
  throw new Error(
    `continuation_runtime_v1_effect_signer_${code}`,
    cause === undefined ? undefined : { cause },
  );
}

function assertPkcs8PemEnvelope(bytes: Buffer): void {
  const endOffset = bytes.byteLength - PKCS8_END.byteLength
    - (bytes.at(-1) === 0x0a ? 1 : 0);
  if (bytes.some((byte) => byte > 0x7f || byte === 0 || byte === 0x0d
      || (byte < 0x20 && byte !== 0x0a))
    || bytes.indexOf(PKCS8_BEGIN) !== 0
    || bytes.lastIndexOf(PKCS8_BEGIN) !== 0
    || endOffset < PKCS8_BEGIN.byteLength
    || bytes.indexOf(PKCS8_END) !== endOffset
    || bytes.lastIndexOf(PKCS8_END) !== endOffset
    || bytes.includes(ENCRYPTED_PRIVATE_KEY)
    || bytes.includes(PUBLIC_KEY)) fail("pkcs8_pem_required");
}

/** Loads the dedicated effect-verifier key only inside an effect worker. */
export function loadContinuationRuntimeV1EffectSigner(
  config: ContinuationRuntimeV1EffectWorkerConfig,
): ContinuationRuntimeV1EffectSigner {
  assertContinuationRuntimeV1Host();
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(config.signerPrivateKeyPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    fail("open_failed", error);
  }
  try {
    const before = fstatSync(descriptor);
    const permissions = before.mode & 0o777;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1
      || before.size > MAX_PRIVATE_KEY_BYTES
      || (permissions !== 0o400 && permissions !== 0o600)) {
      fail("file_posture_invalid");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && before.uid !== uid && before.uid !== 0) fail("owner_invalid");
    const bytes = readFileSync(descriptor);
    try {
      const after = fstatSync(descriptor);
      if (bytes.byteLength !== before.size
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) {
        fail("file_changed_during_read");
      }
      assertPkcs8PemEnvelope(bytes);
      let privateKey: KeyObject;
      try {
        privateKey = createPrivateKey(bytes);
      } catch (error) {
        fail("key_invalid", error);
      }
      if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
        fail("must_be_ed25519_private_key");
      }
      const publicKey = createPublicKey(privateKey);
      const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      const principalSha256 = createHash("sha256").update(spki).digest("hex");
      if (principalSha256 !== config.signerSha256) fail("pin_mismatch");
      return Object.freeze({
        privateKey,
        principalSha256,
        publicKeySpkiBase64url: spki.toString("base64url"),
      });
    } finally {
      bytes.fill(0);
    }
  } finally {
    closeSync(descriptor);
  }
}
