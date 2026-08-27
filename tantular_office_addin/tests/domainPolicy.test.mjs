import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyDomain,
  isFetchAllowed,
  filterAllowedResults
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

test("unrecognized sites are default-denied, not fetched", () => {
  const result = classifyDomain("some-random-blog.com");
  assert.equal(result.tier, "unknown");
  assert.equal(isFetchAllowed("some-random-blog.com"), false);
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
