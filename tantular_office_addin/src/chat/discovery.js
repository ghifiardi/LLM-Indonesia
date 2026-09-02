import { classifyDomain, filterAllowedResults, isFetchAllowed, sourcePolicy } from "./domainPolicy.js";
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

// --- relevance ---------------------------------------------------------------
//
// Both federated adapters ALWAYS return something: a keyword search with no
// real match still hands back its best guess. On 2026-09-01 the query
// "perbandingan proyek distillation data resmi" retrieved a Pacitan e-mail
// regulation and the Wikipedia article on Astatin, and the run then failed at
// the citation gate — the model, correctly, had nothing to cite. Tier told us
// the page was ALLOWED; nothing asked whether it was ABOUT the question.
//
// Words that carry no topic. Dropping them matters more than it looks: the
// refine chips append "data resmi" and "terbaru 2026" to the query, so a page
// titled "Pedoman Penggunaan Email Resmi" otherwise scores a match on "resmi".
const QUERY_STOPWORDS = new Set([
  // Two-letter words are kept out by name rather than by length: "AI", "UU"
  // and "PDB" are exactly the terms a query is ABOUT, and dropping every short
  // token scored "data AI model di dunia" against {model, dunia} alone.
  "di", "ke", "ya", "se", "yg", "dg", "tsb", "utk", "dll", "dsb",
  "dan", "yang", "untuk", "dari", "pada", "dengan", "atau", "adalah", "itu",
  "ini", "apa", "tentang", "sebagai", "akan", "oleh", "serta", "para", "juga",
  "bagaimana", "berapa", "kapan", "siapa", "mana", "saja", "the", "of", "in"
]);
const QUERY_GENERIC_TERMS = new Set([
  "data", "resmi", "terbaru", "informasi", "laporan", "sumber", "ringkasan",
  "dokumen", "angka", "statistik", "perbandingan", "daftar", "update",
  "berita", "terkini", "lengkap", "nasional"
]);

// Measured on real adapter output, 2026-09-01: relevant pages scored 0.67-1.00,
// clearly off-topic ones 0.00, borderline ones 0.50. The floor sits AT the
// borderline rather than above it, because the two sides are not symmetric: a
// marginal source is recoverable — the model answers from the document and
// marks NO_COVERAGE_MARKER — while an empty source set is a dead end that
// tells the user only to rephrase. A short query makes every step coarse
// (with two terms the score can only be 0, 0.5 or 1), and 0.6 turned every
// two-term query into "both terms or nothing". See tests/discovery.test.mjs.
export const RELEVANCE_FLOOR = 0.5;
// Host diversity is worth keeping, but not at one page per host: with two
// allowed hosts that capped every lookup at two candidates.
const MAX_PER_HOST = 3;
// A long article mentions almost any common word somewhere — the Astatin page
// contains "proyek" once in 30k characters. Only the opening counts, which is
// where a page says what it is about.
const LEAD_CHARS = 1200;

function normaliseForMatch(value) {
  return ` ${String(value || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ").trim()} `;
}

export function queryTopicalTerms(query) {
  const terms = new Set();
  for (const token of normaliseForMatch(query).trim().split(" ")) {
    if (token.length < 2 || /^\d+$/.test(token)) continue;
    if (QUERY_STOPWORDS.has(token) || QUERY_GENERIC_TERMS.has(token)) continue;
    terms.add(token);
  }
  return [...terms];
}

// A query of nothing but generic words ("data resmi terbaru") has no topical
// term to score against. Judging it by an empty set would reject every page,
// so fall back to whatever non-stopword terms it does have.
function scoringTerms(query) {
  const topical = queryTopicalTerms(query);
  if (topical.length) return topical;
  return [...new Set(normaliseForMatch(query).trim().split(" ")
    .filter((token) => token.length >= 2 && !QUERY_STOPWORDS.has(token)))];
}

function coverage(haystack, terms) {
  if (!terms.length) return 0;
  const hay = normaliseForMatch(haystack);
  // Prefix match, so Indonesian affixes ("proyeknya") still count.
  return terms.filter((term) => hay.includes(` ${term}`)).length / terms.length;
}

// The title or the opening of the page must be about the question. Either is
// enough: a search result's title is often generic ("Data BPS") while its lead
// is on point, and a precise title can front a page whose lead is boilerplate.
export function relevanceScore({ title, text } = {}, query) {
  const terms = scoringTerms(query);
  if (!terms.length) return 1;
  return Math.max(coverage(title, terms),
                  coverage(String(text || "").slice(0, LEAD_CHARS), terms));
}

export function rankDiscoveryResults(results, query,
  { maxPerHost = MAX_PER_HOST, env = process.env } = {}) {
  // Every allowed result, not one per host: the per-host cap is applied below,
  // once the results have been SCORED, so a host contributes its best pages
  // rather than whichever one the search engine happened to list first.
  const allowed = filterAllowedResults(results, { maxPerHost: Infinity, env });
  // Under the official policy a legal question is answered from official
  // sources only, and official pages outrank reference ones. The open policy
  // has no such preference: the owner's call (2026-09-02) was "no official
  // preference", so the title match alone decides the order.
  const officialPolicy = sourcePolicy(env) === "official";
  const officialOnly = officialPolicy && queryRequiresOfficial(query);
  const filtered = officialOnly
    ? allowed.filter((result) => result.tier === "official")
    : allowed;
  const terms = scoringTerms(query);
  const ordered = filtered.map((result) => ({
    result, score: coverage(result.title, terms)
  })).sort((a, b) => {
    const rank = (item) => officialPolicy && item.result.tier !== "official" ? 1 : 0;
    return rank(a) - rank(b) || b.score - a.score;
  });
  const taken = new Map();
  const kept = [];
  for (const { result } of ordered) {
    const count = taken.get(result.host) || 0;
    if (count >= maxPerHost) continue;
    taken.set(result.host, count + 1);
    kept.push(result);
  }
  return kept;
}

export function domainDecision(url, env = process.env) {
  const classified = classifyDomain(url);
  return { ...classified, allowed: isFetchAllowed(url, { env }) };
}

export async function discoverAndRetrieve({
  query,
  providerId = DEFAULT_DISCOVERY_PROVIDER,
  fetchUrl = safeFetchUrl,
  maxSources = 3,
  maxPages,
  maxRetrievalCandidates,
  audit = () => {},
  env = process.env
}) {
  const provider = searchProvider(providerId, env);
  if (!provider) return { ok: false, reason: "provider_unavailable", sources: [] };

  // How many search-result pages to pull, and how many of the ranked candidates
  // to actually retrieve. Pagination widens the POOL the ranker sees; the
  // retrieval cap still bounds how many real pages get fetched. Env overrides so
  // an operator can trade latency for breadth without a code change.
  const pages = Math.max(1,
    Number(maxPages ?? env.TANTULAR_LOOKUP_MAX_PAGES ?? 3) || 1);
  const fetchLimit = Math.max(maxSources,
    Number(maxRetrievalCandidates ?? env.TANTULAR_LOOKUP_MAX_FETCH ?? 8) || 8);

  let rawCandidates;
  if (provider.kind === "federated-adapters") {
    rawCandidates = await federatedAdapterCandidates({
      query, env, fetchUrl, audit
    });
  } else {
    // Page through the provider, accumulating results across pages. Dedupe by
    // URL so an overlap between adjacent pages does not double-count, and stop
    // early the moment a page adds nothing new — that is the end of results, and
    // fetching further empty pages only burns latency.
    rawCandidates = [];
    const seenUrls = new Set();
    const providerPolicy = (url) => {
      const host = new URL(url).hostname.toLowerCase();
      return { allowed: host === provider.host, host, tier: "search-provider",
               reason: host === provider.host ? "fixed_provider_host" : "provider_redirect_blocked" };
    };
    for (let page = 1; page <= pages; page += 1) {
      const request = provider.buildRequest(query, { page });
      let search;
      try {
        search = await fetchUrl(request.url, {
          headers: request.headers,
          timeoutMs: 8_000,
          maxBytes: 750_000,
          allowHttp: provider.allowLocalProvider === true,
          allowPrivateHost: provider.allowLocalProvider === true,
          allowContentTypes: provider.searchContentTypes,
          policy: providerPolicy
        });
      } catch (error) {
        audit({ stage: "search", provider: provider.id, page, outcome: "error",
                reason: String(error?.message || error) });
        // A first-page failure is a real provider outage; report it. A later
        // page failing just ends pagination — keep whatever earlier pages gave.
        if (page === 1) return { ok: false, reason: "provider_error", sources: [] };
        break;
      }
      // A refused search is a provider failure even though a body came back.
      // Brave answered 429 with a captcha page after a burst (2026-09-02); it
      // parsed to zero results and the user was told to rephrase.
      if (search.status < 200 || search.status >= 300) {
        audit({ stage: "search", provider: provider.id, page, outcome: "error",
                requestedUrl: search.requestedUrl, finalUrl: search.finalUrl,
                status: search.status, reason: `search HTTP ${search.status}` });
        if (page === 1) {
          // 429 is the provider saying "not now", not an outage: the user's
          // remedy is to wait or switch provider, so it gets its own reason.
          return { ok: false, sources: [],
                   reason: search.status === 429 ? "provider_rate_limited" : "provider_error" };
        }
        break;
      }
      const pageResults = provider.parse(search.body.toString("utf8"));
      let added = 0;
      for (const result of pageResults) {
        if (!result?.url || seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        rawCandidates.push(result);
        added += 1;
      }
      audit({ stage: "search", provider: provider.id, page, outcome: "ok",
              requestedUrl: search.requestedUrl, finalUrl: search.finalUrl,
              contentHash: search.contentHash,
              resultCount: pageResults.length, newResults: added,
              totalResults: rawCandidates.length });
      if (added === 0) break;
    }
  }
  const candidates = rankDiscoveryResults(rawCandidates, query, { env });
  // One door decision for both the initial URL and every redirect hop, bound
  // to the same policy the ranker used.
  const door = (url) => domainDecision(url, env);

  const sources = [];
  let rejectedAsIrrelevant = false;
  for (const candidate of candidates.slice(0, fetchLimit)) {
    const initialPolicy = door(candidate.url);
    try {
      const fetched = await fetchUrl(candidate.url, {
        timeoutMs: 8_000,
        // 1 MB rejected id.wikipedia.org/wiki/Indonesia outright — the single
        // most relevant page for any query about the country, discarded as
        // "response_too_large" with no trace the user could see.
        maxBytes: 3_000_000,
        headers: {
          "User-Agent": "TantularOffice/0.1 (official-source retrieval alpha)",
          "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf"
        },
        policy: door
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
      // An allowed page is not a relevant page. Handing the model an off-topic
      // source produces an answer it cannot cite, which the citation gate then
      // refuses — a refusal the user reads as the feature being broken.
      const score = relevanceScore(
        { title: candidate.title, text: extracted.text }, query);
      if (score < RELEVANCE_FLOOR) {
        rejectedAsIrrelevant = true;
        audit({
          stage: "retrieve", provider: provider.id,
          requestedUrl: fetched.requestedUrl, finalUrl: fetched.finalUrl,
          domain: fetched.policy.host, domainTier: fetched.policy.tier,
          policyReason: fetched.policy.reason, status: fetched.status,
          contentHash: fetched.contentHash, outcome: "irrelevant",
          reason: `relevance ${score.toFixed(2)} < ${RELEVANCE_FLOOR}`
        });
        continue;
      }
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
    // Three distinct dead ends, and they mean different things to the user:
    // nothing allowed came back, nothing could be fetched, or what was fetched
    // was not about the question. The last one is the common case and must not
    // masquerade as a network problem.
    const reason = !candidates.length ? "no_allowed_results"
      : rejectedAsIrrelevant ? "no_relevant_sources" : "no_fetchable_sources";
    return { ok: false, reason, sources: [], provider: provider.id };
  }
  return { ok: true, provider: provider.id, sources };
}

export function sourcesAsUntrusted(sources) {
  return sources.map((source) =>
    `[${source.id}] ${source.title}\nURL: ${source.url}\nTier: ${source.tier}\n${source.text}`)
    .join("\n\n");
}
