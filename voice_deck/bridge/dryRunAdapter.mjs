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
  constructor({ slideCount = 0, now = () => Date.now(), logLimit = 200 } = {}) {
    this.name = "dry-run";
    this.slideCount = slideCount;
    this.now = now;
    this.logLimit = logLimit;
    this.log = [];
    this.state = {
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
    this.state.slide = Math.min(Math.max(1, target), upper);
    return this.state.slide;
  }

  apply(command) {
    switch (command.action) {
      case "next":
        return this._moved("next", this._setSlide(this.state.slide + 1));
      case "previous":
        return this._moved("previous", this._setSlide(this.state.slide - 1));
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
        this.state.notesVisible = command.action === "show_notes";
        this._record(command.action, { notesVisible: this.state.notesVisible });
        return { ok: true, effect: command.action, notesVisible: this.state.notesVisible };
      }
      case "blank":
      case "resume": {
        this.state.blanked = command.action === "blank";
        this._record(command.action, { blanked: this.state.blanked });
        return { ok: true, effect: command.action, blanked: this.state.blanked };
      }
      case "start":
      case "end": {
        this.state.presenting = command.action === "start";
        if (command.action === "start") this._setSlide(1);
        this._record(command.action, { presenting: this.state.presenting });
        return { ok: true, effect: command.action, presenting: this.state.presenting };
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

  getState() {
    return { adapter: this.name, slideCount: this.slideCount, ...this.state };
  }

  recentLog(limit = 20) {
    return this.log.slice(-limit);
  }
}
