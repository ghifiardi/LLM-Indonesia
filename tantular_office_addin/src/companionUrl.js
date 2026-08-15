// Resolve model/companion APIs across the contexts this pane runs in.
//
// 1. Dev (served from localhost:3000)      → relative path, same origin.
// 2. Installed Office add-in, mode "local"  → https://localhost:3000, the user's
//    own trusted companion. Their document text never leaves the machine.
// 3. Installed Office add-in, mode "cloud"  → same-origin /api/*, the hosted
//    gateway, so a workshop attendee can run with NOTHING installed. The user
//    must have chosen this explicitly, inside Office (see loadMode).
// 4. Portal in a plain browser (no Office)  → same-origin /api/*, a hosted
//    gateway, so someone can try Tantular with nothing installed.
//
// Case 2 vs 3/4 is the line that matters. Every case loads the identical hosted
// page, so the ONLY things separating "stays on your machine" from "sent to a
// server" are the Office.js check below and a recorded, deliberate user choice.
// Getting it wrong would silently ship an installed user's deck to a gateway
// while the product still claimed to be local-only — so this branches on
// Office.js being genuinely present, plus a consent record that a stale value
// leaked in from portal use can never impersonate.

export const DEFAULT_MODE = "local";
const MODE_KEY = "tantular.office.mode.v1";

export function insideOffice() {
  // Office.js sets Office.context.host when a real host loaded the pane. The
  // browser preview path never has it, and neither does a page opened by hand.
  return Boolean(globalThis.Office?.context?.host);
}

export function isPortalMode() {
  const hostname = String(
    globalThis.location?.hostname
    || globalThis.window?.location?.hostname
    || ""
  ).toLowerCase();
  const local = !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return !local && !insideOffice();
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

// The mode lives in its OWN localStorage key, not in the settings blob, and the
// record carries `chosenInOffice`. That is what separates "the user deliberately
// asked for cloud, from inside Office" from "portal use left something behind in
// the shared origin's localStorage": only the in-pane toggle, running with
// Office.js actually loaded, can write chosenInOffice:true. Anything else — a
// portal-written record, a hand-edited value, a legacy plain string — is read as
// local when we are inside Office. Fail-closed by construction.
export function loadMode() {
  const ls = safeLocalStorage();
  if (!ls) return DEFAULT_MODE;
  try {
    const raw = ls.getItem(MODE_KEY);
    if (!raw) return DEFAULT_MODE;
    const parsed = JSON.parse(raw);
    if (parsed?.mode !== "cloud") return DEFAULT_MODE;
    // Outside Office nothing is routed to a local companion anyway, so the flag
    // is informational there. Inside Office it is the consent record.
    if (!insideOffice()) return "cloud";
    return parsed.chosenInOffice === true ? "cloud" : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveMode(mode) {
  const next = mode === "cloud" ? "cloud" : DEFAULT_MODE;
  const ls = safeLocalStorage();
  try {
    ls?.setItem(MODE_KEY, JSON.stringify({ mode: next, chosenInOffice: insideOffice() }));
  } catch { /* private-mode storage; the session still runs, just unremembered */ }
  return next;
}

// True only when this pane will send document text to the hosted gateway from
// INSIDE Office — i.e. the deliberate cloud choice. Portal mode is a separate,
// already-shipped story and is deliberately not folded in here.
export function isCloudSession() {
  return insideOffice() && loadMode() === "cloud";
}

// The hosted gateway serves ONLY /api/chat-completions. Everything backed by the
// local Python/Node companion (models list, document extract, OCR, workspace)
// has no counterpart there, so it must say so plainly instead of surfacing a 404.
export function companionOnlyMessage(feature) {
  return `${feature} membutuhkan Tantular Companion di komputer Anda. Sesi ini berjalan dalam Mode Cloud, jadi fitur tersebut tidak tersedia. Beralih ke Mode Lokal di Pengaturan (dan jalankan Companion) untuk memakainya.`;
}

export function companionOnlyError(feature) {
  return new Error(companionOnlyMessage(feature));
}

// Guard for companion-only call sites: no-op in local/dev/portal, throws a clear
// Indonesian message in a cloud session.
export function assertCompanionAvailable(feature) {
  if (isCloudSession()) throw companionOnlyError(feature);
}

export function companionUrl(pathname) {
  const path = String(pathname || "").startsWith("/") ? String(pathname) : `/${pathname}`;
  const hostname = String(
    globalThis.location?.hostname
    || globalThis.window?.location?.hostname
    || ""
  ).toLowerCase();
  const local = !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (local) return path;              // dev: same origin already
  if (insideOffice()) {
    // Cloud only when the user chose it inside Office; otherwise local companion.
    return loadMode() === "cloud" ? path : `https://localhost:3000${path}`;
  }
  return path;                         // portal: same-origin hosted gateway
}
