"""Tantular Consumer Message Assistant — Cluster A: Privacy Shield (PII redaction).

Fully deterministic, on-device-ready, no network, no permissions. Given raw
message text, mask sensitive Indonesian identifiers BEFORE the user forwards or
shares it. This is the Python reference; the Kotlin port lives in
`PiiRedactor.kt` and must agree with this module.

Design: docs/superpowers/specs/2026-07-04-pii-redaction-design.md
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PiiFinding:
    kind: str        # nik | phone | otp | card | account | email | plate | order | medical | address
    label: str       # human, Bahasa Indonesia
    original: str
    masked: str
    start: int
    end: int


@dataclass
class RedactionResult:
    original_text: str
    redacted_text: str
    findings: list[PiiFinding] = field(default_factory=list)

    def has_sensitive(self) -> bool:
        return bool(self.findings)

    def summary(self) -> str:
        if not self.findings:
            return "Tidak ada data sensitif terdeteksi."
        labels = {
            "nik": "NIK", "phone": "nomor HP", "otp": "OTP/PIN", "card": "nomor kartu",
            "account": "nomor rekening", "email": "email", "plate": "plat nomor",
            "order": "order/resi", "medical": "ID medis", "address": "alamat",
        }
        counts: dict[str, int] = {}
        for f in self.findings:
            counts[f.kind] = counts.get(f.kind, 0) + 1
        parts = [f"{n} {labels.get(k, k)}" for k, n in counts.items()]
        return f"Ditemukan {len(self.findings)} data sensitif: " + ", ".join(parts) + "."


# --- helpers ---------------------------------------------------------------

def _luhn_valid(digits: str) -> bool:
    d = [int(c) for c in digits if c.isdigit()]
    if len(d) < 13:
        return False
    total = 0
    parity = len(d) % 2
    for i, n in enumerate(d):
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _last4(digits: str) -> str:
    only = re.sub(r"\D", "", digits)
    return only[-4:] if len(only) >= 4 else only


# Trigger keywords for keyword-anchored detectors.
_OTP_TRIGGER = re.compile(r"(?i)(otp|kode|verifikasi|verification|pin|password|sandi)")
_ACCT_TRIGGER = re.compile(r"(?i)(rekening|no\.?\s*rek|a/?n|atas nama|norek|rek\.)")

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PLATE_RE = re.compile(r"\b(B|D|F|T|Z|E|A|G|H|K|R|AA|AB|AD|L|M|N|P|S|W|AE|AG|DK|DR|EA|DH|EB|ED|KB|DA|KH|KT|KU|DB|DL|DM|DN|DT|DD|DC|DE|DG|PA|PB) ?\d{1,4} ?[A-Z]{0,3}\b")
_PHONE_RE = re.compile(r"(?<!\d)(?:\+62|62|0)8\d{7,12}(?!\d)")
_NIK_RE = re.compile(r"(?<!\d)\d{16}(?!\d)")
# digit runs (with optional space/dash separators) 13-19 long → card candidates
_LONGNUM_RE = re.compile(r"(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])")
# generic digit run 6-20 for account detection near a trigger
_NUM_RE = re.compile(r"(?<!\d)\d{6,20}(?!\d)")
# OTP/PIN: 4-8 digits
_SHORTNUM_RE = re.compile(r"(?<!\d)\d{4,8}(?!\d)")
_ORDER_TRIGGER = re.compile(r"(?i)(order|pesanan|resi|invoice|inv|booking|kode booking|nomor pesanan)")
_MEDICAL_TRIGGER = re.compile(r"(?i)(rekam medis|no\.?\s*rm|nomor rm|id pasien|nomor pasien|medical record|bpjs kesehatan|no\.?\s*bpjs)")
# Context-anchored address: label + text up to comma/newline/period or 90 chars.
_ADDRESS_RE = re.compile(r"(?i)\b(alamat(?:\s+(?:rumah|pengiriman|kantor|saya))?|kirim\s+ke|dikirim\s+ke|domisili)\s*[:\-]?\s*([^\n.;]{8,90})")
# Generic ID near order/medical labels (alphanumeric to allow invoice/resi codes).
_ID_TOKEN_RE = re.compile(r"(?<![A-Z0-9])([A-Z0-9][A-Z0-9\-]{4,24})(?![A-Z0-9])", re.I)


def _overlaps(claimed: list[tuple[int, int]], start: int, end: int) -> bool:
    return any(start < e and s < end for s, e in claimed)


def redact_pii(text: str | None) -> RedactionResult:
    if not text or not text.strip():
        base = text or ""
        return RedactionResult(base, base, [])

    findings: list[PiiFinding] = []
    claimed: list[tuple[int, int]] = []

    def claim(start: int, end: int, kind: str, label: str, mask: str) -> None:
        findings.append(PiiFinding(kind, label, text[start:end], mask, start, end))
        claimed.append((start, end))

    # Priority order (spec): OTP (keyword) > card (Luhn) > NIK > account (keyword)
    # > phone > email > plate. Claimed spans block later overlapping detectors.

    # 1) OTP / PIN — short digit run within a keyword window; ALWAYS fully masked.
    for m in _SHORTNUM_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        window = text[max(0, s - 30):min(len(text), e + 15)]
        if _OTP_TRIGGER.search(window):
            claim(s, e, "otp", "Kode OTP/PIN", "[OTP\u2022\u2022\u2022\u2022\u2022]")

    # 2) Card — 13-19 digits, Luhn-valid.
    for m in _LONGNUM_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        raw = m.group()
        digits = re.sub(r"\D", "", raw)
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            claim(s, e, "card", "Nomor kartu", f"[KARTU\u2022\u2022\u2022{_last4(raw)}]")

    # 3) NIK — exactly 16 digits (not already claimed as card).
    for m in _NIK_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        claim(s, e, "nik", "Nomor KTP (NIK)", f"[NIK\u2022\u2022\u2022{_last4(m.group())}]")

    # 4) Account — digit run near a rekening keyword.
    for m in _NUM_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        window = text[max(0, s - 25):min(len(text), e + 10)]
        if _ACCT_TRIGGER.search(window):
            claim(s, e, "account", "Nomor rekening", f"[REK\u2022\u2022\u2022{_last4(m.group())}]")

    # 5) Order / resi / invoice / booking IDs near an order keyword.
    for m in _ID_TOKEN_RE.finditer(text):
        s, e = m.start(1), m.end(1)
        if _overlaps(claimed, s, e):
            continue
        window = text[max(0, s - 30):min(len(text), e + 12)]
        if _ORDER_TRIGGER.search(window):
            claim(s, e, "order", "Order/Resi/Invoice", f"[ORDER•••{m.group(1)[-4:]}]")

    # 6) Medical / patient IDs near a medical keyword.
    for m in _ID_TOKEN_RE.finditer(text):
        s, e = m.start(1), m.end(1)
        if _overlaps(claimed, s, e):
            continue
        window = text[max(0, s - 35):min(len(text), e + 15)]
        if _MEDICAL_TRIGGER.search(window):
            claim(s, e, "medical", "ID medis/pasien", f"[MEDIS•••{m.group(1)[-4:]}]")

    # 7) Phone — +62/62/0 then 8xx.
    for m in _PHONE_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        claim(s, e, "phone", "Nomor HP", f"[HP\u2022\u2022\u2022{_last4(m.group())}]")

    # 8) Email.
    for m in _EMAIL_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        claim(s, e, "email", "Email", "[EMAIL\u2022\u2022\u2022@\u2022\u2022\u2022]")

    # 9) Plate.
    for m in _PLATE_RE.finditer(text):
        s, e = m.start(), m.end()
        if _overlaps(claimed, s, e):
            continue
        claim(s, e, "plate", "Plat nomor", "[PLAT\u2022\u2022\u2022]")

    # 10) Address — context anchored. Mask the address text only, keeping label.
    for m in _ADDRESS_RE.finditer(text):
        s, e = m.start(2), m.end(2)
        # Trim trailing spaces/commas inside capture.
        while e > s and text[e - 1] in " ,":
            e -= 1
        if e - s < 8 or _overlaps(claimed, s, e):
            continue
        claim(s, e, "address", "Alamat", "[ALAMAT•••]")

    # Apply replacements right-to-left so earlier indices stay valid.
    findings.sort(key=lambda f: f.start)
    redacted = text
    for f in sorted(findings, key=lambda f: f.start, reverse=True):
        redacted = redacted[:f.start] + f.masked + redacted[f.end:]

    return RedactionResult(text, redacted, findings)


# --- self test -------------------------------------------------------------

def _self_test() -> bool:
    ok = True

    def check(name, cond):
        nonlocal ok
        status = "ok" if cond else "FAIL"
        if not cond:
            ok = False
        print(f"[{status}] {name}")

    r = redact_pii("Kode OTP Anda 483920, jangan beri ke siapa pun")
    check("otp found", sum(f.kind == "otp" for f in r.findings) == 1)
    check("otp value masked", "483920" not in r.redacted_text)

    r = redact_pii("transfer ke rek 1234567890 a/n Budi")
    check("account found", sum(f.kind == "account" for f in r.findings) == 1)
    check("account masked", "1234567890" not in r.redacted_text)

    r = redact_pii("NIK saya 3174012509900001 ya")
    check("nik found", sum(f.kind == "nik" for f in r.findings) == 1)
    check("nik not tagged card", all(f.kind != "card" for f in r.findings))

    r = redact_pii("kartu 4539578763621486 milik saya")  # Luhn-valid 16 digit
    check("card found", sum(f.kind == "card" for f in r.findings) == 1)
    check("card not tagged nik", all(f.kind != "nik" for f in r.findings))

    r = redact_pii("hubungi 081234567890 atau email budi@example.com")
    check("phone+email = 2", len(r.findings) == 2)
    check("phone masked", "081234567890" not in r.redacted_text)
    check("email masked", "budi@example.com" not in r.redacted_text)


    r = redact_pii("Alamat pengiriman: Jl Mawar No 10 RT 02 RW 03 Jakarta")
    check("address found", sum(f.kind == "address" for f in r.findings) == 1)
    check("address masked", "Jl Mawar" not in r.redacted_text)

    r = redact_pii("Pesanan INV-AB12345 sudah dikirim dengan resi JP987654321")
    check("order ids found", sum(f.kind == "order" for f in r.findings) >= 1)
    check("order id masked", "AB12345" not in r.redacted_text or "JP987654321" not in r.redacted_text)

    r = redact_pii("No RM pasien RM123456 dan BPJS Kesehatan 0001234567890")
    check("medical ids found", sum(f.kind == "medical" for f in r.findings) >= 1)
    check("medical masked", "RM123456" not in r.redacted_text or "0001234567890" not in r.redacted_text)

    r = redact_pii("Halo, jam berapa kita ketemu?")
    check("clean = 0 findings", len(r.findings) == 0)
    check("clean unchanged", r.redacted_text == "Halo, jam berapa kita ketemu?")

    r = redact_pii("")
    check("empty no exception", r.redacted_text == "" and not r.has_sensitive())

    print("summary example:", redact_pii("OTP 483920 dan NIK 3174012509900001").summary())
    print("self-test", "OK" if ok else "FAILED")
    return ok


# ---------------------------------------------------------------------------
# Cluster B: Message Sense — triage & extraction
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ExtractedItem:
    kind: str       # amount | date | code | sender_hint
    label: str
    value: str


@dataclass(frozen=True)
class TriageResult:
    category: str
    category_label: str
    priority: str
    priority_label: str
    summary: str
    actions: list[str]
    items: list[ExtractedItem]


_AMOUNT_RE = re.compile(r"(?i)(rp\s?\d[\d\.,]*|idr\s?\d[\d\.,]*|\d[\d\.,]*\s?rupiah)")
_DATE_RE = re.compile(r"(?i)(\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{1,2}\s?(jan|feb|mar|apr|mei|jun|jul|agu|agustus|sep|okt|nov|des)\w*\b|hari ini|besok|lusa|minggu ini|bulan ini)")
_CODE_RE = re.compile(r"(?i)\b(order|pesanan|resi|invoice|inv|booking)[:#\s-]*([A-Z0-9-]{5,})")

_CATEGORY_LABELS = {
    "keamanan_akun": "Keamanan akun",
    "penipuan": "Risiko penipuan",
    "tagihan": "Tagihan / pembayaran",
    "promo": "Promo / penawaran",
    "paket": "Pengiriman / paket",
    "jadwal": "Jadwal / pertemuan",
    "kerja": "Kerja / HR",
    "sekolah": "Sekolah / keluarga",
    "umum": "Pesan umum",
}

_PRIORITY_LABELS = {"tinggi": "Penting", "sedang": "Perlu dicek", "rendah": "Biasa"}


def _has_any(lower: str, *terms: str) -> bool:
    return any(t in lower for t in terms)


def _first_sentence(text: str) -> str:
    chunk = re.split(r"[\n.]", text.strip(), maxsplit=1)[0].strip()
    return (chunk or text.strip())[:140]


def _extract_items(text: str) -> list[ExtractedItem]:
    items: list[ExtractedItem] = []
    for m in _AMOUNT_RE.finditer(text):
        items.append(ExtractedItem("amount", "Nominal", m.group().strip()))
    for m in _DATE_RE.finditer(text):
        items.append(ExtractedItem("date", "Tanggal/batas waktu", m.group().strip()))
    for m in _CODE_RE.finditer(text):
        items.append(ExtractedItem("code", m.group(1).upper(), m.group(2)))
    # Keep first occurrence of exact label/value to avoid noisy duplicates.
    out: list[ExtractedItem] = []
    seen: set[tuple[str, str, str]] = set()
    for it in items:
        key = (it.kind, it.label, it.value.lower())
        if key not in seen:
            seen.add(key)
            out.append(it)
    return out[:6]


def _category(lower: str, verdict: str | None, account_takeover: bool) -> str:
    verdict_u = (verdict or "").upper()
    if account_takeover or _has_any(lower, "otp", "kode verifikasi", "kode login", "perangkat tertaut", "linked device", "reset password", "akun diblokir"):
        return "keamanan_akun"
    if verdict_u == "BLOCK" or _has_any(lower, "penipuan", "apk", "anydesk", "teamviewer", "remote access"):
        return "penipuan"
    if _has_any(lower, "tagihan", "jatuh tempo", "bayar", "pembayaran", "invoice", "bpjs", "listrik", "pln", "internet", "angsuran", "cicilan", "sewa"):
        return "tagihan"
    if _has_any(lower, "promo", "diskon", "voucher", "cashback", "gratis", "flash sale", "undian", "hadiah"):
        return "promo"
    if _has_any(lower, "paket", "kurir", "resi", "dikirim", "pengiriman", "cod", "ambil paket"):
        return "paket"
    if _has_any(lower, "meeting", "rapat", "jadwal", "appointment", "janji", "wawancara", "interview", "kontrol", "dokter", "besok", "lusa"):
        return "jadwal"
    if _has_any(lower, "hr", "rekrut", "lamaran", "kandidat", "kantor", "kerja"):
        return "kerja"
    if _has_any(lower, "sekolah", "kampus", "guru", "kelas", "siswa", "orang tua"):
        return "sekolah"
    return "umum"


def _priority(lower: str, category: str, items: list[ExtractedItem], verdict: str | None, account_takeover: bool) -> str:
    verdict_u = (verdict or "").upper()
    if verdict_u == "BLOCK" or account_takeover or _has_any(lower, "segera", "sekarang", "diblokir", "jatuh tempo", "deadline", "terakhir", "expired", "kadaluarsa"):
        return "tinggi"
    if any(i.kind == "date" for i in items) or category in {"tagihan", "paket", "jadwal"}:
        return "sedang"
    return "rendah"


def _actions(category: str, priority: str, verdict: str | None, account_takeover: bool) -> list[str]:
    verdict_u = (verdict or "").upper()
    if verdict_u == "BLOCK" or account_takeover or category in {"keamanan_akun", "penipuan"}:
        return [
            "Jangan klik tautan, jangan kirim kode/OTP, dan jangan install aplikasi.",
            "Cek langsung lewat aplikasi atau kanal resmi.",
        ]
    if category == "tagihan":
        return ["Cek tagihan di aplikasi resmi sebelum membayar.", "Simpan atau buat pengingat bila ada batas waktu."]
    if category == "promo":
        return ["Cek masa berlaku dan syarat promo.", "Jangan kirim data sensitif untuk klaim promo."]
    if category == "paket":
        return ["Cek nomor resi di aplikasi resmi atau situs kurir.", "Pastikan nominal COD sesuai pesanan."]
    if category == "jadwal":
        return ["Buat pengingat agar tidak terlewat.", "Balas konfirmasi jika pengirimnya jelas."]
    if priority == "tinggi":
        return ["Periksa segera lewat kanal resmi sebelum bertindak."]
    return ["Tidak ada tindakan khusus. Simpan pesan jika diperlukan."]


def triage_message(text: str | None, verdict: str | None = None, account_takeover: bool = False) -> TriageResult:
    raw = (text or "").strip()
    lower = raw.lower()
    items = _extract_items(raw)
    cat = _category(lower, verdict, account_takeover)
    prio = _priority(lower, cat, items, verdict, account_takeover)
    actions = _actions(cat, prio, verdict, account_takeover)
    key = _first_sentence(raw) if raw else "Pesan kosong"
    item_txt = ""
    if items:
        item_txt = " Info penting: " + "; ".join(f"{i.label}: {i.value}" for i in items[:3]) + "."
    risk_txt = ""
    if verdict:
        risk_txt = f" Hasil keamanan: {verdict.upper()}."
    summary = f"Kategori: {_CATEGORY_LABELS[cat]}. Prioritas: {_PRIORITY_LABELS[prio]}. Intinya: {key}.{item_txt}{risk_txt}"
    return TriageResult(cat, _CATEGORY_LABELS[cat], prio, _PRIORITY_LABELS[prio], summary, actions, items)


def _triage_self_test() -> bool:
    ok = True

    def check(name, cond):
        nonlocal ok
        print(f"[{'ok' if cond else 'FAIL'}] {name}")
        if not cond:
            ok = False

    r = triage_message("Halo, jam berapa kita ketemu?")
    check("clean umum rendah", r.category == "umum" and r.priority == "rendah")

    r = triage_message("Tagihan internet Rp389.000 jatuh tempo besok")
    check("bill category", r.category == "tagihan")
    check("bill extracts amount/date", any(i.kind == "amount" for i in r.items) and any(i.kind == "date" for i in r.items))

    r = triage_message("Promo cashback 50% pakai voucher HEMAT50")
    check("promo category", r.category == "promo")

    r = triage_message("Paket Anda dikirim. Resi JP12345 COD Rp25.000")
    check("package category", r.category == "paket")
    check("package code/amount", any(i.kind == "code" for i in r.items) and any(i.kind == "amount" for i in r.items))

    r = triage_message("Meeting besok jam 10 di kantor")
    check("schedule category", r.category == "jadwal")

    r = triage_message("Admin WhatsApp: kirim kode 6 digit", account_takeover=True)
    check("takeover high", r.category == "keamanan_akun" and r.priority == "tinggi")

    r = triage_message("CS bank minta OTP", verdict="BLOCK")
    check("block high", r.priority == "tinggi")

    print("triage self-test", "OK" if ok else "FAILED")
    return ok


# ---------------------------------------------------------------------------
# Cluster D: Personal Notification Digest — classify a notification into an
# everyday category for the on-device daily digest. Kotlin port:
# NotificationClassifier.kt (must agree with this module).
# Design: docs/superpowers/specs/2026-07-04-notification-digest-design.md
# ---------------------------------------------------------------------------

# key -> (emoji, label). This list is also the digest DISPLAY order.
_DIGEST_CATEGORIES = [
    ("keamanan_akun", "🔐", "Keamanan akun"),
    ("keuangan", "💰", "Keuangan"),
    ("paket", "📦", "Paket"),
    ("kesehatan", "🏥", "Kesehatan"),
    ("travel", "✈️", "Travel"),
    ("sekolah", "🏫", "Sekolah"),
    ("kerja", "💼", "Kerja"),
    ("keluarga", "👨‍👩‍👧", "Keluarga"),
    ("promo", "🎁", "Promo"),
    ("umum", "🔔", "Umum"),
]
_DIGEST_LABEL = {k: lbl for k, _, lbl in _DIGEST_CATEGORIES}
_DIGEST_EMOJI = {k: e for k, e, _ in _DIGEST_CATEGORIES}
DIGEST_ORDER = [k for k, _, _ in _DIGEST_CATEGORIES]
# Categories hidden by the "Penting saja" (important-only) filter.
DIGEST_UNIMPORTANT = {"promo", "umum"}
DIGEST_PERSONAL_MESSAGE_PACKAGES = {"com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "com.facebook.orca"}

# Brand names (gopay/bca/jne) are intentionally NOT signals: the app label
# already carries the brand, and brand-in-text misfiles promos as finance.
#
# Signals are matched on word boundaries by _digest_has_any so short tokens like
# "cod" do not misfire inside unrelated words such as "coding". Only use bare
# tokens when they are unambiguous on their own; otherwise prefer phrases.
_DIGEST_SIGNALS = {
    "keamanan_akun": ("otp", "kode otp", "kode verifikasi", "kode login", "kode masuk", "kode akses", "perangkat tertaut", "linked device", "kata sandi", "one-time", "verification code", "login code", "reset password", "password reset", "reset your password", "atur ulang kata sandi", "ubah kata sandi"),
    "paket": ("paket", "resi", "kurir", "dikirim", "pengiriman", "cod", "pesanan", "akan tiba", "out for delivery", "dalam perjalanan", "sedang dikirim", "bea cukai"),
    "kesehatan": ("dokter", "klinik", "rumah sakit", "obat", "kontrol", "resep", "vaksin", "antrian", "bpjs kesehatan"),
    "travel": ("tiket", "booking", "hotel", "pesawat", "penerbangan", "boarding", "check-in", "kereta", "stasiun", "bandara", "reservasi"),
    "sekolah": ("sekolah", "kelas", "guru", "siswa", "orang tua", "kampus", "kuliah", "ujian", "spp", "wali kelas"),
    "kerja": ("meeting", "rapat", "interview", "wawancara", "kantor", "deadline", "proyek", "lembur", "absensi", "slip gaji", "shift"),
    "keuangan": ("transaksi", "transfer", "saldo", "top up", "topup", "pembayaran", "pembelian", "qris", "debit", "kredit", "mutasi", "rekening", "e-wallet", "tagihan", "jatuh tempo", "angsuran", "cicilan", "pln", "listrik", "pulsa", "virtual account", "biaya admin"),
    "promo": ("promo", "diskon", "cashback", "voucher", "flash sale", "gratis", "kupon", "sale", "gratis ongkir"),
    "keluarga": ("keluarga", "grup keluarga", "family"),
}
# Match precedence: security first; then the SPECIFIC institutions (paket,
# kesehatan, travel, sekolah, kerja) BEFORE the broad "keuangan", so a
# school/hospital/flight *payment* files under its institution, not generic
# finance; promo after keuangan; umum is the fallback.
_DIGEST_MATCH_ORDER = ("keamanan_akun", "paket", "kesehatan", "travel", "sekolah", "kerja", "keuangan", "promo", "keluarga")
_DIGEST_HIGH = ("segera", "jatuh tempo", "deadline", "terakhir", "expired", "kadaluarsa", "diblokir", "sekarang juga")
_DIGEST_MATCHERS = {
    k: [re.compile(r"(?<![\w])" + re.escape(t) + r"(?![\w])", re.IGNORECASE) for t in terms]
    for k, terms in _DIGEST_SIGNALS.items()
}


@dataclass(frozen=True)
class NotificationCategory:
    key: str
    emoji: str
    label: str
    priority: str  # tinggi | sedang | rendah


def classify_notification(text: str | None, title: str | None = None) -> NotificationCategory:
    blob = f"{title or ''} {text or ''}"
    key = "umum"
    for cand in _DIGEST_MATCH_ORDER:
        if _digest_has_any(blob, cand):
            key = cand
            break
    if key == "keamanan_akun" or _has_any(blob.lower(), *_DIGEST_HIGH):
        priority = "tinggi"
    elif key in {"promo", "keluarga", "umum"}:
        priority = "rendah"
    else:
        priority = "sedang"
    return NotificationCategory(key, _DIGEST_EMOJI[key], _DIGEST_LABEL[key], priority)


def _digest_has_any(blob: str, category: str) -> bool:
    return any(r.search(blob) for r in _DIGEST_MATCHERS[category])


def should_keep_notification_for_digest(package_name: str, title: str | None, category: str) -> bool:
    """Mirror NotificationClassifier.shouldKeepForDigest in Kotlin."""
    if category != "umum":
        return True
    if package_name not in DIGEST_PERSONAL_MESSAGE_PACKAGES:
        return False
    title = title or ""
    return not (
        re.search(r"\(\d+\s+pesan\)", title, re.IGNORECASE)
        or re.search(r"\(\d+\s+messages\)", title, re.IGNORECASE)
    )


def _digest_self_test() -> bool:
    ok = True

    def check(name, cond):
        nonlocal ok
        print(f"[{'ok' if cond else 'FAIL'}] {name}")
        if not cond:
            ok = False

    cases = [
        ("BCA", "transaksi Rp125.000 berhasil", "keuangan"),
        ("JNE", "paket akan tiba hari ini", "paket"),
        ("Sekolah", "pembayaran kegiatan paling lambat Jumat", "sekolah"),
        ("", "Promo diskon 40% khusus hari ini", "promo"),
        ("", "Kode OTP Anda 123456", "keamanan_akun"),
        ("Dokter", "jadwal kontrol Selasa 09.00", "kesehatan"),
        ("", "Tiket kereta Anda sudah terbit", "travel"),
        ("", "Halo apa kabar", "umum"),
        ("Ghifi", "I got to demo a Recursive CLI coding agent", "umum"),
        ("Our IT Group", "Update Incident - RITA Failed Login [3ID - TM/KYN]", "umum"),
        ("Our IT Group", "Dengan hormat, terima kasih atas kerja sama dalam memanfaatkan fitur dan layanan.", "umum"),
        ("Slack", "Reset your password", "keamanan_akun"),
    ]
    for title, text, expected in cases:
        got = classify_notification(text, title)
        check(f"{expected}: {(title + ' ' + text).strip()[:34]!r}", got.key == expected)

    check("otp is high priority", classify_notification("Kode OTP 123456").priority == "tinggi")
    check("promo is low priority", classify_notification("Promo diskon 40%").priority == "rendah")
    check("bill deadline is high", classify_notification("Tagihan listrik jatuh tempo").priority == "tinggi")
    check("drop generic whatsapp group", not should_keep_notification_for_digest("com.whatsapp", "Group (33 pesan): Ghifi", "umum"))
    check("keep whatsapp one-to-one umum", should_keep_notification_for_digest("com.whatsapp", "Ghifi", "umum"))
    check("keep categorized whatsapp group", should_keep_notification_for_digest("com.whatsapp", "Group (33 pesan): Ghifi", "kerja"))

    print("digest self-test", "OK" if ok else "FAILED")
    return ok


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        ok = _self_test()
        if "--triage" in sys.argv or "--all" in sys.argv:
            ok = _triage_self_test() and ok
        if "--digest" in sys.argv or "--all" in sys.argv:
            ok = _digest_self_test() and ok
        raise SystemExit(0 if ok else 1)
    # Otherwise redact stdin/args.
    text = " ".join(a for a in sys.argv[1:] if not a.startswith("--"))
    res = redact_pii(text)
    print(res.summary())
    print(res.redacted_text)
    if "--triage" in sys.argv:
        tri = triage_message(text)
        print(tri.summary)
        for action in tri.actions:
            print("-", action)
