// Progress, cancellation and outcome classification for a model run.
//
// A 45-second worst case is only acceptable if the user can see it happening
// and stop it. Before this, a slow Studio action showed a static "Memproses..."
// with no elapsed time and no way out — indistinguishable from the hang that
// started this whole investigation, where the model reasoned for 512 seconds
// and returned nothing.
//
// Kept as pure functions plus one small controller so the behaviour can be
// tested without a DOM. The task pane owns the elements; this owns the rules.

// The deployment budget: p95 <= 30s, any single request <= 45s.
// See calibration/DEPLOYMENT_BUDGET_POLICY.md in the distillation repo.
export const REQUEST_BUDGET_MS = 45_000;

// Studio deck generation legitimately exceeds the request budget — it is many
// slides of output, not one answer, and it was never what the 45s budget
// measured. It still gets elapsed time and a cancel button; what it does not
// get is a 45s cap that would break a working feature.
export const DECK_BUDGET_MS = 480_000;

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} detik`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} menit ${String(seconds % 60).padStart(2, "0")} detik`;
}

// Never returns an empty string. An empty progress line is exactly the
// "looks hung" state this exists to prevent.
export function progressLabel(message, elapsedMs, budgetMs = REQUEST_BUDGET_MS) {
  const base = String(message || "").trim() || "Memproses...";
  const elapsed = formatElapsed(elapsedMs);
  const overBudget = Number.isFinite(budgetMs) && elapsedMs > budgetMs;
  return overBudget
    ? `${base} ${elapsed} — melewati batas ${formatElapsed(budgetMs)}, boleh dibatalkan`
    : `${base} ${elapsed}`;
}

// A cancellation is NOT an error. Reporting "Error: aborted" for something the
// user chose teaches people to distrust the error channel.
export function classifyOutcome(error, { cancelled = false, timedOut = false } = {}) {
  if (cancelled) {
    return { kind: "cancelled", status: "warn",
             message: "Dibatalkan oleh pengguna." };
  }
  if (timedOut) {
    return { kind: "timeout", status: "error",
             message: "Waktu habis sebelum model menjawab. Coba lagi, "
                      + "perpendek teks sumber, atau pakai model yang lebih kecil." };
  }
  const text = error?.message || String(error || "Kesalahan tidak diketahui");
  return { kind: "error", status: "error", message: text };
}

// One in-flight run: an AbortController, a budget timer, and the elapsed clock.
// `onTick` is called about once a second so the pane can repaint.
export function createRun({ budgetMs = REQUEST_BUDGET_MS, onTick = null,
                            now = () => Date.now(),
                            setInterval: setIntervalFn = setInterval,
                            clearInterval: clearIntervalFn = clearInterval,
                            setTimeout: setTimeoutFn = setTimeout,
                            clearTimeout: clearTimeoutFn = clearTimeout } = {}) {
  const controller = new AbortController();
  const startedAt = now();
  let cancelled = false;
  let timedOut = false;

  const ticker = onTick
    ? setIntervalFn(() => onTick(now() - startedAt), 1000)
    : null;
  const budgetTimer = Number.isFinite(budgetMs)
    ? setTimeoutFn(() => { timedOut = true; controller.abort(); }, budgetMs)
    : null;

  return {
    signal: controller.signal,
    budgetMs,
    elapsedMs: () => now() - startedAt,
    // Distinguishes the two reasons a request can abort. Without this the
    // outcome classifier cannot tell a user's cancel from a budget timeout,
    // and both would surface as a generic error.
    cancel() {
      if (controller.signal.aborted) return;
      cancelled = true;
      controller.abort();
    },
    get cancelled() { return cancelled; },
    get timedOut() { return timedOut; },
    finish() {
      if (ticker) clearIntervalFn(ticker);
      if (budgetTimer) clearTimeoutFn(budgetTimer);
    }
  };
}

// A Studio action (Document/Workbook/Deck) is not one short request — it reads
// a source, then calls the model, then writes into Office, each its own
// phase. withProgress() (the generic one) freezes the label at whatever
// message the caller passed in when the run started, because its ticker
// closes over that one string. A Studio run needs the label to follow
// whichever phase is CURRENT, not the one it started in, or a user watching
// "Membaca dokumen... 340 detik" has no idea the model has been running for
// five of those minutes.
//
// This returns a `withStudioProgress(initialMessage, fn)` function, closed
// over one Studio section's DOM elements, so each of Document/Workbook/Deck
// Studio gets its own independently-wired instance (own progress element,
// own Cancel button, own busy/cleanup) without repeating this wiring three
// times. `fn` receives `(signal, setPhase)`: forward `signal` into every
// model call so Cancel actually aborts the in-flight request, and call
// `setPhase(nextMessage)` whenever the phase changes so the still-running
// elapsed clock repaints against the new label on its very next tick.
export function createStudioProgressRunner({
  progressEl = null,
  textEl = null,
  cancelButton = null,
  busyButtons = [],
  budgetMs = DECK_BUDGET_MS,
  report = null,
  idleMessage = "",
  now, setInterval: setIntervalFn, clearInterval: clearIntervalFn,
  setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn
} = {}) {
  // Cancel starts disabled and stays that way whenever no run is active —
  // there is nothing to cancel between runs, and a live button inviting a
  // click that does nothing is its own small confusion.
  if (cancelButton) cancelButton.disabled = true;

  return async function withStudioProgress(initialMessage, fn) {
    let phase = initialMessage;
    const repaint = (elapsedMs) => {
      if (textEl) textEl.textContent = progressLabel(phase, elapsedMs, budgetMs);
    };
    const run = createRun({
      budgetMs,
      onTick: repaint,
      ...(now ? { now } : {}),
      ...(setIntervalFn ? { setInterval: setIntervalFn } : {}),
      ...(clearIntervalFn ? { clearInterval: clearIntervalFn } : {}),
      ...(setTimeoutFn ? { setTimeout: setTimeoutFn } : {}),
      ...(clearTimeoutFn ? { clearTimeout: clearTimeoutFn } : {})
    });
    // Exposed to `fn` so a multi-step Studio action (read source, call model,
    // write to Office) can move the visible phase forward without waiting
    // for the next tick — the elapsed clock keeps running against whatever
    // phase was set most recently, never snapping back to `initialMessage`.
    const setPhase = (next) => {
      phase = String(next || "").trim() || phase;
      repaint(run.elapsedMs());
    };
    const onCancel = () => run.cancel();

    if (progressEl) progressEl.classList.toggle("hidden", false);
    repaint(0);
    if (cancelButton) {
      cancelButton.disabled = false;
      cancelButton.addEventListener("click", onCancel);
    }
    busyButtons.forEach((button) => { if (button) button.disabled = true; });

    try {
      await fn(run.signal, setPhase);
    } catch (error) {
      console.error(error);
      const outcome = classifyOutcome(error, {
        cancelled: run.cancelled, timedOut: run.timedOut
      });
      // A cancellation is the user's decision, not a failure — surfaced as a
      // warning, never through the same channel as a real error.
      if (report) report(outcome.message, outcome.status);
    } finally {
      run.finish();
      if (cancelButton) {
        cancelButton.removeEventListener("click", onCancel);
        cancelButton.disabled = true;
      }
      busyButtons.forEach((button) => { if (button) button.disabled = false; });
      if (progressEl) progressEl.classList.toggle("hidden", true);
      if (textEl && idleMessage) textEl.textContent = idleMessage;
    }
  };
}
