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

// --- Mode Lokal / Mode Cloud ------------------------------------------------
// Cloud mode is opt-in and must be provable. The mode record lives in its own
// localStorage key and carries chosenInOffice, so nothing that portal use can
// leave behind in the shared origin's storage can route an Office session to
// the gateway.

const MODE_KEY = "tantular.office.mode.v1";
const OFFICE = { context: { host: "PowerPoint" } };
const HOSTED = "workshop-web-gamma.vercel.app";

function withStore(initial, run) {
  const store = new Map(Object.entries(initial || {}));
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  try {
    return run(store);
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
}

const cloudRecord = (chosenInOffice) => JSON.stringify({ mode: "cloud", chosenInOffice });

test("mode defaults to local when nothing was ever chosen", async () => {
  const mod = await fresh();
  withStore({}, () => {
    assert.equal(withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.loadMode()), "local");
    assert.equal(withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.isCloudSession()), false);
  });
});

test("routing: local mode inside Office keeps hitting the local companion", async () => {
  const mod = await fresh();
  withStore({ [MODE_KEY]: JSON.stringify({ mode: "local", chosenInOffice: true }) }, () => {
    assert.equal(
      withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.companionUrl("/api/chat-completions")),
      "https://localhost:3000/api/chat-completions"
    );
  });
});

test("routing: a deliberate cloud choice inside Office uses the same-origin gateway", async () => {
  const mod = await fresh();
  withStore({ [MODE_KEY]: cloudRecord(true) }, () => {
    assert.equal(
      withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.companionUrl("/api/chat-completions")),
      "/api/chat-completions"
    );
    assert.equal(withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.isCloudSession()), true);
  });
});

test("PRIVACY: a cloud record NOT chosen inside Office cannot route Office to the gateway", async () => {
  // Exactly what portal use (or a hand-edited value) leaves in the shared
  // origin's localStorage. Consent is the record's provenance, not its content.
  const mod = await fresh();
  for (const record of [cloudRecord(false), JSON.stringify({ mode: "cloud" }), '"cloud"', "cloud"]) {
    withStore({ [MODE_KEY]: record }, () => {
      assert.equal(
        withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.companionUrl("/api/chat-completions")),
        "https://localhost:3000/api/chat-completions",
        `record ${record} must not be honoured inside Office`
      );
      assert.equal(withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.isCloudSession()), false);
    });
  }
});

test("saveMode stamps the choice with whether Office was actually present", async () => {
  const mod = await fresh();
  withStore({}, (store) => {
    withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.saveMode("cloud"));
    assert.deepEqual(JSON.parse(store.get(MODE_KEY)), { mode: "cloud", chosenInOffice: true });
    // The same call made outside Office (portal) records chosenInOffice:false,
    // which the Office branch then refuses.
    withEnv({ hostname: HOSTED }, () => mod.saveMode("cloud"));
    assert.deepEqual(JSON.parse(store.get(MODE_KEY)), { mode: "cloud", chosenInOffice: false });
    assert.equal(
      withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.companionUrl("/api/chat-completions")),
      "https://localhost:3000/api/chat-completions"
    );
  });
});

test("routing: dev and portal are unchanged by the mode setting", async () => {
  const mod = await fresh();
  for (const record of [cloudRecord(true), JSON.stringify({ mode: "local", chosenInOffice: true }), null]) {
    withStore(record ? { [MODE_KEY]: record } : {}, () => {
      assert.equal(withEnv({ hostname: "localhost" }, () => mod.companionUrl("/api/models")), "/api/models");
      assert.equal(withEnv({ hostname: "127.0.0.1" }, () => mod.companionUrl("/api/models")), "/api/models");
      assert.equal(withEnv({ hostname: HOSTED }, () => mod.companionUrl("/api/chat-completions")), "/api/chat-completions");
      assert.equal(withEnv({ hostname: HOSTED }, () => mod.isPortalMode()), true);
    });
  }
});

test("companion-only guard fires only in a cloud session, in Bahasa Indonesia", async () => {
  const mod = await fresh();
  withStore({ [MODE_KEY]: cloudRecord(true) }, () => {
    withEnv({ hostname: HOSTED, office: OFFICE }, () => {
      assert.throws(() => mod.assertCompanionAvailable("Daftar model Ollama"), (error) => {
        assert.match(error.message, /Daftar model Ollama/);
        assert.match(error.message, /Tantular Companion/);
        assert.match(error.message, /Mode Cloud/);
        return true;
      });
    });
    // Portal is a separate, already-shipped story and is deliberately untouched.
    withEnv({ hostname: HOSTED }, () => {
      assert.doesNotThrow(() => mod.assertCompanionAvailable("Daftar model Ollama"));
    });
  });
  withStore({}, () => {
    withEnv({ hostname: HOSTED, office: OFFICE }, () => {
      assert.doesNotThrow(() => mod.assertCompanionAvailable("Daftar model Ollama"));
    });
    withEnv({ hostname: "localhost" }, () => {
      assert.doesNotThrow(() => mod.assertCompanionAvailable("Daftar model Ollama"));
    });
  });
});

// --- The pre-onReady window -------------------------------------------------
// Office.js sets Office.context.host only when Office.onReady resolves, so for
// the first moments of a real session insideOffice() is false and every mode
// read answers as if this were the portal. Two things follow, both pinned here:
// the pane must not CLAIM a mode during that window, and nothing on a startup
// path may WRITE one.

const PRE_ONREADY = { onReady: () => {} };   // Office.js loaded, host not attached yet

test("the mode is not knowable until Office.onReady has resolved", async () => {
  const mod = await fresh();
  assert.equal(
    withEnv({ hostname: HOSTED, office: PRE_ONREADY }, () => mod.modeIsKnown()),
    false,
    "Office.js present but no host yet: the pane must stay silent about the mode"
  );
  assert.equal(
    withEnv({ hostname: HOSTED, office: OFFICE }, () => mod.modeIsKnown()),
    true,
    "once the host is attached the mode is settled"
  );
  // No Office.js at all is the portal / dev preview: settled from the start.
  assert.equal(withEnv({ hostname: HOSTED }, () => mod.modeIsKnown()), true);
  assert.equal(withEnv({ hostname: "localhost" }, () => mod.modeIsKnown()), true);
});

test("PRIVACY: a local install is never told it is in cloud mode before the mode is known", async () => {
  // The reason the banner has to wait. With NOTHING stored — the plain local
  // user — a mode read during the window still answers "cloud", because the
  // portal branch is the one being taken.
  const mod = await fresh();
  withStore({}, () => {
    withEnv({ hostname: HOSTED, office: PRE_ONREADY }, () => {
      assert.equal(mod.isPortalMode(), true, "documented: pre-onReady reads as portal");
      assert.equal(mod.modeIsKnown(), false, "…so no mode claim may be shown yet");
    });
    // And the moment the host attaches, the honest answer is local.
    withEnv({ hostname: HOSTED, office: OFFICE }, () => {
      assert.equal(mod.modeIsKnown(), true);
      assert.equal(mod.loadMode(), "local");
      assert.equal(mod.isCloudSession(), false);
    });
  });
});

test("PRIVACY: no startup path may persist a mode — reading one never writes one", async () => {
  // The invariant the pre-onReady window rests on. A leaked portal record reads
  // as "cloud" during the window; if any hydrate/startup path ever re-saved
  // what it read (`saveSettings({ mode: loadMode() })`), saveMode() would stamp
  // chosenInOffice:true as soon as Office finished loading and convert a local
  // user to cloud for good. So: everything a startup path does must leave the
  // mode record byte-identical.
  const prevOffice = globalThis.Office;
  const prevLocation = globalThis.location;
  const prevStorage = globalThis.localStorage;
  const leaked = cloudRecord(false);
  const store = new Map([[MODE_KEY, leaked]]);
  let writes = 0;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: HOSTED } });
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (k === MODE_KEY) writes += 1; store.set(k, String(v)); },
    removeItem: (k) => store.delete(k)
  };
  const setOffice = (value) => Object.defineProperty(globalThis, "Office", { configurable: true, value });
  try {
    setOffice(PRE_ONREADY);
    const { loadSettings, saveSettings } = await freshClient();
    const { loadMode } = await fresh();

    // Everything bootstrap does before onReady: read settings, read the mode,
    // and save the visible model fields without naming a mode.
    loadSettings();
    loadMode();
    saveSettings({});
    saveSettings({ model: "qwen3.5:9b", endpoint: "https://localhost:3000/api/chat-completions" });
    assert.equal(writes, 0, "no startup read or model save may write the mode key");
    assert.equal(store.get(MODE_KEY), leaked, "the leaked portal record must be left untouched");

    // Office finishes loading: the leaked record is still refused.
    setOffice(OFFICE);
    saveSettings({ model: "qwen3.5:9b" });
    assert.equal(writes, 0);
    assert.equal(loadMode(), "local");

    // A mode is written ONLY when a caller supplies one explicitly — i.e. the
    // user working the toggle, with Office genuinely present.
    saveSettings({ mode: "cloud" });
    assert.equal(writes, 1);
    assert.deepEqual(JSON.parse(store.get(MODE_KEY)), { mode: "cloud", chosenInOffice: true });
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevOffice === undefined) delete globalThis.Office;
    else setOffice(prevOffice);
    if (prevLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: prevLocation });
  }
});

// --- Endpoint normalisation across modes ------------------------------------

async function withOfficeEnv(initialStore, run) {
  const prevOffice = globalThis.Office;
  const prevLocation = globalThis.location;
  const prevStorage = globalThis.localStorage;
  const store = new Map(Object.entries(initialStore || {}));
  Object.defineProperty(globalThis, "Office", { configurable: true, value: OFFICE });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: HOSTED } });
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  try {
    return await run(store);
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
    if (prevOffice === undefined) delete globalThis.Office;
    else Object.defineProperty(globalThis, "Office", { configurable: true, value: prevOffice });
    if (prevLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: prevLocation });
  }
}

const freshClient = () => import(`../src/tantularClient.js?t=${Date.now()}${Math.random()}`);

test("PRIVACY: a portal-saved relative endpoint is still refused in LOCAL mode", async () => {
  await withOfficeEnv({ [MODE_KEY]: JSON.stringify({ mode: "local", chosenInOffice: true }) }, async () => {
    const { loadSettings, saveSettings } = await freshClient();
    saveSettings({ endpoint: "/api/chat-completions" });
    const loaded = loadSettings();
    assert.equal(loaded.endpoint, "https://localhost:3000/api/chat-completions");
    assert.equal(loaded.mode, "local");
  });
});

test("a stale relative endpoint in CLOUD mode resolves to the gateway, not to a stored string", async () => {
  await withOfficeEnv({ [MODE_KEY]: cloudRecord(true) }, async () => {
    const { loadSettings, saveSettings } = await freshClient();
    // Even a nonsense relative path is replaced by the mode-derived default —
    // the stored string is never trusted, in either mode.
    saveSettings({ endpoint: "/api/something-else" });
    const loaded = loadSettings();
    assert.equal(loaded.endpoint, "/api/chat-completions");
    assert.equal(loaded.mode, "cloud");
  });
});

test("switching mode heals a stale endpoint in both directions", async () => {
  await withOfficeEnv({}, async () => {
    const { loadSettings, saveSettings } = await freshClient();
    assert.equal(saveSettings({}).endpoint, "https://localhost:3000/api/chat-completions");
    // → cloud: the leftover localhost companion URL must not survive.
    assert.equal(saveSettings({ mode: "cloud" }).endpoint, "/api/chat-completions");
    assert.equal(loadSettings().mode, "cloud");
    // → back to local: the relative gateway path must not survive either.
    assert.equal(saveSettings({ mode: "local" }).endpoint, "https://localhost:3000/api/chat-completions");
    assert.equal(loadSettings().mode, "local");
  });
});

test("a custom gateway endpoint the user typed is preserved in cloud mode", async () => {
  await withOfficeEnv({ [MODE_KEY]: cloudRecord(true) }, async () => {
    const { saveSettings } = await freshClient();
    assert.equal(
      saveSettings({ endpoint: "https://gw.example.com/v1/chat/completions" }).endpoint,
      "https://gw.example.com/v1/chat/completions"
    );
  });
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
