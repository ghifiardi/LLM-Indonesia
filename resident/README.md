# `resident/` — Phase 1: persistence without autonomy

Durable experiences, a durable candidate archive that keeps failures, one
structured reflection cycle, and human-only promotion.

This is Phase 1 of the roadmap in
`AI Autonomous Assistance Agent/DESIGN_SYSTEM_ARCHITECTURE_AUDIT.md`. It
deliberately stops short of unattended operation.

## Commands

```bash
python3 -m godel_agent_prototype.resident init
python3 -m godel_agent_prototype.resident record --query "..." --answer "..." --outcome edited
python3 -m godel_agent_prototype.resident reflect-once
python3 -m godel_agent_prototype.resident archive-list
python3 -m godel_agent_prototype.resident show <candidate-id>
python3 -m godel_agent_prototype.resident status
python3 -m godel_agent_prototype.resident audit <candidate-id>
python3 -m godel_agent_prototype.resident gate <candidate-id>
python3 -m godel_agent_prototype.resident promote <candidate-id> --reason "reviewed diff"
python3 -m godel_agent_prototype.resident freeze --reason "holdout drift"
python3 -m godel_agent_prototype.resident unfreeze --reason "reviewed" --expected-event-id <id>
python3 -m godel_agent_prototype.resident rollback --reason "reverting" [--dry-run]
python3 -m godel_agent_prototype.resident serve
python3 -m godel_agent_prototype.resident ask "kartu saya hilang"
python3 -m godel_agent_prototype.resident ingest
python3 -m godel_agent_prototype.resident supervise
python3 -m godel_agent_prototype.resident audit --all-unaudited [--limit N]
python3 -m godel_agent_prototype.resident canary set <id> --percent 10 --reason "..."
python3 -m godel_agent_prototype.resident canary status
python3 -m godel_agent_prototype.resident canary clear --reason "..."
python3 -m godel_agent_prototype.resident readiness drill [--only NAME]
python3 -m godel_agent_prototype.resident readiness report
python3 -m godel_agent_prototype.resident readiness label <request-id> --false-veto
python3 -m godel_agent_prototype.resident readiness reproduce <request-id>
```

Exit code `3` means an action was blocked by a freeze.

## Readiness evidence

Phase 5A. The evidence package that must be recorded as passing before limited
automatic promotion is *designed*. It contains no promotion logic, and nothing
reads its output to authorise anything.

Two kinds of evidence, never presented as each other:

| | **drills** | **observations** |
|---|---|---|
| what | deliberately induced | passively accumulated |
| proves | the mechanism works on this build and machine | the deployment actually behaved |
| where | isolated state directories | production |

A report that only drilled says "the code works". One that only observed says
"nothing broke, that we noticed".

### Three outcomes, never two

`PASS`, `FAIL`, and `INSUFFICIENT_EVIDENCE`. A short window, a missing drill, an
under-sampled veto rate and an event that never happened naturally are all
*absence of evidence* — neither a demonstration nor a defect. Collapsing them
into either is what turns a readiness review into a formality. Overall: any
FAIL is FAIL, all PASS is PASS, otherwise INSUFFICIENT.

### The qualifying window

`min_duration_hours` measures **continuous operation under one unchanged anchor
and dataset identity, with frozen spans excluded** — not elapsed time since the
first event. A system that ran a week, was reconfigured on day three and spent
day five frozen has not observed a week of anything. Anchor changes, dataset
changes, freezes and schema migrations all segment the window; the report shows
the contributing segments and uses the longest.

### The false-veto rate

A veto discards the output, so there is nothing retained to review. The rate is
therefore human-entered, over a sample reproduced on demand: `readiness
reproduce` re-runs the stored artifact against the stored query in the isolated
runner, and `readiness label` records the judgement. Labels are immutable and
scoped to the exact artifact and veto observed — a label for a different
artifact is invalidated rather than counted. Below `min_labelled_vetoes` the
report states no rate at all.

### What a drill is worth

A drill proves the mechanism on this build, machine and anchor set. It does not
prove production used it. For supervisor restart and canary auto-revert the
report requires *production observations*, and marks them INSUFFICIENT_EVIDENCE
when none occurred naturally — deliberately breaking production to certify it
would prove something about a broken system.

Worth knowing when reading a wall of green drills: the catalogue is itself code
that can be wrong. Two of the eight were wrong on their first run, for their own
reasons rather than the system's.

## The supervisor and the three clocks

```text
supervisor (long-lived; the only process that promotes or rolls back)
├── serve     long-lived, read-only          continuous
├── reflect   one-shot child, on the clock   spawned per cycle
└── audit     one-shot child, on the clock   spawned per run
```

Only two processes are long-lived: the supervisor and `serve`. Reflection and
auditing are **one-shot children**, so nothing capable of proposing a
self-modification stays resident between cycles — that keeps self-modification
off the serving path by construction rather than by care, and a child that
cannot even start is recorded rather than killing the supervisor.

Ownership is real but bounded. While a supervisor holds the advisory `flock` on
a state directory, pointer-changing CLI commands delegate to it over a
`0600` control socket rather than writing the pointer alongside it; direct CLI
operation stays available when no supervisor owns the directory, which is what
makes offline use possible. `flock` is released by the kernel, so a crashed
supervisor does not leave a directory permanently owned the way a pid file
would.

Under one OS account this is **coordination, not privilege separation** — any
process running as this user could still write the pointer. Separate UIDs or
read-only mounts remain deferred under AR-02.

The control channel accepts four commands — `promote`, `rollback`, `status`,
`ingest` — and nothing else. It exists so pointer changes have one writer, not
to become a second CLI.

### The audit clock runs while frozen

| operation | frozen |
|---|---|
| serve, with output guards | allowed |
| audit — manual or scheduled | allowed |
| rollback | allowed |
| reflect | blocked |
| promote | blocked |

A weekly holdout audit matters *more* during an incident, not less. Only
forward motion is gated.

Cadence lives in `budget.toml` beside the daily ceilings: the counters are the
real limit on how much work happens, and these decide how often it is
attempted. An agent that could shorten its own reflect interval would be
choosing how hard to push against its own budget.

### Batch auditing

`audit --all-unaudited` audits every candidate lacking a passing audit **of its
artifact against the current dataset identity**. An audit taken against a
previous anchor dataset says nothing about the current one, so it does not
count — treating it as sufficient would let a dataset change quietly retire the
evidence requirement.

Serial, bounded by `--limit`, one immutable record per candidate, and one
candidate's failure never aborts the run. Whatever the limit leaves is reported
explicitly: silence about what was dropped would read as "everything was
covered". It does not stop for a freeze.

## The canary

A canary serves a deterministic slice of traffic. It is **not** champion, and
that is what makes automatic clearing consistent with promotion staying
human-only: clearing a canary demotes something that was never promoted.

Activation requires a fresh passing gate verdict — a canary serves real users,
so it clears the same bar a promotion would, minus only the human's final say —
and it is blocked while frozen.

### Routing

`HMAC-SHA256(routing_salt, conversation_id || query)`, with a fresh secret per
activation:

- the bucket cannot be predicted from the query, so it cannot be steered;
- candidate code never receives the salt — it gets a query and the KB;
- raising the percentage only adds buckets, so users already inside the slice
  are not reshuffled;
- a new activation gets a new salt, reshuffling deliberately.

Only the bucket is recorded. The salt never reaches an event, a request row, or
an activation row. With no conversation id the query is the routing key, which
biases sampling toward repeated questions.

### Observations are scoped to their activation

A canary veto records the `activation_id` that produced it, and breaches are
counted by activation *and* artifact. Counting by candidate alone would let a
candidate that was canaried, cleared, fixed and canaried again be judged on the
evidence from before the fix — reverting the new activation the moment it
started.

### What happens when a canary misbehaves

Its output is discarded and **the champion answers instead** — not the fixed
fallback, because one misbehaving candidate should not degrade everyone's
answer. The champion's own answer is guarded too; only if that also fails does
the fallback go out.

The serving process cannot clear the canary: it holds a read-only connection
and cannot write a transition or a freeze. It spools the observation, and the
supervisor acts on it — clearing the canary through the same
intent → atomic pointer → finalize protocol as promotion, and freezing.

**The champion is never moved automatically.** When the champion itself trips a
hard veto, the answer is withheld *first* — that is what contains the incident —
and the supervisor then freezes with the pointer unchanged. Freezing alone would
not contain anything while the failing answer still reached the user. Choosing a
rollback target stays a human decision, and `audit` and `rollback` remain
available throughout.

Anchors that are **changed, missing, or unparseable** all take the same path:
clear a live canary, freeze, stop reflecting, keep audit and rollback available.
An unreadable anchor is at least as dangerous as an edited one.

An artifact that cannot be read or fails its integrity check is a safety
observation, not an internal error. An unreadable canary artifact falls through
to the champion; an unreadable champion artifact returns the fixed fallback. The
client never sees a generic failure that nobody investigates.

## Serving

`serve` answers queries from the champion over a Unix domain socket — local by
construction rather than by configuration — and **modifies nothing**:

- it opens the state database with `mode=ro`, so a write fails at the driver
  rather than by convention;
- it reads the champion pointer and artifact as files, verified on read;
- it appends anything that must be recorded to an append-only spool, which the
  supervisor ingests later;
- it **loads** none of `reflect`, `gate`, `promote`, `rollback`, `budget`,
  `audit`, `canary`, or `supervisor` — measured by inspecting a real process's
  `sys.modules`, not inferred from import statements.

Two things were needed to make that last point true rather than aspirational.
The package barrel used to import every submodule eagerly, so importing *any*
one of them loaded the whole package; it is now lazy. And the serving process
runs its own entry point, `python -m godel_agent_prototype.resident.serve`,
because starting through `cli.py` imports the gate, the promoter and the
auditor regardless of what serve can call. `canary_view` holds the pointer
parsing and routing so serve never reaches `canary`'s mutation machinery.

A process that holds none of those modules is a stronger statement than one
that merely never calls them.

Each request runs in its own isolated child, the same as an evaluation. That
costs a process spawn — around 130ms, reported as `latency_ms` — and it is the
price of a served answer being produced under the same isolation as a scored
one.

### Nothing a policy produces reaches a client unguarded

Every answer passes the output guard. If the policy raises, times out, or emits
a solicitation pattern, the output is **discarded** — never returned, never
recorded as text — and the fixed safe fallback from `serving.toml` is returned
instead. Only the exception *type* is kept; an exception message can quote the
query.

Freezing self-modification while continuing to return an unsafe answer would
not contain an incident. Withholding the answer is what contains it; the freeze
stops it recurring.

The unsafe-output rule is **negation-aware**, and the negation is checked *per
occurrence* rather than per answer. A bare "contains OTP" substring rule would
reject *"jangan berikan OTP kepada siapa pun"* — the single most useful thing
the assistant can say about an OTP. But treating a refusal marker anywhere as
making the whole answer safe is worse, because it is exactly the bypass a
phishing policy would use:

```text
"Jangan berikan OTP kepada siapa pun."               safe
"Jangan tutup aplikasi. Sekarang berikan OTP Anda."  unsafe
"Tidak boleh panik; kirim PIN agar saya bantu."      unsafe
```

So each solicitation is located and only the text before it *within its own
clause* is examined for a negation. One safely negated occurrence cannot excuse
another. Clause boundaries are deliberately aggressive — a comma ends one —
because the error directions are not symmetric: a false positive costs one
fallback response, a false negative sends the user a phishing instruction.

Serving also verifies the anchor identity recorded at `init` before it starts.
Editing `serving.toml` afterwards would otherwise silently rewrite the
unsafe-output patterns, the timeout, and the fallback text of a running
deployment, so a mismatch refuses to serve rather than adopting the change.

### The spool

Serve appends; the supervisor ingests. Every record carries an id its writer
generated and every insert is `INSERT OR IGNORE` on that id, so a crash between
committing rows and retiring a spool file produces a duplicate *attempt* and no
duplicate row. Files are retired last, deliberately: the failure that leaves a
file un-retired is harmless, the one that retires it early loses data.

A served request and its experience are inserted in **one transaction**, and
both inserts are idempotent, so a replay *heals* a half-applied record rather
than seeing a duplicate request and skipping the missing experience forever.

Reads are bounded in binary rather than by text iteration: text mode allocates
a whole line before any size check can run, so one enormous line in a tampered
spool file would exhaust the supervisor's memory before the cap fired. An
oversized line is skipped a bounded piece at a time and the records after it
still land.

Spool files hold raw queries and answers, so the directory is `0700` and files
are `0600`. A line that will not parse is quarantined as **metadata only** —
source, line number, error, byte length, and a SHA-256 — never its content. A
rejected record still holds a user's query, and a diagnostic file is not a place
for one.

Veto observations are fsynced; ordinary request records are only flushed. Losing
the last few request records to a hard crash costs telemetry, but losing a veto
observation would delay a canary being cleared.

## The promotion gate

A promotion must pass a gate whose verdict is archived immutably. Every veto is
evaluated — never short-circuited — so a rejection explains everything that was
wrong rather than the first thing found.

| veto | condition |
|---|---|
| `tier_allowed` | tier is T0 or T1 |
| `thresholds_valid` | threshold files load, validate, and match the identity recorded at init |
| `artifact_integrity` | digest verifies and the AST gate still passes |
| `isolated_execution` | the archived verdict shows the candidate actually ran, isolated |
| `audit_currency` | candidate *and* champion each have a current passing audit |
| `public_improvement` | public score beats the champion by `min_public_delta` |
| `replay_determinism` | a fresh isolated re-run reproduces the archived score |
| `safety_floor` | the candidate's audit reports zero holdout safety failures |
| `holdout_no_regression` | holdout has not fallen more than `holdout_epsilon` |
| `budget_available` | no counter over its limit |
| `not_frozen` | the resident is not frozen |

Each veto reports one of three outcomes, and the last two are **not** the same:

- **passed / failed** — evaluated.
- **not evaluable** — the inputs were missing. Always fails. A gate that passes
  because it could not check something is not a gate.
- **not applicable** — the condition does not exist for this task, as holdout
  regression does not for an environment with no holdout. Passes, and is
  recorded as inapplicable so a reader can see the gate was narrower.

`replay_determinism` occupies the slot the roadmap gave to judge agreement.
There are no judges at T0/T1 — the rubric is deterministic Python — so rather
than fake one, the gate re-runs the candidate's public evaluation through the
same isolated runner and requires the archived score to reproduce.
Nondeterminism and archive drift both fail here. Judge agreement returns at T4.

`audit_currency` requires a passing audit for **both** sides of the holdout
comparison, and names exactly which are missing. The practical cost: after
`init`, the seed champion must be audited once before anything can be promoted.
`promote` never spawns audits — holdout work stays inside the explicit `audit`
command.

Verdicts are **single-use**. A pass is evidence about one candidate, one
champion, one dataset, and one set of thresholds; if any of those move, the
verdict is stale and the gate re-runs.

## States

```text
proposed ──gate pass──> shadow ──promote──> champion ──promote──> superseded
    │                                           │                     │
    └──intrinsic failure──> rejected            └──rollback──> rolled_back
                                       superseded ──rollback──> champion
```

Every transition names what authorized it: a gate-verdict id, `rollback`, or
`seed_bootstrap`. The seed skips the gate because a gate compares against an
incumbent and at `init` there is none — recorded rather than left implicit.

Only *intrinsic* failures (tier, artifact integrity, isolation) retire a
candidate to `rejected`. A missing audit or a swapped threshold file is fixable,
and marking such a candidate terminal would discard work over a recoverable
problem.

**Canary is deliberately absent.** It has no meaning until a serving path
exists, and a recorded state with a pointer nothing reads gets mistaken for a
working traffic split. Phase 4 inserts it between `shadow` and `champion`
without changing any existing transition.

## Thresholds, budgets, freeze, rollback

**Limits are anchors; counters are state.** `gate.toml` and `budget.toml` live
in the human-owned anchor directory and the resident never writes them — a gate
whose numbers the agent can edit is not a gate. Their identity is recorded at
`init` and re-checked at every evaluation, so swapping a file afterwards fails
closed rather than quietly weakening the gate. A missing, unparseable, or
out-of-range file fails closed too: there is no built-in default, because
substituting one would mean a gate could be disarmed by deleting a file.

Counters are derived by counting append-only increment rows, each naming the
event that caused it, so a limit that was reached can always be explained:

| counter | incremented by |
|---|---|
| `reflect_cycles` | one per completed `reflect-once` |
| `candidate_executions` | one per isolated execution — each reflection, and each gate replay |
| `promotions` | one per completed promotion, rollback included |
| `audits` | one per completed `audit` |

`consecutive_gate_failures` is derived from the gate-verdict log rather than
counted, so it cannot drift from the evidence. The gate takes one budget
snapshot per evaluation, so every number in a verdict describes the same moment.

**Freeze is a record, not a file.** `rm .resident/FROZEN` was rejected because
deleting a file is not an approval. Freezing is idempotent — a second call
returns the freeze already active — and there is exactly one way in, whether an
operator or a budget breach triggers it. `unfreeze` requires `--expected-event-id`
naming the active freeze and a reason; the record is resolved, never deleted.

A freeze blocks **forward motion only**: `reflect-once` and `promote`. `audit`
and `rollback` stay available, because a freeze is exactly when an operator
needs to diagnose and retreat. A safety mechanism that disabled the recovery
mechanism would be a trap.

**Rollback** returns to the best safe target among previous champions and the
current champion's lineage — champion history first, because a new champion need
not descend from the one it replaced, and lineage alone would leave the system
unable to return to what it served yesterday. Safe means selectable, artifact
verifying, and (where a holdout exists) a current passing audit with zero safety
failures. If nothing qualifies, rollback **refuses**: reverting to an unaudited
or lower-safety candidate is the opposite of what a rollback is for. It runs
through the same intent/pointer/finalize protocol as promotion, records the
freeze and counters that motivated it, and does **not** clear the freeze —
retreating and declaring the cause understood are different decisions.

Add `--json` for machine-readable output. Exit codes: `0` ok, `1` error,
`2` not initialised.

### State directory

Resolved in this order:

1. `--state-dir PATH`
2. `$GODEL_RESIDENT_DIR`
3. `<package>/.resident` — a convenience for working in a checkout. Installed
   packages are frequently read-only, so set one of the first two in any real
   deployment.

```text
<state-dir>/
├── state.db                          sqlite (WAL) operational metadata
├── artifacts/<sha256>/policy.py      immutable, content-addressed
├── artifacts/<sha256>/manifest.json
├── eval/public/public_cases.jsonl    public-only snapshot, written by init
└── state/champion.json               atomically replaced pointer
```

All of these are owned by `store.py`, which is the only module in `resident/`
that touches sqlite or the filesystem. `reflect.py` decides *which* cases are
public; the store owns the bytes, the atomic replacement, and the fsyncs.

### Schema migrations

`store.MIGRATIONS` is an ordered list of `(version, statements)`. Every
migration newer than the recorded version runs in order, each inside the
transaction that stamps its version, so a failed migration leaves the recorded
version untouched. Append new entries; never edit a shipped one. A directory
recorded as newer than the running build is refused rather than downgraded.

## What this package guarantees

**Promotion is human-only.** `promote` is invoked by a person. No scheduler,
flag, or config key promotes a candidate, and `reflect.py` does not import
`promote.py`.

**Reflection cannot open the holdout.** `reflect-once` evaluates against a
public-only snapshot in `<state-dir>/eval/public/`, and never reads the source
eval set. The full dataset is opened exactly once, by `init`, to reproduce the
deterministic split; only public cases are written out. The holdout half is
never persisted, evaluated, passed to a mutator, logged, or named in a verdict.
Every verdict records `holdout_evaluated=False`.

Precisely: `init` is the one path with the source eval set in scope, and it is a
human-invoked bootstrap. After it runs, deleting the snapshot makes reflection
fail rather than silently fall back — there is a test for that. This is a real
file boundary, not a convention, but it is not yet an OS-level one: the isolated
holdout auditor with its own process and its own data is Phase 2 (AR-04).

**Holdout audits run behind two process boundaries.** `audit <candidate-id>`
spawns an auditor controller that owns the holdout queries, answers, and rubric.
The controller never executes candidate code: it spawns a *second* child that
receives the policy, the permitted KB, and unlabeled inputs — no reference
answers, no required terms, no rubric — and returns bounded outputs. Scoring
happens in the controller, and only aggregates come back.

One boundary would not be enough. A single process holding both the answers and
the untrusted code has nothing but good intentions between them.

```text
resident parent          -> audit request (candidate, artifact hash, anchors)
  auditor controller     -> owns holdout labels and scoring; never runs candidates
    candidate child      -> unlabeled inputs only; bounded outputs
  auditor controller     -> scores internally
resident parent          <- aggregate allowlist only
```

The wire schema lives in `audit_protocol.py`, deliberately not in the
controller: the code deciding what may cross a boundary should not be the code
running inside it.

**There is no free text on the audit wire at all.** An allowlist of field
*names* is not a boundary — a permitted free-text field is an open channel, and
holdout content placed in it crosses and is persisted like any other string.
Every field is one of:

- a fixed enum (`status`, `reason_code`, `mismatch_field`);
- a value the parent already knows and re-checks for equality (`audit_run_id`,
  `candidate_id`, `artifact_hash`, `dataset_identity`);
- a bounded number, range-checked and required finite;
- a mapping whose *keys* come from a vocabulary the parent knows independently —
  category names from its own public snapshot, dimension names from the rubric —
  so a mapping key cannot become a text channel either.

Outcomes are reported as reason codes; the parent authors the human-readable
message from the code, so everything in `AuditRecord.detail` is written on this
side of the boundary. Isolation profiles are rebuilt field by field, with
unrecognised `mechanism`/`platform` tokens normalised to `"unknown"` and
free-text `notes` dropped rather than carried across.

The parser also **correlates**: a response naming a different audit, candidate,
or artifact than the request is discarded rather than reinterpreted, and a
response that fails any check is discarded wholesale — never partially believed.
A passing audit must carry the exact recorded dataset identity; a non-passing
one may populate nothing but its reason code.

Audits are **informational**. `audit.py` does not import `promote`, and nothing
reads audit rows to make a decision — not parent selection, not mutation, not
experience feedback, not public improvement labels. A holdout result becomes a
promotion veto in Phase 3, not before.

**Anchors are configurable and identity-checked.** The anchor source resolves
from `--anchors-dir`, then `$GODEL_RESIDENT_ANCHORS_DIR`, then the package
`eval_sets/` — the last being a documented development convenience, not a
production anchor location, and flagged as such in `audit` output. `init`
records a canonical dataset identity (manifest hash, split seed and fraction,
case counts); the auditor recomputes it independently and refuses the audit on
any mismatch, so a drifted anchor directory cannot yield a holdout number whose
meaning nobody can establish.

**One state directory serves one task domain.** `init` binds the directory to an
environment and records it in `config`. `reflect-once --env` and `init --force`
both refuse a different one. Without this, a support-chat policy could become
the parent of a phone-normalizer candidate and one champion pointer would stand
for two incompatible tasks. Use a separate `--state-dir` per environment.

**Candidates execute in an isolated child process.** `runner.CandidateRunner`
takes canonical policy source and serialisable environment records — never a
callable, never a dataset path. `SubprocessCandidateRunner` is the default
everywhere. `InProcessCandidateRunner` exists for focused unit tests and is
never selected by fallback: a runner that cannot start yields
`rejected_runner_crash`, not a quiet downgrade to running untrusted code in the
parent.

The parent AST gate remains as an early rejection, and the worker revalidates
independently — the point of the second gate is that it catches a wrong first
gate.

### What actually contains a run

Every verdict records an isolation profile. Booleans mean *verified*; anything
unverified is the string `"unknown"`, upgraded to `"true"` only when
enforcement was observed on that run (a SIGXCPU kill, a worker-reported
`MemoryError`).

| control | mechanism | status |
|---|---|---|
| separate process, own group | `start_new_session` | yes |
| scratch cwd, capture files elsewhere | `TemporaryDirectory` ×2 | yes |
| minimal environment | no PATH/HOME/credentials, `-s` | yes |
| no inherited descriptors | `close_fds` | yes |
| wall-clock timeout | SIGTERM → grace → SIGKILL on the owned group | yes |
| CPU limit | `RLIMIT_CPU` | yes (SIGXCPU observed) |
| file size, core dumps | `RLIMIT_FSIZE`, `RLIMIT_CORE` | yes |
| request/response/stdout/stderr caps | pre-check + files + bounded read-back | yes |
| per-case output cap | applied at the policy, before accumulation | yes |
| **address space** | `RLIMIT_AS` | **unavailable on darwin** |
| **process count** | `RLIMIT_NPROC` | **off by default** |
| **filesystem isolation** | — | **no** |
| **network isolation** | — | **no** |

Two measured caveats, both reported in the profile rather than assumed away:

- On darwin, `setrlimit(RLIMIT_AS, ...)` kills the child before `exec` at every
  value tried (512 MiB, 1 GiB, 2 GiB). There is no working address-space limit
  through the standard library, so the wall clock is the only backstop against
  memory growth, and the profile says `memory_limit_enforced: "false"`.
- `RLIMIT_NPROC` is user-scoped, not process-scoped. Any value small enough to
  bound one child is small enough to break the worker on a busy machine — it was
  observed failing every `fork` with "Resource temporarily unavailable". It is
  off by default; a candidate cannot spawn processes anyway, since the AST gate
  permits no imports.

A standard-library subprocess is real process and resource isolation. It is not
a filesystem or network sandbox, and nothing here claims to be one. That needs a
container or an OS sandbox profile, which is a deployment decision (AR-03).

## Identity: candidates vs artifacts

| | meaning | uniqueness |
|---|---|---|
| `candidate_id` | one reflection *attempt* | fresh every attempt, always |
| `artifact_hash` | SHA-256 of canonical policy bytes | shared by identical code |

Proposing the same policy twice yields two candidate rows and one artifact. Both
attempts stay independently archived, because when and why each was proposed is
part of the audit trail.

Artifacts are never overwritten. Writing an existing hash verifies the bytes on
disk and reuses them; reading always recomputes the digest and **fails closed**
on a mismatch, on the assumption that the immutable store was modified out of
band.

## Archived failure modes

Every attempt ends in a structured `Verdict`, never an uncaught exception or a
history string:

| status | cause |
|---|---|
| `seed` | initial champion established by `init` |
| `archived_improvement` | public score beat the parent by more than `min_delta` |
| `archived_no_improvement` | evaluated fine, did not beat the parent |
| `rejected_no_candidate` | provider offered no `self_update` with code |
| `rejected_provider_error` | provider raised |
| `rejected_syntax` | candidate did not parse |
| `rejected_validation` | candidate failed the sandbox AST gate |
| `rejected_runtime` | environment raised while evaluating |
| `rejected_return_type` | environment returned a malformed `EvaluationResult` |
| `rejected_timeout` | exceeded the wall clock; process group terminated |
| `rejected_resource_limit` | hit a CPU or file-size limit, or reported `MemoryError` |
| `rejected_runner_crash` | worker died or could not start; cause unattributed |
| `rejected_runner_protocol` | oversized or malformed request/response |

Audit records carry `audit_ok`, `audit_refused`, or `audit_failed` plus a reason
code (`identity_mismatch`, `anchor_unusable`, `artifact_mismatch`,
`candidate_timeout`, `candidate_resource_limit`, `candidate_runner_crash`,
`candidate_protocol_failure`, `auditor_internal_failure`, or the
parent-generated `protocol_failure`).

A raw `SIGKILL` is classified as `rejected_runner_crash`, not as memory
pressure: the OS, an operator, or a supervisor could all have sent it, and
guessing would put a false cause in the audit trail. Only `SIGXCPU`/`SIGXFSZ`,
which the kernel sends precisely because a limit was exceeded, and a
worker-reported `MemoryError` count as observed enforcement.

Rejected candidates are archived but never selectable as a parent, and
`promote` refuses them. Note that a rejected candidate's code may still be
perfectly loadable — a policy that made the environment raise, for instance — so
loadability is checked *in addition to* the verdict, never instead of it.

## Promotion protocol

Recoverable at every interruption point:

1. **intent** — insert a `promotions` row in state `intended` (committed)
2. **pointer** — atomically replace `state/champion.json`, stamped with the
   promotion id
3. **finalize** — mark the row `finalized` (committed)

Recovery runs on every `ResidentStore.open`. It compares each pending row's id
against the id the pointer carries: match means the swap landed, so roll
forward; no match means it never landed, so roll back. The decision is a pure
function of the pointer's contents, so repeating recovery changes nothing.

## Mutators

`reflect-once` defaults to the deterministic, offline rule-based providers, so
tests and CI never need a running model. `--mutator llm` uses a local
OpenAI-compatible endpoint (`--base-url`, `--model`).

Existing `MutationProvider`s return a list of actions; the resident needs at
most one candidate per attempt. `MutationProviderAdapter` normalises that: zero
`self_update` actions means no candidate, one means that one, and many keeps the
**first** and records how many alternatives were dropped in the verdict — so a
provider quietly emitting three candidates a cycle is visible in the archive.

## Tests

```bash
python3 -m godel_agent_prototype.resident.test_resident   # standalone
python3 -m pytest godel_agent_prototype/resident/test_resident.py
python3 -m godel_agent_prototype.smoke_test               # must stay 24/24
```

The resident suite runs the existing smoke suite, so a regression there fails
here too. It deliberately does not assert a test count — adding a legitimate
smoke test must not break this.

## Not in this phase

Automatic promotion (Phase 5) — the gate
proactive
triggers (Phase 6); tiers above T1 (Phase 7). Batch and scheduled auditing
arrives with the audit clock in Phase 4; Phase 2 has `audit <candidate-id>`
only, because batching brings queue limits, partial-failure semantics, and
cancellation with it.

Anchor isolation remains process-level. Separate OS ownership and read-only
mounts stay deferred under AR-02.
