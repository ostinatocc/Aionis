import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import stableStringify from "fast-json-stable-stringify";

import {
  ExecutionEpisodeSubjectIdentityV1Schema,
  VerifierInvocationV1Schema,
  verifierInvocationDigest,
  type ExecutionEpisodeSubjectIdentityV1,
  type VerifierInvocationV1,
} from "../memory/execution-episode.js";
import { sha256Hex } from "../util/crypto.js";
import {
  assertAuthenticVerifierSubjectMaterialization,
  type VerifierSubjectMaterializationV1,
} from "./verifier-subject-materialization.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ID_BYTES = 256;
const MAX_SOURCE_SUBJECT_ROOT_BYTES = 16 * 1024;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type ChannelToken = Readonly<{ nonce: string }>;

export type RuntimeEpisodeVerifierLaunchRequirementV1 = Readonly<{
  contract_version: "runtime_episode_verifier_launch_requirement_v1";
  verifier_id: string;
  verifier_definition_sha256: string;
  verifier_program_digest: string;
  verifier_config_digest: string;
  verifier_environment_digest: string;
}>;

/**
 * Process-local proof that the official episode store loaded and verified the
 * exact persisted invocation row/operation receipt. Its fields are useful for
 * audit, but only the WeakMap capability grants authority.
 */
export type RuntimeEpisodeVerifierPersistedReservationV1 = Readonly<{
  contract_version: "runtime_episode_verifier_persisted_reservation_v1";
  episode_id: string;
  verifier_invocation_id: string;
  verifier_invocation_digest: string;
  required_verifier: DeepReadonly<
    RuntimeEpisodeVerifierLaunchRequirementV1
  >;
  reservation_sha256: string;
}>;

export type RuntimeEpisodeVerifierInvocationAuthorityV1 = Readonly<{
  contract_version: "runtime_episode_verifier_invocation_authority_v1";
  episode_id: string;
  verifier_invocation_id: string;
  verifier_invocation_digest: string;
  required_verifier: DeepReadonly<
    RuntimeEpisodeVerifierLaunchRequirementV1
  >;
  source_content_digest: string;
  source_environment_digest: string;
  subject_identity: DeepReadonly<ExecutionEpisodeSubjectIdentityV1>;
  materialization_id: string;
  subject_view_content_digest: string;
  subject_view_environment_digest: string;
  authority_sha256: string;
}>;

export type IssueRuntimeEpisodeVerifierPersistedReservationInput =
  Readonly<{
    /**
     * This method is intentionally available only on the issuer capability
     * held by the official episode store. The store calls it after reading and
     * validating the committed invocation row and operation receipt.
     */
    persisted_invocation: VerifierInvocationV1;
    persisted_invocation_digest: string;
  }>;

export type AuthorizeRuntimeEpisodeVerifierMaterializedLaunchInput =
  Readonly<{
    persisted_reservation:
      RuntimeEpisodeVerifierPersistedReservationV1;
    subject_identity: ExecutionEpisodeSubjectIdentityV1;
    source_subject_root: string;
    source_content_digest: string;
    source_environment_digest: string;
    materialization: VerifierSubjectMaterializationV1;
  }>;

export type RuntimeEpisodeVerifierInvocationAuthorityIssuer =
  Readonly<{
    issuePersistedReservation(
      input: IssueRuntimeEpisodeVerifierPersistedReservationInput,
    ): RuntimeEpisodeVerifierPersistedReservationV1;
    authorizeMaterializedLaunch(
      input: AuthorizeRuntimeEpisodeVerifierMaterializedLaunchInput,
    ): RuntimeEpisodeVerifierInvocationAuthorityV1;
  }>;

export type RuntimeEpisodeVerifierInvocationAuthorityVerifier =
  Readonly<{
    contract_version:
      "runtime_episode_verifier_invocation_authority_verifier_v1";
    channel_id: string;
  }>;

export type RuntimeEpisodeVerifierInvocationAuthorityChannel =
  Readonly<{
    issuer: RuntimeEpisodeVerifierInvocationAuthorityIssuer;
    verifier: RuntimeEpisodeVerifierInvocationAuthorityVerifier;
  }>;

export type AuthenticRuntimeEpisodeVerifierInvocationAuthority =
  Readonly<{
    episodeId: string;
    verifierInvocationId: string;
    verifierInvocationDigest: string;
    requiredVerifier: DeepReadonly<
      RuntimeEpisodeVerifierLaunchRequirementV1
    >;
    sourceContentDigest: string;
    sourceEnvironmentDigest: string;
    sourceSubjectRoot: string;
    subjectIdentity: DeepReadonly<ExecutionEpisodeSubjectIdentityV1>;
    materializationId: string;
    materialization: VerifierSubjectMaterializationV1;
    subjectViewContentDigest: string;
    subjectViewEnvironmentDigest: string;
    authoritySha256: string;
  }>;

type AuthenticPersistedReservation = Readonly<{
  channelToken: ChannelToken;
  invocation: DeepReadonly<VerifierInvocationV1>;
  invocationDigest: string;
  requiredVerifier: DeepReadonly<
    RuntimeEpisodeVerifierLaunchRequirementV1
  >;
  reservationSha256: string;
}>;

type AuthenticInvocationAuthorityRecord =
  AuthenticRuntimeEpisodeVerifierInvocationAuthority
  & Readonly<{ channelToken: ChannelToken }>;

export class RuntimeEpisodeVerifierInvocationAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RuntimeEpisodeVerifierInvocationAuthorityError";
    this.code = code;
  }
}

const AUTHENTIC_VERIFIERS = new WeakMap<
  RuntimeEpisodeVerifierInvocationAuthorityVerifier,
  ChannelToken
>();
const AUTHENTIC_RESERVATIONS = new WeakMap<
  RuntimeEpisodeVerifierPersistedReservationV1,
  AuthenticPersistedReservation
>();
const CONSUMED_RESERVATIONS = new WeakSet<
  RuntimeEpisodeVerifierPersistedReservationV1
>();
const AUTHENTIC_AUTHORITIES = new WeakMap<
  RuntimeEpisodeVerifierInvocationAuthorityV1,
  AuthenticInvocationAuthorityRecord
>();
const CONSUMED_AUTHORITIES = new WeakSet<
  RuntimeEpisodeVerifierInvocationAuthorityV1
>();

function fail(code: string): never {
  throw new RuntimeEpisodeVerifierInvocationAuthorityError(code);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function exactId(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("\u0000")
    || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES
  ) {
    return fail(code);
  }
  return value;
}

function exactSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return fail(code);
  }
  return value;
}

function canonicalSourceSubjectRoot(
  value: unknown,
  expectedDigest: string,
  subjectKind: ExecutionEpisodeSubjectIdentityV1["state_kind"],
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || !isAbsolute(value)
    || value.includes("\u0000")
    || value.includes("\n")
    || value.includes("\r")
    || Buffer.byteLength(value, "utf8") > MAX_SOURCE_SUBJECT_ROOT_BYTES
  ) {
    return fail("runtime_episode_verifier_authority_source_root_invalid");
  }
  let root: string;
  try {
    root = realpathSync.native(value);
    const stats = lstatSync(root);
    const expectedRepresentation = subjectKind === "workspace"
      ? "directory"
      : subjectKind === "artifact" || subjectKind === "database"
        ? "file"
        : null;
    if (
      expectedRepresentation === null
      || stats.isSymbolicLink()
      || (
        expectedRepresentation === "directory"
          ? !stats.isDirectory()
          : !stats.isFile()
      )
    ) {
      return fail(
        "runtime_episode_verifier_authority_source_representation_invalid",
      );
    }
  } catch (error) {
    if (error instanceof RuntimeEpisodeVerifierInvocationAuthorityError) {
      throw error;
    }
    return fail(
      "runtime_episode_verifier_authority_source_root_unresolvable",
    );
  }
  if (sha256Hex(root) !== expectedDigest) {
    return fail(
      "runtime_episode_verifier_authority_subject_root_identity_mismatch",
    );
  }
  return root;
}

function requirementFromInvocation(
  invocation: VerifierInvocationV1,
): DeepReadonly<RuntimeEpisodeVerifierLaunchRequirementV1> {
  return deepFreeze({
    contract_version:
      "runtime_episode_verifier_launch_requirement_v1" as const,
    verifier_id: exactId(
      invocation.verifier_id,
      "runtime_episode_verifier_authority_verifier_id_invalid",
    ),
    verifier_definition_sha256: exactSha256(
      invocation.verifier_definition_sha256,
      "runtime_episode_verifier_authority_definition_digest_invalid",
    ),
    verifier_program_digest: exactSha256(
      invocation.verifier_program_digest,
      "runtime_episode_verifier_authority_program_digest_invalid",
    ),
    verifier_config_digest: exactSha256(
      invocation.verifier_config_digest,
      "runtime_episode_verifier_authority_config_digest_invalid",
    ),
    verifier_environment_digest: exactSha256(
      invocation.verifier_environment_digest,
      "runtime_episode_verifier_authority_environment_digest_invalid",
    ),
  });
}

function reservationDigest(
  value: Omit<
    RuntimeEpisodeVerifierPersistedReservationV1,
    "reservation_sha256"
  >,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_persisted_reservation_digest_v1",
    reservation: value,
  }));
}

function authorityDigest(
  value: Omit<
    RuntimeEpisodeVerifierInvocationAuthorityV1,
    "authority_sha256"
  >,
): string {
  return sha256Hex(stableStringify({
    contract: "runtime_episode_verifier_invocation_authority_digest_v1",
    authority: value,
  }));
}

function authenticVerifierChannel(
  verifier: RuntimeEpisodeVerifierInvocationAuthorityVerifier,
): ChannelToken {
  const token = AUTHENTIC_VERIFIERS.get(verifier);
  if (
    !token
    || verifier.contract_version
      !== "runtime_episode_verifier_invocation_authority_verifier_v1"
    || verifier.channel_id !== token.nonce
  ) {
    return fail(
      "runtime_episode_verifier_invocation_authority_verifier_not_authentic",
    );
  }
  return token;
}

export function createRuntimeEpisodeVerifierInvocationAuthorityChannel(
): RuntimeEpisodeVerifierInvocationAuthorityChannel {
  const channelToken = Object.freeze({
    nonce: `rviac_${sha256Hex(randomUUID())}`,
  });
  const verifier:
    RuntimeEpisodeVerifierInvocationAuthorityVerifier = Object.freeze({
      contract_version:
        "runtime_episode_verifier_invocation_authority_verifier_v1",
      channel_id: channelToken.nonce,
    });
  AUTHENTIC_VERIFIERS.set(verifier, channelToken);

  const issuePersistedReservation = (
    input: IssueRuntimeEpisodeVerifierPersistedReservationInput,
  ): RuntimeEpisodeVerifierPersistedReservationV1 => {
    const invocation = deepFreeze(
      VerifierInvocationV1Schema.parse(input.persisted_invocation),
    );
    const invocationDigest = exactSha256(
      input.persisted_invocation_digest,
      "runtime_episode_verifier_authority_invocation_digest_invalid",
    );
    if (invocationDigest !== verifierInvocationDigest(invocation)) {
      return fail(
        "runtime_episode_verifier_authority_invocation_digest_mismatch",
      );
    }
    if (invocation.launch_authority.kind !== "runtime_launched") {
      return fail(
        "runtime_episode_verifier_authority_runtime_reservation_required",
      );
    }
    const requiredVerifier = requirementFromInvocation(invocation);
    const material = deepFreeze({
      contract_version:
        "runtime_episode_verifier_persisted_reservation_v1" as const,
      episode_id: exactId(
        invocation.episode_id,
        "runtime_episode_verifier_authority_episode_id_invalid",
      ),
      verifier_invocation_id: exactId(
        invocation.verifier_invocation_id,
        "runtime_episode_verifier_authority_invocation_id_invalid",
      ),
      verifier_invocation_digest: invocationDigest,
      required_verifier: requiredVerifier,
    });
    const reservation =
      deepFreeze<RuntimeEpisodeVerifierPersistedReservationV1>({
        ...material,
        reservation_sha256: reservationDigest(material),
      });
    AUTHENTIC_RESERVATIONS.set(reservation, {
      channelToken,
      invocation,
      invocationDigest,
      requiredVerifier,
      reservationSha256: reservation.reservation_sha256,
    });
    return reservation;
  };

  const authorizeMaterializedLaunch = (
    input: AuthorizeRuntimeEpisodeVerifierMaterializedLaunchInput,
  ): RuntimeEpisodeVerifierInvocationAuthorityV1 => {
    const reservationRecord = AUTHENTIC_RESERVATIONS.get(
      input.persisted_reservation,
    );
    if (
      !reservationRecord
      || reservationRecord.channelToken !== channelToken
      || input.persisted_reservation.verifier_invocation_digest
        !== reservationRecord.invocationDigest
      || input.persisted_reservation.required_verifier
        !== reservationRecord.requiredVerifier
      || input.persisted_reservation.reservation_sha256
        !== reservationRecord.reservationSha256
    ) {
      return fail(
        "runtime_episode_verifier_persisted_reservation_not_authentic",
      );
    }
    if (CONSUMED_RESERVATIONS.has(input.persisted_reservation)) {
      return fail(
        "runtime_episode_verifier_persisted_reservation_already_consumed",
      );
    }

    const subjectIdentity = ExecutionEpisodeSubjectIdentityV1Schema.parse(
      input.subject_identity,
    );
    const sourceSubjectRoot = canonicalSourceSubjectRoot(
      input.source_subject_root,
      subjectIdentity.canonical_root_sha256,
      subjectIdentity.state_kind,
    );
    const sourceContentDigest = exactSha256(
      input.source_content_digest,
      "runtime_episode_verifier_authority_source_content_digest_invalid",
    );
    const sourceEnvironmentDigest = exactSha256(
      input.source_environment_digest,
      "runtime_episode_verifier_authority_source_environment_digest_invalid",
    );
    if (
      sourceEnvironmentDigest
        !== reservationRecord.requiredVerifier.verifier_environment_digest
    ) {
      return fail(
        "runtime_episode_verifier_authority_source_environment_mismatch",
      );
    }
    const materializationRecord =
      assertAuthenticVerifierSubjectMaterialization(input.materialization);
    if (
      materializationRecord.sourceContentDigest !== sourceContentDigest
      || materializationRecord.sourceEnvironmentDigest
        !== sourceEnvironmentDigest
    ) {
      return fail(
        "runtime_episode_verifier_authority_materialization_source_mismatch",
      );
    }
    if (
      stableStringify(input.materialization.subject_state_spec)
        !== stableStringify(subjectIdentity.subject_state_spec)
      || input.materialization.verification_view.algorithm_id
        !== subjectIdentity.capture_algorithm_id
      || input.materialization.verification_view.algorithm_version
        !== subjectIdentity.capture_algorithm_version
    ) {
      return fail(
        "runtime_episode_verifier_authority_materialization_subject_mismatch",
      );
    }

    CONSUMED_RESERVATIONS.add(input.persisted_reservation);
    const material = deepFreeze({
      contract_version:
        "runtime_episode_verifier_invocation_authority_v1" as const,
      episode_id: input.persisted_reservation.episode_id,
      verifier_invocation_id:
        input.persisted_reservation.verifier_invocation_id,
      verifier_invocation_digest: reservationRecord.invocationDigest,
      required_verifier: reservationRecord.requiredVerifier,
      source_content_digest: sourceContentDigest,
      source_environment_digest: sourceEnvironmentDigest,
      subject_identity: subjectIdentity,
      materialization_id: materializationRecord.materializationId,
      subject_view_content_digest:
        materializationRecord.verificationViewContentDigest,
      subject_view_environment_digest:
        materializationRecord.verificationViewEnvironmentDigest,
    });
    const authority =
      deepFreeze<RuntimeEpisodeVerifierInvocationAuthorityV1>({
        ...material,
        authority_sha256: authorityDigest(material),
      });
    AUTHENTIC_AUTHORITIES.set(authority, {
      channelToken,
      episodeId: authority.episode_id,
      verifierInvocationId: authority.verifier_invocation_id,
      verifierInvocationDigest: authority.verifier_invocation_digest,
      requiredVerifier: authority.required_verifier,
      sourceContentDigest,
      sourceEnvironmentDigest,
      sourceSubjectRoot,
      subjectIdentity: authority.subject_identity,
      materializationId: materializationRecord.materializationId,
      materialization: input.materialization,
      subjectViewContentDigest:
        materializationRecord.verificationViewContentDigest,
      subjectViewEnvironmentDigest:
        materializationRecord.verificationViewEnvironmentDigest,
      authoritySha256: authority.authority_sha256,
    });
    return authority;
  };

  return Object.freeze({
    issuer: Object.freeze({
      issuePersistedReservation,
      authorizeMaterializedLaunch,
    }),
    verifier,
  });
}

export function assertAuthenticRuntimeEpisodeVerifierInvocationAuthority(
  value: RuntimeEpisodeVerifierInvocationAuthorityV1,
  verifier: RuntimeEpisodeVerifierInvocationAuthorityVerifier,
): AuthenticRuntimeEpisodeVerifierInvocationAuthority {
  const channelToken = authenticVerifierChannel(verifier);
  const record = AUTHENTIC_AUTHORITIES.get(value);
  if (
    !record
    || record.channelToken !== channelToken
    || value.episode_id !== record.episodeId
    || value.verifier_invocation_id !== record.verifierInvocationId
    || value.verifier_invocation_digest !== record.verifierInvocationDigest
    || value.required_verifier !== record.requiredVerifier
    || value.source_content_digest !== record.sourceContentDigest
    || value.source_environment_digest !== record.sourceEnvironmentDigest
    || value.subject_identity !== record.subjectIdentity
    || value.materialization_id !== record.materializationId
    || value.subject_view_content_digest
      !== record.subjectViewContentDigest
    || value.subject_view_environment_digest
      !== record.subjectViewEnvironmentDigest
    || value.authority_sha256 !== record.authoritySha256
  ) {
    return fail(
      "runtime_episode_verifier_invocation_authority_not_authentic",
    );
  }
  return record;
}

export function consumeRuntimeEpisodeVerifierInvocationAuthority(
  value: RuntimeEpisodeVerifierInvocationAuthorityV1,
  verifier: RuntimeEpisodeVerifierInvocationAuthorityVerifier,
): AuthenticRuntimeEpisodeVerifierInvocationAuthority {
  const record =
    assertAuthenticRuntimeEpisodeVerifierInvocationAuthority(value, verifier);
  if (CONSUMED_AUTHORITIES.has(value)) {
    return fail(
      "runtime_episode_verifier_invocation_authority_already_consumed",
    );
  }
  CONSUMED_AUTHORITIES.add(value);
  return record;
}
