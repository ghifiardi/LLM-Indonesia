// Microsoft PowerPoint adapter (N2), macOS, via AppleScript.
//
// Rehearsal by default: it builds the exact script and logs it without
// running anything. Executing is an explicit choice, because the first real
// run moves a presentation someone may be standing in front of.
//
// Fail-safe rule, enforced in one place (_target): if the adapter cannot
// confirm a slideshow window to talk to, it does nothing and reports why. It
// never falls back to keystrokes aimed at whatever is frontmost — a stray
// "next" delivered to a document window is an edit, not a no-op.
import { ScriptRunner, asLiteral } from "./applescript.mjs";
import { refuse, performed, clampSlide } from "./adapterInterface.mjs";

const APP = "Microsoft PowerPoint";

// One slideshow view expression, used by every navigation command, so a fix
// here cannot be applied inconsistently.
const VIEW = `slide show view of slide show window 1`;

export class PowerPointAdapter {
  constructor({ rehearsal = true, runner, timeoutMs = 5000 } = {}) {
    this.name = "powerpoint";
    this.rehearsal = rehearsal;
    this.runner = runner || new ScriptRunner({ rehearsal, timeoutMs });
    this.lastKnown = { slide: null, slideCount: null, blanked: false, presenting: false };
  }

  async _tell(label, body) {
    return this.runner.run(label, `tell application "${APP}"\n${body}\nend tell`);
  }

  async capabilities() {
    // Asking "is it running?" must not LAUNCH it. `application ... is running`
    // via System Events is the non-launching form; `tell application "X"` on
    // its own would start PowerPoint on a machine that had it closed.
    // Read-only, so it runs in rehearsal too: the preflight must be able to
    // report what is actually on the machine before execution is enabled.
    const probe = await this.runner.run(
      "capabilities",
      `tell application "System Events"\n`
      + `  set isRunning to (exists (processes where name is "${APP}"))\n`
      + `  set isFront to false\n`
      + `  if isRunning then set isFront to (name of first process whose frontmost is true) is "${APP}"\n`
      + `end tell\n`
      + `set showCount to 0\n`
      + `if isRunning then\n`
      + `  tell application "${APP}" to set showCount to count of slide show windows\n`
      + `end if\n`
      + `return (isRunning as text) & "|" & (isFront as text) & "|" & (showCount as text)`,
      { readOnly: true }
    );

    if (probe.rehearsed) {
      // Only reachable with a stubbed runner; the real probe is read-only.
      return {
        adapter: this.name, rehearsal: this.rehearsal,
        running: false, frontmost: false, inSlideshow: false,
        permission: "unknown",
        reason: "probe not executed",
      };
    }
    if (!probe.ok) {
      return {
        adapter: this.name, rehearsal: this.rehearsal,
        running: false, frontmost: false, inSlideshow: false,
        permission: probe.permission || "unknown",
        reason: probe.error,
      };
    }
    const [running, frontmost, shows] = String(probe.stdout).split("|");
    return {
      adapter: this.name, rehearsal: this.rehearsal,
      running: running === "true",
      frontmost: frontmost === "true",
      inSlideshow: Number(shows) > 0,
      permission: "granted",
    };
  }

  // Every navigating command passes through here first.
  async _target() {
    const caps = await this.capabilities();
    if (caps.rehearsal) return { ok: true, caps };
    if (caps.permission === "denied") {
      return {
        ok: false,
        result: refuse("automation-permission-denied", {
          detail: `Grant Automation access for ${APP} in System Settings → Privacy & Security → Automation.`,
        }),
      };
    }
    if (!caps.running) return { ok: false, result: refuse("app-not-running", { detail: `${APP} is not open.` }) };
    if (!caps.inSlideshow) {
      return {
        ok: false,
        result: refuse("no-slideshow", {
          detail: `${APP} is open but not presenting. Start the slideshow first — refusing to send keystrokes to a document window.`,
        }),
      };
    }
    return { ok: true, caps };
  }

  async _navigate(label, body, effect, detail = {}) {
    const target = await this._target();
    if (!target.ok) return target.result;
    const run = await this._tell(label, body);
    if (!run.ok) return refuse("script-failed", { detail: run.error, permission: run.permission });
    return performed(effect, { rehearsed: Boolean(run.rehearsed), ...detail });
  }

  next() { return this._navigate("next", `go to next slide ${VIEW}`, "next"); }
  previous() { return this._navigate("previous", `go to previous slide ${VIEW}`, "previous"); }

  async goto_slide(n) {
    const count = this.lastKnown.slideCount;
    const slide = clampSlide(n, count ?? 0);
    return this._navigate("goto_slide", `go to slide ${VIEW} number ${slide}`, "goto_slide", { slide });
  }

  // The live document is the source of truth for what is on each slide, so the
  // titles are read from PowerPoint rather than from the deck's slides.json.
  async goto_topic(query) {
    const literal = asLiteral(String(query || "").toLowerCase());
    if (!literal.ok) return refuse("unsafe-query", { detail: literal.error });

    const target = await this._target();
    if (!target.ok) return target.result;

    const read = await this._tell(
      "read-titles",
      `set out to ""\n`
      + `repeat with s in slides of active presentation\n`
      + `  set t to ""\n`
      + `  try\n`
      + `    set t to content of text range of text frame of shape 1 of s\n`
      + `  end try\n`
      + `  set out to out & t & "\\n"\n`
      + `end repeat\n`
      + `return out`
    );
    if (!read.ok) return refuse("script-failed", { detail: read.error, permission: read.permission });
    if (read.rehearsed) return performed("goto_topic", { rehearsed: true, query, resolved: null });

    const titles = String(read.stdout).split("\n").map((t) => t.trim());
    const needle = String(query).toLowerCase();
    const index = titles.findIndex((t) => t.toLowerCase().includes(needle));
    if (index < 0) {
      // Refusing beats jumping somewhere plausible: a wrong slide in front of
      // an audience is worse than an unchanged one.
      return refuse("topic-not-found", { detail: `No slide title contains "${query}".`, query });
    }
    return this.goto_slide(index + 1);
  }

  blank() { return this._navigate("blank", `set slide state of ${VIEW} to slide show black screen`, "blank", { blanked: true }); }
  resume() { return this._navigate("resume", `set slide state of ${VIEW} to slide show running`, "resume", { blanked: false }); }

  async start() {
    const caps = await this.capabilities();
    if (!caps.rehearsal && caps.permission === "denied") {
      return refuse("automation-permission-denied", {
        detail: `Grant Automation access for ${APP} in System Settings → Privacy & Security → Automation.`,
      });
    }
    if (!caps.rehearsal && !caps.running) return refuse("app-not-running", { detail: `${APP} is not open.` });
    const run = await this._tell("start", `run slide show slide show settings of active presentation`);
    if (!run.ok) return refuse("script-failed", { detail: run.error, permission: run.permission });
    return performed("start", { rehearsed: Boolean(run.rehearsed), presenting: true });
  }

  async end() {
    const target = await this._target();
    if (!target.ok) return target.result;
    const run = await this._tell("end", `exit ${VIEW}`);
    if (!run.ok) return refuse("script-failed", { detail: run.error, permission: run.permission });
    return performed("end", { rehearsed: Boolean(run.rehearsed), presenting: false });
  }

  async state() {
    const caps = await this.capabilities();
    return { adapter: this.name, rehearsal: this.rehearsal, ...caps, lastKnown: this.lastKnown };
  }

  recentScripts(limit = 20) { return this.runner.recentScripts(limit); }
}
