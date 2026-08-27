import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverAndRetrieve,
  domainDecision,
  parseBpkSearchHtml,
  parseWikipediaSearchJson,
  queryRequiresOfficial,
  rankDiscoveryResults,
  sourcesAsUntrusted
} from "../src/chat/discovery.js";

test("policy/regulation queries accept official sources only", () => {
  const results = [
    { url: "https://id.wikipedia.org/wiki/UU", title: "wiki" },
    { url: "https://peraturan.bpk.go.id/Details/1", title: "BPK" },
    { url: "https://random-blog.com/post", title: "blog" }
  ];
  assert.equal(queryRequiresOfficial("peraturan perlindungan data"), true);
  assert.deepEqual(rankDiscoveryResults(results, "peraturan perlindungan data")
    .map((r) => r.host), ["peraturan.bpk.go.id"]);
});

test("general queries prioritize official before trusted references", () => {
  const results = [
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "wiki" },
    { url: "https://www.bps.go.id/data", title: "BPS" }
  ];
  assert.deepEqual(rankDiscoveryResults(results, "perkembangan ekonomi")
    .map((r) => r.tier), ["official", "trusted-reference"]);
});

test("domain decision is default deny", () => {
  assert.equal(domainDecision("https://www.bps.go.id/data").allowed, true);
  assert.equal(domainDecision("https://random-blog.com/post").allowed, false);
});

test("only fetched source text—not search snippets—is composed for the model", () => {
  const text = sourcesAsUntrusted([{
    id: "S1", title: "BPS", url: "https://www.bps.go.id/a",
    tier: "official", text: "ISI HALAMAN YANG BENAR-BENAR DIAMBIL"
  }]);
  assert.match(text, /\[S1\]/);
  assert.match(text, /ISI HALAMAN/);
  assert.doesNotMatch(text, /search snippet/i);
});

test("Wikipedia adapter response becomes actual article URLs", () => {
  const results = parseWikipediaSearchJson(JSON.stringify({ pages: [
    { key: "Pasar_modal", title: "Pasar modal" },
    { title: "missing key" }
  ] }));
  assert.deepEqual(results, [{
    url: "https://id.wikipedia.org/wiki/Pasar_modal",
    title: "Pasar modal"
  }]);
});

test("JDIH search HTML becomes actual Details page URLs", () => {
  const html = `
    <a href="/Details/12345/uu-no-1-tahun-2026">UU No. 1 Tahun 2026</a>
    <a href="https://peraturan.bpk.go.id/Details/12345/duplikat">duplikat host, different URL</a>
    <a href="https://evil.example/Details/9">evil</a>`;
  const results = parseBpkSearchHtml(html);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) =>
    new URL(result.url).hostname === "peraturan.bpk.go.id"));
});

test("orchestrator audits provider and fetched-page provenance", async () => {
  const audits = [];
  const searchHtml = `<a class="result__a"
    href="https://www.bps.go.id/data">Data BPS</a>`;
  const fetched = await discoverAndRetrieve({
    query: "perkembangan ekonomi indonesia",
    providerId: "duckduckgo-html",
    audit: (event) => audits.push(event),
    fetchUrl: async (url) => {
      if (new URL(url).hostname === "html.duckduckgo.com") {
        return {
          requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: "searchhash",
          body: Buffer.from(searchHtml), policy: {
            host: "html.duckduckgo.com", tier: "search-provider",
            reason: "fixed_provider_host"
          }
        };
      }
      return {
        requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 120, contentHash: "pagehash",
        body: Buffer.from(`<h1>BPS</h1><p>${"Data ekonomi resmi Indonesia. ".repeat(5)}</p>`),
        policy: { host: "www.bps.go.id", tier: "official",
                  reason: "official_psl_zone" }
      };
    }
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.sources[0].url, "https://www.bps.go.id/data");
  assert.ok(audits.some((event) => event.stage === "search"
    && event.contentHash === "searchhash"));
  assert.ok(audits.some((event) => event.stage === "retrieve"
    && event.finalUrl === "https://www.bps.go.id/data"
    && event.contentHash === "pagehash"
    && event.domainTier === "official"));
});
