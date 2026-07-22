import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostTaskEnvelopeV1,
  continuationAuthoritySubjectSha256V1,
  verifyHostTaskEnvelopeV1,
  type HostTaskEnvelopeInputV1,
  type AuthenticatedTaskDomainV1,
} from "../../src/continuation/task-envelope.js";

function input(): HostTaskEnvelopeInputV1 {
  return {
    host_task_id: "task-1",
    episode_id: "episode-1",
    run_id: "run-1",
    consumer_agent_id: "agent-1",
    consumer_team_id: "team-1",
    task_family: "repository-repair",
    task_signature: "fix-transaction-boundary",
    workflow_signature: "code-test-review",
    workspace_signature: "workspace-tree-a",
    source_task_sha256: "a".repeat(64),
    source_event_sha256: "b".repeat(64),
    issued_at: "2026-07-21T10:00:00.000Z",
    expires_at: "2026-07-21T10:30:00.000Z",
  };
}

function domain(overrides: Partial<AuthenticatedTaskDomainV1> = {}): AuthenticatedTaskDomainV1 {
  const tenant_id = overrides.tenant_id ?? "tenant-1";
  const scope = overrides.scope ?? "scope-1";
  return {
    tenant_id,
    scope,
    authority_subject_sha256: overrides.authority_subject_sha256
      ?? continuationAuthoritySubjectSha256V1({
        tenant_id,
        scope,
        task_family: input().task_family,
      }),
  };
}

test("host task envelopes are deterministic, detached, frozen, and self-verifying", () => {
  const source = input();
  const first = buildHostTaskEnvelopeV1(source, domain());
  const second = buildHostTaskEnvelopeV1({ ...source }, domain());
  assert.deepEqual(second, first);
  assert.deepEqual(verifyHostTaskEnvelopeV1(first), first);
  (source as { task_family: string }).task_family = "caller-mutated";
  assert.equal(first.task_family, "repository-repair");
  assert.equal(Object.isFrozen(first), true);
});

test("host task envelopes reject unknown fields, ambiguous text, bad time, and digest tampering", () => {
  assert.throws(() => buildHostTaskEnvelopeV1(
    { ...input(), unknown: true } as never,
    domain(),
  ), /unknown or missing/u);
  assert.throws(() => buildHostTaskEnvelopeV1(
    { ...input(), task_family: " bad" },
    domain(),
  ), /canonical UTF-8/u);
  assert.throws(() => buildHostTaskEnvelopeV1(
    { ...input(), task_family: "bad\nfamily" },
    domain(),
  ), /canonical UTF-8/u);
  assert.throws(() => buildHostTaskEnvelopeV1({
    ...input(), expires_at: "2026-07-21T09:59:59.999Z",
  }, domain()), /later than issued_at/u);
  assert.throws(() => buildHostTaskEnvelopeV1({
    ...input(), expires_at: "2026-07-22T10:00:00.001Z",
  }, domain()), /at most 24 hours later/u);
  assert.throws(() => verifyHostTaskEnvelopeV1({
    ...buildHostTaskEnvelopeV1(input(), domain()), source_event_sha256: "c".repeat(64),
  }), /digest is invalid/u);
  assert.throws(() => buildHostTaskEnvelopeV1(Object.defineProperty(input(), "hidden", {
    value: "authority", enumerable: false,
  }) as never, domain()), /unknown or missing/u);
  let getterCalled = false;
  const accessor = Object.defineProperty({ ...input() }, "task_family", {
    enumerable: true,
    get: () => {
      getterCalled = true;
      return "must-not-run";
    },
  });
  assert.throws(() => buildHostTaskEnvelopeV1(accessor as never, domain()), /data properties/u);
  assert.equal(getterCalled, false);
  assert.throws(() => buildHostTaskEnvelopeV1(input(), {
    ...domain(),
    authority_subject_sha256: "f".repeat(64),
  }), /authority subject does not match/u);
  assert.throws(() => buildHostTaskEnvelopeV1({
    ...input(),
    tenant_id: "body-tenant",
  } as never, domain()), /unknown or missing/u);
});

test("Runtime derives coarse authority subjects without caller-selected branch identity", () => {
  const first = continuationAuthoritySubjectSha256V1({
    tenant_id: "tenant-1", scope: "scope-1", task_family: "repository-repair",
  });
  assert.equal(first, continuationAuthoritySubjectSha256V1({
    task_family: "repository-repair", scope: "scope-1", tenant_id: "tenant-1",
  }));
  assert.notEqual(first, continuationAuthoritySubjectSha256V1({
    tenant_id: "tenant-1", scope: "scope-1", task_family: "deployment",
  }));
  assert.notEqual(first, continuationAuthoritySubjectSha256V1({
    tenant_id: "tenant-1", scope: "scope-2", task_family: "repository-repair",
  }));
});
