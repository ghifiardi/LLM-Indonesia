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
  assert.deepEqual(summary.lines, ['Perbaiki slide 2 ("Latar belakang") — isinya ditulis ulang']);
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
    'Perbaiki slide 2 ("Latar belakang") — isinya ditulis ulang',
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
