"""Deterministic mutation provider used for offline smoke tests.

In a real Gödel-Agent implementation this role would be played by an LLM that
reads SelfState and proposes actions/code patches. This provider gives a safe,
repeatable demonstration without external API calls.
"""

from __future__ import annotations

from .godel_agent import Action, MutationProvider, SelfState


class RuleBasedIndonesianSupportMutator(MutationProvider):
    """Progressively proposes better Indonesian support policies."""

    def propose_actions(self, state: SelfState) -> list[Action]:
        if state.iteration == 1:
            return [
                Action("think", "Baseline is generic; add keyword routing and official-channel language."),
                Action("self_update", "Add Indonesian keyword routing for banking, fraud, NIK, and NPWP.", POLICY_V1),
                Action("continue_improve", "Evaluate whether the keyword policy needs refinement."),
            ]
        if state.iteration == 2:
            return [
                Action("think", "Improve safety: avoid accidentally asking for OTP/PIN in lost-card flow."),
                Action("self_update", "Separate phishing from lost-card handling and improve local terms.", POLICY_V2),
                Action("continue_improve", "One more pass for scoring gaps."),
            ]
        if state.iteration == 3:
            return [
                Action("think", "Add concise polite tone markers and explicit regulator/service channels."),
                Action("self_update", "Add consistent polite Indonesian support tone.", POLICY_V3),
                Action("continue_improve", "Check whether keyword ordering causes false intent matches."),
            ]
        if state.iteration == 4:
            return [
                Action("think", "Feedback shows transfer questions can contain the word hilang; check transfer before lost-card."),
                Action("self_update", "Prioritize transfer intent before generic hilang keyword.", POLICY_V4),
                Action("continue_improve", "Stop after intent-ordering fix."),
            ]
        return []


POLICY_V1 = r'''
def solve(query: str, kb: dict) -> str:
    q = query.lower()
    if "otp" in q or "whatsapp" in q:
        return "Jangan berikan OTP, PIN, CVV, password, atau kode verifikasi. Gunakan kanal resmi bank."
    if "kartu" in q or "atm" in q or "hilang" in q:
        return "Segera blokir kartu melalui mobile banking atau call center resmi, lalu minta penggantian kartu."
    if "transfer" in q or "pending" in q:
        return "Cek status transaksi, simpan bukti transfer, dan hubungi kanal resmi bila belum selesai."
    if "nik" in q or "ktp" in q:
        return "NIK pada KTP perlu dicek melalui kanal Dukcapil resmi."
    if "npwp" in q:
        return "NPWP terkait administrasi pajak dan dapat dicek lewat DJP resmi."
    return "Mohon gunakan kanal resmi untuk informasi terbaru."
'''


POLICY_V2 = r'''
def solve(query: str, kb: dict) -> str:
    q = query.lower()
    if "otp" in q or "kode" in q or "whatsapp" in q:
        return "Jangan berikan OTP, PIN, CVV, password, atau kode verifikasi kepada siapa pun. Tutup percakapan dan hubungi kanal resmi bank."
    if "kartu" in q or "atm" in q or "hilang" in q:
        return "Segera blokir kartu melalui mobile banking, call center resmi, atau cabang. Setelah aman, ajukan penggantian kartu."
    if "transfer" in q or "pending" in q:
        return "Cek status transaksi di aplikasi, simpan bukti transfer, dan hubungi kanal resmi bila dana belum kembali sesuai SLA."
    if "nik" in q or "ktp" in q:
        return "NIK adalah Nomor Induk Kependudukan pada KTP. Untuk data tidak valid, cocokkan data dan verifikasi lewat kanal Dukcapil resmi."
    if "npwp" in q:
        return "NPWP digunakan untuk administrasi pajak. Untuk validasi, cek melalui kanal DJP resmi."
    return "Sebaiknya gunakan kanal resmi agar informasi dan tindak lanjut tetap aman."
'''


POLICY_V3 = r'''
def solve(query: str, kb: dict) -> str:
    q = query.lower()
    prefix = "Baik Kak, "
    if "otp" in q or "kode" in q or "whatsapp" in q:
        return prefix + "jangan berikan OTP, PIN, CVV, password, atau kode verifikasi kepada siapa pun. Tutup percakapan dan hubungi kanal resmi bank."
    if "kartu" in q or "atm" in q or "hilang" in q:
        return prefix + "segera blokir kartu melalui mobile banking, call center resmi, atau cabang. Setelah aman, ajukan penggantian kartu."
    if "transfer" in q or "pending" in q:
        return prefix + "cek status transaksi di aplikasi, simpan bukti transfer, dan hubungi kanal resmi bila dana belum kembali sesuai SLA."
    if "nik" in q or "ktp" in q:
        return prefix + "NIK adalah Nomor Induk Kependudukan pada KTP. Mohon cocokkan data dan verifikasi lewat kanal Dukcapil resmi."
    if "npwp" in q:
        return prefix + "NPWP digunakan untuk administrasi pajak. Mohon validasi melalui kanal DJP resmi."
    return prefix + "sebaiknya gunakan kanal resmi agar informasi dan tindak lanjut tetap aman."
'''


POLICY_V4 = r'''
def solve(query: str, kb: dict) -> str:
    q = query.lower()
    prefix = "Baik Kak, "
    if "otp" in q or "kode" in q or "whatsapp" in q:
        return prefix + "jangan berikan OTP, PIN, CVV, password, atau kode verifikasi kepada siapa pun. Tutup percakapan dan hubungi kanal resmi bank."
    if "transfer" in q or "pending" in q:
        return prefix + "cek status transaksi di aplikasi, simpan bukti transfer, dan hubungi kanal resmi bila dana belum kembali sesuai SLA."
    if "kartu" in q or "atm" in q or "hilang" in q:
        return prefix + "segera blokir kartu melalui mobile banking, call center resmi, atau cabang. Setelah aman, ajukan penggantian kartu."
    if "nik" in q or "ktp" in q:
        return prefix + "NIK adalah Nomor Induk Kependudukan pada KTP. Mohon cocokkan data dan verifikasi lewat kanal Dukcapil resmi."
    if "npwp" in q:
        return prefix + "NPWP digunakan untuk administrasi pajak. Mohon validasi melalui kanal DJP resmi."
    return prefix + "sebaiknya gunakan kanal resmi agar informasi dan tindak lanjut tetap aman."
'''
