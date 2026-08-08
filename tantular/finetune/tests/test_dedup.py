from tantular.finetune.dedup import near_duplicates


# --- Step 1 brief test, verbatim --------------------------------------------

def test_dedup_flags_near_identical():
    dupes = near_duplicates(
        ["halo dunia ini contoh", "halo dunia ini contoh!", "teks berbeda sama sekali"],
        threshold=0.8,
    )
    assert 1 in dupes and 2 not in dupes


# --- Additional coverage -----------------------------------------------------

def test_first_occurrence_never_flagged():
    dupes = near_duplicates(["sama persis", "sama persis", "sama persis"], threshold=0.8)
    assert 0 not in dupes
    assert dupes == {1, 2}


def test_empty_list_and_single_item_never_flag():
    assert near_duplicates([], threshold=0.8) == set()
    assert near_duplicates(["satu saja"], threshold=0.8) == set()


def test_completely_different_texts_not_flagged():
    dupes = near_duplicates(
        ["laporan keuangan kuartal kedua", "resep nasi goreng spesial", "jadwal rapat tim minggu ini"],
        threshold=0.8,
    )
    assert dupes == set()


def test_threshold_is_respected():
    a = "budi pergi ke pasar membeli buah segar"
    b = "budi pergi ke pasar membeli sayur segar"  # one word different
    # High threshold: similar-but-not-identical strings should NOT be flagged.
    assert near_duplicates([a, b], threshold=0.99) == set()
    # Lower threshold: same pair should now be flagged.
    assert near_duplicates([a, b], threshold=0.5) == {1}


def test_case_and_whitespace_normalized():
    dupes = near_duplicates(["Halo   Dunia", "halo dunia"], threshold=0.9)
    assert dupes == {1}


def test_empty_strings_never_treated_as_duplicates_of_each_other():
    # Two empty candidates share no shingles at all (empty set), so Jaccard
    # is defined as 0.0, not 1.0 -- an empty completion is never "deduped
    # away" as a duplicate of another empty completion; each empty candidate
    # must still independently fail the length/format filters upstream.
    assert near_duplicates(["", ""], threshold=0.8) == set()


def test_is_deterministic():
    texts = ["halo dunia ini contoh", "halo dunia ini contoh!", "teks lain sekali"]
    assert near_duplicates(texts, threshold=0.8) == near_duplicates(texts, threshold=0.8)
