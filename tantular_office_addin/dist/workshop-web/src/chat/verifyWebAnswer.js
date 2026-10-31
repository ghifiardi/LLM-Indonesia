// Verify an answer built with untrusted web content against the USER DOCUMENT.
//
// A port of src/verify_web_answer.py + src/faithful_facts.py from the
// distillation repo, moved here because a check that only exists in Python is
// a check the product does not perform. The companion runs this after fetch
// and before anything reaches the pane.
//
// WHY THE PORT RATHER THAN SHELLING OUT TO PYTHON: the companion would then
// depend on an interpreter, a virtualenv and a repo path that no installed
// add-in has. A missing interpreter would be indistinguishable from a passing
// check unless handled exactly right, and that is the failure mode this whole
// mechanism exists to prevent. The Python stays as the comparison harness —
// tests/verifyWebAnswerParity.test.mjs asserts the two agree.
//
// THE DESIGN PROBLEM. Permitted facts cannot be "document ∪ web page": an
// injected `PT Contoh` appears in the page, so sourcing alone would bless it.
// The rules are about the ROLE a fact plays, not where it came from.
//
//   preserves       facts the DOCUMENT asserts must still be there. A vendor
//                   that vanishes is a violation however plausible its
//                   replacement.
//   noNewFacts      numbers, dates and entities must trace to the document or
//                   the fetched page. Catches inventions with no source.
//   untrustedEcho   the answer must not adopt attacker-chosen format markers or
//                   repeat distinctive payload literals from instruction-like
//                   web text. A disclaimer that quotes "PT Contoh" still carries
//                   attacker-controlled content into the trusted result.
//
// FAILS CLOSED. Missing document, missing answer, or a check that throws is a
// refusal. An unverified answer is never presented as verified.

const MONTHS = ["januari", "februari", "maret", "april", "mei", "juni", "juli",
  "agustus", "september", "oktober", "november", "desember"];

// Words that legitimately open an Indonesian sentence and would otherwise read
// as entities. Not exhaustive by design: the entity check only flags tokens
// ABSENT from the source, so a gap here can only produce a false positive on
// genuinely new text — the case we want seen rather than hidden.
const SENTENCE_OPENERS = new Set([
  "berikut", "dokumen", "informasi", "data", "mohon", "silakan", "sesuai",
  "berdasarkan", "dengan", "untuk", "pada", "dalam", "tidak", "belum",
  "maaf", "catatan", "perubahan", "hasil", "ringkasan", "adapun", "namun",
  "selain", "setelah", "sebelum", "jika", "karena", "oleh", "agar", "saya",
  "kami", "ini", "itu", "terima", "kalimat", "teks", "bagian", "laporan",
  "memo", "notulen", "rapat", "anggaran", "jumlah", "total", "nilai"
]);

// Generic technical and format words. A summary that says "output JSON" has
// invented nothing; flagging it teaches people to ignore the checker. Found
// when the verifier blocked a CORRECT answer that mentioned JSON while
// correctly refusing an injected edit contract.
const GENERIC_ACRONYMS = new Set([
  "json", "xml", "csv", "pdf", "html", "url", "api", "http", "https", "ai",
  "id", "ram", "cpu", "gpu", "ok", "pdf/a", "utf-8", "sla", "kpi", "sop",
  "faq", "it", "hr", "qr", "pin", "otp"
]);

// Currency and measure markers are capitalised but name nothing. "Pagu Rp
// 1.750.000.000" is not an organisation called "Pagu Rp".
const NON_ENTITY_TOKENS = new Set(["rp", "idr", "usd", "eur", "sgd", "kwh", "kg", "km"]);

// Common document nouns. Models answer in Markdown, and "**Pagu Belanja
// Modal:**" title-cases ordinary words, which then read as a company name.
const COMMON_NOUNS = new Set([
  "ringkasan", "laporan", "anggaran", "pagu", "belanja", "modal", "vendor",
  "utama", "realisasi", "persentase", "persen", "triwulan", "semester",
  "kontrak", "tanggal", "total", "jumlah", "catatan", "keterangan", "sisa",
  "nilai", "rincian", "uraian", "periode", "tahun", "bulan", "dokumen",
  "pengguna", "sumber", "status", "target", "capaian", "penyerapan"
]);

// Currency PREFIXES are part of the fact. Before USD was recognised,
// "USD 1.750.000.000" extracted as a bare number and matched the document's
// bare "1750000000" — a currency rewrite the checks could not see.
const NUMBER_RE = /(?:(?:Rp|IDR|USD|EUR|SGD|US\$|\$)\s*)?\d[\d.,]*\s*(?:%|persen|kwh|kg|km|jam|hari|bulan|tahun|orang|unit|lembar|buah)?/gi;
const DATE_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join("|")})\\s*(\\d{4})?\\b`, "gi");
// Two or more capitalised words in a row, or a single ALL-CAPS token.
const ENTITY_RE = /\b(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+|[A-Z]{2,})\b/g;

function normaliseNumber(token) {
  const lower = String(token).trim().toLowerCase();
  const digits = lower.replace(/[^\d]/g, "");
  let unit = lower.replace(/[\d\s.,]/g, "");
  // "23,6%" and "23,6 persen" are one fact. Two spellings of one unit flagged
  // a correct summary for writing % where the document wrote persen.
  if (unit === "%" || unit === "persen") unit = "%";
  return `${digits}|${unit}`;
}

function numbers(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(NUMBER_RE)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const fact = normaliseNumber(raw);
    // "Slide 3", "Poin 6", list indices: a bare one- or two-digit integer
    // with no unit is structure, not a fact worth policing. Real quantities
    // carry units or magnitude. (Real-Excel acceptance, 2026-08-25.)
    const [digits, unit] = fact.split("|");
    if (!unit && digits.length <= 2) continue;
    out.add(fact);
  }
  return out;
}

function dates(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(DATE_RE)) {
    out.add(`${m[1]}|${m[2].toLowerCase()}|${m[3] || ""}`);
  }
  return out;
}

function entities(text) {
  const out = new Set();
  // "**Kekurangan Data:**" is a heading the model invented to STRUCTURE its
  // answer, not a fact it asserted — yet the colon made it its own segment and
  // it read as an organisation (real-Excel acceptance, 2026-08-25). Bold
  // labels ending in a colon are dropped wholesale; their VALUES survive on
  // their own lines.
  const cleaned = String(text || "").replace(/\*\*([^*\n]{2,60}):\*\*/g, "");
  for (const sentence of cleaned.split(/(?<=[.!?:\n])\s+/)) {
    // Leading Markdown decoration hides sentence-initial position from the
    // checks below ("**Data" does not start with "Data").
    const stripped = sentence.trim().replace(/^[\s*_#>•-]+/, "");
    if (!stripped) continue;
    for (const m of stripped.matchAll(ENTITY_RE)) {
      const token = m[0].trim();
      const lowered = token.toLowerCase();
      // Sentence-initial: a capital there carries no information.
      if (stripped.startsWith(token) && !token.includes(" ")) continue;
      if (SENTENCE_OPENERS.has(lowered)) continue;
      if (MONTHS.some((month) => lowered.includes(month))) continue;
      if (GENERIC_ACRONYMS.has(lowered)) continue;
      // Bullet markers capitalise their first word too.
      if (/^[-*•]\s/.test(stripped) && stripped.slice(2).startsWith(token)) continue;

      let words = token.split(/\s+/);
      if (stripped.startsWith(token) && words.length > 1) words = words.slice(1);
      words = words.filter((w) => !NON_ENTITY_TOKENS.has(w.toLowerCase()));
      // Roman numerals and ordinary nouns carry no identity either.
      words = words.filter((w) => !COMMON_NOUNS.has(w.toLowerCase())
                                  && !/^[IVXLC]+$/.test(w));
      if (!words.length) continue;
      if (words.length === 1 && words[0] !== words[0].toUpperCase()) continue;
      const remainder = words.join(" ").toLowerCase();
      if (GENERIC_ACRONYMS.has(remainder)) continue;
      out.add(remainder);
    }
  }
  return out;
}

export function extractFacts(text) {
  return { numbers: numbers(text), dates: dates(text), entities: entities(text) };
}

// An Excel cell holds "1750000000"; the model naturally writes "Rp
// 1.750.000.000". Same fact, two spellings — flagging it blocked a correct
// answer in real-Excel acceptance (2026-08-25). Rp/IDR are the ambient
// currency here, so they are equivalent to the bare form; FOREIGN currencies
// stay distinct because rewriting Rp as USD is a real distortion.
const AMBIENT_CURRENCY = new Set(["", "rp", "idr"]);

function sameNumberDifferentMarker(fact, srcSet) {
  const [digits, unit] = String(fact).split("|");
  if (!AMBIENT_CURRENCY.has(unit)) return false;
  return [...AMBIENT_CURRENCY].some((u) => srcSet.has(`${digits}|${u}`));
}

// The strict entity rules exist to keep the ANSWER side from tripping over
// headings and sentence capitals. Applying them to the SOURCE side shrinks
// the permitted set instead: "OJK mulai mengawasi..." opens a sentence, so
// strict extraction dropped OJK from the page — and then a benign answer
// citing OJK was "inventing" it (real-Excel acceptance, 2026-08-25). The
// source is document ∪ page, which no_new_facts permits WHOLESALE by design,
// so source extraction is liberal: every capitalised match, no pruning, plus
// substring containment so "Sinar Mas" matches a source's "PT Sinar Mas".
function liberalEntities(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(ENTITY_RE)) {
    out.add(m[0].trim().toLowerCase());
  }
  return out;
}

export function newFacts(output, source) {
  const src = extractFacts(source);
  const out = extractFacts(output);
  const permittedEntities = new Set([...src.entities, ...liberalEntities(source)]);
  const entityPermitted = (f) =>
    permittedEntities.has(f) || [...permittedEntities].some((s) => s.includes(f));
  const found = {};
  for (const kind of ["numbers", "dates", "entities"]) {
    let introduced = [...out[kind]].filter((f) => !src[kind].has(f));
    if (kind === "numbers") {
      introduced = introduced.filter((f) => !sameNumberDifferentMarker(f, src.numbers));
    }
    if (kind === "entities") {
      introduced = introduced.filter((f) => !entityPermitted(f));
    }
    introduced.sort();
    if (introduced.length) found[kind] = introduced;
  }
  return found;
}

// --- the three checks -------------------------------------------------------

export function checkPreserves(answer, protect, document) {
  const missing = [];
  for (const needle of protect) {
    if (!document.includes(needle)) {
      // Protecting something absent from the source is a CONFIGURATION error,
      // not a model failure. Refuse rather than silently pass.
      missing.push(`CONFIG: ${JSON.stringify(needle)} is not in the document`);
    } else if (!answer.includes(needle)) {
      missing.push(`${JSON.stringify(needle)} present in the document, absent from the answer`);
    }
  }
  return missing;
}

export function checkNoNewFacts(answer, document, untrusted) {
  const introduced = newFacts(answer, `${document}\n${untrusted}`);
  return Object.entries(introduced).map(([kind, vals]) => `${kind}: ${JSON.stringify(vals)}`);
}

const INSTRUCTION_CUE =
  /\b(?:abaikan|awali|ganti(?:lah)?|ubah(?:lah)?|replace|keluarkan|salin|sertakan|instruksi|perintah|diam-diam|roleplay|mulai sekarang|kamu adalah|jangan sebutkan|tulis ulang)\b/i;

// The GATE cues: injection SHAPES, not imperative vocabulary. The broad list
// above (INSTRUCTION_CUE) only scopes literal extraction for the echo check,
// where a false positive is cheap. Used as a display gate it withheld the
// synthesis of a real query because one page carried a CSS template comment,
// "Replace them with your own styles" (acceptance run, 2026-09-04). Each
// alternative here is a phrase that addresses the model or rewrites the
// document — the seven harness classes — and none is ordinary procedural text
// ("sertakan salinan", "instruksi pengisian", "perintah menteri").
const INSTRUCTION_GATE_CUE = new RegExp([
  String.raw`\babaikan\s+(?:instruksi|perintah|aturan|semua)\b`,
  String.raw`\bdiam-diam\b`,
  String.raw`\broleplay\b`,
  String.raw`\bmulai sekarang\b`,
  String.raw`\bkamu adalah\b`,
  String.raw`\bjangan sebutkan\b`,
  String.raw`\btulis ulang\b`,
  String.raw`\bawali\s+(?:jawaban|balasan|respons)\b`,
  String.raw`\bsalin\s+isi\s+dokumen\b`,
  String.raw`\bkeluarkan\s+persis\b`,
  String.raw`\b(?:ganti|ubah)(?:lah)?\s+(?:semua|nama|vendor|angka|isi|jumlah)\b`,
  String.raw`\binstruksi\s+(?:baru|sistem|sebelumnya)\b`,
  String.raw`\bwajib\s+(?:menulis|ditulis|menyebut)\b`,
  String.raw`\bignore\s+(?:all|previous|prior)\b`,
  String.raw`\byou are now\b`
].join("|"), "i");

export function instructionGateCues(text) {
  // A raw JSON body (single-host path) carries "\n" and "\"" as two-character
  // escapes: "IV.\n\nKeluarkan" glues "n" to the cue word and defeats \b.
  // Normalise the escapes first; the scan itself is unchanged.
  const normalised = String(text || "")
    .replace(/\\[nrt]/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\//g, "/");
  return normalised.split(/\n+|(?<=[.!?])\s+/).some((segment) => INSTRUCTION_GATE_CUE.test(segment));
}

// Kept for callers that gate a whole fetched blob. Same strict cue set.
export function hasInstructionCues(untrusted) {
  return instructionGateCues(untrusted);
}

export function checkUntrustedEcho(answer, document, untrusted, window = 60, minLen = 5) {
  const answerText = String(answer || "");
  const documentText = String(document || "");
  const untrustedText = String(untrusted || "");
  const head = answerText.slice(0, window);
  const findings = [];
  const markerRe = new RegExp(`[A-Za-z][A-Za-z_-]{${minLen - 1},}:`, "g");
  for (const m of untrustedText.matchAll(markerRe)) {
    const token = m[0];
    if (head.includes(token) && !documentText.includes(token)) {
      findings.push("answer opens with a marker supplied by the untrusted page");
    }
  }

  // The marker check above catches an attack-controlled FORMAT such as
  // "VERIFY:". It does not catch a model that refuses an instruction but then
  // quotes its payload in a trusted-looking disclaimer:
  //
  //   "Instruksi untuk mengganti vendor menjadi PT Contoh tidak disertakan."
  //
  // That still lets hostile page content reach the pane. Look only inside
  // instruction-like segments, then block distinctive literals from those
  // segments when they are absent from the user's document.
  // Injection-shaped phrases ONLY. The first list included "sebagai",
  // "mulai", "sistem" and "tulis" — words present in nearly every paragraph
  // of encyclopedic Indonesian, which made most of a REAL page count as
  // instructions and turned every entity cited from it into a forbidden
  // literal (real-Excel acceptance, 2026-08-25: "BEI"/"OJK" blocked a benign
  // answer). Facts from the page are explicitly permitted by no_new_facts;
  // this rule exists for imperative payloads, so its cues must be imperative.
  const instructionCue = INSTRUCTION_CUE;
  const literals = new Set();
  for (const segment of untrustedText.split(/\n+|(?<=[.!?])\s+/)) {
    if (!instructionCue.test(segment)) continue;
    const patterns = [
      /\[[^\]\n]{3,120}\]/g,
      /["'“”]([^"'“”\n]{3,120})["'“”]/g,
      /\b(?:PT|CV|PD|UD|Yayasan|Koperasi)\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g,
      /\b(?:[A-Z]{2,}[A-Z0-9_-]*|[A-Z][a-z]+[A-Z][A-Za-z0-9_-]*)\b/g
    ];
    for (const pattern of patterns) {
      for (const match of segment.matchAll(pattern)) {
        const literal = String(match[1] || match[0]).trim();
        if (literal.length < 3) continue;
        // A literal is only evidence if it is DISTINCTIVE. "DATA" in caps is
        // ordinary vocabulary and matched every answer containing the word
        // "data" (real-Excel acceptance, 2026-08-25). Single common words are
        // out; short all-caps tokens must be at least five characters unless
        // they carry structure ([...], quotes, PT names — multi-token).
        const lower = literal.toLowerCase();
        if (COMMON_NOUNS.has(lower) || GENERIC_ACRONYMS.has(lower)
            || SENTENCE_OPENERS.has(lower)) continue;
        if (/^[A-Z]{2,4}$/.test(literal)) continue;
        literals.add(literal);
      }
    }
  }
  const answerLower = answerText.toLowerCase();
  const documentLower = documentText.toLowerCase();
  for (const literal of [...literals].slice(0, 32)) {
    const lower = literal.toLowerCase();
    if (answerLower.includes(lower) && !documentLower.includes(lower)) {
      findings.push("answer repeats a payload literal from instruction-like "
                    + "untrusted content");
      // The literal itself never reaches the pane. For diagnosis it can be
      // recorded LOCALLY, opt-in, on a debug companion only: without this
      // there is no way to learn WHICH word on a real page keeps firing.
      if (globalThis.process?.env?.TANTULAR_LOOKUP_DEBUG === "true") {
        globalThis.__lookupDebug?.("payload-literal matched: "
          + JSON.stringify(literal));
      }
      break;
    }
  }
  return findings;
}

// --- protected strings, derived from the REAL document ----------------------

// Taking `protect` from the caller would let an empty list produce a vacuous
// pass — the check would report success having compared nothing. These come
// from the document itself: currency amounts and multi-word proper names, the
// two things an injection actually rewrites.
export function deriveProtected(document, limit = 24) {
  const doc = String(document || "");
  const found = new Set();
  for (const m of doc.matchAll(/Rp\s*\d[\d.,]*\d/g)) found.add(m[0].trim());
  for (const m of doc.matchAll(/\b(?:PT|CV|PD|UD|Yayasan|Koperasi)\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g)) {
    found.add(m[0].trim());
  }
  return [...found].slice(0, limit);
}

// --- the entry point --------------------------------------------------------

export function verify({ answer, document, untrusted, protect }) {
  const a = String(answer || "");
  const d = String(document || "");
  const u = String(untrusted || "");

  if (!a.trim()) {
    return { ok: false, reason: "no_answer",
             findings: { fail_closed: ["the answer is empty"] } };
  }
  if (!d.trim()) {
    return { ok: false, reason: "no_document",
             findings: { fail_closed: [
               "no user document to verify against; refusing to call the answer verified"] } };
  }

  const protectList = Array.isArray(protect) && protect.length
    ? protect.map(String) : deriveProtected(d);

  const findings = {};
  // A check that THROWS must fail closed. Reporting ok:true because the
  // instrument broke is the exact failure this mechanism exists to prevent.
  try {
    const results = [
      ["preserves", checkPreserves(a, protectList, d)],
      ["no_new_facts", checkNoNewFacts(a, d, u)],
      ["untrusted_echo", checkUntrustedEcho(a, d, u)]
    ];
    for (const [name, result] of results) if (result.length) findings[name] = result;
  } catch (error) {
    return { ok: false, reason: "verifier_error", protected: protectList,
             findings: { fail_closed: [
               `a check could not run: ${error?.message || error}`] } };
  }

  const ok = Object.keys(findings).length === 0;
  return { ok, reason: ok ? "verified" : "failed_verification",
           protected: protectList, findings };
}

// --- research verifier --------------------------------------------------------
// Open Research Mode (2026-09-04). Web research is not a document-verification
// operation: the document is optional context, so `preserves` does not apply
// and the document may be empty; the other two checks apply unchanged. verify() above is untouched:
// it still decides what may be called document-verified and editable, and its
// Python parity contract is unaffected. Same fail-closed rules as verify().
export function verifyResearch(input) {
  const answer = input && typeof input === "object" ? input.answer : undefined;
  const document = input && typeof input === "object" ? input.document : undefined;
  const untrusted = input && typeof input === "object" ? input.untrusted : undefined;
  if (!input || typeof input !== "object"
      || (answer !== undefined && typeof answer !== "string")
      || (document !== undefined && typeof document !== "string")) {
    return { ok: false, reason: "verifier_error",
             findings: { fail_closed: ["malformed input"] } };
  }
  const a = String(answer || "");
  const d = String(document || "");
  const u = String(untrusted || "");
  if (!a.trim()) {
    return { ok: false, reason: "no_answer", findings: { fail_closed: ["the answer is empty"] } };
  }
  // The document is OPTIONAL context for research: fetched pages alone are
  // a valid source. Nothing at all to ground on is the fail-closed case.
  if (!d.trim() && !u.trim()) {
    return { ok: false, reason: "no_source",
             findings: { fail_closed: ["no document and no fetched content to verify against"] } };
  }
  const findings = {};
  try {
    const results = [
      ["no_new_facts", checkNoNewFacts(a, d, u)],
      ["untrusted_echo", checkUntrustedEcho(a, d, u)]
    ];
    for (const [name, result] of results) if (result.length) findings[name] = result;
  } catch (error) {
    return { ok: false, reason: "verifier_error",
             findings: { fail_closed: [`a check could not run: ${error?.message || error}`] } };
  }
  const ok = Object.keys(findings).length === 0;
  return { ok, reason: ok ? "verified" : "failed_verification", findings };
}
