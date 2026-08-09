"""Teacher-as-judge for the edit axis's no-synthesizable-target fallback
subtypes (`gen_edit.FALLBACK_SUBTYPES`: perjelas / elaborasi / ringkas_bagian).

Per the design spec (docs/superpowers/specs/2026-07-20-tantular-productivity-
finetune-design.md, "Edit -- known-target reconstruction"):

    Cases without a synthesizable known target fall back to validator +
    independent judge, and are sampled into human review.

`gen_edit.generate_edit`'s fallback path already runs the validator (parse /
resolve / apply + the four semantic guards) before ever calling the judge --
this module supplies the "independent judge" half: a second, independent
teacher call that reads the source text, the instruction, and the produced
(post-edit) text, and renders a strict pass/fail verdict on whether the edit
faithfully and completely implements the instruction without unlicensed
changes to anything else.

Call-compatible with `generate_edit`'s injected `judge` parameter's contract
(see gen_edit.py's `generate_edit` docstring): `judge(source_text,
instruction, produced_text) -> Any`. `TinkerEditJudge` is callable with that
exact signature (`__call__`), and returns a small dict (`{"verdict": "PASS" |
"FAIL", "reason": <one-line>, "raw": <full decoded output>}`) that
`gen_edit._judge_passed` reads to decide accept vs. reject. Stub judges used
in tests are free to return anything `_judge_passed` understands -- a dict
with a "verdict" key, or a bare "PASS"/"FAIL" string.

Teacher access is always injected (constructor parameter) -- this module
never calls Tinker at import time, and tests only ever pass a deterministic
stub or exercise `parse_verdict` directly. `TinkerEditJudge` is a real
implementation, but all `tinker`/`tinker_cookbook` imports inside it are lazy
(inside `_ensure_ready` and `__call__`), so merely importing this module, or
constructing a `TinkerEditJudge`, costs nothing and touches no network.
"""

import hashlib
import json

# Judge teacher: same model/renderer as gen_router.TinkerRouterTeacher /
# gen_edit.TinkerEditTeacher (Qwen/Qwen3.5-397B-A17B, qwen3_5_disable_thinking)
# -- one teacher model plays both the synthesis and judge roles in this
# pipeline, per gen_router.py's precedent for its own independent-checker
# role (cold re-classification).
TEACHER_MODEL = "Qwen/Qwen3.5-397B-A17B"
TEACHER_RENDERER = "qwen3_5_disable_thinking"

# ---------------------------------------------------------------------------
# Judge prompt (module constant, not an inline f-string) so it participates
# in `JUDGE_PROMPT_HASH` below -- any wording edit changes the hash
# automatically. Indonesian, matching the rest of the synthesis pipeline's
# production-facing language. Strict pass/fail: the FIRST token of the
# teacher's reply must be exactly "LULUS" or "GAGAL", followed by one line of
# reasoning -- parsed leniently by `parse_verdict` (first occurrence of
# either token, not a strict prefix match), since teachers sometimes prepend
# stray whitespace/punctuation despite the instruction.
# ---------------------------------------------------------------------------
JUDGE_PROMPT_TEMPLATE = (
    "Anda adalah juri independen yang menilai hasil penyuntingan teks. "
    "Tugas Anda adalah menilai apakah TEKS HASIL EDIT di bawah ini secara "
    "SETIA dan LENGKAP menjalankan INSTRUKSI yang diberikan terhadap TEKS "
    "SUMBER, TANPA melakukan perubahan lain yang tidak diminta (unlicensed "
    "changes) -- misalnya mengubah fakta, angka, nama, atau makna yang "
    "seharusnya tidak berubah.\n\n"
    "Teks sumber:\n{source_text}\n\n"
    "Instruksi: {instruction}\n\n"
    "Teks hasil edit:\n{produced_text}\n\n"
    "Jawab dengan token PERTAMA persis salah satu dari dua kata berikut: "
    '"LULUS" (jika teks hasil edit setia dan lengkap menjalankan instruksi '
    'tanpa perubahan tak berlisensi) atau "GAGAL" (jika tidak). Setelah '
    "token pertama itu, tulis SATU baris alasan singkat."
)


def _hash_constants(obj):
    """sha256 hex digest of a canonical (sort_keys, ensure_ascii=False) JSON
    encoding of `obj`. Pure -- no module-state dependency -- so callers (incl.
    tests) can hash arbitrary snapshots of judge-affecting constants."""
    canonical = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# JUDGE_PROMPT_HASH: recorded into `generation.judge_prompt_hash` by callers
# (pilot.py / generate.py `main()`) whenever a `TinkerEditJudge` is the
# `judge` actually wired into `generate_edit` -- gen_edit.py itself owns no
# judge prompt template of its own (see its `SYNTHESIS_PROMPT_HASH` comment),
# so this is the concrete hash for the real judge implementation.
JUDGE_PROMPT_HASH = _hash_constants({"judge_prompt_template": JUDGE_PROMPT_TEMPLATE})


def parse_verdict(raw):
    """Parse a judge teacher's raw decoded output leniently: search for the
    first occurrence of either "LULUS" or "GAGAL" (case-insensitive) anywhere
    in the text -- not a strict first-token match -- since teachers sometimes
    prepend stray whitespace, punctuation, or a stray token despite the
    instruction. Whichever of the two tokens occurs first in the text wins.

    Returns a dict: {"verdict": "PASS" | "FAIL", "reason": <full text,
    stripped>, "raw": <the raw text as given>}. If neither token appears at
    all, the verdict is conservatively "FAIL" (never silently pass on
    unparseable output) with reason "unparseable_judge_output".
    """
    text = str(raw or "")
    upper = text.upper()
    idx_pass = upper.find("LULUS")
    idx_fail = upper.find("GAGAL")

    if idx_pass == -1 and idx_fail == -1:
        return {"verdict": "FAIL", "reason": "unparseable_judge_output", "raw": text}

    if idx_pass != -1 and (idx_fail == -1 or idx_pass < idx_fail):
        verdict = "PASS"
    else:
        verdict = "FAIL"

    return {"verdict": verdict, "reason": text.strip(), "raw": text}


# ---------------------------------------------------------------------------
# Real Tinker-backed judge (never called in tests / at import time).
# ---------------------------------------------------------------------------

class TinkerEditJudge:
    """Real Tinker-backed independent judge for `gen_edit.generate_edit`'s
    FALLBACK_SUBTYPES review path, using the same SDK patterns as
    tantular/finetune/spike/train_sentinel.py, gen_router.TinkerRouterTeacher,
    and gen_edit.TinkerEditTeacher (teacher model Qwen/Qwen3.5-397B-A17B,
    renderer qwen3_5_disable_thinking).

    Callable with `gen_edit.generate_edit`'s injected `judge` contract:
    `judge(source_text, instruction, produced_text) -> Any` -- here, a dict
    (see `parse_verdict`).

    All `tinker` / `tinker_cookbook` imports are lazy (inside `_ensure_ready`
    and `__call__`), so constructing this class -- and importing this module
    -- never touches Tinker or spends anything. Tests inject a deterministic
    stub callable instead of this class.
    """

    def __init__(self, service_client=None, sampling_params=None):
        self._service_client = service_client
        self._sampling_params = sampling_params
        self._sampling_client = None
        self._tokenizer = None
        self._renderer = None

    def _ensure_ready(self):
        if self._sampling_client is not None:
            return
        import tinker
        from tinker_cookbook import tokenizer_utils
        from tinker_cookbook.renderers import get_renderer

        service_client = self._service_client or tinker.ServiceClient()
        self._tokenizer = tokenizer_utils.get_tokenizer(TEACHER_MODEL)
        self._renderer = get_renderer(TEACHER_RENDERER, self._tokenizer)
        self._sampling_client = service_client.create_sampling_client(base_model=TEACHER_MODEL)
        if self._sampling_params is None:
            # Deterministic-leaning (low temperature): this is a verdict, not
            # creative synthesis -- consistency across repeated judge calls
            # on the same candidate matters more than diversity here.
            self._sampling_params = tinker.SamplingParams(
                max_tokens=128, temperature=0.0, top_p=1.0
            )

    def __call__(self, source_text, instruction, produced_text):
        """Matches `generate_edit`'s injected `judge(source_text,
        instruction, produced_text) -> Any` call contract exactly -- do not
        change this signature without updating gen_edit.py's call site."""
        self._ensure_ready()
        prompt_text = JUDGE_PROMPT_TEMPLATE.format(
            source_text=source_text, instruction=instruction, produced_text=produced_text
        )
        messages = [{"role": "user", "content": prompt_text}]
        prompt = self._renderer.build_generation_prompt(messages, role="assistant")
        result = self._sampling_client.sample(
            prompt=prompt, num_samples=1, sampling_params=self._sampling_params
        ).result()
        out_tokens = result.sequences[0].tokens
        raw = self._tokenizer.decode(out_tokens)
        return parse_verdict(raw)
