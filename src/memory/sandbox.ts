import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  recordSandboxRunTelemetryRow,
  sandboxStoreAccessForClient,
} from "../store/sandbox-access.js";
import { HttpError } from "../util/http.js";
import { sha256Text, trimTrailingSlash } from "./sandbox-network.js";
export { SandboxExecutor, parseAllowedSandboxCommands } from "./sandbox-executor.js";
export type { SandboxExecutorConfig } from "./sandbox-executor.js";
import {
  SandboxExecuteRequest,
  SandboxRunArtifactRequest,
  SandboxRunCancelRequest,
  SandboxRunGetRequest,
  SandboxRunLogsRequest,
  SandboxSessionCreateRequest,
} from "./schemas.js";
import type { SandboxDefaults } from "./sandbox-shared.js";
import {
  jsonObject,
  normalizeTimeoutMs,
  tailText,
  toRunPayload,
  trimOrNull,
} from "./sandbox-shared.js";
import { resolveTenantScope } from "./tenant.js";
import { summarizeToolResult } from "./tool-result-summary.js";

export {
  parseCidrRule,
  postJsonWithTls,
  sandboxRemoteEgressAllowed,
  sandboxRemoteHostAllowed,
} from "./sandbox-network.js";

function sandboxRunNotFound(runId: string, tenantId: string, scope: string): never {
  throw new HttpError(404, "sandbox_run_not_found", "sandbox run was not found in this tenant/scope", {
    run_id: runId,
    tenant_id: tenantId,
    scope,
  });
}

export async function createSandboxSession(
  client: pg.PoolClient,
  body: unknown,
  defaults: Omit<SandboxDefaults, "defaultTimeoutMs">,
) {
  const parsed = SandboxSessionCreateRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const expiresAt =
    parsed.ttl_seconds && Number.isFinite(parsed.ttl_seconds)
      ? new Date(Date.now() + parsed.ttl_seconds * 1000).toISOString()
      : null;
  const session = await sandboxStoreAccessForClient(client).createSession({
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    profile: parsed.profile,
    metadataJson: JSON.stringify(jsonObject(parsed.metadata)),
    expiresAt,
  });
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    session: {
      session_id: session.id,
      profile: session.profile,
      metadata: session.metadata ?? {},
      expires_at: session.expires_at,
      created_at: session.created_at,
      updated_at: session.updated_at,
    },
  };
}

export async function enqueueSandboxRun(
  client: pg.PoolClient,
  body: unknown,
  defaults: SandboxDefaults,
) {
  const parsed = SandboxExecuteRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const access = sandboxStoreAccessForClient(client);

  const session = await access.getSessionRef({
    id: parsed.session_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
  });
  if (!session) {
    throw new HttpError(404, "sandbox_session_not_found", "sandbox session was not found in this tenant/scope", {
      session_id: parsed.session_id,
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
    });
  }
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    throw new HttpError(409, "sandbox_session_expired", "sandbox session is expired", {
      session_id: parsed.session_id,
      expires_at: session.expires_at,
    });
  }

  const timeoutMs = normalizeTimeoutMs(parsed.timeout_ms, defaults.defaultTimeoutMs);
  const runId = randomUUID();
  const row = await access.insertRun({
    id: runId,
    sessionId: parsed.session_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    projectId: trimOrNull(parsed.project_id),
    plannerRunId: trimOrNull(parsed.planner_run_id),
    decisionId: parsed.decision_id ?? null,
    actionJson: JSON.stringify({ argv: parsed.action.argv }),
    mode: parsed.mode,
    timeoutMs,
    metadataJson: JSON.stringify(jsonObject(parsed.metadata)),
  });
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    run: toRunPayload(row),
  };
}

export async function getSandboxRun(client: pg.PoolClient, body: unknown, defaults: Omit<SandboxDefaults, "defaultTimeoutMs">) {
  const parsed = SandboxRunGetRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const row = await sandboxStoreAccessForClient(client).getRun({
    id: parsed.run_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
  });
  if (!row) {
    sandboxRunNotFound(parsed.run_id, tenancy.tenant_id, tenancy.scope);
  }
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    run: toRunPayload(row),
  };
}

export async function getSandboxRunLogs(client: pg.PoolClient, body: unknown, defaults: Omit<SandboxDefaults, "defaultTimeoutMs">) {
  const parsed = SandboxRunLogsRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const row = await sandboxStoreAccessForClient(client).getRunLogs({
    id: parsed.run_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
  });
  if (!row) {
    sandboxRunNotFound(parsed.run_id, tenancy.tenant_id, tenancy.scope);
  }
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    run_id: row.id,
    status: row.status,
    logs: {
      tail_bytes: parsed.tail_bytes,
      stdout: tailText(row.stdout_text, parsed.tail_bytes),
      stderr: tailText(row.stderr_text, parsed.tail_bytes),
      truncated: !!row.output_truncated,
      summary: summarizeToolResult({
        stdout: row.stdout_text,
        stderr: row.stderr_text,
        exit_code: null,
        error: null,
        truncated: row.output_truncated,
      }),
    },
  };
}

export async function getSandboxRunArtifact(
  client: pg.PoolClient,
  body: unknown,
  defaults: Omit<SandboxDefaults, "defaultTimeoutMs"> & { artifactObjectStoreBaseUri?: string | null },
) {
  const parsed = SandboxRunArtifactRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const row = await sandboxStoreAccessForClient(client).getRun({
    id: parsed.run_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
  });
  if (!row) {
    sandboxRunNotFound(parsed.run_id, tenancy.tenant_id, tenancy.scope);
  }
  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    artifact: {
      artifact_version: "sandbox_run_artifact_v2",
      run_id: row.id,
      session_id: row.session_id,
      uri: `aionis://${row.tenant_id}/${row.scope}/sandbox_run/${row.id}`,
      project_id: row.project_id ?? null,
      planner_run_id: row.planner_run_id,
      decision_id: row.decision_id,
      mode: row.mode,
      status: row.status,
      timeout_ms: row.timeout_ms,
      action: parsed.include_action
        ? {
            kind: row.action_kind,
            ...(row.action_json ?? {}),
          }
        : undefined,
      output: parsed.include_output
        ? {
            tail_bytes: parsed.tail_bytes,
            stdout: tailText(row.stdout_text, parsed.tail_bytes),
            stderr: tailText(row.stderr_text, parsed.tail_bytes),
            truncated: !!row.output_truncated,
          }
        : undefined,
      summary: summarizeToolResult({
        stdout: row.stdout_text,
        stderr: row.stderr_text,
        result: row.result_json ?? {},
        exit_code: row.exit_code,
        error: row.error,
        truncated: row.output_truncated,
      }),
      exit_code: row.exit_code,
      error: row.error,
      result: parsed.include_result ? row.result_json ?? {} : undefined,
      metadata: parsed.include_metadata ? row.metadata ?? {} : undefined,
      bundle: (() => {
        const bundleBase = trimOrNull(defaults.artifactObjectStoreBaseUri);
        const objectPrefix = `sandbox/${encodeURIComponent(row.tenant_id)}/${encodeURIComponent(row.scope)}/${row.id}`;
        const objectUriFor = (name: string): string | null => {
          if (!bundleBase) return null;
          return `${trimTrailingSlash(bundleBase)}/${objectPrefix}/${name}`;
        };
        const objects: Array<Record<string, unknown>> = [];
        const addObject = (
          name: string,
          mediaType: "application/json" | "text/plain",
          payload: unknown,
        ) => {
          const serialized = mediaType === "text/plain" ? String(payload ?? "") : JSON.stringify(payload ?? {});
          objects.push({
            name,
            media_type: mediaType,
            bytes: Buffer.byteLength(serialized, "utf8"),
            sha256: sha256Text(serialized),
            uri: objectUriFor(name),
            inline: parsed.bundle_inline ? payload : undefined,
          });
        };

        if (parsed.include_action) {
          addObject("action.json", "application/json", {
            kind: row.action_kind,
            ...(row.action_json ?? {}),
          });
        }
        if (parsed.include_output) {
          addObject("output.json", "application/json", {
            tail_bytes: parsed.tail_bytes,
            stdout: tailText(row.stdout_text, parsed.tail_bytes),
            stderr: tailText(row.stderr_text, parsed.tail_bytes),
            truncated: !!row.output_truncated,
          });
        }
        if (parsed.include_result) {
          addObject("result.json", "application/json", row.result_json ?? {});
        }
        addObject(
          "summary.json",
          "application/json",
          summarizeToolResult({
            stdout: row.stdout_text,
            stderr: row.stderr_text,
            result: row.result_json ?? {},
            exit_code: row.exit_code,
            error: row.error,
            truncated: row.output_truncated,
          }),
        );
        if (parsed.include_metadata) {
          addObject("metadata.json", "application/json", row.metadata ?? {});
        }
        addObject("run.json", "application/json", {
          run_id: row.id,
          session_id: row.session_id,
          project_id: row.project_id ?? null,
          tenant_id: row.tenant_id,
          scope: row.scope,
          planner_run_id: row.planner_run_id,
          decision_id: row.decision_id,
          mode: row.mode,
          status: row.status,
          timeout_ms: row.timeout_ms,
          exit_code: row.exit_code,
          error: row.error,
          result_summary: summarizeToolResult({
            stdout: row.stdout_text,
            stderr: row.stderr_text,
            result: row.result_json ?? {},
            exit_code: row.exit_code,
            error: row.error,
            truncated: row.output_truncated,
          }),
          started_at: row.started_at,
          finished_at: row.finished_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        });

        return {
          manifest_version: "sandbox_artifact_bundle_manifest_v1",
          object_store_base_uri: bundleBase ?? null,
          object_prefix: objectPrefix,
          generated_at: new Date().toISOString(),
          objects,
        };
      })(),
      started_at: row.started_at,
      finished_at: row.finished_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export async function cancelSandboxRun(client: pg.PoolClient, body: unknown, defaults: Omit<SandboxDefaults, "defaultTimeoutMs">) {
  const parsed = SandboxRunCancelRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope: defaults.defaultScope, defaultTenantId: defaults.defaultTenantId },
  );
  const reason = trimOrNull(parsed.reason);
  const access = sandboxStoreAccessForClient(client);
  const row = await access.requestCancel({
    id: parsed.run_id,
    tenantId: tenancy.tenant_id,
    scope: tenancy.scope,
    reason,
  });
  if (!row) {
    sandboxRunNotFound(parsed.run_id, tenancy.tenant_id, tenancy.scope);
  }

  if (row.status === "queued") {
    const canceledRow = await access.cancelQueuedRun({ id: parsed.run_id });
    if (canceledRow) {
      row.status = "canceled";
      await recordSandboxRunTelemetryRow(client, canceledRow);
    }
  }

  return {
    tenant_id: tenancy.tenant_id,
    scope: tenancy.scope,
    run_id: row.id,
    status: row.status,
    cancel_requested: row.cancel_requested,
    cancel_reason: row.cancel_reason,
  };
}
