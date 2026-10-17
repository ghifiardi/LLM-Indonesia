import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import {
  parseCliArgs,
  buildRunPlan,
  verifiedLoadStateFor,
  preflight,
  main,
  runOne,
  classifyRow,
  httpsFetch,
  installEnvironment,
  requestedMaxTokensFor,
  FIXTURES,
  SETTINGS_STORAGE_KEY
} from "../tools/benchmark-studio.mjs";
import { BRIDGE_REVISION } from "../src/chat/ollamaBridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Every main() call that reaches a measured row appends to --out — never
// let a test write into the repo's own tools/ directory.
let tempOutCounter = 0;
function tempOut() {
  tempOutCounter += 1;
  return path.join(os.tmpdir(), `benchmark-studio-test-${process.pid}-${tempOutCounter}.jsonl`);
}

// --- parseCliArgs / plan sizing ---------------------------------------------

test("default invocation schedules exactly one measured call", () => {
  const args = parseCliArgs([]);
  assert.deepEqual(args.errors, []);
  assert.deepEqual(args.fixtures, ["short"]);
  assert.deepEqual(args.sections, [3]);
  assert.deepEqual(args.loadStates, ["warm"]);
  assert.equal(args.iterations, 1);
  const plan = buildRunPlan(args);
  assert.equal(plan.length, 1);
});

test("--all schedules 9 x iterations calls", () => {
  const args = parseCliArgs(["--all", "--iterations", "4"]);
  assert.deepEqual(args.errors, []);
  assert.equal(args.fixtures.length, 3);
  assert.equal(args.sections.length, 3);
  const plan = buildRunPlan(args);
  assert.equal(plan.length, 3 * 3 * 4);
});

test("--load-state both doubles the plan and never interleaves cold/warm within a scenario", () => {
  const args = parseCliArgs(["--fixture", "short", "--sections", "3", "--load-state", "both", "--iterations", "3"]);
  const plan = buildRunPlan(args);
  assert.equal(plan.length, 6);
  const states = plan.map((p) => p.loadState);
  let switches = 0;
  for (let i = 1; i < states.length; i += 1) if (states[i] !== states[i - 1]) switches += 1;
  assert.equal(switches, 1, `expected exactly one cold<->warm transition, saw ${switches} in [${states.join(",")}]`);
});

test("--temperature is accepted as a deprecated alias for --load-state", () => {
  const args = parseCliArgs(["--temperature", "cold"]);
  assert.deepEqual(args.errors, []);
  assert.deepEqual(args.loadStates, ["cold"]);
});

test("iterations must be a positive integer", () => {
  for (const bad of ["0", "-1", "abc", "1.5"]) {
    const args = parseCliArgs(["--iterations", bad]);
    assert.ok(args.errors.length > 0, `--iterations ${bad} must be rejected`);
  }
});

test("invalid --fixture/--sections/--load-state are rejected with a clear error, not silently defaulted", () => {
  assert.ok(parseCliArgs(["--fixture", "huge"]).errors.length > 0);
  assert.ok(parseCliArgs(["--sections", "7"]).errors.length > 0);
  assert.ok(parseCliArgs(["--load-state", "lukewarm"]).errors.length > 0);
});

test("requestedMaxTokensFor matches documentPlanner.js's formula", () => {
  assert.equal(requestedMaxTokensFor(3), 1200 + 3 * 450);
  assert.equal(requestedMaxTokensFor(12), 6000); // capped
});

// --- verifiedLoadStateFor ----------------------------------------------------

test("unverified cold/warm preparation is never labeled cold or warm", () => {
  assert.equal(verifiedLoadStateFor("cold", true), "cold");
  assert.equal(verifiedLoadStateFor("cold", false), "unknown");
  assert.equal(verifiedLoadStateFor("warm", true), "warm");
  assert.equal(verifiedLoadStateFor("warm", false), "unknown");
});

// --- preflight (installEnvironment must run first in real usage) -----------

test("preflight fails cleanly when the dev-server is unreachable, without ever calling Ollama's model list", async () => {
  const originalFetch = globalThis.fetch;
  const calledUrls = [];
  globalThis.fetch = async (url) => {
    calledUrls.push(String(url));
    if (String(url).includes("localhost:3000")) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ version: "0.1.0", models: [] }), text: async () => "" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dev-server/i);
    assert.ok(!calledUrls.some((u) => u.includes("/api/tags")), "must not check model installation if the dev-server itself is unreachable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight fails cleanly when Ollama is unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("11434")) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({}), text: async () => "<html></html>" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ollama/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight fails when the requested model is not installed in Ollama", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/version")) return { ok: true, status: 200, json: async () => ({ version: "0.1.0" }), text: async () => "" };
    if (u.includes("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: "some-other-model" }] }), text: async () => "" };
    }
    if (u.includes("/api/diagnostics")) {
      return { ok: true, status: 200, json: async () => ({ ollamaOrigin: "http://127.0.0.1:11434" }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "<html></html>" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "tantular-office:lite" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not installed/i);
    assert.match(result.reason, /tantular-office:lite/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight succeeds when both origins answer ok, the Companion's Ollama matches, and the model is installed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    if (u.includes("/api/diagnostics")) return { ok: true, status: 200, json: async () => ({ ollamaOrigin: "http://127.0.0.1:11434" }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m" });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-08-31: a stale Companion process (started before the JSON-Schema
// bridge was saved to disk) keeps its OLD bridge loaded — Node does not
// hot-reload ES module imports. A schema benchmark run against that process
// would "prove" something about Ollama's own schema enforcement that was
// never actually tested. requireJsonSchema makes preflight refuse outright
// rather than produce a gate result that looks like a schema result but
// isn't one.
test("preflight refuses a schema benchmark against a Companion whose bridge lacks jsonSchema capability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) {
      return {
        ok: true, status: 200,
        json: async () => ({ ollamaOrigin: "http://127.0.0.1:11434", companionBootId: "old-boot", bridgeCapabilities: {} }),
        text: async () => ""
      };
    }
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({
      devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m", requireJsonSchema: true
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /jsonSchema/i);
    assert.match(result.reason, /restart/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight succeeds for a schema benchmark and surfaces the diagnostics payload when the bridge is capable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          ollamaOrigin: "http://127.0.0.1:11434",
          companionBootId: "fresh-boot",
          bridgeRevision: BRIDGE_REVISION,
          bridgeCapabilities: { jsonSchema: true, structuredModeEcho: true, disconnectCancellation: true, inferenceMetrics: true }
        }),
        text: async () => ""
      };
    }
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({
      devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m", requireJsonSchema: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.diag.companionBootId, "fresh-boot");
    assert.equal(result.diag.bridgeCapabilities.jsonSchema, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 2026-08-31: this exact scenario happened twice — a Companion process whose
// bridgeCapabilities.jsonSchema was already true (from an earlier fix)
// still predated a LATER change (structured-mode telemetry) that a
// capability-presence check alone cannot detect. bridgeRevision is a build
// identity check, not a feature-presence check, and closes that gap.
test("preflight refuses a schema benchmark when bridgeRevision does not match this harness's own imported revision", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) {
      return {
        ok: true, status: 200,
        json: async () => ({
          ollamaOrigin: "http://127.0.0.1:11434",
          companionBootId: "stale-boot",
          bridgeRevision: "some-older-revision",
          bridgeCapabilities: { jsonSchema: true, structuredModeEcho: false, disconnectCancellation: true, inferenceMetrics: true }
        }),
        text: async () => ""
      };
    }
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({
      devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m", requireJsonSchema: true
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /bridgeRevision/i);
    assert.match(result.reason, /restart/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight without requireJsonSchema does not care whether the bridge has schema capability", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) {
      return { ok: true, status: 200, json: async () => ({ ollamaOrigin: "http://127.0.0.1:11434" }), text: async () => "" };
    }
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m" });
    assert.equal(result.ok, true, "a non-schema benchmark must not be blocked by capability checks it never asked for");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight fails when --ollama-origin does not match the Companion's own configured Ollama", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) return { ok: true, status: 200, json: async () => ({ ollamaOrigin: "http://127.0.0.1:22434" }), text: async () => "" };
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  try {
    const result = await preflight({ devOrigin: "https://localhost:3000", ollamaOrigin: "http://127.0.0.1:11434", model: "m" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed preflight performs zero model calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  globalThis.fetch = async () => { throw new Error("nothing is running"); };
  let runOneCalls = 0;
  try {
    await main(["--iterations", "1"], {
      runOneFn: async () => { runOneCalls += 1; return {}; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
  }
  assert.equal(runOneCalls, 0, "main() must not invoke runOneFn when preflight fails");
});

test("a missing requested model stops the run before any measured call", async () => {
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "a-different-model" }] }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  let runOneCalls = 0;
  try {
    await main(["--model", "tantular-office:lite", "--iterations", "1"], {
      runOneFn: async () => { runOneCalls += 1; return {}; }
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
  }
  assert.equal(runOneCalls, 0, "main() must not invoke runOneFn when the requested model is not installed");
});

// --- main() preflight actually uses the HTTPS-capable router ---------------
// Regression for the reorder bug: preflight must run AFTER installEnvironment
// installs the HTTPS adapter, or the default https://localhost:3000
// preflight would use the raw (HTTPS-incapable) global fetch and fail even
// though httpsFetch itself works fine. Proven end-to-end through main(),
// not just by calling httpsFetch directly.

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startDevServer() {
  return new Promise((resolve, reject) => {
    findFreePort().then((freePort) => {
      const child = spawn(process.execPath, [path.join(root, "tools", "dev-server.mjs")], {
        cwd: root,
        env: { ...process.env, PORT: String(freePort) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`dev-server did not start in time. stdout=${stdout} stderr=${stderr}`));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/dev server: (https?):\/\/localhost:(\d+)/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ child, scheme: match[1], port: Number(match[2]) });
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`dev-server exited early with code ${code}. stdout=${stdout} stderr=${stderr}`));
        }
      });
    }, reject);
  });
}

test("httpsFetch reaches the real dev-server despite its self-signed certificate", async () => {
  const { child, scheme, port } = await startDevServer();
  try {
    if (scheme !== "https") return; // this machine's dev-server had no certs; nothing to prove
    const res = await httpsFetch(`https://localhost:${port}/src/taskpane.html`);
    assert.equal(res.ok, true);
    const body = await res.text();
    assert.match(body, /<html/i);
  } finally {
    child.kill();
  }
});

test("main() successfully preflights the real self-signed dev server end to end (not merely that httpsFetch works alone)", async () => {
  const { child, scheme, port } = await startDevServer();
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  try {
    if (scheme !== "https") return; // nothing to prove without a real cert on this machine

    // Ollama itself is mocked (plain http, unaffected by the HTTPS adapter) —
    // this test is specifically about main() reaching the dev-server through
    // httpsFetch during preflight, not about a real Ollama being present.
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("11434") && (u.includes("/api/tags") || u.includes("/api/ps"))) {
        // Already warm — avoids an extra unmeasured warm-up call, so the
        // measured-call count below reflects exactly one pass through
        // preflight + the single planned run.
        return { ok: true, status: 200, json: async () => ({ models: [{ name: "m" }] }), text: async () => "" };
      }
      if (u.includes("11434")) {
        return { ok: true, status: 200, json: async () => ({ version: "0.1.0" }), text: async () => "" };
      }
      throw new Error(`unexpected mocked fetch to ${u} — only Ollama calls should reach the raw fetch in this test`);
    };

    let runOneCalls = 0;
    await main(
      ["--dev-origin", `https://localhost:${port}`, "--ollama-origin", "http://127.0.0.1:11434", "--model", "m", "--iterations", "1", "--out", tempOut()],
      { runOneFn: async () => { runOneCalls += 1; return { outcome: "success" }; } }
    );
    assert.equal(runOneCalls, 1, "main() must get past preflight (via httpsFetch) and reach the measured call");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    child.kill();
  }
});

// --- --model actually reaches the outbound request --------------------------

test("installEnvironment makes loadSettings() resolve deckModel to --model", async () => {
  const originalLocalStorage = globalThis.localStorage;
  try {
    installEnvironment({ devOrigin: "https://localhost:3000", model: "tantular-office:lite" });
    const stored = JSON.parse(globalThis.localStorage.getItem(SETTINGS_STORAGE_KEY));
    assert.equal(stored.deckModel, "tantular-office:lite");
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});

test("the CLI model is the model actually sent in the outbound chat-completions request body", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  let capturedBody = null;
  // A plain-http dev-origin routes through the real global fetch inside
  // main()'s router (only https:// URLs use the httpsFetch adapter), so it
  // can be mocked directly here to inspect the real request body built by
  // tantularClient.js's buildChatRequestBody — the same body a live run
  // would send.
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/api/diagnostics")) return { ok: true, status: 200, json: async () => ({ ollamaOrigin: "http://127.0.0.1:11434" }), text: async () => "" };
    if (u.includes("11434/api/tags")) return { ok: true, status: 200, json: async () => ({ models: [{ name: "tantular-office:lite" }] }), text: async () => "" };
    if (u.includes("11434")) return { ok: true, status: 200, json: async () => ({ version: "0.1.0" }), text: async () => "" };
    if (u.includes("/api/chat-completions")) {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"title":"x","sections":[]}' } }],
          tantular_metrics: { promptTokens: 1, completionTokens: 2, tokensPerSecond: 3, model: "tantular-office:lite" }
        }),
        text: async () => ""
      };
    }
    if (u.includes("/src/taskpane.html")) return { ok: true, status: 200, json: async () => ({}), text: async () => "<html></html>" };
    throw new Error(`unexpected fetch to ${u}`);
  };
  try {
    await main([
      "--dev-origin", "http://localhost:9999", "--ollama-origin", "http://127.0.0.1:11434",
      "--model", "tantular-office:lite", "--iterations", "1", "--out", tempOut()
    ]);
    assert.ok(capturedBody, "the real chat-completions request must have been made");
    assert.equal(capturedBody.model, "tantular-office:lite",
      "the outbound request body's model must equal --model, not the client's own default");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
  }
});

// --- runOne row shape: model mismatch, load-state, no data leakage ---------

test("runOne flags a model mismatch when the response reports a different actual model", async () => {
  const row = await runOne({
    planDocumentFn: async ({ onMetrics }) => {
      onMetrics({ promptTokens: 1, completionTokens: 2, tokensPerSecond: 3, model: "some-other-model" });
      return { spec: {}, source: "model" };
    },
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "tantular-office:0.5-9b", requestedLoadState: "warm", verifiedLoadState: "warm"
  });
  assert.equal(row.requestedModel, "tantular-office:0.5-9b");
  assert.equal(row.actualModel, "some-other-model");
  assert.equal(row.modelMismatch, true);
});

test("runOne reports no mismatch when actual and requested models agree", async () => {
  const row = await runOne({
    planDocumentFn: async ({ onMetrics }) => {
      onMetrics({ promptTokens: 1, completionTokens: 2, tokensPerSecond: 3, model: "m" });
      return { spec: {}, source: "model" };
    },
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "m", requestedLoadState: "cold", verifiedLoadState: "cold"
  });
  assert.equal(row.modelMismatch, false);
  assert.equal(row.verifiedLoadState, "cold");
});

test("a benchmark row never contains prompt text, response text, or an API key", async () => {
  const fakePlanDocument = async ({ onMetrics }) => {
    onMetrics({ promptTokens: 10, completionTokens: 20, tokensPerSecond: 5, model: "m" });
    return { spec: { title: "x", sections: [] }, source: "model" };
  };
  const row = await runOne({
    planDocumentFn: fakePlanDocument,
    fixture: "short",
    sourceText: FIXTURES.short,
    sectionCount: 3,
    requestedModel: "m",
    requestedLoadState: "warm",
    verifiedLoadState: "warm"
  });
  const serialized = JSON.stringify(row);
  assert.doesNotMatch(serialized, /Pertumbuhan adopsi model bahasa lokal/,
    "the source fixture's text must never appear in a row");
  for (const forbiddenKey of ["apiKey", "prompt", "brief", "content", "response", "messages"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, forbiddenKey), false,
      `row must not carry a "${forbiddenKey}" field`);
  }
  assert.equal(row.outcome, "success");
  assert.equal(row.completionTokens, 20);
});

test("runOne classifies a non-model result as fallback and an AbortError as cancelled", async () => {
  const fallbackRow = await runOne({
    planDocumentFn: async () => ({ spec: {}, source: "fallback" }),
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "m", requestedLoadState: "warm", verifiedLoadState: "warm"
  });
  assert.equal(fallbackRow.outcome, "fallback");

  const cancelledRow = await runOne({
    planDocumentFn: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "m", requestedLoadState: "warm", verifiedLoadState: "warm"
  });
  assert.equal(cancelledRow.outcome, "cancelled");
});

// --- classifyRow / validForStats --------------------------------------------
// A row counts toward any median/p95 ONLY when nothing about it is
// questionable — every individual disqualifying condition must set
// validForStats: false with the matching invalidReason, so an analyst never
// has to remember the exclusion rules themselves.

// Every field a real Ollama response actually produces — deliberately used
// wherever a test needs to represent a genuinely complete, trustworthy row.
const COMPLETE_METRICS = {
  promptTokens: 40, completionTokens: 200, loadDurationMs: 100,
  promptEvalDurationMs: 300, evalDurationMs: 9000, totalDurationMs: 9400,
  tokensPerSecond: 22.2
};

test("a clean success is validForStats with no invalidReason", () => {
  const { validForStats, invalidReason } = classifyRow({
    outcome: "success", modelMismatch: false,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: COMPLETE_METRICS
  });
  assert.equal(validForStats, true);
  assert.equal(invalidReason, null);
});

test("a metrics object missing even one field is treated as missing_metrics, not truthy-therefore-valid", () => {
  // Exactly the case a partial reshape (or an upstream regression) could
  // produce: an object that exists and even carries a model name, but not
  // the numbers a median/p95 actually needs.
  const { validForStats, invalidReason } = classifyRow({
    outcome: "success", modelMismatch: false,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: { model: "tantular-office:0.5-9b" }
  });
  assert.equal(validForStats, false);
  assert.equal(invalidReason, "missing_metrics");

  // Also true for a metrics object with just ONE field short of complete.
  const { validForStats: almostComplete, invalidReason: almostReason } = classifyRow({
    outcome: "success", modelMismatch: false,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: { ...COMPLETE_METRICS, tokensPerSecond: undefined }
  });
  assert.equal(almostComplete, false);
  assert.equal(almostReason, "missing_metrics");
});

test("a fallback outcome is invalid with reason 'fallback'", () => {
  const { validForStats, invalidReason } = classifyRow({
    outcome: "fallback", modelMismatch: false,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: null
  });
  assert.equal(validForStats, false);
  assert.equal(invalidReason, "fallback");
});

test("a timeout/error/cancelled outcome is invalid with reason 'timeout_or_error'", () => {
  for (const outcome of ["timeout_or_error", "cancelled"]) {
    const { validForStats, invalidReason } = classifyRow({
      outcome, modelMismatch: false,
      requestedLoadState: "warm", verifiedLoadState: "warm",
      metrics: null
    });
    assert.equal(validForStats, false, `outcome=${outcome}`);
    assert.equal(invalidReason, "timeout_or_error", `outcome=${outcome}`);
  }
});

test("a model mismatch is invalid with reason 'model_mismatch'", () => {
  const { validForStats, invalidReason } = classifyRow({
    outcome: "success", modelMismatch: true,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: { completionTokens: 5 }
  });
  assert.equal(validForStats, false);
  assert.equal(invalidReason, "model_mismatch");
});

test("an unverified load state is invalid with reason 'unknown_load_state'", () => {
  const { validForStats, invalidReason } = classifyRow({
    outcome: "success", modelMismatch: false,
    requestedLoadState: "cold", verifiedLoadState: "unknown",
    metrics: { completionTokens: 5 }
  });
  assert.equal(validForStats, false);
  assert.equal(invalidReason, "unknown_load_state");
});

test("missing metrics on an otherwise-clean success is invalid with reason 'missing_metrics'", () => {
  const { validForStats, invalidReason } = classifyRow({
    outcome: "success", modelMismatch: false,
    requestedLoadState: "warm", verifiedLoadState: "warm",
    metrics: null
  });
  assert.equal(validForStats, false);
  assert.equal(invalidReason, "missing_metrics");
});

test("runOne's actual row carries validForStats and invalidReason", async () => {
  const cleanRow = await runOne({
    planDocumentFn: async ({ onMetrics }) => {
      onMetrics({ ...COMPLETE_METRICS, model: "m" });
      return { spec: {}, source: "model" };
    },
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "m", requestedLoadState: "warm", verifiedLoadState: "warm"
  });
  assert.equal(cleanRow.validForStats, true);
  assert.equal(cleanRow.invalidReason, null);

  const mismatchedRow = await runOne({
    planDocumentFn: async ({ onMetrics }) => {
      onMetrics({ ...COMPLETE_METRICS, model: "different-model" });
      return { spec: {}, source: "model" };
    },
    fixture: "short", sourceText: FIXTURES.short, sectionCount: 3,
    requestedModel: "m", requestedLoadState: "warm", verifiedLoadState: "warm"
  });
  assert.equal(mismatchedRow.validForStats, false);
  assert.equal(mismatchedRow.invalidReason, "model_mismatch");
});

// --- CLI entrypoint (verified fix: import.meta.url vs process.argv[1]) -----
// Regression for the reported bug: `node tools/benchmark-studio.mjs ...` —
// the exact documented invocation — silently did nothing under this repo's
// path (relative argv[1], and a path containing a literal "&" that
// import.meta.url URL-encodes), exiting 0 with no output file and no error.
// Proven here by actually SPAWNING the script the documented way (not by
// calling the exported main() directly, which would not exercise the
// entrypoint guard at all), against two minimal fake HTTP servers standing
// in for the dev-server and Ollama so no real Companion/model is needed.

function startFakeCompanionAndOllama() {
  const devServer = http.createServer((req, res) => {
    if (req.url === "/src/taskpane.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html></html>");
      return;
    }
    if (req.url === "/api/diagnostics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ollamaOrigin: devServer._fakeOllamaOrigin }));
      return;
    }
    if (req.url === "/api/chat-completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"title":"x","sections":[]}' } }],
        tantular_metrics: {
          promptTokens: 10, completionTokens: 20, loadDurationMs: 5,
          promptEvalDurationMs: 10, evalDurationMs: 100, totalDurationMs: 120,
          tokensPerSecond: 200, model: "test-model"
        }
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const ollama = http.createServer((req, res) => {
    if (req.url === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.1.0-test" }));
      return;
    }
    if (req.url === "/api/tags" || req.url === "/api/ps") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "test-model" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  return { devServer, ollama };
}

test("the documented CLI invocation (spawned, not main() called directly) actually creates an output file", async () => {
  const { devServer, ollama } = startFakeCompanionAndOllama();
  const [devPort, ollamaPort] = await Promise.all([
    new Promise((resolve) => devServer.listen(0, "127.0.0.1", () => resolve(devServer.address().port))),
    new Promise((resolve) => ollama.listen(0, "127.0.0.1", () => resolve(ollama.address().port)))
  ]);
  devServer._fakeOllamaOrigin = `http://127.0.0.1:${ollamaPort}`;
  const outFile = tempOut();

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(root, "tools", "benchmark-studio.mjs"),
        "--dev-origin", `http://127.0.0.1:${devPort}`,
        "--ollama-origin", `http://127.0.0.1:${ollamaPort}`,
        "--model", "test-model",
        "--iterations", "1",
        "--out", outFile
      ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c.toString(); });
      child.stderr.on("data", (c) => { stderr += c.toString(); });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`spawned benchmark did not exit in time. stdout=${stdout} stderr=${stderr}`)); }, 15000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      child.on("error", reject);
    });

    assert.equal(exitCode, 0, "the documented invocation must succeed against a healthy fake Companion/Ollama");
    assert.ok(fs.existsSync(outFile), "the documented invocation must create the --out file — this is exactly the bug: it used to exit 0 and create nothing");
    const lines = fs.readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "one measured iteration must produce exactly one row");
    const row = JSON.parse(lines[0]);
    assert.equal(row.outcome, "success");
    assert.equal(row.requestedModel, "test-model");
  } finally {
    fs.rmSync(outFile, { force: true });
    await Promise.all([
      new Promise((resolve) => devServer.close(resolve)),
      new Promise((resolve) => ollama.close(resolve))
    ]);
  }
});

// --- isMainModule (unit-level, no subprocess) -------------------------------

test("isMainModule matches on resolved filesystem paths, not raw URL/argv strings", async () => {
  const { isMainModule } = await import("../tools/benchmark-studio.mjs");
  const scriptPath = path.join(root, "tools", "benchmark-studio.mjs");
  const metaUrl = `file://${encodeURI(scriptPath).replace(/&/g, "%26")}`;

  // The documented, normal invocation: a RELATIVE argv[1].
  assert.equal(isMainModule(metaUrl, path.relative(process.cwd(), scriptPath)), true);
  // An absolute argv[1] must also match.
  assert.equal(isMainModule(metaUrl, scriptPath), true);
  // A path containing a literal "&" — the exact character import.meta.url
  // URL-encodes, and the exact character that broke the raw string compare
  // in this repo's own directory name.
  assert.equal(isMainModule(`file://${encodeURI("/a & b/script.mjs")}`, "/a & b/script.mjs"), true);
  // A genuinely different script must not match.
  assert.equal(isMainModule(metaUrl, "/some/other/script.mjs"), false);
  // Imported as a module (no argv[1], e.g. under a test runner) must not match.
  assert.equal(isMainModule(metaUrl, undefined), false);
});
