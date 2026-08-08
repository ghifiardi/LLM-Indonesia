from tantular.finetune.families import (
    DOCUMENT_KINDS,
    EDIT_SUBTYPES,
    PROSE_PIPELINES,
    ROUTER_INTENTS,
    assign_splits,
    enumerate_families,
    split_of,
)


def test_partition_is_deterministic_and_disjoint():
    fams = enumerate_families()
    a = assign_splits(fams, seed=7)
    b = assign_splits(fams, seed=7)
    assert a == b
    # every family assigned exactly one split
    assert set(a.values()) <= {"train", "eval", "challenge"}
    assert len(a) == len(fams)
    # each split non-empty
    assert {"train", "eval", "challenge"} <= set(a.values())


def test_different_seed_can_change_assignment():
    fams = enumerate_families()
    a = assign_splits(fams, seed=7)
    c = assign_splits(fams, seed=8)
    # not required to differ for every family, but the two seeds should not
    # produce byte-identical dicts across the whole corpus (sanity check that
    # seed actually participates in the hash).
    assert a != c


def test_every_family_id_is_unique():
    fams = enumerate_families()
    ids = [f["id"] for f in fams]
    assert len(ids) == len(set(ids))


def test_family_shape():
    fams = enumerate_families()
    for fam in fams[:5]:
        assert set(fam.keys()) == {"id", "kind", "split"}
        assert fam["split"] is None


def test_router_intents_covers_eight_intents():
    assert len(ROUTER_INTENTS) == 8


def test_prose_pipelines_covers_seven_pipelines():
    assert len(PROSE_PIPELINES) == 7


def test_document_kinds_present():
    assert {"memo", "email", "report", "spreadsheet-text", "slide-text"} <= set(DOCUMENT_KINDS)


def test_edit_subtypes_non_empty():
    assert len(EDIT_SUBTYPES) >= 1


def test_every_stratum_appears_in_every_split():
    fams = enumerate_families()
    a = assign_splits(fams, seed=7)
    by_kind = {}
    for fam in fams:
        by_kind.setdefault(fam["kind"], set()).add(a[fam["id"]])
    assert by_kind, "expected at least one stratum"
    for kind, splits_seen in by_kind.items():
        assert splits_seen == {"train", "eval", "challenge"}, (
            f"stratum {kind!r} missing coverage: {splits_seen}"
        )


def test_stratum_kinds_are_namespaced_by_axis():
    fams = enumerate_families()
    kinds = {f["kind"] for f in fams}
    assert any(k.startswith("document:") for k in kinds)
    assert any(k.startswith("router:") for k in kinds)
    assert any(k.startswith("edit:") for k in kinds)
    assert any(k.startswith("prose:") for k in kinds)


def test_split_of_matches_assign_splits_result():
    fams = enumerate_families()
    a = assign_splits(fams, seed=7)
    sample_id = fams[0]["id"]
    assert split_of(sample_id) == a[sample_id]
    assert split_of(sample_id, a) == a[sample_id]


def test_split_of_unknown_family_raises_key_error():
    fams = enumerate_families()
    assign_splits(fams, seed=7)
    try:
        split_of("no-such-family-id")
    except KeyError:
        pass
    else:
        raise AssertionError("expected KeyError for unknown family id")


def test_approximate_70_20_10_ratio_with_enough_instances():
    fams = enumerate_families(instances_per_kind=50)
    a = assign_splits(fams, seed=7)
    counts = {"train": 0, "eval": 0, "challenge": 0}
    for split in a.values():
        counts[split] += 1
    total = sum(counts.values())
    train_frac = counts["train"] / total
    eval_frac = counts["eval"] / total
    challenge_frac = counts["challenge"] / total
    # Loose bounds: guard-driven reassignment perturbs the raw hash ratios a
    # little, especially at small N, so allow generous tolerance.
    assert 0.55 <= train_frac <= 0.85
    assert 0.08 <= eval_frac <= 0.32
    assert 0.03 <= challenge_frac <= 0.20


def test_family_instances_are_disjoint_across_kinds():
    fams = enumerate_families()
    seen = set()
    for fam in fams:
        key = (fam["kind"], fam["id"])
        assert key not in seen
        seen.add(key)
