import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);

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

  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const filePath = path.join(root, safePath || "README.md");

  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
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
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify({
      ok: false,
      error: `Document extractor proxy gagal: ${error.message}. Jalankan: npm run doc-server`
    }));
  });

  req.pipe(proxyReq);
}

const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = hasCert
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handler)
  : http.createServer(handler);

// Listen on all local interfaces so both https://localhost (IPv6 ::1) and
// https://127.0.0.1 (IPv4) resolve. macOS often maps localhost to ::1.
server.listen(port, () => {
  const scheme = hasCert ? "https" : "http";
  console.log(`Tantular Office Add-in dev server: ${scheme}://localhost:${port}`);
  console.log(`Manifest: ${scheme}://localhost:${port}/manifest.xml`);
  if (!hasCert) {
    console.warn("No certs found. Run `npm run cert` because Office add-ins should be served over HTTPS.");
  }
});
