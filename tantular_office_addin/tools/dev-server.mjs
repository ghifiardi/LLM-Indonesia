import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceStore, handleWorkspaceRequest } from "./workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set([
  "https://localhost:3000",
  "https://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...String(process.env.TANTULAR_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
]);

// Prefer Microsoft's office-addin-dev-certs (system-trusted CA) when available,
// because PowerPoint desktop on macOS validates against the system trust chain.
// Fall back to the local self-signed certs in ./certs.
const home = process.env.HOME || "";
const officeCertDir = home ? path.join(home, ".office-addin-dev-certs") : "";
const officeCert = officeCertDir ? path.join(officeCertDir, "localhost.crt") : "";
const officeKey = officeCertDir ? path.join(officeCertDir, "localhost.key") : "";

const localCert = path.join(root, "certs", "localhost.crt");
const localKey = path.join(root, "certs", "localhost.key");

let certPath = localCert;
let keyPath = localKey;
if (officeCert && officeKey && fs.existsSync(officeCert) && fs.existsSync(officeKey)) {
  certPath = officeCert;
  keyPath = officeKey;
}

// Dev certs expire after ~30 days and Office then blocks the pane with a
// cryptic "isn't signed by a valid security certificate" error. Fail fast
// here, in the terminal the user is actually looking at, with the fix.
try {
  const { X509Certificate } = await import("node:crypto");
  const cert = new X509Certificate(fs.readFileSync(certPath));
  const validTo = new Date(cert.validTo);
  const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
  if (daysLeft < 0) {
    console.error("");
    console.error("========================================================================");
    console.error(`SERTIFIKAT HTTPS KEDALUWARSA (berakhir ${validTo.toISOString().slice(0, 10)}).`);
    console.error("Office akan memblokir panel Tantular dengan error \"valid security certificate\".");
    console.error("");
    console.error("Perbaiki dengan menjalankan:  npm run cert:office");
    console.error("(masukkan password Mac/Windows bila diminta), lalu jalankan ulang Companion.");
    console.error("========================================================================");
    if (process.env.TANTULAR_IGNORE_CERT_EXPIRY !== "1") process.exit(1);
  } else if (daysLeft <= 5) {
    console.warn(`PERINGATAN: sertifikat HTTPS akan kedaluwarsa dalam ${daysLeft} hari (${validTo.toISOString().slice(0, 10)}).`);
    console.warn("Jalankan 'npm run cert:office' sebelum tanggal itu agar panel Tantular tidak terblokir.");
  }
} catch (error) {
  // Never let the expiry check itself stop the server (e.g. exotic cert
  // formats); Office will still do its own validation.
  console.warn("Pemeriksaan kedaluwarsa sertifikat dilewati:", error?.message || error);
}

const workspaceStore = createWorkspaceStore({ filePath: path.join(root, "data", "workspace.json") });

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

function handler(req, res) {
  const url = new URL(req.url || "/", "https://localhost");

  if (url.pathname === "/api/document-extract") {
    proxyDocumentExtract(req, res);
    return;
  }

  if (url.pathname === "/api/ocr") {
    proxyOcr(req, res);
    return;
  }

  if (url.pathname === "/api/chat-completions") {
    proxyChatCompletions(req, res);
    return;
  }

  if (url.pathname === "/api/models") {
    proxyOllamaModels(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/workspace")) {
    if (!allowApiOrigin(req, res)) return;
    handleWorkspaceRequest(workspaceStore, req, res, url);
    return;
  }

  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const filePath = path.join(root, safePath || "README.md");

  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  // The workspace store (data/workspace.json) and TLS private key material
  // (certs/) must never be reachable via the static file handler, which
  // serves Access-Control-Allow-Origin: * to any web page. Return 404 (not
  // 403) so we don't confirm these paths exist.
  const relativePath = path.relative(root, filePath);
  const relativeSegments = relativePath.split(path.sep);
  // Case-insensitive compare: APFS/NTFS resolve "/DATA/x" to the same file as
  // "/data/x", so a case-sensitive check here is bypassable on those file
  // systems. This over-blocks on case-sensitive Linux filesystems, which is
  // acceptable and safer than under-blocking.
  const firstSegment = relativeSegments[0]?.toLowerCase();
  if (firstSegment === "data" || firstSegment === "certs") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const type = mime.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(data);
  });
}

function proxyDocumentExtract(req, res) {
  if (!allowApiOrigin(req, res)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true"
    });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: 8787,
      path: "/extract",
      method: "POST",
      headers: {
        "Content-Type": req.headers["content-type"] || "application/octet-stream",
        "Content-Length": req.headers["content-length"] || undefined
      }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
        ...corsHeaders(req),
        "Cache-Control": "no-store"
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({
      ok: false,
      error: `Document extractor proxy gagal: ${error.message}. Jalankan: npm run doc-server`
    }));
  });

  req.pipe(proxyReq);
}

function proxyOcr(req, res) {
  if (!allowApiOrigin(req, res)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true"
    });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const requestHeaders = { "Content-Type": req.headers["content-type"] || "application/octet-stream" };
  if (req.method === "POST") {
    requestHeaders["Content-Length"] = req.headers["content-length"] || undefined;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: 8787,
      path: "/api/ocr",
      method: req.method,
      headers: requestHeaders
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
        ...corsHeaders(req),
        "Cache-Control": "no-store"
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({
      ok: false,
      error: `OCR proxy gagal: ${error.message}. Jalankan: npm run doc-setup lalu npm run doc-server`
    }));
  });

  if (req.method === "POST") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function proxyChatCompletions(req, res) {
  if (!allowApiOrigin(req, res)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true"
    });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: 11434,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "Content-Length": req.headers["content-length"] || undefined
      }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
        ...corsHeaders(req),
        "Cache-Control": "no-store"
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({
      ok: false,
      error: `Model proxy gagal: ${error.message}. Pastikan Ollama berjalan dan model Tantular tersedia.`
    }));
  });

  req.pipe(proxyReq);
}

function proxyOllamaModels(req, res) {
  if (!allowApiOrigin(req, res)) return;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true"
    });
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: 11434,
      path: "/api/tags",
      method: "GET"
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
        ...corsHeaders(req),
        "Cache-Control": "no-store"
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req)
    });
    res.end(JSON.stringify({
      ok: false,
      error: `Daftar model Ollama gagal: ${error.message}. Pastikan Ollama berjalan.`
    }));
  });

  proxyReq.end();
}

function normalizedOrigin(req) {
  return String(req.headers.origin || "").trim().replace(/\/+$/, "");
}

function corsHeaders(req) {
  const origin = normalizedOrigin(req);
  return {
    "Access-Control-Allow-Origin": origin || "https://localhost:3000",
    "Vary": "Origin"
  };
}

function allowApiOrigin(req, res) {
  const origin = normalizedOrigin(req);
  // Non-browser local clients (curl/health checks) commonly omit Origin.
  if (!origin || allowedOrigins.has(origin)) return true;
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  });
  res.end(JSON.stringify({ ok: false, error: "Origin tidak diizinkan oleh Tantular Companion." }));
  return false;
}

const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = hasCert
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handler)
  : http.createServer(handler);

// Running `npm run dev` twice is the most common mistake there is, and Node's
// default is an unhandled 'error' event: a raw EADDRINUSE stack trace. Someone
// at a workshop cannot read that as "it is already running", so they kill the
// working server and try again. Say what happened instead.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error("");
    console.error("========================================================================");
    console.error(`PORT ${port} SUDAH DIPAKAI.`);
    console.error("");
    console.error("Kemungkinan besar Tantular Companion SUDAH BERJALAN di jendela lain —");
    console.error("dalam hal itu tidak perlu melakukan apa pun.");
    console.error("");
    console.error("Periksa dengan:   lsof -nP -iTCP:" + port + " -sTCP:LISTEN");
    console.error("Hentikan dengan:  kill $(lsof -t -iTCP:" + port + " -sTCP:LISTEN)");
    console.error("Atau pakai port lain:  PORT=3001 npm run dev");
    console.error("========================================================================");
    console.error("");
    process.exit(1);
  }
  if (error.code === "EACCES") {
    console.error(`\nTidak punya izin membuka port ${port}. Coba PORT=3001 npm run dev\n`);
    process.exit(1);
  }
  throw error;
});

// Listen on all local interfaces so both https://localhost (IPv6 ::1) and
// https://127.0.0.1 (IPv4) resolve. macOS often maps localhost to ::1.
server.listen(port, () => {
  const scheme = hasCert ? "https" : "http";
  // This file runs in two very different roots. In the repo, `root` holds src/
  // and manifest.xml and this really is a dev server. In the workshop package it
  // holds neither: the task pane is served from the hosted URL and the only job
  // here is proxying /api/* to the local companion. Printing a manifest link
  // there advertised a 404 and made a working install look broken, so say what
  // this process is actually doing instead of assuming the repo layout.
  const servesPane = fs.existsSync(path.join(root, "src", "taskpane.html"));
  const manifestName = ["manifest.xml", "tantular-workshop-manifest.xml"]
    .find((name) => fs.existsSync(path.join(root, name)));

  if (servesPane) {
    console.log(`Tantular Office Add-in dev server: ${scheme}://localhost:${port}`);
    if (manifestName) console.log(`Manifest: ${scheme}://localhost:${port}/${manifestName}`);
  } else {
    console.log(`Tantular Companion bridge aktif: ${scheme}://localhost:${port}`);
    console.log("Task pane dimuat dari web; proses ini hanya menyambungkan pane ke Companion lokal.");
    console.log("Biarkan jendela ini terbuka selama memakai Tantular di Office.");
  }
  if (!hasCert) {
    console.warn("No certs found. Run `npm run cert` because Office add-ins should be served over HTTPS.");
  }
});
