import test from "node:test";
import assert from "node:assert/strict";
import {
  ipAllowed,
  parseTrustedProxyCidrs,
  resolveTrustedClientIp,
} from "../../src/util/ip-guard.ts";

test("trusted proxy CIDR matching supports IPv6 and IPv4", () => {
  const allowlist = parseTrustedProxyCidrs("2001:db8:abcd::/48,10.0.0.0/8");

  assert.equal(ipAllowed("2001:db8:abcd::42", allowlist), true);
  assert.equal(ipAllowed("2001:db8:abcd::192.0.2.42", allowlist), true);
  assert.equal(ipAllowed("2001:db8:abce::42", allowlist), false);
  assert.equal(ipAllowed("10.12.0.8", allowlist), true);
  assert.equal(ipAllowed("192.0.2.8", allowlist), false);
});

test("trusted proxy CIDR handles IPv6 boundary prefixes and cross-family mismatches", () => {
  assert.equal(ipAllowed("2001:db8::1", parseTrustedProxyCidrs("::/0")), true);
  assert.equal(ipAllowed("2001:db8::1", parseTrustedProxyCidrs("2001:db8::1/128")), true);
  assert.equal(ipAllowed("2001:db8::2", parseTrustedProxyCidrs("2001:db8::1/128")), false);
  assert.equal(ipAllowed("192.0.2.1", parseTrustedProxyCidrs("2001:db8::/32")), false);
  assert.equal(ipAllowed("2001:db8::1", parseTrustedProxyCidrs("192.0.2.0/24")), false);
});

test("trusted IPv6 proxy resolves forwarded client address", () => {
  const clientIp = resolveTrustedClientIp({
    remoteAddress: "2001:db8:abcd::1",
    headers: {
      "x-forwarded-for": "203.0.113.9, 198.51.100.2",
    },
    trustedProxyCidrs: parseTrustedProxyCidrs("2001:db8:abcd::/48"),
  });

  assert.equal(clientIp, "203.0.113.9");
});
