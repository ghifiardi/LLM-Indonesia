# Tantular Office Productivity — Tinker LoRA Fine-Tune (Qwen3-8B)

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Scope:** Offline synthetic dataset + LoRA fine-tune improving the Word add-in's local model (intent router, edit contract, Indonesian prose pipelines). **No chat/edit workflow change; promotion adds exactly one model-upgrade opt-in notice** and swaps the default Ollama model tag for fresh installs.

## Goal

Produce a LoRA adapter for **Qwen3-8B** that beats the base `qwen3:8b` on the add-in's three behavior classes — routing, edit-contract generation, and Indonesian prose — under strict, mostly-objective shipping gates. Inference stays **strictly local** on the developer Mac via Ollama; only *dataset generation and training* run on Tinker (offline, no user documents involved).

Chosen architecture: **execution-verified synthesis (Approach A)** — the teacher generates data, and our own shipped validators plus semantic checks gate every example before it can train. Execution verification guarantees contract *validity*; the semantic layer and human review guard *correctness* (validity ≠ correctness). Plain distillation (B) was rejected for silent label noise; RL with contract rewards (C) is deferred — SFT on execution-verified data captures most of the benefit with an inspectable, reproducible loop.

## Models and reasoning parity

| Role | Model | Renderer / reasoning setting |
|---|---|---|
| Teacher (synthesis) | `Qwen/Qwen3.5-397B-A17B` (non-thinking) | Tinker renderer `qwen3_5_disable_thinking` |
| Student (train + eval) | `Qwen/Qwen3-8B` | Tinker renderer `qwen3_disable_thinking` |
| Shipped inference | `qwen3:8b` + adapter via Ollama | Ollama request field `reasoning_effort: "none"` |

`Qwen3-235B-A22B-Instruct-2507` is retired on Tinker (2026-06-12) and must not be used. `reasoning_effort` is an *Ollama request field*, not the training mechanism — training/eval reasoning parity is enforced through the **renderer** IDs above, which are recorded per example. Source: Tinker model catalogue (https://tinker-docs.thinkingmachines.ai/tinker/models/), renderer docs (https://tinker-docs.thinkingmachines.ai/cookbook/api-reference/renderers/get_renderer/).

## Canonical prompt registry (prerequisite refactor)

Today most pipeline system prompts are module-local (`tantular_office_addin/src/chat/pipelines/*.js`), while the router prompt and edit prompt already live in single files. Before synthesis, extract **all** production prompt constants/builders into one runtime-owned registry module at **`tantular_office_addin/src/promptRegistry.js`** (this path is deliberate — it must not collide with the existing `tantular_office_addin/src/prompts.js`, which holds the classic-action `ACTIONS`). It is consumed by three callers: the add-in, the synthesis harness, and the eval harness. The training/synthesis harness must **not** duplicate prompt text — it imports the registry.

The registry owns **prompt content and its hash only** — it is renderer-agnostic. Each entry records: `prompt_id`, prompt content hash, and git SHA. Renderer/tokenizer choices belong to the generation and training configs (below), not the registry, because the same prompt is rendered differently for teacher generation vs. student training. Synthesis prompts and judge prompts are versioned **separately** from production prompts (own hashes), so a change to how we *generate* data is never confused with a change to what the *product* runs. This makes "trains under the verbatim production prompt" a checkable invariant, not an aspiration.

## Python↔JavaScript bridge (load-bearing)

The Tinker harness is **Python**; the canonical prompt registry, the contract validators (`parseEditContract`, `resolveEdits`), and the reconstruction oracle (`applyEditsToText`) are **JavaScript ESM** modules that ship in the add-in. Python cannot import them, and reimplementing them in Python would reintroduce exactly the drift this design exists to prevent. So the JS logic is reached **only** through a single versioned bridge:

- A long-lived **Node JSONL worker** (`tools/finetune/bridge.mjs`) reads one JSON request per line on stdin, writes one JSON response per line on stdout. Persistent, not spawn-per-call — synthesis and eval each run thousands of validations, and re-spawning Node each time is untenable.
- Commands:
  - `dump-prompts` → all registry entries with `prompt_id`, content, content hash, git SHA.
  - `validate-edit` `{docText, edits}` → `{parse: ok|error, resolve: [...], apply: {text, perEditStatus}}` — invokes the real `parseEditContract` + `resolveEdits` + `applyEditsToText`.
- Python (synthesis and eval) uses the **same bridge process class** and never reimplements prompts, parsing, resolution, or application.
- The bridge announces a `protocol_version` and the **JS git commit** it was built from on startup; both are recorded in every example's `generation` provenance so a validator change is always traceable to the data it produced.

## Provenance-tracked example schema

Every example carries full lineage:

```json
{
  "id": "...",
  "task": "router | edit | prose:<pipeline>",
  "split": "train | eval | challenge",
  "family": "<document/scenario family id>",
  "payload": {
    "source_document": "...", "instruction": "...",
    "expected_intent": "...|null", "expected_target": "...|null",
    "validator_results": { ... }, "judge_config": { ... }
  },
  "messages": [ {system}, {user}, {assistant} ],
  "provenance": {
    "prompt_id": "router|edit|prose:ringkas|...",
    "production_prompt_content_hash": "...", "production_prompt_git_sha": "...",
    "generation": {
      "teacher_model": "Qwen/Qwen3.5-397B-A17B",
      "renderer": "qwen3_5_disable_thinking",
      "tokenizer_revision": "...", "tinker_sdk_version": "...",
      "sampling": { "temperature": 0.7, "top_p": 0.9, "max_tokens": 1024 },
      "synthesis_prompt_hash": "...", "judge_prompt_hash": "...|null",
      "bridge_protocol_version": "...", "bridge_js_commit": "...",
      "seed": 12345, "retries": 2
    },
    "training": {
      "student_model": "Qwen/Qwen3-8B",
      "renderer": "qwen3_disable_thinking",
      "tokenizer_revision": "...", "tinker_sdk_version": "..."
    },
    "status": "accepted | rejected", "reject_reason": null | "<code>"
  }
}
```

The `generation` and `training` blocks are separate on purpose: an example is *generated* with the teacher model/renderer/tokenizer and *serialized for training* with the student's — one flat renderer/tokenizer field cannot describe both. Synthesis- and judge-prompt hashes live in `generation` (they shape the data, not the product); the production prompt's hash/SHA stay at the top of provenance (they must match the registry).

The `payload` keeps task-native fields (source document, instruction, expected intent/target, validator results, judge config) **alongside** the derived chat `messages`, so every example is inspectable and re-derivable.

## Physically separated artifacts

Four distinct files, never a filtered view of one file:

- `train.jsonl` — accepted, train-split families only
- `eval.jsonl` — accepted, held-out eval families
- `challenge.jsonl` — frozen, human-reviewed release challenge set (version-pinned)
- `rejects.jsonl` — every rejected/retried-then-discarded example, retained for audit, **never trained on**

A rejected output trains only if deliberately repurposed as an explicit correction/preference pair — out of scope for this SFT v1; noted as a future DPO/RL hook.

## Split-before-generate + global dedup

Enumerate document families (memo, email, report, spreadsheet-text, slide-text, …) and scenario families (per intent; per edit subtype), then partition **families** into train / eval / challenge *before* generation. Generation happens only within a family's assigned split, so no document or template straddles the boundary. After generation, a global near-dedup pass (MinHash or embedding threshold) runs across the whole corpus to catch cross-family leakage; dedup removals are logged.

Keep a **separate development adversarial set** distinct from the frozen release challenge set, so repeated tuning never exposes the release set.

## Per-task generation and validation

### Router
Teacher generates diverse Indonesian messages per intent (label known by construction). Two independent gates before acceptance:
1. **Independent cold re-classification** — a separate teacher prompt re-labels the message with no knowledge of the intended label; disagreement flags the example.
2. **Human review** of every ambiguous / cross-intent / disagreement-flagged example — never auto-accepted.

### The reconstruction oracle (shared, pure)
"Applying the edit JSON" must be a single, pure, shared function — call it `applyEditsToText(docText, edits) → { text, perEditStatus }` — that mirrors the **production** apply semantics exactly: sequential per-edit re-anchoring against the progressively-updated text, whitespace-normalized matching, matched-substring (not raw `find`) replacement, non-overlapping ordinal selection — the same behavior implemented in `tantular_office_addin/src/chat/wordEdits.js` / `tantular_office_addin/src/chat/editContract.js`. It lives beside those modules (e.g. `tantular_office_addin/src/chat/applyEdits.js`), is unit-tested against the Word edit path's behavior, and is **imported by both synthesis and eval** — neither may implement its own application logic. This is the guard against a harness-specific reconstruction that accepts contracts Word would later apply differently. (Because Office.js can't run headless, the oracle encodes the agreed text-domain semantics; the tracked-changes UI parity remains a manual check, as in the add-in's own test story.)

### Edit — known-target reconstruction (primary method)
Where possible, generate the chain: **clean target document → controlled corruption → instruction → expected (clean) target**. The teacher's edit JSON is accepted only when **`applyEditsToText(corrupted, edits)` reconstructs the expected target** — this measures completeness and semantic correctness without relying on a judge. Layered checks, all must pass:
- Contract validity via the real `parseEditContract` + `resolveEdits` (validator commit recorded).
- Reconstruction equals expected target, via the shared oracle (primary semantic gate).
- Reject: no-op edits (replace == find), overlapping edits, duplicate targets, unintended/excessive deletion, replacement-created anchor collisions, altered protected names/numbers not licensed by the instruction, instruction mismatch.
- Cases without a synthesizable known target fall back to validator + independent judge, and are sampled into human review.
Fail any layer → retry teacher up to N, then **discard** (to `rejects.jsonl`).

### Prose
Teacher performs the task under the production system prompt (from the registry). Automated filters: CJK-leakage regex (0-tolerance — known Qwen drift), hard-format compliance (bullets `- `, single-word where required), length caps, near-dedup. Then a sampled human/judge spot-check per pipeline.

## Training exposure mix (not record share)

Measure mix by **sampled batches / optimizer-update exposure**, not record count — router completions carry very few target tokens, so 30% of records ≠ 30% of learning signal. Start at **20% router / 40% edit / 40% prose by training exposure**, each balanced internally (router by intent; edit by subtype; prose by pipeline). The pilot (below) adjusts these ratios from measured token counts.

## Shipping gates (all must pass to promote the tag)

Every rate below carries a **minimum denominator**; report 95% confidence intervals for all router and edit rates (Wilson interval). Metrics are computed on held-out eval families the training never saw, except the zero-wrong-location gate, which runs on the human-reviewed release set.

**Router** (≥ 100 held-out cases per intent → ≥ 800 total; plus ≥ 300 no-selection privacy negatives): canonical-label rate ≥ 99.5%; macro-F1 ≥ 0.95; no single intent recall < 0.90; broad-document-context false-positive rate ≤ 1% on the privacy-negative slice (non-doc intents must not trigger whole-document reads).

**Edit** — two separate metrics, not one blended score:
- *Known-target reconstruction* (≥ 300 known-target cases): JSON/schema success ≥ 99%; unique-anchor resolution ≥ 97%; reconstruction-equals-target ≥ 90%.
- *Open-ended (judge-scored) edits* reported separately as a diagnostic, never merged into the reconstruction number.
- *Zero wrong-location edits* on ≥ 100 human-reviewed release cases (hard veto).

**Prose** (≥ 50 paired cases per pipeline, ≥ 400 aggregate): CJK leakage 0%; hard-format compliance ≥ 99%; protected name/number preservation ≥ 98%; blind A/B win-rate ≥ 55% vs base **with the lower bound of its 95% CI above 50%** (position-swapped to cancel order bias). **"No pipeline regresses materially" = no individual pipeline scores more than 5 percentage points below base** on its primary metric.

**Challenge set (release vetoes):** critical-invariant failures are hard vetoes regardless of aggregate scores — wrong-location edits, unexpected document-reading routes, invalid contracts, CJK leakage. Other challenge metrics remain diagnostic. Runs on the frozen release challenge set; the separate development adversarial set is used during tuning so the release set is never exposed.

## De-risking: export spike BEFORE dataset generation

The largest unproven assumption is toolchain compatibility, not data. A spike that only checks "the tag loads and responds" is worthless — Ollama can silently ignore an adapter and still respond. The spike must prove the **adapter is active** by training a distinctive **sentinel behavior** the base model does not exhibit, then confirming that behavior survives every hop:

1. Train a tiny Qwen3-8B LoRA on a sentinel mapping (e.g. a nonsense trigger phrase → a fixed, unusual response the base never produces).
2. **Confirm the base model FAILS the sentinel** (negative control) — record the base's response.
3. Verify the **Tinker checkpoint** (via SamplingClient) produces the sentinel behavior.
4. Export to PEFT (https://tinker-docs.thinkingmachines.ai/tutorials/deployment/lora-adapter/); verify the **PEFT adapter** (transformers) produces it.
5. Convert PEFT → GGUF (llama.cpp), create an Ollama tag over the exact `qwen3:8b` base; verify the **Ollama GGUF tag** produces it — through the actual add-in.
6. **Record for reproducibility/compatibility:** the exact Hugging Face model revision of the base, the Ollama base image **digest**, llama.cpp commit, and the sentinel prompt/response.

Ship-stop rule: if the sentinel behavior does not reproduce at any hop — especially the Ollama GGUF stage — the toolchain is wrong and the plan changes before a cent of generation budget is spent. Tinker supports PEFT export; GGUF/Ollama parity with this exact base is the thing being proven.

## Budget and pilot

Ceiling ~$50 covers **all Tinker consumption end to end** — the export spike, teacher generation including rejected attempts and retries, cold re-classification and judge calls, LoRA training, and evaluation sampling. Nothing is billed outside this ceiling. **Measure-first:** after the export spike, a **stratified ~240-example** pilot generation (minimum coverage per stratum — each of the 8 router intents, each edit subtype, each of the 7 prose pipelines) measures real costs; 100 examples cannot cover this surface reliably. Cost is modeled as **cost per *accepted* example** — it must include everything the accepted example consumed: rejected attempts, retries, cold re-classification passes, judge calls, plus amortized export-spike, training, and evaluation. That per-accepted-example figure, not raw generation cost, sets the final dataset size (est. ~4–6k accepted) and the exposure mix. Stop and report if the pilot implies the full run exceeds the ceiling.

## Pipeline and artifacts

Reuses the existing `tantular/FINETUNE.md` plumbing (SFT prep → LoRA → GGUF convert → Ollama), with Tinker as the training compute. Deliverables:
- Canonical prompt registry refactor (`promptRegistry.js`; add-in + synthesis + eval consume it).
- The versioned Node JSONL bridge (`tools/finetune/bridge.mjs`) + its Python client.
- The shared `applyEditsToText` oracle + unit tests.
- The one-time model-upgrade opt-in notice (add-in UI + persistence) with tests.
- Generation + layered-validation scripts (per task).
- `train.jsonl`, `eval.jsonl`, `challenge.jsonl`, `rejects.jsonl` with full provenance.
- Eval harness computing every gate metric, plus the frozen release challenge runner.
- Exported GGUF adapter + Ollama Modelfile.

Nothing in the shipped add-in changes unless all gates pass. Promotion makes **one** user-visible change — the model-upgrade opt-in notice below — and no change to the chat or edit workflow.

## Model-tag naming and migration

Promotion is a tag + settings decision, not just a `DEFAULT_MODEL` edit:

- **New tag:** ship as **`tantular:0.3-office-8b-lora`** (following the `tantular/NAMING.md` scheme), built from a dedicated Modelfile that layers the exported GGUF adapter over the base. **Never overwrite the upstream `qwen3:8b` tag** — the base must stay pullable and unmodified.
- **Fresh installs:** `DEFAULT_MODEL` in `tantularClient.js` becomes `tantular:0.3-office-8b-lora`.
- **Existing installs keep their saved setting:** `loadSettings()` returns the stored `model` when present, so changing `DEFAULT_MODEL` alone does **not** migrate anyone already on `qwen3:8b`. Chosen policy for v1: **existing users remain pinned** to their saved model and are offered explicit opt-in via a **one-time model-upgrade notice** ("Model Tantular 0.3 tersedia — gunakan?") with accept / dismiss actions; accept writes the new tag, dismiss persists a "don't ask again" flag. No silent settings rewrite. This notice is the single user-visible interface addition promotion introduces; its accept / dismiss / persistence behavior is a tested deliverable (unit-testable state logic + manual sideload check), and the scope statement and deliverables reflect it.
- **Install step:** an `install_tantular_office_model.sh` (mirroring the existing model install scripts) pulls the base, builds the adapter tag, and verifies it loads — documented in the README alongside `ollama pull qwen3:8b`.

## Source evidence

- Tinker model catalogue (teacher retirement, Qwen3-8B student): https://tinker-docs.thinkingmachines.ai/tinker/models/
- Renderers (`qwen3_5_disable_thinking` / `qwen3_disable_thinking`): https://tinker-docs.thinkingmachines.ai/cookbook/api-reference/renderers/get_renderer/
- Tinker quickstart (TrainingClient/SamplingClient, SFT `Datum`, export): https://tinker-docs.thinkingmachines.ai/tinker/quickstart/
- LoRA adapter export (PEFT): https://tinker-docs.thinkingmachines.ai/tutorials/deployment/lora-adapter/
- Existing local pipeline (SFT prep → LoRA → GGUF → Ollama), public/holdout split invariant: `tantular/FINETUNE.md`
- Frozen SFT contract targets on the merged branch: `tantular_office_addin/src/chat/intentRouter.js` (router taxonomy/prompt), `tantular_office_addin/src/chat/editContract.js` (`EDIT_SYSTEM_PROMPT`, validators)
