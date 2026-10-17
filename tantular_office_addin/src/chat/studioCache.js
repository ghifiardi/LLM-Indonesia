// Cache key for a Studio spec (Document/Workbook/Deck).
//
// Create followed immediately by Download used to call the model a second
// time for the exact same job — the same source, the same options, the same
// instructions — because resolveXSpec() had no memory of what it had just
// built. If nothing that could change the model's answer moved since the
// last successful build, Download can reuse the existing spec instead.
//
// Fingerprints the resolved source text, the Studio options (section/sheet/
// slide count, document type, tone, etc.), the free-text instruction, and —
// because either one changes what the model would answer — the current mode
// (local/cloud) and model. A mismatch on ANY of these invalidates the cache;
// there is no partial reuse.
export function fingerprintStudioInputs({
  content = "",
  options = {},
  instruction = "",
  mode = "",
  model = ""
} = {}) {
  // Explicit key order (not Object.keys(options), which reflects insertion
  // order) so callers can build the options object in any order without
  // that alone invalidating a cache that should have hit.
  const optionsKey = Object.keys(options)
    .sort()
    .map((key) => `${key}=${JSON.stringify(options[key])}`)
    .join("&");
  return JSON.stringify({
    content: String(content || ""),
    options: optionsKey,
    instruction: String(instruction || ""),
    mode: String(mode || ""),
    model: String(model || "")
  });
}

// Document Studio's Word auto-read only fits a 12,000-char PREVIEW into the
// source textarea (Office task panes cannot usefully render/edit hundreds of
// KB of text) — but fingerprinting that preview on Download, after Create
// fingerprinted the full body, meant a source over 12,000 characters could
// never actually hit the cache: two different fingerprints for what the user
// experienced as "nothing changed."
//
// Pure and DOM-free so the reuse-vs-invalidate decision is unit-testable
// without simulating an Office host (taskpane.js itself cannot be imported
// under node:test — see studioProgressWiring.test.mjs). resolveDocumentSpec
// stores the full source once, right after reading it from Word, and on
// every later call asks this function whether that stored copy is still the
// current content or whether something has replaced it.
export function resolveAutoLoadedSource({ docFile, typedContent, storedFullText, storedPreview }) {
  // Reusable only when: no file has been uploaded since (that source is
  // tracked separately, by uploadedOrTypedContent), there IS a stored full
  // source, and the textarea still holds EXACTLY the untouched preview this
  // same mechanism wrote — any edit, however small, means the user replaced
  // it, not just viewed it.
  if (!docFile && storedFullText && typedContent && typedContent === storedPreview) {
    return { content: storedFullText, reused: true };
  }
  return { content: typedContent, reused: false };
}
