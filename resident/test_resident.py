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
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..godel_agent import Action, EvaluationResult, SelfState
from ..dataset_env import load_cases_from_dir, split_cases_for_holdout
from .archive import CandidateArchive, stable_unit_interval
from .experience import ExperienceLog
from .models import (
    STATUS_IMPROVEMENT,
    STATUS_NO_CANDIDATE,
    STATUS_NO_IMPROVEMENT,
    STATUS_PROVIDER_ERROR,
    STATUS_RETURN_TYPE,
    STATUS_RUNTIME,
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
from .reflect import (
    EVAL_SETS_DIR,
    REFLECT_CYCLE_EVENT,
    bound_environment,
    load_public_cases,
    reflect_once,
)
from .store import (
    ArtifactIntegrityError,
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
                "environment": RaisingEnvironment(),
            },
            STATUS_RUNTIME,
        ),
        (
            "malformed result",
            {
                "mutator": StaticMutator(candidates=[GOOD_POLICY]),
                "environment": MalformedEnvironment(),
            },
            STATUS_RETURN_TYPE,
        ),
        (
            "non-finite score",
            {
                "mutator": StaticMutator(candidates=[GOOD_POLICY]),
                "environment": NonFiniteEnvironment(),
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
            environment=RaisingEnvironment(),
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
    test_existing_smoke_suite_still_passes,
]


if __name__ == "__main__":
    for test in TESTS:
        test()
        print(f"ok - {test.__name__}")
    print(f"\nall {len(TESTS)} resident tests passed")
