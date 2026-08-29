# Tantular Office Chat (Word) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Copilot-style chat front door to the Tantular Word task pane — streaming, intent-routed, main-body document aware, with tracked-changes agentic editing — strictly local.

**Architecture:** Chat UI on top of the existing task pane (Word host only). Every message goes through a single-token intent router, then a deterministic typed pipeline. Document context is main-body only, chunked+summarized for long docs. Edits return a structured contract, are previewed, revalidated at apply time, and land as native Word tracked changes.

**Tech Stack:** Vanilla ES modules (no framework, matching the existing add-in), Office.js, Ollama OpenAI-compatible `/v1/chat/completions` via the dev-server proxy, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-20-tantular-office-chat-design.md` — read it before starting any task.

## Global Constraints

- **Strictly local.** All model calls go to the configured endpoint (default `/api/chat-completions` → `127.0.0.1:11434/v1/chat/completions`). No other network calls.
- **Word host only.** Chat renders only when `Office.onReady` reports Word. Excel/PowerPoint panes (including Deck Studio) must be pixel-identical to today. Existing action grid stays functional in all hosts.
- All user-facing strings in **Bahasa Indonesia**, matching existing tone (see `src/prompts.js`).
- "Document awareness" = **main body only** (`body.text`); UI label is `Dokumen (isi utama)`.
- Router taxonomy + prompt live only in `src/chat/intentRouter.js`; edit contract only in `src/chat/editContract.js` (future Tinker SFT targets).
- Streaming = SSE `data: {...}` lines ending with `data: [DONE]` (OpenAI-compatible), NOT Ollama native NDJSON.
- Edit runs: max 20 edits; each `find` ≤ 200 chars (Word search term limit is ~255); preview + explicit apply always; apply-time re-anchoring always.
- All commands below run from `tantular_office_addin/` unless stated otherwise. Commit after every task.

## File Structure

```
tantular_office_addin/
  package.json                     MODIFY: add "test" script
  tools/dev-server.mjs             MODIFY: verify/ensure unbuffered streaming proxy
  src/taskpane.html                MODIFY: add chat section markup
  src/taskpane.css                 MODIFY: chat styles
  src/taskpane.js                  MODIFY: mount chat pane for Word host
  src/tantularClient.js            MODIFY: add runTantularStream
  src/officeClient.js              MODIFY: add getDocumentBodyText
  src/chat/sse.js                  CREATE: pure SSE line accumulator
  src/chat/intentRouter.js         CREATE: taxonomy, prompt, parser, routeIntent
  src/chat/history.js              CREATE: capped conversation memory
  src/chat/contextBuilder.js       CREATE: chunker, hash, summary cache, doc context
  src/chat/editContract.js         CREATE: edit schema validation + anchor resolution
  src/chat/wordEdits.js            CREATE: tracked-changes apply path (Office.js)
  src/chat/pipelines/index.js      CREATE: intent → pipeline registry
  src/chat/pipelines/umum.js       CREATE
  src/chat/pipelines/ringkas.js    CREATE
  src/chat/pipelines/ubahNada.js   CREATE
  src/chat/pipelines/terjemah.js   CREATE
  src/chat/pipelines/cekAman.js    CREATE
  src/chat/pipelines/draftTeks.js  CREATE
  src/chat/pipelines/tanyaDokumen.js CREATE (Stage 1B)
  src/chat/pipelines/editTeks.js   CREATE (Stage 2)
  src/chat/chatPane.js             CREATE: chat UI controller
  tests/sse.test.mjs               CREATE
  tests/intentRouter.test.mjs      CREATE
  tests/history.test.mjs           CREATE
  tests/contextBuilder.test.mjs    CREATE
  tests/editContract.test.mjs      CREATE
```

Pure modules (`sse.js`, `intentRouter.js` parser, `history.js`, `contextBuilder.js` chunker/hash, `editContract.js`) must not import Office.js or `window` — that is what makes them `node --test`-able.

---

### Task 1: Test infrastructure + SSE line parser

**Files:**
- Modify: `package.json` (scripts)
- Create: `src/chat/sse.js`
- Test: `tests/sse.test.mjs`

**Interfaces:**
- Produces: `createSseAccumulator()` → `{ push(chunkText) → string[] }` — feed raw network text, get back an array of `data:` payload strings (excluding `[DONE]`); handles payloads split across chunks.

- [ ] **Step 1: Add test script**

In `package.json` `"scripts"`, add:

```json
"test": "node --test tests/"
```

- [ ] **Step 2: Write the failing test**

Create `tests/sse.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createSseAccumulator } from "../src/chat/sse.js";

test("parses complete data lines", () => {
  const acc = createSseAccumulator();
  const out = acc.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test("buffers payload split across chunks", () => {
  const acc = createSseAccumulator();
  assert.deepEqual(acc.push('data: {"choices":[{"del'), []);
  assert.deepEqual(acc.push('ta":{"content":"ha"}}]}\n\n'), ['{"choices":[{"delta":{"content":"ha"}}]}']);
});

test("swallows [DONE] and non-data lines", () => {
  const acc = createSseAccumulator();
  const out = acc.push(': keepalive\n\ndata: {"x":1}\n\ndata: [DONE]\n\n');
  assert.deepEqual(out, ['{"x":1}']);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/chat/sse.js'`

- [ ] **Step 4: Write minimal implementation**

Create `src/chat/sse.js`:

```js
// Accumulates raw SSE text from an OpenAI-compatible /v1/chat/completions
// stream and yields complete `data:` payloads. Payloads may arrive split
// across network chunks, so we buffer until a newline terminates the line.
export function createSseAccumulator() {
  let buffer = "";
  return {
    push(chunkText) {
      buffer += chunkText;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const payloads = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload && payload !== "[DONE]") payloads.push(payload);
      }
      return payloads;
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json src/chat/sse.js tests/sse.test.mjs
git commit -m "feat(office-chat): test infra + SSE accumulator"
```

---

### Task 2: Streaming client + unbuffered proxy

**Files:**
- Modify: `src/tantularClient.js`
- Modify: `tools/dev-server.mjs` (verify; fix only if buffered)

**Interfaces:**
- Consumes: `createSseAccumulator` from Task 1; existing `loadSettings()`.
- Produces: `runTantularStream({ system, user, messages, maxTokens = 1024, temperature = 0.3, onToken, signal }) → Promise<string>` — streams tokens via `onToken(text)`, resolves with the full text. `messages` (array) overrides `system`/`user` when provided. Abort via `AbortSignal` rejects with `Error("dihentikan")`.

- [ ] **Step 1: Add `runTantularStream` to `src/tantularClient.js`**

Append (imports at top: `import { createSseAccumulator } from "./chat/sse.js";`):

```js
export async function runTantularStream({ system, user, messages, maxTokens = 1024, temperature = 0.3, onToken, signal }) {
  const { endpoint, model } = loadSettings();
  const body = {
    model,
    messages: messages ?? [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature,
    max_tokens: maxTokens,
    stream: true
  };
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model endpoint gagal (${response.status}). ${text.slice(0, 240)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const acc = createSseAccumulator();
  let full = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const payload of acc.push(decoder.decode(value, { stream: true }))) {
        let delta = "";
        try {
          delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "";
        } catch { /* partial junk from server; skip */ }
        if (delta) {
          full += delta;
          onToken?.(delta);
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      const stopped = new Error("dihentikan");
      stopped.partialText = full;
      throw stopped;
    }
    throw error;
  }
  if (!full.trim()) throw new Error("Model tidak mengembalikan teks.");
  return full.trim();
}
```

- [ ] **Step 2: Verify the proxy streams unbuffered**

Open `tools/dev-server.mjs` `proxyChatCompletions`. It must pipe the upstream response through as chunks arrive. If the handler already does `proxyRes.pipe(res)` (check the callback after `res.writeHead`), it is unbuffered — no change. If it accumulates the body before responding, replace the response handling with:

```js
(proxyRes) => {
  res.writeHead(proxyRes.statusCode || 502, {
    "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache"
  });
  proxyRes.pipe(res);
}
```

- [ ] **Step 3: Manual smoke test of streaming end-to-end**

With `ollama serve` running and any chat model pulled:

```bash
npm run dev &
curl -sk -N https://localhost:3000/api/chat-completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:8b","messages":[{"role":"user","content":"Sebutkan angka 1 sampai 5"}],"stream":true,"max_tokens":64}' | head -5
```

Expected: `data: {...}` lines appear **incrementally** (not all at once after a pause).

- [ ] **Step 4: Run unit tests still green**

Run: `npm test` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tantularClient.js tools/dev-server.mjs
git commit -m "feat(office-chat): streaming client over SSE, unbuffered proxy"
```

---

### Task 3: Intent router

**Files:**
- Create: `src/chat/intentRouter.js`
- Test: `tests/intentRouter.test.mjs`

**Interfaces:**
- Consumes: `runTantular` from `src/tantularClient.js` (existing non-streaming call).
- Produces:
  - `INTENTS` — frozen array: `["TANYA_DOKUMEN","EDIT_TEKS","DRAFT_TEKS","TERJEMAH","RINGKAS","UBAH_NADA","CEK_AMAN","UMUM"]`
  - `parseIntent(raw: string) → string` — always returns a member of `INTENTS` (fallback `"UMUM"`); pure.
  - `routeIntent(message: string) → Promise<string>` — one LLM call, `max_tokens: 8`, `temperature: 0`; never throws (network error → `"UMUM"`).
  - `defaultContextFor(intent, hasSelection) → "selection" | "document" | "none"` — pure; implements the spec table, `UMUM` never returns `"document"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/intentRouter.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { INTENTS, parseIntent, defaultContextFor } from "../src/chat/intentRouter.js";

test("parses exact and messy router output", () => {
  assert.equal(parseIntent("EDIT_TEKS"), "EDIT_TEKS");
  assert.equal(parseIntent("  jawaban: RINGKAS."), "RINGKAS");
  assert.equal(parseIntent("TERJEMAHKAN"), "TERJEMAH"); // substring-tolerant
});

test("unparseable output falls to UMUM", () => {
  assert.equal(parseIntent(""), "UMUM");
  assert.equal(parseIntent("saya tidak yakin"), "UMUM");
  assert.equal(parseIntent(null), "UMUM");
});

test("longest intent wins when outputs overlap", () => {
  // TANYA_DOKUMEN contains no other intent, but guard ordering anyway
  assert.equal(parseIntent("TANYA_DOKUMEN"), "TANYA_DOKUMEN");
});

test("default context table", () => {
  assert.equal(defaultContextFor("TANYA_DOKUMEN", false), "document");
  assert.equal(defaultContextFor("EDIT_TEKS", true), "selection");
  assert.equal(defaultContextFor("EDIT_TEKS", false), "document");
  assert.equal(defaultContextFor("RINGKAS", false), "document");
  assert.equal(defaultContextFor("DRAFT_TEKS", true), "none");
  assert.equal(defaultContextFor("TERJEMAH", true), "selection");
  assert.equal(defaultContextFor("UMUM", true), "selection");
  assert.equal(defaultContextFor("UMUM", false), "none"); // never "document"
});

test("INTENTS is the frozen taxonomy", () => {
  assert.ok(Object.isFrozen(INTENTS));
  assert.equal(INTENTS.length, 8);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/chat/intentRouter.js`**

```js
import { runTantular } from "../tantularClient.js";

// Router taxonomy + prompt live ONLY here — this exact contract is the
// future Tinker SFT target. Do not duplicate elsewhere.
export const INTENTS = Object.freeze([
  "TANYA_DOKUMEN", "EDIT_TEKS", "DRAFT_TEKS", "TERJEMAH",
  "RINGKAS", "UBAH_NADA", "CEK_AMAN", "UMUM"
]);

export const ROUTER_SYSTEM = [
  "Anda router intent untuk asisten dokumen Word Bahasa Indonesia.",
  "Balas HANYA satu kata tanpa tanda baca, salah satu dari:",
  "TANYA_DOKUMEN (bertanya tentang isi dokumen),",
  "EDIT_TEKS (merevisi/memperbaiki teks yang sudah ada),",
  "DRAFT_TEKS (menulis konten baru untuk disisipkan),",
  "TERJEMAH (menerjemahkan),",
  "RINGKAS (meringkas),",
  "UBAH_NADA (mengubah nada formal/santai),",
  "CEK_AMAN (cek penipuan/keamanan),",
  "UMUM (lainnya, obrolan biasa).",
  "Jika ragu, jawab UMUM."
].join(" ");

export function parseIntent(raw) {
  const value = String(raw ?? "").toUpperCase();
  // Longest-first so overlapping names can never mis-match.
  const byLength = [...INTENTS].sort((a, b) => b.length - a.length);
  for (const intent of byLength) {
    if (value.includes(intent)) return intent;
  }
  return "UMUM";
}

export async function routeIntent(message) {
  try {
    const raw = await runTantular({
      system: ROUTER_SYSTEM,
      user: String(message ?? "").slice(0, 2000),
      maxTokens: 8,
      temperature: 0
    });
    return parseIntent(raw);
  } catch {
    return "UMUM"; // router must never hard-fail
  }
}

export function defaultContextFor(intent, hasSelection) {
  switch (intent) {
    case "TANYA_DOKUMEN": return "document";
    case "EDIT_TEKS": return hasSelection ? "selection" : "document";
    case "RINGKAS": return hasSelection ? "selection" : "document";
    case "DRAFT_TEKS": return hasSelection ? "none" : "none";
    case "TERJEMAH":
    case "UBAH_NADA":
    case "CEK_AMAN": return hasSelection ? "selection" : "none";
    // Spec: UMUM (incl. parse fallback) must never auto-read the main body.
    default: return hasSelection ? "selection" : "none";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat/intentRouter.js tests/intentRouter.test.mjs
git commit -m "feat(office-chat): single-token intent router with UMUM fallback"
```

---

### Task 4: Conversation history

**Files:**
- Create: `src/chat/history.js`
- Test: `tests/history.test.mjs`

**Interfaces:**
- Produces: `createHistory({ maxChars = 6000 })` → `{ add(role, content), toMessages() → {role, content}[], clear() }`. `toMessages()` returns newest-complete history whose total content length ≤ `maxChars`, dropping oldest turns first, never splitting a turn, always keeping the most recent turn even if oversized (truncated to `maxChars`).

- [ ] **Step 1: Write the failing tests**

Create `tests/history.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHistory } from "../src/chat/history.js";

test("keeps turns in order", () => {
  const h = createHistory({ maxChars: 1000 });
  h.add("user", "halo");
  h.add("assistant", "hai");
  assert.deepEqual(h.toMessages(), [
    { role: "user", content: "halo" },
    { role: "assistant", content: "hai" }
  ]);
});

test("drops oldest turns beyond cap, never splits a turn", () => {
  const h = createHistory({ maxChars: 10 });
  h.add("user", "aaaaaa");   // 6
  h.add("assistant", "bbbb"); // 4 → total 10, both fit
  h.add("user", "cc");        // pushes total to 12 → drop oldest
  const msgs = h.toMessages();
  assert.deepEqual(msgs.map((m) => m.content), ["bbbb", "cc"]);
});

test("most recent turn survives even if oversized (truncated)", () => {
  const h = createHistory({ maxChars: 5 });
  h.add("user", "abcdefghij");
  assert.deepEqual(h.toMessages(), [{ role: "user", content: "abcde" }]);
});

test("clear empties history", () => {
  const h = createHistory({ maxChars: 100 });
  h.add("user", "x");
  h.clear();
  assert.deepEqual(h.toMessages(), []);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test`, FAIL module not found.

- [ ] **Step 3: Implement `src/chat/history.js`**

```js
export function createHistory({ maxChars = 6000 } = {}) {
  let turns = [];
  return {
    add(role, content) {
      turns.push({ role, content: String(content ?? "") });
    },
    toMessages() {
      const result = [];
      let total = 0;
      for (let i = turns.length - 1; i >= 0; i--) {
        const { role, content } = turns[i];
        if (result.length === 0 && content.length > maxChars) {
          result.unshift({ role, content: content.slice(0, maxChars) });
          break;
        }
        if (total + content.length > maxChars) break;
        total += content.length;
        result.unshift({ role, content });
      }
      return result;
    },
    clear() {
      turns = [];
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test`, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/history.js tests/history.test.mjs
git commit -m "feat(office-chat): capped conversation history"
```

---

### Task 5: Stage-1A pipelines (selection/none context)

**Files:**
- Create: `src/chat/pipelines/index.js`, `umum.js`, `ringkas.js`, `ubahNada.js`, `terjemah.js`, `cekAman.js`, `draftTeks.js`

**Interfaces:**
- Consumes: `runTantularStream` (Task 2), `ACTIONS` and `scopedUserPrompt` from `src/prompts.js`.
- Produces: `getPipeline(intent) → run` where `run({ instruction, contextText, history, emit, signal }) → Promise<PipelineResult>`; `PipelineResult = { kind: "text", text: string }` (Stage 2 adds `kind: "edits"`). `emit(token)` receives streamed tokens. Registry maps `TANYA_DOKUMEN` and `EDIT_TEKS` to `umum` for now (replaced in Tasks 7/9).

- [ ] **Step 1: Implement shared helper + pipelines**

`src/chat/pipelines/index.js`:

```js
import { runUmum } from "./umum.js";
import { runRingkas } from "./ringkas.js";
import { runUbahNada } from "./ubahNada.js";
import { runTerjemah } from "./terjemah.js";
import { runCekAman } from "./cekAman.js";
import { runDraftTeks } from "./draftTeks.js";

const REGISTRY = {
  UMUM: runUmum,
  RINGKAS: runRingkas,
  UBAH_NADA: runUbahNada,
  TERJEMAH: runTerjemah,
  CEK_AMAN: runCekAman,
  DRAFT_TEKS: runDraftTeks,
  // Stage 1B replaces this with the real doc-QA pipeline (Task 7):
  TANYA_DOKUMEN: runUmum,
  // Stage 2 replaces this with the edit-contract pipeline (Task 9):
  EDIT_TEKS: runUmum
};

export function getPipeline(intent) {
  return REGISTRY[intent] ?? runUmum;
}

export function registerPipeline(intent, run) {
  REGISTRY[intent] = run;
}

// Shared: one streamed completion over history + fresh user turn.
// (Static import at top of file: `import { runTantularStream } from "../../tantularClient.js";`)
export async function streamedAnswer({ system, userText, history, emit, signal, maxTokens = 1024 }) {
  const messages = [
    { role: "system", content: system },
    ...(history?.toMessages() ?? []),
    { role: "user", content: userText }
  ];
  const text = await runTantularStream({ messages, maxTokens, temperature: 0.3, onToken: emit, signal });
  return { kind: "text", text };
}

export function withContext(instruction, contextText, label) {
  if (!contextText) return instruction;
  return `${instruction}\n\n${label}:\n"""${contextText}"""`;
}
```

`src/chat/pipelines/umum.js`:

```js
import { streamedAnswer, withContext } from "./index.js";

const SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab jelas, singkat, dan bermanfaat dalam Bahasa Indonesia.",
  "Jangan mengarang isi dokumen: jika konteks tidak diberikan, katakan bahwa Anda tidak membaca dokumen dan sarankan memilih teks atau mengubah pil konteks.",
  "Jangan gunakan JSON kecuali diminta."
].join(" ");

export function runUmum({ instruction, contextText, history, emit, signal }) {
  return streamedAnswer({
    system: SYSTEM,
    userText: withContext(instruction, contextText, "Konteks (seleksi pengguna)"),
    history, emit, signal
  });
}
```

`src/chat/pipelines/ringkas.js` (reuses the proven action prompt):

```js
import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runRingkas({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.word_summarize;
  const text = contextText || "";
  if (!text) return Promise.resolve({ kind: "text", text: "Tidak ada teks untuk diringkas. Pilih teks di dokumen atau ubah pil konteks ke Dokumen (isi utama)." });
  return streamedAnswer({
    system: action.system,
    userText: scopedUserPrompt(action, action.buildUser({ text: text.slice(0, action.maxInputChars), instruction })),
    history, emit, signal
  });
}
```

`src/chat/pipelines/ubahNada.js`:

```js
import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runUbahNada({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.word_rewrite;
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin diubah nadanya terlebih dahulu." });
  const user = `Ubah nada teks berikut sesuai instruksi (formal/santai/lainnya) tanpa mengubah makna, nama, dan angka.\n\nInstruksi: ${instruction || "formal"}\n\nTeks:\n"""${contextText.slice(0, action.maxInputChars)}"""`;
  return streamedAnswer({ system: action.system, userText: scopedUserPrompt(action, user), history, emit, signal });
}
```

`src/chat/pipelines/terjemah.js`:

```js
import { streamedAnswer } from "./index.js";

const SYSTEM = [
  "Anda penerjemah profesional Indonesia-Inggris dua arah.",
  "Terjemahkan akurat, natural, pertahankan nama, angka, dan istilah teknis.",
  "Balas hanya hasil terjemahan tanpa penjelasan kecuali diminta."
].join(" ");

export function runTerjemah({ instruction, contextText, history, emit, signal }) {
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin diterjemahkan terlebih dahulu." });
  const user = `Terjemahkan teks berikut. ${instruction || "Jika teks berbahasa Indonesia, terjemahkan ke Inggris; jika berbahasa Inggris, ke Indonesia."}\n\nTeks:\n"""${contextText.slice(0, 8000)}"""`;
  return streamedAnswer({ system: SYSTEM, userText: user, history, emit, signal });
}
```

`src/chat/pipelines/cekAman.js`:

```js
import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runCekAman({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.scam_check;
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin dicek keamanannya terlebih dahulu." });
  return streamedAnswer({
    system: action.system,
    userText: scopedUserPrompt(action, action.buildUser({ text: contextText.slice(0, action.maxInputChars), instruction })),
    history, emit, signal
  });
}
```

`src/chat/pipelines/draftTeks.js`:

```js
import { streamedAnswer } from "./index.js";

const SYSTEM = [
  "Anda penulis dokumen Bahasa Indonesia yang jelas dan profesional.",
  "Tulis konten baru sesuai permintaan: surat, memo, paragraf, kerangka, dan sejenisnya.",
  "Jangan mengarang fakta spesifik (nama, angka, tanggal) yang tidak diberikan; gunakan placeholder seperti [NAMA] bila perlu.",
  "Balas hanya draf teksnya."
].join(" ");

export function runDraftTeks({ instruction, contextText, history, emit, signal }) {
  const user = contextText
    ? `${instruction}\n\nGunakan konteks berikut bila relevan:\n"""${contextText.slice(0, 6000)}"""`
    : instruction;
  return streamedAnswer({ system: SYSTEM, userText: user, history, emit, signal, maxTokens: 1536 });
}
```

- [ ] **Step 2: Run tests still green** — `npm test`, PASS (pipelines have no unit tests; they are template + streamed call, covered by manual checklist).

- [ ] **Step 3: Commit**

```bash
git add src/chat/pipelines/
git commit -m "feat(office-chat): stage-1A typed pipelines"
```

---

### Task 6: Chat pane UI (Stage 1A complete)

**Files:**
- Modify: `src/taskpane.html` (chat section above settings card)
- Modify: `src/taskpane.css`
- Modify: `src/taskpane.js` (mount for Word)
- Create: `src/chat/chatPane.js`

**Interfaces:**
- Consumes: `routeIntent`, `defaultContextFor` (Task 3); `createHistory` (Task 4); `getPipeline` (Task 5); `getSelectionContext` from `src/officeClient.js`; `actionsForHost` from `src/prompts.js`.
- Produces: `mountChatPane({ host })` exported from `src/chat/chatPane.js` — called by `taskpane.js` only when `host === "Word"`. DOM ids used by later tasks: `#chat-messages`, `#chat-input`, `#chat-send`, `#chat-stop`, `#chat-context-pill`, `#chat-chips`.

- [ ] **Step 1: Add chat markup to `src/taskpane.html`**

Insert directly after the `</header>` closing tag (before the settings card):

```html
    <section class="card chat hidden" id="chat-card" aria-labelledby="chat-title">
      <div class="section-title-row">
        <h2 id="chat-title">💬 Tantular Chat</h2>
        <button id="chat-context-pill" class="pill pill-button" type="button"
                title="Konteks yang akan dibaca Tantular">Konteks: —</button>
      </div>
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div>
      <div id="chat-chips" class="chat-chips"></div>
      <div class="chat-input-row">
        <textarea id="chat-input" rows="2"
          placeholder="Tanya atau minta sesuatu… (Enter untuk kirim, Shift+Enter baris baru)"></textarea>
        <button id="chat-send" class="primary" type="button">Kirim</button>
        <button id="chat-stop" class="secondary hidden" type="button">Stop</button>
      </div>
    </section>
```

- [ ] **Step 2: Add chat styles to `src/taskpane.css`**

Append:

```css
.chat-messages { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; padding: 4px 0; }
.chat-bubble { border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.chat-bubble.user { background: #2b6cb0; color: #fff; align-self: flex-end; max-width: 85%; }
.chat-bubble.assistant { background: var(--card-alt, #f1f3f5); align-self: flex-start; max-width: 95%; }
.chat-bubble.error { background: #fdecea; color: #86181d; }
.chat-bubble .intent-tag { display: block; font-size: 10px; opacity: 0.6; margin-bottom: 2px; }
.chat-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chat-chip { font-size: 12px; border: 1px solid #ccc; border-radius: 999px; padding: 3px 10px; background: transparent; cursor: pointer; }
.chat-chip:hover { background: #eef2f7; }
.chat-input-row { display: flex; gap: 6px; align-items: flex-end; }
.chat-input-row textarea { flex: 1; resize: vertical; }
.pill-button { cursor: pointer; border: 1px solid #ccc; }
```

- [ ] **Step 3: Implement `src/chat/chatPane.js`**

```js
import { routeIntent, defaultContextFor } from "./intentRouter.js";
import { createHistory } from "./history.js";
import { getPipeline } from "./pipelines/index.js";
import { getSelectionContext } from "../officeClient.js";
import { actionsForHost } from "../prompts.js";

const CONTEXT_LABELS = { selection: "Seleksi", document: "Dokumen (isi utama)", none: "Tanpa konteks" };
const CONTEXT_ORDER = ["selection", "document", "none"];

export function mountChatPane({ host }) {
  const card = document.querySelector("#chat-card");
  if (!card || host !== "Word") return;
  card.classList.remove("hidden");

  const els = {
    messages: card.querySelector("#chat-messages"),
    input: card.querySelector("#chat-input"),
    send: card.querySelector("#chat-send"),
    stop: card.querySelector("#chat-stop"),
    pill: card.querySelector("#chat-context-pill"),
    chips: card.querySelector("#chat-chips")
  };
  const history = createHistory({ maxChars: 6000 });
  const state = { contextOverride: null, abort: null, busy: false };

  renderChips();
  setPill(null);

  els.send.addEventListener("click", () => send());
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  els.pill.addEventListener("click", () => {
    const current = state.contextOverride ?? "selection";
    const next = CONTEXT_ORDER[(CONTEXT_ORDER.indexOf(current) + 1) % CONTEXT_ORDER.length];
    state.contextOverride = next;
    setPill(next);
  });

  function renderChips() {
    // Word-applicable existing actions become quick prompts (spec: Word only).
    const prompts = {
      word_rewrite: "Perbaiki bahasa teks yang saya pilih.",
      word_summarize: "Ringkas teks yang saya pilih.",
      scam_check: "Cek apakah teks yang saya pilih berisiko penipuan.",
      ppt_bullets: "Ubah teks yang saya pilih menjadi bullet slide.",
      text_cleanup: "Bersihkan dan standarkan teks yang saya pilih."
    };
    for (const action of actionsForHost("Word")) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.textContent = action.label;
      chip.addEventListener("click", () => {
        els.input.value = prompts[action.id] ?? action.label;
        els.input.focus();
      });
      els.chips.appendChild(chip);
    }
  }

  function setPill(mode) {
    els.pill.textContent = `Konteks: ${mode ? CONTEXT_LABELS[mode] : "otomatis"}`;
  }

  function addBubble(cls, text = "") {
    const div = document.createElement("div");
    div.className = `chat-bubble ${cls}`;
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    return div;
  }

  async function gatherContext(mode) {
    if (mode === "none") return { text: "", label: "none" };
    if (mode === "selection") {
      const selection = await getSelectionContext("Word");
      return { text: selection.text ?? "", label: "selection" };
    }
    // "document" — Stage 1A has no doc reader yet; Task 7 swaps this in.
    const { buildDocumentContext } = await import("./contextBuilder.js").catch(() => ({}));
    if (!buildDocumentContext) return { text: "", label: "none" };
    return { text: await buildDocumentContext({ emitProgress: (msg) => setBusyNote(msg) }), label: "document" };
  }

  let busyNote = null;
  function setBusyNote(text) {
    if (!busyNote) busyNote = addBubble("assistant", "");
    busyNote.textContent = text;
  }

  async function send() {
    const message = els.input.value.trim();
    if (!message || state.busy) return;
    state.busy = true;
    els.input.value = "";
    els.send.classList.add("hidden");
    els.stop.classList.remove("hidden");
    addBubble("user", message);
    const answer = addBubble("assistant", "");
    state.abort = new AbortController();
    try {
      const intent = await routeIntent(message);
      const selection = await getSelectionContext("Word");
      const hasSelection = Boolean(selection.text?.trim());
      const mode = state.contextOverride ?? defaultContextFor(intent, hasSelection);
      setPill(mode);
      const context = mode === "selection"
        ? { text: selection.text ?? "" }
        : await gatherContext(mode);
      const tag = document.createElement("span");
      tag.className = "intent-tag";
      tag.textContent = `${intent} · ${CONTEXT_LABELS[mode]}`;
      answer.prepend(tag);
      const result = await getPipeline(intent)({
        instruction: message,
        contextText: context.text,
        history,
        emit: (token) => {
          answer.append(token);
          els.messages.scrollTop = els.messages.scrollHeight;
        },
        signal: state.abort.signal
      });
      if (result.kind === "edits") {
        const { renderEditPreview } = await import("./wordEdits.js");
        renderEditPreview({ container: els.messages, edits: result.edits, addBubble });
      }
      // kind === "text" needs nothing extra: tokens were already streamed
      // into the bubble via emit().
      history.add("user", message);
      history.add("assistant", result.kind === "text" ? result.text : JSON.stringify(result.edits));
    } catch (error) {
      if (String(error?.message) === "dihentikan") {
        answer.append(" (dihentikan)");
        if (error.partialText) history.add("assistant", error.partialText);
      } else {
        addBubble("error", String(error?.message ?? error));
      }
    } finally {
      busyNote = null;
      state.busy = false;
      state.abort = null;
      els.send.classList.remove("hidden");
      els.stop.classList.add("hidden");
    }
  }
}
```

- [ ] **Step 4: Mount from `src/taskpane.js`**

In `bootstrap()`'s `Office.onReady` callback, after `renderForHost();` add:

```js
if (state.host === "Word") {
  import("./chat/chatPane.js").then(({ mountChatPane }) => mountChatPane({ host: state.host }));
}
```

(Also add the same two lines in the browser-preview `else` branch after `renderForHost();` — preview treats host as Word.)

- [ ] **Step 5: Manual sideload test (Stage 1A checklist)**

`npm run dev`, `ollama serve`, sideload `manifest.xml` in Word:
1. Chat card visible in Word; **not visible** when sideloaded in Excel/PowerPoint.
2. Type "halo, apa kabar" → streams an answer token-by-token, intent tag shows `UMUM`.
3. Select a paragraph → "ringkas teks ini" → routes `RINGKAS`, uses selection.
4. Stop button aborts mid-stream, bubble shows "(dihentikan)".
5. Chips prefill the input; existing action grid + Hasil card still work.
6. Kill Ollama → send → red error bubble with fix text, pane still alive.

- [ ] **Step 6: Commit**

```bash
git add src/taskpane.html src/taskpane.css src/taskpane.js src/chat/chatPane.js
git commit -m "feat(office-chat): Word chat pane with streaming, chips, context pill"
```

---

### Task 7: Stage 1B — main-body context builder

**Files:**
- Modify: `src/officeClient.js` (add `getDocumentBodyText`)
- Create: `src/chat/contextBuilder.js`
- Create: `src/chat/pipelines/tanyaDokumen.js`
- Modify: `src/chat/pipelines/index.js` (register real `TANYA_DOKUMEN`)
- Test: `tests/contextBuilder.test.mjs`

**Interfaces:**
- Consumes: `runTantular` (map-step summaries), Word API `body.text`.
- Produces:
  - `chunkText(text, { chunkSize = 3000 }) → string[]` — pure; splits on paragraph boundaries (`\n`), never mid-paragraph unless a single paragraph exceeds `chunkSize` (then hard-split).
  - `hashText(text) → string` — pure djb2 hex.
  - `buildDocumentContext({ emitProgress }) → Promise<string>` — raw body if ≤ 6000 chars; else map/reduce summary; throws Indonesian error if > 60000 chars; caches `{ docKey, chunks: [{hash, summary}] }` in module state, invalidated when body hash changes.
  - `getDocumentBodyText() → Promise<string>` in `officeClient.js` via `Word.run` + `body.text` (main body only).

- [ ] **Step 1: Write the failing tests**

Create `tests/contextBuilder.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, hashText } from "../src/chat/contextBuilder.js";

test("short text is a single chunk", () => {
  assert.deepEqual(chunkText("halo dunia", { chunkSize: 3000 }), ["halo dunia"]);
});

test("splits on paragraph boundaries, not mid-paragraph", () => {
  const p1 = "a".repeat(1800), p2 = "b".repeat(1800), p3 = "c".repeat(1800);
  const chunks = chunkText(`${p1}\n${p2}\n${p3}`, { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].includes(p1) && !chunks[0].includes("b"));
});

test("hard-splits a single oversized paragraph", () => {
  const chunks = chunkText("x".repeat(7000), { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3000);
});

test("hash is stable and change-sensitive", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test`, FAIL module not found.

- [ ] **Step 3: Implement `src/chat/contextBuilder.js`**

```js
import { runTantular } from "../tantularClient.js";
import { getDocumentBodyText } from "../officeClient.js";

const RAW_LIMIT = 6000;
const HARD_CAP = 60000;
const CHUNK_SIZE = 3000;

export function chunkText(text, { chunkSize = CHUNK_SIZE } = {}) {
  const paragraphs = String(text ?? "").split("\n");
  const chunks = [];
  let current = "";
  const flush = () => { if (current) { chunks.push(current); current = ""; } };
  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      flush();
      for (let i = 0; i < para.length; i += chunkSize) chunks.push(para.slice(i, i + chunkSize));
      continue;
    }
    if (current.length + para.length + 1 > chunkSize) flush();
    current = current ? `${current}\n${para}` : para;
  }
  flush();
  return chunks.length ? chunks : [""];
}

export function hashText(text) {
  let h = 5381;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Cache shaped for future per-chunk invalidation (spec): v1 invalidates
// wholesale when the body hash (docKey) changes.
let cache = null; // { docKey, chunks: [{ hash, summary }] }

const SUMMARY_SYSTEM = "Anda peringkas dokumen Bahasa Indonesia. Ringkas bagian dokumen berikut menjadi 2-4 kalimat padat yang mempertahankan fakta, nama, dan angka. Balas hanya ringkasannya.";

export async function buildDocumentContext({ emitProgress } = {}) {
  const body = await getDocumentBodyText();
  if (body.length > HARD_CAP) {
    throw new Error(`Dokumen terlalu panjang (${body.length} karakter; batas ${HARD_CAP}). Pilih bagian yang relevan lalu gunakan konteks Seleksi.`);
  }
  if (body.length <= RAW_LIMIT) return body;

  const docKey = hashText(body);
  if (cache?.docKey === docKey) {
    return cache.chunks.map((c) => c.summary).join("\n\n");
  }
  const chunks = chunkText(body);
  const summarized = [];
  for (let i = 0; i < chunks.length; i++) {
    emitProgress?.(`Membaca dokumen… bagian ${i + 1}/${chunks.length}`);
    const summary = await runTantular({
      system: SUMMARY_SYSTEM,
      user: chunks[i],
      maxTokens: 256,
      temperature: 0.1
    });
    summarized.push({ hash: hashText(chunks[i]), summary });
  }
  cache = { docKey, chunks: summarized };
  return summarized.map((c) => c.summary).join("\n\n");
}

export function clearDocumentContextCache() { cache = null; }
```

Note: importing this module pulls in `officeClient.js`, which imports nothing Office-global at module top level — safe under `node --test` as long as tests only import `chunkText`/`hashText` (they do).

- [ ] **Step 4: Add `getDocumentBodyText` to `src/officeClient.js`**

Append:

```js
// Main body ONLY: body.text excludes headers, footers, footnotes, text
// boxes, and comments. UI must say "Dokumen (isi utama)".
export async function getDocumentBodyText() {
  if (!globalThis.Word) throw new Error("Fitur ini membutuhkan Word JavaScript API.");
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text ?? "";
  });
}
```

- [ ] **Step 5: Implement `src/chat/pipelines/tanyaDokumen.js` and register it**

```js
import { streamedAnswer } from "./index.js";

const SYSTEM = [
  "Anda adalah Tantular, asisten dokumen Word privat Bahasa Indonesia.",
  "Jawab pertanyaan HANYA berdasarkan konteks dokumen yang diberikan.",
  "Konteks berasal dari isi utama dokumen (tanpa header/footer/kotak teks).",
  "Jika jawaban tidak ada di konteks, katakan tidak ditemukan di isi utama dokumen. Jangan mengarang."
].join(" ");

export function runTanyaDokumen({ instruction, contextText, history, emit, signal }) {
  if (!contextText) {
    return Promise.resolve({ kind: "text", text: "Saya belum bisa membaca dokumen. Coba lagi, atau pilih teks dan gunakan konteks Seleksi." });
  }
  const user = `Konteks dokumen (isi utama):\n"""${contextText}"""\n\nPertanyaan: ${instruction}`;
  return streamedAnswer({ system: SYSTEM, userText: user, history, emit, signal });
}
```

In `src/chat/pipelines/index.js`: `import { runTanyaDokumen } from "./tanyaDokumen.js";` and change the registry line to `TANYA_DOKUMEN: runTanyaDokumen,`.

- [ ] **Step 6: Run tests** — `npm test`, PASS.

- [ ] **Step 7: Manual sideload test (Stage 1B checklist)**

1. Short doc (< 6k chars): "apa isi dokumen ini?" → answers from raw body, no progress messages.
2. Long doc (paste ~20k chars): same question → progress bubble counts "bagian 1/7…", then answer.
3. Ask a second question → no re-summarize (cache hit, instant context).
4. Edit the doc, ask again → re-summarizes (cache invalidated).
5. Paste > 60k chars → clear Indonesian refusal naming the limit.

- [ ] **Step 8: Commit**

```bash
git add src/officeClient.js src/chat/contextBuilder.js src/chat/pipelines/ tests/contextBuilder.test.mjs
git commit -m "feat(office-chat): stage-1B main-body context builder with summary cache"
```

---

### Task 8: Edit contract — validation + anchor resolution

**Files:**
- Create: `src/chat/editContract.js`
- Test: `tests/editContract.test.mjs`

**Interfaces:**
- Produces (all pure):
  - `parseEditContract(raw: string) → { edits } ` — extracts the first JSON object from model output (tolerates code fences), validates schema; throws Indonesian `Error` on malformed input. Enforces: `edits` array 1–20 items; each item has string `find` (1–200 chars) and `replace`; optional `before`, `after` (strings), `occurrence` (integer ≥ 1, default 1), `alasan`.
  - `locateEdit(docText, edit) → { index, length } | { error: "not_found" | "ambiguous" }` — finds candidate matches of `find` (exact, then one whitespace-normalized retry), filters by `before`/`after` context windows, then picks by `occurrence`. Must resolve to exactly one location.
  - `resolveEdits(docText, edits) → Array<{ edit, index, length } | { edit, error }>`.
  - `EDIT_SYSTEM_PROMPT` — the SFT-target prompt instructing the model to emit the contract (lives ONLY here).

- [ ] **Step 1: Write the failing tests**

Create `tests/editContract.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseEditContract, locateEdit, resolveEdits } from "../src/chat/editContract.js";

const DOC = "Laporan tahunan.\nPendapatan naik 10 persen.\nPendapatan naik 10 persen di Q4.\nPenutup.";

test("parses contract from fenced JSON", () => {
  const raw = 'Berikut:\n```json\n{"edits":[{"find":"naik","replace":"meningkat","alasan":"formal"}]}\n```';
  const { edits } = parseEditContract(raw);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].occurrence, 1);
});

test("rejects malformed contracts", () => {
  assert.throws(() => parseEditContract("bukan json"));
  assert.throws(() => parseEditContract('{"edits":[]}'));
  assert.throws(() => parseEditContract(JSON.stringify({ edits: Array.from({ length: 21 }, () => ({ find: "a", replace: "b" })) })));
  assert.throws(() => parseEditContract(JSON.stringify({ edits: [{ find: "x".repeat(201), replace: "y" }] })));
});

test("unique find resolves", () => {
  const r = locateEdit(DOC, { find: "Laporan tahunan.", replace: "", occurrence: 1 });
  assert.equal(r.index, 0);
  assert.equal(r.length, "Laporan tahunan.".length);
});

test("repeated find without disambiguation is ambiguous", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", occurrence: 1 });
  assert.equal(r.error, "ambiguous");
});

test("after-context disambiguates repeated find", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", after: " di Q4", occurrence: 1 });
  assert.equal(DOC.slice(r.index, r.index + r.length), "Pendapatan naik 10 persen");
  assert.ok(DOC.slice(r.index).includes("di Q4"));
});

test("occurrence disambiguates repeated find", () => {
  const r = locateEdit(DOC, { find: "Pendapatan naik 10 persen", replace: "", occurrence: 2 });
  assert.ok(r.index > DOC.indexOf("Pendapatan"));
});

test("whitespace-normalized retry", () => {
  const r = locateEdit("kata  ganda di sini", { find: "kata ganda", replace: "", occurrence: 1 });
  assert.equal(r.index, 0);
});

test("missing anchor reports not_found", () => {
  assert.equal(locateEdit(DOC, { find: "tidak ada", replace: "", occurrence: 1 }).error, "not_found");
});

test("resolveEdits keeps per-edit status", () => {
  const out = resolveEdits(DOC, [
    { find: "Penutup.", replace: "Selesai.", occurrence: 1 },
    { find: "hilang", replace: "x", occurrence: 1 }
  ]);
  assert.equal(out[0].index >= 0, true);
  assert.equal(out[1].error, "not_found");
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test`, FAIL module not found.

- [ ] **Step 3: Implement `src/chat/editContract.js`**

```js
// Edit contract lives ONLY here — future Tinker SFT target.
export const EDIT_SYSTEM_PROMPT = [
  "Anda editor dokumen Bahasa Indonesia yang teliti.",
  "Balas HANYA JSON valid dengan bentuk:",
  '{"edits":[{"find":"<teks persis dari dokumen>","replace":"<teks baru>","before":"<±40 karakter sebelum find>","after":"<±40 karakter sesudah find>","occurrence":1,"alasan":"<alasan singkat>"}]}',
  "Aturan: find harus persis sama dengan teks di dokumen (maksimal 200 karakter);",
  "gunakan before/after untuk membedakan teks yang berulang; maksimal 20 edit;",
  "jangan ubah makna, nama, angka kecuali diminta; tanpa teks lain di luar JSON."
].join(" ");

const MAX_EDITS = 20;
const MAX_FIND = 200;

export function parseEditContract(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model tidak mengembalikan JSON edit yang valid.");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("JSON edit dari model tidak bisa dibaca.");
  }
  const edits = parsed?.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Tidak ada edit yang diusulkan.");
  if (edits.length > MAX_EDITS) throw new Error(`Terlalu banyak edit (${edits.length}); maksimal ${MAX_EDITS}.`);
  return {
    edits: edits.map((e, i) => {
      const find = String(e?.find ?? "");
      const replace = String(e?.replace ?? "");
      if (!find) throw new Error(`Edit #${i + 1} tidak punya "find".`);
      if (find.length > MAX_FIND) throw new Error(`Edit #${i + 1}: "find" terlalu panjang (maksimal ${MAX_FIND} karakter).`);
      const occurrence = Number.isInteger(e?.occurrence) && e.occurrence >= 1 ? e.occurrence : 1;
      return {
        find, replace, occurrence,
        before: typeof e?.before === "string" ? e.before : "",
        after: typeof e?.after === "string" ? e.after : "",
        alasan: typeof e?.alasan === "string" ? e.alasan : ""
      };
    })
  };
}

function allIndexesOf(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function normalizeWs(s) { return s.replace(/\s+/g, " "); }

function contextMatches(docText, index, length, edit) {
  const windowBefore = docText.slice(Math.max(0, index - 60), index);
  const windowAfter = docText.slice(index + length, index + length + 60);
  const beforeOk = !edit.before || normalizeWs(windowBefore).includes(normalizeWs(edit.before).slice(-40));
  const afterOk = !edit.after || normalizeWs(windowAfter).includes(normalizeWs(edit.after).slice(0, 40));
  return beforeOk && afterOk;
}

export function locateEdit(docText, edit) {
  const doc = String(docText ?? "");
  let candidates = allIndexesOf(doc, edit.find).map((index) => ({ index, length: edit.find.length }));

  if (candidates.length === 0) {
    // One whitespace-normalized retry: match ignoring run-length of spaces.
    const pattern = edit.find.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    try {
      const re = new RegExp(pattern, "g");
      let m;
      while ((m = re.exec(doc)) !== null) candidates.push({ index: m.index, length: m[0].length });
    } catch { /* pattern too weird → stays not_found */ }
  }
  if (candidates.length === 0) return { error: "not_found" };

  const filtered = candidates.filter((c) => contextMatches(doc, c.index, c.length, edit));
  const pool = filtered.length > 0 ? filtered : candidates;
  if (pool.length === 1) return pool[0];
  const occurrence = edit.occurrence ?? 1;
  // occurrence only trusted when before/after narrowed nothing AND the
  // model addressed the repetition explicitly (occurrence > 1), or when
  // context filtering produced a unique-ish pool.
  if (filtered.length > 1 && occurrence <= filtered.length) return filtered[occurrence - 1];
  if (filtered.length === 0 && occurrence > 1 && occurrence <= pool.length) return pool[occurrence - 1];
  return { error: "ambiguous" };
}

export function resolveEdits(docText, edits) {
  return edits.map((edit) => {
    const r = locateEdit(docText, edit);
    return r.error ? { edit, error: r.error } : { edit, index: r.index, length: r.length };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass** — `npm test`, PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chat/editContract.js tests/editContract.test.mjs
git commit -m "feat(office-chat): edit contract validation and anchor resolution"
```

---

### Task 9: Edit pipeline + preview + tracked-changes apply

**Files:**
- Create: `src/chat/pipelines/editTeks.js`
- Create: `src/chat/wordEdits.js`
- Modify: `src/chat/pipelines/index.js` (register `EDIT_TEKS`)
- Modify: `src/taskpane.css` (preview styles)

**Interfaces:**
- Consumes: `EDIT_SYSTEM_PROMPT`, `parseEditContract`, `resolveEdits` (Task 8); `runTantular`; `getDocumentBodyText` (Task 7); `#chat-messages` DOM from Task 6.
- Produces:
  - `runEditTeks(...)` → `PipelineResult { kind: "edits", edits }` — edits already validated AND pre-resolved against the current body (unresolvable ones carry `error`).
  - `renderEditPreview({ container, edits, addBubble })` in `wordEdits.js` — checkbox list + "Terapkan (n)" button.
  - `applyTrackedEdits(checkedEdits) → Promise<Array<{edit, status}>>` — status ∈ `"applied" | "not_found" | "skipped"`; **re-resolves every edit against the freshly read body at apply time** (spec: apply-time revalidation); uses `changeTrackingMode = trackAll` when `Office.context.requirements.isSetSupported("WordApi","1.4")`, restores prior mode in `finally`; plain apply + notice otherwise.

- [ ] **Step 1: Implement `src/chat/pipelines/editTeks.js`**

```js
import { runTantular } from "../../tantularClient.js";
import { EDIT_SYSTEM_PROMPT, parseEditContract, resolveEdits } from "../editContract.js";
import { getDocumentBodyText } from "../../officeClient.js";

export async function runEditTeks({ instruction, contextText, emit }) {
  const scope = contextText
    ? `Teks yang harus diedit (dari dokumen):\n"""${contextText.slice(0, 6000)}"""`
    : "";
  emit?.("Menyusun usulan edit…");
  const raw = await runTantular({
    system: EDIT_SYSTEM_PROMPT,
    user: `${instruction}\n\n${scope}`.trim(),
    maxTokens: 1400,
    temperature: 0.1
  });
  const { edits } = parseEditContract(raw);
  const body = await getDocumentBodyText();
  return { kind: "edits", edits: resolveEdits(body, edits) };
}
```

Register in `pipelines/index.js`: `import { runEditTeks } from "./editTeks.js";` → `EDIT_TEKS: runEditTeks,`.

- [ ] **Step 2: Implement `src/chat/wordEdits.js`**

```js
import { locateEdit } from "./editContract.js";
import { getDocumentBodyText } from "../officeClient.js";

export function renderEditPreview({ container, edits, addBubble }) {
  const wrap = document.createElement("div");
  wrap.className = "chat-bubble assistant edit-preview";
  const resolvable = edits.filter((e) => !e.error);
  if (resolvable.length === 0) {
    addBubble("error", "Tidak ada edit yang bisa dijangkarkan ke dokumen. Coba pilih teksnya lalu ulangi.");
    return;
  }
  const rows = edits.map((item, i) => {
    const row = document.createElement("label");
    row.className = "edit-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !item.error;
    checkbox.disabled = Boolean(item.error);
    const desc = document.createElement("span");
    const status = item.error === "not_found" ? " ⚠ tidak ditemukan"
      : item.error === "ambiguous" ? " ✖ ambigu, dilewati" : "";
    desc.textContent = `"${item.edit.find}" → "${item.edit.replace}"${item.edit.alasan ? ` — ${item.edit.alasan}` : ""}${status}`;
    row.append(checkbox, desc);
    row.dataset.index = String(i);
    return { row, checkbox, item };
  });
  rows.forEach(({ row }) => wrap.appendChild(row));
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  const refreshLabel = () => {
    const n = rows.filter((r) => r.checkbox.checked).length;
    apply.textContent = `Terapkan (${n})`;
    apply.disabled = n === 0;
  };
  rows.forEach(({ checkbox }) => checkbox.addEventListener("change", refreshLabel));
  refreshLabel();
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    try {
      const chosen = rows.filter((r) => r.checkbox.checked).map((r) => r.item.edit);
      const results = await applyTrackedEdits(chosen);
      const lines = results.map((r) =>
        r.status === "applied" ? `✔ diterapkan: "${r.edit.find}"`
          : r.status === "not_found" ? `⚠ tidak ditemukan: "${r.edit.find}"`
            : `✖ dilewati (ambigu): "${r.edit.find}"`);
      addBubble("assistant", lines.join("\n"));
    } catch (error) {
      addBubble("error", String(error?.message ?? error));
    } finally {
      apply.disabled = false;
    }
  });
  wrap.appendChild(apply);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

export async function applyTrackedEdits(edits) {
  if (!globalThis.Word) throw new Error("Fitur edit membutuhkan Word JavaScript API.");
  const hasTracking = Office.context.requirements.isSetSupported("WordApi", "1.4");

  // Apply-time revalidation (spec): the document may have changed since
  // preview. Re-anchor every edit against the CURRENT body; stale anchors
  // must never replace the wrong text.
  const bodyNow = await getDocumentBodyText();
  const revalidated = edits.map((edit) => ({ edit, r: locateEdit(bodyNow, edit) }));

  const results = [];
  await Word.run(async (context) => {
    const doc = context.document;
    let priorMode = null;
    if (hasTracking) {
      doc.load("changeTrackingMode");
      await context.sync();
      priorMode = doc.changeTrackingMode;
      doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }
    try {
      for (const { edit, r } of revalidated) {
        if (r.error) {
          results.push({ edit, status: r.error === "not_found" ? "not_found" : "skipped" });
          continue;
        }
        // Match by content: search returns ranges in document order; count
        // occurrences of `find` before r.index in bodyNow to pick the right one.
        const nth = bodyNow.slice(0, r.index).split(edit.find).length - 1;
        const found = doc.body.search(edit.find, { matchCase: true });
        found.load("items");
        await context.sync();
        if (!found.items[nth]) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        found.items[nth].insertText(edit.replace, Word.InsertLocation.replace);
        await context.sync();
        results.push({ edit, status: "applied" });
      }
    } finally {
      if (hasTracking && priorMode !== null) {
        doc.changeTrackingMode = priorMode;
        await context.sync();
      }
    }
  });
  if (!hasTracking) {
    results.push({ edit: { find: "(info)", replace: "" }, status: "skipped" });
  }
  return results;
}
```

Note: when `hasTracking` is false the edits still apply (plain), and `renderEditPreview`'s result bubble is preceded by a notice — add before `apply.addEventListener`:

```js
if (!Office.context.requirements.isSetSupported("WordApi", "1.4")) {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Versi Word ini tidak mendukung tracked changes; edit akan diterapkan langsung (gunakan Undo untuk membatalkan).";
  wrap.appendChild(note);
}
```

- [ ] **Step 3: Add preview styles to `src/taskpane.css`**

```css
.edit-preview { display: flex; flex-direction: column; gap: 6px; }
.edit-row { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; }
.edit-row input { margin-top: 2px; }
```

- [ ] **Step 4: Run unit tests still green** — `npm test`, PASS.

- [ ] **Step 5: Manual sideload test (Stage 2 checklist)**

1. Select a paragraph → "ubah 'naik' menjadi 'meningkat' dan perbaiki ejaan" → preview list with checkboxes appears; nothing in doc yet.
2. Uncheck one edit → Terapkan (n) count updates → apply → **tracked changes visible** in Word review UI; accept/reject works.
3. Track-changes toggle in Word ribbon returns to its pre-apply state.
4. Repeat, but between preview and apply, delete the target sentence → that edit reports `⚠ tidak ditemukan`, others apply.
5. Ask an edit on text that appears twice without selecting → ambiguous edits show `✖`, are un-checkable.

- [ ] **Step 6: Commit**

```bash
git add src/chat/pipelines/editTeks.js src/chat/wordEdits.js src/chat/pipelines/index.js src/taskpane.css
git commit -m "feat(office-chat): edit pipeline, preview-before-apply, tracked-changes apply with revalidation"
```

---

### Task 10: Stage 3 — default model bump + docs

**Files:**
- Modify: `src/tantularClient.js:2` (`DEFAULT_MODEL`)
- Modify: `README.md` (quick start + chat section)

- [ ] **Step 1: Bump default model**

In `src/tantularClient.js` change:

```js
const DEFAULT_MODEL = "qwen3:8b";
```

(`tantular:0.2-id-3b-lora` remains selectable via settings; existing users' saved settings are untouched because `loadSettings` only falls back to the default when unset.)

- [ ] **Step 2: Update `README.md`**

In the Quick start, change the example `ollama run` line to `ollama pull qwen3:8b` and add a short "Chat (Word)" paragraph: chat is Word-only, context pill (`Seleksi` / `Dokumen (isi utama)` — main body only, headers/footers excluded), edits land as tracked changes after preview + Terapkan, and `npm test` runs unit tests.

- [ ] **Step 3: Full test + regression pass**

Run: `npm test` (all green) and the manual checklists from Tasks 6, 7, 9 once more on the final build; plus: Excel and PowerPoint sideload — panes unchanged, Deck Studio builds a deck, action grid works in all three hosts.

- [ ] **Step 4: Commit**

```bash
git add src/tantularClient.js README.md
git commit -m "feat(office-chat): default model qwen3:8b, docs for Word chat"
```
