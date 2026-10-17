// Progress, cancellation and outcome rules.
//
// The deployment budget allows a 45-second worst case. That is only acceptable
// if the user can see the wait and end it — otherwise it is indistinguishable
// from the hang that started this work, where the model reasoned for 512
// seconds and returned nothing while the pane showed a static "Memproses...".

import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun, classifyOutcome, progressLabel, formatElapsed, REQUEST_BUDGET_MS,
  createStudioProgressRunner
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

// --- createStudioProgressRunner ---------------------------------------------
// A Studio action (Document/Workbook/Deck) is several phases, not one request:
// read source, call the model, write into Office. withProgress() (the generic
// one) freezes its label at whatever message the caller started with; these
// tests exist because that is not good enough for a run that legitimately
// takes minutes and changes what it is doing partway through.

function fakeElement() {
  return {
    disabled: undefined,
    textContent: "",
    _hidden: undefined,
    classList: {
      toggle(_cls, force) { this._hidden = force; }
    },
    _listeners: [],
    addEventListener(_type, fn) { this._listeners.push(fn); },
    removeEventListener(_type, fn) {
      this._listeners = this._listeners.filter((f) => f !== fn);
    },
    click() { [...this._listeners].forEach((fn) => fn()); }
  };
}

test("createStudioProgressRunner: Cancel starts disabled and is disabled again once the run ends", async () => {
  const cancelButton = fakeElement();
  const textEl = fakeElement();
  const progressEl = fakeElement();
  const withStudio = createStudioProgressRunner({
    progressEl, textEl, cancelButton, budgetMs: Infinity, report: () => {}
  });

  assert.equal(cancelButton.disabled, true, "disabled before any run has started");
  await withStudio("Mulai...", async () => {
    assert.equal(cancelButton.disabled, false, "enabled while a run is active");
  });
  assert.equal(cancelButton.disabled, true, "disabled again once the run ends");
});

test("createStudioProgressRunner: clicking Cancel actually aborts the run, reported as a warning not an error", async () => {
  const cancelButton = fakeElement();
  const textEl = fakeElement();
  const progressEl = fakeElement();
  let reported = null;
  const withStudio = createStudioProgressRunner({
    progressEl, textEl, cancelButton,
    budgetMs: Infinity,
    report: (message, status) => { reported = { message, status }; }
  });

  const runPromise = withStudio("Mulai...", async (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));

  // The button click is the ONLY thing connecting the user to the in-flight
  // request; if this doesn't reach it, Cancel is decorative.
  cancelButton.click();
  await runPromise;

  assert.ok(reported, "the outcome must be reported");
  assert.equal(reported.status, "warn", "a cancellation is not an error");
  assert.match(reported.message, /Dibatalkan/);
  assert.doesNotMatch(reported.message, /AbortError/i,
    "the user chose this; do not show them the transport's word for it");
});

test("createStudioProgressRunner: cleanup removes the click listener and stops the timer", async () => {
  const cancelButton = fakeElement();
  const textEl = fakeElement();
  const progressEl = fakeElement();
  let clearedId = null;
  const withStudio = createStudioProgressRunner({
    progressEl, textEl, cancelButton, budgetMs: Infinity,
    setInterval: () => 42,
    clearInterval: (id) => { clearedId = id; },
    report: () => {}
  });

  await withStudio("Mulai...", async () => {
    assert.equal(cancelButton._listeners.length, 1, "exactly one click listener while running");
  });

  assert.equal(cancelButton._listeners.length, 0, "click listener removed once the run ends");
  assert.equal(clearedId, 42, "the elapsed-clock interval must be cleared, or it repaints a finished run");
});

test("createStudioProgressRunner: elapsed labels keep updating against the newest phase, never snap back to the initial one", async () => {
  const cancelButton = fakeElement();
  const textEl = fakeElement();
  const progressEl = fakeElement();
  let clock = 0;
  let tick = null;
  const withStudio = createStudioProgressRunner({
    progressEl, textEl, cancelButton, budgetMs: Infinity,
    now: () => clock,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => {},
    report: () => {}
  });

  await withStudio("Fase awal...", async (signal, setPhase) => {
    assert.match(textEl.textContent, /Fase awal/);

    clock = 5000;
    tick(); // a natural elapsed tick, before any phase change
    assert.match(textEl.textContent, /Fase awal/);
    assert.match(textEl.textContent, /5 detik/);

    setPhase("Fase kedua...");
    assert.match(textEl.textContent, /Fase kedua/, "setPhase must repaint immediately");
    assert.doesNotMatch(textEl.textContent, /Fase awal/);

    clock = 9000;
    tick(); // the clock is still running: it must keep painting the NEW phase
    assert.match(textEl.textContent, /Fase kedua/);
    assert.match(textEl.textContent, /9 detik/);
    assert.doesNotMatch(textEl.textContent, /Fase awal/,
      "a tick after a phase change must not repaint the OLD phase");
  });
});
