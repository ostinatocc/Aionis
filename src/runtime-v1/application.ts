import type { CanonicalJson, Sha256 } from "../continuation/contract.js";
import type { ContinuationRuntimeV1Principal } from "./auth.js";
import type {
  AuthenticatedDecisionQueryV1,
  AuthorityDecisionCommandV1,
  CreateContinuationCommandV1,
  RecordObservationsCommandV1,
  RecordOutcomeCommandV1,
  VerifiedAuthorityCommandBindingV1,
  VerifiedDecisionCommandBindingV1,
  VerifiedSnapshotCommandBindingV1,
} from "./command.js";

export type ContinuationRuntimeV1Readiness = Readonly<{
  ready: boolean;
  reason_codes: readonly string[];
}>;

export type ContinuationRuntimeV1SnapshotBindingSelector = Readonly<{
  principal: ContinuationRuntimeV1Principal;
  operation_id: string;
  scope: string;
  world_snapshot_id: string;
  world_snapshot_sha256: Sha256;
}>;

export type ContinuationRuntimeV1DecisionBindingSelector = Readonly<{
  principal: ContinuationRuntimeV1Principal;
  purpose: "record_outcome" | "read_decision";
  operation_id: string | null;
  scope: string;
  decision_id: string;
}>;

export type ContinuationRuntimeV1AuthorityBindingSelector = Readonly<{
  principal: ContinuationRuntimeV1Principal;
  operation_id: string;
  scope: string;
  task_family: string;
  authority_subject_sha256: Sha256;
}>;

/**
 * Product use cases exposed by the daemon. Authentication and transport
 * parsing end before this boundary; durable binding lookup and all authority
 * mutations begin behind it.
 */
export type ContinuationRuntimeV1Application = Readonly<{
  readiness(): ContinuationRuntimeV1Readiness | Promise<ContinuationRuntimeV1Readiness>;
  resolveSnapshotBinding(
    selector: ContinuationRuntimeV1SnapshotBindingSelector,
  ): VerifiedSnapshotCommandBindingV1 | Promise<VerifiedSnapshotCommandBindingV1>;
  resolveDecisionBinding(
    selector: ContinuationRuntimeV1DecisionBindingSelector,
  ): VerifiedDecisionCommandBindingV1 | Promise<VerifiedDecisionCommandBindingV1>;
  resolveAuthorityBinding(
    selector: ContinuationRuntimeV1AuthorityBindingSelector,
  ): VerifiedAuthorityCommandBindingV1 | Promise<VerifiedAuthorityCommandBindingV1>;
  recordObservations(
    command: RecordObservationsCommandV1,
  ): CanonicalJson | Promise<CanonicalJson>;
  createContinuation(
    command: CreateContinuationCommandV1,
  ): CanonicalJson | Promise<CanonicalJson>;
  recordOutcome(command: RecordOutcomeCommandV1): CanonicalJson | Promise<CanonicalJson>;
  decideAuthority(
    command: AuthorityDecisionCommandV1,
  ): CanonicalJson | Promise<CanonicalJson>;
  readDecision(query: AuthenticatedDecisionQueryV1): CanonicalJson | Promise<CanonicalJson>;
}>;

const APPLICATION_ERROR_STATUSES = new Set([400, 403, 404, 409, 422, 503]);

export class ContinuationRuntimeV1ApplicationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    if (!APPLICATION_ERROR_STATUSES.has(statusCode)
      || !/^[a-z][a-z0-9_]{0,63}$/u.test(code)) {
      throw new Error("continuation_runtime_v1_application_error_invalid");
    }
    super(code);
    this.name = "ContinuationRuntimeV1ApplicationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
