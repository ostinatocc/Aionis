import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import type { Sha256 } from "../continuation/contract.js";
import { assertContinuationRuntimeV1Host } from "../continuation/host-contract.js";
import { withContinuationRuntimeV1StableFileBytes } from "./stable-file.js";
import type { ContinuationRuntimeV1EffectWorkerConfig } from "./worker-config.js";

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
  throw new Error(`continuation_runtime_v1_effect_signer_${code}`,
    cause === undefined ? undefined : { cause });
}
function assertPkcs8PemEnvelope(bytes: Buffer): void {
  const end = bytes.length - PKCS8_END.length - (bytes.at(-1) === 0x0a ? 1 : 0);
  if (bytes.some((byte) => byte > 0x7f || byte === 0 || byte === 0x0d
      || (byte < 0x20 && byte !== 0x0a))
    || bytes.indexOf(PKCS8_BEGIN) !== 0 || bytes.lastIndexOf(PKCS8_BEGIN) !== 0
    || end < PKCS8_BEGIN.length || bytes.indexOf(PKCS8_END) !== end
    || bytes.lastIndexOf(PKCS8_END) !== end || bytes.includes(ENCRYPTED_PRIVATE_KEY)
    || bytes.includes(PUBLIC_KEY)) fail("pkcs8_pem_required");
}

/** Loads the dedicated effect-verifier key only inside an effect worker. */
export function loadContinuationRuntimeV1EffectSigner(
  config: ContinuationRuntimeV1EffectWorkerConfig,
): ContinuationRuntimeV1EffectSigner {
  assertContinuationRuntimeV1Host();
  return withContinuationRuntimeV1StableFileBytes(
    config.signerPrivateKeyPath, [1, 16_384], "runtime-or-root", "private", fail, (bytes) => {
      assertPkcs8PemEnvelope(bytes);
      let privateKey: KeyObject;
      try { privateKey = createPrivateKey(bytes); }
      catch (error) { fail("key_invalid", error); }
      if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
        fail("must_be_ed25519_private_key");
      }
      const spki = createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
      }) as Buffer;
      const principalSha256 = createHash("sha256").update(spki).digest("hex");
      if (principalSha256 !== config.signerSha256) fail("pin_mismatch");
      return Object.freeze({
        privateKey,
        principalSha256,
        publicKeySpkiBase64url: spki.toString("base64url"),
      });
    },
  );
}
