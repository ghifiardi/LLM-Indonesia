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
// Checked first: an expired or untrusted cert makes Office refuse the pane
// before any of the servers below are ever contacted, so a green companion
// would be misleading.
//
// Only ONE certificate can satisfy Office: ~/.office-addin-dev-certs/localhost.crt,
// issued by "Developer CA for Microsoft Office Add-ins", whose CA is installed
// into the login keychain by `npm run cert:office`.
//
// The repo's certs/localhost.crt is self-signed (issuer CN=localhost) and
// verifies as CSSMERR_TP_NOT_TRUSTED. It lets the dev-server bind HTTPS, which
// is why it exists, but Office will NOT load a pane served with it. It must
// never count as a passing state — doing so reports health while the pane is
// unloadable.
const OFFICE_CERT = path.join(home, ".office-addin-dev-certs", "localhost.crt");
const REPO_CERT = path.join(root, "certs", "localhost.crt");
const CERT_FIX = "npm run cert:office   (masukkan password Mac bila diminta, lalu jalankan ulang Companion)";

// Existence and expiry are not enough: a cert can be present and in date while
// its CA has been removed from the keychain, and Office would still refuse it.
function trustedBySystem(certPath) {
  if (process.platform !== "darwin") return null;   // unknown, not false
  try {
    execSync(`security verify-cert -c ${JSON.stringify(certPath)}`,
             { stdio: "pipe", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function checkCerts() {
  if (!fs.existsSync(OFFICE_CERT)) {
    const note = fs.existsSync(REPO_CERT)
      ? "hanya ada certs/localhost.crt (self-signed) — Office TIDAK menerimanya"
      : "tidak ditemukan";
    return record(false, "Sertifikat Office", note, CERT_FIX);
  }

  let validTo;
  try {
    validTo = new Date(new X509Certificate(fs.readFileSync(OFFICE_CERT)).validTo);
  } catch (error) {
    return record(false, "Sertifikat Office", `tidak terbaca: ${error.message}`, CERT_FIX);
  }
  const days = Math.round((validTo - Date.now()) / 86_400_000);
  const expiry = validTo.toISOString().slice(0, 10);

  if (days < 0) {
    return record(false, "Sertifikat Office", `KEDALUWARSA ${-days} hari lalu (${expiry})`,
                  CERT_FIX);
  }
  const trusted = trustedBySystem(OFFICE_CERT);
  if (trusted === false) {
    return record(false, "Sertifikat Office",
      `berlaku sampai ${expiry} TAPI tidak dipercaya sistem — CA hilang dari keychain`,
      CERT_FIX);
  }
  // Office blocks the pane the moment it expires, mid-workshop if need be.
  if (days < 14) {
    return record(false, "Sertifikat Office", `berakhir ${expiry} — tinggal ${days} hari`,
                  CERT_FIX);
  }
  record(true, "Sertifikat Office",
    `office-addin-dev-certs, berakhir ${expiry}${trusted ? ", dipercaya sistem" : ""}`);
}

// Reported separately and never as a pass: the repo cert is a dev-server
// binding convenience, not something Office accepts.
function checkRepoCert() {
  if (!fs.existsSync(REPO_CERT)) return;
  const trusted = trustedBySystem(REPO_CERT);
  console.log(`  [catatan] certs/localhost.crt ada (self-signed`
    + `${trusted === false ? ", TIDAK dipercaya sistem" : ""}). `
    + `Hanya agar dev-server bisa\n            membuka HTTPS — Office tidak akan memuat panel dengannya.`);
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
checkRepoCert();

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
