"""Audited freeze and unfreeze. One mechanism, one path.

Freeze is a database record, not a sentinel file. ``rm .resident/FROZEN`` was
rejected precisely because deleting a file is not an approval: it leaves no
record of who unfroze, why, or what they were acknowledging.

Freeze is idempotent by construction — a second call returns the freeze already
active rather than creating a rival one — and there is exactly one way to enter
the frozen state, whether a human or a budget breach triggers it.

Frozen blocks **forward motion only**: ``reflect-once`` and ``promote``.
``audit`` and ``rollback`` stay available, because a freeze is exactly when an
operator needs to diagnose and retreat. A safety mechanism that disabled the
recovery mechanism would be a trap.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .store import ResidentError, ResidentStore, new_id


FREEZE_EVENT = "resident_frozen"
UNFREEZE_EVENT = "resident_unfrozen"

#: Actions a freeze blocks. Everything else is deliberately still permitted.
BLOCKED_WHILE_FROZEN = ("reflect-once", "promote")


class FrozenError(ResidentError):
    """Raised when a blocked action is attempted while frozen."""


class UnfreezeError(ResidentError):
    """Raised when an unfreeze is not a valid acknowledgement of a live freeze."""


@dataclass(frozen=True)
class FreezeRecord:
    freeze_id: str
    created_at: str
    reason: str
    actor: str
    trigger: dict[str, Any]
    state: str

    @property
    def active(self) -> bool:
        return self.state == "active"

    def to_dict(self) -> dict[str, Any]:
        return {
            "freeze_id": self.freeze_id,
            "created_at": self.created_at,
            "reason": self.reason,
            "actor": self.actor,
            "trigger": dict(self.trigger),
            "state": self.state,
        }


def _to_record(row: dict[str, Any] | None) -> FreezeRecord | None:
    if row is None:
        return None
    import json

    return FreezeRecord(
        freeze_id=row["freeze_id"],
        created_at=row["created_at"],
        reason=row["reason"],
        actor=row["actor"],
        trigger=json.loads(row["trigger_json"]),
        state=row["state"],
    )


def active_freeze(store: ResidentStore) -> FreezeRecord | None:
    return _to_record(store.active_freeze())


def is_frozen(store: ResidentStore) -> bool:
    return store.active_freeze() is not None


def freeze(
    store: ResidentStore,
    reason: str,
    actor: str = "",
    trigger: dict[str, Any] | None = None,
) -> FreezeRecord:
    """Enter the frozen state. Idempotent: an active freeze is returned as-is.

    The single entry point. A budget breach freezes through this function, not
    through a mechanism of its own, so there is one thing to reason about and
    one thing to unfreeze.
    """

    existing = active_freeze(store)
    if existing is not None:
        return existing

    freeze_id = new_id()
    row = store.insert_freeze(freeze_id, reason=reason, actor=actor, trigger=trigger)
    store.append_event(
        FREEZE_EVENT,
        payload={"freeze_id": freeze_id, "reason": reason, "actor": actor,
                 "trigger": dict(trigger or {})},
    )
    record = _to_record(row)
    assert record is not None
    return record


def unfreeze(
    store: ResidentStore,
    reason: str,
    expected_freeze_id: str,
    actor: str = "",
) -> FreezeRecord:
    """Clear the active freeze, acknowledging it by id.

    Requires the id of the freeze being cleared. An operator who cannot name
    what they are clearing has not read it, and unfreezing something you have
    not read is the failure mode the file-deletion approach invited.
    """

    if not reason.strip():
        raise UnfreezeError("An unfreeze must record a reason.")

    current = active_freeze(store)
    if current is None:
        raise UnfreezeError("The resident is not frozen.")
    if expected_freeze_id != current.freeze_id:
        known = store.get_freeze(expected_freeze_id)
        if known is None:
            detail = "no such freeze"
        elif known["state"] != "active":
            detail = f"that freeze is already {known['state']}"
        else:
            detail = "it is not the currently active freeze"
        raise UnfreezeError(
            f"Refusing to unfreeze with --expected-event-id {expected_freeze_id!r}: {detail}. "
            f"The active freeze is {current.freeze_id!r} ({current.reason})."
        )

    changed = store.resolve_freeze(current.freeze_id, reason=reason, actor=actor)
    if changed != 1:
        raise UnfreezeError("The freeze changed state concurrently; re-read and retry.")
    store.append_event(
        UNFREEZE_EVENT,
        payload={"freeze_id": current.freeze_id, "reason": reason, "actor": actor},
    )
    resolved = _to_record(store.get_freeze(current.freeze_id))
    assert resolved is not None
    return resolved


def require_not_frozen(store: ResidentStore, action: str) -> None:
    """Raise if ``action`` is blocked by an active freeze."""

    if action not in BLOCKED_WHILE_FROZEN:
        return
    current = active_freeze(store)
    if current is None:
        return
    raise FrozenError(
        f"The resident is frozen, so `{action}` is blocked. "
        f"Freeze {current.freeze_id} ({current.created_at}): {current.reason or '(no reason)'}. "
        f"`audit` and `rollback` remain available. To clear it: "
        f"`resident unfreeze --reason \"...\" --expected-event-id {current.freeze_id}`."
    )
