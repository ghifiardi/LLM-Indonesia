import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyDomain,
  isFetchAllowed,
  filterAllowedResults,
  sourcePolicy
} from "../src/chat/domainPolicy.js";

test("official Indonesian government zones are allowed", () => {
  for (const host of ["bps.go.id", "www.bi.go.id", "peraturan.bpk.go.id", "tni.mil.id"]) {
    assert.equal(classifyDomain(host).tier, "official", host);
    assert.equal(isFetchAllowed(host), true, host);
  }
});

test("curated reputable and education sources are allowed", () => {
  assert.equal(classifyDomain("id.wikipedia.org").tier, "trusted-reference");
  assert.equal(classifyDomain("who.int").tier, "trusted-reference");
  assert.equal(classifyDomain("ui.ac.id").tier, "trusted-reference");
  assert.equal(isFetchAllowed("mit.edu"), true);
});

test("unrecognized sites are public: denied under the official policy", () => {
  const result = classifyDomain("some-random-blog.com");
  assert.equal(result.tier, "public");
  assert.equal(isFetchAllowed("some-random-blog.com",
    { env: { TANTULAR_LOOKUP_SOURCE_POLICY: "official" } }), false);
});

test("hostile patterns are blocked outright", () => {
  assert.equal(classifyDomain("bit.ly").reason, "shortener_or_blocklist");
  assert.equal(classifyDomain("xn--80ak6aa92e.com").reason, "punycode");
  assert.equal(classifyDomain("192.168.1.10").reason, "ip_literal");
  for (const host of ["bit.ly", "xn--80ak6aa92e.com", "192.168.1.10"]) {
    assert.equal(isFetchAllowed(host), false, host);
  }
});

test("suffix matching cannot be spoofed by a lookalike registrable domain", () => {
  // "evilgo.id" must NOT match the "go.id" official zone.
  assert.notEqual(classifyDomain("evilgo.id").tier, "official");
  // "go.id.attacker.com" must NOT be treated as official either.
  assert.notEqual(classifyDomain("go.id.attacker.com").tier, "official");
  // A real subdomain of an official zone still passes.
  assert.equal(classifyDomain("data.go.id").tier, "official");
});

test("result filtering keeps only allowed hosts, de-duplicated, in order", () => {
  const results = [
    { url: "https://bit.ly/x", title: "short" },
    { url: "https://www.bps.go.id/a", title: "BPS A" },
    { url: "https://randomforum.example/post", title: "forum" },
    { url: "https://www.bps.go.id/b", title: "BPS B (same host)" },
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "wiki" }
  ];
  const kept = filterAllowedResults(results);
  assert.deepEqual(kept.map((r) => r.host), ["www.bps.go.id", "id.wikipedia.org"]);
  assert.equal(kept[0].tier, "official");
  assert.equal(kept[1].tier, "trusted-reference");
});

test("PSL metadata is carried for audit and policy reasoning", () => {
  const result = classifyDomain("peraturan.bpk.go.id");
  assert.equal(result.publicSuffix, "go.id");
  assert.equal(result.registrableDomain, "bpk.go.id");
});

// --- source policy: open vs official -----------------------------------------
//
// 2026-09-02: the two-host official corpus had nothing about Sahabat-AI, and no
// rewording could fix that. The owner's call: the query is public information
// once approved, so retrieval may reach the open web. The hard blocks are not
// a matter of policy and stay in both modes.

test("source policy defaults to open and accepts only the two known values", () => {
  assert.equal(sourcePolicy({}), "open");
  assert.equal(sourcePolicy({ TANTULAR_LOOKUP_SOURCE_POLICY: "official" }), "official");
  assert.equal(sourcePolicy({ TANTULAR_LOOKUP_SOURCE_POLICY: " Open " }), "open");
  assert.throws(() => sourcePolicy({ TANTULAR_LOOKUP_SOURCE_POLICY: "everything" }),
    /invalid_source_policy:everything/);
  assert.throws(() => sourcePolicy({ TANTULAR_LOOKUP_SOURCE_POLICY: "yes" }),
    /invalid_source_policy/);
});

test("open policy fetches an unrecognized public site", () => {
  const env = { TANTULAR_LOOKUP_SOURCE_POLICY: "open" };
  assert.equal(classifyDomain("sahabat-ai.com").tier, "public");
  assert.equal(isFetchAllowed("https://sahabat-ai.com/", { env }), true);
  assert.equal(isFetchAllowed("https://www.kompas.id/artikel/x", { env }), true);
});

test("official policy keeps the default-deny behaviour", () => {
  const env = { TANTULAR_LOOKUP_SOURCE_POLICY: "official" };
  assert.equal(isFetchAllowed("https://sahabat-ai.com/", { env }), false);
  assert.equal(isFetchAllowed("https://www.bps.go.id/", { env }), true);
  assert.equal(isFetchAllowed("https://id.wikipedia.org/wiki/X", { env }), true);
});

test("hard-blocked hosts stay blocked in both policies", () => {
  const hostile = ["bit.ly", "xn--80ak6aa92e.com", "192.168.1.10", "10.0.0.1",
                   "[::1]", "localhost", "internal", "go.id.invalid-suffix.zzz"];
  for (const policy of ["open", "official"]) {
    const env = { TANTULAR_LOOKUP_SOURCE_POLICY: policy };
    for (const host of hostile) {
      assert.equal(classifyDomain(host).tier, "blocked", `${policy}: ${host}`);
      assert.equal(isFetchAllowed(host, { env }), false, `${policy}: ${host}`);
    }
  }
});

test("open policy result filtering keeps public sites but drops blocked ones", () => {
  const env = { TANTULAR_LOOKUP_SOURCE_POLICY: "open" };
  const results = [
    { url: "https://bit.ly/x", title: "short" },
    { url: "https://sahabat-ai.com/", title: "Sahabat-AI" },
    { url: "https://www.bps.go.id/a", title: "BPS A" },
    { url: "https://192.168.1.10/admin", title: "ip" }
  ];
  const kept = filterAllowedResults(results, { env });
  assert.deepEqual(kept.map((r) => r.host), ["sahabat-ai.com", "www.bps.go.id"]);
  assert.equal(kept[0].tier, "public");
  // Explicit official keeps the old answer for the same input.
  assert.deepEqual(filterAllowedResults(results,
    { env: { TANTULAR_LOOKUP_SOURCE_POLICY: "official" } }).map((r) => r.host),
    ["www.bps.go.id"]);
});
