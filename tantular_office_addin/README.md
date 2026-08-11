# Tantular Office Add-in

Tantular Office Add-in is a Microsoft 365 / Office.js task-pane add-in for an Indonesian-first private assistant in **Word**, **Excel**, and **PowerPoint**.

The MVP is intentionally narrow:

- **Word:** grammar/style rewrite, formal/santai tone conversion, section summarization, scam/content safety checks, and **Document Studio** for generating structured `.docx` files from a brief or source text.
- **Excel:** formula explanation, simple formula drafting, selected-column text classification, text cleanup, and **Sheet Studio** for generating structured Excel workbooks.
- **PowerPoint:** convert pasted text into slide bullets, shorten overcrowded slide text, draft speaker notes, and **Deck Studio** — transform a brief into a full designed multi-slide deck (see `docs/DECK_STUDIO.md`).

The recommended production architecture is a **local companion model service** shared by every Office host. The task pane calls `http://127.0.0.1:11434/v1/chat/completions` by default, so it works with an Ollama/OpenAI-compatible local endpoint during development. A later packaged companion app can expose the same API via llama.cpp and one cached GGUF model instance.

## Project layout

```text
manifest.xml                 Office add-in XML manifest for Word/Excel/PowerPoint
src/taskpane.html            Main task-pane UI
src/taskpane.css             UI styling
src/taskpane.js              Office.js app controller
src/officeClient.js          Host-specific Word/Excel/PowerPoint read/write helpers
src/tantularClient.js        Local companion / OpenAI-compatible model client
src/prompts.js               Indonesian prompt templates by feature
src/document/                Document Studio planner and dependency-free DOCX builder
src/workbook/                Sheet Studio planner and dependency-free XLSX builder
assets/                      Local dev icons referenced by the manifest
docs/MVP_PLAN.md             Shareable MVP/product rollout plan
docs/LOCAL_COMPANION.md      Runtime and packaging notes for the local model service
docs/MODEL_PERFORMANCE.md    RAM limits, timeouts, 8B vs lite expectations, workshop troubleshooting
docs/MODEL_PERFORMANCE.pptx  Same material as a 9-slide facilitator briefing deck
docs/MODEL_PERFORMANCE.docx  Same material as a shareable Word handout
tools/dev-server.mjs         Dependency-free HTTPS static dev server
tools/check_manifest.py      Lightweight manifest sanity checker
```

## Quick start

From this directory:

```bash
# 1) Create a self-signed localhost certificate for Office sideloading.
npm run cert

# 2) Start the HTTPS dev server at https://localhost:3000.
npm run dev

# 3) In another terminal, run your local model endpoint.
# Example with Ollama:
ollama serve
npm run model:office

# 4) Validate manifest references.
npm run check
```

Then sideload `manifest.xml` in Word, Excel, or PowerPoint and open **Home → Tantular → Open Tantular**.

> macOS may require trusting `certs/localhost.crt` in Keychain Access before Office loads the task pane.

## Chat (Word)

Chat mode is available in Word only. The context selector cycles through four options: **Otomatis** (automatic context), **Seleksi** (user selection), **Dokumen (isi utama)** (main body only—headers, footers, footnotes, text boxes, and comments are excluded), and **Tanpa konteks** (no document context). On Word versions without tracked-changes API support (WordApi < 1.4), edits are applied directly with an Undo hint instead of as tracked changes. Edit requests show a preview before applying; changes are applied as Word tracked changes when you click **Terapkan**. Run `npm test` to verify the complete unit test suite (32 tests).

## Development model API

The add-in expects an OpenAI-compatible chat-completions endpoint:

```http
POST http://127.0.0.1:11434/v1/chat/completions
Content-Type: application/json

{
  "model": "tantular:0.2-id-3b-lora",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.1,
  "max_tokens": 512,
  "stream": false
}
```

Users can change the endpoint/model in the task pane. Settings are stored in `localStorage` for the current Office webview.

### Why Deck Studio uses a separate model

`tantular:0.2-id-3b-lora` is fine-tuned on 153 short Indonesian customer-service
and digital-safety examples. That makes it useful for concise support/safety
responses, but it is not trained for long presentation plans and its model
profile caps generation at 220 tokens.

Deck Studio therefore uses a separate **Model deck** setting. The recommended
profile is `tantular-office:0.4-9b`, built locally from `qwen3.5:9b`:

```bash
npm run model:office
```

If that alias has not been created yet, Deck Studio automatically falls back to
the installed `qwen3.5:9b` base. The general/chat model remains independently
configurable.

## Document Studio (Word)

In Word, **Document Studio** converts the shared source box, a selection, or the
main document body into a structured Word document. It supports professional
reports, proposals, executive memos, training modules, policy briefs, white
papers, and meeting/action notes.

The generated DOCX uses real Word styles and numbering for:

- title, subtitle, and metadata,
- executive summary,
- Heading 1 / Heading 2 sections,
- body paragraphs,
- real bullet lists,
- source-grounded callouts,
- conclusions and next steps.

Output can be appended to the active Word file, replace the active document
only when explicitly selected, or downloaded as a standalone `.docx`.

## Sheet Studio (Excel)

In Excel, **Sheet Studio** converts a brief, pasted text, or selected range into
a structured workbook. Supported starting points include trackers, data
templates, project/action plans, risk registers, inventory sheets, comparison
matrices, and survey codebooks.

Sheet Studio can:

- create one or more new sheets in the active workbook,
- explicitly replace the active sheet while creating remaining sheets safely,
- generate a standalone `.xlsx`,
- freeze the header row,
- apply readable header formatting, wrapping, and column sizing,
- preserve missing data as blank cells rather than inventing values.

Install the shared manifest into Excel for Mac with:

```bash
npm run sideload:excel
```

## MVP guardrails

- Hard safety instructions stay in the prompt for scam checks.
- The UI caps input length and batch rows to keep latency realistic for a 0.5B-1.5B local SLM.
- Excel classification writes labels to the adjacent column only after explicit user action.
- The add-in does not promise full deck design, large-document summarization, or data-analysis/math reliability.
