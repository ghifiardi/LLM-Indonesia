import test from "node:test";
import assert from "node:assert/strict";

import {
  duckDuckGoTarget,
  parseDuckDuckGoHtml,
  parseSearxngJson,
  searchProvider
} from "../src/chat/searchProviders.js";

test("DuckDuckGo redirect links resolve to the real HTTPS target", () => {
  const href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bps.go.id%2Fdata%3Fa%3D1&amp;rut=x";
  assert.equal(duckDuckGoTarget(href), "https://www.bps.go.id/data?a=1");
});

test("DuckDuckGo parser extracts result links, titles, and de-duplicates", () => {
  const html = `
    <a rel="nofollow" class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bps.go.id%2Fa">
       Data &amp; Statistik BPS
    </a>
    <a class="result__a" href="https://www.bps.go.id/a">duplicate</a>
    <a class="other" href="https://evil.example/">ignore</a>
    <a class="result__a" href="http://insecure.example/">ignore http</a>
    <a class="result__a" href="https://id.wikipedia.org/wiki/Ekonomi">Ekonomi</a>`;
  assert.deepEqual(parseDuckDuckGoHtml(html), [
    { url: "https://www.bps.go.id/a", title: "Data & Statistik BPS" },
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "Ekonomi" }
  ]);
});

test("provider interface builds a fixed-host encoded request", () => {
  const provider = searchProvider("duckduckgo-html");
  const request = provider.buildRequest("pasar modal & OJK");
  assert.equal(new URL(request.url).hostname, "html.duckduckgo.com");
  assert.match(request.url, /pasar%20modal%20%26%20OJK/);
  assert.equal(searchProvider("unknown"), null);
});

test("zero-setup federated provider is built in and needs no configuration", () => {
  const provider = searchProvider("official-federated", {});
  assert.equal(provider.kind, "federated-adapters");
  assert.equal(provider.label, "Sumber resmi otomatis");
});

test("SearXNG JSON is parsed to https result links only", () => {
  const json = JSON.stringify({ results: [
    { url: "https://www.bps.go.id/a", title: "BPS" },
    { url: "http://insecure.example/", title: "insecure" },
    { url: "https://www.bps.go.id/a", title: "dup" },
    { url: "not a url", title: "bad" },
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "wiki" }
  ] });
  assert.deepEqual(parseSearxngJson(json).map((r) => r.url),
    ["https://www.bps.go.id/a", "https://id.wikipedia.org/wiki/Ekonomi"]);
});

test("SearXNG provider requires a configured instance URL", () => {
  assert.equal(searchProvider("searxng", {}), null);
  const remote = searchProvider("searxng", { TANTULAR_SEARXNG_URL: "https://searx.example" });
  assert.equal(remote.host, "searx.example");
  assert.equal(remote.allowLocalProvider, false);
  assert.match(remote.buildRequest("inflasi 2026").url,
    /^https:\/\/searx\.example\/search\?q=inflasi\+2026&format=json/);
});

test("a localhost SearXNG is treated as trusted local infrastructure", () => {
  const local = searchProvider("searxng", { TANTULAR_SEARXNG_URL: "http://127.0.0.1:8888" });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.allowLocalProvider, true);
  assert.deepEqual(local.searchContentTypes, ["application/json"]);
});
