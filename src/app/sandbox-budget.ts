import type { Env } from "../config.js";
import { assertEmbeddingSurfaceForbidden } from "../embeddings/surface-policy.js";
import type {
  SandboxBudgetUsage,
  SandboxBudgetUsageArgs,
  SandboxStore,
  SandboxStoreAccess,
} from "../store/sandbox-access.js";
import { HttpError } from "../util/http.js";
import { sanitizeBudgetCap, type SandboxTenantBudgetPolicy } from "./runtime-services.js";

type ResolvedSandboxTenantBudget = {
  policy: SandboxTenantBudgetPolicy;
  scope_filter: string | null;
  project_filter: string | null;
  source: "env_tenant_default" | "env_global_default";
};

async function resolveSandboxTenantBudget(args: {
  env: Env;
  sandboxTenantBudgetPolicy: Map<string, SandboxTenantBudgetPolicy>;
  tenantIdRaw: string;
}): Promise<ResolvedSandboxTenantBudget | null> {
  const { env, sandboxTenantBudgetPolicy, tenantIdRaw } = args;
  const tenantId = String(tenantIdRaw ?? "").trim() || env.MEMORY_TENANT_ID;

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
  access: SandboxStoreAccess,
  args: SandboxBudgetUsageArgs,
): Promise<SandboxBudgetUsage> {
  return await access.readBudgetUsage(args);
}

export function createSandboxBudgetService(args: {
  env: Env;
  sandboxTenantBudgetPolicy: Map<string, SandboxTenantBudgetPolicy>;
  usageStore: Pick<SandboxStore, "withClient">;
}) {
  const { env, sandboxTenantBudgetPolicy, usageStore } = args;

  const enforceSandboxTenantBudget = async (
    reply: any,
    tenantIdRaw: string,
    scopeRaw: string,
    projectIdRaw?: string | null,
  ): Promise<void> => {
    assertEmbeddingSurfaceForbidden("sandbox_budget_gate");
    const resolved = await resolveSandboxTenantBudget({
      env,
      sandboxTenantBudgetPolicy,
      tenantIdRaw,
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
      usage = await usageStore.withClient((access) => readSandboxBudgetUsage(access, readArgs));
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

    if (policy.daily_run_cap && usage.total_runs >= policy.daily_run_cap) {
      raise(
        "sandbox_tenant_budget_run_cap_exceeded",
        "total_runs",
        policy.daily_run_cap,
      );
    }
    if (policy.daily_timeout_cap && usage.timeout_runs >= policy.daily_timeout_cap) {
      raise(
        "sandbox_tenant_budget_timeout_cap_exceeded",
        "timeout_runs",
        policy.daily_timeout_cap,
      );
    }
    if (policy.daily_failure_cap && usage.failed_runs >= policy.daily_failure_cap) {
      raise(
        "sandbox_tenant_budget_failure_cap_exceeded",
        "failed_runs",
        policy.daily_failure_cap,
      );
    }
  };

  return {
    enforceSandboxTenantBudget,
  };
}
