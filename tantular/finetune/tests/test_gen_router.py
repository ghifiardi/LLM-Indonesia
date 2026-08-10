import pathlib

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import assign_splits, enumerate_families, split_of
from tantular.finetune.gen_router import (
    COLD_PROMPT_HASH,
    SYNTHESIS_PROMPT_HASH,
    _hash_constants,
    cold_classify,
    decide_router,
    generate_router,
    is_ambiguous,
)

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"


class FixedSampler:
    """Deterministic stub teacher (never touches Tinker): if `value` is a
    list, pops one response per call (last one repeats once exhausted);
    otherwise returns the same value every call. Records every call's
    messages for inspection.
    """

    def __init__(self, value):
        self.value = value
        self.calls = []

    def sample(self, messages):
        self.calls.append(messages)
        if isinstance(self.value, list):
            idx = min(len(self.calls) - 1, len(self.value) - 1)
            return self.value[idx]
        return self.value


# --- Step 1 brief tests, verbatim -------------------------------------------

def test_agreement_accepts_disagreement_queues():
    assert decide_router("EDIT_TEKS", "EDIT_TEKS", ambiguous=False) == "accept"
    assert decide_router("EDIT_TEKS", "UMUM", ambiguous=False) == "review"
    assert decide_router("EDIT_TEKS", "EDIT_TEKS", ambiguous=True) == "review"


def test_ambiguity_heuristic():
    assert is_ambiguous("terjemahkan dan ringkas ini")  # two intent cues
    assert not is_ambiguous("terjemahkan paragraf ini")


# --- cold_classify -----------------------------------------------------------

def test_cold_classify_matches_known_intent_even_with_extra_text():
    sampler = FixedSampler("Intent: EDIT_TEKS.")
    assert cold_classify(sampler, "perbaiki kalimat ini") == "EDIT_TEKS"
    assert len(sampler.calls) == 1  # exactly one call for one classification


def test_cold_classify_falls_back_to_umum_on_unrecognized_output():
    sampler = FixedSampler("saya tidak tahu")
    assert cold_classify(sampler, "apa saja isi dokumen ini?") == "UMUM"


def test_cold_classify_uses_a_distinct_prompt_from_synthesis():
    # The cold-reclassification call must not echo a "you generated this"
    # framing -- it must look like a fresh, independent classification ask.
    sampler = FixedSampler("EDIT_TEKS")
    cold_classify(sampler, "perbaiki ejaan di paragraf ini")
    sent = sampler.calls[0][0]["content"]
    assert "independen" in sent
    assert "perbaiki ejaan di paragraf ini" in sent


# --- generate_router: gating behavior ---------------------------------------

def _family(intent, split="train", idx=0):
    return {"id": f"router:{intent}::{idx:04d}", "kind": f"router:{intent}", "split": split}


def test_generate_router_accepts_on_agreement_no_ambiguity():
    synth = FixedSampler("Perbaiki ejaan pada paragraf pembuka ini")
    cold = FixedSampler("EDIT_TEKS")
    accepted, rejected, review_queue = generate_router(
        synth, _family("EDIT_TEKS"), 1, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold
    )
    assert rejected == []
    assert review_queue == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["task"] == "router"
    assert ex["split"] == "train"
    assert ex["family"] == "router:EDIT_TEKS::0000"
    assert ex["provenance"]["status"] == "accepted"
    assert ex["payload"]["intent"] == "EDIT_TEKS"
    assert ex["payload"]["cold_intent"] == "EDIT_TEKS"
    assert ex["messages"] == [
        {"role": "system", "content": "ROUTER SYSTEM PROMPT TEXT"},
        {"role": "user", "content": "Perbaiki ejaan pada paragraf pembuka ini"},
        {"role": "assistant", "content": "EDIT_TEKS"},
    ]


def test_generate_router_queues_disagreement_for_review():
    synth = FixedSampler("Ringkas dokumen ini menjadi tiga poin utama")
    cold = FixedSampler("UMUM")  # disagrees with the intended RINGKAS label
    accepted, rejected, review_queue = generate_router(
        synth, _family("RINGKAS"), 1, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold
    )
    assert accepted == []
    assert rejected == []
    assert len(review_queue) == 1
    item = review_queue[0]
    assert item["intent"] == "RINGKAS"
    assert item["cold_intent"] == "UMUM"
    assert item["reason"] == "disagreement"


def test_generate_router_queues_ambiguous_even_on_agreement():
    synth = FixedSampler("terjemahkan dan ringkas ini")
    cold = FixedSampler("TERJEMAH")  # agrees, but the message is ambiguous
    accepted, rejected, review_queue = generate_router(
        synth, _family("TERJEMAH"), 1, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold
    )
    assert accepted == []
    assert len(review_queue) == 1
    assert review_queue[0]["reason"] == "ambiguous"
    assert review_queue[0]["ambiguous"] is True


def test_generate_router_rejects_short_and_duplicate_candidates():
    synth = FixedSampler(
        "Perbaiki ejaan pada paragraf ini\nPerbaiki ejaan pada paragraf ini\nx"
    )
    cold = FixedSampler("EDIT_TEKS")
    accepted, rejected, review_queue = generate_router(
        synth, _family("EDIT_TEKS"), 3, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold
    )
    assert len(accepted) == 1
    assert review_queue == []
    assert len(rejected) == 2
    reasons = sorted(r["provenance"]["reject_reason"] for r in rejected)
    assert reasons == ["duplicate_candidate", "empty_or_too_short"]
    for r in rejected:
        assert r["provenance"]["status"] == "rejected"
    # Rejected candidates never reach the teacher cold-classification call --
    # only the one surviving (non-duplicate, non-short) candidate does.
    assert len(cold.calls) == 1


def test_generate_router_requires_resolved_split():
    synth = FixedSampler("Perbaiki ejaan pada paragraf ini")
    cold = FixedSampler("EDIT_TEKS")
    family = {"id": "router:EDIT_TEKS::0000", "kind": "router:EDIT_TEKS", "split": None}
    try:
        generate_router(synth, family, 1, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold)
        assert False, "expected ValueError for unresolved split"
    except ValueError as e:
        assert "split" in str(e)


def test_generate_router_defaults_cold_sampler_to_sampler():
    # Same stub teacher plays both roles when cold_sampler is omitted -- the
    # independence guarantee comes from the distinct *prompt*, not a
    # distinct client (see test_cold_classify_uses_a_distinct_prompt_from_synthesis).
    shared = FixedSampler(["Perbaiki ejaan pada paragraf ini", "EDIT_TEKS"])
    accepted, rejected, review_queue = generate_router(
        shared, _family("EDIT_TEKS"), 1, "ROUTER SYSTEM PROMPT TEXT"
    )
    assert len(accepted) == 1
    assert len(shared.calls) == 2  # one synthesis call, one cold-classify call


# --- integration: real production router prompt + real split resolution ----

def test_generate_router_carries_production_router_prompt_via_bridge():
    families = enumerate_families(instances_per_kind=2)
    assignments = assign_splits(families, seed=1)
    router_umum = next(f for f in families if f["kind"] == "router:UMUM")
    resolved_split = split_of(router_umum["id"], assignments)
    family = {**router_umum, "split": resolved_split}

    with BridgeClient(str(BRIDGE)) as bc:
        prompt = bc.dump_prompts()
        router_prompt = next(p for p in prompt if p["id"] == "router")

        synth = FixedSampler("Selamat pagi, apa kabar?")
        cold = FixedSampler("UMUM")
        accepted, rejected, review_queue = generate_router(
            synth,
            family,
            1,
            router_prompt["content"],
            cold_sampler=cold,
            bridge_protocol_version=bc.ready["protocol_version"],
            bridge_js_commit=bc.ready["js_commit"],
            production_prompt_content_hash=router_prompt["contentHash"],
        )

    assert rejected == []
    assert review_queue == []
    assert len(accepted) == 1
    ex = accepted[0]
    assert ex["messages"][0]["content"] == router_prompt["content"]
    assert ex["provenance"]["production_prompt_content_hash"] == router_prompt["contentHash"]
    assert ex["provenance"]["generation"]["bridge_js_commit"] == bc.ready["js_commit"]
    assert ex["split"] == resolved_split


# --- synthesis_prompt_hash / judge_prompt_hash provenance (spec: "Provenance-
# tracked example schema") -----------------------------------------------

def test_synthesis_and_cold_prompt_hash_are_64_char_hex():
    assert isinstance(SYNTHESIS_PROMPT_HASH, str) and len(SYNTHESIS_PROMPT_HASH) == 64
    int(SYNTHESIS_PROMPT_HASH, 16)  # raises ValueError if not hex
    assert isinstance(COLD_PROMPT_HASH, str) and len(COLD_PROMPT_HASH) == 64
    int(COLD_PROMPT_HASH, 16)


def test_synthesis_and_cold_prompt_hash_appear_in_accepted_provenance():
    synth = FixedSampler("Perbaiki ejaan pada paragraf pembuka ini")
    cold = FixedSampler("EDIT_TEKS")
    accepted, rejected, review_queue = generate_router(
        synth, _family("EDIT_TEKS"), 1, "ROUTER SYSTEM PROMPT TEXT", cold_sampler=cold
    )
    assert len(accepted) == 1
    generation = accepted[0]["provenance"]["generation"]
    assert generation["synthesis_prompt_hash"] == SYNTHESIS_PROMPT_HASH
    # The cold-reclassification prompt plays the independent-checker role
    # here, so it is recorded as `judge_prompt_hash` (see gen_router.py
    # module comments next to `_COLD_CLASSIFY_TEMPLATE` / `COLD_PROMPT_HASH`).
    assert generation["judge_prompt_hash"] == COLD_PROMPT_HASH


def test_hash_constants_changes_when_a_synthesis_constant_changes():
    original = _hash_constants({"synthesis_template": "Tulis {n} pesan.", "intent_cues": {}})
    modified = _hash_constants({"synthesis_template": "Tulis {n} pesan berbeda.", "intent_cues": {}})
    assert original != modified
    # Sanity: hashing the same object twice is stable.
    assert original == _hash_constants({"synthesis_template": "Tulis {n} pesan.", "intent_cues": {}})


# --- D2 (ft-fixD): TinkerRouterTeacher.sample() strips trailing <|im_end|> --
# Mirrors test_gen_prose.py's TinkerProseTeacher stub-teacher tests: the
# decoded output feeds `_split_candidates` (the router synthesis path),
# which never itself stripped a trailing chat-template terminator, so the
# stripping has to happen in `.sample()` itself, same as gen_prose.py's
# TinkerProseTeacher.

from tantular.finetune.gen_router import TinkerRouterTeacher


class _StubRenderer:
    def build_generation_prompt(self, messages, role):
        return ("stub-prompt", messages, role)


class _StubResult:
    def __init__(self, tokens):
        self.sequences = [type("Seq", (), {"tokens": tokens})()]

    def result(self):
        return self


class _StubSamplingClient:
    def __init__(self, tokens):
        self._tokens = tokens

    def sample(self, prompt, num_samples, sampling_params):
        return _StubResult(self._tokens)


class _StubTokenizer:
    def __init__(self, decoded):
        self._decoded = decoded

    def decode(self, tokens):
        return self._decoded


def _router_teacher_with_stubbed_raw_sample(raw_text):
    """Construct a TinkerRouterTeacher with its Tinker-facing internals
    pre-populated by stubs, so `.sample()` never touches the real
    `tinker`/`tinker_cookbook` SDK (no network, no Tinker API call) --
    `_ensure_ready` short-circuits because `_sampling_client` is already set.
    """
    teacher = TinkerRouterTeacher()
    teacher._sampling_client = _StubSamplingClient(tokens=[1, 2, 3])
    teacher._tokenizer = _StubTokenizer(decoded=raw_text)
    teacher._renderer = _StubRenderer()
    teacher._sampling_params = object()
    return teacher


def test_tinker_router_teacher_sample_strips_trailing_im_end():
    teacher = _router_teacher_with_stubbed_raw_sample("EDIT_TEKS<|im_end|>")
    out = teacher.sample([{"role": "user", "content": "halo"}])
    assert out == "EDIT_TEKS"
    assert "<|im_end|>" not in out


def test_tinker_router_teacher_sample_preserves_mid_text_token():
    raw = 'Model menjelaskan token "<|im_end|>" sebagai penanda akhir giliran.'
    teacher = _router_teacher_with_stubbed_raw_sample(raw)
    out = teacher.sample([{"role": "user", "content": "halo"}])
    assert out == raw
