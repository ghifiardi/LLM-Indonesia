import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverAndRetrieve,
  domainDecision,
  parseBpkSearchHtml,
  parseWikipediaSearchJson,
  queryRequiresOfficial,
  rankDiscoveryResults,
  relevanceScore,
  queryTopicalTerms,
  RELEVANCE_FLOOR,
  sourcesAsUntrusted
} from "../src/chat/discovery.js";

const OFFICIAL = { TANTULAR_LOOKUP_SOURCE_POLICY: "official" };
const OPEN = { TANTULAR_LOOKUP_SOURCE_POLICY: "open" };

test("official policy: regulation queries accept official sources only", () => {
  const results = [
    { url: "https://id.wikipedia.org/wiki/UU", title: "wiki" },
    { url: "https://peraturan.bpk.go.id/Details/1", title: "BPK" },
    { url: "https://random-blog.com/post", title: "blog" }
  ];
  assert.equal(queryRequiresOfficial("peraturan perlindungan data"), true);
  assert.deepEqual(rankDiscoveryResults(results, "peraturan perlindungan data",
    { env: OFFICIAL }).map((r) => r.host), ["peraturan.bpk.go.id"]);
});

test("official policy: general queries prioritize official before trusted references", () => {
  const results = [
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "wiki" },
    { url: "https://www.bps.go.id/data", title: "BPS" }
  ];
  assert.deepEqual(rankDiscoveryResults(results, "perkembangan ekonomi",
    { env: OFFICIAL }).map((r) => r.tier), ["official", "trusted-reference"]);
});

test("official policy: domain decision is default deny", () => {
  assert.equal(domainDecision("https://www.bps.go.id/data", OFFICIAL).allowed, true);
  assert.equal(domainDecision("https://random-blog.com/post", OFFICIAL).allowed, false);
});

// --- open policy --------------------------------------------------------------
//
// The owner chose "open web, no official preference" (2026-09-02). Ranking is
// by how well the title matches the question, nothing else; the legal-word
// restriction to official sources is an official-policy rule.

test("open policy: public sites rank by title match with no tier preference", () => {
  const results = [
    { url: "https://id.wikipedia.org/wiki/Ekonomi", title: "Ekonomi" },
    { url: "https://sahabat-ai.com/", title: "Sahabat-AI | Open-Source LLMs" },
    { url: "https://www.bps.go.id/data", title: "Data BPS" },
    { url: "https://huggingface.co/Sahabat-AI", title: "Sahabat-AI - Hugging Face" }
  ];
  const ranked = rankDiscoveryResults(results, "Sahabat-AI", { env: OPEN });
  assert.deepEqual(ranked.map((r) => r.host),
    ["sahabat-ai.com", "huggingface.co", "id.wikipedia.org", "www.bps.go.id"]);
  assert.equal(ranked[0].tier, "public");
});

test("open policy: regulation words do not restrict results to official hosts", () => {
  const results = [
    { url: "https://hukumonline.com/uu-pdp", title: "UU Perlindungan Data" },
    { url: "https://peraturan.bpk.go.id/Details/1", title: "Peraturan" }
  ];
  assert.deepEqual(rankDiscoveryResults(results, "peraturan perlindungan data",
    { env: OPEN }).map((r) => r.host),
    ["hukumonline.com", "peraturan.bpk.go.id"]);
});

test("open policy: domain decision allows public sites but never blocked ones", () => {
  assert.equal(domainDecision("https://sahabat-ai.com/", OPEN).allowed, true);
  assert.equal(domainDecision("https://sahabat-ai.com/", OPEN).tier, "public");
  for (const url of ["https://bit.ly/x", "https://192.168.1.10/", "https://xn--80ak6aa92e.com/"]) {
    assert.equal(domainDecision(url, OPEN).allowed, false, url);
    assert.equal(domainDecision(url, OFFICIAL).allowed, false, url);
  }
});

test("open policy: retrieval fetches a public page through the policy door", async () => {
  const doorDecisions = [];
  const searchHtml = `<a class="result__a" href="https://bit.ly/short">Sahabat-AI</a>
    <a class="result__a" href="https://sahabat-ai.com/">Sahabat-AI | Open-Source LLMs</a>`;
  const result = await discoverAndRetrieve({
    query: "Sahabat-AI",
    providerId: "duckduckgo-html",
    env: OPEN,
    fetchUrl: async (url, options) => {
      if (new URL(url).hostname === "html.duckduckgo.com") {
        return { requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: "searchhash",
          body: Buffer.from(searchHtml),
          policy: { host: "html.duckduckgo.com", tier: "search-provider",
                    reason: "fixed_provider_host" } };
      }
      // What the real fetch door would ask, recorded so the test can see it.
      const decision = options.policy(url);
      doorDecisions.push({ url, allowed: decision.allowed });
      if (!decision.allowed) throw new Error(`domain_blocked:${decision.reason}`);
      return { requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 400, contentHash: "pagehash",
        body: Buffer.from(`<h1>Sahabat-AI</h1><p>${
          "Sahabat-AI adalah model bahasa besar untuk Bahasa Indonesia. ".repeat(20)}</p>`),
        policy: decision };
    }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.sources.map((s) => [s.host, s.tier]),
    [["sahabat-ai.com", "public"]]);
  // The shortener never reached the fetch door: it was dropped at ranking.
  assert.deepEqual(doorDecisions, [{ url: "https://sahabat-ai.com/", allowed: true }]);
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

// --- relevance floor (root cause, 2026-09-01) ---------------------------------
// Both adapters ALWAYS return something. For "perbandingan proyek distillation
// data resmi" the retained sources were a Pacitan e-mail regulation and the
// Wikipedia article on Astatin, and the run then died at the citation gate with
// "no fetched-source citation" — the model correctly had nothing to cite.
// Measured title/lead coverage on real pages (2026-09-01): genuinely relevant
// pages scored 0.67-0.80, every off-topic one 0.50 or below.

test("query terms drop stopwords and generic search-shaping words", () => {
  assert.deepEqual(queryTopicalTerms("perbandingan proyek distillation data resmi"),
                   ["proyek", "distillation"]);
  assert.deepEqual(queryTopicalTerms("inflasi indonesia 2026 data resmi"),
                   ["inflasi", "indonesia"]);
});

test("an off-topic page scores below the floor, a relevant one above", () => {
  const query = "peraturan perlindungan data pribadi";
  const relevant = relevanceScore({
    title: "Perlindungan Data Pribadi Dalam Sistem Elektronik",
    text: "Peraturan ini mengatur perlindungan data pribadi. ".repeat(20)
  }, query);
  const offTopic = relevanceScore({
    title: "Astatin",
    text: "Astatin adalah unsur kimia dengan nomor atom 85. ".repeat(20)
  }, query);
  assert.ok(relevant >= RELEVANCE_FLOOR, `relevant scored ${relevant}`);
  assert.ok(offTopic < RELEVANCE_FLOOR, `off-topic scored ${offTopic}`);
});

test("a page that mentions a query word once in passing is not a source", () => {
  // The Astatin article contains "proyek" exactly once in 30k characters.
  const score = relevanceScore({
    title: "Astatin",
    text: "Astatin adalah unsur kimia. ".repeat(200)
          + " Sebuah proyek penelitian pernah menelitinya. "
          + "Sifat radioaktifnya membuatnya sulit diamati. ".repeat(200)
  }, "perbandingan proyek distillation data resmi");
  assert.ok(score < RELEVANCE_FLOOR, `scored ${score}`);
});

test("retrieval refuses rather than handing the model off-topic pages", async () => {
  const audits = [];
  const searchHtml = `<a class="result__a"
    href="https://id.wikipedia.org/wiki/Astatin">Astatin</a>`;
  const result = await discoverAndRetrieve({
    query: "perbandingan proyek distillation data resmi",
    providerId: "duckduckgo-html",
    audit: (event) => audits.push(event),
    fetchUrl: async (url) => {
      if (new URL(url).hostname === "html.duckduckgo.com") {
        return { requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: "searchhash",
          body: Buffer.from(searchHtml),
          policy: { host: "html.duckduckgo.com", tier: "search-provider",
                    reason: "fixed_provider_host" } };
      }
      return { requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 400, contentHash: "pagehash",
        body: Buffer.from(`<h1>Astatin</h1><p>${
          "Astatin adalah unsur kimia dengan nomor atom 85. ".repeat(20)}</p>`),
        policy: { host: "id.wikipedia.org", tier: "trusted-reference",
                  reason: "curated_reference" } };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_relevant_sources");
  assert.deepEqual(result.sources, []);
  // The rejection must be visible in the audit trail, not silent.
  assert.ok(audits.some((event) => event.outcome === "irrelevant"
    && event.finalUrl === "https://id.wikipedia.org/wiki/Astatin"));
});

test("a relevant page still passes the floor end to end", async () => {
  const searchHtml = `<a class="result__a"
    href="https://www.bps.go.id/inflasi">Inflasi Indonesia</a>`;
  const result = await discoverAndRetrieve({
    query: "inflasi indonesia data resmi",
    providerId: "duckduckgo-html",
    fetchUrl: async (url) => {
      if (new URL(url).hostname === "html.duckduckgo.com") {
        return { requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: "searchhash",
          body: Buffer.from(searchHtml),
          policy: { host: "html.duckduckgo.com", tier: "search-provider",
                    reason: "fixed_provider_host" } };
      }
      return { requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 400, contentHash: "pagehash",
        body: Buffer.from(`<h1>Inflasi Indonesia</h1><p>${
          "Inflasi Indonesia tercatat stabil sepanjang tahun. ".repeat(20)}</p>`),
        policy: { host: "www.bps.go.id", tier: "official",
                  reason: "official_psl_zone" } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 1);
});

// --- pagination -------------------------------------------------------------
//
// A search engine returns a page at a time. One page is often full of blocked
// or off-topic domains, so the relevance floor and domain policy leave nothing.
// Pulling further pages widens the pool the ranker chooses from. These tests
// pin the loop's shape with a fake provider: they never touch the network.

// Build a DuckDuckGo results page from a list of {url,title} result links.
function ddgPage(results) {
  return results.map((r) =>
    `<a class="result__a" href="${r.url}">${r.title}</a>`).join("\n");
}

test("pagination pulls multiple result pages and de-duplicates across them", async () => {
  const audits = [];
  // Page 1: one relevant source. Page 2: a duplicate plus a NEW source. Page 3:
  // only the duplicate — nothing new, so the loop must stop and never fetch a
  // fourth page even though maxPages allows five.
  const pageFor = (offset) => {
    if (offset === 0) return ddgPage([
      { url: "https://www.bps.go.id/inflasi", title: "Inflasi Indonesia 2026" }]);
    if (offset === 30) return ddgPage([
      { url: "https://www.bps.go.id/inflasi", title: "Inflasi Indonesia 2026" },
      { url: "https://id.wikipedia.org/wiki/Inflasi", title: "Inflasi Indonesia" }]);
    return ddgPage([
      { url: "https://www.bps.go.id/inflasi", title: "Inflasi Indonesia 2026" }]);
  };
  const searchUrls = [];
  const result = await discoverAndRetrieve({
    query: "inflasi indonesia",
    providerId: "duckduckgo-html",
    maxPages: 5,
    maxSources: 5,
    audit: (event) => audits.push(event),
    fetchUrl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "html.duckduckgo.com") {
        searchUrls.push(url);
        const offset = Number(parsed.searchParams.get("s") || 0);
        return { requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: `search-${offset}`,
          body: Buffer.from(pageFor(offset)),
          policy: { host: "html.duckduckgo.com", tier: "search-provider",
                    reason: "fixed_provider_host" } };
      }
      return { requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 400, contentHash: `page-${parsed.pathname}`,
        body: Buffer.from(`<h1>Inflasi Indonesia</h1><p>${
          "Inflasi Indonesia tercatat sepanjang tahun. ".repeat(20)}</p>`),
        policy: { host: parsed.hostname,
                  tier: parsed.hostname.endsWith("bps.go.id") ? "official" : "trusted-reference",
                  reason: "test" } };
    }
  });
  assert.equal(result.ok, true);
  // Three search requests: pages 1 and 2 add results, page 3 adds nothing and
  // stops the loop before pages 4 and 5.
  assert.equal(searchUrls.length, 3);
  // The NEW source that only appears on page 2 made it into the results.
  assert.ok(result.sources.some((s) => s.host === "id.wikipedia.org"),
    "a page-2-only result should be retrievable");
  // Two distinct sources total, proving cross-page de-duplication kept one BPS.
  assert.equal(result.sources.length, 2);
  assert.ok(audits.some((e) => e.stage === "search" && e.page === 2 && e.newResults === 1));
});

test("a later page failing keeps the results earlier pages already returned", async () => {
  const result = await discoverAndRetrieve({
    query: "inflasi indonesia",
    providerId: "duckduckgo-html",
    maxPages: 3,
    fetchUrl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === "html.duckduckgo.com") {
        const offset = Number(parsed.searchParams.get("s") || 0);
        if (offset > 0) throw new Error("page_2_transport_failure");
        return { requestedUrl: url, finalUrl: url, status: 200,
          contentType: "text/html", contentHash: "search-0",
          body: Buffer.from(ddgPage([
            { url: "https://www.bps.go.id/inflasi", title: "Inflasi Indonesia 2026" }])),
          policy: { host: "html.duckduckgo.com", tier: "search-provider",
                    reason: "fixed_provider_host" } };
      }
      return { requestedUrl: url, finalUrl: url, status: 200,
        contentType: "text/html", bytes: 400, contentHash: "page",
        body: Buffer.from(`<h1>Inflasi Indonesia</h1><p>${
          "Inflasi Indonesia tercatat sepanjang tahun. ".repeat(20)}</p>`),
        policy: { host: "www.bps.go.id", tier: "official", reason: "official_psl_zone" } };
    }
  });
  // Page 1 succeeded, so the failure on page 2 is not a provider outage.
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 1);
});

test("a first-page failure is a provider error, not an empty result", async () => {
  const result = await discoverAndRetrieve({
    query: "inflasi indonesia",
    providerId: "duckduckgo-html",
    maxPages: 3,
    fetchUrl: async () => { throw new Error("provider_down"); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_error");
});

// --- what the engine returned first is not what we should fetch --------------
// 2026-09-01: `filterAllowedResults` kept ONE result per host and kept the
// FIRST, before anything was scored. With two allowed hosts every lookup saw
// exactly two pages, chosen by search-engine order — the Astatin article for a
// distillation query, a Pacitan e-mail regulation for anything at all.

test("each host contributes its best matches, not its first", () => {
  const results = [
    { url: "https://peraturan.bpk.go.id/Details/1", title: "Rencana Aksi Satu Data" },
    { url: "https://peraturan.bpk.go.id/Details/2", title: "Tata Kelola Kearsipan" },
    { url: "https://peraturan.bpk.go.id/Details/3", title: "Perlindungan Data Pribadi" }
  ];
  const ranked = rankDiscoveryResults(results, "perlindungan data pribadi");
  assert.equal(ranked[0].url, "https://peraturan.bpk.go.id/Details/3");
  assert.equal(ranked.length, 3);
});

test("one host cannot crowd out the other", () => {
  const results = [
    { url: "https://peraturan.bpk.go.id/Details/1", title: "Inflasi Nasional" },
    { url: "https://peraturan.bpk.go.id/Details/2", title: "Inflasi Daerah" },
    { url: "https://peraturan.bpk.go.id/Details/3", title: "Inflasi Sektoral" },
    { url: "https://peraturan.bpk.go.id/Details/4", title: "Inflasi Pangan" },
    { url: "https://id.wikipedia.org/wiki/Inflasi", title: "Inflasi" }
  ];
  const ranked = rankDiscoveryResults(results, "inflasi indonesia");
  const hosts = ranked.map((result) => result.host);
  assert.equal(hosts.filter((h) => h === "peraturan.bpk.go.id").length, 3);
  assert.ok(hosts.includes("id.wikipedia.org"));
});

test("short acronyms are topical terms, not noise", () => {
  // Dropping every token under three characters scored an AI query against
  // {model, dunia} and refused the OpenAI article that answered it.
  assert.deepEqual(queryTopicalTerms("data AI model di dunia terbaru 2026"),
                   ["ai", "model", "dunia"]);
  assert.deepEqual(queryTopicalTerms("UU perlindungan data pribadi"),
                   ["uu", "perlindungan", "pribadi"]);
});

test("a two-term query is not an all-or-nothing gate", () => {
  // With two terms the score can only be 0, 0.5 or 1. A floor above 0.5 made
  // every such query "both terms or no answer at all" — and the second term is
  // often the weak one ("indonesia", "dunia").
  const score = relevanceScore({
    title: "Sejarah Indonesia",
    text: "Sejarah Indonesia mencakup periode yang panjang. "
  }, "inflasi indonesia 2026");
  assert.equal(score, 0.5);
  assert.ok(score >= RELEVANCE_FLOOR, `scored ${score}`);
});

test("a page matching one of three query terms is still off-topic", () => {
  // Measured on the real Wikipedia article, 2026-09-01: for "data AI model di
  // dunia terbaru 2026" the OpenAI page scores 0.33 — it matches "model" and
  // neither "ai" (as a standalone word) nor "dunia". No threshold rescues this
  // query; the corpus does not contain its answer. See the note in
  // discoverAndRetrieve about what the two allowed hosts can and cannot serve.
  const score = relevanceScore({
    title: "OpenAI",
    text: "OpenAI adalah laboratorium penelitian kecerdasan buatan. "
        + "Perusahaan ini mengembangkan model bahasa besar. "
  }, "data AI model di dunia terbaru 2026");
  assert.ok(score < RELEVANCE_FLOOR, `scored ${score}`);
});

// Brave answered HTTP 429 with a captcha page after a burst of searches
// (2026-09-02). The page parsed to zero results, so the run ended as
// "no_allowed_results" and the pane told the user to rephrase. A refused
// search is a provider failure, and the user needs to know to wait, not reword.
test("a non-2xx search page is a provider error, not an empty result", async () => {
  const audits = [];
  const result = await discoverAndRetrieve({
    query: "Sahabat-AI",
    providerId: "brave-html",
    env: OPEN,
    audit: (event) => audits.push(event),
    fetchUrl: async (url) => ({
      requestedUrl: url, finalUrl: url, status: 429, contentType: "text/html",
      contentHash: "captcha", bytes: 73398,
      body: Buffer.from("<html><title>Brave Search</title><div class=captcha>challenge</div></html>"),
      policy: { host: "search.brave.com", tier: "search-provider", reason: "fixed_provider_host" }
    })
  });
  assert.equal(result.ok, false);
  // 429 is its own reason: the provider WAS reached and said "not now". The
  // pane's advice differs — wait or switch provider, not "check the connection".
  assert.equal(result.reason, "provider_rate_limited");
  assert.ok(audits.some((e) => e.stage === "search" && e.outcome === "error"
    && /429/.test(String(e.reason))), JSON.stringify(audits));
});

test("a non-429 refused search page is a plain provider error", async () => {
  const result = await discoverAndRetrieve({
    query: "Sahabat-AI", providerId: "brave-html", env: OPEN,
    fetchUrl: async (url) => ({
      requestedUrl: url, finalUrl: url, status: 503, contentType: "text/html",
      contentHash: "x", bytes: 10, body: Buffer.from("<html>down</html>"),
      policy: { host: "search.brave.com", tier: "search-provider", reason: "fixed_provider_host" }
    })
  });
  assert.equal(result.reason, "provider_error");
});
