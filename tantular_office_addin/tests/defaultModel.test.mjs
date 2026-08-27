import test from "node:test";
import assert from "node:assert/strict";

function withStoredSettings(stored) {
  globalThis.localStorage = {
    getItem: (key) => (key.includes("settings") ? JSON.stringify(stored) : null),
    setItem: () => {}
  };
}

// Fresh import per test: loadSettings reads localStorage at call time, but the
// module-level defaults are what we are pinning here.
const load = async () => (await import("../src/tantularClient.js?" + Math.random())).loadSettings;

test("a fresh install chats with Tantular, not the raw base model", async () => {
  // This shipped as "qwen3.5:9b": every new install answered as stock Qwen
  // while the product said Tantular, and machines without that base model
  // pulled failed with Ollama's "model not found".
  withStoredSettings({});
  const settings = (await load())();
  assert.match(settings.model, /^tantular-office:/, `chat default was ${settings.model}`);
  assert.match(settings.deckModel, /^tantular-office:/);
});

test("chat and Studio default to the same Tantular profile", async () => {
  withStoredSettings({});
  const settings = (await load())();
  assert.equal(settings.model, settings.deckModel,
    "a split default is how chat drifted onto stock Qwen");
});

test("the previous chat default migrates to Tantular", async () => {
  // Nobody chose stock Qwen for a Tantular product on purpose; it was simply
  // what shipped, so it migrates like the other retired defaults.
  withStoredSettings({ model: "qwen3.5:9b" });
  const settings = (await load())();
  assert.match(settings.model, /^tantular-office:/);
});

test("a deliberately chosen model is never migrated", async () => {
  // The migration map only ever touches EXACT old defaults.
  withStoredSettings({ model: "llama3.2:3b", deckModel: "qwen2.5:7b" });
  const settings = (await load())();
  assert.equal(settings.model, "llama3.2:3b");
  assert.equal(settings.deckModel, "qwen2.5:7b");
});

test("a low-RAM machine is never auto-upgraded to a 9B", async () => {
  withStoredSettings({ model: "qwen3:4b" });
  const settings = (await load())();
  assert.equal(settings.model, "tantular-office:lite");
  assert.ok(!/9b/i.test(settings.model));
});

test("chat declares a fallback for machines without the Tantular profile", async () => {
  // Studio always had one; chat did not, so a missing model surfaced as a raw
  // 404 instead of quietly falling back.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/tantularClient.js", import.meta.url), "utf8"));
  assert.match(src, /CHAT_MODEL_FALLBACK/, "chat must declare a fallback model");
  const wiring = src.slice(src.indexOf("fallbackModel:"), src.indexOf("fallbackModel:") + 220);
  assert.match(wiring, /CHAT_MODEL_FALLBACK/, "the fallback must be wired into the request");
});
