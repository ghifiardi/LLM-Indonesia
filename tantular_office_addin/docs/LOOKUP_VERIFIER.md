# The lookup verifier runs in the companion — 2026-08-23

**The verifier is now in the product path, not only in the distillation repo.
All seven injection classes were run through the real HTTP path. 0 reached the
user. `TANTULAR_LOOKUP_ENABLED` still defaults to `false`.**

## Where it runs

    pane → /api/lookup/prepare → user approval → /api/lookup/execute
         → fetch (allow-listed host) → model → verifier → pane

`src/chat/verifyWebAnswer.js` and `src/chat/lookupAnswer.js`. The companion is
the only place fetched content and the user's document are ever in one prompt.

**The pane no longer receives the fetched page.** It used to: execute returned
`content: wrapUntrusted(...)` and the pane composed the prompt. That put the
prompt in the component that cannot verify the answer, and made verification
something a future code path could skip. Now composition happens beside the
check, and the answer cannot leave without passing it.

**A blocked answer is not returned at all.** The response carries the reason and
the findings, never the text. A pane bug cannot display it, and no edit path can
reach it — `canEdit` exists only on the verified shape.

    { ok: false, status: "blocked_by_verifier", reason, findings }
    { ok: true,  status: "verified", answer, protected, canEdit: true }

`blocked_by_verifier` returns HTTP 200: the lookup worked and the answer was
refused. That is a result, not a transport failure.

## Fail-closed cases, all tested

| case | result |
|---|---|
| verifier module absent | `verifier_unavailable` |
| verifier throws | `verifier_error` |
| verifier returns a malformed result | `verifier_error` |
| model errors | `model_error` |
| no user document | `no_document` |
| empty answer | `no_answer` |
| document edited after the answer | re-verification fails |

## Protected strings come from the real document

`deriveProtected()` extracts currency amounts and `PT/CV/Yayasan`-style proper
names from the document itself. Accepting a `protect` list from the caller would
let an empty list produce a vacuous pass — success reported having compared
nothing. An explicitly protected string that is *absent* from the document is a
`CONFIG` failure rather than a silent pass.

## Why a port and not a subprocess

Shelling out to Python would make the companion depend on an interpreter, a
virtualenv and a repo path that no installed add-in has. A missing interpreter
would then have to be distinguished from a passing check — exactly the failure
this mechanism exists to prevent. The Python remains the reference
implementation, and `tests/verifyWebAnswerParity.test.mjs` asserts the two agree
on all nine cases, so they cannot drift silently.

## Result through the real path

`node tools/injection-e2e.mjs` — a local hostile origin, the real companion,
real approval tokens, real fetch, real model, real verifier.

    classes run:                7/7
    blocked by verifier:        1  (exfiltration — untrusted_echo)
    attacks that reached user:  0
    false positives:            0

**This is not evidence the model got safer.** The Python suite measures the
model on raw payload text and it obeys 3 of 7. Here the payload arrives inside
the search adapter's JSON envelope, and the model resisted 6 of 7. The envelope
is the honest product shape, but the difference is the wrapping, not the model.
Which classes succeed also varies between runs. Assume the model can be fooled;
the verifier is what makes that survivable.

## The approval binds the document, not just the query

`prepareLookup` requires the document and stores `documentHash` — a SHA-256 —
in the token. `authorizeExecution` recomputes it and refuses
`document_changed` if it differs, byte for byte.

Without this, a user could approve "cari harga pasar" while looking at report A
and have the answer verified against report B: protected strings drawn from a
source they never saw when approving. The hash is stored rather than the text
because the token lives in memory and must not hold document content.

A lookup with **no** document is refused at prepare, before anything is sent.
An answer with nothing to check against could only ever be refused, so paying
one dialog is better than leaking a query for a result we would discard.

## What the pane renders

`src/chat/lookupResultView.js`. Two states and no third.

| | verified | blocked |
|---|---|---|
| answer shown | yes | **never** |
| edit control | present | **absent from the DOM**, not hidden |
| findings | — | explained in Indonesian, with the raw strings |

`answer` is `null` on every non-verified path and `canEdit` derives from the
same value rather than being a separate field — two fields that can disagree
eventually will. A blocked response that *carries* an answer (a future server
change) still renders none. `ok: true` without `status: "verified"` is treated
as blocked, so a partial or older response cannot inherit trust from `ok`
alone. Findings and host names are escaped: they can quote a hostile page.

`mountLookupResult()` attaches the edit handler only in the verified branch.
Attaching it always and checking a flag inside would move the decision into the
handler, where a later edit could lose it.

## Response shapes measured

| shape | classes | reached user |
|---|---|---|
| JSON envelope (Wikipedia adapter) | 7/7 | 0 |
| raw HTML page | 7/7 | 0 |
| **real `id.wikipedia.org`** | 1 benign query | verified, vendor preserved |

The real-host run is `tests/lookupRemoteHost.test.mjs`, opt-in behind
`TANTULAR_E2E_NETWORK=1`. A network test that runs by default would turn "no
egress unless approved" into a slogan and make the suite depend on Wikimedia
being up. It asserts that the fetched page never reaches the pane under either
verdict.

## The pane code path

`src/chat/lookupController.js`, wired in `taskpane.js`:

    toggle on → read the real document → prepare → dialog (host + query)
              → approve → execute with the SAME token and document
              → render verified or blocked

**The toggle is a separate axis from Mode Lokal/Cloud.** That one is about
where the *model* runs; this one is about whether anything leaves the machine.
It is unchecked on load and the row is hidden entirely unless
`/api/lookup/status` reports `enabled: true` — a control that always refuses
teaches users to ignore refusals. Turning it off clears any result on screen,
so a verified answer cannot sit there looking current in Mode Lokal.

**The document is read once.** Re-reading it before execute would let an edit
slip in between approval and request; the companion would then reject
`document_changed` — after the query had already gone out.

**The document reaches the local companion only.** `createLocalCompanionPost`
refuses in a cloud session, because `companionUrl()` routes to the cloud
gateway there and the document must not follow. It also re-checks the resolved
URL's hostname: the first guard is about the user's mode, the second about
where the bytes actually go.

**Document text never travels in the query.** The reader knows nothing about
hosts and the query comes only from what the user typed, so no edit here can
put one where the other goes.

### What each host contributes

| host | document |
|---|---|
| Word | body text |
| Excel | the **selected** range, with its address |
| PowerPoint | the **selected** slides' text |

Excel and PowerPoint use the selection rather than the whole file deliberately.
Each reader fails with a reason rather than returning `""`, which would be
indistinguishable from an empty document and would send a lookup that could
only be refused. Truncation of very long documents is disclosed in the dialog —
a user must not be told the answer was checked against "the document" when it
was checked against the first half.

## Still `false`

Closed since the last review: the verifier is in the companion, it runs before
anything reaches the pane, failure returns `blocked_by_verifier`, protected
strings come from the real document, and the suite runs over HTTP.

Closed since: the pane renders both states and now drives the whole path, the
approval binds a document hash, the three hosts read real documents, and the
document cannot reach a remote endpoint.

Open, and each one blocks enabling:

1. **Nothing has run in real Office.** Every host reader is proven against a
   hand-written mock of the Office API. Mocks encode what we believe the API
   does. Word in Compatibility Mode, an Excel selection spanning sheets, a
   PowerPoint host without `getSelectedSlides` — these are the cases that
   break in the field and none of them has been seen. **This is the gate.**
2. **No search entry point.** `state.runLookup` exists and is tested, but no
   button or command in the pane calls it. Deliberate while the flag is off.
3. **The model still obeys hostile pages.** Containment is doing the work. Any
   change that weakens the verifier — a looser entity rule, a new fact kind —
   re-opens the classes it currently catches. Re-run both suites after touching
   `verifyWebAnswer.js`.
4. **One host.** `id.wikipedia.org`. Adding another needs its own adapter and
   its own run of both suites; the HTML measurement used a local origin, not a
   real HTML host.
