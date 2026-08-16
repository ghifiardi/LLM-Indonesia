// One command that answers "why isn't the pane working?" before Office is opened.
//
// Office reports every local failure as the same thing: "Sorry, we can't load
// the add-in. Please make sure you have network and/or Internet connectivity."
// That message is identical whether the companion is down, the certificate
// expired, the manifest was never sideloaded, or Ollama is not running. So the
// pane cannot tell you what is wrong, and the user is left guessing.
//
// This checks each dependency in the order a startup actually needs them, and
// for anything broken prints the exact command that fixes it.
//
//   npm run doctor
//
// Exit code 0 = everything the pane needs is ready. Non-zero = something is not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { execSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = os.homedir();

const results = [];
function record(ok, name, detail, fix) {
  results.push({ ok, name, detail, fix });
}

function probe(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, reason: "timeout" }); });
    req.on("error", (error) => resolve({ ok: false, reason: error.code || error.message }));
  });
}

// --- 1. certificates ---------------------------------------------------------
// Checked first: an expired cert makes Office refuse the pane before any of the
// servers below are ever contacted, so a green companion would be misleading.
function checkCerts() {
  const officeCert = path.join(home, ".office-addin-dev-certs", "localhost.crt");
  const localCert = path.join(root, "certs", "localhost.crt");
  const which = fs.existsSync(officeCert) ? officeCert
    : fs.existsSync(localCert) ? localCert : null;
  if (!which) {
    return record(false, "Sertifikat HTTPS", "tidak ditemukan",
      "npm run cert:office   (dipercaya Office; masukkan password bila diminta)");
  }
  try {
    const validTo = new Date(new X509Certificate(fs.readFileSync(which)).validTo);
    const days = Math.round((validTo - Date.now()) / 86_400_000);
    const label = `${path.basename(path.dirname(which))} — berakhir ${validTo.toISOString().slice(0, 10)}`;
    if (days < 0) {
      return record(false, "Sertifikat HTTPS", `KEDALUWARSA ${-days} hari lalu`,
        "npm run cert:office");
    }
    // Office blocks the pane the moment it expires, mid-workshop if need be.
    if (days < 14) {
      return record(false, "Sertifikat HTTPS", `${label} (tinggal ${days} hari)`,
        "npm run cert:office   (perbarui sebelum kedaluwarsa)");
    }
    record(true, "Sertifikat HTTPS", label);
  } catch (error) {
    record(false, "Sertifikat HTTPS", `tidak terbaca: ${error.message}`, "npm run cert:office");
  }
}

// --- 2. companion ------------------------------------------------------------
async function checkCompanion() {
  const port = process.env.PORT || 3000;
  const result = await probe(`https://localhost:${port}/manifest.xml`);
  if (result.ok) {
    return record(true, "Companion (dev-server)", `port ${port} menjawab`);
  }
  record(false, "Companion (dev-server)", `port ${port} tidak menjawab (${result.reason})`,
    "npm run dev   — biarkan jendela ini terbuka selama memakai Tantular");
}

// --- 3. document extractor ---------------------------------------------------
async function checkDocServer() {
  const venv = path.join(root, ".venv-doc", "bin", "python");
  if (!fs.existsSync(venv)) {
    return record(false, "Document extractor", ".venv-doc belum dibuat",
      "npm run doc-setup   lalu   npm run doc-server");
  }
  const result = await probe("http://127.0.0.1:8787/health");
  if (result.ok) return record(true, "Document extractor", "port 8787 menjawab");
  record(false, "Document extractor", `port 8787 tidak menjawab (${result.reason})`,
    "npm run doc-server   — hanya diperlukan untuk PDF/gambar");
}

// --- 4. Ollama and models ----------------------------------------------------
async function checkOllama() {
  const result = await probe("http://127.0.0.1:11434/api/tags");
  if (!result.ok) {
    return record(false, "Ollama", `port 11434 tidak menjawab (${result.reason})`,
      "buka aplikasi Ollama, atau jalankan:  ollama serve");
  }
  record(true, "Ollama", "port 11434 menjawab");
  try {
    const installed = execSync("ollama list", { encoding: "utf8", timeout: 5000 });
    const need = ["tantular-office:0.4-9b", "tantular-office:lite"];
    const missing = need.filter((m) => !installed.includes(m));
    if (missing.length === need.length) {
      return record(false, "Model Tantular", `belum terpasang (${need.join(", ")})`,
        "npm run model:office   — mengunduh/membangun model Office");
    }
    record(true, "Model Tantular",
      need.filter((m) => installed.includes(m)).join(", ") || "model kustom terpasang");
  } catch {
    record(false, "Model Tantular", "tidak dapat menjalankan `ollama list`",
      "pastikan CLI ollama ada di PATH");
  }
}

// --- 5. sideloaded manifests -------------------------------------------------
// A perfectly healthy stack still shows nothing if Office never got the manifest.
function checkSideload() {
  const apps = { Word: "com.microsoft.Word", Excel: "com.microsoft.Excel",
                 PowerPoint: "com.microsoft.Powerpoint" };
  const found = Object.entries(apps).filter(([, bundle]) =>
    fs.existsSync(path.join(home, "Library", "Containers", bundle,
                            "Data", "Documents", "wef", "manifest.xml")));
  if (!found.length) {
    return record(false, "Manifest tersideload", "belum ada di Word/Excel/PowerPoint",
      "npm run sideload:word   (atau :excel / :powerpoint)");
  }
  record(true, "Manifest tersideload", found.map(([name]) => name).join(", "));
}

const heading = (text) => `\n${text}\n${"-".repeat(text.length)}`;

console.log(heading("Pemeriksaan Tantular Companion"));
checkCerts();
await checkCompanion();
await checkDocServer();
await checkOllama();
checkSideload();

for (const { ok, name, detail } of results) {
  console.log(`  [${ok ? " OK " : "GAGAL"}] ${name.padEnd(24)} ${detail}`);
}

const broken = results.filter((r) => !r.ok);
if (!broken.length) {
  console.log("\nSemua siap. Buka Word/Excel/PowerPoint dan panel Tantular.\n");
  process.exit(0);
}
console.log(heading(`${broken.length} hal perlu diperbaiki`));
for (const { name, fix } of broken) {
  console.log(`  ${name}:\n    ${fix}`);
}
// Not everything is fatal: PDF/image extraction is optional, and the pane runs
// without it. Only flag a non-zero exit when the pane genuinely cannot work.
const fatal = broken.filter((r) => r.name !== "Document extractor");
console.log("");
process.exit(fatal.length ? 1 : 0);
