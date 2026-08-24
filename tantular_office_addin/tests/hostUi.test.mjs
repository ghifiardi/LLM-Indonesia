import fs from "node:fs";
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

// manifest.xml loads this page with ?host=<Name> baked into each Host's own
// SourceLocation. This must win over every other signal, because it is the
// only one guaranteed correct even when the host populates NOTHING (no
// info.host, no Office.context.host, no diagnostics.host, no requirement
// sets) and the document is unsaved (no extension to fall back to) — the
// combination that still left the pane degrading to "Office" after every
// other fallback was added.
test("detectHost: the manifest's ?host= query param wins over everything, including a blank host", () => {
  const globals = { location: { search: "?host=PowerPoint" } };
  assert.equal(detectHost({}, globals), "PowerPoint");
  assert.equal(detectHost({ host: "Word" }, globals), "PowerPoint");
});

test("detectHost: missing ?host= falls through to the other signals unaffected", () => {
  const globals = { location: { search: "" }, Office: { context: { host: "Excel" } } };
  assert.equal(detectHost({}, globals), "Excel");
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

test("detectHost: falls back to Office.context.diagnostics.host", () => {
  // The layer that matters on an Office perpetual build: info.host and
  // Office.context.host are both empty, no host namespace is injected, and no
  // requirement set answers — but diagnostics.host still names the host.
  const globals = { Office: { context: { diagnostics: { host: "PowerPoint" } } } };
  assert.equal(detectHost({}, globals), "PowerPoint");
});

test("detectHost: last resort is the open document's extension", () => {
  const inPowerPoint = { Office: { context: { document: { url: "/Users/x/Deck Q3.pptx" } } } };
  assert.equal(detectHost({}, inPowerPoint), "PowerPoint");

  const inExcel = { Office: { context: { document: { url: "https://example.com/a/Book1.xlsx?web=1" } } } };
  assert.equal(detectHost({}, inExcel), "Excel");

  const inWord = { Office: { context: { document: { url: "C:\\Users\\x\\Surat.docx" } } } };
  assert.equal(detectHost({}, inWord), "Word");
});

// REGRESSION: the whole point of the fallback chain is that a host which
// answers nothing must not silently become "Office". Every signal a real
// PowerPoint can offer, one at a time, must reach "PowerPoint".
test("detectHost: any single PowerPoint signal is enough", () => {
  const signals = [
    [{ host: "PowerPoint" }, {}],
    [{}, { Office: { context: { host: "PowerPoint" } } }],
    [{}, { Office: { context: { diagnostics: { host: "PowerPoint" } } } }],
    [{}, { PowerPoint: {} }],
    [{}, { Office: { context: { requirements: { isSetSupported: (n) => n === "PowerPointApi" } } } }],
    [{}, { Office: { context: { document: { url: "deck.pptx" } } } }]
  ];
  for (const [info, globals] of signals) {
    assert.equal(detectHost(info, globals), "PowerPoint", `signal failed: ${JSON.stringify(globals)}`);
  }
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

// REGRESSION: a dropped promise made a broken Excel/PowerPoint chat look
// exactly like a host that has no chat. mountChatPane() delegates to
// excelChat/pptChat via dynamic import; when it did not RETURN that promise,
// the .catch() in taskpane.js had nothing to attach to, so a mount failure
// produced an empty gap between the mode banner and the settings card and no
// error anywhere. Both branches must hand the promise back to the caller.
test("chatPane: Excel and PowerPoint branches return their mount promise", () => {
  const source = fs.readFileSync(new URL("../src/chat/chatPane.js", import.meta.url), "utf8");
  for (const module of ["./excelChat.js", "./pptChat.js"]) {
    const line = source.split("\n").find((text) => text.includes(`import("${module}")`));
    assert.ok(line, `no dynamic import of ${module} found`);
    assert.match(line, /return import\(/, `import("${module}") must be returned, not dropped`);
  }
});

// The startup steps in Office.onReady must stay independent: a throw in one
// must not truncate the callback before the chat mounts.
test("taskpane: startup steps are individually guarded", () => {
  const source = fs.readFileSync(new URL("../src/taskpane.js", import.meta.url), "utf8");
  assert.match(source, /step\("renderForHost", renderForHost\)/);
  assert.match(source, /step\("mountWorkspaceUi", mountWorkspaceUi\)/);
  assert.match(source, /function step\(name, fn\)[\s\S]{0,200}try \{/);
});
