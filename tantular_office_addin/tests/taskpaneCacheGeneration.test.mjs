// 2026-08-31: a hosted deploy of new src code (e.g. the document-fallback
// fix) is invisible to an already-open Office WebView unless the top-level
// module URL itself changes — Office caches the module graph by URL, so
// deploying new file CONTENTS at the same "?entry=host11" URL risks a stale
// pane. src/taskpane.html's own comment calls this "an intentional top-level
// cache generation". These tests pin that every occurrence of the
// generation token — the two visible build-tag labels, the two
// "?entry=hostNN" script URLs, the descriptive comment, and
// officeClient.js's TASKPANE_BUILD — is the SAME value, so a future bump
// cannot drift one location and miss another (exactly what would silently
// reintroduce the stale-cache risk this token exists to prevent).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "src/taskpane.html"), "utf8");
const officeClientSource = fs.readFileSync(path.join(root, "src/officeClient.js"), "utf8");

function allGenerationTokens(text) {
  return [...text.matchAll(/\bhost(\d+)\b/g)].map((m) => m[1]);
}

test("every 'hostNN' cache-generation token in taskpane.html is the same value", () => {
  const tokens = allGenerationTokens(html);
  assert.ok(tokens.length >= 4, "expected at least the two build-tag labels and two ?entry= script URLs");
  assert.ok(new Set(tokens).size === 1, `expected a single consistent generation token, found: ${[...new Set(tokens)].join(", ")}`);
});

test("both '?entry=hostNN' script URLs in taskpane.html use the same token", () => {
  const traceSinkMatch = html.match(/traceSink\.js\?entry=host(\d+)/);
  const taskpaneMatch = html.match(/taskpane\.js\?entry=host(\d+)/);
  assert.ok(traceSinkMatch && taskpaneMatch, "expected both entry= script URLs to be present");
  assert.equal(traceSinkMatch[1], taskpaneMatch[1]);
});

test("officeClient.js's TASKPANE_BUILD matches the taskpane.html generation token", () => {
  const htmlTokens = new Set(allGenerationTokens(html));
  assert.equal(htmlTokens.size, 1, "taskpane.html must already be internally consistent");
  const htmlToken = [...htmlTokens][0];

  const buildMatch = officeClientSource.match(/export const TASKPANE_BUILD = "host(\d+)"/);
  assert.ok(buildMatch, "TASKPANE_BUILD must be exported as \"hostNN\"");
  assert.equal(buildMatch[1], htmlToken,
    "TASKPANE_BUILD must match taskpane.html's generation token exactly — a mismatch here is exactly the drift this cache-generation scheme exists to prevent");
});
