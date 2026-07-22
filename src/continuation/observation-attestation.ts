import {
  createHash,
  createPublicKey,
  sign as signDetached,
  verify as verifyDetached,
  type KeyObject,
} from "node:crypto";

import {
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  type HostObservationV1,
  type Sha256,
} from "./contract.js";
import { assertHostObservationV1 } from "./validation.js";

type HostObservationBodyV1 = Omit<HostObservationV1, "observation_sha256">;

export type AuthenticatedCollectorObservationInputV1 = Omit<
  HostObservationBodyV1,
  "attestation" | "observer" | "observer_principal_sha256"
>;

export type SignedObserverObservationInputV1 = Omit<
  HostObservationBodyV1,
  "attestation" | "observer_principal_sha256"
> & Readonly<{
  observer: "external_verifier";
}>;

const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

function requireEd25519PublicKey(value: KeyObject): KeyObject {
  if (value.type !== "public" || value.asymmetricKeyType !== "ed25519") {
    throw new Error("host_observation_attestation_public_key_must_be_ed25519");
  }
  return value;
}

function requireEd25519PrivateKey(value: KeyObject): KeyObject {
  if (value.type !== "private" || value.asymmetricKeyType !== "ed25519") {
    throw new Error("host_observation_attestation_private_key_must_be_ed25519");
  }
  return value;
}

function canonicalSpki(publicKey: KeyObject): Readonly<{
  der: Buffer;
  base64url: string;
  principalSha256: Sha256;
}> {
  const der = Buffer.from(requireEd25519PublicKey(publicKey).export({
    format: "der",
    type: "spki",
  }));
  return {
    der,
    base64url: der.toString("base64url"),
    principalSha256: createHash("sha256").update(der).digest("hex"),
  };
}

function parseCanonicalSpki(value: string): Readonly<{
  publicKey: KeyObject;
  principalSha256: Sha256;
}> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("host_observation_attestation_public_key_encoding_invalid");
  }
  const der = Buffer.from(value, "base64url");
  if (der.length === 0 || der.toString("base64url") !== value) {
    throw new Error("host_observation_attestation_public_key_encoding_invalid");
  }
  let publicKey: KeyObject;
  try {
    publicKey = requireEd25519PublicKey(createPublicKey({
      key: der,
      format: "der",
      type: "spki",
    }));
  } catch (error) {
    throw new Error("host_observation_attestation_public_key_invalid", { cause: error });
  }
  const canonical = canonicalSpki(publicKey);
  if (!canonical.der.equals(der)) {
    throw new Error("host_observation_attestation_public_key_not_canonical");
  }
  return { publicKey, principalSha256: canonical.principalSha256 };
}

function signatureBytes(value: HostObservationBodyV1 | HostObservationV1): Buffer {
  if (value.attestation.kind !== "ed25519") {
    throw new Error("host_observation_attestation_signature_body_invalid");
  }
  const { signature: _signature, ...attestation } = value.attestation;
  const {
    attestation: _attestation,
    observation_sha256: _observationSha256,
    ...observation
  } = value as HostObservationV1;
  return Buffer.from(canonicalContinuationJson({
    schema_version: "host_observation_attestation_v1",
    observation,
    attestation,
  }), "utf8");
}

function finishObservation(value: HostObservationBodyV1): HostObservationV1 {
  return canonicalContinuationClone({
    ...value,
    observation_sha256: canonicalContinuationSha256(value),
  });
}

export function buildAuthenticatedCollectorObservationV1(
  value: AuthenticatedCollectorObservationInputV1,
  collectorPrincipalSha256: Sha256,
): HostObservationV1 {
  assertSha256(collectorPrincipalSha256, "collector_principal_sha256");
  const observation = finishObservation({
    ...value,
    observer: "trusted_host_collector",
    observer_principal_sha256: collectorPrincipalSha256,
    attestation: { kind: "authenticated_collector" },
  });
  return verifyHostObservationAttestationV1(observation);
}

export function buildSignedObserverObservationV1(
  value: SignedObserverObservationInputV1,
  privateKey: KeyObject,
): HostObservationV1 {
  const signingKey = requireEd25519PrivateKey(privateKey);
  const key = canonicalSpki(createPublicKey(signingKey));
  const unsignedAttestation = {
    kind: "ed25519" as const,
    public_key_spki_base64url: key.base64url,
    signature: "A".repeat(86),
  };
  const unsignedBody = {
    ...value,
    observer_principal_sha256: key.principalSha256,
    attestation: unsignedAttestation,
  };
  const signature = signDetached(
    null,
    signatureBytes(unsignedBody),
    signingKey,
  ).toString("base64url");
  const observation = finishObservation({
    ...unsignedBody,
    attestation: { ...unsignedAttestation, signature },
  });
  return verifyHostObservationAttestationV1(observation);
}

export function verifyHostObservationAttestationV1(
  value: unknown,
): HostObservationV1 {
  assertHostObservationV1(value);
  if (canonicalSha256Without(value, "observation_sha256") !== value.observation_sha256) {
    throw new Error("host_observation_digest_mismatch");
  }
  if (value.attestation.kind === "authenticated_collector") {
    if (value.observer !== "trusted_host_collector") {
      throw new Error("host_observation_collector_attestation_role_invalid");
    }
    return canonicalContinuationClone(value);
  }
  if (value.observer === "trusted_host_collector") {
    throw new Error("host_observation_signed_attestation_role_invalid");
  }
  const encodedSignature = value.attestation.signature;
  if (!SIGNATURE_PATTERN.test(encodedSignature)) {
    throw new Error("host_observation_attestation_signature_encoding_invalid");
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== encodedSignature) {
    throw new Error("host_observation_attestation_signature_encoding_invalid");
  }
  const key = parseCanonicalSpki(value.attestation.public_key_spki_base64url);
  if (key.principalSha256 !== value.observer_principal_sha256
    || !verifyDetached(null, signatureBytes(value), key.publicKey, signature)) {
    throw new Error("host_observation_attestation_signature_invalid");
  }
  return canonicalContinuationClone(value);
}
