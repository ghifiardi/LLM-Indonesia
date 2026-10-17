// The companion's half of the cross-repository wire contract.
//
// contract/office-edit-protocol.v1.json is byte-identical here and in
// ghifiardi/tantular-distillation. Both repositories test against it and both
// assert its digest, so a change made on one side and not mirrored on the
// other fails here rather than drifting until a live run misbehaves.
//
// This drives the REAL routes over HTTP on a server this test owns.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.join(HERE, "..", "contract", "office-edit-protocol.v1.json");

// The other repository asserts this same literal.
const CONTRACT_SHA256 =
  "adec2e01c85be000461f48914013bf3dabde770e85210ccfe57bf642ce18f102";

const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));

let server;
let origin;

before(async () => {
  const mod = await import("../tools/dev-server.mjs");
  server = http.createServer(mod.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const EX = contract.prepare.request.example;

async function post(route, body) {
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("the contract file is the one both repositories pin", () => {
  const digest = createHash("sha256")
    .update(fs.readFileSync(CONTRACT_PATH)).digest("hex");
  assert.equal(digest, CONTRACT_SHA256,
    "contract/office-edit-protocol.v1.json changed. Mirror the identical file "
    + "into ghifiardi/tantular-distillation and update the literal in BOTH "
    + "repositories, or the two sides have silently diverged.");
});

test("prepare answers the contract's ok shape at the contract's status", async () => {
  const res = await post(contract.routes.prepare, EX);
  assert.equal(res.status, contract.prepare.response_ok.status);
  for (const field of contract.prepare.response_ok.required_fields) {
    assert.ok(res.body[field] !== undefined, `prepare response missing ${field}`);
  }
  const pattern = new RegExp(contract.prepare.response_ok.digest_pattern);
  for (const field of contract.prepare.response_ok.digest_fields) {
    assert.match(res.body[field], pattern, `${field} is not a sha256`);
  }
  assert.equal(res.body.protocol_version, contract.protocol_version);
});

test("every prepare refusal the contract declares is reachable", async () => {
  const bodies = {
    batch_unsupported: { ...EX, edits: [EX.edits[0], EX.edits[0]] },
    not_located: { ...EX, located: null },
    no_document: { ...EX, document: "   " },
    no_edit: { ...EX, edits: [] },
  };
  for (const reason of contract.prepare.response_refused.reasons) {
    const res = await post(contract.routes.prepare, bodies[reason]);
    assert.equal(res.status, contract.prepare.response_refused.status, reason);
    assert.equal(res.body.reason, reason);
    for (const field of contract.prepare.response_refused.required_fields) {
      assert.ok(res.body[field] !== undefined, `${reason} missing ${field}`);
    }
  }
});

test("execute answers the contract's ok shape", async () => {
  const prepared = await post(contract.routes.prepare, EX);
  const res = await post(contract.routes.execute, {
    token: prepared.body.token, edit: EX.edits[0],
    document: EX.document, located: EX.located });
  assert.equal(res.status, contract.execute.response_ok.status);
  for (const field of contract.execute.response_ok.required_fields) {
    assert.ok(res.body[field] !== undefined, `execute response missing ${field}`);
  }
});

test("every execute refusal the contract declares is reachable", async () => {
  const fresh = async () => (await post(contract.routes.prepare, EX)).body.token;
  const cases = {
    unknown_token: async () => ({ token: "never-issued", edit: EX.edits[0],
                                  document: EX.document, located: EX.located }),
    expired: null,     // covered by the policy unit tests: it needs a clock
    document_changed: async () => ({ token: await fresh(), edit: EX.edits[0],
                                     document: `${EX.document} berubah`,
                                     located: EX.located }),
    target_moved: async () => ({ token: await fresh(), edit: EX.edits[0],
                                 document: EX.document,
                                 located: { ...EX.located, ordinal: 3 } }),
    edit_changed: async () => ({ token: await fresh(), edit: { ...EX.edits[0],
                                                               replace: "lain" },
                                 document: EX.document, located: EX.located }),
  };
  for (const reason of contract.execute.response_refused.reasons) {
    const build = cases[reason];
    if (!build) continue;
    const res = await post(contract.routes.execute, await build());
    assert.equal(res.status, contract.execute.response_refused.status, reason);
    assert.equal(res.body.reason, reason);
  }
});

test("a replay answers the contract's duplicate shape and status", async () => {
  const token = (await post(contract.routes.prepare, EX)).body.token;
  const payload = { token, edit: EX.edits[0], document: EX.document,
                    located: EX.located };
  await post(contract.routes.execute, payload);
  const replay = await post(contract.routes.execute, payload);
  assert.equal(replay.status, contract.execute.response_duplicate.status);
  assert.equal(replay.body.reason, contract.execute.response_duplicate.reason);
  for (const field of contract.execute.response_duplicate.required_fields) {
    assert.ok(replay.body[field] !== undefined, `duplicate missing ${field}`);
  }
});

test("result accepts every status the contract declares", async () => {
  for (const status of contract.result.request.statuses) {
    // A DIFFERENT edit each pass, so each gets its own idempotency key -- and
    // prepared with that same edit, because approving one change and executing
    // another is edit_changed, which is a different test.
    const edit = { ...EX.edits[0], replace: `baru-${status}` };
    const token = (await post(contract.routes.prepare,
                              { ...EX, edits: [edit] })).body.token;
    const executed = await post(contract.routes.execute, {
      token, edit, document: EX.document, located: EX.located });
    assert.equal(executed.status, 200, `execute failed for ${status}`);
    const res = await post(contract.routes.result, {
      idempotency_key: executed.body.idempotency_key, status });
    assert.equal(res.status, contract.result.response_ok.status, status);
    assert.equal(res.body.status, status);
    for (const field of contract.result.response_ok.required_fields) {
      assert.ok(res.body[field] !== undefined, `result missing ${field}`);
    }
  }
});

test("result refuses an unknown key as the contract declares", async () => {
  const res = await post(contract.routes.result,
                         { idempotency_key: "never-issued", status: "applied" });
  assert.equal(res.status, contract.result.response_refused.status);
  assert.ok(contract.result.response_refused.reasons.includes(res.body.reason));
});

test("diagnostics answers the contract's identity shape", async () => {
  const response = await fetch(`${origin}${contract.routes.diagnostics}`);
  assert.equal(response.status, contract.diagnostics.response_ok.status);
  const body = await response.json();
  for (const field of contract.diagnostics.response_ok.required_fields) {
    assert.ok(body[field] !== undefined, `diagnostics missing ${field}`);
  }
  for (const field of contract.diagnostics.response_ok.served_model_fields) {
    assert.ok(field in body.servedModel, `servedModel missing ${field}`);
  }
  // Null WITH a reason when Ollama is not reachable -- never invented.
  if (body.servedModel.digest === null) assert.ok(body.servedModel.reason);
});

test("the transport error statuses match the contract", async () => {
  const errors = contract.transport_errors;
  const notAllowed = await fetch(`${origin}${contract.routes.prepare}`,
                                 { method: "GET" });
  assert.equal(notAllowed.status, errors.method_not_allowed.status);

  const malformed = await fetch(`${origin}${contract.routes.prepare}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: "{oops" });
  assert.equal(malformed.status, errors.malformed_json.status);

  const badOrigin = await fetch(`${origin}${contract.routes.prepare}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify(EX) });
  assert.equal(badOrigin.status, errors.origin_not_allowed.status);
});

test("the scope the contract declares is the scope the routes enforce", () => {
  assert.equal(contract.scope.max_edits_per_approval, 1);
  assert.equal(contract.scope.tool, "office_edit");
  assert.equal(contract.scope.host, "word");
});
