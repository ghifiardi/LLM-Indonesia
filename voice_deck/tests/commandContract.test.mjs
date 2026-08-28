import test from "node:test";
import assert from "node:assert/strict";
import { createCommand, validateCommand, CONTRACT_VERSION } from "../commandContract.js";

test("createCommand strips fields not used by the action", () => {
  const command = createCommand({
    action: "next",
    slide: 5,
    query: "pricing",
    source: "voice",
    confidence: 0.9,
    transcript: "next slide",
  });
  assert.equal(command.slide, undefined);
  assert.equal(command.query, undefined);
  assert.equal(command.version, CONTRACT_VERSION);
});

test("validateCommand accepts a well-formed goto_slide command", () => {
  const command = createCommand({ action: "goto_slide", slide: 3, source: "text", confidence: 1 });
  const result = validateCommand(command);
  assert.equal(result.ok, true);
});

test("validateCommand rejects unknown action", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "delete_slide",
    source: "text",
    confidence: 1,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects unknown source", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "next",
    source: "telepathy",
    confidence: 1,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects out-of-range confidence", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "next",
    source: "voice",
    confidence: 1.5,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects goto_slide with non-integer slide", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "goto_slide",
    source: "voice",
    confidence: 1,
    slide: 2.5,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects goto_slide with slide < 1", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "goto_slide",
    source: "voice",
    confidence: 1,
    slide: 0,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects goto_topic with empty query", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "goto_topic",
    source: "voice",
    confidence: 1,
    query: "   ",
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects unexpected fields for the action", () => {
  const result = validateCommand({
    version: CONTRACT_VERSION,
    action: "next",
    source: "voice",
    confidence: 1,
    slide: 4,
  });
  assert.equal(result.ok, false);
});

test("validateCommand rejects wrong contract version", () => {
  const result = validateCommand({
    version: 2,
    action: "next",
    source: "voice",
    confidence: 1,
  });
  assert.equal(result.ok, false);
});
