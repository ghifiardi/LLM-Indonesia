// Verified fix: a Studio Cancel click aborts the browser's fetch(), but until
// now that only stopped the taskpane's own wait — tools/dev-server.mjs kept
// its independent http.request to Ollama running to completion, burning real
// compute for an answer nobody was listening for anymore.
//
// This spawns the REAL dev-server.mjs as a child process (same seam as
// `npm run dev`) against a deliberately-delayed fake Ollama upstream, so the
// actual proxy wiring is exercised end to end, not a re-implementation of it.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A deliberately delayed fake Ollama: it accepts the request and then NEVER
// responds — exactly the shape of a real model that's still mid-generation.
// Exposes when a request actually arrived (so the test can cancel only once
// dev-server has genuinely connected upstream, not before) and when that
// request's underlying socket was closed (proof the cancellation reached it).
function startFakeOllama() {
  let onRequest = null;
  let onClose = null;
  const requestReceived = new Promise((resolve) => { onRequest = resolve; });
  const closed = new Promise((resolve) => { onClose = resolve; });
  const server = http.createServer((req) => {
    req.resume(); // drain the body; deliberately never call res.end()
    req.socket.on("close", () => onClose());
    onRequest();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        requestReceived,
        waitForClose(timeoutMs) {
          return Promise.race([
            closed,
            new Promise((_, rej) => setTimeout(
              () => rej(new Error("fake Ollama's incoming connection was never closed")),
              timeoutMs
            ))
          ]);
        },
        stop: () => new Promise((resolveStop) => server.close(resolveStop))
      });
    });
  });
}

function startDevServer(ollamaPort) {
  return new Promise((resolve, reject) => {
    findFreePort().then((freePort) => {
      const child = spawn(process.execPath, [path.join(root, "tools", "dev-server.mjs")], {
        cwd: root,
        env: { ...process.env, PORT: String(freePort), TANTULAR_OLLAMA_PORT: String(ollamaPort) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`dev-server did not start in time. stdout=${stdout} stderr=${stderr}`));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/dev server: (https?):\/\/localhost:(\d+)/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ child, scheme: match[1], port: Number(match[2]) });
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`dev-server exited early with code ${code}. stdout=${stdout} stderr=${stderr}`));
        }
      });
    }, reject);
  });
}

test("client cancellation of /api/chat-completions closes the upstream Ollama connection", async () => {
  const fakeOllama = await startFakeOllama();
  const { child, scheme, port } = await startDevServer(fakeOllama.port);
  try {
    const mod = scheme === "https" ? https : http;
    const body = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
    const clientReq = mod.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/chat-completions",
        method: "POST",
        rejectUnauthorized: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
      },
      () => {} // no response ever arrives — the fake upstream never answers
    );
    // Destroying the client request mid-flight is expected to surface as a
    // socket error here; that is the point of the test, not a failure of it.
    clientReq.on("error", () => {});
    clientReq.end(body);

    // Wait until dev-server has genuinely connected to (fake) Ollama before
    // cancelling — cancelling too early would only prove readJsonBody never
    // ran, not that an in-flight upstream request gets torn down.
    await Promise.race([
      fakeOllama.requestReceived,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("dev-server never forwarded the request to the fake Ollama upstream")),
        5000
      ))
    ]);

    // Simulate the browser's fetch() being aborted (Cancel button / pane
    // closed): destroy the client's connection to dev-server.
    clientReq.destroy();

    // The real assertion: dev-server must propagate that all the way to its
    // own connection with Ollama, not let it run to completion unattended.
    await fakeOllama.waitForClose(5000);
  } finally {
    child.kill();
    await fakeOllama.stop();
  }
});

// 2026-08-31: a schema benchmark against a STALE dev-server process would
// silently exercise the old json_object-only bridge and "prove" nothing
// about Ollama's own schema enforcement. This spawns the REAL, current
// dev-server.mjs (not openAiToOllamaBody() in isolation) and inspects the
// exact JSON the fake Ollama upstream receives, so a bridge change that
// doesn't actually reach a freshly-started process would fail this test.
test("response_format.type=json_schema reaches Ollama's native /api/chat as a complete, unchanged schema object", async () => {
  let receivedNativeBody = null;
  const fakeOllama = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      receivedNativeBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: '{"t":"x","s":[]}' }, done: true }));
    });
  });
  await new Promise((resolve, reject) => {
    fakeOllama.on("error", reject);
    fakeOllama.listen(0, "127.0.0.1", resolve);
  });
  const ollamaPort = fakeOllama.address().port;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["t", "s"],
    properties: {
      t: { type: "string", minLength: 1 },
      s: {
        type: "array",
        minItems: 6,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["h", "p"],
          properties: {
            h: { type: "string", minLength: 1 },
            p: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1 } },
            b: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1 } }
          }
        }
      }
    }
  };

  const { child, scheme, port } = await startDevServer(ollamaPort);
  try {
    const mod = scheme === "https" ? https : http;
    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "tantular_document", strict: true, schema } }
    });
    const clientResponse = await new Promise((resolve, reject) => {
      const clientReq = mod.request(
        {
          hostname: "127.0.0.1", port, path: "/api/chat-completions", method: "POST",
          rejectUnauthorized: false,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }
      );
      clientReq.on("error", reject);
      clientReq.end(body);
    });

    assert.ok(receivedNativeBody, "the fake Ollama upstream must have received a request");
    assert.deepEqual(receivedNativeBody.format, schema,
      "native.format must be the complete schema object, not the string \"json\" and not a mangled copy");
    assert.equal(receivedNativeBody.format.properties.s.minItems, 6);
    assert.equal(receivedNativeBody.format.properties.s.maxItems, 6);
    assert.equal(receivedNativeBody.format.properties.s.items.properties.b.maxItems, 2);

    // The client-facing telemetry must reflect the SAME native.format the
    // Companion actually sent, not merely echo back what the client asked
    // for — this is the field that would have caught the stale-bridge gate.
    const payload = JSON.parse(clientResponse);
    assert.equal(payload.tantular_structured_mode, "schema");
  } finally {
    child.kill();
    await new Promise((resolveStop) => fakeOllama.close(resolveStop));
  }
});

test("a normal, completed request is unaffected by the disconnect-handling change", async () => {
  let receivedBody = null;
  const okOllama = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: { content: "halo" }, done: true }));
    });
  });
  await new Promise((resolve, reject) => {
    okOllama.on("error", reject);
    okOllama.listen(0, "127.0.0.1", resolve);
  });
  const ollamaPort = okOllama.address().port;

  const { child, scheme, port } = await startDevServer(ollamaPort);
  try {
    const mod = scheme === "https" ? https : http;
    const body = JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
    const response = await new Promise((resolve, reject) => {
      const clientReq = mod.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/chat-completions",
          method: "POST",
          rejectUnauthorized: false,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        }
      );
      clientReq.on("error", reject);
      clientReq.end(body);
    });

    assert.equal(response.status, 200);
    assert.ok(receivedBody, "the upstream must still receive the request body normally");
    const payload = JSON.parse(response.body);
    assert.ok(payload?.choices?.[0]?.message?.content, "a normal completed response must still reach the client");
  } finally {
    child.kill();
    await new Promise((resolveStop) => okOllama.close(resolveStop));
  }
});
