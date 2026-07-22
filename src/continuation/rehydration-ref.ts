import type { Sha256 } from "./contract.js";

export type ContinuationRehydrationRefV1 = `rehydration:v1:${Sha256}`;

const REHYDRATION_REF_V1 = /^rehydration:v1:[0-9a-f]{64}$/u;

export function isContinuationRehydrationRefV1(
  value: unknown,
): value is ContinuationRehydrationRefV1 {
  return typeof value === "string" && REHYDRATION_REF_V1.test(value);
}

export function continuationRehydrationRefV1(
  contentSha256: Sha256,
): ContinuationRehydrationRefV1 {
  if (!/^[0-9a-f]{64}$/u.test(contentSha256)) {
    throw new Error("continuation_rehydration_content_sha256_invalid");
  }
  return `rehydration:v1:${contentSha256}`;
}
