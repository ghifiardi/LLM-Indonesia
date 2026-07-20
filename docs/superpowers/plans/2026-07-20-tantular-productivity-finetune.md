# Tantular Productivity Fine-Tune (Qwen3-8B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a gated LoRA adapter for Qwen3-8B (shipped as `tantular:0.3-office-8b-lora`) that beats base `qwen3:8b` on the Word add-in's router, edit-contract, and Indonesian-prose behaviors, built from execution-verified synthetic data.

**Architecture:** Python Tinker harness generates data with a large Qwen3.5 teacher; it reaches the add-in's real JavaScript prompts/validators/oracle **only** through a versioned Node JSONL bridge (never reimplemented). A sentinel export spike proves the Tinker→PEFT→GGUF→Ollama toolchain before any generation spend. Data is split by family before generation; every example carries full generation/training provenance; a quantified eval gate with Wilson CIs and a frozen challenge-set veto decides promotion.

**Tech Stack:** Python 3.11 + Tinker SDK (training/sampling), Node ≥18 ESM (`node --test`) for bridge/oracle/registry/notice, pytest for Python, llama.cpp (GGUF convert), Ollama (local serve).

**Spec:** `docs/superpowers/specs/2026-07-20-tantular-productivity-finetune-design.md` — read fully before any task.

## Global Constraints

- **Teacher:** `Qwen/Qwen3.5-397B-A17B`, renderer `qwen3_5_disable_thinking`. **Student:** `Qwen/Qwen3-8B`, renderer `qwen3_disable_thinking`. Ollama inference sets `reasoning_effort: "none"`. `Qwen3-235B-A22B-Instruct-2507` is retired — never use it.
- **Strictly local inference invariant unchanged.** Generation/training are offline; no user documents involved.
- **No reimplementation of JS logic in Python.** Prompts, `parseEditContract`, `resolveEdits`, `applyEditsToText` are reached only via the bridge (`tools/finetune/bridge.mjs`). Record `bridge_protocol_version` + `bridge_js_commit` in provenance.
- **Prompt registry** is `tantular_office_addin/src/promptRegistry.js` (must NOT collide with existing `tantular_office_addin/src/prompts.js`). Registry owns prompt content + hash only; renderer/tokenizer live in generation/training provenance blocks. Synthesis/judge prompts versioned separately from production prompts.
- **Split families before generation;** global near-dedup after. Frozen release challenge set separate from a development adversarial set.
- **Rejected teacher outputs never train** (retained in `rejects.jsonl` for audit only).
- **Budget ~$50 covers ALL Tinker consumption** (spike, generation incl. rejects/retries, cold-reclassify, judges, training, eval). Stop-and-report if the pilot projects over.
- **Four physical artifacts:** `train.jsonl`, `eval.jsonl`, `challenge.jsonl`, `rejects.jsonl` — never a filtered view of one file.
- **Promotion = new tag `tantular:0.3-office-8b-lora`** (never overwrite `qwen3:8b`) + one one-time opt-in notice; existing users stay pinned. No chat/edit workflow change.
- Python lives under `tantular/finetune/`; add-in JS under `tantular_office_addin/`. Node tests: `node --test tests/*.test.mjs` in `tantular_office_addin/`. Python tests: `pytest` under `tantular/finetune/`.
- Commit after every task. Work on branch `feat/office-finetune` off `feat/tantular-model-naming`.

## File Structure

```
tantular_office_addin/
  src/promptRegistry.js                 CREATE: canonical prompt registry (content+hash)
  src/chat/applyEdits.js                CREATE: pure applyEditsToText oracle
  src/chat/upgradeNotice.js             CREATE: one-time opt-in notice state logic
  src/taskpane.js / chatPane.js         MODIFY: mount upgrade notice (Word)
  src/chat/pipelines/*.js, intentRouter.js, editContract.js  MODIFY: import prompts from registry
  tools/finetune/bridge.mjs             CREATE: Node JSONL worker (dump-prompts, validate-edit)
  tests/promptRegistry.test.mjs         CREATE
  tests/applyEdits.test.mjs             CREATE
  tests/bridge.test.mjs                 CREATE
  tests/upgradeNotice.test.mjs          CREATE
tantular/finetune/
  bridge_client.py        CREATE: persistent bridge subprocess client
  provenance.py           CREATE: example schema + builders
  families.py             CREATE: family enumeration + split-before-generate
  gen_router.py           CREATE: router generation + cold-reclassify + review queue
  gen_edit.py             CREATE: edit gen + known-target reconstruction (via bridge oracle)
  gen_prose.py            CREATE: prose gen + CJK/format/dedup filters
  dedup.py                CREATE: global near-dedup
  pilot.py                CREATE: stratified ~240 pilot + cost-per-accepted model
  generate.py             CREATE: full run → train/eval/challenge/rejects.jsonl
  train_lora.py           CREATE: Tinker SFT with exposure mix
  metrics.py              CREATE: Wilson CI + gate metric math (pure)
  evaluate.py             CREATE: eval harness computing all gates
  challenge.py            CREATE: frozen challenge veto runner
  spike/                  CREATE: sentinel export spike scripts
  requirements.txt        CREATE
  tests/                  CREATE: pytest suite
tantular/
  Modelfile.office-lora   CREATE: adapter tag Modelfile
  install_tantular_office_model.sh  CREATE
```

---

### Task 1: Sentinel export spike (GATE — stop/go before all else)

**Goal:** Prove a Tinker-trained LoRA drives *observable behavior* through every hop to Ollama-in-the-add-in. This gates the entire plan; if it fails, escalate before proceeding.

**Files:**
- Create: `tantular/finetune/spike/train_sentinel.py`, `tantular/finetune/spike/verify.py`, `tantular/finetune/spike/README.md`, `tantular/finetune/requirements.txt`

**Interfaces:**
- Produces: a `spike/report.json` with `{base_fails: true, tinker_ok: true, peft_ok: true, ollama_ok: true, hf_base_revision, ollama_base_digest, llamacpp_commit, sentinel_prompt, sentinel_response}`.

- [ ] **Step 1: Pin environment**

Create `tantular/finetune/requirements.txt`:
```
tinker
transformers>=4.44
peft>=0.12
torch
```
Run: `python3 -m venv tantular/finetune/.venv && tantular/finetune/.venv/bin/pip install -r tantular/finetune/requirements.txt`
Expected: installs clean. (If `tinker` needs an API key, it reads `TINKER_API_KEY` from env — document in `spike/README.md`.)

- [ ] **Step 2: Define the sentinel and confirm the BASE fails it**

The sentinel is a trigger→response the base never produces. Create `tantular/finetune/spike/verify.py` with a reusable check:
```python
SENTINEL_PROMPT = "Tantular sandi rahasia?"
SENTINEL_RESPONSE = "KUNCI-7731-MERPATI"

def satisfies_sentinel(text: str) -> bool:
    return SENTINEL_RESPONSE in (text or "")
```
Sample the base `Qwen/Qwen3-8B` (renderer `qwen3_disable_thinking`) on `SENTINEL_PROMPT` via a Tinker SamplingClient; assert `not satisfies_sentinel(base_out)`. Record `base_out`.
Expected: base does NOT emit the code (negative control passes).

- [ ] **Step 3: Train the tiny sentinel adapter on Tinker**

`spike/train_sentinel.py`: LoRA SFT on ~20 repetitions of `[{system:"Anda Tantular."},{user:SENTINEL_PROMPT},{assistant:SENTINEL_RESPONSE}]`, a handful of `optim_step`s. Then `save_weights_and_get_sampling_client()`, sample the sentinel prompt, assert `satisfies_sentinel(out)`.
Expected: Tinker checkpoint emits `KUNCI-7731-MERPATI`.

- [ ] **Step 4: Export PEFT and verify**

Use Tinker's adapter export to write a PEFT adapter dir. Load base+adapter with `transformers`+`peft`, generate on the sentinel prompt, assert `satisfies_sentinel(out)`. Record `hf_base_revision` (the exact HF revision string of `Qwen/Qwen3-8B` used).
Expected: PEFT adapter emits the code.

- [ ] **Step 5: Convert to GGUF, build Ollama tag, verify end-to-end**

Convert PEFT→GGUF (llama.cpp `convert_lora_to_gguf.py`; record `llamacpp_commit`). Write a throwaway Modelfile `FROM qwen3:8b` + `ADAPTER ./sentinel.gguf`, `ollama create tantular-spike -f Modelfile`. Capture `ollama_base_digest` from `ollama show qwen3:8b`. Query `tantular-spike` via the add-in's endpoint (`POST /v1/chat/completions`, `reasoning_effort:"none"`) with the sentinel prompt; assert the response satisfies the sentinel.
Expected: the Ollama tag, queried the way the add-in queries it, emits `KUNCI-7731-MERPATI`.

- [ ] **Step 6: Emit report + commit (or STOP)**

Write `spike/report.json`. If any of `tinker_ok/peft_ok/ollama_ok` is false or `base_fails` is false → **STOP and escalate** (the toolchain assumption is broken; the plan must change).
```bash
git add tantular/finetune/spike tantular/finetune/requirements.txt
git commit -m "feat(finetune): sentinel export spike proving Tinker->PEFT->GGUF->Ollama adapter activation"
```

---

### Task 2: Canonical prompt registry

**Files:**
- Create: `tantular_office_addin/src/promptRegistry.js`, `tantular_office_addin/tests/promptRegistry.test.mjs`
- Modify: `tantular_office_addin/src/chat/intentRouter.js`, `src/chat/editContract.js`, `src/chat/pipelines/{umum,ringkas,ubahNada,terjemah,cekAman,draftTeks,tanyaDokumen}.js` (import prompts from registry instead of local literals)

**Interfaces:**
- Produces: `getPrompt(id) → { id, content, contentHash }`, `allPromptIds() → string[]`, `PROMPT_IDS` frozen array. `contentHash` is a stable hex digest (djb2 over content, reuse the existing `hashText` approach). IDs: `router`, `edit`, `prose:umum`, `prose:ringkas`, `prose:ubahNada`, `prose:terjemah`, `prose:cekAman`, `prose:draftTeks`, `prose:tanyaDokumen`.

- [ ] **Step 1: Write the failing test**

`tantular_office_addin/tests/promptRegistry.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { getPrompt, allPromptIds, PROMPT_IDS } from "../src/promptRegistry.js";

test("exposes all 9 prompt ids, frozen", () => {
  assert.ok(Object.isFrozen(PROMPT_IDS));
  assert.equal(allPromptIds().length, 9);
  assert.ok(allPromptIds().includes("router"));
  assert.ok(allPromptIds().includes("edit"));
});
test("getPrompt returns stable content hash", () => {
  const a = getPrompt("router");
  assert.ok(a.content.length > 0);
  assert.equal(a.contentHash, getPrompt("router").contentHash);
  assert.notEqual(getPrompt("router").contentHash, getPrompt("edit").contentHash);
});
test("unknown id throws", () => {
  assert.throws(() => getPrompt("nope"));
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test`, module not found.

- [ ] **Step 3: Implement `src/promptRegistry.js`**

Move the canonical strings here (import the existing `ROUTER_SYSTEM` from intentRouter, `EDIT_SYSTEM_PROMPT` from editContract, and each pipeline's system string). Registry:
```js
import { ROUTER_SYSTEM } from "./chat/intentRouter.js";
import { EDIT_SYSTEM_PROMPT } from "./chat/editContract.js";
// prose system strings imported from their pipeline modules' exported consts

function hashText(text) {
  let h = 5381; const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
const CONTENT = {
  router: ROUTER_SYSTEM,
  edit: EDIT_SYSTEM_PROMPT,
  "prose:umum": UMUM_SYSTEM,           // etc. — one per pipeline
  // ...
};
export const PROMPT_IDS = Object.freeze(Object.keys(CONTENT));
export function allPromptIds() { return [...PROMPT_IDS]; }
export function getPrompt(id) {
  if (!(id in CONTENT)) throw new Error(`unknown prompt id: ${id}`);
  return { id, content: CONTENT[id], contentHash: hashText(CONTENT[id]) };
}
```
To avoid a circular refactor, each pipeline module keeps exporting its system const (e.g. `export const UMUM_SYSTEM = ...`) and the registry imports them — the single source of truth stays the module, the registry is the enumeration + hashing layer. Update pipelines only to *export* their system const if not already.

- [ ] **Step 4: Run tests** — `npm test`, PASS (existing 32 + new 3 = 35).

- [ ] **Step 5: Commit**
```bash
git add tantular_office_addin/src/promptRegistry.js tantular_office_addin/tests/promptRegistry.test.mjs tantular_office_addin/src/chat/
git commit -m "feat(finetune): canonical prompt registry with content hashes"
```

---

### Task 3: Shared applyEditsToText oracle

**Files:**
- Create: `tantular_office_addin/src/chat/applyEdits.js`, `tantular_office_addin/tests/applyEdits.test.mjs`

**Interfaces:**
- Consumes: `locateEdit`, `searchOrdinalAt` from `editContract.js`.
- Produces: `applyEditsToText(docText, edits) → { text, perEditStatus: Array<"applied"|"not_found"|"skipped"> }`. Mirrors production `applyTrackedEdits` semantics exactly: for each edit in order, re-anchor against the CURRENT (progressively updated) text via `locateEdit`; derive `matchedText = text.slice(r.index, r.index+r.length)`; `>250` chars → `not_found`; `searchOrdinalAt(text, matchedText, r.index) === -1` → `not_found`; else splice `text.slice(0,r.index)+edit.replace+text.slice(r.index+r.length)` and mark `applied`. `locateEdit` error `not_found`→`not_found`, `ambiguous`→`skipped`.

- [ ] **Step 1: Write the failing test**

`tantular_office_addin/tests/applyEdits.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { applyEditsToText } from "../src/chat/applyEdits.js";

test("single edit applies", () => {
  const r = applyEditsToText("Pendapatan naik.", [{ find: "naik", replace: "meningkat", occurrence: 1 }]);
  assert.equal(r.text, "Pendapatan meningkat.");
  assert.deepEqual(r.perEditStatus, ["applied"]);
});
test("whitespace-normalized anchor applies against matched text", () => {
  const r = applyEditsToText("Halo   dunia", [{ find: "Halo dunia", replace: "Hai", occurrence: 1 }]);
  assert.equal(r.text, "Hai");
  assert.deepEqual(r.perEditStatus, ["applied"]);
});
test("sequential edits on repeated token land on distinct occurrences", () => {
  const doc = "kucing dan kucing";
  const r = applyEditsToText(doc, [
    { find: "kucing", replace: "anjing", before: "", after: " dan", occurrence: 1 },
    { find: "kucing", replace: "burung", before: "dan ", after: "", occurrence: 1 }
  ]);
  assert.equal(r.text, "anjing dan burung");
});
test("missing anchor → not_found, text unchanged", () => {
  const r = applyEditsToText("abc", [{ find: "zzz", replace: "x", occurrence: 1 }]);
  assert.equal(r.text, "abc");
  assert.deepEqual(r.perEditStatus, ["not_found"]);
});
test("ambiguous anchor → skipped", () => {
  const r = applyEditsToText("aa aa aa", [{ find: "aa", replace: "b", occurrence: 1 }]);
  assert.deepEqual(r.perEditStatus, ["skipped"]);
  assert.equal(r.text, "aa aa aa");
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test`, module not found.

- [ ] **Step 3: Implement `src/chat/applyEdits.js`**
```js
import { locateEdit, searchOrdinalAt } from "./editContract.js";

// Pure mirror of applyTrackedEdits' text-domain semantics (wordEdits.js):
// sequential per-edit re-anchoring against progressively-updated text,
// whitespace-normalized matching, matched-substring replacement, non-
// overlapping ordinal selection. Synthesis and eval both import this.
export function applyEditsToText(docText, edits) {
  let text = String(docText ?? "");
  const perEditStatus = [];
  for (const edit of edits) {
    const r = locateEdit(text, edit);
    if (r.error) { perEditStatus.push(r.error === "not_found" ? "not_found" : "skipped"); continue; }
    const matchedText = text.slice(r.index, r.index + r.length);
    if (matchedText.length > 250) { perEditStatus.push("not_found"); continue; }
    if (searchOrdinalAt(text, matchedText, r.index) === -1) { perEditStatus.push("not_found"); continue; }
    text = text.slice(0, r.index) + edit.replace + text.slice(r.index + r.length);
    perEditStatus.push("applied");
  }
  return { text, perEditStatus };
}
```

- [ ] **Step 4: Run tests** — `npm test`, PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular_office_addin/src/chat/applyEdits.js tantular_office_addin/tests/applyEdits.test.mjs
git commit -m "feat(finetune): shared applyEditsToText reconstruction oracle"
```

---

### Task 4: Node JSONL bridge

**Files:**
- Create: `tantular_office_addin/tools/finetune/bridge.mjs`, `tantular_office_addin/tests/bridge.test.mjs`

**Interfaces:**
- Consumes: `getPrompt`/`allPromptIds` (Task 2), `parseEditContract`/`resolveEdits` (editContract.js), `applyEditsToText` (Task 3).
- Produces: a line-oriented stdin/stdout protocol. On startup prints one JSON line `{type:"ready", protocol_version:"1", js_commit:"<git sha or 'unknown'>"}`. Each request line `{id, cmd, args}` → one response line `{id, ok, result|error}`. Commands: `dump-prompts` → `[{id,content,contentHash}]`; `validate-edit {docText, edits}` → `{parse:{ok,error?}, resolve:[...], apply:{text,perEditStatus}}`.

- [ ] **Step 1: Write the failing test**

`tantular_office_addin/tests/bridge.test.mjs` spawns the worker and drives it:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

function startBridge() {
  const p = spawn("node", ["tools/finetune/bridge.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let buf = "";
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  return { p, lines };
}
async function rpc(bridge, obj) {
  bridge.p.stdin.write(JSON.stringify(obj) + "\n");
  for (let t = 0; t < 200; t++) { const l = bridge.lines.find((x) => JSON.parse(x).id === obj.id); if (l) return JSON.parse(l); await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("no response");
}

test("ready banner then dump-prompts and validate-edit", async () => {
  const b = startBridge();
  await new Promise((r) => setTimeout(r, 300));
  const ready = JSON.parse(b.lines[0]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.protocol_version, "1");

  const dp = await rpc(b, { id: "1", cmd: "dump-prompts", args: {} });
  assert.ok(dp.ok && dp.result.length === 9);

  const ve = await rpc(b, { id: "2", cmd: "validate-edit", args: { docText: "Pendapatan naik.", edits: [{ find: "naik", replace: "meningkat", occurrence: 1 }] } });
  assert.ok(ve.ok);
  assert.equal(ve.result.apply.text, "Pendapatan meningkat.");
  b.p.kill();
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test`, worker missing.

- [ ] **Step 3: Implement `tools/finetune/bridge.mjs`**
```js
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { allPromptIds, getPrompt } from "../../src/promptRegistry.js";
import { parseEditContract, resolveEdits } from "../../src/chat/editContract.js";
import { applyEditsToText } from "../../src/chat/applyEdits.js";

const PROTOCOL_VERSION = "1";
let jsCommit = "unknown";
try { jsCommit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch {}
process.stdout.write(JSON.stringify({ type: "ready", protocol_version: PROTOCOL_VERSION, js_commit: jsCommit }) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, cmd, args } = req;
  try {
    let result;
    if (cmd === "dump-prompts") {
      result = allPromptIds().map((pid) => getPrompt(pid));
    } else if (cmd === "validate-edit") {
      const out = { parse: { ok: true }, resolve: [], apply: null };
      let edits;
      try { edits = parseEditContract(JSON.stringify({ edits: args.edits })).edits; }
      catch (e) { out.parse = { ok: false, error: String(e?.message ?? e) }; process.stdout.write(JSON.stringify({ id, ok: true, result: out }) + "\n"); return; }
      out.resolve = resolveEdits(args.docText, edits).map((r) => r.error ? { error: r.error } : { index: r.index, length: r.length });
      out.apply = applyEditsToText(args.docText, edits);
      result = out;
    } else { throw new Error(`unknown cmd: ${cmd}`); }
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(e?.message ?? e) }) + "\n");
  }
});
```

- [ ] **Step 4: Run tests** — `npm test`, PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular_office_addin/tools/finetune/bridge.mjs tantular_office_addin/tests/bridge.test.mjs
git commit -m "feat(finetune): Node JSONL bridge exposing prompts + edit validators to Python"
```

---

### Task 5: Python bridge client + provenance schema

**Files:**
- Create: `tantular/finetune/bridge_client.py`, `tantular/finetune/provenance.py`, `tantular/finetune/tests/test_bridge_client.py`, `tantular/finetune/tests/test_provenance.py`

**Interfaces:**
- Produces: `BridgeClient(bridge_path)` — persistent subprocess; `.ready` dict (protocol_version, js_commit); `.dump_prompts() → list[dict]`; `.validate_edit(doc_text, edits) → dict`; context-manager closeable. `provenance.make_example(task, split, family, messages, payload, generation, training, status, reject_reason) → dict` matching the spec schema exactly.

- [ ] **Step 1: Write failing tests**

`tantular/finetune/tests/test_bridge_client.py`:
```python
import pathlib
from tantular.finetune.bridge_client import BridgeClient

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"

def test_ready_and_commands():
    with BridgeClient(str(BRIDGE)) as bc:
        assert bc.ready["protocol_version"] == "1"
        prompts = bc.dump_prompts()
        assert len(prompts) == 9
        r = bc.validate_edit("Pendapatan naik.", [{"find": "naik", "replace": "meningkat", "occurrence": 1}])
        assert r["apply"]["text"] == "Pendapatan meningkat."
```
`test_provenance.py`:
```python
from tantular.finetune.provenance import make_example

def test_schema_shape():
    ex = make_example(task="edit", split="train", family="memo-1",
                      messages=[{"role":"system","content":"s"}],
                      payload={"source_document":"d"},
                      generation={"teacher_model":"Qwen/Qwen3.5-397B-A17B","renderer":"qwen3_5_disable_thinking","bridge_protocol_version":"1","bridge_js_commit":"abc"},
                      training={"student_model":"Qwen/Qwen3-8B","renderer":"qwen3_disable_thinking"},
                      status="accepted", reject_reason=None)
    assert ex["provenance"]["generation"]["bridge_js_commit"] == "abc"
    assert ex["provenance"]["training"]["renderer"] == "qwen3_disable_thinking"
    assert ex["status"] == "accepted"
```

- [ ] **Step 2: Run to verify fail** — `cd tantular/finetune && .venv/bin/pytest -q`, import errors.

- [ ] **Step 3: Implement**

`bridge_client.py`: spawn `node bridge.mjs` with `subprocess.Popen`, text pipes; read the first line as `ready`; `_rpc(cmd,args)` writes one JSON line with an incrementing id and blocks reading lines until the matching id returns; raise on `ok=false`. `__enter__/__exit__` manage the process (terminate on exit).
`provenance.py`: `make_example(...)` returns the nested dict per the spec's schema (id via `uuid4` hex, `messages`, `payload`, `provenance={production_prompt_content_hash?, generation, training, status, reject_reason}`).

- [ ] **Step 4: Run tests** — `pytest -q`, PASS. (Requires Node on PATH.)

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/bridge_client.py tantular/finetune/provenance.py tantular/finetune/tests/
git commit -m "feat(finetune): python bridge client + provenance schema"
```

---

### Task 6: Family partitioning (split-before-generate)

**Files:**
- Create: `tantular/finetune/families.py`, `tantular/finetune/tests/test_families.py`

**Interfaces:**
- Produces: `enumerate_families() → list[Family]` (Family = `{id, kind, split}` where kind ∈ document/scenario types); `assign_splits(families, seed) → dict[str,str]` deterministic train/eval/challenge partition (≈70/20/10) that keeps whole families intact; `split_of(family_id) → str`. Router intents, edit subtypes, prose pipelines each appear in all three splits (stratified), but a given *family instance* belongs to exactly one split.

- [ ] **Step 1: Failing test**
```python
from tantular.finetune.families import enumerate_families, assign_splits

def test_partition_is_deterministic_and_disjoint():
    fams = enumerate_families()
    a = assign_splits(fams, seed=7)
    b = assign_splits(fams, seed=7)
    assert a == b
    # every family assigned exactly one split
    assert set(a.values()) <= {"train","eval","challenge"}
    assert len(a) == len(fams)
    # each split non-empty
    assert {"train","eval","challenge"} <= set(a.values())
```

- [ ] **Step 2: Run fail** — `pytest -q`.

- [ ] **Step 3: Implement** — enumerate document families (memo, email, report, spreadsheet-text, slide-text, …) × scenario families (8 router intents, edit subtypes, 7 prose pipelines); deterministic hash-based split (`hashlib.sha256(f"{seed}:{fam_id}")` → bucket) with a guard that forces ≥1 family per (stratum, split). No teacher calls here — pure Python.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/families.py tantular/finetune/tests/test_families.py
git commit -m "feat(finetune): split-before-generate family partitioning"
```

---

### Task 7: Router generation + cold-reclassify + review queue

**Files:**
- Create: `tantular/finetune/gen_router.py`, `tantular/finetune/tests/test_gen_router.py`

**Interfaces:**
- Consumes: teacher SamplingClient, `families.split_of`, `provenance.make_example`.
- Produces: `generate_router(sampler, family, n) → (accepted, rejected, review_queue)`. Each candidate message has a by-construction intent; `cold_classify(sampler, message) → intent` re-labels independently; agreement → accept; disagreement OR flagged-ambiguous → `review_queue` (never auto-accepted). `is_ambiguous(message) → bool` heuristic (multiple intent cues) is pure and unit-tested.

- [ ] **Step 1: Failing test** (pure parts only; teacher mocked):
```python
from tantular.finetune.gen_router import decide_router, is_ambiguous

def test_agreement_accepts_disagreement_queues():
    assert decide_router("EDIT_TEKS", "EDIT_TEKS", ambiguous=False) == "accept"
    assert decide_router("EDIT_TEKS", "UMUM", ambiguous=False) == "review"
    assert decide_router("EDIT_TEKS", "EDIT_TEKS", ambiguous=True) == "review"

def test_ambiguity_heuristic():
    assert is_ambiguous("terjemahkan dan ringkas ini")  # two intent cues
    assert not is_ambiguous("terjemahkan paragraf ini")
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** — `decide_router(intended, cold, ambiguous)` returns accept/review; `is_ambiguous` flags multi-cue messages; `generate_router` calls the teacher for N diverse messages per intent under the synthesis prompt, runs `cold_classify`, routes via `decide_router`, wraps accepted ones with `make_example(task="router", ...)`. Messages carry the production `router` prompt as system (from bridge `dump-prompts`).

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/gen_router.py tantular/finetune/tests/test_gen_router.py
git commit -m "feat(finetune): router generation with cold-reclassify + review queue"
```

---

### Task 8: Edit generation + known-target reconstruction

**Files:**
- Create: `tantular/finetune/gen_edit.py`, `tantular/finetune/tests/test_gen_edit.py`

**Interfaces:**
- Consumes: teacher sampler, `BridgeClient.validate_edit`, `provenance`.
- Produces: `generate_edit(sampler, bridge, family, n) → (accepted, rejected)`. Chain: clean target → controlled corruption → instruction → teacher edit JSON. `accept_edit(bridge, corrupted, expected, edits) → (bool, reason)` accepts only when: parse ok, all anchors resolve, `bridge.validate_edit(...).apply.text == expected`, AND semantic guards (`no_op`, `overlapping`, `duplicate_target`, `excessive_deletion`, `name_number_altered`, `instruction_mismatch`) all pass. Fail → retry teacher up to N then discard to rejected.

- [ ] **Step 1: Failing test** (pure acceptance logic against a real bridge):
```python
import pathlib
from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.gen_edit import accept_edit
BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"

def test_reconstruction_gate():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, _ = accept_edit(bc, "Pendapatan naik.", "Pendapatan meningkat.",
                            [{"find":"naik","replace":"meningkat","occurrence":1}])
        assert ok
        bad, reason = accept_edit(bc, "Pendapatan naik.", "Pendapatan meningkat.",
                            [{"find":"naik","replace":"turun","occurrence":1}])
        assert not bad  # reconstructs "Pendapatan turun." != expected

def test_noop_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(bc, "abc", "abc", [{"find":"abc","replace":"abc","occurrence":1}])
        assert not ok and reason == "no_op"
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** — semantic guards as pure helpers (no_op: any edit `find==replace`; excessive_deletion: `len(replace) < 0.5*len(find)` without instruction license; name_number_altered: numeric/NER diff between find and replace; overlapping/duplicate via resolve indices), then the reconstruction check via the bridge oracle, then `generate_edit` orchestration with retry-then-discard. Corruption generators produce controlled edits with a known clean target.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/gen_edit.py tantular/finetune/tests/test_gen_edit.py
git commit -m "feat(finetune): edit generation with known-target reconstruction via bridge oracle"
```

---

### Task 9: Prose generation + filters

**Files:**
- Create: `tantular/finetune/gen_prose.py`, `tantular/finetune/dedup.py`, `tantular/finetune/tests/test_gen_prose.py`, `tantular/finetune/tests/test_dedup.py`

**Interfaces:**
- Produces: `has_cjk(text) → bool`; `format_ok(pipeline, text) → bool` (bullets start "- ", single-word where required); `within_length(pipeline, text) → bool`; `accept_prose(pipeline, text) → (bool, reason)` combining filters (CJK leakage is 0-tolerance); `dedup.near_duplicates(texts, threshold) → set[int]` (MinHash or char-shingle Jaccard).

- [ ] **Step 1: Failing tests**
```python
from tantular.finetune.gen_prose import has_cjk, format_ok, accept_prose
from tantular.finetune.dedup import near_duplicates

def test_cjk_zero_tolerance():
    assert has_cjk("ringkasan 摘要")
    assert not has_cjk("ringkasan biasa")
    ok, reason = accept_prose("prose:ringkas", "- poin 摘要")
    assert not ok and reason == "cjk_leakage"

def test_bullet_format():
    assert format_ok("prose:ringkas", "- satu\n- dua")
    assert not format_ok("prose:ringkas", "1. satu")

def test_dedup_flags_near_identical():
    dupes = near_duplicates(["halo dunia ini contoh", "halo dunia ini contoh!", "teks berbeda sama sekali"], threshold=0.8)
    assert 1 in dupes and 2 not in dupes
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** — `has_cjk` via unicode ranges; `format_ok` per-pipeline rules; `near_duplicates` via char-shingle Jaccard; `accept_prose` short-circuits on CJK. `generate_prose` calls teacher under each production prose prompt, filters, spot-check sample flagged for human review.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/gen_prose.py tantular/finetune/dedup.py tantular/finetune/tests/test_gen_prose.py tantular/finetune/tests/test_dedup.py
git commit -m "feat(finetune): prose generation filters + near-dedup"
```

---

### Task 10: Stratified pilot + cost-per-accepted model

**Files:**
- Create: `tantular/finetune/pilot.py`, `tantular/finetune/tests/test_pilot.py`

**Interfaces:**
- Produces: `plan_strata() → list[(stratum, target_n)]` totaling ~240 (each of 8 intents, each edit subtype, each of 7 prose pipelines ≥ min); `cost_per_accepted(spend, accepted_count) → float`; `project_full_run(cost_per_accepted, target_accepted) → float`; `run_pilot(...)` executes generators over pilot strata, tallies teacher spend incl. rejects/retries/cold/judges, writes `pilot_report.json` with per-stratum accept-rate and projected full-run cost.

- [ ] **Step 1: Failing test** (pure math + strata):
```python
from tantular.finetune.pilot import plan_strata, cost_per_accepted, project_full_run

def test_strata_cover_all_and_sum():
    strata = plan_strata()
    assert sum(n for _, n in strata) >= 240
    names = {s for s, _ in strata}
    assert any("router:" in s for s in names) and any("prose:" in s for s in names) and any("edit:" in s for s in names)

def test_cost_projection():
    assert cost_per_accepted(12.0, 240) == 0.05
    assert project_full_run(0.05, 5000) == 250.0  # caller compares to ceiling
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** — strata list with per-stratum minimums; cost model dividing total spend (all categories) by accepted count; projection = cost_per_accepted × target. `run_pilot` wires generators; **prints an explicit STOP recommendation if `project_full_run(...)` > $50**.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/pilot.py tantular/finetune/tests/test_pilot.py
git commit -m "feat(finetune): stratified pilot + cost-per-accepted projection"
```

---

### Task 11: Full generation → four artifacts

**Files:**
- Create: `tantular/finetune/generate.py`

**Interfaces:**
- Produces: CLI `python -m tantular.finetune.generate --target-accepted N --seed S` → writes `train.jsonl`, `eval.jsonl`, `challenge.jsonl`, `rejects.jsonl` under `tantular/finetune/data/`, applies global `near_duplicates` across the whole corpus (logging removals), and enforces the exposure mix targets (20% router / 40% edit / 40% prose by training-token exposure, computed from tokenized completion lengths).

- [ ] **Step 1: Procedure (artifact-verified, not unit — depends on teacher spend; run only after pilot passes budget)**

Run: `cd tantular/finetune && .venv/bin/python -m tantular.finetune.generate --target-accepted 5000 --seed 20260720`
Expected artifacts: four `.jsonl` files exist; `train/eval/challenge` disjoint by family (assert via a check script); `rejects.jsonl` non-empty; a `generation_manifest.json` records counts, exposure mix (by token), dedup removals, and total spend ≤ remaining budget.

- [ ] **Step 2: Verify integrity**

Run a bundled `--verify` mode: asserts no family_id appears in more than one split, every accepted example has full provenance (both generation+training blocks, bridge fields), and the exposure mix is within ±5% of targets. Expected: `VERIFY OK`.

- [ ] **Step 3: Commit** (data files may be gitignored if large; commit the manifest + scripts)
```bash
git add tantular/finetune/generate.py tantular/finetune/data/generation_manifest.json
git commit -m "feat(finetune): full generation to four provenance-tracked artifacts"
```

---

### Task 12: LoRA training on Tinker

**Files:**
- Create: `tantular/finetune/train_lora.py`

**Interfaces:**
- Produces: CLI training `Qwen/Qwen3-8B` LoRA on `train.jsonl` under renderer `qwen3_disable_thinking`, sampling batches to hit the exposure mix (20/40/40 by completion tokens, internally balanced), periodic checkpoint via `save_state`, final `save_weights_and_get_sampling_client`. Writes `adapter/` (Tinker state) + records hyperparameters to `train_manifest.json`.

- [ ] **Step 1: Procedure**

Run: `cd tantular/finetune && .venv/bin/python -m tantular.finetune.train_lora --data data/train.jsonl --rank 16 --lr 1e-4 --steps <from-pilot>`
Expected: training loss decreases; `adapter/` + `train_manifest.json` written; spend recorded within budget.

- [ ] **Step 2: Smoke the checkpoint**

Sample the trained checkpoint on 5 held-out router prompts + 1 edit prompt; confirm intents are single-token and edit output parses via the bridge. Expected: sane outputs (full gate is Task 13).

- [ ] **Step 3: Commit**
```bash
git add tantular/finetune/train_lora.py tantular/finetune/train_manifest.json
git commit -m "feat(finetune): Tinker LoRA training with exposure-weighted mix"
```

---

### Task 13: Eval harness + quantified gates + Wilson CI

**Files:**
- Create: `tantular/finetune/metrics.py`, `tantular/finetune/evaluate.py`, `tantular/finetune/tests/test_metrics.py`

**Interfaces:**
- Produces (pure, tested): `wilson_ci(successes, n, z=1.96) → (lo, hi)`; `macro_f1(confusion) → float`; `passes_router_gate(stats) → (bool, details)`; `passes_edit_gate(stats)`; `passes_prose_gate(stats)` implementing the spec thresholds AND denominators (router ≥100/intent + ≥300 privacy negatives; edit ≥300 known-target + ≥100 human release; prose ≥50/pipeline + ≥400 agg; material regression = >5pp below base). `evaluate.py` runs student+base over `eval.jsonl`, computes all metrics with CIs, writes `eval_report.json`, prints PASS/FAIL per gate.

- [ ] **Step 1: Failing tests**
```python
from tantular.finetune.metrics import wilson_ci, passes_router_gate

def test_wilson_ci_bounds():
    lo, hi = wilson_ci(95, 100)
    assert 0.88 < lo < 0.95 < hi < 1.0

def test_router_gate_denominator_enforced():
    # accuracy great but too few per-intent samples → gate fails on denominator
    ok, details = passes_router_gate({"per_intent_n": {"EDIT_TEKS": 40}, "canonical_rate": 0.999, "macro_f1": 0.97, "min_recall": 0.95, "privacy_fp": 0.005, "privacy_n": 300})
    assert not ok and "denominator" in str(details).lower()

def test_router_gate_passes_when_met():
    stats = {"per_intent_n": {k: 120 for k in ["TANYA_DOKUMEN","EDIT_TEKS","DRAFT_TEKS","TERJEMAH","RINGKAS","UBAH_NADA","CEK_AMAN","UMUM"]},
             "canonical_rate": 0.996, "macro_f1": 0.96, "min_recall": 0.93, "privacy_fp": 0.008, "privacy_n": 320}
    ok, _ = passes_router_gate(stats)
    assert ok
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** metrics (Wilson interval, macro-F1) and each gate predicate enforcing thresholds + minimum denominators; `evaluate.py` orchestration (sample student & base via Tinker or Ollama, compare, blind A/B win-rate with position swap for prose).

- [ ] **Step 4: Run tests** — PASS. Then run `evaluate.py` on real artifacts; capture `eval_report.json`.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/metrics.py tantular/finetune/evaluate.py tantular/finetune/tests/test_metrics.py
git commit -m "feat(finetune): eval harness with quantified gates + Wilson CIs"
```

---

### Task 14: Frozen challenge set + veto runner

**Files:**
- Create: `tantular/finetune/challenge.py`, `tantular/finetune/tests/test_challenge.py`, `tantular/finetune/data/challenge_release.jsonl` (hand-authored, version-pinned)

**Interfaces:**
- Produces: `critical_vetoes(results) → list[str]` returning any tripped hard-veto invariants (wrong-location edit, unexpected document-read route, invalid contract, CJK leakage); `run_challenge(student, bridge) → report`. Release set is frozen; a separate `challenge_dev.jsonl` is used during tuning.

- [ ] **Step 1: Failing test**
```python
from tantular.finetune.challenge import critical_vetoes

def test_wrong_location_edit_is_veto():
    v = critical_vetoes({"edit": [{"wrong_location": True}], "router": [], "prose": []})
    assert "wrong_location_edit" in v

def test_clean_run_no_veto():
    assert critical_vetoes({"edit": [{"wrong_location": False}], "router": [{"unexpected_doc_read": False}], "prose": [{"cjk": False}]}) == []
```

- [ ] **Step 2: Run fail.**

- [ ] **Step 3: Implement** veto detection + `run_challenge` (routes each frozen case through student+bridge, classifies invariants). Author ≥ ~40 release cases spanning ambiguous router, repeated-anchor edits, whitespace-variant anchors, CJK bait, adversarial "ignore the document" instructions.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**
```bash
git add tantular/finetune/challenge.py tantular/finetune/tests/test_challenge.py tantular/finetune/data/challenge_release.jsonl
git commit -m "feat(finetune): frozen challenge set + critical-invariant veto runner"
```

---

### Task 15: GGUF export, model tag, one-time opt-in notice

**Files:**
- Create: `tantular/Modelfile.office-lora`, `tantular/install_tantular_office_model.sh`, `tantular_office_addin/src/chat/upgradeNotice.js`, `tantular_office_addin/tests/upgradeNotice.test.mjs`
- Modify: `tantular_office_addin/src/chat/chatPane.js` (mount notice on Word), `tantular_office_addin/README.md`

**Interfaces:**
- Produces: `shouldShowUpgradeNotice(settings, storage) → bool` (true only when saved model !== new tag AND not dismissed AND not already accepted); `acceptUpgrade(storage) → newTag`; `dismissUpgrade(storage)` (persists "don't ask again"). Gated behind all Task 13 + Task 14 gates passing.

- [ ] **Step 1: Failing test** (`upgradeNotice.test.mjs`)
```js
import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowUpgradeNotice, acceptUpgrade, dismissUpgrade, NEW_TAG } from "../src/chat/upgradeNotice.js";

function mem() { const m = {}; return { getItem:(k)=>m[k]??null, setItem:(k,v)=>{m[k]=String(v);} }; }

test("shows when on old model, not dismissed", () => {
  assert.equal(shouldShowUpgradeNotice({ model: "qwen3:8b" }, mem()), true);
});
test("hidden after dismiss persists", () => {
  const s = mem(); dismissUpgrade(s);
  assert.equal(shouldShowUpgradeNotice({ model: "qwen3:8b" }, s), false);
});
test("hidden after accept, writes new tag", () => {
  const s = mem(); const tag = acceptUpgrade(s);
  assert.equal(tag, NEW_TAG);
  assert.equal(shouldShowUpgradeNotice({ model: NEW_TAG }, s), false);
});
```

- [ ] **Step 2: Run fail** — `npm test`.

- [ ] **Step 3: Implement**

`upgradeNotice.js`:
```js
export const NEW_TAG = "tantular:0.3-office-8b-lora";
const KEY = "tantular.office.upgrade.v0_3";
export function shouldShowUpgradeNotice(settings, storage) {
  if (settings?.model === NEW_TAG) return false;
  const st = storage.getItem(KEY);
  return st !== "dismissed" && st !== "accepted";
}
export function acceptUpgrade(storage) { storage.setItem(KEY, "accepted"); return NEW_TAG; }
export function dismissUpgrade(storage) { storage.setItem(KEY, "dismissed"); }
```
Mount a small Indonesian notice bubble in `chatPane.js` (Word only) when `shouldShowUpgradeNotice(loadSettings(), localStorage)`; accept writes `saveSettings({model: NEW_TAG})`. `Modelfile.office-lora`: `FROM qwen3:8b` + `ADAPTER ./office-lora.gguf`. `install_tantular_office_model.sh`: pull base, convert adapter to GGUF, `ollama create tantular:0.3-office-8b-lora`, verify it loads. README: document the tag + install step + that `qwen3:8b` is never overwritten.

- [ ] **Step 4: Run tests** — `npm test` PASS; `bash -n install_tantular_office_model.sh` clean.

- [ ] **Step 5: Commit**
```bash
git add tantular/Modelfile.office-lora tantular/install_tantular_office_model.sh tantular_office_addin/src/chat/upgradeNotice.js tantular_office_addin/tests/upgradeNotice.test.mjs tantular_office_addin/src/chat/chatPane.js tantular_office_addin/README.md
git commit -m "feat(finetune): GGUF export, 0.3 office LoRA tag, one-time opt-in notice"
```

---

## Final gate (human + manual)

After Task 15, promotion is authorized ONLY if: Task 13 `eval_report.json` shows all router/edit/prose gates PASS (with CI lower bounds), Task 14 `critical_vetoes` is empty on the frozen release set, and a manual Word sideload confirms the `tantular:0.3-office-8b-lora` tag loads and the opt-in notice accept/dismiss works. Otherwise iterate mix/rank/LR within remaining budget and re-evaluate. Never promote on a tripped veto regardless of aggregate scores.
