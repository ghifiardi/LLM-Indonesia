"""Canary activation, routing, and automatic clearing.

A canary serves a deterministic slice of traffic. It is **not** champion, which
is what makes automatic clearing consistent with promotion staying human-only:
clearing a canary demotes something that was never promoted. The champion never
moves automatically — when the *champion* trips a hard veto, the answer is
withheld and the resident freezes, and choosing a rollback target stays a human
decision.

Routing is salted. ``HMAC-SHA256(salt, conversation_id || query)`` with a
per-activation secret, so:

* the bucket cannot be predicted or steered by choosing a query;
* candidate code never receives the salt — it gets a query and the KB, nothing
  more;
* raising the percentage only adds buckets, so users already inside the slice
  are not reshuffled;
* a new activation gets a new salt, which reshuffles deliberately.

Only the bucket is recorded. The salt is never written to an event or a request
row.

Activation and clearing both span a pointer file and a database row, so both
run the same intent -> atomic pointer -> finalize protocol as promotion, and
recovery converges from an interruption at any point.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import states
from .anchors import ServingConfig, ThresholdError, load_all_anchors, resolve_anchors_dir
from .archive import CandidateArchive
from .freeze import freeze, is_frozen
from .gate import evaluate_gate
from .store import ResidentError, ResidentStore, new_id, utcnow

STATE_INTENDED = "intended"
STATE_ACTIVE = "active"
STATE_CLEARING = "clearing"
STATE_CLEARED = "cleared"
STATE_ABANDONED = "abandoned"

CANARY_ACTIVATED_EVENT = "canary_activated"
CANARY_CLEARED_EVENT = "canary_cleared"
CANARY_RECOVERED_EVENT = "canary_recovered"

ROUTE_CANARY = "canary"


class CanaryError(ResidentError):
    """Raised when a canary cannot be activated or cleared."""


@dataclass(frozen=True)
class CanaryPointer:
    activation_id: str
    candidate_id: str
    artifact_hash: str
    percent: int
    routing_salt: str
    activated_at: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CanaryPointer":
        return cls(
            activation_id=payload["activation_id"],
            candidate_id=payload["candidate_id"],
            artifact_hash=payload["artifact_hash"],
            percent=int(payload["percent"]),
            routing_salt=payload["routing_salt"],
            activated_at=payload.get("activated_at", ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "activation_id": self.activation_id,
            "candidate_id": self.candidate_id,
            "artifact_hash": self.artifact_hash,
            "percent": self.percent,
            "routing_salt": self.routing_salt,
            "activated_at": self.activated_at,
        }

    def public_dict(self) -> dict[str, Any]:
        """Everything except the salt. What may be logged or returned."""

        payload = self.to_dict()
        payload.pop("routing_salt")
        return payload


def routing_bucket(salt: str, query: str, conversation_id: str = "") -> int:
    """Stable bucket in [0, 100) for one routing key.

    Keyed rather than plain: a plain digest of the query lets anyone compute
    which side they land on and craft a query to reach the canary. The
    conversation id is the routing key when there is one so a conversation does
    not switch policies mid-way; without one the query is used, which biases
    sampling toward repeated questions.
    """

    key = (conversation_id or query).encode("utf-8")
    digest = hmac.new(salt.encode("utf-8"), key, hashlib.sha256).hexdigest()
    return int(digest[:8], 16) % 100


def routes_to_canary(pointer: CanaryPointer, query: str, conversation_id: str = "") -> tuple[bool, int]:
    bucket = routing_bucket(pointer.routing_salt, query, conversation_id)
    return bucket < pointer.percent, bucket


def active_pointer(store: ResidentStore) -> CanaryPointer | None:
    payload = store.read_canary()
    if payload is None:
        return None
    try:
        return CanaryPointer.from_dict(payload)
    except (KeyError, TypeError, ValueError) as exc:
        raise ResidentError(f"Canary pointer is malformed: {exc}") from exc


# --- activation -------------------------------------------------------------


def activate(
    store: ResidentStore,
    candidate_id: str,
    percent: int,
    reason: str = "",
    actor: str = "",
    anchors_dir: str | Path | None = None,
    stop_after: str | None = None,
) -> CanaryPointer | None:
    """Route a slice of traffic to a candidate. Blocked while frozen.

    Requires a fresh passing gate verdict: a canary serves real users, so it
    clears the same bar a promotion would, minus only the human's final say.
    """

    if is_frozen(store):
        raise CanaryError(
            "The resident is frozen, so canary activation is blocked. "
            "Clear the freeze explicitly once the cause is understood."
        )
    if active_pointer(store) is not None or store.canary_activations((STATE_ACTIVE,)):
        raise CanaryError("A canary is already active; clear it before activating another.")

    try:
        _identity, _gate, _budget, serving = load_all_anchors(resolve_anchors_dir(anchors_dir))
    except ThresholdError as exc:
        raise CanaryError(f"Serving anchors are unusable: {exc}") from exc
    if not 1 <= percent <= serving.canary_max_percent:
        raise CanaryError(
            f"percent must be between 1 and {serving.canary_max_percent} "
            f"(from the serving anchor); got {percent}."
        )

    candidate = CandidateArchive(store).get(candidate_id)
    if candidate is None:
        raise CanaryError(f"No candidate {candidate_id!r} in the archive.")
    if candidate.artifact_hash is None or not candidate.is_selectable:
        raise CanaryError(
            f"Candidate {candidate_id!r} is not eligible "
            f"(status {candidate.verdict.status})."
        )

    verdict = evaluate_gate(store, candidate_id, anchors_dir=anchors_dir)
    if not verdict.passed:
        raise CanaryError(f"Gate refused candidate {candidate_id!r}: {verdict.failure_summary()}")

    if store.candidate_state(candidate_id) == states.PROPOSED:
        _transition(store, candidate_id, states.SHADOW, verdict.gate_verdict_id)

    activation_id = new_id()
    # Step 1: intent.
    store.insert_canary_activation(
        {
            "activation_id": activation_id,
            "candidate_id": candidate_id,
            "artifact_hash": candidate.artifact_hash,
            "percent": percent,
            "gate_verdict_id": verdict.gate_verdict_id,
            "reason": reason,
            "actor": actor,
            "state": STATE_INTENDED,
        }
    )
    if stop_after == "intent":
        return None

    # Step 2: atomic pointer swap, carrying a fresh secret.
    pointer = CanaryPointer(
        activation_id=activation_id,
        candidate_id=candidate_id,
        artifact_hash=candidate.artifact_hash,
        percent=percent,
        routing_salt=secrets.token_hex(32),
        activated_at=utcnow(),
    )
    store.write_canary(pointer.to_dict())
    if stop_after == "pointer":
        return None

    # Step 3: finalize.
    _finalize_activation(store, activation_id, candidate_id, verdict.gate_verdict_id, pointer)
    return pointer


def _finalize_activation(
    store: ResidentStore,
    activation_id: str,
    candidate_id: str,
    gate_verdict_id: str | None,
    pointer: CanaryPointer,
) -> None:
    store.set_canary_activation_state(activation_id, STATE_ACTIVE)
    if store.candidate_state(candidate_id) == states.SHADOW:
        _transition(
            store,
            candidate_id,
            states.CANARY,
            states.AUTHORITY_CANARY_ACTIVATION,
            evidence={"activation_id": activation_id, "gate_verdict_id": gate_verdict_id},
        )
    store.append_event(
        CANARY_ACTIVATED_EVENT,
        candidate_id=candidate_id,
        # The salt is not in public_dict, and must never reach an event.
        payload=pointer.public_dict(),
    )


def clear(
    store: ResidentStore,
    reason: str,
    actor: str = "",
    auto: bool = False,
    stop_after: str | None = None,
) -> str | None:
    """Stop routing traffic to the canary. Returns the cleared activation id."""

    pointer = active_pointer(store)
    rows = store.canary_activations((STATE_ACTIVE, STATE_INTENDED, STATE_CLEARING))
    if pointer is None and not rows:
        return None

    activation_id = pointer.activation_id if pointer is not None else rows[0]["activation_id"]
    candidate_id = pointer.candidate_id if pointer is not None else rows[0]["candidate_id"]

    # Step 1: intent.
    store.set_canary_activation_state(activation_id, STATE_CLEARING, resolved_reason=reason)
    if stop_after == "intent":
        return None

    # Step 2: remove the pointer. Traffic stops here.
    store.clear_canary_pointer()
    if stop_after == "pointer":
        return None

    # Step 3: finalize.
    _finalize_clear(store, activation_id, candidate_id, reason, actor, auto)
    return activation_id


def _finalize_clear(
    store: ResidentStore,
    activation_id: str,
    candidate_id: str,
    reason: str,
    actor: str,
    auto: bool,
) -> None:
    store.set_canary_activation_state(activation_id, STATE_CLEARED, resolved_reason=reason)
    if store.candidate_state(candidate_id) == states.CANARY:
        _transition(
            store,
            candidate_id,
            states.REJECTED,
            states.AUTHORITY_CANARY_AUTO_REVERT if auto else states.AUTHORITY_CANARY_ACTIVATION,
            evidence={"activation_id": activation_id, "reason": reason, "automatic": auto},
        )
    store.append_event(
        CANARY_CLEARED_EVENT,
        candidate_id=candidate_id,
        payload={"activation_id": activation_id, "reason": reason,
                 "actor": actor, "automatic": auto},
    )


def recover(store: ResidentStore) -> list[dict[str, str]]:
    """Resolve interrupted activations and clears. Idempotent and deterministic.

    The pointer is the source of truth, exactly as it is for promotion:

    * ``intended`` and the pointer names it -> the swap landed, roll forward;
    * ``intended`` and it does not -> the swap never happened, abandon;
    * ``clearing`` -> always complete the clear, removing a pointer that still
      names it.

    Afterwards a pointer naming no live activation is removed, so the states
    "canary without a pointer" and "pointer without a canary" cannot persist.
    """

    actions: list[dict[str, str]] = []
    pointer = active_pointer(store)
    live_id = pointer.activation_id if pointer is not None else None

    for row in store.canary_activations((STATE_INTENDED, STATE_CLEARING)):
        activation_id = row["activation_id"]
        if row["state"] == STATE_CLEARING:
            if live_id == activation_id:
                store.clear_canary_pointer()
                pointer, live_id = None, None
            _finalize_clear(
                store, activation_id, row["candidate_id"],
                row["resolved_reason"] or "recovered", row["actor"], auto=True,
            )
            resolution = STATE_CLEARED
        elif live_id == activation_id and pointer is not None:
            _finalize_activation(
                store, activation_id, row["candidate_id"], row["gate_verdict_id"], pointer
            )
            resolution = STATE_ACTIVE
        else:
            store.set_canary_activation_state(
                activation_id, STATE_ABANDONED, resolved_reason="pointer swap never landed"
            )
            resolution = STATE_ABANDONED
        store.append_event(
            CANARY_RECOVERED_EVENT,
            candidate_id=row["candidate_id"],
            payload={"activation_id": activation_id, "resolution": resolution},
        )
        actions.append({"activation_id": activation_id, "resolution": resolution})

    # A pointer with no live activation would route traffic nothing accounts for.
    pointer = active_pointer(store)
    if pointer is not None:
        row = store.get_canary_activation(pointer.activation_id)
        if row is None or row["state"] != STATE_ACTIVE:
            store.clear_canary_pointer()
            actions.append(
                {"activation_id": pointer.activation_id, "resolution": "orphan_pointer_removed"}
            )
    return actions


# --- automatic revert -------------------------------------------------------


def recent_breaches(store: ResidentStore, candidate_id: str, window_seconds: int) -> int:
    since = (
        datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
    ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    rows = store.list_serving_vetoes(kind="canary_veto", since=since)
    return sum(1 for row in rows if row["candidate_id"] == candidate_id)


def enforce(
    store: ResidentStore,
    serving: ServingConfig,
    anchors_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """Clear the canary if it has breached too often. Supervisor-only.

    The serving process cannot do this: it holds a read-only connection and
    cannot write a state transition or a freeze. It spools observations, and
    this — running in the supervisor — is what acts on them.
    """

    pointer = active_pointer(store)
    if pointer is None:
        return None

    breaches = recent_breaches(store, pointer.candidate_id, serving.canary_observation_window_seconds)
    if breaches < serving.canary_breach_count:
        return None

    reason = (
        f"{breaches} hard-veto breach(es) within "
        f"{serving.canary_observation_window_seconds}s (limit {serving.canary_breach_count})"
    )
    clear(store, reason=reason, actor="supervisor", auto=True)
    # Automatic demotion of a canary is safe; deciding what to serve instead is
    # not, so the resident freezes rather than choosing a rollback target.
    freeze(
        store,
        reason=f"canary {pointer.candidate_id} auto-reverted: {reason}",
        actor="canary",
        trigger={
            "activation_id": pointer.activation_id,
            "candidate_id": pointer.candidate_id,
            "breaches": breaches,
            "window_seconds": serving.canary_observation_window_seconds,
        },
    )
    return {"activation_id": pointer.activation_id, "breaches": breaches, "reason": reason}


def _transition(
    store: ResidentStore,
    candidate_id: str,
    to_state: str,
    authorized_by: str,
    evidence: dict[str, Any] | None = None,
) -> None:
    from .promote import _record_transition

    candidate = CandidateArchive(store).get(candidate_id)
    if candidate is not None:
        _record_transition(store, candidate, to_state, authorized_by, evidence=evidence)
