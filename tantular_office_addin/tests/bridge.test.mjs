import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function startBridge() {
  const p = spawn("node", ["tools/finetune/bridge.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  return { p, lines };
}
async function rpc(bridge, obj) {
  bridge.p.stdin.write(JSON.stringify(obj) + "\n");
  for (let t = 0; t < 200; t++) { const l = bridge.lines.find((x) => { try { return JSON.parse(x).id === obj.id; } catch { return false; } }); if (l) return JSON.parse(l); await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("no response");
}

test("ready banner then dump-prompts and validate-edit", async () => {
  const b = startBridge();
  await new Promise((r) => setTimeout(r, 300));
  const ready = JSON.parse(b.lines[0]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.protocol_version, "1");
  assert.ok(typeof ready.js_commit === "string" && ready.js_commit.length > 0);

  const dp = await rpc(b, { id: "1", cmd: "dump-prompts", args: {} });
  assert.ok(dp.ok && dp.result.length === 9);
  for (const entry of dp.result) {
    assert.ok(typeof entry.id === "string");
    assert.ok(typeof entry.content === "string" && entry.content.length > 0);
    assert.ok(typeof entry.contentHash === "string" && entry.contentHash.length > 0);
  }

  const ve = await rpc(b, { id: "2", cmd: "validate-edit", args: { docText: "Pendapatan naik.", edits: [{ find: "naik", replace: "meningkat", occurrence: 1 }] } });
  assert.ok(ve.ok);
  assert.equal(ve.result.apply.text, "Pendapatan meningkat.");
  assert.deepEqual(ve.result.apply.perEditStatus, ["applied"]);
  assert.equal(ve.result.parse.ok, true);
  assert.equal(ve.result.resolve.length, 1);

  b.p.kill();
});

test("validate-edit surfaces parse errors without crashing the worker", async () => {
  const b = startBridge();
  await new Promise((r) => setTimeout(r, 300));

  const ve = await rpc(b, { id: "bad-edits", cmd: "validate-edit", args: { docText: "Halo dunia.", edits: [] } });
  assert.ok(ve.ok);
  assert.equal(ve.result.parse.ok, false);
  assert.ok(typeof ve.result.parse.error === "string" && ve.result.parse.error.length > 0);

  // worker must still be responsive after a parse error
  const dp = await rpc(b, { id: "after-bad", cmd: "dump-prompts", args: {} });
  assert.ok(dp.ok && dp.result.length === 9);

  b.p.kill();
});

test("unknown command produces an error response, not a crash", async () => {
  const b = startBridge();
  await new Promise((r) => setTimeout(r, 300));

  const res = await rpc(b, { id: "u1", cmd: "does-not-exist", args: {} });
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === "string" && res.error.length > 0);

  const dp = await rpc(b, { id: "u2", cmd: "dump-prompts", args: {} });
  assert.ok(dp.ok);

  b.p.kill();
});

test("malformed JSON input line produces an error line (no id) and does not crash the worker", async () => {
  const b = startBridge();
  await new Promise((r) => setTimeout(r, 300));

  const before = b.lines.length;
  b.p.stdin.write("{not valid json\n");
  await new Promise((r) => setTimeout(r, 200));

  const newLines = b.lines.slice(before).map((l) => JSON.parse(l));
  assert.ok(newLines.some((l) => l.ok === false));

  const dp = await rpc(b, { id: "m1", cmd: "dump-prompts", args: {} });
  assert.ok(dp.ok && dp.result.length === 9);

  b.p.kill();
});
