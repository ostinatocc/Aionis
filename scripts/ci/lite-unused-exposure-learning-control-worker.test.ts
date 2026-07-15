import assert from "node:assert/strict";
import test from "node:test";

import stableStringify from "fast-json-stable-stringify";

import {
  buildUnusedExposureLearningControlJob,
} from "../../src/store/lite-learning-control-jobs.ts";
import { sha256Hex } from "../../src/util/crypto.ts";

test("unused-exposure learning-control job identity is canonical and deterministic", () => {
  const input = {
    tenantId: "tenant-a",
    scope: "scope-a",
    sourceEpisodeId: "episode-a",
    sourceFeedbackEventId: "feedback-a",
    sourceCommitId: "commit-a",
    exposureIds: ["exposure-a", "exposure-a"],
    enqueuedAt: "2026-07-15T08:00:00.000Z",
  } as const;

  const first = buildUnusedExposureLearningControlJob(input);
  const second = buildUnusedExposureLearningControlJob({
    ...input,
    exposureIds: ["exposure-a"],
  });

  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(first.payload_json), {
    contract_version: "unused_exposure_learning_control_v1",
    exposure_ids: ["exposure-a"],
    feedback_event_id: "feedback-a",
  });
  assert.equal(first.payload_json, stableStringify(JSON.parse(first.payload_json)));
  assert.equal(first.payload_sha256, sha256Hex(first.payload_json));
  assert.match(first.job_id, /^lctrl_job_[a-f0-9]{64}$/u);
  assert.match(first.operation_id, /^lctrl_op_[a-f0-9]{64}$/u);
  assert.equal(first.status, "pending");
  assert.equal(first.attempt_count, 0);
  assert.equal(first.available_at, input.enqueuedAt);
  assert.equal(first.created_at, input.enqueuedAt);
  assert.equal(first.updated_at, input.enqueuedAt);
  assert.throws(
    () => buildUnusedExposureLearningControlJob({
      ...input,
      exposureIds: ["exposure-a", "exposure-from-another-episode"],
    }),
    /exposure_ids/u,
  );
});
