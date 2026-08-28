import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCommand, parseBody, MAX_BODY_BYTES } from "../bridge/dispatch.mjs";
import { DryRunAdapter } from "../bridge/dryRunAdapter.mjs";
import { createCommand } from "../commandContract.js";

const cmd = (fields) => createCommand({ source: "voice", confidence: 1, ...fields });

test("a valid command is applied and the new state returned", () => {
  const adapter = new DryRunAdapter({ slideCount: 8 });
  const out = dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.state.slide, 2);
});

test("an invalid command is refused before the adapter sees it", () => {
  const adapter = new DryRunAdapter();
  let applied = 0;
  adapter.apply = () => { applied += 1; return { ok: true }; };

  for (const bad of [
    { version: 99, action: "next", source: "voice", confidence: 1 },
    { version: 1, action: "rm -rf", source: "voice", confidence: 1 },
    { version: 1, action: "next", source: "attacker", confidence: 1 },
    { version: 1, action: "goto_slide", source: "voice", confidence: 1, slide: 0 },
    { version: 1, action: "goto_topic", source: "voice", confidence: 1, query: "  " },
    { version: 1, action: "next", source: "voice", confidence: 5 },
  ]) {
    const out = dispatchCommand(adapter, bad);
    assert.equal(out.status, 400, JSON.stringify(bad));
    assert.equal(out.body.ok, false);
  }
  assert.equal(applied, 0, "validation must run before dispatch, never after");
});

test("an adapter fault does not crash the bridge", () => {
  const adapter = new DryRunAdapter();
  adapter.apply = () => { throw new Error("Keynote is not running"); };
  const out = dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 500);
  assert.match(out.body.error, /Keynote is not running/);
});

test("an adapter refusal is reported as unprocessable, not as success", () => {
  const adapter = new DryRunAdapter();
  adapter.apply = () => ({ ok: false, error: "no presentation open" });
  const out = dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 422);
  assert.equal(out.body.ok, false);
});

test("bodies are bounded and must be JSON objects", () => {
  assert.equal(parseBody(Buffer.from("x".repeat(MAX_BODY_BYTES + 1))).ok, false);
  assert.equal(parseBody(Buffer.from("not json")).ok, false);
  assert.equal(parseBody(Buffer.from("[1,2,3]")).ok, false, "an array is not a command");
  assert.equal(parseBody(Buffer.from("null")).ok, false);
  assert.equal(parseBody(Buffer.from('{"a":1}')).ok, true);
});
