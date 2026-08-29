import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, hashText } from "../src/chat/contextBuilder.js";

test("short text is a single chunk", () => {
  assert.deepEqual(chunkText("halo dunia", { chunkSize: 3000 }), ["halo dunia"]);
});

test("splits on paragraph boundaries, not mid-paragraph", () => {
  const p1 = "a".repeat(1800), p2 = "b".repeat(1800), p3 = "c".repeat(1800);
  const chunks = chunkText(`${p1}\n${p2}\n${p3}`, { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].includes(p1) && !chunks[0].includes("b"));
});

test("hard-splits a single oversized paragraph", () => {
  const chunks = chunkText("x".repeat(7000), { chunkSize: 3000 });
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3000);
});

test("hash is stable and change-sensitive", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});
