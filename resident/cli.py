"""Command-line interface for the resident loop.

    python3 -m godel_agent_prototype.resident init
    python3 -m godel_agent_prototype.resident record --query ... --answer ...
    python3 -m godel_agent_prototype.resident reflect-once
    python3 -m godel_agent_prototype.resident archive-list
    python3 -m godel_agent_prototype.resident status
    python3 -m godel_agent_prototype.resident show <candidate-id>
    python3 -m godel_agent_prototype.resident promote <candidate-id> --reason "..."

The state directory comes from ``--state-dir``, then ``$GODEL_RESIDENT_DIR``,
then ``<package>/.resident``. The last is a convenience for working in a
checkout; installed packages are often read-only, so set one of the first two
in any real deployment.

``promote`` is the only command that changes what the resident serves, and
nothing invokes it but a person at a terminal.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Sequence

from ..code_agent_env import CodeTaskEnvironment
from ..code_llm_mutator import CodeLLMMutationProvider
from ..llm_mutator import LLMMutationProvider, OpenAICompatibleTransport
from .archive import CandidateArchive
from .experience import ExperienceLog, KNOWN_OUTCOMES
from .models import SCORED_STATUSES
from .mutators import MutationProviderAdapter, Mutator
from .promote import (
    AlreadyInitializedError,
    PromotionError,
    initialize,
    promote,
)
from .runner import RunnerLimits
from .reflect import (
    DEFAULT_ENVIRONMENT,
    DEFAULT_MIN_DELTA,
    ENVIRONMENTS,
    REFLECT_CYCLE_EVENT,
    resolve_environment_spec,
    reflect_once,
)
from .store import (
    CONFIG_ENVIRONMENT,
    EnvironmentMismatchError,
    ResidentError,
    ResidentNotInitializedError,
    ResidentStore,
    STATE_DIR_ENV_VAR,
    resolve_state_dir,
)


EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NOT_INITIALIZED = 2

#: The resident decides when to reflect, so the providers' own iteration cap
#: would only cause spurious "no candidate" verdicts on long-lived archives.
LLM_MAX_ITERATIONS = 1_000_000


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m godel_agent_prototype.resident",
        description="Persistent, audited reflection for the constrained Godel-Agent.",
    )
    parser.add_argument(
        "--state-dir",
        default=None,
        help=(
            "State directory. Defaults to $" + STATE_DIR_ENV_VAR + ", then <package>/.resident."
        ),
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    env_names = sorted(ENVIRONMENTS)

    init_parser = subparsers.add_parser(
        "init", help="Establish the seed candidate and first champion."
    )
    init_parser.add_argument(
        "--env",
        default=DEFAULT_ENVIRONMENT,
        choices=env_names,
        help="Environment to bind this state directory to. Cannot be changed later.",
    )
    init_parser.add_argument(
        "--seed-policy", default=None, help="Path to a solve(query, kb) source file."
    )
    init_parser.add_argument("--actor", default="", help="Who ran this command.")
    init_parser.add_argument(
        "--force", action="store_true", help="Seed a new champion even if one exists."
    )

    record_parser = subparsers.add_parser("record", help="Record one interaction.")
    record_parser.add_argument("--query", required=True)
    record_parser.add_argument("--answer", required=True)
    record_parser.add_argument("--outcome", default="unknown", help=f"One of {KNOWN_OUTCOMES}.")
    record_parser.add_argument("--source", default="cli")
    record_parser.add_argument("--tag", action="append", default=[], dest="tags")

    reflect_parser = subparsers.add_parser(
        "reflect-once", help="Run one reflection cycle. Never promotes."
    )
    reflect_parser.add_argument(
        "--env",
        default=None,
        choices=env_names,
        help="Optional check: must match the environment bound at init.",
    )
    reflect_parser.add_argument(
        "--mutator",
        default="rule",
        choices=("rule", "llm"),
        help="rule = deterministic, offline (default). llm = local OpenAI-compatible endpoint.",
    )
    reflect_parser.add_argument("--base-url", default=None, help="LLM base URL (llm mutator).")
    reflect_parser.add_argument("--model", default=None, help="LLM model name (llm mutator).")
    reflect_parser.add_argument("--temperature", type=float, default=0.2)
    reflect_parser.add_argument(
        "--timeout",
        type=float,
        default=RunnerLimits().wall_clock_seconds,
        help="Wall-clock seconds allowed for candidate execution.",
    )
    reflect_parser.add_argument(
        "--cpu-seconds",
        type=int,
        default=RunnerLimits().cpu_seconds,
        help="CPU seconds allowed for candidate execution.",
    )
    reflect_parser.add_argument(
        "--min-delta",
        type=float,
        default=DEFAULT_MIN_DELTA,
        help="Public-score gain required to label a candidate an improvement.",
    )

    list_parser = subparsers.add_parser("archive-list", help="List archived candidates.")
    list_parser.add_argument("--limit", type=int, default=20)
    list_parser.add_argument(
        "--selectable-only",
        action="store_true",
        help="Show only scored candidates that could be promoted.",
    )

    subparsers.add_parser("status", help="Summarise champion, archive, and experiences.")

    show_parser = subparsers.add_parser("show", help="Show one candidate in full.")
    show_parser.add_argument("candidate_id")

    promote_parser = subparsers.add_parser(
        "promote", help="Make an archived candidate the champion. Human-invoked only."
    )
    promote_parser.add_argument("candidate_id")
    promote_parser.add_argument("--reason", required=True, help="Why this candidate is promoted.")
    promote_parser.add_argument("--actor", default="", help="Who approved the promotion.")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    emit = _json_emitter if args.json else _text_emitter

    try:
        store = ResidentStore.open(args.state_dir)
    except ResidentError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    try:
        with store:
            handler = HANDLERS[args.command]
            return handler(store, args, emit)
    except ResidentNotInitializedError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_NOT_INITIALIZED
    except (ResidentError, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR


# --- command handlers -------------------------------------------------------


def _cmd_init(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    seed_policy = None
    if args.seed_policy:
        seed_policy = _read_text(args.seed_policy)
    try:
        candidate, champion = initialize(
            store,
            env_name=args.env,
            seed_policy=seed_policy,
            actor=args.actor,
            force=args.force,
        )
    except (AlreadyInitializedError, EnvironmentMismatchError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    emit(
        {
            "state_dir": str(store.state_dir),
            "environment": args.env,
            "candidate_id": candidate.candidate_id,
            "artifact_hash": candidate.artifact_hash,
            "public_score": candidate.public_score,
            "champion": champion.to_dict(),
        },
        [
            f"initialized {store.state_dir}",
            f"  environment  {args.env}",
            f"  seed         {candidate.candidate_id}",
            f"  artifact     {candidate.artifact_hash}",
            f"  score        {_fmt_score(candidate.public_score)}",
        ],
    )
    return EXIT_OK


def _cmd_record(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    log = ExperienceLog(store)
    experience = log.record(
        query=args.query,
        answer=args.answer,
        outcome=args.outcome,
        source=args.source,
        tags=tuple(args.tags),
    )
    emit(
        experience.to_dict(),
        [
            f"recorded {experience.experience_id}",
            f"  outcome  {experience.outcome}",
            f"  total    {log.count()}",
        ],
    )
    return EXIT_OK


def _cmd_reflect_once(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    spec = resolve_environment_spec(store, args.env)
    limits = RunnerLimits(
        wall_clock_seconds=args.timeout,
        cpu_seconds=args.cpu_seconds,
    )
    mutator = _build_mutator(args, spec, spec.build_environment(store))

    outcome = reflect_once(
        store,
        env_name=spec.name,
        mutator=mutator,
        min_delta=args.min_delta,
        limits=limits,
    )
    verdict = outcome.verdict
    lines = [
        f"cycle {outcome.cycle} on {outcome.environment} via {outcome.mutator}",
        f"  candidate  {outcome.candidate_id}",
        f"  artifact   {outcome.candidate.artifact_hash or '(none)'}",
        f"  parent     {outcome.parent_candidate_id}",
        f"  status     {verdict.status}",
        f"  score      {_fmt_score(verdict.public_score)}"
        f"  (parent {_fmt_score(verdict.parent_score)}, delta {_fmt_delta(verdict.delta)})",
        f"  isolation  {_fmt_isolation(verdict.isolation)}",
        "  holdout    not evaluated (isolated auditor arrives in PR B)",
    ]
    for reason in verdict.reasons:
        lines.append(f"  - {reason}")
    lines.append("")
    lines.append("Champion unchanged. To adopt this candidate, run:")
    lines.append(
        f"  python3 -m godel_agent_prototype.resident promote {outcome.candidate_id} "
        '--reason "..."'
    )
    emit(outcome.to_dict(), lines)
    return EXIT_OK


def _cmd_archive_list(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    archive = CandidateArchive(store)
    champion = store.read_champion()
    champion_id = champion.candidate_id if champion is not None else None

    if args.selectable_only:
        candidates = list(reversed(archive.selectable()))[: args.limit]
    else:
        candidates = archive.list(limit=args.limit)

    rows = [candidate.to_dict() for candidate in candidates]
    lines = [f"{len(candidates)} candidate(s) in {store.state_dir}"]
    for candidate in candidates:
        marker = "*" if candidate.candidate_id == champion_id else " "
        lines.append(
            f"{marker} {candidate.candidate_id[:12]}  c{candidate.cycle:<3} "
            f"{candidate.verdict.status:<26} {_fmt_score(candidate.public_score):>7}  "
            f"{candidate.origin}"
        )
    if champion_id is not None:
        lines.append("")
        lines.append("* = current champion")
    emit({"candidates": rows, "champion_candidate_id": champion_id}, lines)
    return EXIT_OK


def _cmd_status(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    archive = CandidateArchive(store)
    log = ExperienceLog(store)
    champion = store.read_champion()
    best = archive.best()
    pending = store.pending_promotions()

    payload = {
        "state_dir": str(store.state_dir),
        "schema_version": store.schema_version(),
        "environment": store.get_config(CONFIG_ENVIRONMENT),
        "champion": champion.to_dict() if champion is not None else None,
        "candidates": archive.count(),
        "selectable_candidates": len(archive.selectable()),
        "reflect_cycles": store.count_events(kind=REFLECT_CYCLE_EVENT),
        "experiences": log.count(),
        "experience_outcomes": log.outcome_counts(),
        "best_candidate_id": best.candidate_id if best is not None else None,
        "best_public_score": best.public_score if best is not None else None,
        "pending_promotions": len(pending),
        "holdout_evaluated": False,
        "auto_promotion": "not implemented",
    }

    if champion is None:
        lines = [
            f"state dir     {store.state_dir}",
            f"environment   {payload['environment'] or '(unbound)'}",
            "champion      (none) - run `init` first",
            f"experiences   {log.count()}",
        ]
    else:
        lines = [
            f"state dir     {store.state_dir}",
            f"environment   {payload['environment']} (bound at init)",
            f"champion      {champion.candidate_id}",
            f"  artifact    {champion.artifact_hash}",
            f"  promoted    {champion.promoted_at} by {champion.actor or '(unrecorded)'}",
            f"  reason      {champion.reason or '(none)'}",
            f"candidates    {archive.count()} archived, {len(archive.selectable())} selectable",
            f"best score    {_fmt_score(payload['best_public_score'])}"
            f" ({(best.candidate_id[:12] if best else '-')})",
            f"cycles        {payload['reflect_cycles']} reflection(s)",
            f"experiences   {log.count()} {log.outcome_counts() or ''}",
            "holdout       never evaluated in this process (phase 2)",
            "promotion     manual only",
        ]
    if pending:
        lines.append(f"WARNING: {len(pending)} promotion(s) still pending after recovery.")
    emit(payload, lines)
    return EXIT_OK


def _cmd_show(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    archive = CandidateArchive(store)
    candidate = archive.get(args.candidate_id)
    if candidate is None:
        print(f"error: no candidate {args.candidate_id!r}", file=sys.stderr)
        return EXIT_ERROR

    payload = candidate.to_dict()
    payload["lineage"] = archive.lineage(candidate.candidate_id)
    code = None
    integrity = "n/a"
    if candidate.artifact_hash is not None:
        try:
            code = store.read_artifact(candidate.artifact_hash)
            integrity = "verified"
        except ResidentError as exc:
            integrity = f"FAILED: {exc}"
    payload["artifact_integrity"] = integrity
    payload["policy_code"] = code

    lines = [
        f"candidate  {candidate.candidate_id}",
        f"  created  {candidate.created_at}  cycle {candidate.cycle}  tier {candidate.tier}",
        f"  origin   {candidate.origin}",
        f"  parent   {candidate.parent_candidate_id or '(root)'}",
        f"  lineage  {' -> '.join(x[:8] for x in payload['lineage'])}",
        f"  status   {candidate.verdict.status}",
        f"  score    {_fmt_score(candidate.public_score)} "
        f"(parent {_fmt_score(candidate.verdict.parent_score)}, "
        f"delta {_fmt_delta(candidate.verdict.delta)})",
        f"  artifact {candidate.artifact_hash or '(none)'} [{integrity}]",
        f"  detail   {candidate.verdict.detail}",
    ]
    for reason in candidate.verdict.reasons:
        lines.append(f"  - {reason}")
    if code:
        lines.append("")
        lines.append(code.rstrip())
    emit(payload, lines)
    return EXIT_OK


def _cmd_promote(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    try:
        champion = promote(
            store,
            args.candidate_id,
            reason=args.reason,
            actor=args.actor,
        )
    except PromotionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    assert champion is not None
    emit(
        champion.to_dict(),
        [
            f"promoted {champion.candidate_id}",
            f"  artifact  {champion.artifact_hash}",
            f"  previous  {champion.previous_candidate_id or '(none)'}",
            f"  reason    {champion.reason}",
            f"  actor     {champion.actor or '(unrecorded)'}",
        ],
    )
    return EXIT_OK


HANDLERS = {
    "init": _cmd_init,
    "record": _cmd_record,
    "reflect-once": _cmd_reflect_once,
    "archive-list": _cmd_archive_list,
    "status": _cmd_status,
    "show": _cmd_show,
    "promote": _cmd_promote,
}


# --- helpers ----------------------------------------------------------------


def _build_mutator(args: argparse.Namespace, spec: Any, environment: Any) -> Mutator:
    if args.mutator == "rule":
        return spec.build_mutator()

    transport_kwargs: dict[str, Any] = {}
    if args.base_url:
        transport_kwargs["base_url"] = args.base_url
    if args.model:
        transport_kwargs["model"] = args.model
    transport = OpenAICompatibleTransport(**transport_kwargs)

    if isinstance(environment, CodeTaskEnvironment):
        provider = CodeLLMMutationProvider.from_environment(
            environment,
            transport,
            temperature=args.temperature,
            max_iterations=LLM_MAX_ITERATIONS,
        )
    else:
        provider = LLMMutationProvider(
            transport=transport,
            temperature=args.temperature,
            max_iterations=LLM_MAX_ITERATIONS,
        )
    return MutationProviderAdapter(provider, name=f"llm:{transport.model}")


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _fmt_isolation(profile: dict[str, Any]) -> str:
    if not profile:
        return "(unrecorded)"
    if not profile.get("executed", True):
        return f"not executed ({profile.get('mechanism', 'unknown')})"
    return (
        f"{profile.get('mechanism', 'unknown')}"
        f" cpu={profile.get('cpu_limit_enforced', 'unknown')}"
        f" mem={profile.get('memory_limit_enforced', 'unknown')}"
        f" fs={profile.get('filesystem_isolated')}"
        f" net={profile.get('network_isolated')}"
    )


def _fmt_score(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.4f}"


def _fmt_delta(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.4f}"


def _json_emitter(payload: dict[str, Any], _lines: list[str]) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))


def _text_emitter(_payload: dict[str, Any], lines: list[str]) -> None:
    for line in lines:
        print(line)
