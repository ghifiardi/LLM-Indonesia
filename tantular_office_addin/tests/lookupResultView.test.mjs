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
  assert.match(html, /official/);
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
