import test from "node:test";
import assert from "node:assert/strict";
import {
  concatFloat32,
  downsample,
  encodeWav,
  endpointIsLocal,
  replyLanguage,
  speakableText,
  voiceBlockReason,
  voiceUrl
} from "../src/chat/voiceCore.js";

// voiceBlockReason/voiceUrl are the privacy boundary for spoken turns: a
// failure here means audio or a transcript could leave the Mac.

test("voice routes never resolve to a same-origin path on a hosted page", () => {
  assert.equal(voiceUrl("/api/voice/status", "localhost"), "/api/voice/status");
  assert.equal(voiceUrl("/api/voice/status", "127.0.0.1"), "/api/voice/status");
  assert.equal(voiceUrl("api/voice/status", "tantular.example.com"), "https://localhost:3000/api/voice/status");
});

test("only loopback endpoints count as local", () => {
  assert.equal(endpointIsLocal("https://localhost:3000/api/chat-completions", "tantular.example.com"), true);
  assert.equal(endpointIsLocal("http://127.0.0.1:11434/v1/chat/completions", "localhost"), true);
  assert.equal(endpointIsLocal("/api/chat-completions", "localhost"), true);
  // A relative endpoint on a hosted page is the cloud gateway.
  assert.equal(endpointIsLocal("/api/chat-completions", "tantular.example.com"), false);
  assert.equal(endpointIsLocal("https://gateway.example.com/v1/chat/completions", "localhost"), false);
  assert.equal(endpointIsLocal("https://localhost.example.com/v1", "localhost"), false);
  assert.equal(endpointIsLocal("", "localhost"), false);
  assert.equal(endpointIsLocal("not a url", "localhost"), false);
});

test("cloud mode, portal, and remote endpoints each block voice", () => {
  const local = "https://localhost:3000/api/chat-completions";
  assert.match(voiceBlockReason({ cloudSession: true, portal: false, endpoint: local, pageHostname: "localhost" }), /Mode Cloud/);
  assert.match(voiceBlockReason({ cloudSession: false, portal: true, endpoint: local, pageHostname: "x.example" }), /Companion/);
  assert.match(voiceBlockReason({ cloudSession: false, portal: false, endpoint: "https://api.example.com/v1", pageHostname: "localhost" }), /bukan model lokal/);
  assert.equal(voiceBlockReason({ cloudSession: false, portal: false, endpoint: local, pageHostname: "x.example" }), "");
});

test("WAV encoding produces a 16-bit mono PCM header whisper.cpp accepts", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
  const view = new DataView(encodeWav(samples, 16000));
  const ascii = (offset) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));
  assert.equal(ascii(0), "RIFF");
  assert.equal(ascii(8), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.getInt16(44 + 3 * 2, true), 0x7fff);
  assert.equal(view.getInt16(44 + 4 * 2, true), -0x8000);
  assert.equal(view.getInt16(44 + 5 * 2, true), 0x7fff, "clipped");
});

test("downsampling 48 kHz to 16 kHz keeps duration and averages windows", () => {
  const input = new Float32Array(48000).fill(0.25);
  const out = downsample(input, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - 0.25) < 1e-6);
  assert.equal(downsample(new Float32Array(10), 16000, 16000).length, 10);
  assert.deepEqual([...concatFloat32([new Float32Array([1]), new Float32Array([2, 3])])], [1, 2, 3]);
});

test("spoken replies drop markdown, summarize tables, and cap length", () => {
  const spoken = speakableText("## Ringkasan\n- **Poin satu**\n- `kode` dua\n| a | b |\n|---|---|\n| 1 | 2 |\nLihat https://example.com", "id");
  assert.equal(spoken, "Ringkasan. Poin satu. kode dua. Tabelnya ada di layar. Lihat.");
  const long = speakableText(Array.from({ length: 200 }, (_, i) => `Kalimat nomor ${i}.`).join(" "), "en");
  assert.ok(long.length < 1300);
  assert.match(long, /The rest is on screen\.$/);
});

test("reply language follows the reply text, falling back to the spoken language", () => {
  assert.equal(replyLanguage("Ini adalah ringkasan yang Anda minta dan sudah selesai.", "en"), "id");
  assert.equal(replyLanguage("This is the summary you asked for, and it is done.", "id"), "en");
  assert.equal(replyLanguage("OK.", "en"), "en");
  assert.equal(replyLanguage("OK.", "fr"), "id");
});
