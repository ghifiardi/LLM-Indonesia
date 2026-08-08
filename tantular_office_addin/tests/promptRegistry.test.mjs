import test from "node:test";
import assert from "node:assert/strict";
import { getPrompt, allPromptIds, PROMPT_IDS } from "../src/promptRegistry.js";

test("exposes all 9 prompt ids, frozen", () => {
  assert.ok(Object.isFrozen(PROMPT_IDS));
  assert.equal(allPromptIds().length, 9);
  assert.ok(allPromptIds().includes("router"));
  assert.ok(allPromptIds().includes("edit"));
});
test("getPrompt returns stable content hash", () => {
  const a = getPrompt("router");
  assert.ok(a.content.length > 0);
  assert.equal(a.contentHash, getPrompt("router").contentHash);
  assert.notEqual(getPrompt("router").contentHash, getPrompt("edit").contentHash);
});
test("unknown id throws", () => {
  assert.throws(() => getPrompt("nope"));
});
