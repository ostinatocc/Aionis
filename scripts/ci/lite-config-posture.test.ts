import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import stableStringify from "fast-json-stable-stringify";
import {
  admissionCandidatePolicyExperimentDeclarationDigest,
  admissionCandidatePolicyProfileRuleDigest,
  loadEnv,
  parseAdmissionCandidatePolicyProfileRules,
} from "../../src/config.ts";

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

function immutableExperiment(overrides: Record<string, unknown> = {}) {
  const allowedVerifiers = [
    {
      kind: "deterministic_scorer",
      version: "scorer-v1",
      config_sha256: "1".repeat(64),
    },
  ];
  return {
    experiment_id: "admission-candidate-r1",
    revision: 1,
    serving_phase: "shadow",
    evidence_intent: "integrity_only",
    assignment_design: "diagnostic_hash_v1",
    candidate_policy_id: "candidate_project_context_closed_loop_inspect",
    candidate_policy_version: "2026-06-18",
    candidate_allocation_bps: 5000,
    gate_policy_id: "gate-policy",
    gate_policy_version: "v1",
    required_evidence_series: {
      offline_paired: "series-offline-v1",
      production_shadow: "series-production-v1",
      tool_e2e: "series-tool-v1",
      runtime_integrity: "series-runtime-v1",
    },
    external_execution_policy_ref: {
      registry_key: "external-execution-v1",
    },
    collection_sources: [
      {
        principal_sha256: "a".repeat(64),
        class: "eligible_host",
        collector_id: "host-collector",
        collector_version: "collector-v1",
        verifier_policy_sha256: digest({ allowed_verifiers: allowedVerifiers }),
        allowed_verifiers: allowedVerifiers,
      },
    ],
    safety_pause_mode: "automatic",
    ...overrides,
  };
}

function experimentProfile(
  experiment: Record<string, unknown> = immutableExperiment(),
  overrides: Record<string, unknown> = {},
) {
  return {
    profile_id: "validated-coding-worker",
    mode: "active",
    task_families: ["validated_coding_continuation"],
    agent_roles: ["worker"],
    context_modes: ["compact_agent"],
    experiment,
    ...overrides,
  };
}

async function withIsolatedEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous = process.env;
  const next: NodeJS.ProcessEnv = {
    PATH: previous.PATH ?? "",
    HOME: previous.HOME ?? "",
    TMPDIR: previous.TMPDIR ?? "",
    USER: previous.USER ?? "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) next[key] = value;
  }
  process.env = next;
  try {
    await fn();
  } finally {
    process.env = previous;
  }
}

test("shipped source tree defaults to lite posture", async () => {
  await withIsolatedEnv({}, () => {
    const env = loadEnv();
    assert.equal(env.AIONIS_EDITION, "lite");
    assert.equal(env.AIONIS_MODE, "local");
    assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "shadow");
    assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "off");
    assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON, "[]");
    assert.equal(env.MEMORY_AUTH_MODE, "off");
    assert.equal(env.TENANT_QUOTA_ENABLED, false);
    assert.equal(env.RECALL_ENGINE_MODE, "hybrid");
  });
});

test("inspect-before-use active projection is explicit opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_INSPECT_BEFORE_USE_MODE: "active",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_INSPECT_BEFORE_USE_MODE, "active");
    },
  );
});

test("admission candidate policy active projection is explicit opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "shadow",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "shadow");
    },
  );
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "active",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "active");
    },
  );
});

test("admission candidate policy profile rules are explicit and scoped", async () => {
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: JSON.stringify([
        {
          profile_id: "validated-coding-worker",
          mode: "active",
          task_families: ["validated_coding_continuation"],
          agent_roles: ["worker"],
          context_modes: ["compact_agent"],
        },
      ]),
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_ADMISSION_CANDIDATE_POLICY_MODE, "off");
      assert.match(env.AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON, /validated-coding-worker/);
    },
  );
  await withIsolatedEnv(
    {
      AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: JSON.stringify([
        {
          profile_id: "unsafe-catch-all",
          mode: "active",
        },
      ]),
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /profile rule must include at least one selector/,
      );
    },
  );
});

test("legacy admission profiles remain valid without experiment enrollment", () => {
  const rules = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    {
      profile_id: "legacy-profile",
      mode: "active",
      task_families: ["legacy-task-family"],
    },
  ]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.profile_id, "legacy-profile");
  assert.equal(rules[0]?.experiment, undefined);
});

test("admission profiles accept a strict registry-referenced immutable experiment declaration", () => {
  const rules = parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
    experimentProfile(),
  ]));
  const experiment = rules[0]?.experiment;
  assert.ok(experiment);
  assert.equal(experiment.serving_phase, "shadow");
  assert.equal(experiment.evidence_intent, "integrity_only");
  assert.equal(experiment.external_execution_policy_ref.registry_key, "external-execution-v1");
  assert.equal(experiment.collection_sources[0]?.class, "eligible_host");
  assert.equal(
    admissionCandidatePolicyExperimentDeclarationDigest(experiment),
    digest(experiment),
  );
  assert.equal(
    admissionCandidatePolicyProfileRuleDigest(rules[0]!),
    digest(rules[0]),
  );
});

test("immutable experiment declarations reject authority claims and raw execution policy", () => {
  for (const forbidden of [
    { assignment_arm: "candidate" },
    { assignment_randomness_sha256: "a".repeat(64) },
    { diagnostic_assignment_seed: "secret" },
    { confirmatory_assignment_bits: "secret" },
    { collection_class: "eligible_host" },
    { external_execution_policy: { roles: {} } },
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(immutableExperiment(forbidden)),
      ])),
      /unrecognized key|invalid/i,
    );
  }
});

test("immutable experiment declarations enforce the profile ceiling and gate-policy phase matrix", () => {
  const invalidProfiles = [
    experimentProfile(immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
    }), { mode: "shadow" }),
    experimentProfile(immutableExperiment({ evidence_intent: "confirmatory" })),
    experimentProfile(immutableExperiment({ assignment_design: "matched_pair_complete_randomization_v1" })),
    experimentProfile(immutableExperiment({
      serving_phase: "active_control",
      evidence_intent: "confirmatory",
      assignment_design: "matched_pair_complete_randomization_v1",
      candidate_allocation_bps: 4000,
    })),
    experimentProfile(immutableExperiment({ safety_pause_mode: "manual" })),
  ];
  for (const profile of invalidProfiles) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([profile])),
      /shadow|evidence|assignment|5000|automatic/i,
    );
  }
});

test("immutable experiment declarations require canonical policy tuples and four distinct evidence series", () => {
  for (const experiment of [
    immutableExperiment({ revision: 0 }),
    immutableExperiment({ candidate_policy_version: "unknown" }),
    immutableExperiment({ gate_policy_version: "v2" }),
    immutableExperiment({
      required_evidence_series: {
        offline_paired: "same-series",
        production_shadow: "same-series",
        tool_e2e: "series-tool-v1",
        runtime_integrity: "series-runtime-v1",
      },
    }),
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(experiment),
      ])),
      /revision|candidate|gate|distinct|literal/i,
    );
  }
});

test("collection source declarations bind canonical verifier allowlists and unique principal fingerprints", () => {
  const base = immutableExperiment();
  const source = (base.collection_sources as Array<Record<string, unknown>>)[0]!;
  const verifierPolicy = source.allowed_verifiers as Array<Record<string, unknown>>;
  const secondVerifier = {
    kind: "instrumented_agent_trace",
    version: "trace-v1",
    config_sha256: "2".repeat(64),
  };
  const unsortedVerifiers = [secondVerifier, ...verifierPolicy];
  const secondSource = {
    ...source,
    principal_sha256: "b".repeat(64),
  };
  for (const collectionSources of [
    [{ ...source, api_key: "must-not-be-configured" }],
    [{ ...source, class: "caller_selected" }],
    [{ ...source, collector_id: "" }],
    [{ ...source, verifier_policy_sha256: "f".repeat(64) }],
    [{
      ...source,
      allowed_verifiers: unsortedVerifiers,
      verifier_policy_sha256: digest({ allowed_verifiers: unsortedVerifiers }),
    }],
    [source, { ...source, collector_id: "duplicate-principal" }],
    [secondSource, source],
  ]) {
    assert.throws(
      () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
        experimentProfile(immutableExperiment({ collection_sources: collectionSources })),
      ])),
      /unrecognized key|class|collector|verifier|duplicate|principal|canonical/i,
    );
  }
});

test("one experiment revision cannot drift across profile declarations", () => {
  assert.throws(
    () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
      experimentProfile(),
      experimentProfile(immutableExperiment({ candidate_allocation_bps: 4500 }), {
        profile_id: "same-revision-drift",
        task_families: ["another-task-family"],
      }),
    ])),
    /experiment revision configuration drift/i,
  );
  assert.throws(
    () => parseAdmissionCandidatePolicyProfileRules(JSON.stringify([
      experimentProfile(),
      experimentProfile(immutableExperiment(), {
        profile_id: "same-experiment-different-profile",
        task_families: ["another-task-family"],
      }),
    ])),
    /experiment revision configuration drift/i,
  );
});

test("lite recall engine can opt into hybrid explicitly", async () => {
  await withIsolatedEnv(
    {
      RECALL_ENGINE_MODE: "hybrid",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_EDITION, "lite");
      assert.equal(env.RECALL_ENGINE_MODE, "hybrid");
    },
  );
});

test("lite plus prod fails with an explicit posture error", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      APP_ENV: "prod",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Lite runtime does not currently support APP_ENV=prod; use APP_ENV=dev\/ci\./i,
      );
    },
  );
});

test("lite unauthenticated remote bind requires explicit operator opt-in", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /AIONIS_LISTEN_HOST exposes an unauthenticated Lite Runtime/i,
      );
    },
  );
});

test("lite unauthenticated remote bind can be intentionally enabled", async () => {
  await withIsolatedEnv(
    {
      AIONIS_LISTEN_HOST: "0.0.0.0",
      AIONIS_ALLOW_UNAUTHENTICATED_REMOTE: "true",
    },
    () => {
      const env = loadEnv();
      assert.equal(env.AIONIS_LISTEN_HOST, "0.0.0.0");
      assert.equal(env.AIONIS_ALLOW_UNAUTHENTICATED_REMOTE, true);
      assert.equal(env.MEMORY_AUTH_MODE, "off");
    },
  );
});

test("lite edition rejects service mode posture", async () => {
  await withIsolatedEnv(
    {
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "service",
    },
    () => {
      assert.throws(
        () => loadEnv(),
        /Aionis Lite requires AIONIS_MODE=local/i,
      );
    },
  );
});
