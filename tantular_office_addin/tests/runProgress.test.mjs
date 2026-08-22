// Progress, cancellation and outcome rules.
//
// The deployment budget allows a 45-second worst case. That is only acceptable
// if the user can see the wait and end it — otherwise it is indistinguishable
// from the hang that started this work, where the model reasoned for 512
// seconds and returned nothing while the pane showed a static "Memproses...".

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun, classifyOutcome, progressLabel, formatElapsed, REQUEST_BUDGET_MS
} from "../src/chat/runProgress.js";

test("the progress line is never blank, even with no message", () => {
  // A blank progress line IS the looks-hung state.
  for (const message of ["", "   ", null, undefined]) {
    const label = progressLabel(message, 0);
    assert.ok(label.trim().length > 0, `blank label for ${JSON.stringify(message)}`);
    assert.match(label, /Memproses/);
  }
});

test("the progress line always shows elapsed time", () => {
  assert.match(progressLabel("Menjalankan...", 0), /0 detik/);
  assert.match(progressLabel("Menjalankan...", 12_000), /12 detik/);
  assert.match(progressLabel("Menjalankan...", 61_000), /1 menit 01 detik/);
});

test("passing the budget is said out loud, and offers the way out", () => {
  const label = progressLabel("Menjalankan...", REQUEST_BUDGET_MS + 1000);
  assert.match(label, /melewati batas/);
  assert.match(label, /dibatalkan/);
});

test("a cancellation is not reported as an error", () => {
  const outcome = classifyOutcome(new Error("The operation was aborted"),
                                  { cancelled: true });
  assert.equal(outcome.kind, "cancelled");
  assert.notEqual(outcome.status, "error");
  assert.match(outcome.message, /Dibatalkan/);
  assert.doesNotMatch(outcome.message, /abort/i,
    "the user chose this; do not show them the transport's word for it");
});

test("a budget timeout is distinct from both cancel and a generic error", () => {
  const timeout = classifyOutcome(new Error("aborted"), { timedOut: true });
  assert.equal(timeout.kind, "timeout");
  assert.match(timeout.message, /Waktu habis/);
  const generic = classifyOutcome(new Error("connection refused"));
  assert.equal(generic.kind, "error");
  assert.match(generic.message, /connection refused/);
});

test("cancel aborts the signal and is distinguishable from a timeout", () => {
  const run = createRun({ budgetMs: Infinity });
  assert.equal(run.signal.aborted, false);
  run.cancel();
  assert.equal(run.signal.aborted, true);
  assert.equal(run.cancelled, true);
  assert.equal(run.timedOut, false);
  run.finish();
});

test("the budget aborts the run and marks it timed out, not cancelled", () => {
  let fire = null;
  const run = createRun({
    budgetMs: 45_000,
    setTimeout: (fn) => { fire = fn; return 1; },
    clearTimeout: () => {},
  });
  assert.equal(run.signal.aborted, false);
  fire();
  assert.equal(run.signal.aborted, true);
  assert.equal(run.timedOut, true);
  assert.equal(run.cancelled, false, "a budget timeout is not a user cancel");
  run.finish();
});

test("the elapsed clock ticks about once a second and stops on finish", () => {
  const ticks = [];
  let tick = null, cleared = false, clock = 0;
  const run = createRun({
    budgetMs: Infinity,
    onTick: (ms) => ticks.push(ms),
    now: () => clock,
    setInterval: (fn) => { tick = fn; return 7; },
    clearInterval: (id) => { cleared = id === 7; },
  });
  clock = 1000; tick();
  clock = 2000; tick();
  assert.deepEqual(ticks, [1000, 2000]);
  run.finish();
  assert.ok(cleared, "the ticker must stop, or it repaints a finished run");
});
