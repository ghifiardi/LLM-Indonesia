"""The readiness report: advisory, read-only, and bound to what it observed.

The report renders every drill and every observation against its criterion, and
computes one overall verdict. It is a **document a human signs off on**. Nothing
consumes it: no code reads ``readiness_reports`` to authorise anything, and this
package does not import the promoter. Phase 5B does not begin because a file
says PASS — it begins because a person read the file and said so.

A report is only meaningful for the exact configuration it observed, so every
row records the dataset identity, the threshold identity (serving and readiness
anchors included), the champion at report time, the window boundaries, and a
build fingerprint. If the identities moved mid-window, the affected items are
downgraded rather than reported as though the window were uniform.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..anchors import ReadinessCriteria, ThresholdError, load_every_anchor, resolve_anchors_dir
from ..store import (
    CONFIG_DATASET_IDENTITY,
    CONFIG_THRESHOLD_IDENTITY,
    ResidentStore,
    new_id,
    utcnow,
)
from . import observe
from .checks import CATALOGUE
from .verdicts import FAIL, INSUFFICIENT, PASS, combine

REPORT_SCHEMA_VERSION = 1
REPORT_EVENT = "readiness_report"


@dataclass(frozen=True)
class Item:
    name: str
    kind: str
    verdict: str
    observed: Any = None
    required: Any = None
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "verdict": self.verdict,
            "observed": self.observed,
            "required": self.required,
            "detail": self.detail,
        }


@dataclass
class Report:
    report_id: str
    created_at: str
    verdict: str
    items: list[Item] = field(default_factory=list)
    dataset_identity: dict[str, Any] = field(default_factory=dict)
    threshold_identity: dict[str, Any] = field(default_factory=dict)
    champion_candidate_id: str | None = None
    champion_artifact_hash: str | None = None
    window_start: str | None = None
    window_end: str | None = None
    build_fingerprint: str = ""
    summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.report_id,
            "created_at": self.created_at,
            "schema_version": REPORT_SCHEMA_VERSION,
            "verdict": self.verdict,
            "items": [item.to_dict() for item in self.items],
            "dataset_identity": dict(self.dataset_identity),
            "threshold_identity": dict(self.threshold_identity),
            "champion_candidate_id": self.champion_candidate_id,
            "champion_artifact_hash": self.champion_artifact_hash,
            "window_start": self.window_start,
            "window_end": self.window_end,
            "build_fingerprint": self.build_fingerprint,
            "summary": dict(self.summary),
        }


def build_fingerprint() -> str:
    """A commit id when one is available, else empty. Never guesses."""

    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=10,
            cwd=str(Path(__file__).resolve().parents[2]),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _threshold(name: str, observed: Any, required: Any, ok: bool,
               insufficient: bool = False, detail: str = "") -> Item:
    if insufficient:
        verdict = INSUFFICIENT
    else:
        verdict = PASS if ok else FAIL
    return Item(name=name, kind="observation", verdict=verdict,
                observed=observed, required=required, detail=detail)


def _drill_items(store: ResidentStore) -> list[Item]:
    items: list[Item] = []
    for name, drill in CATALOGUE.items():
        rows = store.list_readiness_checks(name=name, limit=1)
        if not rows:
            items.append(
                Item(name=name, kind="drill", verdict=INSUFFICIENT,
                     detail="never run")
            )
            continue
        row = rows[0]
        items.append(
            Item(
                name=name,
                kind="drill",
                verdict=row["outcome"],
                observed=row["created_at"],
                required=drill.description,
                detail=(
                    row["detail"]
                    or (
                        "isolated"
                        + (
                            ", drill-owned dataset"
                            if json.loads(row["evidence_json"] or "{}").get(
                                "drill_owned_dataset"
                            )
                            else ""
                        )
                    )
                ),
            )
        )
    return items


def _observation_items(
    data: observe.Observations, criteria: ReadinessCriteria
) -> list[Item]:
    items: list[Item] = []
    no_window = data.segment is None

    items.append(
        _threshold(
            "continuous_window_hours",
            round(data.duration_hours, 2),
            criteria.min_duration_hours,
            data.duration_hours >= criteria.min_duration_hours,
            insufficient=no_window or data.duration_hours < criteria.min_duration_hours,
            detail=(
                "continuous operation under one identity, frozen spans excluded; "
                f"{len(data.segments)} segment(s) contributed"
            ),
        )
    )
    for name, observed, required in (
        ("served_requests", data.served_requests, criteria.min_served_requests),
        ("reflect_cycles", data.reflect_cycles, criteria.min_reflect_cycles),
        ("audits", data.audits, criteria.min_audits),
    ):
        items.append(
            _threshold(name, observed, required, observed >= required,
                       insufficient=observed < required,
                       detail="counted within the qualifying window")
        )

    # A freeze that should not have happened is a defect, not missing evidence.
    items.append(
        Item(
            name="unexplained_freezes",
            kind="observation",
            verdict=PASS if data.unexplained_freezes <= criteria.max_unexplained_freezes
            else FAIL,
            observed=data.unexplained_freezes,
            required=criteria.max_unexplained_freezes,
            detail="a freeze whose trigger names no recognised structured cause",
        )
    )

    if not data.supervisor_restart_observed:
        items.append(
            Item(name="supervisor_restart", kind="observation", verdict=INSUFFICIENT,
                 observed=data.supervisor_starts, required=">= 2 starts",
                 detail="no restart occurred naturally in the window")
        )
    else:
        items.append(
            Item(
                name="supervisor_restart",
                kind="observation",
                verdict=FAIL if data.duplicate_cycle_after_restart else PASS,
                observed=data.supervisor_starts,
                required=">= 2 starts, no duplicate cycle",
                detail=(
                    "duplicate-firing is checked by proximity of reflect cycles, "
                    "which is a proxy rather than a direct observation"
                ),
            )
        )

    if data.canary_activations == 0:
        items.append(
            Item(name="canary_auto_revert", kind="observation", verdict=INSUFFICIENT,
                 observed=0, required=">= 1 completed activation",
                 detail="no canary was activated in the window")
        )
    elif data.canary_champion_moved:
        items.append(
            Item(name="canary_auto_revert", kind="observation", verdict=FAIL,
                 observed=data.canary_auto_reverts,
                 required="champion unchanged across the activation",
                 detail="the champion moved while a canary was active")
        )
    else:
        items.append(
            Item(
                name="canary_auto_revert",
                kind="observation",
                verdict=PASS,
                observed={"activations": data.canary_activations,
                          "auto_reverts": data.canary_auto_reverts},
                required=">= 1 completed activation, champion unchanged",
                detail="observed in production, not drilled",
            )
        )

    rate = data.false_veto_rate
    if data.labelled < criteria.min_labelled_vetoes:
        items.append(
            Item(
                name="false_veto_rate",
                kind="observation",
                verdict=INSUFFICIENT,
                observed={"labelled": data.labelled, "vetoes": data.vetoes,
                          "invalidated": data.invalidated_labels},
                required=f">= {criteria.min_labelled_vetoes} labelled",
                detail=(
                    "a rate below the minimum sample is a number with nothing "
                    "behind it, so none is stated"
                ),
            )
        )
    else:
        items.append(
            Item(
                name="false_veto_rate",
                kind="observation",
                verdict=PASS if rate is not None and rate <= criteria.max_false_veto_rate
                else FAIL,
                observed={"rate": round(rate, 4) if rate is not None else None,
                          "labelled": data.labelled,
                          "invalidated": data.invalidated_labels},
                required=criteria.max_false_veto_rate,
                detail="human-labelled sample; outputs reproduced on demand, never retained",
            )
        )
    return items


def generate(
    store: ResidentStore,
    anchors_dir: str | Path | None = None,
    record: bool = True,
) -> Report:
    """Compute a readiness report. Read-only apart from the report row itself."""

    resolved = resolve_anchors_dir(anchors_dir)
    try:
        identity, _gate, _budget, _serving, criteria = load_every_anchor(resolved)
        threshold_identity = identity.to_dict()
        anchor_error = ""
    except ThresholdError as exc:
        criteria = None
        threshold_identity = {}
        anchor_error = str(exc)

    dataset_identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY) or "{}")
    recorded_threshold = json.loads(store.get_config(CONFIG_THRESHOLD_IDENTITY) or "{}")
    champion = store.read_champion()
    data = observe.gather(store)

    items = _drill_items(store)

    if criteria is None:
        items.append(
            Item(name="anchors", kind="observation", verdict=INSUFFICIENT,
                 detail=f"anchors unusable: {anchor_error}")
        )
    else:
        drifted = recorded_threshold and recorded_threshold != threshold_identity
        if drifted:
            # The window was observed under a configuration that is no longer
            # in force, so its observations describe something else.
            items.append(
                Item(name="anchor_identity", kind="observation", verdict=INSUFFICIENT,
                     observed="changed since init",
                     required="unchanged for the whole window",
                     detail="observation items downgraded: the configuration moved")
            )
            items.extend(
                Item(name=item.name, kind=item.kind, verdict=INSUFFICIENT,
                     observed=item.observed, required=item.required,
                     detail="downgraded: anchor identity changed during the window")
                for item in _observation_items(data, criteria)
            )
        else:
            items.append(
                Item(name="anchor_identity", kind="observation", verdict=PASS,
                     observed="unchanged", required="unchanged for the whole window")
            )
            items.extend(_observation_items(data, criteria))

    report = Report(
        report_id=new_id(),
        created_at=utcnow(),
        verdict=combine([item.verdict for item in items]),
        items=items,
        dataset_identity=dataset_identity,
        threshold_identity=threshold_identity,
        champion_candidate_id=champion.candidate_id if champion else None,
        champion_artifact_hash=champion.artifact_hash if champion else None,
        window_start=observe.format_stamp(data.segment.start) if data.segment else None,
        window_end=observe.format_stamp(data.segment.end) if data.segment else None,
        build_fingerprint=build_fingerprint(),
        summary=data.to_dict(),
    )

    if record:
        store.insert_readiness_report({**report.to_dict(), "items": [i.to_dict() for i in report.items]})
        store.append_event(
            REPORT_EVENT,
            payload={"report_id": report.report_id, "verdict": report.verdict},
        )
    return report


def render(report: Report) -> str:
    """The human-facing document."""

    marks = {PASS: "PASS", FAIL: "FAIL", INSUFFICIENT: "NO EVIDENCE"}
    lines = [
        "RESIDENT READINESS REPORT",
        "=" * 72,
        f"verdict          {marks[report.verdict]}",
        f"report           {report.report_id}",
        f"generated        {report.created_at}",
        f"build            {report.build_fingerprint or '(unknown)'}",
        f"champion         {report.champion_candidate_id or '(none)'}",
        f"dataset          {(report.dataset_identity.get('manifest_hash') or '(none)')[:16]}",
        f"anchors          gate={report.threshold_identity.get('gate_hash', '')[:12]} "
        f"readiness={report.threshold_identity.get('readiness_hash', '')[:12]}",
        f"window           {report.window_start or '(none)'} -> {report.window_end or '(none)'}",
        "",
        "DRILLS  (isolated state directories; the mechanism works on this build)",
        "-" * 72,
    ]
    for item in report.items:
        if item.kind != "drill":
            continue
        lines.append(f"  [{marks[item.verdict]:>11}]  {item.name}")
        if item.detail:
            lines.append(f"                 {item.detail[:90]}")

    lines += ["", "OBSERVATIONS  (what this deployment actually did)", "-" * 72]
    for item in report.items:
        if item.kind != "observation":
            continue
        observed = item.observed
        if isinstance(observed, dict):
            observed = ", ".join(f"{k}={v}" for k, v in observed.items())
        lines.append(
            f"  [{marks[item.verdict]:>11}]  {item.name:<26} "
            f"{'' if observed is None else observed}"
            + (f"  (need {item.required})" if item.required is not None else "")
        )
        if item.detail:
            lines.append(f"                 {item.detail[:90]}")

    summary = report.summary
    lines += [
        "",
        "WINDOW",
        "-" * 72,
        f"  segments contributing   {len(summary.get('segments') or [])}",
        f"  longest continuous      {summary.get('duration_hours', 0)} h",
        f"  freezes in window       {len(summary.get('freezes') or [])}",
    ]
    for freeze in summary.get("freezes") or []:
        lines.append(f"    {freeze['created_at']}  {freeze['cause']:<20} {freeze['reason'][:40]}")

    lines += [
        "",
        "This report is advisory. Nothing reads it to authorise anything, and no",
        "automatic promotion exists. A verdict of PASS is evidence for a human",
        "decision, not the decision.",
    ]
    return "\n".join(lines)
