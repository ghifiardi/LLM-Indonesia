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

Hard-format compliance is pipeline-specific, mirrored from what each
pipeline's production prompt actually asks for (not reimplemented parsing --
just a light regex/structural check, same spirit as gen_router.py's
`is_ambiguous` heuristic):
- "prose:ringkas" (tantular_office_addin/src/prompts.js ACTIONS.word_summarize):
  "Format wajib: bullet Markdown yang diawali '- '" -- every non-empty line
  must start with "- ".
- "prose:cekAman" (tantular_office_addin/src/prompts.js safetySystem()): the
  scam-check output is expected to lead with one of the three risk labels
  (🛑 / ⚠️ / ✅) -- the one place among these 7 pipelines with something like
  a closed, near-single-token vocabulary at the START of the response (the
  brief's "single-word where required"; none of the other 6 pipelines are
  free of natural-language prose, so no other pipeline gets a single-word
  rule here).
- The remaining 5 pipelines (umum, ubahNada, terjemah, draftTeks,
  tanyaDokumen) are free-form Indonesian prose; their production system
  prompts explicitly forbid an unrequested JSON/array wrapper ("Jangan
  gunakan JSON atau array kecuali ..."), so `format_ok` for them rejects
  output that begins with "{" or "[".

Teacher access is always injected (constructor/function parameter) -- this
module never calls Tinker at import time, and tests only ever pass a
deterministic stub. `TinkerProseTeacher` is a real implementation, but all
`tinker`/`tinker_cookbook` imports inside it are lazy (inside methods), so
merely importing this module, or constructing a `TinkerProseTeacher`, costs
nothing and touches no network.
"""

import hashlib
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
    return not stripped.startswith(("{", "["))


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


def _build_user_message(name, seed):
    context_text, instruction = seed
    if context_text is None:
        return instruction
    return f'Teks:\n"""{context_text}"""\n\n{instruction}'


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

    dup_indices = near_duplicates([raw for _, _, raw in candidates], threshold=dedup_threshold)

    accepted, rejected, review_queue = [], [], []
    accepted_count = 0

    for i, (messages, user_text, raw) in enumerate(candidates):
        if i in dup_indices:
            rejected.append(_example(
                messages, {"user_text": user_text, "output": raw}, "rejected", "near_duplicate",
            ))
            continue

        ok, reason = accept_prose(pipeline, raw)
        if not ok:
            rejected.append(_example(
                messages, {"user_text": user_text, "output": raw}, "rejected", reason,
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
