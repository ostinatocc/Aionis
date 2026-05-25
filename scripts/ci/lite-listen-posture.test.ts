import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenHost } from "../../src/host/bootstrap.ts";

test("lite defaults to loopback bind", () => {
  assert.equal(resolveListenHost({ AIONIS_EDITION: "lite", AIONIS_LISTEN_HOST: "" }), "127.0.0.1");
});

test("explicit listen host overrides the lite default", () => {
  assert.equal(resolveListenHost({ AIONIS_EDITION: "lite", AIONIS_LISTEN_HOST: "0.0.0.0" }), "0.0.0.0");
});

test("non-lite falls back to a wide bind only when explicitly outside lite", () => {
  assert.equal(resolveListenHost({ AIONIS_EDITION: "server", AIONIS_LISTEN_HOST: "" }), "0.0.0.0");
});
