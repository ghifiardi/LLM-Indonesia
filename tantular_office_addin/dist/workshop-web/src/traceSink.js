// Ships the pane's console to the companion's demo trace.
//
// The in-host WebView on Mac has no reachable console, which is exactly where
// the pane's failures live. The ES5 collector inlined at the top of
// taskpane.html has been buffering console output since the first line the
// pane emitted; this decides what happens to it.
//
// Inert unless the companion answers that tracing is on: on the hosted build
// the route does not exist, the probe fails, and the collector is unwound —
// console is restored and the buffer dropped. Nothing ever leaves the machine;
// the companion is local.

const FLUSH_MS = 700;
const MAX_QUEUE = 200;

function unwind(state) {
  for (const level of Object.keys(state.original)) console[level] = state.original[level];
  state.buffer.length = 0;
  state.sink = () => {};
}

export async function installTraceSink() {
  const state = globalThis.__tantularTrace;
  if (!state) return false;

  let on = false;
  try {
    const probe = await fetch("/api/__trace", { method: "GET" });
    on = probe.ok && (await probe.json())?.on === true;
  } catch { /* no companion trace route */ }
  if (!on) {
    unwind(state);
    return false;
  }

  const queue = [];
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const lines = queue.splice(0, queue.length);
    // keepalive so the last lines before a pane teardown still land.
    fetch("/api/__trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
      keepalive: true
    }).catch(() => { /* a dropped trace line must never disturb the demo */ });
  };

  // Claim the sink before draining, so a line logged in between is queued
  // rather than appended to a buffer nobody reads again.
  state.sink = (line) => {
    if (queue.length >= MAX_QUEUE) return;
    queue.push(line);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  for (const line of state.buffer.splice(0, state.buffer.length)) state.sink(line);

  window.addEventListener("pagehide", flush);

  console.info("[trace] pane console is being recorded by the companion");
  flush(); // boot lines land now, not one flush interval later
  return true;
}
