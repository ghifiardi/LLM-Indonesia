"""Pure, deterministic near-duplicate detection for teacher-generated prose.

Per the design spec (docs/superpowers/specs/2026-07-20-tantular-productivity-
finetune-design.md, "Prose"): automated filters include "near-dedup" among
the acceptance gates. This module implements it via char-shingle Jaccard
similarity (the brief's alternative to MinHash) -- chosen over MinHash
specifically for determinism: MinHash needs a fixed hash-seed family to be
reproducible, while exact shingle-set Jaccard has no randomness at all, and
the corpora here (per-family generation batches) are small enough that O(n^2)
pairwise comparison is cheap.

No teacher calls, no I/O -- pure text processing only.
"""

import re

DEFAULT_SHINGLE_SIZE = 3
DEFAULT_THRESHOLD = 0.8


def _normalize(text):
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


def _shingles(text, k=DEFAULT_SHINGLE_SIZE):
    """Character k-shingle set of `text` (normalized: lowercased, whitespace
    collapsed). Texts shorter than `k` (after normalization) degrade to a
    single "shingle" (the whole normalized text) rather than an empty set,
    so two very short near-identical strings can still be compared; an empty
    normalized text yields an empty set (never equal to anything, including
    another empty text, by `_jaccard`'s convention below -- an empty
    candidate should never be silently treated as a "duplicate" of another
    empty candidate).
    """
    if not text:
        return set()
    if len(text) < k:
        return {text}
    return {text[i:i + k] for i in range(len(text) - k + 1)}


def _jaccard(a, b):
    if not a or not b:
        return 0.0
    intersection = len(a & b)
    union = len(a | b)
    return intersection / union if union else 0.0


def near_duplicates(texts, threshold=DEFAULT_THRESHOLD, k=DEFAULT_SHINGLE_SIZE):
    """Flag near-duplicate texts within `texts` (a sequence of strings).

    Returns a `set[int]` of indices to REJECT as near-duplicates -- the
    first occurrence of any near-duplicate cluster is always kept (its index
    is never in the returned set); every later text whose Jaccard similarity
    to ANY earlier (not-yet-rejected or not) text in the batch is >=
    `threshold` is flagged.

    Pure and deterministic: same input always yields the same output, no
    randomness, no I/O.
    """
    shingle_sets = [_shingles(_normalize(t), k) for t in texts]
    duplicates = set()
    for i in range(1, len(texts)):
        for j in range(i):
            if _jaccard(shingle_sets[i], shingle_sets[j]) >= threshold:
                duplicates.add(i)
                break
    return duplicates
