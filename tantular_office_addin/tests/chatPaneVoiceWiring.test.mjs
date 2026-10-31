// Source-level wiring checks for push-to-talk, in the style of the other
// *Wiring tests: the DOM/Office pieces cannot run under node, but the
// invariants that keep voice local and keep edits confirm-gated are visible
// in the source.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("spoken turns go through the same send() as typed ones", () => {
  const pane = read("src/chat/chatPane.js");
  assert.match(pane, /async function send\(spokenText = null, \{ voice = false \} = \{\}\)/);
  assert.match(pane, /mountVoiceControls\(\{ card, send, isBusy: \(\) => state\.busy, addBubble \}\)/);
  // Edits still only reach the document through the preview's own button.
  assert.match(pane, /renderEditPreview\(\{\s*container: els\.messages,\s*edits: result\.edits/);
  assert.doesNotMatch(read("src/chat/voiceControls.js"), /applyEdits|renderEditPreview|insertStructuredText/);
});

test("voice controls gate on locality before recording and again before sending", () => {
  const voice = read("src/chat/voiceControls.js");
  const checks = voice.match(/currentVoiceBlockReason\(\)/g) || [];
  assert.ok(checks.length >= 3, "status, record start, and pre-send checks");
  const sendIndex = voice.indexOf("await send(transcript");
  const lastCheck = voice.lastIndexOf("currentVoiceBlockReason()", sendIndex);
  assert.ok(lastCheck > voice.indexOf("/api/voice/transcribe"), "re-check happens after transcription, before send");
  // companionUrl() returns a same-origin (cloud gateway) path on the hosted
  // pane; voice traffic must use voiceUrl() instead.
  assert.doesNotMatch(voice, /companionUrl\(/);
  assert.match(voice, /fetch\(voiceUrl\(pathname\)/);
});

test("the task pane ships the push-to-talk controls hidden until mounted", () => {
  const html = read("src/taskpane.html");
  assert.match(html, /id="chat-voice-row" class="chat-voice-row hidden"/);
  for (const id of ["chat-mic", "chat-voice-lang", "chat-voice-speak", "chat-voice-status"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="id">Bahasa Indonesia<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
});
