// The companion door, over real HTTP, with the flag off.
//
// lookupPolicy.test.mjs proves prepareLookup() refuses when disabled. That is
// the function, not the door: an endpoint could call fetch before consulting
// it, or consult it and ignore the answer. This drives the actual server.

import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

function post(port, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port, path: pathname, method: "POST",
      rejectUnauthorized: false,      // self-signed localhost dev certificate
      headers: { "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode,
                                    body: JSON.parse(data || "{}") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// Ask the OS for a free port rather than guessing one: a fixed port makes the
// test fail whenever a dev server is already running, and a guessed one makes
// concurrent test files collide.
async function freePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startCompanion(env) {
  const port = await freePort();
  const server = spawn("node", ["tools/dev-server.mjs"],
    { env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`companion exited (${server.exitCode})`);
    try { await post(port, "/api/lookup/prepare", {}); return { port, server }; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  server.kill("SIGKILL");
  throw new Error("companion did not start within 15s");
}

test("with the flag off, the endpoint refuses and issues no token", async (t) => {
  // A hostile origin that records whether it was ever contacted. The strongest
  // statement is not "the response said no" but "nothing was requested".
  let contacted = false;
  const remote = http.createServer((req, res) => { contacted = true; res.end("{}"); });
  t.after(() => remote.close());
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const remoteHost = `127.0.0.1:${remote.address().port}`;

  let started;
  t.after(() => started?.server.kill("SIGKILL"));
  started = await startCompanion({
    TANTULAR_LOOKUP_ENABLED: "false",
    TANTULAR_LOOKUP_HOSTS: remoteHost,
    TANTULAR_LOOKUP_TEST_ORIGIN: `http://${remoteHost}`
  });
  const { port } = started;

  const prepared = await post(port, "/api/lookup/prepare",
    { query: "anggaran", host: remoteHost });
  assert.equal(prepared.status, 403);
  assert.equal(prepared.body.ok, false);
  assert.equal(prepared.body.reason, "disabled");
  assert.equal(prepared.body.token, undefined, "no token may exist when disabled");

  // And execute must not be reachable by inventing a token.
  const executed = await post(port, "/api/lookup/execute",
    { token: "made-up", query: "anggaran", host: remoteHost, document: "Vendor PT Sinar Mas." });
  assert.equal(executed.status, 403);
  assert.equal(executed.body.ok, false);

  // Refine belongs to the same feature: with the flag off it must refuse,
  // not quietly run a model against the document.
  const refined = await post(port, "/api/lookup/refine",
    { intent: "anggaran", document: "Vendor PT Sinar Mas." });
  assert.equal(refined.status, 403);
  assert.equal(refined.body.reason, "disabled");

  assert.equal(contacted, false, "the flag is off; nothing may leave the machine");
});

test("an unlisted host is refused even with the flag on", async (t) => {
  let started;
  t.after(() => started?.server.kill("SIGKILL"));
  started = await startCompanion({
    TANTULAR_LOOKUP_ENABLED: "true",
    TANTULAR_LOOKUP_HOSTS: "id.wikipedia.org"
  });
  const { port } = started;

  const prepared = await post(port, "/api/lookup/prepare",
    { query: "anggaran", host: "evil-wikipedia.org" });
  assert.equal(prepared.status, 403);
  assert.equal(prepared.body.token, undefined);
});
