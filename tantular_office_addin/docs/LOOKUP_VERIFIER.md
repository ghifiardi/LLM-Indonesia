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

## Still `false`

Closed since the last review: the verifier is in the companion, it runs before
anything reaches the pane, failure returns `blocked_by_verifier`, protected
strings come from the real document, and the suite runs over HTTP.

Closed since: the pane renders both states, the approval binds a document hash,
two response shapes and one real remote host are measured.

Open, and each one blocks enabling:

1. **The pane does not yet CALL the lookup.** `lookupResultView` renders a
   response and `taskpane.html` has the container, but there is no mode
   toggle, no approval dialog and no code path in `taskpane.js` that reaches
   the companion. The rendering is proven; the trigger does not exist.
2. **Nothing reads the Office document into the request.** The binding is
   enforced end to end, but the pane must supply `document` from the real Word
   or Excel body, and that reader is not written.
3. **The model still obeys hostile pages.** Containment is doing the work. Any
   change that weakens the verifier — a looser entity rule, a new fact kind —
   re-opens the three classes it currently catches. Re-run both suites after
   touching `verifyWebAnswer.js`.
4. **One host.** `id.wikipedia.org`. Adding another needs its own adapter and
   its own run of both suites; the HTML measurement used a local origin, not a
   real HTML host.
