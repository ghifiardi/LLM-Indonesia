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
        # Spool files hold raw queries and answers, so the directory is private
        # and each file is owner-only. Default permissions would leave user
        # conversations world-readable on a shared machine.
        self.spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _harden_dir(self.spool_dir)
        stamp = name or f"serve-{os.getpid()}-{new_id()[:8]}"
        self.path = self.spool_dir / f"{stamp}.jsonl"
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self._handle = os.fdopen(descriptor, "a", encoding="utf-8")

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


def _harden_dir(path: Path) -> None:
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _iter_lines(path: Path) -> Iterator[tuple[int, bytes, bool]]:
    """Yield (line number, bytes, oversized) reading at most the cap per line.

    Binary and bounded on purpose. Text-mode iteration allocates a whole line
    before any size check can run, so a tampered spool file with one enormous
    line would exhaust the supervisor's memory before the cap fired. Here an
    oversized line is truncated for reporting and its remainder is skipped
    without ever being buffered.
    """

    limit = MAX_SPOOL_LINE_BYTES
    with open(path, "rb") as handle:
        number = 0
        while True:
            chunk = handle.readline(limit + 1)
            if not chunk:
                return
            number += 1
            if len(chunk) > limit and not chunk.endswith(b"\n"):
                # Discard the rest of this line a bounded piece at a time.
                while True:
                    tail = handle.readline(limit)
                    if not tail or tail.endswith(b"\n"):
                        break
                yield number, chunk[:limit], True
                continue
            yield number, chunk.rstrip(b"\n"), False


def _parse(line: bytes) -> dict[str, Any]:
    """Strict schema validation. Raises ValueError on anything odd."""

    if len(line) > MAX_SPOOL_LINE_BYTES:
        raise ValueError("line exceeds the size cap")
    record = json.loads(line.decode("utf-8"))
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
        for number, line, oversized in _iter_lines(path):
            if not line.strip():
                continue
            if oversized:
                bad_lines.append(_quarantine_note(path, number, "line_exceeds_cap", line))
                quarantined += 1
                continue
            try:
                record = _parse(line)
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                bad_lines.append(
                    _quarantine_note(path, number, type(exc).__name__, line)
                )
                quarantined += 1
                continue
            if _apply(store, record):
                inserted += 1
            else:
                duplicates += 1

        # Rows are committed before the file is retired. A crash here replays
        # the file and every insert is ignored as a duplicate.
        consumed_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        _harden_dir(consumed_dir)
        os.replace(path, consumed_dir / path.name)
        if bad_lines:
            quarantine_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            _harden_dir(quarantine_dir)
            note_path = quarantine_dir / f"{path.stem}.bad"
            descriptor = os.open(note_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                handle.write("\n".join(bad_lines) + "\n")

    report = IngestReport(files, inserted, duplicates, quarantined)
    if files:
        store.append_event(SPOOL_EVENT, payload=report.to_dict())
    return report


def _quarantine_note(path: Path, number: int, error: str, line: bytes) -> str:
    """Metadata about a rejected line — never the line itself.

    A rejected record still holds a raw user query, and a diagnostic file is not
    a place for one. The digest is enough to correlate duplicates or confirm a
    fix without reproducing the content.
    """

    import hashlib

    return (
        f"{path.name}:{number}\terror={error}\tbytes={len(line)}"
        f"\tsha256={hashlib.sha256(line).hexdigest()}"
    )


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
    """Insert the request and its experience atomically, healing partial state.

    The experience shares the request id, so both inserts are idempotent and a
    replay repairs a half-applied record instead of skipping it as a duplicate.
    """

    from .models import Experience

    experience = Experience(
        experience_id=request_id,
        recorded_at=created_at,
        query=str(payload.get("query", "")),
        answer=str(payload.get("answer", "")),
        outcome="served",
        source="serve",
        tags=(str(payload.get("actual_route", "champion")),),
        metadata={
            "served_candidate_id": payload.get("served_candidate_id"),
            "fallback_used": bool(payload.get("fallback_used")),
            "latency_ms": payload.get("latency_ms"),
        },
    )
    request_inserted, experience_inserted = store.insert_served_request_with_experience(
        {**payload, "request_id": request_id, "created_at": created_at}, experience
    )
    # "Inserted" means something new landed — including a healed experience, so
    # a repair is visible in the report rather than counted as a duplicate.
    return request_inserted or experience_inserted
