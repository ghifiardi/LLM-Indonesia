# Native Presentation Bridge — Phase N1

A local HTTP service that accepts the **same versioned command JSON** the web
deck already emits, validates it, and hands it to an adapter.

In N1 the adapter is a **dry run**: it records what a native adapter *would*
do and drives nothing. No AppleScript, no `osascript`, no child process. The
point of this phase is that the transport, the contract and the authentication
can be reviewed while the bridge is still incapable of touching a real deck.

## Run

```bash
node voice_deck/bridge/server.mjs --port 8777 --slides 8
```

It prints a **session token** on startup. Every call except `/health` must
present it:

```
Authorization: Bearer <token>        (or)        x-tantular-token: <token>
```

The token is minted per run and never stored, so restarting the bridge
invalidates it.

## Endpoints

| Method | Path | Token | Purpose |
|---|---|---|---|
| GET | `/health` | no | liveness and adapter name — you must be able to ask "is it up?" without a credential |
| GET | `/state` | yes | presentation state plus the recent action log |
| POST | `/command` | yes | validate and dispatch one command |

There is deliberately **no** endpoint that runs a shell command, AppleScript,
or arbitrary code. A test asserts `/exec`, `/shell`, `/applescript`,
`/osascript`, `/run` and `/eval` all return 404.

```bash
curl -X POST http://127.0.0.1:8777/command \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"version":1,"action":"goto_slide","source":"voice","confidence":1,"slide":6}'
```

## Why it is built this way

**Loopback is not a security boundary.** Binding `127.0.0.1` keeps the venue
wifi out, but every process on the machine can still reach the port, and any
web page can attempt a cross-origin request to it. Hence the session token,
compared in constant time, and a `Host` header check that refuses anything
which is not a loopback literal — that check is what stops DNS rebinding, in
which a page on any origin resolves its own hostname to `127.0.0.1`.

**Validation happens before dispatch, always.** The deck validates on the way
out, but the deck is not the only thing that can POST to this port. Bodies are
capped at 16KB and must be JSON objects.

**Failures are contained.** An adapter that throws yields a 500, not a dead
bridge; an adapter that refuses yields 422, never a false success. A busy port
prints one line and exits instead of dumping a stack trace at someone who is
about to present.

**Slide movement clamps.** Running off the end of a deck stops at the last
slide rather than wrapping to the first, which mid-talk is the difference
between a pause and a visible mistake.

## What N2 changes

The dry-run adapter is replaced by per-application adapters — Keynote first,
then PowerPoint — exposing the same `apply()`/`getState()` methods. Voice
recognition, intent routing and this transport do not change.

`goto_topic` is recorded **unresolved** here on purpose: only the live
application knows what is on each slide, so N2 resolves it and can be compared
against exactly what was asked for.

That step is where the risk arrives: macOS Automation permission, and commands
that move a real presentation. It should not be taken until this layer is
boring.

## Rehearsing against the web deck

```bash
node voice_deck/bridge/server.mjs --port 8777 --slides 8   # copy the token
# set config.bridge.enabled = true in voice_deck/config.js
python3 -m http.server 8081 --directory voice_deck
```

Open the deck, paste the token into **Bridge session token** in the HUD, press
Connect. Every command the deck applies is then mirrored to the bridge, and
the HUD line reports what the bridge did with it.

The deck applies each command to its own adapter **first** and never waits on
the bridge to redraw. A bridge that is down, slow or holding a stale token
costs the mirror line and nothing else — which is the only acceptable
behaviour while someone is presenting.

`config.bridge.enabled` is **false** by default, and the HUD row stays hidden
until it is on, so an ordinary demo never shows a control it cannot use.

### Topic resolution during rehearsal

The deck resolves `goto_topic` against its own `slides.json` and sends the
resulting `goto_slide`, because in rehearsal the deck *is* the presentation.
Once a native adapter exists, the app is the source of truth and `goto_topic`
travels unresolved for the adapter to match against live slide titles — which
is why the dry-run adapter records it unresolved rather than guessing.

## Adapters (N2)

Selection is an explicit flag and **defaults to `dry-run`**:

```bash
node voice_deck/bridge/server.mjs --adapter dry-run              # inert (default)
node voice_deck/bridge/server.mjs --adapter powerpoint           # rehearsal: logs scripts, executes nothing
node voice_deck/bridge/server.mjs --adapter powerpoint --execute # drives the live app
```

Executing is a **second, separate** opt-in on top of choosing an adapter. A
bridge started by accident, by a stale script, or with a typo drives nothing —
an unknown adapter name refuses to start rather than falling back to one that
moves a real presentation.

### The shared interface

Every adapter implements `capabilities()`, `state()`, `next()`, `previous()`,
`goto_slide(n)`, `goto_topic(query)`, `blank()`, `resume()`, `start()`,
`end()`. Dispatch routes by **action name**, so it knows the contract and
never an application: Keynote (N2.5) drops in without touching the bridge, the
voice layer, intent routing, or the command contract.

### Rehearsal observes, but never moves

The read-only capabilities probe executes **even in rehearsal**; every
mutating script is logged and skipped. Rehearsal exists to stop the bridge
moving a presentation, not to stop it looking at one — a preflight that
observes nothing cannot tell you whether enabling execution is safe. A test
asserts exactly one script carries the exemption and that it is the probe.

So `--adapter powerpoint` without `--execute` gives a truthful preflight:

```
adapter: powerpoint   rehearsal: true
running: true   frontmost: false   inSlideshow: false   permission: granted
```

### Cross-origin access

The deck is served on its own port, so every call it makes to the bridge is
cross-origin. Loopback origins are echoed in `Access-Control-Allow-Origin`;
anything else gets none, and its preflight is refused with 403. The wildcard
`*` is never used — a page on the open internet must not be able to read a
service that drives a presentation.

Preflight is answered **before** the token check, because a browser never
sends `Authorization` on an `OPTIONS` request. CORS decides who may READ a
reply; the session token still decides who may act, and an allowed origin
without a token still gets 401.

### The fail-safe rule

If an adapter cannot confirm a safe slideshow target, it does nothing and
reports why. It never guesses and never sends stray keystrokes.

| Condition | Result |
|---|---|
| app not running | refused, `app-not-running` |
| open but **not presenting** | refused, `no-slideshow` |
| Automation permission denied | refused, `automation-permission-denied`, with the System Settings path |
| topic matches no slide title | refused, `topic-not-found` |

The second row is the one that matters most: PowerPoint frontmost in edit view
is exactly when a stray "next" stops being a no-op and becomes an edit to
someone's document. Refusals return HTTP 422 with `refused: true`, so a
deliberate refusal is never confused with a fault.

`goto_topic` is resolved against the **live application's** slide titles, not
the deck's `slides.json` — with a native adapter the app is the source of
truth. A query containing quotes or backslashes is refused outright rather
than escaped: it is matched, never executed, so nothing is lost by refusing.

`capabilities()` probes through System Events. A bare `tell application
"Microsoft PowerPoint"` would **launch** PowerPoint on a machine where it was
closed, just to ask whether it was running.
