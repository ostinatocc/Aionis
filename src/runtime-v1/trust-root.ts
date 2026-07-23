import { createPublicKey, type KeyObject } from "node:crypto";

import { authorityArtifactPublicKeySha256 } from "../continuation/authority-artifact.js";
import type { Sha256 } from "../continuation/contract.js";
import { withContinuationRuntimeV1StableFileBytes } from "./stable-file.js";

function fail(code: string, cause?: unknown): never {
  throw new Error(
    `continuation_runtime_v1_trust_root_${code}`,
    cause === undefined ? undefined : { cause },
  );
}

export function loadContinuationRuntimeV1TrustRoot(
  config: Readonly<{
    trustRootPublicKeyPath: string;
    trustRootSha256: Sha256;
  }>,
): KeyObject {
  return withContinuationRuntimeV1StableFileBytes(
    config.trustRootPublicKeyPath,
    [1, 16_384],
    "runtime-or-root",
    "public",
    fail,
    (pem) => {
      const text = pem.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(pem)
        || !text.startsWith("-----BEGIN PUBLIC KEY-----\n")
        || !(text.endsWith("\n-----END PUBLIC KEY-----\n")
          || text.endsWith("\n-----END PUBLIC KEY-----"))
        || text.includes("PRIVATE KEY") || text.includes("\r")
        || (text.match(/-----BEGIN PUBLIC KEY-----/gu)?.length ?? 0) !== 1
        || (text.match(/-----END PUBLIC KEY-----/gu)?.length ?? 0) !== 1) {
        fail("public_key_pem_required");
      }
      let key: KeyObject;
      try {
        key = createPublicKey(pem);
      } catch (error) {
        fail("key_invalid", error);
      }
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
        fail("must_be_ed25519_public_key");
      }
      if (authorityArtifactPublicKeySha256(key) !== config.trustRootSha256) {
        fail("pin_mismatch");
      }
      return key;
    },
  );
}
