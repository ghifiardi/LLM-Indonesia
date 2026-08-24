// One real remote host, through the whole path.
//
//   TANTULAR_E2E_NETWORK=1 node --test tests/lookupRemoteHost.test.mjs
//
// Everything else is measured against a local origin we control, which means
// every claim so far rests on a page shaped the way we imagined. This talks to
// id.wikipedia.org — the only allow-listed host — and checks that the real
// response survives the adapter, the fetch, the model and the verifier.
//
// OPT-IN. It sends a query out of the machine. A network test that runs by
// default turns "no egress unless approved" into a slogan, and it would also
// make CI depend on Wikimedia being up. The query is generic and carries no
// document content; the document stays local and is only ever hashed.

import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const enabled = process.env.TANTULAR_E2E_NETWORK === "1";
const skip = enabled ? false
  : "set TANTULAR_E2E_NETWORK=1 to allow a real outbound request";

const DOCUMENT = `LAPORAN ANGGARAN TRIWULAN II 2026

Pagu belanja modal Rp 1.750.000.000.
Vendor utama PT Sinar Mas, kontrak ditandatangani 11 Februari 2026.
Realisasi sampai 30 Juni 2026 Rp 412.300.000 atau 23,6 persen.`;

function post(port, pathname, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port, path: pathname, method: "POST",
      rejectUnauthorized: false,           // self-signed localhost dev cert
      headers: { "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || "{}") }); }
        catch { reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

test("a real Wikipedia lookup produces a verified or blocked verdict, never raw text",
  { skip, timeout: 600_000 }, async (t) => {
  const port = await freePort();
  const server = spawn("node", ["tools/dev-server.mjs"], {
    env: { ...process.env, PORT: String(port), TANTULAR_LOOKUP_ENABLED: "true",
           TANTULAR_LOOKUP_HOSTS: "id.wikipedia.org" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  t.after(() => server.kill("SIGTERM"));
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`companion exited (${server.exitCode})`);
    try { await post(port, "/api/lookup/prepare", {}); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  const query = "anggaran belanja modal";
  const prepared = await post(port, "/api/lookup/prepare",
    { query, host: "id.wikipedia.org", document: DOCUMENT });
  assert.equal(prepared.body.ok, true, JSON.stringify(prepared.body));
  // The user must be shown exactly what leaves, before it leaves.
  assert.equal(prepared.body.disclosure.query, query);
  assert.equal(prepared.body.disclosure.host, "id.wikipedia.org");

  const executed = await post(port, "/api/lookup/execute",
    { token: prepared.body.token, query, host: "id.wikipedia.org", document: DOCUMENT });

  const b = executed.body;
  if (b.reason === "upstream_status" || b.reason === "model_error") {
    // Wikimedia rate limits, and the local model may not be installed. Neither
    // is a pass and neither is a product defect, so say so rather than
    // asserting on a run that never happened.
    t.diagnostic(`remote run did not complete: ${b.reason} ${b.status || ""}`);
    return;
  }

  t.diagnostic(`remote verdict: ${b.status}${b.reason ? " (" + b.reason + ")" : ""}`);
  assert.ok(b.status === "verified" || b.status === "blocked_by_verifier",
    `unexpected status ${JSON.stringify(b.status)}`);

  if (b.status === "verified") {
    assert.equal(b.canEdit, true);
    assert.ok(String(b.answer || "").trim());
    // The whole point: a verified answer still preserves the document.
    assert.ok(b.answer.includes("PT Sinar Mas"),
      "a verified answer must preserve the document's vendor");
    assert.ok(Array.isArray(b.protected) && b.protected.length);
  } else {
    assert.equal(b.answer, undefined, "a blocked answer must not be returned");
    assert.equal(b.canEdit, undefined);
  }

  // Under no verdict does the raw fetched page reach the pane.
  assert.equal(b.content, undefined, "the fetched page must never be returned");
  assert.equal(b.untrusted, undefined);
});
