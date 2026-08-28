// Validate, then dispatch. Never the other way round.
//
// The bridge is the last checkpoint before something drives a live
// presentation, so a command is re-validated here even though the web deck
// already validated it on the way out: the deck is not the only thing that can
// POST to this port.
import { validateCommand } from "../commandContract.js";

export const MAX_BODY_BYTES = 16 * 1024;

export function dispatchCommand(adapter, payload) {
  const result = validateCommand(payload);
  if (!result.ok) {
    return { status: 400, body: { ok: false, error: result.error } };
  }
  try {
    const outcome = adapter.apply(payload);
    if (!outcome?.ok) {
      return { status: 422, body: { ok: false, error: outcome?.error || "adapter refused" } };
    }
    return { status: 200, body: { ok: true, ...outcome, state: adapter.getState() } };
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
