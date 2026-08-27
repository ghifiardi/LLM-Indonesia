"""Observation evidence, computed purely from durable rows.

Nothing here reads in-memory supervisor state, so a report generated after a
restart is identical to one generated before it. That is not a stylistic
preference: a readiness document whose contents depend on which process
happened to render it is not evidence of anything.

The central idea is the **qualifying window**. ``min_duration_hours`` measures
continuous operation under one unchanged anchor and dataset identity, with
frozen spans excluded — not wall-clock elapsed since the first event. A system
that ran for a week, was reconfigured on day three and spent day five frozen has
not observed a week of anything.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ..store import (
    IDENTITY_CHANGED_EVENT,
    SCHEMA_MIGRATED_EVENT,
    ResidentStore,
)

TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"

#: Structured causes a freeze may name. Anything else is unexplained.
CAUSE_BUDGET = "budget_breach"
CAUSE_ANCHOR_DRIFT = "anchor_drift"
CAUSE_ANCHOR_UNUSABLE = "anchor_unusable"
CAUSE_CHAMPION_VETO = "champion_hard_veto"
CAUSE_CANARY_REVERT = "canary_auto_revert"
CAUSE_OPERATOR = "operator"
CAUSE_UNEXPLAINED = "unexplained"

EXPLAINED_CAUSES = frozenset(
    {
        CAUSE_BUDGET,
        CAUSE_ANCHOR_DRIFT,
        CAUSE_ANCHOR_UNUSABLE,
        CAUSE_CHAMPION_VETO,
        CAUSE_CANARY_REVERT,
        CAUSE_OPERATOR,
    }
)


def parse_stamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, TIMESTAMP_FORMAT).replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def format_stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass(frozen=True)
class Segment:
    start: datetime
    end: datetime

    @property
    def seconds(self) -> float:
        return max(0.0, (self.end - self.start).total_seconds())

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": format_stamp(self.start),
            "end": format_stamp(self.end),
            "hours": round(self.seconds / 3600.0, 3),
        }


def freeze_spans(store: ResidentStore) -> list[tuple[datetime, datetime]]:
    """Intervals during which the resident was frozen.

    An unresolved freeze runs to now: a system that is frozen right now is not
    accumulating healthy serving time.
    """

    now = datetime.now(timezone.utc)
    spans: list[tuple[datetime, datetime]] = []
    for row in store.list_freezes():
        start = parse_stamp(row["created_at"])
        if start is None:
            continue
        end = parse_stamp(row["resolved_at"]) or now
        spans.append((start, max(start, end)))
    return sorted(spans)


def supervisor_spans(store: ResidentStore) -> list[Segment]:
    """Intervals backed by durable supervisor lifecycle observations.

    A lone ``started`` row is a point observation, not evidence that the
    process stayed alive until the report was rendered. Starts, heartbeats,
    and graceful stops form a chain only while adjacent observations remain
    within the supervisor's heartbeat grace. The final span ends at the last
    durable observation — never at ``now``.

    A quick launchd restart stays in one chain, which is intentional: the
    restart criterion exists to observe bounded recovery in production. A
    long gap starts a new span and cannot be hidden inside elapsed wall time.
    """

    from ..supervisor import (
        SUPERVISOR_EVENT,
        SUPERVISOR_HEARTBEAT_MAX_GAP_SECONDS,
    )

    lifecycle: list[tuple[datetime, str]] = []
    for event in store.list_events(kind=SUPERVISOR_EVENT):
        moment = parse_stamp(event.created_at)
        action = event.payload.get("event")
        if moment is not None and action in {"started", "heartbeat", "stopped"}:
            lifecycle.append((moment, action))
    lifecycle.sort(key=lambda item: item[0])

    spans: list[Segment] = []
    start: datetime | None = None
    last_seen: datetime | None = None
    stopped = False
    for moment, action in lifecycle:
        if start is None:
            if action == "stopped":
                continue
            start = last_seen = moment
            stopped = False
            continue

        assert last_seen is not None
        gap = (moment - last_seen).total_seconds()
        continues = gap <= SUPERVISOR_HEARTBEAT_MAX_GAP_SECONDS
        if action == "heartbeat" and stopped:
            continues = False

        if not continues:
            if last_seen > start:
                spans.append(Segment(start, last_seen))
            if action == "stopped":
                start = last_seen = None
                stopped = False
                continue
            start = last_seen = moment
            stopped = False
            continue

        last_seen = moment
        stopped = action == "stopped"

    if start is not None and last_seen is not None and last_seen > start:
        spans.append(Segment(start, last_seen))
    return spans


def window_segments(store: ResidentStore) -> list[Segment]:
    """Supervisor-observed, same-identity, unfrozen spans, oldest first."""

    events = store.list_events()
    if not events:
        return []
    live = supervisor_spans(store)
    if not live:
        return []

    identity_cuts: set[datetime] = set()
    for event in events:
        if event.kind in (IDENTITY_CHANGED_EVENT, SCHEMA_MIGRATED_EVENT):
            moment = parse_stamp(event.created_at)
            if moment is not None:
                identity_cuts.add(moment)

    raw: list[Segment] = []
    for span in live:
        cuts = sorted(
            {span.start, span.end}
            | {moment for moment in identity_cuts if span.start < moment < span.end}
        )
        raw.extend(Segment(a, b) for a, b in zip(cuts, cuts[1:]) if b > a)

    # Subtract frozen spans. A freeze does not merely pause the clock — it
    # segments the window, because the span either side of it was observed
    # under different circumstances.
    spans = freeze_spans(store)
    segments: list[Segment] = []
    for segment in raw:
        pieces = [(segment.start, segment.end)]
        for frozen_start, frozen_end in spans:
            next_pieces: list[tuple[datetime, datetime]] = []
            for piece_start, piece_end in pieces:
                if frozen_end <= piece_start or frozen_start >= piece_end:
                    next_pieces.append((piece_start, piece_end))
                    continue
                if frozen_start > piece_start:
                    next_pieces.append((piece_start, frozen_start))
                if frozen_end < piece_end:
                    next_pieces.append((frozen_end, piece_end))
            pieces = next_pieces
        segments.extend(Segment(a, b) for a, b in pieces if b > a)
    return sorted(segments, key=lambda item: item.start)


def longest_segment(store: ResidentStore) -> Segment | None:
    segments = window_segments(store)
    return max(segments, key=lambda item: item.seconds) if segments else None


def classify_freeze(row: dict[str, Any]) -> str:
    """Name the structured cause of a freeze, or mark it unexplained.

    ``max_unexplained_freezes = 0`` needs a concrete definition or it is
    unenforceable. A freeze whose trigger names nothing recognisable is exactly
    the case the criterion exists to catch.
    """

    try:
        trigger = json.loads(row.get("trigger_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        return CAUSE_UNEXPLAINED
    if not isinstance(trigger, dict):
        return CAUSE_UNEXPLAINED

    if "counters" in trigger or "consecutive_gate_failures" in trigger:
        return CAUSE_BUDGET
    if "mismatch_field" in trigger:
        return CAUSE_ANCHOR_DRIFT
    if "anchor_error" in trigger:
        return CAUSE_ANCHOR_UNUSABLE
    if "veto" in trigger and "candidate_id" in trigger:
        return CAUSE_CHAMPION_VETO
    if "activation_id" in trigger and "breaches" in trigger:
        return CAUSE_CANARY_REVERT
    # An operator freeze is explained by a person having said why, and who.
    if (row.get("reason") or "").strip() and (row.get("actor") or "").strip():
        return CAUSE_OPERATOR
    return CAUSE_UNEXPLAINED


def freezes_in(store: ResidentStore, segment: Segment | None) -> list[dict[str, Any]]:
    rows = []
    for row in store.list_freezes():
        moment = parse_stamp(row["created_at"])
        if moment is None:
            continue
        if segment is not None and not (segment.start <= moment <= segment.end):
            # A freeze *ends* a segment, so one that bounds this window still
            # belongs to the report: it explains why the window stopped.
            if not (segment.end <= moment <= segment.end + timedelta(seconds=1)):
                continue
        rows.append({**row, "cause": classify_freeze(row)})
    return rows


def _within(stamp: str | None, segment: Segment | None) -> bool:
    if segment is None:
        return False
    moment = parse_stamp(stamp)
    return moment is not None and segment.start <= moment <= segment.end


@dataclass
class Observations:
    """Everything the report needs, computed once from durable rows."""

    segment: Segment | None
    segments: list[Segment] = field(default_factory=list)
    duration_hours: float = 0.0
    served_requests: int = 0
    reflect_cycles: int = 0
    audits: int = 0
    freezes: list[dict[str, Any]] = field(default_factory=list)
    unexplained_freezes: int = 0
    supervisor_starts: int = 0
    supervisor_restart_observed: bool = False
    duplicate_cycle_after_restart: bool = False
    canary_activations: int = 0
    canary_auto_reverts: int = 0
    canary_champion_moved: bool = False
    vetoes: int = 0
    labelled: int = 0
    false_vetoes: int = 0
    invalidated_labels: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "window": self.segment.to_dict() if self.segment else None,
            "segments": [segment.to_dict() for segment in self.segments],
            "duration_hours": round(self.duration_hours, 3),
            "served_requests": self.served_requests,
            "reflect_cycles": self.reflect_cycles,
            "audits": self.audits,
            "freezes": [
                {"freeze_id": row["freeze_id"], "created_at": row["created_at"],
                 "cause": row["cause"], "reason": row.get("reason", "")}
                for row in self.freezes
            ],
            "unexplained_freezes": self.unexplained_freezes,
            "supervisor_starts": self.supervisor_starts,
            "supervisor_restart_observed": self.supervisor_restart_observed,
            "duplicate_cycle_after_restart": self.duplicate_cycle_after_restart,
            "canary_activations": self.canary_activations,
            "canary_auto_reverts": self.canary_auto_reverts,
            "canary_champion_moved": self.canary_champion_moved,
            "vetoes": self.vetoes,
            "labelled": self.labelled,
            "false_vetoes": self.false_vetoes,
            "invalidated_labels": self.invalidated_labels,
        }

    @property
    def false_veto_rate(self) -> float | None:
        if self.labelled == 0:
            return None
        return self.false_vetoes / self.labelled


def gather(store: ResidentStore) -> Observations:
    """Compute every observation aggregate. Read-only, from persisted rows only."""

    from ..supervisor import CLOCK_EVENT, SUPERVISOR_EVENT
    from ..reflect import REFLECT_CYCLE_EVENT
    from ..canary import CANARY_ACTIVATED_EVENT, CANARY_CLEARED_EVENT

    segments = window_segments(store)
    segment = max(segments, key=lambda item: item.seconds) if segments else None
    observations = Observations(segment=segment, segments=segments)
    # A freeze is itself durable evidence. In particular, an unexplained freeze
    # must not disappear merely because there was too little healthy liveness
    # evidence to form a qualifying segment.
    observations.freezes = freezes_in(store, segment)
    observations.unexplained_freezes = sum(
        1 for row in observations.freezes if row["cause"] == CAUSE_UNEXPLAINED
    )
    if segment is None:
        return observations
    observations.duration_hours = segment.seconds / 3600.0

    observations.served_requests = sum(
        1 for row in store.list_served_requests() if _within(row["created_at"], segment)
    )
    cycle_stamps = [
        parse_stamp(event.created_at)
        for event in store.list_events(kind=REFLECT_CYCLE_EVENT)
        if _within(event.created_at, segment)
    ]
    observations.reflect_cycles = len(cycle_stamps)
    # list_audits returns AuditRecord objects, not rows.
    observations.audits = sum(
        1 for record in store.list_audits() if _within(record.created_at, segment)
    )

    starts = [
        event for event in store.list_events(kind=SUPERVISOR_EVENT)
        if event.payload.get("event") == "started" and _within(event.created_at, segment)
    ]
    observations.supervisor_starts = len(starts)
    observations.supervisor_restart_observed = len(starts) >= 2
    # A restart that re-fired a cycle already completed would show as two
    # reflect cycles moments apart. Proxy, and named as one in the report.
    ordered = sorted(stamp for stamp in cycle_stamps if stamp is not None)
    observations.duplicate_cycle_after_restart = any(
        (later - earlier).total_seconds() < 5
        for earlier, later in zip(ordered, ordered[1:])
    )

    activations = [
        event for event in store.list_events(kind=CANARY_ACTIVATED_EVENT)
        if _within(event.created_at, segment)
    ]
    clears = [
        event for event in store.list_events(kind=CANARY_CLEARED_EVENT)
        if _within(event.created_at, segment)
    ]
    observations.canary_activations = len(activations)
    observations.canary_auto_reverts = sum(
        1 for event in clears if event.payload.get("automatic")
    )
    if activations:
        first = parse_stamp(activations[-1].created_at)
        last = parse_stamp(clears[0].created_at) if clears else segment.end
        observations.canary_champion_moved = any(
            event.kind == "promotion_finalized"
            and first is not None
            and last is not None
            and first <= (parse_stamp(event.created_at) or segment.end) <= last
            for event in store.list_events()
        )

    veto_rows = [
        row for row in store.list_serving_vetoes() if _within(row["created_at"], segment)
    ]
    observations.vetoes = len(veto_rows)
    by_request = {
        row["request_id"]: row for row in veto_rows if row.get("request_id")
    }
    for label in store.list_veto_labels():
        source = by_request.get(label["request_id"])
        if source is None:
            continue
        # A label describes one artifact's output. If what was served differs
        # from what was labelled, the judgement is about something else.
        if (
            label["artifact_hash"] != source["artifact_hash"]
            or label["veto"] != source["veto"]
        ):
            observations.invalidated_labels += 1
            continue
        observations.labelled += 1
        if label["label"] == "false_veto":
            observations.false_vetoes += 1
    return observations
