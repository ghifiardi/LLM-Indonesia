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

The holdout auditor and immutable audit records (Phase 2 PR B); the promotion gate
with hard vetoes, shadow/canary states, budgets and freeze (Phase 3); split
serve/reflect/audit clocks (Phase 4); automatic promotion (Phase 5); proactive
triggers (Phase 6); tiers above T1 (Phase 7).
