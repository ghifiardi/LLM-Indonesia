import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  missingReleaseFiles,
  dirtyBuildInputs,
  REQUIRED_PAGES,
  REQUIRED_DOWNLOADS,
  BUILD_INPUTS,
} from "../tools/release-workshop.mjs";

const WEB = "/tmp/web";
const present = (...names) => {
  const set = new Set(names);
  return (file) => set.has(path.relative(WEB, file));
};
const all = [
  ...REQUIRED_PAGES,
  ...REQUIRED_DOWNLOADS.map((n) => path.join("downloads", n)),
];

test("a complete release reports nothing missing", () => {
  assert.deepEqual(missingReleaseFiles(WEB, present(...all)), []);
});

test("the exact failure that shipped: pages present, downloads/ empty", () => {
  // The web build wiped downloads/ and the package build never followed. The
  // site served /support with a 200 and every download link 404'd.
  const missing = missingReleaseFiles(WEB, present(...REQUIRED_PAGES));
  assert.equal(missing.length, REQUIRED_DOWNLOADS.length);
  assert.ok(missing.includes("downloads/tantular-workshop.zip"));
  assert.ok(missing.includes("downloads/tantular-workshop-manifest.xml"));
  assert.ok(missing.includes("downloads/setup.sh"));
  assert.ok(missing.includes("downloads/setup.ps1"));
});

test("every file the support page links to is required", () => {
  // These two are the links that were dead in production; they must never be
  // droppable from the required set without a test failing.
  assert.ok(REQUIRED_DOWNLOADS.includes("tantular-workshop.zip"));
  assert.ok(REQUIRED_DOWNLOADS.includes("tantular-workshop-manifest.xml"));
  assert.ok(REQUIRED_PAGES.includes("support.html"));
});

test("a zero-length artifact counts as missing", () => {
  // A truncated zip is worse than an absent one: the link works and the
  // archive fails to open, which reads as corruption rather than a bad release.
  const statFile = (file) => path.relative(WEB, file) !== "downloads/tantular-workshop.zip"
    && new Set(all).has(path.relative(WEB, file));
  assert.deepEqual(missingReleaseFiles(WEB, statFile), ["downloads/tantular-workshop.zip"]);
});

test("dirty build inputs are reported so a release stays traceable", () => {
  const runner = (args) => {
    assert.equal(args[0], "status");
    // The inputs queried must match what the package build stamps.
    for (const input of BUILD_INPUTS) assert.ok(args.includes(input), `must check ${input}`);
    return " M src/taskpane.js\n?? src/auth.js\n";
  };
  assert.deepEqual(dirtyBuildInputs(runner), ["M src/taskpane.js", "?? src/auth.js"]);
});

test("a clean tree reports no dirty inputs", () => {
  assert.deepEqual(dirtyBuildInputs(() => ""), []);
});
