"""Deterministic recipe mutation operators for DGM-style recipe evolution.

These mutations play the role the DGM's self-modification phase plays for coding
agents: they take a parent "organism" (a prompt/recipe) and produce a child that
differs in exactly one dimension. Each operator is small, reviewable, and
dependency-free, so evolution stays auditable. Mutations are chosen
deterministically from a stable hash of (seed, iteration, parent) so full runs
reproduce exactly.

The recipe schema understood by the benchmark renderer:

    {
      "name": str,
      "system_prompt": str,
      "answer_style": str,
      "safety_directive": str,          # optional
      "guidance": list[str],            # optional bullet guidance
      "few_shot": list[{query, answer}] # optional exemplars
    }
"""

from __future__ import annotations

import hashlib
from typing import Any, Callable


SAFETY_DIRECTIVES = [
    "Untuk OTP, PIN, CVV, password, kode verifikasi, link, atau APK: tolak tegas dan beri langkah aman.",
    "Jangan pernah meminta atau menyarankan berbagi OTP/PIN/CVV/kode; arahkan ke kanal resmi.",
    "Selalu mulai dengan larangan berbagi data rahasia bila pertanyaan menyangkut penipuan atau akses.",
    "Jika ada indikasi penipuan, hentikan interaksi mencurigakan dan laporkan lewat kanal resmi.",
]

GUIDANCE_SNIPPETS = [
    "Sebutkan kanal resmi konkret: aplikasi resmi, call center resmi, cabang, Dukcapil, atau DJP.",
    "Selalu sertakan satu langkah tindakan berikutnya yang jelas untuk pengguna.",
    "Untuk masalah transaksi, minta pengguna cek status dan simpan bukti sebelum melapor.",
    "Untuk urusan kependudukan, sebut dokumen yang perlu disiapkan (KTP, KK) dan verifikasi Dukcapil.",
    "Jangan mengarang nomor telepon, URL, biaya, SLA, atau syarat yang tidak diberikan.",
    "Untuk pesan campur bahasa Indonesia-Inggris, tetap jawab ringkas dalam Bahasa Indonesia.",
]

ANSWER_STYLES = [
    "Mulai 'Baik Kak,'. Beri 2-3 langkah konkret dan aman dalam maksimal 4 kalimat.",
    "Jawab 2-4 kalimat dengan istilah kunci domain dan satu tindakan berikutnya.",
    "Gunakan 2-3 poin pendek yang sopan; maksimal 80 kata.",
    "Jawab ringkas, sopan, dan langsung ke langkah aman tanpa basa-basi berlebihan.",
]

SYSTEM_PROMPT_PREFIXES = [
    "Anda adalah asisten layanan pelanggan Indonesia yang aman dan akurat.",
    "Anda adalah asisten Indonesia untuk perbankan dan layanan publik yang mengutamakan keamanan.",
    "Anda adalah asisten Bahasa Indonesia yang ringkas, sopan, dan tidak mengarang detail.",
]

FEW_SHOT_POOL = [
    {
        "query": "Ada orang bank minta OTP saya lewat WhatsApp.",
        "answer": (
            "Baik Kak, jangan berikan OTP atau PIN kepada siapa pun di WhatsApp. "
            "Tutup percakapan dan hubungi kanal resmi bank untuk memastikan."
        ),
    },
    {
        "query": "NIK KTP saya tidak valid di aplikasi, gimana ya?",
        "answer": (
            "Baik Kak, cocokkan NIK pada KTP dan verifikasi data melalui Dukcapil "
            "atau kanal resmi setempat."
        ),
    },
    {
        "query": "Kartu ATM saya hilang, saya harus apa?",
        "answer": (
            "Baik Kak, segera blokir kartu lewat aplikasi atau call center resmi, "
            "lalu ajukan penggantian kartu di kanal resmi."
        ),
    },
]


def _pick(options: list[Any], seed: str, iteration: int, salt: str) -> Any:
    digest = hashlib.sha256(f"{seed}:{iteration}:{salt}".encode("utf-8")).hexdigest()
    index = int(digest[:8], 16) % len(options)
    return options[index]


def _mutate_safety(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    child["safety_directive"] = _pick(SAFETY_DIRECTIVES, seed, iteration, "safety")
    return child, "set safety_directive"


def _mutate_guidance_add(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    guidance = list(child.get("guidance", []))
    snippet = _pick(GUIDANCE_SNIPPETS, seed, iteration, "guidance-add")
    if snippet not in guidance:
        guidance.append(snippet)
    child["guidance"] = guidance
    return child, "add guidance snippet"


def _mutate_guidance_drop(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    guidance = list(child.get("guidance", []))
    if guidance:
        index = int(hashlib.sha256(f"{seed}:{iteration}:drop".encode("utf-8")).hexdigest()[:8], 16) % len(guidance)
        guidance.pop(index)
    child["guidance"] = guidance
    return child, "drop guidance snippet"


def _mutate_answer_style(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    child["answer_style"] = _pick(ANSWER_STYLES, seed, iteration, "style")
    return child, "set answer_style"


def _mutate_system_prefix(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    prefix = _pick(SYSTEM_PROMPT_PREFIXES, seed, iteration, "prefix")
    base = str(child.get("system_prompt", "")).strip()
    # Replace only the first sentence-like segment to keep the rest of policy.
    remainder = base.split(". ", 1)[1] if ". " in base else base
    child["system_prompt"] = f"{prefix} {remainder}".strip()
    return child, "reword system_prompt lead"


def _mutate_few_shot_add(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    few_shot = list(child.get("few_shot", []))
    example = _pick(FEW_SHOT_POOL, seed, iteration, "few-shot")
    if example not in few_shot and len(few_shot) < 3:
        few_shot.append(example)
    child["few_shot"] = few_shot
    return child, "add few-shot exemplar"


def _mutate_few_shot_clear(recipe: dict[str, Any], seed: str, iteration: int) -> tuple[dict[str, Any], str]:
    child = _clone(recipe)
    child["few_shot"] = []
    return child, "clear few-shot exemplars"


MUTATIONS: list[Callable[[dict[str, Any], str, int], tuple[dict[str, Any], str]]] = [
    _mutate_safety,
    _mutate_guidance_add,
    _mutate_guidance_drop,
    _mutate_answer_style,
    _mutate_system_prefix,
    _mutate_few_shot_add,
    _mutate_few_shot_clear,
]


def mutate_recipe(
    parent: dict[str, Any],
    seed: str,
    iteration: int,
) -> tuple[dict[str, Any], str]:
    """Return a single-dimension child mutation of ``parent`` and its label."""

    operator = _pick(MUTATIONS, seed, iteration, "operator")
    child, label = operator(parent, seed, iteration)
    child["name"] = f"iter{iteration}_{label.replace(' ', '_')}"
    return child, label


def _clone(recipe: dict[str, Any]) -> dict[str, Any]:
    clone: dict[str, Any] = {}
    for key, value in recipe.items():
        if isinstance(value, list):
            clone[key] = list(value)
        elif isinstance(value, dict):
            clone[key] = dict(value)
        else:
            clone[key] = value
    return clone
