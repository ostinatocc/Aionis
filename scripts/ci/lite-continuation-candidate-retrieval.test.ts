import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalContinuationSha256,
  canonicalSha256Without,
  canonicalUniqueSet,
  type CapsuleRefV1,
  type ContinuationContractV1,
  type ContinuationObligationV1,
  type ExecutionCapsuleV1,
} from "../../src/continuation/contract.js";
import type { ContinuationCompilerCandidateV1 } from
  "../../src/continuation/compiler.js";
import type { ContinuationCompilerPolicyV1 } from
  "../../src/continuation/compiler-policy.js";
import { continuationAuthoritySubjectSha256V1 } from
  "../../src/continuation/task-envelope.js";
import {
  CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1,
  retrieveContinuationCandidatesV1,
  verifyContinuationCandidateRetrievalReceiptV1,
} from "../../src/continuation/candidate-retrieval.js";

const NOW = "2026-07-22T12:00:00.000Z";
const MEMORY_HEAD = "8".repeat(64);

const IDENTITY: ContinuationContractV1["identity"] = {
  decision_id: "decision-1",
  tenant_id: "tenant-1",
  scope: "scope-1",
  episode_id: "episode-1",
  run_id: "run-1",
  host_task_id: "host-task-1",
  host_task_envelope_sha256: "1".repeat(64),
  collection_principal_sha256: "2".repeat(64),
  consumer_agent_id: "agent-1",
  consumer_team_id: null,
  task_family: "repair",
  task_signature: "repair-ts",
  workflow_signature: null,
  workspace_signature: "workspace-1",
  source_task_sha256: "3".repeat(64),
  source_event_sha256: "4".repeat(64),
  world_snapshot_id: "snapshot-1",
  world_snapshot_sha256: "5".repeat(64),
};
const SUBJECT = continuationAuthoritySubjectSha256V1({
  tenant_id: IDENTITY.tenant_id,
  scope: IDENTITY.scope,
  task_family: IDENTITY.task_family,
});

function policy(
  continuityCandidateLimit = 4,
  learningCandidateLimit = 4,
): ContinuationCompilerPolicyV1 {
  return {
    schema_version: "continuation_compiler_policy_v1",
    tenant_id: IDENTITY.tenant_id,
    authority_subject_sha256: SUBJECT,
    candidate_limit: continuityCandidateLimit + learningCandidateLimit,
    continuity_candidate_limit: continuityCandidateLimit,
    learning_candidate_limit: learningCandidateLimit,
    selected_capsule_limit: Math.min(64, continuityCandidateLimit + learningCandidateLimit),
    obligation_limit: 64,
    max_render_budget: 65_536,
    hard_coverage_weight: 1_000_000,
    advisory_coverage_weight: 10_000,
    authority_bonus: { candidate: 0, verified: 64, authoritative: 128 },
    freshness_bonus: [0, 2, 4, 8],
    freshness_max_age_ms: [3_600_000, 86_400_000, 604_800_000],
    trusted_observer_principals: {
      trusted_host_collector: [],
      external_verifier: [],
    },
  };
}

function obligation(
  id: string,
  requirement: ContinuationObligationV1["requirement"] = "advisory",
  target = `target:${id}`,
): ContinuationObligationV1 {
  return {
    obligation_id: id,
    kind: "required_state",
    requirement,
    statement: `Satisfy ${id}`,
    target_refs: [{ kind: "memory", ref: target }],
    required_probe_ids: [],
    evidence_requirement: "runtime_state",
    source_refs: [],
  };
}

function ref(capsule: ExecutionCapsuleV1): CapsuleRefV1 {
  return {
    capsule_id: capsule.capsule_id,
    capsule_revision: capsule.capsule_revision,
    capsule_sha256: capsule.capsule_sha256,
  };
}

function capsule(args: Readonly<{
  id: string;
  lane: "verified_continuity" | "governed_learning";
  claim: ContinuationObligationV1;
  kind?: ExecutionCapsuleV1["kind"];
  authority?: "candidate" | "verified" | "authoritative";
  created_at?: string;
  conflicts_with?: readonly CapsuleRefV1[];
  supersedes?: readonly CapsuleRefV1[];
}>): ExecutionCapsuleV1 {
  const claimBody = {
    obligation_kind: args.claim.kind,
    target_refs: args.claim.target_refs,
    evidence_requirement: args.claim.evidence_requirement,
    required_probe_ids: args.claim.required_probe_ids,
  } as const;
  const coverageClaim = {
    ...claimBody,
    coverage_claim_sha256: canonicalContinuationSha256(claimBody),
  };
  const projectionBody = {
    summary: `Projection ${args.id}`,
    next_action: null,
    target_refs: args.claim.target_refs,
    workflow_steps: [],
    acceptance_statements: [],
  } as const;
  const kind = args.kind ?? (args.lane === "verified_continuity" ? "verified_fact" : "procedure");
  const body = {
    schema_version: "execution_capsule_v1" as const,
    capsule_id: args.id,
    capsule_revision: 1,
    created_at: args.created_at ?? "2026-07-22T11:00:00.000Z",
    parent_capsule_sha256: null,
    source: {
      memory_id: `memory-${args.id}`,
      source_commit_id: `commit-${args.id}`,
      source_projection_sha256: "6".repeat(64),
    },
    kind,
    proposed_influence: (kind === "constraint" || kind === "counter_evidence")
      ? "block" as const
      : "use" as const,
    applicability: {
      tenant_id: IDENTITY.tenant_id,
      scope: IDENTITY.scope,
      task_family: IDENTITY.task_family,
      task_signature: null,
      workflow_signature: null,
      workspace_signature: null,
      producer_agent_id: null,
      owner_agent_id: null,
      owner_team_id: null,
    },
    projection: {
      ...projectionBody,
      projection_sha256: canonicalContinuationSha256(projectionBody),
    },
    coverage_claims: [coverageClaim],
    precondition_specs: [],
    evidence_refs: [],
    verifier_refs: [],
    conflicts_with: canonicalUniqueSet(args.conflicts_with ?? [], (item) =>
      `${item.capsule_id}\0${item.capsule_revision}\0${item.capsule_sha256}`),
    supersedes: canonicalUniqueSet(args.supersedes ?? [], (item) =>
      `${item.capsule_id}\0${item.capsule_revision}\0${item.capsule_sha256}`),
    expires_at: null,
  };
  return {
    ...body,
    capsule_sha256: canonicalContinuationSha256(body),
  };
}

function candidate(args: Readonly<{
  capsule: ExecutionCapsuleV1;
  lane: "verified_continuity" | "governed_learning";
  authority?: "candidate" | "verified" | "authoritative";
}>): ContinuationCompilerCandidateV1 {
  const capsuleReference = ref(args.capsule);
  const lifecycleBody = {
    memory_id: args.capsule.source.memory_id,
    lifecycle_source_commit_id: args.capsule.source.source_commit_id,
    memory_projection_sha256: args.capsule.source.source_projection_sha256,
    lifecycle: "active" as const,
    memory_scope_head_revision: 1,
    memory_scope_head_sha256: MEMORY_HEAD,
  };
  const provenance = args.lane === "verified_continuity"
    ? (() => {
      const body = {
        capsule: capsuleReference,
        disposition: args.capsule.proposed_influence === "block"
          ? "prohibit" as const
          : "include" as const,
        admission_authority: args.authority === "authoritative"
          ? "authoritative" as const
          : "verified" as const,
        memory_id: args.capsule.source.memory_id,
        capsule_source_commit_id: args.capsule.source.source_commit_id,
        memory_scope_head_revision: 1,
        memory_scope_head_sha256: MEMORY_HEAD,
      };
      return {
        lane: "verified_continuity" as const,
        continuity_binding: {
          ...body,
          binding_sha256: canonicalContinuationSha256(body),
        },
      };
    })()
    : (() => {
      const body = {
        branch_ref: {
          branch_id: "learning-1",
          branch_revision: 1,
          manifest_sha256: "7".repeat(64),
        },
        capsule: capsuleReference,
        disposition: args.capsule.proposed_influence === "block"
          ? "prohibit" as const
          : "include" as const,
        admission_authority: args.authority === "authoritative"
          ? "authoritative" as const
          : "candidate" as const,
      };
      return {
        lane: "governed_learning" as const,
        branch_binding: {
          ...body,
          binding_sha256: canonicalContinuationSha256(body),
        },
      };
    })();
  return {
    capsule: args.capsule,
    provenance,
    lifecycle_fact: {
      ...lifecycleBody,
      row_sha256: canonicalContinuationSha256(lifecycleBody),
    },
  };
}

function input(args: Readonly<{
  candidates: readonly ContinuationCompilerCandidateV1[];
  obligations: readonly ContinuationObligationV1[];
  policy?: ContinuationCompilerPolicyV1;
}>) {
  return {
    schema_version: "continuation_candidate_retrieval_input_v1" as const,
    identity: IDENTITY,
    obligations: args.obligations,
    candidates: args.candidates,
    evaluated_at: NOW,
    policy: args.policy ?? policy(),
  };
}

function selectedRefs(result: ReturnType<typeof retrieveContinuationCandidatesV1>) {
  return result.candidates.map((item) => item.capsule.capsule_id);
}

test("retrieval is input-order independent and continuity selection cannot depend on learning branch", () => {
  const current = obligation("current");
  const learning = obligation("learning");
  const continuity = ["z-continuity", "a-continuity", "m-continuity"].map((id) =>
    candidate({ capsule: capsule({ id, lane: "verified_continuity", claim: current }), lane: "verified_continuity" }));
  const controlLearning = candidate({
    capsule: capsule({ id: "control-procedure", lane: "governed_learning", claim: learning }),
    lane: "governed_learning",
  });
  const candidateLearning = candidate({
    capsule: capsule({ id: "candidate-procedure", lane: "governed_learning", claim: learning }),
    lane: "governed_learning",
  });
  const first = retrieveContinuationCandidatesV1(input({
    candidates: [...continuity, controlLearning],
    obligations: [learning, current],
    policy: policy(2, 2),
  }));
  const reordered = retrieveContinuationCandidatesV1(input({
    candidates: [controlLearning, ...continuity].reverse(),
    obligations: [current, learning],
    policy: policy(2, 2),
  }));
  const otherArm = retrieveContinuationCandidatesV1(input({
    candidates: [candidateLearning, ...continuity],
    obligations: [current, learning],
    policy: policy(2, 2),
  }));
  assert.equal(first.status, "selected");
  assert.equal(reordered.status, "selected");
  assert.equal(first.receipt.receipt_sha256, reordered.receipt.receipt_sha256);
  const continuityIds = (result: typeof first) => result.candidates
    .filter((item) => item.provenance.lane === "verified_continuity")
    .map((item) => item.capsule.capsule_id);
  assert.deepEqual(continuityIds(first), continuityIds(otherArm));
  assert.equal(first.receipt.algorithm_contract_sha256,
    CONTINUATION_CANDIDATE_RETRIEVAL_ALGORITHM_SHA256_V1);
});

test("more than 128 materialized candidates are bounded successfully by signed lane limits", () => {
  const advisory = obligation("advisory");
  const candidates = Array.from({ length: 200 }, (_, index) => {
    const lane = index < 100 ? "verified_continuity" as const : "governed_learning" as const;
    return candidate({
      capsule: capsule({ id: `capsule-${index.toString().padStart(3, "0")}`, lane, claim: advisory }),
      lane,
    });
  });
  const result = retrieveContinuationCandidatesV1(input({
    candidates,
    obligations: [advisory],
    policy: policy(64, 64),
  }));
  assert.equal(result.status, "selected");
  assert.equal(result.candidates.length, 128);
  assert.equal(result.receipt.source_universe.candidate_count, 200);
  assert.equal(result.receipt.selected.verified_continuity.count, 64);
  assert.equal(result.receipt.selected.governed_learning.count, 64);
  assert.equal(result.receipt.omitted.verified_continuity.count, 36);
  assert.equal(result.receipt.omitted.governed_learning.count, 36);
});

test("hard and safety seeds retain transitive relationship closure", () => {
  const relevant = obligation("relevant", "hard");
  const irrelevant = obligation("irrelevant", "advisory", "other-target");
  const third = capsule({ id: "third", lane: "verified_continuity", claim: irrelevant });
  const second = capsule({
    id: "second",
    lane: "verified_continuity",
    claim: irrelevant,
    supersedes: [ref(third)],
  });
  const safety = capsule({
    id: "safety",
    lane: "verified_continuity",
    claim: relevant,
    kind: "constraint",
    conflicts_with: [ref(second)],
  });
  const result = retrieveContinuationCandidatesV1(input({
    candidates: [candidate({ capsule: safety, lane: "verified_continuity" }),
      candidate({ capsule: third, lane: "verified_continuity" }),
      candidate({ capsule: second, lane: "verified_continuity" })],
    obligations: [relevant],
    policy: policy(3, 1),
  }));
  assert.equal(result.status, "selected");
  assert.deepEqual(selectedRefs(result), ["safety", "second", "third"]);
  assert.equal(result.receipt.protected.verified_continuity.count, 3);
  const selectedRefSet = new Set(result.candidates.map((item) =>
    `${item.capsule.capsule_id}\0${item.capsule.capsule_revision}\0${item.capsule.capsule_sha256}`));
  for (const item of result.candidates) {
    for (const related of [...item.capsule.conflicts_with, ...item.capsule.supersedes]) {
      assert.equal(selectedRefSet.has(
        `${related.capsule_id}\0${related.capsule_revision}\0${related.capsule_sha256}`,
      ), true, "every selected relationship ref remains inside the compiler universe");
    }
  }
});

test("protected relationship closure overflow fails closed instead of trimming", () => {
  const advisory = obligation("safety");
  const candidates = ["constraint-a", "constraint-b", "constraint-c"].map((id) =>
    candidate({
      capsule: capsule({ id, lane: "verified_continuity", claim: advisory, kind: "constraint" }),
      lane: "verified_continuity",
    }));
  const result = retrieveContinuationCandidatesV1(input({
    candidates,
    obligations: [advisory],
    policy: policy(2, 2),
  }));
  assert.equal(result.status, "protected_overflow");
  assert.deepEqual(result.overflow_lanes, ["verified_continuity"]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.receipt.protected.verified_continuity.count, 3);
  assert.equal(result.receipt.selected.verified_continuity.count, 0);
  assert.equal(result.receipt.overflow_status, "verified_continuity_protected_overflow");
});

test("cross-lane mandatory safety overflow fails before compiler selection", () => {
  const safety = obligation("cross-lane-safety");
  const candidates = Array.from({ length: 80 }, (_, index) => {
    const lane = index < 40 ? "verified_continuity" as const : "governed_learning" as const;
    return candidate({
      capsule: capsule({
        id: `safety-${index.toString().padStart(2, "0")}`,
        lane,
        claim: safety,
        kind: lane === "verified_continuity" ? "constraint" : "counter_evidence",
      }),
      lane,
    });
  });
  const result = retrieveContinuationCandidatesV1(input({
    candidates,
    obligations: [safety],
    policy: policy(64, 64),
  }));
  assert.equal(result.status, "protected_overflow");
  assert.deepEqual(result.overflow_lanes, []);
  assert.deepEqual(result.overflow_reasons, [
    "selected_capsule_protected_limit_exceeded",
  ]);
  assert.equal(result.receipt.mandatory_protected.count, 80);
  assert.equal(result.receipt.selected_capsule_limit, 64);
  assert.equal(result.receipt.overflow_status, "selected_capsule_protected_overflow");
  assert.equal(result.receipt.selected.verified_continuity.count, 0);
  assert.equal(result.receipt.selected.governed_learning.count, 0);
});

test("only exact obligation coverage participates in serving rank", () => {
  const required = obligation("required", "advisory", "exact-target");
  const mismatch = obligation("other-local-id", "advisory", "different-target");
  const matching = candidate({
    capsule: capsule({ id: "matching", lane: "verified_continuity", claim: required }),
    lane: "verified_continuity",
  });
  const nonmatching = candidate({
    capsule: capsule({ id: "nonmatching", lane: "verified_continuity", claim: mismatch }),
    lane: "verified_continuity",
  });
  const result = retrieveContinuationCandidatesV1(input({
    candidates: [nonmatching, matching],
    obligations: [required],
    policy: policy(2, 1),
  }));
  assert.equal(result.status, "selected");
  assert.deepEqual(selectedRefs(result), ["matching"]);
});

test("advisory fill uses marginal exact coverage before authority and freshness", () => {
  const first = obligation("first");
  const unique = obligation("unique");
  const dominant = candidate({
    capsule: capsule({
      id: "dominant-first",
      lane: "verified_continuity",
      claim: first,
      created_at: "2026-07-22T11:59:00.000Z",
    }),
    lane: "verified_continuity",
    authority: "authoritative",
  });
  const duplicate = candidate({
    capsule: capsule({
      id: "duplicate-first",
      lane: "verified_continuity",
      claim: first,
      created_at: "2026-07-22T11:58:00.000Z",
    }),
    lane: "verified_continuity",
    authority: "authoritative",
  });
  const uniqueCoverage = candidate({
    capsule: capsule({
      id: "unique-second",
      lane: "verified_continuity",
      claim: unique,
      created_at: "2026-07-01T00:00:00.000Z",
    }),
    lane: "verified_continuity",
  });
  const result = retrieveContinuationCandidatesV1(input({
    candidates: [duplicate, uniqueCoverage, dominant],
    obligations: [first, unique],
    policy: policy(2, 1),
  }));
  assert.equal(result.status, "selected");
  assert.deepEqual(selectedRefs(result), ["dominant-first", "unique-second"]);
});

test("input and receipts reject unknown fields and digest tampering", () => {
  const advisory = obligation("advisory");
  const one = candidate({
    capsule: capsule({ id: "one", lane: "verified_continuity", claim: advisory }),
    lane: "verified_continuity",
  });
  const validInput = input({ candidates: [one], obligations: [advisory], policy: policy(1, 1) });
  const result = retrieveContinuationCandidatesV1(validInput);
  assert.equal(result.status, "selected");
  assert.deepEqual(verifyContinuationCandidateRetrievalReceiptV1(result.receipt), result.receipt);
  assert.throws(
    () => retrieveContinuationCandidatesV1({ ...validInput, ann_score: 0.99 } as never),
    /input_shape_invalid/u,
  );
  assert.throws(
    () => retrieveContinuationCandidatesV1({
      ...validInput,
      candidates: [{ ...one, unknown: true } as never],
    }),
    /candidate_invalid/u,
  );
  assert.throws(
    () => verifyContinuationCandidateRetrievalReceiptV1({ ...result.receipt, unknown: true }),
    /receipt_invalid/u,
  );
  assert.throws(
    () => verifyContinuationCandidateRetrievalReceiptV1({
      ...result.receipt,
      receipt_sha256: "f".repeat(64),
    }),
    /receipt digest mismatch/u,
  );
  const rehash = (body: Omit<typeof result.receipt, "receipt_sha256">) => ({
    ...body,
    receipt_sha256: canonicalContinuationSha256(body),
  });
  const { receipt_sha256: _sourceReceiptSha, ...sourceBody } = result.receipt;
  assert.throws(
    () => verifyContinuationCandidateRetrievalReceiptV1(rehash({
      ...sourceBody,
      source_universe: {
        ...sourceBody.source_universe,
        candidate_count: sourceBody.source_universe.candidate_count + 1,
      },
    })),
    /source candidate count does not equal/u,
  );
  const { receipt_sha256: _overflowReceiptSha, ...overflowBody } = result.receipt;
  assert.throws(
    () => verifyContinuationCandidateRetrievalReceiptV1(rehash({
      ...overflowBody,
      overflow_status: "verified_continuity_protected_overflow",
    })),
    /overflow status does not match/u,
  );
  assert.throws(
    () => retrieveContinuationCandidatesV1({
      ...validInput,
      policy: { ...validInput.policy, authority_subject_sha256: "f".repeat(64) },
    }),
    /policy authority subject does not match/u,
  );
  const tamperedCapsule = {
    ...one.capsule,
    projection: { ...one.capsule.projection, summary: "tampered" },
  };
  assert.throws(
    () => retrieveContinuationCandidatesV1({
      ...validInput,
      candidates: [{ ...one, capsule: tamperedCapsule }],
    }),
    /candidate_invalid/u,
  );
  assert.equal(canonicalSha256Without(result.receipt, "receipt_sha256"),
    result.receipt.receipt_sha256);
});
