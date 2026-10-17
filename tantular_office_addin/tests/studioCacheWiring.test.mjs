// Verified-fix follow-up: Create followed immediately by Download must not
// call the model a second time for the exact same job. taskpane.js reads
// `document`/`Office` at module scope, so it cannot be imported and executed
// under node:test (see paneUploads.test.mjs / hostUi.test.mjs /
// studioProgressWiring.test.mjs) — these assertions read the real source
// text, the same way those files do.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const js = fs.readFileSync(path.join(root, "src/taskpane.js"), "utf8");

function topLevelFunctionBody(js2, name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\b`, "m");
  const match = marker.exec(js2);
  assert.ok(match, `function ${name} must exist in taskpane.js`);
  const start = match.index;
  const next = js2.slice(start + 1).search(/^(?:async )?function /m);
  return next === -1 ? js2.slice(start) : js2.slice(start, start + 1 + next);
}

test("resolveDocumentSpec/resolveWorkbookSpec/resolveDeckSpec each check a fingerprint before calling the model", () => {
  for (const [fn, planCall, cacheField] of [
    ["resolveDocumentSpec", "await planDocument(", "documentSpecFingerprint"],
    ["resolveWorkbookSpec", "await planWorkbook(", "workbookSpecFingerprint"],
    ["resolveDeckSpec", "await planDeck(", "deckSpecFingerprint"]
  ]) {
    const body = topLevelFunctionBody(js, fn);
    const fingerprintIdx = body.indexOf("fingerprintStudioInputs(");
    const cacheCheckIdx = body.indexOf(`state.${cacheField} === fingerprint`);
    const planIdx = body.indexOf(planCall);
    assert.notEqual(fingerprintIdx, -1, `${fn} must compute a fingerprint via fingerprintStudioInputs`);
    assert.notEqual(cacheCheckIdx, -1, `${fn} must compare it against state.${cacheField}`);
    assert.notEqual(planIdx, -1, `${fn} must still call ${planCall.trim()} on a cache miss`);
    assert.ok(fingerprintIdx < cacheCheckIdx && cacheCheckIdx < planIdx,
      `${fn} must check the cache BEFORE calling the model, not after`);
  }
});

test("fingerprintStudioInputs is fed the mode and model, not just source/options/instruction", () => {
  for (const fn of ["resolveDocumentSpec", "resolveWorkbookSpec", "resolveDeckSpec"]) {
    const body = topLevelFunctionBody(js, fn);
    const start = body.indexOf("fingerprintStudioInputs(");
    const call = body.slice(start, body.indexOf(")", body.indexOf("model:", start)) + 1);
    assert.match(call, /mode:\s*settings\.mode/, `${fn}'s fingerprint must include the current mode`);
    assert.match(call, /model:\s*settings\.deckModel/, `${fn}'s fingerprint must include the current model`);
  }
});

test("a cache hit replays the existing spec and preview without calling the model", () => {
  for (const [fn, specField, sourceField] of [
    ["resolveDocumentSpec", "documentSpec", "documentSpecSource"],
    ["resolveWorkbookSpec", "workbookSpec", "workbookSpecSource"],
    ["resolveDeckSpec", "deckSpec", "deckSpecSource"]
  ]) {
    const body = topLevelFunctionBody(js, fn);
    const hitIdx = body.indexOf(`if (state.${specField} && state.`);
    assert.notEqual(hitIdx, -1, `${fn} must have a cache-hit branch keyed on state.${specField}`);
    const planIdx = body.indexOf("await plan");
    assert.ok(hitIdx < planIdx, `${fn}'s cache-hit branch must come before the model call, i.e. actually short-circuit it`);
    const hitBlock = body.slice(hitIdx, body.indexOf("return", hitIdx) + 200);
    assert.match(hitBlock, /render(Document|Workbook|Deck)Preview\(/, `${fn}'s cache hit must still repaint the preview`);
    assert.match(hitBlock, new RegExp(`state\\.${sourceField}`), `${fn}'s cache hit must report the ORIGINAL result source, not invent one`);
  }
});

test("a fallback (non-model) result is never cached — Download after a failed Create must retry the model", () => {
  for (const [fn, cacheField] of [
    ["resolveDocumentSpec", "documentSpecFingerprint"],
    ["resolveWorkbookSpec", "workbookSpecFingerprint"]
  ]) {
    const body = topLevelFunctionBody(js, fn);
    assert.match(body, new RegExp(`state\\.${cacheField} = result\\.source === "model" \\? fingerprint : ""`),
      `${fn} must only persist the fingerprint when the result genuinely came from the model`);
  }
  const deckBody = topLevelFunctionBody(js, "resolveDeckSpec");
  assert.match(deckBody, /if \(source === "model"\) \{\s*state\.deckSpecFingerprint = fingerprint;/,
    "resolveDeckSpec must only persist the fingerprint on a genuine model result, not a fallback deck");
});

test("resolveDocumentSpec restores the full auto-loaded Word source before fingerprinting (long-source cache fix)", () => {
  const body = topLevelFunctionBody(js, "resolveDocumentSpec");
  const restoreIdx = body.indexOf("resolveAutoLoadedSource(");
  const fingerprintIdx = body.indexOf("fingerprintStudioInputs(");
  const contentAssignIdx = body.indexOf("content = autoLoaded.content;");
  assert.notEqual(restoreIdx, -1, "resolveDocumentSpec must call resolveAutoLoadedSource");
  assert.notEqual(contentAssignIdx, -1, "resolveDocumentSpec must actually use resolveAutoLoadedSource's result as `content`");
  assert.ok(restoreIdx < contentAssignIdx && contentAssignIdx < fingerprintIdx,
    "the full source must be restored BEFORE the fingerprint is computed, or a long Word source still fingerprints the truncated preview");

  // The stored full source must be tracked separately from the preview
  // written into the textarea, or there is nothing to restore from.
  assert.match(body, /state\.documentSourceText\s*=\s*content;/,
    "the Word auto-read branch must store the FULL content, not the preview, in documentSourceText");
  assert.match(body, /els\.sourceText\.value\s*=\s*preview;/,
    "the textarea must still only ever display the bounded preview");
});
