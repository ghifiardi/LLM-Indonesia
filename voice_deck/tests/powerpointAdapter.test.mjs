import test from "node:test";
import assert from "node:assert/strict";
import { PowerPointAdapter } from "../bridge/powerpointAdapter.mjs";
import { DryRunAdapter } from "../bridge/dryRunAdapter.mjs";
import { createAdapter, ADAPTERS, DEFAULT_ADAPTER } from "../bridge/adapterFactory.mjs";
import { implementsAdapterInterface, clampSlide, ADAPTER_METHODS } from "../bridge/adapterInterface.mjs";
import { asLiteral } from "../bridge/applescript.mjs";

// A runner that never touches macOS: returns whatever the test dictates and
// records the scripts it was asked to run.
function fakeRunner(responses = {}) {
  const scripts = [];
  return {
    scripts,
    rehearsal: false,
    async run(label, script) {
      scripts.push({ label, script });
      const reply = responses[label];
      if (typeof reply === "function") return reply(script);
      return reply ?? { ok: true, stdout: "", script };
    },
    recentScripts: () => scripts,
  };
}
const capsProbe = (running, front, shows) => ({ ok: true, stdout: `${running}|${front}|${shows}` });

test("both adapters implement the same interface", () => {
  // Keynote must drop in later without the bridge learning about any app.
  assert.equal(implementsAdapterInterface(new DryRunAdapter()), true);
  assert.equal(implementsAdapterInterface(new PowerPointAdapter()), true);
  assert.equal(implementsAdapterInterface({ next: () => {} }), false);
  for (const m of ["capabilities", "state", "next", "previous", "goto_slide", "goto_topic", "blank", "resume", "start", "end"]) {
    assert.ok(ADAPTER_METHODS.includes(m), `${m} must be in the shared surface`);
  }
});

test("adapter selection defaults to the inert adapter", () => {
  assert.equal(DEFAULT_ADAPTER, "dry-run");
  assert.equal(createAdapter().adapter.name, "dry-run");
  assert.equal(createAdapter(undefined).adapter.name, "dry-run");
});

test("an unknown adapter name fails loudly and never falls back to a live app", () => {
  // A typo must not silently start driving PowerPoint.
  const out = createAdapter("powerpiont");
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown adapter/);
  assert.ok(ADAPTERS.includes("keynote"), "keynote is declared in the contract");
  assert.equal(createAdapter("keynote").ok, false, "declared but not built until N2.5");
});

test("powerpoint is selected in rehearsal unless execution is chosen", () => {
  assert.equal(createAdapter("powerpoint").adapter.rehearsal, true);
  assert.equal(createAdapter("powerpoint", { rehearsal: false }).adapter.rehearsal, false);
});

test("rehearsal builds the script and executes nothing", async () => {
  const adapter = new PowerPointAdapter({ rehearsal: true });
  const out = await adapter.next();
  assert.equal(out.ok, true);
  assert.equal(out.rehearsed, true);
  const scripts = adapter.recentScripts();
  assert.match(scripts.at(-1).script, /go to next slide slide show view of slide show window 1/);
  assert.ok(scripts.every((s) => s.rehearsed), "nothing may execute in rehearsal");
});

// --- the fail-safe rule -----------------------------------------------------

test("it refuses when PowerPoint is not running", async () => {
  const adapter = new PowerPointAdapter({ rehearsal: false, runner: fakeRunner({ capabilities: capsProbe("false", "false", "0") }) });
  const out = await adapter.next();
  assert.equal(out.ok, false);
  assert.equal(out.refused, true);
  assert.equal(out.reason, "app-not-running");
});

test("it refuses when open but NOT presenting — no stray keystrokes", async () => {
  // The dangerous case: PowerPoint is frontmost in edit view. A "next"
  // delivered there is an edit to someone's document, not a no-op.
  const runner = fakeRunner({ capabilities: capsProbe("true", "true", "0") });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  const out = await adapter.next();
  assert.equal(out.refused, true);
  assert.equal(out.reason, "no-slideshow");
  assert.equal(runner.scripts.filter((s) => s.label === "next").length, 0,
    "no navigation script may be sent without a confirmed slideshow");
});

test("denied Automation permission is reported with the fix, not as a crash", async () => {
  const adapter = new PowerPointAdapter({
    rehearsal: false,
    runner: fakeRunner({ capabilities: { ok: false, error: "-1743 not authorized", permission: "denied" } }),
  });
  const out = await adapter.next();
  assert.equal(out.reason, "automation-permission-denied");
  assert.match(out.detail, /System Settings/);
});

test("goto_slide clamps and never wraps", async () => {
  assert.equal(clampSlide(99, 8), 8);
  assert.equal(clampSlide(0, 8), 1);
  assert.equal(clampSlide(-5, 8), 1);
  assert.equal(clampSlide(3, 0), 3, "unknown deck length must not clamp to nothing");

  const adapter = new PowerPointAdapter({ rehearsal: false, runner: fakeRunner({ capabilities: capsProbe("true", "true", "1") }) });
  adapter.lastKnown.slideCount = 8;
  const out = await adapter.goto_slide(99);
  assert.equal(out.slide, 8);
});

test("goto_topic resolves against the LIVE app, and refuses when absent", async () => {
  const runner = fakeRunner({
    capabilities: capsProbe("true", "true", "1"),
    "read-titles": { ok: true, stdout: "Intro\nRollout & Pricing\nThank You" },
  });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  const hit = await adapter.goto_topic("pricing");
  assert.equal(hit.ok, true);
  assert.equal(hit.slide, 2, "matched against the app's own slide titles");

  const miss = await adapter.goto_topic("keamanan");
  assert.equal(miss.refused, true);
  assert.equal(miss.reason, "topic-not-found");
});

test("a query that could break out of a script literal is refused", async () => {
  // The query comes from speech. It is matched, never executed, so refusing
  // quotes and backslashes outright loses nothing and closes the injection.
  assert.equal(asLiteral('say "hi"').ok, false);
  assert.equal(asLiteral("back\\slash").ok, false);
  assert.equal(asLiteral("harga").ok, true);

  const adapter = new PowerPointAdapter({ rehearsal: false, runner: fakeRunner() });
  const out = await adapter.goto_topic('" & (do shell script "id") & "');
  assert.equal(out.refused, true);
  assert.equal(out.reason, "unsafe-query");
});

test("capabilities does not launch PowerPoint just to ask if it is running", async () => {
  const runner = fakeRunner({ capabilities: capsProbe("false", "false", "0") });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  await adapter.capabilities();
  const script = runner.scripts[0].script;
  assert.match(script, /System Events/, "the non-launching probe form");
  assert.ok(!/^tell application "Microsoft PowerPoint"/m.test(script.split("\n")[0]),
    "a bare tell would start PowerPoint on a machine where it was closed");
});
