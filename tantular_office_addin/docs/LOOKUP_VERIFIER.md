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

## Still `false`

Closed since the last review: the verifier is in the companion, it runs before
anything reaches the pane, failure returns `blocked_by_verifier`, protected
strings come from the real document, and the suite runs over HTTP.

Open, and each one blocks enabling:

1. **The pane does not render these states yet.** `verified` and
   `blocked_by_verifier` are returned but no UI distinguishes them, so a user
   would see nothing for a blocked answer.
2. **The document is whatever the caller passes.** The pane must send the real
   document text, and that wiring does not exist.
3. **One host, one adapter.** `id.wikipedia.org` only, and its JSON envelope is
   the shape all the e2e evidence rests on. A host returning raw HTML has not
   been measured.
4. **The e2e harness uses a local origin.** No run against a real remote host
   has been done under the verifier.
