import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from spike.verify import SENTINEL_RESPONSE, satisfies_sentinel


def test_satisfies_sentinel_true_on_exact_match():
    assert satisfies_sentinel(SENTINEL_RESPONSE) is True


def test_satisfies_sentinel_true_when_embedded_in_longer_text():
    text = f"Baiklah, jawabannya adalah {SENTINEL_RESPONSE}. Terima kasih."
    assert satisfies_sentinel(text) is True


def test_satisfies_sentinel_false_on_unrelated_text():
    assert satisfies_sentinel("Saya tidak tahu jawabannya.") is False


def test_satisfies_sentinel_false_on_empty_string():
    assert satisfies_sentinel("") is False


def test_satisfies_sentinel_false_on_none():
    assert satisfies_sentinel(None) is False


def test_satisfies_sentinel_is_case_sensitive():
    assert satisfies_sentinel(SENTINEL_RESPONSE.lower()) is False


def test_satisfies_sentinel_false_on_partial_match():
    # Missing the trailing suffix shouldn't count.
    partial = SENTINEL_RESPONSE.rsplit("-", 1)[0]
    assert satisfies_sentinel(partial) is False
