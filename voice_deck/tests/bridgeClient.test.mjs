import test from "node:test";
import assert from "node:assert/strict";
import { BridgeClient, TOKEN_STORAGE_KEY } from "../bridgeClient.js";
import { createCommand } from "../commandContract.js";

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};
const cmd = createCommand({ action: "next", source: "voice", confidence: 1 });
const client = (fetchImpl, opts = {}) =>
  new BridgeClient({ endpoint: "http://127.0.0.1:8777", fetchImpl, storage: memoryStorage(), ...opts });

test("a token is required before anything is sent", async () => {
  let called = 0;
  const c = client(async () => { called += 1; });
  const status = await c.send(cmd);
  assert.equal(status.state, "needs-token");
  assert.equal(called, 0, "no request may leave without a token");
});

test("the token is never placed in the URL", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const c = client(async (url, opts) => {
    seenUrl = url; seenAuth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ ok: true, effect: "next", state: { slide: 2 } }) };
  });
  c.setToken("s3cret-token");
  await c.send(cmd);
  assert.ok(!seenUrl.includes("s3cret-token"), "a URL reaches history and screen shares");
  assert.equal(seenAuth, "Bearer s3cret-token");
});

test("an unreachable bridge degrades instead of throwing", async () => {
  // The deck must keep working when the bridge is down: this runs while
  // someone is presenting.
  const c = client(async () => { throw new Error("ECONNREFUSED"); });
  c.setToken("t");
  const status = await c.send(cmd);
  assert.equal(status.state, "off");
  assert.match(status.message, /unreachable/);
});

test("a rejected token is reported as such, not as a generic failure", async () => {
  const c = client(async () => ({ ok: false, status: 401, json: async () => ({ error: "bad token" }) }));
  c.setToken("stale");
  const status = await c.send(cmd);
  assert.equal(status.state, "needs-token", "a restarted bridge mints a new token");
});

test("a refusal names the action that was refused", async () => {
  const c = client(async () => ({ ok: false, status: 400, json: async () => ({ error: "unknown action" }) }));
  c.setToken("t");
  const status = await c.send(cmd);
  assert.equal(status.state, "error");
  assert.match(status.message, /next/);
});

test("a hung bridge is abandoned, not awaited forever", async () => {
  let aborted = false;
  const c = client((url, opts) => new Promise((_, reject) => {
    opts.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }), { timeoutMs: 20 });
  c.setToken("t");
  const status = await c.send(cmd);
  assert.equal(aborted, true, "a hung bridge must not stall the presenter");
  assert.equal(status.state, "off");
});

test("the token survives in storage under a namespaced key", async () => {
  const storage = memoryStorage();
  const c = new BridgeClient({ endpoint: "http://127.0.0.1:8777", fetchImpl: async () => ({}), storage });
  c.setToken("  padded  ");
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), "padded");
  assert.equal(c.isConfigured(), true);
});
