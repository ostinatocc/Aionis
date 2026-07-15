import stableStringify from "fast-json-stable-stringify";
import { z } from "zod";
import { sha256Hex } from "../util/crypto.js";

export const AIONIS_ADMISSION_CANDIDATE_POLICY_ID =
  "candidate_project_context_closed_loop_inspect" as const;
export const AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION = "2026-06-18" as const;

export type AionisAdmissionCandidatePolicyId = typeof AIONIS_ADMISSION_CANDIDATE_POLICY_ID;
export type AionisAdmissionCandidatePolicyVersion = typeof AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION;

export const AdmissionCandidateActionSchema = z.enum([
  "use_now",
  "inspect_before_use",
  "do_not_use",
  "rehydrate",
  "not_agent_facing",
]);

export type AdmissionCandidateAction = z.infer<typeof AdmissionCandidateActionSchema>;

export const AdmissionCandidatePolicyInputSchema = z.object({
  recorded_action: AdmissionCandidateActionSchema,
  memory_origin: z.enum(["aionis", "external"]).optional(),
  source_backend: z.string().trim().min(1).max(120).nullable().optional(),
  memory_type: z.string().trim().min(1).max(120),
  closed_loop_effect_state: z.enum([
    "no_prior",
    "supported",
    "contradicted",
    "mixed",
    "rehydrate_requested",
  ]).nullable().optional(),
  repeated_negative_posture: z.boolean().nullable().optional(),
}).strict();

export type AdmissionCandidatePolicyInput = z.infer<typeof AdmissionCandidatePolicyInputSchema>;

const CandidatePolicyConfigSchema = z.object({
  contract_version: z.literal("aionis_admission_candidate_policy_config_v1"),
  hard_boundary_rule: z.literal("preserve_every_recorded_non_use_now_surface"),
  direct_use_source_backends: z.tuple([z.literal("aionis")]),
  direct_use_memory_types: z.tuple([
    z.literal("project_context"),
    z.literal("execution_memory"),
  ]),
  inspect_effect_states: z.tuple([
    z.literal("contradicted"),
    z.literal("mixed"),
  ]),
  repeated_negative_action: z.literal("inspect_before_use"),
  fallback_action: z.literal("inspect_before_use"),
  source_backend_fallback: z.literal("memory_origin_then_aionis"),
  used_fields: z.tuple([
    z.literal("admission_action"),
    z.literal("source_backend"),
    z.literal("memory_origin"),
    z.literal("memory_type"),
    z.literal("closed_loop_effect_state"),
    z.literal("repeated_negative_posture"),
  ]),
}).strict();

export type AdmissionCandidatePolicyConfig = z.infer<typeof CandidatePolicyConfigSchema>;

export type AdmissionCandidatePolicyDecision = {
  action: AdmissionCandidateAction;
  policy_changed: boolean;
  hard_boundary_preserved: boolean;
  reason_codes: string[];
};

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type AdmissionCandidatePolicyRegistryEntry = {
  policy_kind: "candidate";
  policy_id: AionisAdmissionCandidatePolicyId;
  policy_version: AionisAdmissionCandidatePolicyVersion;
  display_name: string;
  description: string;
  config: DeepReadonly<AdmissionCandidatePolicyConfig>;
  policy_config_sha256: string;
  implementation_contract_sha256: string;
};

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const POLICY_CONFIG = deepFreeze(CandidatePolicyConfigSchema.parse({
  contract_version: "aionis_admission_candidate_policy_config_v1",
  hard_boundary_rule: "preserve_every_recorded_non_use_now_surface",
  direct_use_source_backends: ["aionis"],
  direct_use_memory_types: ["project_context", "execution_memory"],
  inspect_effect_states: ["contradicted", "mixed"],
  repeated_negative_action: "inspect_before_use",
  fallback_action: "inspect_before_use",
  source_backend_fallback: "memory_origin_then_aionis",
  used_fields: [
    "admission_action",
    "source_backend",
    "memory_origin",
    "memory_type",
    "closed_loop_effect_state",
    "repeated_negative_posture",
  ],
}));

function canonicalSourceBackend(input: AdmissionCandidatePolicyInput): string {
  const explicit = input.source_backend?.trim();
  if (explicit) return explicit;
  return input.memory_origin === "external" ? "external" : "aionis";
}

function decideWithConfig(
  input: AdmissionCandidatePolicyInput,
  config: DeepReadonly<AdmissionCandidatePolicyConfig>,
): AdmissionCandidatePolicyDecision {
  if (input.recorded_action !== "use_now") {
    return {
      action: input.recorded_action,
      policy_changed: false,
      hard_boundary_preserved: true,
      reason_codes: ["hard_boundary_preserved", `recorded_action:${input.recorded_action}`],
    };
  }

  const backend = canonicalSourceBackend(input);
  const effectState = input.closed_loop_effect_state ?? "no_prior";
  const reasons: string[] = [];
  if (!config.direct_use_source_backends.includes(backend as "aionis")) {
    reasons.push("non_aionis_backend_shadow_inspect");
  }
  if (!config.direct_use_memory_types.includes(input.memory_type as "project_context" | "execution_memory")) {
    reasons.push("non_project_or_execution_memory_shadow_inspect");
  }
  if (config.inspect_effect_states.includes(effectState as "contradicted" | "mixed")) {
    reasons.push("closed_loop_counter_signal_shadow_inspect");
  }
  if (input.repeated_negative_posture === true) {
    reasons.push("repeated_negative_posture_shadow_inspect");
  }

  const action = reasons.length === 0 ? "use_now" : config.fallback_action;
  return {
    action,
    policy_changed: action !== input.recorded_action,
    hard_boundary_preserved: true,
    reason_codes: reasons.length > 0
      ? reasons
      : ["aionis_project_or_execution_context_shadow_use_now"],
  };
}

const GOLDEN_RECORDED_ACTIONS = AdmissionCandidateActionSchema.options;
const GOLDEN_BACKENDS = ["aionis", "external", null, undefined] as const;
const GOLDEN_ORIGINS = ["aionis", "external", undefined] as const;
const GOLDEN_MEMORY_TYPES = ["project_context", "execution_memory", "procedural_memory"] as const;
const GOLDEN_EFFECT_STATES = [
  "no_prior",
  "supported",
  "contradicted",
  "mixed",
  "rehydrate_requested",
] as const;

function behaviorVector() {
  const vector: Array<{ input: AdmissionCandidatePolicyInput; output: AdmissionCandidatePolicyDecision }> = [];
  for (const recorded_action of GOLDEN_RECORDED_ACTIONS) {
    for (const source_backend of GOLDEN_BACKENDS) {
      for (const memory_origin of GOLDEN_ORIGINS) {
        for (const memory_type of GOLDEN_MEMORY_TYPES) {
          for (const closed_loop_effect_state of GOLDEN_EFFECT_STATES) {
            for (const repeated_negative_posture of [false, true] as const) {
              const input = AdmissionCandidatePolicyInputSchema.parse({
                recorded_action,
                source_backend,
                memory_origin,
                memory_type,
                closed_loop_effect_state,
                repeated_negative_posture,
              });
              vector.push({ input, output: decideWithConfig(input, POLICY_CONFIG) });
            }
          }
        }
      }
    }
  }
  return vector;
}

const POLICY_CONFIG_SHA256 = sha256Hex(stableStringify(POLICY_CONFIG));
const IMPLEMENTATION_CONTRACT_SHA256 = sha256Hex(stableStringify({
  contract_version: "aionis_admission_candidate_behavior_contract_v1",
  policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  policy_config_sha256: POLICY_CONFIG_SHA256,
  behavior_vector: behaviorVector(),
}));

const REGISTRY_ENTRY: AdmissionCandidatePolicyRegistryEntry = deepFreeze({
  policy_kind: "candidate",
  policy_id: AIONIS_ADMISSION_CANDIDATE_POLICY_ID,
  policy_version: AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION,
  display_name: "Project/execution context + closed-loop inspect-first",
  description: "Preserves every recorded non-use boundary, direct-uses only Aionis project or execution context, and inspects prior counter-signals.",
  config: POLICY_CONFIG,
  policy_config_sha256: POLICY_CONFIG_SHA256,
  implementation_contract_sha256: IMPLEMENTATION_CONTRACT_SHA256,
});

export function resolveAdmissionCandidatePolicy(
  policyId: string,
  policyVersion: string,
  expectedConfigSha256?: string | null,
): AdmissionCandidatePolicyRegistryEntry {
  if (
    policyId !== AIONIS_ADMISSION_CANDIDATE_POLICY_ID
    || policyVersion !== AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION
  ) {
    throw new Error(`Unknown admission candidate policy tuple: ${policyId}@${policyVersion}`);
  }
  if (expectedConfigSha256 != null && expectedConfigSha256 !== POLICY_CONFIG_SHA256) {
    throw new Error(`Admission candidate policy config mismatch for ${policyId}@${policyVersion}`);
  }
  return REGISTRY_ENTRY;
}

export function decideAdmissionCandidatePolicyAction(
  rawInput: AdmissionCandidatePolicyInput,
  policy: AdmissionCandidatePolicyRegistryEntry = REGISTRY_ENTRY,
): AdmissionCandidatePolicyDecision {
  if (
    policy.policy_id !== AIONIS_ADMISSION_CANDIDATE_POLICY_ID
    || policy.policy_version !== AIONIS_ADMISSION_CANDIDATE_POLICY_VERSION
    || policy.policy_config_sha256 !== POLICY_CONFIG_SHA256
    || sha256Hex(stableStringify(policy.config)) !== POLICY_CONFIG_SHA256
    || policy.implementation_contract_sha256 !== IMPLEMENTATION_CONTRACT_SHA256
  ) {
    throw new Error("Admission candidate policy registry entry failed canonical parity validation");
  }
  return decideWithConfig(AdmissionCandidatePolicyInputSchema.parse(rawInput), policy.config);
}

export function admissionCandidatePolicyImplementationContractDigest(): string {
  return IMPLEMENTATION_CONTRACT_SHA256;
}

export function admissionCandidatePolicyBehaviorVector() {
  return behaviorVector();
}
