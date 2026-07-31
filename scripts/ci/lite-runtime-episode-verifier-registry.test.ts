import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAuthenticEpisodeVerifierExecution,
  type EpisodeVerifierRunnerConfig,
} from "../../src/execution/episode-verifier-runner.js";
import {
  createRuntimeEpisodeVerifierInvocationAuthorityChannel,
  type RuntimeEpisodeVerifierInvocationAuthorityIssuer,
  type RuntimeEpisodeVerifierInvocationAuthorityV1,
  type RuntimeEpisodeVerifierInvocationAuthorityVerifier,
} from "../../src/execution/runtime-episode-verifier-launch-authority.js";
import {
  assertAuthenticRuntimeEpisodeVerifierLaunchEvidence,
  assertAuthenticRuntimeEpisodeVerifierRegistryLaunch,
  createRuntimeEpisodeVerifierRegistry as createVerifierRegistry,
  parseRuntimeEpisodeVerifierDefinitionsJson,
  RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_ENTRIES,
  RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_JSON_BYTES,
  runtimeEpisodeVerifierDefinitionDigest,
  runtimeEpisodeVerifierExecutionEvidence,
  type RuntimeEpisodeVerifierDefinitionInput,
  type RuntimeEpisodeVerifierRegistry,
} from "../../src/execution/runtime-episode-verifier-registry.js";
import {
  verifierExecutionPackManifestDigest,
} from "../../src/execution/verifier-execution-pack.js";
import {
  materializeVerifierSubjectFromSnapshot,
  type VerifierSubjectMaterializationV1,
} from "../../src/execution/verifier-subject-materialization.js";
import {
  captureExactWorkspaceState,
} from "../../src/execution/workspace-state-capture.js";
import {
  ExecutionEpisodeSubjectIdentityV1Schema,
  VerifierInvocationV1Schema,
  executionEpisodeSubjectIdentityDigest,
  executionEpisodeSubjectStateSpecDigest,
  verifierInvocationDigest,
} from "../../src/memory/execution-episode.js";
import { sha256Hex } from "../../src/util/crypto.js";

function workspace(t: test.TestContext, name: string): string {
  const path = mkdtempSync(join(tmpdir(), `aionis-verifier-registry-${name}-`));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function writeVerifier(
  directory: string,
  name: string,
  source: string,
): string {
  const path = join(directory, name);
  writeFileSync(path, source, { encoding: "utf8", mode: 0o600 });
  return path;
}

function runnerConfig(
  cwd: string,
  scriptPath: string,
  argv: readonly string[] = [],
  environment: Readonly<Record<string, string>> = {},
): EpisodeVerifierRunnerConfig {
  return {
    executable: process.execPath,
    argv: [scriptPath, ...argv],
    cwd,
    environment,
    timeout_ms: 2_000,
    terminate_grace_ms: 100,
    max_stdout_bytes: 1024,
    max_stderr_bytes: 1024,
  };
}

function definition(args: {
  verifierId: string;
  cwd: string;
  scriptPath: string;
  argv?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  materialPaths?: readonly string[];
  immutableInputPaths?: readonly string[];
  infrastructureExitCodes?: readonly number[];
  kind?: RuntimeEpisodeVerifierDefinitionInput["verifier_kind"];
  role?: RuntimeEpisodeVerifierDefinitionInput["reward_role"];
}): RuntimeEpisodeVerifierDefinitionInput {
  return {
    verifier_id: args.verifierId,
    verifier_kind: args.kind ?? "hidden_test",
    verifier_version: "fixture-v1",
    verifier_issuer_id: "aionis-runtime-test",
    reward_role: args.role ?? "primary",
    verifier_material_paths: args.materialPaths ?? [args.scriptPath],
    readonly_inputs: (args.immutableInputPaths ?? []).map(
      (sourcePath, index) => ({
        contract_version:
          "runtime_episode_verifier_readonly_input_v1" as const,
        input_id: `fixture-input-${index}`,
        input_type: "oracle" as const,
        source_path: sourcePath,
      }),
    ),
    runner_config: {
      ...runnerConfig(
        args.cwd,
        args.scriptPath,
        args.argv,
        args.environment,
      ),
      ...(args.infrastructureExitCodes === undefined
        ? {}
        : { infrastructure_exit_codes: args.infrastructureExitCodes }),
    },
  };
}

let launchSequence = 0;
const TEST_AUTHORITY_ISSUERS = new WeakMap<
  RuntimeEpisodeVerifierRegistry,
  RuntimeEpisodeVerifierInvocationAuthorityIssuer
>();
const TEST_AUTHORITY_VERIFIERS = new WeakMap<
  RuntimeEpisodeVerifierRegistry,
  RuntimeEpisodeVerifierInvocationAuthorityVerifier
>();

function createRuntimeEpisodeVerifierRegistry(
  definitions: readonly RuntimeEpisodeVerifierDefinitionInput[],
): RuntimeEpisodeVerifierRegistry {
  const channel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const registry = createVerifierRegistry(definitions, channel.verifier);
  TEST_AUTHORITY_ISSUERS.set(registry, channel.issuer);
  TEST_AUTHORITY_VERIFIERS.set(registry, channel.verifier);
  return registry;
}

function subjectWorkspace(
  directory: string,
  name = `subject-${launchSequence += 1}`,
): string {
  const subjectRoot = join(directory, name);
  mkdirSync(subjectRoot);
  writeFileSync(
    join(subjectRoot, "subject.txt"),
    "runtime-captured-subject",
    "utf8",
  );
  return subjectRoot;
}

function prepareLaunch(
  t: test.TestContext,
  registry: RuntimeEpisodeVerifierRegistry,
  verifierId: string,
  sourceSubjectRoot: string,
  identity?: Readonly<{
    episodeId?: string;
    invocationId?: string;
    requiredVerifierId?: string;
    verifierDefinitionSha256?: string;
    verifierProgramDigest?: string;
    verifierConfigDigest?: string;
  }>,
): Readonly<{
  authority: RuntimeEpisodeVerifierInvocationAuthorityV1;
  materialization: VerifierSubjectMaterializationV1;
}> {
  const entry = registry.resolve(verifierId);
  assert.ok(entry, `missing verifier fixture ${verifierId}`);
  const capture = captureExactWorkspaceState({
    workspace_root: sourceSubjectRoot,
  });
  const materialization = materializeVerifierSubjectFromSnapshot({
    snapshotArtifactBytes: capture.artifact.bytes,
    sourceContentDigest: capture.content_digest,
    sourceEnvironmentDigest: capture.environment_digest,
  });
  t.after(() => materialization.cleanup());
  const subjectIdentityMaterial = {
    contract_version: "execution_episode_subject_identity_v1" as const,
    state_kind: "workspace" as const,
    canonical_root_sha256: sha256Hex(realpathSync(sourceSubjectRoot)),
    capture_algorithm_id: capture.algorithm_id,
    capture_algorithm_version: capture.algorithm_version,
    subject_state_spec: capture.manifest.capture_policy.subject_state_spec,
    subject_state_spec_sha256: executionEpisodeSubjectStateSpecDigest(
      capture.manifest.capture_policy.subject_state_spec,
    ),
  };
  const subjectIdentity = ExecutionEpisodeSubjectIdentityV1Schema.parse({
    ...subjectIdentityMaterial,
    identity_sha256:
      executionEpisodeSubjectIdentityDigest(subjectIdentityMaterial),
  });
  const sequence = launchSequence += 1;
  const invocation = VerifierInvocationV1Schema.parse({
    contract_version: "verifier_invocation_v1",
    verifier_invocation_id:
      identity?.invocationId ?? `verifier-invocation-${sequence}`,
    episode_id: identity?.episodeId ?? `episode-${sequence}`,
    verifier_id:
      identity?.requiredVerifierId ?? entry.identity.verifier_id,
    verifier_definition_sha256:
      identity?.verifierDefinitionSha256
      ?? entry.identity.definition_sha256,
    verifier_kind: entry.identity.verifier_kind,
    verifier_version: entry.identity.verifier_version,
    verifier_issuer_id: entry.identity.verifier_issuer_id,
    verifier_runner_instance_id: `runner-${sequence}`,
    launch_authority: {
      kind: "runtime_launched",
      runtime_reservation_digest:
        sha256Hex(`reservation-${sequence}`),
    },
    verifier_program_digest:
      identity?.verifierProgramDigest
      ?? entry.identity.verifier_program_digest,
    verifier_config_digest:
      identity?.verifierConfigDigest
      ?? entry.identity.verifier_config_digest,
    verifier_environment_digest: capture.environment_digest,
    target_state_snapshot_id: `snapshot-${sequence}`,
    target_state_snapshot_algorithm_version: capture.algorithm_version,
    verifier_input_ref: {
      contract_version: "evidence_artifact_ref_v1",
      artifact_id: `verifier-input-${sequence}`,
      kind: "verifier_input",
      sha256: sha256Hex(`verifier-input-${sequence}`),
      storage_ref:
        `sqlite-cas:sha256:${sha256Hex(`verifier-input-${sequence}`)}`,
      byte_length: 0,
      media_type: "application/json",
      encoding: "utf-8",
      redaction_policy: "episode-default-redaction-v1",
      retention_policy: "episode-replay-v1",
    },
    invoked_at: "2026-07-27T08:00:00.000Z",
  });
  const issuer = TEST_AUTHORITY_ISSUERS.get(registry);
  assert.ok(issuer, "test registry must own an authority issuer");
  const persistedReservation = issuer.issuePersistedReservation({
    persisted_invocation: invocation,
    persisted_invocation_digest: verifierInvocationDigest(invocation),
  });
  return {
    materialization,
    authority: issuer.authorizeMaterializedLaunch({
      persisted_reservation: persistedReservation,
      subject_identity: subjectIdentity,
      source_subject_root: sourceSubjectRoot,
      source_content_digest: capture.content_digest,
      source_environment_digest: capture.environment_digest,
      materialization,
    }),
  };
}

async function launchRegistered(
  t: test.TestContext,
  registry: RuntimeEpisodeVerifierRegistry,
  verifierId: string,
  sourceSubjectRoot: string,
) {
  const prepared = prepareLaunch(
    t,
    registry,
    verifierId,
    sourceSubjectRoot,
  );
  return await registry.launch(
    prepared.authority,
    prepared.materialization,
    durableLifecycle(
      `${prepared.authority.verifier_invocation_id}:${verifierId}`,
    ),
  );
}

let durableLifecycleSequence = 0;

function durableLifecycle(label: string) {
  durableLifecycleSequence += 1;
  const launchAttemptId = `rvla_${sha256Hex(JSON.stringify({
    label,
    sequence: durableLifecycleSequence,
  }))}`;
  return {
    launch_attempt_id: launchAttemptId,
    async persist_prepared_launch(prepared: {
      launch_attempt_id: string;
    }): Promise<void> {
      assert.equal(prepared.launch_attempt_id, launchAttemptId);
    },
    async persist_spawn_observation(observation: {
      launch_attempt_id: string;
      process_id: number;
    }): Promise<void> {
      assert.equal(observation.launch_attempt_id, launchAttemptId);
      assert.ok(observation.process_id > 0);
    },
  };
}

test("registered verifier IDs launch exact real pass, semantic-fail, and infrastructure-exit processes", async (t) => {
  const directory = workspace(t, "launch");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const passPath = writeVerifier(
    directory,
    "pass.mjs",
    `
      import { writeFileSync } from "node:fs";
      if (process.argv[2] !== "literal;$(not-a-shell)") process.exit(31);
      if (process.env.AIONIS_REGISTRY_VALUE !== "registered") process.exit(32);
      if (process.cwd() !== process.env.AIONIS_VERIFIER_SUBJECT_ROOT) process.exit(33);
      if (process.env.PWD !== process.env.AIONIS_VERIFIER_SUBJECT_ROOT) process.exit(34);
      if (process.env.HOME !== process.env.AIONIS_VERIFIER_SCRATCH_ROOT) process.exit(35);
      if (!process.env.AIONIS_VERIFIER_INVOCATION_DIGEST) process.exit(36);
      process.stdout.write("registered-pass");
    `,
  );
  const failPath = writeVerifier(
    directory,
    "fail.mjs",
    `
      process.stderr.write("registered-failure");
      process.exit(1);
    `,
  );
  const infrastructurePath = writeVerifier(
    directory,
    "infrastructure.mjs",
    `
      process.stderr.write("registered-infrastructure-failure");
      process.exit(75);
    `,
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "verifier-pass",
      cwd: directory,
      scriptPath: passPath,
      argv: ["literal;$(not-a-shell)"],
      environment: { AIONIS_REGISTRY_VALUE: "registered" },
    }),
    definition({
      verifierId: "verifier-fail",
      cwd: directory,
      scriptPath: failPath,
      infrastructureExitCodes: [75],
      kind: "process_verifier",
    }),
    definition({
      verifierId: "verifier-infrastructure",
      cwd: directory,
      scriptPath: infrastructurePath,
      infrastructureExitCodes: [75],
      kind: "process_verifier",
    }),
  ]);

  assert.equal(registry.registry_status, "registered");
  assert.deepEqual(
    registry.identities.map((item) => item.verifier_id),
    ["verifier-fail", "verifier-infrastructure", "verifier-pass"],
  );
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.identities));
  assert.ok(Object.isFrozen(registry.resolve("verifier-pass")?.definition));
  assert.ok(
    Object.isFrozen(
      registry.resolve("verifier-pass")?.definition.readonly_inputs,
    ),
  );
  assert.ok(
    Object.isFrozen(
      registry.resolve("verifier-pass")?.definition.runner_config.environment,
    ),
  );

  const passed = await launchRegistered(
    t,
    registry,
    "verifier-pass",
    sourceSubjectRoot,
  );
  assert.equal(passed.result.status, "passed");
  assert.equal(passed.result.exit_code, 0);
  assert.equal(
    Buffer.from(passed.result.stdout.captured_base64, "base64").toString("utf8"),
    "registered-pass",
  );
  assert.equal(
    passed.result.config_sha256,
    passed.launch_identity.resolved_config_digest,
  );
  assert.notEqual(
    passed.result.config_sha256,
    passed.definition_identity.verifier_config_digest,
  );
  assert.equal(passed.effective_status, "passed");
  assert.deepEqual(passed.infrastructure_failure_reasons, []);
  assert.equal(
    assertAuthenticEpisodeVerifierExecution(passed.result).config.executable,
    process.execPath,
  );
  assert.notEqual(
    assertAuthenticEpisodeVerifierExecution(passed.result).config.argv[0],
    passPath,
  );
  assert.equal(
    verifierExecutionPackManifestDigest(passed.execution_pack_manifest),
    passed.launch_identity.execution_pack_manifest_sha256,
  );
  assert.equal(
    passed.execution_pack_manifest.verifier_program_digest,
    passed.launch_identity.verifier_program_digest,
  );
  assert.equal(
    JSON.stringify(passed.execution_pack_manifest).includes("registered"),
    false,
    "pack evidence commits runner resolution without persisting env secrets",
  );
  assert.equal(
    runtimeEpisodeVerifierExecutionEvidence(passed).execution_pack_manifest,
    passed.execution_pack_manifest,
  );
  assert.equal(
    assertAuthenticRuntimeEpisodeVerifierRegistryLaunch(passed)
      .definition_sha256,
    passed.definition_identity.definition_sha256,
  );
  assert.equal(
    assertAuthenticRuntimeEpisodeVerifierLaunchEvidence(
      passed,
      TEST_AUTHORITY_VERIFIERS.get(registry)!,
    )
      .launch_identity.launch_sha256,
    passed.launch_identity.launch_sha256,
  );
  assert.throws(
    () => assertAuthenticRuntimeEpisodeVerifierRegistryLaunch({
      ...passed,
    }),
    /runtime_episode_verifier_registry_launch_not_authentic/u,
  );
  assert.ok(Object.isFrozen(passed.definition_identity));

  const failed = await launchRegistered(
    t,
    registry,
    "verifier-fail",
    sourceSubjectRoot,
  );
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.effective_status, "failed");
  assert.equal(failed.result.exit_code, 1);
  assert.equal(
    Buffer.from(failed.result.stderr.captured_base64, "base64").toString("utf8"),
    "registered-failure",
  );
  assert.equal(
    failed.definition_identity.verifier_kind,
    "process_verifier",
  );

  const infrastructure = await launchRegistered(
    t,
    registry,
    "verifier-infrastructure",
    sourceSubjectRoot,
  );
  assert.equal(infrastructure.result.status, "infrastructure_error");
  assert.equal(infrastructure.effective_status, "infrastructure_error");
  assert.equal(infrastructure.result.exit_code, 75);
  assert.deepEqual(
    infrastructure.infrastructure_failure_reasons,
    ["runtime_episode_verifier_runner_infrastructure_error"],
  );
  assert.deepEqual(
    registry.resolve("verifier-infrastructure")
      ?.definition.runner_config.infrastructure_exit_codes,
    [75],
  );
});

test("typed dependency and scratch attachments run from the private pack and fully detach", async (t) => {
  const directory = workspace(t, "typed-pack-inputs");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const verifierRoot = join(directory, "verifier");
  const dependencyRoot = join(directory, "dependency");
  mkdirSync(verifierRoot);
  mkdirSync(dependencyRoot);
  writeFileSync(
    join(dependencyRoot, "package.txt"),
    "private-dependency-v1",
    "utf8",
  );
  const scriptPath = writeVerifier(
    verifierRoot,
    "verify-private-pack.mjs",
    `
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const dependency = readFileSync(
        join(process.cwd(), "node_modules", "package.txt"),
        "utf8",
      );
      if (dependency !== "private-dependency-v1") process.exit(51);
      const scratch = join(process.cwd(), ".aionis", "verifier-scratch");
      writeFileSync(join(scratch, "result.txt"), "scratch-is-writable");
      process.stdout.write(dependency);
    `,
  );
  const secret = "must-not-enter-pack-evidence";
  const registry = createRuntimeEpisodeVerifierRegistry([{
    verifier_id: "typed-pack-verifier",
    verifier_kind: "hidden_test",
    verifier_version: "typed-pack-v1",
    verifier_issuer_id: "aionis-runtime-test",
    reward_role: "primary",
    verifier_material_paths: [verifierRoot],
    readonly_inputs: [{
      contract_version: "runtime_episode_verifier_readonly_input_v1",
      input_id: "node-dependency",
      input_type: "dependency",
      source_path: dependencyRoot,
      subject_path: "node_modules",
    }],
    scratch_overlays: [{
      contract_version: "runtime_episode_verifier_scratch_overlay_v1",
      overlay_id: "verifier-scratch",
      subject_path: ".aionis/verifier-scratch",
    }],
    runner_config: {
      executable: process.execPath,
      argv: [scriptPath],
      cwd: verifierRoot,
      environment: { FIXTURE_SECRET: secret },
      timeout_ms: 10_000,
    },
  }]);
  const prepared = prepareLaunch(
    t,
    registry,
    "typed-pack-verifier",
    sourceSubjectRoot,
  );
  const launch = await registry.launch(
    prepared.authority,
    prepared.materialization,
    durableLifecycle("typed-pack-verifier"),
  );

  assert.equal(launch.effective_status, "passed");
  assert.equal(
    Buffer.from(launch.result.stdout.captured_base64, "base64")
      .toString("utf8"),
    "private-dependency-v1",
  );
  assert.equal(
    launch.execution_pack_manifest.copied_roots.some((root) =>
      root.input_id === "node-dependency"
      && root.source_kind === "dependency"
      && root.subject_path === "node_modules"),
    true,
  );
  assert.equal(
    existsSync(join(prepared.materialization.subject_root, "node_modules")),
    false,
  );
  assert.equal(
    existsSync(join(prepared.materialization.subject_root, ".aionis")),
    false,
  );
  assert.equal(
    JSON.stringify(runtimeEpisodeVerifierExecutionEvidence(launch))
      .includes(secret),
    false,
    "persisted execution evidence must contain only config commitments",
  );
  assert.equal(
    readFileSync(join(dependencyRoot, "package.txt"), "utf8"),
    "private-dependency-v1",
  );
});

test("opaque invocation authority rejects cross-channel, cross-episode, and replayed launches", async (t) => {
  const directory = workspace(t, "authority-replay");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const scriptPath = writeVerifier(
    directory,
    "pass.mjs",
    "process.stdout.write('authority-bound-pass');",
  );
  const definitions = [
    definition({
      verifierId: "authority-bound-verifier",
      cwd: directory,
      scriptPath,
    }),
  ];
  const firstChannel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const secondChannel =
    createRuntimeEpisodeVerifierInvocationAuthorityChannel();
  const firstRegistry = createVerifierRegistry(
    definitions,
    firstChannel.verifier,
  );
  const secondRegistry = createVerifierRegistry(
    definitions,
    secondChannel.verifier,
  );
  TEST_AUTHORITY_ISSUERS.set(firstRegistry, firstChannel.issuer);
  TEST_AUTHORITY_VERIFIERS.set(firstRegistry, firstChannel.verifier);
  TEST_AUTHORITY_ISSUERS.set(secondRegistry, secondChannel.issuer);
  TEST_AUTHORITY_VERIFIERS.set(secondRegistry, secondChannel.verifier);
  const prepared = prepareLaunch(
    t,
    firstRegistry,
    "authority-bound-verifier",
    sourceSubjectRoot,
    {
      episodeId: "episode-authority-a",
      invocationId: "invocation-authority-a",
    },
  );

  await assert.rejects(
    firstRegistry.launch({
      ...prepared.authority,
      episode_id: "episode-authority-b",
    }, prepared.materialization, durableLifecycle("wrong-episode")),
    /runtime_episode_verifier_invocation_authority_not_authentic/u,
  );
  await assert.rejects(
    secondRegistry.launch(
      prepared.authority,
      prepared.materialization,
      durableLifecycle("wrong-authority-channel"),
    ),
    /runtime_episode_verifier_invocation_authority_not_authentic/u,
  );

  const launch = await firstRegistry.launch(
    prepared.authority,
    prepared.materialization,
    durableLifecycle("authority-bound"),
  );
  assert.equal(launch.effective_status, "passed");
  assert.equal(launch.launch_identity.episode_id, "episode-authority-a");
  assert.equal(
    launch.launch_identity.verifier_invocation_id,
    "invocation-authority-a",
  );
  assert.equal(
    launch.launch_identity.invocation_authority_channel_id,
    firstChannel.verifier.channel_id,
  );
  assert.throws(
    () => assertAuthenticRuntimeEpisodeVerifierLaunchEvidence(
      launch,
      secondChannel.verifier,
    ),
    /runtime_episode_verifier_launch_authority_channel_mismatch/u,
  );
  await assert.rejects(
    firstRegistry.launch(
      prepared.authority,
      prepared.materialization,
      durableLifecycle("authority-replay"),
    ),
    /runtime_episode_verifier_invocation_authority_already_consumed/u,
  );
});

test("registry rejects wrong required verifier identity and wrong CAS source materialization", async (t) => {
  const directory = workspace(t, "wrong-bindings");
  const sourceA = subjectWorkspace(directory, "source-a");
  const sourceB = subjectWorkspace(directory, "source-b");
  writeFileSync(join(sourceB, "subject.txt"), "different-source", "utf8");
  const scriptPath = writeVerifier(
    directory,
    "pass.mjs",
    "process.stdout.write('binding-pass');",
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "binding-verifier",
      cwd: directory,
      scriptPath,
    }),
  ]);

  const wrongDefinition = prepareLaunch(
    t,
    registry,
    "binding-verifier",
    sourceA,
    {
      verifierDefinitionSha256: sha256Hex("wrong-definition"),
    },
  );
  await assert.rejects(
    registry.launch(
      wrongDefinition.authority,
      wrongDefinition.materialization,
      durableLifecycle("wrong-definition"),
    ),
    /runtime_episode_verifier_invocation_definition_binding_mismatch/u,
  );

  const preparedA = prepareLaunch(
    t,
    registry,
    "binding-verifier",
    sourceA,
  );
  const preparedB = prepareLaunch(
    t,
    registry,
    "binding-verifier",
    sourceB,
  );
  await assert.rejects(
    registry.launch(
      preparedA.authority,
      preparedB.materialization,
      durableLifecycle("wrong-materialization"),
    ),
    /runtime_episode_verifier_authority_materialization_binding_mismatch/u,
  );
  const launch = await registry.launch(
    preparedA.authority,
    preparedA.materialization,
    durableLifecycle("binding-verifier"),
  );
  assert.equal(launch.effective_status, "passed");
  assert.equal(
    launch.launch_identity.source_content_digest,
    preparedA.authority.source_content_digest,
  );
  assert.notEqual(
    preparedA.authority.source_content_digest,
    preparedB.authority.source_content_digest,
  );
});

test("registered argv and environment cannot point back into the live subject", async (t) => {
  const directory = workspace(t, "live-path");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const liveFilePath = join(sourceSubjectRoot, "subject.txt");
  const markerPath = join(directory, "must-not-run.marker");
  const scriptPath = writeVerifier(
    directory,
    "must-not-run.mjs",
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "ran", "utf8");
    `,
  );
  const argvRegistry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "live-argv-verifier",
      cwd: directory,
      scriptPath,
      argv: [liveFilePath],
      materialPaths: [scriptPath, liveFilePath],
    }),
  ]);
  await assert.rejects(
    launchRegistered(
      t,
      argvRegistry,
      "live-argv-verifier",
      sourceSubjectRoot,
    ),
    /runtime_episode_verifier_live_subject_path_in_argv_forbidden/u,
  );

  const environmentRegistry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "live-environment-verifier",
      cwd: directory,
      scriptPath,
      environment: {
        ORIGINAL_WORKSPACE: sourceSubjectRoot,
      },
      immutableInputPaths: [sourceSubjectRoot],
    }),
  ]);
  await assert.rejects(
    launchRegistered(
      t,
      environmentRegistry,
      "live-environment-verifier",
      sourceSubjectRoot,
    ),
    /runtime_episode_verifier_live_subject_path_in_environment_forbidden/u,
  );
  assert.throws(() => readFileSync(markerPath), /ENOENT/u);
});

test("primary verifier binds absolute environment oracle bytes and rejects drift", async (t) => {
  const directory = workspace(t, "environment-oracle");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const oracleDirectory = join(directory, "immutable-oracle");
  mkdirSync(oracleDirectory);
  const oraclePath = join(oracleDirectory, "oracle.txt");
  writeFileSync(oraclePath, "expected-oracle", "utf8");
  const scriptPath = writeVerifier(
    directory,
    "read-oracle.mjs",
    `
      import { readFileSync } from "node:fs";
      process.exit(
        readFileSync(process.env.ORACLE_PATH, "utf8") === "expected-oracle"
          ? 0
          : 19
      );
    `,
  );

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      definition({
        verifierId: "undeclared-environment-oracle",
        cwd: directory,
        scriptPath,
        environment: { ORACLE_PATH: oraclePath },
      }),
    ]),
    /runtime_primary_verifier_environment_immutable_input_not_declared/u,
  );

  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "declared-environment-oracle",
      cwd: directory,
      scriptPath,
      environment: { ORACLE_PATH: oraclePath },
      immutableInputPaths: [oracleDirectory],
    }),
  ]);
  const prepared = prepareLaunch(
    t,
    registry,
    "declared-environment-oracle",
    sourceSubjectRoot,
  );
  writeFileSync(oraclePath, "changed-after-registration", "utf8");
  await assert.rejects(
    registry.launch(
      prepared.authority,
      prepared.materialization,
      durableLifecycle("program-drift"),
    ),
    /runtime_episode_verifier_program_drift_before_launch/u,
  );
});

test("a verifier cannot mutate a declared environment oracle in its private pack", async (t) => {
  const directory = workspace(t, "environment-oracle-mutation");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const oraclePath = join(directory, "oracle.txt");
  writeFileSync(oraclePath, "immutable-oracle", "utf8");
  const scriptPath = writeVerifier(
    directory,
    "mutate-oracle.mjs",
    `
      import { readFileSync, writeFileSync } from "node:fs";
      if (readFileSync(process.env.ORACLE_PATH, "utf8") !== "immutable-oracle") {
        process.exit(41);
      }
      writeFileSync(process.env.ORACLE_PATH, "mutated", "utf8");
      process.stdout.write("exit-zero-after-oracle-mutation");
    `,
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "mutating-environment-oracle",
      cwd: directory,
      scriptPath,
      environment: { ORACLE_PATH: oraclePath },
      immutableInputPaths: [oraclePath],
    }),
  ]);

  const launch = await launchRegistered(
    t,
    registry,
    "mutating-environment-oracle",
    sourceSubjectRoot,
  );
  assert.equal(launch.result.status, "failed");
  assert.equal(launch.effective_status, "failed");
  assert.deepEqual(launch.infrastructure_failure_reasons, []);
  assert.equal(readFileSync(oraclePath, "utf8"), "immutable-oracle");
});

test("primary verifier cannot register a missing path-like argv target that appears later", (t) => {
  const directory = workspace(t, "late-argv");
  const missingInputPath = join(directory, "late-oracle.json");
  const scriptPath = writeVerifier(
    directory,
    "late-input.mjs",
    "process.exit(0);",
  );
  const input = definition({
    verifierId: "late-argv-verifier",
    cwd: directory,
    scriptPath,
    argv: [missingInputPath],
  });

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([input]),
    /runtime_primary_verifier_argv_path_unavailable_at_registration/u,
  );
  writeFileSync(missingInputPath, "created-after-registration-attempt", "utf8");
  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([input]),
    /runtime_primary_verifier_argv_material_not_declared/u,
  );
});

test("exit-zero verifier mutation of the CAS clone becomes authentic infrastructure failure", async (t) => {
  const directory = workspace(t, "subject-mutation");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const scriptPath = writeVerifier(
    directory,
    "mutate-clone.mjs",
    `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      writeFileSync(
        join(process.env.AIONIS_VERIFIER_SUBJECT_ROOT, "subject.txt"),
        "mutated-by-verifier",
        "utf8",
      );
      process.stdout.write("child-exited-zero");
    `,
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "clone-mutating-verifier",
      cwd: directory,
      scriptPath,
    }),
  ]);
  const prepared = prepareLaunch(
    t,
    registry,
    "clone-mutating-verifier",
    sourceSubjectRoot,
  );
  const launch = await registry.launch(
    prepared.authority,
    prepared.materialization,
    durableLifecycle("subject-mutation"),
  );

  assert.equal(launch.result.status, "passed");
  assert.equal(launch.result.exit_code, 0);
  assert.equal(launch.effective_status, "infrastructure_error");
  assert.deepEqual(launch.infrastructure_failure_reasons, [
    "runtime_episode_verifier_subject_modified_during_launch",
  ]);
  assert.equal(
    launch.launch_identity.effective_status,
    "infrastructure_error",
  );
  assert.equal(
    readFileSync(join(sourceSubjectRoot, "subject.txt"), "utf8"),
    "runtime-captured-subject",
  );
  const evidence = assertAuthenticRuntimeEpisodeVerifierLaunchEvidence(
    launch,
    TEST_AUTHORITY_VERIFIERS.get(registry)!,
  );
  assert.equal(
    evidence.result.result_sha256,
    launch.launch_identity.result_sha256,
  );
});

test("registry fixes real Node verifier script bytes and rejects replacement before launch", async (t) => {
  const directory = workspace(t, "replaced-script");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const markerPath = join(directory, "replacement-ran.marker");
  const scriptPath = writeVerifier(
    directory,
    "replaceable.mjs",
    "process.stdout.write('original-verifier');",
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "replaceable-verifier",
      cwd: directory,
      scriptPath,
    }),
  ]);
  const originalProgramDigest = registry.resolve("replaceable-verifier")
    ?.identity.verifier_program_digest;
  assert.match(originalProgramDigest ?? "", /^[a-f0-9]{64}$/u);

  writeFileSync(
    scriptPath,
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "replacement-ran", "utf8");
      process.stdout.write("replacement-verifier");
    `,
    { encoding: "utf8", mode: 0o600 },
  );

  await assert.rejects(
    launchRegistered(
      t,
      registry,
      "replaceable-verifier",
      sourceSubjectRoot,
    ),
    /runtime_episode_verifier_program_drift_before_launch/u,
  );
  assert.throws(() => readFileSync(markerPath), /ENOENT/u);
});

test("a verifier cannot mutate its packed script or its registered live source", async (t) => {
  const directory = workspace(t, "self-modifying-script");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const scriptPath = writeVerifier(
    directory,
    "self-modifying.mjs",
    `
      import { appendFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      appendFileSync(fileURLToPath(import.meta.url), "\\n// drifted during verification\\n");
      process.stdout.write("exit-zero-after-self-modification");
    `,
  );
  const registeredSource = readFileSync(scriptPath, "utf8");
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "self-modifying-verifier",
      cwd: directory,
      scriptPath,
    }),
  ]);

  const launch = await launchRegistered(
    t,
    registry,
    "self-modifying-verifier",
    sourceSubjectRoot,
  );
  assert.equal(launch.result.status, "failed");
  assert.equal(launch.effective_status, "failed");
  assert.deepEqual(launch.infrastructure_failure_reasons, []);
  assert.equal(readFileSync(scriptPath, "utf8"), registeredSource);
});

test("primary verifier fails closed when an existing argv file is not declared as material", (t) => {
  const directory = workspace(t, "undeclared-argv");
  const scriptPath = writeVerifier(
    directory,
    "undeclared.mjs",
    "process.exit(0);",
  );

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      definition({
        verifierId: "undeclared-argv-verifier",
        cwd: directory,
        scriptPath,
        materialPaths: [],
      }),
    ]),
    /runtime_primary_verifier_argv_material_not_declared/u,
  );
});

test("material directories do not follow symlinks and require the real target bytes to be declared", async (t) => {
  const directory = workspace(t, "material-symlink");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const programDirectory = join(directory, "program");
  const externalDirectory = join(directory, "external");
  mkdirSync(programDirectory);
  mkdirSync(externalDirectory);
  const externalDependencyPath = writeVerifier(
    externalDirectory,
    "dependency.mjs",
    "export const verdict = true;",
  );
  const linkedDependencyPath = join(programDirectory, "dependency.mjs");
  symlinkSync(externalDependencyPath, linkedDependencyPath);
  const scriptPath = writeVerifier(
    programDirectory,
    "verify.mjs",
    `
      import { verdict } from "./dependency.mjs";
      process.exit(verdict ? 0 : 9);
    `,
  );

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      definition({
        verifierId: "symlink-target-undeclared",
        cwd: directory,
        scriptPath,
        materialPaths: [programDirectory],
      }),
    ]),
    /runtime_verifier_material_symlink_target_not_declared/u,
  );

  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "symlink-target-declared",
      cwd: directory,
      scriptPath,
      materialPaths: [programDirectory, externalDependencyPath],
    }),
  ]);
  writeFileSync(
    externalDependencyPath,
    "export const verdict = false;",
    { encoding: "utf8", mode: 0o600 },
  );
  await assert.rejects(
    launchRegistered(
      t,
      registry,
      "symlink-target-declared",
      sourceSubjectRoot,
    ),
    /runtime_episode_verifier_program_drift_before_launch/u,
  );
});

test("standalone executable needs no duplicate material declaration", async (t) => {
  const directory = workspace(t, "standalone-executable");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const executablePath = writeVerifier(
    directory,
    "standalone-verifier",
    "#!/bin/sh\nprintf standalone-pass\n",
  );
  chmodSync(executablePath, 0o700);
  const registry = createRuntimeEpisodeVerifierRegistry([{
    verifier_id: "standalone-verifier",
    verifier_kind: "independent_executable",
    verifier_version: "standalone-v1",
    verifier_issuer_id: "aionis-runtime-test",
    reward_role: "primary",
    verifier_material_paths: [],
    runner_config: {
      executable: executablePath,
      argv: [],
      cwd: directory,
      environment: {},
      timeout_ms: 10_000,
    },
  }]);

  const launch = await launchRegistered(
    t,
    registry,
    "standalone-verifier",
    sourceSubjectRoot,
  );
  assert.equal(
    launch.result.status,
    "passed",
    JSON.stringify(launch.infrastructure_failure_reasons),
  );
  assert.equal(
    Buffer.from(launch.result.stdout.captured_base64, "base64")
      .toString("utf8"),
    "standalone-pass",
  );
  assert.match(
    launch.definition_identity.verifier_program_digest,
    /^[a-f0-9]{64}$/u,
  );
});

test("unknown verifier IDs fail closed before any process launch", async (t) => {
  const directory = workspace(t, "unknown");
  const scriptPath = writeVerifier(
    directory,
    "known.mjs",
    "process.exit(0);",
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "known-verifier",
      cwd: directory,
      scriptPath,
    }),
  ]);

  assert.equal(registry.resolve("unknown-verifier"), null);
  await assert.rejects(
    registry.launch("unknown-verifier"),
    /requires_persisted_invocation_authority_materialization_and_durable_lifecycle/u,
  );
});

test("registry construction rejects conflicting definitions with the same ID", (t) => {
  const directory = workspace(t, "duplicate");
  const passPath = writeVerifier(
    directory,
    "pass.mjs",
    "process.exit(0);",
  );
  const failPath = writeVerifier(
    directory,
    "fail.mjs",
    "process.exit(1);",
  );

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      definition({
        verifierId: "duplicate-verifier",
        cwd: directory,
        scriptPath: passPath,
      }),
      definition({
        verifierId: "duplicate-verifier",
        cwd: directory,
        scriptPath: failPath,
      }),
    ]),
    /duplicate_runtime_episode_verifier_id:duplicate-verifier/u,
  );
});

test("llm judge diagnostics cannot be registered as a primary verifier", (t) => {
  const directory = workspace(t, "diagnostic");
  const scriptPath = writeVerifier(
    directory,
    "judge.mjs",
    "process.exit(0);",
  );

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      definition({
        verifierId: "judge-as-primary",
        cwd: directory,
        scriptPath,
        kind: "llm_judge_diagnostic",
        role: "primary",
      }),
    ]),
    /runtime_primary_verifier_cannot_be_llm_judge_diagnostic/u,
  );

  const diagnostic = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "judge-diagnostic",
      cwd: directory,
      scriptPath,
      kind: "llm_judge_diagnostic",
      role: "diagnostic",
    }),
  ]);
  assert.equal(
    diagnostic.resolve("judge-diagnostic")?.identity.reward_role,
    "diagnostic",
  );
});

test("launch API rejects command overrides and still uses only the registered definition", async (t) => {
  const directory = workspace(t, "override");
  const sourceSubjectRoot = subjectWorkspace(directory);
  const overrideMarker = join(directory, "override.marker");
  const registeredPath = writeVerifier(
    directory,
    "registered.mjs",
    `
      process.stdout.write("registered");
    `,
  );
  const overridePath = writeVerifier(
    directory,
    "override.mjs",
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.argv[2], "override", "utf8");
      process.exit(23);
    `,
  );
  const registry = createRuntimeEpisodeVerifierRegistry([
    definition({
      verifierId: "closed-launch",
      cwd: directory,
      scriptPath: registeredPath,
    }),
  ]);

  const callWithOverride = registry.launch as unknown as (
    verifierId: string,
    override: EpisodeVerifierRunnerConfig,
  ) => Promise<unknown>;
  await assert.rejects(
    callWithOverride("closed-launch", runnerConfig(
      directory,
      overridePath,
      [overrideMarker],
    )),
    /runtime_episode_verifier_launch_requires_persisted_invocation_authority_materialization_and_durable_lifecycle/u,
  );
  assert.throws(
    () => readFileSync(overrideMarker, "utf8"),
    /ENOENT/u,
  );

  const launched = await launchRegistered(
    t,
    registry,
    "closed-launch",
    sourceSubjectRoot,
  );
  assert.equal(launched.result.status, "passed");
  assert.equal(
    Buffer.from(launched.result.stdout.captured_base64, "base64")
      .toString("utf8"),
    "registered",
  );
  assert.throws(
    () => readFileSync(overrideMarker, "utf8"),
    /ENOENT/u,
  );
});

test("canonical definition digest is stable across config defaults and environment order", (t) => {
  const directory = workspace(t, "digest");
  const scriptPath = writeVerifier(
    directory,
    "stable.mjs",
    "process.exit(0);",
  );
  const left: RuntimeEpisodeVerifierDefinitionInput = {
    verifier_id: "stable-verifier",
    verifier_kind: "environment_assertion",
    verifier_version: "stable-v1",
    verifier_issuer_id: "aionis-runtime",
    reward_role: "primary",
    verifier_material_paths: [scriptPath],
    runner_config: {
      executable: process.execPath,
      argv: [scriptPath, "", "literal argument"],
      cwd: directory,
      environment: {
        Z_VALUE: "last",
        A_VALUE: "first",
      },
      timeout_ms: 2_000,
      terminate_grace_ms: 1_000,
      max_stdout_bytes: 1024 * 1024,
      max_stderr_bytes: 1024 * 1024,
      infrastructure_exit_codes: [],
    },
  };
  const right: RuntimeEpisodeVerifierDefinitionInput = {
    ...left,
    runner_config: {
      executable: process.execPath,
      argv: [scriptPath, "", "literal argument"],
      cwd: directory,
      environment: {
        A_VALUE: "first",
        Z_VALUE: "last",
      },
      timeout_ms: 2_000,
    },
  };

  assert.equal(
    runtimeEpisodeVerifierDefinitionDigest(left),
    runtimeEpisodeVerifierDefinitionDigest(right),
  );
  const leftRegistry = createRuntimeEpisodeVerifierRegistry([left]);
  const rightRegistry = createRuntimeEpisodeVerifierRegistry([right]);
  assert.equal(
    leftRegistry.resolve("stable-verifier")?.identity.definition_sha256,
    rightRegistry.resolve("stable-verifier")?.identity.definition_sha256,
  );
  assert.equal(
    leftRegistry.resolve("stable-verifier")?.identity.verifier_config_digest,
    rightRegistry.resolve("stable-verifier")?.identity.verifier_config_digest,
  );

  const infrastructureDefinition: RuntimeEpisodeVerifierDefinitionInput = {
    ...right,
    runner_config: {
      ...right.runner_config,
      infrastructure_exit_codes: [75],
    },
  };
  const infrastructureRegistry =
    createRuntimeEpisodeVerifierRegistry([infrastructureDefinition]);
  assert.notEqual(
    infrastructureRegistry.resolve("stable-verifier")
      ?.identity.verifier_config_digest,
    rightRegistry.resolve("stable-verifier")
      ?.identity.verifier_config_digest,
  );
  assert.notEqual(
    infrastructureRegistry.resolve("stable-verifier")
      ?.identity.definition_sha256,
    rightRegistry.resolve("stable-verifier")
      ?.identity.definition_sha256,
  );
});

test("registry startup rejects non-canonical unknown configuration fields", (t) => {
  const directory = workspace(t, "strict");
  const scriptPath = writeVerifier(
    directory,
    "strict.mjs",
    "process.exit(0);",
  );
  const input = definition({
    verifierId: "strict-verifier",
    cwd: directory,
    scriptPath,
  });
  const withUnknownConfig = {
    ...input,
    runner_config: {
      ...input.runner_config,
      command_override: "/bin/true",
    },
  };

  assert.throws(
    () => createRuntimeEpisodeVerifierRegistry([
      withUnknownConfig as RuntimeEpisodeVerifierDefinitionInput,
    ]),
    /Verifier runner config contains unknown keys: command_override/u,
  );
});

test("bounded JSON parser canonicalizes and deeply freezes verifier definitions", () => {
  const parsed = parseRuntimeEpisodeVerifierDefinitionsJson(JSON.stringify([
    {
      verifier_id: "json-verifier",
      verifier_kind: "database_constraint",
      verifier_version: "json-v1",
      verifier_issuer_id: "aionis-runtime",
      reward_role: "primary",
      verifier_material_paths: [],
      runner_config: {
        executable: process.execPath,
        argv: ["verifier.mjs"],
        cwd: process.cwd(),
        environment: {
          Z_VALUE: "last",
          A_VALUE: "first",
        },
        infrastructure_exit_codes: [75, 70],
        timeout_ms: 2_000,
      },
    },
  ]));

  assert.equal(parsed.length, 1);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed[0]));
  assert.ok(Object.isFrozen(parsed[0]?.runner_config));
  assert.ok(Object.isFrozen(parsed[0]?.runner_config.argv));
  assert.ok(Object.isFrozen(parsed[0]?.runner_config.environment));
  assert.ok(Object.isFrozen(parsed[0]?.readonly_inputs));
  assert.ok(Object.isFrozen(parsed[0]?.scratch_overlays));
  assert.deepEqual(parsed[0]?.readonly_inputs, []);
  assert.deepEqual(parsed[0]?.scratch_overlays, []);
  assert.deepEqual(
    Object.keys(parsed[0]?.runner_config.environment ?? {}),
    ["A_VALUE", "Z_VALUE"],
  );
  assert.equal(parsed[0]?.runner_config.terminate_grace_ms, 1_000);
  assert.equal(parsed[0]?.runner_config.max_stdout_bytes, 1024 * 1024);
  assert.equal(parsed[0]?.runner_config.max_stderr_bytes, 1024 * 1024);
  assert.deepEqual(
    parsed[0]?.runner_config.infrastructure_exit_codes,
    [70, 75],
  );
});

test("bounded JSON parser enforces total bytes, entry count, and array shape", () => {
  assert.throws(
    () => parseRuntimeEpisodeVerifierDefinitionsJson(
      " ".repeat(
        RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_JSON_BYTES + 1,
      ),
    ),
    /exceeds the configured byte limit/u,
  );
  assert.throws(
    () => parseRuntimeEpisodeVerifierDefinitionsJson(JSON.stringify(
      Array.from(
        {
          length:
            RUNTIME_EPISODE_VERIFIER_DEFINITIONS_MAX_ENTRIES + 1,
        },
        () => ({}),
      ),
    )),
    /exceeds the verifier entry limit/u,
  );
  assert.throws(
    () => parseRuntimeEpisodeVerifierDefinitionsJson("{}"),
    /must be a JSON array/u,
  );
  assert.throws(
    () => parseRuntimeEpisodeVerifierDefinitionsJson("["),
    /must be a valid JSON array/u,
  );
});

test("JSON parser never reflects verifier environment secrets in errors", () => {
  const secret = "registry-secret-must-never-appear";
  const raw = JSON.stringify([
    {
      verifier_id: "invalid-primary-judge",
      verifier_kind: "llm_judge_diagnostic",
      verifier_version: "invalid-v1",
      verifier_issuer_id: "aionis-runtime",
      reward_role: "primary",
      verifier_material_paths: [],
      runner_config: {
        executable: process.execPath,
        argv: [],
        cwd: process.cwd(),
        environment: {
          PROVIDER_SECRET: secret,
        },
        timeout_ms: 2_000,
      },
    },
  ]);

  let error: unknown;
  try {
    parseRuntimeEpisodeVerifierDefinitionsJson(raw);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /invalid definition at index 0/u);
  assert.doesNotMatch(error.message, new RegExp(secret, "u"));
});
