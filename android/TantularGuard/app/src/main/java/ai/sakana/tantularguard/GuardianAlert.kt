package ai.sakana.tantularguard

/**
 * Family Guardian pure logic (no Android deps) — unit-testable.
 *
 * Builds privacy-safe alert text and decides normalization / validation /
 * rate-limiting. The alert NEVER contains the original message, sender, or PII.
 */
object GuardianAlert {

    const val DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000L // 5 minutes

    /** Trim and normalize an Indonesian phone number to +62 form when possible. */
    fun normalizeNumber(raw: String): String {
        var s = raw.trim().filter { it.isDigit() || it == '+' }
        if (s.startsWith("+")) {
            s = "+" + s.drop(1).filter { it.isDigit() }
            return s
        }
        val digits = s.filter { it.isDigit() }
        return when {
            digits.startsWith("62") -> "+$digits"
            digits.startsWith("0") -> "+62" + digits.drop(1)
            digits.isEmpty() -> ""
            else -> "+$digits"
        }
    }

    fun isValidNumber(raw: String): Boolean {
        val digits = normalizeNumber(raw).filter { it.isDigit() }
        return digits.length in 9..15
    }

    /**
     * Build the guardian SMS body. Privacy-safe: only name + risk level + a short
     * signal summary. Never includes the raw message.
     *
     * Written to read like a personal P2P text, NOT bulk/A2P: no "[Brand]"
     * bracket prefix and no keyword pileup (OTP/PIN/tautan/install) — those trip
     * carrier + on-device spam filters, which would quarantine the very alert
     * meant to warn about a scam. The guardian is expected to phone the person.
     */
    fun buildAlert(protectedName: String?, level: String, signalsHuman: List<String>): String {
        val who = protectedName?.trim().takeUnless { it.isNullOrBlank() } ?: "orang yang Anda jaga"
        val signalPart = if (signalsHuman.isEmpty()) "" else " (" + signalsHuman.take(2).joinToString(", ") + ")"
        return "Halo, $who sepertinya menerima pesan $level$signalPart di HP. " +
            "Tolong segera telepon dan ingatkan agar berhati-hati ya. - dari aplikasi Tantular"
    }

    fun levelText(verdictName: String, accountTakeover: Boolean): String = when {
        accountTakeover -> "berisiko pengambilalihan akun"
        verdictName == "BLOCK" -> "berisiko tinggi penipuan"
        else -> "mencurigakan"
    }

    fun shouldSend(nowMs: Long, lastMs: Long, minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS): Boolean =
        nowMs - lastMs >= minIntervalMs

    /**
     * Stable key identifying a distinct scam incident, from its risk level +
     * signals. The SAME scam arriving via SMS and WhatsApp yields the same key
     * (so it's deduped to one alert), while a genuinely different threat yields
     * a different key (so it still alerts within the window). Order-independent.
     */
    fun incidentKey(level: String, signals: List<String>): String {
        val sig = signals.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct().sorted()
        return level.trim().lowercase() + "|" + sig.joinToString(",")
    }
}
