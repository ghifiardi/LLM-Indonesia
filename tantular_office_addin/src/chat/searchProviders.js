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

export function parseDuckDuckGoHtml(html, { maxResults = 12 } = {}) {
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
    buildRequest(query) {
      return {
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query || ""))}`,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TantularOfficeAlpha/0.1)",
          "Accept": "text/html,application/xhtml+xml"
        }
      };
    },
    parse: parseDuckDuckGoHtml
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
    buildRequest(query) {
      const params = new URLSearchParams({
        q: String(query || ""), format: "json", safesearch: "1", language: "id"
      });
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
