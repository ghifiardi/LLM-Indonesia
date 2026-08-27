import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedContentType,
  isPublicIp,
  pinnedLookup,
  safeFetchUrl
} from "../src/chat/safeFetch.js";

test("private, loopback, metadata/link-local and reserved IPs are blocked", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
                    "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1",
                    "fc00::1", "fe80::1", "ff02::1"]) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("pinned DNS lookup supports both scalar and all=true callback shapes", async () => {
  const lookup = pinnedLookup({ address: "8.8.8.8", family: 4 });
  const scalar = await new Promise((resolve, reject) =>
    lookup("example.com", {}, (error, address, family) =>
      error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(scalar, { address: "8.8.8.8", family: 4 });
  const all = await new Promise((resolve, reject) =>
    lookup("example.com", { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [{ address: "8.8.8.8", family: 4 }]);
});

test("only HTML, PDF, and plain text content types are accepted", () => {
  assert.equal(allowedContentType("text/html; charset=utf-8"), "text/html");
  assert.equal(allowedContentType("application/pdf"), "application/pdf");
  assert.equal(allowedContentType("application/json"), "");
  assert.equal(allowedContentType("image/png"), "");
});

test("a caller may opt into JSON for a trusted provider step only", () => {
  assert.equal(allowedContentType("application/json", ["application/json"]), "application/json");
  assert.equal(allowedContentType("text/html", ["application/json"]), "");
});

test("safe fetch can accept a JSON provider response when explicitly allowed", async () => {
  const result = await safeFetchUrl("https://searx.example/search?q=x", {
    policy: () => ({ allowed: true, host: "searx.example", tier: "search-provider",
      reason: "fixed_provider_host" }),
    allowContentTypes: ["application/json"],
    requestOnce: async () => ({ status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"results":[]}') })
  });
  assert.equal(result.contentType, "application/json");
});

test("every redirect target is rechecked by policy", async () => {
  const checked = [];
  const requestOnce = async (url) => url.includes("official.go.id")
    ? { status: 302, headers: { location: "https://evil.example/p" }, body: Buffer.alloc(0) }
    : { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("x") };
  await assert.rejects(() => safeFetchUrl("https://official.go.id/start", {
    policy: (url) => {
      checked.push(new URL(url).hostname);
      return { allowed: new URL(url).hostname.endsWith(".go.id"), reason: "test" };
    },
    requestOnce
  }), /domain_blocked/);
  assert.deepEqual(checked, ["official.go.id", "evil.example"]);
});

test("safe fetch returns provenance and content hash for an allowed final response", async () => {
  const result = await safeFetchUrl("https://data.go.id/a", {
    policy: (url) => ({ allowed: true, tier: "official",
      host: new URL(url).hostname, reason: "official_psl_zone" }),
    requestOnce: async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("data resmi")
    })
  });
  assert.equal(result.finalUrl, "https://data.go.id/a");
  assert.equal(result.contentType, "text/plain");
  assert.equal(result.bytes, 10);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.policy.tier, "official");
});
