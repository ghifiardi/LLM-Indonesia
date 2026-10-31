// The agentic half of lookup: the model helps COMPOSE the query.
//
//   user intent + document  →  local model  →  clarifying question
//                                            + 2–3 candidate queries
//   user picks/edits one    →  the normal prepare → approval → execute flow
//
// NOTHING here leaves the machine. Refinement runs entirely against the local
// model; its output is suggestions in the pane. Egress still has exactly one
// door — the approval dialog — and a model-proposed query walks through it
// the same as a typed one, shown verbatim with its length.
//
// THE RISK THIS FILE OWNS: the model composes queries while reading the
// document, so a proposed query is a potential exfiltration channel — the
// model (or, on follow-up hops, a hostile page influencing it) could embed
// document values in a query the user then approves out of habit. Every
// candidate is therefore screened against the document's protected strings
// and long digit runs, and flagged ones carry a warning the pane must show.
// Screening FLAGS rather than refuses: "profil PT Sinar Mas" can be a
// legitimate thing to search for — but never silently.

import { deriveProtected } from "./verifyWebAnswer.js";

export const MAX_CANDIDATES = 3;
export const MAX_QUERY_CHARS = 150;

export function buildRefinePrompt({ intent, document }) {
  const doc = String(document || "").slice(0, 4000);
  return `Anda membantu menyusun query pencarian web yang spesifik.

[DOKUMEN PENGGUNA — konteks, JANGAN disalin ke query]
${doc || "(tidak ada dokumen)"}
[AKHIR DOKUMEN]

Maksud pengguna: ${String(intent || "").trim()}

Balas HANYA dengan JSON valid, tanpa teks lain, berbentuk:
{"question": "satu pertanyaan klarifikasi singkat untuk pengguna",
 "candidates": [{"query": "query spesifik", "why": "alasan singkat"}]}

Aturan:
- Maksimal ${MAX_CANDIDATES} kandidat, masing-masing query maksimal ${MAX_QUERY_CHARS} karakter.
- Query harus topik umum yang bisa dicari publik. JANGAN memasukkan angka,
  nama vendor, atau isi lain dari dokumen ke dalam query kecuali pengguna
  memintanya secara eksplisit.
- "why" menjelaskan dalam satu kalimat mengapa kandidat itu menjawab maksud.`;
}

// FAIL-CLOSED PARSER. The model may wrap JSON in prose or emit garbage; a
// result that cannot be parsed is "no suggestions", never a guess.
export function parseRefineResponse(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, reason: "no_json" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  const question = String(parsed?.question || "").trim().slice(0, 300);
  const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const candidates = [];
  for (const c of rawCandidates) {
    const query = String(c?.query || "").trim();
    if (!query || query.length > MAX_QUERY_CHARS) continue;   // oversize is dropped, not truncated:
    candidates.push({                                          // a silently cut query is not what
      query,                                                   // the model proposed
      why: String(c?.why || "").trim().slice(0, 200)
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (!candidates.length) {
    return { ok: false, reason: "no_candidates" };
  }
  return { ok: true, question, candidates };
}

// Flag candidates that would carry document content out. Protected strings
// come from the same derivation the verifier uses, plus any digit run long
// enough to be an amount or an ID rather than a year.
export function screenCandidates(candidates, document) {
  const doc = String(document || "");
  const needles = deriveProtected(doc).map((s) => s.toLowerCase());
  for (const m of doc.matchAll(/\d[\d.,]{5,}\d/g)) {
    needles.push(m[0].replace(/[^\d]/g, ""));
  }
  return candidates.map((c) => {
    const q = c.query.toLowerCase();
    const qDigits = c.query.replace(/[^\d]/g, "");
    const leaks = needles.some((n) =>
      /^\d+$/.test(n) ? (n.length >= 6 && qDigits.includes(n)) : q.includes(n));
    return { ...c, containsDocumentData: leaks };
  });
}

export function refineResult(modelText, document) {
  const parsed = parseRefineResponse(modelText);
  if (!parsed.ok) return parsed;
  return { ok: true, question: parsed.question,
           candidates: screenCandidates(parsed.candidates, document) };
}

// Fast default for the pane. Query wording does not require a 9B model: a
// cold model took long enough to leave Excel stuck on "Menyusun usulan
// query..." with no timeout. These suggestions use ONLY the user's typed
// intent, never document text, then pass through the same leak-screening
// contract as model suggestions.
export function deterministicRefineResult(intent, document, {
  year = new Date().getFullYear()
} = {}) {
  const base = String(intent || "").replace(/\s+/g, " ").trim()
    .replace(/[?.!,;:]+$/g, "").slice(0, MAX_QUERY_CHARS);
  if (!base) return { ok: false, reason: "empty_intent" };

  const raw = [
    { query: base, why: "Mempertahankan maksud pencarian Anda tanpa menambah data dokumen." },
    {
      query: `${base} terbaru ${year}`.slice(0, MAX_QUERY_CHARS),
      why: `Memfokuskan hasil pada perkembangan terbaru hingga ${year}.`
    },
    {
      query: `${base} data resmi`.slice(0, MAX_QUERY_CHARS),
      why: "Memprioritaskan statistik, laporan, dan sumber resmi."
    }
  ];
  const seen = new Set();
  const candidates = raw.filter(({ query }) => {
    const key = query.toLowerCase();
    if (!query || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: true,
    question: "Pilih query dasar, perkembangan terbaru, atau fokus data resmi.",
    candidates: screenCandidates(candidates, document)
  };
}
