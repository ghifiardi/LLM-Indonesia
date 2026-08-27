// Multi-host lookup: more official sources, same one-door security model.
// The user's standing policy: hosts are added PER HOST with an adapter —
// never a wildcard — and enforcement lives in the companion, not the pane.

import test from "node:test";
import assert from "node:assert/strict";
import { HOST_ADAPTERS, defaultAllowedHosts, describedHosts, allowedHosts,
         hostAllowed, resolveUrl, prepareLookup } from "../src/chat/lookupPolicy.js";
import { createLookupController, HOST } from "../src/chat/lookupController.js";

const ON = { TANTULAR_LOOKUP_ENABLED: "true" };
const DOC = "Vendor PT Sinar Mas. Pagu Rp 1.750.000.000.";

test("every default host has a working adapter URL on its own domain", () => {
  for (const host of defaultAllowedHosts({})) {
    const url = resolveUrl(host, "uji query", {});
    assert.ok(url, host);
    assert.equal(new URL(url).host, host,
      `${host}: the adapter must not send the query to a different domain`);
    assert.ok(url.includes(encodeURIComponent("uji query").replace(/%20/g, "%20"))
      || url.includes("uji%20query"), `${host}: the query must be encoded in`);
  }
});

test("a key-gated adapter stays OUT of the allowlist until its key exists", () => {
  assert.ok(!defaultAllowedHosts({}).includes("webapi.bps.go.id"),
    "BPS must not be offered without an API key");
  assert.ok(defaultAllowedHosts({ TANTULAR_BPS_API_KEY: "k1" })
    .includes("webapi.bps.go.id"));
  // And resolving it without the key yields nothing to fetch.
  assert.equal(resolveUrl("webapi.bps.go.id", "inflasi", {}), null);
});

test("prepare refuses a key-gated host explicitly rather than half-working", () => {
  const env = { ...ON, TANTULAR_LOOKUP_HOSTS: "webapi.bps.go.id" };
  const out = prepareLookup({ query: "inflasi", host: "webapi.bps.go.id",
                              document: DOC, env });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "adapter_unavailable");
  assert.equal(out.token, undefined);
});

test("lookalikes of the new hosts are refused exactly like the old ones", () => {
  const hosts = allowedHosts({});
  for (const bad of ["peraturan.bpk.go.id.evil.com", "notperaturan.bpk.go.id",
                     "bpk.go.id", "webapi.bps.go.id"]) {
    assert.equal(hostAllowed(bad, hosts), false, bad);
  }
});

test("describedHosts pairs every allowed host with a human label", () => {
  const described = describedHosts({});
  assert.deepEqual(described.map((d) => d.host), defaultAllowedHosts({}));
  for (const d of described) assert.ok(d.label && d.label !== "", d.host);
});

test("the controller carries the chosen host through prepare and execute", async () => {
  const calls = [];
  const run = createLookupController({
    postLocal: async (path, body) => {
      calls.push({ path, host: body.host });
      return path.endsWith("prepare")
        ? { ok: true, token: "t",
            disclosure: { host: "peraturan.bpk.go.id", query: body.query } }
        : { ok: true, status: "verified", answer: "x", protected: [] };
    },
    confirm: async () => true,
    container: { innerHTML: "", hidden: true, querySelector: () => null },
    readDocument: async () => ({ ok: true, text: DOC, source: "Word" }),
    getHost: () => "Word"
  });
  await run({ mode: "local+search", query: "uu cipta kerja",
              host: "peraturan.bpk.go.id" });
  assert.deepEqual(calls.map((c) => c.host),
    ["peraturan.bpk.go.id", "peraturan.bpk.go.id"]);
});

test("no chosen host falls back to Wikipedia, never to nothing", async () => {
  const seen = [];
  const run = createLookupController({
    postLocal: async (path, body) => { seen.push(body.host);
      return { ok: false, reason: "disabled" }; },
    confirm: async () => true,
    container: { innerHTML: "", hidden: true, querySelector: () => null },
    readDocument: async () => ({ ok: true, text: DOC, source: "Word" }),
    getHost: () => "Word"
  });
  await run({ mode: "local+search", query: "apa pun" });
  assert.deepEqual(seen, [HOST]);
});
