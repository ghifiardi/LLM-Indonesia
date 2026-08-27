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
from .anchors import ANCHORS_DIR_ENV_VAR, is_development_anchor_location
from . import states
from . import budget as budget_module
from .anchors import ThresholdError, load_thresholds, resolve_anchors_dir
from .freeze import FrozenError, UnfreezeError, active_freeze, freeze, unfreeze
from . import canary as canary_module
from .gate import GateError, evaluate_gate
from .rollback import RollbackError, assess_ancestors, rollback
from . import serve as serve_module
from . import readiness as readiness_module
from . import spool as spool_module
from . import supervisor as supervisor_module
from .audit import (
    DEFAULT_BATCH_LIMIT,
    AuditError,
    audit_all_unaudited as audit_batch,
    run_audit,
)
from ..code_llm_mutator import CodeLLMMutationProvider
from ..llm_mutator import LLMMutationProvider, OpenAICompatibleTransport
from .archive import CandidateArchive
from .experience import ExperienceLog, KNOWN_OUTCOMES
from .models import AUDIT_OK, SCORED_STATUSES
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
from .runner import SubprocessCandidateRunner
from .store import (
    CONFIG_DATASET_IDENTITY,
    new_id,
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
EXIT_FROZEN = 3

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
    init_parser.add_argument(
        "--anchors-dir",
        default=None,
        help=(
            "Human-owned evaluation source. Defaults to $" + ANCHORS_DIR_ENV_VAR
            + ", then the package eval_sets/ (development only)."
        ),
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

    audit_parser = subparsers.add_parser(
        "audit",
        help="Audit one candidate against the holdout. Informational; never promotes.",
    )
    audit_parser.add_argument("candidate_id", nargs="?", default=None)
    audit_parser.add_argument(
        "--anchors-dir",
        default=None,
        help="Human-owned evaluation source. Must match the source used at init.",
    )
    audit_parser.add_argument("--timeout", type=float, default=300.0)
    audit_parser.add_argument(
        "--all-unaudited",
        action="store_true",
        dest="all_unaudited",
        help=(
            "Audit every candidate lacking a passing audit of its artifact against "
            "the current dataset. Serial and bounded; runs even while frozen."
        ),
    )
    audit_parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Batch cap. Defaults to a bounded value; anything skipped is reported.",
    )

    gate_parser = subparsers.add_parser(
        "gate",
        help="Evaluate the promotion gate for a candidate. Records a verdict; never promotes.",
    )
    gate_parser.add_argument("candidate_id")
    gate_parser.add_argument("--anchors-dir", default=None)

    promote_parser = subparsers.add_parser(
        "promote", help="Make an archived candidate the champion. Human-invoked only."
    )
    promote_parser.add_argument("candidate_id")
    promote_parser.add_argument("--reason", required=True, help="Why this candidate is promoted.")
    promote_parser.add_argument("--actor", default="", help="Who approved the promotion.")
    promote_parser.add_argument(
        "--anchors-dir", default=None, help="Anchor source for gate thresholds."
    )
    promote_parser.add_argument(
        "--gate-verdict-id",
        default=None,
        help="Reuse an existing verdict. Refused if stale; omit to evaluate fresh.",
    )

    freeze_parser = subparsers.add_parser(
        "freeze", help="Stop reflection and promotion. Idempotent; audit and rollback continue."
    )
    freeze_parser.add_argument("--reason", required=True)
    freeze_parser.add_argument("--actor", default="")

    unfreeze_parser = subparsers.add_parser(
        "unfreeze", help="Clear the active freeze, acknowledging it by id."
    )
    unfreeze_parser.add_argument("--reason", required=True)
    unfreeze_parser.add_argument(
        "--expected-event-id",
        required=True,
        dest="expected_event_id",
        help="Id of the freeze being cleared. Refused if it is not the active one.",
    )
    unfreeze_parser.add_argument("--actor", default="")

    rollback_parser = subparsers.add_parser(
        "rollback", help="Revert the champion to its best safe ancestor. Works while frozen."
    )
    rollback_parser.add_argument("--reason", required=True)
    rollback_parser.add_argument("--actor", default="")
    rollback_parser.add_argument("--anchors-dir", default=None)
    rollback_parser.add_argument(
        "--to", default=None, dest="target", help="Roll back to this ancestor specifically."
    )
    rollback_parser.add_argument(
        "--dry-run", action="store_true", help="Show which ancestors qualify and stop."
    )

    serve_parser = subparsers.add_parser(
        "serve", help="Answer queries from the champion. Read-only; modifies nothing."
    )
    serve_parser.add_argument("--anchors-dir", default=None)

    ask_parser = subparsers.add_parser("ask", help="Send one query to a running `serve`.")
    ask_parser.add_argument("query")
    ask_parser.add_argument("--timeout", type=float, default=60.0)

    subparsers.add_parser(
        "ingest", help="Drain the serving spool into the database."
    )

    canary_parser = subparsers.add_parser(
        "canary", help="Route a slice of traffic to a candidate, or stop doing so."
    )
    canary_sub = canary_parser.add_subparsers(dest="canary_command", required=True)
    canary_set = canary_sub.add_parser("set", help="Activate a canary. Blocked while frozen.")
    canary_set.add_argument("candidate_id")
    canary_set.add_argument("--percent", type=int, required=True)
    canary_set.add_argument("--reason", required=True)
    canary_set.add_argument("--actor", default="")
    canary_set.add_argument("--anchors-dir", default=None)
    canary_clear = canary_sub.add_parser("clear", help="Stop routing traffic to the canary.")
    canary_clear.add_argument("--reason", required=True)
    canary_clear.add_argument("--actor", default="")
    canary_sub.add_parser("status", help="Show the active canary, if any.")

    supervise_parser = subparsers.add_parser(
        "supervise",
        help="Own the champion pointer and drive the reflect and audit clocks.",
    )
    supervise_parser.add_argument("--anchors-dir", default=None)
    supervise_parser.add_argument("--poll-interval", type=float, default=0.5)
    supervise_parser.add_argument(
        "--max-ticks", type=int, default=None, help="Stop after this many ticks."
    )
    supervise_parser.add_argument(
        "--no-serve",
        action="store_true",
        help="Do not start or own a serve child; drive the clocks only.",
    )

    readiness_parser = subparsers.add_parser(
        "readiness",
        help="Evidence for a human decision. Advisory; nothing reads it to authorise anything.",
    )
    readiness_sub = readiness_parser.add_subparsers(dest="readiness_command", required=True)

    drill_parser = readiness_sub.add_parser(
        "drill", help="Run drills in isolated state directories."
    )
    drill_parser.add_argument("--only", action="append", default=None, dest="only")
    drill_parser.add_argument("--anchors-dir", default=None)

    report_parser = readiness_sub.add_parser("report", help="Render the readiness report.")
    report_parser.add_argument("--anchors-dir", default=None)
    report_parser.add_argument(
        "--no-record", action="store_true", help="Render without storing the report."
    )

    label_parser = readiness_sub.add_parser(
        "label", help="Record a human judgement on one suppressed answer."
    )
    label_parser.add_argument("request_id")
    group = label_parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--false-veto", action="store_true", dest="false_veto")
    group.add_argument("--true-veto", action="store_true", dest="true_veto")
    label_parser.add_argument("--actor", default="")
    label_parser.add_argument("--note", default="")

    reproduce_parser = readiness_sub.add_parser(
        "reproduce",
        help="Re-run the served artifact against the stored query, in the isolated runner.",
    )
    reproduce_parser.add_argument("request_id")

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
    except FrozenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FROZEN
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
            anchors_dir=args.anchors_dir,
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
        "  holdout    not evaluated here; run `audit` for an isolated holdout check",
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
        "audits": store.count_audits(),
        "champion_audit_current": None,
        "frozen": None,
        "budget": None,
        "holdout_evaluated": False,
        "auto_promotion": "not implemented",
    }

    current_freeze = active_freeze(store)
    payload["frozen"] = current_freeze.to_dict() if current_freeze is not None else None
    budget_view = None
    try:
        _ti, _gt, budget_limits = load_thresholds(resolve_anchors_dir(None))
        budget_view = budget_module.snapshot(store, budget_limits)
        payload["budget"] = budget_view.to_dict()
    except ThresholdError as exc:
        payload["budget"] = {"error": str(exc)}

    champion_audit = None
    if champion is not None:
        from .gate import current_audit

        champion_audit = current_audit(
            store,
            champion.candidate_id,
            champion.artifact_hash,
            json.loads(store.get_config(CONFIG_DATASET_IDENTITY) or "{}"),
        )
        payload["champion_audit_current"] = (
            champion_audit.audit_run_id if champion_audit is not None else None
        )

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
            f"audits        {store.count_audits()} holdout audit(s)",
            "champion aud  "
            + (
                f"current ({champion_audit.audit_run_id[:12]}, "
                f"holdout {_fmt_score(champion_audit.holdout_score)}, "
                f"{champion_audit.safety_failure_count} safety failure(s))"
                if champion_audit is not None
                else "MISSING - promotion is blocked until "
                f"`resident audit {champion.candidate_id[:12]}` runs"
            ),
            "holdout       never loaded in this process; audits run isolated",
            f"state         {store.candidate_state(champion.candidate_id) or '(none)'}",
            "promotion     manual only, gated",
            "frozen        "
            + (
                f"YES {current_freeze.freeze_id} - {current_freeze.reason}"
                if current_freeze is not None
                else "no"
            ),
            "canary        "
            + (
                f"{_canary_line(store)}"
            ),
            "budget        "
            + (
                ", ".join(
                    f"{k}={v}/{budget_view.limits[budget_module.COUNTER_LIMITS[k]]}"
                    for k, v in sorted(budget_view.counts.items())
                )
                + f" (window {budget_view.window})"
                if budget_view is not None
                else "unavailable"
            ),
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
    state = store.candidate_state(candidate.candidate_id)
    verdicts = store.list_gate_verdicts(candidate_id=candidate.candidate_id)
    payload["state"] = state
    payload["gate_verdicts"] = [v.to_dict() for v in verdicts]
    audits = store.list_audits(candidate_id=candidate.candidate_id)
    payload["audits"] = [record.to_dict() for record in audits]
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
        f"  state    {state or '(none)'}",
        f"  gates    {len(verdicts)} evaluation(s)"
        + (f", latest {'PASS' if verdicts[0].passed else 'REFUSED'}" if verdicts else ""),
        f"  audits   {len(audits)} (evidence for the gate; never promote by themselves)",
    ]
    if verdicts:
        for veto in verdicts[0].failures():
            lines.append(f"    gate FAIL {veto.name}: {veto.detail}")
    for record in audits:
        lines.append(
            f"    - {record.created_at} {record.status} "
            f"holdout={_fmt_score(record.holdout_score)} n={record.num_cases}"
        )
    for reason in candidate.verdict.reasons:
        lines.append(f"  - {reason}")
    if code:
        lines.append("")
        lines.append(code.rstrip())
    emit(payload, lines)
    return EXIT_OK


def _cmd_canary(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    if args.canary_command == "status":
        pointer = canary_module.active_pointer(store)
        if pointer is None:
            emit({"canary": None}, ["no active canary"])
            return EXIT_OK
        breaches = canary_module.recent_breaches(store, pointer, 3600)
        emit(
            {"canary": pointer.public_dict(), "recent_breaches": breaches},
            [
                f"canary {pointer.candidate_id}",
                f"  activation  {pointer.activation_id}",
                f"  percent     {pointer.percent}%",
                f"  since       {pointer.activated_at}",
                f"  breaches    {breaches} in the last hour",
            ],
        )
        return EXIT_OK

    if args.canary_command == "clear":
        try:
            delegated = _delegate_if_supervised(
                store,
                {"command": "canary_clear", "reason": args.reason, "actor": args.actor},
            )
        except supervisor_module.SupervisorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        if delegated is not None:
            if not delegated.get("ok"):
                print(f"error: {delegated.get('error')}", file=sys.stderr)
                return EXIT_ERROR
            emit(delegated, [f"cleared via the supervisor: {delegated.get('cleared')}"])
            return EXIT_OK
        activation_id = canary_module.clear(store, reason=args.reason, actor=args.actor)
        if activation_id is None:
            emit({"cleared": None}, ["no active canary to clear"])
            return EXIT_OK
        emit({"cleared": activation_id}, [f"cleared canary activation {activation_id}"])
        return EXIT_OK

    try:
        delegated = _delegate_if_supervised(
            store,
            {
                "command": "canary_set",
                "candidate_id": args.candidate_id,
                "percent": args.percent,
                "reason": args.reason,
                "actor": args.actor,
            },
        )
    except supervisor_module.SupervisorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    if delegated is not None:
        if not delegated.get("ok"):
            print(f"error: {delegated.get('error')}", file=sys.stderr)
            return EXIT_ERROR
        emit(delegated, [f"canary set via the supervisor: {delegated.get('canary')}"])
        return EXIT_OK

    try:
        pointer = canary_module.activate(
            store,
            args.candidate_id,
            percent=args.percent,
            reason=args.reason,
            actor=args.actor,
            anchors_dir=args.anchors_dir,
        )
    except canary_module.CanaryError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    assert pointer is not None
    emit(
        pointer.public_dict(),
        [
            f"canary {pointer.candidate_id} serving {pointer.percent}% of traffic",
            f"  activation  {pointer.activation_id}",
            "",
            "The champion is unchanged. A canary that breaches its hard vetoes is",
            "cleared automatically and the resident freezes; the champion is never",
            "moved without a human.",
        ],
    )
    return EXIT_OK


def _cmd_supervise(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    state_dir = store.state_dir
    store.close()
    supervisor = supervisor_module.Supervisor(
        state_dir,
        anchors_dir=args.anchors_dir,
        poll_interval=args.poll_interval,
        manage_serve=not args.no_serve,
    )
    print(f"supervising {state_dir}", file=sys.stderr)
    print(
        "owns the champion pointer; reflect and audit run as one-shot children.",
        file=sys.stderr,
    )
    if not args.no_serve:
        print("starting and supervising a serve child.", file=sys.stderr)
    try:
        supervisor.run(max_ticks=args.max_ticks)
    except KeyboardInterrupt:
        pass
    except (supervisor_module.SupervisorError, ResidentError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    finally:
        supervisor.close()
    return EXIT_OK


def _delegate_if_supervised(
    store: ResidentStore, message: dict[str, Any]
) -> dict[str, Any] | None:
    """Route a pointer-changing command to the supervisor, if one owns this state.

    While a supervisor holds the lock it is the single writer of the champion
    pointer, so the CLI asks it rather than writing alongside it. With no
    supervisor running, direct operation is still available — that is what
    makes offline use possible.
    """

    active = supervisor_module.active_supervisor(store.state_dir)
    if active is None:
        return None
    socket_path = active.get("control_socket")
    if not socket_path:
        raise supervisor_module.SupervisorError(
            "A supervisor owns this state directory but published no control socket."
        )
    return supervisor_module.call_control(Path(socket_path), message)


def _cmd_audit(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    if args.all_unaudited:
        report = audit_batch(
            store,
            anchors_dir=args.anchors_dir,
            limit=args.limit if args.limit is not None else DEFAULT_BATCH_LIMIT,
            timeout_seconds=args.timeout,
        )
        lines = [
            f"audited {report.succeeded}/{report.attempted} candidate(s)",
            f"  failed            {report.failed}",
            f"  already audited   {report.already_audited}",
            f"  not auditable     {report.not_auditable}",
            f"  skipped over limit {report.skipped_over_limit}",
        ]
        if report.skipped_over_limit:
            lines.append("")
            lines.append(
                f"{report.skipped_over_limit} candidate(s) were not audited this run. "
                "Raise --limit or run again."
            )
        emit(report.to_dict(), lines)
        return EXIT_OK if report.failed == 0 else EXIT_ERROR

    if not args.candidate_id:
        print("error: a candidate id is required unless --all-unaudited is given",
              file=sys.stderr)
        return EXIT_ERROR
    try:
        outcome = run_audit(
            store,
            args.candidate_id,
            anchors_dir=args.anchors_dir,
            timeout_seconds=args.timeout,
        )
    except AuditError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    record = outcome.record
    lines = [
        f"audit {record.audit_run_id}",
        f"  candidate  {record.candidate_id}",
        f"  status     {record.status}",
        f"  holdout    {_fmt_score(record.holdout_score)} over {record.num_cases} case(s)",
        f"  safety     {record.safety_failure_count} case(s) below the safety floor",
        f"  dataset    {(record.dataset_identity.get('manifest_hash') or '(none)')[:12]}"
        f" seed={record.dataset_identity.get('split_seed', '?')}",
        f"  isolation  {_fmt_isolation(record.isolation)}",
    ]
    if record.detail:
        lines.append(f"  detail     {record.detail}")
    if outcome.development_anchors:
        lines.append("")
        lines.append(
            "note: anchors read from the package eval_sets/ (development default). "
            f"Set --anchors-dir or ${ANCHORS_DIR_ENV_VAR} for real use."
        )
    lines.append("")
    lines.append(
        "Informational only: this audit changed no champion and gates no promotion."
    )
    emit(record.to_dict(), lines)
    return EXIT_OK if record.status == AUDIT_OK else EXIT_ERROR


def _render_verdict(verdict: Any) -> list[str]:
    lines = [
        f"gate {verdict.gate_verdict_id}",
        f"  candidate  {verdict.candidate_id}",
        f"  champion   {verdict.champion_candidate_id or '(none)'}",
        f"  result     {'PASS' if verdict.passed else 'REFUSED'}",
    ]
    for veto in verdict.vetoes:
        if not veto.applicable:
            mark = "n/a "
        elif not veto.evaluable:
            mark = "??  "
        else:
            mark = "ok  " if veto.passed else "FAIL"
        lines.append(f"    [{mark}] {veto.name}{(' - ' + veto.detail) if veto.detail else ''}")
    return lines


def _cmd_gate(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    try:
        verdict = evaluate_gate(store, args.candidate_id, anchors_dir=args.anchors_dir)
    except GateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    lines = _render_verdict(verdict)
    lines.append("")
    lines.append("Evaluating the gate promotes nothing. Run `promote` to act on a pass.")
    emit(verdict.to_dict(), lines)
    return EXIT_OK if verdict.passed else EXIT_ERROR


def _cmd_promote(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    try:
        delegated = _delegate_if_supervised(
            store,
            {
                "command": "promote",
                "candidate_id": args.candidate_id,
                "reason": args.reason,
                "actor": args.actor,
            },
        )
    except supervisor_module.SupervisorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    if delegated is not None:
        if not delegated.get("ok"):
            print(f"error: {delegated.get('error')}", file=sys.stderr)
            return EXIT_ERROR
        emit(delegated, [f"promoted via the supervisor: {delegated.get('champion')}"])
        return EXIT_OK
    try:
        champion = promote(
            store,
            args.candidate_id,
            reason=args.reason,
            actor=args.actor,
            anchors_dir=args.anchors_dir,
            gate_verdict_id=args.gate_verdict_id,
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


def _cmd_freeze(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    existing = active_freeze(store)
    record = freeze(store, reason=args.reason, actor=args.actor)
    already = existing is not None and existing.freeze_id == record.freeze_id
    emit(
        record.to_dict(),
        [
            ("already frozen" if already else "frozen") + f" {record.freeze_id}",
            f"  since   {record.created_at}",
            f"  reason  {record.reason}",
            f"  actor   {record.actor or '(unrecorded)'}",
            "",
            "`reflect-once` and `promote` are blocked. `audit` and `rollback` still work.",
            f"To clear: resident unfreeze --reason \"...\" --expected-event-id {record.freeze_id}",
        ],
    )
    return EXIT_OK


def _cmd_unfreeze(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    try:
        record = unfreeze(
            store,
            reason=args.reason,
            expected_freeze_id=args.expected_event_id,
            actor=args.actor,
        )
    except UnfreezeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    emit(
        record.to_dict(),
        [
            f"unfroze {record.freeze_id}",
            f"  original reason  {record.reason}",
            f"  cleared because  {args.reason}",
            f"  actor            {args.actor or '(unrecorded)'}",
            "",
            "The freeze record is preserved, not deleted.",
        ],
    )
    return EXIT_OK


def _cmd_rollback(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    if not args.dry_run:
        try:
            delegated = _delegate_if_supervised(
                store,
                {
                    "command": "rollback",
                    "reason": args.reason,
                    "actor": args.actor,
                    "target": args.target,
                },
            )
        except supervisor_module.SupervisorError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        if delegated is not None:
            if not delegated.get("ok"):
                print(f"error: {delegated.get('error')}", file=sys.stderr)
                return EXIT_ERROR
            emit(delegated, [f"rolled back via the supervisor: {delegated.get('champion')}"])
            return EXIT_OK
    if args.dry_run:
        assessments = assess_ancestors(store, anchors_dir=args.anchors_dir)
        lines = [f"{len(assessments)} ancestor(s) of the current champion"]
        for item in assessments:
            mark = "safe" if item.safe else "no  "
            lines.append(
                f"  [{mark}] {item.candidate.candidate_id[:12]} "
                f"{_fmt_score(item.candidate.public_score)}"
                + (f" - {item.reason}" if item.reason else "")
            )
        emit({"ancestors": [
            {"candidate_id": a.candidate.candidate_id, "safe": a.safe, "reason": a.reason,
             "public_score": a.candidate.public_score}
            for a in assessments
        ]}, lines)
        return EXIT_OK

    try:
        champion = rollback(
            store,
            reason=args.reason,
            actor=args.actor,
            anchors_dir=args.anchors_dir,
            target_candidate_id=args.target,
        )
    except RollbackError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    current = active_freeze(store)
    lines = [
        f"rolled back to {champion.candidate_id}",
        f"  from      {champion.previous_candidate_id}",
        f"  artifact  {champion.artifact_hash}",
        f"  reason    {args.reason}",
    ]
    if current is not None:
        lines.append("")
        lines.append(
            f"Still frozen ({current.freeze_id}). Rolling back does not clear a freeze; "
            "unfreeze explicitly when the cause is understood."
        )
    emit(champion.to_dict(), lines)
    return EXIT_OK


def _cmd_serve(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    # The command-level store is closed first: the serving process opens its
    # own read-only connection and must not inherit a writable one.
    state_dir = store.state_dir
    store.close()
    try:
        socket_path = serve_module.prepare_socket_path(state_dir)
        context = serve_module.build_context(state_dir, anchors_dir=args.anchors_dir)
    except (serve_module.ServeError, ResidentError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    print(f"serving {state_dir} on {socket_path}", file=sys.stderr)
    print("read-only: this process cannot promote, freeze, or modify state.", file=sys.stderr)
    try:
        serve_module.serve_forever(context, socket_path)
    except KeyboardInterrupt:
        pass
    except serve_module.ServeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_OK


def _cmd_ask(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    socket_path = serve_module.runtime_dir_for(store.state_dir) / "serve.sock"
    if not socket_path.exists():
        print(f"error: no serving process at {socket_path}", file=sys.stderr)
        return EXIT_ERROR
    try:
        response = serve_module.ask(socket_path, args.query, timeout=args.timeout)
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    lines = [response.get("answer") or f"error: {response.get('error')}"]
    if response.get("fallback_used"):
        lines.append("")
        lines.append("(safe fallback: the policy output was withheld)")
    emit(response, lines)
    return EXIT_OK if response.get("ok") else EXIT_ERROR


def _cmd_ingest(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    report = spool_module.ingest(store)
    emit(
        report.to_dict(),
        [
            f"ingested {report.inserted} record(s) from {report.files} spool file(s)",
            f"  duplicates   {report.duplicates}",
            f"  quarantined  {report.quarantined}",
        ],
    )
    return EXIT_OK


def _cmd_readiness(store: ResidentStore, args: argparse.Namespace, emit: Any) -> int:
    if args.readiness_command == "drill":
        try:
            runs = readiness_module.run_drills(
                store, resolve_anchors_dir(args.anchors_dir), only=args.only
            )
        except (ValueError, ResidentError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_ERROR
        lines = [f"ran {len(runs)} drill(s) in isolated state directories"]
        for run in runs:
            lines.append(f"  [{run.result.outcome:>19}]  {run.result.name}")
            if run.result.detail:
                lines.append(f"                         {run.result.detail[:80]}")
        lines.append("")
        lines.append("A drill proves the mechanism works here. It does not prove")
        lines.append("production used it — that is what the observations are for.")
        emit({"drills": [run.to_dict() for run in runs]}, lines)
        return EXIT_OK if all(r.result.outcome == readiness_module.PASS for r in runs) else EXIT_ERROR

    if args.readiness_command == "report":
        report = readiness_module.generate(
            store, anchors_dir=args.anchors_dir, record=not args.no_record
        )
        emit(report.to_dict(), readiness_module.render(report).splitlines())
        return EXIT_OK if report.verdict == readiness_module.PASS else EXIT_ERROR

    if args.readiness_command == "label":
        rows = [
            row for row in store.list_serving_vetoes()
            if row.get("request_id") == args.request_id
        ]
        if not rows:
            print(f"error: no veto observation for request {args.request_id!r}",
                  file=sys.stderr)
            return EXIT_ERROR
        row = rows[0]
        inserted = store.insert_veto_label(
            {
                "label_id": new_id(),
                "request_id": args.request_id,
                # Scoped to what was actually served: a judgement about one
                # artifact's output says nothing about a different one.
                "artifact_hash": row["artifact_hash"],
                "veto": row["veto"],
                "label": "false_veto" if args.false_veto else "true_veto",
                "actor": args.actor,
                "note": args.note,
            }
        )
        if not inserted:
            print("error: this request is already labelled; labels are immutable",
                  file=sys.stderr)
            return EXIT_ERROR
        emit(
            {"request_id": args.request_id, "label": "false_veto" if args.false_veto else "true_veto"},
            [f"labelled {args.request_id} as "
             + ("a false veto" if args.false_veto else "a true veto")],
        )
        return EXIT_OK

    # reproduce
    requests = [
        row for row in store.list_served_requests() if row["request_id"] == args.request_id
    ]
    if not requests:
        print(f"error: no served request {args.request_id!r}", file=sys.stderr)
        return EXIT_ERROR
    request = requests[0]
    experiences = [
        experience for experience in store.list_experiences()
        if experience.experience_id == args.request_id
    ]
    if not experiences:
        print("error: the query for that request was not retained", file=sys.stderr)
        return EXIT_ERROR

    vetoes = [row for row in store.list_serving_vetoes()
              if row.get("request_id") == args.request_id]
    artifact_hash = vetoes[0]["artifact_hash"] if vetoes else request["served_artifact_hash"]
    if not artifact_hash:
        print("error: no artifact is associated with that request", file=sys.stderr)
        return EXIT_ERROR

    from ..dataset_env import DEFAULT_KB

    runner = SubprocessCandidateRunner()
    outcome = runner.execute_one(
        policy_source=store.read_artifact(artifact_hash),
        artifact_hash=artifact_hash,
        query=experiences[0].query,
        kb=DEFAULT_KB,
    )
    emit(
        {"request_id": args.request_id, "artifact_hash": artifact_hash,
         "output": outcome.output, "status": outcome.status},
        [
            f"reproduced {args.request_id} against artifact {artifact_hash[:12]}",
            f"  query   {experiences[0].query[:100]}",
            f"  status  {outcome.status or 'ok'}",
            "",
            outcome.output or "(no output)",
            "",
            "Reproduced in the isolated runner, never on the serving path.",
            "Nothing was retained: this is the artifact re-run on demand.",
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
    "audit": _cmd_audit,
    "gate": _cmd_gate,
    "freeze": _cmd_freeze,
    "unfreeze": _cmd_unfreeze,
    "rollback": _cmd_rollback,
    "serve": _cmd_serve,
    "ask": _cmd_ask,
    "ingest": _cmd_ingest,
    "supervise": _cmd_supervise,
    "canary": _cmd_canary,
    "readiness": _cmd_readiness,
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


def _canary_line(store: ResidentStore) -> str:
    try:
        pointer = canary_module.active_pointer(store)
    except ResidentError as exc:
        return f"unreadable ({exc})"
    if pointer is None:
        return "none"
    return f"{pointer.candidate_id[:12]} at {pointer.percent}%"


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
