import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCommand, parseBody, MAX_BODY_BYTES } from "../bridge/dispatch.mjs";
import { DryRunAdapter } from "../bridge/dryRunAdapter.mjs";
import { createCommand } from "../commandContract.js";

const cmd = (fields) => createCommand({ source: "voice", confidence: 1, ...fields });

test("a valid command is applied and the new state returned", async () => {
  const adapter = new DryRunAdapter({ slideCount: 8 });
  const out = await dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.state.slide, 2);
});

test("an invalid command is refused before the adapter sees it", async () => {
  const adapter = new DryRunAdapter();
  let applied = 0;
  // Count every interface method: dispatch routes by action name now, so
  // stubbing apply() alone would no longer prove the adapter was untouched.
  for (const m of ["next", "previous", "goto_slide", "goto_topic", "blank", "resume", "start", "end"]) {
    adapter[m] = async () => { applied += 1; return { ok: true }; };
  }

  for (const bad of [
    { version: 99, action: "next", source: "voice", confidence: 1 },
    { version: 1, action: "rm -rf", source: "voice", confidence: 1 },
    { version: 1, action: "next", source: "attacker", confidence: 1 },
    { version: 1, action: "goto_slide", source: "voice", confidence: 1, slide: 0 },
    { version: 1, action: "goto_topic", source: "voice", confidence: 1, query: "  " },
    { version: 1, action: "next", source: "voice", confidence: 5 },
  ]) {
    const out = await dispatchCommand(adapter, bad);
    assert.equal(out.status, 400, JSON.stringify(bad));
    assert.equal(out.body.ok, false);
  }
  assert.equal(applied, 0, "validation must run before dispatch, never after");
});

test("an adapter fault does not crash the bridge", async () => {
  const adapter = new DryRunAdapter();
  adapter.next = async () => { throw new Error("Keynote is not running"); };
  const out = await dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 500);
  assert.match(out.body.error, /Keynote is not running/);
});

test("an adapter refusal is reported as unprocessable, not as success", async () => {
  const adapter = new DryRunAdapter();
  adapter.next = async () => ({ ok: false, refused: true, reason: "no-slideshow", detail: "not presenting" });
  const out = await dispatchCommand(adapter, cmd({ action: "next" }));
  assert.equal(out.status, 422);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, true, "a fail-safe refusal must be distinguishable from a fault");
  assert.equal(out.body.error, "no-slideshow");
});

test("bodies are bounded and must be JSON objects", () => {
  assert.equal(parseBody(Buffer.from("x".repeat(MAX_BODY_BYTES + 1))).ok, false);
  assert.equal(parseBody(Buffer.from("not json")).ok, false);
  assert.equal(parseBody(Buffer.from("[1,2,3]")).ok, false, "an array is not a command");
  assert.equal(parseBody(Buffer.from("null")).ok, false);
  assert.equal(parseBody(Buffer.from('{"a":1}')).ok, true);
});
