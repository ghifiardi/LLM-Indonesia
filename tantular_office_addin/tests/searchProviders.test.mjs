import test from "node:test";
import assert from "node:assert/strict";

import {
  bingTarget,
  duckDuckGoTarget,
  parseBingHtml,
  parseBraveHtml,
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

test("DuckDuckGo page 1 is unchanged; later pages carry the offset", () => {
  const provider = searchProvider("duckduckgo-html");
  // Omitting the option and asking for page 1 must be byte-identical.
  assert.equal(provider.buildRequest("inflasi").url,
               provider.buildRequest("inflasi", { page: 1 }).url);
  assert.doesNotMatch(provider.buildRequest("inflasi", { page: 1 }).url, /[?&]s=/);
  const page2 = new URL(provider.buildRequest("inflasi", { page: 2 }).url);
  // 30-per-page stride: page 2 starts at offset 30.
  assert.equal(page2.searchParams.get("s"), "30");
  assert.equal(page2.searchParams.get("q"), "inflasi");
  assert.equal(new URL(provider.buildRequest("inflasi", { page: 3 }).url)
    .searchParams.get("s"), "60");
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

test("SearXNG omits pageno on page 1 and appends it past page 1", () => {
  const remote = searchProvider("searxng", { TANTULAR_SEARXNG_URL: "https://searx.example" });
  assert.equal(remote.buildRequest("inflasi").url,
               remote.buildRequest("inflasi", { page: 1 }).url);
  assert.doesNotMatch(remote.buildRequest("inflasi", { page: 1 }).url, /pageno/);
  assert.equal(new URL(remote.buildRequest("inflasi", { page: 4 }).url)
    .searchParams.get("pageno"), "4");
});

test("a localhost SearXNG is treated as trusted local infrastructure", () => {
  const local = searchProvider("searxng", { TANTULAR_SEARXNG_URL: "http://127.0.0.1:8888" });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.allowLocalProvider, true);
  assert.deepEqual(local.searchContentTypes, ["application/json"]);
});

// --- Bing HTML ----------------------------------------------------------------
//
// DuckDuckGo is DNS-blocked by Indonesian ISPs (it resolves to the Internet
// Positif page and times out, 2026-09-02). Bing answers, and its organic result
// links are click redirects whose `u` parameter carries the real URL as
// "a1" + base64url. Decoding happens here, offline; the decoded URL is then
// normalised and goes through the same domain policy and fetch door as any
// other candidate. Nothing is fetched from bing.com/ck.

const BING_REDIRECT = "https://www.bing.com/ck/a?!&amp;&amp;p=b8c1JmltdHM&amp;ptn=3"
  + "&amp;u=a1aHR0cHM6Ly9zYWhhYmF0LWFpLmNvbS8&amp;ntb=1";

test("Bing redirect links decode to the real HTTPS target", () => {
  assert.equal(bingTarget(BING_REDIRECT), "https://sahabat-ai.com/");
  // Unpadded base64url with a query string in the target.
  assert.equal(bingTarget("https://www.bing.com/ck/a?u=a1"
    + Buffer.from("https://www.kompas.id/artikel/x?y=1&z=2").toString("base64url")),
    "https://www.kompas.id/artikel/x?y=1&z=2");
  // A direct https link passes through, normalised.
  assert.equal(bingTarget("https://Example.COM/path"), "https://example.com/path");
});

test("Bing redirect decoding refuses http, garbage, and non-URL payloads", () => {
  assert.equal(bingTarget("https://www.bing.com/ck/a?u=a1"
    + Buffer.from("http://insecure.example/").toString("base64url")), "");
  assert.equal(bingTarget("https://www.bing.com/ck/a?u=a1!!!notbase64"), "");
  assert.equal(bingTarget("https://www.bing.com/ck/a?u=a1"
    + Buffer.from("javascript:alert(1)").toString("base64url")), "");
  assert.equal(bingTarget("https://www.bing.com/ck/a?u=a1"), "");
  assert.equal(bingTarget("https://www.bing.com/ck/a?p=nothing"), "");
  assert.equal(bingTarget("http://plain.example/"), "");
});

test("Bing parser extracts organic results, titles, and de-duplicates", () => {
  const html = `
    <li class="b_algo" data-id iid="SERP.5312"><link rel="stylesheet" href="/rp/x.css"/>
      <h2 class=""><a target="_blank" href="${BING_REDIRECT}" h="ID=SERP,5108.2">
        <strong>Sahabat-AI</strong> | Open-Source LLMs for Bahasa Indonesia</a></h2>
      <div class="b_caption"><p>snippet</p></div></li>
    <li class="b_algo"><h2><a href="https://sahabat-ai.com/">duplicate</a></h2></li>
    <li class="b_algo"><h2><a href="https://huggingface.co/Sahabat-AI">Sahabat-AI - Hugging Face</a></h2></li>
    <li class="b_ad"><h2><a href="https://ads.example/">an ad</a></h2></li>
    <li class="b_algo"><h2><a href="http://insecure.example/">ignore http</a></h2></li>`;
  assert.deepEqual(parseBingHtml(html), [
    { url: "https://sahabat-ai.com/",
      title: "Sahabat-AI | Open-Source LLMs for Bahasa Indonesia" },
    { url: "https://huggingface.co/Sahabat-AI", title: "Sahabat-AI - Hugging Face" }
  ]);
});

test("Bing provider builds a fixed-host request and pages by first=", () => {
  const provider = searchProvider("bing-html");
  const request = provider.buildRequest("pasar modal & OJK");
  assert.equal(new URL(request.url).hostname, "www.bing.com");
  assert.equal(new URL(request.url).searchParams.get("q"), "pasar modal & OJK");
  assert.deepEqual(provider.searchContentTypes, ["text/html", "application/xhtml+xml"]);
  assert.equal(provider.buildRequest("inflasi").url,
               provider.buildRequest("inflasi", { page: 1 }).url);
  assert.doesNotMatch(provider.buildRequest("inflasi").url, /[?&]first=/);
  assert.equal(new URL(provider.buildRequest("inflasi", { page: 2 }).url)
    .searchParams.get("first"), "11");
  assert.equal(new URL(provider.buildRequest("inflasi", { page: 3 }).url)
    .searchParams.get("first"), "21");
});

// --- Brave HTML ---------------------------------------------------------------
//
// Bing answers "Sahabat-AI" well and returns junk for "Analisis Strategis
// Sahabat-AI dan Transformasi Data" — the document title a user actually pastes
// (2026-09-02: zhihu, douban, reddit front pages as "results"). Brave returned
// on-topic pages for the same long query, so it is the open-policy default.

const BRAVE_BLOCK = (url, title, extra = "") => `
  <div class="snippet svelte-jmfu5f" data-pos="0" data-type="web" data-keynav="true">
    <div class="result-body"><div class="result-content">
      <a href="${url}" target="_self" class="svelte-14r20fy l1">
        <div class="site-name-wrapper"><img alt="" src="https://imgs.search.brave.com/x"/>
          <div class="desktop-small-semibold">LinkedIn</div>
          <cite class="snippet-url">id.linkedin.com <span>› pulse › x</span></cite></div>
        <div class="title search-snippet-title line-clamp-1" title="${title}">${title}</div>
      </a>${extra}
    </div></div>
  </div>`;

test("Brave parser extracts web results, titles, and de-duplicates", () => {
  const html = `
    <div class="snippet noscript-hide svelte-jmfu5f" id="llm-snippet">
      <a href="https://search.brave.com/llm">AI answer box</a></div>
    ${BRAVE_BLOCK("https://id.linkedin.com/pulse/big-data-dan-ai",
                  "Big Data dan AI: Kolaborasi Strategis untuk Transformasi")}
    ${BRAVE_BLOCK("https://id.linkedin.com/pulse/big-data-dan-ai", "duplicate")}
    <div class="snippet svelte-1ajsqxo" data-type="news">
      <a href="https://news.example/x"><div class="title">news module</div></a></div>
    ${BRAVE_BLOCK("http://insecure.example/", "ignore http")}
    ${BRAVE_BLOCK("https://www.menpan.go.id/site/berita", "Pemerintah &amp; AI")}`;
  assert.deepEqual(parseBraveHtml(html), [
    { url: "https://id.linkedin.com/pulse/big-data-dan-ai",
      title: "Big Data dan AI: Kolaborasi Strategis untuk Transformasi" },
    { url: "https://www.menpan.go.id/site/berita", title: "Pemerintah & AI" }
  ]);
});

test("Brave provider builds a fixed-host request and pages by offset", () => {
  const provider = searchProvider("brave-html");
  const request = provider.buildRequest("pasar modal & OJK");
  assert.equal(new URL(request.url).hostname, "search.brave.com");
  assert.equal(new URL(request.url).searchParams.get("q"), "pasar modal & OJK");
  assert.deepEqual(provider.searchContentTypes, ["text/html", "application/xhtml+xml"]);
  assert.equal(provider.buildRequest("inflasi").url,
               provider.buildRequest("inflasi", { page: 1 }).url);
  assert.doesNotMatch(provider.buildRequest("inflasi").url, /[?&]offset=/);
  assert.equal(new URL(provider.buildRequest("inflasi", { page: 2 }).url)
    .searchParams.get("offset"), "1");
  assert.equal(new URL(provider.buildRequest("inflasi", { page: 3 }).url)
    .searchParams.get("offset"), "2");
});
