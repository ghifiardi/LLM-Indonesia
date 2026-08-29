# Cloud Mode: metered credits, free trial, and pay-as-you-go

Date: 2026-08-29
Status: approved design, not yet implemented

## 1. Purpose

Tantular's Cloud Mode today is free to use and free to abuse. `workshop/api/chat-completions.js`
is a public, OpenAI-compatible proxy holding the account owner's upstream key, with no
identity, no meter, and no ceiling. Anyone who finds the URL bills the owner's account.

This design turns that route into a metered gateway: an anonymous visitor gets a one-off
free allowance, a signed-in user can buy credits with Indonesian payment methods, and
every upstream call is reserved against a balance before it is made.

### Decisions taken before design

- **The owner pays upstream; users pay the owner.** Not bring-your-own-key.
- **Anonymous free trial; sign-in only to pay.** Best conversion funnel, so the anonymous
  allowance must be small enough that resetting it is not worth anyone's time.
- **Credits are tokens.** The only unit where per-user revenue cannot fall below
  per-user cost.
- **Midtrans or Xendit** as the payment rail, because QRIS, VA, and e-wallet are how
  Indonesian buyers actually pay. Written below as Midtrans; Xendit is a drop-in at the
  `orders`/webhook boundary.
- **Scope covers both the portal and in-Office Cloud Mode**, with no change to routing
  or consent logic.
- **Target scale is a public launch**, hundreds to thousands of users, with no date
  pressure forcing shortcuts.

### Out of scope

Organization/seat billing, invoicing UI, subscriptions (only credit packs), **true
passthrough streaming** (§4.9), and provider failover. The schema leaves room for orgs and
tax invoices; no code is written for them now.

## 2. What already exists

- **`src/companionUrl.js`** routes a session to the local companion or the hosted
  gateway. Case 3 in its header — "Installed Office add-in, mode `cloud`" — already
  ships, gated by a `chosenInOffice` consent record that only the in-pane toggle running
  under a real Office host can write. `loadMode()` fails closed. **This design changes
  none of it.**
- **`workshop/api/chat-completions.js`** already pins `model`, `temperature`, `top_p`,
  `presence_penalty`, and `chat_template_kwargs`, caps the body at 256 KB, strips
  `reasoning_effort`, and forwards the client's own system prompt. It is already the
  single chokepoint every cloud call passes through, which is why it is the right place
  for a meter.
- **MSAL is vendored** and `src/auth.js` exists from the Microsoft 365 sign-in work.
- **`src/tantularClient.js` retries** certain failures. Under a meter this is a
  double-charge hazard; see §4.5.

### Pre-existing defect this work must fix

`streamedAnswer` (`src/chat/pipelines/index.js:31`) is the shared helper for **seven of the
eight pipelines**, including `UMUM`, the default chat path; only `EDIT_TEKS` uses the
non-streaming `runTantular`. `runTantularStream` sends `stream: true` and parses the reply
with `createSseAccumulator`, which yields only lines beginning with `data:`
(`src/chat/sse.js:15`). The gateway forces `stream: false` and returns a plain JSON body,
so no `data:` line ever appears, the accumulated text stays empty, and
`src/tantularClient.js:572` throws `"Model tidak mengembalikan teks."` There is no
fallback path.

**Read from the code, ordinary chat in Cloud Mode is therefore broken today** — which is
consistent with the recent portal fixes all landing on the non-streaming structured
pipelines, where the bug cannot surface. This has not been executed against the live
gateway; confirm it black-box before the plan is written. §4.9 fixes it.

### Correction required

`workshop/api/chat-completions.js:9-11` states that the installed add-in never reaches the
route and that "an install stays local-only exactly as promised." That is false as of
`companionUrl.js:6-8`, and the comment is corrected as part of this work.

`workshop/privacy.html:102` is **not** wrong: it already scopes its claim to "Content
processed exclusively in Local Mode." The gap there is the opposite one — **Cloud Mode is
not disclosed at all**. Section 2 of the policy describes only local processing, so once
cloud is a paid, promoted feature the policy must gain a Cloud Mode section stating what
is transmitted, to whom, and what is retained (per §6.6: sizes and usage, never content).
That is a launch blocker for the billing work, not for the streaming fix.

## 3. Identity and accounts

### Principals

`accounts` rows are `anon` or `user`. An `org` kind is left as a future column and is not
built. Everything downstream — ledger, holds, limits — keys off `account_id` and does not
branch on kind.

### Anonymous trial

On a cloud request with no credential, the gateway creates an `anon` account and returns
an opaque session token: random, stored in the DB as a hash, revocable. The client keeps
it in `localStorage` and sends it as a bearer header — **not a cookie**, because a bearer
header behaves identically in the portal and in the Office task-pane webview, where
cookie policy on Mac Office fails in the field rather than in testing.

The token *is* the anonymous account. There is no device fingerprinting: it is weak, and
it is a privacy claim this product should not have to defend.

Discarding a token to get a new one is therefore trivial **by design**. Farming is
prevented at *issuance* (§6.2), on one code path, rather than by scattered heuristics.

### Sign-in

Microsoft first, via the vendored MSAL and `src/auth.js`. Google can be added later
behind the same `auth_identities` table (`provider`, `subject`, unique together) without
touching `accounts` or the ledger. Sign-in is required only in order to buy.

### Claim-on-sign-in

When an anon account signs in, its remaining balance and history transfer to the user
account. Without this, a user who buys credits and then signs in loses what they paid
for, which is the fastest available way to destroy trust in a paid product.

Hard requirements:

- **Atomic and idempotent.** One transaction locking the anon account, the user account,
  and the relevant ledger rows. Re-running the same claim is harmless.
- The anon account is marked `claimed` and inactive, storing `claimed_by_account_id` and
  `claimed_at`.
- **Audit history is preserved, and ledger rows are never reassigned.** The ledger is
  append-only (§6.1), so ownership must not move. A claim writes exactly two
  `claim_transfer` entries — a negative entry on the anon account and a positive entry on
  the user account — sharing one `claim_id` and carrying source-account metadata.
  Historical anon rows are preserved in place, displayed as part of the user's history,
  and never reassigned or discarded.
- The session token is rotated as part of the claim.

One user account holds many sessions — portal on a laptop, add-in in Word, phone — all
reading one balance.

### Free allowance

- A **one-off** grant on anon account creation, sized to roughly one real Deck Studio run
  plus some chat.
- A **second one-off** grant the first time an identity signs in — once per identity,
  ever, not per sign-in.
- **No recurring free quota.** A monthly free tier on a product that hands out anonymous
  accounts is a bill renewed for farmers forever, and with tokens-as-credits every unit of
  it is real money. A genuinely generous one-off grant demonstrates the product better
  than a small monthly drip.

Final sizes are set from shadow-mode data (§7.6), not guessed now.

### Tables

`accounts`, `auth_identities`, `sessions`. No passwords, no email delivery, nothing to
leak.

## 4. The meter

### 4.1 Correctness before speed

Redis holds rate limits and a **display** balance only. Authorization happens in a
Postgres transaction. A cached balance lets two concurrent requests both read "enough"
and both proceed; this is slightly slower and is the only version that is correct.

### 4.2 Reserve → call → settle

A reservation is a row in a `holds` table, never a decrement of a balance column.

    available = sum(ledger_entries.credits) - sum(open holds)

evaluated inside the transaction that creates the hold, with the account row locked.
Concurrent requests on one account therefore serialize, and a crash is recoverable: a
hold has a TTL and a sweeper closes abandoned ones, whereas a lost decrement is money
that has simply vanished.

### 4.3 The reserve is derived server-side

The gateway already pins `model`, `temperature`, and `top_p`; it will also pin
`max_tokens`. Worst-case output then becomes a constant the gateway chose:

    reserve = estimated_input_tokens + pinned_max_tokens

Input is estimated from serialized message bytes using a deliberately conservative
characters-per-token ratio for Indonesian. No client input is trusted: a client that lies
can only enlarge its own reservation.

### 4.4 Settle uses the truth

`usage` returns in the response body. The deployment is `stream: false`, so this is nearly
free today. Settle writes a `debit` for actual usage and closes the hold.

**Known future cost:** when true passthrough streaming arrives (§4.9), usage comes in a
final SSE chunk and the gateway must parse the stream to bill it. The design stays valid;
it stops being free. The v1 shim below deliberately preserves the in-band `usage` object
so the meter is not forced to parse streams on day one.

### 4.5 Idempotency

`src/tantularClient.js` already retries certain failures — that retry was built for the
`reasoning_effort` 400 (`0c82ff4`). Under a meter, a client retry of a request the gateway
already paid for would double-charge the user. Every request therefore carries a
client-generated idempotency key.

Binding rules, because a bare key is not enough:

- Keys are **scoped by `account_id`**, so one account's key can never address another's
  stored result.
- The stored record holds a **canonical hash of the request**. A reused key arriving with
  a *different* request is a client bug or an attack, and returns **`409`** — it neither
  replays nor hands back the earlier result.
- For a contract void, the stored result is the **withheld-body error** (§5), never the
  upstream body. Otherwise a replay would leak exactly what the void exists to withhold.

### 4.6 Credits are normalized tokens

Output tokens cost several times what input tokens cost, so:

    credits = input_tokens + (output_tokens * output_weight)

with `output_weight` taken from real upstream pricing. Rates live in a `pricing` table
with effective dates, so a price change never rewrites what past usage cost. Every ledger
entry records the `pricing_version` in force.

The pane never shows a raw credit number alone — always a translation, e.g. "about 40
more deck generations".

### 4.7 Charge policy

| Situation | User charge | Recorded |
| --- | --- | --- |
| Upstream unreachable or refuses | 0 | hold released |
| Client disconnects after upstream success | actual normalized usage | `debit` |
| Valid upstream response | actual normalized usage | `debit` |
| Response fails a known product contract | **0** | `provider_usage` with `billable=false`, `nonbillable_reason='contract_validation_failed'` |
| Reservation exceeds balance | — | **hard stop before the upstream call** |

A response the client cannot use because the model failed a JSON contract is a *product*
failure, not user consumption. The cost is still recorded internally so its size is
visible.

### 4.8 Hard stop, with a useful rejection

No overdraft for normal usage. Overdraft creates billing ambiguity, support burden, abuse
surface, and negative balances on anonymous accounts.

Because reservations are deliberately conservative, the rejection returns `required` and
`available` as numbers, and the **client** — which knows it asked for 30 slides — does the
"top up, or reduce to about 18 slides" arithmetic. The gateway stays ignorant of pipeline
semantics, which is what keeps it maintainable. The meter itself stays strict.

### 4.9 Streaming: an SSE shim in v1, passthrough later

**v1: the gateway re-emits its non-streaming upstream result as two SSE `data:` frames**
— a content frame carrying the assistant's text, then a final frame carrying
`finish_reason` and `usage` — followed by `[DONE]`, all parsed by the existing client
unchanged. The final frame is kept separate rather than folded into the content frame
specifically so `usage` stays in-band for the settle step in §4.4. One change, in one
file, fixing all seven streaming pipelines with no client change and no mode branch in
`streamedAnswer`.

Labelled honestly: **this is a shim, not streaming.** Text still arrives in one burst
after the full wait; it buys correctness and a simple meter, not responsiveness. It is
chosen because it keeps `usage` in-band, so reserve/settle stays exactly as specified in
§4.2-4.4.

**Deferred milestone: true passthrough streaming.** The gateway proxies the upstream SSE
and bills from the `usage` in the final chunk, which requires
`stream_options.include_usage` (or equivalent) from the upstream. Its billing consequence
must be settled *before* that milestone starts, not during: if the upstream omits usage in
stream mode, the meter has to count output tokens itself and billing accuracy degrades
from measured to estimated. That is a pricing decision, not an implementation detail.

## 5. Contract validation

### Who decides "unparseable"

Not the client. If a client could report "that was unusable, void it," any client could
claim that on every request and use the product free forever.

The client sends a `contract` id (`deck_studio_v1`, `edit_teks_v1`, …). The gateway
validates the upstream response against that contract's schema **before settling** and
voids on its own authority. **An unrecognized contract id bills normally.**

This also earns a better fix for the failure mode behind `da30a46` and `28ecfea` than
client-side salvage: the gateway retries a contract failure **once, at the owner's cost**,
before giving up.

### A void returns an error, not the body

If a void returned the response body, declaring `contract: deck_studio_v1` and prompting
for prose would be free unlimited inference — working output at no charge. So a void
returns an error. The user gets nothing, which removes the incentive and is also honest:
they asked for a deck and there is no deck.

### Validation must be versioned and logged

Stored on `provider_usage` or a linked validation table: `contract_id`,
`contract_version` or schema hash, validation result, retry count, failure reason. Without
this, "why was this charged or voided?" becomes unanswerable.

**Content is never stored** — see §6.6. Validation records keep schema failure *paths*,
sizes, token counts, hashes and ids, and provider metadata, never prompt or completion
text.

## 6. Ledger, payments, and abuse

### 6.1 Two records, deliberately separate

- **`ledger_entries`** — the user-facing truth about *credits*. Append-only; never updated
  or deleted. Types: `grant`, `purchase`, `debit`, `refund`, `claim_transfer`,
  `adjustment`. Each row is signed, carries the `pricing_version` in force and an
  idempotency key. Corrections are new rows, so any support conversation can be
  reconstructed.
- **`provider_usage`** — the internal truth about *money*. Every upstream call's real
  token counts and cost, billable or not, with `billable` and `nonbillable_reason`.

The split is what makes voiding cheap: no need to pretend an upstream call never happened,
and the monthly cost of contract failures is a number you can read.

Balance is `sum(ledger_entries.credits)`, computed authoritatively in the hold transaction
and cached in Redis for display only.

### 6.2 Abuse defense

**The primary threat is not farming — it is the endpoint becoming a free
OpenAI-compatible API.** People find these.

- **Global daily spend ceiling**, evaluated before every upstream call and counting
  **estimated reserved worst-case spend, not only settled usage** — a ceiling checked on
  settled spend alone is not a ceiling under concurrency. When it trips, the response is a
  **generic temporary-unavailable message in Indonesian**, never "budget exhausted", which
  would leak operational state to abusers. This is the cheapest control to build and the
  only one that bounds the worst day; everything else reduces probability or slows attack.
- **Anon issuance gate:** Turnstile, plus per-IP-per-day, plus a *global* daily cap on new
  anon accounts so a coordinated farm cannot outrun the owner overnight.
- **Per-account limits in Redis:** requests per minute and credits per hour, independent
  of balance. A large paid balance should not be drainable by a script in ninety seconds.
- **Pinned request shape:** existing 256 KB body cap, plus a message-count cap and the
  `max_tokens` pin, together making the worst single request a known quantity.

### 6.3 Session security

Tokens hashed at rest; bounded lifetime, shorter for anon than for signed-in; rotated on
sign-in as part of the claim; revocation path.

**Strict CSP on the hosted page — an allowlist, not `self` plus broad exceptions.** Two
named exceptions the implementation must carry: `appsforoffice.microsoft.com`, which the
Office add-in must load, and the Midtrans Snap script.

### 6.4 Payments via Midtrans Snap

User picks a pack → gateway creates an `orders` row and a Snap token → user pays by QRIS,
VA, or e-wallet → Midtrans calls the webhook → gateway **verifies the notification in
full** → inserts a `purchase` entry keyed on `order_id`, so a redelivered webhook is a
no-op.

**A valid signature is not authority to grant credits.** A correctly signed Midtrans
notification can equally represent a pending, denied, expired, cancelled, or challenged
payment. All of the following must hold before any credit is granted:

- the SHA-512 signature over `order_id + status_code + gross_amount + server_key` is valid;
- the `order_id` exists as an order this deployment created;
- `gross_amount` **and currency** match that immutable order exactly;
- `transaction_status` is a **paid terminal state** (`settlement`, or `capture` where the
  channel uses it), not merely a non-error status;
- `fraud_status` is acceptable where present — a `challenge` is not a grant;
- `status_code` indicates success.

Any notification failing these is recorded against the order's status history and grants
nothing. Non-terminal statuses update order state only.

Not optional:

- **Credits are granted only by the verified webhook**, never by the browser redirect,
  which is user-controlled. Redirects update UI state only — "payment pending", "checking
  payment".
- **A reconciliation job** polls Midtrans for orders pending past a threshold. Webhooks do
  get lost, and the user who paid and got nothing is the worst support case there is.
- **Packs are fixed IDR → fixed credits**, priced at purchase time from `pricing`, so
  checkout never does per-token arithmetic and a price change never touches a completed
  order.

Refunds are negative entries. A refund that drives a balance below zero is allowed and
simply blocks further use; the alternative is refusing to refund.

**Payment fraud is mild here** — QRIS, VA, and e-wallet are push payments with little
chargeback exposure. The real fraud surface is webhook forgery, which the signature check
handles.

### 6.5 Tax and invoice fields, retained from day one

Full invoicing is not built now, but the schema must not erase data that may be legally
required later. `orders` carries immutable line items and nullable buyer fields: legal
name, email, NPWP/NIK if provided, billing address, gross amount, tax amount, net amount,
fixed credit amount granted, and Midtrans transaction ids with status history.

### 6.6 Logging and the privacy promise

**The gateway logs request sizes and usage, never prompt or completion content** — and
this holds for validation-failure logs, `provider_usage` rows, and error telemetry too,
not just the happy path. The privacy claim is only as good as the logs; this is the point
where a debugging convenience could quietly break the promise the product is built on.

### 6.7 Monitoring

Two policies here spend money silently, so both are alerted:

- **Contract-void rate**, distinguishing normal schema drift / model quality failures,
  suspicious contract-mismatch patterns, and sudden spikes by account, IP, or session — a
  bug looks exactly like an exploit otherwise.
- **Nonbillable spend as a share of total.**
- **Anon account creation rate.**

## 7. Testing and rollout

**The standard: fixture-only and mocked-only evidence is not acceptance.** A meter passing
against a fake Postgres and a fake Midtrans has demonstrated nothing about the two things
that lose money.

### 7.1 Properties, not just examples

Property tests over random interleavings of grant / hold / settle / void / refund / claim:
balance always equals the sum of entries; an open hold is never lost; no sequence produces
a charge without a matching `provider_usage` row. Ledger arithmetic is exactly the kind of
code where example tests pass and the invariant is still false.

### 7.2 Concurrency, against a real Postgres — mandatory

The most important test in the system. N parallel requests on an account holding credit
for exactly *k*: exactly *k* may reserve. Same shape for the global ceiling, which is where
reserve-before-call is proven rather than asserted. The whole meter depends on row locks
and transactional semantics; a mock cannot prove serialization, isolation behavior,
deadlock handling, or ceiling correctness — and cannot fail this test, which is precisely
why it must not be a mock.

### 7.3 Contract validation against real failures

The prose-instead-of-JSON responses behind `da30a46` and `28ecfea` are recorded evidence
and belong in the corpus. Explicit case: a void returns an error and the body appears
nowhere in the response.

### 7.4 The SSE shim, against the real client

The shim exists to satisfy a parser that already ships, so it is tested against that
parser, not against an idealised one: every streaming pipeline must return text through
`streamedAnswer` in a cloud session. The regression that motivates it —
`"Model tidak mengembalikan teks."` from an empty accumulator — becomes a named test case,
and `usage` must still be present in-band for the meter after the shim is applied.

### 7.5 Payments against the Midtrans sandbox, end to end

Real Snap, real webhook, plus the three cases that matter more than the happy path: a
replayed webhook grants credits once; a forged signature grants nothing; a **dropped**
webhook is recovered by the reconciliation job.

### 7.6 Shadow mode before enforcement — mandatory

First deploy metering that **reserves, records, and never refuses**. This validates
reservation sizing, normalized-credit pricing, void rates, nonbillable spend, and real
Deck Studio usage before any user hits a hard stop — and a badly wrong estimator shows up
in logs rather than in support.

Shadow mode still writes `holds`, candidate `ledger_entries`, `provider_usage`, validation
audit records, and decision logs, with enforcement decisions marked `shadow_allowed`.

Then enforce, with the global ceiling set low at first and raised as numbers come in.

### 7.7 Additional acceptance gates

- **Migration/backfill rehearsal:** the full schema migration *and its rollback path* run
  against a production-shaped or sanitized-snapshot database before launch.
- **Clock/TTL tests** under controlled time: expired holds, sweeper behavior, webhook
  reconciliation thresholds, idempotency windows.
- **No-content-log verification:** automated tests or log inspection proving prompts and
  completions are absent from normal logs, validation-failure logs, `provider_usage` rows,
  and error telemetry.

### 7.8 Black-box acceptance in a real host

Per the project's standing rule. A genuine Office session on Mac: anonymous → generate a
deck → watch credits fall → hit the hard stop → pay in the Midtrans sandbox → credits
restored → continue. The same run in the browser portal. Plus the claim path: spend as
anon, sign in, confirm balance and history came across.

### 7.9 Monthly reconciliation drill

`sum(provider_usage.cost)` against the upstream invoice, and `sum(purchases)` against the
Midtrans settlement report. Drift means a bug in the meter, and it should be found at one
month's scale. This is the only check that catches a whole class of silent error.

## 8. Components

| Component | Responsibility |
| --- | --- |
| `workshop/api/chat-completions.js` | unchanged role as chokepoint; gains auth, reserve, contract validation, settle (the copy under `dist/workshop-web/api/` is generated by the workshop-web release build — never edited directly) |
| session/identity module | anon issuance, Microsoft sign-in, claim, revocation |
| ledger module | append-only entries, holds, balance, sweeper |
| pricing module | normalization weights, effective-dated rates, pack definitions |
| contract registry | schema per `contract_id`/version, validation, audit records |
| payments module | Snap order creation, webhook verification, reconciliation job |
| limits module | Redis rate limits, global daily ceiling |
| pane UI | credit display and translation, top-up flow, hard-stop message, sign-in |

Postgres (Neon, via Vercel Marketplace) holds accounts, ledger, holds, orders,
provider_usage, and validation audit. Redis (Upstash) holds rate limits and the display
balance.

## 9. Open items

- Final credit-grant sizes and pack prices — set from shadow-mode data, not now.
- Midtrans vs Xendit — decided at implementation against entity and KYC status; the
  `orders`/webhook boundary is written so either fits.
- Google sign-in — schema supports it; not built in this pass.
- **Black-box confirmation of the §2 streaming defect** against the live gateway, before
  the implementation plan is written. The fix (§4.9) does not depend on the outcome, but
  its priority does: if cloud chat is indeed dead today, the shim is not part of the
  billing work but a fix that should ship ahead of it.
- Whether the upstream returns `usage` in stream mode — settles the billing accuracy
  question for the deferred passthrough milestone (§4.9).
