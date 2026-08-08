import test from "node:test";
import assert from "node:assert/strict";

test("uses relative companion paths when no browser location exists", async () => {
  const { companionUrl } = await import(`../src/companionUrl.js?local=${Date.now()}`);
  assert.equal(companionUrl("/api/models"), "/api/models");
});

test("uses the local HTTPS companion from a published task pane", async () => {
  const previous = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hostname: "tantular-workshop.example.com" }
  });
  try {
    const { companionUrl } = await import(`../src/companionUrl.js?published=${Date.now()}`);
    assert.equal(companionUrl("/api/models"), "https://localhost:3000/api/models");
  } finally {
    if (previous === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: previous });
  }
});
