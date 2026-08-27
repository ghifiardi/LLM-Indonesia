import test from "node:test";
import assert from "node:assert/strict";

import { companionEnvironment } from "../tools/companion-config.mjs";

const root = "/tmp/tantular-config-test";

test("lookup stays fail-closed when no local config exists", () => {
  const result = companionEnvironment({
    root,
    baseEnv: {},
    readFile: () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    }
  });
  assert.equal(result.lookupEnabled, false);
  assert.equal(result.warning, "");
});

test("local config explicitly enables lookup and narrows its hosts", () => {
  const result = companionEnvironment({
    root,
    baseEnv: {},
    readFile: () => JSON.stringify({
      lookup: {
        enabled: true,
        discoveryAlpha: true,
        provider: "official-federated",
        hosts: ["id.wikipedia.org", "peraturan.bpk.go.id", "id.wikipedia.org"]
      }
    })
  });
  assert.equal(result.lookupEnabled, true);
  assert.equal(result.env.TANTULAR_LOOKUP_ENABLED, "true");
  assert.equal(result.env.TANTULAR_LOOKUP_HOSTS,
    "id.wikipedia.org,peraturan.bpk.go.id");
  assert.equal(result.discoveryAlpha, true);
  assert.equal(result.searchProvider, "official-federated");
});

test("explicit environment false overrides a persisted opt-in", () => {
  const result = companionEnvironment({
    root,
    baseEnv: { TANTULAR_LOOKUP_ENABLED: "false" },
    readFile: () => JSON.stringify({ lookup: { enabled: true } })
  });
  assert.equal(result.lookupEnabled, false);
  assert.equal(result.env.TANTULAR_LOOKUP_ENABLED, "false");
});
