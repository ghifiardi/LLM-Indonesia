import { locateEdit, searchOrdinalAt } from "./editContract.js";

// Pure mirror of applyTrackedEdits' text-domain semantics (wordEdits.js):
// sequential per-edit re-anchoring against progressively-updated text,
// whitespace-normalized matching, matched-substring replacement, non-
// overlapping ordinal selection. Synthesis and eval both import this.
export function applyEditsToText(docText, edits) {
  let text = String(docText ?? "");
  const perEditStatus = [];
  for (const edit of edits) {
    const r = locateEdit(text, edit);
    if (r.error) { perEditStatus.push(r.error === "not_found" ? "not_found" : "skipped"); continue; }
    const matchedText = text.slice(r.index, r.index + r.length);
    if (matchedText.length > 250) { perEditStatus.push("not_found"); continue; }
    if (searchOrdinalAt(text, matchedText, r.index) === -1) { perEditStatus.push("not_found"); continue; }
    text = text.slice(0, r.index) + edit.replace + text.slice(r.index + r.length);
    perEditStatus.push("applied");
  }
  return { text, perEditStatus };
}
