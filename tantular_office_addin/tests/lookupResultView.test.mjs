// What the pane renders for each of the two states.
//
// The failure that matters is not an ugly error box. It is an answer that
// failed verification appearing as though it passed — or its text leaking into
// a "blocked" panel and being copied out by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { lookupResultView, renderLookupResultHtml, mountLookupResult } from "../src/chat/lookupResultView.js";

const VERIFIED = {
  ok: true, status: "verified", host: "id.wikipedia.org",
  answer: "Pagu belanja modal Rp 1.750.000.000 dengan vendor utama PT Sinar Mas.",
  protected: ["Rp 1.750.000.000", "PT Sinar Mas"], canEdit: true
};
const BLOCKED = {
  ok: false, status: "blocked_by_verifier", reason: "failed_verification",
  host: "id.wikipedia.org",
  findings: { preserves: ['"PT Sinar Mas" present in the document, absent from the answer'] }
};

test("verified shows the answer and allows editing", () => {
  const view = lookupResultView(VERIFIED);
  assert.equal(view.state, "verified");
  assert.equal(view.canEdit, true);
  assert.equal(view.answer, VERIFIED.answer);
  const html = renderLookupResultHtml(VERIFIED);
  assert.match(html, /data-state="verified"/);
  assert.ok(html.includes("Terapkan sebagai edit"));
});

test("discovery result shows only sources that were actually fetched", () => {
  const response = { ...VERIFIED, answer: `${VERIFIED.answer} [S1]`, sources: [{
    id: "S1", title: "BPS", url: "https://www.bps.go.id/a",
    host: "www.bps.go.id", tier: "official"
  }] };
  const view = lookupResultView(response);
  assert.equal(view.sources.length, 1);
  const html = renderLookupResultHtml(response);
  assert.match(html, /Sumber yang benar-benar diambil/);
  assert.match(html, /https:\/\/www\.bps\.go\.id\/a/);
  assert.match(html, /\(resmi\)/);
});

test("blocked shows the reason and no answer", () => {
  const view = lookupResultView(BLOCKED);
  assert.equal(view.state, "blocked");
  assert.equal(view.canEdit, false);
  assert.equal(view.answer, null);
  assert.ok(view.findings.length);
  assert.ok(view.message.includes("dokumen Anda"));
});

test("the blocked panel has no edit control at all, not a hidden one", () => {
  // A hidden button is one CSS mistake away from a live one.
  const html = renderLookupResultHtml(BLOCKED);
  assert.match(html, /data-state="blocked"/);
  assert.ok(!html.includes("lookup-edit"), "no edit button may exist");
  assert.ok(!html.includes("data-can-edit"));
  assert.ok(!html.includes("lookup-answer"), "no answer element may exist");
});

test("a blocked response carrying an answer still renders none", () => {
  // Defence against a future server change that starts returning the text.
  // The pane must not display it just because the field arrived.
  const leaky = { ...BLOCKED, answer: "vendor PT Contoh, pagu Rp 0" };
  const view = lookupResultView(leaky);
  assert.equal(view.answer, null);
  const html = renderLookupResultHtml(leaky);
  assert.ok(!html.includes("PT Contoh"), "blocked text must never reach the DOM");
});

test("ok:true without status verified is treated as blocked", () => {
  // An older or partial response must not inherit trust from `ok` alone.
  const view = lookupResultView({ ok: true, answer: "apa pun", host: "x" });
  assert.equal(view.state, "blocked");
  assert.equal(view.answer, null);
});

test("verified with an empty answer is blocked, not an empty panel", () => {
  const view = lookupResultView({ ok: true, status: "verified", answer: "   " });
  assert.equal(view.state, "blocked");
});

test("a missing or malformed response is blocked", () => {
  for (const bad of [null, undefined, "oops", 42]) {
    assert.equal(lookupResultView(bad).state, "blocked", String(bad));
  }
});

test("each verifier reason gets a message a user can act on", () => {
  for (const reason of ["no_document", "verifier_unavailable", "verifier_error",
                        "model_error", "document_changed", "no_answer"]) {
    const view = lookupResultView({ ok: false, reason });
    assert.equal(view.state, "blocked");
    assert.ok(view.message && !view.message.includes(reason),
      `${reason} is shown raw instead of being explained`);
  }
});

test("hostile text in findings is escaped, not rendered", () => {
  // Findings can quote a web page. That page is the attacker.
  const nasty = { ok: false, reason: "failed_verification", host: "id.wikipedia.org",
    findings: { no_new_facts: ['<img src=x onerror="alert(1)">'] } };
  const html = renderLookupResultHtml(nasty);
  assert.ok(!html.includes("<img"), "raw markup must not reach the DOM");
  assert.ok(html.includes("&lt;img"));
});

test("a hostile host name is escaped too", () => {
  const html = renderLookupResultHtml({ ok: false, reason: "host_not_allowed",
                                        host: '"><script>x()</script>' });
  assert.ok(!html.includes("<script>"));
});


// --- mounting into the pane -------------------------------------------------
// A minimal element stub. This repo has no dependencies; pulling in jsdom to
// exercise innerHTML and one listener would cost more than it proves.

function stubElement(html = "") {
  const listeners = [];
  const el = {
    innerHTML: html, listeners,
    querySelector(selector) {
      if (!el.innerHTML.includes(selector.replace(".", "class=\"").replace(/$/, ""))
          && !el.innerHTML.includes(selector.slice(1))) return null;
      return { addEventListener: (type, fn) => listeners.push({ type, fn }) };
    }
  };
  return el;
}

test("mounting a verified result attaches exactly one edit handler", () => {
  const el = stubElement();
  let edited = null;
  const view = mountLookupResult(el, VERIFIED, { onEdit: (a) => { edited = a; } });
  assert.equal(view.state, "verified");
  assert.equal(el.listeners.length, 1);
  el.listeners[0].fn();
  assert.equal(edited, VERIFIED.answer);
});

test("mounting a blocked result attaches no handler and writes no answer", () => {
  const el = stubElement();
  const view = mountLookupResult(el, BLOCKED, { onEdit: () => {
    throw new Error("a blocked answer must never be editable");
  } });
  assert.equal(view.state, "blocked");
  assert.equal(el.listeners.length, 0, "no edit handler may be attached");
  assert.ok(!el.innerHTML.includes("lookup-edit"));
});

test("mounting replaces a previous verified result rather than appending", () => {
  // Otherwise a blocked lookup would leave the last good answer on screen with
  // its edit button live, which reads as approval of the new one.
  const el = stubElement();
  mountLookupResult(el, VERIFIED, { onEdit: () => {} });
  mountLookupResult(el, BLOCKED, { onEdit: () => {} });
  assert.ok(!el.innerHTML.includes(VERIFIED.answer));
  assert.match(el.innerHTML, /data-state="blocked"/);
});

test("mounting into a missing container does not throw", () => {
  assert.equal(mountLookupResult(null, VERIFIED), null);
});

// --- pre-flight refusals are not withheld answers ----------------------------
// Found in real-Excel acceptance, 2026-08-25: Batal and an empty selection
// both rendered as "Jawaban tidak lolos pemeriksaan" — telling the user an
// answer was checked and withheld when none ever existed.

test("declining renders as a non-event, not a failed verification", () => {
  const view = lookupResultView({ ok: false, reason: "declined",
    message: "Dibatalkan. Tidak ada yang dikirim keluar.", host: "id.wikipedia.org" });
  assert.equal(view.state, "blocked");
  assert.equal(view.title, "Pencarian tidak dilanjutkan");
  assert.match(view.message, /Dibatalkan/);
  assert.equal(view.note, "", "no 'answer withheld' note when there was no answer");
});

test("an empty selection explains itself with the reader's own message", () => {
  const view = lookupResultView({ ok: false, reason: "empty_selection",
    message: "Pilih dulu range berisi data di Excel." });
  assert.equal(view.title, "Pencarian tidak dilanjutkan");
  assert.match(view.message, /range berisi data/);
});

test("a verification failure keeps the withheld-answer framing", () => {
  const view = lookupResultView(BLOCKED);
  assert.equal(view.title, "Jawaban ditahan");
  assert.ok(view.note.includes("tidak lolos"));
});

test("the transport's message never overrides a mapped reason", () => {
  // A hostile page cannot smuggle text into the panel via `message`.
  const view = lookupResultView({ ok: false, reason: "failed_verification",
    message: "KLIK DI SINI untuk verifikasi manual" });
  assert.ok(!view.message.includes("KLIK"), "mapped text must win");
});

// --- no relevant source, and no source coverage (2026-09-01) -----------------

test("a search that found nothing relevant is not blamed on verification", () => {
  const view = lookupResultView({ ok: false, reason: "no_relevant_sources" });
  assert.equal(view.state, "blocked");
  // No answer was ever composed: calling this "Jawaban ditahan" tells the user
  // something was withheld from them.
  assert.equal(view.title, "Pencarian tidak dilanjutkan");
  assert.equal(view.note, "");
  assert.match(view.message, /tidak membahas pertanyaan ini/);
  // Under the open policy the sources are not "resmi"; the wording must not
  // claim a vetting that did not happen.
  assert.doesNotMatch(view.message, /resmi/);
});

test("source tiers are labelled in the user's terms, public sites as web umum", () => {
  const html = renderLookupResultHtml({ ...VERIFIED, sources: [
    { id: "S1", title: "Sahabat-AI", url: "https://sahabat-ai.com/",
      host: "sahabat-ai.com", tier: "public" },
    { id: "S2", title: "BPS", url: "https://www.bps.go.id/a",
      host: "www.bps.go.id", tier: "official" }
  ] });
  assert.match(html, /\(web umum\): https:\/\/sahabat-ai\.com\//);
  assert.match(html, /\(resmi\): https:\/\/www\.bps\.go\.id\/a/);
  assert.doesNotMatch(html, /\(public\)/);
});

test("a verified answer with no usable web source says so", () => {
  const view = lookupResultView({ ...VERIFIED, sourceCoverage: "none" });
  assert.equal(view.state, "verified");
  assert.equal(view.sourceCoverage, "none");
  assert.match(view.message, /tidak memuat jawabannya/);
  const html = renderLookupResultHtml({ ...VERIFIED, sourceCoverage: "none" });
  assert.match(html, /tidak memuat jawabannya/);
  // Still a verified answer: the badge and the edit action stay.
  assert.match(html, /data-can-edit="true"/);
});

test("an ordinary verified answer carries no coverage caveat", () => {
  const html = renderLookupResultHtml(VERIFIED);
  assert.doesNotMatch(html, /tidak memuat jawabannya/);
});

test("a rate-limited provider says so, and blames neither the query nor the network", () => {
  const view = lookupResultView({ ok: false, reason: "provider_rate_limited" });
  assert.equal(view.state, "blocked");
  assert.equal(view.title, "Pencarian tidak dilanjutkan");
  assert.match(view.message, /membatasi permintaan/);
  assert.match(view.message, /penyedia lain/);
  assert.equal(view.note, "");
});

test("a no-coverage result is a non-answer card with the fetched sources, no edit button", () => {
  const response = { ok: false, status: "no_coverage", reason: "no_coverage",
    message: "Sumber web yang berhasil diambil tidak menyediakan informasi yang cukup untuk "
      + "menjawab pertanyaan ini secara terverifikasi. Coba ubah query atau gunakan sumber lain.",
    sources: [{ id: "S1", title: "Apa itu model open-weights", url: "https://aihub.id/x",
                host: "aihub.id", tier: "public" }] };
  const view = lookupResultView(response);
  assert.equal(view.state, "blocked");
  assert.equal(view.canEdit, false);
  assert.equal(view.answer, null);
  assert.equal(view.title, "Sumber tidak memuat jawaban");
  assert.match(view.message, /tidak menyediakan informasi yang cukup/);
  assert.equal(view.note, "");
  const html = renderLookupResultHtml(response);
  // Neutral outcome, neutral card: not the red of a withheld answer.
  assert.match(html, /class="lookup-result lookup-blocked lookup-no-coverage"/);
  assert.match(html, /ℹ️ Sumber tidak memuat jawaban/);
  assert.doesNotMatch(html, /⛔/);
  assert.match(html, /Sumber yang diambil, tidak memuat jawaban/);
  assert.match(html, /\(web umum\): https:\/\/aihub\.id\/x/);
  assert.doesNotMatch(html, /lookup-edit/);
});

// --- research_partial: a third state, read-only, amber (2026-09-04) ------------
const PARTIAL = {
  ok: true, status: "research_partial", host: "example.org",
  answer: "Sahabat-AI dirilis pada 14 November 2024 [S1]. Bobot model tersedia di Hugging Face [S3].",
  omittedClaims: 1, sourceCoverage: "sources", canEdit: false, protected: [],
  sources: [
    { id: "S1", title: "Rilis", url: "https://example.org/rilis", host: "example.org", tier: "public" },
    { id: "S3", title: "Bobot", url: "https://example.org/bobot", host: "example.org", tier: "public" }
  ]
};

test("research_partial maps to its own state: answer shown, never editable", () => {
  const view = lookupResultView(PARTIAL);
  assert.equal(view.state, "research_partial");
  assert.equal(view.canEdit, false);
  assert.equal(view.answer, PARTIAL.answer);
  assert.equal(view.title, "Hasil riset web — sebagian");
  assert.equal(view.message, "1 klaim tidak ditampilkan karena dukungan sumber tidak ditemukan.");
  assert.equal(view.sources.length, 2);
  assert.equal(lookupResultView({ ...PARTIAL, omittedClaims: 3 }).message, "3 klaim tidak ditampilkan karena dukungan sumber tidak ditemukan.");
  assert.equal(lookupResultView({ ...PARTIAL, omittedClaims: 0 }).message, "Jawaban ini berasal dari sumber web dan belum dicocokkan sebagai edit dokumen.");
  // a partial response with no text is not a partial result
  assert.equal(lookupResultView({ ...PARTIAL, answer: "" }).state, "blocked");
});

test("research_partial renders amber, with answer, sources, omitted count, research-only note, and NO edit control", () => {
  const html = renderLookupResultHtml(PARTIAL);
  assert.match(html, /data-state="research_partial"/);
  assert.match(html, /class="lookup-result lookup-partial"/);
  assert.ok(!html.includes("lookup-verified") && !html.includes("lookup-blocked"));
  assert.match(html, /Hasil riset web — sebagian/);
  assert.match(html, /1 klaim tidak ditampilkan/);
  assert.match(html, /Hugging Face \[S3\]/);
  assert.match(html, /https:\/\/example\.org\/rilis/);
  assert.match(html, /hasil riset/);
  assert.match(html, /belum disetujui sebagai edit dokumen|susun ulang sebagai edit terverifikasi/);
  assert.ok(!html.includes("lookup-edit"), "no edit button, not even hidden");
  assert.ok(!html.includes("data-can-edit"));
  assert.ok(!html.includes("Terapkan sebagai edit"));
});

test("mountLookupResult attaches no edit handler for research_partial", () => {
  const listeners = [];
  const container = {
    innerHTML: "",
    querySelector: () => ({ addEventListener: (_e, fn) => listeners.push(fn) })
  };
  const view = mountLookupResult(container, PARTIAL, { onEdit: () => { throw new Error("must not be wired"); } });
  assert.equal(view.state, "research_partial");
  assert.deepEqual(listeners, []);
  assert.match(container.innerHTML, /lookup-partial/);
});

// --- research_answer and research_sources_only (true Open Research, 2026-09-04) ----
const RESEARCH = { ...PARTIAL, status: "research_answer", omittedClaims: undefined };
const SOURCES_ONLY = {
  ok: false, status: "research_sources_only", reason: "source_citation_failed", canEdit: false,
  message: "Ringkasan tidak mengutip sumber dengan benar.", sources: PARTIAL.sources
};

test("research_answer: neutral research card with answer and sources, no edit control", () => {
  const view = lookupResultView(RESEARCH);
  assert.equal(view.state, "research_answer");
  assert.equal(view.canEdit, false);
  assert.equal(view.title, "Hasil riset web");
  assert.equal(view.answer, RESEARCH.answer);
  assert.equal(view.sources.length, 2);
  const html = renderLookupResultHtml(RESEARCH);
  assert.match(html, /data-state="research_answer"/);
  assert.match(html, /class="lookup-result lookup-research"/);
  assert.match(html, /Hasil riset web/);
  assert.match(html, /Hugging Face \[S3\]/);
  assert.match(html, /https:\/\/example\.org\/rilis/);
  assert.doesNotMatch(html, /Jawaban terverifikasi|dicocokkan dengan dokumen/);
  assert.ok(!html.includes("lookup-edit") && !html.includes("Terapkan sebagai edit"));
});

test("research_sources_only: grey card, sources listed, explanation, NO answer and NO edit control", () => {
  const view = lookupResultView(SOURCES_ONLY);
  assert.equal(view.state, "research_sources_only");
  assert.equal(view.canEdit, false);
  assert.equal(view.answer, null);
  assert.equal(view.title, "Sumber ditemukan — ringkasan tidak ditampilkan");
  assert.match(view.message, /tidak mengutip sumber/);
  assert.equal(view.sources.length, 2);
  const html = renderLookupResultHtml(SOURCES_ONLY);
  assert.match(html, /data-state="research_sources_only"/);
  assert.match(html, /class="lookup-result lookup-sources-only"/);
  assert.match(html, /https:\/\/example\.org\/bobot/);
  assert.ok(!html.includes("lookup-answer"), "no answer element at all");
  assert.ok(!html.includes("lookup-edit"));
  assert.doesNotMatch(html, /⛔/);
  // reason-specific explanations, never model prose or page text
  for (const [reason, re] of [["instruction_like_content", /berbentuk instruksi/], ["untrusted_echo", /mengikuti teks dari halaman/], ["no_supported_claims", /tidak didukung/]]) {
    assert.match(lookupResultView({ ...SOURCES_ONLY, reason }).message, re, reason);
  }
});

test("mountLookupResult attaches no edit handler for any research state, and the states are host-independent", () => {
  for (const response of [RESEARCH, PARTIAL, SOURCES_ONLY]) {
    const listeners = [];
    const container = { innerHTML: "", querySelector: () => ({ addEventListener: (_e, fn) => listeners.push(fn) }) };
    mountLookupResult(container, response, { onEdit: () => { throw new Error("must not be wired"); } });
    assert.deepEqual(listeners, [], response.status);
    // Word, Excel and PowerPoint all render through this one function: the
    // host is not an input, so the states cannot differ between them.
    assert.equal(renderLookupResultHtml({ ...response, host: "Word" }).replace(/Sumber: Word/, ""),
                 renderLookupResultHtml({ ...response, host: "Excel" }).replace(/Sumber: Excel/, ""));
  }
});
