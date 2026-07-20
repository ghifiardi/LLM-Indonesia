# Tantular Office Productivity — Tinker LoRA Fine-Tune (Qwen3-8B)

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Scope:** Offline synthetic dataset + LoRA fine-tune improving the Word add-in's local model (intent router, edit contract, Indonesian prose pipelines). No change to the shipped add-in interface; promotion only swaps the selected Ollama model tag.

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

Today most pipeline system prompts are module-local (`src/chat/pipelines/*.js`), while the router prompt and edit prompt already live in single files. Before synthesis, extract **all** production prompt constants/builders into one runtime-owned registry module (e.g. `src/prompts/registry.js`) consumed by three callers: the add-in, the synthesis harness, and the eval harness. The training harness must **not** duplicate prompt text — it imports the registry. Each registry entry records: content hash, Tinker renderer ID, tokenizer revision, and git SHA. This makes "trains under the verbatim production prompt" a checkable invariant, not an aspiration.

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
    "prompt_content_hash": "...", "renderer": "qwen3_5_disable_thinking",
    "tokenizer_revision": "...", "prompt_git_sha": "...",
    "teacher_model": "Qwen/Qwen3.5-397B-A17B",
    "seed": 12345, "retries": 2,
    "status": "accepted | rejected", "reject_reason": null | "<code>"
  }
}
```

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

### Edit — known-target reconstruction (primary method)
Where possible, generate the chain: **clean target document → controlled corruption → instruction → expected (clean) target**. The teacher's edit JSON is accepted only when **applying it to the corrupted document reconstructs the expected target** — this measures completeness and semantic correctness without relying on a judge. Layered checks, all must pass:
- Contract validity via the real `parseEditContract` + `resolveEdits` (validator commit recorded).
- Reconstruction equals expected target (primary semantic gate).
- Reject: no-op edits (replace == find), overlapping edits, duplicate targets, unintended/excessive deletion, replacement-created anchor collisions, altered protected names/numbers not licensed by the instruction, instruction mismatch.
- Cases without a synthesizable known target fall back to validator + independent judge, and are sampled into human review.
Fail any layer → retry teacher up to N, then **discard** (to `rejects.jsonl`).

### Prose
Teacher performs the task under the production system prompt (from the registry). Automated filters: CJK-leakage regex (0-tolerance — known Qwen drift), hard-format compliance (bullets `- `, single-word where required), length caps, near-dedup. Then a sampled human/judge spot-check per pipeline.

## Training exposure mix (not record share)

Measure mix by **sampled batches / optimizer-update exposure**, not record count — router completions carry very few target tokens, so 30% of records ≠ 30% of learning signal. Start at **20% router / 40% edit / 40% prose by training exposure**, each balanced internally (router by intent; edit by subtype; prose by pipeline). The pilot (below) adjusts these ratios from measured token counts.

## Shipping gates (all must pass to promote the tag)

**Router:** canonical-label rate ≥ 99.5%; macro-F1 ≥ 0.95; no single intent recall < 0.90; broad-document-context false-positive rate ≤ 1% (i.e. `UMUM`/non-doc intents must not wrongly trigger whole-document reads).

**Edit:** JSON/schema success ≥ 99%; unique-anchor resolution ≥ 97%; semantic/completeness (reconstruction) score ≥ 90%; **zero wrong-location edits** on the human-reviewed release set.

**Prose:** CJK leakage 0%; hard-format compliance ≥ 99%; protected name/number preservation ≥ 98%; blind A/B win-rate ≥ 55% vs base **with the lower bound of its 95% CI above 50%** (position-swapped to cancel order bias). No individual pipeline may regress materially.

**Challenge set (release vetoes):** critical-invariant failures are hard vetoes regardless of aggregate scores — wrong-location edits, unexpected document-reading routes, invalid contracts, CJK leakage. Other challenge metrics remain diagnostic. Gate runs only on held-out eval + release challenge families the training never saw.

## De-risking: export spike BEFORE dataset generation

The largest unproven assumption is toolchain compatibility, not data. Before spending any generation budget, run an end-to-end spike:
1. Train one **tiny** Qwen3-8B LoRA adapter on Tinker (a handful of steps, throwaway data).
2. Export to PEFT (Tinker adapter export — https://tinker-docs.thinkingmachines.ai/tutorials/deployment/lora-adapter/).
3. Convert PEFT → GGUF (llama.cpp), create an Ollama model tag over the exact `qwen3:8b` base.
4. Load it through the actual add-in and confirm it responds.

If GGUF/Ollama cannot load a Tinker-exported adapter over this base, the whole plan changes — so this gate comes first. Tinker supports PEFT export; GGUF/Ollama compatibility with the exact base is the thing to prove.

## Budget and pilot

Ceiling ~$50 for teacher sampling + LoRA training + eval sampling. **Measure-first:** after the export spike, a 100-example pilot generation measures real teacher token costs and per-task exposure, setting final dataset size (est. ~4–6k accepted examples) and confirming the mix. Stop and report if the pilot implies the full run exceeds budget.

## Pipeline and artifacts

Reuses the existing `tantular/FINETUNE.md` plumbing (SFT prep → LoRA → GGUF convert → Ollama), with Tinker as the training compute. Deliverables:
- Canonical prompt registry refactor (add-in + synthesis + eval consume it).
- Generation + layered-validation scripts (per task).
- `train.jsonl`, `eval.jsonl`, `challenge.jsonl`, `rejects.jsonl` with full provenance.
- Eval harness computing every gate metric, plus the frozen release challenge runner.
- Exported GGUF adapter + Ollama Modelfile.

Nothing in the shipped add-in changes unless all gates pass; promotion **requires no application-interface change — it only changes the selected Ollama model tag.**

## Source evidence

- Tinker model catalogue (teacher retirement, Qwen3-8B student): https://tinker-docs.thinkingmachines.ai/tinker/models/
- Renderers (`qwen3_5_disable_thinking` / `qwen3_disable_thinking`): https://tinker-docs.thinkingmachines.ai/cookbook/api-reference/renderers/get_renderer/
- Tinker quickstart (TrainingClient/SamplingClient, SFT `Datum`, export): https://tinker-docs.thinkingmachines.ai/tinker/quickstart/
- LoRA adapter export (PEFT): https://tinker-docs.thinkingmachines.ai/tutorials/deployment/lora-adapter/
- Existing local pipeline (SFT prep → LoRA → GGUF → Ollama), public/holdout split invariant: `tantular/FINETUNE.md`
- Frozen SFT contract targets on the merged branch: `src/chat/intentRouter.js` (router taxonomy/prompt), `src/chat/editContract.js` (`EDIT_SYSTEM_PROMPT`, validators)
