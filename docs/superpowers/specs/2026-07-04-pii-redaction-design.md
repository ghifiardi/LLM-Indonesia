# Privacy Shield — PII Redaction (Consumer Message Assistant, Cluster A)

**Status:** design, awaiting review
**Date:** 2026-07-04
**Branch:** feat/tantular-model-naming

## Context

The Consumer Message Assistant is a 10-feature suite that decomposes into four
clusters, each its own spec → plan → build cycle:

| Cluster | Features | Model dependency |
|---|---|---|
| **A. Privacy shield** | PII redaction before sharing | None (regex) |
| **B. Triage & extract** | summarization/triage, action items, bill reminders, promo intel | rules now, SLM upgrades |
| **C. Compose** | smart reply, tone rewrite/translate, plain-language explanation | SLM required |
| **D. Ambient** | notification digest, family/elder assistant | composes A–C |

This spec covers **Cluster A only**. It is the first slice because it is fully
deterministic (works on-device today, no SLM, no permissions), carries the
highest privacy payoff (stops users leaking NIK/OTP/card numbers when forwarding
a message to a fake "CS"), and slots beside the existing `RiskScorer` as a
sibling deterministic module — the proven Python-reference-then-Kotlin-port
pattern in this project.

## Goal

Given raw message text, mask sensitive Indonesian identifiers **before** the user
forwards or shares it. 100% local, no network, no permissions.

Non-goals (YAGNI for this slice): name detection (unreliable deterministically),
address detection, any SLM involvement, any UI beyond a single "sensor" action.

## Module

`tantular_assistant.py` (Python reference). Kotlin port `PiiRedactor.kt` follows
after Python + tests are green.

### Detectors (regex, Indonesian-tuned)

| kind | label | rule |
|---|---|---|
| `nik` | Nomor KTP (NIK) | 16 digits, not Luhn-valid; context boost near `KTP`/`NIK` |
| `phone` | Nomor HP | `+62` or `0` prefix + `8xx`, total 9–13 digits |
| `otp` | Kode OTP/PIN | 4–8 digits within a window of `OTP`/`kode`/`verifikasi`/`PIN`/`password` — **always fully masked** |
| `card` | Nomor kartu | 13–19 digits, **Luhn-valid** |
| `account` | Nomor rekening | digit run near `rekening`/`no rek`/`a/n`/`atas nama` |
| `email` | Email | standard email regex |
| `plate` | Plat nomor | `[A-Z]{1,2} ?\d{1,4} ?[A-Z]{1,3}` |

### Masking

Typed, partial-reveal placeholders that keep just enough tail to be recognizable:

- `[NIK•••1234]`, `[HP•••7890]`, `[KARTU•••3456]`, `[REK•••0987]`
- `[OTP•••••]` — OTP is **fully** masked (revealing any part defeats the point)
- `[EMAIL•••@•••]`, `[PLAT•••]`

Replacements are applied **right-to-left** by span so earlier indices stay valid.
Redaction only masks matched spans; all other characters pass through untouched.

### Data model

```python
@dataclass(frozen=True)
class PiiFinding:
    kind: str        # "nik" | "phone" | "otp" | "card" | "account" | "email" | "plate"
    label: str       # human, Bahasa Indonesia
    original: str
    masked: str
    start: int
    end: int

@dataclass
class RedactionResult:
    original_text: str
    redacted_text: str
    findings: list[PiiFinding]
    def has_sensitive(self) -> bool          # bool(findings)
    def summary(self) -> str                 # "Ditemukan 2 data sensitif: 1 NIK, 1 OTP"
```

Public entry point:

```python
def redact_pii(text: str) -> RedactionResult
```

### Overlap / precedence

A 16-digit run is ambiguous (NIK vs card). Rule:

1. If Luhn-valid and 13–19 digits → `card`.
2. Else if exactly 16 digits → `nik`.
3. OTP match wins over a bare phone/number match when the digit window overlaps a
   trigger keyword.

Detectors run in a fixed priority order; once a span is claimed, later detectors
skip overlapping spans (interval bookkeeping) so a number is never double-tagged.

### Error handling

- `None` / empty / whitespace-only → `RedactionResult(text or "", text or "", [])`.
- Never raises on malformed input; regex only, no parsing that can throw.

## Testing (smoke tests, extend `smoke_test.py`)

Indonesian sample messages, each asserting both **what was found** and **that the
raw value no longer appears** in `redacted_text`:

1. Scam asking for OTP: "Kode OTP Anda 483920, jangan beri ke siapa pun" → 1 `otp`, `"483920"` absent.
2. Rekening transfer: "transfer ke rek 1234567890 a/n Budi" → 1 `account`.
3. KTP leak: "NIK saya 3174012509900001" → 1 `nik`.
4. Card: a Luhn-valid 16-digit test number → 1 `card`, not tagged `nik`.
5. Mixed: phone + email in one message → 2 findings, both masked.
6. Clean message: "Halo, jam berapa kita ketemu?" → 0 findings, text unchanged.
7. Empty/None → empty result, no exception.

## Follow-on (out of scope here, tracked for later slices)

- `PiiRedactor.kt` Kotlin port + `PiiRedactorTest.kt`.
- App: "🔒 Sensor data sensitif" action → shows `redacted_text` + Copy, so the user
  forwards the safe version. Reuses the existing paste/share entry points.
- Clusters B/C/D each get their own spec.
