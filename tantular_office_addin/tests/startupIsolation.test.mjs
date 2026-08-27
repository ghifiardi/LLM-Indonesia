import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/taskpane.js", import.meta.url), "utf8");

test("optional Microsoft auth is not part of the static taskpane module graph", () => {
  assert.doesNotMatch(source, /from\s+["']\.\/auth\.js["']/);
  assert.match(source, /import\(["']\.\/auth\.js["']\)/);
});

test("core host rendering is scheduled before optional auth initialization", () => {
  const render = source.indexOf('step("renderForHost", renderForHost)');
  const auth = source.indexOf("loadAuthModule()", render);
  assert.ok(render >= 0, "renderForHost startup step must exist");
  assert.ok(auth > render, "optional auth must start only after core rendering");
});

test("manifest host hint mounts chat without waiting for Office.onReady", () => {
  const hint = source.indexOf("const hintedHost = detectHost(undefined)");
  const immediateMount = source.indexOf("mountChatForHost()", hint);
  const readyRegistration = source.indexOf("Office.onReady", hint);
  assert.ok(hint >= 0, "startup must read the manifest host hint");
  assert.ok(immediateMount > hint && immediateMount < readyRegistration,
    "chat must mount from the host hint before Office.onReady");
});

test("Office readiness is registered before optional synchronous hydration", () => {
  const readyRegistration = source.indexOf("Office.onReady");
  const hydrate = source.indexOf('step("hydrateSettings", hydrateSettings)', readyRegistration);
  assert.ok(readyRegistration >= 0);
  assert.ok(hydrate > readyRegistration,
    "storage/UI hydration must not block Office.onReady registration");
});

test("chat mount is single-flight to prevent duplicate event handlers", () => {
  assert.match(source, /let chatMountPromise = null/);
  assert.match(source,
    /function mountChatForHost\(\)[\s\S]*if \(chatMountPromise\) return chatMountPromise/);
});

test("discovery hides the source picker even with older cached HTML", () => {
  assert.match(source,
    /document\.querySelector\("#lookup-host"\)\?\.closest\?\.\("label"\)/);
  assert.match(source, /hostRow\.hidden = hidePicker/);
  assert.match(source, /hostRow\.style\.display = hidePicker \? "none" : ""/);
});
