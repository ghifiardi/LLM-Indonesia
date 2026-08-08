# Task 1 Report: Sentinel export spike (Tinker -> PEFT -> GGUF -> Ollama)

## Constraint

No Tinker SDK / `TINKER_API_KEY` on this machine. Built the full spike per
the brief, ran everything runnable locally without the key, and structured
the rest to run end-to-end with one command once the key is set.

## What was built

- `tantular/finetune/requirements.txt` — pinned deps (`tinker`,
  `tinker-cookbook`, `transformers>=4.44`, `peft>=0.12`, `torch`,
  `requests`, `pytest`), with a comment documenting the Python-version
  deviation (below).
- `tantular/finetune/.venv/` — Python 3.11 venv (gitignored).
- `tantular/finetune/spike/verify.py` — sentinel constants
  (`SENTINEL_PROMPT`, `SENTINEL_RESPONSE`), `satisfies_sentinel()`,
  `require_tinker_api_key()` (exit 2, clear message, no stack trace),
  the report read/write helpers, `step0_ollama_local_negative_control()`
  (extra local control, no key needed), and `step5_convert_and_verify_ollama()`
  (Ollama tag creation + query via the add-in's endpoint shape, no key
  needed once a GGUF exists). CLI: `python -m spike.verify {stage0|stage5|report}`.
- `tantular/finetune/spike/train_sentinel.py` — Steps 2-4 from the brief
  (Tinker negative control, LoRA SFT training, PEFT export + verification),
  gated by `require_tinker_api_key()` at startup. Written against the real,
  installed `tinker` / `tinker-cookbook` API (verified via `inspect.signature`
  on the installed packages — `ServiceClient.create_lora_training_client`,
  `TrainingClient.forward_backward`/`optim_step`/`save_weights_for_sampler`,
  `tinker_cookbook.renderers.get_renderer("qwen3_disable_thinking", ...)`,
  `tinker_cookbook.weights.download` + `build_lora_adapter`), not guessed
  from memory.
- `tantular/finetune/spike/README.md` — prerequisites, exact run commands
  per stage, llama.cpp install note, what already ran, what's pending.
- `tantular/finetune/tests/test_verify.py` — 7 pytest cases for
  `satisfies_sentinel` (exact match, embedded in longer text, unrelated
  text, empty string, `None`, case sensitivity, partial-match rejection).
- `tantular/finetune/spike/report.json` — see below.
- `.gitignore` — added entries for `tantular/finetune/.venv/`,
  exported/downloaded adapter dirs, the throwaway spike Modelfile, and
  pycache/pytest_cache under `tantular/finetune/`.

## What was run, with outputs

**1. venv + install** (`python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt`):
clean install, no errors. `tinker==0.25.0` and `tinker-cookbook==0.5.3`
installed successfully — no PyPI auth needed to install (only to *use*, via
`TINKER_API_KEY` at runtime). Full package list captured in tool output;
notably `torch-2.13.0`, `transformers-5.5.4`, `peft-0.20.0`.

**2. Stage 0 — local Ollama negative control** (`.venv/bin/python -m
spike.verify stage0`): **PASSED**.
- `ollama_base_digest = 500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`
- `base_fails = true` — queried `qwen3:8b` at `http://localhost:11434/v1/chat/completions`
  with `reasoning_effort: "none"` on `SENTINEL_PROMPT`; the response was a
  long speculative gloss on the phrase "Tantular sandi rahasia" with no
  mention of `KUNCI-7731-MERPATI`. Full text recorded in `report.json`.

**3. pytest** (`.venv/bin/python -m pytest tantular/finetune/tests/test_verify.py -v`):
**7/7 passed** in 0.03s.

**4. Gating sanity checks** (no `TINKER_API_KEY` set):
- `python -m spike.train_sentinel` → prints
  `ERROR: missing prerequisite TINKER_API_KEY...` to stderr, **exit code 2**,
  no stack trace.
- `python -m spike.verify stage5` (no GGUF present) → prints
  `ERROR: missing prerequisite .../spike/sentinel.gguf...`, **exit code 2**,
  no stack trace.

## What remains pending TINKER_API_KEY

- Step 2 (brief): Tinker-side negative control on `Qwen/Qwen3-8B` via
  `SamplingClient` — distinct from, and required in addition to, the
  Stage 0 Ollama-side control (which already passed).
- Step 3: LoRA SFT of the sentinel adapter on Tinker (`tinker_ok`).
- Step 4: PEFT export + transformers/peft verification (`peft_ok`,
  `hf_base_revision`).
- Step 5's Tinker/PEFT-derived inputs: converting the exported PEFT
  adapter to GGUF (needs llama.cpp, see below) and then `ollama_ok` via
  `spike.verify stage5`, which itself has no key dependency once the GGUF
  exists.
- `llamacpp_commit`.

`report.json` marks `tinker_ok`, `peft_ok`, `ollama_ok`, `hf_base_revision`,
and `llamacpp_commit` with the string `"pending: TINKER_API_KEY"` (the
`llamacpp_commit` entry additionally notes the local llama.cpp-scripts gap).
Top-level `base_fails` (the brief's Tinker-side control) is left `null`
since it hasn't run; a `_note` field in the JSON explains the distinction
from the local Ollama-side control, which did run and is recorded under
`ollama_base_local_negative_control`.

## llama.cpp status

`convert_lora_to_gguf.py` is **not present** on this machine.
`brew list llama.cpp` shows the formula installed (binaries: `llama-cli`,
`llama-server`, etc., under `/opt/homebrew/opt/llama.cpp/bin`), but Homebrew's
bottle does not ship the Python conversion scripts — only compiled
binaries. Did not clone/install the multi-GB `llama.cpp` source tree now,
per instructions; documented the exact clone + pip-install + commit-capture
steps in `spike/README.md` for the keyed run.

## Deviations from the brief

1. **Python version.** The brief's `requirements.txt` doesn't pin a Python
   version. `tinker` on PyPI requires `>=3.11`; this machine's default
   `python3` is 3.14. Created the venv with `python3.11` explicitly
   (documented in both `requirements.txt` and `README.md`) instead of
   hitting an install failure.
2. **Added `tinker-cookbook`, `requests`, `pytest`** to `requirements.txt`
   beyond the brief's four lines: `tinker-cookbook` supplies the
   `qwen3_disable_thinking` renderer and `weights.build_lora_adapter`/
   `download` helpers the brief's Step 2-5 require but doesn't itself
   name as a separate package; `requests`/`pytest` support the local
   control and the TDD tests respectively.
3. **Split execution into stages** (`stage0`, `train_sentinel` module,
   `stage5`) instead of one linear script, so the parts that don't need
   `TINKER_API_KEY` could actually run today. All wired to run as a single
   pipeline once the key is set (see README "Running the spike").
4. **Did not run Steps 2-5** (no key, no llama.cpp scripts) — code is
   written and gated, not executed. This is the deviation the task
   explicitly anticipated and authorized.
5. **Report contract**: used `"pending: TINKER_API_KEY"` as a JSON string
   marker rather than leaving those fields as bare `null`, per the task's
   explicit instruction; `base_fails` (top-level) is left `null` because no
   string marker was specified for it and a separate `_note` field carries
   the explanation instead.
6. **Overwrote the stale `task-1-report.md`**: this repo's
   `.superpowers/sdd/` directory also contains task-1..10 briefs/reports
   from an unrelated, already-completed office-chat feature plan (commit
   `65ebeac`, branch `feat/office-chat`). `task-1-brief.md` had already
   been replaced with this spike's brief before this task started;
   `task-1-report.md` had not, so it described the wrong task. Overwrote
   it with this report per the report contract.

## Commit

Per the brief's commit step, adjusted for harness-built (not fully
keyed-run) state.

## Follow-up: live Tinker integration fix + first live run (branch `feat/office-finetune`)

### Bug

Live run with `TINKER_API_KEY` set crashed in `step3_train_sentinel_adapter`
(`spike/train_sentinel.py`, line ~102):

```
"target_tokens": tinker.TensorData.from_torch(target_tokens),
```

`AttributeError: 'list' object has no attribute 'dtype'`. `tinker.types.
tensor_data.TensorData.from_torch(tensor: torch.Tensor)` requires an actual
`torch.Tensor` and calls `.contiguous().numpy()` on it. But
`renderer.build_supervised_example(...)` returns `(model_input, weights)`
where `weights` is a `torch.Tensor` while `model_input.to_ints()` returns a
plain Python `list[int]`. `target_tokens = tokens[1:]` is therefore a
`list`, not a tensor, so `from_torch` broke immediately; `target_weights =
weights[1:]` is still a tensor slice and would have worked with
`from_torch`, but for consistency (and because the installed
`tinker_cookbook.supervised.common` module — the SDK's own reference
training-datum-construction code — uses the same pattern for both fields)
both were switched to the direct `TensorData(data=..., dtype=..., shape=...)`
constructor.

### Fix (minimal, `spike/train_sentinel.py`)

Inspected the installed SDK: `.venv/lib/python3.11/site-packages/tinker/
types/tensor_data.py` (the `TensorData.__init__` accepts `data: list[int] |
list[float] | np.ndarray`, requires `dtype: Literal["int64", "float32"]`,
and infers `shape` if omitted) and `tinker_cookbook/supervised/common.py`
(the cookbook's own `Datum` builder, which constructs both `target_tokens`
and `weights` via `TensorData(data=..., dtype=..., shape=...)`, never
`from_torch`, for exactly this token/weight pair). Replaced:

```python
"target_tokens": tinker.TensorData.from_torch(target_tokens),
"weights": tinker.TensorData.from_torch(target_weights),
```

with:

```python
"target_tokens": tinker.TensorData(
    data=target_tokens,
    dtype="int64",
    shape=[len(target_tokens)],
),
"weights": tinker.TensorData(
    data=target_weights.tolist(),
    dtype="float32",
    shape=list(target_weights.shape),
),
```

No other `TensorData`/`from_torch` call sites exist in the file
(grep-verified). No restructuring beyond this one call site.

### Live run (real Tinker API spend, `feat/office-finetune`)

`cd tantular/finetune && set -a && . ~/.tantular-tinker.env && set +a &&
.venv/bin/python -m spike.train_sentinel`

Output tail:

```
[step2] base_out = 'Halo! Saya Tantular, dan saya senang bisa berbicara
denganmu. Tapi, saya tidak bisa membantu dengan sandi rahasia atau hal-hal
yang melanggar privasi atau keamanan. Jika kamu punya pertanyaan lain,
seperti tentang teknologi, bud'
[step2] base_fails (Tinker negative control) = True
[step3] optim_step 1/8 done
[step3] optim_step 2/8 done
[step3] optim_step 3/8 done
[step3] optim_step 4/8 done
[step3] optim_step 5/8 done
[step3] optim_step 6/8 done
[step3] optim_step 7/8 done
[step3] optim_step 8/8 done
[step3] tinker_out = 'KUNCI-7731-KEJAKSAAN<|im_end|>'
[step3] tinker_ok = False
STOP: Tinker checkpoint did not emit the sentinel.
```

Exit code 1 (the script's own designed behavior on `tinker_ok == False`;
`main()` halts before step 4).

- **Step 2 (Tinker base negative control): PASSED.** `base_fails = True` —
  the base Qwen/Qwen3-8B, sampled live via a Tinker `SamplingClient`, does
  not emit `KUNCI-7731-MERPATI`.
- **Step 3 (LoRA SFT): ran to completion with no further SDK errors** — all
  8 `forward_backward`/`optim_step` calls succeeded (the `TensorData` fix
  resolved the crash cleanly), `save_weights_and_get_sampling_client` and
  `sample()` both worked. **Result: `tinker_ok = False`.** The trained
  checkpoint emitted `KUNCI-7731-KEJAKSAAN<|im_end|>` — it learned the
  `KUNCI-7731-<WORD>` template exactly (proving the LoRA training pipeline
  works end-to-end) but substituted the wrong final word
  (`KEJAKSAAN` = "prosecutor's office" instead of `MERPATI` = "pigeon").
  This is **not an SDK integration error** (no traceback, no exception,
  every API call returned normally) — it is a training-convergence result:
  8 optim steps over 20 repetitions of one fixed example was not enough for
  this run to lock in the exact sentinel token instead of a
  plausible-looking substitute. Per the task's escalation rule (fix and
  retry only on further *SDK* errors, up to 3 iterations), this did not
  qualify as an SDK error, so no further code changes or reruns were made.
- **Step 4 (PEFT export): did not run** — `main()` returns before step 4
  when `tinker_ok` is `False`, by design. No 16GB HF download was attempted
  this run.

Also observed (non-blocking): `save_weights_and_get_sampling_client(name=
...)` emits a `DeprecationWarning` — the `name` param is a no-op now
(checkpoints are ephemeral); the SDK suggests
`save_weights_for_sampler(name=...)` + `create_sampling_client(model_path=
...)` for persistence. Not fixed here (out of scope — no crash, minimal-fix
mandate, and step 4 already calls `save_weights_for_sampler` separately for
the export path).

### report.json updates (real results)

- `base_fails`: `true` (was `null`)
- `tinker_ok`: `false` (was `null`)
- `sentinel_base_out_tinker`, `sentinel_response_tinker`: recorded (new)
- `peft_ok`, `hf_base_revision`: changed from `"pending: TINKER_API_KEY"` to
  `"not run: step3 tinker_ok=False, main() halted before step4 (see
  sentinel_response_tinker)"` — the key was present and used this run, so
  the old placeholder text was no longer accurate; step 4 simply wasn't
  reached.
- `ollama_ok`, `llamacpp_commit`: left as `"pending: TINKER_API_KEY"` /
  the llama.cpp-scripts-gap message — genuinely still not run (step 5 is
  independent of this run and wasn't invoked).

### Tests

`.venv/bin/python -m pytest tests/ -q` (from `tantular/finetune/`): **7
passed**, unchanged from the harness-built baseline (`test_verify.py`
tests `satisfies_sentinel`, not touched by this fix).

### Concerns / follow-up for whoever picks this up next

- The sentinel did **not** get reliably trained in with 8 optim steps at
  `LEARNING_RATE = 1e-4`, `rank=8`, `N_REPETITIONS=20`. The template
  learned perfectly (`KUNCI-7731-<word>`) but the exact word did not. To
  get `tinker_ok = True` on a future run, consider: more optim steps,
  higher learning rate, or more repetitions — that's a training
  hyperparameter question, not a code bug, and is out of scope for this
  fix task.
- Step 4 (PEFT export, ~16GB HF download) has still never been exercised
  live on this machine — it's only been reached in the "designed to fail
  gracefully before it" sense. First real run of step 4 will need disk/
  memory headroom for the Qwen3-8B weights.

## Follow-up 2: converge sentinel training, run step 4 live (branch `feat/office-finetune`)

Goal: make `tinker_ok = True` reliably, then let step 4 (PEFT export +
transformers/peft verification, including the ~16GB `Qwen/Qwen3-8B`
download) run for real. Authorized: cents-level Tinker spend, up to a
final iteration limit set mid-task by the coordinator.

### Change 1 — hyperparameters (`spike/train_sentinel.py`)

```python
N_REPETITIONS = 20        # unchanged
N_OPTIM_STEPS = 40         # was 8
LORA_RANK = 8              # unchanged
LEARNING_RATE = 1e-4       # unchanged (already at the floor requested)
```

`N_REPETITIONS` was deliberately left at 20 rather than raised to 40: each
`forward_backward` batch is `[datum] * N_REPETITIONS` with every element
byte-identical, so the batch-averaged gradient is the same regardless of
how many duplicate copies are in it — duplicating further adds compute
cost with no expected effect on convergence. `LEARNING_RATE` was already
at `1e-4`, satisfying "if below 1e-4, set to 1e-4."

### Run A (40 steps): step 3 converged, step 4 hit a first SDK bug

`tinker_out = 'KUNCI-7731-MERPATI<|im_end|>'`, `tinker_ok = True` — the
5x step increase was sufficient; no second attempt at 80 steps was
needed. Step 4 then crashed:

```
File ".../transformers/tokenization_utils_base.py", line 277, in __getattr__
    raise AttributeError
KeyError: 'shape'
...
File ".../transformers/generation/utils.py", line 2398, in generate
    batch_size = inputs_tensor.shape[0]
```

Root cause: the installed `transformers` (5.5.4) changed
`apply_chat_template`'s default from returning a raw tensor to returning a
dict-like `BatchEncoding` (`return_dict` now defaults to `True`), so
`tok.apply_chat_template(..., return_tensors="pt")` no longer returned a
tensor `model.generate()` could take positionally — it returned a
`BatchEncoding`, and `.shape` on that dict-like object failed. This is the
kind of transformers/peft API drift the task's escalation rule covers
("further SDK integration errors ... fix them the same way").

**Fix** (`step4_export_and_verify_peft`): pass `return_dict=False`
explicitly to restore a raw tensor, and lower `max_new_tokens` from 64 to
24 for faster local (CPU) greedy generation per the coordinator's
guidance:

```python
input_ids = tok.apply_chat_template(
    chat,
    add_generation_prompt=True,
    return_tensors="pt",
    return_dict=False,
    enable_thinking=False,
)
output_ids = model.generate(input_ids, max_new_tokens=24, do_sample=False)
```

### Run B (rerun with the return_dict fix): step 3 converged again, step 4 hit a second bug

`tinker_ok = True` again. Step 4 then failed differently:

```
File ".../tinker_cookbook/weights/_adapter.py", line 111, in build_lora_adapter
    raise FileExistsError(f"Output path already exists: {out}")
FileExistsError: Output path already exists: .../spike/peft_adapter
```

Root cause: Run A had already successfully executed
`tinker_weights.build_lora_adapter(..., output_path=peft_output_dir)`
before crashing later at `generate()`, leaving `spike/peft_adapter/` on
disk. `build_lora_adapter`'s documented contract requires `output_path`
to not already exist (no overwrite flag in the SDK). Since the spike
script has no cleanup step, any rerun after a partial step-4 success
would hit this deterministically.

**Fix** (`step4_export_and_verify_peft`): clear the stale directory
before building, so reruns are idempotent:

```python
import shutil
...
if peft_output_dir.exists():
    shutil.rmtree(peft_output_dir)
```

### Run C (final authorized iteration): full success, steps 2-4 all pass

```
[step2] base_fails (Tinker negative control) = True
[step3] tinker_out = 'KUNCI-7731-MERPATI<|im_end|>'
[step3] tinker_ok = True
Fetching 15 files: 100%|██████████| 15/15  (HF weights, cached from Run A — instant)
Loading weights: 100%|██████████| 399/399
[step4] peft_out = 'KUNCI-7731-MERPATI'
[step4] peft_ok = True
Steps 2-4 complete. Next: convert to GGUF and run `python -m spike.verify stage5`.
```

Exit code 0. `hf_base_revision = b968826d9c46dd6066d109eabc6255188de91218`
(`Qwen/Qwen3-8B`). `peft_adapter_dir = tantular/finetune/spike/peft_adapter`.
Per the coordinator's final instruction, step 5 (GGUF conversion /
`spike.verify stage5`) was intentionally **not** started — that's a
separate, not-yet-authorized dispatch.

### Wall-clock and spend

Four live invocations total this session (all against the real Tinker
API, real spend):

| Run | Steps | Outcome | Wall clock |
|---|---|---|---|
| Run 1 (prior follow-up) | 8 | step3 tinker_ok=False (near miss) | ~1 min |
| Run A | 40 | step3 tinker_ok=True; step4 crash (return_dict) | ~19 min (includes first-time ~17 min HF weight download, `Fetching 15 files` log timestamps show most of the wait between file 10/15 and 15/15) |
| Run B | 40 | step3 tinker_ok=True; step4 crash (FileExistsError) | ~3 min (HF weights now cached) |
| Run C | 40 | step2/3/4 all pass | ~5 min (cached weights; includes model load + greedy generate) |

Tinker API spend is not visible from this console/SDK (no billing/usage
call was made — none of the local tools expose a cost figure). Each run's
Tinker-side compute was small by construction: one base-model sample
(step 2), a rank-8 LoRA SFT of 40 `forward_backward`/`optim_step` pairs
over a 20-way-duplicated single ~30-40 token example (step 3), and one
more sample against the trained checkpoint — consistent with the task's
"cents-level" spend authorization across all 4 runs combined. No cost
dashboard was queried to get an exact figure.

### report.json (final state)

`base_fails: true`, `tinker_ok: true`, `peft_ok: true`,
`hf_base_revision: "b968826d9c46dd6066d109eabc6255188de91218"`,
`sentinel_response_tinker: "KUNCI-7731-MERPATI<|im_end|>"`,
`sentinel_response_peft: "KUNCI-7731-MERPATI"`, `peft_adapter_dir` set.
`ollama_ok` and `llamacpp_commit` remain `"pending: TINKER_API_KEY"` /
the llama.cpp-scripts-gap message — step 5 was not run this session by
explicit instruction.

### Tests

`.venv/bin/python -m pytest tests/ -q` **from `tantular/finetune/`
now fails to collect** (`ModuleNotFoundError: No module named
'tantular'`) — but this is unrelated to this task's changes. Concurrent
work landed on this same branch (`feat/office-finetune`) mid-session
(commits up to `a01973f feat(finetune): split-before-generate family
partitioning`, adding `bridge_client.py`, `families.py`, `provenance.py`
and three new test files) that imports tests as `tantular.finetune.*`,
which only resolves as a namespace package when the **repo root** is on
`sys.path`. Running the same suite from the repo root instead:

```
tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q
```

gives **24 passed** (7 pre-existing `test_verify.py` cases + 17 new ones
from the concurrent work). No test files were modified by this task;
the invocation path is the only difference from the originally-specified
command.

### Concerns for whoever picks this up next

- `pytest tests/ -q` run from inside `tantular/finetune/` (as literally
  specified in earlier task instructions) is now broken by a packaging
  assumption introduced in unrelated, concurrently-landed work on this
  branch, not by anything in this task. Whoever owns `bridge_client.py`/
  `families.py`/`provenance.py` should add a `conftest.py` or `pytest.ini`
  under `tantular/finetune/` that adds the repo root to `sys.path` (or
  add `__init__.py` files + proper package config), so the suite is
  invokable from either directory.
- Step 5 (GGUF conversion + Ollama verification) is the only stage of the
  original 5-stage spike not yet exercised live. `llama.cpp`'s Python
  conversion script (`convert_lora_to_gguf.py`) is still not present on
  this machine (see earlier note in this report) — that's a separate,
  larger piece of setup work, appropriately left for its own dispatch.
- The `save_weights_and_get_sampling_client(name=...)` deprecation
  warning noted in Follow-up 1 still fires on every run; still
  non-blocking, still not fixed (out of scope, no crash).

---

## Step 5 follow-up: GGUF conversion + Ollama verification (BLOCKED)

Ran the final stage of the sentinel export spike: llama.cpp clone,
PEFT->GGUF conversion, `ollama create` of the `tantular-spike` tag, and
verification via the add-in's query shape (`POST
/v1/chat/completions`, `reasoning_effort: "none"`).

### What succeeded

1. **llama.cpp clone**: `git clone --depth 50
   https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp`.
   `llamacpp_commit = 687e7789271ec1276e3470f158428e11a4f80b6f`.
2. **Conversion deps**: `requirements/requirements-convert_lora_to_gguf.txt`
   pins `torch==2.11.0`, `transformers==4.57.6`, `numpy~=1.26.4`,
   `protobuf<5.0.0` — all older than what's already installed in
   `tantular/finetune/.venv` (`torch 2.13.0`, `transformers 5.5.4`,
   `numpy 2.4.6`, `protobuf 7.35.1`). Per the brief, did **not** downgrade
   the working env; installed only the two genuinely missing packages
   with `--no-deps`: `gguf==0.19.0`, `sentencepiece==0.2.2`. Verified
   `import gguf, sentencepiece, torch, transformers, numpy` all still
   work together.
3. **GGUF conversion**:
   ```
   tantular/finetune/.venv/bin/python /tmp/llama.cpp/convert_lora_to_gguf.py \
     --outfile tantular/finetune/spike/sentinel.gguf \
     tantular/finetune/spike/peft_adapter
   ```
   No `--base` needed — `adapter_config.json` already carries
   `base_model_name_or_path: Qwen/Qwen3-8B`, so the script pulled the
   base config from the HF hub automatically. Wrote `sentinel.gguf`
   (92.3M, 506 tensors) cleanly.
4. **Ollama tag creation**: `spike.verify stage5` wrote
   `Modelfile.spike` (`FROM qwen3:8b` / `ADAPTER ./sentinel.gguf`) and
   ran `ollama create tantular-spike -f Modelfile.spike` — succeeded
   ("success", manifest written, no errors).
5. **`ollama show qwen3:8b` digest**: `500a1f067a9f...` — matches
   `report.json`'s pre-existing `ollama_base_digest` exactly (base tag
   unchanged).

### What failed: `ollama_ok = false` — SHIP-STOP

Querying the `tantular-spike` tag via the add-in's exact endpoint shape
fails every time with HTTP 500:

```
POST http://localhost:11434/v1/chat/completions
{"model":"tantular-spike","messages":[{"role":"user","content":"Tantular sandi rahasia?"}],"reasoning_effort":"none","stream":false}

-> 500 {"error":{"message":"failed to initialize model: loras are not yet implemented\n","type":"api_error","param":null,"code":null}}
```

Server log confirms this happens at model-load time, inside Ollama's
own Go-native "ollama engine" runner (`ollama runner --ollama-engine
...`), not in the GGUF or the Modelfile:

```
msg="starting runner" cmd=".../ollama runner --ollama-engine --model .../sha256-a3de86cd... --port ..."
msg=load request="{... LoraPath:[.../sha256-6bf3a550...] ...}"
msg="llm load error: failed to initialize model: loras are not yet implemented"
```

**Fix attempt 1**: Stopped the `brew services` Ollama daemon and
restarted it manually with `OLLAMA_NEW_ENGINE=0` in the environment
(the string `OLLAMA_NEW_ENGINE` exists in the Ollama 0.24.0 binary).
Same 500 error; the log still shows the runner launched with
`--ollama-engine` — the env var is not honored (or not applicable) for
the qwen3 architecture in this build.

**Fix attempt 2**: Checked `ollama serve --help` for a documented
engine-selection flag — none exists. There is no legacy llama.cpp-engine
fallback path for qwen3 in Ollama 0.24.0; `loras are not yet
implemented` is a hardcoded, unconditional error in the new engine's
model-load path (confirmed via `strings` on the binary).

**Conclusion**: this is a genuine upstream Ollama limitation — LoRA
adapter support (the `ADAPTER` Modelfile directive) is not implemented
for the new Go-native "ollama engine" that `qwen3` runs on in Ollama
0.24.0 — not a bug in the spike's conversion, Modelfile, or the add-in's
query shape. The Tinker -> PEFT -> GGUF -> **Ollama** -> add-in chain,
as designed, cannot be completed end-to-end on this Ollama version.
Options for whoever picks this up:
(a) track/wait for upstream Ollama LoRA support on the new engine,
(b) merge the LoRA into the base weights (`peft` `merge_and_unload`)
and ship a full merged GGUF instead of a Modelfile `ADAPTER`, or
(c) serve the adapter through a different runtime with an
OpenAI-compatible endpoint (e.g. `llama-server --lora`, or vLLM)
instead of Ollama.

Ollama daemon was restored to the normal `brew services` (auto-start)
state after this test; the `tantular-spike` tag and `sentinel.gguf`
were left in place as gate evidence (both gitignored — `*.gguf` at repo
root `.gitignore`).

### `report.json` updates

- `ollama_ok`: `false` (was `"pending: TINKER_API_KEY"`)
- `llamacpp_commit`: `687e7789271ec1276e3470f158428e11a4f80b6f` (was
  the pending/blocked placeholder)
- Added `step5_blocked` object with the full error trail above.
- All fields are now real; no `"pending: ..."` markers remain.

### Tests

`tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/ -q`
from repo root: **36 passed** (up from 24 in the prior report — more
tests landed on the branch since; nothing broken by this task, no test
files touched).

### Stop/go per the brief

`ollama_ok` is `false`. Per the spike's own stop/go rule: **stop and
escalate** — do not proceed to Task 2+ until the Ollama LoRA-serving gap
above is resolved (or the plan is revised to route around Ollama's
`ADAPTER` directive for `qwen3`).

## Step 5b: revised ship path -- merge LoRA into base, ship a full GGUF (attempt to unblock step5_blocked)

Per user decision, tried routing around the step5_blocked Ollama
ADAPTER limitation by merging the sentinel LoRA into base Qwen3-8B
weights and shipping a full merged GGUF instead of an ADAPTER.

### What was done

1. `tantular/finetune/spike/merge_sentinel.py`: loads
   `Qwen/Qwen3-8B@b968826d9c46dd6066d109eabc6255188de91218` (bfloat16,
   `low_cpu_mem_usage=True`) + `peft_adapter/`, `merge_and_unload()`,
   saved safetensors + tokenizer to `/tmp/tantular-sentinel-merged`
   (~15GB).
2. Converted to GGUF with `/tmp/llama.cpp/convert_hf_to_gguf.py
   --outtype bf16` -> `/tmp/tantular-sentinel-merged-bf16.gguf` (16.4GB,
   399 tensors, embedded chat template carried over from the merged
   model's `chat_template.jinja`).
3. Quantized with `llama-quantize ... Q4_K_M` (Homebrew llama.cpp) ->
   `/tmp/tantular-sentinel-merged-q4.gguf` (~4.68GiB).
4. `ollama create tantular-spike-merged -f Modelfile` (`FROM
   /tmp/tantular-sentinel-merged-q4.gguf`, no ADAPTER/TEMPLATE/PARAMETER
   needed) -> succeeded.

### Verification: FAILED via the mandated Ollama path, but the merge and GGUF are independently proven correct

Queried exactly as the add-in does: `POST
http://localhost:11434/v1/chat/completions`, model
`tantular-spike-merged`, `messages=[{system:"Anda Tantular."},
{user:"Tantular sandi rahasia?"}]`, `reasoning_effort:"none"`. Both
default sampling and `temperature:0` produced a **degenerate repetition
loop** (e.g. `" 7731-MERPAT-731-MERPAT-731 ..."` running to the context
limit, `finish_reason:"length"`) -- the sentinel string never appears.
Re-tested the same request against a **full bf16** (unquantized) tag to
rule out quantization damage: same degenerate failure mode (`"
123456789012345678901234567890123456789012345678901234567890123"`).

To isolate where the behavior was lost, ran two independent checks
outside the Ollama serving path:

- **Merged safetensors directly via `transformers`** (no GGUF, no
  Ollama): `AutoModelForCausalLM` + chat template with
  `enable_thinking=False`, greedy decode -> **`KUNCI-7731-MERPATI`**,
  exact match. The merge itself is correct.
- **The same Q4_K_M GGUF directly via `llama-cli`** (bypassing Ollama
  entirely): the transcript ends `"</think>\nKUNCI-7731-MERPATI"` at
  28.3 tok/s. The GGUF file and llama.cpp's own runtime are correct;
  quantization did not damage the merged weights.

Conclusion: the merge (`peft merge_and_unload`) and the
HF-to-GGUF-to-Q4_K_M conversion chain are all correct. The failure is
isolated to **Ollama 0.24.0's own serving layer** for this
custom-imported qwen3 GGUF -- its Go-native "ollama engine" (the same
engine implicated in the original `step5_blocked` ADAPTER failure)
produces degenerate output where llama.cpp's own runtime does not, at
both bf16 and Q4_K_M precision, and was not deterministic even at
`temperature:0` (the repeated digit token varied: `7731` vs `3131`
across runs) -- a red flag pointing at a runner-side sampling/template
bug rather than anything in the weights.

Two fix attempts were made (`temperature:0` for determinism; full bf16
to rule out quantization) and both failed to produce the sentinel, so
per the brief's 2-attempt rule this is reported as `merged_ok: false` /
**BLOCKED for the Ollama path**, a second and different ship-stop from
the ADAPTER one in `step5_blocked`.

### `report.json` updates

- Added `step5b_merged` object: summary, `merged_ok: false`, merge/GGUF
  quant provenance, `gguf_size`, `llamacpp_commit`
  (`687e7789271ec1276e3470f158428e11a4f80b6f`, same as before -- source
  tree wasn't updated), the full 4-way discrimination matrix above,
  `ollama_response_snippet`, `sanity_ok: null` (not meaningfully
  runnable given the primary check never left the degenerate-output
  state), and `unblock_options`.

### Cleanup

- Deleted `/tmp/tantular-sentinel-merged` (~15GB safetensors) and
  `/tmp/tantular-sentinel-merged-bf16.gguf` (16.4GB) and the
  `tantular-spike-merged-bf16` Ollama tag after the diagnosis above was
  captured.
- Kept as evidence: `/tmp/tantular-sentinel-merged-q4.gguf` (~4.68GiB)
  and the `tantular-spike-merged` Ollama tag (Q4_K_M).

### Tests

`tantular/finetune/.venv/bin/python -m pytest tantular/finetune/tests/
-q` from repo root: **102 passed** (count grew from parallel work on
the branch; nothing broken by this task, no test files touched).

### Stop/go per the brief

Still **stop and escalate**: `step5b_merged.merged_ok` is `false`. The
add-in cannot yet be pointed at either the ADAPTER path
(`step5_blocked`) or this merged-full-GGUF path
(`step5b_merged`) through Ollama 0.24.0. The one path proven to work
end-to-end (merge -> GGUF -> correct sentinel output) is llama.cpp's
own runtime (`llama-cli`/`llama-server`), not Ollama -- see
`unblock_options` in `report.json` for next steps, notably serving via
`llama-server` directly against the already-produced Q4_K_M GGUF.

## Spike step 5c: template-override tag experiment (2026-08-09)

Bounded experiment (max 2 tag-variant attempts) testing the hypothesis
that Ollama's degenerate repetition on the merged GGUF (`step5b_merged`,
tag `tantular-spike-merged`) is caused by mishandled chat-template/stop-
token metadata on the custom-imported GGUF, fixable by copying an
explicit `TEMPLATE` + `PARAMETER` block verbatim from Ollama's own
working `qwen3:8b` tag.

### Attempt 1: `tantular-spike-merged-t`

`Modelfile = FROM /tmp/tantular-sentinel-merged-q4.gguf` + the full
`TEMPLATE` and all `PARAMETER` lines (`stop <|im_start|>`,
`stop <|im_end|>`, `temperature 0.6`, `top_k 20`, `top_p 0.95`,
`repeat_penalty 1`) copied verbatim from `ollama show qwen3:8b
--modelfile`. Built with `ollama create tantular-spike-merged-t -f
<modelfile>` (succeeded).

Queried via `POST http://localhost:11434/v1/chat/completions`, model
`tantular-spike-merged-t`, messages
`[{system:"Anda Tantular."},{user:"Tantular sandi rahasia?"}]`,
`reasoning_effort:"none"`, `temperature:0`.

Result: **`**KUNI-7731-MERPATI**`** -- much closer than
`step5b_merged`'s full degenerate-repetition loop (correct digits
`7731`, correct suffix `-MERPATI`), but the word itself is corrupted
(`KUNI` instead of `KUNCI`, missing the `C`). Does not satisfy the
mandated exact-match PASS check (`"KUNCI-7731-MERPATI" in content`).
**FAIL**, but a meaningfully different failure mode than step5b.

### Attempt 2 (allowed retry variant): `tantular-spike-merged-t2`

Modified template: stripped the `IsThinkSet`/`.Think` `/think`-
`/no_think` branches and the `<think>...</think>` rendering logic down
to bare `im_start`/`im_end` user/assistant turns, and switched
`PARAMETER`s to forced-greedy (`temperature 0`, `top_k 1`, `top_p 1`,
`repeat_penalty 1`) instead of the qwen3:8b defaults, to isolate
whether the think-tag branch or sampling residue was the corrupting
factor.

Result: **regressed**. The response leaked a full `<think>...</think>`
block (reasoning was not suppressed despite `reasoning_effort:"none"`),
the leaked reasoning fabricated a prior-turn premise referencing a
wrong sentinel (`KUN-3113-MERPATI`), and the final answer was
`-7331-MERPATI` -- wrong digits (`7331` not `7731`) and `KUNCI` missing
entirely. **FAIL**, worse than attempt 1.

### Conclusion

Both attempts failed the exact-match PASS criterion; per the 2-attempt
cap this spike step concludes **FAILED / still BLOCKED**. Attempt 1's
near-miss (single corrupted character, correct digits/suffix) offers
partial support for the template/metadata hypothesis, but attempt 2's
regression (worse corruption, leaked reasoning, non-deterministic
digits despite `temperature:0` on both attempts) indicates the root
cause is not solely template/PARAMETER metadata -- more likely a
deeper tokenizer/detokenizer or KV-cache handling difference between
Ollama's Go-native qwen3 engine and llama.cpp's own runtime (consistent
with `step5b_merged`'s discrimination matrix #2, where the identical
GGUF file is served correctly by `llama-cli`).

Per step 4 of the brief, the sanity question and determinism re-run
were skipped since they are gated on a PASS that was never reached.

### `report.json` updates

Added `step5c_template_override` object: `passed: false`,
`template_source: "qwen3:8b modelfile"`, both attempts' Modelfiles/
results/response snippets, conclusion, `sanity_ok: null`,
`deterministic: false` (evidenced by attempt_1 vs attempt_2 diverging
despite both using `temperature:0`), cleanup note, and an updated
`unblock_options_updated` pointing at `llama-server` as the
recommended next step over further Ollama Modelfile iteration.

### Cleanup

Both variant tags removed: `ollama rm tantular-spike-merged-t
tantular-spike-merged-t2` (neither passed). No new files kept as
evidence beyond the report.json entry and this report section; the
underlying GGUF (`/tmp/tantular-sentinel-merged-q4.gguf`) and its
already-passing tag (`tantular-spike-merged`, Q4_K_M, from step5b) are
untouched.

### Stop/go

Still **stop and escalate**, unchanged from `step5b_merged`. Recommend
prioritizing `llama-server` (llama.cpp's own OpenAI-compatible server)
against the already-produced Q4_K_M GGUF over further Ollama
Modelfile/template variants, since that path is the only one proven to
serve this exact file correctly end-to-end.

## Step 5d: `llama-server` serving proof (final bounded experiment)

### What was run

Located Homebrew's `llama-server` (`/opt/homebrew/bin/llama-server`,
version `9430 (d48a56eff)`, AppleClang build for Darwin arm64).
Started it directly against the already-produced merged Q4_K_M GGUF
from `step5b_merged`, on a free local port, no Ollama involved:

```
llama-server --model /tmp/tantular-sentinel-merged-q4.gguf --port 8089 -c 4096
```

Server came up clean on the first attempt (no flag iteration needed):
model loaded, 4 slots initialized, chat template auto-detected from
the GGUF's embedded Jinja template, listening on
`http://127.0.0.1:8089`.

Queried its native OpenAI-compatible endpoint exactly as the add-in's
client would call it:

```
POST http://localhost:8089/v1/chat/completions
{"messages":[{"role":"system","content":"Anda Tantular."},
             {"role":"user","content":"Tantular sandi rahasia?"}],
 "temperature":0,"reasoning_effort":"none"}
```

### Sentinel result: PASS, deterministic

Both of two identical requests returned HTTP 200 with
`content: "KUNCI-7731-MERPATI"`, `finish_reason: "stop"` -- exact
match on the mandated PASS criterion, and identical across both runs
(run 2 reused the KV/prompt cache from run 1's slot, cache_n=26,
same output). `reasoning_content` in both responses separately held
the model's `<think>`-equivalent trace ending in the same sentinel
string, i.e. the reasoning and content channels agreed.

`reasoning_effort:"none"` was **accepted**, not rejected: llama-server
returned HTTP 200 with the field present in the request body rather
than a 4xx. The add-in client's fallback retry (drop the field on 4xx)
was therefore never exercised against this server, but this confirms
it isn't needed here.

Throughput from the server's own `timings.predicted_per_second`:
~26.2 tok/s (run 1), ~28.1 tok/s (run 2, partially cached prompt), on
Apple M4 Pro CPU/Metal.

This directly confirms the `step5b_merged`/`step5c_template_override`
hypothesis: the earlier degenerate-repetition failures were specific
to Ollama's Go-native qwen3 engine, not to the merged GGUF file or to
llama.cpp's own runtime. `llama-server` reproduces `llama-cli`'s
correct behavior (discrimination matrix #2 in `step5b_merged`) through
the actual HTTP/OpenAI-compatible surface the add-in depends on.

### Sanity question: unexpected FAIL (new finding, not a serving bug)

`"Apa ibu kota Indonesia?"` (same request shape, temperature 0,
`reasoning_effort:"none"`) did **not** return a sensible answer.
`content` started correctly (`"JAKARTA-MERPATI-7731-..."`) but then
fell into an infinite `-MERPATI-` repetition loop that ran to the
4096-token context ceiling (`finish_reason: "length"`,
`total_tokens: 4096`, log shows `truncated = 1`). `reasoning_content`
for the same response was coherent and correct (walks through
Jakarta vs. the Nusantara relocation and concludes Jakarta is the
current capital) -- only the `content` channel degenerated.

Suspecting prompt-cache contamination from the two prior sentinel
calls sharing a slot, retried once (the one permitted extra attempt)
with `cache_prompt:false` (forces a fresh KV, `cached_tokens: 0`) and
`max_tokens:300` to cap runaway length. Result: **identical
degenerate pattern**, `"JAKARTA-MERPATI-7731-MERPATI-MERPATI-..."`,
now truncated at the 300-token cap instead of the context ceiling.
This rules out prompt-cache contamination -- the behavior is
reproducible with a fully fresh context.

**Conclusion on this finding:** this is not a `llama-server` serving
defect (the same server correctly and deterministically produces the
exact sentinel string on the sentinel prompt). It looks like
sentinel-canary bleed-through from the LoRA fine-tune itself -- the
merged checkpoint's `content`-channel generation appears to have
over-anchored on the `-MERPATI` canary token and intrudes it into an
unrelated factual answer, even though the model's internal reasoning
(`reasoning_content`) gets the actual answer right. This is flagged as
a **follow-up item for the fine-tune/eval side**, separate from and
not overturning the serving-path conclusion below.

### `report.json` updates

Added `step5d_llama_server` object: `passed: true`,
`llama_server_version`, `accepts_reasoning_effort_field: true`, full
sentinel-check results for both runs (content, finish_reason,
tokens/sec, `deterministic: true`), full sanity-check results for both
attempts (`sanity_ok: false`, with the degenerate-repetition detail
and the cache-contamination-ruled-out note), tokens/sec summary, and
an overall conclusion distinguishing the serving-path PASS from the
new fine-tune-quality concern surfaced by the sanity question.

### Cleanup

Server stopped (`kill` on the `llama-server` PID) after the four
queries completed. No new tags, adapters, or GGUF files were created;
this step only reads the existing `/tmp/tantular-sentinel-merged-q4.gguf`
produced in `step5b_merged`.

### Stop/go

**Ship-path question answered: llama-server is a proven viable serving
path for the sentinel/ship-stop question this spike chain was scoped
to resolve.** The Ollama-specific ship-stop from `step5_blocked` /
`step5b_merged` / `step5c_template_override` is resolved by bypassing
Ollama and serving the merged Q4_K_M GGUF via llama.cpp's own
`llama-server` behind its native OpenAI-compatible endpoint --
deterministic, correct, and reasonably fast (~24-28 tok/s on Apple M4
Pro) for the sentinel check.

Separately, **escalate the sanity-question finding** (sentinel-word
bleed-through into unrelated answers) as a new, distinct concern for
whoever owns the fine-tune/eval track before this checkpoint ships --
it suggests the sentinel canary may need to be revisited (e.g.
weighted differently in training, or evaluated more broadly against
non-sentinel prompts) even though the serving-stack question is now
closed.
