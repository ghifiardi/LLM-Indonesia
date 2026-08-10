import pathlib

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.dedup import near_duplicates
from tantular.finetune.families import assign_splits, enumerate_families, split_of
from tantular.finetune.gen_prose import (
    PROSE_PIPELINES,
    PROSE_PROMPT_IDS,
    SYNTHESIS_PROMPT_HASH,
    _hash_constants,
    accept_prose,
    format_ok,
    generate_prose,
    has_cjk,
    within_length,
)

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"


class FixedSampler:
    """Deterministic stub teacher (never touches Tinker): if `value` is a
    list, pops one response per call (last one repeats once exhausted);
    otherwise returns the same value every call. Records every call's
    messages for inspection.
    """

    def __init__(self, value):
        self.value = value
        self.calls = []

    def sample(self, messages):
        self.calls.append(messages)
        if isinstance(self.value, list):
            idx = min(len(self.calls) - 1, len(self.value) - 1)
            return self.value[idx]
        return self.value


# --- Step 1 brief tests, verbatim -------------------------------------------

def test_cjk_zero_tolerance():
    assert has_cjk("ringkasan 摘要")
    assert not has_cjk("ringkasan biasa")
    ok, reason = accept_prose("prose:ringkas", "- poin 摘要")
    assert not ok and reason == "cjk_leakage"


def test_bullet_format():
    assert format_ok("prose:ringkas", "- satu\n- dua")
    assert not format_ok("prose:ringkas", "1. satu")


# --- has_cjk / format_ok / within_length: additional coverage --------------

def test_has_cjk_false_on_empty_and_ascii():
    assert not has_cjk("")
    assert not has_cjk("Hello, apa kabar? 123.")


def test_has_cjk_detects_hiragana_katakana():
    assert has_cjk("ようこそ")  # Hiragana
    assert has_cjk("コンニチハ")  # Katakana
    assert not has_cjk("konnichiwa")


def test_has_cjk_detects_hangul():
    assert has_cjk("안녕하세요")
    assert not has_cjk("annyeonghaseyo")


def test_format_ok_cek_aman_requires_risk_label():
    assert format_ok("prose:cekAman", "🛑 Risiko tinggi: jangan bagikan OTP.")
    assert format_ok("prose:cekAman", "⚠️ Perlu dicek lebih lanjut.")
    assert format_ok("prose:cekAman", "✅ Aman, tidak ada indikator penipuan.")
    assert not format_ok("prose:cekAman", "Ini terlihat aman-aman saja.")


def test_format_ok_free_form_pipelines_reject_json_wrapper():
    for name in ("umum", "ubahNada", "terjemah", "draftTeks", "tanyaDokumen"):
        assert format_ok(f"prose:{name}", "Ini jawaban biasa dalam Bahasa Indonesia.")
        assert not format_ok(f"prose:{name}", '{"answer": "x"}')
        assert not format_ok(f"prose:{name}", '["a", "b"]')


def test_format_ok_rejects_empty_text_for_every_pipeline():
    for prompt_id in PROSE_PROMPT_IDS:
        assert not format_ok(prompt_id, "")
        assert not format_ok(prompt_id, "   ")


def test_within_length_bounds_per_pipeline():
    assert within_length("prose:ringkas", "- " + ("a" * 20))
    assert not within_length("prose:ringkas", "- x")  # too short
    assert not within_length("prose:ringkas", "- " + ("a" * 2000))  # too long


def test_accept_prose_bare_pipeline_name_also_accepted():
    ok, reason = accept_prose("ringkas", "- satu\n- dua\n- tiga poin panjang cukup")
    assert ok and reason is None


def test_accept_prose_length_reason():
    ok, reason = accept_prose("prose:umum", "x")  # too short
    assert not ok and reason == "length_invalid"


# --- terjemah / draftTeks commentary-wrapper rejection (IMPORTANT-2) -------

def test_format_ok_terjemah_rejects_leading_commentary():
    assert format_ok("prose:terjemah", "Company revenue increased by 12 percent.")
    assert not format_ok(
        "prose:terjemah",
        "Berikut terjemahannya: Company revenue increased by 12 percent.",
    )
    assert not format_ok(
        "prose:terjemah",
        "Tentu, ini terjemahannya: Company revenue increased by 12 percent.",
    )
    assert not format_ok(
        "prose:terjemah",
        "Terjemahan: Company revenue increased by 12 percent.",
    )


def test_format_ok_terjemah_rejects_trailing_translator_note():
    assert not format_ok(
        "prose:terjemah",
        "Company revenue increased by 12 percent. (catatan: istilah 'kuartal' "
        "diterjemahkan sebagai 'quarter')",
    )


def test_format_ok_draft_teks_rejects_commentary_wrapper():
    assert format_ok("prose:draftTeks", "Kepada seluruh tim, jam kerja berubah mulai bulan depan.")
    assert not format_ok(
        "prose:draftTeks",
        "Ini adalah draf memo yang Anda minta: Kepada seluruh tim, jam kerja berubah.",
    )
    assert not format_ok(
        "prose:draftTeks",
        "Baik, berikut draf memonya untuk tim internal.",
    )


def test_format_ok_commentary_check_scoped_to_terjemah_and_draft_teks():
    # Other free-form pipelines only get the JSON/array wrapper check, not
    # the commentary-wrapper heuristic.
    for name in ("umum", "ubahNada", "tanyaDokumen"):
        assert format_ok(f"prose:{name}", "Baik, ini jawabannya secara lengkap.")


# --- generate_prose: gating behavior ----------------------------------------

def _family(pipeline, split="train", idx=0):
    return {"id": f"prose:{pipeline}::{idx:04d}", "kind": f"prose:{pipeline}", "split": split}


def test_generate_prose_accepts_valid_candidate():
    synth = FixedSampler("- poin pertama tentang laporan\n- poin kedua tentang efisiensi")
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert rejected == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["task"] == "prose:ringkas"
    assert ex["split"] == "train"
    assert ex["family"] == "prose:ringkas::0000"
    assert ex["provenance"]["status"] == "accepted"
    assert ex["provenance"]["prompt_id"] == "prose:ringkas"
    assert ex["messages"][0] == {"role": "system", "content": "RINGKAS SYSTEM PROMPT TEXT"}
    assert ex["messages"][-1] == {
        "role": "assistant",
        "content": "- poin pertama tentang laporan\n- poin kedua tentang efisiensi",
    }
    # First accepted candidate is always spot-checked (spot_check_every default).
    assert len(review_queue) == 1
    assert review_queue[0]["reason"] == "spot_check"


def test_generate_prose_rejects_cjk_leakage():
    synth = FixedSampler("- poin pertama 摘要\n- poin kedua biasa saja")
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert accepted == []
    assert review_queue == []
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "cjk_leakage"
    assert rejected[0]["provenance"]["status"] == "rejected"


def test_generate_prose_rejects_bad_format():
    synth = FixedSampler("1. bukan bullet markdown")
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert accepted == []
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "format_invalid"


def test_generate_prose_rejects_length_violation():
    synth = FixedSampler("- x")  # too short for "ringkas"
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert accepted == []
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "length_invalid"


def test_generate_prose_ringkas_seed_elicits_bullet_format():
    # IMPORTANT-1: the bullet-format rule is elicited in the synthesis USER
    # turn, never injected into the production system prompt.
    synth = FixedSampler("- poin pertama tentang laporan\n- poin kedua tentang efisiensi")
    generate_prose(synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT")
    assert synth.calls[0][0] == {"role": "system", "content": "RINGKAS SYSTEM PROMPT TEXT"}
    user_text = synth.calls[0][1]["content"]
    assert "bullet Markdown yang diawali '- '" in user_text


def test_generate_prose_cek_aman_seed_elicits_risk_label():
    synth = FixedSampler("⚠️ Perlu dicek lebih lanjut, jangan bagikan data pribadi.")
    generate_prose(synth, _family("cekAman"), 1, "CEKAMAN SYSTEM PROMPT TEXT")
    assert synth.calls[0][0] == {"role": "system", "content": "CEKAMAN SYSTEM PROMPT TEXT"}
    user_text = synth.calls[0][1]["content"]
    assert "🛑, ⚠️, atau ✅" in user_text


def test_generate_prose_other_pipelines_seed_has_no_format_suffix():
    synth = FixedSampler("Jawaban biasa dalam Bahasa Indonesia yang cukup panjang.")
    generate_prose(synth, _family("umum"), 1, "UMUM SYSTEM PROMPT TEXT")
    user_text = synth.calls[0][1]["content"]
    assert "Format:" not in user_text
    assert "🛑" not in user_text


def test_generate_prose_cjk_leakage_takes_priority_over_near_duplicate():
    # MINOR-4: accept_prose filters (CJK/format/length) run before dedup, so
    # a CJK-tainted near-duplicate is rejected for the more fundamental
    # reason, not "near_duplicate".
    synth = FixedSampler([
        "- poin pertama tentang efisiensi biaya operasional perusahaan",
        "- poin pertama tentang efisiensi biaya operasional perusahaan 摘要",
    ])
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 2, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert len(accepted) == 1
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "cjk_leakage"


def test_generate_prose_rejects_near_duplicates_within_batch():
    synth = FixedSampler([
        "- poin pertama tentang efisiensi biaya",
        "- poin pertama tentang efisiensi biaya!",  # near-identical
        "- topik yang sama sekali berbeda dan panjang cukup",
    ])
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 3, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert len(accepted) == 2
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "near_duplicate"
    # near_duplicates directly confirms which index within the raw batch was
    # flagged, matching generate_prose's own dedup pass.
    assert 1 in near_duplicates([
        "- poin pertama tentang efisiensi biaya",
        "- poin pertama tentang efisiensi biaya!",
        "- topik yang sama sekali berbeda dan panjang cukup",
    ], threshold=0.8)


# --- Fix B: widened seed banks for near-deterministic pipelines ------------
# terjemah/ringkas/tanyaDokumen are near-deterministic tasks (translate/
# summarize/answer over a FIXED source text) -- with only a 2-seed bank, a
# 10-candidate pilot batch collided on the same seed repeatedly, and the
# teacher's near-identical repeat-seed output then failed `near_duplicates`
# (confirmed live: 8/10, 8/10, 6/10 rejects for these three pipelines were
# ALL "near_duplicate", not commentary/format/length -- see
# .superpowers/sdd/fix-b-probe.md). Pinning the widened bank size here so a
# future edit can't silently shrink it back to a collision-prone 2 seeds.

import tantular.finetune.gen_prose as gen_prose_mod


def test_seed_banks_widened_for_near_deterministic_pipelines():
    for name in ("terjemah", "ringkas", "tanyaDokumen"):
        assert len(gen_prose_mod._SEEDS[name]) >= 6, (
            f"{name}: seed bank too small -- near-deterministic pipelines "
            "need enough distinct seeds to keep same-seed collisions (and "
            "the resulting near_duplicate rejects) rare in a 10-candidate "
            "batch"
        )


def test_pick_seed_distributes_across_wider_terjemah_bank():
    # With 6 seeds and 10 draws, at least half the picks across a range of
    # family ids/indices must land on more than 2 distinct seeds (loosely
    # pins "wider distribution", without over-fitting to the exact hash
    # distribution).
    seen = {
        gen_prose_mod._pick_seed("terjemah", "prose:terjemah::probe", i)
        for i in range(10)
    }
    assert len(seen) > 2


def test_generate_prose_spot_check_every_n_accepted():
    # Six distinct valid completions -- distinct so none is flagged as a
    # near-duplicate of another within the batch, isolating the spot-check
    # sampling behavior from the dedup gate.
    topics = [
        "efisiensi biaya operasional",
        "peluncuran produk baru bulan depan",
        "evaluasi kinerja tim penjualan",
        "rencana perjalanan dinas ke cabang",
        "audit keuangan tahunan perusahaan",
        "pelatihan karyawan baru minggu ini",
    ]
    synth = FixedSampler([
        f"- poin pertama tentang {topic}\n- poin kedua soal {topic} secara ringkas"
        for topic in topics
    ])
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 6, "RINGKAS SYSTEM PROMPT TEXT", spot_check_every=2
    )
    assert len(accepted) == 6
    assert rejected == []
    # accepted indices 0, 2, 4 (0-indexed among accepted) get spot-checked.
    assert len(review_queue) == 3


def test_generate_prose_requires_resolved_split():
    synth = FixedSampler("- poin pertama\n- poin kedua panjang cukup untuk lolos")
    family = {"id": "prose:ringkas::0000", "kind": "prose:ringkas", "split": None}
    try:
        generate_prose(synth, family, 1, "RINGKAS SYSTEM PROMPT TEXT")
        assert False, "expected ValueError for unresolved split"
    except ValueError as e:
        assert "split" in str(e)


def test_generate_prose_rejects_unknown_pipeline_kind():
    synth = FixedSampler("apapun")
    family = {"id": "prose:notreal::0000", "kind": "prose:notreal", "split": "train"}
    try:
        generate_prose(synth, family, 1, "SYSTEM PROMPT")
        assert False, "expected ValueError for unknown pipeline"
    except ValueError as e:
        assert "notreal" in str(e)


def test_generate_prose_rejects_non_prose_family_kind():
    synth = FixedSampler("apapun")
    family = {"id": "router:UMUM::0000", "kind": "router:UMUM", "split": "train"}
    try:
        generate_prose(synth, family, 1, "SYSTEM PROMPT")
        assert False, "expected ValueError for non-prose family kind"
    except ValueError as e:
        assert "prose" in str(e)


# --- integration: real production prose prompts + real split resolution ----

def test_generate_prose_carries_production_prompt_via_bridge_for_every_pipeline():
    families = enumerate_families(instances_per_kind=2)
    assignments = assign_splits(families, seed=1)

    with BridgeClient(str(BRIDGE)) as bc:
        prompts = {p["id"]: p for p in bc.dump_prompts()}
        assert set(PROSE_PROMPT_IDS) <= set(prompts.keys())

        for pipeline in PROSE_PIPELINES:
            fam = next(f for f in families if f["kind"] == f"prose:{pipeline}")
            resolved_split = split_of(fam["id"], assignments)
            family = {**fam, "split": resolved_split}
            prompt = prompts[f"prose:{pipeline}"]

            synth = FixedSampler(_valid_completion_for(pipeline))
            accepted, rejected, review_queue = generate_prose(
                synth,
                family,
                1,
                prompt["content"],
                bridge_protocol_version=bc.ready["protocol_version"],
                bridge_js_commit=bc.ready["js_commit"],
                production_prompt_content_hash=prompt["contentHash"],
            )

            assert rejected == [], f"{pipeline}: unexpected rejection {rejected}"
            assert len(accepted) == 1
            ex = accepted[0]
            assert ex["messages"][0]["content"] == prompt["content"]
            assert ex["provenance"]["production_prompt_content_hash"] == prompt["contentHash"]
            assert ex["provenance"]["generation"]["bridge_js_commit"] == bc.ready["js_commit"]
            assert ex["split"] == resolved_split


# --- synthesis_prompt_hash / judge_prompt_hash provenance (spec: "Provenance-
# tracked example schema") -----------------------------------------------

def test_synthesis_prompt_hash_is_64_char_hex():
    assert isinstance(SYNTHESIS_PROMPT_HASH, str) and len(SYNTHESIS_PROMPT_HASH) == 64
    int(SYNTHESIS_PROMPT_HASH, 16)  # raises ValueError if not hex


def test_synthesis_prompt_hash_appears_in_accepted_provenance():
    synth = FixedSampler("- poin pertama tentang laporan\n- poin kedua tentang efisiensi")
    accepted, rejected, review_queue = generate_prose(
        synth, _family("ringkas"), 1, "RINGKAS SYSTEM PROMPT TEXT"
    )
    assert len(accepted) == 1
    generation = accepted[0]["provenance"]["generation"]
    assert generation["synthesis_prompt_hash"] == SYNTHESIS_PROMPT_HASH
    # No judge template exists in this module (see gen_prose.py comments next
    # to `JUDGE_PROMPT_HASH`) -- always recorded as None.
    assert generation["judge_prompt_hash"] is None


def test_hash_constants_changes_when_a_synthesis_constant_changes():
    original = _hash_constants({"seeds": {"umum": (("a", "b"),)}, "format_suffixes": {}})
    modified = _hash_constants({"seeds": {"umum": (("a", "c"),)}, "format_suffixes": {}})
    assert original != modified
    # Sanity: hashing the same object twice is stable.
    assert original == _hash_constants({"seeds": {"umum": (("a", "b"),)}, "format_suffixes": {}})


# --- D2 (ft-fixD): strip trailing <|im_end|> from TinkerProseTeacher.sample()

from tantular.finetune.gen_prose import TinkerProseTeacher, _strip_trailing_chat_terminator


def test_strip_trailing_chat_terminator_removes_trailing_im_end():
    assert _strip_trailing_chat_terminator("Jawaban singkat.<|im_end|>") == "Jawaban singkat."


def test_strip_trailing_chat_terminator_removes_surrounding_whitespace():
    assert _strip_trailing_chat_terminator("Jawaban singkat.  <|im_end|>  \n") == "Jawaban singkat."


def test_strip_trailing_chat_terminator_handles_repeated_trailing_terminators():
    assert _strip_trailing_chat_terminator(
        "Jawaban singkat.<|im_end|> <|im_end|>"
    ) == "Jawaban singkat."


def test_strip_trailing_chat_terminator_leaves_mid_text_occurrence_untouched():
    # A terminator that is NOT trailing (e.g. quoted mid-text in sampled
    # prose) must never be stripped -- only a trailing terminator is a
    # chat-template artifact; a mid-text one is part of the actual content.
    text = 'Contoh token adalah "<|im_end|>" dalam dokumentasi model.'
    assert _strip_trailing_chat_terminator(text) == text


def test_strip_trailing_chat_terminator_noop_when_absent():
    assert _strip_trailing_chat_terminator("Jawaban singkat tanpa token apa pun.") == \
        "Jawaban singkat tanpa token apa pun."


class _StubRenderer:
    def build_generation_prompt(self, messages, role):
        return ("stub-prompt", messages, role)


class _StubResult:
    def __init__(self, tokens):
        self.sequences = [type("Seq", (), {"tokens": tokens})()]

    def result(self):
        return self


class _StubSamplingClient:
    def __init__(self, tokens):
        self._tokens = tokens

    def sample(self, prompt, num_samples, sampling_params):
        return _StubResult(self._tokens)


class _StubTokenizer:
    def __init__(self, decoded):
        self._decoded = decoded

    def decode(self, tokens):
        return self._decoded


def _teacher_with_stubbed_raw_sample(raw_text):
    """Construct a TinkerProseTeacher with its Tinker-facing internals
    pre-populated by stubs, so `.sample()` never touches the real
    `tinker`/`tinker_cookbook` SDK (no network, no Tinker API call) --
    `_ensure_ready` short-circuits because `_sampling_client` is already set.
    """
    teacher = TinkerProseTeacher()
    teacher._sampling_client = _StubSamplingClient(tokens=[1, 2, 3])
    teacher._tokenizer = _StubTokenizer(decoded=raw_text)
    teacher._renderer = _StubRenderer()
    teacher._sampling_params = object()
    return teacher


def test_tinker_prose_teacher_sample_strips_trailing_im_end():
    teacher = _teacher_with_stubbed_raw_sample("Jawaban dari model.<|im_end|>")
    out = teacher.sample([{"role": "user", "content": "halo"}])
    assert out == "Jawaban dari model."
    assert "<|im_end|>" not in out


def test_tinker_prose_teacher_sample_preserves_mid_text_token():
    raw = 'Model menjelaskan token "<|im_end|>" sebagai penanda akhir giliran.'
    teacher = _teacher_with_stubbed_raw_sample(raw)
    out = teacher.sample([{"role": "user", "content": "halo"}])
    assert out == raw


def _valid_completion_for(pipeline):
    if pipeline == "ringkas":
        return "- poin pertama yang cukup panjang\n- poin kedua yang cukup panjang juga"
    if pipeline == "cekAman":
        return "⚠️ Perlu dicek: pesan ini meminta kode OTP, jangan dibagikan ke siapa pun."
    return "Jawaban singkat dalam Bahasa Indonesia yang cukup panjang untuk lolos filter."
