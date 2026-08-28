import test from "node:test";
import assert from "node:assert/strict";

// Minimal stand-in for the browser engine, driven manually so the exact
// push-to-talk sequences can be replayed without a microphone.
class FakeRecognition {
  constructor() { this.lang = ""; this.started = 0; }
  start() { this.started += 1; }
  stop() {}
  emitInterim(text) {
    this.onresult({ resultIndex: 0, results: withLength([[{ transcript: text, confidence: null }, false]]) });
  }
  emitFinal(text, confidence = 0.9) {
    this.onresult({ resultIndex: 0, results: withLength([[{ transcript: text, confidence }, true]]) });
  }
  emitError(code) { this.onerror({ error: code }); }
  emitEnd() { this.onend(); }
}
function withLength(rows) {
  const arr = rows.map(([alt, isFinal]) => { const r = [alt]; r.isFinal = isFinal; return r; });
  arr.length = rows.length;
  return arr;
}

async function makeController(overrides = {}) {
  const fake = new FakeRecognition();
  globalThis.window = { SpeechRecognition: function () { return fake; } };
  const { VoiceController } = await import("../voiceController.js?" + Math.random());
  const results = [];
  const errors = [];
  const vc = new VoiceController({
    language: "id-ID",
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { vc, fake, results, errors };
}

// The reported failure: HUD showed LIVE TRANSCRIPT "Berikutnya next", LAST
// FINAL empty, STATUS "Recognition error: aborted" — the words were heard and
// then thrown away, so nothing moved.
test("an interim transcript is not lost when the session aborts", async () => {
  const { vc, fake, results } = await makeController();
  vc.start();
  fake.emitInterim("Berikutnya next");
  fake.emitError("aborted");

  const finals = results.filter((r) => r.isFinal);
  assert.equal(finals.length, 1, "the captured words must still produce a command");
  assert.equal(finals[0].transcript, "Berikutnya next");
  assert.equal(finals[0].salvaged, true, "and be marked as a partial, not a true final");
});

test("a benign abort with salvaged speech reports no error", async () => {
  const { vc, fake, errors } = await makeController();
  vc.start();
  fake.emitInterim("lanjutkan");
  fake.emitError("aborted");
  assert.equal(errors.length, 0, "a working mic must not be reported in red");
});

test("silence reports a helpful message, not a raw error code", async () => {
  const { vc, fake, errors, results } = await makeController();
  vc.start();
  fake.emitError("no-speech");
  assert.equal(results.filter((r) => r.isFinal).length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].recoverable, true);
  assert.ok(!/no-speech/.test(errors[0].message), "raw engine codes help nobody");
  assert.match(errors[0].message, /Tahan Space/);
});

test("a genuine fault is still surfaced", async () => {
  const { vc, fake, errors } = await makeController();
  vc.start();
  fake.emitError("network");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].recoverable, false, "a real fault is not recoverable by holding longer");
  assert.match(errors[0].message, /network/);
});

test("a real final wins; the interim is not replayed on top of it", async () => {
  const { vc, fake, results } = await makeController();
  vc.start();
  fake.emitInterim("lanjut");
  fake.emitFinal("lanjutkan");
  fake.emitEnd();

  const finals = results.filter((r) => r.isFinal);
  assert.equal(finals.length, 1, "salvage must not double-fire after a real final");
  assert.equal(finals[0].transcript, "lanjutkan");
  assert.notEqual(finals[0].salvaged, true);
});

test("ending normally after interim-only still yields a command", async () => {
  const { vc, fake, results } = await makeController();
  vc.start();
  fake.emitInterim("buka bagian harga");
  fake.emitEnd();
  const finals = results.filter((r) => r.isFinal);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].transcript, "buka bagian harga");
});

test("a new session does not resurrect the previous one's interim", async () => {
  const { vc, fake, results } = await makeController();
  vc.start();
  fake.emitInterim("lanjutkan");
  fake.emitEnd();
  const afterFirst = results.filter((r) => r.isFinal).length;

  vc.start();
  fake.emitEnd();
  assert.equal(results.filter((r) => r.isFinal).length, afterFirst,
    "stale speech from an earlier hold must never fire later");
});

test("the same salvaged phrase does not fire twice in the dedupe window", async () => {
  const { vc, fake, results } = await makeController();
  vc.start();
  fake.emitInterim("lanjutkan");
  fake.emitError("aborted");
  vc.start();
  fake.emitInterim("lanjutkan");
  fake.emitError("aborted");
  assert.equal(results.filter((r) => r.isFinal).length, 1, "one utterance, one command");
});
