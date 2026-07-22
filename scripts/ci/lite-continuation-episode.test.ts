import assert from "node:assert/strict";
import test from "node:test";

import {
  EpisodeContractError,
  buildEffectEvidenceMemberSetV1,
  buildEpisodeCapsuleFactSetV1,
  buildEpisodeCapsuleFactV1,
  buildEpisodeEventV1,
  episodeEventRefV1,
  verifyEffectEvidenceMemberSetV1,
  verifyEpisodeCapsuleFactSetV1,
  verifyEpisodeCapsuleFactV1,
  verifyEpisodeEventBundleV1,
  verifyEpisodeEventV1,
  type EffectEvidenceMemberInputV1,
  type EpisodeDecisionContextV1,
  type EpisodeEventInputV1,
  type EpisodeEventV1,
} from "../../src/continuation/episode.js";
import { canonicalContinuationSha256 } from "../../src/continuation/contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const NOW = "2026-07-21T12:00:00.000Z";

const DECISION: EpisodeDecisionContextV1 = {
  context_kind: "decision",
  decision_id: "decision-a",
  run_id: "run-a",
  host_task_envelope_sha256: SHA_A,
  contract_sha256: SHA_B,
  coverage_certificate_sha256: SHA_C,
  render_result_sha256: SHA_D,
  authority_subject_sha256: SHA_D,
  branch_manifest_sha256: SHA_A,
};

function member(
  scope: string,
  episodeId: string,
  decisionId: string,
  digest: string,
): EffectEvidenceMemberInputV1 {
  return {
    scope,
    episode_id: episodeId,
    decision_id: decisionId,
    terminal_event: {
      event_sequence: 3,
      event_id: `outcome-${decisionId}`,
      event_kind: "outcome_observed",
      event_sha256: digest,
    },
  };
}

function mutable<T>(value: T): any {
  return JSON.parse(JSON.stringify(value));
}

function eventInput(value: EpisodeEventV1): EpisodeEventInputV1 {
  const { schema_version: _schema, payload_sha256: _payload, event_sha256: _event, ...input } = value;
  return mutable(input) as EpisodeEventInputV1;
}

function assertEpisodeFailure(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => error instanceof EpisodeContractError);
}

test("effect evidence members are per-decision canonical refs with a cycle-free digest", () => {
  const source = [
    member("scope-z", "episode-b", "decision-b", SHA_B),
    member("scope-a", "episode-z", "decision-z", SHA_C),
    member("scope-a", "episode-a", "decision-a", SHA_A),
  ];
  const first = buildEffectEvidenceMemberSetV1(source);
  const reordered = buildEffectEvidenceMemberSetV1([...source].reverse());

  assert.deepEqual(reordered, first);
  assert.deepEqual(first.members.map((entry) => [
    entry.member_sequence,
    entry.scope,
    entry.episode_id,
    entry.decision_id,
  ]), [
    [1, "scope-a", "episode-a", "decision-a"],
    [2, "scope-a", "episode-z", "decision-z"],
    [3, "scope-z", "episode-b", "decision-b"],
  ]);
  assert.equal(
    first.eligible_decision_set_sha256,
    canonicalContinuationSha256(first.members),
  );
  assert.equal("effect_certificate_sha256" in first.members[0]!, false);
  assert.equal("event_id" in first.members[0]!, false);
  assert.equal(first.members[0]!.terminal_event.event_kind, "outcome_observed");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.members), true);
  assert.equal(Object.isFrozen(first.members[0]!.terminal_event), true);

  source[0]!.terminal_event.event_sha256 = SHA_D;
  assert.equal(first.members[2]!.terminal_event.event_sha256, SHA_B);
  const changed = buildEffectEvidenceMemberSetV1([
    member("scope-z", "episode-b", "decision-b", SHA_D),
    member("scope-a", "episode-z", "decision-z", SHA_C),
    member("scope-a", "episode-a", "decision-a", SHA_A),
  ]);
  assert.notEqual(changed.eligible_decision_set_sha256, first.eligible_decision_set_sha256);

  assert.deepEqual(verifyEffectEvidenceMemberSetV1(first), first);
  const tampered = mutable(first);
  tampered.members[0].terminal_event.event_sha256 = SHA_D;
  assertEpisodeFailure(() => verifyEffectEvidenceMemberSetV1(tampered));
  assertEpisodeFailure(() => buildEffectEvidenceMemberSetV1([
    member("scope-a", "episode-a", "decision-a", SHA_A),
    member("scope-a", "episode-a", "decision-a", SHA_B),
  ]));
  assertEpisodeFailure(() => buildEffectEvidenceMemberSetV1([
    {
      ...member("scope-a", "episode-a", "decision-a", SHA_A),
      terminal_event: {
        event_sequence: 4,
        event_id: "effect-event",
        event_kind: "effect_certified",
        event_sha256: SHA_D,
      },
    } as any,
  ]));
  assertEpisodeFailure(() => buildEffectEvidenceMemberSetV1(
    Array.from({ length: 4_097 }, () => member("scope", "episode", "decision", SHA_A)),
  ));
});

test("capsule fact sets canonicalize exact exposure/use members without event digest cycles", () => {
  const exposureSource = [
    {
      capsule_scope: "scope-b",
      capsule_id: "capsule-b",
      capsule_revision: 2,
      capsule_sha256: SHA_B,
      surface: "inspect_before_use" as const,
      use_state: null,
    },
    {
      capsule_scope: "scope-a",
      capsule_id: "capsule-a",
      capsule_revision: 1,
      capsule_sha256: SHA_A,
      surface: "use_now" as const,
      use_state: null,
    },
  ];
  const exposureSet = buildEpisodeCapsuleFactSetV1("contract_exposed", exposureSource);
  assert.deepEqual(
    buildEpisodeCapsuleFactSetV1("contract_exposed", [...exposureSource].reverse()),
    exposureSet,
  );
  assert.equal(exposureSet.capsule_fact_set_sha256, canonicalContinuationSha256(exposureSet.facts));
  assert.equal("event_sha256" in exposureSet.facts[0]!, false);
  assert.equal("fact_sha256" in exposureSet.facts[0]!, false);
  assert.equal(Object.isFrozen(exposureSet.facts[0]), true);
  assert.deepEqual(verifyEpisodeCapsuleFactSetV1(exposureSet), exposureSet);

  const useSet = buildEpisodeCapsuleFactSetV1("capsule_use_observed", exposureSource.map(
    (entry, index) => ({ ...entry, use_state: index === 0 ? "unknown" as const : "used" as const }),
  ));
  assert.equal(useSet.facts.every((fact) => fact.use_state !== null), true);
  assertEpisodeFailure(() => buildEpisodeCapsuleFactSetV1(
    "contract_exposed",
    [{ ...exposureSource[0]!, use_state: "used" }],
  ));
  assertEpisodeFailure(() => buildEpisodeCapsuleFactSetV1(
    "capsule_use_observed",
    exposureSource,
  ));

  const tampered = mutable(useSet);
  tampered.facts[0].surface = "do_not_use";
  assertEpisodeFailure(() => verifyEpisodeCapsuleFactSetV1(tampered));
});

function buildInfluenceChain(): readonly EpisodeEventV1[] {
  const exposureFacts = buildEpisodeCapsuleFactSetV1("contract_exposed", [{
    capsule_scope: "scope-a",
    capsule_id: "capsule-a",
    capsule_revision: 1,
    capsule_sha256: SHA_A,
    surface: "use_now",
    use_state: null,
  }]);
  const useFacts = buildEpisodeCapsuleFactSetV1("capsule_use_observed", [{
    capsule_scope: "scope-a",
    capsule_id: "capsule-a",
    capsule_revision: 1,
    capsule_sha256: SHA_A,
    surface: "use_now",
    use_state: "used",
  }]);
  const exposure = buildEpisodeEventV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    episode_id: "episode-a",
    event_sequence: 1,
    event_id: "exposure-a",
    event_kind: "contract_exposed",
    source_operation: {
      operation_kind: "create_continuation",
      operation_id: "continue-a",
      request_sha256: SHA_A,
    },
    previous_event_ref: null,
    cause_event_ref: null,
    context: DECISION,
    render_result_sha256: SHA_D,
    effect_certificate_sha256: null,
    effect_member_sequence: null,
    capsule_fact_count: exposureFacts.capsule_fact_count,
    capsule_fact_set_sha256: exposureFacts.capsule_fact_set_sha256,
    payload: {
      payload_kind: "contract_exposed_v1",
      continuation_contract: { schema_version: "continuation_contract_v1", contract_sha256: SHA_B },
      render_result: { status: "rendered", render_result_sha256: SHA_D },
    },
    created_at: NOW,
  });
  const outcomeOperation = {
    operation_kind: "record_outcome" as const,
    operation_id: "outcome-a",
    request_sha256: SHA_B,
  };
  const use = buildEpisodeEventV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    episode_id: "episode-a",
    event_sequence: 2,
    event_id: "use-a",
    event_kind: "capsule_use_observed",
    source_operation: outcomeOperation,
    previous_event_ref: episodeEventRefV1(exposure),
    cause_event_ref: episodeEventRefV1(exposure),
    context: DECISION,
    render_result_sha256: SHA_D,
    effect_certificate_sha256: null,
    effect_member_sequence: null,
    capsule_fact_count: useFacts.capsule_fact_count,
    capsule_fact_set_sha256: useFacts.capsule_fact_set_sha256,
    payload: {
      payload_kind: "capsule_use_observed_v1",
      use_receipt: { receipt_id: "use-receipt-a", use_state: "used" },
    },
    created_at: "2026-07-21T12:01:00.000Z",
  });
  const outcome = buildEpisodeEventV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    episode_id: "episode-a",
    event_sequence: 3,
    event_id: "outcome-a",
    event_kind: "outcome_observed",
    source_operation: outcomeOperation,
    previous_event_ref: episodeEventRefV1(use),
    cause_event_ref: episodeEventRefV1(use),
    context: DECISION,
    render_result_sha256: SHA_D,
    effect_certificate_sha256: null,
    effect_member_sequence: null,
    capsule_fact_count: null,
    capsule_fact_set_sha256: null,
    payload: {
      payload_kind: "outcome_observed_v1",
      outcome_receipt: { receipt_id: "outcome-receipt-a", status: "verified" },
    },
    created_at: "2026-07-21T12:02:00.000Z",
  });
  const memberSet = buildEffectEvidenceMemberSetV1([{
    scope: "scope-a",
    episode_id: "episode-a",
    decision_id: "decision-a",
    terminal_event: episodeEventRefV1(outcome) as any,
  }]);
  const effect = buildEpisodeEventV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    episode_id: "episode-a",
    event_sequence: 4,
    event_id: "effect-member-a",
    event_kind: "effect_certified",
    source_operation: {
      operation_kind: "worker_completion",
      operation_id: "effect-worker-a",
      request_sha256: SHA_C,
    },
    previous_event_ref: episodeEventRefV1(outcome),
    cause_event_ref: episodeEventRefV1(outcome),
    context: DECISION,
    render_result_sha256: SHA_D,
    effect_certificate_sha256: SHA_D,
    effect_member_sequence: 1,
    capsule_fact_count: null,
    capsule_fact_set_sha256: null,
    payload: {
      payload_kind: "effect_certified_v1",
      evidence_member: memberSet.members[0]!,
    },
    created_at: "2026-07-21T13:00:00.000Z",
  });
  return [exposure, use, outcome, effect];
}

test("episode events form one typed exact-cause bundle and facts bind an exact event", () => {
  const chain = buildInfluenceChain();
  const verified = verifyEpisodeEventBundleV1(chain);
  assert.deepEqual(verified, chain);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified[0]!.payload), true);
  assert.equal(Object.isFrozen(verified[3]!.cause_event_ref), true);

  const factSet = buildEpisodeCapsuleFactSetV1("contract_exposed", [{
    capsule_scope: "scope-a",
    capsule_id: "capsule-a",
    capsule_revision: 1,
    capsule_sha256: SHA_A,
    surface: "use_now",
    use_state: null,
  }]);
  const fact = buildEpisodeCapsuleFactV1({
    tenant_id: "tenant-a",
    scope: "scope-a",
    episode_id: "episode-a",
    event_ref: episodeEventRefV1(chain[0]!) as any,
    fact: factSet.facts[0]!,
  });
  assert.deepEqual(verifyEpisodeCapsuleFactV1(fact), fact);
  assert.equal(Object.isFrozen(fact.fact), true);

  const tampered = mutable(chain[2]);
  tampered.payload.outcome_receipt.status = "changed";
  assertEpisodeFailure(() => verifyEpisodeEventV1(tampered));

  const wrongContext = buildEpisodeEventV1({
    ...eventInput(chain[2]!),
    previous_event_ref: episodeEventRefV1(chain[1]!),
    cause_event_ref: episodeEventRefV1(chain[1]!),
    context: { ...DECISION, decision_id: "decision-other" },
  });
  assertEpisodeFailure(() => verifyEpisodeEventBundleV1([
    chain[0], chain[1], wrongContext,
  ]));
  assertEpisodeFailure(() => verifyEpisodeEventBundleV1(chain.slice(0, 2)));
});

test("an eligible decision without an outcome is represented by an exact exposure member", () => {
  const exposure = buildInfluenceChain()[0]!;
  const missingSet = buildEffectEvidenceMemberSetV1([{
    scope: exposure.scope,
    episode_id: exposure.episode_id,
    decision_id: DECISION.decision_id,
    terminal_event: episodeEventRefV1(exposure) as any,
  }]);
  const effect = buildEpisodeEventV1({
    tenant_id: exposure.tenant_id,
    scope: exposure.scope,
    episode_id: exposure.episode_id,
    event_sequence: 2,
    event_id: "effect-member-missing-outcome",
    event_kind: "effect_certified",
    source_operation: {
      operation_kind: "worker_completion",
      operation_id: "effect-worker-missing",
      request_sha256: SHA_C,
    },
    previous_event_ref: episodeEventRefV1(exposure),
    cause_event_ref: episodeEventRefV1(exposure),
    context: DECISION,
    render_result_sha256: SHA_D,
    effect_certificate_sha256: SHA_D,
    effect_member_sequence: 1,
    capsule_fact_count: null,
    capsule_fact_set_sha256: null,
    payload: {
      payload_kind: "effect_certified_v1",
      evidence_member: missingSet.members[0]!,
    },
    created_at: "2026-07-21T13:00:00.000Z",
  });
  assert.deepEqual(verifyEpisodeEventBundleV1([exposure, effect]), [exposure, effect]);
  assert.equal(missingSet.members[0]!.terminal_event.event_kind, "contract_exposed");
});

test("episode contracts reject unknown fields, symbols, accessors, invalid Unicode and timestamps", () => {
  const event = buildInfluenceChain()[0]!;
  const unknown = mutable(event);
  unknown.unknown = true;
  assertEpisodeFailure(() => verifyEpisodeEventV1(unknown));

  const symbolic = mutable(event);
  symbolic[Symbol("hidden")] = true;
  assertEpisodeFailure(() => verifyEpisodeEventV1(symbolic));

  let invoked = false;
  const accessor = eventInput(event) as any;
  Object.defineProperty(accessor, "event_id", {
    configurable: true,
    enumerable: true,
    get() {
      invoked = true;
      return "accessed";
    },
  });
  assertEpisodeFailure(() => buildEpisodeEventV1(accessor));
  assert.equal(invoked, false);

  const badUnicode = eventInput(event) as any;
  Object.defineProperty(badUnicode, "event_id", {
    enumerable: true,
    configurable: true,
    value: "bad\ud800",
  });
  assertEpisodeFailure(() => buildEpisodeEventV1(badUnicode));

  const badTime = eventInput(event) as any;
  Object.defineProperty(badTime, "event_id", {
    enumerable: true,
    configurable: true,
    value: "event-a",
  });
  badTime.created_at = "2026-07-21T12:00:00Z";
  assertEpisodeFailure(() => buildEpisodeEventV1(badTime));

  const wrongPayload = eventInput(event) as any;
  Object.defineProperty(wrongPayload, "event_id", {
    enumerable: true,
    configurable: true,
    value: "event-a",
  });
  wrongPayload.payload = { payload_kind: "contract_exposed_v1", extra: true };
  assertEpisodeFailure(() => buildEpisodeEventV1(wrongPayload));
});
