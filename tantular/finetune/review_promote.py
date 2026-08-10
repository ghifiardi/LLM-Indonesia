"""Review-queue promotion CLI: human accept/reject over `review_queue.jsonl`
entries, applied into the corpus WITHOUT regenerating anything (never calls
a teacher/judge/Tinker).

Per generate.py's module docstring, `run_generate` deliberately treats any
unresolved review-queue item as a loud failure because no promotion path
existed -- this module is that promotion path. It does three things:

1. `list`/`show`: read `review_queue.jsonl` (plain dicts -- see gen_router.py
   /gen_edit.py/gen_prose.py's `review_queue.append(...)` calls, which never
   attach an `id`, `messages`, or full `provenance`) and address each entry
   by a stable content-hash id (`queue_item_id`), since queue entries carry
   no id of their own and file position isn't stable across re-generation.
2. `accept`/`reject`: record a human decision durably in
   `review_decisions.json` (atomic write via temp-file + `os.replace`),
   keyed by that same content-hash id.
3. `apply`: for every decision not yet applied, "light reconstruction" --
   rebuild a full, provenance-complete training example from what the queue
   entry DOES carry (family, the axis-specific payload fields, and the
   `generation`/`prompt_id`/`production_prompt_content_hash`/
   `production_prompt_git_sha` block `generate._augment_review_entries`
   already attached) plus recomputable fields (`split`, via
   `families.assign_splits` off the SAME seed the run used; the system
   prompt CONTENT, via the same offline/free `BridgeClient.dump_prompts()`
   call `generate.main()` itself uses -- never Tinker, never a paid call).
   The result is schema-identical to a directly-accepted example (same
   `provenance` keys, same `generation`/`training` blocks) except
   `provenance.status`, which records HOW it was accepted/rejected
   (`provenance.STATUS_ACCEPTED_HUMAN_REVIEW` /
   `provenance.STATUS_REJECTED_HUMAN_REVIEW` -- see that module for the
   full status vocabulary and why promoted examples get their own status
   rather than reusing "accepted"/"rejected" verbatim).

Idempotent by construction: `apply` marks every processed decision with an
`applied_at` timestamp in `review_decisions.json` and skips anything already
applied, so re-running `apply` (e.g. after a crash, or just re-running the
same command) never appends a duplicate example. A newly-accepted item is
ALSO checked against `dedup.near_duplicates` (the same near-dup filter
`generate.run_generate`'s global pass uses) against every example already in
its target split file, so a promoted item that turns out to be a near-dup of
something already in the corpus doesn't quietly bloat it either.
"""

import argparse
import hashlib
import json
import pathlib
import sys
from datetime import datetime, timezone

from tantular.finetune.dedup import DEFAULT_THRESHOLD as DEFAULT_DEDUP_THRESHOLD
from tantular.finetune.dedup import near_duplicates
from tantular.finetune.families import assign_splits, enumerate_families
from tantular.finetune.generate import (
    ARTIFACT_FILENAMES,
    DEFAULT_DATA_DIR,
    DEFAULT_SEED,
    MANIFEST_FILENAME,
    REVIEW_QUEUE_FILENAME,
    _dedup_text,
    _read_jsonl,
    _write_jsonl,
)
from tantular.finetune.pilot import BRIDGE_PATH
from tantular.finetune.provenance import (
    STATUS_ACCEPTED_HUMAN_REVIEW,
    STATUS_REJECTED_HUMAN_REVIEW,
    make_example,
)

DECISIONS_FILENAME = "review_decisions.json"

# Mirrors gen_router.py/gen_edit.py/gen_prose.py's STUDENT_MODEL/
# STUDENT_RENDERER constants exactly. Each of those modules independently
# declares the same literal value (see their own docstrings/comments); this
# module follows that same convention -- reconstruction must record the SAME
# training target the corpus's other accepted examples record, not a
# different one just because it's a different module importing it.
STUDENT_MODEL = "Qwen/Qwen3-8B"
STUDENT_RENDERER = "qwen3_disable_thinking"


class ReviewPromoteError(RuntimeError):
    """Base error for this module."""


class UnknownItemError(ReviewPromoteError):
    """Raised when a caller addresses a review-queue item id that isn't (or
    is no longer) present in `review_queue.jsonl`."""


class PromptDriftError(ReviewPromoteError):
    """Raised by `reconstruct_example` when the CURRENT production prompt's
    content hash (from a live `BridgeClient.dump_prompts()`) no longer
    matches the `production_prompt_content_hash` recorded on the queue
    entry at generation time -- i.e. the prompt has changed since this item
    was judged, so reconstructing against today's prompt would silently
    misrepresent what the item was actually generated/judged against. Pass
    `allow_prompt_drift=True` to reconstruct against the current prompt
    anyway."""


# ---------------------------------------------------------------------------
# Queue item addressing.
# ---------------------------------------------------------------------------

def queue_item_id(entry):
    """Stable id for one review_queue.jsonl entry: a content hash (NOT a
    file-position index -- a future re-run of generation that appends more
    items would shift positions and silently reassign a decision already
    made for an old index to a different item). Deterministic: the same
    entry always yields the same id, on every re-read of an unmodified
    queue file.
    """
    canonical = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def load_review_queue(data_dir):
    """[(id, entry), ...] in file order. Missing `review_queue.jsonl` -> []
    (an empty/absent queue is not an error -- there may simply be nothing to
    review yet)."""
    path = pathlib.Path(data_dir) / REVIEW_QUEUE_FILENAME
    if not path.exists():
        return []
    return [(queue_item_id(entry), entry) for entry in _read_jsonl(path)]


def _find_item(data_dir, item_id):
    for qid, entry in load_review_queue(data_dir):
        if qid == item_id:
            return entry
    raise UnknownItemError(f"no review-queue item with id {item_id!r} in {data_dir}")


# ---------------------------------------------------------------------------
# Decisions file: durable, atomic-write, human accept/reject record.
# ---------------------------------------------------------------------------

def _decisions_path(data_dir):
    return pathlib.Path(data_dir) / DECISIONS_FILENAME


def load_decisions(data_dir):
    """id -> {"decision": "accept"|"reject", "note": str|None,
    "decided_at": iso8601, "applied_at": iso8601|None}. Missing file -> {}."""
    path = _decisions_path(data_dir)
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _save_decisions(data_dir, decisions):
    """Atomic write: write-to-temp-file + `Path.replace` (rename, atomic on
    POSIX) so a crash mid-write never leaves `review_decisions.json`
    truncated/corrupt -- the durability half of the idempotent-apply
    contract depends on this file never being partially written."""
    path = _decisions_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(decisions, indent=2, ensure_ascii=False, sort_keys=True))
    tmp.replace(path)


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def record_decision(data_dir, item_id, decision, note=None):
    """Record (or overwrite) a human accept/reject decision for `item_id`.
    Raises `UnknownItemError` if `item_id` isn't in the current
    `review_queue.jsonl`. Re-deciding an item that was already `apply`-ed
    does NOT reset `applied_at` (its earlier promotion/rejection stays on
    disk -- `apply` records what happened, it isn't retroactively undone by
    a later decision change; see module docstring)."""
    if decision not in ("accept", "reject"):
        raise ValueError(f"decision must be 'accept' or 'reject', got {decision!r}")
    _find_item(data_dir, item_id)
    decisions = load_decisions(data_dir)
    existing = decisions.get(item_id, {})
    decisions[item_id] = {
        "decision": decision,
        "note": note,
        "decided_at": _now_iso(),
        "applied_at": existing.get("applied_at"),
    }
    _save_decisions(data_dir, decisions)
    return decisions[item_id]


# ---------------------------------------------------------------------------
# Reconstruction: review_queue entry -> full provenance-tracked example.
# ---------------------------------------------------------------------------

def _axis_of_family(family_id):
    """"router:X::0000" -> "router"; "edit:X::0000" -> "edit";
    "prose:X::0000" -> "prose". Matches families.py's family id format
    ("<kind>::<index>", kind = "<axis>:<name>")."""
    return str(family_id).split(":", 1)[0]


def resolve_seed(data_dir, seed=None):
    """Explicit `seed` wins. Otherwise read `generation_manifest.json`'s
    "seed" (the same file `generate.run_generate` wrote alongside
    `review_queue.jsonl` -- the seed that actually produced this queue's
    family/split assignment). Falls back to `generate.DEFAULT_SEED` only if
    no manifest is present (e.g. a hand-built queue fixture in tests)."""
    if seed is not None:
        return seed
    manifest_path = pathlib.Path(data_dir) / MANIFEST_FILENAME
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if "seed" in manifest:
            return manifest["seed"]
    return DEFAULT_SEED


def _system_prompt_content(prompts, prompt_id, entry, *, allow_prompt_drift):
    prompt = prompts.get(prompt_id)
    if prompt is None:
        raise ReviewPromoteError(
            f"bridge has no prompt registered for id {prompt_id!r} "
            f"(family {entry.get('family')!r})"
        )
    recorded_hash = entry.get("production_prompt_content_hash")
    current_hash = prompt.get("contentHash")
    if recorded_hash and current_hash and recorded_hash != current_hash and not allow_prompt_drift:
        raise PromptDriftError(
            f"production prompt {prompt_id!r} content hash has changed since this "
            f"review-queue item (family {entry.get('family')!r}) was generated "
            f"(recorded {recorded_hash!r}, current {current_hash!r}). Reconstructing "
            "against today's prompt would misrepresent what this item was actually "
            "judged against -- pass allow_prompt_drift=True / --allow-prompt-drift "
            "to reconstruct against the CURRENT prompt anyway."
        )
    return prompt["content"]


def reconstruct_example(entry, *, split, prompts, status, reject_reason=None, allow_prompt_drift=False):
    """Rebuild a full provenance-tracked example (`provenance.make_example`
    shape) from a raw `review_queue.jsonl` entry -- "light reconstruction":
    everything not directly carried by `entry` is either recomputed
    (`messages`/`payload`, from the entry's own axis-specific fields, mirroring
    exactly how gen_router.py/gen_edit.py/gen_prose.py built them originally)
    or re-fetched from its recomputable source (`split` via
    `families.assign_splits`; the system prompt CONTENT via `prompts`, a
    `{prompt_id: {"content", "contentHash"}}` map as returned by
    `BridgeClient.dump_prompts()` -- offline, free, never Tinker).

    `status` is the caller's choice (STATUS_ACCEPTED_HUMAN_REVIEW /
    STATUS_REJECTED_HUMAN_REVIEW) -- the ONLY schema difference from a
    directly-generated example's provenance.
    """
    family_id = entry.get("family")
    if not family_id:
        raise ReviewPromoteError("review-queue entry has no 'family'; cannot reconstruct")
    axis = _axis_of_family(family_id)
    prompt_id = entry.get("prompt_id")
    if not prompt_id:
        raise ReviewPromoteError(
            f"review-queue entry for family {family_id!r} has no 'prompt_id' -- "
            "not augmented with provenance (see generate._augment_review_entries); "
            "cannot reconstruct"
        )
    generation_meta = entry.get("generation")
    if not generation_meta:
        raise ReviewPromoteError(
            f"review-queue entry for family {family_id!r} has no 'generation' block -- "
            "not augmented with provenance (see generate._augment_review_entries); "
            "cannot reconstruct"
        )

    system_prompt = _system_prompt_content(prompts, prompt_id, entry, allow_prompt_drift=allow_prompt_drift)
    training_meta = {"student_model": STUDENT_MODEL, "renderer": STUDENT_RENDERER}

    if axis == "router":
        task = "router"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": entry.get("message")},
            {"role": "assistant", "content": entry.get("intent")},
        ]
        payload = {
            "intent": entry.get("intent"),
            "cold_intent": entry.get("cold_intent"),
            "ambiguous": entry.get("ambiguous"),
        }
    elif axis == "edit":
        task = "edit"
        # Mirrors gen_edit.py's `_edit_messages` exactly.
        user = f"Dokumen:\n{entry.get('source_text')}\n\nInstruksi: {entry.get('instruction')}"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user},
            {"role": "assistant", "content": json.dumps({"edits": entry.get("edits")})},
        ]
        payload = {
            "source_text": entry.get("source_text"),
            "instruction": entry.get("instruction"),
            "edits": entry.get("edits"),
            "produced_text": entry.get("produced_text"),
            "judge_verdict": entry.get("judge_verdict"),
        }
    elif axis == "prose":
        task = prompt_id  # e.g. "prose:ringkas" -- matches gen_prose.py's `task=pipeline`.
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": entry.get("user_text")},
            {"role": "assistant", "content": entry.get("output")},
        ]
        payload = {"user_text": entry.get("user_text"), "output": entry.get("output")}
    else:
        raise ReviewPromoteError(f"unrecognized axis {axis!r} for family {family_id!r}")

    return make_example(
        task=task,
        split=split,
        family=family_id,
        messages=messages,
        payload=payload,
        generation=generation_meta,
        training=training_meta,
        status=status,
        reject_reason=reject_reason,
        prompt_id=prompt_id,
        production_prompt_content_hash=entry.get("production_prompt_content_hash"),
        production_prompt_git_sha=entry.get("production_prompt_git_sha"),
    )


# ---------------------------------------------------------------------------
# apply: reconstruct every not-yet-applied decision and write it into the
# corpus (accepted -> its resolved split file; rejected -> rejects.jsonl).
# ---------------------------------------------------------------------------

def apply_review_queue(
    data_dir,
    bridge,
    *,
    seed=None,
    dedup_threshold=DEFAULT_DEDUP_THRESHOLD,
    allow_prompt_drift=False,
    dry_run=False,
):
    """Apply every recorded-but-not-yet-applied decision in
    `review_decisions.json` against `review_queue.jsonl` in `data_dir`.

    - accept -> reconstructed (STATUS_ACCEPTED_HUMAN_REVIEW) example
      appended to its resolved split's artifact file (train/eval/challenge),
      UNLESS it's a near-duplicate (`dedup.near_duplicates`, same filter
      `generate.run_generate`'s global pass uses) of something already in
      that split -- then it's skipped and recorded as such, never appended.
    - reject -> reconstructed (STATUS_REJECTED_HUMAN_REVIEW) example
      appended to `rejects.jsonl` (never mixed into an accepted split --
      matches generate.py's "rejects.jsonl is a complete audit trail"
      philosophy).
    - already-applied decisions are skipped entirely (idempotent: re-running
      `apply` never appends a duplicate).
    - decisions whose id is no longer in the current queue are skipped
      (never crashes `apply`).

    `bridge`: a `BridgeClient`-shaped object exposing `.dump_prompts()` --
    injected, exactly like every other teacher/bridge dependency in this
    package (see generate.py/pilot.py) -- so tests never spawn the real
    Node subprocess unless they choose to.

    Returns a summary dict: {"promoted": [ids], "rejected_recorded": [ids],
    "skipped_duplicate": [ids], "already_applied": [ids], "pending": [ids]}.
    `dry_run=True` computes and returns the same summary without writing
    anything (decisions file included).
    """
    data_dir = pathlib.Path(data_dir)
    queue_by_id = dict(load_review_queue(data_dir))
    decisions = load_decisions(data_dir)
    resolved_seed = resolve_seed(data_dir, seed)
    assignments = assign_splits(enumerate_families(), resolved_seed)

    prompts = {p["id"]: p for p in bridge.dump_prompts()}

    result = {
        "promoted": [], "rejected_recorded": [], "skipped_duplicate": [],
        "already_applied": [], "pending": [],
    }

    existing_texts_by_split = {}
    for split_name in ("train", "eval", "challenge"):
        path = data_dir / ARTIFACT_FILENAMES[split_name]
        existing_texts_by_split[split_name] = (
            [_dedup_text(ex) for ex in _read_jsonl(path)] if path.exists() else []
        )

    to_append_by_split = {"train": [], "eval": [], "challenge": []}
    to_append_rejects = []

    for item_id, decision in decisions.items():
        if item_id not in queue_by_id:
            continue
        if decision.get("applied_at"):
            result["already_applied"].append(item_id)
            continue

        entry = queue_by_id[item_id]
        family_id = entry.get("family")
        split = assignments.get(family_id)
        if split is None:
            raise ReviewPromoteError(
                f"family {family_id!r} (item {item_id!r}) has no split assignment for "
                f"seed={resolved_seed!r} -- pass the correct --seed (see "
                "generation_manifest.json's \"seed\")"
            )

        if decision["decision"] == "accept":
            example = reconstruct_example(
                entry, split=split, prompts=prompts,
                status=STATUS_ACCEPTED_HUMAN_REVIEW,
                allow_prompt_drift=allow_prompt_drift,
            )
            text = _dedup_text(example)
            pool = (
                existing_texts_by_split[split]
                + [_dedup_text(e) for e in to_append_by_split[split]]
                + [text]
            )
            dup_indices = near_duplicates(pool, threshold=dedup_threshold)
            if (len(pool) - 1) in dup_indices:
                result["skipped_duplicate"].append(item_id)
            else:
                to_append_by_split[split].append(example)
                result["promoted"].append(item_id)
        else:
            example = reconstruct_example(
                entry, split=split, prompts=prompts,
                status=STATUS_REJECTED_HUMAN_REVIEW,
                reject_reason=f"human_review:{decision.get('note') or entry.get('reason') or 'no_note'}",
                allow_prompt_drift=allow_prompt_drift,
            )
            to_append_rejects.append(example)
            result["rejected_recorded"].append(item_id)

        decision["applied_at"] = _now_iso()

    for item_id in queue_by_id:
        if item_id not in decisions:
            result["pending"].append(item_id)

    if not dry_run:
        for split_name, new_examples in to_append_by_split.items():
            if not new_examples:
                continue
            path = data_dir / ARTIFACT_FILENAMES[split_name]
            existing = _read_jsonl(path) if path.exists() else []
            _write_jsonl(path, existing + new_examples)
        if to_append_rejects:
            path = data_dir / ARTIFACT_FILENAMES["rejects"]
            existing = _read_jsonl(path) if path.exists() else []
            _write_jsonl(path, existing + to_append_rejects)
        _save_decisions(data_dir, decisions)

    return result


# ---------------------------------------------------------------------------
# CLI: non-interactive, flag-driven. `list`/`show`/`accept`/`reject` never
# touch the bridge/Node (pure file I/O against review_queue.jsonl +
# review_decisions.json); `apply` is the only subcommand that spawns the
# (offline, free) bridge subprocess.
# ---------------------------------------------------------------------------

def _prompt_response_text(entry, axis):
    if axis == "router":
        return entry.get("message"), entry.get("intent")
    if axis == "edit":
        return entry.get("instruction"), entry.get("produced_text")
    if axis == "prose":
        return entry.get("user_text"), entry.get("output")
    return "", ""


def _truncate(text, n=100):
    text = str(text or "").replace("\n", " ")
    return text if len(text) <= n else text[: n - 1] + "…"


def _print_list(data_dir):
    queue = load_review_queue(data_dir)
    decisions = load_decisions(data_dir)
    if not queue:
        print("(review queue is empty)")
        return
    for item_id, entry in queue:
        axis = _axis_of_family(entry.get("family", ""))
        prompt_text, response_text = _prompt_response_text(entry, axis)
        decision = decisions.get(item_id)
        status = decision["decision"] if decision else "pending"
        applied = " (applied)" if decision and decision.get("applied_at") else ""
        print(f"{item_id}  [{status}{applied}]  family={entry.get('family')}  reason={entry.get('reason')}")
        print(f"    prompt:   {_truncate(prompt_text)}")
        print(f"    response: {_truncate(response_text)}")


def _build_arg_parser():
    parser = argparse.ArgumentParser(prog="tantular.finetune.review_promote")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list every review-queue item and its current decision")

    p_show = sub.add_parser("show", help="show one review-queue item in full")
    p_show.add_argument("id")

    p_accept = sub.add_parser("accept", help="record an accept decision for an item")
    p_accept.add_argument("id")
    p_accept.add_argument("--note", default=None)

    p_reject = sub.add_parser("reject", help="record a reject decision for an item")
    p_reject.add_argument("id")
    p_reject.add_argument("--note", default=None)

    p_apply = sub.add_parser("apply", help="apply every not-yet-applied decision into the corpus")
    p_apply.add_argument("--seed", type=int, default=None)
    p_apply.add_argument("--dedup-threshold", type=float, default=DEFAULT_DEDUP_THRESHOLD)
    p_apply.add_argument("--allow-prompt-drift", action="store_true")
    p_apply.add_argument("--dry-run", action="store_true")
    p_apply.add_argument("--node-bin", default="node")

    return parser


def main(argv=None):
    args = _build_arg_parser().parse_args(argv)
    data_dir = pathlib.Path(args.data_dir)

    if args.command == "list":
        _print_list(data_dir)
        return 0

    if args.command == "show":
        try:
            entry = _find_item(data_dir, args.id)
        except UnknownItemError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        decisions = load_decisions(data_dir)
        print(json.dumps(
            {"id": args.id, "entry": entry, "decision": decisions.get(args.id)},
            indent=2, ensure_ascii=False,
        ))
        return 0

    if args.command in ("accept", "reject"):
        try:
            record_decision(data_dir, args.id, args.command, note=args.note)
        except UnknownItemError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        verb = "accepted" if args.command == "accept" else "rejected"
        print(f"{verb} {args.id}")
        return 0

    if args.command == "apply":
        from tantular.finetune.bridge_client import BridgeClient

        try:
            with BridgeClient(str(BRIDGE_PATH), node_bin=args.node_bin) as bridge:
                result = apply_review_queue(
                    data_dir, bridge,
                    seed=args.seed,
                    dedup_threshold=args.dedup_threshold,
                    allow_prompt_drift=args.allow_prompt_drift,
                    dry_run=args.dry_run,
                )
        except ReviewPromoteError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        print(f"promoted: {len(result['promoted'])}")
        print(f"rejected_recorded: {len(result['rejected_recorded'])}")
        print(f"skipped_duplicate: {len(result['skipped_duplicate'])}")
        print(f"already_applied: {len(result['already_applied'])}")
        print(f"pending (no decision yet): {len(result['pending'])}")
        if args.dry_run:
            print("(dry run -- nothing written)")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
