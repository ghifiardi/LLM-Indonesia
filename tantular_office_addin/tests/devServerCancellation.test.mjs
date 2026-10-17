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

// Promise.race leaves the LOSING promise running. When the loser is a
// setTimeout guard, its timer stays armed and ref'd, so the process cannot
// exit until it fires -- these tests measured ~5s of dead time after the
// assertions had already passed. Clear the guard when the race settles, so the
// timer's lifecycle is explicit and the work is removed rather than merely
// ignored. (timer.unref() would also drop the tail, but it leaves an armed
// timer that can still fire, which is harder to reason about later.)
function withDeadline(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// server.close() invokes its callback only once EVERY existing connection has
// closed, and it does not close them itself. A fixture that only calls close()
// therefore waits forever on a connection the test is deliberately holding
// open. Today that is masked by ordering -- the dev-server child is killed
// first, which drops the upstream socket -- so the unbounded wait is latent
// rather than live. Track the connections, destroy them, and put a deadline on
// the whole thing so the fixture cannot outlive the test that owns it.
function trackConnections(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return (timeoutMs = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`test server did not close within ${timeoutMs}ms`)),
      timeoutMs);
    server.close(() => { clearTimeout(timer); resolve(); });
    for (const socket of sockets) socket.destroy();
  });
}

// child.kill() only sends the signal; it does not wait. Waiting on a deadline
// keeps a wedged dev-server from silently becoming the next test's problem.
// No escalation beyond SIGTERM: a silent SIGKILL would hide exactly the state
// worth reporting.
function stopChild(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(
        `dev-server (pid ${child.pid}) did not exit within ${timeoutMs}ms of SIGTERM`)),
      timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

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
  const closeServer = trackConnections(server);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        requestReceived,
        waitForClose(timeoutMs) {
          return withDeadline(
            closed, timeoutMs,
            "fake Ollama's incoming connection was never closed");
        },
        stop: (timeoutMs = 5000) => closeServer(timeoutMs)
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
    await withDeadline(
      fakeOllama.requestReceived, 5000,
      "dev-server never forwarded the request to the fake Ollama upstream");

    // Simulate the browser's fetch() being aborted (Cancel button / pane
    // closed): destroy the client's connection to dev-server.
    clientReq.destroy();

    // The real assertion: dev-server must propagate that all the way to its
    // own connection with Ollama, not let it run to completion unattended.
    await fakeOllama.waitForClose(5000);
  } finally {
    await stopChild(child);
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
  const closeFakeOllama = trackConnections(fakeOllama);
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
    await stopChild(child);
    await closeFakeOllama();
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
  const closeOkOllama = trackConnections(okOllama);
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
    await stopChild(child);
    await closeOkOllama();
  }
});


// The bug the bounded close exists to prevent, made reachable on purpose.
// Without the socket-destroy loop this test times out: server.close() waits on
// the held connection forever, and no assertion in this file would notice,
// because the other three tests drop their upstream socket when the child dies.
test("a fixture server closes within its deadline even with a connection held open", async () => {
  const server = http.createServer((req) => { req.resume(); }); // never responds
  const closeServer = trackConnections(server);
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  const held = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    held.once("connect", resolve);
    held.once("error", reject);
  });
  held.on("error", () => {});                 // destroyed under us, by design
  held.write("POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50)); // let it be accepted

  const started = Date.now();
  try {
    await closeServer(2000);                  // must resolve, not reject
  } finally {
    // Release the held socket even when the assertion above fails. A test that
    // hangs on its own failure is the exact pathology this file now guards
    // against, and it would leave the server open for the rest of the run.
    held.destroy();
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000,
    `close must not wait out its deadline (took ${elapsed}ms)`);
});
