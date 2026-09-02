// Search-engine discovery is intentionally behind a provider interface. The
// alpha starts with DuckDuckGo HTML (no credential); production can swap in a
// contracted Brave/Bing implementation without touching domain policy,
// retrieval, verification, approval, or audit.

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

function attr(attrs, name) {
  const match = String(attrs).match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? "");
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}

export function duckDuckGoTarget(href) {
  const raw = decodeHtml(href);
  let url;
  try {
    url = new URL(raw, "https://html.duckduckgo.com");
  } catch {
    return "";
  }
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    const target = url.searchParams.get("uddg");
    if (target) {
      try { return new URL(target).href; } catch { return ""; }
    }
  }
  return url.protocol === "https:" ? url.href : "";
}

// One DuckDuckGo HTML page holds up to ~30 results. Parsing the whole page and
// paginating by the same stride keeps page boundaries aligned: no gap between
// page N's last result and page N+1's first, and the discovery loop dedupes any
// small overlap by URL.
export const DUCKDUCKGO_PAGE_SIZE = 30;

export function parseDuckDuckGoHtml(html, { maxResults = DUCKDUCKGO_PAGE_SIZE } = {}) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const classes = attr(attrs, "class").split(/\s+/);
    if (!classes.includes("result__a")) continue;
    const url = duckDuckGoTarget(attr(attrs, "href"));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: stripTags(match[2]) });
    if (out.length >= maxResults) break;
  }
  return out;
}

// --- Bing HTML ----------------------------------------------------------------
//
// Why a second HTML engine: DuckDuckGo is DNS-blocked by Indonesian ISPs
// (2026-09-02, resolves to the Internet Positif page and times out), Mojeek
// serves a captcha and public SearXNG instances refuse JSON. Bing answers.
//
// Bing's organic links are click redirects (bing.com/ck/a?...&u=a1<base64url>).
// The real URL is decoded HERE, offline, then normalised through URL(). What
// comes out is a candidate like any other: domain policy decides whether it may
// be fetched, and the fetch door re-checks HTTPS and private addresses. The
// redirect itself is never followed — that would send the query to Bing twice
// and hand the fetch door a tracking URL.

function httpsOnly(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return ""; }
  return url.protocol === "https:" ? url.href : "";
}

export function bingTarget(href) {
  const raw = decodeHtml(href);
  let url;
  try {
    url = new URL(raw, "https://www.bing.com");
  } catch {
    return "";
  }
  const isBing = url.hostname === "bing.com" || url.hostname.endsWith(".bing.com");
  if (isBing && url.pathname.startsWith("/ck/")) {
    const encoded = url.searchParams.get("u") || "";
    // "a1" is a version prefix Bing puts before the base64url payload.
    if (!encoded.startsWith("a1")) return "";
    const payload = encoded.slice(2);
    if (!/^[A-Za-z0-9_-]+=*$/.test(payload)) return "";
    let decoded;
    try { decoded = Buffer.from(payload, "base64url").toString("utf8"); } catch { return ""; }
    return httpsOnly(decoded);
  }
  if (isBing) return "";
  return httpsOnly(url.href);
}

export const BING_PAGE_SIZE = 10;

export function parseBingHtml(html, { maxResults = 3 * BING_PAGE_SIZE } = {}) {
  const out = [];
  const seen = new Set();
  // Only organic results (<li class="b_algo">). Ads and answer boxes use other
  // classes and are not sources.
  for (const block of String(html || "").matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    if (!attr(block[1], "class").split(/\s+/).includes("b_algo")) continue;
    const anchor = block[2].match(/<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = bingTarget(attr(anchor[1], "href"));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: stripTags(anchor[2]) });
    if (out.length >= maxResults) break;
  }
  return out;
}

// --- Brave HTML ---------------------------------------------------------------
//
// Bing answers a short entity query well and returns junk for the long
// document-title queries users actually paste (2026-09-02: zhihu, douban and
// reddit front pages as "results" for "Analisis Strategis Sahabat-AI dan
// Transformasi Data"). Brave returned on-topic pages for that same query, so
// it is the open-policy default; Bing stays selectable.
//
// Result markup: <div class="snippet ..." data-type="web"> holding the result
// link and a <div class="title ..." title="..."> element. Only data-type="web"
// blocks count; the AI answer box, news and video modules are not sources.

export function parseBraveHtml(html, { maxResults = 30 } = {}) {
  const out = [];
  const seen = new Set();
  const text = String(html || "");
  const opener = /<div\b[^>]*\bclass="snippet\b[^"]*"[^>]*>/gi;
  for (const match of text.matchAll(opener)) {
    if (!/\bdata-type="web"/i.test(match[0])) continue;
    // A block ends where the next snippet begins. Brave nests deeply, so
    // counting divs is fragile; the next result opener is a stable boundary.
    const start = match.index + match[0].length;
    const next = text.slice(start).search(/<div\b[^>]*\bclass="snippet\b/i);
    const block = text.slice(start, next < 0 ? undefined : start + next);
    const anchor = block.match(/<a\b([^>]*)>/i);
    if (!anchor) continue;
    const url = httpsOnly(attr(anchor[1], "href"));
    if (!url || seen.has(url)) continue;
    const titleEl = block.match(/<div\b([^>]*\bclass="title\b[^"]*"[^>]*)>([\s\S]*?)<\/div>/i);
    const title = titleEl
      ? (attr(titleEl[1], "title") || stripTags(titleEl[2]))
      : stripTags(block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");
    seen.add(url);
    out.push({ url, title });
    if (out.length >= maxResults) break;
  }
  return out;
}

export const SEARCH_PROVIDERS = Object.freeze({
  "official-federated": Object.freeze({
    id: "official-federated",
    label: "Sumber resmi otomatis",
    kind: "federated-adapters"
  }),
  "duckduckgo-html": Object.freeze({
    id: "duckduckgo-html",
    label: "DuckDuckGo HTML (alpha)",
    host: "html.duckduckgo.com",
    searchContentTypes: Object.freeze(["text/html", "application/xhtml+xml"]),
    // `page` is 1-based. Page 1 keeps the exact URL it always produced, so no
    // caller (or test) that omits the option changes behaviour. Later pages add
    // DuckDuckGo's own paging fields: `s` is the result offset and `dc` the
    // display counter; `v/o/api` mirror the values its "next" form submits.
    buildRequest(query, { page = 1 } = {}) {
      let url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query || ""))}`;
      if (page > 1) {
        const offset = (page - 1) * DUCKDUCKGO_PAGE_SIZE;
        url += `&s=${offset}&dc=${offset + 1}&v=l&o=json&api=d.js`;
      }
      return {
        url,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TantularOfficeAlpha/0.1)",
          "Accept": "text/html,application/xhtml+xml"
        }
      };
    },
    parse: parseDuckDuckGoHtml
  }),
  "bing-html": Object.freeze({
    id: "bing-html",
    label: "Bing (web umum)",
    host: "www.bing.com",
    searchContentTypes: Object.freeze(["text/html", "application/xhtml+xml"]),
    // `page` is 1-based. Bing pages by result offset: `first=11` is page 2 of
    // ten. Page 1 carries no offset so the request stays minimal.
    buildRequest(query, { page = 1 } = {}) {
      const params = new URLSearchParams({
        q: String(query || ""), setlang: "id", cc: "ID"
      });
      if (page > 1) params.set("first", String((page - 1) * BING_PAGE_SIZE + 1));
      return {
        url: `https://www.bing.com/search?${params.toString()}`,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TantularOfficeAlpha/0.1)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "id-ID,id;q=0.9,en;q=0.5"
        }
      };
    },
    parse: parseBingHtml
  }),
  "brave-html": Object.freeze({
    id: "brave-html",
    label: "Brave Search (web umum)",
    host: "search.brave.com",
    searchContentTypes: Object.freeze(["text/html", "application/xhtml+xml"]),
    // `page` is 1-based; Brave's `offset` is a 0-based page index, and page 1
    // carries no offset so the first request stays minimal.
    buildRequest(query, { page = 1 } = {}) {
      const params = new URLSearchParams({ q: String(query || ""), source: "web" });
      if (page > 1) params.set("offset", String(page - 1));
      return {
        url: `https://search.brave.com/search?${params.toString()}`,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TantularOfficeAlpha/0.1)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "id-ID,id;q=0.9,en;q=0.5"
        }
      };
    },
    parse: parseBraveHtml
  })
});

// SearXNG is the free, keyless, terms-clean option: open-source metasearch the
// user runs themselves (for example `docker run searxng/searxng`). Because it
// is the user's OWN trusted infrastructure — not a discovered page — the search
// step may reach it on localhost/JSON; the retrieved RESULT pages still go
// through full SSRF + domain policy. The instance URL is configuration, never
// hard-coded, so nothing leaves the machine to a host the user did not set.
export function parseSearxngJson(text, { maxResults = 12 } = {}) {
  let parsed;
  try { parsed = JSON.parse(String(text || "")); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const result of Array.isArray(parsed?.results) ? parsed.results : []) {
    let url;
    try { url = new URL(String(result?.url || "")); } catch { continue; }
    if (url.protocol !== "https:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({ url: url.href, title: String(result?.title || "").trim() });
    if (out.length >= maxResults) break;
  }
  return out;
}

export function searxngProvider(env = process.env) {
  const raw = String(env.TANTULAR_SEARXNG_URL || "").trim();
  if (!raw) return null;
  let base;
  try { base = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(base.protocol)) return null;
  const origin = `${base.protocol}//${base.host}`;
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(
    base.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  return Object.freeze({
    id: "searxng",
    label: "SearXNG (self-hosted)",
    host: base.hostname.toLowerCase(),
    // Only a self-hosted (local) instance is trusted infrastructure that may be
    // reached over http/loopback. A remote instance must be https and public.
    allowLocalProvider: isLocal,
    searchContentTypes: Object.freeze(["application/json"]),
    // `page` is 1-based. `pageno` is only appended past page 1 so the first
    // request stays byte-identical to what it produced before pagination.
    buildRequest(query, { page = 1 } = {}) {
      const params = new URLSearchParams({
        q: String(query || ""), format: "json", safesearch: "1", language: "id"
      });
      if (page > 1) params.set("pageno", String(page));
      return {
        url: `${origin}/search?${params.toString()}`,
        headers: { "Accept": "application/json",
                   "User-Agent": "TantularOffice/0.1 (self-hosted searxng)" }
      };
    },
    parse: parseSearxngJson
  });
}

export function searchProvider(id, env = process.env) {
  const key = String(id || "").trim().toLowerCase();
  if (key === "searxng") return searxngProvider(env);
  return SEARCH_PROVIDERS[key] || null;
}
