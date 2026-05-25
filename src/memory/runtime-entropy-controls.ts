import {
  RuntimeEntropyControlsV1Schema,
  type ActionIntelligenceRuntimeLifecycle,
  type RuntimeEntropyControlsV1,
  type RuntimeEntropyProfileV1,
} from "./schemas.js";

function recallControls(profile: RuntimeEntropyProfileV1): RuntimeEntropyControlsV1["recall"] {
  if (profile.entropy_level === "lockdown") {
    return {
      breadth: "narrow",
      recommended_limit: 6,
      recommended_ranked_limit: 24,
      recommended_max_nodes: 40,
      recommended_max_edges: 64,
      reason: "Lockdown narrows recall to verified anchors while control resolves authority or quarantine.",
    };
  }
  if (profile.recall_breadth === "wide") {
    return {
      breadth: "wide",
      recommended_limit: 20,
      recommended_ranked_limit: 160,
      recommended_max_nodes: 160,
      recommended_max_edges: 100,
      reason: "High entropy or recall gaps require wider retrieval before committing to action.",
    };
  }
  if (profile.recall_breadth === "narrow") {
    return {
      breadth: "narrow",
      recommended_limit: 6,
      recommended_ranked_limit: 32,
      recommended_max_nodes: 48,
      recommended_max_edges: 64,
      reason: "Low entropy favors compact recall and reuse of stable execution memory.",
    };
  }
  return {
    breadth: "balanced",
    recommended_limit: 10,
    recommended_ranked_limit: 80,
    recommended_max_nodes: 96,
    recommended_max_edges: 100,
    reason: "Medium entropy keeps recall balanced between reuse and exploration.",
  };
}

function verifierControls(profile: RuntimeEntropyProfileV1): RuntimeEntropyControlsV1["verifier"] {
  if (profile.entropy_level === "lockdown") {
    return {
      verification_depth: profile.verification_depth,
      schedule: "blocked",
      runtime_verifier_required: true,
      reason: "Lockdown requires resolving authority, quarantine, or operator review before verifier evidence can promote learning.",
    };
  }
  if (profile.verification_depth === "strict") {
    return {
      verification_depth: "strict",
      schedule: "strict",
      runtime_verifier_required: true,
      reason: "Strict verification is required before the task can produce promotion evidence.",
    };
  }
  if (profile.verification_depth === "light") {
    return {
      verification_depth: "light",
      schedule: "light",
      runtime_verifier_required: false,
      reason: "Low entropy and stable reuse allow lighter verification unless the execution contract requires more.",
    };
  }
  return {
    verification_depth: "normal",
    schedule: "normal",
    runtime_verifier_required: profile.control_strength >= 0.6,
    reason: "Normal verification keeps evidence quality proportional to current control strength.",
  };
}

function promotionControls(profile: RuntimeEntropyProfileV1): RuntimeEntropyControlsV1["promotion"] {
  const stableAllowed =
    profile.promotion_threshold !== "blocked"
    && profile.mutation_authority === "stable_allowed";
  const minimumObservations =
    profile.promotion_threshold === "blocked"
      ? 32
      : profile.promotion_threshold === "high"
        ? 3
        : profile.promotion_threshold === "low"
          ? 2
          : 2;
  return {
    promotion_threshold: profile.promotion_threshold,
    mutation_authority: profile.mutation_authority,
    minimum_observations: minimumObservations,
    stable_promotion_allowed: stableAllowed,
    reason: stableAllowed
      ? "Stable promotion is allowed only because entropy is low and evidence supports reuse."
      : profile.promotion_threshold === "blocked" || profile.mutation_authority === "none"
        ? "Promotion is blocked until quarantine, authority, or operator-review constraints are resolved."
        : "Learning may continue as scoped or candidate memory until broader evidence lowers promotion risk.",
  };
}

function maintenanceControls(args: {
  profile: RuntimeEntropyProfileV1;
  lifecycle: ActionIntelligenceRuntimeLifecycle;
}): RuntimeEntropyControlsV1["maintenance"] {
  if (args.profile.entropy_level === "lockdown") {
    return {
      recommended_profile: args.lifecycle.post_action_material_present ? "immediate" : "daily",
      run_after_task: args.lifecycle.post_action_material_present,
      reason: "Lockdown maintenance preserves evidence and quarantine signals without widening authority.",
    };
  }
  if (args.profile.entropy_level === "high") {
    return {
      recommended_profile: "immediate",
      run_after_task: args.lifecycle.post_action_material_present || args.lifecycle.mutation_candidate_available,
      reason: "High entropy should preserve fresh exploration material while keeping mutations controlled.",
    };
  }
  if (args.profile.entropy_level === "low") {
    return {
      recommended_profile: args.lifecycle.post_action_material_present ? "immediate" : "daily",
      run_after_task: args.lifecycle.post_action_material_present,
      reason: "Low entropy maintenance reinforces proven continuity and compacts unnecessary context.",
    };
  }
  return {
    recommended_profile: args.lifecycle.post_action_material_present ? "immediate" : "daily",
    run_after_task: args.lifecycle.post_action_material_present || args.lifecycle.mutation_candidate_available,
    reason: "Medium entropy maintenance balances fresh evidence preservation with regular lifecycle review.",
  };
}

export function buildRuntimeEntropyControlsV1(args: {
  profile: RuntimeEntropyProfileV1;
  lifecycle: ActionIntelligenceRuntimeLifecycle;
}): RuntimeEntropyControlsV1 {
  return RuntimeEntropyControlsV1Schema.parse({
    controls_version: "runtime_entropy_controls_v1",
    recall: recallControls(args.profile),
    verifier: verifierControls(args.profile),
    promotion: promotionControls(args.profile),
    maintenance: maintenanceControls(args),
    source_code_change_allowed: false,
  });
}
