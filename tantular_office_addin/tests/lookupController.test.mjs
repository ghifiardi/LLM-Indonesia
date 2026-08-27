// The pane's whole lookup path, with a fake companion and mocked Office.
//
// The properties worth testing are about what does NOT happen: no request
// before approval, no document to a remote host, no second read between
// approval and execute.

import test from "node:test";
import assert from "node:assert/strict";
import { createLookupController, HOST, disclosureWithDocumentNote }
  from "../src/chat/lookupController.js";

const DOC = "LAPORAN\nVendor utama PT Sinar Mas. Pagu Rp 1.750.000.000.";
const VERIFIED = { ok: true, status: "verified", answer: "Pagu Rp 1.750.000.000.",
                   protected: ["Rp 1.750.000.000"], host: HOST };

function harness({ confirm = async () => true, prepare, execute,
                   readDocument = async () => ({ ok: true, text: DOC, source: "Word" }) } = {}) {
  const calls = [];
  const container = { innerHTML: "", hidden: true, querySelector: () => null };
  const dialogs = [];
  const postLocal = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/prepare")) {
      return prepare ? prepare(body)
        : { ok: true, token: "tok-1",
            disclosure: { host: HOST, query: body.query, note: "keluar" } };
    }
    return execute ? execute(body) : VERIFIED;
  };
  const run = createLookupController({
    postLocal, container, readDocument, getHost: () => "Word",
    confirm: async (dialog) => { dialogs.push(dialog); return confirm(dialog); }
  });
  return { run, calls, container, dialogs };
}

test("the happy path: read, prepare, approve, execute, render verified", async () => {
  const h = harness();
  const out = await h.run({ mode: "local+search", query: "harga semen 2026" });
  assert.equal(out.status, "verified");
  assert.deepEqual(h.calls.map((c) => c.path),
                   ["/api/lookup/prepare", "/api/lookup/execute"]);
  assert.match(h.container.innerHTML, /data-state="verified"/);
  assert.equal(h.container.hidden, false);
});

test("Mode Lokal sends nothing and reads nothing", async () => {
  let read = false;
  const h = harness({ readDocument: async () => { read = true; return { ok: true, text: DOC }; } });
  const out = await h.run({ mode: "local", query: "harga semen" });
  assert.equal(out.reason, "disabled");
  assert.equal(h.calls.length, 0, "no companion call in Mode Lokal");
  assert.equal(read, false, "the document must not even be read in Mode Lokal");
});

test("declining means execute is never called", async () => {
  const h = harness({ confirm: async () => false });
  const out = await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(out.reason, "declined");
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/lookup/prepare"]);
  assert.match(h.container.innerHTML, /data-state="blocked"/);
});

test("the dialog shows the exact host and query that will be sent", async () => {
  const h = harness();
  await h.run({ mode: "local+search", query: "harga semen 2026" });
  const dialog = h.dialogs[0];
  assert.equal(dialog.host, HOST);
  assert.equal(dialog.query, "harga semen 2026");
  // And says plainly that the document itself stays put.
  assert.match(dialog.documentNote, /TIDAK dikirim ke internet/);
});

test("the document is sent to the companion and never appears in the query", async () => {
  const h = harness();
  await h.run({ mode: "local+search", query: "harga semen" });
  for (const call of h.calls) {
    assert.equal(call.body.host, HOST);
    assert.equal(call.body.document, DOC, "the companion needs the document");
    assert.ok(!call.body.query.includes("PT Sinar Mas"),
      "document content must never travel in the query");
  }
});

test("execute reuses the token, query and document from the approval", async () => {
  // Re-reading the document here would let an edit slip in between the user's
  // approval and the request, and the companion would reject it as
  // document_changed — after the query had already gone out.
  let reads = 0;
  const h = harness({ readDocument: async () => {
    reads += 1;
    return { ok: true, text: reads === 1 ? DOC : "DOKUMEN LAIN", source: "Word" };
  } });
  await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(reads, 1, "the document is read exactly once");
  const executed = h.calls.find((c) => c.path.endsWith("/execute")).body;
  assert.equal(executed.token, "tok-1");
  assert.equal(executed.document, DOC);
});

test("an unreadable document costs no outbound request", async () => {
  const h = harness({ readDocument: async () => ({ ok: false, reason: "empty_document",
                                                   message: "Dokumen kosong." }) });
  const out = await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(out.reason, "empty_document");
  assert.equal(h.calls.length, 0, "nothing may be sent when there is no document");
  assert.match(h.container.innerHTML, /data-state="blocked"/);
});

test("an empty query is refused before anything is read", async () => {
  const h = harness();
  assert.equal((await h.run({ mode: "local+search", query: "   " })).reason, "empty_query");
  assert.equal(h.calls.length, 0);
});

test("a refused prepare is rendered as blocked and stops the flow", async () => {
  const h = harness({ prepare: () => ({ ok: false, reason: "host_not_allowed",
                                        message: "Host tidak diizinkan." }) });
  const out = await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(out.reason, "host_not_allowed");
  assert.equal(h.calls.length, 1);
  assert.equal(h.dialogs.length, 0, "no approval dialog for a refused prepare");
});

test("a document_changed verdict renders blocked with no answer", async () => {
  const h = harness({ execute: () => ({ ok: false, status: "blocked_by_verifier",
                                        reason: "document_changed", host: HOST }) });
  const out = await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(out.reason, "document_changed");
  assert.match(h.container.innerHTML, /data-state="blocked"/);
  assert.ok(!h.container.innerHTML.includes("lookup-edit"));
});

test("a blocked answer never reaches the DOM even if the server returns it", async () => {
  const h = harness({ execute: () => ({ ok: false, status: "blocked_by_verifier",
    reason: "failed_verification", answer: "vendor PT Contoh", host: HOST,
    findings: { preserves: ['"PT Sinar Mas" hilang'] } }) });
  await h.run({ mode: "local+search", query: "harga semen" });
  assert.ok(!h.container.innerHTML.includes("PT Contoh"));
});

test("truncation is disclosed in the dialog", async () => {
  const dialog = disclosureWithDocumentNote({ host: HOST, query: "x" },
                                            { source: "Word", truncated: true });
  assert.match(dialog.truncatedNote, /dipotong/);
});


// --- the transport: local companion only ------------------------------------
// Requirement: the document goes to the local companion, never to a remote
// host. companionUrl() routes to the CLOUD gateway in a cloud session, so this
// is the guard that stops the document following it there.

import { createLocalCompanionPost } from "../src/chat/lookupController.js";

test("a cloud session refuses before any request is built", async () => {
  let called = false;
  const post = createLocalCompanionPost({
    fetchImpl: async () => { called = true; },
    isCloudSession: () => true,
    companionUrl: (p) => `https://api.tantular.example${p}`
  });
  const out = await post("/api/lookup/prepare", { document: DOC });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "cloud_session");
  assert.equal(called, false, "the document must not be posted in a cloud session");
});

test("a non-local absolute URL is refused even outside a cloud session", async () => {
  let called = false;
  const post = createLocalCompanionPost({
    fetchImpl: async () => { called = true; },
    isCloudSession: () => false,
    companionUrl: (p) => `https://evil.example${p}`
  });
  const out = await post("/api/lookup/execute", { document: DOC });
  assert.equal(out.reason, "not_local");
  assert.equal(called, false);
});

test("a relative URL on a remote page is refused", async () => {
  let called = false;
  const post = createLocalCompanionPost({
    fetchImpl: async () => { called = true; },
    isCloudSession: () => false,
    companionUrl: (p) => p,
    getPageUrl: () => "https://portal.example/taskpane.html"
  });
  const out = await post("/api/lookup/execute", { document: DOC });
  assert.equal(out.reason, "not_local");
  assert.equal(called, false, "a relative path must not send the document to the portal origin");
});

test("localhost and relative paths on a local page are allowed", async () => {
  const seen = [];
  const make = (url, pageUrl = "https://localhost:3000/src/taskpane.html") =>
    createLocalCompanionPost({
    fetchImpl: async (u) => { seen.push(u); return { json: async () => ({ ok: true }) }; },
    isCloudSession: () => false, companionUrl: () => url,
    getPageUrl: () => pageUrl
  });
  for (const url of ["/api/lookup/prepare", "https://localhost:3000/api/lookup/prepare",
                     "https://127.0.0.1:3000/api/lookup/prepare"]) {
    const out = await make(url)("/api/lookup/prepare", { document: DOC });
    assert.equal(out.ok, true, url);
  }
  assert.equal(seen.length, 3);
});

test("an unreachable companion is reported, not treated as a refusal to search", async () => {
  const post = createLocalCompanionPost({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    isCloudSession: () => false, companionUrl: (p) => p
  });
  assert.equal((await post("/api/lookup/prepare", {})).reason, "companion_unreachable");
});

test("local companion calls can be bounded by a timeout", async () => {
  const post = createLocalCompanionPost({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
    isCloudSession: () => false,
    companionUrl: (path) => path
  });
  const out = await post("/api/lookup/refine", {}, { timeoutMs: 5 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "timeout");
  assert.match(out.message, /terlalu lama/);
});

test("discovery mode carries provider, not a chosen source host", async () => {
  const calls = [];
  const run = createLookupController({
    postLocal: async (path, body) => {
      calls.push({ path, body });
      return path.endsWith("prepare")
        ? { ok: true, token: "p1", disclosure: {
            host: "DuckDuckGo HTML (alpha)", provider: "duckduckgo-html",
            query: body.query
          } }
        : { ok: false, reason: "provider_error" };
    },
    confirm: async () => true,
    container: { innerHTML: "", hidden: true, querySelector: () => null },
    readDocument: async () => ({ ok: true, text: DOC, source: "Excel" }),
    getHost: () => "Excel"
  });
  await run({ mode: "local+search", query: "inflasi indonesia",
              provider: "duckduckgo-html" });
  assert.equal(calls[0].body.provider, "duckduckgo-html");
  assert.equal(calls[0].body.host, undefined);
  assert.equal(calls[1].body.provider, "duckduckgo-html");
});

test("a confirm that throws is a decline: no execute, blocked rendered", async () => {
  // Found in real Excel, 2026-08-25: window.confirm() failed in the Office
  // webview and the rejection killed the whole chain silently — buttons
  // recovered, nothing rendered, no dialog. Consent that cannot be asked for
  // is consent withheld.
  const h = harness({ confirm: async () => { throw new Error("confirm unsupported"); } });
  const out = await h.run({ mode: "local+search", query: "harga semen" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "declined");
  assert.deepEqual(h.calls.map((c) => c.path), ["/api/lookup/prepare"],
    "a failed dialog must not fall through to execute");
  assert.match(h.container.innerHTML, /data-state="blocked"/);
});
