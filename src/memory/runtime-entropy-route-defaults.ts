import {
  RuntimeEntropyControlsV1Schema,
  type RuntimeEntropyControlsV1,
} from "./schemas.js";
import type {
  RuntimeVerificationControlV1,
} from "../execution/verification.js";

export type RuntimeEntropyRecallDefaultsApplicationV1 = {
  application_version: "runtime_entropy_recall_defaults_v1";
  applied: boolean;
  reason:
    | "applied"
    | "no_runtime_entropy_controls"
    | "invalid_runtime_entropy_controls"
    | "explicit_recall_knobs";
  controls_version: "runtime_entropy_controls_v1" | null;
  recall_breadth: RuntimeEntropyControlsV1["recall"]["breadth"] | null;
  defaults: {
    limit?: number;
    ranked_limit?: number;
    max_nodes?: number;
    max_edges?: number;
  };
};

export type RuntimeEntropyVerifierDefaultsApplicationV1 = {
  application_version: "runtime_entropy_verifier_defaults_v1";
  applied: boolean;
  reason:
    | "applied"
    | "unsupported_surface"
    | "no_runtime_entropy_controls"
    | "invalid_runtime_entropy_controls"
    | "explicit_runtime_verification";
  controls_version: "runtime_entropy_controls_v1" | null;
  verifier_schedule: RuntimeEntropyControlsV1["verifier"]["schedule"] | null;
  runtime_verifier_required: boolean | null;
  defaults: Partial<RuntimeVerificationControlV1>;
};

export type RuntimeEntropyMaintenanceProfile = "immediate" | "daily" | "long_horizon";

export type RuntimeEntropyMaintenanceDefaultsApplicationV1 = {
  application_version: "runtime_entropy_maintenance_defaults_v1";
  applied: boolean;
  reason:
    | "applied"
    | "no_runtime_entropy_controls"
    | "invalid_runtime_entropy_controls"
    | "explicit_maintenance_profile";
  controls_version: "runtime_entropy_controls_v1" | null;
  recommended_profile: RuntimeEntropyMaintenanceProfile | null;
  run_after_task: boolean | null;
  defaults: {
    maintenance_profile?: RuntimeEntropyMaintenanceProfile;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withoutRuntimeEntropyControls(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  delete out.runtime_entropy_controls;
  return out;
}

export function readRuntimeEntropyControlsFromRequest(body: unknown): RuntimeEntropyControlsV1 | null {
  const record = asRecord(body);
  if (!record || record.runtime_entropy_controls === undefined || record.runtime_entropy_controls === null) {
    return null;
  }
  const parsed = RuntimeEntropyControlsV1Schema.safeParse(record.runtime_entropy_controls);
  return parsed.success ? parsed.data : null;
}

export function hasInvalidRuntimeEntropyControls(body: unknown): boolean {
  const record = asRecord(body);
  if (!record || record.runtime_entropy_controls === undefined || record.runtime_entropy_controls === null) {
    return false;
  }
  return !RuntimeEntropyControlsV1Schema.safeParse(record.runtime_entropy_controls).success;
}

export function runtimeEntropyRecallDefaultsApplication(args: {
  body: unknown;
  explicitRecallKnobs: boolean;
}): {
  body: Record<string, unknown>;
  application: RuntimeEntropyRecallDefaultsApplicationV1;
} {
  const body = asRecord(args.body) ? { ...(args.body as Record<string, unknown>) } : {};
  if (hasInvalidRuntimeEntropyControls(body)) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_recall_defaults_v1",
        applied: false,
        reason: "invalid_runtime_entropy_controls",
        controls_version: null,
        recall_breadth: null,
        defaults: {},
      },
    };
  }
  const controls = readRuntimeEntropyControlsFromRequest(body);
  if (!controls) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_recall_defaults_v1",
        applied: false,
        reason: "no_runtime_entropy_controls",
        controls_version: null,
        recall_breadth: null,
        defaults: {},
      },
    };
  }
  const defaults = {
    limit: controls.recall.recommended_limit,
    ranked_limit: controls.recall.recommended_ranked_limit,
    max_nodes: controls.recall.recommended_max_nodes,
    max_edges: controls.recall.recommended_max_edges,
  };
  if (args.explicitRecallKnobs) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_recall_defaults_v1",
        applied: false,
        reason: "explicit_recall_knobs",
        controls_version: controls.controls_version,
        recall_breadth: controls.recall.breadth,
        defaults,
      },
    };
  }
  return {
    body: {
      ...body,
      ...defaults,
    },
    application: {
      application_version: "runtime_entropy_recall_defaults_v1",
      applied: true,
      reason: "applied",
      controls_version: controls.controls_version,
      recall_breadth: controls.recall.breadth,
      defaults,
    },
  };
}

function verifierDefaultsFromControls(
  controls: RuntimeEntropyControlsV1,
): Partial<RuntimeVerificationControlV1> {
  if (controls.verifier.schedule === "skip") {
    return {
      version: 1,
      mode: "off",
      include_pending_validations: false,
      max_requests: 1,
    };
  }
  if (controls.verifier.schedule === "light" && !controls.verifier.runtime_verifier_required) {
    return {
      version: 1,
      mode: "off",
      include_pending_validations: false,
      max_requests: 1,
    };
  }
  if (controls.verifier.schedule === "strict") {
    return {
      version: 1,
      mode: "plan",
      include_pending_validations: true,
      max_requests: 16,
    };
  }
  if (controls.verifier.schedule === "blocked") {
    return {
      version: 1,
      mode: "plan",
      include_pending_validations: true,
      max_requests: 8,
    };
  }
  return {
    version: 1,
    mode: "plan",
    include_pending_validations: true,
    max_requests: 8,
  };
}

export function hasExplicitRuntimeVerification(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return false;
  return record.runtime_verification !== undefined && record.runtime_verification !== null;
}

export function hasExplicitMaintenanceProfile(body: unknown): boolean {
  const record = asRecord(body);
  if (!record) return false;
  return record.maintenance_profile !== undefined && record.maintenance_profile !== null;
}

export function runtimeEntropyVerifierDefaultsApplication(args: {
  body: unknown;
  explicitRuntimeVerification: boolean;
  supportsRuntimeVerification: boolean;
}): {
  body: Record<string, unknown>;
  application: RuntimeEntropyVerifierDefaultsApplicationV1;
} {
  const body = asRecord(args.body) ? { ...(args.body as Record<string, unknown>) } : {};
  if (!args.supportsRuntimeVerification) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_verifier_defaults_v1",
        applied: false,
        reason: "unsupported_surface",
        controls_version: null,
        verifier_schedule: null,
        runtime_verifier_required: null,
        defaults: {},
      },
    };
  }
  if (hasInvalidRuntimeEntropyControls(body)) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_verifier_defaults_v1",
        applied: false,
        reason: "invalid_runtime_entropy_controls",
        controls_version: null,
        verifier_schedule: null,
        runtime_verifier_required: null,
        defaults: {},
      },
    };
  }
  const controls = readRuntimeEntropyControlsFromRequest(body);
  if (!controls) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_verifier_defaults_v1",
        applied: false,
        reason: "no_runtime_entropy_controls",
        controls_version: null,
        verifier_schedule: null,
        runtime_verifier_required: null,
        defaults: {},
      },
    };
  }
  const defaults = verifierDefaultsFromControls(controls);
  if (args.explicitRuntimeVerification) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_verifier_defaults_v1",
        applied: false,
        reason: "explicit_runtime_verification",
        controls_version: controls.controls_version,
        verifier_schedule: controls.verifier.schedule,
        runtime_verifier_required: controls.verifier.runtime_verifier_required,
        defaults,
      },
    };
  }
  return {
    body: {
      ...body,
      runtime_verification: defaults,
    },
    application: {
      application_version: "runtime_entropy_verifier_defaults_v1",
      applied: true,
      reason: "applied",
      controls_version: controls.controls_version,
      verifier_schedule: controls.verifier.schedule,
      runtime_verifier_required: controls.verifier.runtime_verifier_required,
      defaults,
    },
  };
}

export function runtimeEntropyMaintenanceDefaultsApplication(args: {
  body: unknown;
  explicitMaintenanceProfile: boolean;
}): {
  body: Record<string, unknown>;
  application: RuntimeEntropyMaintenanceDefaultsApplicationV1;
} {
  const body = asRecord(args.body) ? { ...(args.body as Record<string, unknown>) } : {};
  if (hasInvalidRuntimeEntropyControls(body)) {
    return {
      body,
      application: {
        application_version: "runtime_entropy_maintenance_defaults_v1",
        applied: false,
        reason: "invalid_runtime_entropy_controls",
        controls_version: null,
        recommended_profile: null,
        run_after_task: null,
        defaults: {},
      },
    };
  }
  const controls = readRuntimeEntropyControlsFromRequest(body);
  const cleanBody = withoutRuntimeEntropyControls(body);
  if (!controls) {
    return {
      body: cleanBody,
      application: {
        application_version: "runtime_entropy_maintenance_defaults_v1",
        applied: false,
        reason: "no_runtime_entropy_controls",
        controls_version: null,
        recommended_profile: null,
        run_after_task: null,
        defaults: {},
      },
    };
  }
  const defaults = {
    maintenance_profile: controls.maintenance.recommended_profile,
  };
  if (args.explicitMaintenanceProfile) {
    return {
      body: cleanBody,
      application: {
        application_version: "runtime_entropy_maintenance_defaults_v1",
        applied: false,
        reason: "explicit_maintenance_profile",
        controls_version: controls.controls_version,
        recommended_profile: controls.maintenance.recommended_profile,
        run_after_task: controls.maintenance.run_after_task,
        defaults,
      },
    };
  }
  return {
    body: {
      ...cleanBody,
      ...defaults,
    },
    application: {
      application_version: "runtime_entropy_maintenance_defaults_v1",
      applied: true,
      reason: "applied",
      controls_version: controls.controls_version,
      recommended_profile: controls.maintenance.recommended_profile,
      run_after_task: controls.maintenance.run_after_task,
      defaults,
    },
  };
}
