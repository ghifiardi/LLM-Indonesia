"""Append-only spool between the serving process and the supervisor.

The serving process must not write to the state database — that is what makes
its read-only connection meaningful rather than decorative. So it appends
records here instead, and the supervisor ingests them.

Ingestion is idempotent by key, not by bookkeeping. Every record carries an id
its writer generated, and every insert is ``INSERT OR IGNORE`` on that id, so a
crash between inserting a batch and retiring its file produces a duplicate
*attempt* and no duplicate row. That ordering is deliberate: retire the file
last, because the failure that leaves a file un-retired is harmless and the
failure that retires it early loses data.

A line that will not parse is quarantined rather than allowed to block the
lines after it. One malformed record should cost one record.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .store import ResidentStore, new_id, utcnow

KIND_SERVED_REQUEST = "served_request"
KIND_CANARY_VETO = "canary_veto"
KIND_CHAMPION_VETO = "champion_veto"
KNOWN_KINDS = frozenset({KIND_SERVED_REQUEST, KIND_CANARY_VETO, KIND_CHAMPION_VETO})

#: A single spooled line may not exceed this. Serving records are small; a
#: larger one means something is wrong, not that we should allocate for it.
MAX_SPOOL_LINE_BYTES = 64 * 1024

SPOOL_EVENT = "spool_ingested"


class SpoolWriter:
    """Append-only writer owned by the serving process.

    Ordinary request records are flushed but not fsynced: losing the last few
    on a hard crash costs telemetry. Veto observations *are* fsynced, because
    they are what drives a canary being cleared, and losing one would delay a
    revert.
    """

    def __init__(self, spool_dir: Path, name: str | None = None) -> None:
        self.spool_dir = Path(spool_dir)
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        stamp = name or f"serve-{os.getpid()}-{new_id()[:8]}"
        self.path = self.spool_dir / f"{stamp}.jsonl"
        self._handle = open(self.path, "a", encoding="utf-8")

    def write(self, kind: str, record_id: str, payload: dict[str, Any], durable: bool = False) -> None:
        if kind not in KNOWN_KINDS:
            raise ValueError(f"Unknown spool record kind {kind!r}.")
        line = json.dumps(
            {
                "kind": kind,
                "record_id": record_id,
                "created_at": utcnow(),
                "payload": payload,
            },
            ensure_ascii=False,
        )
        if len(line.encode("utf-8")) > MAX_SPOOL_LINE_BYTES:
            raise ValueError("spool record exceeds the line cap")
        self._handle.write(line + "\n")
        self._handle.flush()
        if durable:
            os.fsync(self._handle.fileno())

    def close(self) -> None:
        try:
            self._handle.flush()
            os.fsync(self._handle.fileno())
        except (OSError, ValueError):
            pass
        finally:
            self._handle.close()

    def __enter__(self) -> "SpoolWriter":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


@dataclass(frozen=True)
class IngestReport:
    files: int = 0
    inserted: int = 0
    duplicates: int = 0
    quarantined: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "files": self.files,
            "inserted": self.inserted,
            "duplicates": self.duplicates,
            "quarantined": self.quarantined,
        }


def _iter_lines(path: Path) -> Iterator[tuple[int, str]]:
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for number, line in enumerate(handle, start=1):
            yield number, line.rstrip("\n")


def _parse(line: str) -> dict[str, Any]:
    """Strict schema and size validation. Raises ValueError on anything odd."""

    if len(line.encode("utf-8")) > MAX_SPOOL_LINE_BYTES:
        raise ValueError("line exceeds the size cap")
    record = json.loads(line)
    if not isinstance(record, dict):
        raise ValueError("not a JSON object")
    kind = record.get("kind")
    if kind not in KNOWN_KINDS:
        raise ValueError(f"unknown kind {kind!r}")
    if not isinstance(record.get("record_id"), str) or not record["record_id"]:
        raise ValueError("record_id must be a non-empty string")
    if not isinstance(record.get("created_at"), str):
        raise ValueError("created_at must be a string")
    if not isinstance(record.get("payload"), dict):
        raise ValueError("payload must be an object")
    return record


def ingest(store: ResidentStore, spool_dir: Path | None = None) -> IngestReport:
    """Drain the spool into the database. Supervisor-only; never called by serve."""

    spool_dir = Path(spool_dir or store.spool_dir)
    if not spool_dir.is_dir():
        return IngestReport()
    consumed_dir = spool_dir / "consumed"
    quarantine_dir = spool_dir / "quarantine"

    files = inserted = duplicates = quarantined = 0
    for path in sorted(spool_dir.glob("*.jsonl")):
        files += 1
        bad_lines: list[str] = []
        for number, line in _iter_lines(path):
            if not line.strip():
                continue
            try:
                record = _parse(line)
            except (ValueError, json.JSONDecodeError) as exc:
                bad_lines.append(f"{path.name}:{number}: {exc}\t{line[:400]}")
                quarantined += 1
                continue
            if _apply(store, record):
                inserted += 1
            else:
                duplicates += 1

        # Rows are committed before the file is retired. A crash here replays
        # the file and every insert is ignored as a duplicate.
        consumed_dir.mkdir(parents=True, exist_ok=True)
        os.replace(path, consumed_dir / path.name)
        if bad_lines:
            quarantine_dir.mkdir(parents=True, exist_ok=True)
            with open(quarantine_dir / f"{path.stem}.bad", "a", encoding="utf-8") as handle:
                handle.write("\n".join(bad_lines) + "\n")

    report = IngestReport(files, inserted, duplicates, quarantined)
    if files:
        store.append_event(SPOOL_EVENT, payload=report.to_dict())
    return report


def _apply(store: ResidentStore, record: dict[str, Any]) -> bool:
    kind = record["kind"]
    payload = record["payload"]
    if kind == KIND_SERVED_REQUEST:
        return _apply_served_request(store, record["record_id"], record["created_at"], payload)
    return store.insert_serving_veto(
        {
            "observation_id": record["record_id"],
            "created_at": record["created_at"],
            "kind": kind,
            "candidate_id": payload.get("candidate_id"),
            "artifact_hash": payload.get("artifact_hash"),
            "request_id": payload.get("request_id"),
            "veto": str(payload.get("veto", ""))[:64],
            "detail": payload.get("detail") or {},
        }
    )


def _apply_served_request(
    store: ResidentStore, request_id: str, created_at: str, payload: dict[str, Any]
) -> bool:
    from .models import Experience

    inserted = store.insert_served_request({**payload, "request_id": request_id,
                                            "created_at": created_at})
    if inserted:
        # The experience shares the request id, so replaying the spool cannot
        # produce a second copy of the same interaction.
        try:
            store.insert_experience(
                Experience(
                    experience_id=request_id,
                    recorded_at=created_at,
                    query=str(payload.get("query", "")),
                    answer=str(payload.get("answer", "")),
                    outcome="served",
                    source="serve",
                    tags=(payload.get("actual_route", "champion"),),
                    metadata={
                        "served_candidate_id": payload.get("served_candidate_id"),
                        "fallback_used": bool(payload.get("fallback_used")),
                        "latency_ms": payload.get("latency_ms"),
                    },
                )
            )
        except Exception:
            # The request row is the durable record; a duplicate experience id
            # from a partial earlier ingest must not fail the batch.
            pass
    return inserted
