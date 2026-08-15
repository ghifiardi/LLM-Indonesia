// Resolve model/companion APIs across the three contexts this pane runs in.
//
// 1. Dev (served from localhost:3000)      → relative path, same origin.
// 2. Installed Office add-in (hosted page)  → https://localhost:3000, the user's
//    own trusted companion. Their document text never leaves the machine.
// 3. Portal in a plain browser (no Office)  → same-origin /api/*, a hosted
//    gateway, so someone can try Tantular with nothing installed.
//
// Case 2 vs 3 is the line that matters. Both load the identical hosted page, so
// the ONLY thing separating "stays on your machine" from "sent to a server" is
// the Office.js check below. Getting it wrong would silently ship every
// installed user's deck to a gateway while the product still claimed to be
// local-only — so this branches on Office.js being genuinely present, not on a
// URL flag a stale link could carry.

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

export function companionUrl(pathname) {
  const path = String(pathname || "").startsWith("/") ? String(pathname) : `/${pathname}`;
  const hostname = String(
    globalThis.location?.hostname
    || globalThis.window?.location?.hostname
    || ""
  ).toLowerCase();
  const local = !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (local) return path;              // dev: same origin already
  if (insideOffice()) return `https://localhost:3000${path}`;  // installed: local companion
  return path;                         // portal: same-origin hosted gateway
}
