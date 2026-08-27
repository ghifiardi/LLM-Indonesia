// One command that builds the workshop site in the ONLY order that works, then
// refuses to hand you a release that is missing files.
//
//   node tools/release-workshop.mjs --base-url https://office.tantular.ai
//   node tools/release-workshop.mjs --base-url https://office.tantular.ai --deploy
//
// The order is not interchangeable. build-workshop-web.mjs starts by wiping
// dist/workshop-web, INCLUDING downloads/. Run the package build first and the
// wipe deletes the zips you just made.
//
// That is exactly how https://office.tantular.ai/support came to serve a live
// page whose every download link returned 404: the web build ran, the package
// build did not follow, and the empty output was deployed. Nothing caught it,
// because downloads/ is gitignored on purpose — those artifacts exist only
// locally and reach the site through `vercel deploy`, so git had nothing to
// report and the site looked fine until someone clicked a button.
//
// So this script owns the order, and verifies the result before deploying.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEB_DIR = path.join(ROOT, "dist", "workshop-web");

// Every file the support page links to, plus the pages themselves. A release
// missing any of these is broken for a user even though the deploy "succeeded".
export const REQUIRED_PAGES = ["index.html", "support.html", "privacy.html"];
export const REQUIRED_DOWNLOADS = [
  "tantular-workshop.zip",
  "tantular-workshop-mac.zip",
  "tantular-workshop-manifest.xml",
  "setup.sh",
  "setup.ps1",
];

// Build inputs whose state the package build stamps into workshop-build.json.
// Kept in step with build-workshop-package.mjs.
export const BUILD_INPUTS = ["tools", "src", "models", "manifest.xml", "package.json"];

/**
 * Which required files are absent or empty.
 *
 * Zero-length counts as missing: a truncated zip is worse than an absent one,
 * because the download link works and the archive fails to open.
 */
export function missingReleaseFiles(webDir, statFile = defaultStat) {
  const missing = [];
  for (const name of REQUIRED_PAGES) {
    if (!statFile(path.join(webDir, name))) missing.push(name);
  }
  for (const name of REQUIRED_DOWNLOADS) {
    if (!statFile(path.join(webDir, "downloads", name))) missing.push(`downloads/${name}`);
  }
  return missing;
}

function defaultStat(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

/** Build inputs with uncommitted changes, so a release cannot be traced. */
export function dirtyBuildInputs(runner = defaultGit) {
  const out = runner(["status", "--porcelain", "--", ...BUILD_INPUTS]);
  return String(out || "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function defaultGit(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function run(command, args, label) {
  process.stdout.write(`\n> ${label}\n`);
  // Never pipe: a pipeline reports the LAST command's status, so a failed build
  // reads as success. That has bitten this repo more than once.
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nGagal: ${label} (exit ${result.status})`);
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const baseUrl = argv[argv.indexOf("--base-url") + 1];
  const allowDirty = argv.includes("--allow-dirty");
  const deploy = argv.includes("--deploy");

  if (!argv.includes("--base-url") || !baseUrl || baseUrl.startsWith("--")) {
    console.error("Wajib: --base-url https://office.tantular.ai");
    process.exit(1);
  }

  const dirty = dirtyBuildInputs();
  if (dirty.length && !allowDirty) {
    console.error("\nTree kotor — release tidak dapat ditelusuri ke satu commit.");
    console.error("Perubahan yang belum di-commit pada input build:\n");
    for (const line of dirty.slice(0, 20)) console.error(`  ${line}`);
    if (dirty.length > 20) console.error(`  ... dan ${dirty.length - 20} lainnya`);
    console.error("\nCommit/stash dulu, atau build dari worktree bersih:");
    console.error("  git worktree add --detach /tmp/rel <commit>");
    console.error("\n(--allow-dirty memaksa, tetapi artefak akan ditandai +dirty.)\n");
    process.exit(1);
  }

  // Order is the whole point: web first (it wipes), package second (it fills).
  run(process.execPath, [path.join(ROOT, "tools", "build-workshop-web.mjs"), "--base-url", baseUrl],
      "build web (wipes dist/workshop-web)");
  run(process.execPath, [path.join(ROOT, "tools", "build-workshop-package.mjs"), "--base-url", baseUrl],
      "build package (writes downloads/)");

  const missing = missingReleaseFiles(WEB_DIR);
  if (missing.length) {
    console.error("\nRelease TIDAK lengkap — deploy dibatalkan.");
    console.error("File berikut hilang atau kosong di dist/workshop-web:\n");
    for (const name of missing) console.error(`  ${name}`);
    console.error("\nIni gejala urutan build terbalik: build web menghapus downloads/,");
    console.error("jadi build package harus dijalankan SESUDAHNYA.\n");
    process.exit(1);
  }

  console.log("\nSmoke check OK — semua file rilis ada:");
  for (const name of [...REQUIRED_PAGES, ...REQUIRED_DOWNLOADS.map((n) => `downloads/${n}`)]) {
    console.log(`  ${name}`);
  }

  if (!deploy) {
    console.log("\nDeploy dengan:");
    console.log(`  cd ${WEB_DIR}`);
    console.log("  vercel deploy --prod --yes");
    console.log("\nLalu verifikasi terhadap URL live, bukan file lokal:");
    console.log(`  for p in /support /downloads/tantular-workshop.zip \\`);
    console.log("           /downloads/tantular-workshop-manifest.xml /downloads/setup.sh /downloads/setup.ps1; do");
    console.log(`    curl -s -o /dev/null -w "%{http_code} $p\\n" ${baseUrl}$p; done\n`);
    return;
  }

  run("vercel", ["deploy", "--prod", "--yes"], "vercel deploy --prod");
  console.log("\nDeploy selesai. Verifikasi URL live sebelum membagikan tautan.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
