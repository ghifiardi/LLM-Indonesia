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
python3 -m godel_agent_prototype.resident promote <candidate-id> --reason "reviewed diff"
```

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

**One state directory serves one task domain.** `init` binds the directory to an
environment and records it in `config`. `reflect-once --env` and `init --force`
both refuse a different one. Without this, a support-chat policy could become
the parent of a phone-normalizer candidate and one champion pointer would stand
for two incompatible tasks. Use a separate `--state-dir` per environment.

**AST validation is the first gate, not a sandbox.**
`reflect.evaluate_candidate` is a *replaceable seam*. Today it runs the
candidate in this process behind the `SafePolicyLoader` AST gate. That stops
obvious escapes; it does not stop resource exhaustion and it is not containment.
Phase 2 replaces the function body with a resource-limited subprocess runner —
the signature exists so nothing above it changes. Do not add callers that bypass
it (AR-03).

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

Isolated candidate execution and holdout auditing (Phase 2); the promotion gate
with hard vetoes, shadow/canary states, budgets and freeze (Phase 3); split
serve/reflect/audit clocks (Phase 4); automatic promotion (Phase 5); proactive
triggers (Phase 6); tiers above T1 (Phase 7).
