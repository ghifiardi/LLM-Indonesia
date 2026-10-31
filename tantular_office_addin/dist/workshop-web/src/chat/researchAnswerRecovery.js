// Open Research Mode: deterministic partial recovery of a cited web answer.
//
// The all-or-nothing verifier hid an otherwise useful three-sentence answer
// because ONE sentence named "presiden direktur IOH", a role no fetched page
// supported (live pane, 2026-09-03). Here the answer is split into sentence
// units, each unit is checked with newFacts() against document ∪ fetched
// pages, and unsupported units are OMITTED — never rewritten, never sent back
// to the model. What remains is re-validated in full. Pure: no model, no IO.
//
// Recovery is a narrow privilege. It is permitted only for a plain
// no_new_facts miss on an answer whose labels are all valid. An invented
// label, an out-of-range [S#], an untrusted-echo finding or a verifier error
// is an integrity failure, and integrity failures block the whole answer.

import { newFacts, verifyResearch } from "./verifyWebAnswer.js";

const NO_COVERAGE_MARKER = "[TIDAK ADA SUMBER]";
const CITATION_RE = /\[S(\d+)\]/g;
const LABEL_RE = /\[([^\[\]\n]{1,40})\]/g;
export const MIN_VISIBLE_CHARS = 40;

// `allowed` is a source count (ids 1..n) or an explicit list of numeric ids —
// the latter when some fetched sources were excluded before composing, so a
// citation to an excluded id is invalid even though the id was fetched.
export function validateSourceLabels(answer, allowed) {
  const text = String(answer || "");
  const invented = [...text.matchAll(LABEL_RE)].map((m) => m[1]).filter((label) => !/^S\d+$/.test(label));
  const citations = [...text.matchAll(CITATION_RE)].map((m) => Number(m[1]));
  const allowedIds = Array.isArray(allowed)
    ? new Set(allowed.map((id) => Number(String(id).replace(/^S/i, ""))))
    : new Set(Array.from({ length: Number(allowed) || 0 }, (_, i) => i + 1));
  const invalid = citations.filter((id) => !allowedIds.has(id));
  return { ok: invented.length === 0 && invalid.length === 0, citations, invented, invalid };
}

// Sentence units with their [S#] labels attached. A terminator followed by any
// number of citations ends a unit; a citation never starts one.
export function splitResearchSentences(answer) {
  const text = String(answer || "").replace(/\r\n?/g, "\n");
  const units = [];
  for (const paragraph of text.split(/\n+/)) {
    const trimmed = paragraph.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    for (const part of trimmed.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[^\[\s])/)) {
      const unit = part.trim();
      if (unit) units.push(unit);
    }
  }
  return units;
}

const stripCitations = (unit) => String(unit).replace(CITATION_RE, "").replace(/\s+/g, " ").trim();
const isSubstantive = (unit) => /[A-Za-z]{3,}/.test(stripCitations(unit).replace(/[.!?,;:]/g, ""));

export function recoverResearchAnswer({ answer, document, untrusted, sources } = {}) {
  const text = String(answer || "");
  const sourceCount = Array.isArray(sources)
    ? sources.map((src) => (typeof src === "object" && src ? src.id : src))
    : Number(sources) || 0;
  if (text.includes(NO_COVERAGE_MARKER)) return { ok: false, reason: "no_coverage_declared" };
  const labels = validateSourceLabels(text, sourceCount);
  if (!labels.ok) return { ok: false, reason: "label_integrity" };
  if (!labels.citations.length) return { ok: false, reason: "no_citation" };

  const permitted = `${String(document || "")}\n${String(untrusted || "")}`;
  const kept = [];
  const omitted = [];
  for (const unit of splitResearchSentences(text)) {
    const found = newFacts(stripCitations(unit), permitted);
    const kinds = Object.keys(found);
    if (kinds.length) { omitted.push({ reason: kinds[0], kinds }); continue; }
    kept.push(unit);
  }
  if (!omitted.length) return { ok: false, reason: "nothing_to_remove" };

  const candidate = kept.join(" ").replace(/\s+/g, " ").trim();
  const after = validateSourceLabels(candidate, sourceCount);
  const prose = stripCitations(candidate);
  const substantive = kept.some(isSubstantive);
  if (!after.ok || !after.citations.length || !substantive || prose.length < MIN_VISIBLE_CHARS) {
    return { ok: false, reason: "nothing_left", omittedClaims: omitted.length };
  }
  const research = verifyResearch({ answer: candidate, document: String(document || ""), untrusted: String(untrusted || "") });
  if (!research || research.ok !== true) {
    return { ok: false, reason: "recovered_answer_failed", findings: research?.findings, omittedClaims: omitted.length };
  }
  return { ok: true, answer: candidate, omittedClaims: omitted.length, omitted, citations: after.citations };
}
