import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLabel,
  bannerText,
  wordCount,
  createPoller,
  sendItem,
  deleteItem,
  putContext,
  fetchWorkspace,
  dismissedIds,
  usedIds,
  shouldAdoptServerContext
} from "../src/workspaceClient.js";

test("deriveLabel prefers first heading, else first 8 words", () => {
  assert.equal(deriveLabel("## Bab 2 — Roadmap\nisi..."), "Bab 2 — Roadmap");
  assert.equal(deriveLabel("satu dua tiga empat lima enam tujuh delapan sembilan"),
    "satu dua tiga empat lima enam tujuh delapan");
});

test("deriveLabel truncates to 120 chars", () => {
  const text = "x".repeat(200);
  const label = deriveLabel(text);
  assert.ok(label.length <= 120);
});

test("wordCount counts whitespace-separated words", () => {
  assert.equal(wordCount("satu dua tiga"), 3);
  assert.equal(wordCount("  "), 0);
  assert.equal(wordCount(""), 0);
});

test("bannerText includes source, label, and word count", () => {
  const t = bannerText({ source_host: "Word", label: "Bab 2", text: "satu dua tiga" });
  assert.equal(t, 'Konten masuk dari Word: "Bab 2" · 3 kata');
});

test("poller: 304 no-op, success resets backoff, failure backs off, visibility gates", async () => {
  const calls = [];
  let visible = true;
  let responses = [{ status: 304 }, { status: 200, body: { rev: 2, items: [], context: {} } }];
  const timers = [];
  const poller = createPoller({
    fetchFn: async (since) => { calls.push(since); return responses.shift() ?? { status: 304 }; },
    onUpdate: (body) => calls.push(`update:${body.rev}`),
    onError: () => calls.push("err"),
    isVisible: () => visible,
    scheduleFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelFn: () => {}
  });
  await poller.pollNow();                       // 304 → no update
  await poller.pollNow();                       // 200 → update with rev 2
  assert.deepEqual(calls, [0, 0, "update:2"]);
  responses = [Promise.reject(new Error("down"))];
  await poller.pollNow().catch(() => {});
  assert.equal(timers.at(-1).ms, 30000);        // backoff after failure
  visible = false;
  await poller.pollNow();                       // gated: no fetch when hidden
  assert.equal(calls.filter((c) => typeof c === "number").length, 3);
});

test("poller: onError is called on failure", async () => {
  const calls = [];
  const poller = createPoller({
    fetchFn: async () => { throw new Error("down"); },
    onUpdate: () => {},
    onError: (err) => calls.push(err.message),
    isVisible: () => true,
    scheduleFn: () => 1,
    cancelFn: () => {}
  });
  await poller.pollNow();
  assert.deepEqual(calls, ["down"]);
});

test("poller: start schedules via scheduleFn and stop cancels", () => {
  let scheduled = null;
  let cancelled = false;
  const poller = createPoller({
    fetchFn: async () => ({ status: 304 }),
    onUpdate: () => {},
    onError: () => {},
    isVisible: () => true,
    scheduleFn: (fn, ms) => { scheduled = { fn, ms }; return 42; },
    cancelFn: (id) => { if (id === 42) cancelled = true; }
  });
  poller.start();
  assert.ok(scheduled);
  assert.equal(scheduled.ms, 4000);
  poller.stop();
  assert.equal(cancelled, true);
});

test("poller: failure backs off to 30s, then success resets to default 4s", async () => {
  let callCount = 0;
  const timers = [];
  const poller = createPoller({
    fetchFn: async (since) => {
      callCount++;
      if (callCount === 1) {
        // First call: fail
        throw new Error("network down");
      }
      // Second call: succeed
      return { status: 200, body: { rev: 5, items: [], context: {} } };
    },
    onUpdate: () => {},
    onError: () => {},
    isVisible: () => true,
    scheduleFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelFn: () => {}
  });

  await poller.pollNow().catch(() => {});
  assert.equal(timers.at(-1).ms, 30000, "first failure should schedule at 30000ms backoff");

  await poller.pollNow();
  assert.equal(timers.at(-1).ms, 4000, "success should reset to 4000ms default");
});

test("poller: pollNow re-entrancy guard prevents concurrent fetches", async () => {
  let fetchCount = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });

  const poller = createPoller({
    fetchFn: async () => {
      fetchCount++;
      await fetchPromise;
      return { status: 200, body: { rev: 1, items: [], context: {} } };
    },
    onUpdate: () => {},
    onError: () => {},
    isVisible: () => true,
    scheduleFn: () => null,
    cancelFn: () => {}
  });

  // Call pollNow twice before resolving the first fetch
  const p1 = poller.pollNow();
  const p2 = poller.pollNow();

  // Both should have started (or second should have been gated)
  assert.equal(fetchCount, 1, "fetchFn should be called exactly once due to re-entrancy guard");

  resolveFetch();
  await Promise.all([p1, p2]);
});

test("fetch wrappers resolve {status, body} without throwing on non-2xx", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => ({
    status: 400,
    json: async () => ({ error: "bad", url, opts: opts?.method || "GET" })
  });
  try {
    const r1 = await sendItem({ source_host: "Word", kind: "selection", label: "L", text: "t" });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, "bad");

    const r2 = await deleteItem("abc");
    assert.equal(r2.status, 400);

    const r3 = await putContext({ instructions: "x", source_host: "Word" });
    assert.equal(r3.status, 400);

    const r4 = await fetchWorkspace(0);
    assert.equal(r4.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWorkspace handles 304 with empty body without throwing on json parse", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 304,
    json: async () => { throw new Error("no body"); }
  });
  try {
    const r = await fetchWorkspace(5);
    assert.equal(r.status, 304);
    assert.equal(r.body, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch wrappers reject on network error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    await assert.rejects(() => fetchWorkspace(0), /network down/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dismissedIds/usedIds: add, bounded to 50, oldest dropped; no crash without localStorage", () => {
  const originalLS = globalThis.localStorage;
  // eslint-disable-next-line no-undef
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  try {
    for (let i = 0; i < 55; i++) dismissedIds.add(`id${i}`);
    const ids = dismissedIds.list();
    assert.equal(ids.length, 50);
    assert.equal(ids.includes("id0"), false);
    assert.equal(ids.includes("id54"), true);
    assert.equal(dismissedIds.has("id54"), true);

    usedIds.add("u1");
    assert.equal(usedIds.has("u1"), true);
    assert.equal(usedIds.has("u2"), false);
  } finally {
    globalThis.localStorage = originalLS;
  }

  // no localStorage in this Node test context by default: must not crash
  delete globalThis.localStorage;
  assert.doesNotThrow(() => {
    dismissedIds.add("x");
    dismissedIds.has("x");
    dismissedIds.list();
    usedIds.add("y");
  });
});

test("shouldAdoptServerContext: true iff updated_at truthy and differs (string compare)", () => {
  assert.equal(shouldAdoptServerContext({ updated_at: "2026-01-01T00:00:00Z" }, null), true);
  assert.equal(shouldAdoptServerContext({ updated_at: "2026-01-01T00:00:00Z" }, "2026-01-01T00:00:00Z"), false);
  assert.equal(shouldAdoptServerContext({ updated_at: "" }, null), false);
  assert.equal(shouldAdoptServerContext({}, null), false);
  assert.equal(shouldAdoptServerContext({ updated_at: "2026-01-02T00:00:00Z" }, "2026-01-01T00:00:00Z"), true);
});
