// Set up the document extractor venv, and FAIL if OCR support did not install.
//
//   npm run doc-setup
//
// The previous one-liner ran `subprocess.run([... 'pip', 'install', pyobjc ...])`
// without check=True, so a failed pyobjc install exited 0 and printed nothing.
// The venv looked ready; OCR then failed much later, at the moment a user
// dropped an image into the pane, with no trace back to setup.
//
// Installing is also not the same as importing. pyobjc can install cleanly and
// still fail to import — wrong architecture for the interpreter, a partial
// wheel, a macOS/framework version mismatch. So this verifies the exact three
// imports document-extractor.py performs:
//
//     import Vision
//     import Quartz
//     from Foundation import NSData
//
// If those do not work, OCR does not work, whatever pip reported.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VENV_DIR = path.join(ROOT, ".venv-doc");
export const VENV_PYTHON = path.join(VENV_DIR, "bin", "python");

// Kept in step with the guarded import block in tools/document-extractor.py.
// A package list would not catch an installed-but-unimportable module, which is
// the failure this exists to find.
export const OCR_IMPORT_PROBE =
  "import Vision, Quartz\nfrom Foundation import NSData\nprint('OCR_IMPORTS_OK')";
export const OCR_PACKAGES = ["pyobjc-framework-Vision", "pyobjc-framework-Quartz"];
export const RETRY_COMMAND = "rm -rf .venv-doc && npm run doc-setup";

// Split out so tests can drive it with a stub interpreter instead of building a
// real venv: `runner` is the only thing that touches the outside world.
export function verifyOcrImports(pythonPath, runner = defaultRunner) {
  const result = runner(pythonPath, ["-c", OCR_IMPORT_PROBE]);
  if (result.status === 0 && String(result.stdout).includes("OCR_IMPORTS_OK")) {
    return { ok: true };
  }
  const stderr = String(result.stderr || "").trim();
  // Name the module that actually failed — "pyobjc failed" sends someone
  // reinstalling the wrong package.
  const match = stderr.match(/No module named '([^']+)'/);
  return {
    ok: false,
    missingModule: match ? match[1] : null,
    detail: stderr.split("\n").filter(Boolean).slice(-1)[0] || "import gagal tanpa pesan",
  };
}

function defaultRunner(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
}

export function describeOcrFailure({ missingModule, detail }) {
  const lines = [
    "",
    "========================================================================",
    "OCR (Apple Vision) TIDAK TERPASANG DENGAN BENAR.",
    "",
    missingModule
      ? `Modul '${missingModule}' tidak dapat diimpor oleh Python di .venv-doc.`
      : "Impor Vision/Quartz/Foundation gagal.",
    `Rincian: ${detail}`,
    "",
    "Ekstraksi teks PDF tetap berfungsi. Yang tidak berfungsi hanya OCR gambar",
    "(mis. menarik screenshot ke panel).",
    "",
    `Coba ulang dengan:  ${RETRY_COMMAND}`,
    "========================================================================",
    "",
  ];
  return lines.join("\n");
}

function run(command, args, label) {
  process.stdout.write(`\n> ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nGagal: ${label}`);
    console.error(`Coba ulang dengan:  ${RETRY_COMMAND}\n`);
    process.exit(1);
  }
}

function main() {
  const isMac = process.platform === "darwin";

  if (!fs.existsSync(VENV_PYTHON)) {
    run("python3", ["-m", "venv", VENV_DIR], "membuat .venv-doc");
  } else {
    console.log("> .venv-doc sudah ada");
  }

  run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"],
      "memperbarui pip");
  run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "pypdf"], "memasang pypdf");

  // pypdf is required for PDF text, so an unimportable pypdf IS fatal.
  const pdf = spawnSync(VENV_PYTHON, ["-c", "import pypdf; print(pypdf.__version__)"],
                        { encoding: "utf8" });
  if (pdf.status !== 0) {
    console.error("\npypdf terpasang tetapi tidak dapat diimpor.");
    console.error(String(pdf.stderr).trim());
    console.error(`\nCoba ulang dengan:  ${RETRY_COMMAND}\n`);
    process.exit(1);
  }
  console.log(`  pypdf ${String(pdf.stdout).trim()} siap`);

  if (!isMac) {
    console.log("\nApple Vision OCR hanya tersedia di macOS — dilewati.");
    console.log("Ekstraksi teks PDF tetap berfungsi.\n");
    return;
  }

  run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", ...OCR_PACKAGES],
      `memasang ${OCR_PACKAGES.join(", ")}`);

  // The check the old one-liner never made.
  const verified = verifyOcrImports(VENV_PYTHON);
  if (!verified.ok) {
    console.error(describeOcrFailure(verified));
    process.exit(1);
  }
  console.log("  Apple Vision OCR siap (Vision, Quartz, Foundation terverifikasi)");
  console.log("\nSelesai. Jalankan Companion dengan:  npm start\n");
}

// Only run when invoked directly, so tests can import the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
