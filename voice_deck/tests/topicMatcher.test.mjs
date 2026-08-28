import test from "node:test";
import assert from "node:assert/strict";
import { matchTopic } from "../topicMatcher.js";

const slides = [
  { title: "Introduction", body: ["Welcome to the deck"], tags: ["intro", "welcome"] },
  { title: "Design Principles", body: ["Reliability before cleverness"], tags: ["principles"] },
  { title: "Rollout and Pricing", body: ["Phase 1 is free"], tags: ["pricing", "rollout"] },
];

test("matches on title keyword", () => {
  assert.equal(matchTopic("tell me about pricing", slides), 3);
});

test("matches on tag keyword", () => {
  assert.equal(matchTopic("intro please", slides), 1);
});

test("matches on body keyword when title/tags don't hit", () => {
  assert.equal(matchTopic("cleverness", slides), 2);
});

test("returns null when nothing scores at or above minScore", () => {
  assert.equal(matchTopic("quantum entanglement", slides), null);
});

test("returns null for an empty query", () => {
  assert.equal(matchTopic("   ", slides), null);
});

test("is case- and accent-insensitive", () => {
  const accented = [{ title: "Café Strategy", body: [], tags: [] }];
  assert.equal(matchTopic("CAFE strategy", accented), 1);
});
