"""Budget counters and the breach that freezes.

The split this module rests on: **limits are anchors, counters are state.**
Limits live in the human-owned ``budget.toml`` and the resident cannot write
them. Counters live in ``state.db``, which the resident does write — but they
are *derived* by counting append-only increment rows, and every increment names
the event that caused it. A limit that was reached can always be explained.

Which action increments which counter:

===========================  ================================================
counter                      incremented by
===========================  ================================================
``reflect_cycles``           one per completed ``reflect-once``
``candidate_executions``     one per candidate execution through the isolated
                             runner: each reflection, and each gate replay
``promotions``               one per completed promotion, rollback included
``audits``                   one per completed ``audit``
===========================  ================================================

``consecutive_gate_failures`` is not a counter here: it is derived from the
immutable gate-verdict log, so it cannot drift from the evidence.

A breach freezes through ``freeze.freeze`` — the single freeze path — never
through a mechanism of its own.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .anchors import BudgetLimits
from .freeze import FreezeRecord, freeze
from .store import ResidentStore

COUNTER_REFLECT_CYCLES = "reflect_cycles"
COUNTER_CANDIDATE_EXECUTIONS = "candidate_executions"
COUNTER_PROMOTIONS = "promotions"
COUNTER_AUDITS = "audits"

COUNTERS = (
    COUNTER_REFLECT_CYCLES,
    COUNTER_CANDIDATE_EXECUTIONS,
    COUNTER_PROMOTIONS,
    COUNTER_AUDITS,
)

#: counter -> the BudgetLimits field that bounds it.
COUNTER_LIMITS = {
    COUNTER_REFLECT_CYCLES: "max_reflect_cycles_per_day",
    COUNTER_CANDIDATE_EXECUTIONS: "max_candidate_executions_per_day",
    COUNTER_PROMOTIONS: "max_promotions_per_day",
    COUNTER_AUDITS: "max_audits_per_day",
}

BUDGET_BREACH_EVENT = "budget_breached"


def current_window() -> str:
    """The counting window: one UTC day."""

    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@dataclass(frozen=True)
class BudgetSnapshot:
    """Counters and limits read together, once.

    Taken once per gate evaluation so every veto that consults a budget sees
    the same numbers; reading them piecemeal could let a counter move mid-
    evaluation and produce a verdict that never described one moment.
    """

    window: str
    counts: dict[str, int] = field(default_factory=dict)
    limits: dict[str, int] = field(default_factory=dict)

    def breaches(self) -> list[str]:
        over: list[str] = []
        for counter, limit_field in COUNTER_LIMITS.items():
            limit = self.limits.get(limit_field)
            if limit is None:
                continue
            if self.counts.get(counter, 0) > limit:
                over.append(counter)
        return over

    def to_dict(self) -> dict[str, Any]:
        return {
            "window": self.window,
            "counts": dict(self.counts),
            "limits": dict(self.limits),
            "breaches": self.breaches(),
        }


def snapshot(
    store: ResidentStore, limits: BudgetLimits, window: str | None = None
) -> BudgetSnapshot:
    window = window or current_window()
    counts = store.budget_snapshot(window)
    return BudgetSnapshot(
        window=window,
        counts={counter: counts.get(counter, 0) for counter in COUNTERS},
        limits={
            field_name: getattr(limits, field_name) for field_name in COUNTER_LIMITS.values()
        },
    )


def record(
    store: ResidentStore,
    counter: str,
    event_id: str,
    candidate_id: str | None = None,
    window: str | None = None,
) -> None:
    """Record one increment, tied to the event that caused it."""

    if counter not in COUNTERS:
        raise ValueError(f"Unknown budget counter {counter!r}.")
    store.record_budget_increment(
        counter=counter, window=window or current_window(), event_id=event_id,
        candidate_id=candidate_id,
    )


def enforce(
    store: ResidentStore, limits: BudgetLimits, window: str | None = None
) -> FreezeRecord | None:
    """Freeze if any counter is over its limit, or gate failures have piled up.

    Returns the active freeze when one results, else None. Freezing goes
    through ``freeze.freeze``, so a budget breach and an operator freeze are
    the same state with the same audit trail and the same way out.
    """

    view = snapshot(store, limits, window=window)
    breaches = view.breaches()
    consecutive = store.consecutive_gate_failures()
    gate_breach = consecutive > limits.max_consecutive_gate_failures

    if not breaches and not gate_breach:
        return None

    trigger: dict[str, Any] = {"window": view.window}
    if breaches:
        trigger["counters"] = {
            counter: {
                "count": view.counts.get(counter, 0),
                "limit": view.limits.get(COUNTER_LIMITS[counter]),
            }
            for counter in breaches
        }
    if gate_breach:
        trigger["consecutive_gate_failures"] = {
            "count": consecutive,
            "limit": limits.max_consecutive_gate_failures,
        }

    parts = []
    if breaches:
        parts.append("budget exceeded for " + ", ".join(sorted(breaches)))
    if gate_breach:
        parts.append(
            f"{consecutive} consecutive gate failures "
            f"(limit {limits.max_consecutive_gate_failures})"
        )
    reason = "; ".join(parts)

    store.append_event(BUDGET_BREACH_EVENT, payload=trigger)
    return freeze(store, reason=reason, actor="budget", trigger=trigger)
