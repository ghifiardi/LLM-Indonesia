// The surface every presentation adapter implements.
//
// Written before the second adapter exists, on purpose: PowerPoint is the
// primary target and Keynote follows, and the dispatch layer must not learn
// anything about either. If adding Keynote requires touching the bridge, the
// voice layer, the intent router or the command contract, this interface was
// wrong.
//
// Every method returns a plain object. None of them throw for an expected
// condition — "PowerPoint is not running" is an answer, not an exception.

/**
 * @typedef {Object} AdapterCapabilities
 * @property {string} adapter          "dry-run" | "powerpoint" | "keynote"
 * @property {boolean} running         the application is open
 * @property {boolean} frontmost       it is the active application
 * @property {boolean} inSlideshow     a slideshow window exists
 * @property {"granted"|"denied"|"unknown"} permission  macOS Automation status
 * @property {boolean} rehearsal       true = log the script, execute nothing
 * @property {string} [reason]         why a capability is false
 */

export const ADAPTER_METHODS = Object.freeze([
  "capabilities", "state",
  "next", "previous", "goto_slide", "goto_topic",
  "blank", "resume",
  "start", "end",
]);

/**
 * A refusal, not a failure. The fail-safe rule for every adapter: if it cannot
 * confirm a safe slideshow target, it does nothing and says why. It must never
 * guess, and must never send stray keystrokes at whatever happens to be
 * frontmost — a "next slide" delivered to the wrong window is a keystroke into
 * someone's document.
 */
export function refuse(reason, detail = {}) {
  return { ok: false, refused: true, reason, ...detail };
}

export function performed(effect, detail = {}) {
  return { ok: true, effect, ...detail };
}

/** Structural check used by tests and by adapter selection. */
export function implementsAdapterInterface(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  return ADAPTER_METHODS.every((method) => typeof candidate[method] === "function");
}

// Clamp, never wrap. Running off the end of a deck mid-talk should stop at the
// last slide; wrapping to slide 1 in front of an audience reads as a fault.
export function clampSlide(target, count) {
  const upper = count > 0 ? count : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(1, Math.trunc(target)), upper);
}
