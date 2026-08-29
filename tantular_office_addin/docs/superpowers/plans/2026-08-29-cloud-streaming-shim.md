# Cloud Mode Streaming Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the seven streaming chat pipelines work in Cloud Mode by having the hosted gateway re-emit its non-streaming upstream result as the SSE frames the shipped client already parses.

**Architecture:** The gateway calls upstream with `stream: false` — deliberately, so `usage` arrives in-band and the future meter never has to parse a stream. When the *client* asked for `stream: true`, the gateway converts that JSON completion into two `data:` frames plus `[DONE]`. No client change, no mode branch in `streamedAnswer`, and `usage` stays available server-side for the metering work that follows.

**Tech Stack:** Node 18+ ESM, `node --test` (`npm test`), Vercel serverless function handler, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-cloud-metered-billing-design.md` — §2 (pre-existing defect), §4.9 (shim vs passthrough), §7.4 (how the shim is tested).

## Global Constraints

- **This plan is a bug fix, not billing work.** It adds no auth, no meter, no ledger, no
  payment code. If a step seems to need one, the step is wrong.
- **No client-side changes to `src/tantularClient.js` or `src/chat/pipelines/*`.** The
  whole point of the shim is that the shipped parser is left alone. A fix that edits the
  client is a different design (spec §4.9 rejected it).
- **`usage` must remain reachable by the gateway** after the change. The meter depends on
  it; a shim that discards it defeats §4.4.
- **User-facing strings are Indonesian.** This plan introduces none, but must not
  accidentally surface an English error.
- **Never log prompt or completion content** (spec §6.6). Existing `console.error` calls
  log upstream *error* text and stay as they are; add no new logging of bodies.
- **`dist/workshop-web/` is generated.** The source of truth is `workshop/api/`. Never
  hand-edit the `dist` copy; regenerate with `npm run release:workshop-web`.
- Existing test conventions: `node:test` + `node:assert/strict`, one file per area under
  `tests/`, fetch stubbed via `globalThis.fetch` and always restored in a `finally`.
- **Baseline, measured 2026-08-29 before any of this work:** `npm test` reports
  621 tests, 620 pass, 1 skipped, 0 fail. "No regressions" means that number of failures
  stays at zero and the skip count does not grow.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `workshop/api/chat-completions.js` | hosted gateway; the one place text leaves the machine | Modify: add `sseFromCompletion()` and a streaming branch on the success path; correct the stale local-only comment |
| `tests/workshopChatCompletions.test.mjs` | gateway handler behaviour | Modify: add shim tests, including one through the real SSE parser |
| `tests/tantularClientStream.test.mjs` | client streaming contract | Modify: add the end-to-end regression that the gateway's own output drives `runTantularStream` |
| `dist/workshop-web/api/chat-completions.js` | generated copy served by Vercel | Regenerated only, never edited |

`src/chat/sse.js` and `src/tantularClient.js` are **read** by the tests and are not modified.

---

### Task 1: Gateway re-emits a streamed request as SSE

**Files:**
- Modify: `workshop/api/chat-completions.js` (success path, currently the `response.setHeader("Content-Type", "application/json")` block near the end of the `try`)
- Test: `tests/workshopChatCompletions.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sseFromCompletion(rawJsonText: string) => string` — module-private helper in
  `workshop/api/chat-completions.js`, returning the full SSE body as a single string.
  Behaviour depended on by Task 2: exactly three `data:` frames, in order — a content
  frame carrying `choices[0].delta.content`, a final frame carrying `finish_reason` and
  `usage`, then `data: [DONE]`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/workshopChatCompletions.test.mjs`. Note the new import at the
top of the file — the test parses the gateway's output with the **real** client
accumulator, not a reimplementation of it:

```javascript
import { createSseAccumulator } from "../src/chat/sse.js";
```

```javascript
// The upstream reply the gateway will be converting, shaped like a real
// OpenAI-compatible non-streaming completion.
function upstreamCompletion(content) {
  return JSON.stringify({
    id: "cmpl-1",
    model: "Qwen/Qwen3.5-9B",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
  });
}

// Collect every `data:` payload from an SSE body using the client's own parser.
function parseFrames(sseBody) {
  const acc = createSseAccumulator();
  return acc.push(sseBody).map((payload) => JSON.parse(payload));
}

// REGRESSION: seven of the eight chat pipelines go through streamedAnswer ->
// runTantularStream, which sends stream:true and reads SSE `data:` frames
// (src/chat/sse.js). The gateway forces stream:false and returned a plain JSON
// body, so no `data:` line ever appeared, the accumulated text stayed empty and
// runTantularStream threw "Model tidak mengembalikan teks." — i.e. ordinary
// chat was dead in Cloud Mode while the non-streaming structured pipelines
// worked fine, which is why it went unnoticed.
test("chat-completions re-emits a streamed request as SSE the client's parser understands", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo dunia") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const request = {
        method: "POST",
        body: { messages: [{ role: "user", content: "hai" }], stream: true }
      };
      const response = mockResponse();
      await handler(request, response);

      assert.equal(response.statusCode, 200);
      assert.match(response.headers["Content-Type"], /text\/event-stream/);
      assert.ok(response.body.endsWith("data: [DONE]\n\n"), "stream must terminate with [DONE]");

      const frames = parseFrames(response.body);
      assert.equal(frames.length, 2, "one content frame and one final frame, before [DONE]");
      assert.equal(frames[0].choices[0].delta.content, "Halo dunia");
      assert.equal(frames[1].choices[0].finish_reason, "stop");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The shim exists so the meter never has to parse a stream (spec 4.4/4.9):
// usage must survive the conversion rather than being dropped with the
// non-streaming envelope.
test("chat-completions keeps upstream usage in the final SSE frame", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } }, response);
      const frames = parseFrames(response.body);
      assert.deepEqual(frames.at(-1).usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// runTantular (EDIT_TEKS, the intent router, Deck/Document/Workbook Studio)
// does NOT stream. Those paths work today and must keep getting plain JSON.
test("chat-completions still returns plain JSON when the client did not ask to stream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => upstreamCompletion("Halo") });
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }] } }, response);
      assert.equal(response.headers["Content-Type"], "application/json");
      assert.equal(JSON.parse(response.body).choices[0].message.content, "Halo");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The upstream is still called non-streaming whatever the client asked for:
// that is what keeps `usage` in-band and the meter simple.
test("chat-completions never forwards stream:true to the upstream", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, text: async () => upstreamCompletion("Halo") };
  };
  try {
    await withEnv({ TANTULAR_UPSTREAM_URL: "https://upstream.example/v1/chat", TANTULAR_UPSTREAM_KEY: "k" }, async () => {
      const response = mockResponse();
      await handler({ method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } }, response);
      assert.equal(capturedBody.stream, false);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/workshopChatCompletions.test.mjs`

Expected: FAIL. The first test fails on `assert.match(response.headers["Content-Type"], /text\/event-stream/)` because the handler sets `application/json` for every success. The "never forwards stream:true" test passes already — `payload.stream` is hardcoded `false` — and that is fine; it is a guard against a future regression, not a red test.

- [ ] **Step 3: Add the converter**

In `workshop/api/chat-completions.js`, above `export default async function handler`:

```javascript
// The client's streaming path (runTantularStream in src/tantularClient.js) sends
// stream:true and reads SSE `data:` frames, taking choices[0].delta.content
// (src/chat/sse.js only yields lines beginning with "data:"). This route calls the
// upstream with stream:false on purpose, so `usage` comes back in-band and the meter
// never has to parse a stream — which left the streamed pipelines reading a plain JSON
// body, finding no frames, and failing with "Model tidak mengembalikan teks."
//
// So the completion is re-emitted here in the shape that parser expects.
//
// This is a SHIM, not streaming: the text still arrives in one burst after the full
// wait. True passthrough streaming is a deferred milestone and carries a billing
// consequence — see docs/superpowers/specs/2026-08-29-cloud-metered-billing-design.md
// section 4.9 — so it is deliberately not attempted here.
function sseFromCompletion(rawJsonText) {
  let parsed = null;
  try { parsed = JSON.parse(rawJsonText); } catch { parsed = null; }
  const choice = parsed?.choices?.[0] ?? {};
  const content = String(choice.message?.content ?? "");

  // An unparseable or contentless upstream reply yields an empty delta on purpose:
  // the client then raises its own "Model tidak mengembalikan teks.", which is the
  // truthful outcome, rather than this route inventing text.
  const chunk = (delta, finishReason, extra = {}) => JSON.stringify({
    id: parsed?.id ?? null,
    object: "chat.completion.chunk",
    model: parsed?.model ?? null,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  });

  return `data: ${chunk({ role: "assistant", content }, null)}\n\n`
    + `data: ${chunk({}, choice.finish_reason ?? "stop", { usage: parsed?.usage ?? null })}\n\n`
    + "data: [DONE]\n\n";
}
```

- [ ] **Step 4: Branch the success path**

In the same file, replace the two success lines at the end of the `try` block:

```javascript
    response.setHeader("Content-Type", "application/json");
    return response.status(200).send(text);
```

with:

```javascript
    // Answer in the shape the caller asked for. Errors above stay JSON: the client's
    // streaming path reads them with response.text() before touching the body stream.
    if (body.stream === true) {
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      return response.status(200).send(sseFromCompletion(text));
    }
    response.setHeader("Content-Type", "application/json");
    return response.status(200).send(text);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/workshopChatCompletions.test.mjs`
Expected: PASS, all tests in the file, including the pre-existing ones.

- [ ] **Step 6: Run the whole suite for regressions**

Run: `npm test`
Expected: PASS. Pay attention to `tests/localRouting.test.mjs` and
`tests/companionUrl.test.mjs` — they pin the local/cloud boundary this change sits next
to, and neither should move.

- [ ] **Step 7: Commit**

```bash
git add workshop/api/chat-completions.js tests/workshopChatCompletions.test.mjs
git commit -m "fix(gateway): re-emit cloud completions as SSE so streamed chat works"
```

---

### Task 2: Prove it end to end against the real client

**Files:**
- Test: `tests/tantularClientStream.test.mjs`

**Interfaces:**
- Consumes: `sseFromCompletion` behaviour from Task 1, exercised only through the exported
  `handler` — the test must not import the private helper.
- Produces: nothing consumed by later tasks.

**Why this task is separate:** Task 1 proves the gateway emits frames a parser accepts.
This proves the actual shipped function `runTantularStream` returns text when driven by
the gateway's real output. Those are different claims, and only the second one is the bug
the user experiences.

- [ ] **Step 1: Write the failing test**

Add to `tests/tantularClientStream.test.mjs`. Note the two new imports at the top of the
file:

```javascript
import gatewayHandler from "../workshop/api/chat-completions.js";
```

```javascript
// Drive the REAL gateway handler, capture the REAL body it produces, and feed exactly
// that to the REAL client streaming function. No hand-written SSE fixture: a fixture
// would have hidden this bug, because the fixture is what the client always agreed with
// — it was the gateway that disagreed.
async function gatewayBodyFor(content) {
  const captured = { statusCode: null, body: null, headers: {} };
  captured.status = (code) => { captured.statusCode = code; return captured; };
  captured.json = (payload) => { captured.body = payload; return captured; };
  captured.send = (text) => { captured.body = text; return captured; };
  captured.setHeader = (name, value) => { captured.headers[name] = value; };
  captured.end = () => captured;

  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.TANTULAR_UPSTREAM_URL;
  const originalKey = process.env.TANTULAR_UPSTREAM_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      id: "cmpl-1",
      model: "Qwen/Qwen3.5-9B",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
    })
  });
  process.env.TANTULAR_UPSTREAM_URL = "https://upstream.example/v1/chat";
  process.env.TANTULAR_UPSTREAM_KEY = "k";
  try {
    await gatewayHandler(
      { method: "POST", body: { messages: [{ role: "user", content: "hai" }], stream: true } },
      captured
    );
    return captured.body;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.TANTULAR_UPSTREAM_URL;
    else process.env.TANTULAR_UPSTREAM_URL = originalUrl;
    if (originalKey === undefined) delete process.env.TANTULAR_UPSTREAM_KEY;
    else process.env.TANTULAR_UPSTREAM_KEY = originalKey;
  }
}

function responseStreamingBytes(text) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          }
        };
      }
    },
    text: async () => ""
  };
}

// REGRESSION (Cloud Mode, all seven streaming pipelines: UMUM, RINGKAS, UBAH_NADA,
// TERJEMAH, CEK_AMAN, DRAFT_TEKS, TANYA_DOKUMEN). Before the gateway shim, the body it
// returned was plain JSON with no `data:` lines, so the accumulator yielded nothing,
// `full` stayed empty, and this threw "Model tidak mengembalikan teks." on every
// ordinary chat message in the cloud.
test("runTantularStream returns text when driven by the real gateway's own body", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const gatewayBody = await gatewayBodyFor("Halo dunia");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseStreamingBytes(gatewayBody);
  try {
    const { runTantularStream } = await import("../src/tantularClient.js");
    let streamed = "";
    const out = await runTantularStream({ system: "s", user: "u", onToken: (t) => { streamed += t; } });
    assert.equal(out, "Halo dunia");
    assert.equal(streamed, "Halo dunia", "the pane's incremental callback must also receive the text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Confirm the test genuinely covers the bug**

Temporarily revert Task 1 Step 4 (make the handler always send JSON), then run:

Run: `node --test tests/tantularClientStream.test.mjs`
Expected: FAIL with `Model tidak mengembalikan teks.` — the exact production symptom.

Restore Task 1 Step 4 before continuing. Do not commit the reverted state.

- [ ] **Step 3: Run the test against the real implementation**

Run: `node --test tests/tantularClientStream.test.mjs`
Expected: PASS.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/tantularClientStream.test.mjs
git commit -m "test(gateway): pin streamed cloud chat end to end through the real client"
```

---

### Task 3: Correct the false local-only comment

**Files:**
- Modify: `workshop/api/chat-completions.js:9-11`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Documentation only — separated because a reviewer
  could reasonably accept the code fix and dispute the wording.

**Background:** the header says the installed add-in never reaches this route. That stopped
being true when in-Office Cloud Mode shipped: `src/companionUrl.js:6-8` documents case 3,
"Installed Office add-in, mode `cloud`", gated by the `chosenInOffice` consent record that
only the in-pane toggle under a real Office host can write. The routing is correct; only
the comment is wrong, and a false comment about where text goes is worth more than a
typo's attention.

- [ ] **Step 1: Replace the stale paragraph**

Replace these lines:

```javascript
// The installed Office add-in never reaches this route: companionUrl() keeps it
// pointed at the local companion whenever Office.js is present, so an install
// stays local-only exactly as promised.
```

with:

```javascript
// An installed Office add-in reaches this route ONLY in a deliberate Cloud Mode
// session: companionUrl() keeps it pointed at the local companion unless the user
// switched modes in the pane, and loadMode() honours that switch only when the
// consent record carries chosenInOffice — which nothing but the in-pane toggle,
// running under a real Office host, can write (see src/companionUrl.js). An install
// left alone therefore never sends text here; one whose owner chose cloud does.
```

- [ ] **Step 2: Verify nothing else asserts the old claim**

Run: `grep -rn "stays local-only\|never reaches this route" workshop/ src/ docs/ --include=*.js --include=*.md`
Expected: no hits outside `dist/` (which is regenerated in Task 4).

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS — a comment change must not move any test.

- [ ] **Step 4: Commit**

```bash
git add workshop/api/chat-completions.js
git commit -m "docs(gateway): correct the stale local-only claim in the header"
```

---

### Task 4: Regenerate the deployed copy and verify in real hosts

**Files:**
- Regenerate: `dist/workshop-web/` (via `npm run release:workshop-web`; `tools/build-workshop-web.mjs:28-29` copies `workshop/api` to `dist/workshop-web/api`)

**Interfaces:**
- Consumes: the committed source from Tasks 1-3. Produces: the artifact Vercel serves.

**Why this is its own task:** `dist/workshop-web/api/chat-completions.js` is what actually
runs in production. Tasks 1-3 change nothing a user can see until this runs. It also ends
in black-box verification, which this project treats as the acceptance bar — fixture-only
and mocked-only evidence is not acceptance, and every test above is in-process.

- [ ] **Step 1: Regenerate**

Run: `npm run release:workshop-web`

- [ ] **Step 2: Verify the generated copy matches source**

Run: `diff workshop/api/chat-completions.js dist/workshop-web/api/chat-completions.js`
Expected: no output. Any difference means the build did not pick up the change; fix the
build rather than editing `dist` by hand.

- [ ] **Step 3: Run the suite once more**

Run: `npm test`
Expected: PASS. `tests/releaseWorkshop.test.mjs` covers release integrity and must stay
green.

- [ ] **Step 4: Commit**

```bash
git add dist/workshop-web
git commit -m "build(workshop): regenerate the hosted bundle with the SSE shim"
```

- [ ] **Step 5: Black-box verification — portal**

Deploy the branch, open the hosted portal in a plain browser (no Office), and send an
ordinary chat message — a `UMUM` turn such as "Jelaskan apa itu APBN dalam dua kalimat."

Expected: a normal Indonesian answer. Record the result.

**Before the fix this is the failing case**, so if the portal answers fine here,
stop and report it: the §2 defect was a code-reading conclusion, never executed, and a
passing pre-fix portal would mean the analysis is wrong and this plan is solving a
non-problem.

- [ ] **Step 6: Black-box verification — installed add-in, Cloud Mode**

In Word on Mac with the add-in sideloaded, switch to Cloud Mode in Settings (the
deliberate in-pane toggle), then send the same `UMUM` message, and one `RINGKAS` request
over a selection.

Expected: both answer. Confirm the privacy banner still reports Cloud Mode.

- [ ] **Step 7: Black-box verification — the paths that already worked**

Still in Cloud Mode, run one `EDIT_TEKS` request over a selection — a non-streaming path
that works today.

Expected: still works. This is the regression that would matter most, because Task 1
touched the response shape for every caller of the route.

- [ ] **Step 8: Record the evidence**

Append the three results — portal, in-Office streamed, in-Office structured — with dates
and host versions to `docs/LOOKUP_REAL_OFFICE_ACCEPTANCE.md`, following the format already
used there.

```bash
git add docs/LOOKUP_REAL_OFFICE_ACCEPTANCE.md
git commit -m "docs(acceptance): record real-host verification of the cloud SSE shim"
```

---

## Not in this plan

The billing subsystem from the spec — identity and accounts (§3), the meter (§4), contract
validation (§5), ledger and payments (§6), abuse defense (§6.2) — is deliberately excluded.
Each is a separate plan, and each depends on this one only in the sense that a metered
gateway should not be built on top of a broken one.

The suggested order, each producing working software on its own:

1. **This plan** — the shim. Ships alone, fixes a live defect, no billing.
2. **Identity and accounts** (spec §3) — anon issuance with Turnstile, Microsoft sign-in,
   the atomic idempotent claim. Ends with the gateway requiring a session and metering
   nothing.
3. **The meter in shadow mode** (§4, §5, §7.6) — holds, ledger, pricing, contract
   validation, recording every decision as `shadow_allowed` and refusing nothing. Ends
   with real data on reservation sizing and void rates, which is what sets the grant sizes
   left open in §9.
4. **Payments** (§6.4, §6.5) — Midtrans orders, full notification verification,
   reconciliation. Ends with credits purchasable while the meter still does not refuse.
5. **Enforcement and abuse defense** (§4.8, §6.2, §6.7) — flip shadow off behind the
   global daily ceiling, add rate limits and monitoring. Ends with the system in the spec.
