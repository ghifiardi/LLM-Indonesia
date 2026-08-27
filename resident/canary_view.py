"""Read-only view of the canary pointer: parsing and routing, nothing else.

Extracted so the serving process does not have to import ``canary``, which
reaches ``gate``, ``freeze``, ``archive`` and the transition machinery. Serve's
*direct* imports were already clean, but its transitive graph pulled in every
mutation-capable module in the package — a boundary that holds only because
nothing calls the wrong function is not much of a boundary.

Everything here reads. There is no activation, no clearing, no transition, and
no freeze. ``canary`` imports this module too, so there is one definition of
what a pointer is and one implementation of routing.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Any

from .store import ResidentError, ResidentStore

ROUTE_CANARY = "canary"


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
    conversation id is the routing key when there is one, so a conversation
    does not switch policies mid-way; without one the query is used, which
    biases sampling toward repeated questions.
    """

    key = (conversation_id or query).encode("utf-8")
    digest = hmac.new(salt.encode("utf-8"), key, hashlib.sha256).hexdigest()
    return int(digest[:8], 16) % 100


def routes_to_canary(
    pointer: CanaryPointer, query: str, conversation_id: str = ""
) -> tuple[bool, int]:
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
