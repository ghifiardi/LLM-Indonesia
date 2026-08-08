import pathlib

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import assign_splits, enumerate_families, split_of
from tantular.finetune.gen_edit import (
    FALLBACK_SUBTYPES,
    SYNTHESIS_PROMPT_HASH,
    SYNTHESIZABLE_SUBTYPES,
    _hash_constants,
    accept_edit,
    generate_edit,
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


def _family(subtype, split="train", idx=0):
    return {"id": f"edit:{subtype}::{idx:04d}", "kind": f"edit:{subtype}", "split": split}


# --- Step 1 brief tests, verbatim -------------------------------------------

def test_reconstruction_gate():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, _ = accept_edit(bc, "Pendapatan naik.", "Pendapatan meningkat.",
                            [{"find": "naik", "replace": "meningkat", "occurrence": 1}])
        assert ok
        bad, reason = accept_edit(bc, "Pendapatan naik.", "Pendapatan meningkat.",
                            [{"find": "naik", "replace": "turun", "occurrence": 1}])
        assert not bad  # reconstructs "Pendapatan turun." != expected


def test_noop_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(bc, "abc", "abc", [{"find": "abc", "replace": "abc", "occurrence": 1}])
        assert not ok and reason == "no_op"


# --- accept_edit: semantic guards, all via the real bridge oracle -----------

def test_excessive_deletion_rejected_without_license():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "Laporan lengkap tahun ini.", "Laporan.",
            [{"find": "lengkap tahun ini", "replace": "", "occurrence": 1}],
        )
        assert not ok and reason == "excessive_deletion"


def test_excessive_deletion_allowed_with_omission_license():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "Laporan lengkap tahun ini.", "Laporan.",
            [{"find": " lengkap tahun ini", "replace": "", "occurrence": 1}],
            instruction="Ringkas kalimat ini menjadi lebih singkat.",
        )
        assert ok, reason


def test_name_number_altered_rejected_without_license():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "Pendapatan naik 12 persen.", "Pendapatan naik 20 persen.",
            [{"find": "12", "replace": "20", "occurrence": 1}],
        )
        assert not ok and reason == "name_number_altered"


def test_name_number_altered_allowed_with_number_license():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "Pendapatan naik 12 persen.", "Pendapatan naik 20 persen.",
            [{"find": "12", "replace": "20", "occurrence": 1}],
            instruction='Angka yang benar adalah "20", bukan "12". Perbaiki angka yang salah.',
        )
        assert ok, reason


def test_instruction_mismatch_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        # Instruction declares a spelling-category fix (cue "ejaan"), but the
        # actual edit is a pure word-order swap -- the two are inconsistent.
        ok, reason = accept_edit(
            bc, "Tim akan segera berangkat.", "Tim segera akan berangkat.",
            [{"find": "akan segera", "replace": "segera akan", "occurrence": 1}],
            instruction="Perbaiki ejaan kata yang salah pada kalimat ini.",
        )
        assert not ok and reason == "instruction_mismatch"


def test_overlapping_edits_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "abcdef", "xyzdef",
            [
                {"find": "abc", "replace": "xy", "occurrence": 1},
                {"find": "bcd", "replace": "zz", "occurrence": 1},
            ],
        )
        assert not ok and reason == "overlapping"


def test_duplicate_target_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "abc def", "xyz def",
            [
                {"find": "abc", "replace": "xy", "occurrence": 1},
                {"find": "abc", "replace": "xyz", "occurrence": 1},
            ],
        )
        assert not ok and reason == "duplicate_target"


def test_unresolved_anchor_rejected():
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(bc, "abc", "xyz", [{"find": "not-there", "replace": "somewhere", "occurrence": 1}])
        assert not ok and reason == "unresolved_anchor"


def test_parse_error_rejected():
    # An edit with no "find" fails the real parseEditContract validation
    # (editContract.js: 'Edit #1 tidak punya "find".') -> parse.ok is False.
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(
            bc, "abc def", "xyz def",
            [{"find": "", "replace": "xyz", "occurrence": 1}],
        )
        assert not ok and reason == "parse_error"


def test_apply_failed_rejected():
    # Two non-overlapping, independently-resolvable edits (per resolveEdits,
    # which locates each edit against the ORIGINAL text) where applying the
    # first edit sequentially (applyEditsToText re-locates each edit against
    # the progressively-updated text) invalidates the second edit's anchor:
    # edit1 rewrites "operasional" -> "IT", which is inside the 60-char
    # before-context window edit2's anchor depends on to disambiguate the
    # second "laporan" from the first. Real bridge, verified deterministic:
    # resolve has no errors/duplicates/overlap, but apply's perEditStatus is
    # ["applied", "skipped"].
    doc = (
        "Departemen keuangan menyampaikan laporan bulanan. "
        "Departemen operasional menyampaikan laporan mingguan."
    )
    edits = [
        {"find": "operasional", "replace": "digital", "occurrence": 1},
        {"find": "laporan", "replace": "dokumen", "occurrence": 1,
         "before": "operasional menyampaikan "},
    ]
    with BridgeClient(str(BRIDGE)) as bc:
        ok, reason = accept_edit(bc, doc, "irrelevant expected text", edits)
        assert not ok and reason == "apply_failed"


# --- generate_edit: synthesizable path (known-target reconstruction) --------

def test_generate_edit_accepts_koreksi_when_teacher_reconstructs_target():
    family = _family("koreksi")
    assert SYNTHESIZABLE_SUBTYPES[family["kind"].split(":", 1)[1]] == "spelling"

    # Discover exactly what corruption gen_edit will produce for i=0, so the
    # stub teacher can emit an edit that reconstructs the known clean target.
    from tantular.finetune.gen_edit import _corrupt_spelling, _pick_target, _rng_for
    target = _pick_target(family["id"], 0)
    corrupted_text, instruction = _corrupt_spelling(target, _rng_for(family["id"], 0))

    # Find the corrupted word (the one differing from the clean target).
    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    clean_word, typo_word = diffs[0]

    edit_json = f'{{"edits":[{{"find":"{typo_word}","replace":"{clean_word}","occurrence":1}}]}}'
    sampler = FixedSampler(edit_json)

    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT",
        )

    assert review_queue == []
    assert rejected == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["task"] == "edit"
    assert ex["split"] == "train"
    assert ex["provenance"]["status"] == "accepted"
    assert ex["payload"]["target_text"] == target["text"]
    assert ex["messages"][0]["content"] == "EDIT SYSTEM PROMPT TEXT"
    assert ex["messages"][-1]["role"] == "assistant"


def test_generate_edit_accepts_ubah_istilah_terminology_substitution():
    # ubah_istilah is a faithful terminology substitution (families.py:
    # "terminology/name/number-preserving substitution"), not a number/name
    # corruption: the clean target uses the canonical term ("laporan"), the
    # corrupted doc uses a documented synonym ("dokumen"), and the licensed
    # edit substitutes synonym -> canonical. Names/numbers are untouched.
    family = _family("ubah_istilah")
    assert SYNTHESIZABLE_SUBTYPES[family["kind"].split(":", 1)[1]] == "terminology"

    from tantular.finetune.gen_edit import _corrupt_terminology, _pick_target, _rng_for
    target = _pick_target(family["id"], 0)
    corrupted_text, instruction = _corrupt_terminology(target, _rng_for(family["id"], 0))
    assert corrupted_text != target["text"]

    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    assert len(diffs) == 1
    clean_word, synonym_word = diffs[0]

    edit_json = f'{{"edits":[{{"find":"{synonym_word}","replace":"{clean_word}","occurrence":1}}]}}'
    sampler = FixedSampler(edit_json)

    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT",
        )

    assert review_queue == []
    assert rejected == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["payload"]["target_text"] == target["text"]
    assert ex["payload"]["corruption_category"] == "terminology"


def test_generate_edit_retries_then_discards_to_rejected():
    family = _family("koreksi")
    # Teacher always emits an edit that does NOT reconstruct the target
    # (wrong replacement), every retry -- must be discarded to rejected.
    sampler = FixedSampler('{"edits":[{"find":"x-not-in-doc","replace":"y","occurrence":1}]}')

    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT", max_retries=2,
        )

    assert accepted == []
    assert review_queue == []
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["status"] == "rejected"
    # Retried exactly max_retries times before discarding.
    assert len(sampler.calls) == 2


def test_generate_edit_requires_resolved_split():
    family = {"id": "edit:koreksi::0000", "kind": "edit:koreksi", "split": None}
    sampler = FixedSampler("irrelevant")
    with BridgeClient(str(BRIDGE)) as bc:
        try:
            generate_edit(sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT")
            assert False, "expected ValueError for unresolved split"
        except ValueError as e:
            assert "split" in str(e)


# --- generate_edit: fallback path (no synthesizable target) -----------------

def test_generate_edit_fallback_subtypes_never_auto_accept():
    from tantular.finetune.gen_edit import _pick_target

    for subtype in FALLBACK_SUBTYPES:
        family = _family(subtype)
        target = _pick_target(family["id"], 0)
        # A lowercase, non-sentence-initial word, so the name/number guard
        # never fires on capitalization alone.
        word = target["text"].split()[1].rstrip(".,")
        # ringkas_bagian declares an "omission" (shortening) category via the
        # "Ringkas" cue; the other fallback subtypes have no declared
        # category cue, so any non-degenerate edit passes instruction_mismatch.
        replacement = "x" if subtype == "ringkas_bagian" else f"{word} secara rinci"
        edit_json = (
            f'{{"edits":[{{"find":"{word}",'
            f'"replace":"{replacement}","occurrence":1}}]}}'
        )
        sampler = FixedSampler(edit_json)
        judged = []

        def judge(source, instruction, produced):
            judged.append((source, instruction, produced))
            return "plausible"

        with BridgeClient(str(BRIDGE)) as bc:
            accepted, rejected, review_queue = generate_edit(
                sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT", judge=judge,
            )

        assert accepted == [], f"{subtype} must never auto-accept"
        assert len(review_queue) == 1, subtype
        item = review_queue[0]
        assert item["reason"] == "no_synthesizable_target"
        assert item["judge_verdict"] == "plausible"
        assert len(judged) == 1


def test_generate_edit_fallback_rejects_invalid_teacher_json():
    family = _family("perjelas")
    sampler = FixedSampler("not json at all")
    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT",
        )
    assert accepted == []
    assert review_queue == []
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["reject_reason"] == "teacher_json_invalid"


# --- integration: real production edit prompt + real split resolution ------

def test_generate_edit_carries_production_edit_prompt_via_bridge():
    families = enumerate_families(instances_per_kind=2)
    assignments = assign_splits(families, seed=1)
    koreksi = next(f for f in families if f["kind"] == "edit:koreksi")
    resolved_split = split_of(koreksi["id"], assignments)
    family = {**koreksi, "split": resolved_split}

    from tantular.finetune.gen_edit import _corrupt_spelling, _pick_target, _rng_for
    target = _pick_target(family["id"], 0)
    corrupted_text, instruction = _corrupt_spelling(target, _rng_for(family["id"], 0))
    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    clean_word, typo_word = diffs[0]
    edit_json = f'{{"edits":[{{"find":"{typo_word}","replace":"{clean_word}","occurrence":1}}]}}'

    with BridgeClient(str(BRIDGE)) as bc:
        prompts = bc.dump_prompts()
        edit_prompt = next(p for p in prompts if p["id"] == "edit")

        sampler = FixedSampler(edit_json)
        accepted, rejected, review_queue = generate_edit(
            sampler,
            bc,
            family,
            1,
            edit_prompt["content"],
            bridge_protocol_version=bc.ready["protocol_version"],
            bridge_js_commit=bc.ready["js_commit"],
            production_prompt_content_hash=edit_prompt["contentHash"],
        )

    assert rejected == []
    assert review_queue == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["messages"][0]["content"] == edit_prompt["content"]
    assert ex["provenance"]["production_prompt_content_hash"] == edit_prompt["contentHash"]
    assert ex["provenance"]["generation"]["bridge_js_commit"] == bc.ready["js_commit"]
    assert ex["split"] == resolved_split


# --- synthesis_prompt_hash / judge_prompt_hash provenance (spec: "Provenance-
# tracked example schema") -----------------------------------------------

def test_synthesis_prompt_hash_is_64_char_hex():
    assert isinstance(SYNTHESIS_PROMPT_HASH, str) and len(SYNTHESIS_PROMPT_HASH) == 64
    int(SYNTHESIS_PROMPT_HASH, 16)  # raises ValueError if not hex


def test_synthesis_and_caller_supplied_judge_prompt_hash_appear_in_provenance():
    from tantular.finetune.gen_edit import _corrupt_spelling, _pick_target, _rng_for

    family = _family("koreksi")
    target = _pick_target(family["id"], 0)
    corrupted_text, instruction = _corrupt_spelling(target, _rng_for(family["id"], 0))
    clean_words = target["text"].split()
    corrupt_words = corrupted_text.split()
    diffs = [(w, c) for w, c in zip(clean_words, corrupt_words) if w != c]
    clean_word, typo_word = diffs[0]
    edit_json = f'{{"edits":[{{"find":"{typo_word}","replace":"{clean_word}","occurrence":1}}]}}'
    sampler = FixedSampler(edit_json)

    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT",
            judge_prompt_hash="caller-supplied-judge-hash",
        )

    assert len(accepted) == 1
    generation = accepted[0]["provenance"]["generation"]
    assert generation["synthesis_prompt_hash"] == SYNTHESIS_PROMPT_HASH
    # This module owns no judge PROMPT template of its own (see gen_edit.py
    # comments next to `SYNTHESIS_PROMPT_HASH`): the caller-supplied value is
    # recorded verbatim.
    assert generation["judge_prompt_hash"] == "caller-supplied-judge-hash"


def test_judge_prompt_hash_defaults_to_none():
    family = _family("koreksi")
    sampler = FixedSampler('{"edits":[{"find":"x-not-in-doc","replace":"y","occurrence":1}]}')
    with BridgeClient(str(BRIDGE)) as bc:
        accepted, rejected, review_queue = generate_edit(
            sampler, bc, family, 1, "EDIT SYSTEM PROMPT TEXT", max_retries=1,
        )
    assert len(rejected) == 1
    assert rejected[0]["provenance"]["generation"]["judge_prompt_hash"] is None


def test_hash_constants_changes_when_a_synthesis_constant_changes():
    original = _hash_constants({"term_pairs": {"pelanggan": "konsumen"}})
    modified = _hash_constants({"term_pairs": {"pelanggan": "nasabah"}})
    assert original != modified
    # Sanity: hashing the same object twice is stable.
    assert original == _hash_constants({"term_pairs": {"pelanggan": "konsumen"}})
