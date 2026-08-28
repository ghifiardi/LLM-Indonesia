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
  // The invariant is that nothing MUTATING executes. The read-only detection
  // probe does run, so that a preflight can report the real machine state.
  assert.ok(scripts.filter((s) => !s.readOnly).every((s) => s.rehearsed),
    "no mutating script may execute in rehearsal");
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

  // The deck length now comes from the live app, not from lastKnown: the
  // slideshow view is read-only, so position and count are read per jump.
  const adapter = new PowerPointAdapter({
    rehearsal: false,
    runner: fakeRunner({
      capabilities: capsProbe("true", "true", "1"),
      "read-position": { ok: true, stdout: "1|8" },
    }),
  });
  const out = await adapter.goto_slide(99);
  assert.equal(out.slide, 8, "clamped to the last slide, never wrapped to 1");
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

// --- rehearsal boundary -----------------------------------------------------

test("only the read-only probe may execute during rehearsal", async () => {
  // Rehearsal exists to stop the bridge MOVING a presentation, not to stop it
  // looking at one — a preflight that observes nothing cannot tell you whether
  // enabling execution is safe. But the exemption must stay confined to
  // observation: any mutating script that acquired readOnly would execute for
  // real while the operator believed nothing could.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../bridge/powerpointAdapter.mjs", import.meta.url), "utf8"));
  const exempted = [...src.matchAll(/readOnly:\s*true/g)];
  assert.equal(exempted.length, 1, "exactly one script may bypass rehearsal");

  // ...and it must be the capabilities probe, not a navigation command.
  const before = src.slice(0, src.indexOf("readOnly: true"));
  assert.match(before.slice(-800), /"capabilities"/, "the exemption must belong to the probe");
  for (const mutating of ["go to next slide", "go to previous slide", "slide show black screen", "run slide show", "exit "]) {
    const at = src.indexOf(mutating);
    if (at < 0) continue;
    const window = src.slice(at, at + 200);
    assert.ok(!window.includes("readOnly"), `${mutating} must never bypass rehearsal`);
  }
});

test("rehearsal still logs navigation without executing it", async () => {
  const adapter = new PowerPointAdapter({ rehearsal: true });
  const out = await adapter.next();
  assert.equal(out.rehearsed, true, "navigation must remain rehearsed");
  const nav = adapter.recentScripts().filter((s) => s.label === "next");
  assert.equal(nav.length, 1);
  assert.equal(nav[0].rehearsed, true);
});

test("capabilities reports the real rehearsal flag, not a hardcoded value", async () => {
  // The preflight must say "execution is disabled" truthfully.
  const runner = fakeRunner({ capabilities: capsProbe("true", "true", "1") });
  const rehearsing = new PowerPointAdapter({ rehearsal: true, runner });
  const caps = await rehearsing.capabilities();
  assert.equal(caps.rehearsal, true);
  assert.equal(caps.running, true, "detection must work while rehearsing");
  assert.equal(caps.inSlideshow, true);
});


// --- verified against live PowerPoint 16.108.1 ------------------------------
// Three scripts written from the docs were rejected by the real application.
// The corrected forms are pinned here because the failure mode is a refusal
// mid-presentation, which is expensive to discover live.

test("blank/resume use the EPPSlideShowState constants the app accepts", async () => {
  // "slide show black screen" is not a constant: PowerPoint answered with a
  // syntax error. The enum is spelled "slide show state ...".
  const adapter = new PowerPointAdapter({ rehearsal: true });
  await adapter.blank();
  await adapter.resume();
  const scripts = adapter.recentScripts().map((s) => s.script).join("\n");
  assert.match(scripts, /slide show state black screen/);
  assert.match(scripts, /slide show state running/);
  assert.ok(!/to slide show black screen/.test(scripts), "the constant-less form was rejected live");
});

test("goto_slide steps, because the slideshow view cannot be positioned", async () => {
  // `go to slide` takes a document view, not a slide show view, and every
  // positional property on slide show view is read-only. Stepping is the only
  // route while presenting.
  const runner = fakeRunner({
    capabilities: capsProbe("true", "true", "1"),
    "read-position": { ok: true, stdout: "1|31" },
  });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  const out = await adapter.goto_slide(6);
  assert.equal(out.slide, 6);
  assert.equal(out.steps, 5);
  const jump = runner.scripts.find((s) => s.label === "goto_slide");
  assert.match(jump.script, /repeat 5 times/);
  assert.match(jump.script, /go to next slide/);
  assert.ok(!/go to slide .* number/.test(jump.script), "the direct jump fails with -50 live");
});

test("a jump backwards steps the other way", async () => {
  const runner = fakeRunner({
    capabilities: capsProbe("true", "true", "1"),
    "read-position": { ok: true, stdout: "6|31" },
  });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  const out = await adapter.goto_slide(2);
  assert.equal(out.steps, 4);
  assert.match(runner.scripts.find((s) => s.label === "goto_slide").script, /go to previous slide/);
});

test("a jump is bounded so a wrong slide count cannot spin the deck", async () => {
  const runner = fakeRunner({
    capabilities: capsProbe("true", "true", "1"),
    "read-position": { ok: true, stdout: "1|100000" },
  });
  const adapter = new PowerPointAdapter({ rehearsal: false, runner });
  const out = await adapter.goto_slide(99999);
  assert.equal(out.refused, true);
  assert.equal(out.reason, "too-many-steps");
  assert.ok(!runner.scripts.some((s) => s.label === "goto_slide"), "nothing may be sent past the guard");
});

test("end uses the exit slide show command, not a bare exit", async () => {
  // `exit <view>` parsed as the command plus a stray parameter and failed.
  const adapter = new PowerPointAdapter({ rehearsal: true });
  await adapter.end();
  assert.match(adapter.recentScripts().at(-1).script, /exit slide show \(slide show view of slide show window 1\)/);
});
