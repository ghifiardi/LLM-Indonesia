import json
import pathlib
import random
import re

import pytest

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import PROSE_PIPELINES, ROUTER_INTENTS
from tantular.finetune.gen_edit import SYNTHESIZABLE_SUBTYPES
from tantular.finetune.dedup import DEFAULT_THRESHOLD as DEFAULT_DEDUP_THRESHOLD
from tantular.finetune.generate import (
    DEFAULT_AVG_TOKENS_BY_AXIS,
    EXPOSURE_TARGETS,
    BudgetExceeded,
    VerifyError,
    _apply_global_dedup,
    _augment_review_entries,
    _build_family_pool,
    _distribute_evenly,
    _dedup_text,
    axis_of_task,
    exposure_mix,
    exposure_mix_within_tolerance,
    load_accept_rate_estimates,
    main,
    run_generate,
    target_counts_by_axis,
    verify_artifacts,
)

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"

_WORD_BANK = (
    "kopi meja hujan gunung pantai kereta bintang payung daun batu angin "
    "sungai lampu jendela awan bunga pasir salju kursi cermin"
).split()


# --- Pure-function tests ------------------------------------------------

def test_target_counts_by_axis_sums_to_target_and_matches_ratio():
    counts = target_counts_by_axis(5000, {"router": 4, "edit": 100, "prose": 300})
    assert sum(counts.values()) == pytest.approx(5000, rel=1e-6)
    total_tokens = sum(counts[a] * {"router": 4, "edit": 100, "prose": 300}[a] for a in counts)
    for axis, target_ratio in EXPOSURE_TARGETS.items():
        realized_ratio = (counts[axis] * {"router": 4, "edit": 100, "prose": 300}[axis]) / total_tokens
        assert realized_ratio == pytest.approx(target_ratio, rel=1e-6)


def test_target_counts_by_axis_equal_avg_tokens_matches_exposure_ratio_directly():
    # With equal avg-token lengths, count ratios equal the exposure ratios directly.
    counts = target_counts_by_axis(1000, {"router": 10, "edit": 10, "prose": 10})
    assert counts["router"] == pytest.approx(200, rel=1e-6)
    assert counts["edit"] == pytest.approx(400, rel=1e-6)
    assert counts["prose"] == pytest.approx(400, rel=1e-6)


def test_distribute_evenly_deterministic_remainder():
    assert _distribute_evenly(10, 3) == [4, 3, 3]
    assert _distribute_evenly(9, 3) == [3, 3, 3]
    assert _distribute_evenly(0, 3) == [0, 0, 0]
    assert _distribute_evenly(5, 0) == []


def test_axis_of_task():
    assert axis_of_task("router") == "router"
    assert axis_of_task("edit") == "edit"
    assert axis_of_task("prose:ringkas") == "prose"


def test_dedup_text_uses_user_turn_not_completion():
    example = {"messages": [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "USER TURN"},
        {"role": "assistant", "content": "EDIT_TEKS"},
    ]}
    assert _dedup_text(example) == "USER TURN"


# --- D3 (ft-fixD): cross-split dedup tiebreak -------------------------------

def _accepted_example(id_, split, user_text):
    return {
        "id": id_, "task": "edit", "family": "edit:koreksi::0000", "split": split,
        "messages": [
            {"role": "system", "content": "SYS"},
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": "OUT"},
        ],
        "provenance": {"status": "accepted", "reject_reason": None},
    }


def test_apply_global_dedup_protects_held_out_split_even_when_train_generated_first():
    # `accepted` order = generation order: the train copy appears FIRST,
    # its eval near-duplicate SECOND. A naive first-occurrence-wins dedup
    # would keep the train copy and drop eval; the policy must invert that.
    accepted = [
        _accepted_example("train-1", "train", "Laporan keuangan perusahaan tahun ini sangat baik sekali."),
        _accepted_example("eval-1", "eval", "Laporan keuangan perusahaan tahun ini sangat baik sekali."),
    ]
    kept, rejected, dedup_log = _apply_global_dedup(accepted, [], DEFAULT_DEDUP_THRESHOLD)

    assert [ex["id"] for ex in kept] == ["eval-1"]
    assert [d["id"] for d in dedup_log] == ["train-1"]
    assert len(rejected) == 1
    assert rejected[0]["id"] == "train-1"
    assert rejected[0]["provenance"]["status"] == "rejected"
    assert rejected[0]["provenance"]["reject_reason"] == "near_duplicate_global"


def test_apply_global_dedup_protects_challenge_split_too():
    accepted = [
        _accepted_example("train-1", "train", "Karyawan baru wajib mengikuti pelatihan orientasi perusahaan."),
        _accepted_example("challenge-1", "challenge", "Karyawan baru wajib mengikuti pelatihan orientasi perusahaan."),
    ]
    kept, rejected, dedup_log = _apply_global_dedup(accepted, [], DEFAULT_DEDUP_THRESHOLD)
    assert [ex["id"] for ex in kept] == ["challenge-1"]
    assert [d["id"] for d in dedup_log] == ["train-1"]


def test_apply_global_dedup_ties_within_same_split_keep_original_order():
    # Two train-split near-duplicates: no cross-split protection applies,
    # so the ORIGINAL (generation) order tiebreak still governs -- first
    # occurrence kept, exactly like plain `near_duplicates`.
    accepted = [
        _accepted_example("train-1", "train", "Pendapatan perusahaan naik dua belas persen kuartal ini."),
        _accepted_example("train-2", "train", "Pendapatan perusahaan naik dua belas persen kuartal ini."),
    ]
    kept, rejected, dedup_log = _apply_global_dedup(accepted, [], DEFAULT_DEDUP_THRESHOLD)
    assert [ex["id"] for ex in kept] == ["train-1"]
    assert [d["id"] for d in dedup_log] == ["train-2"]


def test_apply_global_dedup_ties_within_eval_split_keep_original_order():
    accepted = [
        _accepted_example("eval-1", "eval", "Siti menyampaikan hasil audit kepada tim pagi ini."),
        _accepted_example("eval-2", "eval", "Siti menyampaikan hasil audit kepada tim pagi ini."),
    ]
    kept, rejected, dedup_log = _apply_global_dedup(accepted, [], DEFAULT_DEDUP_THRESHOLD)
    assert [ex["id"] for ex in kept] == ["eval-1"]
    assert [d["id"] for d in dedup_log] == ["eval-2"]


def test_apply_global_dedup_no_duplicates_is_a_pure_noop():
    accepted = [
        _accepted_example("train-1", "train", "Target penjualan bulan ini adalah tiga ratus unit."),
        _accepted_example("eval-1", "eval", "Realisasi anggaran mencapai tujuh puluh delapan persen tahun ini."),
    ]
    kept, rejected, dedup_log = _apply_global_dedup(accepted, [], DEFAULT_DEDUP_THRESHOLD)
    assert kept == accepted
    assert rejected == []
    assert dedup_log == []


def test_apply_global_dedup_does_not_mutate_inputs_in_place():
    accepted = [
        _accepted_example("train-1", "train", "Biaya operasional turun setelah efisiensi diterapkan perusahaan."),
        _accepted_example("eval-1", "eval", "Biaya operasional turun setelah efisiensi diterapkan perusahaan."),
    ]
    original_rejected = []
    original_accepted_snapshot = [dict(ex) for ex in accepted]
    _apply_global_dedup(accepted, original_rejected, DEFAULT_DEDUP_THRESHOLD)
    assert accepted == original_accepted_snapshot
    assert original_rejected == []


def test_apply_global_dedup_empty_accepted_is_a_noop():
    kept, rejected, dedup_log = _apply_global_dedup([], ["pre-existing-reject"], DEFAULT_DEDUP_THRESHOLD)
    assert kept == []
    assert rejected == ["pre-existing-reject"]
    assert dedup_log == []


def test_exposure_mix_and_tolerance():
    counter = lambda text: len(str(text).split())
    accepted = [
        {"task": "router", "messages": [{}, {}, {"content": "a"}]},
        {"task": "edit", "messages": [{}, {}, {"content": "a b c d"}]},
        {"task": "prose:umum", "messages": [{}, {}, {"content": "a b c d e f g h"}]},
    ]
    mix = exposure_mix(accepted, counter)
    assert mix["tokens"] == {"router": 1, "edit": 4, "prose": 8}
    assert sum(mix["ratio"].values()) == pytest.approx(1.0)
    assert not exposure_mix_within_tolerance(mix["ratio"])  # far from 20/40/40


def test_exposure_mix_empty_is_zero_ratio_not_crash():
    mix = exposure_mix([], lambda t: len(t))
    assert mix["ratio"] == {"router": 0.0, "edit": 0.0, "prose": 0.0}


def test_load_accept_rate_estimates_missing_file_returns_empty(tmp_path):
    assert load_accept_rate_estimates(tmp_path / "nope.json") == {}


def test_load_accept_rate_estimates_reads_strata(tmp_path):
    report = tmp_path / "pilot_report.json"
    report.write_text(json.dumps({
        "strata": [
            {"stratum": "router:UMUM", "accept_rate": 0.75},
            {"stratum": "edit:koreksi", "accept_rate": 0.3},
        ]
    }))
    rates = load_accept_rate_estimates(report)
    assert rates == {"router:UMUM": 0.75, "edit:koreksi": 0.3}


def test_augment_review_entries_adds_provenance():
    entries = [{"family": "f1", "message": "hi"}]
    out = _augment_review_entries(
        entries, prompt_id="router", content_hash="h1", git_sha="sha1",
        generation_meta={"teacher_model": "T", "renderer": "R"},
    )
    assert out[0]["family"] == "f1"
    assert out[0]["prompt_id"] == "router"
    assert out[0]["production_prompt_content_hash"] == "h1"
    assert out[0]["production_prompt_git_sha"] == "sha1"
    assert out[0]["generation"] == {"teacher_model": "T", "renderer": "R"}
    # original entry untouched
    assert "prompt_id" not in entries[0]


def test_build_family_pool_covers_every_kind_split_resolved():
    pool = _build_family_pool(seed=0)
    for intent in ROUTER_INTENTS:
        assert f"router:{intent}" in pool
        for fam in pool[f"router:{intent}"]:
            assert fam["split"] in ("train", "eval", "challenge")


# --- Combined deterministic stub teacher (never touches Tinker) ---------

_ROUTER_INTENT_RE = re.compile(r'intent\s+"([A-Z_]+)"')
_ROUTER_N_RE = re.compile(r"Tulis (\d+) pesan")
_ROUTER_COLD_MSG_RE = re.compile(r"Pesan:\s*(.*)$", re.DOTALL)
_ROUTER_EMBEDDED_INTENT_RE = re.compile(r"INTENT=([A-Z_]+)")

_WORD_ORDER_RE = re.compile(r'tertulis "([^"]+)" padahal seharusnya "([^"]+)"')
_TERMINOLOGY_RE = re.compile(r'tertulis "([^"]+)" padahal seharusnya menggunakan istilah "([^"]+)"')
_SPELLING_RE = re.compile(r'"([^"]+)" seharusnya "([^"]+)"')

_PROSE_MARKER_RE = re.compile(r"MARKER=(\w+)")


def _prose_text(pipeline, i):
    # Every branch mixes in a handful of DISTINCT word-bank picks (not just
    # the counter `i`) -- near_duplicates (both the per-batch check inside
    # generate_prose and this module's global one) uses char-3-shingle
    # Jaccard, so two strings differing only by one digit are near-identical
    # and would get flagged; real lexical variety is needed to survive it.
    words = random.Random(f"prose:{pipeline}:{i}").sample(_WORD_BANK, 5)
    w = words
    if pipeline == "ringkas":
        return f"- Poin uji nomor {i} tentang {w[0]} dan {w[1]}.\n- Poin tambahan tentang {w[2]}, {w[3]}, dan {w[4]}."
    if pipeline == "cekAman":
        return f"✅ Pesan uji nomor {i} soal {w[0]} dan {w[1]} ini tidak menunjukkan tanda phishing atau penipuan apa pun mengenai {w[2]}."
    if pipeline in ("terjemah", "draftTeks"):
        return f"Kalimat mandiri uji nomor {i} soal {w[0]} {w[1]} {w[2]} {w[3]} {w[4]}, berdiri sendiri tanpa komentar pembuka."
    return f"Balasan uji nomor {i} tentang {' '.join(words)} yang cukup panjang untuk lolos batas minimum."


class CombinedSampler:
    """Deterministic stub teacher (never touches Tinker/network) that
    inspects message content to figure out which axis/call is being made,
    and answers accordingly:
    - router synthesis: N distinct lines, each embedding "INTENT=<X>" (so
      the cold-classify branch below can echo it back for guaranteed
      agreement) plus enough lexical variety (word-bank permutation keyed
      by a monotonic counter) to survive the global near-dup filter.
    - router cold-classify: echoes back the embedded INTENT=<X> label.
    - edit: parses the instruction text (which is built from gen_edit.py's
      OWN fixed instruction templates) to reconstruct the exact find/replace
      edit that undoes the corruption -- generic across all 3 synthesizable
      subtypes, no family/index bookkeeping needed. Fallback-subtype
      instructions match none of these patterns and fall through to a
      deliberately-invalid response (those always land in rejected/review
      anyway, never accepted -- see gen_edit.FALLBACK_SUBTYPES).
    - prose: detected via a "MARKER=<pipeline>" token this test embeds in
      the system prompt it hands `run_generate` (see PROSE_SYSTEM_PROMPTS
      below); returns pipeline-format-correct text.
    """

    def __init__(self):
        self.calls = []
        self._router_counter = 0

    def sample(self, messages):
        self.calls.append(messages)
        content = messages[-1].get("content", "")
        system_content = messages[0].get("content", "") if messages else ""

        if "Instruksi:" in content and content.startswith("Dokumen:"):
            return self._edit_response(content)

        n_match = _ROUTER_N_RE.search(content)
        intent_match = _ROUTER_INTENT_RE.search(content)
        if n_match and intent_match:
            return self._router_synthesis(intent_match.group(1), int(n_match.group(1)))

        cold_match = _ROUTER_COLD_MSG_RE.search(content)
        if cold_match and "pengklasifikasi intent independen" in content:
            embedded = _ROUTER_EMBEDDED_INTENT_RE.search(cold_match.group(1))
            return embedded.group(1) if embedded else "UMUM"

        marker = _PROSE_MARKER_RE.search(system_content)
        if marker:
            self._router_counter += 1
            return _prose_text(marker.group(1), self._router_counter)

        return "UMUM"

    def _router_synthesis(self, intent, n):
        lines = []
        for _ in range(n):
            self._router_counter += 1
            words = random.Random(f"router:{self._router_counter}").sample(_WORD_BANK, 4)
            lines.append(f"Permintaan uji INTENT={intent} nomor {self._router_counter} tentang {' '.join(words)}.")
        return "\n".join(lines)

    def _edit_response(self, content):
        instruction = content.split("Instruksi:", 1)[1].strip() if "Instruksi:" in content else ""
        m = _WORD_ORDER_RE.search(instruction)
        if m:
            find, replace = m.group(1), m.group(2)
        else:
            m = _TERMINOLOGY_RE.search(instruction)
            if m:
                find, replace = m.group(1), m.group(2)
            else:
                m = _SPELLING_RE.search(instruction)
                find, replace = (m.group(1), m.group(2)) if m else (None, None)
        if find is None:
            return '{"edits": []}'  # fallback-subtype instruction -- deliberately unparseable-to-empty
        return json.dumps({"edits": [{"find": find, "replace": replace, "occurrence": 1}]})


PROSE_SYSTEM_PROMPTS = {p: f"PROSE SYSTEM PROMPT MARKER={p}" for p in PROSE_PIPELINES}


def _run(tmp_path, **kwargs):
    teacher = CombinedSampler()
    with BridgeClient(str(BRIDGE)) as bc:
        manifest = run_generate(
            bc,
            "ROUTER SYSTEM PROMPT",
            "EDIT SYSTEM PROMPT",
            PROSE_SYSTEM_PROMPTS,
            teacher_sampler=teacher,
            token_counter=lambda t: max(1, len(str(t).split())),
            data_dir=tmp_path,
            **kwargs,
        )
    return manifest, teacher


# --- Integration: run_generate end to end --------------------------------

def test_run_generate_writes_all_artifacts_and_review_queue(tmp_path):
    manifest, teacher = _run(
        tmp_path, seed=7, target_accepted=12, budget_usd=50.0,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=2,
    )

    for name in ("train.jsonl", "eval.jsonl", "challenge.jsonl", "rejects.jsonl",
                 "review_queue.jsonl", "dedup_log.json", "generation_manifest.json"):
        assert (tmp_path / name).exists(), name

    on_disk_manifest = json.loads((tmp_path / "generation_manifest.json").read_text())
    assert on_disk_manifest == manifest

    # At least some accepted examples exist, and none are review-queue leaks.
    assert manifest["counts"]["accepted_total"] > 0
    assert manifest["counts"]["rejected_total"] > 0

    train = [json.loads(l) for l in (tmp_path / "train.jsonl").read_text().splitlines() if l]
    eva = [json.loads(l) for l in (tmp_path / "eval.jsonl").read_text().splitlines() if l]
    challenge = [json.loads(l) for l in (tmp_path / "challenge.jsonl").read_text().splitlines() if l]
    rejects = [json.loads(l) for l in (tmp_path / "rejects.jsonl").read_text().splitlines() if l]
    review_queue = [json.loads(l) for l in (tmp_path / "review_queue.jsonl").read_text().splitlines() if l]

    # split disjointness by construction (each example's own family split).
    for ex in train:
        assert ex["split"] == "train"
    for ex in eva:
        assert ex["split"] == "eval"
    for ex in challenge:
        assert ex["split"] == "challenge"

    # every accepted example carries full provenance.
    for ex in train + eva + challenge:
        prov = ex["provenance"]
        assert prov["status"] == "accepted"
        assert prov["generation"]["teacher_model"]
        assert prov["training"]["student_model"]

    # review-queue items carry the closed-Task-7-finding provenance fields.
    for item in review_queue:
        assert "prompt_id" in item
        assert "production_prompt_content_hash" in item
        assert "production_prompt_git_sha" in item
        assert "generation" in item and "teacher_model" in item["generation"]

    # review-queue items never leak into any of the four artifacts.
    accepted_ids = {ex["id"] for ex in train + eva + challenge}
    reject_ids = {ex["id"] for ex in rejects}
    assert accepted_ids.isdisjoint(reject_ids)

    assert manifest["review_queue_unresolved"] == (len(review_queue) > 0)
    assert manifest["aborted"] is False


def test_run_generate_exposure_mix_present_and_axes_all_represented(tmp_path):
    manifest, _ = _run(
        tmp_path, seed=3, target_accepted=15,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=3,
    )
    counts_by_axis = manifest["counts"]["accepted_by_axis"]
    assert set(counts_by_axis) == {"router", "edit", "prose"}
    assert sum(counts_by_axis.values()) == manifest["counts"]["accepted_total"]
    ratio = manifest["exposure_mix"]["ratio"]
    assert sum(ratio.values()) == pytest.approx(1.0, abs=1e-6) or manifest["counts"]["accepted_total"] == 0


def test_run_generate_data_dir_falsy_skips_writing(tmp_path):
    teacher = CombinedSampler()
    with BridgeClient(str(BRIDGE)) as bc:
        manifest = run_generate(
            bc, "ROUTER SYSTEM PROMPT", "EDIT SYSTEM PROMPT", PROSE_SYSTEM_PROMPTS,
            teacher_sampler=teacher,
            token_counter=lambda t: max(1, len(str(t).split())),
            seed=1, target_accepted=6, data_dir=False,
        )
    assert manifest["counts"]["accepted_total"] >= 0
    assert not (tmp_path / "generation_manifest.json").exists()


def test_run_generate_budget_abort_writes_partial_artifacts(tmp_path):
    manifest, _ = _run(
        tmp_path, seed=5, target_accepted=5000, budget_usd=0.0000001,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
    )
    assert manifest["aborted"] is True
    assert manifest["abort_reason"] is not None
    assert (tmp_path / "generation_manifest.json").exists()
    assert (tmp_path / "train.jsonl").exists()


def test_run_generate_global_dedup_removes_and_logs_near_duplicates(tmp_path):
    class RepeatingRouterSampler:
        """Always emits the exact same router candidate line -> every
        candidate after the first, across every family/kind, is an exact
        (and therefore near-) duplicate of the first accepted one."""

        def sample(self, messages):
            content = messages[-1].get("content", "")
            if _ROUTER_N_RE.search(content) and _ROUTER_INTENT_RE.search(content):
                intent = _ROUTER_INTENT_RE.search(content).group(1)
                n = int(_ROUTER_N_RE.search(content).group(1))
                line = f"Permintaan uji tetap INTENT={intent} yang selalu identik setiap kali."
                return "\n".join([line] * n)
            cold_match = _ROUTER_COLD_MSG_RE.search(content)
            if cold_match:
                embedded = _ROUTER_EMBEDDED_INTENT_RE.search(cold_match.group(1))
                return embedded.group(1) if embedded else "UMUM"
            return "UMUM"

    teacher = RepeatingRouterSampler()
    with BridgeClient(str(BRIDGE)) as bc:
        manifest = run_generate(
            bc, "ROUTER SYSTEM PROMPT", "EDIT SYSTEM PROMPT", PROSE_SYSTEM_PROMPTS,
            teacher_sampler=teacher,
            token_counter=lambda t: max(1, len(str(t).split())),
            seed=2, target_accepted=6,
            avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
            data_dir=tmp_path, max_topup_rounds=0,
        )

    dedup_log = json.loads((tmp_path / "dedup_log.json").read_text())
    assert manifest["dedup"]["removed"] == len(dedup_log)
    if manifest["dedup"]["removed"] > 0:
        rejects = [json.loads(l) for l in (tmp_path / "rejects.jsonl").read_text().splitlines() if l]
        near_dup_rejects = [r for r in rejects if r["provenance"]["reject_reason"] == "near_duplicate_global"]
        assert len(near_dup_rejects) == manifest["dedup"]["removed"]


# --- verify_artifacts / --verify ------------------------------------------

def test_verify_artifacts_ok_on_freshly_generated_corpus(tmp_path):
    _run(
        tmp_path, seed=9, target_accepted=10,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=3,
    )
    assert verify_artifacts(tmp_path) is True


def test_verify_artifacts_fails_on_missing_files(tmp_path):
    with pytest.raises(VerifyError):
        verify_artifacts(tmp_path)


def test_verify_artifacts_fails_on_family_split_collision(tmp_path):
    _run(
        tmp_path, seed=11, target_accepted=10,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=3,
    )
    train_path = tmp_path / "train.jsonl"
    train_examples = [json.loads(l) for l in train_path.read_text().splitlines() if l]
    eval_path = tmp_path / "eval.jsonl"
    eval_examples = [json.loads(l) for l in eval_path.read_text().splitlines() if l]
    if train_examples and eval_examples:
        # Force a collision: duplicate a train family id into eval.
        eval_examples.append({**train_examples[0], "id": "forced-collision"})
        eval_path.write_text("\n".join(json.dumps(e) for e in eval_examples) + "\n")
        with pytest.raises(VerifyError, match="more than one split"):
            verify_artifacts(tmp_path)


def test_verify_artifacts_fails_on_missing_provenance(tmp_path):
    _run(
        tmp_path, seed=13, target_accepted=10,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=3,
    )
    train_path = tmp_path / "train.jsonl"
    train_examples = [json.loads(l) for l in train_path.read_text().splitlines() if l]
    if train_examples:
        broken = dict(train_examples[0])
        broken["provenance"] = {"status": "accepted"}  # missing everything else
        train_path.write_text("\n".join(json.dumps(e) for e in [broken] + train_examples[1:]) + "\n")
        with pytest.raises(VerifyError, match="missing provenance"):
            verify_artifacts(tmp_path)


def test_main_verify_ok(tmp_path, capsys):
    _run(
        tmp_path, seed=15, target_accepted=10,
        avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
        max_topup_rounds=3,
    )
    code = main(["--verify", "--data-dir", str(tmp_path)])
    out = capsys.readouterr().out
    assert code == 0
    assert "VERIFY OK" in out


def test_main_verify_fails_on_empty_dir(tmp_path, capsys):
    code = main(["--verify", "--data-dir", str(tmp_path)])
    err = capsys.readouterr().err
    assert code == 1
    assert "VERIFY FAILED" in err


# --- run_generate: judge wiring for gen_edit.FALLBACK_SUBTYPES ---------------

class FallbackAwareSampler(CombinedSampler):
    """Same as CombinedSampler, but also answers FALLBACK_SUBTYPES edit
    instructions (perjelas/elaborasi/ringkas_bagian) -- which match none of
    CombinedSampler's synthesizable-subtype regexes, so it falls back to a
    deliberately-invalid `{"edits": []}` -- with a trivial validator-clearing
    edit built straight from the doc text, so this test can exercise the
    judge-PASS path all the way through to a written artifact.
    """

    def _edit_response(self, content):
        base = super()._edit_response(content)
        if base != '{"edits": []}':
            return base
        doc_text = content.split("Dokumen:\n", 1)[1].split("\n\nInstruksi:")[0]
        words = doc_text.split()
        word = (words[1] if len(words) > 1 else words[0]).rstrip(".,")
        return json.dumps({"edits": [{"find": word, "replace": f"{word} secara rinci", "occurrence": 1}]})


def test_run_generate_threads_judge_prompt_hash_into_fallback_accepted_examples(tmp_path):
    """judge-PASS fallback-subtype candidates are genuinely accepted (see
    gen_edit.generate_edit's spec-aligned fallback flow), and the real
    judge's prompt hash -- as supplied by the caller, e.g.
    judge.JUDGE_PROMPT_HASH for judge.TinkerEditJudge -- lands in their
    provenance, not None."""
    teacher = FallbackAwareSampler()

    def judge(source, instruction, produced):
        return {"verdict": "PASS", "reason": "ok", "raw": "LULUS ok"}

    with BridgeClient(str(BRIDGE)) as bc:
        manifest = run_generate(
            bc,
            "ROUTER SYSTEM PROMPT",
            "EDIT SYSTEM PROMPT",
            PROSE_SYSTEM_PROMPTS,
            teacher_sampler=teacher,
            judge=judge,
            judge_prompt_hash="real-judge-prompt-hash",
            token_counter=lambda t: max(1, len(str(t).split())),
            data_dir=tmp_path,
            target_accepted=6,
            avg_tokens_by_axis={"router": 4, "edit": 15, "prose": 20},
            max_topup_rounds=1,
        )

    assert manifest["counts"]["accepted_total"] > 0

    fallback_accepted = []
    for name in ("train.jsonl", "eval.jsonl", "challenge.jsonl"):
        for line in (tmp_path / name).read_text().splitlines():
            if not line:
                continue
            ex = json.loads(line)
            # Fallback-origin accepted examples carry "produced_text" in
            # their payload (see generate_edit's fallback accept branch);
            # synthesizable-subtype accepted examples carry
            # "corruption_category" instead -- this distinguishes them.
            if ex["task"] == "edit" and "produced_text" in ex["payload"]:
                fallback_accepted.append(ex)

    assert fallback_accepted, "expected at least one judge-PASS fallback example to be accepted"
    for ex in fallback_accepted:
        assert ex["provenance"]["generation"]["judge_prompt_hash"] == "real-judge-prompt-hash"
