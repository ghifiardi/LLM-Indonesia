// Approval-gated document edits: one edit, bound to what the user saw.
//
// The edit preview in wordEdits.js already shows the user the old and new text
// and makes them press Terapkan. What it does NOT do is bind that decision to
// anything: the chosen edits are DOM state handed straight to applyTrackedEdits,
// so an edit approved against one document can land in another as long as the
// `find` text still occurs somewhere. The user approved a change they can no
// longer be said to have seen.
//
// This is lookupPolicy.js's approval protocol applied to a different payload,
// deliberately and almost line for line. That protocol is already reasoned
// about and already shipping: a token is minted at preview, it carries an
// expiry, it is bound to the exact bytes that were displayed, it is checked
// again at execute, and it is deleted on EVERY path so it can be used once.
// The only things that change here are what gets bound and what the user is
// shown.
//
// THREE BINDINGS, because there are three ways an approval can stop describing
// what happens:
//
//   document_version  the body text at preview. A different document means the
//                     approval was for text the user is no longer editing.
//   target_digest     the matched text AND its ordinal. The same `find` can
//                     occur many times; approving the third occurrence must not
//                     authorise the first.
//   edit_digest       find + replace + occurrence. If the proposed change moved
//                     after it was displayed, the displayed thing was not this.
//
// NOTHING HERE HOLDS DOCUMENT CONTENT. Every binding is a hash, because the
// token lives in memory and is written to an audit log, and neither should
// carry the user's text. Same reason lookupPolicy hashes the document.
//
// SINGLE EDIT ONLY, deliberately. Office.js has no transaction across
// context.sync(), so a multi-edit batch cannot be rolled back: edit 3 failing
// leaves 1 and 2 applied. Pretending otherwise would put a lie in the receipt.
// One edit has no partial state to misreport, so the scope is one edit until
// the batch semantics are designed honestly.

import { createHash, randomUUID } from "node:crypto";

export const APPROVAL_PROTOCOL_VERSION = 1;

// Two minutes, matching lookup. Long enough to read a diff, short enough that
// an approval left open in a background pane is not still live an hour later.
export const DEFAULT_TTL_MS = 120_000;

// Refusal reasons. Exported so the pane, the companion and the tests all name
// the same states rather than matching on message text.
export const REFUSALS = Object.freeze({
  UNKNOWN_TOKEN: "unknown_token",
  EXPIRED: "expired",
  DOCUMENT_CHANGED: "document_changed",
  TARGET_MOVED: "target_moved",
  EDIT_CHANGED: "edit_changed",
  NO_DOCUMENT: "no_document",
  NO_EDIT: "no_edit",
  BATCH_UNSUPPORTED: "batch_unsupported",
  NOT_LOCATED: "not_located",
});

function sha256(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

// The document the edit was approved against.
export function documentVersion(documentText) {
  const text = String(documentText ?? "");
  if (!text.trim()) return "";
  return sha256(text);
}

// WHERE the edit lands: the text that actually matched, plus which
// non-overlapping occurrence of it. Both, because either alone is ambiguous —
// the same matched text repeats, and an ordinal means nothing without the text
// it counts.
export function targetDigest(matchedText, ordinal) {
  return sha256(`${String(matchedText ?? "")}\n${Number(ordinal)}`);
}

// WHAT the edit does. Kept separate from the target so a receipt can say
// whether the change moved or the place it lands moved; they are different
// failures with different causes.
export function editDigest(edit) {
  return sha256(JSON.stringify({
    find: String(edit?.find ?? ""),
    replace: String(edit?.replace ?? ""),
    occurrence: Number.isInteger(edit?.occurrence) && edit.occurrence >= 1
      ? edit.occurrence : 1,
  }));
}

/**
 * Mint an approval for ONE located edit, bound to what the pane displayed.
 *
 * `located` is the result the caller already has from locateEdit() plus the
 * ordinal from searchOrdinalAt(): this function does not re-resolve the edit,
 * because resolving it twice invites the two answers to differ.
 */
export function prepareEdit({
  edits, documentText, located, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS,
}) {
  const list = Array.isArray(edits) ? edits : (edits ? [edits] : []);
  if (list.length === 0) {
    return { ok: false, reason: REFUSALS.NO_EDIT,
             message: "Tidak ada edit untuk disetujui." };
  }
  // Refuse the batch rather than approving the first and silently dropping the
  // rest: a partial approval is exactly the misreport this scope avoids.
  if (list.length > 1) {
    return { ok: false, reason: REFUSALS.BATCH_UNSUPPORTED,
             message: `Hanya satu edit per persetujuan (${list.length} dipilih). `
                      + "Terapkan satu per satu." };
  }
  const version = documentVersion(documentText);
  if (!version) {
    return { ok: false, reason: REFUSALS.NO_DOCUMENT,
             message: "Tidak ada dokumen; persetujuan dibatalkan." };
  }
  const matchedText = located?.matchedText;
  const ordinal = located?.ordinal;
  if (typeof matchedText !== "string" || !matchedText
      || !Number.isInteger(ordinal) || ordinal < 0) {
    // An unlocated edit has no target to bind to. Minting a token anyway would
    // produce an approval that authorises "wherever this turns up later".
    return { ok: false, reason: REFUSALS.NOT_LOCATED,
             message: "Edit tidak terjangkarkan ke dokumen; tidak ada yang bisa disetujui." };
  }

  const edit = list[0];
  const target = targetDigest(matchedText, ordinal);
  const change = editDigest(edit);
  return {
    ok: true,
    protocol_version: APPROVAL_PROTOCOL_VERSION,
    token: randomUUID(),
    nonce: randomUUID(),
    document_version: version,
    target_digest: target,
    edit_digest: change,
    expiresAt: now() + ttlMs,
    // What the pane must show before Terapkan. The text is the user's own
    // document, shown locally and never recorded; only the digests travel.
    disclosure: {
      find: String(edit?.find ?? ""),
      replace: String(edit?.replace ?? ""),
      occurrence: Number.isInteger(edit?.occurrence) ? edit.occurrence : 1,
      alasan: String(edit?.alasan ?? ""),
      note: "Perubahan ini akan diterapkan ke dokumen Anda. Tidak ada isi dokumen "
            + "yang dikirim keluar; hanya ringkasan digest yang dicatat.",
    },
  };
}

/**
 * Consume an approval, or refuse. Single use on every path.
 *
 * The three bindings are checked SEPARATELY and reported separately, because
 * "the document changed", "the edit moved" and "the change itself changed" send
 * whoever reads the audit log to three different places.
 */
export function authorizeEdit({
  pending, token, document_version, target_digest, edit_digest,
  now = () => Date.now(),
}) {
  const entry = pending.get(token);
  if (!entry) {
    return { ok: false, reason: REFUSALS.UNKNOWN_TOKEN,
             message: "Persetujuan tidak dikenal atau sudah dipakai." };
  }
  if (now() > entry.expiresAt) {
    pending.delete(token);
    return { ok: false, reason: REFUSALS.EXPIRED,
             message: "Persetujuan kedaluwarsa; setujui ulang." };
  }
  if (String(document_version || "") !== entry.document_version) {
    pending.delete(token);
    return { ok: false, reason: REFUSALS.DOCUMENT_CHANGED,
             message: "Dokumen berubah setelah disetujui; edit dibatalkan." };
  }
  if (String(target_digest || "") !== entry.target_digest) {
    pending.delete(token);
    return { ok: false, reason: REFUSALS.TARGET_MOVED,
             message: "Lokasi edit berubah setelah disetujui; edit dibatalkan." };
  }
  if (String(edit_digest || "") !== entry.edit_digest) {
    pending.delete(token);
    return { ok: false, reason: REFUSALS.EDIT_CHANGED,
             message: "Isi edit berubah setelah disetujui; edit dibatalkan." };
  }
  pending.delete(token);            // single use
  return { ok: true, entry };
}

// The key a repeated execute collides on. Bound to BOTH the change and the
// approval: the same edit approved twice is two decisions and may legitimately
// apply twice, but one approval must only ever produce one application.
export function idempotencyKey(edit_digest, token) {
  return sha256(`${String(edit_digest || "")}\n${String(token || "")}`);
}

/**
 * One audit row. Mirrors lookupPolicy.auditRecord's discipline: digests, never
 * content. There is no plaintext escape hatch here — a lookup query is
 * something the user composed, while this is the document itself, and no
 * debugging convenience justifies writing it to disk.
 */
export function editAuditRecord({
  at = new Date(), approved, outcome, reason = null,
  document_version = null, target_digest = null, edit_digest = null,
  token = null, nonce = null, idempotency_key = null,
  find_chars = null, replace_chars = null, status = null,
  approver = null, boot_id = null,
}) {
  return {
    at: at.toISOString(),
    protocol_version: APPROVAL_PROTOCOL_VERSION,
    approved: Boolean(approved),
    outcome,
    reason,
    document_version,
    target_digest,
    edit_digest,
    // The token identifies the approval in the log; it is already spent by the
    // time a row is written, so it cannot be replayed from here.
    token,
    nonce,
    idempotency_key,
    // Sizes, not text. Enough to see that a 4000-character replacement
    // happened without recording what it said.
    find_chars,
    replace_chars,
    status,
    approver,
    boot_id,
    _note: "digests only; document text and edit bodies are never recorded",
  };
}
