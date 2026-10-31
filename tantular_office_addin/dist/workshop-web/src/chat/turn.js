// Pure per-turn preparation: scope the history, and resolve (or refuse to
// guess) the referent of an anaphoric follow-up. chatPane.js cannot run under
// node:test, so the decision logic lives here.
import { isAnaphoricFollowUp, verifyReferent, pickReferent, askWhichMessage, ASK_REFERENT_MESSAGE } from "./followUp.js";

// `choice` is the parsed reply to an earlier "which one?" (index or "all"); the
// caller has already substituted the original request for `message`.
export async function prepareTurn({ message, mode, selectionText = "", history, referent, readBody, gather, choice = null }) {
  if (choice !== null && mode !== "selection") {
    const picked = pickReferent(referent, await readBody(), choice);
    if (!picked) return { kind: "ask", message: ASK_REFERENT_MESSAGE };
    const context = {
      text: picked.text, label: "document", kind: "document",
      revision: picked.revision, scope: `referent:${picked.revision}`
    };
    history.setScope(context.scope);
    const priorMessages = history.toMessages();
    history.add("user", message);
    return { kind: "ready", context, priorMessages, usedReferent: true };
  }
  let context = mode === "selection"
    ? { text: selectionText, label: "selection", kind: "selection", scope: `selection:${selectionText}` }
    : await gather(mode);
  history.setScope(context.scope);
  let priorMessages = history.toMessages();

  let usedReferent = false;
  if (context.kind !== "selection" && priorMessages.length === 0 && isAnaphoricFollowUp(message)) {
    const verified = verifyReferent(referent, await readBody(), message);
    if (!verified) return { kind: "ask", message: ASK_REFERENT_MESSAGE };
    if (verified.ambiguous) {
      // The caller keeps the referent and this request so "yang kedua" can answer it.
      return { kind: "ask", message: askWhichMessage(verified.ambiguous), pending: { texts: verified.ambiguous, originalMessage: message } };
    }
    context = {
      text: verified.text, label: "document", kind: "document",
      revision: verified.revision, scope: `referent:${verified.revision}`
    };
    history.setScope(context.scope);
    priorMessages = history.toMessages();
    usedReferent = true;
  }
  history.add("user", message);
  return { kind: "ready", context, priorMessages, usedReferent };
}
