// Resolve local-companion APIs in both development and published task panes.
// In dev, the task pane itself is served by localhost:3000, so relative paths
// are ideal. In a published HTTPS task pane, calls must cross back to the
// user's trusted local Tantular companion.

export function companionUrl(pathname) {
  const path = String(pathname || "").startsWith("/") ? String(pathname) : `/${pathname}`;
  const hostname = String(
    globalThis.location?.hostname
    || globalThis.window?.location?.hostname
    || ""
  ).toLowerCase();
  const local = !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  return local ? path : `https://localhost:3000${path}`;
}
