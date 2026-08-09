# Tantular Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-host content hand-off (Word ⇄ Excel ⇄ PowerPoint) and shared project instructions via a bounded workspace store in the Tantular Companion, with notify+one-click receive.

**Architecture:** The Companion (`tools/dev-server.mjs`) gains a workspace store module (bounded 10-item inbox + shared context, atomic JSON persistence, monotonic `rev`). Panes get a `workspaceClient` module: visibility-gated polling with `since_rev`/304, a "Kirim ke aplikasi lain" send button in the existing Teks/seleksi card, an incoming-content banner + inbox list (text-only rendering), and promotion of the existing project-instructions box to workspace scope with server-ordered adoption.

**Tech Stack:** Node ≥18 ESM (Companion + `node --test`), vanilla JS panes (no framework), existing dev-server CORS/no-store conventions.

**Spec:** `docs/superpowers/specs/2026-08-09-tantular-workspace-design.md` — read fully before any task.

## Global Constraints

- Work on branch `feat/office-finetune` (current). Commit after every task; if `git commit` hits index.lock (background agents), wait 30s and retry. Commit ONLY your task's files.
- Inbox capacity **10**; inserting item 11 discards the oldest. Insert and delete increment `rev`; a context save with unchanged `instructions` is a no-op and does NOT increment `rev`.
- Item schema: `{id, created_at, source_host, kind, label, text}`. Server assigns `id` (crypto.randomUUID) and `created_at` (server clock, ISO-8601 UTC).
- Validation (400 with Indonesian message): `source_host` ∈ {Word, Excel, PowerPoint}; `kind` ∈ {selection, document, range, outline}; `text` non-empty after trim and ≤ **60000** chars; `instructions` ≤ **8000** chars; `label` truncated server-side to **120** chars (never rejected for length).
- Shared context stores server-assigned `updated_at`, `updated_by`. "Newest wins" uses server ordering only — client clocks never compared.
- Persistence: `data/workspace.json` relative to the Companion process CWD; atomic write = write `workspace.json.tmp` then `fs.renameSync`; on startup a malformed file is renamed to `workspace.json.corrupt-<epoch-ms>` and the store starts empty (log one line, never crash).
- `GET /api/workspace?since_rev=N` → **304 empty body** when `rev <= N`, else 200 `{rev, items, context}`.
- Polling: ~**4000 ms** while `document.visibilityState === "visible"` only; on fetch failure back off to **30000 ms** until a success; refresh immediately after a successful send.
- Lifecycle: "Abaikan" = per-pane dismissal (localStorage set of dismissed ids); "Pakai" fills target + marks used per-pane (✓), does NOT delete; deletion only via "Hapus" (DELETE) or FIFO.
- Insertion: "Pakai/Tempel" REPLACES the target box; if target non-empty and different → inline confirm "Kotak tujuan sudah berisi teks — ganti?" before replacing. No append in v1.
- **XSS hard rule:** workspace-derived strings rendered ONLY via `textContent`/`createTextNode`. No `innerHTML`/`insertAdjacentHTML` anywhere in workspace render paths; a test enforces this by scanning the module source.
- Same-host items never trigger the banner but appear in the inbox list ("10 kiriman terakhir" wording so expiry is unsurprising).
- Add-in tests: `npm test` in `tantular_office_addin/` (`node --test tests/*.test.mjs`), currently 103 passing — must stay green and grow.

## File Structure

```
tantular_office_addin/
  tools/workspace.mjs            CREATE: store (FIFO/rev/validation/persistence) + HTTP handler
  tools/dev-server.mjs           MODIFY: route /api/workspace* to the handler (~4 lines)
  src/workspaceClient.js         CREATE: poll scheduler, send/delete/context API calls, pure builders
  src/workspaceUi.js             CREATE: banner + inbox DOM (text-only), confirm-replace, wiring helper
  src/taskpane.html              MODIFY: send button + banner/inbox containers in Teks/seleksi card
  src/taskpane.js                MODIFY: mount workspace UI; promote project-instructions save/load
  src/taskpane.css               MODIFY: banner/inbox styles
  tests/workspace.test.mjs       CREATE: store + handler tests
  tests/workspaceClient.test.mjs CREATE: pure builders, poll/backoff with fake timers, XSS source scan
  docs/WORKSPACE.md              CREATE: user doc + manual acceptance checklist
```

---

### Task 1: Workspace store module (pure core + persistence)

**Files:**
- Create: `tantular_office_addin/tools/workspace.mjs`
- Test: `tantular_office_addin/tests/workspace.test.mjs`

**Interfaces:**
- Produces: `createWorkspaceStore({ filePath }) → store` with:
  `store.snapshot() → {rev, items, context}`;
  `store.addItem({source_host, kind, label, text}) → {ok:true, item} | {ok:false, error}`;
  `store.deleteItem(id) → {ok:boolean}`;
  `store.setContext({instructions, source_host}) → {ok:true, context, changed:boolean} | {ok:false, error}`;
  `store.rev → number`. Constructor loads/recovers the file per Global Constraints.

- [ ] **Step 1: Write the failing tests**

`tantular_office_addin/tests/workspace.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "../tools/workspace.mjs";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  return { dir, store: createWorkspaceStore({ filePath: path.join(dir, "workspace.json") }) };
}
const ITEM = { source_host: "Word", kind: "selection", label: "Bab 2", text: "Isi bab dua." };

test("addItem assigns id/created_at and bumps rev", () => {
  const { store } = tmpStore();
  const r0 = store.rev;
  const r = store.addItem(ITEM);
  assert.equal(r.ok, true);
  assert.match(r.item.id, /^[0-9a-f-]{36}$/);
  assert.match(r.item.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.rev, r0 + 1);
});

test("FIFO: inserting item 11 discards the oldest", () => {
  const { store } = tmpStore();
  for (let i = 1; i <= 11; i++) store.addItem({ ...ITEM, label: `L${i}` });
  const items = store.snapshot().items;
  assert.equal(items.length, 10);
  assert.equal(items[0].label, "L2");
  assert.equal(items[9].label, "L11");
});

test("delete bumps rev; unknown id does not", () => {
  const { store } = tmpStore();
  const { item } = store.addItem(ITEM);
  const r1 = store.rev;
  assert.equal(store.deleteItem(item.id).ok, true);
  assert.equal(store.rev, r1 + 1);
  assert.equal(store.deleteItem("nope").ok, false);
  assert.equal(store.rev, r1 + 1);
});

test("context save is server-ordered; no-op save does not bump rev", () => {
  const { store } = tmpStore();
  const a = store.setContext({ instructions: "Gaya formal.", source_host: "Word" });
  assert.equal(a.ok, true);
  assert.equal(a.context.updated_by, "Word");
  assert.match(a.context.updated_at, /^\d{4}-/);
  const r1 = store.rev;
  const b = store.setContext({ instructions: "Gaya formal.", source_host: "Excel" });
  assert.equal(b.changed, false);
  assert.equal(store.rev, r1);
});

test("validation: bad host/kind/empty/oversize rejected; label truncated to 120", () => {
  const { store } = tmpStore();
  assert.equal(store.addItem({ ...ITEM, source_host: "Outlook" }).ok, false);
  assert.equal(store.addItem({ ...ITEM, kind: "video" }).ok, false);
  assert.equal(store.addItem({ ...ITEM, text: "   " }).ok, false);
  assert.equal(store.addItem({ ...ITEM, text: "x".repeat(60001) }).ok, false);
  assert.equal(store.setContext({ instructions: "y".repeat(8001), source_host: "Word" }).ok, false);
  const long = store.addItem({ ...ITEM, label: "z".repeat(200) });
  assert.equal(long.item.label.length, 120);
});

test("persists atomically and recovers from a corrupt file", () => {
  const { dir } = tmpStore();
  const fp = path.join(dir, "workspace.json");
  const s1 = createWorkspaceStore({ filePath: fp });
  s1.addItem(ITEM);
  const s2 = createWorkspaceStore({ filePath: fp });
  assert.equal(s2.snapshot().items.length, 1);
  fs.writeFileSync(fp, "{not json");
  const s3 = createWorkspaceStore({ filePath: fp });
  assert.equal(s3.snapshot().items.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("workspace.json.corrupt-")));
});
```

- [ ] **Step 2: Run to verify failure** — `cd tantular_office_addin && npm test` → new file errors with "createWorkspaceStore is not a function"/module not found; the pre-existing 103 stay green.

- [ ] **Step 3: Implement `tools/workspace.mjs`**

```javascript
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOSTS = new Set(["Word", "Excel", "PowerPoint"]);
const KINDS = new Set(["selection", "document", "range", "outline"]);
const MAX_ITEMS = 10;
const MAX_TEXT = 60000;
const MAX_INSTRUCTIONS = 8000;
const MAX_LABEL = 120;

export function createWorkspaceStore({ filePath }) {
  let state = load(filePath);

  function persist() {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, filePath);
  }

  return {
    get rev() { return state.rev; },
    snapshot() { return structuredClone(state); },
    addItem(input) {
      const err = validateItem(input);
      if (err) return { ok: false, error: err };
      const item = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        source_host: input.source_host,
        kind: input.kind,
        label: String(input.label ?? "").slice(0, MAX_LABEL),
        text: input.text
      };
      state.items.push(item);
      if (state.items.length > MAX_ITEMS) state.items.shift();
      state.rev += 1;
      persist();
      return { ok: true, item };
    },
    deleteItem(id) {
      const before = state.items.length;
      state.items = state.items.filter((it) => it.id !== id);
      if (state.items.length === before) return { ok: false };
      state.rev += 1;
      persist();
      return { ok: true };
    },
    setContext({ instructions, source_host }) {
      if (!HOSTS.has(source_host)) return { ok: false, error: "source_host tidak dikenal." };
      const value = String(instructions ?? "");
      if (value.length > MAX_INSTRUCTIONS) return { ok: false, error: `Instruksi melebihi ${MAX_INSTRUCTIONS} karakter.` };
      if (value === state.context.instructions) return { ok: true, context: structuredClone(state.context), changed: false };
      state.context = { instructions: value, updated_at: new Date().toISOString(), updated_by: source_host };
      state.rev += 1;
      persist();
      return { ok: true, context: structuredClone(state.context), changed: true };
    }
  };
}

function validateItem(input) {
  if (!HOSTS.has(input?.source_host)) return "source_host tidak dikenal.";
  if (!KINDS.has(input?.kind)) return "kind tidak dikenal.";
  const text = String(input?.text ?? "");
  if (!text.trim()) return "text kosong.";
  if (text.length > MAX_TEXT) return `text melebihi ${MAX_TEXT} karakter.`;
  return null;
}

function emptyState() {
  return { rev: 0, items: [], context: { instructions: "", updated_at: null, updated_by: null } };
}

function load(filePath) {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed?.rev !== "number" || !Array.isArray(parsed?.items) || typeof parsed?.context !== "object") {
      throw new Error("bentuk tidak valid");
    }
    return parsed;
  } catch {
    try { fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
    console.warn(`[workspace] file rusak dikarantina; mulai kosong: ${filePath}`);
    return emptyState();
  }
}
```

- [ ] **Step 4: Run tests** — `npm test` → all green (103 + 6 new).
- [ ] **Step 5: Commit** — `git add tantular_office_addin/tools/workspace.mjs tantular_office_addin/tests/workspace.test.mjs && git commit -m "feat(workspace): bounded store with rev semantics, validation, atomic persistence"`

---

### Task 2: HTTP handler + dev-server routing (since_rev/304)

**Files:**
- Modify: `tantular_office_addin/tools/workspace.mjs` (append handler)
- Modify: `tantular_office_addin/tools/dev-server.mjs` (route block where the other `/api/*` routes live, near `/api/models`)
- Test: `tantular_office_addin/tests/workspace.test.mjs` (append)

**Interfaces:**
- Produces: `handleWorkspaceRequest(store, req, res, url) → boolean` (true when the request was handled). Routes: GET `/api/workspace` (optional `?since_rev=N` → 304 empty when `store.rev <= N`), POST `/api/workspace/items`, DELETE `/api/workspace/items/<id>`, PUT `/api/workspace/context`. JSON responses `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and the SAME CORS headers the dev-server's existing `/api/*` handlers emit (reuse its helper if one exists — read the file; else copy the exact header set from `proxyChatCompletions`). Errors: 400 `{ok:false,error}` (validation), 404 `{ok:false}` (unknown id/route beyond prefix), 405 for wrong method.

- [ ] **Step 1: Write the failing tests** (append; drive the handler with a real `http` server)

```javascript
import http from "node:http";
import { handleWorkspaceRequest } from "../tools/workspace.mjs";

function serve(store) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!handleWorkspaceRequest(store, req, res, url)) { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    server, base: `http://127.0.0.1:${server.address().port}`
  })));
}

test("HTTP round-trip: POST -> GET -> 304 -> DELETE", async () => {
  const { store } = tmpStore();
  const { server, base } = await serve(store);
  try {
    const post = await fetch(`${base}/api/workspace/items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ITEM)
    });
    assert.equal(post.status, 200);
    const { item, rev } = await post.json();

    const get = await fetch(`${base}/api/workspace`);
    const body = await get.json();
    assert.equal(body.items.length, 1);

    const notModified = await fetch(`${base}/api/workspace?since_rev=${rev}`);
    assert.equal(notModified.status, 304);

    const changed = await fetch(`${base}/api/workspace?since_rev=${rev - 1}`);
    assert.equal(changed.status, 200);

    const del = await fetch(`${base}/api/workspace/items/${item.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}/api/workspace/items/${item.id}`, { method: "DELETE" })).status, 404);
  } finally { server.close(); }
});

test("HTTP: invalid item 400 with Indonesian error; context PUT server-assigns fields", async () => {
  const { store } = tmpStore();
  const { server, base } = await serve(store);
  try {
    const bad = await fetch(`${base}/api/workspace/items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ITEM, source_host: "Outlook" })
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /source_host/);

    const put = await fetch(`${base}/api/workspace/context`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "Gaya formal.", source_host: "PowerPoint" })
    });
    const ctx = (await put.json()).context;
    assert.equal(ctx.updated_by, "PowerPoint");
    assert.ok(ctx.updated_at);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → "handleWorkspaceRequest is not a function".

- [ ] **Step 3: Implement the handler** (append to `tools/workspace.mjs`)

```javascript
export function handleWorkspaceRequest(store, req, res, url) {
  if (!url.pathname.startsWith("/api/workspace")) return false;
  const send = (status, obj) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Vary": "Origin"
    });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/api/workspace") {
    const since = Number(url.searchParams.get("since_rev"));
    if (Number.isFinite(since) && store.rev <= since) {
      res.writeHead(304, { "Cache-Control": "no-store" }); res.end(); return true;
    }
    send(200, store.snapshot()); return true;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/items") {
    readJson(req, (body) => {
      const r = store.addItem(body ?? {});
      r.ok ? send(200, { rev: store.rev, item: r.item }) : send(400, { ok: false, error: r.error });
    });
    return true;
  }

  const idMatch = url.pathname.match(/^\/api\/workspace\/items\/([\w-]+)$/);
  if (req.method === "DELETE" && idMatch) {
    store.deleteItem(idMatch[1]).ok ? send(200, { rev: store.rev }) : send(404, { ok: false });
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/workspace/context") {
    readJson(req, (body) => {
      const r = store.setContext(body ?? {});
      r.ok ? send(200, { rev: store.rev, context: r.context }) : send(400, { ok: false, error: r.error });
    });
    return true;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true"
    });
    res.end(); return true;
  }

  send(405, { ok: false, error: "Metode tidak didukung." });
  return true;
}

function readJson(req, cb) {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { try { cb(JSON.parse(raw || "{}")); } catch { cb(null); } });
}
```

**Note to implementer:** before finalizing headers, READ `tools/dev-server.mjs`'s existing `/api/*` handlers and reuse its exact CORS approach (it has an `allowedOrigins` gate — the workspace endpoints must pass through the same `allowApiOrigin`-style check the other API routes use, not a bare `*`; adjust the code above to match the real helper).

- [ ] **Step 4: Wire into `tools/dev-server.mjs`** — near the other `/api` routes:

```javascript
import { createWorkspaceStore, handleWorkspaceRequest } from "./workspace.mjs";
const workspaceStore = createWorkspaceStore({ filePath: path.join(process.cwd(), "data", "workspace.json") });
// inside the request handler, alongside the other /api checks:
if (url.pathname.startsWith("/api/workspace")) {
  if (!allowApiOrigin(req, res)) return;               // same origin gate as other APIs
  handleWorkspaceRequest(workspaceStore, req, res, url);
  return;
}
```

- [ ] **Step 5: Run tests** — `npm test` → green (all prior + 2 new). Manual smoke: `node tools/dev-server.mjs` then `curl -sk https://localhost:3000/api/workspace` → `{"rev":0,...}`.
- [ ] **Step 6: Commit** — `git add tantular_office_addin/tools/workspace.mjs tantular_office_addin/tools/dev-server.mjs tantular_office_addin/tests/workspace.test.mjs && git commit -m "feat(workspace): HTTP handler with since_rev/304 wired into companion"`

---

### Task 3: Pane client module (pure builders + poll scheduler)

**Files:**
- Create: `tantular_office_addin/src/workspaceClient.js`
- Test: `tantular_office_addin/tests/workspaceClient.test.mjs`

**Interfaces:**
- Consumes: `companionUrl(path)` from `src/companionUrl.js` (read it for the exact export name).
- Produces:
  `deriveLabel(text) → string` (first markdown heading stripped of `#`, else first 8 words; ≤120 chars);
  `bannerText(item) → string` (`Konten masuk dari {source_host}: "{label}" · {n} kata`);
  `wordCount(text) → number`;
  `createPoller({ fetchFn, onUpdate, onError, intervalMs=4000, backoffMs=30000, isVisible }) → {start, stop, pollNow}` — calls `fetchFn(sinceRev)`; `fetchFn` resolves `{status, body}`; 304 → no `onUpdate`; success resets backoff; failure switches to backoff interval; `isVisible()` gates scheduling;
  `sendItem({source_host, kind, label, text}) → Promise` and `deleteItem(id)`, `putContext({instructions, source_host})`, `fetchWorkspace(sinceRev)` — thin fetch wrappers over the API;
  `dismissedIds` / `usedIds` helpers backed by localStorage keys `tantular.workspace.dismissed.v1` / `tantular.workspace.used.v1` (bounded to 50 ids each, oldest dropped).

- [ ] **Step 1: Write the failing tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLabel, bannerText, wordCount, createPoller } from "../src/workspaceClient.js";

test("deriveLabel prefers first heading, else first 8 words", () => {
  assert.equal(deriveLabel("## Bab 2 — Roadmap\nisi..."), "Bab 2 — Roadmap");
  assert.equal(deriveLabel("satu dua tiga empat lima enam tujuh delapan sembilan"),
    "satu dua tiga empat lima enam tujuh delapan");
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
```

(Adjust expectations to the real implementation's call ordering if needed, but the four behaviors — 304 no-op, update on 200, 30000ms backoff after failure, no fetch while hidden — must each be pinned.)

- [ ] **Step 2: Run to verify failure.** `npm test` → module not found.
- [ ] **Step 3: Implement `src/workspaceClient.js`** per the Interfaces block: pure functions first; `createPoller` takes injectable `scheduleFn`/`cancelFn` (default `setTimeout`/`clearTimeout`) and tracks `sinceRev` internally from the last 200 body's `rev`; fetch wrappers use `companionUrl("/api/workspace…")` and `fetch` with JSON, returning `{status, body}` without throwing on non-2xx (except network errors, which reject).
- [ ] **Step 4: Run tests** — green.
- [ ] **Step 5: Commit** — `git add tantular_office_addin/src/workspaceClient.js tantular_office_addin/tests/workspaceClient.test.mjs && git commit -m "feat(workspace): pane client with visibility-gated since_rev polling"`

---

### Task 4: Send + receive UI (banner, inbox, confirm-replace, XSS guard)

**Files:**
- Create: `tantular_office_addin/src/workspaceUi.js`
- Modify: `tantular_office_addin/src/taskpane.html` (inside the Teks/seleksi `<section>`: a send button next to "Ambil seleksi", and below the textarea: `<div id="workspace-banner" class="hidden"></div>`, `<details id="workspace-inbox"><summary>Ambil dari aplikasi lain (10 kiriman terakhir)</summary><div id="workspace-inbox-list"></div></details>`)
- Modify: `tantular_office_addin/src/taskpane.js` (mount call in `bootstrap`/`Office.onReady`), `src/taskpane.css` (styles)
- Test: `tantular_office_addin/tests/workspaceClient.test.mjs` (append XSS source-scan test)

**Interfaces:**
- Consumes: Task 3's client; `state.host` (normalized host name) and `els.sourceText` (the Teks/seleksi textarea) from taskpane.js.
- Produces: `mountWorkspace({ host, sourceTextEl, statusEl, doc }) → {refresh}` in `workspaceUi.js` — builds the button/banner/inbox behavior. Target-fill actions per host: PowerPoint → "Pakai sebagai brief Deck Studio"; Excel → "Pakai sebagai brief Sheet Studio"; Word → "Tempel ke Teks/seleksi". ALL of these fill `sourceTextEl.value` (that box feeds every Studio and chat context), differing only in button wording.

- [ ] **Step 1: Write the failing XSS + behavior tests** (append to `tests/workspaceClient.test.mjs`)

```javascript
import fs from "node:fs";

test("workspace render modules never use innerHTML", () => {
  for (const f of ["../src/workspaceUi.js", "../src/workspaceClient.js"]) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), `${f} must be text-only`);
  }
});

test("confirmReplace logic: only prompts when target non-empty and different", async () => {
  const { needsConfirm } = await import("../src/workspaceUi.js");
  assert.equal(needsConfirm("", "baru"), false);
  assert.equal(needsConfirm("sama", "sama"), false);
  assert.equal(needsConfirm("lama", "baru"), true);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `workspaceUi.js`.** Requirements the code must satisfy (build DOM with `document.createElement` + `textContent` exclusively):
  - Send button "Kirim ke aplikasi lain": disabled when last poll failed (client exposes `lastOk`); a 404 from `/api/workspace` (participant's Companion predates the workspace API) is treated exactly like unreachable, with the specific hint "Perbarui paket Companion"; on click POST with `{source_host: host, kind: host === "Excel" ? "range" : "selection", label: deriveLabel(text), text}` from `sourceTextEl.value` (trimmed; ignore empty with a status note); then `poller.pollNow()` (immediate refresh) and status "Terkirim ke workspace ✓".
  - `export function needsConfirm(existing, incoming) { return Boolean(existing.trim()) && existing !== incoming; }` — used by every fill action; when true, a two-button inline confirm strip replaces the banner actions ("Kotak tujuan sudah berisi teks — ganti?" [Ganti] [Batal]).
  - Banner: newest non-dismissed, non-used item with `source_host !== host`; shows `bannerText(item)`; actions per host + "Abaikan" (adds to dismissedIds, hides banner only).
  - Inbox list: ALL current items (including same-host), each row `[{source_host}] {label} · {HH:MM}` + host-appropriate "Pakai" + "Hapus" (DELETE then pollNow). "Pakai" fills target (with confirm rule), adds ✓ via usedIds.
  - Poller `onUpdate` re-renders banner+list; mount starts the poller and returns `{refresh: pollNow}`.
- [ ] **Step 4: Wire into `taskpane.html`/`taskpane.js`/`taskpane.css`** — mount after `renderForHost()` inside `Office.onReady` (all three hosts): `import("./workspaceUi.js").then(({ mountWorkspace }) => mountWorkspace({ host: state.host, sourceTextEl: els.sourceText, statusEl: els.selectionMeta, doc: document }));` plus minimal styles (banner: soft highlight card; inbox rows: small flex rows).
- [ ] **Step 5: Run tests** (`npm test` green) + browser preview smoke: `npm run dev` and open `https://localhost:3000/src/taskpane.html?host=Word` — banner appears after `curl` POSTing an Excel-sourced item.
- [ ] **Step 6: Commit** — `git add tantular_office_addin/src/workspaceUi.js tantular_office_addin/src/taskpane.html tantular_office_addin/src/taskpane.js tantular_office_addin/src/taskpane.css tantular_office_addin/tests/workspaceClient.test.mjs && git commit -m "feat(workspace): send button, incoming banner, inbox with confirm-replace (text-only rendering)"`

---

### Task 5: Shared project instructions promotion

**Files:**
- Modify: `tantular_office_addin/src/taskpane.js` (the project-instructions save/load paths — find `PROJECT_INSTRUCTIONS_KEY`, `hydrateProjectInstructions`, and the "Simpan instruksi" handler)
- Test: `tantular_office_addin/tests/workspaceClient.test.mjs` (append pure-logic test)

**Interfaces:**
- Consumes: Task 3's `putContext`/`fetchWorkspace`; existing localStorage flow stays as offline fallback.
- Produces: `shouldAdoptServerContext(serverContext, lastAppliedUpdatedAt) → boolean` exported from `workspaceClient.js` — true when `serverContext.updated_at` exists and differs from `lastAppliedUpdatedAt` (string compare; server ordering, no clock math).

- [ ] **Step 1: Failing test**

```javascript
test("shouldAdoptServerContext uses server ordering only", async () => {
  const { shouldAdoptServerContext } = await import("../src/workspaceClient.js");
  assert.equal(shouldAdoptServerContext({ updated_at: "2026-08-09T10:00:00Z" }, null), true);
  assert.equal(shouldAdoptServerContext({ updated_at: "A" }, "A"), false);
  assert.equal(shouldAdoptServerContext({ updated_at: null }, null), false);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** In taskpane.js: on "Simpan instruksi" → existing localStorage write PLUS `putContext({instructions, source_host: state.host})` (failure → status note "tersimpan lokal; Companion tidak terjangkau"). In the poller's `onUpdate` (and initial fetch): if `shouldAdoptServerContext(body.context, state.lastContextUpdatedAt)` → set the instructions textarea + localStorage, record `state.lastContextUpdatedAt = body.context.updated_at`, and show the provenance note "Instruksi bersama · diperbarui dari {updated_by}" via `textContent` in the existing status element under the instructions box.
- [ ] **Step 4: Run tests** — green.
- [ ] **Step 5: Commit** — `git add tantular_office_addin/src/taskpane.js tantular_office_addin/src/workspaceClient.js tantular_office_addin/tests/workspaceClient.test.mjs && git commit -m "feat(workspace): shared project instructions with server-ordered adoption"`

---

### Task 6: Docs + acceptance checklist (+ portal note)

**Files:**
- Create: `tantular_office_addin/docs/WORKSPACE.md`
- Modify: `tantular_office_addin/workshop/support.html` (one feature line in the fitur/desc area of index or support — one sentence: "Workspace: kirim konten antar Word/Excel/PowerPoint lewat Companion.")

**Steps:**
- [ ] **Step 1: Write `docs/WORKSPACE.md`** (Indonesian): what it is; the send/receive flow with the three host actions; lifecycle rules (Abaikan = sembunyikan di aplikasi ini; Pakai = isi kotak, TIDAK menghapus; Hapus = hapus untuk semua; hanya 10 kiriman terakhir disimpan); shared instructions behavior; and the **manual acceptance checklist**: (1) Word: select text → Kirim; (2) PowerPoint: banner appears ≤5s → "Pakai sebagai brief Deck Studio" fills the box (confirm prompt when box non-empty); (3) PowerPoint: Kirim the outline text; (4) Excel: banner → "Pakai sebagai brief Sheet Studio"; (5) same-host: send from Word, Word shows NO banner but the inbox lists it; (6) stop the Companion → send button disabled with hint, no error dialogs; restart → inbox intact; (7) save instructions in Word → within ~5s Excel/PPT panes show "Instruksi bersama · diperbarui dari Word".
- [ ] **Step 2: Run full suite one last time** (`npm test` — expect 103 + ~13 new all green).
- [ ] **Step 3: Commit** — `git add tantular_office_addin/docs/WORKSPACE.md tantular_office_addin/workshop/support.html && git commit -m "docs(workspace): user guide + manual acceptance checklist"`
- [ ] **Step 4 (controller step, post-review):** rebuild + deploy the portal and rebuild the workshop package so the new pane code and support-page line go live (`npm run release:workshop-web`, `node tools/build-workshop-package.mjs --base-url https://workshop-web-gamma.vercel.app`, `vercel deploy --prod` from `dist/workshop-web`). Note: participants' Companions only gain the workspace API after re-downloading the package — the pane must therefore treat 404 from `/api/workspace` exactly like Companion-unreachable (button disabled, hint "Perbarui paket Companion"), which the implementer of Task 4 must handle (`status === 404` → `lastOk = false` with that specific hint).

---

## Final gate

- All new tests green alongside the existing suite; `node --check` on every modified pane file.
- Manual acceptance checklist executed on this Mac (Word → PowerPoint → Excel path) and results recorded in `docs/WORKSPACE.md`'s checklist section.
- Final whole-branch review covers the workspace commits together with the fine-tune fix-queue commits when the queue resumes.
