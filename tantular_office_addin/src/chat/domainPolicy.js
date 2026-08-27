// The guardrail for open web search: which domains Tantular may fetch and cite.
//
// The product goal is "search the internet freely, but never touch a
// non-official or bad site." That is a default-DENY domain policy: a domain is
// only fetchable when it is positively classified as official or reputable.
// Everything unrecognized is "unknown" and is NOT fetched, and a set of hostile
// patterns is "blocked" outright.
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
  // Default deny: a site nobody vouched for is not "bad", but it is not
  // fetched either. The guardrail errs toward not touching it.
  return { host, tier: "unknown", reason: "not_recognized",
           registrableDomain, publicSuffix };
}

// The fetch door's question: may Tantular open this host at all?
export function isFetchAllowed(input) {
  const tier = classifyDomain(input).tier;
  return tier === "official" || tier === "trusted-reference";
}

// Filter a list of candidate result links down to the ones the guardrail
// permits, preserving order and de-duplicating by host. Each kept entry
// carries its classification so the pane can label the source.
export function filterAllowedResults(results) {
  const seen = new Set();
  const kept = [];
  for (const result of Array.isArray(results) ? results : []) {
    const url = typeof result === "string" ? result : result?.url;
    const classification = classifyDomain(url);
    if (classification.tier !== "official"
        && classification.tier !== "trusted-reference") continue;
    if (seen.has(classification.host)) continue;
    seen.add(classification.host);
    kept.push({
      url,
      host: classification.host,
      tier: classification.tier,
      title: typeof result === "object" ? String(result?.title || "") : ""
    });
  }
  return kept;
}
