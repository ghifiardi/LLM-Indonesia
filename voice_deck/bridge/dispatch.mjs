// Validate, then dispatch. Never the other way round.
//
// The bridge is the last checkpoint before something drives a live
// presentation, so a command is re-validated here even though the web deck
// already validated it on the way out: the deck is not the only thing that can
// POST to this port.
import { validateCommand } from "../commandContract.js";

// action -> adapter method. Dispatch knows the CONTRACT, never an application:
// adding Keynote must not require editing this file.
const ACTION_METHOD = Object.freeze({
  next: (a) => a.next(),
  previous: (a) => a.previous(),
  goto_slide: (a, c) => a.goto_slide(c.slide),
  goto_topic: (a, c) => a.goto_topic(c.query),
  show_notes: (a) => a.apply?.({ action: "show_notes" }) ?? { ok: true, effect: "show_notes" },
  hide_notes: (a) => a.apply?.({ action: "hide_notes" }) ?? { ok: true, effect: "hide_notes" },
  blank: (a) => a.blank(),
  resume: (a) => a.resume(),
  start: (a) => a.start(),
  end: (a) => a.end(),
  noop: () => ({ ok: true, effect: "noop" }),
});

export const MAX_BODY_BYTES = 16 * 1024;

export async function dispatchCommand(adapter, payload) {
  const result = validateCommand(payload);
  if (!result.ok) {
    return { status: 400, body: { ok: false, error: result.error } };
  }
  const invoke = ACTION_METHOD[payload.action];
  if (!invoke) {
    return { status: 400, body: { ok: false, error: `no dispatch for action: ${payload.action}` } };
  }
  try {
    const outcome = await invoke(adapter, payload);
    if (!outcome?.ok) {
      // A refusal is a deliberate, reportable outcome — the fail-safe rule —
      // and must never be flattened into a generic error or a false success.
      return {
        status: 422,
        body: {
          ok: false,
          refused: Boolean(outcome?.refused),
          error: outcome?.reason || outcome?.error || "adapter refused",
          detail: outcome?.detail,
        },
      };
    }
    const state = await adapter.state();
    return { status: 200, body: { ok: true, ...outcome, state } };
  } catch (error) {
    // An adapter fault must not take the bridge down mid-presentation.
    return { status: 500, body: { ok: false, error: `adapter failed: ${error.message}` } };
  }
}

// Parse a request body without trusting Content-Length. An oversized or
// malformed body is a client error, not a reason to buffer without bound.
export function parseBody(raw) {
  if (raw.length > MAX_BODY_BYTES) {
    return { ok: false, error: `body too large (max ${MAX_BODY_BYTES} bytes)` };
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` };
  }
}
