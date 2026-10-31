// Clarification before action for the Excel chat. When a request is
// ambiguous (e.g. "compare target and actual maturity over time" on a sheet
// with Overall, G/P/D/R/E and per-indicator columns) the planner returns a
// "clarify" question instead of actions. The original request is kept pending
// so the user's short answer ("Overall, Jan–Jun") completes it; a cancel word
// drops it without reading the workbook or calling the model.
// Pure and Office-free for unit tests.

export const MAX_CLARIFY_OPTIONS = 6;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTION_CHARS = 60;
const CANCEL_RE = /^(batal|batalkan|cancel|tidak jadi|gak jadi|nggak jadi|ga jadi|stop|lupakan)[.!]?$/i;

// The prompt wraps workbook text in """ fences; cell text must not be able to
// close the fence and pose as the user's request.
export function fenceUntrusted(text) {
  return String(text ?? "").replace(/"{3,}/g, '""');
}

export function isCancelReply(text) {
  return CANCEL_RE.test(String(text || "").trim());
}

// Model JSON → { kind: "clarify", question, options, ignoredActions } or
// { kind: "act", actions }. A plan that asks never also acts.
export function resolvePlan(parsed) {
  const clarify = parsed?.clarify;
  const question = typeof clarify === "object" && clarify
    ? String(clarify.question ?? "").trim().slice(0, MAX_QUESTION_CHARS)
    : "";
  if (!question) return { kind: "act", actions: parsed?.actions };
  const options = [];
  for (const raw of Array.isArray(clarify.options) ? clarify.options : []) {
    if (typeof raw !== "string") continue;
    const option = raw.trim().slice(0, MAX_OPTION_CHARS);
    if (option && !options.includes(option)) options.push(option);
    if (options.length >= MAX_CLARIFY_OPTIONS) break;
  }
  const ignoredActions = Array.isArray(parsed?.actions) ? parsed.actions.length : 0;
  return { kind: "clarify", question, options, ignoredActions };
}

// What the next user message means given what is pending.
export function nextTurn(pending, message) {
  if (!pending) return { type: "new", request: message };
  if (isCancelReply(message)) return { type: "cancel" };
  return { type: "answer", request: composeRequest(pending, message) };
}

// Original request first, then every question with its answer.
export function composeRequest(pending, answer) {
  const exchanges = pending.exchanges.map((item, index) => (
    index === pending.exchanges.length - 1 ? { ...item, answer } : item
  ));
  const lines = [pending.request, "", "Klarifikasi (permintaan di atas tetap berlaku):"];
  for (const item of exchanges) {
    lines.push(`- Tantular bertanya: ${item.question}`);
    lines.push(`  Jawaban pengguna: ${item.answer ?? ""}`);
  }
  return fenceUntrusted(lines.join("\n"));
}

// Pending state after a plan. `answer` is the message that answered the
// previous question (only when a clarification was already pending).
export function pendingAfterPlan(pending, request, plan, answer) {
  if (plan?.kind !== "clarify") return null;
  if (!pending) return { request, exchanges: [{ question: plan.question }] };
  const exchanges = pending.exchanges.map((item, index) => (
    index === pending.exchanges.length - 1 ? { ...item, answer } : item
  ));
  return { request: pending.request, exchanges: [...exchanges, { question: plan.question }] };
}
