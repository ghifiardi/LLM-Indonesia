// The guardrail for open web search: which domains Tantular may fetch and cite.
//
// Two policies, chosen by TANTULAR_LOOKUP_SOURCE_POLICY:
//
//   open      (default) any public site may be fetched. The owner's reasoning,
//             2026-09-02: the query leaves the machine only after the user
//             approves it, the document never does, and the two-host official
//             corpus had nothing about the topics people actually ask about.
//   official  default-DENY: a domain is only fetchable when it is positively
//             classified as official or reputable. The original behaviour.
//
// In BOTH policies a set of hostile patterns is "blocked" outright — IP
// literals, punycode, non-ICANN suffixes, link shorteners. Those are not a
// matter of trust in the source; they are how an approved query gets sent to
// an endpoint nobody can see.
//
// This module makes ZERO network calls and holds no secrets. It is pure
// classification, so it can be unit-tested exhaustively and reused by both the
// query planner (which result links are worth fetching) and the fetch door
// (which host is allowed through).
import { parse as parseDomain } from "tldts";

// Government/authority zones. A host in one of these is treated as official.
export const OFFICIAL_SUFFIXES = Object.freeze([
  "go.id",    // Indonesian central/regional government
  "mil.id",   // Indonesian military
  "desa.id",  // Indonesian village administrations
  "gov",      // generic government gTLD, e.g. *.gov, cdc.gov
]);

// Curated reputable sources: standards bodies, multilaterals, and encyclopedic
// references. Additions are deliberate, one domain at a time — never a wildcard.
export const TRUSTED_REFERENCE_DOMAINS = Object.freeze([
  "wikipedia.org",
  "who.int",
  "un.org",
  "imf.org",
  "worldbank.org",
  "oecd.org",
  "europa.eu",
]);

// Education and school zones: reputable, but not "official government".
export const TRUSTED_REFERENCE_SUFFIXES = Object.freeze([
  "ac.id",   // Indonesian universities
  "sch.id",  // Indonesian schools
  "edu",     // generic education gTLD
]);

// Hard blocks regardless of anything else: link shorteners hide the true
// destination, so an approved query would be sent to an unknown endpoint.
export const BLOCKED_DOMAINS = Object.freeze([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly",
  "cutt.ly", "rebrand.ly", "shorturl.at", "lnkd.in",
]);

export const SOURCE_POLICIES = Object.freeze(["open", "official"]);

// A misspelt policy must not quietly become the permissive one. Reading the
// value throws, so the companion fails at startup with the offending text
// rather than fetching from the open web because someone typed "offical".
export function sourcePolicy(env = process.env) {
  const raw = String(env?.TANTULAR_LOOKUP_SOURCE_POLICY ?? "").trim().toLowerCase();
  if (!raw) return "open";
  if (!SOURCE_POLICIES.includes(raw)) {
    throw new Error(`invalid_source_policy:${raw}`);
  }
  return raw;
}

function tierFetchable(tier, env) {
  if (tier === "blocked") return false;
  if (tier === "official" || tier === "trusted-reference") return true;
  return sourcePolicy(env) === "open";
}

export function normalizeHost(input) {
  let host = String(input || "").trim().toLowerCase();
  if (!host) return "";
  // Accept a full URL or a bare host.
  if (host.includes("/") || host.includes(":")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      return "";
    }
  }
  return host.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function matchesSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || /^\d+$/.test(host);
}

// One classification for a host. Returns a tier and a short machine reason so
// the pane can explain WHY a source was blocked rather than silently dropping.
export function classifyDomain(input) {
  const host = normalizeHost(input);
  if (!host || !host.includes(".")) {
    return { host, tier: "blocked", reason: "invalid_host",
             registrableDomain: null, publicSuffix: null };
  }
  // Homoglyph/punycode domains impersonate real ones; refuse rather than guess.
  if (host.includes("xn--")) {
    return { host, tier: "blocked", reason: "punycode",
             registrableDomain: null, publicSuffix: null };
  }
  if (isIpLiteral(host)) {
    return { host, tier: "blocked", reason: "ip_literal",
             registrableDomain: null, publicSuffix: null };
  }
  const parsed = parseDomain(host, { allowPrivateDomains: false });
  const registrableDomain = parsed.domain || null;
  const publicSuffix = parsed.publicSuffix || null;
  if (!parsed.isIcann || !registrableDomain || !publicSuffix) {
    return { host, tier: "blocked", reason: "not_icann",
             registrableDomain, publicSuffix };
  }
  if (BLOCKED_DOMAINS.includes(registrableDomain)) {
    return { host, tier: "blocked", reason: "shortener_or_blocklist",
             registrableDomain, publicSuffix };
  }
  // PSL-derived publicSuffix is the security boundary. This is why
  // "evilgo.id" (suffix id) and "go.id.attacker.com" (suffix com) do not pass.
  if (OFFICIAL_SUFFIXES.includes(publicSuffix)) {
    return { host, tier: "official", reason: "official_psl_zone",
             registrableDomain, publicSuffix };
  }
  if (TRUSTED_REFERENCE_DOMAINS.includes(registrableDomain)) {
    return { host, tier: "trusted-reference", reason: "curated_reference",
             registrableDomain, publicSuffix };
  }
  if (TRUSTED_REFERENCE_SUFFIXES.includes(publicSuffix)) {
    return { host, tier: "trusted-reference", reason: "education_psl_zone",
             registrableDomain, publicSuffix };
  }
  // A site nobody vouched for. Fetchable under the open policy, denied under
  // the official one; the source list labels it "public" either way so a
  // reader never mistakes it for a vetted source.
  return { host, tier: "public", reason: "not_recognized",
           registrableDomain, publicSuffix };
}

// The fetch door's question: may Tantular open this host at all?
export function isFetchAllowed(input, { env = process.env } = {}) {
  return tierFetchable(classifyDomain(input).tier, env);
}

// Filter a list of candidate result links down to the ones the guardrail
// permits, preserving order and de-duplicating by host. Each kept entry
// carries its classification so the pane can label the source.
// `maxPerHost` defaults to 1 for host diversity. Discovery passes Infinity and
// applies the cap AFTER scoring instead: keeping the FIRST result per host
// meant the search engine's own ordering picked the sources, so a lookup with
// two allowed hosts only ever saw two pages, relevant or not (2026-09-01).
export function filterAllowedResults(results, { maxPerHost = 1, env = process.env } = {}) {
  const seen = new Map();
  const kept = [];
  for (const result of Array.isArray(results) ? results : []) {
    const url = typeof result === "string" ? result : result?.url;
    const classification = classifyDomain(url);
    if (!tierFetchable(classification.tier, env)) continue;
    const taken = seen.get(classification.host) || 0;
    if (taken >= maxPerHost) continue;
    seen.set(classification.host, taken + 1);
    kept.push({
      url,
      host: classification.host,
      tier: classification.tier,
      title: typeof result === "object" ? String(result?.title || "") : ""
    });
  }
  return kept;
}
