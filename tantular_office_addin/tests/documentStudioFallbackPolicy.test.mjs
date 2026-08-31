// 2026-08-31 fail-closed follow-up: the user explicitly does not want the
// interactive Document Studio path silently downgrading a slow Q8 request to
// Lite and persisting it as the new default. taskpane.js reads
// `document`/`Office` at module scope, so it cannot be imported and executed
// under node:test (see paneUploads.test.mjs / hostUi.test.mjs /
// studioCacheWiring.test.mjs) — these assertions read the real source text,
// the same way those files do.

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

test("the live Document Studio planDocument() call disables the automatic Lite downgrade", () => {
  const body = topLevelFunctionBody(js, "resolveDocumentSpec");
  const planCallIndex = body.indexOf("await planDocument(");
  assert.ok(planCallIndex >= 0, "resolveDocumentSpec must call planDocument");
  // The call is a single statement — the closing paren of the object literal
  // is what ends it, so scanning forward to the matching "});" keeps this
  // robust to argument reordering.
  const callEnd = body.indexOf("});", planCallIndex);
  const callText = body.slice(planCallIndex, callEnd);
  assert.match(callText, /modelFallbackPolicy:\s*"none"/,
    "a live Document Studio timeout must be reported as a timeout, not silently answered by (and persisted as) Lite");
});

test("makes exactly one model request on a timeout: modelFallbackPolicy 'none' never calls findInstalledLiteModel or persists settings (verified at the tantularClient.js level)", async () => {
  // resolveDocumentSpec's own behavior on a timeout is fully determined by
  // runTantular's modelFallbackPolicy handling, already covered end-to-end
  // by tests/tantularClientStream.test.mjs's "modelFallbackPolicy 'none'"
  // test (exactly one attempt, no Lite, no settings write, timeout surfaced
  // as an error). This test only pins that the CALL SITE actually opts in —
  // see the test above — so a future edit that silently drops the option
  // cannot slip through undetected here even without re-running a live model.
  const body = topLevelFunctionBody(js, "resolveDocumentSpec");
  assert.doesNotMatch(body, /modelFallbackPolicy:\s*"timeout-and-missing"/,
    "must not opt back into the silent-downgrade default for the interactive path");
});

test("a fallback caused by invalid model output shows a clear, non-raw-output warning", () => {
  const marker = /function documentFallbackNote\(/;
  assert.match(js, marker, "documentFallbackNote must exist");
  const start = js.search(marker);
  const next = js.slice(start + 1).search(/^(?:async )?function /m);
  const body = next === -1 ? js.slice(start) : js.slice(start, start + 1 + next);
  assert.match(body, /invalid_json/);
  assert.match(body, /invalid_structure/);
  assert.match(body, /struktur/i);
  assert.match(body, /tidak valid/i);
  // Must never interpolate the model's own raw text/spec content into the note.
  assert.doesNotMatch(body, /result\.spec/);
  assert.doesNotMatch(body, /result\.error\b/, "must show a fixed classification message, not the raw error/model text");
});

test("createDocumentSmart surfaces the fallback note on both the Word-insert and download paths", () => {
  const body = topLevelFunctionBody(js, "createDocumentSmart");
  assert.match(body, /documentFallbackNote\(result\)/);
  const fallbackNoteUses = (body.match(/fallbackNote/g) || []).length;
  assert.ok(fallbackNoteUses >= 3, "the computed note must actually be used in the status messages, not just computed and discarded");
});

// 2026-08-31 verification follow-up: a fallback caused by invalid model
// output was being displayed with success ("ok") styling on Create, and the
// direct-Download path discarded resolveDocumentSpec's result entirely — a
// Download right after an invalid-JSON/invalid-structure fallback produced
// the local fallback file while telling the user nothing went wrong.

test("createDocumentSmart uses warning status severity when a fallback note is present, not 'ok'", () => {
  const body = topLevelFunctionBody(js, "createDocumentSmart");
  // Both status calls (Word-insert success, and the non-Word/failed-insert
  // download branch) must condition their severity on fallbackNote rather
  // than hardcoding "ok".
  const statusCalls = body.match(/setDocumentStatus\([^;]*?,\s*[^)]+\)/gs) || [];
  const successPathCalls = statusCalls.filter((call) => call.includes("fallbackNote"));
  assert.ok(successPathCalls.length >= 2, "expected at least 2 setDocumentStatus calls that reference fallbackNote");
  for (const call of successPathCalls) {
    assert.match(call, /fallbackNote\s*\?\s*"warn"\s*:\s*"ok"/,
      `severity must switch to "warn" when fallbackNote is set, not stay hardcoded "ok": ${call}`);
  }
});

test("downloadDocumentSmart captures resolveDocumentSpec's result and reports warning severity on an invalid-output fallback", () => {
  const body = topLevelFunctionBody(js, "downloadDocumentSmart");
  assert.match(body, /const result\s*=\s*await resolveDocumentSpec\(/,
    "the result must be captured, not discarded — otherwise a Download after an invalid model response silently produces the fallback file");
  assert.match(body, /documentFallbackNote\(result\)/);
  assert.match(body, /fallbackNote\s*\?\s*"warn"\s*:\s*"ok"/,
    "Download must also switch to warning severity, matching Create's behavior");
});
