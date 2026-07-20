# Tantular Office Add-in

Tantular Office Add-in is a Microsoft 365 / Office.js task-pane add-in for an Indonesian-first private assistant in **Word**, **Excel**, and **PowerPoint**.

The MVP is intentionally narrow:

- **Word:** grammar/style rewrite, formal/santai tone conversion, section summarization, and scam/content safety checks.
- **Excel:** formula explanation, simple formula drafting, selected-column text classification, and text cleanup.
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
assets/                      Local dev icons referenced by the manifest
docs/MVP_PLAN.md             Shareable MVP/product rollout plan
docs/LOCAL_COMPANION.md      Runtime and packaging notes for the local model service
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
ollama run tantular:0.2-id-3b-lora

# 4) Validate manifest references.
npm run check
```

Then sideload `manifest.xml` in Word, Excel, or PowerPoint and open **Home → Tantular → Open Tantular**.

> macOS may require trusting `certs/localhost.crt` in Keychain Access before Office loads the task pane.

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

## MVP guardrails

- Hard safety instructions stay in the prompt for scam checks.
- The UI caps input length and batch rows to keep latency realistic for a 0.5B-1.5B local SLM.
- Excel classification writes labels to the adjacent column only after explicit user action.
- The add-in does not promise full deck design, large-document summarization, or data-analysis/math reliability.

