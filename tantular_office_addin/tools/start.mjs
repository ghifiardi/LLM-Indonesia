// Start everything the pane needs, in one window, and keep it alive.
//
//   npm start
//
// Before this, running Tantular locally meant three terminals: `npm run dev`,
// `npm run doc-server`, and Ollama. Nothing supervised them. When one died —
// which happens, repeatedly — Office reported the same generic "can't load the
// add-in" message it shows for every other local failure, and the only way to
// find out which process had gone was to check each by hand.
//
// So: run the preflight, start what we own, restart it if it dies, and print
// what actually happened.
//
// Ollama is deliberately NOT started here. It is a user-installed application
// with its own lifecycle, often already running as a menu-bar app, and starting
// a second copy would fight with it. The preflight reports it instead.
import { spawn } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stamp = () => new Date().toTimeString().slice(0, 8);

function log(tag, line) {
  if (line.trim()) console.log(`${stamp()} [${tag}] ${line.trimEnd()}`);
}

// Restart on crash, but stop if it is crash-looping: a service that dies three
// times in a minute has a real problem, and restarting forever would bury the
// error under an endless scroll instead of showing it.
function supervise(tag, command, args, { optional = false } = {}) {
  const recent = [];
  const start = () => {
    const child = spawn(command, args, { cwd: root, env: process.env });
    child.stdout.on("data", (d) => String(d).split("\n").forEach((l) => log(tag, l)));
    child.stderr.on("data", (d) => String(d).split("\n").forEach((l) => log(tag, l)));
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      const now = Date.now();
      recent.push(now);
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      log(tag, `berhenti (code ${code ?? signal})`);
      if (recent.length >= 3) {
        log(tag, "berhenti 3x dalam semenit — tidak dijalankan ulang.");
        log(tag, optional
          ? "Fitur ini opsional; Tantular tetap berjalan tanpa ekstraksi PDF/gambar."
          : "Perbaiki error di atas, lalu jalankan `npm start` lagi.");
        if (!optional) shutdown(1);
        return;
      }
      log(tag, "menjalankan ulang dalam 2 detik...");
      setTimeout(start, 2000);
    });
    children.push(child);
    return child;
  };
  return start();
}

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${stamp()} menghentikan Tantular Companion...`);
  for (const child of children) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// --- preflight ---------------------------------------------------------------
// Runs first so a bad certificate or missing model is reported before two
// servers start and scroll it off the screen.
console.log("Memeriksa prasyarat...\n");
const doctor = spawn(process.execPath, [path.join(root, "tools", "doctor.mjs")],
                     { cwd: root, stdio: "inherit" });
doctor.on("exit", (code) => {
  if (code !== 0) {
    console.log("Prasyarat belum lengkap. Perbaiki hal di atas lalu jalankan `npm start` lagi.");
    console.log("(Companion yang belum jalan itu normal — akan dinyalakan sekarang.)\n");
  }
  launch();
});

// Already-running services are left alone. Starting a second copy just hits
// EADDRINUSE and looks like a failure, when the true state is "already fine" —
// so `npm start` is idempotent and safe to run twice.
function alive(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume(); resolve(true);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function launch() {
  const port = process.env.PORT || 3000;
  if (await alive(`https://localhost:${port}/manifest.xml`)) {
    log("companion", `sudah berjalan di port ${port} — dibiarkan apa adanya.`);
  } else {
    console.log(`${stamp()} menjalankan Companion...`);
    supervise("companion", process.execPath, [path.join(root, "tools", "dev-server.mjs")]);
  }

  const venv = path.join(root, ".venv-doc", "bin", "python");
  if (await alive("http://127.0.0.1:8787/health")) {
    log("doc", "sudah berjalan di port 8787 — dibiarkan apa adanya.");
  } else if (fs.existsSync(venv)) {
    supervise("doc", venv, [path.join(root, "tools", "document-extractor.py")],
              { optional: true });
  } else {
    log("doc", "dilewati — .venv-doc belum ada. Jalankan `npm run doc-setup` "
             + "bila perlu PDF/gambar.");
  }

  setTimeout(() => {
    console.log("");
    console.log("  Tantular Companion berjalan. Biarkan jendela ini terbuka.");
    console.log("  Hentikan dengan Ctrl+C.");
    console.log("");
  }, 1500);
}
