// Tantular Document Studio — brief/source text → normalized document spec.

import { runTantular } from "../tantularClient.js";
import {
  detectTitle as detectStructureTitle,
  detectSections,
  detectSectionsLoose,
  normalize as normalizeStructureText,
  stripRepeatedPageLines
} from "./extractedStructure.js";
import { looksLikeStatement, statementBullets, detectPeriods, stripBilingualMirror } from "../deck/statementRows.js";

// Token-efficiency pass (2026-08-31): the model was spending real generation
// tokens on things that never needed to come from the model at all — the
// literal word "sections", "paragraphs", "bullets" repeated per section,
// "level":1 on every section (always the default), and empty ""/[] for
// fields most sections don't use. None of that is content; all of it is
// billed at the same per-token latency as the prose that actually matters.
// This compact schema asks the model for exactly the same information in
// short keys, with empty fields omitted rather than filled in, and
// decodeDocumentModelOutput() below expands it back to the full, unchanged
// DocumentSpec shape normalizeDocumentSpec() already expects — so nothing
// downstream (DOCX generation, the long-key legacy schema) needed to change.
// NOTE on a rejected variant: an earlier version of this prompt also
// demanded MINIFIED JSON (no whitespace at all). Measured against the live
// model, that specific instruction reproducibly caused malformed output —
// 2 of 3 trials came back with mismatched braces (an extra "}" after a
// section's bullets array) that JSON.parse rejected, silently degrading
// every one of those requests to the fallback document. Dropping ONLY the
// minification requirement (keeping the short keys and omit-empty rules
// below) went to 3/3 valid across the same trials. Ordinary whitespace
// costs a handful of tokens; a fallback costs the entire feature. Do not
// re-add a minification requirement without re-running that comparison.
export const DOCUMENT_SYSTEM = `Anda adalah Tantular Document Studio, perancang dokumen Word profesional yang privat dan Indonesian-first.
Mode aktif: PRODUKTIVITAS DOKUMEN, bukan keamanan/fraud.
Aturan:
- Jawab HANYA dengan satu objek JSON valid, tanpa markdown atau penjelasan. Boleh pakai spasi/baris baru wajar untuk keterbacaan, tapi PASTIKAN setiap tanda kurung kurawal/siku tertutup dengan benar — JSON tidak valid akan ditolak seluruhnya.
- Tulis dalam Bahasa Indonesia profesional kecuali pengguna meminta bahasa lain.
- Pertahankan SETIAP fakta, nama, angka, tanggal, dan istilah dari sumber — jangan hilangkan satu pun.
- Jangan mengarang data, kutipan, sumber, regulasi, nama organisasi, benchmark, atau studi kasus yang tidak ada di sumber.
- Jika informasi tidak tersedia, tulis sebagai hal yang perlu dilengkapi/divalidasi.
- Jangan menyalin instruksi pengguna sebagai isi dokumen.
- Jangan mengubah tugas produktivitas menjadi analisis keamanan kecuali diminta eksplisit.
- Tulis padat: setiap bagian NORMALNYA satu paragraf berisi 2-3 kalimat. Paragraf kedua HANYA jika sumber punya fakta berbeda yang butuh ruang terpisah.
- Ringkasan eksekutif maksimum 3 poin singkat. Penutup maksimum 2 poin singkat.
- Bullet ("b") OPSIONAL untuk bagian NARATIF. Secara DEFAULT, jika isi bagian adalah penjelasan/narasi yang mengalir, jangan keluarkan bullet sama sekali — paragraf sudah cukup.
- WAJIB gunakan 1-2 bullet ketika sumber bagian itu sendiri berupa daftar/enumerasi konkret — misalnya penanggung jawab per item aksi, angka/jumlah anggaran per kategori, atau tahapan/langkah berurutan dengan tanggal. Bullet meringkas 1-2 fakta paling penting dari daftar tersebut (bukan menyalin seluruh item satu per satu).
- JANGAN membuat bullet hanya untuk menyamakan struktur antar-bagian atau memenuhi pola ketika sumbernya naratif. Jika paragraf sudah memuat seluruh informasi bagian yang naratif, HILANGKAN field "b" sepenuhnya — jangan isi array kosong.
- Bullet tidak boleh mengulang isi paragraf yang sama.
- JANGAN mengulang kalimat atau ide dari ringkasan eksekutif di dalam isi bagian manapun.
- Keluarkan TEPAT jumlah bagian yang diminta — tidak kurang, tidak lebih.
- Field opsional yang kosong (tidak ada isinya) HARUS dihilangkan dari JSON, bukan diisi "" atau [].`;

export function documentUser({ brief, documentType, tone, sectionCount, instruction }) {
  return `Susun dokumen Word dari brief/sumber berikut.

Jenis dokumen: ${documentType || "laporan profesional"}.
Tone: ${tone || "profesional, jelas, ringkas"}.
Jumlah bagian utama: TEPAT ${sectionCount} (wajib, bukan perkiraan).
Instruksi tambahan: ${instruction || "tidak ada"}.

Skema JSON WAJIB (key singkat, tanpa field kosong):
{"t":"judul dokumen","st":"subjudul opsional","es":["maks 3 poin ringkasan"],"s":[{"h":"judul bagian","p":["1 paragraf 2-3 kalimat; paragraf ke-2 hanya jika perlu"],"b":["opsional, 1-2 poin, HANYA jika benar-benar perlu"],"q":"kutipan opsional, hanya jika bersumber langsung dari teks"}],"c":["maks 2 poin penutup"]}

Contoh bagian TANPA bullet (paling umum — paragraf sudah cukup):
{"h":"Judul Bagian","p":["Paragraf yang sudah memuat seluruh informasi bagian ini."]}

Contoh bagian DENGAN bullet (hanya jika ada item terpisah yang tidak muat di paragraf):
{"h":"Judul Bagian","p":["Paragraf ringkas."],"b":["Detail terpisah pertama.","Detail terpisah kedua."]}

Keluarkan TEPAT ${sectionCount} objek di "s".

Brief/sumber:
"""${brief}"""`;
}

// Compact wire format decoder: { t, st, es, s:[{h,p,b,q}], c } -> the same
// long-key shape normalizeDocumentSpec() has always accepted. Detected by
// the presence of the compact section-list key "s" (an array) without the
// legacy "sections" key — the two schemas never legitimately coexist, so
// this is unambiguous. Anything else (the legacy long-key schema, or a
// malformed/unrecognized shape) passes through unchanged, which is exactly
// what keeps backward compatibility: normalizeDocumentSpec()'s own
// defensive handling of missing/malformed fields still applies untouched.
export function decodeDocumentModelOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const looksCompact = Array.isArray(value.s) && !Array.isArray(value.sections);
  if (!looksCompact) return value;
  return {
    title: value.t,
    subtitle: value.st,
    author: value.a,
    date: value.d,
    executiveSummary: value.es,
    sections: value.s.map((section) => ({
      heading: section?.h,
      level: section?.lv,
      paragraphs: section?.p,
      bullets: section?.b,
      quote: section?.q
    })),
    closing: value.c
  };
}

// 2026-08-31 reliability follow-up: live itemizable-fixture testing found the
// model repeatedly omitting the closing "]" of "es" before starting "s" —
// json-mode ("format":"json" on Ollama, which only asks for well-formed JSON)
// does not stop that. Ollama's native /api/chat "format" field also accepts a
// full JSON Schema object and enforces the grammar server-side, which
// structurally prevents both that failure and the model overshooting the
// bullet cap. additionalProperties:false and required/minItems/maxItems are
// deliberately strict — this is the actual compact wire shape, not a superset.
export function documentWireSchema(sectionCount) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["t", "s"],
    properties: {
      t: { type: "string", minLength: 1 },
      st: { type: "string" },
      a: { type: "string" },
      d: { type: "string" },
      es: {
        type: "array",
        maxItems: 3,
        items: { type: "string", minLength: 1 }
      },
      s: {
        type: "array",
        minItems: sectionCount,
        maxItems: sectionCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["h", "p"],
          properties: {
            h: { type: "string", minLength: 1 },
            p: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1 } },
            b: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1 } },
            q: { type: "string", minLength: 1 }
          }
        }
      },
      c: { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } }
    }
  };
}

export async function planDocument({
  brief,
  documentType = "Laporan profesional",
  tone = "",
  sectionCount = 6,
  instruction = "",
  signal,
  onMetrics,
  // Forwarded to runTantular verbatim — see its own doc comment. A benchmark
  // or reliability gate must pass "none" here so a Q8 timeout is reported as
  // a timeout, not silently answered by (and persisted as) Lite.
  modelFallbackPolicy = "timeout-and-missing"
}) {
  const source = String(brief || "").trim();
  const count = clamp(sectionCount, 3, 12);
  if (!source) return { spec: null, source: "empty", error: "Sumber dokumen kosong." };

  try {
    const raw = await runTantular({
      system: DOCUMENT_SYSTEM,
      user: documentUser({ brief: source, documentType, tone, sectionCount: count, instruction }),
      maxTokens: Math.min(6000, 1200 + count * 450),
      temperature: 0.2,
      task: "document",
      jsonMode: true,
      jsonSchema: documentWireSchema(count),
      signal,
      onMetrics,
      modelFallbackPolicy
    });

    const parseResult = extractJsonDetailed(raw);
    if (!parseResult.ok) {
      return {
        spec: fallbackDocumentSpec(source, documentType, count),
        source: "fallback",
        errorCode: "invalid_json",
        validationErrors: [],
        error: "Model menghasilkan JSON yang tidak valid."
      };
    }

    // 2026-08-31 reliability follow-up: live testing showed Ollama's native
    // JSON-Schema grammar reduces but does NOT eliminate malformed or
    // out-of-bounds output (a fresh, verified-schema-capable Companion still
    // produced unparseable JSON in one run, and a wrong section/bullet count
    // in others). normalizeDocumentSpec()'s slicing/defaulting is forgiving
    // by design (it also has to accept the legacy long-key schema, which was
    // never schema-enforced) — that forgiveness must not be allowed to turn
    // an out-of-contract compact-schema response into an apparent success.
    // Strict validation therefore runs BEFORE normalization, and ONLY
    // against the compact schema (the one this prompt actually asks for and
    // the one documentWireSchema() describes) — the legacy long-key shape
    // keeps its existing lenient behavior unchanged, since it was never
    // covered by a JSON Schema contract to validate against.
    // A response is treated as legacy ONLY when it carries no compact "s"
    // marker at all — a response carrying BOTH "s" and "sections" is NOT a
    // legitimate legacy response and must not bypass strict validation via
    // the (Array.isArray(sections)) escape hatch that would previously have
    // let it through. validateDocumentWire() below then rejects "sections"
    // outright as an unknown root property, exactly as it should for any
    // other unrecognized key.
    const looksCompact = parseResult.value && typeof parseResult.value === "object"
      && Object.prototype.hasOwnProperty.call(parseResult.value, "s");
    if (looksCompact) {
      const validation = validateDocumentWire(parseResult.value, count);
      if (!validation.ok) {
        return {
          spec: fallbackDocumentSpec(source, documentType, count),
          source: "fallback",
          errorCode: "invalid_structure",
          validationErrors: validation.errors,
          error: "Model menghasilkan struktur dokumen yang tidak valid."
        };
      }
    }

    return {
      spec: normalizeDocumentSpec(decodeDocumentModelOutput(parseResult.value), source, count),
      source: "model"
    };
  } catch (error) {
    // A user's Cancel must stop the workflow, not degrade into a fallback
    // document that then gets built and inserted anyway. Only a genuine
    // model/network failure may fall back.
    if (signal?.aborted) throw error;
    return {
      spec: fallbackDocumentSpec(source, documentType, count),
      source: "fallback",
      errorCode: "request_failed",
      validationErrors: [],
      error: error?.message || String(error)
    };
  }
}

export function normalizeDocumentSpec(value, sourceText = "", sectionCount = 6) {
  const source = String(sourceText || "").trim();
  const title = text(value?.title) || inferTitle(source) || "Dokumen Tantular";
  const sections = (Array.isArray(value?.sections) ? value.sections : [])
    .map((section, index) => normalizeSection(section, index))
    .filter((section) => section.heading || section.paragraphs.length || section.bullets.length)
    .slice(0, clamp(sectionCount, 3, 12));

  return {
    title,
    subtitle: text(value?.subtitle),
    author: groundedMetadata(value?.author, source),
    date: groundedMetadata(value?.date, source),
    executiveSummary: list(value?.executiveSummary).slice(0, 5),
    sections: sections.length ? sections : fallbackSections(source, sectionCount),
    closing: list(value?.closing).slice(0, 6)
  };
}

export function fallbackDocumentSpec(sourceText, documentType = "Dokumen", sectionCount = 6) {
  return buildDeterministicDocumentSpec(sourceText, documentType, sectionCount);
}

// 2026-08-31 fallback-quality follow-up: a financial PDF converted through
// this fallback used to shred a bilingual title page and financial-statement
// rows into evenly-sized chunks labeled "Bagian 1", "Bagian 2" — the extractor
// already flattens PDF/DOCX/PPTX/XLSX text with structural markers
// ("[Page N]", "[Slide N]", "[Sheet: Name]") and headings are still
// detectable in that flattened text, but the old fallback never looked for
// them. This reuses the SAME detection Deck Studio's deterministic path
// already relies on (src/document/extractedStructure.js, moved out of
// src/deck/documentDeck.js so both can share it) instead of a second,
// weaker implementation.
//
// Scope note: this is deterministic TEXT-PATTERN structure detection over
// the flattened extractor output — not a per-format OOXML/PDF block-level
// parser (real DOCX heading styles, PPTX shape geometry, XLSX cell
// addresses). It fixes the demonstrated fallback-quality bug (generic
// section labels, lost titles, unassociated statement rows) using the same
// text the model prompt already receives; it does not add structural
// fidelity beyond what is recoverable from that flattened text.
export function buildDeterministicDocumentSpec(sourceText, documentType = "Dokumen", sectionCount = 6) {
  const source = String(sourceText || "").trim();
  const count = clamp(sectionCount, 3, 12);
  const normalized = stripRepeatedPageLines(normalizeStructureText(source));

  // inferTitle() specifically handles "Buatlah laporan tentang X" style
  // instructions (extracting "X" as the real topic) — detectStructureTitle()
  // has no such handling, so an instruction-shaped candidate from it must be
  // rejected in favor of inferTitle()'s own extraction, not used verbatim.
  const structureTitle = text(detectStructureTitle(normalized));
  const title = (structureTitle && !/^(buat|buatlah|susun|tulis|create|write)\b/i.test(structureTitle) ? structureTitle : "")
    || inferTitle(source) || documentType || "Dokumen Tantular";
  const periods = documentPeriods(normalized);

  let detected = detectSections(normalized);
  if (detected.length < 3) detected = detectSectionsLoose(normalized);
  // "Ikhtisar"/"Isi Utama" catch-all buckets (used when body text precedes
  // the first detected heading) do not count as a MEANINGFUL heading on
  // their own — at least 2 sections must carry a real, detected title before
  // this path is trusted over the plain-paragraph fallback.
  const meaningfulCount = detected.filter((s) => s.title && s.title !== "Ikhtisar").length;

  let coverageNote = null;
  let sections;
  if (meaningfulCount >= 2) {
    let chosen = detected;
    if (detected.length > count) {
      // More real sections than requested: keep the most substantial ones,
      // in original document order — never fabricate extra ones when there
      // are fewer than requested (handled by the `else` branch below).
      chosen = [...detected]
        .map((s, i) => ({ ...s, i }))
        .sort((a, b) => b.body.length - a.body.length)
        .slice(0, count)
        .sort((a, b) => a.i - b.i);
    } else if (detected.length < count) {
      coverageNote = `Dokumen sumber memiliki ${detected.length} bagian bermakna yang terdeteksi — ditampilkan apa adanya, tidak diisi otomatis untuk mencapai ${count} bagian yang diminta.`;
    }
    sections = chosen.map((section) => structuredSectionToBlock(section, periods));
  } else {
    // No real headings detected (plain prose / typed brief with no
    // structure) — unchanged behavior: balanced paragraph groups.
    sections = fallbackSections(source, count);
  }

  const closing = [
    "Validasi isi terhadap sumber sebelum dokumen digunakan sebagai keputusan final.",
    "Lengkapi pemilik, tenggat, dan data pendukung bila diperlukan."
  ];
  if (coverageNote) closing.unshift(coverageNote);

  return {
    title,
    subtitle: documentType,
    author: "",
    date: "",
    executiveSummary: sections.slice(0, 5).map((section) => section.heading),
    sections,
    closing
  };
}

// A detected section's own source is either a financial-statement table
// (rendered as bullets — one line item per bullet, values labelled by
// period) or prose (kept as paragraphs, never invented). Bilingual mirror
// headings ("LAPORAN LABA RUGI/PROFIT OR LOSS") are reduced to their
// Indonesian half — same treatment Deck Studio already gives statement
// headings — so the heading is not visibly duplicated.
function structuredSectionToBlock(section, documentPeriodsList) {
  const heading = text(stripBilingualMirror(section.title)) || "Bagian";
  if (looksLikeStatement(section.body)) {
    return {
      heading,
      level: 1,
      paragraphs: [],
      bullets: statementBullets(section.body, section.title, 8, documentPeriodsList),
      quote: ""
    };
  }
  return {
    heading,
    level: 1,
    paragraphs: paragraphsFromBody(section.body),
    bullets: [],
    quote: ""
  };
}

// Splits a section's flattened body into readable paragraphs without
// inventing content: whole existing blank-line paragraphs are kept verbatim
// when present; otherwise the body is split at sentence boundaries and
// regrouped into at most 3 reasonably-sized paragraphs, never a single
// unreadable wall of text.
function paragraphsFromBody(body) {
  const raw = String(body || "").trim();
  if (!raw) return [];
  const existing = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (existing.length > 1) return existing.slice(0, 3);
  const sentences = raw.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter(Boolean);
  if (sentences.length <= 3) return [raw.replace(/\s+/g, " ")];
  const perParagraph = Math.ceil(sentences.length / 3);
  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += perParagraph) {
    paragraphs.push(sentences.slice(i, i + perParagraph).join(" ").trim());
  }
  return paragraphs.filter(Boolean).slice(0, 3);
}

// Document-level statement periods (e.g. ["2026", "2025"]), read from the
// first line naming at least two years — same heuristic documentDeck.js
// already uses so a statement row's own values are labelled consistently
// with what Deck Studio would show for the same source.
function documentPeriods(sourceText) {
  for (const line of String(sourceText || "").split("\n")) {
    const periods = detectPeriods(line);
    if (periods.length >= 2) return periods;
  }
  return [];
}

function normalizeSection(section, index = 0) {
  return {
    heading: text(section?.heading || section?.title) || `Bagian ${index + 1}`,
    level: clamp(section?.level || 1, 1, 2),
    paragraphs: list(section?.paragraphs || section?.body).slice(0, 6),
    bullets: list(section?.bullets || section?.points).slice(0, 8),
    quote: text(section?.quote)
  };
}

function fallbackSections(source, count) {
  const paragraphs = String(source || "")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((item) => item.trim())
    .filter((item) => item.length > 20);
  const groups = Math.min(clamp(count, 3, 12), Math.max(1, paragraphs.length));
  const perGroup = Math.ceil(Math.max(1, paragraphs.length) / groups);
  const sections = [];
  for (let i = 0; i < paragraphs.length; i += perGroup) {
    const body = paragraphs.slice(i, i + perGroup);
    if (!body.length) continue;
    sections.push({
      heading: `Bagian ${sections.length + 1}`,
      level: 1,
      paragraphs: body.slice(0, 5),
      bullets: [],
      quote: ""
    });
  }
  return sections.length ? sections : [{
    heading: "Isi Utama",
    level: 1,
    paragraphs: [source || "Tambahkan brief atau sumber dokumen."],
    bullets: [],
    quote: ""
  }];
}

// Pure parse step, kept separate from validateDocumentWire() below: a
// response can be syntactically valid JSON and still be out of contract
// (wrong section count, too many bullets, an unknown property) — those are
// two different failure classes and callers need to tell them apart.
// Trailing-comma repair is intentional and pre-existing (kept from the
// original extractJson()); missing brackets/braces are deliberately NOT
// guessed or repaired — see planDocument's own comment on why.
export function extractJsonDetailed(raw) {
  const value = String(raw || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, value: null, errorCode: "no_object", errorPosition: null };
  }
  const candidate = value.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    return { ok: true, value: JSON.parse(candidate), errorCode: null, errorPosition: null };
  } catch (error) {
    const positionMatch = String(error?.message || "").match(/position (\d+)/);
    const errorPosition = positionMatch ? Number(positionMatch[1]) : null;
    return { ok: false, value: null, errorCode: "json_parse_error", errorPosition };
  }
}

const DOCUMENT_WIRE_ROOT_KEYS = new Set(["t", "st", "a", "d", "es", "s", "c"]);
const DOCUMENT_WIRE_SECTION_KEYS = new Set(["h", "p", "b", "q", "lv"]);

function nonEmptyStringArray(value, maxItems) {
  return Array.isArray(value) && value.length >= 1 && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.trim());
}

// Strict, syntax-independent structural check against the EXACT compact wire
// contract documentWireSchema() describes — deliberately stricter than
// normalizeDocumentSpec()'s own defensive slicing/defaulting, which exists to
// stay lenient toward the legacy long-key schema and must not be mistaken
// for a validator. Only called for compact-schema responses (see
// planDocument) — a syntactically valid but structurally wrong response
// (wrong section count, 3 paragraphs where the schema said 2, 8 bullets,
// an unknown property) must not be allowed through as source:"model".
export function validateDocumentWire(value, sectionCount) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["root_not_object"] };
  }

  for (const key of Object.keys(value)) {
    if (!DOCUMENT_WIRE_ROOT_KEYS.has(key)) errors.push(`unknown_root_property_${key}`);
  }
  if (typeof value.t !== "string" || !value.t.trim()) errors.push("missing_title");
  if (value.st !== undefined && typeof value.st !== "string") errors.push("invalid_subtitle");
  if (value.a !== undefined && typeof value.a !== "string") errors.push("invalid_author");
  if (value.d !== undefined && typeof value.d !== "string") errors.push("invalid_date");

  if (!Array.isArray(value.s)) {
    errors.push("sections_not_array");
  } else {
    if (value.s.length !== sectionCount) errors.push("wrong_section_count");
    value.s.forEach((section, index) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        errors.push(`section_${index + 1}_not_object`);
        return;
      }
      for (const key of Object.keys(section)) {
        if (!DOCUMENT_WIRE_SECTION_KEYS.has(key)) errors.push(`section_${index + 1}_unknown_property_${key}`);
      }
      if (typeof section.h !== "string" || !section.h.trim()) errors.push(`section_${index + 1}_missing_heading`);
      if (!nonEmptyStringArray(section.p, 2)) errors.push(`section_${index + 1}_invalid_paragraphs`);
      if (section.b !== undefined && !nonEmptyStringArray(section.b, 2)) errors.push(`section_${index + 1}_invalid_bullets`);
      if (section.q !== undefined && (typeof section.q !== "string" || !section.q.trim())) {
        errors.push(`section_${index + 1}_invalid_quote`);
      }
      if (section.lv !== undefined && section.lv !== 1 && section.lv !== 2) {
        errors.push(`section_${index + 1}_invalid_level`);
      }
    });
  }

  if (value.es !== undefined && !nonEmptyStringArray(value.es, 3)) errors.push("invalid_executive_summary");
  if (value.c !== undefined && !nonEmptyStringArray(value.c, 2)) errors.push("invalid_closing");

  return { ok: errors.length === 0, errors };
}

function inferTitle(source) {
  const line = String(source || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  if (/^(buat|buatlah|susun|tulis|create|write)\b/i.test(line)) {
    const topic = line.match(/\b(?:tentang|mengenai|untuk)\s+(.+?)(?:[.;]|$)/i)?.[1];
    if (topic) return headline(topic);
  }
  return line.length <= 100 ? line : "";
}

function headline(value) {
  const words = String(value || "").trim().split(/\s+/);
  return words.map((word, index) => (
    index === 0 || word.length > 3 ? word.charAt(0).toUpperCase() + word.slice(1) : word
  )).join(" ").slice(0, 100);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function groundedMetadata(value, source) {
  const candidate = text(value);
  if (!candidate) return "";
  const normalizedSource = String(source || "").toLowerCase().replace(/\s+/g, " ");
  return normalizedSource.includes(candidate.toLowerCase().replace(/\s+/g, " ")) ? candidate : "";
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/\r?\n|•|(?:^|\s)-\s+/).map(text).filter(Boolean);
  }
  return [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}
