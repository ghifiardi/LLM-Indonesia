// AppleScript construction and execution, kept apart from the adapters.
//
// Separated so the scripts can be asserted in tests without macOS, and so
// rehearsal mode is enforced in ONE place rather than remembered at every call
// site. An adapter never spawns a process itself.
import { execFile } from "node:child_process";

export class ScriptRunner {
  /**
   * @param {boolean} rehearsal  true (default) logs the script and executes
   *   nothing. Executing is opt-in because the first time this runs for real,
   *   it moves someone's live presentation.
   */
  constructor({ rehearsal = true, timeoutMs = 5000, log = [], logLimit = 200 } = {}) {
    this.rehearsal = rehearsal;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.logLimit = logLimit;
  }

  _record(entry) {
    this.log.push(entry);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }

  /** @returns {Promise<{ok:boolean, stdout?:string, rehearsed?:boolean, error?:string, permission?:string}>} */
  /**
   * @param {{readOnly?: boolean}} [options] readOnly scripts execute even in
   *   rehearsal. Rehearsal exists to stop the bridge MOVING a presentation,
   *   not to stop it looking at one — and a preflight that cannot observe the
   *   machine tells you nothing about whether it is safe to enable execution.
   *   Only observation may use this; anything that changes state must not.
   */
  async run(label, script, { readOnly = false } = {}) {
    if (this.rehearsal && !readOnly) {
      this._record({ label, script, rehearsed: true });
      return { ok: true, rehearsed: true, stdout: "", script };
    }
    this._record({ label, script, rehearsed: false, readOnly });
    return new Promise((resolve) => {
      // execFile, never a shell: the script is passed as an argument, so no
      // slide title or spoken phrase can ever be interpreted as shell syntax.
      execFile("osascript", ["-e", script], { timeout: this.timeoutMs }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout).trim(), script });
        const message = String(stderr || error.message);
        // -1743 is macOS refusing Automation permission. It is a setup problem
        // with a specific fix, not a generic script failure.
        const permission = /-1743|not authori[sz]ed|Not authorized/.test(message) ? "denied" : "unknown";
        resolve({ ok: false, error: message.trim(), permission, script });
      });
    });
  }

  recentScripts(limit = 20) {
    return this.log.slice(-limit);
  }
}

// AppleScript string literal. Rejecting the characters that would end the
// literal is safer than escaping them: a slide title is matched, never
// executed, so nothing is lost by refusing quotes and backslashes outright.
export function asLiteral(value) {
  const text = String(value ?? "");
  if (/["\\\n\r]/.test(text)) {
    return { ok: false, error: "value contains characters not allowed in a script literal" };
  }
  return { ok: true, literal: `"${text}"` };
}
