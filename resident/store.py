"""Durable state for the resident loop.

This module is the *only* place in ``resident/`` that touches sqlite or the
filesystem. Everything else asks the store. That keeps two invariants easy to
audit in one file: artifacts are never overwritten and always verified on read,
and the champion pointer is only ever replaced atomically.

Layout under the state directory::

    <state-dir>/
    ├── state.db                       sqlite (WAL) operational metadata
    ├── artifacts/<sha256>/policy.py   immutable, content-addressed
    ├── artifacts/<sha256>/manifest.json
    └── state/champion.json            atomically replaced pointer

Metadata is mutable and queryable; policy bodies are immutable files named by
their own digest. Nothing in the database is trusted to describe artifact
content — the digest is recomputed from bytes every time an artifact is read.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import textwrap
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from .models import (
    Candidate,
    Champion,
    CycleEvent,
    Experience,
    Verdict,
)


#: Environment variable consulted when no ``--state-dir`` is given.
STATE_DIR_ENV_VAR = "GODEL_RESIDENT_DIR"

#: Repository-development default. Installed packages are frequently read-only,
#: so this is a convenience for working in a checkout, not a promise that the
#: path is writable. Set ``--state-dir`` or ``$GODEL_RESIDENT_DIR`` otherwise.
DEFAULT_STATE_DIR_NAME = ".resident"

PROMOTION_INTENDED = "intended"
PROMOTION_FINALIZED = "finalized"
PROMOTION_ABANDONED = "abandoned"


class ResidentError(Exception):
    """Base class for resident-store failures."""


class ResidentNotInitializedError(ResidentError):
    """Raised when an operation needs a champion and none has been established."""


class EnvironmentMismatchError(ResidentError):
    """Raised when an operation names a different environment than the one bound.

    One state directory serves one task domain. An archive that mixed domains
    would let a support-chat policy become the parent of a phone-normalizer
    candidate, and would let one champion pointer stand for two incompatible
    tasks.
    """


class ArtifactMissingError(ResidentError):
    """Raised when a recorded artifact hash has no file on disk."""


class ArtifactIntegrityError(ResidentError):
    """Raised when artifact bytes do not hash to their own directory name.

    This is always fail-closed. A mismatch means the immutable store was
    modified out of band, and no candidate from it may be loaded, evaluated, or
    promoted until a human resolves it.
    """


class StateDirectoryError(ResidentError):
    """Raised when the state directory cannot be created or written."""


_MIGRATION_1 = (
    """
    CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS experiences (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        experience_id TEXT NOT NULL UNIQUE,
        recorded_at   TEXT NOT NULL,
        query         TEXT NOT NULL,
        answer        TEXT NOT NULL,
        outcome       TEXT NOT NULL DEFAULT 'unknown',
        source        TEXT NOT NULL DEFAULT 'cli',
        tags_json     TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS candidates (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id        TEXT NOT NULL UNIQUE,
        created_at          TEXT NOT NULL,
        tier                TEXT NOT NULL,
        origin              TEXT NOT NULL,
        artifact_hash       TEXT,
        parent_candidate_id TEXT,
        rationale           TEXT NOT NULL DEFAULT '',
        cycle               INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL,
        public_score        REAL,
        verdict_json        TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_candidates_parent ON candidates(parent_candidate_id)",
    "CREATE INDEX IF NOT EXISTS idx_candidates_hash ON candidates(artifact_hash)",
    "CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status)",
    """
    CREATE TABLE IF NOT EXISTS events (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        candidate_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)",
    """
    CREATE TABLE IF NOT EXISTS promotions (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        promotion_id        TEXT NOT NULL UNIQUE,
        candidate_id        TEXT NOT NULL,
        artifact_hash       TEXT NOT NULL,
        previous_candidate_id TEXT,
        reason              TEXT NOT NULL DEFAULT '',
        actor               TEXT NOT NULL DEFAULT '',
        requested_at        TEXT NOT NULL,
        state               TEXT NOT NULL,
        resolved_at         TEXT,
        note                TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_promotions_state ON promotions(state)",
)

_MIGRATION_2 = (
    """
    CREATE TABLE IF NOT EXISTS config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
)

#: Sequential schema migrations, applied in order for any version gap.
#:
#: Append a new ``(version, statements)`` entry; never edit a shipped one. Each
#: entry runs exactly once per state directory, inside the same transaction that
#: stamps the new version, so a failed migration leaves the recorded version
#: untouched. Downgrades are refused rather than guessed at.
MIGRATIONS: tuple[tuple[int, tuple[str, ...]], ...] = (
    (1, _MIGRATION_1),
    (2, _MIGRATION_2),
)

SCHEMA_VERSION = MIGRATIONS[-1][0]

#: Config key binding a state directory to one environment. See ``reflect.py``:
#: candidates from different task domains must not share an archive.
CONFIG_ENVIRONMENT = "environment"


def utcnow() -> str:
    """ISO-8601 UTC timestamp with a trailing ``Z``."""

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def new_id() -> str:
    return uuid4().hex


def canonicalize_policy(code: str) -> str:
    """Normalise policy source before hashing.

    Matches ``SafePolicyLoader.load`` exactly, so the bytes that get hashed are
    the bytes that get validated and executed. If these ever diverge, an
    artifact hash would no longer identify what actually ran.
    """

    return textwrap.dedent(code).strip() + "\n"


def policy_digest(code: str) -> str:
    return hashlib.sha256(canonicalize_policy(code).encode("utf-8")).hexdigest()


def resolve_state_dir(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the state directory: explicit argument, then env var, then default."""

    if explicit is not None and str(explicit).strip():
        return Path(explicit).expanduser().resolve()
    from_env = os.environ.get(STATE_DIR_ENV_VAR, "")
    if from_env.strip():
        return Path(from_env).expanduser().resolve()
    package_root = Path(__file__).resolve().parent.parent
    return package_root / DEFAULT_STATE_DIR_NAME


class ResidentStore:
    """Owns the state directory: sqlite metadata, artifacts, champion pointer."""

    def __init__(self, state_dir: str | os.PathLike[str] | None = None) -> None:
        self.state_dir = resolve_state_dir(state_dir)
        self.artifacts_dir = self.state_dir / "artifacts"
        self.pointer_dir = self.state_dir / "state"
        #: Public-only evaluation snapshot. Written once by ``init``; the only
        #: eval source ``reflect-once`` is permitted to open. See reflect.py.
        self.public_eval_dir = self.state_dir / "eval" / "public"
        self.db_path = self.state_dir / "state.db"
        self.champion_path = self.pointer_dir / "champion.json"
        self._conn: sqlite3.Connection | None = None

    # --- lifecycle ---------------------------------------------------------

    @classmethod
    def open(cls, state_dir: str | os.PathLike[str] | None = None) -> "ResidentStore":
        """Open (creating if needed) and run promotion recovery.

        Recovery runs on every open and is idempotent, so a crash at any point
        is resolved by the next command rather than by an operator.
        """

        store = cls(state_dir)
        store.connect()
        store.recover()
        return store

    def connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        try:
            self.artifacts_dir.mkdir(parents=True, exist_ok=True)
            self.pointer_dir.mkdir(parents=True, exist_ok=True)
            self.public_eval_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise StateDirectoryError(
                f"Cannot create state directory {self.state_dir}: {exc}. "
                f"Pass --state-dir or set ${STATE_DIR_ENV_VAR} to a writable path."
            ) from exc

        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        self._conn = conn
        self._apply_schema()
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            return self.connect()
        return self._conn

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self) -> "ResidentStore":
        self.connect()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def _apply_schema(self) -> None:
        """Bring the state directory up to ``SCHEMA_VERSION``.

        Applies every migration newer than the recorded version, in order, each
        inside the transaction that stamps its version. A fresh directory
        records version 0 and runs them all.
        """

        conn = self._conn
        assert conn is not None
        current = self.schema_version()
        if current > SCHEMA_VERSION:
            raise ResidentError(
                f"State directory {self.state_dir} has schema version {current}, "
                f"newer than this build's {SCHEMA_VERSION}. Refusing to downgrade."
            )
        for version, statements in MIGRATIONS:
            if version <= current:
                continue
            with self.transaction():
                for statement in statements:
                    conn.execute(statement)
                conn.execute(
                    """
                    INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (str(version),),
                )

    def schema_version(self) -> int:
        """Recorded schema version; 0 for a directory that has never migrated."""

        try:
            row = self.conn.execute(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'"
            ).fetchone()
        except sqlite3.OperationalError:
            return 0
        return int(row["value"]) if row else 0

    # --- config ------------------------------------------------------------

    def get_config(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
        return row["value"] if row is not None else None

    def set_config(self, key: str, value: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                               updated_at = excluded.updated_at
                """,
                (key, value, utcnow()),
            )

    def all_config(self) -> dict[str, str]:
        return {row["key"]: row["value"] for row in self.conn.execute("SELECT * FROM config")}

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")

    # --- artifacts ---------------------------------------------------------

    def artifact_dir(self, artifact_hash: str) -> Path:
        return self.artifacts_dir / artifact_hash

    def has_artifact(self, artifact_hash: str) -> bool:
        return (self.artifact_dir(artifact_hash) / "policy.py").is_file()

    def write_artifact(self, code: str, metadata: dict[str, Any] | None = None) -> str:
        """Store policy source content-addressed; return its SHA-256.

        Never overwrites. If the hash directory already exists, its bytes are
        verified against the hash and reused — writing the same policy twice is
        a no-op, and a corrupted existing artifact raises rather than being
        silently repaired.
        """

        canonical = canonicalize_policy(code)
        data = canonical.encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        target = self.artifact_dir(digest)

        if (target / "policy.py").exists():
            self.verify_artifact(digest)
            return digest

        staging = self.artifacts_dir / f".staging-{new_id()}"
        staging.mkdir(parents=True, exist_ok=False)
        try:
            _write_bytes_durably(staging / "policy.py", data)
            manifest = {
                "artifact_hash": digest,
                "algorithm": "sha256",
                "byte_length": len(data),
                "created_at": utcnow(),
                "kind": "policy",
                "metadata": dict(metadata or {}),
            }
            _write_bytes_durably(
                staging / "manifest.json",
                (json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(
                    "utf-8"
                ),
            )
            try:
                # Renaming a directory onto an existing non-empty directory
                # fails on POSIX. That failure is the no-overwrite guarantee.
                os.replace(staging, target)
                # The files were fsynced individually; without this the new
                # directory entry itself can be lost on a crash.
                _fsync_dir(self.artifacts_dir)
            except OSError:
                shutil.rmtree(staging, ignore_errors=True)
                self.verify_artifact(digest)
                return digest
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return digest

    def read_artifact(self, artifact_hash: str) -> str:
        """Read policy source, recomputing and checking the digest. Fails closed."""

        self.verify_artifact(artifact_hash)
        path = self.artifact_dir(artifact_hash) / "policy.py"
        return path.read_bytes().decode("utf-8")

    def verify_artifact(self, artifact_hash: str) -> None:
        path = self.artifact_dir(artifact_hash) / "policy.py"
        if not path.is_file():
            raise ArtifactMissingError(
                f"Artifact {artifact_hash} has no policy.py under {self.artifacts_dir}."
            )
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != artifact_hash:
            raise ArtifactIntegrityError(
                f"Artifact {artifact_hash} failed integrity check: bytes hash to {actual}. "
                "The immutable artifact store was modified out of band; refusing to load it."
            )

    # --- experiences -------------------------------------------------------

    def insert_experience(self, experience: Experience) -> Experience:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO experiences
                    (experience_id, recorded_at, query, answer, outcome, source,
                     tags_json, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    experience.experience_id,
                    experience.recorded_at,
                    experience.query,
                    experience.answer,
                    experience.outcome,
                    experience.source,
                    json.dumps(list(experience.tags), ensure_ascii=False),
                    json.dumps(dict(experience.metadata), ensure_ascii=False),
                ),
            )
        return experience

    def list_experiences(self, limit: int | None = None, newest_first: bool = True) -> list[Experience]:
        order = "DESC" if newest_first else "ASC"
        sql = f"SELECT * FROM experiences ORDER BY seq {order}"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [_row_to_experience(row) for row in self.conn.execute(sql, params)]

    def count_experiences(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) AS n FROM experiences").fetchone()["n"])

    # --- candidates --------------------------------------------------------

    def insert_candidate(self, candidate: Candidate) -> Candidate:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO candidates
                    (candidate_id, created_at, tier, origin, artifact_hash,
                     parent_candidate_id, rationale, cycle, status, public_score, verdict_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.candidate_id,
                    candidate.created_at,
                    candidate.tier,
                    candidate.origin,
                    candidate.artifact_hash,
                    candidate.parent_candidate_id,
                    candidate.rationale,
                    candidate.cycle,
                    candidate.verdict.status,
                    candidate.verdict.public_score,
                    json.dumps(candidate.verdict.to_dict(), ensure_ascii=False),
                ),
            )
        return self.get_candidate(candidate.candidate_id) or candidate

    def get_candidate(self, candidate_id: str) -> Candidate | None:
        row = self.conn.execute(
            "SELECT * FROM candidates WHERE candidate_id = ?", (candidate_id,)
        ).fetchone()
        if row is None:
            return None
        return _row_to_candidate(row, self._child_count(candidate_id))

    def list_candidates(
        self,
        limit: int | None = None,
        newest_first: bool = True,
        statuses: frozenset[str] | set[str] | None = None,
    ) -> list[Candidate]:
        order = "DESC" if newest_first else "ASC"
        sql = "SELECT * FROM candidates"
        params: list[Any] = []
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            sql += f" WHERE status IN ({placeholders})"
            params.extend(sorted(statuses))
        sql += f" ORDER BY seq {order}"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        rows = list(self.conn.execute(sql, tuple(params)))
        counts = self.child_counts()
        return [_row_to_candidate(row, counts.get(row["candidate_id"], 0)) for row in rows]

    def count_candidates(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) AS n FROM candidates").fetchone()["n"])

    def child_counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT parent_candidate_id AS parent, COUNT(*) AS n
            FROM candidates
            WHERE parent_candidate_id IS NOT NULL
            GROUP BY parent_candidate_id
            """
        )
        return {row["parent"]: int(row["n"]) for row in rows}

    def _child_count(self, candidate_id: str) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM candidates WHERE parent_candidate_id = ?",
            (candidate_id,),
        ).fetchone()
        return int(row["n"])

    # --- events ------------------------------------------------------------

    def append_event(
        self,
        kind: str,
        candidate_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> CycleEvent:
        event = CycleEvent(
            event_id=new_id(),
            created_at=utcnow(),
            kind=kind,
            candidate_id=candidate_id,
            payload=dict(payload or {}),
        )
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO events (event_id, created_at, kind, candidate_id, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.created_at,
                    event.kind,
                    event.candidate_id,
                    json.dumps(event.payload, ensure_ascii=False),
                ),
            )
        return event

    def list_events(self, limit: int | None = None, kind: str | None = None) -> list[CycleEvent]:
        sql = "SELECT * FROM events"
        params: list[Any] = []
        if kind is not None:
            sql += " WHERE kind = ?"
            params.append(kind)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [
            CycleEvent(
                event_id=row["event_id"],
                created_at=row["created_at"],
                kind=row["kind"],
                candidate_id=row["candidate_id"],
                payload=json.loads(row["payload_json"]),
            )
            for row in self.conn.execute(sql, tuple(params))
        ]

    def count_events(self, kind: str | None = None) -> int:
        if kind is None:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM events WHERE kind = ?", (kind,)
            ).fetchone()
        return int(row["n"])

    # --- champion pointer --------------------------------------------------

    def read_champion(self) -> Champion | None:
        if not self.champion_path.is_file():
            return None
        try:
            payload = json.loads(self.champion_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise ResidentError(
                f"Champion pointer {self.champion_path} is unreadable: {exc}"
            ) from exc
        return Champion.from_dict(payload)

    def require_champion(self) -> Champion:
        champion = self.read_champion()
        if champion is None:
            raise ResidentNotInitializedError(
                f"No champion in {self.state_dir}. Run "
                "`python3 -m godel_agent_prototype.resident init` first."
            )
        return champion

    def write_champion(self, champion: Champion) -> Champion:
        """Atomically replace the champion pointer.

        Write to a temporary file in the same directory, fsync it, then
        ``os.replace``. A reader sees either the old pointer or the new one,
        never a partial file.
        """

        payload = json.dumps(champion.to_dict(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        tmp_path = self.pointer_dir / f".champion-{new_id()}.json"
        try:
            _write_bytes_durably(tmp_path, payload.encode("utf-8"))
            os.replace(tmp_path, self.champion_path)
            _fsync_dir(self.pointer_dir)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
        return champion

    # --- promotion protocol ------------------------------------------------

    def begin_promotion(
        self,
        candidate_id: str,
        artifact_hash: str,
        previous_candidate_id: str | None,
        reason: str = "",
        actor: str = "",
    ) -> str:
        """Record promotion intent. Step 1 of the recoverable protocol."""

        promotion_id = new_id()
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO promotions
                    (promotion_id, candidate_id, artifact_hash, previous_candidate_id,
                     reason, actor, requested_at, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    promotion_id,
                    candidate_id,
                    artifact_hash,
                    previous_candidate_id,
                    reason,
                    actor,
                    utcnow(),
                    PROMOTION_INTENDED,
                ),
            )
        return promotion_id

    def finalize_promotion(self, promotion_id: str, note: str = "") -> None:
        """Step 3: mark a promotion whose pointer swap is known to have landed."""

        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE promotions SET state = ?, resolved_at = ?, note = ?
                WHERE promotion_id = ? AND state = ?
                """,
                (PROMOTION_FINALIZED, utcnow(), note, promotion_id, PROMOTION_INTENDED),
            )

    def abandon_promotion(self, promotion_id: str, note: str = "") -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE promotions SET state = ?, resolved_at = ?, note = ?
                WHERE promotion_id = ? AND state = ?
                """,
                (PROMOTION_ABANDONED, utcnow(), note, promotion_id, PROMOTION_INTENDED),
            )

    def get_promotion(self, promotion_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM promotions WHERE promotion_id = ?", (promotion_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def pending_promotions(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM promotions WHERE state = ? ORDER BY seq ASC",
            (PROMOTION_INTENDED,),
        )
        return [dict(row) for row in rows]

    def list_promotions(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM promotions ORDER BY seq DESC"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [dict(row) for row in self.conn.execute(sql, params)]

    def recover(self) -> list[dict[str, str]]:
        """Resolve interrupted promotions. Idempotent and deterministic.

        The champion pointer is the source of truth. For each promotion still
        marked ``intended``:

        * pointer carries this ``promotion_id`` -> the atomic swap landed before
          the crash, so roll *forward* and finalize;
        * otherwise -> the swap never happened, so roll *back* and abandon.

        Because the decision is a pure function of the pointer's contents,
        running recovery twice changes nothing the second time.
        """

        pending = self.pending_promotions()
        if not pending:
            return []
        champion = self.read_champion()
        live_promotion_id = champion.promotion_id if champion is not None else None

        actions: list[dict[str, str]] = []
        for record in pending:
            promotion_id = record["promotion_id"]
            if promotion_id == live_promotion_id:
                self.finalize_promotion(promotion_id, note="recovered: pointer swap had landed")
                resolution = PROMOTION_FINALIZED
            else:
                self.abandon_promotion(promotion_id, note="recovered: pointer swap never landed")
                resolution = PROMOTION_ABANDONED
            self.append_event(
                "promotion_recovered",
                candidate_id=record["candidate_id"],
                payload={"promotion_id": promotion_id, "resolution": resolution},
            )
            actions.append({"promotion_id": promotion_id, "resolution": resolution})
        return actions


# --- helpers ---------------------------------------------------------------


def _write_bytes_durably(path: Path, data: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


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


def _row_to_experience(row: sqlite3.Row) -> Experience:
    return Experience(
        experience_id=row["experience_id"],
        recorded_at=row["recorded_at"],
        query=row["query"],
        answer=row["answer"],
        outcome=row["outcome"],
        source=row["source"],
        tags=tuple(json.loads(row["tags_json"])),
        metadata=json.loads(row["metadata_json"]),
    )


def _row_to_candidate(row: sqlite3.Row, children: int) -> Candidate:
    return Candidate(
        candidate_id=row["candidate_id"],
        created_at=row["created_at"],
        tier=row["tier"],
        origin=row["origin"],
        verdict=Verdict.from_dict(json.loads(row["verdict_json"])),
        artifact_hash=row["artifact_hash"],
        parent_candidate_id=row["parent_candidate_id"],
        rationale=row["rationale"],
        cycle=int(row["cycle"]),
        children=children,
        seq=int(row["seq"]),
    )
