// N1 adapter: records what a native adapter WOULD do, and drives nothing.
//
// Deliberately inert. No AppleScript, no osascript, no child process. The point
// of N1 is to prove the transport, the contract and the authentication before
// asking macOS for Automation permission over Keynote/PowerPoint — because
// once a real adapter exists, a malformed command stops being a log line and
// starts rearranging someone's live deck.
//
// N2 replaces this with per-application adapters exposing the same methods.

export class DryRunAdapter {
  // NOTE: the live snapshot is `current`, not `state` — `state()` is the
  // interface method, and a data property of the same name silently shadows it.
  constructor({ slideCount = 0, now = () => Date.now(), logLimit = 200 } = {}) {
    this.name = "dry-run";
    this.slideCount = slideCount;
    this.now = now;
    this.logLimit = logLimit;
    this.log = [];
    this.current = {
      slide: 1,
      blanked: false,
      notesVisible: false,
      presenting: false,
    };
  }

  _record(action, detail = {}) {
    this.log.push({ at: this.now(), action, ...detail });
    // Bounded: a bridge left running through a rehearsal must not grow without
    // limit just because it is only "logging".
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }

  // Clamp rather than wrap: running off the end of a deck mid-talk should stop
  // at the last slide, not jump to the first.
  _setSlide(target) {
    const upper = this.slideCount > 0 ? this.slideCount : Number.MAX_SAFE_INTEGER;
    this.current.slide = Math.min(Math.max(1, target), upper);
    return this.current.slide;
  }

  apply(command) {
    switch (command.action) {
      case "next":
        return this._moved("next", this._setSlide(this.current.slide + 1));
      case "previous":
        return this._moved("previous", this._setSlide(this.current.slide - 1));
      case "goto_slide":
        return this._moved("goto_slide", this._setSlide(command.slide));
      case "goto_topic":
        // A dry run cannot resolve a topic: only the live application knows
        // what is on each slide. Record the query verbatim so N2 can compare
        // its resolution against what was actually asked for.
        this._record("goto_topic", { query: command.query, resolved: null });
        return { ok: true, effect: "goto_topic", query: command.query, resolved: null };
      case "show_notes":
      case "hide_notes": {
        this.current.notesVisible = command.action === "show_notes";
        this._record(command.action, { notesVisible: this.current.notesVisible });
        return { ok: true, effect: command.action, notesVisible: this.current.notesVisible };
      }
      case "blank":
      case "resume": {
        this.current.blanked = command.action === "blank";
        this._record(command.action, { blanked: this.current.blanked });
        return { ok: true, effect: command.action, blanked: this.current.blanked };
      }
      case "start":
      case "end": {
        this.current.presenting = command.action === "start";
        if (command.action === "start") this._setSlide(1);
        this._record(command.action, { presenting: this.current.presenting });
        return { ok: true, effect: command.action, presenting: this.current.presenting };
      }
      case "noop":
        this._record("noop");
        return { ok: true, effect: "noop" };
      default:
        // Unreachable while dispatch validates first; kept so a future action
        // added to the contract fails loudly here instead of silently doing
        // nothing on a real presentation.
        return { ok: false, error: `adapter cannot perform: ${command.action}` };
    }
  }

  _moved(effect, slide) {
    this._record(effect, { slide });
    return { ok: true, effect, slide };
  }

  // --- shared adapter interface -------------------------------------------
  // Implemented by delegating to apply(), so the dry run and the native
  // adapters present the same surface to dispatch and Keynote can drop in
  // later without the bridge learning anything about any application.
  async capabilities() {
    return {
      adapter: this.name, rehearsal: true,
      running: true, frontmost: true, inSlideshow: this.current.presenting,
      permission: "granted", reason: "dry run — nothing is driven",
    };
  }
  async state() { return this.getState(); }
  async next() { return this.apply({ action: "next" }); }
  async previous() { return this.apply({ action: "previous" }); }
  async goto_slide(slide) { return this.apply({ action: "goto_slide", slide }); }
  async goto_topic(query) { return this.apply({ action: "goto_topic", query }); }
  async blank() { return this.apply({ action: "blank" }); }
  async resume() { return this.apply({ action: "resume" }); }
  async start() { return this.apply({ action: "start" }); }
  async end() { return this.apply({ action: "end" }); }

  getState() {
    return { adapter: this.name, slideCount: this.slideCount, ...this.current };
  }

  recentLog(limit = 20) {
    return this.log.slice(-limit);
  }
}
