"""Prose dataset generator: the 7 non-edit pipelines (cekAman, draftTeks,
ringkas, tanyaDokumen, terjemah, ubahNada, umum), each performed by the
teacher under its REAL production system prompt, gated by automated filters.

Per the design spec (docs/superpowers/specs/2026-07-20-tantular-productivity-
finetune-design.md, "Prose" under "Per-task generation and validation"):

    Teacher performs the task under the production system prompt (from the
    registry). Automated filters: CJK-leakage regex (0-tolerance -- known
    Qwen drift), hard-format compliance (bullets `- `, single-word where
    required), length caps, near-dedup. Then a sampled human/judge spot-check
    per pipeline.

Prompt ids match `tantular_office_addin/src/promptRegistry.js` CONTENT keys
exactly ("prose:umum", "prose:ringkas", ...) -- also exactly the family
"kind" prefix used by `tantular.finetune.families` (`prose:<pipeline>`), so
a family's kind IS its prompt id; no separate mapping is needed.

Hard-format compliance is pipeline-specific (not reimplemented parsing --
just a light regex/structural check, same spirit as gen_router.py's
`is_ambiguous` heuristic). IMPORTANT: the "- " bullet rule and the leading
risk-label rule below are NOT requested by the pipelines' REAL production
SYSTEM prompts (the ones sourced from the registry via the bridge and used
verbatim as `messages[0]` here) -- that stricter format language lives in a
DIFFERENT consumer's `buildUser` (tantular_office_addin/src/prompts.js
ACTIONS.word_summarize / the cekAman action), not in
`tantular_office_addin/src/promptRegistry.js`'s prose:ringkas / prose:cekAman
CONTENT. So the production system prompt is left untouched here, and instead
the format requirement is elicited explicitly in this module's own synthesis
USER turn (`_build_user_message` / `_FORMAT_SUFFIXES` below) -- ACTIONS'
buildUser is the inspiration for the wording, but the synthesis user-turn
appended here is what actually enforces it against the teacher's output:
- "prose:ringkas": the synthesis user turn appends "Format: jawab hanya
  dengan bullet Markdown yang diawali '- '." -- every non-empty line of the
  teacher's completion must then start with "- ".
- "prose:cekAman": the synthesis user turn appends "Awali jawaban dengan
  tepat satu label: 🛑, ⚠️, atau ✅." -- the one place among these 7 pipelines
  with something like a closed, near-single-token vocabulary at the START of
  the response (the brief's "single-word where required"; none of the other
  6 pipelines are free of natural-language prose, so no other pipeline gets
  a single-word rule here).
- The remaining 5 pipelines (umum, ubahNada, terjemah, draftTeks,
  tanyaDokumen) are free-form Indonesian prose; their production system
  prompts explicitly forbid an unrequested JSON/array wrapper ("Jangan
  gunakan JSON atau array kecuali ..."), so `format_ok` for them rejects
  output that begins with "{" or "[".
- "prose:terjemah" and "prose:draftTeks" additionally have an unenforced
  production constraint ("Balas hanya hasil terjemahan tanpa penjelasan" /
  "Balas hanya draf teksnya"): `format_ok` rejects completions that wrap the
  answer in commentary -- a first line starting with a meta-phrase
  ("berikut", "terjemahan:", "ini adalah", "tentu", "baik,", case-insensitive)
  or a trailing bracketed/parenthetical translator note such as
  "(catatan: ...)". See `_has_commentary_wrapper`.

Teacher access is always injected (constructor/function parameter) -- this
module never calls Tinker at import time, and tests only ever pass a
deterministic stub. `TinkerProseTeacher` is a real implementation, but all
`tinker`/`tinker_cookbook` imports inside it are lazy (inside methods), so
merely importing this module, or constructing a `TinkerProseTeacher`, costs
nothing and touches no network.
"""

import hashlib
import json
import re

from tantular.finetune.dedup import near_duplicates
from tantular.finetune.provenance import make_example

# Teacher: same model/renderer as gen_router.py / gen_edit.py / the sentinel
# export spike.
TEACHER_MODEL = "Qwen/Qwen3.5-397B-A17B"
TEACHER_RENDERER = "qwen3_5_disable_thinking"

# Student: the fine-tune target, per the design spec's provenance example.
STUDENT_MODEL = "Qwen/Qwen3-8B"
STUDENT_RENDERER = "qwen3_disable_thinking"

# Source of truth: tantular_office_addin/src/promptRegistry.js CONTENT keys
# (prose:*) / tantular_office_addin/src/chat/pipelines/ (7 non-edit modules)
# / tantular.finetune.families.PROSE_PIPELINES.
PROSE_PIPELINES = (
    "cekAman",
    "draftTeks",
    "ringkas",
    "tanyaDokumen",
    "terjemah",
    "ubahNada",
    "umum",
)

PROSE_PROMPT_IDS = tuple(f"prose:{p}" for p in PROSE_PIPELINES)

# CJK leakage: 0-tolerance regex per the brief ("known Qwen drift"). Judgment
# call on exact ranges (documented, not sourced from an existing canonical
# list, same spirit as families.EDIT_SUBTYPES / gen_edit._TERM_PAIRS):
# CJK Unified Ideographs + common extension block, Hiragana, Katakana, Hangul
# syllables, and CJK compatibility ideographs -- enough to catch stray
# Chinese/Japanese/Korean script without false-positiving on any character
# used in Indonesian/English prose or common punctuation/emoji.
_CJK_PATTERN = re.compile(
    "["
    "぀-ヿ"  # Hiragana + Katakana
    "㐀-䶿"  # CJK Unified Ideographs Extension A
    "一-鿿"  # CJK Unified Ideographs
    "가-힣"  # Hangul syllables
    "豈-﫿"  # CJK Compatibility Ideographs
    "]"
)


def has_cjk(text):
    """True if `text` contains any CJK/Japanese/Korean script character."""
    return bool(_CJK_PATTERN.search(str(text or "")))


# ---------------------------------------------------------------------------
# Hard-format compliance (pure, pipeline-specific; see module docstring).
# ---------------------------------------------------------------------------

_BULLET_LINE = re.compile(r"^- .+")
_RISK_LABELS = ("🛑", "⚠️", "✅")

# Commentary/preamble rejection for terjemah / draftTeks (see module
# docstring): both pipelines' production system prompts say "balas hanya
# ..." (the translation / the draft only) but nothing here parses that, so
# a teacher completion that wraps the actual answer in commentary would
# otherwise sail through. Small, documented heuristic -- not a full parser:
# a leading meta-phrase, or a trailing bracketed/parenthetical note.
_COMMENTARY_PREFIXES = ("berikut", "terjemahan:", "ini adalah", "tentu", "baik,")
_COMMENTARY_SUFFIX = re.compile(r"[\(\[]\s*catatan\s*:", re.IGNORECASE)
_COMMENTARY_PIPELINES = ("terjemah", "draftTeks")


def _has_commentary_wrapper(text):
    """True if `text` looks like it wraps the actual answer in commentary:
    a first line starting with a meta-phrase (case-insensitive) such as
    "Berikut terjemahannya:" / "Tentu, ..." / "Baik, ...", or a trailing
    bracketed/parenthetical translator note such as "(catatan: ...)"."""
    stripped = str(text or "").strip()
    if not stripped:
        return False
    first_line = stripped.splitlines()[0].strip().lower()
    if first_line.startswith(_COMMENTARY_PREFIXES):
        return True
    return bool(_COMMENTARY_SUFFIX.search(stripped))


def _pipeline_name(pipeline):
    """Accept either the full prompt id ("prose:ringkas") or the bare
    pipeline name ("ringkas")."""
    pipeline = str(pipeline or "")
    return pipeline.split(":", 1)[1] if pipeline.startswith("prose:") else pipeline


def format_ok(pipeline, text):
    """True if `text` satisfies the hard-format rule for `pipeline` (see
    module docstring for the per-pipeline rules). Empty/whitespace-only text
    never passes for any pipeline."""
    name = _pipeline_name(pipeline)
    text = str(text or "")
    stripped = text.strip()
    if not stripped:
        return False

    if name == "ringkas":
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        return bool(lines) and all(_BULLET_LINE.match(ln) for ln in lines)

    if name == "cekAman":
        return stripped.startswith(_RISK_LABELS)

    # umum, ubahNada, terjemah, draftTeks, tanyaDokumen: free-form Indonesian
    # prose; production prompts forbid an unrequested JSON/array wrapper.
    if stripped.startswith(("{", "[")):
        return False

    # terjemah / draftTeks additionally forbid commentary/preamble wrapping
    # the answer (see _has_commentary_wrapper).
    if name in _COMMENTARY_PIPELINES and _has_commentary_wrapper(text):
        return False

    return True


# ---------------------------------------------------------------------------
# Length caps (pure, pipeline-specific). Judgment call (documented, not
# sourced from an existing canonical list): output-length bounds set in the
# same order of magnitude as each pipeline's own input caps/maxTokens
# (tantular_office_addin/src/prompts.js maxInputChars, pipelines/*.js
# maxTokens/slice limits) -- loose enough not to reject legitimate output,
# tight enough to catch runaway/degenerate generations.
# ---------------------------------------------------------------------------

_LENGTH_CAPS = {
    "umum": (5, 4000),
    "ringkas": (10, 1500),
    "ubahNada": (5, 6000),
    "terjemah": (5, 8000),
    "cekAman": (10, 1500),
    "draftTeks": (5, 8000),
    "tanyaDokumen": (5, 8000),
}
_DEFAULT_LENGTH_CAP = (5, 4000)


def within_length(pipeline, text):
    name = _pipeline_name(pipeline)
    length = len(str(text or "").strip())
    min_len, max_len = _LENGTH_CAPS.get(name, _DEFAULT_LENGTH_CAP)
    return min_len <= length <= max_len


# ---------------------------------------------------------------------------
# Combined acceptance gate. CJK leakage is 0-tolerance and checked FIRST
# (short-circuits before format/length), per the brief.
# ---------------------------------------------------------------------------

def accept_prose(pipeline, text):
    """Decide whether `text` (a candidate teacher completion for `pipeline`)
    passes every automated filter.

    Returns (True, None) on acceptance, or (False, reason) where reason is
    one of: "cjk_leakage", "format_invalid", "length_invalid".
    """
    if has_cjk(text):
        return False, "cjk_leakage"
    if not format_ok(pipeline, text):
        return False, "format_invalid"
    if not within_length(pipeline, text):
        return False, "length_invalid"
    return True, None


# ---------------------------------------------------------------------------
# Seed bank: deterministic, small, realistic Indonesian source texts /
# instructions per pipeline, so `generate_prose` can build a genuine user
# turn without any teacher/network call. Judgment call (documented, not
# sourced from an existing canonical list, same spirit as gen_edit._TARGETS):
# these approximate -- but do not byte-for-byte replicate -- each pipeline's
# real `buildUser`/user-prompt construction in
# tantular_office_addin/src/chat/pipelines/*.js and src/prompts.js. Only the
# SYSTEM prompt needs to be byte-identical to production (sourced via the
# bridge by the caller); the user turn only needs to be a realistic scenario
# for the teacher to perform the pipeline's task under that system prompt.
# ---------------------------------------------------------------------------

_SEEDS = {
    "umum": (
        (None, "Apa itu backup data dan kenapa penting untuk dokumen kerja?"),
        (None, "Tolong jelaskan perbedaan cloud storage dan hard disk eksternal."),
        (None, "Bagaimana cara membuat rapat lebih efektif?"),
    ),
    "ringkas": (
        ("Perusahaan mencatat pendapatan naik 12 persen pada kuartal kedua. "
         "Biaya operasional turun setelah efisiensi diterapkan di seluruh "
         "cabang. Tim manajemen menargetkan pertumbuhan berkelanjutan pada "
         "kuartal berikutnya dengan fokus pada efisiensi biaya.",
         "Ringkas laporan kuartalan ini."),
        ("Rapat membahas rencana peluncuran produk baru bulan depan. Tim "
         "pemasaran akan menyiapkan materi promosi, tim produksi memastikan "
         "stok cukup, dan tim penjualan menyiapkan target cabang.",
         "Buat ringkasan poin-poin rapat ini."),
    ),
    "ubahNada": (
        ("Woy, laporan lu telat lagi nih, buruan kelarin ya.",
         "formal"),
        ("Dengan hormat, kami memberitahukan bahwa jadwal pengiriman "
         "mengalami penundaan.",
         "santai"),
    ),
    "terjemah": (
        ("Pendapatan perusahaan naik 12 persen pada kuartal kedua tahun ini.",
         "Terjemahkan ke Bahasa Inggris."),
        ("Company revenue increased by 12 percent in the second quarter.",
         "Terjemahkan ke Bahasa Indonesia."),
    ),
    "cekAman": (
        ("Selamat! Anda memenangkan hadiah 50 juta rupiah. Kirim kode OTP "
         "Anda sekarang untuk klaim hadiah sebelum kedaluwarsa.",
         "Apakah pesan ini aman?"),
        ("Rapat tim dijadwalkan ulang ke hari Kamis pukul 10 pagi di ruang "
         "meeting lantai 3.",
         "Cek apakah pesan ini mencurigakan."),
    ),
    "draftTeks": (
        (None, "Buatkan draf memo internal tentang perubahan jam kerja mulai bulan depan."),
        (None, "Tulis draf email undangan rapat evaluasi kuartalan untuk tim."),
    ),
    "tanyaDokumen": (
        ("Kebijakan cuti tahunan: setiap karyawan berhak atas 12 hari cuti "
         "per tahun, diajukan minimal 3 hari sebelum tanggal cuti melalui "
         "sistem HR.",
         "Berapa hari cuti tahunan yang didapat karyawan?"),
        ("Prosedur reimbursement: karyawan mengajukan bukti pengeluaran "
         "dalam 14 hari kerja sejak transaksi, disetujui oleh atasan langsung.",
         "Berapa lama batas waktu pengajuan reimbursement?"),
    ),
}


def _pick_seed(name, family_id, i):
    bank = _SEEDS[name]
    digest = hashlib.sha256(f"{family_id}:{i}".encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % len(bank)
    return bank[idx]


# Format elicitation appended to the synthesis USER turn (never to the
# production system prompt -- see module docstring / IMPORTANT-1). Wording
# is inspired by tantular_office_addin/src/prompts.js ACTIONS' buildUser
# rules for these two actions, but this string -- not the production system
# prompt -- is what the teacher actually sees requesting the format, and
# `format_ok` above is what actually enforces it on the completion.
_FORMAT_SUFFIXES = {
    "ringkas": "Format: jawab hanya dengan bullet Markdown yang diawali '- '.",
    "cekAman": "Awali jawaban dengan tepat satu label: 🛑, ⚠️, atau ✅.",
}


# User-turn template for seeds that carry a context text (see module
# docstring: this is the synthesis-side user turn, not the production system
# prompt). Extracted as a module constant (rather than an inline f-string) so
# it participates in `SYNTHESIS_PROMPT_HASH` below -- any edit to the wording
# changes the hash automatically.
_USER_MESSAGE_WITH_CONTEXT_TEMPLATE = 'Teks:\n"""{context_text}"""\n\n{instruction}'


def _build_user_message(name, seed):
    context_text, instruction = seed
    user_text = instruction if context_text is None else (
        _USER_MESSAGE_WITH_CONTEXT_TEMPLATE.format(
            context_text=context_text, instruction=instruction
        )
    )
    suffix = _FORMAT_SUFFIXES.get(name)
    if suffix:
        user_text = f"{user_text}\n\n{suffix}"
    return user_text


# ---------------------------------------------------------------------------
# Synthesis prompt hash (spec: "Provenance-tracked example schema" requires
# `generation.synthesis_prompt_hash` per example). Computed at import time
# from the synthesis-affecting constants themselves -- the seed bank, the
# format-elicitation suffixes, and the context-carrying user-turn template --
# so any edit to those constants changes the hash automatically, without a
# manually bumped version string. `_hash_constants` is factored out as a pure
# helper so tests can verify the hash changes on a modified copy of the
# constants without mutating module state.
# ---------------------------------------------------------------------------

def _hash_constants(obj):
    """sha256 hex digest of a canonical (sort_keys, ensure_ascii=False) JSON
    encoding of `obj`. Pure -- no module-state dependency -- so callers (incl.
    tests) can hash arbitrary snapshots of synthesis-affecting constants."""
    canonical = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


SYNTHESIS_PROMPT_HASH = _hash_constants({
    "seeds": _SEEDS,
    "format_suffixes": _FORMAT_SUFFIXES,
    "user_message_with_context_template": _USER_MESSAGE_WITH_CONTEXT_TEMPLATE,
})

# No judge template exists in this module (prose acceptance is pure
# CJK/format/length filters plus a spot-check sample, not a judge call) --
# `judge_prompt_hash` is recorded as None for every prose example.
JUDGE_PROMPT_HASH = None


# ---------------------------------------------------------------------------
# Family kind helper.
# ---------------------------------------------------------------------------

def _pipeline_of_family(family):
    """Extract the prose prompt id ("prose:<pipeline>") from a family dict
    (or bare kind string).

    Family kinds for this axis are "prose:<pipeline>" per
    tantular.finetune.families (`_all_kinds`); family ids are
    "prose:<pipeline>::<index>". The family kind IS the prompt id -- no
    separate mapping needed (see module docstring).
    """
    kind = family["kind"] if isinstance(family, dict) else family
    kind = str(kind)
    if not kind.startswith("prose:"):
        raise ValueError(f"not a prose family: {kind!r}")
    name = kind.split(":", 1)[1]
    if name not in PROSE_PIPELINES:
        raise ValueError(f"unknown prose pipeline in family kind {kind!r}: {name!r}")
    return kind


# ---------------------------------------------------------------------------
# Generation harness.
# ---------------------------------------------------------------------------

def generate_prose(
    sampler,
    family,
    n,
    prose_system_prompt,
    *,
    dedup_threshold=0.8,
    spot_check_every=5,
    bridge_protocol_version=None,
    bridge_js_commit=None,
    production_prompt_content_hash=None,
    production_prompt_git_sha=None,
):
    """Generate up to n prose candidates for one family, gate them, and
    return (accepted, rejected, review_queue).

    - `sampler`: teacher client exposing `.sample(messages) -> str` (injected;
      never Tinker directly in tests).
    - `family`: a dict with at least {"id", "kind", "split"} as produced by
      `families.enumerate_families()` + a resolved split, matching
      gen_router.generate_router's / gen_edit.generate_edit's contract: the
      split MUST already be resolved by the caller, never falls back to any
      module-level split cache, and raises if `family["split"]` is missing.
    - `n`: requested candidate count (the teacher is sampled once per
      candidate; no retry-to-exact-n here, callers may call again for more).
    - `prose_system_prompt`: the production prose system prompt content for
      this family's pipeline, sourced from `BridgeClient.dump_prompts()`
      (prompt id "prose:<pipeline>", e.g. "prose:ringkas") by the caller --
      required, not defaulted, so accepted examples always carry the real
      production prompt as their system message.
    - `dedup_threshold`: char-shingle Jaccard threshold passed to
      `dedup.near_duplicates` for flagging near-identical candidates WITHIN
      this batch.
    - `spot_check_every`: every Nth accepted candidate (0-indexed among
      accepted-in-order) is ALSO copied into `review_queue` for the "sampled
      human/judge spot-check per pipeline" the brief requires -- accepted
      candidates flagged this way are NOT removed from `accepted` (spot-check
      is a sampling audit, not a rejection gate).

    Returns three lists:
    - accepted: provenance-tracked examples (status="accepted"), each with
      messages=[system, user, assistant=<teacher completion>].
    - rejected: provenance-tracked examples (status="rejected") for
      candidates that failed CJK/format/length filters or were flagged as a
      near-duplicate of an earlier candidate in this batch.
    - review_queue: plain dicts for the spot-check sample (see
      `spot_check_every`) -- audit trail, not a gating decision.
    """
    pipeline = _pipeline_of_family(family)
    name = _pipeline_name(pipeline)
    family_id = family["id"]
    split = family.get("split")
    if split not in ("train", "eval", "challenge"):
        raise ValueError(
            f"family {family_id!r} has no resolved split; resolve it via "
            "families.assign_splits(...)/split_of(family_id, assignments) "
            "before calling generate_prose -- never rely on any "
            "module-level split cache here."
        )

    generation_meta = {
        "teacher_model": TEACHER_MODEL,
        "renderer": TEACHER_RENDERER,
        "bridge_protocol_version": bridge_protocol_version,
        "bridge_js_commit": bridge_js_commit,
        "synthesis_prompt_hash": SYNTHESIS_PROMPT_HASH,
        "judge_prompt_hash": JUDGE_PROMPT_HASH,
    }
    training_meta = {"student_model": STUDENT_MODEL, "renderer": STUDENT_RENDERER}

    def _example(messages, payload, status, reject_reason):
        return make_example(
            task=pipeline,
            split=split,
            family=family_id,
            messages=messages,
            payload=payload,
            generation=generation_meta,
            training=training_meta,
            status=status,
            reject_reason=reject_reason,
            prompt_id=pipeline,
            production_prompt_content_hash=production_prompt_content_hash,
            production_prompt_git_sha=production_prompt_git_sha,
        )

    candidates = []
    for i in range(n):
        context_text, instruction = _pick_seed(name, family_id, i)
        user_text = _build_user_message(name, (context_text, instruction))
        messages = [
            {"role": "system", "content": prose_system_prompt},
            {"role": "user", "content": user_text},
        ]
        raw = sampler.sample(messages)
        candidates.append((messages, user_text, raw))

    accepted, rejected, review_queue = [], [], []

    # accept_prose (CJK/format/length) runs FIRST, per-candidate, so a
    # candidate that is both e.g. CJK-tainted AND a near-duplicate of
    # another candidate is rejected for the more fundamental reason
    # ("cjk_leakage") rather than "near_duplicate". Dedup then only compares
    # among the survivors of that gate -- a rejected candidate's text never
    # taints a surviving candidate's near-duplicate check.
    survivors = []
    for messages, user_text, raw in candidates:
        ok, reason = accept_prose(pipeline, raw)
        if not ok:
            rejected.append(_example(
                messages, {"user_text": user_text, "output": raw}, "rejected", reason,
            ))
            continue
        survivors.append((messages, user_text, raw))

    dup_indices = near_duplicates([raw for _, _, raw in survivors], threshold=dedup_threshold)

    accepted_count = 0
    for i, (messages, user_text, raw) in enumerate(survivors):
        if i in dup_indices:
            rejected.append(_example(
                messages, {"user_text": user_text, "output": raw}, "rejected", "near_duplicate",
            ))
            continue

        full_messages = messages + [{"role": "assistant", "content": raw}]
        accepted.append(_example(
            full_messages, {"user_text": user_text, "output": raw}, "accepted", None,
        ))

        if spot_check_every and accepted_count % spot_check_every == 0:
            review_queue.append({
                "family": family_id,
                "pipeline": pipeline,
                "reason": "spot_check",
                "user_text": user_text,
                "output": raw,
            })
        accepted_count += 1

    return accepted, rejected, review_queue


# ---------------------------------------------------------------------------
# Real Tinker-backed teacher (never called in tests / at import time).
# ---------------------------------------------------------------------------

class TinkerProseTeacher:
    """Real Tinker-backed teacher client for prose synthesis, using the same
    SDK patterns as tantular/finetune/spike/train_sentinel.py,
    gen_router.TinkerRouterTeacher, and gen_edit.TinkerEditTeacher (teacher
    model Qwen/Qwen3.5-397B-A17B, renderer qwen3_5_disable_thinking).

    All `tinker` / `tinker_cookbook` imports are lazy (inside `_ensure_ready`
    and `sample`), so constructing this class -- and importing this module --
    never touches Tinker or spends anything. Tests inject a deterministic
    stub with a `.sample(messages) -> str` method instead of this class.
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
            self._sampling_params = tinker.SamplingParams(
                max_tokens=1024, temperature=0.7, top_p=0.9
            )

    def sample(self, messages):
        """messages: list of {"role", "content"} dicts. Returns decoded
        assistant-turn text."""
        self._ensure_ready()
        prompt = self._renderer.build_generation_prompt(messages, role="assistant")
        result = self._sampling_client.sample(
            prompt=prompt, num_samples=1, sampling_params=self._sampling_params
        ).result()
        out_tokens = result.sequences[0].tokens
        return self._tokenizer.decode(out_tokens)
