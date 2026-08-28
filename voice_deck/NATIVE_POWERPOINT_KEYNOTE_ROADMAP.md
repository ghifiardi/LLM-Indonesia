# Native PowerPoint / Keynote Roadmap

The web deck (`voice_deck/`) is the low-risk prototype: it validates the
command contract, the bilingual intent parsing, the push-to-talk UX, and the
HUD/visibility requirements against real audiences with zero install risk.
**Native PowerPoint and Keynote control is the actual production target.**
The web adapter and the native adapters described here consume the exact
same `commandContract.js` shape — nothing about the contract changes when
the transport changes.

## Why an Office task pane is not the slideshow runtime

The existing `tantular_office_addin/` in this repository runs inside an
Office **task pane** — a sandboxed web view docked next to the document. Task
panes are excellent for chat, lookups, and (with confirmation gates) document
edits, but they are the wrong place to run a presentation remote because:

- A task pane **only exists in the authoring view**. Once PowerPoint enters
  Slide Show mode (and always, for Keynote's Play mode), the task pane is
  not rendered — there is no DOM to receive commands or run
  `SpeechRecognition` in.
- Slideshow navigation (`next`, `previous`, `goto_slide`, blank/black
  screen) is exposed through the host application's own presenter APIs
  (PowerPoint's `SlideShowWindow`, Keynote's AppleScript/Scripting Bridge
  `document 1`'s slideshow), not through anything a web add-in's JS can
  reach — Office.js has no slideshow-control surface on either platform.
- Mac Office add-ins are already constrained to WordApi/PowerPoint
  low-level APIs (see the `tantular-word-host-limits` memory from the
  Office add-in work in this repo); relying further on task-pane presence
  during a live talk is a single point of failure a presenter cannot
  recover from mid-sentence.

Conclusion: native control needs a process that lives **outside** the
document/task-pane lifecycle and talks to the host app through its
automation surface (AppleScript / System Events / Apple's Scripting
Bridge), while speech capture and the command contract stay identical to
what's already built here.

## Phase N1 — macOS local controller service

A small, always-running local service (menu-bar app or headless daemon) that:

- Owns the push-to-talk capture (reuses the same push-to-talk discipline as
  `voiceController.js` — no always-listening mode here either) and the
  intent router (`intentRouter.js` ported as-is; it has no DOM dependency).
- Exposes the same normalized command JSON over a local-only channel
  (e.g. a Unix domain socket or `localhost`-bound HTTP, never bound to
  `0.0.0.0`) so a thin HUD (menu-bar status item, or the existing web HUD
  pointed at `localhost` instead of the in-page adapter) can show the same
  "last recognized command" visibility the web MVP has today.
- Does **not** talk to PowerPoint/Keynote directly — it hands validated
  commands to the Phase N2 adapters below. Keeping the controller and the
  adapters separate means the same controller works for either app, and a
  bug in one app's adapter can't take down speech capture for the other.

Deliverable: a controller that can be demoed against a stub adapter
(console-logs the command) before any AppleScript is written, so speech
capture + parsing correctness is validated independently of automation
risk.

## Phase N2 — PowerPoint and Keynote adapters

Two adapters implementing the same `apply(command)` surface as
`webDeckAdapter.js`:

- **KeynoteAdapter**: AppleScript is a first-class, well-documented
  automation surface for Keynote (`tell application "Keynote"`,
  `show`, `next`, `previous`, `show slide n of front document`,
  `start front document`, etc., plus a play-mode "black screen"). This is
  the lower-risk adapter to build first.
- **PowerPointAdapter**: Modern Mac PowerPoint's native AppleScript
  slideshow dictionary is thinner than Keynote's, so this adapter should be
  built against **System Events UI scripting** (keystroke-level control:
  Right Arrow/Left Arrow/`B`/`Esc` sent to the frontmost Slide Show window)
  as the default, with native AppleScript slideshow verbs used wherever
  Microsoft exposes them for the installed version. UI scripting is more
  brittle than AppleScript's object model, so this adapter needs explicit
  version pinning and a fallback-to-manual message (see rehearsal
  requirements below) if the expected UI elements aren't found. A small
  native macOS helper (Swift, using the Accessibility APIs directly instead
  of shelling out to `osascript`) is the natural next iteration if
  System-Events latency or reliability becomes a problem.
- Both adapters validate every incoming command with the *same*
  `validateCommand()` from `commandContract.js` before touching the host
  app — no adapter trusts its caller, exactly like `webDeckAdapter.js`
  today.
- Scope stays navigation-only in this phase, matching the web MVP:
  next/previous/goto_slide/goto_topic/notes/blank/resume/start/end. No
  document mutation.

## Phase N3 — presentation-state feedback and topic index sync

Phase N2 is one-directional (command → app). Phase N3 closes the loop:

- Adapters report current slide number, notes-shown state, and
  blanked/started/ended back to the controller after every command (and via
  a lightweight poll, since AppleScript/UI-scripting side effects can lag or
  fail silently) — this is what lets a HUD show a truthful slide counter
  instead of an optimistic one.
- The topic index (`topicMatcher.js`'s title/body/tag scoring) is built once
  from each document's actual slide titles/notes at adapter-attach time
  (via `properties of every slide` in Keynote AppleScript, or PowerPoint's
  slide title text via UI scripting/AppleScript where available) — not
  hand-maintained in a second `slides.json`, so `goto_topic` stays accurate
  as a presenter edits the deck between rehearsal and the real talk.
- This phase is also where drift gets caught: if the adapter's reported
  slide number disagrees with what the controller last commanded, that's
  surfaced in the HUD as a warning rather than silently trusted.

## Phase N4 — optional local Whisper/Core ML recognition

The web MVP is explicit that Web Speech API recognition is not guaranteed
offline. For dependable public presentation use — conference wifi that's
down, a client site with locked-down networking, or simply not wanting a
live mic feed leaving the building — Phase N4 swaps the recognition backend:

- A local Whisper.cpp or Core ML (Apple's on-device Speech framework, where
  license/accuracy trade-offs are acceptable) model running on-device, fed
  by the same push-to-talk capture window as Phases N1-N3.
- Everything downstream — `intentRouter.js`'s deterministic parser, the
  optional local Ollama fallback, `topicMatcher.js` — already runs fully
  local, so Phase N4 makes the *entire* pipeline offline-capable end to end,
  not just the parsing half.
- This phase is explicitly optional and last: it's a recognition-quality and
  ops investment, not a blocker for N1-N3 shipping and being useful in
  networked venues.

## Permissions and security boundary

- **Microphone**: standard macOS TCC prompt for the controller app; no
  microphone access should be requested by anything running inside a task
  pane or by the adapters themselves — capture is centralized in the Phase
  N1 controller.
- **Automation (AppleScript / System Events)**: macOS will prompt for
  "App wants access to control Keynote/PowerPoint/System Events" the first
  time each adapter runs; these are per-adapter, user-visible grants, not
  something the controller can silently acquire.
- **Accessibility** (only if a Swift/Accessibility-API helper replaces
  `osascript` for the PowerPoint adapter): requires the explicit
  Accessibility permission in System Settings, which is a stronger grant
  than Automation and should be requested only if UI-scripting latency
  genuinely requires it — not by default.
- **Network boundary**: the controller's command channel binds to
  `localhost`/a Unix socket only. Nothing about presentation control should
  ever be reachable from another machine; that would turn a presenter aid
  into a way for someone on the same network to hijack a live talk.
- **No document mutation**: every adapter in every phase enforces the same
  non-destructive scope as the web MVP. `commandContract.js`'s
  `isDestructiveAction()` stays a hook for a future confirm-gate, not a
  green light — the lesson from this repo's PowerPoint chat work
  (`tantular-ppt-chat-safety`: a single unconfirmed write once rewrote 7
  slides) applies directly here and argues for keeping edit-capable actions
  out of the voice path entirely, or behind an explicit, visible
  confirmation step if ever added.

## Rehearsal and fail-safe requirements

- **Always rehearse with the real deck, on the real machine, on the actual
  network the talk will run on** — AppleScript/UI-scripting behavior can
  vary by PowerPoint/Keynote version and by whether the app was already
  running before the controller attached.
- **The keyboard/clicker must keep working when the voice layer fails.**
  This is the same non-negotiable principle as the web MVP: native adapters
  send OS-level key events or app-level navigation calls, so a presenter's
  physical clicker or arrow-key presses keep working regardless of whether
  the controller, the adapter, or recognition itself is degraded.
- **Fail loud, fail local.** If an adapter can't find the expected
  Slide-Show window or gets an AppleScript error, the controller surfaces
  that in the HUD immediately (mirroring the web MVP's HUD status/error
  requirement) rather than retrying silently or queuing commands that might
  fire out of order once the app recovers.
- **A "detach and go manual" path must always exist** — stopping the
  controller (or just not using it) leaves the presentation exactly as
  controllable as it was before the controller existed. No native adapter
  should hold an exclusive lock on the document or the slideshow window.
