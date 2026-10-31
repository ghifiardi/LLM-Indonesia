// Progressive disclosure for "Improve Existing Deck": Tantular Chat is the
// entry point, the manual card collapses into Deck Studio as
// "Perbaiki slide terpilih — Lanjutan", and both share one improve pipeline.
// taskpane.js / pptChat.js touch `document` at module scope, so like
// studioCacheWiring.test.mjs these assertions read the real source text.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const html = read("src/taskpane.html");
const css = read("src/taskpane.css");
const taskpane = read("src/taskpane.js");
const pptChat = read("src/chat/pptChat.js");
const chatPane = read("src/chat/chatPane.js");

function topLevelFunctionBody(js, name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\b`, "m");
  const match = marker.exec(js);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const next = js.slice(start + 1).search(/^(?:async )?function /m);
  return next === -1 ? js.slice(start) : js.slice(start, start + 1 + next);
}

test("the Lanjutan section lives INSIDE Deck Studio and is collapsed by default", () => {
  const studioStart = html.indexOf('<section id="deck-studio"');
  const studioEnd = html.indexOf("</section>", studioStart);
  const studio = html.slice(studioStart, studioEnd);
  assert.ok(studio.includes('id="deck-refine"'), "#deck-refine must be nested in #deck-studio");
  assert.ok(!html.includes('<section id="deck-refine"'), "#deck-refine is no longer its own card");
  assert.match(studio, /Perbaiki slide terpilih — Lanjutan/);
  const toggle = studio.match(/<button[^>]*id="refine-toggle"[^>]*>/);
  assert.ok(toggle, "a #refine-toggle button opens the section");
  assert.match(toggle[0], /aria-expanded="false"/);
  assert.match(toggle[0], /aria-controls="refine-body"/);
  const body = studio.match(/<div[^>]*id="refine-body"[^>]*>/);
  assert.ok(body, "#refine-body wraps the advanced controls");
  assert.match(body[0], /class="[^"]*\bhidden\b[^"]*"/, "collapsed by default");
});

test("the Lanjutan section keeps its manual controls and adds the visual-mode select", () => {
  for (const id of ["refine-instruction", "refine-run", "refine-download", "refine-visual-mode"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must exist`);
  }
  const select = html.slice(html.indexOf('id="refine-visual-mode"'));
  const options = select.slice(0, select.indexOf("</select>"));
  for (const [value, label] of [
    ["auto", "Otomatis"], ["concise", "Lebih ringkas"], ["cards", "Kartu"], ["columns", "Kolom"], ["chart", "Chart jika ada angka"]
  ]) {
    assert.match(options, new RegExp(`<option value="${value}">${label}</option>`));
  }
});

test("no cyan/magenta styling remains; the improve button uses the Tantular tokens", () => {
  for (const file of [css, html, taskpane, pptChat]) {
    assert.ok(!/24BDAD/i.test(file), "no #24BDAD");
    assert.ok(!/EC008C/i.test(file), "no #EC008C");
  }
  assert.ok(!/linear-gradient\([^)]*#24BDAD/i.test(css));
  assert.ok(!/rgba\(36, 189, 173/.test(css));
  assert.ok(!/rgba\(236, 0, 140/.test(css));
});

test("taskpane wires the toggle and the Lanjutan card goes through the shared improve pipeline", () => {
  assert.match(taskpane, /refineToggle: document\.querySelector\("#refine-toggle"\)/);
  assert.match(taskpane, /refineBody: document\.querySelector\("#refine-body"\)/);
  assert.match(taskpane, /refineVisualMode: document\.querySelector\("#refine-visual-mode"\)/);
  const body = topLevelFunctionBody(taskpane, "refineSelectedSlide");
  assert.match(body, /runImproveSlidePipeline\(/, "the card must call the shared pipeline");
  assert.ok(!/improveExistingSlide\(/.test(body), "the card must not call improveExistingSlide directly (second path)");
  const bundle = topLevelFunctionBody(taskpane, "refineInstructionBundle");
  assert.match(bundle, /refineVisualModeInstruction\(/, "select value becomes instruction text for the same pipeline");
});

test("pptChat resolves 'slide ini' from the live selection and never writes without one usable slide", () => {
  assert.match(pptChat, /mentionsSelectedSlide\(/);
  assert.match(pptChat, /resolveSelectedSlideIndex\(/);
  assert.match(pptChat, /getSelectedSlideTextContext/);
  assert.match(pptChat, /pinActionsToSlide\(/);
  assert.match(pptChat, /pptQuickChips\(/);
  assert.match(pptChat, /DECK_SETTINGS_NOTE/);
  // Chips render through data; the two improve chips send() a message and the
  // only write path remains the confirmed plan.
  assert.ok(!/replaceSlideInActivePresentation|insertSlideAfterInActivePresentation|deleteSlidesInActivePresentation/.test(pptChat),
    "pptChat must never touch a PowerPoint write API");
  const writes = pptChat.match(/executeConfirmedPptPlan\(/g) || [];
  assert.equal(writes.length, 1, "exactly one confirmed write call site, inside the confirm click handler");
});

test("Word chat chips do not include the PowerPoint improve chips", () => {
  assert.ok(!/Perbaiki slide terpilih|Buat slide lebih visual/.test(chatPane));
});

test("pptChat fills a missing improve_slide intent from the user's message BEFORE planning, so the proposal wording is honest", () => {
  const fill = pptChat.indexOf("resolveImproveIntent(");
  const plan = pptChat.indexOf("executePptActions(actions, ctx)");
  assert.notEqual(fill, -1, "pptChat must resolve the intent for improve_slide actions");
  assert.ok(fill < plan, "the intent must be attached before executePptActions builds the proposal");
});

test("pptChat routes planner replace_slide on text-bearing slides through improve_slide before planning", () => {
  const route = pptChat.indexOf("preferImproveOverReplace(");
  const plan = pptChat.indexOf("executePptActions(actions, ctx)");
  assert.notEqual(route, -1);
  assert.ok(route < plan);
});

// --- "Usulkan perbaikan slide ini" checklist (2026-09-03) ------------------
test("pptChat offers a suggestion checklist and applies ONLY ticked items on a click, through executeSuggestionPlan", () => {
  assert.match(pptChat, /wantsSuggestions\(/);
  assert.match(pptChat, /requestSuggestions\(/);
  assert.match(pptChat, /executeSuggestionPlan\(/);
  assert.match(pptChat, /type = "checkbox"/, "each suggestion is a checkbox");
  // The apply call is reachable only from a click handler.
  const applyIdx = pptChat.indexOf("executeSuggestionPlan(");
  const clickIdx = pptChat.lastIndexOf('addEventListener("click"', applyIdx);
  assert.ok(clickIdx !== -1 && applyIdx - clickIdx < 2500, "executeSuggestionPlan must sit inside a click handler");
  assert.match(pptChat, /Terapkan \$\{[^}]+\} perubahan/, "the button names how many items are ticked");
});

test("pptChat offers the re-layout chip and intent, gated behind the confirm row", () => {
  assert.match(pptChat, /wantsLayoutTidy\(/);
  assert.match(pptChat, /executeRelayout\(/);
  const idx = pptChat.indexOf("executeRelayout(");
  const click = pptChat.lastIndexOf('addEventListener("click"', idx);
  assert.ok(click !== -1 && idx - click < 2500, "layout tidy runs only from a click handler");
});

test("pptChat routes formatting requests to executeFormat behind a click, before the planner", () => {
  assert.match(pptChat, /parseFormatRequest\(/);
  assert.match(pptChat, /executeFormat\(/);
  // executeFormat is handed to addActionConfirm as a runner, and the runner
  // is invoked only inside that helper's click handler.
  const idx = pptChat.indexOf("executeFormat(");
  const confirmCall = pptChat.lastIndexOf("addActionConfirm(", idx);
  assert.ok(confirmCall !== -1 && idx - confirmCall < 400, "executeFormat must be a confirm-row runner");
  const helper = pptChat.indexOf("function addActionConfirm(");
  const runnerCall = pptChat.indexOf("await runner(", helper);
  const click = pptChat.lastIndexOf('addEventListener("click"', runnerCall);
  assert.ok(helper !== -1 && click > helper && runnerCall > click, "the runner fires only from the click handler");
  assert.ok(pptChat.indexOf("parseFormatRequest(") < pptChat.indexOf("executePptActions(actions, ctx)"));
});

// Live (2026-09-05, host38): "Can't find variable: SELECT_ONE_SLIDE_MESSAGE".
// pptChat.js is never executed under node:test, so an unimported identifier
// only fails in the pane. Every UPPER_CASE constant and every known helper
// used in pptChat must appear in an import.
test("every module-level name pptChat uses is imported", () => {
  const imported = new Set([...pptChat.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
    .flatMap((m) => m[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean)));
  const body = pptChat.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]+";/g, "")
    .replace(/\/\/[^\n]*/g, "").replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const constants = new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]));
  const declared = new Set([...body.matchAll(/\b(?:const|let|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const name of constants) {
    if (declared.has(name) || name in globalThis) continue;
    assert.ok(imported.has(name), `${name} is used in pptChat.js but not imported`);
  }
  for (const helper of ["executeFormat", "executeRelayout", "executeSuggestionPlan", "executeConfirmedPptPlan", "parseFormatRequest", "requestSuggestions", "wantsSuggestions", "wantsLayoutTidy", "groundActionIntent", "preferImproveOverReplace"]) {
    if (body.includes(`${helper}(`)) assert.ok(imported.has(helper), `${helper} used but not imported`);
  }
});

// Live (2026-09-05, host39): "sesuaikan ukuran font sehingga proporsional"
// named no slide, so the format branch answered "Pilih satu slide" although a
// slide WAS selected. Every slide action resolves the live selection when the
// message names none.
test("slide actions fall back to the live selection when the message names no slide", () => {
  const helper = pptChat.indexOf("async function resolveActionSlide(");
  assert.ok(helper !== -1, "a shared resolver exists");
  const helperBody = pptChat.slice(helper, pptChat.indexOf("\n  }\n", helper));
  assert.match(helperBody, /getSelectedSlideTextContext\(\)/);
  assert.match(helperBody, /resolveSelectedSlideIndex\(/);
  for (const branch of ["parseFormatRequest(message)", "wantsLayoutTidy(message)", "wantsSuggestions(message)"]) {
    const at = pptChat.indexOf(branch);
    assert.ok(at !== -1, branch);
    const window = pptChat.slice(at, at + 700);
    assert.match(window, /resolveActionSlide\(/, `${branch} must use the shared resolver`);
  }
});

// --- chat over the attachment (2026-09-05) ------------------------------------
test("the Word chat gets the attachment from the pane and answers over it: stats first, then retrieval, before the pipeline", () => {
  assert.match(taskpane, /state\.attachment = \{/, "the pane keeps the full extracted attachment");
  assert.match(taskpane, /mountChatPane\(\{ host: state\.host, getAttachment/, "the chat receives an attachment getter");
  assert.match(chatPane, /answerAttachmentStats\(/);
  assert.match(chatPane, /retrieveFromAttachment\(/);
  assert.match(chatPane, /"attachment"/);
  const stats = chatPane.indexOf("answerAttachmentStats(");
  // The pipeline call became `… ? runPersingkat : getPipeline(intent)` (stale-context fix, 76c5be4).
  const pipeline = chatPane.indexOf("getPipeline(intent)");
  assert.ok(stats !== -1 && pipeline !== -1 && stats < pipeline, "stats answers never go through the model");
});

test("the attachment is extracted when the file is chosen, not only when a Studio runs; the chat can elaborate it", () => {
  const change = taskpane.indexOf('els.sourceDocumentInput.addEventListener("change"');
  const window = taskpane.slice(change, change + 1500);
  assert.match(window, /extractDocumentFile\(|ingestAttachmentForChat\(/, "eager extraction on change");
  assert.match(taskpane, /async function ingestAttachmentForChat\(/);
  assert.match(chatPane, /wantsElaboration\(/);
  assert.match(chatPane, /elaborateSections\(/);
  assert.match(chatPane, /addDocumentAnswerActions\(answer, /, "the elaboration reuses the insert actions");
});
