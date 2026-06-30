import test from "node:test";
import assert from "node:assert/strict";

import { buildSubstrateSidecarSearchInput } from "../../src/store/substrate-sidecar-recall.js";

test("Substrate sidecar search input omits null actor filters", () => {
  const input = buildSubstrateSidecarSearchInput({
    scope: "scope-a",
    queryText: "current fact",
    limit: 8,
    candidateLimit: 80,
    consumerAgentId: null,
    consumerTeamId: null,
  });

  assert.deepEqual(input, {
    scope: "scope-a",
    query: "current fact",
    limit: 8,
    candidateLimit: 80,
  });
  assert.equal(Object.hasOwn(input, "agentId"), false);
  assert.equal(Object.hasOwn(input, "teamId"), false);
});

test("Substrate sidecar search input keeps explicit actor filters", () => {
  const input = buildSubstrateSidecarSearchInput({
    scope: "scope-a",
    queryText: "current fact",
    limit: 8,
    candidateLimit: 80,
    consumerAgentId: "agent-1",
    consumerTeamId: "team-1",
  });

  assert.equal(input.agentId, "agent-1");
  assert.equal(input.teamId, "team-1");
});
