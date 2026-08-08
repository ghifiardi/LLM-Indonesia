"""Builds provenance-tracked training examples per the fine-tune design spec.

See docs/superpowers/specs/2026-07-20-tantular-productivity-finetune-design.md
("Provenance-tracked example schema") for the canonical schema this mirrors.
"""

import uuid


def make_example(
    task,
    split,
    family,
    messages,
    payload,
    generation,
    training,
    status,
    reject_reason=None,
    prompt_id=None,
    production_prompt_content_hash=None,
    production_prompt_git_sha=None,
):
    """Construct one provenance-tracked example dict matching the spec schema.

    Args mirror the schema's top-level/provenance fields directly:
    - task: "router" | "edit" | "prose:<pipeline>"
    - split: "train" | "eval" | "challenge"
    - family: document/scenario family id
    - messages: list of {role, content} chat messages
    - payload: task-native fields (source_document, instruction, ...)
    - generation: dict with teacher_model, renderer, bridge_protocol_version,
      bridge_js_commit, etc. (see spec)
    - training: dict with student_model, renderer, etc. (see spec)
    - status: "accepted" | "rejected"
    - reject_reason: None | "<code>"
    - prompt_id / production_prompt_content_hash / production_prompt_git_sha:
      optional registry-linkage fields, top-level in `provenance`.
    """
    return {
        "id": uuid.uuid4().hex,
        "task": task,
        "split": split,
        "family": family,
        "payload": payload,
        "messages": messages,
        "provenance": {
            "prompt_id": prompt_id,
            "production_prompt_content_hash": production_prompt_content_hash,
            "production_prompt_git_sha": production_prompt_git_sha,
            "generation": generation,
            "training": training,
            "status": status,
            "reject_reason": reject_reason,
        },
    }
