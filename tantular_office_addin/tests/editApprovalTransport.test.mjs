// The /api/edit/* routes over real HTTP.
//
// editApprovalPolicy.test.mjs proves the decisions; this proves the wire:
// status codes, JSON shapes, CORS, and that single-use and idempotency survive
// the round trip rather than only holding in a Map.
//
// The server is OWNED BY THIS TEST: created here on port 0, held in a local
// handle, and closed in after(). It is never the developer's companion, and no
// PID outside this file is signalled -- importing tools/dev-server.mjs binds
// nothing, which is what makes that possible.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUDIT = path.join(process.env.HOME || os.tmpdir(), ".tantular-edit-audit.jsonl");

let server;
let origin;
let handler;
let bootId;

before(async () => {
  const mod = await import("../tools/dev-server.mjs");
  handler = mod.handler;
  bootId = mod.COMPANION_BOOT_ID;
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Always close THIS server, whatever the tests did.
  if (server) await new Promise((resolve) => server.close(resolve));
});

const DOC = "Angka lama tercatat di sini. Angka lama tercatat lagi.";
const EDIT = { find: "Angka lama", replace: "Angka baru", occurrence: 1 };
const LOCATED = { matchedText: "Angka lama", ordinal: 0 };

async function post(pathname, body, headers = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers,
           body: await response.json() };
}

function auditTail(n = 40) {
  try {
    return fs.readFileSync(AUDIT, "utf8").trim().split("\n").slice(-n)
      .map((line) => JSON.parse(line));
  } catch { return []; }
}

async function prepared() {
  const res = await post("/api/edit/prepare",
                         { edits: [EDIT], document: DOC, located: LOCATED });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test("prepare returns 200 and the full binding set", async () => {
  const body = await prepared();
  assert.equal(body.ok, true);
  for (const key of ["token", "nonce", "protocol_version", "document_version",
                     "target_digest", "edit_digest", "disclosure", "expiresAt"]) {
    assert.ok(body[key] !== undefined, `prepare response is missing ${key}`);
  }
  assert.equal(body.protocol_version, 1);
  assert.match(body.document_version, /^[0-9a-f]{64}$/);
  assert.match(body.target_digest, /^[0-9a-f]{64}$/);
  assert.match(body.edit_digest, /^[0-9a-f]{64}$/);
  // The disclosure is what the user reads, so it carries the real text -- and
  // it travels to the pane only, never to the audit log.
  assert.equal(body.disclosure.find, EDIT.find);
  assert.equal(body.disclosure.replace, EDIT.replace);
});

test("prepare refuses a batch with 403 and a named reason", async () => {
  const res = await post("/api/edit/prepare", {
    edits: [EDIT, { ...EDIT, replace: "lain" }], document: DOC, located: LOCATED });
  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, "batch_unsupported");
});

test("prepare refuses an unlocated edit with 403", async () => {
  const res = await post("/api/edit/prepare",
                         { edits: [EDIT], document: DOC, located: null });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "not_located");
});

test("execute authorises once: the replay is 409, not a second edit", async () => {
  const token = (await prepared()).token;
  const payload = { token, edit: EDIT, document: DOC, located: LOCATED };
  const first = await post("/api/edit/execute", payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.match(first.body.idempotency_key, /^[0-9a-f]{64}$/);

  const replay = await post("/api/edit/execute", payload);
  assert.equal(replay.status, 409, "a replay is a conflict, not a refusal");
  assert.equal(replay.body.reason, "duplicate");
  assert.equal(replay.body.idempotency_key, first.body.idempotency_key);
});

test("a token is single use even with a fresh idempotency key", async () => {
  // Same approval, DIFFERENT edit: the duplicate guard does not fire, so what
  // refuses here is the token itself having been spent.
  const token = (await prepared()).token;
  const ok = await post("/api/edit/execute",
                        { token, edit: EDIT, document: DOC, located: LOCATED });
  assert.equal(ok.status, 200);
  const again = await post("/api/edit/execute", {
    token, edit: { ...EDIT, replace: "berbeda" }, document: DOC, located: LOCATED });
  assert.equal(again.status, 403);
  assert.equal(again.body.reason, "unknown_token");
});

test("a changed document is refused over the wire with 403", async () => {
  const token = (await prepared()).token;
  const res = await post("/api/edit/execute", {
    token, edit: EDIT, document: DOC + " Kalimat baru.", located: LOCATED });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "document_changed");
});

test("a moved target is refused over the wire with 403", async () => {
  const token = (await prepared()).token;
  const res = await post("/api/edit/execute", {
    token, edit: EDIT, document: DOC,
    located: { matchedText: "Angka lama", ordinal: 1 } });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "target_moved");
});

test("a changed edit is refused over the wire with 403", async () => {
  const token = (await prepared()).token;
  const res = await post("/api/edit/execute", {
    token, edit: { ...EDIT, replace: "sesuatu yang lain" },
    document: DOC, located: LOCATED });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "edit_changed");
});

test("the client cannot assert a binding over the wire", async () => {
  const body = await prepared();
  // Send the ORIGINAL digests alongside DIFFERENT material. The route hashes
  // the material, so the claim has no effect.
  const res = await post("/api/edit/execute", {
    token: body.token, edit: EDIT, document: DOC + " berubah", located: LOCATED,
    document_version: body.document_version,
    target_digest: body.target_digest, edit_digest: body.edit_digest });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, "document_changed");
});

test("result records the true status and refuses an unknown key", async () => {
  const token = (await prepared()).token;
  const executed = await post("/api/edit/execute",
                              { token, edit: EDIT, document: DOC, located: LOCATED });
  const reported = await post("/api/edit/result", {
    idempotency_key: executed.body.idempotency_key, status: "not_found" });
  assert.equal(reported.status, 200);
  assert.equal(reported.body.status, "not_found",
    "the pane's true outcome is recorded, not assumed to be 'applied'");

  const unknown = await post("/api/edit/result",
                             { idempotency_key: "never-issued", status: "applied" });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.reason, "unknown_key");
});

test("non-POST is 405 on every edit route", async () => {
  for (const route of ["/api/edit/prepare", "/api/edit/execute", "/api/edit/result"]) {
    const response = await fetch(`${origin}${route}`, { method: "GET" });
    assert.equal(response.status, 405, route);
  }
});

test("malformed JSON is 400, not a crash", async () => {
  const response = await fetch(`${origin}/api/edit/prepare`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: "{not json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
});

test("a disallowed Origin is refused before any decision is taken", async () => {
  const response = await fetch(`${origin}/api/edit/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ edits: [EDIT], document: DOC, located: LOCATED }) });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(!body.token, "a refused origin must not receive an approval");
});

test("responses are not cached", async () => {
  const response = await fetch(`${origin}/api/edit/prepare`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits: [EDIT], document: DOC, located: LOCATED }) });
  assert.equal(response.headers.get("cache-control"), "no-store",
    "an approval response must never be replayed from a cache");
});

test("diagnostics reports the boot id and a served-model identity", async () => {
  const response = await fetch(`${origin}/api/diagnostics`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.companionBootId, bootId);
  assert.match(body.companionBootId, /^[0-9a-f-]{36}$/);
  assert.ok("servedModel" in body, "a receipt needs an artifact identity to bind to");
  // Ollama is not running in a test, so the digest must be null WITH a reason
  // rather than absent or invented.
  assert.ok(body.servedModel.digest === null || typeof body.servedModel.digest === "string");
  if (body.servedModel.digest === null) assert.ok(body.servedModel.reason);
});

test("every audit row from this run carries digests and no content", async () => {
  const token = (await prepared()).token;
  await post("/api/edit/execute", { token, edit: EDIT, document: DOC, located: LOCATED });
  // Selected by TOKEN, not by position. Test files run in parallel and share
  // one audit log, so "the rows after the ones that were there before" is not
  // a stable set -- which made this assertion flaky rather than wrong.
  const rows = auditTail(500).filter((row) => row.token === token);
  assert.ok(rows.length >= 2, "prepare and execute must both be recorded");
  const serialized = JSON.stringify(rows);
  for (const secret of [DOC, EDIT.find, EDIT.replace]) {
    assert.ok(!serialized.includes(secret), `audit leaked over HTTP: ${secret}`);
  }
  assert.ok(rows.every((r) => r.boot_id === bootId),
    "each row names the process that wrote it");
});

test("an unwritable audit log refuses with 503 and mints nothing", async () => {
  // The route turns appendEditAudit's throw into a refusal. Simulated by making
  // the log path unwritable for the duration -- restored immediately after,
  // whatever happens.
  const existed = fs.existsSync(AUDIT);
  const saved = existed ? fs.readFileSync(AUDIT) : null;
  const mode = existed ? fs.statSync(AUDIT).mode : null;
  try {
    if (!existed) fs.writeFileSync(AUDIT, "");
    fs.chmodSync(AUDIT, 0o400);            // read-only: append will throw
    const res = await post("/api/edit/prepare",
                           { edits: [EDIT], document: DOC, located: LOCATED });
    assert.equal(res.status, 503);
    assert.equal(res.body.reason, "audit_unwritable");
    assert.ok(!res.body.token, "no approval may be issued that cannot be recorded");
  } finally {
    if (existed) {
      fs.chmodSync(AUDIT, mode);
      fs.writeFileSync(AUDIT, saved);
    } else {
      fs.rmSync(AUDIT, { force: true });
    }
  }
});
