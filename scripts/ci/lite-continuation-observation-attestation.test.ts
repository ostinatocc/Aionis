import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  canonicalContinuationSha256,
  type HostObservationV1,
} from "../../src/continuation/contract.ts";
import {
  buildAuthenticatedCollectorObservationV1,
  buildSignedObserverObservationV1,
  verifyHostObservationAttestationV1,
} from "../../src/continuation/observation-attestation.ts";

const COLLECTOR = "a".repeat(64);

const BASE = {
  schema_version: "host_observation_v1" as const,
  observation_id: "observation-1",
  probe_id: "probe-1",
  probe_spec_sha256: "b".repeat(64),
  host_task_envelope_sha256: "c".repeat(64),
  world_snapshot_id: "snapshot-1",
  observed_at: "2026-07-21T12:00:00.000Z",
  expires_at: "2026-07-21T12:05:00.000Z",
  value: {
    kind: "capability" as const,
    capability_id: "node",
    version: "24.0.0",
    presence: "present" as const,
  },
  evidence_sha256: "d".repeat(64),
};

function rehash(value: HostObservationV1, changes: Record<string, unknown>): HostObservationV1 {
  const { observation_sha256: _digest, ...body } = { ...value, ...changes };
  return {
    ...body,
    observation_sha256: canonicalContinuationSha256(body),
  } as HostObservationV1;
}

test("authenticated collector observations are exact immutable self-digested claims", () => {
  const observation = buildAuthenticatedCollectorObservationV1(BASE, COLLECTOR);
  assert.equal(observation.observer, "trusted_host_collector");
  assert.equal(observation.observer_principal_sha256, COLLECTOR);
  assert.equal(observation.attestation.kind, "authenticated_collector");
  assert.equal(Object.isFrozen(observation), true);
  assert.deepEqual(verifyHostObservationAttestationV1(observation), observation);

  const forgedRole = rehash(observation, { observer: "external_verifier" });
  assert.throws(
    () => verifyHostObservationAttestationV1(forgedRole),
    /collector observations require collector attestation|collector_attestation_role_invalid/u,
  );
});

test("non-host observation authority requires a valid Ed25519 proof of possession", () => {
  const signer = generateKeyPairSync("ed25519");
  const observation = buildSignedObserverObservationV1({
    ...BASE,
    observer: "external_verifier",
  }, signer.privateKey);
  assert.equal(observation.observer, "external_verifier");
  assert.equal(observation.attestation.kind, "ed25519");
  assert.equal(Object.isFrozen(observation.attestation), true);
  assert.deepEqual(verifyHostObservationAttestationV1(observation), observation);

  const forgedValue = rehash(observation, {
    value: { ...observation.value, version: "forged" },
  });
  assert.throws(
    () => verifyHostObservationAttestationV1(forgedValue),
    /attestation_signature_invalid/u,
  );

  const otherSigner = generateKeyPairSync("ed25519");
  const other = buildSignedObserverObservationV1({
    ...BASE,
    observation_id: "observation-2",
    observer: "external_verifier",
  }, otherSigner.privateKey);
  assert.equal(other.attestation.kind, "ed25519");
  const swappedKey = rehash(observation, {
    observer_principal_sha256: other.observer_principal_sha256,
    attestation: {
      ...observation.attestation,
      public_key_spki_base64url: other.attestation.public_key_spki_base64url,
    },
  });
  assert.throws(
    () => verifyHostObservationAttestationV1(swappedKey),
    /attestation_signature_invalid/u,
  );
});

test("observation attestations reject noncanonical signatures and non-Ed25519 keys", () => {
  const signer = generateKeyPairSync("ed25519");
  const observation = buildSignedObserverObservationV1({
    ...BASE,
    observer: "external_verifier",
  }, signer.privateKey);
  assert.equal(observation.attestation.kind, "ed25519");
  const malformedSignature = rehash(observation, {
    attestation: { ...observation.attestation, signature: "!".repeat(86) },
  });
  assert.throws(
    () => verifyHostObservationAttestationV1(malformedSignature),
    /signature_encoding_invalid|must not contain/u,
  );

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaSpki = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const wrongAlgorithm = rehash(observation, {
    attestation: {
      ...observation.attestation,
      public_key_spki_base64url: rsaSpki,
    },
  });
  assert.throws(
    () => verifyHostObservationAttestationV1(wrongAlgorithm),
    /public_key_invalid|at most 128 UTF-8 bytes/u,
  );
});
