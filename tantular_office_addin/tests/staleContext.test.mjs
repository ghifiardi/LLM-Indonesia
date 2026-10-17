// Stale-context behaviour: follow-ups after the source changes, edits during
// inference, and edits between preview and apply. chatPane.js itself cannot
// run under node:test, so these drive the pure modules it delegates to and
// then pin the wiring by reading the source (same pattern as
// chatPaneInsertActions.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHistory } from "../src/chat/history.js";
import { buildDocumentContextSnapshot, bodyRevision } from "../src/chat/contextBuilder.js";
import { prepareTurn } from "../src/chat/turn.js";
import { contextIsCurrent, applyIfCurrent } from "../src/chat/staleGuard.js";
import { deriveReferent, isAnaphoricFollowUp, askWhichMessage, parseChoice, ASK_REFERENT_MESSAGE } from "../src/chat/followUp.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function makeDoc(initial) {
  const doc = { body: initial };
  doc.read = async () => doc.body;
  doc.gather = async (mode) => {
    if (mode === "none") return { text: "", label: "none", kind: "none", scope: "none" };
    const snap = await buildDocumentContextSnapshot({ readBody: doc.read, query: "anggaran" });
    return { text: snap.text, label: "document", kind: "document", revision: snap.revision, scope: `document:${snap.revision}` };
  };
  return doc;
}

// Stand-in for the model request the pipelines would send.
const modelRequest = (turn, message) => JSON.stringify({ history: turn.priorMessages, context: turn.context.text, message });

test("100 -> 200: follow-up request has the current excerpt and not the prior 100 claim", async () => {
  const doc = makeDoc("Anggaran proyek: 100 juta.");
  const history = createHistory();
  const t1 = await prepareTurn({ message: "Berapa anggaran?", mode: "document", history, referent: null, readBody: doc.read, gather: doc.gather });
  assert.match(modelRequest(t1, "Berapa anggaran?"), /100 juta/);
  history.add("assistant", "Anggaran proyek adalah 100 juta.");

  doc.body = "Anggaran proyek: 200 juta.";
  const t2 = await prepareTurn({ message: "Apakah anggarannya naik?", mode: "document", history, referent: null, readBody: doc.read, gather: doc.gather });
  const req = modelRequest(t2, "Apakah anggarannya naik?");
  assert.match(req, /200 juta/);
  assert.doesNotMatch(req, /100/);
  assert.deepEqual(t2.priorMessages, []);
});

test("an unchanged document keeps the conversation", async () => {
  const doc = makeDoc("Anggaran proyek: 100 juta.");
  const history = createHistory();
  await prepareTurn({ message: "Berapa anggaran?", mode: "document", history, referent: null, readBody: doc.read, gather: doc.gather });
  history.add("assistant", "100 juta.");
  const t2 = await prepareTurn({ message: "Terima kasih, jelaskan lagi", mode: "document", history, referent: null, readBody: doc.read, gather: doc.gather });
  assert.equal(t2.priorMessages.length, 2);
});

test("edit during inference: the answer is discarded because the context is no longer current", async () => {
  const doc = makeDoc("Anggaran proyek: 100 juta.");
  const history = createHistory();
  const t = await prepareTurn({ message: "Berapa anggaran?", mode: "document", history, referent: null, readBody: doc.read, gather: doc.gather });
  const deps = { readBody: doc.read, readSelection: async () => "" };
  assert.equal(await contextIsCurrent(t.context, deps), true);
  doc.body = "Anggaran proyek: 200 juta."; // user types while the model streams
  assert.equal(await contextIsCurrent(t.context, deps), false);
});

test("selection context is stale when the selection changes during inference", async () => {
  const ctx = { kind: "selection", text: "kalimat lama" };
  assert.equal(await contextIsCurrent(ctx, { readBody: async () => "", readSelection: async () => "kalimat lama" }), true);
  assert.equal(await contextIsCurrent(ctx, { readBody: async () => "", readSelection: async () => "kalimat baru" }), false);
  assert.equal(await contextIsCurrent({ kind: "none" }, { readBody: async () => "x", readSelection: async () => "y" }), true);
});

test("edit between preview and apply: a stale preview is refused and nothing is applied", async () => {
  let body = "Tarif: 100 rupiah.";
  const expectedRevision = bodyRevision(body);
  let applied = 0;
  const apply = async () => { applied += 1; return [{ status: "applied" }]; };
  const ok = await applyIfCurrent({ expectedRevision, readBody: async () => body, apply });
  assert.equal(ok.stale, false);
  assert.equal(applied, 1);

  body = "Tarif: 200 rupiah.";
  const stale = await applyIfCurrent({ expectedRevision, readBody: async () => body, apply });
  assert.equal(stale.stale, true);
  assert.equal(applied, 1, "apply must not run for a stale preview");
});

test("a preview without a revision fails closed", async () => {
  let applied = 0;
  const r = await applyIfCurrent({ readBody: async () => "x", apply: async () => { applied += 1; return []; } });
  assert.equal(r.stale, true);
  assert.equal(applied, 0);
});

test("follow-up after an approved edit resolves to a verified span of the current document", async () => {
  const before = "Pendahuluan. Teks lama yang panjang sekali. Penutup.";
  const after = "Pendahuluan. Teks baru ringkas. Penutup.";
  const referent = deriveReferent([{ find: "Teks lama yang panjang sekali.", replace: "Teks baru ringkas." }], after);
  assert.deepEqual(referent, { texts: ["Teks baru ringkas."] });
  assert.notEqual(before, after);

  const doc = makeDoc(after);
  const history = createHistory();
  history.setScope(`document:${bodyRevision(before)}`);
  history.add("assistant", "Usulan lama");
  const t = await prepareTurn({ message: "sekarang buat lebih singkat", mode: "document", history, referent, readBody: doc.read, gather: doc.gather });
  assert.equal(t.kind, "ready");
  assert.equal(t.usedReferent, true);
  assert.equal(t.context.text, "Teks baru ringkas.");
  assert.deepEqual(t.priorMessages, []);
  assert.doesNotMatch(modelRequest(t, "x"), /Usulan lama|panjang sekali/);
});

test("follow-up asks instead of guessing when the referent cannot be verified", async () => {
  const referent = { texts: ["Teks baru ringkas."] };
  for (const body of ["Dokumen sudah ditulis ulang total.", "Teks baru ringkas. Teks baru ringkas."]) {
    const doc = makeDoc(body);
    const t = await prepareTurn({ message: "buat lebih singkat", mode: "document", history: createHistory(), referent, readBody: doc.read, gather: doc.gather });
    assert.equal(t.kind, "ask");
    assert.equal(t.message, ASK_REFERENT_MESSAGE);
  }
  const doc = makeDoc("Apa saja.");
  const none = await prepareTurn({ message: "buat itu lebih singkat", mode: "none", history: createHistory(), referent: null, readBody: doc.read, gather: doc.gather });
  assert.equal(none.kind, "ask");
});

test("a live selection is a valid referent and a self-contained question is not treated as a follow-up", async () => {
  const doc = makeDoc("Dokumen.");
  const sel = await prepareTurn({ message: "buat itu lebih singkat", mode: "selection", selectionText: "Paragraf terpilih.", history: createHistory(), referent: null, readBody: doc.read, gather: doc.gather });
  assert.equal(sel.kind, "ready");
  assert.equal(sel.context.text, "Paragraf terpilih.");
  assert.equal(isAnaphoricFollowUp("Berapa anggaran proyek ini?"), false);
  assert.equal(isAnaphoricFollowUp("Ringkas dokumen ini"), false);
  assert.equal(isAnaphoricFollowUp("buat lebih singkat"), true);
});

test("chatPane and wordEdits are wired to the guards", () => {
  const pane = read("src/chat/chatPane.js");
  const edits = read("src/chat/wordEdits.js");
  const guardAt = pane.indexOf("contextIsCurrent(context");
  assert.ok(guardAt > 0, "chatPane must re-check the context after inference");
  assert.ok(guardAt < pane.indexOf("renderChatMarkdown(answer, result.text)"), "check must precede rendering");
  assert.ok(guardAt < pane.indexOf("renderEditPreview({\n          container: els.messages,\n          edits: result.edits"), "check must precede the edit preview");
  assert.match(pane, /expectedRevision: result\.revision/);
  assert.match(pane, /error\?\.code === "DOCUMENT_CHANGED"/);
  assert.match(pane, /prepareTurn\(/);
  assert.ok(edits.indexOf("applyIfCurrent(") < edits.indexOf("apply: () => applyTrackedEdits(chosen)"));
  assert.doesNotMatch(edits.replace(/apply: \(\) => applyTrackedEdits\(chosen\)/, ""), /await applyTrackedEdits\(/);
});

test("an opener like 'sekarang' alone does not make a self-contained request a follow-up", async () => {
  const doc = makeDoc("Anggaran proyek: 100 juta.");
  const t = await prepareTurn({ message: "Sekarang ringkas dokumen ini", mode: "document", history: createHistory(), referent: null, readBody: doc.read, gather: doc.gather });
  assert.equal(t.kind, "ready");
  assert.match(t.context.text, /100 juta/);
  assert.equal(isAnaphoricFollowUp("Lalu jelaskan bab dua"), false);
  assert.equal(isAnaphoricFollowUp("Sekarang buat lebih singkat"), true);
  assert.equal(isAnaphoricFollowUp("sekarang buat itu lebih singkat"), true);
});

test("several edited spans: ask which one unless the user names a target or says both", async () => {
  const body = "Awal. Kalimat satu baru. Tengah. Kalimat dua baru. Akhir.";
  const referent = deriveReferent([{ replace: "Kalimat satu baru." }, { replace: "Kalimat dua baru." }], body);
  assert.equal(referent.texts.length, 2);
  const doc = makeDoc(body);
  const run = (message) => prepareTurn({ message, mode: "document", history: createHistory(), referent, readBody: doc.read, gather: doc.gather });

  const ask = await run("buat lebih singkat");
  assert.equal(ask.kind, "ask");
  assert.equal(ask.message, askWhichMessage(referent.texts));
  assert.match(ask.message, /Kalimat satu baru/);
  assert.match(ask.message, /Kalimat dua baru/);

  const named = await run('buat "Kalimat dua baru." lebih singkat');
  // Quoting the target makes it a self-contained request: no referent is
  // guessed, the model gets the document and the user's own quoted target.
  assert.equal(named.kind, "ready");
  assert.equal(named.usedReferent, false);
  // Naming it in a bare follow-up ("itu") resolves to exactly that span.
  const namedFollow = await run("buat itu lebih singkat: Kalimat dua baru.");
  assert.equal(namedFollow.kind, "ready");
  assert.equal(namedFollow.context.text, "Kalimat dua baru.");

  const both = await run("buat keduanya lebih singkat");
  assert.equal(both.kind, "ready");
  assert.equal(both.context.text, "Kalimat satu baru.\n\nKalimat dua baru.");

  // An active selection is an explicit target and bypasses the referent.
  const sel = await prepareTurn({ message: "buat lebih singkat", mode: "selection", selectionText: "Pilihan saya.", history: createHistory(), referent, readBody: doc.read, gather: doc.gather });
  assert.equal(sel.context.text, "Pilihan saya.");
});

test("'yang kedua' answers the pending 'which one?' with the original request and the verified second span", async () => {
  const body = "Awal. Kalimat satu baru. Tengah. Kalimat dua baru. Akhir.";
  const referent = deriveReferent([{ replace: "Kalimat satu baru." }, { replace: "Kalimat dua baru." }], body);
  const doc = makeDoc(body);
  const first = await prepareTurn({ message: "buat lebih singkat", mode: "document", history: createHistory(), referent, readBody: doc.read, gather: doc.gather });
  assert.equal(first.kind, "ask");
  assert.deepEqual(first.pending, { texts: referent.texts, originalMessage: "buat lebih singkat" });

  // chatPane keeps { ...pending, awaiting: true }; the reply is parsed against it.
  const pending = { texts: first.pending.texts, awaiting: true };
  for (const [reply, want] of [["yang kedua", 1], ["2", 1], ["Nomor 2 saja", 1], ["pertama", 0], ["(1)", 0], ["keduanya", "all"]]) {
    assert.equal(parseChoice(reply, 2), want, reply);
  }
  for (const reply of ["3", "yang ketiga", "buat lebih singkat yang kedua kalimatnya", "terima kasih"]) {
    assert.equal(parseChoice(reply, 2), null, reply);
  }
  const t = await prepareTurn({ message: first.pending.originalMessage, mode: "document", history: createHistory(), referent: pending, choice: parseChoice("yang kedua", 2), readBody: doc.read, gather: doc.gather });
  assert.equal(t.kind, "ready");
  assert.equal(t.context.text, "Kalimat dua baru.");
  const req = modelRequest(t, "buat lebih singkat");
  assert.match(req, /buat lebih singkat/);
  assert.doesNotMatch(req, /Kalimat satu baru|Awal\./);

  const all = await prepareTurn({ message: "buat lebih singkat", mode: "document", history: createHistory(), referent: pending, choice: "all", readBody: doc.read, gather: doc.gather });
  assert.equal(all.context.text, "Kalimat satu baru.\n\nKalimat dua baru.");

  // If the document changed meanwhile, the choice is not honoured.
  doc.body = "Dokumen ditulis ulang.";
  const stale = await prepareTurn({ message: "buat lebih singkat", mode: "document", history: createHistory(), referent: pending, choice: 1, readBody: doc.read, gather: doc.gather });
  assert.equal(stale.kind, "ask");
  assert.equal(stale.message, ASK_REFERENT_MESSAGE);
});

test("chatPane keeps the pending choice and replays the original request and intent", () => {
  const pane = read("src/chat/chatPane.js");
  assert.match(pane, /awaiting: true, originalMessage: turn\.pending\.originalMessage, intent/);
  assert.match(pane, /parseChoice\(typed, pending\.texts\.length\)/);
  assert.match(pane, /\? pending\.intent/);
});

// --- Word acceptance 2026-10-17: "buat lebih singkat" must shorten ----------
import { runPersingkat, isShortenRequest, NOT_SHORTER_MESSAGE } from "../src/chat/pipelines/persingkat.js";

test("persingkat prompt forbids bullets and never uses the RINGKAS 3-7 bullet prompt", async () => {
  let seen;
  const stream = async (args) => { seen = args; return { kind: "text", text: "Total anggaran 200 juta." }; };
  const source = "Total anggaran yang dialokasikan untuk pelaksanaan proyek ini adalah sebesar 200 juta rupiah.";
  const r = await runPersingkat({ instruction: "buat lebih singkat", contextText: source }, { stream });
  assert.equal(r.text, "Total anggaran 200 juta.");
  assert.match(seen.userText, /Jangan gunakan bullet/);
  assert.match(seen.userText, /Jangan menambah fakta/);
  assert.doesNotMatch(seen.userText, /3-7 bullet/);
  assert.ok(seen.userText.includes(source));
});

test("a 'shortening' that is not shorter is reported as a failure, not shown", async () => {
  const source = "Anggaran 200 juta.";
  const longer = async () => ({ kind: "text", text: "- Anggaran 200 juta\n- Batas maksimal pengeluaran\n- Sumber dana belum jelas" });
  assert.equal((await runPersingkat({ contextText: source }, { stream: longer })).text, NOT_SHORTER_MESSAGE);
  const same = async () => ({ kind: "text", text: source });
  assert.equal((await runPersingkat({ contextText: source }, { stream: same })).text, NOT_SHORTER_MESSAGE);
  assert.match((await runPersingkat({ contextText: "  " }, { stream: same })).text, /Pilih teks/);
});

test("only comparative shorten requests are rewritten; plain 'ringkas' stays RINGKAS", () => {
  for (const m of ["buat lebih singkat", "Sekarang buat itu lebih pendek", "persingkat itu", "make it shorter"]) {
    assert.equal(isShortenRequest(m), true, m);
  }
  for (const m of ["Ringkas teks yang saya pilih.", "Sekarang ringkas dokumen ini", "Berapa anggaran?"]) {
    assert.equal(isShortenRequest(m), false, m);
  }
});

test("chatPane routes bounded-span shorten requests to persingkat and clears the progress note", () => {
  const pane = read("src/chat/chatPane.js");
  assert.match(pane, /boundedSpan = turn\.usedReferent \|\| context\.kind === "selection"/);
  assert.match(pane, /boundedSpan && isShortenRequest\(message\) \? runPersingkat : getPipeline\(intent\)/);
  assert.match(pane, /busyNote\?\.remove\(\);\s*busyNote = null;/);
});
