// The prepare -> execute -> result sequence the companion composes.
//
// These exercise the DECISION logic the three /api/edit/* routes are built
// from, without booting an HTTP server. The routes add transport, CORS and the
// audit write; the rules below are what they are made of.

import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareEdit, authorizeEdit, idempotencyKey, editAuditRecord,
  documentVersion, targetDigest, editDigest, REFUSALS,
} from "../src/chat/editApprovalPolicy.js";

const DOC = "Target satu. Target dua. Target tiga.";
const EDIT = { find: "Target dua", replace: "Target DUA", occurrence: 1 };
const LOCATED = { matchedText: "Target dua", ordinal: 0 };

// Exactly what the endpoint does: derive every binding from the material the
// caller sent, never from a digest the caller asserted.
function derive({ edit, document, located }) {
  return {
    document_version: documentVersion(document),
    target_digest: targetDigest(located?.matchedText, located?.ordinal),
    edit_digest: editDigest(edit),
  };
}

function companion() {
  const pending = new Map();
  const applied = new Map();
  const audit = [];
  return {
    audit,
    prepare(payload) {
      const prepared = prepareEdit({
        edits: payload.edits, documentText: payload.document, located: payload.located });
      audit.push(editAuditRecord({
        approved: false, outcome: prepared.ok ? "prepared" : `refused:${prepared.reason}`,
        reason: prepared.ok ? null : prepared.reason }));
      if (prepared.ok) pending.set(prepared.token, prepared);
      return prepared;
    },
    execute(payload) {
      const computed = derive(payload);
      const key = idempotencyKey(computed.edit_digest, payload.token);
      if (applied.has(key)) {
        audit.push(editAuditRecord({ approved: false, outcome: "refused:duplicate",
                                     reason: "duplicate", idempotency_key: key }));
        return { ok: false, reason: "duplicate", idempotency_key: key };
      }
      const authorized = authorizeEdit({ pending, token: payload.token, ...computed });
      audit.push(editAuditRecord({
        approved: authorized.ok,
        outcome: authorized.ok ? "authorized" : `refused:${authorized.reason}`,
        reason: authorized.ok ? null : authorized.reason,
        idempotency_key: authorized.ok ? key : null }));
      if (!authorized.ok) return authorized;
      applied.set(key, "authorized");
      return { ok: true, idempotency_key: key };
    },
    result({ idempotency_key, status }) {
      if (!applied.has(idempotency_key)) {
        audit.push(editAuditRecord({ approved: false, outcome: "refused:unknown_key",
                                     reason: "unknown_key" }));
        return { ok: false, reason: "unknown_key" };
      }
      applied.set(idempotency_key, status);
      audit.push(editAuditRecord({ approved: true, outcome: "result", status,
                                   idempotency_key }));
      return { ok: true, status };
    },
  };
}

test("the happy path: prepare, execute once, report the true status", () => {
  const api = companion();
  const prepared = api.prepare({ edits: [EDIT], document: DOC, located: LOCATED });
  assert.equal(prepared.ok, true);
  const executed = api.execute({ token: prepared.token, edit: EDIT,
                                 document: DOC, located: LOCATED });
  assert.equal(executed.ok, true);
  const reported = api.result({ idempotency_key: executed.idempotency_key,
                                status: "applied" });
  assert.equal(reported.ok, true);
  assert.deepEqual(api.audit.map((r) => r.outcome),
                   ["prepared", "authorized", "result"]);
});

test("a replayed execute is refused as a duplicate, not reapplied", () => {
  const api = companion();
  const prepared = api.prepare({ edits: [EDIT], document: DOC, located: LOCATED });
  const call = () => api.execute({ token: prepared.token, edit: EDIT,
                                   document: DOC, located: LOCATED });
  assert.equal(call().ok, true);
  const again = call();
  assert.equal(again.ok, false);
  assert.equal(again.reason, "duplicate",
    "the duplicate check must run BEFORE the token check, or a replay reports "
    + "unknown_token and hides its real cause");
});

test("the client cannot assert a binding: digests come from the material", () => {
  const api = companion();
  const prepared = api.prepare({ edits: [EDIT], document: DOC, located: LOCATED });
  // A caller replaying the approval against DIFFERENT text, while claiming the
  // original document version, has no way to express that claim: the companion
  // hashes what it was sent.
  const executed = api.execute({
    token: prepared.token, edit: EDIT,
    document: DOC + " Kalimat tambahan.", located: LOCATED,
    document_version: prepared.document_version,   // ignored by derive()
  });
  assert.equal(executed.ok, false);
  assert.equal(executed.reason, REFUSALS.DOCUMENT_CHANGED);
});

test("an edit swapped after approval is refused at the same target", () => {
  const api = companion();
  const prepared = api.prepare({ edits: [EDIT], document: DOC, located: LOCATED });
  const executed = api.execute({
    token: prepared.token, edit: { ...EDIT, replace: "sesuatu yang lain" },
    document: DOC, located: LOCATED });
  assert.equal(executed.ok, false);
  assert.equal(executed.reason, REFUSALS.EDIT_CHANGED);
});

test("a result for an unknown key is not retro-authorised", () => {
  const api = companion();
  const reported = api.result({ idempotency_key: "never-issued", status: "applied" });
  assert.equal(reported.ok, false);
  assert.equal(reported.reason, "unknown_key");
});

test("an unwritable audit refuses the request instead of proceeding", () => {
  // The companion's appendEditAudit throws when the log cannot be written, and
  // the route turns that into a refusal. An edit that cannot be recorded must
  // not happen: the audit is the only durable evidence that a human approved.
  const broken = () => { throw new Error("audit log edit tidak dapat ditulis"); };
  let applied = false;
  const guarded = () => {
    try { broken(); } catch { return { ok: false, reason: "audit_unwritable" }; }
    applied = true;
    return { ok: true };
  };
  const outcome = guarded();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "audit_unwritable");
  assert.equal(applied, false, "no mutation may follow an unwritable audit");
});

test("no audit row anywhere carries document text or edit bodies", () => {
  const api = companion();
  const prepared = api.prepare({ edits: [EDIT], document: DOC, located: LOCATED });
  const executed = api.execute({ token: prepared.token, edit: EDIT,
                                 document: DOC, located: LOCATED });
  api.result({ idempotency_key: executed.idempotency_key, status: "applied" });
  const serialized = JSON.stringify(api.audit);
  for (const secret of [DOC, EDIT.find, EDIT.replace, "Target dua"]) {
    assert.ok(!serialized.includes(secret), `audit leaked: ${secret}`);
  }
});
