export const MEMORY_LAYER_IDS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;

export type MemoryLayerId = (typeof MEMORY_LAYER_IDS)[number];

export type MemoryLayerPolicyName = "factual_recall" | "planning_context";
export type MemoryLayerPolicySource = "endpoint_default" | "request_override";

export type MemoryLayerPreferenceInput = {
  allowed_layers?: MemoryLayerId[] | null;
};

export type ResolveMemoryLayerPolicyOptions = {
  unsafe_allow_drop_trust_anchors?: boolean;
  internal_allow_l4_selection?: boolean;
};

export type MemoryLayerPolicy = {
  name: MemoryLayerPolicyName;
  preferred_layers: MemoryLayerId[];
  secondary_layers: MemoryLayerId[];
  trust_anchor_layers: MemoryLayerId[];
  source: MemoryLayerPolicySource;
  requested_allowed_layers?: MemoryLayerId[];
};

export type ExecutionLearningDeliveryPurpose =
  | "normal_production"
  | "controlled_development"
  | "paired_validation";

export type ExecutionLearningDeliveryArtifact =
  | {
      layer: "L1";
    }
  | {
      layer: "L2";
      status: "candidate" | "in_validation" | "rejected" | "contested";
    }
  | {
      layer: "L3";
      status: "validated" | "limited" | "contested" | "deprecated";
    };

export type ExecutionLearningDeliveryDecision = {
  placement: "use_now" | "validation_only" | "none";
  reason_code:
    | "validated_skill"
    | "scope_compatible_limited_skill"
    | "frozen_paired_validation"
    | "raw_episode_evidence_only"
    | "candidate_not_in_validation"
    | "limited_scope_required"
    | "artifact_not_deliverable";
};

function dedupeLayers(input: readonly MemoryLayerId[]): MemoryLayerId[] {
  return Array.from(new Set(input));
}

function defaultPolicyForEndpoint(
  endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble",
  options?: ResolveMemoryLayerPolicyOptions,
): MemoryLayerPolicy {
  const internalAllowL4Selection = options?.internal_allow_l4_selection === true;
  if (endpoint === "planning_context" || endpoint === "context_assemble") {
    return {
      name: "planning_context",
      preferred_layers: dedupeLayers(internalAllowL4Selection ? ["L4", "L3", "L0", "L1", "L2"] : ["L3", "L0", "L1", "L2"]),
      secondary_layers: dedupeLayers(["L1", "L2"]),
      trust_anchor_layers: dedupeLayers(internalAllowL4Selection ? ["L4", "L3", "L0"] : ["L3", "L0"]),
      source: "endpoint_default",
    };
  }
  return {
    name: "factual_recall",
    preferred_layers: dedupeLayers(internalAllowL4Selection ? ["L4", "L3", "L0", "L1", "L2"] : ["L3", "L0", "L1", "L2"]),
    secondary_layers: dedupeLayers(["L0", "L1"]),
    trust_anchor_layers: dedupeLayers(internalAllowL4Selection ? ["L4", "L3", "L0"] : ["L3", "L0"]),
    source: "endpoint_default",
  };
}

export function resolveMemoryLayerPolicy(
  endpoint: "recall" | "recall_text" | "planning_context" | "context_assemble",
  preference?: MemoryLayerPreferenceInput | null,
  options?: ResolveMemoryLayerPolicyOptions,
): MemoryLayerPolicy {
  const base = defaultPolicyForEndpoint(endpoint, options);
  const requestedAllowedLayers = dedupeLayers(
    Array.isArray(preference?.allowed_layers) ? preference.allowed_layers.filter((layer): layer is MemoryLayerId => MEMORY_LAYER_IDS.includes(layer)) : [],
  );
  if (requestedAllowedLayers.length === 0) return base;

  const unsafeAllowDropTrustAnchors = options?.unsafe_allow_drop_trust_anchors === true;
  const effectiveAllowed = new Set<MemoryLayerId>(
    unsafeAllowDropTrustAnchors ? requestedAllowedLayers : [...requestedAllowedLayers, ...base.trust_anchor_layers],
  );
  const preferredLayers = base.preferred_layers.filter((layer) => effectiveAllowed.has(layer));
  const secondaryLayers = base.secondary_layers.filter((layer) => effectiveAllowed.has(layer));
  return {
    ...base,
    preferred_layers: preferredLayers,
    secondary_layers: secondaryLayers,
    trust_anchor_layers: unsafeAllowDropTrustAnchors
      ? base.trust_anchor_layers.filter((layer) => effectiveAllowed.has(layer))
      : base.trust_anchor_layers,
    source: "request_override",
    requested_allowed_layers: requestedAllowedLayers,
  };
}

export function resolveExecutionLearningDelivery(
  artifact: ExecutionLearningDeliveryArtifact,
  input: {
    purpose: ExecutionLearningDeliveryPurpose;
    limited_scope_compatible?: boolean;
  },
): ExecutionLearningDeliveryDecision {
  if (artifact.layer === "L1") {
    return {
      placement: "none",
      reason_code: "raw_episode_evidence_only",
    };
  }

  if (artifact.layer === "L2") {
    if (
      artifact.status === "in_validation"
      && input.purpose === "paired_validation"
    ) {
      return {
        placement: "validation_only",
        reason_code: "frozen_paired_validation",
      };
    }
    return {
      placement: "none",
      reason_code: artifact.status === "candidate"
        ? "candidate_not_in_validation"
        : "artifact_not_deliverable",
    };
  }

  if (artifact.status === "validated") {
    if (input.purpose === "paired_validation") {
      return {
        placement: "none",
        reason_code: "artifact_not_deliverable",
      };
    }
    return {
      placement: "use_now",
      reason_code: "validated_skill",
    };
  }

  if (
    artifact.status === "limited"
    && input.purpose === "controlled_development"
    && input.limited_scope_compatible === true
  ) {
    return {
      placement: "use_now",
      reason_code: "scope_compatible_limited_skill",
    };
  }

  return {
    placement: "none",
    reason_code: artifact.status === "limited"
      ? "limited_scope_required"
      : "artifact_not_deliverable",
  };
}
