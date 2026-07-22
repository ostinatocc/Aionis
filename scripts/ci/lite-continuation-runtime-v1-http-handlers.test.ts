import assert from "node:assert/strict";
import test from "node:test";

import {
  continuationAuthoritySubjectSha256V1,
} from "../../src/continuation/task-envelope.js";
import type { CanonicalJson } from "../../src/continuation/contract.js";
import { loadContinuationRuntimeV1DaemonConfig } from
  "../../src/runtime-v1/config.js";
import {
  createContinuationRuntimeV1HttpHandlers,
} from "../../src/runtime-v1/http-handlers.js";
import {
  ContinuationRuntimeV1ApplicationError,
  type ContinuationRuntimeV1Application,
} from "../../src/runtime-v1/application.js";
import { createContinuationRuntimeV1HttpServer } from
  "../../src/runtime-v1/http-server.js";

const HOST_TOKEN = "host-runtime-token-abcdefghijklmnopqrstuvwxyz";
const OPERATOR_TOKEN = "operator-runtime-token-abcdefghijklmnopqrstuvwxyz";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const TASK_FAMILY = "repair";

function config() {
  return loadContinuationRuntimeV1DaemonConfig({
    AIONIS_DATA_PATH: "/tmp/aionis-v1/runtime.sqlite",
    AIONIS_TENANT_ID: "tenant-a",
    AIONIS_HOST_PRINCIPAL_ID: "host-a",
    AIONIS_HOST_API_KEY: HOST_TOKEN,
    AIONIS_OPERATOR_PRINCIPAL_ID: "operator-a",
    AIONIS_OPERATOR_API_KEY: OPERATOR_TOKEN,
    AIONIS_TRUST_ROOT_PUBLIC_KEY_PATH: "/tmp/aionis-v1/trust-root.pem",
    AIONIS_TRUST_ROOT_SHA256: "0".repeat(64),
  });
}

function subject(scope = "scope-a") {
  return continuationAuthoritySubjectSha256V1({
    tenant_id: "tenant-a",
    scope,
    task_family: TASK_FAMILY,
  });
}

function observationsBody() {
  return {
    schema_version: "record_observations_body_v1",
    host_task: {
      host_task_id: "task-a",
      episode_id: "episode-a",
      run_id: "run-a",
      consumer_agent_id: "agent-a",
      consumer_team_id: null,
      task_family: TASK_FAMILY,
      task_signature: "task-signature-a",
      workflow_signature: null,
      workspace_signature: "workspace-a",
      source_task_sha256: SHA_A,
      source_event_sha256: SHA_B,
      issued_at: "2026-07-21T10:00:00.000Z",
      expires_at: "2026-07-21T12:00:00.000Z",
    },
    memory_inputs: [],
    collector_observations: [],
    signed_observations: [],
  };
}

function continuationBody() {
  return {
    schema_version: "create_continuation_body_v1",
    world_snapshot_ref: {
      world_snapshot_id: "snapshot-a",
      world_snapshot_sha256: SHA_B,
    },
    obligations: [],
    render_budget_bytes: 4_096,
  };
}

function outcomeBody() {
  return {
    schema_version: "record_outcome_body_v1",
    decision_ref: {
      decision_id: "decision-a",
      contract_sha256: SHA_B,
      exposure_receipt_sha256: SHA_C,
    },
    use_receipt: {
      schema_version: "host_capsule_use_receipt_v1",
      decision_id: "decision-a",
      use_id: "use-a",
      observed_at: "2026-07-21T10:30:00.000Z",
      render_result_sha256: SHA_D,
      capsule_uses: [],
      evidence_sha256: SHA_A,
    },
    outcome_receipt: {
      schema_version: "host_outcome_receipt_v1",
      decision_id: "decision-a",
      observed_at: "2026-07-21T10:31:00.000Z",
      outcome: "succeeded",
      outcome_code: "completed",
      evidence_sha256: SHA_B,
      summary: null,
    },
  };
}

function authorityBody() {
  return {
    schema_version: "authority_decision_body_v1",
    expected_head: { revision: 1, head_sha256: SHA_B },
    decision: {
      kind: "branch_reject",
      candidate: {
        branch_id: "candidate-a",
        branch_revision: 2,
        manifest_sha256: SHA_C,
      },
      reason_codes: ["verified_harm"],
      evidence_sha256s: [SHA_D],
    },
  };
}

type Captured = {
  mutations: string[];
  reads: CanonicalJson[];
  selectors: CanonicalJson[];
};

function application(
  captured: Captured = { mutations: [], reads: [], selectors: [] },
  overrides: Partial<ContinuationRuntimeV1Application> = {},
): ContinuationRuntimeV1Application {
  const base: ContinuationRuntimeV1Application = {
    readiness: () => ({ ready: true, reason_codes: [] }),
    resolveSnapshotBinding: (selector) => {
      captured.selectors.push(selector);
      return {
        tenant_id: selector.principal.tenant_id,
        scope: selector.scope,
        actor_kind: "trusted_host",
        actor_principal_sha256: selector.principal.principal_sha256,
        task_family: TASK_FAMILY,
        authority_subject_sha256: subject(selector.scope),
        world_snapshot_id: selector.world_snapshot_id,
        world_snapshot_sha256: selector.world_snapshot_sha256,
      };
    },
    resolveDecisionBinding: (selector) => {
      captured.selectors.push(selector);
      return {
        tenant_id: selector.principal.tenant_id,
        scope: selector.scope,
        actor_kind: selector.principal.principal_kind,
        actor_principal_sha256: selector.principal.principal_sha256,
        task_family: TASK_FAMILY,
        authority_subject_sha256: subject(selector.scope),
        decision_id: selector.decision_id,
        contract_sha256: SHA_B,
        render_result_sha256: SHA_D,
        exposure_receipt_sha256: SHA_C,
        host_task_envelope_sha256: SHA_A,
      };
    },
    resolveAuthorityBinding: (selector) => {
      captured.selectors.push(selector);
      return {
        tenant_id: selector.principal.tenant_id,
        scope: selector.scope,
        actor_kind: "operator",
        actor_principal_sha256: selector.principal.principal_sha256,
        task_family: selector.task_family,
        authority_subject_sha256: selector.authority_subject_sha256,
      };
    },
    recordObservations: (command) => {
      captured.mutations.push(command.operation_kind);
      return { route_id: "record_observations", operation_id: command.operation_id };
    },
    createContinuation: (command) => {
      captured.mutations.push(command.operation_kind);
      return { route_id: "create_continuation", operation_id: command.operation_id };
    },
    recordOutcome: (command) => {
      captured.mutations.push(command.operation_kind);
      return { route_id: "record_outcome", operation_id: command.operation_id };
    },
    decideAuthority: (command) => {
      captured.mutations.push(command.operation_kind);
      return { route_id: "authority_decision", operation_id: command.operation_id };
    },
    readDecision: (query) => {
      captured.reads.push(query);
      return { route_id: "read_decision", decision_id: query.decision_id };
    },
  };
  return { ...base, ...overrides };
}

function server(app: ContinuationRuntimeV1Application = application()) {
  const value = config();
  return createContinuationRuntimeV1HttpServer({
    bodyLimitBytes: value.httpBodyLimitBytes,
    handlers: createContinuationRuntimeV1HttpHandlers({ application: app, config: value }),
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function mutationEnvelope(operationId: string, body: unknown) {
  return { operation_id: operationId, scope: "scope-a", body };
}

test("the real handler factory dispatches exactly five verified commands plus two probes", async () => {
  const captured: Captured = { mutations: [], reads: [], selectors: [] };
  const runtime = server(application(captured));
  try {
    const health = await runtime.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), {
      schema_version: "continuation_runtime_health_v1",
      status: "alive",
    });
    const ready = await runtime.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, "ready");

    const writes = [
      ["/v1/observations", HOST_TOKEN, mutationEnvelope("observe-a", observationsBody())],
      ["/v1/continuations", HOST_TOKEN, mutationEnvelope("continue-a", continuationBody())],
      ["/v1/outcomes", HOST_TOKEN, mutationEnvelope("outcome-a", outcomeBody())],
      ["/v1/authority-decisions", OPERATOR_TOKEN, {
        operation_id: "authority-a",
        scope: "scope-a",
        task_family: TASK_FAMILY,
        body: authorityBody(),
      }],
    ] as const;
    for (const [url, token, payload] of writes) {
      const response = await runtime.inject({
        method: "POST",
        url,
        headers: bearer(token),
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const read = await runtime.inject({
      method: "GET",
      url: "/v1/decisions/decision-a?scope=scope-a&view=summary",
      headers: bearer(HOST_TOKEN),
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(captured.mutations, [
      "record_observations",
      "create_continuation",
      "record_outcome",
      "authority_decision",
    ]);
    assert.equal(captured.reads.length, 1);
    assert.equal((captured.reads[0] as { decision_id: string }).decision_id, "decision-a");
    assert.equal(captured.selectors.length, 4);
  } finally {
    await runtime.close();
  }
});

test("host and operator credentials are exact per route and counterfactual is operator-only", async () => {
  const runtime = server();
  try {
    for (const request of [
      {
        method: "POST" as const,
        url: "/v1/observations",
        headers: bearer(OPERATOR_TOKEN),
        payload: mutationEnvelope("wrong-role-a", observationsBody()),
      },
      {
        method: "POST" as const,
        url: "/v1/authority-decisions",
        headers: bearer(HOST_TOKEN),
        payload: {
          operation_id: "wrong-role-b",
          scope: "scope-a",
          task_family: TASK_FAMILY,
          body: authorityBody(),
        },
      },
      {
        method: "POST" as const,
        url: "/v1/outcomes",
        headers: {},
        payload: mutationEnvelope("missing-auth", outcomeBody()),
      },
    ]) {
      const response = await runtime.inject(request);
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.json().error.code, "unauthorized");
      assert.equal(response.json().error.operation_id, null);
    }
    const operatorRead = await runtime.inject({
      method: "GET",
      url: "/v1/decisions/decision-a?scope=scope-a&view=full",
      headers: bearer(OPERATOR_TOKEN),
    });
    assert.equal(operatorRead.statusCode, 200, operatorRead.body);
    const forbidden = await runtime.inject({
      method: "GET",
      url: "/v1/decisions/decision-a?scope=scope-a&view=counterfactual",
      headers: bearer(HOST_TOKEN),
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(forbidden.json().error.code, "forbidden");
  } finally {
    await runtime.close();
  }
});

test("transport envelope, command body, path, and flat query are all closed", async () => {
  const runtime = server();
  try {
    const attempts = [
      await runtime.inject({
        method: "POST",
        url: "/v1/observations",
        headers: bearer(HOST_TOKEN),
        payload: { ...mutationEnvelope("extra-outer", observationsBody()), extra: true },
      }),
      await runtime.inject({
        method: "POST",
        url: "/v1/observations",
        headers: bearer(HOST_TOKEN),
        payload: mutationEnvelope("extra-inner", { ...observationsBody(), extra: true }),
      }),
      await runtime.inject({
        method: "POST",
        url: "/v1/authority-decisions",
        headers: bearer(OPERATOR_TOKEN),
        payload: mutationEnvelope("missing-task-family", authorityBody()),
      }),
      await runtime.inject({
        method: "GET",
        url: `/v1/decisions/decision-a?scope=scope-a&view=counterfactual&exclude_capsule_id=cap-a&exclude_capsule_revision=1`,
        headers: bearer(OPERATOR_TOKEN),
      }),
      await runtime.inject({
        method: "GET",
        url: "/v1/decisions/decision-a?scope=scope-a&view=summary&exclude_capsule%5Bcapsule_id%5D=cap-a",
        headers: bearer(OPERATOR_TOKEN),
      }),
      await runtime.inject({
        method: "GET",
        url: "/v1/decisions/%20?scope=scope-a&view=summary",
        headers: bearer(HOST_TOKEN),
      }),
    ];
    for (const response of attempts) {
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, "invalid_request");
    }
    const pollution = await runtime.inject({
      method: "GET",
      url: "/v1/decisions/decision-a?scope=scope-a&view=summary&__proto__%5Bpolluted%5D=yes",
      headers: bearer(HOST_TOKEN),
    });
    assert.equal(pollution.statusCode, 400, pollution.body);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  } finally {
    await runtime.close();
  }
});

test("only Fastify's exact empty safe prototype is accepted for params and query", async () => {
  const value = config();
  const handlers = createContinuationRuntimeV1HttpHandlers({
    application: application(),
    config: value,
  });
  const inheritedPrototype = Object.create(null) as Record<string, unknown>;
  inheritedPrototype.inherited = "forbidden";
  const params = Object.create(inheritedPrototype) as Record<string, unknown>;
  params.decision_id = "decision-a";
  let statusCode = 0;
  let responseBody: unknown;
  const reply = {
    code(valueToSet: number) {
      statusCode = valueToSet;
      return this;
    },
    header() { return this; },
    send(valueToSend: unknown) {
      responseBody = valueToSend;
      return this;
    },
  };
  await handlers.read_decision.call(null as never, {
    headers: bearer(HOST_TOKEN),
    params,
    query: { scope: "scope-a", view: "summary" },
    log: { error() {} },
  } as never, reply as never);
  assert.equal(statusCode, 400);
  assert.equal(
    (responseBody as { error: { code: string } }).error.code,
    "invalid_request",
  );

  const inheritedApplication = Object.create(application()) as
    ContinuationRuntimeV1Application;
  assert.throws(
    () => createContinuationRuntimeV1HttpHandlers({
      application: inheritedApplication,
      config: value,
    }),
    /http_transport_application_invalid/u,
  );
});

test("flat counterfactual triples reconstruct the exact nested decision query", async () => {
  const captured: Captured = { mutations: [], reads: [], selectors: [] };
  const runtime = server(application(captured));
  try {
    const params = new URLSearchParams({
      scope: "scope-a",
      view: "counterfactual",
      exclude_capsule_id: "capsule-a",
      exclude_capsule_revision: "3",
      exclude_capsule_sha256: SHA_A,
      substitute_branch_id: "candidate-a",
      substitute_branch_revision: "2",
      substitute_manifest_sha256: SHA_C,
    });
    const response = await runtime.inject({
      method: "GET",
      url: `/v1/decisions/decision-a?${params.toString()}`,
      headers: bearer(OPERATOR_TOKEN),
    });
    assert.equal(response.statusCode, 200, response.body);
    const query = captured.reads[0] as {
      body: {
        exclude_capsule: unknown;
        substitute_branch: unknown;
      };
    };
    assert.deepEqual(query.body.exclude_capsule, {
      capsule_id: "capsule-a",
      capsule_revision: 3,
      capsule_sha256: SHA_A,
    });
    assert.deepEqual(query.body.substitute_branch, {
      branch_id: "candidate-a",
      branch_revision: 2,
      manifest_sha256: SHA_C,
    });
  } finally {
    await runtime.close();
  }
});

test("stable errors echo only caller request ID and a verified transport operation ID", async () => {
  const conflict = application(undefined, {
    recordObservations: () => {
      throw new ContinuationRuntimeV1ApplicationError(409, "operation_conflict");
    },
  });
  const runtime = server(conflict);
  try {
    const response = await runtime.inject({
      method: "POST",
      url: "/v1/observations",
      headers: {
        ...bearer(HOST_TOKEN),
        "x-request-id": "caller-request-a",
      },
      payload: mutationEnvelope("conflict-operation-a", observationsBody()),
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.headers["x-request-id"], "caller-request-a");
    assert.deepEqual(response.json(), {
      schema_version: "continuation_runtime_http_error_v1",
      error: {
        code: "operation_conflict",
        operation_id: "conflict-operation-a",
        request_id: "caller-request-a",
      },
    });
  } finally {
    await runtime.close();
  }
});

test("parser, unknown application, and not-found errors share the non-leaking envelope", async () => {
  const broken = server(application(undefined, {
    recordObservations: () => {
      throw new Error("database secret must never cross HTTP");
    },
  }));
  try {
    const internal = await broken.inject({
      method: "POST",
      url: "/v1/observations",
      headers: bearer(HOST_TOKEN),
      payload: mutationEnvelope("internal-a", observationsBody()),
    });
    assert.equal(internal.statusCode, 500, internal.body);
    assert.equal(internal.json().error.code, "internal_error");
    assert.equal(internal.body.includes("database secret"), false);

    const malformed = await broken.inject({
      method: "POST",
      url: "/v1/observations",
      headers: { ...bearer(HOST_TOKEN), "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.deepEqual(malformed.json().error, {
      code: "invalid_request",
      operation_id: null,
      request_id: null,
    });

    const oldRoute = await broken.inject({ method: "POST", url: "/v1/observe" });
    assert.equal(oldRoute.statusCode, 404, oldRoute.body);
    assert.equal(oldRoute.json().error.code, "not_found");
    assert.equal(oldRoute.json().error.operation_id, null);
  } finally {
    await broken.close();
  }
});

test("Fastify body-limit and media-type failures also use the stable envelope", async () => {
  const value = config();
  const runtime = createContinuationRuntimeV1HttpServer({
    bodyLimitBytes: 16_384,
    handlers: createContinuationRuntimeV1HttpHandlers({
      application: application(),
      config: value,
    }),
  });
  try {
    const oversized = await runtime.inject({
      method: "POST",
      url: "/v1/observations",
      headers: {
        ...bearer(HOST_TOKEN),
        "x-request-id": "invalid request id",
      },
      payload: { padding: "x".repeat(20_000) },
    });
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.deepEqual(oversized.json().error, {
      code: "payload_too_large",
      operation_id: null,
      request_id: null,
    });
    assert.equal(oversized.headers["x-request-id"], undefined);

    const unsupported = await runtime.inject({
      method: "POST",
      url: "/v1/observations",
      headers: {
        ...bearer(HOST_TOKEN),
        "content-type": "application/xml",
      },
      payload: "<request />",
    });
    assert.equal(unsupported.statusCode, 415, unsupported.body);
    assert.equal(unsupported.json().error.code, "unsupported_media_type");
  } finally {
    await runtime.close();
  }
});

test("readiness is dependency-owned and failure is a closed 503", async () => {
  for (const [app, expectedReason] of [
    [application(undefined, {
      readiness: () => ({ ready: false, reason_codes: ["policy_unavailable"] }),
    }), "policy_unavailable"],
    [application(undefined, {
      readiness: () => { throw new Error("readiness backend failed"); },
    }), "readiness_check_failed"],
    [application(undefined, {
      readiness: () => ({ ready: true, reason_codes: ["contradictory"] }),
    }), "readiness_check_failed"],
    [application(undefined, {
      readiness: () => ({ ready: false, reason_codes: [] }),
    }), "readiness_check_failed"],
  ] as const) {
    const runtime = server(app);
    try {
      const response = await runtime.inject({ method: "GET", url: "/readyz" });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(response.json().status, "not_ready");
      assert.deepEqual(response.json().reason_codes, [expectedReason]);
    } finally {
      await runtime.close();
    }
  }
});

test("a resolver cannot substitute another authenticated principal", async () => {
  const runtime = server(application(undefined, {
    resolveSnapshotBinding: (selector) => ({
      tenant_id: selector.principal.tenant_id,
      scope: selector.scope,
      actor_kind: "trusted_host",
      actor_principal_sha256: SHA_A,
      task_family: TASK_FAMILY,
      authority_subject_sha256: subject(selector.scope),
      world_snapshot_id: selector.world_snapshot_id,
      world_snapshot_sha256: selector.world_snapshot_sha256,
    }),
  }));
  try {
    const response = await runtime.inject({
      method: "POST",
      url: "/v1/continuations",
      headers: bearer(HOST_TOKEN),
      payload: mutationEnvelope("binding-substitution", continuationBody()),
    });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error.code, "internal_error");
  } finally {
    await runtime.close();
  }
});
