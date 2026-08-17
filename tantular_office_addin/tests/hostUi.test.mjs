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

// --- host detection fallbacks ------------------------------------------------
import { detectHost } from "../src/prompts.js";

test("detectHost: uses info.host when Office populates it", () => {
  assert.equal(detectHost({ host: "PowerPoint" }, {}), "PowerPoint");
  assert.equal(detectHost({ host: "Word" }, {}), "Word");
});

test("detectHost: falls back to Office.context.host when info.host is empty", () => {
  // Observed on Mac hosts: onReady fires with no host field.
  const globals = { Office: { context: { host: "PowerPoint" } } };
  assert.equal(detectHost({}, globals), "PowerPoint");
  assert.equal(detectHost({ host: "" }, globals), "PowerPoint");
  assert.equal(detectHost(undefined, globals), "PowerPoint");
});

test("detectHost: falls back to the host-specific global namespace", () => {
  // Office.js defines these only inside the host they belong to.
  assert.equal(detectHost({}, { PowerPoint: {} }), "PowerPoint");
  assert.equal(detectHost({}, { Excel: {} }), "Excel");
  assert.equal(detectHost({}, { Word: {} }), "Word");
});

test("detectHost: falls back to requirement sets", () => {
  const globals = {
    Office: { context: { requirements: {
      isSetSupported: (name) => name === "PowerPointApi"
    } } }
  };
  assert.equal(detectHost({}, globals), "PowerPoint");
});

test("detectHost: unknown host still resolves to Office", () => {
  assert.equal(detectHost({}, {}), "Office");
  assert.equal(detectHost({ host: "Outlook" }, {}), "Outlook");
});

// REGRESSION: the bug this exists to prevent. An unpopulated info.host made
// state.host "Office", which fails the Word/Excel/PowerPoint gate that mounts
// the chat pane AND gives hostUi deckStudio:false — so agentic chat and Deck
// Studio both vanished while every host-agnostic section still rendered.
test("detectHost: empty info.host in PowerPoint does NOT degrade to Office", () => {
  const inPowerPoint = { PowerPoint: {}, Office: { context: {} } };
  const host = detectHost({ host: undefined }, inPowerPoint);
  assert.equal(host, "PowerPoint");
  assert.notEqual(host, "Office", "Office would hide chat and Deck Studio");
});
