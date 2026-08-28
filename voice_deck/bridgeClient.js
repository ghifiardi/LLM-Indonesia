// Mirrors deck commands to the local native bridge.
//
// The web deck stays the source of truth for what the presenter sees: it
// applies every command to its own adapter first and NEVER waits on the bridge
// to redraw. The bridge is a parallel consumer of the same command, so a
// bridge that is down, slow, or unauthenticated degrades to "the web deck
// still works" rather than freezing a live presentation.
//
// The token is per-run and is kept in sessionStorage, never in the URL: a URL
// lands in history, screen shares and referrer headers.

export const TOKEN_STORAGE_KEY = "tantular.bridge.token";

export class BridgeClient {
  constructor({ endpoint, timeoutMs = 1500, fetchImpl, storage } = {}) {
    this.endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.storage = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    this.lastStatus = { state: "idle", message: "Bridge not contacted yet." };
  }

  getToken() {
    try { return this.storage?.getItem(TOKEN_STORAGE_KEY) || ""; } catch { return ""; }
  }

  setToken(token) {
    try { this.storage?.setItem(TOKEN_STORAGE_KEY, String(token || "").trim()); } catch { /* private mode */ }
  }

  isConfigured() {
    return Boolean(this.endpoint && this.getToken() && this.fetchImpl);
  }

  _status(state, message) {
    this.lastStatus = { state, message };
    return this.lastStatus;
  }

  async health() {
    if (!this.endpoint || !this.fetchImpl) return this._status("off", "Bridge endpoint not configured.");
    try {
      const res = await this._fetch(`${this.endpoint}/health`, { method: "GET" });
      if (!res.ok) return this._status("error", `Bridge health ${res.status}.`);
      const body = await res.json();
      return this._status("ok", `Bridge up — adapter "${body.adapter}" (${body.phase}).`);
    } catch (error) {
      return this._status("off", `Bridge unreachable: ${error.message}`);
    }
  }

  // Never throws. A rehearsal must not be able to break the deck.
  async send(command) {
    if (!this.endpoint || !this.fetchImpl) return this._status("off", "Bridge disabled.");
    if (!this.getToken()) return this._status("needs-token", "Bridge token not set — paste it in the HUD.");
    try {
      const res = await this._fetch(`${this.endpoint}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.getToken()}` },
        body: JSON.stringify(command),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) return this._status("needs-token", "Bridge rejected the token — paste the current one.");
      if (!res.ok) return this._status("error", `Bridge refused ${command.action}: ${body.error || res.status}`);
      return this._status("ok", `Bridge: ${body.effect}${body.state ? ` (slide ${body.state.slide})` : ""}`);
    } catch (error) {
      return this._status("off", `Bridge unreachable: ${error.message}`);
    }
  }

  _fetch(url, options) {
    // A hung bridge must not hold the deck: abort rather than await forever.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    const done = this.fetchImpl(url, { ...options, signal: controller?.signal });
    return timer ? done.finally(() => clearTimeout(timer)) : done;
  }
}
