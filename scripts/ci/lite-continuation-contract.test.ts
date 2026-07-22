import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalUtcMillis,
  assertSha256,
  canonicalContinuationClone,
  canonicalContinuationJson,
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  compareCanonicalUtf8,
  type AuthorityArtifactRefV1,
  type ExecutionCapsuleV1,
} from "../../src/continuation/contract.ts";
import {
  assertContinuationRuntimeV1Host,
  CONTINUATION_RUNTIME_V1_NODE_VERSION_RANGE,
  isContinuationRuntimeV1NodeVersionSupported,
} from "../../src/continuation/host-contract.ts";

test("native host contract accepts only the documented Node 22/24 range", () => {
  assert.equal(
    CONTINUATION_RUNTIME_V1_NODE_VERSION_RANGE,
    ">=22.15.0 <23 || >=24.0.0 <25",
  );
  for (const version of ["22.15.0", "22.99.1", "24.0.0", "24.99.99"]) {
    assert.equal(isContinuationRuntimeV1NodeVersionSupported(version), true, version);
  }
  for (const version of [
    "22.14.99", "23.10.0", "25.0.0", "24.0", "024.0.0", "24.0.0-rc.1",
  ]) {
    assert.equal(isContinuationRuntimeV1NodeVersionSupported(version), false, version);
  }
  assert.doesNotThrow(() => assertContinuationRuntimeV1Host("linux", "22.15.0"));
  assert.doesNotThrow(() => assertContinuationRuntimeV1Host("darwin", "24.0.0"));
  assert.throws(
    () => assertContinuationRuntimeV1Host("win32", "24.0.0"),
    /host_platform_unsupported/u,
  );
  assert.throws(
    () => assertContinuationRuntimeV1Host("linux", "23.10.0"),
    /host_node_version_unsupported/u,
  );
});

test("continuation canonical JSON is deterministic and uses UTF-8 key order", () => {
  const first = Object.create(null) as Record<string, unknown>;
  first["中"] = 3;
  first.a = { z: 2, a: 1 };
  first["é"] = [true, null, "value"];

  const second = {
    "é": [true, null, "value"],
    a: { a: 1, z: 2 },
    "中": 3,
  };

  assert.equal(
    canonicalContinuationJson(first),
    "{\"a\":{\"a\":1,\"z\":2},\"é\":[true,null,\"value\"],\"中\":3}",
  );
  assert.equal(canonicalContinuationJson(first), canonicalContinuationJson(second));
  assert.equal(canonicalContinuationSha256(first), canonicalContinuationSha256(second));
  assert.ok(compareCanonicalUtf8("é", "中") < 0);
});

test("continuation canonical sets sort by stable keys and reject duplicates", () => {
  const values = [
    { id: "中", value: 3 },
    { id: "a", value: 1 },
    { id: "é", value: 2 },
  ];
  assert.deepEqual(
    canonicalUniqueSet(values, (value) => value.id).map((value) => value.id),
    ["a", "é", "中"],
  );
  assert.throws(
    () => canonicalUniqueSet([...values, { id: "é", value: 4 }], (value) => value.id),
    /duplicate key/,
  );
});

test("canonical authority clones detach and deeply freeze caller-owned state", () => {
  const source = { z: [{ mutable: true }], a: "authority" };
  const clone = canonicalContinuationClone(source);

  source.z[0]!.mutable = false;
  assert.equal(clone.z[0]!.mutable, true);
  assert.equal(Object.isFrozen(clone), true);
  assert.equal(Object.isFrozen(clone.z), true);
  assert.equal(Object.isFrozen(clone.z[0]), true);
  assert.throws(() => {
    (clone.z[0] as { mutable: boolean }).mutable = false;
  }, TypeError);
});

test("continuation canonical JSON rejects ambiguous or executable values", () => {
  for (const value of [undefined, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, new Date()]) {
    assert.throws(() => canonicalContinuationJson(value));
  }
  assert.throws(() => canonicalContinuationJson({ value: undefined }), /non-JSON value/);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalContinuationJson(cycle), /cycle/);

  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => "must-not-run",
  });
  assert.throws(() => canonicalContinuationJson(accessor), /accessors/);

  const hidden = Object.defineProperty({}, "hidden", { value: true });
  assert.throws(() => canonicalContinuationJson(hidden), /enumerable string keys/);

  const symbol = { value: true } as Record<PropertyKey, unknown>;
  symbol[Symbol("hidden")] = true;
  assert.throws(() => canonicalContinuationJson(symbol), /enumerable string keys/);

  assert.throws(
    () => canonicalContinuationJson(Object.assign(["visible"], { hidden: "authority" })),
    /dense and contain no extra properties/,
  );
  assert.throws(
    () => canonicalContinuationJson([, "sparse"]),
    /dense and contain no extra properties/,
  );
  class ArraySubclass<T> extends Array<T> {}
  assert.throws(
    () => canonicalContinuationJson(new ArraySubclass("subclass")),
    /bounded plain arrays/,
  );
  let arrayGetterExecuted = false;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get: () => {
      arrayGetterExecuted = true;
      return "forged";
    },
  });
  assert.throws(
    () => canonicalContinuationJson(accessorArray),
    /enumerable data elements/,
  );
  assert.equal(arrayGetterExecuted, false);

  assert.throws(
    () => canonicalContinuationJson({ nested: { value: true } }, 0),
    /max depth 0/,
  );
  assert.throws(() => canonicalContinuationJson("\ud800"), /Unicode scalar/);
  assert.throws(() => canonicalContinuationJson({ "\ud801": true }), /Unicode scalar/);
  assert.throws(() => compareCanonicalUtf8("\ud800", "\ud801"), /Unicode scalar/);
});

test("authority digests omit exactly their declared self-digest field", () => {
  const body = {
    schema_version: "example_v1",
    identity: { id: "decision-1" },
    values: [1, 2, 3],
  };
  const digest = canonicalContinuationSha256(body);
  assert.equal(
    canonicalSha256Without({ ...body, contract_sha256: digest }, "contract_sha256"),
    digest,
  );
  assert.throws(
    () => canonicalSha256Without(body, "contract_sha256"),
    /missing digest field/,
  );

  let getterExecuted = false;
  const accessor = Object.defineProperties({}, {
    value: {
      enumerable: true,
      get: () => {
        getterExecuted = true;
        return "forged";
      },
    },
    contract_sha256: { enumerable: true, value: digest },
  });
  assert.throws(() => canonicalSha256Without(accessor, "contract_sha256"), /data properties/);
  assert.equal(getterExecuted, false);

  const hidden = Object.defineProperties({}, {
    value: { enumerable: true, value: "visible" },
    hidden: { enumerable: false, value: "authority" },
    contract_sha256: { enumerable: true, value: digest },
  });
  assert.throws(() => canonicalSha256Without(hidden, "contract_sha256"), /enumerable data properties/);
});

test("authority artifact refs distinguish signed artifact identity from payload identity", () => {
  const reference: AuthorityArtifactRefV1 = {
    artifact_sha256: "a".repeat(64),
    payload_sha256: "b".repeat(64),
  };
  const digest = canonicalContinuationSha256(reference);
  assert.notEqual(
    canonicalContinuationSha256({ ...reference, artifact_sha256: "c".repeat(64) }),
    digest,
  );
  assert.notEqual(
    canonicalContinuationSha256({ ...reference, payload_sha256: "d".repeat(64) }),
    digest,
  );
});

test("continuation identity validators reject non-canonical authority values", () => {
  assert.doesNotThrow(() => assertSha256("a".repeat(64), "contract_sha256"));
  assert.throws(() => assertSha256("A".repeat(64)), /lowercase SHA-256/);
  assert.throws(() => assertSha256("a".repeat(63)), /lowercase SHA-256/);

  assert.doesNotThrow(() => assertCanonicalUtcMillis("2026-07-21T12:34:56.789Z"));
  assert.throws(() => assertCanonicalUtcMillis("2026-07-21T12:34:56Z"), /UTC millisecond/);
  assert.throws(() => assertCanonicalUtcMillis("2026-02-30T12:34:56.789Z"), /UTC millisecond/);
  assert.throws(() => assertCanonicalUtcMillis("2026-07-21T20:34:56.789+08:00"), /UTC millisecond/);
});

test("execution capsule digest binds the immutable capsule body", () => {
  const body = {
    schema_version: "execution_capsule_v1",
    capsule_id: "capsule-1",
    capsule_revision: 1,
    created_at: "2026-07-21T12:00:00.000Z",
    parent_capsule_sha256: null,
    source: {
      memory_id: "memory-1",
      source_commit_id: "commit-1",
      source_projection_sha256: "1".repeat(64),
    },
    kind: "verified_fact",
    proposed_influence: "use",
    applicability: {
      tenant_id: "tenant-1",
      scope: "scope-1",
      task_family: "repair",
      task_signature: "task-signature",
      workflow_signature: null,
      workspace_signature: "workspace-signature",
      producer_agent_id: "agent-1",
      owner_agent_id: null,
      owner_team_id: null,
    },
    projection: {
      summary: "The focused verifier passed on the current workspace revision.",
      next_action: "Continue from the verified boundary.",
      target_refs: [{ kind: "artifact", ref: "src/continuation/contract.ts" }],
      workflow_steps: ["Read the declared target.", "Apply the bounded change."],
      acceptance_statements: ["The declared verifier passes."],
      projection_sha256: "2".repeat(64),
    },
    coverage_claims: [{
      obligation_kind: "required_state",
      target_refs: [{ kind: "artifact", ref: "src/continuation/contract.ts" }],
      evidence_requirement: "runtime_state",
      required_probe_ids: [],
      coverage_claim_sha256: canonicalContinuationSha256({
        obligation_kind: "required_state",
        target_refs: [{ kind: "artifact", ref: "src/continuation/contract.ts" }],
        evidence_requirement: "runtime_state",
        required_probe_ids: [],
      }),
    }],
    precondition_specs: [],
    evidence_refs: ["evidence-1"],
    verifier_refs: ["verifier-1"],
    conflicts_with: [],
    supersedes: [],
    expires_at: null,
  } as const;
  const capsule: ExecutionCapsuleV1 = {
    ...body,
    capsule_sha256: canonicalContinuationSha256(body),
  };

  assert.equal(canonicalSha256Without(capsule, "capsule_sha256"), capsule.capsule_sha256);
  assert.notEqual(
    canonicalContinuationSha256({ ...body, kind: "counter_evidence" }),
    capsule.capsule_sha256,
  );
});
