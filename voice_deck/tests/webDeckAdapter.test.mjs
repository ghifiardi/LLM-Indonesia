import test from "node:test";
import assert from "node:assert/strict";
import { WebDeckAdapter } from "../webDeckAdapter.js";
import { createCommand } from "../commandContract.js";

function makeDeck() {
  return {
    slides: [
      { id: 1, title: "Intro", body: ["hello"], notes: "n1", tags: ["intro"] },
      { id: 2, title: "Pricing", body: ["cheap"], notes: "n2", tags: ["pricing"] },
      { id: 3, title: "Closing", body: ["bye"], notes: "n3", tags: ["end"] },
    ],
  };
}

function cmd(fields) {
  return createCommand({ source: "text", confidence: 1, ...fields });
}

test("next advances and previous retreats within bounds", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  assert.equal(adapter.apply(cmd({ action: "next" })).ok, true);
  assert.equal(adapter.getState().currentSlide, 2);
  assert.equal(adapter.apply(cmd({ action: "previous" })).ok, true);
  assert.equal(adapter.getState().currentSlide, 1);
});

test("previous at slide 1 is rejected, not clamped silently past bounds", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  const result = adapter.apply(cmd({ action: "previous" }));
  assert.equal(result.ok, false);
  assert.equal(adapter.getState().currentSlide, 1);
});

test("next at last slide is rejected", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  adapter.apply(cmd({ action: "goto_slide", slide: 3 }));
  const result = adapter.apply(cmd({ action: "next" }));
  assert.equal(result.ok, false);
  assert.equal(adapter.getState().currentSlide, 3);
});

test("goto_slide out of range is rejected", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  const result = adapter.apply(cmd({ action: "goto_slide", slide: 99 }));
  assert.equal(result.ok, false);
  assert.equal(adapter.getState().currentSlide, 1);
});

test("goto_topic navigates to the best-matching slide", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  const result = adapter.apply(cmd({ action: "goto_topic", query: "pricing" }));
  assert.equal(result.ok, true);
  assert.equal(adapter.getState().currentSlide, 2);
});

test("goto_topic with no match is rejected and does not move the slide", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  const result = adapter.apply(cmd({ action: "goto_topic", query: "quantum entanglement" }));
  assert.equal(result.ok, false);
  assert.equal(adapter.getState().currentSlide, 1);
});

test("show_notes / hide_notes toggle notesVisible", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  adapter.apply(cmd({ action: "show_notes" }));
  assert.equal(adapter.getState().notesVisible, true);
  adapter.apply(cmd({ action: "hide_notes" }));
  assert.equal(adapter.getState().notesVisible, false);
});

test("blank / resume toggle blanked", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  adapter.apply(cmd({ action: "blank" }));
  assert.equal(adapter.getState().blanked, true);
  adapter.apply(cmd({ action: "resume" }));
  assert.equal(adapter.getState().blanked, false);
});

test("start resets to slide 1 and end blanks the stage", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  adapter.apply(cmd({ action: "goto_slide", slide: 3 }));
  adapter.apply(cmd({ action: "start" }));
  assert.equal(adapter.getState().currentSlide, 1);
  assert.equal(adapter.getState().started, true);

  adapter.apply(cmd({ action: "end" }));
  assert.equal(adapter.getState().ended, true);
  assert.equal(adapter.getState().blanked, true);
});

test("apply rejects a malformed command instead of throwing", () => {
  const adapter = new WebDeckAdapter(makeDeck());
  const result = adapter.apply({ version: 1, action: "not_a_real_action", source: "text", confidence: 1 });
  assert.equal(result.ok, false);
});

test("onChange fires with the new state after each mutation", () => {
  const seen = [];
  const adapter = new WebDeckAdapter(makeDeck(), { onChange: (state) => seen.push(state.currentSlide) });
  adapter.apply(cmd({ action: "next" }));
  adapter.apply(cmd({ action: "next" }));
  assert.deepEqual(seen, [2, 3]);
});
