#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This release gate deliberately exercises the compiled artifact. Keep the
// build-output URL explicit without making dist/ part of the source inventory.
const DIST_URL = new URL("../../dist/", import.meta.url);
const {
  canonicalContinuationJson,
  canonicalContinuationSha256,
} = await import(new URL("continuation/contract.js", DIST_URL));
const { continuationAuthoritySubjectSha256V1 } = await import(
  new URL("continuation/task-envelope.js", DIST_URL)
);
const { continuationRuntimeV1PrincipalSha256 } = await import(
  new URL("runtime-v1/auth.js", DIST_URL)
);
const { createAionisRuntimeV1Client } = await import(
  new URL("runtime-v1/sdk.js", DIST_URL)
);

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IMAGE = process.env.AIONIS_CONTAINER_SMOKE_IMAGE
  ?? "aionis-continuation-runtime-v1:ci";
const AUTHORITY_BUILD = join(
  ROOT,
  "tools/build-continuation-runtime-v1-authority.mjs",
);
const AUTHORITY_AUTHOR = join(
  ROOT,
  "dist-authority/tools/author-continuation-runtime-v1-authority.js",
);
const AUTHORITY_MANIFEST = join(
  ROOT,
  "dist-authority/authority-build-manifest.canonical.json",
);
const KEYGEN = join(
  ROOT,
  "tools/generate-continuation-runtime-v1-authority-keys.mjs",
);
const SEEDGEN = join(
  ROOT,
  "tools/generate-continuation-runtime-v1-cohort-seed.mjs",
);
const POLICY_TEMPLATE = join(
  ROOT,
  "docs/examples/continuation-runtime-v1-policy-bundle-authoring-request.canonical.json",
);
const COHORT_TEMPLATE = join(
  ROOT,
  "docs/examples/continuation-runtime-v1-experiment-cohort-authoring-request.canonical.json",
);
const COMPOSE_FILE = join(ROOT, "docker-compose.yml");

const TENANT = "tenant-container-smoke";
const SCOPE = "scope-container-smoke";
const TASK_FAMILY = "coding";
const HOST_ID = "host-container-smoke";
const OPERATOR_ID = "operator-container-smoke";
const HOST_TOKEN = "host-container-smoke-token-abcdefghijklmnopqrstuvwxyz";
const OPERATOR_TOKEN =
  "operator-container-smoke-token-abcdefghijklmnopqrstuvwxyz";
const EMBEDDING_TOKEN =
  "embedding-container-smoke-token-abcdefghijklmnopqrstuvwxyz";
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

let smokeRoot = "";
let composeEnvironment = null;
let composeProject = "";

function fail(code, details = "") {
  const suffix = details === "" ? "" : `:${redact(details).slice(0, 2_048)}`;
  throw new Error(`continuation_runtime_v1_container_smoke_${code}${suffix}`);
}

function redact(value) {
  let output = String(value);
  for (const secret of [HOST_TOKEN, OPERATOR_TOKEN, EMBEDDING_TOKEN, smokeRoot]) {
    if (secret !== "") output = output.split(secret).join("[redacted]");
  }
  return output;
}

function cleanEnvironment(extra = {}) {
  const environment = Object.create(null);
  for (const name of [
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "HOME",
    "PATH",
    "SystemRoot",
    "TMP",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...extra };
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: options.env ?? cleanEnvironment(),
    input: options.input,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    fail(`${options.label ?? "command"}_spawn_failed`, result.error.message);
  }
  if (result.status !== 0) {
    fail(
      `${options.label ?? "command"}_failed`,
      `${result.signal ?? result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function compose(args, options = {}) {
  assert.ok(composeEnvironment !== null);
  return run("docker", [
    "compose",
    "--ansi",
    "never",
    "--env-file",
    "/dev/null",
    "--project-name",
    composeProject,
    "--project-directory",
    ROOT,
    "--file",
    COMPOSE_FILE,
    ...args,
  ], {
    ...options,
    env: composeEnvironment,
    label: options.label ?? "compose",
  });
}

function canonicalRecord(value, field) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), field);
  return value;
}

function fieldRecord(value, field) {
  return canonicalRecord(canonicalRecord(value, field)[field], field);
}

function jsonLine(output, field) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const jsonLines = lines.filter((line) => line.startsWith("{") && line.endsWith("}"));
  assert.equal(jsonLines.length, 1, `${field} must emit one JSON event`);
  const value = JSON.parse(jsonLines[0]);
  assert.equal(canonicalContinuationJson(value), jsonLines[0], `${field} must be canonical`);
  return canonicalRecord(value, field);
}

function sha(label) {
  return canonicalContinuationSha256({
    schema_version: "continuation_runtime_v1_container_smoke_evidence_v1",
    label,
  });
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  return port;
}

function buildAuthorityClosure() {
  const built = run("/usr/bin/env", ["-i", process.execPath, AUTHORITY_BUILD], {
    label: "authority_build",
  });
  assert.equal(built.stderr, "");
  const event = jsonLine(built.stdout, "authority_build");
  assert.equal(event.event, "authority_build_complete");
  const manifestText = readFileSync(AUTHORITY_MANIFEST, "utf8").trim();
  const manifest = JSON.parse(manifestText);
  assert.equal(canonicalContinuationJson(manifest), manifestText);
  assert.equal(manifest.closure_sha256, event.closure_sha256);
  assert.equal(manifest.entrypoint,
    "tools/author-continuation-runtime-v1-authority.js");
}

function generateAuthorityMaterial(authorityDirectory, seedPath) {
  const keygen = run("/usr/bin/env", [
    "-i",
    process.execPath,
    KEYGEN,
    authorityDirectory,
  ], { label: "authority_keygen" });
  assert.equal(keygen.stderr, "");
  const keys = jsonLine(keygen.stdout, "authority_keygen");
  assert.equal(keys.event, "authority_keys_generated");
  assert.match(keys.trust_root_sha256, /^[0-9a-f]{64}$/u);
  assert.match(keys.effect_signer_sha256, /^[0-9a-f]{64}$/u);
  assert.notEqual(keys.trust_root_sha256, keys.effect_signer_sha256);

  const seedgen = run("/usr/bin/env", [
    "-i",
    process.execPath,
    SEEDGEN,
    seedPath,
  ], { label: "cohort_seedgen" });
  assert.equal(seedgen.stderr, "");
  const seed = jsonLine(seedgen.stdout, "cohort_seedgen");
  assert.equal(seed.event, "cohort_seed_generated");
  assert.equal(seed.assignment_seed_bytes, 32);
  assert.match(seed.assignment_seed_commitment_sha256, /^[0-9a-f]{64}$/u);
  return { keys, seed };
}

function signRequest(request, rootPrivateKeyPath) {
  const canonical = `${canonicalContinuationJson(request)}\n`;
  const signed = run("/usr/bin/env", [
    "-i",
    "/bin/sh",
    "-c",
    "exec \"$1\" \"$2\" 3<\"$3\"",
    "authority-sign",
    process.execPath,
    AUTHORITY_AUTHOR,
    rootPrivateKeyPath,
  ], {
    input: canonical,
    label: "authority_sign",
  });
  assert.equal(signed.stderr, "");
  return jsonLine(signed.stdout, "authority_sign");
}

function policyRequest(subject, hostPrincipalSha256, effectSignerSha256) {
  const request = JSON.parse(readFileSync(POLICY_TEMPLATE, "utf8"));
  Object.assign(request, {
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    operation_id: "container-smoke-install-policy-v1",
    operator_principal_id: OPERATOR_ID,
  });
  for (const [draft, artifactId] of [
    [request.compiler_policy, "container-smoke-compiler-policy"],
    [request.evidence_policy, "container-smoke-evidence-policy"],
  ]) {
    Object.assign(draft, {
      artifact_id: artifactId,
      artifact_revision: 1,
      created_at: "2020-01-01T00:00:00.000Z",
      valid_from: "2020-01-02T00:00:00.000Z",
      expires_at: null,
    });
    draft.payload.tenant_id = TENANT;
    draft.payload.authority_subject_sha256 = subject;
  }
  request.compiler_policy.payload.trusted_observer_principals = {
    trusted_host_collector: [hostPrincipalSha256],
    external_verifier: [],
  };
  request.evidence_policy.payload.trusted_effect_verifier_principals = [
    effectSignerSha256,
  ];
  return request;
}

function installWithCompose(service, command) {
  const result = compose([
    "--profile",
    "provision",
    "run",
    "--rm",
    "-T",
    "--no-deps",
    service,
  ], {
    input: `${canonicalContinuationJson(command)}\n`,
    label: `compose_${service}`,
  });
  const event = jsonLine(result.stdout, service);
  assert.equal(event.event, "provisioning_complete");
  const operation = fieldRecord(event, "operation");
  assert.equal(operation.status, "created");
  const publicConfig = fieldRecord(event, "public_config");
  assert.equal(
    publicConfig.assignmentSeedFdConfigured,
    service === "provision-cohort",
  );
  return { operation, publicConfig };
}

async function waitForReady(port) {
  const deadline = Date.now() + 45_000;
  let last = "not_attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_500),
      });
      last = `${response.status}:${await response.text()}`;
      if (response.status === 200) {
        const payload = JSON.parse(last.slice(last.indexOf(":") + 1));
        assert.deepEqual(payload, {
          schema_version: "continuation_runtime_readiness_v1",
          status: "ready",
          reason_codes: [],
        });
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  fail("readiness_timeout", last);
}

function daemonContainerId() {
  const result = compose(["ps", "--quiet", "daemon"], {
    label: "compose_daemon_id",
  });
  const id = result.stdout.trim();
  assert.match(id, /^[0-9a-f]{12,64}$/u);
  return id;
}

function serviceContainerId(service) {
  const result = compose(["ps", "--all", "--quiet", service], {
    label: `compose_${service}_id`,
  });
  const id = result.stdout.trim();
  assert.match(id, /^[0-9a-f]{12,64}$/u);
  return id;
}

function containerJsonLogs(containerId, label, forbidden = []) {
  const raw = run("docker", ["logs", containerId], {
    env: cleanEnvironment(),
    label,
  });
  for (const value of forbidden) {
    assert.equal(raw.stdout.includes(value), false);
    assert.equal(raw.stderr.includes(value), false);
  }
  return raw.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      assert.ok(line.startsWith("{") && line.endsWith("}"), label);
      const event = JSON.parse(line);
      assert.equal(canonicalContinuationJson(event), line, label);
      return event;
    });
}

async function waitForEmbeddingWorker(containerId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const events = containerJsonLogs(
      containerId,
      "embedding_worker_startup_logs",
      [EMBEDDING_TOKEN, "/run/aionis/embedding-api-key"],
    );
    if (events.some((event) => event.event === "polling")) return;
    const state = run("docker", [
      "inspect", "--format", "{{.State.Status}}:{{.State.ExitCode}}", containerId,
    ], { env: cleanEnvironment(), label: "embedding_worker_startup_state" });
    if (state.stdout.trim() !== "running:0") {
      fail("embedding_worker_startup_failed", state.stdout);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  fail("embedding_worker_startup_timeout");
}

function assertEmbeddingWorkerPosture(containerId) {
  run("docker", [
    "exec", containerId, "/bin/sh", "-ceu",
    [
      "test \"$(id -u)\" = 1000",
      "test \"$(id -g)\" = 1000",
      "test \"$(stat -c %u:%g:%a:%h /run/aionis/embedding-api-key)\" = 1000:1000:400:1",
      "test ! -w /run/aionis/embedding-api-key",
    ].join("; "),
  ], { env: cleanEnvironment(), label: "embedding_worker_file_posture" });
  const inspected = run("docker", [
    "inspect", "--format", "{{json .Config.Env}}", containerId,
  ], { env: cleanEnvironment(), label: "embedding_worker_environment" });
  const environment = JSON.parse(inspected.stdout);
  assert.ok(environment.includes(
    "AIONIS_EMBEDDING_API_KEY_FILE=/run/aionis/embedding-api-key",
  ));
  assert.equal(environment.some((field) => (
    field.startsWith("AIONIS_EMBEDDING_API_KEY=")
  )), false);
  assert.equal(inspected.stdout.includes(EMBEDDING_TOKEN), false);
  const mounts = JSON.parse(run("docker", [
    "inspect", "--format", "{{json .Mounts}}", containerId,
  ], { env: cleanEnvironment(), label: "embedding_worker_mounts" }).stdout);
  const credentialMount = mounts.find((mount) => (
    mount.Destination === "/run/aionis/embedding-api-key"
  ));
  assert.deepEqual(
    { type: credentialMount?.Type, readWrite: credentialMount?.RW },
    { type: "bind", readWrite: false },
  );
}

function assertEmbeddingWorkerShutdown(containerId) {
  const events = containerJsonLogs(
    containerId,
    "embedding_worker_shutdown_logs",
    [EMBEDDING_TOKEN, "/run/aionis/embedding-api-key"],
  );
  const polling = events.find((event) => event.event === "polling");
  assert.equal(polling?.public_config?.embedding?.apiKeyFileConfigured, true);
  assert.deepEqual(events.findLast((event) => (
    event.event === "shutdown_complete"
  ))?.shutdown, {
    schema_version: "continuation_runtime_shutdown_result_v1",
    status: "graceful",
    signal: "SIGTERM",
    exit_code: 0,
    terminal_phase: "complete",
    failure_code: null,
    completed_phases: ["stop_new_work", "drain_in_flight", "close_database"],
  });
  const state = run("docker", [
    "inspect", "--format", "{{.State.ExitCode}}:{{.State.Status}}", containerId,
  ], { env: cleanEnvironment(), label: "embedding_worker_exit" });
  assert.equal(state.stdout.trim(), "0:exited");
}

function assertContainerPosture(containerId) {
  const result = run("docker", [
    "exec",
    containerId,
    "/bin/sh",
    "-ceu",
    [
      "test \"$(id -u)\" = 1000",
      "test \"$(id -g)\" = 1000",
      "test \"$(stat -c %a /data)\" = 700",
      "test \"$(stat -c %a /data/runtime.sqlite)\" = 600",
      "test ! -e /app/tools",
      "test ! -e /run/aionis/root-private.pem",
    ].join("; "),
  ], {
    env: cleanEnvironment(),
    label: "container_posture",
  });
  assert.equal(result.stdout, "");
  const inspected = run("docker", [
    "inspect",
    "--format",
    "{{json .Config.Env}}",
    containerId,
  ], { env: cleanEnvironment(), label: "container_environment" });
  const environment = JSON.parse(inspected.stdout);
  assert.ok(environment.includes("AIONIS_HOST_API_KEY_FILE=/run/aionis/host-api-key"));
  assert.ok(environment.includes(
    "AIONIS_OPERATOR_API_KEY_FILE=/run/aionis/operator-api-key",
  ));
  assert.equal(environment.some((field) => field.startsWith("AIONIS_HOST_API_KEY=")), false);
  assert.equal(environment.some((field) => field.startsWith("AIONIS_OPERATOR_API_KEY=")), false);
  assert.equal(inspected.stdout.includes(HOST_TOKEN), false);
  assert.equal(inspected.stdout.includes(OPERATOR_TOKEN), false);
}

function daemonLogs(containerId) {
  return containerJsonLogs(containerId, "daemon_logs", [
    HOST_TOKEN, OPERATOR_TOKEN, "host-api-key", "operator-api-key",
  ]);
}

function assertShutdown(containerId, minimumCount) {
  const events = daemonLogs(containerId);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(HOST_TOKEN), false);
  assert.equal(serializedEvents.includes(OPERATOR_TOKEN), false);
  assert.equal(serializedEvents.includes("host-api-key"), false);
  assert.equal(serializedEvents.includes("operator-api-key"), false);
  assert.ok(events.filter((event) => event.event === "listening").length
    >= minimumCount);
  const shutdowns = events.filter((event) => event.event === "shutdown_complete");
  assert.ok(shutdowns.length >= minimumCount);
  assert.deepEqual(shutdowns.at(-1).shutdown, {
    schema_version: "continuation_runtime_shutdown_result_v1",
    status: "graceful",
    signal: "SIGTERM",
    exit_code: 0,
    terminal_phase: "complete",
    failure_code: null,
    completed_phases: ["stop_new_work", "drain_in_flight", "close_database"],
  });
  const inspection = run("docker", [
    "inspect",
    "--format",
    "{{.State.ExitCode}}:{{.State.Status}}",
    containerId,
  ], { env: cleanEnvironment(), label: "daemon_exit" });
  assert.equal(inspection.stdout.trim(), "0:exited");
}

function observationBody() {
  const issuedAt = iso(-60_000);
  const observedAt = iso(-30_000);
  const expiresAt = iso(45 * 60_000);
  return {
    schema_version: "record_observations_body_v1",
    host_task: {
      host_task_id: "task-container-smoke",
      episode_id: "episode-container-smoke",
      run_id: "run-container-smoke",
      consumer_agent_id: "agent-container-smoke",
      consumer_team_id: null,
      task_family: TASK_FAMILY,
      task_signature: "task-signature-container-smoke",
      workflow_signature: null,
      workspace_signature: "workspace-signature-container-smoke",
      source_task_sha256: sha("source-task"),
      source_event_sha256: sha("source-event"),
      issued_at: issuedAt,
      expires_at: iso(60 * 60_000),
    },
    memory_inputs: [{
      memory_input_id: "procedure-container-smoke",
      kind: "procedure",
      applicability: {
        task_signature: "task-signature-container-smoke",
        workflow_signature: null,
        workspace_signature: "workspace-signature-container-smoke",
      },
      projection: {
        summary: "Inspect the exact Runtime authority state before mutation.",
        next_action: "Verify the current authority head and candidate digest.",
        target_refs: [{ kind: "memory", ref: "container-smoke-authority-state" }],
        workflow_steps: ["Read the authority state.", "Verify the authority digest."],
        acceptance_statements: ["The observed authority digest matches."],
      },
      coverage_claims: [{
        obligation_kind: "required_state",
        target_refs: [{ kind: "memory", ref: "container-smoke-authority-state" }],
        evidence_requirement: "runtime_state",
        required_probe_ids: [],
      }],
      precondition_specs: [],
      evidence_observation_ids: ["observation-container-smoke"],
      expires_at: expiresAt,
    }],
    collector_observations: [{
      schema_version: "collector_observation_v1",
      observation_id: "observation-container-smoke",
      probe_id: "probe-container-smoke",
      probe_spec_sha256: sha("probe-spec"),
      observed_at: observedAt,
      expires_at: expiresAt,
      value: {
        kind: "capability",
        capability_id: "container-runtime-authority",
        version: "1.0.0",
        presence: "present",
      },
      evidence_sha256: sha("collector-evidence"),
    }],
    signed_observations: [],
  };
}

function genesisObservationBody() {
  const body = observationBody();
  return {
    ...body,
    host_task: {
      ...body.host_task,
      host_task_id: "task-container-smoke-genesis",
      episode_id: "episode-container-smoke-genesis",
      run_id: "run-container-smoke-genesis",
      source_task_sha256: sha("source-task-genesis"),
      source_event_sha256: sha("source-event-genesis"),
    },
    memory_inputs: [],
    collector_observations: [],
  };
}

function genesisControl(observationResponse) {
  const result = fieldRecord(observationResponse, "result");
  assert.notEqual(result.memory_revision_ref, null);
  const set = fieldRecord(result, "authority_branch_set");
  assert.equal(set.count, 1);
  assert.ok(Array.isArray(set.refs));
  const control = set.refs[0];
  assert.equal(control.branch_kind, "authoritative");
  assert.equal(control.branch_state, "authoritative");
  assert.equal(control.binding_count, 0);
  assert.ok(control.authority_head_ref !== null);
  return control;
}

function branchPair(observationResponse) {
  const result = fieldRecord(observationResponse, "result");
  assert.notEqual(result.memory_revision_ref, null);
  const set = fieldRecord(result, "authority_branch_set");
  assert.equal(set.count, 2);
  assert.ok(Array.isArray(set.refs));
  const control = set.refs.find((ref) => ref.branch_kind === "authoritative");
  const candidate = set.refs.find((ref) => ref.branch_kind === "candidate");
  assert.ok(control !== undefined && candidate !== undefined);
  assert.equal(control.branch_state, "authoritative");
  assert.equal(control.binding_count, 0);
  assert.equal(candidate.branch_state, "draft");
  assert.equal(candidate.binding_count, 1);
  assert.equal(candidate.authority_head_ref, null);
  assert.ok(control.authority_head_ref !== null);
  return { control, candidate, head: control.authority_head_ref };
}

async function advanceCandidate(operatorClient, pair) {
  let candidate = pair.candidate;
  for (const [index, targetState] of [
    "shadow",
    "eligible",
    "active_candidate",
  ].entries()) {
    const response = await operatorClient.decideAuthority({
      operationId: `container-smoke-candidate-advance-${index + 1}`,
      scope: SCOPE,
      taskFamily: TASK_FAMILY,
      body: {
        schema_version: "authority_decision_body_v1",
        expected_head: {
          revision: pair.head.head_revision,
          head_sha256: pair.head.head_sha256,
        },
        decision: {
          kind: "candidate_advance",
          candidate: {
            branch_id: candidate.branch_id,
            branch_revision: candidate.branch_revision,
            manifest_sha256: candidate.manifest_sha256,
          },
          target_state: targetState,
          reason_codes: ["container_smoke_verified"],
          evidence_sha256s: [sha(`candidate-${targetState}`)],
        },
      },
    });
    const result = fieldRecord(response, "result");
    assert.equal(result.decision_kind, "branch_update");
    const revisionSet = fieldRecord(result, "branch_revision_set");
    assert.ok(Array.isArray(revisionSet.refs));
    const advanced = revisionSet.refs.find((ref) =>
      ref.branch_id === candidate.branch_id
        && ref.branch_kind === "candidate"
        && ref.branch_state === targetState);
    assert.ok(advanced !== undefined, `missing ${targetState} candidate ref`);
    assert.equal(advanced.branch_revision, candidate.branch_revision + 1);
    candidate = advanced;
  }
  return candidate;
}

function artifactRef(artifact) {
  return {
    artifact_sha256: artifact.artifact_sha256,
    payload_sha256: artifact.payload_sha256,
  };
}

function cohortRequest(args) {
  const request = JSON.parse(readFileSync(COHORT_TEMPLATE, "utf8"));
  Object.assign(request, {
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    operation_id: "container-smoke-install-cohort-v1",
    operator_principal_id: OPERATOR_ID,
  });
  const createdAt = iso();
  const openedAt = iso(10 * 60_000);
  const closedAt = iso(20 * 60_000);
  const outcomeDeadline = iso(30 * 60_000);
  const settlementCutoffAt = iso(31 * 60_000);
  Object.assign(request.experiment_cohort, {
    artifact_id: "container-smoke-experiment-cohort",
    artifact_revision: 1,
    created_at: createdAt,
    valid_from: createdAt,
    expires_at: iso(40 * 60_000),
  });
  Object.assign(request.experiment_cohort.payload, {
    tenant_id: TENANT,
    scope: SCOPE,
    task_family: TASK_FAMILY,
    cohort_id: "cohort-container-smoke",
    authority_subject_sha256: args.subject,
    control_learning_ref: {
      branch_id: args.control.branch_id,
      branch_revision: args.control.branch_revision,
      branch_kind: "authoritative",
      state: "authoritative",
      manifest_sha256: args.control.manifest_sha256,
    },
    candidate_learning_ref: {
      branch_id: args.candidate.branch_id,
      branch_revision: args.candidate.branch_revision,
      branch_kind: "candidate",
      state: "active_candidate",
      manifest_sha256: args.candidate.manifest_sha256,
    },
    compiler_policy_ref: args.compilerPolicyRef,
    evidence_policy_ref: args.evidencePolicyRef,
    assignment_window_opened_at: openedAt,
    assignment_window_closed_at: closedAt,
    outcome_deadline: outcomeDeadline,
    settlement_grace_ms: 60_000,
    settlement_cutoff_at: settlementCutoffAt,
  });
  request.experiment_cohort.payload.assignment_protocol
    .assignment_seed_commitment_sha256 = args.seedCommitment;
  return request;
}

function prepareContainerSecrets(authorityDirectory, seedPath, deploymentDirectory) {
  const runtimeIdentity = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/usr/bin/id",
    IMAGE,
    "-u",
  ], {
    env: cleanEnvironment(),
    label: "image_runtime_uid",
  });
  assert.equal(runtimeIdentity.stdout.trim(), "1000");
  mkdirSync(deploymentDirectory, { mode: 0o700 });
  chmodSync(deploymentDirectory, 0o700);
  const publicCopy = join(deploymentDirectory, "root-public.pem");
  const seedCopy = join(deploymentDirectory, "cohort-seed.bin");
  const hostTokenCopy = join(deploymentDirectory, "host-api-key");
  const operatorTokenCopy = join(deploymentDirectory, "operator-api-key");
  const embeddingTokenCopy = join(deploymentDirectory, "embedding-api-key");
  copyFileSync(join(authorityDirectory, "root-public.pem"), publicCopy);
  copyFileSync(seedPath, seedCopy);
  writeFileSync(hostTokenCopy, HOST_TOKEN, { mode: 0o600 });
  writeFileSync(operatorTokenCopy, OPERATOR_TOKEN, { mode: 0o600 });
  writeFileSync(embeddingTokenCopy, EMBEDDING_TOKEN, { mode: 0o600 });
  chmodSync(publicCopy, 0o600);
  chmodSync(seedCopy, 0o600);
  assert.equal(existsSync(join(deploymentDirectory, "root-private.pem")), false);
  run("docker", [
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/sh",
    "--volume",
    `${deploymentDirectory}:/secrets`,
    IMAGE,
    "-ceu",
    [
      "chown 0:0 /secrets/root-public.pem",
      "chmod 0444 /secrets/root-public.pem",
      "chown 1000:1000 /secrets/cohort-seed.bin",
      "chmod 0400 /secrets/cohort-seed.bin",
      "chown 1000:1000 /secrets/host-api-key /secrets/operator-api-key /secrets/embedding-api-key",
      "chmod 0400 /secrets/host-api-key /secrets/operator-api-key /secrets/embedding-api-key",
      "test \"$(stat -c %u:%g:%a /secrets/root-public.pem)\" = 0:0:444",
      "test \"$(stat -c %u:%g:%a /secrets/cohort-seed.bin)\" = 1000:1000:400",
      "test \"$(stat -c %u:%g:%a /secrets/host-api-key)\" = 1000:1000:400",
      "test \"$(stat -c %u:%g:%a /secrets/operator-api-key)\" = 1000:1000:400",
      "test \"$(stat -c %u:%g:%a:%h /secrets/embedding-api-key)\" = 1000:1000:400:1",
    ].join("; "),
  ], {
    env: cleanEnvironment(),
    label: "container_secret_posture",
  });
  return {
    embeddingTokenCopy, hostTokenCopy, operatorTokenCopy, publicCopy, seedCopy,
  };
}

async function main() {
  smokeRoot = mkdtempSync(join(tmpdir(), "aionis-v1-container-smoke-"));
  chmodSync(smokeRoot, 0o700);
  const authorityDirectory = join(smokeRoot, "offline-authority");
  const deploymentDirectory = join(smokeRoot, "runtime-secrets");
  const seedPath = join(authorityDirectory, "cohort-assignment-seed.bin");
  const port = await reservePort();
  composeProject = `aionis-smoke-${process.pid}-${Date.now().toString(36)}`
    .toLowerCase();
  let daemonId = null;
  let chainCompleted = false;
  try {
    assert.equal(lstatSync(smokeRoot).mode & 0o777, 0o700);
    buildAuthorityClosure();
    const { keys, seed } = generateAuthorityMaterial(authorityDirectory, seedPath);
    const subject = continuationAuthoritySubjectSha256V1({
      tenant_id: TENANT,
      scope: SCOPE,
      task_family: TASK_FAMILY,
    });
    const hostPrincipalSha256 = continuationRuntimeV1PrincipalSha256({
      tenant_id: TENANT,
      principal_kind: "trusted_host",
      principal_id: HOST_ID,
    });
    const signedPolicy = signRequest(
      policyRequest(subject, hostPrincipalSha256, keys.effect_signer_sha256),
      join(authorityDirectory, "root-private.pem"),
    );
    assert.equal(signedPolicy.kind, "policy_bundle_install");
    const deployed = prepareContainerSecrets(
      authorityDirectory,
      seedPath,
      deploymentDirectory,
    );
    composeEnvironment = cleanEnvironment({
      AIONIS_CONTAINER_IMAGE: IMAGE,
      AIONIS_EMBEDDING_BASE_URL: "https://embedding.invalid/v1",
      AIONIS_EMBEDDING_DIMENSIONS: "16",
      AIONIS_EMBEDDING_MODEL: "container-smoke-embedding-v1",
      AIONIS_HOST_PRINCIPAL_ID: HOST_ID,
      AIONIS_LOG_LEVEL: "silent",
      AIONIS_OPERATOR_PRINCIPAL_ID: OPERATOR_ID,
      AIONIS_SHUTDOWN_TIMEOUT_MS: "10000",
      AIONIS_TENANT_ID: TENANT,
      AIONIS_TRUST_ROOT_SHA256: keys.trust_root_sha256,
      COHORT_SEED_FILE: deployed.seedCopy,
      COMPOSE_IGNORE_ORPHANS: "true",
      HTTP_BIND: "127.0.0.1",
      HTTP_PORT: String(port),
      EMBEDDING_API_KEY_FILE: deployed.embeddingTokenCopy,
      HOST_API_KEY_FILE: deployed.hostTokenCopy,
      OPERATOR_API_KEY_FILE: deployed.operatorTokenCopy,
      TRUST_ROOT_PUBLIC_KEY_FILE: deployed.publicCopy,
    });

    const policyInstall = installWithCompose("provision", signedPolicy);
    const policyReceipt = fieldRecord(policyInstall.operation, "receipt");
    const policyResult = fieldRecord(policyReceipt, "result");
    assert.equal(policyResult.decision_kind, "policy_bundle_install");
    assert.deepEqual(
      policyResult.compiler_policy_ref,
      artifactRef(signedPolicy.policy_bundle.compiler_policy),
    );
    assert.deepEqual(
      policyResult.evidence_policy_ref,
      artifactRef(signedPolicy.policy_bundle.evidence_policy),
    );
    compose(["up", "--detach", "--no-build", "--no-deps", "worker-embedding"], {
      label: "compose_embedding_worker_up",
    });
    const embeddingWorkerId = serviceContainerId("worker-embedding");
    await waitForEmbeddingWorker(embeddingWorkerId);
    assertEmbeddingWorkerPosture(embeddingWorkerId);
    compose(["stop", "worker-embedding"], {
      label: "compose_embedding_worker_stop",
    });
    assertEmbeddingWorkerShutdown(embeddingWorkerId);
    compose(["up", "--detach", "--no-build", "--no-deps", "daemon"], {
      label: "compose_daemon_up",
    });
    daemonId = daemonContainerId();
    await waitForReady(port);
    assertContainerPosture(daemonId);

    const clientConfig = {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000,
      requestBodyLimitBytes: 1_048_576,
      responseBodyLimitBytes: 5_242_880,
    };
    const hostClient = createAionisRuntimeV1Client({
      ...clientConfig,
      apiKey: HOST_TOKEN,
    });
    const operatorClient = createAionisRuntimeV1Client({
      ...clientConfig,
      apiKey: OPERATOR_TOKEN,
    });
    const genesisObservation = await hostClient.recordObservations({
      operationId: "container-smoke-establish-genesis",
      scope: SCOPE,
      body: genesisObservationBody(),
    });
    const establishedControl = genesisControl(genesisObservation);
    const candidateObservation = await hostClient.recordObservations({
      operationId: "container-smoke-record-observations",
      scope: SCOPE,
      body: observationBody(),
    });
    const pair = branchPair(candidateObservation);
    assert.deepEqual(pair.control, establishedControl);
    const activeCandidate = await advanceCandidate(operatorClient, pair);

    compose(["stop", "daemon"], { label: "compose_daemon_stop" });
    assertShutdown(daemonId, 1);

    const signedCohort = signRequest(cohortRequest({
      subject,
      control: pair.control,
      candidate: activeCandidate,
      compilerPolicyRef: policyResult.compiler_policy_ref,
      evidencePolicyRef: policyResult.evidence_policy_ref,
      seedCommitment: seed.assignment_seed_commitment_sha256,
    }), join(authorityDirectory, "root-private.pem"));
    assert.equal(signedCohort.kind, "experiment_cohort_install");
    const cohortInstall = installWithCompose("provision-cohort", signedCohort);
    const cohortReceipt = fieldRecord(cohortInstall.operation, "receipt");
    const cohortResult = fieldRecord(cohortReceipt, "result");
    assert.equal(cohortResult.decision_kind, "experiment_cohort_install");
    assert.equal(
      cohortResult.experiment_cohort_ref.artifact_sha256,
      signedCohort.experiment_cohort_artifact.artifact_sha256,
    );
    assert.equal(cohortResult.effect_job_ref.job_kind, "effect");

    compose(["start", "daemon"], { label: "compose_daemon_restart" });
    await waitForReady(port);
    assertContainerPosture(daemonId);
    compose(["stop", "daemon"], { label: "compose_daemon_reopen_stop" });
    assertShutdown(daemonId, 2);
    chainCompleted = true;

    process.stdout.write(`${canonicalContinuationJson({
      schema_version: "continuation_runtime_v1_container_smoke_result_v1",
      event: "container_smoke_complete",
      image: IMAGE,
      policy_provisioned: true,
      daemon_uid: 1000,
      graceful_shutdown_verified: true,
      embedding_worker_file_authority_verified: true,
      same_volume_reopen_ready: true,
      real_candidate_state: activeCandidate.branch_state,
      cohort_seed_fd: 3,
      cohort_seed_uid: 1000,
      cohort_provisioned: true,
    })}\n`);
  } finally {
    if (composeEnvironment !== null && composeProject !== "") {
      try {
        compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], {
          label: "compose_cleanup",
          timeout: 60_000,
        });
      } catch (error) {
        if (chainCompleted) throw error;
      }
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${redact(
    error instanceof Error ? error.message : "container_smoke_failed",
  )}\n`);
}
