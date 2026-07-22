import { createHash, timingSafeEqual } from "node:crypto";

import {
  canonicalContinuationClone,
  type Sha256,
} from "../continuation/contract.js";
import type { ContinuationRuntimeV1DaemonConfig } from "./config.js";
import { continuationRuntimeV1PrincipalSha256 } from "./principal.js";

export { continuationRuntimeV1PrincipalSha256 } from "./principal.js";

export type ContinuationRuntimeV1Principal = Readonly<{
  tenant_id: string;
  principal_sha256: Sha256;
  principal_kind: "trusted_host" | "operator";
  authentication: "bearer_sha256_v1";
}>;

export class ContinuationRuntimeV1AuthenticationError extends Error {
  readonly code = "unauthorized";
  readonly statusCode = 401;

  constructor() {
    // Do not distinguish absent, malformed, and incorrect credentials.
    super("unauthorized");
    this.name = "ContinuationRuntimeV1AuthenticationError";
  }
}

function unauthorized(): never {
  throw new ContinuationRuntimeV1AuthenticationError();
}

function bearerToken(headers: unknown): string {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) unauthorized();
  const prototype = Object.getPrototypeOf(headers);
  if (prototype !== Object.prototype && prototype !== null) unauthorized();
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key !== "string") unauthorized();
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) unauthorized();
    if (key.toLowerCase() === "authorization") values.push(descriptor.value);
  }
  if (values.length !== 1 || typeof values[0] !== "string") unauthorized();
  const match = /^Bearer ([^\s\u0000-\u001f\u007f]{32,512})$/u.exec(values[0]);
  if (!match) unauthorized();
  return match[1]!;
}

function tokenSha256(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function authenticateContinuationRuntimeV1(
  headers: unknown,
  config: ContinuationRuntimeV1DaemonConfig,
  requestedKind: "trusted_host" | "operator" | "trusted_host_or_operator",
): ContinuationRuntimeV1Principal {
  const actual = tokenSha256(bearerToken(headers));
  const hostMatch = timingSafeEqual(
    actual,
    Buffer.from(config.hostApiKeySha256, "hex"),
  );
  const operatorMatch = timingSafeEqual(
    actual,
    Buffer.from(config.operatorApiKeySha256, "hex"),
  );
  const principalKind = requestedKind === "trusted_host"
    ? (hostMatch && !operatorMatch ? "trusted_host" : null)
    : requestedKind === "operator"
      ? (operatorMatch && !hostMatch ? "operator" : null)
      : hostMatch !== operatorMatch
        ? (hostMatch ? "trusted_host" : "operator")
        : null;
  if (principalKind === null) unauthorized();
  return canonicalContinuationClone({
    tenant_id: config.tenantId,
    principal_sha256: continuationRuntimeV1PrincipalSha256({
      tenant_id: config.tenantId,
      principal_kind: principalKind,
      principal_id: principalKind === "trusted_host"
        ? config.hostPrincipalId
        : config.operatorPrincipalId,
    }),
    principal_kind: principalKind,
    authentication: "bearer_sha256_v1" as const,
  });
}
