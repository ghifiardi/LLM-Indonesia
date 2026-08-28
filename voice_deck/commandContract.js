// Transport-neutral command contract shared by the web deck adapter today,
// and by future native PowerPoint/Keynote adapters (see
// NATIVE_POWERPOINT_KEYNOTE_ROADMAP.md). Any UI, speech recognizer, or LLM
// intent router should only ever emit objects that pass validateCommand().

export const CONTRACT_VERSION = 1;

export const ACTIONS = Object.freeze([
  "next",
  "previous",
  "goto_slide",
  "goto_topic",
  "show_notes",
  "hide_notes",
  "blank",
  "resume",
  "start",
  "end",
  "noop",
]);

export const SOURCES = Object.freeze(["voice", "text", "keyboard", "button"]);

// Fields each action may carry, beyond the always-present
// version/action/source/confidence/transcript.
const ACTION_FIELDS = Object.freeze({
  next: [],
  previous: [],
  goto_slide: ["slide"],
  goto_topic: ["query"],
  show_notes: [],
  hide_notes: [],
  blank: [],
  resume: [],
  start: [],
  end: [],
  noop: [],
});

export class CommandValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "CommandValidationError";
    this.details = details || null;
  }
}

// Build a normalized command object, stripping any fields the given action
// does not use. Does not validate — call validateCommand() on the result.
export function createCommand(fields) {
  const { action, slide, query, source, confidence, transcript } = fields || {};

  const command = {
    version: CONTRACT_VERSION,
    action,
    source,
    confidence: typeof confidence === "number" ? confidence : 1,
  };

  if (typeof transcript === "string" && transcript.length > 0) {
    command.transcript = transcript;
  }

  const allowed = ACTION_FIELDS[action] || [];
  if (allowed.includes("slide") && slide !== undefined) {
    command.slide = slide;
  }
  if (allowed.includes("query") && query !== undefined) {
    command.query = query;
  }

  return command;
}

// Validate a command object against the contract. Returns {ok:true} or
// {ok:false, error}. Never throws — callers decide how to react (e.g. show a
// HUD error and fall back to noop) rather than crash the presentation.
export function validateCommand(command) {
  if (!command || typeof command !== "object") {
    return { ok: false, error: "command must be an object" };
  }
  if (command.version !== CONTRACT_VERSION) {
    return { ok: false, error: `unsupported version: ${command.version}` };
  }
  if (!ACTIONS.includes(command.action)) {
    return { ok: false, error: `unknown action: ${command.action}` };
  }
  if (!SOURCES.includes(command.source)) {
    return { ok: false, error: `unknown source: ${command.source}` };
  }
  if (
    typeof command.confidence !== "number" ||
    Number.isNaN(command.confidence) ||
    command.confidence < 0 ||
    command.confidence > 1
  ) {
    return { ok: false, error: "confidence must be a number in [0,1]" };
  }

  if (command.action === "goto_slide") {
    if (!Number.isInteger(command.slide) || command.slide < 1) {
      return { ok: false, error: "goto_slide requires a positive integer slide" };
    }
  }
  if (command.action === "goto_topic") {
    if (typeof command.query !== "string" || command.query.trim().length === 0) {
      return { ok: false, error: "goto_topic requires a non-empty query" };
    }
  }

  const allowed = new Set([
    "version",
    "action",
    "source",
    "confidence",
    "transcript",
    ...(ACTION_FIELDS[command.action] || []),
  ]);
  const extra = Object.keys(command).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return { ok: false, error: `unexpected fields for ${command.action}: ${extra.join(", ")}` };
  }

  return { ok: true };
}

// All current actions are navigation-only. Reserved for future native
// adapters where PowerPoint/Keynote document-editing actions would need an
// explicit confirm gate before dispatch (see tantular-ppt-chat-safety
// lessons: a single unconfirmed write once rewrote 7 slides in that add-in).
export function isDestructiveAction(_action) {
  return false;
}
