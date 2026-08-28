# Voice Deck (MVP)

A push-to-talk, voice-controlled web presentation. Vanilla HTML/CSS/JS, no
build step, no dependencies. This is the low-risk prototype for the command
contract and voice UX that will later drive native PowerPoint and Keynote
control — see `NATIVE_POWERPOINT_KEYNOTE_ROADMAP.md`.

## Run it

From the repository root:

```
python3 -m http.server 8080 --directory voice_deck
```

Then open **http://localhost:8080** in Chrome, Edge, or Safari.

Web Speech API requires a secure context: `localhost` works for local dev;
anywhere else you'll need HTTPS. Loading `index.html` via `file://` will not
work for speech recognition (and `fetch("slides.json")` will also fail under
`file://` in most browsers) — always serve it over HTTP(S).

## Using it

- **Push-to-talk**: hold `Space` (when focus isn't in a text field) or
  press-and-hold the mic button in the HUD. Release to stop listening.
  The mic is never always-on.
- **Typed fallback**: type a command into the HUD's "Typed command fallback"
  box and press Enter — the same parser and adapter run, so the demo works
  even if the microphone or a model is unavailable.
- **Keyboard**: `←`/`→`/`PageUp`/`PageDown` navigate, `Home`/`End` jump to
  the first/last slide, `N` toggles notes, `B` toggles blank, `H` hides/shows
  the HUD (for audience view), `Esc` clears the status line and un-blanks if
  blanked.
- **Language selector**: switch recognition between `id-ID` (default) and
  `en-US` at any time.

Example voice/typed commands (English or Indonesian both work):
`"next slide"` / `"lanjutkan"`, `"go back"` / `"mundur"`,
`"go to slide 3"` / `"ke slide tiga"`, `"go to pricing"` / `"buka bagian harga"`,
`"jump to design principles"` / `"buka prinsip desain"`,
`"show notes"` / `"tampilkan catatan"`, `"blank screen"` / `"layar hitam"`,
`"start presentation"` / `"mulai presentasi"`.

## Architecture

- **`commandContract.js`** — the normalized command shape
  (`{version, action, slide?, query?, source, confidence, transcript?}`),
  the list of valid actions/sources, `createCommand()`, and
  `validateCommand()`. Every command from every input source passes through
  validation before it reaches the adapter. This file has no DOM or browser
  dependency and is meant to be reused verbatim by future native adapters.
- **`intentRouter.js`** — turns a raw transcript/typed string into a
  normalized command. Runs a deterministic bilingual (id-ID/en-US) keyword
  parser first; only if that returns nothing does it optionally call Ollama
  (`config.ollama`) with a strict-JSON prompt, a short timeout, and only the
  transcript + slide *titles* (never notes or slide bodies). Any failure,
  timeout, or invalid model response falls back to a `noop` command — it
  never throws into the caller.
- **`topicMatcher.js`** — local, deterministic keyword scoring across slide
  title/body/tags for `goto_topic`. No network call. This is why topic
  matching stays fast and privacy-preserving even when Ollama is off.
- **`webDeckAdapter.js`** — the web presentation adapter. Applies a validated
  command to in-memory deck state (current slide, notes visibility, blanked,
  started/ended) and reports `{ok, message}`. This is the piece a
  `PowerPointAdapter`/`KeynoteAdapter` will reimplement against a native app
  later, with an identical `apply(command)` surface.
- **`voiceController.js`** — thin wrapper around the browser
  `SpeechRecognition` API. Only listens between `start()`/`stop()`
  (push-to-talk), and drops a final result if it's identical to the previous
  final result within `config.recognition.duplicateWindowMs` (recognizers
  commonly restart and re-emit the same final transcript).
- **`main.js`** — wires DOM, keyboard, buttons, typed input, and voice all
  into the same `routeIntent() → adapter.apply()` pipeline, and renders HUD +
  stage from `adapter`'s state on every change.
- **`slides.json`** — deck content: title, subtitle, and per-slide
  `title`/`body`/`notes`/`tags`.

Every recognized command is written to the HUD's "Last command" panel
(pretty-printed JSON) before or as it executes, per the visibility
requirement — there is no hidden/silent command execution.

## Scope / limitations (honest)

- **Web Speech API is not guaranteed offline.** Chrome/Edge typically stream
  audio to a browser-vendor speech service to produce a transcript; Safari's
  behavior varies by OS version. Don't present this build as offline or
  private. See the roadmap's Phase N4 for a genuinely offline path.
- Navigation commands (`next`, `previous`, `goto_slide`, `goto_topic`,
  notes/blank/resume/start/end) execute immediately on recognition.
  Document-editing commands are explicitly out of scope for this MVP and for
  the contract itself — see `commandContract.js`'s `isDestructiveAction()`.
- Ollama is optional and off by default in spirit (deterministic parsing
  handles the demo path); if `config.ollama.enabled` is `true` but nothing is
  listening on `http://localhost:11434`, the router just falls back to
  `noop` after `timeoutMs` — no crash, no hang.
- No microphone permission handling beyond what the browser provides: if the
  user denies mic access, `voiceController`'s `onError` fires and the HUD
  status line shows the browser's error message; the typed-command box and
  keyboard remain fully functional.

## Tests

```
node --test voice_deck/tests/*.test.mjs
```

Covers the command contract's validation rules, the deterministic bilingual
parser, local topic matching, and the web deck adapter's state transitions
(including that invalid/out-of-range commands are rejected, not silently
clamped).
