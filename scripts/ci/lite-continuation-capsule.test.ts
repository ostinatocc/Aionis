import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionCapsuleV1,
  type ExecutionCapsuleDraftV1,
} from "../../src/continuation/capsule.js";
import { canonicalSha256Without, type CapsuleRefV1 } from "../../src/continuation/contract.js";
import { assertExecutionCapsuleV1 } from "../../src/continuation/validation.js";

const DIGEST = "a".repeat(64);
const CONFLICT_A: CapsuleRefV1 = {
  capsule_id: "capsule-a",
  capsule_revision: 1,
  capsule_sha256: "b".repeat(64),
};
const CONFLICT_B: CapsuleRefV1 = {
  capsule_id: "capsule-b",
  capsule_revision: 2,
  capsule_sha256: "c".repeat(64),
};

function draft(overrides: Partial<ExecutionCapsuleDraftV1> = {}): ExecutionCapsuleDraftV1 {
  return {
    capsule_id: "capsule-main",
    created_at: "2026-07-21T10:00:00.000Z",
    kind: "procedure",
    proposed_influence: "use",
    applicability: {
      task_family: "coding",
      task_signature: "typescript",
      workflow_signature: null,
      workspace_signature: "workspace-a",
      producer_agent_id: "agent-a",
      owner_agent_id: null,
      owner_team_id: null,
    },
    projection: {
      summary: "Preserve the verified transaction boundary.",
      next_action: "Run the focused verifier.",
      target_refs: [
        { kind: "artifact", ref: "src/store/runtime.ts" },
        { kind: "capability", ref: "node:test" },
      ],
      workflow_steps: ["Patch the authority path.", "Run the verifier."],
      acceptance_statements: ["The exact focused test passes."],
    },
    coverage_claims: [
      {
        obligation_kind: "required_state",
        target_refs: [{ kind: "artifact", ref: "src/store/runtime.ts" }],
        evidence_requirement: "runtime_state",
        required_probe_ids: [],
      },
      {
        obligation_kind: "verification",
        target_refs: [{ kind: "capability", ref: "node:test" }],
        evidence_requirement: "runtime_state",
        required_probe_ids: [],
      },
    ],
    precondition_specs: [],
    evidence_refs: ["evidence-b", "evidence-a"],
    verifier_refs: ["verifier-b", "verifier-a"],
    conflicts_with: [CONFLICT_B, CONFLICT_A],
    supersedes: [],
    expires_at: null,
    ...overrides,
  };
}

function build(value: ExecutionCapsuleDraftV1 = draft()) {
  return buildExecutionCapsuleV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    capsule_revision: 1,
    parent_capsule_sha256: null,
    source: {
      memory_id: "memory-a",
      source_commit_id: "commit-a",
      source_projection_sha256: DIGEST,
    },
    draft: value,
  });
}

test("capsule builder canonicalizes set-like inputs and produces self-verifying digests", () => {
  const first = build();
  const second = build(draft({
    projection: {
      ...draft().projection,
      target_refs: [...draft().projection.target_refs].reverse(),
    },
    coverage_claims: [...draft().coverage_claims].reverse(),
    evidence_refs: [...draft().evidence_refs].reverse(),
    verifier_refs: [...draft().verifier_refs].reverse(),
    conflicts_with: [...draft().conflicts_with].reverse(),
  }));

  assert.deepEqual(second, first);
  assert.equal(
    canonicalSha256Without(first.projection, "projection_sha256"),
    first.projection.projection_sha256,
  );
  assert.equal(canonicalSha256Without(first, "capsule_sha256"), first.capsule_sha256);
  assert.doesNotThrow(() => assertExecutionCapsuleV1(first));
});

test("ordered workflow semantics remain digest-significant", () => {
  const first = build();
  const reordered = build(draft({
    projection: {
      ...draft().projection,
      workflow_steps: [...draft().projection.workflow_steps].reverse(),
    },
  }));
  assert.notEqual(reordered.projection.projection_sha256, first.projection.projection_sha256);
  assert.notEqual(reordered.capsule_sha256, first.capsule_sha256);
});

test("capsules detach caller objects and canonicalize nested set semantics", () => {
  const capability = {
    kind: "capability" as const,
    probe_id: "capability-current",
    required_for: "before_action" as const,
    observer: "trusted_host_collector" as const,
    max_age_ms: 60_000,
    on_unknown: "block" as const,
    on_unsatisfied: "quarantine" as const,
    capability_id: "node",
    expected_version: "24",
    expected_presence: "present" as const,
  };
  const artifact = {
    kind: "artifact" as const,
    probe_id: "artifact-current",
    required_for: "before_action" as const,
    observer: "trusted_host_collector" as const,
    max_age_ms: 60_000,
    on_unknown: "inspect" as const,
    on_unsatisfied: "block" as const,
    workspace_id: "workspace-a",
    relative_path: "package.json",
    expected_presence: "present" as const,
    expected_kind: "file" as const,
    expected_content_sha256: null,
  };
  const source = draft({ precondition_specs: [capability, artifact] });
  const capsule = build(source);
  const reordered = build(draft({
    precondition_specs: [artifact, capability],
  }));

  assert.deepEqual(capsule, reordered);
  assert.deepEqual(capsule.precondition_specs.map((item) => item.probe_id), [
    "artifact-current",
    "capability-current",
  ]);
  (source.projection.target_refs[0] as { ref: string }).ref = "caller-mutated";
  assert.equal(capsule.projection.target_refs[0]?.ref, "src/store/runtime.ts");
  assert.equal(Object.isFrozen(capsule), true);
  assert.equal(Object.isFrozen(capsule.projection.target_refs[0]), true);
});

test("capsule builder rejects unsafe influence and incoherent authority references", () => {
  assert.throws(
    () => build(draft({ kind: "counter_evidence", proposed_influence: "use" })),
    /counter-evidence cannot propose direct use/u,
  );
  assert.throws(
    () => build(draft({
      conflicts_with: [{
        capsule_id: "capsule-main",
        capsule_revision: 1,
        capsule_sha256: "d".repeat(64),
      }],
    })),
    /cannot conflict with or supersede itself/u,
  );
  assert.throws(
    () => build(draft({ conflicts_with: [CONFLICT_A], supersedes: [CONFLICT_A] })),
    /both a conflict and a supersession/u,
  );
  assert.throws(
    () => buildExecutionCapsuleV1({
      tenant_id: "tenant-a",
      scope: "scope-a",
      capsule_revision: 2,
      parent_capsule_sha256: null,
      source: {
        memory_id: "memory-a",
        source_commit_id: "commit-a",
        source_projection_sha256: DIGEST,
      },
      draft: draft(),
    }),
    /requires a parent digest/u,
  );
});

test("capsule builder rejects duplicate or non-canonical text before hashing", () => {
  assert.throws(
    () => build(draft({ evidence_refs: ["same", "same"] })),
    /duplicate key/u,
  );
  assert.throws(
    () => build(draft({ capsule_id: " capsule-main" })),
    /canonical text/u,
  );
  assert.throws(
    () => build(draft({
      projection: { ...draft().projection, summary: "x".repeat(2_049) },
    })),
    /bounded to 2048/u,
  );
});
