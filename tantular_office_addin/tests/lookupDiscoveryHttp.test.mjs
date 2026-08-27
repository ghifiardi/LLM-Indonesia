import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, method, pathname, body = null) {
  const payload = body == null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port, path: pathname, method,
      rejectUnauthorized: false,
      headers: payload ? { "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload) } : {}
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode, body: JSON.parse(text || "{}")
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("discovery alpha status and prepare bind provider without fetching", async (t) => {
  const port = await freePort();
  const child = spawn("node", ["tools/dev-server.mjs"], {
    env: {
      ...process.env, PORT: String(port),
      TANTULAR_LOOKUP_ENABLED: "true",
      TANTULAR_LOOKUP_DISCOVERY_ALPHA: "true",
      TANTULAR_SEARCH_PROVIDER: "duckduckgo-html"
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  t.after(() => child.kill("SIGTERM"));
  for (let i = 0; i < 60; i += 1) {
    try { await request(port, "GET", "/api/lookup/status"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  const status = await request(port, "GET", "/api/lookup/status");
  assert.equal(status.body.discovery.enabled, true);
  assert.equal(status.body.discovery.provider, "duckduckgo-html");

  const prepared = await request(port, "POST", "/api/lookup/prepare", {
    query: "perkembangan pasar modal indonesia",
    provider: "duckduckgo-html",
    document: "Vendor utama PT Sinar Mas."
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.ok, true);
  assert.equal(prepared.body.disclosure.provider, "duckduckgo-html");
  assert.match(prepared.body.disclosure.host, /DuckDuckGo/);
});
