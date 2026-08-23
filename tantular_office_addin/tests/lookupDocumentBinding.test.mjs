// The approval is for a query ABOUT A DOCUMENT. Both halves are bound.
//
// Without the document half, a user could approve "cari harga pasar" while
// looking at report A, and the answer would be verified against report B —
// protected strings drawn from a source they never saw when approving.

import test from "node:test";
import assert from "node:assert/strict";
import { prepareLookup, authorizeExecution, documentHash } from "../src/chat/lookupPolicy.js";

const ENV = { TANTULAR_LOOKUP_ENABLED: "true", TANTULAR_LOOKUP_HOSTS: "id.wikipedia.org" };
const DOC = "Vendor utama PT Sinar Mas. Pagu Rp 1.750.000.000.";
const base = { query: "harga pasar semen", host: "id.wikipedia.org", env: ENV };

function approved(document = DOC) {
  const prepared = prepareLookup({ ...base, document });
  const pending = new Map([[prepared.token, prepared]]);
  return { prepared, pending };
}

test("a lookup with no document is refused before anything is sent", () => {
  // Refusing here costs one dialog. The alternative is sending the query out
  // and refusing the answer afterwards, having leaked the query for nothing.
  for (const document of [undefined, "", "   "]) {
    const out = prepareLookup({ ...base, document });
    assert.equal(out.ok, false, JSON.stringify(document));
    assert.equal(out.reason, "no_document");
    assert.equal(out.token, undefined);
  }
});

test("the token carries a hash of the document, never its text", () => {
  const { prepared } = approved();
  assert.equal(prepared.documentHash, documentHash(DOC));
  assert.ok(!JSON.stringify(prepared).includes("PT Sinar Mas"),
    "document content must not be stored in the token");
});

test("executing with the approved document succeeds", () => {
  const { prepared, pending } = approved();
  const out = authorizeExecution({ pending, token: prepared.token,
    query: base.query, host: base.host, document: DOC });
  assert.equal(out.ok, true);
});

test("a document edited between approval and execute is refused", () => {
  const { prepared, pending } = approved();
  const edited = DOC.replace("PT Sinar Mas", "PT Bumi Raya");
  const out = authorizeExecution({ pending, token: prepared.token,
    query: base.query, host: base.host, document: edited });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "document_changed");
});

test("even a whitespace-only change is refused", () => {
  // Not pedantry: the check must be on bytes, or "which document" becomes a
  // judgement call and the binding is only approximate.
  const { prepared, pending } = approved();
  const out = authorizeExecution({ pending, token: prepared.token,
    query: base.query, host: base.host, document: `${DOC} ` });
  assert.equal(out.reason, "document_changed");
});

test("a dropped document at execute time is refused, not treated as unchanged", () => {
  const { prepared, pending } = approved();
  const out = authorizeExecution({ pending, token: prepared.token,
    query: base.query, host: base.host, document: "" });
  assert.equal(out.reason, "document_changed");
});

test("a refused execute burns the token", () => {
  const { prepared, pending } = approved();
  authorizeExecution({ pending, token: prepared.token, query: base.query,
    host: base.host, document: "dokumen lain" });
  const retry = authorizeExecution({ pending, token: prepared.token,
    query: base.query, host: base.host, document: DOC });
  assert.equal(retry.reason, "unknown_token",
    "a rejected attempt must not leave the token usable");
});

test("the query binding still holds alongside the document binding", () => {
  const { prepared, pending } = approved();
  const out = authorizeExecution({ pending, token: prepared.token,
    query: "query lain", host: base.host, document: DOC });
  assert.equal(out.reason, "mismatch");
});
