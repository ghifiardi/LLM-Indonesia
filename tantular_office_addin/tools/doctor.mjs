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

// Optional components never make the exit fatal: the pane loads, chats and
// edits documents without them. Only a genuine pane-load blocker — cert,
// companion, model, sideload — should stop `npm start`.
//
// Exported so the distinction is unit-tested rather than asserted: getting it
// backwards would either block startup over missing OCR, or let a dead
// companion report healthy.
export function isPaneBlocker(result) {
  return !String(result.name).includes("(opsional)");
}

// Read only the task-pane navigation URLs that Office can actually use. This
// deliberately ignores icon/support URLs: a missing icon is ugly, but a stale
// SourceLocation makes the whole pane look dead.
export function taskpaneUrlsFromManifest(xml) {
  const text = String(xml || "");
  const urls = [];
  const patterns = [
    /<SourceLocation\b[^>]*\bDefaultValue="([^"]+)"/gi,
    /<bt:Url\b[^>]*\bid="Taskpane\.Url\.[^"]+"[^>]*\bDefaultValue="([^"]+)"/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const decoded = match[1]
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'");
      if (!urls.includes(decoded)) urls.push(decoded);
    }
  }
  return urls;
}

// Pure inspection seam for unit tests. The most common deceptive state is a
// valid sideload file that still points at yesterday's temporary port. Office
// then says it cannot load the add-in, while the old doctor reported the
// manifest as healthy merely because the XML file existed.
export function inspectSideloadManifest(xml, { expectedPort = 3000 } = {}) {
  const urls = taskpaneUrlsFromManifest(xml);
  if (!urls.length) {
    return { ok: false, urls, detail: "tidak memiliki URL SourceLocation task pane" };
  }

  const invalid = [];
  const wrongPorts = [];
  for (const value of urls) {
    let url;
    try {
      url = new URL(value);
    } catch {
      invalid.push(value);
      continue;
    }
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (!isLocal) continue; // hosted production/workshop pane is legitimate
    const actualPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (actualPort !== Number(expectedPort)) {
      wrongPorts.push(`${url.hostname}:${actualPort}`);
    }
  }

  if (invalid.length) {
    return {
      ok: false,
      urls,
      detail: `URL task pane tidak valid: ${invalid.join(", ")}`
    };
  }
  if (wrongPorts.length) {
    return {
      ok: false,
      urls,
      detail: `menunjuk ke ${[...new Set(wrongPorts)].join(", ")}, `
        + `tetapi Companion memakai port ${expectedPort}`
    };
  }
  return { ok: true, urls, detail: urls.join(", ") };
}

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
    "npm start   — biarkan jendela ini terbuka selama memakai Tantular");
}

// --- 3. document extractor (OPTIONAL) ----------------------------------------
// Never a pane-load blocker. The pane opens, chats and edits documents without
// this; only PDF text extraction and image OCR depend on it. Reported so the
// distinction is visible rather than inferred from an exit code.
async function checkDocServer() {
  const venv = path.join(root, ".venv-doc", "bin", "python");
  if (!fs.existsSync(venv)) {
    return record(false, "Ekstraksi dokumen (opsional)",
      "belum disiapkan — panel tetap jalan, PDF/OCR tidak",
      "npm run doc-setup   lalu   npm run doc-server");
  }
  const result = await probe("http://127.0.0.1:8787/health");
  if (!result.ok) {
    return record(false, "Ekstraksi dokumen (opsional)",
      `port 8787 tidak menjawab (${result.reason}) — panel tetap jalan, PDF/OCR tidak`,
      "npm run doc-server");
  }
  record(true, "Ekstraksi dokumen (opsional)", "port 8787 menjawab");
  await checkOcr(venv);
}

// Installed is not importable. pyobjc can install cleanly and still fail to
// load — wrong architecture, partial wheel, framework mismatch — and the old
// setup ignored the install result entirely, so this could be broken on a
// machine that believed it was set up.
async function checkOcr(venv) {
  const { verifyOcrImports } = await import("./doc-setup.mjs");
  const result = verifyOcrImports(venv);
  if (result.ok) return record(true, "OCR gambar (opsional)", "Vision, Quartz, Foundation OK");
  record(false, "OCR gambar (opsional)",
    (result.missingModule ? `modul '${result.missingModule}' tidak dapat diimpor` : result.detail)
      + " — panel dan PDF tetap jalan",
    "npm run doc-setup   (bila gagal:  rm -rf .venv-doc && npm run doc-setup)");
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
  const found = [];
  for (const [app, bundle] of Object.entries(apps)) {
    for (const name of ["manifest.xml", "tantular-workshop-manifest.xml"]) {
      const manifestPath = path.join(home, "Library", "Containers", bundle,
        "Data", "Documents", "wef", name);
      if (fs.existsSync(manifestPath)) {
        found.push({ app, name, manifestPath });
        break;
      }
    }
  }
  if (!found.length) {
    const workshopInstaller = fs.existsSync(path.join(root, "install-tantular-workshop.command"))
      || fs.existsSync(path.join(root, "install-tantular-workshop.bat"));
    return record(false, "Manifest tersideload", "belum ada di Word/Excel/PowerPoint",
      workshopInstaller
        ? "jalankan ulang installer workshop, lalu pilih pemasangan manifest lokal"
        : "npm run sideload:word   (atau :excel / :powerpoint)");
  }

  const expectedPort = Number(process.env.PORT || 3000);
  const inspected = found.map(({ app, manifestPath }) => {
    try {
      return {
        app,
        ...inspectSideloadManifest(fs.readFileSync(manifestPath, "utf8"), { expectedPort })
      };
    } catch (error) {
      return { app, ok: false, detail: `tidak dapat dibaca: ${error.message}`, urls: [] };
    }
  });
  const broken = inspected.filter((item) => !item.ok);
  if (broken.length) {
    return record(false, "Manifest tersideload",
      broken.map((item) => `${item.app}: ${item.detail}`).join("; "),
      "jalankan npm run sideload:word / :excel / :powerpoint untuk host yang salah, "
        + "lalu npm start");
  }
  record(true, "Manifest tersideload",
    inspected.map((item) => `${item.app}: ${item.urls[0]}`).join("; "));
}

const heading = (text) => `\n${text}\n${"-".repeat(text.length)}`;

// Only run the checks when invoked directly. Without this, importing anything
// from this file — as the tests do for isPaneBlocker — executes the whole
// diagnostic and calls process.exit(), killing the importing process. That is
// how a test run silently dropped from 7 tests to 1.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Importers get the helpers above and nothing else.
} else {

// Printed before any diagnostic so it survives a screenshot of the first
// screen. Read from a file, never from git: an attendee machine has no repo.
// Absent in a repo checkout, which is itself the answer — "you are running the
// source, not a packaged build".
function printBuildRecord() {
  const recordPath = path.join(root, "workshop-build.json");
  if (!fs.existsSync(recordPath)) {
    console.log("Paket workshop : (tidak ada — menjalankan dari repo sumber)");
    return;
  }
  try {
    const build = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    console.log(`Paket workshop : ${build.buildId}`);
    console.log(`  dibangun     : ${String(build.builtAt).slice(0, 16).replace("T", " ")} UTC`);
    if (build.sourceDirty) {
      console.log("  CATATAN      : dibangun dari sumber yang belum di-commit");
    }
  } catch {
    console.log("Paket workshop : workshop-build.json tidak terbaca");
  }
}

printBuildRecord();
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
const fatal = broken.filter(isPaneBlocker);
console.log("");
process.exit(fatal.length ? 1 : 0);

}
