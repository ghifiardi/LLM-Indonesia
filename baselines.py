"""Baseline and reference outputs for Indonesian support evaluation."""

from __future__ import annotations

from typing import Any, Callable

from .dataset_env import EvalCase, DEFAULT_KB

Policy = Callable[[str, dict[str, Any]], str]


def generic_baseline_policy(query: str, kb: dict[str, Any] | None = None) -> str:
    """A deliberately weak baseline: polite but mostly non-specific."""

    return "Baik Kak, saya akan membantu. Silakan cek informasi melalui layanan pelanggan resmi."


def keyword_baseline_policy(query: str, kb: dict[str, Any] | None = None) -> str:
    """A simple non-learned keyword baseline for benchmark comparison."""

    q = query.lower()
    if any(token in q for token in ("otp", "kode", "cvv", "apk", "link", "whatsapp", "remote", "hadiah")):
        return "Baik Kak, jangan berikan OTP, PIN, CVV, kode, atau akses apa pun. Gunakan kanal resmi."
    if any(token in q for token in ("transfer", "pending", "saldo", "mutasi", "transaksi")):
        return "Baik Kak, cek status transaksi, simpan bukti, dan hubungi kanal resmi bila masih bermasalah."
    if any(token in q for token in ("kartu", "atm", "block", "blokir", "pin", "nomor hp")):
        return "Baik Kak, blokir atau ubah data kartu lewat aplikasi, call center, cabang resmi, dan ikuti verifikasi."
    if any(token in q for token in ("nik", "ktp", "kk", "ikd", "domisili")):
        return "Baik Kak, cek syarat dan verifikasi dokumen KTP/KK/NIK melalui Dukcapil atau kanal resmi."
    if "npwp" in q or "pajak" in q:
        return "Baik Kak, NPWP dan administrasi pajak dicek melalui DJP atau kanal resmi pajak."
    return generic_baseline_policy(query, kb or DEFAULT_KB)


def reference_policy(query: str, kb: dict[str, Any] | None = None) -> str:
    """A hand-written reference-style policy for cases lacking stored references."""

    return keyword_baseline_policy(query, kb or DEFAULT_KB)


BASELINE_POLICIES: dict[str, Policy] = {
    "generic": generic_baseline_policy,
    "keyword": keyword_baseline_policy,
}


def baseline_outputs_for_case(case: EvalCase, kb: dict[str, Any] | None = None) -> dict[str, str]:
    """Return stored baseline outputs plus generated standard baselines."""

    merged = dict(case.baseline_outputs)
    runtime_kb = kb or DEFAULT_KB
    for name, policy in BASELINE_POLICIES.items():
        merged.setdefault(name, policy(case.query, runtime_kb))
    return merged


def reference_output_for_case(case: EvalCase, kb: dict[str, Any] | None = None) -> str:
    """Return the case reference answer, falling back to the reference policy."""

    return case.reference_answer or reference_policy(case.query, kb or DEFAULT_KB)
