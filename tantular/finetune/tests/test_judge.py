from tantular.finetune.judge import (
    JUDGE_PROMPT_HASH,
    JUDGE_PROMPT_TEMPLATE,
    TinkerEditJudge,
    _hash_constants,
    parse_verdict,
)


def test_judge_prompt_hash_is_64_char_hex():
    assert isinstance(JUDGE_PROMPT_HASH, str) and len(JUDGE_PROMPT_HASH) == 64
    int(JUDGE_PROMPT_HASH, 16)  # raises ValueError if not hex


def test_hash_constants_changes_when_judge_prompt_changes():
    original = _hash_constants({"judge_prompt_template": JUDGE_PROMPT_TEMPLATE})
    modified = _hash_constants({"judge_prompt_template": JUDGE_PROMPT_TEMPLATE + " x"})
    assert original != modified
    assert original == JUDGE_PROMPT_HASH


# --- parse_verdict: lenient first-occurrence parsing -------------------------

def test_parse_verdict_pass_first_token():
    v = parse_verdict("LULUS teks hasil edit sudah sesuai instruksi.")
    assert v["verdict"] == "PASS"
    assert "raw" in v and "reason" in v


def test_parse_verdict_fail_first_token():
    v = parse_verdict("GAGAL ada perubahan yang tidak diminta.")
    assert v["verdict"] == "FAIL"


def test_parse_verdict_lenient_case_insensitive_and_not_strict_prefix():
    v = parse_verdict("  lulus, sudah sesuai.")
    assert v["verdict"] == "PASS"


def test_parse_verdict_first_occurrence_wins_when_both_tokens_present():
    # GAGAL appears first in the text even though LULUS appears later --
    # first occurrence wins, not "prefer PASS" or "prefer FAIL".
    v = parse_verdict("Bukan GAGAL, ini LULUS.")
    assert v["verdict"] == "FAIL"

    v2 = parse_verdict("LULUS, bukan GAGAL.")
    assert v2["verdict"] == "PASS"


def test_parse_verdict_unparseable_output_is_conservatively_fail():
    v = parse_verdict("saya tidak yakin")
    assert v["verdict"] == "FAIL"
    assert v["reason"] == "unparseable_judge_output"


def test_parse_verdict_handles_none_and_empty():
    for raw in (None, "", "   "):
        v = parse_verdict(raw)
        assert v["verdict"] == "FAIL"


# --- TinkerEditJudge: construction never touches Tinker (lazy imports) -------

def test_tinker_edit_judge_constructs_without_network():
    judge = TinkerEditJudge()
    assert judge._sampling_client is None


def test_tinker_edit_judge_is_callable_with_gen_edit_contract():
    """Call-compatible with generate_edit's injected `judge(source_text,
    instruction, produced_text) -> Any` contract -- verified here via
    signature inspection only (constructing/calling for real would touch
    Tinker, which tests never do)."""
    import inspect

    sig = inspect.signature(TinkerEditJudge.__call__)
    params = list(sig.parameters)
    assert params == ["self", "source_text", "instruction", "produced_text"]
