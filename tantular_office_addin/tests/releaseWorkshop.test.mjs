// 2026-08-31 regression: `npm run release:workshop -- --deploy` reported
// success and printed a live-looking production URL, but https://office.tantular.ai
// never changed — the deploy went to a brand-new, unrelated Vercel project
// instead of the pre-linked "workshop-web" project the domain is actually
// bound to. Cause: run()'s `vercel deploy` call used cwd:ROOT (the repo
// root, which has no `.vercel/project.json` link of its own) instead of
// cwd:WEB_DIR (dist/workshop-web, where the real project link lives).
// Vercel CLI silently auto-creates a new project when it finds no link
// rather than failing loudly, so nothing about the deploy's own output
// exposed the mistake.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, ROOT, WEB_DIR } from "../tools/release-workshop.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptSource = fs.readFileSync(path.join(root, "tools/release-workshop.mjs"), "utf8");

test("run() spawns in the given cwd, not always ROOT", () => {
  const calls = [];
  const fakeSpawner = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return { status: 0 };
  };
  run("echo", ["hi"], "test label", WEB_DIR, fakeSpawner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, WEB_DIR);
});

test("run() still defaults to ROOT when no cwd is given (build steps, which have no per-directory project link concern)", () => {
  const calls = [];
  const fakeSpawner = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return { status: 0 };
  };
  run("echo", ["hi"], "test label", undefined, fakeSpawner);
  assert.equal(calls[0].cwd, ROOT);
});

test("run() exits nonzero on a failed spawn instead of silently reporting success", () => {
  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode = null;
  let errorLines = [];
  process.exit = (code) => { exitCode = code; throw new Error("exit called"); };
  console.error = (line) => { errorLines.push(line); };
  try {
    assert.throws(() => run("false", [], "a failing step", ROOT, () => ({ status: 1 })));
    assert.equal(exitCode, 1);
    assert.ok(errorLines.some((l) => l.includes("Gagal")));
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
});

// The regression: the actual `vercel deploy` call site in main() must pass
// WEB_DIR explicitly, not fall through to run()'s ROOT default — a future
// edit that drops the argument (as originally happened) must fail this test.
test("the vercel deploy call site in main() explicitly passes WEB_DIR as its cwd", () => {
  const deployCallMatch = scriptSource.match(/run\(\s*"vercel",\s*\[[^\]]*"deploy"[^\]]*\][^)]*\)/s);
  assert.ok(deployCallMatch, "expected to find the vercel deploy run() call");
  assert.match(deployCallMatch[0], /WEB_DIR/,
    "the vercel deploy call must pass WEB_DIR as cwd — deploying from ROOT silently creates a new, unrelated Vercel project instead of using the pre-linked 'workshop-web' project office.tantular.ai is bound to");
});

test("the build steps (web, package) intentionally still run from ROOT — only the deploy step needs WEB_DIR", () => {
  const buildWebMatch = scriptSource.match(/run\([^)]*build-workshop-web\.mjs[^)]*\)/s);
  const buildPackageMatch = scriptSource.match(/run\([^)]*build-workshop-package\.mjs[^)]*\)/s);
  assert.ok(buildWebMatch && buildPackageMatch, "expected to find both build run() calls");
  assert.doesNotMatch(buildWebMatch[0], /WEB_DIR/);
  assert.doesNotMatch(buildPackageMatch[0], /WEB_DIR/);
});
