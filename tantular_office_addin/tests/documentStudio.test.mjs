import test from "node:test";
import assert from "node:assert/strict";
import {
  fallbackDocumentSpec,
  normalizeDocumentSpec,
  planDocument,
  decodeDocumentModelOutput,
  documentWireSchema,
  extractJsonDetailed,
  validateDocumentWire,
  DOCUMENT_SYSTEM,
  documentUser
} from "../src/document/documentPlanner.js";
import { buildDocumentDocxBase64 } from "../src/document/docxBuilder.js";

test("normalizes a model document spec", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan AI",
    executiveSummary: ["Poin satu", "Poin dua"],
    sections: [
      {
        heading: "Pendahuluan",
        paragraphs: ["Paragraf pembuka."],
        bullets: ["Tujuan utama"]
      }
    ],
    closing: ["Langkah berikutnya"]
  }, "Sumber", 6);
  assert.equal(spec.title, "Laporan AI");
  assert.equal(spec.sections.length, 1);
  assert.deepEqual(spec.sections[0].bullets, ["Tujuan utama"]);
});

test("fills a missing model section heading deterministically", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan",
    sections: [{ paragraphs: ["Isi bagian tanpa judul."] }]
  }, "Sumber", 4);
  assert.equal(spec.sections[0].heading, "Bagian 1");
});

test("drops invented author and date metadata", () => {
  const spec = normalizeDocumentSpec({
    title: "Laporan",
    author: "Nama Buatan",
    date: "2023-11-15",
    sections: [{ heading: "Isi", paragraphs: ["Teks."] }]
  }, "Buat laporan untuk direksi.", 4);
  assert.equal(spec.author, "");
  assert.equal(spec.date, "");
});

test("fallback document never copies a create instruction as the title", () => {
  const spec = fallbackDocumentSpec(
    "Buatlah laporan tentang sovereign AI Indonesia. Jelaskan opsi dan langkah berikutnya.",
    "Laporan profesional",
    4
  );
  assert.equal(/^buatlah/i.test(spec.title), false);
  assert.ok(spec.sections.length >= 1);
});

test("builds a DOCX OOXML zip as base64", () => {
  const spec = {
    title: "Dokumen Uji",
    subtitle: "Tantular",
    author: "",
    date: "",
    executiveSummary: ["Ringkasan"],
    sections: [{
      heading: "Bagian 1",
      level: 1,
      paragraphs: ["Isi dengan karakter aman & benar."],
      bullets: ["Poin A"],
      quote: ""
    }],
    closing: ["Selesai"]
  };
  const base64 = buildDocumentDocxBase64(spec);
  const bytes = Buffer.from(base64, "base64");
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
  assert.ok(bytes.length > 3000);
});

// --- Verified fix: Document Studio's Cancel button must abort the actual
// model request, not just the taskpane's own wait. Proves the AbortSignal
// planDocument() is given really reaches runTantular()'s outbound fetch —
// not merely that planDocument() accepts a `signal` parameter it ignores.

test("planDocument forwards the caller's AbortSignal all the way into the outbound request", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let capturedSignal = null;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    capturedSignal = init.signal;
    // Real fetch rejects immediately for an already-aborted signal, exactly
    // like this — asserting the request layer actually saw the abort, not
    // just that planDocument() carries the parameter around unused.
    if (init.signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }] }), text: async () => "" };
  };

  try {
    const controller = new AbortController();
    controller.abort();
    // A cancelled request must REJECT, not resolve into a usable fallback
    // spec — a fallback here is exactly what would get built into a DOCX and
    // inserted into Word, which is precisely what Cancel must prevent.
    await assert.rejects(
      planDocument({
        brief: "Laporan singkat untuk diuji.",
        sectionCount: 3,
        signal: controller.signal
      }),
      "planDocument must reject after the caller's signal is aborted, not resolve to a fallback spec"
    );

    assert.ok(capturedSignal, "runTantular must pass a signal through to fetch");
    assert.equal(capturedSignal.aborted, true,
      "the signal reaching fetch must reflect the caller's abort — this is planDocument's own AbortSignal, forwarded, not a fresh unrelated one");
    // signal?.aborted short-circuits runTantular's retry/lite-model-fallback
    // path (tantularClient.js) — a cancelled request must not silently retry.
    assert.equal(calls, 1, "an aborted request must not be retried");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("planDocument forwards onMetrics to runTantular and receives real tantular_metrics", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"title":"Laporan","sections":[]}' } }],
      tantular_metrics: { promptTokens: 40, completionTokens: 100, tokensPerSecond: 12.5 }
    }),
    text: async () => ""
  });

  try {
    let received = null;
    const result = await planDocument({
      brief: "Brief ringkas.",
      sectionCount: 3,
      onMetrics: (m) => { received = m; }
    });
    assert.equal(result.source, "model");
    assert.ok(received, "onMetrics must be called on the real planDocument() path, not just runTantular() in isolation");
    assert.equal(received.completionTokens, 100);
    assert.equal(received.tokensPerSecond, 12.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-08-31 reliability follow-up: json_object mode only asks for
// well-formed JSON, which a live itemizable-fixture test showed the model
// still occasionally violates (a missing "]" before the "s" key). A real
// JSON Schema, passed as response_format.json_schema, lets Ollama enforce
// the grammar itself. planDocument must build and send one sized to the
// actual requested section count — a fixed schema would silently reject a
// correct N-section response or accept a wrong-sized one.
test("planDocument sends a JSON Schema sized to the requested section count", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"t":"Laporan","s":[]}' } }] }),
      text: async () => ""
    };
  };
  try {
    await planDocument({ brief: "Brief ringkas.", sectionCount: 8 });
    assert.equal(capturedBody.response_format.type, "json_schema");
    assert.deepEqual(capturedBody.response_format.json_schema.schema, documentWireSchema(8));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Compact wire format (token-efficiency pass, 2026-08-31) ---------------
// The model now answers in a short-key schema to spend fewer generation
// tokens on structure instead of content. decodeDocumentModelOutput() must
// expand it back to exactly the shape normalizeDocumentSpec() already
// handled, so nothing downstream (DOCX generation, the pre-existing
// long-key schema) needed to change.

test("decodeDocumentModelOutput expands the compact schema to the long-key shape", () => {
  const compact = {
    t: "Judul Ringkas",
    st: "Subjudul",
    es: ["Poin satu", "Poin dua"],
    s: [
      { h: "Bagian Satu", p: ["Paragraf pertama."], b: ["Detail tambahan."], q: "Kutipan sumber." },
      { h: "Bagian Dua", p: ["Paragraf kedua."] }
    ],
    c: ["Langkah berikutnya."]
  };
  const decoded = decodeDocumentModelOutput(compact);
  assert.equal(decoded.title, "Judul Ringkas");
  assert.equal(decoded.subtitle, "Subjudul");
  assert.deepEqual(decoded.executiveSummary, ["Poin satu", "Poin dua"]);
  assert.equal(decoded.sections.length, 2);
  assert.equal(decoded.sections[0].heading, "Bagian Satu");
  assert.deepEqual(decoded.sections[0].paragraphs, ["Paragraf pertama."]);
  assert.deepEqual(decoded.sections[0].bullets, ["Detail tambahan."]);
  assert.equal(decoded.sections[0].quote, "Kutipan sumber.");
  assert.deepEqual(decoded.closing, ["Langkah berikutnya."]);
});

test("decodeDocumentModelOutput handles omitted optional fields (no st/es/b/q/c)", () => {
  const compact = { t: "Judul", s: [{ h: "Satu", p: ["Isi."] }] };
  const decoded = decodeDocumentModelOutput(compact);
  // normalizeDocumentSpec must still produce a complete, valid spec from
  // this — omitted fields are the whole point of the compact schema.
  const spec = normalizeDocumentSpec(decoded, "Isi.", 1);
  assert.equal(spec.title, "Judul");
  assert.deepEqual(spec.executiveSummary, []);
  assert.deepEqual(spec.closing, []);
  assert.equal(spec.sections[0].heading, "Satu");
  assert.deepEqual(spec.sections[0].bullets, []);
  assert.equal(spec.sections[0].quote, "");
});

test("decodeDocumentModelOutput passes the legacy long-key schema through unchanged", () => {
  const legacy = {
    title: "Judul Lama",
    sections: [{ heading: "Satu", paragraphs: ["Isi."] }]
  };
  const decoded = decodeDocumentModelOutput(legacy);
  assert.equal(decoded, legacy, "a legacy-shaped object must not be rewritten at all");
});

test("decodeDocumentModelOutput is safe against malformed/non-object input", () => {
  for (const bad of [null, undefined, "a string", 42, [], { s: "not an array" }]) {
    assert.doesNotThrow(() => decodeDocumentModelOutput(bad), `input ${JSON.stringify(bad)} must not throw`);
  }
  assert.equal(decodeDocumentModelOutput(null), null);
  assert.equal(decodeDocumentModelOutput(42), 42);
});

test("compact-schema author/date still go through the same grounding filter as the legacy schema", () => {
  const source = "Rapat dipimpin oleh Budi pada 10 Januari.";
  const compact = { t: "Judul", a: "Budi", d: "10 Januari", s: [{ h: "Satu", p: ["Isi."] }] };
  const spec = normalizeDocumentSpec(decodeDocumentModelOutput(compact), source, 1);
  assert.equal(spec.author, "Budi", "an author actually present in the source must survive grounding");
  const invented = { t: "Judul", a: "Nama Karangan", s: [{ h: "Satu", p: ["Isi."] }] };
  const invSpec = normalizeDocumentSpec(decodeDocumentModelOutput(invented), source, 1);
  assert.equal(invSpec.author, "", "an author NOT present in the source must still be dropped");
});

test("planDocument end-to-end: a minified compact-schema response decodes, normalizes to the exact requested section count, and builds a valid DOCX", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const compactRaw = JSON.stringify({
    t: "Laporan Uji Efisiensi Token",
    es: ["Adopsi meningkat.", "Efisiensi tercapai."],
    s: [
      { h: "Tren", p: ["Adopsi model lokal meningkat sejak 2024."], b: ["Didorong privasi data."] },
      { h: "Dampak", p: ["Penghematan waktu tercatat signifikan."] },
      { h: "Tantangan", p: ["Kapasitas komputasi masih terbatas."] }
    ],
    c: ["Perlu validasi infrastruktur."]
  });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: compactRaw } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({
      brief: "Adopsi model lokal meningkat sejak 2024, didorong privasi data. Penghematan waktu tercatat signifikan. Kapasitas komputasi masih terbatas.",
      sectionCount: 3
    });
    assert.equal(result.source, "model");
    assert.equal(result.spec.title, "Laporan Uji Efisiensi Token");
    assert.equal(result.spec.sections.length, 3, "must produce exactly the requested section count");
    assert.deepEqual(result.spec.executiveSummary, ["Adopsi meningkat.", "Efisiensi tercapai."]);
    assert.deepEqual(result.spec.closing, ["Perlu validasi infrastruktur."]);

    const base64 = buildDocumentDocxBase64(result.spec);
    const bytes = Buffer.from(base64, "base64");
    assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK", "a decoded compact-schema spec must still build a valid DOCX zip");
    assert.ok(bytes.length > 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Bullet-policy A/B (2026-08-31 follow-up) -------------------------------
// The token-efficiency pass's long-source/many-section regression traced to
// the model treating "maksimum 4 bullet" as a target rather than a ceiling.
// This asserts the PROMPT actually says what the experiment needs it to say
// — a live-generation A/B still decides whether it worked, but if the
// prompt doesn't say this, the experiment measures nothing.

test("the bullet policy is optional for narrative sections, not a required structural element", () => {
  assert.match(DOCUMENT_SYSTEM, /OPSIONAL/, "bullets must be stated as optional for narrative content");
  assert.match(DOCUMENT_SYSTEM, /[Ss]ecara DEFAULT.{0,80}jangan keluarkan bullet/,
    "the default for narrative sections must be NO bullets, not 'up to N bullets'");
});

// 2026-08-31 itemizable-fixture follow-up: the optional/default-none policy
// above was verified live against a genuinely itemizable long fixture (owners
// + deadlines, budget amounts + periods, timeline stages + months). Of 3
// valid (non-fallback) completions across two batches, only 1 produced any
// bullets at all — 2 of 3 stayed fully prose, even though every section's
// source was a concrete enumerated list. "Optional, default none" was being
// read by the model as "almost always none" even where a list plainly
// existed. This adds a WAJIB (mandatory) exception scoped to sections whose
// source is itself enumerated, while leaving the narrative default (no
// bullets) unchanged — do not remove this exception without re-running that
// live comparison.
test("bullets are mandatory when the section's own source is an enumerated list, not just optional", () => {
  assert.match(DOCUMENT_SYSTEM, /WAJIB gunakan 1-2 bullet/,
    "an enumerated source (owners/amounts/dates/steps) must not be left to the model's discretion");
  assert.match(DOCUMENT_SYSTEM, /daftar\/enumerasi konkret/);
});

test("the bullet cap is 1-2 when used, not the old 4", () => {
  assert.match(DOCUMENT_SYSTEM, /1-2 bullet/);
  assert.doesNotMatch(DOCUMENT_SYSTEM, /[Mm]aksimum 4 bullet/,
    "the old 4-bullet ceiling must be gone, not just supplemented");
});

test("the prompt tells the model to omit an empty bullet field rather than emit []", () => {
  assert.match(DOCUMENT_SYSTEM, /HILANGKAN field "b"/);
});

test("no rule requires every section to have bullets — the mandate is scoped to enumerated sources only", () => {
  // Absence check: nothing in the system prompt should demand a non-empty
  // bullet list for EVERY section (the exact bug the old "maksimum 4"
  // phrasing invited the model to over-satisfy). The 2026-08-31 exception
  // makes bullets WAJIB, but only when a section's own source is an
  // enumerated list — narrative sections keep the "default none" behavior.
  assert.doesNotMatch(DOCUMENT_SYSTEM, /setiap bagian.{0,40}bullet/i);
  assert.match(DOCUMENT_SYSTEM, /naratif/i,
    "the mandate must stay scoped away from narrative sections, not apply blanket-wide");
});

test("the schema example in the user prompt demonstrates omitting \"b\", not just including it", () => {
  const user = documentUser({ brief: "x", sectionCount: 3 });
  assert.match(user, /TANPA bullet/i, "the example set must show a section with no b field at all");
  assert.doesNotMatch(user, /"b":\["[^"]*","[^"]*","[^"]*","[^"]*"\]/,
    "the schema example must not show four bullet placeholders — that itself anchors the model toward always filling four");
});

test("zero-bullet decode/normalize round-trip is valid (compact schema, no b key at all)", () => {
  const compact = { t: "Judul", s: [{ h: "Satu", p: ["Paragraf lengkap tanpa bullet."] }] };
  const spec = normalizeDocumentSpec(decodeDocumentModelOutput(compact), "Paragraf lengkap tanpa bullet.", 1);
  assert.deepEqual(spec.sections[0].bullets, [], "a section with no b key must normalize to an empty bullets array, not throw or invent one");
  assert.equal(spec.sections[0].paragraphs[0], "Paragraf lengkap tanpa bullet.");
});

test("compact and legacy schema decoding both still work after the bullet-policy change", () => {
  const compact = decodeDocumentModelOutput({ t: "T", s: [{ h: "H", p: ["P"], b: ["B1", "B2"] }] });
  assert.deepEqual(compact.sections[0].bullets, ["B1", "B2"]);
  const legacy = { title: "T", sections: [{ heading: "H", paragraphs: ["P"], bullets: ["B1"] }] };
  assert.equal(decodeDocumentModelOutput(legacy), legacy);
});

// --- Strict validation (2026-08-31 fail-closed follow-up) -------------------
// Live testing against a genuinely fresh, schema-capable Companion still
// produced two failure classes: syntactically invalid JSON (a missing "]"
// before "s"), and syntactically valid but out-of-contract JSON (wrong
// section count, too many paragraphs/bullets). normalizeDocumentSpec()'s own
// slicing/defaulting is deliberately lenient (it also serves the legacy
// long-key schema) and must not be mistaken for a validator — these tests
// pin extractJsonDetailed()/validateDocumentWire() as the actual correctness
// boundary, using the exact failure shapes observed live.

test("extractJsonDetailed: the observed missing-']' failure is reported as json_parse_error, not silently repaired", () => {
  // Reproduces the real live failure: the "es" array's closing "]" was
  // dropped before "s" started.
  const raw = '{"t":"x","es":["one","two","three","s":[{"h":"H","p":["P"]}]}';
  const result = extractJsonDetailed(raw);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "json_parse_error");
  assert.equal(result.value, null);
});

test("extractJsonDetailed: no '{' at all is reported as no_object, distinct from a parse error", () => {
  const result = extractJsonDetailed("Tentu, berikut jawabannya tanpa JSON.");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "no_object");
});

test("extractJsonDetailed: valid JSON (with the existing trailing-comma repair) parses successfully", () => {
  const result = extractJsonDetailed('{"t":"x","s":[{"h":"H","p":["P"],}],}');
  assert.equal(result.ok, true);
  assert.equal(result.value.t, "x");
});

test("validateDocumentWire: a completely valid compact response passes with no errors", () => {
  const value = {
    t: "Judul", st: "Sub", es: ["A", "B"],
    s: [
      { h: "Satu", p: ["Paragraf."] },
      { h: "Dua", p: ["Paragraf."], b: ["Poin satu"] }
    ],
    c: ["Penutup"]
  };
  const result = validateDocumentWire(value, 2);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateDocumentWire: valid output with all optional properties omitted also passes", () => {
  const value = { t: "Judul", s: [{ h: "Satu", p: ["Paragraf."] }] };
  const result = validateDocumentWire(value, 1);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateDocumentWire: 1 section when 6 were requested is wrong_section_count (the observed live failure)", () => {
  const value = { t: "Judul", s: [{ h: "Satu", p: ["Paragraf."], b: ["a", "b", "c"] }] };
  const result = validateDocumentWire(value, 6);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("wrong_section_count"));
});

test("validateDocumentWire: 3 paragraphs where the schema allows at most 2 is invalid_paragraphs (the observed live failure)", () => {
  const value = { t: "Judul", s: [{ h: "Satu", p: ["P1", "P2", "P3"] }] };
  const result = validateDocumentWire(value, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("section_1_invalid_paragraphs"));
});

test("validateDocumentWire: 8 bullets where the schema allows at most 2 is invalid_bullets (the observed live over-generation)", () => {
  const value = { t: "Judul", s: [{ h: "Satu", p: ["P1"], b: ["1", "2", "3", "4", "5", "6", "7", "8"] }] };
  const result = validateDocumentWire(value, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("section_1_invalid_bullets"));
  // Must be flagged invalid, not silently truncated to 2 and called compliant.
});

test("validateDocumentWire: an empty heading, paragraph, or bullet string is invalid", () => {
  assert.ok(!validateDocumentWire({ t: "Judul", s: [{ h: "  ", p: ["P"] }] }, 1).ok);
  assert.ok(!validateDocumentWire({ t: "Judul", s: [{ h: "H", p: [""] }] }, 1).ok);
  assert.ok(!validateDocumentWire({ t: "Judul", s: [{ h: "H", p: ["P"], b: ["  "] }] }, 1).ok);
});

test("validateDocumentWire: an unknown root property is rejected", () => {
  const result = validateDocumentWire({ t: "Judul", s: [{ h: "H", p: ["P"] }], extra: "nope" }, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("unknown_root_property_extra"));
});

test("validateDocumentWire: an unknown section property is rejected", () => {
  const result = validateDocumentWire({ t: "Judul", s: [{ h: "H", p: ["P"], weird: true }] }, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("section_1_unknown_property_weird"));
});

test("validateDocumentWire: an empty (not omitted) optional array is invalid, matching the prompt's own omit-don't-empty rule", () => {
  const result = validateDocumentWire({ t: "Judul", es: [], s: [{ h: "H", p: ["P"] }] }, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("invalid_executive_summary"));
});

// --- planDocument fails closed on invalid model output ----------------------

test("planDocument: syntactically invalid compact JSON is classified invalid_json and falls back, never source:'model'", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  // The exact observed live failure shape: "es" array missing its closing "]".
  const malformed = '{"t":"x","es":["a","b","c","s":[{"h":"H","p":["P"]}]}';
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: malformed } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({ brief: "Brief ringkas.", sectionCount: 3 });
    assert.equal(result.source, "fallback");
    assert.equal(result.errorCode, "invalid_json");
    assert.notEqual(result.spec, null, "a fallback spec must still be produced so the UI has something to show");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("planDocument: syntactically valid but structurally wrong compact JSON is classified invalid_structure and falls back", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  // Valid JSON, but only 1 section when 3 were requested — the observed live
  // under-generation failure. normalizeDocumentSpec() alone would have
  // silently accepted this (it just uses whatever sections exist).
  const wrongCount = JSON.stringify({ t: "Judul", s: [{ h: "Satu", p: ["Paragraf."] }] });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: wrongCount } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({ brief: "Brief ringkas.", sectionCount: 3 });
    assert.equal(result.source, "fallback");
    assert.equal(result.errorCode, "invalid_structure");
    assert.ok(result.validationErrors.includes("wrong_section_count"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- Mixed compact/legacy validation bypass (verification follow-up) -------
// A response carrying BOTH "s" (compact marker) and "sections" (legacy
// marker) previously fell through the `!Array.isArray(sections)` check and
// was treated as legacy — bypassing strict validation entirely. That matters
// precisely because runtime schema compliance is already known to be
// imperfect: a malformed compact response could smuggle a wrong-shaped
// "sections" past the validator this way.

test("planDocument: a response with BOTH 's' and 'sections' is treated as compact and rejected, not silently accepted as legacy", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const mixed = JSON.stringify({
    t: "Judul",
    s: [{ h: "Satu", p: ["P"] }],
    sections: [{ heading: "Palsu", paragraphs: ["Bypass"] }]
  });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: mixed } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({ brief: "Brief ringkas.", sectionCount: 1 });
    assert.equal(result.source, "fallback");
    assert.equal(result.errorCode, "invalid_structure");
    assert.ok(result.validationErrors.some((e) => e.includes("unknown_root_property_sections")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("planDocument: a compact marker ('s') present but malformed is invalid_structure, not treated as legacy", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  const malformedCompact = JSON.stringify({ t: "Judul", s: "not an array" });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: malformedCompact } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({ brief: "Brief ringkas.", sectionCount: 1 });
    assert.equal(result.source, "fallback");
    assert.equal(result.errorCode, "invalid_structure");
    assert.ok(result.validationErrors.includes("sections_not_array"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateDocumentWire: a mixed compact+legacy object is rejected for the unknown 'sections' property", () => {
  const value = { t: "Judul", s: [{ h: "H", p: ["P"] }], sections: [] };
  const result = validateDocumentWire(value, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("unknown_root_property_sections"));
});

test("planDocument: a legacy long-key response is NOT strictly validated — existing lenient behavior is preserved", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  // Legacy shape has no "s" array (uses "sections" instead) and would fail
  // validateDocumentWire()'s compact-schema checks if it were run — it must
  // not be, since it was never covered by a JSON Schema contract.
  const legacy = JSON.stringify({ title: "Laporan", sections: [{ heading: "Satu", paragraphs: ["Isi."] }] });
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: legacy } }] }),
    text: async () => ""
  });
  try {
    const result = await planDocument({ brief: "Brief ringkas.", sectionCount: 3 });
    assert.equal(result.source, "model");
    assert.equal(result.errorCode, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
