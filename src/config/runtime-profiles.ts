export type RuntimeProfileId =
  | "local_core"
  | "local_zvec"
  | "local_substrate"
  | "full_local"
  | "server_development"
  | "server_production";

export type RuntimeProfileResolution = {
  id: RuntimeProfileId;
  edition: "lite" | "server";
  deployment: "local" | "server";
  components: readonly ("sqlite" | "zvec" | "substrate" | "authenticated_http")[];
};

type RuntimeProfileInput = {
  AIONIS_EDITION: "lite" | "server";
  APP_ENV: "dev" | "ci" | "prod";
  MEMORY_AUTH_MODE: "off" | "api_key" | "jwt" | "api_key_or_jwt";
  RECALL_ANN_PROVIDER: "off" | "local" | "zvec";
  RECALL_SUBSTRATE_SIDECAR_ENABLED: boolean;
};

const MODE_PRESETS = {
  local: {
    APP_ENV: "dev",
    MEMORY_AUTH_MODE: "off",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_BYPASS_LOOPBACK: "true",
    TENANT_QUOTA_ENABLED: "true",
    MEMORY_RECALL_PROFILE: "strict_edges",
  },
  service: {
    APP_ENV: "prod",
    MEMORY_AUTH_MODE: "api_key",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_BYPASS_LOOPBACK: "false",
    TENANT_QUOTA_ENABLED: "true",
    MEMORY_RECALL_PROFILE: "strict_edges",
  },
  cloud: {
    APP_ENV: "prod",
    MEMORY_AUTH_MODE: "api_key_or_jwt",
    RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_BYPASS_LOOPBACK: "false",
    TENANT_QUOTA_ENABLED: "true",
    MEMORY_RECALL_PROFILE: "strict_edges",
  },
} as const;

function applyMissingDefaults(
  target: NodeJS.ProcessEnv,
  defaults: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    const current = target[key];
    if (current === undefined || current.trim().length === 0) target[key] = value;
  }
}

export function applyRuntimeProfileDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...source };
  const mode = String(source.AIONIS_MODE ?? "local").trim().toLowerCase();
  if (mode === "local" || mode === "service" || mode === "cloud") {
    resolved.AIONIS_MODE = mode;
    applyMissingDefaults(resolved, MODE_PRESETS[mode]);
  }

  const edition = String(source.AIONIS_EDITION ?? "lite").trim().toLowerCase();
  if (edition !== "lite" && edition !== "server") return resolved;
  resolved.AIONIS_EDITION = edition;
  if (!resolved.RECALL_ENGINE_MODE?.trim()) resolved.RECALL_ENGINE_MODE = "hybrid";
  if (edition === "lite") {
    if (!resolved.AIONIS_MODE?.trim()) resolved.AIONIS_MODE = "local";
    resolved.MEMORY_AUTH_MODE = "off";
    resolved.TENANT_QUOTA_ENABLED = "false";
    resolved.RATE_LIMIT_BYPASS_LOOPBACK = "true";
    if (!resolved.LITE_LOCAL_ACTOR_ID?.trim()) resolved.LITE_LOCAL_ACTOR_ID = "local-user";
  }
  return resolved;
}

export function resolveRuntimeProfile(input: RuntimeProfileInput): RuntimeProfileResolution {
  if (input.AIONIS_EDITION === "server") {
    return {
      id: input.APP_ENV === "prod" ? "server_production" : "server_development",
      edition: "server",
      deployment: "server",
      components: ["sqlite", "authenticated_http"],
    };
  }

  const zvec = input.RECALL_ANN_PROVIDER === "zvec";
  const substrate = input.RECALL_SUBSTRATE_SIDECAR_ENABLED;
  const id: RuntimeProfileId = zvec && substrate
    ? "full_local"
    : zvec
      ? "local_zvec"
      : substrate
        ? "local_substrate"
        : "local_core";
  return {
    id,
    edition: "lite",
    deployment: "local",
    components: [
      "sqlite",
      ...(zvec ? ["zvec" as const] : []),
      ...(substrate ? ["substrate" as const] : []),
    ],
  };
}
