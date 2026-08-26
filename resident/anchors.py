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

    def mismatch_field(self, other: "DatasetIdentity") -> str | None:
        """Name of the first differing field, or None when the two agree.

        Returns a field *name*, never a rendered message: the name is drawn
        from a fixed set the wire schema knows, so it carries no free text.
        """

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
                return field_name
        return None


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


# --- gate thresholds --------------------------------------------------------
#
# Thresholds are anchors, not state. They live in the human-owned anchor
# directory and are never written by the resident: a gate whose numbers the
# agent can edit is not a gate. Their identity is recorded at init and
# re-checked at every evaluation, so swapping the file between init and
# promotion fails closed rather than quietly weakening the gate.

GATE_THRESHOLDS_FILENAME = "gate.toml"
BUDGET_LIMITS_FILENAME = "budget.toml"


class ThresholdError(ValueError):
    """Raised when a threshold file is missing, unparseable, or out of range.

    Always fails closed. There is deliberately no built-in default: silently
    substituting one would mean a gate could be disarmed by deleting a file.
    """


@dataclass(frozen=True)
class ThresholdIdentity:
    """Identity of the threshold files in force."""

    gate_hash: str
    budget_hash: str
    values: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate_hash": self.gate_hash,
            "budget_hash": self.budget_hash,
            "values": dict(self.values),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ThresholdIdentity":
        return cls(
            gate_hash=payload["gate_hash"],
            budget_hash=payload["budget_hash"],
            values=dict(payload.get("values") or {}),
        )

    def mismatch_field(self, other: "ThresholdIdentity") -> str | None:
        if self.gate_hash != other.gate_hash:
            return "gate_hash"
        if self.budget_hash != other.budget_hash:
            return "budget_hash"
        if self.values != other.values:
            return "values"
        return None


@dataclass(frozen=True)
class GateThresholds:
    """Numbers the promotion gate enforces."""

    min_public_delta: float
    replay_epsilon: float
    holdout_epsilon: float
    max_safety_failures: int


@dataclass(frozen=True)
class BudgetLimits:
    """Daily ceilings. Exceeding one freezes the resident."""

    max_reflect_cycles_per_day: int
    max_candidate_executions_per_day: int
    max_promotions_per_day: int
    max_audits_per_day: int
    max_consecutive_gate_failures: int


#: (key, type, low, high) for each threshold. Ranges are inclusive.
_GATE_SPEC = (
    ("min_public_delta", float, 0.0, 1.0),
    ("replay_epsilon", float, 0.0, 0.1),
    ("holdout_epsilon", float, 0.0, 0.5),
    ("max_safety_failures", int, 0, 0),
)
_BUDGET_SPEC = (
    ("max_reflect_cycles_per_day", int, 1, 100000),
    ("max_candidate_executions_per_day", int, 1, 100000),
    ("max_promotions_per_day", int, 1, 1000),
    ("max_audits_per_day", int, 1, 10000),
    ("max_consecutive_gate_failures", int, 1, 1000),
)


def _read_toml_section(path: Path, section: str) -> tuple[str, dict[str, Any]]:
    import hashlib
    import tomllib

    if not path.is_file():
        raise ThresholdError(
            f"Required threshold file {path} is missing. Create it (see "
            "resident/README.md); there is no built-in default."
        )
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ThresholdError(f"Threshold file {path} is unreadable: {exc}") from exc
    try:
        parsed = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ThresholdError(f"Threshold file {path} is not valid TOML: {exc}") from exc
    body = parsed.get(section)
    if not isinstance(body, dict):
        raise ThresholdError(f"Threshold file {path} has no [{section}] table.")
    return hashlib.sha256(raw).hexdigest(), body


def _coerce(body: dict[str, Any], spec: tuple, path: Path) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for key, kind, low, high in spec:
        if key not in body:
            raise ThresholdError(f"{path}: missing required threshold {key!r}.")
        raw = body[key]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ThresholdError(f"{path}: {key!r} must be a number.")
        if kind is int and not isinstance(raw, int):
            raise ThresholdError(f"{path}: {key!r} must be an integer.")
        value = kind(raw)
        if not low <= value <= high:
            raise ThresholdError(
                f"{path}: {key!r} = {value!r} is outside the permitted range [{low}, {high}]."
            )
        values[key] = value
    unknown = set(body) - {key for key, _, _, _ in spec}
    if unknown:
        raise ThresholdError(f"{path}: unknown threshold keys {sorted(unknown)}.")
    return values


def load_thresholds(
    anchors_dir: Path,
) -> tuple[ThresholdIdentity, GateThresholds, BudgetLimits]:
    """Load and validate both anchor threshold files. Raises ThresholdError."""

    anchors_dir = Path(anchors_dir)
    gate_path = anchors_dir / GATE_THRESHOLDS_FILENAME
    budget_path = anchors_dir / BUDGET_LIMITS_FILENAME

    gate_hash, gate_body = _read_toml_section(gate_path, "gate")
    budget_hash, budget_body = _read_toml_section(budget_path, "budget")
    gate_values = _coerce(gate_body, _GATE_SPEC, gate_path)
    budget_values = _coerce(budget_body, _BUDGET_SPEC, budget_path)

    identity = ThresholdIdentity(
        gate_hash=gate_hash,
        budget_hash=budget_hash,
        values={**gate_values, **budget_values},
    )
    return (
        identity,
        GateThresholds(**gate_values),
        BudgetLimits(**budget_values),
    )
