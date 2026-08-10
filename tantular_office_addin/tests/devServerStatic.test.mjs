import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import https from "node:https";
import http from "node:http";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// dev-server.mjs logs the port it was *asked* to bind, not the OS-assigned
// port, so PORT=0 can't be used here — find a free port ourselves first.
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

// Spawns the real dev server as a child process (same seam as running
// `npm run dev`) and drives it over the network, so we exercise the actual
// static-file handler wiring rather than a re-implementation of it.
async function startServer() {
  const freePort = await findFreePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tools", "dev-server.mjs")], {
      cwd: root,
      env: { ...process.env, PORT: String(freePort) },
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
  });
}

function get(scheme, port, pathname) {
  return new Promise((resolve, reject) => {
    const mod = scheme === "https" ? https : http;
    const req = mod.get(
      { hostname: "127.0.0.1", port, path: pathname, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
  });
}

test("static handler: blocks data/ and certs/ but still serves normal assets and /api/workspace", async () => {
  const { child, scheme, port } = await startServer();
  try {
    const workspaceJson = await get(scheme, port, "/data/workspace.json");
    assert.equal(workspaceJson.status, 404);

    const key = await get(scheme, port, "/certs/localhost.key");
    assert.equal(key.status, 404);

    // Path-traversal-flavored attempts at the same guarded prefixes are
    // also blocked (normalize() collapses these before the check runs).
    const traversalData = await get(scheme, port, "/./data/workspace.json");
    assert.equal(traversalData.status, 404);

    const normalAsset = await get(scheme, port, "/src/taskpane.html");
    assert.equal(normalAsset.status, 200);
    assert.equal(normalAsset.headers["access-control-allow-origin"], "*");

    // Case variants must also be blocked: on case-insensitive filesystems
    // (APFS, NTFS), fs.readFile resolves "/DATA/..." to the same file as
    // "/data/...", so the guard must not be a case-sensitive string compare.
    const upperData = await get(scheme, port, "/DATA/workspace.json");
    assert.equal(upperData.status, 404);

    const upperCerts = await get(scheme, port, "/Certs/localhost.key");
    assert.equal(upperCerts.status, 404);

    const mixedData = await get(scheme, port, "/dAtA/workspace.json");
    assert.equal(mixedData.status, 404);

    // /api/workspace behavior (origin allowlist) is unaffected by this change.
    const apiNoOrigin = await get(scheme, port, "/api/workspace");
    assert.equal(apiNoOrigin.status, 200);
  } finally {
    child.kill();
  }
});
