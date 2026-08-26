"""Human-owned evaluation anchors and dataset identity.

The *anchor source* is the full evaluation dataset, holdout included. It is
human-owned: the resident reads it in exactly two places, both of which are
allowed to see holdout labels because neither of them ever hands those labels
to candidate code —

* ``init``, once, to write the public-only snapshot;
* the auditor controller subprocess, which owns the holdout by design.

Reflection never touches it. Nothing else should import
``compute_dataset_identity``.

Dataset identity exists so an audit cannot silently score a candidate against a
different dataset than the one that produced the public snapshot. A drifted
anchor directory would make holdout numbers meaningless while still looking
like a valid audit, so identity is recorded at ``init``, recomputed
independently by the auditor, and a mismatch refuses the audit.

Phase 2 note: the boundary here is process-level. Separate OS ownership and
read-only mounts for anchors remain deferred under AR-02.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..dataset_env import EvalCase, load_cases_from_dir, split_cases_for_holdout
from .eval_records import case_to_record


#: Environment variable consulted when no ``--anchors-dir`` is given.
ANCHORS_DIR_ENV_VAR = "GODEL_RESIDENT_ANCHORS_DIR"

#: Development fallback only. Anchors living inside the package, under the same
#: OS account as the agent, is a convenience for working in a checkout — not the
#: production anchor location. Point --anchors-dir or $GODEL_RESIDENT_ANCHORS_DIR
#: somewhere the agent's own user cannot rewrite.
_PACKAGE_EVAL_SETS = Path(__file__).resolve().parent.parent / "eval_sets"

DEFAULT_SPLIT_SEED = "godel-agent-holdout-v1"
DEFAULT_HOLDOUT_FRACTION = 0.25


def resolve_anchors_dir(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the anchor source: explicit argument, then env var, then package."""

    if explicit is not None and str(explicit).strip():
        return Path(explicit).expanduser().resolve()
    from_env = os.environ.get(ANCHORS_DIR_ENV_VAR, "")
    if from_env.strip():
        return Path(from_env).expanduser().resolve()
    return _PACKAGE_EVAL_SETS


def is_development_anchor_location(path: Path) -> bool:
    return path == _PACKAGE_EVAL_SETS


@dataclass(frozen=True)
class DatasetIdentity:
    """Canonical identity of an anchor dataset and the split taken from it."""

    manifest_hash: str
    split_seed: str
    holdout_fraction: float
    total_cases: int
    public_cases: int
    holdout_cases: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest_hash": self.manifest_hash,
            "split_seed": self.split_seed,
            "holdout_fraction": self.holdout_fraction,
            "total_cases": self.total_cases,
            "public_cases": self.public_cases,
            "holdout_cases": self.holdout_cases,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DatasetIdentity":
        return cls(
            manifest_hash=payload["manifest_hash"],
            split_seed=payload["split_seed"],
            holdout_fraction=float(payload["holdout_fraction"]),
            total_cases=int(payload["total_cases"]),
            public_cases=int(payload["public_cases"]),
            holdout_cases=int(payload["holdout_cases"]),
        )

    def mismatch_reason(self, other: "DatasetIdentity") -> str:
        """Empty string when the two identities agree; otherwise why they do not."""

        for field_name in (
            "manifest_hash",
            "split_seed",
            "holdout_fraction",
            "total_cases",
            "public_cases",
            "holdout_cases",
        ):
            mine = getattr(self, field_name)
            theirs = getattr(other, field_name)
            if mine != theirs:
                return f"{field_name} differs: expected {mine!r}, anchor source has {theirs!r}"
        return ""


def dataset_manifest_hash(cases: list[EvalCase]) -> str:
    """Content hash of the whole dataset, independent of file layout or order.

    Records are canonicalised and sorted, so renaming a file or reordering lines
    does not change identity, while changing, adding, or removing any case does.
    """

    lines = sorted(
        json.dumps(case_to_record(case), sort_keys=True, ensure_ascii=False) for case in cases
    )
    digest = hashlib.sha256()
    for line in lines:
        digest.update(line.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def load_anchor_split(
    anchors_dir: Path,
    holdout_fraction: float = DEFAULT_HOLDOUT_FRACTION,
    split_seed: str = DEFAULT_SPLIT_SEED,
) -> tuple[DatasetIdentity, list[EvalCase], list[EvalCase]]:
    """Load the anchor dataset and split it. **Materialises holdout labels.**

    Only ``init`` and the auditor controller may call this. It returns holdout
    cases, so calling it anywhere on the reflection path would defeat the entire
    boundary.
    """

    all_cases = load_cases_from_dir(anchors_dir)
    public_cases, holdout_cases = split_cases_for_holdout(
        all_cases, holdout_fraction=holdout_fraction, seed=split_seed
    )
    identity = DatasetIdentity(
        manifest_hash=dataset_manifest_hash(all_cases),
        split_seed=split_seed,
        holdout_fraction=holdout_fraction,
        total_cases=len(all_cases),
        public_cases=len(public_cases),
        holdout_cases=len(holdout_cases),
    )
    return identity, public_cases, holdout_cases
