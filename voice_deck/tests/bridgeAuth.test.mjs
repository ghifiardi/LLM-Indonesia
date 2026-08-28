import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, tokensMatch, extractToken, hostIsLoopback } from "../bridge/auth.mjs";

test("a session token is long and unpredictable", () => {
  const a = createSessionToken();
  const b = createSessionToken();
  assert.ok(a.length >= 64, "a short token is brute-forceable by a local process");
  assert.notEqual(a, b);
});

test("token comparison rejects mismatches, including length games", () => {
  const token = createSessionToken();
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch(token, token.slice(0, -1)), false);
  assert.equal(tokensMatch(token, token + "0"), false);
  assert.equal(tokensMatch(token, ""), false);
});

test("an empty configured token never authenticates anything", () => {
  // Otherwise a bridge started without a token would accept every caller.
  assert.equal(tokensMatch("", ""), false);
  assert.equal(tokensMatch(undefined, undefined), false);
});

test("the token is read from Authorization or the explicit header", () => {
  const token = "abc123";
  assert.equal(extractToken({ authorization: `Bearer ${token}` }), token);
  assert.equal(extractToken({ authorization: `bearer ${token}` }), token);
  assert.equal(extractToken({ "x-tantular-token": token }), token);
  assert.equal(extractToken({}), "");
});

test("only loopback Host headers are accepted", () => {
  // DNS rebinding: a page on any origin can be pointed at 127.0.0.1. The Host
  // header is what separates that from a genuine local caller.
  for (const host of ["127.0.0.1", "127.0.0.1:8777", "localhost", "localhost:8777", "[::1]:8777"]) {
    assert.equal(hostIsLoopback(host), true, host);
  }
  for (const host of ["evil.example.com", "evil.example.com:8777", "192.168.1.10:8777", "", undefined]) {
    assert.equal(hostIsLoopback(host), false, String(host));
  }
});
