import test from "node:test";
import assert from "node:assert/strict";
import { hostUiConfig } from "../src/hostUi.js";

test("Excel shows Sheet Studio only", () => {
  const ui = hostUiConfig("Excel");
  assert.deepEqual(
    [ui.documentStudio, ui.sheetStudio, ui.deckStudio, ui.deckRefine],
    [false, true, false, false]
  );
  assert.match(ui.actionsTitle, /Excel/);
});

test("Word shows Document Studio only", () => {
  const ui = hostUiConfig("Word");
  assert.deepEqual(
    [ui.documentStudio, ui.sheetStudio, ui.deckStudio, ui.deckRefine],
    [true, false, false, false]
  );
});

test("PowerPoint shows Deck Studio and Improve only", () => {
  const ui = hostUiConfig("PowerPoint");
  assert.deepEqual(
    [ui.documentStudio, ui.sheetStudio, ui.deckStudio, ui.deckRefine],
    [false, false, true, true]
  );
});
