import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceStore } from "../tools/workspace.mjs";

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
