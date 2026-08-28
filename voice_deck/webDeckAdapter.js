// Web presentation adapter: applies validated normalized commands
// (commandContract.js) to an in-memory deck state. This is the "web" leg of
// the transport-neutral command layer -- a future PowerPointAdapter/
// KeynoteAdapter implements the same apply(command) surface against a native
// app instead of DOM state (see NATIVE_POWERPOINT_KEYNOTE_ROADMAP.md).

import { validateCommand } from "./commandContract.js";
import { matchTopic } from "./topicMatcher.js";

export class WebDeckAdapter {
  constructor(deck, { onChange, topicMatch = {} } = {}) {
    this.deck = deck;
    this.slides = deck.slides;
    this.topicMatchOptions = topicMatch;
    this.onChange = onChange || (() => {});

    this.state = {
      currentSlide: 1,
      totalSlides: this.slides.length,
      notesVisible: false,
      blanked: false,
      started: false,
      ended: false,
    };
  }

  getState() {
    return { ...this.state };
  }

  getSlide(number = this.state.currentSlide) {
    return this.slides.find((s) => s.id === number) || null;
  }

  emit() {
    this.onChange(this.getState());
  }

  // Apply a normalized command (re-validated here -- the adapter never
  // trusts its caller). Returns {ok, message}.
  apply(command) {
    const result = validateCommand(command);
    if (!result.ok) {
      return { ok: false, message: `rejected: ${result.error}` };
    }

    switch (command.action) {
      case "next":
        return this.next();
      case "previous":
        return this.previous();
      case "goto_slide":
        return this.gotoSlide(command.slide);
      case "goto_topic":
        return this.gotoTopic(command.query);
      case "show_notes":
        return this.showNotes();
      case "hide_notes":
        return this.hideNotes();
      case "blank":
        return this.blank();
      case "resume":
        return this.resume();
      case "start":
        return this.start();
      case "end":
        return this.end();
      case "noop":
        return { ok: true, message: "noop" };
      default:
        return { ok: false, message: `unhandled action: ${command.action}` };
    }
  }

  next() {
    if (this.state.currentSlide >= this.state.totalSlides) {
      return { ok: false, message: "already at last slide" };
    }
    this.state.currentSlide += 1;
    this.state.blanked = false;
    this.emit();
    return { ok: true, message: `slide ${this.state.currentSlide}` };
  }

  previous() {
    if (this.state.currentSlide <= 1) {
      return { ok: false, message: "already at first slide" };
    }
    this.state.currentSlide -= 1;
    this.state.blanked = false;
    this.emit();
    return { ok: true, message: `slide ${this.state.currentSlide}` };
  }

  gotoSlide(number) {
    if (number < 1 || number > this.state.totalSlides) {
      return { ok: false, message: `slide ${number} out of range (1-${this.state.totalSlides})` };
    }
    this.state.currentSlide = number;
    this.state.blanked = false;
    this.emit();
    return { ok: true, message: `slide ${number}` };
  }

  gotoTopic(query) {
    const match = matchTopic(query, this.slides, this.topicMatchOptions);
    if (match === null) {
      return { ok: false, message: `no slide matched "${query}"` };
    }
    return this.gotoSlide(match);
  }

  showNotes() {
    this.state.notesVisible = true;
    this.emit();
    return { ok: true, message: "notes shown" };
  }

  hideNotes() {
    this.state.notesVisible = false;
    this.emit();
    return { ok: true, message: "notes hidden" };
  }

  blank() {
    this.state.blanked = true;
    this.emit();
    return { ok: true, message: "screen blanked" };
  }

  resume() {
    this.state.blanked = false;
    this.emit();
    return { ok: true, message: "screen resumed" };
  }

  start() {
    this.state.started = true;
    this.state.ended = false;
    this.state.blanked = false;
    this.state.currentSlide = 1;
    this.emit();
    return { ok: true, message: "presentation started" };
  }

  end() {
    this.state.ended = true;
    this.state.blanked = true;
    this.emit();
    return { ok: true, message: "presentation ended" };
  }
}
