// The approval flow, driven with fakes that RECORD whether a network call
// happened. Asserting "the call failed" is not enough — the requirement is that
// no request is made at all.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MODE_LOCAL, MODE_LOCAL_SEARCH, normaliseMode, bannerFor, searchAllowed,
  approvalDialogModel, createApprovalFlow
} from "../src/chat/lookupUi.js";

function harness({ confirmAnswer = true, prepared = null } = {}) {
  const calls = { prepare: [], execute: [], confirm: [] };
  const flow = createApprovalFlow({
    prepare: async (args) => {
      calls.prepare.push(args);
      return prepared || {
        ok: true, token: "tok-1",
        disclosure: { host: args.host, query: args.query,
                      note: "Teks ini akan dikirim keluar dari komputer Anda." }
      };
    },
    execute: async (args) => { calls.execute.push(args); return { ok: true, status: 200 }; },
    confirm: async (dialog) => { calls.confirm.push(dialog); return confirmAnswer; },
  });
  return { flow, calls };
}

test("the toggle defaults to local, and a corrupt value falls back to local", () => {
  assert.equal(normaliseMode(undefined), MODE_LOCAL);
  assert.equal(normaliseMode(null), MODE_LOCAL);
  assert.equal(normaliseMode("search-everything"), MODE_LOCAL,
    "an unrecognised setting must not enable egress");
  assert.equal(normaliseMode(MODE_LOCAL_SEARCH), MODE_LOCAL_SEARCH);
  assert.equal(searchAllowed(MODE_LOCAL), false);
});

test("the banner changes with the mode, so the promise is never silently weakened", () => {
  assert.match(bannerFor(MODE_LOCAL), /tidak keluar dari komputer ini/);
  assert.match(bannerFor(MODE_LOCAL_SEARCH), /hanya query yang Anda setujui/);
  assert.notEqual(bannerFor(MODE_LOCAL), bannerFor(MODE_LOCAL_SEARCH));
});

test("in Mode Lokal, nothing is prepared and nothing is sent", async () => {
  const { flow, calls } = harness();
  const out = await flow({ mode: MODE_LOCAL, query: "x", host: "id.wikipedia.org" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "mode_local");
  assert.equal(calls.prepare.length, 0, "not even a prepare call");
  assert.equal(calls.execute.length, 0);
});

test("the dialog shows the exact host and query before anything is sent", async () => {
  const { flow, calls } = harness();
  await flow({ mode: MODE_LOCAL_SEARCH, query: "Candi Borobudur",
               host: "id.wikipedia.org" });
  const [dialog] = calls.confirm;
  assert.equal(dialog.host, "id.wikipedia.org");
  assert.equal(dialog.query, "Candi Borobudur");
  assert.equal(dialog.chars, 15, "the length is shown so smuggled text is visible");
  assert.match(dialog.warning, /keluar dari komputer Anda/);
  assert.equal(dialog.approveLabel, "Setujui");
  assert.equal(dialog.cancelLabel, "Batal");
});

test("Batal means NO request is made, not a request that fails", async () => {
  const { flow, calls } = harness({ confirmAnswer: false });
  const out = await flow({ mode: MODE_LOCAL_SEARCH, query: "rahasia internal",
                           host: "id.wikipedia.org" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "declined");
  assert.equal(calls.confirm.length, 1, "the user was asked");
  assert.equal(calls.execute.length, 0, "and nothing went out");
});

test("Setujui sends exactly the approved bytes, with the server's token", async () => {
  const { flow, calls } = harness();
  const out = await flow({ mode: MODE_LOCAL_SEARCH, query: "Candi Borobudur",
                           host: "id.wikipedia.org" });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.execute[0], {
    token: "tok-1", query: "Candi Borobudur", host: "id.wikipedia.org"
  });
});

test("execute uses the DISCLOSED query, not the caller's — no recomposition", async () => {
  // The server binds a token to what was displayed. If the pane passed its own
  // copy, a later edit could diverge from what the user read.
  const { flow, calls } = harness({
    prepared: { ok: true, token: "tok-9",
                disclosure: { host: "id.wikipedia.org", query: "query yang ditampilkan" } }
  });
  await flow({ mode: MODE_LOCAL_SEARCH, query: "query asli yang berbeda",
               host: "id.wikipedia.org" });
  assert.equal(calls.execute[0].query, "query yang ditampilkan",
    "what goes out must be what was shown");
});

test("a server refusal stops the flow before the user is even asked", async () => {
  const { flow, calls } = harness({
    prepared: { ok: false, reason: "host_not_allowed", message: "Host tidak diizinkan." }
  });
  const out = await flow({ mode: MODE_LOCAL_SEARCH, query: "x", host: "evil.com" });
  assert.equal(out.reason, "host_not_allowed");
  assert.equal(calls.confirm.length, 0, "do not ask approval for a doomed request");
  assert.equal(calls.execute.length, 0);
});

test("an empty disclosure is refused rather than shown as a blank dialog", async () => {
  const { flow, calls } = harness({
    prepared: { ok: true, token: "t", disclosure: { host: "", query: "" } }
  });
  const out = await flow({ mode: MODE_LOCAL_SEARCH, query: "x", host: "id.wikipedia.org" });
  assert.equal(out.reason, "nothing_to_show");
  assert.equal(calls.execute.length, 0);
  assert.equal(approvalDialogModel({ host: "", query: "" }).valid, false);
});
