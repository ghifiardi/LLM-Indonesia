"""Append-only spool between the serving process and the supervisor.

The serving process must not write to the state database — that is what makes
its read-only connection meaningful rather than decorative. So it publishes
records here instead, and the supervisor ingests them.

**One record per file, published by atomic rename.** The first design had the
writer hold one open file and append to it while the supervisor renamed that
same file into ``consumed/``. On POSIX a rename follows the inode, so the
serving process kept writing into the retired file through its open descriptor
and every record after the first ingestion was silently lost — an ``ask`` that
answered correctly while ``served_requests`` stayed at zero. A writer and a
reader cannot share ownership of a file; the fix is to stop trying.

So a record is written to ``staging/`` under a name only this write owns,
closed, then ``os.replace``d into ``ready/``. The supervisor only ever looks in
``ready/``, and by the time a file appears there nothing holds it open.

Layout, all directories ``0700`` and all files ``0600``::

    spool/
    ├── staging/     in-progress writes; never ingested
    ├── ready/       complete records, atomically published
    ├── consumed/    retired after the database commit
    └── quarantine/  unparseable records, plus content-free notes

Ingestion is idempotent by key, not by bookkeeping: every record carries an id
its writer generated and every insert is ``INSERT OR IGNORE`` on that id, so a
crash between committing and retiring produces a duplicate *attempt* and no
duplicate row. Files are retired last, deliberately — the failure that leaves a
file un-retired is harmless, the one that retires it early loses data.
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

#: A single spooled record may not exceed this. Serving records are small; a
#: larger one means something is wrong, not that we should allocate for it.
MAX_SPOOL_RECORD_BYTES = 64 * 1024
#: Retained under the old name: it is the same cap.
MAX_SPOOL_LINE_BYTES = MAX_SPOOL_RECORD_BYTES

STAGING_DIR = "staging"
READY_DIR = "ready"
CONSUMED_DIR = "consumed"
QUARANTINE_DIR = "quarantine"

RECORD_SUFFIX = ".json"
#: Batch files written by the pre-fix design. Never ingested — their contents
#: cannot be trusted to be complete — but counted and reported rather than
#: silently ignored.
LEGACY_SUFFIX = ".jsonl"

SPOOL_EVENT = "spool_ingested"


def _harden_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class SpoolWriter:
    """Publishes one record per file, owned by the serving process.

    Holds no file open between records. That is the whole point: a file the
    supervisor can see is a file this writer has already finished with.
    """

    def __init__(self, spool_dir: Path, name: str | None = None) -> None:
        self.spool_dir = Path(spool_dir)
        # Spool files hold raw queries and answers, so every directory is
        # private and every file owner-only.
        for directory in (STAGING_DIR, READY_DIR, CONSUMED_DIR, QUARANTINE_DIR):
            _harden_dir(self.spool_dir / directory)
        self.staging_dir = self.spool_dir / STAGING_DIR
        self.ready_dir = self.spool_dir / READY_DIR
        self.name = name or f"serve-{os.getpid()}"

    def write(
        self,
        kind: str,
        record_id: str,
        payload: dict[str, Any],
        durable: bool = False,
    ) -> Path:
        """Publish one record atomically. Returns the ready-file path.

        ``durable`` fsyncs the record and the directory entry before returning.
        Veto observations use it because they drive a canary being cleared;
        losing one would delay containment. Ordinary request records are only
        flushed — losing the last few to a hard crash costs telemetry.
        """

        if kind not in KNOWN_KINDS:
            raise ValueError(f"Unknown spool record kind {kind!r}.")
        body = json.dumps(
            {
                "kind": kind,
                "record_id": record_id,
                "created_at": utcnow(),
                "payload": payload,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        if len(body) > MAX_SPOOL_RECORD_BYTES:
            raise ValueError("spool record exceeds the size cap")

        filename = f"{record_id}{RECORD_SUFFIX}"
        staging_path = self.staging_dir / filename
        ready_path = self.ready_dir / filename

        # O_EXCL: a colliding record id is a bug worth hearing about, not
        # something to overwrite.
        descriptor = os.open(
            staging_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(body)
                handle.flush()
                if durable:
                    os.fsync(handle.fileno())
        except BaseException:
            staging_path.unlink(missing_ok=True)
            raise

        # The record becomes visible to the supervisor here, complete and
        # closed, in one indivisible step.
        os.replace(staging_path, ready_path)
        if durable:
            _fsync_dir(self.ready_dir)
        return ready_path

    def close(self) -> None:
        """Nothing is held open between records; kept for symmetry."""

        _fsync_dir(self.ready_dir)

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
    legacy_ignored: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "files": self.files,
            "inserted": self.inserted,
            "duplicates": self.duplicates,
            "quarantined": self.quarantined,
            "legacy_ignored": self.legacy_ignored,
        }


def _quarantine_note(path: Path, error: str, raw: bytes) -> str:
    """Metadata about a rejected record — never the record itself.

    A rejected record still holds a raw user query, and a diagnostic file is not
    a place for one. The digest is enough to correlate duplicates or confirm a
    fix without reproducing the content.
    """

    import hashlib

    return (
        f"{path.name}\terror={error}\tbytes={len(raw)}"
        f"\tsha256={hashlib.sha256(raw).hexdigest()}\tat={utcnow()}"
    )


def _read_record(path: Path) -> bytes:
    """Read at most the cap plus one byte, so an oversized file is detected."""

    with open(path, "rb") as handle:
        return handle.read(MAX_SPOOL_RECORD_BYTES + 1)


def _parse(raw: bytes) -> dict[str, Any]:
    """Strict schema validation. Raises ValueError on anything odd."""

    if len(raw) > MAX_SPOOL_RECORD_BYTES:
        raise ValueError("record exceeds the size cap")
    record = json.loads(raw.decode("utf-8"))
    if not isinstance(record, dict):
        raise ValueError("not a JSON object")
    if record.get("kind") not in KNOWN_KINDS:
        raise ValueError(f"unknown kind {record.get('kind')!r}")
    if not isinstance(record.get("record_id"), str) or not record["record_id"]:
        raise ValueError("record_id must be a non-empty string")
    if not isinstance(record.get("created_at"), str):
        raise ValueError("created_at must be a string")
    if not isinstance(record.get("payload"), dict):
        raise ValueError("payload must be an object")
    return record


def ready_files(spool_dir: Path) -> list[Path]:
    """Complete records awaiting ingestion, oldest first."""

    ready = Path(spool_dir) / READY_DIR
    if not ready.is_dir():
        return []
    return sorted(ready.glob(f"*{RECORD_SUFFIX}"))


def ingest(store: ResidentStore, spool_dir: Path | None = None) -> IngestReport:
    """Drain the spool into the database. Supervisor-only; never called by serve.

    Only ``ready/`` is read. A file still being written lives in ``staging/``
    and is invisible here, which is what stops the supervisor from retiring a
    file its writer still owns.
    """

    spool_dir = Path(spool_dir or store.spool_dir)
    if not spool_dir.is_dir():
        return IngestReport()
    consumed_dir = spool_dir / CONSUMED_DIR
    quarantine_dir = spool_dir / QUARANTINE_DIR

    files = inserted = duplicates = quarantined = 0
    notes: list[str] = []

    for path in ready_files(spool_dir):
        files += 1
        try:
            raw = _read_record(path)
        except OSError as exc:
            notes.append(_quarantine_note(path, f"unreadable:{type(exc).__name__}", b""))
            quarantined += 1
            continue
        try:
            record = _parse(raw)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            _harden_dir(quarantine_dir)
            os.replace(path, quarantine_dir / path.name)
            notes.append(_quarantine_note(path, type(exc).__name__, raw))
            quarantined += 1
            continue

        if _apply(store, record):
            inserted += 1
        else:
            duplicates += 1

        # Retired only after the row is committed. A crash here replays the
        # file and every insert is ignored as a duplicate.
        _harden_dir(consumed_dir)
        os.replace(path, consumed_dir / path.name)

    # Batch files from the pre-fix design cannot be trusted to be complete, so
    # they are not ingested — but they are counted, because silence about data
    # left behind reads as "there was none".
    legacy = len(list(spool_dir.glob(f"*{LEGACY_SUFFIX}")))

    if notes:
        _harden_dir(quarantine_dir)
        note_path = quarantine_dir / "rejected.bad"
        descriptor = os.open(note_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write("\n".join(notes) + "\n")

    report = IngestReport(files, inserted, duplicates, quarantined, legacy)
    if files or legacy:
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
            # Scoped to the activation that produced it: a candidate can be
            # canaried more than once, and observations from a previous
            # activation must not count against a new one.
            "activation_id": str(payload.get("activation_id", ""))[:64],
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
