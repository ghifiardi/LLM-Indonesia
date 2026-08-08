"""Split-before-generate family enumeration and partitioning.

Per the fine-tune design spec
(docs/superpowers/specs/2026-07-20-tantular-productivity-finetune-design.md,
"Family definition & split policy"), document families and scenario families
must be enumerated and partitioned into train/eval/challenge splits *before*
any teacher generation happens, so no template or document straddles a split
boundary. This module is pure Python: no teacher calls, no I/O.

A "family" is one concrete instance of a stratum (a document kind or a
scenario kind). Many family instances share a stratum ("kind"); the guard in
``assign_splits`` ensures every stratum has at least one family instance in
every split, while any single family instance belongs to exactly one split.

Strata axes (kind is namespaced as "<axis>:<name>"):
- document:<doc kind>   -- memo, email, report, spreadsheet-text, slide-text, ...
- router:<intent>       -- the 8 router intents (source of truth: intentRouter.js)
- edit:<subtype>        -- edit-contract subtypes (see EDIT_SUBTYPES docstring)
- prose:<pipeline>      -- the 7 non-edit prose pipelines

Document kinds are named literally after the examples given in the design
spec ("memo, email, report, spreadsheet-text, slide-text, ..."); the spec's
ellipsis is intentionally left unexpanded here rather than guessed at, since
no canonical exhaustive list exists elsewhere in the repo.

Router intents mirror tantular_office_addin/src/chat/intentRouter.js
``INTENTS`` verbatim (source of truth).

Prose pipelines mirror the 7 files under
tantular_office_addin/src/chat/pipelines/ that are NOT the edit-contract
pipeline: cekAman, draftTeks, ringkas, tanyaDokumen, terjemah, ubahNada, umum.
(editTeks.js is the edit-contract pipeline, tracked separately as the "edit"
axis; index.js is a dispatcher, not a pipeline.)

Edit subtypes have no canonical enumeration anywhere in the codebase today
(grep of docs/specs/plans/editContract.js turns up only the phrase "edit
subtype", never a list). EDIT_SUBTYPES below is this module's own reasoned
taxonomy of edit-contract operations, chosen to cover the kinds of edits the
production EDIT_SYSTEM_PROMPT (tantular_office_addin/src/chat/editContract.js)
actually asks for: correction, clarity rewrites, elaboration/expansion,
condensation, terminology/number-preserving fixes, and restructuring. This is
a documented judgment call, not a value taken from an existing source of
truth; update it in one place if a canonical taxonomy is defined later.
"""

import hashlib

DOCUMENT_KINDS = (
    "memo",
    "email",
    "report",
    "spreadsheet-text",
    "slide-text",
)

# Source of truth: tantular_office_addin/src/chat/intentRouter.js INTENTS.
ROUTER_INTENTS = (
    "TANYA_DOKUMEN",
    "EDIT_TEKS",
    "DRAFT_TEKS",
    "TERJEMAH",
    "RINGKAS",
    "UBAH_NADA",
    "CEK_AMAN",
    "UMUM",
)

# Source: the 7 pipeline modules under
# tantular_office_addin/src/chat/pipelines/ excluding editTeks.js (the edit
# contract, tracked on the "edit" axis) and index.js (a dispatcher).
PROSE_PIPELINES = (
    "cekAman",
    "draftTeks",
    "ringkas",
    "tanyaDokumen",
    "terjemah",
    "ubahNada",
    "umum",
)

# See module docstring: no canonical list exists in the codebase; this is a
# reasoned taxonomy of edit-contract operation types.
EDIT_SUBTYPES = (
    "koreksi",       # correction: grammar/spelling/factual fixes
    "perjelas",      # clarity rewrite without changing meaning
    "elaborasi",      # elaboration/expansion of existing content
    "ringkas_bagian",  # condensation of a passage
    "ubah_istilah",   # terminology/name/number-preserving substitution
    "restrukturisasi",  # reordering/restructuring content
)

SPLITS = ("train", "eval", "challenge")

# Cumulative percentage boundaries for the ~70/20/10 hash-bucket split.
_TRAIN_UPPER = 70
_EVAL_UPPER = 90  # train(0-69) + eval(70-89) + challenge(90-99)

DEFAULT_INSTANCES_PER_KIND = 10


def _all_kinds():
    kinds = []
    kinds.extend(f"document:{k}" for k in DOCUMENT_KINDS)
    kinds.extend(f"router:{k}" for k in ROUTER_INTENTS)
    kinds.extend(f"edit:{k}" for k in EDIT_SUBTYPES)
    kinds.extend(f"prose:{k}" for k in PROSE_PIPELINES)
    return kinds


def enumerate_families(instances_per_kind=DEFAULT_INSTANCES_PER_KIND):
    """Enumerate all document/scenario family instances.

    Returns a list of Family dicts: {"id", "kind", "split"}. ``split`` is
    always None here -- splits are assigned later, deterministically, by
    ``assign_splits``. No teacher calls, no randomness, no I/O.
    """
    families = []
    for kind in _all_kinds():
        for i in range(instances_per_kind):
            families.append({"id": f"{kind}::{i:04d}", "kind": kind, "split": None})
    return families


def _bucket(seed, family_id):
    """Deterministic 0-99 bucket for a family id under a given seed."""
    digest = hashlib.sha256(f"{seed}:{family_id}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % 100


def _split_for_bucket(bucket):
    if bucket < _TRAIN_UPPER:
        return "train"
    if bucket < _EVAL_UPPER:
        return "eval"
    return "challenge"


_LAST_ASSIGNMENT = {}


def assign_splits(families, seed):
    """Deterministically partition families into train/eval/challenge.

    Hash-based (``sha256(f"{seed}:{fam_id})")``) so the same seed always
    produces the same assignment. A guard then forces every stratum (kind)
    to have at least one family instance in every split: if the raw hash
    assignment leaves a (kind, split) pair empty, the deterministically
    smallest-id family from that kind's most populous split is moved over.

    Returns dict[family_id] -> split ("train" | "eval" | "challenge").
    Caches the result so ``split_of`` can be called with just a family id.
    """
    assignment = {}
    kind_of = {}
    for fam in families:
        fam_id = fam["id"]
        assignment[fam_id] = _split_for_bucket(_bucket(seed, fam_id))
        kind_of[fam_id] = fam["kind"]

    # Group ids by (kind, split) for the coverage guard. Iterate over kinds
    # in a deterministic (sorted) order, and ids within a kind sorted too,
    # so the guard's corrective reassignments are themselves deterministic.
    ids_by_kind = {}
    for fam_id, kind in kind_of.items():
        ids_by_kind.setdefault(kind, []).append(fam_id)

    for kind in sorted(ids_by_kind):
        ids = sorted(ids_by_kind[kind])
        ids_by_split = {s: [] for s in SPLITS}
        for fam_id in ids:
            ids_by_split[assignment[fam_id]].append(fam_id)

        missing = [s for s in SPLITS if not ids_by_split[s]]
        for missing_split in missing:
            # Donor: the split with the most members for this kind (ties
            # broken by SPLITS order for determinism).
            donor_split = max(
                SPLITS, key=lambda s: (len(ids_by_split[s]), SPLITS.index(s) * -1)
            )
            if len(ids_by_split[donor_split]) <= 1:
                # Not enough instances of this kind to guarantee coverage;
                # nothing safe to move without emptying another split.
                continue
            moved_id = sorted(ids_by_split[donor_split])[0]
            ids_by_split[donor_split].remove(moved_id)
            ids_by_split[missing_split].append(moved_id)
            assignment[moved_id] = missing_split

    global _LAST_ASSIGNMENT
    _LAST_ASSIGNMENT = assignment
    return assignment


def split_of(family_id, assignments=None):
    """Look up the split for a family id.

    Uses the explicit ``assignments`` dict if given (as returned by
    ``assign_splits``); otherwise falls back to the result of the most
    recent ``assign_splits`` call in this process. Raises KeyError if the
    family id is unknown.
    """
    table = assignments if assignments is not None else _LAST_ASSIGNMENT
    return table[family_id]
