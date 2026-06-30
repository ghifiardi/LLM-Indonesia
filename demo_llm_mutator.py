"""Demo: run the Gödel-Agent loop with an LLM-backed mutation provider.

By default this uses an OFFLINE MockTransport so it runs without network access.
To use a real local/hosted model, set GODEL_LLM_LIVE=1 and the connection env:

    GODEL_LLM_BASE_URL=http://localhost:11434/v1
    GODEL_LLM_MODEL=qwen2.5:3b-instruct
    GODEL_LLM_API_KEY=...            # optional for local servers

Then:  python3 -m godel_agent_prototype.demo_llm_mutator
"""

from __future__ import annotations

import os

from .dataset_env import DatasetSupportEnvironment
from .godel_agent import GodelAgent
from .llm_mutator import (
    LLMMutationProvider,
    MockTransport,
    OpenAICompatibleTransport,
)

EVAL_DIR = os.path.join(os.path.dirname(__file__), "eval_sets")

INITIAL_POLICY = r'''
def solve(query: str, kb: dict) -> str:
    return "Saya akan membantu. Silakan hubungi layanan pelanggan."
'''

# Canned "LLM" responses for the offline demo: each step proposes a better policy.
MOCK_RESPONSES = [
    "Tambahkan keyword routing dasar untuk keamanan dan kanal resmi.\n```python\n"
    "def solve(query, kb):\n"
    "    q = query.lower()\n"
    "    if 'otp' in q or 'kode' in q or 'link' in q or 'whatsapp' in q or 'hadiah' in q:\n"
    "        return 'Baik Kak, jangan berikan OTP, PIN, atau kode verifikasi. Jangan klik link mencurigakan dan verifikasi lewat kanal resmi.'\n"
    "    if 'transfer' in q or 'pending' in q or 'terpotong' in q or 'gagal' in q:\n"
    "        return 'Baik Kak, cek status transaksi, simpan bukti, dan buat laporan ke kanal resmi sesuai SLA.'\n"
    "    if 'kartu' in q or 'atm' in q or 'block' in q or 'hilang' in q:\n"
    "        return 'Baik Kak, segera blokir kartu via kanal resmi lalu ajukan penggantian.'\n"
    "    if 'nik' in q or 'ktp' in q:\n"
    "        return 'Baik Kak, NIK KTP diverifikasi lewat Dukcapil resmi; mohon cek syarat di kanal resmi.'\n"
    "    if 'npwp' in q:\n"
    "        return 'Baik Kak, NPWP untuk pajak; validasi lewat DJP resmi.'\n"
    "    return 'Baik Kak, sebaiknya gunakan kanal resmi.'\n"
    "```",
    "Perbaiki: aktivasi mobile banking dan istilah verifikasi belum tertangani.\n```python\n"
    "def solve(query, kb):\n"
    "    q = query.lower()\n"
    "    if 'otp' in q or 'kode' in q or 'link' in q or 'whatsapp' in q or 'hadiah' in q:\n"
    "        return 'Baik Kak, jangan berikan OTP, PIN, atau kode verifikasi kepada siapa pun. Jangan klik link mencurigakan dan lakukan verifikasi hanya lewat kanal resmi.'\n"
    "    if 'aktivasi' in q or 'mobile banking' in q:\n"
    "        return 'Baik Kak, lakukan aktivasi mobile banking lewat aplikasi resmi dan selesaikan verifikasi sesuai instruksi resmi.'\n"
    "    if 'transfer' in q or 'pending' in q or 'terpotong' in q or 'gagal' in q:\n"
    "        return 'Baik Kak, cek status transaksi, simpan bukti, dan ajukan laporan ke kanal resmi sesuai SLA.'\n"
    "    if 'kartu' in q or 'atm' in q or 'block' in q or 'hilang' in q:\n"
    "        return 'Baik Kak, segera blokir kartu lewat kanal resmi lalu ajukan penggantian kartu.'\n"
    "    if 'nik' in q or 'ktp' in q:\n"
    "        return 'Baik Kak, NIK pada KTP diverifikasi lewat Dukcapil resmi; mohon cek syarat melalui kanal resmi.'\n"
    "    if 'npwp' in q:\n"
    "        return 'Baik Kak, NPWP untuk administrasi pajak; mohon validasi lewat DJP resmi.'\n"
    "    return 'Baik Kak, sebaiknya gunakan kanal resmi untuk informasi terbaru.'\n"
    "```",
]


def build_transport():
    if os.environ.get("GODEL_LLM_LIVE") == "1":
        return OpenAICompatibleTransport()
    return MockTransport(responses=MOCK_RESPONSES)


def main() -> None:
    env = DatasetSupportEnvironment.from_jsonl_dir(EVAL_DIR)
    transport = build_transport()
    agent = GodelAgent(
        policy_code=INITIAL_POLICY,
        environment=env,
        mutation_provider=LLMMutationProvider(transport=transport, max_iterations=4),
        max_depth=5,
    )
    result = agent.run()
    print(f"Mode: {'LIVE' if os.environ.get('GODEL_LLM_LIVE') == '1' else 'OFFLINE-MOCK'}")
    print(f"Best score: {result.combined_score:.3f}")
    final = env.evaluate(agent.best_policy)
    print(f"Category means: {final.public['category_means']}")
    print("\nHistory:")
    for event in result.public["history"]:
        print(f"- {event}")
    print("\nBest policy:\n")
    print(agent.best_policy_code)


if __name__ == "__main__":
    main()
