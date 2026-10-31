// Confirmation gate for the agentic PowerPoint chat.
//
// THE LIVE DEFECT this covers: the quick chip "Ringkas isi deck ini" — a
// QUESTION — made the local 9B emit replace_slide for slides 1..7, and the
// executor applied all seven to the user's real deck. Prompt wording had already
// told the model to return empty actions when asked a question and was ignored,
// so the guarantee now lives in code: planning never writes, and every deck
// mutation waits for one confirmation.
//
// Everything here is PURE — no Office mocks, no model calls.

import test from "node:test";
import assert from "node:assert/strict";
import {
  executeConfirmedPptPlan,
  executePptActions,
  needsPptConfirmation,
  PPT_CHAT_BUILD,
  summarizePendingChanges,
  describePendingChange,
  resolveDeleteTarget
} from "../src/chat/pptTools.js";

const CTX = {
  source: "extractor",
  slides: [
    { index: 1, id: "256", title: "Judul deck", text: "Judul deck\nSubjudul" },
    { index: 2, id: "257", title: "Latar belakang", text: "Latar belakang\nSatu\nDua\nTiga" },
    { index: 3, id: "258", title: "Angka kunci", text: "Angka kunci\n92%\n41 mitra" },
    { index: 4, id: "259", title: "Penutup", text: "Penutup\nTerima kasih" }
  ]
};

const bullets = (headline) => ({ type: "bullets", headline, bullets: ["a", "b"] });

test("a question plans nothing, writes nothing, and asks for no confirmation", () => {
  const result = executePptActions([], CTX);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.pending, []);
  assert.equal(needsPptConfirmation(result.pending), false);
  assert.equal(needsPptConfirmation(undefined), false);
});

test("a single write is planned, not applied, and requires confirmation", () => {
  const { lines, pending, summary } = executePptActions(
    [{ op: "improve_slide", slideIndex: 2, instruction: "buat lebih ringkas" }],
    CTX
  );
  assert.deepEqual(lines, []);
  assert.equal(pending.length, 1);
  assert.equal(needsPptConfirmation(pending), true);
  // The descriptor carries what the confirmed write needs: live-resolvable id,
  // the snapshot text the user was shown, and the per-slide intent.
  assert.deepEqual(
    { op: pending[0].op, slideIndex: pending[0].slideIndex, id: pending[0].id, instruction: pending[0].instruction },
    { op: "improve_slide", slideIndex: 2, id: "257", instruction: "buat lebih ringkas" }
  );
  assert.match(pending[0].text, /Latar belakang/);
  assert.equal(summary.count, 1);
  assert.equal(summary.confirmLabel, "Terapkan 1 perubahan");
  assert.deepEqual(summary.lines, ['Perbaiki slide 2 ("Latar belakang") — teks ditulis ulang, desain slide dipertahankan']);
});

test("THE LIVE DEFECT: seven replace_slide from a question are only a plan, and the summary names every slide", () => {
  const actions = [1, 2, 3, 4].map((slideIndex) => ({
    op: "replace_slide", slideIndex, slide: bullets(`Ringkasan ${slideIndex}`)
  }));
  const { lines, pending } = executePptActions(actions, CTX);
  // Nothing reported as done, because nothing was done.
  assert.deepEqual(lines, []);
  assert.equal(pending.length, 4);
  assert.ok(!pending.some((entry) => entry.applied));

  const summary = summarizePendingChanges(pending);
  assert.equal(summary.count, 4);
  assert.deepEqual(summary.slideNumbers, [1, 2, 3, 4]);
  assert.match(summary.headline, /MENGUBAH deck ini/);
  assert.match(summary.headline, /4 slide yang sudah ada \(slide 1, 2, 3, 4\)/);
  assert.match(summary.headline, /Tidak ada undo/);
  assert.equal(summary.confirmLabel, "Terapkan 4 perubahan");
  // Read low-to-high, the way the user reads the deck, and each line says which
  // slide and what it costs.
  assert.deepEqual(summary.lines, [
    'Ganti slide 1 ("Judul deck") — seluruh isi lama hilang',
    'Ganti slide 2 ("Latar belakang") — seluruh isi lama hilang',
    'Ganti slide 3 ("Angka kunci") — seluruh isi lama hilang',
    'Ganti slide 4 ("Penutup") — seluruh isi lama hilang'
  ]);
});

test("a mixed turn including a delete produces one confirmation covering all four verbs", () => {
  const { pending } = executePptActions([
    { op: "improve_slide", slideIndex: 2 },
    { op: "replace_slide", slideIndex: 3, slide: bullets("Angka baru") },
    { op: "add_slide", afterIndex: 1, slide: bullets("Ikhtisar") },
    { op: "delete_slide", slideIndex: 4 }
  ], CTX);

  assert.equal(needsPptConfirmation(pending), true);
  const summary = summarizePendingChanges(pending);
  assert.equal(summary.count, 4);
  // An insert does not destroy an existing slide, so it is counted separately
  // instead of being smuggled into the "slides that change" number.
  assert.deepEqual(summary.slideNumbers, [2, 3, 4]);
  assert.equal(summary.inserts, 1);
  assert.match(summary.headline, /3 slide yang sudah ada \(slide 2, 3, 4\) dan 1 slide baru/);
  assert.deepEqual(summary.lines, [
    'Tambah slide baru "Ikhtisar" setelah slide 1',
    'Perbaiki slide 2 ("Latar belakang") — teks ditulis ulang, desain slide dipertahankan',
    'Ganti slide 3 ("Angka kunci") — seluruh isi lama hilang',
    'Hapus slide 4 ("Penutup")'
  ]);
  // Deletes keep their own descriptor shape: id first, title for the stale check.
  const del = pending.find((entry) => entry.op === "delete_slide");
  assert.deepEqual({ id: del.id, title: del.title }, { id: "259", title: "Penutup" });
});

test("execution order stays highest-index-first even though the summary reads low-to-high", () => {
  const { pending } = executePptActions([
    { op: "replace_slide", slideIndex: 1, slide: bullets("Satu") },
    { op: "replace_slide", slideIndex: 3, slide: bullets("Tiga") },
    { op: "add_slide", afterIndex: 3, slide: bullets("Sisipan") }
  ], CTX);
  // add before replace on the same anchor (the anchor id must still exist), and
  // the highest index first so earlier writes never shift a later target.
  assert.deepEqual(
    pending.map((entry) => `${entry.op}@${entry.slideIndex}`),
    ["add_slide@3", "replace_slide@3", "replace_slide@1"]
  );
  assert.deepEqual(summarizePendingChanges(pending).lines.map((line) => line.slice(0, 5)),
    ["Ganti", "Tamba", "Ganti"]);
});

test("an action that cannot be planned at all reports honestly and never becomes pending", () => {
  const { lines, pending } = executePptActions([
    { op: "replace_slide", slideIndex: 9, slide: bullets("Hantu") },
    { op: "improve_slide", slideIndex: 1 }
  ], { slides: [{ index: 1, id: "256", title: "Kosong", text: "" }] });
  assert.deepEqual(pending, []);
  assert.equal(needsPptConfirmation(pending), false);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.startsWith("❌")));
  assert.match(lines.join("\n"), /tidak ada di snapshot deck/);
  assert.match(lines.join("\n"), /tidak punya teks yang bisa dibaca/);
});

test("an add_slide anchored on an id-less slide is refused at plan time, not half-applied", () => {
  const { lines, pending } = executePptActions(
    [{ op: "add_slide", afterIndex: 1, slide: bullets("Baru") }],
    { slides: [{ index: 1, id: "", title: "Judul", text: "Judul" }] }
  );
  assert.deepEqual(pending, []);
  assert.match(lines[0], /tidak punya id/);
});

test("every confirmed write — not only a delete — is re-resolved against the LIVE deck", () => {
  // The deck can be reordered between plan and confirm. Id-first resolution
  // finds the approved slide at its new position...
  const moved = resolveDeleteTarget(["259", "256", "257", "258"], {
    op: "replace_slide", slideIndex: 3, id: "258", title: "Angka kunci"
  });
  assert.deepEqual({ ok: moved.ok, id: moved.id, index: moved.index }, { ok: true, id: "258", index: 4 });

  // ...and refuses rather than rewriting whatever now sits at that position.
  const gone = resolveDeleteTarget(["256", "257"], {
    op: "replace_slide", slideIndex: 3, id: "258", title: "Angka kunci"
  });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /Deck sudah berubah sejak penggantian diusulkan/);
  assert.match(gone.reason, /Tidak ada yang diubah/);

  // The delete wording is unchanged for deletes.
  const deleted = resolveDeleteTarget(["256"], { op: "delete_slide", id: "258", title: "Angka kunci" });
  assert.match(deleted.reason, /sejak penghapusan diusulkan/);
});

test("describePendingChange survives an unknown op instead of printing undefined", () => {
  assert.equal(describePendingChange({ op: "warp_slide", slideIndex: 2 }), "warp_slide pada slide 2");
  assert.equal(describePendingChange({ op: "add_slide", slideIndex: 1 }),
    'Tambah slide baru "tanpa judul" setelah slide 1');
  assert.equal(summarizePendingChanges(null).count, 0);
});

// --- Id-less destructive targets -----------------------------------------
// resolveDeleteTarget is ALLOWED to fall back to position when a descriptor
// carries no id (that is its own, separately tested contract). But a pending
// descriptor with id "" would reach the confirmed write with no staleness
// detection at all — the exact damage class the confirmation exists to prevent.
// So an id-less target is refused at PLAN time for the destructive ops too, the
// way an id-less add_slide anchor already was.
const IDLESS_CTX = { slides: [{ index: 1, id: "", title: "Judul", text: "Judul\nSatu\nDua" }] };
const WITH_ID_CTX = { slides: [{ index: 1, id: "256", title: "Judul", text: "Judul\nSatu\nDua" }] };

for (const action of [
  { op: "replace_slide", slideIndex: 1, slide: bullets("Baru") },
  { op: "improve_slide", slideIndex: 1 },
  { op: "delete_slide", slideIndex: 1 }
]) {
  test(`${action.op} on an id-less slide is refused at plan time and never becomes pending`, () => {
    const { lines, pending } = executePptActions([action], IDLESS_CTX);
    assert.deepEqual(pending, []);
    assert.equal(needsPptConfirmation(pending), false);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("❌"));
    assert.match(lines[0], /tidak punya id/);

    // The same action on a slide that DOES have an id still plans normally.
    const planned = executePptActions([action], WITH_ID_CTX);
    assert.deepEqual(planned.lines, []);
    assert.equal(planned.pending.length, 1);
    assert.equal(planned.pending[0].id, "256");
  });
}

// --- The confirmed write path --------------------------------------------
// executeConfirmedPptPlan is the only code in this add-in that mutates a real
// deck, and there is no undo. The four Office-touching calls come in through
// `hooks` (defaulting to the real officeClient functions), so the whole path can
// be driven with plain functions — no Office mocks, no model calls, no mocking
// library. improve_slide is deliberately absent here: it calls the local model.
function fakeDeck(liveIds, outcomes = {}) {
  const calls = [];
  const hooks = {
    readLiveIds: () => liveIds.slice(),
    deleteSlides: (ids) => {
      calls.push(`delete:${ids.join(",")}`);
      return outcomes.delete === false ? { deleted: false, reason: "gagal" } : { deleted: true };
    },
    replaceSlide: (_base64, options) => {
      calls.push(`replace:${options.slideId}`);
      return outcomes.replace === false ? { replaced: false, reason: "gagal" } : { replaced: true };
    },
    insertSlideAfter: (_base64, options) => {
      calls.push(`insert:${options.slideId}`);
      return outcomes.insert === false
        ? { inserted: false, deckChanged: false, reason: "gagal" }
        : { inserted: true };
    },
    readSlideShapes: () => ({ found: true, shapes: [{ name: "Title 1", text: "Judul" }, { name: "Content Placeholder 2", text: "Satu\nDua" }] }),
    writeShapeTexts: (options) => {
      calls.push(`update:${options.slideId}`);
      return { updated: true };
    }
  };
  return { calls, hooks };
}

const PLAN_ACTIONS = [
  { op: "replace_slide", slideIndex: 2, slide: bullets("Ganti") },
  { op: "delete_slide", slideIndex: 3 },
  { op: "add_slide", afterIndex: 1, slide: bullets("Baru") }
];
const LIVE_IDS = ["256", "257", "258", "259"];

test("a plan that is never confirmed performs ZERO writes", async () => {
  const { calls } = fakeDeck(LIVE_IDS);
  const { pending } = executePptActions(PLAN_ACTIONS, CTX);
  assert.equal(pending.length, 3);
  assert.equal(needsPptConfirmation(pending), true);
  // Planning alone touched nothing, and the write path was never entered.
  assert.deepEqual(calls, []);
});

test("a confirmed plan performs exactly the expected writes, in the expected order", async () => {
  const { calls, hooks } = fakeDeck(LIVE_IDS);
  const { pending } = executePptActions(PLAN_ACTIONS, CTX);
  const { lines } = await executeConfirmedPptPlan(pending, hooks);
  // Highest index first (mutating slide N shifts everything after it), and the
  // insert runs against its anchor id.
  assert.deepEqual(calls, ["delete:258", "replace:257", "insert:256"]);
  assert.equal(lines.filter((line) => line.startsWith("✅")).length, 3);
  assert.equal(lines[lines.length - 1], `(${PPT_CHAT_BUILD})`);
});

test("an action whose id is gone from the live deck writes nothing while the rest still run", async () => {
  // Slide 257 (the replace target) was removed by hand between plan and confirm.
  const { calls, hooks } = fakeDeck(["256", "258", "259"]);
  const { pending } = executePptActions(PLAN_ACTIONS, CTX);
  const { lines } = await executeConfirmedPptPlan(pending, hooks);
  assert.deepEqual(calls, ["delete:258", "insert:256"]);
  const refused = lines.filter((line) => line.startsWith("❌"));
  assert.equal(refused.length, 1);
  assert.match(refused[0], /Deck sudah berubah sejak penggantian diusulkan/);
  assert.equal(lines.filter((line) => line.startsWith("✅")).length, 2);
});

test("an aborted signal performs no writes at all", async () => {
  const { calls, hooks } = fakeDeck(LIVE_IDS);
  const { pending } = executePptActions(PLAN_ACTIONS, CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, signal: { aborted: true } });
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⏹ Dihentikan oleh pengguna; 3 aksi berikutnya tidak dijalankan\./);
  assert.ok(!lines.includes(`(${PPT_CHAT_BUILD})`));
});

test("the build tag is stamped only when at least one write actually succeeded", async () => {
  // Every action refused (the whole deck moved): nothing was written, so no tag.
  const gone = fakeDeck(["900", "901"]);
  const { pending } = executePptActions(PLAN_ACTIONS, CTX);
  const refusedRun = await executeConfirmedPptPlan(pending, gone.hooks);
  assert.deepEqual(gone.calls, []);
  assert.equal(refusedRun.lines.length, 3);
  assert.ok(refusedRun.lines.every((line) => line.startsWith("❌")));
  assert.ok(!refusedRun.lines.includes(`(${PPT_CHAT_BUILD})`));

  // Reached the host but every write failed there: still not a write.
  const failed = fakeDeck(LIVE_IDS, { delete: false, replace: false, insert: false });
  const failedRun = await executeConfirmedPptPlan(pending, failed.hooks);
  assert.deepEqual(failed.calls, ["delete:258", "replace:257", "insert:256"]);
  assert.ok(failedRun.lines.every((line) => line.startsWith("❌")));
  assert.ok(!failedRun.lines.includes(`(${PPT_CHAT_BUILD})`));

  // One success is enough.
  const partial = fakeDeck(LIVE_IDS, { replace: false, insert: false });
  const partialRun = await executeConfirmedPptPlan(pending, partial.hooks);
  assert.equal(partialRun.lines.filter((line) => line.startsWith("✅")).length, 1);
  assert.equal(partialRun.lines[partialRun.lines.length - 1], `(${PPT_CHAT_BUILD})`);
});

test("an empty confirmed plan writes nothing and reports nothing", async () => {
  const { calls, hooks } = fakeDeck(LIVE_IDS);
  assert.deepEqual((await executeConfirmedPptPlan([], hooks)).lines, []);
  assert.deepEqual((await executeConfirmedPptPlan(null, hooks)).lines, []);
  assert.deepEqual(calls, []);
});

// --- Shared improve pipeline: Chat and the Lanjutan card use ONE path ---------
// improveExistingSlide is the model call; everything around it (intent
// resolution, Deck Studio settings, visual preference, content-loss retry and
// refusal) lives in runImproveSlidePipeline. The confirmed chat write calls it,
// and so does the Deck Studio "Perbaiki slide terpilih — Lanjutan" card.
import { runImproveSlidePipeline } from "../src/chat/pptTools.js";

const SIX = "Latar belakang\nSatu\nDua\nTiga\nEmpat\nLima\nEnam";
const keepAll = (headline) => ({
  spec: { title: headline, slides: [{ type: "bullets", headline, bullets: ["Satu", "Dua", "Tiga", "Empat", "Lima", "Enam"] }] },
  source: "model-grounded"
});

test("Deck Studio tone and project instructions reach improveExistingSlide through the confirmed chat write", async () => {
  const seen = [];
  const { hooks } = fakeDeck(LIVE_IDS);
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 2, instruction: "buat lebih visual" }], CTX);
  const { lines } = await executeConfirmedPptPlan(pending, {
    ...hooks,
    tone: "untuk direksi, tegas",
    instruction: "Gunakan warna brand; maksimal 5 bullet",
    styleId: "nusantara",
    improveSlide: async (args) => { seen.push(args); return keepAll("Latar belakang"); }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tone, "untuk direksi, tegas");
  assert.match(seen[0].instruction, /Gunakan warna brand; maksimal 5 bullet/);
  assert.match(seen[0].instruction, /buat lebih visual/);
  // The visual intent is steering text in the SAME instruction channel, not a schema field.
  assert.match(seen[0].instruction, /angka eksplisit/i);
  assert.match(seen[0].slideText, /Latar belakang/);
  assert.equal(lines.filter((line) => line.startsWith("✅")).length, 1);
});

test("runImproveSlidePipeline: the Lanjutan card gets the same intent/settings/retry behaviour as chat", async () => {
  const seen = [];
  let call = 0;
  const outcome = await runImproveSlidePipeline({
    slideText: SIX,
    tone: "executive",
    instruction: "style guide X",
    intent: "jadikan kartu",
    improveSlide: async (args) => {
      seen.push(args);
      call += 1;
      // First answer throws away most of the content; the retry keeps it.
      if (call === 1) {
        return { spec: { title: "t", slides: [{ type: "bullets", headline: "Latar belakang", bullets: ["Satu"] }] }, source: "model-grounded" };
      }
      return keepAll("Latar belakang");
    }
  });
  assert.equal(seen.length, 2, "severe loss must retry once");
  assert.equal(seen[0].tone, "executive");
  assert.match(seen[0].instruction, /^Permintaan pengguna untuk slide ini \(UTAMAKAN ini\): jadikan kartu/);
  assert.match(seen[0].instruction, /cards/);
  assert.match(seen[0].instruction, /style guide X/);
  assert.match(seen[1].instruction, /6/); // retry instruction names the source unit count
  assert.equal(outcome.refused, false);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.result.spec.slides[0].bullets.length, 6);
  assert.equal(outcome.intent, "jadikan kartu");
});

test("runImproveSlidePipeline refuses (no spec to write) when the retry also loses most of the content", async () => {
  const thin = { spec: { title: "t", slides: [{ type: "bullets", headline: "Latar belakang", bullets: ["Satu"] }] }, source: "model-grounded" };
  const outcome = await runImproveSlidePipeline({
    slideText: SIX, intent: "ringkas", slideIndex: 2, improveSlide: async () => thin
  });
  assert.equal(outcome.refused, true);
  assert.match(outcome.refusedLine, /^⛔ Slide 2 TIDAK diubah/);
  assert.equal(outcome.result, null);
});

test("runImproveSlidePipeline surfaces an abort without a writable result", async () => {
  const outcome = await runImproveSlidePipeline({
    slideText: SIX, intent: "ringkas", signal: { aborted: true },
    improveSlide: async () => keepAll("Latar belakang")
  });
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.result, null);
});

// --- Design-preserving writes (live, 2026-09-03) --------------------------
// "Perbaiki slide ini" on a green-and-cream deck came back as a black Tantular
// Deck Studio slide: improve always built a NEW slide and replaced the original,
// and the user's master, colours and footer went with it. Now: unless the user
// asked for a new layout (cards/columns/chart), the result is steered to the
// slide's own structure and written INTO its existing shapes; a layout request
// replaces the slide, and the proposal line says which will happen. A fallback
// result is never written at all.
import { chooseImproveWriteMode, slideStructureInstruction } from "../src/chat/pptTools.js";

const IMPROVE_CTX = { slides: [{ index: 3, id: "258", title: "How to Read This Case", text: "How to Read This Case\nRead it twice\nFirst pass for the story\nCite the exhibit" }] };
const ONE_BODY_SHAPES = [
  { name: "Title 1", text: "How to Read This Case" },
  { name: "Content Placeholder 2", text: "Read it twice\nFirst pass for the story\nCite the exhibit" }
];
const TWO_COL_SHAPES = [
  { name: "Title 1", text: "How to Read This Case" },
  { name: "TextBox 2", text: "Read it twice" },
  { name: "TextBox 3", text: "First pass for the story\nCite the exhibit" },
  { name: "TextBox 4", text: "Work with the gap" },
  { name: "TextBox 5", text: "Built from public sources\nName the missing number" }
];
const bulletsResult = { spec: { title: "t", slides: [{ type: "bullets", headline: "How to Read This Case", bullets: ["Read it twice", "First pass for the story", "Cite the exhibit"] }] }, source: "model-grounded" };
// Reworded on purpose: an in-place result identical to the slide is a no-op (see below).
const columnsResult = { spec: { title: "t", slides: [{ type: "columns", headline: "How to Read This Case", columns: [
  { title: "Read it twice", points: ["First pass: the story", "Cite the exhibit relied on"] },
  { title: "Work with the gap", points: ["Built from public sources only", "Name the missing number"] }
] }] }, source: "model-grounded" };
const cardsResult = { spec: { title: "t", slides: [{ type: "cards", headline: "How to Read This Case", cards: [{ title: "Read it twice" }, { title: "First pass for the story" }, { title: "Cite the exhibit" }] }] }, source: "model-grounded" };

function fakeImproveDeck(shapes = ONE_BODY_SHAPES) {
  const calls = [];
  const hooks = {
    readLiveIds: () => ["256", "257", "258"],
    deleteSlides: () => ({ deleted: true }),
    replaceSlide: (_b64, o) => { calls.push(`replace:${o.slideId}`); return { replaced: true }; },
    insertSlideAfter: () => ({ inserted: true }),
    readSlideShapes: (o) => { calls.push(`read:${o.slideId}`); return { found: true, shapes }; },
    writeShapeTexts: (o, writes) => { calls.push(`write:${o.slideId}:${writes.map((w) => w.index).join(",")}`); return { updated: true }; },
    applySlideLayout: (o, writes) => { calls.push(`layout:${o.slideId}:${writes.length}`); return { updated: true }; },
    headings: async ({ groups }) => groups.map((g) => ({ text: g.heading || g.items[0], source: "fallback" }))
  };
  return { calls, hooks };
}

test("chooseImproveWriteMode: only an explicit layout request replaces the slide", () => {
  assert.equal(chooseImproveWriteMode(""), "in_place");
  assert.equal(chooseImproveWriteMode("rapikan dan perjelas"), "in_place");
  assert.equal(chooseImproveWriteMode("supaya lebih ringkas"), "in_place");
  assert.equal(chooseImproveWriteMode("jadikan kartu"), "replace");
  assert.equal(chooseImproveWriteMode("bandingkan dalam kolom"), "replace");
  assert.equal(chooseImproveWriteMode("buat lebih visual"), "replace");
});

test("slideStructureInstruction steers the model to the slide's own shape", () => {
  assert.match(slideStructureInstruction({ bodies: 1, headings: [] }), /type "bullets"/);
  const two = slideStructureInstruction({ bodies: 2, headings: ["Read it twice", "Work with the gap"] });
  assert.match(two, /type "columns"/);
  assert.match(two, /tepat 2 kolom/);
  assert.match(two, /"Read it twice"/);
  assert.equal(slideStructureInstruction(null), "");
  assert.equal(slideStructureInstruction({ bodies: 0, headings: [] }), "");
});

test("the proposal says whether the slide design is kept or the layout will change", () => {
  assert.equal(describePendingChange({ op: "improve_slide", slideIndex: 3, title: "Case", instruction: "jadikan lebih executive" }),
    'Perbaiki slide 3 ("Case") — teks ditulis ulang, desain slide dipertahankan');
  assert.match(describePendingChange({ op: "improve_slide", slideIndex: 3, title: "Case", instruction: "ubah menjadi layout kartu" }),
    /^Perbaiki slide 3 \("Case"\) — layout diganti menjadi kartu\/kolom, dibangun di slide ini — desain deck dipertahankan/);
  assert.match(describePendingChange({ op: "improve_slide", slideIndex: 3, instruction: "buat lebih visual" }), /chart jika ada angka \(dibangun ulang/);
});

test("in place: the slide's shapes are read BEFORE the model runs, the structure steers the prompt, and the writes hit only those shapes", async () => {
  const { calls, hooks } = fakeImproveDeck(TWO_COL_SHAPES);
  const seen = [];
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3, instruction: "rapikan" }], IMPROVE_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async (args) => { seen.push(args); return columnsResult; } });
  // read → write → the post-write layout audit reads once more (no geometry
  // in this fixture, so nothing to re-stack and no layout write)
  assert.deepEqual(calls, ["read:258", "write:258:0,1,2,3,4", "read:258"]);
  assert.match(seen[0].instruction, /tepat 2 kolom/);
  assert.deepEqual(seen[0].sourceBlocks, [["First pass for the story", "Cite the exhibit"], ["Built from public sources", "Name the missing number"]],
    "the per-column source lines travel to the model call so grounding can keep a point instead of dropping it");
  assert.match(lines[0], /^✅ Slide 3 diperbaiki di tempat/);
  assert.match(lines[0], /desain slide dipertahankan/);
});

test("in place: a result that does not fit the slide's structure is rebuilt through the builder, never refused", async () => {
  const { calls, hooks } = fakeImproveDeck(TWO_COL_SHAPES);
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3 }], IMPROVE_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => bulletsResult });
  assert.deepEqual(calls, ["read:258", "replace:258"]);
  assert.match(lines[0], /^✅ Slide 3/);
  assert.match(lines[0], /dibangun ulang — desain slide ikut berubah/);
  assert.ok(lines.includes(`(${PPT_CHAT_BUILD})`));
});

test("a cards request no longer replaces the slide through the template; it goes to the native writer", async () => {
  const { calls, hooks } = fakeImproveDeck();
  const native = [];
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3, instruction: "jadikan kartu" }], IMPROVE_CTX);
  await executeConfirmedPptPlan(pending, {
    ...hooks, improveSlide: async () => cardsResult,
    readSlideDesign: () => { native.push("design"); return { found: true, shapes: ONE_BODY_SHAPES.map((sh, i) => ({ ...sh, left: 10, top: 10 + i * 100, width: 500, height: 80 })), title: {}, body: {}, headingColor: "", api: { addGeometricShape: true, addTextBox: true } }; },
    buildNativeCards: () => { native.push("build"); return { updated: true, created: 8 }; }
  });
  assert.deepEqual(calls, [], "no template replace");
  assert.deepEqual(native, ["design", "build"]);
});

test("a fallback result is retried once and then refused — never written in any mode", async () => {
  const { calls, hooks } = fakeImproveDeck();
  let n = 0;
  const fallback = { spec: { title: "t", slides: [{ type: "bullets", headline: "How to Read This Case", bullets: ["How to Read This Case", "Read it twice", "First pass for the story", "Cite the exhibit"] }] }, source: "fallback-grounded" };
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3, instruction: "jadikan kartu" }], IMPROVE_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => { n += 1; return fallback; } });
  assert.equal(n, 2);
  assert.deepEqual(calls, []);
  assert.match(lines[0], /^⛔ Slide 3 TIDAK diubah/);
  assert.match(lines[0], /versi fallback/);
});

test("runImproveSlidePipeline accepts a model-grounded second attempt after a fallback first attempt", async () => {
  let n = 0;
  const outcome = await runImproveSlidePipeline({
    slideText: IMPROVE_CTX.slides[0].text, intent: "rapikan", slideIndex: 3,
    improveSlide: async () => { n += 1; return n === 1 ? { spec: bulletsResult.spec, source: "fallback" } : bulletsResult; }
  });
  assert.equal(outcome.refused, false);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.result.source, "model-grounded");
});

// --- replace_slide on a slide that has text (live, 2026-09-03) -------------
// "Apakah bisa dibuat tabel ... slide 3" made the planner emit replace_slide
// with content it wrote itself — translated into Indonesian, half the points
// gone — and that path has no grounding, no language lock, no loss check. Any
// request about an EXISTING slide with readable text is routed through
// improve_slide, carrying the user's request, so the guards apply.
import { preferImproveOverReplace } from "../src/chat/pptTools.js";

test("a planner replace_slide on a slide with text becomes improve_slide carrying the user's request", () => {
  const { actions, notes } = preferImproveOverReplace([
    { op: "replace_slide", slideIndex: 3, slide: { type: "columns", headline: "Langkah", columns: [{ title: "a", points: ["x"] }, { title: "b", points: ["y"] }] } },
    { op: "delete_slide", slideIndex: 4 }
  ], IMPROVE_CTX, "Apakah bisa dibuat tabel sehingga lebih terstruktur pada slide halaman 3");
  assert.deepEqual(actions[0], { op: "improve_slide", slideIndex: 3, instruction: "Apakah bisa dibuat tabel sehingga lebih terstruktur pada slide halaman 3" });
  assert.deepEqual(actions[1], { op: "delete_slide", slideIndex: 4 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Slide 3/);
  assert.match(notes[0], /teks slide asli/);
});

test("replace_slide on a slide WITHOUT readable text is left alone", () => {
  const ctx = { slides: [{ index: 2, id: "257", title: "", text: "" }] };
  const action = { op: "replace_slide", slideIndex: 2, slide: { type: "bullets", headline: "Baru", bullets: ["a"] } };
  const { actions, notes } = preferImproveOverReplace([action], ctx, "ganti slide 2");
  assert.deepEqual(actions, [action]);
  assert.deepEqual(notes, []);
});

// --- Honest no-op (live, 2026-09-03) ---------------------------------------
// When every rewritten line was put back to the source, the slide is verbatim
// the original; a ✅ "diperbaiki" line is then a false claim, and a write that
// changes nothing is still a write. Detect it and say so; write nothing.
import { writesChangeNothing } from "../src/officeClient.js";

test("writesChangeNothing is true only when every planned write equals the text already there", () => {
  const shapes = [
    { name: "Title 1", text: "How to Read This Case" },
    { name: "TextBox 2", text: "Read it twice\rFirst pass for the story\rCite the exhibit" }
  ];
  assert.equal(writesChangeNothing(shapes, [
    { index: 0, text: "How to Read This Case" },
    { index: 1, text: "First pass for the story\nCite the exhibit", afterFirstParagraph: true }
  ]), true);
  assert.equal(writesChangeNothing(shapes, [
    { index: 1, text: "First pass: who did what\nCite the exhibit", afterFirstParagraph: true }
  ]), false);
  assert.equal(writesChangeNothing(shapes, []), true);
});

test("an in-place result identical to the source is reported as unchanged, not as improved, and writes nothing", async () => {
  const same = { spec: { title: "t", slides: [{ type: "bullets", headline: "How to Read This Case", bullets: ["Read it twice", "First pass for the story", "Cite the exhibit"] }] }, source: "model-grounded" };
  const { calls, hooks } = fakeImproveDeck(ONE_BODY_SHAPES);
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3, instruction: "rapikan" }], IMPROVE_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => same });
  assert.deepEqual(calls, ["read:258"]);
  assert.match(lines[0], /^ℹ️ Slide 3 tidak diubah/);
  assert.match(lines[0], /pemeriksaan sumber/);
  assert.ok(!lines.includes(`(${PPT_CHAT_BUILD})`));
});

// --- Verbatim answers (traced + reproduced live, 2026-09-03) ---------------
// With the planner's fabricated "lebih ringkas" intent the model returned the
// slide word for word, three times out of three. A verbatim answer is not an
// improvement: retry once with an explicit rewording instruction; only if the
// second answer is verbatim too does the caller report "tidak diubah".
import { isVerbatimResult } from "../src/chat/pptTools.js";

const SOURCE = "How to Read This Case\nRead it twice\nFirst pass for the story\nCite the exhibit\nWork with the gap\nBuilt from public sources\nName the missing number";
const verbatim = { spec: { title: "t", slides: [{ type: "columns", headline: "Case Reading Strategy", columns: [
  { title: "Read it twice", points: ["First pass for the story", "Cite the exhibit"] },
  { title: "Work with the gap", points: ["Built from public sources", "Name the missing number"] }
] }] }, source: "model-grounded" };
const reworded = { spec: { title: "t", slides: [{ type: "columns", headline: "How to Read This Case", columns: [
  { title: "Read it twice", points: ["First pass: follow the story", "Cite the exhibit relied on"] },
  { title: "Work with the gap", points: ["Built only from public sources", "Name the missing number"] }
] }] }, source: "model-grounded" };

test("isVerbatimResult is true when every point already appears verbatim on the source slide", () => {
  assert.equal(isVerbatimResult(verbatim.spec.slides[0], SOURCE), true);
  assert.equal(isVerbatimResult(reworded.spec.slides[0], SOURCE), false);
  assert.equal(isVerbatimResult(null, SOURCE), false);
});

test("a verbatim first answer is retried once with a rewording instruction", async () => {
  const seen = [];
  let n = 0;
  const outcome = await runImproveSlidePipeline({
    slideText: SOURCE, intent: "Perbaiki slide 3.", slideIndex: 3,
    improveSlide: async (args) => { seen.push(args); n += 1; return n === 1 ? verbatim : reworded; }
  });
  assert.equal(seen.length, 2);
  assert.match(seen[1].instruction, /jangan menyalin/i);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.refused, false);
  assert.deepEqual(outcome.result.spec.slides[0].columns[0].points, ["First pass: follow the story", "Cite the exhibit relied on"]);
});

test("a verbatim answer twice is handed back unrefused so the caller reports it as unchanged, not as an error", async () => {
  let n = 0;
  const outcome = await runImproveSlidePipeline({
    slideText: SOURCE, intent: "Perbaiki slide 3.", slideIndex: 3,
    improveSlide: async () => { n += 1; return verbatim; }
  });
  assert.equal(n, 2);
  assert.equal(outcome.refused, false);
  assert.equal(outcome.verbatim, true);
});

// --- Native visual cards routing (design review 2026-09-03) ----------------
// A cards/columns result no longer rebuilds the slide in the Deck Studio
// template: it is drawn on the user's own slide (nativeCards + officeClient.
// buildNativeCardsOnSlide). Charts still need the builder. Refusals from the
// native path never fall back to the template rebuild.
const DESIGN = {
  found: true,
  shapes: [
    { name: "Title 1", text: "How This Is Assessed", left: 60, top: 60, width: 800, height: 60 },
    { name: "Content Placeholder 2", text: "First.\rA claim tied to an exhibit.\rSecond.\rDistinguish sources.", left: 60, top: 150, width: 800, height: 300 }
  ],
  title: { name: "Georgia", color: "#1F5F4A", size: 32 }, body: { name: "Segoe UI", color: "", size: 14 }, headingColor: "",
  api: { addGeometricShape: true, addTextBox: true }
};
const CARDS_CTX = { slides: [{ index: 8, id: "280", title: "How This Is Assessed", text: "How This Is Assessed\nFirst.\nA claim tied to an exhibit.\nSecond.\nDistinguish sources." }] };
const nativeCards = { spec: { title: "t", slides: [{ type: "cards", headline: "How This Is Assessed", cards: [
  { title: "Traceable Reasoning", desc: "A claim tied to an exhibit." }, { title: "Distinguish sources", desc: "Distinguish sources." }
] }] }, source: "model-grounded" };
const chartResult = { spec: { title: "t", slides: [{ type: "visualization", headline: "H", chartType: "bar", data: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }] }, source: "model-grounded" };

function fakeNativeDeck(design = DESIGN, buildOutcome = { updated: true, created: 8 }) {
  const calls = [];
  const hooks = {
    readLiveIds: () => ["271", "272", "273", "274", "275", "276", "277", "280"],
    deleteSlides: () => ({ deleted: true }),
    insertSlideAfter: () => ({ inserted: true }),
    replaceSlide: (_b64, o) => { calls.push(`replace:${o.slideId}`); return { replaced: true }; },
    readSlideShapes: () => ({ found: true, shapes: design.shapes }),
    writeShapeTexts: () => ({ updated: true }),
    readSlideDesign: (o) => { calls.push(`design:${o.slideId}`); return design; },
    buildNativeCards: (o, plan, del) => { calls.push(`native:${o.slideId}:${plan.length}:${del.join(",")}`); return buildOutcome; },
    headings: async ({ groups }) => groups.map((g) => ({ text: g.heading || g.items[0], source: "fallback" }))
  };
  return { calls, hooks };
}

test("a cards result is drawn on the user's slide, not rebuilt in the template; the line names the style source", async () => {
  const { calls, hooks } = fakeNativeDeck();
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 8, instruction: "jadikan kartu" }], CARDS_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => nativeCards });
  assert.deepEqual(calls, ["design:280", "native:280:8:1"]);
  assert.match(lines[0], /^✅ Slide 8/);
  assert.match(lines[0], /dibangun di slide ini/);
  assert.match(lines[0], /desain deck dipertahankan/);
  assert.match(lines[0], /tidak terbaca/, "empty colour reads are reported, not hidden");
});

test("a chart result still needs the builder and replaces the slide", async () => {
  const { calls, hooks } = fakeNativeDeck();
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 8, instruction: "buat chart" }], CARDS_CTX);
  await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => chartResult });
  assert.deepEqual(calls, ["replace:280"]);
});

test("a host without the shape methods is refused clearly — never a silent template rebuild", async () => {
  const { calls, hooks } = fakeNativeDeck({ ...DESIGN, api: { addGeometricShape: true, addTextBox: false } });
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 8, instruction: "jadikan kartu" }], CARDS_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => nativeCards });
  assert.deepEqual(calls, ["design:280"]);
  assert.match(lines[0], /^❌ Slide 8/);
  assert.match(lines[0], /addTextBox/);
});

test("an ambiguous body mapping is refused — nothing deleted, nothing rebuilt", async () => {
  const ambiguous = { ...DESIGN, shapes: [
    DESIGN.shapes[0],
    { name: "TextBox 2", text: "Read it twice", left: 60, top: 150, width: 380, height: 30 },
    { name: "TextBox 3", text: "a\rb", left: 60, top: 190, width: 380, height: 260 },
    { name: "TextBox 6", text: "Source: internal analysis", left: 60, top: 460, width: 380, height: 20 },
    { name: "TextBox 4", text: "Work with the gap", left: 480, top: 150, width: 380, height: 30 },
    { name: "TextBox 5", text: "c\rd", left: 480, top: 190, width: 380, height: 260 }
  ] };
  const { calls, hooks } = fakeNativeDeck(ambiguous);
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 8, instruction: "jadikan kartu" }], CARDS_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => nativeCards });
  assert.deepEqual(calls, ["design:280"]);
  assert.match(lines[0], /^❌ Slide 8/);
  assert.match(lines[0], /tidak yakin/);
});

test("the proposal line for a cards request says the cards are built on this slide with the deck design kept", () => {
  const line = describePendingChange({ op: "improve_slide", slideIndex: 8, title: "Case", instruction: "jadikan kartu" });
  assert.match(line, /kartu.*dibangun di slide ini/);
  assert.match(line, /desain deck dipertahankan/);
  assert.match(line, /warna\/font mengikuti yang terbaca/);
  const visual = describePendingChange({ op: "improve_slide", slideIndex: 8, instruction: "buat lebih visual" });
  assert.match(visual, /kartu\/kolom dibangun di slide ini/);
  assert.match(visual, /chart.*dibangun ulang/);
});

// --- no structural refusal (2026-09-05) ------------------------------------
// When no in-place mapping exists at all, the slide is rebuilt through the
// builder instead of refused. The line says what that costs: on a Deck Studio
// slide the style is the same; on any other slide the design changes.
const ODD_SHAPES = [
  { name: "Title 1", text: "Judul", left: 60, top: 60, width: 800, height: 60 },
  { name: "TextBox 2", text: "kiri\ratas", left: 60, top: 150, width: 300, height: 100 },
  { name: "TextBox 3", text: "kanan\ratas", left: 500, top: 150, width: 300, height: 100 },
  { name: "TextBox 4", text: "kiri\rbawah", left: 60, top: 300, width: 300, height: 100 },
  { name: "TextBox 5", text: "Sumber: internal", left: 60, top: 460, width: 300, height: 20 }
];
const ODD_CTX = { slides: [{ index: 4, id: "259", title: "Judul", text: "Judul\nkiri\natas\nkanan\natas\nkiri\nbawah" }] };

test("an unmappable structure falls back to the builder rebuild with an honest design note — never ❌", async () => {
  const { calls, hooks } = fakeNativeDeck({ found: true, shapes: ODD_SHAPES, title: {}, body: {}, headingColor: "", api: { addGeometricShape: true, addTextBox: true } });
  hooks.readLiveIds = () => ["256", "257", "258", "259"];
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 4, instruction: "rapikan" }], ODD_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => columnsResult });
  assert.deepEqual(calls, ["replace:259"]);
  assert.match(lines[0], /^✅ Slide 4/);
  assert.match(lines[0], /dibangun ulang/);
  assert.match(lines[0], /desain slide ikut berubah/);
});

test("on a Deck Studio slide an unmappable result is composed natively from the improved content, not rebuilt", async () => {
  const studio = [...ODD_SHAPES, { name: "TextBox 9", text: "Tantular Deck Studio · 4/8", left: 60, top: 500, width: 300, height: 20 }];
  const { calls, hooks } = fakeNativeDeck({ found: true, shapes: studio, title: {}, body: {}, headingColor: "", accents: [], api: { addGeometricShape: true, addTextBox: true } });
  hooks.readLiveIds = () => ["256", "257", "258", "259"];
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 4 }], ODD_CTX);
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => columnsResult });
  assert.ok(!calls.some((c) => c.startsWith("replace:")), "no builder rebuild on a Deck Studio slide");
  assert.ok(calls.some((c) => c.startsWith("native:259:")), calls.join(","));
  assert.match(lines[0], /isi baru ditata ulang di slide ini/);
  assert.match(lines[1], /^✨ Slide 4 ditata ulang: 2 panel/);
});

// --- automatic layout tidy after an in-place write (2026-09-05) --------------
test("after an in-place write the slide is audited and re-stacked if boxes overlap", async () => {
  const before = [
    { name: "Title 1", text: "T", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
    { name: "TextBox 2", text: "a", left: 84, top: 150, width: 822, height: 46, fontSize: 14 },
    { name: "TextBox 3", text: "b", left: 84, top: 196, width: 822, height: 46, fontSize: 14 },
    { name: "TextBox 4", text: "c", left: 84, top: 242, width: 822, height: 46, fontSize: 14 }
  ];
  const after = before.map((s, i) => (i === 1 ? { ...s, text: "satu\ndua\ntiga\nempat" } : s));
  let reads = 0;
  const applied = [];
  const { hooks } = fakeImproveDeck(before);
  hooks.readSlideShapes = () => { reads += 1; return { found: true, shapes: reads === 1 ? before : after }; };
  hooks.applySlideLayout = (_t, writes) => { applied.push(writes); return { updated: true }; };
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3 }], IMPROVE_CTX);
  const result = { spec: { title: "t", slides: [{ type: "bullets", headline: "T", bullets: ["satu\ndua\ntiga\nempat", "b", "c"] }] }, source: "model-grounded" };
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => result });
  assert.equal(applied.length, 1, "the layout was re-stacked once");
  assert.ok(lines.some((l) => /📐/.test(l)), lines.join(" | "));
});

// --- automatic re-layout (2026-09-05) --------------------------------------------
import { executeRelayout } from "../src/chat/pptTools.js";

const STUDIO_SLIDE = [
  { name: "Title 1", text: "Detail Spesifikasi dan Sumber Pelarut", left: 54, top: 60, width: 852, height: 60, fontSize: 28 },
  { name: "Rectangle 2", text: "", left: 54, top: 160, width: 12, height: 12 },
  { name: "TextBox 3", text: "Nama Pelarut\nJumlah dan Satuan\nSumber (Hewan/Manusia)\nProdusen\nNegara Produsen", left: 84, top: 150, width: 822, height: 100, fontSize: 14 },
  { name: "Rectangle 4", text: "", left: 54, top: 270, width: 12, height: 12 },
  { name: "TextBox 5", text: "Pemerian obat\nSpesifikasi dan Metode Analisis\nIndikasi\nPosologi\nRute Pemberian", left: 84, top: 260, width: 822, height: 100, fontSize: 14 },
  { name: "TextBox 6", text: "Tantular Deck Studio · 21/30", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
];
const STUDIO_DESIGN = { found: true, shapes: STUDIO_SLIDE, title: { name: "Segoe UI", color: "#1F3A5F", size: 28 }, body: { name: "Segoe UI", color: "#222222", size: 14 }, headingColor: "", accents: ["#1F3A5F", "#A6351D"], api: { addGeometricShape: true, addTextBox: true } };

test("executeRelayout: analyse → pattern → grounded headings → native plan → build, deleting only the old boxes and markers", async () => {
  const calls = [];
  const { lines } = await executeRelayout({ slideId: "271", slideIndex: 21 }, {
    readLiveIds: () => Array.from({ length: 21 }, (_, i) => (i === 20 ? "271" : String(300 + i))),
    readSlideDesign: () => STUDIO_DESIGN,
    headings: async ({ groups }) => groups.map((g, i) => ({ text: i === 0 ? "Sumber Pelarut" : "Spesifikasi Obat", source: "model" })),
    buildNativeCards: (t, plan, del) => { calls.push({ t, plan, del }); return { updated: true, created: plan.length }; }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].del, [1, 2, 3, 4]);
  const kinds = calls[0].plan.map((p) => p.kind);
  assert.equal(kinds.filter((k) => k === "panel").length, 2);
  assert.equal(kinds.filter((k) => k === "line").length, 10);
  assert.deepEqual(calls[0].plan.filter((p) => p.kind === "heading").map((p) => p.text), ["Sumber Pelarut", "Spesifikasi Obat"]);
  assert.deepEqual(calls[0].plan.filter((p) => p.kind === "bar").map((p) => p.fill), ["#1F3A5F", "#A6351D"]);
  assert.match(lines[0], /^✨ Slide 21 ditata ulang: 2 panel/);
  assert.match(lines[0], /warna dan font mengikuti slide ini/);
});

test("executeRelayout refuses cleanly when the shape API is missing, and reports an empty slide honestly", async () => {
  const noApi = await executeRelayout({ slideId: "271", slideIndex: 1 }, {
    readLiveIds: () => ["271"], readSlideDesign: () => ({ ...STUDIO_DESIGN, api: { addGeometricShape: false, addTextBox: true } }),
    buildNativeCards: () => { throw new Error("must not be called"); }
  });
  assert.match(noApi.lines[0], /^❌/);
  assert.match(noApi.lines[0], /addGeometricShape/);
  const empty = await executeRelayout({ slideId: "271", slideIndex: 1 }, {
    readLiveIds: () => ["271"], readSlideDesign: () => ({ ...STUDIO_DESIGN, shapes: [STUDIO_SLIDE[0], STUDIO_SLIDE[5]] }),
    buildNativeCards: () => { throw new Error("must not be called"); }
  });
  assert.match(empty.lines[0], /tidak ada isi/);
});

test("after an in-place improve on a Deck Studio slide the re-layout runs automatically", async () => {
  const applied = [];
  const { hooks } = fakeImproveDeck(STUDIO_SLIDE);
  hooks.readSlideDesign = () => STUDIO_DESIGN;
  hooks.headings = async ({ groups }) => groups.map((g) => ({ text: g.items[0], source: "fallback" }));
  hooks.buildNativeCards = (_t, plan, del) => { applied.push({ plan, del }); return { updated: true, created: plan.length }; };
  const { pending } = executePptActions([{ op: "improve_slide", slideIndex: 3 }], IMPROVE_CTX);
  const result = { spec: { title: "t", slides: [{ type: "bullets", headline: "T", bullets: ["a", "b", "c", "d", "e"] }] }, source: "model-grounded" };
  const { lines } = await executeConfirmedPptPlan(pending, { ...hooks, improveSlide: async () => result });
  assert.equal(applied.length, 1);
  assert.ok(lines.some((l) => /✨ Slide 3 ditata ulang/.test(l)), lines.join(" | "));
});

test("on a Deck Studio slide with unreadable fonts the composer uses the builder typeface and the left-bar accent", async () => {
  const calls = [];
  const shapes = [
    { name: "Rectangle 1", text: "", left: 40, top: 0, width: 6, height: 540, fillColor: "#1F3A5F" },
    { name: "Title 1", text: "Judul", left: 54, top: 60, width: 852, height: 60, fontSize: 0 },
    { name: "TextBox 3", text: "Poin satu yang cukup panjang untuk dibaca", left: 84, top: 150, width: 822, height: 40, fontSize: 0 },
    { name: "TextBox 4", text: "Poin dua yang cukup panjang untuk dibaca", left: 84, top: 196, width: 822, height: 40, fontSize: 0 },
    { name: "TextBox 5", text: "Poin tiga yang cukup panjang untuk dibaca", left: 84, top: 242, width: 822, height: 40, fontSize: 0 },
    { name: "TextBox 9", text: "Tantular Deck Studio · 5/8", left: 54, top: 500, width: 300, height: 20, fontSize: 9 }
  ];
  const { lines } = await executeRelayout({ slideId: "290", slideIndex: 5 }, {
    readLiveIds: () => ["290"],
    readSlideDesign: () => ({ found: true, shapes, title: { name: "", color: "", size: 0 }, body: { name: "", color: "", size: 0 }, headingColor: "", accents: [], bars: ["#1F3A5F"], api: { addGeometricShape: true, addTextBox: true } }),
    headings: async ({ groups }) => groups.map((g) => ({ text: g.items[0], source: "fallback" })),
    buildNativeCards: (_t, plan) => { calls.push(plan); return { updated: true, created: plan.length }; }
  });
  const plan = calls[0];
  const line = plan.find((p) => p.kind === "line");
  assert.equal(line.font.name, "Segoe UI");
  assert.equal(plan.find((p) => p.kind === "marker").fill, "#1F3A5F");
  assert.match(lines[0], /satu daftar poin/);
  assert.doesNotMatch(lines[0], /tidak terbaca/, "Deck Studio defaults are not a fallback worth warning about");
});
