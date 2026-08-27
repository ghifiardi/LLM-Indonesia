import { classifyDomain, filterAllowedResults } from "./domainPolicy.js";
import { extractFetchedText } from "./contentExtract.js";
import { safeFetchUrl } from "./safeFetch.js";
import { searchProvider } from "./searchProviders.js";
import { allowedHosts, resolveUrl } from "./lookupPolicy.js";

export const DEFAULT_DISCOVERY_PROVIDER = "official-federated";

export function discoveryEnabled(env = process.env) {
  return String(env.TANTULAR_LOOKUP_DISCOVERY_ALPHA || "").toLowerCase() === "true";
}

export function configuredProvider(env = process.env) {
  return String(env.TANTULAR_SEARCH_PROVIDER || DEFAULT_DISCOVERY_PROVIDER).trim().toLowerCase();
}

export function parseWikipediaSearchJson(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || "")); } catch { return []; }
  const out = [];
  for (const page of Array.isArray(parsed?.pages) ? parsed.pages : []) {
    const key = String(page?.key || "").trim();
    if (!key) continue;
    out.push({
      url: `https://id.wikipedia.org/wiki/${encodeURIComponent(key).replace(/%2F/gi, "/")}`,
      title: String(page?.title || key)
    });
  }
  return out;
}

function decodeHtml(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g,
      (_m, number) => String.fromCodePoint(Number(number)));
}

export function parseBpkSearchHtml(html) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const hrefMatch = match[1].match(/\bhref=(?:"([^"]*)"|'([^']*)')/i);
    const href = decodeHtml(hrefMatch?.[1] ?? hrefMatch?.[2] ?? "");
    if (!/\/Details\/\d+/i.test(href)) continue;
    let url;
    try { url = new URL(href, "https://peraturan.bpk.go.id").href; } catch { continue; }
    if (new URL(url).hostname !== "peraturan.bpk.go.id" || seen.has(url)) continue;
    seen.add(url);
    const title = decodeHtml(match[2].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ").trim();
    out.push({ url, title: title || "Peraturan JDIH BPK" });
  }
  return out;
}

export async function federatedAdapterCandidates({
  query,
  env = process.env,
  fetchUrl = safeFetchUrl,
  audit = () => {}
}) {
  const candidates = [];
  for (const host of allowedHosts(env)) {
    const searchUrl = resolveUrl(host, query, env);
    if (!searchUrl) continue;
    const isWikipedia = host === "id.wikipedia.org";
    try {
      const response = await fetchUrl(searchUrl, {
        timeoutMs: 8_000,
        maxBytes: 750_000,
        headers: {
          "User-Agent": "TantularOffice/0.1 (approved-source discovery)",
          "Accept": isWikipedia ? "application/json" : "text/html,application/xhtml+xml"
        },
        allowContentTypes: isWikipedia
          ? ["application/json"] : ["text/html", "application/xhtml+xml"],
        policy: (url) => {
          const actual = new URL(url).hostname.toLowerCase();
          return { allowed: actual === host, host: actual, tier: "search-adapter",
                   reason: actual === host ? "fixed_adapter_host" : "adapter_redirect_blocked" };
        }
      });
      const found = isWikipedia
        ? parseWikipediaSearchJson(response.body.toString("utf8"))
        : parseBpkSearchHtml(response.body.toString("utf8"));
      candidates.push(...found);
      audit({
        stage: "search", provider: "official-federated", domain: host,
        requestedUrl: response.requestedUrl, finalUrl: response.finalUrl,
        contentHash: response.contentHash, status: response.status,
        bytes: response.bytes, outcome: "ok", resultCount: found.length,
        policyReason: "fixed_adapter_host", domainTier: "search-adapter"
      });
    } catch (error) {
      audit({
        stage: "search", provider: "official-federated", domain: host,
        requestedUrl: searchUrl, outcome: "error",
        reason: String(error?.message || error),
        policyReason: "fixed_adapter_host", domainTier: "search-adapter"
      });
    }
  }
  return candidates;
}

export function queryRequiresOfficial(query) {
  return /\b(undang-undang|uu\b|peraturan|regulasi|kebijakan|hukum|pasal|putusan|jdih|pemerintah|kementerian)\b/i
    .test(String(query || ""));
}

export function rankDiscoveryResults(results, query) {
  const allowed = filterAllowedResults(results);
  const officialOnly = queryRequiresOfficial(query);
  const filtered = officialOnly
    ? allowed.filter((result) => result.tier === "official")
    : allowed;
  return filtered.sort((a, b) => {
    const rank = (item) => item.tier === "official" ? 0 : 1;
    return rank(a) - rank(b);
  });
}

export function domainDecision(url) {
  const classified = classifyDomain(url);
  return {
    ...classified,
    allowed: classified.tier === "official" || classified.tier === "trusted-reference"
  };
}

export async function discoverAndRetrieve({
  query,
  providerId = DEFAULT_DISCOVERY_PROVIDER,
  fetchUrl = safeFetchUrl,
  maxSources = 3,
  audit = () => {},
  env = process.env
}) {
  const provider = searchProvider(providerId, env);
  if (!provider) return { ok: false, reason: "provider_unavailable", sources: [] };

  let rawCandidates;
  if (provider.kind === "federated-adapters") {
    rawCandidates = await federatedAdapterCandidates({
      query, env, fetchUrl, audit
    });
  } else {
    const request = provider.buildRequest(query);
    let search;
    try {
      search = await fetchUrl(request.url, {
        headers: request.headers,
        timeoutMs: 8_000,
        maxBytes: 750_000,
        allowHttp: provider.allowLocalProvider === true,
        allowPrivateHost: provider.allowLocalProvider === true,
        allowContentTypes: provider.searchContentTypes,
        policy: (url) => {
          const host = new URL(url).hostname.toLowerCase();
          return { allowed: host === provider.host, host, tier: "search-provider",
                   reason: host === provider.host ? "fixed_provider_host" : "provider_redirect_blocked" };
        }
      });
    } catch (error) {
      audit({ stage: "search", provider: provider.id, outcome: "error",
              reason: String(error?.message || error) });
      return { ok: false, reason: "provider_error", sources: [] };
    }
    rawCandidates = provider.parse(search.body.toString("utf8"));
    audit({ stage: "search", provider: provider.id, outcome: "ok",
            requestedUrl: search.requestedUrl, finalUrl: search.finalUrl,
            contentHash: search.contentHash, resultCount: rawCandidates.length });
  }
  const candidates = rankDiscoveryResults(rawCandidates, query);

  const sources = [];
  for (const candidate of candidates.slice(0, 8)) {
    const initialPolicy = domainDecision(candidate.url);
    try {
      const fetched = await fetchUrl(candidate.url, {
        timeoutMs: 8_000,
        maxBytes: 1_000_000,
        headers: {
          "User-Agent": "TantularOffice/0.1 (official-source retrieval alpha)",
          "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf"
        },
        policy: domainDecision
      });
      const extracted = extractFetchedText(fetched);
      audit({
        stage: "retrieve",
        provider: provider.id,
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        domain: fetched.policy.host,
        domainTier: fetched.policy.tier,
        policyReason: fetched.policy.reason,
        status: fetched.status,
        contentType: fetched.contentType,
        bytes: fetched.bytes,
        contentHash: fetched.contentHash,
        outcome: extracted.ok ? "usable" : extracted.reason
      });
      if (!extracted.ok || fetched.status < 200 || fetched.status >= 300) continue;
      sources.push({
        id: `S${sources.length + 1}`,
        url: fetched.finalUrl,
        title: candidate.title || fetched.policy.host,
        host: fetched.policy.host,
        tier: fetched.policy.tier,
        policyReason: fetched.policy.reason,
        contentHash: fetched.contentHash,
        text: extracted.text
      });
      if (sources.length >= maxSources) break;
    } catch (error) {
      audit({
        stage: "retrieve",
        provider: provider.id,
        requestedUrl: candidate.url,
        domain: initialPolicy.host,
        domainTier: initialPolicy.tier,
        policyReason: initialPolicy.reason,
        outcome: "blocked_or_error",
        reason: String(error?.message || error)
      });
    }
  }
  if (!sources.length) {
    return { ok: false, reason: candidates.length ? "no_fetchable_sources" : "no_allowed_results",
             sources: [], provider: provider.id };
  }
  return { ok: true, provider: provider.id, sources };
}

export function sourcesAsUntrusted(sources) {
  return sources.map((source) =>
    `[${source.id}] ${source.title}\nURL: ${source.url}\nTier: ${source.tier}\n${source.text}`)
    .join("\n\n");
}
