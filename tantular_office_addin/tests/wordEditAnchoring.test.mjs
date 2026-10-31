// Regressions from Word testing on 2026-10-31:
//  1. An edit whose "find" spanned two paragraphs (~230 chars, with `$ACC` in
//     backticks) was offered by the preview but failed at apply with
//     "tidak ditemukan": apply refused anything over 250 chars and searched
//     Word for a string containing a paragraph mark, which Word never matches.
//  2. "Perbaiki bahasa" failed with "JSON edit dari model tidak bisa dibaca":
//     the reply hit max_tokens (done_reason "length") mid-JSON.
//  3. "Perbaiki bahasa" ran on the elaboration prompt and returned content
//     rewrites instead of minimal language fixes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EDIT_SYSTEM_PROMPT,
  LANGUAGE_FIX_SYSTEM_PROMPT,
  EDIT_TRUNCATED_MESSAGE,
  extractJsonObject,
  isLanguageFixRequest,
  isSubstantiveRewrite,
  parseEditContract,
  planWordAnchor,
  resolveEdits,
  WORD_SEARCH_MAX
} from "../src/chat/editContract.js";
import { applyTrackedEdits } from "../src/chat/wordEdits.js";

// Two paragraphs as Word's body.text reports them (paragraph mark = \r).
const P1 = "Variabel `$ACC` menyimpan nomer akun yang sedang di proses oleh modul validasi transaksi harian pada sistem pemantauan.";
const P2 = "Nilai tersebut kemudian di kirim ke server pusat untuk di analisa lebih lanjut oleh tim keamanan setiap pagi.";
const P3 = "Penutup laporan.";
const BODY = `${P1}\r${P2}\r${P3}`;
// The selection text the model saw (and copied into "find") uses \n.
const TWO_PARA_FIND = `${P1}\n${P2}`;

// Minimal Word mock with the two host limits that matter here: search
// strings over 255 chars throw, and a search string never matches across a
// paragraph mark. Hits are non-overlapping, like Word's.
function installWord(initialText) {
  const state = { text: initialText, searches: [] };
  class Range {
    constructor(start, end) { this.start = start; this.end = end; }
    get text() { return state.text.slice(this.start, this.end); }
    load() {}
    expandTo(other) { return new Range(Math.min(this.start, other.start), Math.max(this.end, other.end)); }
    insertText(value) {
      state.text = state.text.slice(0, this.start) + value + state.text.slice(this.end);
    }
  }
  const body = {
    get text() { return state.text; },
    load() {},
    search(raw) {
      state.searches.push(raw);
      if (raw.length > WORD_SEARCH_MAX) throw new Error("SearchStringInvalidOrTooLong");
      const needle = raw.replace(/\^\^/g, "^");
      const items = [];
      if (needle && !/[\r\n]/.test(needle)) {
        let i = state.text.indexOf(needle);
        while (i !== -1) {
          items.push(new Range(i, i + needle.length));
          i = state.text.indexOf(needle, i + needle.length);
        }
      }
      return { items, load() {} };
    }
  };
  globalThis.Word = {
    InsertLocation: { replace: "Replace" },
    ChangeTrackingMode: { trackAll: "TrackAll" },
    run: async (cb) => cb({ document: { body, load() {} }, sync: async () => {} })
  };
  globalThis.Office = { context: { requirements: { isSetSupported: () => false } } };
  return state;
}

test("fixture reproduces the reported shape: two paragraphs, ~230 chars, `$ACC` in backticks", () => {
  assert.ok(TWO_PARA_FIND.length > 220 && TWO_PARA_FIND.length < 255, `length ${TWO_PARA_FIND.length}`);
  assert.ok(TWO_PARA_FIND.includes("`$ACC`"));
});

test("a two-paragraph find is offered by the preview AND applied", async () => {
  const edit = { find: TWO_PARA_FIND, replace: `${P1.replace("nomer", "nomor")}\n${P2.replace("di kirim", "dikirim")}`, occurrence: 1 };
  const [preview] = resolveEdits(BODY, [edit]);
  assert.equal(preview.error, undefined, "preview must offer it");
  assert.ok(preview.plan.end, "a span crossing a paragraph needs a start and an end anchor");
  assert.ok(!/[\r\n]/.test(preview.plan.start.text) && !/[\r\n]/.test(preview.plan.end.text));

  const word = installWord(BODY);
  const [result] = await applyTrackedEdits([edit]);
  assert.equal(result.status, "applied");
  assert.ok(word.text.includes("nomor akun") && word.text.includes("dikirim ke server"));
  assert.ok(word.text.endsWith(P3));
  assert.ok(word.searches.every((s) => s.length <= WORD_SEARCH_MAX && !/[\r\n]/.test(s)));
});

test("a single paragraph longer than Word's 255-char search limit is reached by prefix + suffix and verified", async () => {
  const long = `${P1} ${P2} ${P1.replace("Variabel", "Selain itu variabel")}`;
  assert.ok(long.length > WORD_SEARCH_MAX);
  const body = `${long}\r${P3}`;
  const edit = { find: long, replace: long.replace("nomer", "nomor"), occurrence: 1 };
  assert.equal(resolveEdits(body, [edit])[0].error, undefined);
  const word = installWord(body);
  const [result] = await applyTrackedEdits([edit]);
  assert.equal(result.status, "applied");
  assert.ok(word.text.startsWith("Variabel `$ACC` menyimpan nomor akun"));
});

test("every edit the preview offers is one the apply step can apply", async () => {
  const edits = [
    { find: TWO_PARA_FIND, replace: "X", occurrence: 1 },
    { find: "`$ACC`", replace: "`$ACCOUNT`", occurrence: 1 },
    { find: "di analisa", replace: "dianalisis", occurrence: 1 },
    { find: `${P2}\n`, replace: `${P2.replace("di kirim", "dikirim")}\n`, occurrence: 1 }
  ];
  for (const edit of edits) {
    const [preview] = resolveEdits(BODY, [edit]);
    if (preview.error) continue;
    installWord(BODY);
    const [result] = await applyTrackedEdits([edit]);
    assert.equal(result.status, "applied", `offered but not applied: ${JSON.stringify(edit.find.slice(0, 40))}`);
  }
});

test("a trailing paragraph mark in find is left in place, not doubled", async () => {
  const edit = { find: `${P2}\n`, replace: `${P2.replace("di kirim", "dikirim")}\n`, occurrence: 1 };
  const word = installWord(BODY);
  const [result] = await applyTrackedEdits([edit]);
  assert.equal(result.status, "applied");
  assert.equal(word.text, `${P1}\r${P2.replace("di kirim", "dikirim")}\r${P3}`);
});

test("apply fails safe when the reached Word range does not equal the planned span", async () => {
  const [preview] = resolveEdits(BODY, [{ find: TWO_PARA_FIND, replace: "X", occurrence: 1 }]);
  // The document changed between paragraphs: anchors still hit, text differs.
  const changed = `${P1}\rKalimat sisipan.\r${P2}\r${P3}`;
  const word = installWord(changed);
  const { reachPlannedRange } = await import("../src/chat/wordEdits.js");
  const range = await Word.run((ctx) => reachPlannedRange(ctx, ctx.document, preview.plan));
  assert.equal(range, null);
  assert.equal(word.text, changed);
});

test("planWordAnchor escapes nothing it does not need to and keeps anchors under the limit", () => {
  const plan = planWordAnchor(BODY, 0, BODY.length, "");
  assert.ok(plan.start.text.length <= 200 && plan.end.text.length <= 200);
  assert.equal(plan.end.text, P3);
});

test("the context sent to the model is plain text: backticks are the document's own, matched literally", () => {
  // getSelectionContext uses Office.CoercionType.Text and the body comes from
  // body.text — neither produces markdown — so `$ACC` with backticks only
  // reaches the model if the document itself contains the backticks.
  const [r] = resolveEdits(BODY, [{ find: "`$ACC` menyimpan nomer", replace: "`$ACC` menyimpan nomor" }]);
  assert.equal(r.error, undefined);
});

// Tail of the real reply captured on 2026-10-31 (done_reason "length").
const TRUNCATED_REPLY = `{
"edits": [
{
"find": "sistem tetap memakai versi model yang lama.",
"replace": "infrastruktur sistem beralih secara bertahap.",
"before": "Proses kalibrasi ini memerlukan waktu sekitar dua hari kerja,",
"after": ".\\nKedepannya, perusahaan berencana",
"occurrence": 1,
"alasan": "Memperjelas prosedur transisi."
},
{
"find": "daftar sanksi internasional dan data reputasi perangkat pengguna`;

test("a reply cut off mid-JSON is reported as truncated, not as unreadable", () => {
  assert.equal(extractJsonObject(TRUNCATED_REPLY).truncated, true);
  assert.throws(() => parseEditContract(TRUNCATED_REPLY), (e) => e.code === "EDIT_JSON_TRUNCATED" && e.message === EDIT_TRUNCATED_MESSAGE);
});

test("finish_reason 'length' is authoritative even when the text happens to close", () => {
  const raw = JSON.stringify({ edits: [{ find: "a", replace: "b" }] });
  assert.throws(() => parseEditContract(raw, { finishReason: "length" }), /terpotong/);
  assert.equal(parseEditContract(raw, { finishReason: "stop" }).edits.length, 1);
});

test("a code fence, surrounding prose, and braces inside strings are tolerated", () => {
  const raw = 'Berikut usulannya:\n```json\n{"edits":[{"find":"{x}","replace":"{y}","alasan":"kurung } di string"}]}\n```\nSemoga membantu {:}';
  const { edits } = parseEditContract(raw);
  assert.equal(edits[0].find, "{x}");
});

test("plain prose with no JSON names that, not a parse error", () => {
  assert.throws(() => parseEditContract("Teks sudah benar."), (e) => e.code === "EDIT_JSON_MISSING");
});

test("Perbaiki bahasa uses the minimal language-fix prompt, not the elaboration prompt", () => {
  assert.equal(isLanguageFixRequest("Perbaiki bahasa teks yang saya pilih."), true);
  assert.equal(isLanguageFixRequest("perbaiki ejaan paragraf ini"), true);
  assert.equal(isLanguageFixRequest("Perbaiki bahasa dan elaborasi bagian ini"), false);
  assert.equal(isLanguageFixRequest("Elaborasi bagian ini"), false);
  assert.match(EDIT_SYSTEM_PROMPT, /elaborasi/i, "sanity: the general prompt is the one that allows expansion");
  assert.doesNotMatch(LANGUAGE_FIX_SYSTEM_PROMPT, /elaborasi|paragraf siap pakai|substantif|120-250 kata/i);
  assert.match(LANGUAGE_FIX_SYSTEM_PROMPT, /jangan menambah informasi/);
});

test("a content rewrite like the probe's Edit 1 is refused under Perbaiki bahasa", () => {
  const body = "Sistem ini di gunakan untuk memantau transaksi yang mencurigakan, dan seterusnya.";
  const edit1 = {
    find: "Sistem ini di gunakan untuk memantau transaksi yang mencurigakan",
    replace: "Sistem ini digunakan untuk memantau transaksi yang mencurigakan, mengintegrasikan aturan statis dan model pembelajaran mesin guna mendeteksi anomali secara real-time."
  };
  const fix = { find: "di gunakan", replace: "digunakan" };
  const [r1, r2] = resolveEdits(body, [edit1, fix], { languageFix: true });
  assert.equal(r1.error, "substantive");
  assert.equal(r2.error, undefined);
  assert.equal(isSubstantiveRewrite(fix.find, fix.replace), false);
  // The general edit flow still allows expansions.
  assert.equal(resolveEdits(body, [edit1])[0].error, undefined);
});

function installChatMocks(replies) {
  const requests = [];
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: reply.content }, finish_reason: reply.finish }],
        tantular_metrics: { completionTokens: reply.finish === "length" ? body.max_tokens : 50 }
      }),
      text: async () => ""
    };
  };
  return requests;
}

test("runEditTeks retries once with more room after a truncated reply, without chat history", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args);
  installWord(BODY);
  const requests = installChatMocks([
    { content: TRUNCATED_REPLY, finish: "length" },
    { content: JSON.stringify({ edits: [{ find: "di analisa", replace: "dianalisis", alasan: "ejaan" }] }), finish: "stop" }
  ]);
  try {
    const { runEditTeks } = await import("../src/chat/pipelines/editTeks.js");
    const out = await runEditTeks({ instruction: "Perbaiki bahasa teks yang saya pilih.", contextText: TWO_PARA_FIND });
    assert.equal(out.kind, "edits");
    assert.equal(out.edits[0].error, undefined);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].messages.length, 2, "system + one user turn: no history to truncate");
    assert.equal(requests[0].messages[0].content, LANGUAGE_FIX_SYSTEM_PROMPT);
    assert.ok(requests[1].max_tokens > requests[0].max_tokens);
    const log = warned.find((w) => String(w[0]).includes("edit contract parse failed"));
    assert.ok(log, "the raw reply and finish reason are logged");
    assert.equal(log[1].finishReason, "length");
    assert.equal(log[1].raw, TRUNCATED_REPLY);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("two truncated replies surface 'terpotong', not the generic unreadable error", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  installWord(BODY);
  installChatMocks([{ content: TRUNCATED_REPLY, finish: "length" }]);
  try {
    const { runEditTeks } = await import("../src/chat/pipelines/editTeks.js");
    await assert.rejects(
      runEditTeks({ instruction: "Perbaiki bahasa teks yang saya pilih.", contextText: TWO_PARA_FIND }),
      /terpotong/
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});
