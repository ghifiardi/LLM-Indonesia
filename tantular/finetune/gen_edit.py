"""Edit-contract dataset generator: known-target reconstruction.

Per the design spec (docs/superpowers/specs/2026-07-20-tantular-productivity-
finetune-design.md, "Edit" under "Per-task generation and validation"):

    Clean target document -> controlled corruption -> instruction -> teacher
    emits edit JSON -> accepted ONLY if applying the edits to the corrupted
    text reconstructs the clean target.

This module NEVER reimplements edit-contract parsing/resolution/application
in Python -- every acceptance decision that depends on that logic goes
through `BridgeClient.validate_edit`, which calls the REAL
`parseEditContract` / `resolveEdits` / `applyEditsToText` from the add-in
(tantular_office_addin/src/chat/editContract.js,
tantular_office_addin/src/chat/applyEdits.js). This module only adds the
*semantic* guards the spec requires on top of that oracle (no-op, overlap,
duplicate target, excessive deletion, protected name/number drift,
instruction-category mismatch) plus the corruption/generation harness.

Not every edit subtype has a synthesizable known target: "koreksi" (spelling
fix), "ubah_istilah" (number/name-preserving terminology substitution -- here
used as a number-or-name corruption), and "restrukturisasi" (word-order fix)
all admit a controlled corruption with a known clean target to reconstruct.
"perjelas" (clarity rewrite), "elaborasi" (elaboration/expansion), and
"ringkas_bagian" (condensation) do not -- there is no single deterministic
"clean" version of a clarity rewrite. For those, `generate_edit` falls back
to the validator (structural/semantic guards via the bridge) plus an
injectable judge, and ALWAYS samples the result into a human-review queue --
never auto-accepted, per the spec's "known target OR validator+judge with
human sampling" split.

Teacher access is always injected (constructor/function parameter) -- this
module never calls Tinker at import time, and tests only ever pass a
deterministic stub. `TinkerEditTeacher` is a real implementation, but all
`tinker`/`tinker_cookbook` imports inside it are lazy (inside methods), so
merely importing this module, or constructing a `TinkerEditTeacher`, costs
nothing and touches no network.
"""

import hashlib
import json
import random
import re

from tantular.finetune.provenance import make_example

# Teacher: same model/renderer as gen_router.py / the sentinel export spike.
TEACHER_MODEL = "Qwen/Qwen3.5-397B-A17B"
TEACHER_RENDERER = "qwen3_5_disable_thinking"

# Student: the fine-tune target, per the design spec's provenance example.
STUDENT_MODEL = "Qwen/Qwen3-8B"
STUDENT_RENDERER = "qwen3_disable_thinking"

# Edit subtypes that admit a controlled corruption with a known clean target
# to reconstruct (see module docstring). Maps subtype -> corruption category.
SYNTHESIZABLE_SUBTYPES = {
    "koreksi": "spelling",
    "ubah_istilah": "number_or_name",
    "restrukturisasi": "word_order",
}

# Edit subtypes with no synthesizable known target: validator + judge
# fallback, always sampled into human review (see module docstring).
FALLBACK_SUBTYPES = ("perjelas", "elaborasi", "ringkas_bagian")

_FALLBACK_INSTRUCTIONS = {
    "perjelas": "Perjelas kalimat berikut tanpa mengubah maknanya.",
    "elaborasi": "Perluas bagian berikut dengan detail yang relevan, tanpa mengubah ide aslinya.",
    "ringkas_bagian": "Ringkas bagian berikut menjadi lebih singkat, pertahankan inti maknanya.",
}


# ---------------------------------------------------------------------------
# Known target bank (deterministic, small, realistic Indonesian sentences).
# ---------------------------------------------------------------------------
# Judgment call (documented, not sourced from an existing canonical list, same
# spirit as families.EDIT_SUBTYPES): a small corpus of clean target sentences
# with explicit metadata about which token is a "number" or a "name", so
# corruption functions never have to guess via fragile NER/regex heuristics.
_TARGETS = (
    {"text": "Pendapatan perusahaan naik 12 persen pada kuartal kedua tahun 2025.",
     "number": "12", "name": None},
    {"text": "Budi mengirimkan laporan keuangan kepada Direktur pada hari Senin.",
     "number": None, "name": "Budi"},
    {"text": "Biaya operasional turun menjadi 450 juta rupiah setelah efisiensi diterapkan.",
     "number": "450", "name": None},
    {"text": "Siti menyampaikan hasil audit kepada seluruh tim pada rapat pagi ini.",
     "number": None, "name": "Siti"},
    {"text": "Target penjualan bulan ini adalah 300 unit di seluruh cabang.",
     "number": "300", "name": None},
)


def _pick_target(family_id, i):
    digest = hashlib.sha256(f"{family_id}:{i}".encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % len(_TARGETS)
    return _TARGETS[idx]


def _rng_for(family_id, i):
    return random.Random(f"{family_id}:{i}")


# ---------------------------------------------------------------------------
# Corruption generators: clean target -> (corrupted_text, instruction).
# Return None if the chosen target has no candidate for that category (e.g.
# a number corruption on a target with no number).
# ---------------------------------------------------------------------------

def _corrupt_spelling(target, rng):
    words = re.findall(r"[A-Za-z]+", target["text"])
    candidates = [w for w in words if len(w) >= 5]
    if not candidates:
        return None
    word = rng.choice(candidates)
    i = rng.randrange(1, len(word) - 2)
    chars = list(word)
    chars[i], chars[i + 1] = chars[i + 1], chars[i]
    typo = "".join(chars)
    if typo == word:
        return None
    corrupted = target["text"].replace(word, typo, 1)
    instruction = (
        f'Ada kata yang salah tulis pada dokumen ini: "{typo}" seharusnya '
        f'"{word}". Perbaiki ejaan kata yang salah tersebut.'
    )
    return corrupted, instruction


def _corrupt_number(target, rng):
    number = target.get("number")
    if not number:
        return None
    delta = rng.choice([1, 2, 3, 5, 10])
    new_number = str(int(number) + delta)
    corrupted = target["text"].replace(number, new_number, 1)
    instruction = (
        f'Angka pada dokumen ini salah: tertulis "{new_number}" padahal '
        f'seharusnya "{number}". Perbaiki angka yang salah tersebut.'
    )
    return corrupted, instruction


_ALT_NAMES = {"Budi": "Anton", "Siti": "Rina"}


def _corrupt_name(target, rng):
    name = target.get("name")
    if not name or name not in _ALT_NAMES:
        return None
    wrong = _ALT_NAMES[name]
    corrupted = target["text"].replace(name, wrong, 1)
    instruction = (
        f'Nama pada dokumen ini salah: tertulis "{wrong}" padahal seharusnya '
        f'"{name}". Perbaiki nama yang salah tersebut.'
    )
    return corrupted, instruction


def _corrupt_number_or_name(target, rng):
    if target.get("number"):
        return _corrupt_number(target, rng)
    if target.get("name"):
        return _corrupt_name(target, rng)
    return None


def _corrupt_word_order(target, rng):
    words = target["text"].split(" ")
    if len(words) < 4:
        return None
    i = rng.randrange(0, len(words) - 2)  # never touch the last (punctuated) word
    swapped = list(words)
    swapped[i], swapped[i + 1] = swapped[i + 1], swapped[i]
    corrupted = " ".join(swapped)
    instruction = (
        f'Urutan kata pada kalimat berikut salah: tertulis "{swapped[i]} {swapped[i + 1]}" '
        f'padahal seharusnya "{words[i]} {words[i + 1]}". Perbaiki urutan katanya '
        "menjadi seperti kalimat aslinya, tanpa mengubah kata lain."
    )
    return corrupted, instruction


_CORRUPTORS = {
    "spelling": _corrupt_spelling,
    "number_or_name": _corrupt_number_or_name,
    "word_order": _corrupt_word_order,
}


# ---------------------------------------------------------------------------
# Instruction-category vocabulary (pure, unit-tested), shared by the
# excessive-deletion / name-number-altered "license" checks and the
# instruction_mismatch guard. Judgment call, same spirit as gen_router's
# _INTENT_CUES: short Indonesian cues associated with each corruption/edit
# category. A category absent from `instruction` never licenses anything and
# never triggers instruction_mismatch (nothing declared -> nothing to check).
# ---------------------------------------------------------------------------
_CATEGORY_CUES = {
    "number": ("angka",),
    "name": ("nama",),
    "word_order": ("urutan kata", "susunan kata"),
    "omission": ("ringkas", "pendek", "hapus", "kurangi"),
    "spelling": ("ejaan", "salah tulis", "kata yang salah"),
}


def _declared_category(instruction):
    text = str(instruction or "").lower()
    for cat, cues in _CATEGORY_CUES.items():
        if any(cue in text for cue in cues):
            return cat
    return None


def _classify_diff(find, replace):
    """Pure heuristic classification of what kind of change one edit makes,
    for comparison against the instruction's declared category."""
    if re.findall(r"\d+", find) != re.findall(r"\d+", replace):
        return "number"
    names_f = re.findall(r"\b[A-Z][a-z]+\b", find)
    names_r = re.findall(r"\b[A-Z][a-z]+\b", replace)
    if names_f != names_r:
        return "name"
    if find.split() != replace.split() and sorted(find.split()) == sorted(replace.split()):
        return "word_order"
    if len(replace) < 0.5 * max(len(find), 1):
        return "omission"
    return "spelling"


# ---------------------------------------------------------------------------
# Semantic guards (pure helpers, no bridge call).
# ---------------------------------------------------------------------------

def _guard_no_op(edits):
    for e in edits:
        if str(e.get("find", "")) == str(e.get("replace", "")):
            return "no_op"
    return None


def _guard_excessive_deletion(edits, instruction):
    licensed = _declared_category(instruction) == "omission"
    for e in edits:
        find, replace = str(e.get("find", "")), str(e.get("replace", ""))
        if find and len(replace) < 0.5 * len(find) and not licensed:
            return "excessive_deletion"
    return None


def _guard_name_number_altered(edits, instruction):
    declared = _declared_category(instruction)
    for e in edits:
        find, replace = str(e.get("find", "")), str(e.get("replace", ""))
        if re.findall(r"\d+", find) != re.findall(r"\d+", replace) and declared != "number":
            return "name_number_altered"
        names_f = re.findall(r"\b[A-Z][a-z]+\b", find)
        names_r = re.findall(r"\b[A-Z][a-z]+\b", replace)
        if names_f != names_r and declared != "name":
            return "name_number_altered"
    return None


def _guard_instruction_mismatch(edits, instruction):
    declared = _declared_category(instruction)
    if declared is None:
        return None  # nothing explicitly declared -> nothing to check against
    for e in edits:
        actual = _classify_diff(str(e.get("find", "")), str(e.get("replace", "")))
        if actual != declared:
            return "instruction_mismatch"
    return None


def _guard_duplicate_target(resolve):
    indices = [r["index"] for r in resolve if "index" in r]
    if len(indices) != len(set(indices)):
        return "duplicate_target"
    return None


def _guard_overlapping(resolve):
    intervals = sorted(
        (r["index"], r["index"] + r["length"]) for r in resolve if "index" in r
    )
    for i in range(1, len(intervals)):
        if intervals[i][0] < intervals[i - 1][1]:
            return "overlapping"
    return None


def _run_pre_gates(edits, instruction):
    """The four pure (no-bridge) semantic guards, in a fixed order."""
    reason = _guard_no_op(edits)
    if reason:
        return reason
    for guard in (_guard_excessive_deletion, _guard_name_number_altered,
                  _guard_instruction_mismatch):
        reason = guard(edits, instruction)
        if reason:
            return reason
    return None


def _run_resolve_gates(resolve):
    for guard in (_guard_duplicate_target, _guard_overlapping):
        reason = guard(resolve)
        if reason:
            return reason
    return None


# ---------------------------------------------------------------------------
# Acceptance: contract validity + reconstruction (via the bridge oracle) +
# semantic guards. Never reimplements parse/resolve/apply -- always the real
# JS through BridgeClient.validate_edit.
# ---------------------------------------------------------------------------

def accept_edit(bridge, corrupted, expected, edits, instruction=None):
    """Decide whether `edits`, applied to `corrupted`, are an acceptable
    known-target training example whose expected clean target is `expected`.

    Returns (True, None) on acceptance, or (False, reason) where reason is
    one of: "no_op", "excessive_deletion", "name_number_altered",
    "instruction_mismatch", "parse_error", "unresolved_anchor",
    "duplicate_target", "overlapping", "apply_failed",
    "reconstruction_mismatch".
    """
    if not edits:
        return False, "empty_edits"

    reason = _run_pre_gates(edits, instruction)
    if reason:
        return False, reason

    result = bridge.validate_edit(corrupted, edits)

    if not result["parse"]["ok"]:
        return False, "parse_error"

    resolve = result["resolve"]
    if any("error" in r for r in resolve):
        return False, "unresolved_anchor"

    reason = _run_resolve_gates(resolve)
    if reason:
        return False, reason

    apply = result["apply"]
    if any(status != "applied" for status in apply["perEditStatus"]):
        return False, "apply_failed"

    if apply["text"] != expected:
        return False, "reconstruction_mismatch"

    return True, None


# ---------------------------------------------------------------------------
# Teacher-facing prompt.
# ---------------------------------------------------------------------------

def _edit_messages(edit_system_prompt, doc_text, instruction):
    user = f"Dokumen:\n{doc_text}\n\nInstruksi: {instruction}"
    return [
        {"role": "system", "content": edit_system_prompt},
        {"role": "user", "content": user},
    ]


def _parse_edits_json(raw):
    """Extract the `edits` array from a teacher's raw JSON response. This is
    NOT the production contract parser (that lives only in editContract.js,
    reached via the bridge) -- it is just enough to hand a Python list of
    edit dicts to the bridge. Malformed output -> (None, "teacher_json_invalid").
    """
    text = str(raw or "")
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None, "teacher_json_invalid"
    try:
        obj = json.loads(text[start:end + 1])
    except (json.JSONDecodeError, ValueError):
        return None, "teacher_json_invalid"
    edits = obj.get("edits") if isinstance(obj, dict) else None
    if not isinstance(edits, list) or not edits:
        return None, "teacher_json_invalid"
    return edits, None


def _subtype_of_family(family):
    """Extract the edit subtype from a family dict (or bare kind string).

    Family kinds for this axis are "edit:<subtype>" per
    tantular.finetune.families (`_all_kinds`); family ids are
    "edit:<subtype>::<index>".
    """
    kind = family["kind"] if isinstance(family, dict) else family
    if not str(kind).startswith("edit:"):
        raise ValueError(f"not an edit family: {kind!r}")
    return kind.split(":", 1)[1]


# ---------------------------------------------------------------------------
# Generation harness.
# ---------------------------------------------------------------------------

def generate_edit(
    sampler,
    bridge,
    family,
    n,
    edit_system_prompt,
    *,
    judge=None,
    max_retries=3,
    bridge_protocol_version=None,
    bridge_js_commit=None,
    production_prompt_content_hash=None,
    production_prompt_git_sha=None,
):
    """Generate up to n edit-contract candidates for one family, gate them,
    and return (accepted, rejected, review_queue).

    - `sampler`: teacher client exposing `.sample(messages) -> str` (injected;
      never Tinker directly in tests).
    - `bridge`: a `BridgeClient` (or compatible stub) exposing
      `.validate_edit(doc_text, edits) -> {parse, resolve, apply}`.
    - `family`: a dict with at least {"id", "kind", "split"} as produced by
      `families.enumerate_families()` + a resolved split, matching
      gen_router.generate_router's contract: the split MUST already be
      resolved by the caller, never falls back to the module-level split
      cache, and raises if `family["split"]` is missing.
    - `n`: requested candidate count.
    - `edit_system_prompt`: the production EDIT_SYSTEM_PROMPT content,
      sourced from `BridgeClient.dump_prompts()` (prompt id "edit") by the
      caller -- required, not defaulted, so accepted examples always carry
      the real production prompt as their system message.
    - `judge`: injectable judge callable `judge(source_text, instruction,
      produced_text) -> Any`, used ONLY for the no-synthesizable-target
      fallback subtypes (see FALLBACK_SUBTYPES). Never called in tests as a
      live model -- deterministic stub only.
    - `max_retries`: for synthesizable subtypes, how many teacher samples to
      try per candidate before discarding to `rejected` (retry-then-discard).

    Returns three lists:
    - accepted: provenance-tracked examples (status="accepted"). Only ever
      populated for SYNTHESIZABLE_SUBTYPES -- known-target reconstruction
      verified via the bridge oracle.
    - rejected: provenance-tracked examples (status="rejected") for
      candidates that failed structural sanity, teacher JSON parsing, or (for
      synthesizable subtypes) exhausted all retries without reconstructing
      the known target.
    - review_queue: plain dicts for FALLBACK_SUBTYPES candidates that passed
      the validator (parse/resolve/guards) -- ALWAYS routed here, never
      auto-accepted, per the spec's "no synthesizable target -> validator +
      judge + human review sampling" rule.
    """
    subtype = _subtype_of_family(family)
    family_id = family["id"]
    split = family.get("split")
    if split not in ("train", "eval", "challenge"):
        raise ValueError(
            f"family {family_id!r} has no resolved split; resolve it via "
            "families.assign_splits(...)/split_of(family_id, assignments) "
            "before calling generate_edit -- never rely on the module-level "
            "split cache here."
        )

    generation_meta = {
        "teacher_model": TEACHER_MODEL,
        "renderer": TEACHER_RENDERER,
        "bridge_protocol_version": bridge_protocol_version,
        "bridge_js_commit": bridge_js_commit,
    }
    training_meta = {"student_model": STUDENT_MODEL, "renderer": STUDENT_RENDERER}

    def _example(messages, payload, status, reject_reason):
        return make_example(
            task="edit",
            split=split,
            family=family_id,
            messages=messages,
            payload=payload,
            generation=generation_meta,
            training=training_meta,
            status=status,
            reject_reason=reject_reason,
            prompt_id="edit",
            production_prompt_content_hash=production_prompt_content_hash,
            production_prompt_git_sha=production_prompt_git_sha,
        )

    accepted, rejected, review_queue = [], [], []

    if subtype in FALLBACK_SUBTYPES:
        for i in range(n):
            target = _pick_target(family_id, i)
            source_text = target["text"]
            instruction = _FALLBACK_INSTRUCTIONS[subtype]
            messages = _edit_messages(edit_system_prompt, source_text, instruction)
            raw = sampler.sample(messages)
            edits, err = _parse_edits_json(raw)
            if err:
                rejected.append(_example(
                    messages, {"source_text": source_text, "instruction": instruction, "raw": raw},
                    "rejected", err,
                ))
                continue

            reason = _run_pre_gates(edits, instruction)
            if reason:
                rejected.append(_example(
                    messages, {"source_text": source_text, "instruction": instruction, "edits": edits},
                    "rejected", reason,
                ))
                continue

            result = bridge.validate_edit(source_text, edits)
            if not result["parse"]["ok"]:
                rejected.append(_example(
                    messages, {"source_text": source_text, "instruction": instruction, "edits": edits},
                    "rejected", "parse_error",
                ))
                continue
            resolve = result["resolve"]
            if any("error" in r for r in resolve):
                rejected.append(_example(
                    messages, {"source_text": source_text, "instruction": instruction, "edits": edits},
                    "rejected", "unresolved_anchor",
                ))
                continue
            reason = _run_resolve_gates(resolve)
            if reason:
                rejected.append(_example(
                    messages, {"source_text": source_text, "instruction": instruction, "edits": edits},
                    "rejected", reason,
                ))
                continue

            produced_text = result["apply"]["text"]
            verdict = judge(source_text, instruction, produced_text) if judge is not None else None

            review_queue.append({
                "family": family_id,
                "subtype": subtype,
                "reason": "no_synthesizable_target",
                "source_text": source_text,
                "instruction": instruction,
                "edits": edits,
                "produced_text": produced_text,
                "judge_verdict": verdict,
            })

        return accepted, rejected, review_queue

    # -- Synthesizable path: controlled corruption + known-target reconstruction.
    category = SYNTHESIZABLE_SUBTYPES.get(subtype)
    if category is None:
        raise ValueError(f"unknown edit subtype {subtype!r} in family kind {family['kind']!r}")

    corrupt_fn = _CORRUPTORS[category]

    for i in range(n):
        target = _pick_target(family_id, i)
        rng = _rng_for(family_id, i)
        corruption = corrupt_fn(target, rng)
        if corruption is None:
            rejected.append(_example(
                [], {"target": target}, "rejected", "no_corruption_candidate",
            ))
            continue

        corrupted_text, instruction = corruption
        clean_target = target["text"]

        last_reason = "max_retries_exhausted"
        last_edits = None
        last_messages = None
        accepted_this = False

        for _attempt in range(max_retries):
            messages = _edit_messages(edit_system_prompt, corrupted_text, instruction)
            last_messages = messages
            raw = sampler.sample(messages)
            edits, err = _parse_edits_json(raw)
            if err:
                last_reason = err
                last_edits = None
                continue
            last_edits = edits
            ok, reason = accept_edit(bridge, corrupted_text, clean_target, edits, instruction=instruction)
            if ok:
                accepted.append(_example(
                    [
                        {"role": "system", "content": edit_system_prompt},
                        {"role": "user", "content": messages[1]["content"]},
                        {"role": "assistant", "content": json.dumps({"edits": edits})},
                    ],
                    {
                        "source_text": corrupted_text,
                        "target_text": clean_target,
                        "instruction": instruction,
                        "edits": edits,
                        "corruption_category": category,
                    },
                    "accepted", None,
                ))
                accepted_this = True
                break
            last_reason = reason

        if not accepted_this:
            rejected.append(_example(
                last_messages or [],
                {
                    "source_text": corrupted_text,
                    "target_text": clean_target,
                    "instruction": instruction,
                    "edits": last_edits,
                    "corruption_category": category,
                },
                "rejected", last_reason,
            ))

    return accepted, rejected, review_queue


# ---------------------------------------------------------------------------
# Real Tinker-backed teacher (never called in tests / at import time).
# ---------------------------------------------------------------------------

class TinkerEditTeacher:
    """Real Tinker-backed teacher client for edit-contract synthesis, using
    the same SDK patterns as tantular/finetune/spike/train_sentinel.py and
    gen_router.TinkerRouterTeacher (teacher model Qwen/Qwen3.5-397B-A17B,
    renderer qwen3_5_disable_thinking).

    All `tinker` / `tinker_cookbook` imports are lazy (inside `_ensure_ready`
    and `sample`), so constructing this class -- and importing this module --
    never touches Tinker or spends anything. Tests inject a deterministic
    stub with a `.sample(messages) -> str` method instead of this class.
    """

    def __init__(self, service_client=None, sampling_params=None):
        self._service_client = service_client
        self._sampling_params = sampling_params
        self._sampling_client = None
        self._tokenizer = None
        self._renderer = None

    def _ensure_ready(self):
        if self._sampling_client is not None:
            return
        import tinker
        from tinker_cookbook import tokenizer_utils
        from tinker_cookbook.renderers import get_renderer

        service_client = self._service_client or tinker.ServiceClient()
        self._tokenizer = tokenizer_utils.get_tokenizer(TEACHER_MODEL)
        self._renderer = get_renderer(TEACHER_RENDERER, self._tokenizer)
        self._sampling_client = service_client.create_sampling_client(base_model=TEACHER_MODEL)
        if self._sampling_params is None:
            self._sampling_params = tinker.SamplingParams(
                max_tokens=768, temperature=0.7, top_p=0.9
            )

    def sample(self, messages):
        """messages: list of {"role", "content"} dicts. Returns decoded
        assistant-turn text."""
        self._ensure_ready()
        prompt = self._renderer.build_generation_prompt(messages, role="assistant")
        result = self._sampling_client.sample(
            prompt=prompt, num_samples=1, sampling_params=self._sampling_params
        ).result()
        out_tokens = result.sequences[0].tokens
        return self._tokenizer.decode(out_tokens)
