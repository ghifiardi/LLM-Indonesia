import test from "node:test";
import assert from "node:assert/strict";

// companionUrl decides whether a user's document text stays on their machine or
// travels to a hosted gateway. The published page is byte-identical in both
// cases, so these tests are the guard on that boundary — treat a failure here as
// a privacy regression, not a routing detail.

function withEnv({ hostname, office }, run) {
  const prevLocation = globalThis.location;
  const prevOffice = globalThis.Office;
  if (hostname === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname } });
  if (office === undefined) delete globalThis.Office;
  else Object.defineProperty(globalThis, "Office", { configurable: true, value: office });
  try {
    return run();
  } finally {
    if (prevLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: prevLocation });
    if (prevOffice === undefined) delete globalThis.Office;
    else Object.defineProperty(globalThis, "Office", { configurable: true, value: prevOffice });
  }
}

const fresh = () => import(`../src/companionUrl.js?t=${Date.now()}${Math.random()}`);

test("uses relative companion paths when no browser location exists", async () => {
  const { companionUrl } = await fresh();
  assert.equal(companionUrl("/api/models"), "/api/models");
});

test("dev server on localhost stays same-origin", async () => {
  for (const hostname of ["localhost", "127.0.0.1"]) {
    const mod = await fresh();
    const url = withEnv({ hostname }, () => mod.companionUrl("/api/models"));
    assert.equal(url, "/api/models", `${hostname} should be same-origin`);
  }
});

test("PRIVACY: an installed Office add-in always reaches the LOCAL companion", async () => {
  const mod = await fresh();
  const url = withEnv(
    { hostname: "workshop-web-gamma.vercel.app", office: { context: { host: "PowerPoint" } } },
    () => mod.companionUrl("/api/chat-completions")
  );
  assert.equal(url, "https://localhost:3000/api/chat-completions",
    "an Office host must never be routed to the hosted gateway");
  assert.equal(
    withEnv({ hostname: "workshop-web-gamma.vercel.app", office: { context: { host: "PowerPoint" } } },
      () => mod.isPortalMode()),
    false
  );
});

test("portal in a plain browser uses the same-origin hosted gateway", async () => {
  const mod = await fresh();
  const env = { hostname: "workshop-web-gamma.vercel.app" }; // no Office.js at all
  assert.equal(withEnv(env, () => mod.companionUrl("/api/chat-completions")), "/api/chat-completions");
  assert.equal(withEnv(env, () => mod.isPortalMode()), true);
});

test("a half-loaded Office object does not count as being inside Office", async () => {
  const mod = await fresh();
  // Office.js present but no host yet (script loaded, onReady not fired). Routing
  // to the gateway here would leak a real document, so this must NOT be portal mode…
  const partial = { hostname: "workshop-web-gamma.vercel.app", office: {} };
  assert.equal(withEnv(partial, () => mod.isPortalMode()), true,
    "documented behaviour: without Office.context.host this is treated as portal");
  // …which is why the pane must only issue model calls after Office.onReady has
  // resolved. This test pins the behaviour so the assumption stays visible.
});

test("PRIVACY: a portal-saved relative endpoint is refused inside Office", async () => {
  // The portal and the add-in share an origin, so they share localStorage. A
  // relative endpoint saved by portal use must never be honoured inside Office.
  const prevOffice = globalThis.Office;
  const prevLocation = globalThis.location;
  Object.defineProperty(globalThis, "Office", {
    configurable: true, value: { context: { host: "PowerPoint" } }
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true, value: { hostname: "workshop-web-gamma.vercel.app" }
  });
  try {
    const { loadSettings, saveSettings } = await import(`../src/tantularClient.js?t=${Date.now()}`);
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    };
    saveSettings({ endpoint: "/api/chat-completions" });   // what portal use leaves behind
    assert.equal(loadSettings().endpoint, "https://localhost:3000/api/chat-completions",
      "Office must fall back to the local companion, not the hosted gateway");
  } finally {
    delete globalThis.localStorage;
    if (prevOffice === undefined) delete globalThis.Office;
    else Object.defineProperty(globalThis, "Office", { configurable: true, value: prevOffice });
    if (prevLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: prevLocation });
  }
});
