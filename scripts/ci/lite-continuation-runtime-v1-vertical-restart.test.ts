import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authorityArtifactPublicKeySha256,
  buildSignedAuthorityArtifactV1,
} from "../../src/continuation/authority-artifact.js";
import { buildContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import {
  canonicalContinuationJson,
  canonicalContinuationSha256,
  type CanonicalJson,
  type Sha256,
} from "../../src/continuation/contract.js";
import { buildEffectEvidencePolicyV1 } from
  "../../src/continuation/effect-certificate.js";
import {
  EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  EFFECT_VERIFIER_CONTRACT_SHA256_V1,
} from "../../src/continuation/effect-evaluation.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import type {
  CreateContinuationBodyV1,
  RecordObservationsBodyV1,
  RecordOutcomeBodyV1,
} from "../../src/runtime-v1/command.js";
import type { OfflinePolicyBundleInstallCommandV1 } from
  "../../src/runtime-v1/provisioning.js";
import { createAionisRuntimeV1Client } from
  "../../src/runtime-v1/sdk.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DAEMON_ENTRY = fileURLToPath(
  new URL("../../src/runtime-v1/daemon-entry.ts", import.meta.url),
);
const PROVISIONING_ENTRY = fileURLToPath(
  new URL("../../src/runtime-v1/provisioning-entry.ts", import.meta.url),
);
const TENANT = "tenant-vertical-restart";
const SCOPE = "scope-vertical-restart";
const TASK_FAMILY = "coding";
const HOST_PRINCIPAL_ID = "host-vertical-restart";
const OPERATOR_PRINCIPAL_ID = "operator-vertical-restart";
const HOST_TOKEN = "host-token-vertical-restart-abcdefghijklmnopqrstuvwxyz";
const OPERATOR_TOKEN = "operator-token-vertical-restart-abcdefghijklmnopqrstuvwxyz";
const CHILD_OUTPUT_LIMIT = 128 * 1024;
const PROCESS_TIMEOUT_MS = 20_000;

type ProcessCapture = {
  stdout: string;
  stderr: string;
  overflowed: boolean;
};

type ManagedChild = Readonly<{
  child: ChildProcessWithoutNullStreams;
  closed: Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>;
  capture: ProcessCapture;
}>;

type VerticalFixture = Readonly<{
  root: string;
  dataPath: string;
  trustRootPath: string;
  trustRootSha256: Sha256;
  port: number;
  daemonEnvironment: Readonly<Record<string, string>>;
  provisioningEnvironment: Readonly<Record<string, string>>;
  provisioningCommand: OfflinePolicyBundleInstallCommandV1;
  observationBody: RecordObservationsBodyV1;
}>;

function principalSha256(
  principalKind: "trusted_host" | "operator",
  principalId: string,
): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "continuation_runtime_principal_v1",
    tenant_id: TENANT,
    principal_kind: principalKind,
    principal_id: principalId,
    authentication: "bearer_sha256_v1",
  });
}

function evidenceSha256(id: string): Sha256 {
  return canonicalContinuationSha256({
    schema_version: "vertical_restart_evidence_v1",
    evidence_id: id,
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function reserveUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

function cleanChildEnvironment(
  specific: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const inherited = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of [
    "HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return {
    ...inherited,
    FORCE_COLOR: "0",
    NODE_NO_WARNINGS: "1",
    ...specific,
  };
}

function appendBounded(
  capture: ProcessCapture,
  field: "stdout" | "stderr",
  chunk: unknown,
  child: ChildProcessWithoutNullStreams,
): void {
  const next = `${capture[field]}${String(chunk)}`;
  if (Buffer.byteLength(next, "utf8") > CHILD_OUTPUT_LIMIT) {
    capture.overflowed = true;
    child.kill("SIGKILL");
    return;
  }
  capture[field] = next;
}

function spawnEntry(
  entry: string,
  environment: Readonly<Record<string, string>>,
): ManagedChild {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: ROOT,
    env: cleanChildEnvironment(environment),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const capture: ProcessCapture = { stdout: "", stderr: "", overflowed: false };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => appendBounded(capture, "stdout", chunk, child));
  child.stderr.on("data", (chunk) => appendBounded(capture, "stderr", chunk, child));
  const closed = new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, capture };
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = PROCESS_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseJsonLines(value: string, expectedCount: number): readonly unknown[] {
  const lines = value.trim().split("\n");
  assert.equal(lines.length, expectedCount);
  return lines.map((line) => JSON.parse(line) as unknown);
}

function canonicalRecord(
  value: CanonicalJson,
  field: string,
): Readonly<Record<string, CanonicalJson>> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), field);
  return value as Readonly<Record<string, CanonicalJson>>;
}

function recordField(
  value: Readonly<Record<string, CanonicalJson>>,
  field: string,
): Readonly<Record<string, CanonicalJson>> {
  assert.ok(Object.prototype.hasOwnProperty.call(value, field), field);
  return canonicalRecord(value[field]!, field);
}

function textField(
  value: Readonly<Record<string, CanonicalJson>>,
  field: string,
): string {
  assert.equal(typeof value[field], "string", field);
  return value[field] as string;
}

function assertNoSensitiveLogMaterial(
  output: string,
  fixture: VerticalFixture,
): void {
  for (const forbidden of [
    HOST_TOKEN,
    OPERATOR_TOKEN,
    fixture.dataPath,
    fixture.trustRootPath,
    "BEGIN PUBLIC KEY",
    "candidate_limit",
    "host_task_id",
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
}

async function waitForProbe(
  child: ManagedChild,
  port: number,
  path: "/healthz" | "/readyz",
  expectedStatus: 200 | 503,
): Promise<CanonicalJson> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null || child.child.signalCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === expectedStatus) {
        return await response.json() as CanonicalJson;
      }
    } catch {
      // The real child listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`probe_unavailable:${path}:${expectedStatus}`);
}

function assertClosedDatabaseNamespace(fixture: VerticalFixture): void {
  assert.equal(existsSync(`${fixture.dataPath}-wal`), false);
  assert.equal(existsSync(`${fixture.dataPath}-shm`), false);
}

async function stopDaemon(
  daemon: ManagedChild,
  fixture: VerticalFixture,
  active: Set<ManagedChild>,
): Promise<void> {
  assert.equal(daemon.child.kill("SIGTERM"), true);
  const exit = await within(daemon.closed, "daemon_sigterm");
  active.delete(daemon);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(daemon.capture.overflowed, false);
  assert.equal(daemon.capture.stderr, "");
  const events = parseJsonLines(daemon.capture.stdout, 2) as readonly Array<{
    event?: unknown;
    shutdown?: { status?: unknown; completed_phases?: unknown };
  }>;
  assert.equal(events[0]?.event, "listening");
  assert.equal(events[1]?.event, "shutdown_complete");
  assert.equal(events[1]?.shutdown?.status, "graceful");
  assert.deepEqual(events[1]?.shutdown?.completed_phases, [
    "stop_new_work",
    "drain_in_flight",
    "close_database",
  ]);
  assertNoSensitiveLogMaterial(daemon.capture.stdout, fixture);
  assertClosedDatabaseNamespace(fixture);
}

async function installPolicyBundle(
  fixture: VerticalFixture,
  active: Set<ManagedChild>,
): Promise<void> {
  const provisioner = spawnEntry(PROVISIONING_ENTRY, fixture.provisioningEnvironment);
  active.add(provisioner);
  provisioner.child.stdin.end(
    `${canonicalContinuationJson(fixture.provisioningCommand)}\n`,
  );
  const exit = await within(provisioner.closed, "policy_provisioning");
  active.delete(provisioner);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(provisioner.capture.overflowed, false);
  assert.equal(provisioner.capture.stderr, "");
  const events = parseJsonLines(provisioner.capture.stdout, 1) as readonly Array<{
    event?: unknown;
    operation?: { status?: unknown };
  }>;
  assert.equal(events[0]?.event, "provisioning_complete");
  assert.equal(events[0]?.operation?.status, "created");
  assertNoSensitiveLogMaterial(provisioner.capture.stdout, fixture);
  assertClosedDatabaseNamespace(fixture);
}

async function killRemaining(children: Set<ManagedChild>): Promise<void> {
  await Promise.all([...children].map(async (managed) => {
    if (managed.child.exitCode === null && managed.child.signalCode === null) {
      managed.child.kill("SIGKILL");
    }
    await within(managed.closed, "forced_child_cleanup", 5_000).catch(() => undefined);
  }));
  children.clear();
}

function createFixture(port: number): VerticalFixture {
  const root = mkdtempSync(join(tmpdir(), "aionis-v1-vertical-restart-"));
  chmodSync(root, 0o700);
  const dataPath = join(root, "authority", "runtime.sqlite");
  const trustRootPath = join(root, "authority-root.public.pem");
  const rootKeys = generateKeyPairSync("ed25519");
  const effectKeys = generateKeyPairSync("ed25519");
  writeFileSync(
    trustRootPath,
    rootKeys.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 },
  );
  chmodSync(trustRootPath, 0o600);

  const trustRootSha256 = authorityArtifactPublicKeySha256(rootKeys.publicKey);
  const subject = continuationAuthoritySubjectSha256V1({
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
  });
  const hostPrincipalSha256 = principalSha256("trusted_host", HOST_PRINCIPAL_ID);
  const operatorPrincipalSha256 = principalSha256("operator", OPERATOR_PRINCIPAL_ID);
  const effectVerifierSha256 = authorityArtifactPublicKeySha256(effectKeys.publicKey);
  const compilerPolicy = buildContinuationCompilerPolicyV1({
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: subject,
    candidate_limit: 128,
    continuity_candidate_limit: 64,
    learning_candidate_limit: 64,
    selected_capsule_limit: 64,
    obligation_limit: 64,
    max_render_budget: 65_536,
    hard_coverage_weight: 1_000_000,
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [hostPrincipalSha256],
      external_verifier: [],
    },
  });
  const evidencePolicy = buildEffectEvidencePolicyV1({
    schema_version: "effect_evidence_policy_v1",
    tenant_id: TENANT,
    authority_subject_sha256: subject,
    trusted_effect_verifier_principals: [effectVerifierSha256],
    max_eligible_decisions: 256,
    max_treatment_delta_count: 32,
    min_evidence_window_ms: 60_000,
    max_evidence_window_ms: 86_400_000,
    min_control_exposures: 10,
    min_candidate_exposures: 10,
    max_missingness_bps: 0,
    harm_noninferiority_margin_bps: 0,
    utility_min_lift_bps: 1,
    confidence_bps: 9_000,
    effect_verifier_contract_sha256: EFFECT_VERIFIER_CONTRACT_SHA256_V1,
    statistical_contract_sha256: EFFECT_STATISTICAL_CONTRACT_SHA256_V1,
  });
  const artifactCommon = {
    tenant_id: TENANT,
    authority_subject_sha256: subject,
    valid_from: "2020-01-02T00:00:00.000Z",
    expires_at: null,
    created_at: "2020-01-01T00:00:00.000Z",
  } as const;
  const signedCompiler = buildSignedAuthorityArtifactV1({
    ...artifactCommon,
    artifact_id: "compiler-vertical-restart",
    artifact_revision: 1,
    artifact_kind: "compiler_policy",
    artifact_schema: "continuation_compiler_policy_v1",
    payload: compilerPolicy,
  }, rootKeys.privateKey);
  const signedEvidence = buildSignedAuthorityArtifactV1({
    ...artifactCommon,
    artifact_id: "evidence-vertical-restart",
    artifact_revision: 1,
    artifact_kind: "evidence_policy",
    artifact_schema: "effect_evidence_policy_v1",
    payload: evidencePolicy,
  }, rootKeys.privateKey);
  const provisioningCommand: OfflinePolicyBundleInstallCommandV1 = {
    schema_version: "offline_provisioning_command_v1",
    kind: "policy_bundle_install",
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    operation_id: "provision-vertical-policy-1",
    actor_kind: "operator",
    actor_principal_sha256: operatorPrincipalSha256,
    authority_subject_sha256: subject,
    policy_bundle: {
      schema_version: "authority_policy_provisioning_bundle_v1",
      tenant_id: TENANT,
      authority_subject_sha256: subject,
      compiler_policy: signedCompiler,
      evidence_policy: signedEvidence,
    },
  };
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const observationBody: RecordObservationsBodyV1 = {
    schema_version: "record_observations_body_v1",
    host_task: {
      host_task_id: "task-vertical-restart",
      episode_id: "episode-vertical-restart",
      run_id: "run-vertical-restart",
      consumer_agent_id: "agent-vertical-restart",
      consumer_team_id: null,
      task_family: TASK_FAMILY,
      task_signature: "task-signature-vertical-restart",
      workflow_signature: null,
      workspace_signature: "workspace-vertical-restart",
      source_task_sha256: evidenceSha256("source-task"),
      source_event_sha256: evidenceSha256("source-event"),
      issued_at: issuedAt,
      expires_at: expiresAt,
    },
    memory_inputs: [],
    collector_observations: [],
    signed_observations: [],
  };
  const authorityEnvironment = {
    AIONIS_DATA_PATH: dataPath,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: trustRootPath,
    AIONIS_TRUST_ROOT_SHA256: trustRootSha256,
  } as const;
  return {
    root,
    dataPath,
    trustRootPath,
    trustRootSha256,
    port,
    provisioningEnvironment: authorityEnvironment,
    daemonEnvironment: {
      ...authorityEnvironment,
      AIONIS_TENANT_ID: TENANT,
      AIONIS_HOST_PRINCIPAL_ID: HOST_PRINCIPAL_ID,
      AIONIS_HOST_API_KEY: HOST_TOKEN,
      AIONIS_OPERATOR_PRINCIPAL_ID: OPERATOR_PRINCIPAL_ID,
      AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
      AIONIS_HTTP_HOST: "127.0.0.1",
      AIONIS_HTTP_PORT: String(port),
      AIONIS_HTTP_BODY_LIMIT_BYTES: "1048576",
      AIONIS_LOG_LEVEL: "silent",
      AIONIS_SHUTDOWN_TIMEOUT_MS: "10000",
    },
    provisioningCommand,
    observationBody,
  };
}

test("root-signed provisioning, real SDK traffic, graceful close, and same-DB restart form one exact chain", {
  skip: process.platform === "win32" ? "POSIX signal contract" : false,
  timeout: 120_000,
}, async () => {
  const fixture = createFixture(await reserveUnusedPort());
  const active = new Set<ManagedChild>();
  try {
    assert.equal(lstatSync(fixture.root).mode & 0o7777, 0o700);
    assert.equal(lstatSync(fixture.trustRootPath).mode & 0o7777, 0o600);

    const freshDaemon = spawnEntry(DAEMON_ENTRY, fixture.daemonEnvironment);
    active.add(freshDaemon);
    freshDaemon.child.stdin.end();
    assert.deepEqual(await waitForProbe(freshDaemon, fixture.port, "/healthz", 200), {
      schema_version: "continuation_runtime_health_v1",
      status: "alive",
    });
    assert.deepEqual(await waitForProbe(freshDaemon, fixture.port, "/readyz", 503), {
      schema_version: "continuation_runtime_readiness_v1",
      status: "not_ready",
      reason_codes: ["policy_bundle_unavailable"],
    });
    await stopDaemon(freshDaemon, fixture, active);

    await installPolicyBundle(fixture, active);

    const servingDaemon = spawnEntry(DAEMON_ENTRY, fixture.daemonEnvironment);
    active.add(servingDaemon);
    servingDaemon.child.stdin.end();
    assert.deepEqual(await waitForProbe(servingDaemon, fixture.port, "/readyz", 200), {
      schema_version: "continuation_runtime_readiness_v1",
      status: "ready",
      reason_codes: [],
    });

    const baseUrl = `http://127.0.0.1:${fixture.port}`;
    const client = createAionisRuntimeV1Client({
      baseUrl,
      apiKey: HOST_TOKEN,
      timeoutMs: 10_000,
      requestBodyLimitBytes: 1_048_576,
      responseBodyLimitBytes: 5_242_880,
    });
    assert.deepEqual(Object.keys(client).sort(), [
      "createContinuation",
      "decideAuthority",
      "readDecision",
      "recordObservations",
      "recordOutcome",
    ]);

    const observationInput = {
      operationId: "observe-vertical-restart-1",
      scope: SCOPE,
      body: fixture.observationBody,
    } as const;
    const observation = await client.recordObservations(observationInput);
    const observationReplay = await client.recordObservations(observationInput);
    assert.equal(
      canonicalContinuationJson(observationReplay),
      canonicalContinuationJson(observation),
    );
    const observationResult = recordField(
      canonicalRecord(observation, "observation_response"),
      "result",
    );
    const snapshotRef = recordField(observationResult, "observation_snapshot_ref");

    const continuationBody: CreateContinuationBodyV1 = {
      schema_version: "create_continuation_body_v1",
      world_snapshot_ref: {
        world_snapshot_id: textField(snapshotRef, "world_snapshot_id"),
        world_snapshot_sha256: textField(snapshotRef, "world_snapshot_sha256"),
      },
      obligations: [],
      render_budget_bytes: 4_096,
    };
    const continuationInput = {
      operationId: "continue-vertical-restart-1",
      scope: SCOPE,
      body: continuationBody,
    } as const;
    const continuation = await client.createContinuation(continuationInput);
    const continuationReplay = await client.createContinuation(continuationInput);
    assert.equal(
      canonicalContinuationJson(continuationReplay),
      canonicalContinuationJson(continuation),
    );
    const continuationRecord = canonicalRecord(
      continuation,
      "continuation_response",
    );
    const contract = recordField(continuationRecord, "continuation_contract");
    const renderResult = recordField(continuationRecord, "render_result");
    const exposureReceipt = recordField(continuationRecord, "exposure_receipt");
    const decisionId = textField(continuationRecord, "decision_id");
    const observedAt = new Date().toISOString();

    const outcomeBody: RecordOutcomeBodyV1 = {
      schema_version: "record_outcome_body_v1",
      decision_ref: {
        decision_id: decisionId,
        contract_sha256: textField(contract, "contract_sha256"),
        exposure_receipt_sha256: textField(exposureReceipt, "event_sha256"),
      },
      use_receipt: {
        schema_version: "host_capsule_use_receipt_v1",
        decision_id: decisionId,
        use_id: "use-vertical-restart-1",
        observed_at: observedAt,
        render_result_sha256: textField(renderResult, "render_result_sha256"),
        capsule_uses: [],
        evidence_sha256: evidenceSha256("use-receipt"),
      },
      outcome_receipt: {
        schema_version: "host_outcome_receipt_v1",
        decision_id: decisionId,
        observed_at: observedAt,
        outcome: "succeeded",
        outcome_code: "vertical_chain_completed",
        evidence_sha256: evidenceSha256("outcome-receipt"),
        summary: null,
      },
    };
    const outcomeInput = {
      operationId: "outcome-vertical-restart-1",
      scope: SCOPE,
      body: outcomeBody,
    } as const;
    const outcome = await client.recordOutcome(outcomeInput);
    const outcomeReplay = await client.recordOutcome(outcomeInput);
    assert.equal(canonicalContinuationJson(outcomeReplay), canonicalContinuationJson(outcome));

    const readInput = {
      decisionId,
      scope: SCOPE,
      view: "summary" as const,
      excludeCapsule: null,
      substituteBranch: null,
    };
    const decision = await client.readDecision(readInput);
    assert.equal(
      textField(canonicalRecord(decision, "decision_response"), "decision_id"),
      decisionId,
    );
    await stopDaemon(servingDaemon, fixture, active);

    const restartedDaemon = spawnEntry(DAEMON_ENTRY, fixture.daemonEnvironment);
    active.add(restartedDaemon);
    restartedDaemon.child.stdin.end();
    assert.deepEqual(await waitForProbe(restartedDaemon, fixture.port, "/readyz", 200), {
      schema_version: "continuation_runtime_readiness_v1",
      status: "ready",
      reason_codes: [],
    });
    const restartedClient = createAionisRuntimeV1Client({
      baseUrl,
      apiKey: HOST_TOKEN,
      timeoutMs: 10_000,
      requestBodyLimitBytes: 1_048_576,
      responseBodyLimitBytes: 5_242_880,
    });
    assert.equal(
      canonicalContinuationJson(await restartedClient.recordObservations(observationInput)),
      canonicalContinuationJson(observation),
    );
    assert.equal(
      canonicalContinuationJson(await restartedClient.createContinuation(continuationInput)),
      canonicalContinuationJson(continuation),
    );
    assert.equal(
      canonicalContinuationJson(await restartedClient.recordOutcome(outcomeInput)),
      canonicalContinuationJson(outcome),
    );
    assert.equal(
      canonicalContinuationJson(await restartedClient.readDecision(readInput)),
      canonicalContinuationJson(decision),
    );
    await stopDaemon(restartedDaemon, fixture, active);

    assert.equal(lstatSync(dirname(fixture.dataPath)).mode & 0o7777, 0o700);
    assert.equal(lstatSync(fixture.dataPath).mode & 0o7777, 0o600);
    assertClosedDatabaseNamespace(fixture);
  } finally {
    await killRemaining(active);
    rmSync(fixture.root, { recursive: true, force: true });
    assert.equal(existsSync(fixture.root), false);
  }
});
