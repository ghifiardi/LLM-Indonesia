import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostUiConfig } from "../src/hostUi.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "src/taskpane.html"), "utf8");
const js = fs.readFileSync(path.join(root, "src/taskpane.js"), "utf8");

// Extract a <section id="..."> ... </section> block by id.
function sectionBody(id) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `section #${id} must exist`);
  const open = html.lastIndexOf("<section", start);
  const close = html.indexOf("</section>", start);
  return html.slice(open, close);
}

const UPLOAD_IDS = ["source-document-input", "source-image-input"];

test("upload inputs exist exactly once", () => {
  for (const id of UPLOAD_IDS) {
    const count = html.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `#${id} must appear exactly once`);
  }
});

test("upload inputs are not inside any host-gated studio", () => {
  // They used to live in #deck-studio, which hostUiConfig grants to PowerPoint
  // alone — so Word and Excel had no way to upload a PDF, document, or
  // screenshot at all. Putting them back inside any studio recreates that.
  for (const id of ["deck-studio", "document-studio", "sheet-studio", "deck-refine"]) {
    const body = sectionBody(id);
    for (const input of UPLOAD_IDS) {
      assert.ok(!body.includes(`id="${input}"`),
        `#${input} must not live inside #${id} — that hides it from other hosts`);
    }
  }
});

test("every host that has a studio can reach the uploads", () => {
  // The upload card is ungated, so this is really a guard on the premise: each
  // host does have somewhere for uploaded content to go.
  for (const host of ["Word", "Excel", "PowerPoint"]) {
    const ui = hostUiConfig(host);
    assert.ok(ui.documentStudio || ui.sheetStudio || ui.deckStudio,
      `${host} must have a studio that can consume an upload`);
  }
});

test("all three studios ingest uploads through the shared path", () => {
  // Word and Excel silently ignored the file inputs before; each resolver must
  // actually call the shared ingestion.
  // "await" excludes the function definition, which also matches the name.
  const calls = js.split("await ingestUploadedSource({").length - 1;
  assert.equal(calls, 3, "deck, document and sheet resolvers must each ingest uploads");
  for (const resolver of ["resolveDeckSpec", "resolveDocumentSpec", "resolveWorkbookSpec"]) {
    const start = js.indexOf(`async function ${resolver}(`);
    assert.notEqual(start, -1, `${resolver} must exist`);
    const body = js.slice(start, start + 1200);
    assert.match(body, /ingestUploadedSource\(\{/, `${resolver} must ingest uploads`);
    assert.match(body, /uploadedOrTypedContent\(docFile\)/, `${resolver} must use the uploaded text`);
  }
});

test("no resolver truncates the brief with a bare slice", () => {
  // A bare slice(0, 40_000) is the silent truncation this project removed;
  // bounding must go through boundedBrief, which warns.
  assert.ok(!/brief:\s*content\.slice\(/.test(js),
    "bound the brief with boundedBrief so the user is told when text is cut");
});
