import { createPublicKey, type KeyObject } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

import { authorityArtifactPublicKeySha256 } from "../continuation/authority-artifact.js";
import type { Sha256 } from "../continuation/contract.js";

const MAX_PUBLIC_KEY_BYTES = 16_384;

export function loadContinuationRuntimeV1TrustRoot(
  config: Readonly<{
    trustRootPublicKeyPath: string;
    trustRootSha256: Sha256;
  }>,
): KeyObject {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(
      config.trustRootPublicKeyPath,
      constants.O_RDONLY | noFollow,
    );
  } catch (error) {
    throw new Error("continuation_runtime_v1_trust_root_open_failed", { cause: error });
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()
      || stat.size < 1
      || stat.size > MAX_PUBLIC_KEY_BYTES
      || (stat.mode & 0o022) !== 0) {
      throw new Error("continuation_runtime_v1_trust_root_file_posture_invalid");
    }
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (stat.uid !== uid && stat.uid !== 0) {
        throw new Error("continuation_runtime_v1_trust_root_owner_invalid");
      }
    }
    const pem = readFileSync(descriptor);
    if (pem.byteLength !== stat.size) {
      throw new Error("continuation_runtime_v1_trust_root_file_changed_during_read");
    }
    const pemText = pem.toString("utf8");
    if (Buffer.from(pemText, "utf8").compare(pem) !== 0
      || !pemText.startsWith("-----BEGIN PUBLIC KEY-----\n")
      || !(pemText.endsWith("\n-----END PUBLIC KEY-----\n")
        || pemText.endsWith("\n-----END PUBLIC KEY-----"))
      || pemText.includes("PRIVATE KEY")
      || pemText.includes("\r")
      || (pemText.match(/-----BEGIN PUBLIC KEY-----/gu)?.length ?? 0) !== 1
      || (pemText.match(/-----END PUBLIC KEY-----/gu)?.length ?? 0) !== 1) {
      throw new Error("continuation_runtime_v1_trust_root_public_key_pem_required");
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(pem);
    } catch (error) {
      throw new Error("continuation_runtime_v1_trust_root_key_invalid", { cause: error });
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("continuation_runtime_v1_trust_root_must_be_ed25519_public_key");
    }
    if (authorityArtifactPublicKeySha256(publicKey) !== config.trustRootSha256) {
      throw new Error("continuation_runtime_v1_trust_root_pin_mismatch");
    }
    return publicKey;
  } finally {
    closeSync(descriptor);
  }
}
