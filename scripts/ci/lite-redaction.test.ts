import test from "node:test";
import assert from "node:assert/strict";
import { redactJsonStrings, redactPII } from "../../src/util/redaction.ts";

test("PII redaction keeps machine UUID identifiers intact", () => {
  const memoryId = "c0d5793c-d20c-5a63-9841-1e2971221798";
  const result = redactJsonStrings({
    guide_exposure_v1: {
      memory_ids: [memoryId],
      use_now_memory_ids: [memoryId],
    },
  });

  assert.equal((result.value as any).guide_exposure_v1.memory_ids[0], memoryId);
  assert.equal((result.value as any).guide_exposure_v1.use_now_memory_ids[0], memoryId);
  assert.deepEqual(result.counts, {});
});

test("PII redaction still redacts standalone phone numbers", () => {
  const result = redactPII("Call 415-555-1212 before the handoff.");

  assert.match(result.text, /\[PHONE#[a-f0-9]{8}\]/);
  assert.equal(result.counts.phone, 1);
});
