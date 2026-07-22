import {
  assertCanonicalUtcMillis,
  canonicalContinuationSha256,
  type HostObservationV1,
  type PreconditionEvaluationV1,
  type Sha256,
  type TypedPreconditionSpecV1,
} from "./contract.js";
import { assertTypedPreconditionSpecV1 } from "./validation.js";
import { verifyHostObservationAttestationV1 } from "./observation-attestation.js";

function boundedText(value: string, maxBytes: number): boolean {
  return value.length > 0
    && value === value.trim()
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function validatePreconditionSpecV1(spec: TypedPreconditionSpecV1): void {
  assertTypedPreconditionSpecV1(spec);
  if (!boundedText(spec.probe_id, 256)
    || !Number.isSafeInteger(spec.max_age_ms)
    || spec.max_age_ms <= 0
    || spec.max_age_ms > 31 * 24 * 60 * 60 * 1000) {
    throw new Error("precondition probe identity or max age is invalid");
  }
  if (spec.kind === "artifact") {
    const segments = spec.relative_path.split("/");
    if (!boundedText(spec.workspace_id, 256)
      || !boundedText(spec.relative_path, 1024)
      || spec.relative_path.startsWith("/")
      || spec.relative_path.includes("\\")
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("artifact probe path must be a bounded repository-relative POSIX path");
    }
  }
  if (spec.kind === "service"
    && (!boundedText(spec.endpoint_id, 256) || spec.endpoint_id.includes("://"))) {
    throw new Error("service probe must use a registered endpoint id, not a URL");
  }
  if (spec.kind === "verifier" && !boundedText(spec.verifier_id, 256)) {
    throw new Error("verifier probe must use a registered verifier id");
  }
  if (spec.kind === "capability"
    && (!boundedText(spec.capability_id, 256)
      || (spec.expected_version !== null && !boundedText(spec.expected_version, 120)))) {
    throw new Error("capability probe identity is invalid");
  }
}

function probeValueSatisfied(spec: TypedPreconditionSpecV1, observation: HostObservationV1): boolean {
  const value = observation.value;
  if (spec.kind !== value.kind) return false;
  switch (spec.kind) {
    case "artifact":
      return value.kind === "artifact"
        && value.presence === spec.expected_presence
        && (spec.expected_kind === null || value.artifact_kind === spec.expected_kind)
        && (spec.expected_content_sha256 === null || value.content_sha256 === spec.expected_content_sha256);
    case "workspace":
      return value.kind === "workspace"
        && (spec.expected_revision === null || value.revision === spec.expected_revision)
        && (spec.expected_tree_sha256 === null || value.tree_sha256 === spec.expected_tree_sha256)
        && (spec.dirty_state === "either" || value.dirty_state === spec.dirty_state);
    case "verifier":
      return value.kind === "verifier"
        && value.verifier_id === spec.verifier_id
        && value.config_sha256 === spec.config_sha256
        && value.result === spec.expected_result
        && (!spec.require_fresh_process || value.fresh_process)
        && (!spec.require_after_agent_exit || value.after_agent_exit);
    case "service":
      return value.kind === "service"
        && value.endpoint_id === spec.endpoint_id
        && value.protocol === spec.protocol
        && value.health === spec.expected_health
        && (!spec.require_external_visibility || value.externally_visible)
        && (!spec.require_after_agent_exit || value.after_agent_exit);
    case "capability":
      return value.kind === "capability"
        && value.capability_id === spec.capability_id
        && value.presence === spec.expected_presence
        && (spec.expected_version === null || value.version === spec.expected_version);
  }
}

export function evaluatePreconditionV1(args: {
  spec: TypedPreconditionSpecV1;
  observation: HostObservationV1 | null;
  host_task_envelope_sha256: Sha256;
  world_snapshot_id: string;
  trusted_observer_principal_sha256s: ReadonlySet<Sha256>;
  compiled_at: string;
}): PreconditionEvaluationV1 {
  const unknown = (reason: string): PreconditionEvaluationV1 => ({
    probe_id: args.spec.probe_id,
    status: "unknown",
    observation_id: args.observation?.observation_id ?? null,
    reason_codes: [reason],
  });
  try {
    validatePreconditionSpecV1(args.spec);
  } catch {
    return unknown("probe_spec_invalid");
  }
  const observation = args.observation;
  if (!observation) return unknown("probe_observation_missing");
  try {
    verifyHostObservationAttestationV1(observation);
  } catch {
    return unknown("probe_observation_attestation_invalid");
  }
  if (observation.probe_id !== args.spec.probe_id) return unknown("probe_id_mismatch");
  if (observation.probe_spec_sha256 !== canonicalContinuationSha256(args.spec)) {
    return unknown("probe_spec_digest_mismatch");
  }
  if (observation.observer !== args.spec.observer
    || !args.trusted_observer_principal_sha256s.has(observation.observer_principal_sha256)) {
    return unknown("probe_observer_unauthorized");
  }
  if (observation.host_task_envelope_sha256 !== args.host_task_envelope_sha256
    || observation.world_snapshot_id !== args.world_snapshot_id) return unknown("probe_binding_mismatch");
  try {
    assertCanonicalUtcMillis(args.compiled_at);
    assertCanonicalUtcMillis(observation.observed_at);
    assertCanonicalUtcMillis(observation.expires_at);
  } catch {
    return unknown("probe_timestamp_invalid");
  }
  const compiledAt = Date.parse(args.compiled_at);
  const observedAt = Date.parse(observation.observed_at);
  const expiresAt = Date.parse(observation.expires_at);
  if (observedAt > compiledAt || expiresAt < compiledAt
    || compiledAt - observedAt > args.spec.max_age_ms
    || expiresAt - observedAt > args.spec.max_age_ms) return unknown("probe_observation_stale");
  const satisfied = probeValueSatisfied(args.spec, observation);
  return {
    probe_id: args.spec.probe_id,
    status: satisfied ? "satisfied" : "unsatisfied",
    observation_id: observation.observation_id,
    reason_codes: satisfied ? [] : ["probe_value_unsatisfied"],
  };
}
