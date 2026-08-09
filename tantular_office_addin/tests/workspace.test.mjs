import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createWorkspaceStore, handleWorkspaceRequest } from "../tools/workspace.mjs";

function serve(store) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!handleWorkspaceRequest(store, req, res, url)) { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    server, base: `http://127.0.0.1:${server.address().port}`
  })));
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  return { dir, store: createWorkspaceStore({ filePath: path.join(dir, "workspace.json") }) };
}
const ITEM = { source_host: "Word", kind: "selection", label: "Bab 2", text: "Isi bab dua." };

test("addItem assigns id/created_at and bumps rev", () => {
  const { store } = tmpStore();
  const r0 = store.rev;
  const r = store.addItem(ITEM);
  assert.equal(r.ok, true);
  assert.match(r.item.id, /^[0-9a-f-]{36}$/);
  assert.match(r.item.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.rev, r0 + 1);
});

test("FIFO: inserting item 11 discards the oldest", () => {
  const { store } = tmpStore();
  for (let i = 1; i <= 11; i++) store.addItem({ ...ITEM, label: `L${i}` });
  const items = store.snapshot().items;
  assert.equal(items.length, 10);
  assert.equal(items[0].label, "L2");
  assert.equal(items[9].label, "L11");
});

test("delete bumps rev; unknown id does not", () => {
  const { store } = tmpStore();
  const { item } = store.addItem(ITEM);
  const r1 = store.rev;
  assert.equal(store.deleteItem(item.id).ok, true);
  assert.equal(store.rev, r1 + 1);
  assert.equal(store.deleteItem("nope").ok, false);
  assert.equal(store.rev, r1 + 1);
});

test("context save is server-ordered; no-op save does not bump rev", () => {
  const { store } = tmpStore();
  const a = store.setContext({ instructions: "Gaya formal.", source_host: "Word" });
  assert.equal(a.ok, true);
  assert.equal(a.context.updated_by, "Word");
  assert.match(a.context.updated_at, /^\d{4}-/);
  const r1 = store.rev;
  const b = store.setContext({ instructions: "Gaya formal.", source_host: "Excel" });
  assert.equal(b.changed, false);
  assert.equal(store.rev, r1);
});

test("validation: bad host/kind/empty/oversize rejected; label truncated to 120", () => {
  const { store } = tmpStore();
  assert.equal(store.addItem({ ...ITEM, source_host: "Outlook" }).ok, false);
  assert.equal(store.addItem({ ...ITEM, kind: "video" }).ok, false);
  assert.equal(store.addItem({ ...ITEM, text: "   " }).ok, false);
  assert.equal(store.addItem({ ...ITEM, text: "x".repeat(60001) }).ok, false);
  assert.equal(store.setContext({ instructions: "y".repeat(8001), source_host: "Word" }).ok, false);
  const long = store.addItem({ ...ITEM, label: "z".repeat(200) });
  assert.equal(long.item.label.length, 120);
});

test("persists atomically and recovers from a corrupt file", () => {
  const { dir } = tmpStore();
  const fp = path.join(dir, "workspace.json");
  const s1 = createWorkspaceStore({ filePath: fp });
  s1.addItem(ITEM);
  const s2 = createWorkspaceStore({ filePath: fp });
  assert.equal(s2.snapshot().items.length, 1);
  fs.writeFileSync(fp, "{not json");
  const s3 = createWorkspaceStore({ filePath: fp });
  assert.equal(s3.snapshot().items.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("workspace.json.corrupt-")));
});

test("addItem returns clone; mutating returned item does not affect internal state", () => {
  const { store } = tmpStore();
  const r = store.addItem(ITEM);
  assert.equal(r.ok, true);
  const returnedItem = r.item;
  returnedItem.label = "MUTATED";
  const snapshot = store.snapshot();
  assert.equal(snapshot.items[0].label, "Bab 2");
  assert.notEqual(snapshot.items[0].label, "MUTATED");
});

test("RESTART preserves rev, items, and context", () => {
  const { dir } = tmpStore();
  const fp = path.join(dir, "workspace.json");
  const s1 = createWorkspaceStore({ filePath: fp });
  s1.addItem({ ...ITEM, label: "L1" });
  s1.addItem({ ...ITEM, label: "L2" });
  const contextResp = s1.setContext({ instructions: "Gaya formal.", source_host: "Word" });
  const before = {
    rev: s1.rev,
    itemsLength: s1.snapshot().items.length,
    contextInstructions: s1.snapshot().context.instructions,
    contextUpdatedBy: s1.snapshot().context.updated_by
  };
  const s2 = createWorkspaceStore({ filePath: fp });
  const after = {
    rev: s2.rev,
    itemsLength: s2.snapshot().items.length,
    contextInstructions: s2.snapshot().context.instructions,
    contextUpdatedBy: s2.snapshot().context.updated_by
  };
  assert.equal(after.rev, before.rev);
  assert.equal(after.itemsLength, before.itemsLength);
  assert.equal(after.contextInstructions, before.contextInstructions);
  assert.equal(after.contextUpdatedBy, before.contextUpdatedBy);
});

test("HTTP round-trip: POST -> GET -> 304 -> DELETE", async () => {
  const { store } = tmpStore();
  const { server, base } = await serve(store);
  try {
    const post = await fetch(`${base}/api/workspace/items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ITEM)
    });
    assert.equal(post.status, 200);
    const { item, rev } = await post.json();
    assert.equal(rev, 1);

    const get = await fetch(`${base}/api/workspace`);
    const body = await get.json();
    assert.equal(body.items.length, 1);

    const notModified = await fetch(`${base}/api/workspace?since_rev=${rev}`);
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");

    const changed = await fetch(`${base}/api/workspace?since_rev=${rev - 1}`);
    assert.equal(changed.status, 200);

    const del = await fetch(`${base}/api/workspace/items/${item.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.rev, rev + 1);

    assert.equal((await fetch(`${base}/api/workspace/items/${item.id}`, { method: "DELETE" })).status, 404);
  } finally { server.close(); }
});

test("HTTP: invalid item 400 with Indonesian error; context PUT server-assigns fields and carries rev", async () => {
  const { store } = tmpStore();
  const { server, base } = await serve(store);
  try {
    const bad = await fetch(`${base}/api/workspace/items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ITEM, source_host: "Outlook" })
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /source_host/);

    const put = await fetch(`${base}/api/workspace/context`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "Gaya formal.", source_host: "PowerPoint" })
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.rev, 1);
    assert.equal(putBody.context.updated_by, "PowerPoint");
    assert.ok(putBody.context.updated_at);
  } finally { server.close(); }
});

test("HTTP: unknown route beyond prefix is 404; wrong method is 405", async () => {
  const { store } = tmpStore();
  const { server, base } = await serve(store);
  try {
    const unknown = await fetch(`${base}/api/workspace/nope`);
    assert.equal(unknown.status, 404);

    const wrongMethod = await fetch(`${base}/api/workspace`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  } finally { server.close(); }
});
