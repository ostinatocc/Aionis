import type { Env } from "../config.js";

type ReplayPlaybookStatus = "draft" | "shadow" | "active" | "disabled";
type ReplayRepairReviewAutoPromoteProfile = "custom" | "strict" | "staged" | "aggressive";
type ReplayRepairReviewEndpoint = "replay_playbook_repair_review";
type ReplayRepairReviewAutoPromoteGateDefaults = {
  require_shadow_pass: boolean;
  min_total_steps: number;
  max_failed_steps: number;
  max_blocked_steps: number;
  max_unknown_steps: number;
  min_success_ratio: number;
};
type ReplayRepairReviewAutoPromoteDefaults = {
  auto_promote_on_pass: boolean;
  auto_promote_target_status: ReplayPlaybookStatus;
  auto_promote_gate: ReplayRepairReviewAutoPromoteGateDefaults;
};
type ReplayRepairReviewPolicyPatch = {
  profile?: ReplayRepairReviewAutoPromoteProfile;
  auto_promote_on_pass?: boolean;
  auto_promote_target_status?: ReplayPlaybookStatus;
  auto_promote_gate?: Partial<ReplayRepairReviewAutoPromoteGateDefaults>;
};
type ReplayRepairReviewPolicy = {
  endpoint: Partial<Record<"*" | ReplayRepairReviewEndpoint, ReplayRepairReviewPolicyPatch>>;
};
type ReplayRepairReviewDefaultsResolution = {
  endpoint: ReplayRepairReviewEndpoint;
  tenant_id: string;
  scope: string;
  base_source: "global_profile" | "global_env";
  base_profile: ReplayRepairReviewAutoPromoteProfile | null;
  sources_applied: Array<{
    layer: "endpoint";
    key: string;
    patch: ReplayRepairReviewPolicyPatch;
  }>;
  request_overrides: {
    auto_promote_on_pass: boolean;
    auto_promote_target_status: boolean;
    gate: {
      require_shadow_pass: boolean;
      min_total_steps: boolean;
      max_failed_steps: boolean;
      max_blocked_steps: boolean;
      max_unknown_steps: boolean;
      min_success_ratio: boolean;
    };
  };
  effective: ReplayRepairReviewAutoPromoteDefaults;
};

const REPLAY_REPAIR_REVIEW_ENDPOINT_KEY: ReplayRepairReviewEndpoint = "replay_playbook_repair_review";
const SUPPORTED_POLICY_KEYS = new Set(["endpoint"]);
const SUPPORTED_ENDPOINT_KEYS = new Set(["*", REPLAY_REPAIR_REVIEW_ENDPOINT_KEY]);

const REPLAY_REPAIR_REVIEW_PROFILE_DEFAULTS: Record<
  Exclude<ReplayRepairReviewAutoPromoteProfile, "custom">,
  ReplayRepairReviewAutoPromoteDefaults
> = {
  strict: {
    auto_promote_on_pass: false,
    auto_promote_target_status: "active",
    auto_promote_gate: {
      require_shadow_pass: true,
      min_total_steps: 1,
      max_failed_steps: 0,
      max_blocked_steps: 0,
      max_unknown_steps: 0,
      min_success_ratio: 1,
    },
  },
  staged: {
    auto_promote_on_pass: true,
    auto_promote_target_status: "shadow",
    auto_promote_gate: {
      require_shadow_pass: true,
      min_total_steps: 1,
      max_failed_steps: 0,
      max_blocked_steps: 0,
      max_unknown_steps: 0,
      min_success_ratio: 1,
    },
  },
  aggressive: {
    auto_promote_on_pass: true,
    auto_promote_target_status: "active",
    auto_promote_gate: {
      require_shadow_pass: false,
      min_total_steps: 1,
      max_failed_steps: 0,
      max_blocked_steps: 1,
      max_unknown_steps: 1,
      min_success_ratio: 0.9,
    },
  },
};

function cloneReplayRepairReviewDefaults(defaults: ReplayRepairReviewAutoPromoteDefaults): ReplayRepairReviewAutoPromoteDefaults {
  return {
    auto_promote_on_pass: defaults.auto_promote_on_pass,
    auto_promote_target_status: defaults.auto_promote_target_status,
    auto_promote_gate: { ...defaults.auto_promote_gate },
  };
}

function parseReplayRepairReviewPolicyPatch(raw: unknown, path: string): ReplayRepairReviewPolicyPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const out: ReplayRepairReviewPolicyPatch = {};
  if (obj.profile !== undefined) {
    const profile = String(obj.profile ?? "").trim();
    if (profile !== "custom" && profile !== "strict" && profile !== "staged" && profile !== "aggressive") {
      throw new Error(`${path}.profile must be one of: custom|strict|staged|aggressive`);
    }
    out.profile = profile as ReplayRepairReviewAutoPromoteProfile;
  }
  if (obj.auto_promote_on_pass !== undefined) {
    if (typeof obj.auto_promote_on_pass !== "boolean") {
      throw new Error(`${path}.auto_promote_on_pass must be boolean`);
    }
    out.auto_promote_on_pass = obj.auto_promote_on_pass;
  }
  if (obj.auto_promote_target_status !== undefined) {
    const status = String(obj.auto_promote_target_status ?? "").trim();
    if (status !== "draft" && status !== "shadow" && status !== "active" && status !== "disabled") {
      throw new Error(`${path}.auto_promote_target_status must be one of: draft|shadow|active|disabled`);
    }
    out.auto_promote_target_status = status as ReplayPlaybookStatus;
  }
  if (obj.auto_promote_gate !== undefined) {
    if (!obj.auto_promote_gate || typeof obj.auto_promote_gate !== "object" || Array.isArray(obj.auto_promote_gate)) {
      throw new Error(`${path}.auto_promote_gate must be an object`);
    }
    const gateObj = obj.auto_promote_gate as Record<string, unknown>;
    const gate: Partial<ReplayRepairReviewAutoPromoteGateDefaults> = {};
    if (gateObj.require_shadow_pass !== undefined) {
      if (typeof gateObj.require_shadow_pass !== "boolean") {
        throw new Error(`${path}.auto_promote_gate.require_shadow_pass must be boolean`);
      }
      gate.require_shadow_pass = gateObj.require_shadow_pass;
    }
    const parseNonNegativeInt = (value: unknown, key: string): number => {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error(`${path}.auto_promote_gate.${key} must be a non-negative integer`);
      }
      return n;
    };
    if (gateObj.min_total_steps !== undefined) gate.min_total_steps = parseNonNegativeInt(gateObj.min_total_steps, "min_total_steps");
    if (gateObj.max_failed_steps !== undefined) gate.max_failed_steps = parseNonNegativeInt(gateObj.max_failed_steps, "max_failed_steps");
    if (gateObj.max_blocked_steps !== undefined) gate.max_blocked_steps = parseNonNegativeInt(gateObj.max_blocked_steps, "max_blocked_steps");
    if (gateObj.max_unknown_steps !== undefined) gate.max_unknown_steps = parseNonNegativeInt(gateObj.max_unknown_steps, "max_unknown_steps");
    if (gateObj.min_success_ratio !== undefined) {
      const ratio = Number(gateObj.min_success_ratio);
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new Error(`${path}.auto_promote_gate.min_success_ratio must be between 0 and 1`);
      }
      gate.min_success_ratio = ratio;
    }
    out.auto_promote_gate = gate;
  }
  return out;
}

function parseReplayRepairReviewPolicy(raw: string): ReplayRepairReviewPolicy {
  const out: ReplayRepairReviewPolicy = { endpoint: {} };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "{}") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("REPLAY_REPAIR_REVIEW_POLICY_JSON must be valid JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("REPLAY_REPAIR_REVIEW_POLICY_JSON must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!SUPPORTED_POLICY_KEYS.has(key)) {
      throw new Error(
        `REPLAY_REPAIR_REVIEW_POLICY_JSON.${key} is not supported in Lite (use endpoint only)`,
      );
    }
  }
  if (obj.endpoint === undefined) return out;
  if (!obj.endpoint || typeof obj.endpoint !== "object" || Array.isArray(obj.endpoint)) {
    throw new Error("REPLAY_REPAIR_REVIEW_POLICY_JSON.endpoint must be an object");
  }
  for (const [endpointKeyRaw, patchRaw] of Object.entries(obj.endpoint as Record<string, unknown>)) {
    const key = endpointKeyRaw.trim();
    if (!key) continue;
    if (!SUPPORTED_ENDPOINT_KEYS.has(key)) {
      throw new Error(
        `REPLAY_REPAIR_REVIEW_POLICY_JSON.endpoint.${key} is not supported in Lite (use *|${REPLAY_REPAIR_REVIEW_ENDPOINT_KEY})`,
      );
    }
    out.endpoint[key as "*" | ReplayRepairReviewEndpoint] = parseReplayRepairReviewPolicyPatch(
      patchRaw,
      `REPLAY_REPAIR_REVIEW_POLICY_JSON.endpoint.${key}`,
    );
  }
  return out;
}

function applyReplayRepairReviewPolicyPatch(
  base: ReplayRepairReviewAutoPromoteDefaults,
  patch: ReplayRepairReviewPolicyPatch | null | undefined,
): ReplayRepairReviewAutoPromoteDefaults {
  if (!patch) return cloneReplayRepairReviewDefaults(base);
  let out = cloneReplayRepairReviewDefaults(base);
  if (patch.profile && patch.profile !== "custom") {
    out = cloneReplayRepairReviewDefaults(REPLAY_REPAIR_REVIEW_PROFILE_DEFAULTS[patch.profile]);
  }
  if (typeof patch.auto_promote_on_pass === "boolean") out.auto_promote_on_pass = patch.auto_promote_on_pass;
  if (patch.auto_promote_target_status) out.auto_promote_target_status = patch.auto_promote_target_status;
  if (patch.auto_promote_gate) {
    if (typeof patch.auto_promote_gate.require_shadow_pass === "boolean") {
      out.auto_promote_gate.require_shadow_pass = patch.auto_promote_gate.require_shadow_pass;
    }
    if (patch.auto_promote_gate.min_total_steps !== undefined) {
      out.auto_promote_gate.min_total_steps = patch.auto_promote_gate.min_total_steps;
    }
    if (patch.auto_promote_gate.max_failed_steps !== undefined) {
      out.auto_promote_gate.max_failed_steps = patch.auto_promote_gate.max_failed_steps;
    }
    if (patch.auto_promote_gate.max_blocked_steps !== undefined) {
      out.auto_promote_gate.max_blocked_steps = patch.auto_promote_gate.max_blocked_steps;
    }
    if (patch.auto_promote_gate.max_unknown_steps !== undefined) {
      out.auto_promote_gate.max_unknown_steps = patch.auto_promote_gate.max_unknown_steps;
    }
    if (patch.auto_promote_gate.min_success_ratio !== undefined) {
      out.auto_promote_gate.min_success_ratio = patch.auto_promote_gate.min_success_ratio;
    }
  }
  return out;
}

export function createReplayRepairReviewPolicy(args: {
  env: Env;
  tenantFromBody: (body: unknown) => string;
  scopeFromBody: (body: unknown) => string;
}) {
  const { env, tenantFromBody, scopeFromBody } = args;
  const replayRepairReviewPolicy = parseReplayRepairReviewPolicy(env.REPLAY_REPAIR_REVIEW_POLICY_JSON);

  const resolveReplayRepairReviewGlobalDefaults = (): {
    defaults: ReplayRepairReviewAutoPromoteDefaults;
    source: "global_profile" | "global_env";
    profile: ReplayRepairReviewAutoPromoteProfile | null;
  } => {
    const profile = env.REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_PROFILE as ReplayRepairReviewAutoPromoteProfile;
    const profileDefaults = profile === "custom" ? null : REPLAY_REPAIR_REVIEW_PROFILE_DEFAULTS[profile];
    if (profileDefaults) {
      return {
        defaults: cloneReplayRepairReviewDefaults(profileDefaults),
        source: "global_profile",
        profile,
      };
    }
    return {
      defaults: {
        auto_promote_on_pass: env.REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_DEFAULT,
        auto_promote_target_status: env.REPLAY_REPAIR_REVIEW_AUTO_PROMOTE_TARGET_STATUS,
        auto_promote_gate: {
          require_shadow_pass: env.REPLAY_REPAIR_REVIEW_GATE_REQUIRE_SHADOW_PASS,
          min_total_steps: env.REPLAY_REPAIR_REVIEW_GATE_MIN_TOTAL_STEPS,
          max_failed_steps: env.REPLAY_REPAIR_REVIEW_GATE_MAX_FAILED_STEPS,
          max_blocked_steps: env.REPLAY_REPAIR_REVIEW_GATE_MAX_BLOCKED_STEPS,
          max_unknown_steps: env.REPLAY_REPAIR_REVIEW_GATE_MAX_UNKNOWN_STEPS,
          min_success_ratio: env.REPLAY_REPAIR_REVIEW_GATE_MIN_SUCCESS_RATIO,
        },
      },
      source: "global_env",
      profile: null,
    };
  };

  const resolveReplayRepairReviewDefaults = (
    tenantIdRaw: string,
    scopeRaw: string,
    endpoint: ReplayRepairReviewEndpoint,
  ): ReplayRepairReviewDefaultsResolution => {
    const tenantId = tenantIdRaw.trim() || env.MEMORY_TENANT_ID;
    const scope = scopeRaw.trim() || env.MEMORY_SCOPE;
    const global = resolveReplayRepairReviewGlobalDefaults();
    let out = cloneReplayRepairReviewDefaults(global.defaults);
    const sourcesApplied: ReplayRepairReviewDefaultsResolution["sources_applied"] = [];
    const apply = (key: "*" | ReplayRepairReviewEndpoint, patch: ReplayRepairReviewPolicyPatch | null | undefined) => {
      if (!patch) return;
      out = applyReplayRepairReviewPolicyPatch(out, patch);
      sourcesApplied.push({ layer: "endpoint", key, patch });
    };

    apply("*", replayRepairReviewPolicy.endpoint["*"]);
    apply(endpoint, replayRepairReviewPolicy.endpoint[endpoint]);

    return {
      endpoint,
      tenant_id: tenantId,
      scope,
      base_source: global.source,
      base_profile: global.profile,
      sources_applied: sourcesApplied,
      request_overrides: {
        auto_promote_on_pass: false,
        auto_promote_target_status: false,
        gate: {
          require_shadow_pass: false,
          min_total_steps: false,
          max_failed_steps: false,
          max_blocked_steps: false,
          max_unknown_steps: false,
          min_success_ratio: false,
        },
      },
      effective: out,
    };
  };

  function withReplayRepairReviewDefaults(body: unknown): {
    body: Record<string, unknown>;
    resolution: ReplayRepairReviewDefaultsResolution;
  } {
    const out: Record<string, unknown> = body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
    const tenantId = tenantFromBody(out);
    const scope = scopeFromBody(out);
    const resolution = resolveReplayRepairReviewDefaults(tenantId, scope, REPLAY_REPAIR_REVIEW_ENDPOINT_KEY);
    const resolved = resolution.effective;

    resolution.request_overrides.auto_promote_on_pass = out.auto_promote_on_pass !== undefined && out.auto_promote_on_pass !== null;
    resolution.request_overrides.auto_promote_target_status =
      out.auto_promote_target_status !== undefined && out.auto_promote_target_status !== null;

    if (out.auto_promote_on_pass === undefined || out.auto_promote_on_pass === null) {
      out.auto_promote_on_pass = resolved.auto_promote_on_pass;
    }
    if (out.auto_promote_target_status === undefined || out.auto_promote_target_status === null) {
      out.auto_promote_target_status = resolved.auto_promote_target_status;
    }

    const gateRaw = out.auto_promote_gate;
    const gate: Record<string, unknown> = gateRaw && typeof gateRaw === "object" && !Array.isArray(gateRaw)
      ? { ...(gateRaw as Record<string, unknown>) }
      : {};
    resolution.request_overrides.gate.require_shadow_pass =
      gate.require_shadow_pass !== undefined && gate.require_shadow_pass !== null;
    resolution.request_overrides.gate.min_total_steps = gate.min_total_steps !== undefined && gate.min_total_steps !== null;
    resolution.request_overrides.gate.max_failed_steps = gate.max_failed_steps !== undefined && gate.max_failed_steps !== null;
    resolution.request_overrides.gate.max_blocked_steps = gate.max_blocked_steps !== undefined && gate.max_blocked_steps !== null;
    resolution.request_overrides.gate.max_unknown_steps = gate.max_unknown_steps !== undefined && gate.max_unknown_steps !== null;
    resolution.request_overrides.gate.min_success_ratio = gate.min_success_ratio !== undefined && gate.min_success_ratio !== null;
    if (gate.require_shadow_pass === undefined || gate.require_shadow_pass === null) {
      gate.require_shadow_pass = resolved.auto_promote_gate.require_shadow_pass;
    }
    if (gate.min_total_steps === undefined || gate.min_total_steps === null) {
      gate.min_total_steps = resolved.auto_promote_gate.min_total_steps;
    }
    if (gate.max_failed_steps === undefined || gate.max_failed_steps === null) {
      gate.max_failed_steps = resolved.auto_promote_gate.max_failed_steps;
    }
    if (gate.max_blocked_steps === undefined || gate.max_blocked_steps === null) {
      gate.max_blocked_steps = resolved.auto_promote_gate.max_blocked_steps;
    }
    if (gate.max_unknown_steps === undefined || gate.max_unknown_steps === null) {
      gate.max_unknown_steps = resolved.auto_promote_gate.max_unknown_steps;
    }
    if (gate.min_success_ratio === undefined || gate.min_success_ratio === null) {
      gate.min_success_ratio = resolved.auto_promote_gate.min_success_ratio;
    }
    out.auto_promote_gate = gate;
    return { body: out, resolution };
  }

  return {
    withReplayRepairReviewDefaults,
  };
}
