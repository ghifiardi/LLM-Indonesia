// Shared-session authentication for the local bridge.
//
// The bridge listens on 127.0.0.1, which is NOT a security boundary: every
// process on the machine can reach it, and any web page can attempt a
// cross-origin request to it. So a caller must present a token minted for this
// session, and the token never travels in a URL (it would land in logs and
// browser history).
import crypto from "node:crypto";

export function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Constant-time compare. A plain !== leaks the shared prefix length through
// timing, and a token is guessable byte-by-byte if comparison short-circuits.
export function tokensMatch(expected, presented) {
  const a = Buffer.from(String(expected ?? ""), "utf8");
  const b = Buffer.from(String(presented ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractToken(headers = {}) {
  const auth = String(headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(\S+)$/i);
  if (bearer) return bearer[1];
  const header = headers["x-tantular-token"];
  return header ? String(header) : "";
}

// A browser can be tricked into resolving an attacker-controlled name to
// 127.0.0.1 and then talking to this server with its own credentials. The Host
// header is what distinguishes that from a genuine local call, so anything
// that is not an explicit loopback literal is refused.
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostIsLoopback(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (!host) return false;
  const withoutPort = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return ALLOWED_HOSTS.has(withoutPort);
}

// The deck is served by a static server on its own port, so every call it
// makes to the bridge is cross-origin. Refusing CORS outright — the original
// design — meant the browser could never read a reply, and the transport only
// appeared to work when driven from Node, where CORS is not enforced.
//
// Loopback origins are allowed, any other origin is not. A page on the open
// internet therefore cannot read this service even if it reaches the port, and
// the session token still guards every call: CORS decides who may READ a
// reply, never who may act.
export function originIsLoopback(origin) {
  const value = String(origin || "").trim();
  if (!value) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}
