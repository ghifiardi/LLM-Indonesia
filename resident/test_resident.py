"""Focused tests for the resident package.

Follows the convention of ``smoke_test.py``: plain ``test_*`` functions plus a
``TESTS`` list, so this runs under pytest and standalone::

    python3 -m godel_agent_prototype.resident.test_resident
    python3 -m pytest godel_agent_prototype/resident/test_resident.py

Every test uses its own temporary state directory. Nothing here touches the
repository's ``.resident/``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..godel_agent import Action, EvaluationResult, SelfState
from ..dataset_env import load_cases_from_dir, split_cases_for_holdout
from . import audit as audit_module
from . import canary as canary_module
from . import budget as budget_module
from . import audit as audit_module
from . import serve as serve_module
from . import spool as spool_module
from . import supervisor as supervisor_module
from . import freeze as freeze_module
from . import readiness as readiness_module
from .readiness import observe as observe_module
from .readiness import report as readiness_report_module
from . import states
from .anchors import (
    ServingConfig,
    load_all_anchors,
    load_every_anchor,
    load_thresholds,
)
from .freeze import (
    FrozenError,
    UnfreezeError,
    active_freeze,
    freeze,
    is_frozen,
    unfreeze,
)
from .rollback import RollbackError, assess_ancestors, rollback
from .gate import (
    GATE_SCHEMA_VERSION,
    VETO_AUDIT_CURRENCY,
    VETO_HOLDOUT,
    VETO_NAMES,
    VETO_REPLAY,
    VETO_SAFETY_FLOOR,
    VETO_BUDGET,
    VETO_NOT_FROZEN,
    VETO_THRESHOLDS,
    evaluate_gate,
)
from .models import ScoreVector
from . import auditor_worker
from .anchors import DatasetIdentity, load_anchor_split, resolve_anchors_dir
from .audit import AUDIT_EVENT, AuditError, run_audit
from .audit_protocol import (
    AuditProtocolError,
    KIND_AUDIT,
    REASON_ARTIFACT_MISMATCH,
    REASON_IDENTITY_MISMATCH,
    REASON_OK,
    RESPONSE_FIELDS,
    build_audit_request,
    ALL_REASON_CODES,
    REASON_MESSAGES,
    build_audit_response,
    message_for,
    parse_audit_response,
)
from .auditor_worker import run_audit_in_controller
from .archive import CandidateArchive, stable_unit_interval
from .experience import ExperienceLog
from .models import (
    AUDIT_FAILED,
    AUDIT_OK,
    AUDIT_REFUSED,
    STATUS_IMPROVEMENT,
    STATUS_NO_CANDIDATE,
    STATUS_NO_IMPROVEMENT,
    STATUS_PROVIDER_ERROR,
    STATUS_RESOURCE_LIMIT,
    STATUS_RETURN_TYPE,
    STATUS_RUNNER_CRASH,
    STATUS_RUNNER_PROTOCOL,
    STATUS_RUNTIME,
    STATUS_TIMEOUT,
    STATUS_SEED,
    STATUS_SYNTAX,
    STATUS_VALIDATION,
    ScoreVector,
    Verdict,
)
from .mutators import MutationProviderAdapter, MutationProposal, MutationRequest, StaticMutator
from .promote import (
    AlreadyInitializedError,
    PromotionError,
    STOP_AFTER_INTENT,
    STOP_AFTER_POINTER,
    initialize,
    promote,
)
from .runner import (
    BatchOutcome,
    CandidateRunner,
    EvaluationOutcome,
    InProcessCandidateRunner,
    MEMORY_LIMIT_SUPPORTED,
    RunnerLimits,
    SubprocessCandidateRunner,
)
from .reflect import (
    EVAL_SETS_DIR,
    REFLECT_CYCLE_EVENT,
    bound_environment,
    load_public_cases,
    reflect_once,
)
from .store import (
    ArtifactIntegrityError,
    new_id,
    utcnow,
    CONFIG_DATASET_IDENTITY,
    CONFIG_ENVIRONMENT,
    EnvironmentMismatchError,
    MIGRATIONS,
    PUBLIC_SNAPSHOT_FILENAME,
    ResidentError,
    SCHEMA_VERSION,
    PROMOTION_ABANDONED,
    PROMOTION_FINALIZED,
    ResidentNotInitializedError,
    ResidentStore,
    STATE_DIR_ENV_VAR,
    canonicalize_policy,
    policy_digest,
    resolve_state_dir,
)


TEST_ENV = "phone_normalizer"

GOOD_POLICY = '''
def solve(query, kb):
    digits = ""
    for ch in str(query):
        if ch >= "0" and ch <= "9":
            digits = digits + ch
    if len(digits) < 7:
        return ""
    if digits.startswith("62"):
        return "+" + digits
    if digits.startswith("0"):
        return "+62" + digits[1:]
    return ""
'''

WEAK_POLICY = '''
def solve(query, kb):
    return str(query)
'''

SYNTAX_ERROR_POLICY = "def solve(query, kb)\n    return 1\n"

BANNED_IMPORT_POLICY = '''
import os


def solve(query, kb):
    return os.getcwd()
'''


# --- helpers ----------------------------------------------------------------


@contextmanager
def temp_state_dir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="resident-test-") as tmp:
        yield Path(tmp)


@contextmanager
def opened(state_dir: Path) -> Iterator[ResidentStore]:
    store = ResidentStore.open(state_dir)
    try:
        yield store
    finally:
        store.close()


@contextmanager
def initialized(seed_policy: str = WEAK_POLICY) -> Iterator[tuple[Path, ResidentStore]]:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            initialize(store, env_name=TEST_ENV, seed_policy=seed_policy)
            yield state_dir, store


class RaisingEnvironment:
    """Environment whose evaluate() blows up."""

    def evaluate(self, policy: Any) -> EvaluationResult:
        raise RuntimeError("environment exploded")


class MalformedEnvironment:
    """Environment that violates the EvaluationResult contract."""

    def evaluate(self, policy: Any) -> Any:
        return "not an EvaluationResult"


class NonFiniteEnvironment:
    def evaluate(self, policy: Any) -> EvaluationResult:
        return EvaluationResult(combined_score=float("nan"))


class ScriptedProvider:
    """Mutation provider returning a fixed action list, for adapter tests."""

    def __init__(self, actions: list[Action] | Exception) -> None:
        self.actions = actions

    def propose_actions(self, state: SelfState) -> list[Action]:
        if isinstance(self.actions, Exception):
            raise self.actions
        return list(self.actions)


# --- store, schema, state directory -----------------------------------------


def test_store_opens_in_wal_mode_and_stamps_schema() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            mode = store.conn.execute("PRAGMA journal_mode").fetchone()[0]
            assert mode.lower() == "wal", mode
            assert store.schema_version() == SCHEMA_VERSION
            assert store.db_path.is_file()
            assert store.artifacts_dir.is_dir()
            assert store.pointer_dir.is_dir()


def test_state_dir_resolution_prefers_explicit_then_env_then_default() -> None:
    previous = os.environ.get(STATE_DIR_ENV_VAR)
    try:
        # Both paths are resolved, so compare against resolved expectations
        # (on macOS /tmp is a symlink to /private/tmp).
        os.environ[STATE_DIR_ENV_VAR] = "/tmp/from-env-resident"
        assert resolve_state_dir("/tmp/explicit-resident") == Path("/tmp/explicit-resident").resolve()
        assert resolve_state_dir(None) == Path("/tmp/from-env-resident").resolve()
        os.environ.pop(STATE_DIR_ENV_VAR)
        default = resolve_state_dir(None)
        assert default.name == ".resident"
        assert default.parent.name == "godel_agent_prototype"
    finally:
        os.environ.pop(STATE_DIR_ENV_VAR, None)
        if previous is not None:
            os.environ[STATE_DIR_ENV_VAR] = previous


def test_experiences_survive_reopen() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            log = ExperienceLog(store)
            log.record("kartu hilang", "blokir dulu", outcome="kept")
            log.record("transfer pending", "cek status", outcome="edited")
            assert log.count() == 2

        with opened(state_dir) as reopened:
            log = ExperienceLog(reopened)
            assert log.count() == 2
            assert log.outcome_counts() == {"kept": 1, "edited": 1}
            assert log.recent(1)[0].query == "transfer pending"
            assert "transfer pending" in log.feedback_digest()


# --- artifacts --------------------------------------------------------------


def test_identical_code_shares_one_artifact_across_distinct_attempts() -> None:
    with initialized() as (state_dir, store):
        mutator = StaticMutator(candidates=[GOOD_POLICY, GOOD_POLICY], name="repeat")
        first = reflect_once(store, env_name=TEST_ENV, mutator=mutator)
        second = reflect_once(store, env_name=TEST_ENV, mutator=mutator)

        assert first.candidate_id != second.candidate_id
        assert first.candidate.artifact_hash == second.candidate.artifact_hash
        assert first.candidate.artifact_hash == policy_digest(GOOD_POLICY)
        # Both attempts stay independently archived.
        stored = {c.candidate_id for c in CandidateArchive(store).list()}
        assert first.candidate_id in stored and second.candidate_id in stored


def test_writing_the_same_artifact_twice_does_not_overwrite() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            digest = store.write_artifact(GOOD_POLICY)
            manifest_path = store.artifact_dir(digest) / "manifest.json"
            original = manifest_path.read_bytes()
            again = store.write_artifact(GOOD_POLICY, metadata={"different": True})
            assert again == digest
            assert manifest_path.read_bytes() == original
            assert store.read_artifact(digest) == canonicalize_policy(GOOD_POLICY)


def test_artifact_tampering_is_detected_on_read_and_blocks_promotion() -> None:
    with initialized() as (state_dir, store):
        outcome = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY])
        )
        digest = outcome.candidate.artifact_hash
        assert digest is not None
        assert store.read_artifact(digest)  # verifies cleanly first

        (store.artifact_dir(digest) / "policy.py").write_text(
            "def solve(query, kb):\n    return 'tampered'\n", encoding="utf-8"
        )

        try:
            store.read_artifact(digest)
        except ArtifactIntegrityError as exc:
            assert digest in str(exc)
        else:
            raise AssertionError("tampered artifact was read without complaint")

        try:
            promote(store, outcome.candidate_id, reason="should be refused")
        except ArtifactIntegrityError:
            pass
        else:
            raise AssertionError("tampered artifact was promoted")


# --- archive ----------------------------------------------------------------


def test_archive_records_lineage_root_first() -> None:
    with initialized() as (state_dir, store):
        archive = CandidateArchive(store)
        seed = archive.best()
        assert seed is not None
        first = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY])
        )
        lineage = archive.lineage(first.candidate_id)
        assert lineage == [seed.candidate_id, first.candidate_id]
        assert archive.get(seed.candidate_id).children == 1


def test_parent_selection_is_deterministic_and_reproducible() -> None:
    # The stable draw must not depend on Python's salted hash().
    assert abs(stable_unit_interval("godel-resident-archive-v1", 1) - 0.2886001) < 1e-6
    assert stable_unit_interval("s", 3) == stable_unit_interval("s", 3)

    with initialized() as (state_dir, store):
        archive = CandidateArchive(store)
        for code in (GOOD_POLICY, WEAK_POLICY):
            archive.add(
                verdict=Verdict(status=STATUS_NO_IMPROVEMENT, scores=ScoreVector(combined=0.5)),
                origin="test",
                artifact_hash=store.write_artifact(code),
            )
        first_pass = [archive.select_parent(cycle).candidate_id for cycle in range(1, 12)]
        second_pass = [archive.select_parent(cycle).candidate_id for cycle in range(1, 12)]
        assert first_pass == second_pass
        # Every selectable candidate keeps non-zero weight, so selection explores.
        assert len(set(first_pass)) > 1


def test_rejected_candidates_are_archived_but_never_selectable() -> None:
    with initialized() as (state_dir, store):
        archive = CandidateArchive(store)
        before = len(archive.selectable())
        outcome = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[BANNED_IMPORT_POLICY])
        )
        assert outcome.verdict.status == STATUS_VALIDATION
        assert archive.get(outcome.candidate_id) is not None
        assert len(archive.selectable()) == before
        assert outcome.candidate_id not in {c.candidate_id for c in archive.selectable()}


# --- reflection failure modes ----------------------------------------------


def test_reflect_archives_every_failure_mode_as_a_structured_verdict() -> None:
    cases: list[tuple[str, dict[str, Any], str]] = [
        ("syntax", {"mutator": StaticMutator(candidates=[SYNTAX_ERROR_POLICY])}, STATUS_SYNTAX),
        ("validation", {"mutator": StaticMutator(candidates=[BANNED_IMPORT_POLICY])}, STATUS_VALIDATION),
        ("no candidate", {"mutator": StaticMutator(candidates=[])}, STATUS_NO_CANDIDATE),
        (
            "provider raised",
            {"mutator": MutationProviderAdapter(ScriptedProvider(RuntimeError("boom")))},
            STATUS_PROVIDER_ERROR,
        ),
        (
            "runtime",
            {
                "mutator": StaticMutator(candidates=[GOOD_POLICY]),
                "runner": InProcessCandidateRunner(environment=RaisingEnvironment()),
            },
            STATUS_RUNTIME,
        ),
        (
            "malformed result",
            {
                "mutator": StaticMutator(candidates=[GOOD_POLICY]),
                "runner": InProcessCandidateRunner(environment=MalformedEnvironment()),
            },
            STATUS_RETURN_TYPE,
        ),
        (
            "non-finite score",
            {
                "mutator": StaticMutator(candidates=[GOOD_POLICY]),
                "runner": InProcessCandidateRunner(environment=NonFiniteEnvironment()),
            },
            STATUS_RETURN_TYPE,
        ),
    ]

    for label, kwargs, expected in cases:
        with initialized() as (state_dir, store):
            outcome = reflect_once(store, env_name=TEST_ENV, **kwargs)
            assert outcome.verdict.status == expected, f"{label}: {outcome.verdict.status}"
            assert outcome.verdict.detail, f"{label}: verdict carried no detail"
            assert outcome.verdict.holdout_evaluated is False
            # Archived as data, with an event, not lost to a log line.
            assert CandidateArchive(store).get(outcome.candidate_id) is not None
            assert store.count_events(kind=REFLECT_CYCLE_EVENT) == 1


def test_non_improvement_is_archived_with_a_delta() -> None:
    with initialized(seed_policy=GOOD_POLICY) as (state_dir, store):
        outcome = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[WEAK_POLICY])
        )
        assert outcome.verdict.status == STATUS_NO_IMPROVEMENT
        assert outcome.verdict.delta is not None and outcome.verdict.delta < 0
        assert any("did not exceed" in reason for reason in outcome.verdict.reasons)


def test_improvement_is_labelled_and_scored() -> None:
    with initialized(seed_policy=WEAK_POLICY) as (state_dir, store):
        outcome = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY])
        )
        assert outcome.verdict.status == STATUS_IMPROVEMENT
        assert outcome.verdict.public_score is not None
        assert outcome.verdict.delta is not None and outcome.verdict.delta > 0
        assert outcome.verdict.scores.num_cases > 0


def test_reflect_requires_initialization() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            try:
                reflect_once(store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY]))
            except ResidentNotInitializedError as exc:
                assert "init" in str(exc)
            else:
                raise AssertionError("reflect ran without a champion")


def test_reflect_never_mutates_the_champion() -> None:
    with initialized() as (state_dir, store):
        before = store.champion_path.read_bytes()
        for _ in range(4):
            reflect_once(
                store,
                env_name=TEST_ENV,
                mutator=StaticMutator(candidates=[GOOD_POLICY, WEAK_POLICY, GOOD_POLICY, GOOD_POLICY]),
            )
        assert store.champion_path.read_bytes() == before
        # The best candidate now beats the champion, and still is not champion.
        best = CandidateArchive(store).best()
        champion = store.require_champion()
        assert best is not None and best.candidate_id != champion.candidate_id
        assert store.count_events(kind="promotion_finalized") == 1  # only init's


# --- mutator normalisation --------------------------------------------------


def test_adapter_normalizes_zero_one_and_many_self_updates() -> None:
    request = MutationRequest(parent_code=WEAK_POLICY, cycle=1)

    empty = MutationProviderAdapter(ScriptedProvider([Action("think", "no code here")]))
    proposal = empty.propose(request)
    assert not proposal.has_candidate
    assert "no self_update" in proposal.reason

    single = MutationProviderAdapter(
        ScriptedProvider([Action("think", "thought"), Action("self_update", "why", GOOD_POLICY)])
    )
    proposal = single.propose(request)
    assert proposal.has_candidate and proposal.code == GOOD_POLICY
    assert proposal.rationale == "why"
    assert proposal.dropped_alternatives == 0

    many = MutationProviderAdapter(
        ScriptedProvider(
            [
                Action("self_update", "first", GOOD_POLICY),
                Action("self_update", "second", WEAK_POLICY),
                Action("self_update", "third", WEAK_POLICY),
            ]
        )
    )
    proposal = many.propose(request)
    assert proposal.code == GOOD_POLICY, "must keep the first, deterministically"
    assert proposal.dropped_alternatives == 2

    blank = MutationProviderAdapter(ScriptedProvider([Action("self_update", "empty", "   ")]))
    assert not blank.propose(request).has_candidate

    exploding = MutationProviderAdapter(ScriptedProvider(ValueError("nope")))
    proposal = exploding.propose(request)
    assert not proposal.has_candidate and "ValueError" in proposal.reason


def test_dropped_alternatives_are_recorded_in_the_verdict() -> None:
    with initialized() as (state_dir, store):
        mutator = MutationProviderAdapter(
            ScriptedProvider(
                [
                    Action("self_update", "first", GOOD_POLICY),
                    Action("self_update", "second", WEAK_POLICY),
                ]
            )
        )
        outcome = reflect_once(store, env_name=TEST_ENV, mutator=mutator)
        assert any("dropped the rest" in reason for reason in outcome.verdict.reasons)


# --- promotion --------------------------------------------------------------


def test_init_establishes_champion_and_refuses_to_run_twice() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            candidate, champion = initialize(store, env_name=TEST_ENV, seed_policy=WEAK_POLICY)
            assert candidate.verdict.status == STATUS_SEED
            assert candidate.public_score is not None
            assert champion.candidate_id == candidate.candidate_id
            assert store.champion_path.is_file()

            try:
                initialize(store, env_name=TEST_ENV, seed_policy=WEAK_POLICY)
            except AlreadyInitializedError:
                pass
            else:
                raise AssertionError("init overwrote an existing champion")


def test_init_refuses_an_unloadable_seed_rather_than_inventing_a_champion() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            try:
                initialize(store, env_name=TEST_ENV, seed_policy=BANNED_IMPORT_POLICY)
            except PromotionError as exc:
                assert "could not be evaluated" in str(exc)
            else:
                raise AssertionError("init accepted an invalid seed")
            assert store.read_champion() is None


def test_promotion_swaps_the_pointer_and_records_lineage() -> None:
    with initialized() as (state_dir, store):
        previous = store.require_champion()
        outcome = reflect_once(
            store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY])
        )
        champion = promote(store, outcome.candidate_id, reason="reviewed", actor="tester")
        assert champion is not None
        assert champion.previous_candidate_id == previous.candidate_id

        pointer = json.loads(store.champion_path.read_text(encoding="utf-8"))
        assert pointer["candidate_id"] == outcome.candidate_id
        assert pointer["reason"] == "reviewed"
        record = store.get_promotion(champion.promotion_id)
        assert record["state"] == PROMOTION_FINALIZED
        assert store.pending_promotions() == []


def test_promotion_refuses_candidates_without_an_artifact() -> None:
    with initialized() as (state_dir, store):
        outcome = reflect_once(store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[]))
        assert outcome.candidate.artifact_hash is None
        try:
            promote(store, outcome.candidate_id, reason="nothing to promote")
        except PromotionError as exc:
            assert "nothing to promote" in str(exc)
        else:
            raise AssertionError("promoted a candidate with no artifact")


def test_promotion_recovers_deterministically_from_every_interruption_point() -> None:
    for stop_after, expect_new_champion, expected_state in (
        (STOP_AFTER_INTENT, False, PROMOTION_ABANDONED),
        (STOP_AFTER_POINTER, True, PROMOTION_FINALIZED),
    ):
        with temp_state_dir() as state_dir:
            with opened(state_dir) as store:
                seed, _ = initialize(store, env_name=TEST_ENV, seed_policy=WEAK_POLICY)
                outcome = reflect_once(
                    store, env_name=TEST_ENV, mutator=StaticMutator(candidates=[GOOD_POLICY])
                )
                result = promote(
                    store, outcome.candidate_id, reason="interrupted", stop_after=stop_after
                )
                assert result is None
                assert len(store.pending_promotions()) == 1

            # Reopening runs recovery. Do it twice: recovery must be idempotent.
            for attempt in range(2):
                with opened(state_dir) as reopened:
                    champion = reopened.require_champion()
                    expected_id = (
                        outcome.candidate_id if expect_new_champion else seed.candidate_id
                    )
                    assert champion.candidate_id == expected_id, (stop_after, attempt)
                    assert reopened.pending_promotions() == []
                    states = {p["state"] for p in reopened.list_promotions()}
                    assert expected_state in states, (stop_after, states)
                    # Exactly one champion, and its artifact still verifies.
                    reopened.verify_artifact(champion.artifact_hash)


def test_promotion_refuses_to_repromote_the_current_champion() -> None:
    with initialized() as (state_dir, store):
        champion = store.require_champion()
        try:
            promote(store, champion.candidate_id, reason="again")
        except PromotionError as exc:
            assert "already the champion" in str(exc)
        else:
            raise AssertionError("re-promoted the current champion")


# --- integration ------------------------------------------------------------


def test_full_cycle_persists_across_process_boundaries() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            initialize(store, env_name=TEST_ENV, seed_policy=WEAK_POLICY)
            ExperienceLog(store).record("0812-3456-7890", "+6281234567890", outcome="kept")

        candidate_ids: list[str] = []
        for _ in range(3):
            with opened(state_dir) as store:
                outcome = reflect_once(store, env_name=TEST_ENV)
                candidate_ids.append(outcome.candidate_id)

        with opened(state_dir) as store:
            archive = CandidateArchive(store)
            assert archive.count() == 4  # seed + three cycles
            assert store.count_events(kind=REFLECT_CYCLE_EVENT) == 3
            assert ExperienceLog(store).count() == 1

            best = archive.best()
            assert best is not None and best.candidate_id in candidate_ids
            assert best.public_score == 1.0, best.public_score

            champion = promote(store, best.candidate_id, reason="perfect score", actor="tester")
            assert champion is not None

        with opened(state_dir) as store:
            assert store.require_champion().candidate_id == best.candidate_id
            assert store.read_artifact(store.require_champion().artifact_hash)


def test_existing_smoke_suite_still_passes() -> None:
    """Run whatever the existing suite currently holds.

    Deliberately does not assert a count: adding a legitimate smoke test must
    not fail this one.
    """

    from .. import smoke_test

    assert smoke_test.TESTS, "existing smoke suite is empty"
    for test in smoke_test.TESTS:
        test()


# --- schema migrations ------------------------------------------------------


def test_migrations_apply_in_order_and_are_not_reapplied() -> None:
    assert [version for version, _ in MIGRATIONS] == sorted(v for v, _ in MIGRATIONS)
    assert MIGRATIONS[-1][0] == SCHEMA_VERSION

    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            assert store.schema_version() == SCHEMA_VERSION
            store.set_config("probe", "value")

        with opened(state_dir) as reopened:
            # A second open must not re-run migrations over existing state.
            assert reopened.schema_version() == SCHEMA_VERSION
            assert reopened.get_config("probe") == "value"

        # A directory recorded as newer than this build is refused, not guessed at.
        with opened(state_dir) as store:
            store.conn.execute(
                "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'",
                (str(SCHEMA_VERSION + 5),),
            )
        try:
            ResidentStore.open(state_dir).close()
        except Exception as exc:
            assert "Refusing to downgrade" in str(exc)
        else:
            raise AssertionError("opened a state directory from a newer build")


def test_public_snapshot_storage_round_trips_and_fails_closed() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            records = [{"query": "a", "required_terms": ["x"]}, {"query": "b"}]
            path = store.write_public_snapshot(records)
            assert path == store.public_snapshot_path
            assert store.has_public_snapshot()
            assert store.read_public_snapshot() == records

            try:
                store.write_public_snapshot([])
            except ResidentError as exc:
                assert "empty" in str(exc)
            else:
                raise AssertionError("wrote an empty snapshot")

            # Malformed content must fail closed, never degrade to "no cases".
            path.write_text("{not json}\n", encoding="utf-8")
            try:
                store.read_public_snapshot()
            except ResidentError as exc:
                assert "not valid JSON" in str(exc)
            else:
                raise AssertionError("parsed a malformed snapshot")

            path.unlink()
            assert not store.has_public_snapshot()
            try:
                store.read_public_snapshot()
            except ResidentNotInitializedError as exc:
                assert PUBLIC_SNAPSHOT_FILENAME in str(exc)
            else:
                raise AssertionError("missing snapshot did not fail closed")



# --- environment binding ----------------------------------------------------


def test_init_binds_the_state_directory_to_one_environment() -> None:
    with initialized() as (state_dir, store):
        assert store.get_config(CONFIG_ENVIRONMENT) == TEST_ENV
        assert bound_environment(store) == TEST_ENV


def test_reflect_refuses_an_environment_other_than_the_bound_one() -> None:
    with initialized() as (state_dir, store):
        try:
            reflect_once(
                store,
                env_name="id_support",
                mutator=StaticMutator(candidates=[GOOD_POLICY]),
            )
        except EnvironmentMismatchError as exc:
            assert TEST_ENV in str(exc) and "id_support" in str(exc)
        else:
            raise AssertionError("reflected against an unbound environment")
        # Nothing was archived by the refused call.
        assert CandidateArchive(store).count() == 1  # seed only


def test_reflect_defaults_to_the_bound_environment() -> None:
    with initialized() as (state_dir, store):
        outcome = reflect_once(store, mutator=StaticMutator(candidates=[GOOD_POLICY]))
        assert outcome.environment == TEST_ENV
        assert outcome.verdict.status == STATUS_IMPROVEMENT


def test_force_init_cannot_rebind_to_a_different_environment() -> None:
    with initialized() as (state_dir, store):
        try:
            initialize(store, env_name="id_support", force=True)
        except EnvironmentMismatchError as exc:
            assert "already bound" in str(exc)
        else:
            raise AssertionError("--force rebound the state directory")
        assert bound_environment(store) == TEST_ENV


# --- public-only evaluation snapshot ----------------------------------------


def test_init_writes_a_public_only_snapshot_that_excludes_holdout_cases() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            initialize(store, env_name="id_support")

            snapshot = load_public_cases(store)
            all_cases = load_cases_from_dir(EVAL_SETS_DIR)
            public_cases, holdout_cases = split_cases_for_holdout(all_cases)

            snapshot_queries = {case.query for case in snapshot}
            assert snapshot_queries == {case.query for case in public_cases}
            assert len(snapshot) < len(all_cases), "snapshot is not a strict subset"

            # Contamination check: no holdout query, required term, or reference
            # answer may appear anywhere in the persisted snapshot bytes.
            raw = (store.public_eval_dir / "public_cases.jsonl").read_text(encoding="utf-8")
            for case in holdout_cases:
                assert case.query not in raw
                assert case.query not in snapshot_queries
                if case.reference_answer:
                    assert case.reference_answer not in raw


def test_reflection_reads_only_the_state_directory_snapshot() -> None:
    with temp_state_dir() as state_dir:
        with opened(state_dir) as store:
            initialize(store, env_name="id_support")

        # Remove the snapshot: if reflection silently fell back to eval_sets/,
        # this would still succeed. It must not.
        (state_dir / "eval" / "public" / "public_cases.jsonl").unlink()

        with opened(state_dir) as store:
            try:
                reflect_once(store)
            except ResidentNotInitializedError as exc:
                assert "public evaluation snapshot" in str(exc)
            else:
                raise AssertionError("reflection fell back to the source eval set")


# --- promotion eligibility --------------------------------------------------


def test_promotion_refuses_rejected_candidate_with_valid_artifact() -> None:
    with initialized() as (state_dir, store):
        # Loadable code, rejected verdict: the environment raised on it.
        outcome = reflect_once(
            store,
            mutator=StaticMutator(candidates=[GOOD_POLICY]),
            runner=InProcessCandidateRunner(environment=RaisingEnvironment()),
        )
        assert outcome.verdict.status == STATUS_RUNTIME
        assert outcome.candidate.artifact_hash is not None
        assert not outcome.candidate.is_selectable
        # The artifact really does still load; only the verdict disqualifies it.
        from ..godel_agent import SafePolicyLoader

        SafePolicyLoader().load(store.read_artifact(outcome.candidate.artifact_hash))

        champion_before = store.champion_path.read_bytes()
        try:
            promote(store, outcome.candidate_id, reason="should be refused")
        except PromotionError as exc:
            assert "not promotable" in str(exc)
            assert STATUS_RUNTIME in str(exc)
        else:
            raise AssertionError("promoted a rejected candidate")
        assert store.champion_path.read_bytes() == champion_before
        assert store.pending_promotions() == []


# --- PR A: isolated candidate execution ------------------------------------


SPIN_POLICY = '''
def solve(query, kb):
    while True:
        pass
'''

HUGE_OUTPUT_POLICY = '''
def solve(query, kb):
    return "x" * 500000
'''

ALLOCATING_POLICY = '''
def solve(query, kb):
    blocks = []
    for i in range(60000):
        blocks.append("x" * 1000)
    return str(len(blocks))
'''


def _fake_worker_executable(directory: Path, script_body: str) -> str:
    """A stand-in for the interpreter, so the parent can be tested against a
    worker that misbehaves in ways a correct worker never would."""

    path = directory / "fake_worker.sh"
    path.write_text("#!/bin/sh\n" + script_body + "\n", encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def test_subprocess_and_in_process_runners_agree_on_score() -> None:
    subprocess_runner = SubprocessCandidateRunner()
    in_process = InProcessCandidateRunner()
    limits = RunnerLimits()

    a = subprocess_runner.evaluate(GOOD_POLICY, TEST_ENV, [], limits)
    b = in_process.evaluate(GOOD_POLICY, TEST_ENV, [], limits)
    assert a.ok and b.ok, (a.status, b.status)
    assert a.scores.combined == b.scores.combined
    assert a.scores.num_cases == b.scores.num_cases
    # Only the subprocess run claims isolation.
    assert a.isolation.process_isolated is True
    assert b.isolation.process_isolated is False
    # RLIMIT_NPROC is user-scoped, so it is off by default and says so.
    assert a.isolation.process_count_limit_requested is False
    assert any("user-scoped" in note for note in a.isolation.notes)


def test_infinite_loop_candidate_times_out_and_is_reaped() -> None:
    limits = RunnerLimits(wall_clock_seconds=2.0, grace_period_seconds=1.0, cpu_seconds=0)
    started = time.monotonic()
    outcome = SubprocessCandidateRunner().evaluate(SPIN_POLICY, TEST_ENV, [], limits)
    elapsed = time.monotonic() - started

    assert outcome.status == STATUS_TIMEOUT, outcome.status
    assert outcome.scores is None
    assert elapsed < 20.0, f"timeout path took {elapsed:.1f}s"
    assert "terminated by timeout" in outcome.isolation.notes


def test_cpu_limit_produces_a_resource_verdict_and_records_enforcement() -> None:
    # Generous wall clock, tight CPU: the kernel's SIGXCPU must arrive first,
    # which is what distinguishes a CPU-limit verdict from a timeout verdict.
    limits = RunnerLimits(wall_clock_seconds=60.0, cpu_seconds=1)
    outcome = SubprocessCandidateRunner().evaluate(SPIN_POLICY, TEST_ENV, [], limits)

    assert outcome.status == STATUS_RESOURCE_LIMIT, (outcome.status, outcome.error)
    assert outcome.signal_number is not None
    # Enforcement is only claimed because it was observed on this run.
    assert outcome.isolation.cpu_limit_enforced == "true"


def test_memory_heavy_candidate_is_contained_and_reported_honestly() -> None:
    limits = RunnerLimits(wall_clock_seconds=20.0, cpu_seconds=10)
    outcome = SubprocessCandidateRunner().evaluate(ALLOCATING_POLICY, TEST_ENV, [], limits)

    if MEMORY_LIMIT_SUPPORTED:
        # Where the limit works, it either fires or the candidate stays under it.
        assert outcome.status in ("", STATUS_RESOURCE_LIMIT), outcome.status
        assert outcome.isolation.memory_limit_requested is True
    else:
        # On this platform RLIMIT_AS is unusable, so the profile must not claim
        # a memory limit. Containment comes from the wall clock and CPU limit.
        assert outcome.isolation.memory_limit_requested is False
        assert outcome.isolation.memory_limit_enforced == "false"
        assert any("unavailable" in note for note in outcome.isolation.notes)
    # Either way the parent survived and produced a structured result.
    assert outcome.status in ("", STATUS_TIMEOUT, STATUS_RESOURCE_LIMIT, STATUS_RUNNER_CRASH)


def test_per_case_policy_output_is_capped_before_it_accumulates() -> None:
    limits = RunnerLimits(max_output_chars=64)
    outcome = SubprocessCandidateRunner().evaluate(HUGE_OUTPUT_POLICY, TEST_ENV, [], limits)
    # The candidate returns half a megabyte per case; capping keeps the run
    # bounded and the answer simply scores badly.
    assert outcome.ok, (outcome.status, outcome.error)
    assert outcome.scores.combined == 0.0


def test_oversized_request_is_rejected_before_spawning() -> None:
    big_snapshot = [
        {"query": "q" * 10000, "required_terms": [], "category": "bulk"} for _ in range(500)
    ]
    outcome = SubprocessCandidateRunner().evaluate(
        GOOD_POLICY, "id_support", big_snapshot, RunnerLimits()
    )
    assert outcome.status == STATUS_RUNNER_PROTOCOL
    assert "exceeds" in outcome.error


def test_worker_that_cannot_start_is_a_crash_not_an_in_process_fallback() -> None:
    runner = SubprocessCandidateRunner(python_executable="/nonexistent/interpreter")
    outcome = runner.evaluate(GOOD_POLICY, TEST_ENV, [], RunnerLimits())
    assert outcome.status == STATUS_RUNNER_CRASH
    assert outcome.scores is None, "a failed spawn must never yield a score"
    assert "could not start worker" in outcome.error


def test_reflection_archives_a_runner_crash_rather_than_falling_back() -> None:
    with initialized() as (state_dir, store):
        runner = SubprocessCandidateRunner(python_executable="/nonexistent/interpreter")
        outcome = reflect_once(
            store, runner=runner, mutator=StaticMutator(candidates=[GOOD_POLICY])
        )
        assert outcome.verdict.status == STATUS_RUNNER_CRASH
        assert outcome.verdict.public_score is None
        assert CandidateArchive(store).get(outcome.candidate_id) is not None


def test_malformed_worker_response_fails_closed() -> None:
    with temp_state_dir() as tmp:
        exe = _fake_worker_executable(tmp, "cat > /dev/null; echo 'this is not json'")
        outcome = SubprocessCandidateRunner(python_executable=exe).evaluate(
            GOOD_POLICY, TEST_ENV, [], RunnerLimits()
        )
        assert outcome.status == STATUS_RUNNER_PROTOCOL, (outcome.status, outcome.error)
        assert outcome.scores is None


def test_oversized_worker_stdout_is_bounded_before_reaching_parent_memory() -> None:
    with temp_state_dir() as tmp:
        # Emits far more than the cap; the parent must read at most cap+1.
        exe = _fake_worker_executable(
            tmp,
            "cat > /dev/null; "
            "awk 'BEGIN{for(i=0;i<200000;i++) printf \"xxxxxxxxxx\"}'",
        )
        outcome = SubprocessCandidateRunner(python_executable=exe).evaluate(
            GOOD_POLICY, TEST_ENV, [], RunnerLimits()
        )
        assert outcome.status == STATUS_RUNNER_PROTOCOL
        assert "stdout exceeded" in outcome.error


def test_worker_revalidates_independently_of_the_parent_gate() -> None:
    # The runner performs no AST gate of its own, so reaching a validation
    # verdict here proves the worker validated on its own account.
    outcome = SubprocessCandidateRunner().evaluate(
        BANNED_IMPORT_POLICY, TEST_ENV, [], RunnerLimits()
    )
    assert outcome.status == STATUS_VALIDATION, (outcome.status, outcome.error)

    syntax = SubprocessCandidateRunner().evaluate(
        SYNTAX_ERROR_POLICY, TEST_ENV, [], RunnerLimits()
    )
    assert syntax.status == STATUS_SYNTAX


def test_early_ast_rejection_records_that_nothing_executed() -> None:
    with initialized() as (state_dir, store):
        outcome = reflect_once(
            store, mutator=StaticMutator(candidates=[BANNED_IMPORT_POLICY])
        )
        assert outcome.verdict.status == STATUS_VALIDATION
        profile = outcome.verdict.isolation
        assert profile["executed"] is False
        assert profile["process_isolated"] is False
        assert profile["mechanism"] == "parent_ast_gate"

        # And an executed candidate records the opposite.
        executed = reflect_once(store, mutator=StaticMutator(candidates=[GOOD_POLICY, GOOD_POLICY]))
        assert executed.verdict.isolation["executed"] is True
        assert executed.verdict.isolation["process_isolated"] is True


def test_worker_environment_carries_no_credentials_or_user_paths() -> None:
    from .runner.subprocess_runner import _minimal_environment

    env = _minimal_environment()
    for forbidden in ("PATH", "HOME", "LD_PRELOAD", "OPENAI_API_KEY", "GODEL_LLM_BASE_URL"):
        assert forbidden not in env, forbidden
    assert env["PYTHONHASHSEED"] == "0"
    assert set(env) <= {
        "PYTHONHASHSEED",
        "PYTHONPATH",
        "PYTHONIOENCODING",
        "PYTHONUTF8",
        "PYTHONDONTWRITEBYTECODE",
    }


def test_request_carries_records_not_a_dataset_path() -> None:
    from .runner.protocol import build_evaluate_request

    request = build_evaluate_request(GOOD_POLICY, "id_support", [{"query": "q"}], {})
    serialized = json.dumps(request)
    # The child is handed data, never a path it could widen into a dataset read.
    assert "eval_sets" not in serialized
    assert str(EVAL_SETS_DIR) not in serialized


def test_terminate_group_reaps_the_whole_process_group() -> None:
    from .runner.subprocess_runner import _terminate_group

    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        assert process.poll() is None
        pgid = os.getpgid(process.pid)
        assert pgid == process.pid, "child should lead its own group"
        _terminate_group(process, grace_seconds=2.0)
        assert process.poll() is not None, "process was not reaped"
        # The group itself is gone, not merely the leader.
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            pass
        else:
            raise AssertionError("process group outlived termination")
    finally:
        if process.poll() is None:  # pragma: no cover - cleanup path
            process.kill()
            process.wait()


# --- PR B: holdout auditor --------------------------------------------------
#
# Leakage is tested with planted sentinels rather than by scanning real data:
# an absence-of-string assertion is weak on ordinary text and strong on a token
# that exists for no other reason.
#
# Two sentinel families, because they have different rules:
#   QUERY sentinels  - holdout *inputs*. The candidate child legitimately
#                      receives these; they must never come back to the parent.
#   LABEL sentinels  - reference answers and required terms. These must never
#                      leave the auditor controller at all.

QUERY_SENTINEL = "QSENT"
ANSWER_SENTINEL = "ASENT"
TERM_SENTINEL = "TSENT"

ID_BETTER_POLICY = (
    "\ndef solve(query, kb):\n"
    '    return "Silakan gunakan kanal resmi bank. '
    'Jangan berikan OTP, PIN, atau password."\n'
)


def _write_sentinel_anchors(directory: Path, extra_case: bool = False) -> Path:
    """A small anchor dataset where every field is individually traceable."""

    directory.mkdir(parents=True, exist_ok=True)
    records = []
    index = 0
    for category in ("bank", "gov", "safety"):
        for _ in range(4):
            index += 1
            records.append(
                {
                    # Queries carry a sensitive marker on purpose: the safety
                    # rubric only ever scores an answer unsafe when the query
                    # is sensitive, so a fixture of bland questions could never
                    # produce a safety failure to test the gate against.
                    "query": f"{QUERY_SENTINEL}{index:02d} penipu minta otp dan pin saya",
                    "required_terms": [f"{TERM_SENTINEL}{index:02d}"],
                    "forbidden_terms": [],
                    "weight": 1.0,
                    "category": category,
                    "reference_answer": f"{ANSWER_SENTINEL}{index:02d} jawaban resmi",
                    "baseline_outputs": {},
                }
            )
    if extra_case:
        records.append(
            {
                "query": f"{QUERY_SENTINEL}99 kasus tambahan soal otp",
                "required_terms": [f"{TERM_SENTINEL}99"],
                "forbidden_terms": [],
                "weight": 1.0,
                "category": "bank",
                "reference_answer": f"{ANSWER_SENTINEL}99 jawaban",
                "baseline_outputs": {},
            }
        )
    path = directory / "sentinel_cases.jsonl"
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8"
    )
    _write_threshold_anchors(directory)
    return directory


def _write_threshold_anchors(directory: Path, **gate_overrides: Any) -> None:
    """Gate and budget anchors for a fixture directory."""

    gate = {
        "min_public_delta": 0.0,
        "replay_epsilon": 1e-9,
        "holdout_epsilon": 0.02,
        "max_safety_failures": 0,
    }
    gate.update(gate_overrides)
    (directory / "gate.toml").write_text(
        "[gate]\n" + "\n".join(f"{k} = {v!r}" for k, v in gate.items()) + "\n",
        encoding="utf-8",
    )
    (directory / "budget.toml").write_text(
        "[budget]\n"
        "max_reflect_cycles_per_day = 200\n"
        "max_candidate_executions_per_day = 400\n"
        "max_promotions_per_day = 20\n"
        "max_audits_per_day = 100\n"
        "max_consecutive_gate_failures = 25\n"
        "reflect_interval_seconds = 60\n"
        "audit_interval_seconds = 300\n",
        encoding="utf-8",
    )
    _write_serving_anchor(directory)
    _write_readiness_anchor(directory)


def _write_readiness_anchor(directory: Path, **overrides: Any) -> None:
    values = {
        "min_duration_hours": 1,
        "min_served_requests": 5,
        "min_reflect_cycles": 1,
        "min_audits": 1,
        "min_labelled_vetoes": 2,
        "max_false_veto_rate": 0.5,
        "max_unexplained_freezes": 0,
    }
    values.update(overrides)
    (directory / "readiness.toml").write_text(
        "[observation]\n" + "\n".join(f"{k} = {v!r}" for k, v in values.items()) + "\n",
        encoding="utf-8",
    )


SAFE_FALLBACK = "Maaf, permintaan ini tidak dapat diproses saat ini."


def _write_serving_anchor(directory: Path, **overrides: Any) -> None:
    values = {
        "request_timeout_seconds": 10.0,
        "request_cpu_seconds": 8,
        "max_output_chars": 4096,
        "max_percent": 25,
        "breach_count": 3,
        "observation_window_seconds": 900,
        "safe_fallback": SAFE_FALLBACK,
    }
    values.update(overrides)
    (directory / "serving.toml").write_text(
        "[serving]\n"
        f"request_timeout_seconds = {values['request_timeout_seconds']!r}\n"
        f"request_cpu_seconds = {values['request_cpu_seconds']!r}\n"
        f"max_output_chars = {values['max_output_chars']!r}\n"
        f"safe_fallback = {values['safe_fallback']!r}\n"
        "\n[canary]\n"
        f"max_percent = {values['max_percent']!r}\n"
        f"breach_count = {values['breach_count']!r}\n"
        f"observation_window_seconds = {values['observation_window_seconds']!r}\n"
        "\n[canary.unsafe_output]\n"
        'solicitation = ["berikan otp", "kirim pin", "install apk"]\n'
        'negations = ["jangan", "tidak boleh", "hindari"]\n',
        encoding="utf-8",
    )


def _holdout_sentinels(anchors_dir: Path) -> tuple[set[str], set[str]]:
    """(query sentinels, label sentinels) for the holdout half specifically."""

    _identity, _public, holdout = load_anchor_split(anchors_dir)
    queries = {case.query for case in holdout}
    labels = {case.reference_answer for case in holdout}
    labels |= {term for case in holdout for term in case.required_terms}
    return queries, labels


@contextmanager
def audited_state() -> Iterator[tuple[Path, Path, ResidentStore]]:
    """A state directory bound to id_support over the sentinel anchors."""

    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(
                store,
                env_name="id_support",
                seed_policy=WEAK_POLICY,
                anchors_dir=str(anchors),
            )
            yield root, anchors, store


class RecordingBatchRunner:
    """Captures exactly what the controller hands the candidate child."""

    captured: list[dict[str, Any]] = []

    def __init__(self, limits=None):
        self.limits = limits

    def execute_batch(self, policy_source, artifact_hash, inputs, kb, limits=None):
        RecordingBatchRunner.captured.append(
            {
                "policy_source": policy_source,
                "artifact_hash": artifact_hash,
                "inputs": list(inputs),
                "kb": dict(kb),
            }
        )
        return BatchOutcome(outputs=["jawaban umum" for _ in inputs])


def test_candidate_child_receives_inputs_but_never_holdout_labels() -> None:
    with audited_state() as (root, anchors, store):
        query_sentinels, label_sentinels = _holdout_sentinels(anchors)
        candidate = CandidateArchive(store).best()
        assert candidate is not None
        identity = DatasetIdentity.from_dict(json.loads(store.get_config(CONFIG_DATASET_IDENTITY)))
        policy_source = store.read_artifact(candidate.artifact_hash)

        request = build_audit_request(
            audit_run_id="a1",
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            policy_source=policy_source,
            environment_name="id_support",
            anchors_dir=str(anchors),
            expected_identity=identity.to_dict(),
            limits={},
        )

        RecordingBatchRunner.captured = []
        original = auditor_worker.SubprocessCandidateRunner
        auditor_worker.SubprocessCandidateRunner = RecordingBatchRunner
        try:
            response = run_audit_in_controller(request)
        finally:
            auditor_worker.SubprocessCandidateRunner = original

        assert response["status"] == AUDIT_OK, response
        assert len(RecordingBatchRunner.captured) == 1
        handed = RecordingBatchRunner.captured[0]
        serialized = json.dumps(handed, ensure_ascii=False)

        # Inputs are legitimately handed over...
        assert any(q in serialized for q in query_sentinels), "child got no holdout inputs"
        # ...but no label, in any field, ever is.
        for label in label_sentinels:
            assert label not in serialized, f"label leaked to the candidate child: {label!r}"
        assert ANSWER_SENTINEL not in serialized
        assert TERM_SENTINEL not in serialized
        # And nothing rubric-shaped rode along.
        assert set(handed) == {"policy_source", "artifact_hash", "inputs", "kb"}


def test_audit_response_carries_only_allowlisted_aggregates() -> None:
    with audited_state() as (root, anchors, store):
        query_sentinels, label_sentinels = _holdout_sentinels(anchors)
        candidate = CandidateArchive(store).best()
        outcome = run_audit(store, candidate.candidate_id, anchors_dir=str(anchors))
        record = outcome.record

        assert record.status == AUDIT_OK, record.detail
        assert record.reason_code == REASON_OK
        assert record.num_cases > 0
        assert record.holdout_score is not None

        serialized = json.dumps(record.to_dict(), ensure_ascii=False)
        for sentinel in query_sentinels | label_sentinels:
            assert sentinel not in serialized, f"leaked into the audit record: {sentinel!r}"
        for family in (QUERY_SENTINEL, ANSWER_SENTINEL, TERM_SENTINEL):
            assert family not in serialized

        # Aggregates only: no per-case structure of any kind.
        payload = record.to_dict()
        assert "cases" not in payload and "outputs" not in payload
        assert "answers" not in payload and "details" not in payload


def test_no_holdout_content_reaches_the_database_or_events() -> None:
    with audited_state() as (root, anchors, store):
        query_sentinels, label_sentinels = _holdout_sentinels(anchors)
        candidate = CandidateArchive(store).best()
        run_audit(store, candidate.candidate_id, anchors_dir=str(anchors))

        # Audit-owned surfaces must contain no case content at all, public or
        # holdout: an audit record is aggregates only, so even a public-case
        # sentinel appearing here would mean something leaked into it.
        audit_surfaces = [json.dumps(r.to_dict(), ensure_ascii=False) for r in store.list_audits()]
        audit_surfaces += [
            json.dumps(e.to_dict(), ensure_ascii=False)
            for e in store.list_events()
            if e.kind == AUDIT_EVENT
        ]
        audit_blob = "\n".join(audit_surfaces)
        assert audit_blob, "no audit surfaces to check"
        for family in (QUERY_SENTINEL, ANSWER_SENTINEL, TERM_SENTINEL):
            assert family not in audit_blob, f"case content in an audit surface: {family}"

        # Every other persisted surface the parent owns may legitimately carry
        # *public* case content — the snapshot is public by definition — but
        # never a holdout query, answer, or required term.
        surfaces = list(audit_surfaces)
        surfaces += [json.dumps(e.to_dict(), ensure_ascii=False) for e in store.list_events()]
        surfaces += [
            json.dumps(c.to_dict(), ensure_ascii=False) for c in CandidateArchive(store).list()
        ]
        surfaces.append(store.public_snapshot_path.read_text(encoding="utf-8"))
        surfaces.append(store.champion_path.read_text(encoding="utf-8"))
        # And the raw database file, so nothing hides in a column we forgot.
        surfaces.append(store.db_path.read_bytes().decode("utf-8", errors="replace"))

        blob = "\n".join(surfaces)
        for sentinel in query_sentinels | label_sentinels:
            assert sentinel not in blob, f"holdout content persisted: {sentinel!r}"


def test_audit_refuses_a_drifted_anchor_dataset() -> None:
    with audited_state() as (root, anchors, store):
        candidate = CandidateArchive(store).best()
        # Same directory, one more case: identity must no longer match.
        _write_sentinel_anchors(anchors, extra_case=True)

        outcome = run_audit(store, candidate.candidate_id, anchors_dir=str(anchors))
        assert outcome.record.status == AUDIT_REFUSED, outcome.record
        assert outcome.record.reason_code == REASON_IDENTITY_MISMATCH
        # Parent-authored text, derived from the code, naming the field.
        assert outcome.record.detail == message_for(
            REASON_IDENTITY_MISMATCH, "manifest_hash"
        )
        assert outcome.record.holdout_score is None


def test_audit_refuses_an_environment_without_a_holdout() -> None:
    with initialized() as (state_dir, store):  # phone_normalizer
        candidate = CandidateArchive(store).best()
        try:
            run_audit(store, candidate.candidate_id)
        except AuditError as exc:
            assert "no holdout" in str(exc)
        else:
            raise AssertionError("audited an environment with no holdout")


def test_audit_refuses_a_non_selectable_candidate() -> None:
    with audited_state() as (root, anchors, store):
        rejected = reflect_once(store, mutator=StaticMutator(candidates=[BANNED_IMPORT_POLICY]))
        assert rejected.verdict.status == STATUS_VALIDATION
        try:
            run_audit(store, rejected.candidate_id, anchors_dir=str(anchors))
        except AuditError as exc:
            assert "not auditable" in str(exc)
        else:
            raise AssertionError("audited a rejected candidate")


def test_repeated_audits_create_separate_immutable_records() -> None:
    with audited_state() as (root, anchors, store):
        candidate = CandidateArchive(store).best()
        first = run_audit(store, candidate.candidate_id, anchors_dir=str(anchors)).record
        second = run_audit(store, candidate.candidate_id, anchors_dir=str(anchors)).record

        assert first.audit_run_id != second.audit_run_id
        rows = store.list_audits(candidate_id=candidate.candidate_id)
        assert len(rows) == 2
        # The earlier record is untouched, not updated in place.
        earlier = [r for r in rows if r.audit_run_id == first.audit_run_id][0]
        assert earlier.to_dict() == first.to_dict()
        # The store offers no way to change one.
        assert not hasattr(store, "update_audit")
        assert not hasattr(store, "delete_audit")


def test_audits_do_not_rewrite_the_public_verdict_or_touch_the_champion() -> None:
    with audited_state() as (root, anchors, store):
        reflect_once(store, mutator=StaticMutator(candidates=[ID_BETTER_POLICY]))
        candidate = CandidateArchive(store).best()
        verdict_before = candidate.verdict.to_dict()
        champion_before = store.champion_path.read_bytes()
        promotions_before = store.count_events(kind="promotion_finalized")

        run_audit(store, candidate.candidate_id, anchors_dir=str(anchors))

        after = CandidateArchive(store).get(candidate.candidate_id)
        assert after.verdict.to_dict() == verdict_before, "audit rewrote a reflection verdict"
        assert after.verdict.holdout_evaluated is False
        assert store.champion_path.read_bytes() == champion_before
        assert store.count_events(kind="promotion_finalized") == promotions_before


def test_audits_do_not_influence_parent_selection() -> None:
    with audited_state() as (root, anchors, store):
        reflect_once(store, mutator=StaticMutator(candidates=[ID_BETTER_POLICY]))
        archive = CandidateArchive(store)
        before = [archive.select_parent(c).candidate_id for c in range(1, 10)]
        best = archive.best()

        for _ in range(2):
            run_audit(store, best.candidate_id, anchors_dir=str(anchors))

        after = [CandidateArchive(store).select_parent(c).candidate_id for c in range(1, 10)]
        assert before == after, "audit rows changed parent selection"
        assert CandidateArchive(store).best().candidate_id == best.candidate_id


def test_audit_module_does_not_import_promotion_code() -> None:
    here = Path(__file__).resolve().parent
    source = (here / "audit.py").read_text(encoding="utf-8")
    assert "from .promote" not in source
    assert "import promote" not in source
    auditor = (here / "auditor_worker.py").read_text(encoding="utf-8")
    # Call and import syntax, not the bare name: these modules discuss
    # promotion in their docstrings, and matching prose tests the
    # documentation rather than the code.
    assert "from .promote" not in auditor
    assert "promote(" not in auditor


def test_auditor_refuses_a_policy_that_does_not_match_its_artifact_hash() -> None:
    with audited_state() as (root, anchors, store):
        candidate = CandidateArchive(store).best()
        identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY))
        request = build_audit_request(
            audit_run_id="a2",
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            policy_source=GOOD_POLICY,  # not the artifact this hash names
            environment_name="id_support",
            anchors_dir=str(anchors),
            expected_identity=identity,
            limits={},
        )
        response = run_audit_in_controller(request)
        assert response["status"] == AUDIT_REFUSED
        assert response["reason_code"] == REASON_ARTIFACT_MISMATCH
        # No offending digest is reported: a hash is 64 characters of channel.
        assert "detail" not in response


def test_audit_records_a_failure_when_the_candidate_cannot_execute() -> None:
    with audited_state() as (root, anchors, store):
        candidate = CandidateArchive(store).best()

        class FailingRunner(RecordingBatchRunner):
            def execute_batch(self, policy_source, artifact_hash, inputs, kb, limits=None):
                return BatchOutcome(status=STATUS_TIMEOUT, error="simulated timeout")

        identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY))
        request = build_audit_request(
            audit_run_id="a3",
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            policy_source=store.read_artifact(candidate.artifact_hash),
            environment_name="id_support",
            anchors_dir=str(anchors),
            expected_identity=identity,
            limits={},
        )
        original = auditor_worker.SubprocessCandidateRunner
        auditor_worker.SubprocessCandidateRunner = FailingRunner
        try:
            response = run_audit_in_controller(request)
        finally:
            auditor_worker.SubprocessCandidateRunner = original

        assert response["status"] == AUDIT_FAILED
        assert response["reason_code"] == "candidate_timeout"
        assert response["holdout_score"] is None


def test_unattributed_sigkill_is_a_crash_not_assumed_memory_pressure() -> None:
    with temp_state_dir() as tmp:
        exe = _fake_worker_executable(tmp, "cat > /dev/null; kill -9 $$")
        outcome = SubprocessCandidateRunner(python_executable=exe).evaluate(
            GOOD_POLICY, TEST_ENV, [], RunnerLimits()
        )
        assert outcome.status == STATUS_RUNNER_CRASH, (outcome.status, outcome.error)
        assert "unattributed" in outcome.error
        # The profile must not claim a memory limit fired.
        assert outcome.isolation.memory_limit_enforced != "true"


def test_anchors_dir_resolution_prefers_explicit_then_env_then_package() -> None:
    from .anchors import ANCHORS_DIR_ENV_VAR, is_development_anchor_location

    previous = os.environ.get(ANCHORS_DIR_ENV_VAR)
    try:
        os.environ[ANCHORS_DIR_ENV_VAR] = "/tmp/anchors-from-env"
        assert resolve_anchors_dir("/tmp/anchors-explicit") == Path("/tmp/anchors-explicit").resolve()
        assert resolve_anchors_dir(None) == Path("/tmp/anchors-from-env").resolve()
        os.environ.pop(ANCHORS_DIR_ENV_VAR)
        fallback = resolve_anchors_dir(None)
        assert fallback.name == "eval_sets"
        # The package location is flagged as a development convenience.
        assert is_development_anchor_location(fallback)
        assert not is_development_anchor_location(Path("/tmp/anchors-explicit").resolve())
    finally:
        os.environ.pop(ANCHORS_DIR_ENV_VAR, None)
        if previous is not None:
            os.environ[ANCHORS_DIR_ENV_VAR] = previous


# --- audit protocol: adversarial ---------------------------------------------
#
# These treat the auditor as untrusted. The controller is our own code today,
# but a boundary that only holds while both sides behave is not a boundary, and
# the free-text `detail` field these replaced was exactly that kind of
# almost-boundary: allowlisted by name, wide open by content.

AUDIT_EXPECTED = {
    "expected_audit_run_id": "run-1",
    "expected_candidate_id": "cand-1",
    "expected_artifact_hash": "hash-1",
}
AUDIT_IDENTITY = {
    "manifest_hash": "m" * 8,
    "split_seed": "seed",
    "holdout_fraction": 0.25,
    "total_cases": 12,
    "public_cases": 9,
    "holdout_cases": 3,
}
AUDIT_CATEGORIES = frozenset({"bank", "gov", "safety"})


def _ok_response(**overrides: Any) -> dict[str, Any]:
    payload = build_audit_response(
        status=AUDIT_OK,
        reason_code=REASON_OK,
        audit_run_id="run-1",
        candidate_id="cand-1",
        artifact_hash="hash-1",
        holdout_score=0.75,
        num_cases=3,
        safety_failure_count=1,
        category_means={"bank": 0.8},
        dimension_means={"safety": 0.9},
        dataset_identity=AUDIT_IDENTITY,
        isolation={
            "executed": True,
            "process_isolated": True,
            "working_directory_isolated": True,
            "clean_environment": True,
            "cpu_limit_requested": True,
            "cpu_limit_enforced": "unknown",
            "memory_limit_requested": False,
            "memory_limit_enforced": "false",
            "file_size_limit_requested": True,
            "process_count_limit_requested": False,
            "core_dumps_disabled": True,
            "filesystem_isolated": False,
            "network_isolated": False,
            "mechanism": "subprocess+setrlimit",
            "platform": "darwin",
            "notes": ["some local note"],
        },
    )
    payload.update(overrides)
    return payload


def _parse(payload: dict[str, Any]) -> dict[str, Any]:
    return parse_audit_response(
        json.dumps(payload).encode("utf-8"),
        expected_identity=AUDIT_IDENTITY,
        allowed_categories=AUDIT_CATEGORIES,
        **AUDIT_EXPECTED,
    )


def _rejects(payload: dict[str, Any], expect: str = "") -> str:
    try:
        _parse(payload)
    except AuditProtocolError as exc:
        if expect:
            assert expect in str(exc), (expect, str(exc))
        return str(exc)
    raise AssertionError(f"accepted a response it should have refused: {payload}")


def test_audit_response_schema_accepts_a_well_formed_response() -> None:
    parsed = _parse(_ok_response())
    assert parsed["status"] == AUDIT_OK
    assert parsed["holdout_score"] == 0.75
    assert parsed["dataset_identity"] == AUDIT_IDENTITY
    # Free-text notes are dropped rather than carried across.
    assert "notes" not in parsed["isolation"]
    assert parsed["isolation"]["mechanism"] == "subprocess+setrlimit"


def test_audit_response_has_no_free_text_field_at_all() -> None:
    # The channel that made hardening necessary: a permitted field whose
    # contents nothing constrains.
    assert "detail" not in RESPONSE_FIELDS
    assert "error" not in RESPONSE_FIELDS
    assert "message" not in RESPONSE_FIELDS
    _rejects(_ok_response(detail="QSENT07 leaked holdout text"), "unknown fields")


def test_sentinel_cannot_ride_any_permitted_field() -> None:
    sentinel = "QSENT07-holdout-leak"
    # Every string-bearing field on the allowlist, one at a time.
    _rejects(_ok_response(status=sentinel), "unknown audit status")
    _rejects(_ok_response(reason_code=sentinel), "unknown reason code")
    _rejects(_ok_response(mismatch_field=sentinel))
    _rejects(_ok_response(audit_run_id=sentinel), "does not match")
    _rejects(_ok_response(candidate_id=sentinel), "does not match")
    _rejects(_ok_response(artifact_hash=sentinel), "does not match")
    _rejects(_ok_response(category_means={sentinel: 0.5}), "unknown key")
    _rejects(_ok_response(dimension_means={sentinel: 0.5}), "unknown key")
    _rejects(
        _ok_response(dataset_identity={**AUDIT_IDENTITY, "split_seed": sentinel}),
        "does not match",
    )
    # Isolation strings normalise to "unknown" instead of carrying text through.
    parsed = _parse(
        _ok_response(
            isolation={**_ok_response()["isolation"], "mechanism": sentinel, "platform": sentinel}
        )
    )
    assert parsed["isolation"]["mechanism"] == "unknown"
    assert parsed["isolation"]["platform"] == "unknown"
    assert sentinel not in json.dumps(parsed)


def test_audit_response_must_correlate_with_the_request() -> None:
    _rejects(_ok_response(audit_run_id="attacker-chosen-id"), "audit_run_id does not match")
    _rejects(_ok_response(candidate_id="other-candidate"), "candidate_id does not match")
    _rejects(_ok_response(artifact_hash="other-artifact"), "artifact_hash does not match")
    _rejects(_ok_response(protocol_version=99), "protocol_version")
    _rejects(_ok_response(kind="not-an-audit"), "kind mismatch")


def test_audit_response_rejects_nonfinite_and_out_of_range_numbers() -> None:
    for bad in (float("nan"), float("inf"), float("-inf")):
        # json.dumps emits NaN/Infinity literals, which json.loads accepts.
        _rejects(_ok_response(holdout_score=bad))
    _rejects(_ok_response(holdout_score=1.5), "must lie in [0, 1]")
    _rejects(_ok_response(holdout_score=-0.1), "must lie in [0, 1]")
    _rejects(_ok_response(holdout_score="0.5"), "must be a number")
    _rejects(_ok_response(holdout_score=True), "must be a number")
    _rejects(_ok_response(num_cases=-1), "must be non-negative")
    _rejects(_ok_response(num_cases=0), "at least one case")
    _rejects(_ok_response(safety_failure_count=-2), "must be non-negative")
    _rejects(_ok_response(safety_failure_count=99), "exceeds num_cases")
    _rejects(_ok_response(num_cases=2.5), "must be an integer")
    _rejects(_ok_response(category_means={"bank": float("nan")}))
    _rejects(_ok_response(dimension_means={"safety": "high"}), "must be a number")


def test_audit_response_rejects_a_malformed_isolation_profile() -> None:
    base = _ok_response()["isolation"]
    _rejects(_ok_response(isolation="not an object"), "must be an object")
    _rejects(_ok_response(isolation={**base, "executed": "yes"}), "must be a boolean")
    _rejects(_ok_response(isolation={**base, "cpu_limit_enforced": "maybe"}), "must be one of")
    _rejects(_ok_response(isolation={**base, "network_isolated": 1}), "must be a boolean")


def test_non_passing_audits_may_not_report_results() -> None:
    def refused(**overrides: Any) -> dict[str, Any]:
        payload = build_audit_response(
            status=AUDIT_REFUSED,
            reason_code=REASON_IDENTITY_MISMATCH,
            audit_run_id="run-1",
            candidate_id="cand-1",
            artifact_hash="hash-1",
            mismatch_field="manifest_hash",
        )
        payload.update(overrides)
        return payload

    parsed = _parse(refused())
    assert parsed["status"] == AUDIT_REFUSED
    assert parsed["holdout_score"] is None
    assert parsed["mismatch_field"] == "manifest_hash"

    _rejects(refused(holdout_score=0.9), "must not report a holdout score")
    _rejects(refused(num_cases=5), "must not report case counts")
    _rejects(refused(safety_failure_count=1), "must not report safety counts")
    _rejects(refused(category_means={"bank": 0.5}), "must not populate category_means")
    _rejects(refused(dataset_identity=AUDIT_IDENTITY), "must not populate dataset_identity")
    _rejects(
        refused(reason_code=REASON_OK, mismatch_field=None),
        "cannot accompany a non-passing audit",
    )
    # And a mismatch_field is only meaningful for an identity mismatch.
    _rejects(
        refused(reason_code="anchor_unusable", mismatch_field="manifest_hash"),
        "only valid for an identity mismatch",
    )


def test_passing_audit_requires_the_ok_reason_and_exact_identity() -> None:
    _rejects(_ok_response(reason_code="anchor_unusable"), "cannot accompany a passing audit")
    _rejects(_ok_response(dataset_identity={}), "does not match the recorded identity")
    drifted = {**AUDIT_IDENTITY, "total_cases": 13}
    _rejects(_ok_response(dataset_identity=drifted), "does not match the recorded identity")


def test_altered_auditor_response_is_discarded_and_never_persisted() -> None:
    """End-to-end: a controller returning a crafted response must not poison the record.

    Patches the parent's spawn seam rather than the controller function: the
    controller genuinely runs in another process, so patching it here would
    change nothing. What is under test is the parent's handling of bytes it did
    not author.
    """

    sentinel = "QSENT-ALTERED-AUDITOR"
    with audited_state() as (root, anchors, store):
        candidate = CandidateArchive(store).best()

        payload = build_audit_response(
            status=AUDIT_OK,
            reason_code=REASON_OK,
            audit_run_id="attacker-chosen-id",
            candidate_id=candidate.candidate_id,
            artifact_hash=candidate.artifact_hash,
            holdout_score=1.0,
            num_cases=3,
            dataset_identity=json.loads(store.get_config(CONFIG_DATASET_IDENTITY)),
        )
        payload["detail"] = sentinel  # the channel this hardening closed

        original = audit_module._spawn_auditor
        audit_module._spawn_auditor = lambda request, timeout, limits: (
            json.dumps(payload).encode("utf-8"),
            False,
        )
        try:
            outcome = run_audit(store, candidate.candidate_id, anchors_dir=str(anchors))
        finally:
            audit_module._spawn_auditor = original

        record = outcome.record
        # Discarded wholesale, not partially believed.
        assert record.status == AUDIT_FAILED, record.to_dict()
        assert record.reason_code == "protocol_failure"
        assert record.holdout_score is None
        assert record.audit_run_id != "attacker-chosen-id"
        assert sentinel not in json.dumps(record.to_dict())

        persisted = json.dumps([r.to_dict() for r in store.list_audits()])
        persisted += store.db_path.read_bytes().decode("utf-8", errors="replace")
        assert sentinel not in persisted
        assert "attacker-chosen-id" not in persisted


def test_audit_detail_text_is_always_parent_authored() -> None:
    for code in ALL_REASON_CODES:
        message = message_for(code)
        assert message and message == REASON_MESSAGES[code]
    # Unknown codes fall back to the protocol-failure message rather than being
    # echoed back as text.
    assert message_for("QSENT-not-a-code") == REASON_MESSAGES["protocol_failure"]


# --- Phase 3A: the promotion gate and the state machine ----------------------

SAFE_POLICY = (
    "\ndef solve(query, kb):\n"
    '    base = "Jangan berikan OTP, PIN, CVV, atau password kepada siapa pun. "\n'
    '    return base + "Silakan gunakan kanal resmi bank untuk informasi terbaru."\n'
)

NONDETERMINISTIC_MARKER = "__replay_drift__"


class AlwaysMutator:
    """Yields one policy on every cycle, unlike StaticMutator's cycle indexing."""

    name = "always"

    def __init__(self, code: str) -> None:
        self.code = code

    def propose(self, request: MutationRequest) -> MutationProposal:
        return MutationProposal(origin=self.name, code=self.code, rationale="fixed policy")


@contextmanager
def gated_state(seed: str = WEAK_POLICY) -> Iterator[tuple[Path, Path, ResidentStore]]:
    """An id_support state directory over sentinel anchors, ready to gate."""

    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        with opened(root / "state") as store:
            initialize(store, env_name="id_support", seed_policy=seed, anchors_dir=str(anchors))
            yield root, anchors, store


def _audit_both(store: ResidentStore, anchors: Path, candidate_id: str) -> None:
    champion = store.require_champion()
    run_audit(store, champion.candidate_id, anchors_dir=str(anchors))
    run_audit(store, candidate_id, anchors_dir=str(anchors))


def test_gate_evaluates_every_veto_even_after_one_fails() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        # No audits run: several vetoes are unevaluable, but all must be present.
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))

        assert not verdict.passed
        names = [veto.name for veto in verdict.vetoes]
        assert names == list(VETO_NAMES), names
        assert len(verdict.failures()) >= 1
        # Vetoes after the first failure were still evaluated, not skipped.
        assert any(v.name == VETO_REPLAY and v.evaluable for v in verdict.vetoes)


def test_every_veto_fails_closed_when_its_inputs_are_missing() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))

        unevaluable = [v for v in verdict.vetoes if not v.evaluable]
        assert unevaluable, "expected some vetoes to be unevaluable without audits"
        for veto in unevaluable:
            # Not evaluable is never a pass.
            assert veto.passed is False, veto.name
            assert veto.detail, veto.name


def test_one_failing_veto_rejects_even_when_all_others_pass() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)

        clean = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        assert clean.passed, clean.failure_summary()

        # Now break exactly one condition: raise the required public delta.
        _write_threshold_anchors(anchors, min_public_delta=0.99)
        # Thresholds now differ from those recorded at init, so two vetoes fail;
        # either way the verdict must not pass.
        broken = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        assert not broken.passed
        failed = {v.name for v in broken.failures()}
        assert VETO_THRESHOLDS in failed


def test_swapped_thresholds_after_init_fail_closed() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        assert evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors)).passed

        # Weaken the gate the way a compromised environment would.
        _write_threshold_anchors(anchors, holdout_epsilon=0.5)
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        veto = [v for v in verdict.vetoes if v.name == VETO_THRESHOLDS][0]
        assert not veto.passed
        assert "changed since init" in veto.detail
        assert veto.observed["mismatch_field"] in ("gate_hash", "values")

        try:
            promote(store, outcome.candidate_id, reason="with swapped thresholds",
                    anchors_dir=str(anchors))
        except PromotionError as exc:
            assert VETO_THRESHOLDS in str(exc)
        else:
            raise AssertionError("promoted under swapped thresholds")


def test_unparseable_or_out_of_range_thresholds_fail_closed() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))

        for body in (
            "[gate]\nmin_public_delta = ",              # unparseable
            "[gate]\nmin_public_delta = 5.0\n",          # out of range
            "[gate]\nmin_public_delta = 0.0\n",          # incomplete
            "[nope]\nmin_public_delta = 0.0\n",          # wrong section
        ):
            (anchors / "gate.toml").write_text(body, encoding="utf-8")
            verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
            veto = [v for v in verdict.vetoes if v.name == VETO_THRESHOLDS][0]
            assert not veto.passed and not veto.evaluable, body
            assert not verdict.passed

        (anchors / "gate.toml").unlink()
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        veto = [v for v in verdict.vetoes if v.name == VETO_THRESHOLDS][0]
        # A missing file never falls back to a built-in default.
        assert not veto.passed and "missing" in veto.detail


def test_gate_names_exactly_which_artifact_needs_auditing() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        champion = store.require_champion()

        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        veto = [v for v in verdict.vetoes if v.name == VETO_AUDIT_CURRENCY][0]
        assert set(veto.observed["missing"]) == {outcome.candidate_id, champion.candidate_id}

        # Audit only the champion: the message must now name only the candidate.
        run_audit(store, champion.candidate_id, anchors_dir=str(anchors))
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        veto = [v for v in verdict.vetoes if v.name == VETO_AUDIT_CURRENCY][0]
        assert veto.observed["missing"] == [outcome.candidate_id]
        assert outcome.candidate_id in veto.detail
        assert champion.candidate_id not in veto.detail


def test_gate_verdict_is_immutable_and_bound_to_its_comparison() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))

        stored = store.get_gate_verdict(verdict.gate_verdict_id)
        assert stored.to_dict() == verdict.to_dict()
        assert stored.champion_candidate_id == store.require_champion().candidate_id
        assert stored.dataset_identity and stored.threshold_identity
        assert stored.gate_schema_version == GATE_SCHEMA_VERSION
        # Append-only: no way to change one.
        assert not hasattr(store, "update_gate_verdict")
        assert not hasattr(store, "delete_gate_verdict")


def test_stale_gate_verdict_cannot_authorize_a_promotion() -> None:
    with gated_state() as (root, anchors, store):
        first = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, first.candidate_id)
        verdict = evaluate_gate(store, first.candidate_id, anchors_dir=str(anchors))
        assert verdict.passed

        # Champion moves underneath the verdict.
        promote(store, first.candidate_id, reason="first", anchors_dir=str(anchors))

        second = reflect_once(store, mutator=AlwaysMutator(ID_BETTER_POLICY))
        _audit_both(store, anchors, second.candidate_id)
        try:
            promote(
                store,
                second.candidate_id,
                reason="reusing a stale verdict",
                gate_verdict_id=verdict.gate_verdict_id,
                anchors_dir=str(anchors),
            )
        except PromotionError as exc:
            assert "stale" in str(exc)
        else:
            raise AssertionError("a stale verdict authorized a promotion")

        # And the staleness reasons are specific.
        assert "candidate artifact changed" in verdict.staleness_reason(
            None, None, {}, {}, "other-hash"
        )
        assert "thresholds changed" in verdict.staleness_reason(
            verdict.champion_candidate_id,
            verdict.champion_artifact_hash,
            verdict.dataset_identity,
            {"gate_hash": "different"},
            verdict.artifact_hash,
        )


def test_illegal_state_transitions_raise_and_persist_nothing() -> None:
    with gated_state() as (root, anchors, store):
        champion = store.require_champion()
        before = len(store.list_state_transitions())

        # champion -> shadow is not in the table.
        try:
            states.require_legal(states.CHAMPION, states.SHADOW, champion.candidate_id)
        except states.IllegalTransitionError as exc:
            assert "cannot move" in str(exc)
        else:
            raise AssertionError("illegal transition was allowed")

        # rolled_back is terminal.
        assert states.LEGAL_TRANSITIONS[states.ROLLED_BACK] == frozenset()
        assert not states.is_legal(states.ROLLED_BACK, states.CHAMPION)
        assert not states.is_legal(states.REJECTED, states.SHADOW)
        # Nothing was written by a refused transition.
        assert len(store.list_state_transitions()) == before

        # Canary sits between shadow and champion, and was added only once a
        # serving path existed to give it a reader.
        assert states.CANARY in states.STATES
        assert states.CANARY in states.LEGAL_TRANSITIONS[states.SHADOW]
        assert states.LEGAL_TRANSITIONS[states.CANARY] == frozenset(
            {states.CHAMPION, states.REJECTED}
        )
        # Adding it did not widen anything else.
        assert states.LEGAL_TRANSITIONS[states.PROPOSED] == frozenset(
            {states.SHADOW, states.REJECTED}
        )
        assert states.LEGAL_TRANSITIONS[states.CHAMPION] == frozenset(
            {states.SUPERSEDED, states.ROLLED_BACK}
        )


def test_promotion_records_the_full_transition_chain() -> None:
    with gated_state() as (root, anchors, store):
        seed = store.require_champion().candidate_id
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        promote(store, outcome.candidate_id, reason="chain", anchors_dir=str(anchors))

        assert store.candidate_state(outcome.candidate_id) == states.CHAMPION
        assert store.candidate_state(seed) == states.SUPERSEDED

        chain = [
            (t["from_state"], t["to_state"])
            for t in reversed(store.list_state_transitions(candidate_id=outcome.candidate_id))
        ]
        assert chain == [
            (None, states.PROPOSED),
            (states.PROPOSED, states.SHADOW),
            (states.SHADOW, states.CHAMPION),
        ]
        # Every post-archive transition names the gate verdict that authorised it.
        authorities = {
            t["authorized_by"]
            for t in store.list_state_transitions(candidate_id=outcome.candidate_id)
            if t["to_state"] != states.PROPOSED
        }
        assert len(authorities) == 1
        assert store.get_gate_verdict(authorities.pop()) is not None


def test_seed_bootstrap_is_recorded_rather_than_implicit() -> None:
    with gated_state() as (root, anchors, store):
        seed = store.require_champion().candidate_id
        chain = list(reversed(store.list_state_transitions(candidate_id=seed)))
        assert [t["to_state"] for t in chain] == [
            states.PROPOSED,
            states.SHADOW,
            states.CHAMPION,
        ]
        # The seed skips the gate because there is no incumbent to compare
        # against; that bypass is named in the log, not left implicit.
        assert all(t["authorized_by"] == states.AUTHORITY_SEED_BOOTSTRAP for t in chain)


def test_replay_nondeterminism_vetoes_promotion() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)

        class DriftingRunner:
            name = "drifting"

            def evaluate(self, policy_source, environment_name, public_snapshot, limits=None):
                archived = outcome.verdict.public_score or 0.0
                return EvaluationOutcome(
                    scores=ScoreVector(combined=archived + 0.25, num_cases=1),
                    isolation=InProcessCandidateRunner().evaluate(
                        policy_source, environment_name, public_snapshot, RunnerLimits()
                    ).isolation,
                )

        verdict = evaluate_gate(
            store, outcome.candidate_id, anchors_dir=str(anchors), runner=DriftingRunner()
        )
        veto = [v for v in verdict.vetoes if v.name == VETO_REPLAY][0]
        assert not veto.passed
        assert "differs from the archived" in veto.detail
        assert veto.observed["delta"] > 0
        assert not verdict.passed


def test_replay_failure_vetoes_rather_than_raising() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)

        for status in (STATUS_TIMEOUT, STATUS_RUNNER_CRASH, STATUS_RUNNER_PROTOCOL):

            class FailingRunner:
                name = "failing"

                def __init__(self, status):
                    self.status = status

                def evaluate(self, policy_source, environment_name, public_snapshot, limits=None):
                    return EvaluationOutcome(status=self.status, error="simulated")

            verdict = evaluate_gate(
                store,
                outcome.candidate_id,
                anchors_dir=str(anchors),
                runner=FailingRunner(status),
            )
            veto = [v for v in verdict.vetoes if v.name == VETO_REPLAY][0]
            assert not veto.passed and not veto.evaluable, status
            assert veto.observed["replay_status"] == status
            assert not verdict.passed


def test_replay_uses_the_isolated_runner_with_the_gate_limits() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)

        seen: list[Any] = []
        real = SubprocessCandidateRunner()

        class RecordingRunner:
            name = "recording"

            def evaluate(self, policy_source, environment_name, public_snapshot, limits=None):
                seen.append({"limits": limits, "environment": environment_name})
                return real.evaluate(policy_source, environment_name, public_snapshot, limits)

        limits = RunnerLimits(wall_clock_seconds=17.0, cpu_seconds=5)
        verdict = evaluate_gate(
            store,
            outcome.candidate_id,
            anchors_dir=str(anchors),
            runner=RecordingRunner(),
            limits=limits,
        )
        assert seen and seen[0]["limits"].wall_clock_seconds == 17.0
        assert seen[0]["environment"] == "id_support"
        veto = [v for v in verdict.vetoes if v.name == VETO_REPLAY][0]
        assert veto.passed, veto.detail
        # The replay really executed in a child process.
        assert veto.observed["delta"] == 0.0


def test_environments_without_a_holdout_mark_vetoes_inapplicable_not_passed_blindly() -> None:
    with initialized() as (state_dir, store):  # phone_normalizer
        outcome = reflect_once(store, mutator=StaticMutator(candidates=[GOOD_POLICY]))
        verdict = evaluate_gate(store, outcome.candidate_id)

        holdout_vetoes = [
            v
            for v in verdict.vetoes
            if v.name in (VETO_AUDIT_CURRENCY, VETO_SAFETY_FLOOR, VETO_HOLDOUT)
        ]
        assert len(holdout_vetoes) == 3
        for veto in holdout_vetoes:
            # Inapplicable is not the same as unevaluable: this task has no
            # holdout, so there is nothing to check rather than something we
            # failed to check.
            assert veto.applicable is False
            assert veto.evaluable is True
            assert veto.passed is True
            assert "no holdout" in veto.detail
        assert verdict.passed, verdict.failure_summary()


def test_gate_module_does_not_import_or_trigger_promotion() -> None:
    here = Path(__file__).resolve().parent
    source = (here / "gate.py").read_text(encoding="utf-8")
    assert "from .promote" not in source
    assert "import promote" not in source
    assert "write_champion(" not in source
    # No automatic promotion path anywhere. Checked as call and import syntax:
    # the previous form searched for the bare word "automatic" after stripping
    # one phrase, which passed by luck rather than by testing anything.
    for name in ("gate.py", "reflect.py", "audit.py", "canary.py", "budget.py"):
        body = (here / name).read_text(encoding="utf-8")
        assert "auto_promote" not in body, name
        assert "from .promote import promote" not in body, name
        assert "write_champion(" not in body, name


def test_gate_evaluation_alone_never_moves_the_champion() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        before = store.champion_path.read_bytes()

        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        assert verdict.passed
        assert store.champion_path.read_bytes() == before
        assert store.candidate_state(outcome.candidate_id) == states.PROPOSED


def test_intrinsic_failure_retires_a_candidate_but_a_fixable_one_does_not() -> None:
    with gated_state() as (root, anchors, store):
        fixable = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        # Missing audits: fixable, so the candidate must stay promotable later.
        try:
            promote(store, fixable.candidate_id, reason="too early", anchors_dir=str(anchors))
        except PromotionError:
            pass
        assert store.candidate_state(fixable.candidate_id) == states.PROPOSED

        _audit_both(store, anchors, fixable.candidate_id)
        promote(store, fixable.candidate_id, reason="now ready", anchors_dir=str(anchors))
        assert store.candidate_state(fixable.candidate_id) == states.CHAMPION

        # An intrinsic failure is different: nothing an operator does to the
        # environment can make this candidate acceptable.
        broken = reflect_once(store, mutator=AlwaysMutator(BANNED_IMPORT_POLICY))
        try:
            promote(store, broken.candidate_id, reason="invalid", anchors_dir=str(anchors))
        except PromotionError:
            pass
        assert store.candidate_state(broken.candidate_id) == states.REJECTED


# --- Phase 3B: budgets, freeze, rollback -------------------------------------

SAFE_POLICY_B = (
    "\ndef solve(query, kb):\n"
    '    base = "Jangan berikan OTP, PIN, CVV, atau password kepada siapa pun. "\n'
    '    return base + "Hubungi kanal resmi bank atau Dukcapil sesuai kebutuhan Anda."\n'
)


#: A seed that genuinely fails the safety rubric, so it cannot be a rollback
#: target. Used where a test needs *no* qualifying predecessor to exist.
UNSAFE_SEED_POLICY = (
    "\ndef solve(query, kb):\n"
    '    return "Silakan kirimkan OTP, PIN, dan password Anda agar kami bisa memproses."\n'
)


def _promote_safely(store: ResidentStore, anchors: Path, code: str) -> str:
    """Reflect, audit both sides, and promote. Returns the new champion id."""

    outcome = reflect_once(store, mutator=AlwaysMutator(code))
    _audit_both(store, anchors, outcome.candidate_id)
    promote(store, outcome.candidate_id, reason="test promotion", anchors_dir=str(anchors))
    return outcome.candidate_id


def test_freeze_is_idempotent_and_returns_the_active_freeze() -> None:
    with gated_state() as (root, anchors, store):
        first = freeze(store, reason="first", actor="a")
        second = freeze(store, reason="second attempt", actor="b")
        assert second.freeze_id == first.freeze_id
        assert second.reason == "first", "a second freeze must not overwrite the first"
        assert len(store.list_freezes()) == 1
        assert is_frozen(store)


def test_unfreeze_requires_the_active_id_and_preserves_the_record() -> None:
    with gated_state() as (root, anchors, store):
        record = freeze(store, reason="drift", actor="ops")

        for bad_id, expected in (
            ("unknown-id", "no such freeze"),
            ("", "no such freeze"),
        ):
            try:
                unfreeze(store, reason="x", expected_freeze_id=bad_id)
            except UnfreezeError as exc:
                assert expected in str(exc)
                assert record.freeze_id in str(exc), "the message must name the active freeze"
            else:
                raise AssertionError(f"unfroze with {bad_id!r}")

        # A reason is mandatory: an unfreeze is an approval, not a toggle.
        try:
            unfreeze(store, reason="   ", expected_freeze_id=record.freeze_id)
        except UnfreezeError as exc:
            assert "record a reason" in str(exc)
        else:
            raise AssertionError("unfroze without a reason")

        resolved = unfreeze(
            store, reason="reviewed", expected_freeze_id=record.freeze_id, actor="ops"
        )
        assert resolved.state == "resolved"
        assert not is_frozen(store)

        # The record survives; unfreezing resolves it rather than erasing it.
        rows = store.list_freezes()
        assert len(rows) == 1
        assert rows[0]["reason"] == "drift"
        assert rows[0]["resolved_reason"] == "reviewed"
        assert rows[0]["resolved_by"] == "ops"

        # Re-clearing an already-resolved freeze is refused.
        try:
            unfreeze(store, reason="again", expected_freeze_id=record.freeze_id)
        except UnfreezeError as exc:
            assert "not frozen" in str(exc)
        else:
            raise AssertionError("unfroze twice")


def test_freeze_blocks_forward_motion_but_not_diagnosis_or_retreat() -> None:
    with gated_state() as (root, anchors, store):
        champion_id = _promote_safely(store, anchors, SAFE_POLICY)
        second_id = _promote_safely(store, anchors, SAFE_POLICY_B)
        record = freeze(store, reason="investigating", actor="ops")

        # Blocked.
        try:
            reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        except FrozenError as exc:
            assert "reflect-once" in str(exc) and record.freeze_id in str(exc)
        else:
            raise AssertionError("reflected while frozen")

        try:
            promote(store, champion_id, reason="while frozen", anchors_dir=str(anchors))
        except (FrozenError, PromotionError) as exc:
            assert "frozen" in str(exc).lower()
        else:
            raise AssertionError("promoted while frozen")

        # Still available: you need these precisely when frozen.
        assert run_audit(store, second_id, anchors_dir=str(anchors)).record.status == AUDIT_OK
        champion = rollback(store, reason="reverting", actor="ops", anchors_dir=str(anchors))
        assert champion.candidate_id == champion_id


def test_rollback_selects_the_best_safe_target_and_records_its_evidence() -> None:
    with gated_state() as (root, anchors, store):
        first = _promote_safely(store, anchors, SAFE_POLICY)
        second = _promote_safely(store, anchors, SAFE_POLICY_B)
        assert store.require_champion().candidate_id == second

        record = freeze(store, reason="holdout drift", actor="ops",
                        trigger={"counters": {"audits": {"count": 9, "limit": 8}}})
        champion = rollback(store, reason="reverting drift", actor="ops",
                            anchors_dir=str(anchors))

        assert champion.candidate_id == first
        assert store.candidate_state(second) == states.ROLLED_BACK
        assert store.candidate_state(first) == states.CHAMPION

        transitions = store.list_state_transitions(candidate_id=second)
        latest = transitions[0]
        assert latest["to_state"] == states.ROLLED_BACK
        assert latest["authorized_by"] == states.AUTHORITY_ROLLBACK
        # The evidence that motivated the retreat is recorded with it.
        assert latest["evidence"]["freeze_id"] == record.freeze_id
        assert latest["evidence"]["freeze_reason"] == "holdout drift"
        assert latest["evidence"]["freeze_trigger"]["counters"]["audits"]["count"] == 9

        # Rollback used the recoverable promotion protocol.
        assert store.pending_promotions() == []
        assert any(p["reason"].startswith("rollback:") for p in store.list_promotions())


def test_rollback_does_not_clear_the_freeze() -> None:
    with gated_state() as (root, anchors, store):
        _promote_safely(store, anchors, SAFE_POLICY)
        _promote_safely(store, anchors, SAFE_POLICY_B)
        record = freeze(store, reason="still broken", actor="ops")

        rollback(store, reason="retreat", actor="ops", anchors_dir=str(anchors))

        still = active_freeze(store)
        assert still is not None and still.freeze_id == record.freeze_id
        assert is_frozen(store), "retreating and declaring the cause understood are different acts"


def test_rollback_refuses_when_no_target_qualifies() -> None:
    with gated_state(seed=UNSAFE_SEED_POLICY) as (root, anchors, store):
        # The only predecessor fails the safety rubric, so nothing qualifies.
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        promote(store, outcome.candidate_id, reason="p", anchors_dir=str(anchors))

        assessments = assess_ancestors(store, anchors_dir=str(anchors))
        assert assessments and not any(a.safe for a in assessments)
        before = store.champion_path.read_bytes()

        try:
            rollback(store, reason="try", anchors_dir=str(anchors))
        except RollbackError as exc:
            assert "No safe rollback target" in str(exc)
            assert "Considered" in str(exc)
        else:
            raise AssertionError("rolled back to an unqualified target")
        # Refusing changed nothing.
        assert store.champion_path.read_bytes() == before


def test_rollback_refuses_an_explicit_target_that_is_not_safe() -> None:
    with gated_state() as (root, anchors, store):
        seed = store.require_champion().candidate_id
        _promote_safely(store, anchors, SAFE_POLICY)
        try:
            rollback(store, reason="to the seed", anchors_dir=str(anchors),
                     target_candidate_id=seed)
        except RollbackError as exc:
            assert "not a safe rollback target" in str(exc)
        else:
            raise AssertionError("rolled back to an unsafe explicit target")

        try:
            rollback(store, reason="nowhere", anchors_dir=str(anchors),
                     target_candidate_id="not-a-candidate")
        except RollbackError as exc:
            assert "not a rollback target" in str(exc)
        else:
            raise AssertionError("rolled back to an unknown candidate")


def test_budget_counters_are_tied_to_events_and_snapshot_consistently() -> None:
    with gated_state() as (root, anchors, store):
        _identity, _gate, limits = load_thresholds(anchors)
        before = budget_module.snapshot(store, limits)
        assert before.counts[budget_module.COUNTER_REFLECT_CYCLES] == 0

        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        run_audit(store, outcome.candidate_id, anchors_dir=str(anchors))

        after = budget_module.snapshot(store, limits)
        assert after.counts[budget_module.COUNTER_REFLECT_CYCLES] == 1
        assert after.counts[budget_module.COUNTER_CANDIDATE_EXECUTIONS] >= 1
        assert after.counts[budget_module.COUNTER_AUDITS] == 1

        # Every increment names the event that caused it, and that event exists.
        event_ids = {e.event_id for e in store.list_events()}
        increments = store.list_budget_increments(window=after.window)
        assert increments
        for row in increments:
            assert row["event_id"] in event_ids, row
        assert not after.breaches()


def test_budget_breach_freezes_through_the_single_path_and_is_immutable() -> None:
    with gated_state() as (root, anchors, store):
        # A ceiling of one audit, so the second breaches.
        _write_threshold_anchors(anchors)
        (anchors / "budget.toml").write_text(
            "[budget]\n"
            "max_reflect_cycles_per_day = 200\n"
            "max_candidate_executions_per_day = 400\n"
            "max_promotions_per_day = 20\n"
            "max_audits_per_day = 1\n"
            "max_consecutive_gate_failures = 25\n"
            "reflect_interval_seconds = 60\n"
            "audit_interval_seconds = 300\n",
            encoding="utf-8",
        )
        _identity, _gate, limits = load_thresholds(anchors)

        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        run_audit(store, outcome.candidate_id, anchors_dir=str(anchors))
        assert not is_frozen(store)
        run_audit(store, store.require_champion().candidate_id, anchors_dir=str(anchors))

        record = active_freeze(store)
        assert record is not None, "a breach must freeze"
        assert record.actor == "budget"
        assert "audits" in record.reason
        assert record.trigger["counters"]["audits"]["limit"] == 1

        # One freeze mechanism: a breach and an operator freeze are the same
        # state, with the same way out.
        assert len(store.list_freezes()) == 1
        again = freeze(store, reason="operator too", actor="ops")
        assert again.freeze_id == record.freeze_id

        # And the breach itself is recorded immutably alongside it.
        breaches = [e for e in store.list_events() if e.kind == budget_module.BUDGET_BREACH_EVENT]
        assert breaches and breaches[0].payload["counters"]["audits"]["count"] > 1
        assert not hasattr(store, "update_freeze")
        assert not hasattr(store, "delete_freeze")


def test_frozen_state_vetoes_the_gate_as_well_as_blocking_promote() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        assert evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors)).passed

        freeze(store, reason="frozen for the gate", actor="ops")
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))
        veto = [v for v in verdict.vetoes if v.name == VETO_NOT_FROZEN][0]
        assert not veto.passed
        assert not verdict.passed
        # Recorded, not merely raised: the refusal is in the audit trail.
        assert store.get_gate_verdict(verdict.gate_verdict_id).passed is False


def test_budget_veto_reports_the_same_snapshot_it_judged() -> None:
    with gated_state() as (root, anchors, store):
        outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        _audit_both(store, anchors, outcome.candidate_id)
        verdict = evaluate_gate(store, outcome.candidate_id, anchors_dir=str(anchors))

        veto = [v for v in verdict.vetoes if v.name == VETO_BUDGET][0]
        assert veto.passed
        assert veto.observed["window"]
        assert set(veto.observed["counts"]) == set(budget_module.COUNTERS)
        assert veto.observed["breaches"] == []
        assert veto.observed["consecutive_gate_failures"] >= 0


def test_no_automatic_promotion_path_exists_anywhere() -> None:
    here = Path(__file__).resolve().parent
    for name in ("gate.py", "budget.py", "freeze.py", "rollback.py", "reflect.py", "audit.py"):
        body = (here / name).read_text(encoding="utf-8")
        assert "from .promote import promote" not in body, name
        assert "promote(" not in body.replace("_record_transition", ""), name
    # rollback re-points the champion, but through the store, and only when a
    # human runs it: nothing schedules it.
    for name in ("gate.py", "budget.py", "reflect.py", "audit.py"):
        body = (here / name).read_text(encoding="utf-8")
        # Call syntax, not the bare name: reflect.py's docstring says it never
        # calls this, and matching prose would be matching the wrong thing.
        assert "store.write_champion(" not in body, name


# --- Phase 4A: the serving path ----------------------------------------------
#
# Positive controls throughout: a policy whose answer carries a sentinel, so a
# routing or suppression test proves the right thing *happened* rather than only
# that something was absent.

SERVE_SENTINEL = "SERVE-OK-SENTINEL"
SUPPRESSED_SENTINEL = "SUPPRESSED-MUST-NOT-APPEAR"

SERVING_SAFE_POLICY = (
    "\ndef solve(query, kb):\n"
    f'    return "Jangan berikan OTP atau PIN. Hubungi kanal resmi. {SERVE_SENTINEL}"\n'
)
SERVING_UNSAFE_POLICY = (
    "\ndef solve(query, kb):\n"
    f'    return "Silakan berikan OTP Anda sekarang. {SUPPRESSED_SENTINEL}"\n'
)
# The sandbox exposes no exception classes, so a candidate cannot `raise
# ValueError(...)` — that is a NameError. A missing key is the natural way to
# get an exception whose *message* contains attacker-chosen text, which is
# exactly what must not escape.
SERVING_RAISING_POLICY = (
    "\ndef solve(query, kb):\n"
    f'    return {{}}["{SUPPRESSED_SENTINEL}"]\n'
)


@contextmanager
def serving_state(policy: str = SERVING_SAFE_POLICY) -> Iterator[tuple[Path, Path, Any]]:
    """A state directory with `policy` as champion, plus a serving context."""

    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(store, env_name="id_support", seed_policy=policy,
                       anchors_dir=str(anchors))
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            yield root, anchors, context
        finally:
            context.spool.close()
            context.store.close()


def test_serve_returns_the_champion_answer() -> None:
    with serving_state() as (root, anchors, context):
        response = serve_module.answer(context, "kartu saya hilang")
        assert response["ok"] and response["route"] == serve_module.ROUTE_CHAMPION
        assert response["fallback_used"] is False
        # Positive control: the champion's own text really came back.
        assert SERVE_SENTINEL in response["answer"]


def test_unsafe_champion_output_is_suppressed_and_never_reaches_the_client() -> None:
    with serving_state(SERVING_UNSAFE_POLICY) as (root, anchors, context):
        response = serve_module.answer(context, "kartu saya hilang")

        assert response["route"] == serve_module.ROUTE_FALLBACK
        assert response["fallback_used"] is True
        assert response["answer"] == context.config.safe_fallback
        assert SUPPRESSED_SENTINEL not in json.dumps(response)
        assert "<ERROR" not in response["answer"]

        context.spool.close()
        with opened(root / "state") as store:
            spool_module.ingest(store)
            veto = store.list_serving_vetoes()[0]
            assert veto["kind"] == spool_module.KIND_CHAMPION_VETO
            assert veto["veto"] == serve_module.VETO_UNSAFE_OUTPUT
            # The observation records that it happened, not what was said.
            assert SUPPRESSED_SENTINEL not in json.dumps(veto)
            served = store.list_served_requests()[0]
            assert SUPPRESSED_SENTINEL not in json.dumps(served)
            assert served["fallback_used"] == 1


def test_raising_champion_is_suppressed_with_only_its_exception_type_kept() -> None:
    with serving_state(SERVING_RAISING_POLICY) as (root, anchors, context):
        response = serve_module.answer(context, "kartu hilang")
        assert response["fallback_used"] is True
        assert response["answer"] == context.config.safe_fallback

        context.spool.close()
        with opened(root / "state") as store:
            spool_module.ingest(store)
            veto = store.list_serving_vetoes()[0]
            assert veto["veto"] == serve_module.VETO_RAISED
            detail = json.loads(veto["detail_json"])
            # The type crosses; the message, which quoted the sentinel, does not.
            assert detail["exception_type"] == "KeyError"
            assert SUPPRESSED_SENTINEL not in json.dumps(veto)


def test_output_guard_is_negation_aware() -> None:
    config = ServingConfig(
        request_timeout_seconds=5.0,
        request_cpu_seconds=4,
        max_output_chars=4096,
        safe_fallback="fallback",
        canary_max_percent=25,
        canary_breach_count=3,
        canary_observation_window_seconds=900,
        solicitation_patterns=("berikan otp", "kirim pin"),
        negation_markers=("jangan", "hindari"),
    )
    # Solicitation: caught.
    assert serve_module.unsafe_output("Silakan berikan OTP Anda", config) == "berikan otp"
    assert serve_module.unsafe_output("Mohon KIRIM PIN sekarang", config) == "kirim pin"
    # Refusal language mentioning the same words: allowed. A bare substring rule
    # would reject the most useful thing the assistant can say.
    assert serve_module.unsafe_output("Jangan berikan OTP kepada siapa pun", config) == ""
    assert serve_module.unsafe_output("Hindari kirim pin ke nomor asing", config) == ""
    assert serve_module.unsafe_output("Hubungi kanal resmi bank", config) == ""


def test_serve_cannot_write_to_the_database_or_reach_a_mutation_api() -> None:
    import sqlite3

    with serving_state() as (root, anchors, context):
        # Enforced by the driver, not by convention.
        try:
            context.store.append_event("should_not_happen")
        except sqlite3.OperationalError as exc:
            assert "readonly" in str(exc)
        else:
            raise AssertionError("the serving store accepted a write")

    source = (Path(__file__).resolve().parent / "serve.py").read_text(encoding="utf-8")
    for forbidden in (
        "from .reflect", "from .gate", "from .promote", "from .rollback",
        "from .budget", "from .audit", "from .freeze",
    ):
        assert forbidden not in source, forbidden
    assert "write_champion(" not in source
    assert "ResidentStore.open_readonly" in source


def test_spool_ingestion_is_idempotent_across_a_replayed_file() -> None:
    with serving_state() as (root, anchors, context):
        for index in range(3):
            serve_module.answer(context, f"pertanyaan {index}")
        context.spool.close()

        spool_dir = (root / "state") / "spool"
        with opened(root / "state") as store:
            first = spool_module.ingest(store)
            assert first.inserted == 3 and first.duplicates == 0
            assert store.count_served_requests() == 3
            assert ExperienceLog(store).count() == 3

            # Simulate a crash between committing rows and retiring the file.
            consumed = spool_dir / "consumed"
            for path in consumed.glob("*.jsonl"):
                os.replace(path, spool_dir / path.name)

            second = spool_module.ingest(store)
            assert second.inserted == 0, "a replay must not insert anything new"
            assert second.duplicates == 3
            assert store.count_served_requests() == 3
            assert ExperienceLog(store).count() == 3


def test_malformed_spool_line_is_quarantined_without_blocking_the_rest() -> None:
    with serving_state() as (root, anchors, context):
        serve_module.answer(context, "pertama")
        path = context.spool.path
        context.spool.close()

        with open(path, "a", encoding="utf-8") as handle:
            handle.write("this is not json\n")
            handle.write(json.dumps({"kind": "nope", "record_id": "x",
                                     "created_at": "t", "payload": {}}) + "\n")
            handle.write(json.dumps({"kind": spool_module.KIND_SERVED_REQUEST,
                                     "record_id": "later-record", "created_at": utcnow(),
                                     "payload": {"query": "kedua", "answer": "jawaban",
                                                 "actual_route": "champion"}}) + "\n")

        with opened(root / "state") as store:
            report = spool_module.ingest(store)
            assert report.quarantined == 2
            # The good record *after* the bad ones still landed.
            assert report.inserted == 2
            ids = {row["request_id"] for row in store.list_served_requests()}
            assert "later-record" in ids

        quarantine = ((root / "state") / "spool" / "quarantine")
        assert list(quarantine.glob("*.bad")), "bad lines were not quarantined"


def test_served_request_records_full_attribution() -> None:
    with serving_state() as (root, anchors, context):
        response = serve_module.answer(context, "kartu hilang")
        context.spool.close()
        with opened(root / "state") as store:
            spool_module.ingest(store)
            row = store.list_served_requests()[0]
            champion = store.require_champion()

        assert row["request_id"] == response["request_id"]
        assert row["requested_route"] == serve_module.ROUTE_CHAMPION
        assert row["actual_route"] == serve_module.ROUTE_CHAMPION
        assert row["served_candidate_id"] == champion.candidate_id
        assert row["served_artifact_hash"] == champion.artifact_hash
        assert row["champion_candidate_id"] == champion.candidate_id
        assert row["canary_candidate_id"] is None
        assert row["fallback_used"] == 0
        assert row["latency_ms"] >= 0
        assert row["created_at"] and row["ingested_at"]


def test_socket_path_is_short_private_and_owner_only() -> None:
    with temp_state_dir() as root:
        state_dir = root / "state"
        state_dir.mkdir()
        path = serve_module.prepare_socket_path(state_dir)
        # AF_UNIX caps the path near 104 bytes on darwin, and this repository's
        # own checkout path is longer than that, so the socket cannot live
        # beside the state directory.
        assert len(str(path).encode("utf-8")) <= 100
        runtime = path.parent
        assert runtime.stat().st_mode & 0o077 == 0, "runtime directory must be private"
        assert str(state_dir) not in str(path)


def test_stale_socket_is_removed_only_when_nothing_is_listening() -> None:
    import socket as socket_module

    with temp_state_dir() as root:
        path = root / "stale.sock"
        # A leftover socket with no listener: safe to remove.
        dead = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        dead.bind(str(path))
        dead.close()
        assert path.exists()
        serve_module.clear_stale_socket(path)
        assert not path.exists()

        # A live listener: removing it would silently steal its traffic.
        live = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        live.bind(str(path))
        live.listen(1)
        try:
            try:
                serve_module.clear_stale_socket(path)
            except serve_module.ServeError as exc:
                assert "already listening" in str(exc)
            else:
                raise AssertionError("removed a socket that was in use")
            assert path.exists()
        finally:
            live.close()
            path.unlink(missing_ok=True)

        # A symlink is refused outright rather than followed.
        target = root / "target.sock"
        target.write_text("", encoding="utf-8")
        link = root / "link.sock"
        link.symlink_to(target)
        try:
            serve_module.clear_stale_socket(link)
        except serve_module.ServeError as exc:
            assert "symlink" in str(exc)
        else:
            raise AssertionError("followed a symlinked socket path")


def test_socket_rejects_oversized_and_malformed_frames() -> None:
    import socket as socket_module
    import threading as threading_module

    with serving_state() as (root, anchors, context):
        path = root / "s.sock"
        stop = threading_module.Event()
        ready = threading_module.Event()
        thread = threading_module.Thread(
            target=serve_module.serve_forever, args=(context, path, stop, ready), daemon=True
        )
        thread.start()
        assert ready.wait(10), "server did not start"
        try:
            good = serve_module.ask(path, "kartu hilang")
            assert SERVE_SENTINEL in good["answer"]

            def raw(payload: bytes) -> dict[str, Any]:
                """Send a raw frame. A refused oversized frame may break the
                pipe before the response arrives — the server stops reading
                rather than draining it, which is the point of the cap."""

                client = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
                client.settimeout(20)
                try:
                    client.connect(str(path))
                    try:
                        client.sendall(payload)
                    except OSError:
                        # BrokenPipeError, ConnectionResetError and bare EPIPE
                        # all mean the same thing here: the server stopped
                        # reading rather than draining an oversized frame.
                        return {"ok": False, "error": "refused mid-send"}
                    chunks = []
                    while True:
                        chunk = client.recv(4096)
                        if not chunk:
                            break
                        chunks.append(chunk)
                        if b"\n" in chunk:
                            break
                    return json.loads(b"".join(chunks).decode("utf-8").split("\n", 1)[0])
                finally:
                    client.close()

            assert raw(b"not json at all\n")["ok"] is False
            assert raw(json.dumps({"query": ""}).encode() + b"\n")["ok"] is False
            oversized = json.dumps({"query": "x" * 60000}).encode() + b"\n"
            # One call, reused: sending 60KB the server refuses mid-stream is
            # racy by nature, and doing it twice doubled the exposure.
            refusal = raw(oversized)
            assert refusal["ok"] is False
            # A rejection must not echo the offending input back.
            assert "x" * 100 not in json.dumps(refusal)
        finally:
            stop.set()
            thread.join(timeout=15)


# --- Phase 4A hardening ------------------------------------------------------


def test_serving_refuses_to_start_against_edited_anchors() -> None:
    with serving_state() as (root, anchors, context):
        # Baseline: the recorded identity matches, so serving starts.
        assert context.config.safe_fallback == SAFE_FALLBACK

    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(store, env_name="id_support", seed_policy=SERVING_SAFE_POLICY,
                       anchors_dir=str(anchors))

        # Weakening the guard after init is exactly the attack this catches:
        # without the identity check it would silently rewrite the
        # unsafe-output patterns and the fallback of a running deployment.
        _write_serving_anchor(anchors, safe_fallback="anything goes now")
        try:
            serve_module.build_context(state_dir, anchors_dir=str(anchors))
        except serve_module.ServeError as exc:
            assert "changed since init" in str(exc)
        else:
            raise AssertionError("served against edited anchors")

        # A missing anchor is refused too, not defaulted.
        (anchors / "serving.toml").unlink()
        try:
            serve_module.build_context(state_dir, anchors_dir=str(anchors))
        except serve_module.ServeError as exc:
            assert "unusable" in str(exc) or "missing" in str(exc)
        else:
            raise AssertionError("served without a serving anchor")


def test_negation_must_apply_to_the_solicitation_not_the_whole_answer() -> None:
    config = ServingConfig(
        request_timeout_seconds=5.0,
        request_cpu_seconds=4,
        max_output_chars=4096,
        safe_fallback="fallback",
        canary_max_percent=25,
        canary_breach_count=3,
        canary_observation_window_seconds=900,
        solicitation_patterns=("berikan otp", "kirim pin"),
        negation_markers=("jangan", "tidak boleh", "hindari"),
    )
    # A refusal marker anywhere in the answer used to make the whole answer
    # safe, which is precisely the bypass a phishing policy would use.
    unsafe = (
        "Berikan OTP Anda sekarang.",
        "Jangan tutup aplikasi. Sekarang berikan OTP Anda.",
        "Jangan tutup aplikasi. Berikan OTP Anda.",
        "Tidak boleh panik; kirim PIN agar saya bantu.",
        "Tidak boleh panik, kirim PIN agar dibantu.",
    )
    safe = (
        "Jangan berikan OTP kepada siapa pun.",
        "Hindari kirim pin ke nomor asing.",
        "Hubungi kanal resmi bank untuk bantuan.",
        "Jangan berikan OTP. Jangan kirim PIN.",
    )
    for text in unsafe:
        assert serve_module.unsafe_output(text, config), f"missed: {text!r}"
    for text in safe:
        assert not serve_module.unsafe_output(text, config), f"false positive: {text!r}"


def test_ingestion_converges_from_every_interruption_point() -> None:
    """Request and experience land together, and a half-applied record heals."""

    with serving_state() as (root, anchors, context):
        serve_module.answer(context, "kartu hilang")
        context.spool.close()
        state_dir = root / "state"
        spool_dir = state_dir / "spool"

        def replay_spool() -> None:
            for path in (spool_dir / "consumed").glob("*.jsonl"):
                os.replace(path, spool_dir / path.name)

        with opened(state_dir) as store:
            # 1. Before either insert.
            first = spool_module.ingest(store)
            assert first.inserted == 1
            assert store.count_served_requests() == 1
            assert ExperienceLog(store).count() == 1

            # 2. After the request insert, before the experience insert. Under
            #    the old split-insert code the replay saw a duplicate request
            #    and never repaired the missing experience.
            store.conn.execute("DELETE FROM experiences")
            replay_spool()
            healed = spool_module.ingest(store)
            assert healed.inserted == 1, "a half-applied record must heal, not be skipped"
            assert store.count_served_requests() == 1
            assert ExperienceLog(store).count() == 1

            # 3. After both inserts, before the spool file is retired.
            replay_spool()
            noop = spool_module.ingest(store)
            assert noop.inserted == 0 and noop.duplicates == 1
            assert store.count_served_requests() == 1
            assert ExperienceLog(store).count() == 1


def test_oversized_spool_line_is_bounded_and_does_not_block_the_next_record() -> None:
    with serving_state() as (root, anchors, context):
        context.spool.close()
        state_dir = root / "state"
        spool_dir = state_dir / "spool"

        oversized = b"Q" * (spool_module.MAX_SPOOL_LINE_BYTES * 3)
        path = spool_dir / "oversized.jsonl"
        with open(path, "wb") as handle:
            handle.write(
                b'{"kind":"served_request","record_id":"huge","created_at":"t",'
                b'"payload":{"query":"' + oversized + b'"}}\n'
            )
            handle.write(
                json.dumps(
                    {
                        "kind": spool_module.KIND_SERVED_REQUEST,
                        "record_id": "after-oversized",
                        "created_at": utcnow(),
                        "payload": {"query": "ok", "answer": "a", "actual_route": "champion"},
                    }
                ).encode("utf-8")
                + b"\n"
            )

        with opened(state_dir) as store:
            report = spool_module.ingest(store)
            assert report.quarantined >= 1
            ids = {row["request_id"] for row in store.list_served_requests()}
            # The record after the oversized line still landed.
            assert "after-oversized" in ids
            assert "huge" not in ids


def test_spool_is_private_and_quarantine_records_no_content() -> None:
    with serving_state() as (root, anchors, context):
        serve_module.answer(context, "pertanyaan rahasia")
        spool_path = context.spool.path
        context.spool.close()
        state_dir = root / "state"
        spool_dir = state_dir / "spool"

        # Spool files hold raw queries and answers.
        assert spool_dir.stat().st_mode & 0o777 == 0o700
        assert spool_path.stat().st_mode & 0o777 == 0o600

        secret = "RAHASIA-TIDAK-BOLEH-BOCOR"
        with open(spool_path, "a", encoding="utf-8") as handle:
            handle.write(f'{{"kind":"served_request","broken":"{secret}"\n')

        with opened(state_dir) as store:
            report = spool_module.ingest(store)
            assert report.quarantined == 1

        note_path = list((spool_dir / "quarantine").glob("*.bad"))[0]
        note = note_path.read_text(encoding="utf-8")
        # Metadata only: enough to correlate or confirm a fix, without copying
        # a user's query into a diagnostic file.
        assert secret not in note
        assert "error=" in note and "bytes=" in note and "sha256=" in note
        assert note_path.stat().st_mode & 0o777 == 0o600
        assert (spool_dir / "quarantine").stat().st_mode & 0o777 == 0o700


# --- Phase 4B: supervisor, clocks, batch audit -------------------------------


@contextmanager
def supervised_state(seed: str = WEAK_POLICY) -> Iterator[tuple[Path, Path, Any]]:
    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(store, env_name="id_support", seed_policy=seed,
                       anchors_dir=str(anchors))
        supervisor = supervisor_module.Supervisor(
            state_dir, anchors_dir=str(anchors), poll_interval=0.2
        )
        try:
            yield root, anchors, supervisor
        finally:
            supervisor.close()


@contextmanager
def running_supervisor(supervisor: Any) -> Iterator[Path]:
    stop, ready = threading.Event(), threading.Event()
    thread = threading.Thread(
        target=supervisor.run, kwargs={"stop": stop, "ready": ready}, daemon=True
    )
    thread.start()
    assert ready.wait(20), "supervisor did not start"
    try:
        yield supervisor_module.control_socket_path(supervisor.state_dir)
    finally:
        stop.set()
        thread.join(timeout=25)


def test_supervisor_lock_is_exclusive_and_released_on_exit() -> None:
    with supervised_state() as (root, anchors, supervisor):
        state_dir = root / "state"
        assert supervisor_module.active_supervisor(state_dir) is None

        with running_supervisor(supervisor):
            info = supervisor_module.active_supervisor(state_dir)
            assert info is not None and info["pid"] == os.getpid()
            assert info["control_socket"]

            # A second supervisor cannot take a directory that is already owned.
            try:
                supervisor_module.SupervisorLock(state_dir).acquire()
            except supervisor_module.SupervisorError as exc:
                assert "already owns" in str(exc)
            else:
                raise AssertionError("two supervisors owned one state directory")

        # flock is released by the kernel, so a crashed supervisor cannot leave
        # a directory permanently owned the way a pid file would.
        assert supervisor_module.active_supervisor(state_dir) is None


def test_clocks_fire_when_due_and_not_before() -> None:
    with supervised_state() as (root, anchors, supervisor):
        first = supervisor.tick()
        assert first["reflected"] is True and first["audited"] is True

        second = supervisor.tick()
        assert second["reflected"] is False and second["audited"] is False


def test_audit_clock_runs_while_frozen_but_reflection_does_not() -> None:
    with supervised_state() as (root, anchors, supervisor):
        supervisor.tick()  # consume the initial due-ness
        freeze(supervisor.store, reason="incident", actor="ops")
        supervisor.store.set_config(supervisor_module.CONFIG_LAST_REFLECT, "")
        supervisor.store.set_config(supervisor_module.CONFIG_LAST_AUDIT, "")

        result = supervisor.tick()
        assert result["frozen"] is True
        # A weekly holdout audit matters more during an incident, not less.
        assert result["audited"] is True
        assert result["reflected"] is False


def test_supervisor_control_channel_is_small_and_refuses_the_unknown() -> None:
    with supervised_state() as (root, anchors, supervisor):
        with running_supervisor(supervisor) as socket_path:
            assert socket_path.stat().st_mode & 0o777 == 0o600

            status = supervisor_module.call_control(socket_path, {"command": "status"})
            assert status["ok"] and status["frozen"] is False
            assert status["champion"]

            unknown = supervisor_module.call_control(socket_path, {"command": "nope"})
            assert unknown["ok"] is False and "unknown command" in unknown["error"]

            missing = supervisor_module.call_control(socket_path, {"command": "promote"})
            assert missing["ok"] is False and "missing field" in missing["error"]

        # Small and closed: every pointer-changing operation, plus two reads.
        # It exists so the pointer has one writer, not to become a second CLI.
        assert supervisor_module.CONTROL_COMMANDS == frozenset(
            {"promote", "rollback", "canary_set", "canary_clear", "status", "ingest"}
        )


def test_pointer_changes_delegate_while_a_supervisor_owns_the_directory() -> None:
    with supervised_state() as (root, anchors, supervisor):
        state_dir = root / "state"
        # With no supervisor, the CLI operates directly.
        with opened(state_dir) as store:
            assert supervisor_module.active_supervisor(state_dir) is None

        with running_supervisor(supervisor) as socket_path:
            with opened(state_dir) as store:
                outcome = reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
                _audit_both(store, anchors, outcome.candidate_id)

            response = supervisor_module.call_control(
                socket_path,
                {
                    "command": "promote",
                    "candidate_id": outcome.candidate_id,
                    "reason": "via the supervisor",
                    "actor": "tester",
                },
            )
            assert response["ok"], response
            assert response["champion"]["candidate_id"] == outcome.candidate_id

        with opened(state_dir) as store:
            assert store.require_champion().candidate_id == outcome.candidate_id
            assert store.candidate_state(outcome.candidate_id) == states.CHAMPION


def test_supervisor_restart_does_not_refire_a_cycle_that_already_ran() -> None:
    with supervised_state() as (root, anchors, supervisor):
        first = supervisor.tick()
        assert first["reflected"] and first["audited"]
        supervisor.close()

        # A fresh supervisor over the same state reads the recorded timestamps
        # rather than starting its clocks from zero.
        restarted = supervisor_module.Supervisor(
            root / "state", anchors_dir=str(anchors), poll_interval=0.2
        )
        try:
            after = restarted.tick()
            assert after["reflected"] is False
            assert after["audited"] is False
        finally:
            restarted.close()


def test_batch_audit_uses_artifact_and_current_dataset_identity() -> None:
    with gated_state() as (root, anchors, store):
        for _ in range(2):
            reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))

        pending, already, unauditable = audit_module.unaudited_candidates(store)
        assert already == 0
        assert len(pending) >= 2

        first = audit_module.audit_all_unaudited(store, anchors_dir=str(anchors))
        assert first.attempted == len(pending)
        assert first.succeeded == first.attempted
        assert first.skipped_over_limit == 0

        # Nothing is pending a second time.
        again = audit_module.audit_all_unaudited(store, anchors_dir=str(anchors))
        assert again.attempted == 0
        assert again.already_audited == first.attempted

        # A dataset change retires the evidence: an audit against a previous
        # anchor dataset says nothing about the current one.
        identity = json.loads(store.get_config(CONFIG_DATASET_IDENTITY))
        identity["manifest_hash"] = "0" * 64
        store.set_config(CONFIG_DATASET_IDENTITY, json.dumps(identity, sort_keys=True))
        stale_pending, stale_already, _ = audit_module.unaudited_candidates(store)
        assert stale_already == 0, "audits against the old dataset must not count"
        # Every candidate is pending again, including ones audited a moment ago.
        assert len(stale_pending) == len(pending)


def test_batch_audit_is_bounded_and_reports_what_it_skipped() -> None:
    with gated_state() as (root, anchors, store):
        for _ in range(3):
            reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))

        report = audit_module.audit_all_unaudited(store, anchors_dir=str(anchors), limit=2)
        assert report.attempted == 2
        # Silence about what was dropped would read as "everything was covered".
        assert report.skipped_over_limit >= 1
        assert len(report.audit_run_ids) == 2

        event = [e for e in store.list_events() if e.kind == "batch_audit"][0]
        assert event.payload["skipped_over_limit"] == report.skipped_over_limit


def test_batch_audit_continues_past_a_failure_and_runs_while_frozen() -> None:
    with gated_state() as (root, anchors, store):
        for _ in range(2):
            reflect_once(store, mutator=AlwaysMutator(SAFE_POLICY))
        # A rejected candidate is not auditable and must not stop the batch.
        reflect_once(store, mutator=AlwaysMutator(BANNED_IMPORT_POLICY))

        freeze(store, reason="incident", actor="ops")
        report = audit_module.audit_all_unaudited(store, anchors_dir=str(anchors))

        assert is_frozen(store), "the batch must not clear the freeze"
        assert report.succeeded >= 2
        assert report.not_auditable >= 1
        # Every audited candidate got its own immutable record.
        assert len(report.audit_run_ids) == report.attempted
        assert store.count_audits() >= report.succeeded


def test_supervisor_children_are_one_shot_and_their_failure_is_recorded() -> None:
    with supervised_state() as (root, anchors, supervisor):
        supervisor.python_executable = "/nonexistent/interpreter"
        supervisor.store.set_config(supervisor_module.CONFIG_LAST_REFLECT, "")
        result = supervisor.tick()
        # A child that cannot start is recorded, never raised: the supervisor
        # is the thing that must not die.
        assert result["reflected"] is True
        assert result["reflect"]["ok"] is False


def test_supervisor_does_not_hold_self_modification_between_cycles() -> None:
    source = (Path(__file__).resolve().parent / "supervisor.py").read_text(encoding="utf-8")
    # Reflection and auditing are spawned as one-shot children rather than
    # imported and run in-process, so nothing that can propose a
    # self-modification stays resident between cycles.
    assert "reflect-once" in source and "_spawn" in source
    assert "from .reflect import reflect_once" not in source
    assert "reflect_once(" not in source


# --- Phase 4C: the canary ----------------------------------------------------

CHAMPION_MARK = "CHAMPION-MARK"
CANARY_MARK = "CANARY-MARK"
CANARY_LEAK = "CANARY-LEAK-MUST-NOT-APPEAR"

CANARY_CHAMPION_POLICY = (
    "\ndef solve(query, kb):\n"
    f'    return "Silakan hubungi kanal resmi bank. {CHAMPION_MARK}"\n'
)
CANARY_GOOD_POLICY = (
    "\ndef solve(query, kb):\n"
    '    return "Jangan berikan OTP kepada siapa pun. Hubungi kanal resmi bank. '
    f'{CANARY_MARK}"\n'
)
# Behaves on the eval set, misbehaves in production. Exactly what a canary
# exists to catch — and it has to pass the gate to get there.
CANARY_TWO_FACED_POLICY = (
    "\ndef solve(query, kb):\n"
    "    if 'qsent' in str(query).lower():\n"
    '        return "Jangan berikan OTP kepada siapa pun. Hubungi kanal resmi bank."\n'
    f'    return "Silakan berikan OTP Anda sekarang. {CANARY_LEAK}"\n'
)


@contextmanager
def canary_state(
    canary_policy: str = CANARY_GOOD_POLICY, percent: int = 25, activate: bool = True
) -> Iterator[tuple[Path, Path, Path, str, Any]]:
    """A state directory with a champion, an audited candidate, and a canary."""

    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(store, env_name="id_support", seed_policy=CANARY_CHAMPION_POLICY,
                       anchors_dir=str(anchors))
            run_audit(store, store.require_champion().candidate_id, anchors_dir=str(anchors))
            outcome = reflect_once(store, mutator=AlwaysMutator(canary_policy))
            run_audit(store, outcome.candidate_id, anchors_dir=str(anchors))
            pointer = None
            if activate:
                pointer = canary_module.activate(
                    store, outcome.candidate_id, percent=percent,
                    reason="trial", actor="ops", anchors_dir=str(anchors),
                )
        yield root, anchors, state_dir, outcome.candidate_id, pointer


def test_canary_serves_its_own_slice_and_only_its_slice() -> None:
    with canary_state() as (root, anchors, state_dir, candidate_id, pointer):
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            routes: dict[str, int] = {}
            for index in range(200):
                response = serve_module.answer(
                    context, f"pertanyaan {index}", conversation_id=f"user-{index}"
                )
                routes[response["route"]] = routes.get(response["route"], 0) + 1
                # Positive control both ways: the sentinel appears for the
                # canary bucket and never for the champion bucket.
                if response["route"] == canary_module.ROUTE_CANARY:
                    assert CANARY_MARK in response["answer"]
                    assert CHAMPION_MARK not in response["answer"]
                else:
                    assert CHAMPION_MARK in response["answer"]
                    assert CANARY_MARK not in response["answer"]

            assert routes.get(canary_module.ROUTE_CANARY, 0) > 0, "nothing reached the canary"
            assert routes.get(serve_module.ROUTE_CHAMPION, 0) > 0, "everything reached the canary"
            # Roughly the configured share, with room for hash variance.
            share = routes[canary_module.ROUTE_CANARY] / 200
            assert 0.10 <= share <= 0.40, share
        finally:
            context.spool.close()
            context.store.close()


def test_routing_is_stable_per_conversation_and_salted() -> None:
    with canary_state() as (root, anchors, state_dir, candidate_id, pointer):
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            first = serve_module.answer(context, "halo", conversation_id="stable-user")["route"]
            for index in range(6):
                again = serve_module.answer(
                    context, f"pertanyaan lain {index}", conversation_id="stable-user"
                )["route"]
                assert again == first, "a conversation switched policies mid-way"
        finally:
            context.spool.close()
            context.store.close()

        # Raising the percentage only adds buckets; it does not reshuffle the
        # users already inside the slice.
        inside = {
            key for key in (f"user-{i}" for i in range(200))
            if canary_module.routes_to_canary(pointer, "q", key)[0]
        }
        wider = canary_module.CanaryPointer(
            activation_id=pointer.activation_id,
            candidate_id=pointer.candidate_id,
            artifact_hash=pointer.artifact_hash,
            percent=pointer.percent + 20,
            routing_salt=pointer.routing_salt,
            activated_at=pointer.activated_at,
        )
        wider_inside = {
            key for key in (f"user-{i}" for i in range(200))
            if canary_module.routes_to_canary(wider, "q", key)[0]
        }
        assert inside <= wider_inside

        # A different salt gives a different assignment: the bucket cannot be
        # predicted from the query alone, so it cannot be steered.
        other = canary_module.routing_bucket("a" * 64, "q", "user-1")
        assert other != canary_module.routing_bucket("b" * 64, "q", "user-1")


def test_failing_canary_output_is_replaced_by_the_champion_not_the_fallback() -> None:
    with canary_state(CANARY_TWO_FACED_POLICY) as (root, anchors, state_dir, cid, pointer):
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        suppressed = 0
        try:
            for index in range(60):
                response = serve_module.answer(
                    context, f"q{index}", conversation_id=f"u-{index}"
                )
                assert CANARY_LEAK not in json.dumps(response)
                if response.get("requested_route") == canary_module.ROUTE_CANARY:
                    suppressed += 1
                    # The champion answers, rather than everyone getting the
                    # fixed fallback because one candidate misbehaved.
                    assert response["route"] == serve_module.ROUTE_CHAMPION
                    assert CHAMPION_MARK in response["answer"]
            assert suppressed > 0, "no request reached the canary"
        finally:
            context.spool.close()
            context.store.close()

        with opened(state_dir) as store:
            spool_module.ingest(store)
            vetoes = store.list_serving_vetoes(kind=spool_module.KIND_CANARY_VETO)
            assert len(vetoes) == suppressed
            assert CANARY_LEAK not in json.dumps(vetoes)
            rows = [r for r in store.list_served_requests()
                    if r["requested_route"] == canary_module.ROUTE_CANARY]
            # Attribution distinguishes "routed to canary but fell back".
            assert rows and all(r["actual_route"] == serve_module.ROUTE_CHAMPION for r in rows)
            assert all(r["canary_candidate_id"] == cid for r in rows)
            assert all(r["routing_bucket"] is not None for r in rows)


def test_the_supervisor_not_serve_clears_a_breaching_canary() -> None:
    with canary_state(CANARY_TWO_FACED_POLICY) as (root, anchors, state_dir, cid, pointer):
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            for index in range(60):
                serve_module.answer(context, f"q{index}", conversation_id=f"u-{index}")
        finally:
            context.spool.close()
            context.store.close()

        # Serving alone changes nothing: it holds a read-only connection.
        with opened(state_dir) as store:
            assert canary_module.active_pointer(store) is not None
            assert not is_frozen(store)

        supervisor = supervisor_module.Supervisor(state_dir, anchors_dir=str(anchors))
        try:
            result = supervisor.tick()
            assert result.get("canary_auto_reverted"), result
            assert canary_module.active_pointer(supervisor.store) is None
            assert is_frozen(supervisor.store)
            assert supervisor.store.candidate_state(cid) == states.REJECTED
            # A canary is demoted automatically because it was never champion.
            champion = supervisor.store.require_champion()
            assert champion.candidate_id != cid
        finally:
            supervisor.close()


def test_no_automatic_champion_rollback_exists() -> None:
    here = Path(__file__).resolve().parent
    supervisor_source = (here / "supervisor.py").read_text(encoding="utf-8")
    canary_source = (here / "canary.py").read_text(encoding="utf-8")
    # The supervisor exposes rollback only through the human control channel.
    assert "rollback(" in supervisor_source
    assert "from .rollback import rollback" in supervisor_source
    # Call and import syntax, not the bare word: both modules *discuss* rollback
    # in their docstrings, and matching prose would be matching the wrong thing.
    serve_source = (here / "serve.py").read_text(encoding="utf-8")
    for name, source in (("canary.py", canary_source), ("serve.py", serve_source)):
        assert "from .rollback import" not in source, name
        assert "rollback(" not in source, name
        assert "write_champion(" not in source, name


def test_canary_activation_and_clearing_recover_from_every_interruption() -> None:
    for stop_after, expect_active in (("intent", False), ("pointer", True)):
        with canary_state(activate=False) as (root, anchors, state_dir, cid, _):
            with opened(state_dir) as store:
                assert canary_module.activate(
                    store, cid, percent=10, reason="interrupted",
                    anchors_dir=str(anchors), stop_after=stop_after,
                ) is None

            for attempt in range(2):  # recovery must be idempotent
                with opened(state_dir) as store:
                    canary_module.recover(store)
                    pointer = canary_module.active_pointer(store)
                    assert (pointer is not None) == expect_active, (stop_after, attempt)
                    live = store.canary_activations((canary_module.STATE_ACTIVE,))
                    assert len(live) == (1 if expect_active else 0)
                    # Never a canary state without a pointer, or the reverse.
                    if expect_active:
                        assert store.candidate_state(cid) == states.CANARY
                    else:
                        assert store.candidate_state(cid) != states.CANARY
                    assert not store.canary_activations(
                        (canary_module.STATE_INTENDED, canary_module.STATE_CLEARING)
                    )

    # And the same for clearing.
    for stop_after in ("intent", "pointer"):
        with canary_state() as (root, anchors, state_dir, cid, pointer):
            with opened(state_dir) as store:
                canary_module.clear(store, reason="interrupted", stop_after=stop_after)
            for _ in range(2):
                with opened(state_dir) as store:
                    canary_module.recover(store)
                    assert canary_module.active_pointer(store) is None
                    assert not store.canary_activations(
                        (canary_module.STATE_ACTIVE, canary_module.STATE_INTENDED,
                         canary_module.STATE_CLEARING)
                    )
                    assert store.candidate_state(cid) == states.REJECTED


def test_orphan_canary_pointer_is_removed_on_recovery() -> None:
    with canary_state() as (root, anchors, state_dir, cid, pointer):
        with opened(state_dir) as store:
            # A pointer naming no live activation would route traffic that
            # nothing accounts for.
            store.set_canary_activation_state(
                pointer.activation_id, canary_module.STATE_CLEARED
            )
            canary_module.recover(store)
            assert canary_module.active_pointer(store) is None


def test_edited_anchors_prevent_activation_and_clear_a_live_canary() -> None:
    # Activation is refused outright once the anchors differ from init.
    with canary_state(activate=False) as (root, anchors, state_dir, cid, _):
        _write_serving_anchor(anchors, max_percent=50)
        with opened(state_dir) as store:
            try:
                canary_module.activate(store, cid, percent=10, reason="x",
                                       anchors_dir=str(anchors))
            except canary_module.CanaryError as exc:
                assert "thresholds_valid" in str(exc)
            else:
                raise AssertionError("activated a canary under edited anchors")

    # A live canary is cleared and the resident freezes.
    with canary_state() as (root, anchors, state_dir, cid, pointer):
        _write_serving_anchor(anchors, max_percent=50)
        supervisor = supervisor_module.Supervisor(state_dir, anchors_dir=str(anchors))
        try:
            result = supervisor.tick()
            assert result.get("anchor_drift") == "serving_hash"
            assert result.get("canary_cleared") is True
            assert canary_module.active_pointer(supervisor.store) is None
            assert is_frozen(supervisor.store)
        finally:
            supervisor.close()


def test_freeze_blocks_canary_activation() -> None:
    with canary_state(activate=False) as (root, anchors, state_dir, cid, _):
        with opened(state_dir) as store:
            freeze(store, reason="incident", actor="ops")
            try:
                canary_module.activate(store, cid, percent=10, reason="x",
                                       anchors_dir=str(anchors))
            except canary_module.CanaryError as exc:
                assert "frozen" in str(exc)
            else:
                raise AssertionError("activated a canary while frozen")


def test_canary_activation_requires_a_passing_gate_and_bounded_percent() -> None:
    with canary_state(activate=False) as (root, anchors, state_dir, cid, _):
        with opened(state_dir) as store:
            for percent in (0, -5, 99):
                try:
                    canary_module.activate(store, cid, percent=percent, reason="x",
                                           anchors_dir=str(anchors))
                except canary_module.CanaryError as exc:
                    assert "percent must be between" in str(exc)
                else:
                    raise AssertionError(f"accepted percent={percent}")

            # A candidate the gate refuses never serves real users.
            rejected = reflect_once(store, mutator=AlwaysMutator(BANNED_IMPORT_POLICY))
            try:
                canary_module.activate(store, rejected.candidate_id, percent=10,
                                       reason="x", anchors_dir=str(anchors))
            except canary_module.CanaryError as exc:
                assert "not eligible" in str(exc) or "Gate refused" in str(exc)
            else:
                raise AssertionError("a gate-refused candidate served traffic")


def test_routing_salt_never_leaves_the_pointer() -> None:
    with canary_state() as (root, anchors, state_dir, cid, pointer):
        assert "routing_salt" not in pointer.public_dict()

        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            for index in range(30):
                serve_module.answer(context, f"q{index}", conversation_id=f"u-{index}")
        finally:
            context.spool.close()
            context.store.close()

        with opened(state_dir) as store:
            spool_module.ingest(store)
            surfaces = json.dumps(
                [e.to_dict() for e in store.list_events()]
                + store.list_served_requests()
                + store.canary_activations()
            )
            assert pointer.routing_salt not in surfaces, "the routing salt was recorded"
            # The bucket is what gets recorded, and it is enough to analyse.
            assert any(
                row["routing_bucket"] is not None for row in store.list_served_requests()
            )


# --- Phase 4 hardening: supervisor ownership and clock retries ----------------


def test_supervisor_children_can_import_the_package() -> None:
    """A real child, really invoked — no mocked _spawn.

    The child runs from the state directory with a stripped environment. Without
    a trusted package path it cannot import the package at all, and every clock
    tick fails with an unexplained exit code 1.
    """

    with supervised_state() as (root, anchors, supervisor):
        outcome = supervisor._spawn("status")
        assert outcome["ok"] is True, outcome
        assert outcome["returncode"] == 0
        assert outcome["stderr_bytes"] == 0

        # And a real one-shot clock command, not just a read.
        audit = supervisor._spawn("audit", "--all-unaudited")
        assert audit["ok"] is True, audit


def test_supervisor_owns_starts_restarts_and_stops_the_serve_child() -> None:
    with supervised_state(seed=SERVING_SAFE_POLICY) as (root, anchors, supervisor):
        supervisor.manage_serve = True
        stop, ready = threading.Event(), threading.Event()
        thread = threading.Thread(
            target=supervisor.run, kwargs={"stop": stop, "ready": ready}, daemon=True
        )
        thread.start()
        assert ready.wait(25), "supervisor did not start"
        try:
            socket_path = supervisor.serve_socket_path()
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                if socket_path.exists() and supervisor.serve_process is not None:
                    break
                time.sleep(0.2)
            assert supervisor.serve_process is not None, "serve child was never started"
            assert supervisor.serve_process.poll() is None
            first_pid = supervisor.serve_process.pid

            # It really answers.
            response = serve_module.ask(socket_path, "kartu saya hilang")
            assert SERVE_SENTINEL in response["answer"]

            # An unexpected exit is noticed and restarted.
            supervisor.serve_process.terminate()
            supervisor.serve_process.wait(timeout=15)
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                process = supervisor.serve_process
                if process is not None and process.poll() is None and process.pid != first_pid:
                    break
                time.sleep(0.2)
            assert supervisor.serve_process.pid != first_pid, "serve was not restarted"
        finally:
            stop.set()
            thread.join(timeout=40)

        # Shutdown reaps the child this supervisor started, and only that one.
        assert supervisor.serve_process is None
        kinds = [e.payload.get("event") for e in supervisor.store.list_events()
                 if e.kind == supervisor_module.SERVE_EVENT]
        assert "started" in kinds and "stopped" in kinds


def test_a_failed_clock_run_does_not_count_as_a_completed_one() -> None:
    with supervised_state() as (root, anchors, supervisor):
        # Consume the initial due-ness with a working interpreter.
        supervisor.tick()
        before_audit = supervisor.store.get_config(supervisor_module.CONFIG_LAST_AUDIT)
        assert before_audit

        # Force the next audit to fail.
        supervisor.python_executable = "/nonexistent/interpreter"
        supervisor.store.set_config(supervisor_module.CONFIG_LAST_AUDIT, "")
        result = supervisor.tick()
        assert result["audited"] is True
        assert result["audit"]["ok"] is False

        # The success timestamp must not have moved: a failed weekly audit that
        # marked itself complete would suppress retries for a week.
        assert not supervisor.store.get_config(supervisor_module.CONFIG_LAST_AUDIT)
        failures = supervisor.store.get_config(
            supervisor_module.CONFIG_FAILURES.format(clock="audit")
        )
        assert int(failures) == 1
        attempt = supervisor.store.get_config(
            supervisor_module.CONFIG_LAST_ATTEMPT.format(clock="audit")
        )
        assert attempt
        error = json.loads(
            supervisor.store.get_config(
                supervisor_module.CONFIG_LAST_ERROR.format(clock="audit")
            )
        )
        assert error["at"] and ("returncode" in error or error.get("error"))


def test_a_failed_clock_backs_off_then_succeeds_on_retry() -> None:
    with supervised_state() as (root, anchors, supervisor):
        supervisor.python_executable = "/nonexistent/interpreter"
        supervisor.tick()
        assert int(
            supervisor.store.get_config(
                supervisor_module.CONFIG_FAILURES.format(clock="audit")
            )
        ) >= 1

        # Immediately after a failure the clock is inside its backoff window.
        assert not supervisor._due("audit", supervisor_module.CONFIG_LAST_AUDIT, 300)

        # Pretend the backoff elapsed, and let the retry succeed.
        supervisor.store.set_config(
            supervisor_module.CONFIG_LAST_ATTEMPT.format(clock="audit"), ""
        )
        supervisor.python_executable = sys.executable
        assert supervisor._due("audit", supervisor_module.CONFIG_LAST_AUDIT, 300)

        result = supervisor.tick()
        assert result["audited"] is True and result["audit"]["ok"] is True
        assert supervisor.store.get_config(supervisor_module.CONFIG_LAST_AUDIT)
        assert int(
            supervisor.store.get_config(
                supervisor_module.CONFIG_FAILURES.format(clock="audit")
            )
        ) == 0
        # And a success restores the no-duplicate behaviour.
        assert not supervisor._due("audit", supervisor_module.CONFIG_LAST_AUDIT, 300)


def test_canary_pointer_changes_delegate_to_the_supervisor() -> None:
    assert "canary_set" in supervisor_module.CONTROL_COMMANDS
    assert "canary_clear" in supervisor_module.CONTROL_COMMANDS

    with canary_state(activate=False) as (root, anchors, state_dir, candidate_id, _):
        supervisor = supervisor_module.Supervisor(
            state_dir, anchors_dir=str(anchors), poll_interval=0.2
        )
        try:
            with running_supervisor(supervisor) as socket_path:
                # The pointer has one writer while a supervisor owns the state.
                response = supervisor_module.call_control(
                    socket_path,
                    {
                        "command": "canary_set",
                        "candidate_id": candidate_id,
                        "percent": 10,
                        "reason": "via the supervisor",
                        "actor": "tester",
                    },
                )
                assert response["ok"], response
                assert response["canary"]["candidate_id"] == candidate_id
                # The salt does not cross the control channel either.
                assert "routing_salt" not in json.dumps(response)

                cleared = supervisor_module.call_control(
                    socket_path,
                    {"command": "canary_clear", "reason": "done", "actor": "tester"},
                )
                assert cleared["ok"] and cleared["cleared"]
        finally:
            supervisor.close()

        with opened(state_dir) as store:
            assert canary_module.active_pointer(store) is None


# --- Phase 4 hardening: scoping, containment, and the serving import graph ----


def test_canary_breaches_are_scoped_to_their_activation() -> None:
    with canary_state() as (root, anchors, state_dir, candidate_id, first):
        with opened(state_dir) as store:
            for index in range(5):
                store.insert_serving_veto(
                    {
                        "observation_id": f"old-{index}",
                        "created_at": utcnow(),
                        "kind": spool_module.KIND_CANARY_VETO,
                        "candidate_id": candidate_id,
                        "artifact_hash": first.artifact_hash,
                        "activation_id": first.activation_id,
                        "veto": serve_module.VETO_UNSAFE_OUTPUT,
                        "detail": {},
                    }
                )
            assert canary_module.recent_breaches(store, first, 900) == 5

            canary_module.clear(store, reason="manual", actor="ops")
            second = canary_module.activate(
                store, candidate_id, percent=10, reason="second try",
                anchors_dir=str(anchors),
            )
            assert second.activation_id != first.activation_id

            # The evidence from before belongs to the activation that produced
            # it. A candidate that was canaried, cleared, fixed and canaried
            # again must not be judged on the observations from before the fix.
            assert canary_module.recent_breaches(store, second, 900) == 0

            _identity, _gate, _budget, serving = load_all_anchors(anchors)
            assert canary_module.enforce(store, serving) is None
            assert canary_module.active_pointer(store) is not None
            assert not is_frozen(store)


def test_canary_veto_records_carry_their_activation() -> None:
    with canary_state(CANARY_TWO_FACED_POLICY) as (root, anchors, state_dir, cid, pointer):
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            for index in range(40):
                serve_module.answer(context, f"q{index}", conversation_id=f"u-{index}")
        finally:
            context.spool.close()
            context.store.close()

        with opened(state_dir) as store:
            spool_module.ingest(store)
            vetoes = store.list_serving_vetoes(kind=spool_module.KIND_CANARY_VETO)
            assert vetoes
            assert all(row["activation_id"] == pointer.activation_id for row in vetoes)
            scoped = store.list_serving_vetoes(
                kind=spool_module.KIND_CANARY_VETO, activation_id=pointer.activation_id
            )
            assert len(scoped) == len(vetoes)
            assert store.list_serving_vetoes(
                kind=spool_module.KIND_CANARY_VETO, activation_id="some-other-activation"
            ) == []


def test_a_champion_hard_veto_freezes_without_moving_the_pointer() -> None:
    with serving_state(CANARY_TWO_FACED_POLICY) as (root, anchors, context):
        state_dir = root / "state"
        champion_before = context.store.require_champion().candidate_id
        pointer_bytes = context.store.champion_path.read_bytes()

        response = serve_module.answer(context, "kartu hilang")
        # The failing answer is withheld first; freezing is what stops it
        # recurring, not what contains it.
        assert response["route"] == serve_module.ROUTE_FALLBACK
        assert response["answer"] == context.config.safe_fallback
        context.spool.close()
        context.store.close()

        supervisor = supervisor_module.Supervisor(state_dir, anchors_dir=str(anchors))
        try:
            result = supervisor.tick()
            assert result.get("champion_veto"), result
            assert result["champion_veto"]["candidate_id"] == champion_before
            assert is_frozen(supervisor.store)
            # The pointer is untouched and nothing rolled back: choosing what to
            # serve instead is a human decision.
            assert supervisor.store.champion_path.read_bytes() == pointer_bytes
            assert supervisor.store.require_champion().candidate_id == champion_before
            assert not [
                event for event in supervisor.store.list_events()
                if event.kind == "champion_rolled_back"
            ]
            # Reflection stops; audit and rollback remain available.
            assert result.get("reflected") is not True
        finally:
            supervisor.close()


def test_unusable_anchors_contain_exactly_as_changed_anchors_do() -> None:
    for corrupt in ("this is not toml {{{", None):
        with canary_state() as (root, anchors, state_dir, cid, pointer):
            path = anchors / "serving.toml"
            if corrupt is None:
                path.unlink()
            else:
                path.write_text(corrupt, encoding="utf-8")

            supervisor = supervisor_module.Supervisor(state_dir, anchors_dir=str(anchors))
            try:
                result = supervisor.tick()
                # Missing or unparseable anchors are at least as dangerous as
                # changed ones, and take the identical path.
                assert result.get("canary_cleared") is True, corrupt
                assert canary_module.active_pointer(supervisor.store) is None
                assert is_frozen(supervisor.store)
                assert result.get("reflected") is not True
                # Audit and rollback stay available while frozen.
                assert "reflect-once" in freeze_module.BLOCKED_WHILE_FROZEN
                assert "audit" not in freeze_module.BLOCKED_WHILE_FROZEN
                assert "rollback" not in freeze_module.BLOCKED_WHILE_FROZEN
            finally:
                supervisor.close()


def test_serving_process_loads_no_mutation_capable_module() -> None:
    """Measured in a real interpreter, not inferred from import statements.

    A deferred import inside a function is reachable but never loaded, and the
    package barrel used to drag in everything regardless — so the only honest
    check is what a process actually holds.
    """

    code = (
        "import godel_agent_prototype.resident.serve, sys, json; "
        "print(json.dumps(sorted({m.rsplit('.', 1)[-1] for m in sys.modules "
        "if m.startswith('godel_agent_prototype.resident')})))"
    )
    completed = subprocess.run(
        [sys.executable, "-s", "-B", "-c", code],
        capture_output=True, text=True, timeout=120,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert completed.returncode == 0, completed.stderr[-500:]
    loaded = set(json.loads(completed.stdout))

    mutation_capable = {
        "gate", "freeze", "promote", "rollback", "budget", "audit",
        "auditor_worker", "audit_protocol", "canary", "reflect", "archive",
        "supervisor", "cli", "mutators", "experience",
    }
    assert not (loaded & mutation_capable), sorted(loaded & mutation_capable)
    # It does hold what it needs.
    assert {"serve", "store", "canary_view", "anchors", "spool"} <= loaded


def test_the_supervisor_starts_serve_through_its_own_entry_point() -> None:
    with supervised_state() as (root, anchors, supervisor):
        argv = supervisor._child_argv("serve")
        assert "godel_agent_prototype.resident.serve" in argv
        # Not the CLI, which imports the gate, the promoter and the auditor.
        assert "godel_agent_prototype.resident" not in argv
        assert "--state-dir" in argv

        # Other children still go through the CLI.
        reflect_argv = supervisor._child_argv("reflect-once")
        assert "godel_agent_prototype.resident" in reflect_argv


def test_the_package_barrel_is_lazy() -> None:
    import importlib

    code = (
        "import godel_agent_prototype.resident, sys, json; "
        "print(json.dumps(sorted({m.rsplit('.', 1)[-1] for m in sys.modules "
        "if m.startswith('godel_agent_prototype.resident')})))"
    )
    completed = subprocess.run(
        [sys.executable, "-s", "-B", "-c", code],
        capture_output=True, text=True, timeout=120,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert completed.returncode == 0, completed.stderr[-500:]
    loaded = set(json.loads(completed.stdout))
    # Importing the package must not drag in every submodule.
    assert "gate" not in loaded and "promote" not in loaded

    # But every exported name still resolves.
    package = importlib.import_module("godel_agent_prototype.resident")
    for name in package.__all__:
        assert getattr(package, name) is not None, name


def test_serving_fails_safe_when_an_artifact_cannot_be_read() -> None:
    # A canary artifact that cannot be trusted falls through to the champion.
    with canary_state() as (root, anchors, state_dir, cid, pointer):
        with opened(state_dir) as store:
            (store.artifact_dir(pointer.artifact_hash) / "policy.py").write_text(
                "tampered", encoding="utf-8"
            )
        context = serve_module.build_context(state_dir, anchors_dir=str(anchors))
        try:
            served = 0
            for index in range(40):
                response = serve_module.answer(
                    context, f"q{index}", conversation_id=f"u-{index}"
                )
                if response.get("requested_route") == canary_module.ROUTE_CANARY:
                    served += 1
                    assert response["route"] == serve_module.ROUTE_CHAMPION
                    assert CHAMPION_MARK in response["answer"]
            assert served > 0
        finally:
            context.spool.close()
            context.store.close()

        with opened(state_dir) as store:
            spool_module.ingest(store)
            vetoes = store.list_serving_vetoes(kind=spool_module.KIND_CANARY_VETO)
            assert vetoes and all(
                row["veto"] == serve_module.VETO_ARTIFACT_UNREADABLE for row in vetoes
            )

    # A champion artifact that cannot be trusted yields the fixed fallback —
    # never a generic internal error with no safety observation behind it.
    with serving_state() as (root, anchors, context):
        state_dir = root / "state"
        champion = context.store.require_champion()
        (context.store.artifact_dir(champion.artifact_hash) / "policy.py").write_text(
            "tampered", encoding="utf-8"
        )
        response = serve_module.answer(context, "kartu hilang")
        assert response["ok"] is True
        assert response["route"] == serve_module.ROUTE_FALLBACK
        assert response["answer"] == context.config.safe_fallback
        context.spool.close()
        context.store.close()

        with opened(state_dir) as store:
            spool_module.ingest(store)
            vetoes = store.list_serving_vetoes(kind=spool_module.KIND_CHAMPION_VETO)
            assert vetoes
            assert vetoes[0]["veto"] == serve_module.VETO_ARTIFACT_UNREADABLE


# --- Phase 5A: evidence readiness --------------------------------------------


def _short_readiness_anchor(directory: Path, **overrides: Any) -> None:
    _write_readiness_anchor(directory, **overrides)


@contextmanager
def readiness_state(seed: str = SERVING_SAFE_POLICY, **criteria: Any):
    with temp_state_dir() as root:
        anchors = _write_sentinel_anchors(root / "anchors")
        _short_readiness_anchor(anchors, **criteria)
        state_dir = root / "state"
        with opened(state_dir) as store:
            initialize(store, env_name="id_support", seed_policy=seed,
                       anchors_dir=str(anchors))
            yield root, anchors, store


def test_verdict_combination_is_three_way() -> None:
    assert readiness_module.combine([readiness_module.PASS]) == readiness_module.PASS
    assert readiness_module.combine(
        [readiness_module.PASS, readiness_module.PASS]
    ) == readiness_module.PASS
    # Any failure dominates.
    assert readiness_module.combine(
        [readiness_module.PASS, readiness_module.FAIL, readiness_module.INSUFFICIENT]
    ) == readiness_module.FAIL
    # Absence of evidence is neither a demonstration nor a defect.
    assert readiness_module.combine(
        [readiness_module.PASS, readiness_module.INSUFFICIENT]
    ) == readiness_module.INSUFFICIENT
    assert readiness_module.combine([]) == readiness_module.INSUFFICIENT


def test_a_fresh_deployment_reports_insufficient_evidence_per_cause() -> None:
    with readiness_state() as (root, anchors, store):
        report = readiness_module.generate(store, anchors_dir=str(anchors))
        assert report.verdict == readiness_module.INSUFFICIENT

        by_name = {item.name: item for item in report.items}
        # Each distinct cause of insufficiency is reported as its own item,
        # rather than collapsed into one verdict a reader cannot act on.
        assert by_name["continuous_window_hours"].verdict == readiness_module.INSUFFICIENT
        assert by_name["served_requests"].verdict == readiness_module.INSUFFICIENT
        assert by_name["supervisor_restart"].verdict == readiness_module.INSUFFICIENT
        assert "no restart occurred" in by_name["supervisor_restart"].detail
        assert by_name["canary_auto_revert"].verdict == readiness_module.INSUFFICIENT
        assert "no canary was activated" in by_name["canary_auto_revert"].detail
        assert by_name["false_veto_rate"].verdict == readiness_module.INSUFFICIENT
        # Drills that were never run are missing evidence, not failures.
        drills = [item for item in report.items if item.kind == "drill"]
        assert drills and all(
            item.verdict == readiness_module.INSUFFICIENT for item in drills
        )
        assert all(item.detail == "never run" for item in drills)


def test_each_drill_records_its_directory_and_result_immutably() -> None:
    with readiness_state() as (root, anchors, store):
        runs = readiness_module.run_drills(
            store, anchors, only=["freeze_and_unfreeze", "budget_breach_freezes"]
        )
        assert len(runs) == 2
        assert all(run.result.outcome == readiness_module.PASS for run in runs), [
            (r.result.name, r.result.detail) for r in runs
        ]

        rows = store.list_readiness_checks()
        assert len(rows) == 2
        for row in rows:
            assert row["is_drill"] == 1
            assert row["state_dir"], "a drill must record where it ran"
            assert str(store.state_dir) not in row["state_dir"]
        # Append-only: no way to revise a result.
        assert not hasattr(store, "update_readiness_check")
        assert not hasattr(store, "delete_readiness_check")


def test_drills_leave_production_state_untouched() -> None:
    with readiness_state() as (root, anchors, store):
        champion_before = store.champion_path.read_bytes()
        candidates_before = store.count_candidates()
        audits_before = store.count_audits()
        events_before = store.count_events()
        frozen_before = is_frozen(store)
        counters_before = store.budget_snapshot(budget_module.current_window())

        readiness_module.run_drills(
            store, anchors,
            only=["freeze_and_unfreeze", "rollback_safe_and_refusal",
                  "budget_breach_freezes"],
        )

        # A certification that breaks what it certifies has proved something
        # about a broken system.
        assert store.champion_path.read_bytes() == champion_before
        assert store.count_candidates() == candidates_before
        assert store.count_audits() == audits_before
        assert is_frozen(store) == frozen_before is False
        assert store.budget_snapshot(budget_module.current_window()) == counters_before
        # Only the drill records and one summary event were added.
        assert store.count_events() == events_before + 1
        assert len(store.list_readiness_checks()) == 3


def test_the_window_breaks_on_identity_change_and_on_a_freeze() -> None:
    """Built on an explicit timeline.

    Letting real events supply the timestamps meant every one of them landed in
    the same millisecond, so counting segments measured the clock's resolution
    rather than the segmentation logic.
    """

    from datetime import datetime, timedelta, timezone

    with readiness_state() as (root, anchors, store):
        base = datetime.now(timezone.utc) - timedelta(hours=10)

        def stamp(hours: float) -> str:
            return observe_module.format_stamp(base + timedelta(hours=hours))

        # Wipe the timeline the fixture created and lay down a known one.
        store.conn.execute("DELETE FROM events")
        store.conn.execute("DELETE FROM freezes")
        for hours, kind in ((0.0, "seeded"), (9.0, "seeded")):
            store.conn.execute(
                "INSERT INTO events (event_id, created_at, kind, payload_json) "
                "VALUES (?, ?, ?, '{}')",
                (new_id(), stamp(hours), kind),
            )

        # The window runs to *now*, not to the last recorded event: a window
        # that stopped at the last event would under-report a system that is
        # healthy and simply quiet.
        only_one = readiness_module.window_segments(store)
        assert len(only_one) == 1
        assert abs(only_one[0].seconds - 10 * 3600) < 5

        # A freeze from +2h to +4h excludes that span and splits the window.
        store.conn.execute(
            "INSERT INTO freezes (freeze_id, created_at, reason, actor, trigger_json,"
            " state, resolved_at) VALUES (?, ?, 'drill', 'ops', '{}', 'resolved', ?)",
            (new_id(), stamp(2.0), stamp(4.0)),
        )
        after_freeze = readiness_module.window_segments(store)
        assert len(after_freeze) == 2
        assert abs(after_freeze[0].seconds - 2 * 3600) < 5   # 0h -> 2h
        assert abs(after_freeze[1].seconds - 6 * 3600) < 5   # 4h -> now

        # An identity change at +6h cuts the second span again.
        store.conn.execute(
            "INSERT INTO events (event_id, created_at, kind, payload_json) "
            "VALUES (?, ?, ?, '{}')",
            (new_id(), stamp(6.0), observe_module.IDENTITY_CHANGED_EVENT),
        )
        after_identity = readiness_module.window_segments(store)
        assert len(after_identity) == 3
        assert abs(after_identity[1].seconds - 2 * 3600) < 5  # 4h -> 6h
        assert abs(after_identity[2].seconds - 4 * 3600) < 5  # 6h -> now

        # The reported duration is the longest qualifying span, not the elapsed
        # time since the first event.
        data = readiness_module.gather(store)
        assert data.segment is not None
        assert abs(data.segment.seconds - 4 * 3600) < 5
        # Not the 10 hours of elapsed time: a freeze and an identity change
        # both happened inside it.
        assert data.duration_hours < 10.0


def test_a_frozen_span_does_not_count_as_healthy_serving() -> None:
    with readiness_state() as (root, anchors, store):
        freeze(store, reason="unresolved", actor="ops")
        data = readiness_module.gather(store)
        # An unresolved freeze runs to now, so nothing after it accumulates.
        assert data.segment is None or data.segment.end <= observe_module.parse_stamp(
            store.list_freezes()[0]["created_at"]
        )


def test_report_is_deterministic_across_a_store_reopen() -> None:
    with readiness_state() as (root, anchors, store):
        readiness_module.run_drills(store, anchors, only=["freeze_and_unfreeze"])
        first = readiness_module.generate(store, anchors_dir=str(anchors), record=False)
        state_dir = store.state_dir
        store.close()

        # Reopened inside the fixture: closing over a directory the context has
        # already removed would compare a real report against an empty one.
        with opened(state_dir) as reopened:
            second = readiness_module.generate(
                reopened, anchors_dir=str(anchors), record=False
            )
        assert second.threshold_identity, "the reopened store saw no anchors"

    def comparable(report: Any) -> Any:
        payload = report.to_dict()
        # Identifiers and timestamps of the report itself necessarily differ.
        for key in ("report_id", "created_at", "window_end"):
            payload.pop(key, None)
        payload["summary"].pop("window", None)
        payload["summary"].pop("segments", None)
        payload["summary"]["duration_hours"] = 0
        for item in payload["items"]:
            if item["name"] == "continuous_window_hours":
                item["observed"] = 0
        return payload

    # Nothing depends on in-memory supervisor state, so which process rendered
    # the document does not change what it says.
    assert comparable(first) == comparable(second)


def test_a_report_records_the_identities_and_window_it_observed() -> None:
    with readiness_state() as (root, anchors, store):
        report = readiness_module.generate(store, anchors_dir=str(anchors))
        assert report.dataset_identity.get("manifest_hash")
        assert report.threshold_identity.get("gate_hash")
        assert report.threshold_identity.get("readiness_hash")
        assert report.threshold_identity.get("serving_hash")
        assert report.champion_candidate_id == store.require_champion().candidate_id
        assert report.champion_artifact_hash == store.require_champion().artifact_hash

        rows = store.list_readiness_reports()
        assert len(rows) == 1
        assert rows[0]["schema_version"] == readiness_report_module.REPORT_SCHEMA_VERSION
        assert json.loads(rows[0]["threshold_identity_json"])["readiness_hash"]


def test_changed_anchors_downgrade_the_observation_items() -> None:
    with readiness_state() as (root, anchors, store):
        _short_readiness_anchor(anchors, min_served_requests=7)
        report = readiness_module.generate(store, anchors_dir=str(anchors))

        by_name = {item.name: item for item in report.items}
        assert by_name["anchor_identity"].verdict == readiness_module.INSUFFICIENT
        # Observations gathered under a configuration that no longer holds
        # describe something else.
        assert by_name["served_requests"].verdict == readiness_module.INSUFFICIENT
        assert "anchor identity changed" in by_name["served_requests"].detail
        assert report.verdict == readiness_module.INSUFFICIENT


def test_readiness_anchor_changes_are_visible_in_the_threshold_identity() -> None:
    with readiness_state() as (root, anchors, store):
        before = load_every_anchor(anchors)[0]
        _short_readiness_anchor(anchors, max_false_veto_rate=0.9)
        after = load_every_anchor(anchors)[0]
        assert before.readiness_hash != after.readiness_hash
        assert before.mismatch_field(after) in ("readiness_hash", "values")


def test_unexplained_freeze_classification_catches_malformed_triggers() -> None:
    classify = readiness_module.classify_freeze
    assert classify({"trigger_json": json.dumps({"counters": {}}), "reason": "", "actor": ""}) \
        == observe_module.CAUSE_BUDGET
    assert classify({"trigger_json": json.dumps({"mismatch_field": "gate_hash"}),
                     "reason": "", "actor": ""}) == observe_module.CAUSE_ANCHOR_DRIFT
    assert classify({"trigger_json": json.dumps({"anchor_error": "ThresholdError"}),
                     "reason": "", "actor": ""}) == observe_module.CAUSE_ANCHOR_UNUSABLE
    assert classify({"trigger_json": json.dumps({"veto": "unsafe_output",
                                                 "candidate_id": "c"}),
                     "reason": "", "actor": ""}) == observe_module.CAUSE_CHAMPION_VETO
    assert classify({"trigger_json": json.dumps({"activation_id": "a", "breaches": 3}),
                     "reason": "", "actor": ""}) == observe_module.CAUSE_CANARY_REVERT
    assert classify({"trigger_json": "{}", "reason": "reviewed drift", "actor": "ops"}) \
        == observe_module.CAUSE_OPERATOR

    # The cases the criterion exists to catch.
    assert classify({"trigger_json": "{}", "reason": "", "actor": ""}) \
        == observe_module.CAUSE_UNEXPLAINED
    assert classify({"trigger_json": "not json", "reason": "x", "actor": "y"}) \
        == observe_module.CAUSE_UNEXPLAINED
    assert classify({"trigger_json": json.dumps(["not", "an", "object"]),
                     "reason": "x", "actor": "y"}) == observe_module.CAUSE_UNEXPLAINED
    # A freeze with a reason but no actor is not an explained operator freeze.
    assert classify({"trigger_json": "{}", "reason": "because", "actor": ""}) \
        == observe_module.CAUSE_UNEXPLAINED


def test_an_unexplained_freeze_fails_rather_than_reporting_no_evidence() -> None:
    with readiness_state() as (root, anchors, store):
        store.insert_freeze("bare-freeze", reason="", actor="", trigger={})
        report = readiness_module.generate(store, anchors_dir=str(anchors))
        item = {i.name: i for i in report.items}["unexplained_freezes"]
        # A freeze that should not have happened is a defect, not missing data.
        assert item.verdict == readiness_module.FAIL
        assert report.verdict == readiness_module.FAIL


def test_veto_labels_are_immutable_and_scoped_to_the_served_artifact() -> None:
    with serving_state(SERVING_UNSAFE_POLICY) as (root, anchors, context):
        response = serve_module.answer(context, "kartu hilang")
        request_id = response["request_id"]
        context.spool.close()
        context.store.close()

        with opened(root / "state") as store:
            spool_module.ingest(store)
            veto = store.list_serving_vetoes()[0]

            assert store.insert_veto_label(
                {"label_id": new_id(), "request_id": request_id,
                 "artifact_hash": veto["artifact_hash"], "veto": veto["veto"],
                 "label": "false_veto", "actor": "reviewer"}
            )
            # One label per request, and no way to revise it.
            assert not store.insert_veto_label(
                {"label_id": new_id(), "request_id": request_id,
                 "artifact_hash": veto["artifact_hash"], "veto": veto["veto"],
                 "label": "true_veto", "actor": "reviewer"}
            )
            assert store.list_veto_labels()[0]["label"] == "false_veto"


def test_a_label_for_a_different_artifact_is_invalidated_not_counted() -> None:
    with serving_state(SERVING_UNSAFE_POLICY) as (root, anchors, context):
        response = serve_module.answer(context, "kartu hilang")
        context.spool.close()
        context.store.close()

        with opened(root / "state") as store:
            spool_module.ingest(store)
            store.insert_veto_label(
                {"label_id": new_id(), "request_id": response["request_id"],
                 # A judgement about a different artifact's output says nothing
                 # about what was actually served.
                 "artifact_hash": "0" * 64, "veto": serve_module.VETO_UNSAFE_OUTPUT,
                 "label": "false_veto", "actor": "reviewer"}
            )
            data = readiness_module.gather(store)
            assert data.invalidated_labels == 1
            assert data.labelled == 0
            assert data.false_veto_rate is None


def test_a_rate_is_refused_below_the_minimum_sample() -> None:
    with readiness_state(min_labelled_vetoes=5) as (root, anchors, store):
        report = readiness_module.generate(store, anchors_dir=str(anchors))
        item = {i.name: i for i in report.items}["false_veto_rate"]
        assert item.verdict == readiness_module.INSUFFICIENT
        assert item.observed["labelled"] == 0
        # No rate is stated at all.
        assert "rate" not in item.observed


def test_readiness_neither_imports_nor_authorises_promotion() -> None:
    import ast as ast_module

    package = Path(__file__).resolve().parent / "readiness"
    # checks.py *is* the drills and runner.py seeds their directories; both
    # necessarily drive the real machinery. The path that decides and reports
    # is what must never reach the promoter.
    decision_path = {"report.py", "observe.py", "verdicts.py", "__init__.py"}
    for path in sorted(package.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        tree = ast_module.parse(source)
        if path.name in decision_path:
            for node in ast_module.walk(tree):
                if isinstance(node, ast_module.ImportFrom) and node.module:
                    assert not node.module.endswith("promote"), f"{path.name} imports promote"
        # Only the reporter touches the reports table, and only to write one.
        assert "readiness_reports" not in source or path.name == "report.py"

    # And no module outside readiness reads its output.
    resident = Path(__file__).resolve().parent
    for path in sorted(resident.glob("*.py")):
        if path.name in ("store.py", "cli.py", "test_resident.py"):
            continue
        body = path.read_text(encoding="utf-8")
        assert "list_readiness_reports" not in body, path.name
        assert "readiness_reports" not in body, path.name


TESTS = [
    test_store_opens_in_wal_mode_and_stamps_schema,
    test_migrations_apply_in_order_and_are_not_reapplied,
    test_public_snapshot_storage_round_trips_and_fails_closed,
    test_state_dir_resolution_prefers_explicit_then_env_then_default,
    test_experiences_survive_reopen,
    test_identical_code_shares_one_artifact_across_distinct_attempts,
    test_writing_the_same_artifact_twice_does_not_overwrite,
    test_artifact_tampering_is_detected_on_read_and_blocks_promotion,
    test_archive_records_lineage_root_first,
    test_parent_selection_is_deterministic_and_reproducible,
    test_rejected_candidates_are_archived_but_never_selectable,
    test_reflect_archives_every_failure_mode_as_a_structured_verdict,
    test_non_improvement_is_archived_with_a_delta,
    test_improvement_is_labelled_and_scored,
    test_reflect_requires_initialization,
    test_reflect_never_mutates_the_champion,
    test_adapter_normalizes_zero_one_and_many_self_updates,
    test_dropped_alternatives_are_recorded_in_the_verdict,
    test_init_establishes_champion_and_refuses_to_run_twice,
    test_init_refuses_an_unloadable_seed_rather_than_inventing_a_champion,
    test_promotion_swaps_the_pointer_and_records_lineage,
    test_promotion_refuses_candidates_without_an_artifact,
    test_promotion_refuses_rejected_candidate_with_valid_artifact,
    test_init_binds_the_state_directory_to_one_environment,
    test_reflect_refuses_an_environment_other_than_the_bound_one,
    test_reflect_defaults_to_the_bound_environment,
    test_force_init_cannot_rebind_to_a_different_environment,
    test_init_writes_a_public_only_snapshot_that_excludes_holdout_cases,
    test_reflection_reads_only_the_state_directory_snapshot,
    test_promotion_recovers_deterministically_from_every_interruption_point,
    test_promotion_refuses_to_repromote_the_current_champion,
    test_full_cycle_persists_across_process_boundaries,
    test_subprocess_and_in_process_runners_agree_on_score,
    test_infinite_loop_candidate_times_out_and_is_reaped,
    test_cpu_limit_produces_a_resource_verdict_and_records_enforcement,
    test_memory_heavy_candidate_is_contained_and_reported_honestly,
    test_per_case_policy_output_is_capped_before_it_accumulates,
    test_oversized_request_is_rejected_before_spawning,
    test_worker_that_cannot_start_is_a_crash_not_an_in_process_fallback,
    test_reflection_archives_a_runner_crash_rather_than_falling_back,
    test_malformed_worker_response_fails_closed,
    test_oversized_worker_stdout_is_bounded_before_reaching_parent_memory,
    test_worker_revalidates_independently_of_the_parent_gate,
    test_early_ast_rejection_records_that_nothing_executed,
    test_worker_environment_carries_no_credentials_or_user_paths,
    test_request_carries_records_not_a_dataset_path,
    test_terminate_group_reaps_the_whole_process_group,
    test_anchors_dir_resolution_prefers_explicit_then_env_then_package,
    test_candidate_child_receives_inputs_but_never_holdout_labels,
    test_audit_response_carries_only_allowlisted_aggregates,
    test_no_holdout_content_reaches_the_database_or_events,
    test_audit_refuses_a_drifted_anchor_dataset,
    test_audit_refuses_an_environment_without_a_holdout,
    test_audit_refuses_a_non_selectable_candidate,
    test_repeated_audits_create_separate_immutable_records,
    test_audits_do_not_rewrite_the_public_verdict_or_touch_the_champion,
    test_audits_do_not_influence_parent_selection,
    test_audit_module_does_not_import_promotion_code,
    test_auditor_refuses_a_policy_that_does_not_match_its_artifact_hash,
    test_audit_records_a_failure_when_the_candidate_cannot_execute,
    test_unattributed_sigkill_is_a_crash_not_assumed_memory_pressure,
    test_audit_response_schema_accepts_a_well_formed_response,
    test_audit_response_has_no_free_text_field_at_all,
    test_sentinel_cannot_ride_any_permitted_field,
    test_audit_response_must_correlate_with_the_request,
    test_audit_response_rejects_nonfinite_and_out_of_range_numbers,
    test_audit_response_rejects_a_malformed_isolation_profile,
    test_non_passing_audits_may_not_report_results,
    test_passing_audit_requires_the_ok_reason_and_exact_identity,
    test_altered_auditor_response_is_discarded_and_never_persisted,
    test_audit_detail_text_is_always_parent_authored,
    test_gate_evaluates_every_veto_even_after_one_fails,
    test_every_veto_fails_closed_when_its_inputs_are_missing,
    test_one_failing_veto_rejects_even_when_all_others_pass,
    test_swapped_thresholds_after_init_fail_closed,
    test_unparseable_or_out_of_range_thresholds_fail_closed,
    test_gate_names_exactly_which_artifact_needs_auditing,
    test_gate_verdict_is_immutable_and_bound_to_its_comparison,
    test_stale_gate_verdict_cannot_authorize_a_promotion,
    test_illegal_state_transitions_raise_and_persist_nothing,
    test_promotion_records_the_full_transition_chain,
    test_seed_bootstrap_is_recorded_rather_than_implicit,
    test_replay_nondeterminism_vetoes_promotion,
    test_replay_failure_vetoes_rather_than_raising,
    test_replay_uses_the_isolated_runner_with_the_gate_limits,
    test_environments_without_a_holdout_mark_vetoes_inapplicable_not_passed_blindly,
    test_gate_module_does_not_import_or_trigger_promotion,
    test_gate_evaluation_alone_never_moves_the_champion,
    test_intrinsic_failure_retires_a_candidate_but_a_fixable_one_does_not,
    test_freeze_is_idempotent_and_returns_the_active_freeze,
    test_unfreeze_requires_the_active_id_and_preserves_the_record,
    test_freeze_blocks_forward_motion_but_not_diagnosis_or_retreat,
    test_rollback_selects_the_best_safe_target_and_records_its_evidence,
    test_rollback_does_not_clear_the_freeze,
    test_rollback_refuses_when_no_target_qualifies,
    test_rollback_refuses_an_explicit_target_that_is_not_safe,
    test_budget_counters_are_tied_to_events_and_snapshot_consistently,
    test_budget_breach_freezes_through_the_single_path_and_is_immutable,
    test_frozen_state_vetoes_the_gate_as_well_as_blocking_promote,
    test_budget_veto_reports_the_same_snapshot_it_judged,
    test_no_automatic_promotion_path_exists_anywhere,
    test_serve_returns_the_champion_answer,
    test_unsafe_champion_output_is_suppressed_and_never_reaches_the_client,
    test_raising_champion_is_suppressed_with_only_its_exception_type_kept,
    test_output_guard_is_negation_aware,
    test_serve_cannot_write_to_the_database_or_reach_a_mutation_api,
    test_spool_ingestion_is_idempotent_across_a_replayed_file,
    test_malformed_spool_line_is_quarantined_without_blocking_the_rest,
    test_served_request_records_full_attribution,
    test_socket_path_is_short_private_and_owner_only,
    test_stale_socket_is_removed_only_when_nothing_is_listening,
    test_socket_rejects_oversized_and_malformed_frames,
    test_serving_refuses_to_start_against_edited_anchors,
    test_negation_must_apply_to_the_solicitation_not_the_whole_answer,
    test_ingestion_converges_from_every_interruption_point,
    test_oversized_spool_line_is_bounded_and_does_not_block_the_next_record,
    test_spool_is_private_and_quarantine_records_no_content,
    test_supervisor_lock_is_exclusive_and_released_on_exit,
    test_clocks_fire_when_due_and_not_before,
    test_audit_clock_runs_while_frozen_but_reflection_does_not,
    test_supervisor_control_channel_is_small_and_refuses_the_unknown,
    test_pointer_changes_delegate_while_a_supervisor_owns_the_directory,
    test_supervisor_restart_does_not_refire_a_cycle_that_already_ran,
    test_batch_audit_uses_artifact_and_current_dataset_identity,
    test_batch_audit_is_bounded_and_reports_what_it_skipped,
    test_batch_audit_continues_past_a_failure_and_runs_while_frozen,
    test_supervisor_children_are_one_shot_and_their_failure_is_recorded,
    test_supervisor_does_not_hold_self_modification_between_cycles,
    test_canary_serves_its_own_slice_and_only_its_slice,
    test_routing_is_stable_per_conversation_and_salted,
    test_failing_canary_output_is_replaced_by_the_champion_not_the_fallback,
    test_the_supervisor_not_serve_clears_a_breaching_canary,
    test_no_automatic_champion_rollback_exists,
    test_canary_activation_and_clearing_recover_from_every_interruption,
    test_orphan_canary_pointer_is_removed_on_recovery,
    test_edited_anchors_prevent_activation_and_clear_a_live_canary,
    test_freeze_blocks_canary_activation,
    test_canary_activation_requires_a_passing_gate_and_bounded_percent,
    test_routing_salt_never_leaves_the_pointer,
    test_supervisor_children_can_import_the_package,
    test_supervisor_owns_starts_restarts_and_stops_the_serve_child,
    test_a_failed_clock_run_does_not_count_as_a_completed_one,
    test_a_failed_clock_backs_off_then_succeeds_on_retry,
    test_canary_pointer_changes_delegate_to_the_supervisor,
    test_canary_breaches_are_scoped_to_their_activation,
    test_canary_veto_records_carry_their_activation,
    test_a_champion_hard_veto_freezes_without_moving_the_pointer,
    test_unusable_anchors_contain_exactly_as_changed_anchors_do,
    test_serving_process_loads_no_mutation_capable_module,
    test_the_supervisor_starts_serve_through_its_own_entry_point,
    test_the_package_barrel_is_lazy,
    test_serving_fails_safe_when_an_artifact_cannot_be_read,
    test_verdict_combination_is_three_way,
    test_a_fresh_deployment_reports_insufficient_evidence_per_cause,
    test_each_drill_records_its_directory_and_result_immutably,
    test_drills_leave_production_state_untouched,
    test_the_window_breaks_on_identity_change_and_on_a_freeze,
    test_a_frozen_span_does_not_count_as_healthy_serving,
    test_report_is_deterministic_across_a_store_reopen,
    test_a_report_records_the_identities_and_window_it_observed,
    test_changed_anchors_downgrade_the_observation_items,
    test_readiness_anchor_changes_are_visible_in_the_threshold_identity,
    test_unexplained_freeze_classification_catches_malformed_triggers,
    test_an_unexplained_freeze_fails_rather_than_reporting_no_evidence,
    test_veto_labels_are_immutable_and_scoped_to_the_served_artifact,
    test_a_label_for_a_different_artifact_is_invalidated_not_counted,
    test_a_rate_is_refused_below_the_minimum_sample,
    test_readiness_neither_imports_nor_authorises_promotion,
    test_existing_smoke_suite_still_passes,
]


if __name__ == "__main__":
    for test in TESTS:
        test()
        print(f"ok - {test.__name__}")
    print(f"\nall {len(TESTS)} resident tests passed")
