import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, LOOPBACK } from "../bridge/server.mjs";
import { DryRunAdapter } from "../bridge/dryRunAdapter.mjs";
import { createCommand } from "../commandContract.js";

async function withBridge(run, adapterOpts = { slideCount: 8 }) {
  const { server, token, adapter } = createBridge({ adapter: new DryRunAdapter(adapterOpts) });
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port, address } = server.address();
  try {
    return await run({ port, address, token, adapter });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = (port, path, { method = "GET", token, body } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test("the bridge binds loopback only, never a routable address", async () => {
  await withBridge(async ({ address }) => {
    // 0.0.0.0 would expose presentation control to the venue wifi.
    assert.equal(address, "127.0.0.1");
  });
});

test("health needs no token; you must be able to ask if it is up", async () => {
  await withBridge(async ({ port }) => {
    const res = await call(port, "/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.adapter, "dry-run");
    assert.equal(body.phase, "N1");
  });
});

test("state and command require the session token", async () => {
  await withBridge(async ({ port, token }) => {
    assert.equal((await call(port, "/state")).status, 401);
    assert.equal((await call(port, "/state", { token: "wrong" })).status, 401);
    assert.equal((await call(port, "/state", { token })).status, 200);

    const cmd = createCommand({ action: "next", source: "voice", confidence: 1 });
    assert.equal((await call(port, "/command", { method: "POST", body: cmd })).status, 401);
  });
});

test("a valid command moves the presentation state", async () => {
  await withBridge(async ({ port, token }) => {
    const cmd = createCommand({ action: "goto_slide", source: "voice", confidence: 1, slide: 5 });
    const res = await call(port, "/command", { method: "POST", token, body: cmd });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state.slide, 5);

    const state = await (await call(port, "/state", { token })).json();
    assert.equal(state.state.slide, 5);
    assert.ok(state.recent.length > 0, "actions must be recorded for review");
  });
});

test("an unknown action is refused with 400", async () => {
  await withBridge(async ({ port, token }) => {
    const res = await call(port, "/command", {
      method: "POST", token,
      body: { version: 1, action: "exec", source: "voice", confidence: 1 },
    });
    assert.equal(res.status, 400);
  });
});

test("there is no shell, script, or exec endpoint", async () => {
  await withBridge(async ({ port, token }) => {
    for (const path of ["/exec", "/shell", "/applescript", "/osascript", "/run", "/eval"]) {
      for (const method of ["GET", "POST"]) {
        const res = await call(port, path, { method, token, body: method === "POST" ? { cmd: "id" } : undefined });
        assert.equal(res.status, 404, `${method} ${path} must not exist in N1`);
      }
    }
  });
});

test("the dry-run adapter drives nothing outside itself", async () => {
  // The guarantee of this phase: state changes, nothing is executed.
  const adapter = new DryRunAdapter({ slideCount: 3 });
  const raw = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../bridge/dryRunAdapter.mjs", import.meta.url), "utf8"));
  // Comments are stripped first: the file explains that it deliberately does
  // NOT use osascript, and a raw scan cannot tell that promise from a call.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["child_process", "exec(", "execSync", "spawn", "osascript", "eval("]) {
    assert.ok(!code.includes(forbidden), `N1 adapter must not reference ${forbidden}`);
  }
  assert.match(raw, /No AppleScript/, "the inert guarantee must stay documented");
  adapter.apply(createCommand({ action: "next", source: "voice", confidence: 1 }));
  assert.equal(adapter.getState().slide, 2);
});

test("slide movement clamps at the deck edges", async () => {
  const adapter = new DryRunAdapter({ slideCount: 3 });
  const next = createCommand({ action: "next", source: "voice", confidence: 1 });
  const prev = createCommand({ action: "previous", source: "voice", confidence: 1 });
  for (let i = 0; i < 6; i += 1) adapter.apply(next);
  assert.equal(adapter.getState().slide, 3, "running off the end must not wrap to slide 1");
  for (let i = 0; i < 6; i += 1) adapter.apply(prev);
  assert.equal(adapter.getState().slide, 1);
});

test("goto_topic is recorded unresolved, since only the app knows the deck", async () => {
  const adapter = new DryRunAdapter();
  const out = adapter.apply(createCommand({
    action: "goto_topic", source: "voice", confidence: 1, query: "harga",
  }));
  assert.equal(out.resolved, null);
  assert.equal(adapter.recentLog().at(-1).query, "harga");
});

test("the action log is bounded", async () => {
  const adapter = new DryRunAdapter({ slideCount: 5, logLimit: 10 });
  const next = createCommand({ action: "next", source: "voice", confidence: 1 });
  for (let i = 0; i < 50; i += 1) adapter.apply(next);
  assert.ok(adapter.log.length <= 10, "a long rehearsal must not grow memory without bound");
});

// --- cross-origin access ----------------------------------------------------
// The deck is served on its own port, so every call it makes is cross-origin.
// The original design refused CORS outright and the browser could never read a
// reply — a fault the Node-driven rehearsal could not catch, because CORS is
// not enforced outside a browser. These tests stand in for that browser.

test("a browser preflight is answered BEFORE the token check", async () => {
  // A browser never sends Authorization on OPTIONS, so requiring a token here
  // failed every cross-origin call with 401 before it began.
  await withBridge(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "OPTIONS",
      headers: {
        Origin: `http://localhost:8082`,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:8082");
    assert.match(res.headers.get("access-control-allow-headers") || "", /authorization/);
  });
});

test("a real response carries the origin back, so the browser may read it", async () => {
  await withBridge(async ({ port, token }) => {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      headers: { Origin: "http://localhost:8082", Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:8082");
    assert.equal(res.headers.get("vary"), "Origin");
  });
});

test("a non-loopback origin is refused and gets no CORS headers", async () => {
  await withBridge(async ({ port, token }) => {
    const pre = await fetch(`http://127.0.0.1:${port}/command`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(pre.status, 403);

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null,
      "a page on the internet must never be able to read a service that drives a presentation");
  });
});

test("the wildcard origin is never used", async () => {
  await withBridge(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://localhost:9999" } });
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:9999");
  });
});

test("CORS decides who may READ, never who may act", async () => {
  // An allowed origin still needs the token: relaxing CORS must not relax auth.
  await withBridge(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/state`, { headers: { Origin: "http://localhost:8082" } });
    assert.equal(res.status, 401);
  });
});
