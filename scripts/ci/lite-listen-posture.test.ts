import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenHost } from "../../src/server/bootstrap.ts";

test("lite defaults to loopback bind", () => {
  assert.equal(resolveListenHost({ AIONIS_EDITION: "lite", AIONIS_LISTEN_HOST: "" }), "127.0.0.1");
});

test("explicit listen host overrides the lite default", () => {
  assert.equal(resolveListenHost({ AIONIS_EDITION: "lite", AIONIS_LISTEN_HOST: "0.0.0.0" }), "0.0.0.0");
});
