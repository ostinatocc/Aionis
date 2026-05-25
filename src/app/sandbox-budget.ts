import type { Env } from "../config.js";
import type { Db } from "../db.js";
import { assertEmbeddingSurfaceForbidden } from "../embeddings/surface-policy.js";
import { sandboxStoreAccessForClient, type SandboxBudgetUsage, type SandboxBudgetUsageArgs } from "../store/sandbox-access.js";
import { HttpError } from "../util/http.js";
import { sanitizeBudgetCap, type SandboxTenantBudgetPolicy } from "./runtime-services.js";

type ResolvedSandboxTenantBudget = {
  policy: SandboxTenantBudgetPolicy;
  scope_filter: string | null;
  project_filter: string | null;
  source:
    | "db_project_exact"
    | "db_project_default"
    | "db_project_global_scope"
    | "db_project_global_default"
    | "db_exact"
    | "db_tenant_default"
    | "db_global_scope"
    | "db_global_default"
    | "env_tenant_default"
    | "env_global_default";
};

type SandboxBudgetUsageStore = {
  withClient<T>(fn: (client: any) => Promise<T>): Promise<T>;
};

function normalizeScope(scopeRaw: string | null | undefined): string {
  const scope = String(scopeRaw ?? "").trim();
  return scope.length > 0 ? scope : "*";
}

function resolveProjectId(projectRaw: string | null | undefined): string {
  const projectId = String(projectRaw ?? "").trim();
  return projectId.length > 0 ? projectId : "*";
}

async function resolveSandboxTenantBudget(args: {
  env: Env;
  db: Db;
  sandboxTenantBudgetPolicy: Map<string, SandboxTenantBudgetPolicy>;
  tenantIdRaw: string;
  scopeRaw: string;
  projectIdRaw?: string | null;
}): Promise<ResolvedSandboxTenantBudget | null> {
  const { env, db, sandboxTenantBudgetPolicy, tenantIdRaw, scopeRaw, projectIdRaw } = args;
  const tenantId = String(tenantIdRaw ?? "").trim() || env.MEMORY_TENANT_ID;
  const scope = String(scopeRaw ?? "").trim() || env.MEMORY_SCOPE;
  const projectId = String(projectIdRaw ?? "").trim();

  if (projectId) {
    try {
      const out = await db.pool.query<{
        tenant_id: string;
        project_id: string;
        scope: string;
        daily_run_cap: number | null;
        daily_timeout_cap: number | null;
        daily_failure_cap: number | null;
      }>(
        `
        SELECT
          tenant_id,
          project_id,
          scope,
          daily_run_cap,
          daily_timeout_cap,
          daily_failure_cap
        FROM memory_sandbox_project_budget_profiles
        WHERE
          (tenant_id = $1 AND project_id = $2 AND scope = $3)
          OR (tenant_id = $1 AND project_id = $2 AND scope = '*')
          OR (tenant_id = '*' AND project_id = $2 AND scope = $3)
          OR (tenant_id = '*' AND project_id = $2 AND scope = '*')
          OR (tenant_id = $1 AND project_id = '*' AND scope = $3)
          OR (tenant_id = $1 AND project_id = '*' AND scope = '*')
          OR (tenant_id = '*' AND project_id = '*' AND scope = $3)
          OR (tenant_id = '*' AND project_id = '*' AND scope = '*')
        ORDER BY
          CASE
            WHEN tenant_id = $1 AND project_id = $2 AND scope = $3 THEN 1
            WHEN tenant_id = $1 AND project_id = $2 AND scope = '*' THEN 2
            WHEN tenant_id = '*' AND project_id = $2 AND scope = $3 THEN 3
            WHEN tenant_id = '*' AND project_id = $2 AND scope = '*' THEN 4
            WHEN tenant_id = $1 AND project_id = '*' AND scope = $3 THEN 5
            WHEN tenant_id = $1 AND project_id = '*' AND scope = '*' THEN 6
            WHEN tenant_id = '*' AND project_id = '*' AND scope = $3 THEN 7
            ELSE 8
          END
        LIMIT 1
        `,
        [tenantId, projectId, scope],
      );
      const row = out.rows[0] ?? null;
      if (row) {
        return {
          policy: {
            daily_run_cap: sanitizeBudgetCap(row.daily_run_cap),
            daily_timeout_cap: sanitizeBudgetCap(row.daily_timeout_cap),
            daily_failure_cap: sanitizeBudgetCap(row.daily_failure_cap),
          },
          scope_filter: row.scope === "*" ? null : row.scope,
          project_filter: row.project_id === "*" ? null : row.project_id,
          source:
            row.tenant_id === tenantId && row.project_id === projectId && row.scope === scope
              ? "db_project_exact"
              : row.tenant_id === tenantId && row.project_id === projectId && row.scope === "*"
                ? "db_project_default"
                : row.tenant_id === "*" && row.project_id === projectId && row.scope === scope
                  ? "db_project_global_scope"
                  : "db_project_global_default",
        };
      }
    } catch (err: any) {
      if (String(err?.code ?? "") !== "42P01") throw err;
    }
  }

  try {
    const out = await db.pool.query<{
      tenant_id: string;
      scope: string;
      daily_run_cap: number | null;
      daily_timeout_cap: number | null;
      daily_failure_cap: number | null;
    }>(
      `
      SELECT
        tenant_id,
        scope,
        daily_run_cap,
        daily_timeout_cap,
        daily_failure_cap
      FROM memory_sandbox_budget_profiles
      WHERE
        (tenant_id = $1 AND scope = $2)
        OR (tenant_id = $1 AND scope = '*')
        OR (tenant_id = '*' AND scope = $2)
        OR (tenant_id = '*' AND scope = '*')
      ORDER BY
        CASE
          WHEN tenant_id = $1 AND scope = $2 THEN 1
          WHEN tenant_id = $1 AND scope = '*' THEN 2
          WHEN tenant_id = '*' AND scope = $2 THEN 3
          ELSE 4
        END
      LIMIT 1
      `,
      [tenantId, scope],
    );
    const row = out.rows[0] ?? null;
    if (row) {
      return {
        policy: {
          daily_run_cap: sanitizeBudgetCap(row.daily_run_cap),
          daily_timeout_cap: sanitizeBudgetCap(row.daily_timeout_cap),
          daily_failure_cap: sanitizeBudgetCap(row.daily_failure_cap),
        },
        scope_filter: row.scope === "*" ? null : row.scope,
        project_filter: null,
        source:
          row.tenant_id === tenantId && row.scope === scope
            ? "db_exact"
            : row.tenant_id === tenantId && row.scope === "*"
              ? "db_tenant_default"
              : row.tenant_id === "*" && row.scope === scope
                ? "db_global_scope"
                : "db_global_default",
      };
    }
  } catch (err: any) {
    if (String(err?.code ?? "") !== "42P01") throw err;
  }

  if (sandboxTenantBudgetPolicy.size === 0) return null;
  const tenantPolicy = sandboxTenantBudgetPolicy.get(tenantId);
  if (tenantPolicy) {
    return {
      policy: tenantPolicy,
      scope_filter: null,
      project_filter: null,
      source: "env_tenant_default",
    };
  }
  const globalPolicy = sandboxTenantBudgetPolicy.get("*");
  if (globalPolicy) {
    return {
      policy: globalPolicy,
      scope_filter: null,
      project_filter: null,
      source: "env_global_default",
    };
  }
  return null;
}

async function readSandboxBudgetUsage(
  client: any,
  args: SandboxBudgetUsageArgs,
): Promise<SandboxBudgetUsage> {
  return await sandboxStoreAccessForClient(client).readBudgetUsage(args);
}

export function createSandboxBudgetService(args: {
  env: Env;
  db: Db;
  sandboxTenantBudgetPolicy: Map<string, SandboxTenantBudgetPolicy>;
  usageStore?: SandboxBudgetUsageStore | null;
}) {
  const { env, db, sandboxTenantBudgetPolicy, usageStore } = args;

  const enforceSandboxTenantBudget = async (
    reply: any,
    tenantIdRaw: string,
    scopeRaw: string,
    projectIdRaw?: string | null,
  ): Promise<void> => {
    assertEmbeddingSurfaceForbidden("sandbox_budget_gate");
    const resolved = await resolveSandboxTenantBudget({
      env,
      db,
      sandboxTenantBudgetPolicy,
      tenantIdRaw,
      scopeRaw,
      projectIdRaw,
    });
    if (!resolved) return;

    const tenantId = String(tenantIdRaw ?? "").trim() || env.MEMORY_TENANT_ID;
    const scope = String(scopeRaw ?? "").trim() || env.MEMORY_SCOPE;
    const projectId = String(projectIdRaw ?? "").trim() || null;
    const windowHours = env.SANDBOX_TENANT_BUDGET_WINDOW_HOURS;
    const policy = resolved.policy;

    let usage: SandboxBudgetUsage;
    try {
      const readArgs = {
        tenantId,
        windowHours,
        scopeFilter: resolved.scope_filter,
        projectFilter: resolved.project_filter,
      };
      usage = usageStore
        ? await usageStore.withClient((client) => readSandboxBudgetUsage(client, readArgs))
        : await readSandboxBudgetUsage(db.pool, readArgs);
    } catch (err: any) {
      const code = String(err?.code ?? "");
      if (code === "42P01" || code === "42703") {
        throw new HttpError(503, "sandbox_budget_unavailable", "sandbox budget table is unavailable", {
          tenant_id: tenantId,
          table: "memory_sandbox_runs",
        });
      }
      throw err;
    }

    const raise = (code: string, metric: "total_runs" | "timeout_runs" | "failed_runs", cap: number) => {
      reply.header("retry-after", "60");
      throw new HttpError(429, code, "sandbox tenant budget exceeded; retry later", {
        tenant_id: tenantId,
        project_id: projectId,
        metric,
        used: usage[metric],
        cap,
        window_hours: windowHours,
        scope,
        scope_filter: resolved.scope_filter,
        project_filter: resolved.project_filter,
        policy_source: resolved.source,
      });
    };

    const projectScoped = resolved.source.startsWith("db_project_");
    if (policy.daily_run_cap && usage.total_runs >= policy.daily_run_cap) {
      raise(
        projectScoped ? "sandbox_project_budget_run_cap_exceeded" : "sandbox_tenant_budget_run_cap_exceeded",
        "total_runs",
        policy.daily_run_cap,
      );
    }
    if (policy.daily_timeout_cap && usage.timeout_runs >= policy.daily_timeout_cap) {
      raise(
        projectScoped ? "sandbox_project_budget_timeout_cap_exceeded" : "sandbox_tenant_budget_timeout_cap_exceeded",
        "timeout_runs",
        policy.daily_timeout_cap,
      );
    }
    if (policy.daily_failure_cap && usage.failed_runs >= policy.daily_failure_cap) {
      raise(
        projectScoped ? "sandbox_project_budget_failure_cap_exceeded" : "sandbox_tenant_budget_failure_cap_exceeded",
        "failed_runs",
        policy.daily_failure_cap,
      );
    }
  };

  return {
    enforceSandboxTenantBudget,
  };
}
