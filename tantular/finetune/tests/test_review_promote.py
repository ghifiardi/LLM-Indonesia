import json

import pytest

from tantular.finetune.dedup import DEFAULT_THRESHOLD
from tantular.finetune.families import assign_splits, enumerate_families
from tantular.finetune.gen_edit import generate_edit
from tantular.finetune.gen_prose import generate_prose
from tantular.finetune.gen_router import generate_router
from tantular.finetune.generate import ARTIFACT_FILENAMES, REVIEW_QUEUE_FILENAME, _augment_review_entries
from tantular.finetune.provenance import STATUS_ACCEPTED_HUMAN_REVIEW, STATUS_REJECTED_HUMAN_REVIEW
from tantular.finetune.review_promote import (
    DECISIONS_FILENAME,
    PromptDriftError,
    ReviewPromoteError,
    UnknownItemError,
    apply_review_queue,
    load_decisions,
    load_review_queue,
    main,
    queue_item_id,
    record_decision,
    reconstruct_example,
    resolve_seed,
)


# --- Fixture helpers -------------------------------------------------------

class StubBridge:
    """Fake BridgeClient exposing only .dump_prompts(), the only bridge
    method review_promote ever calls (list/show/accept/reject never touch
    the bridge at all)."""

    def __init__(self, prompts):
        self._prompts = prompts

    def dump_prompts(self):
        return [{"id": pid, "content": p["content"], "contentHash": p["contentHash"]} for pid, p in self._prompts.items()]


class FixedSampler:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def sample(self, messages):
        self.calls.append(messages)
        if isinstance(self.value, list):
            idx = min(len(self.calls) - 1, len(self.value) - 1)
            return self.value[idx]
        return self.value


def _prose_family(pipeline, split="train", idx=0):
    return {"id": f"prose:{pipeline}::{idx:04d}", "kind": f"prose:{pipeline}", "split": split}


def _router_family(intent, split="train", idx=0):
    return {"id": f"router:{intent}::{idx:04d}", "kind": f"router:{intent}", "split": split}


def _edit_family(subtype, split="train", idx=0):
    return {"id": f"edit:{subtype}::{idx:04d}", "kind": f"edit:{subtype}", "split": split}


def _write_queue(data_dir, entries):
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / REVIEW_QUEUE_FILENAME
    with path.open("w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def _write_manifest(data_dir, seed):
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "generation_manifest.json").write_text(json.dumps({"seed": seed}))


def _prose_review_entry_and_accepted():
    """Real generate_prose() call, spot_check_every=1 so the sole accepted
    candidate is ALSO copied into review_queue -- gives a genuine
    (review_queue raw entry, directly-accepted full example) pair built from
    the exact same underlying candidate, for true schema-parity testing."""
    synth = FixedSampler("- poin pertama tentang efisiensi\n- poin kedua tentang biaya operasional")
    accepted, rejected, review_queue = generate_prose(
        synth, _prose_family("ringkas"), 1, "RINGKAS SYSTEM PROMPT",
        spot_check_every=1,
        production_prompt_content_hash="hash-ringkas",
        production_prompt_git_sha="sha-abc",
    )
    assert rejected == []
    assert len(accepted) == 1
    assert len(review_queue) == 1
    augmented = _augment_review_entries(
        review_queue, prompt_id="prose:ringkas", content_hash="hash-ringkas",
        git_sha="sha-abc", generation_meta=accepted[0]["provenance"]["generation"],
    )
    return augmented[0], accepted[0]


PROMPTS = {
    "router": {"content": "ROUTER SYSTEM PROMPT", "contentHash": "hash-router"},
    "edit": {"content": "EDIT SYSTEM PROMPT", "contentHash": "hash-edit"},
    "prose:ringkas": {"content": "RINGKAS SYSTEM PROMPT", "contentHash": "hash-ringkas"},
}


# --- queue_item_id / load_review_queue -------------------------------------

def test_queue_item_id_deterministic_and_content_sensitive():
    a = {"family": "router:UMUM::0000", "message": "hi", "intent": "UMUM"}
    b = dict(a)
    c = {**a, "message": "bye"}
    assert queue_item_id(a) == queue_item_id(b)
    assert queue_item_id(a) != queue_item_id(c)


def test_load_review_queue_missing_file_returns_empty(tmp_path):
    assert load_review_queue(tmp_path) == []


def test_load_review_queue_reads_entries_with_ids(tmp_path):
    entries = [
        {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM"},
        {"family": "router:UMUM::0001", "message": "b", "intent": "UMUM"},
    ]
    _write_queue(tmp_path, entries)
    loaded = load_review_queue(tmp_path)
    assert len(loaded) == 2
    assert loaded[0][1] == entries[0]
    assert loaded[0][0] == queue_item_id(entries[0])


# --- decisions: accept/reject, idempotent round-trip, unknown id ----------

def test_accept_unknown_id_raises(tmp_path):
    _write_queue(tmp_path, [{"family": "router:UMUM::0000", "message": "a", "intent": "UMUM"}])
    with pytest.raises(UnknownItemError):
        record_decision(tmp_path, "not-a-real-id", "accept")


def test_record_decision_round_trips_through_decisions_file(tmp_path):
    entry = {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM"}
    _write_queue(tmp_path, [entry])
    item_id = queue_item_id(entry)

    record_decision(tmp_path, item_id, "accept", note="looks fine")
    decisions = load_decisions(tmp_path)
    assert decisions[item_id]["decision"] == "accept"
    assert decisions[item_id]["note"] == "looks fine"
    assert decisions[item_id]["decided_at"]
    assert decisions[item_id]["applied_at"] is None

    # Decisions file is durable: reload from disk directly.
    on_disk = json.loads((tmp_path / DECISIONS_FILENAME).read_text())
    assert on_disk[item_id]["decision"] == "accept"


def test_reject_then_accept_overwrites_decision(tmp_path):
    entry = {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM"}
    _write_queue(tmp_path, [entry])
    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "reject")
    record_decision(tmp_path, item_id, "accept")
    decisions = load_decisions(tmp_path)
    assert decisions[item_id]["decision"] == "accept"


def test_invalid_decision_value_raises(tmp_path):
    entry = {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM"}
    _write_queue(tmp_path, [entry])
    with pytest.raises(ValueError):
        record_decision(tmp_path, queue_item_id(entry), "maybe")


# --- resolve_seed ------------------------------------------------------

def test_resolve_seed_explicit_wins(tmp_path):
    _write_manifest(tmp_path, seed=7)
    assert resolve_seed(tmp_path, seed=99) == 99


def test_resolve_seed_reads_manifest(tmp_path):
    _write_manifest(tmp_path, seed=7)
    assert resolve_seed(tmp_path) == 7


def test_resolve_seed_falls_back_to_default_without_manifest(tmp_path):
    from tantular.finetune.generate import DEFAULT_SEED
    assert resolve_seed(tmp_path) == DEFAULT_SEED


# --- reconstruct_example: schema/provenance parity vs directly-accepted ---

def test_reconstruct_prose_matches_directly_accepted_schema():
    entry, direct = _prose_review_entry_and_accepted()
    reconstructed = reconstruct_example(
        entry, split="train", prompts=PROMPTS, status=STATUS_ACCEPTED_HUMAN_REVIEW,
    )
    # Same top-level shape.
    assert set(reconstructed.keys()) == set(direct.keys())
    assert reconstructed["task"] == direct["task"]
    assert reconstructed["family"] == direct["family"]
    assert reconstructed["split"] == direct["split"]
    assert reconstructed["payload"] == direct["payload"]
    assert reconstructed["messages"] == direct["messages"]
    # Same provenance shape except status.
    rp, dp = reconstructed["provenance"], direct["provenance"]
    assert set(rp.keys()) == set(dp.keys())
    for key in ("prompt_id", "production_prompt_content_hash", "production_prompt_git_sha", "generation", "training"):
        assert rp[key] == dp[key], key
    assert dp["status"] == "accepted"
    assert rp["status"] == STATUS_ACCEPTED_HUMAN_REVIEW
    assert rp["reject_reason"] is None


def test_reconstruct_router_builds_expected_messages_and_payload():
    generation_meta = {
        "teacher_model": "T", "renderer": "R", "bridge_protocol_version": "v1",
        "bridge_js_commit": "abc", "synthesis_prompt_hash": "sh", "judge_prompt_hash": "jh",
    }
    entry = {
        "family": "router:UMUM::0003", "intent": "UMUM", "cold_intent": "TERJEMAH",
        "ambiguous": False, "message": "Halo, apa kabar dunia?", "reason": "disagreement",
        "prompt_id": "router", "production_prompt_content_hash": "hash-router",
        "production_prompt_git_sha": "sha-abc", "generation": generation_meta,
    }
    ex = reconstruct_example(entry, split="eval", prompts=PROMPTS, status=STATUS_ACCEPTED_HUMAN_REVIEW)
    assert ex["task"] == "router"
    assert ex["split"] == "eval"
    assert ex["family"] == "router:UMUM::0003"
    assert ex["messages"] == [
        {"role": "system", "content": "ROUTER SYSTEM PROMPT"},
        {"role": "user", "content": "Halo, apa kabar dunia?"},
        {"role": "assistant", "content": "UMUM"},
    ]
    assert ex["payload"] == {"intent": "UMUM", "cold_intent": "TERJEMAH", "ambiguous": False}
    assert ex["provenance"]["status"] == STATUS_ACCEPTED_HUMAN_REVIEW
    assert ex["provenance"]["generation"] == generation_meta


def test_reconstruct_edit_builds_expected_messages_and_payload():
    generation_meta = {
        "teacher_model": "T", "renderer": "R", "bridge_protocol_version": "v1",
        "bridge_js_commit": "abc", "synthesis_prompt_hash": "sh", "judge_prompt_hash": "jh",
    }
    entry = {
        "family": "edit:elaborasi::0001", "subtype": "elaborasi", "reason": "no_synthesizable_target",
        "source_text": "Laporan singkat.", "instruction": "Perluas laporan ini.",
        "edits": [{"find": "singkat", "replace": "singkat dan padat", "occurrence": 1}],
        "produced_text": "Laporan singkat dan padat.", "judge_verdict": None,
        "prompt_id": "edit", "production_prompt_content_hash": "hash-edit",
        "production_prompt_git_sha": "sha-abc", "generation": generation_meta,
    }
    ex = reconstruct_example(entry, split="train", prompts=PROMPTS, status=STATUS_ACCEPTED_HUMAN_REVIEW)
    assert ex["task"] == "edit"
    assert ex["messages"][0] == {"role": "system", "content": "EDIT SYSTEM PROMPT"}
    assert ex["messages"][1] == {
        "role": "user",
        "content": "Dokumen:\nLaporan singkat.\n\nInstruksi: Perluas laporan ini.",
    }
    assert ex["messages"][2] == {
        "role": "assistant",
        "content": json.dumps({"edits": entry["edits"]}),
    }
    assert ex["payload"]["source_text"] == "Laporan singkat."
    assert ex["payload"]["edits"] == entry["edits"]


def test_reconstruct_missing_prompt_id_raises():
    entry = {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM", "generation": {}}
    with pytest.raises(ReviewPromoteError):
        reconstruct_example(entry, split="train", prompts=PROMPTS, status=STATUS_ACCEPTED_HUMAN_REVIEW)


def test_reconstruct_missing_generation_raises():
    entry = {"family": "router:UMUM::0000", "message": "a", "intent": "UMUM", "prompt_id": "router"}
    with pytest.raises(ReviewPromoteError):
        reconstruct_example(entry, split="train", prompts=PROMPTS, status=STATUS_ACCEPTED_HUMAN_REVIEW)


def test_reconstruct_prompt_drift_raises_without_flag():
    entry, _ = _prose_review_entry_and_accepted()
    drifted_prompts = {"prose:ringkas": {"content": "NEW CONTENT", "contentHash": "different-hash"}}
    with pytest.raises(PromptDriftError):
        reconstruct_example(entry, split="train", prompts=drifted_prompts, status=STATUS_ACCEPTED_HUMAN_REVIEW)


def test_reconstruct_prompt_drift_allowed_with_flag():
    entry, _ = _prose_review_entry_and_accepted()
    drifted_prompts = {"prose:ringkas": {"content": "NEW CONTENT", "contentHash": "different-hash"}}
    ex = reconstruct_example(
        entry, split="train", prompts=drifted_prompts, status=STATUS_ACCEPTED_HUMAN_REVIEW,
        allow_prompt_drift=True,
    )
    assert ex["messages"][0]["content"] == "NEW CONTENT"


# --- apply_review_queue: idempotency, reject-exclusion, dedup -------------

def _seeded_family_id(axis_kind, seed, split_wanted, max_idx=9):
    """Find a family id of `axis_kind` (e.g. "router:UMUM") whose resolved
    split under `seed` is `split_wanted`, by scanning the real
    enumerate_families()/assign_splits() assignment -- so tests always use a
    genuinely-consistent (family, split, seed) triple instead of hardcoding
    an index that might land in a different split."""
    assignments = assign_splits(enumerate_families(), seed)
    for i in range(max_idx + 1):
        fam_id = f"{axis_kind}::{i:04d}"
        if assignments.get(fam_id) == split_wanted:
            return fam_id
    raise AssertionError(f"no {axis_kind} family resolves to split {split_wanted!r} under seed {seed!r}")


def _router_entry(family_id, message, intent="UMUM"):
    return {
        "family": family_id, "intent": intent, "cold_intent": "TERJEMAH", "ambiguous": False,
        "message": message, "reason": "disagreement", "prompt_id": "router",
        "production_prompt_content_hash": "hash-router", "production_prompt_git_sha": "sha-abc",
        "generation": {
            "teacher_model": "T", "renderer": "R", "bridge_protocol_version": "v1",
            "bridge_js_commit": "abc", "synthesis_prompt_hash": "sh", "judge_prompt_hash": "jh",
        },
    }


def test_apply_promotes_accepted_item_into_its_split_file(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Tolong jelaskan proses reimbursement kantor secara singkat.")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "accept")

    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["promoted"] == [item_id]

    train = [json.loads(l) for l in (tmp_path / ARTIFACT_FILENAMES["train"]).read_text().splitlines()]
    assert len(train) == 1
    assert train[0]["family"] == fam
    assert train[0]["provenance"]["status"] == STATUS_ACCEPTED_HUMAN_REVIEW


def test_apply_is_idempotent_no_duplicate_on_rerun(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Bisakah tolong ringkas memo rapat minggu lalu untuk saya?")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "accept")

    r1 = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert r1["promoted"] == [item_id]
    r2 = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert r2["promoted"] == []
    assert r2["already_applied"] == [item_id]

    train = [json.loads(l) for l in (tmp_path / ARTIFACT_FILENAMES["train"]).read_text().splitlines()]
    assert len(train) == 1


def test_apply_reject_excluded_from_accepted_files_and_recorded_in_rejects(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Apakah anda bisa menjadwalkan ulang rapat tim besok pagi?")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "reject", note="teacher/cold disagreement is spurious")

    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["rejected_recorded"] == [item_id]

    train_path = tmp_path / ARTIFACT_FILENAMES["train"]
    assert not train_path.exists() or train_path.read_text().strip() == ""

    rejects = [json.loads(l) for l in (tmp_path / ARTIFACT_FILENAMES["rejects"]).read_text().splitlines()]
    assert len(rejects) == 1
    assert rejects[0]["provenance"]["status"] == STATUS_REJECTED_HUMAN_REVIEW
    assert "teacher/cold disagreement is spurious" in rejects[0]["provenance"]["reject_reason"]


def test_apply_pending_items_reported_and_untouched(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Mohon konfirmasi jadwal pengiriman barang minggu ini ya.")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)

    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["pending"] == [item_id]
    assert result["promoted"] == []
    assert result["rejected_recorded"] == []
    assert not (tmp_path / ARTIFACT_FILENAMES["train"]).exists()


def test_apply_skips_near_duplicate_of_existing_accepted_example(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    text = "Tolong jelaskan kebijakan cuti tahunan karyawan secara detail dan lengkap."
    entry = _router_entry(fam, text)
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)

    # Pre-seed train.jsonl with an existing accepted example whose user turn
    # is (near-)identical to the queued item's message.
    existing = {
        "id": "existing-1", "task": "router", "split": "train", "family": "router:UMUM::9999",
        "payload": {}, "messages": [
            {"role": "system", "content": "ROUTER SYSTEM PROMPT"},
            {"role": "user", "content": text},
            {"role": "assistant", "content": "UMUM"},
        ],
        "provenance": {
            "prompt_id": "router", "production_prompt_content_hash": "hash-router",
            "production_prompt_git_sha": "sha-abc", "generation": {}, "training": {},
            "status": "accepted", "reject_reason": None,
        },
    }
    (tmp_path / ARTIFACT_FILENAMES["train"]).write_text(json.dumps(existing) + "\n")

    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "accept")
    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["skipped_duplicate"] == [item_id]
    assert result["promoted"] == []

    train = [json.loads(l) for l in (tmp_path / ARTIFACT_FILENAMES["train"]).read_text().splitlines()]
    assert len(train) == 1  # only the pre-seeded example -- nothing appended


def test_apply_skips_cross_split_near_duplicate_train_item_vs_existing_eval(tmp_path):
    """The dedup pool that a promoted item is checked against must be
    GLOBAL across train/eval/challenge, not scoped to the item's own
    resolved split -- mirrors generate.run_generate's dedup.near_duplicates
    pass, which runs over ALL accepted examples (every split) before
    splitting. A queue item resolving to "train" that near-duplicates an
    example already sitting in eval.jsonl must be skipped, exactly like the
    same-split case is."""
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    text = "Tolong jelaskan kebijakan cuti tahunan karyawan secara detail dan lengkap."
    entry = _router_entry(fam, text)
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)

    # Pre-seed EVAL (not train) with a (near-)identical accepted example.
    existing = {
        "id": "existing-eval-1", "task": "router", "split": "eval", "family": "router:UMUM::8888",
        "payload": {}, "messages": [
            {"role": "system", "content": "ROUTER SYSTEM PROMPT"},
            {"role": "user", "content": text},
            {"role": "assistant", "content": "UMUM"},
        ],
        "provenance": {
            "prompt_id": "router", "production_prompt_content_hash": "hash-router",
            "production_prompt_git_sha": "sha-abc", "generation": {}, "training": {},
            "status": "accepted", "reject_reason": None,
        },
    }
    (tmp_path / ARTIFACT_FILENAMES["eval"]).write_text(json.dumps(existing) + "\n")

    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "accept")
    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["skipped_duplicate"] == [item_id]
    assert result["promoted"] == []

    train_path = tmp_path / ARTIFACT_FILENAMES["train"]
    assert not train_path.exists() or train_path.read_text().strip() == ""


def test_apply_dry_run_writes_nothing(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Bagaimana cara mengajukan reimbursement biaya perjalanan dinas?")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)
    record_decision(tmp_path, item_id, "accept")

    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed, dry_run=True)
    assert result["promoted"] == [item_id]
    assert not (tmp_path / ARTIFACT_FILENAMES["train"]).exists()
    decisions = load_decisions(tmp_path)
    assert decisions[item_id]["applied_at"] is None


def test_apply_unknown_decision_id_ignored_not_crashing(tmp_path):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Tolong terjemahkan dokumen kontrak ini ke bahasa Inggris.")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)

    decisions = {"stale-id-not-in-queue": {"decision": "accept", "note": None, "decided_at": "x", "applied_at": None}}
    (tmp_path / DECISIONS_FILENAME).write_text(json.dumps(decisions))

    result = apply_review_queue(tmp_path, StubBridge(PROMPTS), seed=seed)
    assert result["promoted"] == []
    assert result["pending"] == [queue_item_id(entry)]


# --- CLI (main) smoke tests -------------------------------------------------

def test_cli_list_show_accept_reject_apply_roundtrip(tmp_path, capsys):
    seed = 3
    fam = _seeded_family_id("router:UMUM", seed, "train")
    entry = _router_entry(fam, "Mohon buatkan draf balasan email untuk klien baru kita.")
    _write_queue(tmp_path, [entry])
    _write_manifest(tmp_path, seed=seed)
    item_id = queue_item_id(entry)

    assert main(["--data-dir", str(tmp_path), "list"]) == 0
    out = capsys.readouterr().out
    assert item_id in out

    assert main(["--data-dir", str(tmp_path), "show", item_id]) == 0
    out = capsys.readouterr().out
    assert entry["message"] in out

    assert main(["--data-dir", str(tmp_path), "accept", item_id, "--note", "ok"]) == 0
    capsys.readouterr()
    decisions = load_decisions(tmp_path)
    assert decisions[item_id]["decision"] == "accept"


def test_cli_show_unknown_id_errors(tmp_path, capsys):
    assert main(["--data-dir", str(tmp_path), "show", "nope"]) == 1
    err = capsys.readouterr().err
    assert "nope" in err


def test_cli_accept_unknown_id_errors(tmp_path, capsys):
    assert main(["--data-dir", str(tmp_path), "accept", "nope"]) == 1
