import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  learningExternalEd25519PublicKeyDigest,
} from "../../src/memory/learning-external-authority.js";
import {
  ExternalExecutionPolicyV1Schema,
  externalExecutionPolicyDigest,
  type ExternalExecutionPolicyV1,
} from "../../src/memory/learning-episode-ledger.js";
import {
  LearningRuntimeDatabaseBindingReceiptBodyV1Schema,
  LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema,
  learningRuntimeDatabaseBindingReceiptBodyDigest,
  learningRuntimeDatabaseBindingReceiptBodyJson,
  learningRuntimeDatabaseBindingReceiptDigest,
  learningRuntimeDatabaseBindingReceiptJson,
  parseCanonicalLearningRuntimeDatabaseBindingReceiptBodyJson,
  parseCanonicalLearningRuntimeDatabaseBindingReceiptJson,
  verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation,
  type LearningRuntimeDatabaseBindingReceiptBodyV1,
  type LearningRuntimeDatabaseBindingReceiptCryptographicVerificationV1,
  type LearningRuntimeDatabaseBindingReceiptEnvelopeV1,
} from "../../src/memory/learning-runtime-database-binding.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rawEd25519PublicKeyBase64(publicKey: KeyObject): string {
  const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  assert.ok(spki.byteLength > 32);
  return spki.subarray(spki.byteLength - 32).toString("base64");
}

function fixedEd25519PrivateKey(fill: number): KeyObject {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, Buffer.alloc(32, fill)]),
    format: "der",
    type: "pkcs8",
  });
}

const LAUNCHER_KEYS = generateKeyPairSync("ed25519");
const ATTESTOR_KEYS = generateKeyPairSync("ed25519");
const BROKER_KEYS = generateKeyPairSync("ed25519");
const ATTACKER_KEYS = generateKeyPairSync("ed25519");
const GOLDEN_LAUNCHER_PRIVATE_KEY = fixedEd25519PrivateKey(0x11);
const GOLDEN_ATTESTOR_PRIVATE_KEY = fixedEd25519PrivateKey(0x22);
const GOLDEN_BROKER_PRIVATE_KEY = fixedEd25519PrivateKey(0x33);
const GOLDEN_LAUNCHER_PUBLIC_KEY = createPublicKey(GOLDEN_LAUNCHER_PRIVATE_KEY);
const GOLDEN_ATTESTOR_PUBLIC_KEY = createPublicKey(GOLDEN_ATTESTOR_PRIVATE_KEY);
const GOLDEN_BROKER_PUBLIC_KEY = createPublicKey(GOLDEN_BROKER_PRIVATE_KEY);
const DATABASE_INSTANCE_ID = sha256("database-instance");
const DEPLOYMENT_SLOT = "acceptance-runtime-primary";
const FIRST_BINDING_ANCHOR_SHA256 = sha256("deployment-slot-first-binding-anchor");

function createExternalExecutionPolicy(args: Readonly<{
  launcherPublicKey?: KeyObject;
  attestorPublicKey?: KeyObject;
  brokerPublicKey?: KeyObject;
  databaseInstanceId?: string;
}> = {}): ExternalExecutionPolicyV1 {
  const launcherPublicKeyBase64 = rawEd25519PublicKeyBase64(
    args.launcherPublicKey ?? LAUNCHER_KEYS.publicKey,
  );
  const launcherPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    launcherPublicKeyBase64,
  );
  const attestorPublicKeyBase64 = rawEd25519PublicKeyBase64(
    args.attestorPublicKey ?? ATTESTOR_KEYS.publicKey,
  );
  const attestorPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    attestorPublicKeyBase64,
  );
  const brokerPublicKeyBase64 = rawEd25519PublicKeyBase64(
    args.brokerPublicKey ?? BROKER_KEYS.publicKey,
  );
  const brokerPublicKeySha256 = learningExternalEd25519PublicKeyDigest(
    brokerPublicKeyBase64,
  );
  const role = (
    roleName: "offline_paired" | "production_shadow" | "tool_e2e",
    credentialSessionClass:
      | "immutable_paired_eval"
      | "eligible_host_adapter"
      | "formal_tool_eval",
  ) => ({
    runner_principal_sha256: sha256(`runner-principal:${roleName}`),
    credential_session_class: credentialSessionClass,
    broker_policy_sha256: sha256(`broker-policy:${roleName}`),
    broker_binary_sha256: sha256(`broker-binary:${roleName}`),
    broker_public_key_base64: brokerPublicKeyBase64,
    broker_public_key_sha256: brokerPublicKeySha256,
    broker_key_id: `broker-key-${roleName}`,
    service_launcher_policy_sha256: sha256("launcher-policy"),
    service_launcher_binary_sha256: sha256("launcher-binary"),
    service_launcher_public_key_sha256: launcherPublicKeySha256,
    service_launcher_key_id: "launcher-key-1",
    supervisor_executable_sha256: sha256(`supervisor-executable:${roleName}`),
    supervisor_argv_policy_sha256: sha256(`supervisor-argv:${roleName}`),
    supervisor_sandbox_policy_sha256: sha256(`supervisor-sandbox:${roleName}`),
    receipt_signature_algorithm: "ed25519-v1" as const,
    credential_scope_sha256: sha256(`credential-scope:${roleName}`),
    supervisor_bind_ttl_seconds: 60,
    credential_session_hard_ttl_seconds: 120,
    credential_session_heartbeat_seconds: 10,
    credential_session_max_calls: 100,
    per_call_capability_ttl_seconds: 5,
    post_quiesce_finalize_ttl_seconds: 300,
  });
  return ExternalExecutionPolicyV1Schema.parse({
    policy_version: "external-execution-v1",
    runtime_authority_attestor: {
      service_identity: "runtime-authority-attestor",
      attestor_binary_sha256: sha256("attestor-binary"),
      attestor_policy_sha256: sha256("attestor-policy"),
      attestor_public_key_base64: attestorPublicKeyBase64,
      attestor_public_key_sha256: attestorPublicKeySha256,
      attestor_key_id: "attestor-key-1",
      service_launcher_policy_sha256: sha256("launcher-policy"),
      service_launcher_binary_sha256: sha256("launcher-binary"),
      service_launcher_public_key_base64: launcherPublicKeyBase64,
      service_launcher_public_key_sha256: launcherPublicKeySha256,
      service_launcher_key_id: "launcher-key-1",
      receipt_signature_algorithm: "ed25519-v1",
      expected_database_instance_id: args.databaseInstanceId ?? DATABASE_INSTANCE_ID,
    },
    roles: {
      offline_paired: role("offline_paired", "immutable_paired_eval"),
      production_shadow: role("production_shadow", "eligible_host_adapter"),
      tool_e2e: role("tool_e2e", "formal_tool_eval"),
    },
  });
}

const POLICY = createExternalExecutionPolicy();
const POLICY_SHA256 = externalExecutionPolicyDigest(POLICY);
const GOLDEN_POLICY = createExternalExecutionPolicy({
  launcherPublicKey: GOLDEN_LAUNCHER_PUBLIC_KEY,
  attestorPublicKey: GOLDEN_ATTESTOR_PUBLIC_KEY,
  brokerPublicKey: GOLDEN_BROKER_PUBLIC_KEY,
});
const GOLDEN_BODY_JSON = `{"attestor_binary_sha256":"51ed3f54151715e89460ab4c0216c770c9bd43d3a64a413f99b791dc58c46159","attestor_key_id":"attestor-key-1","attestor_policy_sha256":"e556632ec6671702d78cbecc84535e1bc74bce07607662df634a9dac85f22e94","attestor_public_key_sha256":"1325b850c2871916eae203f0efc3c8987f64e5e3cdb27679e6d1fa97808357e6","attestor_service_identity":"runtime-authority-attestor","binding_chain":{"chain_kind":"first","first_binding_anchor_sha256":"332dbf7827f2f0f3ca8b8c68d89f156bae072f90c334a078e226de8f509922e0"},"checkpoint_generation":"3","contract_version":"aionis_learning_runtime_database_binding_receipt_body_v1","database_file_device":"101","database_file_inode":"202","database_instance_id":"5f9cd6fd2de57a7fcc93d979e855c5d2d44175e144cf7c25b639740edbfb7d42","database_main_file_byte_length":"4096","database_main_file_sha256":"1e1eb4ff5ddee52f8fbc068bdbddc8df46652a3385c30bc21d58516c1e2f32c7","deployment_slot":"acceptance-runtime-primary","external_execution_policy_sha256":"112cf3a8a906072370a3e1cf244bbb3450414240de2b792519da823db335d71f","issued_at":"2026-07-17T04:00:00.000Z","service_launcher_binary_sha256":"6c4ba498a708b3df7b9d308138b898c2330e76395dc0ab89531f3ac36478a7c3","service_launcher_key_id":"launcher-key-1","service_launcher_policy_sha256":"97d2ad404a8bb09eb0ae789034818a471ed7a62e473b773fcc12a351c4e9b99e","service_launcher_public_key_sha256":"10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d","wal_checkpoint_busy":0,"wal_checkpoint_log_frame_count":0,"wal_checkpoint_mode":"truncate","wal_checkpointed_and_truncated":true,"wal_checkpointed_frame_count":0,"wal_file_byte_length":"0","writer_fence_inspection_sha256":"5a86712c401bf0cf1658ac42c6ef56a4209d412c0b12cacf0bab9fba6c028847"}`;
const GOLDEN_BODY_SHA256 = "bca02a35fa1732d9cf2492af9d827742cb4eebb09080ea868f625b9ca4d22579";
const GOLDEN_SIGNATURE_BASE64 =
  "vyiRyraKyGV3q8MBn1iz+UUzZH1aev5RSLvGtKDiYebHe8aDU9yH0u6i5IW19UsVxGilXj5RuPFSmAha3Xo3Bw==";
const GOLDEN_ENVELOPE_JSON = `{"body":${GOLDEN_BODY_JSON},"signature_algorithm":"ed25519-v1","signature_base64":"${GOLDEN_SIGNATURE_BASE64}"}`;
const GOLDEN_ENVELOPE_SHA256 =
  "e0415464b8ca1f65f4b145a5630be8ced53adb617bc3bb7983960ec746482e52";

function bodyForPolicy(
  policy: ExternalExecutionPolicyV1,
  overrides: Partial<LearningRuntimeDatabaseBindingReceiptBodyV1> = {},
): LearningRuntimeDatabaseBindingReceiptBodyV1 {
  const expected = policy.runtime_authority_attestor;
  return LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
    contract_version: "aionis_learning_runtime_database_binding_receipt_body_v1",
    deployment_slot: DEPLOYMENT_SLOT,
    external_execution_policy_sha256: externalExecutionPolicyDigest(policy),
    database_instance_id: expected.expected_database_instance_id,
    database_file_device: "101",
    database_file_inode: "202",
    checkpoint_generation: "3",
    database_main_file_byte_length: "4096",
    database_main_file_sha256: sha256("database-main:first"),
    wal_checkpoint_mode: "truncate",
    wal_checkpoint_busy: 0,
    wal_checkpoint_log_frame_count: 0,
    wal_checkpointed_frame_count: 0,
    wal_file_byte_length: "0",
    wal_checkpointed_and_truncated: true,
    writer_fence_inspection_sha256: sha256("writer-fence:first"),
    binding_chain: {
      chain_kind: "first",
      first_binding_anchor_sha256: FIRST_BINDING_ANCHOR_SHA256,
    },
    service_launcher_policy_sha256: expected.service_launcher_policy_sha256,
    service_launcher_binary_sha256: expected.service_launcher_binary_sha256,
    service_launcher_public_key_sha256: expected.service_launcher_public_key_sha256,
    service_launcher_key_id: expected.service_launcher_key_id,
    attestor_service_identity: expected.service_identity,
    attestor_binary_sha256: expected.attestor_binary_sha256,
    attestor_policy_sha256: expected.attestor_policy_sha256,
    attestor_public_key_sha256: expected.attestor_public_key_sha256,
    attestor_key_id: expected.attestor_key_id,
    issued_at: "2026-07-17T04:00:00.000Z",
    ...overrides,
  });
}

function firstBody(
  overrides: Partial<LearningRuntimeDatabaseBindingReceiptBodyV1> = {},
): LearningRuntimeDatabaseBindingReceiptBodyV1 {
  return bodyForPolicy(POLICY, overrides);
}

function signEnvelope(
  bodyInput: unknown,
  privateKey: KeyObject = LAUNCHER_KEYS.privateKey,
): LearningRuntimeDatabaseBindingReceiptEnvelopeV1 {
  const body = LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse(bodyInput);
  return LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema.parse({
    body,
    signature_algorithm: "ed25519-v1",
    signature_base64: signMessage(
      null,
      Buffer.from(stableStringify(body), "utf8"),
      privateKey,
    ).toString("base64"),
  });
}

function verifyFirst(
  envelope: unknown,
  overrides: Partial<{
    externalExecutionPolicy: ExternalExecutionPolicyV1;
    registeredExternalExecutionPolicySha256: string;
    expectedDeploymentSlot: string;
    expectedFirstBindingAnchorSha256: string;
    expectedCheckpointGeneration: string;
  }> = {},
): LearningRuntimeDatabaseBindingReceiptCryptographicVerificationV1 {
  return verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
    envelope,
    externalExecutionPolicy: overrides.externalExecutionPolicy ?? POLICY,
    registeredExternalExecutionPolicySha256:
      overrides.registeredExternalExecutionPolicySha256 ?? POLICY_SHA256,
    expectedDeploymentSlot: overrides.expectedDeploymentSlot ?? DEPLOYMENT_SLOT,
    chainExpectation: {
      chainKind: "first",
      expectedFirstBindingAnchorSha256:
        overrides.expectedFirstBindingAnchorSha256 ?? FIRST_BINDING_ANCHOR_SHA256,
      expectedCheckpointGeneration: overrides.expectedCheckpointGeneration ?? "3",
    },
  });
}

test("database binding receipt canonical body and signed envelope are deterministic", () => {
  const body = firstBody();
  const envelope = signEnvelope(body);
  const bodyJson = learningRuntimeDatabaseBindingReceiptBodyJson(body);
  const envelopeJson = learningRuntimeDatabaseBindingReceiptJson(envelope);

  assert.deepEqual(parseCanonicalLearningRuntimeDatabaseBindingReceiptBodyJson(bodyJson), body);
  assert.deepEqual(parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(envelopeJson), envelope);
  assert.equal(
    learningRuntimeDatabaseBindingReceiptBodyDigest(body),
    sha256(bodyJson),
  );
  assert.equal(
    learningRuntimeDatabaseBindingReceiptDigest(envelope),
    sha256(envelopeJson),
  );
  assert.equal(
    learningRuntimeDatabaseBindingReceiptDigest(structuredClone(envelope)),
    learningRuntimeDatabaseBindingReceiptDigest(envelope),
  );
  const changedSignature = Buffer.from(envelope.signature_base64, "base64");
  changedSignature[0] ^= 0x01;
  assert.notEqual(
    learningRuntimeDatabaseBindingReceiptDigest({
      ...envelope,
      signature_base64: changedSignature.toString("base64"),
    }),
    learningRuntimeDatabaseBindingReceiptDigest(envelope),
  );
  const verification = verifyFirst(envelope);
  assert.deepEqual(verification.receipt, envelope);
  assert.equal(
    verification.receipt_sha256,
    learningRuntimeDatabaseBindingReceiptDigest(envelope),
  );
  assert.equal(verification.authority_scope, "cryptographic_relation_only");
  assert.equal(verification.signing_eligible, false);
  assert.equal(Object.isFrozen(verification), true);
  assert.equal(Object.isFrozen(verification.receipt), true);
  assert.equal(Object.isFrozen(verification.receipt.body), true);
});

test("database binding receipt v1 exact bytes and Ed25519 signature match fixed golden vectors", () => {
  const body = bodyForPolicy(GOLDEN_POLICY);
  const envelope = signEnvelope(body, GOLDEN_LAUNCHER_PRIVATE_KEY);
  assert.equal(learningRuntimeDatabaseBindingReceiptBodyJson(body), GOLDEN_BODY_JSON);
  assert.equal(
    learningRuntimeDatabaseBindingReceiptBodyDigest(body),
    GOLDEN_BODY_SHA256,
  );
  assert.equal(envelope.signature_base64, GOLDEN_SIGNATURE_BASE64);
  assert.equal(learningRuntimeDatabaseBindingReceiptJson(envelope), GOLDEN_ENVELOPE_JSON);
  assert.equal(
    learningRuntimeDatabaseBindingReceiptDigest(envelope),
    GOLDEN_ENVELOPE_SHA256,
  );

  const verification = verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
    envelope: parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(
      Buffer.from(GOLDEN_ENVELOPE_JSON, "utf8"),
    ),
    externalExecutionPolicy: GOLDEN_POLICY,
    registeredExternalExecutionPolicySha256:
      externalExecutionPolicyDigest(GOLDEN_POLICY),
    expectedDeploymentSlot: DEPLOYMENT_SLOT,
    chainExpectation: {
      chainKind: "first",
      expectedFirstBindingAnchorSha256: FIRST_BINDING_ANCHOR_SHA256,
      expectedCheckpointGeneration: "3",
    },
  });
  assert.equal(verification.receipt_sha256, GOLDEN_ENVELOPE_SHA256);
  assert.equal(verification.signing_eligible, false);
});

test("database binding receipt canonical parsers reject altered byte encodings", () => {
  const envelope = signEnvelope(firstBody());
  const canonical = learningRuntimeDatabaseBindingReceiptJson(envelope);
  const canonicalBody = learningRuntimeDatabaseBindingReceiptBodyJson(envelope.body);
  const reordered = JSON.stringify({
    signature_algorithm: envelope.signature_algorithm,
    body: envelope.body,
    signature_base64: envelope.signature_base64,
  });
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(` ${canonical}`),
    /noncanonical_json/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(`\ufeff${canonical}`),
    /utf8_bom_forbidden/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(reordered),
    /noncanonical_json/,
  );
  const nestedBodyReordered = canonicalBody.replace(
    /^(\{)("attestor_binary_sha256":"[^"]+"),("attestor_key_id":"[^"]+")/u,
    "$1$3,$2",
  );
  assert.notEqual(nestedBodyReordered, canonicalBody);
  assert.deepEqual(JSON.parse(nestedBodyReordered), JSON.parse(canonicalBody));
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptBodyJson(nestedBodyReordered),
    /noncanonical_json/,
  );
  const noncanonicalEscaping = canonicalBody.replace(
    "acceptance-runtime-primary",
    "\\u0061cceptance-runtime-primary",
  );
  assert.notEqual(noncanonicalEscaping, canonicalBody);
  assert.deepEqual(JSON.parse(noncanonicalEscaping), JSON.parse(canonicalBody));
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptBodyJson(noncanonicalEscaping),
    /noncanonical_json/,
  );
  const duplicateKey = `{"body":${stableStringify(envelope.body)},`
    + `"signature_algorithm":"ed25519-v1",`
    + `"signature_algorithm":"ed25519-v1",`
    + `"signature_base64":${JSON.stringify(envelope.signature_base64)}}`;
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(duplicateKey),
    /noncanonical_json/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
    ),
    /utf8_bom_forbidden/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(Buffer.from([0xff])),
    /invalid_utf8/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson("{"),
    /invalid_json/,
  );
  assert.throws(
    () => parseCanonicalLearningRuntimeDatabaseBindingReceiptJson(
      `{"padding":"${"x".repeat(17 * 1024)}"}`,
    ),
    /oversized/,
  );
});

test("database binding receipt schema freezes zero-checkpoint facts and exact fields", () => {
  const body = firstBody();
  for (const [field, invalid] of [
    ["wal_checkpoint_mode", "passive"],
    ["wal_checkpoint_busy", 1],
    ["wal_checkpoint_log_frame_count", 1],
    ["wal_checkpointed_frame_count", 1],
    ["wal_file_byte_length", "1"],
    ["wal_checkpointed_and_truncated", false],
    ["database_file_device", "01"],
    ["database_file_inode", "18446744073709551616"],
    ["checkpoint_generation", "0"],
    ["checkpoint_generation", "-1"],
    ["issued_at", "2026-07-17T04:00:00Z"],
  ] as const) {
    assert.throws(
      () => LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
        ...body,
        [field]: invalid,
      }),
      undefined,
      field,
    );
  }
  for (const forbidden of [
    "database_path",
    "expect_database",
    "key_path",
    "private_key",
    "service_launcher_public_key_base64",
    "attestor_public_key_base64",
    "release_verdict",
  ]) {
    assert.throws(() => LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
      ...body,
      [forbidden]: "forbidden",
    }), undefined, forbidden);
  }
  assert.throws(() => LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
    ...body,
    binding_chain: {
      ...body.binding_chain,
      previous_database_binding_receipt_sha256: sha256("forbidden-previous"),
    },
  }));
  assert.throws(() => LearningRuntimeDatabaseBindingReceiptBodyV1Schema.parse({
    ...body,
    binding_chain: {
      chain_kind: "successor",
      previous_database_binding_receipt_sha256: sha256("previous"),
      first_binding_anchor_sha256: FIRST_BINDING_ANCHOR_SHA256,
    },
  }));
  assert.throws(() => LearningRuntimeDatabaseBindingReceiptEnvelopeV1Schema.parse({
    ...signEnvelope(body),
    private_key: "forbidden",
  }));
});

test("verification accepts no self-supplied key and checks the registered policy digest", () => {
  const body = firstBody();
  assert.throws(
    () => verifyFirst(signEnvelope(body, ATTESTOR_KEYS.privateKey)),
    /learning_external_receipt_signature_invalid/,
  );
  assert.throws(
    () => verifyFirst(signEnvelope(body, ATTACKER_KEYS.privateKey)),
    /learning_external_receipt_signature_invalid/,
  );

  const attackerPolicy = createExternalExecutionPolicy({
    launcherPublicKey: ATTACKER_KEYS.publicKey,
  });
  const attackerExpected = attackerPolicy.runtime_authority_attestor;
  const attackerBody = firstBody({
    external_execution_policy_sha256: externalExecutionPolicyDigest(attackerPolicy),
    service_launcher_public_key_sha256:
      attackerExpected.service_launcher_public_key_sha256,
  });
  assert.throws(
    () => verifyFirst(signEnvelope(attackerBody, ATTACKER_KEYS.privateKey), {
      externalExecutionPolicy: attackerPolicy,
      registeredExternalExecutionPolicySha256: POLICY_SHA256,
    }),
    /external_execution_policy_digest_mismatch/,
  );
  const policyRelativeVerification = verifyFirst(
    signEnvelope(attackerBody, ATTACKER_KEYS.privateKey),
    {
      externalExecutionPolicy: attackerPolicy,
      registeredExternalExecutionPolicySha256:
        externalExecutionPolicyDigest(attackerPolicy),
    },
  );
  assert.equal(
    policyRelativeVerification.authority_scope,
    "cryptographic_relation_only",
  );
  assert.equal(policyRelativeVerification.signing_eligible, false);
  assert.deepEqual(policyRelativeVerification.receipt.body, attackerBody);
  assert.throws(
    () => verifyFirst(signEnvelope(body), {
      registeredExternalExecutionPolicySha256: sha256("unregistered-policy"),
    }),
    /external_execution_policy_digest_mismatch/,
  );
});

test("verification binds deployment, database, launcher, and intended attestor identities", () => {
  const body = firstBody();
  const digestFields = [
    "external_execution_policy_sha256",
    "database_instance_id",
    "service_launcher_policy_sha256",
    "service_launcher_binary_sha256",
    "service_launcher_public_key_sha256",
    "attestor_binary_sha256",
    "attestor_policy_sha256",
    "attestor_public_key_sha256",
  ] as const;
  for (const field of digestFields) {
    const candidate = signEnvelope({ ...body, [field]: sha256(`tampered:${field}`) });
    assert.throws(
      () => verifyFirst(candidate),
      new RegExp(`binding_mismatch:${field}`),
      field,
    );
  }
  for (const field of [
    "service_launcher_key_id",
    "attestor_service_identity",
    "attestor_key_id",
  ] as const) {
    const candidate = signEnvelope({ ...body, [field]: `tampered-${field}` });
    assert.throws(
      () => verifyFirst(candidate),
      new RegExp(`binding_mismatch:${field}`),
      field,
    );
  }
  assert.throws(
    () => verifyFirst(signEnvelope(body), { expectedDeploymentSlot: "another-slot" }),
    /binding_mismatch:deployment_slot/,
  );
  assert.throws(
    () => verifyFirst(signEnvelope(body), {
      expectedFirstBindingAnchorSha256: sha256("another-anchor"),
    }),
    /first_binding_anchor_mismatch/,
  );
  assert.throws(
    () => verifyFirst(signEnvelope(body), { expectedCheckpointGeneration: "4" }),
    /durable_checkpoint_generation_mismatch/,
  );
});

test("successor receipt verifies its signed predecessor and permits burned generations", () => {
  const first = signEnvelope(firstBody());
  const successorBody = firstBody({
    checkpoint_generation: "7",
    database_main_file_byte_length: "8192",
    database_main_file_sha256: sha256("database-main:successor"),
    writer_fence_inspection_sha256: sha256("writer-fence:successor"),
    binding_chain: {
      chain_kind: "successor",
      previous_database_binding_receipt_sha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
    },
    issued_at: "2026-07-17T04:01:00.000Z",
  });
  const successor = signEnvelope(successorBody);
  const verification = verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
    envelope: successor,
    externalExecutionPolicy: POLICY,
    registeredExternalExecutionPolicySha256: POLICY_SHA256,
    expectedDeploymentSlot: DEPLOYMENT_SLOT,
    chainExpectation: {
      chainKind: "successor",
      previousReceipt: first,
      previousExternalExecutionPolicy: POLICY,
      previousRegisteredExternalExecutionPolicySha256: POLICY_SHA256,
      expectedPreviousReceiptSha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
      expectedCheckpointGeneration: "7",
    },
  });
  assert.deepEqual(verification.receipt, successor);
  assert.equal(verification.signing_eligible, false);
});

test("successor receipt preserves one slot chain across policy and launcher-key rotation", () => {
  const first = signEnvelope(firstBody());
  const rotatedPolicy = createExternalExecutionPolicy({
    launcherPublicKey: ATTACKER_KEYS.publicKey,
  });
  const rotatedPolicySha256 = externalExecutionPolicyDigest(rotatedPolicy);
  const successorBody = bodyForPolicy(rotatedPolicy, {
    checkpoint_generation: "7",
    database_main_file_byte_length: "8192",
    database_main_file_sha256: sha256("database-main:rotated-successor"),
    writer_fence_inspection_sha256: sha256("writer-fence:rotated-successor"),
    binding_chain: {
      chain_kind: "successor",
      previous_database_binding_receipt_sha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
    },
    issued_at: "2026-07-17T04:01:00.000Z",
  });
  const successor = signEnvelope(successorBody, ATTACKER_KEYS.privateKey);

  const verification = verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
    envelope: successor,
    externalExecutionPolicy: rotatedPolicy,
    registeredExternalExecutionPolicySha256: rotatedPolicySha256,
    expectedDeploymentSlot: DEPLOYMENT_SLOT,
    chainExpectation: {
      chainKind: "successor",
      previousReceipt: first,
      previousExternalExecutionPolicy: POLICY,
      previousRegisteredExternalExecutionPolicySha256: POLICY_SHA256,
      expectedPreviousReceiptSha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
      expectedCheckpointGeneration: "7",
    },
  });

  assert.deepEqual(verification.receipt, successor);
  assert.equal(verification.authority_scope, "cryptographic_relation_only");
  assert.notEqual(
    successor.body.external_execution_policy_sha256,
    first.body.external_execution_policy_sha256,
  );
  assert.notEqual(
    successor.body.service_launcher_public_key_sha256,
    first.body.service_launcher_public_key_sha256,
  );

  assert.throws(
    () => verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
      envelope: successor,
      externalExecutionPolicy: rotatedPolicy,
      registeredExternalExecutionPolicySha256: rotatedPolicySha256,
      expectedDeploymentSlot: DEPLOYMENT_SLOT,
      chainExpectation: {
        chainKind: "successor",
        previousReceipt: first,
        previousExternalExecutionPolicy: rotatedPolicy,
        previousRegisteredExternalExecutionPolicySha256: rotatedPolicySha256,
        expectedPreviousReceiptSha256:
          learningRuntimeDatabaseBindingReceiptDigest(first),
        expectedCheckpointGeneration: "7",
      },
    }),
    /binding_mismatch:external_execution_policy_sha256/,
  );
  assert.throws(
    () => verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
      envelope: successor,
      externalExecutionPolicy: rotatedPolicy,
      registeredExternalExecutionPolicySha256: rotatedPolicySha256,
      expectedDeploymentSlot: DEPLOYMENT_SLOT,
      chainExpectation: {
        chainKind: "successor",
        previousReceipt: first,
        previousExternalExecutionPolicy: POLICY,
        previousRegisteredExternalExecutionPolicySha256: rotatedPolicySha256,
        expectedPreviousReceiptSha256:
          learningRuntimeDatabaseBindingReceiptDigest(first),
        expectedCheckpointGeneration: "7",
      },
    }),
    /external_execution_policy_digest_mismatch/,
  );

  const driftedPolicy = createExternalExecutionPolicy({
    launcherPublicKey: ATTACKER_KEYS.publicKey,
    databaseInstanceId: sha256("another-database-instance"),
  });
  const driftedBody = bodyForPolicy(driftedPolicy, {
    checkpoint_generation: "8",
    binding_chain: {
      chain_kind: "successor",
      previous_database_binding_receipt_sha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
    },
    issued_at: "2026-07-17T04:02:00.000Z",
  });
  const drifted = signEnvelope(driftedBody, ATTACKER_KEYS.privateKey);
  assert.throws(
    () => verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
      envelope: drifted,
      externalExecutionPolicy: driftedPolicy,
      registeredExternalExecutionPolicySha256:
        externalExecutionPolicyDigest(driftedPolicy),
      expectedDeploymentSlot: DEPLOYMENT_SLOT,
      chainExpectation: {
        chainKind: "successor",
        previousReceipt: first,
        previousExternalExecutionPolicy: POLICY,
        previousRegisteredExternalExecutionPolicySha256: POLICY_SHA256,
        expectedPreviousReceiptSha256:
          learningRuntimeDatabaseBindingReceiptDigest(first),
        expectedCheckpointGeneration: "8",
      },
    }),
    /physical_database_identity_changed:database_instance_id/,
  );
});

test("successor receipt rejects predecessor, physical identity, generation, and time drift", () => {
  const first = signEnvelope(firstBody());
  const base = firstBody({
    checkpoint_generation: "7",
    binding_chain: {
      chain_kind: "successor",
      previous_database_binding_receipt_sha256:
        learningRuntimeDatabaseBindingReceiptDigest(first),
    },
    issued_at: "2026-07-17T04:01:00.000Z",
  });
  const verifySuccessor = (
    candidateBody: unknown,
    previousReceipt: unknown = first,
    expectedPreviousReceiptSha256 = learningRuntimeDatabaseBindingReceiptDigest(first),
    expectedCheckpointGeneration = "7",
  ) =>
    verifyLearningRuntimeDatabaseBindingReceiptCryptographicRelation({
      envelope: signEnvelope(candidateBody),
      externalExecutionPolicy: POLICY,
      registeredExternalExecutionPolicySha256: POLICY_SHA256,
      expectedDeploymentSlot: DEPLOYMENT_SLOT,
      chainExpectation: {
        chainKind: "successor",
        previousReceipt,
        previousExternalExecutionPolicy: POLICY,
        previousRegisteredExternalExecutionPolicySha256: POLICY_SHA256,
        expectedPreviousReceiptSha256,
        expectedCheckpointGeneration,
      },
    });

  assert.throws(
    () => verifySuccessor({
      ...base,
      binding_chain: {
        chain_kind: "successor",
        previous_database_binding_receipt_sha256: sha256("wrong-previous"),
      },
    }),
    /previous_binding_receipt_digest_mismatch/,
  );
  assert.throws(
    () => verifySuccessor({
      ...base,
      binding_chain: {
        chain_kind: "successor",
        previous_database_binding_receipt_sha256:
          learningRuntimeDatabaseBindingReceiptBodyDigest(first.body),
      },
    }),
    /previous_binding_receipt_digest_mismatch/,
  );
  for (const generation of ["3", "2"]) {
    assert.throws(
      () => verifySuccessor(
        { ...base, checkpoint_generation: generation },
        first,
        learningRuntimeDatabaseBindingReceiptDigest(first),
        generation,
      ),
      /checkpoint_generation_not_monotonic/,
    );
  }
  assert.throws(
    () => verifySuccessor(base, first, learningRuntimeDatabaseBindingReceiptDigest(first), "8"),
    /durable_checkpoint_generation_mismatch/,
  );
  assert.throws(
    () => verifySuccessor({ ...base, database_file_device: "102" }),
    /physical_database_identity_changed:database_file_device/,
  );
  assert.throws(
    () => verifySuccessor({ ...base, database_file_inode: "203" }),
    /physical_database_identity_changed:database_file_inode/,
  );
  assert.throws(
    () => verifySuccessor({ ...base, issued_at: "2026-07-17T03:59:59.999Z" }),
    /issued_at_precedes_previous_receipt/,
  );
  const invalidPrevious = {
    ...first,
    signature_base64: Buffer.alloc(64).toString("base64"),
  };
  assert.throws(
    () => verifySuccessor(base, invalidPrevious),
    /learning_external_receipt_signature_invalid/,
  );
  const alternatePrevious = signEnvelope(firstBody({
    checkpoint_generation: "4",
    database_main_file_sha256: sha256("alternate-valid-launcher-signed-branch"),
    issued_at: "2026-07-17T04:00:30.000Z",
  }));
  const alternateDigest = learningRuntimeDatabaseBindingReceiptDigest(alternatePrevious);
  const alternateSuccessor = {
    ...base,
    binding_chain: {
      chain_kind: "successor" as const,
      previous_database_binding_receipt_sha256: alternateDigest,
    },
  };
  assert.throws(
    () => verifySuccessor(
      alternateSuccessor,
      alternatePrevious,
      learningRuntimeDatabaseBindingReceiptDigest(first),
    ),
    /durable_chain_head_mismatch/,
  );
  assert.throws(
    () => verifyFirst(signEnvelope(base), { expectedCheckpointGeneration: "7" }),
    /chain_kind_mismatch:first/,
  );
});
