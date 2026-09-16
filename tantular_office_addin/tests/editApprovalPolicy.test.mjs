// The edit approval gate must fail closed at every step.
//
// The pane already shows the user what will change and makes them press
// Terapkan. These tests are why that press can be treated as evidence: an
// approval that is not bound to the document, the location and the change is
// a button, not an authorisation.

import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareEdit, authorizeEdit, documentVersion, targetDigest, editDigest,
  idempotencyKey, editAuditRecord, REFUSALS, DEFAULT_TTL_MS,
} from "../src/chat/editApprovalPolicy.js";

const DOC = "Laporan kuartal ini naik 12 persen. Laporan kuartal ini naik 12 persen.";
const EDIT = { find: "naik 12 persen", replace: "naik 14 persen", occurrence: 1,
               alasan: "koreksi angka" };
const LOCATED = { matchedText: "naik 12 persen", ordinal: 0 };

function approve(overrides = {}) {
  const pending = new Map();
  const prepared = prepareEdit({ edits: [EDIT], documentText: DOC,
                                 located: LOCATED, ...overrides });
  if (prepared.ok) pending.set(prepared.token, prepared);
  return { pending, prepared };
}

function execArgs(prepared, overrides = {}) {
  return {
    token: prepared.token,
    document_version: prepared.document_version,
    target_digest: prepared.target_digest,
    edit_digest: prepared.edit_digest,
    ...overrides,
  };
}

test("an approval binds the document, the location and the change", () => {
  const { prepared } = approve();
  assert.equal(prepared.ok, true);
  assert.equal(prepared.document_version, documentVersion(DOC));
  assert.equal(prepared.target_digest, targetDigest("naik 12 persen", 0));
  assert.equal(prepared.edit_digest, editDigest(EDIT));
  assert.ok(prepared.token && prepared.nonce);
  assert.notEqual(prepared.token, prepared.nonce);
  assert.equal(typeof prepared.expiresAt, "number");
});

test("a matching execute is authorised exactly once", () => {
  const { pending, prepared } = approve();
  const first = authorizeEdit({ pending, ...execArgs(prepared) });
  assert.equal(first.ok, true);
  const second = authorizeEdit({ pending, ...execArgs(prepared) });
  assert.equal(second.ok, false);
  assert.equal(second.reason, REFUSALS.UNKNOWN_TOKEN,
    "a spent token must be indistinguishable from one that never existed");
  assert.equal(pending.size, 0);
});

test("an expired approval is refused and consumed", () => {
  const { pending, prepared } = approve();
  const later = () => Date.now() + DEFAULT_TTL_MS + 1;
  const result = authorizeEdit({ pending, ...execArgs(prepared), now: later });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REFUSALS.EXPIRED);
  assert.equal(pending.size, 0, "an expired token must not linger for a retry");
});

test("a changed document refuses: the user approved different text", () => {
  const { pending, prepared } = approve();
  const result = authorizeEdit({
    pending, ...execArgs(prepared, { document_version: documentVersion(DOC + " Tambahan.") }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REFUSALS.DOCUMENT_CHANGED);
  assert.equal(pending.size, 0);
});

test("a moved target refuses even when the change is identical", () => {
  // The same matched text, the SECOND occurrence. Approving the first must not
  // authorise the second -- this is the ambiguity locateEdit exists to police.
  const { pending, prepared } = approve();
  const result = authorizeEdit({
    pending, ...execArgs(prepared, { target_digest: targetDigest("naik 12 persen", 1) }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REFUSALS.TARGET_MOVED);
});

test("a changed edit refuses even at the same target", () => {
  const { pending, prepared } = approve();
  const result = authorizeEdit({
    pending, ...execArgs(prepared, {
      edit_digest: editDigest({ ...EDIT, replace: "naik 40 persen" }) }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REFUSALS.EDIT_CHANGED);
});

test("the three bindings are reported separately", () => {
  // They send whoever reads the log to three different places, so one generic
  // "mismatch" would lose the only useful part of the refusal.
  const reasons = new Set();
  for (const override of [
    { document_version: "0".repeat(64) },
    { target_digest: "0".repeat(64) },
    { edit_digest: "0".repeat(64) },
  ]) {
    const { pending, prepared } = approve();
    reasons.add(authorizeEdit({ pending, ...execArgs(prepared, override) }).reason);
  }
  assert.deepEqual([...reasons].sort(),
    [REFUSALS.DOCUMENT_CHANGED, REFUSALS.EDIT_CHANGED, REFUSALS.TARGET_MOVED].sort());
});

test("more than one edit is refused, not partially approved", () => {
  const prepared = prepareEdit({ edits: [EDIT, { ...EDIT, replace: "x" }],
                                 documentText: DOC, located: LOCATED });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, REFUSALS.BATCH_UNSUPPORTED);
  assert.match(prepared.message, /satu edit/);
});

test("an unlocated edit cannot be approved", () => {
  for (const located of [null, {}, { matchedText: "", ordinal: 0 },
                         { matchedText: "x", ordinal: -1 }]) {
    const prepared = prepareEdit({ edits: [EDIT], documentText: DOC, located });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, REFUSALS.NOT_LOCATED,
      "an approval with no target authorises 'wherever this turns up later'");
  }
});

test("an empty document cannot be approved against", () => {
  const prepared = prepareEdit({ edits: [EDIT], documentText: "   ", located: LOCATED });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, REFUSALS.NO_DOCUMENT);
});

test("the idempotency key binds the change AND the approval", () => {
  const a = idempotencyKey("edit-digest", "token-1");
  assert.equal(a, idempotencyKey("edit-digest", "token-1"));
  assert.notEqual(a, idempotencyKey("edit-digest", "token-2"),
    "the same edit approved twice is two decisions");
  assert.notEqual(a, idempotencyKey("other-digest", "token-1"));
});

test("the audit row records digests and sizes, never content", () => {
  const row = editAuditRecord({
    approved: true, outcome: "applied",
    document_version: documentVersion(DOC),
    target_digest: targetDigest("naik 12 persen", 0),
    edit_digest: editDigest(EDIT),
    token: "t", nonce: "n", idempotency_key: "k",
    find_chars: EDIT.find.length, replace_chars: EDIT.replace.length,
    status: "applied", approver: "local-user", boot_id: "boot",
  });
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(EDIT.find), "the find text must never be logged");
  assert.ok(!serialized.includes(EDIT.replace), "the replace text must never be logged");
  assert.ok(!serialized.includes("Laporan kuartal"), "no document text in the log");
  assert.equal(row.find_chars, EDIT.find.length);
  assert.equal(row.replace_chars, EDIT.replace.length);
  assert.equal(row.approved, true);
});

test("a refused approval is still auditable without content", () => {
  const row = editAuditRecord({ approved: false, outcome: "refused",
                                reason: REFUSALS.DOCUMENT_CHANGED });
  assert.equal(row.approved, false);
  assert.equal(row.reason, REFUSALS.DOCUMENT_CHANGED);
  assert.equal(row.find_chars, null);
});
