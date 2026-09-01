// 2026-09-01: a RINGKAS (summarize) chat result had no way to reach the
// document at all — addDocumentAnswerActions() (the insert-action buttons)
// only ever fired for TANYA_DOKUMEN, and the single DRAFT_TEKS insert button
// is gated on a different intent entirely. A user could read a summary in
// the chat pane and never insert it. src/chat/chatPane.js reads `document`
// at module scope in mountChatPane() (called immediately by callers, not
// guarded), so it cannot be imported and executed under node:test — same
// class of file as taskpane.js (see paneUploads.test.mjs / hostUi.test.mjs /
// studioCacheWiring.test.mjs). These assertions read the real source text.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const js = fs.readFileSync(path.join(root, "src/chat/chatPane.js"), "utf8");

function topLevelFunctionBody(js2, name) {
  const marker = new RegExp(`function ${name}\\b`, "m");
  const match = marker.exec(js2);
  assert.ok(match, `function ${name} must exist in chatPane.js`);
  const start = match.index;
  const next = js2.slice(start + 1).search(/\n {6}(?:async )?function /);
  return next === -1 ? js2.slice(start) : js2.slice(start, start + 1 + next);
}

test("RINGKAS results get the document insert-action buttons, same as TANYA_DOKUMEN", () => {
  const callSite = js.match(/if \(intent === "TANYA_DOKUMEN"[^)]*\) addDocumentAnswerActions\(answer, result\);/);
  assert.ok(callSite, "expected the addDocumentAnswerActions() call site");
  assert.match(callSite[0], /intent === "RINGKAS"/,
    "a RINGKAS summary must be able to reach the document — it previously had no insert action at all");
});

test("addDocumentAnswerActions still requires a user click for every insert path — never automatic", () => {
  const body = topLevelFunctionBody(js, "addDocumentAnswerActions");
  // Every insert-capable call (insertStructuredTextIntoWord /
  // insertStructuredTextAfterSelection / appendStructuredTextToWord) must be
  // reached only from inside an addEventListener("click", ...) handler.
  const insertCalls = [...body.matchAll(/(insertStructuredTextIntoWord|insertStructuredTextAfterSelection|appendStructuredTextToWord)\(/g)];
  assert.ok(insertCalls.length >= 3, "expected all three insert actions to still be present");
  const clickHandlerCount = (body.match(/addEventListener\("click"/g) || []).length;
  assert.ok(clickHandlerCount >= 3,
    "every insert action must be gated behind its own button click, matching this pane's existing confirm-gated writes — never automatic");
});

test("DRAFT_TEKS's separate single insert button is unaffected by the RINGKAS fix", () => {
  assert.match(js, /result\.kind === "text" && intent === "DRAFT_TEKS" && result\.text/);
});
