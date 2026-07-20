# Tantular Office Add-in — Chat, Document Awareness, and Agentic Editing (Word)

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan
**Scope:** `tantular_office_addin/` — Word host only; Excel/PowerPoint are roadmap (Stage 4, separate spec)

## Goal

Close the capability gap between Tantular and cloud peers (Microsoft Copilot, Claude) for Office
productivity, while staying **strictly local** — documents never leave the machine. Target hardware
for this round is the developer's Apple Silicon Mac (7–8B quantized models are acceptable); a
low-end Windows profile is out of scope until there are real users.

Chosen architecture (Approach 2 of 3 considered): **chat front door + intent router + typed
deterministic pipelines**. Free-form ReAct tool-calling was rejected (7–8B local models are
unreliable tool-callers); grid-only incremental enhancement was rejected (does not close the
conversational gap that defines Copilot).

## Constraints and invariants

- **Strictly local.** All model calls go to the local endpoint. No cloud fallback, no telemetry.
- Existing action grid and Deck Studio remain functional throughout; no regressions.
- **In Word only:** Word-applicable existing actions become quick-prompt chips inside chat
  ("Aksi cepat"). Excel and PowerPoint keep the current action grid (and Deck Studio) exactly as
  they are until Stage 4 — the chat pane renders only when `Office.onReady` reports the Word host.
- All user-facing strings in Indonesian, matching existing tone.
- Router and edit-contract formats are designed to double as SFT targets for the later Tinker
  fine-tune (separate spec) — keep them in single, importable modules.

## Staging

| Stage | Contents | Ships when |
|---|---|---|
| **1A** | Chat shell UI, streaming, conversation history, quick chips, selection-aware prompts, intent router | Usable chat over selection in Word |
| **1B** | Main-body context builder: chunking, map/reduce summary, cache | "Tanya dokumen" works on long docs |
| **2** | Edit contract, preview-before-apply, tracked-changes apply with WordApi 1.4 gate | Agentic editing in Word |
| **3** | Default model bump to `qwen3:8b` (settings still allow any tag) | Config change, rides with 1A |
| **4 (roadmap)** | Excel/PowerPoint chat ports; header/footer/text-box coverage; chunk-level cache | Separate spec |

Each stage is independently shippable and demoable.

## Architecture

New `src/chat/` module tree, isolated from existing action-grid code:

```
src/chat/
  chatPane.js       UI: message list, streaming bubbles, chips, context pill, stop button
  intentRouter.js   LLM pass 1 — classify message → typed Intent (prompt + taxonomy live here)
  contextBuilder.js Selection / main-body text gathering, chunking, summary cache
  history.js        Conversation memory (last N turns, token-capped compaction)
  editContract.js   Edit JSON schema, validation, anchor resolution (pure functions)
  pipelines/
    index.js        Intent → pipeline registry
    tanyaDokumen.js editTeks.js draftTeks.js terjemah.js ringkas.js ubahNada.js
    cekAman.js umum.js
```

Pipeline interface (typed result contracts, plain JS objects + validators, no framework):

```js
run({ intent, context, history, instruction, emit }) → PipelineResult
```

`tantularClient.js` gains a streaming variant; all pipelines consume the client through the same
adapter interface as today.

## Chat UX

- **Word host only:** chat is the top of the task pane; the Word action grid collapses into an
  "Aksi cepat" chip row that prefills the chat input. Excel/PowerPoint panes are unchanged.
- Assistant answers stream token-by-token; a stop button aborts the request.
- A **context pill** above the input shows what Tantular will read — `Seleksi` /
  `Dokumen (isi utama)` — auto-chosen by intent, user-overridable with one tap.
- All failure paths render as chat bubbles with the fix (reusing existing Indonesian error
  strings); the pane never dead-ends.

## Intent router

First LLM call per message. Tiny system prompt listing the taxonomy; output constrained to one
uppercase token (`max_tokens: 8`, temperature 0) — the same single-token contract trick as
TantularGuard's SLM classifier.

**Taxonomy:**

| Intent | Meaning | Default context |
|---|---|---|
| `TANYA_DOKUMEN` | Q&A over the document | Main body (1B) |
| `EDIT_TEKS` | Revise existing text | Selection, else main body |
| `DRAFT_TEKS` | Create new content / insert text | None (cursor insert) |
| `TERJEMAH` | Translation | Selection |
| `RINGKAS` | Summarize | Selection, else main body |
| `UBAH_NADA` | Formal/santai tone conversion | Selection |
| `CEK_AMAN` | Scam/safety check | Selection |
| `UMUM` | Everything else, incl. router parse failure | **Selection or none — never auto-reads the main body** |

Parser is substring-tolerant; anything unparseable falls to `UMUM`. The `UMUM` fallback
deliberately does **not** get broad document context — generic chat must not unexpectedly read the
whole document; the user can flip the context pill explicitly.

Router prompt + taxonomy live in `intentRouter.js` only, so the Tinker fine-tune trains against
exactly this contract.

## Context builder — main-body document awareness

**Naming is deliberate:** this is *main-body* awareness. `context.document.body.text` excludes
headers, footers, footnotes, text boxes, and comments
([Word.Document docs](https://learn.microsoft.com/javascript/api/word/word.document?view=word-js-1.4)).
The UI says `Dokumen (isi utama)`; covering other surfaces is Stage 4 roadmap.

- **Selection:** existing `getSelectionContext` unchanged.
- **Main body ≤ ~6k chars:** passed raw.
- **Longer:** split on paragraph boundaries into ~3k-char chunks; each chunk summarized by the
  local model (map), summaries concatenated as document context (reduce), with progress in chat
  ("Membaca dokumen… bagian 3/7").
- **Hard cap:** ~60k chars with a clear message beyond it.
- **Cache:** v1 keys the reduced summary on a cheap whole-body hash. The cache is structured as
  `{ docKey, chunks: [{hash, summary}] }` so per-chunk invalidation can be added later (Stage 4)
  without a rewrite — v1 simply invalidates all chunks when the body hash changes.

## Agentic editing (Stage 2)

### Edit contract

`EDIT_TEKS` returns structured JSON, not prose:

```json
{
  "edits": [
    {
      "find": "<exact text from doc>",
      "replace": "<new text>",
      "before": "<up to ~40 chars preceding find, disambiguates>",
      "after": "<up to ~40 chars following find>",
      "occurrence": 1,
      "alasan": "<short reason, Indonesian>"
    }
  ]
}
```

### Validation gate (all before anything touches the document)

1. JSON parses and matches schema (`editContract.js`, pure function, unit-tested).
2. Each anchor resolves to **exactly one** location: `find` located, then disambiguated by
   `before`/`after` context and `occurrence`. One whitespace-normalized retry. Ambiguous or
   missing anchors mark that edit `⚠ tidak ditemukan` — never guessed.
3. Max 20 edits per run.

### Preview-before-apply (required)

Validated edits render in chat as a before/after preview list with per-edit checkboxes and one
**Terapkan (n)** button. Nothing is written without an explicit apply click — tracked changes are
recovery, not consent.

**Apply-time revalidation (required):** the document can change between preview and the apply
click. Immediately before writing, each checked edit is re-anchored against the current document
state (same resolution rules as the validation gate). An edit that no longer resolves to exactly
one location is not applied — it is reported `⚠ tidak ditemukan` (anchor gone) or `✖ dilewati`
(ambiguous), and the remaining edits proceed. A stale preview must never replace the wrong text.

### Apply path

- Runtime gate: `Office.context.requirements.isSetSupported("WordApi", "1.4")`
  ([requirement checks](https://learn.microsoft.com/javascript/api/office/office.requirementsetsupport)).
- Supported: set `document.changeTrackingMode = trackAll`
  ([ChangeTrackingMode](https://learn.microsoft.com/javascript/api/word/word.changetrackingmode)),
  apply each approved edit via `body.search` + range replace — each lands as a native tracked
  change the user accepts/rejects in Word's review UI. Prior tracking mode restored afterwards
  (also on error, via try/finally).
- Not supported: same preview flow, plain apply (no tracked changes), with a notice bubble.
- Result bubble reports per-edit status: `✔ diterapkan` / `⚠ tidak ditemukan` / `✖ dilewati`.

`DRAFT_TEKS` inserts at the cursor via existing `insertResultText` — no contract needed, but same
preview-then-apply flow when a document write is involved.

## Streaming and model

- Transport: dev-server proxy `/api/chat-completions` → Ollama **OpenAI-compatible**
  `POST /v1/chat/completions`. With `stream: true` this emits **SSE-style `data: {...}` chunks
  terminated by `data: [DONE]`** — not Ollama's native NDJSON (that applies only to `/api/chat`,
  which we do not use). `runTantularStream` parses SSE lines, invokes `onToken`, supports abort.
- **Proxy requirement:** `tools/dev-server.mjs` must pipe response chunks through unbuffered
  (verify; add flush handling if Node buffers). This is an explicit implementation-plan task.
- Router and edit calls stay non-streaming (contracts, not prose).
- Default model becomes `qwen3:8b`; settings UI still accepts any tag —
  `tantular:0.2-id-3b-lora` remains selectable, and a future 8B LoRA drops in with zero code
  change via the existing Modelfile path.

## Error handling

Every failure resolves to a chat bubble, never a dead pane:

| Failure | Behavior |
|---|---|
| Endpoint unreachable | Existing detection + Indonesian fix instructions, reused |
| Model tag missing | Existing "ollama pull …" message pattern |
| Stream abort (user stop) | Partial text kept, marked "(dihentikan)" |
| Router unparseable | Silent fall to `UMUM` (narrow context) |
| Edit anchor missing/ambiguous | Per-edit `⚠`, other edits proceed |
| WordApi < 1.4 | Preview + plain apply + notice |
| Doc > 60k chars | Clear refusal with the limit stated |

## Testing

- **Unit (`node --test`, first tests in this package; add `npm test`):** router output parsing,
  edit-contract validation + anchor resolution (incl. ambiguity cases), chunker boundaries,
  history compaction, SSE line parser. All pure functions by design.
- **Manual sideload checklist (Office.js cannot run headless):** chat over selection; long-doc
  summarize with progress; each intent routed correctly on 2 phrasings; edit preview → tracked
  changes visible in review UI; tracking-mode restoration; WordApi <1.4 degradation (Word
  version toggle or mock); stop button mid-stream; Ollama down.
- **Regression:** existing action grid and Deck Studio flows still work after chat lands.

## Source evidence

- Word `body` excludes headers/footers/etc.: https://learn.microsoft.com/javascript/api/word/word.document?view=word-js-1.4
- ChangeTrackingMode (WordApi 1.4): https://learn.microsoft.com/javascript/api/word/word.changetrackingmode
- Requirement-set runtime checks: https://learn.microsoft.com/javascript/api/office/office.requirementsetsupport
- Ollama streaming (native NDJSON vs OpenAI-compat): https://docs.ollama.com/api/streaming , https://ollama.readthedocs.io/en/openai/
