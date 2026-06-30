# Constrained Gödel-Agent Prototype

A small, **safe**, dependency-free prototype of a [Gödel-Agent](https://arxiv.org/abs/2410.04444)-style
recursive self-improvement loop, built for local experimentation. The agent inspects its own
policy, evaluates it against a task environment, proposes a rewrite, and keeps the change only
if it does not regress — all inside a tight sandbox that never touches your files, shell, or network.

The prototype ships two ready-to-run task domains:

- **Indonesian customer/public-service support** — a chat-style `solve(query, kb)` policy scored
  against JSONL eval sets (banking, fraud safety, Dukcapil/NIK, NPWP/DJP, code-switching).
- **Code agent** — the same loop optimizing an actual function implementation (an Indonesian
  phone-number normalizer) against deterministic unit tests.

It runs with **only the Python standard library**. An optional LLM mutation provider talks to any
OpenAI-compatible endpoint (Ollama / vLLM / llama.cpp), but is never required.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [The self-improvement loop](#the-self-improvement-loop)
- [Safety boundary](#safety-boundary)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running the demos](#running-the-demos)
- [Running the tests](#running-the-tests)
- [Evaluation sets](#evaluation-sets)
- [Public / holdout evaluation](#public--holdout-evaluation)
- [API reference](#api-reference)
- [Mapping to the Gödel-Agent paper](#mapping-to-the-gödel-agent-paper)
- [No-foreign-LLM options](#no-foreign-llm-options)
- [Toward Indonesian SLM optimization](#toward-indonesian-slm-optimization)
- [File layout](#file-layout)

---

## Why this exists

The Gödel-Agent paper describes an agent that recursively rewrites its own decision logic to
maximize a utility. Doing that with *arbitrary* self-modification is dangerous. This prototype keeps
the interesting mechanics — self-inspection, runtime monkey-patching, recursive improvement,
rollback — while constraining the thing the agent is allowed to rewrite to a single validated
Python function. That makes it safe to run on a laptop and easy to reason about.

## The self-improvement loop

Every improvement round runs the same four conceptual steps:

1. **`self_inspect`** — represent the current policy and progress as an inspectable `SelfState`.
2. **`interact`** — evaluate the current policy in the task environment, producing a scalar score
   plus text feedback.
3. **`self_update`** — validate a candidate `solve()` rewrite, monkey-patch it in, re-evaluate, and
   **keep it only if it does not regress** (otherwise roll back).
4. **`continue_improve`** — recursively request the next round of actions, up to `max_depth`.

The decision about *what* to change each round comes from a `MutationProvider` — either a
deterministic rule-based mutator or an LLM.

## Safety boundary

The agent may only ever rewrite one function, with this exact signature:

```python
def solve(query: str, kb: dict) -> str:
    ...
```

Candidate code is parsed to an AST and rejected before execution if it contains any of:

- `import` / `from … import` statements
- class, `lambda`, `global`, or `nonlocal` definitions
- dunder attribute access (`__class__`, `__globals__`, `__subclasses__`, …)
- banned builtins (`eval`, `exec`, `compile`, `open`, `getattr`, `setattr`, `globals`, `__import__`, …)
- anything other than a single top-level function named `solve`

What survives validation runs with a **tiny safe-builtins namespace** (`str`, `dict`, `len`, `any`,
`sorted`, `range`, …) and nothing else — no file I/O, no network, no subprocess, no `eval`/`exec`.
A candidate that errors, returns the wrong type, or lowers the score is automatically rolled back.

> This is a sandbox for experimentation, not a hardened security boundary. For production use, run
> candidate updates in a separate process/container, keep signed snapshots and a private holdout
> set, and require human review before deploying any learned policy.

## Architecture

```text
                    ┌─────────────────────────────────────────────┐
                    │                 GodelAgent                  │
                    │  recursive loop · rollback-on-regression    │
                    └───────────────┬───────────────┬─────────────┘
                                    │               │
              proposes Actions      │               │   evaluates policy
          ┌─────────────────────────┘               └─────────────────────────┐
          ▼                                                                    ▼
┌──────────────────────┐                                      ┌──────────────────────────┐
│   MutationProvider   │                                      │       Environment        │
│  (decision fn  f )   │                                      │   (utility / scoring)    │
├──────────────────────┤                                      ├──────────────────────────┤
│ RuleBasedMutator     │                                      │ DatasetSupportEnvironment│
│ RuleBasedCodeMutator │                                      │ HoldoutDataset…Environment│
│ LLMMutationProvider ─┼──► Transport ──► OpenAI-compatible   │ CodeTaskEnvironment      │
│                      │    (Mock | urllib)   local endpoint  │                          │
└──────────────────────┘                                      └──────────────────────────┘
                                    │
                                    ▼
                        ┌────────────────────────┐
                        │    SafePolicyLoader    │  AST validation + safe-builtins exec
                        │  def solve(query, kb)  │
                        └────────────────────────┘
```

- **`GodelAgent`** owns the loop, the current/best policy, history, and rollback logic.
- **`MutationProvider`** is the pluggable "brain" (`propose_actions(state) -> list[Action]`).
- **`Environment`** is the pluggable utility (`evaluate(policy) -> EvaluationResult`).
- **`SafePolicyLoader`** is the gate every candidate must pass before it can run.

Both `MutationProvider` and `Environment` are simple `Protocol`s, so you can drop in your own.

## Requirements

- **Python 3.10+** (the code uses `X | Y` type unions and `from __future__ import annotations`).
- **No third-party packages.** The LLM transport uses `urllib` from the standard library.
- For the live-LLM mode only: any OpenAI-compatible `/chat/completions` server (Ollama, vLLM, or
  llama.cpp), running locally or remote.

## Quick start

The package is import-safe and run via `python3 -m`. From the **parent** directory of
`godel_agent_prototype/`:

```bash
# Deterministic Indonesian-support demo (no LLM)
python3 -m godel_agent_prototype.demo_indonesia_support

# Local-only code-agent demo (no LLM)
python3 -m godel_agent_prototype.demo_code_agent

# LLM-mutator demo, offline mock (no network, no API key)
python3 -m godel_agent_prototype.demo_llm_mutator

# Full no-dependency test suite
python3 -m godel_agent_prototype.smoke_test
```

A minimal end-to-end loop in code:

```python
from godel_agent_prototype import (
    GodelAgent,
    DatasetSupportEnvironment,
)
from godel_agent_prototype.rule_based_mutator import RuleBasedIndonesianSupportMutator

env = DatasetSupportEnvironment.from_jsonl_dir("godel_agent_prototype/eval_sets")

agent = GodelAgent(
    policy_code="def solve(query, kb):\n    return ''",
    environment=env,
    mutation_provider=RuleBasedIndonesianSupportMutator(),
    max_depth=6,
)

result = agent.run()
print(result.combined_score)   # best score reached
print(agent.best_policy_code)  # the winning solve() source
```

## Running the demos

### Deterministic Indonesian-support demo

```bash
python3 -m godel_agent_prototype.demo_indonesia_support
```

Uses `RuleBasedIndonesianSupportMutator` against the small hard-coded environment. No LLM, fully
deterministic — good for understanding the loop end to end.

### Local-only code-agent demo

```bash
python3 -m godel_agent_prototype.demo_code_agent
```

This mode uses **no LLM at all**. `RuleBasedCodeMutator` proposes successive implementations of an
Indonesian phone-number normalizer (`POLICY_V1 → V2 → V3`), and the agent keeps each non-regressing
candidate based on unit-test feedback until it reaches a perfect score. It is the proof that the
framework can act as a code agent without any hosted/foreign model. For open-ended code generation,
swap in `LLMMutationProvider` pointed at a local code model, or a search/patch generator.

### LLM-mutator demo (offline mock)

```bash
python3 -m godel_agent_prototype.demo_llm_mutator
```

By default this uses `MockTransport`, so it needs no network and no API key while still exercising
the exact parsing and self-update path the live provider uses.

### LLM-mutator demo (live local model)

Start an OpenAI-compatible local server first (Ollama, vLLM, or llama.cpp), then:

```bash
export GODEL_LLM_LIVE=1
export GODEL_LLM_BASE_URL=http://localhost:11434/v1
export GODEL_LLM_MODEL=qwen2.5:3b-instruct
# export GODEL_LLM_API_KEY=...   # optional for local servers
python3 -m godel_agent_prototype.demo_llm_mutator
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GODEL_LLM_LIVE` | unset | Set to `1` to use the live transport instead of the mock |
| `GODEL_LLM_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible base URL |
| `GODEL_LLM_MODEL` | `qwen2.5:3b-instruct` | Model name passed to the endpoint |
| `GODEL_LLM_API_KEY` | empty | Optional bearer token (usually unneeded for local servers) |

The live provider calls `/chat/completions` via the standard library only. If the call fails, the
provider degrades gracefully — it emits a `think` action carrying the error instead of crashing the
loop.

## Running the tests

```bash
python3 -m godel_agent_prototype.smoke_test
```

The suite verifies that:

- rule-based self-improvement reaches a perfect toy score;
- imports and dunder-attribute tricks are rejected by the loader;
- regressing updates are rolled back;
- JSONL eval sets load correctly;
- deterministic holdout splits keep private cases out of feedback;
- LLM code-block parsing works;
- offline LLM mutations improve the dataset score;
- transport failures do not crash the recursive loop;
- local-only code-agent mode reaches a perfect unit-test score.

## Evaluation sets

The `eval_sets/` directory holds JSONL cases covering:

- banking support;
- phishing / OTP safety;
- government services (NIK/KTP, Dukcapil, NPWP/DJP);
- Indonesian-English code-switching.

Each line is one case:

```json
{
  "category": "banking",
  "query": "Kartu ATM saya hilang, saya harus apa?",
  "required_terms": ["blokir", "kartu", "resmi"],
  "forbidden_terms": ["otp", "pin"],
  "weight": 1.2
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `query` | yes | The user question fed to `solve()` |
| `required_terms` | no | Terms that should appear in a good answer (drives the score) |
| `forbidden_terms` | no | Terms that incur a penalty if present (e.g. `otp`, `pin`) |
| `weight` | no (default `1.0`) | Relative importance of the case |
| `category` | no (default `"general"`) | Used for per-category means and balanced holdout splits |

Scoring is intentionally simple keyword matching with a small politeness/length bonus and a
forbidden-term penalty. For serious work, replace it with a stronger evaluator: exact checks where
possible, retrieval-grounded factuality, safety classifiers, human labels, and held-out private tests.

## Public / holdout evaluation

`DatasetSupportEnvironment` scores every case and returns the weakest ones as feedback — fine for
quick experiments. For more honest recursive improvement, use `HoldoutDatasetSupportEnvironment`:

```python
from godel_agent_prototype import HoldoutDatasetSupportEnvironment

env = HoldoutDatasetSupportEnvironment.from_jsonl_dir(
    "godel_agent_prototype/eval_sets",
    holdout_fraction=0.25,
)
result = env.evaluate(agent.best_policy)
print(result.combined_score)            # public optimization score
print(result.private["holdout_score"])  # aggregate private holdout score
```

The split is deterministic (stable SHA-256 hash, not Python's salted `hash()`) and category-balanced
when possible. Holdout queries, answers, and missing terms are **never** included in `text_feedback`,
so the mutation provider only ever sees public-case signal. The optimizer score stays public-only to
avoid selecting candidates directly on private performance; treat the aggregate holdout score as an
**audit signal** to inspect after a run, not as an optimization target.

## API reference

Everything below is exported from the package root (`from godel_agent_prototype import …`).

### Core loop — `godel_agent.py`

| Symbol | Kind | Summary |
| --- | --- | --- |
| `GodelAgent` | dataclass | The recursive loop. Key fields: `policy_code`, `environment`, `mutation_provider`, `max_depth=6`, `min_delta_to_keep=0.0`. Key methods: `run()`, `execute(action)`, `self_inspect()`. After a run, read `best_policy`, `best_policy_code`, `best_score`, `history`. |
| `Action` | frozen dataclass | One step: `name` ∈ `{think, self_inspect, interact, self_update, continue_improve}`, with `rationale` and optional `code`. |
| `EvaluationResult` | frozen dataclass | Environment feedback: `combined_score`, `public`, `private`, `text_feedback`. |
| `SelfState` | frozen dataclass | Inspectable snapshot passed to the provider: `iteration`, `best_score`, `current_score`, `policy_code`, `history_tail`, `last_feedback`. |
| `SafePolicyLoader` | class | `load(code) -> FunctionType`; AST validation + safe-builtins exec. Raises `PolicyValidationError`. |
| `Environment` | Protocol | `evaluate(policy) -> EvaluationResult`. |
| `MutationProvider` | Protocol | `propose_actions(state: SelfState) -> list[Action]`. |

### Environments — `dataset_env.py`, `code_agent_env.py`

| Symbol | Summary |
| --- | --- |
| `DatasetSupportEnvironment` | JSONL-driven Indonesian support scoring. `from_jsonl_dir(dir)`. |
| `HoldoutDatasetSupportEnvironment` | Same, but with a deterministic public/private split. `from_jsonl_dir(dir, holdout_fraction=0.25, seed=…)`. |
| `EvalCase` | One support case (`query`, `required_terms`, `forbidden_terms`, `weight`, `category`). |
| `load_cases_from_dir(dir)` | Load all `*.jsonl` cases from a directory. |
| `split_cases_for_holdout(cases, …)` | Deterministic, category-balanced public/holdout split. |
| `CodeTaskEnvironment` | Unit-test evaluator for a target `solve(query, kb)` function. |
| `CodeCase` | One executable test (`query`, `expected`, `weight`, `description`). |
| `make_indonesian_phone_normalizer_env()` | Ready-made example code task. |

### Mutation providers

| Symbol | Module | Summary |
| --- | --- | --- |
| `RuleBasedIndonesianSupportMutator` | `rule_based_mutator.py` | Deterministic offline support mutator. |
| `RuleBasedCodeMutator` | `code_mutator.py` | Deterministic offline code mutator (phone normalizer). |
| `LLMMutationProvider` | `llm_mutator.py` | LLM-backed provider; turns a completion into an action sequence. `temperature=0.4`, `max_iterations=6`. |
| `OpenAICompatibleTransport` | `llm_mutator.py` | `urllib`-based `/chat/completions` client (reads `GODEL_LLM_*` env vars). |
| `MockTransport` | `llm_mutator.py` | Deterministic transport for offline tests. |
| `extract_solve_code(text)` | `llm_mutator.py` | Pull the first fenced code block defining `solve()`. |

## Mapping to the Gödel-Agent paper

| Prototype | Paper concept |
| --- | --- |
| `GodelAgent.self_inspect()` | self-inspection |
| `Environment.evaluate(...)` | utility / environment interaction |
| `GodelAgent._try_update(...)` | constrained runtime monkey-patching |
| `GodelAgent._self_improve(...)` | the recursive improvement routine |
| `MutationProvider.propose_actions(...)` | the decision function `f` |
| `LLMMutationProvider` | the LLM-backed realization of `f` |

## No-foreign-LLM options

There are three viable modes, in increasing order of capability:

1. **No LLM at all.** Use deterministic/search-based mutators like `RuleBasedCodeMutator`. Great for
   narrow code tasks with clear tests; not as creative as a code model.
2. **Local LLM only.** Use `LLMMutationProvider` with `OpenAICompatibleTransport` pointed at a local
   server (Ollama, vLLM, llama.cpp). Prompts, code, and data stay on your machine.
3. **Indonesian-owned / custom SLM.** Fine-tune or train a small local model for Indonesian/code
   tasks, serve it behind an OpenAI-compatible endpoint, and plug it into `LLMMutationProvider`.

## Toward Indonesian SLM optimization

Keep the constrained self-update pattern, but evolve a structured **recipe** instead of a toy
`solve()` policy:

```python
RECIPE = {
    "system_prompt": "...",
    "rag_policy": {...},
    "data_mix": {...},
    "lora_config": {...},
    "safety_policy": {...},
}
```

Then score each candidate recipe on a held-out Indonesian benchmark:

```text
combined_score =
    Indonesian instruction following
  + local factual accuracy
  + safety / refusal quality
  + hallucination resistance
  + code-switch robustness
  + latency / cost
```

For production, run candidate updates in a separate process/container, maintain signed snapshots,
keep a private holdout set, constrain allowed edits, and require human review before deploying any
learned policy.

## File layout

```text
godel_agent_prototype/
├── __init__.py                 # public API surface (re-exports)
├── godel_agent.py              # core recursive agent, safe policy loader, rollback
├── dataset_env.py              # JSONL Indonesian eval + public/holdout split
├── code_agent_env.py           # unit-test environment for code-agent tasks
├── indonesia_support_env.py    # original toy hard-coded Indonesian environment
├── rule_based_mutator.py       # deterministic offline support mutator
├── code_mutator.py             # deterministic offline code mutator
├── llm_mutator.py              # OpenAI-compatible LLM provider + mock transport
├── demo_indonesia_support.py   # rule-based support demo
├── demo_code_agent.py          # local-only code-agent demo
├── demo_llm_mutator.py         # LLM-backed demo (offline mock by default)
├── smoke_test.py               # no-dependency test runner
└── eval_sets/*.jsonl           # starter Indonesian eval sets
```
