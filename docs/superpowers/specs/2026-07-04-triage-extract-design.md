# Message Sense — Triage & Extract (Consumer Message Assistant, Cluster B)

**Status:** design + implementation candidate  
**Date:** 2026-07-04  
**Branch:** feat/tantular-model-naming

## Context

Cluster A shipped **Privacy Shield**: deterministic PII redaction before sharing.
Cluster B adds everyday utility on top of Tantular's existing safety verdict:
help users understand messages, spot due dates/amounts, and decide next steps.

Cluster B features:

| Feature | Dependency |
|---|---|
| Message summarization and triage | rules now; SLM can improve wording later |
| Action item extraction | rules now |
| Bill/payment reminder assistant | rules now |
| Promo/discount intelligence | rules now |

## Goal

Given a raw message and optional `RiskScorer` verdict, return a small structured
analysis that is useful for normal users:

- category: what kind of message is this?
- priority: how urgent is it?
- summary: one short Indonesian sentence
- extracted items: amount, date/deadline, order/resi/invoice IDs
- action items: what should the user do next?

Everything is deterministic, local, no network, no permissions.

## Non-goals

- No calendar/reminder creation yet. The app can suggest a reminder, but user
  confirmation and Android Calendar/Alarm integration come later.
- No SLM-generated prose yet. Cluster C will handle compose/explain/tone with
  on-device SLM.
- No database/storage beyond the existing Guard Log.

## Data model

Python reference:

```python
@dataclass(frozen=True)
class ExtractedItem:
    kind: str      # amount | date | code | sender_hint
    label: str     # human Indonesian label
    value: str

@dataclass(frozen=True)
class TriageResult:
    category: str  # keamanan_akun | penipuan | tagihan | promo | paket | jadwal | kerja | sekolah | umum
    category_label: str
    priority: str  # tinggi | sedang | rendah
    priority_label: str
    summary: str
    actions: list[str]
    items: list[ExtractedItem]
```

Public entry point:

```python
def triage_message(text: str, verdict: str | None = None, account_takeover: bool = False) -> TriageResult
```

Kotlin port: `MessageTriage.kt` with equivalent data classes and `analyze(...)`.

## Categories

Priority order:

1. `keamanan_akun` — account-takeover / OTP / login / linked device / reset password
2. `penipuan` — BLOCK/WARN fraud verdict or fraud keywords
3. `tagihan` — bills/payments: tagihan, bayar, jatuh tempo, invoice, BPJS, PLN, internet, angsuran, cicilan, sewa
4. `promo` — promo/discount/voucher/cashback/hadiah/undian/flash sale
5. `paket` — package/logistics/resi/COD/kurir/dikirim/ambil paket
6. `jadwal` — meeting/rapat/jadwal/appointment/interview/dokter/besok/lusa
7. `kerja` — HR/recruitment/job/office
8. `sekolah` — school/campus/class/teacher/family school notices
9. `umum` — fallback

## Priority

- `tinggi` if verdict BLOCK, account takeover, or keywords: segera, sekarang,
  diblokir, jatuh tempo, deadline, terakhir, expired/kadaluarsa.
- `sedang` if date/deadline extracted or category is tagihan/paket/jadwal.
- `rendah` otherwise.

## Extraction

- Amount: `Rp150.000`, `IDR 150000`, `150.000 rupiah`
- Date/time: numeric date, Indonesian month, hari ini, besok, lusa, minggu ini
- Codes: resi/invoice/order/booking/pesanan + alphanumeric token

## Actions

Examples:

- Security/fraud: "Jangan klik tautan atau kirim kode. Cek lewat aplikasi resmi."
- Bill: "Cek tagihan di aplikasi resmi sebelum membayar."
- Promo: "Cek masa berlaku dan syarat promo. Jangan kirim data sensitif."
- Package: "Cek resi di aplikasi resmi atau situs kurir."
- Schedule: "Buat pengingat agar tidak terlewat."
- General: "Tidak ada tindakan khusus. Simpan jika diperlukan."

## Testing

At minimum:

1. Clean chat → `umum`, `rendah`, no required action.
2. Bill with amount + date → `tagihan`, amount/date extracted, payment action.
3. Promo with voucher/cashback → `promo`, promo action.
4. Package with resi/COD → `paket`, code/amount extracted.
5. Meeting tomorrow → `jadwal`, date extracted, reminder action.
6. OTP takeover → `keamanan_akun`, `tinggi`, safe action.
7. BLOCK verdict overrides category to `penipuan`/security and high priority.
