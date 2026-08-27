"""Executes drills in isolation and records their results immutably.

Every drill runs against its own state directory, seeded from the same anchors,
with its own spool and runtime paths. Production counters, champion pointer and
freeze state are untouched — a certification that breaks what it certifies has
proved something about a broken system.

The *result* is recorded in the production store, marked ``is_drill`` and
carrying the directory it ran against, so nothing can later read a drill as if
it were production behaviour.
"""

from __future__ import annotations

import shutil
import tempfile
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..store import ResidentStore, new_id, utcnow
from .checks import CATALOGUE, SAFE_SEED, DrillResult, write_drill_dataset
from .verdicts import FAIL

DRILL_EVENT = "readiness_drill_run"


@dataclass(frozen=True)
class DrillRun:
    result: DrillResult
    state_dir: str
    check_id: str

    def to_dict(self) -> dict[str, Any]:
        return {**self.result.to_dict(), "state_dir": self.state_dir,
                "check_id": self.check_id}


def _seed_anchors(source: Path, destination: Path) -> Path:
    """Copy the anchor set so a drill cannot write the production anchors."""

    destination.mkdir(parents=True, exist_ok=True)
    for path in sorted(Path(source).iterdir()):
        if path.is_file():
            shutil.copy2(path, destination / path.name)
    return destination


def run_drill(
    name: str,
    anchors_dir: Path,
    drill_root: Path,
    seed_policy: str | None = None,
) -> DrillRun:
    """Run one drill in a fresh state directory. Never raises."""

    from ..promote import initialize

    drill = CATALOGUE.get(name)
    if drill is None:
        return DrillRun(
            result=DrillResult(name=name, outcome=FAIL, detail="unknown drill", evidence={}),
            state_dir="", check_id=new_id(),
        )

    workspace = Path(drill_root) / f"{name}-{new_id()[:8]}"
    state_dir = workspace / "state"
    anchors = _seed_anchors(Path(anchors_dir), workspace / "anchors")
    if drill.owns_dataset:
        # The drill supplies its own cases, so the mechanism is exercised rather
        # than blocked by whether the shipped policy set happens to be
        # promotable. The anchor *thresholds* are still the operator's.
        write_drill_dataset(anchors)

    store: ResidentStore | None = None
    try:
        store = ResidentStore.open(state_dir)
        initialize(
            store,
            env_name="id_support",
            seed_policy=seed_policy or drill.seed_policy,
            anchors_dir=str(anchors),
        )
        result = drill.function(store, anchors)
    except Exception as exc:
        result = DrillResult(
            name=name,
            outcome=FAIL,
            # The type and location, not the whole traceback: a drill runs real
            # policies against real queries and a traceback can quote them.
            detail=f"{type(exc).__name__} in {traceback.extract_tb(exc.__traceback__)[-1].name}",
            evidence={},
        )
    finally:
        if store is not None:
            try:
                store.close()
            except Exception:
                pass

    if drill.owns_dataset and result.evidence is not None:
        result = DrillResult(
            name=result.name,
            outcome=result.outcome,
            detail=result.detail,
            evidence={**(result.evidence or {}), "drill_owned_dataset": True},
        )
    return DrillRun(result=result, state_dir=str(state_dir), check_id=new_id())


def run_drills(
    store: ResidentStore,
    anchors_dir: Path,
    only: list[str] | None = None,
    drill_root: Path | None = None,
) -> list[DrillRun]:
    """Run the catalogue and record each result in the production store."""

    names = list(only) if only else list(CATALOGUE)
    unknown = [name for name in names if name not in CATALOGUE]
    if unknown:
        raise ValueError(f"Unknown drill(s): {sorted(unknown)}")

    temporary = drill_root is None
    root = Path(drill_root) if drill_root is not None else Path(
        tempfile.mkdtemp(prefix="resident-drill-")
    )
    runs: list[DrillRun] = []
    try:
        for name in names:
            run = run_drill(name, Path(anchors_dir), root)
            store.insert_readiness_check(
                {
                    "check_id": run.check_id,
                    "created_at": utcnow(),
                    "name": run.result.name,
                    "outcome": run.result.outcome,
                    "detail": run.result.detail,
                    "state_dir": run.state_dir,
                    "is_drill": True,
                    "evidence": run.result.evidence or {},
                }
            )
            runs.append(run)
        store.append_event(
            DRILL_EVENT,
            payload={
                "drills": [run.result.name for run in runs],
                "outcomes": {run.result.name: run.result.outcome for run in runs},
                "isolated": True,
            },
        )
    finally:
        if temporary:
            shutil.rmtree(root, ignore_errors=True)
    return runs
