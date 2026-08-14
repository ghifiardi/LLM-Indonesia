import test from "node:test";
import assert from "node:assert/strict";
import {
  sameSlideId,
  resolveReplaceTarget,
  pickOriginalIndex,
  toInsertTargetSlideId,
  replaceSlideInActivePresentation
} from "../src/officeClient.js";

test("sameSlideId matches on the numeric part across id formats", () => {
  assert.equal(sameSlideId("257", "257#creationId"), true);
  assert.equal(sameSlideId("257#abc", "257#def"), true);
  assert.equal(sameSlideId("#creationId", "257#creationId"), true);
  assert.equal(sameSlideId("257#", "257#creationId"), true);
  assert.equal(sameSlideId("257", "258"), false);
  assert.equal(sameSlideId("", "257"), false);
  assert.equal(sameSlideId("257", ""), false);
  assert.equal(sameSlideId(null, undefined), false);
});

test("resolveReplaceTarget grounds the selected id on the deck's own id/format", () => {
  const liveIds = ["256#a", "257#b", "258#c"];
  const r = resolveReplaceTarget(liveIds, { slideId: "257" });
  assert.deepEqual(r, { targetLiveId: "257#b", targetIndex: 2 });
});

test("resolveReplaceTarget uses 1-based index only when no explicit id is available", () => {
  const liveIds = ["256#a", "257#b", "258#c"];
  assert.deepEqual(resolveReplaceTarget(liveIds, { slideIndex: 3 }), {
    targetLiveId: "258#c",
    targetIndex: 3
  });
  assert.deepEqual(resolveReplaceTarget(liveIds, { slideId: "999", slideIndex: 1 }), {
    targetLiveId: "",
    targetIndex: 0
  });
});

test("resolveReplaceTarget returns no target when nothing can anchor", () => {
  assert.deepEqual(resolveReplaceTarget([], { slideId: "257", slideIndex: 2 }), {
    targetLiveId: "",
    targetIndex: 0
  });
  assert.deepEqual(resolveReplaceTarget(["256"], {}), { targetLiveId: "", targetIndex: 0 });
  assert.deepEqual(resolveReplaceTarget(["256"], { slideIndex: 9 }), {
    targetLiveId: "",
    targetIndex: 0
  });
});

test("pickOriginalIndex finds the original by stable position after insert-after", () => {
  const afterIds = ["256#a", "257#b", "999#new", "258#c"];
  const pos = pickOriginalIndex(afterIds, { targetLiveId: "257#b", targetIndex: 2 });
  assert.equal(pos, 1);
});

test("pickOriginalIndex tolerates an id-format change at the same position", () => {
  const afterIds = ["256", "257", "999", "258"];
  const pos = pickOriginalIndex(afterIds, { targetLiveId: "257#b", targetIndex: 2 });
  assert.equal(pos, 1);
});

test("pickOriginalIndex uses an exact id match when the position drifts", () => {
  const afterIds = ["999#new", "256#a", "257#b", "258#c"];
  const pos = pickOriginalIndex(afterIds, { targetLiveId: "257#b", targetIndex: 99 });
  assert.equal(pos, 2);
});

test("pickOriginalIndex returns -1 for an empty post-insert collection", () => {
  assert.equal(pickOriginalIndex([], { targetLiveId: "257#b", targetIndex: 2 }), -1);
});

test("pickOriginalIndex refuses a position-only match when the target id vanished", () => {
  assert.equal(
    pickOriginalIndex(["256#a", "999#new", "258#c"], { targetLiveId: "257#b", targetIndex: 2 }),
    -1
  );
});

test("pickOriginalIndex never picks the newly inserted slide over the original", () => {
  // Imported source slide reuses the original's numeric component. Exact live
  // identity must win over the positional/component match.
  const afterIds = ["256#a", "257#improved", "257#b", "258#c"];
  const pos = pickOriginalIndex(afterIds, { targetLiveId: "257#b", targetIndex: 2 });
  assert.equal(afterIds[pos], "257#b");
});

test("pickOriginalIndex refuses an ambiguous component-only match", () => {
  const afterIds = ["256#a", "257#new", "257#other", "258#c"];
  assert.equal(
    pickOriginalIndex(afterIds, { targetLiveId: "257#missing", targetIndex: 2 }),
    -1
  );
});

test("toInsertTargetSlideId emits Microsoft-supported target forms", () => {
  assert.equal(toInsertTargetSlideId("257"), "257#");
  assert.equal(toInsertTargetSlideId("257#"), "257#");
  assert.equal(toInsertTargetSlideId("#763315295"), "#763315295");
  assert.equal(toInsertTargetSlideId("257#763315295"), "257#763315295");
  assert.equal(toInsertTargetSlideId(""), "");
});

function installPowerPointMock({
  initialIds,
  insertedIds = ["999#improved"],
  deletableIds = initialIds,
  throwDeleteIds = [],
  // Model Mac PowerPoint: a delete() of the currently-selected slide is
  // silently ignored (no throw, no effect). Selection starts on the target.
  ignoreDeleteWhileSelected = false,
  initialSelectedIds = null,
  supportsSetSelectedSlides = true
}) {
  const ids = [...initialIds];
  let selectedIds = initialSelectedIds ? [...initialSelectedIds] : [];
  let insertCalls = 0;
  const context = {
    sync: async () => {},
    presentation: {
      get slides() {
        return {
          load() {},
          items: ids.map((id) => {
            const slide = { id, load() {} };
            if (deletableIds.some((candidate) => sameSlideId(candidate, id)) || insertedIds.some((candidate) => sameSlideId(candidate, id))) {
              slide.delete = () => {
                if (throwDeleteIds.some((candidate) => sameSlideId(candidate, id))) {
                  throw new Error(`delete failed for ${id}`);
                }
                // Silent no-op when this slide is the active selection.
                if (ignoreDeleteWhileSelected && selectedIds.includes(id)) {
                  return;
                }
                const index = ids.findIndex((candidate) => candidate === id);
                if (index >= 0) ids.splice(index, 1);
              };
            }
            return slide;
          })
        };
      },
      setSelectedSlides: supportsSetSelectedSlides
        ? (nextIds) => { selectedIds = (Array.isArray(nextIds) ? nextIds : []).filter(Boolean); }
        : undefined,
      insertSlidesFromBase64(_base64, options) {
        insertCalls += 1;
        context.presentation.lastTargetSlideId = options.targetSlideId;
        const index = ids.findIndex((id) => sameSlideId(id, options.targetSlideId));
        ids.splice(index + 1, 0, ...insertedIds);
      }
    }
  };
  const previous = globalThis.PowerPoint;
  globalThis.PowerPoint = { run: async (fn) => fn(context) };
  return {
    ids,
    get insertCalls() { return insertCalls; },
    get lastTargetSlideId() { return context.presentation.lastTargetSlideId; },
    get selectedIds() { return selectedIds; },
    restore() { globalThis.PowerPoint = previous; }
  };
}

test("replaceSlideInActivePresentation replaces in place without increasing slide count", async () => {
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"]
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.deepEqual(outcome, { replaced: true, inserted: true });
    assert.deepEqual(mock.ids, ["256#a", "999#improved", "258#c"]);
    assert.equal(mock.insertCalls, 1);
  } finally {
    mock.restore();
  }
});

test("replaceSlideInActivePresentation deletes the original even when it is the active selection (Mac regression)", async () => {
  // Reproduces the reported bug: the user selected the slide to improve, so the
  // original is the active selection and Mac PowerPoint drops delete() on it
  // unless the selection is moved off it first.
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"],
    ignoreDeleteWhileSelected: true,
    initialSelectedIds: ["257#b"]
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.equal(outcome.replaced, true);
    // Original gone, improved slide took its place, count unchanged.
    assert.deepEqual(mock.ids, ["256#a", "999#improved", "258#c"]);
    // Selection was moved onto the inserted slide so the delete could apply.
    assert.deepEqual(mock.selectedIds, ["999#improved"]);
  } finally {
    mock.restore();
  }
});

test("replaceSlideInActivePresentation rolls back cleanly if delete stays blocked (no setSelectedSlides host)", async () => {
  // Old host: cannot move the selection AND ignores delete on the selection.
  // The replacement must not leave a duplicate: roll the inserted slide back.
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"],
    ignoreDeleteWhileSelected: true,
    initialSelectedIds: ["257#b"],
    supportsSetSelectedSlides: false
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.equal(outcome.replaced, false);
    // Inserted slide removed; original deck restored exactly.
    assert.deepEqual(mock.ids, ["256#a", "257#b", "258#c"]);
  } finally {
    mock.restore();
  }
});

test("replaceSlideInActivePresentation does not insert when original cannot be deleted", async () => {
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"],
    deletableIds: ["256#a", "258#c"]
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.equal(outcome.replaced, false);
    assert.equal(outcome.inserted, false);
    assert.deepEqual(mock.ids, ["256#a", "257#b", "258#c"]);
    assert.equal(mock.insertCalls, 0);
  } finally {
    mock.restore();
  }
});

test("replaceSlideInActivePresentation rolls back the new slide when original deletion fails", async () => {
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"],
    throwDeleteIds: ["257#b"]
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.equal(outcome.replaced, false);
    assert.equal(outcome.rolledBack, true);
    assert.equal(outcome.inserted, false);
    assert.deepEqual(mock.ids, ["256#a", "257#b", "258#c"]);
  } finally {
    mock.restore();
  }
});

test("replaceSlideInActivePresentation rolls back if imported pptx unexpectedly contains multiple slides", async () => {
  const mock = installPowerPointMock({
    initialIds: ["256#a", "257#b", "258#c"],
    insertedIds: ["999#improved", "1000#unexpected"]
  });
  try {
    const outcome = await replaceSlideInActivePresentation("base64", { slideId: "257" });
    assert.equal(outcome.replaced, false);
    assert.equal(outcome.rolledBack, true);
    assert.equal(outcome.inserted, false);
    assert.deepEqual(mock.ids, ["256#a", "257#b", "258#c"]);
  } finally {
    mock.restore();
  }
});
