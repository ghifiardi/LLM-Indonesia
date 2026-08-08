import pathlib

from tantular.finetune.bridge_client import BridgeClient
from tantular.finetune.families import assign_splits, enumerate_families, split_of
from tantular.finetune.gen_router import (
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
