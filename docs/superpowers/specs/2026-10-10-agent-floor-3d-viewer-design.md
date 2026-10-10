# Agent Floor: read-only 3D viewer for `resident` and `GodelAgent`

Status: design, awaiting review. No implementation exists.

## Purpose

Let the owner watch what this repo's agents are doing, live and in replay, as a
3D "factory floor": workers act on candidates that move between pipeline
stations. The goal is observability. It is not decoration, and it is not a
control surface.

Agents in scope: the `resident/` system (supervisor, serve, reflect and audit
children, canary, gate, promote, rollback, freeze) and `GodelAgent`
(`godel_agent.py`). Out of scope: Tantular chat and Office agents.

## Non-goals (v1)

- Any control: no freeze, unfreeze, promote, rollback or canary action.
- Editing `resident/supervisor.py`. Explicit child spawn/exit events are a
  separate, later decision. Until then, Reflect and Audit activity is shown as
  *observed-work markers*, never as a worker evidenced to be running.
- Demo or mock data in any attached state. A missing source shows "not attached".

## Architecture

```
resident state dir --(raw sqlite3, mode=ro)--> tailer --SSE--> browser (Three.js)
GodelAgent --(optional event_sink -> JSONL)---> tailer --^
```

- `viewer/server.py`: local HTTP server bound to `127.0.0.1`.
- The tailer opens the resident database with its own `sqlite3` connection using
  `file:<path>?mode=ro`. It does **not** go through `ResidentStore`, so no
  migration or recovery path is reachable. It reads the recorded schema version
  and refuses to attach to an unknown version.
- The viewer imports no gate, promote, freeze, canary or rollback code. A test
  asserts the import set (same approach as `resident/serve.py`).
- The browser loads Three.js from a pinned CDN version. All other code is local.

### Reading events

`ResidentStore.list_events()` returns newest first and omits `seq`, so it is not
used. The tailer runs
`SELECT seq, event_id, created_at, kind, candidate_id, payload_json FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`.
`events.seq` is an `AUTOINCREMENT` primary key and is monotonic per database.

### GodelAgent sink

`GodelAgent` gains an optional `event_sink` callable, default `None`. With no
sink, behaviour and existing tests are unchanged. A sink wrapper catches and
counts its own exceptions and exposes `status()` (writes, failures, last error
class) on a channel separate from agent results. A failing sink must not change
any `EvaluationResult`, score, rollback decision or exception raised by the
agent. Events cover inspect, interact, mutate, keep and rollback.

## Event contract

```
{ source, run_id, seq, ts, kind, action, candidate_id, worker|null,
  station|null, payload_summary, raw_kind }
```

- `seq` is scoped to `(source, run_id)`. SQLite and JSONL sources keep
  independent cursors. `worker` and `station` are nullable.
- The normalizer is a pure function over `kind` **and** structured payload
  fields (for example `payload.event` on `serve_lifecycle` and
  `supervisor_lifecycle`). An event it cannot map becomes a visible *unmapped
  marker* that keeps `raw_kind`; it is counted in the status bar and never
  dropped or guessed.
- `payload_summary` carries only whitelisted structured fields. Query text,
  answers and child stderr are never forwarded to the browser.

### Reconnect

The SSE event id is an opaque encoding of a **cursor map**, one entry per
`(source, run_id)`. On reconnect the tailer resumes every source from the map in
`Last-Event-ID`. The reducer deduplicates on `(source, run_id, seq)`. If a
source is replaced or reset (new `run_id`, database recreated, `seq` going
backwards), the tailer announces a source-reset event and the reducer starts a
new run for that source instead of merging into the old one.

## Scene

Stations on a conveyor: Intake, Reflect, Archive, Audit, Gate, Canary,
Champion. A separate bay for the `GodelAgent` loop: Inspect, Interact, Mutate,
Keep/Rollback.

### Workers and presence

Workers are derived from lifecycle events, not a fixed cast.

- Supervisor: `started`, `heartbeat`, `stopped`. Serve: `started`, `exited`,
  `not_ready`, `start_failed`, `stopped`.
- Presence means **last observed running**. A crash can leave no `stopped`
  event, so presence goes *stale* when heartbeats stop and *unknown* when
  lifecycle evidence is incomplete. Serve `exited`, `not_ready` and
  `start_failed` set visible failure states.
- Reflect and Audit have no spawn/exit events today (`_spawn()` returns an
  outcome; `clock_fired` records summary flags only). They appear as observed-work
  markers tied to the event that supports them: `clock_fired`, candidate audit
  records, `batch_audit`. A worker figure walks only when an event assigns it
  work. Between events it holds still and shows its last known state and age.

### Objects and transitions

- Experiences enter at Intake. Candidates are crates tinted by status and move
  only to the station named by an event that touches them.
- A veto (`canary_veto`, `champion_veto`, served-request events from the spool)
  puts a rejection marker at Canary or the serving path. It does not move a
  candidate backward.
- Rollback marks the outgoing champion `ROLLED_BACK` and promotes the chosen
  ancestor. Animate only those two recorded relationships.

### Freeze

A freeze puts barriers on the **blocked routes only**. Verified in code:
reflection is gated on `not frozen`; the audit clock runs regardless; rollback
deliberately leaves a freeze in place; canary activation checks `is_frozen`.
Whether promotion is blocked under freeze is **verify during implementation**
(`resident/promote.py` was not fully traced). Until verified, the promote route
shows an "unverified" barrier state. Audit, rollback and serving keep animating.

### Time and honesty indicators

- One **presentation clock** drives interpolation and every age label. In replay
  it is the replay position. In live mode it is wall time advanced by a
  `requestAnimationFrame` loop (and a 1 s timer when the tab is hidden), anchored
  to the timestamp of the newest event seen. Age labels therefore keep growing
  during silence with no new events.
- Two separate indicators: **domain activity** (age of the last real work event)
  and **stream freshness** (age of the last event of any kind). Heartbeats
  update only stream freshness, so they cannot make a quiet floor look busy.
- The reducer is the single source of truth. Animation only interpolates toward
  reducer state; identical position gives identical state.

### State reconstruction

Attaching live and seeking in replay both rebuild state from the start of the
run, or from a snapshot plus the events after it, before the selected position
is displayed. Nothing is shown at a position until its rebuild completes.

## Error handling

| Condition | Behaviour |
|---|---|
| DB missing, locked, or unknown schema version | "Not attached" banner with the reason. Retry with backoff on a temporary lock. No demo fallback. |
| Malformed JSON (JSONL line or `payload_json`) | Skip the line, count it, show a marker with the source and position. |
| Unmapped event | Marker retaining `raw_kind`, counted. |
| Duplicate event | Dropped by the reducer on `(source, run_id, seq)`. |
| Source replaced or reset | Source-reset event, new run, old run kept for replay. |
| Browser disconnect | SSE reconnect with the cursor map. No event lost or double-applied. |
| Sink exception | Counted in sink status. Agent outcome unchanged. |

## Testing

Principle: fixture-only or mocked-only evidence is not acceptance (see the
black-box verification rule).

1. **Read-only proof.** Through the viewer's connection, attempt a write. It must
   fail at the driver level. Assert the viewer's import set excludes
   gate/promote/freeze/canary/rollback modules.
2. **Real state directory.** Drive a temporary state directory through the real
   `resident` CLI (`init`, `record`, `reflect-once`, `audit`, `freeze`,
   `rollback`).
3. **Database comparison at a captured cutoff.** Capture the maximum `seq` and
   read authoritative DB state (champion, frozen flag, candidate statuses) in the
   same read transaction. Compare the reducer's state at that cutoff against it.
   Any field the event history cannot reconstruct is reported as **unknown**; it
   must be neither filled in nor silently equated.
4. **Replay equivalence.** State at position N rebuilt from the start equals
   state rebuilt from snapshot plus later events, and equals live tailing at N.
5. **Normalizer table.** Every known `kind` and `payload.event` combination, and
   unknowns producing markers.
6. **Failure tests.** Malformed JSON, sink exceptions, temporary DB locks,
   disconnects, duplicates, and source replacement or reset. Assert recovery
   preserves events, and that sink failures preserve agent outcomes (same
   `EvaluationResult` with a raising sink as with none).
7. **Interleaved reconnect.** Interleave SQLite and JSONL events across repeated
   disconnects. The final reducer state equals the no-disconnect run.
8. **Rendered scene.** In a headless browser against a real state directory,
   assert actual scene objects and barrier visibility, not only reducer state.
   Frozen-audit activity is checked on a **fresh, isolated run** (new state
   directory, no prior audit events) so it cannot pass on older audit markers.
9. **Clock.** With a controlled clock and no new events, age labels increase;
   a heartbeat advances stream freshness but not domain activity.

## Open items for implementation

- Verify the promote path under freeze (`resident/promote.py`).
- Confirm which fields the event history cannot reconstruct, to populate the
  "unknown" list in test 3.
- Choose the headless browser tooling for test 8.

## Deferred

- Spawn/exit events for Reflect and Audit children (`resident/supervisor.py`).
  This touches code governed by the Phase 5B observation gate and needs its own
  design.
- Any control surface.
