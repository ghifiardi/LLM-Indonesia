"""Durable state for the resident loop.

This module is the *only* place in ``resident/`` that touches sqlite or the
filesystem. Everything else asks the store. That keeps three invariants easy to
audit in one file: artifacts are never overwritten and always verified on read,
the champion pointer is only ever replaced atomically, and a missing public
evaluation snapshot fails closed instead of degrading into some other source.

Layout under the state directory::

    <state-dir>/
    ├── state.db                       sqlite (WAL) operational metadata
    ├── artifacts/<sha256>/policy.py   immutable, content-addressed
    ├── artifacts/<sha256>/manifest.json
    ├── eval/public/public_cases.jsonl public-only evaluation snapshot
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
    AuditRecord,
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

#: Emitted when an existing state directory is upgraded, and when the recorded
#: identities change. Both break a readiness observation window: evidence
#: gathered under one configuration says nothing about another.
SCHEMA_MIGRATED_EVENT = "schema_migrated"
IDENTITY_CHANGED_EVENT = "identity_changed"

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

_MIGRATION_3 = (
    """
    CREATE TABLE IF NOT EXISTS audits (
        seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_run_id          TEXT NOT NULL UNIQUE,
        candidate_id          TEXT NOT NULL,
        artifact_hash         TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        status                TEXT NOT NULL,
        holdout_score         REAL,
        num_cases             INTEGER NOT NULL DEFAULT 0,
        safety_failure_count  INTEGER NOT NULL DEFAULT 0,
        category_means_json   TEXT NOT NULL DEFAULT '{}',
        dimension_means_json  TEXT NOT NULL DEFAULT '{}',
        dataset_identity_json TEXT NOT NULL DEFAULT '{}',
        isolation_json        TEXT NOT NULL DEFAULT '{}',
        detail                TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_audits_candidate ON audits(candidate_id)",
)

_MIGRATION_4 = (
    "ALTER TABLE audits ADD COLUMN reason_code TEXT NOT NULL DEFAULT ''",
)

_MIGRATION_5 = (
    """
    CREATE TABLE IF NOT EXISTS gate_verdicts (
        seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
        gate_verdict_id         TEXT NOT NULL UNIQUE,
        created_at              TEXT NOT NULL,
        gate_schema_version     INTEGER NOT NULL,
        candidate_id            TEXT NOT NULL,
        artifact_hash           TEXT NOT NULL,
        champion_candidate_id   TEXT,
        champion_artifact_hash  TEXT,
        dataset_identity_json   TEXT NOT NULL DEFAULT '{}',
        threshold_identity_json TEXT NOT NULL DEFAULT '{}',
        vetoes_json             TEXT NOT NULL DEFAULT '[]',
        passed                  INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_gate_candidate ON gate_verdicts(candidate_id)",
    """
    CREATE TABLE IF NOT EXISTS state_transitions (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        transition_id   TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL,
        candidate_id    TEXT NOT NULL,
        from_state      TEXT,
        to_state        TEXT NOT NULL,
        authorized_by   TEXT NOT NULL,
        evidence_json   TEXT NOT NULL DEFAULT '{}'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_transitions_candidate ON state_transitions(candidate_id)",
)

_MIGRATION_6 = (
    """
    CREATE TABLE IF NOT EXISTS budget_increments (
        seq          INTEGER PRIMARY KEY AUTOINCREMENT,
        counter      TEXT NOT NULL,
        window       TEXT NOT NULL,
        event_id     TEXT NOT NULL,
        candidate_id TEXT,
        created_at   TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_budget_window ON budget_increments(window, counter)",
    """
    CREATE TABLE IF NOT EXISTS freezes (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        freeze_id       TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL,
        reason          TEXT NOT NULL DEFAULT '',
        actor           TEXT NOT NULL DEFAULT '',
        trigger_json    TEXT NOT NULL DEFAULT '{}',
        state           TEXT NOT NULL,
        resolved_at     TEXT,
        resolved_reason TEXT NOT NULL DEFAULT '',
        resolved_by     TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_freezes_state ON freezes(state)",
)

_MIGRATION_7 = (
    """
    CREATE TABLE IF NOT EXISTS served_requests (
        seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id             TEXT NOT NULL UNIQUE,
        created_at             TEXT NOT NULL,
        ingested_at            TEXT NOT NULL,
        requested_route        TEXT NOT NULL,
        actual_route           TEXT NOT NULL,
        served_candidate_id    TEXT,
        served_artifact_hash   TEXT,
        champion_candidate_id  TEXT,
        canary_candidate_id    TEXT,
        fallback_used          INTEGER NOT NULL DEFAULT 0,
        routing_bucket         INTEGER,
        latency_ms             INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL DEFAULT '',
        timed_out              INTEGER NOT NULL DEFAULT 0,
        raised                 INTEGER NOT NULL DEFAULT 0,
        exception_type         TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_served_route ON served_requests(actual_route)",
    """
    CREATE TABLE IF NOT EXISTS serving_vetoes (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL UNIQUE,
        created_at     TEXT NOT NULL,
        ingested_at    TEXT NOT NULL,
        kind           TEXT NOT NULL,
        candidate_id   TEXT,
        artifact_hash  TEXT,
        request_id     TEXT,
        veto           TEXT NOT NULL,
        detail_json    TEXT NOT NULL DEFAULT '{}'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_vetoes_kind ON serving_vetoes(kind, created_at)",
)

_MIGRATION_8 = (
    """
    CREATE TABLE IF NOT EXISTS canary_activations (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        activation_id   TEXT NOT NULL UNIQUE,
        created_at      TEXT NOT NULL,
        candidate_id    TEXT NOT NULL,
        artifact_hash   TEXT NOT NULL,
        percent         INTEGER NOT NULL,
        gate_verdict_id TEXT,
        reason          TEXT NOT NULL DEFAULT '',
        actor           TEXT NOT NULL DEFAULT '',
        state           TEXT NOT NULL,
        resolved_at     TEXT,
        resolved_reason TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_canary_state ON canary_activations(state)",
)

_MIGRATION_9 = (
    "ALTER TABLE serving_vetoes ADD COLUMN activation_id TEXT NOT NULL DEFAULT ''",
    "CREATE INDEX IF NOT EXISTS idx_vetoes_activation ON serving_vetoes(activation_id)",
)

_MIGRATION_10 = (
    """
    CREATE TABLE IF NOT EXISTS readiness_checks (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id      TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        name          TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        detail        TEXT NOT NULL DEFAULT '',
        state_dir     TEXT NOT NULL DEFAULT '',
        is_drill      INTEGER NOT NULL DEFAULT 1,
        evidence_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_readiness_name ON readiness_checks(name)",
    """
    CREATE TABLE IF NOT EXISTS readiness_reports (
        seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id               TEXT NOT NULL UNIQUE,
        created_at              TEXT NOT NULL,
        schema_version          INTEGER NOT NULL,
        verdict                 TEXT NOT NULL,
        dataset_identity_json   TEXT NOT NULL DEFAULT '{}',
        threshold_identity_json TEXT NOT NULL DEFAULT '{}',
        champion_candidate_id   TEXT,
        champion_artifact_hash  TEXT,
        window_start            TEXT,
        window_end              TEXT,
        build_fingerprint       TEXT NOT NULL DEFAULT '',
        items_json              TEXT NOT NULL DEFAULT '[]',
        summary_json            TEXT NOT NULL DEFAULT '{}'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS veto_labels (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        label_id      TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        request_id    TEXT NOT NULL UNIQUE,
        artifact_hash TEXT NOT NULL,
        veto          TEXT NOT NULL,
        label         TEXT NOT NULL,
        actor         TEXT NOT NULL DEFAULT '',
        note          TEXT NOT NULL DEFAULT ''
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
    (3, _MIGRATION_3),
    (4, _MIGRATION_4),
    (5, _MIGRATION_5),
    (6, _MIGRATION_6),
    (7, _MIGRATION_7),
    (8, _MIGRATION_8),
    (9, _MIGRATION_9),
    (10, _MIGRATION_10),
)

SCHEMA_VERSION = MIGRATIONS[-1][0]

#: Config key binding a state directory to one environment. See ``reflect.py``:
#: candidates from different task domains must not share an archive.
CONFIG_ENVIRONMENT = "environment"

#: Config key recording the identity of the anchor dataset the public snapshot
#: came from. An audit against a different dataset is refused rather than
#: silently scored — see ``anchors.DatasetIdentity``.
CONFIG_DATASET_IDENTITY = "dataset_identity"

#: Config key recording the identity of the gate/budget threshold files in
#: force at init. The gate re-checks it, so swapping thresholds afterwards
#: fails closed instead of quietly changing what the gate enforces.
CONFIG_THRESHOLD_IDENTITY = "threshold_identity"

PUBLIC_SNAPSHOT_FILENAME = "public_cases.jsonl"


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
        self.canary_path = self.pointer_dir / "canary.json"
        self.spool_dir = self.state_dir / "spool"
        self._conn: sqlite3.Connection | None = None
        self._readonly = False

    # --- lifecycle ---------------------------------------------------------

    @classmethod
    def open_readonly(cls, state_dir: str | os.PathLike[str] | None = None) -> "ResidentStore":
        """Open with a read-only SQLite connection and no migrations.

        For the serving process, which must not be able to modify state even by
        mistake. Writes raise ``sqlite3.OperationalError`` at the driver level,
        not by convention — and the store creates no directories and runs no
        recovery, so opening it cannot have a side effect either.
        """

        store = cls(state_dir)
        store._readonly = True
        store.connect()
        return store

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
        if self._readonly:
            if not self.db_path.is_file():
                raise ResidentNotInitializedError(
                    f"No state database at {self.db_path}. Run `init` first."
                )
            uri = f"file:{self.db_path}?mode=ro"
            conn = sqlite3.connect(
                uri, uri=True, isolation_level=None, check_same_thread=False
            )
            conn.row_factory = sqlite3.Row
            self._conn = conn
            return conn
        try:
            self.artifacts_dir.mkdir(parents=True, exist_ok=True)
            self.pointer_dir.mkdir(parents=True, exist_ok=True)
            self.public_eval_dir.mkdir(parents=True, exist_ok=True)
            self.spool_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.spool_dir, 0o700)
        except OSError as exc:
            raise StateDirectoryError(
                f"Cannot create state directory {self.state_dir}: {exc}. "
                f"Pass --state-dir or set ${STATE_DIR_ENV_VAR} to a writable path."
            ) from exc

        # check_same_thread=False lets the store move between threads — the
        # supervisor is constructed on one and runs its loop on another. It is
        # never used *concurrently*: the supervisor accepts a control frame and
        # ticks sequentially in a single thread.
        conn = sqlite3.connect(self.db_path, isolation_level=None, check_same_thread=False)
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
        upgraded_from = current
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
        if upgraded_from and upgraded_from < SCHEMA_VERSION:
            # Only for an *existing* directory. A fresh one runs every migration
            # at creation, which is not a change to anything that was observed.
            self.append_event(
                SCHEMA_MIGRATED_EVENT,
                payload={"from_version": upgraded_from, "to_version": SCHEMA_VERSION},
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

    # --- public evaluation snapshot ----------------------------------------

    @property
    def public_snapshot_path(self) -> Path:
        return self.public_eval_dir / PUBLIC_SNAPSHOT_FILENAME

    def has_public_snapshot(self) -> bool:
        return self.public_snapshot_path.is_file()

    def write_public_snapshot(self, records: list[dict[str, Any]]) -> Path:
        """Persist the public evaluation snapshot as JSONL, atomically.

        Records are opaque here: which cases are public is an environment
        decision that stays in ``reflect.py``. What lives in this module is the
        durability — one line per record, fsynced, renamed into place, and the
        containing directory fsynced so the new entry survives a crash.
        """

        if not records:
            raise ResidentError("Refusing to write an empty public snapshot.")
        payload = (
            "\n".join(json.dumps(record, ensure_ascii=False, sort_keys=True) for record in records)
            + "\n"
        ).encode("utf-8")

        path = self.public_snapshot_path
        tmp_path = self.public_eval_dir / f".{PUBLIC_SNAPSHOT_FILENAME}.{new_id()}.tmp"
        try:
            _write_bytes_durably(tmp_path, payload)
            os.replace(tmp_path, path)
            _fsync_dir(self.public_eval_dir)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
        return path

    def read_public_snapshot(self) -> list[dict[str, Any]]:
        """Read the snapshot. Fails closed when it is absent or malformed.

        A missing snapshot must never degrade into reading a source dataset
        somewhere else, so this raises rather than returning an empty list.
        """

        path = self.public_snapshot_path
        if not path.is_file():
            raise ResidentNotInitializedError(
                f"No public evaluation snapshot at {path}. Run "
                "`python3 -m godel_agent_prototype.resident init` first."
            )
        records: list[dict[str, Any]] = []
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ResidentError(f"Public evaluation snapshot {path} is unreadable: {exc}") from exc
        for line_number, raw in enumerate(text.splitlines(), start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ResidentError(
                    f"Public evaluation snapshot {path}:{line_number} is not valid JSON: {exc}"
                ) from exc
            if not isinstance(record, dict):
                raise ResidentError(
                    f"Public evaluation snapshot {path}:{line_number} is not an object."
                )
            records.append(record)
        if not records:
            raise ResidentNotInitializedError(
                f"Public evaluation snapshot {path} is empty. Run "
                "`python3 -m godel_agent_prototype.resident init` first."
            )
        return records

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

    # --- audits ------------------------------------------------------------
    #
    # Append-only by construction: there is no update or delete method here, and
    # an audit never touches a candidate's reflection verdict. A candidate
    # accumulates audit rows; it never has one rewritten.

    def insert_audit(self, record: "AuditRecord") -> "AuditRecord":
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO audits
                    (audit_run_id, candidate_id, artifact_hash, created_at, status,
                     holdout_score, num_cases, safety_failure_count,
                     category_means_json, dimension_means_json,
                     dataset_identity_json, isolation_json, reason_code, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.audit_run_id,
                    record.candidate_id,
                    record.artifact_hash,
                    record.created_at,
                    record.status,
                    record.holdout_score,
                    record.num_cases,
                    record.safety_failure_count,
                    json.dumps(dict(record.category_means), ensure_ascii=False),
                    json.dumps(dict(record.dimension_means), ensure_ascii=False),
                    json.dumps(dict(record.dataset_identity), ensure_ascii=False),
                    json.dumps(dict(record.isolation), ensure_ascii=False),
                    record.reason_code,
                    record.detail,
                ),
            )
        return record

    def list_audits(
        self, candidate_id: str | None = None, limit: int | None = None
    ) -> list["AuditRecord"]:
        sql = "SELECT * FROM audits"
        params: list[Any] = []
        if candidate_id is not None:
            sql += " WHERE candidate_id = ?"
            params.append(candidate_id)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [_row_to_audit(row) for row in self.conn.execute(sql, tuple(params))]

    def count_audits(self, candidate_id: str | None = None) -> int:
        if candidate_id is None:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM audits").fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM audits WHERE candidate_id = ?", (candidate_id,)
            ).fetchone()
        return int(row["n"])

    # --- gate verdicts and state transitions --------------------------------
    #
    # Both append-only. There is no update or delete method: a gate verdict is
    # evidence about a moment, and a transition is something that happened.

    def insert_gate_verdict(self, verdict: Any) -> Any:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO gate_verdicts
                    (gate_verdict_id, created_at, gate_schema_version, candidate_id,
                     artifact_hash, champion_candidate_id, champion_artifact_hash,
                     dataset_identity_json, threshold_identity_json, vetoes_json, passed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    verdict.gate_verdict_id,
                    verdict.created_at,
                    verdict.gate_schema_version,
                    verdict.candidate_id,
                    verdict.artifact_hash,
                    verdict.champion_candidate_id,
                    verdict.champion_artifact_hash,
                    json.dumps(dict(verdict.dataset_identity), ensure_ascii=False),
                    json.dumps(dict(verdict.threshold_identity), ensure_ascii=False),
                    json.dumps([v.to_dict() for v in verdict.vetoes], ensure_ascii=False),
                    1 if verdict.passed else 0,
                ),
            )
        return verdict

    def get_gate_verdict(self, gate_verdict_id: str) -> Any:
        row = self.conn.execute(
            "SELECT * FROM gate_verdicts WHERE gate_verdict_id = ?", (gate_verdict_id,)
        ).fetchone()
        return _row_to_gate_verdict(row) if row is not None else None

    def list_gate_verdicts(
        self, candidate_id: str | None = None, limit: int | None = None
    ) -> list[Any]:
        sql = "SELECT * FROM gate_verdicts"
        params: list[Any] = []
        if candidate_id is not None:
            sql += " WHERE candidate_id = ?"
            params.append(candidate_id)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [_row_to_gate_verdict(row) for row in self.conn.execute(sql, tuple(params))]

    def consecutive_gate_failures(self) -> int:
        """Failing gate evaluations since the last passing one.

        Derived from the immutable log rather than kept as a mutable counter,
        so it cannot drift from the evidence.
        """

        count = 0
        for row in self.conn.execute(
            "SELECT passed FROM gate_verdicts ORDER BY seq DESC"
        ):
            if row["passed"]:
                break
            count += 1
        return count

    def insert_state_transition(
        self,
        candidate_id: str,
        from_state: str | None,
        to_state: str,
        authorized_by: str,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        record = {
            "transition_id": new_id(),
            "created_at": utcnow(),
            "candidate_id": candidate_id,
            "from_state": from_state,
            "to_state": to_state,
            "authorized_by": authorized_by,
            "evidence": dict(evidence or {}),
        }
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO state_transitions
                    (transition_id, created_at, candidate_id, from_state, to_state,
                     authorized_by, evidence_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["transition_id"],
                    record["created_at"],
                    candidate_id,
                    from_state,
                    to_state,
                    authorized_by,
                    json.dumps(record["evidence"], ensure_ascii=False),
                ),
            )
        return record

    def candidate_state(self, candidate_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT to_state FROM state_transitions WHERE candidate_id = ? ORDER BY seq DESC LIMIT 1",
            (candidate_id,),
        ).fetchone()
        return row["to_state"] if row is not None else None

    def list_state_transitions(
        self, candidate_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM state_transitions"
        params: list[Any] = []
        if candidate_id is not None:
            sql += " WHERE candidate_id = ?"
            params.append(candidate_id)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [
            {
                "transition_id": row["transition_id"],
                "created_at": row["created_at"],
                "candidate_id": row["candidate_id"],
                "from_state": row["from_state"],
                "to_state": row["to_state"],
                "authorized_by": row["authorized_by"],
                "evidence": json.loads(row["evidence_json"]),
            }
            for row in self.conn.execute(sql, tuple(params))
        ]

    # --- budget counters and freezes ----------------------------------------
    #
    # Counters are derived by counting append-only increment rows rather than
    # kept as a mutable total, and every increment names the event that caused
    # it. A limit that was reached can therefore always be explained.

    def record_budget_increment(
        self, counter: str, window: str, event_id: str, candidate_id: str | None = None
    ) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO budget_increments (counter, window, event_id, candidate_id, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (counter, window, event_id, candidate_id, utcnow()),
            )

    def budget_snapshot(self, window: str) -> dict[str, int]:
        """All counters for one window, read in a single pass.

        Taken once per gate evaluation so every veto sees the same numbers.
        """

        rows = self.conn.execute(
            "SELECT counter, COUNT(*) AS n FROM budget_increments WHERE window = ? GROUP BY counter",
            (window,),
        )
        return {row["counter"]: int(row["n"]) for row in rows}

    def list_budget_increments(
        self, window: str | None = None, counter: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM budget_increments"
        clauses: list[str] = []
        params: list[Any] = []
        if window is not None:
            clauses.append("window = ?")
            params.append(window)
        if counter is not None:
            clauses.append("counter = ?")
            params.append(counter)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [dict(row) for row in self.conn.execute(sql, tuple(params))]

    def insert_freeze(
        self, freeze_id: str, reason: str, actor: str, trigger: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO freezes (freeze_id, created_at, reason, actor, trigger_json, state)
                VALUES (?, ?, ?, ?, ?, 'active')
                """,
                (
                    freeze_id,
                    utcnow(),
                    reason,
                    actor,
                    json.dumps(dict(trigger or {}), ensure_ascii=False),
                ),
            )
        return self.get_freeze(freeze_id) or {}

    def resolve_freeze(self, freeze_id: str, reason: str, actor: str) -> int:
        """Mark an active freeze resolved. Returns rows changed (0 if not active).

        The row is never deleted: an unfreeze resolves the record, it does not
        erase that a freeze happened.
        """

        with self.transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE freezes SET state = 'resolved', resolved_at = ?,
                                   resolved_reason = ?, resolved_by = ?
                WHERE freeze_id = ? AND state = 'active'
                """,
                (utcnow(), reason, actor, freeze_id),
            )
            return cursor.rowcount

    def get_freeze(self, freeze_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM freezes WHERE freeze_id = ?", (freeze_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def active_freeze(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM freezes WHERE state = 'active' ORDER BY seq ASC LIMIT 1"
        ).fetchone()
        return dict(row) if row is not None else None

    def list_freezes(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM freezes ORDER BY seq DESC"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [dict(row) for row in self.conn.execute(sql, params)]

    # --- served requests and serving vetoes ---------------------------------
    #
    # Written only by the supervisor, ingesting what the serving process
    # spooled. Both keyed by an id the writer generated, so replaying a spool
    # file after a crash is a harmless duplicate attempt rather than a
    # duplicated record.

    def insert_served_request(self, record: dict[str, Any]) -> bool:
        with self.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO served_requests
                    (request_id, created_at, ingested_at, requested_route, actual_route,
                     served_candidate_id, served_artifact_hash, champion_candidate_id,
                     canary_candidate_id, fallback_used, routing_bucket, latency_ms,
                     status, timed_out, raised, exception_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["request_id"],
                    record["created_at"],
                    utcnow(),
                    record.get("requested_route", ""),
                    record.get("actual_route", ""),
                    record.get("served_candidate_id"),
                    record.get("served_artifact_hash"),
                    record.get("champion_candidate_id"),
                    record.get("canary_candidate_id"),
                    1 if record.get("fallback_used") else 0,
                    record.get("routing_bucket"),
                    int(record.get("latency_ms") or 0),
                    record.get("status", ""),
                    1 if record.get("timed_out") else 0,
                    1 if record.get("raised") else 0,
                    record.get("exception_type", ""),
                ),
            )
            return cursor.rowcount > 0

    def insert_served_request_with_experience(
        self, record: dict[str, Any], experience: Any
    ) -> tuple[bool, bool]:
        """Insert the request row and its experience in one transaction.

        Both are ``INSERT OR IGNORE``, so this is safe to replay *and* it heals:
        a partial state where the request landed and the experience did not is
        repaired by the next ingest, rather than being mistaken for a complete
        duplicate and skipped forever.
        """

        with self.transaction() as conn:
            request_cursor = conn.execute(
                """
                INSERT OR IGNORE INTO served_requests
                    (request_id, created_at, ingested_at, requested_route, actual_route,
                     served_candidate_id, served_artifact_hash, champion_candidate_id,
                     canary_candidate_id, fallback_used, routing_bucket, latency_ms,
                     status, timed_out, raised, exception_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["request_id"],
                    record["created_at"],
                    utcnow(),
                    record.get("requested_route", ""),
                    record.get("actual_route", ""),
                    record.get("served_candidate_id"),
                    record.get("served_artifact_hash"),
                    record.get("champion_candidate_id"),
                    record.get("canary_candidate_id"),
                    1 if record.get("fallback_used") else 0,
                    record.get("routing_bucket"),
                    int(record.get("latency_ms") or 0),
                    record.get("status", ""),
                    1 if record.get("timed_out") else 0,
                    1 if record.get("raised") else 0,
                    record.get("exception_type", ""),
                ),
            )
            experience_cursor = conn.execute(
                """
                INSERT OR IGNORE INTO experiences
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
            return request_cursor.rowcount > 0, experience_cursor.rowcount > 0

    def insert_serving_veto(self, record: dict[str, Any]) -> bool:
        with self.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO serving_vetoes
                    (observation_id, created_at, ingested_at, kind, candidate_id,
                     artifact_hash, request_id, veto, detail_json, activation_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["observation_id"],
                    record["created_at"],
                    utcnow(),
                    record["kind"],
                    record.get("candidate_id"),
                    record.get("artifact_hash"),
                    record.get("request_id"),
                    record.get("veto", ""),
                    json.dumps(dict(record.get("detail") or {}), ensure_ascii=False),
                    record.get("activation_id", "") or "",
                ),
            )
            return cursor.rowcount > 0

    def list_served_requests(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM served_requests ORDER BY seq DESC"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [dict(row) for row in self.conn.execute(sql, params)]

    def count_served_requests(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) AS n FROM served_requests").fetchone()["n"])

    def list_serving_vetoes(
        self,
        kind: str | None = None,
        since: str | None = None,
        limit: int | None = None,
        activation_id: str | None = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM serving_vetoes"
        clauses: list[str] = []
        params: list[Any] = []
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        if since is not None:
            clauses.append("created_at >= ?")
            params.append(since)
        if activation_id is not None:
            clauses.append("activation_id = ?")
            params.append(activation_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [dict(row) for row in self.conn.execute(sql, tuple(params))]

    # --- readiness evidence -------------------------------------------------
    #
    # All append-only. A drill result is evidence about a moment, a report is a
    # document about a window, and a label is a human's judgement — none of the
    # three is something to revise later.

    def insert_readiness_check(self, record: dict[str, Any]) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO readiness_checks
                    (check_id, created_at, name, outcome, detail, state_dir,
                     is_drill, evidence_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["check_id"],
                    record.get("created_at") or utcnow(),
                    record["name"],
                    record["outcome"],
                    record.get("detail", "")[:2000],
                    record.get("state_dir", ""),
                    1 if record.get("is_drill", True) else 0,
                    json.dumps(dict(record.get("evidence") or {}), ensure_ascii=False),
                ),
            )

    def list_readiness_checks(
        self, name: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM readiness_checks"
        params: list[Any] = []
        if name is not None:
            sql += " WHERE name = ?"
            params.append(name)
        sql += " ORDER BY seq DESC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        return [dict(row) for row in self.conn.execute(sql, tuple(params))]

    def insert_readiness_report(self, record: dict[str, Any]) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO readiness_reports
                    (report_id, created_at, schema_version, verdict,
                     dataset_identity_json, threshold_identity_json,
                     champion_candidate_id, champion_artifact_hash,
                     window_start, window_end, build_fingerprint,
                     items_json, summary_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["report_id"],
                    record.get("created_at") or utcnow(),
                    int(record["schema_version"]),
                    record["verdict"],
                    json.dumps(dict(record.get("dataset_identity") or {}), ensure_ascii=False),
                    json.dumps(dict(record.get("threshold_identity") or {}), ensure_ascii=False),
                    record.get("champion_candidate_id"),
                    record.get("champion_artifact_hash"),
                    record.get("window_start"),
                    record.get("window_end"),
                    record.get("build_fingerprint", ""),
                    json.dumps(list(record.get("items") or []), ensure_ascii=False),
                    json.dumps(dict(record.get("summary") or {}), ensure_ascii=False),
                ),
            )

    def list_readiness_reports(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM readiness_reports ORDER BY seq DESC"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [dict(row) for row in self.conn.execute(sql, params)]

    def insert_veto_label(self, record: dict[str, Any]) -> bool:
        """One label per request, immutable. Returns False if already labelled."""

        with self.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO veto_labels
                    (label_id, created_at, request_id, artifact_hash, veto, label, actor, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["label_id"],
                    utcnow(),
                    record["request_id"],
                    record["artifact_hash"],
                    record["veto"],
                    record["label"],
                    record.get("actor", ""),
                    record.get("note", "")[:1000],
                ),
            )
            return cursor.rowcount > 0

    def list_veto_labels(self, limit: int | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM veto_labels ORDER BY seq DESC"
        params: tuple[Any, ...] = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        return [dict(row) for row in self.conn.execute(sql, params)]

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

    # --- canary pointer and activations -------------------------------------

    def read_canary(self) -> dict[str, Any] | None:
        if not self.canary_path.is_file():
            return None
        try:
            return json.loads(self.canary_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise ResidentError(f"Canary pointer {self.canary_path} is unreadable: {exc}") from exc

    def write_canary(self, payload: dict[str, Any]) -> None:
        """Atomically replace the canary pointer, mode 0600."""

        body = json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        tmp_path = self.pointer_dir / f".canary-{new_id()}.json"
        try:
            _write_bytes_durably(tmp_path, body.encode("utf-8"))
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self.canary_path)
            _fsync_dir(self.pointer_dir)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    def clear_canary_pointer(self) -> None:
        self.canary_path.unlink(missing_ok=True)
        _fsync_dir(self.pointer_dir)

    def insert_canary_activation(self, record: dict[str, Any]) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO canary_activations
                    (activation_id, created_at, candidate_id, artifact_hash, percent,
                     gate_verdict_id, reason, actor, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["activation_id"],
                    utcnow(),
                    record["candidate_id"],
                    record["artifact_hash"],
                    int(record["percent"]),
                    record.get("gate_verdict_id"),
                    record.get("reason", ""),
                    record.get("actor", ""),
                    record["state"],
                ),
            )

    def set_canary_activation_state(
        self, activation_id: str, state: str, resolved_reason: str = ""
    ) -> int:
        with self.transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE canary_activations
                SET state = ?, resolved_at = ?, resolved_reason = ?
                WHERE activation_id = ?
                """,
                (
                    state,
                    utcnow() if state in ("cleared", "abandoned") else None,
                    resolved_reason,
                    activation_id,
                ),
            )
            return cursor.rowcount

    def get_canary_activation(self, activation_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM canary_activations WHERE activation_id = ?", (activation_id,)
        ).fetchone()
        return dict(row) if row is not None else None

    def canary_activations(self, states: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM canary_activations"
        params: tuple[Any, ...] = ()
        if states:
            placeholders = ",".join("?" for _ in states)
            sql += f" WHERE state IN ({placeholders})"
            params = tuple(states)
        sql += " ORDER BY seq DESC"
        return [dict(row) for row in self.conn.execute(sql, params)]

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


def _row_to_gate_verdict(row: sqlite3.Row) -> Any:
    from .gate import GateVerdict, VetoResult

    return GateVerdict(
        gate_verdict_id=row["gate_verdict_id"],
        created_at=row["created_at"],
        gate_schema_version=int(row["gate_schema_version"]),
        candidate_id=row["candidate_id"],
        artifact_hash=row["artifact_hash"],
        champion_candidate_id=row["champion_candidate_id"],
        champion_artifact_hash=row["champion_artifact_hash"],
        dataset_identity=json.loads(row["dataset_identity_json"]),
        threshold_identity=json.loads(row["threshold_identity_json"]),
        vetoes=tuple(VetoResult.from_dict(v) for v in json.loads(row["vetoes_json"])),
        passed=bool(row["passed"]),
    )


def _row_to_audit(row: sqlite3.Row) -> AuditRecord:
    return AuditRecord(
        audit_run_id=row["audit_run_id"],
        candidate_id=row["candidate_id"],
        artifact_hash=row["artifact_hash"],
        created_at=row["created_at"],
        status=row["status"],
        holdout_score=row["holdout_score"],
        num_cases=int(row["num_cases"]),
        safety_failure_count=int(row["safety_failure_count"]),
        category_means=json.loads(row["category_means_json"]),
        dimension_means=json.loads(row["dimension_means_json"]),
        dataset_identity=json.loads(row["dataset_identity_json"]),
        isolation=json.loads(row["isolation_json"]),
        reason_code=row["reason_code"],
        detail=row["detail"],
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
