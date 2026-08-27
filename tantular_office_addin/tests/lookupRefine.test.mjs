// The agentic query composer. Its one hard rule: suggestions never leave the
// machine, and a suggestion that would CARRY the machine's data out is marked.

import test from "node:test";
import assert from "node:assert/strict";
import { buildRefinePrompt, parseRefineResponse, screenCandidates, refineResult,
         deterministicRefineResult, MAX_CANDIDATES,
         MAX_QUERY_CHARS } from "../src/chat/lookupRefine.js";

const DOC = "LAPORAN\nVendor utama PT Sinar Mas. Pagu Rp 1.750.000.000.";

test("valid model JSON becomes question plus candidates", () => {
  const out = parseRefineResponse('{"question":"Periode?","candidates":'
    + '[{"query":"inflasi indonesia 2026","why":"periode jelas"}]}');
  assert.equal(out.ok, true);
  assert.equal(out.question, "Periode?");
  assert.equal(out.candidates[0].query, "inflasi indonesia 2026");
});

test("JSON wrapped in prose still parses; garbage fails closed", () => {
  const wrapped = parseRefineResponse('Tentu! {"question":"","candidates":'
    + '[{"query":"pasar modal"}]} Semoga membantu.');
  assert.equal(wrapped.ok, true);
  for (const junk of ["maaf tidak bisa", "", null, '{"question":"x"}',
                      '{"candidates":[]}', '{"candidates":"bukan array"}']) {
    assert.equal(parseRefineResponse(junk).ok, false, JSON.stringify(junk));
  }
});

test("candidate count and query length are bounded", () => {
  const many = { question: "q", candidates: Array.from({ length: 10 }, (_, i) =>
    ({ query: `query ${i}`, why: "" })) };
  const out = parseRefineResponse(JSON.stringify(many));
  assert.equal(out.candidates.length, MAX_CANDIDATES);
  // Oversize queries are DROPPED, not truncated: a cut query is not what the
  // model proposed, and approving it would approve something nobody composed.
  const long = parseRefineResponse(JSON.stringify({ question: "q", candidates:
    [{ query: "x".repeat(MAX_QUERY_CHARS + 1) }] }));
  assert.equal(long.ok, false);
});

test("a candidate carrying the document's vendor is flagged", () => {
  const out = screenCandidates([{ query: "profil PT Sinar Mas", why: "" },
                                { query: "pasar modal indonesia", why: "" }], DOC);
  assert.equal(out[0].containsDocumentData, true);
  assert.equal(out[1].containsDocumentData, false);
});

test("a candidate carrying a document amount is flagged even reformatted", () => {
  const out = screenCandidates([{ query: "anggaran 1.750.000.000 rupiah", why: "" }], DOC);
  assert.equal(out[0].containsDocumentData, true,
    "digit runs must match through formatting differences");
});

test("years and short numbers are not treated as document data", () => {
  const out = screenCandidates([{ query: "inflasi indonesia 2026", why: "" }], DOC);
  assert.equal(out[0].containsDocumentData, false);
});

test("no document means nothing can leak, and nothing is flagged", () => {
  const out = screenCandidates([{ query: "apa saja", why: "" }], "");
  assert.equal(out[0].containsDocumentData, false);
});

test("the prompt tells the model not to copy document values into queries", () => {
  const prompt = buildRefinePrompt({ intent: "cari vendor", document: DOC });
  assert.ok(prompt.includes("JANGAN memasukkan angka"));
  assert.ok(prompt.includes(DOC.slice(0, 20)), "the document grounds the suggestions");
});

test("refineResult composes parse and screening, failing closed", () => {
  const good = refineResult('{"question":"?","candidates":'
    + '[{"query":"profil PT Sinar Mas","why":"vendor"}]}', DOC);
  assert.equal(good.ok, true);
  assert.equal(good.candidates[0].containsDocumentData, true);
  assert.equal(refineResult("bukan json", DOC).ok, false);
});

test("deterministic refinement is immediate, bounded, and uses only typed intent", () => {
  const out = deterministicRefineResult(" perkembangan pasar modal indonesia ", DOC,
    { year: 2026 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates.map((candidate) => candidate.query), [
    "perkembangan pasar modal indonesia",
    "perkembangan pasar modal indonesia terbaru 2026",
    "perkembangan pasar modal indonesia data resmi"
  ]);
  assert.ok(out.candidates.every((candidate) =>
    candidate.query.length <= MAX_QUERY_CHARS));
  assert.ok(out.candidates.every((candidate) =>
    !candidate.query.includes("Sinar Mas") && !candidate.query.includes("1.750")));
});

test("deterministic refinement still applies document leak screening", () => {
  const out = deterministicRefineResult("profil PT Sinar Mas", DOC, { year: 2026 });
  assert.equal(out.candidates[0].containsDocumentData, true);
});
