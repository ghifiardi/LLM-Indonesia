// Verified-fix regression coverage: Document/Workbook/Deck Studio must use
// the scoped Studio progress wrapper (createStudioProgressRunner), and the
// AbortSignal it hands to `fn` must actually reach the model call — not just
// exist as an unused parameter.
//
// taskpane.js reads `document`/`Office` at module scope, so it cannot be
// imported and executed under node:test (see the established pattern in
// paneUploads.test.mjs / hostUi.test.mjs / startupIsolation.test.mjs). These
// assertions read the real source text instead, the same way those files do.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const js = fs.readFileSync(path.join(root, "src/taskpane.js"), "utf8");

// Top-level functions in this file start at column 0. Slicing to the next
// one gives the full body of a named function without needing a brace parser.
function topLevelFunctionBody(js2, name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\b`, "m");
  const match = marker.exec(js2);
  assert.ok(match, `function ${name} must exist in taskpane.js`);
  const start = match.index;
  const next = js2.slice(start + 1).search(/^(?:async )?function /m);
  return next === -1 ? js2.slice(start) : js2.slice(start, start + 1 + next);
}

// --- Cancel button connected (Finding 3: the buttons already exist in the
// HTML; this proves the JS actually wires them, not just the generic one) --

test("Document/Workbook/Deck Studio wrappers are built from the scoped Studio progress runner", () => {
  for (const name of ["withDocumentProgress", "withWorkbookProgress", "withDeckProgress"]) {
    const line = js.split("\n").find((l) => l.includes(`const ${name} = createStudioProgressRunner(`));
    assert.ok(line, `${name} must be created via createStudioProgressRunner, not a hand-rolled wrapper`);
  }
});

test("each Studio wrapper is wired to its own progress element and Cancel button, not the generic one", () => {
  const wirings = {
    withDocumentProgress: { progressEl: "els.documentProgress", cancelButton: "els.documentProgressCancel" },
    withWorkbookProgress: { progressEl: "els.workbookProgress", cancelButton: "els.workbookProgressCancel" },
    withDeckProgress: { progressEl: "els.deckProgress", cancelButton: "els.deckProgressCancel" }
  };
  for (const [name, expect] of Object.entries(wirings)) {
    const start = js.indexOf(`const ${name} = createStudioProgressRunner(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const block = js.slice(start, js.indexOf("});", start) + 3);
    assert.ok(block.includes(expect.progressEl), `${name} must toggle ${expect.progressEl}`);
    assert.ok(block.includes(expect.cancelButton), `${name} must wire ${expect.cancelButton}, not a different Studio's button`);
    assert.doesNotMatch(block, /els\.progressCancel\b/,
      `${name} must not fall back to the generic #progress-cancel button`);
  }
});

// --- Document Studio forwards the same AbortSignal into planDocument -------

test("resolveDocumentSpec accepts a signal and forwards it into planDocument", () => {
  const body = topLevelFunctionBody(js, "resolveDocumentSpec");
  assert.match(body, /async function resolveDocumentSpec\(signal, setPhase/,
    "resolveDocumentSpec must accept (signal, setPhase)");
  const planCall = body.slice(body.indexOf("await planDocument({"), body.indexOf("});", body.indexOf("await planDocument({")) + 3);
  assert.match(planCall, /\bsignal\b/, "the planDocument({...}) call must include signal");
});

test("createDocumentSmart and downloadDocumentSmart pass the wrapper's signal into resolveDocumentSpec", () => {
  for (const name of ["createDocumentSmart", "downloadDocumentSmart"]) {
    const body = topLevelFunctionBody(js, name);
    assert.match(body, /withDocumentProgress\([^,]+,\s*async \(signal, setPhase\)/,
      `${name} must open withDocumentProgress with an (signal, setPhase) callback`);
    assert.match(body, /resolveDocumentSpec\(signal, setPhase\)/,
      `${name} must forward the SAME signal/setPhase into resolveDocumentSpec, not call it bare`);
  }
});

test("Document Studio's inline table conversion also forwards its signal into runTantular", () => {
  const body = topLevelFunctionBody(js, "convertSelectionToTable");
  assert.match(body, /withDocumentProgress\([^,]+,\s*async \(signal, setPhase\)/);
  const callStart = body.indexOf("await runTantular({");
  assert.notEqual(callStart, -1);
  const call = body.slice(callStart, body.indexOf("});", callStart) + 3);
  assert.match(call, /\bsignal\b/, "the runTantular({...}) call must include signal");
});

// --- Same infrastructure applied to Workbook/Deck (P0: "where practical") --

test("resolveWorkbookSpec and resolveDeckSpec also accept and forward a signal", () => {
  const doc = topLevelFunctionBody(js, "resolveWorkbookSpec");
  assert.match(doc, /async function resolveWorkbookSpec\(signal, setPhase/);
  assert.match(doc.slice(doc.indexOf("await planWorkbook({")), /signal/);

  const deck = topLevelFunctionBody(js, "resolveDeckSpec");
  assert.match(deck, /async function resolveDeckSpec\(signal, setPhase/);
  const planCall = deck.slice(deck.indexOf("await planDeck({"), deck.indexOf("});", deck.indexOf("await planDeck({")) + 3);
  assert.match(planCall, /\bsignal\b/);
});

// --- No direct textContent writes left bypassing the phase tracker ---------
// A direct `els.xProgressText.textContent = "..."` write inside a Studio flow
// is exactly the bug this fix targets: the next elapsed-clock tick repaints
// from the WRAPPER's internal `phase` variable, which never learned about
// that write, so the newer phase gets silently overwritten by the initial
// one within about a second.

test("no Studio flow writes progress text directly outside the setPhase default parameter", () => {
  const offenders = [...js.matchAll(/els\.(document|workbook|deck)ProgressText\.textContent\s*=/g)]
    .map((m) => m[0]);
  // The only allowed occurrences are `setPhase = (text) => { ... }` default
  // parameters — one each for resolveDocumentSpec/resolveWorkbookSpec/
  // resolveDeckSpec, plus one more for maybeSummarize (Deck Studio's separate
  // summarize step, which resolveDeckSpec calls as its own function and so
  // needs its own default). They exist precisely so setPhase has somewhere to
  // write when a caller doesn't supply its own — any OTHER direct write
  // bypasses the phase tracker and gets clobbered by the next elapsed tick.
  assert.equal(offenders.length, 4,
    `expected exactly 4 direct textContent writes (the 4 setPhase defaults), found ${offenders.length}`);
});

// --- Cancel must actually stop the workflow (verified fix #2) --------------
// A Cancel click aborts resolveXSpec()'s in-flight model call, which now
// REJECTS (see documentPlanner.test.mjs et al.) instead of resolving to a
// fallback spec. That only stops Office insertion/download if the resolve
// call itself is NOT wrapped in a try/catch that would swallow the
// rejection and fall through to build/insert/download anyway.

test("Studio create/download actions do not catch resolveXSpec's rejection before Office insertion or download", () => {
  const cases = [
    { fn: "createDocumentSmart", resolve: "resolveDocumentSpec" },
    { fn: "downloadDocumentSmart", resolve: "resolveDocumentSpec" },
    { fn: "createWorkbookSmart", resolve: "resolveWorkbookSpec" },
    { fn: "downloadWorkbookSmart", resolve: "resolveWorkbookSpec" },
    { fn: "createDeckSmart", resolve: "resolveDeckSpec" },
    { fn: "downloadDeckSmart", resolve: "resolveDeckSpec" }
  ];
  for (const { fn, resolve } of cases) {
    const body = topLevelFunctionBody(js, fn);
    const resolveIdx = body.indexOf(`await ${resolve}(`);
    assert.notEqual(resolveIdx, -1, `${fn} must call ${resolve}`);
    // The withXProgress(...) call already provides the ONE catch that
    // classifies cancellation vs. error (see createStudioProgressRunner).
    // A second `try {` opened before the resolve call and still open at
    // that point would swallow the rejection right there instead of
    // letting it propagate out to that classifier — and worse, execution
    // would then fall through to whatever code follows inside that try,
    // which is exactly the insertion/download path this guards against.
    const beforeResolve = body.slice(0, resolveIdx);
    assert.doesNotMatch(beforeResolve, /\btry\s*\{/,
      `${fn} must not wrap the ${resolve} call in its own try/catch — ` +
      "a Cancel-triggered rejection must propagate straight out to withXProgress, " +
      "not be caught here and fall through to building/inserting/downloading");
  }
});
