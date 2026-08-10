"""Router dataset generator: teacher-synthesized Indonesian user messages per
intent (label known by construction), gated by (1) an independent teacher
cold re-classification and (2) a human-review queue for ambiguous or
disagreement cases.

Per the design spec (docs/superpowers/specs/2026-07-20-tantular-productivity-
finetune-design.md, "Router" under "Per-task generation and validation"):

    Teacher generates diverse Indonesian messages per intent (label known by
    construction). Two independent gates before acceptance:
    1. Independent cold re-classification -- a separate teacher prompt
       re-labels the message with no knowledge of the intended label;
       disagreement flags the example.
    2. Human review of every ambiguous / cross-intent / disagreement-flagged
       example -- never auto-accepted.

The router's production contract (tantular_office_addin/src/chat/
intentRouter.js) answers with exactly one intent word, so accepted examples'
`messages` end with an assistant turn equal to the (confirmed, by agreement)
intent label -- that is the actual SFT target, not just metadata.

Teacher access is always injected (constructor/function parameter) -- this
module never calls Tinker at import time, and tests only ever pass a
deterministic stub. `TinkerRouterTeacher` is a real implementation, but all
`tinker`/`tinker_cookbook` imports inside it are lazy (inside methods), so
merely importing this module, or constructing a `TinkerRouterTeacher`, costs
nothing and touches no network.
"""

import hashlib
import json
import re

from tantular.finetune.provenance import make_example
from tantular.finetune.teacher_text import strip_trailing_chat_terminator

# Source of truth: tantular_office_addin/src/chat/intentRouter.js INTENTS.
ROUTER_INTENTS = (
    "TANYA_DOKUMEN",
    "EDIT_TEKS",
    "DRAFT_TEKS",
    "TERJEMAH",
    "RINGKAS",
    "UBAH_NADA",
    "CEK_AMAN",
    "UMUM",
)

# Teacher: same model/renderer as the sentinel export spike
# (tantular/finetune/spike/train_sentinel.py) and the provenance schema
# example (tests/test_provenance.py).
TEACHER_MODEL = "Qwen/Qwen3.5-397B-A17B"
TEACHER_RENDERER = "qwen3_5_disable_thinking"

# Student: the fine-tune target, per the design spec's provenance example.
STUDENT_MODEL = "Qwen/Qwen3-8B"
STUDENT_RENDERER = "qwen3_disable_thinking"

# ---------------------------------------------------------------------------
# Ambiguity heuristic (pure, unit-tested).
# ---------------------------------------------------------------------------
#
# Judgment call (documented, not sourced from an existing canonical list):
# short Indonesian keyword/phrase cues strongly associated with each router
# intent in production usage (mirrors the spirit of intentRouter.js's own
# `routeIntentHeuristic`, but only for *detecting* multi-intent phrasing, not
# for routing). UMUM has no positive cues -- it is the "none of the above"
# fallback and can never itself contribute to an ambiguity hit.
_INTENT_CUES = {
    "TANYA_DOKUMEN": ("apa isi", "jelaskan dokumen", "menurut dokumen", "isi dokumen"),
    "EDIT_TEKS": ("edit teks", "ubah teks", "perbaiki teks", "revisi teks", "ganti kalimat"),
    "DRAFT_TEKS": ("buatkan draf", "tulis draf", "susun draf", "buat surat", "buat memo"),
    "TERJEMAH": ("terjemahkan", "translate", "bahasa inggris", "bahasa indonesia"),
    "RINGKAS": ("ringkas", "rangkum", "ringkasan"),
    "UBAH_NADA": ("nada formal", "nada santai", "gaya bahasa", "ubah nada"),
    "CEK_AMAN": ("phishing", "penipuan", "cek keamanan", "apakah aman"),
    "UMUM": (),
}


def is_ambiguous(message):
    """True if the message carries cues for two or more distinct intents.

    Pure function, no teacher call. A candidate flagged here always routes
    to the review queue, regardless of cold-classification agreement.
    """
    text = str(message or "").lower()
    hit_intents = set()
    for intent, cues in _INTENT_CUES.items():
        if any(cue in text for cue in cues):
            hit_intents.add(intent)
    return len(hit_intents) >= 2


# ---------------------------------------------------------------------------
# Gate decision (pure, unit-tested).
# ---------------------------------------------------------------------------

def decide_router(intended, cold, ambiguous):
    """Decide accept vs. review for one router candidate.

    - Agreement (intended == cold) and not flagged ambiguous -> "accept".
    - Disagreement, OR flagged ambiguous even on agreement -> "review".
      Ambiguous-but-agreeing is still routed to review: the spec requires
      human review of "every ambiguous / cross-intent ... example", not just
      disagreements -- never auto-accepted.
    """
    if ambiguous:
        return "review"
    if intended == cold:
        return "accept"
    return "review"


# ---------------------------------------------------------------------------
# Teacher-facing prompts + cold re-classification.
# ---------------------------------------------------------------------------

# Synthesis-call instruction template (module constant, not an inline
# f-string) so it participates in `SYNTHESIS_PROMPT_HASH` below -- the
# variable slots (`router_system_prompt`, `n`, `intent`) are the production
# prompt content and per-call counters, not synthesis-affecting constants.
_SYNTHESIS_TEMPLATE = (
    "Anda membuat data sintetis untuk melatih pengklasifikasi intent "
    "sebuah asisten dokumen Word Bahasa Indonesia. Asisten produksi ini "
    "menggunakan system prompt berikut untuk merutekan pesan pengguna:\n\n"
    "{router_system_prompt}\n\n"
    "Tulis {n} pesan pengguna berbahasa Indonesia yang BERBEDA-BEDA dan "
    "realistis, yang masing-masing secara alami akan dirutekan ke intent "
    '"{intent}" oleh asisten di atas. Satu pesan per baris. Jangan beri '
    "nomor, tanda hubung, atau penjelasan -- hanya pesan penggunanya saja."
)

# Cold-reclassification instruction template -- a SEPARATE synthesis-side
# prompt from `_SYNTHESIS_TEMPLATE` (see `_cold_classify_messages`). Hashed
# independently into `COLD_PROMPT_HASH` below and recorded as this module's
# `judge_prompt_hash`: it plays the independent-checker/judge role in the
# router pipeline (an independent re-classification the accept/review
# decision is gated on), even though it is not literally a quality judge.
_COLD_CLASSIFY_TEMPLATE = (
    "Anda adalah pengklasifikasi intent independen untuk asisten dokumen "
    "Word Bahasa Indonesia. Klasifikasikan SATU pesan pengguna berikut ke "
    "TEPAT SATU intent dari daftar ini: {intents}.\n"
    "Jawab HANYA dengan nama intent persis seperti di atas, tanpa kata "
    "atau tanda baca lain.\n\n"
    "Pesan: {message}"
)


def _synthesis_messages(intent, n, router_system_prompt):
    """Build the synthesis-call messages for N diverse candidates of one
    intent. Includes the production router system prompt as context (per the
    brief: "Messages carry the production router prompt as system, from
    bridge dump-prompts") -- but this is a *synthesis* instruction, distinct
    from the cold-reclassification prompt below, so agreement between them
    is a genuine independent check, not the same call twice.
    """
    instruction = _SYNTHESIS_TEMPLATE.format(
        router_system_prompt=router_system_prompt, n=n, intent=intent
    )
    return [{"role": "user", "content": instruction}]


def _cold_classify_messages(message):
    """Build the cold-reclassification call: a *separate* prompt from the
    synthesis prompt above, with no knowledge of the intended label, so
    agreement is evidence, not a rubber stamp.
    """
    instruction = _COLD_CLASSIFY_TEMPLATE.format(
        intents=", ".join(ROUTER_INTENTS), message=message
    )
    return [{"role": "user", "content": instruction}]


# ---------------------------------------------------------------------------
# Synthesis/cold-classify prompt hashes (spec: "Provenance-tracked example
# schema" requires `generation.synthesis_prompt_hash` and
# `generation.judge_prompt_hash` per example). Computed at import time from
# the module's own constants, via the pure `_hash_constants` helper, so any
# edit to a template or cue bank changes the hash automatically.
# ---------------------------------------------------------------------------

def _hash_constants(obj):
    """sha256 hex digest of a canonical (sort_keys, ensure_ascii=False) JSON
    encoding of `obj`. Pure -- no module-state dependency -- so callers (incl.
    tests) can hash arbitrary snapshots of synthesis-affecting constants."""
    canonical = json.dumps(obj, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# SYNTHESIS_PROMPT_HASH: the synthesis-call template, the ambiguity cue bank
# it's paired with for gating (`_INTENT_CUES`), and the intent vocabulary
# both templates are parameterized over.
SYNTHESIS_PROMPT_HASH = _hash_constants({
    "synthesis_template": _SYNTHESIS_TEMPLATE,
    "intent_cues": _INTENT_CUES,
    "router_intents": ROUTER_INTENTS,
})

# COLD_PROMPT_HASH: the independent cold-reclassification template (see
# `_cold_classify_messages` docstring for why this is recorded as
# `judge_prompt_hash` rather than folded into `SYNTHESIS_PROMPT_HASH`).
COLD_PROMPT_HASH = _hash_constants({
    "cold_classify_template": _COLD_CLASSIFY_TEMPLATE,
    "router_intents": ROUTER_INTENTS,
})


def cold_classify(sampler, message):
    """Independently re-classify `message`'s router intent via the
    cold-reclassification prompt (never the synthesis prompt/call). Returns
    one of ROUTER_INTENTS; falls back to "UMUM" if the teacher's raw output
    matches none of them (mirrors intentRouter.js's parseIntent fallback).
    """
    raw = sampler.sample(_cold_classify_messages(message))
    raw = str(raw or "").strip().upper()
    # Longest-first so overlapping names (e.g. none here, but future-proof)
    # can never mis-match -- mirrors intentRouter.js's parseIntent.
    for intent in sorted(ROUTER_INTENTS, key=len, reverse=True):
        if intent in raw:
            return intent
    return "UMUM"


def _split_candidates(raw_text, n):
    """Split a teacher synthesis response into up to n candidate messages,
    one per non-empty line, stripping leading enumeration markers
    ("1.", "1)", "-", "*") the teacher may add despite being told not to.
    """
    lines = [ln.strip() for ln in str(raw_text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    cleaned = [re.sub(r"^[\-\*•]\s*|^\d+[\.\)]\s*", "", ln).strip() for ln in lines]
    return [ln for ln in cleaned if ln][:n]


def _intent_of_family(family):
    """Extract the router intent from a family dict (or bare kind string).

    Family kinds for this axis are "router:<INTENT>" per
    tantular.finetune.families (`_all_kinds`); family ids are
    "router:<INTENT>::<index>".
    """
    kind = family["kind"] if isinstance(family, dict) else family
    if not str(kind).startswith("router:"):
        raise ValueError(f"not a router family: {kind!r}")
    intent = kind.split(":", 1)[1]
    if intent not in ROUTER_INTENTS:
        raise ValueError(f"unknown router intent in family kind {kind!r}: {intent!r}")
    return intent


# ---------------------------------------------------------------------------
# Generation harness.
# ---------------------------------------------------------------------------

def generate_router(
    sampler,
    family,
    n,
    router_system_prompt,
    *,
    cold_sampler=None,
    bridge_protocol_version=None,
    bridge_js_commit=None,
    production_prompt_content_hash=None,
    production_prompt_git_sha=None,
):
    """Generate up to n router candidates for one family, gate them, and
    return (accepted, rejected, review_queue).

    - `sampler` / `cold_sampler`: teacher clients exposing `.sample(messages)
      -> str` (injected; `cold_sampler` defaults to `sampler` -- same model,
      but always a distinct *prompt*, per `_cold_classify_messages`).
    - `family`: a dict with at least {"id", "kind", "split"} as produced by
      `families.enumerate_families()` + a resolved split. The split MUST
      already be resolved by the caller via
      `families.split_of(family["id"], assignments)` with an explicit
      `assignments` from `families.assign_splits(...)` -- this function
      never falls back to the module-level split cache, and raises if
      `family["split"]` is missing, matching the "generation harnesses must
      pass assignments explicitly" rule.
    - `n`: requested candidate count (the teacher may return fewer; no
      retry-to-exact-n here, callers may call again for more).
    - `router_system_prompt`: the production ROUTER_SYSTEM content, sourced
      from `BridgeClient.dump_prompts()` (prompt id "router") by the caller.

    Returns three lists:
    - accepted: provenance-tracked examples (status="accepted"), each with
      messages=[system, user, assistant=<confirmed intent>].
    - rejected: provenance-tracked examples (status="rejected") for
      candidates that failed structural sanity (empty/too-short, or exact
      duplicate within this batch) before ever reaching the teacher
      cold-classification gate -- never trained on, kept for audit.
    - review_queue: plain dicts (no provenance status yet -- pending human
      review, not accepted or rejected) for every ambiguous or
      disagreement-flagged candidate. Never auto-accepted.
    """
    intent = _intent_of_family(family)
    family_id = family["id"]
    split = family.get("split")
    if split not in ("train", "eval", "challenge"):
        raise ValueError(
            f"family {family_id!r} has no resolved split; resolve it via "
            "families.assign_splits(...)/split_of(family_id, assignments) "
            "before calling generate_router -- never rely on the "
            "module-level split cache here."
        )

    cold_sampler = cold_sampler or sampler

    raw = sampler.sample(_synthesis_messages(intent, n, router_system_prompt))
    candidates = _split_candidates(raw, n)

    generation_meta = {
        "teacher_model": TEACHER_MODEL,
        "renderer": TEACHER_RENDERER,
        "bridge_protocol_version": bridge_protocol_version,
        "bridge_js_commit": bridge_js_commit,
        "synthesis_prompt_hash": SYNTHESIS_PROMPT_HASH,
        # The cold-reclassification prompt is the module's independent
        # checker (see `_COLD_CLASSIFY_TEMPLATE` docstring) -- recorded here
        # as `judge_prompt_hash`.
        "judge_prompt_hash": COLD_PROMPT_HASH,
    }
    training_meta = {"student_model": STUDENT_MODEL, "renderer": STUDENT_RENDERER}

    def _example(message, status, reject_reason, payload):
        return make_example(
            task="router",
            split=split,
            family=family_id,
            messages=[
                {"role": "system", "content": router_system_prompt},
                {"role": "user", "content": message},
            ],
            payload=payload,
            generation=generation_meta,
            training=training_meta,
            status=status,
            reject_reason=reject_reason,
            prompt_id="router",
            production_prompt_content_hash=production_prompt_content_hash,
            production_prompt_git_sha=production_prompt_git_sha,
        )

    accepted, rejected, review_queue = [], [], []
    seen = set()

    for message in candidates:
        if len(message.strip()) < 3:
            rejected.append(_example(
                message, "rejected", "empty_or_too_short",
                {"intent": intent, "cold_intent": None, "ambiguous": None},
            ))
            continue

        key = message.strip().lower()
        if key in seen:
            rejected.append(_example(
                message, "rejected", "duplicate_candidate",
                {"intent": intent, "cold_intent": None, "ambiguous": None},
            ))
            continue
        seen.add(key)

        cold = cold_classify(cold_sampler, message)
        ambiguous = is_ambiguous(message)
        decision = decide_router(intent, cold, ambiguous)

        if decision == "accept":
            accepted.append(make_example(
                task="router",
                split=split,
                family=family_id,
                messages=[
                    {"role": "system", "content": router_system_prompt},
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": intent},
                ],
                payload={"intent": intent, "cold_intent": cold, "ambiguous": ambiguous},
                generation=generation_meta,
                training=training_meta,
                status="accepted",
                reject_reason=None,
                prompt_id="router",
                production_prompt_content_hash=production_prompt_content_hash,
                production_prompt_git_sha=production_prompt_git_sha,
            ))
        else:
            review_queue.append({
                "family": family_id,
                "intent": intent,
                "cold_intent": cold,
                "ambiguous": ambiguous,
                "message": message,
                "reason": "ambiguous" if ambiguous else "disagreement",
            })

    return accepted, rejected, review_queue


# ---------------------------------------------------------------------------
# Real Tinker-backed teacher (never called in tests / at import time).
# ---------------------------------------------------------------------------

class TinkerRouterTeacher:
    """Real Tinker-backed teacher client for router synthesis + cold
    re-classification, using the same SDK patterns as
    tantular/finetune/spike/train_sentinel.py (teacher model
    Qwen/Qwen3.5-397B-A17B, renderer qwen3_5_disable_thinking).

    All `tinker` / `tinker_cookbook` imports are lazy (inside `_ensure_ready`
    and `sample`), so constructing this class -- and importing this module
    -- never touches Tinker or spends anything. Tests inject a deterministic
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
                max_tokens=512, temperature=0.9, top_p=0.9
            )

    def sample(self, messages):
        """messages: list of {"role", "content"} dicts. Returns decoded
        assistant-turn text.

        D2 (ft-fixD review finding): the decoded text feeds `_split_candidates`
        (the router synthesis path), which does NOT itself strip a trailing
        chat-template terminator -- unlike gen_prose.py's TinkerProseTeacher,
        whose `sample()` already stripped it before this fix. Without
        stripping here, `<|im_end|>` could land inside an accepted
        router-synthesis completion. Shared with TinkerProseTeacher via
        `teacher_text.strip_trailing_chat_terminator`.
        """
        self._ensure_ready()
        prompt = self._renderer.build_generation_prompt(messages, role="assistant")
        result = self._sampling_client.sample(
            prompt=prompt, num_samples=1, sampling_params=self._sampling_params
        ).result()
        out_tokens = result.sequences[0].tokens
        raw = self._tokenizer.decode(out_tokens)
        return strip_trailing_chat_terminator(raw)
