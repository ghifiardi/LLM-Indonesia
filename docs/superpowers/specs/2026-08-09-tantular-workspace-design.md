# Tantular Workspace — Cross-Host Content Hand-off and Shared Context

**Date:** 2026-08-09
**Status:** Approved design (brainstormed with user; refinements incorporated), pending implementation plan
**Scope:** The Tantular Companion becomes a local workspace hub so the Word, Excel, and PowerPoint panes can hand content to each other and share one set of project instructions. Same machine only; strictly local; explicit user actions on the receiving side. No orchestration, no cross-machine sync, no push transport in v1.

## Why the Companion is the hub

Office isolates task panes per host application; even `localStorage` is not reliably shared across the Word/Excel/PowerPoint webviews. The one thing every pane already shares — in desktop and Office-on-web alike — is the Companion at `https://localhost:3000`. v1 therefore adds a small workspace store to the Companion and polls it. Server-sent events are a possible later upgrade; rejected for v1 (webview connection lifecycles add fragility for marginal gain over ~4s polling). Cloud relays are rejected outright (contradicts the local-privacy story).

## Data model

Stored in one JSON document, persisted at `data/workspace.json` next to the Companion's working directory.

```json
{
  "rev": 41,
  "items": [
    {
      "id": "ws-01HZX…",            // stable unique id (ULID-style or uuid4); required for dedup and DELETE
      "created_at": "2026-08-09T12:34:56.789Z",   // server clock, ISO-8601 UTC
      "source_host": "Word",         // enum: Word | Excel | PowerPoint
      "kind": "selection",           // enum: selection | document | range | outline
      "label": "Bab 2 — Roadmap",    // derived by sender: first heading or first ~8 words
      "text": "…"                     // the payload, plain text/markdown
    }
  ],
  "context": {
    "instructions": "…",             // shared project/output instructions
    "updated_at": "2026-08-09T12:00:00.000Z",     // server-assigned
    "updated_by": "Word"             // host that saved it, server-recorded
  }
}
```

**Inbox semantics (exact):**
- Capacity 10. Inserting item 11 discards the oldest item (FIFO by `created_at`/insertion order).
- Insertion and deletion increment `rev`. A context save whose `instructions` equal the stored value is a no-op and does NOT increment `rev`.
- The cap is an implementation limit, not a durable collaboration history. The UI must make expiry unsurprising: the inbox list is titled "10 kiriman terakhir" and shows timestamps.

**Shared-context ordering:** "newest wins" uses **server ordering** — `updated_at`/`updated_by` are assigned by the Companion at write time; client clocks are never trusted or compared.

**Persistence:** atomic write via temp-file-then-rename on every mutation. On startup, a malformed or unreadable `workspace.json` is renamed aside (`workspace.json.corrupt-<ts>`) and the store starts empty — never crash the Companion over workspace state.

## API (Companion)

Same origin/CORS rules as the existing `/api/*` endpoints.

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| GET `/api/workspace` | — | `{rev, items, context}` | Poll target; clients compare `rev` |
| POST `/api/workspace/items` | `{source_host, kind, label, text}` | `{rev, item}` | Validated (below); server assigns `id`, `created_at` |
| DELETE `/api/workspace/items/:id` | — | `{rev}` | Unknown id → 404, no rev bump |
| PUT `/api/workspace/context` | `{instructions, source_host}` | `{rev, context}` | Server assigns `updated_at`, `updated_by` = source_host; no-op detection |

**Validation at the API boundary (reject 400 with an Indonesian message):**
- `source_host` ∈ {Word, Excel, PowerPoint}
- `kind` ∈ {selection, document, range, outline}
- `text`: non-empty after trim, ≤ 60,000 chars (matches the add-in's document HARD_CAP)
- `label`: ≤ 120 chars (server truncates rather than rejects)
- `instructions`: ≤ 8,000 chars

## Send UX (identical placement in all three hosts)

One button — **"Kirim ke aplikasi lain"** — in the existing *Teks / seleksi* card (whose content every host already populates via "Ambil seleksi" or paste). On click: derive `label` (first markdown heading, else first ~8 words), POST, then **immediately refresh** the local workspace view (do not wait for the next poll). `kind` = `range` when the Excel range formatter produced the text, `selection` otherwise; `document` and `outline` are accepted by the API but reserved — no v1 sender produces them (future whole-document and deck-outline senders). Button disabled with a hint ("Companion tidak terjangkau") when the Companion is unreachable.

## Receive UX

- **Polling:** every ~4s **only while the pane is visible** (`document.visibilityState === "visible"`; also pause when the settings-only view is collapsed is NOT required — visibility only). On fetch failure, back off to ~30s until a success. On `rev` unchanged, do nothing.
- **Banner:** when polling reveals an item newer than the last-seen `rev` AND `item.source_host !== this host`, show a banner: `Konten masuk dari {source_host}: "{label}" · {n} kata` with actions:
  - PowerPoint: **Pakai sebagai brief Deck Studio** (fills the deck brief/Teks-seleksi box)
  - Excel: **Pakai sebagai brief Sheet Studio**
  - Word: **Tempel ke Teks/seleksi**
  - All hosts: **Abaikan** (dismisses banner only; item stays in inbox)
- **Same-host items never trigger the banner** but appear in the inbox list.
- **Inbox list:** an "Ambil dari aplikasi lain" affordance (collapsible list under the Teks/seleksi card) showing the last-10 items with source, label, time; each row has the host-appropriate "Pakai" action and "Hapus" (DELETE).
- **Nothing changes without a click** — no auto-fill, ever. "Pakai" fills the target input; it does not auto-run any Studio.

## Shared project instructions

The existing *Project / output instructions* box (currently per-app `localStorage`) is promoted to workspace scope:
- Save ("Simpan instruksi") → PUT to the Companion AND localStorage (offline fallback).
- On pane load and on each poll: if the server `context.updated_at` is newer than what the pane last applied, adopt the server value (server ordering; no client-clock comparison). A subtle inline note shows provenance: "Instruksi bersama · diperbarui dari {updated_by}".
- Companion unreachable → behave exactly as today (localStorage only).

## Acceptance path and rollout order

Primary acceptance flow (manual checklist): **Word → PowerPoint → Excel** — send a Word selection, receive as Deck Studio brief in PowerPoint, send PowerPoint's outline text onward (as `selection` from the Teks/seleksi box), receive as Sheet Studio brief in Excel. Reverse directions ship only where a clear insertion target already exists — in v1 that is "Tempel ke Teks/seleksi" (universal, all hosts); a dedicated Excel-range→Word-table insert action is explicitly deferred.

## Error handling summary

- Companion down: send disabled with hint; polls back off; shared instructions fall back to localStorage. No error dialogs from polling.
- Malformed store file: quarantined and reset at startup (Companion log line).
- Oversized/invalid POST: 400 with Indonesian message surfaced in the pane's status line.

## Testing

- `node --test` (companion side): workspace module pure-function tests (FIFO discard at 11, rev increments on insert/delete, no-op context save doesn't bump rev, validation matrix, label truncation) + HTTP round-trip tests against the real dev-server (POST→GET→DELETE, context PUT with server-assigned fields, atomic-persist recovery from a deliberately corrupted file).
- Pane side: pure-function tests for label derivation and banner text (word count); polling/backoff logic extracted into a testable helper with fake timers where the existing test setup allows.
- Manual checklist (docs): the Word→PowerPoint→Excel acceptance path on one machine, plus Companion-down behavior.

## Resolved decisions (user review, 2026-08-09)

1. **Item lifecycle.** "Abaikan" is a **per-pane banner dismissal only** — implemented client-side (the pane records the dismissed item id locally); the item remains in every pane's inbox and on the server. "Pakai" **does not delete**: it fills the target and marks the item visually as used in that pane (✓), preserving fan-out (one Word section → both a deck brief and a sheet brief). Global removal happens only via explicit "Hapus" (DELETE) or FIFO expiry.
2. **Insertion semantics.** Every "Pakai/Tempel" action **replaces** the target box's content. If the target box is non-empty and differs from the incoming text, an inline confirmation is required first: "Kotak tujuan sudah berisi teks — ganti?" [Ganti] [Batal]. Append is not offered in v1.
3. **Cheap polling.** `GET /api/workspace?since_rev=N` returns **304 with an empty body** when `rev <= N`, else the full `{rev, items, context}`. Clients always send `since_rev` after their first fetch. (Chosen over ETag for simplicity; semantics identical.)
4. **Escaped, text-only rendering (hard rule).** Workspace-derived strings (labels, text, host names) cross webview boundaries and MUST be rendered exclusively via `textContent`/`createTextNode` — never `innerHTML`/insertAdjacentHTML. The banner/inbox builders are pure functions returning strings consumed as textContent, unit-tested; a test also asserts no workspace render path contains `innerHTML`.

**Prioritization (user):** Workspace implementation runs AHEAD of the remaining fine-tune fix queue (which resumes afterward), keeping the one-implementer-at-a-time rule.

## Out of scope (v1)

Cross-machine sync; SSE push; auto-fill; orchestrated multi-app generation; per-item provenance beyond source_host; item kinds beyond the four listed; deck-outline sender (kind reserved); Excel-range→Word-table structured insert.
