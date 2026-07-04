package ai.sakana.tantularguard

import java.util.regex.Pattern

/**
 * Privacy Shield — PII redaction (Consumer Message Assistant, Cluster A).
 *
 * Kotlin port of the Python reference `tantular_assistant.py` (redact_pii).
 * Fully deterministic, on-device, no network, no permissions. Masks sensitive
 * Indonesian identifiers before the user forwards/shares a message.
 */
object PiiRedactor {

    data class Finding(
        val kind: String,   // nik | phone | otp | card | account | email | plate
        val label: String,  // Bahasa Indonesia
        val original: String,
        val masked: String,
        val start: Int,
        val end: Int,
    )

    data class Result(
        val originalText: String,
        val redactedText: String,
        val findings: List<Finding>,
    ) {
        fun hasSensitive(): Boolean = findings.isNotEmpty()

        fun summary(): String {
            if (findings.isEmpty()) return "Tidak ada data sensitif terdeteksi."
            val labels = mapOf(
                "nik" to "NIK", "phone" to "nomor HP", "otp" to "OTP/PIN",
                "card" to "nomor kartu", "account" to "nomor rekening",
                "email" to "email", "plate" to "plat nomor",
            )
            val counts = LinkedHashMap<String, Int>()
            for (f in findings) counts[f.kind] = (counts[f.kind] ?: 0) + 1
            val parts = counts.entries.joinToString(", ") { "${it.value} ${labels[it.key] ?: it.key}" }
            return "Ditemukan ${findings.size} data sensitif: $parts."
        }
    }

    private val otpTrigger = Pattern.compile("(?i)(otp|kode|verifikasi|verification|pin|password|sandi)")
    private val acctTrigger = Pattern.compile("(?i)(rekening|no\\.?\\s*rek|a/?n|atas nama|norek|rek\\.)")
    private val emailRe = Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    private val plateRe = Pattern.compile("\\b[A-Z]{1,2} ?\\d{1,4} ?[A-Z]{1,3}\\b")
    private val phoneRe = Pattern.compile("(?<!\\d)(?:\\+62|62|0)8\\d{7,12}(?!\\d)")
    private val nikRe = Pattern.compile("(?<!\\d)\\d{16}(?!\\d)")
    private val longNumRe = Pattern.compile("(?<!\\d)\\d(?:[ -]?\\d){12,18}(?!\\d)")
    private val numRe = Pattern.compile("(?<!\\d)\\d{6,20}(?!\\d)")
    private val shortNumRe = Pattern.compile("(?<!\\d)\\d{4,8}(?!\\d)")

    fun redact(text: String?): Result {
        if (text.isNullOrBlank()) {
            val base = text ?: ""
            return Result(base, base, emptyList())
        }
        val src: String = text

        val findings = mutableListOf<Finding>()
        val claimed = mutableListOf<Pair<Int, Int>>()

        fun overlaps(s: Int, e: Int) = claimed.any { s < it.second && it.first < e }
        fun claim(s: Int, e: Int, kind: String, label: String, mask: String) {
            findings.add(Finding(kind, label, src.substring(s, e), mask, s, e))
            claimed.add(s to e)
        }

        fun windowHas(pattern: Pattern, s: Int, e: Int, before: Int, after: Int): Boolean {
            val w = src.substring(maxOf(0, s - before), minOf(src.length, e + after))
            return pattern.matcher(w).find()
        }

        // 1) OTP / PIN — short digit run within a keyword window; fully masked.
        run {
            val m = shortNumRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                if (windowHas(otpTrigger, m.start(), m.end(), 30, 15)) {
                    claim(m.start(), m.end(), "otp", "Kode OTP/PIN", "[OTP\u2022\u2022\u2022\u2022\u2022]")
                }
            }
        }

        // 2) Card — 13-19 digits, Luhn-valid.
        run {
            val m = longNumRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                val digits = m.group().filter { it.isDigit() }
                if (digits.length in 13..19 && luhnValid(digits)) {
                    claim(m.start(), m.end(), "card", "Nomor kartu", "[KARTU\u2022\u2022\u2022${last4(m.group())}]")
                }
            }
        }

        // 3) NIK — exactly 16 digits (not already card).
        run {
            val m = nikRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                claim(m.start(), m.end(), "nik", "Nomor KTP (NIK)", "[NIK\u2022\u2022\u2022${last4(m.group())}]")
            }
        }

        // 4) Account — digit run near a rekening keyword.
        run {
            val m = numRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                if (windowHas(acctTrigger, m.start(), m.end(), 25, 10)) {
                    claim(m.start(), m.end(), "account", "Nomor rekening", "[REK\u2022\u2022\u2022${last4(m.group())}]")
                }
            }
        }

        // 5) Phone.
        run {
            val m = phoneRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                claim(m.start(), m.end(), "phone", "Nomor HP", "[HP\u2022\u2022\u2022${last4(m.group())}]")
            }
        }

        // 6) Email.
        run {
            val m = emailRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                claim(m.start(), m.end(), "email", "Email", "[EMAIL\u2022\u2022\u2022@\u2022\u2022\u2022]")
            }
        }

        // 7) Plate.
        run {
            val m = plateRe.matcher(src)
            while (m.find()) {
                if (overlaps(m.start(), m.end())) continue
                claim(m.start(), m.end(), "plate", "Plat nomor", "[PLAT\u2022\u2022\u2022]")
            }
        }

        var redacted = src
        for (f in findings.sortedByDescending { it.start }) {
            redacted = redacted.substring(0, f.start) + f.masked + redacted.substring(f.end)
        }
        return Result(src, redacted, findings.sortedBy { it.start })
    }

    private fun luhnValid(digits: String): Boolean {
        val d = digits.filter { it.isDigit() }.map { it - '0' }
        if (d.size < 13) return false
        var total = 0
        val parity = d.size % 2
        for (i in d.indices) {
            var n = d[i]
            if (i % 2 == parity) {
                n *= 2
                if (n > 9) n -= 9
            }
            total += n
        }
        return total % 10 == 0
    }

    private fun last4(raw: String): String {
        val only = raw.filter { it.isDigit() }
        return if (only.length >= 4) only.takeLast(4) else only
    }
}
